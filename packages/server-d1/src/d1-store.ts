import type { DeviceRecord } from "@berdyh/bridge-protocol";
import type { DeviceStore } from "@berdyh/bridge-server";

type Row = Record<string, unknown>;
const record = (r: Row): DeviceRecord => ({ userId: String(r.user_id), deviceId: String(r.device_id), hostname: String(r.hostname), os: String(r.os), runnerVersion: String(r.runner_version), createdAt: String(r.created_at), lastSeen: String(r.last_seen) });
const revokedCredential = `EXISTS (SELECT 1 FROM bridge_device_credentials c JOIN bridge_devices d USING (user_id,device_id) WHERE c.user_id=?1 AND c.credential_id=?3 AND d.revoked=1)`;

/** How long "migration 0002 is not applied" is trusted before the column is looked for again. */
const COLUMN_RECHECK_MS = 60_000;

/** D1 batches are atomic: registration, credential binding and revocation cannot race. */
export function createD1DeviceStore(db: D1Database): DeviceStore {
  const query = (sql: string, ...params: unknown[]) => db.prepare(sql).bind(...params);
  /**
   * Whether migration 0002 (the `fingerprint` column) is applied. Found once per store instance: a present column is
   * remembered for good, an absent one for `COLUMN_RECHECK_MS` (so applying 0002 later is picked up without a restart),
   * and a failed check counts as absent and is retried on the next call. It never throws, so an unmigrated database
   * (or a failing check) cannot fail a hello: the credential is then bound as before, without a fingerprint. This store
   * has no logger, so it says nothing; the symptom is a long-offline revoked runner getting a 401, not the verdict.
   */
  let columnKnown = false;
  let columnCheckedAt = Number.NEGATIVE_INFINITY;
  const hasFingerprintColumn = async (): Promise<boolean> => {
    if (columnKnown) return true;
    if (Date.now() - columnCheckedAt < COLUMN_RECHECK_MS) return false;
    try {
      const columns = await query("PRAGMA table_info(bridge_device_credentials)").all<Row>();
      columnKnown = columns.results.some((c) => c.name === "fingerprint");
      columnCheckedAt = columnKnown ? columnCheckedAt : Date.now();
    } catch {
      // Retried on the next call.
    }
    return columnKnown;
  };
  return {
    async getDevice(u, d) { const row = await query("SELECT * FROM bridge_devices WHERE user_id=?1 AND device_id=?2 AND revoked=0", u, d).first<Row>(); return row ? record(row) : undefined; },
    async listDevices(u) { return (await query("SELECT * FROM bridge_devices WHERE user_id=?1 AND revoked=0 ORDER BY created_at DESC,device_id", u).all<Row>()).results.map(record); },
    async upsertDevice(r, credentialId, fingerprint) {
      const writeFingerprint = fingerprint !== undefined && credentialId !== undefined && (await hasFingerprintColumn());
      const statements = [
        query(`INSERT INTO bridge_devices (user_id,device_id,hostname,os,runner_version,created_at,last_seen) SELECT ?1,?2,?4,?5,?6,?7,?8 WHERE NOT ${revokedCredential} ON CONFLICT (user_id,device_id) DO UPDATE SET hostname=excluded.hostname,os=excluded.os,runner_version=excluded.runner_version WHERE bridge_devices.revoked=0`, r.userId, r.deviceId, credentialId ?? null, r.hostname, r.os, r.runnerVersion, r.createdAt, r.lastSeen),
        query(`INSERT INTO bridge_device_credentials (user_id,device_id,credential_id) SELECT ?1,?2,?3 WHERE ?3 IS NOT NULL AND EXISTS (SELECT 1 FROM bridge_devices WHERE user_id=?1 AND device_id=?2 AND revoked=0) AND NOT ${revokedCredential} ON CONFLICT DO NOTHING`, r.userId, r.deviceId, credentialId ?? null),
        query(`SELECT EXISTS (SELECT 1 FROM bridge_devices WHERE user_id=?1 AND device_id=?2 AND revoked=1) AS revoked, ${revokedCredential} AS credential_revoked`, r.userId, r.deviceId, credentialId ?? null),
      ];
      // After the status read, so its place in the results does not move. Only the hash of the token is written, and only
      // while the device is live (a revoked device keeps the fingerprint it had). Needs migration 0002.
      if (writeFingerprint) {
        statements.push(query(`UPDATE bridge_device_credentials SET fingerprint=?4 WHERE user_id=?1 AND device_id=?2 AND credential_id=?3 AND EXISTS (SELECT 1 FROM bridge_devices WHERE user_id=?1 AND device_id=?2 AND revoked=0)`, r.userId, r.deviceId, credentialId, fingerprint));
      }
      const results = await db.batch<Row>(statements);
      const status = results[2]!.results[0]!;
      return status.revoked ? "revoked" : status.credential_revoked ? "credential_revoked" : "ok";
    },
    async touchLastSeen(u, d, at, ms) {
      const result = await query("UPDATE bridge_devices SET last_seen=?3 WHERE user_id=?1 AND device_id=?2 AND revoked=0 AND last_seen<=?4", u, d, at, new Date(Date.parse(at) - ms).toISOString()).run();
      return result.meta.changes > 0;
    },
    async revokeDevice(u, d) {
      const results = await db.batch<Row>([
        query("UPDATE bridge_devices SET revoked=1 WHERE user_id=?1 AND device_id=?2 AND revoked=0", u, d),
        query("SELECT credential_id FROM bridge_device_credentials WHERE user_id=?1 AND device_id=?2 ORDER BY credential_id", u, d),
        query("SELECT 1 AS known FROM bridge_devices WHERE user_id=?1 AND device_id=?2", u, d),
      ]);
      if (!results[2]!.results.length) return undefined;
      const credentialIds = results[1]!.results.map((r) => String(r.credential_id));
      return results[0]!.meta.changes ? { credentialIds } : { credentialIds, alreadyRevoked: true };
    },
    async isRevoked(u, d) { return !!(await query("SELECT 1 FROM bridge_devices WHERE user_id=?1 AND device_id=?2 AND revoked=1", u, d).first()); },
    async revokedCredentialByFingerprint(fingerprint) {
      if (!(await hasFingerprintColumn())) return undefined;
      const row = await query("SELECT c.user_id, c.credential_id FROM bridge_device_credentials c JOIN bridge_devices d USING (user_id,device_id) WHERE c.fingerprint=?1 AND d.revoked=1 LIMIT 1", fingerprint).first<Row>();
      return row ? { userId: String(row.user_id), credentialId: String(row.credential_id) } : undefined;
    },
    async isCredentialRevoked(u, c) { return !!(await query("SELECT 1 FROM bridge_device_credentials c JOIN bridge_devices d USING (user_id,device_id) WHERE c.user_id=?1 AND c.credential_id=?2 AND d.revoked=1 LIMIT 1", u, c).first()); },
  };
}
