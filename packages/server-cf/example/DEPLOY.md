# Local example and real deployment prerequisites

This example runs the Cloudflare relay Durable Object and the D1 device store
locally. From the repository root, with dependencies already provisioned:

```sh
pnpm e2e:cf
node e2e-cf/run.mjs typecheck
```

The direct typecheck launcher uses installed tools without invoking pnpm or
installing dependencies. It generates protocol/server declarations inside a
temporary `e2e-cf/.runtime/` directory using browser/Node types, then checks the
example against Worker types and those declarations. It removes the temporary
directory afterward and writes no dependency builds into other packages.

The harness invokes the installed Wrangler directly with `dev --local`, applies
the real D1 migrations to a new local database, and binds to `127.0.0.1` on a free
port. It needs no Cloudflare login, API token, Internet access or external database.
All generated files, fake credentials, identities, trust lists, plugin data and
Wrangler's HOME/config/cache/logs live in `e2e-cf/.runtime/`. Each run uses a fresh
directory and shuts down its children and removes that directory on completion.
The fake credential store is injected; the real OS keychain is never used.

`BRIDGE_TEST_AUTH=1` enables deliberately fake tokens (`test-runner` and
`test-browser`), auto-approved device authorization, and test diagnostics. It also
requires an HTTP loopback `APP_ORIGIN`. The checked-in configuration leaves this
binding absent; without it credentials are refused and all OAuth/test endpoints
return 404. This is a test fixture, not a production authentication configuration.

The suite runs the real CLI parser/commands in a child process with injected host
dependencies and a private file-backed fake keychain. `connect`, `plugin add`,
`run`, `enroll` and `browsers revoke` execute across process boundaries. It
exercises SPAKE2 enrollment and the encrypted ACP session using the real runner,
headless client, adapter and a stub ACP agent subprocess. The real sample
plugin is bundled into a self-contained temporary package and installed with
consent; `_sample/echo` traverses the encrypted channel and plugin subprocess.
The client receives the local UI handoff and loads the plugin's loopback page.
Both directions of the relay traffic are captured at the socket boundary and
checked for encrypted envelopes and absence of the prompt and method plaintext.

Idle sockets must survive the server's 60-second idle deadline with the SDKs'
20-second `bridge:ping` heartbeats. A silent socket must close, and suppressing
only pong delivery must make the browser abandon its socket and reconnect.
The adapter currently hard-codes 20/10-second client heartbeat, 60-second server
idle and 30-second sweep intervals; there is no supported short-interval config.
The suite leaves these modules unchanged and tests real wall-clock deadlines, so it takes about two minutes rather than simulating accelerated timers.

The example adds test-only constructor IDs and records the first WebSocket event
after construction. After idle, the first encrypted plugin request must route. If
the constructor ID changed, the test checks that this frame was the first event
after wake. If this local workerd/Miniflare does not evict the object, the test
prints an explicit `Hibernation: GAP` message: idle routing is proven, actual
eviction/wake is not. The attachment-restoration unit tests cover reconstruction;
they are not evidence of a local or production hibernation event. A staging run
must verify hibernation independently. No restart that drops sockets is counted
as successful hibernation.

## What a real deployment needs

No deployment is performed by this harness.

1. Create this app's Cloudflare account resources: Worker, its own relay DO
   namespace, SQLite DO migration, HTTPS domain, and a device database. Use
   `../templates/worker.ts` and `../wrangler.toml.example` as the production
   starting point, replacing the example app identifiers and origins. Remove the
   test binding, test OAuth routes and diagnostics. Supply a real verifier.
2. Create a separate Clerk application for this app. Configure its issuer, public
   OAuth client ID, authorized parties (this app's HTTPS origin only), and device
   grant, or choose app-hosted enrollment (`createRunnerEnrollmentApp` with `0003_enrollment.sql` on D1, see
   [Pairing and enrollment](../../../docs/ARCHITECTURE.md#5-pairing-and-enrollment)) or an API key minted
   from a code page of your own. Store the
   Clerk secret as a Worker secret. Test origin/azp rejection, device enrollment,
   token refresh and revocation. Decide and implement whole-grant revocation if
   required; the production template's OAuth setting permits device-id-only
   revocation and does not revoke the refresh grant automatically.
3. For Neon, create an app-specific project/branch, apply
   `packages/server-neon/migrations/0001_devices.sql` (and `0002_credential_fingerprint.sql`, which lets a runner revoked
   while offline for long still get the revoked verdict; the store works without it), configure `DATABASE_URL` as
   a Worker secret, and use `createNeonDeviceStore`. **Neon is unit-tested only
   against a mocked `neon()`; no Postgres or live Neon branch runs in this suite.**
   Before a real deploy, check a live isolated Neon branch: migration, registration
   and reconnect, per-user list/get, last-seen throttling, device/credential
   tombstones and revoked-credential reuse. Remove the disposable test branch
   after verification. D1 is the actual local database tested here, not a
   substitute for this live Neon check.
4. Clerk verification is likewise tested only against fakes in this repository;
   no real Clerk account or provider tokens are exercised here. Validate actual
   Clerk tokens/device grants on staging with the app's own credentials.
5. Run this suite and the repository checks, then validate real WSS, idle
   hibernation and first-frame routing, reconnect/replay after deployment,
   browser/device revocation, and two separately deployed apps' isolation on
   staging. Also walk through a real ACP agent by hand; the local stub agent does not prove that.

Keep each app's Worker, DO namespace, database, Clerk application and secrets
separate. The bridge kit is a library; it provides no shared hosted relay.
