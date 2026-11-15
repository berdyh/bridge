// The MCP server of the e2e plugin: newline-delimited JSON-RPC on stdio, no SDK. Two tools:
//   read  annotations.readOnlyHint true (claude runs such a tool without a permission request)
//   echo  no hint (claude asks before each call)
// Arguments (from the manifest; the runner substitutes the two placeholders):
//   --secret-file <path>  the per-session secret file. Read once at start.
//   --probe-dir <dir>     where to leave a probe (the plugin's data dir, `${PLUGIN_DATA}`).
// The probe holds the sha256 of what the secret file held, never the secret itself, so the test can tell the
// secret reached this server and nowhere else.
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const secretFile = argOf("--secret-file");
const probeDir = argOf("--probe-dir");

let secret;
let secretMode;
try {
  if (secretFile) {
    secret = readFileSync(secretFile);
    secretMode = (statSync(secretFile).mode & 0o777).toString(8);
  }
} catch {
  secret = undefined;
}
if (probeDir) {
  const probe = {
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    secretFile: secretFile ?? null,
    secretFileMode: secretMode ?? null,
    secretSha256: secret ? createHash("sha256").update(secret).digest("hex") : null,
    secretBytes: secret ? secret.length : 0,
  };
  try {
    writeFileSync(path.join(probeDir, `mcp-probe-${process.pid}.json`), JSON.stringify(probe));
  } catch {
    // A probe that cannot be written shows up as a missing probe in the test.
  }
}

const TOOLS = [
  {
    name: "read",
    description: "Reads a page of the e2e corpus (read only).",
    inputSchema: { type: "object", properties: { page: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "echo",
    description: "Echoes its text.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
];

const write = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);

createInterface({ input: process.stdin })
  .on("line", (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id === undefined) return; // notifications (notifications/initialized) need no answer
    switch (m.method) {
      case "initialize":
        return write({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "e2e-stub-mcp", version: "1.0.0" } } });
      case "tools/list":
        return write({ id: m.id, result: { tools: TOOLS } });
      case "tools/call": {
        const name = m.params?.name;
        const args = m.params?.arguments ?? {};
        if (name === "read") return write({ id: m.id, result: { content: [{ type: "text", text: `page ${String(args.page ?? "")}: read ok` }] } });
        if (name === "echo") return write({ id: m.id, result: { content: [{ type: "text", text: `echo: ${String(args.text ?? "")}` }] } });
        return write({ id: m.id, result: { isError: true, content: [{ type: "text", text: `no tool ${String(name)}` }] } });
      }
      default:
        return write({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
    }
  })
  .on("close", () => process.exit(0));
