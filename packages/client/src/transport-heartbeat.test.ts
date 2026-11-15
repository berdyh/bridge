import { afterEach, describe, expect, it, vi } from "vitest";

import { createTransport } from "./transport.js";

// The heartbeat contract: ping after 20 s without outbound traffic, a missing pong
// within 10 s means a half-open socket (reconnect), only a pong settles a ping, a ping is
// answered and a stray pong ignored, and neither string reaches the session code.
const PING = "bridge:ping";
const PONG = "bridge:pong";
const IDLE = 20_000;
const PONG_WAIT = 10_000;

class Socket extends EventTarget {
  static instances: Socket[] = [];
  readyState = 0;
  sent: string[] = [];
  closeCalls = 0;
  /** A half-open socket never finishes the close handshake: `close()` fires no event. */
  silentClose = false;
  constructor(readonly url: string, readonly protocols: string[]) {
    super();
    Socket.instances.push(this);
  }
  send(value: string) { this.sent.push(value); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  text(data: string) { this.dispatchEvent(new MessageEvent("message", { data })); }
  message(body: unknown, runnerId = "r1", kind = "frame") {
    this.text(JSON.stringify({ to: "browser", runnerId, kind, body }));
  }
  close(code = 1000) {
    this.closeCalls++;
    if (this.silentClose || this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}
const constructor = Socket as unknown as typeof WebSocket;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  Socket.instances = [];
  vi.useRealTimers();
});

async function openTransport() {
  vi.useFakeTimers();
  const transport = createTransport({ relayUrl: "wss://app.example/relay", browserKeyId: "browser",
    getSessionToken: async () => "token", webSocket: constructor, random: () => 0 });
  cleanups.push(() => transport.close());
  const connected = transport.connect();
  await vi.advanceTimersByTimeAsync(0);
  const socket = Socket.instances[0]!;
  socket.open();
  await connected;
  return { transport, socket };
}
const pings = (s: Socket) => s.sent.filter((t) => t === PING).length;

describe("transport heartbeat", () => {
  it("pings after 20 s without outbound traffic; a pong within 10 s keeps the socket", async () => {
    const { transport, socket } = await openTransport();
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(pings(socket)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pings(socket)).toBe(1);
    socket.text(PONG);
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(pings(socket)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pings(socket)).toBe(2);
    expect(transport.state).toBe("open");
    expect(socket.closeCalls).toBe(0);
  });

  it("treats a missing pong as a half-open socket: reconnects even if the close handshake never finishes", async () => {
    const { transport, socket } = await openTransport();
    socket.silentClose = true;
    const states: string[] = [];
    transport.onState((s) => states.push(s));
    await vi.advanceTimersByTimeAsync(IDLE + PONG_WAIT - 1);
    expect(socket.closeCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.closeCalls).toBe(1);
    expect(transport.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(Socket.instances).toHaveLength(2);
    Socket.instances[1]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.state).toBe("open");
    expect(states).toEqual(["reconnecting", "open"]);
    // The abandoned socket's late close must not disturb the new one.
    socket.serverClose(1006);
    expect(transport.state).toBe("open");
    expect(Socket.instances[1]!.closeCalls).toBe(0);
  });

  it("counts outbound traffic as activity", async () => {
    const { transport, socket } = await openTransport();
    await vi.advanceTimersByTimeAsync(IDLE - 1_000);
    transport.beginSession("r1");
    transport.bindSession("r1", "session");
    transport.sendFrame("r1", { v: 1, kid: "session", seq: 1, msg: { jsonrpc: "2.0", method: "x" } });
    expect(socket.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(pings(socket)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pings(socket)).toBe(1);
  });

  it("pings a receive-only connection: inbound frames every 10 s do not defer the ping", async () => {
    const { transport, socket } = await openTransport();
    for (let t = 0; t < 70_000; t += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      socket.message({ type: "peer_gone", peer: "runner", runnerId: "r1" }, "r1", "control");
      if (socket.sent.at(-1) === PING) socket.text(PONG);
    }
    // 20 s, 40 s and 60 s of outbound silence: three pings in 70 s.
    expect(pings(socket)).toBe(3);
    expect(transport.state).toBe("open");
  });

  it("other inbound frames do not settle a pending ping: no pong still abandons the socket 10 s after it", async () => {
    const { transport, socket } = await openTransport();
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(pings(socket)).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    socket.message({ type: "peer_gone", peer: "runner", runnerId: "r1" }, "r1", "control");
    await vi.advanceTimersByTimeAsync(PONG_WAIT - 5_000 - 1);
    expect(socket.closeCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.closeCalls).toBe(1);
    expect(transport.state).toBe("reconnecting");
  });

  it("answers a ping with a pong, ignores a stray pong, and hands neither to the session code", async () => {
    const { transport, socket } = await openTransport();
    const seen = vi.fn();
    transport.onFrame(seen);
    transport.onPake(seen);
    transport.onControl(seen);
    transport.onPresence(seen);
    socket.text(PING);
    expect(socket.sent.filter((t) => t === PONG)).toHaveLength(1);
    socket.text(PONG);
    expect(socket.sent.filter((t) => t === PONG)).toHaveLength(1);
    expect(seen).not.toHaveBeenCalled();
    expect(transport.state).toBe("open");
  });

  it("stops the heartbeat with the transport and with a closed socket", async () => {
    const { transport, socket } = await openTransport();
    socket.serverClose(1006);
    await vi.advanceTimersByTimeAsync(IDLE * 3);
    expect(pings(socket)).toBe(0);
    transport.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not ping a transport that was closed while a pong was pending", async () => {
    const { transport, socket } = await openTransport();
    await vi.advanceTimersByTimeAsync(IDLE);
    transport.close();
    await vi.advanceTimersByTimeAsync(PONG_WAIT * 2);
    expect(vi.getTimerCount()).toBe(0);
    expect(transport.state).toBe("closed");
    expect(socket.closeCalls).toBe(1);
  });
});
