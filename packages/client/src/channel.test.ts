import {
  createPlainLayer, HANDSHAKE_TIMEOUT_MS,
  type ChannelLayer, type ControlBody, type HandshakeIO, type JsonRpcMessage,
  type PakeMessage, type SequencedFrame,
} from "@berdyh/bridge-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannel } from "./channel.js";
import type { Transport, TransportState } from "./contracts.js";
import { events } from "./events.js";
import { createTransport } from "./transport.js";

const message: JsonRpcMessage = { jsonrpc: "2.0", method: "ping" };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function wire() {
  const frame = events<{ from: string; value: SequencedFrame }>();
  const pake = events<{ from: string; value: PakeMessage }>();
  const state = events<TransportState>();
  const control = events<ControlBody>();
  const transport: Transport = {
    state: "open", browserKeyId: "browser", connect: async () => {}, rebind: async () => {}, close: vi.fn(),
    beginSession: vi.fn(), bindSession: vi.fn(), sendFrame: vi.fn(), sendPake: vi.fn(),
    onFrame: (handler) => frame.on(({ from, value }) => handler(from, value)),
    onPake: (handler) => pake.on(({ from, value }) => handler(from, value)),
    onPresence: () => () => {}, onControl: control.on, onState: state.on,
  };
  return { transport, frame: (value: SequencedFrame, from = "r1") => frame.emit({ value, from }),
    pake: (value: PakeMessage, from = "r1") => pake.emit({ value, from }), state: state.emit };
}

afterEach(() => { vi.useRealTimers(); });

describe("channel lifecycle and layer seam", () => {
  it("preserves not_trusted before start resolves, including for late subscribers", async () => {
    const link = wire();
    let finish!: () => void;
    const layer: ChannelLayer = { ...createPlainLayer(), kind: "e2ee", kid: "", close: vi.fn(),
      start: async (io) => {
        io.send({ t: "session/init", v: 1, sid: "pending", eph: "public" });
        await new Promise<void>((resolve) => { finish = resolve; });
      },
    };
    const channel = createChannel(link.transport, "r1", layer);
    const close = vi.fn(); channel.onClose(close);
    link.pake({ t: "session/close", v: 1, sid: "other", reason: "not_trusted" });
    expect(channel.closed).toBe(false);
    link.pake({ t: "session/close", v: 1, sid: "pending", reason: "not_trusted" });
    expect(close).toHaveBeenCalledExactlyOnceWith("not_trusted");
    const late = vi.fn(); channel.onClose(late);
    expect(late).toHaveBeenCalledExactlyOnceWith("not_trusted");
    finish(); await tick();
    expect(link.transport.bindSession).not.toHaveBeenCalled();
    expect(layer.close).toHaveBeenCalledOnce();
  });

  it("begins before start, binds before data, and serializes asynchronous seal and open operations", async () => {
    const link = wire();
    const calls: string[] = [];
    let finishStart!: () => void;
    const plain = createPlainLayer({ kid: "session" });
    const layer: ChannelLayer = { ...plain, start: async () => {
      expect(link.transport.beginSession).toHaveBeenCalledWith("r1");
      calls.push("start");
      await new Promise<void>((resolve) => { finishStart = resolve; });
    }, seal: async (msg) => {
      expect(link.transport.bindSession).toHaveBeenCalledWith("r1", "session");
      calls.push(`seal${msg.id}`);
      await Promise.resolve();
      return plain.seal(msg);
    }, open: async (frame) => { calls.push(`open${frame.seq}`); await Promise.resolve(); return plain.open(frame); } };
    const channel = createChannel(link.transport, "r1", layer);
    const first = channel.send({ ...message, id: 1 });
    const second = channel.send({ ...message, id: 2 });
    await tick();
    expect(link.transport.sendFrame).not.toHaveBeenCalled();
    finishStart();
    await Promise.all([first, second]);
    expect(calls).toEqual(["start", "seal1", "seal2"]);
    const received: JsonRpcMessage[] = [];
    channel.onMessage((msg) => received.push(msg));
    link.frame({ v: 1, kid: "session", seq: 1, msg: { ...message, id: 1 } });
    link.frame({ v: 1, kid: "session", seq: 2, msg: { ...message, id: 2 } });
    link.frame({ v: 1, kid: "other", seq: 90, msg: message });
    await tick();
    expect(received.map((msg) => msg.id)).toEqual([1, 2]);
    expect(calls.slice(3)).toEqual(["open1", "open2"]);
    channel.close();
  });

  it.each(["closed", "timeout"])("clears a pre-init E2EE session locally on %s so enrollment can rebind", async (ending) => {
    vi.useFakeTimers();
    const sockets: TestSocket[] = [];
    class TestSocket extends EventTarget {
      readyState = 0;
      sent: string[] = [];
      constructor() { super(); sockets.push(this); }
      send(text: string) { this.sent.push(text); }
      open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
      close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 })); }
    }
    const transport = createTransport({ relayUrl: "wss://app.example/relay", browserKeyId: "before",
      getSessionToken: async () => "token", webSocket: TestSocket as unknown as typeof WebSocket });
    try {
      const connected = transport.connect();
      await tick();
      sockets[0]!.open();
      await connected;
      let loadKey!: () => void;
      const layer: ChannelLayer = { ...createPlainLayer(), kind: "e2ee", kid: "", close: vi.fn(),
        start: async (io) => {
          await new Promise<void>((resolve) => { loadKey = resolve; });
          io.send({ t: "session/init", v: 1, sid: "late", eph: "public" });
        } };
      const channel = createChannel(transport, "r1", layer);
      const send = channel.send(message);
      if (ending === "closed") channel.close();
      else await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
      await send;
      expect(channel.closed).toBe(true);
      expect(layer.close).toHaveBeenCalledOnce();
      expect(sockets[0]!.sent).toEqual([]);
      expect(vi.getTimerCount()).toBe(1); // only the open socket's heartbeat idle timer
      const rebound = transport.rebind("enrolled");
      await tick();
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      await rebound;
      loadKey();
      await tick();
      expect(sockets[1]!.sent).toEqual([]);
      expect(() => transport.bindSession("r1", "late")).toThrow("no active session");
      expect(transport.browserKeyId).toBe("enrolled");
    } finally { transport.close(); }
  });

  it("bounds startup, settles queued sends on timeout, and scopes pending closes by sid", async () => {
    vi.useFakeTimers();
    const link = wire();
    let io!: HandshakeIO;
    const onHandshake = vi.fn();
    const layer: ChannelLayer = {
      ...createPlainLayer(), kind: "e2ee", kid: "",
      start: async (handshake) => {
        io = handshake;
        io.onMessage(onHandshake);
        io.send({ t: "session/init", v: 1, sid: "pending", eph: "public" });
        await new Promise<void>(() => {});
      }, close: vi.fn(),
    };
    const channel = createChannel(link.transport, "r1", layer);
    const onClose = vi.fn();
    channel.onClose(onClose);
    const pending = channel.send(message);
    link.pake({ t: "session/close", v: 1, sid: "other", reason: "superseded" });
    link.pake({ t: "session/close", v: 1 });
    expect(channel.closed).toBe(false);
    expect(onHandshake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    await pending;
    expect(channel.closed).toBe(true);
    expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
    expect(link.transport.sendPake).toHaveBeenLastCalledWith("r1", { t: "session/close", v: 1, sid: "pending", reason: "error" });
    expect(layer.close).toHaveBeenCalledOnce();
    io.send({ t: "session/init", v: 1, sid: "late", eph: "public" });
    expect(link.transport.sendPake).toHaveBeenCalledTimes(2);
  });

  it("consumes matching session closes, ignores stale ones, and notifies late close subscribers", async () => {
    const link = wire();
    const channel = createChannel(link.transport, "r1", createPlainLayer({ kid: "session" }));
    await tick();
    const onClose = vi.fn();
    channel.onClose(onClose);
    link.pake({ t: "session/close", v: 1, kid: "other" });
    link.pake({ t: "session/close", v: 1, kid: "session" }, "other-runner");
    expect(channel.closed).toBe(false);
    link.pake({ t: "session/close", v: 1, kid: "session" });
    channel.close();
    expect(onClose).toHaveBeenCalledExactlyOnceWith("peer closed");
    expect(link.transport.sendPake).not.toHaveBeenCalled();
    const late = vi.fn();
    channel.onClose(late);
    expect(late).toHaveBeenCalledExactlyOnceWith("peer closed");
    await channel.send(message);
    expect(link.transport.sendFrame).not.toHaveBeenCalled();
  });

  it("closes failed handshakes on socket loss but preserves established sessions across reconnects", async () => {
    const link = wire();
    const channel = createChannel(link.transport, "r1", createPlainLayer());
    await tick();
    link.state("reconnecting");
    expect(channel.closed).toBe(false);
    link.state("closed");
    expect(channel.closed).toBe(true);
    const pendingLink = wire();
    const layer: ChannelLayer = { ...createPlainLayer(), kind: "e2ee", start: () => new Promise(() => {}) };
    const pending = createChannel(pendingLink.transport, "r1", layer);
    pendingLink.state("reconnecting");
    expect(pending.closed).toBe(true);
  });

  it("turns seal/open failures into an error close without rejecting send", async () => {
    for (const operation of ["seal", "open"] as const) {
      const link = wire();
      const layer = { ...createPlainLayer({ kid: "session" }), [operation]: async () => { throw new Error("bad layer"); } };
      const channel = createChannel(link.transport, "r1", layer);
      const onClose = vi.fn();
      channel.onClose(onClose);
      await tick();
      if (operation === "seal") await expect(channel.send(message)).resolves.toBeUndefined();
      else link.frame({ v: 1, kid: "session", seq: 1, msg: message });
      await tick();
      expect(channel.closed).toBe(true);
      expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
      expect(link.transport.sendPake).toHaveBeenCalledExactlyOnceWith("r1", { t: "session/close", v: 1, kid: "session", reason: "error" });
    }
  });

  it("settles an in-flight seal on close and prevents late data from escaping", async () => {
    const link = wire();
    let resolveSeal!: (frame: SequencedFrame) => void;
    const channel = createChannel(link.transport, "r1", { ...createPlainLayer({ kid: "session" }),
      seal: () => new Promise((resolve) => { resolveSeal = resolve; }) });
    const send = channel.send(message);
    await tick();
    channel.close();
    await send;
    resolveSeal({ v: 1, kid: "session", seq: 1, msg: message });
    await tick();
    expect(link.transport.sendFrame).not.toHaveBeenCalled();
  });

  it("buffers messages until a subscriber attaches and tolerates subscriber failure", async () => {
    const link = wire();
    const channel = createChannel(link.transport, "r1", createPlainLayer({ kid: "session" }));
    await tick();
    link.frame({ v: 1, kid: "session", seq: 1, msg: message });
    await tick();
    const got = vi.fn();
    channel.onMessage(got);
    channel.onMessage(() => { throw new Error("app bug"); });
    const other = vi.fn();
    channel.onMessage(other);
    link.frame({ v: 1, kid: "session", seq: 2, msg: message });
    await tick();
    expect(got).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledOnce();
    channel.close();
  });

  it("stops dispatch immediately when a message subscriber closes the channel", async () => {
    const link = wire();
    const channel = createChannel(link.transport, "r1", createPlainLayer({ kid: "session" }));
    await tick();
    channel.onMessage(() => channel.close());
    const later = vi.fn();
    channel.onMessage(later);
    link.frame({ v: 1, kid: "session", seq: 1, msg: message });
    await tick();
    expect(channel.closed).toBe(true);
    expect(later).not.toHaveBeenCalled();
  });
});
