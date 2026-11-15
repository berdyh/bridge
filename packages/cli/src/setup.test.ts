import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { lstat, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import path from "node:path";

import { wordsOf } from "@berdyh/bridge-protocol";
import { EnrollError, type EnrollPrompt, type EnrollWindow, type CommandResult } from "@berdyh/bridge-runner";
import { createNodeBridgeServer, createStubAuthVerifier, type NodeBridgeServer } from "@berdyh/bridge-server-node";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";
import { type HostedAppRecord, appsFilePath, loadApps as loadAllApps, upsertApp } from "./config.js";
import type { CliDeps, ConfirmOptions } from "./deps.js";
import { agentDirOf, agentLoginFileOf } from "./agent.js";
import { launcherPathOf } from "./doctor.js";
import { appPathsOf } from "./paths.js";
import { WORDS_RULE } from "./enroll.js";
import { startRunnerOf, startService } from "./setup.js";
import { readRunnerStatus, runnerPathsOf, statusFilePath, writeRunnerStatus } from "./status.js";
import { type Harness, exists, harness, record } from "./testkit.js";
import { CLI_VERSION } from "./version.js";

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
  requests: string[];
}

/** A stub OAuth server: device authorization, then one `authorization_pending`, then a token. */
async function oauth(): Promise<Oauth> {
  const requests: string[] = [];
  let polls = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      if (req.url === "/d") {
        res.end(JSON.stringify({ device_code: "dev-code", user_code: "WDJB-MJHT", verification_uri: `${url}/activate`, expires_in: 600, interval: 1 }));
      } else if (++polls % 2 === 1) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "authorization_pending" }));
      } else {
        res.end(JSON.stringify({ access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600 }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(() => new Promise<void>((resolve) => void server.close(() => resolve())));
  return { url, requests };
}

async function appServer(idp: Oauth, enrollPage: string | undefined = "/bridge/enroll"): Promise<NodeBridgeServer> {
  const server = await createNodeBridgeServer({
    ...(enrollPage ? { enrollPage } : {}),
    app: { id: "demo", name: "Demo App" },
    auth: { issuer: idp.url, clientId: "runner-client", deviceAuthorizationEndpoint: `${idp.url}/d`, tokenEndpoint: `${idp.url}/t` },
  });
  closers.push(() => server.close());
  return server;
}

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "" };
/** setup's one question. */
const ONE = (url: string): string => `Set up bridge for Demo App at ${url}?`;
/** The last line when no agent can run (the tests' machine has none unless a test adds one). */
const PAIRED_NO_AGENT = "Paired: Demo App trusts that browser, but no coding agent is ready on this machine";
const FAR = "2999-01-01T00:00:00.000Z";

interface World {
  idp: Oauth;
  server: NodeBridgeServer;
  /** The browsers the fake runner reports as trusted. */
  trusted: unknown[];
  /** What the fake `enroll` was asked (the answer to the trust request). */
  trustAnswers: boolean[];
  /** Questions asked, with the default each one carried. */
  asked: { question: string; default: ConfirmOptions["default"] }[];
  /** Per-question answers; default yes. */
  answer: (question: string) => boolean;
  /** The fake browser attempts only once the test has staged an enroll window (a non-terminal run). */
  waitForWindow: boolean;
}

/** Fake `npm install` (lays out an npm-prefix install) and fake `systemctl` (the service "starts" the runner). */
function fakeMachine(deps: CliDeps, commands: string[][], options: { serviceStarts?: boolean; startFails?: boolean } = {}): void {
  deps.run = async (command, args): Promise<CommandResult> => {
    commands.push([command, ...args]);
    if (command === "npm") {
      const prefix = args[args.indexOf("--prefix") + 1]!;
      const spec = args.at(-1)!;
      const version = /@berdyh\/bridge@(.+)$/.exec(spec)?.[1] ?? "0.0.0";
      const pkg = path.join(prefix, "node_modules/@berdyh/bridge");
      await mkdir(path.join(pkg, "bin"), { recursive: true });
      await mkdir(path.join(pkg, "dist"), { recursive: true });
      await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@berdyh/bridge", version }));
      await writeFile(path.join(pkg, "bin/run.js"), '#!/usr/bin/env node\nimport "../dist/main.js";\n', { mode: 0o755 });
      await writeFile(path.join(pkg, "dist/main.js"), "");
      return OK;
    }
    if (command === "systemctl" && args[0] === "--user" && (args[1] === "enable" || args[1] === "start" || args[1] === "restart")) {
      if (options.startFails && args[1] !== "enable") return { exitCode: 1, stdout: "", stderr: "Unit not found" };
      if (options.serviceStarts !== false) {
        await writeRunnerStatus(deps, {
          version: 1,
          pid: process.pid,
          // The service starts the runner now, after the app's record is on disk.
          startedAt: new Date().toISOString(),
          apps: Object.fromEntries((await loadApps(deps)).map((a) => [a.appId, "online" as const])),
          browsers: 0,
        });
      }
    }
    return OK;
  };
}

async function world(over: Partial<CliDeps> = {}, options: Parameters<typeof fakeMachine>[2] = {}): Promise<World> {
  const idp = await oauth();
  const server = await appServer(idp);
  const w: World = { idp, server, trusted: [], trustAnswers: [], asked: [], answer: () => true, waitForWindow: false };
  h = await harness({
    isTTY: true,
    // No agent adapter: the login step has nothing to ask. The agent-login tests pass their own.
    adapters: [],
    e2ee: {
      enroll: async (_app, prompt: EnrollPrompt) => {
        prompt.showCode("BCDFGHJK", FAR);
        if (w.waitForWindow) await until(() => existsSync(windowFile(h.deps, record({ runnerId: _app.runnerId }))));
        const ok = await prompt.confirm({ label: "Firefox", keyId: "kid-1" });
        w.trustAnswers.push(ok);
        if (!ok) throw new EnrollError("unconfirmed", "the browser was not trusted");
        w.trusted.push({ browserKeyId: "kid-1" });
        return { browserKeyId: "kid-1", label: "Firefox", enrolledAt: "2026-10-21T00:01:00.000Z" };
      },
      listBrowsers: async () => w.trusted as never,
      revokeBrowser: async () => false,
    },
    confirm: async (question, opts) => {
      h.questions.push(question);
      w.asked.push({ question, default: opts?.default });
      return w.answer(question);
    },
    ...over,
  });
  fakeMachine(h.deps, h.commands, options);
  // No agent's own command on PATH unless a test puts one there (`onPath`).
  h.deps.env.PATH = path.join(h.root, "bin");
  return w;
}

/**
 * A real (short) sleep for setup's wait for the runner. The harness sleep returns at once, so the wait's
 * looks would run back to back and could all be spent before the in-process runner has started and stopped.
 */
const shortSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.min(ms, 20)));

/** The deps of "another process" (the agent running `enroll approve`): its output is not setup's. */
const aside = (): CliDeps => ({ ...h.deps, stdout: () => {}, stderr: () => {} });
const printed = (): string => h.out.join("") + h.err.join("");
const jsonLines = (): Record<string, unknown>[] =>
  h.out.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, entry.name);
    out.push(p);
    if (entry.isDirectory()) out.push(...(await tree(p)));
  }
  return out.sort();
}

const windowFile = (deps: CliDeps, app = record()): string => appPathsOf(deps, app.appId).enrollFile;
async function putWindow(deps: CliDeps, runnerId: string): Promise<void> {
  const window: EnrollWindow = {
    v: 1,
    codeId: "code-1",
    code: "BCDFGHJK",
    expiresAt: FAR,
    attemptsLeft: 5,
    state: "open",
    ownerPid: process.pid,
    pending: { attemptId: "attempt-1", enrollId: "enroll-1", label: "Firefox", publicKey: "pk", keyId: "kid-1" },
  };
  const file = windowFile(deps, record({ runnerId }));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(window)}\n`);
}
const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

describe("bridge setup on a terminal", () => {
  it("asks one question after one grouped path list, opens the two links, and trusts the browser it opened without the words", async () => {
    const w = await world();
    let beforeQuestion = "";
    w.answer = (q) => {
      if (q === ONE(w.server.url)) beforeQuestion = printed();
      return true;
    };
    expect(await runCli(["setup", w.server.url], h.deps)).toBe(0);

    // One consent covers install, connect and the service with the bridge:// handler, listing every path, grouped, before it asks.
    expect(w.asked).toEqual([{ question: ONE(w.server.url), default: "yes" }]);
    const groups = ["install bridge", "connect this machine to Demo App", "run the runner as a background service, and register the bridge:// handler"].map((g) => beforeQuestion.indexOf(g));
    expect(groups.every((i) => i > 0)).toBe(true);
    expect([...groups].sort((a, b) => a - b)).toEqual(groups);
    for (const listed of [
      path.join(h.deps.dataDir, "bridge", "versions", CLI_VERSION),
      launcherPathOf(h.deps),
      appsFilePath(h.deps),
      runnerPathsOf(h.deps).serviceFile,
      path.join(h.deps.configDir, "mimeapps.list"),
      path.join(h.deps.dataDir, "applications", "bridge-url-handler.desktop"),
    ]) {
      expect(beforeQuestion).toContain(listed);
    }

    const text = printed();
    const launcher = launcherPathOf(h.deps);
    const paths = runnerPathsOf(h.deps);
    expect(text).toContain(`bridge ${CLI_VERSION}: setting up Demo App (demo) at ${w.server.url}`);
    for (const listed of [
      path.join(h.deps.dataDir, "bridge", "versions", CLI_VERSION),
      launcher,
      paths.serviceFile,
      path.join(h.deps.configDir, "mimeapps.list"),
      path.join(h.deps.dataDir, "applications", "bridge-url-handler.desktop"),
    ]) {
      expect(text).toContain(listed);
    }
    // The words are shown as information, with the way to revoke the browser; the enroll code and link are not printed.
    expect(text).toContain(`Trusting the browser 'Firefox' that setup opened. Its page shows these four words:\n  ${wordsOf("kid-1").join("  ")}\n`);
    expect(text).toContain("Not your browser? Revoke it: `bridge browsers revoke demo kid-1`");
    expect(text).not.toContain("BCDFGHJK");
    expect(text).not.toContain("/bridge/enroll#");
    expect(text).not.toContain(WORDS_RULE);
    // No agent on this machine: the last line says what is missing instead of "Ready".
    expect(text).toContain(PAIRED_NO_AGENT);
    expect(text).not.toContain("Ready:");
    // The grouped list is the only one: no step prints its own path list or consent text after the yes.
    const count = (needle: string): number => text.split(needle).length - 1;
    expect(count(runnerPathsOf(h.deps).serviceFile)).toBe(1);
    expect(count(appsFilePath(h.deps))).toBe(1);
    expect(count(path.join(h.deps.configDir, "mimeapps.list"))).toBe(1);
    expect(text).not.toContain("These paths will be written");
    expect(text).not.toContain("Sign-in: ");
    expect(text).toContain(`Installed bridge ${CLI_VERSION}: `);
    expect(text).toContain("Installed bridge-runner.service.");
    expect(text).toContain("Registered the bridge:// handler.");

    const [app] = await loadApps(h.deps);
    expect(h.opened).toEqual([`${w.idp.url}/activate`, `${w.server.url}/bridge/enroll#code=BCDFGHJK&runner=${app!.runnerId}`]);
    expect(w.trustAnswers).toEqual([true]);

    // What was written: the launcher link, the service, the handler; and no policy.json.
    expect((await lstat(launcher)).isSymbolicLink()).toBe(true);
    expect((await lstat(paths.serviceFile)).isFile()).toBe(true);
    expect(await readFile(path.join(h.deps.configDir, "mimeapps.list"), "utf8")).toContain("x-scheme-handler/bridge=bridge-url-handler.desktop");
    await expect(lstat(path.join(h.deps.configDir, "bridge", "policy.json"))).rejects.toThrow();
    expect(h.commands.some((c) => c.join(" ").includes("enable --now"))).toBe(true);
  });

  it("--no-open prints the links instead of opening them, and the browser is trusted only with the words", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--no-open"], h.deps)).toBe(0);
    expect(h.opened).toEqual([]);
    expect(w.asked.map((a) => a.question)).toEqual([ONE(w.server.url), "Same words?"]);
    expect(printed()).toContain(`${w.idp.url}/activate`);
    expect(printed()).toContain(`${w.server.url}/bridge/enroll#code=BCDFGHJK`);
  });

  it("a no to the one question writes, connects and runs nothing, and ends in cancelled", async () => {
    const w = await world();
    w.answer = () => false;
    const before = await tree(h.root);
    expect(await runCli(["setup", w.server.url, "--no-open"], h.deps)).toBe(1);
    expect(await tree(h.root)).toEqual(before);
    expect(await loadApps(h.deps)).toEqual([]);
    expect(w.idp.requests).toEqual([]);
    expect(h.commands).toEqual([]);
    expect(w.asked).toHaveLength(1);
    expect(h.err.join("")).toContain("bridge setup: cancelled");
  });

  it("--from-link (a bridge://setup link started it) asks the one question with a default of no", async () => {
    const w = await world();
    w.answer = () => false;
    expect(await runCli(["setup", w.server.url, "--from-link"], h.deps)).toBe(1);
    expect(w.asked).toEqual([{ question: ONE(w.server.url), default: "no" }]);
    expect(await loadApps(h.deps)).toEqual([]);
    expect(w.idp.requests).toEqual([]);
  });

  it("the four words are asked even with --yes, and a no leaves the browser untrusted", async () => {
    const w = await world();
    w.answer = (q) => q === "Same words?" ? false : true;
    expect(await runCli(["setup", w.server.url, "--yes", "--no-open"], h.deps)).toBe(1);
    // --yes answered install, connect, service and handler; only the words reached the person.
    expect(w.asked.map((a) => a.question)).toEqual(["Same words?"]);
    expect(w.trustAnswers).toEqual([false]);
    expect(w.trusted).toEqual([]);
    expect(printed()).not.toContain("Ready:");
    expect(printed()).toContain("these paths will be written");
    expect(printed()).toContain(launcherPathOf(h.deps));
    expect(printed()).toContain(runnerPathsOf(h.deps).serviceFile);
  });

  it("--yes with a terminal stops at the words and finishes when the person says yes", async () => {
    const w = await world();
    let before = "";
    const answer = w.answer;
    w.answer = (q) => {
      if (q === "Same words?") before = printed();
      return answer(q);
    };
    expect(await runCli(["setup", w.server.url, "--yes", "--no-open"], h.deps)).toBe(0);
    expect(w.asked.map((a) => a.question)).toEqual(["Same words?"]);
    expect(w.trusted).toHaveLength(1);
    // An agent may be driving the terminal: the ask-the-person rule comes before the question.
    expect(before).toContain(WORDS_RULE);
  });

  it("the setting setup.service=ask asks the one question with no default", async () => {
    const w = await world({ setupConfig: { service: "ask" } });
    expect(await runCli(["setup", w.server.url], h.deps)).toBe(0);
    expect(w.asked[0]).toEqual({ question: ONE(w.server.url), default: "none" });
    expect(w.asked.map((a) => a.question)).toEqual([ONE(w.server.url)]);
  });

  it("with setup.service=ask, --yes on a terminal needs --service or --foreground", async () => {
    const w = await world({ setupConfig: { service: "ask" } });
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("choose with --service or --foreground");
    expect(w.asked).toEqual([]);
    expect(await loadApps(h.deps)).toEqual([]);
  });

  it("with setup.service=ask, --yes alone does not answer the service question and a non-terminal run must choose", async () => {
    const w = await world({ isTTY: false, setupConfig: { service: "ask" } });
    expect(await runCli(["setup", w.server.url, "--yes", "--json"], h.deps)).toBe(1);
    expect(jsonLines().at(-1)).toMatchObject({ event: "error", code: "service_choice_required" });
    expect(await loadApps(h.deps)).toEqual([]);
  });

  it("with --no-install and a launcher that is already ours, setup.service=ask without a terminal still stops instead of asking nobody", async () => {
    const w = await world({ isTTY: false, setupConfig: { service: "ask" } });
    expect(await runCli(["self", "install", "--yes"], h.deps)).toBe(0);
    h.out.length = 0;
    h.err.length = 0;
    expect(await runCli(["setup", w.server.url, "--no-install", "--yes", "--json"], h.deps)).toBe(1);
    expect(jsonLines().at(-1)).toMatchObject({ event: "error", code: "service_choice_required" });
    expect(w.asked).toEqual([]);
    expect(await loadApps(h.deps)).toEqual([]);
  });

  it("--service is the choice, not the consent: it still asks with the paths unless --yes", async () => {
    const w = await world({ setupConfig: { service: "ask" } });
    expect(await runCli(["setup", w.server.url, "--service"], h.deps)).toBe(0);
    expect(w.asked[0]).toEqual({ question: ONE(w.server.url), default: "yes" });
  });

  it("--foreground never writes a service", async () => {
    const w = await world({ signal: AbortSignal.abort(), sleep: shortSleep });
    // The already-aborted signal stops the in-process runner at once (see above).
    expect(await runCli(["setup", w.server.url, "--foreground", "--no-open"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("bridge setup: the runner stopped before it was online");
    // Neither the service nor the bridge:// handler is in the one consent: nothing written, and how to add it later.
    expect(printed()).not.toContain("background service");
    expect(printed()).not.toContain("register the bridge:// handler");
    expect(await exists(path.join(h.deps.configDir, "mimeapps.list"))).toBe(false);
    expect(printed()).toContain("Not registering the bridge:// handler (--foreground)");
    expect(printed()).toContain("`bridge protocol install`");
    await expect(lstat(runnerPathsOf(h.deps).serviceFile)).rejects.toThrow();
    expect(printed()).toContain("Starting the runner in this terminal");
  });

  it("--foreground with the service already installed says it is ignored and how to remove the service", async () => {
    const w = await world();
    await mkdir(path.dirname(runnerPathsOf(h.deps).serviceFile), { recursive: true });
    await writeFile(runnerPathsOf(h.deps).serviceFile, "[Unit]\n");
    expect(await runCli(["setup", w.server.url, "--foreground", "--no-open"], h.deps)).toBe(0);
    expect(printed()).toContain("--foreground is ignored while the background service is installed");
    expect(printed()).toContain("`bridge service uninstall`");
    expect(h.commands.some((c) => c[0] === "systemctl" && c.includes("start"))).toBe(true);
    expect(printed()).not.toContain("Starting the runner in this terminal");
  });

  it("where no bridge:// handler exists (macOS), the consent lists the service only", async () => {
    const w = await world({ platform: "darwin", sleep: async () => {} });
    let beforeQuestion = "";
    w.answer = (q) => {
      if (q === ONE(w.server.url)) beforeQuestion = printed();
      return true;
    };
    // Nothing reports the runner online here; the question and its list are what is checked.
    expect(await runCli(["setup", w.server.url, "--no-open"], h.deps)).toBe(1);
    expect(w.asked).toEqual([{ question: ONE(w.server.url), default: "yes" }]);
    expect(beforeQuestion).toContain("run the runner as a background service:");
    expect(beforeQuestion).not.toContain("bridge:// handler");
    expect(beforeQuestion).toContain(runnerPathsOf(h.deps).serviceFile);
    expect(beforeQuestion).not.toContain("mimeapps.list");
    expect(beforeQuestion).not.toContain("bridge-url-handler.desktop");
  });

  it("--plan with --foreground offers neither the service nor the handler", async () => {
    const w = await world({ isTTY: false });
    expect(await runCli(["setup", w.server.url, "--plan", "--json", "--foreground"], h.deps)).toBe(0);
    const steps = jsonLines()[0]!.steps as { id: string; state: string; paths: string[] }[];
    expect(steps.find((s) => s.id === "service")).toMatchObject({ state: "foreground", paths: [] });
    expect(steps.find((s) => s.id === "handler")).toMatchObject({ state: "foreground", paths: [] });
  });

  it("only the window's first trust request skips the words: a second one is asked, and its browser gets no revoke line", async () => {
    const w = await world();
    h.deps.e2ee = {
      ...h.deps.e2ee!,
      // The first attempt was trusted but never delivered (the runner withdrew it); a second browser then asks.
      enroll: async (_app, prompt) => {
        prompt.showCode("BCDFGHJK", FAR);
        w.trustAnswers.push(await prompt.confirm({ label: "Firefox", keyId: "kid-1" }));
        w.trustAnswers.push(await prompt.confirm({ label: "Other", keyId: "kid-2" }));
        w.trusted.push({ browserKeyId: "kid-2" });
        return { browserKeyId: "kid-2", label: "Other", enrolledAt: "2026-10-21T00:01:00.000Z" };
      },
    };
    expect(await runCli(["setup", w.server.url], h.deps)).toBe(0);
    expect(w.trustAnswers).toEqual([true, true]);
    expect(w.asked.map((a) => a.question)).toEqual([ONE(w.server.url), "Same words?"]);
    expect(printed()).toContain(`Browser 'Other' asks to be trusted. The page shows four words.\n  ${wordsOf("kid-2").join("  ")}`);
    expect(printed()).not.toContain("Revoke it");
  });

  it("an enroll link that fails to open prints the link and code and falls back to the words", async () => {
    const w = await world();
    const open = h.deps.openUrl!;
    h.deps.openUrl = async (url) => (url.includes("/bridge/enroll#") ? Promise.reject(new Error("no browser")) : open(url));
    expect(await runCli(["setup", w.server.url], h.deps)).toBe(0);
    expect(w.asked.map((a) => a.question)).toEqual([ONE(w.server.url), "Same words?"]);
    expect(printed()).toContain(`Could not open a browser. Open ${w.server.url}/bridge/enroll#code=BCDFGHJK`);
    expect(printed()).toContain("(code: BCDFGHJK");
    expect(printed()).not.toContain("Revoke it");
  });

  it("--json on a terminal never trusts by itself: the words go to `enroll approve`", async () => {
    const w = await world();
    // No window, so there is no pending attempt for the words to be given to.
    expect(await runCli(["setup", w.server.url, "--yes", "--json"], h.deps)).toBe(1);
    expect(w.trustAnswers).toEqual([false]);
    expect(jsonLines().some((e) => e.event === "trust_request")).toBe(true);
    expect(jsonLines().at(-1)).toMatchObject({ event: "error", code: "enroll_unconfirmed" });
  });

  it("--service and --foreground together are a usage error", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--service", "--foreground"], h.deps)).toBe(2);
    expect(w.idp.requests).toEqual([]);
  });
});

/** An ACP-style adapter that is (or is not) installed; its own `availability` says nothing about bridge's login. */
function agentAdapters(installed: Record<string, boolean>): CliDeps["adapters"] {
  return Object.entries(installed).map(
    ([id, found]) => ({ id, availability: async () => ({ id, available: false }), resolved: () => (found ? { command: `/v/${id}-acp`, source: "bundled" } : undefined), spawn: async () => Promise.reject(new Error("unused")) }) as never,
  );
}
const claudeSignedIn = async (): Promise<void> => {
  await mkdir(path.join(h.root, "home/.claude"), { recursive: true });
  await writeFile(path.join(h.root, "home/.claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "c1" } }));
};
/** Puts the agents' own commands (`claude`, `codex`) on the PATH setup looks at. */
async function onPath(...agents: string[]): Promise<void> {
  const bin = path.join(h.root, "bin");
  await mkdir(bin, { recursive: true });
  for (const agent of agents) await writeFile(path.join(bin, agent), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}
/** The agent's own login, run by setup, writes its login into the folder it was pointed at. */
function loginLands(): void {
  h.spawnResult.onRun = async (_command, _args, env) => {
    const dir = env.CLAUDE_CONFIG_DIR!;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "bridge-own" } }));
  };
}

describe("bridge setup agents", () => {
  it("an agent on PATH: the one consent lists bridge's adapter and a separate sign-in, never a copy, and a failed adapter download does not stop setup", async () => {
    const w = await world({ adapters: agentAdapters({ claude: false, codex: false }) });
    await onPath("claude");
    // The person's own login is there: setup never copies it.
    await claudeSignedIn();
    loginLands();
    let beforeQuestion = "";
    w.answer = (q) => {
      if (q === ONE(w.server.url)) beforeQuestion = printed();
      return true;
    };
    expect(await runCli(["setup", w.server.url], h.deps)).toBe(0);
    expect(w.asked.map((a) => a.question)).toEqual([ONE(w.server.url)]);
    expect(beforeQuestion).toContain("bridge's claude adapter (about 300 MB from the npm registry)");
    expect(beforeQuestion).toContain("a separate claude sign-in for bridge");
    expect(beforeQuestion).toContain(path.join(h.deps.dataDir, "bridge", "adapters", "claude"));
    expect(beforeQuestion).toContain(agentDirOf(h.deps, "claude"));
    // codex is not on PATH: only named, with the commands that set it up later.
    expect(beforeQuestion).toContain("codex: not found on PATH; once it is installed, run `bridge agent install codex` (about 450 MB)");
    // The adapter download ran and failed (the fake npm lays out no adapter): reported with the command, and setup went on.
    expect(h.commands.some((c) => c[0] === "npm" && c.at(-1)!.startsWith("@agentclientprotocol/claude-agent-acp@"))).toBe(true);
    expect(printed()).toContain("The claude adapter was not installed");
    expect(printed()).toContain("Later: `bridge agent install claude`");
    // The sign-in ran with its folder in bridge's, after the adapter, and left a login made by bridge (not a copy).
    expect(h.spawned.map((s) => [s.command, ...s.args])).toEqual([["claude", "auth", "login"]]);
    expect(h.spawned[0]!.env.CLAUDE_CONFIG_DIR).toBe(agentDirOf(h.deps, "claude"));
    expect(await readFile(agentLoginFileOf(h.deps, "claude"), "utf8")).toContain("bridge-own");
    expect(JSON.parse(await readFile(path.join(agentDirOf(h.deps, "claude"), "bridge-login.json"), "utf8"))).toMatchObject({ source: "login" });
    // The agents' paths were listed once, in the grouped list; neither step repeats them.
    expect(printed().split(`  ${agentDirOf(h.deps, "claude")}\n`).length - 1).toBe(1);
    expect(printed().split(`  ${path.join(h.deps.dataDir, "bridge", "adapters", "claude")}`).length - 1).toBe(1);
    expect(printed()).not.toContain("This runs `claude auth login`");
    expect(printed()).not.toContain("These paths will be written");
    // No agent can run (no adapter): the last line says what is missing, not "Ready".
    expect(printed()).toContain(`${PAIRED_NO_AGENT} (claude: run \`bridge agent install claude\` (about 300 MB);`);
    expect(printed()).not.toContain("Ready:");
  });

  it("an agent on PATH with the adapter installed and no login: setup signs it in for bridge and ends Ready", async () => {
    const w = await world({ adapters: agentAdapters({ claude: true }) });
    await onPath("claude");
    loginLands();
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    // --yes answered the one question; the sign-in itself is the agent's own flow in this terminal.
    expect(w.asked).toEqual([]);
    expect(h.commands.some((c) => c[0] === "npm" && c.join(" ").includes("claude-agent-acp"))).toBe(false);
    expect(h.spawned).toHaveLength(1);
    expect(await exists(agentLoginFileOf(h.deps, "claude"))).toBe(true);
    expect(printed()).toContain("Ready: Demo App can use your coding agent");
  });

  it("a sign-in that fails is reported with the command and setup goes on", async () => {
    const w = await world({ adapters: agentAdapters({ claude: true }) });
    await onPath("claude");
    h.spawnResult.exitCode = 1;
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    expect(printed()).toContain("No claude login for bridge yet. Later: `bridge agent login claude --login`.");
    expect(printed()).toContain(`${PAIRED_NO_AGENT} (claude: run \`bridge agent login claude --login\``);
  });

  it("asks and runs nothing for an agent whose adapter and login are in place", async () => {
    const w = await world({ adapters: agentAdapters({ claude: true, codex: false }) });
    await onPath("claude");
    await mkdir(agentDirOf(h.deps, "claude"), { recursive: true });
    await writeFile(agentLoginFileOf(h.deps, "claude"), JSON.stringify({ claudeAiOauth: { accessToken: "c1" } }));
    expect(await runCli(["setup", w.server.url], h.deps)).toBe(0);
    expect(w.asked.map((a) => a.question)).toEqual([ONE(w.server.url)]);
    expect(h.spawned).toEqual([]);
    expect(h.commands.some((c) => c[0] === "npm" && c.join(" ").includes("acp"))).toBe(false);
    expect(printed()).toContain("Ready: Demo App can use your coding agent");
  });

  it("with no agent on PATH, setup names each with the commands that set it up and asks nothing for agents", async () => {
    const w = await world({ adapters: agentAdapters({ claude: false, codex: false }) });
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    const text = printed();
    expect(text).toContain("Not set up here: claude: not found on PATH; once it is installed, run `bridge agent install claude` (about 300 MB) and `bridge agent login claude --login`; codex: not found on PATH");
    expect(h.spawned).toEqual([]);
    expect(text).toContain(PAIRED_NO_AGENT);
  });

  it("with no usable keychain setup refuses before any question or write, with the BRIDGE_CREDENTIAL_STORE hint", async () => {
    const w = await world();
    delete h.deps.credentials;
    const base = h.deps.run!;
    h.deps.run = async (command, args) => (command === "secret-tool" ? { exitCode: 1, stdout: "", stderr: "The name org.freedesktop.secrets was not provided by any .service files\n" } : base(command, args));
    const before = await tree(h.root);
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("the OS keychain is not usable here");
    expect(h.err.join("")).toContain("BRIDGE_CREDENTIAL_STORE=file:<absolute directory>");
    expect(w.asked).toEqual([]);
    expect(w.idp.requests).toEqual([]);
    expect(await tree(h.root)).toEqual(before);
    expect(await loadApps(h.deps)).toEqual([]);
  });

  it("a keychain that does not answer in time: setup refuses before any question or write", async () => {
    const w = await world();
    delete h.deps.credentials;
    const base = h.deps.run!;
    h.deps.run = async (command, args) => {
      if (command === "secret-tool") throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      return base(command, args);
    };
    const before = await tree(h.root);
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("the OS keychain did not answer within 5 s");
    expect(w.asked).toEqual([]);
    expect(w.idp.requests).toEqual([]);
    expect(await tree(h.root)).toEqual(before);
  });

  it("an already connected app with a hanging keychain: the bounded probe refuses before any token read, so setup does not hang", async () => {
    const w = await world();
    await upsertApp(h.deps, record({ appId: "demo", name: "Demo App", origin: w.server.url, url: w.server.url }));
    delete h.deps.credentials;
    const calls: { args: readonly string[]; timeoutMs: number | undefined }[] = [];
    // Like the real secret-tool against a service that never answers: it only ends through the timeout it is given.
    h.deps.run = async (command, args, options) => {
      if (command !== "secret-tool") return OK;
      calls.push({ args, timeoutMs: options?.timeoutMs });
      if (options?.timeoutMs === undefined) return new Promise<never>(() => {});
      throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    };
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("the OS keychain did not answer within 5 s");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toBe("lookup");
    expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
    expect(w.asked).toEqual([]);
    expect(w.idp.requests).toEqual([]);
  }, 10000);

  it("--plan names the credential store in use: the files under BRIDGE_CREDENTIAL_STORE=file:<dir>, else the OS keychain", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--plan"], h.deps)).toBe(0);
    expect(printed()).toContain("the sign-in token goes to the OS keychain");
    h.out.length = 0;
    h.deps.env.BRIDGE_CREDENTIAL_STORE = `file:${h.root}/creds`;
    expect(await runCli(["setup", w.server.url, "--plan"], h.deps)).toBe(0);
    expect(printed()).toContain("the sign-in token goes to the credential files (BRIDGE_CREDENTIAL_STORE)");
    expect(printed()).not.toContain("OS keychain");
    // The plan's connect step lists the credential folder among its paths.
    expect(printed()).toContain(`  ${h.root}/creds\n`);
  });

  it("--plan lists the adapter and agent folders among the paths, and writes nothing", async () => {
    const w = await world({ adapters: agentAdapters({ claude: false }) });
    await onPath("claude");
    const before = await tree(h.root);
    expect(await runCli(["setup", w.server.url, "--plan"], h.deps)).toBe(0);
    expect(await tree(h.root)).toEqual(before);
    expect(printed()).toContain("agents: needed");
    expect(printed()).toContain(path.join(h.deps.dataDir, "bridge", "adapters", "claude"));
    expect(printed()).toContain(agentDirOf(h.deps, "claude"));
  });

  it("under --json --yes the adapter still installs, the sign-in is reported as agent_login_required, and nothing is spawned", async () => {
    const w = await world({ isTTY: false, adapters: agentAdapters({ claude: false }) });
    await onPath("claude");
    await claudeSignedIn();
    w.waitForWindow = true;
    const done = runCli(["setup", w.server.url, "--yes", "--json"], h.deps);
    await until(() => jsonLines().some((e) => e.event === "enroll_code"));
    const [app] = await loadApps(h.deps);
    await putWindow(h.deps, app!.runnerId);
    await until(() => jsonLines().some((e) => e.event === "trust_request"));
    expect(await runCli(["enroll", "approve", "demo", "--words", wordsOf("kid-1").join(" ")], aside())).toBe(0);
    expect(await done).toBe(0);
    const events = jsonLines();
    const names = events.map((e) => e.event);
    expect(h.commands.some((c) => c[0] === "npm" && c.at(-1)!.startsWith("@agentclientprotocol/claude-agent-acp@"))).toBe(true);
    expect(names.indexOf("agent_login_required")).toBeGreaterThan(names.indexOf("connected"));
    expect(names.indexOf("agent_login_required")).toBeLessThan(names.indexOf("service"));
    expect(events[names.indexOf("agent_login_required")]).toEqual({ event: "agent_login_required", agents: ["claude"], command: "bridge agent login <agent> --login" });
    expect(names.at(-1)).toBe("ready");
    expect(w.asked).toEqual([]);
    expect(h.spawned).toEqual([]);
    expect(await exists(agentLoginFileOf(h.deps, "claude"))).toBe(false);
  });
});

describe("bridge setup --plan", () => {
  it("writes nothing, opens nothing, pairs nothing and prints every step with its paths", async () => {
    const w = await world();
    const before = await tree(h.root);
    expect(await runCli(["setup", w.server.url, "--plan"], h.deps)).toBe(0);
    expect(await tree(h.root)).toEqual(before);
    expect(h.commands).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(w.idp.requests).toEqual([]);
    expect(w.asked).toEqual([]);
    const text = printed();
    for (const id of ["install:", "connect:", "service:", "handler:", "enroll:"]) expect(text).toContain(id);
    expect(text).toContain(launcherPathOf(h.deps));
    expect(text).toContain(runnerPathsOf(h.deps).serviceFile);
    expect(text).toContain(path.join(h.deps.configDir, "mimeapps.list"));
    expect(text).toContain(appPathsOf(h.deps, "demo").workDir);
    for (const p of [appsFilePath(h.deps), appPathsOf(h.deps, "demo").appFile, appPathsOf(h.deps, "demo").configDir, appPathsOf(h.deps, "demo").dataDir, appPathsOf(h.deps, "demo").stateDir]) expect(text).toContain(p);
    expect(text).toContain("Nothing was written");
  });

  it("never says an agent is ready when none can run, and names each with its commands", async () => {
    const w = await world({ adapters: agentAdapters({ claude: false, codex: false }) });
    // A login file left in bridge's folder does not make an agent ready when its adapter is nowhere.
    await mkdir(agentDirOf(h.deps, "claude"), { recursive: true });
    await writeFile(agentLoginFileOf(h.deps, "claude"), JSON.stringify({ claudeAiOauth: { accessToken: "c1" } }));
    expect(await runCli(["setup", w.server.url, "--plan"], h.deps)).toBe(0);
    const line = printed().split("\n").find((l) => l.startsWith("agents:"))!;
    expect(line).toContain("no_agent");
    expect(line).not.toContain("ready;");
    expect(line).toContain("claude: not found on PATH; once it is installed, run `bridge agent install claude` (about 300 MB)");
    expect(line).toContain("codex: not found on PATH; once it is installed, run `bridge agent install codex` (about 450 MB) and `bridge agent login codex --login`");

    h.out.length = 0;
    expect(await runCli(["setup", w.server.url, "--plan", "--json"], h.deps)).toBe(0);
    const step = (jsonLines()[0]!.steps as { id: string; state: string; paths: string[]; note?: string }[]).find((x) => x.id === "agents")!;
    expect(step.state).toBe("no_agent");
    expect(step.paths).toEqual([]);
    expect(step.note).toContain("bridge agent install codex");
  });

  it("says an agent is ready when its adapter and bridge's login are in place", async () => {
    const w = await world({ adapters: agentAdapters({ claude: true, codex: false }) });
    await mkdir(agentDirOf(h.deps, "claude"), { recursive: true });
    await writeFile(agentLoginFileOf(h.deps, "claude"), JSON.stringify({ claudeAiOauth: { accessToken: "c1" } }));
    expect(await runCli(["setup", w.server.url, "--plan"], h.deps)).toBe(0);
    const line = printed().split("\n").find((l) => l.startsWith("agents:"))!;
    expect(line).toContain("agents: ready");
    expect(line).toContain("claude: ready");
    expect(line).not.toContain("bridge agent install claude");
  });
  it("--plan --json prints one plan event and nothing else on stdout", async () => {
    const w = await world({ isTTY: false });
    expect(await runCli(["setup", w.server.url, "--plan", "--json"], h.deps)).toBe(0);
    const events = jsonLines();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "plan", app: { appId: "demo", origin: w.server.url } });
    const steps = events[0]!.steps as { id: string; paths: string[] }[];
    expect(steps.map((s) => s.id)).toEqual(["install", "connect", "agents", "service", "handler", "enroll"]);
    expect(steps.find((s) => s.id === "install")!.paths).toContain(launcherPathOf(h.deps));
  });
});

describe("bridge setup without a terminal", () => {
  it("stops before the first write when nobody can be asked and --yes was not given", async () => {
    const w = await world({ isTTY: false });
    const before = await tree(h.root);
    expect(await runCli(["setup", w.server.url], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("--yes");
    expect(await tree(h.root)).toEqual(before);
    expect(w.idp.requests).toEqual([]);
    expect(w.asked).toEqual([]);
  });

  it("--json --yes emits every step as a JSON line in order, text on stderr, and waits for `enroll approve` at the words", async () => {
    const w = await world({ isTTY: false });
    w.waitForWindow = true;
    const done = runCli(["setup", w.server.url, "--yes", "--json"], h.deps);
    // The fake runner has no browser; stage the pending attempt the real runner would write.
    await until(() => jsonLines().some((e) => e.event === "enroll_code"));
    const [app] = await loadApps(h.deps);
    await putWindow(h.deps, app!.runnerId);
    await until(() => jsonLines().some((e) => e.event === "trust_request"));
    const words = wordsOf("kid-1");
    expect(await runCli(["enroll", "approve", "demo", "--words", words.join(" ")], aside())).toBe(0);
    expect(await done).toBe(0);

    const events = jsonLines();
    expect(events.map((e) => e.event)).toEqual([
      "plan",
      "need_approval", // the one consent: every group
      "device_code",
      "connected",
      "service",
      "enroll_code",
      "trust_request",
      "ready",
    ]);
    const groups = events[1]!.groups as { id: string; what: string; paths: string[] }[];
    expect(events[1]).toMatchObject({ what: `set up bridge for Demo App at ${w.server.url}` });
    expect(groups.map((g) => g.id)).toEqual(["install", "connect", "service"]);
    expect(groups[0]).toMatchObject({ what: `install bridge ${CLI_VERSION} for this user`, paths: expect.arrayContaining([launcherPathOf(h.deps)]) });
    expect(groups[1]).toMatchObject({ what: expect.stringContaining("Demo App"), paths: expect.arrayContaining([appsFilePath(h.deps)]) });
    expect(groups[2]!.paths).toEqual(expect.arrayContaining([runnerPathsOf(h.deps).serviceFile, path.join(h.deps.configDir, "mimeapps.list")]));
    expect(events[1]!.paths).toEqual(groups.flatMap((g) => g.paths));
    expect(events[2]).toEqual({ event: "device_code", url: `${w.idp.url}/activate`, code: "WDJB-MJHT" });
    expect(events[5]).toMatchObject({ code: "BCDFGHJK", url: `${w.server.url}/bridge/enroll#code=BCDFGHJK&runner=${app!.runnerId}` });
    expect(events[6]).toMatchObject({ label: "Firefox", words, keyId: "kid-1" });
    expect(String(events[6]!.instructions)).toMatch(/Ask the person/);
    expect(String(events[6]!.instructions)).toMatch(/Never guess/);
    expect(events[7]).toMatchObject({ status: "paired", keyId: "kid-1" });
    expect(await readFile(path.join(h.deps.configDir, "mimeapps.list"), "utf8")).toContain("x-scheme-handler/bridge=bridge-url-handler.desktop");
    expect(w.asked).toEqual([]);
    // Text is on stderr, including the agent-facing instruction about the words.
    expect(h.err.join("")).toContain("Ask the person for the four words");
    expect(h.err.join("")).not.toContain(`--words "${words.join(" ")}"`);
  });

  it("with setup.service=ask and no terminal, --service --yes answers the one consent for the service and the handler", async () => {
    const w = await world({ isTTY: false, setupConfig: { service: "ask" } });
    w.waitForWindow = true;
    const done = runCli(["setup", w.server.url, "--service", "--yes", "--json"], h.deps);
    await until(() => jsonLines().some((e) => e.event === "enroll_code"));
    const [app] = await loadApps(h.deps);
    await putWindow(h.deps, app!.runnerId);
    await until(() => jsonLines().some((e) => e.event === "trust_request"));
    expect(await runCli(["enroll", "deny", "demo"], aside())).toBe(0);
    expect(await done).toBe(1);
    const approvals = jsonLines().filter((e) => e.event === "need_approval");
    expect(approvals).toHaveLength(1);
    expect((approvals[0]!.groups as { id: string }[]).map((g) => g.id)).toEqual(["install", "connect", "service"]);
    expect(await readFile(path.join(h.deps.configDir, "mimeapps.list"), "utf8")).toContain("x-scheme-handler/bridge=bridge-url-handler.desktop");
    expect(w.asked).toEqual([]);
  });

  it("with the service already installed, setup.service=ask and no terminal, --yes skips the handler offer and says how to register it later", async () => {
    const w = await world({ isTTY: false, setupConfig: { service: "ask" } });
    await mkdir(path.dirname(runnerPathsOf(h.deps).serviceFile), { recursive: true });
    await writeFile(runnerPathsOf(h.deps).serviceFile, "[Unit]\n");
    w.waitForWindow = true;
    const done = runCli(["setup", w.server.url, "--yes", "--json"], h.deps);
    await until(() => jsonLines().some((e) => e.event === "enroll_code"));
    const [app] = await loadApps(h.deps);
    await putWindow(h.deps, app!.runnerId);
    await until(() => jsonLines().some((e) => e.event === "trust_request"));
    expect(await runCli(["enroll", "deny", "demo"], aside())).toBe(0);
    expect(await done).toBe(1);
    expect(jsonLines().some((e) => e.event === "need_approval" && JSON.stringify(e.groups).includes("bridge:// handler"))).toBe(false);
    expect(await exists(path.join(h.deps.configDir, "mimeapps.list"))).toBe(false);
    expect(h.err.join("")).toContain("The bridge:// handler was not registered");
    expect(h.err.join("")).toContain("register it later with `bridge protocol install`");
    expect(w.asked).toEqual([]);
  });

  it("--yes without a terminal never trusts a browser by itself: with no decision the attempt is not trusted", async () => {
    const w = await world({ isTTY: false });
    // No window, so there is no pending attempt for the words to be given to.
    expect(await runCli(["setup", w.server.url, "--yes", "--json"], h.deps)).toBe(1);
    expect(w.trustAnswers).toEqual([false]);
    expect(w.trusted).toEqual([]);
    expect(jsonLines().at(-1)).toMatchObject({ event: "error", code: "enroll_unconfirmed" });
    expect(jsonLines().some((e) => e.event === "ready")).toBe(false);
  });

  it("a wrong set of words is refused by `enroll approve` and the browser stays untrusted", async () => {
    const w = await world({ isTTY: false });
    w.waitForWindow = true;
    const done = runCli(["setup", w.server.url, "--yes", "--json"], h.deps);
    await until(() => jsonLines().some((e) => e.event === "enroll_code"));
    const [app] = await loadApps(h.deps);
    await putWindow(h.deps, app!.runnerId);
    await until(() => jsonLines().some((e) => e.event === "trust_request"));
    expect(await runCli(["enroll", "approve", "demo", "--words", "wrong words from the agent"], aside())).toBe(2);
    expect(await runCli(["enroll", "approve", "demo", "--words", "one two three four"], aside())).toBe(1);
    expect(await done).toBe(1);
    expect(w.trusted).toEqual([]);
  });
});

describe("bridge setup and a runner that is already running", () => {
  const live = (apps: Record<string, string>, startedAt = "2026-10-21T00:00:00.000Z") => ({ version: 1 as const, pid: process.pid, startedAt, apps: apps as never, browsers: 0 });

  it("a running runner that does not serve this app, with no service, asks the person to restart it", async () => {
    const w = await world({ isTTY: false });
    await writeRunnerStatus(h.deps, live({}));
    expect(await runCli(["setup", w.server.url, "--foreground", "--no-install", "--yes", "--json"], h.deps)).toBe(1);
    expect(jsonLines().at(-1)).toMatchObject({ event: "error", code: "runner_restart_required" });
    expect(h.commands.filter((c) => c[0] === "systemctl")).toEqual([]);
  });

  it("with the service installed, a running runner that does not serve this app is restarted through it", async () => {
    const w = await world({ isTTY: false });
    w.waitForWindow = true;
    const done = runCli(["setup", w.server.url, "--yes", "--json"], h.deps);
    await until(() => jsonLines().some((e) => e.event === "enroll_code"));
    const [app] = await loadApps(h.deps);
    await putWindow(h.deps, app!.runnerId);
    await until(() => jsonLines().some((e) => e.event === "trust_request"));
    expect(await runCli(["enroll", "approve", "demo", "--words", wordsOf("kid-1").join(" ")], aside())).toBe(0);
    expect(await done).toBe(0);

    // The runner is up but was started before the app was connected.
    await writeRunnerStatus(h.deps, live({}));
    h.commands.length = 0;
    h.out.length = 0;
    expect(await runCli(["setup", w.server.url, "--yes", "--json"], h.deps)).toBe(0);
    expect(h.commands).toContainEqual(["systemctl", "--user", "restart", runnerPathsOf(h.deps).serviceName]);
    expect(jsonLines().at(-1)).toMatchObject({ event: "ready" });
  });

  it.each(["auth_failed", "update_required", "replaced"])("a runner that reports the app as %s ends in runner_%s", async (status) => {
    const w = await world({ isTTY: false });
    // A runner that started after the app's record was written (FAR is after any record), so its word is about the current identity.
    await writeRunnerStatus(h.deps, live({ demo: status }, FAR));
    expect(await runCli(["setup", w.server.url, "--foreground", "--no-install", "--yes", "--json"], h.deps)).toBe(1);
    expect(jsonLines().at(-1)).toMatchObject({ event: "error", code: `runner_${status}` });
  });
});

describe("bridge setup and a revoked machine", () => {
  const live = (apps: Record<string, string>, startedAt: string) => ({ version: 1 as const, pid: process.pid, startedAt, apps: apps as never, browsers: 0 });

  it("a runner that reports the app as revoked: setup connects it again with a new runner id and restarts the service, instead of stopping on it", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    const [before] = await loadApps(h.deps);
    // The service's runner started with the record (not before it) and is parked on "revoked".
    await writeRunnerStatus(h.deps, live({ demo: "revoked" }, before!.connectedAt));
    h.out.length = 0;
    h.err.length = 0;
    h.commands.length = 0;

    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    const [after] = await loadApps(h.deps);
    expect(after!.runnerId).not.toBe(before!.runnerId);
    expect(printed()).toContain("revoked");
    expect(printed()).not.toContain("Already connected");
    expect(h.commands).toContainEqual(["systemctl", "--user", "restart", runnerPathsOf(h.deps).serviceName]);
    expect(printed()).toContain("but no coding agent is ready on this machine");

    // Run again, with the old runner still reporting revoked (the restart did not happen): no third id.
    await writeRunnerStatus(h.deps, live({ demo: "revoked" }, "2026-10-21T00:00:00.000Z"));
    h.commands.length = 0;
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    expect((await loadApps(h.deps))[0]!.runnerId).toBe(after!.runnerId);
    expect(h.commands).toContainEqual(["systemctl", "--user", "restart", runnerPathsOf(h.deps).serviceName]);
  });

  it("a revoked.json naming the stored runner id, with no runner up: setup connects it again with a new runner id, and the mark goes", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    const [before] = await loadApps(h.deps);
    const markFile = appPathsOf(h.deps, "demo").revokedFile;
    await writeFile(markFile, JSON.stringify({ version: 1, runnerId: before!.runnerId, at: "2026-10-20T00:00:00.000Z" }));
    await rm(statusFilePath(h.deps), { force: true });
    expect(await readRunnerStatus(h.deps)).toBeUndefined();
    h.out.length = 0;
    expect(await runCli(["setup", w.server.url, "--plan"], h.deps)).toBe(0);
    expect(printed()).toMatch(/connect: needed[^\n]*revoked/);
    expect((await loadApps(h.deps))[0]!.runnerId).toBe(before!.runnerId);

    h.out.length = 0;
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    const [after] = await loadApps(h.deps);
    expect(after!.runnerId).not.toBe(before!.runnerId);
    expect(await exists(markFile)).toBe(false);
    expect(printed()).toContain(markFile);

    // Run again: the mark is gone, so no third id.
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    expect((await loadApps(h.deps))[0]!.runnerId).toBe(after!.runnerId);
  });

  it.each(["reconnecting", "online", "auth_failed", "replaced"])(
    "a service runner that started after the old record holds the revoked id and reports %s: setup mints a new id, restarts the service and reaches online",
    async (status) => {
      const w = await world();
      expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
      const [before] = await loadApps(h.deps);
      // The relay refused the stored id; the runner restarted on it and now retries ("reconnecting"), so its link no longer reads revoked.
      await writeFile(appPathsOf(h.deps, "demo").revokedFile, JSON.stringify({ version: 1, runnerId: before!.runnerId, at: "2026-10-20T00:00:00.000Z" }));
      await writeRunnerStatus(h.deps, live({ demo: status }, before!.connectedAt));
      h.out.length = 0;
      h.commands.length = 0;

      expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
      const [after] = await loadApps(h.deps);
      expect(after!.runnerId).not.toBe(before!.runnerId);
      expect(h.commands).toContainEqual(["systemctl", "--user", "restart", runnerPathsOf(h.deps).serviceName]);
      expect(printed()).toContain("but no coding agent is ready on this machine");
    },
  );

  it("the mark already gone and the record already rewritten (a second setup after a timed-out first): the runner on the old id is still restarted", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    const [before] = await loadApps(h.deps);
    await writeFile(appPathsOf(h.deps, "demo").revokedFile, JSON.stringify({ version: 1, runnerId: before!.runnerId, at: "2026-10-20T00:00:00.000Z" }));
    await writeRunnerStatus(h.deps, live({ demo: "reconnecting" }, before!.connectedAt));
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    const [rewritten] = await loadApps(h.deps);
    expect(rewritten!.runnerId).not.toBe(before!.runnerId);
    expect(await exists(appPathsOf(h.deps, "demo").revokedFile)).toBe(false);

    // The restart did not take: the runner that started before the rewrite is still the one that reports.
    await writeRunnerStatus(h.deps, live({ demo: "reconnecting" }, before!.connectedAt));
    h.commands.length = 0;
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    expect((await loadApps(h.deps))[0]!.runnerId).toBe(rewritten!.runnerId);
    expect(h.commands).toContainEqual(["systemctl", "--user", "restart", runnerPathsOf(h.deps).serviceName]);
  });

  it("a runner that started after an unchanged record is left alone", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    const [app] = await loadApps(h.deps);
    await writeRunnerStatus(h.deps, live({ demo: "online" }, app!.connectedAt));
    h.out.length = 0;
    h.commands.length = 0;
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    expect(h.commands.filter((c) => c[0] === "systemctl")).toEqual([]);
    expect((await loadApps(h.deps))[0]!.runnerId).toBe(app!.runnerId);
    expect(printed()).toContain("already running");
  });

  describe("re-pairing an unchanged runner id while its runner stays online", () => {
    const later = () => new Promise((r) => setTimeout(r, 15));

    it("`bridge connect` again, then setup with the service: the runner is reused, not restarted", async () => {
      const w = await world();
      expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
      const [before] = await loadApps(h.deps);
      await writeRunnerStatus(h.deps, live({ demo: "online" }, before!.connectedAt));
      await later();
      expect(await runCli(["connect", w.server.url, "--yes"], h.deps)).toBe(0);
      const [repaired] = await loadApps(h.deps);
      expect(repaired!.runnerId).toBe(before!.runnerId);

      h.out.length = 0;
      h.commands.length = 0;
        expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
      expect(h.commands.filter((c) => c[0] === "systemctl")).toEqual([]);
      expect(printed()).toContain("already running");
      expect(printed()).not.toContain("restarting it");
    });

    it("the same without a service: no runner_restart_required", async () => {
      const w = await world({ isTTY: false });
      await upsertApp(h.deps, record({ origin: w.server.url, url: w.server.url, runnerId: "kept-runner", connectedAt: "2026-10-14T00:00:00.000Z" }));
      await writeRunnerStatus(h.deps, live({ demo: "online" }, "2026-10-21T00:00:00.000Z"));
      expect(await runCli(["connect", w.server.url, "--yes"], h.deps)).toBe(0);
      expect((await loadApps(h.deps))[0]!.runnerId).toBe("kept-runner");
      h.out.length = 0;
      // It goes on to the browser enrollment (nobody answers the words here): the runner step is what is under test.
      await runCli(["setup", w.server.url, "--foreground", "--no-install", "--yes", "--json"], h.deps);
      expect(jsonLines().map((e) => e.code)).not.toContain("runner_restart_required");
      expect(jsonLines().some((e) => e.event === "enroll_code")).toBe(true);
      expect(printed()).toContain("The runner is already running");
    });

    it("a runner that reports a final status for the unchanged id still ends in that status, not in a restart", async () => {
      const w = await world({ isTTY: false });
      await upsertApp(h.deps, record({ origin: w.server.url, url: w.server.url, runnerId: "kept-runner", connectedAt: "2026-10-14T00:00:00.000Z" }));
      await writeRunnerStatus(h.deps, live({ demo: "auth_failed" }, "2026-10-21T00:00:00.000Z"));
      expect(await runCli(["connect", w.server.url, "--yes"], h.deps)).toBe(0);
      h.out.length = 0;
      expect(await runCli(["setup", w.server.url, "--foreground", "--no-install", "--yes", "--json"], h.deps)).toBe(1);
      expect(jsonLines().at(-1)).toMatchObject({ event: "error", code: "runner_auth_failed" });
    });
  });

  it("--plan names the new connection a revoked link needs", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    const [before] = await loadApps(h.deps);
    await writeRunnerStatus(h.deps, live({ demo: "revoked" }, before!.connectedAt));
    h.out.length = 0;
    expect(await runCli(["setup", w.server.url, "--plan"], h.deps)).toBe(0);
    expect(printed()).toMatch(/connect: needed[^\n]*revoked/);
    expect((await loadApps(h.deps))[0]!.runnerId).toBe(before!.runnerId);
  });

  it("without the service, a running runner that holds the revoked id is not restarted for the person: setup says so after connecting, and a second run mints no second id", async () => {
    const w = await world({ isTTY: false });
    await upsertApp(h.deps, record({ origin: w.server.url, url: w.server.url, runnerId: "old-runner", connectedAt: "2026-10-14T00:00:00.000Z" }));
    await writeRunnerStatus(h.deps, live({ demo: "revoked" }, "2026-10-21T00:00:00.000Z"));
    expect(await runCli(["setup", w.server.url, "--foreground", "--no-install", "--yes", "--json"], h.deps)).toBe(1);
    expect(jsonLines().at(-1)).toMatchObject({ event: "error", code: "runner_restart_required" });
    const [app] = await loadApps(h.deps);
    expect(app!.runnerId).not.toBe("old-runner");
    expect(h.commands.filter((c) => c[0] === "systemctl")).toEqual([]);

    expect(await runCli(["setup", w.server.url, "--foreground", "--no-install", "--yes", "--json"], h.deps)).toBe(1);
    expect(jsonLines().at(-1)).toMatchObject({ event: "error", code: "runner_restart_required" });
    expect((await loadApps(h.deps))[0]!.runnerId).toBe(app!.runnerId);
  });
});

describe("bridge setup run again", () => {
  it("skips what is done: no install, no pairing, no service question, no new trust unless the person asks", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    h.out.length = 0;
    h.err.length = 0;
    h.commands.length = 0;
    h.opened.length = 0;
    w.asked.length = 0;
    w.idp.requests.length = 0;

    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    expect(h.commands.filter((c) => c[0] === "npm")).toEqual([]);
    expect(h.commands.filter((c) => c[0] === "systemctl")).toEqual([]);
    expect(w.idp.requests).toEqual([]);
    expect(h.opened).toEqual([]);
    // Nothing is left to consent to, and an already trusted browser asks nothing: `bridge enroll` pairs another.
    expect(w.asked).toEqual([]);
    expect(printed()).toContain("To pair another browser, run `bridge enroll demo --open`.");
    expect(printed()).toContain("already installed");
    expect(printed()).toContain("Already connected");
    expect(printed()).toContain("The background service is already installed");
    expect(printed()).toContain("The runner is already running");
    expect(printed()).toContain("already trusted");
    expect(await loadApps(h.deps)).toHaveLength(1);
  });

  it("after install.sh with a file:// BRIDGE_INSTALL_BASE, the installed version is current: the base (<base>/<version>/ layout) is never read", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    h.out.length = 0;
    h.err.length = 0;
    h.commands.length = 0;
    w.answer = () => false;
    // install.sh's base: the set is at <base>/<version>/; the base itself holds no SHA256SUMS.
    const base = path.join(h.root, "release");
    await mkdir(base, { recursive: true });
    h.deps.env.BRIDGE_INSTALL_BASE = `file://${base}`;
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    expect(printed()).not.toContain("SHA256SUMS");
    expect(printed()).toContain("already installed");
    expect(h.commands.filter((c) => c[0] === "npm")).toEqual([]);
  });

  it("without a terminal, an already trusted browser ends in ready{already_trusted} and the way to pair another", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    h.deps.isTTY = false;
    h.out.length = 0;
    h.err.length = 0;
    expect(await runCli(["setup", w.server.url, "--yes", "--json"], h.deps)).toBe(0);
    expect(jsonLines().at(-1)).toMatchObject({ event: "ready", status: "already_trusted", trustedBrowsers: 1 });
    expect(h.err.join("")).toContain("bridge enroll demo --open");
  });

  it("re-pairs when the app's sign-in changed, keeping the runner id", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    const [before] = await loadApps(h.deps);
    await upsertApp(h.deps, { ...before!, auth: { ...before!.auth, clientId: "old-client" } });
    w.idp.requests.length = 0;
    w.trusted.length = 0;
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    expect(w.idp.requests).toContain("/d");
    expect((await loadApps(h.deps))[0]!.runnerId).toBe(before!.runnerId);
  });

  it("a re-run uses discovery's name and enroll page for this run and does not write apps.json", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    const [before] = await loadApps(h.deps);
    await upsertApp(h.deps, { ...before!, name: "Old Name", enrollPage: "/old/enroll" });
    const stored = await readFile(appsFilePath(h.deps), "utf8");
    h.deps.isTTY = false;
    h.out.length = 0;
    expect(await runCli(["setup", w.server.url, "--plan", "--json"], h.deps)).toBe(0);
    expect((jsonLines()[0]!.steps as { id: string }[]).find((s) => s.id === "connect")).toMatchObject({ state: "connected", paths: [] });
    h.deps.isTTY = true;
    w.trusted.length = 0;
    h.opened.length = 0;
    h.out.length = 0;
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    expect(h.opened).toEqual([`${w.server.url}/bridge/enroll#code=BCDFGHJK&runner=${before!.runnerId}`]);
    expect(printed()).toContain("Already connected to Demo App");
    expect(await readFile(appsFilePath(h.deps), "utf8")).toBe(stored); // `bridge connect` updates it, not setup
  });

  it("never uses a stored enrollPage that left the app's origin: the link is discovery's, on the app", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    const [before] = await loadApps(h.deps);
    await upsertApp(h.deps, { ...before!, enrollPage: "//evil.example/enroll" });
    w.trusted.length = 0;
    h.opened.length = 0;
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    expect(h.opened).toEqual([`${w.server.url}/bridge/enroll#code=BCDFGHJK&runner=${before!.runnerId}`]);
    expect((await loadApps(h.deps))[0]!.enrollPage).toBe("//evil.example/enroll"); // left as stored
  });

  it("starts the installed service when the runner is not running, instead of asking again", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    // The runner has stopped (idle); the service file is still there.
    await writeRunnerStatus(h.deps, { version: 1, pid: 2 ** 22 + 12345, startedAt: "2026-10-21T00:00:00.000Z", apps: { demo: "online" }, browsers: 0 });
    w.trusted.length = 0;
    h.commands.length = 0;
    w.asked.length = 0;
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(0);
    expect(h.commands).toContainEqual(["systemctl", "--user", "start", runnerPathsOf(h.deps).serviceName]);
    expect(w.asked).toEqual([]);
  });
});

describe("bridge setup refuses what it cannot trust", () => {
  it("does nothing on Windows and points to WSL2", async () => {
    const w = await world({ platform: "win32" as never, fetch: (() => { throw new Error("no request expected"); }) as typeof fetch });
    expect(await runCli(["setup", w.server.url], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("WSL2");
    expect(h.commands).toEqual([]);
  });

  it("refuses a discovery enrollPage that leaves the app origin before writing or installing anything", async () => {
    const w = await world();
    const liar = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        app: { id: "x", name: "X" },
        origin: liarUrl,
        auth: { issuer: w.idp.url, clientId: "c", deviceAuthorizationEndpoint: `${w.idp.url}/d`, tokenEndpoint: `${w.idp.url}/t` },
        relayUrl: liarUrl.replace("http", "ws") + "/relay",
        protocol: { min: 1, max: 1 },
        enrollPage: "//evil.example/enroll",
      }));
    });
    let liarUrl = "";
    await new Promise<void>((resolve) => liar.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => void liar.close(() => resolve())));
    liarUrl = `http://127.0.0.1:${(liar.address() as AddressInfo).port}`;
    const before = await tree(h.root);
    expect(await runCli(["setup", liarUrl, "--yes", "--json"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("enrollPage");
    expect(jsonLines().at(-1)).toMatchObject({ event: "error", code: "discovery_invalid" });
    expect(await tree(h.root)).toEqual(before);
    expect(h.commands).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  it("connects to the origin it printed: a discovery that names another origin is refused", async () => {
    const w = await world();
    const liar = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        app: { id: "x", name: "X" },
        origin: "https://elsewhere.example",
        auth: { issuer: w.idp.url, clientId: "c", deviceAuthorizationEndpoint: `${w.idp.url}/d`, tokenEndpoint: `${w.idp.url}/t` },
        relayUrl: "wss://elsewhere.example/relay",
        protocol: { min: 1, max: 1 },
      }));
    });
    await new Promise<void>((resolve) => liar.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => void liar.close(() => resolve())));
    const url = `http://127.0.0.1:${(liar.address() as AddressInfo).port}`;
    expect(await runCli(["setup", url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("does not match the app URL");
    expect(await loadApps(h.deps)).toEqual([]);
    expect(h.commands).toEqual([]);
  });

  it("an app URL that is not https (or localhost) is a usage error before any request", async () => {
    await world({ fetch: (() => { throw new Error("no request expected"); }) as typeof fetch });
    expect(await runCli(["setup", "http://app.example"], h.deps)).toBe(2);
    expect(await runCli(["setup"], h.deps)).toBe(2);
  });

  it("without a launcher (--no-install) the service and the handler are not offered: the runner would have nothing to run", async () => {
    const w = await world({ signal: AbortSignal.abort() });
    expect(await runCli(["setup", w.server.url, "--no-install", "--yes", "--no-open"], h.deps)).toBe(1);
    expect(h.commands.filter((c) => c[0] === "npm" || c[0] === "systemctl")).toEqual([]);
    expect(printed()).toContain("No installed launcher");
    await expect(lstat(runnerPathsOf(h.deps).serviceFile)).rejects.toThrow();
  });

  it("--service without an installed launcher is an error, not a quiet foreground run", async () => {
    const w = await world();
    expect(await runCli(["setup", w.server.url, "--no-install", "--service", "--yes", "--json"], h.deps)).toBe(1);
    expect(jsonLines().at(-1)).toMatchObject({ event: "error", code: "no_launcher" });
    await expect(lstat(runnerPathsOf(h.deps).serviceFile)).rejects.toThrow();
  });

  it("refuses a foreign file at the launcher path before connecting", async () => {
    const w = await world();
    const launcher = launcherPathOf(h.deps);
    await mkdir(path.dirname(launcher), { recursive: true });
    await symlink("/usr/bin/true", launcher);
    expect(await runCli(["setup", w.server.url, "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("not a bridge launcher");
    expect(w.idp.requests).toEqual([]);
  });

  it("stops with a clear error when the service cannot be installed", async () => {
    const w = await world();
    const run = h.deps.run!;
    h.deps.run = async (command, args) => (command === "systemctl" && args.includes("enable") ? { exitCode: 1, stdout: "", stderr: "Failed to connect to bus" } : run(command, args));
    expect(await runCli(["setup", w.server.url, "--yes", "--json"], h.deps)).toBe(1);
    expect(jsonLines().at(-1)).toMatchObject({ event: "error", code: "service_failed" });
  });
});

describe("bridge setup interrupted while waiting for the browser", () => {
  async function interruptible(json: boolean): Promise<{ w: World; passed: { signal?: AbortSignal; confirms: number }; done: Promise<number>; stop: AbortController }> {
    const stop = new AbortController();
    const w = await world({ signal: stop.signal });
    const passed: { signal?: AbortSignal; confirms: number } = { confirms: 0 };
    const real = h.deps.e2ee!;
    h.deps.e2ee = {
      ...real,
      // Like the runner's enroll: ends the wait, closes the window and rejects with `aborted` when the signal fires.
      enroll: async (_app, prompt, options) => {
        passed.signal = options?.signal;
        prompt.showCode("BCDFGHJK", FAR);
        return new Promise<never>((_resolve, reject) => {
          // Without a signal this would hang: the test then fails on its timeout.
          options?.signal?.addEventListener("abort", () => reject(new EnrollError("aborted", "enrollment cancelled")), { once: true });
        });
      },
    };
    h.deps.confirm = async (question) => {
      if (question === "Same words?") passed.confirms += 1;
      return true;
    };
    const done = runCli(["setup", w.server.url, "--yes", "--no-open", ...(json ? ["--json"] : [])], h.deps);
    await until(() => printed().includes("BCDFGHJK"));
    return { w, passed, done, stop };
  }

  it("binds the enroll wait to setup's abort and ends it there instead of orphaning it", async () => {
    const { passed, done, stop } = await interruptible(false);
    expect(passed.signal).toBeDefined();
    expect(passed.signal!.aborted).toBe(false);
    stop.abort();
    expect(await done).toBe(1);
    expect(passed.signal!.aborted).toBe(true);
    expect(printed()).toContain("stopped before the browser was trusted");
    expect(printed()).not.toContain("Ready:");
    expect(passed.confirms).toBe(0);
  });

  it("--json reports the interruption as an error event with the code interrupted", async () => {
    const { done, stop } = await interruptible(true);
    stop.abort();
    expect(await done).toBe(1);
    expect(jsonLines().at(-1)).toMatchObject({ event: "error", code: "interrupted" });
    expect(jsonLines().some((e) => e.event === "ready")).toBe(false);
  });
});

describe("bridge setup with the runner in this terminal", () => {
  /** A real in-process runner against a server that accepts the stub token; the fake browser trusts at once. */
  async function foreground(isTTY: boolean): Promise<{ url: string; stop: AbortController; trusted: unknown[] }> {
    const idp = await oauth();
    const stop = new AbortController();
    const trusted: unknown[] = [];
    h = await harness({
      isTTY,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
      signal: stop.signal,
      e2ee: {
        enroll: async (_app, prompt) => {
          prompt.showCode("BCDFGHJK", FAR);
          expect(await prompt.confirm({ label: "Firefox", keyId: "kid-1" })).toBe(true);
          trusted.push({});
          return { browserKeyId: "kid-1", label: "Firefox", enrolledAt: "2026-10-21T00:01:00.000Z" };
        },
        listBrowsers: async () => trusted as never,
        revokeBrowser: async () => false,
      },
      adapters: [],
    });
    const verified = await createNodeBridgeServer({
      enrollPage: "/bridge/enroll",
      adapters: { verifier: createStubAuthVerifier({ browser: {}, runner: { "access-1": "alice" } }) },
      app: { id: "demo", name: "Demo App" },
      auth: { issuer: idp.url, clientId: "runner-client", deviceAuthorizationEndpoint: `${idp.url}/d`, tokenEndpoint: `${idp.url}/t` },
    });
    closers.push(() => verified.close());
    return { url: verified.url, stop, trusted };
  }

  it("serves the app from this process, enrolls, and stays until it is stopped", async () => {
    const f = await foreground(true);
    const done = runCli(["setup", f.url, "--foreground", "--no-install", "--yes", "--no-open"], h.deps);
    await until(() => printed().includes("The runner stays in this terminal") || printed().includes("bridge setup:"), 15_000).catch(() => undefined);
    expect(printed()).toContain("Paired: Demo App");
    f.stop.abort();
    expect(await done).toBe(0);
    expect(f.trusted).toHaveLength(1);
  }, 30_000);

  it("--json keeps stdout pure JSON lines while the runner runs in this process: its status lines go to stderr", async () => {
    const f = await foreground(false);
    // No terminal and no decision on the words: the run ends in an enroll error, which is fine; only stdout purity is under test.
    const done = runCli(["setup", f.url, "--foreground", "--no-install", "--yes", "--json", "--no-open"], h.deps);
    await until(() => h.err.join("").includes("The runner stays in this terminal") || h.err.join("").includes("bridge setup:"), 15_000).catch(() => undefined);
    f.stop.abort();
    await done;
    const lines = h.out.join("").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(h.err.join("")).toContain("[demo] online");
    expect(h.out.join("")).not.toContain("[demo]");
  }, 30_000);
});

describe("bridge://run starts the service, not a second runner", () => {
  it("starts the installed service through systemctl and opens no terminal", async () => {
    h = await harness();
    await mkdir(path.dirname(runnerPathsOf(h.deps).serviceFile), { recursive: true });
    await writeFile(runnerPathsOf(h.deps).serviceFile, "[Unit]\n");
    expect(await runCli(["handle-url", "bridge://run"], h.deps)).toBe(0);
    expect(h.commands).toEqual([["systemctl", "--user", "start", runnerPathsOf(h.deps).serviceName]]);
    expect(h.terminals).toEqual([]);
  });

  it("opens a terminal running `bridge run` only when no service exists", async () => {
    h = await harness();
    expect(await runCli(["handle-url", "bridge://run"], h.deps)).toBe(0);
    expect(h.terminals).toEqual([[launcherPathOf(h.deps), "run"]]);
    expect(h.commands).toEqual([]);
  });

  it("an installed service that fails to start is an error, not a reason to open a terminal", async () => {
    h = await harness();
    await mkdir(path.dirname(runnerPathsOf(h.deps).serviceFile), { recursive: true });
    await writeFile(runnerPathsOf(h.deps).serviceFile, "[Unit]\n");
    h.deps.run = async () => ({ exitCode: 5, stdout: "", stderr: "Unit bridge-runner.service not found." });
    expect(await runCli(["handle-url", "bridge://run"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("systemctl --user start");
    expect(h.terminals).toEqual([]);
  });

  it("uses launchctl kickstart on macOS, with fixed arguments", async () => {
    h = await harness({ platform: "darwin" });
    await mkdir(path.dirname(runnerPathsOf(h.deps).serviceFile), { recursive: true });
    await writeFile(runnerPathsOf(h.deps).serviceFile, "<plist/>\n");
    await startRunnerOf(h.deps)();
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]!.slice(0, 2)).toEqual(["launchctl", "kickstart"]);
    expect(h.commands[0]!.at(-1)).toMatch(/^gui\/\d+\/.*bridge/);
  });

  it("falls back to launchctl bootstrap when kickstart fails, and reports the failure when both do", async () => {
    h = await harness({ platform: "darwin" });
    await mkdir(path.dirname(runnerPathsOf(h.deps).serviceFile), { recursive: true });
    await writeFile(runnerPathsOf(h.deps).serviceFile, "<plist/>\n");
    h.deps.run = async (command, args) => {
      h.commands.push([command, ...args]);
      return args[0] === "kickstart" ? { exitCode: 113, stdout: "", stderr: "Could not find service" } : OK;
    };
    expect(await startService(h.deps)).toEqual({ ok: true });
    expect(h.commands).toHaveLength(2);
    expect(h.commands[0]!.slice(0, 2)).toEqual(["launchctl", "kickstart"]);
    expect(h.commands[1]!.slice(0, 2)).toEqual(["launchctl", "bootstrap"]);
    expect(h.commands[1]![2]).toMatch(/^gui\/\d+$/);
    expect(h.commands[1]!.at(-1)).toBe(runnerPathsOf(h.deps).serviceFile);

    h.deps.run = async (_command, args) => ({ exitCode: 5, stdout: "", stderr: args[0] === "kickstart" ? "Could not find service" : "Bootstrap failed" });
    const failed = await startService(h.deps);
    expect(failed.ok).toBe(false);
    // Both failures are named: the kickstart one is often the real cause.
    expect(!failed.ok && failed.error).toMatch(/^kickstart: `launchctl kickstart .*` failed: Could not find service; bootstrap: `launchctl bootstrap .*` failed: Bootstrap failed$/);
  });

  it("nothing from the URL reaches the service-start arguments", async () => {
    h = await harness();
    await mkdir(path.dirname(runnerPathsOf(h.deps).serviceFile), { recursive: true });
    await writeFile(runnerPathsOf(h.deps).serviceFile, "[Unit]\n");
    for (const url of ["bridge://run?x=--now", "bridge://run/../x", "bridge://run#frag", "bridge://runx"]) {
      expect(await runCli(["handle-url", url], h.deps)).toBe(2);
    }
    expect(h.commands).toEqual([]);
  });
});
