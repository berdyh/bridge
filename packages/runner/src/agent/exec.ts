import type { SpawnFn } from "./types.js";
import { boundedCleanup, type ProcessCleanupResult } from "../acp/cleanup.js";

export interface ExecOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** errno code when the process could not be started (ENOENT, EACCES). */
  spawnCode?: string;
  spawnMessage?: string;
  /** Exited 0 but its stdin closed before the prompt was delivered. */
  stdinFailed?: Error;
  /** Awaited after close/error, before a staged login can be persisted or released. */
  cleanup?: ProcessCleanupResult;
}

export interface ExecOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Delay between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  /** Staged OAuth requires a lifecycle namespace; this does not select an SRT tool policy. */
  requireCleanup?: boolean;
}

/** Spawn, feed stdin, collect output; never rejects. */
export function execCollect(spawn: SpawnFn, opts: ExecOptions): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let stdinFailed: Error | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (outcome: Omit<ExecOutcome, "stdout" | "stderr" | "timedOut" | "aborted">) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      void boundedCleanup(async () => child?.cleanup
        ? await child.cleanup()
        : { status: "incomplete", mechanism: "process-group", reason: "descendants-unverified" },
      (opts.killGraceMs ?? 1_000) + 3_000, opts.requireCleanup ? "linux-pid-namespace" : "process-group")
        .then((cleanup) => resolve({ ...outcome, stdout, stderr, timedOut, aborted, stdinFailed, cleanup }));
    };

    let child: ReturnType<SpawnFn>;
    try {
      child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, requireCleanup: opts.requireCleanup });
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      return finish({ exitCode: null, signal: null, spawnCode: e.code, spawnMessage: e.message });
    }

    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), opts.killGraceMs ?? 1_000);
      killTimer.unref();
    };
    function onAbort() {
      aborted = true;
      terminate();
    }

    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);

    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (c: Buffer | string) => (stdout += c.toString()));
    child.stderr?.on("data", (c: Buffer | string) => (stderr += c.toString()));
    child.on("error", (error) => {
      const e = error as NodeJS.ErrnoException;
      finish({ exitCode: null, signal: null, spawnCode: e.code, spawnMessage: e.message });
    });
    child.on("close", (exitCode, signal) => finish({ exitCode, signal }));
    child.stdin?.on("error", (e) => (stdinFailed ??= e));
    if (opts.stdin) child.stdin?.write(opts.stdin);
    child.stdin?.end();
  });
}
