// A tiny ACP agent for the runner's tests: newline-delimited JSON-RPC on stdio, no SDK.
// Behaviour is driven by the prompt text:
//   hello            -> agent_message_chunk "echo: hello", end_turn
//   ask:<Tool>[:<kind>] -> session/request_permission (toolName in _meta.claudeCode), then
//                       a chunk "outcome:<json>"
//   ask-noname       -> like ask, with no tool name
//   hang             -> waits for session/cancel, then stopReason "cancelled"
//   info             -> a chunk with what the stub saw (pid, cwd, mcpServers, capabilities, ...)
//   fs               -> sends fs/read_text_file to the client, reports the error code
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const seen = { setMode: 0, setConfig: [], initialize: null, newParams: null, cancels: 0, prompts: [] };
let nextOutbound = 1;
const waiting = new Map();
const pendingHang = new Map();
let sessionCounter = 0;
// The options the agent currently declares; set_config_option answers with this whole list, as ACP says.
let configOptions = [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "fast", name: "Fast" }] },
  { id: "autopilot", name: "Autopilot", category: "mode", type: "select", currentValue: "off", options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] },
  { id: "verbose", name: "Verbose", type: "boolean", currentValue: false },
  // An adapter's own permission switch: no category, and nothing in its id or values gives it away.
  { id: "autoApprove", name: "Auto approve", type: "select", currentValue: "off", options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] },
];

const write = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const respond = (id, result) => write({ id, result });
const fail = (id, code, message) => write({ id, error: { code, message } });
const update = (sessionId, text) =>
  write({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextOutbound++;
    waiting.set(id, resolve);
    write({ id, method, params });
  });

async function prompt(id, params) {
  const sessionId = params.sessionId;
  seen.prompts.push(params.prompt);
  const text = params.prompt.map((b) => b.text ?? "").join("");
  if (text === "hello") {
    update(sessionId, "echo: hello");
  } else if (text.startsWith("ask:") || text === "ask-noname") {
    const [, tool, kind] = text.split(":");
    const toolCall = {
      toolCallId: "tc1",
      title: `Run ${tool ?? "tool"}`,
      kind: kind ?? "execute",
      rawInput: { command: "ls" },
      locations: kind === "edit" ? [{ path: `${seen.newParams?.cwd}/a.txt` }] : undefined,
      ...(tool ? { _meta: { claudeCode: { toolName: tool } } } : {}),
    };
    const answer = await ask("session/request_permission", {
      sessionId,
      toolCall,
      options: [
        { optionId: "allow-always", name: "Always", kind: "allow_always" },
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    update(sessionId, `outcome:${JSON.stringify(answer.result?.outcome ?? answer.error)}`);
  } else if (text === "declare-option") {
    // The agent adds an option later, as agents do when they discover what a model supports.
    configOptions = [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "default", options: [] },
      { id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: "low", options: [] },
      { id: "yolo", name: "Yolo", category: "mode", type: "boolean", currentValue: false },
    ];
    write({
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "config_option_update", configOptions } },
    });
  } else if (text === "hang") {
    const outcome = await new Promise((resolve) => pendingHang.set(sessionId, resolve));
    respond(id, { stopReason: outcome });
    return;
  } else if (text === "info") {
    update(
      sessionId,
      JSON.stringify({
        pid: process.pid,
        cwd: process.cwd(),
        newParams: seen.newParams,
        initialize: seen.initialize,
        setMode: seen.setMode,
        setConfig: seen.setConfig,
        prompts: seen.prompts,
        envKeys: Object.keys(process.env).sort(),
        home: process.env.HOME,
      }),
    );
  } else if (text === "leak") {
    // A wrapper that exits while something it started is still running, in the same process group.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    update(sessionId, `leak:${JSON.stringify({ child: child.pid, agent: process.pid })}`);
    respond(id, { stopReason: "end_turn" });
    setTimeout(() => process.exit(0), 100);
    return;
  } else if (text === "fs") {
    const answer = await ask("fs/read_text_file", { sessionId, path: "/etc/hostname" });
    update(sessionId, `fs:${answer.error?.code ?? "ok"}`);
  } else {
    update(sessionId, `unknown prompt: ${text}`);
  }
  respond(id, { stopReason: "end_turn" });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === undefined && m.id !== undefined) {
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
    return;
  }
  switch (m.method) {
    case "initialize":
      seen.initialize = m.params;
      return respond(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] });
    case "session/new":
      seen.newParams = m.params;
      sessionCounter += 1;
      // Fixed id on purpose: two stub processes both say "stub-1", the proxy must not mix them up.
      return respond(m.id, {
        sessionId: "stub-1",
        configOptions,
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "bypassPermissions", name: "Bypass" }] },
      });
    case "session/prompt":
      return void prompt(m.id, m.params);
    case "session/cancel":
      seen.cancels += 1;
      pendingHang.get(m.params.sessionId)?.("cancelled");
      return;
    case "session/set_mode":
      seen.setMode += 1;
      return respond(m.id, {});
    case "session/set_config_option":
      seen.setConfig.push(m.params);
      configOptions = configOptions.map((o) => (o.id === m.params.configId ? { ...o, currentValue: m.params.value } : o));
      return respond(m.id, { configOptions });
    default:
      if (m.id !== undefined) fail(m.id, -32601, `method not found: ${m.method}`);
  }
});
rl.on("close", () => process.exit(0));
