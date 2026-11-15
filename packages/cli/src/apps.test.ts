import { chmod, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";
import { type LocalAppRecord, appsFilePath, loadApps, printable, readAppList, removeApp, resolveApp, tokenKey, upsertApp } from "./config.js";
import { appPathsOf } from "./paths.js";
import { type Harness, harness, exists, record } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("apps", () => {
  it("lists apps, and says so when there are none", async () => {
    h = await harness();
    expect(await runCli(["apps", "list"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("No apps connected. Run `bridge connect <app-url>` or `bridge apps add-local <app-id>`.");
    await upsertApp(h.deps, record());
    h.out.length = 0;
    await runCli(["apps", "list"], h.deps);
    expect(h.out.join("")).toContain("demo\tDemo\thttps://demo.example\trunner runner-1");
  });

  it("lists the app records as JSON for scripts and agents, [] when there are none", async () => {
    h = await harness();
    expect(await runCli(["apps", "list", "--json"], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual([]);
    await upsertApp(h.deps, record({ enrollPage: "/bridge/enroll" }));
    h.out.length = 0;
    expect(await runCli(["apps", "list", "--json"], h.deps)).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0]!)).toEqual([record({ enrollPage: "/bridge/enroll" })]);
    expect(await runCli(["apps", "remove", "demo", "--json"], h.deps)).toBe(2);
  });

  it("remove refuses an app whose parent folder contains a base dir (an app named systemd holds the service dir), before anything is touched", async () => {
    h = await harness();
    await upsertApp(h.deps, record({ appId: "systemd", origin: "https://systemd.example" }));
    const p = appPathsOf(h.deps, "systemd");
    await mkdir(path.join(h.deps.configDir, "systemd", "user"), { recursive: true });
    await h.deps.credentials!.set(tokenKey("systemd"), "token");
    expect(await runCli(["apps", "remove", "systemd", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toMatch(/refusing to remove .*systemd: it is, or contains, .*systemd\/user/);
    expect(await h.deps.credentials!.get(tokenKey("systemd"))).toBe("token");
    expect(await exists(p.appFile)).toBe(true);
    expect((await readAppList(h.deps)).listed.map((a) => a.appId)).toEqual(["systemd"]);
  });

  it("remove keeps the app recorded (app.json and apps.json) when a folder cannot be removed, and the retry finishes", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    const p = appPathsOf(h.deps, "demo");
    await mkdir(path.join(p.stateDir, "work"), { recursive: true });
    await writeFile(path.join(p.stateDir, "work", "notes.txt"), "work");
    await writeFile(path.join(p.configDir, "trust.json"), "[]");
    await chmod(p.stateDir, 0o000);
    try {
      expect(await runCli(["apps", "remove", "demo", "--yes"], h.deps)).toBe(1);
    } finally {
      await chmod(p.stateDir, 0o700);
    }
    expect(await exists(p.appFile)).toBe(true);
    expect(await exists(path.join(p.configDir, "trust.json"))).toBe(true);
    expect((await readAppList(h.deps)).listed.map((a) => a.appId)).toEqual(["demo"]);
    expect(await runCli(["apps", "remove", "demo", "--yes"], h.deps)).toBe(0);
    for (const dir of [p.parents.config, p.parents.data, p.parents.state]) expect(await exists(dir)).toBe(false);
    expect((await readAppList(h.deps)).listed).toEqual([]);
  });

  it("remove of a half-removed app (app.json gone) says the wrapping key went with the half removal, and removes the rest", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    const p = appPathsOf(h.deps, "demo");
    await rm(p.appFile);
    expect(await runCli(["apps", "remove", "demo", "--yes"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("a half removal by bridge already deleted it");
    expect(await exists(p.parents.config)).toBe(false);
    expect((await readAppList(h.deps)).listed).toEqual([]);
  });

  it("remove of a half-removed app under BRIDGE_CREDENTIAL_STORE=file:<dir> names the credential files and no keychain", async () => {
    h = await harness();
    h.deps.env.BRIDGE_CREDENTIAL_STORE = `file:${h.root}/creds`;
    await upsertApp(h.deps, record());
    await rm(appPathsOf(h.deps, "demo").appFile);
    expect(await runCli(["apps", "remove", "demo", "--yes"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("Also deleted from the credential files (BRIDGE_CREDENTIAL_STORE): the sign-in token of demo");
    expect(h.out.join("")).toContain("(credential items go first)");
    expect(h.out.join("")).not.toContain("keychain");
  });

  it("remove refuses when the record changes kind during the question (corrupt, then gone): the consent's wording no longer holds", async () => {
    h = await harness();
    h.deps.isTTY = true; // the prompt only exists on a terminal
    await upsertApp(h.deps, record());
    const p = appPathsOf(h.deps, "demo");
    await writeFile(p.appFile, "{nope");
    h.deps.confirm = async () => {
      await rm(p.appFile);
      return true;
    };
    expect(await runCli(["apps", "remove", "demo"], h.deps)).toBe(1);
    expect(h.out.join("")).toContain("Its record is unreadable");
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await exists(p.configDir)).toBe(true);
    expect((await readAppList(h.deps)).listed.map((a) => a.appId)).toEqual(["demo"]);
  });

  /** Fills an app's three bridge/ dirs the way a connected, enrolled, working app has them. */
  async function populate(appId: string): Promise<void> {
    const p = appPathsOf(h.deps, appId);
    for (const [file, body] of [[p.trustFile, "{}"], [p.identityFile, "{}"], [p.enrollFile, "{}"], [path.join(p.pluginsDir, "x", "1.0.0", "entry.js"), ""], [path.join(p.workDir, "notes.txt"), "work"], [path.join(p.tmpDir, "s1", "f"), ""]] as const) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body);
    }
  }

  async function twoApps(): Promise<void> {
    await upsertApp(h.deps, record());
    await upsertApp(h.deps, record({ appId: "other", name: "Other", origin: "https://other.example", runnerId: "runner-2" }));
    await h.deps.credentials!.set(tokenKey("demo"), "secret-demo");
    await h.deps.credentials!.set(tokenKey("other"), "secret-other");
    await h.deps.credentials!.set("bridge/e2ee-identity-key/demo/runner-1", "wrap-demo");
    await h.deps.credentials!.set("bridge/e2ee-identity-key/other/runner-2", "wrap-other");
    await populate("demo");
    await populate("other");
  }

  it("remove lists every path and the keychain items before it asks, cancels cleanly, and --yes still prints them", async () => {
    h = await harness();
    h.deps.isTTY = true; // the prompt only exists on a terminal
    await twoApps();
    const demo = appPathsOf(h.deps, "demo");
    let printed = "";
    h.deps.confirm = async (q) => {
      printed = h.out.join("");
      h.questions.push(q);
      return false;
    };
    expect(await runCli(["apps", "remove", "demo"], h.deps)).toBe(1);
    for (const p of [demo.configDir, demo.dataDir, demo.stateDir, demo.parents.config, demo.parents.data, demo.parents.state, appsFilePath(h.deps)]) expect(printed).toContain(p);
    expect(printed).toContain("Removed only if empty");
    expect(printed).toContain("sign-in token and the identity's key wrapping key of demo");
    expect(h.err.join("")).toContain("cancelled");
    expect((await loadApps(h.deps)).map((a) => a.appId)).toEqual(["demo", "other"]);
    expect(await exists(demo.trustFile)).toBe(true);
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBe("secret-demo");

    h.out.length = 0;
    h.questions.length = 0;
    expect(await runCli(["apps", "remove", "demo", "--yes"], h.deps)).toBe(0);
    expect(h.questions).toEqual([]);
    expect(h.out.join("")).toContain(demo.configDir);
  });

  it("remove forgets the record, both keychain items and the three dirs of that app only; the other app and the keychain names stay", async () => {
    h = await harness();
    h.deps.isTTY = true; // the prompt only exists on a terminal
    await twoApps();
    const demo = appPathsOf(h.deps, "demo");
    const other = appPathsOf(h.deps, "other");
    expect(await runCli(["apps", "remove", "demo"], h.deps)).toBe(0);
    expect((await loadApps(h.deps)).map((a) => a.appId)).toEqual(["other"]);
    expect(JSON.parse(await readFile(appsFilePath(h.deps), "utf8"))).toEqual({ version: 2, apps: [{ appId: "other", origin: "https://other.example" }] });
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBeNull();
    expect(await h.deps.credentials!.get("bridge/e2ee-identity-key/demo/runner-1")).toBeNull();
    expect(await h.deps.credentials!.get(tokenKey("other"))).toBe("secret-other");
    expect(await h.deps.credentials!.get("bridge/e2ee-identity-key/other/runner-2")).toBe("wrap-other");
    for (const d of [demo.configDir, demo.dataDir, demo.stateDir]) expect(await exists(d)).toBe(false);
    for (const f of [other.trustFile, other.identityFile, other.enrollFile, other.appFile, path.join(other.workDir, "notes.txt"), path.join(other.pluginsDir, "x", "1.0.0", "entry.js")]) expect(await exists(f)).toBe(true);
  });

  it("with no other file in an app's parents they go too; a decoy next to bridge/ keeps its parent", async () => {
    h = await harness();
    await twoApps();
    const demo = appPathsOf(h.deps, "demo");
    const other = appPathsOf(h.deps, "other");
    await writeFile(path.join(other.parents.config, "their-config.toml"), "the app's own");
    await writeFile(path.join(other.parents.state, "their.log"), "the app's own");
    expect(await runCli(["apps", "remove", "demo", "--yes"], h.deps)).toBe(0);
    for (const p of [demo.parents.config, demo.parents.data, demo.parents.state]) expect(await exists(p)).toBe(false);
    expect(await runCli(["apps", "remove", "other", "--yes"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("Left in place");
    expect(await readFile(path.join(other.parents.config, "their-config.toml"), "utf8")).toBe("the app's own");
    expect(await readFile(path.join(other.parents.state, "their.log"), "utf8")).toBe("the app's own");
    expect(await exists(other.configDir)).toBe(false);
    expect(await exists(other.parents.data)).toBe(false);
    // The files outside the app's folders are never touched.
    expect(await exists(path.join(h.deps.configDir, "bridge"))).toBe(true);
  });

  it("a symlinked app parent is never followed: bridge/ inside its target goes, the link, the target and its other files stay", async () => {
    h = await harness();
    h.deps.isTTY = true; // the prompt only exists on a terminal
    const real = path.join(h.root, "elsewhere", "demo-config");
    await mkdir(real, { recursive: true });
    await writeFile(path.join(real, "theirs.txt"), "mine");
    await mkdir(h.deps.configDir, { recursive: true });
    await symlink(real, path.join(h.deps.configDir, "demo"));
    await twoApps();
    expect(await exists(path.join(real, "bridge", "app.json"))).toBe(true);
    let printed = "";
    h.deps.confirm = async () => {
      printed = h.out.join("");
      return true;
    };
    expect(await runCli(["apps", "remove", "demo"], h.deps)).toBe(0);
    expect(printed).toContain(`${path.join(h.deps.configDir, "demo", "bridge")} (really ${path.join(real, "bridge")})`);
    expect(await exists(path.join(real, "bridge"))).toBe(false);
    expect(await readFile(path.join(real, "theirs.txt"), "utf8")).toBe("mine");
    expect((await lstat(path.join(h.deps.configDir, "demo"))).isSymbolicLink()).toBe(true);
    expect(h.out.join("")).toContain("a symlink, left alone");
  });

  it("a bridge/ dir that is itself a link is unlinked as a leaf: its target keeps its files", async () => {
    h = await harness();
    await twoApps();
    const demo = appPathsOf(h.deps, "demo");
    const target = path.join(h.root, "precious");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "f.txt"), "keep");
    await rm(demo.stateDir, { recursive: true });
    await symlink(target, demo.stateDir);
    expect(await runCli(["apps", "remove", "demo", "--yes"], h.deps)).toBe(0);
    expect(await readFile(path.join(target, "f.txt"), "utf8")).toBe("keep");
    expect(await exists(demo.stateDir)).toBe(false);
  });

  it("refuses when a path changed while the question was open, and removes nothing", async () => {
    h = await harness();
    h.deps.isTTY = true; // the prompt only exists on a terminal
    await twoApps();
    const demo = appPathsOf(h.deps, "demo");
    h.deps.confirm = async () => {
      await writeFile(demo.appFile, JSON.stringify({ version: 1, ...record({ runnerId: "swapped" }) }));
      return true;
    };
    expect(await runCli(["apps", "remove", "demo"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await exists(demo.trustFile)).toBe(true);
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBe("secret-demo");
    expect((await readAppList(h.deps)).listed.map((a) => a.appId)).toEqual(["demo", "other"]);
  });

  it("refuses when a dir was retargeted into another app's folder during the question", async () => {
    h = await harness();
    h.deps.isTTY = true; // the prompt only exists on a terminal
    await twoApps();
    const demo = appPathsOf(h.deps, "demo");
    const other = appPathsOf(h.deps, "other");
    h.deps.confirm = async () => {
      await rm(demo.dataDir, { recursive: true });
      await symlink(other.dataDir, demo.dataDir);
      return true;
    };
    expect(await runCli(["apps", "remove", "demo"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await exists(path.join(other.pluginsDir, "x", "1.0.0", "entry.js"))).toBe(true);
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBe("secret-demo");
  });

  it("refuses an aliased layout before the question: one app's dir resolving into another's", async () => {
    h = await harness();
    await twoApps();
    const demo = appPathsOf(h.deps, "demo");
    const other = appPathsOf(h.deps, "other");
    await rm(demo.dataDir, { recursive: true });
    await symlink(other.dataDir, demo.dataDir);
    expect(await runCli(["apps", "remove", "other", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("overlap");
    expect(h.questions).toEqual([]);
    expect(await exists(other.trustFile)).toBe(true);
  });

  it("removes an app whose app.json is broken: the token goes, the wrapping key is named for the person, the dirs and the list entry go", async () => {
    h = await harness();
    await twoApps();
    const demo = appPathsOf(h.deps, "demo");
    await writeFile(demo.appFile, "{nope");
    expect(await runCli(["apps", "remove", "demo", "--yes"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("bridge/e2ee-identity-key/demo/<runner id>");
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBeNull();
    expect(await exists(demo.configDir)).toBe(false);
    expect((await readAppList(h.deps)).listed.map((a) => a.appId)).toEqual(["other"]);
  });

  it("a keychain failure stops before any file is removed, so a second run can finish", async () => {
    h = await harness();
    await twoApps();
    const store = h.deps.credentials!;
    const realDelete = store.delete.bind(store);
    let fail = true;
    store.delete = async (key) => {
      if (fail && key.startsWith("bridge/e2ee-identity-key/")) throw new Error("keychain locked");
      return realDelete(key);
    };
    expect(await runCli(["apps", "remove", "demo", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("keychain locked");
    expect(await exists(appPathsOf(h.deps, "demo").trustFile)).toBe(true);
    expect((await readAppList(h.deps)).listed.map((a) => a.appId)).toEqual(["demo", "other"]);
    fail = false;
    expect(await runCli(["apps", "remove", "demo", "--yes"], h.deps)).toBe(0);
    expect(await exists(appPathsOf(h.deps, "demo").configDir)).toBe(false);
  });

  it("remove without --yes and without a terminal refuses naming --yes, never asks or reads stdin, and removes nothing", async () => {
    h = await harness();
    await twoApps();
    const demo = appPathsOf(h.deps, "demo");
    expect(h.deps.isTTY).toBe(false);
    expect(await runCli(["apps", "remove", "demo"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("--yes");
    expect(h.questions).toEqual([]); // confirm (the stdin reader) was never called
    expect(h.out.join("")).not.toContain("These paths will be removed");
    expect((await loadApps(h.deps)).map((a) => a.appId)).toEqual(["demo", "other"]);
    expect(await exists(demo.trustFile)).toBe(true);
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBe("secret-demo");
    expect(await h.deps.credentials!.get("bridge/e2ee-identity-key/demo/runner-1")).toBe("wrap-demo");
    // With --yes the same removal goes through.
    expect(await runCli(["apps", "remove", "demo", "--yes"], h.deps)).toBe(0);
    expect((await loadApps(h.deps)).map((a) => a.appId)).toEqual(["other"]);
  });

  it("a name or origin finds the app too, and an unknown one is an error", async () => {
    h = await harness();
    await twoApps();
    expect(await runCli(["apps", "remove", "nope", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("no connected app 'nope'");
    expect(await runCli(["apps", "remove", "https://other.example", "--yes"], h.deps)).toBe(0);
    expect((await readAppList(h.deps)).listed.map((a) => a.appId)).toEqual(["demo"]);
  });

  it("refuses an ambiguous display name instead of picking the first app", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    await upsertApp(h.deps, record({ appId: "twin", origin: "https://twin.example", runnerId: "runner-2" }));
    h.answers.yes = true;
    await expect(resolveApp(h.deps, "Demo")).rejects.toThrow(/more than one app \(demo, twin\)/);
    expect(await runCli(["apps", "remove", "Demo"], h.deps)).toBe(1);
    expect((await loadApps(h.deps)).map((a) => a.appId)).toEqual(["demo", "twin"]);
    expect((await resolveApp(h.deps, "twin")).appId).toBe("twin");
  });

  it("printable strips terminal control characters", () => {
    expect(printable("Ev\u001b[2Jil\nApp\u0007")).toBe("Ev[2JilApp");
  });

  it("concurrent connects and removes do not lose updates", async () => {
    h = await harness();
    const ids = Array.from({ length: 12 }, (_, i) => `app-${i}`);
    await Promise.all(ids.map((appId) => upsertApp(h.deps, record({ appId, origin: `https://${appId}.example`, runnerId: `r-${appId}` }))));
    expect((await loadApps(h.deps)).map((a) => a.appId).sort()).toEqual([...ids].sort());
    await Promise.all(ids.slice(0, 6).map((appId) => removeApp(h.deps, appId)));
    await Promise.all(ids.slice(12 - 3).map((appId) => upsertApp(h.deps, record({ appId, name: "again", runnerId: `r-${appId}` }))));
    const left = await loadApps(h.deps);
    expect(left.map((a) => a.appId).sort()).toEqual(ids.slice(6).sort());
    expect(left.filter((a) => a.name === "again")).toHaveLength(3);
  });

  it("apps.json is private to the user", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    const file = path.join(h.deps.configDir, "bridge", "apps.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("apps list and remove, for a local app", () => {
  const local: LocalAppRecord = { kind: "local", appId: "sample-app", name: "Sample app", origin: "local", createdAt: "2026-11-04T00:00:00.000Z" };

  it("lists it as `<id>  <name>  local  -` and as the stored record with --json, beside a hosted app", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    await upsertApp(h.deps, local);
    expect(await runCli(["apps", "list"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("demo\tDemo\thttps://demo.example\trunner runner-1\n");
    expect(h.out.join("")).toContain("sample-app\tSample app\tlocal\t-\n");
    h.out.length = 0;
    expect(await runCli(["apps", "list", "--json"], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual([record(), local]);
  });

  it("remove deletes its folders and list entry with no keychain line and no credential-store call, and leaves a hosted app alone", async () => {
    h = await harness();
    h.deps.isTTY = true;
    await upsertApp(h.deps, record());
    await upsertApp(h.deps, local);
    const mine = appPathsOf(h.deps, "sample-app");
    for (const d of [mine.dataDir, mine.stateDir]) await mkdir(d, { recursive: true });
    await h.deps.credentials!.set(tokenKey("demo"), "secret-demo");
    const calls: string[] = [];
    const store = h.deps.credentials!;
    h.deps.credentials = { get: async (k) => (calls.push(`get ${k}`), store.get(k)), set: async (k, v) => (calls.push(`set ${k}`), store.set(k, v)), delete: async (k) => (calls.push(`delete ${k}`), store.delete(k)) };

    h.answers.yes = false;
    expect(await runCli(["apps", "remove", "sample-app"], h.deps)).toBe(1);
    expect(h.questions).toEqual([`Remove local app Sample app (local) and delete its bridge folders?`]);
    expect(h.out.join("")).toContain(mine.configDir);
    expect(h.out.join("")).not.toContain("keychain");
    expect(await exists(mine.appFile)).toBe(true);

    h.answers.yes = true;
    h.out.length = 0;
    expect(await runCli(["apps", "remove", "sample-app"], h.deps)).toBe(0);
    expect(h.out.join("")).not.toContain("keychain");
    expect(h.out.join("")).toContain("Removed local app Sample app.");
    expect(calls).toEqual([]);
    for (const d of [mine.configDir, mine.dataDir, mine.stateDir]) expect(await exists(d)).toBe(false);
    expect((await loadApps(h.deps)).map((a) => a.appId)).toEqual(["demo"]);
    expect(await store.get(tokenKey("demo"))).toBe("secret-demo");
  });

  it.each([["absent", undefined], ["broken", "{not json"]])("remove of a listed local app whose app.json is %s runs no credential step and prints no keychain line", async (_kind, contents) => {
    h = await harness();
    h.deps.isTTY = true;
    await upsertApp(h.deps, local);
    const mine = appPathsOf(h.deps, "sample-app");
    if (contents === undefined) await rm(mine.appFile);
    else await writeFile(mine.appFile, contents);
    const calls: string[] = [];
    const store = h.deps.credentials!;
    h.deps.credentials = { get: async (k) => (calls.push(`get ${k}`), store.get(k)), set: async (k, v) => (calls.push(`set ${k}`), store.set(k, v)), delete: async (k) => (calls.push(`delete ${k}`), store.delete(k)) };
    h.answers.yes = true;
    expect(await runCli(["apps", "remove", "sample-app"], h.deps)).toBe(0);
    expect(h.questions).toEqual(["Remove local app sample-app (local) and delete its bridge folders?"]);
    expect(h.out.join("")).not.toContain("keychain");
    expect(h.out.join("")).toContain("Removed local app sample-app.");
    expect(calls).toEqual([]);
    expect(await exists(mine.configDir)).toBe(false);
    expect((await loadApps(h.deps)).length).toBe(0);
  });

  it("a name that matches the origin marker does not select a local app", async () => {
    h = await harness();
    await upsertApp(h.deps, local);
    expect(await runCli(["apps", "remove", "local", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("no connected app 'local'");
    expect(await exists(appPathsOf(h.deps, "sample-app").appFile)).toBe(true);
  });
});
