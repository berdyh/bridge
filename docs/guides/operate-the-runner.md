# Operate the runner

The `bridge` runner is one install per machine. It holds a separate credential,
connection, trusted-browser list and plugin set for each app it is connected to, each in
that app's own folders. It dials out to each app's server; nothing needs to accept
connections on your machine.

## Quick start

You need Node 22 or newer on Linux or macOS. One command installs the runner, connects it
to an app and pairs your browser:

```sh
npx @berdyh/bridge setup https://app.example
```

The app URL must be `https`, or `http` on localhost. Without `npx`, run the install script
(`scripts/install.sh`) and pass the app URL after it (the script adds `setup`): `sh install.sh https://app.example`.
The script downloads the checksummed release into `~/.local/share/bridge/versions/<version>/`,
links `~/.local/bin/bridge` and `~/.local/bin/bridge-runner` to it, then runs `bridge setup` with your arguments.

`bridge setup` lists the paths it will write and asks before it writes. Then, in order:

1. **Install.** `bridge self install`: the runner goes into `~/.local/share/bridge/versions/<version>/`
   and two launcher links, `~/.local/bin/bridge` and `~/.local/bin/bridge-runner`, point at it. It
   warns when another `bridge` comes first on `PATH` (see [The `bridge` name on PATH](#the-bridge-name-on-path)).
2. **Connect.** It reads the app's `/.well-known/bridge.json`, shows the app name, origin and
   sign-in issuer, and asks. You approve a device code on the app's own sign-in page.
3. **Agent login.** For each agent whose adapter is installed and that has no login in bridge's
   folder, it asks (see [Agent logins](#agent-logins)). The adapters are not installed with
   bridge: for an agent with none, setup names the exact command and its size
   (`bridge agent install claude`, about 300 MB; `bridge agent install codex`, about 450 MB) and asks
   no login until it is installed (see [Prerequisites](#prerequisites)).
   Without a terminal it only says what is missing.
4. **Background service and `bridge://` handler.** One question covers both. See
   [Background service](#background-service-and-the-bridge-handler).
5. **Enroll your browser.** It starts the runner, opens the app's enroll page with the code in
   the link, and shows four words. The page shows the same four words. Same words: confirm.

If setup cannot open a browser (in WSL2, for instance) it prints the link; open it yourself.
`bridge setup <url> --plan` prints each step and its paths and writes nothing.

Setup options:

| Option | Effect |
|---|---|
| `--service` | Run the runner as a background service. The path list and question still appear unless `--yes` |
| `--foreground` | Keep the runner in this terminal. Neither the service nor the handler is asked about or installed. Ignored while the background service is installed: run `bridge service uninstall`, then setup again |
| `--no-install` | Skip the install step; use the launcher that is already there |
| `--no-open` | Print the sign-in and enroll links instead of opening them |
| `--yes` | Answer the install, connect and service-and-handler questions. It never answers the four words or the agent-login choice |
| `--json` | One JSON event per line on stdout, text on stderr |
| `--plan` | Show the steps and paths, write nothing |

Without a terminal and without `--yes`, setup stops before its first write. Re-running it is
safe: an app that is already connected is not connected again.

### When an agent does the setup

An agent can run `bridge setup <app-url> --yes` (add `--json` for one event per line; `--json` alone has no terminal to ask on, so setup stops with `consent_required`). Setup prints the four words
and waits. The agent must ask the person for the four words their browser page shows, then run:

```sh
printf '%s\n' "$WORDS" | bridge enroll approve <app> --words -
```

or `bridge enroll deny <app>`. `--words -` reads the words from stdin; a script or agent uses it
because argv is visible to other local users and to audit logs. The words are the human's confirmation. The kit has no gate of
its own beyond that and the harness's command approval, so the agent never guesses or reuses
words. `--yes` does not answer this step.

## Prerequisites

1. **Node 22 or newer.**
2. **An ACP adapter for each agent you want to use.** The runner starts agents only through
   ACP adapters. It has no direct one-shot exec path.
   - claude: bridge does not install the `claude-agent-acp` adapter with itself (it pulls in the
     Claude Agent SDK and the claude binary, about 300 MB). Install it on request:

     ```sh
     bridge agent install claude          # lists the paths and asks first
     bridge agent install claude --yes    # without a terminal, `--yes` is required
     ```

     It runs `npm install` of `@agentclientprotocol/claude-agent-acp` at the one version this
     release pins, from the registry npm is configured with, into
     `~/.local/share/bridge/adapters/claude/<version>/` (under `XDG_DATA_HOME`), checks the result
     and moves it into place; a failure leaves nothing there. Until then `bridge doctor` says
     `no adapter installed; run `bridge agent install claude``, `bridge run` warns at start, and a
     claude session is refused (`ACP adapter not installed`). A copy installed while the runner
     runs serves the next session with no restart. The lookup order is `BRIDGE_CLAUDE_ADAPTER`
     (an absolute path, or a name on `PATH`), bridge's own installed copy, then `claude-agent-acp`
     and the older `claude-code-acp` on `PATH`. Only bridge's own copy runs contained plugin
     sessions: an adapter named by `BRIDGE_CLAUDE_ADAPTER` or found on `PATH` serves ordinary
     sessions, and contained ones are refused with `contained sessions run only the bundled adapter`
     ("bundled" there means bridge's own installed copy).
   - codex: bridge does not install the `codex-acp` adapter with itself either (it pulls in
     `@openai/codex` and its native binary, about 450 MB). Install it the same way:

     ```sh
     bridge agent install codex           # lists the paths and the size, and asks first
     bridge agent install codex --yes     # without a terminal, `--yes` is required
     ```

     It runs `npm install --ignore-scripts` of `@agentclientprotocol/codex-acp` at the one version
     this release pins (2.5.0), from the registry npm is configured with, into
     `~/.local/share/bridge/adapters/codex/<version>/`, through the same staging folder as the
     claude adapter, checks that the lockfile npm wrote names the package at the pinned version and
     integrity, and moves the folder into place; a failure leaves nothing there. (The unscoped
     `codex-acp` package on npm and the deprecated `@zed-industries/codex-acp` are different
     packages; bridge uses neither.) The lookup order is `BRIDGE_CODEX_ADAPTER` (an absolute path,
     or a name on `PATH`), bridge's own installed copy, then `codex-acp` on `PATH`. A copy installed
     while the runner runs serves the next session with no restart. When a codex login is in
     bridge's folder but no adapter resolves, `bridge doctor` says
     `no adapter installed; run `bridge agent install codex``, and `bridge run` warns at start.
     Codex has no contained plugin sessions whatever the adapter: they are refused (-32016).
3. **A login for bridge, in bridge's own folder.** See [Agent logins](#agent-logins).
4. **Check both.** `bridge doctor` lists, per agent, whether an adapter was found and whether
   bridge holds a login:

   ```text
   claude: adapter found (adapter installed by bridge: ...), login present
   codex: no adapter found, no login (run `bridge agent login codex`)
   ```

   With a codex login in bridge's folder and no codex adapter, the codex line reads
   `codex: no adapter installed; run `bridge agent install codex` (about 450 MB from the npm registry into ...), login present`.

   An agent counts as available when its adapter is found and the login file in bridge's folder
   exists.

## Agent logins

Bridge keeps its own agent logins and never writes `~/.claude` or `~/.codex`. When setup or
`bridge agent login` offers to copy your existing login, it first reads that login file (read only)
to check there is one to copy, then asks before copying anything. Bridge's logins live in
`~/.config/bridge/agents/claude/` and `~/.config/bridge/agents/codex/`. Each session
gets a throwaway copy of the one it needs, and a token refresh is written back to bridge's
copy only ([Token write-back](#token-write-back)).

There are two ways to give bridge a login. The default is to copy your current login once:

```sh
bridge agent login claude --copy    # copy your current login into bridge's folder, once
```

The copy reads the agent's own login file: claude's from `$CLAUDE_CONFIG_DIR` when set, else
`~/.claude/.credentials.json`; codex's from `$CODEX_HOME/auth.json` when `CODEX_HOME` is set and not
empty, else `~/.codex/auth.json`. The prompt and the path list name the file actually used
(`from: ... (read only)`), and neither folder is written.

A copy shares one grant with your own login. If either side refreshes and the provider
rotates the token, the other may be signed out, your terminal agent included. The command
prints both paths and this warning before it asks. For that reason `bridge agent logout`
refuses a copied login; `bridge uninstall` deletes the copy without signing anything out.

The alternative is a separate sign-in. It runs the agent's own login with its config folder
set to bridge's, so bridge holds its own grant and your terminal agent is not involved:

```sh
bridge agent login claude --login   # runs `claude auth login` with CLAUDE_CONFIG_DIR set to bridge's folder
bridge agent login codex --login    # runs `codex login` with CODEX_HOME set to bridge's folder
bridge agent status                 # present or absent, per agent
bridge agent logout claude          # signs out the login bridge made (`claude auth logout`, bridge's folder only)
```

`--login` needs a terminal and the agent's own command (`claude`, `codex`) on `PATH`. The
path list is printed first. `bridge agent logout` works only on a login made with `--login`.

`bridge setup` asks about each installed agent that has no login yet, and asks the copy
question first. Both questions default to yes, so Enter copies; answer no to reach the
separate sign-in. (A bare `bridge agent login <agent>` asks the same way; an explicit
`--copy` or `--login` alone defaults to no.) `--yes` never
answers either one: only an explicit `bridge agent login <agent> --copy --yes` or `--login --yes`
consents. Without a terminal, setup skips the step and prints the commands to run later. On
macOS Claude Code keeps its login in the Keychain, so `--copy` finds no file and `--login` may
not leave one in bridge's folder; the command then exits 1 and says so.

### Token write-back

A session starts with a throwaway copy of bridge's login in its sandbox (claude: only the
`claudeAiOauth` block of `.credentials.json`, never the file's other tokens; codex: `auth.json`).
Agents refresh their tokens, and providers rotate the refresh token when they do. So when a session
ends, and its agent refreshed the token, **the runner writes the refreshed token back to bridge's own
login file**, provided that file has not changed since the copy was made:

| Agent | File written back (under `XDG_CONFIG_HOME` when set) |
|---|---|
| claude | `~/.config/bridge/agents/claude/.credentials.json` |
| codex | `~/.config/bridge/agents/codex/auth.json` |

These are plain files (folders 0700, files 0600), whichever credential store is selected:
`BRIDGE_CREDENTIAL_STORE` does not move them. Nothing else is written. `~/.claude`, `~/.codex`,
`$CLAUDE_CONFIG_DIR` and `$CODEX_HOME` are never staged from and never written back to. Bridge reads
your own login file (read only) only when it offers or makes a copy: in `bridge setup`'s login step, in a
bare `bridge agent login <agent>` and in `--copy`. The first read happens before the question, only to
check that there is a login to copy; an accepted copy reads the file a second time after your yes.
The runner never reads it while serving sessions. A login file in bridge's folder that is a
symlink, or sits in a symlinked folder, is refused: neither read nor written.

**When the copy is released, by platform.** One session at a time holds a login (a lease next to
the file); the token is written back and the lease released only once the runner has evidence that
the agent and what it started are gone:

- **Linux.** The agent runs in its own PID namespace; ending it ends every descendant, and a runner
  crash ends them too.
- **macOS.** There is no PID namespace. The agent runs in its own
  process group; after the group is killed, the runner waits until no process carries that group's
  id, then writes back and releases. Known gap: a process the agent starts in a new session (`setsid`)
  leaves the group, is not seen, and could keep a token in memory and refresh it, so a later session
  may find the saved refresh token already used and need a new `bridge agent login`. If the runner
  itself crashes, the agent's group keeps running (nothing ends it); the lease then reports a stale
  owner and stays until you check that the agent is gone and remove the lease folder the message names.
- **Other platforms** refuse a session that would stage a login (`sandbox_unavailable`).

There is no setting that turns the write-back off. Without it a rotated refresh token would be lost
and the next session would start with one the provider has already retired. If bridge's login is a
*copy* of yours, the refresh it saves belongs to the grant you share with your terminal agent (see
above); a separate `--login` avoids that.

`bridge doctor` lists both paths under its `token write-back` heading, each with `login present` or
`no login` (`bridge doctor --json` has them as `tokenWriteBack`). `bridge uninstall` removes them
with the rest of `~/.config/bridge`.

## Background service and the bridge:// handler

By default setup asks once: run the runner as a background service, and (on Linux) register
the `bridge://` handler the page's Start button uses. The answer defaults to yes. One consent
covers both, and the path list is printed first. Answer no to keep the runner in your terminal;
the handler is then not registered either. You can add either later:

```sh
bridge service install      # lists the paths it will write and asks first
bridge service uninstall
bridge protocol install     # Linux: the bridge:// link handler
bridge protocol uninstall
```

`bridge service install --no-activate` writes the files without enabling the service. On Linux
the service is the systemd user unit `bridge-runner.service` in `~/.config/systemd/user/`; on
macOS a launchd agent in `~/Library/LaunchAgents/`. Both run `~/.local/bin/bridge run`, so
that launcher must exist before you install the service. The service captures your `PATH`,
the XDG roots and (when set) `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `BRIDGE_CREDENTIAL_STORE`
at install time, so agents and `node` are found and the service opens the same credential store
you configured (see [Where the runner keeps its credentials](#where-the-runner-keeps-its-credentials)).
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` only make the runner protect the same agent folders;
logins come from bridge's own folder.

A variable changed later reaches a running service in two steps: run `bridge service install`
again, which rewrites the unit or plist with the new environment, then restart the service, because
a running service keeps the environment it started with. On Linux run
`systemctl --user restart bridge-runner.service` (the install only runs `daemon-reload` and
`enable --now`, and `enable --now` does not restart a unit that is already active). On macOS run
`bridge service uninstall` and then `bridge service install`: the install's `launchctl bootstrap`
fails on a job that is already loaded, the install then reports `written, but ...`, and the old job
keeps running. The service manager restarts the runner after a crash, not after a normal exit.

### The `setup.service` setting

To be asked with no default instead (the question shows no `[Y/n]`), set `setup.service` to
`"ask"` in `~/.config/bridge/config.json`:

```json
{ "setup": { "service": "ask" } }
```

The other value is `"default-yes"`, which is the default. An app's own
`~/.config/<app>/bridge/config.json` overrides the machine file. With `"ask"`, `--yes` does not
answer the service question, and a run without a terminal must choose with `--service` or
`--foreground`, or setup stops with `service_choice_required`.

### Start notifications, idle stop and restart

When `bridge run` starts it prints a line to stderr and sends a desktop notification (`notify-send`
on Linux, `osascript` on macOS; a missing tool is ignored). The text names the connected apps
and says it stops after 15 minutes with no browser connected. It also warns, per app, when no
browser is trusted yet.

The runner stops itself after 15 minutes with no browser connected for any app (an open enroll
window counts as activity). A plugin's agent session, contained or headless, counts as activity
while it is open: the runner never idles out under a running plugin session, and the 15
minutes start when the last browser and the last plugin session are gone. A local-only app keeps the
runner up altogether (see [A local-only app](#a-local-only-app)). The idle stop is a normal exit, so
the service manager does not restart it.

The rule exactly (`IDLE_STOP_MS` and the idle timer in `packages/cli/src/run.ts`): the runner exits,
status 0, once **15 minutes in a row** have passed with all of the following true. The clock starts
when the runner starts, not when a browser last left, and starts again when the last browser and the
last plugin session are gone.

- No browser is connected for any app (a browser counts from the moment the relay reports it on the
  link; one that drops has a short grace period before it stops counting).
- No plugin session is open.
- No enroll activity: a window is open (a live `bridge enroll` process with an unexpired, unused
  code, at most 10 minutes), or an app's `bridge/` config folder changed since the last look. The
  runner looks every 30 seconds, and each time it sees activity the 15 minutes start over.
- No local-only app is served (one keeps the runner up with no idle stop at all).

A script that starts the runner and then spends longer than 15 minutes before its browser connects
or its `bridge enroll` is running (installing a browser, waiting for a download) finds the runner
gone: `bridge status` reports `not running`, and the page reports `runner_offline`. To avoid it, start
the runner (or the service) last, right before the browser or `bridge enroll <app>` step, and keep
`bridge enroll` running until the browser finishes; or check `bridge status` (it shows `idle since`)
and run `bridge run` again (see below) when the runner has stopped.

To start it again:

- **Linux, with the handler.** The app page's Start button opens a `bridge://run` link. If the
  service is installed, the handler starts it (`systemctl --user start bridge-runner.service`).
  If there is no service, it opens a terminal running `~/.local/bin/bridge run`. A service that is
  installed but fails to start is reported as an error; no second runner is started in a terminal.
- **macOS.** There is no handler. Paste this in a terminal (setup prints it too):

  ```sh
  ~/.local/bin/bridge run
  ```

- **Anywhere.** Run `bridge run` yourself. On Linux you can also start the service with
  `systemctl --user start bridge-runner.service`. The service's output goes to
  `~/.local/state/bridge/runner.log`.

If a running runner does not serve an app you just connected, setup restarts the service (or,
without one, tells you to stop it and run setup again).

## Windows

Windows is not supported natively. `bridge setup` and `install.sh` stop with a message that
says so. Install WSL2 (https://learn.microsoft.com/windows/wsl/install), then run the quick
start inside it. The runner dials out, so it needs no inbound port.

## Commands

| Command | What it does |
|---|---|
| `bridge setup <app-url> [--service \| --foreground] [--no-install] [--no-open] [--yes] [--json] [--plan]` | Install, connect and pair a browser in one go |
| `bridge connect <app-url> [--yes] [--open] [--json]` | Pair this machine with an app's server, nothing more |
| `bridge run [--no-e2ee]` | Hold a connection to every connected app and serve its browsers |
| `bridge status [--json]` | Show whether the runner is running and each app's link and browsers |
| `bridge enroll [<app>] [--open] [--json]` | Open an enrollment window and show the code for a new browser |
| `bridge enroll approve\|deny <app> --words "<w1 w2 w3 w4>"\|-` | Answer a browser's trust request from another terminal. Scripts pass `--words -` and the words on stdin |
| `bridge browsers list\|revoke [<app>] [<browser-key-id>]` | List or revoke trusted browsers |
| `bridge apps list [--json]\|add-local <app-id> [--name <name>] [--yes]\|remove <app> [--yes]` | List apps, create a local-only app (no hosted server) or remove an app |
| `bridge agent login <claude\|codex> [--copy \| --login] [--yes]`, `agent logout <agent>`, `agent install <claude\|codex> [--yes]`, `agent status [--json]` | Manage bridge's own agent logins; install the claude (about 300 MB) or codex (about 450 MB) adapter |
| `bridge plugin add <path \| https://...tgz --sha256 <hex> \| npm:<name>@<version> [--integrity sha512-...]> [--replace] [--yes] [--no-restart]`, `plugin list [--json]`, `plugin remove <id> [--keep-data] [--yes] [--no-restart]`, `plugin revoke <id> [--yes] [--no-restart]`, `plugin audit <id> [--limit <n>] [--json]` | Install, list, remove or revoke local app plugins, and read a plugin's audit log |
| `bridge doctor [--paths \| --containment] [--json]` | Check the install: launcher, `PATH`, credential store, token write-back paths, agents, plugins and a newer release; `--paths` lists every path the runner writes; `--containment` shows what contained plugin sessions were measured on |
| `bridge service install\|uninstall [--no-activate] [--yes] [--json]` | Install or remove the user service that runs `bridge run` |
| `bridge self install [--yes] [--version <v>] [--from <dir>]` | Install this release for the current user (the launcher links `bridge` and `bridge-runner`) |
| `bridge protocol install\|uninstall [--yes]` | Register or remove the `bridge://` link handler (Linux) |
| `bridge uninstall [--yes]` | Remove what bridge installed; shared folders and `mimeapps.list` stay (bridge's own lines are removed from it) |

An `<app>` argument may be omitted when exactly one app is connected. It is the app's id, as
`bridge apps list` shows it. `bridge-runner` is the same program under a second command name
(see [The `bridge` name on PATH](#the-bridge-name-on-path)).

## The `bridge` name on PATH

On Linux, iproute2 ships `/usr/bin/bridge` (it is part of the base system on Arch, Debian and
Fedora). Until `bridge self install` has run, or while `~/.local/bin` comes after `/usr/bin` on
`PATH`, typing `bridge` runs iproute2's network tool, which fails every runner command
(`bridge status` prints `Object "status" is unknown` and exits 255). A `PATH` lookup therefore says
nothing about whether the runner is installed.

- **The warning.** `bridge self install` and `bridge doctor` check the first `bridge` on `PATH`.
  When it is not the launcher they print `WARNING: `bridge` on your PATH is not the bridge launcher`,
  name both paths, and give the fix: put `~/.local/bin` before `/usr/bin` in `PATH` (in your shell
  profile), or run the launcher by its full path. With the launcher first, or with no `bridge` on
  `PATH` at all, there is no warning.
- **`bridge-runner`.** `self install` (and `install.sh`) writes a second launcher link beside
  `bridge`, `~/.local/bin/bridge-runner`, to the same program, and the npm package has the second
  bin name too. Nothing else uses that name, so an app or a script should run `bridge-runner`.
- **If you must run `bridge`**, tell the runner from iproute2 with `bridge status --json`. The
  runner prints one JSON object with a boolean `running` and an `apps` array and exits 0, even when
  `bridge run` is not running (`{"running":false,"apps":[]}`). iproute2 exits 255. A second check is
  `bridge plugin list` exiting 0.
- **Where the launcher is.** The links live in `~/.local/bin`, under `HOME`. They do not follow
  `XDG_DATA_HOME`, `XDG_CONFIG_HOME` or `XDG_STATE_HOME`: those move the versions, the config and the
  state, not the launcher. This is by design, because the launcher folder is a `PATH` matter, not a
  data folder. So `bridge setup <url> --plan` names `~/.local/bin/bridge` even when the XDG folders are
  redirected; only a different `HOME` moves it.

## Status

```sh
bridge status
```

It prints whether `bridge run` is running (pid, start time, how many browsers are connected,
and since when it has been idle), then one line per app: id, name, link status, number of
trusted browsers and whether an enroll window is open. While the runner runs, the link is
`online`, `connecting`, `reconnecting`, `update_required`, `replaced`, `revoked`,
`auth_failed` or `stopped`, or `local` for a [local-only app](#a-local-only-app), which has no
link. It is `not_running` when the runner is not, and `not_served` when
the runner started before this app was connected. `--json` prints the same as one JSON object:

```json
{"running":true,"pid":4242,"startedAt":"2026-11-04T16:35:22.190Z","browsers":0,"apps":[{"appId":"my-app","name":"My app","origin":"https://my-app.example","link":"online","trustedBrowsers":1,"enrollWindowOpen":false}]}
```

`pid`, `startedAt`, `browsers` and `idleSince` are there only while the runner runs; `running` and
`apps` are always there.

## Connect

```sh
bridge connect https://my-app.example
```

`bridge setup` does this for you; `connect` is the step on its own. The runner fetches
`https://my-app.example/.well-known/bridge.json` over HTTPS (plain HTTP only on localhost),
refuses it if any endpoint is off the app's origin (the auth issuer and its device and token
endpoints are the one exception), then shows the app name, origin and sign-in issuer and asks
before pairing. You approve a device code in the browser; tokens go to the OS keychain under
the service name `berdyh-bridge`, or to the credential files when `BRIDGE_CREDENTIAL_STORE` is set
(next section). Re-connecting an app keeps its runner id. An app id that is
already connected from a different origin is refused: run `bridge apps remove <app>` first.

**A revoked machine.** When the app's server has revoked this machine and the runner saw the
relay's `revoked` verdict (link status `revoked`), `bridge connect` and `bridge setup` say so, connect
it again as a new machine with a new runner id, and delete the old id's trust list, identity and
wrapping key (after listing them). A link that is only `reconnecting` keeps its id. While the relay
refuses the runner (HTTP 403, or no answer), `bridge run` stays up and retries with backoff, logging
each refusal once per step with the same advice: if the app lists this machine as revoked, run
`bridge apps remove <app>` and then `bridge setup <app-url>`.

## Where the runner keeps its credentials

For each connected app the runner keeps two secrets: the sign-in tokens `connect` obtained (the
device-grant access and refresh tokens) and the wrapping key of the app's E2EE identity. By default
both live in the OS keychain: the Secret Service through `secret-tool` on Linux, the login keychain
through `security` on macOS.

**`HOME` and the `XDG_*` variables do not isolate the keychain.** A run with `HOME=/scratch/home`
still talks to your real session keyring: a scratch-HOME test of `bridge connect` would write a
`berdyh-bridge` item into your own login keyring. A machine with no Secret Service (a server, a
container, CI) has nothing to store them in at all.

For both cases, set `BRIDGE_CREDENTIAL_STORE=file:<absolute directory>` and the runner keeps them as
files there instead:

```sh
export HOME=/scratch/home XDG_CONFIG_HOME=/scratch/home/.config XDG_DATA_HOME=/scratch/home/.local/share XDG_STATE_HOME=/scratch/home/.local/state
export BRIDGE_CREDENTIAL_STORE=file:/scratch/home/credentials
bridge doctor        # prints a WARNING that the file store is in use
```

- **Unset or empty** is the keychain, and nothing about it changes. **Anything else that is not
  `file:` followed by an absolute path** is a usage error naming the setting; it never falls back to
  the keychain. With the setting on, the keychain is never called.
- **The directory** is created 0700 when it is missing. It must be a real directory (a symlink is
  refused), owned by you, with no access for anyone else; a looser mode is refused with a
  `chmod 700` hint, never repaired. Each credential is a file named `<percent-encoded key>.secret` of
  mode 0600. A symlink, a file owned by someone else or a looser mode is refused. Writes go to a
  temporary file that is renamed into place.
- **The files are not encrypted.** Anyone who can read the folder as you, or a backup of it, can act as
  this runner. Use it on a machine with no Secret Service, not as a convenience. `bridge doctor`
  prints a `WARNING: BRIDGE_CREDENTIAL_STORE is set` line naming the folder while it is in use, and
  prints nothing about it when the variable is unset (`credentialStore` in `bridge doctor --json`).
- **Every command and the service need it.** The variable is read from each command's environment.
  `bridge service install` copies it into the service unit with `PATH` and the XDG roots, so the
  service uses the store you configured. A change reaches a running service only after
  `bridge service install` and a restart of the service
  ([steps per platform](#background-service-and-the-bridge-handler)).
- `bridge apps remove` and `bridge uninstall` delete the app's entries from whichever store is in use.
  The directory itself stays, and is yours to remove.

This covers the runner's credentials only. The agent logins in `~/.config/bridge/agents/` are plain
files whatever the store ([Token write-back](#token-write-back)).

## Enroll browsers

Setup enrolls your first browser. To add another:

```sh
bridge enroll my-app --open
```

It shows an 8-character code (or opens the enroll page with the code in the link) and waits,
up to the code's 10-minute lifetime, for the browser to use it. A code is single-use and
allows 5 attempts. The runner must be running (`bridge run`, or the service) for the browser
to reach it.

When the browser finishes the code exchange, it shows four words, and the terminal shows the
same four. On a terminal you compare them and answer. Without one, the command waits for a
decision made from another process:

```sh
bridge enroll approve my-app --words "<the four words from the page>"
bridge enroll deny my-app
```

In a script, put the words on stdin instead, so they stay out of argv (`ps`, audit logs):
`printf '%s\n' "$WORDS" | bridge enroll approve my-app --words -`. Input over 4 KiB is refused.

`approve` is refused, and the browser denied, when the words do not match the browser that is
waiting. Never guess, invent or reuse words: ask the person for the four words their page shows.

A scripted enrollment has to fit the runner's idle stop (see
[Start notifications, idle stop and restart](#start-notifications-idle-stop-and-restart)): the runner
exits after 15 minutes with no browser connected, no open plugin session and no enroll activity,
counted from when it started. Keep `bridge enroll <app>` running (its window is activity, for up to
the code's 10 minutes) from before the harness starts the browser until the browser has finished,
and start the runner no earlier than that step. If the runner has stopped in between, run
`bridge run` again before the browser connects.

```sh
bridge browsers list my-app
bridge browsers revoke my-app <browser-key-id>
```

Revoking takes effect on the runner, which is authoritative. Each app has its own trust list.

## Run

```sh
bridge run
```

`bridge run --no-e2ee` (or `BRIDGE_E2EE=0`) selects plaintext channels. It prints a warning, is
for local development only, and must never face a real server.

One `bridge run` per machine: it holds `~/.local/state/bridge/runner.lock`, and a second one
while the first is alive stops with "another bridge run is running (pid ...); stop it first" and
exit code 1 (the service manager retries and takes over after you stop the first). Each app it
serves also has a `worker.lock` in that app's state folder. At start the runner removes what a
crashed run left behind for contained plugin sessions: their session folders, secret files and
sandboxes.

### A newer release

`bridge doctor` and the start of `bridge run` tell you when the registry has a newer `@berdyh/bridge`.
Doctor prints a line, and the runner writes one line to its log (stderr, so `runner.log` under the
service):

```text
update:   bridge 0.2.0 is available (this is 0.1.1); install it with `bridge self install --version 0.2.0`
```

The check is one request for the newest version's manifest (`<registry>/@berdyh%2fbridge/latest`, no
tarball), limited to 3 seconds and 64 KiB, over https only, with no token. It asks the registry npm
would use for the `@berdyh` scope: an `@berdyh:registry` setting, then `npm_config_registry`, then the
`registry=` line of `~/.npmrc` (or the file `npm_config_userconfig` names), then the public npm
registry. Project and global npmrc files are not read, and `npm` itself is not run. The runner does it
in the background, so a slow registry never delays its start.

It never installs anything: the command is yours to run. When the registry is unreachable, refuses,
answers slowly or says nothing newer, there is no output at all. `BRIDGE_UPDATE_CHECK=0`, or npm's
own offline setting (`npm_config_offline=true`), turns it off.

## A local-only app

An app that runs on this machine alone, with no hosted server, relay, sign-in, E2EE identity or
browser, is a local-only app:

```sh
bridge apps add-local my-local --name "My local app"    # lists the paths and asks first
bridge apps add-local my-local --yes                    # without a terminal, `--yes` is required
bridge plugin add ./my-plugin                           # the plugin's manifest names "app": "my-local"
bridge run
```

`add-local` writes `~/.config/my-local/bridge/app.json` (with `"kind": "local"`) and lists the app in
`apps.json` under the origin `local`. It gets the same three `bridge/` folders as any app, and no
keychain item. An id that is already a local app is left as it is; an id that is connected to a hosted
origin is refused (`bridge apps remove <app>` first). `bridge apps list` and `bridge apps remove` work
as for any app; `bridge status` shows the link as `local`.

`bridge run` serves it with no connection: no socket, no token, no browser trust list. The runner
gives it its own `bridge/` folders and its own plugin set, routes its plugin calls and sessions to that
app only, and starts a contained session in its own cwd only; the plugin host and policy are the same as
for a hosted app's (the app's own `config.json` can narrow the machine policy as above). That
separation covers what goes through the runner and the managed per-app paths. A plugin is ordinary code
running as you, with no filesystem confinement: its declared `fs` and `network` grants are shown at
install but **not yet enforced** (see the Plugins bullet of the
[security model](../../README.md#security-model-in-short)), so it can read another app's folders
directly. Nothing listens on the network. A served local app keeps the runner up: there is no
idle stop, because nothing could bring a stopped runner back. The start line says so, `It stays up
until stopped: a local app is served`.

## Work folder and local policy

What agents may do is decided by `~/.config/bridge/policy.json` on this machine (under
`XDG_CONFIG_HOME` when set). A browser can never change it. Setup does not write it.

### The per-app work folder

While `policy.json` has no `allowedCwds`, a session of an app starts only in that app's own
work folder, `~/.local/state/<app>/bridge/work`. The runner creates it (mode 0700) when the
first session needs it. Setup does not create it or list it in `policy.json`.

**What a page's `cwd` becomes.** ACP's `session/new` requires a `cwd`, and a page cannot know the
runner's paths, so it usually sends `"."` or nothing. The runner honours a `cwd` only when it is an
absolute path string. Anything else (missing, `"."`, a relative path, a value that is not a string) is
**replaced, without a word in the reply, by that app's work folder**,
`~/.local/state/<app>/bridge/work`. That is the per-app default, and no other app's. An absolute `cwd`
is used as sent, and local policy then decides: a folder that `allowedCwds` (below) does not admit is
refused with `session not allowed by local policy` (-32012). An app that wants its sessions in a
project folder sends that absolute path, which the user must have listed in `allowedCwds`. An app that does not care
sends `"."` and gets its work folder.

To let sessions start in your project folders, set `allowedCwds` in `policy.json`:

```json
{
  "allowedCwds": ["/home/me/projects/my-app", "/home/me/.local/state/my-app/bridge/work"]
}
```

A configured list is used exactly as written. The work folder is then no longer a default, so
list it too if you still want it. Entries must be absolute paths without `.` or `..`
segments. An entry that reaches an app's bridge state folder is admitted only if it is that
app's own work folder; any other is ignored with a warning.

### Narrowing per app

An app can only narrow the machine policy. `~/.config/<app>/bridge/config.json` may carry:

```json
{
  "policy": {
    "allowedCwds": ["/home/me/projects/my-app"],
    "agents": ["claude"],
    "mode": "read-only"
  },
  "agent": { "default": "claude" }
}
```

An `allowedCwds` entry is kept only if it is the app's own work folder or the machine policy
admits it, so a folder the machine policy refuses cannot be added here. `agents` is
intersected with the machine list. `mode` must be equal to or stricter than the machine's
(`ask`, then `read-only`, then `accept-edits`, then `bypass`); a looser one is ignored. Anything
dropped is reported as a warning by `bridge doctor`. `agent.default` is the agent the app's
sessions use when the browser names none. `pluginApprovals`, `models` and `sessionBudget` in
`policy`, and `agent.model`, govern contained plugin sessions; see
[Contained sessions and policy](#contained-sessions-and-policy).

### Policy file

```json
{
  "mode": "ask",
  "agents": ["claude"],
  "allowedCwds": ["/home/me/projects"],
  "allowedTools": ["Read"]
}
```

In the `read-only` and `accept-edits` modes the auto-approve shortcuts are fail-closed: whenever
anything about a request is ambiguous, they ask. Every path the call names (its locations and any
path, `~` path or `file:` URI in its raw input) is resolved component by component, following
symlinks and applying `..` to the real directory (never lexically). They ask when a path has a
backslash, is longer than 4096 characters or 256 components, when a request names more than 64
paths, when `..` follows a component that does not exist, when a `file:` URI cannot be decoded,
when the call names no path, and when the target is inside a protected location or is a parent of
one (a recursive search of `~/.config`). Strings with a scheme other than http(s) and ws(s) are checked
as relative paths. A session whose directory is itself inside a protected location gets no
shortcut at all. File contents, patches, patterns and prose in the raw input (keys such as
`content`, `old_string`, `new_string`, `lines`, `pattern`) are never read as paths, and the scan
gives up, so the shortcut asks, after 2048 values. Protected locations and the home directory are compared
case-insensitively on every platform, which may ask more than needed on Linux. Accepted
residuals: hardlinks into a protected file, a path that changes between the check and the use,
trusting the agent's own `kind` of a tool call (a call that is mislabelled as a read), and
trusting the `locations` it reports: the trusted scope of a request is the adapter's `kind` plus
`locations`, and the scan of the raw input is best-effort. A request whose rawInput touches files
the adapter does not report in locations is not detected reliably. A protected path is also
recognised by its pathname and by every path seen while following symlinks, so a protected file
that is a symlink into a project still asks.

`mode` is `ask` (default), `read-only`, `accept-edits` or `bypass`. `agents` limits which
agents sessions may use (empty means all installed). `allowedCwds` limits where sessions may
start (absent: the app's work folder, as above). `allowedTools` lists tool names approved
without asking. The `read-only` and `accept-edits` shortcuts only approve files inside the
session directory and never approve (they ask) anything under the runner's own `bridge` config,
data and state directories, the systemd user directory (or `~/Library/LaunchAgents`), `~/.ssh`,
`~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.claude`, `~/.codex`, `~/.netrc`, or your shell rc files
(`.bashrc`, `.zshrc`, `.profile` and the like). The one exception is a session started in its
app's own work folder, which gets the shortcuts although that folder sits under the runner's
state directory. A session whose directory is your home directory itself gets no shortcut at
all. Keep `bypass` off unless you understand it. A runner also caps sessions per channel and per
app; sessions a plugin starts count toward the per-app cap.

## Heartbeat

The runner, the client and the servers keep sockets alive with text frames. After 20 seconds
without outbound traffic an endpoint sends `bridge:ping`; the other side answers `bridge:pong`.
If nothing comes back within 10 seconds, the runner treats the socket as half-open and
reconnects with backoff; the backoff resets only once a connection has stayed up for 30 seconds after the server's welcome. The close code 4401 means the device was revoked: the runner must not
and does not retry. Code 4409 means another process holding this runner's credential took
the connection over; the runner stops that app's connection without retrying. Stop the
other `bridge run` before starting this one again.

## Remove an app

```sh
bridge apps list
bridge apps remove my-app
```

Without a terminal and without `--yes` it refuses (`no terminal to ask on; pass --yes to remove
without asking`), exits non-zero, never reads stdin and removes nothing. With `--yes` it goes ahead
without asking. After confirmation this forgets everything the runner keeps for the app: its tokens, its E2EE
identity, the keychain wrapping key for that identity, its trust list, any open enrollment
window, and its three `bridge/` folders (`~/.config/<app>/bridge`, `~/.local/share/<app>/bridge`,
`~/.local/state/<app>/bridge`). The app's parent folders (`~/.config/<app>` and the other two)
are removed only if empty. A running `bridge run` drops the app on its next start. A custom
`SecretStore` without a `delete` method (the optional method on the secret store the runner is
given) keeps its wrapping key, so remove that entry yourself. The device also stays on the
server's device list until the app owner revokes it there.

## Plugins

```sh
bridge plugin add npm:my-plugin@1.4.0 --integrity sha512-<base64>   # or a path, or https://...tgz --sha256 <hex>
bridge plugin list
bridge plugin audit my-app.sync [--limit 20] [--json]
bridge plugin revoke my-app.sync
bridge plugin remove my-app.sync [--keep-data]
```

`bridge plugin add` installs a plugin (a local folder or tarball, an `https://` tarball with
`--sha256`, or `npm:<name>@<exact version>`), `list` shows them, `remove` removes one and `revoke`
withdraws the approval of one. When the background service is running, `add`, `remove` and
`revoke` restart it so the change is live: open agent sessions of every app end and browsers
reconnect. Each says so before its question, so you can answer no; pass `--no-restart` when that
disruption must be avoided. With it the change waits for the next start of `bridge run`. Without a service they tell you to restart `bridge run`. `bridge run` starts only the
plugins of the apps that are connected. A plugin that fails to start is logged to stderr and does not stop the runner or the other plugins. What the
user is asked, and what `--replace`, `--keep-data` and `revoke` do, is in
[Write a plugin, section 7](write-a-plugin.md#7-install-and-use).

`bridge plugin list` prints one `<id>`, `<version>` and `app <app id>` line per plugin. With `--json` it
prints one JSON array, one row per installed plugin (`[]` when there are none). The shape is stable: new
fields may be added, none are renamed or removed. The arrays are always present, empty when the
manifest declares nothing:

```json
[{"id":"demo","version":"1.0.0","app":"my-local","grants":{"network":["api.example.com"],"fs":[],"agents":["claude"],"localUi":false,"mcpServers":[],"headlessTools":[]}}]
```

`grants` is what the manifest declares and the user approved at install: network hosts, filesystem
paths, agent ids, whether a localhost UI is asked for, the names of the MCP servers it ships and the
tools a headless session may call. `bridge apps list --json` has the same style.

**A widened grant needs a person.** A plugin that ships MCP servers or headless tools asks the
user to approve them. A first install with such an entry, and an update that adds one, can be
approved only by a person at a terminal (stdin and stdout both terminals): `--yes`, a pipe or an
agent running the command is refused with "run it in a terminal to confirm". `--yes` approves an
install that adds nothing to what was approved before. `--yes` from `npm:` or `https://` needs a
pinned hash (`--integrity` or `--sha256`).

### The audit log

Every tool call of a plugin's contained sessions is written, one JSON line each, to
`~/.local/state/<app>/bridge/audit/<plugin id>.jsonl` (mode 0600; when it passes 5 MiB it moves to
`<plugin id>.jsonl.1`, replacing the one before). A line holds the time, the session id, what
started the session (`headless`, or the browser it was started for), the attached servers, the call
id, the tool name, its status, the decision, and the SHA-256 digest and size of the tool's input.
The input itself and the session secret are never written.

```sh
bridge plugin audit my-app.sync            # the newest 50 records, oldest first
bridge plugin audit my-app.sync --limit 200
bridge plugin audit my-app.sync --json     # {pluginId, appId, file, records}
```

Each text line is `time`, `decision`, tool name, status and `session <id>`, separated by tabs.
The `decision` says what happened to the permission request: `allow` (approved from the set the
user consented to at install), `reject` or `cancel` (refused), or `none`, which means **no
permission request was made for that call**. `none` is not a refusal: the agent runs some tools,
a read-only MCP tool for instance, without asking, and the call is still recorded and counted. A
`-` means the call's decision was not known yet.

Each line's `sessionId` is the id the plugin was given; a session that made no tool call has no audit line.

`bridge plugin remove` deletes the plugin's audit log with its data; `--keep-data` keeps both.
If a write to the audit log fails (a full disk, a folder or file made unwritable, the log removed
or replaced), the runner refuses to approve that plugin's tool calls rather than let a call go
unrecorded. The failure is remembered for as long as the runner runs: freeing space or repairing the
path does not bring approvals back. Fix the cause, then restart the runner (stop and start
`bridge run`, or `systemctl --user restart bridge-runner.service` on Linux), which opens the log
again.

### Contained sessions and policy

A plugin's contained session (see [Write a plugin](write-a-plugin.md#3-contained-agent-sessions))
is held to the tools the user approved at install. These keys of `policy.json`, and of an app's
`config.json` under `policy`, narrow that. An app's file can only narrow the machine's.

```json
{
  "pluginApprovals": true,
  "models": ["sonnet"],
  "sessionBudget": { "wallClockMs": 600000, "maxToolCalls": 100 }
}
```

- `pluginApprovals`: `false` turns off the automatic approval of contained plugin sessions.
  Every permission request of such a session is then rejected. An app's `true` cannot turn on what
  the machine turned off. Write the JSON boolean `false`, not the string `"false"`: a value that
  is not `true` or `false` is reported with a warning, and what follows differs by file. In the
  **machine's** `policy.json` it reads as off, so approvals stop. In an **app's** `config.json`
  it is dropped, as if it were absent, so the machine's setting applies and automatic approval
  stays **on** if the machine allows it. Do not take a warning about an app's switch for "off".
  It does not stop a call the agent runs without asking (a `none` line in
  the audit log), which is why it is a kill switch for approvals and not for the plugin.
- `models`: the models a plugin may name for its sessions, exact names. Absent or empty means any.
  With a list, a contained session that names no model is refused (the local policy answers
  `session not allowed`, -32012 to the plugin) unless the app's `agent.model` supplies one. An
  app's list is intersected with the machine's.
- `sessionBudget`: a ceiling on `wallClockMs` and `maxToolCalls`. The runner's own ceiling is
  1 hour and 500 calls; the machine file may lower either, an app's file may lower it further. A
  plugin that names no budget gets 15 minutes and 200 calls (or the ceiling, if lower). A field
  that is not a whole number from 1 up to the runner's ceiling is reported with a warning and not
  used; an app value above the machine's is ignored with a warning.
- `agent.model` (an app's `config.json`): the model a contained session uses when the plugin names
  none; it is checked against `models` like a named one. `agent.effort` is recorded, not applied.

An approval is never widened from here: nothing in `policy.json`, the machine's `mode` or its
`allowedTools` adds a tool to a contained session. The approval set is the headless list the user
consented to, and a call outside it ends the session. `allowedCwds` does not apply: a contained
session always runs in an empty folder the runner makes
(`~/.local/state/<app>/bridge/sessions/<session id>`).

### Contained sessions in `bridge doctor`

```sh
bridge doctor                  # per agent: contained sessions supported, or refused and why
bridge doctor --containment    # the measured pairs and whether the installed one is among them
bridge doctor --containment --json
```

The line reads `contained sessions: supported (running adapter 0.94.0 / CLI 2.1.303; measured on
adapter 0.94.0 / CLI 2.1.303, accepted from those versions up, argv asserted at CI, detected at
runtime)` or `contained sessions: refused: <why>`. For codex the reason is "no containment profile".
For claude it is one of: `the claude adapter is not installed`, `contained sessions run only the
bundled adapter` (an adapter from `BRIDGE_CLAUDE_ADAPTER` or `PATH`; "bundled" means bridge's own installed copy), `claude adapter <v> is older than
the lowest supported <floor>`, `claude CLI <v> is older than the lowest supported <floor>`, or `only
linux x64 was measured`. `bridge doctor` also lists each plugin with contained sessions and whether its
recorded approval matches the installed manifest. `doctor --containment` points to [The claude version floor](#the-claude-version-floor) and never
starts a check: measuring a stack spends your subscription.

### The claude version floor

Contained claude sessions run on bridge's own copy of the adapter (see
[Prerequisites](#prerequisites)), on a stack that is at or above the **lowest measured pair**:
adapter 0.94.0 and `claude --version` 2.1.303 (Linux x64). They are not tied to the hash of one
build. When a contained session starts, the runner reads the adapter's package version and asks the
binary for its `--version`:

- **At the floor or above:** the session runs.
- **Newer than the measured pair:** it runs, and the runner logs one line per versions pair:
  `bridge: contained claude sessions run on adapter <v> / CLI <v>, newer than the measured 0.94.0 /
  2.1.303: accepted, not re-measured`. A newer stack is accepted, not measured.
- **Older than the floor, or a version that cannot be read:** the session is refused
  (`containmentUnavailable`, -32016). `bridge doctor` prints the reason, which names the floor.

What keeps a newer stack contained is the same as for the measured one: the argv the runner asserts, the
contained environment rule and the frame check on every session. `bridge doctor` prints the versions
the session would run on beside the measured ones, and `bridge doctor --containment` shows the table of
measured pairs and whether the installed one is among them. The binary's sha256 in that table is
evidence of the measurement, not checked at a start.

The floor rises only when a newer pair is measured and the older one is dropped. To check a new
claude version against the floor, a maintainer measures the stack on a machine with a real login
(this spends a subscription, so do it deliberately):

1. Install the new adapter and claude CLI, and sign in with bridge's own claude login folder
   (`<XDG config>/bridge/agents/claude`, made by `bridge agent login claude`); `~/.claude` is never
   used for this.
2. Start real contained sessions on that stack and check each of the containment properties the runner
   relies on: the argv it asserts reaches the adapter unchanged, the session sees no settings, hooks,
   memory files or MCP servers beyond the ones declared, the built-in tools are off, and the login and
   secret files stay out of the agent's reach. The stack passes only if every check holds on the new
   pair; a check that was not run counts as not passed.
3. Add the measured pair to `CLAUDE_MEASURED_STACKS` in
   `packages/runner/src/acp/containment/claude.ts`: the adapter, SDK and platform package versions,
   the binary's version and the sha256 of the platform package's `claude` file. The test that counts
   the rows is edited with it.
4. To change the version `bridge agent install claude` installs, move four things together: the
   `@agentclientprotocol/claude-agent-acp` entry in `packages/cli/package.json` (an exact version, in
   `devDependencies`), `CLAUDE_ADAPTER_PIN` (version and integrity) in `packages/cli/src/adapters.ts`,
   the runner's measured stack, and `pnpm-lock.yaml`. `packages/cli/src/adapters.test.ts` fails when
   they differ. Running a newer adapter needs no re-measure; a copy installed for the old version is
   not used, so `bridge agent install claude` asks again.

### App installers

An app's `install.sh` that runs `bridge plugin add` gets the consent prompt on the person's
terminal, using the pattern of `scripts/install.sh`: open the terminal as file descriptor 3 when
`/dev/tty` is readable, run the command with it as input, and otherwise with none.

```sh
if ( : < /dev/tty ) 2>/dev/null; then
  exec 3< /dev/tty
  bridge plugin add npm:my-plugin@1.4.0 --integrity "$INTEGRITY" <&3
else
  bridge plugin add npm:my-plugin@1.4.0 --integrity "$INTEGRITY" < /dev/null
fi
```

Under `curl | sh` the script's own input is the pipe, which is why the terminal is opened by
name. With no terminal the command still runs, and a widened grant refuses with "run it in a
terminal to confirm"; that is the intended result. Never pipe `yes` or any answer into it, and do
not add `--yes` to get past it: `--yes` is "not a person" and a widened grant refuses it. Always
pass the pin (`--integrity` or `--sha256`) so the person is approving the bytes you meant.

## Install, reinstall and uninstall

```sh
bridge self install                  # lists the paths and asks first
bridge self install --version 0.1.0  # a specific version
bridge self install --from <dir>     # from a release tarball set (it and SHA256SUMS are checked)
```

`bridge self install` puts the runner into `~/.local/share/bridge/versions/<version>/` and
points two launcher links, `~/.local/bin/bridge` and `~/.local/bin/bridge-runner`, at it. It runs `npm install` into a staging
folder first and moves it into place. A version that is already there is kept, and only the
launcher links are checked. `bridge setup` runs this for you. It warns when another `bridge` comes
first on `PATH` ([The `bridge` name on PATH](#the-bridge-name-on-path)).

```sh
bridge uninstall
```

It prints every path, asks once, then stops and removes the background service, forgets each
app's keychain items (or credential-file entries), removes the `bridge://` handler, the two launcher links (only
if they point into bridge's versions folder) and bridge's own folders: `~/.local/share/bridge`
(the runner versions and any claude adapter bridge installed), `~/.config/bridge`,
`~/.local/state/bridge`, and each connected app's three `bridge/` folders. It also signs out a
login bridge made with `bridge agent login --login`, and deletes a copied one without signing
anything out. It prints what it leaves alone:

- **Shared and system folders stay**, even empty ones bridge created: `~/.config`, `~/.local`,
  `~/.local/share`, `~/.local/state`, `~/.local/bin`, `~/.config/systemd/user`,
  `~/.local/share/applications` and `~/.cache`. Only bridge's own entries inside them go, such
  as the launcher links, the unit file and its enable symlink, the desktop entry and
  `~/.cache/bridge-install`.
- **`~/.config/mimeapps.list` is never deleted.** Only bridge's `x-scheme-handler/bridge` lines
  are stripped.
- **An app's parent folder** (`~/.config/<app>` and the other two) is removed only if empty.
- **Your agents' own logins** (`~/.claude`, `~/.codex`) were never written by bridge and stay,
  and so does npm's cache.
- **The folder of `BRIDGE_CREDENTIAL_STORE`**, if you set one: its entries go, the folder stays.
- A runner you started by hand is not stopped; uninstall warns about it.

### An older layout

Earlier versions kept every app's trust list, identity and enroll window in one
`~/.config/bridge`, state under `~/.local/state/bridge/apps/`, and plugins under
`~/.local/share/bridge/`. The current version refuses that layout and never migrates it. Most
commands, `uninstall` and `install.sh` stop with a message naming the old paths (`bridge doctor`
reports them). Run the old version's `bridge uninstall`, then `bridge setup <url>`. There is
no migrate command.

## Where things live

`bridge doctor --paths` prints the full list, one path per line with its kind and what it is
(`--json` for a machine-readable list). In short:

| Where | What |
|---|---|
| `~/.local/share/bridge/versions/<version>/` | The installed runner |
| `~/.local/share/bridge/adapters/claude/<version>/` | The claude adapter, when `bridge agent install claude` made it |
| `~/.local/share/bridge/adapters/codex/<version>/` | The codex adapter, when `bridge agent install codex` made it |
| `~/.local/bin/bridge` and `~/.local/bin/bridge-runner` | The launcher links, the only files on `PATH`; they follow `HOME`, not the `XDG_*` roots |
| `~/.config/bridge/` | Machine-wide: `config.json` (`setup.service`), `apps.json` (app id to origin), `policy.json`, `agents/` (bridge's agent logins: `claude/.credentials.json` and `codex/auth.json`, where [refreshed tokens are written back](#token-write-back)) |
| the folder of `BRIDGE_CREDENTIAL_STORE=file:<dir>` | Only when set: the runner's credentials as `<name>.secret` files ([above](#where-the-runner-keeps-its-credentials)). Not listed by `doctor --paths`: it is wherever you pointed it |
| `~/.local/state/bridge/` | `runner.json` (status the CLI reads), `runner.log`, `runner.lock` (the one `bridge run`) |
| `~/.config/<app>/bridge/` | One app: `app.json` (connection record), `trust.json`, `identity.json`, `identity.key`, `enroll.json`, `revoked.json` (the relay refused this runner id for good), optional `config.json`, `plugins/` (one `<plugin id>.consent.json` per plugin: what the user approved) |
| `~/.local/share/<app>/bridge/` | One app: `plugins/`, `plugin-data/` |
| `~/.local/state/<app>/bridge/` | One app: `work/` (the default session folder), `tmp/` (session sandboxes and the per-session secret files of contained plugin sessions), `sessions/` (one empty folder per contained session, emptied when the runner starts), `audit/` (`<plugin id>.jsonl`, the tool-call audit logs), `worker.lock` |
| `~/.config/systemd/user/bridge-runner.service` | The service (Linux); a launchd agent in `~/Library/LaunchAgents` on macOS |
| `~/.local/share/applications/bridge-url-handler.desktop` and `~/.config/mimeapps.list` | The `bridge://` handler (Linux) |

Bridge owns only the `bridge/` segment of each app's folders. App ids are lowercase
(`a-z`, `0-9`, `-`, starting with a letter, up to 63 characters; `bridge` is reserved), and the
first origin to claim an id owns it. `<config>`, `<data>` and `<state>` follow `XDG_CONFIG_HOME`,
`XDG_DATA_HOME` and `XDG_STATE_HOME`. The paths are the same on macOS. A symlinked
`~/.config/<app>` is allowed; a `bridge/` folder that is a symlink is not written through.

`apps.json` is written under a lock, so concurrent `connect` and `apps remove` runs are safe. A record in it that is not valid stops every command with an error naming the record, and nothing is rewritten until you fix or remove it.

## Verify the whole thing

- `pnpm e2e` runs the full path in-process with a stub agent: pairing, enrollment, an encrypted
  prompt, plugins, contained plugin sessions and relay blindness.
- `pnpm e2e:cf` runs the same path against `wrangler dev`.
- A manual run against your real `claude` (`bridge agent install claude`, then `bridge agent login claude`,
  then the steps above) is the only way to see the permission prompts that the automated tests cannot
  answer for you.
