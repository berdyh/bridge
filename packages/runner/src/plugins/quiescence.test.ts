import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionQuiescence } from "@berdyh/bridge-protocol";
import { describe, expect, it, vi } from "vitest";
import { MEASURED_CLAUDE_STACK, type AgentAdapter, type AgentProcess } from "../acp/contracts.js";
import { claudeProfileOf } from "../acp/containment/claude.js";
import type { ProcessCleanupResult } from "../acp/cleanup.js";
import { createAcpProxy } from "../acp/proxy.js";
import { type RawAgentProcess, spawnAcpProcess } from "../acp/process.js";
import { ManagedPlugin } from "./process.js";
import { surfaceOf, surfaceSha256Of } from "./consent.js";

const probe = process.platform === "linux" ? spawnSync("/usr/bin/unshare", ["--user", "--map-root-user", "--pid", "--fork", "--kill-child=KILL", "--mount-proc", "--", process.execPath, "-e", "process.exit(process.pid===1?0:1)"], { timeout: 2_000 }) : undefined;

async function compileSdk(installDir: string) {
  const compiled = spawnSync(fileURLToPath(new URL("../../../../node_modules/.bin/tsc", import.meta.url)), ["-p", fileURLToPath(new URL("../../../plugin-sdk/tsconfig.build.json", import.meta.url)), "--outDir", installDir], { encoding: "utf8" });
  expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
  const protocol = import.meta.resolve("@berdyh/bridge-protocol");
  const sdk = await readFile(path.join(installDir, "runtime.js"), "utf8");
  await writeFile(path.join(installDir, "runtime.js"), sdk.replaceAll('"@berdyh/bridge-protocol"', JSON.stringify(protocol)));
  await writeFile(path.join(installDir, "package.json"), JSON.stringify({ type: "module" }));
}

describe("SDK to plugin host to proxy quiescence", () => {
  it.skipIf(probe?.status !== 0).each(["close", "cancel", "kill-error", "cleanup-unavailable"])("returns honest cleanup evidence for %s after real namespace/server teardown", async (operation) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-quiescence-wire-"));
    const installDir = path.join(root, "install");
    const dataDir = path.join(root, "data");
    const workspace = path.join(root, "workspace");
    await Promise.all([installDir, dataDir, workspace].map((dir) => mkdir(dir)));
    // Compile the actual SDK into this fixture, independently of sibling dist output.
    await compileSdk(installDir);
    await writeFile(path.join(installDir, "entry.mjs"), `
      import { definePlugin } from './runtime.js';
      definePlugin(context => context.registerMethod('_test/run', async () => {
        const session = await context.startAgentSession({agent:'stub',cwd:${JSON.stringify(workspace)}});
        const turn = await session.prompt('synthetic turn');
        ${operation === "cancel" ? "await session.cancel();" : ""}
        await session.close();
        return {turn, ended:await session.ended, quiescence:await session.quiescence};
      }));
    `);
    const server = `const fs=require('node:fs');const net=require('node:net');const server=net.createServer(s=>s.end('fixture'));server.listen(0,'127.0.0.1',()=>fs.writeFileSync('port',String(server.address().port)));setInterval(()=>fs.appendFileSync('ticks','x'),10)`;
    const child = `const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(server)}],{detached:true,stdio:'ignore'});p.unref();setInterval(()=>{},1000)`;
    const agent = `
      const fs=require('node:fs');const out=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);
        if(m.method==='initialize')out({id:m.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
        else if(m.method==='session/new'){
          require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref();
          out({id:m.id,result:{sessionId:'agent-session'}});
        } else if(m.method==='session/prompt'){
          const ready=setInterval(()=>{if(fs.existsSync('port')&&fs.existsSync('ticks')){clearInterval(ready);out({id:m.id,result:{stopReason:'end_turn'}})}},10);
        }
      });
    `;
    const adapter: AgentAdapter = {
      id: "stub",
      availability: async () => ({ id: "stub", available: true }),
      async spawn(options) {
        // A PID namespace never reports the macOS-only group-empty, so the raw process is a public one.
        const proc = await spawnAcpProcess({ command: process.execPath, args: ["-e", agent], cwd: options.cwd, env: { PATH: process.env.PATH ?? "" }, processTree: "linux-pid-namespace", killGraceMs: 20 }) as AgentProcess;
        if (operation === "cleanup-unavailable") return { ...proc, cleanup: undefined };
        return operation === "kill-error" ? { ...proc, kill: async () => { await proc.kill(); throw new Error("synthetic kill failure"); } } : proc;
      },
    };
    const proxy = createAcpProxy({ appId: "app", adapters: [adapter], defaultCwd: workspace, policy: { mode: "ask", allowSession: () => true, decidePermission: () => ({ action: "cancel" }) } });
    const plugin = new ManagedPlugin({ appId: "app", manifest: { id: "test", app: "app", entry: "entry.mjs", permissions: { agents: ["stub"] } }, version: "1.0.0", installDir, dataDir, status: "stopped" }, { pathBoundary: root, broker: () => proxy.broker, stopTimeoutMs: 100 });
    try {
      await plugin.start();
      const result = await plugin.call("_test/run", {}, { appId: "app", browserKeyId: "browser" }) as { turn: { stopReason: string }; ended: { reason: string }; quiescence: SessionQuiescence };
      expect(result.turn.stopReason).toBe("end_turn");
      expect(result.ended.reason).toBe(operation === "cancel" ? "cancelled" : "closed");
      expect(result.quiescence).toEqual(operation === "cleanup-unavailable"
        ? { status: "incomplete", mechanism: "unknown", reason: "cleanup-unavailable" }
        : operation === "kill-error" ? { status: "incomplete", mechanism: "unknown", reason: "termination-failed" }
          : { status: "quiescent", mechanism: "linux-pid-namespace" });
      expect(proxy.sessionCount()).toBe(0);
      const ticks = await readFile(path.join(workspace, "ticks"), "utf8");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await readFile(path.join(workspace, "ticks"), "utf8")).toBe(ticks);
      const port = Number(await readFile(path.join(workspace, "port"), "utf8"));
      const connected = await new Promise<boolean>((resolve) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
      });
      expect(connected).toBe(false);
    } finally {
      await plugin.stop();
      await proxy.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("delivers an automatic budget cleanup timeout over the real plugin wire when kill and ended hang", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-quiescence-auto-"));
    const installDir = path.join(root, "install");
    const dataDir = path.join(root, "data");
    await Promise.all([installDir, dataDir].map((dir) => mkdir(dir)));
    await compileSdk(installDir);
    await writeFile(path.join(installDir, "entry.mjs"), `
      import { definePlugin } from './runtime.js';
      definePlugin(context=>context.registerMethod('_test/auto',async()=>{
        const session=await context.startAgentSession({agent:'stub',tools:{builtins:'none'},budget:{wallClockMs:1000}});
        const receipt=await session.quiescence;
        const ended=await Promise.race([session.ended.then(()=>false),Promise.resolve(true)]);
        return {receipt,endedPending:ended};
      }));
    `);
    let raw: RawAgentProcess | undefined;
    let releaseKill!: () => void;
    const killed = new Promise<void>((resolve) => { releaseKill = resolve; });
    let releaseCleanup!: (receipt: ProcessCleanupResult) => void;
    const cleaned = new Promise<ProcessCleanupResult>((resolve) => { releaseCleanup = resolve; });
    const profile = claudeProfileOf(MEASURED_CLAUDE_STACK);
    const adapter: AgentAdapter = {
      id: "stub", availability: async () => ({ id: "stub", available: true }), containment: () => profile,
      async spawn(options) {
        await mkdir(options.cwd, { recursive: true, mode: 0o700 });
        raw = await spawnAcpProcess({ command: process.execPath, args: ["-e", `const out=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')out({id:m.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});else if(m.method==='session/new')out({id:m.id,result:{sessionId:'synthetic',modes:{currentModeId:'default',availableModes:[]},configOptions:[]}})});`], cwd: options.cwd, env: { PATH: process.env.PATH ?? "" }, killGraceMs: 20 });
        return { ...raw, sessionNew: { mcpServers: [] }, kill: () => killed, cleanup: () => cleaned };
      },
    };
    const manifest = { id: "test", app: "app", entry: "entry.mjs", permissions: { agents: ["stub"] } };
    const surface = surfaceOf(manifest);
    const proxy = createAcpProxy({ appId: "app", adapters: [adapter], defaultCwd: root,
      policy: { mode: "ask", allowSession: () => true, allowContainedSession: () => ({ allowed: true, budget: { wallClockMs: 60_000, maxToolCalls: 200 } }), decidePermission: () => ({ action: "cancel" }) },
      contained: { sessionsDir: path.join(root, "bridge/sessions"), auditLogOf: () => ({ append() {}, recordFrame() {}, recordDecision() {}, endSession() {} }), resolutionOf: () => ({ installDir, dataDir, surfaceSha256Of }) },
    });
    let ready!: () => void;
    const registered = new Promise<void>((resolve) => { ready = resolve; });
    const plugin = new ManagedPlugin({ appId: "app", manifest, version: "1.0.0", installDir, dataDir, status: "stopped" }, {
      pathBoundary: root, stopTimeoutMs: 100,
      grantOf: async () => ({ pluginId: "test", appId: "app", version: "1.0.0", surface, surfaceSha256: surfaceSha256Of(surface), time: "synthetic" }),
      broker: () => ({ start: async (request) => { const session = await proxy.broker.start(request); ready(); return session; } }),
    });
    try {
      await plugin.start();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const result = plugin.call("_test/auto", {}, { appId: "app", browserKeyId: "browser" });
      void result.catch(() => {});
      await Promise.race([registered, result.then(() => undefined)]);
      await vi.advanceTimersByTimeAsync(31_001);
      await expect(result).resolves.toEqual({ receipt: { status: "incomplete", mechanism: "unknown", reason: "timeout" }, endedPending: true });
      expect(proxy.sessionCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      releaseCleanup({ status: "incomplete", mechanism: "process-group", reason: "descendants-unverified" });
      releaseKill();
      await raw?.kill();
      await plugin.stop();
      await proxy.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
