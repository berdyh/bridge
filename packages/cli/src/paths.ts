import path from "node:path";

import { appPathsOf as runnerAppPathsOf, runnerPaths, type AppPaths, type BaseDirs, type RunnerPaths } from "@berdyh/bridge-runner";

import { type CliDeps, homeOf, platformOf } from "./deps.js";

/** The app name of the one runner of this machine: it names its dirs, launcher and service. */
export const RUNNER_NAME = "bridge";

export function baseDirsOf(deps: CliDeps): BaseDirs {
  const home = homeOf(deps);
  return {
    home,
    data: deps.dataDir,
    config: deps.configDir,
    state: deps.env.XDG_STATE_HOME || path.join(home, ".local", "state"),
    bin: deps.launcher ? path.dirname(deps.launcher) : path.join(home, ".local", "bin"),
  };
}

/** The one launcher path: `deps.launcher` verbatim, else `<bin>/bridge`. Self install, service, handler, doctor and uninstall all use it. */
export function launcherPathOf(deps: CliDeps): string {
  return deps.launcher ?? path.join(baseDirsOf(deps).bin, RUNNER_NAME);
}

/** The second command name: the same program under a name nothing else uses (`bridge` collides with iproute2's on Linux). */
export const RUNNER_ALIAS = "bridge-runner";

/** The alias link: `<launcher's folder>/bridge-runner`, written by `self install` to the same target as the launcher. */
export function aliasLauncherPathOf(deps: CliDeps): string {
  return path.join(path.dirname(launcherPathOf(deps)), RUNNER_ALIAS);
}

/** The one runner's machine-wide paths (`<data|config|state>/bridge`, with `runner.json`, `agents/` and the service files). */
export function runnerPathsOf(deps: CliDeps): RunnerPaths {
  return runnerPaths({ app: RUNNER_NAME, platform: platformOf(deps), base: baseDirsOf(deps) });
}

/** `<data>/bridge/adapters`: agent adapters bridge installed itself (`bridge agent install`), one folder per agent and version. Not under `versions/`, which is scanned for bridge releases. */
export function adaptersDirOf(deps: CliDeps): string {
  return path.join(runnerPathsOf(deps).appDir, "adapters");
}

/**
 * Every path of one app, from its id: `<config|data|state>/<app>/bridge/...`. The only place the
 * CLI joins an app id to a base dir (`appPathsOf`); every per-app function takes the result.
 */
export function appPathsOf(deps: CliDeps, appId: string): AppPaths {
  return runnerAppPathsOf(baseDirsOf(deps), appId);
}

/** The lock file name of the machine-wide runner and of one app's worker (same algorithm, `runner-lock.ts`). */
export const RUNNER_LOCK_FILE = "runner.lock";
export const WORKER_LOCK_FILE = "worker.lock";

/** `<state>/bridge/runner.lock`: one `bridge run` per machine. Inside the runner's state folder, so uninstall removes it with the folder. */
export function runnerLockPath(deps: CliDeps): string {
  return path.join(runnerPathsOf(deps).stateDir, RUNNER_LOCK_FILE);
}

/** `<state>/<app>/bridge/worker.lock`: one worker per app. Inside that app's `bridge/` state folder, so `apps remove` removes it with the folder; no `AppPaths` member names it. */
export function workerLockPath(appPaths: Pick<AppPaths, "stateDir">): string {
  return path.join(appPaths.stateDir, WORKER_LOCK_FILE);
}

/** `<config>/bridge/agents/<agent>`: bridge's own copy of one agent's config dir. */
export function agentDirOf(deps: CliDeps, agent: "claude" | "codex"): string {
  return path.join(runnerPathsOf(deps).agentsDir, agent);
}
