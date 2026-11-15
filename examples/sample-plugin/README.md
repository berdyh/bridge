# Sample bridge plugin

Build from the repository root with `pnpm --filter @berdyh/bridge-sample-plugin... build`.
The build includes the SDK and protocol modules as regular files under `dist/`,
so the plugin can be copied or packed and installed offline without `node_modules`.
Use the sample directory (or an npm-style `.tgz`) with `PluginHost.install` or
`bridge plugin add`, approve its permissions at a terminal, then start plugins for
`sample-app`. The sample declares an MCP server and a headless tool, so its grant is
widened: `--yes` or a piped answer cannot approve it, only a person at a terminal.

An enrolled browser on `sample-app` can call `_sample/echo` with arbitrary JSON and
receives that JSON back. Subscribe to the host router before starting to receive
`_bridge/localUi`, or subscribe later to receive the current URL. Opening the URL
shows a small page served only on `127.0.0.1` on an automatically assigned port.

`_sample/ask` `{question}` answers from the notes in the plugin's data folder
(`$PLUGIN_DATA/notes`; the plugin puts a `welcome.md` there on first start, add `.md`
or `.txt` files beside it). It starts a **contained, headless** claude session: no
built-in tools (`tools.builtins: "none"`), only the sample's `notes` MCP server
(`dist/mcp.js`, built from `src/mcp.ts`), and only its read-only `search` tool, the
one entry of `permissions.headless.tools`. Nobody is asked during the session: the
runner approves the consented tool, refuses any other, and ends the session
(`breach`) if the agent calls one anyway.
The sample needs no network hosts.
