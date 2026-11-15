# Write a plugin

A plugin is code your app ships to run on the user's machine, for example a notes indexer
with a local search page. The runner spawns it as its own Node process. The hosted page
calls its methods through the same encrypted ACP channel it uses for agents. A plugin
can also start agent sessions of its own, including contained ones that have only the
tools the plugin ships (section 3).

The working example is [examples/sample-plugin](../../examples/sample-plugin). It
registers `_sample/echo`, serves a small local page, and answers `_sample/ask` through a
contained session with its own MCP server.

## 1. The manifest

A plugin directory (or `.tgz`) needs a `bridge-plugin.json` and a `package.json`. The
`package.json` must carry a valid semver `version`: the install refuses the plugin
without one, and `bridge plugin list` shows it. The manifest:

```json
{
  "id": "my-app.sync",
  "app": "my-app",
  "entry": "dist/plugin.js",
  "permissions": {
    "network": ["api.example.com"],
    "fs": ["$PLUGIN_DATA"],
    "agents": ["claude"],
    "localUi": { "port": "auto" },
    "mcpServers": {
      "corpus": { "entry": "dist/mcp.js", "args": ["--secret-file", "${SESSION_SECRET_FILE}", "--data", "${PLUGIN_DATA}"] }
    },
    "headless": { "tools": ["mcp__corpus__search", "mcp__corpus__summary_write"] }
  }
}
```

- `id`: lowercase letters, digits, `.`, `-`, `_`. It is also the method prefix, so the
  plugin's methods are `_my-app.sync/<name>`. The id `bridge` is reserved.
- `app`: the `app.id` of your bridge server (as served in `bridge.json`; letters, digits, `.`, `-`, `_`, at most 64). Only browsers
  enrolled for that app can call the plugin, and the plugin only runs for that app's connection.
- `entry`: a relative path inside the package. It is spawned as `node <entry>`.
- `permissions`: unknown keys are rejected. `localUi.port` is `"auto"` or a port from
  1024 to 65535 (the SDK currently always binds a free port, whatever it declares). `agents` lists the agent ids the plugin may ask the runner for (same charset as an app id). `fs` entries are printable paths of at most 512 characters, without control characters. The consent prompt shown at install strips control characters from every line.
- `permissions.mcpServers`: the MCP servers the plugin ships, by name. The runner starts them
  for the agent sessions that attach them (section 3); it never starts one on its own.
  - A name is lowercase letters, digits and `-`, starting with a letter, at most 32 (no `_`,
    so `mcp__<server>__<tool>` splits one way). At most 16 servers.
  - `entry` is a printable path inside the package (at most 512 characters) and must exist in
    the package: the install refuses the plugin otherwise. The runner runs `node <install dir>/<entry>`
    with its own Node. There is no `command`, `env` or `cwd`: any other key is rejected.
  - `args` is at most 32 printable strings of at most 512 characters. The only placeholders are
    `${PLUGIN_DATA}` (the plugin's data folder) and `${SESSION_SECRET_FILE}` (the path of the
    session's secret file, section 3). Any other `${` is rejected.
  - A server that uses `${SESSION_SECRET_FILE}` can only be attached to a session that passes a
    `secret`, and a `secret` needs such a server.
- `permissions.headless.tools`: the tools the plugin's contained sessions may use without asking
  anyone, each written `mcp__<declared server>__<tool>` (`<tool>` is letters, digits, `_` and `-`,
  at most 64; at most 256 tools, no duplicates). A tool of a server you did not declare is rejected.
  The user approves this list once, at install. It reaches your own MCP tools only, never a built-in
  tool of the agent.

**Enforcement.** What the runner enforces: the process sandbox (a stripped environment and its own
HOME, TMPDIR and data directory) and, for contained sessions, what section 4 lists. What it does not:
the declared `network` hosts and extra `fs` paths are shown to the user at install time but are
**not yet enforced**, and your plugin and its MCP servers run as the user and can do what the user can.
State that plainly to your users.

## 2. The code

Use `@berdyh/bridge-plugin-sdk`:

```ts
import { definePlugin } from "@berdyh/bridge-plugin-sdk";

definePlugin(async ({ registerMethod, startAgentSession, localUi, dataDir, log }) => {
  registerMethod("_my-app.sync/status", async (params, caller) => {
    // `params` is untrusted input. `caller` is { appId, browserKeyId }.
    return { ok: true };
  });

  registerMethod("_my-app.sync/summarize", async (params, caller) => {
    const session = await startAgentSession({ agent: "claude", onBehalfOf: caller });
    try {
      const { text } = await session.prompt("Summarize the data in your working directory.");
      return { text };
    } finally {
      await session.close();
    }
  });

  await localUi.listen((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<h1>Local inbox</h1>");
  });
  log.info("ready", { dataDir });
});
```

- `registerMethod(name, handler)`: `name` is the full `_<id>/<name>` and must start with the
  plugin's own prefix, otherwise it throws. The handler's result (or a thrown error's message)
  goes back to the browser.
- `startAgentSession(request)`: asks the runner for an agent session. It rejects unless the
  manifest lists the agent. Without the contained options it is an ordinary session: pass the
  `caller` you received as `onBehalfOf`, so permission requests the local policy does not
  answer are forwarded to that browser; without it they are cancelled. The plugin never sees or
  answers a permission request, and the permission mode is the runner's local policy. The
  contained options are in section 3.
- `localUi.listen(handler)`: binds `127.0.0.1` on a free port and tells the runner the URL.
  The manifest must declare `localUi`. The runner sends the URL to enrolled browsers of the
  app inside the encrypted channel (`_bridge/localUi`), and the page receives it through
  `bridge.onLocalUi`. The content never touches the relay.
- `dataDir` (`$PLUGIN_DATA`) is the plugin's own writable directory. `log` has `debug`,
  `info`, `warn` and `error`.

## 3. Contained agent sessions

An ordinary session gives the agent all of its own tools and relies on the person to answer each
permission request. A plugin that works in the background, with nobody to ask, uses a **contained**
session instead: the agent gets none of its built-in tools (no shell, no file or web tools), only
the MCP servers the plugin declared, and only the tools the user approved at install.

A session is contained exactly when `tools.builtins` is `"none"`. These options belong to
contained sessions only, and on any other session the start fails with -32016:
`mcpServers`, `secret`, `headless: true`, `budget` and a non-empty `tools.allow`.

| Option | Meaning |
|---|---|
| `agent` | An agent id from `permissions.agents`. Only `"claude"` can be contained in this release |
| `tools.builtins` | `"none"` makes the session contained. The default is `"agent-default"` |
| `tools.allow` | Exact `mcp__<server>__<tool>` names the session may use. Each must be in the headless set the user approved, on an attached server |
| `mcpServers` | Names from `permissions.mcpServers` to attach, at most 16 |
| `secret` | Up to 4096 bytes of UTF-8 text for the attached servers (a job token, for example). See below |
| `model` | A model name. The user's policy decides whether it is allowed (-32012 when not); the app's `agent.model` is used when you name none. See [Operate the runner](operate-the-runner.md#contained-sessions-and-policy) |
| `budget` | `{ wallClockMs, maxToolCalls }`. Defaults are 15 minutes and 200 tool calls. A value above 3,600,000 ms or 500 calls is invalid (-32602); the user may set lower ceilings, which clamp yours |
| `headless` | `true` says no person is behind the session. A label for the audit log, nothing more: the approval set is the same either way. It cannot be combined with `onBehalfOf` |
| `onBehalfOf` | The `caller` of the page that asked for the session. The audit log then names that browser as the trigger. The consented tool set applies to it all the same: a page cannot widen it |
| `cwd` | Not allowed. The runner gives a contained session an empty private folder and refuses a request that names one (-32602) |

A background job in a hosted app: a page asks for a summary, the plugin starts a contained
session that reads pages and writes the summary through its own MCP server, and hands the job
token to that server and to nothing else.

```json
{
  "id": "my-app.local",
  "app": "my-app",
  "entry": "dist/plugin.js",
  "permissions": {
    "agents": ["claude"],
    "mcpServers": {
      "corpus": { "entry": "dist/mcp.js", "args": ["--secret-file", "${SESSION_SECRET_FILE}", "--data", "${PLUGIN_DATA}"] }
    },
    "headless": { "tools": ["mcp__corpus__page_read", "mcp__corpus__search", "mcp__corpus__summary_write"] }
  }
}
```

```ts
definePlugin(async ({ registerMethod, startAgentSession, log }) => {
  registerMethod("_my-app.local/summarize", async (params) => {
    const { jobId, jobToken } = params as { jobId: string; jobToken: string };
    const session = await startAgentSession({
      agent: "claude",
      tools: {
        builtins: "none",
        allow: ["mcp__corpus__page_read", "mcp__corpus__search", "mcp__corpus__summary_write"],
      },
      mcpServers: ["corpus"],
      secret: jobToken, // reaches the corpus server through a file, never an env variable or argument
      budget: { wallClockMs: 10 * 60_000, maxToolCalls: 100 },
      headless: true,
    });
    log.info("summary job started", { jobId, sessionId: session.sessionId });
    session.onUpdate?.((event) => {
      if (event.type === "tool_call") log.info("tool call", { jobId, tool: event.toolName });
    });
    const ended = session.ended?.then(({ reason }) => log.info("session ended", { jobId, reason }));
    try {
      const { text } = await session.prompt(`Summarize job ${jobId}. Read pages with page_read and save the result with summary_write.`);
      return { text };
    } finally {
      await session.close();
      await ended;
    }
  });
});
```

**The secret.** The runner writes `secret` to a file (mode 0600, in a folder of its own that is
not under the agent's HOME, TMPDIR, XDG or config folders and not in its working folder), and
replaces `${SESSION_SECRET_FILE}` in the server's args with that file's path. Your MCP server
reads the file at start. The secret is never put in an environment variable, a command-line
argument, an ACP frame, a relay frame, a log line or an audit record. The folder is removed when
the session ends, and a runner start removes any a crash left. The file is private to the user's
account, not to your server alone: another process of the same user can read it while the session
runs, as it can read bridge's own login. Do not treat it as stronger than that.

**What the agent sees.** A contained session starts in an empty folder, loads no `CLAUDE.md`,
`.mcp.json`, hooks or settings, and has no slash commands: a prompt that starts with `/` is refused
(-32602) and not forwarded.

**Events.** `session.onUpdate(handler)` delivers, in order, `tool_call` and `tool_call_update`
(`id`, `toolName`, `kind`, `title`, `status`), `text`, `plan` and `usage` events. `rawInput` and
`result` appear only on your own `mcp__` tools. Subscribe right after the start returns: until the
first subscriber the SDK holds up to 1024 events and drops later ones. Nothing here crosses the
relay; the plugin decides what to forward to its page. `plan` and `usage` events are typed but have
not been checked against a real agent's frames in this release.

**How it ends.** `session.ended` resolves once with `{ reason }`:

| `reason` | Why |
|---|---|
| `closed` | You called `close()` (with no `cancel()` since the last prompt) |
| `cancelled` | You called `cancel()`, no prompt followed, and then you called `close()` |
| `budget` | The wall clock or the tool-call budget ran out |
| `breach` | The agent used a tool outside the session's set; see section 4 |
| `agent_exited` | The agent process ended on its own |
| `plugin_gone` | The plugin's own process ended or was stopped |
| `runner_shutdown` | The runner is stopping |

**A finished prompt, or `cancel()`, does not end the session.** When `prompt()` returns, the session
stays open: the agent process, the secret file and the budget clock keep running, and the next
`prompt()` continues the conversation. `cancel()` only asks the agent to stop the current turn; the
session is still open afterwards. Always call `close()` when you are finished, as the example does in
`finally`. To stop early, call `cancel()` and then `close()`: only then does `ended` resolve with
`cancelled`. Awaiting `ended` after `cancel()` alone waits until the wall-clock budget ends the
session.

A `prompt()` that is in flight when the session ends for `breach` or `budget` rejects with -32017
or -32018.

**The session id.** `session.sessionId` is the runner's session id: `bridge plugin audit <plugin>` prints it as `session <id>`, the runner log carries it as `sessionId`, and the session's working folder is named after it. Log it with your job id to correlate.

## 4. What is enforced, and what is measured

Contained sessions are **claude only** in this release. A contained request for any other agent
(codex, for now) fails with -32016, and no agent is started.

What holds a contained session to its tools is *measured for adapter 0.94.0 / CLI 2.1.303, accepted
from those versions up, argv asserted in the runner's tests, detected at runtime*. In plain words:

- The runner starts only bridge's own installed copy of the agent adapter, with the `claude` binary
  that comes with it, at or above the versions it was measured on. An older or unreadable version is
  refused with -32016; a newer one is accepted and logged, not re-measured. `bridge doctor --containment`
  shows the installed pair and whether it is one of the measured ones.
- For those versions, the command line the adapter builds from the runner's options (no built-in
  tools, only the attached servers, no settings sources, no slash commands) is asserted by the
  runner's tests against what was measured.
- At runtime the runner checks the versions, the agent's `session/new` answer and every tool call
  it sees. A permission request for a tool outside the session's set is rejected, and never reaches a
  browser. A tool call outside the set ends the session as `breach` (-32017).

The last point is a detection, not a prevention: the call is seen after the agent started it, so it
**may already have run**. The control is the command line that leaves the agent no other tools; the
kill is the backstop. Treat a `breach` as an incident, and look at the audit log.

Things that are not claimed:

- Your MCP server runs as the user. Containment limits what the *agent* can reach, not what the
  server can. It can read what the user can read, bridge's staged agent login for that run included.
  The install prompt says so.
- The `network` and `fs` entries in your manifest are shown, not enforced.
- The measurement covers one adapter and CLI pair on Linux x64. A newer pair is accepted but not
  re-measured, and an older one is refused (see [Operate the runner](operate-the-runner.md#the-claude-version-floor)).

**The audit log.** Every tool call of a contained session is recorded in
`~/.local/state/<app>/bridge/audit/<plugin id>.jsonl`, from the agent's own `tool_call` frames:
time, session id, trigger (`headless`, or the browser the session was started for), the attached
servers, the call id, the tool name, its status, a SHA-256 digest of its input and the input's
size. The input itself and the secret are never written. Each record also carries a `decision`
that says what happened to the permission request for that call:

- `allow`: the runner approved it from the consented set.
- `reject` or `cancel`: the runner refused it.
- `none`: no permission request was made for that call. This does **not** mean the call was not
  allowed: the agent runs some tools (a read-only MCP tool, for instance) without asking, and the
  call is still recorded, counted against the budget and, if the tool is outside the set, a breach.

## 5. Errors

A failed start or a failed `prompt()` rejects with an error whose `code` is one of these.

| Code | Name | When | What to do |
|---|---|---|---|
| -32016 | `containmentUnavailable` | The request asks for something only a contained session may have, without `tools.builtins: "none"`; or the agent has no containment profile here (codex; claude below the version floor or at a version that cannot be read, or an adapter that is not bridge's own copy); or a check failed before the session started | Do not retry. Drop the contained-only options only if the job can do without them, or tell the user to run `bridge doctor --containment`. The message is generic by design; the reason is in the runner's log |
| -32017 | `containmentBreach` | A running session was killed because the agent used a tool outside its set. That call may already have run | Do not trust the session's output. Do not retry unchanged. Check the audit log |
| -32018 | `budgetExceeded` | The wall clock or the tool-call budget is used up. The clock runs from your start request, start-up included | Split the work, or ask for a larger `budget` (at most 1 hour and 500 calls; the user's own ceiling may be lower, and only the user can change it) |
| -32019 | `consentMissing` | The runner holds no valid consent for this plugin: the user revoked it, or the installed version has no recorded approval; also a `headless: true` request when no headless tool was approved | Tell the user to approve the plugin again (section 7, "Removing, keeping data, revoking") |

Other codes you may see: -32602 (the request is invalid: an undeclared or unconsented server or
tool, a `cwd`, a secret nobody reads, a prompt starting with `/`) and -32012 (the user's policy does
not allow this agent or model for this app).

## 6. Package it

The host does not download dependencies or run npm lifecycle scripts on install. Ship a
self-contained package: bundle or vendor everything the entry imports, including the SDK.
The sample's `build.mjs` copies the SDK and protocol `dist` folders next to the entry and
rewrites the imports. A bundler works as well.

Or ship dependencies inside the package with `bundleDependencies`. Every runtime dependency goes in
**both** `dependencies` and `bundleDependencies`: `bundleDependencies` only says what to pack, and
`npm install` installs only what `dependencies` lists, so a name in the bundle list alone bundles
nothing and the import fails after install. That includes the MCP SDK your entry imports, and any
dependency those need (npm packs those along).

```json
{
  "name": "my-plugin",
  "version": "1.4.0",
  "dependencies": { "@modelcontextprotocol/sdk": "^1.0.0" },
  "bundleDependencies": ["@modelcontextprotocol/sdk"],
  "files": ["dist", "bridge-plugin.json"]
}
```

```sh
npm install     # in the plugin folder, so node_modules holds what is bundled
npm pack        # writes my-plugin-1.4.0.tgz with the bundled dependencies inside
tar tzf my-plugin-1.4.0.tgz | grep node_modules | head   # empty means nothing was bundled
```

Install from the `.tgz`, not from the source folder: installing a folder leaves out
`node_modules`, `.git` and `.bk`, while a tarball keeps what it bundled. A package may hold up to
100,000 files and 64 MiB, and no symlinks. If you use `files`, list `bridge-plugin.json`.

## 7. Install and use

```sh
bridge plugin add ./path/to/plugin-dir-or-package.tgz   # shows permissions, asks first
bridge plugin list
bridge plugin audit my-app.sync                          # the newest tool-call records
bridge plugin remove my-app.sync                         # removes its install dir, its data and its audit log
bridge run                                               # restart it to load new plugins
```

`--yes` skips the question for a grant that is not widened. The plugin's app must already be
connected (`bridge setup <app-url>`); otherwise the install says to connect it first. Each plugin
installs into its own app's folders: code in `~/.local/share/<app>/bridge/plugins`, data in
`~/.local/share/<app>/bridge/plugin-data`. `bridge plugin list` shows each plugin with its
app, and `bridge doctor --paths` shows the plugin directories. A runner serves the plugins that were installed
for an app when it started; a crashed plugin is restarted with backoff.

**Publishing.** Publish the tarball to npm, or host it over https, then install it by name:

```sh
npm view my-plugin@1.4.0 dist.integrity            # sha512-..., the registry's hash of the tarball
bridge plugin add npm:my-plugin@1.4.0 --integrity sha512-<base64>
bridge plugin add https://example.com/my-plugin-1.4.0.tgz --sha256 <64 hex characters>
```

- `npm:<name>@<exact version>` only: a range, a tag or a git spec is refused. The registry is the
  one `npm config get registry` names, over https; the download is checked against the registry's
  `dist.integrity`, and against `--integrity` when you give it. An `https://` source needs
  `--sha256`, the hash of the tarball; `http://` is refused.
- A pin (`--integrity`, `--sha256`) is a hash you got from somewhere other than the download. `--yes`
  installs from a published source need one, because the registry's own `dist.integrity` comes with
  the download it checks. An interactive install may leave `--integrity` out.
- Downloads are staged under `~/.cache/bridge-install/plugins/` and removed afterwards.

**What the user is asked.** The prompt lists the agents, the MCP servers with their command line,
the headless tools, the audit file and the paths the install writes, and says that network and
filesystem entries are not enforced. A first install that holds an `mcpServers` or `headless`
entry, and an update that adds one, is a *widened* grant: only a person at a terminal can approve
it. `--yes`, a pipe or an agent running the command cannot, and the command stops with "run it in a
terminal to confirm". An install that adds nothing to what the user already approved, a plain
plugin included, can be approved with `--yes`. An app's own installer script gets the prompt on the
person's terminal; see [Operate the runner](operate-the-runner.md#app-installers).

**Updating.** Install the new version with `bridge plugin add` (an older version is replaced, and
superseded versions are removed). The prompt shows what the update adds or removes compared with
what the user approved before. Installing the same version again is refused unless you add
`--replace`; `--replace` with identical content and a current approval changes nothing ("Nothing
changed") and does not restart anything.

**Removing, keeping data, revoking.**

```sh
bridge plugin remove my-app.sync                 # also removes its data and its audit log
bridge plugin remove my-app.sync --keep-data     # keeps the data folder and the audit log
bridge plugin revoke my-app.sync                 # withdraws the approval, keeps the plugin
```

`remove` deletes the recorded approval with the plugin, so a reinstall asks again; with
`--keep-data` a reinstall finds the data where it was. `revoke` withdraws the user's approval
without removing the plugin: its contained sessions stop and the next start fails with -32019.
To approve again, run `bridge plugin add` on the same package with `--replace` and answer the
prompt at a terminal: an identical copy whose approval was revoked (or is missing or does not fit
it) is not a no-op, it asks, and a yes writes the approval again without touching the data.
`--yes`, a pipe or an agent cannot give that answer. Removing the plugin with `--keep-data` and
adding it again also works.

**A runner that is already running.** When the background service is running, `bridge plugin add`,
`remove` and `revoke` restart it so the change takes effect: open agent sessions of every app end,
and browsers reconnect. Each of the three says so **before** its question ("Approving restarts the
bridge service: ..."), once, and only when approving will restart a running service. If that
disruption matters (a session of another app is running a job), answer no, or pass `--no-restart`
to `add`, `remove` and `revoke`: the change is made, and takes effect at the next start of
`bridge run` or the service. Without a service, the command tells you to restart
`bridge run`.

From the page, call a method on the ACP connection from [the client guide](add-to-an-app.md):

```ts
const result = await connection.agent.request("_my-app.sync/status", {});
```

Any `_` method whose plugin is not installed for that app is refused, the same way as an
unknown plugin id. Another app's plugin ids are unreachable.
