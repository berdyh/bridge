import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { compareSemver, parseSemver } from "@berdyh/bridge-runner";

import { appsFilePath } from "./config.js";
import { type CliDeps, bridgeConfigDir } from "./deps.js";
import { runnerPathsOf } from "./paths.js";
import { CLI_VERSION } from "./version.js";

/**
 * The older bridge layout: one `<config>/bridge` holding every app's trust
 * lists, identities and enroll windows, `<state>/bridge/apps/<id>`, `<data>/bridge/plugins`, and an
 * `apps.json` with the full records inline. There is no migration: a command refuses and says how
 * to start over. Nothing reads an old trust list or identity.
 */
export class LegacyLayoutError extends Error {
  /** The offending paths. */
  readonly paths: string[];
  constructor(paths: string[], oldBinaries: string[]) {
    const old = oldBinaries.length > 0 ? ` (the older bridge is ${oldBinaries.join(" or ")})` : "";
    super(
      `an older bridge layout is present (${paths.join(", ")}); run the old \`bridge uninstall\`${old}, then \`bridge setup <url>\`. There is no migrate command.`,
    );
    this.name = "LegacyLayoutError";
    this.paths = paths;
  }
}

async function present(p: string): Promise<boolean> {
  return lstat(p).then(() => true, () => false);
}

/** The offending paths of an older layout, `[]` when there is none. Reads only (`lstat`, `apps.json`). */
export async function legacyLayoutOf(deps: CliDeps): Promise<string[]> {
  const config = bridgeConfigDir(deps);
  const paths = runnerPathsOf(deps);
  const markers = [
    ...["trust", "identity", "identity-key", "enroll"].map((n) => path.join(config, n)),
    path.join(paths.stateDir, "apps"),
    ...["plugins", "plugin-data"].map((n) => path.join(paths.appDir, n)),
  ];
  const found: string[] = [];
  for (const marker of markers) if (await present(marker)) found.push(marker);
  // An `apps.json` that parses but is not version 2 is the older list; one that does not parse is
  // just broken (`bridge doctor` and `loadApps` say so) and is not this refusal's business.
  try {
    const parsed = JSON.parse(await readFile(appsFilePath(deps), "utf8")) as { version?: unknown } | null;
    if (parsed !== null && typeof parsed === "object" && parsed.version !== 2) found.push(appsFilePath(deps));
  } catch {
    // missing, unreadable or not JSON
  }
  return found;
}

/** The `bridge` binaries of installed versions older than this one: the launcher may already point at the new one. */
async function olderBinaries(deps: CliDeps): Promise<string[]> {
  const versionsDir = runnerPathsOf(deps).versionsDir;
  const names = await readdir(versionsDir).catch(() => [] as string[]);
  const older = names.filter((n) => parseSemver(n) !== null && compareSemver(n, CLI_VERSION) < 0).sort(compareSemver).reverse();
  const out: string[] = [];
  for (const name of older) {
    const bin = path.join(versionsDir, name, "node_modules", ".bin", "bridge");
    if (await present(bin)) out.push(bin);
  }
  return out;
}

/**
 * Throws `LegacyLayoutError` when an older layout is present. Called first by every command that
 * reads or writes bridge's folders, before any consent or write.
 */
export async function assertNoLegacyLayout(deps: CliDeps): Promise<void> {
  const error = await legacyErrorOf(deps);
  if (error) throw error;
}

/** The refusal for an older layout, or `undefined` when there is none (for a caller that reports instead of refusing). */
export async function legacyErrorOf(deps: CliDeps): Promise<LegacyLayoutError | undefined> {
  const found = await legacyLayoutOf(deps);
  return found.length > 0 ? new LegacyLayoutError(found, await olderBinaries(deps)) : undefined;
}
