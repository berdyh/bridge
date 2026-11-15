# bridge

A pluggable kit for "hosted app ↔ user's local coding agent": runner, server kit, client and plugin SDKs.

`CLAUDE.md` is a symlink to this file. Edit this one only.

## Layout

| Path | Package | What it is |
|---|---|---|
| `packages/cli` | `@berdyh/bridge` | the `bridge` command line and the runner it installs |
| `packages/runner` | `@berdyh/bridge-runner` | the local runner: agent adapters, contained sessions, plugins, keychain |
| `packages/client` | `@berdyh/bridge-client` | browser and headless client SDK |
| `packages/plugin-sdk` | `@berdyh/bridge-plugin-sdk` | the API a local plugin implements |
| `packages/protocol` | `@berdyh/bridge-protocol` | wire messages and their validation |
| `packages/crypto` | `@berdyh/bridge-crypto` | SPAKE2, X25519/HKDF and the AES-GCM frame codec |
| `packages/pairing` | `@berdyh/bridge-pairing` | device pairing |
| `packages/server` | `@berdyh/bridge-server` | runtime-independent server core |
| `packages/server-cf`, `server-node` | `@berdyh/bridge-server-cf`, `-node` | Cloudflare Workers and Node adapters |
| `packages/server-clerk` | `@berdyh/bridge-server-clerk` | Clerk auth verifier |
| `packages/server-d1`, `server-neon` | `@berdyh/bridge-server-d1`, `-neon` | device stores |
| `examples/sample-plugin` | | a sample local plugin |
| `e2e`, `e2e-cf` | | end-to-end suites (Node relay; Cloudflare Workers through Miniflare) |

The architecture is in `docs/ARCHITECTURE.md`; how to use each part is in `docs/guides/`.

## Rules

- Apps depend on this repo; this repo never depends on an app or imports app code.
- Nothing here may couple two apps' servers at runtime. Each app deploys its own bridge server (relay, pairing API,
  device store) with its own auth and credentials. The kit is a library, not a shared service.
- The one shared piece is the local `bridge` runner: one install per machine, with a separate credential,
  connection, browser trust list and plugin set per app server. Code that lets one app's connection reach another's
  is a bug.
- Runner CLI, server kit, client SDK and plugin SDK live here as separate packages of one monorepo.
- `docs/ARCHITECTURE.md` describes the current architecture: change it in the same change as the code it describes.
- Tests use synthetic credentials only and never read a real agent login or keychain entry.

## Reporting problems with the kit

This section is also for agents working in an app, plugin or adapter that uses the kit.

**When to file.** The kit behaves differently from its docs, a command or API fails, a guide is wrong, or an app
needs a capability the kit lacks and cannot build on top of it. A problem in the app's own code is not a kit issue.

**How.** File a GitHub issue in `berdyh/bridge`, one problem per issue:

```
gh issue list -R berdyh/bridge --state all --search "<words from the error>"   # search first; comment on a match
gh issue create -R berdyh/bridge --template "Bug report"    # or --template "Kit request"
```

Fill in every section of the template. Then record the issue URL where the app tracks its own work, and work around
the problem in the app or wait for the fix.

**Never:**

- write the report into a file, in the bridge checkout, the app's repository or anywhere else on the machine;
- patch the kit's code inside the app (a vendored or installed copy) to get past it;
- put secrets, enrollment words, keychain contents, real app URLs, user names, private paths or the app's internal
  plans into an issue: describe the kit's behaviour with `https://app.example` and `/home/me`;
- file a security problem as an issue: report it privately as `SECURITY.md` says.

## Checks

Run from the repository root with pnpm (version pinned in `package.json`):

```
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm -r --workspace-concurrency=1 --filter '!@berdyh/bridge-e2e' test
pnpm run e2e
pnpm run e2e:cf
node --test scripts/install.test.mjs scripts/release-set.test.mjs && bash scripts/pack-check.sh
```

Scratch and test state: unit tests create their temporary folders with `os.tmpdir()`, which follows `TMPDIR`. The
end-to-end suites (`e2e`, `e2e-cf`) keep theirs under `TMPDIR` too, and fall back to a folder in the user's cache
directory when `TMPDIR` is unset or points at `/tmp` or `/var/tmp`. `scripts/pack-check.sh` sets `TMPDIR` to
`.ci-local/tmp` in the checkout, and the tests in `scripts/` create their scratch folders there (`.ci-local/` is
git-ignored). Outside those scripts, set `TMPDIR` to a writable folder before running the checks.
