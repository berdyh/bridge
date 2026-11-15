import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginManifest } from "@berdyh/bridge-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appPathsOf } from "../paths.js";
import type { ConsentedGrant, GrantSurface } from "./contracts.js";
import { createConsentStore, diffSurfaces, surfaceOf, surfaceSha256Of } from "./consent.js";

const manifest = (permissions: PluginManifest["permissions"]): PluginManifest => ({ id: "alpha", app: "app-a", entry: "entry.js", permissions });
const full = manifest({
  agents: ["codex", "claude"], network: ["b.example.com", "a.example.com"], fs: ["$PLUGIN_DATA"], localUi: { port: "auto" },
  mcpServers: { notes: { entry: "dist/notes.js", args: ["--data", "${PLUGIN_DATA}"] }, corpus: { entry: "dist/corpus.js" } },
  headless: { tools: ["mcp__notes__append", "mcp__corpus__read"] },
});

let temp: string;
beforeEach(async () => { temp = await mkdtemp(fileURLToPath(new URL(".test-", import.meta.url))); });
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });
const paths = () => appPathsOf({ config: path.join(temp, "config"), data: path.join(temp, "data"), state: path.join(temp, "state") }, "app-a");
const grantFor = (surface: GrantSurface, extra: Partial<ConsentedGrant> = {}): ConsentedGrant => ({
  pluginId: "alpha", appId: "app-a", version: "1.0.0", surface, surfaceSha256: surfaceSha256Of(surface), time: "2026-11-02T10:00:00.000Z", ...extra,
});
const recordFile = () => path.join(paths().consentDir, "alpha.consent.json");

describe("grant surface", () => {
  it("lists what a manifest asks for as canonical items, sorted by kind then value", () => {
    expect(surfaceOf(full).items).toEqual([
      { kind: "agent", value: "claude" }, { kind: "agent", value: "codex" },
      { kind: "fs", value: "$PLUGIN_DATA" },
      { kind: "headlessTool", value: "mcp__corpus__read" }, { kind: "headlessTool", value: "mcp__notes__append" },
      { kind: "localUi", value: "auto" },
      { kind: "mcpServer", value: JSON.stringify({ name: "corpus", entry: "dist/corpus.js", args: [] }) },
      { kind: "mcpServer", value: JSON.stringify({ name: "notes", entry: "dist/notes.js", args: ["--data", "${PLUGIN_DATA}"] }) },
      { kind: "network", value: "a.example.com" }, { kind: "network", value: "b.example.com" },
    ]);
    expect(surfaceOf(manifest({})).items).toEqual([]);
    expect(surfaceOf(manifest({ localUi: { port: 4321 } })).items).toEqual([{ kind: "localUi", value: "4321" }]);
  });
  it("hashes the canonical JSON: the same surface in any order gives one hash, any change another", () => {
    const surface = surfaceOf(full);
    expect(surfaceSha256Of(surface)).toMatch(/^[0-9a-f]{64}$/);
    expect(surfaceSha256Of({ items: [...surface.items].reverse() })).toBe(surfaceSha256Of(surface));
    expect(surfaceSha256Of({ items: [...surface.items, surface.items[0]!] })).toBe(surfaceSha256Of(surface));
    expect(surfaceSha256Of({ items: surface.items.slice(1) })).not.toBe(surfaceSha256Of(surface));
    // A changed server argument is a different item, hence a different hash.
    const other = surfaceOf(manifest({ ...full.permissions, mcpServers: { ...full.permissions.mcpServers, notes: { entry: "dist/notes.js", args: ["--data", "/etc"] } } }));
    expect(surfaceSha256Of(other)).not.toBe(surfaceSha256Of(surface));
  });
  it("diffs a surface against the consented one", () => {
    const before = surfaceOf(manifest({ agents: ["claude"], network: ["a.example.com"] }));
    const after = surfaceOf(manifest({ agents: ["claude", "codex"], fs: ["$PLUGIN_DATA"] }));
    expect(diffSurfaces(before, after)).toEqual({
      added: [{ kind: "agent", value: "codex" }, { kind: "fs", value: "$PLUGIN_DATA" }],
      removed: [{ kind: "network", value: "a.example.com" }],
      unchanged: [{ kind: "agent", value: "claude" }],
    });
    expect(diffSurfaces(undefined, after)).toEqual({ added: after.items, removed: [], unchanged: [] });
    expect(diffSurfaces(after, after)).toEqual({ added: [], removed: [], unchanged: after.items });
  });
});

describe("consent store", () => {
  it("writes a private record and reads it back; a missing record reads as none", async () => {
    const store = createConsentStore({ paths: paths() });
    expect(await store.read("alpha")).toBeUndefined();
    const grant = grantFor(surfaceOf(full));
    await store.write(grant);
    expect(await store.read("alpha")).toEqual(grant);
    expect(JSON.parse(await readFile(recordFile(), "utf8"))).toEqual({
      pluginId: "alpha", appId: "app-a", version: "1.0.0", surfaceSha256: grant.surfaceSha256, surface: grant.surface, time: grant.time,
    });
    expect((await stat(recordFile())).mode & 0o777).toBe(0o600);
    expect((await stat(paths().consentDir)).mode & 0o777).toBe(0o700);
    expect(await readdir(paths().consentDir)).toEqual(["alpha.consent.json"]);
    // A second write replaces the record.
    const wider = grantFor(surfaceOf(manifest({ agents: ["claude"] })), { version: "2.0.0" });
    await store.write(wider);
    expect(await store.read("alpha")).toEqual(wider);
    expect(await readdir(paths().consentDir)).toEqual(["alpha.consent.json"]);
  });
  it("revokes by deleting the record, and revoking again is fine", async () => {
    const store = createConsentStore({ paths: paths() });
    await store.revoke("alpha");
    await store.write(grantFor(surfaceOf(full)));
    await store.revoke("alpha");
    expect(await store.read("alpha")).toBeUndefined();
    await store.revoke("alpha");
    expect(await readdir(paths().consentDir)).toEqual([]);
  });
  it("treats a hand-edited record whose hash no longer matches its surface as no consent", async () => {
    const store = createConsentStore({ paths: paths() });
    await store.write(grantFor(surfaceOf(manifest({ agents: ["claude"] }))));
    const record = JSON.parse(await readFile(recordFile(), "utf8"));
    record.surface.items.push({ kind: "headlessTool", value: "mcp__notes__rm" });
    await writeFile(recordFile(), JSON.stringify(record));
    expect(await store.read("alpha")).toBeUndefined();
  });
  it("does not accept another plugin's or app's record copied under this name", async () => {
    const store = createConsentStore({ paths: paths() });
    await store.write(grantFor(surfaceOf(full)));
    const record = JSON.parse(await readFile(recordFile(), "utf8"));
    await writeFile(recordFile(), JSON.stringify({ ...record, pluginId: "beta" }));
    expect(await store.read("alpha")).toBeUndefined();
    await writeFile(recordFile(), JSON.stringify({ ...record, appId: "app-b" }));
    expect(await store.read("alpha")).toBeUndefined();
  });
  it("throws on a record it cannot read, and refuses a write that does not hold together", async () => {
    const store = createConsentStore({ paths: paths() });
    await store.write(grantFor(surfaceOf(full)));
    await writeFile(recordFile(), "{not json");
    await expect(store.read("alpha")).rejects.toThrow("not valid JSON");
    await writeFile(recordFile(), JSON.stringify({ pluginId: "alpha" }));
    await expect(store.read("alpha")).rejects.toThrow("unexpected shape");
    await expect(store.write(grantFor(surfaceOf(full), { surfaceSha256: "0".repeat(64) }))).rejects.toThrow("does not match");
    await expect(store.write(grantFor(surfaceOf(full), { appId: "app-b" }))).rejects.toThrow("app-b");
    await expect(store.read("../alpha")).rejects.toThrow("Invalid plugin id");
    await expect(store.revoke("bridge")).rejects.toThrow("Invalid plugin id");
  });

  describe("the folder's mode", () => {
    it.each([0o755, 0o775, 0o777, 0o750, 0o705])("hardens an existing consent folder of mode %o to 0700 before the record goes in", async (mode) => {
      const store = createConsentStore({ paths: paths() });
      await mkdir(paths().consentDir, { recursive: true });
      await chmod(paths().consentDir, mode);
      await store.write(grantFor(surfaceOf(full)));
      expect((await stat(paths().consentDir)).mode & 0o777).toBe(0o700);
      expect((await stat(recordFile())).mode & 0o777).toBe(0o600);
      expect(await store.read("alpha")).toEqual(grantFor(surfaceOf(full)));
    });
    it("leaves a private folder as it is, and refuses (writing nothing) when the folder cannot be made private", async () => {
      const store = createConsentStore({ paths: paths() });
      await store.write(grantFor(surfaceOf(full)));
      await store.write(grantFor(surfaceOf(full), { version: "1.1.0" }));
      expect((await stat(paths().consentDir)).mode & 0o777).toBe(0o700);
      // A folder that is not a directory at all (here a file in its place) is refused, not replaced.
      await rm(paths().consentDir, { recursive: true });
      await writeFile(paths().consentDir, "not a folder");
      await expect(store.write(grantFor(surfaceOf(full)))).rejects.toThrow();
      expect(await readFile(paths().consentDir, "utf8")).toBe("not a folder");
    });
  });

  describe("a bound folder", () => {
    // `<config>/app-a` may be a link that exists when the folder is bound; moving it afterwards is a different folder.
    async function boundThenRetargeted() {
      const first = path.join(temp, "first"); const second = path.join(temp, "second");
      await mkdir(first); await mkdir(second);
      const link = paths().parents.config;
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(first, link);
      const store = createConsentStore({ paths: paths() });
      await store.write(grantFor(surfaceOf(full)));
      const bound = await store.bind();
      expect(bound).toBe(path.join(first, "bridge", "plugins"));
      await rm(link); await symlink(second, link);
      return { store, bound, first, second };
    }
    it("refuses read, write and revoke once the folder resolves elsewhere, and touches neither place", async () => {
      const { store, bound, first, second } = await boundThenRetargeted();
      await expect(store.read("alpha", bound)).rejects.toThrow("moved during confirmation");
      await expect(store.write(grantFor(surfaceOf(full)), bound)).rejects.toThrow("moved during confirmation");
      await expect(store.revoke("alpha", bound)).rejects.toThrow("moved during confirmation");
      expect(await readdir(second)).toEqual([]);
      expect(await readdir(path.join(first, "bridge", "plugins"))).toEqual(["alpha.consent.json"]);
      // Unbound, the store acts on wherever the folder is now (nothing was promised about a place).
      expect(await store.read("alpha")).toBeUndefined();
    });
    it("acts as usual while the folder is where it was bound, and refuses a link planted at it", async () => {
      const store = createConsentStore({ paths: paths() });
      const bound = await store.bind();
      await store.write(grantFor(surfaceOf(full)), bound);
      expect(await store.read("alpha", bound)).toEqual(grantFor(surfaceOf(full)));
      await store.revoke("alpha", bound);
      expect(await store.read("alpha", bound)).toBeUndefined();
      await rm(paths().consentDir, { recursive: true });
      await mkdir(path.join(temp, "decoy"));
      await symlink(path.join(temp, "decoy"), paths().consentDir);
      await expect(store.write(grantFor(surfaceOf(full)), bound)).rejects.toThrow("symlink");
      await expect(store.bind()).rejects.toThrow("symlink");
    });
  });

  describe("links", () => {
    const decoy = () => path.join(temp, "decoy");
    it("refuses a consent record that is a symlink, on read, write and revoke, and leaves its target alone", async () => {
      const store = createConsentStore({ paths: paths() });
      await mkdir(paths().consentDir, { recursive: true });
      await mkdir(decoy());
      await writeFile(path.join(decoy(), "target.json"), "untouched");
      await symlink(path.join(decoy(), "target.json"), recordFile());
      await expect(store.read("alpha")).rejects.toThrow("symlink");
      await expect(store.write(grantFor(surfaceOf(full)))).rejects.toThrow("symlink");
      await expect(store.revoke("alpha")).rejects.toThrow("symlink");
      expect(await readFile(path.join(decoy(), "target.json"), "utf8")).toBe("untouched");
      expect(await readdir(decoy())).toEqual(["target.json"]);
    });
    it("refuses a consent folder that is a symlink and writes nothing through it", async () => {
      const store = createConsentStore({ paths: paths() });
      await mkdir(path.dirname(paths().consentDir), { recursive: true });
      await mkdir(decoy());
      await symlink(decoy(), paths().consentDir);
      await expect(store.read("alpha")).rejects.toThrow("symlink");
      await expect(store.write(grantFor(surfaceOf(full)))).rejects.toThrow("symlink");
      await expect(store.revoke("alpha")).rejects.toThrow("symlink");
      expect(await readdir(decoy())).toEqual([]);
    });
    it("refuses a symlinked bridge folder, but accepts a symlinked <config>/<app> parent", async () => {
      const store = createConsentStore({ paths: paths() });
      const parent = paths().parents.config;
      await mkdir(path.join(decoy(), "bridge"), { recursive: true });
      // <config>/app-a/bridge is the link.
      await mkdir(parent, { recursive: true });
      await symlink(path.join(decoy(), "bridge"), paths().configDir);
      await expect(store.write(grantFor(surfaceOf(full)))).rejects.toThrow("symlink");
      expect(await readdir(path.join(decoy(), "bridge"))).toEqual([]);
      await rm(paths().configDir);
      await rm(parent, { recursive: true });
      // <config>/app-a is a link to a real folder: allowed, as for the plugin folders.
      const real = path.join(temp, "real-parent");
      await mkdir(real);
      await symlink(real, parent);
      await store.write(grantFor(surfaceOf(full)));
      expect(await store.read("alpha")).toEqual(grantFor(surfaceOf(full)));
      expect(await readdir(path.join(real, "bridge", "plugins"))).toEqual(["alpha.consent.json"]);
    });
  });
});
