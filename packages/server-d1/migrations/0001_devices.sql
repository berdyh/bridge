-- Portable schema, also shipped byte-identically in server-d1/migrations.
-- ISO UTC timestamps sort lexically; callers supply canonical toISOString values.
CREATE TABLE IF NOT EXISTS bridge_devices (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  os TEXT NOT NULL,
  runner_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  PRIMARY KEY (user_id, device_id)
);
CREATE TABLE IF NOT EXISTS bridge_device_credentials (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, credential_id),
  FOREIGN KEY (user_id, device_id) REFERENCES bridge_devices (user_id, device_id)
);
CREATE INDEX IF NOT EXISTS bridge_credentials_by_user ON bridge_device_credentials (user_id, credential_id);
CREATE INDEX IF NOT EXISTS bridge_devices_by_user ON bridge_devices (user_id, revoked, created_at);
