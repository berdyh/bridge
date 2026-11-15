import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, readlink, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { removeBound } from "@berdyh/bridge-runner";

/**
 * Consent plans: what a command shows before it asks, bound to what it then does.
 *
 * TRUST MODEL: a process running as the same user is a concurrency hazard, not an adversary; it
 * already owns ~/.config, ~/.local and the rest. The only guarantee is that the plan the user
 * consented to is the plan executed, or nothing is executed.
 *
 * RULE: consent binds a FULLY RESOLVED plan:
 *  - canonical paths: the realpath of the nearest existing ancestor plus the missing components
 *    appended lexically (`canonicalPath`). A missing `.` or `..` component is refused, and so is
 *    a dangling symlink in the way: it is never written through or created. The last component
 *    itself is not followed: a symlink that is a manifest entry stays a symlink (`kind`), and a
 *    writer that would follow one refuses it or resolves and discloses its target;
 *  - kinds (missing, file, dir, symlink and its target, other);
 *  - the contents (sha256) the step depends on.
 * The plan is computed before consent and recomputed after it (`assertUnchanged`); a step runs
 * only if the two are deep-equal, otherwise it refuses with CHANGED_WHILE_WAITING and mutates
 * nothing. Every mutation uses the canonical paths from the plan, never the lexical ones.
 * Whatever moves between the final recompute and the mutating syscall is the documented,
 * accepted TOCTOU window. Writes are a temp file plus rename(2) beside the canonical target, so
 * even inside that window a write replaces a symlink rather than following it.
 *
 * RULE A (base layout, fail closed): before the question, every base a manifest lives under
 * (data, config, state, bin, the service dir) and each top-level manifest dir is fully resolved,
 * its last component followed too. If two of them resolve to the same place, or one into the
 * other, where their paths do not (an aliased or overlapping layout), the whole command is
 * refused before consent: it names both paths, says it is an unusual layout that bridge will not
 * change automatically, lists what to remove by hand, and exits 1 with no mutation. A base or
 * manifest dir that is a symlink to somewhere apart stays supported: a manifest link is unlinked
 * as a leaf, and a real base is never deleted (containment checks use the fully resolved bases).
 *
 * RULE B (execution): the plan is recomputed exactly once after consent; if it differs, nothing
 * runs. Execution then uses the bound canonical paths and is NOT re-gated: whatever a same-uid
 * process does while npm, the service commands or the keychain run is the accepted window.
 * The one invariant that survives it: bridge never removes a path outside the consented layout.
 * Every removal (recursive or single, failure-path cleanup included) goes through `removeBound`,
 * which re-resolves the parent immediately before the syscall and requires it to equal the parent
 * of the bound canonical path; otherwise it refuses, stops the command and names what was left.
 * The resolve→rm pair and the traversal inside a recursive rm are themselves the accepted window.
 * A unit swapped during daemon-reload or recreated after the final reload is that window too.
 *
 * PER-APP DIRS (the apps' own folders): bridge owns only the `bridge/` segment of
 * `<config|data|state>/<app>`. `layout-rule.ts` applies Rule A to each connected app's three `bridge/` dirs
 * (against one another, other apps' and the machine-wide manifest dirs) and `LayoutSnapshot.apps` binds them,
 * so connect, `apps remove`, self install, service and uninstall all fail the Rule B recompute when one is
 * retargeted during the question. The parents (`<config>/<app>` and the other two) are not checked and not
 * bound as part of the layout: a symlinked parent is allowed, so a `bridge/` dir may
 * really live anywhere apart; each removal is bound by its canonical path, which follows that parent but never the
 * `bridge/` dir itself, and a parent is removed only when it is a real, empty folder (`removeBound` with
 * `emptyDirOnly`). A `bridge/` dir that is itself a symlink is refused at connect (`assertAppDirsReal`) and only
 * unlinked, never followed, by removals. The record never widens or narrows an app's path set: a listed id
 * whose record is absent is removed by its id's paths alone.
 *
 * PROTECTED DIRS (agent logins, `bridge agent login` and the setup login step): the agents' own
 * folders, `~/.claude`, `~/.codex`, `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME`, are never written. The
 * runner's `resolvedAgentOwnDirs` resolves them fully (last component and dangling links followed;
 * a loop or failure is unresolvable), and Rule A applies to bridge's agents folder and agent folder
 * against each: equal to, inside, or containing one (or one unresolvable) refuses the step before
 * consent, naming both paths and where they resolve. No carve-out for a deliberate alias. The
 * protected set's {path, real} pairs are part of the login plan, so a retarget during the question
 * fails the Rule B recompute. The runner applies the same check when it stages a login.
 */

export const CHANGED_WHILE_WAITING =
  "the files changed while waiting for confirmation, so the paths shown are out of date; nothing was changed, run the command again";

/** A plan that no longer matches what the user consented to. */
export class ChangedWhileWaiting extends Error {
  constructor(what?: string) {
    super(what === undefined ? CHANGED_WHILE_WAITING : `${what}: ${CHANGED_WHILE_WAITING}`);
    this.name = "ChangedWhileWaiting";
  }
}

/**
 * The canonical form of `file`: the realpath of its nearest existing ancestor (it must be a
 * directory) plus the missing components appended lexically, then the last component as named.
 * So a plan binds the real destination even when the parent does not exist yet, and a later
 * retarget of any ancestor symlink changes the plan. A missing `.` or `..` component, or a
 * dangling symlink in the way, is refused. Directories are created under this path, never the
 * lexical one. `file` is made absolute with path.resolve, which collapses `..` before any link is
 * followed; that is the same string every bridge path is built from (path.join of the config, data
 * and state dirs, in the CLI and the runner alike), so the bound path is where bridge's writes and
 * reads go. Protected dirs, which bridge never builds but must locate, use the runner's
 * `resolveProtectedDir` instead (kernel order: `..` after a link goes up from its target).
 */
export async function canonicalPath(file: string): Promise<string> {
  const abs = path.resolve(file);
  let existing = path.dirname(abs);
  if (existing === abs) return abs; // the root itself
  const missing: string[] = [];
  let real: string;
  for (;;) {
    try {
      real = await realpath(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (await lstat(existing).then(() => true, () => false)) {
      throw new Error(`${existing} is a dangling symlink; fix the link and run the command again`);
    }
    const name = path.basename(existing);
    const parent = path.dirname(existing);
    if (name === "." || name === ".." || parent === existing) {
      throw new Error(`${file} cannot be resolved (missing component ${JSON.stringify(name)}); refusing to touch it`);
    }
    missing.unshift(name);
    existing = parent;
  }
  if (!(await stat(real)).isDirectory()) throw new Error(`${existing} is not a directory; refusing to touch ${file}`);
  return path.join(real, ...missing, path.basename(abs));
}

export type PathKind = "missing" | "file" | "dir" | "symlink" | "other" | "unresolvable";

/** One path of a plan, as it is now. Plain data, so two snapshots compare with deep equality. */
export interface PathState {
  /** The path as the command names it. */
  path: string;
  /** Where it really is (`canonicalPath`); equal to `path` when it cannot be resolved. */
  canonical: string;
  /** `lstat` of the canonical path: a symlink is reported, never followed. */
  kind: PathKind;
  /** A symlink's own text. */
  link?: string;
  /** Where a symlink leads (its realpath), or null when it dangles. */
  target?: string | null;
  /** The sha256 of a regular file's bytes, when asked for. */
  sha256?: string;
  /** Why the path cannot be resolved (`unresolvable`) or read. */
  error?: string;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The state of one path. Never throws: a path that cannot be resolved is `unresolvable` with its reason. */
export async function pathState(file: string, options: { hash?: boolean } = {}): Promise<PathState> {
  let canonical: string;
  try {
    canonical = await canonicalPath(file);
  } catch (error) {
    return { path: file, canonical: file, kind: "unresolvable", error: (error as Error).message };
  }
  let info;
  try {
    info = await lstat(canonical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file, canonical, kind: "missing" };
    return { path: file, canonical, kind: "unresolvable", error: (error as Error).message };
  }
  if (info.isDirectory()) return { path: file, canonical, kind: "dir" };
  if (info.isSymbolicLink()) {
    const link = await readlink(canonical);
    const target = await realpath(canonical).catch(() => null);
    return { path: file, canonical, kind: "symlink", link, target };
  }
  if (!info.isFile()) return { path: file, canonical, kind: "other" };
  if (!options.hash) return { path: file, canonical, kind: "file" };
  try {
    return { path: file, canonical, kind: "file", sha256: sha256(await readFile(canonical)) };
  } catch (error) {
    return { path: file, canonical, kind: "file", error: (error as Error).message };
  }
}

export async function pathStates(files: readonly string[], options: { hash?: boolean } = {}): Promise<PathState[]> {
  const out: PathState[] = [];
  for (const f of files) out.push(await pathState(f, options));
  return out;
}

/**
 * The consent label of a path: the path, where it really is when that differs, and its kind
 * when it is a symlink or something unexpected.
 */
export function describePath(s: PathState): string {
  const where = s.canonical !== s.path ? ` (really ${s.canonical})` : "";
  // `target`: where the link resolves; null: it resolves nowhere (dangling); undefined: not read, so only the link's text is shown.
  if (s.kind === "symlink") return `${s.path}${where} [symlink to ${s.target ?? (s.target === null ? `${s.link}, dangling` : s.link)}; the link itself]`;
  if (s.kind === "other" || s.kind === "unresolvable") return `${s.path}${where} [${s.kind}${s.error ? `: ${s.error}` : ""}]`;
  return `${s.path}${where}`;
}

/** Throws `ChangedWhileWaiting` unless the plan recomputed after consent equals the consented one. */
export function assertUnchanged<T>(consented: T, now: T, what?: string): void {
  if (!isDeepStrictEqual(consented, now)) throw new ChangedWhileWaiting(what);
}

/**
 * Atomic write: a new temp file (`wx`) in the target's directory, then rename over the target.
 * The rename replaces whatever is at the target, a symlink included; it never writes through it.
 * The mode is the existing file's when there is one, else `mode`; with `exactMode` it is always `mode`
 * (private files: a looser mode left by someone else is not kept).
 */
export async function writeFileAtomically(target: string, data: string | Uint8Array, mode = 0o644, options: { exactMode?: boolean } = {}): Promise<void> {
  let keep = mode;
  try {
    const info = await lstat(target);
    if (info.isFile() && options.exactMode !== true) keep = info.mode & 0o777;
  } catch {
    // new file
  }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.bridge-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(temp, data, { mode: keep, flag: "wx" });
    await rename(temp, target);
  } catch (error) {
    await removeBound(temp, { force: true });
    throw error;
  }
}
