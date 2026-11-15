import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createAcpProxy } from "./proxy.js";
import { createLocalPolicy } from "./policy.js";
import { claudeProfileOf, claudeSessionOptions } from "./containment/claude.js";
import { MEASURED_CLAUDE_STACK, type AuditRecord, type AuditLog } from "./contracts.js";
import { brokerRequestOf } from "../plugins/broker.js";
import { surfaceOf, surfaceSha256Of } from "../plugins/consent.js";
import { confinedExecutionSupport } from "./confined.js";
import { confinedSocketDirectoryFits } from "./confined-sockets.js";
import type { PluginManifest } from "@berdyh/bridge-protocol";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
// Long clean worktrees may select the primary checkout's short .ci-local/s.
// This changes only synthetic fixture placement; every production path check still runs.
const scratch = process.env.BRIDGE_TEST_SOCKET_ROOT ?? path.join(repo, ".ci-local/s");
function requireShortFixtureRoot(): void {
  if (!path.isAbsolute(scratch) || !confinedSocketDirectoryFits(path.join(scratch, "abc-XXXXXX", "b15"))) {
    throw new Error("Unix-socket fixtures need a short absolute base directory (a socket path must fit sun_path); set BRIDGE_TEST_SOCKET_ROOT to one, for example `.ci-local/s` in the checkout");
  }
}
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("shipped confined plugin/session execution", () => {
  it("uses the real namespace/SRT/broker path with synthetic credentials and fail-closed prerequisites", async () => {
    // The production JS entries are the ones included in a published runner pack.
    const { createAcpAgentAdapter } = await import(pathToFileURL(path.join(repo, "packages/runner/dist/acp/adapters.js")).href);
    // Only real sockets need the short root; where confined execution is unsupported the test asserts the refusal.
    if (confinedExecutionSupport().supported) requireShortFixtureRoot();
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(path.join(scratch, "c-"));
    const tmpBase = path.join(root, "tmp");
    const realHome = path.join(root, "host-home");
    const installDir = path.join(root, "install");
    const dataDir = path.join(root, "private-app");
    for (const dir of [tmpBase, realHome, installDir, dataDir]) await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(installDir, "package.json"), JSON.stringify({ name: "synthetic-plugin", type: "module" }));
    await copyFile(fixture("confined-broker.mjs"), path.join(installDir, "broker.mjs"));
    const protectedFile = path.join(dataDir, "oauth-canary");
    const outsideHomeFile = path.join(root, "outside-home-canary");
    await writeFile(protectedFile, "SYNTHETIC_PROTECTED"); await writeFile(outsideHomeFile, "SYNTHETIC_OUTSIDE");
    const adapter = createAcpAgentAdapter({ id: "claude", command: process.execPath,
      environment: { env: { PATH: process.env.PATH, PROTECTED_CANARY: "MUST_NOT_STAGE" }, homedir: realHome, tmpBase },
      socketRuntimeBase: scratch, log: (line: string) => process.stderr.write(line + "\n"),
      containment: { resolve: () => ({ launch: { command: process.execPath, args: [fixture("confined-probe-agent.mjs")], env: {}, profile: claudeProfileOf(MEASURED_CLAUDE_STACK), sessionMeta: () => ({ claudeCode: { options: claudeSessionOptions() } }) } }) },
    });
    let appBroker: ReturnType<typeof createHttpServer> | undefined;
    let proxy: ReturnType<typeof createAcpProxy> | undefined;
    const servers: ReturnType<typeof createServer>[] = [];
    try {
      await copyFile(path.join(repo, "packages/plugin-sdk/dist/broker-client.js"), path.join(installDir, "broker-client.js"));
      const execution = { broker: "http-unix" as const, profile: "confined-v1" as const, network: process.env.BRIDGE_TEST_ALLOWED_NETWORK === "1" ? ["example.com:443"] : [] };
      const manifest: PluginManifest = { id: "synthetic", app: "app-a", entry: "plugin.mjs", permissions: { fs: ["$PLUGIN_DATA/brokers"], agents: ["claude"], execution, mcpServers: { broker: { entry: "broker.mjs", secretTransport: "fd3" } }, headless: { tools: ["mcp__broker__read"] } } };
      const surface = surfaceOf(manifest);
      const grant = { pluginId: manifest.id, appId: manifest.app, version: "1.0.0", time: "now", surface, surfaceSha256: surfaceSha256Of(surface) };
      const secret = "SYNTHETIC_BROKER_SECRET_NEVER_AT_REST";
      let appReads = 0;
      const appSocketDir = path.join(dataDir, "brokers");
      await mkdir(appSocketDir, { mode: 0o700 });
      const appSocket = path.join(appSocketDir, "run.sock");
      appBroker = createHttpServer(async (req, res) => {
        process.stderr.write(`confined: host service method=${req.method} authorized=${req.headers.authorization === `Bearer ${secret}`}\n`);
        if (req.method !== "POST" || req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(403).end(); return; }
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 65536) { res.writeHead(413).end(); return; } }
        const call = JSON.parse(body);
        if (call.operation !== "read" || appReads >= 2) { res.writeHead(429).end(); return; }
        appReads++;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ content: [{ type: "text", text: `HOST_BUDGETED_READ:${appReads}` }] }));
      });
      await new Promise<void>((resolve, reject) => { appBroker!.once("error", reject); appBroker!.listen(appSocket, resolve); });
      const params = { broker: { transport: "http-unix" as const, socket: "brokers/run.sock" }, agent: "claude", execution, secret, mcpServers: ["broker"], tools: { allow: ["mcp__broker__read"] }, budget: { maxToolCalls: 10 } };
      const context = {
        installed: { manifest, appId: manifest.app, version: "1.0.0", installDir, dataDir, status: "running" as const }, runnerNode: process.execPath, pathBoundary: root, grantOf: async () => grant,
      };
      const request = await brokerRequestOf(params, undefined, context);
      await expect(brokerRequestOf({ ...params, broker: { transport: "http-unix", socket: "../other-plugin/endpoint.sock" } }, undefined, context)).rejects.toMatchObject({ code: -32602 });
      await symlink(appSocket, path.join(appSocketDir, "linked.sock"));
      await expect(brokerRequestOf({ ...params, broker: { transport: "http-unix", socket: "brokers/linked.sock" } }, undefined, context)).rejects.toMatchObject({ code: -32016 });
      await writeFile(path.join(appSocketDir, "file.sock"), "not a socket");
      await expect(brokerRequestOf({ ...params, broker: { transport: "http-unix", socket: "brokers/file.sock" } }, undefined, context)).rejects.toMatchObject({ code: -32016 });
      const withoutFs = { items: surface.items.filter((item) => item.kind !== "fs") };
      await expect(brokerRequestOf(params, undefined, { ...context, grantOf: async () => ({ ...grant, surface: withoutFs, surfaceSha256: surfaceSha256Of(withoutFs) }) })).rejects.toMatchObject({ code: -32602 });
      if (process.getuid) {
        const uid = process.getuid(); const changedOwner = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
        try { await expect(brokerRequestOf(params, undefined, context)).rejects.toMatchObject({ code: -32016 }); }
        finally { changedOwner.mockRestore(); }
      }
      const records: AuditRecord[] = [];
      const audit: AuditLog = { append: (record) => { records.push(record); }, recordFrame: () => {}, recordDecision: () => {}, endSession: () => {} };
      proxy = createAcpProxy({ log: (level, message, fields) => process.stderr.write(JSON.stringify({level,message,fields}) + "\n"), defaultCwd: root, appId: "app-a", adapters: [adapter], policy: createLocalPolicy({ agents: ["claude"], pluginApprovals: true, auditFailed: () => false }), contained: { sessionsDir: path.join(root, "bridge/sessions"), auditLogOf: () => audit, resolutionOf: () => ({ installDir, dataDir, surfaceSha256Of }) } });
      if (!confinedExecutionSupport().supported) {
        await expect(proxy.broker.start(request)).rejects.toMatchObject({ code: -32016 });
        return;
      }
      const host = createServer((socket) => socket.destroy()); servers.push(host);
      await new Promise<void>((resolve, reject) => { host.once("error", reject); host.listen(0, "127.0.0.1", resolve); });
      const hostSocket = createServer((socket) => socket.destroy()); servers.push(hostSocket);
      const socket = path.join(root, "host.sock");
      await new Promise<void>((resolve, reject) => { hostSocket.once("error", reject); hostSocket.listen(socket, resolve); });
      const abstract = createServer((socket) => socket.destroy()); servers.push(abstract);
      const abstractSocket = `\0bridge-test-${process.pid}-${Date.now()}`;
      await new Promise<void>((resolve, reject) => { abstract.once("error", reject); abstract.listen(abstractSocket, resolve); });
      const socketBase = scratch;
      await mkdir(socketBase, { recursive: true, mode: 0o700 });
      const session = await proxy.broker.start(request);
      const plan = { appSocket, exerciseHostBudget: true, protectedFile, outsideHomeFile, realHome, port: (host.address() as { port: number }).port, socket, abstractSocket, parentPid: process.pid, ...(execution.network.length ? { allowedUrl: "https://example.com" } : {}) };
      const result = await session.prompt(JSON.stringify(plan));
      const report = JSON.parse(result.text);
      // The selected short base may be shared by independent clean-checkout test runs.
      // Find this fixture's exact manager path through its private launch spec instead
      // of counting other sessions' directories in the shared base.
      const agentDirs = (await readdir(tmpBase)).filter((name) => name.startsWith("bridge-acp-"));
      expect(agentDirs).toHaveLength(1);
      const launchSpec = JSON.parse(await readFile(path.join(tmpBase, agentDirs[0]!, "execution/launch.json"), "utf8")) as { socketDir: string };
      const managerRoot = path.dirname(launchSpec.socketDir);
      expect(path.basename(launchSpec.socketDir)).toBe("a");
      expect(path.dirname(managerRoot)).toBe(socketBase);
      const muxName = (names: string[]) => names.find((name) => /^srt-mux-\d+-\d+\.sock$/.test(name));
      const agentMux = muxName(await readdir(path.join(managerRoot, "a")));
      const brokerMux = muxName(await readdir(path.join(managerRoot, "b0")));
      expect(agentMux).toBeDefined(); expect(brokerMux).toBe(agentMux);
      // The namespace PID-based backend name collides by design; its parent directory must not.
      expect(path.join(managerRoot, "a", agentMux!)).not.toBe(path.join(managerRoot, "b0", brokerMux!));
      expect(report).toMatchObject({ approved: true, script: true, protectedReadable: false, outsideHomeReadable: false, protectedEnv: false, hostBrokerEnvironment: false, selfRoot: false, pidOneRoot: false, ownEnvironment: true, directLoopback: false, ipv6Loopback: false, numericLoopback: false, unixSocket: false, appSocketReachable: false, abstractSocket: false, nestedUserns: false, procParent: false, tools: ["read"], unauthorized: 403, wrongToken: 403, resources: 403 });
      expect(await readFile(outsideHomeFile, "utf8")).toBe("SYNTHETIC_OUTSIDE");
      expect(["denied", "shadow-or-host"]).toContain(report.outsideWrite);
      if (execution.network.length) { process.stderr.write(`confined: network allowed=${report.allowedNetwork} denied=${report.deniedNetwork}\n`); expect(report.allowedNetwork).toBe(200); expect(report.deniedNetwork).toBe(403); }
      expect(report.broker.content[0].text).toBe("HOST_BUDGETED_READ:1");
      expect(report.hostSecond.content[0].text).toBe("HOST_BUDGETED_READ:2");
      expect(report.hostThird.isError).toBe(true);
      expect(appReads).toBe(2);
      expect(records.filter((record) => record.toolName === "mcp__broker__read").map((record) => record.status)).toEqual(["pending", "completed", "pending", "completed", "pending", "failed"]);
      const containsSecret = async (dir: string): Promise<boolean> => {
        for (const item of await readdir(dir, { withFileTypes: true })) {
          const file = path.join(dir, item.name);
          if (item.isDirectory() && await containsSecret(file)) return true;
          if (item.isFile() && (await readFile(file)).includes(Buffer.from(secret))) return true;
        }
        return false;
      };
      expect(await containsSecret(root)).toBe(false);
      expect(JSON.stringify(records)).not.toContain(secret);
      process.stderr.write("confined: first session complete\n");
      const sibling = await proxy.broker.start(request);
      const siblingReport = JSON.parse((await sibling.prompt(JSON.stringify({ ...plan, exerciseHostBudget: false, allowedUrl: undefined, sibling: report.capability }))).text);
      expect(siblingReport.sibling).toBe(403);
      await sibling.close();
      expect(await sibling.quiescence).toMatchObject({ status: "quiescent" });
      await session.close();
      expect(await session.quiescence).toMatchObject({ status: "quiescent" });
      process.stderr.write("confined: sibling session complete\n");
      const budgeted = await proxy.broker.start({ ...request, budget: { maxToolCalls: 1 } });
      await expect(budgeted.prompt(JSON.stringify({ ...plan, exerciseHostBudget: false, allowedUrl: undefined }))).rejects.toMatchObject({ code: -32018 });
      const budgetReceipt = await budgeted.quiescence;
      process.stderr.write(`confined: budget receipt ${JSON.stringify(budgetReceipt)}\n`);
      expect(budgetReceipt).toMatchObject({ status: "quiescent" });
      await expect(proxy.broker.start({ ...request, appId: "other-app" })).rejects.toMatchObject({ code: -32012 });
    } finally {
      await proxy?.close();
      if (appBroker) await new Promise<void>((resolve) => appBroker!.close(() => resolve()));
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      await rm(root, { recursive: true, force: true });
    }
  }, 40_000);
});
