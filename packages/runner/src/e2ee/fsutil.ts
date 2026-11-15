import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

/**
 * Small private-file helpers for the runner's E2EE state (trust list, identity key,
 * enrollment window). Every file is mode 0600 inside a 0700 directory, every write
 * is atomic (temp file + rename), and read-modify-write sequences are serialized
 * across processes with a lock file, because `bridge enroll`, `bridge browsers` and
 * the daemon are separate processes that share these files.
 */

export async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

/** Writes `data` to `file` atomically with mode 0600. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  await ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await fs.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Publishes `data` at `file` only if nothing is there yet (hard-link publication is
 * atomic and exclusive). Returns false when the file already existed.
 */
export async function writeFileExclusive(file: string, data: string): Promise<boolean> {
  await ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await fs.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(tmp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/**
 * Reads a file; `undefined` when it does not exist. With `noFollow` a symlink at `file` is an
 * error (`O_NOFOLLOW`), not something to read through.
 */
export async function readTextFile(file: string, options: { noFollow?: boolean } = {}): Promise<string | undefined> {
  try {
    if (!options.noFollow) return await fs.readFile(file, "utf8");
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") throw new Error(`Refusing symlink in state path: ${file}`);
    throw error;
  }
}

/** Throws when a secret file is readable by group or others. */
export async function assertPrivateFile(file: string): Promise<void> {
  const stat = await fs.stat(file);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${file} must not be accessible by other users (mode 0600)`);
}

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const chains = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` while holding `<file>.lock`. Serialized in-process by a promise chain
 * (no polling between callers of one process) and across processes by an exclusive
 * lock file. A lock older than `LOCK_STALE_MS` belongs to a crashed holder and is
 * broken.
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const previous = chains.get(lock) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    await ensurePrivateDir(path.dirname(file));
    const started = Date.now();
    for (;;) {
      try {
        const handle = await fs.open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          // lstat: a lock path that is a (dangling) symlink ages out like any stale lock.
          const stat = await fs.lstat(lock);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            await fs.rm(lock, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error("timed out waiting for a state file lock");
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(lock, { force: true });
    }
  });
  chains.set(lock, run);
  try {
    return await run;
  } finally {
    if (chains.get(lock) === run) chains.delete(lock);
  }
}
