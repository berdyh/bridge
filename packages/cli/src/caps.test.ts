import type { JsonRpcMessage } from "@berdyh/bridge-protocol";
import { PROXY_ERROR, type AgentAdapter, type AgentProcess, type BrowserChannel } from "@berdyh/bridge-runner";
import { describe, expect, it } from "vitest";

import { createSessionLimiter } from "./caps.js";

function memoryChannel(id: string) {
  const handlers = new Set<(m: JsonRpcMessage) => void>();
  const closers = new Set<(r?: string) => void>();
  const sent: JsonRpcMessage[] = [];
  let closed = false;
  const channel: BrowserChannel = {
    channelId: id, appId: "app", browserKeyId: id,
    get closed() { return closed; },
    send: (m) => void sent.push(m),
    onMessage: (h) => (handlers.add(h), () => void handlers.delete(h)),
    onClose: (h) => (closers.add(h), () => void closers.delete(h)),
    close(reason) { closed = true; for (const h of [...closers]) h(reason); },
  };
  return { channel, sent, receive: (m: JsonRpcMessage) => handlers.forEach((h) => h(m)) };
}

/** An adapter whose agents live until `exit()` is called on them. */
function fakeAdapter() {
  const procs: { exit(): void }[] = [];
  const adapter: AgentAdapter = {
    id: "fake",
    availability: async () => ({ id: "fake", available: true }),
    async spawn() {
      let exit!: () => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { exit = () => r({ code: 0, signal: null }); });
      procs.push({ exit });
      return { stream: undefined as never, exited, kill: async () => exit() } satisfies AgentProcess;
    },
  };
  return { adapter, procs };
}

const sessionNew = (id: number): JsonRpcMessage => ({ jsonrpc: "2.0", id, method: "session/new", params: {} });
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Stands in for the proxy: a session/new spawns an agent, then answers. */
function serve(channel: BrowserChannel, adapter: AgentAdapter, outcome: "ok" | "fail" = "ok") {
  channel.onMessage((m) => {
    void (async () => {
      if (outcome === "fail") {
        channel.send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "agent failed" } } as JsonRpcMessage);
        return;
      }
      await adapter.spawn({ cwd: "/tmp" });
      channel.send({ jsonrpc: "2.0", id: m.id, result: { sessionId: `s${String(m.id)}` } } as JsonRpcMessage);
    })();
  });
}

describe("session limiter", () => {
  it("keeps the adapter's containment profile, or its absence", () => {
    const limiter = createSessionLimiter({ perChannel: 5, perApp: 2 });
    const { adapter } = fakeAdapter();
    const profile = { id: "p" } as never;
    const contained: AgentAdapter = { ...adapter, containment: () => profile };
    const [withProfile, without] = limiter.wrapAdapters([contained, adapter]);
    expect(withProfile!.containment?.()).toBe(profile);
    expect(without!.containment).toBeUndefined();
  });

  it("keeps the reason a contained session is refused, or its absence", () => {
    const limiter = createSessionLimiter({ perChannel: 5, perApp: 2 });
    const { adapter } = fakeAdapter();
    const missing: AgentAdapter = { ...adapter, containmentRefusalReason: () => "adapter_missing" };
    const [withReason, without] = limiter.wrapAdapters([missing, adapter]);
    expect(withReason!.containmentRefusalReason?.()).toBe("adapter_missing");
    expect(without!.containmentRefusalReason).toBeUndefined();
  });

  it("charges a plugin-brokered spawn (no browser request in flight) to the app cap", async () => {
    const limiter = createSessionLimiter({ perChannel: 5, perApp: 2 });
    const { adapter, procs } = fakeAdapter();
    const [wrapped] = limiter.wrapAdapters([adapter]);
    await wrapped!.spawn({ cwd: "/tmp" });
    await wrapped!.spawn({ cwd: "/tmp" });
    expect(limiter.usage().app).toBe(2);
    await expect(wrapped!.spawn({ cwd: "/tmp" })).rejects.toThrow(/session limit/);
    expect(procs).toHaveLength(2);
    // A browser session/new is refused too while brokered sessions fill the app.
    const a = memoryChannel("a");
    const channel = limiter.wrapChannel(a.channel);
    serve(channel, wrapped!);
    a.receive(sessionNew(1));
    await tick();
    expect(a.sent.find((m) => m.id === 1)).toMatchObject({ error: { code: PROXY_ERROR.sessionNotAllowed } });
    procs[0]!.exit();
    await tick();
    expect(limiter.usage().app).toBe(1);
  });

  it("refuses session/new over the per-channel cap without reaching the proxy, and frees a slot when an agent exits", async () => {
    const limiter = createSessionLimiter({ perChannel: 2, perApp: 10 });
    const { adapter, procs } = fakeAdapter();
    const [wrapped] = limiter.wrapAdapters([adapter]);
    const a = memoryChannel("a");
    const channel = limiter.wrapChannel(a.channel);
    serve(channel, wrapped!);

    a.receive(sessionNew(1));
    a.receive(sessionNew(2));
    a.receive(sessionNew(3));
    await tick();
    expect(procs).toHaveLength(2);
    expect(a.sent.find((m) => m.id === 3)).toMatchObject({ error: { code: PROXY_ERROR.sessionNotAllowed } });
    expect(a.sent.filter((m) => "result" in m)).toHaveLength(2);

    procs[0]!.exit();
    await tick();
    a.receive(sessionNew(4));
    await tick();
    expect(procs).toHaveLength(3);
    expect(a.sent.find((m) => m.id === 4)).toHaveProperty("result");
    expect(limiter.usage().byChannel).toEqual({ a: 2 });
  });

  it("caps the app as a whole across channels, counting each browser separately too", async () => {
    const limiter = createSessionLimiter({ perChannel: 2, perApp: 3 });
    const { adapter, procs } = fakeAdapter();
    const [wrapped] = limiter.wrapAdapters([adapter]);
    const a = memoryChannel("a");
    const b = memoryChannel("b");
    serve(limiter.wrapChannel(a.channel), wrapped!);
    serve(limiter.wrapChannel(b.channel), wrapped!);
    a.receive(sessionNew(1));
    a.receive(sessionNew(2));
    b.receive(sessionNew(1));
    b.receive(sessionNew(2));
    await tick();
    expect(procs).toHaveLength(3);
    expect(b.sent.find((m) => m.id === 2)).toMatchObject({ error: { code: PROXY_ERROR.sessionNotAllowed } });
  });

  it("a failed start releases its slot", async () => {
    const limiter = createSessionLimiter({ perChannel: 1, perApp: 1 });
    const { adapter } = fakeAdapter();
    limiter.wrapAdapters([adapter]);
    const a = memoryChannel("a");
    serve(limiter.wrapChannel(a.channel), adapter, "fail");
    for (let i = 1; i <= 3; i++) {
      a.receive(sessionNew(i));
      await tick();
    }
    expect(a.sent.map((m) => (m.error as { code: number }).code)).toEqual([-32603, -32603, -32603]);
    expect(limiter.usage().app).toBe(0);
  });

  it("charges a spawn that no browser request is waiting for (a plugin's session) to the app, not to a channel", async () => {
    const limiter = createSessionLimiter({ perChannel: 1, perApp: 2 });
    const { adapter, procs } = fakeAdapter();
    const [wrapped] = limiter.wrapAdapters([adapter]);
    const a = memoryChannel("a");
    serve(limiter.wrapChannel(a.channel), wrapped!);
    await wrapped!.spawn({ cwd: "/tmp" });
    expect(procs).toHaveLength(1);
    expect(limiter.usage()).toEqual({ app: 1, byChannel: { a: 0 } });
    a.receive(sessionNew(1));
    await tick();
    expect(a.sent.find((m) => m.id === 1)).toHaveProperty("result");
  });

  it("a malformed message reusing a pending session/new id is answered locally and keeps the reservation", async () => {
    const limiter = createSessionLimiter({ perChannel: 1, perApp: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { adapter, procs } = fakeAdapter();
    const slow: AgentAdapter = { ...adapter, spawn: async (o) => { await gate; return adapter.spawn(o); } };
    const [wrapped] = limiter.wrapAdapters([slow]);
    const a = memoryChannel("a");
    const channel = limiter.wrapChannel(a.channel);
    const forwarded: JsonRpcMessage[] = [];
    // The real proxy answers an id with no method and no result/error with -32600 echoing that id.
    channel.onMessage((m) => {
      forwarded.push(m);
      if (m.method === undefined && m.id !== undefined && !("result" in m) && !("error" in m)) {
        channel.send({ jsonrpc: "2.0", id: m.id, error: { code: -32600, message: "Invalid request" } } as JsonRpcMessage);
        return;
      }
      if (m.method === "session/new") {
        void (async () => {
          await wrapped!.spawn({ cwd: "/tmp" });
          channel.send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s" } } as JsonRpcMessage);
        })();
      }
    });

    a.receive(sessionNew(1));
    a.receive({ jsonrpc: "2.0", id: 1 } as JsonRpcMessage);
    a.receive({ jsonrpc: "2.0", id: null, method: "session/new" } as unknown as JsonRpcMessage);
    a.receive({ jsonrpc: "2.0", id: { x: 1 }, method: "x" } as unknown as JsonRpcMessage);
    a.receive({ jsonrpc: "2.0", id: 1, method: 5 } as unknown as JsonRpcMessage);
    expect(forwarded.map((m) => m.method)).toEqual(["session/new"]);
    expect(a.sent).toHaveLength(4);
    for (const m of a.sent) expect(m).toMatchObject({ id: null, error: { code: -32600 } });
    expect(limiter.usage().app).toBe(1);

    release();
    await tick();
    await tick();
    expect(procs).toHaveLength(1);
    expect(limiter.usage()).toEqual({ app: 1, byChannel: { a: 1 } });
    // The cap holds: the next session/new is refused.
    a.receive(sessionNew(2));
    expect(a.sent.at(-1)).toMatchObject({ id: 2, error: { code: PROXY_ERROR.sessionNotAllowed } });
  });

  it("repeating the malformed id never lets live sessions exceed the cap", async () => {
    const limiter = createSessionLimiter({ perChannel: 1, perApp: 1 });
    const { adapter, procs } = fakeAdapter();
    const [wrapped] = limiter.wrapAdapters([adapter]);
    const a = memoryChannel("a");
    const channel = limiter.wrapChannel(a.channel);
    channel.onMessage((m) => {
      if (m.method === undefined && m.id !== undefined && !("result" in m) && !("error" in m)) {
        channel.send({ jsonrpc: "2.0", id: m.id, error: { code: -32600, message: "Invalid request" } } as JsonRpcMessage);
      } else if (m.method === "session/new") {
        void (async () => {
          await tick();
          await wrapped!.spawn({ cwd: "/tmp" });
          channel.send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s" } } as JsonRpcMessage);
        })();
      }
    });
    for (let i = 1; i <= 5; i++) {
      a.receive(sessionNew(i));
      a.receive({ jsonrpc: "2.0", id: i } as JsonRpcMessage);
    }
    await tick();
    await tick();
    expect(procs).toHaveLength(1);
    expect(limiter.usage().app).toBe(1);
  });

  it("closing a channel releases its pending starts", async () => {
    const limiter = createSessionLimiter({ perChannel: 1, perApp: 1 });
    const a = memoryChannel("a");
    const channel = limiter.wrapChannel(a.channel);
    channel.onMessage(() => {});
    a.receive(sessionNew(1));
    expect(limiter.usage().app).toBe(1);
    a.channel.close("gone");
    expect(limiter.usage().app).toBe(0);
  });

  it("refuses a session/new that reuses an in-flight request id, so same-id floods stay within the cap", async () => {
    const limiter = createSessionLimiter({ perChannel: 2, perApp: 3 });
    const { adapter, procs } = fakeAdapter();
    const [wrapped] = limiter.wrapAdapters([adapter]);
    const { channel, sent, receive } = memoryChannel("c1");
    serve(limiter.wrapChannel(channel), wrapped!);
    for (let i = 0; i < 20; i++) receive(sessionNew(7));
    await tick();
    await tick();
    expect(procs.length).toBeLessThanOrEqual(2);
    expect(limiter.usage().app).toBe(procs.length);
    expect(sent.filter((m) => "error" in m).length).toBe(19);
  });

  it("an unrelated response with a pending session/new's id does not free its reservation", async () => {
    const limiter = createSessionLimiter({ perChannel: 1, perApp: 1 });
    const { adapter, procs } = fakeAdapter();
    const [wrapped] = limiter.wrapAdapters([adapter]);
    const { channel, receive } = memoryChannel("c1");
    const wc = limiter.wrapChannel(channel);
    // A proxy that spawns on session/new but never answers it yet.
    wc.onMessage((m) => { if (m.method === "session/new") void wrapped!.spawn({ cwd: "/tmp" }); });
    receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} } as JsonRpcMessage);
    receive(sessionNew(2));
    // A reused id on another method is refused, and a response for id 1 frees only id 1.
    wc.send({ jsonrpc: "2.0", id: 1, result: {} } as JsonRpcMessage);
    for (let i = 0; i < 5; i++) receive({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} } as JsonRpcMessage);
    wc.send({ jsonrpc: "2.0", id: 9, result: {} } as JsonRpcMessage);
    await tick();
    receive(sessionNew(3));
    await tick();
    expect(procs.length).toBe(1);
    expect(limiter.usage().app).toBe(1);
  });

  it("answers a malformed response -32600 with a null id, never forwards it and keeps the reservation", async () => {
    const limiter = createSessionLimiter({ perChannel: 1, perApp: 1 });
    const { channel, sent, receive } = memoryChannel("c1");
    const wc = limiter.wrapChannel(channel);
    const seen: JsonRpcMessage[] = [];
    wc.onMessage((m) => void seen.push(m));
    receive(sessionNew(1));
    const bad: unknown[] = [
      { jsonrpc: "2.0", id: 1, result: {}, error: { code: -1, message: "x" } },
      { jsonrpc: "2.0", id: 1, error: null },
      { jsonrpc: "2.0", id: 1, error: { code: 1.5, message: "x" } },
      { jsonrpc: "2.0", id: 1, error: { code: -1 } },
      { jsonrpc: "2.0", id: 1, error: "boom" },
    ];
    for (const m of bad) receive(m as JsonRpcMessage);
    expect(seen).toHaveLength(1);
    const replies = sent.filter((m) => m.error);
    expect(replies).toHaveLength(bad.length);
    for (const r of replies) expect(r).toMatchObject({ id: null, error: { code: -32600 } });
    expect(limiter.usage().app).toBe(1);
    // A well-formed response is still forwarded and releases.
    receive({ jsonrpc: "2.0", id: 2, result: {} } as JsonRpcMessage);
    receive({ jsonrpc: "2.0", id: 3, error: { code: -1, message: "x" } } as JsonRpcMessage);
    expect(seen).toHaveLength(3);
  });

  it("charges each concurrent start to its own request, so a slow first start cannot let a third agent through a cap of 2", async () => {
    const limiter = createSessionLimiter({ perChannel: 2, perApp: 2 });
    const { adapter, procs } = fakeAdapter();
    const [wrapped] = limiter.wrapAdapters([adapter]);
    const { channel, sent, receive } = memoryChannel("c1");
    const wc = limiter.wrapChannel(channel);
    const gates = new Map<number, () => void>();
    wc.onMessage((m) => {
      if (m.method !== "session/new") return;
      const id = m.id as number;
      void (async () => {
        await new Promise<void>((r) => gates.set(id, r));
        await wrapped!.spawn({ cwd: "/tmp" });
        wc.send({ jsonrpc: "2.0", id, result: { sessionId: `s${id}` } } as JsonRpcMessage);
      })();
    });
    receive(sessionNew(1));
    receive(sessionNew(2));
    gates.get(2)!(); // the second request spawns first
    await tick();
    await tick();
    expect(limiter.usage().app).toBe(2);
    receive(sessionNew(3)); // both slots still held: refused
    await tick();
    expect(sent.some((m) => m.id === 3 && "error" in m)).toBe(true);
    gates.get(1)!();
    await tick();
    await tick();
    expect(procs.length).toBe(2);
    expect(limiter.usage().app).toBe(2);
    procs[0]!.exit();
    await tick();
    expect(limiter.usage().app).toBe(1);
    receive(sessionNew(4));
    await tick();
    expect(sent.some((m) => m.id === 4 && "error" in m)).toBe(false);
  });
});
