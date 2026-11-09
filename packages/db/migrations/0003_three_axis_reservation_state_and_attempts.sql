-- Migration 0003: Three-Axis Reservation State Model, Authorization Provenance & Persistent Execution Attempts
BEGIN;

ALTER TABLE school_account_bindings ADD COLUMN IF NOT EXISTS auth_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE consent_records ADD COLUMN IF NOT EXISTS auth_version BIGINT NOT NULL DEFAULT 1;

ALTER TABLE reservation_plans ADD COLUMN IF NOT EXISTS auth_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE reservation_plans ADD COLUMN IF NOT EXISTS user_intent_state TEXT NOT NULL DEFAULT 'ACTIVE'
  CHECK (user_intent_state IN ('ACTIVE', 'STOP_REQUESTED', 'REVOKED', 'NEEDS_RECONFIRMATION'));

ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS auth_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS user_intent_state TEXT NOT NULL DEFAULT 'ACTIVE'
  CHECK (user_intent_state IN ('ACTIVE', 'STOP_REQUESTED', 'REVOKED', 'NEEDS_RECONFIRMATION'));
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS external_execution_state TEXT NOT NULL DEFAULT 'NOT_DISPATCHED'
  CHECK (external_execution_state IN ('NOT_DISPATCHED', 'DISPATCH_INTENT', 'RESULT_UNKNOWN', 'SCHOOL_CONFIRMED', 'SCHOOL_REJECTED'));
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS school_cancellation_state TEXT NOT NULL DEFAULT 'NOT_REQUESTED'
  CHECK (school_cancellation_state IN ('NOT_REQUESTED', 'CANCEL_IN_PROGRESS', 'CANCEL_RESULT_UNKNOWN', 'SCHOOL_CANCELLED', 'MANUAL_ACTION_REQUIRED'));
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS billing_state TEXT NOT NULL DEFAULT 'NOT_BILLED';
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS display_status TEXT NOT NULL DEFAULT 'ARMED';
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS status_label TEXT NOT NULL DEFAULT '委托待执行';
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS confirmed_seat_id TEXT;
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS confirmed_seat_name TEXT;
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS confirmed_region_name TEXT;
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS external_booking_id TEXT;

CREATE TABLE IF NOT EXISTS reservation_attempts (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES reservation_jobs(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES reservation_plans(id) ON DELETE CASCADE,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id),
  school_id TEXT NOT NULL,
  student_no TEXT NOT NULL,
  binding_id UUID NOT NULL,
  consent_id UUID NOT NULL,
  auth_version BIGINT NOT NULL,
  target_local_date TEXT NOT NULL,
  slot_window TEXT NOT NULL,
  candidate_seat_id TEXT NOT NULL,
  candidate_seat_name TEXT,
  candidate_region_name TEXT,
  external_execution_state TEXT NOT NULL CHECK (external_execution_state IN ('DISPATCH_INTENT', 'RESULT_UNKNOWN', 'SCHOOL_CONFIRMED', 'SCHOOL_REJECTED')),
  user_intent_state_at_dispatch TEXT NOT NULL,
  user_intent_state_at_completion TEXT,
  dispatch_intent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  external_booking_id TEXT,
  raw_response_code TEXT,
  raw_response_msg TEXT,
  readback_verified BOOLEAN NOT NULL DEFAULT FALSE,
  readback_evidence JSONB,
  billing_order_id UUID,
  billing_state TEXT NOT NULL DEFAULT 'NOT_BILLED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reservation_attempts_job_idx ON reservation_attempts(job_id);
CREATE INDEX IF NOT EXISTS reservation_attempts_user_idx ON reservation_attempts(cloud_user_id);

COMMIT;
