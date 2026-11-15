import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { createConnection } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { request as httpRequest } from "node:http";

const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
const permissions = new Map();
let session;
const rpc = (server, method, params) => new Promise((resolve, reject) => {
  const id = Math.random().toString();
  const read = createInterface({ input: server.stdout });
  const timer = setTimeout(() => { read.close(); reject(new Error(`MCP timeout ${method}`)); }, 10000);
  read.on("line", (line) => { const frame = JSON.parse(line); if (frame.id === id) { clearTimeout(timer); read.close(); resolve(frame.result); } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const reachable = (target) => new Promise((resolve) => {
  const socket = createConnection(target);
  const done = (ok) => { socket.destroy(); resolve(ok); };
  socket.once("connect", () => done(true)); socket.once("error", () => done(false)); socket.setTimeout(300, () => done(false));
});
const direct = (entry, method, params, capability = entry.args[2]) => new Promise((resolve) => {
  const target = new URL(entry.args[1]);
  const proxy = new URL(process.env.HTTP_PROXY);
  const req = httpRequest({ hostname: proxy.hostname, port: proxy.port, path: `${target.href}/send`, method: "POST", headers: { authorization: capability, host: target.host, "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` } }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on("error", () => resolve(0));
  req.end(JSON.stringify({ jsonrpc: "2.0", id: Math.random().toString(), method, params }));
});
const networkProbe = (url) => new Promise((resolve) => {
  const target = new URL(url);
  const proxy = new URL(process.env.HTTP_PROXY);
  const req = httpRequest({ hostname: proxy.hostname, port: proxy.port, method: "CONNECT", path: `${target.hostname}:443`, headers: { host: `${target.hostname}:443`, "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` } });
  req.setTimeout(10000, () => { req.destroy(); resolve(0); });
  req.on("error", () => resolve(0));
  req.on("connect", (res, socket) => {
    if (res.statusCode !== 200) { socket.destroy(); resolve(res.statusCode); return; }
    const tls = tlsConnect({ socket, servername: target.hostname }, () => tls.write(`HEAD / HTTP/1.1\r\nHost: ${target.hostname}\r\nConnection: close\r\n\r\n`));
    tls.setTimeout(10000, () => { tls.destroy(); resolve(0); });
    tls.on("error", () => resolve(0));
    tls.once("data", (chunk) => { const status = /^HTTP\/1\.[01] (\d+)/.exec(chunk.toString()); tls.destroy(); resolve(status ? Number(status[1]) : 0); });
  });
  req.end();
});
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) { permissions.get(message.id)?.(message.result); return; }
  if (message.method === "initialize") { send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "synthetic" } } }); return; }
  if (message.method === "session/new") { session = message.params; send({ id: message.id, result: { sessionId: "synthetic", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "default" }] }, configOptions: [] } }); return; }
  if (message.method !== "session/prompt") return;
  try {
    const plan = JSON.parse(message.params.prompt[0].text);
    const permissionId = "permission";
    const permission = new Promise((resolve) => permissions.set(permissionId, resolve));
    send({ method: "session/request_permission", id: permissionId, params: { sessionId: "synthetic", toolCall: { toolCallId: "script", kind: "execute", _meta: { claudeCode: { toolName: "Bash" } } }, options: [{ optionId: "yes", kind: "allow_once", name: "yes" }, { optionId: "no", kind: "reject_once", name: "no" }] } });
    const approved = (await permission).outcome?.optionId === "yes";
    const script = spawnSync("/bin/bash", ["-c", 'printf SCRIPT_OK > artifacts/proof'], { cwd: session.cwd, encoding: "utf8" });
    const readable = (file) => { try { readFileSync(file); return true; } catch { return false; } };
    const report = {
      approved, script: script.status === 0 && readFileSync(`${session.cwd}/artifacts/proof`, "utf8") === "SCRIPT_OK",
      protectedReadable: readable(plan.protectedFile), outsideHomeReadable: readable(plan.outsideHomeFile),
      selfRoot: readable(`/proc/self/root${plan.protectedFile}`), pidOneRoot: readable(`/proc/1/root${plan.protectedFile}`),
      hostBrokerEnvironment: process.env.BRIDGE_SESSION_BROKER_URL !== undefined,
      protectedEnv: process.env.PROTECTED_CANARY !== undefined,
      ownEnvironment: process.env.HOME !== plan.realHome,
      directLoopback: await reachable({ host: "127.0.0.1", port: plan.port }),
      ipv6Loopback: await reachable({ host: "::1", port: plan.port }),
      numericLoopback: await reachable({ host: "2130706433", port: plan.port }),
      appSocketReachable: plan.appSocket ? await reachable({ path: plan.appSocket }) : false,
      unixSocket: await reachable({ path: plan.socket }), abstractSocket: await reachable({ path: plan.abstractSocket }),
      nestedUserns: spawnSync("/usr/bin/unshare", ["--user", "--map-root-user", "/bin/true"]).status === 0,
      procParent: readable(`/proc/${plan.parentPid}/environ`),
    };
    try { writeFileSync(plan.outsideHomeFile, "PRIVATE_SHADOW_WRITE"); report.outsideWrite = "shadow-or-host"; } catch { report.outsideWrite = "denied"; }
    const entry = session.mcpServers[0];
    if (entry) {
      const server = spawn(entry.command, entry.args, { env: process.env, stdio: ["pipe", "pipe", "inherit"] });
      await rpc(server, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
      const listed = await rpc(server, "tools/list", {});
      report.tools = listed.tools.map((tool) => tool.name);
      report.broker = await rpc(server, "tools/call", { name: "read", arguments: {} });
      if (plan.exerciseHostBudget) {
        report.hostSecond = await rpc(server, "tools/call", { name: "read", arguments: {} });
        report.hostThird = await rpc(server, "tools/call", { name: "read", arguments: {} });
      }
      report.unauthorized = await direct(entry, "tools/call", { name: "admin", arguments: {} });
      report.wrongToken = await direct(entry, "tools/call", { name: "read", arguments: {} }, "wrong-session-token");
      report.resources = await direct(entry, "resources/read", { uri: "file:///etc/shadow" });
      report.capability = { url: entry.args[1], token: entry.args[2] };
      if (plan.sibling) report.sibling = await direct({ args: ["", plan.sibling.url, plan.sibling.token] }, "tools/call", { name: "read", arguments: {} });
      server.kill();
    }
    if (plan.allowedUrl) { report.allowedNetwork = await networkProbe(plan.allowedUrl); report.deniedNetwork = await networkProbe("https://www.iana.org"); }
    send({ method: "session/update", params: { sessionId: "synthetic", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(report) } } } });
    send({ id: message.id, result: { stopReason: "end_turn" } });
  } catch (error) { send({ id: message.id, error: { code: -32603, message: `synthetic probe failed: ${error.message}` } }); }
});
