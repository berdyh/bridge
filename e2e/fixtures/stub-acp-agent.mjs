// A stub ACP agent for the e2e harness: newline-delimited JSON-RPC on stdio, no SDK.
// It runs as a real child process of the runner. Every prompt is answered with one
// agent_message_chunk "agent[<pid>] echo: <prompt text>" and stopReason end_turn.
// A prompt "ask: <command>" first asks the client for permission to run <command> (session/request_permission, a
// once-only allow and reject), waits for the answer and replies "tool ran: <command>" when allowed and
// "tool not run (<outcome>)" otherwise: the permission flow without a real agent.
import { createInterface } from "node:readline";

const write = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
let sessions = 0;
/** Prompts waiting for a permission answer, by the id of the request sent to the client. */
const asking = new Map();
let asks = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === undefined) {
    // A response from the client: the answer to one of our permission requests.
    const waiting = asking.get(m.id);
    if (!waiting) return;
    asking.delete(m.id);
    const outcome = m.result?.outcome;
    const allowed = outcome?.outcome === "selected" && outcome.optionId === "allow";
    const text = allowed ? `tool ran: ${waiting.command}` : `tool not run (${outcome?.outcome === "selected" ? `selected ${outcome.optionId}` : (outcome?.outcome ?? "no answer")})`;
    write({ method: "session/update", params: { sessionId: waiting.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    return write({ id: waiting.promptId, result: { stopReason: "end_turn" } });
  }
  switch (m.method) {
    case "initialize":
      return write({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } });
    case "session/new":
      sessions += 1;
      return write({ id: m.id, result: { sessionId: `stub-${process.pid}-${sessions}` } });
    case "session/prompt": {
      const text = (m.params.prompt ?? []).map((b) => b.text ?? "").join("");
      const ask = text.match(/^ask: (.*)$/s);
      if (ask) {
        const id = `perm-${(asks += 1)}`;
        asking.set(id, { promptId: m.id, sessionId: m.params.sessionId, command: ask[1] });
        return write({
          id,
          method: "session/request_permission",
          params: {
            sessionId: m.params.sessionId,
            toolCall: { toolCallId: `tool-${asks}`, title: ask[1], kind: "execute", status: "pending" },
            options: [
              { optionId: "allow", name: "Allow once", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          },
        });
      }
      write({
        method: "session/update",
        params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `agent[${process.pid}] echo: ${text}` } } },
      });
      return write({ id: m.id, result: { stopReason: "end_turn" } });
    }
    default:
      if (m.id !== undefined) write({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
}).on("close", () => process.exit(0));
