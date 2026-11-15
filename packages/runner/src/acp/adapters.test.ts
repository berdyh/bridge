import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAcpAgentAdapter, createDefaultAgentAdapters } from "./adapters.js";
import { claudeContainmentSupportWithSeams } from "./containment/claude.js";
import { createEmptySessionDir } from "./containment/index.js";
import { CLAUDE_CONTAINMENT_OPTIONS, ContainmentRefused, type AgentExit, type AgentProcess, type ContainmentRequest } from "./contracts.js";
import { type RawAgentProcess, type SpawnAcpProcessOptions, spawnAcpProcess } from "./process.js";
import type { ProcessCleanupResult, RawProcessCleanupResult } from "./cleanup.js";
import { isSessionQuiescence } from "@berdyh/bridge-protocol";
import { createRpcPeer } from "./rpc.js";

/** Containment is measured on Linux x64 only (`resolveClaudeStack`); elsewhere a contained spawn is refused. */
const linuxX64 = process.platform === "linux" && process.arch === "x64";
const STUB = fileURLToPath(new URL("./fixtures/stub-agent.mjs", import.meta.url));

let root: string;
let tmpBase: string;
let home: string;
let project: string;
const spawned: RawAgentProcess[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bridge-adapter-"));
  tmpBase = path.join(root, "tmp");
  home = path.join(root, "home");
  project = path.join(root, "project");
  await Promise.all([tmpBase, home, project].map((d) => mkdir(d, { recursive: true })));
});
afterEach(async () => {
  await Promise.all(spawned.splice(0).map((p) => p.kill()));
  await rm(root, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition not met in time");
}

/** Runs the stub through the adapter and asks it what it saw. */
async function probe(proc: RawAgentProcess) {
  const peer = createRpcPeer(proc.stream, { onRequest: () => null, onNotification: (m, p) => m === "session/update" && updates.push(p) });
  const updates: unknown[] = [];
  await peer.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  await peer.request("session/new", { cwd: project, mcpServers: [] });
  await peer.request("session/prompt", { sessionId: "stub-1", prompt: [{ type: "text", text: "info" }] });
  const text = (updates[0] as { update: { content: { text: string } } }).update.content.text;
  return JSON.parse(text) as { pid: number; cwd: string; envKeys: string[]; home: string };
}

describe("createAcpAgentAdapter", () => {
  const env = () => ({
    PATH: path.dirname(process.execPath),
    ANTHROPIC_API_KEY: "sk-secret",
    GITHUB_TOKEN: "ghp-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
  });

  it("reports availability: missing command, present command, and missing login", async () => {
    const environment = { env: env(), homedir: home, tmpBase };
    const missing = createAcpAgentAdapter({ id: "x", command: "definitely-not-installed-acp", environment });
    expect(await missing.availability()).toEqual({ id: "x", available: false });

    const present = createAcpAgentAdapter({ id: "x", command: process.execPath, environment });
    expect(await present.availability()).toEqual({ id: "x", available: true });

    const needsLogin = createAcpAgentAdapter({ id: "claude", command: process.execPath, environment, credentialsFor: "claude-code" });
    expect(await needsLogin.availability()).toEqual({ id: "claude", available: false });
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a" } }));
    expect(await needsLogin.availability()).toEqual({ id: "claude", available: true });
  });

  it("runs the agent in the session cwd with a stripped env and its own HOME, then removes the sandbox", async () => {
    const adapter = createAcpAgentAdapter({
      id: "stub",
      command: process.execPath,
      args: [STUB],
      environment: { env: env(), homedir: home, tmpBase },
    });
    const proc = await adapter.spawn({ cwd: project });
    spawned.push(proc);
    const seen = await probe(proc);
    expect(seen.cwd).toBe(project);
    expect(seen.envKeys).not.toContain("ANTHROPIC_API_KEY");
    expect(seen.envKeys).not.toContain("GITHUB_TOKEN");
    expect(seen.envKeys).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(seen.home?.startsWith(tmpBase)).toBe(true);
    expect(await readdir(tmpBase)).toHaveLength(1);
    expect(alive(proc.pid!)).toBe(true);

    await proc.kill();
    expect(alive(proc.pid!)).toBe(false);
    expect(await readdir(tmpBase)).toEqual([]);
    await expect(proc.exited).resolves.toBeDefined();
    await proc.kill(); // idempotent
  });

  it("stages only the agent's own login into the sandbox", async () => {
    const login = path.join(home, "config/bridge/agents/claude/.credentials.json"); // bridge's own copy
    await mkdir(path.dirname(login), { recursive: true });
    await writeFile(
      login,
      JSON.stringify({ claudeAiOauth: { accessToken: "a" }, mcpOAuth: { other: { accessToken: "unrelated" } } }),
    );
    const adapter = createAcpAgentAdapter({
      id: "claude",
      command: process.execPath,
      args: [STUB],
      credentialsFor: "claude-code",
      authFiles: { "claude-code": login },
      environment: { env: env(), homedir: home, tmpBase },
    });
    const proc = await adapter.spawn({ cwd: project });
    spawned.push(proc);
    const seen = await probe(proc);
    expect(seen.envKeys).toContain("CLAUDE_CONFIG_DIR");
    expect(seen.envKeys).not.toContain("ANTHROPIC_API_KEY");
  });

  it("kills the agent when the spawn signal aborts", async () => {
    const adapter = createAcpAgentAdapter({ id: "stub", command: process.execPath, args: [STUB], environment: { env: env(), homedir: home, tmpBase } });
    const controller = new AbortController();
    const proc = await adapter.spawn({ cwd: project, signal: controller.signal });
    spawned.push(proc);
    controller.abort();
    await proc.exited;
    expect(alive(proc.pid!)).toBe(false);
  });

  it("does not start, or kills at once, an agent whose signal aborts during sandbox setup", async () => {
    const environment = { env: env(), homedir: home, tmpBase };
    const already = new AbortController();
    already.abort();
    await expect(createAcpAgentAdapter({ id: "x", command: process.execPath, args: [STUB], environment }).spawn({ cwd: project, signal: already.signal })).rejects.toThrow(/aborted/);

    // Aborts while the child is being started: the test seam fires the signal at that moment.
    const controller = new AbortController();
    let child: RawAgentProcess | undefined;
    const adapter = createAcpAgentAdapter({
      id: "x",
      command: process.execPath,
      args: [STUB],
      environment,
      spawnProcess: async (o) => {
        child = await spawnAcpProcess(o);
        controller.abort();
        return child as AgentProcess; // a non-staged spawn never reports the macOS-only group-empty
      },
    });
    await expect(adapter.spawn({ cwd: project, signal: controller.signal })).rejects.toThrow(/aborted/);
    await child!.exited;
    expect(alive(child!.pid!)).toBe(false);
    expect(await readdir(tmpBase)).toEqual([]);
  });

  it("rejects when the command is not installed or cannot start, leaving no sandbox behind", async () => {
    const environment = { env: env(), homedir: home, tmpBase };
    await expect(createAcpAgentAdapter({ id: "x", command: "nope-acp", environment }).spawn({ cwd: project })).rejects.toThrow(/not installed/);

    const notExec = path.join(root, "broken");
    await writeFile(notExec, "#!/nonexistent/interpreter\n");
    await chmod(notExec, 0o755);
    await expect(createAcpAgentAdapter({ id: "x", command: notExec, environment }).spawn({ cwd: project })).rejects.toThrow();
    await expect(createAcpAgentAdapter({ id: "x", command: process.execPath, environment }).spawn({ cwd: path.join(root, "missing-dir") })).rejects.toThrow();
    expect(await readdir(tmpBase)).toEqual([]);
  });

  it("kills the whole process group, not just the leader", async () => {
    const script = path.join(root, "wrapper.mjs");
    await writeFile(
      script,
      `import { spawn } from "node:child_process";
const kid = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "kid", params: { pid: kid.pid } }) + "\\n");
setInterval(() => {}, 1000);
`,
    );
    const adapter = createAcpAgentAdapter({ id: "w", command: process.execPath, args: [script], environment: { env: env(), homedir: home, tmpBase } });
    const proc = await adapter.spawn({ cwd: project });
    let kid = 0;
    proc.stream.onMessage((m) => {
      kid = (m.params as { pid: number }).pid;
    });
    await until(() => kid > 0);
    await proc.kill();
    await until(() => !alive(kid));
  });
});

describe("spawnAcpProcess leftovers", () => {
  it("kills descendants that hold the agent's stdio open once the agent itself exits", async () => {
    // The child inherits stdout/stderr, so `close` would wait for it; only `exit` can fire the cleanup.
    const script = path.join(root, "leaker.mjs");
    await writeFile(
      script,
      `import { spawn } from "node:child_process";
const kid = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["ignore", "inherit", "inherit"] });
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "kid", params: { pid: kid.pid } }) + "\\n");
setTimeout(() => process.exit(0), 100);
`,
    );
    const proc = await spawnAcpProcess({ command: process.execPath, args: [script], cwd: project, env: { PATH: process.env.PATH ?? "" } });
    spawned.push(proc);
    let kid = 0;
    proc.stream.onMessage((m) => {
      kid = (m.params as { pid: number }).pid;
    });
    try {
      await until(() => kid > 0);
      // No kill() here: the exit alone must end the leftover and release `exited`.
      await expect(Promise.race([proc.exited, new Promise((r) => setTimeout(() => r("hung"), 2500))])).resolves.toMatchObject({ code: 0 });
      await until(() => !alive(kid));
    } finally {
      if (kid > 0 && alive(kid)) process.kill(kid, "SIGKILL");
    }
  });
});

describe("per-app sandbox parent", () => {
  const env = () => ({ PATH: path.dirname(process.execPath) });

  it("places the sandbox under the app's tmp dir, 0700, and removes it at session end", async () => {
    const stateDir = path.join(root, "state");
    const adapter = createAcpAgentAdapter({
      id: "stub",
      command: process.execPath,
      args: [STUB],
      environment: { env: env(), homedir: home },
      tmpBaseOf: (appId) => path.join(stateDir, appId, "bridge", "tmp"),
    });
    const proc = await adapter.spawn({ cwd: project, appId: "app1" });
    spawned.push(proc);
    const seen = await probe(proc);
    const appTmp = path.join(stateDir, "app1/bridge/tmp");
    expect(seen.home?.startsWith(`${appTmp}${path.sep}`)).toBe(true);
    expect(await readdir(appTmp)).toHaveLength(1);
    expect((await stat(appTmp)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(stateDir, "app1/bridge"))).mode & 0o777).toBe(0o700);
    await proc.kill();
    expect(await readdir(appTmp)).toEqual([]);
  });

  it("tightens an existing tmp dir to 0700", async () => {
    const appTmp = path.join(root, "state/app1/bridge/tmp");
    await mkdir(appTmp, { recursive: true, mode: 0o755 });
    await chmod(appTmp, 0o755);
    const adapter = createAcpAgentAdapter({
      id: "stub",
      command: process.execPath,
      args: [STUB],
      environment: { env: env(), homedir: home },
      tmpBaseOf: () => appTmp,
    });
    const proc = await adapter.spawn({ cwd: project, appId: "app1" });
    spawned.push(proc);
    expect((await stat(appTmp)).mode & 0o777).toBe(0o700);
  });

  it("refuses a redirected tmp dir: a symlink never puts the sandbox somewhere else (e.g. /tmp)", async () => {
    const stateDir = path.join(root, "state");
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    const adapter = createAcpAgentAdapter({
      id: "stub",
      command: process.execPath,
      args: [STUB],
      environment: { env: env(), homedir: home },
      tmpBaseOf: (appId) => path.join(stateDir, appId, "bridge", "tmp"),
    });
    const spawn = () => adapter.spawn({ cwd: project, appId: "app1" });
    // tmp itself and the app's bridge folder each redirected; a dangling link too
    await mkdir(path.join(stateDir, "app1/bridge"), { recursive: true });
    await symlink(elsewhere, path.join(stateDir, "app1/bridge/tmp"));
    await expect(spawn()).rejects.toThrow(/redirected/);
    await rm(path.join(stateDir, "app1/bridge/tmp"));
    await symlink(path.join(root, "nowhere"), path.join(stateDir, "app1/bridge/tmp"));
    await expect(spawn()).rejects.toThrow(/redirected/);
    await rm(path.join(stateDir, "app1/bridge"), { recursive: true });
    await symlink(elsewhere, path.join(stateDir, "app1/bridge"));
    await expect(spawn()).rejects.toThrow(/redirected/);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("accepts a state dir that is itself reached through a symlink", async () => {
    const real = path.join(root, "real-state");
    await mkdir(real);
    await symlink(real, path.join(root, "linked-state"));
    const adapter = createAcpAgentAdapter({
      id: "stub",
      command: process.execPath,
      args: [STUB],
      environment: { env: env(), homedir: home },
      tmpBaseOf: (appId) => path.join(root, "linked-state", appId, "bridge", "tmp"),
    });
    const proc = await adapter.spawn({ cwd: project, appId: "app1" });
    spawned.push(proc);
    expect(await readdir(path.join(real, "app1/bridge/tmp"))).toHaveLength(1);
  });

  it("refuses to start without an app id, or with no sandbox parent configured, rather than falling back to /tmp", async () => {
    const withBase = createAcpAgentAdapter({
      id: "stub",
      command: process.execPath,
      args: [STUB],
      environment: { env: env(), homedir: home },
      tmpBaseOf: (appId) => path.join(root, "state", appId),
    });
    await expect(withBase.spawn({ cwd: project })).rejects.toThrow(/app id/);
    const none = createAcpAgentAdapter({ id: "stub", command: process.execPath, args: [STUB], environment: { env: env(), homedir: home } });
    await expect(none.spawn({ cwd: project, appId: "app1" })).rejects.toThrow(/no sandbox folder/);
    await expect(readdir(path.join(root, "state"))).rejects.toThrow();
  });

  it("an invalid app id fails with a message naming the id", async () => {
    const adapters = createDefaultAgentAdapters({ environment: { env: env(), homedir: home }, base: { config: path.join(root, "config"), data: path.join(root, "data"), state: path.join(root, "state") }, commands: { claude: process.execPath } });
    await expect(adapters[0]!.spawn({ cwd: project, appId: "../evil" })).rejects.toThrow(/invalid app folder name/);
    expect(await readdir(root)).not.toContain("state");
  });

  it("the default adapters use <state>/<app>/bridge/tmp from `base`, and never os.tmpdir()", async () => {
    const stateDir = path.join(root, "state");
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a" } }));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const wrapper = path.join(bin, "stub-acp");
    await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${STUB}"\n`);
    await chmod(wrapper, 0o755);
    const adapters = createDefaultAgentAdapters({
      environment: { env: { PATH: `${bin}:${path.dirname(process.execPath)}` }, homedir: home },
      base: { config: path.join(root, "config"), data: path.join(root, "data"), state: stateDir },
      commands: { claude: "stub-acp" },
    });
    const proc = await adapters[0]!.spawn({ cwd: project, appId: "app1" });
    spawned.push(proc);
    const seen = await probe(proc);
    expect(seen.home?.startsWith(path.join(stateDir, "app1/bridge/tmp") + path.sep)).toBe(true);
    await proc.kill();
  });

  it("with no `base` and no fixed tmpBase, derives <home state dir>/<app>/bridge/tmp from the home dir", async () => {
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a" } }));
    const adapters = createDefaultAgentAdapters({
      environment: { env: { PATH: path.dirname(process.execPath), XDG_STATE_HOME: path.join(root, "xdg-state") }, homedir: home },
      commands: { claude: process.execPath },
    });
    // `node` with no args waits on stdin; only the sandbox parent matters here.
    const proc = await adapters[0]!.spawn({ cwd: project, appId: "app2" });
    spawned.push(proc);
    expect(await readdir(path.join(root, "xdg-state/app2/bridge/tmp"))).toHaveLength(1);
    await proc.kill();
  });
});

describe("adapter resolution", () => {
  it("prefers the bundled command, reports its source, and falls back to PATH", async () => {
    const bundled = path.join(root, "bundled-acp");
    const onPath = path.join(root, "pathbin");
    await mkdir(onPath);
    await writeFile(bundled, "#!/bin/sh\n");
    await chmod(bundled, 0o755);
    await writeFile(path.join(onPath, "claude-agent-acp"), "#!/bin/sh\n");
    await chmod(path.join(onPath, "claude-agent-acp"), 0o755);
    const environment = { env: { PATH: onPath }, homedir: home, tmpBase };
    const commands = { claude: [{ command: bundled, source: "bundled" as const }, "claude-agent-acp", "claude-code-acp"] };

    // A same-named binary earlier on PATH does not shadow the bundled one.
    const both = createDefaultAgentAdapters({ environment, commands })[0]!;
    expect(both.resolved()).toEqual({ command: bundled, source: "bundled" });

    await rm(bundled);
    expect(both.resolved()).toEqual({ command: path.join(onPath, "claude-agent-acp"), source: "path" });

    await rm(path.join(onPath, "claude-agent-acp"));
    expect(both.resolved()).toBeUndefined();
    expect(await both.availability()).toEqual({ id: "claude", available: false });
  });

  it("treats a plain absolute path given in `commands` as a path source, not bundled", async () => {
    const adapter = createAcpAgentAdapter({ id: "x", command: process.execPath, environment: { env: {}, homedir: home, tmpBase } });
    expect(adapter.resolved()).toEqual({ command: process.execPath, source: "path" });
  });
});

describe("createDefaultAgentAdapters", () => {
  it("builds claude and codex adapters that report unavailable when no ACP binary is installed", async () => {
    const adapters = createDefaultAgentAdapters({ environment: { env: { PATH: "" }, homedir: home, tmpBase } });
    expect(adapters.map((a) => a.id)).toEqual(["claude", "codex"]);
    expect(await Promise.all(adapters.map((a) => a.availability()))).toEqual([
      { id: "claude", available: false },
      { id: "codex", available: false },
    ]);
    await expect(adapters[0]!.spawn({ cwd: project })).rejects.toThrow(/not installed/);
  });

  it("codex runs the `commands.codex` candidates in order, with a bare codex-acp last as the PATH fallback", async () => {
    const mk = async (dir: string, name: string): Promise<string> => {
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, name);
      await writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      return file;
    };
    const installed = await mk(path.join(root, "codex-installed"), "codex-acp");
    const onPath = await mk(path.join(root, "codex-path"), "codex-acp");
    const codexOf = (commands: NonNullable<Parameters<typeof createDefaultAgentAdapters>[0]>["commands"]) =>
      createDefaultAgentAdapters({ environment: { env: { PATH: path.dirname(onPath) }, homedir: home, tmpBase }, commands }).find((a) => a.id === "codex")!;
    const candidates = [{ command: installed, source: "bundled" as const }, "codex-acp"];
    expect(codexOf({ codex: candidates }).resolved()).toEqual({ command: installed, source: "bundled" });
    await rm(installed);
    expect(codexOf({ codex: candidates }).resolved()).toEqual({ command: onPath, source: "path" });
    // With no `commands` the default is the PATH lookup alone.
    expect(codexOf(undefined).resolved()).toEqual({ command: onPath, source: "path" });
  });

  describe.skipIf(!linuxX64)("the production adapters log a contained claude session on a newer stack", () => {
    /** A claude install tree with the adapter at `adapter` and a binary that answers `--version` with `binary`. */
    async function install(adapter: string, binary: string): Promise<string> {
      const nm = path.join(root, "install/node_modules");
      const write = async (rel: string, text: string, mode = 0o644) => {
        await mkdir(path.dirname(path.join(nm, rel)), { recursive: true });
        await writeFile(path.join(nm, rel), text, { mode });
      };
      await write("@agentclientprotocol/claude-agent-acp/package.json", JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: adapter, bin: { "claude-agent-acp": "dist/index.js" } }));
      await write("@agentclientprotocol/claude-agent-acp/dist/index.js", "// adapter\n");
      await write("@anthropic-ai/claude-agent-sdk/package.json", JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.303" }));
      await write("@anthropic-ai/claude-agent-sdk-linux-x64/package.json", JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk-linux-x64", version: "0.3.303" }));
      await write("@anthropic-ai/claude-agent-sdk-linux-x64/claude", `#!/bin/sh\necho "${binary} (Claude Code)"\n`, 0o755);
      await write(".bin/claude-agent-acp", "#!/bin/sh\nexit 0\n", 0o755);
      return path.join(nm, ".bin/claude-agent-acp");
    }
    const adaptersOf = (bin: string, containmentLog?: (line: string) => void, log?: (line: string) => void) =>
      createDefaultAgentAdapters({ environment: { env: { PATH: "" }, homedir: home, tmpBase }, commands: { claude: [{ command: bin, source: "bundled" }] }, containmentLog, log });

    it("a newer stack leaves one line in containmentLog, without `log`; the measured stack leaves none", async () => {
      const lines: string[] = [];
      const newer = await install("0.95.0", "2.2.0");
      const [claude] = adaptersOf(newer, (line) => lines.push(line));
      expect(claude!.containment?.()).toBeDefined();
      expect(claude!.containment?.()).toBeDefined();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("adapter 0.95.0 / CLI 2.2.0");
      expect(lines[0]).toContain("newer than the measured");

      await rm(path.join(root, "install"), { recursive: true, force: true });
      const measured = await install("0.94.0", "2.1.303");
      const quiet: string[] = [];
      expect(adaptersOf(measured, (line) => quiet.push(line))[0]!.containment?.()).toBeDefined();
      expect(quiet).toEqual([]);
    });

    it("containmentLog does not turn on agent stderr forwarding: `log` alone does", async () => {
      const bin = path.join(root, "noisy-acp");
      await writeFile(bin, "#!/bin/sh\necho agent-stderr-line >&2\nexit 0\n", { mode: 0o755 });
      const contained: string[] = [];
      const [withoutLog] = adaptersOf(bin, (line) => contained.push(line));
      const quietProc = await withoutLog!.spawn({ cwd: project });
      spawned.push(quietProc);
      await quietProc.exited;
      expect(contained).toEqual([]);

      const logs: string[] = [];
      const [withLog] = adaptersOf(bin, (line) => contained.push(line), (line) => logs.push(line));
      const loudProc = await withLog!.spawn({ cwd: project });
      spawned.push(loudProc);
      await loudProc.exited;
      await until(() => logs.length > 0);
      expect(logs).toEqual(["claude: agent-stderr-line"]);
      expect(contained).toEqual([]);
    });
  });

  it("can be called with no arguments", () => {
    expect(createDefaultAgentAdapters()).toHaveLength(2);
  });
});

describe("spawnAcpProcess group signals", () => {
  it("sweeps the group exactly once after a natural exit and never signals it again", async () => {
    const script = path.join(root, "quick.mjs");
    await writeFile(script, `setTimeout(() => process.exit(0), 50);\n`);
    const signals: [number, string][] = [];
    const proc = await spawnAcpProcess({
      command: process.execPath,
      args: [script],
      cwd: project,
      env: { PATH: process.env.PATH ?? "" },
      killGraceMs: 100,
      signalFn: (pid, sig) => void signals.push([pid, sig]),
    });
    await proc.exited;
    expect(signals).toEqual([[-proc.pid!, "SIGKILL"]]);
    await proc.kill();
    await new Promise((r) => setTimeout(r, 250)); // past the grace period
    expect(signals).toHaveLength(1);
  });

  it("signals the group once with SIGTERM and once with the sweep when killed while running, then nothing", async () => {
    const script = path.join(root, "idle.mjs");
    await writeFile(script, `setInterval(() => {}, 1000);\n`);
    const signals: [number, string][] = [];
    const proc = await spawnAcpProcess({
      command: process.execPath,
      args: [script],
      cwd: project,
      env: { PATH: process.env.PATH ?? "" },
      killGraceMs: 100,
      // Really deliver SIGTERM so the child ends; record everything.
      signalFn: (pid, sig) => {
        signals.push([pid, sig]);
        process.kill(pid, sig);
      },
    });
    await proc.kill();
    await new Promise((r) => setTimeout(r, 250));
    const sigs = signals.map((s) => s[1]);
    expect(sigs[0]).toBe("SIGTERM");
    expect(sigs.filter((x) => x === "SIGKILL").length).toBeLessThanOrEqual(1);
    expect(signals.length).toBeLessThanOrEqual(2);
    // The last signal is the sweep: nothing follows it.
    const countAtEnd = signals.length;
    await proc.kill();
    await new Promise((r) => setTimeout(r, 150));
    expect(signals).toHaveLength(countAtEnd);
  });
});

describe("per-app sandbox parent in the app's own bridge folder (base)", () => {
  const state = () => path.join(root, "state");
  async function stubAdapter(extra: Partial<Parameters<typeof createDefaultAgentAdapters>[0]> = {}) {
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a" } }));
    const bin = path.join(root, "bin");
    await mkdir(bin, { recursive: true });
    const wrapper = path.join(bin, "stub-acp");
    await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${STUB}"\n`);
    await chmod(wrapper, 0o755);
    return createDefaultAgentAdapters({
      environment: { env: { PATH: `${bin}:${path.dirname(process.execPath)}` }, homedir: home },
      base: { config: path.join(root, "config"), data: path.join(root, "data"), state: state() },
      commands: { claude: "stub-acp" },
      ...extra,
    })[0]!;
  }

  it("places the sandbox under <state>/<app>/bridge/tmp, 0700, never os.tmpdir(), and removes it at session end", async () => {
    const adapter = await stubAdapter();
    const proc = await adapter.spawn({ cwd: project, appId: "app-a" });
    spawned.push(proc);
    const seen = await probe(proc);
    const appTmp = path.join(state(), "app-a/bridge/tmp");
    expect(seen.home?.startsWith(appTmp + path.sep)).toBe(true);
    expect((await stat(appTmp)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(state(), "app-a/bridge"))).mode & 0o777).toBe(0o700);
    await proc.kill();
    expect(await readdir(appTmp)).toEqual([]);
  });

  it("keeps two apps' sandboxes in their own folders", async () => {
    const adapter = await stubAdapter();
    const a = await adapter.spawn({ cwd: project, appId: "app-a" });
    const b = await adapter.spawn({ cwd: project, appId: "app-b" });
    spawned.push(a, b);
    expect(await readdir(path.join(state(), "app-a/bridge/tmp"))).toHaveLength(1);
    expect(await readdir(path.join(state(), "app-b/bridge/tmp"))).toHaveLength(1);
  });

  it("accepts a symlinked <state>/<app>, refuses a symlinked bridge or tmp", async () => {
    const adapter = await stubAdapter();
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    await mkdir(path.join(root, "real-app"));
    await mkdir(state());
    await symlink(path.join(root, "real-app"), path.join(state(), "app-a"));
    const proc = await adapter.spawn({ cwd: project, appId: "app-a" });
    spawned.push(proc);
    expect(await readdir(path.join(root, "real-app/bridge/tmp"))).toHaveLength(1);
    await proc.kill();
    // tmp -> elsewhere
    await rm(path.join(root, "real-app/bridge/tmp"), { recursive: true });
    await symlink(elsewhere, path.join(root, "real-app/bridge/tmp"));
    await expect(adapter.spawn({ cwd: project, appId: "app-a" })).rejects.toThrow(/redirected/);
    // bridge -> elsewhere
    await rm(path.join(root, "real-app/bridge"), { recursive: true });
    await symlink(elsewhere, path.join(root, "real-app/bridge"));
    await expect(adapter.spawn({ cwd: project, appId: "app-a" })).rejects.toThrow(/redirected/);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("refuses an app id that is not a folder name, and the reserved one", async () => {
    const adapter = await stubAdapter();
    for (const appId of ["../evil", "AppA", "bridge"]) {
      await expect(adapter.spawn({ cwd: project, appId }), appId).rejects.toThrow(/invalid app folder name/);
    }
    await expect(readdir(state())).rejects.toThrow();
  });
});


// ---------------------------------------------------------------------------------------------------------
// Contained sessions: the adapter half of containment, through the `spawnProcess` seam. The real bundled
// claude adapter is only read (package.json, hash), never run here; `claude-argv.test.ts` runs it.
// ---------------------------------------------------------------------------------------------------------
describe.skipIf(!linuxX64)("contained sessions", () => {
  const CLI_DIR = fileURLToPath(new URL("../../../cli", import.meta.url));
  const BUNDLED = path.join(CLI_DIR, "node_modules/.bin/claude-agent-acp");
  const SECRET = "contained-secret-9a8b7c6d5e";
  const NODE = process.execPath;
  const SERVER_JS = "/opt/plugin/dist/corpus-mcp.js";
  let sessions: string;
  let fakeBinary: string;
  let loginFile: string;

  beforeEach(async () => {
    sessions = path.join(root, "sessions");
    fakeBinary = path.join(root, "claude-binary");
    await writeFile(fakeBinary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    loginFile = path.join(root, "bridge-config/agents/claude/.credentials.json");
    await mkdir(path.dirname(loginFile), { recursive: true });
    await writeFile(loginFile, JSON.stringify({ claudeAiOauth: { accessToken: "a-login-token", refreshToken: "r" } }), { mode: 0o600 });
  });

  /** A process that is only a handle: exits when killed. */
  function handle(): AgentProcess {
    let done!: (e: AgentExit) => void;
    const exited = new Promise<AgentExit>((r) => (done = r));
    return { stream: {} as AgentProcess["stream"], exited, kill: async () => done({ code: 0, signal: null }), cleanup: async () => { done({ code: 0, signal: null }); return { status: "quiescent", mechanism: "linux-pid-namespace" }; } };
  }

  interface Harness {
    adapter: ReturnType<typeof createAcpAgentAdapter>;
    calls: SpawnAcpProcessOptions[];
    logs: string[];
  }
  function harness(o: { command?: Parameters<typeof createAcpAgentAdapter>[0]["command"]; binaryPath?: string; parentEnv?: Record<string, string>; allow?: string[]; spawnProcess?: (o: SpawnAcpProcessOptions) => Promise<AgentProcess>; withSupport?: boolean } = {}): Harness {
    const calls: SpawnAcpProcessOptions[] = [];
    const logs: string[] = [];
    const adapter = createAcpAgentAdapter({
      id: "claude",
      command: o.command ?? { command: BUNDLED, source: "bundled" },
      environment: { env: { PATH: path.dirname(process.execPath), ...o.parentEnv }, homedir: home, tmpBase },
      credentialsFor: "claude-code",
      authFiles: { "claude-code": loginFile },
      envPolicy: o.allow ? { allow: o.allow } : undefined,
      ...(o.withSupport === false ? {} : { containment: claudeContainmentSupportWithSeams({ binaryPath: o.binaryPath ?? fakeBinary }) }),
      log: (line) => logs.push(line),
      spawnProcess:
        o.spawnProcess ??
        (async (options) => {
          calls.push(options);
          options.onStderr?.("agent says hello");
          return handle();
        }),
    });
    return { adapter, calls, logs };
  }

  function request(o: Partial<ContainmentRequest> = {}): ContainmentRequest {
    return {
      sessionId: randomUUID(),
      servers: [{ name: "corpus", command: NODE, args: [SERVER_JS, "--data=/data/corpus", "${SESSION_SECRET_FILE}"] }],
      allow: ["mcp__corpus__read"],
      secret: new TextEncoder().encode(SECRET),
      model: "haiku",
      ...o,
    };
  }
  const cwdOf = (r: ContainmentRequest) => path.join(sessions, r.sessionId);
  const spawnContained = async (h: Harness, r: ContainmentRequest = request()) => {
    const proc = await h.adapter.spawn({ cwd: cwdOf(r), appId: "app", containment: r });
    spawned.push(proc);
    return { proc, r };
  };

  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else out.push(full);
    }
    return out;
  }

  it("session/new params equal the profile exactly; bypass is off; no MCP entry carries an env", async () => {
    const h = harness();
    const { proc, r } = await spawnContained(h);
    const secretFile = path.join(tmpBase, `bridge-acp-secrets-${r.sessionId}`, "corpus");
    expect(proc.sessionNew).toEqual({
      mcpServers: [{ name: "corpus", command: NODE, args: [SERVER_JS, "--data=/data/corpus", secretFile], env: [] }],
      _meta: { claudeCode: { options: { ...CLAUDE_CONTAINMENT_OPTIONS, model: "haiku" } } },
    });
    const options = (proc.sessionNew!._meta as { claudeCode: { options: { allowDangerouslySkipPermissions: unknown } } }).claudeCode.options;
    expect(options.allowDangerouslySkipPermissions).toBe(false);
    for (const entry of proc.sessionNew!.mcpServers) expect(entry.env).toEqual([]);
    expect(JSON.stringify(proc.sessionNew)).not.toContain('"env":{');
    // Without a model, no model key; a non-contained spawn has no sessionNew at all.
    await proc.kill(); // One synthetic login lease at a time, as production now requires.
    const bare = await spawnContained(h, request({ model: undefined }));
    expect(bare.proc.sessionNew!._meta).toEqual({ claudeCode: { options: CLAUDE_CONTAINMENT_OPTIONS } });
    await bare.proc.kill();
    const plain = await h.adapter.spawn({ cwd: project, appId: "app" });
    spawned.push(plain);
    expect(plain.sessionNew).toBeUndefined();
  });

  it("runs the pin-checked adapter by the runner's Node, in the empty session cwd, with the sandbox env", async () => {
    const h = harness();
    const { r } = await spawnContained(h);
    const call = h.calls[0]!;
    expect(call.command).toBe(NODE);
    expect(call.args).toHaveLength(1);
    expect(call.args![0]).toMatch(/claude-agent-acp\/dist\/index\.js$/);
    expect(call.cwd).toBe(cwdOf(r));
    expect(await readdir(call.cwd)).toEqual([]);
    expect((await stat(call.cwd)).mode & 0o777).toBe(0o700);
    expect(call.env.CLAUDE_CODE_EXECUTABLE).toBe(await realpath(fakeBinary));
    expect(call.env.HOME?.startsWith(tmpBase)).toBe(true);
    expect(call.env.CLAUDE_CONFIG_DIR?.startsWith(tmpBase)).toBe(true);
  });

  it("the secret appears only in the secret file, which lies outside every env-named directory", async () => {
    const h = harness();
    const { proc, r } = await spawnContained(h);
    const call = h.calls[0]!;
    const secretDir = path.join(tmpBase, `bridge-acp-secrets-${r.sessionId}`);
    const secretFile = path.join(secretDir, "corpus");
    expect(await readFile(secretFile, "utf8")).toBe(SECRET);
    expect((await stat(secretFile)).mode & 0o777).toBe(0o600);
    expect((await stat(secretDir)).mode & 0o777).toBe(0o700);

    // Outside HOME, TMPDIR, the XDG dirs, CLAUDE_CONFIG_DIR and the cwd.
    const named = ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CLAUDE_CONFIG_DIR"].map((k) => call.env[k]!);
    for (const dir of [...named, call.cwd]) {
      expect(secretFile.startsWith(dir + path.sep) || secretFile === dir, dir).toBe(false);
    }

    // Not in env, argv, params, logs, or any file of the sandbox tree or the cwd.
    expect(Object.values(call.env).some((v) => v.includes(SECRET))).toBe(false);
    expect((call.args ?? []).join("\0")).not.toContain(SECRET);
    expect(JSON.stringify(proc.sessionNew)).not.toContain(SECRET);
    expect(h.logs.join("\n")).not.toContain(SECRET);
    const sandbox = path.dirname(call.env.TMPDIR! === call.env.HOME ? call.env.HOME! : call.env.HOME!);
    for (const file of [...(await walk(sandbox)), ...(await walk(call.cwd))]) {
      expect(await readFile(file, "utf8").catch(() => ""), file).not.toContain(SECRET);
    }
    // The buffer the caller handed in is zeroed.
    expect([...r.secret!].every((b) => b === 0)).toBe(true);
  });

  it("removes the cwd, the secret directory and the sandbox when the session ends", async () => {
    const h = harness();
    const { proc, r } = await spawnContained(h);
    expect(await readdir(tmpBase)).toHaveLength(2); // the sandbox and the secret directory
    await proc.kill();
    expect(await readdir(tmpBase)).toEqual([]);
    await expect(stat(cwdOf(r))).rejects.toThrow();
    await expect(stat(path.join(tmpBase, `bridge-acp-secrets-${r.sessionId}`))).rejects.toThrow();
  });

  it("a failed process start leaves nothing behind and still zeroes the secret", async () => {
    const h = harness({ spawnProcess: async () => Promise.reject(new Error("boom")) });
    const r = request();
    await expect(h.adapter.spawn({ cwd: cwdOf(r), appId: "app", containment: r })).rejects.toThrow("boom");
    expect(await readdir(tmpBase)).toEqual([]);
    await expect(stat(cwdOf(r))).rejects.toThrow();
    expect([...r.secret!].every((b) => b === 0)).toBe(true);
  });

  it("refuses before any process or file: a cwd that is not <sessions>/<id>, a cwd that exists, a server that wants a secret that is not there", async () => {
    const h = harness();
    const r = request();
    await expect(h.adapter.spawn({ cwd: project, appId: "app", containment: r })).rejects.toBeInstanceOf(ContainmentRefused);
    await mkdir(cwdOf(r), { recursive: true });
    await expect(h.adapter.spawn({ cwd: cwdOf(r), appId: "app", containment: r })).rejects.toBeInstanceOf(ContainmentRefused);
    const noSecret = request({ secret: undefined });
    await expect(h.adapter.spawn({ cwd: cwdOf(noSecret), appId: "app", containment: noSecret })).rejects.toBeInstanceOf(ContainmentRefused);
    expect(h.calls).toEqual([]);
    expect(await readdir(tmpBase)).toEqual([]);
    expect(await readdir(cwdOf(r))).toEqual([]); // the pre-existing cwd was not touched
  });

  it("a cwd that is not in normal form is refused before any file, and the child starts in the verified path", async () => {
    const h = harness();
    const r = request();
    const normal = cwdOf(r);
    for (const odd of [`${normal}/`, `${sessions}/./${r.sessionId}`, `${sessions}/x/../${r.sessionId}`, `${sessions}//${r.sessionId}`, `${sessions}/${r.sessionId}/.`]) {
      await expect(h.adapter.spawn({ cwd: odd, appId: "app", containment: r }), odd).rejects.toBeInstanceOf(ContainmentRefused);
    }
    await expect(stat(sessions)).rejects.toThrow(); // no sessions dir was created for any of them
    expect(h.calls).toEqual([]);
    expect(await readdir(tmpBase)).toEqual([]);
    // The same rule at the function that makes the directory.
    await expect(createEmptySessionDir(`${normal}/`)).rejects.toBeInstanceOf(ContainmentRefused);
    // The accepted form: the child gets exactly the path that was verified and created.
    await spawnContained(h, r);
    expect(h.calls[0]!.cwd).toBe(normal);
    expect(path.resolve(h.calls[0]!.cwd)).toBe(h.calls[0]!.cwd);
  });

  it("a session cwd under a linked `bridge` or `sessions` folder is refused before any process or file, whatever tmpBase is used", async () => {
    const h = harness();
    const target = path.join(root, "elsewhere");
    await mkdir(target);
    await mkdir(path.join(root, "state-a"));
    await symlink(target, path.join(root, "state-a", "bridge"));
    await mkdir(path.join(root, "state-b", "bridge"), { recursive: true });
    await symlink(target, path.join(root, "state-b", "bridge", "sessions"));
    for (const state of ["state-a", "state-b"]) {
      const r = request();
      await expect(h.adapter.spawn({ cwd: path.join(root, state, "bridge", "sessions", r.sessionId), appId: "app", containment: r }), state).rejects.toBeInstanceOf(ContainmentRefused);
    }
    expect(h.calls).toEqual([]);
    expect(await readdir(target)).toEqual([]);
    expect(await readdir(tmpBase)).toEqual([]);
  });

  it("codex is refused with -32016 and no process starts", async () => {
    const codex = createDefaultAgentAdapters({ environment: { env: { PATH: path.dirname(process.execPath) }, homedir: home, tmpBase } }).find((a) => a.id === "codex")!;
    expect(codex.containment?.()).toBeUndefined();
    const r = request();
    const error = await codex.spawn({ cwd: cwdOf(r), appId: "app", containment: r }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainmentRefused);
    expect((error as ContainmentRefused).code).toBe(-32016);
    expect(await readdir(tmpBase)).toEqual([]);
    // Any adapter built without containment support reads the same.
    const h = harness({ withSupport: false });
    await expect(h.adapter.spawn({ cwd: cwdOf(r), appId: "app", containment: r })).rejects.toMatchObject({ code: -32016 });
    expect(h.calls).toEqual([]);
  });

  it("a claude adapter that is not installed is refused with the reason adapter_missing; no other refusal carries one", async () => {
    // Nothing on the candidate list resolves: the adapter is not installed.
    const missing = harness({ command: [{ command: path.join(root, "no-such-adapter"), source: "bundled" }, "no-such-acp"] });
    expect(missing.adapter.resolved()).toBeUndefined();
    expect(missing.adapter.containment?.()).toBeUndefined();
    expect(missing.adapter.containmentRefusalReason?.()).toBe("adapter_missing");
    const r = request();
    const error = await missing.adapter.spawn({ cwd: cwdOf(r), appId: "app", containment: r }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainmentRefused);
    expect(error).toMatchObject({ code: -32016, message: "Contained session unavailable", reason: "adapter_missing", detail: "the claude adapter is not installed" });
    expect(missing.calls).toEqual([]);
    // Every other cause: a command outside the bundled pair, no profile at all, no support, a good install.
    const fromPath = harness({ command: [{ command: NODE, source: "path" }, { command: BUNDLED, source: "bundled" }] });
    expect(fromPath.adapter.containmentRefusalReason?.()).toBeUndefined();
    await expect(fromPath.adapter.spawn({ cwd: cwdOf(r), appId: "app", containment: request() })).rejects.toMatchObject({ code: -32016, reason: undefined });
    const noSupport = harness({ withSupport: false });
    expect(noSupport.adapter.containmentRefusalReason?.()).toBeUndefined();
    await expect(noSupport.adapter.spawn({ cwd: cwdOf(r), appId: "app", containment: request() })).rejects.toMatchObject({ code: -32016, reason: undefined });
    expect(harness().adapter.containmentRefusalReason?.()).toBeUndefined();
    const codex = createDefaultAgentAdapters({ environment: { env: { PATH: path.dirname(process.execPath) }, homedir: home, tmpBase } }).find((a) => a.id === "codex")!;
    expect(codex.containmentRefusalReason?.()).toBeUndefined();
  });

  it("an adapter or binary outside the pin is refused with -32016", async () => {
    // A claude install tree whose adapter version, or whose binary's content, is not the measured one.
    async function install(name: string, adapterVersion: string): Promise<string> {
      const nm = path.join(root, name, "node_modules");
      const pkg = (n: string, version: string, extra: object = {}) => JSON.stringify({ name: n, version, ...extra });
      for (const [rel, text, mode] of [
        ["@agentclientprotocol/claude-agent-acp/package.json", pkg("@agentclientprotocol/claude-agent-acp", adapterVersion, { bin: { "claude-agent-acp": "index.js" } }), 0o644],
        ["@agentclientprotocol/claude-agent-acp/index.js", "", 0o644],
        ["@anthropic-ai/claude-agent-sdk/package.json", pkg("@anthropic-ai/claude-agent-sdk", "0.3.303"), 0o644],
        ["@anthropic-ai/claude-agent-sdk-linux-x64/package.json", pkg("@anthropic-ai/claude-agent-sdk-linux-x64", "0.3.303"), 0o644],
        ["@anthropic-ai/claude-agent-sdk-linux-x64/claude", "#!/bin/sh\necho some other build\n", 0o755],
        [".bin/claude-agent-acp", "#!/bin/sh\n", 0o755],
      ] as const) {
        await mkdir(path.dirname(path.join(nm, rel)), { recursive: true });
        await writeFile(path.join(nm, rel), text, { mode });
      }
      return path.join(nm, ".bin/claude-agent-acp");
    }
    for (const [what, bin, binaryPath] of [
      ["adapter 0.93.0 (the binary is passed by the seam, so only the adapter version is wrong)", await install("old-adapter", "0.93.0"), fakeBinary],
      ["right versions, another build of the binary (the real hash check, no seam)", await install("other-build", "0.94.0"), undefined],
    ] as const) {
      const calls: SpawnAcpProcessOptions[] = [];
      const adapter = createAcpAgentAdapter({
        id: "claude",
        command: { command: bin, source: "bundled" },
        environment: { env: { PATH: path.dirname(process.execPath) }, homedir: home, tmpBase },
        containment: claudeContainmentSupportWithSeams(binaryPath === undefined ? {} : { binaryPath }),
        spawnProcess: async (o) => (calls.push(o), handle()),
      });
      const r = request();
      expect(adapter.containment?.(), what).toBeUndefined();
      await expect(adapter.spawn({ cwd: cwdOf(r), appId: "app", containment: r }), what).rejects.toMatchObject({ code: -32016 });
      expect(calls, what).toEqual([]);
    }
    expect(await readdir(tmpBase)).toEqual([]);
    // The bundled install itself is the measured pair.
    expect(harness().adapter.containment?.()).toMatchObject({ adapterVersion: "0.94.0", platformPackageVersion: "0.3.303", binaryVersion: "2.1.303" });
  });

  it("BRIDGE_CLAUDE_ADAPTER (a command from PATH or an override) with a contained request is refused; other sessions still run", async () => {
    const h = harness({ command: [{ command: NODE, source: "path" }, { command: BUNDLED, source: "bundled" }] });
    expect(h.adapter.resolved()).toEqual({ command: NODE, source: "path" });
    expect(h.adapter.containment?.()).toBeUndefined();
    const r = request();
    await expect(h.adapter.spawn({ cwd: cwdOf(r), appId: "app", containment: r })).rejects.toMatchObject({ code: -32016, detail: expect.stringContaining("bundled adapter") });
    expect(h.calls).toEqual([]);
    const plain = await h.adapter.spawn({ cwd: project, appId: "app" });
    spawned.push(plain);
    expect(h.calls).toHaveLength(1);
  });

  it("envPolicy.allow naming CLAUDE_CODE_EXECUTABLE and the four denied keys: contained gets the pin-checked binary and none of the four; a plain spawn is unchanged", async () => {
    const parentEnv = { CLAUDE_CODE_EXECUTABLE: "/evil/claude", CLAUDE_MODEL_CONFIG: "{}", MAX_THINKING_TOKENS: "1", NODE_OPTIONS: "--require /evil.js", DEBUG_CLAUDE_AGENT_SDK: "1" };
    const allow = Object.keys(parentEnv);
    const h = harness({ parentEnv, allow });
    const running = await spawnContained(h);
    const contained = h.calls[0]!.env;
    expect(contained.CLAUDE_CODE_EXECUTABLE).toBe(await realpath(fakeBinary));
    for (const key of ["CLAUDE_MODEL_CONFIG", "MAX_THINKING_TOKENS", "NODE_OPTIONS", "DEBUG_CLAUDE_AGENT_SDK"]) expect(contained, key).not.toHaveProperty(key);
    await running.proc.kill();

    const plain = await h.adapter.spawn({ cwd: project, appId: "app" });
    spawned.push(plain);
    const env = h.calls[1]!.env;
    expect(env.CLAUDE_CODE_EXECUTABLE).toBe("/evil/claude");
    expect(env.CLAUDE_MODEL_CONFIG).toBe("{}");
    expect(env.NODE_OPTIONS).toBe("--require /evil.js");
    expect(env.DEBUG_CLAUDE_AGENT_SDK).toBe("1");
  });

  it("a .mjs or relative claude executable is refused with containmentUnavailable", async () => {
    await writeFile(path.join(root, "claude.mjs"), "#!/bin/sh\n", { mode: 0o755 });
    for (const binaryPath of [path.join(root, "claude.mjs"), "relative/claude", "./claude"]) {
      const h = harness({ binaryPath });
      const r = request();
      await expect(h.adapter.spawn({ cwd: cwdOf(r), appId: "app", containment: r }), binaryPath).rejects.toMatchObject({ code: -32016 });
      expect(h.calls).toEqual([]);
    }
  });

  it("known limit: a same-uid child of the agent env can read the staged login", async () => {
    // Residual risk, accepted (see containment/claude.ts): CLAUDE_CONFIG_DIR is in the declared server's env
    // and the server runs as the same uid. The child below gets the exact childEnv and cwd; it reports only whether
    // the file is there and readable, never its contents.
    const probeScript = [
      'const fs = require("node:fs"), path = require("node:path");',
      "const dir = process.env.CLAUDE_CONFIG_DIR;",
      'const file = dir ? path.join(dir, ".credentials.json") : "";',
      'const envPresent = typeof dir === "string" && dir.length > 0;',
      "let exists = false, readable = false;",
      "try { fs.accessSync(file); exists = true; } catch {}",
      "try { const fd = fs.openSync(file, fs.constants.O_RDONLY); fs.readSync(fd, Buffer.alloc(1), 0, 1, 0); fs.closeSync(fd); readable = true; } catch {}",
      "process.stdout.write(JSON.stringify({ envPresent, exists, readable }));",
    ].join("\n");
    let report = "";
    const h = harness({
      spawnProcess: async (options) => {
        const child = spawn(process.execPath, ["-e", probeScript], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "ignore"] });
        child.stdout.on("data", (d: Buffer) => (report += d.toString()));
        await new Promise((resolve) => child.on("close", resolve));
        return handle();
      },
    });
    await spawnContained(h);
    const seen = JSON.parse(report) as { envPresent: boolean; exists: boolean; readable: boolean };
    expect(Object.keys(seen).sort()).toEqual(["envPresent", "exists", "readable"]);
    expect(seen.envPresent).toBe(true);
    expect(seen.exists).toBe(true);
    expect(seen.readable).toBe(true);
    expect(report).not.toContain("a-login-token");
  });
});

describe.skipIf(linuxX64)("off the measured platform (Linux x64) a contained spawn is refused", () => {
  it("-32016, no process, no file, whatever the seams say", async () => {
    const binary = path.join(root, "claude-binary");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const calls: SpawnAcpProcessOptions[] = [];
    const adapter = createAcpAgentAdapter({
      id: "claude",
      command: { command: path.join(fileURLToPath(new URL("../../../cli", import.meta.url)), "node_modules/.bin/claude-agent-acp"), source: "bundled" },
      environment: { env: { PATH: path.dirname(process.execPath) }, homedir: home, tmpBase },
      containment: claudeContainmentSupportWithSeams({ binaryPath: binary }),
      spawnProcess: async (o) => (calls.push(o), { stream: {} as AgentProcess["stream"], exited: new Promise<AgentExit>(() => undefined), kill: async () => undefined }),
    });
    const r: ContainmentRequest = { sessionId: randomUUID(), servers: [], allow: [] };
    expect(adapter.containment?.()).toBeUndefined();
    await expect(adapter.spawn({ cwd: path.join(root, "sessions", r.sessionId), appId: "app", containment: r })).rejects.toMatchObject({ code: -32016 });
    expect(calls).toEqual([]);
    expect(await readdir(tmpBase)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// On macOS an empty process group after the sweep releases a staged login (an accepted gap: a
// descendant that left the group is not seen). The public receipt never says quiescent.
// ---------------------------------------------------------------------------------------------------------
describe("staged-login release by platform", () => {
  let login: string;
  const lease = () => `${login}.bridge-login-lease`;
  beforeEach(async () => {
    login = path.join(home, "config/bridge/agents/claude/.credentials.json");
    await mkdir(path.dirname(login), { recursive: true, mode: 0o700 });
    await writeFile(login, JSON.stringify({ claudeAiOauth: { accessToken: "before" } }), { mode: 0o600 });
  });

  /** A fake agent that "refreshes" its staged login, optionally races a writer on the source, and reports `cleanup`. */
  function adapterOn(platform: NodeJS.Platform, cleanup: RawProcessCleanupResult, o: { raceSource?: boolean } = {}) {
    const calls: SpawnAcpProcessOptions[] = [];
    const logs: string[] = [];
    const adapter = createAcpAgentAdapter({
      id: "claude", command: process.execPath, args: [STUB], credentialsFor: "claude-code", authFiles: { "claude-code": login },
      environment: { env: { PATH: path.dirname(process.execPath) }, homedir: home, tmpBase }, platform, log: (line) => logs.push(line),
      spawnProcess: async (options) => {
        calls.push(options);
        await writeFile(path.join(options.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "refreshed" } }));
        if (o.raceSource) await writeFile(login, JSON.stringify({ claudeAiOauth: { accessToken: "someone-else" } }), { mode: 0o600 });
        let done!: (e: AgentExit) => void;
        const exited = new Promise<AgentExit>((r) => (done = r));
        return { stream: {} as AgentProcess["stream"], exited, kill: async () => done({ code: 0, signal: null }), cleanup: async () => { done({ code: 0, signal: null }); return cleanup; } } as AgentProcess; // injects the internal group-empty through the public seam
      },
    });
    return { adapter, calls, logs };
  }
  const token = async () => (JSON.parse(await readFile(login, "utf8")) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken;
  const PUBLIC_INCOMPLETE = { status: "incomplete", mechanism: "process-group", reason: "descendants-unverified" };

  it("darwin: group-empty persists the refresh, releases the lease and sandbox, and reports incomplete", async () => {
    const { adapter, calls, logs } = adapterOn("darwin", { status: "group-empty", mechanism: "process-group" });
    const proc = await adapter.spawn({ cwd: project });
    expect(calls[0]?.processTree).toBeUndefined();
    expect(calls[0]?.platform).toBe("darwin");
    await expect(stat(lease())).resolves.toBeDefined();
    const receipt = await proc.cleanup!();
    expect(receipt).toEqual(PUBLIC_INCOMPLETE);
    // A well-formed public receipt, and not quiescent: the internal group-empty value never leaks
    // (the protocol/plugin-sdk guards reject it; see their quiescence tests).
    expect(isSessionQuiescence(receipt)).toBe(true);
    expect(receipt.status).not.toBe("quiescent");
    expect(await token()).toBe("refreshed");
    await expect(stat(lease())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(tmpBase)).toEqual([]);
    expect(logs).toContain("staged cleanup: group-empty; lease released (macOS, descendants unverified)");
  });

  it("linux: a group-empty result from a custom spawn is not accepted; the lease, copy and sandbox are kept", async () => {
    const { adapter, calls } = adapterOn("linux", { status: "group-empty", mechanism: "process-group" });
    const proc = await adapter.spawn({ cwd: project });
    expect(calls[0]?.processTree).toBe("linux-pid-namespace");
    expect(await proc.cleanup!()).toEqual(PUBLIC_INCOMPLETE);
    expect(await token()).toBe("before");
    await expect(stat(lease())).resolves.toBeDefined();
    expect(await readdir(tmpBase)).toHaveLength(1);
  });

  it("darwin: incomplete evidence (a live group at the deadline) keeps everything", async () => {
    const { adapter } = adapterOn("darwin", { status: "incomplete", mechanism: "process-group", reason: "timeout" });
    const proc = await adapter.spawn({ cwd: project });
    expect(await proc.cleanup!()).toEqual({ status: "incomplete", mechanism: "process-group", reason: "timeout" });
    expect(await token()).toBe("before");
    await expect(stat(lease())).resolves.toBeDefined();
  });

  it("darwin: a failed write-back keeps the lease and staged copy and reports termination-failed", async () => {
    const { adapter } = adapterOn("darwin", { status: "group-empty", mechanism: "process-group" }, { raceSource: true });
    const proc = await adapter.spawn({ cwd: project });
    expect(await proc.cleanup!()).toEqual({ status: "incomplete", mechanism: "process-group", reason: "termination-failed" });
    expect(await token()).toBe("someone-else");
    await expect(stat(lease())).resolves.toBeDefined();
    expect(await readdir(tmpBase)).toHaveLength(1);
  });

  it("win32: a staged login is refused before spawn with sandbox_unavailable and nothing is held", async () => {
    const { adapter, calls } = adapterOn("win32", { status: "group-empty", mechanism: "process-group" });
    await expect(adapter.spawn({ cwd: project })).rejects.toMatchObject({ name: "ContainmentRefused", reason: "sandbox_unavailable" });
    expect(calls).toEqual([]);
    await expect(stat(lease())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(tmpBase)).toEqual([]);
    expect(await token()).toBe("before");
  });
});
