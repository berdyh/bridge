import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), neon: vi.fn() }));
vi.mock("@neondatabase/serverless", () => ({ neon: mocks.neon }));
import { createNeonDeviceStore } from "./neon-store.js";
function setup() {
  mocks.query.mockReset().mockImplementation((sql, params) => ({ sql, params }));
  mocks.transaction.mockReset(); mocks.neon.mockReturnValue(mocks);
  return createNeonDeviceStore({ connectionString: "postgresql://test:test@localhost/test" });
}
describe("Neon HTTP adapter", () => {
  it("ships the same portable migration as D1", () => {
    expect(readFileSync(new URL("../migrations/0001_devices.sql", import.meta.url), "utf8")).toBe(readFileSync(new URL("../../server-d1/migrations/0001_devices.sql", import.meta.url), "utf8"));
  });
  it("ships the same credential fingerprint migration as D1, adding a nullable column and an index", () => {
    const sql = readFileSync(new URL("../migrations/0002_credential_fingerprint.sql", import.meta.url), "utf8");
    expect(sql).toBe(readFileSync(new URL("../../server-d1/migrations/0002_credential_fingerprint.sql", import.meta.url), "utf8"));
    expect(sql).toMatch(/ALTER TABLE bridge_device_credentials ADD COLUMN fingerprint TEXT;/);
    expect(sql).not.toMatch(/NOT NULL/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS bridge_credentials_by_fingerprint ON bridge_device_credentials \(fingerprint\)/);
  });
  it("maps rows and scopes reads with bound parameters", async () => {
    const store = setup(); mocks.query.mockResolvedValueOnce([{ user_id: "u", device_id: "d", hostname: "h", os: "o", runner_version: "1", created_at: "a", last_seen: "b" }]);
    expect(await store.getDevice("u", "d")).toEqual({ userId: "u", deviceId: "d", hostname: "h", os: "o", runnerVersion: "1", createdAt: "a", lastSeen: "b" });
    expect(mocks.query.mock.calls[0]![1]).toEqual(["u", "d"]);
    mocks.query.mockResolvedValueOnce([]); expect(await store.listDevices("other")).toEqual([]);
  });
  it("uses exactly one conditional UPDATE for touchLastSeen", async () => {
    const store = setup(); mocks.query.mockResolvedValueOnce([{ device_id: "d" }]);
    expect(await store.touchLastSeen("u", "d", "2026-10-14T00:05:00.000Z", 300_000)).toBe(true);
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^UPDATE .*revoked=0 AND last_seen <= \$4 RETURNING/), ["u", "d", "2026-10-14T00:05:00.000Z", "2026-10-14T00:00:00.000Z"]);
    mocks.query.mockResolvedValueOnce([]); expect(await store.touchLastSeen("u", "missing", "2026-10-14T00:05:00.000Z", 300_000)).toBe(false);
  });
  it.each([[false, false, "ok"], [true, false, "revoked"], [false, true, "credential_revoked"]])("serializes registration and rejects revoked identities (%s, %s)", async (revoked, credentialRevoked, result) => {
    const store = setup(); mocks.transaction.mockResolvedValue([[], [], [], [{ revoked, credential_revoked: credentialRevoked }]]);
    expect(await store.upsertDevice({ userId: "u", deviceId: "d", hostname: "h", os: "o", runnerVersion: "1", createdAt: "a", lastSeen: "b" }, "key")).toBe(result);
    const queries = mocks.transaction.mock.calls[0]![0];
    expect(queries[0]).toEqual({ sql: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", params: ["u"] });
    expect(queries[1].sql).toContain("WHERE NOT EXISTS");
    expect(queries[2].sql).toContain("ON CONFLICT DO NOTHING");
  });
  it("revokes atomically and returns the whole credential set", async () => {
    const store = setup(); mocks.transaction.mockResolvedValueOnce([[], [{ device_id: "d" }], [{ credential_id: "a" }, { credential_id: "b" }], [{ known: 1 }]]);
    expect(await store.revokeDevice("u", "d")).toEqual({ credentialIds: ["a", "b"] });
    mocks.transaction.mockResolvedValueOnce([[], [], [{ credential_id: "a" }, { credential_id: "b" }], [{ known: 1 }]]);
    expect(await store.revokeDevice("u", "d")).toEqual({ credentialIds: ["a", "b"], alreadyRevoked: true });
    mocks.transaction.mockResolvedValueOnce([[], [], [], []]); expect(await store.revokeDevice("u", "d")).toBeUndefined();
    mocks.query.mockResolvedValueOnce([{}]); expect(await store.isRevoked("u", "d")).toBe(true);
    mocks.query.mockResolvedValueOnce([]); expect(await store.isCredentialRevoked("other", "a")).toBe(false);
  });

  it("writes only the token hash, after the status read, only with a credential, and finds it by fingerprint", async () => {
    const store = setup(); const fp = "ab".repeat(32); const token = "ak_secret-token";
    mocks.query.mockResolvedValueOnce([{ "?column?": 1 }]); // the column check: migration 0002 is applied
    mocks.transaction.mockResolvedValue([[], [], [], [{ revoked: false, credential_revoked: false }], []]);
    const device = { userId: "u", deviceId: "d", hostname: "h", os: "o", runnerVersion: "1", createdAt: "a", lastSeen: "b" };
    expect(await store.upsertDevice(device, "key", fp)).toBe("ok");
    const queries = mocks.transaction.mock.calls[0]![0];
    expect(queries).toHaveLength(5);
    expect(queries[3].sql).toContain("AS credential_revoked"); // the status read keeps its place
    expect(queries[4].sql).toMatch(/^UPDATE bridge_device_credentials SET fingerprint=\$4 WHERE .*revoked=0\)$/);
    expect(queries[4].params).toEqual(["u", "d", "key", fp]);
    expect(JSON.stringify(queries)).not.toContain(token);
    // Without a fingerprint, or without a credential, nothing extra is written (a database without migration 0002 still works).
    for (const args of [["key"], [undefined, fp]] as const) {
      mocks.transaction.mockClear().mockResolvedValue([[], [], [], [{ revoked: false, credential_revoked: false }]]);
      await store.upsertDevice(device, ...args);
      expect(mocks.transaction.mock.calls[0]![0]).toHaveLength(4);
    }
    mocks.query.mockClear().mockResolvedValueOnce([{ user_id: "u", credential_id: "key" }]);
    expect(await store.revokedCredentialByFingerprint!(fp)).toEqual({ userId: "u", credentialId: "key" });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringMatching(/WHERE c\.fingerprint=\$1 AND d\.revoked=1 LIMIT 1$/), [fp]);
    mocks.query.mockResolvedValueOnce([]); expect(await store.revokedCredentialByFingerprint!("0".repeat(64))).toBeUndefined();
  });

  it("binds and looks up on a database without migration 0002 exactly as before, and picks the column up once it exists", async () => {
    const store = setup(); const fp = "ab".repeat(32);
    const device = { userId: "u", deviceId: "d", hostname: "h", os: "o", runnerVersion: "1", createdAt: "a", lastSeen: "b" };
    let now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      mocks.transaction.mockResolvedValue([[], [], [], [{ revoked: false, credential_revoked: false }]]);
      mocks.query.mockResolvedValueOnce([]); // information_schema: no fingerprint column
      expect(await store.upsertDevice(device, "key", fp)).toBe("ok");
      expect(mocks.transaction.mock.calls[0]![0]).toHaveLength(4); // no fingerprint write
      mocks.query.mockClear();
      expect(await store.revokedCredentialByFingerprint!(fp)).toBeUndefined(); // answered without a query
      expect(await store.upsertDevice(device, "key", fp)).toBe("ok");
      expect(mocks.query.mock.calls.filter(([sql]) => /information_schema/.test(String(sql)))).toHaveLength(0); // not re-checked within the minute
      // The check itself failing never fails the hello, and is retried on the next call.
      now += 61_000;
      mocks.query.mockRejectedValueOnce(new Error("catalog unavailable"));
      mocks.transaction.mockClear().mockResolvedValue([[], [], [], [{ revoked: false, credential_revoked: false }]]);
      expect(await store.upsertDevice(device, "key", fp)).toBe("ok");
      expect(mocks.transaction.mock.calls[0]![0]).toHaveLength(4);
      mocks.query.mockRejectedValueOnce(new Error("catalog unavailable"));
      expect(await store.revokedCredentialByFingerprint!(fp)).toBeUndefined();
      // 0002 applied: the next check finds the column and the fingerprint is written and looked up.
      mocks.query.mockResolvedValueOnce([{ "?column?": 1 }]);
      mocks.transaction.mockClear().mockResolvedValue([[], [], [], [{ revoked: false, credential_revoked: false }], []]);
      expect(await store.upsertDevice(device, "key", fp)).toBe("ok");
      expect(mocks.transaction.mock.calls[0]![0]).toHaveLength(5);
      mocks.query.mockResolvedValueOnce([{ user_id: "u", credential_id: "key" }]);
      expect(await store.revokedCredentialByFingerprint!(fp)).toEqual({ userId: "u", credentialId: "key" });
    } finally { vi.restoreAllMocks(); }
  });
});
