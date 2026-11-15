import { lstat, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getValidAccessToken } from "@berdyh/bridge-pairing";
import { parseExtensionMethod } from "@berdyh/bridge-protocol";
import {
  APP_DIR_LEVELS,
  acceptEnrollment,
  auditFilesOf,
  createAcpProxy,
  createAuditLog,
  createLocalPolicy,
  redirectedComponent,
  removeBound,
  resolveProtectedDir,
  resolvedAgentOwnDirs,
  surfaceSha256Of,
  wrapRunnerChannel,
  type AcpProxy,
  type AcpAgentAdapter,
  type AgentSessionBroker,
  type BrokeredSession,
  type FileAuditLog,
  type ExtensionRouter,
  type LocalPolicy,
  type AppPaths,
  type LocalPolicyConfig,
  type PluginHost,
  type RunnerE2eeContext,
  type RunnerStatusFile,
} from "@berdyh/bridge-runner";

import { parse } from "./args.js";
import { type AppPolicyOverride, appConfigOf, effectivePolicyOf, orderAdapters } from "./app-config.js";
import { createSessionLimiter } from "./caps.js";
import { type AppRecord, type HostedAppRecord, isLocalApp, loadApps, printable, tokenKey } from "./config.js";
import { pairingConfigFor, readRevokedMark } from "./connect.js";
import { e2eeAppOf } from "./enroll.js";
import {
  DEFAULT_SESSION_CAPS,
  type CliDeps,
  UsageError,
  adaptersOf,
  bridgeConfigDir,
  credentialsOf,
  e2eeOf,
  homeOf,
  platformOf,
} from "./deps.js";
import type { RelaySocket, SocketFactory } from "./deps.js";
import { type AppLink, type LinkStatus, type LinkTimers, createAppLink, nodeSocket } from "./link.js";
import { assertLayout, relation } from "./layout-rule.js";
import { assertNoLegacyLayout } from "./legacy.js";
import { appPathsOf, runnerLockPath, runnerPathsOf, workerLockPath } from "./paths.js";
import { notifyOf } from "./notify.js";
import { pluginHostFor, pluginLogOf } from "./plugin.js";
import { type Lock, LockRefused, acquireLock } from "./runner-lock.js";
import { enrollDirStamp, enrollWindowOpen, isPidAlive, removeRunnerStatus, statusFilePath, writeRunnerStatus } from "./status.js";
import { ADAPTER_KINDS, type AdapterAgent } from "./adapters.js";
import { agentLoginIsPresent } from "./agent.js";
import { checkForUpdate, updateInfoOf } from "./update-check.js";
import { CLI_VERSION } from "./version.js";

/**
 * The runner stops after this long with no browser connected for any app, no open plugin session and no open enroll
 * window (open plugin sessions count as activity).
 */
export const IDLE_STOP_MS = 15 * 60 * 1000;
/** How often an idle runner looks for an open enroll window (a window opened and closed in between is not seen). */
const IDLE_POLL_MS = 30 * 1000;

export interface IdleOptions {
  /** Default `IDLE_STOP_MS`. */
  ms?: number;
  /** Timer seam (tests inject a manual clock). Default: the global timers, unref'd. */
  timers?: LinkTimers;
}

export interface RunnerOptions {
  /** False selects the plaintext layer (the test harness, `BRIDGE_E2EE=0`). Default true. */
  e2ee?: boolean;
  /** The idle stop. The clock is `deps.now`. */
  idle?: IdleOptions;
  /** Timer seam for each link's connect, welcome and heartbeat timers (tests inject a manual clock). Default: the global timers. */
  linkTimers?: LinkTimers;
  /** Whether a process is alive, for the lock holders (tests inject it). Default: `kill(pid, 0)`. */
  isPidAlive?: (pid: number) => boolean;
}

/** Link statuses that end the connection for good: no browser can still be on such a link. */
const TERMINAL: ReadonlySet<LinkStatus> = new Set<LinkStatus>(["update_required", "replaced", "revoked", "auth_failed"]);

const globalTimers: LinkTimers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface RunnerHandle {
  /** The status of each app's connection, by app id; `local` for a local app (it has no connection). */
  statuses(): Record<string, LinkStatus | "local">;
  link(appId: string): AppLink | undefined;
  proxy(appId: string): AcpProxy | undefined;
  /** Resolves when every hosted app's connect loop has ended (stopped, or parked on a terminal status); at once when there is none. */
  settled: Promise<void>;
  /**
   * Resolves once the runner has been idle for the idle period: no browser connected for any app, no open
   * plugin session and no open enroll window. The caller stops the runner; this never stops it by itself.
   */
  idle: Promise<void>;
  /** Browsers connected right now, over all apps. */
  browsers(): number;
  stop(): Promise<void>;
}

/**
 * Which `_<id>/...` methods reach the plugin host for one app: those of plugins installed for
 * that app when the runner started. Any other extension method, including another app's
 * plugin id, is refused by the proxy with `extensionNotFound`, exactly like an unknown id. The
 * proxy never forwards `_` methods to an agent, so agent-native `_vendor/...` methods are
 * unreachable by design; they would need a policy decision in the proxy, not here.
 */
export function scopeExtensions(router: ExtensionRouter, pluginIds: ReadonlySet<string>): ExtensionRouter {
  return {
    handles(method) {
      const parsed = parseExtensionMethod(method);
      return parsed !== undefined && pluginIds.has(parsed.pluginId) && router.handles(method);
    },
    request: (caller, method, params) => router.request(caller, method, params),
    notify: (caller, method, params) => router.notify(caller, method, params),
    subscribe: (caller, push) => router.subscribe(caller, push),
  };
}

/** What `policy.json` may set. The rest of `LocalPolicyConfig` is runner-side code (functions, the home dir) that no file supplies. */
const MACHINE_POLICY_KEYS = ["mode", "agents", "allowedCwds", "allowedTools", "protectedPaths", "pluginApprovals", "models", "sessionBudget"] as const;
const POLICY_MODES: readonly string[] = ["ask", "read-only", "accept-edits", "bypass"];
const RUNNER_SIDE_KEYS: readonly string[] = ["workDirOf", "appStateDirOf", "agentModel", "auditFailed", "homedir", "warn"];
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Checks a parsed `policy.json`. It must be a JSON object; `mode` one of the four modes; `agents`, `allowedCwds`,
 * `allowedTools` and `protectedPaths` lists of strings; any of these wrong refuses the start (a value read
 * loosely could widen what sessions may do). `pluginApprovals`, `models` and `sessionBudget` are checked by the
 * policy itself, which fails closed on a bad one and says so. A key the runner sets in code (`auditFailed`,
 * `agentModel`, the work-folder functions, `homedir`) and any unknown key is dropped with a warning, so a file can
 * neither supply nor override what the runner decides.
 */
export function validateMachinePolicy(value: unknown, file: string): { policy: LocalPolicyConfig; warnings: string[] } {
  const bad = (what: string): never => {
    throw new Error(`${file} is not valid: ${what}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("it must be a JSON object");
  const raw = value as Record<string, unknown>;
  const warnings: string[] = [];
  const policy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if ((MACHINE_POLICY_KEYS as readonly string[]).includes(key)) policy[key] = entry;
    else if (RUNNER_SIDE_KEYS.includes(key)) warnings.push(`${file}: ${JSON.stringify(key)} is set by bridge, not by this file; ignored`);
    else warnings.push(`${file}: unknown key ${JSON.stringify(key)}; ignored`);
  }
  if (policy.mode !== undefined && !(typeof policy.mode === "string" && POLICY_MODES.includes(policy.mode))) bad(`"mode" must be one of ${POLICY_MODES.join(", ")}`);
  for (const key of ["agents", "allowedCwds", "allowedTools", "protectedPaths"]) {
    if (policy[key] !== undefined && !isTextList(policy[key])) bad(`"${key}" must be a list of strings`);
  }
  return { policy: policy as LocalPolicyConfig, warnings };
}

/** The machine policy: `<config>/bridge/policy.json`, `{}` when there is none. */
export async function loadMachinePolicy(deps: CliDeps): Promise<{ policy: LocalPolicyConfig; warnings: string[] }> {
  const file = path.join(bridgeConfigDir(deps), "policy.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`policy.json is not valid: ${(error as Error).message}`);
    return { policy: {}, warnings: [] };
  }
  return validateMachinePolicy(parsed, "policy.json");
}

/**
 * The agents' own config dirs (`~/.claude`, `~/.codex`, `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`), resolved the
 * way the kernel would (the resolver: `..` after a link goes up from its target, a dangling link is
 * followed through its text). An unresolvable one cannot be protected, so the runner refuses to start
 * rather than protect the wrong destination.
 */
async function agentOwnDirsOf(deps: CliDeps): Promise<{ path: string; real: string }[]> {
  const out: { path: string; real: string }[] = [];
  for (const dir of await resolvedAgentOwnDirs({ homedir: homeOf(deps), env: deps.env })) {
    if (dir.real === null) throw new Error(`cannot resolve ${dir.path} (a link loop, an unreadable link or a file in the way), so it cannot be protected; fix it, or unset the variable that names it. Nothing was started`);
    out.push({ path: dir.path, real: dir.real });
  }
  return out;
}

/**
 * Refuses to start when an agent's own config dir is, is inside, or contains an app's work folder or
 * state folder (both resolved). The policy's work-folder carve-out admits sessions into those folders,
 * so it must never admit an agent's login dir. A work or state folder that cannot be resolved cannot be
 * shown apart, so it refuses too (fail closed).
 */
export async function assertAgentDirsApart(deps: CliDeps, apps: readonly Pick<AppRecord, "appId">[]): Promise<void> {
  const agents = await agentOwnDirsOf(deps);
  for (const app of apps) {
    const p = appPathsOf(deps, app.appId);
    for (const [what, dir] of [["work folder", p.workDir], ["state folder", p.stateDir]] as const) {
      const real = await resolveProtectedDir(dir);
      if (real === null) throw new Error(`cannot resolve ${app.appId}'s ${what} ${dir} (a link loop, an unreadable link or a file in the way), so it cannot be kept apart from the agents' own folders; fix it. Nothing was started`);
      for (const agent of agents) {
        if (relation(agent.real, real) !== "apart") {
          throw new Error(`the agent folder ${agent.path} (really ${agent.real}) overlaps ${app.appId}'s ${what} ${dir} (really ${real}); sessions run in that folder and must never reach an agent's login. Move one of them, or unset the variable that names the agent folder. Nothing was started`);
        }
      }
    }
  }
}

/**
 * What no session may reach by any policy: the machine-wide dirs (`<config|data|state>/bridge`, which
 * hold `agents/`, the launcher's versions and `runner.json`), every connected app's three `bridge/`
 * dirs, the service dirs and, when moved off the defaults, the agents' own config dirs. Neither
 * `policy.json` nor an app's `config.json` can remove one of them.
 */
export async function protectedPathsOf(deps: CliDeps, apps: readonly Pick<AppRecord, "appId">[], extra: readonly string[] = []): Promise<string[]> {
  const runner = runnerPathsOf(deps);
  const agentDirs = (await agentOwnDirsOf(deps)).map((d) => d.real);
  return [
    ...extra,
    bridgeConfigDir(deps),
    runner.agentsDir,
    runner.appDir,
    runner.stateDir,
    ...apps.flatMap((app) => {
      const p = appPathsOf(deps, app.appId);
      return [p.configDir, p.dataDir, p.stateDir];
    }),
    path.join(deps.configDir, "systemd"),
    path.join(deps.dataDir, "systemd"),
    path.join(deps.configDir, "environment.d"),
    ...agentDirs,
  ];
}

/**
 * One app's local policy: the machine policy narrowed by the app's `config.json` (`effectivePolicyOf`),
 * confined to the app's own work folder and state folder. The functions the policy is given answer
 * for this app only: another app's id throws, so a policy cannot be handed another app's `AppPaths`.
 */
async function policyOf(
  deps: CliDeps,
  machine: LocalPolicyConfig,
  app: AppRecord,
  override: AppPolicyOverride | undefined,
  protectedPaths: string[],
  /** Set in code for this app, after the machine and effective policy: no file reaches them. */
  hooks: { auditFailed: (pluginId: string) => boolean; agentModel?: string },
): Promise<{ policy: LocalPolicy; warnings: string[] }> {
  const paths = appPathsOf(deps, app.appId);
  const own = (appId: string): AppPaths => {
    if (appId !== paths.appId) throw new Error(`this policy belongs to ${paths.appId}, not ${JSON.stringify(appId)}`);
    return paths;
  };
  // What the runner adds to any policy of this app: the same for the machine policy (asked below) and the effective one.
  const runnerSide = {
    homedir: homeOf(deps),
    protectedPaths: [...(machine.protectedPaths ?? []), ...protectedPaths],
    appStateDirOf: (appId: string) => own(appId).stateDir,
    workDirOf: (appId: string) => own(appId).workDir,
  };
  // The machine policy exactly as the runner would build it for this app, with its agent list left out: the
  // narrowing asks it whether a cwd is admitted, so an override can only keep what the machine admits.
  const { agents: _agents, ...machineCwds } = machine;
  const machineOnly = createLocalPolicy({ ...machineCwds, ...runnerSide, warn: () => {} });
  const admits = async (cwd: string): Promise<boolean> => machineOnly.allowSession({ appId: app.appId, agentId: "(any agent)", cwd });
  // Where the work folder and the app's entries really are (the resolver: a dangling link is followed through
  // its target, never read as the path it sits at). One that cannot be resolved is not in the map, so
  // `effectivePolicyOf` drops it.
  const real = new Map<string, string>();
  for (const p of [paths.workDir, paths.stateDir, ...(override?.allowedCwds ?? [])]) {
    if (!path.isAbsolute(p)) continue;
    const resolved = await resolveProtectedDir(p);
    if (resolved !== null) real.set(p, resolved);
  }
  const effective = await effectivePolicyOf(machine, override, { workDir: paths.workDir, stateDir: paths.stateDir, resolve: (p) => real.get(p), admits });
  // The runner's own dirs follow the deps (XDG overrides), not just the home defaults. Without
  // `allowedCwds` a session starts only in its app's work folder created 0700 on demand.
  const policy = createLocalPolicy({
    ...effective.config,
    ...runnerSide,
    auditFailed: hooks.auditFailed,
    ...(hooks.agentModel !== undefined ? { agentModel: hooks.agentModel } : {}),
  });
  return { policy, warnings: effective.warnings };
}

/**
 * The broker the plugin host gets: the proxy's own, with each session it starts counted while it is open (and
 * while it is still starting), so the idle stop sees plugin sessions as activity. A session is over when its
 * `ended` resolves; a session without one is over at its `close()`. Nothing else about the session changes.
 */
export function countSessions(broker: AgentSessionBroker, opened: () => void, closed: () => void): AgentSessionBroker {
  return {
    async start(request) {
      opened();
      let session: BrokeredSession;
      try {
        session = await broker.start(request);
      } catch (error) {
        closed();
        throw error;
      }
      let over = false;
      const end = (): void => {
        if (over) return;
        over = true;
        closed();
      };
      if (session.ended) {
        void session.ended.then(end, end);
        return session;
      }
      return {
        get sessionId() {
          return session.sessionId;
        },
        prompt: (text) => session.prompt(text),
        cancel: () => session.cancel(),
        close: (reason) => session.close(reason).finally(end),
        ...(session.onUpdate ? { onUpdate: (handler) => session.onUpdate!(handler) } : {}),
      };
    },
  };
}

/**
 * Watches the sockets one app's link opens, to say why a connection did not last: `reason()` is how the latest
 * attempt ended. A relay that refuses the upgrade (HTTP 403 for a revoked runner id) shows as a socket that closes
 * before it opened; the status line alone would say "reconnecting" and nothing else.
 */
function watchSockets(open: SocketFactory): { socket: SocketFactory; reason(): string } {
  let latest = "no connection tried yet";
  return {
    socket(url, init) {
      const sock = open(url, init);
      let opened = false;
      /** The runner gave up on this socket itself (the link's connect or welcome timer, a transport fault, a stop). */
      let abandoned = false;
      /** An `error` came before the socket opened: the upgrade was refused or failed (Node 22 fires no `close` after it). */
      let refused = false;
      latest = "the relay did not answer in time";
      sock.addEventListener("open", () => {
        opened = true;
      });
      // Registered before the link's own listeners, so the reason is set before the link gives the attempt up.
      sock.addEventListener("error", () => {
        if (opened || abandoned) return;
        refused = true;
        latest = "the relay refused the connection (the upgrade failed before the socket opened)";
      });
      sock.addEventListener("close", (event) => {
        if (refused) return;
        const why = event.reason ? `, ${printable(event.reason).slice(0, 120)}` : "";
        if (abandoned) latest = opened ? "the relay did not welcome the runner in time" : "the relay did not answer in time";
        else latest = opened ? `the relay closed the connection (code ${event.code}${why})` : `the relay refused the connection (closed before it opened, code ${event.code}${why})`;
      });
      const watched: RelaySocket = {
        get readyState() {
          return sock.readyState;
        },
        send: (data) => sock.send(data),
        close: (code, reason) => {
          abandoned = true;
          sock.close(code, reason);
        },
        addEventListener: ((type: string, listener: never) => (sock.addEventListener as (t: string, l: never) => void)(type, listener)) as RelaySocket["addEventListener"],
      };
      return watched;
    },
    reason: () => latest,
  };
}

/** The folder name prefix of a contained session's secret files (`<tmp>/bridge-acp-secrets-<session id>`). */
const SECRETS_PREFIX = "bridge-acp-secrets-";
/** The folder name prefix of a session's sandbox (`<tmp>/bridge-acp-<random>`); it can hold a staged copy of the agent's login. */
const SANDBOX_PREFIX = "bridge-acp-";

/** What `sweepApp` removed (counts only) and the folders it left alone, with why. */
export interface SweepResult {
  sessions: number;
  secrets: number;
  /** Leftover `bridge-acp-<random>` session sandboxes (a staged agent login lives in one). */
  sandboxes: number;
  left: { dir: string; why: string }[];
}

/**
 * Removes the entries of `dir` that `wanted` accepts, through `removeBound`, never following a link: a link inside
 * `dir` is removed as a link and its target stays. `dir` itself must be a real folder in `bridge/` (not a link; the
 * folders above `bridge/` may be links); anything else is left and reported.
 */
async function sweepFolder(dir: string, wanted: (name: string) => boolean): Promise<{ removed: number; left?: string }> {
  const redirected = await redirectedComponent(dir, APP_DIR_LEVELS);
  if (redirected !== undefined) return { removed: 0, left: `${redirected} is a link` };
  let canonical: string;
  try {
    canonical = path.join(await realpath(path.dirname(dir)), path.basename(dir));
    if (!(await lstat(canonical)).isDirectory()) return { removed: 0, left: "it is not a folder" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0 };
    return { removed: 0, left: `cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
  }
  let removed = 0;
  let left: string | undefined;
  for (const name of (await readdir(canonical)).filter(wanted).sort()) {
    try {
      await removeBound(path.join(canonical, name), { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      left ??= `an entry could not be removed (${(error as NodeJS.ErrnoException).code ?? "refused"})`;
    }
  }
  return { removed, ...(left !== undefined ? { left } : {}) };
}

/**
 * The start-up sweep of ONE app: everything a crashed runner left behind that a contained session
 * owns, i.e. every entry under the app's `sessionsDir` and every `bridge-acp-*` folder (secret folders and session
 * sandboxes, which can hold a staged copy of the agent's login) in its `secretsParent`; no staged login outlives its
 * runner. It touches this app's two folders and nothing else, so a worker that holds the app's `worker.lock` runs the
 * same function. Call it only while holding that lock: with no live runner for the app, no entry is a live session's.
 * Nothing it returns names a session.
 */
export async function sweepApp(paths: AppPaths): Promise<SweepResult> {
  const sessions = await sweepFolder(paths.sessionsDir, () => true);
  const secrets = await sweepFolder(paths.secretsParent, (name) => name.startsWith(SECRETS_PREFIX));
  // The secret folders are gone, so `bridge-acp-*` now matches the sandboxes only.
  const sandboxes = await sweepFolder(paths.secretsParent, (name) => name.startsWith(SANDBOX_PREFIX));
  const left: SweepResult["left"] = [];
  if (sessions.left !== undefined) left.push({ dir: paths.sessionsDir, why: sessions.left });
  const parentLeft = secrets.left ?? sandboxes.left;
  if (parentLeft !== undefined) left.push({ dir: paths.secretsParent, why: parentLeft });
  return { sessions: sessions.removed, secrets: secrets.removed, sandboxes: sandboxes.removed, left };
}

/** The locks a running runner holds: the machine-wide one and one per served app. */
interface HeldLocks {
  runner: Lock;
  workers: Map<string, Lock>;
  /** The apps whose worker lock was taken: the ones this runner serves. */
  served: AppRecord[];
}

/** The `runner.json` of a live `bridge run` (older, without the lock), for the lock's transition rule. */
async function runningStatusOf(deps: CliDeps, alive: (pid: number) => boolean): Promise<{ pid: number; startedAt?: string } | undefined> {
  try {
    const status = JSON.parse(await readFile(statusFilePath(deps), "utf8")) as { pid?: unknown; startedAt?: unknown };
    if (typeof status.pid !== "number" || !Number.isInteger(status.pid) || status.pid <= 0 || !alive(status.pid)) return undefined;
    return { pid: status.pid, ...(typeof status.startedAt === "string" ? { startedAt: status.startedAt } : {}) };
  } catch {
    return undefined;
  }
}

async function releaseAll(held: Pick<HeldLocks, "runner" | "workers">): Promise<void> {
  for (const lock of held.workers.values()) await lock.release();
  await held.runner.release();
}

/**
 * Takes `runner.lock`, then for each app its `worker.lock` and, under it, that app's sweep. A refused runner lock throws
 * `LockRefused` before anything is swept or written. A refused app lock leaves that app unserved (logged) and its
 * folders untouched; the other apps and the runner go on. If no app can be served the start is refused.
 */
async function takeLocks(deps: CliDeps, apps: readonly AppRecord[], options: RunnerOptions): Promise<HeldLocks> {
  const alive = options.isPidAlive ?? isPidAlive;
  const lockOptions = (label: string) => ({
    isPidAlive: alive,
    ...(deps.now ? { now: deps.now } : {}),
    label,
    log: (level: "warn" | "info", message: string) => void deps.stderr(`bridge run: ${level}: ${message}\n`),
  });
  const runner = await acquireLock(runnerLockPath(deps), { ...lockOptions("runner"), transition: () => runningStatusOf(deps, alive) });
  const held: HeldLocks = { runner, workers: new Map(), served: [] };
  try {
    const refusals: string[] = [];
    for (const app of apps) {
      const paths = appPathsOf(deps, app.appId);
      let lock: Lock;
      try {
        lock = await acquireLock(workerLockPath(paths), lockOptions(`worker for app ${app.appId}`));
      } catch (error) {
        if (!(error instanceof LockRefused)) throw error;
        refusals.push(error.message);
        deps.stderr(`[${app.appId}] error: ${error.message}; this app is not served by this runner\n`);
        continue;
      }
      held.workers.set(app.appId, lock);
      held.served.push(app);
      // Under the app's own lock, before its proxy accepts a session or its plugins start.
      const swept = await sweepApp(paths);
      if (swept.sessions + swept.secrets + swept.sandboxes > 0) {
        deps.stderr(`[${app.appId}] info: removed ${swept.sessions} stale session folder(s), ${swept.secrets} stale secret folder(s) and ${swept.sandboxes} stale agent sandbox(es) left by a crashed runner\n`);
      }
      for (const leftover of swept.left) deps.stderr(`[${app.appId}] warn: ${leftover.dir}: ${leftover.why}; left alone, remove by hand if it is yours\n`);
    }
    if (held.served.length === 0 && apps.length > 0) throw new LockRefused("live", `no app can be served: ${refusals.join("; ")}`);
    return held;
  } catch (error) {
    await releaseAll(held);
    throw error;
  }
}

/**
 * Starts one connection per connected app and returns at once; the connections keep running. Throws `LockRefused`
 * when another runner holds `runner.lock` (nothing was swept or written). The locks are held until `stop()`.
 */
export async function startRunner(deps: CliDeps, allApps: AppRecord[], options: RunnerOptions = {}): Promise<RunnerHandle> {
  // Rule A (consent-plan.ts) before any policy is built: the apps' bridge/ dirs and the machine-wide dirs may not
  // alias one another. Aliased state parents would otherwise make the work-folder carve-out admit one app into another's.
  await assertLayout(deps, "run", allApps.map((a) => a.appId));
  // Before any policy too: the work-folder carve-out must never admit an agent's login dir.
  await assertAgentDirsApart(deps, allApps);
  // Before anything is written, swept or started: one runner per machine, one worker per app.
  const held = await takeLocks(deps, allApps, options);
  try {
    return await serve(deps, held, allApps, options);
  } catch (error) {
    await releaseAll(held);
    throw error;
  }
}

async function serve(deps: CliDeps, held: HeldLocks, allApps: AppRecord[], options: RunnerOptions): Promise<RunnerHandle> {
  const apps = held.served;
  const adapters = adaptersOf(deps);
  const machine = deps.policy ? undefined : await loadMachinePolicy(deps);
  const machinePolicy = machine?.policy;
  for (const warning of machine?.warnings ?? []) deps.stderr(`bridge run: warn: ${warning}\n`);
  // Every connected app's folders are protected, served by this runner or not.
  const protectedPaths = await protectedPathsOf(deps, allApps);
  const caps = deps.sessionCaps ?? DEFAULT_SESSION_CAPS;
  const host: PluginHost = pluginHostFor(deps, apps, pluginLogOf(deps));
  const installed = await host.list();
  const credentials = credentialsOf(deps);
  const sleep = deps.sleep ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new Error("aborted")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  }));

  const links = new Map<string, AppLink>();
  const proxies = new Map<string, AcpProxy>();

  // --- the status file and the idle stop ---------------------------------------------------
  const now = deps.now ?? Date.now;
  const timers = options.idle?.timers ?? globalTimers;
  const idleMs = options.idle?.ms ?? IDLE_STOP_MS;
  const startedAt = new Date(now()).toISOString();
  /** Browsers present per app (from the demux's `onPeer`); their sum is the runner's browser count. */
  const peers = new Map<string, Set<string>>(apps.map((a) => [a.appId, new Set<string>()]));
  // A local app has no link: it reads `local` from the start and never changes.
  const linkStatuses = new Map<string, LinkStatus | "local">(apps.map((a) => [a.appId, isLocalApp(a) ? "local" : "connecting"]));
  /** The apps that have a link (a local app has none). */
  const hostedApps = apps.filter((a): a is HostedAppRecord => !isLocalApp(a));
  /** A served local app keeps the runner up: the idle stop is a hosted economy (a browser or the service brings the runner back), and a local app has no wake-up path. */
  const holdsRunner = hostedApps.length < apps.length;
  const browserCount = (): number => [...peers.values()].reduce((n, set) => n + set.size, 0);
  /** Plugin sessions open right now, over all apps (counted by the broker the plugin host is given). */
  let pluginSessions = 0;
  /** Since when no browser has been connected and no plugin session has been open, for any app; undefined while one is. */
  const idleStart = now();
  let idleSince: number | undefined = holdsRunner ? undefined : idleStart;
  /** Last moment something other than a browser or a plugin session kept the runner busy (an open enroll window). */
  let lastActivity = idleStart;
  let idleTimer: unknown;
  /** Bumped on every arm and disarm: a check that finds it changed while it awaited is stale and must not reschedule. */
  let idleGeneration = 0;
  let stopped = false;
  let signalIdle!: () => void;
  const idle = new Promise<void>((resolve) => (signalIdle = resolve));

  let writing: Promise<void> = Promise.resolve();
  const writeStatus = (): void => {
    if (stopped) return;
    const file: RunnerStatusFile = {
      version: 1,
      pid: process.pid,
      startedAt,
      apps: Object.fromEntries(linkStatuses),
      browsers: browserCount(),
      ...(idleSince !== undefined ? { idleSince: new Date(idleSince).toISOString() } : {}),
    };
    writing = writing.then(() => (stopped ? undefined : writeRunnerStatus(deps, file))).catch((error: unknown) => {
      deps.stderr(`bridge run: cannot write the status file: ${printable(error instanceof Error ? error.message : String(error))}\n`);
    });
  };

  /**
   * The relay itself said an app's runner id is revoked: keep that word in `revoked.json` (0600, temp file then rename), so
   * `bridge connect` and `bridge setup` know to mint a new id even when no runner is up. A failed write is only logged.
   */
  let marking: Promise<void> = Promise.resolve();
  const markRevoked = (app: HostedAppRecord, file: string, detail: string | undefined): void => {
    marking = marking.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        const mark = { version: 1, runnerId: app.runnerId, at: new Date(now()).toISOString(), ...(detail !== undefined ? { detail } : {}) };
        await writeFile(tmp, `${JSON.stringify(mark)}\n`, { mode: 0o600 });
        await rename(tmp, file);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined);
        deps.stderr(`[${app.appId}] warn: cannot write ${file}: ${printable(error instanceof Error ? error.message : String(error))}\n`);
      }
    });
  };

  /** Enroll activity: a window open now, or any change to the enroll state dir since the previous look. */
  let enrollStamp = "";
  const enrollBusy = async (): Promise<boolean> => {
    // The stamp is read on both sides of the window reads, which run together: a window created or
    // removed while the reads are in flight moves the stamp, so it cannot slip between them.
    const before = await enrollDirStamp(deps, apps);
    const open = (await Promise.all(hostedApps.map((app) => enrollWindowOpen(deps, app)))).some(Boolean);
    const after = await enrollDirStamp(deps, apps);
    const changed = before !== enrollStamp || after !== before;
    enrollStamp = after;
    return open || changed;
  };
  const disarmIdle = (): void => {
    idleGeneration += 1;
    if (idleTimer !== undefined) timers.clear(idleTimer);
    idleTimer = undefined;
  };
  /**
   * Looks at the clock instead of trusting the schedule: stop only when no browser has been present, no plugin
   * session has been open and no enroll activity has been seen for the whole idle period; otherwise sleep until it could be.
   * Nothing is awaited between the last look and `signalIdle`.
   */
  const checkIdle = async (generation: number): Promise<void> => {
    idleTimer = undefined;
    if (stopped || idleSince === undefined || generation !== idleGeneration) return;
    const busy = await enrollBusy();
    if (stopped || idleSince === undefined || generation !== idleGeneration) return;
    if (busy) lastActivity = now();
    const quietSince = Math.max(idleSince, lastActivity);
    const left = quietSince + idleMs - now();
    if (left <= 0) {
      signalIdle();
      return;
    }
    idleTimer = timers.set(() => void checkIdle(generation), Math.min(left, IDLE_POLL_MS));
  };
  const armIdle = (): void => {
    disarmIdle();
    const generation = idleGeneration;
    idleTimer = timers.set(() => void checkIdle(generation), Math.min(idleMs, IDLE_POLL_MS));
  };
  /** Re-derives the idle period from the browser and plugin session counts: either holds it off, the last one going starts it. */
  const activityChanged = (): void => {
    if (stopped) return;
    if (holdsRunner || browserCount() > 0 || pluginSessions > 0) {
      idleSince = undefined;
      disarmIdle();
    } else if (idleSince === undefined) {
      idleSince = now();
      lastActivity = idleSince;
      armIdle();
    }
    writeStatus();
  };
  const onPeer = (appId: string) => (browserKeyId: string, present: boolean): void => {
    const set = peers.get(appId);
    if (!set) return;
    if (present) set.add(browserKeyId);
    else set.delete(browserKeyId);
    activityChanged();
  };
  const log = (appId: string) => (level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void => {
    if (level === "debug") return;
    deps.stderr(`[${appId}] ${level}: ${message}${fields ? ` ${JSON.stringify(fields)}` : ""}\n`);
  };

  for (const app of apps) {
    const limiter = createSessionLimiter(caps);
    const pluginIds = new Set(installed.filter((p) => p.appId === app.appId).map((p) => p.manifest.id));
    const appPaths = appPathsOf(deps, app.appId);
    const config = await appConfigOf(deps, app.appId);
    for (const warning of config.warnings) log(app.appId)("warn", warning);
    // One audit log per installed plugin (`<auditDir>/<id>.jsonl`; the file is opened on its first write). The policy
    // cancels a contained decision unless its plugin's log is known and healthy: no log, no approval.
    const appPlugins = installed.filter((p) => p.appId === app.appId);
    const auditLogs = new Map<string, FileAuditLog>(
      appPlugins.map((p) => [p.manifest.id, createAuditLog(auditFilesOf(appPaths, p.manifest.id)[0]!, { now })]),
    );
    let policy: LocalPolicy;
    if (deps.policy) policy = deps.policy;
    else {
      const built = await policyOf(deps, machinePolicy!, app, config.policy, protectedPaths, {
        auditFailed: (pluginId) => auditLogs.get(pluginId)?.failed ?? true,
        ...(config.agent?.model !== undefined ? { agentModel: config.agent.model } : {}),
      });
      for (const warning of built.warnings) log(app.appId)("warn", warning);
      policy = built.policy;
    }
    const proxy = createAcpProxy({
      appId: app.appId,
      adapters: limiter.wrapAdapters(orderAdapters(adapters, config.agent?.default)),
      policy,
      extensions: scopeExtensions(host.router, pluginIds),
      defaultCwd: deps.defaultCwd ?? appPaths.workDir,
      log: log(app.appId),
      // Contained plugin sessions. The grant itself comes with the request (the plugin host reads it at each start); what
      // the proxy adds is where the session runs, the plugin's one audit log (the object `auditFailed` reads, so a log that
      // failed stops approvals and records alike), and where the plugin lives, so the command line it checks against the
      // grant is the one the host built. The host's `nodePath` is not set by the CLI, so both sides use `process.execPath`.
      contained: {
        sessionsDir: appPaths.sessionsDir,
        // The app's `agent.model` is the model of a session whose request names none: the proxy resolves it once for the
        // policy's admission and the launch. The same value reaches the policy as `agentModel`, which a built policy needs.
        ...(config.agent?.model !== undefined ? { defaultModel: config.agent.model } : {}),
        auditLogOf: (pluginId) => {
          const audit = auditLogs.get(pluginId);
          if (!audit) throw new Error(`no audit log for plugin ${pluginId}`);
          return audit;
        },
        resolutionOf: (pluginId) => {
          const plugin = appPlugins.findLast((p) => p.manifest.id === pluginId);
          return plugin ? { installDir: plugin.installDir, dataDir: plugin.dataDir, surfaceSha256Of } : undefined;
        },
      },
    });
    proxies.set(app.appId, proxy);
    // The plugin host starts its sessions through this one: an open plugin session keeps the runner from idling out.
    host.setBroker(app.appId, countSessions(proxy.broker, () => { pluginSessions += 1; activityChanged(); }, () => { pluginSessions -= 1; activityChanged(); }));

    // A local app is an app in everything above (limiter, config, audit, policy, proxy, plugins) and has no link: no
    // socket, token, revoked mark or E2EE identity is created for it, and no browser can reach it.
    if (isLocalApp(app)) {
      linkStatuses.set(app.appId, "local");
      continue;
    }

    const e2ee: RunnerE2eeContext = {
      // The same identity `enroll` and `browsers` use, and the id the relay hello carries: the
      // app's device id (`DeviceRecord.deviceId`), one per app server, kept across restarts in apps.json.
      app: e2eeAppOf(app, deps),
      e2ee: options.e2ee !== false,
    };
    const pairing = pairingConfigFor(app, deps);
    // A connection that does not last is logged at every backoff step, with why, so a relay that refuses this
    // runner (403 for a revoked runner id) or cannot be reached is never silent while the link retries.
    const watched = watchSockets(deps.socket ?? nodeSocket);
    // A mark that names this record's runner id: the relay already refused it for good. The link still tries (the relay decides).
    const priorMark = await readRevokedMark(deps, app.appId);
    if (priorMark?.runnerId === app.runnerId) {
      log(app.appId)("warn", `this runner id was revoked on ${printable(priorMark.at)}; run \`bridge connect ${printable(app.url)}\``);
    }
    let step = 0;
    const link = createAppLink({
      appId: app.appId,
      runnerId: app.runnerId,
      relayUrl: app.relayUrl,
      runnerVersion: CLI_VERSION,
      hostname: os.hostname(),
      os: platformOf(deps),
      getToken: (signal) => getValidAccessToken(pairing, credentials, { key: tokenKey(app.appId), ...(signal ? { signal } : {}) }),
      agents: () => Promise.all(adapters.map((a) => a.availability())),
      socket: watched.socket,
      demux: {
        makeChannel: (wire) => limiter.wrapChannel(wrapRunnerChannel(wire, e2ee)),
        attach: (channel) => proxy.attach(channel),
        acceptEnrollment: (wire, start) => acceptEnrollment(wire, start, e2ee),
        ...(deps.peerGoneGraceMs !== undefined ? { peerGoneGraceMs: deps.peerGoneGraceMs } : {}),
        onPeer: onPeer(app.appId),
        log: log(app.appId),
      },
      ...(deps.backoff ? { backoff: deps.backoff } : {}),
      sleep: (ms, signal) => {
        step += 1;
        log(app.appId)("warn", `relay connection failed (${watched.reason()}); retrying in ${Math.round(ms / 100) / 10} s (attempt ${step}); if ${printable(app.name)} lists this machine as revoked, run \`bridge apps remove ${app.appId}\` and then \`bridge setup ${printable(app.url)}\``);
        return sleep(ms, signal);
      },
      ...(options.linkTimers ? { timers: options.linkTimers } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      onStatus(status, detail) {
        deps.stdout(`[${app.appId}] ${status}${detail ? `: ${detail}` : ""}\n`);
        linkStatuses.set(app.appId, status);
        if (status === "online") step = 0;
        if (status === "revoked") markRevoked(app, appPaths.revokedFile, detail);
        // A parked link closes its demux, which cancels the departure timers without reporting the
        // browsers gone: forget them here, or the count (and the idle stop) would never recover.
        if (TERMINAL.has(status) && peers.get(app.appId)?.size) {
          peers.get(app.appId)!.clear();
          activityChanged();
        } else writeStatus();
      },
    });
    links.set(app.appId, link);
  }

  // Plugins are optional: a plugin that fails to start is logged and the links start anyway.
  // Only the plugins of the connected apps are started (not those of removed apps).
  const started = await Promise.allSettled(apps.map((app) => host.start(app.appId)));
  started.forEach((result, i) => {
    if (result.status === "fulfilled") return;
    const reason = result.reason as unknown;
    const errors = reason instanceof AggregateError ? (reason.errors as unknown[]) : [reason];
    for (const error of errors) {
      log(apps[i]!.appId)("error", `plugin failed to start: ${printable(error instanceof Error ? error.message : String(error))}`);
    }
  });
  // The file exists before the first link comes up, so `bridge enroll` in another process sees a runner at once.
  writeStatus();
  enrollStamp = await enrollDirStamp(deps, apps);
  if (!holdsRunner) armIdle();
  const settled = Promise.all([...links.values()].map((l) => l.start())).then(() => undefined);
  let stopping: Promise<void> | undefined;
  return {
    statuses: () => Object.fromEntries(linkStatuses),
    link: (id) => links.get(id),
    proxy: (id) => proxies.get(id),
    settled,
    idle,
    browsers: browserCount,
    stop() {
      stopping ??= (async () => {
        stopped = true;
        disarmIdle();
        try {
          await Promise.all([...links.values()].map((l) => l.stop()));
          await Promise.all([...proxies.values()].map((p) => p.close()));
        } finally {
          try {
            // The plugin children are detached process groups: always stop them.
            await host.stopAll();
            // A clean exit leaves no status file; a stale one (dead pid) reads as "not running" anyway.
            await writing;
            await marking;
            await removeRunnerStatus(deps).catch(() => undefined);
          } finally {
            // Last, whatever failed above: each app's worker lock (its plugins are stopped), then the machine-wide lock.
            await releaseAll(held);
          }
        }
        await settled;
      })();
      return stopping;
    },
  };
}

/** Whether an agent's adapter resolves to no command at all (not bridge's copy, not its `$BRIDGE_<AGENT>_ADAPTER`, not one on PATH). An adapter that cannot say (a stand-in) is not missing. */
function adapterMissing(deps: CliDeps, agent: AdapterAgent): boolean {
  const adapter = adaptersOf(deps).find((a) => a.id === agent);
  if (adapter === undefined || !("resolved" in adapter) || typeof adapter.resolved !== "function") return false;
  return (adapter as AcpAgentAdapter).resolved() === undefined;
}

/**
 * The warnings printed once after the started line for an agent whose adapter is not installed. Claude is always
 * named. Codex only when bridge holds a codex login (someone who never set codex up is not nagged): then a codex
 * session is refused for want of the adapter, and the line names the command.
 */
async function missingAdapterWarnings(deps: CliDeps): Promise<string[]> {
  const lines: string[] = [];
  for (const agent of ["claude", "codex"] as const) {
    if (!adapterMissing(deps, agent)) continue;
    if (agent === "codex" && !(await agentLoginIsPresent(deps, "codex").catch(() => false))) continue;
    lines.push(`bridge run: warn: the ${agent} adapter is not installed; ${agent} sessions are refused until you run \`${ADAPTER_KINDS[agent].command}\`\n`);
  }
  return lines;
}

/** The line printed (and notified) when the runner starts. */
function startedMessage(apps: AppRecord[]): string {
  const names = apps.map((a) => `${printable(a.name)}${isLocalApp(a) ? " (local)" : ""}`).join(", ");
  const stops = apps.some(isLocalApp) ? "It stays up until stopped: a local app is served." : `It stops after ${IDLE_STOP_MS / 60_000} minutes with no browser connected.`;
  return `Bridge runner started. Connected apps: ${names}. ${stops}`;
}

/** `bridge run [--no-e2ee]`: serves every connected app until stopped, or until it has been idle for 15 minutes. */
export async function runRun(args: string[], deps: CliDeps, options: { idle?: IdleOptions; linkTimers?: LinkTimers; isPidAlive?: (pid: number) => boolean } = {}): Promise<number> {
  const { values, positionals } = parse(args, { "no-e2ee": { type: "boolean" } });
  if (positionals.length > 0) throw new UsageError("usage: bridge run [--no-e2ee]");
  await assertNoLegacyLayout(deps);
  const apps = await loadApps(deps);
  if (apps.length === 0) {
    deps.stderr("bridge run: no app is connected and no local app exists; run `bridge connect <app-url>` or `bridge apps add-local <app-id>` first\n");
    return 1;
  }
  const e2ee = !(values["no-e2ee"] || deps.env.BRIDGE_E2EE === "0");
  if (!e2ee) deps.stderr("bridge run: end-to-end encryption is OFF (plaintext channels); use this only for local development\n");

  // Handlers go in before anything is started, so a signal during startup still stops the children.
  const controller = new AbortController();
  const signal = deps.signal ?? controller.signal;
  const stopOnSignal = () => controller.abort();
  if (!deps.signal) {
    process.once("SIGINT", stopOnSignal);
    process.once("SIGTERM", stopOnSignal);
  }
  let handle: RunnerHandle;
  try {
    handle = await startRunner(deps, apps, { e2ee, ...(options.idle ? { idle: options.idle } : {}), ...(options.linkTimers ? { linkTimers: options.linkTimers } : {}), ...(options.isPidAlive ? { isPidAlive: options.isPidAlive } : {}) });
  } catch (error) {
    process.off("SIGINT", stopOnSignal);
    process.off("SIGTERM", stopOnSignal);
    // Another runner holds the lock (or no app can be served): one line, exit 1, nothing was swept or written.
    if (error instanceof LockRefused) {
      deps.stderr(`bridge run: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  // Tell the user the runner is up and, once per start, which apps have no trusted browser yet.
  const message = startedMessage(apps);
  deps.stderr(`bridge run: ${message}\n`);
  void notifyOf(deps)({ title: "Bridge runner started", body: message }).catch(() => undefined);
  for (const line of await missingAdapterWarnings(deps)) deps.stderr(line);
  // A newer bridge in the registry: one bounded request, in the background, never installs; it stops with the runner.
  const updateCheck = new AbortController();
  signal.addEventListener("abort", () => updateCheck.abort(), { once: true });
  void checkForUpdate(deps, { signal: updateCheck.signal }).then((notice) => {
    if (notice !== undefined && !updateCheck.signal.aborted) deps.stderr(updateInfoOf(notice));
  }).catch(() => undefined);
  if (e2ee) {
    for (const app of apps.filter((a): a is HostedAppRecord => !isLocalApp(a))) {
      const trusted = await e2eeOf(deps).listBrowsers(e2eeAppOf(app, deps)).then((list) => list.length, () => undefined);
      if (trusted === 0) deps.stderr(`bridge run: no browser is trusted for ${printable(app.name)}; run \`bridge enroll ${app.appId}\` or \`bridge setup ${printable(app.url)}\`\n`);
    }
  }
  const aborted = new Promise<"signal">((resolve) => {
    if (signal.aborted) resolve("signal");
    else signal.addEventListener("abort", () => resolve("signal"), { once: true });
  });
  let idleStopped = false;
  const idled = handle.idle.then(() => "idle" as const);
  // A pending promise does not keep Node alive, and the relay timers are unref'd: while a link retries (the relay
  // refuses it with 403, or never finishes the handshake) nothing else may hold the loop open, and Node would exit
  // 13 ("unsettled top-level await") with no line, which a service manager restarts at once. The runner is up until
  // it is told to stop or idles out, whatever its links are doing.
  const keepAlive = setInterval(() => undefined, 1 << 30);
  try {
    // With no hosted app `settled` is already resolved and would end the wait at once: it joins the race only for a hosted app.
    const hosted = apps.some((a) => !isLocalApp(a));
    const first = await Promise.race([aborted, ...(hosted ? [handle.settled.then(() => "settled" as const)] : []), idled]);
    if (first === "settled") {
      // Every app is parked on a final status. Returning would make a service manager restart the
      // runner (systemd Restart=on-failure, launchd KeepAlive) and retry at once, which defeats
      // "not retried" for 4409 and hammers the token endpoint and server. Stay up and say why.
      for (const [id, status] of Object.entries(handle.statuses())) {
        if (status !== "stopped" && status !== "local") deps.stderr(`bridge run: ${id} is ${status} and will not be retried; waiting for a stop signal (fix it, then restart)\n`);
      }
      idleStopped = (await Promise.race([aborted, idled])) === "idle";
    } else {
      idleStopped = first === "idle";
    }
  } finally {
    updateCheck.abort();
    clearInterval(keepAlive);
    process.off("SIGINT", stopOnSignal);
    process.off("SIGTERM", stopOnSignal);
    await handle.stop();
  }
  // An idle stop is a normal exit, even when every app was parked: the service manager must not restart it.
  if (idleStopped) {
    deps.stderr(`bridge run: no browser was connected for ${IDLE_STOP_MS / 60_000} minutes; stopped. Start it again with \`bridge run\`.\n`);
    return 0;
  }
  // Exit non-zero when an app ended on a problem the user must fix, so a service manager shows it.
  const bad = Object.values(handle.statuses()).some((s) => s !== "stopped" && s !== "local");
  return bad ? 1 : 0;
}
