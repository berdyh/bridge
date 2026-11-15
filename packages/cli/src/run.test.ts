import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { saveTokens } from "@berdyh/bridge-pairing";
import { RELAY_SUBPROTOCOL, bearerSubprotocol, createPlainLayer, isPlainFrame, type ChannelLayer, type JsonRpcMessage } from "@berdyh/bridge-protocol";
import { PROXY_ERROR, type AgentAdapter, type AgentProcess, type ExtensionRouter } from "@berdyh/bridge-runner";
import { createMemoryDeviceStore, createNodeBridgeServer, createStubAuthVerifier, type NodeBridgeServer } from "@berdyh/bridge-server-node";
import * as runner from "@berdyh/bridge-runner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.js";
import { type HostedAppRecord, type LocalAppRecord, loadApps as loadAllApps, tokenKey, upsertApp } from "./config.js";
import type { CliDeps } from "./deps.js";
import { assertLayout, layoutOf, relation } from "./layout-rule.js";
import { appPathsOf, runnerLockPath, workerLockPath } from "./paths.js";
import { LockRefused } from "./runner-lock.js";
import { type Harness, exists, harness } from "./testkit.js";
import { IDLE_STOP_MS, type RunnerHandle, countSessions, protectedPathsOf, runRun, scopeExtensions, startRunner, sweepApp, validateMachinePolicy } from "./run.js";
import { readRunnerStatus, statusFilePath, workDirOf } from "./status.js";
import { wordsOf } from "@berdyh/bridge-protocol";
import { CLI_VERSION } from "./version.js";

/** These tests connect hosted apps only: the records read back are hosted ones. */
const loadApps = async (deps: Parameters<typeof loadAllApps>[0]): Promise<HostedAppRecord[]> => (await loadAllApps(deps)) as HostedAppRecord[];

// Spies that pass through: they let a test see the E2eeApp the runner hands to the e2ee layer.
vi.mock("@berdyh/bridge-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@berdyh/bridge-runner")>();
  return { ...actual, wrapRunnerChannel: vi.fn(actual.wrapRunnerChannel), acceptEnrollment: vi.fn(actual.acceptEnrollment), readEnrollWindow: vi.fn(actual.readEnrollWindow), createLocalPolicy: vi.fn(actual.createLocalPolicy), createAuditLog: vi.fn(actual.createAuditLog) };
});

const cleanups: (() => Promise<void> | void)[] = [];
let h: Harness | undefined;
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.cleanup();
  h = undefined;
});

const home = () => `${h!.root}/home`;
const until = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

/** An agent that lives in memory: answers initialize, session/new and session/prompt. */
function fakeAdapter(id = "fake") {
  const live = new Set<number>();
  let spawned = 0;
  const adapter: AgentAdapter = {
    id,
    availability: async () => ({ id, available: true }),
    async spawn() {
      const n = ++spawned;
      live.add(n);
      const handlers = new Set<(m: JsonRpcMessage) => void>();
      const closers = new Set<(r?: string) => void>();
      let closed = false;
      let exit!: (v: { code: number | null; signal: string | null }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>((r) => (exit = r));
      const shut = () => {
        if (closed) return;
        closed = true;
        live.delete(n);
        exit({ code: 0, signal: null });
        for (const c of closers) c();
      };
      const reply = (id: unknown, result: unknown) => queueMicrotask(() => handlers.forEach((h) => h({ jsonrpc: "2.0", id, result } as JsonRpcMessage)));
      const proc: AgentProcess = {
        stream: {
          get closed() { return closed; },
          send(m) {
            if (typeof m.method !== "string" || m.id === undefined) return;
            if (m.method === "initialize") reply(m.id, { protocolVersion: 1, agentCapabilities: {} });
            else if (m.method === "session/new") reply(m.id, { sessionId: `agent-${n}` });
            else if (m.method === "session/prompt") reply(m.id, { stopReason: "end_turn" });
            else reply(m.id, {});
          },
          onMessage: (h) => (handlers.add(h), () => void handlers.delete(h)),
          onClose: (h) => (closers.add(h), () => void closers.delete(h)),
          close: shut,
        },
        exited,
        kill: async () => shut(),
      };
      return proc;
    },
  };
  return { adapter, live: () => live.size, spawned: () => spawned };
}

interface AppFixture {
  record: HostedAppRecord;
  server: NodeBridgeServer;
  store: ReturnType<typeof createMemoryDeviceStore>;
  runnerToken: string;
  browserToken: string;
}

async function appFixture(h: Harness, appId: string, runnerId: string): Promise<AppFixture> {
  const runnerToken = `rt-${appId}`;
  const browserToken = `bt-${appId}`;
  const store = createMemoryDeviceStore();
  const server = await createNodeBridgeServer({
    app: { id: appId, name: `App ${appId}` },
    auth: { issuer: "https://idp.example", clientId: "c", deviceAuthorizationEndpoint: "https://idp.example/d", tokenEndpoint: "https://idp.example/t" },
    adapters: {
      store,
      verifier: createStubAuthVerifier({ browser: { [browserToken]: "alice" }, runner: { [runnerToken]: "alice" } }),
    },
  });
  cleanups.push(() => server.close());
  const record: HostedAppRecord = {
    appId,
    name: `App ${appId}`,
    url: server.url,
    origin: server.url,
    relayUrl: `${server.url.replace("http", "ws")}/relay`,
    auth: { issuer: "https://idp.example", clientId: "c", deviceAuthorizationEndpoint: "https://idp.example/d", tokenEndpoint: "https://idp.example/t" },
    protocol: { min: 1, max: 1 },
    runnerId,
    connectedAt: "2026-10-14T00:00:00.000Z",
  };
  await saveTokens(h.deps.credentials!, { accessToken: runnerToken, tokenType: "Bearer" }, tokenKey(appId));
  return { record, server, store, runnerToken, browserToken };
}

/** A plaintext browser: a real socket to the app's relay, the plain layer, JSON-RPC requests. */
class TestBrowser {
  private ws!: WebSocket;
  private layer: ChannelLayer = createPlainLayer();
  private nextId = 1;
  private pending = new Map<unknown, (m: JsonRpcMessage) => void>();
  readonly inbox: JsonRpcMessage[] = [];
  readonly raw: Record<string, unknown>[] = [];
  private opens: Promise<void> = Promise.resolve();
  /** The frame most recently sent, so a test can replay its session id with a bad sequence. */
  lastFrame: { kid?: string } | undefined;

  constructor(private app: AppFixture, readonly browserKeyId: string) {}

  async open(): Promise<this> {
    const { server, browserToken, record } = this.app;
    this.ws = new (WebSocket as unknown as new (u: string, o: object) => WebSocket)(
      `${server.url.replace("http", "ws")}/relay/browser?browserKeyId=${this.browserKeyId}`,
      { protocols: [RELAY_SUBPROTOCOL, bearerSubprotocol(browserToken)], headers: { origin: server.url } },
    );
    cleanups.push(() => this.ws.close());
    this.ws.addEventListener("message", (e) => {
      const env = JSON.parse(String(e.data)) as { kind: string; body: unknown };
      this.raw.push(env as never);
      if (env.kind !== "frame" || !isPlainFrame(env.body)) return;
      const frame = env.body;
      this.opens = this.opens.then(async () => {
        const m = await this.layer.open(frame);
        this.inbox.push(m);
        const waiter = this.pending.get(m.id);
        if (waiter && ("result" in m || "error" in m)) waiter(m);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error("browser socket failed")));
    });
    void record;
    return this;
  }

  close(): void {
    this.ws.close();
  }

  async request(method: string, params: unknown = {}): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const answer = new Promise<JsonRpcMessage>((resolve) => this.pending.set(id, resolve));
    const frame = await this.layer.seal({ jsonrpc: "2.0", id, method, params });
    this.lastFrame = frame as { kid?: string };
    this.ws.send(JSON.stringify({ to: "runner", runnerId: this.app.record.runnerId, browserKeyId: this.browserKeyId, kind: "frame", body: frame }));
    return Promise.race([answer, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no answer to ${method}`)), 3000))]);
  }
}

function runnerDeps(h: Harness, over: Partial<CliDeps> = {}): CliDeps {
  return {
    ...h.deps,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    backoff: { baseMs: 10, maxMs: 40 },
    ...over,
  };
}

/** What `e2e/src/machine.ts` writes: sessions may start in the test's home dir (without it, only in the app's work folder). */
async function allowHomeCwd(h: Harness): Promise<void> {
  await mkdir(home(), { recursive: true });
  await mkdir(path.join(h.deps.configDir, "bridge"), { recursive: true });
  await writeFile(path.join(h.deps.configDir, "bridge", "policy.json"), JSON.stringify({ allowedCwds: [home()] }));
}

async function start(h: Harness, apps: AppFixture[], over: Partial<CliDeps> = {}): Promise<RunnerHandle> {
  await allowHomeCwd(h);
  const handle = await startRunner(runnerDeps(h, over), apps.map((a) => a.record), { e2ee: false });
  cleanups.push(() => handle.stop());
  await until(() => apps.every((a) => handle.statuses()[a.record.appId] === "online"));
  return handle;
}

describe("bridge run against two apps", () => {
  it("serves a browser end to end: initialize, session/new, session/prompt", async () => {
    h = await harness();
    const agent = fakeAdapter();
    const a = await appFixture(h, "app-a", "runner-a");
    await start(h, [a], { adapters: [agent.adapter] });
    const browser = await new TestBrowser(a, "browser-1").open();

    expect(await browser.request("initialize", { protocolVersion: 1 })).toHaveProperty("result");
    const created = await browser.request("session/new", { cwd: home() });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    expect(sessionId).toBeTruthy();
    const prompted = await browser.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    expect(prompted.result).toMatchObject({ stopReason: "end_turn" });
    expect(agent.live()).toBe(1);
  });

  it("keeps two apps apart: a browser of app A cannot reach app B's sessions, even under the same browser key", async () => {
    h = await harness();
    const agent = fakeAdapter();
    const a = await appFixture(h, "app-a", "runner-a");
    const b = await appFixture(h, "app-b", "runner-b");
    const handle = await start(h, [a, b], { adapters: [agent.adapter] });

    const browserA = await new TestBrowser(a, "same-key").open();
    const browserB = await new TestBrowser(b, "same-key").open();
    await browserA.request("initialize");
    await browserB.request("initialize");
    const sessionA = ((await browserA.request("session/new", { cwd: home() })).result as { sessionId: string }).sessionId;
    const sessionB = ((await browserB.request("session/new", { cwd: home() })).result as { sessionId: string }).sessionId;
    expect(sessionA).not.toBe(sessionB);
    expect(handle.proxy("app-a")!.sessionCount()).toBe(1);
    expect(handle.proxy("app-b")!.sessionCount()).toBe(1);

    const cross = await browserB.request("session/prompt", { sessionId: sessionA, prompt: [{ type: "text", text: "x" }] });
    expect(cross.error).toMatchObject({ code: PROXY_ERROR.unknownSession });
    const crossBack = await browserA.request("session/prompt", { sessionId: sessionB, prompt: [{ type: "text", text: "x" }] });
    expect(crossBack.error).toMatchObject({ code: PROXY_ERROR.unknownSession });
    // Each still reaches its own.
    expect((await browserB.request("session/prompt", { sessionId: sessionB, prompt: [{ type: "text", text: "x" }] })).result).toBeTruthy();

    // Ending A's channel ends A's agent only.
    await browserA.request("session/close", { sessionId: sessionA });
    await until(() => handle.proxy("app-a")!.sessionCount() === 0);
    expect(handle.proxy("app-b")!.sessionCount()).toBe(1);
    expect(agent.live()).toBe(1);
  });

  it("closing a browser's channel ends its agent and leaves another app's agent alone", async () => {
    h = await harness();
    const agent = fakeAdapter();
    const a = await appFixture(h, "app-a", "runner-a");
    const b = await appFixture(h, "app-b", "runner-b");
    const handle = await start(h, [a, b], { adapters: [agent.adapter], peerGoneGraceMs: 30 });
    const browserA = await new TestBrowser(a, "key-a").open();
    const browserB = await new TestBrowser(b, "key-b").open();
    await browserA.request("session/new", { cwd: home() });
    await browserB.request("session/new", { cwd: home() });
    expect(agent.live()).toBe(2);

    browserA.close();
    await until(() => handle.proxy("app-a")!.sessionCount() === 0);
    await until(() => agent.live() === 1);
    expect(handle.proxy("app-b")!.sessionCount()).toBe(1);
    expect((await browserB.request("initialize")).result).toBeTruthy();
  });

  it("caps sessions per browser channel and per app", async () => {
    h = await harness();
    const agent = fakeAdapter();
    const a = await appFixture(h, "app-a", "runner-a");
    await start(h, [a], { adapters: [agent.adapter], sessionCaps: { perChannel: 2, perApp: 3 } });
    const first = await new TestBrowser(a, "browser-1").open();
    const second = await new TestBrowser(a, "browser-2").open();

    expect(await first.request("session/new", { cwd: home() })).toHaveProperty("result");
    expect(await first.request("session/new", { cwd: home() })).toHaveProperty("result");
    expect((await first.request("session/new", { cwd: home() })).error).toMatchObject({ code: PROXY_ERROR.sessionNotAllowed });
    expect(await second.request("session/new", { cwd: home() })).toHaveProperty("result");
    expect((await second.request("session/new", { cwd: home() })).error).toMatchObject({ code: PROXY_ERROR.sessionNotAllowed });
    expect(agent.spawned()).toBe(3);
  });

  it("a malformed sequence from one browser fails its session only", async () => {
    h = await harness();
    const agent = fakeAdapter();
    const a = await appFixture(h, "app-a", "runner-a");
    const handle = await start(h, [a], { adapters: [agent.adapter] });
    const good = await new TestBrowser(a, "good").open();
    const bad = await new TestBrowser(a, "bad").open();
    await good.request("initialize");
    await bad.request("initialize");
    expect(await bad.request("session/new", { cwd: home() })).toHaveProperty("result");
    const kid = bad.lastFrame!.kid ?? "AAAA";
    const frame = { v: 1, kid, seq: 1e300, msg: { jsonrpc: "2.0", id: 1, method: "initialize" } };
    (bad as unknown as { ws: WebSocket }).ws.send(JSON.stringify({ to: "runner", runnerId: "runner-a", browserKeyId: "bad", kind: "frame", body: frame }));
    await until(() => bad.raw.some((e) => e.kind === "pake" && (e.body as { t?: string }).t === "session/close"));
    expect(handle.statuses()["app-a"]).toBe("online");
    expect(await good.request("session/new", { cwd: home() })).toHaveProperty("result");
  });

  it("stops an app, not the runner, when another process takes over its credential (4409)", async () => {
    h = await harness();
    const agent = fakeAdapter();
    const a = await appFixture(h, "app-a", "runner-a");
    const b = await appFixture(h, "app-b", "runner-b");
    const handle = await start(h, [a, b], { adapters: [agent.adapter] });

    const thief = new (WebSocket as unknown as new (u: string, o: object) => WebSocket)(
      `${a.server.url.replace("http", "ws")}/relay/runner?runnerId=runner-a`,
      { headers: { authorization: `Bearer ${a.runnerToken}` } },
    );
    cleanups.push(() => thief.close());
    thief.addEventListener("open", () => thief.send(JSON.stringify({ type: "hello", runnerId: "runner-a", runnerVersion: "1.0.0", protocol: { min: 1, max: 1 } })));
    await until(() => handle.statuses()["app-a"] === "replaced");
    expect(handle.statuses()["app-b"]).toBe("online");
    // Not retried: the thief keeps the connection.
    await new Promise((r) => setTimeout(r, 150));
    expect(handle.statuses()["app-a"]).toBe("replaced");
    expect(thief.readyState).toBe(1);
  });

  it("marks an app update_required and keeps the others running", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    const b = await appFixture(h, "app-b", "runner-b");
    // App A's server only speaks protocol 5+.
    await a.server.close();
    const old = await createNodeBridgeServer({
      app: { id: "app-a", name: "App app-a" },
      auth: a.record.auth,
      protocol: { min: 5, max: 6 },
      adapters: { store: createMemoryDeviceStore(), verifier: createStubAuthVerifier({ browser: {}, runner: { [a.runnerToken]: "alice" } }) },
    });
    cleanups.push(() => old.close());
    a.record.relayUrl = `${old.url.replace("http", "ws")}/relay`;
    const handle = await startRunner(runnerDeps(h), [a.record, b.record], { e2ee: false });
    cleanups.push(() => handle.stop());
    await until(() => handle.statuses()["app-a"] === "update_required" && handle.statuses()["app-b"] === "online");
    await new Promise((r) => setTimeout(r, 100));
    expect(handle.statuses()).toEqual({ "app-a": "update_required", "app-b": "online" });
  });
});

describe("the e2ee identity of an app", () => {
  it("is the device id the relay knows: per app server, and the same after a restart", async () => {
    h = await harness();
    const agent = fakeAdapter();
    const a = await appFixture(h, "app-a", "device-a");
    const b = await appFixture(h, "app-b", "device-b");
    await upsertApp(h.deps, a.record);
    await upsertApp(h.deps, b.record);
    const wrap = vi.mocked(runner.wrapRunnerChannel);
    const accept = vi.mocked(runner.acceptEnrollment);
    wrap.mockClear();
    accept.mockClear();

    for (let round = 0; round < 2; round++) {
      const apps = await loadApps(h.deps);
      const handle = await startRunner(runnerDeps(h, { adapters: [agent.adapter] }), apps, { e2ee: false });
      await until(() => apps.every((x: HostedAppRecord) => handle.statuses()[x.appId] === "online"));
      for (const fixture of [a, b]) {
        // The relay registered this id as the device of that app server, and no other server saw it.
        expect((await fixture.store.listDevices("alice")).map((d: { deviceId: string }) => d.deviceId)).toEqual([fixture.record.runnerId]);
        const browser = await new TestBrowser(fixture, "browser-1").open();
        await browser.request("initialize", { protocolVersion: 1 });
        browser.close();
        await until(() => wrap.mock.calls.some(([, ctx]) => ctx.app.appId === fixture.record.appId));
      }
      await handle.stop();
      const seen = new Map(wrap.mock.calls.map(([, ctx]) => [ctx.app.appId, ctx.app.runnerId]));
      expect(Object.fromEntries(seen)).toEqual({ "app-a": "device-a", "app-b": "device-b" });
      // Each app's identity lives in its own bridge/ folder, derived from its own id.
      expect(wrap.mock.calls.every(([, ctx]) => ctx.app.paths?.configDir === appPathsOf(h!.deps, ctx.app.appId).configDir)).toBe(true);
    }
    expect(accept).not.toHaveBeenCalled();
  });
});

describe("bridge run (command)", () => {
  it("refuses to start with no app connected", async () => {
    h = await harness();
    expect(await runCli(["run"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("no app is connected");
  });

  it("stays up when every app is parked, so a service manager does not restart it; exits 1 on the signal", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    await upsertApp(h.deps, a.record);
    const abort = new AbortController();
    let result: number | undefined;
    const intervals = vi.spyOn(globalThis, "setInterval");
    cleanups.push(() => intervals.mockRestore());
    const done = runCli(["run", "--no-e2ee"], runnerDeps(h, { signal: abort.signal, adapters: [fakeAdapter().adapter] })).then((c) => (result = c));
    await until(() => h!.out.join("").includes("[app-a] online"));
    const thief = new (WebSocket as unknown as new (u: string, o: object) => WebSocket)(
      `${a.server.url.replace("http", "ws")}/relay/runner?runnerId=runner-a`,
      { headers: { authorization: `Bearer ${a.runnerToken}` } },
    );
    cleanups.push(() => thief.close());
    thief.addEventListener("open", () => thief.send(JSON.stringify({ type: "hello", runnerId: "runner-a", runnerVersion: "1.0.0", protocol: { min: 1, max: 1 } })));
    await until(() => h!.out.join("").includes("[app-a] replaced"));
    await new Promise((r) => setTimeout(r, 250));
    expect(result).toBeUndefined();
    expect(h.err.join("")).toContain("app-a is replaced");
    // A pending promise alone lets Node exit (code 13): a ref'd handle must hold the loop open.
    const held = intervals.mock.results.map((r) => r.value as NodeJS.Timeout).filter((t) => t.hasRef());
    expect(held.length).toBeGreaterThan(0);
    abort.abort();
    await done;
    expect(result).toBe(1);
  });

  it("runs until its signal aborts, then stops cleanly", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    await upsertApp(h.deps, a.record);
    const abort = new AbortController();
    const done = runCli(["run", "--no-e2ee"], runnerDeps(h, { signal: abort.signal, adapters: [fakeAdapter().adapter] }));
    await until(() => h!.out.join("").includes("[app-a] online"));
    abort.abort();
    expect(await done).toBe(0);
    expect(h.err.join("")).toContain("encryption is OFF");
  });
});

describe("plugin startup", () => {
  it("logs a plugin that fails to start, still serves the links, starts only connected apps' plugins and stops the host", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    const started: (string | undefined)[] = [];
    let stopped = 0;
    const pluginHost: runner.PluginHost = {
      install: async () => { throw new Error("unused"); },
      list: async () => [],
      remove: async () => {},
      revoke: async () => {},
      start: async (appId) => {
        started.push(appId);
        throw new AggregateError([new Error("plugin one broke\u001b[2K")], "plugin one broke");
      },
      stopAll: async () => void stopped++,
      router: { handles: () => false, request: async () => null, notify: () => {}, subscribe: () => () => {} },
      setBroker: () => {},
    };
    const handle = await start(h, [a], { pluginHost, adapters: [fakeAdapter().adapter] });
    expect(started).toEqual(["app-a"]);
    expect(handle.statuses()["app-a"]).toBe("online");
    expect(h.err.join("")).toContain("[app-a] error: plugin failed to start: plugin one broke[2K");
    expect(h.err.join("")).not.toContain("\u001b");
    await handle.stop();
    expect(stopped).toBe(1);
  });

  it("gives the real plugin host a log sink: a host warning reaches the runner log (an invalid installed plugin is no longer silent)", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    // No `pluginHost` override: the host `bridge run` builds. An installed folder with no package in it is invalid.
    await mkdir(path.join(appPathsOf(h.deps, "app-a").pluginsDir, "demo.bad", "1.0.0"), { recursive: true });
    const handle = await start(h, [a], { adapters: [fakeAdapter().adapter] });
    expect(handle.statuses()["app-a"]).toBe("online");
    expect(h.err.join("")).toMatch(/\[plugin demo\.bad\] warn: Skipping invalid installed plugin \{"version":"1\.0\.0","error":/);
    await handle.stop();
  });
});

describe("extension scoping", () => {
  it("routes only the plugin ids installed for this app to the host; everything else is refused by the proxy", () => {
    const calls: string[] = [];
    const router: ExtensionRouter = {
      handles: () => true,
      request: async (_c, method) => (calls.push(method), null),
      notify: () => {},
      subscribe: () => () => {},
    };
    const scoped = scopeExtensions(router, new Set(["mine.plugin"]));
    expect(scoped.handles("_mine.plugin/ping")).toBe(true);
    expect(scoped.handles("_theirs.plugin/ping")).toBe(false);
    expect(scoped.handles("_vendor/agent-native")).toBe(false);
    expect(scoped.handles("session/new")).toBe(false);
    expect(scoped.handles("_bridge/localUi")).toBe(false);
  });
});

/** A manual clock: `deps.now` and the idle timers move together; `advance` fires what is due. */
function manualClock() {
  let time = Date.now();
  const timers = new Map<number, { fn: () => void; at: number }>();
  let next = 1;
  return {
    now: () => time,
    timers: {
      set(fn: () => void, ms: number) {
        const id = next++;
        timers.set(id, { fn, at: time + ms });
        return id;
      },
      clear(handle: unknown) {
        timers.delete(handle as number);
      },
    },
    pending: () => timers.size,
    /** Moves the clock by `ms`, firing due timers in order, letting async checks settle after each. */
    async advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = Math.max(time, due[1].at);
        due[1].fn();
        await new Promise((r) => setTimeout(r, 15));
      }
      time = end;
    },
  };
}

describe("the status file", () => {
  it("is written before the links come up, follows link status and browsers, and is gone after a clean stop", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    const handle = await start(h, [a], { adapters: [fakeAdapter().adapter], peerGoneGraceMs: 40 });
    const file = statusFilePath(h.deps);
    await until(async () => (await readRunnerStatus(h!.deps))?.apps["app-a"] === "online");
    let status = (await readRunnerStatus(h.deps))!;
    expect(status).toMatchObject({ version: 1, pid: process.pid, browsers: 0, apps: { "app-a": "online" } });
    expect(status.idleSince).toBeDefined();
    expect(Date.parse(status.startedAt)).not.toBeNaN();
    expect(((await (await import("node:fs/promises")).stat(file)).mode & 0o777)).toBe(0o600);

    const browser = await new TestBrowser(a, "browser-1").open();
    await browser.request("initialize", { protocolVersion: 1 });
    await until(async () => (await readRunnerStatus(h!.deps))?.browsers === 1);
    status = (await readRunnerStatus(h.deps))!;
    expect(status.idleSince).toBeUndefined();
    expect(handle.browsers()).toBe(1);

    browser.close();
    await until(async () => (await readRunnerStatus(h!.deps))?.browsers === 0, 6000);
    expect((await readRunnerStatus(h.deps))!.idleSince).toBeDefined();

    await handle.stop();
    expect(await readRunnerStatus(h.deps)).toBeUndefined();
    await expect(readFile(file, "utf8")).rejects.toThrow();
  }, 15000);

  it("sums browsers over apps", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    const b = await appFixture(h, "app-b", "runner-b");
    const handle = await start(h, [a, b], { adapters: [fakeAdapter().adapter] });
    await (await new TestBrowser(a, "same-key").open()).request("initialize");
    await (await new TestBrowser(b, "same-key").open()).request("initialize");
    await until(() => handle.browsers() === 2);
    await until(async () => (await readRunnerStatus(h!.deps))?.browsers === 2);
  });

  it("reads as 'not running' when the file names a dead pid, and a newer runner's file survives an older one's cleanup", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    const handle = await start(h, [a], { adapters: [fakeAdapter().adapter] });
    await until(async () => (await readRunnerStatus(h!.deps)) !== undefined);
    const file = statusFilePath(h.deps);
    const original = await readFile(file, "utf8");
    const dead = original.replace(`"pid":${process.pid}`, `"pid":${2 ** 22 + 4321}`);
    expect(dead).not.toBe(original);
    await handle.stop();
    await writeFile(file, dead);
    expect(await readRunnerStatus(h.deps)).toBeUndefined();
  });
});

describe("the per-app work folder", () => {
  it("is the default working folder of a session, and the only place one may start without allowedCwds", async () => {
    h = await harness();
    const agent = fakeAdapter();
    const a = await appFixture(h, "app-a", "runner-a");
    // No policy.json: the work folder is the default.
    const handle = await startRunner(runnerDeps(h, { adapters: [agent.adapter] }), [a.record], { e2ee: false });
    cleanups.push(() => handle.stop());
    await until(() => handle.statuses()["app-a"] === "online");
    const browser = await new TestBrowser(a, "browser-1").open();
    const work = workDirOf(h.deps, "app-a");
    expect(work).toBe(path.join(home(), ".local", "state", "app-a", "bridge", "work"));
    // No cwd given: the app's work folder.
    expect(await browser.request("session/new", { mcpServers: [] })).toHaveProperty("result");
    // Inside it is fine; the home dir is not.
    expect(await browser.request("session/new", { cwd: work })).toHaveProperty("result");
    expect((await browser.request("session/new", { cwd: home() })).error).toBeDefined();
  });
});

describe("per-app folders and per-app settings", () => {
  const writeJson = async (file: string, body: unknown): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(body));
  };

  it("a session of one app cannot start in, or reach, another app's folders, even with a broad allowedCwds", async () => {
    h = await harness();
    const agent = fakeAdapter();
    const a = await appFixture(h, "app-a", "runner-a");
    const b = await appFixture(h, "app-b", "runner-b");
    await mkdir(home(), { recursive: true });
    await writeJson(path.join(h.deps.configDir, "bridge", "policy.json"), { allowedCwds: [home()] });
    const pa = appPathsOf(h.deps, "app-a");
    const pb = appPathsOf(h.deps, "app-b");
    for (const d of [pa.workDir, pb.workDir, pb.configDir, pb.dataDir]) await mkdir(d, { recursive: true });
    const handle = await startRunner(runnerDeps(h, { adapters: [agent.adapter] }), [a.record, b.record], { e2ee: false });
    cleanups.push(() => handle.stop());
    await until(() => handle.statuses()["app-a"] === "online" && handle.statuses()["app-b"] === "online");
    const browserA = await new TestBrowser(a, "browser-1").open();
    const browserB = await new TestBrowser(b, "browser-1").open();
    // Its own work folder, and the home dir around the folders, are fine.
    expect(await browserA.request("session/new", { cwd: pa.workDir })).toHaveProperty("result");
    expect(await browserA.request("session/new", { cwd: home() })).toHaveProperty("result");
    // Another app's work folder, config, data and state are not, by any path.
    for (const cwd of [pb.workDir, pb.configDir, pb.dataDir, pb.stateDir, path.join(pb.workDir, "sub")]) {
      expect((await browserA.request("session/new", { cwd })).error, cwd).toBeDefined();
    }
    // The same folders are B's own: its work folder is fine, A's is not.
    expect(await browserB.request("session/new", { cwd: pb.workDir })).toHaveProperty("result");
    expect((await browserB.request("session/new", { cwd: pa.workDir })).error).toBeDefined();
    // Neither can start in the machine-wide dirs.
    expect((await browserA.request("session/new", { cwd: path.join(h.deps.configDir, "bridge") })).error).toBeDefined();
  });

  it("an app's config.json narrows its own policy only: agents, cwds, and a looser mode keeps the machine's with a warning", async () => {
    h = await harness();
    const agent = fakeAdapter();
    const a = await appFixture(h, "app-a", "runner-a");
    const b = await appFixture(h, "app-b", "runner-b");
    await mkdir(home(), { recursive: true });
    await mkdir(path.join(home(), "proj"), { recursive: true });
    await writeJson(path.join(h.deps.configDir, "bridge", "policy.json"), { allowedCwds: [home()], mode: "ask" });
    // A may only run another agent (so the fake is refused) and asks for a looser mode; B asks for a folder outside the machine's.
    await writeJson(appPathsOf(h.deps, "app-a").configFile, { policy: { agents: ["other"], mode: "bypass" } });
    await writeJson(appPathsOf(h.deps, "app-b").configFile, { policy: { allowedCwds: [path.join(home(), "proj"), "/etc"] } });
    const handle = await startRunner(runnerDeps(h, { adapters: [agent.adapter] }), [a.record, b.record], { e2ee: false });
    cleanups.push(() => handle.stop());
    await until(() => handle.statuses()["app-a"] === "online" && handle.statuses()["app-b"] === "online");
    const browserA = await new TestBrowser(a, "browser-1").open();
    const browserB = await new TestBrowser(b, "browser-1").open();
    expect((await browserA.request("session/new", { cwd: home() })).error).toBeDefined();
    expect(await browserB.request("session/new", { cwd: path.join(home(), "proj") })).toHaveProperty("result");
    // B's own list replaced the machine's wider one; the home dir is no longer a root for B.
    expect((await browserB.request("session/new", { cwd: home() })).error).toBeDefined();
    const err = h.err.join("");
    expect(err).toContain('[app-a] warn: policy.mode: "bypass" is looser than the machine\'s "ask"');
    expect(err).toContain('[app-b] warn: policy.allowedCwds: "/etc" is not a folder the machine policy admits');
  });

  it("an app's agent.default puts that agent first for its sessions only", async () => {
    h = await harness();
    const claude = fakeAdapter("claude");
    const codex = fakeAdapter("codex");
    const a = await appFixture(h, "app-a", "runner-a");
    const b = await appFixture(h, "app-b", "runner-b");
    await writeJson(appPathsOf(h.deps, "app-a").configFile, { agent: { default: "codex" } });
    const handle = await startRunner(runnerDeps(h, { adapters: [claude.adapter, codex.adapter] }), [a.record, b.record], { e2ee: false });
    cleanups.push(() => handle.stop());
    await until(() => handle.statuses()["app-a"] === "online" && handle.statuses()["app-b"] === "online");
    const browserA = await new TestBrowser(a, "browser-1").open();
    const browserB = await new TestBrowser(b, "browser-1").open();
    expect(await browserA.request("session/new", { mcpServers: [] })).toHaveProperty("result");
    expect([claude.spawned(), codex.spawned()]).toEqual([0, 1]);
    expect(await browserB.request("session/new", { mcpServers: [] })).toHaveProperty("result");
    expect([claude.spawned(), codex.spawned()]).toEqual([1, 1]);
  });

  it("the protected paths are the machine-wide dirs and every connected app's three bridge/ dirs", async () => {
    h = await harness();
    const { protectedPathsOf } = await import("./run.js");
    const list = await protectedPathsOf(h.deps, [{ appId: "app-a" }, { appId: "app-b" }]);
    for (const id of ["app-a", "app-b"]) {
      const p = appPathsOf(h.deps, id);
      for (const d of [p.configDir, p.dataDir, p.stateDir]) expect(list).toContain(d);
    }
    expect(list).toContain(path.join(h.deps.configDir, "bridge"));
    expect(list).toContain(path.join(h.deps.configDir, "bridge", "agents"));
    expect(list).toContain(path.join(h.deps.dataDir, "bridge"));
    expect(list).toContain(path.join(home(), ".local", "state", "bridge"));
  });

  it("an agent's config dir named by the environment is protected where it really is: `link/..` goes up from the link's target", async () => {
    h = await harness();
    const { protectedPathsOf } = await import("./run.js");
    const elsewhere = path.join(h.root, "elsewhere");
    await mkdir(path.join(elsewhere, "inner"), { recursive: true });
    await symlink(path.join(elsewhere, "inner"), path.join(h.root, "link"));
    // Lexically `<root>/x`; for the kernel `<root>/link/..` is `<root>/elsewhere`, so `<root>/elsewhere/x`.
    h.deps.env.CODEX_HOME = `${h.root}/link/../x`;
    const list = await protectedPathsOf(h.deps, []);
    expect(list).toContain(path.join(elsewhere, "x"));
    expect(list).not.toContain(path.join(h.root, "x"));
    // A dangling link is followed through its text.
    await symlink(path.join(h.root, "nowhere", "login"), path.join(h.root, "dangling"));
    h.deps.env.CLAUDE_CONFIG_DIR = path.join(h.root, "dangling");
    expect(await protectedPathsOf(h.deps, [])).toContain(path.join(h.root, "nowhere", "login"));
    // A link loop cannot be resolved, so the runner refuses to start.
    await symlink(path.join(h.root, "loop-b"), path.join(h.root, "loop-a"));
    await symlink(path.join(h.root, "loop-a"), path.join(h.root, "loop-b"));
    h.deps.env.CODEX_HOME = path.join(h.root, "loop-a");
    await expect(protectedPathsOf(h.deps, [])).rejects.toThrow(/cannot resolve .*loop-a/);
  });

  it.each(["work folder", "state folder", "inside the work folder", "a parent of the state folder"])("refuses to start when CODEX_HOME is an app's %s: the work-folder carve-out never admits an agent login", async (where) => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    const p = appPathsOf(h.deps, "app-a");
    await mkdir(p.workDir, { recursive: true });
    const codexHome = where === "work folder" ? p.workDir : where === "state folder" ? p.stateDir : where === "inside the work folder" ? path.join(p.workDir, "codex") : path.dirname(p.stateDir);
    h.deps.env.CODEX_HOME = codexHome;
    await expect(startRunner(runnerDeps(h), [a.record], { e2ee: false })).rejects.toThrow(/agent folder .* overlaps app-a's (work|state) folder/);
  });

  it("an app's allowedCwds cannot admit a folder the machine policy refuses: /guard protected, /guard/link -> /projects allowed, override /projects", async () => {
    h = await harness();
    const agent = fakeAdapter();
    const a = await appFixture(h, "app-a", "runner-a");
    const guard = path.join(home(), "guard");
    const projects = path.join(home(), "projects");
    await mkdir(guard, { recursive: true });
    await mkdir(projects, { recursive: true });
    await symlink(projects, path.join(guard, "link"));
    await writeJson(path.join(h.deps.configDir, "bridge", "policy.json"), { protectedPaths: [guard], allowedCwds: [path.join(guard, "link")] });
    await writeJson(appPathsOf(h.deps, "app-a").configFile, { policy: { allowedCwds: [projects] } });
    const handle = await startRunner(runnerDeps(h, { adapters: [agent.adapter] }), [a.record], { e2ee: false });
    cleanups.push(() => handle.stop());
    await until(() => handle.statuses()["app-a"] === "online");
    const browser = await new TestBrowser(a, "browser-1").open();
    expect(h.err.join("")).toContain(`${JSON.stringify(projects)} is not a folder the machine policy admits`);
    expect((await browser.request("session/new", { cwd: projects })).error).toBeDefined();
  });

  it("a dangling link in an app's allowedCwds cannot widen the policy: a session there is refused even after the link is completed", async () => {
    h = await harness();
    const agent = fakeAdapter();
    const a = await appFixture(h, "app-a", "runner-a");
    const proj = path.join(home(), "proj");
    const outside = path.join(h.root, "outside");
    await mkdir(proj, { recursive: true });
    // `<proj>/escape` dangles lexically inside the machine root, but points at a folder outside it.
    await symlink(outside, path.join(proj, "escape"));
    await writeJson(path.join(h.deps.configDir, "bridge", "policy.json"), { allowedCwds: [proj] });
    await writeJson(appPathsOf(h.deps, "app-a").configFile, { policy: { allowedCwds: [path.join(proj, "escape")] } });
    const handle = await startRunner(runnerDeps(h, { adapters: [agent.adapter] }), [a.record], { e2ee: false });
    cleanups.push(() => handle.stop());
    await until(() => handle.statuses()["app-a"] === "online");
    const browser = await new TestBrowser(a, "browser-1").open();
    expect(h.err.join("")).toContain("policy.allowedCwds");
    await mkdir(outside, { recursive: true });
    expect((await browser.request("session/new", { cwd: outside })).error).toBeDefined();
    expect((await browser.request("session/new", { cwd: path.join(proj, "escape") })).error).toBeDefined();
  });

  it("an allowedCwds entry below the work folder is dropped with a warning instead of passing validation and admitting nothing", async () => {
    h = await harness();
    const agent = fakeAdapter();
    const a = await appFixture(h, "app-a", "runner-a");
    const work = appPathsOf(h.deps, "app-a").workDir;
    await writeJson(appPathsOf(h.deps, "app-a").configFile, { policy: { allowedCwds: [path.join(work, "project"), work] } });
    const handle = await startRunner(runnerDeps(h, { adapters: [agent.adapter] }), [a.record], { e2ee: false });
    cleanups.push(() => handle.stop());
    await until(() => handle.statuses()["app-a"] === "online");
    const browser = await new TestBrowser(a, "browser-1").open();
    expect(h.err.join("")).toContain(`only the work folder itself (${work})`);
    expect(await browser.request("session/new", { cwd: work })).toHaveProperty("result");
  });

  it("refuses to start when two apps' state parents alias one another (Rule A), before any policy is built", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    const b = await appFixture(h, "app-b", "runner-b");
    const pa = appPathsOf(h.deps, "app-a");
    const pb = appPathsOf(h.deps, "app-b");
    // `<state>/app-b` is a link to `<state>/app-a`: B's work folder would be A's, and the carve-out would admit A into it.
    await mkdir(pa.stateDir, { recursive: true });
    await symlink(path.dirname(pa.stateDir), path.dirname(pb.stateDir));
    await expect(startRunner(runnerDeps(h, { adapters: [fakeAdapter().adapter] }), [a.record, b.record], { e2ee: false })).rejects.toThrow(/overlap/);
    expect(await readRunnerStatus(h.deps)).toBeUndefined();
  });
});

describe("start notification and enroll hint", () => {
  it("notifies and prints which apps are connected, once, and hints at enrolling a browser when none is trusted", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    const b = await appFixture(h, "app-b", "runner-b");
    await upsertApp(h.deps, a.record);
    await upsertApp(h.deps, b.record);
    const abort = new AbortController();
    const done = runCli(["run"], runnerDeps(h, { signal: abort.signal, adapters: [fakeAdapter().adapter] }));
    await until(() => h!.out.join("").includes("[app-a] online") && h!.out.join("").includes("[app-b] online"));
    await until(() => h!.notifications.length === 1);
    // The hints are printed after the notification, one keychain read per app: wait for the last one.
    await until(() => h!.err.join("").includes("no browser is trusted for App app-b"));
    expect(h.notifications[0]).toMatchObject({ title: "Bridge runner started" });
    expect(h.notifications[0]!.body).toContain("App app-a, App app-b");
    const err = h.err.join("");
    expect(err).toContain("Bridge runner started. Connected apps: App app-a, App app-b.");
    expect(err.match(/no browser is trusted for App app-a; run `bridge enroll app-a` or `bridge setup /g)).toHaveLength(1);
    expect(err).toContain("no browser is trusted for App app-b");
    abort.abort();
    expect(await done).toBe(0);
  });

  describe("the claude adapter hint", () => {
    /** A claude adapter that is there or not, the way the real one reports it (`resolved()`). */
    const claudeStandIn = (resolved: { command: string; source: "bundled" | "path" } | undefined): AgentAdapter =>
      ({ id: "claude", availability: async () => ({ id: "claude", available: resolved !== undefined }), resolved: () => resolved, spawn: async () => Promise.reject(new Error("unused")) }) as never;

    it("warns once after the started line when no claude adapter resolves at all, and names the install command", async () => {
      h = await harness();
      const a = await appFixture(h, "app-a", "runner-a");
      await upsertApp(h.deps, a.record);
      const abort = new AbortController();
      const done = runCli(["run"], runnerDeps(h, { signal: abort.signal, adapters: [claudeStandIn(undefined)] }));
      await until(() => h!.err.join("").includes("claude sessions are refused"));
      const err = h.err.join("");
      expect(err.indexOf("Bridge runner started")).toBeLessThan(err.indexOf("bridge run: warn:"));
      expect(err).toContain("bridge run: warn: the claude adapter is not installed; claude sessions are refused until you run `bridge agent install claude`\n");
      expect(err.match(/the claude adapter is not installed/g)).toHaveLength(1);
      abort.abort();
      expect(await done).toBe(0);
    });

    describe("codex", () => {
      const standIn = (id: string, resolved: { command: string; source: "bundled" | "path" } | undefined): AgentAdapter =>
        ({ id, availability: async () => ({ id, available: resolved !== undefined }), resolved: () => resolved, spawn: async () => Promise.reject(new Error("unused")) }) as never;
      const claudeFound = { command: "/usr/bin/claude-agent-acp", source: "path" as const };
      const codexLogin = async (): Promise<void> => {
        const file = path.join(h!.deps.configDir, "bridge/agents/codex/auth.json");
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify({ tokens: { access_token: "a1" } }), { mode: 0o600 });
      };
      const started = async (adapters: AgentAdapter[]): Promise<string> => {
        const a = await appFixture(h!, "app-a", "runner-a");
        await upsertApp(h!.deps, a.record);
        const abort = new AbortController();
        const done = runCli(["run"], runnerDeps(h!, { signal: abort.signal, adapters }));
        await until(() => h!.err.join("").includes("Bridge runner started"));
        await new Promise((r) => setTimeout(r, 30));
        const err = h!.err.join("");
        abort.abort();
        expect(await done).toBe(0);
        return err;
      };

      it("warns once, with the install command, when a codex login is in bridge's folder and no codex adapter resolves", async () => {
        h = await harness();
        await codexLogin();
        const err = await started([standIn("claude", claudeFound), standIn("codex", undefined)]);
        expect(err).toContain("bridge run: warn: the codex adapter is not installed; codex sessions are refused until you run `bridge agent install codex`\n");
        expect(err.match(/the codex adapter is not installed/g)).toHaveLength(1);
        expect(err).not.toContain("the claude adapter is not installed");
      });

      it("says nothing about codex without a codex login, or when an adapter resolves", async () => {
        h = await harness();
        expect(await started([standIn("claude", claudeFound), standIn("codex", undefined)])).not.toContain("codex adapter is not installed");
        h = await harness();
        await codexLogin();
        expect(await started([standIn("claude", claudeFound), standIn("codex", { command: "/data/bridge/adapters/codex/2.5.0/node_modules/.bin/codex-acp", source: "bundled" })])).not.toContain("codex adapter is not installed");
      });
    });

    it.each([
      ["an adapter on PATH", { command: "/usr/bin/claude-agent-acp", source: "path" as const }],
      ["bridge's installed copy", { command: "/data/bridge/adapters/claude/0.94.0/node_modules/.bin/claude-agent-acp", source: "bundled" as const }],
    ])("says nothing when %s resolves", async (_name, resolved) => {
      h = await harness();
      const a = await appFixture(h, "app-a", "runner-a");
      await upsertApp(h.deps, a.record);
      const abort = new AbortController();
      const done = runCli(["run"], runnerDeps(h, { signal: abort.signal, adapters: [claudeStandIn(resolved)] }));
      await until(() => h!.err.join("").includes("Bridge runner started"));
      await new Promise((r) => setTimeout(r, 30));
      expect(h.err.join("")).not.toContain("claude adapter is not installed");
      abort.abort();
      expect(await done).toBe(0);
    });
  });

  describe("update notice", () => {
    const REGISTRY_URL = "https://registry.npmjs.org/@berdyh%2fbridge/latest";

    /** The harness's fetch, except that the registry's dist-tag URL is answered by `answer`; every registry request is recorded. */
    function withRegistry(answer: () => Response | Promise<Response>) {
      const asked: string[] = [];
      const env = { ...h!.deps.env };
      delete env.BRIDGE_UPDATE_CHECK;
      const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).startsWith("https://registry.npmjs.org/")) {
          asked.push(String(input));
          return answer();
        }
        return globalThis.fetch(input, init);
      }) as typeof fetch;
      return { asked, env, fetch: fetchFn };
    }

    it("prints one info line after the started line when the registry has a newer bridge, and asks only for the metadata", async () => {
      h = await harness();
      const a = await appFixture(h, "app-a", "runner-a");
      await upsertApp(h.deps, a.record);
      const registry = withRegistry(() => new Response(JSON.stringify({ version: "99.0.0" })));
      const abort = new AbortController();
      const done = runCli(["run"], runnerDeps(h, { signal: abort.signal, adapters: [fakeAdapter().adapter], env: registry.env, fetch: registry.fetch }));
      await until(() => h!.err.join("").includes("is available"));
      const err = h.err.join("");
      expect(err.indexOf("Bridge runner started")).toBeLessThan(err.indexOf("bridge run: info: bridge 99.0.0 is available"));
      expect(err).toContain(`bridge run: info: bridge 99.0.0 is available (this is ${CLI_VERSION}); install it with \`bridge self install --version 99.0.0\`\n`);
      expect(err.match(/is available/g)).toHaveLength(1);
      expect(registry.asked).toEqual([REGISTRY_URL]);
      abort.abort();
      expect(await done).toBe(0);
    });

    it("does not leave a rejection unhandled when printing the notice throws", async () => {
      h = await harness();
      const a = await appFixture(h, "app-a", "runner-a");
      await upsertApp(h.deps, a.record);
      const registry = withRegistry(() => new Response(JSON.stringify({ version: "99.0.0" })));
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
      process.on("unhandledRejection", onUnhandled);
      try {
        const abort = new AbortController();
        const done = runCli(["run"], runnerDeps(h, {
          signal: abort.signal, adapters: [fakeAdapter().adapter], env: registry.env, fetch: registry.fetch,
          stderr: (text: string) => {
            if (text.includes("is available")) throw new Error("stderr closed");
            h!.deps.stderr(text);
          },
        }));
        await until(() => registry.asked.length === 1);
        await new Promise((r) => setTimeout(r, 100));
        expect(unhandled).toEqual([]);
        abort.abort();
        expect(await done).toBe(0);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("prints nothing for the same version, an unreachable registry or BRIDGE_UPDATE_CHECK=0", async () => {
      h = await harness();
      const a = await appFixture(h, "app-a", "runner-a");
      await upsertApp(h.deps, a.record);
      for (const [answer, off] of [
        [() => new Response(JSON.stringify({ version: CLI_VERSION })), false],
        [() => { throw new Error("offline"); }, false],
        [() => new Response(JSON.stringify({ version: "99.0.0" })), true],
      ] as const) {
        h.err.length = 0;
        const registry = withRegistry(answer);
        if (off) registry.env.BRIDGE_UPDATE_CHECK = "0";
        const abort = new AbortController();
        const done = runCli(["run"], runnerDeps(h, { signal: abort.signal, adapters: [fakeAdapter().adapter], env: registry.env, fetch: registry.fetch }));
        await until(() => h!.err.join("").includes("Bridge runner started"));
        await new Promise((r) => setTimeout(r, 50));
        expect(h.err.join("")).not.toContain("is available");
        expect(registry.asked).toHaveLength(off ? 0 : 1);
        abort.abort();
        expect(await done).toBe(0);
      }
    });
  });

  it("does not hint for an app that has a trusted browser, and a failing notifier does not stop the runner", async () => {
    h = await harness({
      notify: async () => { throw new Error("no dbus"); },
      e2ee: { enroll: async () => { throw new Error("unused"); }, listBrowsers: async (app) => (app.appId === "app-a" ? [{ browserKeyId: "k", publicKey: "p", label: "L", enrolledAt: "x", lastSeen: "x" }] : []), revokeBrowser: async () => false },
    });
    const a = await appFixture(h, "app-a", "runner-a");
    const b = await appFixture(h, "app-b", "runner-b");
    await upsertApp(h.deps, a.record);
    await upsertApp(h.deps, b.record);
    const abort = new AbortController();
    const done = runCli(["run"], runnerDeps(h, { signal: abort.signal, adapters: [fakeAdapter().adapter] }));
    await until(() => h!.out.join("").includes("[app-a] online") && h!.out.join("").includes("[app-b] online"));
    expect(h.err.join("")).not.toContain("no browser is trusted for App app-a");
    expect(h.err.join("")).toContain("no browser is trusted for App app-b");
    abort.abort();
    expect(await done).toBe(0);
  });
});

describe("the idle stop", () => {
  const MIN = 60_000;

  async function runWithClock(over: Partial<CliDeps> = {}, second = false) {
    h = await harness();
    await allowHomeCwd(h);
    const a = await appFixture(h, "app-a", "runner-a");
    await upsertApp(h.deps, a.record);
    const b = second ? await appFixture(h, "app-b", "runner-b") : undefined;
    if (b) await upsertApp(h.deps, b.record);
    const clock = manualClock();
    const abort = new AbortController();
    let result: number | undefined;
    const done = runRun(["--no-e2ee"], runnerDeps(h, { signal: abort.signal, now: clock.now, adapters: [fakeAdapter().adapter], peerGoneGraceMs: 40, ...over }), { idle: { timers: clock.timers } }).then((c) => (result = c));
    cleanups.push(async () => { abort.abort(); await done; });
    await until(() => h!.out.join("").includes("[app-a] online"));
    if (b) await until(() => h!.out.join("").includes("[app-b] online"));
    return { a, b, clock, abort, done, result: () => result };
  }

  it("stops with exit 0 after 15 minutes with no browser, and removes the status file", async () => {
    const run = await runWithClock();
    await run.clock.advance(14 * MIN);
    expect(run.result()).toBeUndefined();
    await run.clock.advance(MIN + 1000);
    await until(() => run.result() !== undefined);
    expect(run.result()).toBe(0);
    expect(h!.err.join("")).toContain("no browser was connected for 15 minutes; stopped");
    expect(await readRunnerStatus(h!.deps)).toBeUndefined();
  });

  it("never stops while a browser is connected, however long; the period starts again when it leaves", async () => {
    const run = await runWithClock();
    await run.clock.advance(10 * MIN);
    const browser = await new TestBrowser(run.a, "browser-1").open();
    await browser.request("initialize");
    await until(() => (run.clock.pending() === 0));
    await run.clock.advance(60 * MIN);
    expect(run.result()).toBeUndefined();
    expect((await browser.request("initialize")).result).toBeTruthy();

    browser.close();
    await until(async () => (await readRunnerStatus(h!.deps))?.browsers === 0);
    await until(() => run.clock.pending() > 0);
    await run.clock.advance(14 * MIN);
    expect(run.result()).toBeUndefined();
    await run.clock.advance(2 * MIN);
    await until(() => run.result() !== undefined);
    expect(run.result()).toBe(0);
  }, 15000);

  it("a reload inside the grace period keeps the runner running (the departure is never reported)", async () => {
    const run = await runWithClock({ peerGoneGraceMs: 400 });
    const first = await new TestBrowser(run.a, "browser-1").open();
    await first.request("initialize");
    await run.clock.advance(14 * MIN);
    first.close();
    // The page reloads: the new socket is on the relay before the grace period ends.
    // (a bare socket: the runner resends the old session's frames to it, which a fresh layer would reject)
    const reloaded = new (WebSocket as unknown as new (u: string, o: object) => WebSocket)(
      `${run.a.server.url.replace("http", "ws")}/relay/browser?browserKeyId=browser-1`,
      { protocols: [RELAY_SUBPROTOCOL, bearerSubprotocol(run.a.browserToken)], headers: { origin: run.a.server.url } },
    );
    cleanups.push(() => reloaded.close());
    await new Promise<void>((resolve, reject) => {
      reloaded.addEventListener("open", () => resolve());
      reloaded.addEventListener("error", () => reject(new Error("browser socket failed")));
    });
    await new Promise((r) => setTimeout(r, 900));
    expect((await readRunnerStatus(h!.deps))?.browsers).toBe(1);
    await run.clock.advance(30 * MIN);
    expect(run.result()).toBeUndefined();
  }, 15000);

  it("an open enroll window is activity: it holds the runner, and the period counts from its end", async () => {
    const run = await runWithClock();
    const app = run.a.record;
    const file = appPathsOf(h!.deps, app.appId).enrollFile;
    await mkdir(path.dirname(file), { recursive: true });
    const open = { v: 1, codeId: "c", code: "BCDFGHJK", expiresAt: new Date(run.clock.now() + 60 * MIN).toISOString(), attemptsLeft: 5, state: "open", ownerPid: process.pid };
    await writeFile(file, JSON.stringify(open));
    await run.clock.advance(20 * MIN);
    expect(run.result()).toBeUndefined();
    // The window ends (the enroll process is gone): 15 minutes from the last look at it, not before.
    await writeFile(file, JSON.stringify({ ...open, ownerPid: 2 ** 22 + 999 }));
    await run.clock.advance(14 * MIN);
    expect(run.result()).toBeUndefined();
    await run.clock.advance(2 * MIN);
    await until(() => run.result() !== undefined);
    expect(run.result()).toBe(0);
  }, 15000);

  const windowFile = (app: HostedAppRecord) => appPathsOf(h!.deps, app.appId).enrollFile;
  const openWindow = (clock: { now(): number }, app: HostedAppRecord, over: object = {}) => ({
    v: 1, codeId: "c", code: "BCDFGHJK", expiresAt: new Date(clock.now() + 60 * MIN).toISOString(), attemptsLeft: 5, state: "open", ownerPid: process.pid, ...over,
  });

  it("a window that opened and closed between two looks still counts as activity", async () => {
    const run = await runWithClock();
    const file = windowFile(run.a.record);
    await run.clock.advance(14 * MIN + 30_000);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(openWindow(run.clock, run.a.record)));
    await rm(file);
    // The period would have ended at 15 minutes; the window seen at the next look restarts it.
    await run.clock.advance(MIN);
    expect(run.result()).toBeUndefined();
    await run.clock.advance(13 * MIN);
    expect(run.result()).toBeUndefined();
    await run.clock.advance(3 * MIN);
    await until(() => run.result() !== undefined);
    expect(run.result()).toBe(0);
  }, 15000);

  it("a window that opens on one app while the scan is still reading another holds the runner", async () => {
    const run = await runWithClock({}, true);
    const fileA = windowFile(run.a.record);
    const t0 = run.clock.now();
    await run.clock.advance(14 * MIN + 30_000);
    // The read of app-b is slow, and app-a's window opens while it is in flight.
    const real = (await vi.importActual<typeof import("@berdyh/bridge-runner")>("@berdyh/bridge-runner")).readEnrollWindow;
    let written = false;
    vi.mocked(runner.readEnrollWindow).mockImplementation(async (app) => {
      // Only the look that would end the idle period: the window opens right after app-a was read as closed.
      if (app.appId === "app-b" && run.clock.now() - t0 >= IDLE_STOP_MS && !written) {
        written = true;
        await mkdir(path.dirname(fileA), { recursive: true });
        await writeFile(fileA, JSON.stringify(openWindow(run.clock, run.a.record)));
        await new Promise((r) => setTimeout(r, 50));
      }
      return real(app);
    });
    cleanups.push(() => void vi.mocked(runner.readEnrollWindow).mockImplementation(real));
    await run.clock.advance(MIN);
    await new Promise((r) => setTimeout(r, 400));
    expect(written).toBe(true);
    expect(run.result()).toBeUndefined();
    // The open window then holds it for as long as it lasts.
    await run.clock.advance(30 * MIN);
    expect(run.result()).toBeUndefined();
  }, 15000);

  it("browsers on a link that parks for good are forgotten, so the idle stop still comes", async () => {
    const run = await runWithClock();
    const browser = await new TestBrowser(run.a, "browser-1").open();
    await browser.request("initialize");
    await until(async () => (await readRunnerStatus(h!.deps))?.browsers === 1);
    const thief = new (WebSocket as unknown as new (u: string, o: object) => WebSocket)(
      `${run.a.server.url.replace("http", "ws")}/relay/runner?runnerId=runner-a`,
      { headers: { authorization: `Bearer ${run.a.runnerToken}` } },
    );
    cleanups.push(() => thief.close());
    thief.addEventListener("open", () => thief.send(JSON.stringify({ type: "hello", runnerId: "runner-a", runnerVersion: "1.0.0", protocol: { min: 1, max: 1 } })));
    await until(() => h!.out.join("").includes("[app-a] replaced"));
    await until(async () => (await readRunnerStatus(h!.deps))?.browsers === 0);
    expect((await readRunnerStatus(h!.deps))!.idleSince).toBeDefined();
    await until(() => run.clock.pending() > 0);
    await run.clock.advance(IDLE_STOP_MS + MIN);
    await until(() => run.result() !== undefined);
    expect(run.result()).toBe(0);
  }, 15000);

  it("a browser that comes and goes while a check awaits the enroll scan leaves one timer chain, not two", async () => {
    const run = await runWithClock();
    const real = (await vi.importActual<typeof import("@berdyh/bridge-runner")>("@berdyh/bridge-runner")).readEnrollWindow;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    vi.mocked(runner.readEnrollWindow).mockImplementation(async (app) => {
      if (!held) {
        held = true;
        await gate;
      }
      return real(app);
    });
    cleanups.push(() => void vi.mocked(runner.readEnrollWindow).mockImplementation(real));
    // The first poll fires and its scan is held open.
    await run.clock.advance(30_000);
    await until(() => held);
    expect(run.clock.pending()).toBe(0);
    // A browser arrives and leaves meanwhile: the runner arms a new chain when the last one is gone.
    const browser = await new TestBrowser(run.a, "browser-1").open();
    await browser.request("initialize");
    await until(async () => (await readRunnerStatus(h!.deps))?.browsers === 1);
    browser.close();
    await until(async () => (await readRunnerStatus(h!.deps))?.browsers === 0);
    await until(() => run.clock.pending() === 1);
    // The stale check resumes: it must not schedule a second chain.
    release();
    await new Promise((r) => setTimeout(r, 200));
    expect(run.clock.pending()).toBe(1);
    expect(run.result()).toBeUndefined();
    await run.clock.advance(IDLE_STOP_MS + MIN);
    await until(() => run.result() !== undefined);
    expect(run.result()).toBe(0);
  }, 15000);

  it("exits 0, not 1, when every app is parked and the runner idles out", async () => {
    const run = await runWithClock();
    const thief = new (WebSocket as unknown as new (u: string, o: object) => WebSocket)(
      `${run.a.server.url.replace("http", "ws")}/relay/runner?runnerId=runner-a`,
      { headers: { authorization: `Bearer ${run.a.runnerToken}` } },
    );
    cleanups.push(() => thief.close());
    thief.addEventListener("open", () => thief.send(JSON.stringify({ type: "hello", runnerId: "runner-a", runnerVersion: "1.0.0", protocol: { min: 1, max: 1 } })));
    await until(() => h!.out.join("").includes("[app-a] replaced"));
    await run.clock.advance(IDLE_STOP_MS + MIN);
    await until(() => run.result() !== undefined);
    expect(run.result()).toBe(0);
  }, 15000);

  it("a link the relay revoked writes revoked.json naming the record's runner id, and the mark outlives the idle stop; a restart on it says so and still tries", async () => {
    h = await harness();
    await allowHomeCwd(h);
    const a = await appFixture(h, "app-a", "runner-a");
    await upsertApp(h.deps, a.record);
    const markFile = appPathsOf(h.deps, "app-a").revokedFile;
    const clock = manualClock();
    const abort = new AbortController();
    let result: number | undefined;
    const done = runRun(["--no-e2ee"], runnerDeps(h, { signal: abort.signal, now: clock.now, adapters: [fakeAdapter().adapter], peerGoneGraceMs: 40 }), { idle: { timers: clock.timers } }).then((c) => (result = c));
    cleanups.push(async () => { abort.abort(); await done; });
    await until(() => h!.out.join("").includes("[app-a] online"));
    expect(existsSync(markFile)).toBe(false);
    // The person revokes this device on the app: the relay closes the live socket with `revoked`.
    const res = await fetch(`${a.server.url}/bridge/devices/runner-a`, { method: "DELETE", headers: { authorization: `Bearer ${a.browserToken}`, origin: a.server.url } });
    expect(res.status).toBe(200);
    await until(() => h!.out.join("").includes("[app-a] revoked"));
    await until(() => existsSync(markFile));
    const mark = JSON.parse(await readFile(markFile, "utf8")) as { version: number; runnerId: string; at: string; detail?: string };
    expect(mark).toMatchObject({ version: 1, runnerId: "runner-a" });
    expect(Number.isNaN(Date.parse(mark.at))).toBe(false);
    expect(mark.detail).toContain("revoked");
    expect((await lstat(markFile)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(markFile))).not.toContainEqual(expect.stringMatching(/\.tmp$/));

    await clock.advance(IDLE_STOP_MS + MIN);
    await until(() => result !== undefined);
    expect(result).toBe(0);
    expect(existsSync(markFile)).toBe(true);
    expect(JSON.parse(await readFile(markFile, "utf8"))).toEqual(mark);

    // A restart on the same record: the mark is named once, and the link still tries (the relay decides).
    // The relay answers that upgrade with the revoked verdict (the credential is revoked and the store confirms it), not a 403.
    h.err.length = 0;
    h.out.length = 0;
    const again = new AbortController();
    const second = runRun(["--no-e2ee"], runnerDeps(h, { signal: again.signal, adapters: [fakeAdapter().adapter] }), {}).then((c) => c);
    cleanups.push(async () => { again.abort(); await second; });
    await until(() => h!.out.join("").includes("[app-a] revoked"));
    // The verdict parks the link: it does not keep retrying.
    await new Promise((r) => setTimeout(r, 300));
    expect(h.err.join("")).not.toContain("relay connection failed");
    const lines = h.err.join("").split("\n").filter((l) => l.includes("this runner id was revoked on"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(mark.at);
    expect(lines[0]).toContain(`bridge connect ${a.record.url}`);
  }, 15000);

  it("a mark that names another runner id is not announced", async () => {
    h = await harness();
    await allowHomeCwd(h);
    const a = await appFixture(h, "app-a", "runner-a");
    await upsertApp(h.deps, a.record);
    const markFile = appPathsOf(h.deps, "app-a").revokedFile;
    await mkdir(path.dirname(markFile), { recursive: true });
    await writeFile(markFile, JSON.stringify({ version: 1, runnerId: "an-older-runner", at: "2026-10-20T00:00:00.000Z" }));
    const abort = new AbortController();
    const done = runRun(["--no-e2ee"], runnerDeps(h, { signal: abort.signal, adapters: [fakeAdapter().adapter] }), {});
    cleanups.push(async () => { abort.abort(); await done; });
    await until(() => h!.out.join("").includes("[app-a] online"));
    expect(h.err.join("")).not.toContain("this runner id was revoked on");
  });

  it("a signal still ends the run first, with the usual exit code", async () => {
    const run = await runWithClock();
    run.abort.abort();
    await run.done;
    expect(run.result()).toBe(0);
    expect(h!.err.join("")).not.toContain("stopped. Start it again");
  });
});

// --- one runner per machine, one worker per app, and the start-up sweep ----------------------------------------

/** A pid that is alive as far as the runner is told, and one that is not. */
const LIVE_PID = 2_000_000_002;
const DEAD_PID = 2_000_000_001;
const aliveSet = (...pids: number[]) => (pid: number) => pid === process.pid || pids.includes(pid);
const lockRecord = (pid: number) => `${JSON.stringify({ version: 1, pid, startedAt: "2026-11-03T10:00:00.000Z" })}\n`;

/** What a crashed runner leaves for one app: a session folder, a link in the sessions dir, a secrets folder, and a session sandbox with a staged login in it. */
async function plant(h: Harness, appId: string): Promise<{ session: string; link: string; target: string; secrets: string; sandbox: string }> {
  const paths = appPathsOf(h.deps, appId);
  const session = path.join(paths.sessionsDir, "s-0123456789abcdef");
  const target = path.join(h.root, `precious-${appId}`);
  const link = path.join(paths.sessionsDir, "planted-link");
  const secrets = path.join(paths.tmpDir, "bridge-acp-secrets-s-0123456789abcdef");
  const sandbox = path.join(paths.tmpDir, "bridge-acp-AbCdEf");
  for (const dir of [session, target, secrets, sandbox]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(session, "note.txt"), "x");
  await writeFile(path.join(secrets, "files"), "SECRET");
  await writeFile(path.join(sandbox, "keep"), "x");
  await writeFile(path.join(target, "keep"), "x");
  await symlink(target, link);
  // The staged login of a crashed session, and a link planted next to the sandboxes: it goes as a link, its target stays.
  await mkdir(path.join(sandbox, "claude"), { recursive: true });
  await writeFile(path.join(sandbox, "claude", ".credentials.json"), "{\"staged\":true}");
  await symlink(target, path.join(paths.tmpDir, "bridge-acp-planted-link"));
  return { session, link, target, secrets, sandbox };
}

const gone = (file: string): Promise<boolean> => lstat(file).then(() => false, () => true);

describe("the start-up sweep and the runner lock", () => {
  it("removes a leftover session folder and secrets folder at start; a link planted in sessionsDir goes as a link and its target stays; the leftover sandbox with its staged login and a link named like one go too; the log has counts, no names", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    const planted = await plant(h, "app-a");
    const handle = await start(h, [a], { adapters: [fakeAdapter().adapter] });
    expect(await gone(planted.session)).toBe(true);
    expect(await gone(planted.link)).toBe(true);
    expect(await gone(planted.secrets)).toBe(true);
    expect(await readFile(path.join(planted.target, "keep"), "utf8")).toBe("x");
    expect(await gone(planted.sandbox)).toBe(true);
    expect(await gone(path.join(appPathsOf(h.deps, "app-a").tmpDir, "bridge-acp-planted-link"))).toBe(true);
    const log = h.err.join("");
    expect(log).toContain("[app-a] info: removed 2 stale session folder(s), 1 stale secret folder(s) and 2 stale agent sandbox(es)");
    expect(log).not.toContain("AbCdEf");
    expect(log).not.toContain("s-0123456789abcdef");
    expect(log).not.toContain("planted-link");
    await handle.stop();
  });

  it("sweeps before the proxy accepts a session or any plugin starts", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    const planted = await plant(h, "app-a");
    let sweptWhenPluginsStarted: boolean | undefined;
    const pluginHost: runner.PluginHost = {
      install: async () => { throw new Error("unused"); },
      list: async () => [],
      remove: async () => {},
      revoke: async () => {},
      start: async () => void (sweptWhenPluginsStarted = await gone(planted.session)),
      stopAll: async () => {},
      router: { handles: () => false, request: async () => null, notify: () => {}, subscribe: () => () => {} },
      setBroker: () => {},
    };
    await start(h, [a], { pluginHost, adapters: [fakeAdapter().adapter] });
    expect(sweptWhenPluginsStarted).toBe(true);
  });

  it("sweepApp touches one app's two folders only: another app's planted folders stay, and a sessionsDir that is itself a link is left alone", async () => {
    h = await harness();
    const mine = await plant(h, "app-a");
    const theirs = await plant(h, "app-b");
    const result = await sweepApp(appPathsOf(h.deps, "app-a"));
    expect(result).toEqual({ sessions: 2, secrets: 1, sandboxes: 2, left: [] });
    expect(await gone(mine.sandbox)).toBe(true);
    for (const kept of [theirs.session, theirs.link, theirs.secrets, theirs.sandbox, mine.target]) expect(await gone(kept)).toBe(false);

    // The sessions folder replaced by a link: nothing under its target is touched, and the result says it was left.
    const b = appPathsOf(h.deps, "app-b");
    await rm(b.sessionsDir, { recursive: true });
    const elsewhere = path.join(h.root, "elsewhere");
    await mkdir(path.join(elsewhere, "keepme"), { recursive: true });
    await symlink(elsewhere, b.sessionsDir);
    const second = await sweepApp(b);
    expect(second.sessions).toBe(0);
    expect(second.secrets).toBe(1);
    expect(second.left).toEqual([{ dir: b.sessionsDir, why: `${b.sessionsDir} is a link` }]);
    expect(await readdir(elsewhere)).toEqual(["keepme"]);
  });

  it("a second bridge run with a live lock holder exits 1 before sweeping, writes no runner.json and leaves the lock as it was", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    await upsertApp(h.deps, a.record);
    const planted = await plant(h, "app-a");
    const lock = runnerLockPath(h.deps);
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, lockRecord(LIVE_PID));

    const code = await runRun(["--no-e2ee"], runnerDeps(h, { adapters: [fakeAdapter().adapter] }), { isPidAlive: aliveSet(LIVE_PID) });
    expect(code).toBe(1);
    const err = h.err.join("");
    expect(err).toContain(`bridge run: another runner is running (pid ${LIVE_PID}, since 2026-11-03T10:00:00.000Z); stop it first. If none is running, remove ${lock}`);
    expect(err.trim().split("\n").filter((l) => l.includes("another runner"))).toHaveLength(1);
    for (const kept of [planted.session, planted.secrets, planted.link]) expect(await gone(kept)).toBe(false);
    expect(await gone(statusFilePath(h.deps))).toBe(true);
    expect(await readFile(lock, "utf8")).toBe(lockRecord(LIVE_PID));
    expect(await gone(workerLockPath(appPathsOf(h.deps, "app-a")))).toBe(true);
  });

  it("through the command line too: bridge run with a live holder exits 1", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    await upsertApp(h.deps, a.record);
    const lock = runnerLockPath(h.deps);
    await mkdir(path.dirname(lock), { recursive: true });
    // The holder is this very process (alive): a runner that is already running here.
    await writeFile(lock, lockRecord(process.pid));
    expect(await runCli(["run", "--no-e2ee"], runnerDeps(h, { adapters: [fakeAdapter().adapter] }))).toBe(1);
    expect(h.err.join("")).toContain(`another runner is running (pid ${process.pid}`);
  });

  it("replaces a dead holder's lock, then sweeps, and the lock names this process while it runs", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    const planted = await plant(h, "app-a");
    const lock = runnerLockPath(h.deps);
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, lockRecord(DEAD_PID));
    const worker = workerLockPath(appPathsOf(h.deps, "app-a"));
    await writeFile(worker, lockRecord(DEAD_PID));
    const handle = await start(h, [a], { adapters: [fakeAdapter().adapter] });
    expect(JSON.parse(await readFile(lock, "utf8")).pid).toBe(process.pid);
    expect(JSON.parse(await readFile(worker, "utf8")).pid).toBe(process.pid);
    expect(await gone(planted.session)).toBe(true);
    await handle.stop();
  });

  it("a runner.json of an older bridge naming a live pid, with no lock, refuses the start (the transition rule)", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    await upsertApp(h.deps, a.record);
    const planted = await plant(h, "app-a");
    const status = statusFilePath(h.deps);
    await mkdir(path.dirname(status), { recursive: true });
    await writeFile(status, JSON.stringify({ version: 1, pid: LIVE_PID, startedAt: "2026-11-03T09:00:00.000Z", apps: {}, browsers: 0 }));
    expect(await runRun(["--no-e2ee"], runnerDeps(h, { adapters: [fakeAdapter().adapter] }), { isPidAlive: aliveSet(LIVE_PID) })).toBe(1);
    expect(h.err.join("")).toContain(`another runner is running (pid ${LIVE_PID}`);
    expect(await gone(planted.session)).toBe(false);
    expect(await gone(runnerLockPath(h.deps))).toBe(true);
  });

  it("an app whose worker lock is held by a live process is not served and not swept; the other app is, and the runner goes on", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    const b = await appFixture(h, "app-b", "runner-b");
    const plantedA = await plant(h, "app-a");
    const plantedB = await plant(h, "app-b");
    const workerA = workerLockPath(appPathsOf(h.deps, "app-a"));
    await mkdir(path.dirname(workerA), { recursive: true });
    await writeFile(workerA, lockRecord(LIVE_PID));
    await allowHomeCwd(h);
    const handle = await startRunner(runnerDeps(h, { adapters: [fakeAdapter().adapter] }), [a.record, b.record], { e2ee: false, isPidAlive: aliveSet(LIVE_PID) });
    cleanups.push(() => handle.stop());
    await until(() => handle.statuses()["app-b"] === "online");
    expect(Object.keys(handle.statuses())).toEqual(["app-b"]);
    expect(h.err.join("")).toContain(`[app-a] error: another worker for app app-a is running (pid ${LIVE_PID}`);
    expect(await gone(plantedA.session)).toBe(false);
    expect(await gone(plantedA.secrets)).toBe(false);
    expect(await gone(plantedB.session)).toBe(true);
    expect(await gone(plantedB.secrets)).toBe(true);
    await handle.stop();
    // Our locks are gone; the other process's lock is not ours to remove.
    expect(await gone(runnerLockPath(h.deps))).toBe(true);
    expect(await gone(workerLockPath(appPathsOf(h.deps, "app-b")))).toBe(true);
    expect(await readFile(workerA, "utf8")).toBe(lockRecord(LIVE_PID));
  });

  it("when no app can be served the start is refused and the runner lock is released", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    const workerA = workerLockPath(appPathsOf(h.deps, "app-a"));
    await mkdir(path.dirname(workerA), { recursive: true });
    await writeFile(workerA, lockRecord(LIVE_PID));
    await expect(startRunner(runnerDeps(h), [a.record], { e2ee: false, isPidAlive: aliveSet(LIVE_PID) })).rejects.toBeInstanceOf(LockRefused);
    expect(await gone(runnerLockPath(h.deps))).toBe(true);
  });

  it("releases every lock when the start fails after they were taken (an invalid policy.json)", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    await mkdir(path.join(h.deps.configDir, "bridge"), { recursive: true });
    await writeFile(path.join(h.deps.configDir, "bridge", "policy.json"), "[]");
    await expect(startRunner(runnerDeps(h, { adapters: [fakeAdapter().adapter] }), [a.record], { e2ee: false })).rejects.toThrow("policy.json is not valid: it must be a JSON object");
    expect(await gone(runnerLockPath(h.deps))).toBe(true);
    expect(await gone(workerLockPath(appPathsOf(h.deps, "app-a")))).toBe(true);
  });

  it("stop() keeps the locks while the plugins stop and releases runner.json, then the worker locks, then the runner lock; the abort path of bridge run does the same", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    const b = await appFixture(h, "app-b", "runner-b");
    await upsertApp(h.deps, a.record);
    await upsertApp(h.deps, b.record);
    const files = { status: statusFilePath(h.deps), runnerLock: runnerLockPath(h.deps), workerA: workerLockPath(appPathsOf(h.deps, "app-a")), workerB: workerLockPath(appPathsOf(h.deps, "app-b")) };
    const present = () => Object.fromEntries(Object.entries(files).map(([k, f]) => [k, existsSync(f)])) as Record<keyof typeof files, boolean>;
    let duringStopAll: Record<string, boolean> | undefined;
    const pluginHost: runner.PluginHost = {
      install: async () => { throw new Error("unused"); },
      list: async () => [],
      remove: async () => {},
      revoke: async () => {},
      start: async () => {},
      stopAll: async () => void (duringStopAll = present()),
      router: { handles: () => false, request: async () => null, notify: () => {}, subscribe: () => () => {} },
      setBroker: () => {},
    };
    const abort = new AbortController();
    const done = runRun(["--no-e2ee"], runnerDeps(h, { signal: abort.signal, pluginHost, adapters: [fakeAdapter().adapter] }));
    await until(() => h!.out.join("").includes("[app-b] online") && h!.out.join("").includes("[app-a] online"));
    expect(present()).toEqual({ status: true, runnerLock: true, workerA: true, workerB: true });

    // Sample the folder while the runner stops: the machine-wide lock may not vanish before runner.json and the worker locks.
    const orderBroken: string[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const now = present();
        if (!now.runnerLock && (now.status || now.workerA || now.workerB)) orderBroken.push(JSON.stringify(now));
        await new Promise((r) => setImmediate(r));
      }
    })();
    abort.abort();
    expect(await done).toBe(0);
    sampling = false;
    await sampler;
    expect(duringStopAll).toEqual({ status: true, runnerLock: true, workerA: true, workerB: true });
    expect(orderBroken).toEqual([]);
    expect(present()).toEqual({ status: false, runnerLock: false, workerA: false, workerB: false });
  });
});

describe("policy.json on load", () => {
  it("must be a JSON object; mode and the list keys are checked; the runner's own keys and unknown keys are dropped with a warning", () => {
    const file = "policy.json";
    expect(() => validateMachinePolicy([], file)).toThrow("policy.json is not valid: it must be a JSON object");
    expect(() => validateMachinePolicy(null, file)).toThrow("must be a JSON object");
    expect(() => validateMachinePolicy("ask", file)).toThrow("must be a JSON object");
    expect(() => validateMachinePolicy({ mode: "yolo" }, file)).toThrow('"mode" must be one of ask, read-only, accept-edits, bypass');
    for (const key of ["agents", "allowedCwds", "allowedTools", "protectedPaths"]) {
      expect(() => validateMachinePolicy({ [key]: "x" }, file)).toThrow(`"${key}" must be a list of strings`);
      expect(() => validateMachinePolicy({ [key]: [1] }, file)).toThrow(`"${key}" must be a list of strings`);
    }
    const ok = validateMachinePolicy(
      { mode: "read-only", agents: ["claude"], models: ["m"], pluginApprovals: false, sessionBudget: { maxToolCalls: 5 }, auditFailed: "no", agentModel: "x", homedir: "/etc", typo: 1 },
      file,
    );
    expect(ok.policy).toEqual({ mode: "read-only", agents: ["claude"], models: ["m"], pluginApprovals: false, sessionBudget: { maxToolCalls: 5 } });
    expect(ok.warnings).toEqual([
      'policy.json: "auditFailed" is set by bridge, not by this file; ignored',
      'policy.json: "agentModel" is set by bridge, not by this file; ignored',
      'policy.json: "homedir" is set by bridge, not by this file; ignored',
      'policy.json: unknown key "typo"; ignored',
    ]);
  });

  it("a value the policy itself fails closed on (models that is not a list) is passed on for it to report", () => {
    expect(validateMachinePolicy({ models: "sonnet" }, "policy.json").policy).toEqual({ models: "sonnet" });
  });

  it("an invalid file stops the start with its reason", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    await mkdir(path.join(h.deps.configDir, "bridge"), { recursive: true });
    await writeFile(path.join(h.deps.configDir, "bridge", "policy.json"), JSON.stringify({ mode: "yolo" }));
    await upsertApp(h.deps, a.record);
    await expect(startRunner(runnerDeps(h, { adapters: [fakeAdapter().adapter] }), [a.record], { e2ee: false })).rejects.toThrow('policy.json is not valid: "mode" must be one of');
  });
});

describe("what the policy is given for a contained plugin session", () => {
  const SET = ["mcp__srv__read"];
  const OPTIONS = [{ optionId: "once", name: "Once", kind: "allow_once" }, { optionId: "no", name: "No", kind: "reject_once" }];

  /** The effective policy `startRunner` built last: the call that carried `auditFailed`. */
  function builtPolicy(): { config: runner.LocalPolicyConfig; policy: runner.LocalPolicy } {
    const mock = vi.mocked(runner.createLocalPolicy);
    const index = mock.mock.calls.map((c) => c[0]).findLastIndex((c) => c.auditFailed !== undefined);
    return { config: mock.mock.calls[index]![0], policy: mock.mock.results[index]!.value as runner.LocalPolicy };
  }
  const decide = (policy: runner.LocalPolicy, pluginId: string) =>
    policy.decidePermission({
      appId: "app-a", agentId: "claude", sessionId: "s1", cwd: "/w", toolCallId: "t1", toolName: "mcp__srv__read", options: OPTIONS,
      origin: { kind: "plugin", pluginId, contained: true, headless: true, callsLeft: 3, allow: SET },
    });

  it("a contained decision is approved only while its plugin's audit log is known and healthy: a plugin with no log is cancelled", async () => {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    const plugin = { manifest: { id: "demo.sync", app: "app-a", entry: "entry.js", permissions: { agents: ["claude"] } }, appId: "app-a", version: "1.0.0", installDir: "/x", dataDir: "/y", status: "stopped" } as runner.InstalledPlugin;
    const pluginHost: runner.PluginHost = {
      install: async () => { throw new Error("unused"); },
      list: async () => [plugin],
      remove: async () => {},
      revoke: async () => {},
      start: async () => {},
      stopAll: async () => {},
      router: { handles: () => false, request: async () => null, notify: () => {}, subscribe: () => () => {} },
      setBroker: () => {},
    };
    await start(h, [a], { pluginHost, adapters: [fakeAdapter().adapter] });
    const { policy } = builtPolicy();
    expect(await decide(policy, "demo.sync")).toEqual({ action: "select", optionId: "once" });
    expect(await decide(policy, "ghost.plugin")).toEqual({ action: "cancel" });
  });

  it("passes the app's agent.model: with a models list, a session that names none is admitted only when that model is on it", async () => {
    h = await harness();
    const good = await appFixture(h, "app-a", "runner-a");
    const bad = await appFixture(h, "app-b", "runner-b");
    await mkdir(path.join(h.deps.configDir, "bridge"), { recursive: true });
    await writeFile(path.join(h.deps.configDir, "bridge", "policy.json"), JSON.stringify({ models: ["sonnet"], allowedCwds: [home()] }));
    await mkdir(home(), { recursive: true });
    for (const [id, model] of [["app-a", "sonnet"], ["app-b", "opus"]] as const) {
      await mkdir(path.dirname(appPathsOf(h.deps, id).configFile), { recursive: true });
      await writeFile(appPathsOf(h.deps, id).configFile, JSON.stringify({ agent: { model } }));
    }
    vi.mocked(runner.createLocalPolicy).mockClear();
    const handle = await startRunner(runnerDeps(h, { adapters: [fakeAdapter().adapter] }), [good.record, bad.record], { e2ee: false });
    cleanups.push(() => handle.stop());
    const mock = vi.mocked(runner.createLocalPolicy);
    const effective = mock.mock.calls.map((c, i) => ({ config: c[0], policy: mock.mock.results[i]!.value as runner.LocalPolicy })).filter((c) => c.config.auditFailed !== undefined);
    expect(effective.map((e) => e.config.agentModel)).toEqual(["sonnet", "opus"]);
    const verdicts = await Promise.all(effective.map((e, i) => e.policy.allowContainedSession!({ appId: i === 0 ? "app-a" : "app-b", agentId: "claude" })));
    expect(verdicts.map((v) => v.allowed)).toEqual([true, false]);
  });
});

describe("a contained plugin session through the runner's proxy", () => {
  const PLUGIN_ID = "demo.sync";
  const TOOL = "mcp__stub__read";
  const ITEM = { name: "stub", entry: "mcp.js", args: [] as string[] };

  /** A claude-shaped adapter in memory: it has a containment profile and answers `session/new` with the profile's own parameters. */
  function containedAdapter() {
    const base = fakeAdapter("claude");
    const spawns: runner.AgentSpawnOptions[] = [];
    const profile: runner.ContainmentProfile = { ...runner.claudeProfileOf(runner.CLAUDE_MEASURED_STACKS[0]!), checkNewSession: () => undefined };
    const adapter: AgentAdapter = {
      ...base.adapter,
      containment: () => profile,
      async spawn(options) {
        spawns.push(options);
        return { ...(await base.adapter.spawn(options)), sessionNew: { mcpServers: [], _meta: {} } };
      },
    };
    return { adapter, spawns };
  }

  async function fixture() {
    h = await harness();
    const a = await appFixture(h, "app-a", "runner-a");
    /** The broker `runRun` hands the plugin host per app: the one a plugin starts its sessions through. */
    const brokers = new Map<string, runner.AgentSessionBroker>();
    const installDir = path.join(h.root, "plugin-install", PLUGIN_ID, "1.0.0");
    const dataDir = path.join(h.root, "plugin-data", PLUGIN_ID);
    const plugin = { manifest: { id: PLUGIN_ID, app: "app-a", entry: "entry.js", permissions: { agents: ["claude"] } }, appId: "app-a", version: "1.0.0", installDir, dataDir, status: "stopped" } as runner.InstalledPlugin;
    const pluginHost: runner.PluginHost = {
      install: async () => { throw new Error("unused"); },
      list: async () => [plugin],
      remove: async () => {},
      revoke: async () => {},
      start: async () => {},
      stopAll: async () => {},
      router: { handles: () => false, request: async () => null, notify: () => {}, subscribe: () => () => {} },
      setBroker: (appId, broker) => void brokers.set(appId, broker),
    };
    const surface = {
      items: [
        { kind: "mcpServer" as const, value: JSON.stringify(ITEM) },
        { kind: "headlessTool" as const, value: TOOL },
      ],
    };
    /** What the plugin host's broker hands the proxy: servers built from the grant, the grant itself, the hash of its surface. */
    const requestFor = (over: Partial<runner.AgentSessionBrokerRequest> & { pluginId?: string; surfaceSha256?: string } = {}): runner.AgentSessionBrokerRequest => {
      const { pluginId = PLUGIN_ID, surfaceSha256 = runner.surfaceSha256Of(surface), ...rest } = over;
      return {
        pluginId,
        appId: "app-a",
        agent: "claude",
        mcpServers: ["stub"],
        servers: [runner.resolveGrantedServer(ITEM, process.execPath, { installDir, dataDir })!],
        tools: { allow: [TOOL], builtins: "none" },
        grant: { pluginId, appId: "app-a", version: "1.0.0", surface, surfaceSha256, time: "2026-11-03T00:00:00.000Z" },
        ...rest,
      };
    };
    return { a, pluginHost, installDir, requestFor, brokers };
  }

  it("starts in the app's sessions dir, from the installed plugin's own dirs and the hash the consent module computes", async () => {
    const { a, pluginHost, installDir, requestFor } = await fixture();
    const agent = containedAdapter();
    const handle = await start(h!, [a], { pluginHost, adapters: [agent.adapter] });

    const session = await handle.proxy("app-a")!.broker.start(requestFor());
    cleanups.push(() => session.close());

    expect(agent.spawns).toHaveLength(1);
    expect(agent.spawns[0]!.cwd).toBe(path.join(appPathsOf(h!.deps, "app-a").sessionsDir, session.sessionId));
    expect(agent.spawns[0]!.containment).toMatchObject({
      sessionId: session.sessionId,
      allow: [TOOL],
      servers: [{ name: "stub", command: process.execPath, args: [path.join(installDir, ITEM.entry)] }],
    });
  });

  it("launches with the model it was admitted with: a request naming none gets the app's agent.model, one outside the models list is refused", async () => {
    const { a, pluginHost, requestFor } = await fixture();
    await mkdir(path.join(h!.deps.configDir, "bridge"), { recursive: true });
    await writeFile(path.join(h!.deps.configDir, "bridge", "policy.json"), JSON.stringify({ models: ["sonnet"], allowedCwds: [home()] }));
    await mkdir(home(), { recursive: true });
    await mkdir(path.dirname(appPathsOf(h!.deps, "app-a").configFile), { recursive: true });
    await writeFile(appPathsOf(h!.deps, "app-a").configFile, JSON.stringify({ agent: { model: "sonnet" } }));
    const agent = containedAdapter();
    // `start` would rewrite policy.json; the models list must stay.
    const handle = await startRunner(runnerDeps(h!, { pluginHost, adapters: [agent.adapter] }), [a.record], { e2ee: false });
    cleanups.push(() => handle.stop());
    const broker = handle.proxy("app-a")!.broker;

    const session = await broker.start(requestFor());
    cleanups.push(() => session.close());
    expect(agent.spawns).toHaveLength(1);
    expect(agent.spawns[0]!.containment).toMatchObject({ model: "sonnet" });

    await expect(broker.start(requestFor({ model: "opus" }))).rejects.toMatchObject({ code: PROXY_ERROR.sessionNotAllowed });
    expect(agent.spawns).toHaveLength(1);
  });

  it("refuses what the consented grant does not back: a hash that is not the surface's, and a plugin that is not installed", async () => {
    const { a, pluginHost, requestFor } = await fixture();
    const agent = containedAdapter();
    const handle = await start(h!, [a], { pluginHost, adapters: [agent.adapter] });
    const broker = handle.proxy("app-a")!.broker;

    // The real `surfaceSha256Of` is wired in: a stand-in that accepts any hash would let this through.
    await expect(broker.start(requestFor({ surfaceSha256: "0".repeat(64) }))).rejects.toMatchObject({ code: -32602 });
    await expect(broker.start(requestFor({ pluginId: "ghost.plugin" }))).rejects.toMatchObject({ code: PROXY_ERROR.containmentUnavailable });
    expect(agent.spawns).toHaveLength(0);
  });

  it("feeds the plugin's one audit log: the object the runner built for it is the one the session ends on", async () => {
    const { a, pluginHost, requestFor } = await fixture();
    const agent = containedAdapter();
    vi.mocked(runner.createAuditLog).mockClear();
    const handle = await start(h!, [a], { pluginHost, adapters: [agent.adapter] });
    const mock = vi.mocked(runner.createAuditLog);
    const index = mock.mock.calls.findIndex((c) => path.basename(c[0]) === `${PLUGIN_ID}.jsonl`);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(mock.mock.calls.filter((c) => path.basename(c[0]) === `${PLUGIN_ID}.jsonl`)).toHaveLength(1);
    const log = mock.mock.results[index]!.value as runner.FileAuditLog;
    const ended = vi.spyOn(log, "endSession");

    const session = await handle.proxy("app-a")!.broker.start(requestFor());
    await session.close();

    expect(ended).toHaveBeenCalledWith(session.sessionId);
  });
  describe("the idle stop counts open plugin sessions as activity", () => {
    const MIN = 60_000;

    async function runIdle() {
      const { a, pluginHost, requestFor, brokers } = await fixture();
      await allowHomeCwd(h!);
      await upsertApp(h!.deps, a.record);
      const agent = containedAdapter();
      const clock = manualClock();
      const abort = new AbortController();
      let result: number | undefined;
      const done = runRun(["--no-e2ee"], runnerDeps(h!, { signal: abort.signal, now: clock.now, pluginHost, adapters: [agent.adapter] }), { idle: { timers: clock.timers } }).then((c) => (result = c));
      cleanups.push(async () => { abort.abort(); await done; });
      await until(() => h!.out.join("").includes("[app-a] online"));
      return { clock, requestFor, broker: brokers.get("app-a")!, result: () => result };
    }

    it.each([
      ["a contained session with a 1 h budget", (requestFor: Awaited<ReturnType<typeof fixture>>["requestFor"]): runner.AgentSessionBrokerRequest => requestFor({ budget: { wallClockMs: 60 * MIN } })],
      ["a plugin session that is not contained and has no browser behind it", (): runner.AgentSessionBrokerRequest => ({ pluginId: PLUGIN_ID, appId: "app-a", agent: "claude", cwd: home() })],
    ])("%s, with no browser connected: the runner is up past IDLE_STOP_MS, and stops IDLE_STOP_MS after the session ends", async (_name, build) => {
      const run = await runIdle();
      const session = await run.broker.start(build(run.requestFor));
      cleanups.push(() => session.close());

      await run.clock.advance(IDLE_STOP_MS + 5 * MIN);
      expect(run.result()).toBeUndefined();
      await until(async () => (await readRunnerStatus(h!.deps))?.idleSince === undefined);
      await run.clock.advance(30 * MIN);
      expect(run.result()).toBeUndefined();

      await session.close();
      await until(async () => (await readRunnerStatus(h!.deps))?.idleSince !== undefined);
      await run.clock.advance(IDLE_STOP_MS - MIN);
      expect(run.result()).toBeUndefined();
      await run.clock.advance(2 * MIN);
      await until(() => run.result() !== undefined);
      expect(run.result()).toBe(0);
    }, 30000);

    it("a session that fails to start leaves no count behind: the runner idles out on time", async () => {
      const run = await runIdle();
      await expect(run.broker.start(run.requestFor({ pluginId: "ghost.plugin" }))).rejects.toMatchObject({ code: PROXY_ERROR.containmentUnavailable });
      await run.clock.advance(IDLE_STOP_MS + MIN);
      await until(() => run.result() !== undefined);
      expect(run.result()).toBe(0);
    }, 30000);
  });
});

describe("a local app: an app with no link", () => {
  const PLUGIN_ID = "demo.local";
  const TOOL = "mcp__stub__read";
  const ITEM = { name: "stub", entry: "mcp.js", args: [] as string[] };
  const MIN = 60_000;
  const local = (appId = "sample-app"): LocalAppRecord => ({ kind: "local", appId, name: "Sample app", origin: "local", createdAt: "2026-11-04T00:00:00.000Z" });

  /** A claude-shaped adapter in memory with a containment profile (as the contained-session tests above build). */
  function containedAdapter() {
    const base = fakeAdapter("claude");
    const spawns: runner.AgentSpawnOptions[] = [];
    const profile: runner.ContainmentProfile = { ...runner.claudeProfileOf(runner.CLAUDE_MEASURED_STACKS[0]!), checkNewSession: () => undefined };
    const adapter: AgentAdapter = {
      ...base.adapter,
      containment: () => profile,
      async spawn(options) {
        spawns.push(options);
        return { ...(await base.adapter.spawn(options)), sessionNew: { mcpServers: [], _meta: {} } };
      },
    };
    return { adapter, spawns };
  }

  /** A plugin host stub with one plugin installed for `appId`; it records what the runner asks of it. */
  function hostFor(appId: string) {
    const installDir = path.join(h!.root, "plugin-install", PLUGIN_ID, "1.0.0");
    const dataDir = path.join(h!.root, "plugin-data", PLUGIN_ID);
    const plugin = { manifest: { id: PLUGIN_ID, app: appId, entry: "entry.js", permissions: { agents: ["claude"] } }, appId, version: "1.0.0", installDir, dataDir, status: "stopped" } as runner.InstalledPlugin;
    const started: string[] = [];
    const brokers = new Map<string, runner.AgentSessionBroker>();
    const pluginHost: runner.PluginHost = {
      install: async () => { throw new Error("unused"); },
      list: async () => [plugin],
      remove: async () => {},
      revoke: async () => {},
      start: async (id) => void started.push(id!),
      stopAll: async () => {},
      router: { handles: () => true, request: async () => "plugin answered", notify: () => {}, subscribe: () => () => {} },
      setBroker: (id, broker) => void brokers.set(id, broker),
    };
    const surface = { items: [{ kind: "mcpServer" as const, value: JSON.stringify(ITEM) }, { kind: "headlessTool" as const, value: TOOL }] };
    const request = (): runner.AgentSessionBrokerRequest => ({
      pluginId: PLUGIN_ID,
      appId,
      agent: "claude",
      mcpServers: ["stub"],
      servers: [runner.resolveGrantedServer(ITEM, process.execPath, { installDir, dataDir })!],
      tools: { allow: [TOOL], builtins: "none" },
      grant: { pluginId: PLUGIN_ID, appId, version: "1.0.0", surface, surfaceSha256: runner.surfaceSha256Of(surface), time: "2026-11-04T00:00:00.000Z" },
    });
    return { pluginHost, started, brokers, request };
  }

  /** Spies for everything a link would use: the relay socket, the network and the credential store. */
  function linkSpies() {
    const calls: string[] = [];
    const socket = ((url: string) => { calls.push(`socket ${url}`); throw new Error("a local app opens no socket"); }) as unknown as NonNullable<CliDeps["socket"]>;
    const fetch = (async (input: unknown) => { calls.push(`fetch ${String(input)}`); throw new Error("a local app uses no network"); }) as unknown as CliDeps["fetch"];
    const credentials: NonNullable<CliDeps["credentials"]> = {
      get: async (k) => (calls.push(`get ${k}`), null),
      set: async (k) => void calls.push(`set ${k}`),
      delete: async (k) => void calls.push(`delete ${k}`),
    };
    return { calls, socket, fetch, credentials };
  }

  const listeners = (): number => process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap").length;

  it("is served with no link: no socket, no network, no credential read; it reads `local` in statuses() and runner.json, its plugins start and a contained headless session runs and is audited under its auditDir", async () => {
    h = await harness();
    await allowHomeCwd(h);
    const spies = linkSpies();
    const { pluginHost, started, brokers, request } = hostFor("sample-app");
    const agent = containedAdapter();
    const servers = listeners();
    vi.mocked(runner.createAuditLog).mockClear();
    const handle = await startRunner(runnerDeps(h, { socket: spies.socket, fetch: spies.fetch, credentials: spies.credentials, pluginHost, adapters: [agent.adapter] }), [local()], { e2ee: true });
    cleanups.push(() => handle.stop());

    expect(handle.statuses()).toEqual({ "sample-app": "local" });
    expect(handle.link("sample-app")).toBeUndefined();
    await until(async () => (await readRunnerStatus(h!.deps))?.apps?.["sample-app"] === "local");
    expect(JSON.parse(await readFile(statusFilePath(h.deps), "utf8"))).toMatchObject({ version: 1, apps: { "sample-app": "local" }, browsers: 0 });
    expect(started).toEqual(["sample-app"]);
    expect([...brokers.keys()]).toEqual(["sample-app"]);
    expect(await handle.settled).toBeUndefined();

    // The plugin's contained headless session goes through the same broker and proxy as any app's.
    const session = await brokers.get("sample-app")!.start(request());
    expect(agent.spawns).toHaveLength(1);
    const paths = appPathsOf(h.deps, "sample-app");
    expect(agent.spawns[0]!.cwd).toBe(path.join(paths.sessionsDir, session.sessionId));
    // The plugin's one audit log is opened under this app's own auditDir, and the session ends on that object.
    const auditFile = runner.auditFilesOf(paths, PLUGIN_ID)[0]!;
    expect(path.dirname(auditFile)).toBe(paths.auditDir);
    const mock = vi.mocked(runner.createAuditLog);
    const index = mock.mock.calls.findIndex((c) => c[0] === auditFile);
    expect(index).toBeGreaterThanOrEqual(0);
    const ended = vi.spyOn(mock.mock.results[index]!.value as runner.FileAuditLog, "endSession");
    await session.close();
    expect(ended).toHaveBeenCalledWith(session.sessionId);

    expect(spies.calls).toEqual([]);
    expect(tokenKey("sample-app")).toBe("sample-app/pairing.tokens");
    expect(listeners()).toBe(servers);
    await handle.stop();
    expect(await exists(statusFilePath(h.deps))).toBe(false);
  });

  it("keeps the runner up: past IDLE_STOP_MS (with a plugin session open or not) idle stays pending, idleSince is absent and no idle timer is armed", async () => {
    h = await harness();
    await allowHomeCwd(h);
    const { pluginHost, brokers, request } = hostFor("sample-app");
    const clock = manualClock();
    const handle = await startRunner(runnerDeps(h, { now: clock.now, pluginHost, adapters: [containedAdapter().adapter] }), [local()], { e2ee: false, idle: { timers: clock.timers } });
    cleanups.push(() => handle.stop());
    let idled = false;
    void handle.idle.then(() => (idled = true));
    await until(async () => (await readRunnerStatus(h!.deps)) !== undefined);
    expect(clock.pending()).toBe(0);

    await clock.advance(IDLE_STOP_MS * 2);
    expect(idled).toBe(false);
    expect((await readRunnerStatus(h.deps))?.idleSince).toBeUndefined();

    // A session coming and going does not start an idle period either.
    const session = await brokers.get("sample-app")!.start(request());
    await session.close();
    await new Promise((r) => setTimeout(r, 20));
    await clock.advance(IDLE_STOP_MS * 2);
    expect(idled).toBe(false);
    expect((await readRunnerStatus(h.deps))?.idleSince).toBeUndefined();
    expect(clock.pending()).toBe(0);
    await handle.stop();
  });

  it("bridge run with only a local app: says so, stays up on its own, exits 0 on a signal and never prints a will-not-be-retried line", async () => {
    h = await harness();
    await allowHomeCwd(h);
    await upsertApp(h.deps, local());
    const spies = linkSpies();
    const abort = new AbortController();
    const { pluginHost } = hostFor("sample-app");
    let result: number | undefined;
    const done = runRun([], runnerDeps(h, { signal: abort.signal, socket: spies.socket, fetch: spies.fetch, credentials: spies.credentials, pluginHost, adapters: [containedAdapter().adapter] })).then((c) => (result = c));
    cleanups.push(async () => { abort.abort(); await done; });
    await until(() => h!.err.join("").includes("Bridge runner started"));
    expect(h.err.join("")).toContain("Connected apps: Sample app (local). It stays up until stopped: a local app is served.");
    expect(h.err.join("")).not.toContain("will not be retried");
    expect(h.err.join("")).not.toContain("no browser is trusted");
    await new Promise((r) => setTimeout(r, 50));
    expect(result).toBeUndefined();
    abort.abort();
    await done;
    expect(result).toBe(0);
    expect(h.err.join("")).not.toContain("will not be retried");
    expect(h.out.join("")).not.toMatch(/connecting|online/);
    expect(spies.calls).toEqual([]);
  });

  it("bridge run with no app at all points at both ways to make one", async () => {
    h = await harness();
    expect(await runRun([], runnerDeps(h))).toBe(1);
    expect(h.err.join("")).toContain("no app is connected and no local app exists; run `bridge connect <app-url>` or `bridge apps add-local <app-id>` first");
  });

  describe("beside a hosted app", () => {
    it("the hosted link comes online and the local app reads `local`; a hosted app's idle stop is held off for as long as the local app is served", async () => {
      h = await harness();
      const a = await appFixture(h, "app-a", "runner-a");
      const clock = manualClock();
      await allowHomeCwd(h);
      const handle = await startRunner(runnerDeps(h, { now: clock.now, adapters: [fakeAdapter().adapter] }), [a.record, local()], { e2ee: false, idle: { timers: clock.timers } });
      cleanups.push(() => handle.stop());
      await until(() => handle.statuses()["app-a"] === "online");
      expect(handle.statuses()).toEqual({ "app-a": "online", "sample-app": "local" });
      expect(handle.link("app-a")).toBeDefined();
      expect(handle.link("sample-app")).toBeUndefined();
      let idled = false;
      void handle.idle.then(() => (idled = true));
      await clock.advance(IDLE_STOP_MS * 2);
      expect(idled).toBe(false);
    });

    it("a browser of the hosted app cannot reach the local app's plugins nor start a session in its folders", async () => {
      h = await harness();
      const a = await appFixture(h, "app-a", "runner-a");
      const agent = fakeAdapter();
      const { pluginHost } = hostFor("sample-app");
      await mkdir(home(), { recursive: true });
      await mkdir(path.join(h.deps.configDir, "bridge"), { recursive: true });
      await writeFile(path.join(h.deps.configDir, "bridge", "policy.json"), JSON.stringify({ allowedCwds: [home()] }));
      const pl = appPathsOf(h.deps, "sample-app");
      const pa = appPathsOf(h.deps, "app-a");
      for (const d of [pl.workDir, pl.configDir, pl.dataDir, pa.workDir]) await mkdir(d, { recursive: true });
      const handle = await startRunner(runnerDeps(h, { pluginHost, adapters: [agent.adapter] }), [a.record, local()], { e2ee: false });
      cleanups.push(() => handle.stop());
      await until(() => handle.statuses()["app-a"] === "online");
      const browser = await new TestBrowser(a, "browser-1").open();

      // The local app's plugin id is no extension of app-a: the proxy refuses it like an unknown id, though the host would answer.
      expect((await browser.request(`_${PLUGIN_ID}/ping`)).error).toMatchObject({ code: PROXY_ERROR.extensionNotFound });
      // Its folders are not app-a's to start in, by any path; app-a's own work folder is.
      for (const cwd of [pl.workDir, pl.configDir, pl.dataDir, pl.stateDir, path.join(pl.workDir, "sub")]) {
        expect((await browser.request("session/new", { cwd })).error, cwd).toBeDefined();
      }
      expect(await browser.request("session/new", { cwd: pa.workDir })).toHaveProperty("result");
    });

    it("protects the local app's three bridge/ dirs like any app's, and its paths are apart from every hosted app's", async () => {
      h = await harness();
      const a = await appFixture(h, "app-a", "runner-a");
      const b = await appFixture(h, "app-b", "runner-b");
      await upsertApp(h.deps, a.record);
      await upsertApp(h.deps, b.record);
      await upsertApp(h.deps, local());
      const mine = appPathsOf(h.deps, "sample-app");
      expect(await protectedPathsOf(h.deps, [a.record, local()])).toEqual(expect.arrayContaining([mine.configDir, mine.dataDir, mine.stateDir]));

      for (const hosted of [a.record, b.record]) {
        const theirs = appPathsOf(h.deps, hosted.appId);
        const fields = Object.entries(mine).filter(([, v]) => typeof v === "string" && path.isAbsolute(v)).map(([k]) => k);
        expect(fields.length).toBeGreaterThan(5);
        for (const field of fields) {
          expect(relation((mine as unknown as Record<string, string>)[field]!, (theirs as unknown as Record<string, string>)[field]!), `${field} of sample-app against ${hosted.appId}`).toBe("apart");
        }
        for (const [k, v] of Object.entries(mine.parents)) expect(relation(v, (theirs.parents as Record<string, string>)[k]!), `parents.${k}`).toBe("apart");
      }
      expect((await layoutOf(h.deps)).overlap).toBeUndefined();
    });

    it("refuses to start when the local app's bridge/ dir is a link into a hosted app's folder (rule A)", async () => {
      h = await harness();
      const a = await appFixture(h, "app-a", "runner-a");
      await upsertApp(h.deps, a.record);
      await upsertApp(h.deps, local());
      const mine = appPathsOf(h.deps, "sample-app");
      await rm(mine.configDir, { recursive: true, force: true });
      await symlink(appPathsOf(h.deps, "app-a").configDir, mine.configDir);
      await expect(assertLayout(h.deps, "run", ["app-a", "sample-app"])).rejects.toThrow(/overlap/);
      await expect(startRunner(runnerDeps(h, { adapters: [fakeAdapter().adapter] }), [a.record, local()], { e2ee: false })).rejects.toThrow(/overlap/);
      expect(await exists(statusFilePath(h.deps))).toBe(false);
    });
  });
});

describe("countSessions", () => {
  const request = { pluginId: "p", appId: "app-a", agent: "claude" } as runner.AgentSessionBrokerRequest;

  it("counts a session from its start to its end, and not twice", async () => {
    let n = 0;
    let end!: (v: { reason: "closed" }) => void;
    const ended = new Promise<{ reason: "closed" }>((r) => (end = r));
    const session = { sessionId: "s1", prompt: async () => ({ stopReason: "end_turn", text: "" }), cancel: async () => {}, close: async () => end({ reason: "closed" }), ended } as unknown as runner.BrokeredSession;
    const broker = countSessions({ start: async () => session }, () => void n++, () => void n--);
    const started = broker.start(request);
    expect(n).toBe(1);
    expect(await started).toBe(session);
    expect(n).toBe(1);
    await session.close();
    await until(() => n === 0);
    end({ reason: "closed" });
    await new Promise((r) => setTimeout(r, 10));
    expect(n).toBe(0);
  });

  it("a start that throws is not counted", async () => {
    let n = 0;
    const broker = countSessions({ start: async () => { throw new Error("refused"); } }, () => void n++, () => void n--);
    await expect(broker.start(request)).rejects.toThrow("refused");
    expect(n).toBe(0);
  });

  it("a session that reports no end is over at its close()", async () => {
    let n = 0;
    const calls: string[] = [];
    const session = {
      sessionId: "s2",
      prompt: async (text: string) => (calls.push(text), { stopReason: "end_turn", text: "ok" }),
      cancel: async () => void calls.push("cancel"),
      close: async (reason?: "plugin_gone") => void calls.push(`close:${reason ?? ""}`),
    } as runner.BrokeredSession;
    const broker = countSessions({ start: async () => session }, () => void n++, () => void n--);
    const counted = await broker.start(request);
    expect(n).toBe(1);
    expect(counted.sessionId).toBe("s2");
    expect(await counted.prompt("hi")).toMatchObject({ text: "ok" });
    await counted.cancel();
    await counted.close("plugin_gone");
    await counted.close();
    expect(n).toBe(0);
    expect(calls).toEqual(["hi", "cancel", "close:plugin_gone", "close:"]);
  });
});

// --- a relay that refuses the runner, or never answers it -------------

interface FakeRelay {
  record: HostedAppRecord;
  /** How many upgrade requests the relay has seen. */
  attempts: () => number;
}

/** A relay that answers every runner upgrade with HTTP 403 (a revoked runner id), or takes it and never finishes the handshake. */
async function brokenRelay(h: Harness, mode: "refuse" | "hang"): Promise<FakeRelay> {
  let attempts = 0;
  const sockets = new Set<Duplex>();
  const server: Server = createServer((_req, res) => void res.writeHead(404).end());
  server.on("upgrade", (_req, socket) => {
    attempts += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (mode === "refuse") socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { issuer: "https://idp.example", clientId: "c", deviceAuthorizationEndpoint: "https://idp.example/d", tokenEndpoint: "https://idp.example/t" };
  const record: HostedAppRecord = { appId: "app-a", name: "App app-a", url, origin: url, relayUrl: `${url.replace("http", "ws")}/relay`, auth, protocol: { min: 1, max: 1 }, runnerId: "runner-a", connectedAt: "2026-10-14T00:00:00.000Z" };
  await saveTokens(h.deps.credentials!, { accessToken: "rt-app-a", tokenType: "Bearer" }, tokenKey("app-a"));
  await upsertApp(h.deps, record);
  return { record, attempts: () => attempts };
}

describe("a runner the relay refuses or cannot finish a handshake with", () => {
  const BACKOFF = { baseMs: 1000, maxMs: 30_000 };

  /**
   * `bridge run` against the broken relay, on virtual time: the backoff sleeps return at once but add up, so a minute of
   * the service's life takes a moment. `elapsed()` is the virtual time passed; `sleeps` the backoff steps taken.
   */
  async function runAgainst(mode: "refuse" | "hang") {
    h = await harness();
    const relay = await brokenRelay(h, mode);
    const abort = new AbortController();
    let result: number | undefined;
    let elapsed = 0;
    const sleeps: number[] = [];
    const linkClock = manualClock();
    const intervals = vi.spyOn(globalThis, "setInterval");
    cleanups.push(() => intervals.mockRestore());
    const deps = runnerDeps(h, {
      signal: abort.signal,
      adapters: [fakeAdapter().adapter],
      backoff: BACKOFF,
      random: () => 1,
      sleep: async (ms) => {
        sleeps.push(ms);
        elapsed += ms;
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    // A handshake that never finishes ends by the link's own 15 s timer: that clock is manual too.
    const done = runRun(["--no-e2ee"], deps, mode === "hang" ? { linkTimers: linkClock.timers } : {}).then((c) => (result = c));
    cleanups.push(async () => { abort.abort(); await done; });
    return { relay, abort, done, result: () => result, elapsed: () => elapsed, sleeps, linkClock, intervals };
  }

  const refusalLines = (): string[] => h!.err.join("").split("\n").filter((l) => l.includes("[app-a] warn: relay connection failed"));

  it("403 on every attempt: logs the refusal at each backoff step with its reason, stays up for a minute of backoff, parks nothing, and keeps the event loop held", async () => {
    const run = await runAgainst("refuse");
    await until(() => run.elapsed() >= 60_000, 15000);
    expect(run.relay.attempts()).toBeGreaterThanOrEqual(4);
    expect(run.result()).toBeUndefined();

    const lines = refusalLines();
    // One line per backoff step (the step in flight may not have logged yet or may have just logged).
    expect(Math.abs(lines.length - run.sleeps.length)).toBeLessThanOrEqual(1);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    lines.slice(0, 4).forEach((line, i) => {
      expect(line).toContain("the relay refused the connection");
      expect(line).toContain(`attempt ${i + 1})`);
    });
    expect(lines[0]).toContain("retrying in 1 s");
    // The way back for a refusal no mark can cover is named at every step.
    expect(lines.every((l) => l.includes("lists this machine as revoked, run `bridge apps remove app-a` and then `bridge setup "))).toBe(true);
    // A refusal at the upgrade is not the relay's word `revoked`: no mark.
    expect(existsSync(appPathsOf(h!.deps, "app-a").revokedFile)).toBe(false);
    expect(lines[1]).toContain("retrying in 2 s");
    // The backoff grows to its cap; nothing is final.
    expect(run.sleeps.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(run.sleeps.every((ms) => ms <= BACKOFF.maxMs)).toBe(true);
    expect(h!.err.join("")).not.toContain("will not be retried");
    // Node exits 13 ("unsettled top-level await") when nothing holds the loop: a ref'd interval must, while the link is still retrying.
    expect(run.intervals.mock.results.map((r) => r.value as NodeJS.Timeout).filter((t) => t.hasRef()).length).toBeGreaterThan(0);

    run.abort.abort();
    expect(await run.done).toBe(0);
    expect(run.result()).not.toBe(13);
  }, 30000);

  it("Node 22's refusal (an error and no close at the upgrade) is logged as a refusal at once, not as a timeout", async () => {
    h = await harness();
    await brokenRelay(h, "refuse");
    const abort = new AbortController();
    const linkClock = manualClock();
    let opened = 0;
    // What Node 22's global WebSocket does on a 403: fire `error` and never `close`.
    const socket = (_url: string, _init: unknown) => {
      opened += 1;
      const listeners: Record<string, ((e: never) => void)[]> = {};
      const sock = {
        readyState: 0,
        send: () => undefined,
        close: () => undefined,
        addEventListener: (type: string, l: (e: never) => void) => { (listeners[type] ??= []).push(l); },
      };
      queueMicrotask(() => { for (const l of listeners.error ?? []) l({} as never); });
      return sock;
    };
    const deps = runnerDeps(h, { signal: abort.signal, adapters: [fakeAdapter().adapter], backoff: BACKOFF, random: () => 1, socket: socket as never, sleep: async () => { await new Promise((r) => setTimeout(r, 5)); } });
    const done = runRun(["--no-e2ee"], deps, { linkTimers: linkClock.timers });
    cleanups.push(async () => { abort.abort(); await done; });
    // The link clock never advances, so the 15 s connect timer cannot be what ended these attempts.
    await until(() => refusalLines().length >= 3, 8000);
    expect(opened).toBeGreaterThanOrEqual(3);
    expect(refusalLines().every((l) => l.includes("the relay refused the connection") && !l.includes("did not answer"))).toBe(true);
    abort.abort();
    expect(await done).toBe(0);
  }, 30000);

  it("a handshake that never finishes: the same, the reason says the relay did not answer", async () => {
    const run = await runAgainst("hang");
    // Each attempt waits out the link's 15 s connect timer (manual here), then backs off.
    for (let i = 0; i < 12 && run.elapsed() < 60_000; i++) {
      await until(() => run.linkClock.pending() > 0, 8000);
      await run.linkClock.advance(15_001);
    }
    expect(run.elapsed()).toBeGreaterThanOrEqual(60_000);
    expect(run.relay.attempts()).toBeGreaterThanOrEqual(4);
    expect(run.result()).toBeUndefined();
    const lines = refusalLines();
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.every((l) => l.includes("the relay did not answer in time"))).toBe(true);
    expect(run.intervals.mock.results.map((r) => r.value as NodeJS.Timeout).filter((t) => t.hasRef()).length).toBeGreaterThan(0);

    run.abort.abort();
    expect(await run.done).toBe(0);
  }, 30000);
});
