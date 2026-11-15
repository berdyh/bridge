import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

/** A refusal is immediate: callers must retry after the owning session completes. */
export class LoginLeaseError extends Error {
  readonly code = "AGENT_LOGIN_BUSY";
  readonly leasePath: string;
  constructor(leasePath: string, reason: string) {
    super(`Agent login unavailable: ${reason}. Retry after the owning session finishes. ` +
      `If its runner crashed, stop and verify all of that session's agent descendants are gone, ` +
      `then remove only the lease directory ${JSON.stringify(leasePath)} and re-export the login if a refresh was lost. ` +
      `A missing owner PID alone is not safe recovery.`);
    this.name = "LoginLeaseError";
    this.leasePath = leasePath;
  }
}

interface Owner {
  version: 1;
  id: string;
  pid: number;
  uid: number;
  started: string;
  acquiredAt: string;
}

/** Linux boot + process start ticks distinguish PID reuse and reboot; never contains credentials. */
async function processIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const [stat, boot] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return started ? `${boot.trim()}:${started}` : undefined;
  } catch {
    return undefined;
  }
}

async function ownerStatus(ownerFile: string): Promise<string> {
  try {
    const info = await lstat(ownerFile);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return "unsafe lease owner record";
    const owner = JSON.parse(await readFile(ownerFile, "utf8")) as Partial<Owner>;
    if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || owner.uid !== process.getuid?.() || typeof owner.started !== "string") return "unverifiable lease owner";
    const current = await processIdentity(owner.pid!);
    if (current !== undefined) return current === owner.started ? "another session owns this login" : "stale lease (owner PID was reused)";
    try {
      process.kill(owner.pid!, 0);
      return "another session owns this login (start identity unavailable)";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "stale lease (runner exited; descendants may remain)" : "unverifiable lease owner";
    }
  } catch {
    return "incomplete or unreadable lease owner record";
  }
}

export interface LoginLease {
  /** Verify ownership before persisting a refresh. Throws after release or replacement. */
  assertOwned(): Promise<void>;
  /** Only after refresh persistence AND verified agent descendant cleanup. Idempotent. */
  release(): Promise<void>;
}

/**
 * Exclusive, cross-process lease for one canonical login path, across all apps. No timeout or
 * PID-only stale stealing: an agent may survive its runner and still rotate the grant. Different
 * login paths remain independent. The credential directory must belong to this uid and must
 * not be writable by other users. Existing symlink/unsafe/incomplete leases fail closed.
 */
export async function acquireLoginLease(canonical: string): Promise<LoginLease> {
  const leasePath = `${canonical}.bridge-login-lease`;
  const ownerFile = path.join(leasePath, "owner.json");
  const uid = process.getuid?.();
  const parent = path.dirname(canonical);
  const info = await lstat(parent);
  if (uid === undefined || !info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022) !== 0 || await realpath(parent) !== parent) {
    throw new LoginLeaseError(leasePath, "login directory must be canonical, owned by this user and not writable by other users");
  }
  const sourceInfo = await lstat(canonical);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.uid !== uid || sourceInfo.nlink !== 1 || (sourceInfo.mode & 0o022) !== 0) {
    throw new LoginLeaseError(leasePath, "login must be an owned regular file, without hard links or write access for other users");
  }
  try {
    await mkdir(leasePath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await lstat(leasePath);
    const safe = existing.isDirectory() && !existing.isSymbolicLink() && existing.uid === uid && (existing.mode & 0o077) === 0;
    throw new LoginLeaseError(leasePath, safe ? await ownerStatus(ownerFile) : "unsafe lease directory (symlink, ownership or permissions)");
  }
  // Once mkdir succeeds nobody may reclaim this path, even if owner.json is not yet published.
  const directory = await lstat(leasePath);
  const owner: Owner = {
    version: 1, id: randomUUID(), pid: process.pid, uid,
    started: await processIdentity(process.pid) ?? `unavailable:${Date.now() - Math.floor(process.uptime() * 1000)}`,
    acquiredAt: new Date().toISOString(),
  };
  const record = JSON.stringify(owner);
  try {
    const handle = await open(ownerFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(record, "utf8"); } finally { await handle.close(); }
  } catch (error) {
    // No agent has been launched. Only remove the newly created empty directory; unexpected
    // contents or a partially published record are retained conservatively for manual recovery.
    await rmdir(leasePath).catch(() => undefined);
    throw error;
  }
  let released = false;
  const assertOwned = async (): Promise<void> => {
    if (released) throw new LoginLeaseError(leasePath, "session already released this login");
    const current = await lstat(leasePath).catch(() => undefined);
    const file = await lstat(ownerFile).catch(() => undefined);
    if (!current?.isDirectory() || current.isSymbolicLink() || current.dev !== directory.dev || current.ino !== directory.ino || current.uid !== uid || (current.mode & 0o077) !== 0 ||
      !file?.isFile() || file.isSymbolicLink() || file.uid !== uid || (file.mode & 0o077) !== 0 || await readFile(ownerFile, "utf8").catch(() => undefined) !== record) {
      throw new LoginLeaseError(leasePath, "session lease was removed or replaced");
    }
  };
  return {
    assertOwned,
    release: async () => {
      if (released) return;
      await assertOwned();
      await unlink(ownerFile);
      await rmdir(leasePath);
      released = true;
    },
  };
}
