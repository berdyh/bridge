import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, cp, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { createPluginHost } from "../../../packages/runner/src/plugins/host.js";
import { appPathsOf } from "../../../packages/runner/src/paths.js";
import type { PluginHost } from "../../../packages/runner/src/plugins/contracts.js";
import type { AgentSessionBrokerRequest, ResolvedMcpServer } from "../../../packages/runner/src/acp/contracts.js";
import type { JsonRpcMessage } from "@berdyh/bridge-protocol";

const example = fileURLToPath(new URL("../", import.meta.url));
const consent = { confirm: async () => true };
// The sample declares an MCP server and a headless tool, a widened grant: only a person at a terminal may approve it.
const atTerminal = { terminal: true };
const caller = { appId: "sample-app", channelId: "browser", browserKeyId: "key" };
let temp: string | undefined; let host: PluginHost | undefined;
beforeAll(async () => {
  // Exercise the artifact a user installs, including its vendored SDK/protocol.
  execFileSync("pnpm", ["build"], { cwd: example, stdio: "pipe" });
  // Compile the current SDK into the owned artifact without rebuilding outputs
  // in other packages when running isolated source regressions.
  execFileSync("pnpm", ["exec", "tsc", "-p", "../../packages/plugin-sdk/tsconfig.build.json", "--outDir", path.join(example, "dist/sdk")], { cwd: example, stdio: "pipe" });
  for (const file of ["runtime.js", "rpc.js"]) {
    const target = path.join(example, "dist/sdk", file);
    await writeFile(target, (await readFile(target, "utf8")).replaceAll('"@berdyh/bridge-protocol"', '"../protocol/index.js"'));
  }
});
afterEach(async () => { await host?.stopAll(); if (temp) await rm(temp, { recursive: true, force: true }); host = undefined; temp = undefined; });
async function fixture(options: Partial<Parameters<typeof createPluginHost>[0]> = {}) {
  temp = await mkdtemp(path.join(example, ".test-"));
  const pkg = path.join(temp, "package");
  await cp(path.join(example, "dist"), path.join(pkg, "dist"), { recursive: true });
  await cp(path.join(example, "bridge-plugin.json"), path.join(pkg, "bridge-plugin.json"));
  await cp(path.join(example, "package.json"), path.join(pkg, "package.json"));
  host = createPluginHost({ apps: [appPathsOf({ config: path.join(temp, "config"), data: path.join(temp, "base"), state: path.join(temp, "state") }, "sample-app")], ...options });
  return { host, pkg };
}


/** A stdio MCP client on `server` as the runner resolved it (its own Node, the absolute entry first). */
function mcpClient(server: Pick<ResolvedMcpServer, "command" | "args">) {
  const child = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id: number } & Record<string, unknown>;
    pending.get(message.id)?.(message); pending.delete(message.id);
  });
  let next = 0;
  return {
    request(method: string, params: unknown = {}): Promise<Record<string, unknown>> {
      const id = ++next;
      return new Promise((resolve) => { pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
    },
    async close() { child.stdin.end(); if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve)); },
  };
}
const textOf = (reply: Record<string, unknown>) => ((reply.result as { content: { text: string }[] }).content[0]!.text);

describe("sample plugin through a real host process", () => {
  it("echoes and opens a local-only UI; late subscribers also receive the URL", async () => {
    const { host, pkg } = await fixture();
    const messages: JsonRpcMessage[] = []; const wrongApp: JsonRpcMessage[] = [];
    host.router.subscribe(caller, (message) => messages.push(message));
    host.router.subscribe({ ...caller, appId: "other" }, (message) => wrongApp.push(message));
    await host.install(pkg, consent, atTerminal); await host.start("sample-app");
    expect(await host.router.request(caller, "_sample/echo", { message: "hello", nested: [1, null, "🦊"] })).toEqual({ message: "hello", nested: [1, null, "🦊"] });
    const localUi = messages.find((m) => m.method === "_bridge/localUi");
    const { url, pluginId } = localUi!.params as { url: string; pluginId: string };
    expect(pluginId).toBe("sample"); expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(await (await fetch(url)).text()).toContain("Bridge sample plugin");
    expect(wrongApp).toEqual([]);
    const late: JsonRpcMessage[] = []; host.router.subscribe(caller, (message) => late.push(message));
    expect(late).toEqual([localUi]);
    await host.remove("sample", consent); await expect(fetch(url)).rejects.toThrow();
  });
  it("uses the SDK agent session lifecycle with a fake proxy broker", async () => {
    const { host, pkg } = await fixture();
    await writeFile(path.join(pkg, "bridge-plugin.json"), JSON.stringify({ id: "sample", app: "sample-app", entry: "dist/plugin.js", permissions: { agents: ["claude"] } }));
    await writeFile(path.join(pkg, "dist/plugin.js"), `
      import {definePlugin} from './sdk/runtime.js';
      definePlugin(({registerMethod,startAgentSession}) => {
        registerMethod('_sample/agent',async (params,caller) => {
          const session = await startAgentSession({agent:params.agent,onBehalfOf:caller});
          try { const result = await session.prompt('hello'); await session.cancel(); return result; }
          finally {await session.close();await session.close();}
        });
      });
    `);
    const close = vi.fn(async () => {}); const cancel = vi.fn(async () => {});
    const start = vi.fn(async () => ({ sessionId: "broker-session", prompt: async (text: string) => ({ text: `reply: ${text}`, stopReason: "end_turn" }), cancel, close }));
    host.setBroker("sample-app", { start }); await host.install(pkg, consent); await host.start();
    await expect(host.router.request(caller, "_sample/agent", { agent: "codex" })).rejects.toMatchObject({ code: -32012 });
    expect(await host.router.request(caller, "_sample/agent", { agent: "claude" })).toEqual({ text: "reply: hello", stopReason: "end_turn" });
    expect(start).toHaveBeenCalledWith({ pluginId: "sample", appId: "sample-app", agent: "claude", onBehalfOf: { browserKeyId: "key" } });
    expect(cancel).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
  it("keeps console diagnostics off the protocol wire and forwards stderr only to the host logger", async () => {
    const log = vi.fn(); const { host, pkg } = await fixture({ log });
    await writeFile(path.join(pkg, "bridge-plugin.json"), JSON.stringify({ id: "sample", app: "sample-app", entry: "dist/plugin.js", permissions: {} }));
    await writeFile(path.join(pkg, "dist/plugin.js"), `
      import {definePlugin} from './sdk/runtime.js';
      definePlugin(({registerMethod}) => {
        console.log('startup diagnostic %s', '🦊'); console.info('info diagnostic'); console.debug('debug diagnostic');
        console.dir({startupDir:'startup dir diagnostic'}); console.dirxml('startup dirxml diagnostic');
        console.table([{startupTable:'startup table diagnostic'}]);
        registerMethod('_sample/echo', params => {
          console.log('method diagnostic', {value: 42}); console.warn('warning diagnostic'); console.error('error diagnostic');
          console.dir({methodDir:'method dir diagnostic'}); console.dirxml('method dirxml diagnostic');
          console.table([{methodTable:'method table diagnostic'}]);
          return params;
        });
      });
    `);
    const browser: JsonRpcMessage[] = []; const otherApp: JsonRpcMessage[] = [];
    host.router.subscribe(caller, (m) => browser.push(m));
    host.router.subscribe({ ...caller, appId: "other" }, (m) => otherApp.push(m));
    await host.install(pkg, consent); await host.start();
    expect(await host.router.request(caller, "_sample/echo", "still running")).toBe("still running");
    await vi.waitFor(() => expect(log.mock.calls.map((call) => call[2]).join("")).toContain("method table diagnostic"));
    const output = log.mock.calls.map((call) => call[2]).join("");
    for (const text of ["startup diagnostic 🦊", "info diagnostic", "debug diagnostic", "startup dir diagnostic", "startup dirxml diagnostic", "startup table diagnostic", "method diagnostic", "value: 42", "warning diagnostic", "error diagnostic", "method dir diagnostic", "method dirxml diagnostic", "method table diagnostic"]) expect(output).toContain(text);
    expect(log.mock.calls.every((call) => call[0] === "sample" && call[3]?.stream === "stderr")).toBe(true);
    expect(browser).toEqual([]); expect(otherApp).toEqual([]);
    expect((await host.list())[0]?.status).toBe("running");
  });
  it("completes a real SDK call when both agent spawn and prompt exceed the former 30 second deadline", async () => {
    const { host, pkg } = await fixture();
    await writeFile(path.join(pkg, "bridge-plugin.json"), JSON.stringify({ id: "sample", app: "sample-app", entry: "dist/plugin.js", permissions: { agents: ["claude"] } }));
    await writeFile(path.join(pkg, "dist/plugin.js"), `
      import {definePlugin} from './sdk/runtime.js';
      definePlugin(({registerMethod,startAgentSession}) => {
        registerMethod('_sample/agent',async (_params,caller) => {
          const session = await startAgentSession({agent:'claude',onBehalfOf:caller});
          try {return await session.prompt('long turn');} finally {await session.close();}
        });
      });
    `);
    const delay = () => new Promise((resolve) => setTimeout(resolve, 31_000));
    const close = vi.fn(async () => {});
    const start = vi.fn(async () => {
      await delay();
      return { sessionId: "slow-session", prompt: async () => { await delay(); return { text: "finished", stopReason: "end_turn" }; }, cancel: async () => {}, close };
    });
    host.setBroker("sample-app", { start }); await host.install(pkg, consent); await host.start();
    expect(await host.router.request(caller, "_sample/agent", {})).toEqual({ text: "finished", stopReason: "end_turn" });
    expect(start).toHaveBeenCalledWith({ pluginId: "sample", appId: "sample-app", agent: "claude", onBehalfOf: { browserKeyId: "key" } });
    expect(close).toHaveBeenCalledOnce(); await host.stopAll(); expect(close).toHaveBeenCalledOnce();
  }, 90_000);
});

describe("the sample's notes MCP server and headless session", () => {
  it("the notes server lists one read-only tool and finds lines in the notes folder only", async () => {
    temp = await mkdtemp(path.join(example, ".test-"));
    const notes = path.join(temp, "notes");
    await mkdir(path.join(notes, "nested"), { recursive: true });
    await writeFile(path.join(notes, "a.md"), "# Shopping\nbuy OAT milk\nbread\n");
    await writeFile(path.join(notes, "b.txt"), "oat cakes\n");
    await writeFile(path.join(notes, "c.json"), "oat in a file that is not a note\n");
    await writeFile(path.join(notes, "nested", "d.md"), "oat in a nested folder\n");
    await writeFile(path.join(temp, "outside.md"), "oat outside the notes folder\n");
    const manifest = JSON.parse(await readFile(path.join(example, "bridge-plugin.json"), "utf8"));
    // The manifest's server, with `${PLUGIN_DATA}` resolved the way the runner does.
    const declared = manifest.permissions.mcpServers.notes as { entry: string; args: string[] };
    const server = mcpClient({ command: process.execPath, args: [path.join(example, declared.entry), ...declared.args.map((a) => a.replace("${PLUGIN_DATA}", temp!))] });
    try {
      expect((await server.request("initialize", { protocolVersion: "2025-06-18" })).result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "sample-notes" } });
      const { tools } = (await server.request("tools/list")).result as { tools: { name: string; annotations?: unknown }[] };
      expect(tools.map((t) => [t.name, t.annotations])).toEqual([["search", { readOnlyHint: true }]]);
      expect(manifest.permissions.headless.tools).toEqual(tools.map((t) => `mcp__notes__${t.name}`));
      expect(textOf(await server.request("tools/call", { name: "search", arguments: { query: "oat" } }))).toBe("a.md: buy OAT milk\nb.txt: oat cakes");
      expect(textOf(await server.request("tools/call", { name: "search", arguments: { query: "zzz" } }))).toBe('No note mentions "zzz".');
      expect((await server.request("tools/call", { name: "write", arguments: {} })).result).toMatchObject({ isError: true });
      expect((await server.request("resources/list")).error).toMatchObject({ code: -32601 });
    } finally { await server.close(); }
  });

  it("`_sample/ask` runs a contained headless session with only the notes server, whose search finds the seeded note", async () => {
    const { host, pkg } = await fixture();
    const requests: AgentSessionBrokerRequest[] = []; const prompts: string[] = []; const close = vi.fn(async () => {});
    host.setBroker("sample-app", {
      async start(request) {
        requests.push(request);
        return {
          sessionId: "headless-session",
          // The stand-in agent calls the one tool it was given, on the server the runner resolved.
          async prompt(text: string) {
            prompts.push(text);
            const server = mcpClient(request.servers![0]!);
            try {
              await server.request("initialize", { protocolVersion: "2025-06-18" });
              return { text: textOf(await server.request("tools/call", { name: "search", arguments: { query: "keeps its notes" } })), stopReason: "end_turn" };
            } finally { await server.close(); }
          },
          cancel: async () => {}, close,
        };
      },
    });
    await host.install(pkg, consent, atTerminal); await host.start();
    await expect(host.router.request(caller, "_sample/ask", { question: " " })).rejects.toMatchObject({ code: -32602 });
    expect(requests).toEqual([]);
    expect(await host.router.request(caller, "_sample/ask", { question: "Where are my notes kept?" }))
      .toEqual({ text: "welcome.md: The bridge sample plugin keeps its notes in this folder.", stopReason: "end_turn" });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toMatchObject({ pluginId: "sample", appId: "sample-app", agent: "claude", mcpServers: ["notes"], tools: { builtins: "none", allow: ["mcp__notes__search"] }, headless: true, grant: { pluginId: "sample", appId: "sample-app" } });
    // Headless: no browser to ask, no folder of its own choosing, no secret.
    expect(request!.onBehalfOf).toBeUndefined(); expect(request!.cwd).toBeUndefined(); expect(request!.secret).toBeUndefined();
    const [server] = request!.servers!;
    expect(request!.servers).toHaveLength(1);
    expect(server).toMatchObject({ name: "notes", command: process.execPath });
    expect(server!.args).toEqual([expect.stringMatching(/\/dist\/mcp\.js$/), "--notes-dir", expect.stringMatching(/\/notes$/)]);
    expect(path.isAbsolute(server!.args[0]!) && path.isAbsolute(server!.args[2]!)).toBe(true);
    expect(prompts).toEqual([expect.stringContaining("Question: Where are my notes kept?")]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("the grant is widened: an install with no person at a terminal is refused and installs nothing", async () => {
    const { host, pkg } = await fixture();
    await expect(host.install(pkg, consent)).rejects.toThrow(/run it in a terminal to confirm/);
    await expect(host.install(pkg, consent, { nonInteractive: true })).rejects.toThrow(/run it in a terminal to confirm/);
    expect(await host.list()).toEqual([]);
  });
});
