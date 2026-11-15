import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renames = vi.hoisted(() => [] as string[]);
const writeBackFault = vi.hoisted(() => ({ target: "" }));
const cleanupFault = vi.hoisted(() => ({ target: "" }));
vi.mock("node:fs/promises", async (orig) => {
  const actual = await orig<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      renames.push(to);
      if (to === writeBackFault.target) throw Object.assign(new Error("synthetic full disk"), { code: "ENOSPC" });
      return actual.rename(from, to);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]) === cleanupFault.target) throw Object.assign(new Error("synthetic removal denied"), { code: "EACCES" });
      return actual.rm(...args);
    },
  };
});

import { buildAgentArgs, buildPrompt } from "./args.js";
import { agentLoginPresent, exportAgentLogin, resolveAgentAuthFile, resolveProtectedDir, stageAgentCredentials } from "./credentials.js";
import { resolveAgentCommand } from "./discover.js";
import { classifyFailure } from "./failure.js";
import { createAgentRunner } from "./runner.js";
import { type ChildLike, type SpawnFn, toHeartbeatAgents } from "./types.js";

let root: string;
let home: string;
let tmp: string;
let bin: string;

/** Bridge's own login folders and files, as the CLI points the runner at them (under the fake config dir). */
const CL = (): string => path.join(home, "config/bridge/agents/claude");
const CX = (): string => path.join(home, "config/bridge/agents/codex");
const bridgeLogins = () => ({ "claude-code": path.join(CL(), ".credentials.json"), "codex-cli": path.join(CX(), "auth.json") });

beforeEach(async () => {
  renames.length = 0;
  writeBackFault.target = "";
  cleanupFault.target = "";
  root = await mkdtemp(path.join(os.tmpdir(), "bridge-agent-test-"));
  home = path.join(root, "home");
  tmp = path.join(root, "tmp");
  bin = path.join(root, "bin");
  await Promise.all([home, tmp, bin].map((d) => mkdir(d, { recursive: true })));
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function exe(file: string, body = "#!/bin/sh\n") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  await chmod(file, 0o755);
}

describe("discovery", () => {
  it("prefers the newest npx-cache codex over PATH", async () => {
    const older = path.join(home, ".npm/_npx/aaa/node_modules/.bin/codex");
    const newer = path.join(home, ".npm/_npx/bbb/node_modules/.bin/codex");
    await exe(older);
    await exe(newer);
    await utimes(older, 1000, 1000);
    await exe(path.join(bin, "codex"));
    expect(resolveAgentCommand("codex-cli", { homedir: home, pathEnv: bin })).toEqual({ command: newer, source: "npx-cache" });
  });

  it("falls back to PATH, skips npx wrappers, honours overrides", async () => {
    await exe(path.join(bin, "claude"));
    expect(resolveAgentCommand("claude-code", { homedir: home, pathEnv: bin })).toEqual({ command: path.join(bin, "claude"), source: "path" });

    await exe(path.join(bin, "codex"), "#!/bin/sh\nexec npx --prefer-online @openai/codex\n");
    expect(resolveAgentCommand("codex-cli", { homedir: home, pathEnv: bin })).toBeUndefined();

    const custom = path.join(root, "custom-claude");
    await exe(custom);
    expect(resolveAgentCommand("claude-code", { homedir: home, pathEnv: bin, overrides: { "claude-code": custom } })).toEqual({ command: custom, source: "override" });
    expect(resolveAgentCommand("claude-code", { homedir: home, pathEnv: bin, overrides: { "claude-code": "/nope" } })).toBeUndefined();
  });
});

describe("credential staging", () => {
  const codexAuth = JSON.stringify({ tokens: { access_token: "a1" } });

  it("resolves default and env-overridden locations", () => {
    expect(resolveAgentAuthFile("codex-cli", { homedir: "/h", env: {} })).toBe("/h/.codex/auth.json");
    expect(resolveAgentAuthFile("claude-code", { homedir: "/h", env: { CLAUDE_CONFIG_DIR: "/c" } })).toBe("/c/.credentials.json");
  });

  it("stages codex auth.json verbatim at 0600 and writes back a valid refresh", async () => {
    await mkdir(CX(), { recursive: true });
    const real = path.join(CX(), "auth.json");
    await writeFile(real, codexAuth);
    const run = path.join(tmp, "run");
    const staged = await stageAgentCredentials("codex-cli", run, { homedir: home, env: {}, authFiles: bridgeLogins() });
    const copy = path.join(run, "codex-home/auth.json");
    expect(staged.env).toEqual({ CODEX_HOME: path.join(run, "codex-home") });
    expect(await readFile(copy, "utf8")).toBe(codexAuth);
    expect((await stat(copy)).mode & 0o777).toBe(0o600);

    const refreshed = JSON.stringify({ tokens: { access_token: "a2" } });
    await writeFile(copy, refreshed);
    await staged.persistRefresh?.();
    expect(await readFile(real, "utf8")).toBe(refreshed);
  });

  it("refuses write-back of a malformed refresh or when the real file changed", async () => {
    await mkdir(CX(), { recursive: true });
    const real = path.join(CX(), "auth.json");
    await writeFile(real, codexAuth);
    const run = path.join(tmp, "run");
    const staged = await stageAgentCredentials("codex-cli", run, { homedir: home, env: {}, authFiles: bridgeLogins() });
    const copy = path.join(run, "codex-home/auth.json");
    await writeFile(copy, "garbage");
    await expect(staged.persistRefresh!()).rejects.toMatchObject({ code: "AGENT_LOGIN_PERSISTENCE_UNVERIFIED" });
    expect(await readFile(real, "utf8")).toBe(codexAuth);

    await writeFile(copy, JSON.stringify({ tokens: { access_token: "a2" } }));
    await writeFile(real, JSON.stringify({ tokens: { access_token: "concurrent-login" } }));
    await expect(staged.persistRefresh!()).rejects.toMatchObject({ code: "AGENT_LOGIN_PERSISTENCE_UNVERIFIED" });
    expect(await readFile(real, "utf8")).toContain("concurrent-login");
  });

  it("stages only claudeAiOauth and merges refresh back without dropping mcpOAuth", async () => {
    await mkdir(CL(), { recursive: true });
    const real = path.join(CL(), ".credentials.json");
    await writeFile(real, JSON.stringify({ claudeAiOauth: { accessToken: "c1" }, mcpOAuth: { vercel: "secret" } }));
    const run = path.join(tmp, "run");
    const staged = await stageAgentCredentials("claude-code", run, { homedir: home, env: {}, authFiles: bridgeLogins() });
    const copy = path.join(run, "claude-home/.credentials.json");
    expect(JSON.parse(await readFile(copy, "utf8"))).toEqual({ claudeAiOauth: { accessToken: "c1" } });
    expect(staged.env).toEqual({ CLAUDE_CONFIG_DIR: path.join(run, "claude-home") });

    await writeFile(copy, JSON.stringify({ claudeAiOauth: { accessToken: "c2" } }));
    await staged.persistRefresh?.();
    expect(JSON.parse(await readFile(real, "utf8"))).toEqual({ claudeAiOauth: { accessToken: "c2" }, mcpOAuth: { vercel: "secret" } });
  });

  it("with an explicit authFiles entry, a missing file stages nothing and the home default is never read", async () => {
    // A valid login at the home default: reading it would stage it.
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "decoy" } }));
    await writeFile(path.join(home, ".codex/auth.json"), codexAuth);
    const authFiles = { "claude-code": path.join(home, "bridge/claude/.credentials.json"), "codex-cli": path.join(home, "bridge/codex/auth.json") };
    const env = { CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex") };
    for (const agent of ["claude-code", "codex-cli"] as const) {
      expect(await stageAgentCredentials(agent, path.join(tmp, `r-${agent}`), { homedir: home, env, authFiles })).toEqual({ env: {}, staged: false });
    }
  });

  it("stages nothing from an invalid login file", async () => {
    await mkdir(path.join(home, "b"), { recursive: true });
    const claude = path.join(home, "b/.credentials.json");
    const codex = path.join(home, "b/auth.json");
    await writeFile(claude, JSON.stringify({ claudeAiOauth: {} }));
    await writeFile(codex, "not json");
    const authFiles = { "claude-code": claude, "codex-cli": codex };
    expect(await stageAgentCredentials("claude-code", path.join(tmp, "r1"), { homedir: home, env: {}, authFiles })).toEqual({ env: {}, staged: false });
    expect(await stageAgentCredentials("codex-cli", path.join(tmp, "r2"), { homedir: home, env: {}, authFiles })).toEqual({ env: {}, staged: false });
  });

  it("writes a refresh back to the explicit copy and leaves the home login byte-identical", async () => {
    const decoy = JSON.stringify({ claudeAiOauth: { accessToken: "decoy" }, mcpOAuth: { x: 1 } });
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude/.credentials.json"), decoy);
    const bridgeCopy = path.join(home, "bridge/claude/.credentials.json");
    await mkdir(path.dirname(bridgeCopy), { recursive: true });
    await writeFile(bridgeCopy, JSON.stringify({ claudeAiOauth: { accessToken: "c1" } }));
    const run = path.join(tmp, "run");
    const staged = await stageAgentCredentials("claude-code", run, { homedir: home, env: {}, authFiles: { "claude-code": bridgeCopy } });
    expect(staged.staged).toBe(true);
    await writeFile(path.join(run, "claude-home/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "c2" } }));
    await staged.persistRefresh?.();
    expect(JSON.parse(await readFile(bridgeCopy, "utf8"))).toEqual({ claudeAiOauth: { accessToken: "c2" } });
    expect(await readFile(path.join(home, ".claude/.credentials.json"), "utf8")).toBe(decoy);
  });

  it("exportAgentLogin keeps only claudeAiOauth, codex verbatim, and never writes the source", async () => {
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const claudeRaw = JSON.stringify({ claudeAiOauth: { accessToken: "c1", refreshToken: "r1" }, mcpOAuth: { vercel: "secret" } });
    await writeFile(path.join(home, ".claude/.credentials.json"), claudeRaw);
    await writeFile(path.join(home, ".codex/auth.json"), codexAuth);
    const src = { homedir: home, env: {} };
    expect(JSON.parse((await exportAgentLogin("claude-code", src))!)).toEqual({ claudeAiOauth: { accessToken: "c1", refreshToken: "r1" } });
    expect(await exportAgentLogin("codex-cli", src)).toBe(codexAuth);
    expect(await readFile(path.join(home, ".claude/.credentials.json"), "utf8")).toBe(claudeRaw);
    expect(await exportAgentLogin("claude-code", { homedir: path.join(home, "none"), env: {} })).toBeUndefined();
    await writeFile(path.join(home, ".codex/auth.json"), "{}");
    expect(await exportAgentLogin("codex-cli", src)).toBeUndefined();
  });

  it("agentLoginPresent says whether a file holds a usable login", async () => {
    const claude = path.join(home, "c.json");
    const codex = path.join(home, "x.json");
    await writeFile(claude, JSON.stringify({ claudeAiOauth: { accessToken: "c1" } }));
    await writeFile(codex, codexAuth);
    expect(await agentLoginPresent("claude-code", claude)).toBe(true);
    expect(await agentLoginPresent("codex-cli", codex)).toBe(true);
    expect(await agentLoginPresent("claude-code", codex)).toBe(false);
    expect(await agentLoginPresent("codex-cli", path.join(home, "missing"))).toBe(false);
  });

  it("stages nothing when the agent has no credential file", async () => {
    expect(await stageAgentCredentials("codex-cli", path.join(tmp, "r"), { homedir: home, env: {} })).toEqual({ env: {}, staged: false });
  });
});

describe("args and prompt", () => {
  const ctx = { cwd: "/t", outputFile: "/t/response.txt" };
  it("claude: no tools, no persistence, --tools '' last", () => {
    const args = buildAgentArgs("claude-code", { models: { "claude-code": "sonnet" } }, ctx);
    expect(args.slice(-2)).toEqual(["--tools", ""]);
    expect(args).toEqual(expect.arrayContaining(["--print", "--no-session-persistence", "--disable-slash-commands", "--model", "sonnet"]));
  });
  it("codex: read-only sandbox, ephemeral, stdin prompt", () => {
    const args = buildAgentArgs("codex-cli", { codexReasoningEffort: "low" }, ctx);
    expect(args[0]).toBe("exec");
    expect(args).toEqual(expect.arrayContaining(["--sandbox", "read-only", "--ephemeral", "--output-last-message", "/t/response.txt", "--config", 'model_reasoning_effort="low"']));
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain("--model");
  });
  it("prompt includes schema instruction only when given", () => {
    expect(buildPrompt({ prompt: "hi" })).toContain("Do not modify files or run tools");
    const p = buildPrompt({ prompt: "hi", systemPrompt: "sys", schema: { type: "object" } });
    expect(p).toContain('{"type":"object"}');
    expect(p).toContain("sys");
  });
});

describe("classifyFailure", () => {
  const o = (over: object) => ({ exitCode: 1, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, ...over });
  it("orders auth before retryable hints", () => {
    expect(classifyFailure(o({ stderr: "Reconnecting... 401 Unauthorized, try again" }))).toBe("auth_permanent");
    expect(classifyFailure(o({ spawnCode: "ENOENT" }))).toBe("not_installed");
    expect(classifyFailure(o({ timedOut: true }))).toBe("timeout");
    expect(classifyFailure(o({ aborted: true }))).toBe("cancelled");
    expect(classifyFailure(o({ stderr: "429 rate limit" }))).toBe("rate_limit");
    expect(classifyFailure(o({ stderr: "error: unknown option '--foo'" }))).toBe("format");
    expect(classifyFailure(o({ stderr: "service overloaded" }))).toBe("overloaded");
    expect(classifyFailure(o({ stderr: "weird" }))).toBe("unknown");
  });
});

// ---- runner with a fake spawn ------------------------------------------------

interface Call { command: string; args: string[]; cwd: string; env: Record<string, string>; stdin: string; killed: string[] }
type Script = (call: Call, child: FakeChild) => void | Promise<void>;

class FakeChild extends EventEmitter {
  // This synthetic process has no real descendants. Production spawns must prove this.
  async cleanup() { return { status: "quiescent" as const, mechanism: "linux-pid-namespace" as const }; }
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinBuf = "";
  killed: string[] = [];
  stdin = Object.assign(new EventEmitter(), {
    write: (d: string) => void (this.stdinBuf += d),
    end: () => void this.emit("stdin-end"),
  });
  kill(sig?: NodeJS.Signals) {
    this.killed.push(sig ?? "SIGTERM");
    // Like a real process, die from the signal.
    queueMicrotask(() => this.emit("close", null, sig ?? "SIGTERM"));
    return true;
  }
  finish(code: number, out = "", err = "") {
    if (out) this.stdout.emit("data", Buffer.from(out));
    if (err) this.stderr.emit("data", Buffer.from(err));
    this.emit("close", code, null);
  }
}

function fakeSpawn(script: Script) {
  const calls: Call[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild();
    const call: Call = { command, args, cwd: options.cwd, env: options.env, stdin: "", killed: child.killed };
    calls.push(call);
    child.on("stdin-end", () => {
      call.stdin = child.stdinBuf;
      queueMicrotask(() => void script(call, child));
    });
    return child as unknown as ChildLike;
  };
  return { spawn, calls };
}

function makeRunner(script: Script, extra: object = {}) {
  const f = fakeSpawn(script);
  const runner = createAgentRunner({
    environment: { spawn: f.spawn, env: { PATH: bin, OPENAI_API_KEY: "sk", MY_TOKEN: "t" }, homedir: home, tmpBase: tmp },
    authFiles: bridgeLogins(),
    timeoutMs: 2_000,
    killGraceMs: 10,
    ...extra,
  });
  return { ...f, runner };
}

describe("runTask", () => {
  it("runs codex sandboxed, feeds the prompt on stdin, reads the output file, cleans up", async () => {
    await exe(path.join(bin, "codex"));
    await mkdir(CX(), { recursive: true });
    await writeFile(path.join(CX(), "auth.json"), JSON.stringify({ tokens: { access_token: "a" } }));
    const { runner, calls } = makeRunner(async (call, child) => {
      const out = call.args[call.args.indexOf("--output-last-message") + 1]!;
      expect(JSON.parse(await readFile(path.join(call.env.CODEX_HOME!, "auth.json"), "utf8")).tokens.access_token).toBe("a");
      await writeFile(out, "final answer\n");
      child.finish(0, "noise");
    });
    const r = await runner.runTask({ prompt: "2+2?" }).result;
    expect(r).toMatchObject({ ok: true, agent: "codex-cli", output: "final answer" });
    const call = calls[0]!;
    expect(call.stdin).toContain("2+2?");
    expect(call.env.HOME).toBe(path.join(call.cwd, "home"));
    expect(call.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(call.env).not.toHaveProperty("MY_TOKEN");
    expect(await readdir(tmp)).toEqual([]); // throwaway dir removed
  });

  it("fails over from a signed-out agent to the next, recording attempts", async () => {
    await exe(path.join(bin, "codex"));
    await exe(path.join(bin, "claude"));
    const { runner, calls } = makeRunner((call, child) => {
      if (call.command.endsWith("codex")) child.finish(1, "", "401 Unauthorized. Not logged in");
      else child.finish(0, "from claude\n");
    });
    const r = await runner.runTask({ prompt: "x" }).result;
    expect(r).toMatchObject({ ok: true, agent: "claude-code", output: "from claude" });
    expect(r.attempts).toMatchObject([{ agent: "codex-cli", reason: "auth_permanent" }]);
    expect(calls.map((c) => path.basename(c.command))).toEqual(["codex", "claude"]);
  });

  it("skips uninstalled agents and reports not_installed when none exist", async () => {
    const { runner, calls } = makeRunner(() => undefined);
    const r = await runner.runTask({ prompt: "x" }).result;
    expect(r).toMatchObject({ ok: false, reason: "not_installed" });
    expect(r.attempts.map((a) => a.agent)).toEqual(["codex-cli", "claude-code"]);
    expect(calls).toHaveLength(0);
  });

  it("stops the ladder on a format error (stale argv) instead of burning every agent", async () => {
    await exe(path.join(bin, "codex"));
    await exe(path.join(bin, "claude"));
    const { runner, calls } = makeRunner((_c, child) => child.finish(2, "", "error: unknown option '--ephemeral'"));
    const r = await runner.runTask({ prompt: "x" }).result;
    expect(r).toMatchObject({ ok: false, reason: "format" });
    expect(calls).toHaveLength(1);
  });

  it("honours a pinned agent without failover", async () => {
    await exe(path.join(bin, "codex"));
    await exe(path.join(bin, "claude"));
    const { runner, calls } = makeRunner((_c, child) => child.finish(0, "ok"));
    const r = await runner.runTask({ prompt: "x", agent: "claude-code" }).result;
    expect(r).toMatchObject({ ok: true, agent: "claude-code" });
    expect(calls).toHaveLength(1);
  });

  it("times out and kills the child", async () => {
    await exe(path.join(bin, "claude"));
    const { runner, calls } = makeRunner(() => undefined, { timeoutMs: 30, order: ["claude-code"] });
    const r = await runner.runTask({ prompt: "x" }).result;
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(calls[0]!.killed).toContain("SIGTERM");
  });
});

describe("cancel and status", () => {
  it("cancel kills the running child and resolves the task as cancelled", async () => {
    await exe(path.join(bin, "claude"));
    await exe(path.join(bin, "codex"));
    const { runner, calls } = makeRunner(() => undefined);
    const handle = runner.runTask({ id: "t1", prompt: "x" });
    await new Promise((r) => setTimeout(r, 30));
    expect(runner.cancel("t1")).toBe(true);
    const r = await handle.result;
    expect(r).toMatchObject({ ok: false, reason: "cancelled" });
    expect(calls).toHaveLength(1); // cancelled: no failover to the next agent
    expect(calls[0]!.killed[0]).toBe("SIGTERM");
    expect(runner.cancel("t1")).toBe(false); // already finished
    expect(await readdir(tmp)).toEqual([]);
  });

  it("status probes each agent in the sandbox", async () => {
    await exe(path.join(bin, "claude"));
    await exe(path.join(bin, "codex"));
    const { runner, calls } = makeRunner((call, child) => {
      if (call.command.endsWith("claude")) child.finish(0, '{"loggedIn": false}');
      else child.finish(0, "Logged in using ChatGPT");
    });
    const s = await runner.status();
    expect(s.running).toEqual([]);
    expect(s.agents).toMatchObject([
      { agent: "codex-cli", installed: true, authenticated: true },
      { agent: "claude-code", installed: true, authenticated: false },
    ]);
    expect(calls.find((c) => c.command.endsWith("codex"))!.args).toEqual(["login", "status"]);
    expect(await readdir(tmp)).toEqual([]);
  });

  it("status reports a missing agent as not installed", async () => {
    const { runner } = makeRunner(() => undefined);
    expect((await runner.status()).agents.every((a) => !a.installed)).toBe(true);
  });
});

describe("runTask credential handling", () => {
  for (const probe of [false, true]) {
    it(`retains the login lease when actual ${probe ? "probe" : "task"} folder removal fails`, async () => {
      await exe(path.join(bin, "codex"));
      await mkdir(CX(), { recursive: true });
      await writeFile(path.join(CX(), "auth.json"), JSON.stringify({ tokens: { access_token: "synthetic" } }));
      const { runner, calls } = makeRunner((call, child) => {
        cleanupFault.target = call.cwd;
        child.finish(0, "ok");
      }, { order: ["codex-cli"] });
      if (probe) {
        expect((await runner.status()).agents[0]).toMatchObject({ authenticated: false, error: expect.stringContaining("folder cleanup is incomplete") });
      } else {
        expect(await runner.runTask({ prompt: "x" }).result).toMatchObject({ ok: false, message: expect.stringContaining("folder cleanup is incomplete") });
      }
      expect(await readFile(path.join(calls[0]!.env.CODEX_HOME!, "auth.json"), "utf8")).toContain("synthetic");
      await expect(stageAgentCredentials("codex-cli", path.join(tmp, "retry"), { homedir: home, env: {}, authFiles: bridgeLogins() })).rejects.toMatchObject({ code: "AGENT_LOGIN_BUSY" });
    });
  }

  for (const fault of ["missing-source", "missing-staged", "invalid-staged", "stale-source", "retarget-source"] as const) {
    it(`retains staging and lease when the task cannot verify persistence: ${fault}`, async () => {
      await exe(path.join(bin, "codex"));
      await mkdir(CX(), { recursive: true });
      const source = path.join(CX(), "auth.json");
      await writeFile(source, JSON.stringify({ tokens: { access_token: "original" } }));
      const { runner, calls } = makeRunner(async (call, child) => {
        const staged = path.join(call.env.CODEX_HOME!, "auth.json");
        await writeFile(staged, JSON.stringify({ tokens: { access_token: "rotated-latest" } }));
        if (fault === "missing-source") await rm(source);
        if (fault === "missing-staged") await rm(staged);
        if (fault === "invalid-staged") await writeFile(staged, "invalid synthetic login");
        if (fault === "stale-source") await writeFile(source, JSON.stringify({ tokens: { access_token: "separate-login" } }));
        if (fault === "retarget-source") {
          const target = path.join(root, "replacement-login.json");
          await writeFile(target, JSON.stringify({ tokens: { access_token: "separate-login" } }));
          await rm(source);
          await symlink(target, source);
        }
        child.finish(0, "ok");
      });
      expect(await runner.runTask({ prompt: "x", agent: "codex-cli" }).result).toMatchObject({ ok: false, message: expect.stringContaining("write-back failed") });
      expect((await stat(calls[0]!.cwd)).isDirectory()).toBe(true);
      expect((await stat(`${source}.bridge-login-lease`)).isDirectory()).toBe(true);
      if (fault === "stale-source" || fault === "retarget-source") {
        expect(await readFile(source, "utf8")).toContain("separate-login");
        expect(await readFile(path.join(calls[0]!.env.CODEX_HOME!, "auth.json"), "utf8")).toContain("rotated-latest");
      }
    });
  }
  it("retains a staged login and stops failover when a custom spawn has no descendant cleanup evidence", async () => {
    await exe(path.join(bin, "codex"));
    await exe(path.join(bin, "claude"));
    await mkdir(CX(), { recursive: true });
    await writeFile(path.join(CX(), "auth.json"), JSON.stringify({ tokens: { access_token: "synthetic" } }));
    const fake = fakeSpawn((_call, child) => child.finish(0, "direct leader exited"));
    const spawn: SpawnFn = (...args) => {
      const child = fake.spawn(...args);
      child.cleanup = undefined;
      return child;
    };
    const runner = createAgentRunner({ environment: { spawn, env: { PATH: bin }, homedir: home, tmpBase: tmp }, authFiles: bridgeLogins() });
    expect(await runner.runTask({ prompt: "x" }).result).toMatchObject({ ok: false, message: expect.stringContaining("cleanup is incomplete") });
    expect(fake.calls).toHaveLength(1);
    expect(await readFile(path.join(fake.calls[0]!.env.CODEX_HOME!, "auth.json"), "utf8")).toContain("synthetic");
    await expect(stageAgentCredentials("codex-cli", path.join(tmp, "retry"), { homedir: home, env: {}, authFiles: bridgeLogins() })).rejects.toMatchObject({ code: "AGENT_LOGIN_BUSY" });
  });

  it("retains the refreshed login and lease when write-back fails instead of losing the rotated grant", async () => {
    await exe(path.join(bin, "codex"));
    const source = path.join(CX(), "auth.json");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, JSON.stringify({ tokens: { access_token: "old", refresh_token: "old-refresh" } }));
    let stagedFile = "";
    const { runner } = makeRunner(async (call, child) => {
      stagedFile = path.join(call.env.CODEX_HOME!, "auth.json");
      await writeFile(stagedFile, JSON.stringify({ tokens: { access_token: "new", refresh_token: "rotated-refresh" } }));
      writeBackFault.target = source;
      child.finish(0, "ok");
    });
    expect(await runner.runTask({ prompt: "x", agent: "codex-cli" }).result).toMatchObject({ ok: false, message: expect.stringContaining("retained for recovery") });
    expect(JSON.parse(await readFile(stagedFile, "utf8")).tokens.refresh_token).toBe("rotated-refresh");
    expect(JSON.parse(await readFile(source, "utf8")).tokens.refresh_token).toBe("old-refresh");
    await expect(stageAgentCredentials("codex-cli", path.join(tmp, "next"), { homedir: home, env: {}, authFiles: bridgeLogins() })).rejects.toThrow(/lease|use|active|busy/i);
  });

  it("writes a token refreshed inside the sandbox back to the real codex auth.json", async () => {
    await exe(path.join(bin, "codex"));
    const real = path.join(CX(), "auth.json");
    await mkdir(path.dirname(real), { recursive: true });
    await writeFile(real, JSON.stringify({ tokens: { access_token: "old" } }));
    const { runner } = makeRunner(async (call, child) => {
      await writeFile(path.join(call.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { access_token: "refreshed" } }));
      child.finish(0, "ok");
    });
    expect(await runner.runTask({ prompt: "x" }).result).toMatchObject({ ok: true });
    expect(JSON.parse(await readFile(real, "utf8")).tokens.access_token).toBe("refreshed");
    expect((await stat(real)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(real))).toEqual(["auth.json"]); // no temp litter
  });

  it("writes a refreshed claude token back without dropping other keys, and stages only claudeAiOauth", async () => {
    await exe(path.join(bin, "claude"));
    const real = path.join(CL(), ".credentials.json");
    await mkdir(path.dirname(real), { recursive: true });
    await writeFile(real, JSON.stringify({ claudeAiOauth: { accessToken: "old" }, mcpOAuth: { srv: { token: "mcp-secret" } } }));
    let staged = "";
    const { runner } = makeRunner(async (call, child) => {
      const file = path.join(call.env.CLAUDE_CONFIG_DIR!, ".credentials.json");
      staged = await readFile(file, "utf8");
      await writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: "new" } }));
      child.finish(0, "ok");
    });
    expect(await runner.runTask({ prompt: "x", agent: "claude-code" }).result).toMatchObject({ ok: true });
    expect(staged).not.toContain("mcp-secret");
    expect(staged).not.toContain("mcpOAuth");
    const after = JSON.parse(await readFile(real, "utf8"));
    expect(after.claudeAiOauth.accessToken).toBe("new");
    expect(after.mcpOAuth.srv.token).toBe("mcp-secret");
  });

  it("never writes through a symlink: a linked login stages nothing, and a link swapped in later is not refreshed", async () => {
    const target = path.join(root, "personal/auth.json");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({ tokens: { access_token: "a" } }));
    const link = path.join(CX(), "auth.json");
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(target, link);
    const src = { homedir: home, env: {}, authFiles: bridgeLogins() };
    expect(await stageAgentCredentials("codex-cli", path.join(root, "run"), src)).toEqual({ env: {}, staged: false });
    expect(await agentLoginPresent("codex-cli", link)).toBe(false);

    // A real file staged first, then replaced by a link before the refresh lands.
    await rm(link);
    await writeFile(link, JSON.stringify({ tokens: { access_token: "a" } }));
    const staged = await stageAgentCredentials("codex-cli", path.join(root, "run2"), src);
    await rm(link);
    await symlink(target, link);
    await writeFile(path.join(staged.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { access_token: "b" } }));
    await expect(staged.persistRefresh!()).rejects.toMatchObject({ code: "AGENT_LOGIN_PERSISTENCE_UNVERIFIED" });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(target, "utf8")).tokens.access_token).toBe("a");
  });

  it("a symlinked login folder stages nothing and is never refreshed into", async () => {
    const outside = path.join(root, "personal-claude");
    await mkdir(outside, { recursive: true });
    const personal = JSON.stringify({ claudeAiOauth: { accessToken: "p1" }, mcpOAuth: { x: 1 } });
    await writeFile(path.join(outside, ".credentials.json"), personal);
    await mkdir(path.dirname(CL()), { recursive: true });
    await symlink(outside, CL());
    const src = { homedir: home, env: {}, authFiles: bridgeLogins() };
    expect(await stageAgentCredentials("claude-code", path.join(root, "run"), src)).toEqual({ env: {}, staged: false });
    expect(await agentLoginPresent("claude-code", path.join(CL(), ".credentials.json"))).toBe(false);

    // The folder becomes a link after staging: persistence must report unverified without writing.
    await rm(CL());
    await mkdir(CL());
    await writeFile(path.join(CL(), ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "p1" } }));
    const staged = await stageAgentCredentials("claude-code", path.join(root, "run2"), src);
    expect(staged.staged).toBe(true);
    await rm(CL(), { recursive: true });
    await symlink(outside, CL());
    await writeFile(path.join(staged.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "p2" } }));
    await expect(staged.persistRefresh!()).rejects.toMatchObject({ code: "AGENT_LOGIN_PERSISTENCE_UNVERIFIED" });
    expect(await readFile(path.join(outside, ".credentials.json"), "utf8")).toBe(personal);
  });

  it("a symlinked agents folder (the grandparent) stages nothing and is never refreshed into", async () => {
    const outside = path.join(root, "outside-agents");
    await mkdir(path.join(outside, "claude"), { recursive: true });
    const personal = JSON.stringify({ claudeAiOauth: { accessToken: "p1" }, mcpOAuth: { x: 1 } });
    await writeFile(path.join(outside, "claude/.credentials.json"), personal);
    const agents = path.join(home, "config/bridge/agents");
    await mkdir(path.dirname(agents), { recursive: true });
    await symlink(outside, agents);
    const file = path.join(agents, "claude/.credentials.json");
    const src = { homedir: home, env: {}, authFiles: { "claude-code": file } };
    expect(await stageAgentCredentials("claude-code", path.join(root, "run"), src)).toEqual({ env: {}, staged: false });
    expect(await agentLoginPresent("claude-code", file)).toBe(false);

    // Linked only after staging: persistence must report unverified without writing.
    await rm(agents);
    await mkdir(path.join(agents, "claude"), { recursive: true });
    await writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: "p1" } }));
    const staged = await stageAgentCredentials("claude-code", path.join(root, "run2"), src);
    expect(staged.staged).toBe(true);
    await rm(agents, { recursive: true });
    await symlink(outside, agents);
    await writeFile(path.join(staged.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "p2" } }));
    await expect(staged.persistRefresh!()).rejects.toMatchObject({ code: "AGENT_LOGIN_PERSISTENCE_UNVERIFIED" });
    expect(await readFile(path.join(outside, "claude/.credentials.json"), "utf8")).toBe(personal);
  });

  it("a login whose config ancestor resolves into an agent's own folder stages nothing and is never refreshed there", async () => {
    // A static layout, no race: the config dir is a link into ~/.claude (or $CODEX_HOME).
    const claudeHome = path.join(home, ".claude");
    const codexHome = path.join(root, "codex-home");
    const login = { claude: JSON.stringify({ claudeAiOauth: { accessToken: "p1" } }), codex: JSON.stringify({ tokens: { access_token: "a1" } }) };
    for (const [own, env] of [
      [claudeHome, {}],
      [codexHome, { CODEX_HOME: codexHome }],
    ] as const) {
      await rm(path.join(home, "config"), { recursive: true, force: true });
      await mkdir(path.join(own, "bridge/agents/claude"), { recursive: true });
      await mkdir(path.join(own, "bridge/agents/codex"), { recursive: true });
      await writeFile(path.join(own, "bridge/agents/claude/.credentials.json"), login.claude);
      await writeFile(path.join(own, "bridge/agents/codex/auth.json"), login.codex);
      await symlink(own, path.join(home, "config"));
      const src = { homedir: home, env, authFiles: bridgeLogins() };
      for (const agent of ["claude-code", "codex-cli"] as const) {
        expect(await stageAgentCredentials(agent, path.join(root, `run-${agent}`), src)).toEqual({ env: {}, staged: false });
      }
      expect(await readFile(path.join(own, "bridge/agents/claude/.credentials.json"), "utf8")).toBe(login.claude);
      expect(await readFile(path.join(own, "bridge/agents/codex/auth.json"), "utf8")).toBe(login.codex);
    }
  });

  it("an absent ~/.claude still counts: a login under it stages nothing, and present-with-src is false inside an agent's folder", async () => {
    const file = path.join(home, ".claude/config/bridge/agents/codex/auth.json");
    const src = { homedir: home, env: {}, authFiles: { "codex-cli": file } };
    expect(await stageAgentCredentials("codex-cli", path.join(root, "run"), src)).toEqual({ env: {}, staged: false });
    await expect(lstat(path.join(home, ".claude"))).rejects.toThrow();

    // Present, but inside ~/.claude: what staging refuses, agentLoginPresent with src calls absent.
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ tokens: { access_token: "a" } }));
    expect(await stageAgentCredentials("codex-cli", path.join(root, "run2"), src)).toEqual({ env: {}, staged: false });
    expect(await agentLoginPresent("codex-cli", file)).toBe(true);
    expect(await agentLoginPresent("codex-cli", file, src)).toBe(false);
  });

  it("a dangling ~/.claude link into bridge's agents folder, or a loop at ~/.codex, stages nothing", async () => {
    await mkdir(CX(), { recursive: true });
    await writeFile(path.join(CX(), "auth.json"), JSON.stringify({ tokens: { access_token: "a" } }));
    const src = { homedir: home, env: {}, authFiles: bridgeLogins() };
    expect((await stageAgentCredentials("codex-cli", path.join(root, "run0"), src)).staged).toBe(true);
    // ~/.claude -> <agents>/claude (missing): it is where claude would write, inside bridge's agents folder.
    await symlink(CL(), path.join(home, ".claude"));
    expect(await resolveProtectedDir(path.join(home, ".claude"))).toBe(path.join(await realpath(path.dirname(CL())), "claude"));
    expect(await stageAgentCredentials("codex-cli", path.join(root, "run1"), src)).toEqual({ env: {}, staged: false });
    expect(await agentLoginPresent("codex-cli", path.join(CX(), "auth.json"), src)).toBe(false);
    await rm(path.join(home, ".claude"));
    await symlink(path.join(home, ".codex"), path.join(home, ".codex"));
    expect(await resolveProtectedDir(path.join(home, ".codex"))).toBeNull();
    expect(await stageAgentCredentials("codex-cli", path.join(root, "run2"), src)).toEqual({ env: {}, staged: false });
  });

  it("resolves `..` after a link the way the kernel does: CODEX_HOME=<v>/alias/../config/bridge with alias -> real/sub", async () => {
    const v = path.join(root, "v");
    await mkdir(path.join(v, "real/sub"), { recursive: true });
    await mkdir(path.join(v, "real/config/bridge/agents/codex"), { recursive: true });
    await symlink(path.join(v, "real/sub"), path.join(v, "alias"));
    const codexHome = `${v}/alias/../config/bridge`;
    const realV = await realpath(v);
    expect(await resolveProtectedDir(codexHome)).toBe(path.join(realV, "real/config/bridge"));
    const file = path.join(v, "real/config/bridge/agents/codex/auth.json");
    await writeFile(file, JSON.stringify({ tokens: { access_token: "a" } }));
    const src = { homedir: home, env: { CODEX_HOME: codexHome }, authFiles: { "codex-cli": file } };
    expect(await stageAgentCredentials("codex-cli", path.join(root, "run"), src)).toEqual({ env: {}, staged: false });
    expect(await agentLoginPresent("codex-cli", file, src)).toBe(false);
  });

  it("a refresh refuses persistence once an ancestor of its bound login is retargeted", async () => {
    const real = path.join(root, "real-config");
    await mkdir(path.join(real, "bridge/agents/codex"), { recursive: true });
    await writeFile(path.join(real, "bridge/agents/codex/auth.json"), JSON.stringify({ tokens: { access_token: "a" } }));
    await symlink(real, path.join(home, "config"));
    const src = { homedir: home, env: {}, authFiles: bridgeLogins() };
    const staged = await stageAgentCredentials("codex-cli", path.join(root, "run"), src);
    expect(staged.staged).toBe(true);
    // Retargeted into ~/.codex after staging.
    const codexHome = path.join(home, ".codex");
    await mkdir(path.join(codexHome, "bridge/agents/codex"), { recursive: true });
    const personal = JSON.stringify({ tokens: { access_token: "a" } });
    await writeFile(path.join(codexHome, "bridge/agents/codex/auth.json"), personal);
    await rm(path.join(home, "config"));
    await symlink(codexHome, path.join(home, "config"));
    await writeFile(path.join(staged.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { access_token: "b" } }));
    await expect(staged.persistRefresh!()).rejects.toMatchObject({ code: "AGENT_LOGIN_PERSISTENCE_UNVERIFIED" });
    expect(await readFile(path.join(codexHome, "bridge/agents/codex/auth.json"), "utf8")).toBe(personal);
    expect(JSON.parse(await readFile(path.join(real, "bridge/agents/codex/auth.json"), "utf8")).tokens.access_token).toBe("a");
  });

  it("without an authFiles entry nothing is staged and the home login stays unread and unwritten", async () => {
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const claudeRaw = JSON.stringify({ claudeAiOauth: { accessToken: "personal" } });
    await writeFile(path.join(home, ".claude/.credentials.json"), claudeRaw);
    const codexAuth = JSON.stringify({ tokens: { access_token: "a1" } });
    await writeFile(path.join(home, ".codex/auth.json"), codexAuth);
    const env = { CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex") };
    const none = { env: {}, staged: false };
    for (const authFiles of [undefined, {}]) {
      for (const agent of ["claude-code", "codex-cli"] as const) {
        expect(await stageAgentCredentials(agent, path.join(tmp, `r-${agent}`), { homedir: home, env, authFiles })).toEqual(none);
      }
    }
    // One entry does not open the other agent's home default.
    const onlyClaude = { "claude-code": path.join(home, "bridge/claude/.credentials.json") };
    expect(await stageAgentCredentials("codex-cli", path.join(tmp, "r-x"), { homedir: home, env, authFiles: onlyClaude })).toEqual(none);
    expect(await readFile(path.join(home, ".claude/.credentials.json"), "utf8")).toBe(claudeRaw);
    expect(await readFile(path.join(home, ".codex/auth.json"), "utf8")).toBe(codexAuth);
  });

  it("refuses concurrent stages of one login until explicit release, then retry sees the refresh", async () => {
    const real = path.join(CX(), "auth.json");
    await mkdir(path.dirname(real), { recursive: true });
    await writeFile(real, JSON.stringify({ tokens: { access_token: "a" } }));
    const src = { homedir: home, env: {}, authFiles: bridgeLogins() };
    const first = await stageAgentCredentials("codex-cli", path.join(root, "r1"), src);
    await expect(stageAgentCredentials("codex-cli", path.join(root, "r2"), src)).rejects.toMatchObject({ code: "AGENT_LOGIN_BUSY" });
    await writeFile(path.join(first.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { access_token: "rotated" } }));
    await first.persistRefresh!();
    // Persisting alone must not make a still-running agent's login available.
    await expect(stageAgentCredentials("codex-cli", path.join(root, "r3"), src)).rejects.toMatchObject({ code: "AGENT_LOGIN_BUSY" });
    await first.release!();
    const retry = await stageAgentCredentials("codex-cli", path.join(root, "retry"), src);
    expect(JSON.parse(await readFile(path.join(retry.env.CODEX_HOME!, "auth.json"), "utf8")).tokens.access_token).toBe("rotated");
    await retry.release!();
    expect(await readdir(path.dirname(real))).toEqual(["auth.json"]);
  });

  it("retains compare-before-write rejection when a login changes outside its lease", async () => {
    const real = path.join(CX(), "auth.json");
    await mkdir(path.dirname(real), { recursive: true });
    await writeFile(real, JSON.stringify({ tokens: { access_token: "a" } }));
    const staged = await stageAgentCredentials("codex-cli", path.join(root, "r1"), { homedir: home, env: {}, authFiles: bridgeLogins() });
    await writeFile(path.join(staged.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { access_token: "stale-base-refresh" } }));
    await writeFile(real, JSON.stringify({ tokens: { access_token: "new-login" } }));
    await expect(staged.persistRefresh!()).rejects.toMatchObject({ code: "AGENT_LOGIN_PERSISTENCE_UNVERIFIED" });
    expect(JSON.parse(await readFile(real, "utf8")).tokens.access_token).toBe("new-login");
    expect(renames.filter((t) => t === real)).toHaveLength(0);
    expect(await readFile(path.join(staged.env.CODEX_HOME!, "auth.json"), "utf8")).toContain("stale-base-refresh");
    expect(await readdir(path.dirname(real))).toContain("auth.json.bridge-login-lease");
  });
});

describe("runner robustness", () => {
  it("rejects a duplicate running id without disturbing the live task", async () => {
    await exe(path.join(bin, "claude"));
    const { runner, calls } = makeRunner(() => undefined, { order: ["claude-code"] });
    const first = runner.runTask({ id: "dup", prompt: "x" });
    await new Promise((r) => setTimeout(r, 30));
    const second = await runner.runTask({ id: "dup", prompt: "y" }).result;
    expect(second).toMatchObject({ ok: false, message: expect.stringContaining("already running") });
    expect(runner.cancel("dup")).toBe(true); // still cancellable
    expect(await first.result).toMatchObject({ reason: "cancelled" });
    expect(calls).toHaveLength(1); // the duplicate never spawned
  });

  it("status reports a probe failure per agent instead of rejecting", async () => {
    await exe(path.join(bin, "claude"));
    const broken = createAgentRunner({
      environment: { spawn: fakeSpawn(() => undefined).spawn, env: { PATH: bin }, homedir: home, tmpBase: path.join(root, "does-not-exist") },
    });
    const s = await broken.status();
    expect(s.agents.find((a) => a.agent === "claude-code")).toMatchObject({ installed: true, authenticated: false, error: expect.any(String) });
  });

  it("maps internal agent ids to the protocol's heartbeat ids", () => {
    expect(
      toHeartbeatAgents({
        running: [],
        agents: [
          { agent: "codex-cli", installed: true, authenticated: true },
          { agent: "claude-code", installed: true, authenticated: false },
        ],
      }),
    ).toEqual([
      { id: "codex", available: true },
      { id: "claude", available: false },
    ]);
  });
});
