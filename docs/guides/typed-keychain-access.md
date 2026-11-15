# Typed keychain access for trusted host adapters

Typed keychain access is supplied by `@berdyh/bridge-runner` (root export). It is an additive
host library facade; the existing credential-store constructors and CLI consent
policy remain available. App core code can keep a Bridge-free port, injected by
its small trusted CLI/plugin or local Node host adapter.

```ts
import {
  createKeychainAccess,
  KeychainOperationError,
  type KeychainAvailability,
} from "@berdyh/bridge-runner";

const keychain = createKeychainAccess({ service: "my-app" });
const availability: KeychainAvailability = await keychain.inspect();
// keychain.store implements CredentialStore: get, set, delete.
```

`createKeychainAccess(options): KeychainAccess` takes `service`, optional `label`,
`platform`, `inspectionTimeoutMs`, `operationTimeoutMs`, and trusted injectable
`run` and `findExecutable` collaborators. Neither collaborator is agent input.
Defaults are the real OS platform, Bridge-owned PATH/executable observation and
bounded process execution. It has no CLI dependency or import from an app.

Both deadlines default to **5000 ms**, configurable as integers **1–30000 ms**.
They bound the whole public call, including dependency discovery. Transport
commands receive the deadline and cancellation signal; the owned runner kills a
timed-out child and bounds combined stdout/stderr to 1 MiB. Injected runners must
honor their timeout/cancellation contract. A returned timeout never proves the
service rolled back an already submitted operation. Inspection has one total
deadline across all metadata calls, not one deadline per stage.

## Availability

| Status | Stable reasons | Meaning |
|---|---|---|
| `available` | `ready` | Existing default collection observed unlocked; this is advisory metadata, not proof that a particular item can be read or written. |
| `absent` | `unsupported_platform`, `executable_missing`, `service_missing` | This facade has no backend on that platform, a required store executable is confirmed missing, or the connected bus has neither a service owner nor activation registration. |
| `locked` | `collection_locked` | Existing default collection reports `Locked=true`. No unlock is requested. |
| `unknown` | `observer_unavailable`, `inspection_unsupported`, `service_not_running`, `no_default_collection`, `timeout`, `access_denied`, `invalid_response`, `command_failed`, `mutation_outcome_unknown` | No safe absence/fallback conclusion is available. |

Linux uses executable metadata plus `busctl --user --json=short --auto-start=no`.
It reads bus names/activation registration, pins the existing Secret Service
owner, reads the default collection alias and its Locked flag. It never calls
OpenSession, SearchItems, GetSecret, Unlock, a store/delete command, or service
activation. It reads no real item or secret, returns no raw stderr, and performs
no writes, installs, credential-directory creation or chmod. An inactive but
activatable service is unknown, not absent. Relative/empty PATH entries follow
normal executable search semantics.

Linux requires `secret-tool` for store operations and `busctl` for observation.
Missing `busctl` is unknown because lack of an observer does not prove lack of a
keychain. macOS store operations use `security`; lock observation currently
returns `unknown/inspection_unsupported` when that executable exists. Other
platforms refuse operations and report `absent/unsupported_platform`.

macOS limits, measured natively on macOS 26.5.1:

- A write is one `security -i` line, and `security` reads lines through a
  4096-byte buffer. A longer line would store a truncated head and run the rest
  as a separate command, so a write whose line (`add-generic-password -U -a
  "<key>" -s "<service>" -w "<value>"`, after quoting) exceeds 4095 bytes is
  refused before dispatch: `invalid_input`, `not_started`, no mutation latch.
  With a short key and service that leaves about 3.9 KB of value.
- Reads use `find-generic-password -g` and decode its `password:` line, so
  non-ASCII, tab and backslash values (printed as hex) round-trip exactly. A
  value that is not UTF-8 text, or an unrecognized line, fails as
  `command_failed` rather than returning something else.
- A locked keychain makes `security` wait for an unlock prompt: a call ends at
  its deadline as `timeout` (a read is `mayHaveMutated: false`), not `locked`.

Rerun these checks against a scratch keychain only. They were measured on one macOS
machine with the native `security` tool, not against a live provider or an application.

## Store outcomes and migration

`KeychainOperationError` exposes only `operation`, a stable `code`,
`outcome: "not_started" | "unknown"`, and `mayHaveMutated`. It retains no raw
platform stderr, secret, account key, or underlying error cause. Codes are
`unsupported_platform`, `executable_missing`, `timeout`, `access_denied`, `locked`,
`command_failed`, `output_limit`, `invalid_input`, and `mutation_uncertain`.

Known pre-dispatch failures have `outcome: "not_started"` and
`mayHaveMutated: false`. A failed/timed-out set or delete after dispatch is
conservative: `outcome: "unknown"`, `mayHaveMutated: true`. Nonzero outcomes are
validated before legacy permissive behavior; only exact documented not-found
read statuses and macOS not-found deletion are accepted. Output never enters
public error text. Secrets reach store commands over stdin, never argv.

A possible failed mutation permanently latches this facade's inspection to
`unknown/mutation_outcome_unknown` and refuses later mutations with
`mutation_uncertain`. Late command success or a later missing executable does
not turn it into an absence signal. Reads remain possible for reconciliation.
After caller-owned reconciliation, deliberately construct a new facade for a
new attempt; recreating one is not itself recovery or evidence of rollback.
Never retry a possibly still-running injected mutation automatically.

The app owns serialization, token JSON, migrations and rollback policy. Preserve
the old file on any failure. Write the new keychain token, read it back and verify
it before deleting the old file. Only `status: "absent"` can enter the app's
explicitly approved file-fallback policy; locked/unknown/timeout/denial cannot.
Availability never overrides an operation's ambiguous outcome. Bridge neither
selects a fallback nor migrates or deletes application credentials for this API.

## Tests

`keychain-access.test.ts`, `keychain-command.test.ts` and the existing
`keychain.test.ts` use synthetic collaborators/Node children. The integration
fixture starts private buses with no activation directories, verifies actual
missing-service JSON and a fake metadata-only provider's locked/unlocked boolean
properties, and never contacts the host keyring. The two fake-provider cases
use optional system Python dbus/PyGObject bindings and skip if unavailable; these
are test-only dependencies. The fake provider has no credential, item, session or unlock operations. Tests cover late preflight/command completion,
ambiguous mutations, stderr/exception sanitization, and locked/absent/unknown
refusals.

Depend on a published `@berdyh/bridge-runner` version.
