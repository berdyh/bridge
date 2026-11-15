// The contained-session stub agent. It stands where the pinned claude ACP adapter stands (the runner runs it
// as `<node> <adapter entry>`, with the contained env and the empty session cwd) and plays the adapter and the CLI
// behind it for the levers containment depends on. Not a test file: the stub install (`containment-stack.ts`)
// writes an entry that sets `globalThis.__CONTAINMENT_STUB__ = { records, role }` and imports this module.
//
// What it records, in `<records>/spawn-<uuid>.json` (rewritten after every step):
//   pid, ppid, argv, cwd, env              what it was started with
//   sessionNew                             the `session/new` params exactly as received
//   cwdEntries                             what its cwd held when the session started
//   advertised                             the command names of its `available_commands_update` after `session/new`
//   seen                                   the planted files a claude with these options would read (model below)
//   tools                                  the tools it would offer the model: built-ins left by `tools`, plus the
//                                          tools of every attached MCP server (it starts each one and lists them)
//   configDir                              what `$CLAUDE_CONFIG_DIR` holds (names and the login file's keys)
//   mcpChildren                            pids of the MCP servers it started
//   prompts                                every prompt text it received
//
// The loading model (adapter 0.94.0 + CLI 2.1.303 as measured, reduced to what the plants test):
//   settingSources  `_meta.claudeCode.options.settingSources`, else the adapter's default user, project, local
//   project         CLAUDE.md in the cwd and every parent; `<cwd>/.claude/settings.json` (its hooks);
//                   `<cwd>/.mcp.json` unless strictMcpConfig
//   local           `<cwd>/.claude/settings.local.json`
//   user            `$CLAUDE_CONFIG_DIR` (else `$HOME/.claude`): settings.json, CLAUDE.md; `.claude.json`
//                   mcpServers unless strictMcpConfig
//   slash commands  without `extraArgs["disable-slash-commands"]` the CLI advertises its bundled commands too
//
// A prompt is either plain text (echoed) or JSON `{"steps": [...]}`, run in order; the reply is one text chunk,
// JSON `{"results": [...]}`. Steps:
//   {"tool": "<name>", "via": "frame"|"ask"|"askOnly", "input": {...}}
//     frame    a `tool_call` frame, then the call runs with no permission request (a readOnlyHint tool)
//     ask      a `tool_call` frame, then `session/request_permission`; it runs only when allowed
//     askOnly  `session/request_permission` with no frame before it; nothing runs
//   {"commands": ["mcp", ...]}  an `available_commands_update` with these names
// An `mcp__<server>__<tool>` of an attached server runs on that server; any other tool "runs" as a no-op.
//
// `<records>/behaviour.json`, read at start, may hold {"commands": [...]}: the list to advertise after `session/new`
// in place of the model's (the mutation that emits `init`).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const config = globalThis.__CONTAINMENT_STUB__ ?? {};
const records = config.records;
const recordId = randomUUID();
const recordFile = records ? path.join(records, `spawn-${recordId}.json`) : undefined;
let behaviour = {};
try {
  behaviour = records ? JSON.parse(readFileSync(path.join(records, "behaviour.json"), "utf8")) : {};
} catch {
  behaviour = {};
}

const record = {
  id: recordId,
  role: config.role ?? "claude",
  pid: process.pid,
  ppid: process.ppid,
  // A fresh lifecycle namespace intentionally reuses small PIDs. Host observations must
  // bind both the namespace and the process start identity before reading any host /proc.
  pidNamespace: process.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : undefined,
  processStart: process.platform === "linux" ? readFileSync("/proc/self/stat", "utf8").split(") ").at(-1).split(" ")[19] : undefined,
  argv: process.argv,
  cwd: process.cwd(),
  env: { ...process.env },
  startedAt: new Date().toISOString(),
  prompts: [],
  mcpChildren: [],
};
// Written whole and renamed into place, so a reader never sees half a record.
const save = () => {
  if (!recordFile) return;
  writeFileSync(`${recordFile}.tmp`, JSON.stringify(record, null, 1));
  renameSync(`${recordFile}.tmp`, recordFile);
};
save();

const write = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const notifyUpdate = (sessionId, update) => write({ method: "session/update", params: { sessionId, update } });

const BUNDLED_COMMANDS = ["mcp", "remote-control", "init", "compact", "review"];

/** The planted files a claude with `options` in `cwd` would read (the model in the header). */
function seenBy(options, cwd, env) {
  const sources = Array.isArray(options.settingSources) ? options.settingSources : ["user", "project", "local"];
  const strict = options.strictMcpConfig === true;
  const seen = [];
  const look = (file) => {
    if (existsSync(file)) seen.push(file);
  };
  if (sources.includes("project")) {
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      look(path.join(dir, "CLAUDE.md"));
      if (path.dirname(dir) === dir) break;
    }
    look(path.join(cwd, ".claude", "settings.json"));
    if (!strict) look(path.join(cwd, ".mcp.json"));
  }
  if (sources.includes("local")) look(path.join(cwd, ".claude", "settings.local.json"));
  if (sources.includes("user")) {
    const dir = env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? "/nonexistent", ".claude");
    look(path.join(dir, "settings.json"));
    look(path.join(dir, "CLAUDE.md"));
    if (!strict) look(path.join(dir, ".claude.json"));
  }
  return seen;
}

function configDirOf(env) {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (!dir) return null;
  let names = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    names = [];
  }
  let loginKeys = null;
  try {
    loginKeys = Object.keys(JSON.parse(readFileSync(path.join(dir, ".credentials.json"), "utf8"))).sort();
  } catch {
    loginKeys = null;
  }
  return { dir, names, loginKeys };
}

/** One MCP server over stdio: start it, initialize, list its tools. */
function startMcp(entry) {
  const env = { ...process.env };
  for (const pair of Array.isArray(entry.env) ? entry.env : []) if (pair && typeof pair.name === "string") env[pair.name] = String(pair.value ?? "");
  const child = spawn(entry.command, entry.args ?? [], { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "ignore"] });
  record.mcpChildren.push(child.pid);
  let next = 0;
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    const w = waiting.get(m.id);
    if (w) {
      waiting.delete(m.id);
      w(m);
    }
  });
  child.on("error", () => undefined);
  child.on("exit", () => {
    for (const w of waiting.values()) w({ error: { message: "server exited" } });
    waiting.clear();
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const ready = (async () => {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "containment-stub", version: "1" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = await request("tools/list", {});
    return (listed.result?.tools ?? []).map((t) => t.name);
  })();
  return { name: entry.name, child, request, ready };
}

const sessions = new Map();
/** Permission requests waiting for the client's answer, by request id. */
const asking = new Map();
let requests = 0;
let calls = 0;

function askPermission(sessionId, toolCall) {
  const id = `perm-${++requests}`;
  return new Promise((resolve) => {
    asking.set(id, resolve);
    write({
      id,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall,
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
  });
}

async function runTool(session, tool, input) {
  const m = /^mcp__([a-z][a-z0-9-]*)__(.+)$/.exec(tool);
  const server = m ? session.servers.find((s) => s.name === m[1]) : undefined;
  if (!server) return { text: `${tool}: no-op` };
  const answer = await server.request("tools/call", { name: m[2], arguments: input ?? {} });
  return { text: answer.result?.content?.map((c) => c.text ?? "").join("") ?? `error: ${answer.error?.message ?? "none"}` };
}

async function runStep(session, step) {
  if (Array.isArray(step.commands)) {
    notifyUpdate(session.id, { sessionUpdate: "available_commands_update", availableCommands: step.commands.map((name) => ({ name, description: name })) });
    return { commands: step.commands };
  }
  const tool = String(step.tool);
  const via = step.via ?? "ask";
  const toolCallId = `call-${++calls}`;
  const toolCall = { toolCallId, title: tool, kind: /^mcp__/.test(tool) ? "other" : "execute", status: "pending", rawInput: step.input ?? {}, _meta: { claudeCode: { toolName: tool } } };
  if (via !== "askOnly") notifyUpdate(session.id, { sessionUpdate: "tool_call", ...toolCall });
  let outcome = "not asked";
  let allowed = via === "frame";
  if (via === "ask" || via === "askOnly") {
    const answer = await askPermission(session.id, toolCall);
    const o = answer?.outcome;
    allowed = o?.outcome === "selected" && o.optionId === "allow";
    outcome = o?.outcome === "selected" ? `selected ${o.optionId}` : (o?.outcome ?? "no answer");
  }
  if (via === "askOnly") return { tool, via, toolCallId, outcome, ran: false };
  if (!allowed) {
    notifyUpdate(session.id, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", _meta: { claudeCode: { toolName: tool } } });
    return { tool, via, toolCallId, outcome, ran: false };
  }
  const out = await runTool(session, tool, step.input);
  notifyUpdate(session.id, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    rawOutput: out.text,
    content: [{ type: "content", content: { type: "text", text: out.text } }],
    _meta: { claudeCode: { toolName: tool } },
  });
  return { tool, via, toolCallId, outcome, ran: true, output: out.text };
}

async function onPrompt(m) {
  const session = sessions.get(m.params?.sessionId);
  const text = (m.params?.prompt ?? []).map((b) => b.text ?? "").join("");
  record.prompts.push(text);
  save();
  if (!session) return write({ id: m.id, error: { code: -32602, message: "unknown session" } });
  let script;
  try {
    script = JSON.parse(text);
  } catch {
    script = undefined;
  }
  if (!script || !Array.isArray(script.steps)) {
    notifyUpdate(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `stub echo: ${text}` } });
    return write({ id: m.id, result: { stopReason: "end_turn" } });
  }
  const results = [];
  for (const step of script.steps) results.push(await runStep(session, step));
  notifyUpdate(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ results }) } });
  return write({ id: m.id, result: { stopReason: "end_turn" } });
}

async function onSessionNew(m) {
  const params = m.params ?? {};
  const options = params._meta?.claudeCode?.options ?? {};
  record.sessionNew = params;
  record.cwdEntries = readdirSync(process.cwd()).sort();
  record.seen = seenBy(options, process.cwd(), process.env);
  record.configDir = configDirOf(process.env);
  const servers = (Array.isArray(params.mcpServers) ? params.mcpServers : []).map(startMcp);
  const listed = await Promise.all(servers.map(async (s) => (await s.ready).map((t) => `mcp__${s.name}__${t}`)));
  const builtins = Array.isArray(options.tools) ? options.tools : ["<agent default built-ins>"];
  const denied = new Set(Array.isArray(options.disallowedTools) ? options.disallowedTools : []);
  record.tools = [...builtins, ...listed.flat()].filter((t) => !denied.has(t));
  save();
  const id = `stub-${process.pid}-${sessions.size + 1}`;
  sessions.set(id, { id, servers });
  write({
    id: m.id,
    result: {
      sessionId: id,
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "acceptEdits", name: "Accept edits" }, { id: "plan", name: "Plan" }] },
      configOptions: [
        { id: "mode", name: "Mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] },
        { id: "model", name: "Model", type: "select", category: "model", currentValue: "default", options: [{ value: "default", name: "Default" }] },
      ],
    },
  });
  const flag = options.extraArgs && Object.hasOwn(options.extraArgs, "disable-slash-commands");
  const commands = Array.isArray(behaviour.commands) ? behaviour.commands : flag ? ["mcp", "remote-control"] : BUNDLED_COMMANDS;
  record.advertised = commands;
  save();
  notifyUpdate(id, { sessionUpdate: "available_commands_update", availableCommands: commands.map((name) => ({ name, description: name })) });
}

createInterface({ input: process.stdin })
  .on("line", (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.method === undefined) {
      const resolve = asking.get(m.id);
      if (resolve) {
        asking.delete(m.id);
        resolve(m.result);
      }
      return;
    }
    switch (m.method) {
      case "initialize":
        return write({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } });
      case "session/new":
        return void onSessionNew(m);
      case "session/prompt":
        return void onPrompt(m);
      case "session/cancel":
        for (const [id, resolve] of asking) {
          asking.delete(id);
          resolve({ outcome: { outcome: "cancelled" } });
        }
        return;
      default:
        if (m.id !== undefined) write({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
    }
  })
  .on("close", () => {
    for (const s of sessions.values()) for (const server of s.servers) server.child.kill();
    process.exit(0);
  });
