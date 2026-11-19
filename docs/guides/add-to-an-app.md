# Add the bridge to an app

This guide deploys the server kit for your app, adds the client SDK to a page, and adds
the enroll page that lets a user set up their local runner from your app.
Each app deploys its own server, with its own database and Clerk application. Do not
share them between apps.

## 1. Choose a server stack

| Piece | Default | Alternatives |
|---|---|---|
| Runtime and relay | Cloudflare Worker plus a Durable Object (`@berdyh/bridge-server-cf`) | Node with `ws` (`@berdyh/bridge-server-node`) |
| Device store | Neon (`@berdyh/bridge-server-neon`) | D1 (`@berdyh/bridge-server-d1`), or your own `DeviceStore` |
| Auth | Clerk (`@berdyh/bridge-server-clerk`) | Your own `AuthVerifier` |

The core is `@berdyh/bridge-server`. `createBridgeApp(config)` returns an `HttpHost`
(a plain `fetch` handler) that serves `/.well-known/bridge.json`, the device API
(`/bridge/devices`) and the relay upgrade routes.

## 2. Deploy on Cloudflare

1. Copy `packages/server-cf/templates/worker.ts` and `packages/server-cf/wrangler.toml.example`
   into your Worker project and install the bridge adapter packages there. The packages
   publish `dist` only, so copy the template files and the SQL migrations from this
   repository.
2. Create a separate Clerk application for this app. Put its issuer in `CLERK_ISSUER`,
   the public OAuth client id of the runner in `CLERK_CLIENT_ID`, and your page's origin
   in `APP_ORIGIN`. Enable the device grant for that client.
3. Create a Neon project for this app and apply `packages/server-neon/migrations/0001_devices.sql`, then `0002_credential_fingerprint.sql` (a nullable column that lets a runner revoked while offline for long still get the revoked verdict; without it that runner keeps a 401 and nothing else changes).
   For D1, copy the migrations in `packages/server-d1/migrations/` (`0001_devices.sql`,
   `0002_credential_fingerprint.sql`, and `0003_enrollment.sql` only if you mount app-hosted
   enrollment, see [the revocation window](#the-revocation-window-of-the-clerk-opt-in)) into your D1 migrations directory and use
   `createD1DeviceStore(env.DB)` in the template instead of the Neon store. Also add
   `DB: D1Database` to `Env`, enable the `[[d1_databases]]` block in `wrangler.toml` with
   binding `DB` (and `migrations_dir`), and apply the migration with `wrangler d1 migrations apply`.
4. Set `DATABASE_URL` and `CLERK_SECRET_KEY` as Worker secrets, never as `[vars]`.
5. Keep the template's Durable Object binding `RELAY` and its migration
   (`new_sqlite_classes = ["Relay"]`). The Worker exports `Relay` and a default fetch handler:

   ```ts
   export const Relay = createRelayDurableObject(configFor);
   export default createBridgeWorker(configFor);
   ```

6. The template turns on `oauth: { clientId, allowWithoutCredentialId: true }` in
   `createClerkVerifier`. Read the revocation window below before you ship that.

More detail on liveness, hibernation and limits: [packages/server-cf/README.md](../../packages/server-cf/README.md).
What a real deployment needs and what the local example does not cover:
[packages/server-cf/example/DEPLOY.md](../../packages/server-cf/example/DEPLOY.md).

### What revocation the relay sees live

The relay checks tokens only when a socket opens. **Revoking a device through the device
API (`DELETE /bridge/devices/:id`, or `bridge` CLI revoke) is the only revocation the
relay observes live**: it closes the sockets at once. If you revoke a session, API key
or OAuth grant only at the identity provider, an already open socket stays up until it
reaches `maxSocketAgeMs` (default 12 hours; set it in the server config, 0 disables).
At that age the relay closes it with code 1012, the client and runner reconnect with a
fresh token, and the provider refuses the revoked one. To cut a runner off immediately,
revoke the device through the device API.

### Rate limit the public routes

The bridge routes are reachable by anyone, and a request with a well-formed junk token
still costs a Clerk Backend API call (API key and OAuth introspection, or a JWKS fetch
for an unknown JWT `kid`). The verifier drops oversized or non-token strings before any
call, and `jwtKey` removes the JWKS fetch, but only an edge rule bounds the rest.
In Cloudflare, add a rate-limiting rule (Security > WAF > Rate limiting rules) that
matches `starts_with(http.request.uri.path, "/relay/") or starts_with(http.request.uri.path, "/bridge/devices")`,
counts per client IP, and blocks above a rate that fits your users (for example 60
requests per minute). The Worker does not throttle by itself.

Also set `CLERK_JWT_KEY` to the Clerk instance's PEM public key (Clerk dashboard,
API keys, "JWKS Public Key"). The template passes it as `jwtKey`, so browser JWTs
verify without a network call.

### The revocation window of the Clerk opt-in

Clerk's backend SDK gives no stable grant id for an OAuth device grant. With
`allowWithoutCredentialId: true` the verifier returns a principal with no
`credentialId`, so revoking a device only bans its device id. **A revoked machine can
reconnect under a new runner id and keep refreshing access tokens, for as long as its
refresh token or grant stays valid, or until you revoke the grant in Clerk.** Access-token
expiry alone does not end the window, because the runner requests `offline_access`.

Clerk gives nothing that identifies the grant (the OAuth access token has no session or grant id, and
its `jti` changes on every refresh), so `resolveGrant` receives only `{ id, subject, clientId }`. What
closes the window:

- **API-key runner credentials.** Pair the runner with a Clerk user API key (`ak_...`) instead of an
  OAuth device grant. The kit ships this as app-hosted enrollment: mount `createRunnerEnrollmentApp`
  (from `@berdyh/bridge-server`) at `/bridge/enrollment/*`, with `createClerkEnrollmentIssuer`
  minting the key and the `enrollment` option of `createClerkVerifier` accepting only those keys;
  the D1 store is `createD1EnrollmentStore` and needs `0003_enrollment.sql` (see
  [Pairing and enrollment](../ARCHITECTURE.md#5-pairing-and-enrollment)). You can also mint a user
  API key from a code page of your own. The credential id is the stable `api_key:<key id>`, so revoking the device through
  the device API tombstones it and revokes the key at Clerk, and a revoked machine cannot reconnect
  with it. Clerk keeps accepting a revoked key for about a minute; the tombstone covers that.
- **Revoke the grant by hand**, from a trusted backend that holds an access or refresh token of it:
  `clerkClient.oauthApplications.revokeToken({ oauthApplicationId, token })`.
- **`resolveGrant` and `revokeGrant`** (both, together) help only an app that fronts the token endpoint
  and so sees the grant when it is issued and can key its own store.

If the revoked-machine window matters to you, use the API-key credential; if you accept it, say so in
your own risk notes. The claim shapes the verifier requires (`sub` as `user_*`, and for a browser
token `sid` as `sess_*`) and the full reasoning are in
[packages/server-clerk/README.md](../../packages/server-clerk/README.md).
Without the opt-in and without the hooks, the verifier refuses OAuth tokens.

## 3. Or run the server on Node

```ts
import { createNodeBridgeServer, createStubAuthVerifier } from "@berdyh/bridge-server-node";

const server = await createNodeBridgeServer({
  app: { id: "my-app", name: "My app" },
  auth: { issuer, clientId, deviceAuthorizationEndpoint, tokenEndpoint },
  adapters: { verifier /* your AuthVerifier */, store /* your DeviceStore */ },
  port: 8787,
  origin: "https://my-app.example", // the public origin, not the loopback one
  enrollPage: "/bridge/enroll",     // optional: see "Serve the enroll page"
});
```

It binds `127.0.0.1`, so put your own TLS proxy in front of it. Behind a proxy `origin`
must be the public origin: it defaults to `http://127.0.0.1:<port>`, which would make
`bridge.json` fail `bridge connect` and make the server refuse the real page. `relayUrl`
and `allowedBrowserOrigins` default from `origin`, so `relayUrl` becomes
`wss://my-app.example/relay` and the proxy must forward WebSocket upgrades on `/relay/*`. Without `adapters` it
uses an in-memory store and a stub verifier whose token maps are empty, so nothing
authenticates. For local development, pass your own `createStubAuthVerifier({ browser: {...}, runner: {...} })`
with fixed tokens; never do that on a reachable host. The Node relay keeps sockets in memory and
drops them on restart. Runners and clients reconnect and replay by `seq`, as they do after
a Durable Object deploy. The `tap` option dumps relay traffic for tests and must stay off
in production.

## 4. Add the client SDK to the page

```ts
import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { connectBridge } from "@berdyh/bridge-client";

const bridge = await connectBridge({
  discoveryUrl: `${location.origin}/.well-known/bridge.json`, // absolute, same-origin; HTTPS, or HTTP on loopback
  // Called on every (re)connect. Clerk resolves null when signed out: throw instead.
  getSessionToken: async () => {
    const token = await clerk.session?.getToken();
    if (!token) throw new Error("Sign in");
    return token;
  },
  label: "My app in Chrome", // shown on the runner when it asks to trust this browser
});

bridge.onRunners((runners) => { /* PresenceBody[]: the runners the relay knows for this user, each with `online` */ });
```

1. **Enroll once per browser and runner.** `bridge setup <app-url>` does this without typing
   when your app serves an enroll page (next section). Without one, the user runs
   `bridge enroll <app>` on their machine and reads out the 8-character code. Then:

   ```ts
   await bridge.enroll(code, runnerId); // runnerId may be omitted if exactly one runner is online
   ```

   The browser key is non-extractable and lives in IndexedDB. There is one long-term
   browser key per app (per origin and app id). If the key is lost, the user enrolls again
   with a new code. The user must confirm the browser on the runner before it is trusted.
2. **Drive an agent.** Build an ACP client app with the ACP SDK and attach it:

   ```ts
   const app = client({ name: "my-app" })
     .onNotification("session/update", ({ params }) => { /* stream chunks to the UI */ })
     .onRequest("session/request_permission", async ({ params }) => ({ outcome: { outcome: "selected", optionId } }));
   const connection = await bridge.acp(app, runnerId);
   await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
   const { sessionId } = await connection.agent.request("session/new", { cwd, mcpServers: [] });
   await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
   ```

   **`cwd` is a hint your page cannot fill in.** The page does not know the runner's paths, and
   the runner (`packages/runner/src/acp/proxy.ts`, `usableCwd`) honours `cwd` only when it is an absolute
   path string. A `cwd` that is missing, `"."`, relative or not a string is **replaced, silently,
   by that app's own work folder**, `~/.local/state/<app>/bridge/work` (per app, created 0700 when the first
   session needs it). Nothing in the `session/new` reply says which folder was used. An absolute `cwd` is
   used as sent only if the user's local policy admits it (`allowedCwds` in `policy.json`; with none set,
   only the app's work folder): otherwise `session/new` fails with `session not allowed by local policy`
   (-32012). So send `"."` and your sessions get the work folder, or send a project folder you have
   asked the user to allow. See [Operate the runner](operate-the-runner.md#the-per-app-work-folder).
   `bridge.stream()` and `bridge.channel()` are the lower-level forms of `bridge.acp()`.
   Each call opens a new channel and closes the previous one to that runner.
   A complete headless example is `e2e/src/page.ts`.
3. **Plugin UI.** `bridge.onLocalUi(({ pluginId, url }) => ...)` delivers the URL a plugin
   serves on the user's machine. Offer an "Open local UI" link. The content never touches the relay.
4. Call `bridge.close()` when the page is done.

In Node the SDK needs an explicit `keyStore` (an object with `load`, `save`, `delete`)
and, to look like a browser, a `webSocket` that sends an `Origin` header. The server refuses
browser sockets without an allowed `Origin`; by default only the app's own origin is allowed
(`allowedBrowserOrigins` in the server config).

### Heartbeat

After 20 seconds without outbound traffic the client sends the text frame `bridge:ping`.
If nothing arrives within 10 seconds it treats the socket as half-open and reconnects.
Servers answer `bridge:pong` at the transport layer; neither string reaches the relay core.
The runner does the same. Both peers accept only `bridge:pong` as the answer, not any
other inbound frame. A custom `RelayTransport` must answer it. The Cloudflare adapter
closes a socket idle for 60 seconds.

### Node key stores

If you pass your own `KeyStore` in Node, use **one handle per backend**, or make `save`
insert-if-absent. Two handles over the same backend with no locking can race the first
enrollment. In browsers, enrollment takes a Web Lock (`navigator.locks`), which covers this.

## 5. Let users set up the runner from your app

`bridge setup <app-url>` installs the runner, signs the user in to your app, and pairs the
browser. The user runs one command and compares four words. Your app supplies three
things: an enroll page, the setup copy and a status pill. The kit gives you the pieces
for all three.

### Serve the enroll page

Set `enrollPage` in the server config (`createBridgeApp`, `createNodeBridgeServer` and the
Cloudflare template take it; the template sets `"/bridge/enroll"`). It is a path on your
app's origin. The server puts it in `/.well-known/bridge.json`. It must start with a single
`/`, and contain no `?`, `#` or backslash, and stay on the app origin; `createBridgeApp` throws on an invalid value. Leave it out and `bridge setup` falls back to printing the code to type.

Then serve a page at that path. `bridge setup` and `bridge enroll <app> --open` open
`https://<origin><enrollPage>#code=XXXXXXXX&runner=<runnerId>`. The code is in the URL fragment,
which browsers never send to a server, so it does not reach your server or its logs.
The page needs this much:

```ts
import { connectBridge, consumeEnrollLink, wordsOf } from "@berdyh/bridge-client";

const link = consumeEnrollLink();   // first: strips the fragment from the URL, never enrolls
// If the user is signed out, redirect to sign-in now, from here. The next load of this page resumes the link.
const bridge = await connectBridge({ discoveryUrl, getSessionToken, label });
bridge.status().then(render);       // the first answer
bridge.onStatus(render);            // later changes; "ready" only when this browser is trusted
if (link) {
  pairButton.onclick = () => bridge.enroll(link.code, link.runnerId, {
    onBrowserKey: (id) => words.textContent = wordsOf(id).join(" "),
  });
}
```

Rules:

- Call `consumeEnrollLink()` before analytics, auth redirects or any other code that reads
  the URL. Treat the link as secret: do not send it to analytics or your server.
- **Keep the fragment across sign-in: do not redirect to sign-in on the server.** The code is in the URL
  fragment, which a browser never sends to a server, so a server-side check on the enroll route (a
  Clerk middleware that redirects a signed-out request to sign-in, say) cannot see it. It redirects
  before any script of your page has run; your sign-in hands the user back to a URL the server
  built, with no fragment, and the code is gone. The kit assumes the redirect is made by the page: serve the enroll
  page to signed-out visitors, let `consumeEnrollLink()` run first (it saves the link in this tab's
  `sessionStorage`, scoped to the page's path, for ten minutes), then send the user to sign-in from
  script. The next load of the same path, after sign-in, resumes the link. If the link is lost anyway
  (storage disabled, another tab or browser profile, more than ten minutes), the user can type the
  8-character code `bridge enroll <app>` prints into a field of your page, and you call
  `bridge.enroll(code, runnerId)` with it.
- Never enroll on load. Enroll only on an explicit click, so a link nobody asked for cannot
  pair a browser. The runner also asks the user to approve the browser.
- Show the four words (`wordsOf(keyId)`) next to the button, as text. The user compares them with the
  words in the terminal and approves only if all four match.
- The link is returned once per document. It is also saved in `sessionStorage` for ten minutes so
  it survives a sign-in redirect; a failed save does not break a direct link.
  Codes expire after ten minutes.
- `PresenceBody.hostname` is the machine's name, display text only. Use it in "Pair with
  <hostname>" when it is present.

### Read the status

`bridge.status(runnerId?)` resolves once; `bridge.onStatus(handler, runnerId?)` calls
the handler whenever the answer changes and returns an unsubscribe function. Both give
`{ state, runner? }`. A page cannot know that the runner is not installed. It only knows
that no runner is online for this user. `runner` is a `PresenceBody` (it has `runnerId`,
`online` and, usually, `hostname`).

| `state` | Meaning | Suggested copy |
|---|---|---|
| `no_runner` | No runner is known for this user. | "Set up the local runner. Paste this into a terminal:" and `setupInstructions(...).oneLiner`. |
| `runner_offline` | A runner is known but not online. It may have stopped after 15 minutes with no browser, or the machine is off. | "Your runner is offline." On Linux a link to `bridge://run`; otherwise "run `bridge run` in a terminal". |
| `online_not_enrolled` | A runner is online and this browser is not enrolled with it. | "Pair this browser." Send the user to the enroll page, or tell them to run `bridge enroll <app> --open`. |
| `ready` | A runner is online and this browser is enrolled with it. | "Connected." |
| `runner_selection_required` | Several known runners are online at once. `runner` is absent. | "Choose a runner." List `bridge.runners().filter((r) => r.online)` by `hostname`, then follow the pick with `status(runnerId)` and `onStatus(handler, runnerId)`. |

`ready` means this browser holds an enrolled key for the runner (`bridge.isEnrolled(runnerId)`).
If the runner revoked this browser since, the key is still here. Offline runners never
trigger `runner_selection_required`: with none online, the most recently seen one is
reported as `runner_offline`. The client remembers at most 8 known runners per app, so a runner
that stopped before the page loaded still shows as `runner_offline`.

### Show setup instructions

`setupInstructions({ appUrl, appName, platform?, flavor })` returns copy as data:
`{ flavor, oneLiner, steps, troubleshooting, agentPrompt? }`. It is a pure function, so it
also runs on the server. Show its output as text, not as HTML. `appUrl` must be https (http
only on localhost), with no credentials, query or fragment, or it throws. `platform` is
`"linux"` or `"darwin"` and picks the restart wording; leave it out for Linux, which is also
the WSL2 path. An optional `appId` selects the app by its discovery id in the commands; the
default is the app's origin.

- **`cliVersion` and `registry`** (both optional) pin the `npx` commands: with them the one-liner is
  `npx --registry <registry> @berdyh/bridge@<cliVersion> setup <appUrl>`, so a page can name the release it was
  tested with or a private registry. The agent prompt uses the same prefix for the steps before `self install`.
  Every later step and troubleshooting fix uses the bare `bridge`, the launcher setup installs in `~/.local/bin`:
  each npx spelling is its own npx cache entry, so a pinned `npx` there would make npm ask "Ok to proceed?" on
  each command, again after each release. A troubleshooting entry covers a missing launcher (rerun the
  one-liner) and checks it with `bridge --version`, because Linux's iproute2 also ships a `bridge` command.
- **`flavor: "human"`.** `oneLiner` is `npx @berdyh/bridge setup <appUrl>` (as above, pinned when you
  pass the options). `steps` tell a person at a
  terminal what to expect: one path list and one question, the device-code sign-in, bridge's
  adapter and separate sign-in for an agent on `PATH`, the background service, the enroll page
  setup opens and trusts (the words are compared only when it cannot open one), and the 15-minute
  idle stop. `troubleshooting` is a
  list of `{ problem, fix }` for the states above, plus Windows (use WSL2) and a failed setup.
- **`flavor: "agent"`.** Adds `agentPrompt`: a prompt the user pastes into Claude Code or Codex, which
  runs the same `bridge` commands. It tells the agent to run `bridge doctor --json`, then
  `setup <appUrl> --plan --json`, and to show every path list and ask before it passes `--yes` to
  `self install` or `service install`. For pairing the agent runs `bridge enroll <app> --open --json`,
  waits for the `trust_request` event, then **asks the human for the four words shown on the
  page** and runs `bridge enroll approve <app> --words "<w1 w2 w3 w4>"` (a script passes `--words -`
  and the words on stdin, so they stay out of argv). A wrong set of words
  denies the pairing. The kit has no gate of its own here: the human's confirmation is the
  four words they read off the page, plus the agent harness's command approval. Do not
  edit the prompt to let the agent read the words from the terminal. A script that drives the
  browser itself should know the runner's idle stop: it exits after 15 minutes with no browser, no
  plugin session and no enroll activity, counted from its start (an open `bridge enroll` window is
  activity); see [Operate the runner](operate-the-runner.md#start-notifications-idle-stop-and-restart).

### Ready-made elements

`defineElements()` (from `@berdyh/bridge-client`) registers two custom elements with shadow DOM.
It does nothing outside a browser. Both are optional; the functions above are enough to build your own.

- **`<bridge-setup app-url="https://..." app-name="My app" platform="linux">`.** Renders the status and
  the matching setup: the one-liner with a copy button, a "Start runner" link on Linux when the
  runner is offline, a collapsed "Set up with a coding agent" prompt, a runner picker for
  `runner_selection_required`, and, when the page was opened from an enroll link, the pair
  button and the four words. Give it a client with
  `element.client = { status, onStatus, runners, onRunners, enroll, consumeEnrollLink }`: the
  `BridgeClient` methods, plus your `consumeEnrollLink`. Set `element.instructions` to replace the copy generator.
  Style it through its `part` names (`panel`, `status`, `one-liner`, `copy`, `pair`, `words`, `error`).
- **`<bridge-permission>`.** Shows permission requests one at a time. Pass `element.mount` to
  `permissionPrompt` (next section).

### Ask for permission

The agent asks before it runs a tool; the request reaches your page as the ACP
`session/request_permission`. `permissionPrompt(options)` returns the handler for it, so you do not
write the allow and deny logic:

```ts
import { permissionPrompt } from "@berdyh/bridge-client";

const app = client({ name: "my-app" })
  .onRequest("session/request_permission", permissionPrompt({ mount: permissionEl.mount }));
```

`options.mount(view, answer)` renders `view` and returns an unmount function. Call
`answer(optionId)` when the user chooses, or `answer(null)` to dismiss. `view` has `sessionId`,
`title`, `toolKind`, `locations`, `rawInput` and `options`. Only the `allow_once` and `reject_once`
options reach the browser, and a choice that is not among them is treated as a denial. Everything
else denies: no `mount`, `answer(null)`, a throwing `mount`, a cancelled session, and `timeoutMs`
(default: none) elapsing. A denial selects `reject_once`, or `cancelled` if the runner offered none. Show
`title`, `locations` and `rawInput` as text: they come from the agent.

### What stays app-specific

- Sign-in: `getSessionToken`, and keeping the enroll link through your own sign-in redirect (the page
  makes the redirect; see the rules above).
- The route and branding of the enroll page, and where the status pill and permission prompt sit.
- The working directory your app passes to `session/new`. Send `"."` for the app's own work folder, or an
  absolute folder the runner's policy allows (see `cwd` in section 4 and
  [Operate the runner](operate-the-runner.md#the-per-app-work-folder)).
- Your server stack, database and Clerk application (sections 1 to 3).

## 6. Check it works

Connect a runner to your deployed server with `bridge connect https://your-app.example`
(see [Operate the runner](operate-the-runner.md)), enroll, and send a prompt. For a
pre-deploy check, `pnpm e2e` and `pnpm e2e:cf` run this path locally.
