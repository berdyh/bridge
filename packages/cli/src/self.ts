import { randomBytes } from "node:crypto";
import { access, constants as fsConstants } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ENTRY_FILE,
  applyUpdatePlan,
  listValidVersions,
  parseSemver,
  removeBound,
  runnerPaths,
  versionDir,
  type DownloadPlan,
  type RunnerPaths,
  type UpdateFs,
} from "@berdyh/bridge-runner";

import { parse } from "./args.js";
import { printable } from "./config.js";
import { type LayoutSnapshot, assertLayout, layoutSnapshot } from "./layout-rule.js";
import { type PathState, assertUnchanged, describePath, pathStates, sha256 } from "./consent-plan.js";
import { type CliDeps, UsageError, errorMessage, platformOf, runnerOf } from "./deps.js";
import { assertNoLegacyLayout } from "./legacy.js";
import { RUNNER_ALIAS, RUNNER_NAME, aliasLauncherPathOf, baseDirsOf, launcherPathOf } from "./paths.js";
import { CLI_VERSION } from "./version.js";

/** The npm package the runner is installed from. */
export const BRIDGE_PACKAGE = "@berdyh/bridge";

/**
 * The release base, as `install.sh` reads it: the tarball set of a version is at `<base>/<version>/`.
 * A `file://` base is installed from (tests, an offline install); any other is install.sh's to download from.
 */
export const INSTALL_BASE_ENV = "BRIDGE_INSTALL_BASE";

const SUMS_FILE = "SHA256SUMS";
/** `pnpm pack` names `@berdyh/bridge` `berdyh-bridge-<version>.tgz` (the other packages have a name after `bridge-`). */
const BRIDGE_TARBALL = /^berdyh-bridge-(\d+\.\d+\.\d+[A-Za-z0-9.+-]*)\.tgz$/;
const TARBALL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/;
/** The runner's production closure (`@berdyh/<name>`): what a tarball set installs, the same five as install.sh. */
export const RUNNER_PACKAGES = ["bridge", "bridge-crypto", "bridge-pairing", "bridge-protocol", "bridge-runner"] as const;
const runnerTarball = (name: string, version: string): string => `berdyh-${name}-${version}.tgz`;

export const nodeFs: UpdateFs = {
  mkdir: (dir, opts) => mkdir(dir, opts),
  rename: (from, to) => rename(from, to),
  rm: (p, opts) => removeBound(p, opts),
  stat: (p) => stat(p),
};

export function installPathsOf(deps: CliDeps): RunnerPaths {
  return { ...runnerPaths({ app: RUNNER_NAME, platform: platformOf(deps), base: baseDirsOf(deps) }), launcherLink: launcherPathOf(deps) };
}

/** Whether `child` is strictly inside `parent` (lexically; both are resolved first). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// --- the launcher link -----------------------------------------------------------------------

export type LauncherState =
  | { kind: "missing" }
  /** A symlink that points into our versions dir. `dangling`: its target no longer exists. */
  | { kind: "ours"; target: string; version: string; dangling: boolean }
  /** Anything else at the launcher path: a file, a directory, a symlink to somewhere else. */
  | { kind: "foreign"; detail: string };

/** The state of one launcher link: `bridge` by default, or the alias (`aliasLauncherPathOf`). */
export async function launcherStateOf(deps: CliDeps, link: string = launcherPathOf(deps)): Promise<LauncherState> {
  const paths = installPathsOf(deps);
  let info;
  try {
    info = await lstat(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  if (!info.isSymbolicLink()) return { kind: "foreign", detail: "it is not a symlink" };
  const target = path.resolve(path.dirname(link), await readlink(link));
  if (!isInside(paths.versionsDir, target)) return { kind: "foreign", detail: `it points to ${target}, outside ${paths.versionsDir}` };
  const version = path.relative(paths.versionsDir, target).split(path.sep)[0]!;
  const alive = await stat(target).then(() => true, () => false);
  return { kind: "ours", target, version, dangling: !alive };
}

/** Both launcher links, `bridge` first: what `self install` writes and `uninstall` removes. */
export function launcherLinksOf(deps: CliDeps): string[] {
  return [launcherPathOf(deps), aliasLauncherPathOf(deps)];
}

/** Whether a launcher link is ours, alive and points at `entry`. */
const linkIsCurrent = (state: LauncherState, entry: string): boolean => state.kind === "ours" && state.target === entry && !state.dangling;

/**
 * Whether both links (`bridge` and `bridge-runner`) are ours, alive, and point into the version dir of `version`.
 * One-click setup uses it to tell an install that is complete from one that still has to write a link.
 */
export async function launchersCurrentFor(deps: CliDeps, version: string): Promise<boolean> {
  for (const link of launcherLinksOf(deps)) {
    const state = await launcherStateOf(deps, link);
    if (state.kind !== "ours" || state.dangling || state.version !== version) return false;
  }
  return true;
}

// --- the launcher on PATH --------------------------------------------------------------------

/**
 * The first executable named `bridge` on `PATH`, as `command -v bridge` finds it. A relative entry resolves against the
 * current directory and an empty entry (leading, trailing or `::`) is the current directory; the result is absolute.
 */
async function firstOnPath(env: CliDeps["env"]): Promise<string | undefined> {
  if (env.PATH === undefined) return undefined;
  for (const dir of env.PATH.split(":")) {
    const candidate = path.join(path.resolve(process.cwd(), dir || "."), RUNNER_NAME);
    const runnable = await stat(candidate).then(
      (info) => info.isFile() && new Promise<boolean>((resolve) => access(candidate, fsConstants.X_OK, (error) => resolve(error === null))),
      () => false,
    );
    if (runnable) return candidate;
  }
  return undefined;
}

/** Whether two paths name the same file: the same text, or the same real file (a linked bin dir, a launcher link and its target). */
async function sameFile(a: string, b: string): Promise<boolean> {
  if (path.resolve(a) === path.resolve(b)) return true;
  const [realA, realB] = await Promise.all([realpath(a).catch(() => undefined), realpath(b).catch(() => undefined)]);
  return realA !== undefined && realA === realB;
}

const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * The warning for a `bridge` on `PATH` that is not the launcher, or undefined when the launcher is the first one (or none
 * is found: nothing shadows it, and a missing launcher is reported on its own). On Linux the usual cause is iproute2's
 * `/usr/bin/bridge` ahead of `~/.local/bin`; it runs whatever an app hands it and fails, so a PATH lookup says nothing
 * about whether the runner is installed. Reads only; checked against `deps.env.PATH`, the way a shell started the same way would.
 */
export async function pathWarningOf(deps: CliDeps): Promise<string | undefined> {
  const found = await firstOnPath(deps.env);
  const launcher = launcherPathOf(deps);
  if (found === undefined || (await sameFile(found, launcher))) return undefined;
  const dir = path.dirname(launcher);
  const iproute2 = /^\/(usr\/)?s?bin\/bridge$/.test(found) ? " (on Linux that is iproute2's network tool, which fails every bridge command)" : "";
  return (
    `WARNING: \`bridge\` on your PATH is not the bridge launcher. \`command -v bridge\` finds ${printable(found)}${iproute2} first; ` +
    `the launcher is ${printable(launcher)}. Apps and scripts that run \`bridge\` would run the wrong program. ` +
    `Fix: put ${printable(dir)} before ${printable(path.dirname(found))} in PATH (in your shell profile: export PATH=${shellQuote(printable(dir))}:"$PATH"), or run the launcher by its full path. ` +
    `\`${RUNNER_ALIAS}\` is the same program under a name nothing else uses: apps and scripts can run that instead.`
  );
}

// --- the plan --------------------------------------------------------------------------------

export interface SelfInstallPlan {
  version: string;
  /** `<data>/bridge/versions/<version>` */
  versionDir: string;
  /** The launcher target: the version dir's entry file. */
  entry: string;
  launcherLink: string;
  /** The second link, `bridge-runner`, to the same entry. */
  aliasLink: string;
  /** Folders the install creates when they are missing (the launcher's folder, the app's data folders). */
  dirs: string[];
  source: { kind: "registry"; spec: string } | { kind: "tarballs"; dir: string };
  /**
   * The command the install runs, with `<staging>` standing for the staging folder. With a tarball
   * set it names no spec: `<staging>/package.json` lists the verified tarballs (`stagingManifest`).
   */
  command: string[];
  /** The paths the install writes, for the consent: the version dir and the two launcher links. */
  paths: string[];
}

export interface SelfInstallOptions {
  /** Default: this CLI's version. */
  version?: string;
  /** A directory holding the release tarball set and `SHA256SUMS`. */
  from?: string;
}

/** `npm install --prefix <prefix> --ignore-scripts [<specs>]`: one invocation, every spec in it (none: the prefix's package.json). */
export function npmInstallArgs(prefix: string, specs: readonly string[] = []): string[] {
  return ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", ...specs];
}

/** Pure: what `bridge self install` would do for these options. Reads nothing and writes nothing. */
export function selfInstallPlan(deps: CliDeps, options: SelfInstallOptions = {}): SelfInstallPlan {
  const version = options.version ?? CLI_VERSION;
  if (!parseSemver(version)) throw new UsageError(`not a version: ${JSON.stringify(version)}`);
  const paths = installPathsOf(deps);
  const dir = versionDir(paths.versionsDir, version);
  const source = options.from === undefined
    ? ({ kind: "registry", spec: `${BRIDGE_PACKAGE}@${version}` } as const)
    : ({ kind: "tarballs", dir: path.resolve(options.from) } as const);
  const staging = path.join(paths.versionsDir, `.staging-${version}-<random>`);
  return {
    version,
    versionDir: dir,
    entry: path.join(dir, DEFAULT_ENTRY_FILE),
    launcherLink: paths.launcherLink,
    aliasLink: aliasLauncherPathOf(deps),
    dirs: [paths.appDir, paths.versionsDir, path.dirname(paths.launcherLink)],
    source,
    command: ["npm", ...npmInstallArgs(staging.replace(/<random>$/, "<staging>"), source.kind === "registry" ? [source.spec] : [])],
    paths: [dir, paths.launcherLink, aliasLauncherPathOf(deps)],
  };
}

// --- the verified tarball set ----------------------------------------------------------------

export interface TarballSet {
  dir: string;
  /** Absolute paths of the runner closure's tarballs (`RUNNER_PACKAGES`), sorted by name. */
  files: string[];
  /** Each file's sha256 from `SHA256SUMS` (checked once already), by absolute path. */
  sums: Record<string, string>;
  /** The version of the `@berdyh/bridge` tarball in the set. */
  version: string;
}

async function regularFile(file: string, what: string): Promise<void> {
  const info = await lstat(file).catch(() => undefined);
  if (info === undefined) throw new Error(`${what} is missing`);
  if (!info.isFile()) throw new Error(`${what} is not a regular file (a symlink or other); refusing to use it`);
}

function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error(`${SUMS_FILE}: unreadable line: ${JSON.stringify(line.slice(0, 80))}`);
    const name = m[2]!;
    if (!TARBALL_NAME.test(name)) throw new Error(`${SUMS_FILE}: not a plain tarball name: ${JSON.stringify(name.slice(0, 80))}`);
    if (sums.has(name)) throw new Error(`${SUMS_FILE}: ${name} is listed twice`);
    sums.set(name, m[1]!);
  }
  return sums;
}

/**
 * Reads a release tarball set and checks it against its `SHA256SUMS`. Refuses a symlink, a
 * listed tarball that is missing or whose hash differs, a `.tgz` in the folder that the sums do
 * not list, and a set without every tarball of the runner closure. Other listed tarballs (the
 * server SDKs of a full release) are checked but not installed. Reads only.
 */
export async function readTarballSet(dir: string): Promise<TarballSet> {
  const root = path.resolve(dir);
  if (!(await lstat(root).then((i) => i.isDirectory(), () => false))) throw new Error(`${root} is not a directory`);
  await regularFile(path.join(root, SUMS_FILE), `${root}/${SUMS_FILE}`);
  const sums = parseSums(await readFile(path.join(root, SUMS_FILE), "utf8"));
  if (sums.size === 0) throw new Error(`${SUMS_FILE} lists no tarballs`);
  for (const name of await readdir(root)) {
    if (name.endsWith(".tgz") && !sums.has(name)) throw new Error(`${name} is not listed in ${SUMS_FILE}; refusing the set`);
  }
  const files: string[] = [];
  const verified: Record<string, string> = {};
  for (const [name, expected] of [...sums].sort(([a], [b]) => a.localeCompare(b))) {
    const file = path.join(root, name);
    await regularFile(file, `${file}`);
    const actual = sha256(await readFile(file));
    if (actual !== expected) throw new Error(`${name}: checksum mismatch (expected ${expected}, got ${actual})`);
    files.push(file);
    verified[file] = expected;
  }
  const bridges = files.map((f) => BRIDGE_TARBALL.exec(path.basename(f))?.[1]).filter((v): v is string => v !== undefined);
  if (bridges.length !== 1) throw new Error(`the set must hold exactly one ${BRIDGE_PACKAGE} tarball (berdyh-bridge-<version>.tgz), found ${bridges.length}`);
  const version = bridges[0]!;
  const closure = RUNNER_PACKAGES.map((name) => path.join(root, runnerTarball(name, version)));
  const missing = closure.filter((f) => !files.includes(f));
  if (missing.length > 0) {
    throw new Error(`the set lacks ${missing.map((f) => path.basename(f)).join(", ")}; the runner needs ${RUNNER_PACKAGES.map((n) => `@berdyh/${n}`).join(", ")}`);
  }
  const runner = files.filter((f) => closure.includes(f));
  return { dir: root, files: runner, sums: Object.fromEntries(runner.map((f) => [f, verified[f]!])), version };
}

/**
 * `<staging>/package.json` for a tarball set: every runner tarball as a `file:` dependency and as
 * an override. npm then resolves the `@berdyh/*` edges between them from these files; tarballs
 * named on the command line would still make it ask the registry for those (unpublished) packages.
 */
export function stagingManifest(files: readonly string[], version: string): string {
  const deps: Record<string, string> = {};
  for (const name of RUNNER_PACKAGES) {
    const file = files.find((f) => path.basename(f) === runnerTarball(name, version));
    if (file === undefined) throw new Error(`${runnerTarball(name, version)} is missing from the set`);
    deps[`@berdyh/${name}`] = `file:${path.resolve(file)}`;
  }
  return `${JSON.stringify({ private: true, dependencies: deps, overrides: deps }, null, 2)}\n`;
}

/**
 * The tarball set of `version` under `BRIDGE_INSTALL_BASE` when that is a `file://` URL:
 * `<base>/<version>/`, the layout `install.sh` reads (`<base>/<version>/<artifact>`). Any other value is not
 * ours to download from (`install.sh` does that and then runs this command), so it is ignored
 * and `ignored` carries it: the install then uses the registry.
 */
export function installBaseDir(deps: CliDeps, version: string): { dir?: string; ignored?: string } {
  const base = deps.env[INSTALL_BASE_ENV];
  if (base === undefined || base === "") return {};
  try {
    const url = new URL(base);
    if (url.protocol === "file:") return { dir: path.join(fileURLToPath(url), version) };
  } catch {
    // not a URL: ignored below
  }
  return { ignored: base };
}

// --- the install -----------------------------------------------------------------------------

export interface SelfInstallRun extends SelfInstallOptions {
  /** `--yes`: skip the question. The path list is still printed. */
  yes?: boolean;
  /** The caller (`setup`) already asked in a consent that listed these paths: no path list, no question. */
  consented?: boolean;
}

export type SelfInstallResult =
  | { outcome: "installed" | "relinked" | "current"; version: string; versionDir: string; launcher: string; alias: string }
  | { outcome: "cancelled"; version: string };

/** The newest tail of a command's stderr, for an error message. */
function tail(text: string): string {
  const lines = text.trim().split("\n");
  return lines.slice(-6).join("\n");
}

/**
 * Installs one release into `versions/<version>` and points the launcher link at it. Order:
 * look (reads only), print the paths and ask, `npm install --prefix <staging> --ignore-scripts`
 * in one invocation (the registry spec, or a staging package.json naming the verified runner
 * tarballs), rename the staging folder into place, and last
 * replace the launcher link atomically (a new symlink renamed over the old). A version dir
 * that is already there is kept and only the launcher is checked.
 */
export async function selfInstall(deps: CliDeps, run: SelfInstallRun = {}): Promise<SelfInstallResult> {
  await assertNoLegacyLayout(deps);
  const paths = installPathsOf(deps);
  // A version that is already there needs no source at all (install.sh and setup rely on that to
  // only relink): an explicit --from is still checked, the environment's base is not even read.
  // Without --from the version is known up front (--version, else this CLI's own).
  const early = run.version === undefined && run.from !== undefined ? undefined : selfInstallPlan(deps, { version: run.version });
  const presentEarly = early !== undefined && (await versionPresent(early, paths));
  let from = run.from;
  let fromBase = false;
  if (from === undefined && !presentEarly) {
    const base = installBaseDir(deps, early!.version);
    from = base.dir;
    fromBase = base.dir !== undefined;
    if (base.ignored !== undefined) deps.stderr(`bridge self install: ${INSTALL_BASE_ENV} is not a file:// directory, so ${BRIDGE_PACKAGE} comes from the npm registry\n`);
  }
  const set = from === undefined ? undefined : await readTarballSet(from);
  if (set && fromBase && set.version !== early!.version) {
    throw new Error(`${set.dir} holds bridge ${set.version}, not ${early!.version} (${INSTALL_BASE_ENV} sets are at <base>/<version>/)`);
  }
  if (set && run.version !== undefined && run.version !== set.version) {
    throw new UsageError(`--version ${run.version} does not match the tarball set (${set.version})`);
  }
  const plan = set === undefined && early !== undefined ? early : selfInstallPlan(deps, { version: run.version ?? set?.version, from: set?.dir });

  // The plan the consent binds (see consent-plan.ts): canonical paths and kinds of every
  // destination, whether the version is there, the launcher's state.
  const bound = await bindingOf(deps, plan, paths, set);
  const { present, launcher, alias } = bound;
  for (const [link, state] of [[plan.launcherLink, launcher], [plan.aliasLink, alias]] as const) {
    if (state.kind === "foreign") throw new Error(`${link} exists and is not a bridge launcher (${state.detail}); move it away and run this again`);
  }
  const writeLauncherLink = !linkIsCurrent(launcher, plan.entry);
  const writeAliasLink = !linkIsCurrent(alias, plan.entry);
  if (present && !writeLauncherLink && !writeAliasLink) {
    deps.stdout(`bridge ${plan.version} is already installed at ${plan.versionDir}; the launcher ${plan.launcherLink} and ${plan.aliasLink} are current.\n`);
    await warnPath(deps);
    return { outcome: "current", version: plan.version, versionDir: plan.versionDir, launcher: plan.launcherLink, alias: plan.aliasLink };
  }
  // Rule A (consent-plan.ts): an aliased layout is refused before the question, as uninstall does.
  await assertLayout(deps, "install into");

  const lines: string[] = [];
  if (!present) {
    const how = plan.source.kind === "registry" ? `npm install of ${plan.source.spec}` : `npm install of the verified tarballs in ${plan.source.dir}, copied into a private folder next to it first`;
    lines.push(`  ${describePath(bound.install.versionDir)}  (bridge ${plan.version} and its dependencies: ${how}, --ignore-scripts, built in a staging folder next to it)`);
  }
  if (writeLauncherLink) lines.push(`  ${describePath(bound.link.launcher)}  (launcher link to ${plan.entry}${launcher.kind === "ours" ? `, replacing the link to ${launcher.target}` : ""})`);
  if (writeAliasLink) lines.push(`  ${describePath(bound.link.alias)}  (the same program under the name ${RUNNER_ALIAS}: a link to ${plan.entry}${alias.kind === "ours" ? `, replacing the link to ${alias.target}` : ""})`);
  const missing = [bound.install.appDir, bound.install.versionsDir, bound.link.binDir].filter((d) => d.kind === "missing");
  if (missing.length > 0) lines.push(`  folders created when missing: ${missing.map(describePath).join(", ")}`);
  if (!run.consented) deps.stdout(`These paths will be written:\n${lines.join("\n")}\n`);
  if (!run.yes && !run.consented && !(await deps.confirm(`Install bridge ${plan.version} for this user?`))) {
    deps.stderr("bridge self install: cancelled\n");
    return { outcome: "cancelled", version: plan.version };
  }

  // The prompt may have taken minutes: recompute the whole plan and go on only if it is the one shown.
  assertUnchanged(bound, await bindingOf(deps, plan, paths, set), "bridge self install");
  // That was the one recompute (rule B in consent-plan.ts): npm and everything after it run on
  // the bound canonical paths, not re-gated; every removal goes through removeBound.
  try {
    if (!present) await installVersion(deps, plan, set, bound);
    if (writeLauncherLink) await writeLauncher(plan, bound, plan.launcherLink, bound.link.launcher.canonical);
    if (writeAliasLink) await writeLauncher(plan, bound, plan.aliasLink, bound.link.alias.canonical);
  } catch (error) {
    await removeCreatedDirs(bound);
    throw error;
  }
  deps.stdout(`Installed bridge ${plan.version}: ${plan.launcherLink} -> ${plan.entry}; ${plan.aliasLink} -> ${plan.entry}\n`);
  await warnPath(deps);
  return { outcome: present ? "relinked" : "installed", version: plan.version, versionDir: plan.versionDir, launcher: plan.launcherLink, alias: plan.aliasLink };
}

/** After an install (or a check that nothing needed installing): says on stderr when `bridge` on PATH is not the launcher. */
async function warnPath(deps: CliDeps): Promise<void> {
  const warning = await pathWarningOf(deps).catch(() => undefined);
  if (warning !== undefined) deps.stderr(`${warning}\n`);
}

/** What `bridge self install` consents to, beyond the pure plan; plain data, compared after the question. */
interface SelfInstallBinding {
  present: boolean;
  launcher: LauncherState;
  alias: LauncherState;
  /** What the version install writes into. */
  install: { appDir: PathState; versionsDir: PathState; versionDir: PathState };
  /** What the launcher write touches. */
  link: { binDir: PathState; launcher: PathState; alias: PathState };
  /** The resolved layout (rule A): bases, top-level dirs, the launcher. */
  layout: LayoutSnapshot;
  /** With --from: `SHA256SUMS` and every tarball, with their hashes, so a set edited during the question is refused before any write. */
  source?: PathState[];
}

/**
 * After a failed install, bridge's own folders this run created (missing when the plan was bound) are
 * removed again, deepest first, only while empty and only through removeBound. The launcher's dir
 * (`~/.local/bin`) is a shared folder and stays even when this run made it.
 */
async function removeCreatedDirs(bound: SelfInstallBinding): Promise<void> {
  for (const d of [bound.install.versionsDir, bound.install.appDir]) {
    if (d.kind !== "missing") continue;
    await removeBound(d.canonical, { emptyDir: true }).catch(() => undefined);
  }
}

async function resolved(files: string[]): Promise<PathState[]> {
  const states = await pathStates(files);
  for (const s of states) if (s.kind === "unresolvable") throw new Error(`${s.path} cannot be resolved (${s.error}); refusing to install there`);
  return states;
}

async function linkStatesOf(plan: SelfInstallPlan): Promise<SelfInstallBinding["link"]> {
  const [binDir, launcher, alias] = await resolved([path.dirname(plan.launcherLink), plan.launcherLink, plan.aliasLink]);
  return { binDir: binDir!, launcher: launcher!, alias: alias! };
}

async function bindingOf(deps: CliDeps, plan: SelfInstallPlan, paths: RunnerPaths, set: TarballSet | undefined): Promise<SelfInstallBinding> {
  const present = await versionPresent(plan, paths);
  const launcher = await launcherStateOf(deps);
  const alias = await launcherStateOf(deps, plan.aliasLink);
  const [appDir, versionsDir, versionDir] = await resolved([paths.appDir, paths.versionsDir, plan.versionDir]);
  return {
    present,
    launcher,
    alias,
    install: { appDir: appDir!, versionsDir: versionsDir!, versionDir: versionDir! },
    link: await linkStatesOf(plan),
    layout: await layoutSnapshot(deps),
    ...(set !== undefined && !present && { source: await pathStates([path.join(set.dir, SUMS_FILE), ...set.files], { hash: true }) }),
  };
}

/** Whether `versions/<version>` is a complete install; a symlink or half-made dir there is an error. */
async function versionPresent(plan: SelfInstallPlan, paths: RunnerPaths): Promise<boolean> {
  for (const dir of [paths.appDir, paths.versionsDir]) {
    const info = await lstat(dir).catch(() => undefined);
    if (info !== undefined && !info.isDirectory()) throw new Error(`${dir} is not a directory (a symlink or other); refusing to install into it`);
  }
  const info = await lstat(plan.versionDir).catch(() => undefined);
  if (info === undefined) return false;
  if (!info.isDirectory()) throw new Error(`${plan.versionDir} is not a directory (a symlink or other); refusing to use it`);
  const valid = await listValidVersions({ versionsDir: paths.versionsDir, fs: { readdir: (d) => readdir(d), stat: (p) => stat(p) }, allowPrerelease: true });
  if (!valid.some((t) => t.version === plan.version)) {
    throw new Error(`${plan.versionDir} exists but is incomplete; remove it (or run \`bridge uninstall\`) and run this again`);
  }
  // The launcher will point at the entry: it must be a real file inside the version dir.
  await checkEntry(plan.versionDir, plan.entry);
  return true;
}

/** The entry file must be a regular file whose real path stays inside the version dir. */
async function checkEntry(root: string, entry: string): Promise<void> {
  const info = await lstat(entry).catch(() => undefined);
  if (info === undefined || !info.isFile()) throw new Error(`${entry} is not a regular file; refusing to link to it`);
  const real = await realpath(entry);
  const realRoot = await realpath(root);
  if (!isInside(realRoot, real)) throw new Error(`${entry} resolves outside ${root}; refusing to link to it`);
}

/**
 * Copies the verified tarball set into a private (0700) folder under the canonical versions dir:
 * each file is read once, its bytes are checked against the hash the consent bound, and those
 * bytes are what npm gets. A tarball swapped after the check (for a symlink or other bytes)
 * never reaches npm.
 */
async function stageTarballs(set: TarballSet, versionsDir: string, version: string): Promise<{ dir: string; files: string[] }> {
  await mkdir(versionsDir, { recursive: true });
  const dir = path.join(versionsDir, `.tarballs-${version}-${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { mode: 0o700 });
  const files: string[] = [];
  try {
    for (const file of set.files) {
      const bytes = await readFile(file);
      const actual = sha256(bytes);
      if (actual !== set.sums[file]) throw new Error(`${path.basename(file)} changed after it was verified (expected ${set.sums[file]}, got ${actual}); nothing was installed`);
      const staged = path.join(dir, path.basename(file));
      await writeFile(staged, bytes, { mode: 0o600, flag: "wx" });
      files.push(staged);
    }
  } catch (error) {
    await removeBound(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, files };
}

async function installVersion(deps: CliDeps, plan: SelfInstallPlan, set: TarballSet | undefined, bound: SelfInstallBinding): Promise<void> {
  if (plan.source.kind === "tarballs" && set === undefined) throw new Error("nothing to install");
  const staged = set === undefined ? undefined : await stageTarballs(set, bound.install.versionsDir.canonical, plan.version);
  try {
    const specs = staged === undefined && plan.source.kind === "registry" ? [plan.source.spec] : [];
    const downloadPlan: DownloadPlan = {
      action: "download",
      version: plan.version,
      url: plan.source.kind === "registry" ? plan.source.spec : `file://${plan.source.dir}`,
      destDir: bound.install.versionDir.canonical,
    };
    const result = await applyUpdatePlan(downloadPlan, {
      fs: nodeFs,
      download: async (_plan, staging) => {
        if (staged !== undefined) await writeFile(path.join(staging, "package.json"), stagingManifest(staged.files, plan.version), { flag: "wx" });
        let r;
        try {
          r = await runnerOf(deps)("npm", npmInstallArgs(staging, specs));
        } catch (error) {
          throw new Error(`could not run npm (${errorMessage(error)}); install Node.js with npm and try again`);
        }
        if (r.exitCode !== 0) throw new Error(`npm install exited with ${r.exitCode}: ${tail(r.stderr)}`);
        const pkgFile = path.join(staging, "node_modules", ...BRIDGE_PACKAGE.split("/"), "package.json");
        let installed: unknown;
        try {
          installed = (JSON.parse(await readFile(pkgFile, "utf8")) as { version?: unknown }).version;
        } catch {
          throw new Error(`npm install left no ${BRIDGE_PACKAGE} package in the staging folder`);
        }
        if (installed !== plan.version) throw new Error(`npm installed ${BRIDGE_PACKAGE} ${String(installed)}, not ${plan.version}`);
        await checkEntry(staging, path.join(staging, DEFAULT_ENTRY_FILE));
      },
    });
    if (!result.fetched) throw new Error(`install of bridge ${plan.version} failed: ${result.error ?? "unknown error"}`);
  } finally {
    if (staged !== undefined) await removeBound(staged.dir, { recursive: true, force: true });
  }
}

/** Points one link (the launcher or the alias) at the version's entry: a new symlink in the link's canonical dir, renamed over the old one. */
async function writeLauncher(plan: SelfInstallPlan, bound: SelfInstallBinding, link: string, canonical: string): Promise<void> {
  await checkEntry(plan.versionDir, plan.entry);
  const dir = bound.link.binDir.canonical;
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(link)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await symlink(plan.entry, temp);
    await rename(temp, canonical);
  } catch (error) {
    await removeBound(temp, { force: true });
    throw error;
  }
}

/** `bridge self install [--yes] [--version <v>] [--from <dir>]`. */
export async function runSelfInstall(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(args, { yes: { type: "boolean" }, version: { type: "string" }, from: { type: "string" } });
  if (positionals.length !== 1 || positionals[0] !== "install") {
    throw new UsageError("usage: bridge self install [--yes] [--version <v>] [--from <dir>]");
  }
  const result = await selfInstall(deps, { yes: values.yes === true, version: values.version, from: values.from });
  return result.outcome === "cancelled" ? 1 : 0;
}
