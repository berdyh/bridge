// The helpers that check a containment run against a real claude login, proved without a subscription.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { endProcessGroup, endRealRun, ranProblems, toolListViolations, writeBackLogin } from "./containment-real-checks.js";
import { scratchRoot } from "./scratch.js";

const ok = (text: string) => ({ ok: true as const, stopReason: "end_turn", text });

describe("ranProblems (positive control before an absence check)", () => {
  it("is empty only when the session started and every prompt was answered with text", () => {
    expect(ranProblems({ started: true, prompts: [ok("hello")] }, 1)).toEqual([]);
    expect(ranProblems({ started: true, prompts: [ok("a"), ok("b"), ok("c")] }, 3)).toEqual([]);
  });

  it.each([
    ["a session that did not start", { started: false, error: { code: -32016, message: "no login" } }, 1],
    ["a started session with no prompt results", { started: true, prompts: [] }, 1],
    ["a failed prompt", { started: true, prompts: [{ ok: false as const, error: { code: -32603, message: "auth" } }] }, 1],
    ["an empty answer", { started: true, prompts: [ok("  \n")] }, 1],
    ["one of three prompts failing", { started: true, prompts: [ok("a"), { ok: false as const, error: { code: null, message: "x" } }, ok("c")] }, 3],
    ["fewer prompt results than sent", { started: true, prompts: [ok("a")] }, 3],
  ])("reports %s", (_name, report, count) => {
    expect(ranProblems(report, count)).not.toEqual([]);
  });

  // Row 2: the enforced end of the intended call (an attached, unlisted tool) is the documented outcome, not a failure.
  const breached = { started: true, sessionId: "s1", ended: "breach", prompts: [{ ok: false as const, error: { code: -32017, message: "containment breach" } }] };
  // The audit carries the runner's session id, which is the plugin's report.sessionId ("s1" here).
  const echoed = { tool: "mcp__stub__echo", audit: [{ sessionId: "s1", toolName: "mcp__stub__read" }, { sessionId: "s1", toolName: "mcp__stub__echo" }] };

  it("accepts a -32017 breach end when the end reason and the row's audit records show the intended call", () => {
    expect(ranProblems(breached, 1, echoed)).toEqual([]);
  });

  it.each([
    ["no expected breach (rows 1, 3, 4, 5)", breached, undefined],
    ["an end that is not breach", { ...breached, ended: "closed" }, echoed],
    ["no end reason", { ...breached, ended: null }, echoed],
    ["audit records of two sessions", breached, { ...echoed, audit: [{ sessionId: "s1", toolName: "mcp__stub__echo" }, { sessionId: "s2", toolName: "mcp__stub__read" }] }],
    ["audit records that name a different session than the report's", breached, { ...echoed, audit: [{ sessionId: "other", toolName: "mcp__stub__echo" }] }],
    ["a report with no session id", { ...breached, sessionId: undefined }, echoed],
    ["an audit record of another tool (a built-in reached the agent)", breached, { ...echoed, audit: [{ sessionId: "s1", toolName: "Bash" }] }],
    ["an empty audit", breached, { ...echoed, audit: [] }],
    ["an auth failure, not -32017", { ...breached, prompts: [{ ok: false as const, error: { code: -32603, message: "auth" } }] }, echoed],
    ["a breach at start (the session did not start)", { started: false, ended: "breach", sessionId: "s1", error: { code: -32017, message: "breach" } }, echoed],
  ])("still reports %s", (_name, report, enforced) => {
    expect(ranProblems(report, 1, enforced)).not.toEqual([]);
  });
});

describe("toolListViolations (row 1: the list names only mcp__stub__* tools)", () => {
  it("accepts the stub's tools and a truthful sentence about built-ins it lacks", () => {
    expect(toolListViolations("mcp__stub__read\n- `mcp__stub__echo`\nI have no Bash, Read or WebFetch tool.")).toEqual([]);
  });

  it.each(["Bash", "- Read", "1. `Write`: writes files", "* **WebFetch** fetches urls", "  Glob", "Grep (search)"])("flags the built-in line %j", (line) => {
    expect(toolListViolations(`mcp__stub__read\n${line}`)).toHaveLength(1);
  });

  it.each([
    "I have no Bash tool.",
    "Bash: not available",
    "- Bash (NOT-AVAILABLE)",
    "I can't call Read or WebFetch here",
    "There is no Write, Edit or Glob tool in this session.",
    "Without Grep or WebSearch, I only list what I have.",
  ])("accepts the negative statement %j", (line) => {
    expect(toolListViolations(`mcp__stub__read\n${line}`)).toEqual([]);
  });

  it.each([
    "Tools: mcp__stub__read, Bash",
    "mcp__stub__read and Read",
    "My tools are mcp__stub__read, mcp__stub__echo, WebFetch.",
    "I have no Bash, but I have Read",
    "I cannot call Bash. Available: Grep",
    "I don't have Bash; I do have Write",
    "No shell here, only mcp__stub__read and Glob",
  ])("flags a built-in in the positive listing %j", (line) => {
    expect(toolListViolations(line)).not.toEqual([]);
  });

  it("flags another server's tool anywhere in a line", () => {
    expect(toolListViolations("mcp__stub__read\nalso mcp__other__x")).toEqual(["mcp__other__x"]);
  });
});

describe("writeBackLogin (a refreshed token goes back to the login the user logs out)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(scratchRoot(), "writeback-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const login = (name: string, body: unknown) => writeFile(path.join(dir, name), JSON.stringify(body)).then(() => path.join(dir, name));

  it("writes the newer token, keeps the other keys, mode 0600, leaves no temp file", async () => {
    const from = await login("from.json", { claudeAiOauth: { accessToken: "new", refreshToken: "r2" } });
    const to = await login("to.json", { claudeAiOauth: { accessToken: "old", refreshToken: "r1" }, other: 1 });
    expect(await writeBackLogin(from, to)).toBe(true);
    expect(JSON.parse(await readFile(to, "utf8"))).toEqual({ claudeAiOauth: { accessToken: "new", refreshToken: "r2" }, other: 1 });
    expect((await stat(to)).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).filter((f) => f.includes("writeback"))).toEqual([]);
  });

  it("writes nothing when the tokens match, the source is unreadable or it holds no token", async () => {
    const same = { claudeAiOauth: { accessToken: "t" } };
    const a = await login("a.json", same);
    const b = await login("b.json", same);
    expect(await writeBackLogin(a, b)).toBe(false);
    const before = await readFile(b, "utf8");
    expect(await writeBackLogin(path.join(dir, "missing.json"), b)).toBe(false);
    expect(await writeBackLogin(await login("empty.json", {}), b)).toBe(false);
    expect(await readFile(b, "utf8")).toBe(before);
  });
});

describe("endRealRun (the user's own login gets the token a session refreshed at shutdown)", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(scratchRoot(), "endrun-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const oauth = (accessToken: string, expiresAt: number) => ({ claudeAiOauth: { accessToken, refreshToken: `r-${accessToken}`, expiresAt } });
  const tokenOf = async (file: string) => (JSON.parse(await readFile(file, "utf8")) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken;

  /** A scratch machine holding the run's login (`old`), the user's own copy of it, and the adapters' sandbox folder. */
  const setup = async (name: string) => {
    const dir = path.join(root, name);
    const machine = path.join(dir, "machine");
    const sandboxes = path.join(machine, "state", "tmp");
    await mkdir(sandboxes, { recursive: true });
    const machineLogin = path.join(machine, ".credentials.json");
    const ownerLogin = path.join(dir, "owner.json");
    await writeFile(machineLogin, JSON.stringify(oauth("old", 1000)));
    await writeFile(ownerLogin, JSON.stringify({ ...oauth("old", 1000), kept: true }));
    /** A session's sandbox with its staged copy, as the adapter leaves it until its cleanup. */
    const sandbox = async (token: string, expiresAt: number) => {
      const staged = path.join(sandboxes, `bridge-acp-${token}`, "claude-home", ".credentials.json");
      await mkdir(path.dirname(staged), { recursive: true });
      await writeFile(staged, JSON.stringify(oauth(token, expiresAt)));
      return staged;
    };
    const seen: { ownerAtRemoval?: string } = {};
    const removeMachine = async () => {
      seen.ownerAtRemoval = await tokenOf(ownerLogin);
      await rm(machine, { recursive: true, force: true });
    };
    return { machine, sandboxes, machineLogin, ownerLogin, sandbox, seen, removeMachine };
  };

  it("a session (row 3's control) whose cleanup persists a refresh only when the runner stops", async () => {
    const w = await setup("at-stop");
    await w.sandbox("new", 2000);
    // The adapter's cleanup on stop: the refreshed staged copy goes into the machine's login, then the sandbox goes.
    const stopSessions = async () => {
      await writeFile(w.machineLogin, JSON.stringify(oauth("new", 2000)));
      await rm(w.sandboxes, { recursive: true, force: true });
    };
    await endRealRun({ stopSessions, removeMachine: w.removeMachine, sandboxes: w.sandboxes, machineLogin: w.machineLogin, ownerLogin: w.ownerLogin });
    expect(await tokenOf(w.ownerLogin)).toBe("new");
    expect(JSON.parse(await readFile(w.ownerLogin, "utf8")).kept).toBe(true);
    expect(w.seen.ownerAtRemoval).toBe("new"); // exported before the machine folder went
  });

  it("a refresh left in a sandbox whose cleanup never ran (the runner was killed)", async () => {
    const w = await setup("left");
    await w.sandbox("stale", 500);
    await w.sandbox("new", 2000);
    await endRealRun({ stopSessions: async () => undefined, removeMachine: w.removeMachine, sandboxes: w.sandboxes, machineLogin: w.machineLogin, ownerLogin: w.ownerLogin });
    expect(await tokenOf(w.ownerLogin)).toBe("new");
  });

  it("a stale staged copy never replaces a later token the cleanup persisted", async () => {
    const w = await setup("stale");
    await w.sandbox("old", 1000);
    const stopSessions = () => writeFile(w.machineLogin, JSON.stringify(oauth("new", 2000)));
    await endRealRun({ stopSessions, removeMachine: w.removeMachine, sandboxes: w.sandboxes, machineLogin: w.machineLogin, ownerLogin: w.ownerLogin });
    expect(await tokenOf(w.ownerLogin)).toBe("new");
  });

  it("no refresh: the user's own login is left as it was", async () => {
    const w = await setup("none");
    const before = await readFile(w.ownerLogin, "utf8");
    await endRealRun({ stopSessions: async () => undefined, removeMachine: w.removeMachine, sandboxes: w.sandboxes, machineLogin: w.machineLogin, ownerLogin: w.ownerLogin });
    expect(await readFile(w.ownerLogin, "utf8")).toBe(before);
    expect(existsSync(w.machine)).toBe(false);
  });

  it("a stop that fails still writes back what was persisted, then removes the machine, then throws", async () => {
    const w = await setup("fails");
    const stopSessions = async () => {
      await writeFile(w.machineLogin, JSON.stringify(oauth("new", 2000)));
      throw new Error("runner stop failed");
    };
    await expect(endRealRun({ stopSessions, removeMachine: w.removeMachine, sandboxes: w.sandboxes, machineLogin: w.machineLogin, ownerLogin: w.ownerLogin })).rejects.toThrow("runner stop failed");
    expect(await tokenOf(w.ownerLogin)).toBe("new");
    expect(existsSync(w.machine)).toBe(false);
  });
});

describe("endProcessGroup (a process a row starts ends with the row)", () => {
  /** Running now (a zombie waiting for its reaper is dead). */
  const running = (pid: number) => {
    try {
      if (process.platform === "linux") {
        const t = readFileSync(`/proc/${pid}/stat`, "utf8");
        return t.slice(t.lastIndexOf(")") + 2, t.lastIndexOf(")") + 3) !== "Z";
      }
      // No /proc off Linux: ps prints the state letter, empty for a pid that is gone.
      const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
      return state !== "" && !state.startsWith("Z");
    } catch {
      return false;
    }
  };
  /** Whether `pid` stops running within 2 s. */
  const stops = async (pid: number) => {
    for (let i = 0; i < 20 && running(pid); i++) await new Promise((r) => setTimeout(r, 100));
    return !running(pid);
  };
  const start = async (script: string) => {
    const child = spawn("sh", ["-c", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const grandchild = await new Promise<number>((resolve) => child.stdout!.once("data", (d: Buffer) => resolve(Number(d.toString().trim()))));
    return { child, grandchild };
  };

  it("ends the leader and what it started", async () => {
    const { child, grandchild } = await start("sleep 300 & echo $!; wait");
    expect(running(grandchild)).toBe(true);
    await endProcessGroup(child);
    expect(await stops(grandchild)).toBe(true);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("kills a group that ignores SIGTERM after the bounded wait", async () => {
    const { child, grandchild } = await start("trap '' TERM; (trap '' TERM; exec sleep 300) & echo $!; while :; do sleep 1; done");
    const began = Date.now();
    await endProcessGroup(child, 300);
    expect(await stops(grandchild)).toBe(true);
    expect(Date.now() - began).toBeLessThan(10_000);
  });
});
