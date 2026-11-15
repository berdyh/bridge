# Architecture

This document describes how bridge is built: what runs where, who trusts
whom, which messages cross which boundary, and which codes a consumer can depend on. It is
for people who use the kit, read its code or contribute to it. Task-oriented instructions
live in the guides, which this document links to; the [README](../README.md) has the quick
start.

Contents:

1. [What the kit is](#1-what-the-kit-is)
2. [Packages and how they fit](#2-packages-and-how-they-fit)
3. [Trust and isolation model](#3-trust-and-isolation-model)
4. [The app server](#4-the-app-server)
5. [Pairing and enrollment](#5-pairing-and-enrollment)
6. [The relay](#6-the-relay)
7. [The encrypted channel](#7-the-encrypted-channel)
8. [The runner](#8-the-runner)
9. [Agent adapters and sessions](#9-agent-adapters-and-sessions)
10. [Plugins](#10-plugins)
11. [Plugin agent sessions: contained and confined](#11-plugin-agent-sessions-contained-and-confined)
12. [Credentials and the keychain](#12-credentials-and-the-keychain)
13. [Platform support and limits](#13-platform-support-and-limits)
14. [Security model](#14-security-model)
15. [Wire contracts and error codes](#15-wire-contracts-and-error-codes)
16. [Where to go next](#16-where-to-go-next)

## 1. What the kit is

A hosted web app (for example `https://<app>.example.com`) wants an AI coding agent, such as
Claude Code or Codex, to work for its user. The agent should run on the user's own machine
with the user's own subscription, and the user's files and data should stay there. The kit
connects the two:

- The app's page drives a coding agent on the user's machine through an encrypted channel.
- A small program, the **runner** (`bridge`), runs on the user's machine. It dials out to the
  app's server, so nothing listens for the hosted page and no inbound port is needed.
- The app's server contains a **relay** that forwards ciphertext between the page and the
  runner. The relay and the app's server never see prompts, agent output or files.
- The runner starts the agent, decides what it may do from a local policy file, and
  optionally runs **plugins**: code the app ships to run next to the agent on the user's
  machine.

All model work happens on the user's machine and subscription. The app holds no model keys
for generation.

The kit is a library, not a service. Every app that uses it deploys its own server with its
own database and its own identity-provider application. The only shared piece is the runner
program on the user's machine, and even there every app gets its own credential, connection,
trusted-browser list and plugin set (section 3).

The protocol on the wire is the Agent Client Protocol (ACP). The browser is an ACP client,
the runner is an ACP proxy and the agent is an ACP agent. Plugins add `_`-prefixed ACP
extension methods. There is no side protocol.

## 2. Packages and how they fit

| Package | Role |
|---|---|
| `@berdyh/bridge-protocol` | Shared types and validators with no runtime dependencies: the discovery document, relay envelopes, sequenced and encrypted frames, enrollment messages, the plugin manifest, device records, user codes and the four-word display |
| `@berdyh/bridge-crypto` | SPAKE2 enrollment, X25519 identities, HKDF session keys and the AES-256-GCM frame codec. No Node-only imports on the production path, so the browser and the runner share it |
| `@berdyh/bridge-pairing` | The runner's OAuth device-grant client (RFC 8628) and the acknowledgement step of app-hosted enrollment, with tokens kept in an injected credential store |
| `@berdyh/bridge-runner` | The runner core: ACP proxy, local policy, agent adapters, plugin host, per-app encrypted state, install and service planning, the keychain facade |
| `@berdyh/bridge` | The `bridge` command line. It wires the runner core to the operating system and runs the runner for every connected app |
| `@berdyh/bridge-client` | Browser and headless client SDK: discovery, the reliable relay link, enrollment, the encrypted ACP stream, status and optional custom elements |
| `@berdyh/bridge-plugin-sdk` | What a local plugin imports to register methods, start agent sessions and serve a local page |
| `@berdyh/bridge-server` | The runtime-independent server core (Hono). It owns the HTTP routes and the relay logic and talks to its environment only through four interfaces |
| `@berdyh/bridge-server-node` | Reference adapter: `ws` relay, in-memory store, stub auth (development and tests) |
| `@berdyh/bridge-server-cf` | Cloudflare adapter: a Worker for the HTTP routes and one Durable Object per user for the relay sockets |
| `@berdyh/bridge-server-neon`, `@berdyh/bridge-server-d1` | `DeviceStore` implementations on Neon Postgres and Cloudflare D1 (D1 also stores app-hosted enrollments) |
| `@berdyh/bridge-server-clerk` | `AuthVerifier` (and enrollment credential issuer) backed by Clerk |

`protocol` is the base of everything. The client and the runner add `crypto`; the CLI adds
`pairing`; the server core uses `protocol` only.

```
 user's browser                 app's server (one per app)              user's machine
 ┌─────────────────────┐        ┌──────────────────────────┐        ┌─────────────────────────┐
 │ page of the app     │  WSS   │ HTTP routes (Hono)       │  WSS   │ bridge runner           │
 │  bridge-client      │◄──────►│  discovery, device API,  │◄──────►│  one connection per app │
 │  ACP client         │ E2EE   │  enrollment (optional)   │ E2EE   │  ACP proxy + policy     │
 │  SPAKE2 enrollment  │ frames │ relay (blind)            │ frames │  ├ agent adapters ──────┼─stdio─► claude, codex,
 └─────────────────────┘        │  Durable Object per user │        │  └ plugin host ─────────┼─stdio─► app plugins
                                │ adapters: DeviceStore,   │        └─────────────────────────┘          (child processes)
                                │  AuthVerifier, transport │
                                └──────────────────────────┘
```

Reading the diagram:

- Both sockets are outbound: the page and the runner each open a WebSocket
  to the app's server. The relay pairs them by user.
- Inside the encrypted frames the traffic is ACP JSON-RPC. The relay can read only the routing
  header of each envelope.
- The runner talks ACP over stdio to each agent and a private JSON-RPC protocol over stdio to
  each plugin.
- A plugin may also serve a page on `127.0.0.1`. Its URL reaches the browser inside the
  encrypted channel; its content never crosses the relay.

The server core depends only on four interfaces (section 4), which is what lets the same core
run on Workers, on Node or on another runtime.

## 3. Trust and isolation model

### One app, one stack

Each app deploys its own server, relay, pairing endpoints, device store and identity-provider
application. Nothing in the kit couples two apps' servers at runtime: there is no shared
token broker, no shared database and no shared tenant. An app can move to another host or
identity provider without touching the others. Consumers of the kit depend on it as a
library; the kit never depends on an app.

### One runner per machine, separate state per app

The runner is installed once per machine. For every app the machine is connected to, it keeps:

- a **credential** for that app's server (stored under a name derived from the app id),
- one **connection** (its own WebSocket to that app's relay),
- a **runner identity** (a long-term key pair) and a **trusted-browser list**,
- a set of **plugins**, with data directories and consent records,
- a **policy** that can only narrow the machine-wide policy,
- its own **work, session and audit folders**,
- its own **session budget** against the agent caps.

All per-app paths come from one `AppPaths` value derived from the app id, so code that serves
one app has no path to another app's folders. An app id is a lowercase folder name
(`^[a-z][a-z0-9-]{0,62}$`, with `bridge` reserved), and the first origin to claim an id owns
it. A browser enrolled for app A is not in app B's trust list; a plugin of app A cannot be
called by app B's browsers; A's sessions, audit log and secrets are unreachable from B.

Per-app separation covers state, routing and policy. It does not mean one operating-system
process per app: one `bridge run` process serves all connected apps (section 8). A plugin is
ordinary code running as the user, and a plugin's declared filesystem and network grants are
shown but not enforced (section 10), so separation of a plugin from another app's files on
disk depends on the plugin being honest.

### Who may cause what

| Party | Trusted for | May cause | Never |
|---|---|---|---|
| The person at the terminal | Every grant | Install, update and revoke plugins; approve a plugin's MCP servers and headless tools; edit `policy.json` and an app's `config.json`; approve a new browser (in an interactive `bridge setup`, opening it is the approval, see 5.2) | Be stood in for by `--yes` on a widened grant or on the four words |
| An app's installer script | Choosing the package and its pinned hash | Install a plugin whose grant is unchanged or narrower, without a prompt | Approve a widened grant; install a published package under `--yes` without a pinned hash |
| Machine administrator (root) | Everything; out of scope to defend against | Managed settings, hooks, extra MCP servers | The kit detects and refuses where it can; it does not claim to defend |
| The runner, CLI and the agent adapter it installs | Enforcing what it is told | Spawn agents with the profile the runner chose | Read the agent's own config directories (`~/.claude`, `~/.codex`) while serving sessions |
| An installed plugin (code and manifest) | Its own app's data; it is local code running as the user | Start sessions for agents named in its manifest; attach its declared MCP servers; pass a secret; read its sessions' events; cancel and close its sessions | Approve its own agent's tool calls; attach an undeclared server; use a grant the person has not consented to; start a non-contained session with MCP servers; reach another app's sessions |
| A plugin's MCP server | Same as its plugin | Serve tools to the one session it was attached to; read that session's secret | Receive the secret through environment or arguments |
| The agent model and all content it reads | Nothing | Request tool calls, each decided or recorded by the runner | Choose its own tools, servers, mode, working directory, model or budget |
| Project files in a session folder (`CLAUDE.md`, `.mcp.json`, `.claude/`, hooks) | Nothing in a contained session | Nothing: a contained session gets an empty folder and no setting sources | Be loaded into a contained session |
| An enrolled browser | Driving its own sessions under local policy | Text prompts, model options, cancel, close, calls to `_<plugin>/...` methods of its app | Name or define an MCP server; set a permission mode; widen a plugin's consented tools; read plugin session events unless the plugin forwards them |
| The relay and the app server | Nothing about content or commands | Carry ciphertext and presence | Anything the runner acts on |
| Another app's plugin, browser or session | Nothing for this app | Nothing here | Reach this app's plugins, sessions, audit log or secrets |

The consequences that matter most: a compromised relay or app server cannot enroll a new
browser (the runner holds the trust list), cannot read content, and cannot change the
permission mode (policy is local). An agent has only the tools it was given (section 11), and
auto-approval of a plugin's tool calls comes only from consent the person gave at install.

## 4. The app server

`@berdyh/bridge-server` exposes `createBridgeApp(config)`, which returns an `HttpHost`: a plain
`fetch` handler. It serves:

| Route | Purpose |
|---|---|
| `GET /.well-known/bridge.json` | The discovery document |
| `GET /bridge/devices`, `GET /bridge/devices/:id`, `GET /bridge/devices/:id/last-seen`, `DELETE /bridge/devices/:id` | The device API for the signed-in user (browser session token). `DELETE` revokes a device |
| `GET <relayUrl>/runner?runnerId=<id>` and `GET <relayUrl>/browser?browserKeyId=<id>` | WebSocket upgrades for the two relay roles |
| `/bridge/enrollment/*` (optional) | App-hosted runner enrollment (section 5) |

Tokens arrive in `Authorization: Bearer` or, for browsers that cannot set headers, as a
`bearer.<token>` entry in `Sec-WebSocket-Protocol`; the server selects the subprotocol
`bridge.v1`. A browser upgrade must carry an allowed `Origin` (by default only the app's own
origin).

### The discovery document

`/.well-known/bridge.json` is everything a runner needs to pair and connect:

- `app`: `{ id, name }`;
- `origin`: the app's origin;
- `auth`: `{ issuer, clientId, deviceAuthorizationEndpoint, tokenEndpoint, scope? }`;
- `relayUrl`: the base of the relay sockets, on the app origin;
- `enrollPage` (optional): a path on the app origin of the page that enrolls a browser;
- `protocol`: `{ min, max }`, the wire protocol versions the server speaks (the current
  version is 1).

A runner validates the document before trusting it. Everything must be on the app's origin,
over https/wss (plain http/ws only on loopback), with no embedded credentials. The one
exception is the identity provider: the issuer, and the device and token endpoints, may be on
the issuer's origin. A server therefore cannot describe a different app from the one asked
about.

### The four extension points

The core never touches a database, a socket library or an identity provider directly. An
adapter package supplies up to four things:

| Interface | Brings | Shipped implementations |
|---|---|---|
| `DeviceStore` | Device records, credential bindings and revocation tombstones, always scoped by user id | Neon, D1, in-memory (Node package) |
| `AuthVerifier` | Checks of browser session tokens and runner tokens; credential revocation at the provider | Clerk, a stub (Node package) |
| `RelayGateway` | The HTTP side of the relay: accept an upgrade, disconnect a runner | Durable Object forwarder, `ws` |
| `RelayTransport` | The sockets themselves (extends `RelayGateway`): send, close, connection state, liveness | Durable Object, `ws` |

Rules the contracts enforce: store methods are atomic where concurrency matters (the
`lastSeen` throttle is one conditional write); revoking a device also revokes every credential
bound to it and keeps tombstones; a verifier returns `undefined` for a bad token and rejects
only on infrastructure failure (the core answers 503); a transport never throws from `send`,
enforces a queue limit, and owns all timers because the core has none. See
[Write an adapter](guides/write-an-adapter.md) and the
[server README](../packages/server/README.md).

### Deployment shapes

- **Cloudflare (default).** A stateless Worker serves the HTTP routes. A Durable Object per
  user (named by the verified user id) holds that user's runner and browser sockets, using the
  WebSocket Hibernation API. Liveness uses WebSocket auto-response and DO alarms rather than
  JavaScript timers. The device store is Neon or D1 and auth is Clerk.
- **Node.** `createNodeBridgeServer` runs the core with `ws`, binds `127.0.0.1` and expects a
  TLS proxy in front. Its in-memory store and stub auth are for development.

How to deploy either: [Add the bridge to an app](guides/add-to-an-app.md). Package details:
[server-cf](../packages/server-cf/README.md), [server-node](../packages/server-node/README.md),
[server-neon](../packages/server-neon/README.md), [server-d1](../packages/server-d1/README.md),
[server-clerk](../packages/server-clerk/README.md).

## 5. Pairing and enrollment

There are two separate trust steps, and they protect against different things.

1. **Pairing** authenticates the machine to the app's server: "this runner belongs to this
   signed-in user".
2. **Enrollment** makes the runner trust one browser: "this browser may drive my agents".

A compromised server or identity account can interfere with step 1 but cannot complete step 2,
because step 2 needs a code that is displayed on the user's machine.

### 5.1 Pairing a machine to an app

`bridge connect <app-url>` (also run by `bridge setup`) fetches the discovery document, shows
the app name, origin and issuer, asks for confirmation, and then authenticates the machine
against the app's identity provider. Two modes exist. Both use the RFC 8628 shape, so the
runner-side client is the same code.

**OAuth device grant (default).** The runner is a public OAuth client with no embedded secret.
It starts a device authorization, prints a code, and polls the token endpoint while the person
approves the code on the identity provider's sign-in page. It requests `offline_access` and
refreshes its access token itself. Limitation: a Clerk OAuth token carries no stable grant
identifier. Revoking a device through the device API bans its device id and closes its socket,
but a revoked machine that still holds a valid refresh token can come back under a new runner
id until the grant is revoked at the provider. The Clerk verifier therefore refuses OAuth
tokens unless the app opts in explicitly (`allowWithoutCredentialId`). The window is described
in [Add the bridge to an app](guides/add-to-an-app.md#the-revocation-window-of-the-clerk-opt-in).

**App-hosted enrollment (closed revocation window).** The app mounts its own handler
(`createRunnerEnrollmentApp`) at `/bridge/enrollment/*` on its origin, with its own verifier,
credential issuer, durable store, a separate 32-byte encryption key and a rate limiter. It
exposes `/device`, `/token`, `/inspect`, `/approve`, `/deny`, `/cancel` and `/ack`. The flow:

1. The runner posts `/device` with its hostname, OS and version and gets a private device code
   and a public user code. The approval URL carries the user code in the URL fragment.
2. The signed-in user opens the app's approval page, which calls `/inspect` (showing the device
   details), then `/approve` or `/deny` with a request-bound CSRF receipt.
3. On approval the issuer mints a finite-lifetime credential for that user (with Clerk, a user
   API key with the scope `bridge:runner`, default lifetime 90 days). The credential is sealed
   with the app's key and delivered once to the polling runner, never to the browser.
4. The runner saves it in protected storage, then calls `/ack`. A credential that is not
   acknowledged is revoked by cleanup.

A pending request lives 600 seconds by default (configurable 60 to 900) and polling starts at
5 seconds. Because the credential has a stable id, revoking the device tombstones it and
revokes the key, so a revoked machine cannot reconnect under any runner id. This mode invents
no refresh token: an expired key needs a fresh approval. Verification is strict when the
verifier is given an `enrollment` option: exact scope, backend claims, owning app and user, and
a bounded lifetime.

In both modes the app's server never sees a runner secret in the browser. Re-connecting an app
keeps its runner id, and an app id that is already connected from another origin is refused.

### 5.2 Enrolling a browser

The runner owns the browser trust list (`trust.json` in the app's folder). A browser joins it
through a password-authenticated key exchange that the relay merely forwards.

1. **Open a window.** `bridge enroll <app>` (or `bridge setup`) opens an enrollment window on
   the runner and shows an 8-character code from a 20-consonant alphabet with no look-alike
   characters, such as `BCDF-GHJK`. The window lasts 10 minutes, the code is single-use and it
   allows 5 attempts. The window is stored in `enroll.json`, so the command and the running
   runner share it.
2. **Deliver the code.** The CLI opens `<origin><enrollPage>#code=<code>&runner=<runnerId>`.
   The code is in the URL fragment, which browsers never send to a server. The page calls
   `consumeEnrollLink()` first, which strips the fragment from the URL. If the person has to
   sign in first, the page keeps the link in `sessionStorage` for ten minutes. Typing the code
   into a field also works.
3. **SPAKE2.** The browser turns the code into a SPAKE2 password (edwards25519, RFC 9382
   group) and exchanges `pake/start`, `pake/reply`, `pake/confirm` and `pake/done` messages
   with the runner through the relay. The relay forwards them as opaque `pake` envelopes. An
   attempt is consumed when the runner sends a reply, so offline guessing against a reply is
   bounded by the same five attempts. The browser's long-term public key and a label travel
   sealed under the SPAKE2 key.
4. **Four words.** The browser derives four words from its key id (EFF short word list, 1296
   words) and shows them as text. The runner shows the same four words and asks the person to
   confirm the label and key. A person at a terminal compares and answers. A coding agent that
   runs the setup cannot answer: it must ask the person for the four words and run
   `bridge enroll approve <app> --words "..."`, which is refused if the words do not match the
   browser that is waiting. `--yes` never answers this step.
   One exception: an interactive `bridge setup` (a terminal, no `--json`) that opened the enroll
   link itself, with no error from the opener, trusts the first request of that window without
   asking; the code and link are not printed, and afterwards it prints the label, the words and
   `bridge browsers revoke <app> <keyId>`. `--json`, `--no-open`, a failed open, a later request
   and `bridge enroll` always ask for the words, so an agent-driven run never gets past them.
5. **Done.** On success the runner records the browser in `trust.json`. `pake/done` carries a
   proof sealed under the SPAKE2 key and bound to the enrollment and the browser key id, so a
   relay cannot forge a success. The browser id is `base64url(SHA-256(public key)[0..16])`.

The browser key is a non-extractable X25519 key in IndexedDB, one per app (origin plus app id).
Losing it means enrolling again. Revocation is on the runner (`bridge browsers revoke`) and is
authoritative; a revoked or unknown browser gets the session close reason `not_trusted` at its
next handshake, and the client invalidates its saved belief of trust.

### 5.3 What the page can know

`bridge.status()` and `onStatus()` in the client SDK combine relay presence with locally saved
runner keys:

| State | Meaning |
|---|---|
| `no_runner` | No runner is known for this user |
| `runner_offline` | A known runner is not online (it may have stopped after its idle timeout) |
| `online_not_enrolled` | A runner is online and this browser holds no enrollment key for it, or the runner answered `not_trusted` |
| `ready` | A runner is online and this browser holds a saved enrollment key |
| `runner_selection_required` | Several runners are online at once; pass an explicit runner id |

A page cannot tell "not installed" from "not running". `ready` reflects locally saved trust
until a handshake reports otherwise.

## 6. The relay

### 6.1 Blindness

The relay reads the `RelayEnvelope` header and the runner's `hello`. An envelope is:

```
{ to: "runner" | "browser", runnerId, browserKeyId?, kind: "frame" | "pake" | "presence" | "control", body }
```

For `frame` and `pake` the relay forwards the exact text it received and never parses `body`.
`presence` and `control` are originated by the relay only; an endpoint that sends one has it
dropped. A browser must send `to: "runner"` with its own `browserKeyId`; a runner must send
`to: "browser"` with its own `runnerId` and a target `browserKeyId`. Relay-originated errors
about a malformed envelope carry `runnerId: "relay"`.

A compromised relay therefore sees ciphertext, the routing header, connection timing and
sizes, the runner's hostname, OS, version and agent availability (from `hello`), and presence.
It can drop, delay or replay frames, which the channel's sequence numbers and authentication
detect (section 7). It cannot read content or add a trusted browser.

### 6.2 Connecting

1. The runner opens `<relayUrl>/runner?runnerId=<id>` with its bearer token; a browser opens
   `<relayUrl>/browser?browserKeyId=<id>`. The server verifies the token (and for browsers the
   `Origin`) before upgrading.
2. The runner's first message must be `hello`: `{ type: "hello", runnerId, runnerVersion,
   protocol: { min, max }, hostname?, os?, agents? }`. The server answers with the bare JSON
   `{ type: "welcome", protocol: <version> }`, the highest version both sides speak. Nothing is
   routed before `hello`. A runner that does not greet within 10 seconds is closed.
3. If the ranges do not overlap the server sends a `control` envelope instead and closes:
   `update_required` when the runner is too old, `error` with code `protocol_mismatch` when the
   server is too old.
4. **Presence** (`kind: "presence"`) goes to every browser of the user when a runner connects
   or leaves, and to a browser that connects while a runner is online. It carries `runnerId`,
   `online`, `lastSeen`, `runnerVersion`, bounded `agents` and, if valid, a sanitized
   `hostname` (1 to 255 printable characters; display text, never HTML or an identifier).

### 6.3 Reliable delivery

The relay buffers nothing. Reliability is end to end, between the two channel layers:

- Every frame has a per-direction `seq` starting at 1. The receiver acknowledges cumulatively
  with unencrypted `ack` frames. Senders keep unacknowledged frames (at most 64 pending) and
  resend them byte-identical.
- The relay tells each side when to resend: `peer_reconnected` (the peer's socket came back)
  and `peer_gone` (it left). A runner keeps a browser's session for 60 seconds after
  `peer_gone`, then closes it.
- Endpoints reconnect with jittered backoff. The backoff resets after a connection has stayed
  up for 30 seconds past the welcome.

### 6.4 Liveness, caps and replacement

- **Heartbeat.** After 20 seconds without outbound traffic an endpoint sends the text frame
  `bridge:ping`; the transport answers `bridge:pong`. With no answer within 10 seconds the
  endpoint treats the socket as half-open and reconnects. Neither string reaches the relay core.
  On Cloudflare the Durable Object answers pings without waking, and a sparse alarm sweep
  closes sockets with no inbound frame for 60 seconds.
- **One socket per browser key.** A newer browser socket with the same `(user, browserKeyId)`
  replaces the older one, which is closed with 4409 and must not reconnect. Tabs that share an
  enrolled key therefore replace each other, newest wins. A runner socket displaced by a newer
  one of the same runner id also gets 4409.
- **Caps.** At most 16 browser and 8 runner sockets per user by default. The next upgrade gets
  HTTP 429 with `Retry-After: 30`.
- **Backpressure.** A transport enforces a per-connection queue limit. A saturated connection is
  torn down at once (peers see 1006) and the sender gets `error/backpressure`.
- **Maximum socket age.** A socket older than `maxSocketAgeMs` (default 12 hours) is closed with
  1012 so the endpoint reconnects with a freshly fetched token.

### 6.5 Revocation

- `DELETE /bridge/devices/:id` revokes the device, tombstones every credential bound to it,
  closes the runner's sockets with 4401 and revokes the credentials at the identity provider.
  It is idempotent: a retry on an already revoked device answers 200 with `alreadyRevoked: true`.
  The response can carry `socketCloseFailed: true` or `idpRevokeFailed: true`, and the caller
  retries the same request.
- A runner treats close code 4401 as "revoked" and never retries. It records the verdict
  locally (`revoked.json`), so a later `bridge connect` mints a fresh runner id.
- **Revoked verdict at upgrade.** A runner that was offline when it was revoked would get a bare
  HTTP 403, which has no close code. Instead, when the token verified but the runner id or the
  credential is revoked, the server completes the upgrade only to send the `revoked` control
  envelope and close with 4401. That socket is never registered as a peer and reaches no
  routing. A missing or invalid token is still 401 and learns nothing. The identity provider
  may forget a revoked key altogether, so the device store also keeps the SHA-256 of the token
  that last authenticated each credential (never the token itself) and uses it to answer the
  verdict for a long-offline runner. A store or lookup failure keeps the 401.
- **Live revocation is only the device API.** The relay checks tokens and the store only at
  upgrade and `hello`. A session, key or grant revoked only at the identity provider takes
  effect at the next reconnect, at most one `maxSocketAgeMs` later.

## 7. The encrypted channel

Between a browser and a runner, every ACP message travels as an `E2EEFrame`:
`{ v: 1, kid, seq, nonce, ct }`, inside a `frame` envelope.

**Keys.** Each side has a long-term X25519 key (the browser's from enrollment, the runner's
per app). For each new browser/runner session, both contribute a fresh ephemeral key in
`session/init` and `session/accept`. Four Diffie-Hellman results are combined: static with
static, ephemeral with ephemeral, and the two cross pairs. HKDF-SHA256 over them, bound to all
four public keys, yields one AES-256-GCM key per direction. The session id `kid` is derived
from the same transcript. The first frame that decrypts proves the peer holds its long-term
key.

**Frames.** Each frame is AES-256-GCM over one UTF-8 JSON-RPC message with a fresh 12-byte
nonce. The associated data binds the frame version, `kid`, `seq` and direction, so frames
cannot be reflected, reordered across sessions or replayed. A receiver checks version, `kid`
and the exact next `seq` before decrypting. Any decryption fault destroys the session, and
the layer above drops frames for other sessions before they reach the codec. A key is capped at
2^32 encryptions per direction, after which a new session is required.

**Sessions end** with `session/close` carrying a reason: `closed`, `superseded` (a newer
session for the same browser key took over), `unknown_session` (for example the runner restarted),
`peer_gone`, `error` or `not_trusted`. A runner that sees its browser's channel close kills the
agent processes of that channel.

**Plaintext mode.** `bridge run --no-e2ee` (or `BRIDGE_E2EE=0`) selects unencrypted
`PlainFrame`s with the same sequencing. It exists for local development, prints a warning and
must never face a real server.

## 8. The runner

### 8.1 Process model

`bridge run` is one process per machine. It holds `~/.local/state/bridge/runner.lock`, so a
second runner stops with an error. For each connected app it also takes that app's
`worker.lock` in the app's state folder and, under that lock, sweeps what a crashed run left
behind for that app (contained session folders, secret folders, agent sandboxes). An app whose
lock is held elsewhere is logged and left unserved while the others continue.

Inside the one process, every app gets its own:

- connection to its relay (a link with its own backoff and status),
- ACP proxy, session limiter, local policy and audit logs,
- set of plugins and its routing scope,
- E2EE state (identity, trust list, enrollment window).

Sessions are capped per browser channel (4 by default) and per app (16 by default); sessions a
plugin starts count toward the per-app cap. The consequence of the single process is that a
crash, a runaway plugin or memory growth in one app's work affects every app, and all apps
share one agent subscription's rate limits. The kit does not isolate CPU or memory per app.

`bridge status` reads `runner.json` (pid, start time, browser count and, per app, the link
state). Link states are `online`, `connecting`, `reconnecting`, `update_required`,
`replaced`, `revoked`, `auth_failed`, `stopped` and `local`.

### 8.2 Lifecycle: install, service, idle stop

- **Install.** `bridge self install` (run by `bridge setup`) puts the release under
  `~/.local/share/bridge/versions/<version>/` and points two launcher links, `~/.local/bin/bridge`
  and `~/.local/bin/bridge-runner`, at it. `bridge-runner` exists because Linux systems often
  ship an unrelated `/usr/bin/bridge` (iproute2). Every install path is listed and confirmed
  before anything is written, and `bridge doctor --paths` lists them all. `bridge uninstall`
  removes exactly bridge's own entries and leaves shared folders alone.
- **Setup's one consent.** `bridge setup` lists every path it will write, grouped (install,
  connect, agents, service and handler), and asks once; each step then runs as under `--yes` and
  rechecks its own plan before writing. The agents group covers bridge's adapter and a separate
  sign-in for claude and codex found on `PATH`, never a copy of the person's login.
- **Service.** The background service (a systemd user unit on Linux, a launchd agent on macOS)
  and, on Linux, the `bridge://` link handler. The handler is an untrusted launcher: any web page
  can fire a `bridge://` link, so it accepts exactly `bridge://run` and
  `bridge://setup?url=<origin>`, runs only fixed commands, and starts setup with `--from-link`,
  whose one question defaults to no.
- **Idle stop.** The runner exits on its own after 15 minutes with no browser connected for any
  app and no open plugin session (an open enrollment window counts as activity). It is a normal
  exit, so the service manager does not restart it. A page's start button (the `bridge://run`
  link on Linux) or a pasted command on macOS starts it again. Each start prints a line and
  sends a desktop notification naming the connected apps.

### 8.3 Folders

Bridge owns only the `bridge/` segment inside each app's XDG folders:

| Folder | Holds |
|---|---|
| `~/.config/<app>/bridge/` | `app.json` (connection record), `trust.json`, `identity.json`, `identity.key` (only without a keychain), `enroll.json`, `revoked.json`, optional `config.json`, `plugins/` (one consent record per plugin) |
| `~/.local/share/<app>/bridge/` | `plugins/<id>/<version>/`, `plugin-data/<id>/` |
| `~/.local/state/<app>/bridge/` | `work/` (default session folder), `tmp/` (session sandboxes, secret files), `sessions/` (one empty folder per contained session), `audit/`, `worker.lock` |
| `~/.config/bridge/` | Machine-wide: `config.json`, `apps.json` (app id to origin), `policy.json`, `agents/` (bridge's own agent logins) |
| `~/.local/share/bridge/` | `versions/`, `adapters/claude/<version>/` |
| `~/.local/state/bridge/` | `runner.json`, `runner.log`, `runner.lock` |

The base folders follow `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME`, and the layout
is the same on macOS. Bridge creates an app's parent folders (`~/.config/<app>` and the other
two) only when missing, never removes them unless empty, and refuses to write through a
symlink at or inside the `bridge/` segment. Before serving, the runner checks that the apps'
`bridge/` folders and the machine folders do not alias one another.

### 8.4 Local policy

What agents may do is decided on the machine, never by a browser. `~/.config/bridge/policy.json`
holds:

- `mode`: `ask` (default), `read-only`, `accept-edits` or `bypass`. Bypass is off unless
  configured here.
- `agents`: which agents sessions may use.
- `allowedCwds`: where sessions may start. With none configured, a session starts only in the
  app's own work folder.
- `allowedTools`: tool names approved without asking.

An app's `~/.config/<app>/bridge/config.json` can narrow this for that app and never widen it:
`agents` are intersected, `mode` must be equal or stricter, `allowedCwds` entries must be
admitted by the machine policy. The same file sets `agent.default` and `agent.model`. A browser
that asks to change the permission mode is refused with -32010.

**Working directory.** `session/new` requires a `cwd`, but a page does not know the runner's
paths. The runner honors a `cwd` only when it is an absolute path. Anything else (missing, `.`,
relative) is replaced, silently, by the app's work folder. An absolute `cwd` is then checked
against `allowedCwds`; a refusal is -32012.

**Auto-approval shortcuts** in `read-only` and `accept-edits` modes are fail-closed. Every path a
request names is resolved component by component through symlinks, and the shortcut asks
whenever anything is ambiguous or touches a protected location: the runner's own folders, the
service directory, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.claude`, `~/.codex`,
`~/.netrc` and shell startup files. A session whose directory is the home directory gets no
shortcut. A configured `allowedCwds` root inside any app's protected folders is refused unless
it is that app's own work folder, so a broad root never admits one app into another's folders.

Permission requests that the policy does not answer go to the browser as the ACP
`session/request_permission`. Only the `allow_once` and `reject_once` options reach the
browser, and anything else is a denial.

### 8.5 Local-only apps

An app that runs on the machine alone can be registered with `bridge apps add-local <id>`. It
has the same folders, policy, plugin host and proxy as a hosted app but no relay link, token,
identity or browser trust list. A served local app keeps the runner up, since nothing could
bring a stopped runner back.

## 9. Agent adapters and sessions

### 9.1 Adapters

The runner starts agents only through ACP adapters; it has no one-shot exec path. An adapter
implements `AgentAdapter`: `id`, `availability()` and `spawn({ cwd, signal })`, which returns an
`AgentProcess` (the ACP stream, pid, exit promise, kill). The adapter owns discovery,
credential staging and the environment sandbox, so the proxy never handles a secret.

`createAcpAgentAdapter` wraps any agent that speaks ACP over stdio. The built-ins are:

- **claude**: the `claude-agent-acp` adapter. Bridge does not bundle it (it pulls in the Claude
  Agent SDK and binary, about 300 MB). `bridge agent install claude` installs one pinned
  version, checked against a pinned integrity, into bridge's own folder.
- **codex**: the `codex-acp` adapter (`@agentclientprotocol/codex-acp`, with `@openai/codex`; about
  450 MB). `bridge agent install codex` installs one pinned version the same way, and a
  `codex-acp` on `PATH` is the last fallback. Codex has no contained sessions.

Other agents can be added by embedding the CLI with an `adapters` list. See
[Write an adapter](guides/write-an-adapter.md).

### 9.2 What a session sees

Each spawn gets a throwaway directory containing a fresh HOME, TMPDIR and XDG folders. The
environment is rebuilt from an allow-list (application secrets are stripped), the agent runs in
the session's vetted `cwd`, and the directory is removed when the agent exits. Only the agent's
own credential file is staged into it. For claude, only the `claudeAiOauth` block of
`.credentials.json` is copied, not the file's other tokens.

### 9.3 Agent logins

Bridge keeps its own copy of each agent's login in `~/.config/bridge/agents/claude/` and
`~/.config/bridge/agents/codex/` (plain files, folders 0700, files 0600). It never writes
`~/.claude`, `~/.codex`, `$CLAUDE_CONFIG_DIR` or `$CODEX_HOME`, and never reads them while
serving sessions. A login arrives in one of two ways, both requiring a yes: a one-time copy of
the person's current login (a copy shares one grant with the terminal agent, so a refresh on
either side may sign the other out), or the agent's own sign-in run with its config folder
pointed at bridge's folder, which gives bridge a separate grant.

**Token write-back.** Agents refresh their tokens and providers rotate refresh tokens, so when a
session ends and the agent refreshed, the runner writes the new token back to bridge's own login
file, but only if that file has not changed since the copy was made (a stale base is rejected).
There is no switch to disable this: without it the next session would start with a retired
token. A login file that is a symlink, or lies in a symlinked folder, is refused.

**One session per login.** An exclusive lease, coordinated across processes and apps, allows one
active staged session per canonical login file. A second is refused as busy (`login_busy`).
Different login files are independent; copying one grant into several files is not a supported
way around the restriction. A lease is never stolen because its holder's pid vanished, since
descendants or the only rotated grant may still need recovery.

**When the lease is released** depends on evidence that the agent and its descendants are gone:

- **Linux:** the agent runs in its own PID namespace, so ending it ends every descendant.
- **macOS:** there are no PID namespaces. The agent runs in its own process group; after the
  group is killed, the runner waits until no process carries the group id, then writes back and
  releases. A descendant that starts a new session leaves the group and is not seen; a runner
  crash leaves the group running. The public cleanup receipt on macOS therefore never reports
  `quiescent`.
- **Other platforms** refuse a session that would stage a login (`sandbox_unavailable`).

### 9.4 Browser sessions

A browser drives an agent with the ACP methods `initialize`, `session/new`, `session/prompt`,
`session/cancel` and so on. The runner's proxy terminates the browser's channel, applies policy
at `session/new`, answers or forwards permission requests, and passes the rest to the agent.
A request for a session that does not exist, or has closed, gets -32015.

## 10. Plugins

A plugin is code an app ships to run on the user's machine, for example a local notes indexer with
its own search page. The runner runs it as a separate Node process, per app.

### 10.1 What a plugin is

A plugin is a package with a `bridge-plugin.json` manifest and a `package.json` with a semver
version. The manifest names a plugin `id`, the `app` it belongs to, an `entry` file and its
`permissions`:

- `network` (hosts) and `fs` (extra paths): declared and shown to the person; **not enforced**;
- `agents`: the agent ids the plugin may ask the runner for;
- `localUi`: that it wants a page on `127.0.0.1`;
- `mcpServers`: MCP servers it ships, by name, each with an `entry` inside the package and
  limited `args` (the only placeholders are `${PLUGIN_DATA}` and `${SESSION_SECRET_FILE}`);
- `headless.tools`: the exact tools, written `mcp__<server>__<tool>`, that its contained sessions
  may use without asking anyone;
- `execution`: the confined execution grant (section 11).

Unknown keys are rejected. The plugin `id` is also its method prefix: it serves `_<id>/<name>`
methods, and the id `bridge` is reserved.

### 10.2 How a plugin is hosted

- The plugin host keeps each app's plugins in that app's folders. A plugin installs only into
  the app its manifest names. The highest installed version runs; a crashed plugin restarts with
  backoff.
- The process gets a stripped environment and its own HOME, TMPDIR and XDG folders inside its
  data directory. This is an environment and path convention, not operating-system confinement.
  A plugin runs as the user and can do what the user can.
- Installation never contacts a registry and never runs package scripts. Dependencies must be
  bundled in the package. Sources are a local folder or tarball, an `https://` tarball with
  `--sha256`, or `npm:<name>@<exact version>` checked against the registry's `dist.integrity`
  and a pinned `--integrity`. Archives with links, special files, path traversal or oversized
  contents are rejected.
- The wire between host and plugin is newline-delimited JSON-RPC 2.0 over stdio. The SDK
  (`definePlugin`) hides it and offers `registerMethod`, `startAgentSession`, `localUi.listen`,
  `dataDir` and `log`.
- A browser call to `_<id>/<name>` is routed only to a plugin installed for the browser's own
  app. Each call carries a private token so a session started on behalf of a browser names that
  browser.
- **Local UI.** A plugin may serve a page bound to `127.0.0.1` on a free port. The runner sends
  the URL to the app's enrolled browsers inside the encrypted channel (`_bridge/localUi`); the
  page receives it through `bridge.onLocalUi`. The content never crosses the relay.

### 10.3 Consent

Installing a plugin prints what it will be allowed to do and every path it writes, then asks.
A recorded consent per plugin (`<id>.consent.json`, bound to a hash of the manifest's grant
surface) is what later authorizes contained sessions.

- A **widened grant** is a first install that declares `mcpServers` or `headless`, or an update
  that adds an item to the grant surface. Only a person at a terminal (stdin and stdout both
  terminals) can approve it. `--yes`, a pipe or an agent running the command is refused.
- `--yes` approves only an unchanged or narrower grant, and from a published source it needs a
  pinned hash. An app's own installer script runs in the person's terminal and gets the prompt
  there.
- An update shows the diff against what was approved. Installing identical content is a no-op.
- `plugin revoke` withdraws consent but keeps the plugin: its contained sessions stop and the
  next start fails with -32019. `plugin remove` deletes the plugin, its data and its audit log
  (`--keep-data` keeps both).
- `plugin add`, `remove` and `revoke` restart a running background service, which ends open
  agent sessions of every app. The command says so before asking.

### 10.4 Audit log

Every tool call of a plugin's contained sessions is appended, as one JSON line, to
`~/.local/state/<app>/bridge/audit/<plugin id>.jsonl` (mode 0600, rotated at 5 MiB). A record
holds the time, session id, trigger (`headless` or the browser), attached servers, call id, tool
name, status, a decision, and the SHA-256 digest and size of the tool input. The input itself and
the session secret are never written. The decision is `allow` (approved from the consented
set), `reject` or `cancel` (refused), or `none` (the agent ran the tool without asking; the call
is still recorded and counted). If a write to the audit log fails, the runner refuses to approve
that plugin's tool calls until the runner restarts, rather than let a call go unrecorded.

See [Write a plugin](guides/write-a-plugin.md) for the manifest, the SDK and the install
commands.

## 11. Plugin agent sessions: contained and confined

A plugin can start agent sessions of its own. An ordinary session (the plugin passes the `caller`
it received as `onBehalfOf`) behaves like a browser session: permission requests that policy
does not answer are forwarded to that browser, and without a `caller` they are cancelled. The
plugin never sees or answers a permission request.

For background work with nobody to ask, there are two stricter profiles. Both are additive,
explicit, and never an automatic fallback: an unsupported agent, platform or missing
prerequisite is refused, not downgraded to an unrestricted session.

| | Contained | Confined (`confined-v1`) |
|---|---|---|
| Request | `tools: { builtins: "none" }` | `execution: { profile: "confined-v1", network: [...] }` |
| Manifest grant | `mcpServers` and `headless.tools` | `permissions.execution` (and, for a broker, an `fs` subtree) |
| Agent's built-in tools | None | Shell, file and search tools run inside an OS sandbox |
| What holds it | The agent is given no other tools than the plugin's attached MCP servers | A bubblewrap-based sandbox with exact network endpoints |
| Agents and platforms | claude, Linux x64 | claude, Linux x64 |
| Working directory | An empty folder the runner makes | A bounded workspace the runner owns |

Options that belong to these profiles (`mcpServers`, `secret`, `budget`, `headless`, a
non-empty `tools.allow`) are refused with -32016 on an ordinary session.

### 11.1 Contained sessions

- **Tools.** The agent has none of its built-in tools. Its only tools are the MCP servers the
  plugin declared and attached, and of those only the tools in the headless set the person
  approved at install. Machine `allowedTools` and `mode` add nothing. A permission request for a
  tool outside the set is rejected and never reaches a browser.
- **Environment.** A contained session starts in an empty private folder
  (`<state>/<app>/bridge/sessions/<session id>`), loads no `CLAUDE.md`, `.mcp.json`, hooks or
  settings, and has no slash commands (a prompt starting with `/` is refused). The plugin may
  not name a `cwd`.
- **Secret delivery.** A `secret` (up to 4096 bytes) is written by the runner to a mode-0600 file
  in a folder of its own, outside every directory in the agent's environment, and only the
  path replaces `${SESSION_SECRET_FILE}` in the server's args. The secret is never in an
  environment variable, argument, ACP or relay frame, log line or audit record. The privacy of
  the file is per user account, not per process.
- **Events.** The plugin receives `tool_call`, `tool_call_update`, `text`, `plan` and `usage`
  events and an `ended` reason. Raw input and results appear only for the plugin's own `mcp__`
  tools. Nothing extra crosses the relay.
- **Budget.** `{ wallClockMs, maxToolCalls }`, defaulting to 15 minutes and 200 calls, capped at
  1 hour and 500 calls. The person's `sessionBudget` in `policy.json` and an app's `config.json`
  can only lower the ceiling. The clock runs from the start request.
- **Model.** The plugin may name a model only if the policy's `models` allow-list admits it;
  otherwise the app's `agent.model` is used. With a `models` list and no model available, the
  session is refused with -32012.
- **How containment is held.** The control is the command line the adapter is started with,
  which leaves the agent no other tools. It is measured for one pinned adapter and binary pair
  and accepted from those versions up, asserted by the runner's tests, and detected at runtime:
  the runner checks the versions, the agent's `session/new` answer and every tool call it sees.
  A call outside the set ends the session as `breach` (-32017). That is a detection after the
  fact, so the call may already have run: the kill is the backstop, not the control. A newer
  adapter or binary is accepted and logged but not re-measured; an older one or an unreadable
  version is refused. The adapter must be bridge's own installed copy; one found on `PATH` or
  named by an environment variable serves ordinary sessions only. `bridge doctor` and
  `bridge doctor --containment` report the state.

### 11.2 Confined execution

For a job that needs a shell and files (a data-analysis script, for example), a plugin declares
`permissions.execution = { profile: "confined-v1", network: ["host:443", ...], broker?: "http-unix" }`
and requests the same in `startAgentSession`. The two profiles cannot be mixed in one session.

- The runner owns a bounded workspace and an artifact area and refuses a caller-supplied `cwd`.
  The agent does not receive app settings, app credentials or the app's database.
- An OS sandbox (bubblewrap with a seccomp filter and a network proxy, through the sandbox
  runtime) denies reading the filesystem by default, allows only the workspace and runtime
  files, and permits network access only to the exact public `host:443` endpoints the person
  consented to at install. There are no wildcards, arbitrary addresses or general localhost
  access, and private address ranges are denied after resolution.
- A **broker** lets a thin MCP server forward to an app-owned service. The session names a Unix
  socket under the plugin's data directory, covered by an explicitly consented `fs` subtree. The
  runner rejects paths outside it, symlink redirects, non-sockets and wrong ownership. The MCP
  server runs outside the agent sandbox under a tighter profile and reads its app secret from
  file descriptor 3 (`secretTransport: "fd3"`), never from a file. A distinct per-session
  transport capability reaches only the authorized broker through the sandbox proxy.
- Prerequisites are Linux x64, bubblewrap, socat, ripgrep, util-linux and enabled unprivileged
  user and PID namespaces. `bridge doctor --containment` reports them with a fixed hint.

### 11.3 Cleanup receipts

An ended session, a successful cancellation or a `closed` reason is not proof that the agent's
descendants have stopped. The plugin SDK exposes a separate `session.quiescence` receipt:

- `{ status: "quiescent", mechanism: "linux-pid-namespace" }`: the runner observed namespace
  teardown and revoked the session's capability and closed its server resources.
- `{ status: "incomplete", mechanism, reason }` with `reason` one of `descendants-unverified`,
  `timeout`, `termination-failed`, `cleanup-unavailable` or `disconnected`.

Missing evidence, disconnection and timeout never become a success. A consumer reuses a run
workspace only after a `quiescent` receipt. Staged state and the login lease are retained when
cleanup or write-back cannot be verified.

## 12. Credentials and the keychain

Every secret has one home, and the kit lists them.

| Secret | Where it lives |
|---|---|
| The runner's sign-in credential for an app (device-grant tokens, or an enrollment API key) | The OS keychain, or the file store |
| The key that wraps each app's runner identity | The OS keychain, or the file store |
| The runner identity itself (`identity.json`) | The app's config folder, sealed with the wrapping key, mode 0600 |
| The browser's long-term key | The browser's IndexedDB, non-extractable |
| Bridge's own agent logins | `~/.config/bridge/agents/`, plain files (section 9.3) |
| A contained session's secret | A mode-0600 file in a per-session folder, removed when the session ends |

**Keychain.** The runner stores its credentials under the service name `berdyh-bridge`, through
`secret-tool` (Secret Service) on Linux and `security` (login keychain) on macOS. Secrets go to
the store commands over stdin, never as arguments. `HOME` and the XDG variables do not isolate
the keychain, so a scratch-`HOME` run still talks to the real one.

**File store.** On a machine with no keychain (a server, a container, CI), set
`BRIDGE_CREDENTIAL_STORE=file:<absolute dir>`. The directory must be a real directory owned by
the user with no access for others; each credential is a mode-0600 file. The files are not
encrypted, `bridge doctor` warns while the store is in use, and the setting is copied into the
service definition so the service uses the same store. A malformed value is an error and never
falls back to the keychain.

**Typed keychain access.** `createKeychainAccess({ service })` in `@berdyh/bridge-runner` gives
a host adapter a bounded credential store (`get`, `set`, `delete` on `store`) and an
observational `inspect()` that reports `available`, `absent`, `locked` or `unknown` with a
stable reason code. Inspection reads no credential or item, starts no service, prompts for no
unlock and creates nothing. Only `absent` may enter an app's explicitly approved file fallback;
locked, unknown, timeout and denial may not. A store error says whether the operation did not
start or has an unknown outcome. A failed or timed-out write after dispatch latches the facade:
it reports unknown availability and refuses further mutations until the caller reconciles and
constructs a new facade. Applications keep ownership of their credential JSON, migration and
fallback policy. See [Typed keychain access](guides/typed-keychain-access.md).

**Uninstall and removal.** `bridge apps remove` and `bridge uninstall` delete the app's
keychain entries (or file-store entries), its trust list and identity, and its `bridge/`
folders.

## 13. Platform support and limits

| | Linux | macOS | Windows |
|---|---|---|---|
| Runner and CLI | Supported (Node 22 or newer) | Supported | Not supported natively; use WSL2 |
| Background service | systemd user unit | launchd agent | Through WSL2 only |
| `bridge://` link handler | Supported (restarts the runner from the page) | None: the page shows a command to paste | n/a |
| Credential store | Secret Service through `secret-tool`, or file store | Login keychain through `security`, or file store | n/a |
| Ordinary agent sessions (claude, codex) | Supported | Supported | n/a |
| Staged-login cleanup | PID namespace | Process group (weaker, section 9.3) | n/a |
| Contained sessions | claude, Linux x64 | Refused | n/a |
| Confined execution | claude, Linux x64 | Refused | n/a |

Specific limits:

- **macOS login location.** Claude Code on macOS may keep its login in the Keychain instead of a
  file, so copying the login finds no file and a separate sign-in may not leave one in bridge's
  folder. The command then exits with an error that says so.
- **macOS keychain details.** A locked keychain makes `security` wait for an unlock prompt, so a
  call ends at its deadline as `timeout`, not `locked`. A `security -i` line longer than 4095
  bytes would be split, so such a write is refused before dispatch (`invalid_input`). Lock
  inspection reports `unknown`. Reads decode values exactly, and no error quotes command output.
- **No inbound port.** Nothing listens for the hosted page. The only listeners are a plugin's
  optional `127.0.0.1` page and the Node reference server used in development.
- **Update check.** `bridge doctor` and `bridge run` ask the npm registry once for the newest
  release (3 seconds at most, no install, no token); `BRIDGE_UPDATE_CHECK=0` turns it off.
- **One adapter pin.** Contained sessions are measured for one adapter and binary pair on one
  platform, and rise only when a newer pair is measured.

## 14. Security model

| Threat | Control |
|---|---|
| Relay or app server compromised and forging commands | The runner acts only on frames authenticated by keys it enrolled itself. The RPC surface is narrow (ACP methods and a plugin's own `_` methods). The permission mode is set only by local policy. |
| Relay reading content | Frames are AES-256-GCM end to end; the relay forwards bodies unparsed. It sees routing headers, timing, sizes and presence. |
| A new controller added by a compromised server or identity account | Enrollment needs a code shown on the user's machine, a SPAKE2 exchange, and a person confirming four words (or, in an interactive `bridge setup`, the code only ever reaching the browser setup opened, which is trusted on the window's first request). The trust list is on the runner. |
| Phished or guessed enrollment code | 8 characters from a 20-letter alphabet, 10-minute window, single use, 5 attempts counted when the runner replies, and the person must still confirm the browser. |
| Phished pairing code | The approval page shows the device's hostname, OS and version (app-hosted enrollment); a pending request expires in 10 minutes by default. |
| Stolen runner credential | The device list in the app revokes it and closes its socket. With app-hosted enrollment the credential id is tombstoned and the key revoked; with the OAuth opt-in a refresh token can outlive a device revocation until the grant is revoked at the provider. Credentials sit in the OS keychain. |
| Cross-app bleed | Separate server, database and identity application per app; per-app credential, connection, trust list, plugins and folders on the machine; the verifier checks the token issuer and the browser's authorized party against the app's own origin. |
| A page opening arbitrary agents or folders | Local policy: allowed agents, allowed working directories, per-channel and per-app session caps. A page's `cwd` is a hint. |
| A malicious or buggy plugin | Consent at install (a person at a terminal for widened grants); a stripped environment; contained sessions limited to consented tools; every tool call audited. The plugin process itself is not sandboxed. |
| A prompt-injected agent | A contained session has no built-in tools; a confined one runs in an OS sandbox with exact network endpoints; ordinary sessions follow policy and ask the person. |
| Token loss from concurrent refresh | One staged session per login file, write-back only on an unchanged base, retention of staged state when cleanup is unverified. |
| `bridge://` links fired by any web page | The handler accepts two fixed URL shapes and runs only fixed commands. |
| A runner that was revoked while offline | The relay completes the upgrade only to send the `revoked` verdict and close 4401; the runner parks and does not retry. |

Known limits, stated plainly:

- Declared plugin `network` and `fs` grants are shown but not enforced. A plugin and its MCP
  servers run as the user, and a contained session's MCP server can read whatever the user can,
  including bridge's staged agent login for that run.
- Containment is "measured, pinned, asserted and detected". Detection of an out-of-set tool call
  happens after the call started.
- The per-session secret file is private to the user account, not to one process.
- A machine administrator can change agent settings the kit cannot see; this is out of scope.
- One runner process serves all apps, so there is no per-app CPU, memory or crash isolation.
- Revocation at the identity provider alone reaches an open socket only at the next maximum-age
  reconnect; revoke through the device API to cut a runner off at once.
- On macOS a descendant that leaves its process group can outlive the lease release.
- Plaintext mode exists for local development only.

## 15. Wire contracts and error codes

The names below are the stable surface a consumer can depend on. Field-level detail is in the
packages' types and in the guides.

### 15.1 JSON-RPC errors from the runner

Returned to a browser, or to a plugin through the SDK.

| Code | Name | Meaning |
|---|---|---|
| -32602 | invalid params | The request is malformed: for example an undeclared or unconsented server or tool, a `cwd` on a contained session, a secret nobody reads, a prompt starting with `/` in a contained session |
| -32010 | `permissionModeForbidden` | A request tried to change the permission mode or enable bypass; the mode is local policy only |
| -32011 | `unknownAgent` | The named agent is not known, or none is available on the machine |
| -32012 | `sessionNotAllowed` | Local policy refuses the agent, working directory or model, or a session cap is reached |
| -32013 | `extensionNotFound` | No plugin of this app handles the `_` method |
| -32014 | `extensionForbidden` | The plugin belongs to another app, or the browser does not own the call |
| -32015 | `unknownSession` | The session id is unknown or the session is closed |
| -32016 | `containmentUnavailable` | A contained or confined session cannot be provided: a contained-only option on an ordinary session, no profile for the agent or its versions, a failed pre-start check. The message is generic and the reason stays in the local log, except `data: { reason, hint }` below |
| -32017 | `containmentBreach` | The session was killed because the agent used a tool outside its set; the call may already have run |
| -32018 | `budgetExceeded` | The wall-clock or tool-call budget is used up |
| -32019 | `consentMissing` | The runner holds no valid consent for the plugin: revoked, no record for the installed version, or a hash mismatch |

`-32016` carries `data: { reason, hint }` only for fixed reasons, with fixed hint strings:

| `reason` | Meaning |
|---|---|
| `adapter_missing` | The claude adapter is not installed (`bridge agent install claude`) |
| `sandbox_unavailable` | Sandbox prerequisites are missing, or the platform cannot give cleanup evidence for a staged login |
| `execution_unsupported` | Confined execution needs Linux x64 and the claude adapter |
| `login_busy` | Another session holds the agent login |

### 15.2 Relay close codes and HTTP status

| Code | Meaning | Client action |
|---|---|---|
| 4409 `RELAY_CLOSE_REPLACED` | A newer socket replaced this one | Do not reconnect |
| 4401 `RELAY_CLOSE_REVOKED` | The device or credential is revoked | Do not retry; treat as revoked |
| 1012 `RELAY_CLOSE_MAX_AGE` | The socket reached its maximum age | Reconnect with a fresh token |
| 1008 | A runner did not send `hello` in time | Reconnect |
| 1003 | A binary frame was sent (text only) | Fix the sender |
| 1006 | Abnormal close, for example after backpressure | Reconnect |

HTTP at the upgrade: 401 (missing or invalid token), 403 (origin not allowed, or refused), 426
(a host that upgrades outside `fetch`), 429 with `Retry-After` (socket cap), 503 (an
infrastructure failure in the verifier or store).

### 15.3 Relay messages

- `hello`, `welcome` (runner handshake), `RunnerHello.protocol` and the server `protocol` range.
- Envelope kinds: `frame`, `pake`, `presence`, `control`.
- `control` types: `update_required`, `peer_reconnected`, `peer_gone`, `revoked`, `error`.
- `error` codes: `protocol_mismatch`, `unknown_runner`, `unauthorized`, `bad_envelope`,
  `backpressure`, `rate_limited`, `revoked`.
- Text heartbeat frames: `bridge:ping` and `bridge:pong` (transport only).

### 15.4 Enrollment and session messages

- Enrollment: `pake/start`, `pake/reply`, `pake/confirm`, `pake/done`. Failure reasons on
  `pake/done`: `bad_code`, `expired`, `locked`, `rejected_by_user`, `no_enrollment_open`,
  `protocol_error`. A `locked` or `expired` code is dead and needs a new one.
- Session: `session/init`, `session/accept`, `session/close` with reasons `closed`,
  `superseded`, `unknown_session`, `peer_gone`, `error`, `not_trusted`.
- Frames: `E2EEFrame` (`v`, `kid`, `seq`, `nonce`, `ct`), `AckFrame` (`v`, `kid`, `ack`), and the
  development-only `PlainFrame`.

### 15.5 Plugin session contracts

- `session.ended` reasons: `closed`, `cancelled`, `budget`, `breach`, `agent_exited`,
  `plugin_gone`, `runner_shutdown`. A prompt in flight when the session ends for `breach` or
  `budget` rejects with -32017 or -32018.
- Session events: `tool_call`, `tool_call_update`, `text`, `plan`, `usage`.
- `session.sessionId` is the runner's session id. It is the same id the audit log, the runner log
  and the session folder name carry. It is a correlation id, not a capability.
- `session.quiescence` receipts: section 11.3.
- Plugin RPC methods the SDK uses with the host: `host/startAgentSession`, `host/sessionUpdate`,
  `host/sessionEnded`, `plugin/ready`, `plugin/call`, and the browser-facing `_bridge/localUi`.

### 15.6 Client SDK states

`no_runner`, `runner_offline`, `online_not_enrolled`, `ready`, `runner_selection_required`
(section 5.3). `consumeEnrollLink()`, `setupInstructions()`, `permissionPrompt()` and
`defineElements()` (`bridge-setup`, `bridge-permission`) are the helpers an app page uses.

### 15.7 Device API responses

`DELETE /bridge/devices/:id` answers 200 with optional `alreadyRevoked`, `socketCloseFailed`
and `idpRevokeFailed` flags, 404 only for a device never known. The app-hosted enrollment
endpoints use OAuth-style error names such as `expired_token` and `invalid_grant`.

### 15.8 Keychain codes

`KeychainOperationError.code` is one of `unsupported_platform`, `executable_missing`,
`timeout`, `access_denied`, `locked`, `command_failed`, `output_limit`, `invalid_input`,
`mutation_uncertain`, with `outcome` `not_started` or `unknown`. Availability reasons are listed
in [Typed keychain access](guides/typed-keychain-access.md).

### 15.9 Versioning

The wire protocol version (`PROTOCOL_VERSION`, currently 1) is negotiated in the handshake as
an inclusive range. A runner below the server's minimum gets `update_required`; a server below
the runner's minimum yields `protocol_mismatch`. Package versions are exact-pinned by
consumers.

## 16. Where to go next

- Quick start and repository overview: [README](../README.md).
- Deploy a server and add the client to a page:
  [Add the bridge to an app](guides/add-to-an-app.md).
- Install, run and troubleshoot the runner: [Operate the runner](guides/operate-the-runner.md).
- Ship code that runs on the user's machine: [Write a plugin](guides/write-a-plugin.md).
- Support another agent or server runtime: [Write an adapter](guides/write-an-adapter.md).
- Use the OS keychain from a host adapter:
  [Typed keychain access](guides/typed-keychain-access.md).
- Package READMEs: [protocol](../packages/protocol/README.md),
  [crypto](../packages/crypto/README.md), [pairing](../packages/pairing/README.md),
  [runner](../packages/runner/README.md), [cli](../packages/cli/README.md),
  [client](../packages/client/README.md), [plugin-sdk](../packages/plugin-sdk/README.md),
  [server](../packages/server/README.md).
