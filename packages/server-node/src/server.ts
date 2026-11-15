import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { getRequestListener } from "@hono/node-server";
import {
  createBridgeApp,
  createRelayCoreWithHooks,
  createDeviceService,
  DEFAULT_LAST_SEEN_INTERVAL_MS,
  type BridgeServerConfig,
  type RelayConnection,
  type RelayPeer,
} from "@berdyh/bridge-server";

import { createMemoryDeviceStore } from "./memory-store.js";
import { createStubAuthVerifier } from "./stub-auth.js";
import { createWsRelayTransport, type WsRelayTransport, type WsRelayTransportOptions } from "./ws-transport.js";

/**
 * TEST ONLY. Receives every envelope the relay forwards, as the exact text that
 * was received and sent on, with the two peers. Off by default.
 */
export type TrafficTap = (raw: string, meta: { from: RelayPeer; to: RelayPeer }) => void;

export interface NodeBridgeServerOptions extends Omit<BridgeServerConfig, "adapters" | "origin"> {
  /** Defaults to `http://127.0.0.1:<port>` once the port is known. */
  origin?: string;
  /**
   * Adapters default to the ws transport, the memory store and the stub verifier.
   * On Node the process is the relay context, so `relay` is a full `RelayTransport`:
   * the server builds the core with `createRelayCore(config, relay)` and binds it with
   * `relay.bind(core)`, and passes the same object to `createBridgeApp` as its gateway.
   */
  adapters?: { relay?: WsRelayTransport } & Partial<Omit<BridgeServerConfig["adapters"], "relay">>;
  /** Port to listen on; 0 picks a free one. Default 0. Binds 127.0.0.1. */
  port?: number;
  tap?: TrafficTap;
  /** Keepalive and hello-timeout intervals of the default ws transport. Ignored when `adapters.relay` is given. */
  liveness?: Pick<WsRelayTransportOptions, "pingIntervalMs" | "helloTimeoutMs">;
}

export interface NodeBridgeServer {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  close(): Promise<void>;
}

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`, { method: "GET", headers });
}

async function rejectUpgrade(socket: Duplex, response: Response): Promise<void> {
  const body = await response.text();
  socket.end(
    `HTTP/1.1 ${response.status} ${response.statusText || "Error"}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

/**
 * Starts the core on Node: Hono through `@hono/node-server`, relay sockets through
 * `ws`. The process is the relay context: it builds the core, binds it to the ws
 * transport, and does the WebSocket upgrades itself after `authorizeRelayUpgrade`.
 * Binds 127.0.0.1.
 */
export async function createNodeBridgeServer(options: NodeBridgeServerOptions): Promise<NodeBridgeServer> {
  const { adapters, port = 0, tap, liveness, origin: originOption, ...rest } = options;
  const now = rest.now ?? (() => new Date());
  const seenEvery = rest.lastSeenIntervalMs ?? DEFAULT_LAST_SEEN_INTERVAL_MS;
  const lastAttempt = new WeakMap<object, number>();
  const store = adapters?.store ?? createMemoryDeviceStore();
  const devices = createDeviceService({ store, ...(rest.lastSeenIntervalMs !== undefined ? { lastSeenIntervalMs: rest.lastSeenIntervalMs } : {}), now });
  /** A pong proves a runner is alive: refresh its `lastSeen`. Cuts store calls per connection; the store stays the throttle. */
  const onPong = (conn: RelayConnection): void => {
    if (conn.peer.role !== "runner" || conn.state.greeted !== true) return;
    const t = now().getTime();
    const last = lastAttempt.get(conn);
    if (last !== undefined && t - last < seenEvery) return;
    lastAttempt.set(conn, t);
    devices.recordSeen(conn.peer.userId, conn.peer.runnerId).catch(() => {});
  };
  const relay: WsRelayTransport =
    adapters?.relay ??
    createWsRelayTransport({
      ...(rest.maxQueuedBytes !== undefined ? { maxQueuedBytes: rest.maxQueuedBytes } : {}),
      ...(rest.maxEnvelopeBytes !== undefined ? { maxPayloadBytes: rest.maxEnvelopeBytes + 64 * 1024 } : {}),
      ...(rest.maxSocketAgeMs !== undefined ? { maxSocketAgeMs: rest.maxSocketAgeMs } : {}),
      ...(rest.maxSocketsPerUser !== undefined ? { maxSocketsPerUser: rest.maxSocketsPerUser } : {}),
      ...(liveness ?? {}),
      onPong,
    });
  const verifier = adapters?.verifier ?? createStubAuthVerifier({ browser: {}, runner: {} });

  let host: ReturnType<typeof createBridgeApp> | undefined;
  const http = createServer(getRequestListener((req) => (host ? host.fetch(req) : new Response("starting", { status: 503 }))));
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => resolve());
  });
  const boundPort = (http.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${boundPort}`;

  const config: BridgeServerConfig = { ...rest, origin: originOption ?? url, adapters: { relay, store, verifier } };
  try {
    host = createBridgeApp(config);
    relay.bind(createRelayCoreWithHooks(config, relay, tap ? { onForward: tap } : {}));
  } catch (error) {
    // Discovery validation runs once the bound origin is known. A rejected config
    // must not leave the listening server or the transport's timers behind.
    try { await relay.shutdown(); } finally {
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    }
    throw error;
  }

  http.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    void (async () => {
      const auth = await host!.authorizeRelayUpgrade(toRequest(req));
      if (!auth.ok) {
        // A revoked runner gets the verdict (a socket that sends `revoked` and closes, never registered); anything else the refusal.
        if (auth.verdict) return relay.handleVerdict(req, socket, head, auth.verdict);
        return rejectUpgrade(socket, auth.response);
      }
      relay.handleUpgrade(req, socket, head, auth.peer);
    })().catch(() => socket.destroy());
  });

  return {
    url,
    async close() {
      await relay.shutdown();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    },
  };
}
