import { createPlainLayer, HANDSHAKE_TIMEOUT_MS, PENDING_FRAMES_MAX, type ChannelLayer, type PakeMessage, type PakeStart, type RelayEnvelope, type SequencedFrame } from "@berdyh/bridge-protocol";
import { channelFromLayer, type BrowserChannel, type EnrollmentWire, type RunnerWire } from "@berdyh/bridge-runner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDemux } from "./demux.js";

afterEach(() => {
  vi.useRealTimers();
});

const RUNNER = "runner-1";
const msg = (n: number) => ({ jsonrpc: "2.0" as const, method: "ping", params: { n } });
const frame = (kid: string, seq: number, n = seq): SequencedFrame => ({ v: 1, kid, seq, msg: msg(n) });
const toRunner = (browserKeyId: string, kind: "frame" | "pake", body: unknown): RelayEnvelope => ({ to: "runner", runnerId: RUNNER, browserKeyId, kind, body });
const control = (body: unknown): RelayEnvelope => ({ to: "runner", runnerId: RUNNER, kind: "control", body });

function rig(options: { grace?: number; layerKid?: string; gate?: Promise<void> } = {}) {
  const peers: [string, boolean][] = [];
  const sent: RelayEnvelope[] = [];
  const faults: string[] = [];
  const channels: { channel: BrowserChannel; wire: RunnerWire; got: unknown[]; closed: string[] }[] = [];
  const enrollments: { wire: EnrollmentWire; start: PakeStart; got: PakeMessage[]; closed: string[] }[] = [];
  let online = true;
  const demux = createDemux({
    appId: "app-a",
    runnerId: RUNNER,
    transmit(envelope) {
      if (!online) return false;
      sent.push(envelope);
      return true;
    },
    faultSocket: (reason) => void faults.push(reason),
    makeChannel(wire) {
      const plain = createPlainLayer(options.layerKid ? { kid: options.layerKid } : wire.kid === undefined ? {} : { kid: wire.kid });
      // `gate` holds the handshake open, the way the encrypted layer's trust lookup does.
      const layer: ChannelLayer = options.gate
        ? { kind: plain.kind, get kid() { return plain.kid; }, start: async (io) => { await options.gate; return plain.start(io); }, seal: (m) => plain.seal(m), open: (f) => plain.open(f), close: () => plain.close() }
        : plain;
      const channel = channelFromLayer(wire, layer);
      const entry = { channel, wire, got: [] as unknown[], closed: [] as string[] };
      channel.onMessage((m) => entry.got.push(m));
      channel.onClose((r) => entry.closed.push(r ?? ""));
      channels.push(entry);
      return channel;
    },
    attach: () => {},
    acceptEnrollment(wire, start) {
      const entry = { wire, start, got: [] as PakeMessage[], closed: [] as string[] };
      wire.handshake.onMessage((m) => entry.got.push(m));
      wire.onClose((r) => entry.closed.push(r ?? ""));
      enrollments.push(entry);
    },
    onPeer: (id, present) => void peers.push([id, present]),
    ...(options.grace !== undefined ? { peerGoneGraceMs: options.grace } : {}),
  });
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    demux, sent, faults, channels, enrollments, flush, peers,
    setOnline: (v: boolean) => (online = v),
    framesTo: (id: string) => sent.filter((e) => e.kind === "frame" && e.browserKeyId === id).map((e) => e.body as Record<string, unknown>),
    pakesTo: (id: string) => sent.filter((e) => e.kind === "pake" && e.browserKeyId === id).map((e) => e.body as PakeMessage),
  };
}

describe("data frames", () => {
  it("creates a channel for the first frame of a session, delivers in order, acks cumulatively and re-acks duplicates", async () => {
    const r = rig();
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 1)));
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 2)));
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 2)));
    await r.flush();
    expect(r.channels).toHaveLength(1);
    expect(r.channels[0]!.channel.browserKeyId).toBe("b1");
    expect(r.channels[0]!.got).toEqual([msg(1), msg(2)]);
    expect(r.framesTo("b1")).toEqual([{ v: 1, kid: "kid1", ack: 1 }, { v: 1, kid: "kid1", ack: 2 }, { v: 1, kid: "kid1", ack: 2 }]);
    expect(r.faults).toEqual([]);
  });

  it("closes the socket on a gap, and only then", async () => {
    const r = rig();
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 1)));
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 3)));
    expect(r.faults).toEqual(["sequence gap"]);
    r.faults.length = 0;
    r.demux.handle(toRunner("b1", "frame", frame("other", 7)));
    expect(r.faults).toEqual([]);
  });

  it("a newer session of the same browser supersedes the old one and tells it so", async () => {
    const r = rig();
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 1)));
    r.demux.handle(toRunner("b1", "frame", frame("kid2", 1)));
    await r.flush();
    expect(r.channels).toHaveLength(2);
    expect(r.channels[0]!.closed).toEqual(["superseded"]);
    expect(r.pakesTo("b1")).toContainEqual({ t: "session/close", v: 1, kid: "kid1", reason: "superseded" });
    expect(r.channels[1]!.got).toEqual([msg(1)]);
    // The retired session cannot come back: its frames draw a scoped close, once per socket connection.
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 2)));
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 3)));
    const closes = r.pakesTo("b1").filter((p) => p.t === "session/close" && p.reason === "unknown_session");
    expect(closes).toEqual([{ t: "session/close", v: 1, kid: "kid1", reason: "unknown_session" }]);
    expect(r.channels).toHaveLength(2);
    // A browser that reconnects may have lost that reply, so it gets another.
    r.demux.handle(control({ type: "peer_reconnected", peer: "browser", runnerId: RUNNER, browserKeyId: "b1" }));
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 4)));
    expect(r.pakesTo("b1").filter((p) => p.t === "session/close" && p.reason === "unknown_session")).toHaveLength(2);
  });

  it("answers a frame of a session it never had with unknown_session and creates nothing", () => {
    const r = rig();
    r.demux.handle(toRunner("b1", "frame", frame("lost", 5)));
    expect(r.channels).toHaveLength(0);
    expect(r.pakesTo("b1")).toEqual([{ t: "session/close", v: 1, kid: "lost", reason: "unknown_session" }]);
  });

  it("an invalid sequence fails only that session, never the socket or another browser", async () => {
    const r = rig();
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 1)));
    r.demux.handle(toRunner("b2", "frame", frame("kidB", 1)));
    expect(() => r.demux.handle(toRunner("b1", "frame", { v: 1, kid: "kid1", seq: 1e300, msg: msg(0) }))).not.toThrow();
    await r.flush();
    expect(r.channels[0]!.channel.closed).toBe(true);
    expect(r.channels[1]!.channel.closed).toBe(false);
    expect(r.faults).toEqual([]);
    r.demux.handle(toRunner("b2", "frame", frame("kidB", 2)));
    await r.flush();
    expect(r.channels[1]!.got).toEqual([msg(1), msg(2)]);
  });

  it("ignores malformed envelopes without throwing", () => {
    const r = rig();
    for (const body of [null, "x", { v: 1 }, { v: 1, kid: "k", seq: 0, msg: msg(0) }, { v: 1, kid: "k", seq: -1, msg: msg(0) }]) {
      expect(() => r.demux.handle(toRunner("b1", "frame", body))).not.toThrow();
    }
    expect(() => r.demux.handle({ to: "runner", runnerId: RUNNER, kind: "frame", body: frame("k", 1) })).not.toThrow();
    expect(r.channels).toHaveLength(0);
  });
});

describe("outgoing frames", () => {
  it("retains them until acked and resends in order on reconnect and on peer_reconnected", async () => {
    const r = rig();
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 1)));
    await r.flush();
    const { channel } = r.channels[0]!;
    channel.send(msg(10));
    channel.send(msg(11));
    await r.flush();
    const out = () => r.framesTo("b1").filter((f) => "seq" in f).map((f) => f.seq);
    expect(out()).toEqual([1, 2]);

    r.sent.length = 0;
    r.demux.socketOpened();
    expect(out()).toEqual([1, 2]);

    r.sent.length = 0;
    r.demux.handle(toRunner("b1", "frame", { v: 1, kid: "kid1", ack: 1 }));
    r.demux.handle(control({ type: "peer_reconnected", peer: "browser", runnerId: RUNNER, browserKeyId: "b1" }));
    expect(out()).toEqual([2]);
    // Byte-identical: the very frames that were first sent.
    r.demux.handle(toRunner("b1", "frame", { v: 1, kid: "kid1", ack: 2 }));
    r.sent.length = 0;
    r.demux.handle(control({ type: "peer_reconnected", peer: "browser", runnerId: RUNNER, browserKeyId: "b1" }));
    expect(out()).toEqual([]);
  });

  it("keeps frames sent while the socket is down and sends them when it is back", async () => {
    const r = rig();
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 1)));
    await r.flush();
    r.setOnline(false);
    r.channels[0]!.channel.send(msg(20));
    await r.flush();
    r.setOnline(true);
    r.sent.length = 0;
    r.demux.socketOpened();
    expect(r.framesTo("b1")).toEqual([expect.objectContaining({ kid: "kid1", seq: 1, msg: msg(20) })]);
  });

  it("an ack for frames never sent ends the session", async () => {
    const r = rig();
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 1)));
    await r.flush();
    r.channels[0]!.channel.send(msg(1));
    await r.flush();
    r.demux.handle(toRunner("b1", "frame", { v: 1, kid: "kid1", ack: 9 }));
    await r.flush();
    expect(r.channels[0]!.channel.closed).toBe(true);
  });
});

describe("session lifecycle", () => {
  it("a session/close from the browser closes the channel and is not echoed", async () => {
    const r = rig();
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 1)));
    await r.flush();
    r.sent.length = 0;
    r.demux.handle(toRunner("b1", "pake", { t: "session/close", v: 1, kid: "other", reason: "closed" }));
    expect(r.channels[0]!.channel.closed).toBe(false);
    r.demux.handle(toRunner("b1", "pake", { t: "session/close", v: 1, kid: "kid1", reason: "closed" }));
    expect(r.channels[0]!.closed).toEqual(["peer closed"]);
    expect(r.pakesTo("b1")).toEqual([]);
  });

  it("closing a channel from the runner side tells the browser", async () => {
    const r = rig();
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 1)));
    await r.flush();
    r.channels[0]!.channel.close("proxy closed");
    expect(r.pakesTo("b1")).toEqual([{ t: "session/close", v: 1, kid: "kid1", reason: "closed" }]);
    r.channels[0]!.channel.close("proxy closed");
    expect(r.pakesTo("b1")).toHaveLength(1);
  });

  it("session/init creates a pending wire with the first message delivered, and the first data frame binds it", async () => {
    const r = rig({ layerKid: "kid-s" });
    const seen: PakeMessage[] = [];
    const sentinel = { t: "session/init", v: 1, sid: "sid1", eph: "ZXBo" } as const;
    r.demux.handle(toRunner("b1", "pake", sentinel));
    expect(r.channels).toHaveLength(1);
    expect(r.channels[0]!.wire.sid).toBe("sid1");
    r.channels[0]!.wire.handshake.onMessage((m) => seen.push(m));
    await r.flush();
    expect(r.channels[0]!.wire.kid).toBe("kid-s");

    r.demux.handle(toRunner("b1", "frame", frame("kid-s", 1)));
    await r.flush();
    expect(r.channels).toHaveLength(1);
    expect(r.channels[0]!.got).toEqual([msg(1)]);

    // A pending wire is closed by sid; a close for another sid or kid leaves it alone.
    const r2 = rig({ layerKid: "never" });
    r2.demux.handle(toRunner("b2", "pake", { t: "session/init", v: 1, sid: "sidX", eph: "ZXBo" }));
    r2.demux.handle(toRunner("b2", "pake", { t: "session/close", v: 1, sid: "other" }));
    await r2.flush();
    expect(r2.channels[0]!.channel.closed).toBe(false);
    r2.demux.handle(toRunner("b2", "pake", { t: "session/init", v: 1, sid: "sidY", eph: "ZXBo" }));
    expect(r2.channels).toHaveLength(2);
    expect(r2.channels[0]!.closed).toEqual(["superseded"]);
    expect(r2.pakesTo("b2")).toContainEqual({ t: "session/close", v: 1, kid: "never", reason: "superseded" });
  });
});

describe("pending wire binding", () => {
  it("drops a frame injected with another kid after bindSession; the real first frame still binds, nothing is superseded", async () => {
    const r = rig({ layerKid: "kid-real" });
    r.demux.handle(toRunner("b1", "pake", { t: "session/init", v: 1, sid: "sid1", eph: "ZXBo" }));
    await r.flush();
    expect(r.channels[0]!.wire.kid).toBe("kid-real");
    // A relay injects a frame with an unseen kid and seq 1.
    r.demux.handle(toRunner("b1", "frame", frame("kid-junk", 1)));
    await r.flush();
    expect(r.channels).toHaveLength(1);
    expect(r.channels[0]!.closed).toEqual([]);
    expect(r.channels[0]!.got).toEqual([]);
    expect(r.framesTo("b1")).toEqual([]);
    expect(r.faults).toEqual([]);
    r.demux.handle(toRunner("b1", "frame", frame("kid-real", 1)));
    await r.flush();
    expect(r.channels).toHaveLength(1);
    expect(r.channels[0]!.closed).toEqual([]);
    expect(r.channels[0]!.got).toEqual([msg(1)]);
    expect(r.framesTo("b1")).toEqual([{ v: 1, kid: "kid-real", ack: 1 }]);
  });
});

describe("enrollment", () => {
  const start = (id: string): PakeStart => ({ t: "pake/start", v: 1, enrollId: id, msg: "bXNn" });

  it("pake/start opens an EnrollmentWire, never a channel, and hands over the first message", () => {
    const r = rig();
    r.demux.handle(toRunner("enr1", "pake", start("enr1")));
    expect(r.channels).toHaveLength(0);
    expect(r.enrollments).toHaveLength(1);
    expect(r.enrollments[0]!.start).toEqual(start("enr1"));
    expect(r.enrollments[0]!.wire.enrollId).toBe("enr1");
    expect(r.demux.counts()).toEqual({ sessions: 0, enrollments: 1 });
  });

  it("routes pake/confirm to the wire, addresses replies to the enrollId and closes the wire after pake/done", () => {
    const r = rig();
    r.demux.handle(toRunner("enr1", "pake", start("enr1")));
    const e = r.enrollments[0]!;
    r.demux.handle(toRunner("enr1", "pake", { t: "pake/confirm", v: 1, enrollId: "enr1", codeId: "c", mac: "bWFj", sealed: { nonce: "bm9uY2U", ct: "Y3Q" } }));
    expect(e.got.map((m) => m.t)).toEqual(["pake/confirm"]);
    e.wire.handshake.send({ t: "pake/done", v: 1, enrollId: "enr1", ok: true, browserKeyId: "kk" });
    expect(r.pakesTo("enr1")).toEqual([{ t: "pake/done", v: 1, enrollId: "enr1", ok: true, browserKeyId: "kk" }]);
    expect(e.wire.closed).toBe(true);
    expect(r.demux.counts().enrollments).toBe(0);
  });

  it("throws from pake/done when the result could not be transmitted, and still closes the wire", () => {
    const r = rig();
    r.demux.handle(toRunner("enr1", "pake", start("enr1")));
    const e = r.enrollments[0]!;
    r.setOnline(false);
    expect(() => e.wire.handshake.send({ t: "pake/done", v: 1, enrollId: "enr1", ok: true, browserKeyId: "kk" })).toThrow(/could not be sent/);
    expect(e.wire.closed).toBe(true);
    expect(e.closed).toEqual(["undelivered"]);
    expect(r.demux.counts().enrollments).toBe(0);
  });

  it("a second pake/start from the same id replaces the first; a mismatched id is dropped", () => {
    const r = rig();
    r.demux.handle(toRunner("enr1", "pake", start("enr1")));
    r.demux.handle(toRunner("enr1", "pake", start("enr1")));
    expect(r.enrollments).toHaveLength(2);
    expect(r.enrollments[0]!.closed).toEqual(["superseded"]);
    r.demux.handle(toRunner("enr1", "pake", start("someone-else")));
    expect(r.enrollments).toHaveLength(2);
  });

  it("an enrollment ends when its socket drops or its browser goes away", () => {
    const r = rig();
    r.demux.handle(toRunner("enr1", "pake", start("enr1")));
    r.demux.handle(toRunner("enr2", "pake", start("enr2")));
    r.demux.handle(control({ type: "peer_gone", peer: "browser", runnerId: RUNNER, browserKeyId: "enr1" }));
    expect(r.enrollments[0]!.closed).toEqual(["peer_gone"]);
    r.demux.socketLost();
    expect(r.enrollments[1]!.closed).toEqual(["socket lost"]);
  });

  it("a failing acceptEnrollment closes only that wire", async () => {
    const wires: EnrollmentWire[] = [];
    const demux = createDemux({
      appId: "app-a", runnerId: RUNNER, transmit: () => true, faultSocket: () => {},
      makeChannel: () => { throw new Error("no"); }, attach: () => {},
      acceptEnrollment: async (wire) => { wires.push(wire); throw new Error("boom"); },
    });
    demux.handle(toRunner("enr1", "pake", start("enr1")));
    await new Promise((r) => setTimeout(r, 0));
    expect(wires[0]!.closed).toBe(true);
  });
});

describe("presence", () => {
  it("closes a session whose browser stays away past the grace, but not one that comes back", async () => {
    vi.useFakeTimers();
    const r = rig({ grace: 1000 });
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 1)));
    r.demux.handle(toRunner("b2", "frame", frame("kidB", 1)));
    r.demux.handle(control({ type: "peer_gone", peer: "browser", runnerId: RUNNER, browserKeyId: "b1" }));
    r.demux.handle(control({ type: "peer_gone", peer: "browser", runnerId: RUNNER, browserKeyId: "b2" }));
    await vi.advanceTimersByTimeAsync(500);
    r.demux.handle(control({ type: "peer_reconnected", peer: "browser", runnerId: RUNNER, browserKeyId: "b2" }));
    await vi.advanceTimersByTimeAsync(600);
    expect(r.channels[0]!.closed).toEqual(["peer_gone"]);
    expect(r.channels[1]!.channel.closed).toBe(false);
    expect(r.pakesTo("b1")).toContainEqual({ t: "session/close", v: 1, kid: "kid1", reason: "peer_gone" });
  });

  it("a lost socket ends sessions still in handshake but keeps established ones for the resend", async () => {
    const r = rig({ layerKid: "kid-s" });
    r.demux.handle(toRunner("b1", "frame", frame("kid-s", 1)));
    r.demux.handle(toRunner("b2", "pake", { t: "session/init", v: 1, sid: "sidZ", eph: "ZXBo" }));
    await r.flush();
    r.demux.socketLost();
    // b2's wire is bound by now (plain layer starts at once), so both survive.
    expect(r.channels[0]!.channel.closed).toBe(false);
    r.demux.close();
    expect(r.channels.every((c) => c.channel.closed)).toBe(true);
  });
});

describe("close reasons", () => {
  it("passes not_trusted through to the browser, scoped by sid before a kid exists", async () => {
    const r = rig({ layerKid: "kid-s" });
    r.demux.handle(toRunner("b1", "pake", { t: "session/init", v: 1, sid: "sid1", eph: "ZXBo" }));
    r.channels[0]!.channel.close("not_trusted");
    expect(r.pakesTo("b1")).toEqual([{ t: "session/close", v: 1, sid: "sid1", reason: "not_trusted" }]);
  });

  it("maps every other local reason (revoked, a crashed agent, a handshake failure) to error", async () => {
    for (const reason of ["revoked", "agent exited with code 1", "handshake failed", "channel error"]) {
      const r = rig();
      r.demux.handle(toRunner("b1", "frame", frame("kid1", 1)));
      await r.flush();
      r.channels[0]!.channel.close(reason);
      expect(r.pakesTo("b1")).toEqual([{ t: "session/close", v: 1, kid: "kid1", reason: "error" }]);
    }
  });
});

describe("frames during the handshake", () => {
  it("does not adopt a frame injected with a junk kid before bindSession; the held frames are re-fed once the kid is known", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const r = rig({ layerKid: "kid-real", gate });
    r.demux.handle(toRunner("b1", "pake", { t: "session/init", v: 1, sid: "sid1", eph: "ZXBo" }));
    // The injected frame and the real first frame both arrive while the handshake is still running.
    r.demux.handle(toRunner("b1", "frame", frame("kid-junk", 1)));
    r.demux.handle(toRunner("b1", "frame", frame("kid-real", 1)));
    await r.flush();
    expect(r.channels[0]!.wire.kid).toBeUndefined();
    expect(r.framesTo("b1")).toEqual([]); // held frames are not acked
    expect(r.channels[0]!.got).toEqual([]);

    open();
    await r.flush();
    await r.flush();
    expect(r.channels).toHaveLength(1);
    expect(r.channels[0]!.closed).toEqual([]);
    expect(r.channels[0]!.wire.kid).toBe("kid-real");
    expect(r.channels[0]!.got).toEqual([msg(1)]);
    expect(r.framesTo("b1")).toEqual([{ v: 1, kid: "kid-real", ack: 1 }]);
    // The junk session was dropped with a scoped close, never adopted.
    expect(r.pakesTo("b1")).toEqual([{ t: "session/close", v: 1, kid: "kid-junk", reason: "unknown_session" }]);
    expect(r.faults).toEqual([]);
    // The session keeps working in order afterwards.
    r.demux.handle(toRunner("b1", "frame", frame("kid-real", 2)));
    await r.flush();
    expect(r.channels[0]!.got).toEqual([msg(1), msg(2)]);
  });

  it("does not adopt a junk kid held after the real first frame either: one channel, no superseded, the junk answered unknown_session", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const r = rig({ layerKid: "kid-real", gate });
    r.demux.handle(toRunner("b1", "pake", { t: "session/init", v: 1, sid: "sid1", eph: "ZXBo" }));
    r.demux.handle(toRunner("b1", "frame", frame("kid-real", 1)));
    r.demux.handle(toRunner("b1", "frame", frame("kid-junk", 1)));
    open();
    await r.flush();
    await r.flush();
    expect(r.channels).toHaveLength(1);
    expect(r.channels[0]!.closed).toEqual([]);
    expect(r.channels[0]!.wire.kid).toBe("kid-real");
    expect(r.channels[0]!.got).toEqual([msg(1)]);
    expect(r.framesTo("b1")).toEqual([{ v: 1, kid: "kid-real", ack: 1 }]);
    expect(r.pakesTo("b1")).toEqual([{ t: "session/close", v: 1, kid: "kid-junk", reason: "unknown_session" }]);
    expect(r.faults).toEqual([]);
    r.demux.handle(toRunner("b1", "frame", frame("kid-real", 2)));
    await r.flush();
    expect(r.channels[0]!.got).toEqual([msg(1), msg(2)]);
  });

  it("a junk kid alone leaves the wire without a message and the real session intact", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const r = rig({ layerKid: "kid-real", gate });
    r.demux.handle(toRunner("b1", "pake", { t: "session/init", v: 1, sid: "sid1", eph: "ZXBo" }));
    r.demux.handle(toRunner("b1", "frame", frame("kid-junk", 1)));
    open();
    await r.flush();
    await r.flush();
    expect(r.channels[0]!.got).toEqual([]);
    r.demux.handle(toRunner("b1", "frame", frame("kid-real", 1)));
    await r.flush();
    expect(r.channels).toHaveLength(1);
    expect(r.channels[0]!.got).toEqual([msg(1)]);
  });

  it("ends the wire with error when more than PENDING_FRAMES_MAX frames are held", async () => {
    const r = rig({ layerKid: "kid-real", gate: new Promise(() => undefined) });
    r.demux.handle(toRunner("b1", "pake", { t: "session/init", v: 1, sid: "sid1", eph: "ZXBo" }));
    for (let i = 0; i < PENDING_FRAMES_MAX; i++) r.demux.handle(toRunner("b1", "frame", frame(`junk-${i}`, 1)));
    await r.flush();
    expect(r.channels[0]!.closed).toEqual([]);
    r.demux.handle(toRunner("b1", "frame", frame("one-too-many", 1)));
    await r.flush();
    expect(r.channels[0]!.closed).toEqual(["error"]);
    expect(r.pakesTo("b1")).toEqual([{ t: "session/close", v: 1, sid: "sid1", reason: "error" }]);
  });

  it("ends the wire with error when the handshake outlasts HANDSHAKE_TIMEOUT_MS with a frame held", async () => {
    vi.useFakeTimers();
    const r = rig({ layerKid: "kid-real", gate: new Promise(() => undefined) });
    r.demux.handle(toRunner("b1", "pake", { t: "session/init", v: 1, sid: "sid1", eph: "ZXBo" }));
    r.demux.handle(toRunner("b1", "frame", frame("kid-real", 1)));
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS - 1);
    expect(r.channels[0]!.closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(r.channels[0]!.closed).toEqual(["error"]);
    expect(r.pakesTo("b1")).toEqual([{ t: "session/close", v: 1, sid: "sid1", reason: "error" }]);
  });

  it("after a handshake that ended without a kid, a seq-1 frame is not held in limbo", async () => {
    const r = rig({ layerKid: "kid-real", gate: Promise.reject(new Error("untrusted")) });
    r.demux.handle(toRunner("b1", "pake", { t: "session/init", v: 1, sid: "sid1", eph: "ZXBo" }));
    await r.flush();
    await r.flush();
    expect(r.channels[0]!.channel.closed).toBe(true);
    r.demux.handle(toRunner("b1", "frame", frame("kid-late", 1)));
    await r.flush();
    // The failed wire reset the slot to its pre-init state (as on main): the frame starts a
    // new session instead of being held for a kid that will never be negotiated.
    expect(r.channels).toHaveLength(2);
    expect(r.channels[1]!.wire.kid).toBe("kid-late");
  });

  it("a newer session/init drops what the old pending wire held", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const r = rig({ layerKid: "kid-real", gate });
    r.demux.handle(toRunner("b1", "pake", { t: "session/init", v: 1, sid: "sid1", eph: "ZXBo" }));
    r.demux.handle(toRunner("b1", "frame", frame("kid-real", 1)));
    r.demux.handle(toRunner("b1", "pake", { t: "session/init", v: 1, sid: "sid2", eph: "ZXBo" }));
    open();
    await r.flush();
    await r.flush();
    // The stale frame was not delivered to the new session.
    expect(r.channels[1]!.got).toEqual([]);
  });
});

describe("browser events (onPeer)", () => {
  const gone = (id: string) => control({ type: "peer_gone", peer: "browser", runnerId: RUNNER, browserKeyId: id });
  const back = (id: string) => control({ type: "peer_reconnected", peer: "browser", runnerId: RUNNER, browserKeyId: id });

  it("reports an arrival once, on peer_reconnected or the first envelope, not on every message", () => {
    const r = rig();
    r.demux.handle(back("b1"));
    r.demux.handle(toRunner("b1", "frame", frame("kid1", 1)));
    r.demux.handle(back("b1"));
    r.demux.handle(toRunner("b2", "frame", frame("kidB", 1)));
    r.demux.handle(toRunner("b2", "frame", frame("kidB", 2)));
    r.demux.handle(toRunner("b3", "pake", { t: "session/close", v: 1, kid: "x", reason: "closed" }));
    expect(r.peers).toEqual([["b1", true], ["b2", true], ["b3", true]]);
  });

  it("a reload inside the grace period fires nothing; a departure fires once after it", async () => {
    vi.useFakeTimers();
    const r = rig({ grace: 1000 });
    r.demux.handle(back("b1"));
    r.demux.handle(gone("b1"));
    await vi.advanceTimersByTimeAsync(600);
    r.demux.handle(back("b1"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.peers).toEqual([["b1", true]]);

    r.demux.handle(gone("b1"));
    r.demux.handle(gone("b1"));
    await vi.advanceTimersByTimeAsync(999);
    expect(r.peers).toEqual([["b1", true]]);
    await vi.advanceTimersByTimeAsync(2);
    expect(r.peers).toEqual([["b1", true], ["b1", false]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.peers).toHaveLength(2);
    // A browser that returns after leaving arrives again.
    r.demux.handle(back("b1"));
    expect(r.peers).toEqual([["b1", true], ["b1", false], ["b1", true]]);
  });

  it("bounds the tracked browsers: at the cap the oldest departs, so arrivals and departures stay paired", () => {
    const r = rig();
    for (let i = 0; i < 300; i++) r.demux.handle(back(`b${i}`));
    const arrivals = r.peers.filter(([, here]) => here).length;
    const departures = r.peers.filter(([, here]) => !here).length;
    expect(arrivals).toBe(300);
    expect(arrivals - departures).toBe(256);
    expect(r.peers.filter(([, here]) => !here).map(([id]) => id)).toEqual(Array.from({ length: 44 }, (_, i) => `b${i}`));
    // An evicted browser that speaks again is a fresh arrival, not a duplicate.
    r.demux.handle(back("b0"));
    expect(r.peers.at(-1)).toEqual(["b0", true]);
  });

  describe("an enrolled browser rebinding to its enrolled id", () => {
    const enrollAs = (r: ReturnType<typeof rig>, enrollId: string, done: Record<string, unknown>) => {
      r.demux.handle(toRunner(enrollId, "pake", { t: "pake/start", v: 1, enrollId, msg: "bXNn" }));
      r.enrollments.at(-1)!.wire.handshake.send({ t: "pake/done", v: 1, enrollId, ...done } as PakeMessage);
    };
    const count = (r: ReturnType<typeof rig>) => r.peers.reduce((n, [, here]) => n + (here ? 1 : -1), 0);

    it("retires the pre-enrollment id as soon as the enrolled id arrives, without waiting out the grace", async () => {
      vi.useFakeTimers();
      const r = rig({ grace: 60_000 });
      r.demux.handle(back("enr1"));
      enrollAs(r, "enr1", { ok: true, browserKeyId: "kk" });
      r.demux.handle(back("kk"));
      // The arrival comes first, so the count never drops to zero in between.
      expect(r.peers).toEqual([["enr1", true], ["kk", true], ["enr1", false]]);
      expect(count(r)).toBe(1);
      // The relay's later peer_gone for the closed old socket changes nothing.
      r.demux.handle(gone("enr1"));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(r.peers).toHaveLength(3);
      expect(count(r)).toBe(1);
    });

    it("also when the old socket's peer_gone reaches the runner before the enrolled id does", async () => {
      vi.useFakeTimers();
      const r = rig({ grace: 60_000 });
      r.demux.handle(back("enr1"));
      enrollAs(r, "enr1", { ok: true, browserKeyId: "kk" });
      r.demux.handle(gone("enr1"));
      await vi.advanceTimersByTimeAsync(10);
      r.demux.handle(toRunner("kk", "frame", frame("kidK", 1)));
      expect(r.peers).toEqual([["enr1", true], ["kk", true], ["enr1", false]]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(count(r)).toBe(1);
    });

    it("keeps counting the old id when the browser never comes back under the enrolled one", async () => {
      vi.useFakeTimers();
      const r = rig({ grace: 1000 });
      r.demux.handle(back("enr1"));
      enrollAs(r, "enr1", { ok: true, browserKeyId: "kk" });
      await vi.advanceTimersByTimeAsync(5000);
      expect(r.peers).toEqual([["enr1", true]]);
      // It leaves the normal way; a later stranger under the enrolled id retires nothing.
      r.demux.handle(gone("enr1"));
      await vi.advanceTimersByTimeAsync(1001);
      // A newcomer that happens to reuse the old id is its own browser: the departure forgot the pairing.
      r.demux.handle(back("enr1"));
      expect(r.peers).toEqual([["enr1", true], ["enr1", false], ["enr1", true]]);
      r.demux.handle(back("kk"));
      expect(r.peers).toEqual([["enr1", true], ["enr1", false], ["enr1", true], ["kk", true]]);
    });

    it("pairs nothing when pake/done never left, or the old id was no longer counted when it did", () => {
      const r = rig();
      // Undelivered: the browser never learned it was enrolled, so it will not rebind.
      r.demux.handle(back("enr1"));
      r.setOnline(false);
      expect(() => enrollAs(r, "enr1", { ok: true, browserKeyId: "kk" })).toThrow(/could not be sent/);
      r.setOnline(true);
      r.demux.handle(back("kk"));
      expect(r.peers).toEqual([["enr1", true], ["kk", true]]);
      // No longer counted when the result goes out (evicted at the tracking cap while the attempt was open):
      // a later newcomer under the old id is not retired by the enrolled one.
      r.demux.handle(toRunner("enr2", "pake", { t: "pake/start", v: 1, enrollId: "enr2", msg: "bXNn" }));
      for (let i = 0; i < 256; i++) r.demux.handle(back(`b${i}`));
      expect(r.peers.filter(([id]) => id === "enr2")).toEqual([["enr2", true], ["enr2", false]]);
      r.enrollments.at(-1)!.wire.handshake.send({ t: "pake/done", v: 1, enrollId: "enr2", ok: true, browserKeyId: "kk2" });
      r.demux.handle(back("enr2"));
      r.demux.handle(back("kk2"));
      expect(r.peers.filter(([id]) => id === "enr2" || id === "kk2")).toEqual([["enr2", true], ["enr2", false], ["enr2", true], ["kk2", true]]);
    });

    it("bounds the pending pairings: past the cap the oldest is forgotten, not retired", () => {
      const r = rig();
      for (let i = 0; i <= 32; i++) {
        r.demux.handle(back(`enr${i}`));
        enrollAs(r, `enr${i}`, { ok: true, browserKeyId: `kk${i}` });
      }
      r.demux.handle(back("kk0"));
      r.demux.handle(back("kk32"));
      expect(r.peers.slice(33)).toEqual([["kk0", true], ["kk32", true], ["enr32", false]]);
    });

    it("retires nothing for a refused enrollment, or one whose enrolled id is the id already in use", () => {
      const r = rig();
      r.demux.handle(back("enr1"));
      enrollAs(r, "enr1", { ok: false, reason: "bad_code", browserKeyId: "kk" });
      r.demux.handle(back("kk"));
      r.demux.handle(back("kk2"));
      enrollAs(r, "kk2", { ok: true, browserKeyId: "kk2" });
      r.demux.handle(back("kk2"));
      expect(r.peers).toEqual([["enr1", true], ["kk", true], ["kk2", true]]);
    });
  });

  it("peer_gone for a browser that was never seen fires nothing", async () => {
    vi.useFakeTimers();
    const r = rig({ grace: 100 });
    r.demux.handle(gone("ghost"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.peers).toEqual([]);
  });

  it("a browser with no wire at all still departs", async () => {
    vi.useFakeTimers();
    const r = rig({ grace: 100 });
    r.demux.handle(toRunner("b1", "pake", { t: "pake/start", v: 1, enrollId: "b1", msg: "bXNn" }));
    r.demux.handle(gone("b1"));
    await vi.advanceTimersByTimeAsync(150);
    expect(r.peers).toEqual([["b1", true], ["b1", false]]);
  });

  it("a lost socket starts the grace; a browser the relay announces again inside it fires nothing", async () => {
    vi.useFakeTimers();
    const r = rig({ grace: 1000 });
    r.demux.handle(back("b1"));
    r.demux.handle(back("b2"));
    r.demux.socketLost();
    expect(r.peers).toEqual([["b1", true], ["b2", true]]);
    await vi.advanceTimersByTimeAsync(400);
    r.demux.socketOpened();
    r.demux.handle(back("b1"));
    r.demux.handle(toRunner("b2", "frame", frame("kidB", 1)));
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.peers).toEqual([["b1", true], ["b2", true]]);
  });

  it("a browser the relay does not announce again after a lost socket departs once, after the grace", async () => {
    vi.useFakeTimers();
    const r = rig({ grace: 1000 });
    r.demux.handle(back("b1"));
    r.demux.handle(back("b2"));
    r.demux.socketLost();
    await vi.advanceTimersByTimeAsync(600);
    r.demux.socketOpened();
    r.demux.handle(back("b1"));
    r.demux.socketLost(); // a second drop must not restart or duplicate the pending timers
    await vi.advanceTimersByTimeAsync(399);
    expect(r.peers).toEqual([["b1", true], ["b2", true]]);
    await vi.advanceTimersByTimeAsync(2);
    expect(r.peers).toEqual([["b1", true], ["b2", true], ["b2", false]]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.peers).toEqual([["b1", true], ["b2", true], ["b2", false], ["b1", false]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.peers).toHaveLength(4);
    r.demux.handle(back("b1"));
    expect(r.peers[4]).toEqual(["b1", true]);
  });

  it("a departure pending when the socket is lost is not reported twice", async () => {
    vi.useFakeTimers();
    const r = rig({ grace: 100 });
    r.demux.handle(back("b1"));
    r.demux.handle(gone("b1"));
    r.demux.socketLost();
    await vi.advanceTimersByTimeAsync(500);
    expect(r.peers).toEqual([["b1", true], ["b1", false]]);
  });

  it("close stops the timers and fires nothing", async () => {
    vi.useFakeTimers();
    const r = rig({ grace: 100 });
    r.demux.handle(back("b1"));
    r.demux.handle(gone("b1"));
    r.demux.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(r.peers).toEqual([["b1", true]]);
  });
});
