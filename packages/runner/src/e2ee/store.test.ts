import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { base64UrlEncode, generateKeyPair, generateRawKeyPair } from "@berdyh/bridge-crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { E2eeApp, TrustedBrowser } from "./contracts.js";
import { withFileLock } from "./fsutil.js";
import { appPathsOf } from "../paths.js";

import { loadRunnerIdentity, mutateEnrollWindow, mutateTrustList, readTrustList, removeAppState, statePath, touchLastSeen, upsertTrusted, wrapKeyNameOf } from "./store.js";

let dir: string;
let app: E2eeApp;
/** Another app's connection under the same base dirs: its own bridge/ folder, derived from its own id. */
const appNamed = (appId: string, runnerId = "r1"): E2eeApp => ({ appId, runnerId, paths: appPathsOf({ config: dir, data: dir, state: dir }, appId) });
/** The wrapping key file of `a`, in its own bridge config folder. */
const keyFileOf = (a: E2eeApp): string => path.join(path.dirname(statePath(a, "identity")), "identity.key");
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-store-"));
  app = { appId: "app", runnerId: "r1", paths: appPathsOf({ config: dir, data: dir, state: dir }, "app") };
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

async function entry(label = "Laptop", stamp = "2026-10-14T10:00:00.000Z"): Promise<TrustedBrowser> {
  const key = await generateKeyPair();
  return { browserKeyId: key.id, publicKey: base64UrlEncode(key.publicKey), label, enrolledAt: stamp, lastSeen: stamp };
}

describe("trust list", () => {
  it("is empty without a file, and stored 0600 in a 0700 directory", async () => {
    expect(await readTrustList(app)).toEqual([]);
    const laptop = await entry();
    await upsertTrusted(app, laptop);
    expect(await readTrustList(app)).toEqual([laptop]);
    const file = statePath(app, "trust");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
  });

  it("re-enrolling the same key refreshes its entry instead of duplicating it", async () => {
    const laptop = await entry("Old name");
    await upsertTrusted(app, laptop);
    await upsertTrusted(app, { ...laptop, label: "New name" });
    expect((await readTrustList(app)).map((b) => b.label)).toEqual(["New name"]);
  });

  it("removes exactly one browser", async () => {
    const first = await entry("first");
    const second = await entry("second");
    await upsertTrusted(app, first);
    await upsertTrusted(app, second);
    const remove = (id: string) => mutateTrustList(app, (list) => {
      const next = list.filter((e) => e.browserKeyId !== id);
      return next.length === list.length ? { result: false } : { list: next, result: true };
    });
    expect(await remove(first.browserKeyId)).toBe(true);
    expect(await remove(first.browserKeyId)).toBe(false);
    expect((await readTrustList(app)).map((b) => b.label)).toEqual(["second"]);
  });

  it("does not lose entries when several writers update at once", async () => {
    const entries = await Promise.all(Array.from({ length: 12 }, (_, i) => entry(`b${i}`)));
    await Promise.all(entries.map((e) => upsertTrusted(app, e)));
    expect(await readTrustList(app)).toHaveLength(12);
  });

  it("rejects an entry whose id does not match its key", async () => {
    await upsertTrusted(app, await entry());
    const file = statePath(app, "trust");
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { browsers: { publicKey: string }[] };
    parsed.browsers[0]!.publicKey = base64UrlEncode((await generateKeyPair()).publicKey);
    await fs.writeFile(file, JSON.stringify(parsed), { mode: 0o600 });
    await expect(readTrustList(app)).rejects.toThrow("does not match");
  });

  it("fails closed on a corrupt or unknown file", async () => {
    await upsertTrusted(app, await entry());
    const file = statePath(app, "trust");
    await fs.writeFile(file, "{ not json");
    await expect(readTrustList(app)).rejects.toThrow("not valid JSON");
    await fs.writeFile(file, JSON.stringify({ v: 2, browsers: [] }));
    await expect(readTrustList(app)).rejects.toThrow("unknown format");
  });

  it("keeps apps apart: another app's trust list is another app's folder, and an app id that is not a folder name is refused", async () => {
    await upsertTrusted(app, await entry());
    expect(await readTrustList(appNamed("other"))).toEqual([]);
    expect(statePath(appNamed("other"), "trust")).toBe(path.join(dir, "other", "bridge", "trust.json"));
    for (const bad of ["../../etc/x", "..", "Upper", "bridge"]) {
      expect(() => appNamed(bad)).toThrow();
    }
    expect(() => statePath({ appId: "../../etc/x", runnerId: "r1", paths: appPathsOf({ config: dir, data: dir, state: dir }, "other") }, "trust")).toThrow();
  });

  it("writes lastSeen at most once per interval", async () => {
    const laptop = await entry();
    await upsertTrusted(app, laptop);
    await touchLastSeen(app, laptop.browserKeyId, new Date("2026-10-14T10:01:00.000Z"));
    expect((await readTrustList(app))[0]!.lastSeen).toBe(laptop.lastSeen);
    await touchLastSeen(app, laptop.browserKeyId, new Date("2026-10-14T10:06:00.000Z"));
    expect((await readTrustList(app))[0]!.lastSeen).toBe("2026-10-14T10:06:00.000Z");
  });
});

describe("runner identity key", () => {
  it("is created once as a raw 0600 record and reused", async () => {
    const first = await loadRunnerIdentity(app);
    const second = await loadRunnerIdentity(app);
    expect(second.id).toBe(first.id);
    expect(Buffer.from(second.publicKey).equals(Buffer.from(first.publicKey))).toBe(true);
    const file = statePath(app, "identity");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({ v: 2, kind: "raw", alg: "aes-256-gcm" });
    const other = await loadRunnerIdentity(appNamed("other"));
    expect(other.id).not.toBe(first.id);
    first.destroy();
    second.destroy();
    other.destroy();
  });

  it("converges when two processes create it at the same time", async () => {
    const pairs = await Promise.all(Array.from({ length: 6 }, () => loadRunnerIdentity(app)));
    expect(new Set(pairs.map((pair) => pair.id)).size).toBe(1);
    for (const pair of pairs) pair.destroy();
  });

  it("refuses a key file that other users can read", async () => {
    (await loadRunnerIdentity(app)).destroy();
    await fs.chmod(statePath(app, "identity"), 0o644);
    await expect(loadRunnerIdentity(app)).rejects.toThrow("0600");
  });
});

describe("runner identity key at rest", () => {
  const secretOf = async (pair: Awaited<ReturnType<typeof loadRunnerIdentity>>): Promise<string> => {
    const stored = await pair.toStored();
    if (stored.kind !== "raw") throw new Error("expected a raw key");
    return base64UrlEncode(stored.secretKey);
  };
  const memorySecrets = () => {
    const data = new Map<string, string>();
    return { data, get: async (key: string) => data.get(key) ?? null, set: async (key: string, value: string) => void data.set(key, value) };
  };

  it("never writes the secret in the clear, and keeps the wrapping key in its own 0600 file", async () => {
    const identity = await loadRunnerIdentity(app);
    const secret = await secretOf(identity);
    const text = await fs.readFile(statePath(app, "identity"), "utf8");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("secretKey");
    expect((await fs.stat(keyFileOf(app))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(keyFileOf(app), "utf8")).not.toContain(secret);
    // and it still opens to the same key
    const again = await loadRunnerIdentity(app);
    expect(await secretOf(again)).toBe(secret);
    identity.destroy();
    again.destroy();
  });

  it("uses the injected credential store for the wrapping key, and refuses a different one", async () => {
    const secrets = memorySecrets();
    const keyed: E2eeApp = { ...app, secrets };
    const identity = await loadRunnerIdentity(keyed);
    expect(secrets.data.size).toBe(1);
    await expect(fs.access(keyFileOf(app))).rejects.toThrow();
    const again = await loadRunnerIdentity(keyed);
    expect(again.id).toBe(identity.id);

    const before = await fs.readFile(statePath(app, "identity"), "utf8");
    // an empty store, and a store with some other key: neither makes a new identity or opens this one
    await expect(loadRunnerIdentity({ ...app, secrets: memorySecrets() })).rejects.toThrow("missing");
    const other = memorySecrets();
    other.data.set([...secrets.data.keys()][0]!, base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))));
    await expect(loadRunnerIdentity({ ...app, secrets: other })).rejects.toThrow("cannot be decrypted");
    expect(await fs.readFile(statePath(app, "identity"), "utf8")).toBe(before);
    identity.destroy();
    again.destroy();
  });

  it("does not make a new identity when the wrapping key file was lost", async () => {
    (await loadRunnerIdentity(app)).destroy();
    await fs.rm(keyFileOf(app));
    await expect(loadRunnerIdentity(app)).rejects.toThrow("missing");
  });

  it("does not open a file for another runner id (the AAD names the app and the runner), or whose public key was swapped", async () => {
    (await loadRunnerIdentity(app)).destroy();
    await expect(loadRunnerIdentity({ ...app, runnerId: "r2" })).rejects.toThrow("cannot be decrypted");

    const file = statePath(app, "identity");
    const record = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, string>;
    record.publicKey = base64UrlEncode((await generateKeyPair()).publicKey);
    await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });
    await expect(loadRunnerIdentity(app)).rejects.toThrow("cannot be decrypted");
  });

  it("upgrades a first-version plaintext file in place, keeping the same identity", async () => {
    const fresh = await generateRawKeyPair();
    const file = statePath(app, "identity");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ v: 1, kind: "raw", publicKey: base64UrlEncode(fresh.publicKey), secretKey: base64UrlEncode(fresh.secretKey) }), { mode: 0o600 });
    const secret = base64UrlEncode(fresh.secretKey);
    const identity = await loadRunnerIdentity(app);
    expect(Buffer.from(identity.publicKey).equals(Buffer.from(fresh.publicKey))).toBe(true);
    const text = await fs.readFile(file, "utf8");
    expect(JSON.parse(text)).toMatchObject({ v: 2 });
    expect(text).not.toContain(secret);
    expect(await secretOf(await loadRunnerIdentity(app))).toBe(secret);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    identity.destroy();
  });
});

describe("file lock", () => {
  it("runs critical sections one at a time and breaks a stale lock", async () => {
    const file = path.join(dir, "x", "state.json");
    let active = 0;
    let maxActive = 0;
    await Promise.all(Array.from({ length: 5 }, () => withFileLock(file, async () => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    })));
    expect(maxActive).toBe(1);
    await fs.writeFile(`${file}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(`${file}.lock`, old, old);
    await expect(withFileLock(file, async () => "ran")).resolves.toBe("ran");
  });
});

describe("removeAppState", () => {
  it("removes the identity, trust list, enrollment and wrapping key file, and leaves another app alone", async () => {
    const other = appNamed("other");
    for (const a of [app, other]) { await loadRunnerIdentity(a); await upsertTrusted(a, await entry()); }
    await removeAppState(app);
    await expect(fs.access(statePath(app, "identity"))).rejects.toThrow();
    await expect(fs.access(statePath(app, "trust"))).rejects.toThrow();
    expect(await readTrustList(app)).toEqual([]);
    await expect(fs.access(keyFileOf(app))).rejects.toThrow();
    await expect(fs.access(keyFileOf(other))).resolves.toBeUndefined();
    expect((await readTrustList(other)).length).toBe(1);
    await expect(loadRunnerIdentity(other)).resolves.toBeDefined();
    await removeAppState(app);
  });

  it("deletes the wrapping key from the injected credential store", async () => {
    const data = new Map<string, string>();
    const secrets = { get: async (k: string) => data.get(k) ?? null, set: async (k: string, v: string) => void data.set(k, v), delete: async (k: string) => void data.delete(k) };
    const withSecrets: E2eeApp = { ...app, secrets };
    await loadRunnerIdentity(withSecrets);
    expect([...data.keys()]).toEqual(["bridge/e2ee-identity-key/app/r1"]);
    await removeAppState(withSecrets);
    expect(data.size).toBe(0);
    await expect(fs.access(statePath(app, "identity"))).rejects.toThrow();
  });

  it("keeps keychain accounts injective: runner ids that differ only by an escaped character get different item names", () => {
    expect(wrapKeyNameOf({ appId: "app", runnerId: "x/y" })).not.toBe(wrapKeyNameOf({ appId: "app", runnerId: "x%2Fy" }));
    expect(wrapKeyNameOf({ appId: "app", runnerId: "x/y" })).toBe("bridge/e2ee-identity-key/app/x%2Fy");
  });

  it("holds the enrollment and trust locks while deleting, so a concurrent writer lands before or after, never in between", async () => {
    await loadRunnerIdentity(app);
    await upsertTrusted(app, await entry());
    const enroll = statePath(app, "enroll");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    // A daemon-like holder of the enrollment lock that then writes the trust list.
    const holder = withFileLock(enroll, async () => { entered(); await held; await upsertTrusted(app, await entry("Late")); });
    await inside;
    let removed = false;
    const removal = removeAppState(app).then(() => { removed = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(removed).toBe(false);
    release();
    await holder;
    await removal;
    expect(await readTrustList(app)).toEqual([]);
    await expect(fs.access(statePath(app, "identity"))).rejects.toThrow();
  });
});

describe("per-app layout (paths)", () => {
  const base = () => ({ config: path.join(dir, "config"), data: path.join(dir, "data"), state: path.join(dir, "state") });
  const appOf = (id: string, over: Partial<E2eeApp> = {}): E2eeApp => ({ appId: id, runnerId: "r1", paths: appPathsOf(base(), id), ...over });
  const memorySecrets = () => {
    const data = new Map<string, string>();
    return { data, get: async (key: string) => data.get(key) ?? null, set: async (key: string, value: string) => void data.set(key, value), delete: async (key: string) => void data.delete(key) };
  };

  it("keeps the four files in the app's bridge config folder, without the runner id in their names", async () => {
    const a = appOf("app-a");
    const configDir = path.join(dir, "config/app-a/bridge");
    expect(statePath(a, "trust")).toBe(path.join(configDir, "trust.json"));
    expect(statePath(a, "identity")).toBe(path.join(configDir, "identity.json"));
    expect(statePath(a, "enroll")).toBe(path.join(configDir, "enroll.json"));
    await upsertTrusted(a, await entry());
    (await loadRunnerIdentity(a)).destroy();
    await mutateEnrollWindow(a, () => ({ window: { v: 1, codeId: "c", code: "ABCDEFGH", expiresAt: "2030-01-01T00:00:00.000Z", attemptsLeft: 3, state: "open", ownerPid: process.pid }, result: undefined }));
    expect((await fs.readdir(configDir)).sort()).toEqual(["enroll.json", "identity.json", "identity.key", "trust.json"]);
    expect((await fs.stat(path.join(configDir, "identity.key"))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(configDir)).mode & 0o777).toBe(0o700);
    // nothing of the deprecated layout is written
    await expect(fs.access(path.join(dir, "bridge"))).rejects.toThrow();
  });

  it("reuses the identity and keeps two apps apart", async () => {
    const a = appOf("app-a");
    const b = appOf("app-b");
    const first = await loadRunnerIdentity(a);
    const again = await loadRunnerIdentity(a);
    const other = await loadRunnerIdentity(b);
    expect(again.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    await upsertTrusted(a, await entry());
    expect(await readTrustList(b)).toEqual([]);
    for (const k of [first, again, other]) k.destroy();
  });

  it("writes the four files exactly where AppPaths lists them (doctor's manifest must not drift)", async () => {
    const a = appOf("app-a");
    const p = appPathsOf(base(), "app-a");
    expect(statePath(a, "trust")).toBe(p.trustFile);
    expect(statePath(a, "identity")).toBe(p.identityFile);
    expect(statePath(a, "enroll")).toBe(p.enrollFile);
    await upsertTrusted(a, await entry());
    (await loadRunnerIdentity(a)).destroy();
    await mutateEnrollWindow(a, () => ({ window: { v: 1, codeId: "c", code: "ABCDEFGH", expiresAt: "2030-01-01T00:00:00.000Z", attemptsLeft: 3, state: "open", ownerPid: process.pid }, result: undefined }));
    // no keychain secret store: the wrapping key lives in identity.key
    for (const file of [p.trustFile, p.identityFile, p.identityKeyFile, p.enrollFile]) await fs.access(file);
    const names = (await fs.readdir(p.configDir)).filter((n) => !n.endsWith(".lock")).sort();
    expect(names).toEqual([p.trustFile, p.identityFile, p.identityKeyFile, p.enrollFile].map((f) => path.basename(f)).sort());
  });

  it("does not open an identity file copied into another app's folder (the AAD names the app)", async () => {
    const a = appOf("app-a");
    const b = appOf("app-b");
    (await loadRunnerIdentity(a)).destroy();
    await fs.mkdir(b.paths!.configDir, { recursive: true });
    await fs.copyFile(statePath(a, "identity"), statePath(b, "identity"));
    await fs.copyFile(a.paths!.configDir + "/identity.key", b.paths!.configDir + "/identity.key");
    await expect(loadRunnerIdentity(b)).rejects.toThrow("cannot be decrypted");
  });

  it("refuses an app without paths", () => {
    expect(() => statePath({ appId: "app-a", runnerId: "r1" } as E2eeApp, "trust")).toThrow(/paths is not set/);
  });

  it("keeps the keychain item names byte for byte", async () => {
    expect(wrapKeyNameOf({ appId: "app-a", runnerId: "r1" })).toBe("bridge/e2ee-identity-key/app-a/r1");
    expect(wrapKeyNameOf({ appId: "a/b", runnerId: "c" })).toBe("bridge/e2ee-identity-key/a%2Fb/c");
    const secrets = memorySecrets();
    (await loadRunnerIdentity(appOf("app-a", { secrets }))).destroy();
    expect([...secrets.data.keys()]).toEqual(["bridge/e2ee-identity-key/app-a/r1"]);
    await expect(fs.access(path.join(dir, "config/app-a/bridge/identity.key"))).rejects.toThrow();
  });

  it("removeAppState removes the app's four files and leaves the other app and the parent alone", async () => {
    const secrets = memorySecrets();
    const a = appOf("app-a", { secrets });
    const b = appOf("app-b", { secrets });
    for (const x of [a, b]) {
      (await loadRunnerIdentity(x)).destroy();
      await upsertTrusted(x, await entry());
    }
    await fs.writeFile(path.join(a.paths!.configDir, "app.json"), "{}");
    await mutateEnrollWindow(a, () => ({ window: { v: 1, codeId: "c", code: "ABCDEFGH", expiresAt: "2030-01-01T00:00:00.000Z", attemptsLeft: 3, state: "open", ownerPid: 1 }, result: undefined }));
    await removeAppState(a);
    expect((await fs.readdir(a.paths!.configDir)).filter((name) => !name.endsWith(".lock"))).toEqual(["app.json"]);
    expect([...secrets.data.keys()]).toEqual(["bridge/e2ee-identity-key/app-b/r1"]);
    expect((await readTrustList(b)).length).toBe(1);
    await expect(loadRunnerIdentity(b)).resolves.toBeDefined();
    // the parent <config>/<app> is not removed (and not owned)
    expect((await fs.stat(path.join(dir, "config/app-a"))).isDirectory()).toBe(true);
    await removeAppState(a);
  });

  it("removeAppState without a keychain removes identity.key", async () => {
    const a = appOf("app-a");
    (await loadRunnerIdentity(a)).destroy();
    await removeAppState(a);
    expect((await fs.readdir(a.paths!.configDir)).filter((name) => !name.endsWith(".lock"))).toEqual([]);
  });

  describe("another app's state", () => {
    const window = { v: 1 as const, codeId: "c", code: "ABCDEFGH", expiresAt: "2030-01-01T00:00:00.000Z", attemptsLeft: 3, state: "open" as const, ownerPid: 1 };
    const enrollOp = (x: E2eeApp) => mutateEnrollWindow(x, () => ({ window, result: undefined }));
    const operations: [string, (x: E2eeApp) => Promise<unknown>][] = [
      ["readTrustList", (x) => readTrustList(x)],
      ["upsertTrusted", async (x) => upsertTrusted(x, await entry())],
      ["loadRunnerIdentity", (x) => loadRunnerIdentity(x)],
      ["mutateEnrollWindow", enrollOp],
      ["removeAppState", (x) => removeAppState(x)],
    ];
    /** Beta holds trust, identity and a window; returns a snapshot function of its folder. */
    async function seededBeta() {
      const beta = appOf("beta");
      (await loadRunnerIdentity(beta)).destroy();
      await upsertTrusted(beta, await entry("Beta laptop"));
      await enrollOp(beta);
      const snapshot = async () => Object.fromEntries(await Promise.all((await fs.readdir(beta.paths!.configDir)).filter((n) => !n.endsWith(".lock")).sort().map(async (n) => [n, await fs.readFile(path.join(beta.paths!.configDir, n), "utf8")])));
      return { beta, before: await snapshot(), snapshot };
    }

    it.each(operations)("refuses %s when alpha's bridge folder is a link to beta's", async (_name, op) => {
      const { before, snapshot, beta } = await seededBeta();
      await fs.mkdir(path.join(dir, "config/alpha"), { recursive: true });
      await fs.symlink(beta.paths!.configDir, path.join(dir, "config/alpha/bridge"));
      await expect(op(appOf("alpha"))).rejects.toThrow(/symlink/);
      expect(await snapshot()).toEqual(before);
    });

    it("refuses a dangling bridge folder link and creates nothing at its target", async () => {
      const elsewhere = path.join(dir, "elsewhere");
      await fs.mkdir(path.join(dir, "config/alpha"), { recursive: true });
      await fs.symlink(elsewhere, path.join(dir, "config/alpha/bridge"));
      for (const [, op] of operations) await expect(op(appOf("alpha"))).rejects.toThrow(/symlink/);
      await expect(fs.access(elsewhere)).rejects.toThrow();
    });

    it.each(["trust.json", "identity.json", "identity.key", "enroll.json"])("refuses a %s that is a link to beta's file, for reads, writes and removal of the target", async (name) => {
      const { before, snapshot, beta } = await seededBeta();
      const alpha = appOf("alpha");
      await fs.mkdir(alpha.paths!.configDir, { recursive: true });
      await fs.symlink(path.join(beta.paths!.configDir, name), path.join(alpha.paths!.configDir, name));
      const outcomes = await Promise.allSettled(operations.filter(([name]) => name !== "removeAppState").map(([, op]) => op(alpha)));
      // every operation that needs this file refuses; none may change beta's folder
      expect(outcomes.some((o) => o.status === "rejected" && /symlink/.test(String(o.reason)))).toBe(true);
      expect(await snapshot()).toEqual(before);
      // removal takes the link itself away, never its target
      await removeAppState(alpha);
      expect(await snapshot()).toEqual(before);
      await expect(fs.lstat(path.join(alpha.paths!.configDir, name))).rejects.toThrow();
    });

    it("refuses a lock file that is a link", async () => {
      const { before, snapshot, beta } = await seededBeta();
      const alpha = appOf("alpha");
      await fs.mkdir(alpha.paths!.configDir, { recursive: true });
      await fs.symlink(path.join(beta.paths!.configDir, "trust.json"), path.join(alpha.paths!.configDir, "trust.json.lock"));
      await expect(upsertTrusted(alpha, await entry())).rejects.toThrow(/symlink/);
      expect(await snapshot()).toEqual(before);
    });

    it("still allows a symlinked <config>/<app> parent", async () => {
      const real = path.join(dir, "real-alpha");
      await fs.mkdir(real);
      await fs.mkdir(path.join(dir, "config"), { recursive: true });
      await fs.symlink(real, path.join(dir, "config/alpha"));
      const alpha = appOf("alpha");
      await upsertTrusted(alpha, await entry());
      (await loadRunnerIdentity(alpha)).destroy();
      expect((await readTrustList(alpha)).length).toBe(1);
      expect(await fs.readdir(path.join(real, "bridge"))).toContain("trust.json");
      await removeAppState(alpha);
    });

    it.each(operations)("refuses %s when the app's paths are another app's", async (_name, op) => {
      const { before, snapshot } = await seededBeta();
      const alpha = appOf("alpha", { paths: appPathsOf(base(), "beta") });
      expect(() => statePath(alpha, "trust")).toThrow(/another app/);
      await expect(op(alpha)).rejects.toThrow(/another app/);
      expect(await snapshot()).toEqual(before);
    });

    it("refuses paths whose appId matches but whose folder is not <appId>/bridge", async () => {
      const beta = appPathsOf(base(), "beta");
      for (const paths of [{ appId: "alpha", configDir: beta.configDir }, { appId: "beta", configDir: path.join(dir, "config/alpha/bridge") }, { appId: "alpha", configDir: path.join(dir, "config/alpha") }]) {
        expect(() => statePath({ appId: "alpha", runnerId: "r1", paths }, "trust")).toThrow(/another app/);
      }
    });
  });
});
