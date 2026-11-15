# bridge

A pluggable kit that connects a hosted web app to the coding agents on its user's own
machine. The app's page drives a local agent (claude, codex, any ACP agent) through an
end-to-end encrypted relay. The relay and the app's server never see the content.

It is a library, not a shared service. Every app deploys its own bridge server with its
own database and its own Clerk application. The one shared piece is the local `bridge`
runner: one install per machine, with a separate credential, connection, trust list and
plugin set per app, each kept in that app's own folders.

Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## The four plug points

| Plug point | What plugs in | Where to start |
|---|---|---|
| Client apps | A hosted page that drives agents with `@berdyh/bridge-client` | [Add the bridge to an app](docs/guides/add-to-an-app.md) |
| Local app plugins | Code an app ships to run on the user's machine | [Write a plugin](docs/guides/write-a-plugin.md) |
| Agent backends | An adapter that speaks ACP to the runner | [Write an adapter](docs/guides/write-an-adapter.md) |
| Server adapters | Runtime, store and auth under each app's server | [Write an adapter](docs/guides/write-an-adapter.md) |

To install and run the runner on a machine, see the quick start below and
[Operate the runner](docs/guides/operate-the-runner.md).

## Quick start: set up a machine for an app

Requires Node 22 or newer on Linux or macOS (on Windows, use WSL2). One command installs
the runner, connects it to the app and pairs your browser:

```sh
npx @berdyh/bridge setup https://app.example
```

The app URL must be `https`, or `http` on localhost. The other route is the install
script, [scripts/install.sh](scripts/install.sh): it installs this release, then runs
`bridge setup` with the arguments you give it
(`BRIDGE_INSTALL_BASE=<release base URL> sh install.sh https://app.example`; the base holds
`<version>/SHA256SUMS` and the package tarballs).

Setup lists the paths it will write and asks before it writes anything. Then it:

1. Installs the runner into `~/.local/share/bridge/versions/<version>/` with two launcher
   links, `~/.local/bin/bridge` and `~/.local/bin/bridge-runner` (the same program; on Linux
   iproute2 ships its own `/usr/bin/bridge`, and setup warns when that one comes first on `PATH`).
2. Connects the machine to the app. You approve a device code on the app's own sign-in page.
3. Offers a login for your coding agent, kept in bridge's own folder
   (`~/.config/bridge/agents/`). Bridge never writes `~/.claude` or `~/.codex`; offering a copy reads your existing login file
   (read only) to check there is one, and copying it needs your yes. The claude and codex adapters
   (about 300 MB and 450 MB) are not installed with bridge: `bridge agent install claude` and
   `bridge agent install codex` install them on request.
   It offers to copy your current login first (the default), then a separate sign-in. A copy
   shares one grant with your terminal agent, so a token refresh on one side may sign the
   other out; the separate sign-in avoids that.
4. Asks once for the background service and the `bridge://` link handler (Linux). One
   consent covers both. Choose no to run `bridge run` in a terminal instead.
5. Opens the app's enroll page. Compare the four words it shows with the terminal's and
   approve. An agent doing the setup for you asks you for those four words and runs
   `bridge enroll approve <app> --words "..."` (scripts: `--words -` with the words on stdin).

Afterwards, `bridge status` shows the runner and each app's link. `bridge uninstall`
removes what bridge installed. It leaves shared folders and `mimeapps.list` alone (it strips only bridge's lines). Nothing is migrated from an older layout:
run the old version's `bridge uninstall`, then `bridge setup <url>`. Details:
[Operate the runner](docs/guides/operate-the-runner.md).

## Architecture

```
 browser (client app)                    app's bridge server (per app)              user's machine
 ┌──────────────────────┐   WSS    ┌───────────────────────────────┐   WSS   ┌────────────────────────┐
 │ @berdyh/bridge-client│◄────────►│ relay: DO per user (blind)    │◄───────►│ bridge runner          │
 │  ACP client          │ E2EE     │ pairing API (device grant)    │ E2EE    │  ACP proxy             │
 │  SPAKE2 enrollment   │ frames   │ device records, revocation    │ frames  │  ├─ agent adapters     │──stdio──► claude / codex / ACP agent
 └──────────────────────┘          │ adapters: runtime, store, auth│         │  └─ plugin host        │──stdio──► app plugins (subprocess)
                                   └───────────────────────────────┘         └────────────────────────┘
                                                                              one connection per app server
```

- The browser is an ACP client, the runner is an ACP proxy, and the agent is an ACP
  agent. Plugins add `_`-prefixed ACP methods. There is no side protocol.
- The runner dials out to each app server (`bridge connect`). Nothing listens on the
  user's machine for the hosted page, except a plugin's optional loopback UI.
- The server kit's core exposes an `HttpHost` (a fetch handler) and the interfaces
  `RelayGateway`/`RelayTransport`, `DeviceStore` and `AuthVerifier`, which adapters in
  separate packages implement: Node (`ws`, in-memory store, stub auth), Cloudflare
  (Durable Object relay, Workers host), Neon and D1 stores, Clerk auth.

## Packages

| Package | Role |
|---|---|
| `@berdyh/bridge-protocol` | Shared types and validators: discovery document, relay envelope, frames, plugin manifest |
| `@berdyh/bridge-crypto` | SPAKE2 enrollment, X25519/HKDF session keys, AES-GCM frame codec |
| `@berdyh/bridge-pairing` | OAuth device grant client and token store used by the runner |
| `@berdyh/bridge-runner` | Runner core: ACP proxy, agent adapters, plugin host, E2EE, service install |
| `@berdyh/bridge` | The `bridge` CLI |
| `@berdyh/bridge-client` | Browser and headless client SDK |
| `@berdyh/bridge-plugin-sdk` | What a local plugin implements |
| `@berdyh/bridge-server` | Runtime-independent server core |
| `@berdyh/bridge-server-node`, `-cf`, `-neon`, `-d1`, `-clerk` | Server adapters |

## Development: run the end-to-end harness

Requires Node 22 or newer and pnpm. From the repository root:

```sh
pnpm install && pnpm build
pnpm e2e        # runner + Node relay + stub OAuth + headless client, with a stub agent
pnpm e2e:cf     # the same path against `wrangler dev` (starts `wrangler dev`, so it is slower than `pnpm e2e`)
```

`pnpm e2e` covers pairing, SPAKE2 enrollment, an encrypted ACP prompt, a plugin call
with its local UI, cross-app isolation, and a check that the relay never sees
plaintext. To drive your own real `claude`, see [Verify the whole thing](docs/guides/operate-the-runner.md#verify-the-whole-thing).
Unit tests run with `pnpm test`, types with `pnpm typecheck`.

## Privacy and paths

What the runner writes, and where. `bridge doctor --paths` prints the full list for your machine.

- **Its own folders.** `~/.local/share/bridge` (the installed runner, and the claude or codex adapter if you
  ran `bridge agent install claude` or `codex`), `~/.config/bridge` (machine settings, `policy.json`, the agent
  logins), `~/.local/state/bridge` (status, log, the one-runner lock), and for each app the three
  `bridge/` folders `~/.config/<app>/bridge`, `~/.local/share/<app>/bridge` and
  `~/.local/state/<app>/bridge` (trust list, identity, plugins, the work folder, audit logs). The
  base folders follow `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME`. Outside these it
  writes the launcher links in `~/.local/bin`, the systemd or launchd service file and, on Linux, the
  `bridge://` handler entry and its lines in `mimeapps.list`, each only after listing the path and
  asking.
- **Credentials.** The sign-in tokens and the key that wraps each app's identity go to the OS keychain
  (service `berdyh-bridge`), or to plain files in a folder you name with
  `BRIDGE_CREDENTIAL_STORE=file:<absolute dir>` on a machine with no keychain. `HOME` and the XDG
  variables do not isolate the keychain. See
  [Operate the runner](docs/guides/operate-the-runner.md#where-the-runner-keeps-its-credentials).
- **Token write-back.** Bridge keeps its own copy of each agent's login in `~/.config/bridge/agents/`
  (claude: `claude/.credentials.json`, codex: `codex/auth.json`; plain files, mode 0600). A session
  runs on a throwaway copy of it, and when the agent refreshed its token inside the session the
  runner **writes the refreshed token back to those two files**. There is no switch to turn that off.
  Bridge never writes `~/.claude`, `~/.codex`, `$CLAUDE_CONFIG_DIR` or `$CODEX_HOME`. It reads your own
  login file (read only) only when `bridge agent login` offers to copy it, or you pass `--copy`:
  first to check there is a login to copy, again after your yes. The runner never reads it while serving
  sessions. `bridge doctor` lists the two paths. Details:
  [Operate the runner](docs/guides/operate-the-runner.md#token-write-back).
- **The network.** The runner dials out to each app's server only. At `bridge doctor` and when
  `bridge run` starts it also asks the npm registry for the newest `@berdyh/bridge` version (one small
  request, 3 seconds at most, never installs; off with `BRIDGE_UPDATE_CHECK=0`).

## Security model, in short

- **The relay is blind.** It forwards end-to-end encrypted frames (AES-256-GCM) and
  reads only the routing header. A compromised relay or app server sees ciphertext and
  connection metadata. It cannot enroll a browser, because the runner holds the trust list.
- **Enrollment needs the machine.** `bridge enroll` shows an 8-character code locally,
  or puts it in the link it opens. The browser proves it knows the code with SPAKE2
  through the relay. The code lasts 10 minutes, is single-use and allows 5 attempts.
  Before trusting the browser, the runner asks to confirm its label and key. The browser
  page shows four words for that key; the person confirms they match
  (`bridge enroll approve <app> --words "..."` when an agent runs the command; scripts pass
  `--words -` and the words on stdin, which keeps them out of argv).
- **Per-app isolation.** Each app has its own credential, connection, trust list and
  plugin set. A browser enrolled for one app cannot reach another app's sessions or plugins.
- **Local policy only.** Permission mode, allowed agents, allowed working directories
  and pre-approved tools come from the runner's own `policy.json`. A browser cannot
  change them. With no `allowedCwds`, sessions start in the app's own work folder (a page's missing or
  relative `cwd` becomes that folder, silently). An
  app's own `config.json` can only narrow the machine policy.
- **Plugins** run as separate processes with a stripped environment and their own
  HOME and data dir. Declared network hosts and extra filesystem paths are shown to the
  user but are **not yet enforced**.
- **Revocation** works per browser on the runner (`bridge browsers revoke`) and per
  device on the app server (the device API closes the runner's socket).

Known limits and the threat table are in the
[security model](docs/ARCHITECTURE.md#14-security-model). Plaintext mode exists only for local
development (`bridge run --no-e2ee`); never deploy it anywhere reachable.

## Issues and security

Report bugs and kit requests as [GitHub issues](https://github.com/berdyh/bridge/issues), with the templates. Report
a vulnerability privately, never as an issue: see [SECURITY.md](SECURITY.md). Contributions: see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0: see [LICENSE](LICENSE). Copyright 2026 Shokhrukh Berdikobilov (Shoh Berdy); redistributions keep the
attribution in [NOTICE](NOTICE).
