import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";

import { RELAY_CLOSE_REPLACED, RELAY_CLOSE_REVOKED, RELAY_SUBPROTOCOL } from "@berdyh/bridge-protocol";
import {
  RELAY_CLOSE_MAX_AGE,
  resolveSocketLimits,
  revokedVerdictFrame,
  type UpgradeVerdict,
  type ConnectionFilter,
  ConnectionState,
  RelayConnection,
  RelayHandler,
  RelayPeer,
  RelayTransport,
  SendResult,
} from "@berdyh/bridge-server";
import { WebSocketServer, type WebSocket } from "ws";

export interface WsRelayTransportOptions {
  /** Largest incoming message in bytes; larger ones are closed with 1009 by `ws`. Default 1 MiB + 64 KiB. */
  maxPayloadBytes?: number;
  /** Largest per-connection queue of unsent bytes before the connection is closed with 1013. Default 4 MiB. */
  maxQueuedBytes?: number;
  /**
   * Keepalive: every this many ms each socket is pinged, and a socket that did not
   * answer the previous ping with a pong is terminated. 0 disables it. Default 30 000.
   */
  pingIntervalMs?: number;
  /** A runner socket that has not completed `hello` (`state.greeted`) after this many ms is closed with 1008. 0 disables it. Default 10 000. */
  helloTimeoutMs?: number;
  /**
   * Longest a socket may live. At that age it is closed with `RELAY_CLOSE_MAX_AGE`
   * (1012), which clients treat as "reconnect with a fresh token". 0 disables it.
   * Default 12 hours (`DEFAULT_MAX_SOCKET_AGE_MS`).
   */
  maxSocketAgeMs?: number;
  /**
   * Most live sockets one user may hold per role (defaults 16 browsers, 8 runners). A
   * further upgrade is answered with HTTP 429 on the raw socket, before `onOpen`. A
   * browser upgrade that replaces a socket with the same `browserKeyId` is not counted
   * against it.
   */
  maxSocketsPerUser?: { browser?: number; runner?: number };
  /**
   * Called on every pong of an open socket. `createNodeBridgeServer` uses it to
   * refresh a runner's `lastSeen` (throttled there); the transport itself keeps no
   * store.
   */
  onPong?(conn: RelayConnection): void;
}

/** The ws-backed transport. Node upgrades happen outside `fetch`, so it exposes `handleUpgrade`. */
export interface WsRelayTransport extends RelayTransport {
  /**
   * Completes an upgrade for an already authorized `peer`. A browser peer replaces
   * the older socket of the same `browserKeyId` (closed with 4409) before `onOpen`.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, peer: RelayPeer): void;
  /**
   * Completes an upgrade only to deliver `verdict`: sends `revokedVerdictFrame` and
   * closes with `RELAY_CLOSE_REVOKED` ("revoked"). The socket is never registered
   * (not in `connections`, no `onOpen`, no per-user cap, nothing replaced), and it is
   * terminated after `VERDICT_LINGER_MS` if the client does not finish the close.
   */
  handleVerdict(request: IncomingMessage, socket: Duplex, head: Buffer, verdict: UpgradeVerdict): void;
  /** Closes every socket and the underlying `WebSocketServer`. */
  shutdown(): Promise<void>;
}

interface Entry {
  conn: { id: string; peer: RelayPeer; state: ConnectionState };
  ws: WebSocket;
  /** Serializes handler calls for this socket, so async handlers see messages in order. */
  chain: Promise<void>;
  /** False between a ping and its pong. */
  alive: boolean;
  /**
   * True once the relay side closed or dropped this socket (revocation, replacement,
   * timeout, backpressure). Handler calls still queued for it are discarded, so a
   * revoked runner's already-received frames are never routed. A peer-initiated close
   * does not set it: what the peer sent before closing is still delivered.
   */
  dead: boolean;
  helloTimer?: ReturnType<typeof setTimeout>;
  ageTimer?: ReturnType<typeof setTimeout>;
}

/** How long a verdict socket may take to finish its close handshake before it is torn down. */
const VERDICT_LINGER_MS = 2_000;

/** A `RelayTransport` on `ws`: sockets live in memory and are dropped on restart. */
export function createWsRelayTransport(options: WsRelayTransportOptions = {}): WsRelayTransport {
  const maxQueued = options.maxQueuedBytes ?? 4 * 1024 * 1024;
  const pingEvery = options.pingIntervalMs ?? 30_000;
  const helloTimeout = options.helloTimeoutMs ?? 10_000;
  const { maxSocketAgeMs: maxAge, maxBrowserSockets, maxRunnerSockets } = resolveSocketLimits(options);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 1024 * 1024 + 64 * 1024,
    handleProtocols: (protocols) => (protocols.has(RELAY_SUBPROTOCOL) ? RELAY_SUBPROTOCOL : false),
  });
  const byUser = new Map<string, Map<string, Entry>>();
  const byId = new Map<string, Entry>();
  let handler: RelayHandler | undefined;
  /** Last connectedAt handed out, in epoch ms; see `nextConnectedAt`. */
  let lastConnectedAt = 0;

  /**
   * The core orders sockets of one runner by `connectedAt`, so two sockets must never
   * share a stamp: it is bumped by a millisecond when the clock has not moved on.
   */
  function nextConnectedAt(): string {
    lastConnectedAt = Math.max(Date.now(), lastConnectedAt + 1);
    return new Date(lastConnectedAt).toISOString();
  }

  let pingTimer: ReturnType<typeof setInterval> | undefined;

  function stopPinging(): void {
    if (pingTimer !== undefined) clearInterval(pingTimer);
    pingTimer = undefined;
  }

  function ensurePinging(): void {
    if (pingTimer !== undefined || pingEvery <= 0) return;
    pingTimer = setInterval(() => {
      for (const entry of [...byId.values()]) {
        if (!entry.alive) {
          drop(entry);
          continue;
        }
        entry.alive = false;
        try {
          entry.ws.ping();
        } catch {
          drop(entry);
        }
      }
    }, pingEvery);
    pingTimer.unref?.();
  }

  function remove(entry: Entry): void {
    if (entry.helloTimer !== undefined) clearTimeout(entry.helloTimer);
    entry.helloTimer = undefined;
    if (entry.ageTimer !== undefined) clearTimeout(entry.ageTimer);
    entry.ageTimer = undefined;
    byId.delete(entry.conn.id);
    const set = byUser.get(entry.conn.peer.userId);
    set?.delete(entry.conn.id);
    if (set && set.size === 0) byUser.delete(entry.conn.peer.userId);
    if (byId.size === 0) stopPinging();
  }

  /**
   * Drops a socket that cannot take a close frame (its send buffer is saturated, or
   * it is not answering): leave the registry and tear the TCP connection down. The
   * `close` event still reports it to the handler.
   */
  function drop(entry: Entry): void {
    entry.dead = true;
    remove(entry);
    entry.ws.terminate();
  }

  function matches(peer: RelayPeer, f: ConnectionFilter): boolean {
    if (f.role !== undefined && peer.role !== f.role) return false;
    if (f.runnerId !== undefined && !(peer.role === "runner" && peer.runnerId === f.runnerId)) return false;
    if (f.browserKeyId !== undefined && !(peer.role === "browser" && peer.browserKeyId === f.browserKeyId)) return false;
    if (f.credentialId !== undefined && !(peer.role === "runner" && peer.credentialId === f.credentialId)) return false;
    return true;
  }

  /** `always` handlers (onClose) run even for a dead socket; the others are skipped once it is. */
  function enqueue(entry: Entry, fn: () => void | Promise<void>, always = false): void {
    entry.chain = entry.chain.then(() => (entry.dead && !always ? undefined : fn())).catch(() => {
      // A throwing handler must not wedge the relay: drop this socket.
      transport.close(entry.conn.id, 1011, "internal error");
    });
  }

  const transport: WsRelayTransport = {
    bind(h) {
      if (handler) throw new Error("relay handler already bound");
      handler = h;
    },
    async accept() {
      // On Node the HTTP server upgrades outside fetch; see handleUpgrade.
      return new Response("Upgrade Required", { status: 426, headers: { upgrade: "websocket" } });
    },
    handleUpgrade(request, socket, head, peer) {
      const sameRole = transport.connections(peer.userId, { role: peer.role }).filter((c) => !(peer.role === "browser" && c.peer.role === "browser" && c.peer.browserKeyId === peer.browserKeyId));
      if (sameRole.length >= (peer.role === "browser" ? maxBrowserSockets : maxRunnerSockets)) {
        const body = "Too many connections";
        socket.end(`HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\nRetry-After: 30\r\n\r\n${body}`);
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        const h = handler;
        if (!h) {
          ws.close(1013, "not ready");
          return;
        }
        if (peer.role === "browser") {
          for (const old of transport.connections(peer.userId, { role: "browser", browserKeyId: peer.browserKeyId })) {
            transport.close(old.id, RELAY_CLOSE_REPLACED, "replaced");
          }
        }
        const entry: Entry = {
          conn: { id: randomUUID(), peer, state: { connectedAt: nextConnectedAt() } },
          ws,
          chain: Promise.resolve(),
          alive: true,
          dead: false,
        };
        byId.set(entry.conn.id, entry);
        const set = byUser.get(peer.userId) ?? new Map<string, Entry>();
        set.set(entry.conn.id, entry);
        byUser.set(peer.userId, set);

        ws.on("message", (data, isBinary) => {
          if (entry.dead) return;
          entry.alive = true;
          if (isBinary) {
            transport.close(entry.conn.id, 1003, "text only");
            return;
          }
          const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as Buffer).toString("utf8");
          if (text === "bridge:ping") { transport.send(entry.conn.id, "bridge:pong"); return; }
          if (text === "bridge:pong") return;
          enqueue(entry, () => h.onMessage(entry.conn, text));
        });
        ws.on("ping", () => { entry.alive = true; });
        ws.on("pong", () => {
          entry.alive = true;
          if (byId.has(entry.conn.id)) options.onPong?.(entry.conn);
        });
        ws.on("error", () => drop(entry));
        ws.on("close", (code, reason) => {
          remove(entry);
          enqueue(entry, () => h.onClose(entry.conn, code, reason.toString("utf8")), true);
        });
        if (peer.role === "runner" && helloTimeout > 0) {
          entry.helloTimer = setTimeout(() => {
            entry.helloTimer = undefined;
            if (entry.conn.state.greeted !== true) transport.close(entry.conn.id, 1008, "hello timeout");
          }, helloTimeout);
          entry.helloTimer.unref?.();
        }
        if (maxAge > 0) {
          // setTimeout caps at ~24.8 days; clamp so a huge setting still fires.
          entry.ageTimer = setTimeout(() => {
            entry.ageTimer = undefined;
            transport.close(entry.conn.id, RELAY_CLOSE_MAX_AGE, "max age");
          }, Math.min(maxAge, 2 ** 31 - 1));
          entry.ageTimer.unref?.();
        }
        ensurePinging();
        enqueue(entry, () => h.onOpen(entry.conn));
      });
    },
    handleVerdict(request, socket, head, verdict) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        // Not an Entry: it is in no registry, so no route, cap, replacement or timer of the transport sees it.
        const timer = setTimeout(() => ws.terminate(), VERDICT_LINGER_MS);
        timer.unref?.();
        ws.on("error", () => ws.terminate());
        ws.on("close", () => clearTimeout(timer));
        try {
          ws.send(revokedVerdictFrame(verdict.runnerId));
          ws.close(RELAY_CLOSE_REVOKED, "revoked");
        } catch {
          ws.terminate();
        }
      });
    },
    send(connectionId, data): SendResult {
      const entry = byId.get(connectionId);
      if (!entry || entry.ws.readyState !== entry.ws.OPEN) return "closed";
      const buffered = entry.ws.bufferedAmount;
      if (buffered + Buffer.byteLength(data) > maxQueued) {
        // A close frame would queue behind the saturated buffer: terminate instead.
        // The core still hears 1013 semantics through the return value.
        drop(entry);
        return "dropped_backpressure";
      }
      entry.ws.send(data, (err) => {
        if (err) drop(entry);
      });
      return buffered > 0 ? "queued" : "sent";
    },
    close(connectionId, code, reason) {
      const entry = byId.get(connectionId);
      if (!entry) return;
      entry.dead = true;
      // Leave the registry now: a closing socket must not receive routed frames.
      // The handler's onClose still runs when the socket's close event fires.
      remove(entry);
      try {
        entry.ws.close(code, Buffer.from(reason).subarray(0, 120).toString("utf8"));
      } catch {
        drop(entry);
      }
    },
    connections(userId, filter = {}): RelayConnection[] {
      const set = byUser.get(userId);
      if (!set) return [];
      return [...set.values()].filter((e) => matches(e.conn.peer, filter)).map((e) => e.conn);
    },
    setState(connectionId, state) {
      const entry = byId.get(connectionId);
      if (!entry) return;
      entry.conn.state = state;
      if (state.greeted === true && entry.helloTimer !== undefined) {
        clearTimeout(entry.helloTimer);
        entry.helloTimer = undefined;
      }
    },
    async disconnect(userId, filter, code, reason) {
      const targets = transport.connections(userId, filter);
      for (const c of targets) transport.close(c.id, code, reason);
      return targets.length;
    },
    async shutdown() {
      stopPinging();
      for (const entry of [...byId.values()]) drop(entry);
      for (const ws of wss.clients) ws.terminate(); // verdict sockets are in no registry
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
  return transport;
}
