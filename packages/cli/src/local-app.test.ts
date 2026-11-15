import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";
import { appsFilePath, isLocalApp, loadApps, upsertApp } from "./config.js";
import { appPathsOf } from "./paths.js";
import { type Harness, exists, harness, record } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const mode = async (p: string): Promise<number> => (await stat(p)).mode & 0o777;
const listFile = async (hh: Harness): Promise<unknown> => JSON.parse(await readFile(appsFilePath(hh.deps), "utf8"));

describe("bridge apps add-local", () => {
  it("creates the app record (0600, kind local, no relay field), lists it under the origin `local` and makes the config dir 0700", async () => {
    h = await harness();
    expect(await runCli(["apps", "add-local", "sample-app", "--name", "Sample app", "--yes"], h.deps)).toBe(0);
    const p = appPathsOf(h.deps, "sample-app");
    const stored = JSON.parse(await readFile(p.appFile, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({ version: 1, kind: "local", appId: "sample-app", name: "Sample app", origin: "local" });
    expect(typeof stored.createdAt).toBe("string");
    for (const field of ["url", "relayUrl", "auth", "protocol", "enrollPage", "runnerId", "connectedAt"]) expect(stored, field).not.toHaveProperty(field);
    expect(await listFile(h)).toEqual({ version: 2, apps: [{ appId: "sample-app", origin: "local" }] });
    expect(await mode(p.appFile)).toBe(0o600);
    expect(await mode(appsFilePath(h.deps))).toBe(0o600);
    expect(await mode(p.configDir)).toBe(0o700);
    expect(h.out.join("")).toContain("Created local app Sample app (sample-app). Install its plugins with `bridge plugin add`, then `bridge run`.");
    expect(await h.deps.credentials!.get("sample-app/pairing.tokens")).toBeNull();
    expect((h.deps.credentials as unknown as { data: Map<string, string> }).data.size).toBe(0);
    const apps = await loadApps(h.deps);
    expect(apps.map((a) => [a.appId, isLocalApp(a)])).toEqual([["sample-app", true]]);
  });

  it("the name defaults to the id and has control characters dropped", async () => {
    h = await harness();
    expect(await runCli(["apps", "add-local", "plain", "--yes"], h.deps)).toBe(0);
    expect(await runCli(["apps", "add-local", "fancy", "--name", "Fancy\u001b[2K app", "--yes"], h.deps)).toBe(0);
    expect((await loadApps(h.deps)).map((a) => a.name)).toEqual(["plain", "Fancy[2K app"]);
  });

  it("prints every path before the question, asks `Create local app <name> (<id>)?`, and a no leaves nothing behind", async () => {
    h = await harness();
    h.deps.isTTY = true;
    const p = appPathsOf(h.deps, "sample-app");
    let printed = "";
    h.deps.confirm = async (q) => {
      printed = h.out.join("");
      h.questions.push(q);
      return false;
    };
    expect(await runCli(["apps", "add-local", "sample-app", "--name", "Sample app"], h.deps)).toBe(1);
    for (const f of [appsFilePath(h.deps), p.appFile, p.configDir, p.dataDir, p.stateDir]) expect(printed).toContain(f);
    expect(printed).toContain("its parent is created only when missing and never changed");
    expect(h.questions).toEqual(["Create local app Sample app (sample-app)?"]);
    expect(h.err.join("")).toContain("cancelled");
    expect(await exists(appsFilePath(h.deps))).toBe(false);
    expect(await exists(p.parents.config)).toBe(false);
  });

  it("--yes skips the question but still prints the paths; with no terminal and no --yes it fails before writing anything and never asks", async () => {
    h = await harness();
    const p = appPathsOf(h.deps, "sample-app");
    expect(await runCli(["apps", "add-local", "sample-app"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("no terminal to ask on; pass --yes");
    expect(h.questions).toEqual([]);
    expect(await exists(appsFilePath(h.deps))).toBe(false);
    expect(await exists(p.parents.config)).toBe(false);
    h.out.length = 0;
    expect(await runCli(["apps", "add-local", "sample-app", "--yes"], h.deps)).toBe(0);
    expect(h.questions).toEqual([]);
    expect(h.out.join("")).toContain(p.configDir);
  });

  it("refuses an invalid or reserved id with the folder rule's message, writing nothing", async () => {
    h = await harness();
    for (const id of ["Bad.Id", "bridge", "1abc", "has space", "x".repeat(64), "../escape"]) {
      h.err.length = 0;
      expect(await runCli(["apps", "add-local", id, "--yes"], h.deps), id).toBe(1);
      expect(h.err.join(""), id).toContain("invalid app folder name");
    }
    expect(await exists(appsFilePath(h.deps))).toBe(false);
    expect(await exists(h.deps.configDir)).toBe(false);
  });

  it("refuses an id that is a hosted app, naming its origin and the command to run first", async () => {
    h = await harness();
    await upsertApp(h.deps, record({ appId: "sample-app", origin: "https://sample.example" }));
    const before = await readFile(appsFilePath(h.deps), "utf8");
    expect(await runCli(["apps", "add-local", "sample-app", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("sample-app is connected to https://sample.example; run `bridge apps remove sample-app` first");
    expect(await readFile(appsFilePath(h.deps), "utf8")).toBe(before);
    expect(JSON.parse(await readFile(appPathsOf(h.deps, "sample-app").appFile, "utf8"))).toMatchObject({ runnerId: "runner-1" });
  });

  it("refuses an unlisted id whose folder holds a hosted app's leftovers, naming the files and writing nothing", async () => {
    h = await harness();
    const p = appPathsOf(h.deps, "sample-app");
    await mkdir(p.configDir, { recursive: true });
    for (const f of ["trust.json", "identity.key"]) await writeFile(path.join(p.configDir, f), "{}");
    expect(await runCli(["apps", "add-local", "sample-app", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toMatch(/already holds trust\.json, identity\.key, left by an earlier app; remove them by hand/);
    expect(await exists(appsFilePath(h.deps))).toBe(false);
    expect(await exists(p.appFile)).toBe(false);
    for (const f of ["app.json", "identity.json", "enroll.json"]) {
      h.err.length = 0;
      await mkdir(appPathsOf(h.deps, "other").configDir, { recursive: true });
      await writeFile(path.join(appPathsOf(h.deps, "other").configDir, f), "{}");
      expect(await runCli(["apps", "add-local", "other", "--yes"], h.deps), f).toBe(1);
      expect(h.err.join(""), f).toContain(f);
      await rm(path.join(appPathsOf(h.deps, "other").configDir, f));
    }
  });

  it("adding the same id again is a no-op success that changes nothing, so an installer can rerun it", async () => {
    h = await harness();
    expect(await runCli(["apps", "add-local", "sample-app", "--name", "First", "--yes"], h.deps)).toBe(0);
    const file = appPathsOf(h.deps, "sample-app").appFile;
    const before = [await readFile(file, "utf8"), await readFile(appsFilePath(h.deps), "utf8")];
    h.out.length = 0;
    expect(await runCli(["apps", "add-local", "sample-app", "--name", "Second"], h.deps)).toBe(0);
    expect(h.out.join("")).toBe("Nothing changed: local app sample-app exists.\n");
    expect(h.questions).toEqual([]);
    expect([await readFile(file, "utf8"), await readFile(appsFilePath(h.deps), "utf8")]).toEqual(before);
  });

  it("is Rule A: refuses when the app's bridge/ dir is a link, and Rule B: nothing is written when the folder changes during the question", async () => {
    h = await harness();
    const p = appPathsOf(h.deps, "sample-app");
    await mkdir(path.dirname(p.configDir), { recursive: true });
    await mkdir(path.join(h.root, "elsewhere"), { recursive: true });
    await symlink(path.join(h.root, "elsewhere"), p.configDir);
    expect(await runCli(["apps", "add-local", "sample-app", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("is not a real folder");
    expect(await exists(appsFilePath(h.deps))).toBe(false);

    h = await harness();
    h.deps.isTTY = true;
    const q = appPathsOf(h.deps, "sample-app");
    h.deps.confirm = async () => {
      // A file appears where the consented plan saw none.
      await mkdir(q.configDir, { recursive: true });
      await writeFile(q.appFile, "{}");
      return true;
    };
    expect(await runCli(["apps", "add-local", "sample-app"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while");
    expect(await exists(appsFilePath(h.deps))).toBe(false);
    expect(await readFile(q.appFile, "utf8")).toBe("{}");
  });

  it("the help lists it, and the run summary says it serves every app", async () => {
    h = await harness();
    expect(await runCli(["apps", "--help"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("apps list [--json] | add-local <app-id> [--name <name>] [--yes] | remove <app> [--yes]");
    expect(h.out.join("")).toContain("List apps, create a local app (no hosted server) or remove one");
    h.out.length = 0;
    expect(await runCli(["--help"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("Serve every app: hold a connection to each connected app's relay and run every app's plugins");
  });

  it("usage: --name belongs to add-local only, and add-local takes exactly one id", async () => {
    h = await harness();
    expect(await runCli(["apps", "list", "--name", "x"], h.deps)).toBe(2);
    expect(await runCli(["apps", "add-local"], h.deps)).toBe(2);
    expect(await runCli(["apps", "add-local", "a", "b", "--yes"], h.deps)).toBe(2);
    expect(await exists(appsFilePath(h.deps))).toBe(false);
  });

  it("round trip beside a hosted app: list shows both, remove deletes the local app only and touches no credential", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    await h.deps.credentials!.set("demo/pairing.tokens", "secret-demo");
    expect(await runCli(["apps", "add-local", "sample-app", "--yes"], h.deps)).toBe(0);
    h.out.length = 0;
    expect(await runCli(["apps", "list"], h.deps)).toBe(0);
    expect(h.out.join("")).toBe("demo\tDemo\thttps://demo.example\trunner runner-1\nsample-app\tsample-app\tlocal\t-\n");
    expect(await runCli(["apps", "remove", "sample-app", "--yes"], h.deps)).toBe(0);
    expect(await listFile(h)).toEqual({ version: 2, apps: [{ appId: "demo", origin: "https://demo.example" }] });
    expect(await exists(appPathsOf(h.deps, "sample-app").configDir)).toBe(false);
    expect(await h.deps.credentials!.get("demo/pairing.tokens")).toBe("secret-demo");
    // Removed, the id is free again.
    expect(await runCli(["apps", "add-local", "sample-app", "--yes"], h.deps)).toBe(0);
  });
});
