import { createServer, type Server } from "node:http";
import { connect as tcpConnect, type AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { RELAY_CLOSE_REPLACED, RELAY_CLOSE_REVOKED, RELAY_SUBPROTOCOL } from "@berdyh/bridge-protocol";
import { DEFAULT_MAX_SOCKET_AGE_MS, RELAY_CLOSE_MAX_AGE, revokedVerdictFrame, type RelayConnection, type RelayPeer } from "@berdyh/bridge-server";

import { createWsRelayTransport, type WsRelayTransport, type WsRelayTransportOptions } from "./ws-transport.js";

interface Harness {
  transport: WsRelayTransport;
  url: string;
  opened: RelayConnection[];
  closes: { conn: RelayConnection; code: number }[];
  /** Resolves with the n-th connection once `onOpen` ran. */
  open(n: number): Promise<RelayConnection>;
  connect(query: string, opts?: WebSocket.ClientOptions): { ws: WebSocket; closed: Promise<number>; ready: Promise<void> };
}

let servers: Server[] = [];
let transports: WsRelayTransport[] = [];
let clients: WebSocket[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const c of clients) c.terminate();
  clients = [];
  await Promise.all(transports.map((t) => t.shutdown()));
  transports = [];
  await Promise.all(servers.map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); })));
  servers = [];
});

/** `?runner=<id>` makes a runner peer, `?browser=<id>` a browser peer; the user is always "alice". `?verdict=<id>` is a revoked-verdict upgrade. */
async function harness(options: WsRelayTransportOptions = {}, onMessage: (conn: RelayConnection, text: string) => Promise<void> | void = () => undefined): Promise<Harness> {
  const transport = createWsRelayTransport(options);
  transports.push(transport);
  const opened: RelayConnection[] = [];
  const closes: Harness["closes"] = [];
  const waiters: Array<() => void> = [];
  transport.bind({
    async onOpen(conn) {
      opened.push(conn);
      waiters.splice(0).forEach((w) => w());
    },
    async onMessage(conn, text) {
      await onMessage(conn, text);
    },
    async onClose(conn, code) {
      closes.push({ conn, code });
    },
  });
  const http = createServer();
  http.on("upgrade", (req, socket, head) => {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    if (q.has("verdict")) return transport.handleVerdict(req, socket, head, { type: "revoked", runnerId: q.get("verdict")! });
    const peer: RelayPeer = q.has("runner")
      ? { role: "runner", userId: "alice", runnerId: q.get("runner")! }
      : { role: "browser", userId: "alice", browserKeyId: q.get("browser")! };
    transport.handleUpgrade(req, socket, head, peer);
  });
  servers.push(http);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    transport,
    url,
    opened,
    closes,
    async open(n) {
      while (opened.length < n) await new Promise<void>((r) => waiters.push(r));
      return opened[n - 1]!;
    },
    connect(query, opts = {}) {
      const ws = new WebSocket(`${url}/?${query}`, [RELAY_SUBPROTOCOL], opts);
      clients.push(ws);
      ws.on("error", () => undefined);
      return {
        ws,
        closed: new Promise<number>((r) => ws.on("close", (code) => r(code))),
        ready: new Promise<void>((r) => ws.once("open", () => r())),
      };
    },
  };
}

const timersOnly: NonNullable<Parameters<typeof vi.useFakeTimers>[0]> = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] };

describe("ws transport backpressure", () => {
  it("terminates a socket over maxQueuedBytes instead of queueing a close frame", async () => {
    const h = await harness({ maxQueuedBytes: 100 });
    const c = h.connect("browser=bk");
    const conn = await h.open(1);

    expect(h.transport.send(conn.id, "x".repeat(10))).toBe("sent");
    expect(h.transport.send(conn.id, "y".repeat(500))).toBe("dropped_backpressure");
    // Already out of the registry: later sends and routing see it gone.
    expect(h.transport.connections("alice")).toEqual([]);
    expect(h.transport.send(conn.id, "z")).toBe("closed");
    // A terminate has no close frame, so the client sees 1006, never 1013.
    expect(await c.closed).toBe(1006);
    await vi.waitFor(() => expect(h.closes.map((x) => x.conn.id)).toEqual([conn.id]));
  });
});

describe("ws transport revoked verdict", () => {
  it("sends the revoked control and closes 4401, never registering the socket or touching a live one", async () => {
    const h = await harness();
    const live = h.connect("runner=r1");
    await live.ready;
    const liveConn = await h.open(1);

    const messages: string[] = [];
    const v = h.connect("verdict=r1");
    v.ws.on("message", (d) => messages.push(d.toString()));
    const reasons: string[] = [];
    v.ws.on("close", (_c, r) => reasons.push(r.toString()));
    expect(await v.closed).toBe(RELAY_CLOSE_REVOKED);
    expect(messages).toEqual([revokedVerdictFrame("r1")]);
    expect(reasons).toEqual(["revoked"]);

    expect(h.opened).toHaveLength(1); // no onOpen: never reached hello or routing
    expect(h.transport.connections("alice")).toEqual([liveConn]);
    expect(live.ws.readyState).toBe(WebSocket.OPEN);
    // Nothing reaches the handler for it either: no onClose beyond the live socket's (none yet).
    await new Promise((r) => setTimeout(r, 50));
    expect(h.closes).toEqual([]);
  });

  it("is not counted against the per-user socket cap", async () => {
    const h = await harness({ maxSocketsPerUser: { runner: 1 } });
    const live = h.connect("runner=r1");
    await live.ready;
    const v = h.connect("verdict=r1");
    expect(await v.closed).toBe(RELAY_CLOSE_REVOKED);
  });

  it("tears down a client that never finishes the close handshake", async () => {
    const h = await harness();
    const port = Number(new URL(h.url.replace("ws", "http")).port);
    const raw = tcpConnect(port, "127.0.0.1");
    const closed = new Promise<void>((resolve) => raw.on("close", () => resolve()));
    raw.on("error", () => undefined);
    raw.resume(); // read and discard: the client takes the verdict but never answers the close
    raw.on("connect", () => raw.write(
      "GET /?verdict=r1 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    ));
    // No close frame is ever sent back.
    await closed;
    expect(h.opened).toEqual([]);
  }, 10_000);
});

describe("ws transport browser replacement", () => {
  it("closes the older socket of the same browserKeyId with 4409 before onOpen of the new one", async () => {
    const h = await harness();
    const first = h.connect("browser=bk");
    await h.open(1);
    const second = h.connect("browser=bk");
    await h.open(2);
    expect(await first.closed).toBe(RELAY_CLOSE_REPLACED);
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
    expect(h.transport.connections("alice", { role: "browser", browserKeyId: "bk" })).toHaveLength(1);
  });
});

describe("ws transport per-user socket caps", () => {
  const refused = (c: { ws: WebSocket }) => new Promise<number>((r) => {
    c.ws.on("unexpected-response", (_req, res) => { res.resume(); r(res.statusCode ?? 0); });
    c.ws.on("open", () => r(101));
  });

  it("answers 429 before onOpen once a user holds the cap, per role", async () => {
    const h = await harness({ maxSocketsPerUser: { browser: 2, runner: 1 }, pingIntervalMs: 0, helloTimeoutMs: 0 });
    h.connect("browser=a"); h.connect("browser=b"); await h.open(2);
    const over = h.connect("browser=c");
    expect(await refused(over)).toBe(429);
    h.connect("runner=r1"); await h.open(3);
    expect(await refused(h.connect("runner=r2"))).toBe(429);
    expect(h.opened).toHaveLength(3);
    expect(h.transport.connections("alice")).toHaveLength(3);
  });

  it("lets a browser replace its own socket at the cap, and frees a slot on close", async () => {
    const h = await harness({ maxSocketsPerUser: { browser: 2 }, pingIntervalMs: 0, helloTimeoutMs: 0 });
    const first = h.connect("browser=a"); h.connect("browser=b"); await h.open(2);
    const again = h.connect("browser=a"); await h.open(3);
    expect(await first.closed).toBe(RELAY_CLOSE_REPLACED);
    expect(again.ws.readyState).toBe(WebSocket.OPEN);
    expect(h.transport.connections("alice", { role: "browser" })).toHaveLength(2);
    // A refused upgrade never evicts an existing tab.
    expect(await refused(h.connect("browser=c"))).toBe(429);
    expect(again.ws.readyState).toBe(WebSocket.OPEN);
    const [conn] = h.transport.connections("alice", { role: "browser", browserKeyId: "b" });
    h.transport.close(conn!.id, 1000, "bye");
    const fresh = h.connect("browser=c"); await h.open(4);
    await fresh.ready;
    expect(fresh.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("defaults to 16 browsers and 8 runners", async () => {
    const h = await harness({ pingIntervalMs: 0, helloTimeoutMs: 0 });
    for (let i = 0; i < 8; i++) h.connect(`runner=r${i}`);
    await h.open(8);
    expect(await refused(h.connect("runner=r8"))).toBe(429);
    for (let i = 0; i < 16; i++) h.connect(`browser=b${i}`);
    await h.open(24);
    expect(await refused(h.connect("browser=b16"))).toBe(429);
  });
});

describe("ws transport maximum socket age", () => {
  it("closes a socket at the max age with 1012, which is neither 4409 nor 4401", async () => {
    vi.useFakeTimers(timersOnly);
    const h = await harness({ maxSocketAgeMs: 1000, pingIntervalMs: 0, helloTimeoutMs: 0 });
    const c = h.connect("browser=bk");
    await h.open(1);
    vi.advanceTimersByTime(999);
    expect(h.transport.connections("alice")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.transport.connections("alice")).toEqual([]);
    const code = await c.closed;
    expect(code).toBe(RELAY_CLOSE_MAX_AGE);
    expect(code).toBe(1012);
    expect([RELAY_CLOSE_REPLACED, RELAY_CLOSE_REVOKED]).not.toContain(code);
    await vi.waitFor(() => expect(h.closes.map((x) => x.code)).toEqual([1012]));
  });

  it("does not age out sockets when set to 0, and defaults to 12 hours", async () => {
    vi.useFakeTimers(timersOnly);
    const off = await harness({ maxSocketAgeMs: 0, pingIntervalMs: 0, helloTimeoutMs: 0 });
    off.connect("browser=a");
    await off.open(1);
    vi.advanceTimersByTime(48 * 3_600_000);
    expect(off.transport.connections("alice")).toHaveLength(1);
    const def = await harness({ pingIntervalMs: 0, helloTimeoutMs: 0 });
    def.connect("browser=b");
    await def.open(1);
    vi.advanceTimersByTime(DEFAULT_MAX_SOCKET_AGE_MS - 1);
    expect(def.transport.connections("alice")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(def.transport.connections("alice")).toEqual([]);
  });
});

describe("ws transport liveness", () => {
  it("answers text pings and ignores unsolicited text pongs before the core", async () => {
    const seen: string[] = [];
    let delivered!: () => void; const delivery = new Promise<void>((r) => { delivered = r; });
    const h = await harness({ pingIntervalMs: 0, helloTimeoutMs: 0 }, (_conn, text) => { seen.push(text); delivered(); });
    const c = h.connect("runner=r1"); await h.open(1); await c.ready;
    const pong = new Promise<string>((r) => c.ws.once("message", (data) => r(data.toString())));
    c.ws.send("bridge:pong"); c.ws.send("bridge:ping");
    expect(await pong).toBe("bridge:pong");
    c.ws.send("application frame"); await delivery;
    expect(seen).toEqual(["application frame"]); expect(h.transport.connections("alice")).toHaveLength(1);
  });

  it.each(["data", "text ping", "protocol ping"])("counts inbound %s as liveness when protocol pongs are absent", async (kind) => {
    vi.useFakeTimers(timersOnly);
    let delivered!: () => void;
    const h = await harness({ pingIntervalMs: 1000, helloTimeoutMs: 0 }, () => delivered());
    const c = h.connect("browser=bk", { autoPong: false }); await h.open(1); await c.ready;
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1000);
      if (kind === "data") {
        const received = new Promise<void>((r) => { delivered = r; }); c.ws.send("frame"); await received;
      } else if (kind === "text ping") {
        const pong = new Promise<string>((r) => c.ws.once("message", (data) => r(data.toString())));
        c.ws.send("bridge:ping"); expect(await pong).toBe("bridge:pong");
      } else {
        const pong = new Promise<void>((r) => c.ws.once("pong", () => r())); c.ws.ping(); await pong;
      }
      expect(h.transport.connections("alice")).toHaveLength(1);
    }
    vi.advanceTimersByTime(1000); expect(h.transport.connections("alice")).toHaveLength(1);
    vi.advanceTimersByTime(1000); expect(h.transport.connections("alice")).toEqual([]);
    expect(await c.closed).toBe(1006);
  });

  it("terminates a socket that misses a pong", async () => {
    vi.useFakeTimers(timersOnly);
    const h = await harness({ pingIntervalMs: 1000, helloTimeoutMs: 0 });
    const c = h.connect("browser=bk", { autoPong: false });
    await h.open(1);

    vi.advanceTimersByTime(1000); // ping sent, no pong comes
    expect(h.transport.connections("alice")).toHaveLength(1);
    vi.advanceTimersByTime(1000); // still no pong: dropped
    expect(h.transport.connections("alice")).toEqual([]);
    expect(await c.closed).toBe(1006);
    await vi.waitFor(() => expect(h.closes).toHaveLength(1));
  });

  it("keeps a socket that answers, and reports each pong", async () => {
    vi.useFakeTimers(timersOnly);
    const pongs: string[] = [];
    let onPong: (() => void) | undefined;
    const h = await harness({
      pingIntervalMs: 1000,
      helloTimeoutMs: 0,
      onPong(conn) {
        pongs.push(conn.id);
        onPong?.();
      },
    });
    const c = h.connect("browser=bk");
    const conn = await h.open(1);

    for (let i = 1; i <= 3; i++) {
      const got = new Promise<void>((r) => (onPong = r));
      vi.advanceTimersByTime(1000);
      await got;
      expect(pongs).toHaveLength(i);
    }
    expect(pongs).toEqual([conn.id, conn.id, conn.id]);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    expect(h.transport.connections("alice")).toHaveLength(1);
  });

  it("closes a runner that never greets, with 1008", async () => {
    vi.useFakeTimers(timersOnly);
    const h = await harness({ helloTimeoutMs: 500, pingIntervalMs: 0 });
    const c = h.connect("runner=r1");
    await h.open(1);
    await c.ready;
    vi.advanceTimersByTime(499);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(await c.closed).toBe(1008);
  });

  it("leaves a greeted runner alone, and never times out a browser", async () => {
    vi.useFakeTimers(timersOnly);
    const h = await harness({ helloTimeoutMs: 500, pingIntervalMs: 0 });
    const r = h.connect("runner=r1");
    const conn = await h.open(1);
    const b = h.connect("browser=bk");
    await h.open(2);
    await Promise.all([r.ready, b.ready]);
    h.transport.setState(conn.id, { ...conn.state, greeted: true });
    vi.advanceTimersByTime(5000);
    expect(r.ws.readyState).toBe(WebSocket.OPEN);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("stops its timers on shutdown", async () => {
    vi.useFakeTimers(timersOnly);
    const h = await harness({ pingIntervalMs: 1000, helloTimeoutMs: 500 });
    h.connect("runner=r1");
    await h.open(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await h.transport.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ws transport review fixes", () => {
  it("discards handler calls still queued for a socket the relay closed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    const h = await harness({ helloTimeoutMs: 0, pingIntervalMs: 0 }, async (_conn, text) => {
      seen.push(text);
      if (text === "first") await gate;
    });
    const c = h.connect("runner=r1");
    const conn = await h.open(1);
    await c.ready;
    c.ws.send("first");
    await vi.waitFor(() => expect(seen).toEqual(["first"]));
    c.ws.send("second"); // received and queued behind "first"
    await new Promise((r) => setTimeout(r, 50));
    h.transport.close(conn.id, 4401, "revoked");
    release();
    expect(await c.closed).toBe(4401);
    await vi.waitFor(() => expect(h.closes).toHaveLength(1)); // onClose still runs
    expect(seen).toEqual(["first"]);
  });

  it("discards queued handler calls for a socket the relay terminated on shutdown", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    const h = await harness({ helloTimeoutMs: 0, pingIntervalMs: 0 }, async (_conn, text) => {
      seen.push(text);
      if (text === "first") await gate;
    });
    const c = h.connect("runner=r1");
    await h.open(1);
    await c.ready;
    c.ws.send("first");
    await vi.waitFor(() => expect(seen).toEqual(["first"]));
    c.ws.send("second"); // received and queued behind "first"
    await new Promise((r) => setTimeout(r, 50));
    const down = h.transport.shutdown();
    release();
    await down;
    await vi.waitFor(() => expect(h.closes).toHaveLength(1));
    expect(seen).toEqual(["first"]);
  });

  it("still delivers what a peer sent before it closed itself", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    const h = await harness({ helloTimeoutMs: 0, pingIntervalMs: 0 }, async (_conn, text) => {
      seen.push(text);
      if (text === "first") await gate;
    });
    const c = h.connect("browser=bk");
    await h.open(1);
    await c.ready;
    c.ws.send("first");
    await vi.waitFor(() => expect(seen).toEqual(["first"]));
    c.ws.send("second");
    await new Promise((r) => setTimeout(r, 50));
    c.ws.close(1000);
    await c.closed;
    release();
    await vi.waitFor(() => expect(h.closes).toHaveLength(1));
    expect(seen).toEqual(["first", "second"]);
  });

  it("gives every socket a distinct, increasing connectedAt even within one millisecond", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const h = await harness({ helloTimeoutMs: 0, pingIntervalMs: 0 });
    h.connect("runner=r1");
    h.connect("runner=r1");
    h.connect("runner=r1");
    await h.open(3);
    const stamps = h.opened.map((c) => c.state.connectedAt);
    expect(new Set(stamps).size).toBe(3);
    expect([...stamps].sort()).toEqual(stamps);
  });
});
