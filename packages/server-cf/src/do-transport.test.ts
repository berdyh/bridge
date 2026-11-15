import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeServerConfig, DeviceStore, RelayHandler, RelayTransport } from "@berdyh/bridge-server";
import { revokedVerdictFrame } from "@berdyh/bridge-server";
import { CF_HEARTBEAT_PING, CF_HEARTBEAT_PONG, createDoRelayGateway, createRelayDurableObject } from "./do-transport.js";
const NativeResponse = globalThis.Response;
class Socket {
  readyState = 1; value: unknown; sent: string[] = []; closed: number[] = []; bufferedAmount: number | undefined = 0;
  serializeAttachment(a: unknown) { this.value = structuredClone(a); }
  deserializeAttachment() { return structuredClone(this.value); }
  accepted = false; accept() { this.accepted = true; }
  send(s: string) { this.sent.push(s); }
  close(code: number) { this.closed.push(code); this.readyState = 3; }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(overrides: Partial<DeviceStore> = {}) {
  let clock = Date.parse("2026-10-14T00:00:00.000Z");
  let alarm: number | null = null;
  const sockets: Socket[] = []; const pending: Promise<unknown>[] = [];
  const timestamps = new WeakMap<Socket, Date>();
  const id = (name: string): DurableObjectId => ({ name, toString: () => name, equals: (other) => other.toString() === name });
  const ctx = { id: id("alice"), getWebSockets: () => sockets, acceptWebSocket: (s: Socket) => sockets.push(s), waitUntil: (p: Promise<unknown>) => pending.push(p),
    setWebSocketAutoResponse: vi.fn(), getWebSocketAutoResponseTimestamp: (s: Socket) => timestamps.get(s) ?? null,
    storage: {
      getAlarm: vi.fn(async () => alarm),
      setAlarm: vi.fn(async (deadline: number) => { alarm = deadline; }),
      deleteAlarm: vi.fn(async () => { alarm = null; }),
    },
  };
  const store: DeviceStore = { getDevice: vi.fn().mockResolvedValue(undefined), listDevices: vi.fn().mockResolvedValue([]), upsertDevice: vi.fn().mockResolvedValue("ok"), touchLastSeen: vi.fn().mockResolvedValue(true), revokeDevice: vi.fn(), isRevoked: vi.fn().mockResolvedValue(false), isCredentialRevoked: vi.fn().mockResolvedValue(false), ...overrides };
  const gateway = createDoRelayGateway({ idFromName: id } as unknown as DurableObjectNamespace);
  const config: BridgeServerConfig = { app: { id: "test", name: "Test" }, origin: "https://app.test", auth: { issuer: "https://auth.test", clientId: "id", deviceAuthorizationEndpoint: "https://auth.test/device", tokenEndpoint: "https://auth.test/token" }, adapters: { store, verifier: { verifyBrowser: vi.fn(), verifyRunner: vi.fn() }, relay: gateway }, now: () => new Date(clock) };
  vi.stubGlobal("WebSocketPair", class { 0 = new Socket(); 1 = new Socket(); });
  vi.stubGlobal("WebSocketRequestResponsePair", class { constructor(public request: string, public response: string) {} });
  vi.stubGlobal("Response", class extends NativeResponse { constructor(body?: BodyInit | null, init?: ResponseInit) { super(body as never, init?.status === 101 ? { ...init, status: 200 } : init as never); } });
  const Class = createRelayDurableObject(() => config);
  let obj = new Class(ctx as unknown as DurableObjectState, {});
  const transport = () => (obj as unknown as { transport: RelayTransport }).transport;
  const handler = () => (obj as unknown as { handler: RelayHandler }).handler;
  const request = (role: string, user = "alice", key = "pc") => new Request("https://bridge.internal/accept", { headers: { upgrade: "websocket", "x-bridge-internal-peer": JSON.stringify(role === "runner" ? { role, userId: user, runnerId: key, credentialId: "key" } : { role, userId: user, browserKeyId: key }) } });
  return { ctx, config, store, sockets, transport, handler, request, get obj() { return obj; }, get alarm() { return alarm; },
    async accept(role: string, user?: string, key?: string) { await obj.fetch!(request(role, user, key)); return sockets.at(-1)!; },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
    advance(ms: number) { clock += ms; },
    autoPing(ws: Socket) { timestamps.set(ws, new Date(clock)); ws.send(CF_HEARTBEAT_PONG); },
    evict() { obj = new Class(ctx as unknown as DurableObjectState, {}); },
  };
}
const hello = JSON.stringify({ type: "hello", runnerId: "pc", runnerVersion: "1", protocol: { min: 1, max: 1 } });
const frame = (to: "runner" | "browser") => JSON.stringify({ to, runnerId: "pc", browserKeyId: "pc", kind: "frame", body: "opaque" });
const msg = (obj: DurableObject, ws: Socket, text: string | ArrayBuffer) => obj.webSocketMessage!(ws as unknown as WebSocket, text);
describe("DO transport per-user socket caps", () => {
  it("answers 429 before onOpen at the cap and never evicts a live tab for a refused upgrade", async () => {
    const h = setup(); h.config.maxSocketsPerUser = { browser: 2, runner: 1 };
    const a = await h.accept("browser", "alice", "a"); await h.accept("browser", "alice", "b");
    const onOpen = vi.spyOn(h.handler(), "onOpen");
    const res = await h.obj.fetch!(h.request("browser", "alice", "c"));
    expect(res.status).toBe(429); expect(h.sockets).toHaveLength(2); expect(onOpen).not.toHaveBeenCalled();
    // The same browserKeyId replaces its own socket at the cap.
    const again = await h.obj.fetch!(h.request("browser", "alice", "a"));
    expect(again.status).not.toBe(429); expect(a.closed).toEqual([4409]);
    expect(h.transport().connections("alice", { role: "browser" })).toHaveLength(2);
    await h.accept("runner", "alice", "r1");
    expect((await h.obj.fetch!(h.request("runner", "alice", "r2"))).status).toBe(429);
  });
  it("defaults to 16 browsers and 8 runners and frees slots when sockets close", async () => {
    const h = setup();
    for (let i = 0; i < 8; i++) await h.accept("runner", "alice", `r${i}`);
    expect((await h.obj.fetch!(h.request("runner", "alice", "r8"))).status).toBe(429);
    for (let i = 0; i < 16; i++) await h.accept("browser", "alice", `b${i}`);
    expect((await h.obj.fetch!(h.request("browser", "alice", "b16"))).status).toBe(429);
    h.transport().close(h.transport().connections("alice", { role: "browser" })[0]!.id, 1000, "bye");
    expect((await h.obj.fetch!(h.request("browser", "alice", "b16"))).status).not.toBe(429);
  });
});
describe("DO transport maximum socket age", () => {
  it("closes a live socket with 1012 at the default 12 hours, via the alarm sweep and across eviction", async () => {
    const h = setup(); const ws = await h.accept("browser");
    h.advance(12 * 3_600_000 - 1); h.autoPing(ws); h.evict(); await h.obj.alarm!(); await h.drain();
    expect(ws.closed).toEqual([]);
    h.advance(1); h.autoPing(ws); await h.obj.alarm!(); await h.drain();
    expect(ws.closed).toEqual([1012]);
    expect(h.alarm).toBeNull();
  });
  it("honours the configured age and 0 disables it", async () => {
    const h = setup(); h.config.maxSocketAgeMs = 5_000; const ws = await h.accept("runner");
    h.advance(5_000); h.autoPing(ws); await h.obj.alarm!(); await h.drain(); expect(ws.closed).toEqual([1012]);
    const off = setup(); off.config.maxSocketAgeMs = 0; const idle = await off.accept("browser");
    off.advance(100 * 3_600_000); off.autoPing(idle); await off.obj.alarm!(); await off.drain(); expect(idle.closed).toEqual([]);
  });
});
describe("DO transport lifecycle", () => {
  it.each([
    ["Büro Rechner 🖥", "Büro Rechner 🖥"], ["x".repeat(255), "x".repeat(255)],
    [undefined, undefined], ["", undefined], ["x".repeat(256), undefined],
    ...["\u0000", "\t", "\n", "\u001b", "\u007f", "\u0085", "\u009f", "\u2028", "\u2029"].map((control) => [`bad${control}name`, undefined]),
  ])("bounds hostname %j in the store and replays presence after eviction", async (hostname, expected) => {
    const h = setup(); const current = await h.accept("browser", "alice", "current");
    const runner = await h.accept("runner");
    await msg(h.obj, runner, JSON.stringify({ ...JSON.parse(hello), hostname }));
    const presence = (ws: Socket) => ws.sent.map((s) => JSON.parse(s)).filter((e) => e.kind === "presence").at(-1).body;
    const initial = presence(current);
    h.evict();
    const later = await h.accept("browser", "alice", "later");
    const state = h.transport().connections("alice", { role: "runner" })[0]!.state;
    expect(state.greeted).toBe(true);
    for (const value of [initial, presence(later), state]) {
      if (expected === undefined) expect(value).not.toHaveProperty("hostname");
      else expect(value.hostname).toBe(expected);
    }
    expect(h.store.upsertDevice).toHaveBeenCalledWith(expect.objectContaining({ hostname: expected ?? "unknown" }), "key");
    await h.obj.webSocketClose!(runner as unknown as WebSocket, 1000, "bye", true);
    await h.drain();
    expect(presence(later)).toMatchObject({ online: false });
    expect(presence(later)).not.toHaveProperty("hostname");
  });

  it("keeps the maximum hostname and bounded agents within the attachment budget", async () => {
    const h = setup(); const runner = await h.accept("runner");
    // Four-byte printable characters exercise the byte budget, not just string length.
    const hostname = "🖥".repeat(127) + "x";
    const agents = Array.from({ length: 40 }, () => ({ id: "🖥".repeat(32), available: true, extra: "x".repeat(1000) }));
    await msg(h.obj, runner, JSON.stringify({ ...JSON.parse(hello), hostname, agents }));
    const state = h.transport().connections("alice", { role: "runner" })[0]!.state;
    expect(state.hostname).toBe(hostname);
    expect(state.agents).toEqual(Array.from({ length: 32 }, () => ({ id: "🖥".repeat(32), available: true })));
    expect(new TextEncoder().encode(JSON.stringify(runner.deserializeAttachment())).byteLength).toBeLessThan(16_384);
    h.evict();
    const browser = await h.accept("browser");
    expect(browser.sent.map((s) => JSON.parse(s)).find((e) => e.kind === "presence").body).toMatchObject({ hostname, agents: state.agents });
  });

  it("rebuilds greeted routing and state from attachments after eviction", async () => {
    const h = setup(); const runner = await h.accept("runner"); await msg(h.obj, runner, hello);
    const browser = await h.accept("browser"); h.evict();
    await msg(h.obj, browser, frame("runner")); expect(runner.sent).toContain(frame("runner"));
    expect(h.transport().connections("alice", { role: "runner" })[0]!.state.greeted).toBe(true);
    expect(h.transport().connections("bob")).toEqual([]);
    expect(JSON.stringify(runner.value).length).toBeLessThan(16_384);
  });
  it("replaces a browser with 4409 before new onOpen and ignores its queued frames", async () => {
    const h = setup(); const old = await h.accept("browser");
    const events: string[] = [];
    const close = old.close.bind(old);
    vi.spyOn(old, "close").mockImplementation((code) => { events.push(`close:${code}`); close(code); });
    const onOpen = h.handler().onOpen.bind(h.handler());
    vi.spyOn(h.handler(), "onOpen").mockImplementation((conn) => { events.push("onOpen"); expect(old.closed).toEqual([4409]); return onOpen(conn); });
    await h.accept("browser");
    expect(events).toEqual(["close:4409", "onOpen"]);
    expect(h.transport().connections("alice", { role: "browser" })).toHaveLength(1);
    await msg(h.obj, old, "bad"); await h.drain(); expect(old.sent).toEqual([]);
  });
  it("auto-responds without waking or changing attachments, across eviction", async () => {
    const h = setup(); const ws = await h.accept("runner"); await msg(h.obj, ws, hello);
    expect(h.ctx.setWebSocketAutoResponse).toHaveBeenCalledWith(expect.objectContaining({ request: "bridge:ping", response: "bridge:pong" }));
    const attachment = ws.deserializeAttachment(); const writes = h.ctx.storage.setAlarm.mock.calls.length;
    for (let i = 0; i < 5; i++) { h.advance(20_000); h.autoPing(ws); h.evict(); await h.obj.alarm!(); }
    expect(ws.closed).toEqual([]); expect(ws.sent).not.toContain(CF_HEARTBEAT_PING);
    expect((ws.deserializeAttachment() as { lastInbound: number }).lastInbound).toBe((attachment as { lastInbound: number }).lastInbound);
    expect(h.ctx.storage.setAlarm.mock.calls.length - writes).toBeLessThanOrEqual(5);
    h.advance(59_999); h.evict(); await h.obj.alarm!(); expect(ws.closed).toEqual([]);
    h.advance(1); await h.obj.alarm!(); await h.drain(); expect(ws.closed).toEqual([1001]);
    expect(h.alarm).toBeNull();
  });
  it.each([CF_HEARTBEAT_PING, CF_HEARTBEAT_PONG])("keeps %s out of core and preserves the fixed hello timeout", async (text) => {
    const h = setup(); const ws = await h.accept("runner"); const core = vi.spyOn(h.handler(), "onMessage");
    h.advance(9_000); await msg(h.obj, ws, text); expect(core).not.toHaveBeenCalled();
    expect(ws.sent).toEqual(text === CF_HEARTBEAT_PING ? [CF_HEARTBEAT_PONG] : []);
    h.advance(1_000); h.evict(); await h.obj.alarm!(); await h.drain(); expect(ws.closed).toEqual([1008]);
  });
  it("auto-responded pings cannot postpone hello after eviction", async () => {
    const h = setup(); const ws = await h.accept("runner"); h.advance(9_999); h.autoPing(ws);
    h.advance(1); h.evict(); await h.obj.alarm!(); await h.drain(); expect(ws.closed).toEqual([1008]);
  });
  it("counts unsolicited pongs as liveness without responding or notifying core", async () => {
    const h = setup(); const ws = await h.accept("browser"); const core = vi.spyOn(h.handler(), "onMessage");
    for (let i = 0; i < 4; i++) { h.advance(20_000); await msg(h.obj, ws, CF_HEARTBEAT_PONG); await h.obj.alarm!(); }
    expect(ws.closed).toEqual([]); expect(ws.sent).toEqual([]); expect(core).not.toHaveBeenCalled();
    h.advance(60_000); h.evict(); await h.obj.alarm!(); await h.drain(); expect(ws.closed).toEqual([1001]);
  });
  it.each(["runner", "browser"])("keeps an active %s alive using the latest received frame, across eviction", async (role) => {
    const h = setup(); const runner = await h.accept("runner"); await msg(h.obj, runner, hello);
    const browser = await h.accept("browser"); const ws = role === "runner" ? runner : browser;
    for (let i = 0; i < 4; i++) {
      h.advance(20_000); h.autoPing(ws); // The previous auto-response may be older than ordinary traffic.
      h.advance(1_000); await msg(h.obj, ws, frame(role === "runner" ? "browser" : "runner"));
      h.evict(); await h.obj.alarm!(); expect(ws.closed).toEqual([]);
    }
    expect(ws.sent).not.toContain(CF_HEARTBEAT_PING);
    h.advance(59_999); h.evict(); await h.obj.alarm!(); expect(ws.closed).toEqual([]);
    h.advance(1); await h.obj.alarm!(); await h.drain(); expect(ws.closed).toEqual([1001]);
  });
  it("does not let ordinary pre-hello text postpone the hello timeout", async () => {
    const h = setup(); const ws = await h.accept("runner");
    vi.spyOn(h.handler(), "onMessage").mockResolvedValue(undefined);
    h.advance(9_000); await msg(h.obj, ws, JSON.stringify({ type: "unrecognized" }));
    h.advance(1_000); h.evict(); await h.obj.alarm!(); await h.drain(); expect(ws.closed).toEqual([1008]);
  });
  it("records receipt before a stalled handler and does no alarm reads or writes per relayed frame", async () => {
    const h = setup(); const runner = await h.accept("runner"); await msg(h.obj, runner, hello); const browser = await h.accept("browser");
    const reads = h.ctx.storage.getAlarm.mock.calls.length; const writes = h.ctx.storage.setAlarm.mock.calls.length;
    for (let i = 0; i < 3; i++) { h.advance(5_000); await msg(h.obj, browser, frame("runner")); }
    h.evict(); await msg(h.obj, browser, frame("runner"));
    expect(h.ctx.storage.getAlarm).toHaveBeenCalledTimes(reads); expect(h.ctx.storage.setAlarm).toHaveBeenCalledTimes(writes);
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    vi.spyOn(h.handler(), "onMessage").mockReturnValue(gate);
    h.advance(44_000); const pending = msg(h.obj, browser, frame("runner"));
    await h.obj.alarm!(); expect(browser.closed).toEqual([]); release(); await pending; await h.drain();
  });
  it("uses sparse alarms only while sockets exist and enforces both idle and hello deadlines", async () => {
    const h = setup(); expect(h.alarm).toBeNull();
    await h.accept("browser"); const first = h.alarm!;
    h.advance(1_000); const runner = await h.accept("runner"); expect(h.alarm).toBe(first - 19_000);
    h.advance(10_000); h.evict(); await h.obj.alarm!(); await h.drain(); expect(runner.closed).toEqual([1008]);
    expect(h.alarm).toBe(first + 11_000);
    h.advance(49_000); await h.obj.alarm!(); await h.drain(); expect(h.alarm).toBeNull();
  });
  it("keeps a runner healthy when an alarm lastSeen refresh fails and throttles attempts", async () => {
    const h = setup(); const ws = await h.accept("runner"); await msg(h.obj, ws, hello);
    vi.mocked(h.store.touchLastSeen).mockRejectedValue(new Error("store unavailable"));
    h.advance(30_000); h.autoPing(ws); await h.obj.alarm!(); await h.drain(); expect(ws.closed).toEqual([]);
    const calls = vi.mocked(h.store.touchLastSeen).mock.calls.length;
    h.advance(30_000); h.autoPing(ws); h.evict(); await h.obj.alarm!(); await h.drain();
    expect(h.store.touchLastSeen).toHaveBeenCalledTimes(calls);
  });
  it("does not block relayed frames behind a stalled alarm lastSeen write", async () => {
    const h = setup(); const runner = await h.accept("runner"); await msg(h.obj, runner, hello); const browser = await h.accept("browser");
    let resolve!: (value: boolean) => void;
    vi.mocked(h.store.touchLastSeen).mockReturnValue(new Promise<boolean>((r) => { resolve = r; }));
    try {
      h.advance(30_000); h.autoPing(runner); await h.obj.alarm!();
      await msg(h.obj, runner, frame("browser")); expect(browser.sent).toContain(frame("browser")); expect(runner.closed).toEqual([]);
    } finally { resolve(true); await h.drain(); }
  });
  it("drops queued frames after revocation while a hello is awaiting the store", async () => {
    let resolve!: (s: string) => void; const wait = new Promise<string>((r) => { resolve = r; });
    const h = setup({ upsertDevice: vi.fn().mockReturnValue(wait) });
    const ws = await h.accept("runner"); const first = msg(h.obj, ws, hello);
    await Promise.resolve(); const second = msg(h.obj, ws, "queued-frame");
    await h.transport().disconnect("alice", { credentialId: "key" }, 4403, "revoked");
    resolve("ok"); await first; await second; await h.drain(); expect(ws.sent).toEqual([]); expect(ws.closed).toEqual([4403]);
  });
  it.each([1005, 1006, 1015, 1000, 4409])("acknowledges close %i with a sendable code", async (code) => {
    const h = setup(); const ws = await h.accept("browser");
    await h.obj.webSocketClose!(ws as unknown as WebSocket, code, "closed", true);
    expect(ws.closed).toEqual([[1005, 1006, 1015].includes(code) ? 1000 : code]); expect(h.alarm).toBeNull();
  });
  it("skips encoding and maxQueuedBytes when the runtime has no bufferedAmount", async () => {
    const h = setup(); h.config.maxQueuedBytes = 1; const ws = await h.accept("browser"); ws.bufferedAmount = undefined;
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    expect(h.transport().send((ws.value as { id: string }).id, "payload larger than limit")).toBe("sent");
    expect(encode).not.toHaveBeenCalled(); expect(ws.closed).toEqual([]);
  });
  it("terminates on backpressure, binary frames, attachment overflow and send errors", async () => {
    const h = setup(); let ws = await h.accept("browser"); const key = () => (ws.deserializeAttachment() as { id: string }).id;
    ws.bufferedAmount = 5 * 1024 * 1024; expect(h.transport().send(key(), "data")).toBe("dropped_backpressure"); expect(ws.closed).toEqual([1013]);
    ws = await h.accept("browser"); await msg(h.obj, ws, new ArrayBuffer(1)); expect(ws.closed).toEqual([1003]);
    ws = await h.accept("browser"); expect(() => h.transport().setState(key(), { connectedAt: "x".repeat(16_384) })).toThrow("16 KB");
    ws.send = () => { ws.readyState = 3; throw new Error("buffer full"); }; expect(h.transport().send(key(), "data")).toBe("dropped_backpressure");
    expect((ws.deserializeAttachment() as { discard: boolean }).discard).toBe(true); await h.drain();
  });
  it.each([true, false])("rejects another user's accept/disconnect using its own DO id (name available: %s)", async (nameAvailable) => {
    const h = setup(); if (!nameAvailable) Object.defineProperty(h.ctx.id, "name", { value: undefined });
    const ws = await h.accept("browser"); h.evict();
    expect((await h.obj.fetch!(h.request("browser", "bob"))).status).toBe(403);
    const disconnect = (userId: string) => h.obj.fetch!(new Request("https://bridge.internal/disconnect", { method: "POST", body: JSON.stringify({ userId, filter: {}, code: 4403, reason: "revoked" }) }));
    expect((await disconnect("bob")).status).toBe(403); expect(h.sockets).toHaveLength(1); expect(ws.closed).toEqual([]);
    expect((await disconnect("alice")).status).toBe(200); expect(ws.closed).toEqual([4403]); await h.drain();
  });
  it("routes gateways by authenticated user and strips credentials and forged headers", async () => {
    const fetch = vi.fn().mockResolvedValue(new NativeResponse("1")); const idFromName = vi.fn((u) => u); const get = vi.fn(() => ({ fetch }));
    const gateway = createDoRelayGateway({ idFromName, get } as unknown as DurableObjectNamespace);
    await gateway.accept(new Request("https://app.test", { headers: { authorization: "secret", "x-bridge-internal-peer": "evil" } }), { role: "browser", userId: "alice", browserKeyId: "key" });
    expect(idFromName).toHaveBeenCalledWith("alice"); const forwarded = fetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get("authorization")).toBeNull(); expect(JSON.parse(forwarded.headers.get("x-bridge-internal-peer")!).userId).toBe("alice");
    expect(await gateway.disconnect("bob", {}, 4403, "revoked")).toBe(1); expect(idFromName).toHaveBeenCalledWith("bob");
  });
});
describe("DO gateway revoked verdict", () => {
  const upgrade = (protocols?: string) => new Request("https://app.test/relay/runner?runnerId=old", { headers: { upgrade: "websocket", authorization: "Bearer secret", ...(protocols ? { "sec-websocket-protocol": protocols } : {}) } });
  function gateway() {
    const pairs: Socket[][] = [];
    vi.stubGlobal("WebSocketPair", class { 0 = new Socket(); 1 = new Socket(); constructor() { pairs.push([this[0], this[1]]); } });
    vi.stubGlobal("Response", class extends NativeResponse { constructor(body?: BodyInit | null, init?: ResponseInit) { super(body as never, init?.status === 101 ? { ...init, status: 200 } : init as never); } });
    const get = vi.fn(); const idFromName = vi.fn();
    return { pairs, get, idFromName, gateway: createDoRelayGateway({ idFromName, get } as unknown as DurableObjectNamespace) };
  }
  it("sends the revoked control and closes 4401 on a plain socket, without touching any Durable Object", async () => {
    const g = gateway();
    const res = await g.gateway.acceptVerdict!(upgrade(), { type: "revoked", runnerId: "old" });
    expect(res.status).toBe(200); // 101 in workerd, rewritten by the test's Response stand-in
    const [client, server] = g.pairs[0]!; // the client end reaches the browser; Miniflare asserts it
    expect(server!.accepted).toBe(true); expect(server!.sent).toEqual([revokedVerdictFrame("old")]); expect(server!.closed).toEqual([4401]);
    expect(client!.sent).toEqual([]);
    expect(g.get).not.toHaveBeenCalled(); expect(g.idFromName).not.toHaveBeenCalled();
  });
  it("answers a plain GET with 426 and sends nothing", async () => {
    const g = gateway();
    const res = await g.gateway.acceptVerdict!(new Request("https://app.test/relay/runner?runnerId=old"), { type: "revoked", runnerId: "old" });
    expect(res.status).toBe(426); expect(g.pairs).toEqual([]);
  });
});
