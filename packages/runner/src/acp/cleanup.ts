/** Process teardown evidence only. Broker capabilities and server resources are separate gates. */
export type ProcessCleanupResult =
  | { status: "quiescent"; mechanism: "linux-pid-namespace" }
  | {
      status: "incomplete";
      mechanism: "process-group" | "linux-pid-namespace";
      reason: "descendants-unverified" | "timeout" | "termination-failed";
    };

/**
 * What `spawnAcpProcess` reports, runner-internal and not in the package barrel. `group-empty` is
 * macOS evidence: after the group SIGKILL sweep, no process carries the agent's process group
 * id. A descendant that left the group (setsid) is not seen, so it is never quiescence: the adapter
 * maps it to incomplete/descendants-unverified before anything outside the runner sees it, and the
 * wire guard (`isSessionQuiescence`) rejects it. The public `ProcessCleanupResult` never carries it.
 */
export type RawProcessCleanupResult = ProcessCleanupResult | { status: "group-empty"; mechanism: "process-group" };

/** Invalid or excessive caller deadlines cannot turn cleanup into an unbounded wait. */
export function cleanupDeadlineMs(requested: number | undefined): number {
  return requested !== undefined && Number.isFinite(requested) ? Math.max(1, Math.min(30_000, requested)) : 3_000;
}

/** A timeout is evidence of incomplete cleanup, never permission to reuse a workspace. */
export async function boundedCleanup<T extends RawProcessCleanupResult = ProcessCleanupResult>(
  work: () => Promise<T>,
  timeoutMs: number,
  mechanism: ProcessCleanupResult["mechanism"],
): Promise<T | ProcessCleanupResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work).catch((): ProcessCleanupResult => ({ status: "incomplete", mechanism, reason: "termination-failed" })),
      new Promise<ProcessCleanupResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: "incomplete", mechanism, reason: "timeout" }), cleanupDeadlineMs(timeoutMs));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs as PID 1 in a fresh user/PID namespace. The workload never receives the control
 * descriptor (4). A private proc mount hides ancestor supervisors. Losing the runner's
 * control pipe kills PID 1, which makes the kernel tear down ALL namespace descendants,
 * including double-forked/setsid children.
 * The outer unshare process waits for PID 1; its normal exit is the teardown witness.
 * No process inventory, host PID enumeration or sampled absence is used as proof.
 */
export const PID_NAMESPACE_SUPERVISOR = String.raw`
const net = require("node:net");
const { spawn } = require("node:child_process");
if (process.pid !== 1) process.exit(125);
const [graceText, command, ...args] = process.argv.slice(1);
const control = new net.Socket({ fd: 4, readable: true, writable: true });
let target;
let stopping = false;
function terminate() {
  if (stopping) return;
  stopping = true;
  try { target?.kill("SIGTERM"); } catch {}
  // Exiting PID1 makes the kernel kill/reap the whole namespace. A self-sent
  // SIGKILL is not a reliable init-exit path, and a signalled unshare parent is
  // deliberately NOT a teardown witness. Exit normally with a fixed stop code.
  setTimeout(() => process.exit(137), Number(graceText));
}
control.on("data", terminate);
control.on("end", terminate);
control.on("error", terminate);
process.on("SIGTERM", terminate);
process.on("SIGINT", terminate);
target = spawn(command, args, { stdio: [0, 1, 2, 3], env: process.env });
target.once("error", () => process.exit(127));
target.once("exit", (code) => process.exit(code ?? 128));
target.once("spawn", () => control.write("READY\n"));
`;
