import { describe, expect, it } from "vitest";
import { RELAY_CLOSE_REVOKED, type ControlBody, type RelayEnvelope } from "@berdyh/bridge-protocol";

import type {
  BridgeServerConfig,
  ConnectionFilter,
  ConnectionState,
  RelayConnection,
  RelayHandler,
  RelayPeer,
  RelayTransport,
  SendResult,
} from "./contracts.js";
import { createRelayCore, createRelayCoreWithHooks, revokedVerdictFrame } from "./relay.js";
import { negotiateHandshake } from "./handshake.js";
import { buildDiscovery } from "./discovery.js";
import { createDeviceService } from "./devices.js";

/** A synchronous in-memory transport that records what the core sends. */
function fakeTransport() {
  type FakeEntry = { conn: { id: string; peer: RelayPeer; state: ConnectionState }; sent: string[]; closed?: [number, string] };
  const conns = new Map<string, FakeEntry>();
  let n = 0;
  /** Connection ids whose `send` answers this result without delivering anything. */
  const forcedSend = new Map<string, SendResult>();
  const t: RelayTransport = {
    bind() {},
    async accept() {
      return new Response(null, { status: 426 });
    },
    async disconnect() {
      return 0;
    },
    send(id, data): SendResult {
      const forced = forcedSend.get(id);
      if (forced) return forced;
      const e = conns.get(id);
      if (!e || e.closed) return "closed";
      e.sent.push(data);
      return "sent";
    },
    close(id, code, reason) {
      const e = conns.get(id);
      if (e && !e.closed) e.closed = [code, reason];
    },
    connections(userId, f: ConnectionFilter = {}): RelayConnection[] {
      return [...conns.values()]
        .filter((e) => !e.closed && e.conn.peer.userId === userId)
        .filter((e) => f.role === undefined || e.conn.peer.role === f.role)
        .filter((e) => f.runnerId === undefined || (e.conn.peer.role === "runner" && e.conn.peer.runnerId === f.runnerId))
        .filter((e) => f.browserKeyId === undefined || (e.conn.peer.role === "browser" && e.conn.peer.browserKeyId === f.browserKeyId))
        .map((e) => e.conn);
    },
    setState(id, state) {
      const e = conns.get(id);
      if (e) e.conn.state = state;
    },
  };
  return {
    t,
    forceSend: (id: string, result: SendResult) => void forcedSend.set(id, result),
    open(peer: RelayPeer) {
      const id = `c${++n}`;
      const entry: FakeEntry = { conn: { id, peer, state: { connectedAt: new Date(1000 + n).toISOString() } as ConnectionState }, sent: [] };
      conns.set(id, entry);
      return entry;
    },
  };
}

const config = (overrides: Partial<BridgeServerConfig> = {}): BridgeServerConfig => {
  const devices = new Map<string, unknown>();
  return {
    app: { id: "app", name: "App" },
    origin: "https://app.example",
    auth: { issuer: "https://idp.example", clientId: "c", deviceAuthorizationEndpoint: "https://idp.example/d", tokenEndpoint: "https://idp.example/t" },
    adapters: {
      relay: {} as never,
      verifier: {} as never,
      store: {
        async getDevice(u: string, id: string) {
          return devices.has(`${u}:${id}`) ? ({ deviceId: id, runnerVersion: "1.0.0", lastSeen: "2026-01-01T00:00:00.000Z" } as never) : undefined;
        },
        async listDevices() {
          return [];
        },
        async upsertDevice(r: { userId: string; deviceId: string }) {
          devices.set(`${r.userId}:${r.deviceId}`, r);
          return "ok" as const;
        },
        async touchLastSeen() {
          return false;
        },
        async revokeDevice() {
          return undefined;
        },
        async isRevoked() {
          return false;
        },
        async isCredentialRevoked() {
          return false;
        },
      },
    },
    ...overrides,
  };
};

const hello = (runnerId: string, min = 1, max = 1) =>
  JSON.stringify({ type: "hello", runnerId, runnerVersion: "1.0.0", protocol: { min, max } });

const parse = (s: string) => JSON.parse(s) as RelayEnvelope;
const controls = (sent: string[]) => sent.map((s) => parse(s)).filter((e) => e.kind === "control").map((e) => e.body as ControlBody);

async function setup(cfg = config()) {
  const f = fakeTransport();
  const core: RelayHandler = createRelayCore(cfg, f.t);
  const runner = (userId: string, runnerId: string) => f.open({ role: "runner", userId, runnerId });
  const browser = (userId: string, browserKeyId: string) => f.open({ role: "browser", userId, browserKeyId });
  return { f, core, runner, browser, force: f.forceSend };
}

describe("relay routing", () => {
  it("isolates two users with two runners", async () => {
    const { core, runner, browser } = await setup();
    const ra = runner("alice", "run-a");
    const rb = runner("bob", "run-b");
    const ba = browser("alice", "bk-a");
    const bb = browser("bob", "bk-b");
    for (const r of [ra, rb]) {
      await core.onOpen(r.conn);
      await core.onMessage(r.conn, hello(r.conn.peer.role === "runner" ? r.conn.peer.runnerId : ""));
    }
    await core.onOpen(ba.conn);
    await core.onOpen(bb.conn);
    ra.sent.length = rb.sent.length = ba.sent.length = bb.sent.length = 0;

    const toRunner = (runnerId: string, bk: string) =>
      JSON.stringify({ to: "runner", runnerId, browserKeyId: bk, kind: "frame", body: "x" });

    // Alice's browser to Alice's runner arrives; Bob's runner stays silent.
    await core.onMessage(ba.conn, toRunner("run-a", "bk-a"));
    expect(ra.sent).toEqual([toRunner("run-a", "bk-a")]);
    expect(rb.sent).toEqual([]);

    // Alice's browser addressing Bob's runner id never reaches Bob.
    await core.onMessage(ba.conn, toRunner("run-b", "bk-a"));
    expect(rb.sent).toEqual([]);
    expect(controls(ba.sent).at(-1)).toMatchObject({ type: "error", code: "unknown_runner" });

    // Bob's runner answering to Alice's browser key finds nobody.
    await core.onMessage(rb.conn, JSON.stringify({ to: "browser", runnerId: "run-b", browserKeyId: "bk-a", kind: "frame", body: 1 }));
    expect(ba.sent.some((s) => parse(s).kind === "frame")).toBe(false);
    expect(controls(rb.sent).at(-1)).toMatchObject({ type: "peer_gone", peer: "browser" });

    // Presence goes only to the owner's browsers.
    expect(bb.sent.every((s) => !s.includes("run-a"))).toBe(true);
  });

  it("rejects a browser envelope with someone else's browserKeyId", async () => {
    const { core, runner, browser } = await setup();
    const r = runner("alice", "run-a");
    await core.onMessage(r.conn, hello("run-a"));
    const b = browser("alice", "bk-1");
    r.sent.length = 0;
    await core.onMessage(b.conn, JSON.stringify({ to: "runner", runnerId: "run-a", browserKeyId: "bk-2", kind: "frame", body: "x" }));
    expect(r.sent).toEqual([]);
    expect(controls(b.sent).at(-1)).toMatchObject({ type: "error", code: "bad_envelope" });
  });

  it("forwards the raw text byte-identical and never reads body (blindness)", async () => {
    const seen: string[] = [];
    const f = fakeTransport();
    const core = createRelayCoreWithHooks(config(), f.t, { onForward: (raw) => seen.push(raw) });
    const r = f.open({ role: "runner", userId: "u", runnerId: "r1" });
    await core.onMessage(r.conn, hello("r1"));
    const b = f.open({ role: "browser", userId: "u", browserKeyId: "bk" });
    await core.onOpen(b.conn);
    // Odd spacing, duplicate keys, a number JSON.stringify would rewrite, and a body
    // that is not JSON-shaped data at all.
    const raw =
      '{ "to":"runner",  "runnerId":"r1", "browserKeyId":"bk", "kind":"frame",\n "body":"\\u0000not json{ <<>> ", "body":1e400, "z":1.0 }';
    r.sent.length = 0;
    await core.onMessage(b.conn, raw);
    expect(r.sent).toEqual([raw]);
    expect(seen).toEqual([raw]);
  });

  it("drops relay-originated kinds sent by endpoints", async () => {
    const { core, runner, browser } = await setup();
    const r = runner("u", "r1");
    await core.onMessage(r.conn, hello("r1"));
    const b = browser("u", "bk");
    await core.onOpen(b.conn);
    b.sent.length = 0;
    await core.onMessage(r.conn, JSON.stringify({ to: "browser", runnerId: "r1", browserKeyId: "bk", kind: "presence", body: {} }));
    await core.onMessage(r.conn, JSON.stringify({ to: "browser", runnerId: "r1", browserKeyId: "bk", kind: "control", body: {} }));
    expect(b.sent).toEqual([]);
  });

  it("sends presence and peer_reconnected both ways, and presence offline with peer_gone", async () => {
    const { core, runner, browser, f } = await setup();
    const b = browser("u", "bk");
    await core.onOpen(b.conn);
    const r = runner("u", "r1");
    await core.onOpen(r.conn);
    await core.onMessage(r.conn, hello("r1"));
    expect(parse(r.sent[0]!)).toMatchObject({ type: "welcome", protocol: 1 });
    const kinds = b.sent.map((s) => parse(s));
    expect(kinds.find((e) => e.kind === "presence")?.body).toMatchObject({ runnerId: "r1", online: true });
    expect(controls(b.sent)).toContainEqual({ type: "peer_reconnected", peer: "runner", runnerId: "r1" });
    expect(controls(r.sent)).toContainEqual({ type: "peer_reconnected", peer: "browser", runnerId: "r1", browserKeyId: "bk" });

    f.t.close(r.conn.id, 1000, "bye");
    await core.onClose(r.conn, 1000, "bye");
    const last = b.sent.map((s) => parse(s));
    expect(last.filter((e) => e.kind === "presence").at(-1)?.body).toMatchObject({ online: false });
    expect(controls(b.sent).at(-1)).toMatchObject({ type: "peer_gone", peer: "runner" });
  });

  it("repeats the runner's reported agents in presence for a browser that connects later", async () => {
    const { core, runner, browser } = await setup();
    const r = runner("u", "r1");
    await core.onOpen(r.conn);
    const agents = [{ id: "claude", available: true }, { id: "codex", available: false }];
    await core.onMessage(r.conn, JSON.stringify({ ...JSON.parse(hello("r1")), agents }));
    const b = browser("u", "bk");
    await core.onOpen(b.conn);
    const presence = b.sent.map((s) => parse(s)).find((e) => e.kind === "presence");
    expect(presence?.body).toMatchObject({ runnerId: "r1", online: true, agents });
  });

  it("keeps only id and availability of at most 32 reported agents with short ids", async () => {
    const { core, runner, browser } = await setup();
    const r = runner("u", "r1");
    await core.onOpen(r.conn);
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `agent${i}`, available: true, extra: "x".repeat(500) }));
    const agents = [{ id: "a".repeat(65), available: true }, ...many];
    await core.onMessage(r.conn, JSON.stringify({ ...JSON.parse(hello("r1")), agents }));
    const b = browser("u", "bk");
    await core.onOpen(b.conn);
    const presence = b.sent.map((s) => parse(s)).find((e) => e.kind === "presence");
    const sent = (presence?.body as { agents: unknown[] }).agents;
    expect(sent).toHaveLength(32);
    expect(sent[0]).toEqual({ id: "agent0", available: true });
  });

  it("does not route before hello", async () => {
    const { core, runner } = await setup();
    const r = runner("u", "r1");
    await core.onMessage(r.conn, JSON.stringify({ to: "browser", runnerId: "r1", browserKeyId: "bk", kind: "frame", body: 1 }));
    expect(r.conn.state.greeted).toBeUndefined();
    expect(r.sent.length).toBeGreaterThan(0);
  });

  it("rejects an oversized envelope", async () => {
    const { core, runner, f } = await setup(config({ maxEnvelopeBytes: 64 }));
    const r = runner("u", "r1");
    await core.onMessage(r.conn, "x".repeat(100));
    void f;
    expect(r.closed?.[0]).toBe(1009);
  });
});

describe("version negotiation", () => {
  it("picks the highest common version", () => {
    expect(negotiateHandshake({ type: "hello", runnerId: "r", runnerVersion: "1", protocol: { min: 1, max: 5 } }, { min: 1, max: 3 })).toEqual({
      ok: true,
      welcome: { type: "welcome", protocol: 3 },
    });
  });

  it("answers a too-old runner with update_required", () => {
    const out = negotiateHandshake({ type: "hello", runnerId: "r", runnerVersion: "0.1", protocol: { min: 1, max: 1 } }, { min: 2, max: 3 }, "2.0.0");
    expect(out).toMatchObject({ ok: false, reply: { type: "update_required", server: { min: 2, max: 3 }, latestRunnerVersion: "2.0.0" } });
  });

  it("answers a too-new runner with protocol_mismatch", () => {
    const out = negotiateHandshake({ type: "hello", runnerId: "r", runnerVersion: "9", protocol: { min: 5, max: 6 } }, { min: 1, max: 3 });
    expect(out).toMatchObject({ ok: false, reply: { type: "error", code: "protocol_mismatch" } });
  });

  it("sends update_required over the socket and closes it", async () => {
    const { core, runner } = await setup(config({ protocol: { min: 2, max: 3 }, latestRunnerVersion: "2.0.0" }));
    const r = runner("u", "r1");
    await core.onMessage(r.conn, hello("r1", 1, 1));
    expect(controls(r.sent)[0]).toMatchObject({ type: "update_required", latestRunnerVersion: "2.0.0" });
    expect(r.closed).toBeDefined();
    expect(r.conn.state.greeted).toBeUndefined();
  });
});

describe("discovery and device service", () => {
  it("builds discovery with defaults", () => {
    const d = buildDiscovery(config());
    expect(d.relayUrl).toBe("wss://app.example/relay");
    expect(d.protocol).toEqual({ min: 1, max: 1 });
    expect(buildDiscovery(config({ origin: "http://127.0.0.1:9" })).relayUrl).toBe("ws://127.0.0.1:9/relay");
  });

  it("recordSeen delegates to the store with the interval", async () => {
    const calls: unknown[][] = [];
    const svc = createDeviceService({
      store: { touchLastSeen: async (...a: unknown[]) => (calls.push(a), true) } as never,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(await svc.recordSeen("u", "d")).toBe(true);
    expect(calls).toEqual([["u", "d", "2026-01-01T00:00:00.000Z", 300000]]);
  });

  it("revoke hands credential ids to the identity provider, and survives its failure", async () => {
    const revoked: string[][] = [];
    const store = { revokeDevice: async () => ({ credentialIds: ["c1"] }) } as never;
    const ok = createDeviceService({ store, revokeCredentials: async (_u, ids) => void revoked.push(ids) });
    expect(await ok.revoke("u", "d")).toBe(true);
    expect(revoked).toEqual([["c1"]]);
    const bad = createDeviceService({ store, revokeCredentials: async () => Promise.reject(new Error("idp down")) });
    expect(await bad.revokeAndReport("u", "d")).toEqual({ credentialIds: ["c1"], idpRevokeFailed: true });
    const none = createDeviceService({ store: { revokeDevice: async () => undefined } as never });
    expect(await none.revoke("u", "x")).toBe(false);
  });
});

describe("review fixes", () => {
  const gated = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    return { gate, release };
  };

  it("runs the socket-closing callback before a stalled identity provider answers", async () => {
    const store = { revokeDevice: async () => ({ credentialIds: ["c1"] }) } as never;
    const stall = gated();
    const order: string[] = [];
    const svc = createDeviceService({
      store,
      revokeCredentials: async () => {
        order.push("idp");
        await stall.gate;
      },
    });
    const pending = svc.revokeAndReport("u", "d", () => void order.push("sockets"));
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["sockets", "idp"]);
    stall.release();
    expect(await pending).toEqual({ credentialIds: ["c1"] });
  });

  it("an older handshake that finishes late does not evict a newer runner socket", async () => {
    const slow = gated();
    const cfg = config();
    const upsert = cfg.adapters.store.upsertDevice.bind(cfg.adapters.store);
    let calls = 0;
    cfg.adapters.store.upsertDevice = async (r, c) => {
      if (++calls === 1) await slow.gate;
      return upsert(r, c);
    };
    const { core, runner, f } = await setup(cfg);
    void f;
    const older = runner("u", "r");
    const newer = runner("u", "r");
    const olderDone = core.onMessage(older.conn, hello("r"));
    await core.onMessage(newer.conn, hello("r"));
    slow.release();
    await olderDone;
    expect(newer.closed).toBeUndefined();
    expect(older.closed?.[0]).toBe(4409);
  });

  it("a handshake that timed out during the store await does not evict a healthy runner", async () => {
    const slow = gated();
    const cfg = config();
    const upsert = cfg.adapters.store.upsertDevice.bind(cfg.adapters.store);
    let calls = 0;
    cfg.adapters.store.upsertDevice = async (r, c) => {
      if (++calls === 1) await slow.gate;
      return upsert(r, c);
    };
    const { core, runner, browser } = await setup(cfg);
    const healthy = runner("u", "r");
    const stalled = runner("u", "r"); // newer connectedAt
    const b = browser("u", "bk");
    const stalledDone = core.onMessage(stalled.conn, hello("r")); // first upsert: gated
    await core.onMessage(healthy.conn, hello("r"));
    stalled.closed = [1008, "hello timeout"]; // the transport closed it while the store was slow
    slow.release();
    await stalledDone;
    expect(healthy.closed).toBeUndefined();
    expect(healthy.conn.state.greeted).toBe(true);
    expect(stalled.conn.state.greeted).toBeUndefined();
    expect(stalled.sent).toEqual([]); // no welcome to a closed socket
    expect(controls(b.sent).filter((c) => c.type === "peer_gone")).toEqual([]);
  });

  it("a runner that reconnected during close awaits is not reported offline", async () => {
    const slow = gated();
    const cfg = config();
    const { core, runner, browser } = await setup(cfg);
    const first = runner("u", "r");
    await core.onMessage(first.conn, hello("r"));
    const b = browser("u", "bk");
    await core.onOpen(b.conn);
    b.sent.length = 0;
    let gatedOnce = false;
    cfg.adapters.store.touchLastSeen = async () => {
      if (!gatedOnce) {
        gatedOnce = true;
        await slow.gate;
      }
      return false;
    };
    first.closed = [1006, "gone"]; // transport has dropped it
    const closing = core.onClose(first.conn, 1006, "gone");
    const second = runner("u", "r");
    await core.onMessage(second.conn, hello("r"));
    slow.release();
    await closing;
    expect(b.sent.map((s) => parse(s).body).filter((x) => (x as { online?: boolean }).online === false)).toEqual([]);
    expect(controls(b.sent).some((c) => c.type === "peer_gone")).toBe(false);
  });

  it("refreshes lastSeen from runner traffic, at most once per interval", async () => {
    let t = 0;
    let touches = 0;
    const cfg = config({ now: () => new Date(t), lastSeenIntervalMs: 1000 });
    cfg.adapters.store.touchLastSeen = async () => {
      touches++;
      return true;
    };
    const { core, runner } = await setup(cfg);
    const r = runner("u", "r");
    await core.onMessage(r.conn, hello("r"));
    const base = touches; // handshake write
    const msg = JSON.stringify({ to: "browser", runnerId: "r", browserKeyId: "bk", kind: "frame", body: 1 });
    await core.onMessage(r.conn, msg);
    await core.onMessage(r.conn, msg);
    expect(touches).toBe(base);
    t = 1500;
    await core.onMessage(r.conn, msg);
    await core.onMessage(r.conn, msg);
    await new Promise((res) => setTimeout(res, 0));
    expect(touches).toBe(base + 1);
  });
});

describe("send results", () => {
  const toRunner = (runnerId: string, bk: string) => JSON.stringify({ to: "runner", runnerId, browserKeyId: bk, kind: "frame", body: "x" });
  const toBrowser = (runnerId: string, bk: string) => JSON.stringify({ to: "browser", runnerId, browserKeyId: bk, kind: "frame", body: "x" });

  async function pair() {
    const s = await setup();
    const r = s.runner("u", "r");
    await s.core.onMessage(r.conn, hello("r"));
    const b = s.browser("u", "bk");
    await s.core.onOpen(b.conn);
    r.sent.length = 0;
    b.sent.length = 0;
    return { ...s, r, b };
  }

  it("tells a browser error/backpressure when the runner's queue is saturated", async () => {
    const { core, force, r, b } = await pair();
    force(r.conn.id, "dropped_backpressure");
    await core.onMessage(b.conn, toRunner("r", "bk"));
    expect(controls(b.sent)).toEqual([{ type: "error", code: "backpressure", message: expect.any(String) }]);
    expect(parse(b.sent[0]!)).toMatchObject({ to: "browser", runnerId: "r", browserKeyId: "bk" });
  });

  it("tells a runner error/backpressure when the browser's queue is saturated", async () => {
    const { core, force, r, b } = await pair();
    force(b.conn.id, "dropped_backpressure");
    await core.onMessage(r.conn, toBrowser("r", "bk"));
    expect(controls(r.sent)).toEqual([{ type: "error", code: "backpressure", message: expect.any(String) }]);
  });

  it("tells a browser peer_gone when the runner socket is already closed", async () => {
    const { core, force, r, b } = await pair();
    force(r.conn.id, "closed");
    await core.onMessage(b.conn, toRunner("r", "bk"));
    expect(controls(b.sent)).toEqual([{ type: "peer_gone", peer: "runner", runnerId: "r" }]);
  });

  it("tells a runner peer_gone (with the browserKeyId) when the browser socket is already closed", async () => {
    const { core, force, r, b } = await pair();
    force(b.conn.id, "closed");
    await core.onMessage(r.conn, toBrowser("r", "bk"));
    expect(controls(r.sent)).toEqual([{ type: "peer_gone", peer: "browser", runnerId: "r", browserKeyId: "bk" }]);
  });

  it("does not tap an envelope that was not delivered", async () => {
    const f = fakeTransport();
    const tapped: string[] = [];
    const core = createRelayCoreWithHooks(config(), f.t, { onForward: (raw) => tapped.push(raw) });
    const r = f.open({ role: "runner", userId: "u", runnerId: "r" });
    await core.onMessage(r.conn, hello("r"));
    const b = f.open({ role: "browser", userId: "u", browserKeyId: "bk" });
    await core.onOpen(b.conn);
    f.forceSend(r.conn.id, "dropped_backpressure");
    await core.onMessage(b.conn, toRunner("r", "bk"));
    expect(tapped).toEqual([]);
  });
});

describe("runner socket replacement", () => {
  it("closes the older greeted socket of a runner with 4409 and does not report the runner offline", async () => {
    const { core, runner, browser } = await setup();
    const first = runner("u", "r");
    await core.onMessage(first.conn, hello("r"));
    const b = browser("u", "bk");
    await core.onOpen(b.conn);
    b.sent.length = 0;

    const second = runner("u", "r");
    await core.onMessage(second.conn, hello("r"));
    expect(first.closed?.[0]).toBe(4409);
    expect(second.closed).toBeUndefined();

    await core.onClose(first.conn, 4409, "replaced"); // the transport reports the old socket's close
    expect(b.sent.map((x) => parse(x).body).some((x) => (x as { online?: boolean }).online === false)).toBe(false);
    expect(controls(b.sent).some((c) => c.type === "peer_gone")).toBe(false);

    // Routing now reaches the new socket only.
    second.sent.length = 0;
    await core.onMessage(b.conn, JSON.stringify({ to: "runner", runnerId: "r", browserKeyId: "bk", kind: "frame", body: 1 }));
    expect(second.sent).toHaveLength(1);
    expect(first.sent.filter((x) => x.includes('"frame"'))).toEqual([]);
  });

  it("reports the runner offline only when its last socket closes", async () => {
    const { core, runner, browser } = await setup();
    const only = runner("u", "r");
    await core.onMessage(only.conn, hello("r"));
    const b = browser("u", "bk");
    await core.onOpen(b.conn);
    b.sent.length = 0;
    only.closed = [1006, "gone"];
    await core.onClose(only.conn, 1006, "gone");
    expect(controls(b.sent)).toContainEqual({ type: "peer_gone", peer: "runner", runnerId: "r" });
  });
});

describe("revoked verdict frame", () => {
  it("is exactly the envelope the core sends after a revoked upsert", async () => {
    const cfg = config();
    cfg.adapters.store.upsertDevice = async () => "revoked";
    const { core, runner } = await setup(cfg);
    const r = runner("alice", "run-a");
    await core.onMessage(r.conn, hello("run-a"));
    expect(r.closed).toEqual([RELAY_CLOSE_REVOKED, "revoked"]);
    expect(r.sent).toEqual([revokedVerdictFrame("run-a")]);
  });
});

describe("credential fingerprint at hello", () => {
  it("passes the peer's fingerprint to upsertDevice with the credential id", async () => {
    const cfg = config();
    const calls: unknown[][] = [];
    const upsert = cfg.adapters.store.upsertDevice;
    cfg.adapters.store.upsertDevice = async (...args) => (calls.push(args.slice(1)), upsert(...args));
    const { core, f } = await setup(cfg);
    const r = f.open({ role: "runner", userId: "alice", runnerId: "run-a", credentialId: "c1", credentialFingerprint: "f".repeat(64) });
    await core.onMessage(r.conn, hello("run-a"));
    expect(calls).toEqual([["c1", "f".repeat(64)]]);
  });
});
