import type { DeviceRecord } from "@berdyh/bridge-protocol";
import type { DeviceStore, RevokeResult, UpsertResult } from "@berdyh/bridge-server";

const key = (userId: string, id: string): string => `${userId}\u0000${id}`;

/** An in-memory `DeviceStore`, for tests and single-process use. */
export function createMemoryDeviceStore(): DeviceStore {
  const devices = new Map<string, DeviceRecord>();
  const credentials = new Map<string, Set<string>>(); // device key -> credential ids
  const revokedDevices = new Set<string>();
  const revokedCredentials = new Set<string>();
  /** fingerprint (a SHA-256 hex of a runner token, never the token) -> the credential it last authenticated. */
  const fingerprints = new Map<string, { userId: string; credentialId: string }>();

  return {
    async getDevice(userId, deviceId) {
      if (revokedDevices.has(key(userId, deviceId))) return undefined;
      const d = devices.get(key(userId, deviceId));
      return d ? { ...d } : undefined;
    },
    async listDevices(userId) {
      return [...devices.values()]
        .filter((d) => d.userId === userId && !revokedDevices.has(key(userId, d.deviceId)))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .map((d) => ({ ...d }));
    },
    async upsertDevice(record, credentialId, fingerprint): Promise<UpsertResult> {
      const k = key(record.userId, record.deviceId);
      if (revokedDevices.has(k)) return "revoked";
      if (credentialId !== undefined && revokedCredentials.has(key(record.userId, credentialId))) return "credential_revoked";
      const existing = devices.get(k);
      devices.set(
        k,
        existing
          ? { ...existing, hostname: record.hostname, os: record.os, runnerVersion: record.runnerVersion }
          : { ...record },
      );
      if (credentialId !== undefined) {
        const set = credentials.get(k) ?? new Set<string>();
        set.add(credentialId);
        credentials.set(k, set);
        if (fingerprint !== undefined) fingerprints.set(fingerprint, { userId: record.userId, credentialId });
      }
      return "ok";
    },
    async touchLastSeen(userId, deviceId, at, minIntervalMs) {
      const k = key(userId, deviceId);
      const d = devices.get(k);
      if (!d || revokedDevices.has(k)) return false;
      if (Date.parse(d.lastSeen) <= Date.parse(at) - minIntervalMs) {
        d.lastSeen = at;
        return true;
      }
      return false;
    },
    async revokeDevice(userId, deviceId): Promise<RevokeResult | undefined> {
      const k = key(userId, deviceId);
      if (!devices.has(k)) return undefined;
      const alreadyRevoked = revokedDevices.has(k);
      revokedDevices.add(k);
      const ids = [...(credentials.get(k) ?? [])].sort();
      for (const id of ids) revokedCredentials.add(key(userId, id));
      return alreadyRevoked ? { credentialIds: ids, alreadyRevoked: true } : { credentialIds: ids };
    },
    async isRevoked(userId, deviceId) {
      return revokedDevices.has(key(userId, deviceId));
    },
    async isCredentialRevoked(userId, credentialId) {
      return revokedCredentials.has(key(userId, credentialId));
    },
    async revokedCredentialByFingerprint(fingerprint) {
      const found = fingerprints.get(fingerprint);
      return found && revokedCredentials.has(key(found.userId, found.credentialId)) ? { ...found } : undefined;
    },
  };
}
