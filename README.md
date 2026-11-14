# bridge

A kit for connecting a hosted web app to the coding agent on a user's own machine.

- **bridge** (`@berdyh/bridge`): one local runner per machine. It pairs with each app's server separately, keeps a
  separate credential, connection, browser trust list and plugin set per app, and starts agent sessions
  (Claude Code, Codex) on the user's machine when that app asks.
- **Server kit** (`@berdyh/bridge-server` and its Node, Cloudflare, Clerk, Neon and D1 adapters): the relay, pairing
  API and device store an app deploys for itself. Each app runs its own; nothing is shared between apps.
- **Client and plugin SDKs** (`@berdyh/bridge-client`, `@berdyh/bridge-plugin-sdk`): for the app's browser code and
  for plugins that run their own contained agent sessions.

The source will be published here. Until then this repository holds only this summary.
