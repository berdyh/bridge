import { createPlainLayer, type ChannelLayer, type PakeMessage, type PresenceBody, type SequencedFrame } from "@berdyh/bridge-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectBridge } from "./client.js";
import type { ClientE2eeContext, Transport, TransportState } from "./contracts.js";
import { enroll, wrapClientLayer } from "./e2ee/index.js";
import { events } from "./events.js";
import { createTransport } from "./transport.js";

vi.mock("./transport.js", () => ({ createTransport: vi.fn() }));
vi.mock("./e2ee/index.js", () => ({ enroll: vi.fn(), wrapClientLayer: vi.fn((layer: ChannelLayer) => layer) }));

const discovery = {
  app: { id: "app", name: "App" }, origin: "https://app.example",
  auth: { issuer: "https://auth.example", clientId: "public", deviceAuthorizationEndpoint: "https://auth.example/device", tokenEndpoint: "https://auth.example/token" },
  relayUrl: "wss://app.example/relay", protocol: { min: 1, max: 1 },
};
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(wrapClientLayer).mockImplementation((layer) => layer); });

function fixture() {
  const data = new Map<string, unknown>();
  const keyStore = {
    load: vi.fn(async (name: string) => data.get(name)),
    save: vi.fn(async (name: string, value: unknown) => { data.set(name, value); }),
    delete: vi.fn(async (name: string) => { data.delete(name); }),
  };
  const pake = events<{ runnerId: string; message: PakeMessage }>();
  const presence = events<PresenceBody>();
  const states = events<TransportState>();
  const frames = events<SequencedFrame>();
  let identity = "before";
  const transport: Transport = {
    state: "open", get browserKeyId() { return identity; }, connect: vi.fn(async () => {}), close: vi.fn(),
    rebind: vi.fn(async (id) => { identity = id; }), beginSession: vi.fn(), bindSession: vi.fn(),
    sendFrame: vi.fn(), sendPake: vi.fn(),
    onFrame: (handler) => frames.on((frame) => handler("r1", frame)), onPake: (handler) => pake.on(({ runnerId, message }) => handler(runnerId, message)),
    onControl: () => () => {}, onPresence: presence.on, onState: states.on,
  };
  vi.mocked(createTransport).mockReturnValue(transport);
  const options = {
    discoveryUrl: "https://app.example/.well-known/bridge.json", keyStore,
    getSessionToken: async () => "token", fetch: vi.fn(async () => new Response(JSON.stringify(discovery))) as unknown as typeof fetch,
  };
  const connect = async ({ settlePresence = true } = {}) => {
    const bridge = await connectBridge(options);
    cleanups.push(() => bridge.close());
    if (settlePresence) await bridge.status();
    return bridge;
  };
  return { transport, data, options, keyStore, pake: pake.emit, presence: presence.emit, states: states.emit, frame: frames.emit, connect };
}

describe("BridgeClient E2EE delegation", () => {
  it("always wraps the ACP layer and scopes every key store operation to the app", async () => {
    const f = fixture();
    const encrypted = { ...createPlainLayer({ kid: "encrypted" }), kind: "e2ee" as const, close: vi.fn() };
    vi.mocked(wrapClientLayer).mockReturnValue(encrypted);
    const bridge = await f.connect();
    const channel = await bridge.channel("r1");
    await Promise.resolve();
    expect(wrapClientLayer).toHaveBeenCalledOnce();
    expect(f.transport.bindSession).toHaveBeenCalledWith("r1", "encrypted");
    const ctx = vi.mocked(wrapClientLayer).mock.calls[0]![1];
    await ctx.keyStore.save("secret", { opaque: true });
    expect(f.data.get("https://app.example:app:secret")).toEqual({ opaque: true });
    expect(await ctx.keyStore.load("secret")).toEqual({ opaque: true });
    await ctx.keyStore.delete("secret");
    expect(await ctx.keyStore.load("secret")).toBeUndefined();
    channel.close();
    expect(encrypted.close).toHaveBeenCalledOnce();
  });

  it("hands every client over one store the same scoped store, so enroll() serializes on a stable identity", async () => {
    const f = fixture();
    const first = await f.connect();
    const second = await f.connect();
    await first.channel("r1");
    await second.channel("r1");
    await Promise.resolve();
    const calls = vi.mocked(wrapClientLayer).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![1].keyStore).toBe(calls[1]![1].keyStore);
  });

  it("provides runner-scoped handshake I/O that excludes session closes", async () => {
    const f = fixture();
    const bridge = await f.connect();
    await bridge.channel("r1");
    const ctx = vi.mocked(wrapClientLayer).mock.calls[0]![1];
    const io = ctx.handshakeFor("r1");
    const handler = vi.fn();
    const off = io.onMessage(handler);
    const message: PakeMessage = { t: "session/accept", v: 1, sid: "pending", eph: "public" };
    f.pake({ runnerId: "r2", message });
    f.pake({ runnerId: "r1", message: { t: "session/close", v: 1, sid: "other" } });
    f.pake({ runnerId: "r1", message });
    expect(handler).toHaveBeenCalledExactlyOnceWith(message);
    io.send(message);
    expect(f.transport.sendPake).toHaveBeenLastCalledWith("r1", message);
    off();
    f.pake({ runnerId: "r1", message });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("delegates enrollment, closes the old channel, rebinds, and persists enrolled identity", async () => {
    const f = fixture();
    const bridge = await f.connect();
    const channel = await bridge.channel("r1");
    let ctx!: ClientE2eeContext;
    vi.mocked(enroll).mockImplementation(async (code, context) => {
      expect(code).toBe("BCDFGHJK");
      expect(channel.closed).toBe(true);
      ctx = context;
      expect(context.browserKeyId).toBe("before");
      await context.rebind("abcdefghijklmnopqrstuv");
      expect(context.browserKeyId).toBe("abcdefghijklmnopqrstuv");
      return { runnerId: "r1", browserKeyId: "abcdefghijklmnopqrstuv", enrolledAt: "2026-10-14" };
    });
    const result = await bridge.enroll("BCDFGHJK", "r1");
    expect(result.browserKeyId).toBe("abcdefghijklmnopqrstuv");
    expect(f.data.get("https://app.example:app:__bridge/browserKeyId")).toBe(result.browserKeyId);
    expect(ctx.runnerId).toBe("r1");
    expect(f.transport.rebind).toHaveBeenCalledExactlyOnceWith(result.browserKeyId);
  });

  it("blocks concurrent enrollment and channel opens until enrollment completes", async () => {
    const f = fixture();
    const bridge = await f.connect();
    let finish!: () => void;
    vi.mocked(enroll).mockImplementation(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { runnerId: "r1", browserKeyId: "abcdefghijklmnopqrstuv", enrolledAt: "now" };
    });
    const pending = bridge.enroll("BCDFGHJK", "r1");
    await expect(bridge.channel("r1")).rejects.toThrow("enrollment");
    await expect(bridge.enroll("BCDFGHJK", "r1")).rejects.toThrow("enrollment");
    finish();
    await pending;
    expect((await bridge.channel("r1")).closed).toBe(false);
  });

  it("closes all runner channels before enrollment rebinds the app's socket identity", async () => {
    const f = fixture();
    const bridge = await f.connect();
    const first = await bridge.channel("r1");
    const second = await bridge.channel("r2");
    expect(first.closed).toBe(false);
    vi.mocked(enroll).mockImplementation(async (_code, ctx) => {
      expect(first.closed).toBe(true);
      expect(second.closed).toBe(true);
      await ctx.rebind("abcdefghijklmnopqrstuv");
      return { runnerId: "r2", browserKeyId: "abcdefghijklmnopqrstuv", enrolledAt: "now" };
    });
    await bridge.enroll("BCDFGHJK", "r2");
    expect(f.data.get("https://app.example:app:__bridge/browserKeyId")).toBe("abcdefghijklmnopqrstuv");
  });

  it("rejects browser cross-origin discovery before fetch, while allowing the app's auth issuer", async () => {
    const f = fixture();
    vi.stubGlobal("location", { origin: "https://other.example" });
    await expect(f.connect()).rejects.toThrow("cross-origin");
    expect(f.options.fetch).not.toHaveBeenCalled();
    vi.stubGlobal("location", { origin: "https://app.example" });
    const bridge = await f.connect();
    expect(bridge.discovery.auth.issuer).toBe("https://auth.example");
  });

  it("enforces same-origin discovery in Workers without window", async () => {
    const f = fixture();
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("location", { origin: "https://worker.example" });
    await expect(f.connect()).rejects.toThrow("cross-origin discovery");
    expect(f.options.fetch).not.toHaveBeenCalled();
    vi.stubGlobal("location", { origin: "https://app.example" });
    expect((await f.connect()).discovery.origin).toBe("https://app.example");
  });

  it("marks stale presence offline on socket loss and returns independent snapshots", async () => {
    const f = fixture();
    const bridge = await f.connect();
    f.presence({ runnerId: "r1", online: true, agents: [{ id: "claude", available: true }] });
    const snapshot = bridge.runners();
    snapshot[0]!.agents![0]!.available = false;
    expect(bridge.runners()[0]!.agents![0]!.available).toBe(true);
    f.states("reconnecting");
    expect(bridge.runners()[0]!.online).toBe(false);
    await expect(bridge.channel()).rejects.toThrow("runnerId");
  });

  it("preserves early channel messages while observing local UI notifications", async () => {
    const f = fixture();
    const bridge = await f.connect();
    const channel = await bridge.channel("r1");
    const kid = vi.mocked(f.transport.bindSession).mock.calls[0]![1];
    const message = { jsonrpc: "2.0" as const, method: "session/update", params: { early: true } };
    f.frame({ v: 1, kid, seq: 1, msg: message });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const onMessage = vi.fn();
    channel.onMessage(onMessage);
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(message);
    const ui = vi.fn();
    bridge.onLocalUi(ui);
    f.frame({ v: 1, kid, seq: 2, msg: { jsonrpc: "2.0", method: "_bridge/localUi", params: { pluginId: "p", url: "https://external.example/" } } });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(ui).not.toHaveBeenCalled();
  });
});

const runnerKey = (id: string) => `https://app.example:app:__bridge/runner/${id}`;
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

describe("BridgeClient setup status", () => {
  it("remembers enrolled runners across page closure and idle stop with no offline replay", async () => {
    const f = fixture();
    const bridge = await f.connect();
    f.presence({ runnerId: "r1", online: true, hostname: "laptop" });
    vi.mocked(enroll).mockImplementationOnce(async (_code, ctx) => {
      await ctx.keyStore.save("__bridge/runner/r1", "saved-key");
      return { runnerId: "r1", browserKeyId: "browser-key", enrolledAt: "now" };
    });
    await bridge.enroll("BCDFGHJK", "r1");
    bridge.close(); // The runner stops later, when no browser can see its offline presence.
    const nextPage = await f.connect(); // No presence replay: the runner is still stopped.
    const changes = vi.fn(); nextPage.onStatus(changes);
    await settle();
    expect(await nextPage.status()).toEqual({ state: "runner_offline", runner: { runnerId: "r1", online: false } });
    expect(changes).toHaveBeenCalledExactlyOnceWith(await nextPage.status());
    expect(await nextPage.isEnrolled("r1")).toBe(true);
    expect(f.data.get("https://app.example:app:__bridge/knownRunners")).toEqual(["r1"]);
  });

  it("merges successful enrollments from two clients without requiring presence", async () => {
    const f = fixture();
    const first = await f.connect();
    const second = await f.connect();
    vi.mocked(enroll).mockImplementation(async (_code, ctx) => {
      await ctx.keyStore.save(`__bridge/runner/${ctx.runnerId}`, "saved-key");
      return { runnerId: ctx.runnerId, browserKeyId: "browser-key", enrolledAt: "now" };
    });
    await Promise.all([first.enroll("BCDFGHJK", "r1"), second.enroll("BCDFGHJK", "r2")]);
    first.close(); second.close();
    const next = await f.connect();
    expect(next.runners().map((r) => r.runnerId).sort()).toEqual(["r1", "r2"]); // order is recency, set by enrollment race
    expect((await next.status("r1")).state).toBe("runner_offline");
    expect((await next.status("r2")).state).toBe("runner_offline");
    expect(await next.isEnrolled("r1")).toBe(true);
    expect(await next.isEnrolled("r2")).toBe(true);
  });

  it("retries a failed presence registry write during successful enrollment", async () => {
    const f = fixture();
    const bridge = await f.connect();
    const save = f.keyStore.save.getMockImplementation()!;
    f.keyStore.save.mockImplementationOnce(async () => { throw new Error("storage unavailable"); });
    f.presence({ runnerId: "r1", online: true });
    await settle();
    expect((await bridge.status()).state).toBe("online_not_enrolled");
    expect(f.data.has("https://app.example:app:__bridge/knownRunners")).toBe(false);
    f.keyStore.save.mockImplementation(save);
    vi.mocked(enroll).mockImplementationOnce(async (_code, ctx) => {
      await ctx.keyStore.save("__bridge/runner/r1", "saved-key");
      return { runnerId: "r1", browserKeyId: "browser-key", enrolledAt: "now" };
    });
    await bridge.enroll("BCDFGHJK", "r1");
    bridge.close();
    const next = await f.connect();
    expect((await next.status()).state).toBe("runner_offline");
  });

  it("loads only this app's known runners and never trusts registry entries", async () => {
    const f = fixture();
    f.data.set("https://other.example:app:__bridge/knownRunners", ["foreign"]);
    f.data.set("https://app.example:other-app:__bridge/knownRunners", ["other-app"]);
    f.data.set("https://app.example:app:__bridge/knownRunners", ["r1", "r1", null, 7, ""]);
    const bridge = await f.connect();
    expect(bridge.runners()).toEqual([{ runnerId: "r1", online: false }]);
    expect((await bridge.status()).state).toBe("runner_offline");
    f.presence({ runnerId: "r1", online: true });
    expect((await bridge.status()).state).toBe("online_not_enrolled");
    expect((await bridge.status("foreign")).state).toBe("no_runner");
    expect((await bridge.status("other-app")).state).toBe("no_runner");
  });

  it("notifies through single, ambiguous, selected-online and all-offline transitions", async () => {
    const f = fixture();
    f.data.set(runnerKey("r1"), "saved-key");
    const bridge = await f.connect();
    const changes = vi.fn(); bridge.onStatus(changes);
    f.presence({ runnerId: "r1", online: true });
    await settle();
    expect(changes.mock.lastCall![0].state).toBe("ready");
    f.presence({ runnerId: "r2", online: true });
    await settle();
    expect(await bridge.status()).toEqual({ state: "runner_selection_required" });
    expect(changes.mock.lastCall![0]).toEqual(await bridge.status());
    await expect(bridge.channel()).rejects.toThrow("specify runnerId");
    f.presence({ runnerId: "r2", online: false });
    await settle();
    expect(changes.mock.lastCall![0]).toEqual(await bridge.status());
    expect(changes.mock.lastCall![0].state).toBe("ready");
    await bridge.channel();
    expect(wrapClientLayer).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ runnerId: "r1" }));
    f.presence({ runnerId: "r1", online: false });
    await settle();
    expect(changes.mock.lastCall![0]).toEqual({ state: "runner_offline", runner: { runnerId: "r1", online: false } });
    expect((await bridge.status("r2")).state).toBe("runner_offline");
  });

  it("caps known runners at eight, most recently seen first, and refreshes on presence", async () => {
    const f = fixture();
    const key = "https://app.example:app:__bridge/knownRunners";
    f.data.set(key, Array.from({ length: 12 }, (_, i) => `r${i}`));
    const bridge = await f.connect();
    expect(bridge.runners().map((r) => r.runnerId)).toEqual(Array.from({ length: 8 }, (_, i) => `r${i}`));
    f.presence({ runnerId: "r5", online: true });
    f.presence({ runnerId: "new", online: true });
    f.presence({ runnerId: "new", online: false });
    f.presence({ runnerId: "r5", online: false });
    await settle();
    const expected = ["r5", "new", "r0", "r1", "r2", "r3", "r4", "r6"];
    expect(f.data.get(key)).toEqual(expected);
    expect(bridge.runners().map((r) => r.runnerId)).toEqual(expected);
    expect(await bridge.status()).toEqual({ state: "runner_offline", runner: { runnerId: "r5", online: false } });
  });

  it("ignores stale offline runners after a reinstall left an old one behind", async () => {
    const f = fixture();
    f.data.set("https://app.example:app:__bridge/knownRunners", ["fresh", "stale"]);
    const bridge = await f.connect();
    expect((await bridge.status()).state).toBe("runner_offline");
    f.presence({ runnerId: "fresh", online: true });
    expect((await bridge.status()).state).toBe("online_not_enrolled");
  });

  it.each([false, true])("waits for delayed initial presence before status or subscriptions (enrolled=%s)", async (enrolled) => {
    vi.useFakeTimers();
    const f = fixture();
    if (enrolled) f.data.set(runnerKey("r1"), "saved-key");
    const bridge = await f.connect({ settlePresence: false });
    const changes = vi.fn(); bridge.onStatus(changes);
    const current = vi.fn(); void bridge.status().then(current);
    await vi.advanceTimersByTimeAsync(50);
    expect(changes).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    f.presence({ runnerId: "r1", online: true });
    await vi.advanceTimersByTimeAsync(100);
    const expected = { state: enrolled ? "ready" : "online_not_enrolled", runner: { runnerId: "r1", online: true } };
    expect(changes).toHaveBeenCalledExactlyOnceWith(expected);
    expect(current).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it("settles an empty replay and releases pending status on close without notifying", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const bridge = await f.connect({ settlePresence: false });
    const changes = vi.fn(); bridge.onStatus(changes);
    await vi.advanceTimersByTimeAsync(100);
    expect(changes).toHaveBeenCalledExactlyOnceWith({ state: "no_runner" });
    const next = await f.connect({ settlePresence: false });
    const later = vi.fn(); next.onStatus(later);
    const pending = next.status();
    next.close();
    expect(await pending).toEqual({ state: "no_runner" });
    await vi.advanceTimersByTimeAsync(100);
    expect(later).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps ready after an error close by kid until a new handshake rejects trust by sid", async () => {
    const f = fixture();
    f.data.set(runnerKey("r1"), "saved-key");
    const bridge = await f.connect();
    f.presence({ runnerId: "r1", online: true });
    const changes = vi.fn(); bridge.onStatus(changes);
    const live = await bridge.channel();
    const liveClosed = vi.fn(); live.onClose(liveClosed);
    await settle();
    const kid = vi.mocked(f.transport.bindSession).mock.calls[0]![1];
    expect(changes.mock.lastCall![0].state).toBe("ready");
    const count = changes.mock.calls.length;
    f.pake({ runnerId: "r1", message: { t: "session/close", v: 1, kid, reason: "error" } });
    await settle();
    expect(live.closed).toBe(true);
    expect(liveClosed).toHaveBeenCalledExactlyOnceWith("error");
    expect((await bridge.status()).state).toBe("ready");
    expect(changes).toHaveBeenCalledTimes(count);
    expect(await bridge.isEnrolled("r1")).toBe(true);
    vi.mocked(wrapClientLayer).mockImplementationOnce((plain) => ({ ...plain, kind: "e2ee", kid: "",
      start: async (io) => {
        io.send({ t: "session/init", v: 1, sid: "retry", eph: "public" });
        await new Promise<void>(() => {});
      },
    }));
    const retry = await bridge.channel();
    const retryClosed = vi.fn(); retry.onClose(retryClosed);
    f.pake({ runnerId: "r1", message: { t: "session/close", v: 1, sid: "retry", reason: "not_trusted" } });
    await settle();
    expect(retryClosed).toHaveBeenCalledExactlyOnceWith("not_trusted");
    expect((await bridge.status()).state).toBe("online_not_enrolled");
    expect(changes.mock.lastCall![0].state).toBe("online_not_enrolled");
    expect(await bridge.isEnrolled("r1")).toBe(false);
    expect(f.data.has(runnerKey("r1"))).toBe(false);
  });

  it("reports initial status, all four states, metadata changes, deduplication and unsubscribe", async () => {
    const f = fixture();
    const bridge = await f.connect();
    const changes = vi.fn();
    const off = bridge.onStatus(changes);
    await settle();
    expect(changes).toHaveBeenLastCalledWith({ state: "no_runner" });
    f.presence({ runnerId: "r1", online: false, hostname: "laptop" });
    await settle();
    expect(changes).toHaveBeenLastCalledWith({ state: "runner_offline", runner: { runnerId: "r1", online: false, hostname: "laptop" } });
    f.presence({ runnerId: "r1", online: true });
    await settle();
    expect((await bridge.status()).state).toBe("online_not_enrolled");
    f.data.set(runnerKey("r1"), "saved-public-key");
    f.presence({ runnerId: "r1", online: true });
    await settle();
    expect((await bridge.status()).state).toBe("ready");
    expect(changes).toHaveBeenCalledTimes(4);
    f.presence({ runnerId: "r1", online: true });
    await settle();
    expect(changes).toHaveBeenCalledTimes(4);
    f.presence({ runnerId: "r1", online: true, hostname: "new-host" });
    await settle();
    expect(changes).toHaveBeenCalledTimes(5);
    const second = vi.fn();
    bridge.onStatus(second);
    await settle();
    expect(second).toHaveBeenCalledTimes(1);
    off();
    f.states("reconnecting");
    await settle();
    expect(changes).toHaveBeenCalledTimes(5);
    expect((await bridge.status()).state).toBe("runner_offline");
    expect(second.mock.lastCall![0].state).toBe("runner_offline");
  });

  it("scopes enrollment to this app and runner and selects the only online runner", async () => {
    const f = fixture();
    f.data.set("https://other.example:app:__bridge/runner/r1", "other-app-key");
    const bridge = await f.connect();
    expect(await bridge.isEnrolled("r1")).toBe(false);
    f.data.set(runnerKey("r1"), "saved-key");
    expect(await bridge.isEnrolled("r1")).toBe(true);
    expect(await bridge.isEnrolled("r2")).toBe(false);
    f.presence({ runnerId: "r1", online: false });
    f.presence({ runnerId: "r2", online: true });
    expect(await bridge.status()).toEqual({ state: "online_not_enrolled", runner: { runnerId: "r2", online: true } });
    expect((await bridge.status("r1")).state).toBe("runner_offline");
    expect((await bridge.status("r2")).state).toBe("online_not_enrolled");
    expect((await bridge.status("missing")).state).toBe("no_runner");
  });

  it("onStatus(handler, runnerId) reports a selected runner's changes while several stay online", async () => {
    const f = fixture();
    f.data.set(runnerKey("r1"), "saved-key");
    vi.mocked(wrapClientLayer).mockImplementation((plain) => ({ ...plain, kind: "e2ee", kid: "",
      start: async (io) => { io.send({ t: "session/init", v: 1, sid: "pending", eph: "public" }); await new Promise<void>(() => {}); },
    }));
    const bridge = await f.connect();
    for (const id of ["r1", "r2", "r3"]) f.presence({ runnerId: id, online: true });
    const summary = vi.fn(), scoped = vi.fn();
    bridge.onStatus(summary); const off = bridge.onStatus(scoped, "r1");
    await settle();
    expect(summary.mock.lastCall![0]).toEqual({ state: "runner_selection_required" });
    expect(scoped.mock.lastCall![0].state).toBe("ready");
    const channel = await bridge.channel("r1");
    channel.onClose(() => {});
    summary.mockClear();
    f.pake({ runnerId: "r1", message: { t: "session/close", v: 1, sid: "pending", reason: "not_trusted" } });
    await settle();
    expect(summary).not.toHaveBeenCalled(); // the default summary is unchanged, so it stays silent
    expect(scoped.mock.lastCall![0].state).toBe("online_not_enrolled");
    off(); scoped.mockClear();
    f.presence({ runnerId: "r1", online: false });
    await settle();
    expect(scoped).not.toHaveBeenCalled();
  });

  it("exposes not_trusted by sid before started, forgets enrollment, then restores it only on successful enroll", async () => {
    const f = fixture();
    f.data.set(runnerKey("r1"), "saved-key");
    vi.mocked(wrapClientLayer).mockImplementation((plain) => ({ ...plain, kind: "e2ee", kid: "",
      start: async (io) => {
        io.send({ t: "session/init", v: 1, sid: "pending", eph: "public" });
        await new Promise<void>(() => {});
      },
    }));
    const bridge = await f.connect();
    f.presence({ runnerId: "r1", online: true });
    const changes = vi.fn();
    bridge.onStatus(changes);
    await settle();
    expect((await bridge.status()).state).toBe("ready");
    const channel = await bridge.channel();
    const close = vi.fn(); channel.onClose(close);
    f.pake({ runnerId: "r1", message: { t: "session/close", v: 1, sid: "stale", reason: "not_trusted" } });
    expect(await bridge.isEnrolled("r1")).toBe(true);
    f.pake({ runnerId: "r1", message: { t: "session/close", v: 1, sid: "pending", reason: "not_trusted" } });
    expect(close).toHaveBeenCalledExactlyOnceWith("not_trusted");
    expect(f.transport.bindSession).not.toHaveBeenCalled();
    expect(await bridge.isEnrolled("r1")).toBe(false);
    expect(f.data.has(runnerKey("r1"))).toBe(false);
    await settle();
    expect(changes.mock.lastCall![0].state).toBe("online_not_enrolled");
    const nextPage = await f.connect();
    expect(await nextPage.isEnrolled("r1")).toBe(false);
    vi.mocked(enroll).mockRejectedValueOnce(new Error("denied"));
    await expect(bridge.enroll("BCDFGHJK")).rejects.toThrow("denied");
    expect(await bridge.isEnrolled("r1")).toBe(false);
    const onBrowserKey = vi.fn();
    vi.mocked(enroll).mockImplementationOnce(async (_code, ctx) => {
      ctx.onBrowserKey?.("browser-key");
      await ctx.keyStore.save("__bridge/runner/r1", "new-runner-key");
      return { runnerId: "r1", browserKeyId: "browser-key", enrolledAt: "now" };
    });
    await bridge.enroll("BCDFGHJK", "r1", { onBrowserKey });
    expect(onBrowserKey).toHaveBeenCalledExactlyOnceWith("browser-key");
    expect((await bridge.status()).state).toBe("ready");
    await settle();
    expect(changes.mock.lastCall![0].state).toBe("ready");
  });

  it("discards stale ready results when presence or trust changes during a key read", async () => {
    const f = fixture();
    const bridge = await f.connect();
    const channel = await bridge.channel("r1");
    await settle();
    const kid = vi.mocked(f.transport.bindSession).mock.calls[0]![1];
    let finish!: (key: unknown) => void;
    f.keyStore.load.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    f.presence({ runnerId: "r1", online: true });
    const changes = vi.fn(); bridge.onStatus(changes);
    const current = bridge.status("r1");
    f.pake({ runnerId: "r1", message: { t: "session/close", v: 1, kid, reason: "not_trusted" } });
    finish("stale-key");
    expect((await current).state).toBe("online_not_enrolled");
    await settle();
    expect(channel.closed).toBe(true);
    expect(changes.mock.calls.some(([s]) => s.state === "ready")).toBe(false);
    expect(await bridge.isEnrolled("r1")).toBe(false);

    f.keyStore.load.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    f.presence({ runnerId: "r2", online: true });
    const reading = bridge.status("r2");
    f.states("reconnecting");
    finish("old-key");
    expect((await reading).state).toBe("runner_offline");
  });

  it("keeps the denial when deleting stored trust fails and waits for deletion before reenrollment", async () => {
    const f = fixture();
    f.data.set(runnerKey("r1"), "saved-key");
    const bridge = await f.connect();
    const channel = await bridge.channel("r1");
    await settle();
    const kid = vi.mocked(f.transport.bindSession).mock.calls[0]![1];
    let forget!: () => void;
    f.keyStore.delete.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { forget = resolve; }); throw new Error("storage denied"); });
    f.pake({ runnerId: "r1", message: { t: "session/close", v: 1, kid, reason: "not_trusted" } });
    expect(channel.closed).toBe(true);
    expect(await bridge.isEnrolled("r1")).toBe(false);
    vi.mocked(enroll).mockImplementationOnce(async (_code, ctx) => {
      await ctx.keyStore.save("__bridge/runner/r1", "new-key");
      return { runnerId: "r1", browserKeyId: "key", enrolledAt: "now" };
    });
    const pending = bridge.enroll("BCDFGHJK", "r1");
    expect(enroll).not.toHaveBeenCalled();
    forget();
    await pending;
    expect(await bridge.isEnrolled("r1")).toBe(true);
  });

  it("isolates subscriber failures and mutations, and cancels pending notifications on close", async () => {
    const f = fixture();
    const bridge = await f.connect();
    bridge.onStatus((status) => { if (status.runner) status.runner.online = false; throw new Error("app callback"); });
    const changes = vi.fn(); bridge.onStatus(changes);
    f.presence({ runnerId: "r1", online: true });
    await settle();
    expect(changes.mock.lastCall![0].runner.online).toBe(true);
    f.presence({ runnerId: "r1", online: false });
    bridge.close();
    await settle();
    expect(changes).toHaveBeenCalledTimes(1);
    bridge.onStatus(changes);
    await settle();
    expect(changes).toHaveBeenCalledTimes(1);
  });
});
