import { randomBytes } from "node:crypto";
import path from "node:path";

import { RemoveRefused } from "./remove-bound.js";
import { compareSemver, parseSemver } from "./semver.js";

/** The slice of fs the resolver needs; node:fs/promises satisfies it. */
export interface VersionsFs {
  readdir(dir: string): Promise<string[]>;
  stat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
}

export interface ResolveOptions {
  versionsDir: string;
  fs: VersionsFs;
  /** File that must exist inside a version dir for it to count as installed. */
  entryFile?: string;
  /** Pre-release dirs are ignored unless this is set. */
  allowPrerelease?: boolean;
}

export interface LauncherTarget {
  version: string;
  dir: string;
  entry: string;
}

/**
 * The entry of a version dir made by `npm install --prefix versions/<v> @berdyh/bridge`: the CLI
 * package's `bin/run.js` inside the hoisted `node_modules`. The launcher link points at it.
 */
export const DEFAULT_ENTRY_FILE = "node_modules/@berdyh/bridge/bin/run.js";

export function versionDir(versionsDir: string, version: string): string {
  if (!parseSemver(version)) throw new Error(`invalid version: ${version}`);
  return path.join(versionsDir, version);
}

/** Valid = dir name is a semver and the entry file exists. Newest first. */
export async function listValidVersions(opts: ResolveOptions): Promise<LauncherTarget[]> {
  const entryFile = opts.entryFile ?? DEFAULT_ENTRY_FILE;
  let names: string[];
  try {
    names = await opts.fs.readdir(opts.versionsDir);
  } catch {
    return [];
  }
  const found: LauncherTarget[] = [];
  for (const name of names) {
    const parsed = parseSemver(name);
    if (!parsed) continue;
    if (parsed.prerelease.length > 0 && !opts.allowPrerelease) continue;
    const dir = path.join(opts.versionsDir, name);
    const entry = path.join(dir, entryFile);
    try {
      if ((await opts.fs.stat(entry)).isFile()) found.push({ version: name, dir, entry });
    } catch {
      // half-extracted or foreign directory: not valid
    }
  }
  return found.sort((a, b) => compareSemver(b.version, a.version));
}

/** What the service launcher runs at start: the newest valid version, or null. */
export async function resolveLauncherTarget(opts: ResolveOptions): Promise<LauncherTarget | null> {
  return (await listValidVersions(opts))[0] ?? null;
}

export interface RegistryVersion {
  version: string;
  tarballUrl: string;
  integrity?: string;
  /** Lowest protocol version this release speaks; informational. */
  protocolVersion?: number;
}

export interface RegistryMetadata {
  /** Version the registry's "latest" tag points at. */
  latest: string;
  versions: RegistryVersion[];
}

export type UpdatePlan =
  | {
      action: "none";
      reason: "up_to_date" | "already_downloaded" | "not_in_registry" | "invalid_current";
    }
  | {
      action: "download";
      version: string;
      url: string;
      integrity?: string;
      destDir: string;
    };

/**
 * Pure: decide what, if anything, to fetch. The new version takes effect on
 * the next restart because the launcher re-resolves at start.
 */
export function planUpdate(args: {
  currentVersion: string;
  installedVersions: readonly string[];
  registry: RegistryMetadata;
  versionsDir: string;
  allowPrerelease?: boolean;
}): UpdatePlan {
  const { registry } = args;
  if (!parseSemver(args.currentVersion)) return { action: "none", reason: "invalid_current" };
  const latest = parseSemver(registry.latest);
  if (!latest || (latest.prerelease.length > 0 && !args.allowPrerelease)) {
    return { action: "none", reason: "not_in_registry" };
  }
  const meta = registry.versions.find((v) => v.version === registry.latest);
  if (!meta) return { action: "none", reason: "not_in_registry" };
  if (compareSemver(registry.latest, args.currentVersion) <= 0) {
    return { action: "none", reason: "up_to_date" };
  }
  // An installed version at or above latest means the launcher will already pick it up.
  // Apply the launcher's eligibility rule: prereleases only count when allowed.
  const installed = args.installedVersions.filter((v) => {
    const parsed = parseSemver(v);
    return parsed !== null && (parsed.prerelease.length === 0 || args.allowPrerelease === true);
  });
  if (installed.some((v) => compareSemver(v, registry.latest) >= 0)) {
    return { action: "none", reason: "already_downloaded" };
  }
  return {
    action: "download",
    version: meta.version,
    url: meta.tarballUrl,
    integrity: meta.integrity,
    destDir: versionDir(args.versionsDir, meta.version),
  };
}

export type DownloadPlan = Extract<UpdatePlan, { action: "download" }>;

/**
 * Fetches and unpacks the release into `stagingDir` (an empty directory the
 * caller created). Must not touch `plan.destDir`.
 */
export type DownloadFn = (plan: DownloadPlan, stagingDir: string) => Promise<void>;

/** Checks the unpacked tree in `stagingDir` against the registry's integrity string. */
export type VerifyFn = (stagingDir: string, integrity: string) => Promise<boolean>;

/** fs surface for staging and promotion; node:fs/promises satisfies it. */
export interface UpdateFs {
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  rm(p: string, opts: { recursive: true; force: true }): Promise<void>;
  stat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
}

export interface ApplyDeps {
  download: DownloadFn;
  fs: UpdateFs;
  /** Required when the plan carries integrity; without one such a plan is refused. */
  verify?: VerifyFn;
  entryFile?: string;
  /** Random suffix for the staging dir. */
  random?: () => string;
}

/**
 * Downloads into `versions/.staging-<v>-<rand>` (not a semver name, so the
 * resolver ignores it), verifies integrity when present, checks the entry file,
 * then renames into `versions/<v>`. A crash leaves only an ignorable staging
 * dir, never a half-extracted version where the launcher looks. Errors are
 * returned, not thrown.
 */
export async function applyUpdatePlan(
  plan: UpdatePlan,
  deps: ApplyDeps,
): Promise<{ fetched: boolean; version?: string; error?: string }> {
  if (plan.action === "none") return { fetched: false };
  const { fs } = deps;
  const suffix = (deps.random ?? (() => randomBytes(6).toString("hex")))();
  const staging = path.join(path.dirname(plan.destDir), `.staging-${plan.version}-${suffix}`);
  try {
    if (plan.integrity && !deps.verify) throw new Error("plan has integrity but no verifier was provided");
    await fs.mkdir(staging, { recursive: true });
    await deps.download(plan, staging);
    if (plan.integrity && !(await deps.verify!(staging, plan.integrity))) {
      throw new Error("integrity check failed");
    }
    const entry = path.join(staging, deps.entryFile ?? DEFAULT_ENTRY_FILE);
    if (!(await fs.stat(entry).then((st) => st.isFile(), () => false))) {
      throw new Error("downloaded release has no entry file");
    }
    await fs.rename(staging, plan.destDir);
    return { fetched: true, version: plan.version };
  } catch (error) {
    // A cleanup the injected fs refuses (`removeBound`: the staging folder no longer resolves where
    // it was made) is reported with the failure, naming what was left; any other cleanup error is not.
    const refused = await fs.rm(staging, { recursive: true, force: true }).then(
      () => undefined,
      (e: unknown) => (e instanceof RemoveRefused ? e : undefined),
    );
    const message = (error as Error).message;
    return { fetched: false, version: plan.version, error: refused ? `${message}; ${refused.message}` : message };
  }
}
