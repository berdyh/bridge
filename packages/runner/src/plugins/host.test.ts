import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdtemp, mkdir, readdir, readFile, writeFile, rm, stat, symlink, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonRpcMessage } from "@berdyh/bridge-protocol";
import { containedRequestProblem, parseGrantedMcpServer, PROXY_ERROR, resolveGrantedServer } from "../acp/contracts.js";
import { surfaceOf, surfaceSha256Of } from "./consent.js";
import { createPluginHost, type PluginHostWithGrants } from "./host.js";
import type { ConsentedGrant, PermissionSummary, PluginHost } from "./contracts.js";
import { appPathsOf } from "../paths.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

const consent = { confirm: async () => true };
const caller = { appId: "app-a", channelId: "a", browserKeyId: "browser-a" };
/** The `onBehalfOf` a plugin sends: the wire takes {appId, browserKeyId} and refuses any other key. */
const who = ({ appId, browserKeyId }: { appId: string; browserKeyId: string }) => ({ appId, browserKeyId });
// Deliberately uses raw JSON-RPC, independent of the SDK implementation.
const entry = `
import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
const pending = new Map(); let seq = 0;
const ask = (method,params) => new Promise((resolve,reject) => { const id = ++seq; pending.set(id,{resolve,reject}); send({id,method,params}); });
createInterface({input:process.stdin}).on('line', async line => {
 const m = JSON.parse(line);
 if (!m.method) { const p = pending.get(m.id); if(p) {pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result);} return; }
 if(m.method !== 'plugin/call') return;
 const {method,params,caller,callToken} = m.params;
 try {
 let result = params;
 if(method.endsWith('/env')) result = process.env;
 if(method.endsWith('/crash')) process.exit(12);
 if(method.endsWith('/hang')) return;
 if(method.endsWith('/broker')) result = await ask('host/startAgentSession',{...params,callToken});
 if(method.endsWith('/ui')) send({method:'host/localUi',params});
 if(method.endsWith('/session')) result = await ask(params.method,params.params);
 if(method.endsWith('/push')) {send({method:'_alpha/update',params});send({method:'_beta/update',params});send({method:'session/request_permission',params});}
 send({id:m.id,result:result ?? null});
 } catch(error) {send({id:m.id,error:{code:error.code ?? -32603,message:error.message}});}
});
send({method:'plugin/ready',params:{}});
`;
let temp: string;
let hosts: PluginHost[];
async function source(id = "alpha", app = "app-a", version = "1.0.0", permissions: Record<string, unknown> = {}): Promise<string> {
  const dir = path.join(temp, `${id}-${version}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module", version }));
  await writeFile(path.join(dir, "bridge-plugin.json"), JSON.stringify({ id, app, entry: "entry.js", permissions }));
  await writeFile(path.join(dir, "entry.js"), entry);
  return dir;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
/** The base dirs of the tests: plugins of `app-a` land in `<temp>/base/app-a/bridge/plugins`. */
const baseOf = () => ({ config: path.join(temp, "cfg"), data: path.join(temp, "base"), state: path.join(temp, "st") });
function host(options: Partial<Parameters<typeof createPluginHost>[0]> = {}): PluginHostWithGrants {
  const result = createPluginHost({ apps: ["app-a", "app-b"].map((id) => appPathsOf(baseOf(), id)), restartDelayMs: 20, stopTimeoutMs: 50, ...options });
  hosts.push(result);
  return result;
}
beforeEach(async () => { temp = await mkdtemp(fileURLToPath(new URL(".test-", import.meta.url))); hosts = []; });
afterEach(async () => { vi.useRealTimers(); await Promise.all(hosts.map((h) => h.stopAll())); await rm(temp, { recursive: true, force: true }); });

describe("plugin installation", () => {
  it("cleans newly created install and data dirs when publication fails after consent", async () => {
    const h = host();
    vi.mocked(rename).mockRejectedValueOnce(new Error("publication failed"));
    await expect(h.install(await source(), consent)).rejects.toThrow("publication failed");
    expect(await readdir(path.join(temp, "base/app-a/bridge/plugins"))).toEqual([]);
    expect(await readdir(path.join(temp, "base/app-a/bridge/plugin-data"))).toEqual([]);
    expect(await h.list()).toEqual([]);
    expect(await h.install(await source(), consent)).toMatchObject({ version: "1.0.0" });
  });
  it("removes the new id directory even when creating its data directory fails", async () => {
    const h = host(); const data = path.join(temp, "base/app-a/bridge/plugin-data");
    await mkdir(data, { recursive: true }); await writeFile(path.join(data, "alpha"), "existing");
    await expect(h.install(await source(), consent)).rejects.toThrow();
    expect(await readdir(path.join(temp, "base/app-a/bridge/plugins"))).toEqual([]);
    expect(await readFile(path.join(data, "alpha"), "utf8")).toBe("existing");
  });
  it("preserves existing installs and data on a failed upgrade and restores the running version", async () => {
    const h = host({ restartDelayMs: 1_000 }); const p = await h.install(await source(), consent); await h.start();
    await writeFile(path.join(p.dataDir, "saved"), "keep");
    vi.mocked(rename).mockRejectedValueOnce(new Error("publication failed"));
    await expect(h.install(await source("alpha", "app-a", "2.0.0"), consent)).rejects.toThrow("publication failed");
    const src = await source("alpha", "app-a", "2.0.0"); await writeFile(path.join(src, "entry.js"), "process.exit(1);");
    await expect(h.install(src, consent)).rejects.toThrow("before ready");
    expect(await readdir(path.dirname(p.installDir))).toEqual(["1.0.0"]);
    expect(await readFile(path.join(p.dataDir, "saved"), "utf8")).toBe("keep");
    expect((await h.list()).map((p) => [p.version, p.status])).toEqual([["1.0.0", "running"]]);
    expect(await h.router.request(caller, "_alpha/echo", "restored")).toBe("restored");
  });
  it("denied consent writes nothing and shows unenforced network/fs permissions", async () => {
    const h = host();
    const confirm = vi.fn(async () => false);
    const src = await source("alpha", "app-a", "1.0.0", { network: ["example.com"], fs: ["$PLUGIN_DATA"], agents: ["claude"], localUi: { port: "auto" } });
    await expect(h.install(src, { confirm })).rejects.toThrow("not confirmed");
    expect(await readdir(temp)).toEqual(["alpha-1.0.0"]);
    expect(confirm.mock.calls[0]).toMatchObject([{ network: ["example.com"], fs: ["$PLUGIN_DATA"], agents: ["claude"], localUi: true }]);
    expect(JSON.stringify(confirm.mock.calls)).toContain("not yet enforced");
  });
  it("validates manifests, entry files and versions before confirmation", async () => {
    const h = host(); const confirm = vi.fn(async () => true);
    const src = await source();
    await writeFile(path.join(src, "bridge-plugin.json"), JSON.stringify({ id: "../outside", app: "a", entry: "entry.js", permissions: {} }));
    await expect(h.install(src, { confirm })).rejects.toThrow("id must");
    await source(); await writeFile(path.join(src, "package.json"), '{"version":"../escape"}');
    await expect(h.install(src, { confirm })).rejects.toThrow("version");
    await source(); await rm(path.join(src, "entry.js"));
    await expect(h.install(src, { confirm })).rejects.toThrow("entry");
    expect(confirm).not.toHaveBeenCalled();
  });
  it("installs an npm-style gzipped tarball and reloads the inventory", async () => {
    const src = await source(); const archiveRoot = path.join(temp, "archive");
    await mkdir(archiveRoot); const { cp } = await import("node:fs/promises");
    await cp(src, path.join(archiveRoot, "package"), { recursive: true });
    const tar = path.join(temp, "plugin.tgz");
    execFileSync("tar", ["-czf", tar, "-C", archiveRoot, "package"]);
    const h = host(); const installed = await h.install(tar, consent);
    expect(installed.installDir).toBe(path.join(temp, "base/app-a/bridge/plugins/alpha/1.0.0"));
    expect(await readFile(path.join(installed.installDir, "entry.js"), "utf8")).toBe(entry);
    expect(await host().list()).toEqual([installed]);
  });
  it("rejects package links and symlinked destination ancestors", async () => {
    const src = await source();
    await symlink(path.join(src, "entry.js"), path.join(src, "link.js"));
    await expect(host().install(src, consent)).rejects.toThrow("symlinks");
    await rm(path.join(src, "link.js"));
    await mkdir(path.join(temp, "base", "app-a"), { recursive: true });
    await symlink(src, path.join(temp, "base", "app-a", "bridge"));
    await expect(host().install(src, consent)).rejects.toThrow("symlink");
    expect(await readdir(src)).toEqual(["bridge-plugin.json", "entry.js", "package.json"]);
  });
  it("does not let a second app claim the same plugin id", async () => {
    const h = host(); await h.install(await source(), consent);
    await expect(h.install(await source("alpha", "app-b", "2.0.0"), consent)).rejects.toThrow("another app");
    await expect(h.install(await source(), consent)).rejects.toThrow("already installed");
  });
  it.each(["manifest", "identity", "version", "app", "id-link", "version-link"])("isolates a bad %s entry and can remove regular corrupt entries", async (fault) => {
    const initial = host(); const p = await initial.install(await source(), consent);
    const beta = await initial.install(await source("beta", "app-b"), consent);
    if (fault === "manifest") await writeFile(path.join(p.installDir, "bridge-plugin.json"), "{broken");
    if (fault === "identity") await writeFile(path.join(p.installDir, "bridge-plugin.json"), JSON.stringify({ ...p.manifest, id: "impostor" }));
    if (fault === "version") await writeFile(path.join(p.installDir, "package.json"), '{"version":"9.0.0"}');
    // The manifest names another app than the folder that holds it.
    if (fault === "app") await writeFile(path.join(p.installDir, "bridge-plugin.json"), JSON.stringify({ ...p.manifest, app: "app-b" }));
    const linked = fault.endsWith("link");
    if (linked) {
      const target = fault === "id-link" ? path.dirname(p.installDir) : p.installDir;
      await rm(target, { recursive: true }); await symlink(path.dirname(beta.installDir), target);
    }
    const log = vi.fn(); const h = host({ log });
    expect((await h.list()).map((x) => x.manifest.id)).toEqual(["beta"]);
    expect(log).toHaveBeenCalledWith("alpha", "warn", "Skipping invalid installed plugin", expect.any(Object));
    await h.start("app-b");
    expect(await h.router.request({ ...caller, appId: "app-b" }, "_beta/echo", "healthy")).toBe("healthy");
    await expect(h.router.request({ ...caller, appId: "app-b" }, "_alpha/echo", {})).rejects.toMatchObject({ code: -32013 });
    await h.install(await source("gamma", "app-b"), consent);
    await h.remove("gamma", consent);
    if (!linked) {
      const confirm = vi.fn(async () => true);
      await h.remove("alpha", { confirm });
      expect(JSON.stringify(confirm.mock.calls)).toContain("Invalid installed plugin");
      expect(await readdir(path.dirname(path.dirname(beta.installDir)))).toEqual(["beta"]);
    }
    await h.remove("beta", consent);
  });
  it.each(["install", "remove"])("allows list, start and shutdown while %s consent is unanswered", async (operation) => {
    const h = host(); await h.install(await source("beta", "app-b"), consent); await h.start("app-b");
    const src = await source();
    if (operation === "remove") await h.install(src, consent);
    const decision = deferred<boolean>(); const asked = deferred<void>();
    const confirm = async () => { asked.resolve(); return decision.promise; };
    const pending = operation === "install" ? h.install(src, { confirm }) : h.remove("alpha", { confirm });
    const rejected = expect(pending).rejects.toThrow("not confirmed");
    await asked.promise;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => { await h.list(); await h.start("app-b"); await h.stopAll(); })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Consent blocked lifecycle")), 500); }),
      ]);
    } finally { clearTimeout(timer); decision.resolve(false); await rejected; }
  });
  it.each(["duplicate", "owner"])("revalidates an install after consent when another install changes its %s", async (change) => {
    const h = host(); const decision = deferred<boolean>(); const asked = deferred<void>();
    const pending = h.install(await source(), { confirm: async () => { asked.resolve(); return decision.promise; } });
    const rejected = expect(pending).rejects.toThrow(change === "duplicate" ? "already installed" : "another app");
    await asked.promise;
    try { await h.install(await source("alpha", change === "duplicate" ? "app-a" : "app-b", change === "duplicate" ? "1.0.0" : "2.0.0"), consent); }
    finally { decision.resolve(true); }
    await rejected;
    expect(await h.list()).toHaveLength(1);
  });
  it("rejects stale removal consent when a new version is installed", async () => {
    const h = host(); await h.install(await source(), consent);
    const decision = deferred<boolean>(); const asked = deferred<void>();
    const pending = h.remove("alpha", { confirm: async () => { asked.resolve(); return decision.promise; } });
    const rejected = expect(pending).rejects.toThrow("inventory changed");
    await asked.promise;
    try { await h.install(await source("alpha", "app-a", "2.0.0"), consent); }
    finally { decision.resolve(true); }
    await rejected; expect((await h.list()).map((p) => p.version)).toEqual(["2.0.0"]);
  });
  it("rejects a bridge/ symlink inserted while consenting to a missing folder", async () => {
    const h = host();
    const src = await source(); const elsewhere = path.join(temp, "elsewhere"); await mkdir(elsewhere);
    const decision = deferred<boolean>(); const asked = deferred<void>();
    const pending = h.install(src, { confirm: async () => { asked.resolve(); return decision.promise; } });
    const rejected = expect(pending).rejects.toThrow("symlink");
    await asked.promise;
    try {
      await mkdir(path.join(temp, "base", "app-a"), { recursive: true });
      await symlink(elsewhere, path.join(temp, "base", "app-a", "bridge"));
    } finally { decision.resolve(true); }
    await rejected; expect(await readdir(elsewhere)).toEqual([]);
  });
});

describe("subprocesses and app scope", () => {
  it.each(["stop", "remove", "upgrade"])("%s releases the host lifecycle queue despite escaped descendants holding stdio", async (operation) => {
    const h = host({ stopTimeoutMs: 100 }); const src = await source();
    await writeFile(path.join(src, "entry.js"), "import {spawn} from 'node:child_process';\nprocess.on('SIGTERM',()=>process.exit(0));\n" + entry.replace("let result = params;", `let result = params;
      if(method.endsWith('/child')) {
        const sub = spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),10000)'],{detached:true,stdio:['ignore','inherit','inherit']});
        sub.unref(); result = sub.pid;
      }`));
    await h.install(src, consent); await h.install(await source("beta", "app-b"), consent); await h.start("app-a");
    const escaped = await h.router.request(caller, "_alpha/child", {}) as number;
    let finishing: Promise<unknown> | undefined;
    try {
      const upgrade = operation === "upgrade" ? await source("alpha", "app-a", "2.0.0") : undefined;
      finishing = operation === "stop" ? h.stopAll() : operation === "remove" ? h.remove("alpha", consent) : h.install(upgrade!, consent);
      let finished = false;
      const queued = finishing.then(() => h.start("app-b")).then(() => { finished = true; });
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 1_500 });
      await queued;
      expect(await h.router.request({ ...caller, appId: "app-b" }, "_beta/echo", "queue released")).toBe("queue released");
      if (operation === "upgrade") expect(await h.router.request(caller, "_alpha/echo", "upgraded")).toBe("upgraded");
      if (operation === "remove") expect((await h.list()).map((p) => p.manifest.id)).toEqual(["beta"]);
      expect(() => process.kill(escaped, 0)).not.toThrow();
    } finally {
      try { process.kill(-escaped, "SIGKILL"); } catch { /* Already exited. */ }
      await finishing;
    }
  });
  it.each(["stop", "remove"])("%s kills descendants even after their leader exits on SIGTERM", async (operation) => {
    const h = host(); const src = await source();
    await writeFile(path.join(src, "entry.js"), "import {spawn} from 'node:child_process';\nprocess.on('SIGTERM',()=>process.exit(0));\n" + entry.replace("let result = params;", `let result = params;
      if(method.endsWith('/child')) {
        const sub = spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});
        await new Promise(resolve=>sub.stdout.once('data',resolve));
        result = {pid:sub.pid,leader:process.pid};
      }`));
    await h.install(src, consent); await h.start();
    const { pid, leader } = await h.router.request(caller, "_alpha/child", {}) as { pid: number; leader: number };
    try {
      if (operation === "stop") await h.stopAll(); else await h.remove("alpha", consent);
      await vi.waitFor(() => {
        let state = "";
        try { state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { /* Reaped. */ }
        // An orphan zombie cannot execute; PID 1 controls when it is reaped.
        expect(state === "" || state.startsWith("Z")).toBe(true);
      });
    } finally { try { process.kill(-leader, "SIGKILL"); } catch { /* Group gone. */ } }
  });
  it("ignores and logs malformed local UI URLs without disconnecting or restarting", async () => {
    const log = vi.fn(); const h = host({ log });
    await h.install(await source("alpha", "app-a", "1.0.0", { localUi: { port: "auto" } }), consent); await h.start();
    const notifications: JsonRpcMessage[] = []; h.router.subscribe(caller, (m) => notifications.push(m));
    for (const url of ["not a URL", "http://evil.test:1234", "http://user:pass@127.0.0.1:1234"]) {
      expect(await h.router.request(caller, "_alpha/ui", { url })).toEqual({ url });
    }
    expect(log).toHaveBeenCalledTimes(3); expect(notifications).toEqual([]);
    expect((await h.list())[0]).toMatchObject({ status: "running" });
    expect((await h.list())[0]?.localUiUrl).toBeUndefined();
    expect(await h.router.request(caller, "_alpha/echo", "alive")).toBe("alive");
  });
  it("delivers an extracted notify callback and silently ignores foreign or missing plugins", async () => {
    const h = host(); await h.install(await source(), consent); await h.start();
    const received: JsonRpcMessage[] = []; h.router.subscribe(caller, (m) => received.push(m));
    const { notify } = h.router;
    expect(() => notify(caller, "_alpha/push", { ok: true })).not.toThrow();
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(() => notify({ ...caller, appId: "other" }, "_alpha/push", {})).not.toThrow();
    expect(() => notify(caller, "_missing/push", {})).not.toThrow();
    await h.router.request(caller, "_alpha/echo", {});
    expect(received).toHaveLength(1);
  });
  it("strips secrets and inherited Node hooks and gives the plugin private paths", async () => {
    const h = host({ env: { PATH: process.env.PATH, PARENT_SECRET: "hidden", NODE_OPTIONS: "--bad-option", HOME: "/parent", DATABASE_URL: "hidden", UNDECLARED: "hidden" } });
    const p = await h.install(await source(), consent); await h.start("app-a");
    const env = await h.router.request(caller, "_alpha/env", {}) as Record<string, string>;
    expect(env.PARENT_SECRET).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.DATABASE_URL).toBeUndefined(); expect(env.UNDECLARED).toBeUndefined();
    expect(env.PLUGIN_DATA).toBe(p.dataDir); expect(env.HOME).toBe(path.join(p.dataDir, "sandbox/home"));
    expect(env.TMPDIR).toBe(path.join(p.dataDir, "sandbox"));
    expect(await h.router.request(caller, "_alpha/echo", { hello: "world" })).toEqual({ hello: "world" });
    // Public inventory snapshots cannot change routing or permissions.
    p.manifest.app = "evil"; (await h.list())[0]!.manifest.app = "evil";
    await expect(h.router.request({ ...caller, appId: "evil" }, "_alpha/echo", {})).rejects.toMatchObject({ code: -32013 });
  });
  it("rejects cross-app calls and sends only owned notifications to that app", async () => {
    const h = host(); await h.install(await source(), consent); await h.start();
    const messages: JsonRpcMessage[] = []; const other: JsonRpcMessage[] = [];
    const unsubscribe = h.router.subscribe(caller, (m) => messages.push(m));
    h.router.subscribe({ ...caller, appId: "other" }, (m) => other.push(m));
    expect(h.router.handles("_alpha/echo")).toBe(true); expect(h.router.handles("_missing/echo")).toBe(true);
    expect(h.router.handles("session/prompt")).toBe(false);
    const foreign = await h.router.request({ ...caller, appId: "other" }, "_alpha/echo", {}).catch((e: Error & { code: number }) => ({ code: e.code, message: e.message }));
    const missing = await h.router.request({ ...caller, appId: "other" }, "_missing/echo", {}).catch((e: Error & { code: number }) => ({ code: e.code, message: e.message }));
    expect(foreign).toEqual(missing); expect(foreign).toEqual({ code: -32013, message: "Unknown plugin" });
    await expect(h.router.request(caller, "_missing/echo", {})).rejects.toMatchObject({ code: -32013 });
    await h.router.request(caller, "_alpha/push", { event: 1 });
    expect(messages.map((m) => m.method)).toEqual(["_alpha/update"]); expect(other).toEqual([]);
    unsubscribe(); await h.router.request(caller, "_alpha/push", {}); expect(messages).toHaveLength(1);
    expect(() => h.router.notify({ ...caller, appId: "other" }, "_alpha/echo", {})).not.toThrow();
  });
  it("restarts after a crash with backoff and rejects in-flight calls", async () => {
    const h = host({ restartDelayMs: 200 }); await h.install(await source(), consent); await h.start();
    const crashed = h.router.request(caller, "_alpha/crash", {});
    await expect(crashed).rejects.toThrow("closed");
    await vi.waitFor(async () => expect((await h.list())[0]?.status).toBe("backoff"));
    await vi.waitFor(async () => expect((await h.list())[0]?.status).toBe("running"));
    expect(await h.router.request(caller, "_alpha/echo", 42)).toBe(42);
    await h.stopAll(); await h.stopAll(); expect((await h.list())[0]?.status).toBe("stopped");
  });
  it("bounds startup and request hangs and can stop during backoff", async () => {
    const h = host({ startupTimeoutMs: 100, restartDelayMs: 1_000, requestTimeoutMs: 40 });
    const src = await source(); await h.install(src, consent); await h.start();
    await expect(h.router.request(caller, "_alpha/hang", null)).rejects.toThrow("timed out");
    await h.remove("alpha", consent);
    await writeFile(path.join(src, "entry.js"), "setInterval(() => {}, 1000);");
    await h.install(src, consent);
    await expect(h.start()).rejects.toThrow("startup timed out");
    await h.stopAll(); expect((await h.list())[0]?.status).toBe("stopped");
  });
  it("starts only the requested app and selects the newest installed version", async () => {
    const h = host(); await h.install(await source(), consent);
    await h.install(await source("alpha", "app-a", "2.0.0"), consent);
    await h.install(await source("beta", "app-b"), consent); await h.start("app-a");
    expect((await h.list()).map((p) => [p.version, p.status])).toEqual([["2.0.0", "running"], ["1.0.0", "stopped"]]);
    await expect(h.router.request({ ...caller, appId: "app-b" }, "_beta/echo", {})).rejects.toThrow("not running");
  });
  it("starts healthy plugins even when an earlier plugin fails startup", async () => {
    const h = host({ restartDelayMs: 1_000 });
    const broken = await source();
    await writeFile(path.join(broken, "entry.js"), "process.exit(1);");
    await h.install(broken, consent); await h.install(await source("beta"), consent);
    await expect(h.start()).rejects.toThrow("before ready");
    expect(await h.router.request(caller, "_beta/echo", "healthy")).toBe("healthy");
  });
  it("restarts an active plugin on upgrade and preserves its data and app scope", async () => {
    const h = host(); const p = await h.install(await source(), consent);
    await h.install(await source("beta", "app-b"), consent); await h.start();
    await writeFile(path.join(p.dataDir, "user-data"), "preserved");
    const src = await source("alpha", "app-a", "2.0.0");
    await writeFile(path.join(src, "entry.js"), entry.replace("let result = params;", "let result = {version:'2.0.0',params};"));
    expect((await h.install(src, consent)).status).toBe("running");
    expect(await h.router.request(caller, "_alpha/echo", "upgraded")).toEqual({ version: "2.0.0", params: "upgraded" });
    expect(await readFile(path.join(p.dataDir, "user-data"), "utf8")).toBe("preserved");
    expect(await h.router.request({ ...caller, appId: "app-b" }, "_beta/echo", 42)).toBe(42);
    await expect(h.router.request({ ...caller, appId: "app-b" }, "_alpha/echo", {})).rejects.toMatchObject({ code: -32013 });
    await h.install(await source("alpha", "app-a", "0.5.0"), consent);
    expect(await h.router.request(caller, "_alpha/echo", "still newest")).toEqual({ version: "2.0.0", params: "still newest" });
  });
  it("lets browser calls wait beyond 30 seconds for broker starts and prompts, then rejects on shutdown", async () => {
    const h = host(); await h.install(await source("alpha", "app-a", "1.0.0", { agents: ["claude"] }), consent);
    const spawning = deferred<void>(); const prompting = deferred<void>();
    const prompt = vi.fn(async () => { await prompting.promise; return { text: "slow answer", stopReason: "end_turn" }; });
    const close = vi.fn(async () => {});
    const start = vi.fn(async () => { await spawning.promise; return { sessionId: "slow", prompt, cancel: async () => {}, close }; });
    h.setBroker("app-a", { start }); await h.start(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const starting = h.router.request(caller, "_alpha/broker", { agent: "claude", onBehalfOf: who(caller) });
      void starting.catch(() => {});
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(60_000); spawning.resolve();
      const session = await starting as { sessionId: string };
      expect(session.sessionId).toEqual(expect.any(String));
      const result = h.router.request(caller, "_alpha/session", { method: "host/sessionPrompt", params: { ...session, text: "hello" } });
      void result.catch(() => {});
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(60_000); prompting.resolve();
      expect(await result).toEqual({ text: "slow answer", stopReason: "end_turn" });
      const disconnected = expect(h.router.request(caller, "_alpha/hang", {})).rejects.toThrow("closed");
      vi.useRealTimers(); await h.stopAll(); await disconnected; expect(close).toHaveBeenCalledOnce();
    } finally { spawning.resolve(); prompting.resolve(); vi.useRealTimers(); }
  });
});

describe("broker and removal", () => {
  it("rejects attribution to a different concurrent caller and invalid or expired call tokens", async () => {
    const h = host(); const src = await source("alpha", "app-a", "1.0.0", { agents: ["claude"] });
    await writeFile(path.join(src, "entry.js"), "let releaseHeld;\n" + entry.replace("let result = params;", `let result = params;
      if(method.endsWith('/hold')) await new Promise(resolve=>releaseHeld=resolve);
      if(method.endsWith('/release')) releaseHeld();
      if(method.endsWith('/token')) result = callToken;
      if(method.endsWith('/probe')) result = await ask('host/startAgentSession',params);`));
    const start = vi.fn(async () => ({ sessionId: "session", prompt: async () => ({ text: "", stopReason: "end_turn" }), cancel: async () => {}, close: async () => {} }));
    h.setBroker("app-a", { start }); await h.install(src, consent); await h.start();
    const other = { ...caller, browserKeyId: "browser-b" };
    const held = h.router.request(other, "_alpha/hold", {});
    void held.catch(() => {});
    // A response on the same stdio stream proves the held request was delivered.
    const expired = await h.router.request(other, "_alpha/token", {});
    try {
      await expect(h.router.request(caller, "_alpha/broker", { agent: "claude", onBehalfOf: who(other) })).rejects.toMatchObject({ code: -32014 });
      for (const callToken of [undefined, "forged", expired]) {
        await expect(h.router.request(caller, "_alpha/probe", { agent: "claude", onBehalfOf: who(other), callToken })).rejects.toMatchObject({ code: -32014 });
      }
      expect(start).not.toHaveBeenCalled();
      await h.router.request(caller, "_alpha/broker", { agent: "claude", onBehalfOf: who(caller) });
      expect(start).toHaveBeenCalledOnce();
    } finally { await h.router.request(caller, "_alpha/release", {}); await held; }
  });
  it("enforces agent/app permissions and keeps session handles private to a plugin", async () => {
    const h = host(); await h.install(await source("alpha", "app-a", "1.0.0", { agents: ["claude"] }), consent);
    await h.install(await source("beta", "app-b", "1.0.0", { agents: ["claude"] }), consent);
    const close = vi.fn(async () => {}); const start = vi.fn(async () => ({ sessionId: "agent-session", prompt: async (text: string) => ({ stopReason: "end_turn", text }), cancel: async () => {}, close }));
    h.setBroker("app-a", { start }); h.setBroker("app-b", { start }); await h.start();
    await expect(h.router.request(caller, "_alpha/broker", { agent: "codex" })).rejects.toMatchObject({ code: -32012 });
    await expect(h.router.request(caller, "_alpha/broker", { agent: "claude", onBehalfOf: { appId: "app-b", browserKeyId: "b" } })).rejects.toMatchObject({ code: -32014 });
    await expect(h.router.request(caller, "_alpha/broker", { agent: "claude", onBehalfOf: { appId: "app-a", browserKeyId: "not-the-caller" } })).rejects.toMatchObject({ code: -32014 });
    expect(start).not.toHaveBeenCalled();
    // A field the wire does not define, such as a permission mode, is refused rather than ignored.
    await expect(h.router.request(caller, "_alpha/broker", { agent: "claude", cwd: "/project", onBehalfOf: who(caller), permissionMode: "bypass" })).rejects.toMatchObject({ code: -32602 });
    expect(start).not.toHaveBeenCalled();
    const result = await h.router.request(caller, "_alpha/broker", { agent: "claude", cwd: "/project", onBehalfOf: who(caller) }) as { sessionId: string };
    expect(start).toHaveBeenCalledWith({ pluginId: "alpha", appId: "app-a", agent: "claude", cwd: "/project", onBehalfOf: { browserKeyId: "browser-a" } });
    expect(result.sessionId).toBe("agent-session"); // the runner's id; app-b still cannot use it (below)
    await expect(h.router.request({ ...caller, appId: "app-b" }, "_beta/session", { method: "host/sessionPrompt", params: { sessionId: result.sessionId, text: "steal" } })).rejects.toMatchObject({ code: -32015 });
    await expect(h.router.request(caller, "_alpha/session", { method: "session/request_permission", params: {} })).rejects.toMatchObject({ code: -32601 });
    expect(await h.router.request(caller, "_alpha/session", { method: "host/sessionPrompt", params: { sessionId: result.sessionId, text: "hello" } })).toEqual({ stopReason: "end_turn", text: "hello" });
    await h.stopAll(); expect(close).toHaveBeenCalledOnce();
  });
  it.each(["start", "close"])("waits for an in-flight broker %s before removal", async (operation) => {
    const h = host(); const p = await h.install(await source("alpha", "app-a", "1.0.0", { agents: ["claude"] }), consent);
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    const close = vi.fn(async () => { if (operation === "close") await deferred; });
    const start = vi.fn(async () => {
      if (operation === "start") await deferred;
      return { sessionId: "agent-session", prompt: async () => ({ stopReason: "end_turn", text: "" }), cancel: async () => {}, close };
    });
    h.setBroker("app-a", { start }); await h.start();
    let request: Promise<unknown>;
    if (operation === "start") {
      request = h.router.request(caller, "_alpha/broker", { agent: "claude" });
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    } else {
      const session = await h.router.request(caller, "_alpha/broker", { agent: "claude" }) as { sessionId: string };
      request = h.router.request(caller, "_alpha/session", { method: "host/sessionClose", params: session });
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    }
    // Register rejection handling before killing the subprocess.
    const disconnected = expect(request).rejects.toThrow("closed");
    let removed = false;
    const removing = h.remove("alpha", consent).then(() => { removed = true; });
    try {
      await disconnected;
      expect(removed).toBe(false);
      expect(await readFile(path.join(p.installDir, "entry.js"), "utf8")).toBe(entry);
    } finally { release(); }
    await removing; expect(close).toHaveBeenCalledOnce(); expect(removed).toBe(true);
  });
  it("removes exactly this plugin's installs and data, after confirmation, and stops restarts", async () => {
    const h = host({ restartDelayMs: 100 }); const p = await h.install(await source(), consent);
    const sibling = await h.install(await source("alpha-next", "app-b"), consent);
    await writeFile(path.join(p.dataDir, "user-data"), "local"); await h.start();
    await expect(h.remove("alpha", { confirm: async () => false })).rejects.toThrow("not confirmed");
    expect(await readFile(path.join(p.dataDir, "user-data"), "utf8")).toBe("local");
    await expect(h.router.request(caller, "_alpha/crash", {})).rejects.toThrow();
    await h.remove("alpha", consent);
    expect((await h.list()).map((x) => x.manifest.id)).toEqual(["alpha-next"]);
    // The plugin's own app folders are empty; the sibling's (another app's) are untouched.
    expect(await readdir(path.dirname(p.dataDir))).toEqual([]);
    expect(await readdir(path.dirname(path.dirname(p.installDir)))).toEqual([]);
    expect(await readdir(path.dirname(sibling.dataDir))).toEqual(["alpha-next"]);
    expect(await readdir(path.dirname(path.dirname(sibling.installDir)))).toEqual(["alpha-next"]);
    expect(await readFile(path.join(sibling.installDir, "entry.js"), "utf8")).toBe(entry);
    await expect(h.remove("../alpha-next", consent)).rejects.toThrow("Invalid plugin");
    await expect(h.router.request(caller, "_alpha/echo", {})).rejects.toMatchObject({ code: -32013 });
  });
});

describe("per-app plugin folders (apps)", () => {
  const base = () => ({ config: path.join(temp, "config"), data: path.join(temp, "data"), state: path.join(temp, "state") });
  const appsOf = (...ids: string[]) => ids.map((id) => appPathsOf(base(), id));
  function appHost(ids: string[] = ["app-a", "app-b"], options: Partial<Parameters<typeof createPluginHost>[0]> = {}): PluginHost {
    const result = createPluginHost({ apps: appsOf(...ids), restartDelayMs: 20, stopTimeoutMs: 50, ...options });
    hosts.push(result);
    return result;
  }
  const dirs = (id: string) => appPathsOf(base(), id);
  const exists = (p: string) => readdir(p).then(() => true, () => false);

  it("refuses an invalid folder name, and an app listed twice", () => {
    expect(() => createPluginHost({ apps: [...appsOf("app-a"), ...appsOf("app-a")] })).toThrow(/listed twice/);
    expect(() => createPluginHost({ apps: [{ ...appsOf("app-a")[0]!, appId: "AppA" }] })).toThrow(/invalid app folder name/);
  });

  it("installs into the manifest's app only, with data beside it, and reports the app", async () => {
    const h = appHost();
    const plugin = await h.install(await source("alpha", "app-a"), consent);
    const a = dirs("app-a");
    expect(plugin).toMatchObject({ appId: "app-a", installDir: path.join(a.pluginsDir, "alpha", "1.0.0"), dataDir: path.join(a.pluginDataDir, "alpha") });
    expect(await exists(path.join(a.pluginsDir, "alpha", "1.0.0"))).toBe(true);
    expect(await exists(a.pluginDataDir + "/alpha")).toBe(true);
    // nothing in the other app's folders, nor in the old shared layout
    expect(await exists(dirs("app-b").dataDir)).toBe(false);
    expect(await exists(path.join(temp, "base"))).toBe(false);
  });

  it("refuses a manifest naming an unlisted app or an invalid name before any write or consent", async () => {
    const h = appHost(["app-a"]);
    const asked = vi.fn(async () => true);
    await expect(h.install(await source("alpha", "app-b"), { confirm: asked })).rejects.toThrow("connect app-b first: plugins install into the app's own folder");
    await expect(h.install(await source("beta", "App-C"), { confirm: asked })).rejects.toThrow(/invalid app folder name|valid/);
    await expect(h.install(await source("gamma", "bridge"), { confirm: asked })).rejects.toThrow();
    expect(asked).not.toHaveBeenCalled();
    expect(await exists(dirs("app-a").dataDir)).toBe(false);
    expect(await exists(dirs("app-b").dataDir)).toBe(false);
    expect(await h.list()).toEqual([]);
  });

  it("lists across apps and removes exactly the plugin's two dirs", async () => {
    const h = appHost();
    await h.install(await source("alpha", "app-a"), consent);
    await h.install(await source("beta", "app-b"), consent);
    await h.install(await source("alpha2", "app-a"), consent);
    const listed = await h.list();
    expect(listed.map((p) => [p.manifest.id, p.appId]).sort()).toEqual([["alpha", "app-a"], ["alpha2", "app-a"], ["beta", "app-b"]]);
    const a = dirs("app-a");
    await writeFile(path.join(a.pluginDataDir, "alpha", "state.json"), "{}");
    const removing: unknown[] = [];
    await h.remove("alpha", { confirm: async (s) => { removing.push(...(s.paths ?? [])); return true; } });
    expect(removing).toEqual([
      { action: "remove", path: path.join(a.pluginsDir, "alpha") },
      { action: "remove", path: path.join(a.consentDir, "alpha.consent.json") },
      { action: "remove", path: path.join(a.pluginDataDir, "alpha") },
    ]);
    expect(await readdir(a.pluginsDir)).toEqual(["alpha2"]);
    expect(await readdir(a.pluginDataDir)).toEqual(["alpha2"]);
    expect((await h.list()).map((p) => p.manifest.id).sort()).toEqual(["alpha2", "beta"]);
    expect(await readdir(dirs("app-b").pluginsDir)).toEqual(["beta"]);
    // a fresh host sees the same inventory from disk
    expect((await appHost().list()).map((p) => p.manifest.id).sort()).toEqual(["alpha2", "beta"]);
  });

  it("refuses to install a plugin id that another app already holds", async () => {
    const h = appHost();
    await h.install(await source("alpha", "app-a"), consent);
    await expect(h.install(await source("alpha", "app-b", "2.0.0"), consent)).rejects.toThrow("Plugin id already belongs to another app");
    expect(await exists(dirs("app-b").pluginsDir)).toBe(false);
  });

  it("a copy planted in another app's folder is rejected, blocks reinstall of its id, and remove clears both", async () => {
    await appHost().install(await source("alpha", "app-a"), consent);
    const planted = dirs("app-b").pluginsDir;
    await mkdir(planted, { recursive: true });
    await cp(path.join(dirs("app-a").pluginsDir, "alpha"), path.join(planted, "alpha"), { recursive: true });
    // app-b first: the plugin's own app, not the first folder holding the id, sets its boundary
    const h = appHost(["app-b", "app-a"]);
    // app-a's own copy stays; the copy in app-b's folder names app-a and is not trusted there
    expect((await h.list()).map((p) => [p.manifest.id, p.appId])).toEqual([["alpha", "app-a"]]);
    await expect(h.start("app-a")).resolves.toBeUndefined();
    expect(await h.router.request(caller, "_alpha/echo", "from app-a's folder")).toBe("from app-a's folder");
    await expect(h.install(await source("alpha", "app-b", "2.0.0"), consent)).rejects.toThrow("Plugin id already belongs to another app");
    const removing = new Set<string>();
    await h.remove("alpha", { confirm: async (s) => { for (const p of s.paths ?? []) removing.add(`${p.action} ${p.path}`); return true; } });
    // Both folders and the consent record of both places that hold the id, each listed on its own.
    expect(removing.size).toBe(6);
    expect(await readdir(planted)).toEqual([]);
    expect(await readdir(dirs("app-a").pluginsDir)).toEqual([]);
  });

  it("skips a plugin whose manifest names another app than the folder that holds it", async () => {
    await appHost().install(await source("alpha", "app-a"), consent);
    await mkdir(dirs("app-b").pluginsDir, { recursive: true });
    await rename(path.join(dirs("app-a").pluginsDir, "alpha"), path.join(dirs("app-b").pluginsDir, "alpha"));
    const h = appHost();
    expect(await h.list()).toEqual([]);
    await expect(h.start()).resolves.toBeUndefined();
  });

  it.each(["app parent", "bridge folder"])("refuses the %s link planted while consenting to a missing folder, and writes nothing through it", async (kind) => {
    const h = appHost(["app-a"]);
    const src = await source("alpha", "app-a");
    const elsewhere = path.join(temp, "elsewhere"); await mkdir(elsewhere);
    const decision = deferred<boolean>(); const asked = deferred<void>();
    const pending = h.install(src, { confirm: async () => { asked.resolve(); return decision.promise; } });
    const rejected = expect(pending).rejects.toThrow(/symlink|moved during confirmation/);
    await asked.promise;
    try {
      await mkdir(base().data, { recursive: true });
      if (kind === "app parent") await symlink(elsewhere, path.join(base().data, "app-a"));
      else { await mkdir(path.join(base().data, "app-a")); await symlink(elsewhere, path.join(base().data, "app-a", "bridge")); }
    } finally { decision.resolve(true); }
    await rejected;
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it.each(["plugins/<id>", "plugin-data/<id>"])("refuses a %s link planted while consenting, before any staging write", async (kind) => {
    const h = appHost(["app-a"]);
    const src = await source("alpha", "app-a");
    const a = dirs("app-a");
    await mkdir(a.pluginsDir, { recursive: true });
    await mkdir(a.pluginDataDir, { recursive: true });
    const elsewhere = path.join(temp, "elsewhere"); await mkdir(elsewhere);
    const decision = deferred<boolean>(); const asked = deferred<void>();
    const pending = h.install(src, { confirm: async () => { asked.resolve(); return decision.promise; } });
    const rejected = expect(pending).rejects.toThrow(/symlink/);
    await asked.promise;
    try {
      await symlink(elsewhere, path.join(kind === "plugins/<id>" ? a.pluginsDir : a.pluginDataDir, "alpha"));
    } finally { decision.resolve(true); }
    await rejected;
    expect(await readdir(elsewhere)).toEqual([]);
    expect((await readdir(a.pluginsDir)).filter((n) => n.startsWith(".install-"))).toEqual([]);
  });

  it("a removal consented to refuses when the app's parent is retargeted meanwhile, and deletes nothing outside the bound folders", async () => {
    const h = appHost(["app-a"]);
    await h.install(await source("alpha", "app-a"), consent);
    const a = dirs("app-a");
    // A decoy tree elsewhere with the same shape and a plugin of the same id.
    const decoy = path.join(temp, "decoy");
    await mkdir(path.join(decoy, "bridge/plugins/alpha/1.0.0"), { recursive: true });
    await mkdir(path.join(decoy, "bridge/plugin-data/alpha"), { recursive: true });
    await writeFile(path.join(decoy, "bridge/plugins/alpha/1.0.0/keep.txt"), "mine");
    await writeFile(path.join(decoy, "bridge/plugin-data/alpha/keep.txt"), "mine");
    const decision = deferred<boolean>(); const asked = deferred<void>();
    const pending = h.remove("alpha", { confirm: async () => { asked.resolve(); return decision.promise; } });
    const rejected = expect(pending).rejects.toThrow(/moved during confirmation|symlink/);
    await asked.promise;
    // Retarget `<data>/app-a` (the parent of bridge/) to the decoy while the user decides.
    const parent = path.dirname(a.dataDir);
    await rename(parent, path.join(temp, "moved-app-a"));
    await symlink(decoy, parent);
    decision.resolve(true);
    await rejected;
    expect(await readFile(path.join(decoy, "bridge/plugins/alpha/1.0.0/keep.txt"), "utf8")).toBe("mine");
    expect(await readFile(path.join(decoy, "bridge/plugin-data/alpha/keep.txt"), "utf8")).toBe("mine");
    // The consented folders are where they were moved to, untouched.
    expect(await readdir(path.join(temp, "moved-app-a/bridge/plugins"))).toEqual(["alpha"]);
  });

  it("the first install creates the missing <data>/<app> and bridge/ parents 0700 under umask 022, and leaves an existing parent's mode", async () => {
    const previous = process.umask(0o022);
    try {
      await mkdir(base().data, { recursive: true, mode: 0o755 });
      const h = appHost(["app-a"]);
      await h.install(await source("alpha", "app-a"), consent);
      const appParent = path.join(base().data, "app-a");
      for (const dir of [appParent, path.join(appParent, "bridge"), dirs("app-a").pluginsDir, dirs("app-a").pluginDataDir]) {
        expect((await stat(dir)).mode & 0o777, dir).toBe(0o700);
      }
      expect((await stat(base().data)).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(previous);
    }
  });

  it("the install consent lists where the plugin and its data will be written", async () => {
    const h = appHost(["app-a"]);
    const paths: unknown[] = [];
    const plugin = await h.install(await source("alpha", "app-a"), { confirm: async (s) => { paths.push(...(s.paths ?? [])); return true; } });
    expect(paths).toEqual([{ action: "install", path: plugin.installDir }, { action: "data", path: plugin.dataDir }]);
  });

  it("installs twice in one host: the boundary that moves once bridge/ exists is not mistaken for a retarget", async () => {
    const h = appHost(["app-a"]);
    await h.install(await source("alpha", "app-a"), consent);
    await h.install(await source("beta", "app-a"), consent);
    await h.remove("alpha", consent);
    expect((await h.list()).map((p) => p.manifest.id)).toEqual(["beta"]);
  });

  it("allows a symlinked <data>/<app> parent but refuses a symlinked bridge folder and any link inside it", async () => {
    const real = path.join(temp, "real-app-a");
    await mkdir(real);
    await mkdir(base().data, { recursive: true });
    await symlink(real, path.join(base().data, "app-a"));
    const h = appHost(["app-a"]);
    const plugin = await h.install(await source("alpha", "app-a"), consent);
    expect(await readdir(path.join(real, "bridge/plugins/alpha"))).toEqual(["1.0.0"]);
    await h.start();
    expect(await h.router.request(caller, "_alpha/echo", "through a linked parent")).toBe("through a linked parent");
    expect(plugin.installDir).toBe(path.join(real, "bridge/plugins/alpha/1.0.0"));
    await h.stopAll();

    // a link inside bridge/: plugins -> elsewhere
    const elsewhere = path.join(temp, "elsewhere");
    await mkdir(elsewhere);
    await rename(path.join(real, "bridge/plugins"), path.join(real, "bridge/plugins-real"));
    await symlink(elsewhere, path.join(real, "bridge/plugins"));
    await expect(appHost(["app-a"]).list()).rejects.toThrow(/symlink/);
    await expect(appHost(["app-a"]).install(await source("beta", "app-a"), consent)).rejects.toThrow(/symlink/);
    await rm(path.join(real, "bridge/plugins"));
    await rename(path.join(real, "bridge/plugins-real"), path.join(real, "bridge/plugins"));
    // an installed version dir that is a link
    await rename(path.join(real, "bridge/plugins/alpha/1.0.0"), path.join(elsewhere, "1.0.0"));
    await symlink(path.join(elsewhere, "1.0.0"), path.join(real, "bridge/plugins/alpha/1.0.0"));
    const skipped = appHost(["app-a"]);
    expect(await skipped.list()).toEqual([]);
    // the bridge folder itself a link
    await rm(path.join(real, "bridge/plugins/alpha/1.0.0"));
    await rename(path.join(real, "bridge"), path.join(temp, "moved-bridge"));
    await symlink(path.join(temp, "moved-bridge"), path.join(real, "bridge"));
    await expect(appHost(["app-a"]).list()).rejects.toThrow(/symlink/);
    await expect(appHost(["app-a"]).install(await source("gamma", "app-a"), consent)).rejects.toThrow(/symlink/);
    expect(await readdir(elsewhere)).toEqual(["1.0.0"]);
  });
});

describe("consent, update rule, replace and keep-data", () => {
  const SERVER_PERMISSIONS = { mcpServers: { notes: { entry: "dist/notes.js", args: ["--data", "${PLUGIN_DATA}"] } }, headless: { tools: ["mcp__notes__append"] } };
  const terminal = { terminal: true };
  const recordPath = (id = "alpha", app = "app-a") => path.join(appPathsOf(baseOf(), app).consentDir, `${id}.consent.json`);
  const readRecord = async (id = "alpha") => JSON.parse(await readFile(recordPath(id), "utf8")) as ConsentedGrant;
  const exists = (target: string) => stat(target).then(() => true, () => false);
  const auditDir = () => appPathsOf(baseOf(), "app-a").auditDir;
  /** A source whose manifest may name MCP servers: their entry files are written into the package. */
  async function sourceWith(id: string, version: string, permissions: Record<string, unknown>, app = "app-a"): Promise<string> {
    const dir = await source(id, app, version, permissions);
    const servers = (permissions.mcpServers ?? {}) as Record<string, { entry: string }>;
    for (const server of Object.values(servers)) {
      await mkdir(path.dirname(path.join(dir, server.entry)), { recursive: true });
      await writeFile(path.join(dir, server.entry), "// mcp server");
    }
    return dir;
  }
  const asks = () => { const seen: PermissionSummary[] = []; return { seen, confirm: async (s: PermissionSummary) => { seen.push(s); return true; } }; };

  describe("the consent record", () => {
    it("is written only after the person said yes, private, and records the surface", async () => {
      const h = host();
      const src = await sourceWith("alpha", "1.0.0", { agents: ["claude"], ...SERVER_PERMISSIONS });
      await expect(h.install(src, { confirm: async () => false }, terminal)).rejects.toThrow("not confirmed");
      expect(await exists(recordPath())).toBe(false);
      expect(await exists(path.dirname(recordPath()))).toBe(false);
      const installed = await h.install(src, consent, terminal);
      const record = await readRecord();
      expect(record).toMatchObject({ pluginId: "alpha", appId: "app-a", version: "1.0.0" });
      expect(record.surface).toEqual(surfaceOf(installed.manifest));
      expect(record.surfaceSha256).toBe(surfaceSha256Of(record.surface));
      expect(Date.parse(record.time)).not.toBeNaN();
      expect((await stat(recordPath())).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(recordPath()))).mode & 0o777).toBe(0o700);
    });
    it("is not written when the install fails after consent, and a failed upgrade keeps the earlier record", async () => {
      const h = host();
      await h.install(await sourceWith("alpha", "1.0.0", { agents: ["claude"] }), consent);
      const before = await readFile(recordPath(), "utf8");
      vi.mocked(rename).mockRejectedValueOnce(new Error("publication failed"));
      await expect(h.install(await sourceWith("alpha", "2.0.0", { agents: ["claude", "codex"] }), consent, terminal)).rejects.toThrow("publication failed");
      expect(await readFile(recordPath(), "utf8")).toBe(before);
    });
    it("refuses a symlinked consent folder before it asks anything, and writes nothing through it", async () => {
      const h = host(); const decoy = path.join(temp, "decoy"); await mkdir(decoy);
      await mkdir(path.dirname(path.dirname(recordPath())), { recursive: true });
      await symlink(decoy, path.dirname(recordPath()));
      const confirm = vi.fn(async () => true);
      await expect(h.install(await source(), { confirm })).rejects.toThrow("symlink");
      expect(confirm).not.toHaveBeenCalled();
      expect(await readdir(decoy)).toEqual([]);
      expect(await h.list()).toEqual([]);
    });
    describe("the consent folder bound before the confirmation", () => {
      // `<config>/app-a` is a link when the plan is made; it is pointed elsewhere while the person decides.
      async function linkedConfig() {
        const real = path.join(temp, "real-cfg"); const decoy = path.join(temp, "decoy-cfg");
        await mkdir(real); await mkdir(decoy);
        const link = path.join(baseOf().config, "app-a");
        await mkdir(baseOf().config, { recursive: true }); await symlink(real, link);
        const retarget = async () => { await rm(link); await symlink(decoy, link); };
        return { real, decoy, retarget };
      }
      it("refuses an install whose consent folder moved meanwhile, and writes and installs nothing", async () => {
        const { real, decoy, retarget } = await linkedConfig();
        const h = host();
        await expect(h.install(await source(), { confirm: async () => { await retarget(); return true; } })).rejects.toThrow("consent folder moved during confirmation");
        expect(await readdir(decoy)).toEqual([]);
        expect(await readdir(real)).toEqual([]);
        expect(await h.list()).toEqual([]);
        expect(await exists(path.join(temp, "base/app-a/bridge/plugins/alpha"))).toBe(false);
      });
      it("refuses an update whose consent folder moved meanwhile, and keeps the installed version and its record", async () => {
        const { real, decoy, retarget } = await linkedConfig();
        const h = host(); await h.install(await source(), consent);
        const before = await readFile(path.join(real, "bridge/plugins/alpha.consent.json"), "utf8");
        await expect(h.install(await source("alpha", "app-a", "1.1.0"), { confirm: async () => { await retarget(); return true; } })).rejects.toThrow("consent folder moved during confirmation");
        expect(await readdir(decoy)).toEqual([]);
        expect(await readFile(path.join(real, "bridge/plugins/alpha.consent.json"), "utf8")).toBe(before);
        expect((await h.list()).map((p) => p.version)).toEqual(["1.0.0"]);
      });
      it("refuses a removal whose consent folder moved meanwhile, before it deletes anything", async () => {
        const { real, decoy, retarget } = await linkedConfig();
        const h = host(); const installed = await h.install(await source(), consent);
        await expect(h.remove("alpha", { confirm: async () => { await retarget(); return true; } })).rejects.toThrow("consent folder moved during confirmation");
        expect(await readdir(decoy)).toEqual([]);
        expect(await exists(path.join(real, "bridge/plugins/alpha.consent.json"))).toBe(true);
        expect(await exists(installed.installDir)).toBe(true);
        expect((await h.list()).map((p) => p.version)).toEqual(["1.0.0"]);
      });
      it("refuses a standalone revoke whose consent folder moved meanwhile: nothing deleted in either place, the record intact", async () => {
        const { real, decoy, retarget } = await linkedConfig();
        const h = host(); await h.install(await source(), consent);
        // The decoy holds a record of the same name, as an attacker's retarget would offer.
        await mkdir(path.join(decoy, "bridge/plugins"), { recursive: true });
        await writeFile(path.join(decoy, "bridge/plugins/alpha.consent.json"), "decoy record");
        const before = await readFile(path.join(real, "bridge/plugins/alpha.consent.json"), "utf8");
        await expect(h.revoke("alpha", { confirm: async () => { await retarget(); return true; } })).rejects.toThrow("consent folder moved during confirmation");
        expect(await readFile(path.join(real, "bridge/plugins/alpha.consent.json"), "utf8")).toBe(before);
        expect(await readFile(path.join(decoy, "bridge/plugins/alpha.consent.json"), "utf8")).toBe("decoy record");
      });
      it("asks before a standalone revoke deletes anything, and an unconfirmed revoke keeps the record", async () => {
        const { real } = await linkedConfig();
        const h = host(); await h.install(await source(), consent);
        await expect(h.revoke("alpha", { confirm: async () => false })).rejects.toThrow("Revoking was not confirmed");
        expect(await exists(path.join(real, "bridge/plugins/alpha.consent.json"))).toBe(true);
        await h.revoke("alpha", { confirm: async () => true });
        expect(await exists(path.join(real, "bridge/plugins/alpha.consent.json"))).toBe(false);
      });
    });
    it("refuses a symlinked consent file on an update and on remove, and touches nothing behind it", async () => {
      const h = host(); await h.install(await source(), consent);
      const decoy = path.join(temp, "decoy.json"); await writeFile(decoy, "untouched");
      await rm(recordPath()); await symlink(decoy, recordPath());
      const confirm = vi.fn(async () => true);
      await expect(h.install(await source("alpha", "app-a", "2.0.0"), { confirm })).rejects.toThrow("symlink");
      expect(confirm).not.toHaveBeenCalled();
      const kept = await h.list(); expect(kept.map((p) => p.version)).toEqual(["1.0.0"]);
      await expect(h.remove("alpha", consent)).rejects.toThrow("symlink");
      expect(await exists(kept[0]!.installDir)).toBe(true);
      expect(await readFile(decoy, "utf8")).toBe("untouched");
    });
  });

  describe("a contained session start (consentMissing)", () => {
    /** The request the broker would build for a contained session of `alpha`, with the grant `grantOf` returned. */
    async function request(h: PluginHostWithGrants, grant: ConsentedGrant | undefined) {
      const [plugin] = await h.list();
      const resolution = { installDir: plugin!.installDir, dataDir: plugin!.dataDir, surfaceSha256Of };
      const item = surfaceOf(plugin!.manifest).items.find((i) => i.kind === "mcpServer")!;
      const server = resolveGrantedServer(parseGrantedMcpServer(item.value)!, "/usr/bin/node", resolution)!;
      return containedRequestProblem({
        pluginId: "alpha", appId: "app-a", agent: "claude", mcpServers: ["notes"], servers: [server],
        tools: { allow: ["mcp__notes__append"], builtins: "none" }, headless: true, ...(grant ? { grant } : {}),
      }, "/usr/bin/node", resolution);
    }
    it("passes with the recorded consent", async () => {
      const h = host(); await h.install(await sourceWith("alpha", "1.0.0", SERVER_PERMISSIONS), consent, terminal);
      const grant = await h.grantOf("alpha");
      expect(grant).toMatchObject({ pluginId: "alpha", appId: "app-a", version: "1.0.0" });
      expect(await request(h, grant)).toBeUndefined();
    });
    it("is refused with consentMissing when the record is missing, revoked, behind a link, stale or hand-edited", async () => {
      const h = host(); await h.install(await sourceWith("alpha", "1.0.0", SERVER_PERMISSIONS), consent, terminal);
      const original = await readFile(recordPath(), "utf8");
      const refused = async () => {
        const grant = await h.grantOf("alpha");
        expect(grant).toBeUndefined();
        expect(await request(h, grant)).toMatchObject({ code: PROXY_ERROR.consentMissing });
      };
      // A hand edit that adds a tool and leaves the hash alone: the hash no longer matches its surface.
      const record = JSON.parse(original);
      record.surface.items.push({ kind: "headlessTool", value: "mcp__notes__rm" });
      await writeFile(recordPath(), JSON.stringify(record)); await refused();
      // A hand edit that recomputes the hash: it matches itself, but not the installed manifest.
      record.surfaceSha256 = surfaceSha256Of(record.surface);
      await writeFile(recordPath(), JSON.stringify(record)); await refused();
      // A record behind a link.
      const decoy = path.join(temp, "copy.json"); await writeFile(decoy, original);
      await rm(recordPath()); await symlink(decoy, recordPath()); await refused();
      // A missing record.
      await rm(recordPath()); await refused();
      // A revoked one.
      await writeFile(recordPath(), original);
      expect(await h.grantOf("alpha")).toBeDefined();
      await h.revoke("alpha");
      expect(await exists(recordPath())).toBe(false);
      await refused();
      expect((await h.list()).map((p) => p.version)).toEqual(["1.0.0"]);
      await h.revoke("alpha");
    });
  });

  describe("a contained start made while the host holds its lifecycle lock", () => {
    /** A package whose setup starts a contained session before it says ready, as a plugin's setup may. */
    async function setupStarting(version: string): Promise<string> {
      const src = await sourceWith("alpha", version, { agents: ["claude"], ...SERVER_PERMISSIONS });
      const params = JSON.stringify({ agent: "claude", mcpServers: ["notes"], headless: true, tools: { builtins: "none", allow: ["mcp__notes__append"] } });
      await writeFile(path.join(src, "entry.js"), entry.replace("send({method:'plugin/ready',params:{}});",
        `ask('host/startAgentSession', ${params}).then(r => send({method:'plugin/ready',params:r}), e => process.exit(3));`));
      return src;
    }
    const session = () => ({ sessionId: "agent", prompt: async () => ({ stopReason: "end_turn", text: "" }), cancel: async () => {}, close: async () => {} });
    it("is answered during host.start(), which waits for the setup that asks", async () => {
      const h = host({ startupTimeoutMs: 2_000 }); await h.install(await setupStarting("1.0.0"), consent, terminal);
      const start = vi.fn(async (_request: unknown) => session()); h.setBroker("app-a", { start });
      await h.start();
      expect(start).toHaveBeenCalledOnce();
      expect(start.mock.calls[0]![0]).toMatchObject({ grant: { pluginId: "alpha", version: "1.0.0" } });
      expect((await h.list())[0]!.status).toBe("running");
    });
    it("is answered during an upgrade and a replace, which start the new process under the lock", async () => {
      const h = host({ startupTimeoutMs: 2_000 });
      await h.install(await sourceWith("alpha", "1.0.0", { agents: ["claude"], ...SERVER_PERMISSIONS }), consent, terminal); await h.start();
      const start = vi.fn(async (_request: unknown) => session()); h.setBroker("app-a", { start });
      await h.install(await setupStarting("2.0.0"), consent, terminal);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0]![0]).toMatchObject({ grant: { version: "2.0.0" } });
      const replacing = await setupStarting("2.0.0"); await writeFile(path.join(replacing, "entry.js"), (await readFile(path.join(replacing, "entry.js"), "utf8")) + "\n// changed");
      await h.install(replacing, consent, { terminal: true, replace: true });
      expect(start).toHaveBeenCalledTimes(2);
      expect((await h.list()).map((p) => [p.version, p.status])).toEqual([["2.0.0", "running"]]);
    });
    it("still reads the consent fresh and refuses the start when the record no longer fits", async () => {
      const h = host({ startupTimeoutMs: 2_000 }); await h.install(await setupStarting("1.0.0"), consent, terminal);
      const start = vi.fn(async (_request: unknown) => session()); h.setBroker("app-a", { start });
      await rm(recordPath());
      await expect(h.start()).rejects.toThrow("before ready");
      expect(start).not.toHaveBeenCalled();
    });
  });

  describe("the consent screen", () => {
    it("lists servers and headless tools, says they run as the user with the agent login, and shows the audit path", async () => {
      const h = host(); const { seen, confirm } = asks();
      await h.install(await sourceWith("alpha", "1.0.0", { agents: ["claude"], ...SERVER_PERMISSIONS }), { confirm }, terminal);
      const shown = seen[0]!; const text = shown.lines.join("\n");
      expect(shown.mcpServers).toEqual([{ name: "notes", entry: "dist/notes.js", args: ["--data", "${PLUGIN_DATA}"] }]);
      expect(shown.headless).toEqual(["mcp__notes__append"]);
      expect(text).toContain("notes: dist/notes.js --data ${PLUGIN_DATA}");
      expect(text).toContain("Contained sessions of this plugin (background, or started for one of your pages) may use, without asking you:");
      expect(text).toContain("mcp__notes__append");
      expect(text).toMatch(/servers run as you, with everything you can read, including bridge's agent login for this machine/);
      expect(shown.auditFile).toBe(path.join(auditDir(), "alpha.jsonl"));
      expect(text).toContain(path.join(auditDir(), "alpha.jsonl"));
      expect(shown.surfaceSha256).toBe(surfaceSha256Of(surfaceOf((await h.list())[0]!.manifest)));
      expect(shown.widened).toBe(true);
      expect(shown.diff).toBeUndefined();
      expect(shown.paths?.map((p) => p.action)).toEqual(["install", "data"]);
    });
    it("marks a plain first install as not widened, and shows a diff against the consented surface on an update", async () => {
      const h = host(); const first = asks(); const second = asks();
      await h.install(await source("alpha", "app-a", "1.0.0", { agents: ["claude"], network: ["a.example.com"] }), first);
      expect(first.seen[0]).toMatchObject({ widened: false, mcpServers: [], headless: [] });
      await h.install(await source("alpha", "app-a", "2.0.0", { agents: ["claude", "codex"] }), second, terminal);
      expect(second.seen[0]!.widened).toBe(true);
      expect(second.seen[0]!.diff).toEqual({
        added: [{ kind: "agent", value: "codex" }],
        removed: [{ kind: "network", value: "a.example.com" }],
        unchanged: [{ kind: "agent", value: "claude" }],
      });
      expect(second.seen[0]!.lines.join("\n")).toContain("adds agent codex");
    });
  });

  describe("who may answer", () => {
    it("refuses a widened first install and a widened update from a non-terminal answer, before asking", async () => {
      const h = host(); const confirm = vi.fn(async () => true);
      const withServer = await sourceWith("alpha", "1.0.0", SERVER_PERMISSIONS);
      await expect(h.install(withServer, { confirm }, { nonInteractive: true })).rejects.toThrow(/This install adds .*MCP server notes.*; run it in a terminal to confirm/);
      await expect(h.install(withServer, { confirm })).rejects.toThrow("run it in a terminal to confirm");
      expect(confirm).not.toHaveBeenCalled();
      expect(await h.list()).toEqual([]);
      expect(await exists(recordPath())).toBe(false);
      await h.install(await source("beta", "app-a", "1.0.0", { agents: ["claude"] }), consent, { nonInteractive: true });
      const widened = await source("beta", "app-a", "2.0.0", { agents: ["claude", "codex"] });
      await expect(h.install(widened, { confirm }, { nonInteractive: true })).rejects.toThrow(/This update adds agent codex; run it in a terminal to confirm/);
      expect(confirm).not.toHaveBeenCalled();
      expect((await h.list()).map((p) => p.version)).toEqual(["1.0.0"]);
      expect((await readRecord("beta")).version).toBe("1.0.0");
      // A person at a terminal can approve it.
      await h.install(widened, consent, terminal);
      expect((await readRecord("beta")).version).toBe("2.0.0");
    });
    it("lets a non-interactive answer approve a plain install and an unchanged or narrower update", async () => {
      const h = host();
      await h.install(await source("alpha", "app-a", "1.0.0", { agents: ["claude", "codex"], network: ["a.example.com"] }), consent, { nonInteractive: true });
      await h.install(await source("alpha", "app-a", "1.1.0", { agents: ["claude", "codex"], network: ["a.example.com"] }), consent, { nonInteractive: true });
      await h.install(await source("alpha", "app-a", "1.2.0", { agents: ["claude"] }), consent, { nonInteractive: true });
      expect((await h.list()).map((p) => p.version)).toEqual(["1.2.0"]);
      // The narrower surface is what is consented now: asking for codex again is a widening.
      await expect(h.install(await source("alpha", "app-a", "1.3.0", { agents: ["claude", "codex"] }), consent, { nonInteractive: true })).rejects.toThrow("run it in a terminal");
    });
    describe("an installed plugin whose record does not fit it", () => {
      // The record is judged against the installed manifest, like grantOf does: any other state is "no approval".
      const states: Array<[string, (h: PluginHostWithGrants) => Promise<void>]> = [
        ["missing", async () => { await rm(recordPath()); }],
        ["a hand edit that recomputes its own hash and names more than is installed", async () => {
          const record = await readRecord(); record.surface = { items: [...record.surface.items, { kind: "network", value: "other.example.com" }] };
          record.surfaceSha256 = surfaceSha256Of(record.surface); await writeFile(recordPath(), JSON.stringify(record));
        }],
        ["the record of another surface (a different, narrower installed manifest)", async () => {
          const record = await readRecord(); record.surface = { items: [] };
          record.surfaceSha256 = surfaceSha256Of(record.surface); await writeFile(recordPath(), JSON.stringify(record));
        }],
        ["revoked", async (h) => { await h.revoke("alpha"); }],
      ];
      it.each(states)("treats %s as widened: an update with the same surface or a subset needs a terminal", async (_name, damage) => {
        const h = host(); await h.install(await source("alpha", "app-a", "1.0.0", { agents: ["claude", "codex"] }), consent);
        await damage(h);
        const confirm = vi.fn(async () => true);
        // Even a surface that is unchanged or narrower: nothing recorded fits the installed plugin to compare with.
        await expect(h.install(await source("alpha", "app-a", "1.1.0", { agents: ["claude", "codex"] }), { confirm }, { nonInteractive: true })).rejects.toThrow("run it in a terminal to confirm");
        await expect(h.install(await source("alpha", "app-a", "1.1.0", { agents: ["claude"] }), { confirm })).rejects.toThrow("run it in a terminal to confirm");
        // A replace of the installed version is judged the same way.
        const replacing = await source("alpha", "app-a", "1.0.0", { agents: ["claude", "codex"], network: ["a.example.com"] });
        await expect(h.install(replacing, { confirm }, { replace: true, nonInteractive: true })).rejects.toThrow("run it in a terminal to confirm");
        expect(confirm).not.toHaveBeenCalled();
        expect((await h.list()).map((p) => p.version)).toEqual(["1.0.0"]);
        // A person at a terminal can accept it, is told that nothing earlier is recorded, and a record is written again.
        const { seen, confirm: ask } = asks();
        await h.install(await source("alpha", "app-a", "1.1.0", { agents: ["claude"] }), { confirm: ask }, terminal);
        expect(seen[0]).toMatchObject({ widened: true, diff: { added: [{ kind: "agent", value: "claude" }], removed: [], unchanged: [] } });
        expect(seen[0]!.lines.join("\n")).toContain("No earlier approval of this plugin is recorded");
        expect(await h.grantOf("alpha")).toMatchObject({ version: "1.1.0" });
        // With the record back, the plain rule applies again.
        await h.install(await source("alpha", "app-a", "1.2.0", { agents: ["claude"] }), consent, { nonInteractive: true });
      });
    });
    it("rejects a terminal answer that is also marked non-interactive, and a --yes install of a published source without a pin", async () => {
      const h = host();
      await expect(h.install(await source(), consent, { terminal: true, nonInteractive: true })).rejects.toThrow("both interactive");
      await expect(h.install("https://example.com/p.tgz", consent, { nonInteractive: true })).rejects.toThrow("pinned hash");
      await expect(h.install("npm:alpha@1.0.0", consent, { nonInteractive: true })).rejects.toThrow("pinned hash");
      // With a pin the host goes on to read the package it was handed (here it does not exist).
      await expect(h.install("https://example.com/p.tgz", consent, { nonInteractive: true, pinnedHash: { algorithm: "sha256", digest: "0".repeat(64) } })).rejects.not.toThrow("pinned hash");
    });
  });

  describe("replace", () => {
    it("keeps the same-version error without replace, and names --replace", async () => {
      const h = host(); await h.install(await source(), consent);
      await expect(h.install(await source(), consent)).rejects.toThrow("--replace");
    });
    it("is a no-op success for identical content: no prompt, no restart, nothing rewritten", async () => {
      const h = host(); const p = await h.install(await source(), consent); await h.start();
      const confirm = vi.fn(async () => true); const before = await stat(path.join(p.installDir, "entry.js"));
      const recordBefore = await readFile(recordPath(), "utf8");
      const again = await h.install(await source(), { confirm }, { replace: true });
      expect(again).toMatchObject({ version: "1.0.0", installDir: p.installDir });
      expect(confirm).not.toHaveBeenCalled();
      expect((await stat(path.join(p.installDir, "entry.js"))).ino).toBe(before.ino);
      expect(await readFile(recordPath(), "utf8")).toBe(recordBefore);
      expect(await readdir(path.dirname(p.installDir))).toEqual(["1.0.0"]);
      expect((await h.list())[0]!.status).toBe("running");
    });
    describe("identical content whose approval does not fit the installed plugin", () => {
      // The no-op is for a copy that is the same and approved; a missing, revoked or mismatched record is restored only
      // through the consent screen, by a person.
      const states: Array<[string, (h: PluginHostWithGrants) => Promise<void>]> = [
        ["revoked", async (h) => { await h.revoke("alpha"); }],
        ["missing", async () => { await rm(recordPath()); }],
        ["a record of another, narrower surface", async () => {
          const record = await readRecord(); record.surface = { items: [] };
          record.surfaceSha256 = surfaceSha256Of(record.surface); await writeFile(recordPath(), JSON.stringify(record));
        }],
        ["a hand edit that names more than is installed", async () => {
          const record = await readRecord(); record.surface = { items: [...record.surface.items, { kind: "network", value: "other.example.com" }] };
          record.surfaceSha256 = surfaceSha256Of(record.surface); await writeFile(recordPath(), JSON.stringify(record));
        }],
      ];
      it.each(states)("asks again for an identical --replace when the approval is %s, and writes the grant on yes", async (_name, damage) => {
        const h = host(); const p = await h.install(await source("alpha", "app-a", "1.0.0", { agents: ["claude"] }), consent);
        await damage(h);
        expect(await h.grantOf("alpha")).toBeUndefined();
        // Not a person: refused, nothing asked, still no approval.
        const refused = vi.fn(async () => true);
        await expect(h.install(await source("alpha", "app-a", "1.0.0", { agents: ["claude"] }), { confirm: refused }, { replace: true, nonInteractive: true })).rejects.toThrow("run it in a terminal to confirm");
        expect(refused).not.toHaveBeenCalled();
        expect(await h.grantOf("alpha")).toBeUndefined();
        // A person says no: no approval.
        await expect(h.install(await source("alpha", "app-a", "1.0.0", { agents: ["claude"] }), { confirm: async () => false }, { replace: true, terminal: true })).rejects.toThrow("not confirmed");
        expect(await h.grantOf("alpha")).toBeUndefined();
        // A person says yes: asked about the whole surface, and the approval is back.
        const { seen, confirm } = asks();
        const again = await h.install(await source("alpha", "app-a", "1.0.0", { agents: ["claude"] }), { confirm }, { replace: true, terminal: true });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ widened: true });
        expect(again).toMatchObject({ version: "1.0.0", installDir: p.installDir });
        expect(await h.grantOf("alpha")).toMatchObject({ version: "1.0.0" });
        expect((await readRecord()).surface.items).toContainEqual({ kind: "agent", value: "claude" });
        // With the approval back, the same command is the no-op again.
        const quiet = vi.fn(async () => true);
        await h.install(await source("alpha", "app-a", "1.0.0", { agents: ["claude"] }), { confirm: quiet }, { replace: true });
        expect(quiet).not.toHaveBeenCalled();
      });
    });
    it("compares a directory source, which omits node_modules, with the installed copy as the same package", async () => {
      const h = host(); const p = await h.install(await source(), consent);
      const src = await source(); await mkdir(path.join(src, "node_modules", "dep"), { recursive: true }); await writeFile(path.join(src, "node_modules", "dep", "i.js"), "1");
      // A directory source omits node_modules, so it is the same package as the installed copy.
      const confirm = vi.fn(async () => true);
      await h.install(src, { confirm }, { replace: true });
      expect(confirm).not.toHaveBeenCalled();
      expect(await readdir(p.installDir)).toEqual(["bridge-plugin.json", "entry.js", "package.json"]);
    });
    it("swaps different content in, keeps the data, restarts the plugin and leaves no .old-* or .install-* folder", async () => {
      const h = host(); const p = await h.install(await source("alpha", "app-a", "1.0.0", { agents: ["claude"] }), consent); await h.start();
      await writeFile(path.join(p.dataDir, "saved"), "keep");
      const recordBefore = await readRecord();
      const src = await source("alpha", "app-a", "1.0.0", { agents: ["claude"], network: ["a.example.com"] });
      await writeFile(path.join(src, "entry.js"), entry.replace("let result = params;", "let result = {refreshed:true,params};"));
      const { seen, confirm } = asks();
      const refreshed = await h.install(src, { confirm }, { replace: true, terminal: true });
      expect(refreshed.status).toBe("running");
      expect(seen[0]).toMatchObject({ widened: true, diff: { added: [{ kind: "network", value: "a.example.com" }], removed: [] } });
      expect(await h.router.request(caller, "_alpha/echo", "x")).toEqual({ refreshed: true, params: "x" });
      expect(await readFile(path.join(p.dataDir, "saved"), "utf8")).toBe("keep");
      expect(await readdir(path.dirname(p.installDir))).toEqual(["1.0.0"]);
      expect(await readFile(path.join(p.installDir, "bridge-plugin.json"), "utf8")).toContain("a.example.com");
      expect((await readRecord()).surface.items).toContainEqual({ kind: "network", value: "a.example.com" });
      expect((await readRecord()).surfaceSha256).not.toBe(recordBefore.surfaceSha256);
      expect((await h.list()).map((x) => [x.version, x.status])).toEqual([["1.0.0", "running"]]);
    });
    it("needs a person for a replace that widens the grant", async () => {
      const h = host(); await h.install(await source("alpha", "app-a", "1.0.0", { agents: ["claude"] }), consent);
      const src = await source("alpha", "app-a", "1.0.0", { agents: ["claude", "codex"] });
      await expect(h.install(src, consent, { replace: true, nonInteractive: true })).rejects.toThrow("This update adds agent codex");
      expect(await readFile(path.join((await h.list())[0]!.installDir, "bridge-plugin.json"), "utf8")).not.toContain("codex");
    });
    it("restores the old version when the swap fails midway", async () => {
      const h = host(); const p = await h.install(await source("alpha", "app-a", "1.0.0", { agents: ["claude"] }), consent); await h.start();
      await writeFile(path.join(p.dataDir, "saved"), "keep");
      const recordBefore = await readFile(recordPath(), "utf8");
      const src = await source("alpha", "app-a", "1.0.0", { agents: ["claude", "codex"] });
      await writeFile(path.join(src, "entry.js"), "// different");
      const real = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename;
      // The old folder has stepped aside; putting the staged one in place fails.
      vi.mocked(rename).mockImplementation(async (from, to) => {
        if (String(from).includes(".install-") && String(to) === p.installDir) throw new Error("swap failed");
        return real(from, to);
      });
      try { await expect(h.install(src, consent, { replace: true, terminal: true })).rejects.toThrow("swap failed"); }
      finally { vi.mocked(rename).mockImplementation(real); }
      expect(await readdir(path.dirname(p.installDir))).toEqual(["1.0.0"]);
      expect(await readFile(path.join(p.installDir, "entry.js"), "utf8")).toBe(entry);
      expect(await readFile(path.join(p.dataDir, "saved"), "utf8")).toBe("keep");
      expect(await readFile(recordPath(), "utf8")).toBe(recordBefore);
      expect(await h.router.request(caller, "_alpha/echo", "restored")).toBe("restored");
      expect((await h.list()).map((x) => [x.version, x.status])).toEqual([["1.0.0", "running"]]);
    });
    it("restores the old version, its process and its consent record when the new one fails to start", async () => {
      const h = host({ restartDelayMs: 1_000 }); const p = await h.install(await source("alpha", "app-a", "1.0.0", { agents: ["claude"] }), consent); await h.start();
      const recordBefore = await readFile(recordPath(), "utf8");
      const src = await source("alpha", "app-a", "1.0.0", { agents: ["claude"], network: ["a.example.com"] });
      await writeFile(path.join(src, "entry.js"), "process.exit(1);");
      await expect(h.install(src, consent, { replace: true, terminal: true })).rejects.toThrow("before ready");
      expect(await readdir(path.dirname(p.installDir))).toEqual(["1.0.0"]);
      expect(await readFile(path.join(p.installDir, "entry.js"), "utf8")).toBe(entry);
      expect(await readFile(recordPath(), "utf8")).toBe(recordBefore);
      expect(await h.router.request(caller, "_alpha/echo", "restored")).toBe("restored");
    });
  });

  describe("upgrade pruning", () => {
    it("removes superseded versions after an upgrade, keeps the data and records the newest version", async () => {
      const h = host(); const p = await h.install(await source("alpha", "app-a", "1.0.0"), consent);
      await writeFile(path.join(p.dataDir, "saved"), "keep");
      await h.install(await source("alpha", "app-a", "1.5.0"), consent);
      const latest = await h.install(await source("alpha", "app-a", "2.0.0"), consent);
      expect(await readdir(path.dirname(latest.installDir))).toEqual(["2.0.0"]);
      expect((await h.list()).map((x) => x.version)).toEqual(["2.0.0"]);
      expect(await readFile(path.join(p.dataDir, "saved"), "utf8")).toBe("keep");
      expect((await readRecord()).version).toBe("2.0.0");
      expect((await host().list()).map((x) => x.version)).toEqual(["2.0.0"]);
    });
    it("leaves an older version that is installed after a newer one, and the newest version's record", async () => {
      const h = host(); await h.install(await source("alpha", "app-a", "2.0.0", { agents: ["claude"] }), consent);
      const recordBefore = await readFile(recordPath(), "utf8");
      await h.install(await source("alpha", "app-a", "0.5.0", { agents: ["claude"] }), consent);
      expect((await h.list()).map((x) => x.version)).toEqual(["0.5.0", "2.0.0"]);
      expect(await readFile(recordPath(), "utf8")).toBe(recordBefore);
    });
  });

  describe("remove and keep-data", () => {
    async function withAudit() {
      const h = host(); const p = await h.install(await source(), consent); const other = await h.install(await source("beta"), consent);
      await mkdir(auditDir(), { recursive: true });
      for (const name of ["alpha.jsonl", "alpha.jsonl.1", "beta.jsonl", "unrelated.txt"]) await writeFile(path.join(auditDir(), name), name);
      await writeFile(path.join(p.dataDir, "saved"), "keep"); await writeFile(path.join(other.dataDir, "saved"), "beta");
      return { h, p, other };
    }
    it("keepData removes the install dirs and the consent record, and keeps exactly the data folder and the audit files", async () => {
      const { h, p, other } = await withAudit(); const { seen, confirm } = asks();
      await h.remove("alpha", { confirm }, { keepData: true });
      expect(await exists(p.installDir)).toBe(false);
      expect(await exists(path.dirname(p.installDir))).toBe(false);
      expect(await exists(recordPath())).toBe(false);
      expect(await readFile(path.join(p.dataDir, "saved"), "utf8")).toBe("keep");
      expect((await readdir(auditDir())).sort()).toEqual(["alpha.jsonl", "alpha.jsonl.1", "beta.jsonl", "unrelated.txt"]);
      // The other plugin is untouched.
      expect(await exists(other.installDir)).toBe(true);
      expect(await exists(recordPath("beta"))).toBe(true);
      // The screen lists what goes and what stays.
      const removed = seen[0]!.paths!.map((x) => x.path);
      expect(removed).toEqual([path.dirname(p.installDir), recordPath()]);
      const text = seen[0]!.lines.join("\n");
      expect(text).toContain("Kept (not removed):");
      for (const kept of [p.dataDir, path.join(auditDir(), "alpha.jsonl"), path.join(auditDir(), "alpha.jsonl.1")]) expect(text).toContain(kept);
      expect(text).not.toContain("beta.jsonl");
      expect((await h.list()).map((x) => x.manifest.id)).toEqual(["beta"]);
      // Reinstalling finds the kept data.
      const again = await h.install(await source(), consent);
      expect(await readFile(path.join(again.dataDir, "saved"), "utf8")).toBe("keep");
    });
    it("a plain remove deletes the data folder and the audit files too, and lists them", async () => {
      const { h, p } = await withAudit(); const { seen, confirm } = asks();
      await h.remove("alpha", { confirm });
      expect(await exists(p.dataDir)).toBe(false);
      expect((await readdir(auditDir())).sort()).toEqual(["beta.jsonl", "unrelated.txt"]);
      expect(await exists(recordPath())).toBe(false);
      expect(seen[0]!.paths!.map((x) => x.path)).toEqual([
        path.dirname(p.installDir), recordPath(), p.dataDir, path.join(auditDir(), "alpha.jsonl"), path.join(auditDir(), "alpha.jsonl.1"),
      ]);
      expect(seen[0]!.lines.join("\n")).not.toContain("Kept");
    });
    it("refuses an audit path outside the plugin's audit files and removes nothing", async () => {
      const outside = path.join(temp, "outside.jsonl"); await writeFile(outside, "mine");
      const h = host({ auditFilesOf: () => [outside] }); const p = await h.install(await source(), consent);
      await expect(h.remove("alpha", consent)).rejects.toThrow("outside the plugin's audit files");
      expect(await readFile(outside, "utf8")).toBe("mine");
      expect(await exists(p.installDir)).toBe(true);
    });
    it("refuses a symlinked audit file and leaves its target and the plugin in place", async () => {
      const { h, p } = await withAudit(); const target = path.join(temp, "target.txt"); await writeFile(target, "mine");
      await rm(path.join(auditDir(), "alpha.jsonl")); await symlink(target, path.join(auditDir(), "alpha.jsonl"));
      await expect(h.remove("alpha", consent)).rejects.toThrow("symlink");
      expect(await readFile(target, "utf8")).toBe("mine");
      expect(await exists(p.installDir)).toBe(true);
      expect(await exists(recordPath())).toBe(true);
    });
  });

  describe("revoke", () => {
    it("withdraws the consent without removing the plugin or its data", async () => {
      const h = host(); const p = await h.install(await source(), consent);
      await h.revoke("alpha");
      expect(await exists(recordPath())).toBe(false);
      expect(await h.grantOf("alpha")).toBeUndefined();
      expect(await exists(p.installDir)).toBe(true);
      expect(await exists(p.dataDir)).toBe(true);
      await expect(h.revoke("../alpha")).rejects.toThrow("Invalid plugin id");
      await h.revoke("unknown");
    });
  });
});
