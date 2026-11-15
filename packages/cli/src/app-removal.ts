import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { removeBound } from "@berdyh/bridge-runner";

import type { PathState } from "./consent-plan.js";
import type { CliDeps } from "./deps.js";
import { assertNotABase } from "./layout-rule.js";

/** The record that lists an app's folders: removed last, so a retry after any failure still finds the app. */
const RECORD = "app.json";

/** One app's folders as its consent plan bound them. */
export interface AppFolders {
  appId: string;
  /** The three `bridge/` dirs; `config` is absent when the plan keeps it (a broken record). */
  config?: PathState;
  data: PathState;
  state: PathState;
  /** The three parents (`<config|data|state>/<app>`), removed only when real and empty. */
  parents: { config: PathState; data: PathState; state: PathState };
}

/**
 * Removes one app's folders in the order that keeps a retry possible: an index entry goes only after
 * everything it lists is gone. The data and state `bridge/` dirs and their parents (when empty) first,
 * then everything in the config `bridge/` dir but `app.json`, then `app.json`, then that dir and its
 * parent. Any failure throws before `app.json` is touched, so the app is still recorded and a second run
 * finds it. Every removal is a bound canonical path through `removeBound`; a `bridge/` dir that is a link
 * is unlinked as a leaf, never followed. Returns the parents that were left (not empty, or a link).
 */
export async function removeAppFolders(deps: CliDeps, app: AppFolders, removed: (shown: string) => void): Promise<string[]> {
  const left: string[] = [];
  const removeDir = async (s: PathState): Promise<void> => {
    if (s.kind === "missing") return;
    if (s.kind === "unresolvable") throw new Error(`${s.path} cannot be resolved (${s.error}); left alone`);
    await assertNotABase(deps, s.path, s.canonical);
    await removeBound(s.canonical, { recursive: true, force: true });
    removed(s.path);
  };
  const removeParent = async (s: PathState): Promise<void> => {
    // Only a real, empty folder goes. A link is the app's own and stays; so does anything that holds other files.
    if (s.kind !== "dir") {
      if (s.kind !== "missing") left.push(`${s.path} (${s.kind === "symlink" ? "a symlink, left alone" : s.kind})`);
      return;
    }
    await assertNotABase(deps, s.path, s.canonical);
    if (await removeBound(s.canonical, { emptyDirOnly: true })) removed(s.path);
    else left.push(`${s.path} (it holds other files)`);
  };

  await removeDir(app.data);
  await removeDir(app.state);
  await removeParent(app.parents.data);
  await removeParent(app.parents.state);
  const config = app.config;
  if (config === undefined) return left;
  // A dir bound by the plan that is now something else (a link put there meanwhile) is removed as a leaf, never listed.
  const now = config.kind === "dir" ? await lstat(config.canonical).catch(() => undefined) : undefined;
  if (now?.isDirectory()) {
    await assertNotABase(deps, config.path, config.canonical);
    // Everything but the record, then the record, then the (now empty) dir.
    for (const name of (await readdir(config.canonical)).sort()) {
      if (name === RECORD) continue;
      await removeBound(path.join(config.canonical, name), { recursive: true, force: true });
    }
    await removeBound(path.join(config.canonical, RECORD), { force: true });
    await removeBound(config.canonical, { emptyDir: true });
    removed(config.path);
  } else {
    await removeDir(config);
  }
  await removeParent(app.parents.config);
  return left;
}
