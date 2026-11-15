import path from "node:path";

import { escapeControlChars } from "@berdyh/bridge-protocol";

import type { Platform } from "./contracts.js";

/** Base directories every path below is derived from. All injectable. */
export interface BaseDirs {
  home: string;
  /** XDG_DATA_HOME equivalent, e.g. ~/.local/share */
  data: string;
  /** XDG_CONFIG_HOME equivalent, e.g. ~/.config */
  config: string;
  /** XDG_STATE_HOME equivalent, e.g. ~/.local/state */
  state: string;
  /** Directory holding the launcher link, e.g. ~/.local/bin */
  bin: string;
}

/** Standard XDG-style bases for a home directory (pure; reads only `env`). */
export function defaultBaseDirs(
  home: string,
  env: Record<string, string | undefined> = {},
): BaseDirs {
  return {
    home,
    data: env.XDG_DATA_HOME || path.join(home, ".local", "share"),
    config: env.XDG_CONFIG_HOME || path.join(home, ".config"),
    state: env.XDG_STATE_HOME || path.join(home, ".local", "state"),
    bin: path.join(home, ".local", "bin"),
  };
}

export interface RunnerPaths {
  /** <data>/<app> */
  appDir: string;
  /** <data>/<app>/versions */
  versionsDir: string;
  /** Launcher symlink/script: <bin>/<app> */
  launcherLink: string;
  /** <config>/<app> */
  configDir: string;
  /** <state>/<app> */
  stateDir: string;
  logFile: string;
  /** systemd unit or launchd plist. */
  serviceFile: string;
  /** systemd unit name or launchd label. */
  serviceName: string;
  /** `<config>/<app>/agents`: the agent logins bridge keeps (`bridge agent login`). */
  agentsDir: string;
}

/** The agents whose login bridge keeps under `agentsDir`. */
export type AgentLoginName = "claude" | "codex";

/** `<config>/<app>/agents/<agent>`: one agent's login folder. */
export function agentDir(paths: Pick<RunnerPaths, "agentsDir">, agent: AgentLoginName): string {
  if (agent !== "claude" && agent !== "codex") throw new Error(`invalid agent: ${escapeControlChars(JSON.stringify(agent))}`);
  return path.join(paths.agentsDir, agent);
}

export function runnerPaths(args: { app: string; platform: Platform; base: BaseDirs }): RunnerPaths {
  const { app, platform, base } = args;
  assertAppName(app);
  const appDir = path.join(base.data, app);
  const stateDir = path.join(base.state, app);
  const serviceName = platform === "linux" ? `${app}-runner.service` : `com.berdyh.${app}.runner`;
  return {
    appDir,
    versionsDir: path.join(appDir, "versions"),
    launcherLink: path.join(base.bin, app),
    configDir: path.join(base.config, app),
    stateDir,
    logFile: path.join(stateDir, "runner.log"),
    serviceFile:
      platform === "linux"
        ? path.join(base.config, "systemd", "user", serviceName)
        : path.join(base.home, "Library", "LaunchAgents", `${serviceName}.plist`),
    serviceName,
    agentsDir: path.join(base.config, app, "agents"),
  };
}

/** App names become path segments and unit names: keep them boring. */
export function assertAppName(app: string): void {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(app)) {
    throw new Error(`invalid app name: ${escapeControlChars(JSON.stringify(app))}`);
  }
}

/** App ids that cannot be an app's folder name: `bridge` is the machine-wide folder. */
export const RESERVED_APP_NAMES: readonly string[] = ["bridge"];

/** `^[a-z][a-z0-9-]{0,62}$` (the `assertAppName` rule) and not a reserved name. */
export function isAppFolderName(id: string): boolean {
  return typeof id === "string" && /^[a-z][a-z0-9-]{0,62}$/.test(id) && !RESERVED_APP_NAMES.includes(id);
}

/** Throws a readable error naming the rule when `id` cannot be an app's folder name. */
export function assertAppFolderName(id: string): void {
  if (!isAppFolderName(id)) {
    throw new Error(
      `invalid app folder name: ${escapeControlChars(JSON.stringify(id))} (use lowercase letters, digits and "-", starting with a letter, at most 63 characters; ${RESERVED_APP_NAMES.map((n) => JSON.stringify(n)).join(", ")} is reserved)`,
    );
  }
}

/**
 * Every path of one app, derived from one id. bridge owns only the `bridge/` segment inside the
 * app's own XDG folders; the three `parents` are the app's and are never removed unless empty.
 * The only way to obtain one is `appPathsOf`, so no function can reach another app's folder
 * from this app's paths.
 */
export interface AppPaths {
  /** The app these paths belong to; consumers check it against the app they act for. */
  readonly appId: string;
  /** `<config>/<app>/bridge` */
  readonly configDir: string;
  /** `<configDir>/app.json`: the connection record. */
  readonly appFile: string;
  readonly trustFile: string;
  readonly identityFile: string;
  /** Only when the keychain does not hold the identity's wrapping key. */
  readonly identityKeyFile: string;
  readonly enrollFile: string;
  /** `<configDir>/revoked.json`: written once by the runner when the relay itself said this runner id is revoked; read by connect/setup. */
  readonly revokedFile: string;
  /** Per-app overrides of the machine defaults. */
  readonly configFile: string;
  /** `<data>/<app>/bridge` */
  readonly dataDir: string;
  /** `<dataDir>/plugins` */
  readonly pluginsDir: string;
  /** `<dataDir>/plugin-data` */
  readonly pluginDataDir: string;
  /** `<state>/<app>/bridge` */
  readonly stateDir: string;
  /** `<stateDir>/work`: the default folder of agent sessions. */
  readonly workDir: string;
  /** `<stateDir>/tmp`: the parent of per-session sandboxes. */
  readonly tmpDir: string;
  /** `<stateDir>/audit`: one append-only tool-call log per plugin (written by the audit log). */
  readonly auditDir: string;
  /**
   * `<configDir>/plugins`: the consent records, one per installed plugin. Not the plugin packages:
   * those are in `pluginsDir`, under `<data>/<app>/bridge/plugins`.
   */
  readonly consentDir: string;
  /**
   * `<stateDir>/sessions`: one empty private folder per contained session, `<sessionsDir>/<session id>`,
   * chosen by the runner. It is a sibling of `workDir`, never inside it: `allowSession` admits any cwd
   * inside `workDir`, so a folder under it would let a browser start a session in (or write into) a
   * contained session's cwd and plant `.mcp.json`, `.claude/settings.json` or `CLAUDE.md` there. As a
   * sibling it is inside the protected state folder and outside the work carve-out, so `allowSession`
   * refuses it by construction. No browser or plugin value ever names this folder; only the runner
   * builds `<sessionsDir>/<id>` from the session id it minted.
   */
  readonly sessionsDir: string;
  /**
   * The folder in which a contained session's secret file lives
   * (`<secretsParent>/bridge-acp-secrets-<session id>/<server>`). The same directory as `tmpDir`:
   * one directory, two names, so the adapter and the containment code share it. It is outside every
   * env-named directory because `$TMPDIR` of a session is its sandbox, a child of this folder.
   *
   * What this protects, and what it does not: the secret at
   * rest is private at the **uid** level only. The files are 0600 in a 0700 folder, but every agent session
   * of the app runs as the same user, so another session's agent with a shell tool (a non-contained
   * session's Bash) can list this folder and read the file, as it can read `identity.key` and the agent's
   * own login. No path here changes that. What holds is that the secret is never in an env entry, an argv, a
   * frame or a log, and the file name carries the session id, which is therefore never a bearer of anything.
   * A stronger delivery, not implemented here, would have the runner spawn the server itself and hand the
   * agent a stdio shim over a per-session socket.
   */
  readonly secretsParent: string;
  /** The three folders bridge does not own: `<config>/<app>`, `<data>/<app>`, `<state>/<app>`. */
  readonly parents: { readonly config: string; readonly data: string; readonly state: string };
}

export function appPathsOf(base: Pick<BaseDirs, "config" | "data" | "state">, appId: string): AppPaths {
  assertAppFolderName(appId);
  const parents = Object.freeze({
    config: path.join(base.config, appId),
    data: path.join(base.data, appId),
    state: path.join(base.state, appId),
  });
  const configDir = path.join(parents.config, "bridge");
  const dataDir = path.join(parents.data, "bridge");
  const stateDir = path.join(parents.state, "bridge");
  return Object.freeze({
    appId,
    configDir,
    appFile: path.join(configDir, "app.json"),
    trustFile: path.join(configDir, "trust.json"),
    identityFile: path.join(configDir, "identity.json"),
    identityKeyFile: path.join(configDir, "identity.key"),
    enrollFile: path.join(configDir, "enroll.json"),
    revokedFile: path.join(configDir, "revoked.json"),
    configFile: path.join(configDir, "config.json"),
    dataDir,
    pluginsDir: path.join(dataDir, "plugins"),
    pluginDataDir: path.join(dataDir, "plugin-data"),
    stateDir,
    workDir: path.join(stateDir, "work"),
    tmpDir: path.join(stateDir, "tmp"),
    auditDir: path.join(stateDir, "audit"),
    consentDir: path.join(configDir, "plugins"),
    sessionsDir: path.join(stateDir, "sessions"),
    secretsParent: path.join(stateDir, "tmp"),
    parents,
  });
}
