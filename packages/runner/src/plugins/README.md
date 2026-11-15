# Plugin subprocess host

`createPluginHost({ apps })` takes each connected app's `AppPaths` (`appPathsOf(base, appId)`)
and keeps that app's versioned packages under `<data>/<app>/bridge/plugins/<id>/<version>` and
persistent private data under `<data>/<app>/bridge/plugin-data/<id>`. A plugin installs only
into the folder of the app its manifest names. It reads and validates a source snapshot before
consent and writes it atomically after consent. New host instances rediscover the
inventory. The highest installed version runs; removing an id removes all its
versions and its data after every version is confirmed. A plugin id cannot change
its owning app while installed.

Consent callbacks run outside the lifecycle lock, so an unanswered prompt does
not block listing, starting other apps or shutdown. The host revalidates ownership
and versions before writing; removal refuses stale approval if the inventory
changed during consent. Installing a new highest version of an active plugin
stops the old process, preserves its data and starts the replacement before
returning. Inactive plugins stay inactive.
If installation fails after approval, it removes the staging directory, any newly
published version and the id/data directories that attempt created. Existing
versions and data are preserved; a failed active upgrade restores its predecessor.

Each app's `bridge/` folder is resolved through its parent (a symlinked `<data>/<app>` is
allowed; nothing is created before consent) and resolved again after consent, which must find
the same place; symlinks at or below `bridge/` (install, data and sandbox paths, `plugins/<id>`
included) are refused. Missing parents are created `0700`.
Inventory reload skips invalid packages, identity mismatches and unreadable
entries, reporting them through the optional host logger. Corrupt regular entries
can still be removed after explicit consent that identifies their untrusted
metadata. An id containing rejected entries must be removed before reinstalling.
If valid versions claim different apps, the whole id is skipped because its
owning app is ambiguous. Other ids and apps remain usable.

Sources are local directories or plain/gzipped USTAR/POSIX tarballs (with or without
npm's `package/` prefix). Links, special files, traversal, duplicate paths, corrupt
headers and oversized archives are rejected. Global PAX headers (including git
archive's commit metadata) are ignored and never override file paths or sizes.
Directories omit `.git`, `.bk` and `node_modules`. Runtime dependencies must be bundled into regular package files;
installation never contacts a registry or runs package scripts. The sample build
shows an offline self-contained package.

Processes get `buildAgentEnv` plus only `PLUGIN_DATA` and
`BRIDGE_PLUGIN_MANIFEST`. Each has its own HOME, temporary and XDG directories
inside its data directory. Network hosts and extra filesystem permissions are
recorded and shown during confirmation, but are **not enforced**. This is an
execution convention and environment/path isolation, not OS confinement.

The private stdio wire is bounded newline-delimited JSON-RPC 2.0. `PLUGIN_RPC` in
bridge-protocol defines calls, logs, local UI announcements and session creation.
To implement all SDK session operations without extending the shared `PLUGIN_RPC` contract,
the host additionally serves `host/sessionPrompt`, `host/sessionCancel` and
`host/sessionClose` with opaque process-generation session handles. Plugins send
`plugin/ready` after asynchronous setup. Unknown host methods, including permission
answers, are refused. Permission requests stay in the app's proxy broker; the
plugin cannot receive or approve them. The host adds a private opaque `callToken`
to each `plugin/call`; the SDK propagates it with `AsyncLocalStorage` into broker
requests. `onBehalfOf` must name the browser owning the live call asserted by the
token, on the plugin's app. Missing, expired and mismatched tokens are refused.
The host cannot verify that this is the call the broker request is actually
serving: a hostile or buggy plugin can reuse browser B's live token while serving
browser A and attribute the session to B. The same applies when the plugin is
serving no call at all: a background task can use any live call's token. SDK async
context prevents accidental mixing in honest SDK handlers; tokens do not isolate
handlers within one process. This residual attribution risk is a known limit: the
plugin is consented code running as the user's own uid, and attribution is limited to live callers of the same app.
Without attribution the broker applies local policy and cancels
unanswered permission requests, as its contract specifies.

Agent session operations and browser-to-plugin calls have no default deadline;
they settle on completion or protocol disconnect. A session's `cancel()` can
interrupt a prompt through its broker. Hosts may explicitly set `requestTimeoutMs`
to impose a browser call deadline, which does not cancel work already running in
the plugin. Startup still has a separate bounded readiness timeout.

`definePlugin` replaces the global console with a diagnostics console that writes
all methods, including `dir`, `dirxml` and `table`, to stderr before invoking setup.
Direct writes to stdout remain reserved for protocol data.
The host forwards stderr chunks (up to 16 KiB of text per chunk) to its optional
local logger with `stream: "stderr"`; diagnostics never enter browser channels.

Subscribe through `host.router` to receive only that app's plugin notifications and
`_bridge/localUi`. A late subscription receives current UI URLs. A crash rejects
pending RPC calls, closes broker sessions, clears the UI URL and triggers capped
exponential restart backoff. Stopping/removing a plugin cancels restarts and waits
for shutdown; a failed startup does not prevent other selected plugins starting.
Each plugin leads a detached process group. Shutdown sends SIGTERM to the whole
group, then SIGKILL after `stopTimeoutMs`, even if the leader already exited; crash
and RPC-disconnect cleanup also signal the group before relaunch. Cleanup waits
for the leader's exit (or spawn failure), then destroys its local stdio pipes.
It does not wait for child `close`, which inherited pipes can hold open.
Descendants that escape the process group through `detached: true` or `setsid`
can survive stop and removal; process groups are not OS confinement, and those
descendants require separate cleanup. They do not block the host lifecycle queue
or crash restart through inherited stdio. Backoff resets
after `healthyAfterMs` of ready, connected operation (default 60 seconds).

The caller-free `handles(method)` signature classifies valid extension syntax
without consulting plugin inventory. `request()` gives the same `extensionNotFound`
error for missing and foreign-app plugins. `notify` can be called unbound. Malformed
local UI URLs are ignored with a local warning and do not disconnect the plugin.
