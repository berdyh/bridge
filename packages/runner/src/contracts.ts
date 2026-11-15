/**
 * Runner-local contracts: only things no sibling package owns. Wire shapes
 * (PROTOCOL_VERSION, the relay envelope) come from
 * `@berdyh/bridge-protocol` and CredentialStore from `@berdyh/bridge-pairing`;
 * do not redeclare them here.
 */

import path from "node:path";

import type { RunnerPaths } from "./paths.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs an external command to completion. Must reject only when the command
 * cannot be started at all (ENOENT, EACCES); a non-zero exit is a result. With `timeoutMs` a command still
 * running after that long is killed and the call rejects with an error whose `code` is "ETIMEDOUT".
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { stdin?: string; timeoutMs?: number; signal?: AbortSignal },
) => Promise<CommandResult>;

export type Platform = "linux" | "darwin";

// --- runner status file and per-app folders ----------------

/**
 * Where one app's connection stands. The same values as the CLI's `LinkStatus` (`cli/src/link.ts`);
 * declared here because the runner package cannot import the CLI.
 */
export type LinkStatus =
  | "connecting"
  | "online"
  | "reconnecting"
  | "update_required"
  | "replaced"
  | "revoked"
  | "auth_failed"
  | "stopped";

/**
 * `<state>/bridge/runner.json`: written by `bridge run`, read by `bridge status`, `bridge setup`
 * and the idle timer. Never holds secrets.
 */
export type RunnerStatusFile = {
  version: 1;
  /** The `bridge run` process. */
  pid: number;
  /** ISO 8601. */
  startedAt: string;
  /** Per app id: the link status, or `local` for a local app (no relay, so no link). */
  apps: Record<string, LinkStatus | "local">;
  /** Browsers connected right now, over all apps. */
  browsers: number;
  /** ISO 8601: since when no browser has been connected for any app. Absent while one is. */
  idleSince?: string;
};

/** What the path helpers need: `RunnerPaths.stateDir`, which is `<state>/bridge` for the app named `bridge`. */
type StateDirPaths = Pick<RunnerPaths, "stateDir">;

/** `<state>/bridge/runner.json`. */
export function runnerStatusPath(paths: StateDirPaths): string {
  return path.join(paths.stateDir, "runner.json");
}
