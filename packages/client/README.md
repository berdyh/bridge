# @berdyh/bridge-client

The browser and headless client SDK. `connectBridge` fetches the app's `bridge.json`, opens the reliable relay link, enrolls the browser with a runner (SPAKE2) and exposes the encrypted channel as an ACP stream (`bridge.acp`, `bridge.stream`, `bridge.channel`), plus runner presence and plugin local-UI hand-off. See [Add the bridge to an app](../../docs/guides/add-to-an-app.md).

## Setup and enrollment

Call `consumeEnrollLink()` at the very start of the enroll page, before analytics,
authentication redirects or application callbacks. It strips enrollment fields from
the URL with `history.replaceState` before parsing or touching storage, preserving
the path, query and history state. It uses the protocol's strict fragment reader;
malformed enrollment fragments are stripped and rejected too. It never fetches,
opens a connection or starts enrollment.

```ts
import { connectBridge, consumeEnrollLink, setupInstructions, wordsOf } from "@berdyh/bridge-client";

const link = consumeEnrollLink();
// If signed out, redirect now, from this page's script (a server-side sign-in redirect would lose the
// fragment before this runs). The next document on this enroll page can resume the link.
const bridge = await connectBridge({ discoveryUrl, getSessionToken });
bridge.onStatus(renderStatus);
if (link) {
  pairButton.onclick = () => bridge.enroll(link.code, link.runnerId, {
    onBrowserKey: (id) => showWords(wordsOf(id)),
  });
}
const copy = setupInstructions({
  appUrl: "https://app.example", appName: "My app", appId: "my-app",
  platform: "linux", flavor: "human", // or "darwin", "agent"
});
```

`wordsOf` (and its `EnrollWords` type) is exported by this package; there is no need to import
`@berdyh/bridge-protocol` for it.

Only the explicit pair-button click starts enrollment. `onBrowserKey` fires with
the generated or reused long-term browser key id before `pake/start` is sent; show
its four words as text for comparison with the runner's terminal.

The link is returned once per document. A freshly received link is saved in
`sessionStorage`, scoped to the enroll page's pathname, for a sign-in navigation;
the next document consumes and deletes that saved copy. Its local cache expires
ten minutes after receipt, without extension on resume. The link format carries
no issuance timestamp, so only the runner can enforce the original code's actual
remaining lifetime. Disabled storage still permits direct-link enrollment, but
cannot preserve the link through sign-in. A failure to strip the URL throws before
returning a code. Treat the returned link as sensitive: never send it to analytics
or the app server. Display SDK copy as text, not HTML.

`status(runnerId?)` uses relay presence, app-scoped known-runner IDs and saved
runner keys. Successful enrollment and observed presence merge IDs into the
`__bridge/knownRunners` entry in this app's key store, which keeps at most 8 IDs,
most recently seen first. On a new page these IDs
start offline, so a runner that stopped while no page was open still offers the
restart flow. The registry records discovery, never trust; only a saved runner
key can establish enrollment. Presence tracking remains available in memory if
the registry cannot be saved; enrollment awaits registry persistence. Existing
keys without a registry become discoverable after the runner next appears (the
key store cannot enumerate old keys).

With no id, status selects the only online runner, matching `channel()` selection,
or, with none online, reports `runner_offline` for the most recently seen known
runner. Only several runners online at once report `runner_selection_required`
(stale offline IDs never force a picker);
select an id with
`status(runnerId)` and `channel(runnerId)`. An unknown id returns `no_runner`.

| State | Meaning |
| --- | --- |
| `no_runner` | No selected runner (or any runner) is known through presence or saved IDs. |
| `runner_offline` | A known runner is offline, including during relay reconnect. |
| `online_not_enrolled` | The runner is online and no saved runner key exists, or it rejected this browser with `not_trusted`. |
| `ready` | The runner is online and this browser holds its saved enrollment key. |
| `runner_selection_required` | Several runners are online at once; use `onRunners` to offer selection and pass an explicit id. |

`isEnrolled(runnerId)` reads `runnerKeyName(runnerId)` in this app's store.
A matching `not_trusted` session close, including a close by handshake `sid` before
the session starts, immediately invalidates that belief and deletes the saved
runner key. Successful re-enrollment restores it. An in-flight read cannot restore
a belief invalidated by the close. If storage deletion fails, the denial remains
for this client; persistence across reloads requires working storage. Presence
alone cannot prove that a runner still trusts a browser: `ready` reflects locally
saved trust until a handshake reports a revocation.
An `error` close of a live session keeps that local trust belief. Apps should
reopen the channel after such an error: the new handshake can report
`not_trusted`, which changes status to `online_not_enrolled`.

`status()` and the first `onStatus(handler)` delivery wait for a 100 ms presence
settle window after the initial relay connection opens. The relay has no
replay-complete signal, so this is best effort: slower replay can still correct
an earlier status. No presence within the window resolves to the saved offline
runners, or `no_runner` when none are known.

`onStatus(handler)` delivers an initial status asynchronously, then changes,
including runner metadata. Duplicate values are suppressed per subscriber;
unsubscribe or `close()` stops delivery. Subscriber exceptions and mutations do
not affect other subscribers. Ambiguity emits `runner_selection_required` so a
previous runner's `ready` state cannot linger. Storage-read failures do not emit
`ready` and explicit status calls reject with the storage error.

`onStatus(handler, runnerId)` follows `status(runnerId)` for one runner. The default
form suppresses changes while several runners stay online (it stays
`runner_selection_required`); the scoped form still reports that runner's trust and
presence changes.

`setupInstructions` is pure structured text: one-liner, human steps,
troubleshooting, and (for `flavor: "agent"`) an agent prompt. The optional `cliVersion` and `registry`
pin the command: every emitted command runs through
`npx --registry <registry> @berdyh/bridge@<cliVersion>`, in each step (the one-liner is
`npx --registry <registry> @berdyh/bridge@<cliVersion> setup <origin>`). Pass `platform`
explicitly for macOS; its deterministic default is Linux. Linux copy includes the
`bridge://run` restart link and `bridge run` fallback; macOS uses the paste
fallback. Pass `appId` to select a connected app by id; callers that omit it
select by origin instead. The helper accepts HTTPS (or
loopback HTTP) URLs without credentials, query or fragment and quotes shell
arguments. It never detects a platform or performs setup itself.

Agent copy includes prerequisite checks, a path plan, approval before install or
service writes, `connect --yes` with human device-grant approval, the background
service default, per-app work folders and the fifteen-minute idle exit. Trust
still requires the human to supply the four words from the page; `--yes` cannot
approve it. The agent asks the human for those four words and then runs
`bridge enroll approve <app> --words "..."`. The commands in the copy (`bridge setup`, `self install`, `connect`,
`service install`, `enroll`, `status`) are in `@berdyh/bridge` and the `bridge://` handler is registered
by `bridge setup` or `bridge protocol install` (Linux).

## Permission prompts and elements

`permissionPrompt({ mount, timeoutMs })` returns the handler for the agent's ACP permission requests. It calls `mount(view, answer)` to render the request (the strings come from the agent: show them as text) and resolves with the person's choice. Only the `allow_once` and `reject_once` options the agent offered can be selected. With no `mount`, an aborted request or a `timeoutMs` timeout, it denies.

`defineElements()` registers two optional custom elements, `bridge-setup` (the status and enroll flow) and `bridge-permission` (a permission prompt). It does nothing outside a browser. Everything else in the page, such as sign-in, layout and copy, stays with the app.
