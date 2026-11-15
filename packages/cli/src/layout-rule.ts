import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { runnerPaths } from "@berdyh/bridge-runner";

import { type PathState, canonicalPath, pathState } from "./consent-plan.js";
import { readAppList } from "./config.js";
import { type CliDeps, homeOf, platformOf } from "./deps.js";
import { RUNNER_NAME, appPathsOf, baseDirsOf, launcherPathOf } from "./paths.js";
import { isInside } from "./self.js";

/**
 * Rule A of consent-plan.ts, shared by self install, service and uninstall: the bases the
 * manifest lives under and the top-level manifest dirs, fully resolved, may only overlap where
 * their paths do (the service dir inside the config dir). Two that resolve to the same place, or
 * one into the other, where their paths do not, is an aliased layout that bridge will not change
 * automatically. A symlink that leads somewhere apart is fine.
 *
 * The same rule covers each connected app's three `bridge/` dirs (`<config|data|state>/<app>/bridge`,
 * `appLayoutOf`): they may not resolve into one another, into another app's, or into a machine-wide
 * manifest dir, nor may one of those resolve into them, where their paths do not. The apps' parents
 * (`<config>/<app>` and the other two) are not checked and not compared with the bases: a symlinked
 * parent is allowed, so a `bridge/` dir may really live anywhere apart. What is
 * refused elsewhere is a `bridge/` dir that is itself a symlink (`assertAppDirsReal`): the runner's
 * store, plugin host and sandboxes refuse one, so a connect must not create a record it cannot use.
 */

/** Where `p` really is, its last component followed too; for a missing path, `canonicalPath`. */
export async function fullyResolved(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return canonicalPath(p).catch(() => path.resolve(p));
  }
}

export type Relation = "same" | "inside" | "contains" | "apart";

export function relation(a: string, b: string): Relation {
  if (path.resolve(a) === path.resolve(b)) return "same";
  if (isInside(b, a)) return "inside";
  if (isInside(a, b)) return "contains";
  return "apart";
}

/**
 * A path bridge may delete (uninstall, `apps remove`) is never a base dir (home, data, config, state, bin,
 * service dir) or above one, lexically or fully resolved.
 */
export async function assertNotABase(deps: CliDeps, ...paths: string[]): Promise<void> {
  const bases: string[] = [];
  for (const b of [homeOf(deps), ...baseDirList(deps)]) bases.push(b, await fullyResolved(b));
  for (const p of paths) {
    for (const b of bases) {
      if (path.resolve(p) === path.resolve(b) || isInside(p, b)) throw new Error(`refusing to remove ${p}: it is, or contains, ${b}`);
    }
  }
}

/** The base dirs the manifest lives under (home excluded: it holds the others by design). */
export function baseDirList(deps: CliDeps): string[] {
  const base = baseDirsOf(deps);
  const paths = runnerPaths({ app: RUNNER_NAME, platform: platformOf(deps), base });
  return [base.data, base.config, base.state, base.bin, path.dirname(paths.serviceFile)];
}

/** The top-level manifest dirs: `<data>/bridge`, `<config>/bridge`, `<state>/bridge`. */
function topDirs(deps: CliDeps): string[] {
  const paths = runnerPaths({ app: RUNNER_NAME, platform: platformOf(deps), base: baseDirsOf(deps) });
  return [paths.appDir, paths.configDir, paths.stateDir];
}

/** An app's three `bridge/` dirs, in `<config>`, `<data>`, `<state>` order. Derived from its `AppPaths`. */
export function appDirsOf(deps: CliDeps, appId: string): string[] {
  const p = appPathsOf(deps, appId);
  return [p.configDir, p.dataDir, p.stateDir];
}

export interface AppLayout {
  appId: string;
  /** The three `bridge/` dirs, fully resolved. */
  dirs: { path: string; real: string }[];
}

export interface Layout {
  /** The fully resolved base dirs, in `baseDirList` order (a plan binds them). */
  bases: string[];
  /** The connected apps' `bridge/` dirs, resolved. */
  apps: AppLayout[];
  /** The first aliased pair, each as "<path> (really <resolved>)". */
  overlap?: [string, string];
}

/** The ids of the connected apps, from `apps.json` alone (never an `app.json`), plus `extra` (an app about to be connected). */
async function appIdsOf(deps: CliDeps, extra: readonly string[]): Promise<{ ids: string[]; error?: string }> {
  const { listed, error } = await readAppList(deps);
  const ids = [...new Set([...listed.map((a) => a.appId), ...extra])];
  return { ids, ...(error !== undefined && { error }) };
}

async function resolveApps(deps: CliDeps, ids: readonly string[]): Promise<AppLayout[]> {
  return Promise.all(ids.map(async (appId) => ({ appId, dirs: await Promise.all(appDirsOf(deps, appId).map(async (p) => ({ path: p, real: await fullyResolved(p) }))) })));
}

/** One named dir with where it really is. */
export interface Named {
  path: string;
  real: string;
  kind: "base" | "top" | "app";
}

/**
 * The first pair that overlaps really where its paths do not. A base and an app dir are not
 * compared: an app dir is lexically inside its own base, and a symlinked app parent is allowed to
 * lead anywhere apart. An app dir is compared with the machine-wide manifest dirs and with every
 * other app dir; for those pairs an overlap of the paths themselves is refused too (two roots set to
 * one folder, an app's dir inside a manifest dir): nothing makes them overlap by design.
 */
export function firstOverlap(named: readonly Named[]): [string, string] | undefined {
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const a = named[i]!;
      const b = named[j]!;
      if ((a.kind === "base" && b.kind === "app") || (a.kind === "app" && b.kind === "base")) continue;
      const lexically = relation(a.path, b.path);
      if ((a.kind === "app" || b.kind === "app") && lexically !== "apart") return [`${a.path} (really ${a.real})`, `${b.path} (really ${b.real})`];
      const really = relation(a.real, b.real);
      if (really !== "apart" && really !== lexically) return [`${a.path} (really ${a.real})`, `${b.path} (really ${b.real})`];
    }
  }
  return undefined;
}

export async function layoutOf(deps: CliDeps, extraApps: readonly string[] = []): Promise<Layout> {
  const bases = baseDirList(deps);
  const baseNamed = [...bases, ...topDirs(deps)];
  const baseReal = await Promise.all(baseNamed.map(fullyResolved));
  const { ids } = await appIdsOf(deps, extraApps);
  const apps = await resolveApps(deps, ids);
  const named: Named[] = [
    ...baseNamed.map((p, i): Named => ({ path: p, real: baseReal[i]!, kind: i < bases.length ? "base" : "top" })),
    ...apps.flatMap((a) => a.dirs.map((d): Named => ({ ...d, kind: "app" }))),
  ];
  const overlap = firstOverlap(named);
  return { bases: baseReal.slice(0, bases.length), apps, ...(overlap !== undefined && { overlap }) };
}

/**
 * The resolved layout as one value for a consent plan: every base and top-level manifest dir
 * with where it fully resolves, each connected app's `bridge/` dirs (from `apps.json`; an
 * unreadable one is an empty list and its error is part of the value), and the launcher (the
 * service's ExecStart) with its canonical path and kind. Self install, service, uninstall, connect
 * and `apps remove` all bind it, so an alias or a retargeted dir made during the question fails
 * their one post-consent recompute.
 */
export interface LayoutSnapshot {
  dirs: { path: string; real: string }[];
  apps: AppLayout[];
  /** Why `apps.json` could not be read; absent when it could. */
  appsError?: string;
  launcher: PathState;
}

export async function layoutSnapshot(deps: CliDeps, extraApps: readonly string[] = []): Promise<LayoutSnapshot> {
  const named = [...baseDirList(deps), ...topDirs(deps)];
  const launcher = launcherPathOf(deps);
  const { ids, error } = await appIdsOf(deps, extraApps);
  return {
    dirs: await Promise.all(named.map(async (p) => ({ path: p, real: await fullyResolved(p) }))),
    apps: await resolveApps(deps, ids),
    ...(error !== undefined && { appsError: error }),
    launcher: await pathState(launcher),
  };
}

/** The refusal for an aliased layout; `what` is the action ("install into", "remove"). */
export function aliasedLayoutMessage(overlap: [string, string], what: string): string {
  return `${overlap[0]} and ${overlap[1]} overlap: this is an unusual layout that bridge will not ${what} automatically; nothing was changed`;
}

/** Throws the rule A refusal when the layout is aliased; returns the layout otherwise. */
export async function assertLayout(deps: CliDeps, what: string, extraApps: readonly string[] = []): Promise<Layout> {
  const layout = await layoutOf(deps, extraApps);
  if (layout.overlap !== undefined) throw new Error(aliasedLayoutMessage(layout.overlap, what));
  return layout;
}

/**
 * Refuses an app whose `bridge/` dir exists and is not a real folder (a symlink, even one that
 * leads somewhere apart, or a file): the runner would refuse to use it, and writing there would
 * land somewhere the consent did not show. A missing dir is fine (it is created).
 */
export async function assertAppDirsReal(deps: CliDeps, appId: string): Promise<void> {
  for (const dir of appDirsOf(deps, appId)) {
    const info = await lstat(dir).then((i) => i, () => undefined);
    if (info !== undefined && !info.isDirectory()) {
      throw new Error(`${dir} is not a real folder (${info.isSymbolicLink() ? "a symlink" : "not a folder"}); bridge keeps ${appId}'s files in folders of its own and will not use it. Remove it and run the command again; nothing was changed`);
    }
  }
}
