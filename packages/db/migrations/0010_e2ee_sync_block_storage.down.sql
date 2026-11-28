-- Migration 0010 down: remove W4-11 ciphertext-only E2EE sync storage.
BEGIN;
DROP TRIGGER IF EXISTS sync_blob_current_quota_trg ON sync_blob_current;
DROP TRIGGER IF EXISTS sync_devices_quota_trg ON sync_devices;
DROP FUNCTION IF EXISTS sync_enforce_blob_quota();
DROP FUNCTION IF EXISTS sync_enforce_device_quota();
DROP TABLE IF EXISTS sync_rate_windows;
DROP TABLE IF EXISTS sync_transfer_usage;
DROP TABLE IF EXISTS sync_cursors;
DROP TABLE IF EXISTS sync_blob_anti_resurrection;
DROP TABLE IF EXISTS sync_blob_mutations;
DROP TABLE IF EXISTS sync_blob_current;
DROP TABLE IF EXISTS sync_devices;
DROP TABLE IF EXISTS sync_user_states;
COMMIT;
