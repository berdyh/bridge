/**
 * The sample's MCP server, `notes`: newline-delimited JSON-RPC on stdio, no SDK. The runner starts it with its
 * own Node for a contained session that attaches it (the manifest names only `entry` and `args`), with
 * `--notes-dir ${PLUGIN_DATA}/notes`: the plugin's own data folder, the one place it reads.
 *
 * One tool, `search` (`mcp__notes__search` to the agent): the lines of the `.md` and `.txt` files directly in
 * the notes folder that contain the query, case-insensitive, at most 20. It only reads (`readOnlyHint`).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const MAX_MATCHES = 20;
const MAX_FILE_BYTES = 256 * 1024;

const TOOLS = [
  {
    name: "search",
    description: "Searches the user's sample notes and returns the matching lines with their file names.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Text to look for" } }, required: ["query"] },
    annotations: { readOnlyHint: true },
  },
];

const flag = process.argv.indexOf("--notes-dir");
const notesDir = flag === -1 ? undefined : process.argv[flag + 1];

/** The matching lines, `<file>: <line>`. Only plain files directly in the folder; nothing outside it is opened. */
function searchNotes(dir: string, query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(path.join(dir, name), "utf8").slice(0, MAX_FILE_BYTES);
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.toLowerCase().includes(needle)) continue;
      matches.push(`${name}: ${line.trim()}`);
      if (matches.length === MAX_MATCHES) return matches;
    }
  }
  return matches;
}

type Message = { id?: string | number | null; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: { query?: unknown } } };

function answer(message: Message): Record<string, unknown> {
  switch (message.method) {
    case "initialize":
      return { result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "sample-notes", version: "0.1.0" } } };
    case "tools/list":
      return { result: { tools: TOOLS } };
    case "tools/call": {
      if (message.params?.name !== "search") return { result: { isError: true, content: [{ type: "text", text: `No tool ${String(message.params?.name)}` }] } };
      const query = message.params.arguments?.query;
      if (typeof query !== "string") return { result: { isError: true, content: [{ type: "text", text: "query must be a string" }] } };
      const found = notesDir ? searchNotes(notesDir, query) : [];
      return { result: { content: [{ type: "text", text: found.length > 0 ? found.join("\n") : `No note mentions "${query}".` }] } };
    }
    default:
      return { error: { code: -32601, message: `Method not found: ${String(message.method)}` } };
  }
}

createInterface({ input: process.stdin })
  .on("line", (line) => {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      return;
    }
    // Notifications (`notifications/initialized`) need no answer.
    if (message.id === undefined || message.id === null) return;
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...answer(message) })}\n`);
  })
  .on("close", () => process.exit(0));
