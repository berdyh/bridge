import { link, lstat, mkdir, readFile, readdir, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LockRefused, acquireLock, readLock, type AcquireOptions } from "./runner-lock.js";
import { appPathsOf, runnerLockPath, workerLockPath } from "./paths.js";
import { type Harness, exists, harness } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

/** A pid nobody has and a pid the tests call alive. */
const DEAD = 2_000_000_001;
const LIVE = 2_000_000_002;
const aliveSet = (...pids: number[]) => (pid: number) => pid === process.pid || pids.includes(pid);

const record = (pid: number, extra: object = {}) => `${JSON.stringify({ version: 1, pid, startedAt: "2026-11-03T10:00:00.000Z", ...extra })}\n`;

type Kind = { name: string; pathOf: (h: Harness) => string; transition: boolean };
const KINDS: Kind[] = [
  { name: "runner.lock (machine-wide)", pathOf: (x) => runnerLockPath(x.deps), transition: true },
  { name: "worker.lock (app app-a)", pathOf: (x) => workerLockPath(appPathsOf(x.deps, "app-a")), transition: false },
];

async function refusal(promise: Promise<unknown>): Promise<LockRefused> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LockRefused);
    return error as LockRefused;
  }
  throw new Error("expected the lock to be refused");
}

/** Temps, claims and the like next to the lock (not the lock itself). */
const leftovers = async (file: string): Promise<string[]> =>
  (await readdir(path.dirname(file))).filter((n) => n.startsWith(`${path.basename(file)}.`));

describe.each(KINDS)("acquireLock: $name", (kind) => {
  it("takes the lock on an empty state dir: 0600, {version, pid, startedAt}, folder 0700, no temp or claim left", async () => {
    h = await harness();
    const file = kind.pathOf(h);
    const lock = await acquireLock(file, { now: () => Date.parse("2026-11-03T12:00:00Z") });
    expect(lock.path).toBe(file);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, pid: process.pid, startedAt: "2026-11-03T12:00:00.000Z" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await leftovers(file)).toEqual([]);
    await lock.release();
  });

  it("refuses a lock whose holder is alive, naming the pid and the path, and writes nothing", async () => {
    h = await harness();
    const file = kind.pathOf(h);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, record(LIVE));
    const refused = await refusal(acquireLock(file, { isPidAlive: aliveSet(LIVE), label: "runner" }));
    expect(refused.kind).toBe("live");
    expect(refused.message).toContain(`pid ${LIVE}`);
    expect(refused.message).toContain(file);
    expect(refused.message).toContain("2026-11-03T10:00:00.000Z");
    expect(refused.message).not.toContain("\n");
    expect(await readFile(file, "utf8")).toBe(record(LIVE));
    expect(await leftovers(file)).toEqual([]);
  });

  it("replaces a lock whose holder is dead: our pid, a different file, no claim left", async () => {
    h = await harness();
    const file = kind.pathOf(h);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, record(DEAD));
    const before = (await stat(file)).ino;
    const lock = await acquireLock(file, { isPidAlive: aliveSet() });
    expect(JSON.parse(await readFile(file, "utf8")).pid).toBe(process.pid);
    expect((await stat(file)).ino).not.toBe(before);
    expect(await leftovers(file)).toEqual([]);
    await lock.release();
  });

  it("treats unparsable content as stale and replaces it", async () => {
    h = await harness();
    const file = kind.pathOf(h);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "not json at all");
    const lock = await acquireLock(file, { isPidAlive: aliveSet() });
    expect(JSON.parse(await readFile(file, "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  it("refuses a lock written by a newer bridge (version 2)", async () => {
    h = await harness();
    const file = kind.pathOf(h);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, record(DEAD, { version: 2 }));
    const refused = await refusal(acquireLock(file, { isPidAlive: aliveSet() }));
    expect(refused.kind).toBe("newer");
    expect(refused.message).toContain("newer bridge");
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(2);
  });

  it("refuses a link at the lock path and touches neither the link nor its target", async () => {
    h = await harness();
    const file = kind.pathOf(h);
    await mkdir(path.dirname(file), { recursive: true });
    const target = path.join(h.root, "target-file");
    await writeFile(target, "precious");
    await symlink(target, file);
    const refused = await refusal(acquireLock(file, { isPidAlive: aliveSet() }));
    expect(refused.kind).toBe("notRegular");
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("precious");
    expect(await leftovers(file)).toEqual([]);
  });

  it("refuses a folder that is a link, and creates nothing inside it", async () => {
    h = await harness();
    const file = kind.pathOf(h);
    const real = path.join(h.root, "elsewhere");
    await mkdir(real, { recursive: true });
    await mkdir(path.dirname(path.dirname(file)), { recursive: true });
    await symlink(real, path.dirname(file));
    const refused = await refusal(acquireLock(file, { isPidAlive: aliveSet() }));
    expect(refused.kind).toBe("dirIsLink");
    expect(await readdir(real)).toEqual([]);
  });

  it("lets exactly one of two starters that saw the same stale lock win; the other names the winner", async () => {
    h = await harness();
    const file = kind.pathOf(h);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, record(DEAD));
    const options: AcquireOptions = { isPidAlive: aliveSet(), sleep: async () => undefined };
    const results = await Promise.allSettled([acquireLock(file, options), acquireLock(file, options)]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(LockRefused);
    expect((lost[0]!.reason as LockRefused).message).toContain(`pid ${process.pid}`);
    expect(JSON.parse(await readFile(file, "utf8")).pid).toBe(process.pid);
    expect(await leftovers(file)).toEqual([]);
  });

  it("removes a claim whose replacer is dead and goes on", async () => {
    h = await harness();
    const file = kind.pathOf(h);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, record(DEAD));
    await writeFile(`${file}.replace`, record(DEAD + 1));
    const lock = await acquireLock(file, { isPidAlive: aliveSet() });
    expect(JSON.parse(await readFile(file, "utf8")).pid).toBe(process.pid);
    expect(await leftovers(file)).toEqual([]);
    await lock.release();
  });

  it("never treats an empty or unreadable claim as stale while it is young: its writer may be paused", async () => {
    // Rule: a claim becomes visible complete; one that is not a readable record is not removed before CLAIM_GRACE_MS.
    for (const content of ["", "garbage", "{\"version\":1,"]) {
      h = await harness();
      const file = kind.pathOf(h);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, record(DEAD));
      await writeFile(`${file}.replace`, content);
      const refused = await refusal(acquireLock(file, { isPidAlive: aliveSet(), sleep: async () => undefined }));
      expect(refused.kind).toBe("replacing");
      expect(await readFile(`${file}.replace`, "utf8")).toBe(content);
      expect(await readFile(file, "utf8")).toBe(record(DEAD));
      await h.cleanup();
    }
  });

  it("removes an empty or unreadable claim once it is old, and goes on", async () => {
    for (const content of ["", "garbage"]) {
      h = await harness();
      const file = kind.pathOf(h);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, record(DEAD));
      await writeFile(`${file}.replace`, content);
      const old = new Date(Date.now() - 60_000);
      await utimes(`${file}.replace`, old, old);
      const lock = await acquireLock(file, { isPidAlive: aliveSet() });
      expect(JSON.parse(await readFile(file, "utf8")).pid).toBe(process.pid);
      expect(await leftovers(file)).toEqual([]);
      await lock.release();
      await h.cleanup();
    }
  });

  it("publishes its claim complete: a reader that looks at the claim path never sees an empty or partial record", async () => {
    h = await harness();
    const file = kind.pathOf(h);
    await mkdir(path.dirname(file), { recursive: true });
    const seen: string[] = [];
    for (let round = 0; round < 60; round++) {
      await writeFile(file, record(DEAD));
      let done = false;
      const poll = (async () => {
        while (!done) {
          const text = await readFile(`${file}.replace`, "utf8").catch(() => undefined);
          if (text !== undefined) seen.push(text);
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();
      const lock = await acquireLock(file, { isPidAlive: aliveSet() });
      done = true;
      await poll;
      await lock.release();
    }
    for (const text of seen) expect(() => JSON.parse(text)).not.toThrow();
    for (const text of seen) expect(JSON.parse(text)).toMatchObject({ version: 1, pid: process.pid });
  });

  it("waits three rounds of 100 ms for a live replacer, then refuses 'replacing'", async () => {
    h = await harness();
    const file = kind.pathOf(h);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, record(DEAD));
    await writeFile(`${file}.replace`, record(LIVE));
    const waits: number[] = [];
    const refused = await refusal(acquireLock(file, { isPidAlive: aliveSet(LIVE), sleep: async (ms) => void waits.push(ms) }));
    expect(refused.kind).toBe("replacing");
    expect(waits).toEqual([100, 100, 100]);
    // The live replacer's claim and the stale lock are theirs: untouched.
    expect(await readFile(`${file}.replace`, "utf8")).toBe(record(LIVE));
    expect(await readFile(file, "utf8")).toBe(record(DEAD));
  });

  it("removes a leftover temp of a dead acquirer and leaves one of a live acquirer", async () => {
    h = await harness();
    const file = kind.pathOf(h);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.${DEAD}.tmp`, "x");
    await writeFile(`${file}.${LIVE}.tmp`, "x");
    const lock = await acquireLock(file, { isPidAlive: aliveSet(LIVE) });
    expect(await leftovers(file)).toEqual([`${path.basename(file)}.${LIVE}.tmp`]);
    await lock.release();
  });

  it("release removes the lock; after a replacement by another process it leaves theirs and warns", async () => {
    h = await harness();
    const file = kind.pathOf(h);
    const warnings: string[] = [];
    const log: AcquireOptions["log"] = (level, message) => void (level === "warn" && warnings.push(message));
    const lock = await acquireLock(file, { log });
    await lock.release();
    expect(await exists(file)).toBe(false);
    await lock.release(); // idempotent

    const mine = await acquireLock(file, { log });
    await unlink(file);
    await writeFile(file, record(LIVE));
    await mine.release();
    expect(await readFile(file, "utf8")).toBe(record(LIVE));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(file);
  });

  it("release leaves a lock that has our inode but another process's record (an inode number reused by the filesystem)", async () => {
    h = await harness();
    const file = kind.pathOf(h);
    const warnings: string[] = [];
    const log: AcquireOptions["log"] = (level, message) => void (level === "warn" && warnings.push(message));
    const mine = await acquireLock(file, { log });
    await writeFile(file, record(LIVE)); // rewritten in place: same dev/inode, another holder's bytes
    await mine.release();
    expect(await readFile(file, "utf8")).toBe(record(LIVE));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(file);
  });
});

describe("the transition rule (this release): a runner.json of an older bridge without the lock", () => {
  const other = () => ({ pid: LIVE, startedAt: "2026-11-03T09:00:00.000Z" });

  it("refuses the machine-wide lock when runner.json names a live pid other than ours, even with no lock", async () => {
    h = await harness();
    const file = runnerLockPath(h.deps);
    const refused = await refusal(acquireLock(file, { isPidAlive: aliveSet(LIVE), transition: other }));
    expect(refused.kind).toBe("transition");
    expect(refused.message).toContain(`pid ${LIVE}`);
    expect(await exists(file)).toBe(false);
  });

  it("accepts it when runner.json names our own pid or nobody", async () => {
    h = await harness();
    const file = runnerLockPath(h.deps);
    const own = await acquireLock(file, { transition: () => ({ pid: process.pid }) });
    await own.release();
    const none = await acquireLock(file, { transition: () => undefined });
    await none.release();
  });

  it("a worker lock never checks runner.json (no transition option): it is taken", async () => {
    h = await harness();
    const lock = await acquireLock(workerLockPath(appPathsOf(h.deps, "app-a")), { isPidAlive: aliveSet(LIVE) });
    await lock.release();
  });
});

describe("two locks at two paths", () => {
  it("a live runner.lock does not block a worker lock, and a live worker.lock does not block runner.lock", async () => {
    h = await harness();
    const runner = runnerLockPath(h.deps);
    const worker = workerLockPath(appPathsOf(h.deps, "app-a"));
    await mkdir(path.dirname(runner), { recursive: true });
    await writeFile(runner, record(LIVE));
    const takenWorker = await acquireLock(worker, { isPidAlive: aliveSet(LIVE) });
    await takenWorker.release();

    await unlink(runner);
    await mkdir(path.dirname(worker), { recursive: true });
    await writeFile(worker, record(LIVE));
    const takenRunner = await acquireLock(runner, { isPidAlive: aliveSet(LIVE) });
    await takenRunner.release();
    expect(await readFile(worker, "utf8")).toBe(record(LIVE));
  });

  it("two workers of different apps, and the runner, are held side by side; releasing one leaves the others", async () => {
    h = await harness();
    const paths = ["app-a", "app-b"].map((id) => workerLockPath(appPathsOf(h.deps, id)));
    const runner = runnerLockPath(h.deps);
    expect(new Set([...paths, runner]).size).toBe(3);
    const locks = await Promise.all([...paths, runner].map((p) => acquireLock(p, { isPidAlive: aliveSet() })));
    for (const p of [...paths, runner]) expect(await exists(p)).toBe(true);
    await locks[0]!.release();
    expect(await exists(paths[0]!)).toBe(false);
    expect(await exists(paths[1]!)).toBe(true);
    expect(await exists(runner)).toBe(true);
    for (const lock of locks) await lock.release();
  });

  it("a hard link made by another process to the lock does not fool the identity check on release", async () => {
    h = await harness();
    const file = runnerLockPath(h.deps);
    const lock = await acquireLock(file);
    await link(file, `${file}.keep`);
    await lock.release();
    expect(await exists(file)).toBe(false);
    expect(await exists(`${file}.keep`)).toBe(true);
  });
});

describe("readLock (for doctor)", () => {
  it("says absent, held (with liveness) or unreadable, and never throws", async () => {
    h = await harness();
    const file = runnerLockPath(h.deps);
    expect(await readLock(file)).toEqual({ state: "absent" });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, record(LIVE));
    expect(await readLock(file, aliveSet(LIVE))).toEqual({ state: "held", pid: LIVE, startedAt: "2026-11-03T10:00:00.000Z", alive: true });
    expect(await readLock(file, aliveSet())).toMatchObject({ state: "held", alive: false });
    await writeFile(file, "junk");
    expect(await readLock(file)).toMatchObject({ state: "unreadable" });
    await unlink(file);
    await symlink(path.join(h.root, "nowhere"), file);
    expect(await readLock(file)).toMatchObject({ state: "unreadable", detail: expect.stringContaining("link") });
  });
});
