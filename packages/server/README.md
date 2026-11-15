# @berdyh/bridge-server

The runtime-independent core of the bridge server kit. It has no dependency beyond
Hono and `@berdyh/bridge-protocol`. Everything environment-specific sits behind the
interfaces in `src/contracts.ts`; an adapter is a package that implements them.

The relay is **blind**: it reads the `RelayEnvelope` header (`to`, `runnerId`,
`browserKeyId`, `kind`) and the runner `hello`, and forwards every `frame` and
`pake` message as the exact text it received. It never parses `body`.

## What the core gives you

- `createBridgeApp(config)` returns an `HttpHost` (a plain `fetch` handler):
  - `GET /.well-known/bridge.json`
  - `GET /bridge/devices`, `GET /bridge/devices/:id`, `GET /bridge/devices/:id/last-seen`,
    `DELETE /bridge/devices/:id`. The path `/bridge/devices` is fixed. These take the browser session token in
    `Authorization: Bearer`. Revoking closes the runner's socket through
    `RelayGateway.disconnect` (once by `runnerId`, once per revoked credential id).
  - `GET <relayUrl path>/runner` and `/browser`: authorized by
    `authorizeRelayUpgrade`, then handed to `RelayGateway.accept`. Tokens come from
    `Authorization: Bearer` or a `bearer.<token>` entry of `Sec-WebSocket-Protocol`.
- `createRelayCore(config, transport)` returns a `RelayHandler` for the relay context.

Set `enrollPage: "/bridge/enroll"` in `BridgeServerConfig` to advertise the app's
browser enrollment page in `/.well-known/bridge.json`. It is optional and omitted
when unset. `createBridgeApp` validates the discovery document at construction
with the protocol's `validateDiscovery`: the enrollment page must be a path on the
app origin starting with a single `/`, without a query, fragment, backslash,
space or control character. Absolute and off-origin URLs are rejected. The app
must serve the page itself; the kit only advertises its path.

## Writing an adapter

An adapter supplies up to four things.

1. **`DeviceStore`** (Postgres, D1, memory). Every method is scoped by `userId`.
   `touchLastSeen` must be one atomic conditional write, because the core calls it
   from many connections and does not throttle in memory. `revokeDevice` must also
   revoke every credential id bound to the device through `upsertDevice`, and must be
   idempotent: for an already revoked device it returns the same credential ids with
   `alreadyRevoked: true` (undefined only for a device never known), so a retried
   `DELETE` can finish the socket close and the provider revoke.
2. **`AuthVerifier`** (Clerk, a stub). Return `undefined` for a bad token and reject
   only for infrastructure failures (the core answers 503). Give runner principals a
   stable `credentialId` and implement `revokeRunnerCredentials` if the identity
   provider has such a thing.
3. **`RelayGateway`** for the HTTP side: `accept(request, peer)` and
   `disconnect(userId, filter, code, reason)`. On Workers `HttpHost` runs in the
   stateless Worker and the gateway forwards to the user's Durable Object.
4. **`RelayTransport`** (extends `RelayGateway`) in the relay context, which owns the
   sockets:
   - `bind(handler)`, `send`, `close`, `connections`, `setState`.
   - Call the handler's `onOpen`, `onMessage` (text frames only; close binary with
     1003) and `onClose`. Run one connection's handler calls in order.
   - Build and bind the core yourself: `transport.bind(createRelayCore(config, transport))`.
   - Replace the older browser socket of the same `(userId, browserKeyId)` with
     close code `RELAY_CLOSE_REPLACED` (4409) before you call `onOpen` for the new one.
     The core also closes a superseded runner socket with 4409: when a runner `hello`
     completes while an older greeted socket of the same `runnerId` is open, the older
     one is closed with `RELAY_CLOSE_REPLACED` (and a late, older handshake closes
     itself the same way). So both roles can see 4409, and an endpoint that gets it must
     not reconnect.
   - `send` never throws. Enforce a per-connection queue limit and return
     `dropped_backpressure`. Drop the connection immediately and take it out of
     `connections()` first: a close frame would queue behind the saturated buffer and
     never arrive, so tear the socket down (`ws.terminate()` on Node) and let the
     handler's `onClose` follow. Peers see the loss as an abnormal close (1006) and the
     sender gets `error/backpressure`.
   - Liveness belongs to the transport, because the core keeps no timers and has no
     clock beyond `now`. A Durable Object or a Node process must itself (a) ping idle
     sockets and drop one that misses a pong, (b) close a runner socket that has not
     become `greeted` (see `setState`) within a short time, with 1008, and (c) refresh
     `lastSeen` on a pong through `DeviceStore.touchLastSeen`, which is already the
     throttle. The Node transport does all three; see "Liveness" below.
   - Keep nothing the core needs outside `ConnectionState` (via `setState`) and the
     store: the core re-derives everything else from `connections()`.

`@berdyh/bridge-server-node` is the reference adapter (`ws`, in-memory store, stub
verifier). It upgrades outside `fetch`, so its `accept` answers 426 and the HTTP
server calls `authorizeRelayUpgrade` and then the transport's `handleUpgrade`, or
`handleVerdict` when the authorization carries a `verdict` (see below).

## Revoked verdict at upgrade

A runner whose token verified but whose runner id or credential is revoked is not
answered with a bare 403 (which has no close code): `authorizeRelayUpgrade` returns the
403 `response` plus `verdict: { type: "revoked", runnerId }`, and a host that can deliver
it completes the upgrade only to send `revokedVerdictFrame(runnerId)` and close with
`RELAY_CLOSE_REVOKED` ("revoked"). The socket is never registered as a peer.

- **Gateway.** `RelayGateway.acceptVerdict?(request, verdict)` is optional. Without it,
  `createBridgeApp` keeps the 403. On Workers `createDoRelayGateway` implements it in the
  Worker, without calling the user's Durable Object. On Node the upgrade happens outside
  `fetch`, so the HTTP server calls `WsRelayTransport.handleVerdict(req, socket, head,
  verdict)` itself (`createNodeBridgeServer` does).
- **Revoked principal.** A provider that revokes the runner's credential at device revoke
  (Clerk revokes the API key) would make an offline-revoked runner fail verification
  before the id check. `AuthVerifier.verifyRunner` may therefore resolve
  `{ userId, credentialId, revoked: true }` for a credential that is authentic but
  revoked (valid subject and id; never for an unknown, forged, expired or malformed
  token, which stay `undefined`). `createBridgeApp` gives it the verdict only when
  `DeviceStore.isCredentialRevoked(userId, credentialId)` confirms the revoke, and a 401
  otherwise; a principal marked `revoked` is accepted by no other route and never by
  `verifyBrowser`. `@berdyh/bridge-server-clerk` reports a revoked API key (and a revoked
  OAuth token whose grant the app's `resolveGrant` maps) this way; an unmapped revoked
  OAuth token stays a 401.
- **Long-offline runner (token fingerprint).** An identity provider may forget a revoked key altogether
  (Clerk answers 404 about a minute after a revoke), so `verifyRunner` has nothing left to report. `DeviceStore` has two
  optional, additive members for this: `upsertDevice(record, credentialId, fingerprint?)` records, with the credential
  binding, the lowercase hex SHA-256 of the runner token (`tokenFingerprint(token)`, Web Crypto; only the hash is
  stored, never the token), and `revokedCredentialByFingerprint(fingerprint)` answers `{ userId, credentialId }` only for
  a credential bound to a revoked device. The core passes the fingerprint only to a store that has the lookup, only for
  runners that verified with a `credentialId`; when the verifier refuses a runner token (never for a 503, never for a
  browser, never for a token over 4096 bytes), it looks the hash up and, if the store confirms `isCredentialRevoked`,
  gives the verdict. No match, a store without the method, or a lookup error keep the 401 (an outage never becomes a
  verdict, nor a 503). The verdict names only the runner id the caller sent; it does not depend on that id agreeing
  with the device the credential was bound to, because the user is unknown until the store answers and presenting the
  exact token proves the credential (a revoked credential is revoked under any runner id). Stores that implement it:
  the Node memory store, `@berdyh/bridge-server-d1` and `@berdyh/bridge-server-neon` after their migration
  `0002_credential_fingerprint.sql` (apply it to get the long-offline verdict: the stores detect the column, and without it they bind credentials
  without a fingerprint and answer no match, so an app can update the kit first and migrate later without a runner going offline).
  A credential bound before the migration has a NULL fingerprint and falls back to the 401.

## Liveness (Node adapter)

`createWsRelayTransport` takes `pingIntervalMs` (default 30 s, 0 disables) and
`helloTimeoutMs` (default 10 s, 0 disables). Each tick pings every socket and
terminates one that did not pong since the previous tick. A runner socket that is not
`greeted` when `helloTimeoutMs` runs out is closed with 1008. Both timers are `unref`ed
and stop on `shutdown()`. The `onPong(conn)` option lets you react to a pong:
`createNodeBridgeServer` uses it to call `DeviceStore.touchLastSeen` for greeted
runners (at most one attempt per connection per `lastSeenIntervalMs`; the store is the
real throttle). It passes the intervals to the default transport through its `liveness`
option; a transport you pass in `adapters.relay` is configured by you, including
`onPong`.

## Revocation

`DELETE /bridge/devices/:id` closes the runner's sockets with `RELAY_CLOSE_REVOKED`
(4401) through `RelayGateway.disconnect`. The core does **not** send the
`{ type: "revoked" }` control envelope first on that path: `createBridgeApp` only holds
a `RelayGateway` (on Workers it is the Worker's forwarder, with no sockets), and the
relay handler has no hook for `disconnect`, so sending it would need a change to the relay handler contract. **Runners therefore must treat close code 4401 as "revoked" and must not
retry.** The `revoked` control envelope is sent, before the same close code, only when a
runner's `hello` is refused because its device or credential is already revoked.

`DELETE` is idempotent. For an already revoked device it runs the socket closes and the
provider revoke again and answers 200 with `alreadyRevoked: true`; only a device that
was never known gets 404. A `relay.disconnect` rejection does not fail the request: the
response carries `socketCloseFailed: true`, the provider revoke still runs, and the
caller retries the same `DELETE`. A failing provider sets `idpRevokeFailed: true`, also
retryable the same way.

### How long a socket outlives its credential

The relay checks a token and the device store only at upgrade (and at `hello`). A socket
that is already open is not re-authenticated, so **revocation through the device API
(`DELETE /bridge/devices/:id`) is the only revocation the relay observes live**. A
session, API key or OAuth grant revoked at the identity provider takes effect at most
one `maxSocketAgeMs` later (default 12 hours): at that age the transport closes the
socket with `RELAY_CLOSE_MAX_AGE` (1012). That code is neither 4409 nor 4401, so the
client SDK and the runner reconnect at once, with a freshly fetched token that the
provider now refuses. Set `maxSocketAgeMs: 0` to disable it, or lower it to shorten the
window. On Cloudflare the Durable Object's alarm sweep enforces it (within 30 seconds of
the age); on Node a per-socket timer does.

New upgrades are refused at once for a device revoked through the device API: its bound
credential ids are tombstoned in the store before the identity provider is called, and
every runner upgrade checks that tombstone. A credential revoked only at the identity
provider is refused on new upgrades once the provider's own verification stops
accepting it. Clerk's API-key verification caches a key: after a revoke it kept
accepting the key (reporting `revoked: false`) for 47-62 seconds on a development
instance, then answered 404. Production may differ, and a key past its expiry is likely
cached the same way.

### Socket caps

One user may hold at most `maxSocketsPerUser.browser` browser sockets (default 16) and
`maxSocketsPerUser.runner` runner sockets (default 8). The next upgrade is refused with
HTTP 429 (`Retry-After: 30`) before `onOpen` and before anything is replaced, on both
transports (on Cloudflare the cap is per user because each user has its own Durable
Object). A browser upgrade with the `browserKeyId` of a live socket replaces it and is not
counted against the cap. Runner sockets of one `runnerId` are counted until the older one
closes, so a half-open leftover can briefly hold a slot.

## Wire behavior

- A runner socket must send `hello` (a `RunnerHello`, not an envelope) first. The
  core answers with the raw `ServerWelcome` JSON (the protocol defines the welcome as
  bare JSON, not a `RelayEnvelope`), or with a `control` envelope
  (`update_required` for a too-old runner, `error/protocol_mismatch` for a too-old
  server) followed by a close. Nothing is routed before `hello`.
- Presence (`kind: "presence"`) goes to every browser of the user when a runner
  connects or leaves, and to a browser that connects while a runner is online.
  Online presence includes `hostname` from the runner's hello when it passes the
  protocol's `boundedHostname` (1–255 characters, no C0/DEL/C1 controls or line/paragraph
  separators). Invalid names are dropped without rejecting the hello; the device
  record uses `"unknown"` instead. The sanitized name lives beside bounded `agents`
  in `ConnectionState`, so later browsers receive it, including after DO hibernation.
  Offline presence omits it. Treat hostname as display text, never as HTML or an id.
- `peer_reconnected` and `peer_gone` control envelopes tell each side when to resend.
  The relay buffers nothing: endpoints replay by `seq`.
- Envelope checks: a browser must send `to: "runner"` with its own `browserKeyId`; a
  runner must send `to: "browser"` with its own `runnerId` and a target
  `browserKeyId`. `presence` and `control` sent by an endpoint are dropped.
- Relay-originated envelopes that are not about a runner (errors to a browser for a
  malformed envelope) carry `runnerId: "relay"`.

## Test seam

`createRelayCoreWithHooks(config, transport, { onForward })` calls `onForward` with
the raw text of every forwarded `frame` or `pake` envelope. `createNodeBridgeServer`
exposes it as the `tap` option. It is for tests that assert relay blindness; it is
off by default and must not be enabled in production.

## Guides

Deploying a server: [Add the bridge to an app](../../docs/guides/add-to-an-app.md). Writing your own adapter: [Write an adapter](../../docs/guides/write-an-adapter.md).
