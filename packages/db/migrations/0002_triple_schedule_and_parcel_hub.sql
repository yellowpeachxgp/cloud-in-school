-- Migration 0002: ADR-005 Triple-Schedule Events, ADR-006 Signed Plugin Registry & ADR-007 Parcel Hub
BEGIN;

ALTER TABLE reservation_plans ADD COLUMN IF NOT EXISTS target_local_time TIME NOT NULL DEFAULT '07:00:00';
ALTER TABLE reservation_plans ADD COLUMN IF NOT EXISTS precheck_lead_seconds INTEGER NOT NULL DEFAULT 1800;
ALTER TABLE reservation_plans ADD COLUMN IF NOT EXISTS final_check_lead_seconds INTEGER NOT NULL DEFAULT 300;
ALTER TABLE reservation_plans ADD COLUMN IF NOT EXISTS max_lateness_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reservation_plans ADD COLUMN IF NOT EXISTS rule_revision TEXT NOT NULL DEFAULT 'school-haut-rules-2026-09-03';
ALTER TABLE reservation_plans ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1;

ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS precheck_at TIMESTAMPTZ;
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS final_check_at TIMESTAMPTZ;
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS fire_at TIMESTAMPTZ;
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS policy_revision TEXT;
ALTER TABLE reservation_jobs ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1;

UPDATE reservation_jobs
SET
  fire_at = COALESCE(fire_at, due_at),
  precheck_at = COALESCE(precheck_at, due_at - INTERVAL '30 minutes'),
  final_check_at = COALESCE(final_check_at, due_at - INTERVAL '5 minutes')
WHERE fire_at IS NULL;

CREATE TABLE IF NOT EXISTS booking_schedule_events (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES reservation_jobs(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES reservation_plans(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('PRECHECK','FINAL_CHECK','FIRE')),
  due_at TIMESTAMPTZ NOT NULL,
  actual_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  generation BIGINT NOT NULL DEFAULT 1,
  diagnostic_code TEXT,
  UNIQUE(job_id, kind, generation)
);

CREATE INDEX IF NOT EXISTS booking_schedule_due_idx ON booking_schedule_events(status, due_at);

CREATE TABLE IF NOT EXISTS installed_plugins (
  plugin_id TEXT PRIMARY KEY,
  format TEXT NOT NULL,
  version TEXT NOT NULL,
  publisher TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  manifest_json JSONB NOT NULL,
  previous_manifest_json JSONB,
  signature_base64 TEXT NOT NULL,
  public_key_base64 TEXT NOT NULL,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parcel_source_connections (
  id UUID PRIMARY KEY,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id),
  campus_profile_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  authority_status TEXT NOT NULL,
  auth_state TEXT NOT NULL,
  credential_ref UUID,
  last_sync_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parcels (
  id UUID PRIMARY KEY,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id),
  campus_profile_id TEXT NOT NULL,
  carrier_code TEXT NOT NULL,
  carrier_name TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  tracking_verified BOOLEAN NOT NULL DEFAULT FALSE,
  canonical_status TEXT NOT NULL,
  status_source TEXT NOT NULL,
  pickup_code TEXT,
  pickup_station_id TEXT,
  pickup_station_name TEXT,
  pickup_confidence TEXT,
  product_title TEXT,
  show_product_name BOOLEAN NOT NULL DEFAULT FALSE,
  show_code_on_lockscreen BOOLEAN NOT NULL DEFAULT FALSE,
  track_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sync_state TEXT NOT NULL DEFAULT 'FRESH',
  last_success_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(cloud_user_id, campus_profile_id, carrier_code, tracking_number)
);

CREATE TABLE IF NOT EXISTS parcel_source_observations (
  id UUID PRIMARY KEY,
  parcel_id UUID NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  source_account_ref TEXT,
  confidence TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parcel_tracking_events (
  id UUID PRIMARY KEY,
  parcel_id UUID NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
  occurred_at TIMESTAMPTZ NOT NULL,
  location TEXT,
  description TEXT NOT NULL,
  source_provider TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parcel_sync_jobs (
  id UUID PRIMARY KEY,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id),
  campus_profile_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  accepted_providers JSONB NOT NULL,
  rejected_providers JSONB NOT NULL,
  batches_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
