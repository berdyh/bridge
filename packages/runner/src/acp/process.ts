/**
 * Spawns one agent as a child process speaking ACP over stdio. Internal to the runner
 * (not in the package barrel): adapters use it, nothing else does.
 */
import { spawn } from "node:child_process";
import type { Duplex } from "node:stream";

import type { AgentExit, AgentProcess } from "./contracts.js";
import { boundedCleanup, cleanupDeadlineMs, PID_NAMESPACE_SUPERVISOR, type RawProcessCleanupResult } from "./cleanup.js";
import { ndjsonMessageStream } from "./streams.js";

/**
 * What `spawnAcpProcess` returns: an `AgentProcess` whose `cleanup()` may report the runner-internal
 * `group-empty`. Not in the package barrel; the adapter converts it before the public contract sees it.
 */
export type RawAgentProcess = Omit<AgentProcess, "cleanup"> & { cleanup?(): Promise<RawProcessCleanupResult> };

export interface SpawnAcpProcessOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** Delay between SIGTERM and SIGKILL. Default 1000 ms. */
  killGraceMs?: number;
  /** Receives the child's stderr, line by line (never the session's data path). */
  onStderr?: (line: string) => void;
  /** Test seam: replaces `process.kill` for group signals. */
  signalFn?: (pid: number, signal: NodeJS.Signals) => void;
  /** Test seam: replaces `process.kill(pid, 0)` for the macOS group-empty probe (signal 0 only). */
  probeFn?: (pid: number) => void;
  /** Test seam: the platform the macOS group-empty probe keys on. Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Fail closed unless a fresh Linux PID namespace can enclose every descendant. */
  processTree?: "linux-pid-namespace";
  /** Bounded receipt deadline, capped at 30 seconds. Does not change kill()'s compatibility contract. */
  cleanupTimeoutMs?: number;
  /** Private fd3 input for an MCP server. Zeroed immediately; never placed in argv or env. */
  secretInput?: Uint8Array;
}

/**
 * Rejects when the process cannot be started (ENOENT, EACCES). The child leads its own
 * process group, so `kill()` ends wrappers such as `npx` together with what they started.
 * `stream.closed` becomes true when the child exits.
 *
 * Ordinary process groups survive a runner crash and cannot account for setsid escapes.
 * The opt-in Linux PID namespace uses a private control pipe: losing the runner closes
 * it and kills namespace PID1, so the kernel tears down its entire descendant tree.
 * Only cleanup() returns process-tree evidence; kill()/exited alone do not.
 */
export function spawnAcpProcess(options: SpawnAcpProcessOptions): Promise<RawAgentProcess> {
  return new Promise((resolve, reject) => {
    const namespaced = options.processTree === "linux-pid-namespace";
    const graceMs = cleanupDeadlineMs(options.killGraceMs ?? 1_000);
    if (namespaced && process.platform !== "linux") {
      options.secretInput?.fill(0);
      reject(new Error("Linux PID namespace containment is unavailable"));
      return;
    }
    // A fresh supervisor must not execute caller-provided Node startup code.
    if (namespaced && (options.env.NODE_OPTIONS || options.env.NODE_PATH || Object.keys(options.env).some((key) => key.startsWith("LD_") && options.env[key]))) {
      options.secretInput?.fill(0);
      reject(new Error("Unsafe namespace supervisor environment"));
      return;
    }
    const child = spawn(namespaced ? "/usr/bin/unshare" : options.command, namespaced
      ? ["--user", "--map-root-user", "--pid", "--fork", "--kill-child=KILL", "--mount-proc", "--", process.execPath, "-e", PID_NAMESPACE_SUPERVISOR, "--", String(graceMs), options.command, ...(options.args ?? [])]
      : [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      detached: true,
    });
    const secretPipe = child.stdio[3] as Duplex;
    const controlPipe = child.stdio[4] as Duplex;
    // The target owns fd3; fd4 is kept only by the trusted PID1 supervisor.
    secretPipe.on("error", () => undefined);
    controlPipe.on("error", () => undefined);
    const secret = options.secretInput === undefined ? undefined : Buffer.from(options.secretInput);
    options.secretInput?.fill(0);
    secretPipe.end(secret, () => {
      secret?.fill(0);
      // Child-process pipe sockets do not necessarily half-close on Writable.end().
      // Close our endpoint after flushing so a server's read-until-EOF can finish.
      secretPipe.destroy();
    });
    let namespaceReady = false;
    let forcedNamespaceExit = false;

    const sendSignal = options.signalFn ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    // Once the leader has exited and the group was swept, the PGID may be reused by an
    // unrelated group: no group signal is ever sent after that.
    let groupGone = false;
    let escalation: NodeJS.Timeout | undefined;
    const sweepGroup = () => {
      if (groupGone) return;
      groupGone = true;
      if (escalation) clearTimeout(escalation);
      if (namespaced) return;
      if (child.pid === undefined) return;
      try {
        sendSignal(-child.pid, "SIGKILL");
      } catch {
        // the group is empty
      }
    };

    let exitInfo: AgentExit | undefined;
    let onExit!: (exit: AgentExit) => void;
    const exited = new Promise<AgentExit>((r) => (onExit = r));
    const stream = ndjsonMessageStream(child.stdout!, child.stdin!);

    let finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      exitInfo = { code, signal };
      stream.close("agent exited");
      onExit(exitInfo);
    };

    // `exit` (the leader is gone) is the trigger for cleanup, not `close`: `close` waits for
    // every holder of the stdio pipes, and a descendant that inherited them would block it
    // forever, so the group kill below would never fire.
    child.on("exit", (code, signal) => {
      sweepGroup();
      // The group kill closes the pipes, and `close` then delivers the rest of stdout. A
      // descendant that left the group (setsid) could still hold them: do not wait for it.
      const fallback = setTimeout(() => {
        child.stdout!.destroy();
        child.stderr!.destroy();
        finish(code, signal);
      }, options.killGraceMs ?? 1_000);
      fallback.unref();
      child.once("close", () => clearTimeout(fallback));
    });
    child.on("close", (code, signal) => finish(code, signal));

    let stderrTail = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrTail += chunk.toString("utf8");
      let i = stderrTail.indexOf("\n");
      while (i >= 0) {
        options.onStderr?.(stderrTail.slice(0, i));
        stderrTail = stderrTail.slice(i + 1);
        i = stderrTail.indexOf("\n");
      }
      if (stderrTail.length > 8192) stderrTail = stderrTail.slice(-4096);
    });
    child.stdin!.on("error", () => undefined);

    const signalGroup = (signal: NodeJS.Signals) => {
      if (exitInfo || groupGone) return;
      try {
        if (child.pid !== undefined) sendSignal(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };

    let killing: Promise<void> | undefined;
    const kill = (): Promise<void> => {
      killing ??= (async () => {
        stream.close("killed");
        if (!exitInfo && !groupGone) {
          if (namespaced) controlPipe.end("STOP\n");
          else signalGroup("SIGTERM");
          escalation = setTimeout(() => {
            if (namespaced) {
              // The pipe path normally kills PID1 and lets unshare reap it. If it fails,
              // terminate only our live child handle and report incomplete evidence.
              forcedNamespaceExit = true;
              child.kill("SIGKILL");
            } else signalGroup("SIGKILL");
          }, namespaced ? graceMs + 1_000 : graceMs);
          escalation.unref();
          await exited;
          clearTimeout(escalation);
        }
        // The leader is gone; make sure nothing it started in the group is left behind
        // (a no-op when the exit handler already swept it).
        sweepGroup();
      })();
      return killing;
    };

    // macOS has no PID namespace. After the leader is reaped and the group SIGKILL sweep has run,
    // ESRCH for signal 0 to the group means no process (live or unreaped) still carries its id.
    // Signal 0 cannot affect a reused group, so it is exempt from the no-signal-after-groupGone rule;
    // a reused or surviving group answers 0 and the result stays incomplete. A descendant that left
    // the group (setsid) is not seen: the accepted macOS gap.
    const probe = options.probeFn ?? ((pid: number) => process.kill(-pid, 0));
    const probeGroupEmpty = async (deadline: number): Promise<RawProcessCleanupResult> => {
      if (child.pid === undefined || !groupGone) return { status: "incomplete", mechanism: "process-group", reason: "descendants-unverified" };
      for (;;) {
        try {
          probe(child.pid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return { status: "group-empty", mechanism: "process-group" };
        }
        if (Date.now() + 25 > deadline) return { status: "incomplete", mechanism: "process-group", reason: "timeout" };
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    let cleanupResult: Promise<RawProcessCleanupResult> | undefined;
    const cleanupTimeoutMs = options.cleanupTimeoutMs ?? graceMs + 2_000;
    const cleanup = (): Promise<RawProcessCleanupResult> => cleanupResult ??= boundedCleanup(async (): Promise<RawProcessCleanupResult> => {
      const deadline = Date.now() + cleanupDeadlineMs(cleanupTimeoutMs);
      await kill();
      await exited;
      if (namespaced && namespaceReady && !forcedNamespaceExit && exitInfo?.signal === null) {
        return { status: "quiescent", mechanism: "linux-pid-namespace" };
      }
      if (!namespaced && (options.platform ?? process.platform) === "darwin") return probeGroupEmpty(deadline);
      return { status: "incomplete", mechanism: namespaced ? "linux-pid-namespace" : "process-group", reason: namespaced ? "termination-failed" : "descendants-unverified" };
    }, cleanupTimeoutMs, namespaced ? "linux-pid-namespace" : "process-group");

    child.once("error", (error) => {
      secret?.fill(0);
      if (child.pid === undefined) reject(error);
    });
    const result = { stream, pid: child.pid, exited, kill, cleanup };
    if (namespaced) {
      // Expose no confined process unless the actual PID1 workload has started.
      const startupDeadline = setTimeout(() => {
        void kill();
        reject(new Error("Linux PID namespace startup timed out"));
      }, 3_000);
      let ready = "";
      controlPipe.on("data", (chunk: Buffer) => {
        ready += chunk.toString("utf8");
        if (ready === "READY\n") {
          namespaceReady = true;
          clearTimeout(startupDeadline);
          resolve(result);
        } else if (ready.length > 64) {
          clearTimeout(startupDeadline);
          void kill();
          reject(new Error("Invalid PID namespace startup receipt"));
        }
      });
      void exited.then(() => {
        clearTimeout(startupDeadline);
        if (!namespaceReady) reject(new Error("Linux PID namespace containment is unavailable"));
      });
      child.once("error", () => clearTimeout(startupDeadline));
    } else child.once("spawn", () => resolve(result));
  });
}
