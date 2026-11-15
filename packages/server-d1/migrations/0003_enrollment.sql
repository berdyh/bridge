-- Optional: apply only when mounting the reusable runner-enrollment API.
-- The credential delivery payload is encrypted by the app's EnrollmentCipher.
CREATE TABLE IF NOT EXISTS bridge_enrollments (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  user_code_hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  cleanup_at INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  UNIQUE (app_id, user_code_hash)
);
CREATE INDEX IF NOT EXISTS bridge_enrollments_cleanup ON bridge_enrollments (app_id, cleanup_at, id);
