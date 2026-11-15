import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { JsonRpcMessage, PluginManifest, SessionEndReason, SessionEvent } from "@berdyh/bridge-protocol";
import { PROXY_ERROR, containmentRefusalDataOf, type AgentSessionBroker, type AgentSessionBrokerRequest, type BrokeredSession } from "../acp/contracts.js";
import { RpcError } from "../acp/rpc.js";
import { ManagedPlugin, type ProcessOptions } from "./process.js";
import { surfaceOf, surfaceSha256Of } from "./consent.js";
import type { ConsentedGrant, InstalledPlugin } from "./contracts.js";

it.each(["stop", "crash"])("%s completes while an escaped descendant holds stdout and stderr open", async (operation) => {
  const temp = await mkdtemp(fileURLToPath(new URL(".test-", import.meta.url)));
  const installDir = path.join(temp, "install"); const dataDir = path.join(temp, "data");
  await mkdir(installDir); await mkdir(dataDir);
  await writeFile(path.join(installDir, "entry.cjs"), `
    const {spawn} = require('node:child_process');
    process.on('SIGTERM',()=>process.exit(0));
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if(m.params.method.endsWith('/crash')) process.exit(1);
      const sub = spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),10000)'],{
        detached:true,stdio:['ignore','inherit','inherit']
      });
      sub.unref();
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:sub.pid})+'\\n');
    });
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'plugin/ready'})+'\\n');
  `);
  const installed: InstalledPlugin = { manifest: { id: "test", app: "app", entry: "entry.cjs", permissions: {} }, appId: "app", version: "1.0.0", installDir, dataDir, status: "stopped" };
  const plugin = new ManagedPlugin(installed, { pathBoundary: temp, broker: () => undefined, restartDelayMs: 10, stopTimeoutMs: 100 });
  const caller = { appId: "app", browserKeyId: "browser" };
  let escaped: number | undefined;
  try {
    await plugin.start();
    escaped = await plugin.call("_test/spawn", {}, caller) as number;
    if (operation === "stop") {
      let stopped = false;
      const stopping = plugin.stop().then(() => { stopped = true; });
      await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 1_500 });
      await stopping; expect(plugin.status).toBe("stopped");
    } else {
      await expect(plugin.call("_test/crash", {}, caller)).rejects.toThrow("closed");
      await vi.waitFor(() => expect(plugin.status).toBe("running"), { timeout: 1_500 });
      expect(plugin.restarts).toBe(1);
    }
    // Group shutdown cannot reach a descendant that starts a new session.
    expect(() => process.kill(escaped!, 0)).not.toThrow();
  } finally {
    if (escaped !== undefined) { try { process.kill(-escaped, "SIGKILL"); } catch { /* Already exited. */ } }
    await plugin.stop(); await rm(temp, { recursive: true, force: true });
  }
});

it("stops after spawn failure without waiting for an exit event", async () => {
  const temp = await mkdtemp(fileURLToPath(new URL(".test-", import.meta.url)));
  const installDir = path.join(temp, "install"); const dataDir = path.join(temp, "data");
  await mkdir(installDir); await mkdir(dataDir); await writeFile(path.join(installDir, "entry.cjs"), "");
  const installed: InstalledPlugin = { manifest: { id: "test", app: "app", entry: "entry.cjs", permissions: {} }, appId: "app", version: "1.0.0", installDir, dataDir, status: "stopped" };
  const plugin = new ManagedPlugin(installed, { pathBoundary: temp, nodePath: path.join(temp, "missing-node"), broker: () => undefined, restartDelayMs: 10_000, stopTimeoutMs: 10 });
  try {
    await expect(plugin.start()).rejects.toMatchObject({ code: "ENOENT" });
    let stopped = false;
    const stopping = plugin.stop().then(() => { stopped = true; });
    await vi.waitFor(() => expect(stopped).toBe(true));
    await stopping; expect(plugin.status).toBe("stopped");
  } finally { await plugin.stop(); await rm(temp, { recursive: true, force: true }); }
});

it("does not count a disconnected process as healthy during its shutdown grace", async () => {
  const temp = await mkdtemp(fileURLToPath(new URL(".test-", import.meta.url)));
  const installDir = path.join(temp, "install"); const dataDir = path.join(temp, "data");
  await mkdir(installDir); await mkdir(dataDir);
  await writeFile(path.join(installDir, "entry.cjs"), `
    process.on('SIGTERM',()=>{});
    require('node:readline').createInterface({input:process.stdin}).on('line', () => process.stdout.end());
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'plugin/ready'})+'\\n');
  `);
  const installed: InstalledPlugin = { manifest: { id: "test", app: "app", entry: "entry.cjs", permissions: {} }, appId: "app", version: "1.0.0", installDir, dataDir, status: "stopped" };
  const plugin = new ManagedPlugin(installed, { pathBoundary: temp, broker: () => undefined, restartDelayMs: 1_000, stopTimeoutMs: 200, healthyAfterMs: 50 });
  plugin.restarts = 3;
  try {
    await plugin.start();
    await expect(plugin.call("_test/disconnect", {}, { appId: "app", browserKeyId: "browser" })).rejects.toThrow("closed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(plugin.restarts).toBe(3); expect(plugin.status).toBe("crashed");
  } finally { await plugin.stop(); await rm(temp, { recursive: true, force: true }); }
});

it("resets restart backoff only after an injectable healthy running period", async () => {
  const temp = await mkdtemp(fileURLToPath(new URL(".test-", import.meta.url)));
  const installDir = path.join(temp, "install"); const dataDir = path.join(temp, "data");
  await mkdir(installDir); await mkdir(dataDir);
  await writeFile(path.join(installDir, "entry.cjs"), `
    require('node:readline').createInterface({input:process.stdin}).on('line', () => process.exit(1));
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'plugin/ready'})+'\\n');
  `);
  const installed: InstalledPlugin = { manifest: { id: "test", app: "app", entry: "entry.cjs", permissions: {} }, appId: "app", version: "1.0.0", installDir, dataDir, status: "stopped" };
  const plugin = new ManagedPlugin(installed, { pathBoundary: temp, broker: () => undefined, restartDelayMs: 10, stopTimeoutMs: 20, healthyAfterMs: 400 });
  const caller = { appId: "app", browserKeyId: "browser" };
  try {
    await plugin.start();
    for (const count of [1, 2]) {
      await expect(plugin.call("_test/crash", {}, caller)).rejects.toThrow("closed");
      await vi.waitFor(() => expect(plugin.status).toBe("running"));
      expect(plugin.restarts).toBe(count);
    }
    await vi.waitFor(() => expect(plugin.restarts).toBe(0));
    await expect(plugin.call("_test/crash", {}, caller)).rejects.toThrow("closed");
    await vi.waitFor(() => expect(plugin.status).toBe("running"));
    expect(plugin.restarts).toBe(1);
    await plugin.stop();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(plugin.restarts).toBe(1); expect(plugin.status).toBe("stopped");
  } finally { await plugin.stop(); await rm(temp, { recursive: true, force: true }); }
});

it("stop and restart complete without unhandled rejections when group signals fail with EPERM", async () => {
  const temp = await mkdtemp(fileURLToPath(new URL(".test-", import.meta.url)));
  const installDir = path.join(temp, "install"); const dataDir = path.join(temp, "data");
  await mkdir(installDir); await mkdir(dataDir);
  await writeFile(path.join(installDir, "entry.cjs"), `
    process.on('SIGTERM',()=>process.exit(0));
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if(m.params.method.endsWith('/crash')) process.exit(1);
    });
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'plugin/ready'})+'\\n');
  `);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  // Deliver the signal for real, then report EPERM as if other members were unsignalable.
  const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
    try { process.kill(pid, signal); } catch { /* Already gone. */ }
    const error = new Error("EPERM") as NodeJS.ErrnoException; error.code = "EPERM"; throw error;
  });
  const installed: InstalledPlugin = { manifest: { id: "test", app: "app", entry: "entry.cjs", permissions: {} }, appId: "app", version: "1.0.0", installDir, dataDir, status: "stopped" };
  const plugin = new ManagedPlugin(installed, { pathBoundary: temp, broker: () => undefined, restartDelayMs: 10, stopTimeoutMs: 50, kill });
  try {
    await plugin.start();
    await expect(plugin.call("_test/crash", {}, { appId: "app", browserKeyId: "browser" })).rejects.toThrow("closed");
    await vi.waitFor(() => expect(plugin.status).toBe("running"), { timeout: 1_500 });
    await plugin.stop();
    expect(plugin.status).toBe("stopped");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(kill).toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await plugin.stop(); await rm(temp, { recursive: true, force: true });
  }
});

it("does not SIGKILL the group once a probe reports it gone", async () => {
  const temp = await mkdtemp(fileURLToPath(new URL(".test-", import.meta.url)));
  const installDir = path.join(temp, "install"); const dataDir = path.join(temp, "data");
  await mkdir(installDir); await mkdir(dataDir);
  await writeFile(path.join(installDir, "entry.cjs"), `
    process.on('SIGTERM',()=>process.exit(0));
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'plugin/ready'})+'\\n');
  `);
  const signals: Array<NodeJS.Signals | 0> = [];
  const kill = (pid: number, signal: NodeJS.Signals | 0) => {
    signals.push(signal);
    try { process.kill(pid, signal); } catch { /* Gone. */ }
    if (signal === 0) { const e = new Error("ESRCH") as NodeJS.ErrnoException; e.code = "ESRCH"; throw e; }
  };
  const installed: InstalledPlugin = { manifest: { id: "test", app: "app", entry: "entry.cjs", permissions: {} }, appId: "app", version: "1.0.0", installDir, dataDir, status: "stopped" };
  const plugin = new ManagedPlugin(installed, { pathBoundary: temp, broker: () => undefined, stopTimeoutMs: 50, kill });
  try {
    await plugin.start(); await plugin.stop();
    expect(signals).toContain("SIGTERM"); expect(signals).toContain(0); expect(signals).not.toContain("SIGKILL");
  } finally { await plugin.stop(); await rm(temp, { recursive: true, force: true }); }
});

// --- Plugin sessions: the wire between a plugin process and the broker ---------------------------------------------

/**
 * A plugin entry that relays: `_test/rpc` {method, params, withToken?} sends that request to the host and answers
 * `{ok, result | code, message, data}`; every response and host notification it receives is passed on as `_test/seen`,
 * in the order it arrived; `_test/crash` exits.
 */
const RELAY = `
  const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
  const waiting = new Map(); let next = 1000;
  require('node:readline').createInterface({input: process.stdin}).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.method === 'plugin/call') {
      const {method, params} = m.params;
      if (method.endsWith('/crash')) process.exit(1);
      const id = ++next;
      waiting.set(id, (reply) => out({jsonrpc: '2.0', id: m.id, result: reply}));
      const body = {...params.params};
      if (params.withToken) body.callToken = m.params.callToken;
      if (params.onBehalfOf) body.onBehalfOf = m.params.caller;
      out({jsonrpc: '2.0', id, method: params.method, params: body});
    } else if (m.id !== undefined && waiting.has(m.id)) {
      const reply = waiting.get(m.id); waiting.delete(m.id);
      out({jsonrpc: '2.0', method: '_test/seen', params: {kind: 'response'}});
      reply(m.error ? {ok: false, code: m.error.code, message: m.error.message, data: m.error.data} : {ok: true, result: m.result});
    } else if (m.method) {
      out({jsonrpc: '2.0', method: '_test/seen', params: {kind: 'notification', method: m.method, params: m.params}});
    }
  });
  out({jsonrpc: '2.0', method: 'plugin/ready'});
`;
const SECRET = "SECRET-TOKEN-4f9a-do-not-log";
const MANIFEST: PluginManifest = {
  id: "test", app: "app", entry: "entry.cjs",
  permissions: {
    agents: ["claude"],
    mcpServers: { notes: { entry: "dist/notes.js", args: ["--data", "${PLUGIN_DATA}", "--secret", "${SESSION_SECRET_FILE}"] } },
    headless: { tools: ["mcp__notes__append"] },
  },
};
const grantFor = (manifest: PluginManifest): ConsentedGrant => {
  const surface = surfaceOf(manifest);
  return { pluginId: manifest.id, appId: manifest.app, version: "1.0.0", surface, surfaceSha256: surfaceSha256Of(surface), time: "2026-11-03T00:00:00.000Z" };
};
const caller = { appId: "app", browserKeyId: "browser" };
type Answer = { ok: true; result: { sessionId: string } & Record<string, unknown> } | { ok: false; code: number; message: string; data?: unknown };
type Seen = { kind: "response" } | { kind: "notification"; method: string; params: { sessionId: string; event?: SessionEvent; reason?: SessionEndReason } };

/** A broker session that a test drives: `emit` and `end` are the agent's side. */
function fakeSession(id: string, shape: { events?: boolean; ended?: boolean } = {}) {
  const { events = true, ended = true } = shape;
  const handlers = new Set<(event: SessionEvent) => void>();
  let end!: (result: { reason: SessionEndReason }) => void;
  const endedPromise = new Promise<{ reason: SessionEndReason }>((resolve) => { end = resolve; });
  const unsubscribed = vi.fn();
  const session = {
    sessionId: id,
    prompt: vi.fn(async (text: string) => ({ stopReason: "end_turn", text: `echo ${text}` })),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async (reason?: "plugin_gone") => { if (ended) end({ reason: reason ?? "closed" }); }),
    ...(events ? { onUpdate: (handler: (event: SessionEvent) => void) => { handlers.add(handler); return () => { handlers.delete(handler); unsubscribed(); }; } } : {}),
    ...(ended ? { ended: endedPromise } : {}),
  } as BrokeredSession & { prompt: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  return { session, emit: (event: SessionEvent) => { for (const handler of [...handlers]) handler(event); }, end: (reason: SessionEndReason) => end({ reason }), unsubscribed, handlers };
}

async function harness(options: { manifest?: PluginManifest; grant?: ConsentedGrant | "none" | "throws"; sessions?: ReturnType<typeof fakeSession>[]; process?: Partial<ProcessOptions> } = {}) {
  const manifest = options.manifest ?? MANIFEST;
  const temp = await mkdtemp(fileURLToPath(new URL(".test-", import.meta.url)));
  const installDir = path.join(temp, "install"); const dataDir = path.join(temp, "data");
  await mkdir(path.join(installDir, "dist"), { recursive: true }); await mkdir(dataDir);
  await writeFile(path.join(installDir, "entry.cjs"), RELAY); await writeFile(path.join(installDir, "dist", "notes.js"), "");
  const installed: InstalledPlugin = { manifest, appId: manifest.app, version: "1.0.0", installDir, dataDir, status: "stopped" };
  const requests: AgentSessionBrokerRequest[] = [];
  const queue = [...(options.sessions ?? [])];
  let started = 0;
  const broker: AgentSessionBroker = { start: vi.fn(async (request) => { requests.push(request); return (queue.shift() ?? fakeSession(`broker-${++started}`)).session; }) };
  const logs: Array<[string, string, string, Record<string, unknown> | undefined]> = [];
  const state = { grant: options.grant ?? grantFor(manifest) };
  const grantOf = vi.fn(async () => {
    if (state.grant === "throws") throw new Error("consent record unreadable");
    return state.grant === "none" ? undefined : state.grant;
  });
  const plugin = new ManagedPlugin(installed, {
    pathBoundary: temp, broker: () => broker, grantOf, restartDelayMs: 20, stopTimeoutMs: 50,
    log: (pluginId, level, message, fields) => { logs.push([pluginId, level, message, fields]); },
    ...options.process,
  });
  const seen: Seen[] = [];
  plugin.onNotification((message: JsonRpcMessage) => { if (message.method === "_test/seen") seen.push(message.params as Seen); });
  await plugin.start();
  /** Sends a request from the plugin to the host; resolves with the host's answer. */
  const ask = (method: string, params: unknown, extra: { withToken?: boolean; onBehalfOf?: boolean } = {}) =>
    plugin.call("_test/rpc", { method, params, ...extra }, caller) as Promise<Answer>;
  const start = (params: unknown, extra?: { withToken?: boolean; onBehalfOf?: boolean }) => ask("host/startAgentSession", params, extra);
  const handleOf = (answer: Answer) => { if (!answer.ok) throw new Error(`start refused: ${answer.message}`); return answer.result.sessionId; };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  const done = async () => { await plugin.stop(); await rm(temp, { recursive: true, force: true }); };
  return { plugin, broker, requests, logs, seen, state, grantOf, installed, ask, start, handleOf, settle, done, temp };
}
const contained = (extra: Record<string, unknown> = {}) =>
  ({ agent: "claude", mcpServers: ["notes"], secret: SECRET, tools: { builtins: "none", allow: ["mcp__notes__append"] }, ...extra });

describe("a session start from a plugin process", () => {
  it("refuses each invalid request with the right code and never calls the broker", async () => {
    const h = await harness();
    try {
      const cases: Array<[string, unknown, number]> = [
        ["a field no one defined", { agent: "claude", permissionMode: "bypassPermissions" }, -32602],
        ["a field of the wrong type", { agent: 5 }, -32602],
        ["a cwd on a contained session", contained({ cwd: "/work" }), -32602],
        ["an oversized secret", contained({ secret: "x".repeat(4097) }), -32602],
        ["headless together with onBehalfOf", contained({ headless: true, onBehalfOf: caller }), -32602],
        ["a server the manifest does not declare", contained({ mcpServers: ["ghost"] }), -32602],
        ["a tool outside the consented headless set", contained({ tools: { builtins: "none", allow: ["mcp__notes__rm"] } }), -32602],
        ["a tool of a server that is not attached", contained({ mcpServers: undefined, secret: undefined, tools: { builtins: "none", allow: ["mcp__notes__append"] } }), -32602],
        ["a server that reads a secret, with none given", contained({ secret: undefined }), -32602],
        ["an agent the manifest does not list", { agent: "codex" }, PROXY_ERROR.sessionNotAllowed],
        ["mcpServers on an ordinary session", { agent: "claude", mcpServers: ["notes"] }, PROXY_ERROR.containmentUnavailable],
        ["a secret on an ordinary session", { agent: "claude", secret: SECRET }, PROXY_ERROR.containmentUnavailable],
        ["headless on an ordinary session", { agent: "claude", headless: true }, PROXY_ERROR.containmentUnavailable],
        ["an allow list on an ordinary session", { agent: "claude", tools: { allow: ["mcp__notes__append"] } }, PROXY_ERROR.containmentUnavailable],
        ["a budget on an ordinary session", { agent: "claude", budget: { maxToolCalls: 5 } }, PROXY_ERROR.containmentUnavailable],
      ];
      for (const [name, params, code] of cases) {
        const answer = await h.start(params);
        expect(answer, name).toMatchObject({ ok: false, code });
      }
      expect(h.broker.start).not.toHaveBeenCalled();
      expect(h.grantOf).toHaveBeenCalled();
      // Ordinary-session refusals never needed the consent; the contained ones read it.
      expect(JSON.stringify(h.logs)).not.toContain(SECRET);
    } finally { await h.done(); }
  });

  it("hands the plugin the reason code and hint of a refusal for a missing claude adapter, and no data for any other refusal", async () => {
    const h = await harness();
    try {
      const detail = "/home/secret-user/.local/share/bridge/adapters: exit 127";
      const refusal = (data?: unknown, code: number = PROXY_ERROR.containmentUnavailable) => new RpcError(code, "Contained session unavailable", data);
      const next = (error: unknown) => vi.mocked(h.broker.start).mockRejectedValueOnce(error);
      next(refusal(containmentRefusalDataOf("adapter_missing")));
      const missing = await h.start(contained());
      expect(missing).toEqual({ ok: false, code: PROXY_ERROR.containmentUnavailable, message: "Contained session unavailable", data: { reason: "adapter_missing", hint: "bridge agent install claude" } });
      // Every other refusal: the proxy's generic error has no data; so does a plain error with a detail in it.
      next(refusal());
      next(Object.assign(new Error("Contained session unavailable"), { code: PROXY_ERROR.containmentUnavailable, detail }));
      for (const answer of [await h.start(contained()), await h.start(contained())]) {
        expect(answer).toMatchObject({ ok: false, code: PROXY_ERROR.containmentUnavailable, message: "Contained session unavailable" });
        expect(answer, "no data key").not.toHaveProperty("data", expect.anything());
        expect(JSON.stringify(answer)).not.toContain("secret-user");
      }
      // Data that is not exactly the fixed shape, or that rides another code, never leaves the runner.
      next(refusal({ reason: "adapter_missing", hint: "bridge agent install claude", detail }));
      next(refusal({ reason: "adapter_missing", hint: detail }));
      next(refusal(containmentRefusalDataOf("adapter_missing"), PROXY_ERROR.sessionNotAllowed));
      for (const answer of [await h.start(contained()), await h.start(contained()), await h.start(contained())]) {
        expect(answer).toMatchObject({ ok: false });
        expect(answer).not.toHaveProperty("data", expect.anything());
        expect(JSON.stringify(answer)).not.toContain("secret-user");
      }
      expect(JSON.stringify(h.logs)).not.toContain(SECRET);
    } finally { await h.done(); }
  });

  it("refuses a contained start without a usable consent, and reads the consent at each start", async () => {
    const h = await harness();
    try {
      expect(h.handleOf(await h.start(contained()))).toBeTypeOf("string");
      h.state.grant = "none";
      expect(await h.start(contained())).toMatchObject({ ok: false, code: PROXY_ERROR.consentMissing });
      h.state.grant = "throws";
      expect(await h.start(contained())).toMatchObject({ ok: false, code: PROXY_ERROR.consentMissing });
      // A record whose surface was edited after the hash was taken.
      const edited = grantFor(MANIFEST);
      edited.surface = { items: [...edited.surface.items, { kind: "headlessTool", value: "mcp__notes__rm" }] };
      h.state.grant = edited;
      expect(await h.start(contained({ tools: { builtins: "none", allow: ["mcp__notes__rm"] } }))).toMatchObject({ ok: false, code: -32602 });
      expect(h.grantOf).toHaveBeenCalledTimes(4);
      expect(h.broker.start).toHaveBeenCalledTimes(1);
    } finally { await h.done(); }
  });

  it("refuses a contained start for headless: true when the consent holds no headless tools", async () => {
    const manifest: PluginManifest = { ...MANIFEST, permissions: { ...MANIFEST.permissions, headless: undefined } };
    const h = await harness({ manifest });
    try {
      expect(await h.start(contained({ tools: { builtins: "none" }, headless: true }))).toMatchObject({ ok: false, code: PROXY_ERROR.consentMissing });
      expect(h.broker.start).not.toHaveBeenCalled();
    } finally { await h.done(); }
  });

  it("refuses a contained start whose server entry became a link", async () => {
    const h = await harness();
    try {
      const entry = path.join(h.installed.installDir, "dist", "notes.js");
      await rm(entry); await writeFile(path.join(h.temp, "other.js"), ""); await symlink(path.join(h.temp, "other.js"), entry);
      expect(await h.start(contained())).toMatchObject({ ok: false, code: PROXY_ERROR.containmentUnavailable });
      expect(h.broker.start).not.toHaveBeenCalled();
    } finally { await h.done(); }
  });

  it("hands a valid contained request to the broker with resolved absolute entries and the consent", async () => {
    const h = await harness();
    try {
      const answer = await h.start(contained({ model: "sonnet", budget: { wallClockMs: 60_000, maxToolCalls: 10 }, headless: true }));
      expect(answer).toMatchObject({ ok: true });
      expect(h.broker.start).toHaveBeenCalledOnce();
      const request = h.requests[0]!;
      expect(request).toMatchObject({
        pluginId: "test", appId: "app", agent: "claude", mcpServers: ["notes"], secret: SECRET, model: "sonnet",
        budget: { wallClockMs: 60_000, maxToolCalls: 10 }, headless: true, tools: { builtins: "none", allow: ["mcp__notes__append"] },
        grant: grantFor(MANIFEST),
        servers: [{ name: "notes", command: process.execPath, args: [path.join(h.installed.installDir, "dist", "notes.js"), "--data", h.installed.dataDir, "--secret", "${SESSION_SECRET_FILE}"] }],
      });
      expect("cwd" in request).toBe(false);
      expect("onBehalfOf" in request).toBe(false);
    } finally { await h.done(); }
  });

  it("keeps an ordinary session as it was: cwd and model pass, the consent is not read", async () => {
    const h = await harness();
    try {
      expect(await h.start({ agent: "claude", cwd: "/work", model: "sonnet" })).toMatchObject({ ok: true });
      expect(h.requests[0]).toEqual({ pluginId: "test", appId: "app", agent: "claude", cwd: "/work", model: "sonnet" });
      expect(h.grantOf).not.toHaveBeenCalled();
    } finally { await h.done(); }
  });

  it("passes onBehalfOf only for a live call of that browser, and refuses a forged one before the broker", async () => {
    const h = await harness();
    try {
      expect(await h.start({ agent: "claude" }, { withToken: true, onBehalfOf: true })).toMatchObject({ ok: true });
      expect(h.requests[0]).toMatchObject({ onBehalfOf: { browserKeyId: "browser" } });
      expect(await h.start({ agent: "claude" }, { onBehalfOf: true })).toMatchObject({ ok: false, code: PROXY_ERROR.extensionForbidden });
      expect(await h.start({ agent: "claude", callToken: "made-up", onBehalfOf: { appId: "app", browserKeyId: "browser" } })).toMatchObject({ ok: false, code: PROXY_ERROR.extensionForbidden });
      expect(h.broker.start).toHaveBeenCalledOnce();
    } finally { await h.done(); }
  });

  it("never lets the secret reach the host log, on a start, a refusal or a broker failure", async () => {
    const h = await harness();
    try {
      await h.start(contained());
      await h.start(contained({ cwd: "/work" }));
      await h.start(contained({ mcpServers: ["ghost"] }));
      await h.start({ agent: "claude", secret: SECRET });
      h.state.grant = "none";
      const refused = await h.start(contained());
      (h.broker.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("proxy said no"), { code: PROXY_ERROR.sessionNotAllowed }));
      h.state.grant = grantFor(MANIFEST);
      const failed = await h.start(contained());
      expect(failed).toMatchObject({ ok: false, code: PROXY_ERROR.sessionNotAllowed });
      expect(h.logs.length).toBeGreaterThan(0);
      expect(JSON.stringify(h.logs)).not.toContain(SECRET);
      // Nor in what the plugin is told.
      expect(JSON.stringify([refused, failed])).not.toContain(SECRET);
    } finally { await h.done(); }
  });
});

describe("the events and the end of a brokered session", () => {
  const text = (value: string): SessionEvent => ({ type: "text", text: value });
  const updates = (seen: Seen[]) => seen.filter((s): s is Extract<Seen, { kind: "notification" }> => s.kind === "notification");

  it("delivers events in order under the runner's session id, then ended once, and drops the id", async () => {
    const fake = fakeSession("broker-id");
    const h = await harness({ sessions: [fake] });
    try {
      const handle = h.handleOf(await h.start(contained()));
      expect(handle).toBe("broker-id");
      fake.emit(text("a")); fake.emit({ type: "tool_call", id: "t1", toolName: "mcp__notes__append" }); fake.emit(text("b"));
      fake.end("budget");
      await h.settle();
      fake.end("breach"); fake.emit(text("late"));
      await h.settle();
      expect(updates(h.seen).map((s) => [s.method, s.params.sessionId, s.params.event ?? s.params.reason])).toEqual([
        ["host/sessionUpdate", handle, text("a")],
        ["host/sessionUpdate", handle, { type: "tool_call", id: "t1", toolName: "mcp__notes__append" }],
        ["host/sessionUpdate", handle, text("b")],
        ["host/sessionEnded", handle, "budget"],
      ]);
      expect(fake.unsubscribed).toHaveBeenCalled();
      expect(await h.ask("host/sessionPrompt", { sessionId: handle, text: "x" })).toMatchObject({ ok: false, code: PROXY_ERROR.unknownSession });
    } finally { await h.done(); }
  });

  it("announces a session that ended at once only after the start's response", async () => {
    const fake = fakeSession("broker-id"); fake.end("agent_exited");
    const h = await harness({ sessions: [fake] });
    try {
      const handle = h.handleOf(await h.start(contained()));
      await h.settle();
      expect(h.seen.map((s) => s.kind === "response" ? "response" : s.method)).toEqual(["response", "host/sessionEnded"]);
      expect(updates(h.seen)[0]!.params).toEqual({ sessionId: handle, reason: "agent_exited" });
    } finally { await h.done(); }
  });

  it("ends a session that closes through the plugin, once, with the broker's reason", async () => {
    const fake = fakeSession("broker-id");
    const h = await harness({ sessions: [fake] });
    try {
      const handle = h.handleOf(await h.start(contained()));
      expect(await h.ask("host/sessionPrompt", { sessionId: handle, text: "hi" })).toMatchObject({ ok: true, result: { text: "echo hi" } });
      expect(await h.ask("host/sessionClose", { sessionId: handle })).toMatchObject({ ok: true });
      expect(await h.ask("host/sessionClose", { sessionId: handle })).toMatchObject({ ok: false, code: PROXY_ERROR.unknownSession });
      await h.settle();
      expect(updates(h.seen).map((s) => [s.method, s.params.reason])).toEqual([["host/sessionEnded", "closed"]]);
      expect(fake.session.close).toHaveBeenCalledOnce();
    } finally { await h.done(); }
  });

  it("ends a broker session that cannot say when it ended with closed, once, when the plugin closes it", async () => {
    const fake = fakeSession("broker-id", { events: false, ended: false });
    const h = await harness({ sessions: [fake] });
    try {
      const handle = h.handleOf(await h.start(contained()));
      await h.ask("host/sessionClose", { sessionId: handle });
      await h.settle();
      expect(updates(h.seen).map((s) => [s.method, s.params.reason])).toEqual([["host/sessionEnded", "closed"]]);
    } finally { await h.done(); }
  });

  it("refuses a start whose broker session reuses a live id, and leaves the live session alone", async () => {
    const first = fakeSession("same-id"); const second = fakeSession("same-id");
    const h = await harness({ sessions: [first, second] });
    try {
      const handle = h.handleOf(await h.start({ agent: "claude" }));
      expect(handle).toBe("same-id");
      expect(await h.start({ agent: "claude" })).toMatchObject({ ok: false, code: -32603 });
      await h.settle();
      expect(second.session.close).toHaveBeenCalledOnce();
      expect(first.session.close).not.toHaveBeenCalled();
      expect(await h.ask("host/sessionPrompt", { sessionId: handle, text: "still here" })).toMatchObject({ ok: true, result: { text: "echo still here" } });
      expect(updates(h.seen)).toEqual([]);
      expect(h.logs.some(([, level, message, fields]) => level === "warn" && message === "Refused a session start" && fields?.code === -32603)).toBe(true);
    } finally { await h.done(); }
  });

  it.each([["an empty id", ""], ["an id over 128 characters", "x".repeat(129)]])("refuses a start whose broker session has %s", async (_name, id) => {
    const fake = fakeSession(id);
    const h = await harness({ sessions: [fake] });
    try {
      expect(await h.start({ agent: "claude" })).toMatchObject({ ok: false, code: -32603 });
      expect(fake.session.close).toHaveBeenCalledOnce();
    } finally { await h.done(); }
  });

  it("keeps two sessions' events apart", async () => {
    const one = fakeSession("b1"); const two = fakeSession("b2");
    const h = await harness({ sessions: [one, two] });
    try {
      const a = h.handleOf(await h.start({ agent: "claude" })); const b = h.handleOf(await h.start({ agent: "claude" }));
      two.emit(text("for b")); one.emit(text("for a")); one.end("cancelled");
      await h.settle();
      expect(updates(h.seen).map((s) => [s.params.sessionId, s.method])).toEqual([[b, "host/sessionUpdate"], [a, "host/sessionUpdate"], [a, "host/sessionEnded"]]);
      expect(await h.ask("host/sessionPrompt", { sessionId: b, text: "still here" })).toMatchObject({ ok: true });
    } finally { await h.done(); }
  });

  it.each(["crash", "stop"] as const)("after a %s the plugin_gone session gets no event or end, not even from a later process", async (how) => {
    const fake = fakeSession("broker-id");
    const h = await harness({ sessions: [fake] });
    try {
      const handle = h.handleOf(await h.start(contained()));
      fake.emit(text("before"));
      await h.settle();
      const before = h.seen.length;
      if (how === "crash") {
        await expect(h.plugin.call("_test/crash", {}, caller)).rejects.toThrow("closed");
        await vi.waitFor(() => expect(h.plugin.status).toBe("running"), { timeout: 3_000 });
      } else await h.plugin.stop();
      // The host closed the session when the process went; the agent may still say things afterwards.
      await vi.waitFor(() => expect(fake.session.close).toHaveBeenCalledOnce());
      // The process went, so the session ends with that reason, not as a plain close.
      expect(fake.session.close).toHaveBeenCalledWith("plugin_gone");
      await expect(fake.session.ended).resolves.toEqual({ reason: "plugin_gone" });
      fake.emit(text("after")); fake.end("agent_exited");
      await h.settle();
      expect(h.seen.length).toBe(before);
      expect(fake.unsubscribed).toHaveBeenCalled();
      if (how === "crash") {
        // A process generation of its own: the old handle means nothing to the new one.
        expect(await h.ask("host/sessionPrompt", { sessionId: handle, text: "x" })).toMatchObject({ ok: false, code: PROXY_ERROR.unknownSession });
        expect(fake.session.prompt).not.toHaveBeenCalled();
      }
    } finally { await h.done(); }
  });
});
