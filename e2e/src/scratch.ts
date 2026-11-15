import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Whether `p` is in RAM-backed temp space (`/tmp`, `/var/tmp`), where scratch files do not belong. */
export function underSystemTmp(p: string): boolean {
  const resolved = path.resolve(p);
  return ["/tmp", "/var/tmp"].some((t) => resolved === t || resolved.startsWith(`${t}/`));
}

/**
 * Where e2e scratch (machine roots, child TMPDIRs) goes: the run's own `TMPDIR` when it points at disk
 * (local CI sets it to `.ci-local/tmp`), else `~/.cache/bridge-e2e/e2e`. Never `/tmp`,
 * whatever `os.tmpdir()` says.
 */
export function scratchRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.TMPDIR;
  const dir = fromEnv && !underSystemTmp(fromEnv) ? path.resolve(fromEnv) : path.join(os.homedir(), ".cache", "bridge-e2e", "e2e");
  mkdirSync(dir, { recursive: true });
  return dir;
}
