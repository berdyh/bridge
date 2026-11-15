import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createD1DeviceStore } from "./d1-store.js";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup(migrations = ["0001_devices.sql", "0002_credential_fingerprint.sql"]) {
  const sqlite = new DatabaseSync(":memory:"); databases.push(sqlite);
  for (const file of migrations) sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  const prepare = (sql: string) => ({ bind: (...values: unknown[]) => {
    const run = () => {
      // D1's numbered ?n parameters are SQLite named parameters.
      const params = Object.fromEntries(values.map((v, i) => [`?${i + 1}`, v]));
      const stmt = sqlite.prepare(sql);
      const results = stmt.all(params as never);
      return { results, meta: { changes: Number(sqlite.prepare("SELECT changes() AS n").get()!.n) }, success: true };
    };
    return { all: async () => run(), run: async () => run(), first: async () => run().results[0] ?? null, execute: run };
  } });
  const db = { prepare, batch: async (statements: { execute(): unknown }[]) => {
    sqlite.exec("BEGIN"); try { const results = statements.map((s) => s.execute()); sqlite.exec("COMMIT"); return results; } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  } } as unknown as D1Database;
  return Object.assign(createD1DeviceStore(db), { sqlite });
}
const device = { userId: "alice", deviceId: "pc", hostname: "host", os: "linux", runnerVersion: "1", createdAt: "2026-10-14T00:00:00.000Z", lastSeen: "2026-10-14T00:00:00.000Z" };
describe("D1 DeviceStore (real SQLite statements, fake binding)", () => {
  it("preserves timestamps on reconnect, scopes users and orders devices", async () => {
    const store = setup();
    expect(await store.upsertDevice(device, "key1")).toBe("ok");
    expect(await store.upsertDevice({ ...device, hostname: "new", createdAt: "2027", lastSeen: "2027" }, "key2")).toBe("ok");
    expect(await store.getDevice("alice", "pc")).toEqual({ ...device, hostname: "new" });
    expect(await store.getDevice("bob", "pc")).toBeUndefined();
    await store.upsertDevice({ ...device, deviceId: "new", createdAt: "2026-10-15T00:00:00.000Z" });
    expect((await store.listDevices("alice")).map((d) => d.deviceId)).toEqual(["new", "pc"]);
    expect(await store.listDevices("bob")).toEqual([]);
  });
  it("throttles lastSeen atomically at the boundary and refuses stale updates", async () => {
    const store = setup(); await store.upsertDevice(device);
    expect(await store.touchLastSeen("alice", "pc", "2026-10-14T00:04:59.999Z", 300_000)).toBe(false);
    const attempts = await Promise.all([1, 2, 3].map(() => store.touchLastSeen("alice", "pc", "2026-10-14T00:05:00.000Z", 300_000)));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await store.touchLastSeen("alice", "pc", device.lastSeen, 300_000)).toBe(false);
    expect(await store.touchLastSeen("bob", "pc", "2027-01-01T00:00:00.000Z", 300_000)).toBe(false);
  });
  it("tombstones devices and every credential, including credentials shared with other devices", async () => {
    const store = setup();
    await store.upsertDevice(device, "key1"); await store.upsertDevice(device, "key2");
    await store.upsertDevice({ ...device, deviceId: "other" }, "key1");
    expect(await store.revokeDevice("bob", "pc")).toBeUndefined();
    expect(await store.revokeDevice("alice", "pc")).toEqual({ credentialIds: ["key1", "key2"] });
    expect(await store.isCredentialRevoked("alice", "key1")).toBe(true);
    expect(await store.isCredentialRevoked("bob", "key1")).toBe(false);
    expect(await store.isRevoked("alice", "pc")).toBe(true);
    expect(await store.getDevice("alice", "pc")).toBeUndefined();
    expect(await store.upsertDevice(device)).toBe("revoked");
    expect(await store.upsertDevice({ ...device, deviceId: "renamed" }, "key1")).toBe("credential_revoked");
    expect(await store.getDevice("alice", "renamed")).toBeUndefined();
    expect(await store.touchLastSeen("alice", "pc", "2027-01-01T00:00:00.000Z", 0)).toBe(false);
    expect(await store.revokeDevice("alice", "pc")).toEqual({ credentialIds: ["key1", "key2"], alreadyRevoked: true });
    expect(await store.revokeDevice("alice", "never")).toBeUndefined();
  });

  it("stores only the token hash, finds a credential by it once its device is revoked, and is not found before the migration", async () => {
    const store = setup(); const fp = "ab".repeat(32); const token = "ak_secret-token";
    await store.upsertDevice(device, "key1", fp);
    await store.upsertDevice({ ...device, deviceId: "other" }, "key2"); // no fingerprint: a credential bound before the migration
    expect(store.sqlite.prepare("SELECT credential_id, fingerprint FROM bridge_device_credentials ORDER BY 1").all()).toEqual([{ credential_id: "key1", fingerprint: fp }, { credential_id: "key2", fingerprint: null }]);
    expect(JSON.stringify(store.sqlite.prepare("SELECT * FROM bridge_device_credentials").all())).not.toContain(token);
    expect(await store.revokedCredentialByFingerprint!(fp)).toBeUndefined(); // device still live
    await store.revokeDevice("alice", "pc"); await store.revokeDevice("alice", "other");
    expect(await store.revokedCredentialByFingerprint!(fp)).toEqual({ userId: "alice", credentialId: "key1" });
    expect(await store.revokedCredentialByFingerprint!(token)).toBeUndefined();
    // A revoked device keeps its fingerprint: a later refused upsert does not rewrite it.
    expect(await store.upsertDevice(device, "key1", "cd".repeat(32))).toBe("revoked");
    expect(await store.revokedCredentialByFingerprint!(fp)).toEqual({ userId: "alice", credentialId: "key1" });
    expect(await store.revokedCredentialByFingerprint!("cd".repeat(32))).toBeUndefined();
  });

  it("binds and looks up on a database without migration 0002 exactly as before, and picks the column up once it exists", async () => {
    const store = setup(["0001_devices.sql"]); const fp = "ab".repeat(32);
    let now = 1_000_000; const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      expect(await store.upsertDevice(device, "key1", fp)).toBe("ok"); // the hello is not failed by the missing column
      expect(await store.getDevice("alice", "pc")).toEqual(device);
      expect(await store.revokedCredentialByFingerprint!(fp)).toBeUndefined();
      expect(await store.revokeDevice("alice", "pc")).toEqual({ credentialIds: ["key1"] });
      expect(await store.isCredentialRevoked("alice", "key1")).toBe(true);
      expect(await store.revokedCredentialByFingerprint!(fp)).toBeUndefined(); // 401 as today
      // 0002 is applied later: after the recheck window the fingerprint is written.
      store.sqlite.exec(readFileSync(new URL("../migrations/0002_credential_fingerprint.sql", import.meta.url), "utf8"));
      now += 61_000;
      await store.upsertDevice({ ...device, deviceId: "pc2" }, "key2", "cd".repeat(32));
      expect(store.sqlite.prepare("SELECT credential_id, fingerprint FROM bridge_device_credentials ORDER BY 1").all()).toEqual([{ credential_id: "key1", fingerprint: null }, { credential_id: "key2", fingerprint: "cd".repeat(32) }]);
      await store.revokeDevice("alice", "pc2");
      expect(await store.revokedCredentialByFingerprint!("cd".repeat(32))).toEqual({ userId: "alice", credentialId: "key2" });
    } finally { clock.mockRestore(); }
  });
});
