import { realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";

/** A removal `removeBound` refused: the path's folder no longer resolves where the plan bound it. */
export class RemoveRefused extends Error {
  /** The path that was left behind. */
  readonly leftBehind: string;
  constructor(target: string, detail: string) {
    super(`refused to remove ${target}: ${detail}; it was left behind, remove it by hand if it is still yours`);
    this.name = "RemoveRefused";
    this.leftBehind = target;
  }
}

/**
 * The one place install, uninstall and service removals delete a path (recursive or single,
 * failure-path cleanup included). `target` is a bound canonical path: its parent was fully
 * resolved when the plan was made. Immediately before the syscall the parent is resolved again
 * and must equal `dirname(target)`; otherwise nothing is removed and `RemoveRefused` names what
 * was left. `rm` lstat's the leaf and unlinks a symlink rather than descending into it, so the
 * parent check keeps every removal inside the consented layout. The resolve -> rm pair and the
 * traversal inside a recursive rm are the accepted window (see consent-plan.ts in the CLI).
 *
 * With `emptyDirOnly: true` it is `rmdir(2)` and resolves `true` when the directory was removed,
 * `false` when it is not empty (`ENOTEMPTY`, or `EEXIST` on some platforms); any other failure
 * throws as without it. Otherwise it resolves with nothing.
 */
export async function removeBound(target: string, opts: { emptyDirOnly: true }): Promise<boolean>;
export async function removeBound(target: string, opts?: { recursive?: boolean; force?: boolean; emptyDir?: boolean }): Promise<void>;
export async function removeBound(
  target: string,
  opts: { recursive?: boolean; force?: boolean; emptyDir?: boolean; emptyDirOnly?: boolean } = {},
): Promise<boolean | void> {
  if (!path.isAbsolute(target)) throw new RemoveRefused(target, "it is not an absolute path");
  const parent = path.dirname(target);
  if (parent === target) throw new RemoveRefused(target, "it is a filesystem root");
  let real: string;
  try {
    real = await realpath(parent);
  } catch (error) {
    // No parent, so no target: nothing to remove.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && opts.force) return;
    throw new RemoveRefused(target, `its folder ${parent} cannot be resolved (${(error as Error).message})`);
  }
  if (real !== parent) throw new RemoveRefused(target, `its folder ${parent} now resolves to ${real}`);
  if (opts.emptyDirOnly) {
    // `rmdir(2)` on a parent the app owns (`<config>/<app>`): it goes only when nothing is left in
    // it; a folder that still holds the app's own files is not an error, it is simply kept.
    try {
      await rmdir(target);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") return false;
      throw error;
    }
  }
  // `emptyDir`: an empty directory only (rmdir), e.g. a folder this run created and that must
  // not take anything someone put there since.
  if (opts.emptyDir) await rmdir(target);
  else await rm(target, { recursive: opts.recursive ?? false, force: opts.force ?? false });
}
