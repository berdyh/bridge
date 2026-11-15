import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainedSessionRefusal, PluginContext } from "./contracts.js";
import { runPlugin } from "./runtime.js";
import { RpcPeer } from "./rpc.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); vi.useRealTimers(); });
async function setupPlugin(setup: (context: PluginContext) => void | Promise<void>, permissions: Record<string, unknown> = {}) {
  const input = new PassThrough(); const output = new PassThrough();
  const host = new RpcPeer(output, input);
  const messages: { method: string; params: unknown }[] = [];
  host.onNotification = (method, params) => { messages.push({ method, params }); };
  const runtime = await runPlugin(setup, { manifest: { id: "test", app: "app", entry: "plugin.js", permissions }, dataDir: "/injected/data", input, output });
  closers.push(async () => { await runtime.close(); host.close(); input.destroy(); output.destroy(); });
  return { host, messages };
}
const caller = { appId: "app", browserKeyId: "browser" };

describe("plugin logger after disconnect", () => {
  it("never throws once the host has disconnected", async () => {
    let log!: PluginContext["log"];
    const input = new PassThrough(); const output = new PassThrough();
    let disconnected!: () => void; const gone = new Promise<void>((resolve) => { disconnected = resolve; });
    const runtime = await runPlugin((c) => { log = c.log; }, { manifest: { id: "test", app: "app", entry: "plugin.js", permissions: {} }, dataDir: "/d", input, output, onDisconnect: disconnected });
    closers.push(async () => { await runtime.close(); input.destroy(); output.destroy(); });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      input.end();
      await gone;
      for (const level of ["debug", "info", "warn", "error"] as const) expect(() => log[level]("after close", { a: 1 })).not.toThrow();
      expect(stderr).toHaveBeenCalled();
      // The stderr pipe closing later (EPIPE, delivered asynchronously) must not become an uncaught error.
      expect(() => process.stderr.emit("error", new Error("write EPIPE"))).not.toThrow();
    } finally { stderr.mockRestore(); }
  });
});

describe("plugin SDK", () => {
  it("propagates each private call token across asynchronous concurrent method handlers", async () => {
    let context!: PluginContext; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void; const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const { host } = await setupPlugin((c) => {
      context = c;
      c.registerMethod("_test/start", async (params, who) => {
        if ((params as { wait: boolean }).wait) { entered(); await gate; }
        const session = await c.startAgentSession({ agent: "claude", onBehalfOf: who });
        await session.close();
        return who.browserKeyId;
      });
    }, { agents: ["claude"] });
    const requests: unknown[] = [];
    host.onRequest = async (method, params) => {
      if (method === "host/startAgentSession") { requests.push(params); return { sessionId: "session" }; }
      return null;
    };
    const first = host.request("plugin/call", { method: "_test/start", params: { wait: true }, caller, callToken: "call-a" });
    await waiting;
    try {
      const other = { ...caller, browserKeyId: "other" };
      expect(await host.request("plugin/call", { method: "_test/start", params: { wait: false }, caller: other, callToken: "call-b" })).toBe("other");
      release(); expect(await first).toBe("browser");
      await context.startAgentSession({ agent: "claude" });
      expect(requests).toEqual([
        { agent: "claude", onBehalfOf: other, callToken: "call-b" },
        { agent: "claude", onBehalfOf: caller, callToken: "call-a" },
        { agent: "claude" },
      ]);
    } finally { release(); await first; }
  });
  it("registers its own methods, replaces handlers, and returns JSON-RPC errors", async () => {
    const { host } = await setupPlugin(({ registerMethod, dataDir, pluginId }) => {
      expect(dataDir).toBe("/injected/data"); expect(pluginId).toBe("test");
      expect(() => registerMethod("_other/echo", () => {})).toThrow("own prefix");
      expect(() => registerMethod("_bridge/localUi", () => {})).toThrow("own prefix");
      registerMethod("_test/echo", () => "old"); registerMethod("_test/echo", (params, who) => ({ params, who }));
      registerMethod("_test/fail", () => { throw new Error("plugin failure"); });
    });
    expect(await host.request("plugin/call", { method: "_test/echo", params: [1, 2], caller })).toEqual({ params: [1, 2], who: caller });
    await expect(host.request("plugin/call", { method: "_test/fail", caller })).rejects.toThrow("plugin failure");
    await expect(host.request("plugin/call", { method: "_test/missing", caller })).rejects.toMatchObject({ code: -32601 });
    await expect(host.request("plugin/call", { method: "_test/echo", caller: { ...caller, appId: "other" } })).rejects.toMatchObject({ code: -32014 });
    await expect(host.request("session/request_permission", {})).rejects.toMatchObject({ code: -32601 });
  });
  it("logs on the protocol channel and reports readiness only after setup completes", async () => {
    const { messages } = await setupPlugin(async ({ log }) => {
      log.debug("debug"); log.info("info", { item: 1 }); log.warn("warn"); log.error("error");
      await Promise.resolve();
    });
    expect(messages.map((m) => m.method)).toEqual(["host/log", "host/log", "host/log", "host/log", "plugin/ready"]);
    expect(messages[1]?.params).toEqual({ level: "info", message: "info", fields: { item: 1 } });
  });
  it("requires local UI permission, listens on loopback and closes its server", async () => {
    await setupPlugin(async ({ localUi }) => { await expect(localUi.listen(() => {})).rejects.toThrow("not declared"); });
    let url = ""; let close: () => Promise<void> = async () => {};
    const { messages } = await setupPlugin(async ({ localUi }) => {
      const ui = await localUi.listen((_request, response) => response.end("local only"));
      url = ui.url; close = ui.close;
    }, { localUi: { port: "auto" } });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(messages[0]).toEqual({ method: "host/localUi", params: { url } });
    expect(await (await fetch(url)).text()).toBe("local only");
    await close(); await expect(fetch(url)).rejects.toThrow();
  });
  it("brokers prompts, cancellation and idempotent close without permission callbacks", async () => {
    let context!: PluginContext;
    const { host } = await setupPlugin((c) => { context = c; }, { agents: ["claude"] });
    const requests: { method: string; params: unknown }[] = [];
    host.onRequest = async (method, params) => {
      requests.push({ method, params });
      if (method === "host/startAgentSession") return { sessionId: "session" };
      if (method === "host/sessionPrompt") return { stopReason: "end_turn", text: "done" };
      return null;
    };
    await expect(context.startAgentSession({ agent: "codex" })).rejects.toThrow("not declared");
    await expect(context.startAgentSession({ agent: "claude", onBehalfOf: { ...caller, appId: "other" } })).rejects.toThrow("another app");
    const session = await context.startAgentSession({ agent: "claude", cwd: "/project", onBehalfOf: caller });
    expect(session.sessionId).toBe("session");
    expect(await session.prompt("hello")).toEqual({ stopReason: "end_turn", text: "done" });
    await session.cancel(); await session.close(); await session.close(); await session.cancel();
    await expect(session.prompt("closed")).rejects.toThrow("closed");
    expect(requests.map((r) => r.method)).toEqual(["host/startAgentSession", "host/sessionPrompt", "host/sessionCancel", "host/sessionClose"]);
    expect(requests[0]?.params).toEqual({ agent: "claude", cwd: "/project", onBehalfOf: caller });
  });
  it("closes local servers when the host disconnects", async () => {
    let url = ""; const disconnected = vi.fn();
    const input = new PassThrough(); const output = new PassThrough();
    const runtime = await runPlugin(async ({ localUi }) => { url = (await localUi.listen((_q, s) => s.end("ok"))).url; }, {
      manifest: { id: "test", app: "app", entry: "plugin.js", permissions: { localUi: { port: "auto" } } }, dataDir: "/injected", input, output, onDisconnect: disconnected,
    });
    input.end(); await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce());
    await expect(fetch(url)).rejects.toThrow(); await runtime.close(); input.destroy(); output.destroy();
  });
  it("waits beyond 30 seconds for agent creation and prompts, and rejects on disconnect", async () => {
    vi.useFakeTimers();
    let context!: PluginContext;
    const { host } = await setupPlugin((c) => { context = c; }, { agents: ["claude"] });
    host.onRequest = async (method) => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return method === "host/startAgentSession" ? { sessionId: "slow-session" } : { stopReason: "end_turn", text: "done" };
    };
    const starting = context.startAgentSession({ agent: "claude" });
    void starting.catch(() => {});
    await vi.advanceTimersByTimeAsync(60_000);
    const session = await starting;
    expect(session.sessionId).toBe("slow-session");
    const prompting = session.prompt("slow turn"); void prompting.catch(() => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await prompting).toEqual({ stopReason: "end_turn", text: "done" });
    const disconnected = expect(session.prompt("interrupted")).rejects.toThrow("closed");
    await closers[0]!(); await disconnected;
  });
  it("can cancel a pending prompt through a separate session request", async () => {
    let context!: PluginContext;
    const { host } = await setupPlugin((c) => { context = c; }, { agents: ["claude"] });
    let finishPrompt!: (result: { stopReason: string; text: string }) => void;
    const cancelled = vi.fn();
    host.onRequest = async (method) => {
      if (method === "host/startAgentSession") return { sessionId: "session" };
      if (method === "host/sessionPrompt") return new Promise((resolve) => { finishPrompt = resolve; });
      if (method === "host/sessionCancel") { cancelled(); finishPrompt({ stopReason: "cancelled", text: "" }); }
      return null;
    };
    const session = await context.startAgentSession({ agent: "claude" });
    const prompting = session.prompt("pending");
    await session.cancel();
    expect(await prompting).toEqual({ stopReason: "cancelled", text: "" });
    expect(cancelled).toHaveBeenCalledOnce(); await session.close();
  });
});

describe("plugin SDK contained sessions", () => {
  const permissions = { agents: ["claude"] };
  async function started(request: Parameters<PluginContext["startAgentSession"]>[0] = { agent: "claude" }) {
    let context!: PluginContext;
    const { host } = await setupPlugin((c) => { context = c; }, permissions);
    const requests: { method: string; params: unknown }[] = [];
    host.onRequest = async (method, params) => { requests.push({ method, params }); return method === "host/startAgentSession" ? { sessionId: "h1" } : null; };
    const session = await context.startAgentSession(request);
    return { host, requests, session };
  }
  /** What the host would send. */
  const update = (host: RpcPeer, sessionId: string, event: unknown) => host.notify("host/sessionUpdate", { sessionId, event });
  const ended = (host: RpcPeer, sessionId: string, reason: unknown) => host.notify("host/sessionEnded", { sessionId, reason });

  it("sends every documented field of a contained request and none that is not", async () => {
    const request = {
      agent: "claude", onBehalfOf: undefined, mcpServers: ["notes"], tools: { allow: ["mcp__notes__append"], builtins: "none" as const },
      secret: "s3cret", model: "sonnet", budget: { wallClockMs: 1000, maxToolCalls: 3 }, headless: true,
      permissionMode: "bypassPermissions", command: "sh", servers: [{ name: "x" }],
    };
    const { requests } = await started(request as never);
    expect(requests[0]?.params).toEqual({
      agent: "claude", mcpServers: ["notes"], tools: { allow: ["mcp__notes__append"], builtins: "none" },
      secret: "s3cret", model: "sonnet", budget: { wallClockMs: 1000, maxToolCalls: 3 }, headless: true,
    });
  });
  it("hands session events to onUpdate in order, until the unsubscribe", async () => {
    const { host, session } = await started();
    const seen: unknown[] = []; const other = vi.fn();
    const stop = session.onUpdate!((event) => { seen.push(event); });
    session.onUpdate!(other)();
    update(host, "h1", { type: "text", text: "a" });
    update(host, "h1", { type: "tool_call", id: "t1", toolName: "mcp__notes__append" });
    update(host, "h1", { type: "usage", totalTokens: 5 });
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    expect(seen).toEqual([{ type: "text", text: "a" }, { type: "tool_call", id: "t1", toolName: "mcp__notes__append" }, { type: "usage", totalTokens: 5 }]);
    stop(); update(host, "h1", { type: "text", text: "late" });
    update(host, "h1", { type: "text", text: "marker" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(3); expect(other).not.toHaveBeenCalled();
  });
  it("a throwing handler does not break the wire or the other handlers", async () => {
    const { host, session } = await started();
    const seen: unknown[] = [];
    session.onUpdate!(() => { throw new Error("handler failure"); });
    session.onUpdate!((event) => { seen.push(event); });
    update(host, "h1", { type: "text", text: "one" }); update(host, "h1", { type: "text", text: "two" });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    ended(host, "h1", "closed");
    expect(await session.ended).toEqual({ reason: "closed" });
  });
  it("resolves ended once, with the host's reason, and treats the session as closed from then on", async () => {
    const { host, requests, session } = await started();
    const seen = vi.fn(); session.onUpdate!(seen);
    ended(host, "h1", "budget"); ended(host, "h1", "breach"); update(host, "h1", { type: "text", text: "after" });
    expect(await session.ended).toEqual({ reason: "budget" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).not.toHaveBeenCalled();
    await expect(session.prompt("x")).rejects.toThrow("closed");
    await session.close(); await session.cancel();
    expect(requests.map((r) => r.method)).toEqual(["host/startAgentSession"]);
  });
  it("ignores an end or update for a session it does not know, a bad reason and malformed params", async () => {
    const { host, session } = await started();
    const settled = vi.fn(); void session.ended!.then(settled);
    ended(host, "other", "closed"); update(host, "other", { type: "text", text: "x" });
    ended(host, "h1", "not-a-reason"); ended(host, "h1", undefined);
    host.notify("host/sessionEnded", null); host.notify("host/sessionUpdate", { sessionId: "h1" }); host.notify("host/sessionUpdate", [1]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).not.toHaveBeenCalled();
    ended(host, "h1", "agent_exited");
    expect(await session.ended).toEqual({ reason: "agent_exited" });
  });
  it("keeps the events of two sessions apart", async () => {
    let context!: PluginContext;
    const { host } = await setupPlugin((c) => { context = c; }, permissions);
    let n = 0; host.onRequest = async () => ({ sessionId: `h${++n}` });
    const one = await context.startAgentSession({ agent: "claude" }); const two = await context.startAgentSession({ agent: "claude" });
    const a: unknown[] = []; const b: unknown[] = [];
    one.onUpdate!((e) => a.push(e)); two.onUpdate!((e) => b.push(e));
    update(host, "h2", { type: "text", text: "for two" }); ended(host, "h1", "closed");
    expect(await one.ended).toEqual({ reason: "closed" });
    expect(b).toEqual([{ type: "text", text: "for two" }]); expect(a).toEqual([]);
    expect(await Promise.race([two.ended, new Promise((resolve) => setTimeout(() => resolve("pending"), 20))])).toBe("pending");
  });
});

describe("plugin SDK refusal of a contained session", () => {
  it("rejects startAgentSession with the host's -32016 error and its data, unchanged", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    let context!: PluginContext;
    const runtime = await runPlugin((c) => { context = c; }, { manifest: { id: "test", app: "app", entry: "plugin.js", permissions: { agents: ["claude"] } }, dataDir: "/injected/data", input, output });
    closers.push(async () => { await runtime.close(); input.destroy(); output.destroy(); });
    const answers = [
      { code: -32016, message: "Contained session unavailable", data: { reason: "adapter_missing", hint: "bridge agent install claude" } },
      { code: -32016, message: "Contained session unavailable" },
    ];
    let pending = "";
    output.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let newline = pending.indexOf("\n"); newline !== -1; newline = pending.indexOf("\n")) {
        const message = JSON.parse(pending.slice(0, newline)) as { id?: number; method?: string };
        pending = pending.slice(newline + 1);
        if (message.method === "host/startAgentSession") input.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: answers.shift() }) + "\n");
      }
    });
    const missing = await context.startAgentSession({ agent: "claude", tools: { builtins: "none" } }).then(() => undefined, (error: unknown) => error as Error & { code: number; data?: ContainedSessionRefusal });
    expect(missing).toMatchObject({ code: -32016, message: "Contained session unavailable", data: { reason: "adapter_missing", hint: "bridge agent install claude" } });
    const refusal: ContainedSessionRefusal = missing!.data!;
    expect(refusal.reason).toBe("adapter_missing");
    const other = await context.startAgentSession({ agent: "claude", tools: { builtins: "none" } }).then(() => undefined, (error: unknown) => error as Error);
    expect(other).toMatchObject({ code: -32016, message: "Contained session unavailable" });
    expect(other).not.toHaveProperty("data");
  });
});

describe("plugin SDK session events whatever the chunk boundaries", () => {
  /** A plugin whose host answers `host/startAgentSession` with the bytes `wire(requestId)` names, written as the chunks the strategy cuts them into. */
  async function startedOnWire(wire: (id: number) => string, cut: (bytes: Buffer) => Buffer[], pause = false) {
    const input = new PassThrough(); const output = new PassThrough();
    let context!: PluginContext;
    const runtime = await runPlugin((c) => { context = c; }, { manifest: { id: "test", app: "app", entry: "plugin.js", permissions: { agents: ["claude"] } }, dataDir: "/injected/data", input, output });
    closers.push(async () => { await runtime.close(); input.destroy(); output.destroy(); });
    let pending = "";
    output.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let newline = pending.indexOf("\n"); newline !== -1; newline = pending.indexOf("\n")) {
        const message = JSON.parse(pending.slice(0, newline)) as { id?: number; method?: string };
        pending = pending.slice(newline + 1);
        if (message.method !== "host/startAgentSession") continue;
        void (async () => { for (const part of cut(Buffer.from(wire(message.id!)))) { input.write(part); if (pause) await new Promise((resolve) => setImmediate(resolve)); } })();
      }
    });
    return await context.startAgentSession({ agent: "claude" });
  }
  const frame = (message: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n";
  const events = [{ type: "text", text: "a" }, { type: "tool_call", id: "t1", toolName: "mcp__notes__append" }, { type: "usage", totalTokens: 5 }];
  /** The start's response, then every event, then the end: as the host puts them on the wire. */
  const whole = (id: number, sessionId = "h1") => frame({ id, result: { sessionId } }) +
    events.map((event) => frame({ method: "host/sessionUpdate", params: { sessionId, event } })).join("") +
    frame({ method: "host/sessionEnded", params: { sessionId, reason: "budget" } });
  const cuts: Array<[string, (bytes: Buffer) => Buffer[]]> = [
    ["one chunk", (bytes) => [bytes]],
    ["one chunk per line", (bytes) => bytes.toString("utf8").split(/(?<=\n)/).map((line) => Buffer.from(line))],
    ["one byte at a time", (bytes) => [...bytes].map((byte) => Buffer.from([byte]))],
    ...[1, 7, 40, 90, 150].map((at): [string, (bytes: Buffer) => Buffer[]] => [`cut at byte ${at}`, (bytes) => [bytes.subarray(0, at), bytes.subarray(at)]]),
  ];
  describe.each([false, true])("with the chunks written back to back (paused: %s)", (pause) => {
    it.each(cuts)("delivers every event once, in order, and the end, when the stream is cut as %s", async (_name, cut) => {
      const session = await startedOnWire((id) => whole(id), cut, pause);
      const seen: unknown[] = [];
      session.onUpdate!((event) => { seen.push(event); });
      expect(await session.ended).toEqual({ reason: "budget" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(seen).toEqual(events);
    });
  });
  it("delivers the end that rides in the same chunk as the start response", async () => {
    const session = await startedOnWire((id) => frame({ id, result: { sessionId: "h1" } }) + frame({ method: "host/sessionEnded", params: { sessionId: "h1", reason: "agent_exited" } }), (bytes) => [bytes]);
    expect(await session.ended).toEqual({ reason: "agent_exited" });
    await expect(session.prompt("x")).rejects.toThrow("closed");
  });
  describe.each([1024, 1025, 5_000])("a start response, %i updates and the end in one chunk (the event limit is 1024)", (count) => {
    const flood = (id: number) => frame({ id, result: { sessionId: "h1" } }) +
      Array.from({ length: count }, (_, n) => frame({ method: "host/sessionUpdate", params: { sessionId: "h1", event: { type: "text", text: String(n) } } })).join("") +
      frame({ method: "host/sessionEnded", params: { sessionId: "h1", reason: "budget" } });
    it("replays the events the limit keeps, in order, and delivers the end once", async () => {
      const session = await startedOnWire(flood, (bytes) => [bytes]);
      let ends = 0;
      void session.ended!.then(() => { ends++; });
      expect(await session.ended).toEqual({ reason: "budget" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ends).toBe(1);
      await expect(session.prompt("x")).rejects.toThrow("closed");
      const seen: Array<{ text?: string }> = [];
      session.onUpdate!((event) => { seen.push(event as { text?: string }); });
      expect(seen).toHaveLength(Math.min(count, 1024));
      expect(seen.map((event) => Number(event.text))).toEqual(seen.map((_, n) => n));
    });
  });
  it("gives the events produced before the first subscription to the first subscriber only, once", async () => {
    const session = await startedOnWire((id) => whole(id), (bytes) => [bytes]);
    await session.ended;
    const first: unknown[] = []; const second: unknown[] = [];
    session.onUpdate!((event) => { first.push(event); }); session.onUpdate!((event) => { second.push(event); });
    expect(first).toEqual(events); expect(second).toEqual([]);
  });
  it("keeps the events of two sessions started together apart, each delivered to its own handle", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    let context!: PluginContext;
    const runtime = await runPlugin((c) => { context = c; }, { manifest: { id: "test", app: "app", entry: "plugin.js", permissions: { agents: ["claude"] } }, dataDir: "/injected/data", input, output });
    closers.push(async () => { await runtime.close(); input.destroy(); output.destroy(); });
    const ids: number[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { id: number; method: string };
        if (message.method === "host/startAgentSession") ids.push(message.id);
      }
      if (ids.length === 2) {
        // Both responses, and an update for each, arrive in one chunk.
        input.write(frame({ id: ids[1], result: { sessionId: "h2" } }) + frame({ method: "host/sessionUpdate", params: { sessionId: "h2", event: events[1] } }) +
          frame({ id: ids[0], result: { sessionId: "h1" } }) + frame({ method: "host/sessionUpdate", params: { sessionId: "h1", event: events[0] } }) +
          frame({ method: "host/sessionEnded", params: { sessionId: "h2", reason: "closed" } }));
      }
    });
    const [one, two] = await Promise.all([context.startAgentSession({ agent: "claude" }), context.startAgentSession({ agent: "claude" })]);
    expect(one.sessionId).toBe("h1"); expect(two.sessionId).toBe("h2");
    const a: unknown[] = []; const b: unknown[] = [];
    one.onUpdate!((event) => { a.push(event); }); two.onUpdate!((event) => { b.push(event); });
    expect(a).toEqual([events[0]]); expect(b).toEqual([events[1]]);
    expect(await two.ended).toEqual({ reason: "closed" });
  });
  it("drops what no start is waiting for, and holds only a bounded number of early events", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    let context!: PluginContext;
    const runtime = await runPlugin((c) => { context = c; }, { manifest: { id: "test", app: "app", entry: "plugin.js", permissions: { agents: ["claude"] } }, dataDir: "/injected/data", input, output });
    closers.push(async () => { await runtime.close(); input.destroy(); output.destroy(); });
    // Before any start is in flight, an event for a handle nobody knows is dropped, not kept for a later start.
    input.write(frame({ method: "host/sessionUpdate", params: { sessionId: "h1", event: events[0] } }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    output.on("data", (chunk: Buffer) => {
      const asked = chunk.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id: number; method: string }).find((message) => message.method === "host/startAgentSession");
      if (!asked) return;
      const id = asked.id;
      const flood = Array.from({ length: 5_000 }, (_, n) => frame({ method: "host/sessionUpdate", params: { sessionId: "h1", event: { type: "text", text: String(n) } } })).join("");
      input.write(frame({ method: "host/sessionUpdate", params: { sessionId: "h9", event: events[2] } }) + flood + frame({ id, result: { sessionId: "h1" } }));
    });
    // The response comes after the flood: the events were seen while the start was in flight.
    const session = await context.startAgentSession({ agent: "claude" });
    const seen: Array<{ text?: string }> = [];
    session.onUpdate!((event) => { seen.push(event as { text?: string }); });
    expect(seen.length).toBeGreaterThan(0); expect(seen.length).toBeLessThan(5_000);
    expect(seen[0]!.text).toBe("0"); // the oldest are kept, in order
    expect(seen.map((event) => Number(event.text))).toEqual(seen.map((_, n) => n));
  });
});
