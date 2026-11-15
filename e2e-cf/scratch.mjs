import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Whether `p` is in RAM-backed temp space (`/tmp`, `/var/tmp`), where scratch files are not allowed. */
export function underSystemTmp(p) {
  const resolved = path.resolve(p);
  return ["/tmp", "/var/tmp"].some((t) => resolved === t || resolved.startsWith(`${t}/`));
}

/**
 * Where the wrangler harness keeps its run dirs, the typecheck scratch and the vite cache: the run's own `TMPDIR` when
 * it points at disk (local CI sets it to `.ci-local/tmp`), else `~/.cache/bridge-e2e/e2e-cf`.
 * Never `/tmp`, and never a directory inside the package.
 */
export function scratchRoot(env = process.env) {
  const fromEnv = env.TMPDIR;
  const dir = fromEnv && !underSystemTmp(fromEnv)
    ? path.join(path.resolve(fromEnv), "e2e-cf")
    : path.join(os.homedir(), ".cache", "bridge-e2e", "e2e-cf");
  mkdirSync(dir, { recursive: true });
  return dir;
}
