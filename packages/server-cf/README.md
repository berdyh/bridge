# @berdyh/bridge-server-cf

The Cloudflare Workers adapter for the bridge server kit: a Worker that serves the core's HTTP routes, and a Durable Object per user that holds the relay's sockets. It is for apps deployed on Cloudflare. It takes a device store (Neon or D1) and an `AuthVerifier` (Clerk) from the other adapter packages, and ships a Worker template to copy.

Copy `templates/worker.ts` and `wrangler.toml.example` into the app's own Worker
project. Each app needs its own namespace, database and Clerk secret. Apply the
Neon migration before use; for D1, use `createD1DeviceStore(env.DB)` and copy its
migration into the app's D1 migrations directory. Secrets belong in Worker secret
bindings. Source templates and migrations live beside their respective packages;
copy them from this repository (the package manifests publish dist only).

The template sets `enrollPage: "/bridge/enroll"`, advertised in discovery. Serve
the app's enrollment page at that path or change it to another path on the app
origin. It is optional; omit it when the app has no enrollment page. The core
validates discovery when the Worker constructs its app: the path must start with
a single `/` and contain no query, fragment, backslash, space or control character.
Absolute and off-origin URLs are rejected.

Rate limit `/relay/*` and `/bridge/devices*` with a Cloudflare rate-limiting rule: the
Worker does not throttle, and each unauthenticated request can cost a Clerk Backend API
call. Set the optional `CLERK_JWT_KEY` (PEM public key) so browser JWTs verify locally;
see [Add the bridge to an app](../../docs/guides/add-to-an-app.md#rate-limit-the-public-routes).

The Worker template advertises Clerk's device flow and enables OAuth verification
with the same CLERK_CLIENT_ID and explicit
`oauth: { clientId: env.CLERK_CLIENT_ID, allowWithoutCredentialId: true }`.
This opts into device-id-only
revocation: **a revoked machine can reconnect under a new runnerId and use its
refresh token to keep obtaining new access tokens for as long as the refresh
token/grant remains valid, or until the grant is manually revoked in Clerk**.
Access-token expiry alone does not end this window (`offline_access` enables
refresh). To revoke the grant manually, call
`clerkClient.oauthApplications.revokeToken({ oauthApplicationId, token })` from a
trusted backend using this app's Clerk secret key and an opaque access or refresh
token from that grant; Clerk revokes both tokens. Device-id revocation does not
make this call automatically. See the [Clerk verifier README](../server-clerk/README.md)
for the required inputs and limitations.

The Clerk verifier remains strict by default. For whole-grant revocation, supply
both `resolveGrant` and `revokeGrant` hooks backed by an authoritative,
refresh-stable grant mapping; see the Clerk verifier README. Token
id/jti, userId and clientId are not stable grant identifiers. Each app owns its
grant data and provider credentials.

The Worker caches one core Hono app per env object in a WeakMap; only the per-user DO owns sockets.
The gateway derives `idFromName(userId)` from the verified principal and forwards
no bearer token. The DO independently checks accept/disconnect user ids against
its namespace-derived id (or its name for a custom gateway). Attachments contain
peer, negotiated state, inbound timestamps, hello deadlines and close
markers and must be smaller than 16 KB. A fresh DO instance reconstructs routing
from attachments. In-flight Promise chains serialize each socket's handler calls;
they are disposable and prevent eviction until settled, not persistent state.
The relay persists only a `boundedHostname`-validated name (1–255 printable
characters) beside the bounded agents list. Online presence repeats that name for
current and later browsers after hibernation; offline presence omits it. Invalid
names are dropped from presence and stored as `"unknown"` in the device record.

Each user's Durable Object refuses an upgrade with 429 once the user holds
`maxSocketsPerUser` sockets of that role (defaults 16 browsers, 8 runners), before the
core's `onOpen` and before replacing a same-key browser tab.

Liveness uses WebSocket auto-response and the DO alarm API, never JavaScript
timers. Peers send the text frame `bridge:ping` after 20 seconds without outbound
traffic and reconnect if no `bridge:pong` arrives within 10 seconds. The DO
registers `WebSocketRequestResponsePair('bridge:ping', 'bridge:pong')`, so incoming
pings are answered without waking the DO. Neither heartbeat string reaches the
relay core; unsolicited pongs are ignored and servers never initiate text pings.

Any inbound frame proves liveness. The latest inbound time is the maximum of the
attachment timestamp and `getWebSocketAutoResponseTimestamp(ws)`, so it survives
hibernation, including auto-responses. A sparse alarm sweep (at most 30 seconds
apart while sockets exist) closes sockets with no inbound frame for 60 seconds;
sweep timing can delay that close by up to 30 seconds. A runner must greet within
10 seconds; an earlier alarm enforces that fixed deadline and pre-hello traffic
cannot extend it. The sweep refreshes an active runner's lastSeen through the
store's 5-minute throttle; failures are best effort and do not block the socket's
event chain. Ordinary relayed frames update attachments without reading or
writing alarm storage. No alarms remain when there are no live sockets.

A socket older than `maxSocketAgeMs` (default 12 hours, 0 disables it; measured from
`state.connectedAt`) is closed by the same sweep with 1012 (`RELAY_CLOSE_MAX_AGE`), so
the client or runner reconnects and presents a fresh token. Only the device API's
revocation is seen live; identity-provider revocation takes effect within one max age.

Workers' WebSocket API has no bufferedAmount or terminate. **maxQueuedBytes is
inert on Workers**: the adapter owns no outbound queue and skips byte encoding on
send when bufferedAmount is absent. If a runtime exposes bufferedAmount, the
adapter honors maxQueuedBytes. Runtime send failures close the socket; the
platform's hidden aggregate buffer cannot be bounded through this option.
Closing immediately persists a discard marker so queued inbound events never
route after server termination.

The package typecheck includes `templates/worker.ts` against the owned adapter
sources, so copied-template API drift fails the normal check.

Tests use the installed Wrangler Miniflare runtime for Hono, actual WebSocket
hibernation acceptance, D1, replacement, routing and credential revocation, plus
fakes for deterministic eviction, deadlines and send failures. A real `wrangler dev` run is covered by the `e2e-cf` suite.

## Guides

Deploying a server: [Add the bridge to an app](../../docs/guides/add-to-an-app.md). Writing your own adapter: [Write an adapter](../../docs/guides/write-an-adapter.md).
