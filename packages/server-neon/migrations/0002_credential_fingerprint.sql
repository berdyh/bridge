-- Portable schema step, also shipped byte-identically in server-neon/migrations.
-- The lowercase hex SHA-256 of the runner token that last authenticated a credential's hello (never the
-- token), so the relay can give the revoked verdict to a runner whose token the identity provider no longer reports.
-- Rows bound before this migration keep NULL: those credentials are not found and a long-offline runner holding one
-- falls back to the 401 it got before.
ALTER TABLE bridge_device_credentials ADD COLUMN fingerprint TEXT;
CREATE INDEX IF NOT EXISTS bridge_credentials_by_fingerprint ON bridge_device_credentials (fingerprint);
