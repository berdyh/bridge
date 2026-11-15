import { chmod, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type HostedAppRecord, type LocalAppRecord, LOCAL_ORIGIN, appsFilePath, discoverAppFiles, isLocalApp, isSafeAppId, loadApps as loadAllApps, readAppFile, readAppList, readApps, removeApp, resolveApp, upsertApp } from "./config.js";
import { appPathsOf } from "./paths.js";
import { type Harness, exists, harness, record } from "./testkit.js";

/** These tests connect hosted apps only: the records read back are hosted ones. */
const loadApps = async (deps: Parameters<typeof loadAllApps>[0]): Promise<HostedAppRecord[]> => (await loadAllApps(deps)) as HostedAppRecord[];

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("app records (apps.json v2 and each app's app.json)", () => {

  it("writes app.json and apps.json at the bound canonical paths it is given, not through a link retargeted since", async () => {
    h = await harness();
    const real = path.join(h.root, "bound");
    const decoy = path.join(h.root, "decoy");
    await mkdir(path.join(real, "demo", "bridge"), { recursive: true });
    await mkdir(path.join(real, "bridge"), { recursive: true });
    await mkdir(path.join(decoy, "bridge"), { recursive: true });
    await mkdir(path.join(decoy, "demo", "bridge"), { recursive: true });
    // The lexical config dir now leads to the decoy; the plan bound the real one.
    await rm(h.deps.configDir, { recursive: true, force: true });
    await symlink(decoy, h.deps.configDir);
    const bound = { appsFile: path.join(real, "bridge", "apps.json"), appFile: path.join(real, "demo", "bridge", "app.json") };
    await upsertApp(h.deps, record(), bound);
    expect(JSON.parse(await readFile(bound.appFile, "utf8"))).toMatchObject({ appId: "demo" });
    expect(JSON.parse(await readFile(bound.appsFile, "utf8"))).toMatchObject({ apps: [{ appId: "demo" }] });
    expect(await exists(path.join(decoy, "demo", "bridge", "app.json"))).toBe(false);
    expect(await exists(path.join(decoy, "bridge", "apps.json"))).toBe(false);
    // removeApp reads the list where the lock is (the lexical path, here the decoy, which lists nothing) and writes only the bound file.
    await writeFile(path.join(decoy, "bridge", "apps.json"), JSON.stringify({ version: 2, apps: [{ appId: "demo", origin: "https://x" }] }));
    expect(await removeApp(h.deps, "demo", { appsFile: bound.appsFile })).toBe(true);
    expect(JSON.parse(await readFile(bound.appsFile, "utf8"))).toMatchObject({ apps: [] });
    expect(JSON.parse(await readFile(path.join(decoy, "bridge", "apps.json"), "utf8"))).toMatchObject({ apps: [{ appId: "demo" }] });
  });
  it("keep an optional enrollPage across a save and load, and load records without one", async () => {
    h = await harness();
    await upsertApp(h.deps, record({ enrollPage: "/bridge/enroll" }));
    await upsertApp(h.deps, record({ appId: "plain", runnerId: "runner-2" }));
    const apps = await loadApps(h.deps);
    expect(apps.find((a) => a.appId === "demo")?.enrollPage).toBe("/bridge/enroll");
    expect(apps.find((a) => a.appId === "plain")?.enrollPage).toBeUndefined();
  });

  it("round trip: apps.json is the id -> origin list at version 2, the record lives in the app's own bridge/ folder", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    expect(JSON.parse(await readFile(appsFilePath(h.deps), "utf8"))).toEqual({ version: 2, apps: [{ appId: "demo", origin: "https://demo.example" }] });
    const file = appPathsOf(h.deps, "demo").appFile;
    expect(file).toBe(path.join(h.deps.configDir, "demo", "bridge", "app.json"));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, ...record() });
    expect(await loadApps(h.deps)).toEqual([record()]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect((await stat(path.dirname(path.dirname(file)))).mode & 0o777).toBe(0o700);
  });

  it("creates the app's parent only when missing and never changes an existing one", async () => {
    h = await harness();
    const parent = path.join(h.deps.configDir, "demo");
    await mkdir(parent, { recursive: true, mode: 0o755 });
    await writeFile(path.join(parent, "theirs.txt"), "app's own");
    await upsertApp(h.deps, record());
    expect((await stat(parent)).mode & 0o777).toBe(0o755);
    expect(await readFile(path.join(parent, "theirs.txt"), "utf8")).toBe("app's own");
  });

  it("writes apps.json only when the list changes, and never a bridge/ dir that is a link", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    const before = (await stat(appsFilePath(h.deps))).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await upsertApp(h.deps, record({ name: "Renamed" }));
    expect((await stat(appsFilePath(h.deps))).mtimeMs).toBe(before);
    expect((await loadApps(h.deps))[0]!.name).toBe("Renamed");
    await removeApp(h.deps, "demo");
    expect(await readAppList(h.deps)).toEqual({ listed: [] });
    // The record file stays: removing an app's folders is `bridge apps remove`'s job.
    expect(await exists(appPathsOf(h.deps, "demo").appFile)).toBe(true);
  });

  it("never writes through a link: a symlink planted at app.json or apps.json is replaced, the file it pointed at is untouched, and no predictable temp file is used", async () => {
    h = await harness();
    const victim = path.join(h.root, "victim.txt");
    await writeFile(victim, "mine");
    const file = appPathsOf(h.deps, "demo").appFile;
    await mkdir(path.dirname(file), { recursive: true });
    await symlink(victim, file);
    await mkdir(path.dirname(appsFilePath(h.deps)), { recursive: true });
    await symlink(victim, appsFilePath(h.deps));
    // The old writer's temp names: `<file>.<pid>.tmp` planted as links must not be followed either.
    await symlink(victim, `${file}.${process.pid}.tmp`);
    await symlink(victim, `${appsFilePath(h.deps)}.${process.pid}.tmp`);
    // A link at apps.json is not a version 2 list, so it is refused before anything is written; clear it as a person would.
    await rm(appsFilePath(h.deps));
    await upsertApp(h.deps, record());
    expect(await readFile(victim, "utf8")).toBe("mine");
    for (const f of [file, appsFilePath(h.deps)]) {
      const info = await lstat(f);
      expect(info.isSymbolicLink(), f).toBe(false);
      expect(info.mode & 0o777, f).toBe(0o600);
    }
    expect(await loadApps(h.deps)).toEqual([record()]);
    // A looser mode left by someone else is not kept.
    await chmod(file, 0o644);
    await upsertApp(h.deps, record({ name: "Again" }));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("a version-1 apps.json is not a list: it is an error that names the file, never read as records", async () => {
    h = await harness();
    await mkdir(path.dirname(appsFilePath(h.deps)), { recursive: true });
    await writeFile(appsFilePath(h.deps), JSON.stringify({ version: 1, apps: [record()] }));
    expect((await readAppList(h.deps)).error).toContain("not a version 2 list");
    await expect(loadApps(h.deps)).rejects.toThrow(appsFilePath(h.deps));
    await expect(upsertApp(h.deps, record())).rejects.toThrow(/version 2/);
    expect(JSON.parse(await readFile(appsFilePath(h.deps), "utf8")).version).toBe(1);
  });

  it("a listed id without a readable app.json is a hard error naming the file, never dropped", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    await upsertApp(h.deps, record({ appId: "other", origin: "https://other.example", runnerId: "r2" }));
    const file = appPathsOf(h.deps, "other").appFile;
    await writeFile(file, "{nope");
    await expect(loadApps(h.deps)).rejects.toThrow(file);
    const read = await readApps(h.deps);
    expect(read.apps.map((a) => a.appId)).toEqual(["demo"]);
    expect(read.broken).toEqual([expect.objectContaining({ appId: "other", file })]);
    // apps.json alone is still readable: a layout or a manifest can be built.
    expect((await readAppList(h.deps)).listed.map((a) => a.appId)).toEqual(["demo", "other"]);
    await expect(upsertApp(h.deps, record({ appId: "third", origin: "https://t.example", runnerId: "r3" }))).resolves.toBeUndefined();
    expect((await readAppList(h.deps)).listed.map((a) => a.appId)).toEqual(["demo", "other", "third"]);
  });

  it("an app.json that disagrees with the list about id or origin is a hard error", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    await writeFile(appPathsOf(h.deps, "demo").appFile, JSON.stringify({ version: 1, ...record({ origin: "https://evil.example" }) }));
    await expect(loadApps(h.deps)).rejects.toThrow(/https:\/\/evil\.example.*lists demo at https:\/\/demo\.example/);
    await writeFile(appPathsOf(h.deps, "demo").appFile, JSON.stringify({ version: 2, ...record() }));
    await expect(loadApps(h.deps)).rejects.toThrow(/not a valid app record/);
  });

  it("an invalid entry in apps.json is a hard error that a later save cannot turn into a silent drop", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    const text = JSON.stringify({ version: 2, apps: [{ appId: "demo", origin: "https://demo.example" }, { appId: "Bad.Id", origin: 5 }] });
    await writeFile(appsFilePath(h.deps), text);
    await expect(loadApps(h.deps)).rejects.toThrow(/app entry #2 \(Bad\.Id\) is not valid/);
    await expect(upsertApp(h.deps, record({ appId: "other", runnerId: "r2" }))).rejects.toThrow(/not valid/);
    await expect(removeApp(h.deps, "demo")).rejects.toThrow(/not valid/);
    expect(await readFile(appsFilePath(h.deps), "utf8")).toBe(text);
  });

  it("app ids must be folder names: lowercase, no dots or slashes, `bridge` reserved", () => {
    for (const ok of ["demo", "my-app", "a1"]) expect(isSafeAppId(ok)).toBe(true);
    for (const bad of ["", ".", "..", "../x", "a/b", "Demo", "1app", "bridge", "a.b", "a_b", "-x", "a".repeat(64)]) expect(isSafeAppId(bad)).toBe(false);
  });

  it("refuses to write an app.json through a bridge/ dir that is a symlink", async () => {
    h = await harness();
    const target = path.join(h.root, "elsewhere");
    await mkdir(target, { recursive: true });
    await mkdir(path.join(h.deps.configDir, "demo"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(target, path.join(h.deps.configDir, "demo", "bridge"));
    await expect(upsertApp(h.deps, record())).rejects.toThrow(/not a real folder/);
    expect(await exists(path.join(target, "app.json"))).toBe(false);
  });

  it("discoverAppFiles lists the apps that have an app.json of their own, for when apps.json is gone", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    await mkdir(path.join(h.deps.configDir, "unrelated"), { recursive: true });
    expect(await discoverAppFiles(h.deps)).toEqual([{ appId: "demo", file: appPathsOf(h.deps, "demo").appFile }]);
  });
});

describe("local app records", () => {
  const local = (over: Partial<LocalAppRecord> = {}): LocalAppRecord => ({ kind: "local", appId: "sample-app", name: "Sample app", origin: LOCAL_ORIGIN, createdAt: "2026-11-04T00:00:00.000Z", ...over });
  /** Lists a local app, then replaces its app.json with `body` (a full record, or the local one plus a stray field). */
  const writeLocal = async (body: object): Promise<void> => {
    await upsertApp(h.deps, local());
    await writeFile(appPathsOf(h.deps, "sample-app").appFile, JSON.stringify({ version: 1, ...body }));
  };

  it("round trip: the list says origin `local`, app.json carries kind `local` and no relay field", async () => {
    h = await harness();
    await upsertApp(h.deps, local());
    expect(JSON.parse(await readFile(appsFilePath(h.deps), "utf8"))).toEqual({ version: 2, apps: [{ appId: "sample-app", origin: "local" }] });
    const file = appPathsOf(h.deps, "sample-app").appFile;
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, ...local() });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readAppFile(h.deps, { appId: "sample-app", origin: "local" })).toEqual(local());
  });

  it("loadApps returns both kinds, told apart by isLocalApp; a hosted record on disk has no kind", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    await upsertApp(h.deps, local());
    const apps = await loadAllApps(h.deps);
    expect(apps.map((a) => [a.appId, isLocalApp(a)])).toEqual([["demo", false], ["sample-app", true]]);
    expect(JSON.parse(await readFile(appPathsOf(h.deps, "demo").appFile, "utf8"))).not.toHaveProperty("kind");
  });

  it("a local record that carries any relay field is not a record (one kind, never both)", async () => {
    h = await harness();
    for (const extra of [{ relayUrl: "wss://x/relay" }, { runnerId: "r1" }, { auth: record().auth }, { url: "https://x/" }, { protocol: { min: 1, max: 1 } }, { enrollPage: "/e" }, { connectedAt: "2026-01-01T00:00:00.000Z" }]) {
      await writeLocal({ ...local(), ...extra });
      await expect(loadAllApps(h.deps), JSON.stringify(extra)).rejects.toThrow(/not a valid app record/);
    }
    // Nor is a hosted record that claims the marker origin, or a record with an unknown kind.
    await writeLocal(local());
    await expect(loadAllApps(h.deps)).resolves.toHaveLength(1);
    await writeLocal({ ...local(), kind: "other" });
    await expect(loadAllApps(h.deps)).rejects.toThrow(/not a valid app record/);
    await writeLocal(record({ appId: "sample-app", origin: "local" }));
    await expect(loadAllApps(h.deps)).rejects.toThrow(/not a valid app record/);
  });

  it("resolveApp refuses a local app by id, name or as the only app, and still finds hosted apps beside it", async () => {
    h = await harness();
    await upsertApp(h.deps, local());
    for (const name of ["sample-app", "Sample app"]) await expect(resolveApp(h.deps, name)).rejects.toThrow("sample-app is a local app: it has no relay, sign-in, browsers or enrollment");
    await expect(resolveApp(h.deps, undefined)).rejects.toThrow(/sample-app: local, no relay/);
    // The origin marker is no name to resolve by.
    await expect(resolveApp(h.deps, "local")).rejects.toThrow(/no connected app 'local'/);
    await upsertApp(h.deps, record());
    expect((await resolveApp(h.deps, undefined)).appId).toBe("demo");
    expect((await resolveApp(h.deps, "demo")).appId).toBe("demo");
  });
});
