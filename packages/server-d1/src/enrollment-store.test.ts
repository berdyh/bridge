import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { EnrollmentRecord } from "@berdyh/bridge-server";
import { afterEach, expect, it } from "vitest";
import { createD1EnrollmentStore } from "./enrollment-store.js";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup() {
  const sqlite = new DatabaseSync(":memory:"); databases.push(sqlite);
  sqlite.exec(readFileSync(new URL("../migrations/0003_enrollment.sql", import.meta.url), "utf8"));
  const prepare = (sql: string) => ({ bind: (...values: unknown[]) => {
    const run = () => {
      const params = Object.fromEntries(values.map((v, i) => [`?${i + 1}`, v]));
      const results = sqlite.prepare(sql).all(params as never);
      return { results, meta: { changes: Number(sqlite.prepare("SELECT changes() AS n").get()!.n) }, success: true };
    };
    return { all: async () => run(), run: async () => run(), first: async () => run().results[0] ?? null };
  } });
  return { sqlite, store: createD1EnrollmentStore({ prepare } as unknown as D1Database) };
}

const row = (patch: Partial<EnrollmentRecord> = {}): EnrollmentRecord => ({
  appId: "app-a", id: "device-hash", userCodeHash: "code-hash", revision: 0, state: "pending",
  device: { hostname: "test", os: "linux", runnerVersion: "test" },
  createdAt: 100, expiresAt: 200, cleanupAt: 200, intervalSeconds: 5, nextPollAt: 100, ...patch,
});

it("enforces unique device and approval codes per app, returning independent durable copies", async () => {
  const { store } = setup();
  expect(await store.create(row())).toBe(true);
  expect(await store.create(row())).toBe(false);
  expect(await store.create(row({ id: "other" }))).toBe(false);
  expect(await store.create(row({ appId: "app-b" }))).toBe(true);
  expect(await store.get("unknown", "device-hash")).toBeUndefined();
  expect(await store.getByUserCodeHash("unknown", "code-hash")).toBeUndefined();
  const record = (await store.get("app-a", "device-hash"))!;
  record.device.hostname = "mutated";
  expect((await store.getByUserCodeHash("app-a", "code-hash"))!.device.hostname).toBe("test");
});

it("allows only one concurrent revision winner and refuses code retargeting or stale deletion", async () => {
  const { store } = setup(); await store.create(row());
  const wins = await Promise.all(["user_one", "user_two"].map((userId) => store.compareAndSet(row({ revision: 1, state: "issuing", userId }), 0)));
  expect(wins.filter(Boolean)).toHaveLength(1);
  expect(await store.compareAndSet(row({ revision: 2, userCodeHash: "changed" }), 1)).toBe(false);
  expect(await store.delete("app-a", "device-hash", 0)).toBe(false);
  await expect(store.compareAndSet(row({ revision: 8 }), 1)).rejects.toThrow("increment");
  expect(await store.delete("app-b", "device-hash", 1)).toBe(false);
  expect(await store.delete("app-a", "device-hash", 1)).toBe(true);
});

it("indexes bounded cleanup per app and retains only encrypted delivery state", async () => {
  const { store, sqlite } = setup();
  await store.create(row({ sealedDelivery: "ciphertext-only" }));
  await store.create(row({ id: "later", userCodeHash: "code2", cleanupAt: 300 }));
  await store.create(row({ appId: "app-b", cleanupAt: 100 }));
  expect((await store.listExpired("app-a", 300, 1)).map((r) => r.id)).toEqual(["device-hash"]);
  expect((await store.listExpired("app-a", 199, 10))).toEqual([]);
  expect((await store.listExpired("app-b", 300, 10))).toHaveLength(1);
  expect(JSON.stringify(sqlite.prepare("SELECT * FROM bridge_enrollments").all())).toContain("ciphertext-only");
  await expect(store.listExpired("app-a", 300, 0)).rejects.toThrow("cleanup");
});
