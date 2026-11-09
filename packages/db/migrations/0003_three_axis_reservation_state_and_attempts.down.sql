BEGIN;
DROP INDEX IF EXISTS reservation_attempts_user_idx;
DROP INDEX IF EXISTS reservation_attempts_job_idx;
DROP TABLE IF EXISTS reservation_attempts;

ALTER TABLE reservation_jobs DROP COLUMN IF EXISTS external_booking_id;
ALTER TABLE reservation_jobs DROP COLUMN IF EXISTS confirmed_region_name;
ALTER TABLE reservation_jobs DROP COLUMN IF EXISTS confirmed_seat_name;
ALTER TABLE reservation_jobs DROP COLUMN IF EXISTS confirmed_seat_id;
ALTER TABLE reservation_jobs DROP COLUMN IF EXISTS status_label;
ALTER TABLE reservation_jobs DROP COLUMN IF EXISTS display_status;
ALTER TABLE reservation_jobs DROP COLUMN IF EXISTS billing_state;
ALTER TABLE reservation_jobs DROP COLUMN IF EXISTS school_cancellation_state;
ALTER TABLE reservation_jobs DROP COLUMN IF EXISTS external_execution_state;
ALTER TABLE reservation_jobs DROP COLUMN IF EXISTS user_intent_state;
ALTER TABLE reservation_jobs DROP COLUMN IF EXISTS auth_version;

ALTER TABLE reservation_plans DROP COLUMN IF EXISTS user_intent_state;
ALTER TABLE reservation_plans DROP COLUMN IF EXISTS auth_version;

ALTER TABLE consent_records DROP COLUMN IF EXISTS auth_version;
ALTER TABLE school_account_bindings DROP COLUMN IF EXISTS auth_version;
COMMIT;
