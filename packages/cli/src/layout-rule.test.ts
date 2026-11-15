import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { upsertApp } from "./config.js";
import { assertAppDirsReal, assertLayout, firstOverlap, layoutOf, layoutSnapshot } from "./layout-rule.js";
import { assertUnchanged, ChangedWhileWaiting } from "./consent-plan.js";
import { appPathsOf } from "./paths.js";
import { type Harness, harness, record } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

async function twoApps(): Promise<void> {
  await upsertApp(h.deps, record());
  await upsertApp(h.deps, record({ appId: "other", origin: "https://other.example", runnerId: "r2" }));
  for (const id of ["demo", "other"]) {
    const p = appPathsOf(h.deps, id);
    await mkdir(p.dataDir, { recursive: true });
    await mkdir(p.stateDir, { recursive: true });
  }
}

describe("Rule A on the apps' bridge/ dirs", () => {
  it("a plain layout has no overlap and lists each app's three dirs resolved", async () => {
    h = await harness();
    await twoApps();
    const layout = await layoutOf(h.deps);
    expect(layout.overlap).toBeUndefined();
    expect(layout.apps.map((a) => a.appId)).toEqual(["demo", "other"]);
    expect(layout.apps[0]!.dirs.map((d) => d.path)).toEqual([appPathsOf(h.deps, "demo").configDir, appPathsOf(h.deps, "demo").dataDir, appPathsOf(h.deps, "demo").stateDir]);
  });

  it("refuses an app's bridge/ dir symlinked into another app's", async () => {
    h = await harness();
    await twoApps();
    const demo = appPathsOf(h.deps, "demo");
    const other = appPathsOf(h.deps, "other");
    await rm(demo.stateDir, { recursive: true });
    await symlink(other.stateDir, demo.stateDir);
    const layout = await layoutOf(h.deps);
    expect(layout.overlap).toBeDefined();
    expect(layout.overlap!.join(" ")).toContain(demo.stateDir);
    await expect(assertLayout(h.deps, "remove")).rejects.toThrow(/overlap: this is an unusual layout/);
  });

  it("refuses an app's bridge/ dir symlinked into <config>/bridge, or into a subfolder of it", async () => {
    h = await harness();
    await twoApps();
    const demo = appPathsOf(h.deps, "demo");
    await mkdir(path.join(h.deps.configDir, "bridge", "agents"), { recursive: true });
    await rm(demo.dataDir, { recursive: true });
    await symlink(path.join(h.deps.configDir, "bridge", "agents"), demo.dataDir);
    expect((await layoutOf(h.deps)).overlap).toBeDefined();
    await rm(demo.dataDir);
    await symlink(path.join(h.deps.configDir, "bridge"), demo.dataDir);
    expect((await layoutOf(h.deps)).overlap).toBeDefined();
  });

  it("refuses two of one app's dirs resolving to the same place", async () => {
    h = await harness();
    await twoApps();
    const demo = appPathsOf(h.deps, "demo");
    await rm(demo.dataDir, { recursive: true });
    await symlink(demo.stateDir, demo.dataDir);
    expect((await layoutOf(h.deps)).overlap).toBeDefined();
  });

  it("refuses an app whose dir really is a machine-wide dir (the other direction)", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    const demo = appPathsOf(h.deps, "demo");
    await mkdir(path.join(h.deps.dataDir, "bridge", "versions"), { recursive: true });
    await mkdir(demo.parents.data, { recursive: true });
    await symlink(path.join(h.deps.dataDir, "bridge"), demo.dataDir);
    expect((await layoutOf(h.deps)).overlap).toBeDefined();
  });

  it("refuses app dirs whose paths overlap, even where they resolve apart; a manifest dir inside its base stays fine", () => {
    const app = (p: string, real = p) => ({ path: p, real, kind: "app" as const });
    const top = (p: string, real = p) => ({ path: p, real, kind: "top" as const });
    const base = (p: string, real = p) => ({ path: p, real, kind: "base" as const });
    // Two app dirs at one path, though each "resolves" apart (a retarget between the two resolutions).
    expect(firstOverlap([app("/c/demo/bridge", "/r1"), app("/c/demo/bridge", "/r2")])).toBeDefined();
    // An app dir lexically inside a machine-wide manifest dir, resolving apart.
    expect(firstOverlap([top("/c/bridge", "/r1"), app("/c/bridge/demo/bridge", "/r2")])).toBeDefined();
    // A manifest dir inside its base is by design; an app dir inside its base is not compared.
    expect(firstOverlap([base("/c"), top("/c/bridge"), app("/c/demo/bridge")])).toBeUndefined();
  });

  it("refuses two XDG roots set to one folder: an app's config and state bridge/ dirs are then one path", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    h.deps.env.XDG_STATE_HOME = h.deps.configDir;
    const layout = await layoutOf(h.deps);
    expect(layout.overlap).toBeDefined();
    await expect(assertLayout(h.deps, "run")).rejects.toThrow(/overlap/);
  });

  it("accepts a symlinked <config>/<app> parent that leads somewhere apart", async () => {
    h = await harness();
    const real = path.join(h.root, "apart", "demo-config");
    await mkdir(real, { recursive: true });
    await mkdir(h.deps.configDir, { recursive: true });
    await symlink(real, path.join(h.deps.configDir, "demo"));
    await upsertApp(h.deps, record());
    await twoApps();
    const layout = await layoutOf(h.deps);
    expect(layout.overlap).toBeUndefined();
    expect(layout.apps[0]!.dirs[0]!.real).toBe(path.join(real, "bridge"));
    await expect(assertLayout(h.deps, "connect", ["third"])).resolves.toBeDefined();
  });

  it("a new app about to be connected is checked too, before it is in apps.json", async () => {
    h = await harness();
    await twoApps();
    const other = appPathsOf(h.deps, "other");
    const fresh = appPathsOf(h.deps, "fresh");
    await mkdir(fresh.parents.state, { recursive: true });
    await symlink(other.stateDir, fresh.stateDir);
    expect((await layoutOf(h.deps)).overlap).toBeUndefined();
    expect((await layoutOf(h.deps, ["fresh"])).overlap).toBeDefined();
  });

  it("assertAppDirsReal refuses a bridge/ dir that is a symlink, even one leading apart, and a file; a missing one is fine", async () => {
    h = await harness();
    const demo = appPathsOf(h.deps, "demo");
    await expect(assertAppDirsReal(h.deps, "demo")).resolves.toBeUndefined();
    await mkdir(demo.parents.config, { recursive: true });
    await mkdir(path.join(h.root, "apart"), { recursive: true });
    await symlink(path.join(h.root, "apart"), demo.configDir);
    await expect(assertAppDirsReal(h.deps, "demo")).rejects.toThrow(/not a real folder \(a symlink\)/);
    await rm(demo.configDir);
    await writeFile(demo.configDir, "x");
    await expect(assertAppDirsReal(h.deps, "demo")).rejects.toThrow(/not a folder/);
  });
});

describe("the layout snapshot (Rule B)", () => {
  it("carries the apps' dirs and changes when a bridge/ dir is retargeted during consent", async () => {
    h = await harness();
    await twoApps();
    const demo = appPathsOf(h.deps, "demo");
    const before = await layoutSnapshot(h.deps);
    expect(before.apps.map((a) => a.appId)).toEqual(["demo", "other"]);
    assertUnchanged(before, await layoutSnapshot(h.deps));
    const apart = path.join(h.root, "apart");
    await mkdir(apart, { recursive: true });
    await rename(demo.dataDir, path.join(h.root, "moved"));
    await symlink(apart, demo.dataDir);
    await expect(Promise.resolve().then(async () => assertUnchanged(before, await layoutSnapshot(h.deps)))).rejects.toBeInstanceOf(ChangedWhileWaiting);
  });

  it("an unreadable apps.json gives no apps and its error is part of the snapshot", async () => {
    h = await harness();
    await mkdir(path.join(h.deps.configDir, "bridge"), { recursive: true });
    await writeFile(path.join(h.deps.configDir, "bridge", "apps.json"), "{nope");
    const snap = await layoutSnapshot(h.deps);
    expect(snap.apps).toEqual([]);
    expect(snap.appsError).toContain("not valid JSON");
  });

  it("an app added to apps.json during consent changes the snapshot", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    const before = await layoutSnapshot(h.deps);
    await upsertApp(h.deps, record({ appId: "late", origin: "https://late.example", runnerId: "r9" }));
    await expect(Promise.resolve().then(async () => assertUnchanged(before, await layoutSnapshot(h.deps)))).rejects.toBeInstanceOf(ChangedWhileWaiting);
  });
});
