import { PairingError } from "@berdyh/bridge-pairing";
import { RELAY_CLOSE_REPLACED, RELAY_CLOSE_REVOKED, RELAY_SUBPROTOCOL, createPlainLayer } from "@berdyh/bridge-protocol";
import { channelFromLayer } from "@berdyh/bridge-runner";
import { describe, expect, it, vi } from "vitest";

import type { RelaySocket } from "./deps.js";
import { HEARTBEAT_IDLE_MS, STABLE_AFTER_WELCOME_MS, type AppLinkOptions, type LinkStatus, type LinkTimers, PONG_TIMEOUT_MS, backoffDelay, createAppLink } from "./link.js";

class FakeSocket implements RelaySocket {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closedWith: number | undefined;
  private listeners: Record<string, ((e: never) => void)[]> = {};
  constructor(readonly url: string, readonly init: { protocols: string[]; headers: Record<string, string> }) {}
  texts: string[] = [];
  send(data: string) { this.texts.push(data); if (!data.startsWith("bridge:")) this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(code?: number) { this.closedWith = code; this.readyState = 3; }
  addEventListener(type: string, listener: (e: never) => void) { (this.listeners[type] ??= []).push(listener); }
  emit(type: string, event?: unknown) { for (const l of this.listeners[type] ?? []) l(event as never); }
  open() { this.readyState = 1; this.emit("open"); }
  message(obj: unknown) { this.emit("message", { data: JSON.stringify(obj) }); }
  serverClose(code: number) { this.readyState = 3; this.emit("close", { code, reason: "" }); }
  welcome() { this.open(); this.message({ type: "welcome", protocol: 1 }); }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await tick(); expect(cond()).toBe(true); };

function rig(over: Partial<AppLinkOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const statuses: [LinkStatus, string | undefined][] = [];
  const sleeps: number[] = [];
  const channels: { closed: boolean }[] = [];
  const link = createAppLink({
    appId: "app-a",
    runnerId: "runner-1",
    relayUrl: "ws://relay.test/relay",
    runnerVersion: "9.9.9",
    getToken: async () => "tok",
    agents: async () => [{ id: "claude", available: true }],
    socket: (url, init) => { const s = new FakeSocket(url, init); sockets.push(s); return s; },
    demux: {
      makeChannel: (wire) => { const c = channelFromLayer(wire, createPlainLayer(wire.kid === undefined ? {} : { kid: wire.kid })); channels.push(c); return c; },
      attach: () => {},
      acceptEnrollment: () => {},
    },
    sleep: async (ms) => { sleeps.push(ms); await tick(); },
    random: () => 0.5,
    backoff: { baseMs: 100, maxMs: 1000 },
    onStatus: (s, d) => statuses.push([s, d]),
    ...over,
  });
  return { link, sockets, statuses, sleeps, channels };
}

describe("backoffDelay", () => {
  it("grows exponentially, is capped, and stays within its jitter band", () => {
    const b = { baseMs: 100, maxMs: 1000 };
    expect([0, 1, 2, 3, 4, 10].map((n) => backoffDelay(n, b, () => 1))).toEqual([100, 200, 400, 800, 1000, 1000]);
    expect([0, 1, 2, 10].map((n) => backoffDelay(n, b, () => 0))).toEqual([50, 100, 200, 500]);
  });
});

describe("connection", () => {
  it("dials the runner endpoint with the bearer token, sends hello first and is online after welcome", async () => {
    const r = rig();
    void r.link.start();
    await until(() => r.sockets.length === 1);
    const s = r.sockets[0]!;
    expect(s.url).toBe("ws://relay.test/relay/runner?runnerId=runner-1");
    expect(s.init.headers.authorization).toBe("Bearer tok");
    expect(s.init.protocols).toEqual([RELAY_SUBPROTOCOL]);
    s.open();
    expect(s.sent[0]).toMatchObject({
      type: "hello", runnerId: "runner-1", runnerVersion: "9.9.9", protocol: { min: 1, max: 1 },
      agents: [{ id: "claude", available: true }],
    });
    expect(r.link.status()).toBe("connecting");
    s.message({ type: "welcome", protocol: 1 });
    expect(r.link.status()).toBe("online");
    await r.link.stop();
    expect(r.link.status()).toBe("stopped");
    expect(s.closedWith).toBe(1000);
  });

  it("reconnects with growing, jittered delays after an ordinary close and resets after a welcome that stayed up", async () => {
    const clock = manualClock();
    const r = rig({ timers: clock });
    void r.link.start();
    for (let i = 1; i <= 3; i++) {
      await until(() => r.sockets.length === i);
      r.sockets[i - 1]!.open();
      r.sockets[i - 1]!.serverClose(1006);
    }
    await until(() => r.sockets.length === 4);
    expect(r.sleeps).toEqual([75, 150, 300]);
    r.sockets[3]!.welcome();
    clock.advance(STABLE_AFTER_WELCOME_MS);
    r.sockets[3]!.serverClose(1006);
    await until(() => r.sockets.length === 5);
    expect(r.sleeps.at(-1)).toBe(75);
    await r.link.stop();
  });

  it("an error before the socket opened ends the attempt at once, with no wait for a close that Node 22 never fires", async () => {
    const clock = manualClock();
    const r = rig({ timers: clock });
    void r.link.start();
    await until(() => r.sockets.length === 1);
    // Node 22: a 403 at the upgrade fires `error` and nothing else. No timer advance: the 15 s connect timer must not be needed.
    r.sockets[0]!.emit("error", {});
    await until(() => r.sockets.length === 2);
    expect(r.sleeps).toEqual([75]);
    expect(r.sockets[0]!.closedWith).toBe(1000);
    await r.link.stop();
  });

  it("closing a socket that is still connecting (the connect timer) may fire an error from inside close(), as on Node 22: one attempt, no recursion", async () => {
    const clock = manualClock();
    const r = rig({ timers: clock });
    void r.link.start();
    await until(() => r.sockets.length === 1);
    const s = r.sockets[0]!;
    let closes = 0;
    const close = s.close.bind(s);
    s.close = (code?: number) => { closes += 1; close(code); s.emit("error", {}); };
    clock.advance(15_001);
    await until(() => r.sockets.length === 2);
    expect(closes).toBe(1);
    expect(r.sleeps).toEqual([75]);
    await r.link.stop();
  });

  it("an error before open followed by a close (Node 24+) is one attempt, not two", async () => {
    const clock = manualClock();
    const r = rig({ timers: clock });
    void r.link.start();
    await until(() => r.sockets.length === 1);
    r.sockets[0]!.emit("error", {});
    r.sockets[0]!.serverClose(1006);
    await until(() => r.sockets.length === 2);
    await tick();
    await tick();
    expect(r.sockets.length).toBe(2);
    expect(r.sleeps).toEqual([75]);
    await r.link.stop();
  });

  it("an error after the socket opened still waits for its close", async () => {
    const r = rig({ timers: manualClock() });
    void r.link.start();
    await until(() => r.sockets.length === 1);
    r.sockets[0]!.open();
    r.sockets[0]!.emit("error", {});
    await tick();
    await tick();
    expect(r.sockets.length).toBe(1);
    r.sockets[0]!.serverClose(1006);
    await until(() => r.sockets.length === 2);
    await r.link.stop();
  });

  it("reconnects with a fresh token after the relay's max-age close (1012)", async () => {
    const getToken = vi.fn(async () => `tok${getToken.mock.calls.length}`);
    const r = rig({ getToken });
    void r.link.start();
    await until(() => r.sockets.length === 1);
    r.sockets[0]!.welcome();
    r.sockets[0]!.serverClose(1012);
    await until(() => r.sockets.length === 2);
    expect(r.sockets[1]!.init.headers.authorization).toBe("Bearer tok2");
    expect(r.link.status()).not.toBe("replaced");
    r.sockets[1]!.welcome();
    expect(r.link.status()).toBe("online");
    await r.link.stop();
  });

  it("stop() interrupts a token fetch that hangs, through the signal it was given", async () => {
    const r = rig({
      getToken: (signal) => new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    const running = r.link.start();
    await tick();
    await r.link.stop();
    await running;
    expect(r.sockets).toHaveLength(0);
    expect(r.link.status()).toBe("stopped");
  });

  it("keeps backing off when the server welcomes and then closes at once", async () => {
    const clock = manualClock();
    const r = rig({ timers: clock });
    void r.link.start();
    for (let i = 1; i <= 4; i++) {
      await until(() => r.sockets.length === i);
      r.sockets[i - 1]!.welcome();
      clock.advance(STABLE_AFTER_WELCOME_MS - 1);
      r.sockets[i - 1]!.serverClose(1006);
    }
    await until(() => r.sleeps.length === 4);
    expect(r.sleeps).toEqual([75, 150, 300, 600]);
    await r.link.stop();
  });

  it("stops this app and reports it when the current socket is replaced by another process (4409)", async () => {
    const r = rig();
    void r.link.start();
    await until(() => r.sockets.length === 1);
    r.sockets[0]!.welcome();
    const close = vi.spyOn(r.link.demux, "close");
    r.sockets[0]!.serverClose(RELAY_CLOSE_REPLACED);
    await r.link.start();
    expect(r.link.status()).toBe("replaced");
    expect(close).toHaveBeenCalledWith("replaced");
    expect(r.statuses.at(-1)![1]).toContain("another process");
    await tick();
    expect(r.sockets).toHaveLength(1);
  });

  it("ignores a 4409 on a socket it already replaced with its own reconnect", async () => {
    const r = rig();
    void r.link.start();
    await until(() => r.sockets.length === 1);
    const first = r.sockets[0]!;
    first.welcome();
    // A sequence gap makes the manager abandon the socket without waiting for its close handshake.
    first.message({ to: "runner", runnerId: "runner-1", browserKeyId: "b1", kind: "frame", body: { v: 1, kid: "k", seq: 1, msg: { jsonrpc: "2.0", method: "x" } } });
    first.message({ to: "runner", runnerId: "runner-1", browserKeyId: "b1", kind: "frame", body: { v: 1, kid: "k", seq: 3, msg: { jsonrpc: "2.0", method: "x" } } });
    await until(() => r.sockets.length === 2);
    r.sockets[1]!.welcome();
    expect(r.link.status()).toBe("online");
    // The relay closes the old socket as replaced by the new one: stale news.
    first.serverClose(RELAY_CLOSE_REPLACED);
    await tick();
    expect(r.link.status()).toBe("online");
    expect(r.sockets).toHaveLength(2);
    await r.link.stop();
  });

  it("parks the app on update_required and does not retry", async () => {
    const r = rig();
    void r.link.start();
    await until(() => r.sockets.length === 1);
    r.sockets[0]!.open();
    const close = vi.spyOn(r.link.demux, "close");
    r.sockets[0]!.message({ to: "runner", runnerId: "runner-1", kind: "control", body: { type: "update_required", server: { min: 2, max: 3 }, message: "update the runner" } });
    await r.link.start();
    expect(r.link.status()).toBe("update_required");
    expect(close).toHaveBeenCalledWith("update_required");
    expect(r.statuses.at(-1)![1]).toBe("update the runner");
    expect(r.sockets).toHaveLength(1);
  });

  it("strips control characters from a server-supplied terminal detail and caps its length", async () => {
    const r = rig();
    void r.link.start();
    await until(() => r.sockets.length === 1);
    r.sockets[0]!.open();
    const message = `update\r\u001b[2K the runner${"x".repeat(1000)}`;
    r.sockets[0]!.message({ to: "runner", runnerId: "runner-1", kind: "control", body: { type: "update_required", server: { min: 2, max: 3 }, message } });
    await r.link.start();
    const detail = r.statuses.at(-1)![1]!;
    expect(detail).not.toMatch(/[\u001b\r\n]/);
    expect(detail.startsWith("update[2K the runner")).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(300);
  });

  it("does not retry a revoked device (4401)", async () => {
    const r = rig();
    void r.link.start();
    await until(() => r.sockets.length === 1);
    r.sockets[0]!.welcome();
    r.sockets[0]!.serverClose(RELAY_CLOSE_REVOKED);
    await r.link.start();
    expect(r.link.status()).toBe("revoked");
    expect(r.sockets).toHaveLength(1);
  });

  it("stops retrying when the credential is gone and asks for a new pairing", async () => {
    const r = rig({ getToken: async () => { throw new PairingError("no_refresh_token", "no stored credentials"); } });
    await r.link.start();
    expect(r.link.status()).toBe("auth_failed");
    expect(r.statuses.at(-1)![1]).toContain("bridge connect");
    expect(r.sockets).toHaveLength(0);
  });

  it("retries when the token endpoint is merely unreachable", async () => {
    let calls = 0;
    const r = rig({ getToken: async () => { if (++calls < 3) throw new PairingError("network_error", "offline"); return "tok"; } });
    void r.link.start();
    await until(() => r.sockets.length === 1);
    expect(calls).toBe(3);
    await r.link.stop();
  });

  it("ends handshakes and enrollments with the socket but keeps established sessions, and resends on the next welcome", async () => {
    const r = rig();
    void r.link.start();
    await until(() => r.sockets.length === 1);
    const s = r.sockets[0]!;
    s.welcome();
    s.message({ to: "runner", runnerId: "runner-1", browserKeyId: "b1", kind: "frame", body: { v: 1, kid: "kid1", seq: 1, msg: { jsonrpc: "2.0", method: "x" } } });
    await tick();
    expect(r.channels).toHaveLength(1);
    s.serverClose(1006);
    await until(() => r.sockets.length === 2);
    expect(r.channels[0]!.closed).toBe(false);
    await r.link.stop();
    expect(r.channels[0]!.closed).toBe(true);
  });

  it("stop() during the agents lookup opens no socket and resolves", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const r = rig({ agents: async () => { await gate; return []; } });
    const running = r.link.start();
    await tick();
    const stopping = r.link.stop();
    release();
    await stopping;
    await running;
    expect(r.sockets).toHaveLength(0);
  });
});

describe("handshake timers", () => {
  it("do not close a healthy, welcomed socket after the connect and welcome windows", async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      void r.link.start();
      await vi.waitFor(() => expect(r.sockets.length).toBe(1));
      r.sockets[0]!.welcome();
      expect(r.link.status()).toBe("online");
      // A live server answers the heartbeat pings; only the handshake windows are under test here.
      for (let i = 0; i < 12; i++) {
        await vi.advanceTimersByTimeAsync(5_000);
        if (r.sockets[0]!.texts.at(-1) === "bridge:ping") r.sockets[0]!.emit("message", { data: "bridge:pong" });
      }
      expect(r.link.status()).toBe("online");
      expect(r.sockets).toHaveLength(1);
      expect(r.sockets[0]!.closedWith).toBeUndefined();
      await r.link.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A manual clock: nothing fires until `advance`. */
function manualClock(): LinkTimers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    set(fn, ms) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clear(handle) { timers.delete(handle as number); },
    pending: () => timers.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = end;
    },
  };
}

describe("heartbeat", () => {
  const PING = "bridge:ping";
  const PONG = "bridge:pong";
  const pingsOf = (s: FakeSocket) => s.texts.filter((t) => t === PING).length;
  const envelope = { to: "runner", runnerId: "runner-1", browserKeyId: "b1", kind: "frame", body: { v: 1, kid: "k", seq: 1, msg: { jsonrpc: "2.0", method: "x" } } };

  async function online(over: Partial<AppLinkOptions> = {}) {
    const clock = manualClock();
    const r = rig({ timers: clock, ...over });
    void r.link.start();
    await until(() => r.sockets.length === 1);
    r.sockets[0]!.welcome();
    return { ...r, clock, s: r.sockets[0]! };
  }

  it("pings after 20 s without outbound traffic, and a pong within 10 s keeps the socket", async () => {
    const r = await online();
    r.clock.advance(HEARTBEAT_IDLE_MS - 1);
    expect(pingsOf(r.s)).toBe(0);
    r.clock.advance(1);
    expect(pingsOf(r.s)).toBe(1);
    r.s.emit("message", { data: PONG });
    r.clock.advance(HEARTBEAT_IDLE_MS - 1);
    expect(pingsOf(r.s)).toBe(1);
    // The pong re-armed the idle timer: the next ping is due 20 s after it.
    r.clock.advance(1);
    expect(pingsOf(r.s)).toBe(2);
    expect(r.s.closedWith).toBeUndefined();
    expect(r.link.status()).toBe("online");
    await r.link.stop();
  });

  it("abandons a half-open socket when no pong comes within 10 s and reconnects", async () => {
    const r = await online();
    r.clock.advance(HEARTBEAT_IDLE_MS);
    r.clock.advance(PONG_TIMEOUT_MS - 1);
    expect(r.s.closedWith).toBeUndefined();
    r.clock.advance(1);
    expect(r.s.closedWith).toBe(1000);
    await until(() => r.sockets.length === 2);
    expect(r.link.status()).not.toBe("online");
    r.sockets[1]!.welcome();
    expect(r.link.status()).toBe("online");
    await r.link.stop();
  });

  it("counts outbound traffic as activity: sending defers the ping", async () => {
    const r = await online();
    r.clock.advance(HEARTBEAT_IDLE_MS - 1000);
    r.link.demux.handle(envelope as never);
    // The demux acks the frame: outbound traffic, so the idle window starts over.
    expect(r.s.sent.some((m) => m.kind === "frame")).toBe(true);
    r.clock.advance(HEARTBEAT_IDLE_MS - 1);
    expect(pingsOf(r.s)).toBe(0);
    r.clock.advance(1);
    expect(pingsOf(r.s)).toBe(1);
    await r.link.stop();
  });

  it("pings a receive-only connection: inbound frames every 10 s do not defer the ping", async () => {
    const r = await online();
    const control = { to: "runner", runnerId: "runner-1", kind: "control", body: { type: "peer_gone", peer: "browser", runnerId: "runner-1", browserKeyId: "nobody" } };
    for (let t = 0; t < 70_000; t += 10_000) {
      r.clock.advance(10_000);
      r.s.message(control);
      // A live server answers a ping at once, which is inbound too.
      if (r.s.texts.at(-1) === PING) r.s.emit("message", { data: PONG });
    }
    // 20 s, 40 s and 60 s of outbound silence: three pings in 70 s.
    expect(pingsOf(r.s)).toBe(3);
    expect(r.s.closedWith).toBeUndefined();
    await r.link.stop();
  });

  it("other inbound frames do not settle a pending ping: no pong still abandons the socket 10 s after it", async () => {
    const r = await online();
    r.clock.advance(HEARTBEAT_IDLE_MS);
    expect(pingsOf(r.s)).toBe(1);
    r.clock.advance(5_000);
    r.s.message({ to: "runner", runnerId: "runner-1", kind: "control", body: { type: "peer_gone", peer: "browser", runnerId: "runner-1", browserKeyId: "nobody" } });
    r.clock.advance(PONG_TIMEOUT_MS - 5_000 - 1);
    expect(r.s.closedWith).toBeUndefined();
    r.clock.advance(1);
    expect(r.s.closedWith).toBe(1000);
    await r.link.stop();
  });

  it("answers an inbound ping with a pong, ignores an unsolicited pong, and never hands either to the demux", async () => {
    const handled: unknown[] = [];
    const r = await online();
    const handle = vi.spyOn(r.link.demux, "handle").mockImplementation((e) => void handled.push(e));
    r.s.emit("message", { data: PING });
    expect(r.s.texts.filter((t) => t === PONG)).toHaveLength(1);
    r.s.emit("message", { data: PONG });
    expect(r.s.texts.filter((t) => t === PONG)).toHaveLength(1);
    expect(handle).not.toHaveBeenCalled();
    expect(r.link.status()).toBe("online");
    await r.link.stop();
  });

  it("answers a ping that arrives before the welcome too, without treating it as a handshake", async () => {
    const clock = manualClock();
    const r = rig({ timers: clock });
    void r.link.start();
    await until(() => r.sockets.length === 1);
    const s = r.sockets[0]!;
    s.open();
    s.emit("message", { data: PING });
    expect(s.texts).toContain(PONG);
    expect(r.link.status()).toBe("connecting");
    await r.link.stop();
  });

  it("starts no heartbeat before the welcome and leaves no timer behind after stop", async () => {
    const clock = manualClock();
    const r = rig({ timers: clock });
    void r.link.start();
    await until(() => r.sockets.length === 1);
    const s = r.sockets[0]!;
    s.open();
    clock.advance(14_999); // inside the welcome window: no ping, whatever the idle time
    expect(pingsOf(s)).toBe(0);
    await r.link.stop();
    expect(clock.pending()).toBe(0);
  });

  it("stops pinging a closed socket and starts over on the next one", async () => {
    const r = await online();
    r.s.serverClose(1006);
    await until(() => r.sockets.length === 2);
    r.sockets[1]!.welcome();
    r.clock.advance(HEARTBEAT_IDLE_MS);
    expect(pingsOf(r.sockets[1]!)).toBe(1);
    expect(pingsOf(r.s)).toBe(0);
    await r.link.stop();
    expect(r.clock.pending()).toBe(0);
  });
});

describe("handshake delivery before close", () => {
  it("delivers every handshake message queued before close(), in order, for an enrollment and a session", async () => {
    const done = { t: "pake/done", v: 1, enrollId: "enr1", ok: true, browserKeyId: "kk", proof: "extra-field-from-t08" };
    const reply = { t: "pake/reply", v: 1, enrollId: "enr1", codeId: "c", msg: "bXNn", mac: "bWFj", sealed: { nonce: "bm9uY2U", ct: "Y3Q" }, note: "unknown field" };
    const r = rig({
      demux: {
        makeChannel: (wire) => {
          // A session wire: accept, then close straight away.
          wire.handshake.send({ t: "session/accept", v: 1, sid: "c2lk", eph: "ZXBo" });
          wire.close("revoked");
          return channelFromLayer(wire, createPlainLayer({}));
        },
        attach: () => {},
        acceptEnrollment: (wire) => {
          wire.handshake.send(reply as never);
          wire.handshake.send(done as never);
          wire.close();
        },
      },
    });
    void r.link.start();
    await until(() => r.sockets.length === 1);
    const s = r.sockets[0]!;
    s.welcome();
    s.message({ to: "runner", runnerId: "runner-1", browserKeyId: "enr1", kind: "pake", body: { t: "pake/start", v: 1, enrollId: "enr1", msg: "bXNn" } });
    const bodies = s.sent.filter((m) => m.kind === "pake").map((m) => m.body);
    // Bodies pass through unmodified, unknown fields included.
    expect(bodies).toEqual([reply, done]);
    s.message({ to: "runner", runnerId: "runner-1", browserKeyId: "b2", kind: "pake", body: { t: "session/init", v: 1, sid: "c2lk", eph: "ZXBo" } });
    const later = s.sent.filter((m) => m.kind === "pake").slice(2).map((m) => m.body);
    // accept first, then the close: a non-standard reason ("revoked") reaches the browser as a valid one.
    expect(later[0]).toEqual({ t: "session/accept", v: 1, sid: "c2lk", eph: "ZXBo" });
    expect(later[1]).toEqual({ t: "session/close", v: 1, sid: "c2lk", reason: "error" });
    await r.link.stop();
  });
});
