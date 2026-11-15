import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_ENTRY_FILE, applyUpdatePlan, planUpdate, resolveLauncherTarget } from "./layout.js";
import { compareSemver, parseSemver } from "./semver.js";

describe("semver", () => {
  it("parses and rejects", () => {
    expect(parseSemver("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    for (const bad of ["1.2", "v1.2.3", "01.2.3", "1.2.3.4", "latest"]) expect(parseSemver(bad)).toBeNull();
  });
  it("orders numerically, with prereleases below releases", () => {
    const sorted = ["1.10.0", "1.2.0", "1.2.0-beta.2", "1.2.0-beta.10", "1.2.0-alpha", "0.9.9"].sort(compareSemver);
    expect(sorted).toEqual(["0.9.9", "1.2.0-alpha", "1.2.0-beta.2", "1.2.0-beta.10", "1.2.0", "1.10.0"]);
  });
});

describe("resolveLauncherTarget", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "bridge-versions-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function install(version: string, withEntry = true) {
    await mkdir(path.dirname(path.join(dir, version, DEFAULT_ENTRY_FILE)), { recursive: true });
    if (withEntry) await writeFile(path.join(dir, version, DEFAULT_ENTRY_FILE), "");
  }

  it("picks the newest valid version, skipping half-installed, foreign and prerelease dirs", async () => {
    await install("1.2.0");
    await install("1.10.0");
    await install("2.0.0", false); // no entry file
    await install("3.0.0-rc.1"); // prerelease
    await mkdir(path.join(dir, "tmp-download"));
    const target = await resolveLauncherTarget({ versionsDir: dir, fs });
    expect(target).toEqual({
      version: "1.10.0",
      dir: path.join(dir, "1.10.0"),
      entry: path.join(dir, "1.10.0", DEFAULT_ENTRY_FILE),
    });
    const withPre = await resolveLauncherTarget({ versionsDir: dir, fs, allowPrerelease: true });
    expect(withPre?.version).toBe("3.0.0-rc.1");
  });

  it("returns null for an empty or missing versions dir", async () => {
    expect(await resolveLauncherTarget({ versionsDir: dir, fs })).toBeNull();
    expect(await resolveLauncherTarget({ versionsDir: path.join(dir, "nope"), fs })).toBeNull();
  });
});

describe("planUpdate", () => {
  const registry = {
    latest: "1.3.0",
    versions: [
      { version: "1.2.0", tarballUrl: "https://r/1.2.0.tgz" },
      { version: "1.3.0", tarballUrl: "https://r/1.3.0.tgz", integrity: "sha512-abc" },
    ],
  };
  const base = { registry, versionsDir: "/v", installedVersions: ["1.2.0"], currentVersion: "1.2.0" };

  it("plans a download of the newer version", () => {
    expect(planUpdate(base)).toEqual({
      action: "download",
      version: "1.3.0",
      url: "https://r/1.3.0.tgz",
      integrity: "sha512-abc",
      destDir: path.join("/v", "1.3.0"),
    });
  });
  it("does nothing when current, already downloaded, or unknown", () => {
    expect(planUpdate({ ...base, currentVersion: "1.3.0" })).toEqual({ action: "none", reason: "up_to_date" });
    expect(planUpdate({ ...base, installedVersions: ["1.2.0", "1.3.0"] })).toEqual({ action: "none", reason: "already_downloaded" });
    expect(planUpdate({ ...base, registry: { latest: "9.9.9", versions: [] } })).toEqual({ action: "none", reason: "not_in_registry" });
    expect(planUpdate({ ...base, registry: { latest: "2.0.0-rc.1", versions: [{ version: "2.0.0-rc.1", tarballUrl: "u" }] } }).action).toBe("none");
  });

  it("never throws on an invalid current version, ignores prerelease latest, and sees newer installs", () => {
    expect(planUpdate({ ...base, currentVersion: "garbage" })).toEqual({ action: "none", reason: "invalid_current" });
    const pre = { latest: "2.0.0-beta.1", versions: [{ version: "2.0.0-beta.1", tarballUrl: "u" }] };
    expect(planUpdate({ ...base, registry: pre })).toEqual({ action: "none", reason: "not_in_registry" });
    expect(planUpdate({ ...base, registry: pre, allowPrerelease: true }).action).toBe("download");
    // 1.4.0 is already on disk (newer than registry latest 1.3.0): nothing to fetch.
    expect(planUpdate({ ...base, installedVersions: ["1.2.0", "1.4.0", "junk"] })).toEqual({ action: "none", reason: "already_downloaded" });
  });

  it("ignores installed prereleases the launcher would skip", () => {
    const installedVersions = ["1.2.0", "2.0.0-rc.1"];
    expect(planUpdate({ ...base, installedVersions }).action).toBe("download");
    expect(planUpdate({ ...base, installedVersions, allowPrerelease: true })).toEqual({
      action: "none",
      reason: "already_downloaded",
    });
  });
});

describe("applyUpdatePlan", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "bridge-apply-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const mkPlan = (integrity?: string) =>
    planUpdate({
      currentVersion: "1.2.0",
      installedVersions: ["1.2.0"],
      versionsDir: dir,
      registry: { latest: "1.3.0", versions: [{ version: "1.3.0", tarballUrl: "https://r/1.3.0.tgz", integrity }] },
    });
  const write = async (stagingDir: string) => {
    await mkdir(path.join(stagingDir, "node_modules/@berdyh/bridge/bin"), { recursive: true });
    await writeFile(path.join(stagingDir, DEFAULT_ENTRY_FILE), "x");
  };

  it("downloads into a staging sibling, then renames into versions/<v>", async () => {
    const seen: string[] = [];
    const r = await applyUpdatePlan(mkPlan(), {
      fs,
      random: () => "abc",
      download: async (plan, staging) => {
        seen.push(staging);
        expect(staging).not.toBe(plan.destDir);
        await write(staging);
        // mid-download the real version dir does not exist, so the launcher cannot pick it
        expect(await resolveLauncherTarget({ versionsDir: dir, fs })).toBeNull();
      },
    });
    expect(r).toEqual({ fetched: true, version: "1.3.0" });
    expect(seen).toEqual([path.join(dir, ".staging-1.3.0-abc")]);
    expect((await resolveLauncherTarget({ versionsDir: dir, fs }))?.version).toBe("1.3.0");
    expect(await readdir(dir)).toEqual(["1.3.0"]);
  });

  it("cleans staging and leaves no version behind when the download fails midway", async () => {
    const r = await applyUpdatePlan(mkPlan(), {
      fs,
      download: async (_p, staging) => {
        await write(staging);
        throw new Error("offline");
      },
    });
    expect(r).toEqual({ fetched: false, version: "1.3.0", error: "offline" });
    expect(await readdir(dir)).toEqual([]);
    expect(await resolveLauncherTarget({ versionsDir: dir, fs })).toBeNull();
  });

  it("verifies integrity when present: refuses without a verifier, rejects mismatches, accepts matches", async () => {
    const download = async (_p: unknown, staging: string) => write(staging);
    expect(await applyUpdatePlan(mkPlan("sha512-abc"), { fs, download })).toMatchObject({ fetched: false, error: expect.stringContaining("verifier") });
    expect(await applyUpdatePlan(mkPlan("sha512-abc"), { fs, download, verify: async () => false })).toMatchObject({ fetched: false, error: "integrity check failed" });
    expect(await readdir(dir)).toEqual([]);
    const got: string[] = [];
    expect(await applyUpdatePlan(mkPlan("sha512-abc"), { fs, download, verify: async (_d, i) => (got.push(i), true) })).toMatchObject({ fetched: true });
    expect(got).toEqual(["sha512-abc"]);
  });

  it("refuses to promote a download without the entry file; no-op plans skip the downloader", async () => {
    expect(await applyUpdatePlan(mkPlan(), { fs, download: async () => undefined })).toMatchObject({ fetched: false, error: expect.stringContaining("entry") });
    expect(await readdir(dir)).toEqual([]);
    const never = async () => { throw new Error("never"); };
    expect(await applyUpdatePlan({ action: "none", reason: "up_to_date" }, { fs, download: never })).toEqual({ fetched: false });
  });
});
