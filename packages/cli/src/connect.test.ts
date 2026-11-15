import { mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { createMemoryDeviceStore, createNodeBridgeServer, createStubAuthVerifier, type NodeBridgeServer } from "@berdyh/bridge-server-node";
import { loadTokens } from "@berdyh/bridge-pairing";
import { wrapKeyNameOf } from "@berdyh/bridge-runner";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";
import { appUrlOf, startedBeforeRecord } from "./connect.js";
import { UsageError } from "./deps.js";
import { type HostedAppRecord, appsFilePath, isSafeAppId, loadApps as loadAllApps, removeApp, tokenKey, upsertApp } from "./config.js";
import { appPathsOf } from "./paths.js";
import { canonicalPath } from "./consent-plan.js";
import { startRunner } from "./run.js";
import { readRunnerStatus, statusFilePath, writeRunnerStatus } from "./status.js";
import { type Harness, exists, harness, record } from "./testkit.js";

/** These tests connect hosted apps only: the records read back are hosted ones. */
const loadApps = async (deps: Parameters<typeof loadAllApps>[0]): Promise<HostedAppRecord[]> => (await loadAllApps(deps)) as HostedAppRecord[];

const closers: (() => Promise<void>)[] = [];
let h: Harness;
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await h?.cleanup();
});

interface Oauth {
  url: string;
  requests: { path: string; params: Record<string, string> }[];
}

/** A stub OAuth server: device authorization, then one `authorization_pending`, then a token. */
async function oauth(token: (issuer: string) => string = () => "access-1"): Promise<Oauth> {
  const requests: Oauth["requests"] = [];
  let polls = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const params = Object.fromEntries(new URLSearchParams(body));
      requests.push({ path: req.url ?? "", params });
      res.setHeader("content-type", "application/json");
      if (req.url === "/d") {
        res.end(JSON.stringify({ device_code: "dev-code", user_code: "WDJB-MJHT", verification_uri: `${url}/activate`, expires_in: 600, interval: 1 }));
      } else if (++polls < 2) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "authorization_pending" }));
      } else {
        res.end(JSON.stringify({ access_token: token(url), token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600 }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(() => new Promise<void>((resolve) => void server.close(() => resolve())));
  return { url, requests };
}

async function appServer(idp: Oauth, adapters?: NonNullable<Parameters<typeof createNodeBridgeServer>[0]["adapters"]>, enrollPage?: string, scope?: string): Promise<NodeBridgeServer> {
  const server = await createNodeBridgeServer({
    ...(adapters ? { adapters } : {}),
    ...(enrollPage ? { enrollPage } : {}),
    app: { id: "demo", name: "Demo App" },
    auth: { issuer: idp.url, clientId: "runner-client", deviceAuthorizationEndpoint: `${idp.url}/d`, tokenEndpoint: `${idp.url}/t`, ...(scope ? { scope } : {}) },
  });
  closers.push(() => server.close());
  return server;
}

function jwt(claims: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

describe("bridge connect", () => {
  it("acknowledges enrollment only after protected storage and removes the saved receipt", async () => {
    h = await harness();
    const idp = await oauth();
    const server = await appServer(idp, undefined, undefined, "bridge:runner");
    const originalFetch = h.deps.fetch;
    let acknowledgements = 0;
    h.deps.fetch = async (input, init) => {
      if (String(input) === `${idp.url}/t`) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        if (params.get("grant_type") === "urn:berdyh:bridge:enrollment-ack") {
          const saved = await loadTokens(h.deps.credentials!, tokenKey("demo"));
          expect(saved).toMatchObject({ accessToken: "access-1", enrollmentReceipt: { deviceCode: "dev-code", receipt: "ab".repeat(32) } });
          acknowledgements++;
          return Response.json({ acknowledged: true });
        }
        const response = await originalFetch(input, init);
        if (response.ok) return Response.json({ ...await response.json() as object, enrollment_receipt: "ab".repeat(32) });
        return response;
      }
      return originalFetch(input, init);
    };
    expect(await runCli(["connect", server.url], h.deps)).toBe(0);
    expect(acknowledgements).toBe(1);
    expect(idp.requests.find((request) => request.path === "/d")?.params.scope).toBe("bridge:runner");
    expect((await loadTokens(h.deps.credentials!, tokenKey("demo")))?.enrollmentReceipt).toBeUndefined();
    expect(h.out.join("") + h.err.join("")).not.toContain("ab".repeat(32));
  });

  it("validates bridge.json, pairs through the device grant, stores the token per app and records the app", async () => {
    h = await harness();
    const idp = await oauth();
    const server = await appServer(idp);

    expect(await runCli(["connect", server.url], h.deps)).toBe(0);

    const shown = h.out.join("");
    expect(shown).toContain("Demo App (demo)");
    expect(shown).toContain(server.url);
    expect(shown).toContain("WDJB-MJHT");
    expect(h.questions[0]).toContain("Demo App");

    const [app] = await loadApps(h.deps);
    expect(app).toMatchObject({ appId: "demo", name: "Demo App", origin: server.url, relayUrl: `${server.url.replace("http", "ws")}/relay` });
    expect(app!.runnerId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);

    const tokens = await loadTokens(h.deps.credentials!, tokenKey("demo"));
    expect(tokens).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" });
    // The OAuth client is the public one from bridge.json, and the device details are sent for the approval page.
    expect(idp.requests[0]).toMatchObject({ path: "/d", params: { client_id: "runner-client" } });
    expect(idp.requests[0]!.params.device_name).toBeTruthy();
  });

  it("does nothing when the user declines", async () => {
    h = await harness();
    h.answers.yes = false;
    const idp = await oauth();
    const server = await appServer(idp);
    expect(await runCli(["connect", server.url], h.deps)).toBe(1);
    expect(idp.requests).toEqual([]);
    expect(await loadApps(h.deps)).toEqual([]);
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBeNull();
  });

  it("prints the path it writes before the question, and with --yes too", async () => {
    h = await harness();
    h.answers.yes = false;
    let printedBefore = "";
    const confirm = h.deps.confirm;
    h.deps.confirm = async (q, o) => {
      printedBefore = h.out.join("");
      return confirm(q, o);
    };
    const server = await appServer(await oauth());
    expect(await runCli(["connect", server.url], h.deps)).toBe(1);
    const demo = appPathsOf(h.deps, "demo");
    const listed = [appsFilePath(h.deps), demo.appFile, demo.configDir, demo.dataDir, demo.stateDir];
    expect(printedBefore).toContain(`These paths will be written:\n  ${appsFilePath(h.deps)}`);
    for (const p of listed) expect(printedBefore).toContain(p);
    expect(printedBefore).toContain("its parent is created only when missing and never changed");
    expect(await exists(demo.appFile)).toBe(false);
    h.out.length = 0;
    h.answers.yes = true;
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
    for (const p of listed) expect(h.out.join("")).toContain(p);
  });

  it("with BRIDGE_CREDENTIAL_STORE=file:<dir> the consent text names the credential files, not the OS keychain", async () => {
    h = await harness();
    h.deps.env.BRIDGE_CREDENTIAL_STORE = `file:${h.root}/creds`;
    h.answers.yes = false;
    const server = await appServer(await oauth());
    expect(await runCli(["connect", server.url], h.deps)).toBe(1);
    const printed = h.out.join("");
    expect(printed).toContain("the sign-in token goes to the credential files (BRIDGE_CREDENTIAL_STORE)");
    expect(printed).not.toContain("OS keychain");
  });

  it("under BRIDGE_CREDENTIAL_STORE=file:<dir> the paths list names the credential folder, in the text and in the need_approval event; with the keychain it does not", async () => {
    h = await harness();
    const dir = `${h.root}/state/bridge-credentials`;
    h.answers.yes = false;
    const server = await appServer(await oauth());
    expect(await runCli(["connect", server.url], h.deps)).toBe(1);
    expect(h.out.join("")).not.toContain(dir);
    h.out.length = 0;
    h.deps.env.BRIDGE_CREDENTIAL_STORE = `file:${dir}`;
    expect(await runCli(["connect", server.url], h.deps)).toBe(1);
    const written = h.out.join("").split("These paths will be written:\n")[1]!.split("\n").filter((l) => l.startsWith("  "));
    expect(written.some((l) => l.startsWith(`  ${dir}  (dir: the credential files`))).toBe(true);
    h.out.length = 0;
    expect(await runCli(["connect", server.url, "--json"], h.deps)).toBe(1);
    const approval = h.out.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; paths?: string[] }).find((e) => e.event === "need_approval");
    expect(approval?.paths).toContain(dir);
    // Looking creates nothing.
    expect(await exists(dir)).toBe(false);
  });

  it("with the keychain selected the consent text says the OS keychain", async () => {
    h = await harness();
    h.answers.yes = false;
    const server = await appServer(await oauth());
    expect(await runCli(["connect", server.url], h.deps)).toBe(1);
    expect(h.out.join("")).toContain("the sign-in token goes to the OS keychain");
  });

  it("with no usable keychain it refuses before the question and the sign-in, names BRIDGE_CREDENTIAL_STORE=file:<dir>, and writes nothing", async () => {
    h = await harness();
    delete h.deps.credentials;
    h.deps.run = async (command, args) => {
      h.commands.push([command, ...args]);
      if (command === "secret-tool") return { exitCode: 1, stdout: "", stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY\n" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const idp = await oauth();
    const server = await appServer(idp);
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(1);
    const err = h.err.join("");
    expect(err).toContain("the OS keychain is not usable here");
    expect(err).toContain("Cannot autolaunch D-Bus");
    expect(err).toContain("BRIDGE_CREDENTIAL_STORE=file:<absolute directory>");
    expect(idp.requests).toEqual([]);
    expect(h.questions).toEqual([]);
    expect(await loadApps(h.deps)).toEqual([]);
    expect(await exists(appPathsOf(h.deps, "demo").appFile)).toBe(false);
    // The probe only reads: it never stores.
    expect(h.commands.filter((c) => c[0] === "secret-tool")).toEqual([["secret-tool", "lookup", "service", "berdyh-bridge", "account", "bridge-keychain-probe"]]);
  });

  it("a keychain that does not answer in time is refused before the question and the sign-in, nothing written", async () => {
    h = await harness();
    delete h.deps.credentials;
    h.deps.run = async (command) => {
      if (command === "secret-tool") throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const idp = await oauth();
    const server = await appServer(idp);
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("the OS keychain did not answer within 5 s");
    expect(h.err.join("")).toContain("unlock it and retry");
    expect(idp.requests).toEqual([]);
    expect(h.questions).toEqual([]);
    expect(await loadApps(h.deps)).toEqual([]);
  });

  it("with no secret-tool it refuses the same way, and a working Secret Service lets the question through", async () => {
    h = await harness();
    delete h.deps.credentials;
    h.deps.run = async (command) => {
      if (command === "secret-tool") throw Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const server = await appServer(await oauth());
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("secret-tool is not installed");
    expect(h.err.join("")).toContain("BRIDGE_CREDENTIAL_STORE=file:<absolute directory>");
    h.err.length = 0;
    h.deps.run = async (command) => ({ exitCode: command === "secret-tool" ? 1 : 0, stdout: "", stderr: "" });
    h.answers.yes = false;
    expect(await runCli(["connect", server.url], h.deps)).toBe(1);
    expect(h.err.join("")).not.toContain("not usable");
    expect(h.questions.some((q) => q.startsWith("Connect"))).toBe(true);
  });

  it("with the file store selected the keychain is not probed", async () => {
    h = await harness();
    delete h.deps.credentials;
    h.deps.env.BRIDGE_CREDENTIAL_STORE = `file:${h.root}/creds`;
    h.deps.run = async (command, args) => {
      h.commands.push([command, ...args]);
      return { exitCode: 1, stdout: "", stderr: "no service" };
    };
    h.answers.yes = false;
    const server = await appServer(await oauth());
    expect(await runCli(["connect", server.url], h.deps)).toBe(1);
    expect(h.commands.some((c) => c[0] === "secret-tool")).toBe(false);
    expect(h.questions.some((q) => q.startsWith("Connect"))).toBe(true);
  });

  it("--yes skips the question", async () => {
    h = await harness();
    const server = await appServer(await oauth());
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
    expect(h.questions).toEqual([]);
  });

  it("keeps the runner id when the same app is connected again", async () => {
    h = await harness();
    const server = await appServer(await oauth());
    await runCli(["connect", server.url, "--yes"], h.deps);
    const first = (await loadApps(h.deps))[0]!.runnerId;
    await runCli(["connect", server.url, "--yes"], h.deps);
    const apps = await loadApps(h.deps);
    expect(apps).toHaveLength(1);
    expect(apps[0]!.runnerId).toBe(first);
  });

  it("a re-pair that keeps the runner id keeps connectedAt (a runner online on that id is not older than the record); a new id gets a new time", async () => {
    h = await harness();
    const server = await appServer(await oauth());
    await upsertApp(h.deps, record({ runnerId: "old-runner", origin: server.url, url: server.url, connectedAt: "2026-10-14T00:00:00.000Z" }));
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
    const [kept] = await loadApps(h.deps);
    expect(kept!.runnerId).toBe("old-runner");
    expect(kept!.connectedAt).toBe("2026-10-14T00:00:00.000Z");
    expect(JSON.parse(await readFile(appPathsOf(h.deps, "demo").appFile, "utf8")).connectedAt).toBe("2026-10-14T00:00:00.000Z");

    await writeFile(appPathsOf(h.deps, "demo").revokedFile, JSON.stringify({ version: 1, runnerId: "old-runner", at: "2026-10-20T00:00:00.000Z" }));
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
    const [replaced] = await loadApps(h.deps);
    expect(replaced!.runnerId).not.toBe("old-runner");
    expect(Date.parse(replaced!.connectedAt)).toBeGreaterThan(Date.parse("2026-10-14T00:00:00.000Z"));
  });

  describe("a stored link the runner reports as revoked ", () => {
    const runnerReporting = (link: string, startedAt: string) =>
      writeRunnerStatus(h.deps, { version: 1, pid: process.pid, startedAt, apps: { demo: link } as never, browsers: 0 });

    async function storedApp(serverUrl: string) {
      await upsertApp(h.deps, record({ runnerId: "old-runner", origin: serverUrl, url: serverUrl, connectedAt: "2026-10-14T00:00:00.000Z" }));
      const paths = appPathsOf(h.deps, "demo");
      const stale = ["trust.json", "identity.json", "enroll.json", "identity.key"].map((n) => path.join(paths.configDir, n));
      for (const f of stale) await writeFile(f, "{}");
      const wrapKey = wrapKeyNameOf({ appId: "demo", runnerId: "old-runner" });
      await h.deps.credentials!.set(wrapKey, "stale-key");
      return { stale, wrapKey };
    }

    it("writes a new runner id, says why, and deletes what belonged to the revoked id", async () => {
      h = await harness();
      const server = await appServer(await oauth());
      const { stale, wrapKey } = await storedApp(server.url);
      await runnerReporting("revoked", "2026-10-21T00:00:00.000Z");

      expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
      const [app] = await loadApps(h.deps);
      expect(app!.runnerId).not.toBe("old-runner");
      expect(app!.runnerId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
      // The record in the app's own folder carries it too.
      expect(JSON.parse(await readFile(appPathsOf(h.deps, "demo").appFile, "utf8")).runnerId).toBe(app!.runnerId);
      expect(h.out.join("")).toContain("revoked");
      expect(h.out.join("")).toContain("DELETED");
      for (const f of stale) expect(await exists(f), f).toBe(false);
      expect(await h.deps.credentials!.get(wrapKey)).toBeNull();
      // The runner that reported it is still up with the old record: connect says so.
      expect(h.out.join("")).toContain("still holds the revoked identity");
    });

    it("keeps the runner id of a link that is live, parked on something else, or reported by a runner older than the record", async () => {
      h = await harness();
      const server = await appServer(await oauth());
      const { stale } = await storedApp(server.url);

      await runnerReporting("online", "2026-10-21T00:00:00.000Z");
      expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
      expect((await loadApps(h.deps))[0]!.runnerId).toBe("old-runner");

      for (const link of ["reconnecting", "auth_failed", "replaced", "update_required"]) {
        await runnerReporting(link, "2026-10-21T00:00:00.000Z");
        expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
        expect((await loadApps(h.deps))[0]!.runnerId, link).toBe("old-runner");
      }

      // "revoked" from a runner that started before the record was written is the word of an older id.
      await runnerReporting("revoked", "2026-10-01T00:00:00.000Z");
      expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
      expect((await loadApps(h.deps))[0]!.runnerId).toBe("old-runner");

      // No runner at all.
      await rm(statusFilePath(h.deps), { force: true });
      expect(await readRunnerStatus(h.deps)).toBeUndefined();
      expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
      expect((await loadApps(h.deps))[0]!.runnerId).toBe("old-runner");
      for (const f of stale) expect(await exists(f), f).toBe(true);
    });

    it("a second connect after the new id was written does not mint another while the old runner still reports revoked", async () => {
      h = await harness();
      const server = await appServer(await oauth());
      await storedApp(server.url);
      await runnerReporting("revoked", "2026-10-21T00:00:00.000Z");
      expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
      const second = (await loadApps(h.deps))[0]!.runnerId;
      expect(second).not.toBe("old-runner");
      expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
      expect((await loadApps(h.deps))[0]!.runnerId).toBe(second);
    });

    it("--json lists the deletions of the revoked id in need_approval", async () => {
      h = await harness();
      const server = await appServer(await oauth());
      const { stale } = await storedApp(server.url);
      await runnerReporting("revoked", "2026-10-21T00:00:00.000Z");
      expect(await runCli(["connect", server.url, "--yes", "--json"], h.deps)).toBe(0);
      const approval = h.out.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; deletes?: string[] }).find((e) => e.event === "need_approval");
      expect(approval?.deletes?.length).toBe(stale.length);
    });
  });

  describe("a stored runner id the relay refused for good (revoked.json)", () => {
    const markFile = () => appPathsOf(h.deps, "demo").revokedFile;
    const writeMark = (runnerId: string) =>
      writeFile(markFile(), JSON.stringify({ version: 1, runnerId, at: "2026-10-20T00:00:00.000Z", detail: "this device was revoked on the server" }));
    const runnerReporting = (link: string, startedAt: string) =>
      writeRunnerStatus(h.deps, { version: 1, pid: process.pid, startedAt, apps: { demo: link } as never, browsers: 0 });

    async function storedApp(serverUrl: string) {
      await upsertApp(h.deps, record({ runnerId: "old-runner", origin: serverUrl, url: serverUrl, connectedAt: "2026-10-14T00:00:00.000Z" }));
      const paths = appPathsOf(h.deps, "demo");
      await mkdir(paths.configDir, { recursive: true });
      const trust = path.join(paths.configDir, "trust.json");
      await writeFile(trust, "{}");
      return { trust };
    }

    it("a mark naming the record's runner id mints a new id whatever the runner is doing or whether one is up, lists the mark under DELETED and deletes it", async () => {
      for (const runner of [undefined, "online", "reconnecting", "connecting", "auth_failed", "stopped"] as const) {
        h = await harness();
        const server = await appServer(await oauth());
        const { trust } = await storedApp(server.url);
        await writeMark("old-runner");
        if (runner !== undefined) await runnerReporting(runner, "2026-10-21T00:00:00.000Z");
        expect(await runCli(["connect", server.url, "--yes"], h.deps), String(runner)).toBe(0);
        const [app] = await loadApps(h.deps);
        expect(app!.runnerId, String(runner)).not.toBe("old-runner");
        expect(h.out.join(""), String(runner)).toContain(markFile());
        expect(h.out.join(""), String(runner)).toContain("DELETED");
        expect(await exists(markFile()), String(runner)).toBe(false);
        expect(await exists(trust), String(runner)).toBe(false);
        await h.cleanup();
        h = undefined as never;
      }
    });

    it("a mark naming another runner id, or none, keeps the id while the link only reconnects", async () => {
      h = await harness();
      const server = await appServer(await oauth());
      const { trust } = await storedApp(server.url);
      await runnerReporting("reconnecting", "2026-10-21T00:00:00.000Z");
      await writeMark("an-older-runner");
      expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
      expect((await loadApps(h.deps))[0]!.runnerId).toBe("old-runner");
      await rm(markFile(), { force: true });
      expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
      expect((await loadApps(h.deps))[0]!.runnerId).toBe("old-runner");
      expect(await exists(trust)).toBe(true);
    });

    it("an unreadable or foreign-shaped mark is no mark", async () => {
      h = await harness();
      const server = await appServer(await oauth());
      await storedApp(server.url);
      for (const body of ["not json", "null", JSON.stringify({ version: 2, runnerId: "old-runner", at: "x" }), JSON.stringify({ version: 1, runnerId: 7, at: "x" })]) {
        await writeFile(markFile(), body);
        expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
        expect((await loadApps(h.deps))[0]!.runnerId, body).toBe("old-runner");
      }
    });

    it("the staleness of a runner's report has one rule: a start or record time that does not parse is not stale", () => {
      expect(startedBeforeRecord({ startedAt: "2026-10-01T00:00:00.000Z" }, "2026-10-14T00:00:00.000Z")).toBe(true);
      expect(startedBeforeRecord({ startedAt: "2026-10-21T00:00:00.000Z" }, "2026-10-14T00:00:00.000Z")).toBe(false);
      expect(startedBeforeRecord({ startedAt: "not a date" }, "2026-10-14T00:00:00.000Z")).toBe(false);
      expect(startedBeforeRecord({ startedAt: "2026-10-01T00:00:00.000Z" }, "not a date")).toBe(false);
    });
  });

  it("a connect that picks a new runner id deletes the earlier connection's trust, identity, enrollment and wrapping key; a re-pair keeps them", async () => {
    h = await harness();
    const server = await appServer(await oauth());
    const paths = appPathsOf(h.deps, "demo");
    // An earlier connection of this app, no longer listed in apps.json (as after `removeApp`), with its state still in the folder.
    await upsertApp(h.deps, record({ runnerId: "old-runner", origin: server.url, url: server.url }));
    await removeApp(h.deps, "demo");
    const stale = ["trust.json", "identity.json", "enroll.json", "identity.key"].map((n) => path.join(paths.configDir, n));
    for (const f of stale) await writeFile(f, "{}");
    const wrapKey = wrapKeyNameOf({ appId: "demo", runnerId: "old-runner" });
    await h.deps.credentials!.set(wrapKey, "stale-key");
    await writeFile(path.join(paths.configDir, "config.json"), "{}");

    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
    // The consent named what goes, before the device grant.
    for (const f of stale) expect(h.out.join("")).toContain(f);
    expect(h.out.join("")).toContain("DELETED");
    for (const f of stale) expect(await exists(f), f).toBe(false);
    expect(await h.deps.credentials!.get(wrapKey)).toBeNull();
    // Only the earlier state goes: the app's own settings stay.
    expect(await exists(path.join(paths.configDir, "config.json"))).toBe(true);
    const [app] = await loadApps(h.deps);
    expect(app!.runnerId).not.toBe("old-runner");

    // A re-pair of a listed app keeps its runner id, so its state stays valid and is not touched.
    await writeFile(path.join(paths.configDir, "trust.json"), "{}");
    h.out.length = 0;
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
    expect(await exists(path.join(paths.configDir, "trust.json"))).toBe(true);
    expect(h.out.join("")).not.toContain("DELETED");
  });

  it("--json lists the files a connect deletes in need_approval", async () => {
    h = await harness();
    const server = await appServer(await oauth());
    const trust = path.join(appPathsOf(h.deps, "demo").configDir, "trust.json");
    await mkdir(path.dirname(trust), { recursive: true });
    await writeFile(trust, "{}");
    expect(await runCli(["connect", server.url, "--yes", "--json"], h.deps)).toBe(0);
    const events = h.out.join("").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events[0]).toMatchObject({ event: "need_approval", deletes: [await canonicalPath(trust)] });
    expect(await exists(trust)).toBe(false);
  });

  it("--json names the canonical path of a stale file whose app parent is a symlink", async () => {
    h = await harness();
    const server = await appServer(await oauth());
    const demo = appPathsOf(h.deps, "demo");
    const real = path.join(h.root, "real-demo");
    await mkdir(path.join(real, "bridge"), { recursive: true });
    await mkdir(path.dirname(demo.parents.config), { recursive: true });
    await symlink(real, demo.parents.config);
    await writeFile(path.join(real, "bridge", "trust.json"), "{}");
    expect(await runCli(["connect", server.url, "--yes", "--json"], h.deps)).toBe(0);
    const events = h.out.join("").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events[0]).toMatchObject({ event: "need_approval", deletes: [path.join(await realpath(real), "bridge", "trust.json")] });
    expect(await exists(path.join(real, "bridge", "trust.json"))).toBe(false);
  });

  it("refuses when the app's parent is retargeted to a decoy during the device grant, and touches neither the decoy nor the keychain", async () => {
    h = await harness();
    const server = await appServer(await oauth());
    const demo = appPathsOf(h.deps, "demo");
    await upsertApp(h.deps, record({ runnerId: "old-runner", origin: server.url, url: server.url }));
    await removeApp(h.deps, "demo");
    await writeFile(path.join(demo.configDir, "trust.json"), "consented");
    const wrapKey = wrapKeyNameOf({ appId: "demo", runnerId: "old-runner" });
    await h.deps.credentials!.set(wrapKey, "stale-key");
    // A decoy with the same shape: what a retargeted <config>/demo would lead to.
    const decoy = path.join(h.root, "decoy");
    await mkdir(path.join(decoy, "bridge"), { recursive: true });
    await writeFile(path.join(decoy, "bridge", "trust.json"), "decoy");
    await writeFile(path.join(decoy, "bridge", "app.json"), JSON.stringify({ version: 1, ...record({ runnerId: "old-runner", origin: server.url, url: server.url }) }));
    let moved = false;
    h.deps.sleep = async () => {
      if (moved) return;
      moved = true;
      await rename(demo.parents.config, path.join(h.root, "moved-demo"));
      await symlink(decoy, demo.parents.config);
    };
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await readFile(path.join(decoy, "bridge", "trust.json"), "utf8")).toBe("decoy");
    expect(await readFile(path.join(h.root, "moved-demo", "bridge", "trust.json"), "utf8")).toBe("consented");
    expect(await h.deps.credentials!.get(wrapKey)).toBe("stale-key");
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBeNull();
  });

  it("refuses when a stale file appears during the device grant: the recompute looks again and finds a plan nobody consented to", async () => {
    h = await harness();
    const server = await appServer(await oauth());
    const demo = appPathsOf(h.deps, "demo");
    await mkdir(demo.configDir, { recursive: true });
    h.deps.sleep = async () => {
      await writeFile(path.join(demo.configDir, "trust.json"), "appeared");
    };
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(h.out.join("")).not.toContain("DELETED");
    expect(await readFile(path.join(demo.configDir, "trust.json"), "utf8")).toBe("appeared");
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBeNull();
    expect(await exists(appsFilePath(h.deps))).toBe(false);
  });

  it("the id connect records is the device the server stores when the runner then connects, once per app", async () => {
    h = await harness({ sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
    const store = createMemoryDeviceStore();
    const server = await appServer(await oauth(), { store, verifier: createStubAuthVerifier({ browser: {}, runner: { "access-1": "alice" } }) });
    const online = async () => {
      const handle = await startRunner(h.deps, await loadApps(h.deps), { e2ee: false });
      try {
        const end = Date.now() + 4000;
        while (handle.statuses().demo !== "online") {
          if (Date.now() > end) throw new Error("runner never came online");
          await new Promise((r) => setTimeout(r, 10));
        }
      } finally {
        await handle.stop();
      }
    };

    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
    const [app] = await loadApps(h.deps);
    await online();
    expect((await store.listDevices("alice")).map((d) => d.deviceId)).toEqual([app!.runnerId]);

    // Pairing again keeps the device: still one record, under the same id.
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
    await online();
    expect((await store.listDevices("alice")).map((d) => d.deviceId)).toEqual([app!.runnerId]);
  });

  it("refuses a discovery document that describes another origin, and stores nothing", async () => {
    h = await harness();
    const liar = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        app: { id: "x", name: "X" },
        origin: "https://elsewhere.example",
        auth: { issuer: "https://idp.example", clientId: "c", deviceAuthorizationEndpoint: "https://idp.example/d", tokenEndpoint: "https://idp.example/t" },
        relayUrl: "wss://elsewhere.example/relay",
        protocol: { min: 1, max: 1 },
      }));
    });
    await new Promise<void>((resolve) => liar.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => void liar.close(() => resolve())));
    const url = `http://127.0.0.1:${(liar.address() as AddressInfo).port}`;
    expect(await runCli(["connect", url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("does not match the app URL");
    expect(await loadApps(h.deps)).toEqual([]);
  });

  it("reports an unreachable app", async () => {
    h = await harness();
    expect(await runCli(["connect", "http://127.0.0.1:1", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("could not read");
  });

  it("rejects a token whose issuer is not the one bridge.json named", async () => {
    h = await harness();
    const idp = await oauth(() => jwt({ iss: "https://evil.example" }));
    const server = await appServer(idp);
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("issued by https://evil.example");
    expect(await loadApps(h.deps)).toEqual([]);
    expect(await loadTokens(h.deps.credentials!, tokenKey("demo"))).toBeNull();
  });

  it("accepts a JWT whose issuer matches", async () => {
    h = await harness();
    const idp = await oauth((issuer) => jwt({ iss: issuer }));
    const server = await appServer(idp);
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
    expect(await loadTokens(h.deps.credentials!, tokenKey("demo"))).not.toBeNull();
  });

  it("refuses a second origin that claims a connected app's id, leaving the first untouched", async () => {
    h = await harness();
    const first = await appServer(await oauth());
    expect(await runCli(["connect", first.url, "--yes"], h.deps)).toBe(0);
    const before = await loadApps(h.deps);
    const second = await appServer(await oauth(() => "access-2"));
    expect(await runCli(["connect", second.url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("bridge apps remove demo");
    expect(await loadApps(h.deps)).toEqual(before);
    expect(await loadTokens(h.deps.credentials!, tokenKey("demo"))).toMatchObject({ accessToken: "access-1" });
  });

  it("isSafeAppId rejects traversal, empty, uppercase and reserved ids", () => {
    for (const id of ["../../x", "..", ".", "a/b", "", "Demo", "bridge", "demo-app.1"]) expect(isSafeAppId(id)).toBe(false);
    expect(isSafeAppId("demo-app-1")).toBe(true);
  });

  it("refuses an app id that is not a safe file name, and stores nothing", async () => {
    h = await harness();
    for (const id of ["../../x", "..", "a/b", "", "Demo", "bridge", "a.b"]) {
      const idp = await oauth();
      let url = "";
      const liar = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          app: { id, name: "X" },
          origin: url,
          auth: { issuer: idp.url, clientId: "c", deviceAuthorizationEndpoint: `${idp.url}/d`, tokenEndpoint: `${idp.url}/t` },
          relayUrl: url.replace("http", "ws") + "/relay",
          protocol: { min: 1, max: 1 },
        }));
      });
      await new Promise<void>((resolve) => liar.listen(0, "127.0.0.1", resolve));
      closers.push(() => new Promise<void>((resolve) => void liar.close(() => resolve())));
      url = `http://127.0.0.1:${(liar.address() as AddressInfo).port}`;
      h.err.length = 0;
      expect(await runCli(["connect", url, "--yes"], h.deps)).toBe(1);
      expect(h.err.join("")).toContain(id === "" ? "app.id and app.name are required" : "cannot be a folder name");
      if (id !== "") expect(h.err.join("")).toContain("nothing was stored");
      expect(await loadApps(h.deps)).toEqual([]);
      expect(idp.requests).toEqual([]);
    }
  });
});

describe("bridge connect: the per-app layout", () => {
  it("writes apps.json once and the record into the app's own bridge/ folder; a re-run rewrites nothing in apps.json", async () => {
    h = await harness();
    const server = await appServer(await oauth());
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
    const demo = appPathsOf(h.deps, "demo");
    expect(JSON.parse(await readFile(appsFilePath(h.deps), "utf8"))).toEqual({ version: 2, apps: [{ appId: "demo", origin: server.url }] });
    expect(JSON.parse(await readFile(demo.appFile, "utf8"))).toMatchObject({ version: 1, appId: "demo", origin: server.url });
    // Connect creates only the config folder; the runner makes data and state when it needs them.
    expect(await exists(demo.dataDir)).toBe(false);
    const before = (await stat(appsFilePath(h.deps))).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
    expect((await stat(appsFilePath(h.deps))).mtimeMs).toBe(before);
  });

  it("accepts a symlinked app parent: the record lands in its target, and the consent says where", async () => {
    h = await harness();
    const real = path.join(h.root, "elsewhere", "demo-config");
    await mkdir(real, { recursive: true });
    await symlink(real, path.join(h.deps.configDir, "demo")).catch(async () => {
      await mkdir(h.deps.configDir, { recursive: true });
      await symlink(real, path.join(h.deps.configDir, "demo"));
    });
    const server = await appServer(await oauth());
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
    expect(await exists(path.join(real, "bridge", "app.json"))).toBe(true);
    expect(h.out.join("")).toContain(`(really ${path.join(real, "bridge")})`);
  });

  it("refuses a bridge/ dir that is a symlink, even one leading somewhere apart, before the question and before any request", async () => {
    h = await harness();
    const idp = await oauth();
    const server = await appServer(idp);
    const demo = appPathsOf(h.deps, "demo");
    const apart = path.join(h.root, "apart");
    await mkdir(apart, { recursive: true });
    await mkdir(demo.parents.state, { recursive: true });
    await symlink(apart, demo.stateDir);
    expect(await runCli(["connect", server.url], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("not a real folder");
    expect(h.questions).toEqual([]);
    expect(idp.requests).toEqual([]);
    expect(await exists(demo.appFile)).toBe(false);
    expect(await exists(appsFilePath(h.deps))).toBe(false);
  });

  it("refuses a bridge/ dir that resolves into the machine-wide config dir, before the question", async () => {
    h = await harness();
    const server = await appServer(await oauth());
    const demo = appPathsOf(h.deps, "demo");
    await mkdir(path.join(h.deps.configDir, "bridge", "agents"), { recursive: true });
    await mkdir(demo.parents.data, { recursive: true });
    await symlink(path.join(h.deps.configDir, "bridge", "agents"), demo.dataDir);
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toMatch(/not a real folder|overlap/);
    expect(await exists(appsFilePath(h.deps))).toBe(false);
  });

  it("refuses when a path was retargeted while the person approved in the browser, and writes nothing, not even the token", async () => {
    h = await harness();
    const server = await appServer(await oauth());
    const demo = appPathsOf(h.deps, "demo");
    const apart = path.join(h.root, "apart");
    await mkdir(apart, { recursive: true });
    // The poll sleeps once while the grant is pending: that is the "minutes in the browser".
    h.deps.sleep = async () => {
      await mkdir(demo.parents.config, { recursive: true });
      await symlink(apart, demo.configDir).catch(() => undefined);
    };
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBeNull();
    expect(await exists(path.join(apart, "app.json"))).toBe(false);
    expect(await exists(appsFilePath(h.deps))).toBe(false);
  });

  it("records the app at the consented canonical path even when its parent is retargeted after the recompute", async () => {
    h = await harness();
    const server = await appServer(await oauth());
    const demo = appPathsOf(h.deps, "demo");
    const real = path.join(h.root, "real-demo");
    const decoy = path.join(h.root, "decoy-demo");
    await mkdir(path.join(real, "bridge"), { recursive: true });
    await mkdir(path.join(decoy, "bridge"), { recursive: true });
    await mkdir(path.dirname(demo.parents.config), { recursive: true });
    await symlink(real, demo.parents.config);
    // The keychain write comes after the one recompute: retarget the parent there, inside the accepted window.
    const store = h.deps.credentials!;
    const set = store.set.bind(store);
    store.set = async (k, v) => {
      await set(k, v);
      await rm(demo.parents.config);
      await symlink(decoy, demo.parents.config);
    };
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
    expect(JSON.parse(await readFile(path.join(real, "bridge", "app.json"), "utf8"))).toMatchObject({ appId: "demo" });
    expect(await exists(path.join(decoy, "bridge", "app.json"))).toBe(false);
  });

  it("refuses an older layout before any request, consent or write", async () => {
    h = await harness();
    const idp = await oauth();
    const server = await appServer(idp);
    await mkdir(path.join(h.deps.configDir, "bridge", "trust"), { recursive: true });
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("run the old `bridge uninstall`, then `bridge setup <url>`");
    expect(idp.requests).toEqual([]);
    expect(await exists(appsFilePath(h.deps))).toBe(false);
  });
});

describe("bridge connect --open and --json", () => {
  it("persists the enroll page from discovery in the app record", async () => {
    h = await harness();
    const server = await appServer(await oauth(), undefined, "/bridge/enroll");
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
    expect((await loadApps(h.deps))[0]).toMatchObject({ enrollPage: "/bridge/enroll" });

    await h.cleanup();
    h = await harness();
    const plain = await appServer(await oauth());
    expect(await runCli(["connect", plain.url, "--yes"], h.deps)).toBe(0);
    expect((await loadApps(h.deps))[0]).not.toHaveProperty("enrollPage");
  });

  it("--open opens the device-grant URL through openUrl and still prints the URL and the code", async () => {
    h = await harness();
    const idp = await oauth();
    const server = await appServer(idp);
    expect(await runCli(["connect", server.url, "--yes", "--open"], h.deps)).toBe(0);
    expect(h.opened).toEqual([`${idp.url}/activate`]);
    expect(h.out.join("")).toContain(`${idp.url}/activate`);
    expect(h.out.join("")).toContain("WDJB-MJHT");
  });

  it("without --open no browser is opened", async () => {
    h = await harness();
    const server = await appServer(await oauth());
    expect(await runCli(["connect", server.url, "--yes"], h.deps)).toBe(0);
    expect(h.opened).toEqual([]);
  });

  it("--open prints the URL and goes on when the browser cannot be opened", async () => {
    h = await harness({ openUrl: async () => { throw new Error("no browser"); } });
    const idp = await oauth();
    const server = await appServer(idp);
    expect(await runCli(["connect", server.url, "--yes", "--open"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(`${idp.url}/activate`);
    expect(h.out.join("")).toContain("Could not open a browser");
  });

  it("--json prints need_approval, device_code and connected as JSON lines on stdout and the text on stderr", async () => {
    h = await harness();
    const idp = await oauth();
    const server = await appServer(idp);
    expect(await runCli(["connect", server.url, "--yes", "--json"], h.deps)).toBe(0);
    const events = h.out.join("").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => e.event)).toEqual(["need_approval", "device_code", "connected"]);
    expect(events[0]).toMatchObject({ what: expect.stringContaining(server.url) });
    const demo = appPathsOf(h.deps, "demo");
    expect(events[0]!.paths).toEqual([appsFilePath(h.deps), demo.appFile, demo.configDir, demo.dataDir, demo.stateDir]);
    expect(events[1]).toEqual({ event: "device_code", url: `${idp.url}/activate`, code: "WDJB-MJHT" });
    expect(events[2]).toMatchObject({ event: "connected", app: { appId: "demo", origin: server.url } });
    expect(h.err.join("")).toContain("Demo App (demo)");
  });

  it("--json reports a failure as an error event and exits 1", async () => {
    h = await harness();
    expect(await runCli(["connect", "http://127.0.0.1:1", "--yes", "--json"], h.deps)).toBe(1);
    expect(JSON.parse(h.out.join("").trim())).toMatchObject({ event: "error", code: "discovery_unreachable" });
  });

  it("refuses a discovery enrollPage that leaves the app origin, and stores nothing", async () => {
    h = await harness();
    const idp = await oauth();
    for (const enrollPage of ["//evil.example/enroll", "https://evil.example/enroll", "/a?b", "/a#b"]) {
      let url = "";
      const liar = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          app: { id: "x", name: "X" },
          origin: url,
          auth: { issuer: idp.url, clientId: "c", deviceAuthorizationEndpoint: `${idp.url}/d`, tokenEndpoint: `${idp.url}/t` },
          relayUrl: url.replace("http", "ws") + "/relay",
          protocol: { min: 1, max: 1 },
          enrollPage,
        }));
      });
      await new Promise<void>((resolve) => liar.listen(0, "127.0.0.1", resolve));
      closers.push(() => new Promise<void>((resolve) => void liar.close(() => resolve())));
      url = `http://127.0.0.1:${(liar.address() as AddressInfo).port}`;
      h.err.length = 0;
      expect(await runCli(["connect", url, "--yes"], h.deps)).toBe(1);
      expect(h.err.join("")).toContain("enrollPage");
      expect(await loadApps(h.deps)).toEqual([]);
    }
    expect(idp.requests).toEqual([]);
    expect(h.opened).toEqual([]);
  });
});

describe("appUrlOf", () => {
  it.each([
    "https://app.example/",
    "https://localhost:3000",
    "http://localhost:3000",
    "http://127.0.0.1:8080/x",
    "http://[::1]:8080",
  ])("accepts %s", (raw) => {
    expect(appUrlOf(raw).href).toBe(new URL(raw).href);
  });

  it.each([
    "http://app.example",
    "http://example.com:3000",
    "http://localhost.evil.example",
    "http://127.0.0.1.evil.example",
    "http://user@evil.example",
    "http://10.0.0.5:3000",
    "http://[::2]",
    "ftp://localhost",
    "ws://localhost",
  ])("rejects %s with a usage error that names the rule", (raw) => {
    expect(() => appUrlOf(raw)).toThrow(UsageError);
    expect(() => appUrlOf(raw)).toThrow("must be https (or http on localhost)");
  });

  it("makes `bridge connect http://app.example` fail before any request", async () => {
    h = await harness({ fetch: (() => { throw new Error("no request expected"); }) as typeof fetch });
    expect(await runCli(["connect", "http://app.example", "--yes"], h.deps)).toBe(2);
    expect(h.err.join("")).toContain("must be https");
  });
});
