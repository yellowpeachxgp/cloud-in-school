-- Migration 0010: W4-11 ciphertext-only E2EE sync block storage (CT-07)
-- The schema intentionally has no plaintext, plaintext-hash, content-title, content-type,
-- key, key-encryption-key, password, or key-derivation-secret columns.  The only payload
-- bytes are the current padded ciphertext in sync_blob_current; mutation history is metadata-only.
BEGIN;

CREATE TABLE IF NOT EXISTS sync_user_states (
  cloud_user_id UUID PRIMARY KEY REFERENCES cloud_users(id) ON DELETE CASCADE,
  latest_change_sequence BIGINT NOT NULL DEFAULT 0 CHECK (latest_change_sequence >= 0),
  compaction_epoch BIGINT NOT NULL DEFAULT 0 CHECK (compaction_epoch >= 0),
  consent_withdrawn_at TIMESTAMPTZ,
  retention_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sync_user_states_compaction_within_latest_check
    CHECK (compaction_epoch <= latest_change_sequence),
  CONSTRAINT sync_user_states_retention_shape_check
    CHECK ((consent_withdrawn_at IS NULL) = (retention_expires_at IS NULL))
);

CREATE TABLE IF NOT EXISTS sync_devices (
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  session_family_id TEXT NOT NULL,
  consent_id UUID NOT NULL REFERENCES consent_records(id) ON DELETE RESTRICT,
  device_label TEXT CHECK (device_label IS NULL OR char_length(device_label) BETWEEN 1 AND 80),
  platform TEXT NOT NULL CHECK (platform IN ('ANDROID')),
  sync_protocol_version INTEGER NOT NULL CHECK (sync_protocol_version = 1),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT CHECK (revocation_reason IS NULL OR revocation_reason IN ('USER_REMOVED', 'LOST_OR_STOLEN', 'SECURITY_REKEY', 'CONSENT_WITHDRAWN')),
  last_seen_at TIMESTAMPTZ,
  acknowledged_cursor_position BIGINT NOT NULL DEFAULT 0 CHECK (acknowledged_cursor_position >= 0),
  PRIMARY KEY (cloud_user_id, device_id),
  CONSTRAINT sync_devices_revocation_shape_check CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL AND revocation_reason IS NULL) OR
    (status = 'REVOKED' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS sync_devices_user_status_idx
  ON sync_devices (cloud_user_id, status, registered_at, device_id);
CREATE INDEX IF NOT EXISTS sync_devices_session_family_idx
  ON sync_devices (cloud_user_id, session_family_id) WHERE status = 'ACTIVE';

CREATE OR REPLACE FUNCTION sync_enforce_device_quota() RETURNS trigger AS $$
DECLARE
  active_count INTEGER;
  total_count INTEGER;
BEGIN
  SELECT count(*) INTO active_count
    FROM sync_devices
   WHERE cloud_user_id = NEW.cloud_user_id
     AND status = 'ACTIVE'
     AND NOT (cloud_user_id = NEW.cloud_user_id AND device_id = NEW.device_id);
  SELECT count(*) INTO total_count
    FROM sync_devices
   WHERE cloud_user_id = NEW.cloud_user_id
     AND NOT (cloud_user_id = NEW.cloud_user_id AND device_id = NEW.device_id);
  IF NEW.status = 'ACTIVE' AND active_count + 1 > 32 THEN
    RAISE EXCEPTION 'SYNC_QUOTA_EXCEEDED: active device quota 32 exceeded for user'
      USING ERRCODE = '23514';
  END IF;
  IF total_count + 1 > 256 THEN
    RAISE EXCEPTION 'SYNC_QUOTA_EXCEEDED: total device registration quota 256 exceeded for user'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_devices_quota_trg ON sync_devices;
CREATE TRIGGER sync_devices_quota_trg
  BEFORE INSERT OR UPDATE ON sync_devices
  FOR EACH ROW EXECUTE FUNCTION sync_enforce_device_quota();

CREATE TABLE IF NOT EXISTS sync_blob_current (
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  blob_id UUID NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('UPSERT', 'TOMBSTONE')),
  version_vector JSONB NOT NULL CHECK (jsonb_typeof(version_vector) = 'array' AND jsonb_array_length(version_vector) <= 512),
  author_device_id UUID NOT NULL,
  change_sequence BIGINT NOT NULL CHECK (change_sequence >= 1),
  encryption_format TEXT CHECK (encryption_format IS NULL OR encryption_format = 'dis-sync-e2ee/v1'),
  cipher_suite TEXT CHECK (cipher_suite IS NULL OR cipher_suite = 'AES-256-GCM'),
  padding_scheme TEXT CHECK (padding_scheme IS NULL OR padding_scheme = 'DIS_SYNC_SIZE_BUCKETS_POW4_V1'),
  key_id TEXT CHECK (key_id IS NULL OR (char_length(key_id) BETWEEN 8 AND 128 AND key_id ~ '^[A-Za-z0-9._:-]+$')),
  nonce_base64 TEXT CHECK (nonce_base64 IS NULL OR nonce_base64 ~ '^[A-Za-z0-9+/]{16}$'),
  ciphertext BYTEA,
  ciphertext_sha256 TEXT CHECK (ciphertext_sha256 IS NULL OR ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  ciphertext_size_bytes INTEGER CHECK (ciphertext_size_bytes IS NULL OR ciphertext_size_bytes IN (1024, 4096, 16384, 65536, 262144, 1048576)),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cloud_user_id, blob_id),
  UNIQUE (cloud_user_id, change_sequence),
  CONSTRAINT sync_blob_current_author_device_fk
    FOREIGN KEY (cloud_user_id, author_device_id)
    REFERENCES sync_devices (cloud_user_id, device_id)
    ON DELETE RESTRICT,
  CONSTRAINT sync_blob_current_upsert_shape_check CHECK (
    (change_kind = 'UPSERT' AND encryption_format IS NOT NULL AND cipher_suite IS NOT NULL AND padding_scheme IS NOT NULL AND key_id IS NOT NULL AND nonce_base64 IS NOT NULL AND ciphertext IS NOT NULL AND ciphertext_sha256 IS NOT NULL AND ciphertext_size_bytes IS NOT NULL AND octet_length(ciphertext) = ciphertext_size_bytes) OR
    (change_kind = 'TOMBSTONE' AND encryption_format IS NULL AND cipher_suite IS NULL AND padding_scheme IS NULL AND key_id IS NULL AND nonce_base64 IS NULL AND ciphertext IS NULL AND ciphertext_sha256 IS NULL AND ciphertext_size_bytes IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS sync_blob_current_user_live_idx
  ON sync_blob_current (cloud_user_id, change_kind, change_sequence);

CREATE TABLE IF NOT EXISTS sync_blob_mutations (
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  change_sequence BIGINT NOT NULL CHECK (change_sequence >= 1),
  blob_id UUID NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('UPSERT', 'TOMBSTONE')),
  version_vector JSONB NOT NULL CHECK (jsonb_typeof(version_vector) = 'array' AND jsonb_array_length(version_vector) <= 512),
  author_device_id UUID NOT NULL,
  encryption_format TEXT CHECK (encryption_format IS NULL OR encryption_format = 'dis-sync-e2ee/v1'),
  cipher_suite TEXT CHECK (cipher_suite IS NULL OR cipher_suite = 'AES-256-GCM'),
  padding_scheme TEXT CHECK (padding_scheme IS NULL OR padding_scheme = 'DIS_SYNC_SIZE_BUCKETS_POW4_V1'),
  key_id TEXT CHECK (key_id IS NULL OR (char_length(key_id) BETWEEN 8 AND 128 AND key_id ~ '^[A-Za-z0-9._:-]+$')),
  nonce_base64 TEXT CHECK (nonce_base64 IS NULL OR nonce_base64 ~ '^[A-Za-z0-9+/]{16}$'),
  ciphertext_sha256 TEXT CHECK (ciphertext_sha256 IS NULL OR ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  ciphertext_size_bytes INTEGER CHECK (ciphertext_size_bytes IS NULL OR ciphertext_size_bytes IN (1024, 4096, 16384, 65536, 262144, 1048576)),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cloud_user_id, change_sequence),
  CONSTRAINT sync_blob_mutations_blob_fk
    FOREIGN KEY (cloud_user_id, blob_id)
    REFERENCES sync_blob_current (cloud_user_id, blob_id)
    ON DELETE CASCADE,
  CONSTRAINT sync_blob_mutations_author_device_fk
    FOREIGN KEY (cloud_user_id, author_device_id)
    REFERENCES sync_devices (cloud_user_id, device_id)
    ON DELETE RESTRICT,
  CONSTRAINT sync_blob_mutations_shape_check CHECK (
    (change_kind = 'UPSERT' AND encryption_format IS NOT NULL AND cipher_suite IS NOT NULL AND padding_scheme IS NOT NULL AND key_id IS NOT NULL AND nonce_base64 IS NOT NULL AND ciphertext_sha256 IS NOT NULL AND ciphertext_size_bytes IS NOT NULL) OR
    (change_kind = 'TOMBSTONE' AND encryption_format IS NULL AND cipher_suite IS NULL AND padding_scheme IS NULL AND key_id IS NULL AND nonce_base64 IS NULL AND ciphertext_sha256 IS NULL AND ciphertext_size_bytes IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS sync_blob_mutations_user_blob_idx
  ON sync_blob_mutations (cloud_user_id, blob_id, change_sequence);
CREATE INDEX IF NOT EXISTS sync_blob_mutations_compaction_idx
  ON sync_blob_mutations (cloud_user_id, committed_at, change_sequence);

CREATE TABLE IF NOT EXISTS sync_blob_anti_resurrection (
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  blob_id UUID NOT NULL,
  first_tombstone_change_sequence BIGINT NOT NULL CHECK (first_tombstone_change_sequence >= 1),
  tombstoned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cloud_user_id, blob_id)
);

CREATE TABLE IF NOT EXISTS sync_cursors (
  cursor_id UUID PRIMARY KEY,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  position BIGINT NOT NULL CHECK (position >= 0),
  scan_epoch BIGINT NOT NULL CHECK (scan_epoch >= 0),
  scan_mode TEXT NOT NULL CHECK (scan_mode IN ('FULL', 'INCREMENTAL')),
  terminal BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  CONSTRAINT sync_cursors_device_fk
    FOREIGN KEY (cloud_user_id, device_id)
    REFERENCES sync_devices (cloud_user_id, device_id)
    ON DELETE CASCADE,
  CONSTRAINT sync_cursors_position_within_epoch_check
    CHECK (position <= scan_epoch)
);

CREATE INDEX IF NOT EXISTS sync_cursors_device_idx
  ON sync_cursors (cloud_user_id, device_id, created_at);

CREATE TABLE IF NOT EXISTS sync_transfer_usage (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('INGRESS', 'EGRESS')),
  bytes BIGINT NOT NULL CHECK (bytes > 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_transfer_usage_rolling_idx
  ON sync_transfer_usage (cloud_user_id, direction, occurred_at);

CREATE TABLE IF NOT EXISTS sync_rate_windows (
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('READ', 'WRITE')),
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  PRIMARY KEY (cloud_user_id, operation_kind, window_started_at)
);

CREATE OR REPLACE FUNCTION sync_enforce_blob_quota() RETURNS trigger AS $$
DECLARE
  live_count INTEGER;
  live_bytes BIGINT;
BEGIN
  SELECT count(*), coalesce(sum(ciphertext_size_bytes), 0)
    INTO live_count, live_bytes
    FROM sync_blob_current
   WHERE cloud_user_id = NEW.cloud_user_id
     AND change_kind = 'UPSERT'
     AND blob_id <> NEW.blob_id;
  IF NEW.change_kind = 'UPSERT' THEN
    live_count := live_count + 1;
    live_bytes := live_bytes + NEW.ciphertext_size_bytes;
  END IF;
  IF live_count > 4096 THEN
    RAISE EXCEPTION 'SYNC_QUOTA_EXCEEDED: live blob quota 4096 exceeded for user'
      USING ERRCODE = '23514';
  END IF;
  IF live_bytes > 268435456 THEN
    RAISE EXCEPTION 'SYNC_QUOTA_EXCEEDED: live padded ciphertext byte quota 268435456 exceeded for user'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_blob_current_quota_trg ON sync_blob_current;
CREATE TRIGGER sync_blob_current_quota_trg
  BEFORE INSERT OR UPDATE ON sync_blob_current
  FOR EACH ROW EXECUTE FUNCTION sync_enforce_blob_quota();

COMMIT;
