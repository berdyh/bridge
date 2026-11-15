import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireLoginLease, LoginLeaseError } from "./login-lease.js";

let root: string;
let login: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "login-lease-"));
  login = path.join(root, "auth.json");
  await writeFile(login, "synthetic", { mode: 0o600 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("cross-process login lease", () => {
  it("creates private nonsecret owner identity and holds until explicit idempotent release", async () => {
    const lease = await acquireLoginLease(login);
    const directory = `${login}.bridge-login-lease`;
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(directory, "owner.json"))).mode & 0o777).toBe(0o600);
    const record = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8"));
    expect(record).toMatchObject({ pid: process.pid, uid: process.getuid!(), started: expect.any(String), acquiredAt: expect.any(String) });
    expect(JSON.stringify(record)).not.toContain("synthetic");
    await expect(acquireLoginLease(login)).rejects.toMatchObject({ code: "AGENT_LOGIN_BUSY" });
    await lease.release();
    await lease.release();
    await expect(lease.assertOwned()).rejects.toBeInstanceOf(LoginLeaseError);
    const retry = await acquireLoginLease(login);
    await retry.release();
  });

  it("does not reclaim crashed, reused-PID, or incomplete owner records", async () => {
    const lease = await acquireLoginLease(login);
    const recordFile = `${login}.bridge-login-lease/owner.json`;
    const owner = JSON.parse(await readFile(recordFile, "utf8"));
    for (const change of [{ pid: 2_147_483_647 }, { started: "prior-boot:0" }]) {
      await writeFile(recordFile, JSON.stringify({ ...owner, ...change }));
      await expect(acquireLoginLease(login)).rejects.toThrow(/missing owner PID alone is not safe recovery/);
    }
    await writeFile(recordFile, "{");
    await expect(acquireLoginLease(login)).rejects.toThrow(/incomplete/);
    await expect(lease.release()).rejects.toThrow(/removed or replaced/);
  });

  it("refuses unsafe lease links/permissions and leaves the target untouched", async () => {
    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "sentinel"), "untouched");
    const directory = `${login}.bridge-login-lease`;
    await symlink(target, directory);
    await expect(acquireLoginLease(login)).rejects.toThrow(/unsafe lease directory/);
    expect(await readFile(path.join(target, "sentinel"), "utf8")).toBe("untouched");
    await rm(directory);
    await mkdir(directory, { mode: 0o755 });
    await expect(acquireLoginLease(login)).rejects.toThrow(/unsafe lease directory/);
  });

  it("refuses writable source directories and login aliases", async () => {
    await chmod(root, 0o777);
    await expect(acquireLoginLease(login)).rejects.toThrow(/login directory must/);
    await chmod(root, 0o700);
    const alias = path.join(root, "alias.json");
    await symlink(login, alias);
    await expect(acquireLoginLease(alias)).rejects.toThrow(/regular file/);
  });
});
