# @berdyh/bridge-server-neon

A `DeviceStore` for the bridge server kit on Neon Postgres, for apps whose server keeps its data in Neon. The store holds the app's device records (one per connected runner) and the credential ids bound to them, and the server core uses it for device listing, revocation and last-seen. Each app uses its own Neon database.

Apply `migrations/0001_devices.sql` to the app's own Neon database before creating
`createNeonDeviceStore({ connectionString })`. The adapter uses Neon's HTTP driver,
not a long-lived Postgres connection. No credentials are stored here: only stable
credential identifiers supplied by the verifier and, with migration 0002, the SHA-256 of the token.

Also apply `migrations/0002_credential_fingerprint.sql` (a nullable `fingerprint` column and its index) to let a runner that
was revoked while it was offline for a long time still be told so: the store keeps the SHA-256 of the token that last
authenticated each credential (never the token) and finds it when the identity provider no longer knows the key. It is
optional: the store checks for the column, and without it binds credentials without a fingerprint and finds nothing by fingerprint
(that runner gets a 401), so an app may update the kit first and migrate later. Credentials bound before the
migration have no fingerprint and keep the 401. The store has no logger and is silent about a missing column.

Registration and revocation use HTTP transactions with a transaction-scoped
Postgres advisory lock keyed by user id. This serializes credential reuse across
devices with revocation; all writes must go through this adapter. Unknown or
revoked credentials cannot register a fresh device. Tombstoned records and their
credential sets must be retained for revocation to remain effective. Existing
records keep createdAt and lastSeen on reconnect; only device metadata changes.

lastSeen uses one parameterized conditional UPDATE with a canonical UTC cutoff,
so competing connections cannot bypass the five-minute throttle. The portable
schema is byte-identical to the D1 migration. Both store timestamps as ISO UTC text.

Unit tests use a mocked Neon HTTP driver to verify transaction order, SQL guards,
row mapping, parameter binding and the single-update throttle. A live Neon
credential/database is not required or used.

## Guides

Deploying a server: [Add the bridge to an app](../../docs/guides/add-to-an-app.md). Writing your own adapter: [Write an adapter](../../docs/guides/write-an-adapter.md).
