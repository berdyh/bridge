import type { EnrollmentRecord, EnrollmentStore } from "@berdyh/bridge-server";

type Row = { record_json: string };

/**
 * Durable enrollment state for one app's D1 binding (migration 0003). Every operation
 * includes appId even when an app accidentally shares a database. Credentials are
 * encrypted by the enrollment service before they reach this store.
 */
export function createD1EnrollmentStore(db: D1Database): EnrollmentStore {
  const query = (sql: string, ...params: unknown[]) => db.prepare(sql).bind(...params);
  const read = (row: Row | null): EnrollmentRecord | undefined => row ? JSON.parse(row.record_json) as EnrollmentRecord : undefined;
  return {
    async create(record) {
      if (record.revision !== 0) throw new Error("Enrollment must start at revision zero");
      const result = await query(
        "INSERT INTO bridge_enrollments (app_id,id,user_code_hash,revision,cleanup_at,record_json) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT DO NOTHING",
        record.appId, record.id, record.userCodeHash, record.revision, record.cleanupAt, JSON.stringify(record),
      ).run();
      return result.meta.changes === 1;
    },
    async get(appId, id) {
      return read(await query("SELECT record_json FROM bridge_enrollments WHERE app_id=?1 AND id=?2", appId, id).first<Row>());
    },
    async getByUserCodeHash(appId, hash) {
      return read(await query("SELECT record_json FROM bridge_enrollments WHERE app_id=?1 AND user_code_hash=?2", appId, hash).first<Row>());
    },
    async compareAndSet(record, expectedRevision) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || record.revision !== expectedRevision + 1) throw new Error("Enrollment revision must increment by one");
      // Approval codes are immutable. Match their hash too, so a caller cannot move
      // an existing request to another browser's public approval code.
      const result = await query(
        "UPDATE bridge_enrollments SET revision=?4,cleanup_at=?5,record_json=?6 WHERE app_id=?1 AND id=?2 AND user_code_hash=?3 AND revision=?7",
        record.appId, record.id, record.userCodeHash, record.revision, record.cleanupAt, JSON.stringify(record), expectedRevision,
      ).run();
      return result.meta.changes === 1;
    },
    async listExpired(appId, now, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isFinite(now)) throw new Error("Invalid enrollment cleanup range");
      const result = await query("SELECT record_json FROM bridge_enrollments WHERE app_id=?1 AND cleanup_at<=?2 ORDER BY cleanup_at,id LIMIT ?3", appId, now, limit).all<Row>();
      return result.results.map((row) => read(row)!);
    },
    async delete(appId, id, expectedRevision) {
      const result = await query("DELETE FROM bridge_enrollments WHERE app_id=?1 AND id=?2 AND revision=?3", appId, id, expectedRevision).run();
      return result.meta.changes === 1;
    },
  };
}
