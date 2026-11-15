// Opt-in: runs the real NeonStore against a live Postgres. Skipped unless BRIDGE_NEON_URL is set.
// Use a throwaway database; the test applies the shipped migration and scopes rows to unique user ids.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import type { DeviceRecord } from "@berdyh/bridge-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNeonDeviceStore } from "./neon-store.js";

const url = process.env.BRIDGE_NEON_URL;
const run = randomUUID().slice(0, 8);
const rec = (userId: string, deviceId: string, over: Partial<DeviceRecord> = {}): DeviceRecord => ({ userId, deviceId, hostname: "host", os: "linux", runnerVersion: "1.0.0", createdAt: "2026-10-14T00:00:00.000Z", lastSeen: "2026-10-14T00:00:00.000Z", ...over });

describe.skipIf(!url)("NeonStore against live Postgres", () => {
  const users: string[] = [];
  const user = (name: string) => { const id = `live_${run}_${name}`; users.push(id); return id; };
  const sql = neon(url ?? "postgresql://unused");
  const store = createNeonDeviceStore({ connectionString: url ?? "postgresql://unused" });

  beforeAll(async () => {
    for (const [file, idempotent] of [["0001_devices.sql", (t: string) => t], ["0002_credential_fingerprint.sql", (t: string) => t.replace("ADD COLUMN", "ADD COLUMN IF NOT EXISTS")]] as const) {
      const ddl = idempotent(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8")).replace(/^--.*$/gm, "");
      for (const statement of ddl.split(";").map((s) => s.trim()).filter(Boolean)) await sql.query(statement);
    }
  });
  afterAll(async () => {
    if (!users.length) return;
    await sql.query("DELETE FROM bridge_device_credentials WHERE user_id = ANY($1)", [users]);
    await sql.query("DELETE FROM bridge_devices WHERE user_id = ANY($1)", [users]);
  });

  it("applies the migration idempotently", async () => {
    const tables = await sql.query("SELECT table_name FROM information_schema.tables WHERE table_name IN ('bridge_devices','bridge_device_credentials') ORDER BY 1");
    expect(tables.map((r) => r.table_name)).toEqual(["bridge_device_credentials", "bridge_devices"]);
  });

  it("inserts, reads and lists newest first, scoped per user", async () => {
    const u = user("list"), other = user("list_other");
    expect(await store.getDevice(u, "d1")).toBeUndefined();
    expect(await store.upsertDevice(rec(u, "d1", { createdAt: "2026-10-14T00:00:01.000Z" }))).toBe("ok");
    expect(await store.upsertDevice(rec(u, "d2", { createdAt: "2026-10-14T00:00:02.000Z" }))).toBe("ok");
    expect(await store.upsertDevice(rec(other, "d1"))).toBe("ok");
    expect(await store.getDevice(u, "d1")).toEqual(rec(u, "d1", { createdAt: "2026-10-14T00:00:01.000Z" }));
    expect((await store.listDevices(u)).map((d) => d.deviceId)).toEqual(["d2", "d1"]);
    expect((await store.listDevices(other)).map((d) => d.deviceId)).toEqual(["d1"]);
  });

  it("upserts on conflict: updates hostname/os/version, keeps createdAt and lastSeen", async () => {
    const u = user("upsert");
    await store.upsertDevice(rec(u, "d"));
    expect(await store.upsertDevice(rec(u, "d", { hostname: "new", os: "darwin", runnerVersion: "2.0.0", createdAt: "2030-01-01T00:00:00.000Z", lastSeen: "2030-01-01T00:00:00.000Z" }), "key-1")).toBe("ok");
    expect(await store.getDevice(u, "d")).toEqual(rec(u, "d", { hostname: "new", os: "darwin", runnerVersion: "2.0.0" }));
    // Re-binding the same credential is a no-op, a second credential is added.
    expect(await store.upsertDevice(rec(u, "d"), "key-1")).toBe("ok");
    expect(await store.upsertDevice(rec(u, "d"), "key-2")).toBe("ok");
    const creds = await sql.query("SELECT credential_id FROM bridge_device_credentials WHERE user_id=$1 AND device_id=$2 ORDER BY 1", [u, "d"]);
    expect(creds.map((r) => r.credential_id)).toEqual(["key-1", "key-2"]);
  });

  it("throttles touchLastSeen atomically", async () => {
    const u = user("touch");
    await store.upsertDevice(rec(u, "d"));
    expect(await store.touchLastSeen(u, "d", "2026-10-14T00:04:00.000Z", 300_000)).toBe(false);
    expect((await store.getDevice(u, "d"))?.lastSeen).toBe("2026-10-14T00:00:00.000Z");
    expect(await store.touchLastSeen(u, "d", "2026-10-14T00:05:00.000Z", 300_000)).toBe(true);
    expect((await store.getDevice(u, "d"))?.lastSeen).toBe("2026-10-14T00:05:00.000Z");
    expect(await store.touchLastSeen(u, "d", "2026-10-14T00:06:00.000Z", 300_000)).toBe(false);
    expect(await store.touchLastSeen(u, "missing", "2026-10-14T01:00:00.000Z", 300_000)).toBe(false);
    // Concurrent callers: exactly one wins.
    const wins = await Promise.all(Array.from({ length: 5 }, () => store.touchLastSeen(u, "d", "2026-10-14T01:00:00.000Z", 300_000)));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it("revokes a device with its credential set and refuses re-registration", async () => {
    const u = user("revoke");
    await store.upsertDevice(rec(u, "d"), "key-a");
    await store.upsertDevice(rec(u, "d"), "key-b");
    await store.upsertDevice(rec(u, "keep"), "key-c");
    expect(await store.isRevoked(u, "d")).toBe(false);
    expect(await store.isCredentialRevoked(u, "key-a")).toBe(false);
    expect(await store.revokeDevice(u, "d")).toEqual({ credentialIds: ["key-a", "key-b"] });
    expect(await store.revokeDevice(u, "d")).toEqual({ credentialIds: ["key-a", "key-b"], alreadyRevoked: true });
    expect(await store.revokeDevice(u, "unknown")).toBeUndefined();
    expect(await store.isRevoked(u, "d")).toBe(true);
    expect(await store.isRevoked(u, "keep")).toBe(false);
    expect(await store.isCredentialRevoked(u, "key-a")).toBe(true);
    expect(await store.isCredentialRevoked(u, "key-c")).toBe(false);
    expect(await store.isCredentialRevoked("someone_else", "key-a")).toBe(false);
    expect(await store.getDevice(u, "d")).toBeUndefined();
    expect((await store.listDevices(u)).map((d) => d.deviceId)).toEqual(["keep"]);
    expect(await store.touchLastSeen(u, "d", "2030-01-01T00:00:00.000Z", 0)).toBe(false);
    expect(await store.upsertDevice(rec(u, "d"))).toBe("revoked");
    expect(await store.upsertDevice(rec(u, "d"), "fresh")).toBe("revoked");
    // A revoked credential cannot be reused on another device of the same user.
    expect(await store.upsertDevice(rec(u, "other-device"), "key-a")).toBe("credential_revoked");
    expect(await store.getDevice(u, "other-device")).toBeUndefined();
    expect(await store.upsertDevice(rec(u, "other-device"), "key-new")).toBe("ok");
  });

  it("serializes concurrent registrations of one user under the advisory lock", async () => {
    const u = user("race");
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => store.upsertDevice(rec(u, "d"), `k${i}`)));
    expect(results).toEqual(Array(6).fill("ok"));
    expect(await store.listDevices(u)).toHaveLength(1);
    const creds = await sql.query("SELECT count(*)::int AS n FROM bridge_device_credentials WHERE user_id=$1", [u]);
    expect(creds[0]!.n).toBe(6);
    // Revocation racing a registration with the same credential: no credential may stay usable afterwards.
    const [, ...rest] = await Promise.all([store.revokeDevice(u, "d"), ...Array.from({ length: 4 }, (_, i) => store.upsertDevice(rec(u, `n${i}`), "k0"))]);
    for (const r of rest) expect(["ok", "credential_revoked"]).toContain(r);
    expect(await store.isCredentialRevoked(u, "k0")).toBe(true);
  });

  it("finds a credential by token fingerprint only after its device is revoked, and stores only the hash", async () => {
    const u = user("fingerprint"); const fp = `${run}${"0".repeat(56)}`;
    await store.upsertDevice(rec(u, "d"), "key-fp", fp);
    expect(await store.revokedCredentialByFingerprint!(fp)).toBeUndefined();
    await store.revokeDevice(u, "d");
    expect(await store.revokedCredentialByFingerprint!(fp)).toEqual({ userId: u, credentialId: "key-fp" });
    expect(await store.revokedCredentialByFingerprint!("f".repeat(64))).toBeUndefined();
    expect((await sql.query("SELECT fingerprint FROM bridge_device_credentials WHERE user_id=$1", [u])).map((r) => r.fingerprint)).toEqual([fp]);
  });
});
