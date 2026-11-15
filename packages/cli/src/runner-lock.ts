/**
 * The lock file of `bridge run`: one algorithm over a path, used twice.
 *
 *  - `runner.lock` (`runnerLockPath`): one `bridge run` per machine, so two runners never both write
 *    `runner.json` or answer the service.
 *  - `worker.lock` (`workerLockPath`): one worker per app, so the start-up sweep of that app's session folders and
 *    secret folders (`sweepApp`) never deletes a live worker's files. In this release the one `bridge run` process
 *    takes the app locks itself; a supervisor/worker split would run the same code per worker.
 *
 * The record is one line of JSON, read with a 4 KiB cap. A lock is made visible only complete: the record is written
 * to a private temp file created exclusively, then hard-linked to the lock path (the link fails if the lock exists).
 * A stale lock (a dead holder, or bytes that are not a record) is replaced under a `.replace` claim, so two starters
 * that saw the same stale lock cannot both win. The claim is published the same way as the lock (a complete record in
 * a private temp, hard-linked into place), so it is never visible empty or partial; a claim that is not a readable
 * record anyway (an older bridge, a hand edit) is left alone while it is younger than `CLAIM_GRACE_MS`, because its
 * writer may be alive. Pid reuse is accepted: a dead holder's pid taken by an unrelated
 * live process makes the lock look held, and the message says how to remove it (a heartbeat or a process-start-time
 * check would be wrong across a laptop suspend, or platform-specific).
 *
 * Residual, accepted: the one unguarded removal is a stale `.replace` claim whose holder is dead. Two starters that
 * both find it dead at the same instant can both unlink it; one then wins the exclusive publish of a new claim and the
 * other re-enters the loop. For both to proceed one would have to unlink the other's fresh claim between its publish
 * and its release, which needs a crashed replacer and two starts within milliseconds. No filesystem primitive that
 * Node offers without native code (`flock`, `RENAME_NOREPLACE`) closes it. The failure mode is two sweeps of one app,
 * never a secret exposure and never another app's folder.
 */
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { isPidAlive } from "./status.js";

/** Why a lock was not taken. `bridge run` prints `message` as one line and exits 1. */
export type LockRefusedKind = "live" | "replacing" | "notRegular" | "newer" | "dirIsLink" | "transition";

export class LockRefused extends Error {
  readonly kind: LockRefusedKind;
  constructor(kind: LockRefusedKind, message: string) {
    super(message);
    this.name = "LockRefused";
    this.kind = kind;
  }
}

/** The record in a lock file. */
export interface LockFile {
  version: 1;
  pid: number;
  /** ISO 8601. */
  startedAt: string;
}

export interface Lock {
  readonly path: string;
  /** Removes the lock if it is still ours (same file); idempotent; never throws. */
  release(): Promise<void>;
}

export interface AcquireOptions {
  /** Whether a process is alive. Default: `kill(pid, 0)` succeeds or fails with `EPERM`. */
  isPidAlive?: (pid: number) => boolean;
  /** Clock for `startedAt`. Default `Date.now`. */
  now?: () => number;
  log?: (level: "warn" | "info", message: string) => void;
  /** Wait between replacement rounds. Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** What the lock guards, for the refusal text: `runner` (default) or `worker for app X`. */
  label?: string;
  /** The pid to record. Default `process.pid`. */
  pid?: number;
  /**
   * Machine-wide lock only, this release only: the pid of a live `bridge run` that is not ours and holds no lock
   * (the `runner.json` of an older bridge, started before the lock existed). A pid refuses with kind `transition`.
   */
  transition?: () => Promise<{ pid: number; startedAt?: string } | undefined> | { pid: number; startedAt?: string } | undefined;
}

const MAX_RECORD_BYTES = 4096;
const REPLACE_ROUNDS = 3;
const REPLACE_WAIT_MS = 100;
/** A claim that is not a readable record is not stale until it is this old (its writer may be paused, not dead). */
const CLAIM_GRACE_MS = 5000;
/** A hard stop on the retry loop, whatever the filesystem does. */
const MAX_ITERATIONS = 16;
const ISO_LIKE = /^[0-9T:.+\-Z]{10,40}$/;

let tempCounter = 0;

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

type Existing =
  | { kind: "gone" }
  | { kind: "notRegular" }
  | { kind: "newer" }
  | { kind: "held"; record: LockFile }
  | { kind: "unreadable"; dev: number; ino: number };

/** What is at `file` now, read without following a link. A valid record also carries the identity read. */
async function classify(file: string): Promise<Existing & { dev?: number; ino?: number }> {
  let st;
  try {
    st = await lstat(file);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return { kind: "gone" };
    throw error;
  }
  if (!st.isFile()) return { kind: "notRegular" };
  let text: string;
  let dev: number;
  let ino: number;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return { kind: "notRegular" };
      dev = opened.dev;
      ino = opened.ino;
      const buffer = Buffer.alloc(MAX_RECORD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MAX_RECORD_BYTES, 0);
      text = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT") return { kind: "gone" };
    if (code === "ELOOP") return { kind: "notRegular" };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable", dev, ino };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "unreadable", dev, ino };
  const record = parsed as Record<string, unknown>;
  if ("version" in record && record.version !== 1) return { kind: "newer" };
  if (record.version === 1 && Number.isInteger(record.pid) && (record.pid as number) > 0 && typeof record.startedAt === "string") {
    return { kind: "held", record: { version: 1, pid: record.pid as number, startedAt: record.startedAt }, dev, ino };
  }
  return { kind: "unreadable", dev, ino };
}

const since = (startedAt: string | undefined): string => (startedAt !== undefined && ISO_LIKE.test(startedAt) ? `, since ${startedAt}` : "");

/**
 * Takes the lock at `lockPath` or throws `LockRefused`. The folder of the lock is created 0700 and must be a real
 * folder, not a link (the folders above it may be links, as `~/.local` often is, as for every bridge folder).
 */
export async function acquireLock(lockPath: string, options: AcquireOptions = {}): Promise<Lock> {
  const alive = options.isPidAlive ?? isPidAlive;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const label = options.label ?? "runner";
  const ourPid = options.pid ?? process.pid;
  const dir = path.dirname(lockPath);
  const claimPath = `${lockPath}.replace`;
  const refuse = (kind: LockRefusedKind, message: string): never => {
    throw new LockRefused(kind, message);
  };

  // 1. The folder: made 0700 if missing, never a link.
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    // A dangling link in the way makes `mkdir -p` fail with EEXIST: that is a link, not a folder.
    if (!(await lstat(dir).then((s) => !s.isDirectory(), () => false))) throw error;
  }
  const folder = await lstat(dir);
  if (!folder.isDirectory()) return refuse("dirIsLink", `the lock's folder ${dir} is a link; refusing to use it`);

  // The transition rule (machine-wide lock only): an older bridge without the lock may be running.
  if (options.transition !== undefined) {
    const other = await options.transition();
    if (other !== undefined && other.pid !== ourPid) {
      return refuse("transition", `another ${label} is running (pid ${other.pid}${since(other.startedAt)}); stop it first. It was started before ${path.basename(lockPath)} existed`);
    }
  }

  // Temps of an acquirer that crashed between its link and its unlink.
  const base = path.basename(lockPath);
  const leftover = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)(?:-\\d+)?\\.tmp$`);
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const match = leftover.exec(name);
    if (match && !alive(Number(match[1]))) await unlink(path.join(dir, name)).catch(() => undefined);
  }

  // 2. The record, in a private temp created exclusively. The pid is in the name, a counter keeps two calls of one process apart.
  const record: LockFile = { version: 1, pid: ourPid, startedAt: new Date(now()).toISOString() };
  const text = `${JSON.stringify(record)}\n`;
  const tmp = `${lockPath}.${ourPid}-${tempCounter++}.tmp`;
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let identity: { dev: number; ino: number };
  try {
    await handle.writeFile(text);
    const st = await handle.stat();
    identity = { dev: st.dev, ino: st.ino };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await handle.close();


  const replaceStale = async (stale: { dev: number; ino: number }): Promise<"done" | "retry" | "busy"> => {
    // The claim is published like the lock: a complete record in a private temp, hard-linked to the claim path.
    const claimTmp = `${lockPath}.${ourPid}-${tempCounter++}.tmp`;
    const claimHandle = await open(claimTmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let claimIdentity: { dev: number; ino: number };
    try {
      await claimHandle.writeFile(text);
      const st = await claimHandle.stat();
      claimIdentity = { dev: st.dev, ino: st.ino };
    } catch (error) {
      await claimHandle.close().catch(() => undefined);
      await unlink(claimTmp).catch(() => undefined);
      throw error;
    }
    await claimHandle.close();
    try {
      await link(claimTmp, claimPath);
    } catch (error) {
      await unlink(claimTmp).catch(() => undefined);
      if (codeOf(error) !== "EEXIST") throw error;
      // Someone is replacing, or a replacer crashed.
      const other = await classify(claimPath);
      if (other.kind === "gone") return "retry";
      if (other.kind === "held" && alive(other.record.pid)) return "busy";
      if (other.kind === "unreadable" || other.kind === "newer") {
        // Not a record we can attribute to a dead process: its writer may be alive until the claim is old.
        const info = await lstat(claimPath).catch(() => undefined);
        if (info === undefined) return "retry";
        if (now() - info.mtimeMs < CLAIM_GRACE_MS) return "busy";
      }
      await unlink(claimPath).catch(() => undefined);
      return "retry";
    }
    await unlink(claimTmp).catch(() => undefined);
    try {
      // Holding the claim: is it still the stale lock we saw?
      const current = await lstat(lockPath).catch((error: unknown) => {
        if (codeOf(error) === "ENOENT") return undefined;
        throw error;
      });
      if (current === undefined || current.dev !== stale.dev || current.ino !== stale.ino) return "retry";
      await unlink(lockPath);
      try {
        await link(tmp, lockPath);
        return "done";
      } catch (error) {
        if (codeOf(error) === "EEXIST") return "retry";
        throw error;
      }
    } finally {
      // Only our own claim: a recovery by another acquirer may have replaced it.
      if (await stillOurs(claimPath, claimIdentity, text).catch(() => false)) await unlink(claimPath).catch(() => undefined);
    }
  };

  try {
    let rounds = 0;
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      // 3. The exclusive link: the lock is never visible without its content.
      try {
        await link(tmp, lockPath);
        return makeLock(lockPath, identity, text, log);
      } catch (error) {
        if (codeOf(error) !== "EEXIST") throw error;
      }
      // 4. What is there.
      const existing = await classify(lockPath);
      if (existing.kind === "gone") continue;
      if (existing.kind === "notRegular") return refuse("notRegular", `${lockPath} is not a regular file; remove it by hand`);
      if (existing.kind === "newer") return refuse("newer", `${lockPath} was written by a newer bridge; use that version, or remove the file if no runner is running`);
      if (existing.kind === "held" && alive(existing.record.pid)) {
        return refuse("live", `another ${label} is running (pid ${existing.record.pid}${since(existing.record.startedAt)}); stop it first. If none is running, remove ${lockPath}`);
      }
      // A dead holder, or bytes that are not a record: stale. 5. Replace it under a claim.
      const stale = { dev: existing.dev!, ino: existing.ino! };
      const outcome = await replaceStale(stale);
      if (outcome === "done") return makeLock(lockPath, identity, text, log);
      if (outcome === "busy") {
        if (rounds >= REPLACE_ROUNDS) return refuse("replacing", `another ${label} is replacing the lock ${lockPath}; try again`);
        rounds += 1;
        await sleep(REPLACE_WAIT_MS);
      }
    }
    return refuse("replacing", `another ${label} keeps changing the lock ${lockPath}; try again`);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/**
 * Whether `file` is still the file this process wrote: the same dev/inode AND the same bytes. The inode alone is not
 * enough: a filesystem may give a just-freed inode number to the next file created (ext4 does), so a replacement
 * written by another process can carry our old identity. Its record names another pid, so the bytes differ.
 */
async function stillOurs(file: string, identity: { dev: number; ino: number }, text: string): Promise<boolean | undefined> {
  const now = await lstat(file).catch((error: unknown) => {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  });
  if (now === undefined) return undefined;
  if (now.dev !== identity.dev || now.ino !== identity.ino || !now.isFile()) return false;
  const bytes = await readFile(file, "utf8").catch((error: unknown) => {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  });
  if (bytes === undefined) return undefined;
  return bytes === text;
}

function makeLock(lockPath: string, identity: { dev: number; ino: number }, text: string, log: NonNullable<AcquireOptions["log"]>): Lock {
  let released = false;
  return {
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      try {
        const ours = await stillOurs(lockPath, identity, text);
        if (ours === undefined) return;
        if (!ours) {
          // A newer acquirer replaced a lock it judged stale: it is theirs now.
          log("warn", `not removing ${lockPath}: it is no longer the lock this process took`);
          return;
        }
        await unlink(lockPath);
      } catch (error) {
        log("warn", `cannot remove ${lockPath} (${codeOf(error) ?? "error"})`);
      }
    },
  };
}

/** Read for `bridge doctor`: who holds a lock file, without taking it. Never throws. */
export async function readLock(lockPath: string, alive: (pid: number) => boolean = isPidAlive): Promise<
  { state: "absent" } | { state: "held"; pid: number; startedAt: string; alive: boolean } | { state: "unreadable"; detail: string }
> {
  try {
    const st = await lstat(lockPath).catch((error: unknown) => {
      if (codeOf(error) === "ENOENT") return undefined;
      throw error;
    });
    if (st === undefined) return { state: "absent" };
    if (st.isSymbolicLink()) return { state: "unreadable", detail: "a link; not read" };
    const found = await classify(lockPath);
    if (found.kind === "gone") return { state: "absent" };
    if (found.kind === "held") return { state: "held", pid: found.record.pid, startedAt: found.record.startedAt, alive: alive(found.record.pid) };
    if (found.kind === "newer") return { state: "unreadable", detail: "written by a newer bridge" };
    if (found.kind === "notRegular") return { state: "unreadable", detail: "not a regular file" };
    return { state: "unreadable", detail: "not a lock record (a runner start replaces it)" };
  } catch (error) {
    return { state: "unreadable", detail: `cannot be read (${codeOf(error) ?? "error"})` };
  }
}
