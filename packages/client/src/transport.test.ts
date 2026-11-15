import { HANDSHAKE_TIMEOUT_MS, type PakeMessage, type PlainFrame } from "@berdyh/bridge-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTransport } from "./transport.js";
import { createChannel } from "./channel.js";
import { createPlainLayer, type ChannelLayer } from "@berdyh/bridge-protocol";
import * as protocol from "@berdyh/bridge-protocol";

class Socket extends EventTarget {
  static instances: Socket[] = [];
  readyState = 0;
  sent: string[] = [];
  constructor(readonly url: string, readonly protocols: string[]) {
    super();
    Socket.instances.push(this);
  }
  send(value: string) { this.sent.push(value); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(body: unknown, runnerId = "r1", kind = "frame") {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ to: "browser", runnerId, kind, body }) }));
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}
const constructor = Socket as unknown as typeof WebSocket;
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  Socket.instances = [];
  vi.restoreAllMocks();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

function setup(overrides = {}) {
  const transport = createTransport({ relayUrl: "wss://app.example/relay", browserKeyId: "browser",
    getSessionToken: async () => "token", webSocket: constructor, ...overrides });
  cleanups.push(() => transport.close());
  return transport;
}
const frame = (seq = 1, kid = "session"): PlainFrame => ({ v: 1, kid, seq, msg: { jsonrpc: "2.0", method: "ping" } });

describe("transport timing and native browser socket", () => {
  it("clears a not_trusted handshake by sid before started and allows rebind", async () => {
    vi.useFakeTimers();
    const link = setup();
    const connected = link.connect();
    await tick();
    const socket = Socket.instances[0]!;
    socket.open(); await connected;
    let finish!: () => void;
    const channel = createChannel(link, "r1", { ...createPlainLayer(), kind: "e2ee", kid: "",
      start: async (io) => {
        io.send({ t: "session/init", v: 1, sid: "pending", eph: "public" });
        await new Promise<void>((resolve) => { finish = resolve; });
      },
    });
    const close = vi.fn(); channel.onClose(close);
    const send = channel.send({ jsonrpc: "2.0", method: "ping" });
    socket.message({ t: "session/close", v: 1, reason: "not_trusted" }, "r1", "pake");
    socket.message({ t: "session/close", v: 1, sid: "other", reason: "not_trusted" }, "r1", "pake");
    socket.message({ t: "session/close", v: 1, sid: "pending", reason: "not_trusted" }, "r2", "pake");
    expect(channel.closed).toBe(false);
    socket.message({ t: "session/close", v: 1, sid: "pending", reason: "not_trusted" }, "r1", "pake");
    await send;
    expect(close).toHaveBeenCalledExactlyOnceWith("not_trusted");
    expect(() => link.bindSession("r1", "late")).toThrow("active session");
    expect(vi.getTimerCount()).toBe(1); // only the heartbeat
    const rebound = link.rebind("enrolled");
    await tick(); Socket.instances[1]!.open(); await rebound;
    finish(); await tick();
    expect(Socket.instances[1]!.sent).toEqual([]);
  });

  it("uses the native WebSocket in a Worker without window", async () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("location", { origin: "https://app.example" });
    vi.stubGlobal("WebSocket", constructor);
    const link = setup({ webSocket: undefined });
    const connected = link.connect();
    await tick();
    expect(Socket.instances).toHaveLength(1);
    Socket.instances[0]!.open();
    await connected;
  });

  it.each([2 ** 60, 1.5, 0, -1, "1"])("closes only the malformed frame's session for seq=%s", async (seq) => {
    const link = setup();
    const connected = link.connect();
    await tick();
    const socket = Socket.instances[0]!;
    socket.open();
    await connected;
    link.beginSession("r1"); link.bindSession("r1", "session");
    link.beginSession("r2"); link.bindSession("r2", "other");
    const channelClose = vi.fn();
    link.onPake(channelClose);
    const delivered = vi.fn();
    link.onFrame(delivered);
    socket.message({ ...frame(), seq, kid: "stale" });
    expect(channelClose).not.toHaveBeenCalled();
    socket.message({ ...frame(), seq });
    expect(channelClose).toHaveBeenCalledExactlyOnceWith("r1", {
      t: "session/close", v: 1, kid: "session", reason: "error",
    });
    expect(JSON.parse(socket.sent.at(-1)!).body).toMatchObject({ t: "session/close", reason: "error" });
    expect(() => link.sendFrame("r1", frame())).toThrow("bound session");
    socket.message(frame(1, "other"), "r2");
    expect(delivered).toHaveBeenCalledExactlyOnceWith("r2", frame(1, "other"));
    expect(link.state).toBe("open");
  });

  it.each(["connecting", "reconnecting"])("delivers a channel's queued session/init while %s before any data", async (state) => {
    vi.useFakeTimers();
    const link = setup({ random: () => 0 });
    let connected = link.connect();
    await tick();
    if (state === "reconnecting") {
      Socket.instances[0]!.open();
      await connected;
      Socket.instances[0]!.close(1006);
      connected = link.connect();
    }
    let accept!: () => void;
    const layer: ChannelLayer = { ...createPlainLayer({ kid: "session" }), kind: "e2ee",
      start: async (io) => {
        io.send({ t: "session/init", v: 1, sid: "pending", eph: "public" });
        await new Promise<void>((resolve) => { accept = resolve; });
      } };
    const channel = createChannel(link, "r1", layer);
    const send = channel.send({ jsonrpc: "2.0", method: "ping" });
    if (state === "reconnecting") await vi.advanceTimersByTimeAsync(125);
    const socket = Socket.instances.at(-1)!;
    expect(socket.sent).toEqual([]);
    socket.open();
    await connected;
    expect(socket.sent.map((text) => JSON.parse(text).body)).toEqual([
      { t: "session/init", v: 1, sid: "pending", eph: "public" },
    ]);
    accept();
    await send;
    expect(JSON.parse(socket.sent[1]!).body).toMatchObject({ kid: "session", seq: 1 });
    expect(channel.closed).toBe(false);
    channel.close();
  });

  it.each(["receiver", "handler"])("contains an unexpected %s error in the addressed session", async (fault) => {
    const receiver = protocol.createReliableReceiver({ role: "browser" });
    vi.spyOn(protocol, "createReliableReceiver").mockReturnValueOnce(receiver);
    const link = setup();
    const connected = link.connect();
    await tick();
    const socket = Socket.instances[0]!;
    socket.open(); await connected;
    link.beginSession("r1"); link.bindSession("r1", "session");
    link.beginSession("r2"); link.bindSession("r2", "other");
    if (fault === "receiver") vi.spyOn(receiver, "accept").mockImplementationOnce(() => { throw new Error("invalid sequence"); });
    else vi.spyOn(protocol, "isFrameBody").mockImplementationOnce(() => { throw new Error("malformed body"); });
    const close = vi.fn();
    link.onPake(close);
    socket.message(frame());
    expect(close).toHaveBeenCalledExactlyOnceWith("r1", { t: "session/close", v: 1, kid: "session", reason: "error" });
    expect(() => link.sendFrame("r2", frame(1, "other"))).not.toThrow();
    expect(link.state).toBe("open");
  });

  it.each(["before init", "after init"])("ends malformed pending handshakes %s immediately and blocks late init", async (phase) => {
    vi.useFakeTimers();
    const link = setup();
    const connected = link.connect();
    await tick();
    const socket = Socket.instances[0]!;
    socket.open(); await connected;
    let finishStart!: () => void;
    const layer: ChannelLayer = { ...createPlainLayer(), kind: "e2ee", kid: "", close: vi.fn(),
      start: async (io) => {
        if (phase === "after init") io.send({ t: "session/init", v: 1, sid: "pending", eph: "public" });
        await new Promise<void>((resolve) => { finishStart = resolve; });
        io.send({ t: "session/init", v: 1, sid: "late", eph: "public" });
      } };
    const channel = createChannel(link, "r1", layer);
    const close = vi.fn();
    channel.onClose(close);
    const send = channel.send({ jsonrpc: "2.0", method: "ping" });
    socket.message({ t: "session/close", v: 1, reason: "error" }, "r1", "pake");
    expect(channel.closed).toBe(false);
    socket.message(frame(2 ** 60));
    await send;
    expect(channel.closed).toBe(true);
    expect(close).toHaveBeenCalledExactlyOnceWith("error");
    expect(layer.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1); // only the open socket's heartbeat idle timer
    const before = socket.sent.slice();
    finishStart(); await tick();
    expect(socket.sent).toEqual(before);
    expect(link.state).toBe("open");
  });

  it.each(["encrypted frame", "ack"])("rejects an unsafe integer in an incoming %s as a session fault", async (kind) => {
    const link = setup();
    const connected = link.connect();
    await tick();
    const socket = Socket.instances[0]!;
    socket.open(); await connected;
    link.beginSession("r1"); link.bindSession("r1", "session");
    const close = vi.fn();
    link.onPake(close);
    socket.message(kind === "ack" ? { v: 1, kid: "session", ack: 2 ** 60 }
      : { v: 1, kid: "session", seq: 2 ** 60, nonce: "AAAAAAAAAAAAAAAA", ct: "Zm9v" });
    expect(close).toHaveBeenCalledExactlyOnceWith("r1", { t: "session/close", v: 1, kid: "session", reason: "error" });
    expect(link.state).toBe("open");
  });

  it("flushes queued session/init ahead of retained data without sending the data twice", async () => {
    const link = setup();
    link.beginSession("r1");
    link.sendPake("r1", { t: "session/init", v: 1, sid: "pending", eph: "public" });
    link.bindSession("r1", "session");
    link.sendFrame("r1", frame());
    const connected = link.connect();
    await tick();
    const socket = Socket.instances[0]!;
    socket.open(); await connected;
    expect(socket.sent.map((text) => JSON.parse(text).body)).toEqual([
      { t: "session/init", v: 1, sid: "pending", eph: "public" }, frame(),
    ]);
  });

  it("ends a channel visibly when socket.send throws rather than dropping its frame", async () => {
    vi.useFakeTimers();
    const link = setup();
    const connected = link.connect();
    await tick();
    const socket = Socket.instances[0]!;
    socket.open(); await connected;
    const channel = createChannel(link, "r1", createPlainLayer({ kid: "session" }));
    await tick();
    const close = vi.fn();
    channel.onClose(close);
    vi.spyOn(socket, "send").mockImplementationOnce(() => { throw new Error("broken socket"); });
    await channel.send({ jsonrpc: "2.0", method: "ping" });
    expect(channel.closed).toBe(true);
    expect(close).toHaveBeenCalledExactlyOnceWith("error");
    expect(() => link.bindSession("r1", "session")).toThrow("active session");
  });

  it("rejects sendPake if an open socket cannot send", async () => {
    const link = setup();
    const connected = link.connect();
    await tick();
    const socket = Socket.instances[0]!;
    socket.open(); await connected;
    vi.spyOn(socket, "send").mockImplementationOnce(() => { throw new Error("broken socket"); });
    expect(() => link.sendPake("r1", { t: "session/init", v: 1, sid: "pending", eph: "public" })).toThrow("WebSocket send failed");
  });

  it("ends a starting channel visibly when the disconnected handshake queue overflows", async () => {
    vi.useFakeTimers();
    const link = setup();
    const init: PakeMessage = { t: "session/init", v: 1, sid: "pending", eph: "public" };
    for (let i = 0; i < 256; i++) link.sendPake("r2", init);
    const layer: ChannelLayer = { ...createPlainLayer(), kind: "e2ee", close: vi.fn(),
      start: async (io) => { io.send(init); } };
    const channel = createChannel(link, "r1", layer);
    const close = vi.fn();
    channel.onClose(close);
    await tick();
    expect(channel.closed).toBe(true);
    expect(close).toHaveBeenCalledExactlyOnceWith("error");
    expect(layer.close).toHaveBeenCalledOnce();
    const rebound = link.rebind("new");
    await tick();
    Socket.instances[0]!.open();
    await rebound;
    expect(Socket.instances[0]!.sent).toEqual([]);
  });

  it("bounds disconnected handshake count and bytes and clears cancelled init messages", async () => {
    const link = setup();
    const init: PakeMessage = { t: "session/init", v: 1, sid: "pending", eph: "public" };
    expect(() => link.sendPake("r1", { ...init, eph: "x".repeat(4 * 1024 * 1024) })).toThrow("overflow");
    link.beginSession("r1");
    link.sendPake("r1", init);
    link.sendPake("r1", { t: "session/close", v: 1, sid: "pending", reason: "closed" });
    for (let i = 1; i < 256; i++) link.sendPake("r2", init);
    expect(() => link.sendPake("r2", init)).toThrow("overflow");
    const connected = link.connect();
    await tick();
    const socket = Socket.instances[0]!;
    socket.open();
    await connected;
    expect(socket.sent).toHaveLength(256);
    expect(socket.sent.map((text) => JSON.parse(text)).some((message) => message.runnerId === "r1" && message.body.t === "session/init")).toBe(false);
    link.close();
    expect(() => link.sendPake("r1", init)).toThrow("closed");
  });

  it("encodes retained data once per send, frees UTF-8 bytes on ack and resets on a new session", async () => {
    const link = setup();
    const connected = link.connect();
    await tick();
    const socket = Socket.instances[0]!;
    socket.open(); await connected;
    link.beginSession("r1"); link.bindSession("r1", "session");
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const large = (seq: number) => ({ ...frame(seq), msg: { jsonrpc: "2.0" as const, payload: "€".repeat(1024 * 1024) } });
    try {
      link.sendFrame("r1", large(1));
      expect(() => link.sendFrame("r1", large(2))).toThrow("overflow");
      expect(encode).toHaveBeenCalledTimes(2);
      socket.message({ v: 1, kid: "session", ack: 1 });
      link.sendFrame("r1", large(2));
      expect(encode).toHaveBeenCalledTimes(3);
      socket.message({ v: 1, kid: "session", ack: 1 });
      expect(() => link.sendFrame("r1", large(3))).toThrow("overflow");
      link.beginSession("r1"); link.bindSession("r1", "new");
      link.sendFrame("r1", { ...large(1), kid: "new" });
    } finally { encode.mockRestore(); }
  });

  it("uses the native constructor in a browser and cancels pending connect on terminal close", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("location", { origin: "https://app.example" });
    vi.stubGlobal("WebSocket", constructor);
    const link = setup({ webSocket: undefined });
    const pending = link.connect();
    const rejected = expect(pending).rejects.toThrow("closed");
    await tick();
    expect(Socket.instances[0]!.url).toBe("wss://app.example/relay/browser?browserKeyId=browser");
    expect(Socket.instances[0]!.protocols).toEqual(["bridge.v1", "bearer.token"]);
    link.close();
    await rejected;
    await expect(link.rebind("new")).rejects.toThrow("closed");
  });

  it("keeps retrying established links with exponential jittered backoff, capped at 30 seconds", async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    const token = vi.fn(async (): Promise<string> => { throw new Error("temporary auth outage"); }).mockResolvedValueOnce("token");
    const link = setup({ random: () => 0, getSessionToken: token,
      sleep: (ms: number) => { delays.push(ms); return new Promise<void>((resolve) => setTimeout(resolve, ms)); } });
    const connected = link.connect();
    await tick();
    Socket.instances[0]!.open();
    await connected;
    Socket.instances[0]!.close(1006);
    const rejected = expect(link.connect()).rejects.toThrow("closed");
    await vi.advanceTimersToNextTimerAsync();
    expect(delays).toEqual([125, 250]);
    for (let i = 0; i < 10; i++) await vi.advanceTimersToNextTimerAsync();
    expect(delays.slice(0, 4)).toEqual([125, 250, 500, 1000]);
    expect(delays.at(-1)).toBe(15_000);
    link.close();
    await rejected;
    const count = token.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(token).toHaveBeenCalledTimes(count);
  });

  it("never forwards a WebSocket constructor error, which may echo the bearer token", async () => {
    vi.useFakeTimers();
    class Throwing { constructor(_url: string, protocols: string[]) { throw new Error(`invalid subprotocol ${protocols.join(",")}`); } }
    const link = setup({ getSessionToken: async () => "SECRET-TOKEN", webSocket: Throwing as unknown as typeof WebSocket, random: () => 0 });
    const failure = link.connect().then(() => undefined, (error: unknown) => error as Error);
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    const error = (await failure)!;
    expect(error.message).toBe("transport connect timed out");
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify([error.message, error.stack, error.cause])).not.toContain("SECRET-TOKEN");
  });

  it("forwards only the token error's message: no cause, stack or properties", async () => {
    vi.useFakeTimers();
    const original = Object.assign(new Error("Sign in", { cause: new Error("Authorization: Bearer SECRET-TOKEN") }), { header: "Bearer SECRET-TOKEN" });
    const link = setup({ getSessionToken: async () => { throw original; }, random: () => 0 });
    const failure = link.connect().then(() => undefined, (error: unknown) => error as Error);
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    const error = (await failure)!;
    expect(error).not.toBe(original);
    expect(error.message).toBe("Sign in");
    expect(error.cause).toBeUndefined();
    expect("header" in error).toBe(false);
    expect(error.stack ?? "").not.toContain("SECRET-TOKEN");
  });

  it("a stale token success does not wipe a newer attempt's error", async () => {
    vi.useFakeTimers();
    let resolveA!: (token: string) => void;
    let calls = 0;
    const getSessionToken = () => calls++ === 0 ? new Promise<string>((resolve) => { resolveA = resolve; })
      : calls === 2 ? Promise.reject(new Error("Sign in")) : new Promise<string>(() => {});
    const link = setup({ getSessionToken, random: () => 0 });
    const first = link.connect().then(() => undefined, () => undefined);
    await tick();
    const rebound = link.rebind("new").then(() => undefined, (error: unknown) => error as Error);
    await tick();
    resolveA("late-token");
    await tick();
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    expect((await rebound)?.message).toBe("Sign in");
    await first;
  });

  it.each(["refused upgrade", "silent socket", "rejected token", "pending token"])("bounds initial connect with a %s", async (failure) => {
    vi.useFakeTimers();
    let finishToken!: (token: string) => void;
    const token = failure === "rejected token" ? async () => { throw new Error("auth unavailable"); }
      : failure === "pending token" ? () => new Promise<string>((resolve) => { finishToken = resolve; }) : async () => "token";
    const link = setup({ getSessionToken: token, random: () => 0 });
    // A token rejection is the app's own error (e.g. "Sign in"): the deadline reports it, not a generic timeout.
    const message = failure === "rejected token" ? "auth unavailable" : "connect timed out";
    const first = expect(link.connect()).rejects.toThrow(message);
    await tick();
    if (failure === "refused upgrade") Socket.instances[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS - 1);
    const second = expect(link.connect()).rejects.toThrow(message);
    expect(link.state).not.toBe("closed");
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(link.state).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
    const attempts = Socket.instances.length;
    if (failure === "pending token") { finishToken("late-token"); await tick(); }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(Socket.instances).toHaveLength(attempts);
  });

  it("recovers from a refused initial upgrade before the deadline", async () => {
    vi.useFakeTimers();
    const link = setup({ random: () => 0 });
    const connected = link.connect();
    await tick();
    Socket.instances[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(125);
    Socket.instances[1]!.open();
    await connected;
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    expect(link.state).toBe("open");
    expect(vi.getTimerCount()).toBe(1); // only the open socket's heartbeat idle timer
  });

  it("gives rebind its own bounded initial connection even after an established link", async () => {
    vi.useFakeTimers();
    const link = setup({ random: () => 0 });
    const connected = link.connect();
    await tick();
    Socket.instances[0]!.open();
    await connected;
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS * 2);
    const rebound = expect(link.rebind("new")).rejects.toThrow("connect timed out");
    await tick();
    expect(Socket.instances[1]!.url).toContain("browserKeyId=new");
    Socket.instances[1]!.close(1006);
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    await rebound;
    expect(link.state).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out pending sessions and never delivers their early frames afterwards", async () => {
    vi.useFakeTimers();
    const link = setup();
    const connected = link.connect();
    await tick();
    const socket = Socket.instances[0]!;
    socket.open();
    await connected;
    link.beginSession("r1");
    link.sendPake("r1", { t: "session/init", v: 1, sid: "pending", eph: "public" });
    socket.message(frame());
    const onPake = vi.fn();
    link.onPake(onPake);
    const onFrame = vi.fn();
    link.onFrame(onFrame);
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    expect(onPake).toHaveBeenCalledExactlyOnceWith("r1", { t: "session/close", v: 1, sid: "pending", reason: "error" });
    expect(onFrame).not.toHaveBeenCalled();
    expect(() => link.bindSession("r1", "session")).toThrow("active session");
    expect(link.state).toBe("open");
  });

  it("rejects an impossible ack before the first send; silently ignores unrelated acks", async () => {
    const link = setup();
    const connected = link.connect();
    await tick();
    const socket = Socket.instances[0]!;
    socket.open();
    await connected;
    link.beginSession("r1"); link.bindSession("r1", "session");
    const onPake = vi.fn();
    link.onPake(onPake);
    socket.message({ v: 1, kid: "other", ack: 999 });
    socket.message({ v: 1, kid: "session", ack: 0 });
    expect(onPake).not.toHaveBeenCalled();
    socket.message({ v: 1, kid: "session", ack: 1 });
    expect(onPake).toHaveBeenCalledExactlyOnceWith("r1", { t: "session/close", v: 1, kid: "session", reason: "error" });
  });

  it("keeps session closes scoped, retires old kids, and bounds retained bytes", async () => {
    const link = setup();
    const connected = link.connect();
    await tick();
    const socket = Socket.instances[0]!;
    socket.open();
    await connected;
    link.beginSession("r1"); link.bindSession("r1", "old");
    link.sendFrame("r1", frame(1, "old"));
    link.beginSession("r1"); link.bindSession("r1", "session");
    const onPake = vi.fn();
    link.onPake(onPake);
    socket.message({ t: "session/close", v: 1, kid: "old" } satisfies PakeMessage, "r1", "pake");
    socket.message({ t: "session/close", v: 1 } satisfies PakeMessage, "r1", "pake");
    expect(onPake).not.toHaveBeenCalled();
    link.sendPake("r1", { t: "session/close", v: 1 });
    expect(() => link.sendFrame("r1", { ...frame(), msg: { jsonrpc: "2.0", payload: "x".repeat(4 * 1024 * 1024) } })).toThrow("overflow");
    link.sendFrame("r1", frame());
    const close: PakeMessage = { t: "session/close", v: 1, kid: "session", reason: "unknown_session" };
    socket.message(close, "r1", "pake");
    expect(onPake).toHaveBeenCalledExactlyOnceWith("r1", close);
    expect(() => link.sendFrame("r1", frame(2))).toThrow("bound session");
    const rebound = link.rebind("new");
    await tick();
    Socket.instances[1]!.open();
    await rebound;
    expect(link.browserKeyId).toBe("new");
  });

  it("cancels the default backoff timer when closed", async () => {
    vi.useFakeTimers();
    const link = setup();
    const connected = link.connect();
    await tick();
    Socket.instances[0]!.open();
    await connected;
    Socket.instances[0]!.close();
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    link.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
