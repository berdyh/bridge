import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, writeFile, lstat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { AgentProcess, ContainmentProfile, ContainmentRequest } from "./contracts.js";
import { ContainmentRefused } from "./contracts.js";
import { assertNoSymlinks } from "../plugins/package.js";
import { type RawAgentProcess, spawnAcpProcess } from "./process.js";

export const CONFINED_BUILTINS = new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
export const CONFINED_PROVIDER_ENDPOINTS = ["api.anthropic.com:443", "platform.claude.com:443"] as const;
export function confinedProfile(base: ContainmentProfile): ContainmentProfile {
  return { ...base, id: "claude-confined-v1", toolOutsideSet: (tool, allow) => !tool.toolName || (!CONFINED_BUILTINS.has(tool.toolName) && !allow.has(tool.toolName)) };
}

/** Closed, non-sensitive capability report. A spawn repeats the prerequisite check. */
export function confinedExecutionSupport(): { supported: boolean; profile: "confined-v1"; platform: "linux-x64"; reason?: "execution_unsupported" | "sandbox_unavailable"; hint?: string } {
  const result = { profile: "confined-v1" as const, platform: "linux-x64" as const };
  if (process.platform !== "linux" || process.arch !== "x64") return { ...result, supported: false, reason: "execution_unsupported", hint: "confined-v1 requires Linux x64 and the bundled Claude adapter" };
  try {
    for (const command of ["bwrap", "socat", "rg", "unshare"]) execFileSync("/bin/sh", ["-c", `command -v ${command}`], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: "ignore", timeout: 2000 });
    execFileSync("unshare", ["--user", "--map-root-user", "--pid", "--fork", "/bin/true"], { stdio: "ignore", timeout: 3000 });
    const req = createRequire(import.meta.url);
    const runtime = req.resolve("@anthropic-ai/sandbox-runtime");
    accessSync(path.join(path.dirname(path.dirname(runtime)), "vendor", "seccomp", "x64", "apply-seccomp"), constants.X_OK);
    return { ...result, supported: true };
  } catch {
    return { ...result, supported: false, reason: "sandbox_unavailable", hint: "Install bubblewrap, socat, ripgrep and util-linux; enable unprivileged user namespaces; run bridge doctor --containment" };
  }
}

/** Only installed package dependency closures, never a project/repository or user's whole home. */
export function runtimeReadPaths(entries: readonly string[]): string[] {
  const paths = new Set<string>([realpathSync(process.execPath)]);
  const seen = new Set<string>();
  function packageAt(entry: string): void {
    const real = realpathSync(entry);
    paths.add(real);
    // A native binary is a file, not an npm package. Walking its ancestors
    // could accidentally treat a user HOME package.json as a runtime package.
    if (!/\.(?:[cm]?js|json|ts)$/.test(real)) { paths.add(real); return; }
    let dir = path.dirname(real);
    while (!existsSync(path.join(dir, "package.json"))) {
      const parent = path.dirname(dir);
      if (dir === parent) { paths.add(real); return; }
      dir = parent;
    }
    if (seen.has(dir)) return;
    seen.add(dir);
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    // A runner's workspace package contains no app data, but granting the whole
    // monorepo would include runtime state and other sessions. Only its dist.
    // The workspace root is found by its pnpm-workspace.yaml, never by its package
    // name: a renamed checkout must not widen the grant to the whole repository.
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) { paths.add(real); return; }
    paths.add(pkg.name?.startsWith("@berdyh/") && existsSync(path.join(dir, "dist")) ? path.join(dir, "dist") : dir);
    const require = createRequire(path.join(dir, "package.json"));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      try { packageAt(require.resolve(`${name}/package.json`)); }
      catch { try { packageAt(require.resolve(name)); } catch { /* optional dependency absent */ } }
    }
  }
  for (const entry of entries) packageAt(entry);
  return [...paths];
}

/** Every host path starts denied, including apps installed outside the user's home. */
export function confinedSettings(read: readonly string[], write: readonly string[], network: readonly string[], socket?: string): SandboxRuntimeConfig {
  return {
    network: { allowedDomains: [...network], deniedDomains: [], strictAllowlist: true, allowAllUnixSockets: false, allowLocalBinding: false,
      deniedResolvedAddresses: ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4", "240.0.0.0/4", "::/128", "::1/128", "::ffff:0:0/96", "fc00::/7", "fe80::/10", "ff00::/8"] },
    filesystem: { denyRead: ["/"], allowRead: [...read, "/usr/lib", "/lib", "/lib64", "/usr/bin", "/bin", "/etc/ssl/certs", "/etc/ld.so.cache", "/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/hosts", ...(socket ? [socket] : [])], allowWrite: [...write], denyWrite: [] },
    allowNestedUserNamespaces: false, enableWeakerNestedSandbox: false,
  };
}

export async function validateHostBrokerSocket(target: { socketPath: string; dataDir: string }): Promise<void> {
  if (Buffer.byteLength(target.socketPath) > 100) throw new ContainmentRefused("host broker socket path exceeds Unix socket budget");
  const relative = path.relative(target.dataDir, target.socketPath);
  if (!path.isAbsolute(target.dataDir) || !relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new ContainmentRefused("host broker socket leaves plugin data");
  await assertNoSymlinks(target.socketPath, path.dirname(target.dataDir));
  const info = await lstat(target.socketPath);
  if (!info.isSocket() || (process.getuid && info.uid !== process.getuid())) throw new ContainmentRefused("host broker socket is not an owned Unix socket");
}

const worker = fileURLToPath(new URL("./confined-worker.js", import.meta.url));
const client = fileURLToPath(new URL("./confined-client.js", import.meta.url));

export async function writeConfinedLaunch(dir: string, command: string, args: readonly string[], settings: SandboxRuntimeConfig, secretFd = false, socketDir = dir): Promise<{ command: string; args: string[] }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const spec = path.join(dir, "launch.json");
  await writeFile(spec, JSON.stringify({ command, args, settings, secretFd, socketDir }), { flag: "wx", mode: 0o600 });
  return { command: process.execPath, args: [worker, spec] };
}

/** Runner-owned server processes. Agent transports know only a separate revocable capability. */
export async function startConfinedBrokers(request: ContainmentRequest, root: string, env: Record<string, string>, _runtime: readonly string[], socketDir = path.dirname(root)): Promise<{ servers: NonNullable<AgentProcess["sessionNew"]>["mcpServers"]; mitm: { socketPath: string; domains: string[] }; close(): Promise<boolean> }> {
  const running: RawAgentProcess[] = [];
  const sockets = new Set<Socket>();
  const feeds = new Map<number, ServerResponse>();
  const queues = new Map<number, string[]>();
  const pending = new Map<string, { callId: string; toolName: string }>();
  const listings = new Set<string>();
  let active = true;
  let toolCalls = 0;
  const token = randomBytes(32).toString("hex");
  const hostname = `bridge-${randomBytes(16).toString("hex")}.invalid`;
  const endpoint = path.join(socketDir, "m.sock");
  if (Buffer.byteLength(endpoint) > 100) throw new ContainmentRefused("the private MCP endpoint path is too long");
  const digest = createHash("sha256").update(token).digest("hex");
  let inflight = 0;
  const listener = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
    if (inflight >= 64) { res.writeHead(429).end(); return; }
    inflight++;
    let counted = true;
    const finished = () => { if (counted) { counted = false; inflight--; } };
    res.once("close", finished);
    res.once("finish", finished);
    if (req.headers.origin !== undefined) { res.writeHead(403).end(); return; }
    const capability = req.headers.authorization;
    if (!active || typeof capability !== "string" || createHash("sha256").update(capability).digest("hex") !== digest) { res.writeHead(403).end(); return; }
    let url: URL;
    try { url = new URL(req.url ?? "/", `http://${hostname}:443`); } catch { res.writeHead(400).end(); return; }
    const match = /^\/(\d+)\/(events|send)$/.exec(url.pathname);
    const index = match ? Number(match[1]) : -1;
    const proc = running[index];
    if (!proc || url.search || url.hash || url.username || url.password || url.hostname !== hostname || url.port !== "443") { res.writeHead(404).end(); return; }
    if (req.method === "GET" && match![2] === "events") {
      if (feeds.has(index)) { res.writeHead(409).end(); return; }
      feeds.set(index, res);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.flushHeaders();
      for (const frame of queues.get(index) ?? []) { if (!res.write(frame)) { active = false; res.destroy(); void proc.kill(); break; } }
      queues.set(index, []);
      res.once("close", () => { if (feeds.get(index) === res) feeds.delete(index); });
      return;
    }
    if (req.method !== "POST" || match![2] !== "send") { res.writeHead(405).end(); return; }
    let body = "";
    req.setEncoding("utf8");
    try {
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 1 << 20) { res.writeHead(413).end(); req.destroy(); return; }
      }
      const frame: unknown = JSON.parse(body);
      if (typeof frame !== "object" || frame === null || Array.isArray(frame) || (frame as { jsonrpc?: unknown }).jsonrpc !== "2.0") throw new Error("invalid frame");
      const rpc = frame as { method?: unknown; params?: unknown };
      if (!["initialize", "ping", "tools/list", "tools/call", "notifications/initialized", "notifications/cancelled"].includes(String(rpc.method))) { res.writeHead(403).end(); return; }
      const id = (frame as { id?: unknown }).id;
      const notification = String(rpc.method).startsWith("notifications/");
      const validId = (typeof id === "string" && Buffer.byteLength(id) <= 128) || (typeof id === "number" && Number.isSafeInteger(id));
      if (notification ? id !== undefined : !validId) { res.writeHead(400).end(); return; }
      const frameKey = `${index}:${JSON.stringify(id)}`;
      if (rpc.method === "tools/list") {
        if (listings.has(frameKey) || listings.size >= 256) { res.writeHead(429).end(); return; }
        listings.add(frameKey);
      }
      if (rpc.method === "tools/call") {
        const params = rpc.params as { name?: unknown } | undefined;
        const name = params?.name;
        if (typeof name !== "string" || !request.allow.includes(`mcp__${request.servers[index]!.name}__${name}`)) { res.writeHead(403).end(); return; }
        if (typeof id !== "string" && typeof id !== "number") { res.writeHead(400).end(); return; }
        if (pending.has(frameKey)) { res.writeHead(409).end(); return; }
        if (toolCalls >= (request.maxToolCalls ?? 200)) { res.writeHead(429).end(); return; }
        const callId = randomUUID();
        const toolName = `mcp__${request.servers[index]!.name}__${name}`;
        pending.set(frameKey, { callId, toolName });
        const allowed = request.brokerTools && await request.brokerTools.before(callId, toolName, (params as { arguments?: unknown }).arguments);
        if (!allowed || !active) {
          if (pending.delete(frameKey) && allowed) await request.brokerTools?.after(callId, toolName, true);
          res.writeHead(403).end(); return;
        }
        toolCalls++;
      }
      if (!active) { res.writeHead(403).end(); return; }
      await proc.stream.send(frame as import("@berdyh/bridge-protocol").JsonRpcMessage); res.writeHead(204).end(); }
    catch { res.writeHead(400).end(); }
  });
  listener.maxConnections = 64;
  listener.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  let listening = false;
  let closing: Promise<boolean> | undefined;
  const close = () => closing ??= (async () => {
    active = false;
    const interrupted = [...pending.values()];
    pending.clear();
    for (const res of feeds.values()) res.destroy();
    feeds.clear();
    for (const socket of sockets) socket.destroy();
    if (listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
    const receipts = await Promise.all(running.map(async (proc) => { try { return proc.cleanup ? (await proc.cleanup()).status === "quiescent" : (await proc.kill(), false); } catch { return false; } }));
    let timer: NodeJS.Timeout | undefined;
    let audited: boolean;
    try { audited = await Promise.race([
      Promise.all(interrupted.map((call) => request.brokerTools?.after(call.callId, call.toolName, true))).then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 3000); }),
    ]); } finally { clearTimeout(timer); }
    return receipts.every(Boolean) && audited;
  })();
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const servers = [];
    for (const [index, server] of request.servers.entries()) {
      if (server.secretTransport !== "fd3" || server.args.some((a) => a.includes("${SESSION_SECRET_FILE}"))) throw new ContainmentRefused("confined-v1 brokers require fd3 transport");
      const dir = path.join(root, `b${index}`);
      await mkdir(dir, { mode: 0o700 });
      const home = path.join(dir, "home");
      await mkdir(home, { mode: 0o700 });
      const brokerRuntime = runtimeReadPaths([server.args[0]!]);
      const settings = confinedSettings([...brokerRuntime, ...runtimeReadPaths([worker])], [home], request.execution!.network);
      let hostServiceUrl: string | undefined;
      if (request.hostBroker) {
        if (request.execution?.broker !== "http-unix") throw new ContainmentRefused("host broker service was not consented");
        await validateHostBrokerSocket(request.hostBroker);
        const hostService = `service-${randomBytes(16).toString("hex")}.invalid`;
        settings.network.allowedDomains.push(`${hostService}:443`);
        settings.network.mitmProxy = { socketPath: request.hostBroker.socketPath, domains: [hostService] };
        hostServiceUrl = `http://${hostService}:443`;
      }
      // SRT names its internal mux backend by PID. Each outer PID namespace
      // reuses PID2, so every manager must have a distinct host TMPDIR.
      const managerSocketDir = path.join(socketDir, `b${index}`);
      await mkdir(managerSocketDir, { mode: 0o700 });
      const spec = await writeConfinedLaunch(dir, server.command, server.args, settings, true, managerSocketDir);
      const proc = await spawnAcpProcess({ ...spec, cwd: home, env: { PATH: env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, ...(hostServiceUrl ? { BRIDGE_SESSION_BROKER_URL: hostServiceUrl } : {}) }, processTree: "linux-pid-namespace", secretInput: request.secret ? Uint8Array.from(request.secret) : new Uint8Array() });
      running.push(proc);
      queues.set(index, []);
      proc.stream.onMessage((frame) => {
        if (!active) return;
        const response = frame as { id?: unknown; result?: { tools?: { name?: unknown }[]; isError?: unknown }; error?: unknown };
        const key = `${index}:${JSON.stringify(response.id)}`;
        if (listings.delete(key) && Array.isArray(response.result?.tools)) response.result.tools = response.result.tools.filter((tool) => typeof tool.name === "string" && request.allow.includes(`mcp__${server.name}__${tool.name}`));
        const call = pending.get(key);
        if (call) {
          pending.delete(key);
          void request.brokerTools?.after(call.callId, call.toolName, response.error !== undefined || response.result?.isError === true).catch(() => { active = false; void proc.kill(); });
        }
        const line = `${JSON.stringify(frame)}\n`;
        const feed = feeds.get(index);
        if (Buffer.byteLength(line) > 1 << 20) { active = false; feed?.destroy(); void proc.kill(); return; }
        if (feed) { if (!feed.write(line)) { active = false; feed.destroy(); void proc.kill(); } }
        else { const queue = queues.get(index)!; if (queue.length >= 256 || queue.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) + Buffer.byteLength(line) > 1 << 20) { active = false; void proc.kill(); } else queue.push(line); }
      });
      servers.push({ name: server.name, command: process.execPath, args: [client, `http://${hostname}:443/${index}`, token], env: [] as [] });
    }
    await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(endpoint, () => { listening = true; resolve(); }); });
    await chmod(endpoint, 0o600);
    return { servers, mitm: { socketPath: endpoint, domains: [hostname] }, close };
  } catch (error) { const clean = await close(); if (!clean) throw Object.assign(new Error("broker startup cleanup incomplete"), { incompleteCleanup: true }); throw error; }
}

export function sandboxRuntimeReadPaths(): string[] { return runtimeReadPaths([createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime")]); }
