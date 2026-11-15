import { describe, expect, it } from "vitest";

import { createMemoryDeviceStore } from "./memory-store.js";

const rec = (userId: string, deviceId: string, at = "2026-01-01T00:00:00.000Z") => ({
  userId,
  deviceId,
  hostname: "h",
  os: "linux",
  runnerVersion: "1",
  createdAt: at,
  lastSeen: at,
});

describe("memory device store", () => {
  it("scopes every method by user", async () => {
    const s = createMemoryDeviceStore();
    await s.upsertDevice(rec("a", "d1"));
    expect(await s.getDevice("b", "d1")).toBeUndefined();
    expect(await s.listDevices("b")).toEqual([]);
    expect(await s.revokeDevice("b", "d1")).toBeUndefined();
    expect(await s.touchLastSeen("b", "d1", "2027-01-01T00:00:00.000Z", 0)).toBe(false);
    expect(await s.isRevoked("a", "d1")).toBe(false);
  });

  it("throttles touchLastSeen atomically", async () => {
    const s = createMemoryDeviceStore();
    await s.upsertDevice(rec("a", "d1"));
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    expect(await s.touchLastSeen("a", "d1", at(60_000), 300_000)).toBe(false);
    expect(await s.touchLastSeen("a", "d1", at(300_000), 300_000)).toBe(true);
    expect(await s.touchLastSeen("a", "d1", at(301_000), 300_000)).toBe(false);
    expect((await s.getDevice("a", "d1"))?.lastSeen).toBe(at(300_000));
    expect(await s.touchLastSeen("a", "nope", at(900_000), 0)).toBe(false);
  });

  it("revokes the device and every credential bound to it", async () => {
    const s = createMemoryDeviceStore();
    await s.upsertDevice(rec("a", "d1"), "c1");
    await s.upsertDevice(rec("a", "d1"), "c2");
    expect(await s.revokeDevice("a", "d1")).toEqual({ credentialIds: ["c1", "c2"] });
    expect(await s.listDevices("a")).toEqual([]);
    expect(await s.isRevoked("a", "d1")).toBe(true);
    expect(await s.isCredentialRevoked("a", "c1")).toBe(true);
    expect(await s.isCredentialRevoked("b", "c1")).toBe(false);
    expect(await s.upsertDevice(rec("a", "d1"))).toBe("revoked");
    expect(await s.upsertDevice(rec("a", "d2"), "c2")).toBe("credential_revoked");
    expect(await s.revokeDevice("a", "d1")).toEqual({ credentialIds: ["c1", "c2"], alreadyRevoked: true });
    expect(await s.revokeDevice("a", "never")).toBeUndefined();
  });

  it("keeps createdAt on update and lists newest first", async () => {
    const s = createMemoryDeviceStore();
    await s.upsertDevice(rec("a", "old", "2026-01-01T00:00:00.000Z"));
    await s.upsertDevice(rec("a", "new", "2026-02-01T00:00:00.000Z"));
    await s.upsertDevice({ ...rec("a", "old", "2026-03-01T00:00:00.000Z"), hostname: "renamed" });
    expect((await s.listDevices("a")).map((d) => d.deviceId)).toEqual(["new", "old"]);
    expect(await s.getDevice("a", "old")).toMatchObject({ hostname: "renamed", createdAt: "2026-01-01T00:00:00.000Z" });
  });

  it("finds a credential by token fingerprint only once its device is revoked, and keeps only the hash", async () => {
    const s = createMemoryDeviceStore();
    const token = "ak_secret-token";
    const fp = "a".repeat(64);
    await s.upsertDevice(rec("a", "d1"), "c1", fp);
    await s.upsertDevice(rec("a", "d2"), "c2", "b".repeat(64));
    expect(await s.revokedCredentialByFingerprint!(fp)).toBeUndefined(); // bound to a live device
    expect(await s.revokeDevice("a", "d1")).toEqual({ credentialIds: ["c1"] });
    expect(await s.revokedCredentialByFingerprint!(fp)).toEqual({ userId: "a", credentialId: "c1" });
    expect(await s.revokedCredentialByFingerprint!("b".repeat(64))).toBeUndefined(); // another device's credential
    expect(await s.revokedCredentialByFingerprint!(token)).toBeUndefined(); // the token itself is not a key
    expect(await s.revokedCredentialByFingerprint!("c".repeat(64))).toBeUndefined();
  });

  it("does not record a fingerprint for a refused upsert or without a credential", async () => {
    const s = createMemoryDeviceStore();
    await s.upsertDevice(rec("a", "d1"), "c1");
    await s.revokeDevice("a", "d1");
    expect(await s.upsertDevice(rec("a", "d9"), "c1", "d".repeat(64))).toBe("credential_revoked");
    expect(await s.upsertDevice(rec("a", "d2"), undefined, "e".repeat(64))).toBe("ok");
    expect(await s.revokedCredentialByFingerprint!("d".repeat(64))).toBeUndefined();
    expect(await s.revokedCredentialByFingerprint!("e".repeat(64))).toBeUndefined();
  });
});
