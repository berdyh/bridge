# @berdyh/bridge-runner

The runner core behind the CLI: the ACP proxy that terminates each browser's channel, local policy, agent adapters (`createAcpAgentAdapter`, `createDefaultAgentAdapters`), the plugin host, the per-app E2EE state (identity, trust list, enrollment) and service and path planning. The `bridge` CLI (`@berdyh/bridge`) is built on it; import it when you embed the runner or write an agent adapter, not to set up a machine (use `npx @berdyh/bridge setup <app-url>` for that). See [Operate the runner](../../docs/guides/operate-the-runner.md), [Write an adapter](../../docs/guides/write-an-adapter.md) and [Write a plugin](../../docs/guides/write-a-plugin.md).

## Per-app folders (paths)

Bridge is part of each app: an app's data lives in the app's own XDG folders and bridge owns only the `bridge/` segment inside them. `appPathsOf(base, appId)` builds every per-app path from one id (the id must be a lowercase folder name and not `bridge`; `assertAppFolderName`), so no function can reach another app's folder from this app's paths.

| Folder | Holds |
|---|---|
| `~/.config/<app>/bridge/` | `app.json`, `trust.json`, `identity.json`, `identity.key` (only without the keychain), `enroll.json`, optional `config.json`, `plugins/` (`AppPaths.consentDir`: one `<plugin id>.consent.json` per plugin) |
| `~/.local/share/<app>/bridge/` | `plugins/<id>/<version>/`, `plugin-data/<id>/` |
| `~/.local/state/<app>/bridge/` | `work/` (agent sessions' default folder), `tmp/` (per-session sandboxes and the secret files of contained sessions, `AppPaths.secretsParent`), `sessions/` (`AppPaths.sessionsDir`: one empty folder per contained session), `audit/` (`AppPaths.auditDir`: `<plugin id>.jsonl`) |

The three parents (`~/.config/<app>`, `~/.local/share/<app>`, `~/.local/state/<app>`) belong to the app: bridge creates them `0700` only when missing, never changes an existing one's mode, may be reached through a symlink there, and removes one only when empty (`removeBound(path, { emptyDirOnly: true })`). A symlink at or inside the `bridge/` segment is refused (plugin host, sandboxes, work folder). Machine-wide paths are `~/.local/share/bridge/versions/`, `~/.local/state/bridge/runner.json` and `~/.config/bridge/`, plus `~/.config/bridge/agents/` (`RunnerPaths.agentsDir`, `agentDir(paths, "claude" | "codex")`). Keychain items use the service name `berdyh-bridge`.

The runner takes the per-app layout through `E2eeApp.paths`, `createPluginHost({ apps })`, `LocalPolicyConfig.appStateDirOf`, `createDefaultAgentAdapters({ base })` and `doctorPaths({ appPaths })`. With `appStateDirOf` set, `LocalPolicyConfig.protectedPaths` also bounds session admission: a session cwd or configured root inside any protected root is refused unless it is inside the session's own work folder, so a broad `allowedCwds` (the home dir) never starts one app in another app's folders (the CLI passes every connected app's three bridge dirs). `PluginHost.remove(id, consent)` removes that id's two directories in every listed app's folder (a plugin id has one owner, so normally one pair); the consent summary lists each directory in `PermissionSummary.paths`, as `install` does for where it writes.
