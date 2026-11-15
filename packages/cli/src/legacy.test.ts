import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appsFilePath } from "./config.js";
import { runCli } from "./cli.js";
import { assertNoLegacyLayout, legacyLayoutOf, LegacyLayoutError } from "./legacy.js";
import { runnerPathsOf } from "./paths.js";
import { type Harness, harness } from "./testkit.js";
import { CLI_VERSION } from "./version.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

/** One legacy marker per entry, each as a function that creates it under the fake home. */
const markers: Record<string, (h: Harness) => Promise<string>> = {
  "config/bridge/trust": async (h) => dir(path.join(h.deps.configDir, "bridge", "trust")),
  "config/bridge/identity": async (h) => dir(path.join(h.deps.configDir, "bridge", "identity")),
  "config/bridge/identity-key": async (h) => dir(path.join(h.deps.configDir, "bridge", "identity-key")),
  "config/bridge/enroll": async (h) => dir(path.join(h.deps.configDir, "bridge", "enroll")),
  "state/bridge/apps": async (h) => dir(path.join(runnerPathsOf(h.deps).stateDir, "apps")),
  "data/bridge/plugins": async (h) => dir(path.join(h.deps.dataDir, "bridge", "plugins")),
  "data/bridge/plugin-data": async (h) => dir(path.join(h.deps.dataDir, "bridge", "plugin-data")),
  "apps.json without version 2": async (h) => {
    await mkdir(path.dirname(appsFilePath(h.deps)), { recursive: true });
    await writeFile(appsFilePath(h.deps), JSON.stringify({ version: 1, apps: [] }));
    return appsFilePath(h.deps);
  },
  "a marker that is a dangling symlink": async (h) => {
    const file = path.join(h.deps.configDir, "bridge", "trust");
    await mkdir(path.dirname(file), { recursive: true });
    await symlink(path.join(h.root, "nowhere"), file);
    return file;
  },
};

async function dir(p: string): Promise<string> {
  await mkdir(p, { recursive: true });
  return p;
}

/** Every file, dir and link under the fake root, so "nothing changed" is a comparison. */
async function tree(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      out.push(`${path.relative(root, full)}${e.isDirectory() ? "/" : ""}`);
      if (e.isDirectory()) await walk(full);
    }
  };
  await walk(root);
  return out.sort();
}

describe("legacy layout detection", () => {
  it("a clean home has none", async () => {
    h = await harness();
    expect(await legacyLayoutOf(h.deps)).toEqual([]);
    await expect(assertNoLegacyLayout(h.deps)).resolves.toBeUndefined();
  });

  for (const [name, make] of Object.entries(markers)) {
    it(`${name} alone triggers the refusal, which names the path and the fixed way out`, async () => {
      h = await harness();
      const marker = await make(h);
      expect(await legacyLayoutOf(h.deps)).toEqual([marker]);
      const error = await assertNoLegacyLayout(h.deps).then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(LegacyLayoutError);
      const message = (error as Error).message;
      expect(message).toContain(marker);
      expect(message).toContain("run the old `bridge uninstall`, then `bridge setup <url>`");
      expect(message).toContain("There is no migrate command.");
    });
  }

  it("a version 2 apps.json and a broken one are not the older layout", async () => {
    h = await harness();
    await mkdir(path.dirname(appsFilePath(h.deps)), { recursive: true });
    await writeFile(appsFilePath(h.deps), JSON.stringify({ version: 2, apps: [] }));
    expect(await legacyLayoutOf(h.deps)).toEqual([]);
    await writeFile(appsFilePath(h.deps), "{nope");
    expect(await legacyLayoutOf(h.deps)).toEqual([]);
  });

  it("names the binary of an older installed version too, since the launcher may point at the new one", async () => {
    h = await harness();
    await markers["config/bridge/trust"]!(h);
    const old = path.join(runnerPathsOf(h.deps).versionsDir, "0.0.9", "node_modules", ".bin", "bridge");
    await mkdir(path.dirname(old), { recursive: true });
    await writeFile(old, "");
    const same = path.join(runnerPathsOf(h.deps).versionsDir, CLI_VERSION, "node_modules", ".bin", "bridge");
    await mkdir(path.dirname(same), { recursive: true });
    await writeFile(same, "");
    const message = await assertNoLegacyLayout(h.deps).then(() => "", (e: Error) => e.message);
    expect(message).toContain(old);
    expect(message).not.toContain(same);
  });
});

describe("every command refuses an older layout before any consent or write", () => {
  const commands: [string, string[]][] = [
    ["setup", ["setup", "https://app.example", "--yes"]],
    ["setup --plan", ["setup", "https://app.example", "--plan"]],
    ["setup --json", ["setup", "https://app.example", "--yes", "--json"]],
    ["self install", ["self", "install", "--yes"]],
    ["connect", ["connect", "https://app.example", "--yes"]],
    ["run", ["run"]],
    ["enroll", ["enroll", "demo"]],
    ["enroll approve", ["enroll", "approve", "demo", "--words", "a b c d"]],
    ["enroll deny", ["enroll", "deny", "demo"]],
    ["status", ["status"]],
    ["browsers", ["browsers", "list"]],
    ["apps list", ["apps", "list"]],
    ["apps remove", ["apps", "remove", "demo", "--yes"]],
    ["plugin list", ["plugin", "list"]],
    ["plugin add", ["plugin", "add", "/nonexistent", "--yes"]],
    ["service install", ["service", "install", "--yes"]],
    ["protocol install", ["protocol", "install", "--yes"]],
    ["uninstall", ["uninstall", "--yes"]],
  ];

  for (const [name, argv] of commands) {
    it(`${name}: exit 1, the fixed message, nothing written, no request`, async () => {
      h = await harness();
      let requests = 0;
      h.deps.fetch = (async () => {
        requests += 1;
        throw new Error("no network");
      }) as typeof fetch;
      // A decoy next to every kind of old path, so a stray write or removal would show.
      await markers["config/bridge/trust"]!(h);
      await markers["state/bridge/apps"]!(h);
      await markers["data/bridge/plugins"]!(h);
      await writeFile(path.join(h.deps.configDir, "bridge", "trust", "decoy.json"), "mine");
      const before = await tree(h.root);
      expect(await runCli(argv, h.deps), name).toBe(1);
      expect(h.err.join("") + h.out.join("")).toContain("an older bridge layout is present");
      expect(h.err.join("") + h.out.join("")).toContain("run the old `bridge uninstall`, then `bridge setup <url>`");
      expect(await tree(h.root)).toEqual(before);
      expect(await readFile(path.join(h.deps.configDir, "bridge", "trust", "decoy.json"), "utf8")).toBe("mine");
      expect(h.questions).toEqual([]);
      expect(h.commands).toEqual([]);
      expect(requests).toBe(0);
    });
  }

  it("setup --json reports the refusal as an error event", async () => {
    h = await harness();
    await markers["config/bridge/enroll"]!(h);
    expect(await runCli(["setup", "https://app.example", "--yes", "--json"], h.deps)).toBe(1);
    const events = h.out.join("").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events).toEqual([expect.objectContaining({ event: "error", code: "legacy_layout" })]);
  });

  it("doctor warns and still prints (and --paths warns on stderr)", async () => {
    h = await harness();
    await markers["config/bridge/identity"]!(h);
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("WARNING: an older bridge layout is present");
    h.out.length = 0;
    expect(await runCli(["doctor", "--paths"], h.deps)).toBe(0);
    expect(h.err.join("")).toContain("an older bridge layout is present");
    expect(h.out.join("")).toContain(path.join(h.deps.configDir, "bridge", "apps.json"));
  });

  it("the new uninstall never touches the older folders: it refuses and lists them", async () => {
    h = await harness();
    const trust = await markers["config/bridge/trust"]!(h);
    await writeFile(path.join(trust, "demo.runner-1.json"), "[]");
    expect(await runCli(["uninstall", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain(trust);
    expect(await readFile(path.join(trust, "demo.runner-1.json"), "utf8")).toBe("[]");
  });
});
