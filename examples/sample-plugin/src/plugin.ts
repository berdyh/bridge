import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { definePlugin } from "@berdyh/bridge-plugin-sdk";

/** The one tool the sample's headless session may call: `search` on its own `notes` MCP server (`src/mcp.ts`). */
const NOTES_SEARCH = "mcp__notes__search";

const WELCOME = "# Welcome\n\nThe bridge sample plugin keeps its notes in this folder.\nAdd .md or .txt files here and ask about them.\n";

/**
 * The sample plugin: `_sample/echo` returns its params, a tiny local UI page is served on localhost, and
 * `_sample/ask` answers a question from the notes in the plugin's data folder through a contained, headless
 * claude session: no built-in tools, only the sample's `notes` server and its `search` tool, which the user
 * approved for unattended use at install.
 */
export function startSample(): void {
  definePlugin(async ({ registerMethod, startAgentSession, localUi, dataDir, log }) => {
    // The folder the `notes` server reads (`${PLUGIN_DATA}/notes` in the manifest), with one note to find.
    const notes = path.join(dataDir, "notes");
    await mkdir(notes, { recursive: true });
    await writeFile(path.join(notes, "welcome.md"), WELCOME, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });

    registerMethod("_sample/echo", (params) => params);

    registerMethod("_sample/ask", async (params) => {
      const question = (params as { question?: unknown } | null)?.question;
      if (typeof question !== "string" || question.trim() === "") throw Object.assign(new Error("question must be a non-empty string"), { code: -32602 });
      // Headless: no person answers its permission requests, so it gets no `onBehalfOf`; the runner approves
      // only the consented headless tools, and ends the session if the agent reaches for anything else.
      const session = await startAgentSession({
        agent: "claude",
        tools: { builtins: "none", allow: [NOTES_SEARCH] },
        mcpServers: ["notes"],
        headless: true,
      });
      try {
        return await session.prompt(`Answer from the user's notes only; use ${NOTES_SEARCH} to look them up. Question: ${question}`);
      } finally {
        await session.close();
      }
    });

    await localUi.listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Bridge sample</title><h1>Bridge sample plugin</h1><p>This page is served locally by the sample plugin.</p></html>');
    });
    log.info("Sample plugin ready");
  });
}

startSample();
