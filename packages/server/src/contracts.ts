/**
 * Contracts of the bridge server kit. The core (`@berdyh/bridge-server`) has no
 * runtime dependency beyond Hono and depends only on the interfaces below; each
 * deployment choice sits behind one of them.
 *
 * Who calls whom:
 *
 *   HttpHost (core, built by createBridgeApp) ── authenticates ──► AuthVerifier
 *      │  /relay/* upgrade                                       DeviceStore ◄── device API
 *      ▼
 *   RelayGateway.accept(request, peer)           (adapter: ws on Node, a Durable Object on Workers)
 *      │  socket events
 *      ▼
 *   RelayHandler (core, built by createRelayCore) ── routes ──► RelayTransport.send(...)
 *
 * The relay is blind: it reads the `RelayEnvelope` header and the runner `hello`,
 * and forwards `body` untouched.
 *
 * Which context runs what. Relay state lives in one per-user relay context: on
 * Workers that is the user's Durable Object, on Node the process. The type split
 * mirrors it:
 *  - `RelayGateway` (`accept`, `disconnect`) is all the `HttpHost` routes use. Both
 *    members are asynchronous and addressed by `userId`, so they work from either
 *    context. `createBridgeApp` takes a `RelayGateway`, builds HTTP only, and never
 *    binds anything: on Workers it runs in the stateless Worker, whose gateway is a
 *    thin forwarder to the Durable Object.
 *  - `RelayTransport extends RelayGateway` adds the synchronous socket members
 *    (`bind`, `connections`, `send`, `setState`, `close`). Only the relay context
 *    has one. Its owner calls `createRelayCore(config, transport)` and then
 *    `transport.bind(core)`: `createNodeBridgeServer` does that on Node, the
 *    Durable Object's constructor does it on Workers. No adapter member exists
 *    just to throw.
 */
import type {
  AgentAvailability,
  BridgeDiscovery,
  DeviceRecord,
  ProtocolRange,
  RelayRole,
} from "@berdyh/bridge-protocol";

/** The authenticated identity of one relay socket. JSON-serializable and small (the Cloudflare adapter keeps it in the socket attachment, limit 16 KB). */
export type RelayPeer =
  | {
      role: "runner";
      userId: string;
      /** `DeviceRecord.deviceId`; the socket's `runnerId` query parameter, checked against the device store. */
      runnerId: string;
      /** `Principal.credentialId` of the credential that opened the socket, if the verifier gave one. */
      credentialId?: string;
      /**
       * `tokenFingerprint` of the token that opened the socket, set only when the store can look fingerprints up
       * (`DeviceStore.revokedCredentialByFingerprint`) and the verifier gave a `credentialId`. A hash, never the token.
       */
      credentialFingerprint?: string;
    }
  | {
      role: "browser";
      userId: string;
      /** The id the browser opened the socket with; every envelope it sends must carry the same `browserKeyId`. */
      browserKeyId: string;
    };

/** Per-connection state the core keeps. Must survive the transport hibernating, so it lives in the transport (`RelayTransport.setState`). */
export interface ConnectionState {
  /** ISO 8601. */
  connectedAt: string;
  /** Runner only: true once a valid `hello` was accepted. No envelope is routed before that. */
  greeted?: boolean;
  /** The protocol version negotiated for this connection. */
  protocol?: number;
  /** Runner only: the agents its `hello` reported, repeated in the presence sent to browsers that connect later. */
  agents?: AgentAvailability[];
  /** Runner only: `boundedHostname(hello.hostname)`, repeated in presence like `agents`. */
  hostname?: string;
}

/** One accepted socket, by an id that is unique for the lifetime of the deployment. */
export interface RelayConnection {
  readonly id: string;
  readonly peer: RelayPeer;
  readonly state: ConnectionState;
}

export type SendResult =
  /** Handed to the socket. */
  | "sent"
  /** Accepted into the per-connection queue; the socket is slow. */
  | "queued"
  /** The queue is over its byte limit and the connection was closed (code 1013). Frames are lost; the endpoints resend after reconnect. */
  | "dropped_backpressure"
  /** No such open connection. */
  | "closed";

/** Which connections of a user to list. Omitted fields match anything. */
export interface ConnectionFilter {
  role?: RelayRole;
  runnerId?: string;
  browserKeyId?: string;
  /** Matches runner sockets opened with this credential (`RelayPeer.credentialId`). Used when a revoked device's credential may be held by sockets under other runner ids. */
  credentialId?: string;
}

/**
 * Events the transport reports to the core. `data` is the text frame exactly as
 * received; binary frames are closed with code 1003 by the transport.
 */
export interface RelayHandler {
  onOpen(connection: RelayConnection): void | Promise<void>;
  onMessage(connection: RelayConnection, data: string): void | Promise<void>;
  onClose(connection: RelayConnection, code: number, reason: string): void | Promise<void>;
}

/**
 * The two members `HttpHost` routes use, callable from ANY context (Worker or
 * relay context). Both are asynchronous and addressed by `userId`.
 *
 * One browser socket per `browserKeyId`. When `accept` is given a browser peer
 * whose `browserKeyId` already has an open socket for that user, the older socket
 * is closed with `RELAY_CLOSE_REPLACED` (4409) before the new one is registered. The
 * adapter does this wherever it registers a new browser socket (`accept` on
 * Workers, the upgrade handler on Node), before it calls `RelayHandler.onOpen`.
 */
export interface RelayGateway {
  /**
   * Completes a WebSocket upgrade for an already authenticated `peer`. Resolves to
   * the HTTP response to return (101 on Workers). On runtimes where the HTTP server
   * performs upgrades outside `fetch` (Node), the adapter does it there and `accept`
   * resolves to a 426 for a plain fetch call.
   */
  accept(request: Request, peer: RelayPeer): Promise<Response>;
  /**
   * Closes every open connection of `userId` matching `filter` and resolves to how
   * many it closed (0 when none matched, which is not an error). This is how the
   * device-revoke route closes the runner's socket: `disconnect(userId, { role:
   * "runner", runnerId }, RELAY_CLOSE_REVOKED, "revoked")`, then once more per revoked credential
   * id (`{ role: "runner", credentialId }`) to catch sockets the same credential
   * opened under other runner ids. On Workers it is a single call into
   * the user's Durable Object. The core's `onClose` still runs for each closed
   * socket, inside the relay context.
   */
  disconnect(userId: string, filter: ConnectionFilter, code: number, reason: string): Promise<number>;
  /**
   * Optional. Completes a WebSocket upgrade only to deliver `verdict` (see
   * `UpgradeVerdict`): the adapter sends `revokedVerdictFrame(verdict.runnerId)` as one
   * text message and closes with `RELAY_CLOSE_REVOKED` and reason "revoked", and
   * resolves to the HTTP response to return (101 on Workers). The socket is never
   * registered: it is not in `connections`, replaces nothing, never reaches
   * `RelayHandler.onOpen`, and does not wait for the client to answer the close. An
   * adapter that cannot do this leaves the method out; `createBridgeApp` then keeps the
   * 403 response of the failed authorization. On Workers it runs in the stateless
   * Worker and does not touch the user's Durable Object. On Node the upgrade happens
   * outside `fetch` (`WsRelayTransport.handleVerdict`), so the ws transport leaves
   * it out.
   */
  acceptVerdict?(request: Request, verdict: UpgradeVerdict): Promise<Response>;
}

/**
 * Accepts and owns WebSockets, and delivers raw text to the core. The core never
 * touches a socket. This is the relay context's full view; the Worker only ever
 * holds a `RelayGateway`.
 *
 * Reconnect and replay. A transport does not buffer messages for absent peers: a
 * `send` to a connection that is gone returns "closed" and the message is lost.
 * Endpoints cope by replaying frames by `seq` after the peer returns. The core
 * helps by sending `peer_reconnected` control envelopes. This holds for every
 * adapter, because a Node restart and a Durable Object deploy both drop sockets.
 *
 * Hibernation. An adapter may evict its in-memory objects between events. The core
 * therefore keeps no state outside `ConnectionState` (via `setState`) and the
 * `DeviceStore`, and re-derives everything else from `connections()`.
 *
 * Context. Every member beyond `RelayGateway` is called only from inside the
 * per-user relay context and may be synchronous there.
 */
export interface RelayTransport extends RelayGateway {
  /** Registers the core's handler. Called once by the relay context's owner, before any `accept`. */
  bind(handler: RelayHandler): void;
  /** Queues `data` (one text message) for the connection. Never throws. */
  send(connectionId: string, data: string): SendResult;
  /** Closes the connection. Idempotent. */
  close(connectionId: string, code: number, reason: string): void;
  /** Open connections of `userId`. */
  connections(userId: string, filter?: ConnectionFilter): RelayConnection[];
  /** Replaces the persisted state of a connection. */
  setState(connectionId: string, state: ConnectionState): void;
}

/**
 * An answer for a runner whose token verified but whose runner id or credential is
 * revoked. A bare HTTP 403 carries no WebSocket close code, so a runner that was offline
 * at revoke could not tell "revoked" from "refused": it gets this verdict instead.
 */
export interface UpgradeVerdict {
  type: "revoked";
  /** The runner id the upgrade asked for; it is what the `revoked` control names. */
  runnerId: string;
}

/**
 * Result of authorizing a socket upgrade: the identity, or the response to send
 * instead. A failure may also carry a `verdict` (additive): a host
 * that can deliver it accepts the upgrade only to send the verdict and close (see
 * `RelayGateway.acceptVerdict`) and never registers the socket as a peer; a host that
 * cannot, or does not know the field, answers with `response` (403) as before.
 * A `verdict` is only ever set after the token verified.
 */
export type UpgradeAuthorization =
  | { ok: true; peer: RelayPeer }
  | { ok: false; response: Response; verdict?: UpgradeVerdict };

/**
 * The core's HTTP surface. It is a plain fetch handler, so each runtime mounts it
 * its own way (Workers: `export default { fetch }`; Node: `@hono/node-server`).
 *
 * Routes:
 *  - `GET /.well-known/bridge.json`: the `BridgeDiscovery` built from the config.
 *  - Device API (browser session auth): list devices, revoke one (closes its
 *    socket with `RelayGateway.disconnect`, never `connections` + `close`), last
 *    seen.
 *
 * HTTP routes use only `RelayGateway.accept` and `RelayGateway.disconnect`.
 *  - `GET /relay/runner` and `GET /relay/browser`: WebSocket upgrades, authorized by
 *    `authorizeRelayUpgrade` and then handed to `RelayGateway.accept`.
 */
export interface HttpHost {
  fetch(request: Request): Promise<Response>;
  /**
   * Authenticates a relay upgrade request without performing it, for runtimes that
   * upgrade outside `fetch`. The token is the `Authorization: Bearer` header or a
   * `bearer.<token>` entry of `Sec-WebSocket-Protocol`. Checks: token valid
   * (`AuthVerifier`), browser `Origin` allowed (`allowedBrowserOrigins`), runner
   * device not revoked (`DeviceStore.isRevoked`), runner credential not revoked
   * (`DeviceStore.isCredentialRevoked`, when the verifier gave a `credentialId`),
   * required query parameter present.
   * Failures are 401, 403 or 400 responses; the body is a short generic text. A revoked
   * runner id or credential (token valid) is a failure with a 403 `response` and a
   * `verdict` of "revoked".
   */
  authorizeRelayUpgrade(request: Request): Promise<UpgradeAuthorization>;
}

/** Outcome of `DeviceStore.upsertDevice`. */
export type UpsertResult =
  /** Stored. */
  | "ok"
  /** The device id is revoked; nothing was stored. */
  | "revoked"
  /** The credential is revoked (it belonged to a revoked device); nothing was stored. */
  | "credential_revoked";

/** What `DeviceStore.revokeDevice` reports for a device that existed. */
export interface RevokeResult {
  /**
   * Every credential id that was ever bound to the device through `upsertDevice`
   * (and is now revoked in the store). The caller hands them to
   * `AuthVerifier.revokeRunnerCredentials`.
   */
  credentialIds: string[];
  /**
   * True when the device was already revoked before this call. The result then still
   * carries the bound credential ids, so a retried revoke can finish the socket close
   * and the identity-provider revoke that a partial failure left undone.
   */
  alreadyRevoked?: boolean;
}

/**
 * Runner device records. All methods are scoped by `userId`: no method returns or
 * changes another user's rows.
 *
 * The store is also the durable device-to-credential association. A runner
 * credential is issued to a user, not to a device, so the only moment the two
 * meet is the runner's `hello` on a socket: the core then calls `upsertDevice`
 * with `Principal.credentialId`, and the store remembers it for that device.
 */
export interface DeviceStore {
  getDevice(userId: string, deviceId: string): Promise<DeviceRecord | undefined>;
  /** Live (not revoked) devices of the user, newest first. */
  listDevices(userId: string): Promise<DeviceRecord[]>;
  /**
   * Creates the record or updates hostname, os and runnerVersion, keeping
   * `createdAt`, and adds `credentialId` (when given) to the device's set of
   * credentials. Refuses a revoked device id and a revoked credential id.
   *
   * `fingerprint` (optional, additive): the `tokenFingerprint` (lowercase hex SHA-256) of the
   * runner token that authenticated this hello. A store that implements
   * `revokedCredentialByFingerprint` records it with the credential binding (the newest one wins) and never
   * anything else of the token; the core passes it only to such a store, and only together with a `credentialId`.
   */
  upsertDevice(record: DeviceRecord, credentialId?: string, fingerprint?: string): Promise<UpsertResult>;
  /**
   * Sets `lastSeen` to `at`, but only if the stored `lastSeen` is older than
   * `at - minIntervalMs`; resolves to whether it wrote. The comparison and the write
   * are ONE atomic store operation (a conditional `UPDATE ... WHERE last_seen <=
   * $at - interval`), because the core calls this from several connections and
   * Durable Object instances at once and cannot throttle from its own memory.
   * Resolves to false for an unknown or revoked device.
   */
  touchLastSeen(userId: string, deviceId: string, at: string, minIntervalMs: number): Promise<boolean>;
  /**
   * Revokes the id for good: the record disappears from `listDevices`, `isRevoked`
   * answers true and `upsertDevice` refuses it. Every credential bound to the device
   * is marked revoked too (`isCredentialRevoked`), whichever `runnerId` presents it
   * later. Idempotent: for a device that is already revoked it resolves to the same
   * credential ids with `alreadyRevoked: true`. Resolves to undefined only if the
   * device was never known.
   */
  revokeDevice(userId: string, deviceId: string): Promise<RevokeResult | undefined>;
  isRevoked(userId: string, deviceId: string): Promise<boolean>;
  /** True when `credentialId` was bound to a device that has been revoked. */
  isCredentialRevoked(userId: string, credentialId: string): Promise<boolean>;
  /**
   * Optional (additive). Which credential, bound to a REVOKED device, last authenticated with a token whose
   * `tokenFingerprint` is `fingerprint`; undefined for an unknown fingerprint and for a credential whose devices are
   * all live. It lets the relay give the revoked verdict to a runner that was offline so long that the identity
   * provider no longer even reports its key as revoked (Clerk answers 404 about a minute after a revoke). A credential
   * bound before the store recorded fingerprints has none and is not found (the runner then gets today's 401). A
   * store without this method keeps the 401 for every refused token. Never reveals a device: it answers
   * `{ userId, credentialId }` only.
   */
  revokedCredentialByFingerprint?(fingerprint: string): Promise<{ userId: string; credentialId: string } | undefined>;
}

/** A verified caller. */
export interface Principal {
  /** Stable user id of the app's user. Every route and the device store scope by it. */
  userId: string;
  /**
   * Runner credentials only: the id of the credential that authenticated the call,
   * never the secret. It must be stable across the refreshes of one credential (the
   * OAuth grant or session id, or the API key id; not a per-token `jti` that changes
   * on every refresh) and different for different credentials, so that revoking a
   * device can find and kill what that device holds. Absent when the identity
   * provider has no such id; revocation of that credential is then limited to the
   * device id (see `AuthVerifier`).
   */
  credentialId?: string;
  /**
   * `verifyRunner` only (additive): the credential is authentic but
   * revoked at the identity provider (a revoked API key, a revoked grant), with a valid
   * `userId` and the `credentialId` it had. It lets the relay answer a runner that was
   * offline at revoke with the revoked verdict instead of a 401 it cannot tell from "bad
   * token". A principal marked `revoked` is never usable for anything else: no route
   * accepts it, and `createBridgeApp` gives it the verdict only when
   * `DeviceStore.isCredentialRevoked(userId, credentialId)` confirms the revoke, and a 401
   * otherwise. An unknown, forged, expired or malformed token is still `undefined`.
   * `verifyBrowser` never returns it.
   */
  revoked?: true;
}

/**
 * Verifies bearer tokens. Both methods resolve to undefined for a bad, expired or
 * wrongly scoped token (`verifyRunner` may instead report an authentic but revoked
 * credential, see `Principal.revoked`), and reject only for infrastructure failures (which the core
 * turns into 503, never into access).
 *
 * Device revocation and credentials. A runner credential is issued to the user, not
 * to a device, so banning a `runnerId` alone would let the revoked machine
 * reconnect under a fresh one. The pieces that close that gap:
 *  1. `verifyRunner` returns `Principal.credentialId`.
 *  2. At `hello`, the core stores the association (`DeviceStore.upsertDevice`).
 *  3. `revokeDevice` returns the credential ids and marks them revoked in the store;
 *     `authorizeRelayUpgrade` then refuses any runner socket whose credential is
 *     revoked, whatever its `runnerId`. This part needs only the store.
 *  4. The credential is also invalidated at the identity provider through
 *     `revokeRunnerCredentials`. Production adapters (Clerk, any real IdP) MUST
 *     implement it; it is optional only so that the dev/stub adapters and the
 *     in-memory test stack stay trivial.
 * An adapter that gives no `credentialId` leaves revocation at the device id only,
 * and its docs must say so.
 */
export interface AuthVerifier {
  /** An app user's session token, presented by a browser. `origin` is the request's `Origin` header. */
  verifyBrowser(token: string, context: { origin: string | null }): Promise<Principal | undefined>;
  /** A runner credential (device-grant access token or user API key). */
  verifyRunner(token: string): Promise<Principal | undefined>;
  /**
   * Revokes these runner credentials (`Principal.credentialId` values taken from
   * `RevokeResult`) at the identity provider. Must be idempotent and must not reject
   * for ids it no longer knows.
   */
  revokeRunnerCredentials?(userId: string, credentialIds: string[]): Promise<void>;
}

/**
 * Everything a deployment configures. `app`, `origin`, `auth`, `relayUrl` and
 * `protocol` feed `/.well-known/bridge.json`.
 */
export interface BridgeServerConfig {
  app: BridgeDiscovery["app"];
  /** Bare app origin; must equal the origin of the served pages. */
  origin: string;
  auth: BridgeDiscovery["auth"];
  /** Defaults to `<origin as ws(s)>/relay`. */
  relayUrl?: string;
  /**
   * Path of the app page that enrolls a browser (`BridgeDiscovery.enrollPage`), served in
   * `/.well-known/bridge.json` when set. Validated like the discovery document.
   */
  enrollPage?: string;
  /** Defaults to `PROTOCOL_RANGE`. `min` is the oldest runner protocol the server still accepts. */
  protocol?: ProtocolRange;
  /** Shown to runners in `update_required`. */
  latestRunnerVersion?: string;
  adapters: {
    /**
     * What `HttpHost` uses. On Node it is the relay context's own `RelayTransport`;
     * on Workers it is the Worker-side forwarder to the Durable Object.
     */
    relay: RelayGateway;
    store: DeviceStore;
    verifier: AuthVerifier;
  };
  /** Browser `Origin` values allowed to open `/relay/browser`. Defaults to `[origin]`. */
  allowedBrowserOrigins?: string[];
  /** Minimum gap between `lastSeen` writes per device, passed to `DeviceStore.touchLastSeen`. Default 5 minutes. */
  lastSeenIntervalMs?: number;
  /** Largest accepted envelope, in bytes of the text message. Default 1 MiB. */
  maxEnvelopeBytes?: number;
  /** Per-connection send queue limit before `dropped_backpressure`. Default 4 MiB. */
  maxQueuedBytes?: number;
  /**
   * Longest a relay socket may live, in ms, so a session or credential that the
   * identity provider revoked cannot stay connected forever (the relay checks the
   * token only at upgrade). At this age the transport closes the socket with
   * `RELAY_CLOSE_MAX_AGE` and clients reconnect with a fresh token. 0 disables it.
   * Default 12 hours.
   */
  maxSocketAgeMs?: number;
  /**
   * Most live sockets one user may hold per role. A further upgrade is refused with
   * HTTP 429 before `onOpen`. A browser upgrade that replaces a socket with the same
   * `browserKeyId` does not count that socket. Defaults: 16 browsers, 8 runners.
   */
  maxSocketsPerUser?: { browser?: number; runner?: number };
  /** Test seam. */
  now?: () => Date;
}

