import path from "node:path";

import { type Platform, runnerStatusPath } from "./contracts.js";
import { type AppPaths, type BaseDirs, agentDir, runnerPaths } from "./paths.js";

export type ManifestKind = "dir" | "file" | "symlink";
export type ManifestRole = "install" | "launcher" | "config" | "state" | "log" | "service" | "external";

export interface ManifestEntry {
  path: string;
  kind: ManifestKind;
  role: ManifestRole;
  description: string;
  /** False for paths the runner touches but does not own: uninstall must leave them. */
  removeOnUninstall: boolean;
}

/**
 * `doctor --paths`: every path the runner and its service would write for this
 * app and these base dirs. Uninstall removes exactly these, nothing else.
 * Bridge keeps the agents' logins in its own `agentsDir` and never writes the agents' own login
 * files, so none is listed. (`ManifestRole` keeps "external" for a path that is touched but not owned.)
 * The state dir also holds `runner.json` (the live status file). Each connected app's
 * folders are listed from `appPaths` (the three `bridge/` dirs and what is inside them).
 * Shared parent dirs (e.g. ~/.config/systemd/user, ~/.local/bin) and the apps' own parents
 * (`<config>/<app>`, `<data>/<app>`, `<state>/<app>`) are not listed because they are not
 * owned by the runner.
 */
export function doctorPaths(args: {
  app: string;
  platform: Platform;
  base: BaseDirs;
  includeService?: boolean;
  /** The connected apps' paths (`appPathsOf`); each adds its `bridge/` dirs and their contents. Default: none. */
  appPaths?: readonly AppPaths[];
}): ManifestEntry[] {
  const p = runnerPaths(args);
  const entries: ManifestEntry[] = [
    { path: p.appDir, kind: "dir", role: "install", description: "app install root (versions live inside)", removeOnUninstall: true },
    { path: p.versionsDir, kind: "dir", role: "install", description: "versioned installs; the launcher link pins the explicitly installed version", removeOnUninstall: true },
    { path: p.launcherLink, kind: "symlink", role: "launcher", description: "launcher link on PATH", removeOnUninstall: true },
    { path: p.configDir, kind: "dir", role: "config", description: "runner configuration", removeOnUninstall: true },
    { path: p.stateDir, kind: "dir", role: "state", description: "runner state", removeOnUninstall: true },
    { path: p.logFile, kind: "file", role: "log", description: "runner log", removeOnUninstall: true },
    { path: runnerStatusPath(p), kind: "file", role: "state", description: "runner status (runner.json): pid, apps, idle time", removeOnUninstall: true },
  ];
  entries.push(
    { path: p.agentsDir, kind: "dir", role: "config", description: "agent logins kept by bridge (agent login)", removeOnUninstall: true },
    { path: agentDir(p, "claude"), kind: "dir", role: "config", description: "claude login kept by bridge", removeOnUninstall: true },
    { path: agentDir(p, "codex"), kind: "dir", role: "config", description: "codex login kept by bridge", removeOnUninstall: true },
  );
  for (const a of args.appPaths ?? []) {
    const own = (kind: ManifestKind, role: ManifestRole, file: string, what: string): ManifestEntry => ({
      path: file, kind, role, description: `${a.appId}: ${what}`, removeOnUninstall: true,
    });
    entries.push(
      own("dir", "config", a.configDir, "bridge config folder"),
      own("file", "config", a.appFile, "connection record"),
      own("file", "config", a.trustFile, "trusted browsers"),
      own("file", "config", a.identityFile, "runner identity (encrypted)"),
      own("file", "config", a.identityKeyFile, "identity wrapping key (only without the OS keychain)"),
      own("file", "config", a.enrollFile, "open enrollment window"),
      own("file", "config", a.revokedFile, "the relay refused this runner id for good"),
      own("file", "config", a.configFile, "per-app overrides of the machine defaults"),
      own("dir", "install", a.dataDir, "bridge data folder"),
      own("dir", "install", a.pluginsDir, "installed plugins"),
      own("dir", "install", a.pluginDataDir, "plugin data"),
      own("dir", "state", a.stateDir, "bridge state folder"),
      own("dir", "state", a.workDir, "agent sessions' working folder"),
      own("dir", "state", a.tmpDir, "agent session sandboxes"),
    );
  }
  if (args.includeService !== false) {
    entries.push({
      path: p.serviceFile,
      kind: "file",
      role: "service",
      description: args.platform === "linux" ? "systemd user unit" : "launchd agent plist",
      removeOnUninstall: true,
    });
    if (args.platform === "linux") {
      entries.push({
        path: path.join(path.dirname(p.serviceFile), "default.target.wants", p.serviceName),
        kind: "symlink",
        role: "service",
        description: "systemd enable symlink (created by systemctl --user enable)",
        removeOnUninstall: true,
      });
    }
  }
  return entries;
}

export function formatDoctorPaths(entries: readonly ManifestEntry[]): string {
  return entries.map((e) => `${e.path}\t${e.kind}\t${e.description}`).join("\n") + "\n";
}
