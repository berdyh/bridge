import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { access, mkdtemp, rm, mkdir, lstat, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentAvailability } from "@berdyh/bridge-protocol";

import { type CredentialSources, resolveAgentAuthFile, stageAgentCredentials } from "../agent/credentials.js";
import type { AgentEnvironment, AgentId } from "../agent/types.js";
import { type BaseDirs, type RunnerPaths, appPathsOf, defaultBaseDirs } from "../paths.js";
import { APP_DIR_LEVELS, type EnvPolicy, buildAgentEnv, buildContainedAgentEnv, ensurePrivateAppDir, prepareRunDirs } from "../sandbox/index.js";

import {
  type AcpContainmentSupport,
  checkContainmentRequest,
  claudeContainmentSupport,
  createEmptySessionDir,
  sessionNewOf,
  usesSecretFile,
  writeSessionSecrets,
} from "./containment/index.js";
import { type AgentAdapter, type AgentProcess, type AgentSpawnOptions, type ContainmentProfile, type ContainmentRefusalReason, ContainmentRefused } from "./contracts.js";
import { CONFINED_BUILTINS, confinedExecutionSupport, confinedProfile, confinedSettings, runtimeReadPaths, sandboxRuntimeReadPaths, startConfinedBrokers, writeConfinedLaunch } from "./confined.js";
import { confinedSocketDirectoryFits } from "./confined-sockets.js";
import type { ProcessCleanupResult, RawProcessCleanupResult } from "./cleanup.js";
import { type RawAgentProcess, type SpawnAcpProcessOptions, spawnAcpProcess } from "./process.js";

/**
 * The parts of `AgentEnvironment` an ACP adapter uses (it spawns through `spawnProcess`, not
 * `spawn`). `tmpBase` is the fixed parent of the session sandboxes; it may be left out when the
 * adapter has a per-app `tmpBaseOf`.
 */
export type AcpAdapterEnvironment = Pick<AgentEnvironment, "env" | "homedir"> & Partial<Pick<AgentEnvironment, "tmpBase">>;

/** Where an ACP command was found: shipped with the CLI install ("bundled") or on `PATH`/as configured ("path"). */
export type AdapterSource = "bundled" | "path";

/** A command to try, with where it comes from. A bare string counts as `"path"`. */
export interface AcpCommandCandidate {
  command: string;
  source: AdapterSource;
}

/** What an adapter resolved to. For `bridge doctor`; never sent to a browser. */
export interface ResolvedAdapterCommand {
  command: string;
  source: AdapterSource;
}

/** An adapter that can also say which command it would run. */
export type AcpAgentAdapter = AgentAdapter & { resolved(): ResolvedAdapterCommand | undefined };

/** What it takes to run one ACP agent as an adapter. */
export interface AcpAgentAdapterOptions {
  /** Protocol agent id ("claude", "codex", or any id the app asks for). */
  id: string;
  /**
   * The ACP binary: an absolute path, or a bare name looked up on `environment.env.PATH`.
   * A list is tried in order and the first that exists wins. A `{command, source}` entry
   * carries where the command comes from (`resolved()` reports it); a string is `"path"`.
   */
  command: string | AcpCommandCandidate | readonly (string | AcpCommandCandidate)[];
  args?: readonly string[];
  environment: AcpAdapterEnvironment;
  /**
   * The parent folder of the sandbox of a session of `appId`, created 0700 on demand. When set
   * it wins over `environment.tmpBase`, and a spawn without an `appId` is refused. With neither
   * this nor `environment.tmpBase` a spawn is refused: the adapter never falls back to `/tmp`.
   */
  tmpBaseOf?: (appId: string) => string;
  /**
   * How many trailing components of a `tmpBaseOf` folder must not be links (`ensurePrivateAppDir`):
   * 2 for the per-app layout (`<state>/<app>/bridge/tmp`), 3 for the deprecated one. Default 3.
   */
  tmpBaseLevels?: number;
  /** Host-only private short socket base; defaults use <state>/bridge/r. Never agent-readable. */
  socketRuntimeBase?: string;
  /**
   * Set for agents whose own login must be staged into the sandbox (claude, codex). When
   * absent the agent is started with no credentials of its own.
   */
  credentialsFor?: AgentId;
  authFiles?: Partial<Record<AgentId, string>>;
  envPolicy?: EnvPolicy;
  killGraceMs?: number;
  /**
   * What lets this agent run contained sessions (claude: `claudeContainmentSupport()`). Absent for an agent without
   * a profile (codex): `containment()` is `undefined` and a contained `spawn` is refused (`ContainmentRefused`,
   * -32016) before any process starts.
   */
  containment?: AcpContainmentSupport;
  /** Test seam: replaces the child-process spawn. */
  spawnProcess?: (options: SpawnAcpProcessOptions) => Promise<AgentProcess>;
  /** Test seam: the platform staged-login cleanup keys on. Default `process.platform`. */
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateOf(c: string | AcpCommandCandidate): AcpCommandCandidate {
  return typeof c === "string" ? { command: c, source: "path" } : c;
}

function findExecutable(command: string, pathEnv: string | undefined): string | undefined {
  if (path.isAbsolute(command)) return isExecutable(command) ? command : undefined;
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * An adapter for any agent that speaks ACP over stdio. Each `spawn` gets a throwaway
 * sandbox dir (stripped env, own HOME and TMPDIR, only the agent's own login staged in),
 * runs the agent in the session's cwd, and removes the dir after the agent exits. A token
 * the agent refreshed inside the sandbox is written back. The proxy never sees a secret.
 */
export function createAcpAgentAdapter(options: AcpAgentAdapterOptions): AcpAgentAdapter {
  const { environment: env } = options;
  const candidates = (typeof options.command === "string" || !Array.isArray(options.command) ? [options.command as string | AcpCommandCandidate] : [...options.command]).map(candidateOf);
  const resolved = (): ResolvedAdapterCommand | undefined => {
    for (const c of candidates) {
      const found = findExecutable(c.command, env.env.PATH);
      if (found) return { command: found, source: c.source };
    }
    return undefined;
  };
  const resolveCommand = () => resolved()?.command;
  /** The sandbox parent for this spawn, never the system temp dir. */
  const tmpBaseFor = (appId: string | undefined): string => {
    if (options.tmpBaseOf) {
      if (appId === undefined) throw new Error(`${options.id}: cannot place the session sandbox without an app id`);
      return options.tmpBaseOf(appId);
    }
    if (env.tmpBase === undefined) throw new Error(`${options.id}: no sandbox folder configured`);
    return env.tmpBase;
  };
  /** The launch of a contained session, or a refusal: no profile, an adapter outside the pin, an override. */
  const containedLaunch = () => {
    if (!options.containment) throw new ContainmentRefused(`${options.id} has no containment profile`);
    const found = options.containment.resolve(resolved());
    if ("unavailable" in found) throw new ContainmentRefused(found.unavailable, found.reason);
    return found.launch;
  };
  const sources = (): CredentialSources => ({ homedir: env.homedir, env: env.env, authFiles: options.authFiles });

  async function spawnOne(spawnOptions: AgentSpawnOptions): Promise<AgentProcess> {
    const request = spawnOptions.containment;
    // A contained request is checked first: no profile, no pin, no override means no process and no file.
    const contained = request ? containedLaunch() : undefined;
    if (request) checkContainmentRequest(request, spawnOptions.cwd);
    if (request?.execution) {
      if (options.id !== "claude") throw new ContainmentRefused("unsupported execution agent", "execution_unsupported");
      const support = confinedExecutionSupport();
      if (!support.supported) throw new ContainmentRefused("confined-v1 prerequisites unavailable", support.reason);
    }
    const command = contained?.command ?? resolveCommand();
    if (!command) throw new Error(`${options.id}: ACP adapter not installed (${candidates.map((c) => c.command).join(", ")})`);
    if (spawnOptions.signal?.aborted) throw new Error("spawn aborted");

    const platform = options.platform ?? process.platform;
    const tmpBase = tmpBaseFor(spawnOptions.appId);
    if (options.tmpBaseOf) await ensurePrivateAppDir(tmpBase, options.tmpBaseLevels);
    const tempDir = await mkdtemp(path.join(tmpBase, "bridge-acp-"));
    let persist: (() => Promise<void>) | undefined;
    let release: (() => Promise<void>) | undefined;
    let stagedLogin = false;
    let socketDir: string | undefined;
    let setupIncomplete = false;
    let rawProc: RawAgentProcess | undefined;
    let brokers: Awaited<ReturnType<typeof startConfinedBrokers>> | undefined;
    const removers: (() => Promise<void>)[] = [];
    let receipt: ProcessCleanupResult | undefined;
    let cleaning: Promise<void> | undefined;
    const cleanup = () => (cleaning ??= (async () => {
      const raw: RawProcessCleanupResult = rawProc?.cleanup ? await rawProc.cleanup() : { status: "incomplete", mechanism: "process-group", reason: "descendants-unverified" };
      // macOS (an accepted gap): an empty process group after the sweep releases a staged
      // login. It is never quiescence, so the receipt anything else sees stays incomplete.
      const groupEmpty = raw.status === "group-empty" && platform === "darwin" && !request?.execution;
      receipt = raw.status === "group-empty" ? { status: "incomplete", mechanism: "process-group", reason: "descendants-unverified" } : raw;
      const brokersClosed = await brokers?.close() ?? true;
      if (request?.execution && (receipt.status !== "quiescent" || !brokersClosed)) options.log?.(`confined cleanup: agent=${receipt.status}${receipt.status === "incomplete" ? ":" + receipt.reason : ""}; brokers=${brokersClosed ? "closed" : "incomplete"}`);
      if (!brokersClosed) receipt = { status: "incomplete", mechanism: "linux-pid-namespace", reason: "termination-failed" };
      // Strong sessions retain the workspace and the refresh lease on uncertain teardown.
      if (((request?.execution || stagedLogin) && rawProc && receipt.status !== "quiescent" && !groupEmpty) || setupIncomplete || !brokersClosed) return;
      try { await persist?.(); } catch {
        receipt = { status: "incomplete", mechanism: request?.execution ? "linux-pid-namespace" : "process-group", reason: "termination-failed" };
        return;
      }
      await rm(tempDir, { recursive: true, force: true });
      for (const remove of removers.splice(0)) await remove();
      await release?.();
      if (groupEmpty && stagedLogin) options.log?.("staged cleanup: group-empty; lease released (macOS, descendants unverified)");
    })());
    try {
      await prepareRunDirs(tempDir);
      if (request?.execution) {
        const socketBase = options.socketRuntimeBase ?? tmpBase;
        await ensurePrivateAppDir(socketBase, options.socketRuntimeBase ? 2 : options.tmpBaseLevels ?? 1);
        const socketBaseStat = await lstat(socketBase);
        if (socketBaseStat.isSymbolicLink() || (process.getuid && socketBaseStat.uid !== process.getuid())) throw new ContainmentRefused("runtime socket base is not runner owned", "sandbox_unavailable");
        socketDir = await mkdtemp(path.join(socketBase, `${createHash("sha256").update(spawnOptions.appId ?? "unknown").digest("hex").slice(0, 3)}-`));
        await chmod(socketDir, 0o700);
        removers.push(() => rm(socketDir!, { recursive: true, force: true }));
        if (!confinedSocketDirectoryFits(path.join(socketDir, "b15"))) throw new ContainmentRefused("runtime socket path too long; choose a shorter XDG_STATE_HOME", "sandbox_unavailable");
      }
      if (spawnOptions.signal?.aborted) throw new Error("spawn aborted");
      const staged = options.credentialsFor
        ? await stageAgentCredentials(options.credentialsFor, tempDir, sources())
        : { env: {}, staged: false, persistRefresh: undefined, release: undefined };
      persist = staged.persistRefresh;
      release = staged.release;
      stagedLogin = staged.staged;
      // Releasing a staged login needs cleanup evidence: a Linux PID namespace, or on macOS an empty
      // process group. Elsewhere refuse before anything runs so the lease and copy are released.
      if (stagedLogin && platform !== "linux" && platform !== "darwin") {
        throw new ContainmentRefused(`a staged ${options.credentialsFor} login needs cleanup evidence this platform (${platform}) cannot give`, "sandbox_unavailable");
      }
      // Staged credential vars last: the env policy may not override them. A contained spawn also strips
      // `CONTAINED_ENV_DENY` and forces the profile's own values (the pin-checked binary) after them.
      const childEnv = contained
        ? buildContainedAgentEnv(tempDir, env.env, request?.execution ? undefined : options.envPolicy, staged.env, contained.env)
        : { ...buildAgentEnv(tempDir, env.env, options.envPolicy), ...staged.env };
      let sessionNew: AgentProcess["sessionNew"];
      // The directory the child starts in: for a contained session, the path `createEmptySessionDir` verified.
      let childCwd = spawnOptions.cwd;
      if (contained && request) {
        const cwd = spawnOptions.cwd;
        const keepOut = [childEnv.HOME, childEnv.TMPDIR, childEnv.XDG_CONFIG_HOME, childEnv.XDG_CACHE_HOME, childEnv.XDG_DATA_HOME, childEnv.CLAUDE_CONFIG_DIR, cwd].filter((d): d is string => d !== undefined);
        const emptyCwd = await createEmptySessionDir(cwd);
        removers.push(emptyCwd.remove);
        childCwd = emptyCwd.dir;
        if (request.execution) {
          const brokerRoot = await mkdtemp(path.join(tmpBase, "bb-"));
          removers.push(() => rm(brokerRoot, { recursive: true, force: true }));
          const runtime = runtimeReadPaths([contained.command, ...contained.args.filter((a) => path.isAbsolute(a)), ...(contained.env.CLAUDE_CODE_EXECUTABLE ? [contained.env.CLAUDE_CODE_EXECUTABLE] : [])]);
          brokers = await startConfinedBrokers(request, brokerRoot, childEnv, runtime, socketDir);
          const meta = contained.sessionMeta(request);
          const claude = meta.claudeCode as { options: Record<string, unknown> };
          claude.options.tools = [...CONFINED_BUILTINS];
          claude.options.disallowedTools = [];
          sessionNew = { mcpServers: brokers.servers, _meta: meta };
        } else {
          const wanting = request.servers.filter(usesSecretFile).map((server) => server.name);
          let secretFiles: ReadonlyMap<string, string> = new Map();
          if (wanting.length > 0) {
            if (request.secret === undefined || request.secret.length === 0) throw new ContainmentRefused("a server asks for the secret file but the request has no secret");
            const written = await writeSessionSecrets(tmpBase, request.sessionId, wanting, request.secret, keepOut);
            removers.push(written.remove);
            secretFiles = written.files;
          }
          sessionNew = sessionNewOf(request, secretFiles, contained.sessionMeta(request));
        }
        request.secret?.fill(0);
      }
      let launch = { command, args: [...(contained ? contained.args : options.args ?? [])] };
      if (request?.execution && contained && brokers) {
        await mkdir(path.join(childCwd, "artifacts"), { mode: 0o700 });
        const runtime = runtimeReadPaths([contained.command, ...contained.args.filter((a) => path.isAbsolute(a)), ...(contained.env.CLAUDE_CODE_EXECUTABLE ? [contained.env.CLAUDE_CODE_EXECUTABLE] : [])]);
        const settings = confinedSettings([...runtime, ...sandboxRuntimeReadPaths(), new URL("./confined-client.js", import.meta.url).pathname], [tempDir, childCwd], [...request.execution.network, `${brokers.mitm.domains[0]}:443`]);
        settings.network.mitmProxy = brokers.mitm;
        const managerSocketDir = path.join(socketDir!, "a");
        await mkdir(managerSocketDir, { mode: 0o700 });
        launch = await writeConfinedLaunch(path.join(tempDir, "execution"), command, contained.args, settings, false, managerSocketDir);
      }
      // A public AgentProcess is assignable to the raw one: the seam can only report public receipts.
      const spawnRaw: (options: SpawnAcpProcessOptions) => Promise<RawAgentProcess> = options.spawnProcess ?? spawnAcpProcess;
      const proc = await spawnRaw({
        ...launch,
        ...((request?.execution || (stagedLogin && platform !== "darwin")) ? { processTree: "linux-pid-namespace" as const } : {}),
        cwd: childCwd,
        env: childEnv,
        killGraceMs: options.killGraceMs,
        platform,
        onStderr: options.log ? (line) => options.log?.(`${options.id}: ${line}`) : undefined,
      });
      rawProc = proc;
      const exited = proc.exited.finally(cleanup);
      exited.catch(() => undefined);
      // An abort that fired while the sandbox was being set up has no listener to hear it:
      // look again now that the child exists, then listen for the rest.
      if (spawnOptions.signal?.aborted) {
        await proc.kill();
        await exited;
        throw new Error("spawn aborted");
      }
      const onAbort = () => void proc.kill();
      spawnOptions.signal?.addEventListener("abort", onAbort, { once: true });
      void exited.then(() => spawnOptions.signal?.removeEventListener("abort", onAbort));
      return {
        stream: proc.stream,
        pid: proc.pid,
        exited,
        cleanup: async () => { await proc.kill(); await exited; return receipt!; },
        // Resolves after the process is gone and the sandbox dir is removed.
        kill: async () => {
          await proc.kill();
          await exited;
        },
        ...(sessionNew !== undefined ? { sessionNew } : {}),
      };
    } catch (error) {
      setupIncomplete = Boolean((error as { incompleteCleanup?: unknown })?.incompleteCleanup);
      await cleanup();
      throw error;
    }
  }

  return {
    id: options.id,
    resolved,
    containment(): ContainmentProfile | undefined {
      if (!options.containment) return undefined;
      const found = options.containment.resolve(resolved());
      return "launch" in found ? found.launch.profile : undefined;
    },
    execution(): ContainmentProfile | undefined {
      if (options.id !== "claude" || !confinedExecutionSupport().supported || !options.containment) return undefined;
      const found = options.containment.resolve(resolved());
      return "launch" in found ? confinedProfile(found.launch.profile) : undefined;
    },
    containmentRefusalReason(): ContainmentRefusalReason | undefined {
      if (!options.containment) return undefined;
      const found = options.containment.resolve(resolved());
      return "unavailable" in found ? found.reason : undefined;
    },
    async availability(): Promise<AgentAvailability> {
      if (!resolveCommand()) return { id: options.id, available: false };
      if (options.credentialsFor) {
        const signedIn = await access(resolveAgentAuthFile(options.credentialsFor, sources())).then(
          () => true,
          () => false,
        );
        return { id: options.id, available: signedIn };
      }
      return { id: options.id, available: true };
    },
    async spawn(spawnOptions: AgentSpawnOptions): Promise<AgentProcess> {
      const request = spawnOptions.containment;
      try {
        return await spawnOne(spawnOptions);
      } finally {
        // The adapter owns the secret from the call on: whatever happened, no copy of it outlives the spawn.
        request?.secret?.fill(0);
      }
    },
  };
}

export interface DefaultAdapterOptions {
  environment?: AcpAdapterEnvironment;
  /**
   * The XDG bases. Session sandboxes go to `appPathsOf(base, appId).tmpDir`
   * (`<state>/<app>/bridge/tmp`), created 0700 on demand. Default: derived from
   * `environment.homedir` and its XDG env, unless `environment.tmpBase` fixes the parent (tests).
   * Never the system temp dir.
   */
  base?: Pick<BaseDirs, "config" | "data" | "state">;
  /**
   * ACP binary per agent. Default: the published adapters, looked up on PATH. Put an
   * `{ command, source: "bundled" }` entry first to prefer a shipped copy; the candidates are tried in
   * order, so a bare `codex-acp` last keeps the `PATH` lookup as the final fallback.
   */
  commands?: {
    claude?: string | AcpCommandCandidate | readonly (string | AcpCommandCandidate)[];
    codex?: string | AcpCommandCandidate | readonly (string | AcpCommandCandidate)[];
  };
  authFiles?: Partial<Record<AgentId, string>>;
  envPolicy?: EnvPolicy;
  killGraceMs?: number;
  log?: (line: string) => void;
  /**
   * Receives containment decisions worth a line (today: a claude stack newer than the measured one, once per
   * versions pair); independent of `log`, which also turns on agent stderr forwarding.
   */
  containmentLog?: (line: string) => void;
}

/**
 * The claude and codex adapters. They run the ACP adapters found through `commands` (the CLI
 * passes, per agent, its override and the copy it installed first and the `PATH` names last), else the
 * published ones on PATH (`claude-agent-acp` / `claude-code-acp`, `codex-acp`), and report the agent
 * unavailable when none is installed. They are not exercised against the real binaries in tests (see the gated
 * test in `proxy.test.ts`). Each session's sandbox lives under the app's `tmp` dir in the
 * runner's state dir, created 0700 on demand. Only claude can run contained sessions, and only on the bundled
 * adapter at the measured version (`containment/claude.ts`).
 */
export function createDefaultAgentAdapters(options: DefaultAdapterOptions = {}): AcpAgentAdapter[] {
  const environment = options.environment ?? { env: process.env, homedir: os.homedir() };
  const base = options.base ?? (environment.tmpBase === undefined ? defaultBaseDirs(environment.homedir, environment.env) : undefined);
  const shared = {
    environment,
    ...(base !== undefined ? { socketRuntimeBase: path.join(base.state, "bridge", "r"), tmpBaseOf: (appId: string) => appPathsOf(base, appId).tmpDir, tmpBaseLevels: APP_DIR_LEVELS } : {}),
    authFiles: options.authFiles,
    envPolicy: options.envPolicy,
    killGraceMs: options.killGraceMs,
    log: options.log,
  };
  return [
    createAcpAgentAdapter({
      ...shared,
      id: "claude",
      command: options.commands?.claude ?? ["claude-agent-acp", "claude-code-acp"],
      credentialsFor: "claude-code",
      // Only a command marked "bundled" can run contained; codex has no profile.
      containment: claudeContainmentSupport({ log: options.containmentLog }),
    }),
    createAcpAgentAdapter({
      ...shared,
      id: "codex",
      command: options.commands?.codex ?? ["codex-acp"],
      credentialsFor: "codex-cli",
    }),
  ];
}
