/**
 * The argv assertion. The real bundled claude ACP adapter is started by the production
 * `createAcpAgentAdapter` with the production env rule, and the production `spawn` builds `session/new`. `CLAUDE_CODE_EXECUTABLE` points at a test-only POSIX `sh` recorder, so the claude
 * binary, the network, the model and a login are never touched. The recorded argv must equal the literal list below
 * token for token, on the pinned pair.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_ENV_DENY } from "../../sandbox/index.js";
import { createAcpAgentAdapter } from "../adapters.js";
import { CLAUDE_BUILTIN_TOOL_NAMES, ContainmentRefused, type AgentProcess, type ContainmentRequest } from "../contracts.js";
import { spawnAcpProcess, type SpawnAcpProcessOptions } from "../process.js";
import { createRpcPeer, RpcError } from "../rpc.js";

import { claudeContainmentSupportWithSeams } from "./claude.js";

const RECORDER = fileURLToPath(new URL("./fixtures/claude-argv-recorder", import.meta.url));
const CLI_PACKAGE_JSON = fileURLToPath(new URL("../../../../cli/package.json", import.meta.url));
/** The adapter command the CLI hands the runner: its bundled `.bin` entry. */
const BUNDLED_ADAPTER = path.join(path.dirname(CLI_PACKAGE_JSON), "node_modules/.bin/claude-agent-acp");
const SECRET = "s3cret-VALUE-9f1c2e7a4b";
const NODE = process.execPath;
/** Containment is measured on Linux x64 only (`resolveClaudeStack`); elsewhere a contained spawn is refused. */
const linuxX64 = process.platform === "linux" && process.arch === "x64";
const STUB_SERVER = "/opt/plugin/dist/corpus-mcp.js";

const globRe = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
const DENY_RES = DEFAULT_ENV_DENY.map(globRe);

let root: string;
let tmpBase: string;
let recordDir: string;
let loginFile: string;
const live: AgentProcess[] = [];

beforeEach(async () => {
  // os.tmpdir() follows TMPDIR, which CI may point at an on-disk directory.
  root = await mkdtemp(path.join(os.tmpdir(), "bridge-argv-"));
  tmpBase = path.join(root, "tmp");
  recordDir = path.join(root, "records");
  loginFile = path.join(root, "bridge-config/agents/claude/.credentials.json");
  await Promise.all([mkdir(tmpBase), mkdir(recordDir), mkdir(path.join(root, "home")), mkdir(path.dirname(loginFile), { recursive: true })]);
  await writeFile(loginFile, JSON.stringify({ claudeAiOauth: { accessToken: "fake-access-token", refreshToken: "fake-refresh" } }), { mode: 0o600 });
});
afterEach(async () => {
  await Promise.all(live.splice(0).map((p) => p.kill()));
  await rm(root, { recursive: true, force: true });
});

interface Invocation {
  argv: string[];
  env: Record<string, string>;
}

async function readInvocations(): Promise<Invocation[]> {
  const files = (await readdir(recordDir)).filter((f) => f.endsWith(".argv")).sort();
  const out: Invocation[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(recordDir, file), "utf8");
    const argv = raw.split("\0");
    argv.pop(); // every argument ends with NUL, the last one included (an empty last argument stays)
    const env: Record<string, string> = {};
    for (const line of (await readFile(path.join(recordDir, file.replace(/\.argv$/, ".env")), "utf8")).split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    out.push({ argv, env });
  }
  return out;
}

interface Variant {
  model?: string;
  withServer?: boolean;
  /** Edits the production `session/new` params before they are sent (a negative case). */
  mutate?: (sessionNew: { mcpServers: Record<string, unknown>[]; _meta: { claudeCode: { options: Record<string, unknown> } } }) => void;
  /** Adds env after the production env rule, through the `spawnProcess` seam (a negative case). */
  extraEnv?: Record<string, string>;
  /** Recorder-only nonroot control; no login is staged or used. */
  unstaged?: boolean;
}

async function run(variant: Variant) {
  const withServer = variant.withServer ?? true;
  const logs: string[] = [];
  const sessionId = randomUUID();
  const request: ContainmentRequest = {
    sessionId,
    servers: withServer ? [{ name: "corpus", command: NODE, args: [STUB_SERVER, "--data=/data/corpus", "${SESSION_SECRET_FILE}"] }] : [],
    allow: withServer ? ["mcp__corpus__read"] : [],
    ...(withServer ? { secret: new TextEncoder().encode(SECRET) } : {}),
    ...(variant.model !== undefined ? { model: variant.model } : {}),
  };
  const adapter = createAcpAgentAdapter({
    id: "claude",
    command: { command: BUNDLED_ADAPTER, source: "bundled" },
    environment: { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", BRIDGE_ARGV_RECORD_DIR: recordDir }, homedir: path.join(root, "home"), tmpBase },
    credentialsFor: variant.unstaged ? undefined : "claude-code",
    authFiles: { "claude-code": loginFile },
    envPolicy: { allow: ["BRIDGE_ARGV_RECORD_DIR"] },
    containment: claudeContainmentSupportWithSeams({ binaryPath: RECORDER }),
    log: (line) => logs.push(line),
    spawnProcess: async (o: SpawnAcpProcessOptions) => (await spawnAcpProcess({ ...o, env: { ...o.env, ...variant.extraEnv } })) as AgentProcess,
  });
  const cwd = path.join(root, "sessions", sessionId);
  const proc = await adapter.spawn({ cwd, appId: "app", containment: request });
  live.push(proc);
  const sandboxes = (await readdir(tmpBase)).filter((d) => !d.startsWith("bridge-acp-secrets-"));
  const sessionNew = JSON.parse(JSON.stringify(proc.sessionNew)) as NonNullable<Parameters<NonNullable<Variant["mutate"]>>[0]>;
  variant.mutate?.(sessionNew);

  const peer = createRpcPeer(proc.stream, { onRequest: () => null, onNotification: () => undefined });
  await peer.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const error = await peer.request("session/new", { cwd, ...sessionNew }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "the recorder refuses the session argv, so session/new fails").toBeInstanceOf(RpcError);
  expect((error as RpcError).code).toBe(-32603);
  return { invocations: await readInvocations(), sessionId, sessionNew, sandboxes, logs, request };
}

/** The session invocation in order. The `--session-id=` value is a placeholder. */
function expectedSessionArgv(options: { model?: string; mcpConfig?: string }): string[] {
  return [
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    ...(options.model !== undefined ? [`--model=${options.model}`] : []),
    "--permission-prompt-tool=stdio",
    `--disallowedTools=${[...CLAUDE_BUILTIN_TOOL_NAMES, "AskUserQuestion"].join(",")}`,
    "--tools=",
    ...(options.mcpConfig !== undefined ? ["--mcp-config", options.mcpConfig] : []),
    "--setting-sources=",
    "--strict-mcp-config",
    "--permission-mode=default",
    "--include-partial-messages",
    "--session-id=<uuid>",
    "--no-session-persistence",
    "--restricted",
    "--disable-slash-commands",
    "--replay-user-messages",
    "",
  ];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Splits the two invocations; fails when there are not exactly the probe and the session. */
function twoInvocations(invocations: Invocation[]) {
  expect(invocations.map((i) => i.argv[0] === "auth" ? i.argv : "session")).toEqual([["auth", "status", "--json"], "session"]);
  const session = invocations.find((i) => i.argv[0] !== "auth")!;
  const idArg = session.argv.find((a) => a.startsWith("--session-id="))!;
  expect(idArg.slice("--session-id=".length)).toMatch(UUID);
  return { session, normalized: session.argv.map((a) => (a === idArg ? "--session-id=<uuid>" : a)) };
}

function mcpConfigOf(argv: string[]): { json: string; value: unknown } {
  const at = argv.indexOf("--mcp-config");
  expect(at).toBeGreaterThan(-1);
  const json = argv[at + 1]!;
  return { json, value: JSON.parse(json) };
}

describe.skipIf(!linuxX64)("the session argv of the pinned adapter and binary", () => {
  it("server + secret + model: equals the literal list, token for token", async () => {
    const { invocations, request } = await run({ model: "haiku" });
    const { session, normalized } = twoInvocations(invocations);
    const mcp = mcpConfigOf(session.argv);
    expect(normalized).toEqual(expectedSessionArgv({ model: "haiku", mcpConfig: mcp.json }));
    // The one --mcp-config value: the resolved server, an empty env, the secret's path and never its value.
    const secretFile = request.servers[0] && (mcp.value as { mcpServers: { corpus: { args: string[] } } }).mcpServers.corpus.args[2]!;
    expect(mcp.value).toEqual({ mcpServers: { corpus: { type: "stdio", command: NODE, args: [STUB_SERVER, "--data=/data/corpus", secretFile], env: {} } } });
    expect(secretFile).toMatch(new RegExp(`/bridge-acp-secrets-${request.sessionId}/corpus$`));
    expect(mcp.json).not.toContain(SECRET);
    expect(session.argv.join("\0")).not.toContain(SECRET);
  }, 60_000);

  it("server + secret, no model: no --model token", async () => {
    const { invocations } = await run({});
    const { session, normalized } = twoInvocations(invocations);
    expect(normalized).toEqual(expectedSessionArgv({ mcpConfig: mcpConfigOf(session.argv).json }));
    expect(session.argv.some((a) => a.startsWith("--model"))).toBe(false);
  }, 60_000);

  it("no server: no --mcp-config at all", async () => {
    const { invocations } = await run({ withServer: false, model: "sonnet" });
    const { normalized } = twoInvocations(invocations);
    expect(normalized).toEqual(expectedSessionArgv({ model: "sonnet" }));
    expect(normalized).not.toContain("--mcp-config");
  }, 60_000);

  it("the session env: sdk-ts entrypoint, no NODE_OPTIONS, the sandbox dirs, no denied key, the secret in no value", async () => {
    const { invocations, sandboxes } = await run({ model: "haiku" });
    const { session } = twoInvocations(invocations);
    const env = session.env;
    expect(sandboxes).toHaveLength(1);
    const sandbox = path.join(tmpBase, sandboxes[0]!);
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
    expect(env.HOME).toBe(path.join(sandbox, "home"));
    expect(env.TMPDIR).toBe(sandbox);
    expect(env.XDG_CONFIG_HOME).toBe(path.join(sandbox, "xdg-config"));
    expect(env.XDG_CACHE_HOME).toBe(path.join(sandbox, "xdg-cache"));
    expect(env.XDG_DATA_HOME).toBe(path.join(sandbox, "xdg-data"));
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(sandbox, "claude-home"));
    expect(env.CLAUDE_CODE_EXECUTABLE).toBe(RECORDER);
    // BRIDGE_ARGV_RECORD_DIR is the test's own channel to the recorder, allowed by the test's envPolicy.
    for (const key of Object.keys(env)) {
      if (key === "BRIDGE_ARGV_RECORD_DIR") continue;
      expect(DENY_RES.some((re) => re.test(key)), `${key} matches DEFAULT_ENV_DENY`).toBe(false);
    }
    for (const [key, value] of Object.entries(env)) expect(value, key).not.toContain(SECRET);
  }, 60_000);
});

describe.skipIf(!linuxX64)("negative cases: each guard, dropped, must change the argv", () => {
  const sessionArgv = async (variant: Variant) => twoInvocations((await run(variant)).invocations).session.argv;

  it("extraArgs without restricted: no --restricted token", async () => {
    const argv = await sessionArgv({ mutate: (p) => delete (p._meta.claudeCode.options.extraArgs as Record<string, unknown>).restricted });
    expect(argv).not.toContain("--restricted");
    expect(argv).toContain("--disable-slash-commands");
  }, 60_000);

  it("extraArgs without disable-slash-commands: the token is absent", async () => {
    const argv = await sessionArgv({ mutate: (p) => delete (p._meta.claudeCode.options.extraArgs as Record<string, unknown>)["disable-slash-commands"] });
    expect(argv).not.toContain("--disable-slash-commands");
    expect(argv).toContain("--restricted");
  }, 60_000);

  it.skipIf(process.getuid?.() === 0)("allowDangerouslySkipPermissions omitted: --allow-dangerously-skip-permissions is present (non-root)", async () => {
    // A staged login now requires a user namespace (UID0 inside it), where the SDK
    // suppresses this dangerous flag itself. Keep this recorder-only SDK mutation
    // control nonroot without staging any credentials; production stays namespaced.
    const argv = await sessionArgv({ unstaged: true, mutate: (p) => delete p._meta.claudeCode.options.allowDangerouslySkipPermissions });
    expect(argv).toContain("--allow-dangerously-skip-permissions");
  }, 60_000);

  it('a server env entry lands in the --mcp-config value', async () => {
    const argv = await sessionArgv({ mutate: (p) => (p.mcpServers[0]!.env = [{ name: "X", value: "1" }]) });
    expect(mcpConfigOf(argv).json).toContain('"env":{"X":"1"}');
  }, 60_000);

  it("CLAUDE_MODEL_CONFIG in the adapter env: --settings on the session invocation", async () => {
    // Only `modelOverrides` and `availableModels` are read from it (acp-agent.js parseModelConfig), so these are the
    // values that matter. The `auth status` probe at `initialize` runs before any session settings exist; the
    // probes after a prompt carry `--settings` too, but this test never sends a prompt (the recorder refuses the
    // session argv), so the contained env rule (`CONTAINED_ENV_DENY`) is what keeps the variable out in production.
    const config = { modelOverrides: { "claude-haiku": "other-model" } };
    const { invocations } = await run({ extraEnv: { CLAUDE_MODEL_CONFIG: JSON.stringify(config) } });
    const { session } = twoInvocations(invocations);
    const at = session.argv.indexOf("--settings");
    expect(at).toBeGreaterThan(-1);
    expect(JSON.parse(session.argv[at + 1]!)).toEqual(config);
  }, 60_000);

  it("settingSources omitted: --setting-sources=user,project,local", async () => {
    const argv = await sessionArgv({ mutate: (p) => delete p._meta.claudeCode.options.settingSources });
    expect(argv).toContain("--setting-sources=user,project,local");
    expect(argv).not.toContain("--setting-sources=");
  }, 60_000);

  it("tools omitted: no --tools= token", async () => {
    const argv = await sessionArgv({ mutate: (p) => delete p._meta.claudeCode.options.tools });
    expect(argv).not.toContain("--tools=");
  }, 60_000);
});

describe.skipIf(linuxX64)("off the measured platform (Linux x64) a contained spawn is refused, and nothing starts", () => {
  it("the production adapter refuses with -32016 before any process or file", async () => {
    const adapter = createAcpAgentAdapter({
      id: "claude",
      command: { command: BUNDLED_ADAPTER, source: "bundled" },
      environment: { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, homedir: path.join(root, "home"), tmpBase },
      credentialsFor: "claude-code",
      authFiles: { "claude-code": loginFile },
      containment: claudeContainmentSupportWithSeams({ binaryPath: RECORDER }),
    });
    const sessionId = randomUUID();
    const request: ContainmentRequest = { sessionId, servers: [], allow: [] };
    const error = await adapter.spawn({ cwd: path.join(root, "sessions", sessionId), appId: "app", containment: request }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainmentRefused);
    expect((error as ContainmentRefused).code).toBe(-32016);
    expect(await readdir(tmpBase)).toEqual([]);
    expect(await readdir(recordDir)).toEqual([]);
  });
});
