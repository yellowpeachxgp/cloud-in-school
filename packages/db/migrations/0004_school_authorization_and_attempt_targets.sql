-- Persist authenticated policy approval workflow and immutable live submission evidence.
-- Runtime in this repository uses CloudDatabaseStore snapshots; SQL deployment is separate.
BEGIN;
ALTER TABLE school_integrations ADD COLUMN IF NOT EXISTS authorization_request JSONB;
ALTER TABLE school_integrations ADD COLUMN IF NOT EXISTS authorization_approval JSONB;
ALTER TABLE school_integrations ALTER COLUMN kill_switch SET DEFAULT TRUE;
-- Existing approvals did not prove two authenticated acts; require fresh approval before writes.
UPDATE school_integrations SET kill_switch = TRUE WHERE authorization_approval IS NULL;
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS submission_target JSONB;
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS pending_external_booking_id TEXT;
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS last_reconcile_at_ms BIGINT;
COMMIT;
