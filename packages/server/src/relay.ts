import {
  PROTOCOL_RANGE,
  RELAY_CLOSE_REVOKED,
  RELAY_CLOSE_REPLACED,
  boundedHostname,
  isRelayEnvelope,
  isRunnerHello,
  type ControlBody,
  type PresenceBody,
  type RelayEnvelope,
  type RelayKind,
  type RelayRole,
} from "@berdyh/bridge-protocol";

import type {
  BridgeServerConfig,
  RelayConnection,
  RelayHandler,
  RelayPeer,
  RelayTransport,
  SendResult,
  UpgradeVerdict,
} from "./contracts.js";
import { createDeviceService, DEFAULT_LAST_SEEN_INTERVAL_MS, type DeviceService } from "./devices.js";
import { negotiateHandshake } from "./handshake.js";

const DEFAULT_MAX_ENVELOPE_BYTES = 1024 * 1024;
/** Bounds on the agents a runner's `hello` reports: they are kept in the socket state, which
 *  the Cloudflare transport persists in a size-limited WebSocket attachment. */
const MAX_REPORTED_AGENTS = 32;
const MAX_AGENT_ID_LENGTH = 64;

/** Only `{ id, available }`, bounded in count and id length; anything else a runner sent is dropped. */
function boundedAgents(agents: PresenceBody["agents"]): PresenceBody["agents"] {
  if (!agents) return undefined;
  return agents
    .filter((a) => a.id.length <= MAX_AGENT_ID_LENGTH)
    .slice(0, MAX_REPORTED_AGENTS)
    .map((a) => ({ id: a.id, available: a.available }));
}

/** `runnerId` placed on relay-originated envelopes to a browser when no runner is involved. */
export const RELAY_SELF_ID = "relay";

/**
 * The text message of the revoked verdict: the same relay control envelope the core
 * sends after a revoked upsert (`closeWithError`). Adapters send it, then close with
 * `RELAY_CLOSE_REVOKED` and reason "revoked", for `UpgradeVerdict`.
 */
export function revokedVerdictFrame(runnerId: UpgradeVerdict["runnerId"]): string {
  const envelope: RelayEnvelope = { to: "runner", runnerId, kind: "control", body: { type: "revoked", runnerId } };
  return JSON.stringify(envelope);
}

/**
 * TEST SEAM. Called for every `frame` or `pake` envelope the relay forwards, with
 * the exact text that was received and the two peers. Not part of the runtime
 * contract; `createNodeBridgeServer({ tap })` uses it.
 */
export interface RelayHooks {
  onForward?(raw: string, meta: { from: RelayPeer; to: RelayPeer }): void;
}

/**
 * The runtime-independent relay: handshake, routing by `(userId, runnerId)` and
 * `(userId, browserKeyId)`, presence, `peer_reconnected`, size and backpressure
 * limits. It reads envelope headers and the runner `hello` only, and forwards
 * `body` byte-identical. It never routes across users.
 *
 * `transport` is the relay context's own transport, passed explicitly because
 * `config.adapters.relay` is only a `RelayGateway` (on Workers it is the Worker's
 * forwarder, not the Durable Object's transport). The caller binds the result with
 * `transport.bind(handler)`, once: `createNodeBridgeServer` on Node, the Durable
 * Object's constructor on Workers. This function does not bind.
 */
export function createRelayCore(config: BridgeServerConfig, transport: RelayTransport): RelayHandler {
  return createRelayCoreWithHooks(config, transport, {});
}

/** `createRelayCore` plus the test seam. */
export function createRelayCoreWithHooks(config: BridgeServerConfig, transport: RelayTransport, hooks: RelayHooks): RelayHandler {
  const { store } = config.adapters;
  const server = config.protocol ?? PROTOCOL_RANGE;
  const maxBytes = config.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES;
  const now = config.now ?? (() => new Date());
  const encoder = new TextEncoder();
  const devices: DeviceService = createDeviceService({
    store,
    ...(config.lastSeenIntervalMs !== undefined ? { lastSeenIntervalMs: config.lastSeenIntervalMs } : {}),
    now,
  });

  /** Per-connection time of the last `recordSeen` attempt; only cuts store calls, the store stays the throttle. */
  const seenAttempt = new Map<string, number>();
  const seenEvery = config.lastSeenIntervalMs ?? DEFAULT_LAST_SEEN_INTERVAL_MS;

  /** Refreshes `lastSeen` from live runner traffic, off the forwarding path. */
  function touchFromTraffic(conn: RelayConnection, userId: string, runnerId: string): void {
    const t = now().getTime();
    const last = seenAttempt.get(conn.id);
    if (last !== undefined && t - last < seenEvery) return;
    seenAttempt.set(conn.id, t);
    devices.recordSeen(userId, runnerId).catch(() => {});
  }

  // ---- helpers over transport.connections(): the core keeps no state of its own.

  const greetedRunners = (userId: string, runnerId?: string): RelayConnection[] =>
    transport
      .connections(userId, { role: "runner", ...(runnerId !== undefined ? { runnerId } : {}) })
      .filter((c) => c.state.greeted === true);

  const browsers = (userId: string, browserKeyId?: string): RelayConnection[] =>
    transport.connections(userId, { role: "browser", ...(browserKeyId !== undefined ? { browserKeyId } : {}) });

  /** The newest greeted runner connection for a runnerId. */
  function pickRunner(userId: string, runnerId: string): RelayConnection | undefined {
    let best: RelayConnection | undefined;
    for (const c of greetedRunners(userId, runnerId)) {
      if (!best || c.state.connectedAt >= best.state.connectedAt) best = c;
    }
    return best;
  }

  function envelopeText(env: RelayEnvelope): string {
    return JSON.stringify(env);
  }

  /** Sends a relay-originated envelope (`control` or `presence`) addressed to `target`. */
  function sendFromRelay(target: RelayConnection, kind: "control" | "presence", runnerId: string, body: ControlBody | PresenceBody): SendResult {
    const peer = target.peer;
    const env: RelayEnvelope =
      peer.role === "runner"
        ? { to: "runner", runnerId: peer.runnerId, kind, body }
        : { to: "browser", runnerId, browserKeyId: peer.browserKeyId, kind, body };
    return transport.send(target.id, envelopeText(env));
  }

  const control = (target: RelayConnection, runnerId: string, body: ControlBody): SendResult =>
    sendFromRelay(target, "control", runnerId, body);

  function closeWithError(conn: RelayConnection, code: number, reason: string, body: ControlBody, runnerId = RELAY_SELF_ID): void {
    control(conn, runnerId, body);
    transport.close(conn.id, code, reason);
  }

  async function presenceBody(userId: string, runnerId: string, online: boolean, agents?: PresenceBody["agents"], hostname?: string): Promise<PresenceBody> {
    const device = await store.getDevice(userId, runnerId);
    return {
      runnerId,
      online,
      lastSeen: online ? (device?.lastSeen ?? now().toISOString()) : now().toISOString(),
      ...(device?.runnerVersion ? { runnerVersion: device.runnerVersion } : {}),
      ...(online && agents ? { agents } : {}),
      ...(online && hostname !== undefined ? { hostname } : {}),
    };
  }

  // ---- lifecycle

  async function onOpen(conn: RelayConnection): Promise<void> {
    if (conn.peer.role === "runner") return; // nothing is routed until `hello`
    const { userId, browserKeyId } = conn.peer;
    for (const runner of greetedRunners(userId)) {
      const runnerId = (runner.peer as { runnerId: string }).runnerId;
      control(conn, runnerId, { type: "peer_reconnected", peer: "runner", runnerId });
      sendFromRelay(conn, "presence", runnerId, await presenceBody(userId, runnerId, true, runner.state.agents, runner.state.hostname));
      control(runner, runnerId, { type: "peer_reconnected", peer: "browser", runnerId, browserKeyId });
    }
  }

  async function onHello(conn: RelayConnection, peer: Extract<RelayPeer, { role: "runner" }>, data: string): Promise<void> {
    if (conn.state.greeted) return closeWithError(conn, 1008, "duplicate hello", { type: "error", code: "bad_envelope", message: "hello was already sent" }, peer.runnerId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return closeWithError(conn, 1008, "hello expected", { type: "error", code: "bad_envelope", message: "The first message must be hello." }, peer.runnerId);
    }
    if (!isRunnerHello(parsed)) {
      return closeWithError(conn, 1008, "hello expected", { type: "error", code: "bad_envelope", message: "The first message must be hello." }, peer.runnerId);
    }
    const hello = parsed;
    if (hello.runnerId !== peer.runnerId) {
      return closeWithError(conn, 1008, "runner id mismatch", { type: "error", code: "unauthorized", message: "hello.runnerId differs from the socket's runnerId." }, peer.runnerId);
    }
    const outcome = negotiateHandshake(hello, server, config.latestRunnerVersion);
    if (!outcome.ok) {
      return closeWithError(conn, 1008, outcome.reply.type, outcome.reply, peer.runnerId);
    }

    const stamp = now().toISOString();
    const hostname = boundedHostname(hello.hostname);
    const upsert = await store.upsertDevice(
      {
        userId: peer.userId,
        deviceId: peer.runnerId,
        hostname: hostname ?? "unknown",
        os: hello.os ?? "unknown",
        runnerVersion: hello.runnerVersion,
        createdAt: stamp,
        lastSeen: stamp,
      },
      peer.credentialId,
      // Only a store that can look fingerprints up gets a third argument (the peer carries one only then).
      ...(peer.credentialFingerprint !== undefined ? [peer.credentialFingerprint] : []),
    );
    if (upsert !== "ok") {
      return closeWithError(conn, RELAY_CLOSE_REVOKED, "revoked", { type: "revoked", runnerId: peer.runnerId }, peer.runnerId);
    }

    // The store awaits above let this socket be closed (hello timeout, revocation, a
    // replacement): a socket that left the transport must not greet, and above all must
    // not close a healthy older socket as "replaced".
    if (!transport.connections(peer.userId, { role: "runner", runnerId: peer.runnerId }).some((c) => c.id === conn.id)) return;
    // The store awaits above let other handshakes finish: a newer greeted socket of this
    // runner means this one is the stale one, and it must not evict the newer one.
    if (greetedRunners(peer.userId, peer.runnerId).some((c) => c.id !== conn.id && c.state.connectedAt > conn.state.connectedAt)) {
      transport.close(conn.id, RELAY_CLOSE_REPLACED, "replaced");
      return;
    }
    const agents = boundedAgents(hello.agents);
    transport.setState(conn.id, {
      ...conn.state,
      greeted: true,
      protocol: outcome.welcome.protocol,
      ...(agents ? { agents } : {}),
      ...(hostname !== undefined ? { hostname } : {}),
    });
    // A newer socket of the same runner supersedes older ones (half-open leftovers).
    for (const old of greetedRunners(peer.userId, peer.runnerId)) {
      if (old.id !== conn.id && old.state.connectedAt < conn.state.connectedAt) transport.close(old.id, RELAY_CLOSE_REPLACED, "replaced");
    }
    seenAttempt.set(conn.id, now().getTime());
    // The welcome is the runner's own handshake answer, not a routed envelope.
    transport.send(conn.id, JSON.stringify(outcome.welcome));
    await devices.recordSeen(peer.userId, peer.runnerId);

    const presence = await presenceBody(peer.userId, peer.runnerId, true, agents, hostname);
    for (const browser of browsers(peer.userId)) {
      const bk = (browser.peer as { browserKeyId: string }).browserKeyId;
      sendFromRelay(browser, "presence", peer.runnerId, presence);
      control(browser, peer.runnerId, { type: "peer_reconnected", peer: "runner", runnerId: peer.runnerId });
      control(conn, peer.runnerId, { type: "peer_reconnected", peer: "browser", runnerId: peer.runnerId, browserKeyId: bk });
    }
  }

  async function onMessage(conn: RelayConnection, data: string): Promise<void> {
    const peer = conn.peer;
    if (encoder.encode(data).byteLength > maxBytes) {
      return closeWithError(conn, 1009, "too large", { type: "error", code: "bad_envelope", message: "Envelope too large." }, peer.role === "runner" ? peer.runnerId : RELAY_SELF_ID);
    }
    if (peer.role === "runner" && !conn.state.greeted) return onHello(conn, peer, data);
    if (peer.role === "runner") touchFromTraffic(conn, peer.userId, peer.runnerId);

    // Header check only. `body` is never inspected; `data` is forwarded as received.
    let env: unknown;
    try {
      env = JSON.parse(data);
    } catch {
      return reject(conn, RELAY_SELF_ID, "Not JSON.");
    }
    if (!isRelayEnvelope(env)) return reject(conn, RELAY_SELF_ID, "Not a relay envelope.");
    const kind: RelayKind = env.kind;
    if (kind !== "frame" && kind !== "pake") return; // presence and control are relay-originated: dropped

    if (peer.role === "browser") {
      if (env.to !== "runner" || env.browserKeyId !== peer.browserKeyId) {
        return reject(conn, env.runnerId, "Envelope addressing does not match this socket.");
      }
      const target = pickRunner(peer.userId, env.runnerId);
      if (!target) return peerAbsent(conn, peer.userId, env.runnerId, "runner", undefined);
      return forward(conn, target, data);
    }

    // runner
    if (env.to !== "browser" || env.runnerId !== peer.runnerId || !env.browserKeyId) {
      return reject(conn, peer.runnerId, "Envelope addressing does not match this socket.");
    }
    const bks = browsers(peer.userId, env.browserKeyId);
    const target = bks[bks.length - 1];
    if (!target) return peerAbsent(conn, peer.userId, peer.runnerId, "browser", env.browserKeyId);
    return forward(conn, target, data);
  }

  function reject(conn: RelayConnection, runnerId: string, message: string): void {
    control(conn, runnerId, { type: "error", code: "bad_envelope", message });
  }

  async function peerAbsent(conn: RelayConnection, userId: string, runnerId: string, peer: RelayRole, browserKeyId: string | undefined): Promise<void> {
    if (peer === "runner" && !(await store.getDevice(userId, runnerId))) {
      control(conn, runnerId, { type: "error", code: "unknown_runner", message: "No such runner." });
      return;
    }
    control(conn, runnerId, { type: "peer_gone", peer, runnerId, ...(browserKeyId ? { browserKeyId } : {}) });
  }

  function forward(from: RelayConnection, to: RelayConnection, data: string): void {
    if (from.peer.userId !== to.peer.userId) return; // never across users (defense in depth)
    const result = transport.send(to.id, data);
    if (result === "closed") {
      const runnerId = from.peer.role === "runner" ? from.peer.runnerId : (to.peer as { runnerId: string }).runnerId;
      const other = from.peer.role === "runner" ? "browser" : "runner";
      control(from, runnerId, {
        type: "peer_gone",
        peer: other,
        runnerId,
        ...(to.peer.role === "browser" ? { browserKeyId: to.peer.browserKeyId } : {}),
      });
      return;
    }
    if (result === "dropped_backpressure") {
      control(from, from.peer.role === "runner" ? from.peer.runnerId : (to.peer as { runnerId: string }).runnerId, {
        type: "error",
        code: "backpressure",
        message: "The peer was too slow and was disconnected.",
      });
      return;
    }
    hooks.onForward?.(data, { from: from.peer, to: to.peer });
  }

  async function onClose(conn: RelayConnection, _code: number, _reason: string): Promise<void> {
    const peer = conn.peer;
    if (peer.role === "runner") {
      seenAttempt.delete(conn.id);
      if (!conn.state.greeted) return;
      if (pickRunner(peer.userId, peer.runnerId)) return; // a newer socket of this runner is live
      await devices.recordSeen(peer.userId, peer.runnerId);
      const presence = await presenceBody(peer.userId, peer.runnerId, false);
      // Re-check after the store awaits: a runner that reconnected meanwhile is not offline.
      if (pickRunner(peer.userId, peer.runnerId)) return;
      for (const browser of browsers(peer.userId)) {
        sendFromRelay(browser, "presence", peer.runnerId, presence);
        control(browser, peer.runnerId, { type: "peer_gone", peer: "runner", runnerId: peer.runnerId });
      }
      return;
    }
    if (browsers(peer.userId, peer.browserKeyId).length > 0) return; // replaced by a newer socket
    for (const runner of greetedRunners(peer.userId)) {
      const runnerId = (runner.peer as { runnerId: string }).runnerId;
      control(runner, runnerId, { type: "peer_gone", peer: "browser", runnerId, browserKeyId: peer.browserKeyId });
    }
  }

  return { onOpen, onMessage, onClose };
}
