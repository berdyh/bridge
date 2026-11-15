import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type LocalAppRecord, upsertApp } from "./config.js";
import { runBrowsers } from "./browsers.js";
import { connectApp } from "./connect.js";
import { runEnroll } from "./enroll.js";
import { UsageError } from "./deps.js";
import { appPathsOf } from "./paths.js";
import { readRunnerStatus, runStatus, statusFilePath, writeRunnerStatus } from "./status.js";
import { type Harness, harness, record } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const trusted = [{ browserKeyId: "k1", publicKey: "pk", label: "Laptop", enrolledAt: "2026-10-21T00:00:00Z", lastSeen: "2026-10-21T00:00:00Z" }];

describe("bridge status", () => {
  it("says the runner is not running, and lists the apps, when there is no runner.json", async () => {
    h = await harness({ e2ee: { enroll: async () => { throw new Error("unused"); }, listBrowsers: async () => trusted, revokeBrowser: async () => false } });
    await upsertApp(h.deps, record());
    expect(await runStatus([], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("not running");
    expect(h.out.join("")).toContain("demo\tDemo\tnot_running\t1 trusted browser(s)\tenroll window closed");
    h.out.length = 0;
    expect(await runStatus(["--json"], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({
      running: false,
      apps: [{ appId: "demo", name: "Demo", origin: "https://demo.example", link: "not_running", trustedBrowsers: 1, enrollWindowOpen: false }],
    });
  });

  it("with no apps at all, the hint names both ways to add one", async () => {
    h = await harness();
    expect(await runStatus([], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("No apps connected. Run `bridge connect <app-url>` or `bridge apps add-local <app-id>`.");
  });

  it("reports link status, browsers and an open enroll window per app from a live runner.json", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    await upsertApp(h.deps, record({ appId: "late", name: "Late", origin: "https://late.example", runnerId: "runner-2" }));
    await writeRunnerStatus(h.deps, { version: 1, pid: process.pid, startedAt: "2026-10-21T00:00:00.000Z", apps: { demo: "online" }, browsers: 2 });
    const windowFile = appPathsOf(h.deps, "demo").enrollFile;
    await mkdir(path.dirname(windowFile), { recursive: true });
    await writeFile(windowFile, JSON.stringify({ v: 1, codeId: "c", code: "BCDFGHJK", expiresAt: "2999-01-01T00:00:00.000Z", attemptsLeft: 5, state: "open", ownerPid: process.pid }));
    expect(await runStatus(["--json"], h.deps)).toBe(0);
    const report = JSON.parse(h.out.join(""));
    expect(report).toMatchObject({ running: true, pid: process.pid, browsers: 2 });
    expect(report.apps).toEqual([
      { appId: "demo", name: "Demo", origin: "https://demo.example", link: "online", trustedBrowsers: 0, enrollWindowOpen: true },
      { appId: "late", name: "Late", origin: "https://late.example", link: "not_served", trustedBrowsers: 0, enrollWindowOpen: false },
    ]);
  });

  it("treats a corrupt or foreign runner.json as no runner, and rejects stray arguments", async () => {
    h = await harness();
    await mkdir(path.dirname(statusFilePath(h.deps)), { recursive: true });
    for (const text of ["not json", "{}", JSON.stringify({ version: 1, pid: process.pid, startedAt: "x", browsers: 0, apps: { demo: "wat" } })]) {
      await writeFile(statusFilePath(h.deps), text);
      expect(await readRunnerStatus(h.deps)).toBeUndefined();
    }
    await expect(runStatus(["extra"], h.deps)).rejects.toBeInstanceOf(UsageError);
  });
});

describe("bridge status and the commands that need a link, for a local app", () => {
  const local: LocalAppRecord = { kind: "local", appId: "sample-app", name: "Sample app", origin: "local", createdAt: "2026-11-04T00:00:00.000Z" };
  /** An E2EE store that fails the test when asked: a local app has no identity or trust list. */
  const noE2ee = { enroll: async () => { throw new Error("enroll must not be called"); }, listBrowsers: async () => { throw new Error("listBrowsers must not be called"); }, revokeBrowser: async () => { throw new Error("revokeBrowser must not be called"); } };

  it("reads `local` while a runner serves it, `not_running` with no runner, and never asks the E2EE store about it", async () => {
    h = await harness({ e2ee: noE2ee });
    await upsertApp(h.deps, local);
    expect(await runStatus(["--json"], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({
      running: false,
      apps: [{ appId: "sample-app", name: "Sample app", origin: "local", link: "not_running", trustedBrowsers: 0, enrollWindowOpen: false }],
    });
    h.out.length = 0;
    await writeRunnerStatus(h.deps, { version: 1, pid: process.pid, startedAt: "2026-11-04T00:00:00.000Z", apps: { "sample-app": "local" }, browsers: 0 });
    expect(await runStatus(["--json"], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join("")).apps).toEqual([{ appId: "sample-app", name: "Sample app", origin: "local", link: "local", trustedBrowsers: 0, enrollWindowOpen: false }]);
    h.out.length = 0;
    expect(await runStatus([], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("sample-app\tSample app\tlocal\t0 trusted browser(s)\tenroll window closed");
  });

  it("a worker entry of the other kind (the app was removed and recreated under a live runner) reads `not_served`, whichever way it flipped", async () => {
    h = await harness({ e2ee: { enroll: async () => { throw new Error("unused"); }, listBrowsers: async () => [], revokeBrowser: async () => false } });
    const links = async (): Promise<string[]> => {
      h.out.length = 0;
      expect(await runStatus(["--json"], h.deps)).toBe(0);
      return (JSON.parse(h.out.join("")) as { apps: { link: string }[] }).apps.map((a) => a.link);
    };
    const status = (apps: Record<string, "online" | "local">): Promise<void> =>
      writeRunnerStatus(h.deps, { version: 1, pid: process.pid, startedAt: "2026-11-04T00:00:00.000Z", apps, browsers: 0 });
    // A local record under a hosted worker's entry.
    await upsertApp(h.deps, local);
    await status({ "sample-app": "online" });
    expect(await links()).toEqual(["not_served"]);
    // A hosted record under a local worker's entry.
    await status({ demo: "local" });
    await upsertApp(h.deps, record());
    expect(await links()).toEqual(["not_served", "not_served"]);
    // Entries of the matching kind still read as themselves.
    await status({ "sample-app": "local", demo: "online" });
    expect(await links()).toEqual(["local", "online"]);
  });

  it("a runner that started before the app was created reports it `not_served`", async () => {
    h = await harness({ e2ee: noE2ee });
    await upsertApp(h.deps, local);
    await writeRunnerStatus(h.deps, { version: 1, pid: process.pid, startedAt: "2026-11-04T00:00:00.000Z", apps: {}, browsers: 0 });
    expect(await runStatus(["--json"], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join("")).apps[0].link).toBe("not_served");
  });

  it("`enroll` and `browsers` refuse a local app by name, and as the only app: no relay, sign-in, browsers or enrollment", async () => {
    h = await harness({ e2ee: noE2ee });
    await upsertApp(h.deps, local);
    for (const run of [() => runEnroll(["sample-app"], h.deps), () => runBrowsers(["list", "sample-app"], h.deps), () => runBrowsers(["revoke", "sample-app", "key-1"], h.deps)]) {
      await expect(run()).rejects.toThrow("sample-app is a local app: it has no relay, sign-in, browsers or enrollment");
    }
  });

  it("`connect` of a server whose app id is a local app is an origin_conflict: nothing is stored and the local app is untouched", async () => {
    h = await harness({ e2ee: noE2ee });
    await upsertApp(h.deps, local);
    const discovery = {
      protocol: { min: 1, max: 1 }, app: { id: "sample-app", name: "Sample app" }, origin: "https://sample.example", relayUrl: "wss://sample.example/relay",
      auth: { issuer: "https://idp.example", clientId: "c", deviceAuthorizationEndpoint: "https://idp.example/d", tokenEndpoint: "https://idp.example/t" },
    };
    const result = await connectApp(new URL("https://sample.example/"), h.deps, { yes: true, discovered: { ok: true, url: new URL("https://sample.example/"), discovery } as never });
    expect(result).toMatchObject({ ok: false, code: "origin_conflict" });
    expect(h.questions).toEqual([]);
    expect([...(h.deps.credentials as ReturnType<typeof import("./testkit.js").memoryCredentials>).data.keys()]).toEqual([]);
  });
});
