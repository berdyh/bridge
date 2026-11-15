import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { type AgentModelConfig, buildAgentArgs, buildPrompt } from "./args.js";
import { type CredentialSources, stageAgentCredentials } from "./credentials.js";
import { resolveAgentCommand } from "./discover.js";
import { type ExecOutcome, execCollect } from "./exec.js";
import { classifyFailure, shouldFailover, tail } from "./failure.js";
import { type EnvPolicy, buildAgentEnv, prepareRunDirs } from "../sandbox/index.js";
import {
  AGENT_IDS,
  type AgentAttempt,
  type AgentEnvironment,
  type AgentId,
  type AgentStatus,
  type AgentTask,
  type FailureReason,
  type RunnerStatus,
  type TaskHandle,
  type TaskResult,
} from "./types.js";

export interface AgentRunnerOptions extends AgentModelConfig {
  environment: AgentEnvironment;
  /** Failover order. Defaults to codex then claude. */
  order?: AgentId[];
  envPolicy?: EnvPolicy;
  commands?: Partial<Record<AgentId, string>>;
  authFiles?: Partial<Record<AgentId, string>>;
  timeoutMs?: number;
  probeTimeoutMs?: number;
  killGraceMs?: number;
}

export interface AgentRunner {
  /** Starts a task; the handle's `result` never rejects. */
  runTask(task: AgentTask): TaskHandle;
  /** Aborts a running task (kills its child). Returns false if unknown. */
  cancel(id: string): boolean;
  status(): Promise<RunnerStatus>;
}

const AUTH_PROBE_ARGS: Record<AgentId, string[]> = {
  "codex-cli": ["login", "status"],
  "claude-code": ["auth", "status"],
};

export function createAgentRunner(opts: AgentRunnerOptions): AgentRunner {
  const { environment: env } = opts;
  const order = opts.order ?? [...AGENT_IDS];
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const running = new Map<string, AbortController>();
  const creds = (): CredentialSources => ({ homedir: env.homedir, env: env.env, authFiles: opts.authFiles });
  const resolve = (agent: AgentId) =>
    resolveAgentCommand(agent, {
      homedir: env.homedir,
      pathEnv: env.env.PATH,
      overrides: opts.commands,
    });

  async function invoke(
    agent: AgentId,
    task: AgentTask,
    signal: AbortSignal,
  ): Promise<{ ok: true; output: string } | { ok: false; reason: FailureReason; message: string }> {
    const resolution = resolve(agent);
    if (!resolution) return { ok: false, reason: "not_installed", message: `${agent} not found` };

    const tempDir = await mkdtemp(path.join(env.tmpBase, "bridge-agent-"));
    let persist: (() => Promise<void>) | undefined;
    let release: (() => Promise<void>) | undefined;
    let launched = false;
    let outcome: ExecOutcome | undefined;
    try {
      await prepareRunDirs(tempDir);
      const staged = await stageAgentCredentials(agent, tempDir, creds());
      persist = staged.persistRefresh;
      release = staged.release;
      const outputFile = path.join(tempDir, "response.txt");
      // Staged credential vars last: the env policy may not override them.
      const childEnv = { ...buildAgentEnv(tempDir, env.env, opts.envPolicy), ...staged.env };
      launched = true;
      outcome = await execCollect(env.spawn, {
        command: resolution.command,
        args: buildAgentArgs(agent, opts, { cwd: tempDir, outputFile }),
        cwd: tempDir,
        env: childEnv,
        stdin: buildPrompt(task),
        timeoutMs,
        signal,
        killGraceMs: opts.killGraceMs,
        requireCleanup: staged.staged,
      });
      return await interpret(agent, outcome, outputFile);
    } finally {
      if (release && launched && outcome?.cleanup?.status !== "quiescent") {
        throw new Error("Agent descendant cleanup is incomplete; the private session folder and login lease are retained for recovery. Staged logins require a verified cleanup-capable spawn (Linux user/PID lifecycle namespaces with nodeSpawn)");
      }
      try {
        await persist?.();
      } catch {
        // Refresh-token rotation can invalidate the source login. Preserve its
        // only updated copy and the lease instead of allowing another stale run.
        throw new Error("Agent credential write-back failed; the private session folder and login lease are retained for recovery");
      }
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        throw new Error("Agent private session folder cleanup is incomplete; the login lease and remaining session state are retained for recovery");
      }
      await release?.();
    }
  }

  async function interpret(agent: AgentId, o: ExecOutcome, outputFile: string) {
    const failed = o.aborted || o.timedOut || o.spawnCode || o.exitCode !== 0 || o.stdinFailed;
    if (failed) {
      const reason = o.stdinFailed && o.exitCode === 0 && !o.aborted && !o.timedOut ? "unknown" : classifyFailure(o);
      const detail = tail(o.stderr) || tail(o.stdout) || o.spawnMessage || o.stdinFailed?.message || "";
      return { ok: false as const, reason, message: `${agent} failed (${reason}). ${detail}`.trim() };
    }
    const fromFile = (await readFile(outputFile, "utf8").catch(() => "")).trim();
    return { ok: true as const, output: fromFile || o.stdout.trim() };
  }

  async function execute(task: AgentTask, signal: AbortSignal): Promise<TaskResult> {
    const candidates = task.agent ? [task.agent] : order;
    const attempts: AgentAttempt[] = [];
    for (const agent of candidates) {
      const r = await invoke(agent, task, signal);
      if (r.ok) return { ok: true, agent, output: r.output, attempts };
      attempts.push({ agent, reason: r.reason, message: r.message });
      if (!shouldFailover(r.reason)) break;
    }
    const last = attempts[attempts.length - 1];
    return {
      ok: false,
      reason: last?.reason ?? "not_installed",
      message: last?.message ?? "no agents configured",
      attempts,
    };
  }

  return {
    runTask(task) {
      const id = task.id ?? randomUUID();
      if (running.has(id)) {
        // Never clobber the live task's controller: it would become uncancellable.
        return {
          id,
          result: Promise.resolve<TaskResult>({
            ok: false,
            reason: "unknown",
            message: `task id already running: ${id}`,
            attempts: [],
          }),
        };
      }
      const controller = new AbortController();
      running.set(id, controller);
      const result = execute(task, controller.signal)
        .catch((error): TaskResult => ({
          ok: false,
          reason: "unknown",
          message: (error as Error).message,
          attempts: [],
        }))
        .finally(() => {
          if (running.get(id) === controller) running.delete(id);
        });
      return { id, result };
    },
    cancel(id) {
      const c = running.get(id);
      if (!c) return false;
      c.abort();
      return true;
    },
    async status() {
      const agents = await Promise.all(order.map((a) => probeAgent(a)));
      return { agents, running: [...running.keys()] };
    },
  };

  async function probeAgent(agent: AgentId): Promise<AgentStatus> {
    const resolution = resolve(agent);
    if (!resolution) return { agent, installed: false, authenticated: false };
    const base = { agent, installed: true, command: resolution.command, source: resolution.source };
    let tempDir: string | undefined;
    let staged: Awaited<ReturnType<typeof stageAgentCredentials>> | undefined;
    let launched = false;
    let outcome: ExecOutcome | undefined;
    try {
      tempDir = await mkdtemp(path.join(env.tmpBase, "bridge-probe-"));
      await prepareRunDirs(tempDir);
      staged = await stageAgentCredentials(agent, tempDir, creds());
      launched = true;
      const o = outcome = await execCollect(env.spawn, {
        command: resolution.command,
        args: AUTH_PROBE_ARGS[agent],
        cwd: tempDir,
        env: { ...buildAgentEnv(tempDir, env.env, opts.envPolicy), ...staged.env },
        timeoutMs: opts.probeTimeoutMs ?? 15_000,
        killGraceMs: opts.killGraceMs,
        requireCleanup: staged.staged,
      });
      return { ...base, authenticated: probeVerdict(agent, o, staged.staged) };
    } catch (error) {
      return { ...base, authenticated: false, error: (error as Error).message };
    } finally {
      if (staged?.release && launched && outcome?.cleanup?.status !== "quiescent") {
        return { ...base, authenticated: false, error: "Agent descendant cleanup is incomplete; the private probe folder and login lease are retained for recovery. Staged logins require verified cleanup-capable spawning (Linux user/PID lifecycle namespaces with nodeSpawn)" };
      }
      try {
        await staged?.persistRefresh?.();
      } catch {
        return { ...base, authenticated: false, error: "Agent credential write-back failed; the private probe folder and login lease are retained for recovery" };
      }
      try {
        if (tempDir) await rm(tempDir, { recursive: true, force: true });
      } catch {
        return { ...base, authenticated: false, error: "Agent private probe folder cleanup is incomplete; the login lease and remaining probe state are retained for recovery" };
      }
      await staged?.release?.();
    }
  }
}

/** The CLI's own answer wins; if it cannot answer, fall back to "a credential exists". */
function probeVerdict(agent: AgentId, o: ExecOutcome, hasCredential: boolean): boolean {
  if (agent === "claude-code") {
    try {
      const m = /\{[\s\S]*\}/.exec(o.stdout);
      const parsed = m ? (JSON.parse(m[0]) as { loggedIn?: unknown }) : undefined;
      if (typeof parsed?.loggedIn === "boolean") return parsed.loggedIn;
    } catch {
      // fall through
    }
  }
  if (/not logged in/i.test(`${o.stdout}\n${o.stderr}`)) return false;
  if (!o.timedOut && !o.spawnCode && o.exitCode === 0) return true;
  return hasCredential;
}
