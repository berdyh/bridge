import { spawn } from "node:child_process";
import type { Duplex } from "node:stream";

import { boundedCleanup, cleanupDeadlineMs, PID_NAMESPACE_SUPERVISOR, type ProcessCleanupResult } from "../acp/cleanup.js";
import type { SpawnFn } from "./types.js";

/**
 * Ordinary CLI tools, cwd, filesystem and network policy stay ordinary. Only staged OAuth
 * runs require a lifecycle namespace so detached children cannot outlive the login lease.
 * This uses the trusted PID1/control-pipe supervisor; it is not the SRT execution profile.
 * Unsupported platforms or disabled Linux user/PID namespaces cannot safely stage OAuth.
 */
export const nodeSpawn: SpawnFn = (command, args, options) => {
  if (!options.requireCleanup) {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    return child;
  }
  if (process.platform !== "linux") {
    throw new Error("Staged agent logins require Linux user/PID lifecycle namespaces; this platform cannot verify descendant cleanup");
  }
  if (options.env.NODE_OPTIONS || options.env.NODE_PATH || Object.keys(options.env).some((key) => key.startsWith("LD_") && options.env[key])) {
    throw new Error("Staged agent login lifecycle supervisor refuses Node startup or loader environment overrides");
  }
  const graceMs = 1_000;
  const child = spawn("/usr/bin/unshare", [
    "--user", "--map-root-user", "--pid", "--fork", "--kill-child=KILL", "--mount-proc", "--",
    process.execPath, "-e", PID_NAMESPACE_SUPERVISOR, "--", String(graceMs), command, ...args,
  ], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"], detached: true });
  const secret = child.stdio[3] as Duplex;
  const control = child.stdio[4] as Duplex;
  secret.on("error", () => undefined);
  control.on("error", () => undefined);
  secret.end(() => secret.destroy());
  let ready = false;
  let invalid = false;
  let forced = false;
  let exited = false;
  let exitSignal: NodeJS.Signals | null = null;
  const nativeKill = child.kill.bind(child);
  let escalation: NodeJS.Timeout | undefined;
  let stopping = false;
  const stop = () => {
    if (exited || stopping) return true;
    stopping = true;
    control.end("STOP\n");
    escalation = setTimeout(() => {
      if (exited) return;
      forced = true;
      nativeKill("SIGKILL");
    }, graceMs + 1_000);
    escalation.unref();
    return true;
  };
  const startup = setTimeout(() => { invalid = true; stop(); }, 3_000);
  startup.unref();
  let receipt = "";
  control.on("data", (chunk: Buffer) => {
    receipt += chunk.toString("utf8");
    if (receipt === "READY\n") { ready = true; clearTimeout(startup); }
    else if (receipt.length > 64 || receipt.includes("\n")) { invalid = true; stop(); }
  });
  child.once("error", () => { invalid = true; clearTimeout(startup); });
  const closed = new Promise<void>((resolve) => {
    child.once("close", (_code, signal) => {
      exited = true;
      exitSignal = signal;
      clearTimeout(startup);
      clearTimeout(escalation);
      control.destroy();
      resolve();
    });
  });
  let cleaning: Promise<ProcessCleanupResult> | undefined;
  const cleanup = (): Promise<ProcessCleanupResult> => cleaning ??= boundedCleanup(async () => {
    stop();
    await closed;
    return ready && !invalid && !forced && exitSignal === null
      ? { status: "quiescent", mechanism: "linux-pid-namespace" }
      : { status: "incomplete", mechanism: "linux-pid-namespace", reason: "termination-failed" };
  }, cleanupDeadlineMs(graceMs + 2_000), "linux-pid-namespace");
  // SIGTERM/SIGKILL requests both travel over the private pipe. Killing only the outer
  // unshare process is reserved for escalation and cannot produce a quiescence receipt.
  child.kill = () => stop();
  return Object.assign(child, { cleanup });
};
