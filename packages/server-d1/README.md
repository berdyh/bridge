# @berdyh/bridge-server-d1

A `DeviceStore` for the bridge server kit on Cloudflare D1, for apps whose server runs on Workers and keeps its data in D1. The store holds the app's device records (one per connected runner) and the credential ids bound to them, and the server core uses it for device listing, revocation and last-seen. Each app uses its own D1 binding.

Copy `migrations/0001_devices.sql` to the app's D1 migrations directory and apply it
before calling `createD1DeviceStore(env.DB)`. It is the same portable schema shipped
with the Neon adapter. Use one app-specific D1 binding; no app servers share data.

Also apply `migrations/0002_credential_fingerprint.sql` (a nullable `fingerprint` column and its index). It lets a runner that
was revoked while it was offline for a long time still be told so: the store keeps the SHA-256 of the token that last
authenticated each credential (never the token) and finds it when the identity provider no longer knows the key. It is
optional: the store checks for the column, and without it binds credentials without a fingerprint and finds nothing by fingerprint
(that runner gets a 401), so an app may update the kit first and migrate later. Credentials bound before the
migration have no fingerprint and keep the 401. The store has no logger and is silent about a missing column.

To mount app-hosted runner enrollment (`createRunnerEnrollmentApp` in `@berdyh/bridge-server`), also apply
`migrations/0003_enrollment.sql` and use `createD1EnrollmentStore(env.DB)`. It is not needed otherwise.

D1 batches make device registration, credential binding and revocation atomic.
Tombstones and all credential associations remain durable so a revoked credential
cannot reconnect under a different device id. All reads/writes scope by user id.
The five-minute lastSeen throttle is one conditional UPDATE; reconnect metadata
updates preserve createdAt and lastSeen.

Unit tests execute real SQLite statements through a fake D1 binding. The CF
package's Miniflare integration also runs this adapter against an actual local D1
binding, including credential revocation after DO eviction/hibernation.

## Guides

Deploying a server: [Add the bridge to an app](../../docs/guides/add-to-an-app.md). Writing your own adapter: [Write an adapter](../../docs/guides/write-an-adapter.md).
