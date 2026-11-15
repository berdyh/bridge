import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket as WsSocket } from "ws";
import { aliases } from "../aliases.js";
import { scratchRoot } from "../scratch.mjs";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const requireWrangler = createRequire(realpathSync(path.join(root, "packages/server-cf/node_modules/wrangler/package.json")));
const requireClient = createRequire(path.join(root, "packages/client/package.json"));
export const Ws = requireClient("ws") as typeof import("ws").WebSocket;
const wrangler = path.join(root, "packages/server-cf/node_modules/wrangler/bin/wrangler.js");

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function until(check: () => boolean | Promise<boolean>, label: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error(`Timed out: ${label}`);
    await delay(50);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function stop(child: ChildProcess, graceMs = 2_000): Promise<void> {
  if (!child.pid) return;
  // Each Wrangler process owns its group, including workerd and esbuild.
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit");
  const signal = (value: NodeJS.Signals) => {
    try { process.kill(-child.pid!, value); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  signal("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); })]); }
  finally { clearTimeout(timer); signal("SIGKILL"); }
  await exited;
}

export interface Diagnostic {
  boot: string;
  firstMessage?: { boot: string; message: string };
  sockets: { attachment: { peer: { role: string; runnerId?: string; browserKeyId?: string }; lastInbound: number }; autoResponseAt: number | null }[];
}

/** The wrangler config of the example Worker (it names an `enrollPage`). */
export const exampleConfig = path.join(root, "packages/server-cf/example/wrangler.toml");

export async function startWorker(testAuth = true, config = exampleConfig) {
  const runtime = scratchRoot();
  await mkdir(runtime, { recursive: true });
  const dir = await mkdtemp(path.join(runtime, "run-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const persist = path.join(dir, "state");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: path.join(dir, "config"),
    XDG_CACHE_HOME: path.join(dir, "cache"), XDG_DATA_HOME: path.join(dir, "data"),
    TMPDIR: dir, CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: path.join(dir, "wrangler.log"),
  };
  let child: ChildProcess | undefined;
  let log = "";
  const launch = (args: string[]) => {
    const process = spawn(globalThis.process.execPath, [wrangler, ...args, "--config", config], {
      cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    process.stdout!.on("data", (data) => { log = (log + String(data)).slice(-30_000); });
    process.stderr!.on("data", (data) => { log = (log + String(data)).slice(-30_000); });
    return process;
  };
  try {
    child = launch(["d1", "migrations", "apply", "DB", "--local", "--persist-to", persist]);
    const [code] = await once(child, "exit");
    if (code !== 0) throw new Error(`D1 migration failed: ${log}`);
    child = launch(["dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0",
      "--persist-to", persist, "--var", `APP_ORIGIN:${origin}`, "--var", `BRIDGE_TEST_AUTH:${testAuth ? "1" : "0"}`]);
    let failure: Error | undefined;
    child.on("error", (error) => { failure = error; });
    await until(async () => {
      if (failure) throw failure;
      if (child!.exitCode !== null) throw new Error(`Wrangler exited: ${log}`);
      try { return (await fetch(`${origin}/.well-known/bridge.json`, { signal: AbortSignal.timeout(1_000) })).ok; }
      catch { return false; }
    }, "wrangler dev ready", 40_000);
    return {
      dir, origin,
      async diagnostics(): Promise<Diagnostic> {
        const response = await fetch(`${origin}/__test/state`, { headers: { authorization: "Bearer test-browser" } });
        if (!response.ok) throw new Error(`Diagnostics: ${response.status}`);
        return response.json() as Promise<Diagnostic>;
      },
      async close() { await stop(child!); await rm(dir, { recursive: true, force: true }); },
    };
  } catch (error) {
    if (child) await stop(child);
    await rm(dir, { recursive: true, force: true });
    throw new Error(`${String(error)}\n${log}`);
  }
}

export async function samplePlugin(target: string): Promise<string> {
  const dir = path.join(target, "sample-plugin");
  await mkdir(dir);
  const { build } = requireWrangler("esbuild") as { build(options: Record<string, unknown>): Promise<unknown> };
  await build({ entryPoints: [path.join(root, "examples/sample-plugin/src/plugin.ts")],
    outfile: path.join(dir, "plugin.mjs"), bundle: true, platform: "node", format: "esm", alias: aliases });
  const manifest = JSON.parse(await readFile(path.join(root, "examples/sample-plugin/bridge-plugin.json"), "utf8"));
  // This copy carries the relay test (installed with `--yes`), not contained sessions: drop the sample's agents,
  // MCP server and headless tools, which are not bundled here and would make the grant widened.
  const { agents: _agents, mcpServers: _mcpServers, headless: _headless, ...permissions } = manifest.permissions ?? {};
  await writeFile(path.join(dir, "bridge-plugin.json"), JSON.stringify({ ...manifest, entry: "plugin.mjs", permissions }));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ version: "0.1.0", type: "module" }));
  return dir;
}

export async function cliBinary(target: string): Promise<string> {
  const outfile = path.join(target, "cli.mjs");
  const { build } = requireWrangler("esbuild") as { build(options: Record<string, unknown>): Promise<unknown> };
  await build({ entryPoints: [path.join(root, "e2e-cf/fixtures/cli.ts")], outfile,
    bundle: true, platform: "node", format: "esm", alias: aliases });
  return outfile;
}

export function startCli(binary: string, base: string, args: string[]) {
  let output = "";
  const wire: string[] = [];
  const child = spawn(process.execPath, [binary, ...args], { cwd: root, detached: true,
    env: { PATH: process.env.PATH, HOME: path.join(base, "home"), TMPDIR: base,
      BRIDGE_TEST_ROOT: base, BRIDGE_TEST_WS: requireClient.resolve("ws"),
      BRIDGE_TEST_AGENT: path.join(root, "e2e-cf/fixtures/agent.mjs") }, stdio: ["ignore", "pipe", "pipe"] });
  let partial = "";
  child.stdout!.on("data", (data) => {
    const text = String(data);
    output += text;
    partial += text;
    const lines = partial.split("\n");
    partial = lines.pop()!;
    for (const line of lines) if (line.startsWith("WIRE ")) wire.push((JSON.parse(line.slice(5)) as { text: string }).text);
  });
  let errors = "";
  child.stderr!.on("data", (data) => { const text = String(data); output += text; errors += text; });
  let signal: NodeJS.Signals | null = null;
  const finished = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, sig) => { signal = sig; resolve(code ?? 1); });
  });
  void finished.catch(() => {});
  return { output: () => output, stderr: () => errors, signal: () => signal, wire, finished, close: () => stop(child, 8_000) };
}

export async function cliCommand(binary: string, base: string, args: string[]): Promise<void> {
  const command = startCli(binary, base, args);
  try {
    let timer: NodeJS.Timeout | undefined;
    const code = await Promise.race([command.finished,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`CLI timed out: ${args.join(" ")}`)), 20_000); })]).finally(() => clearTimeout(timer));
    if (code !== 0) {
      // Name the exit signal and any state-file locks left behind, so a flake is diagnosable.
      const locks = (await readdir(base, { recursive: true }).catch(() => [])).filter((name) => name.endsWith(".lock"));
      throw new Error(`CLI "${args.join(" ")}" exited ${code}${command.signal() ? ` (signal ${command.signal()})` : ""}\n` +
        `stderr: ${command.stderr().trim() || "(empty)"}\nlock files present: ${locks.join(", ") || "none"}\n` +
        `stdout: ${command.output().split("\n").filter((line) => !line.startsWith("WIRE ")).join("\n").trim()}`);
    }
  } finally { await command.close(); }
}

export class ObservedSocket extends Ws {
  static all: ObservedSocket[] = [];
  readonly sent: string[] = [];
  readonly received: string[] = [];
  closedCode?: number;
  dropPongs = false;
  constructor(url: string, protocols: string[], options?: import("ws").ClientOptions) {
    super(url, protocols, options);
    ObservedSocket.all.push(this);
    this.on("close", (code) => { this.closedCode = code; });
    this.on("message", (data) => this.received.push(String(data)));
    const send = this.send.bind(this);
    Object.defineProperty(this, "send", { value: (data: unknown, ...args: unknown[]) => {
      if (typeof data === "string") this.sent.push(data);
      return Reflect.apply(send, this, [data, ...args]);
    } });
    const add = this.addEventListener.bind(this);
    Object.defineProperty(this, "addEventListener", { value: (type: string, handler: (event: { data?: unknown }) => void, options?: unknown) => {
      const listener = type === "message" ? (event: { data?: unknown }) => {
        if (!(this.dropPongs && event.data === "bridge:pong")) handler(event);
      } : handler;
      return Reflect.apply(add, this, [type, listener, options]);
    } });
  }
}

export function browserSocket(origin: string): typeof WebSocket {
  return class extends ObservedSocket {
    constructor(url: string, protocols: string[]) { super(url, protocols, { origin }); }
  } as unknown as typeof WebSocket;
}

export async function silentPeer(origin: string): Promise<WsSocket> {
  const socket = new Ws(`${origin.replace("http", "ws")}/relay/browser?browserKeyId=silent-browser`,
    { origin, headers: { authorization: "Bearer test-browser" } });
  await once(socket, "open");
  return socket;
}
