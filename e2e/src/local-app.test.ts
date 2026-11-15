// A local app. No hosted app, relay or Clerk: the machine has no app server at all,
// `bridge apps add-local` makes the app, the e2e plugin is installed into it at a terminal, and `bridge run` serves it.
// The plugin starts its own contained headless session at start (the `autorun.json` seam of the fixture), since no
// page exists to call it.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_ID, ContainedWorld, PLUGIN_ID, containedRequest, steps, type AuditLine } from "./containment-world.js";

const linuxX64 = process.platform === "linux" && process.arch === "x64";

/** The lines of a JSONL file, `[]` when it is not there yet. */
async function linesOf(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function until<T>(read: () => Promise<T | undefined>, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!linuxX64)("a local app runs a plugin's contained session with no hosted app", () => {
  let world: ContainedWorld;
  const pluginLog = () => linesOf(path.join(world.pluginDataDir, "plugin.log"));

  beforeAll(async () => {
    world = await ContainedWorld.create({
      e2ee: false,
      local: true,
      beforeRun: async (w) => {
        const request = containedRequest({ secret: "not-the-canary", tools: { builtins: "none", allow: ["mcp__stub__echo"] } });
        await writeFile(path.join(w.pluginDataDir, "autorun.json"), JSON.stringify({ request, prompts: [steps({ tool: "mcp__stub__echo", via: "ask", input: { text: "local" } })] }));
      },
    });
    // The session is the plugin's own doing: it ends (closed) a moment after the runner is up.
    await until(async () => ((await pluginLog()).some((l) => l.kind === "ended") ? true : undefined), "the plugin's session to end");
  }, 180_000);
  afterAll(async () => {
    await world?.dispose();
  });

  it("starts with the app created by `apps add-local`, no relay connection attempted, and no page or app server anywhere", async () => {
    expect(world.local).toBe(true);
    expect(world.runner.stderr()).toContain("Bridge runner started. Connected apps: mcp-app (local). It stays up until stopped: a local app is served.");
    expect(world.runner.stdout()).not.toMatch(/\[mcp-app\] (connecting|online|reconnecting)/);
    const apps = await world.cli(["apps", "list", "--json"]);
    expect(JSON.parse(apps.stdout)).toEqual([expect.objectContaining({ kind: "local", appId: APP_ID, origin: "local" })]);
    expect(await world.machine.keychainEntries()).toBe(0);
  });

  it("the plugin's contained session ran: it ended `closed` and the stub's echo result came back", async () => {
    const log = await pluginLog();
    const ended = log.filter((l) => l.kind === "ended");
    expect(ended).toEqual([expect.objectContaining({ reason: "closed" })]);
    const prompts = log.find((l) => l.kind === "prompts") as { results: { ok: boolean; text: string }[] };
    expect(prompts.results).toHaveLength(1);
    expect(prompts.results[0]!.ok).toBe(true);
    expect(JSON.parse(prompts.results[0]!.text)).toMatchObject({ results: [{ tool: "mcp__stub__echo", outcome: "selected allow", ran: true, output: "echo: local" }] });
    expect(log.some((l) => l.kind === "autorun-failed" || l.kind === "start-failed")).toBe(false);
    expect(await world.records()).toHaveLength(1);
  });

  it("is audited under the app's own state folder: a headless allow record", async () => {
    const audit = (await linesOf(path.join(world.appStateDir, "audit", `${PLUGIN_ID}.jsonl`))) as unknown as AuditLine[];
    expect(audit.some((r) => r.decision === "allow" && r.trigger?.kind === "headless" && r.toolName === "mcp__stub__echo" && r.appId === APP_ID)).toBe(true);
    // And the person finds the same records through the CLI.
    expect((await world.audit()).some((r) => r.decision === "allow" && r.trigger?.kind === "headless")).toBe(true);
  });

  it("`bridge status --json` shows the link as `local` and no trusted browser", async () => {
    const out = await world.cli(["status", "--json"]);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ running: true, browsers: 0, apps: [{ appId: APP_ID, link: "local", trustedBrowsers: 0, enrollWindowOpen: false }] });
  });

  it("SIGTERM ends the runner with exit 0 and leaves no runner.json", async () => {
    const done = await world.runner.stop();
    expect(done.code).toBe(0);
    expect(done.stderr).not.toContain("will not be retried");
    const status = await world.cli(["status", "--json"]);
    expect(JSON.parse(status.stdout)).toMatchObject({ running: false, apps: [{ appId: APP_ID, link: "not_running" }] });
  });
});
