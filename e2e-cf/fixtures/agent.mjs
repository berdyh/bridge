import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (method === "session/new") send({ id, result: { sessionId: "stub-session" } });
  else if (method === "session/prompt") {
    for (const text of ["stub: ", ...params.prompt.map((block) => block.text)]) send({ method: "session/update", params: {
      sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    } });
    send({ id, result: { stopReason: "end_turn" } });
  } else send({ id, error: { code: -32601, message: "Unknown stub method" } });
});
