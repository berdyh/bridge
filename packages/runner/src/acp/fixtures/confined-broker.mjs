import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const secret = readFileSync(3);
const bearer = secret.toString("utf8");
const hostClient = process.env.BRIDGE_SESSION_BROKER_URL ? await import("./broker-client.js") : undefined;
const digest = createHash("sha256").update(secret).digest("hex");
secret.fill(0);
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result = {};
  if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } };
  if (message.method === "tools/list") result = { tools: [{ name: "read", inputSchema: { type: "object" } }, { name: "admin", inputSchema: { type: "object" } }] };
  if (message.method === "tools/call" && message.params.name === "noisy") result = { content: [{ type: "text", text: "x".repeat(128 * 1024) }] };
  else if (message.method === "tools/call" && hostClient) {
    try {
      const response = await hostClient.requestSessionBroker({ headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ operation: message.params.name, arguments: message.params.arguments }), timeoutMs: 5000 });
      result = response.status === 200 ? JSON.parse(Buffer.from(response.body).toString("utf8")) : { isError: true, content: [{ type: "text", text: "HOST_BUDGET_REFUSED" }] };
    } catch { result = { isError: true, content: [{ type: "text", text: "HOST_SERVICE_FAILED" }] }; }
  } else if (message.method === "tools/call") result = { content: [{ type: "text", text: message.params.name === "read" ? digest : "UNAPPROVED_ADMIN" }] };
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
});
