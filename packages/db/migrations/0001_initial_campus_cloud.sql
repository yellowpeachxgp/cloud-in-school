-- Migration 0001: Core Campus Cloud Identity, Vault, Reservations, Finance Saga, Outbox & Audit
BEGIN;

CREATE TABLE IF NOT EXISTS cloud_users (
  id UUID PRIMARY KEY,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','DISABLED','DELETION_REQUESTED','DELETED'))
);

CREATE TABLE IF NOT EXISTS user_identities (
  id UUID PRIMARY KEY,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  UNIQUE(issuer, subject)
);

CREATE TABLE IF NOT EXISTS cloud_device_sessions (
  id UUID PRIMARY KEY,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id),
  device_label TEXT,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  family_id UUID NOT NULL,
  generation BIGINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS school_integrations (
  school_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  capability_status TEXT NOT NULL,
  authorization_evidence_ref TEXT,
  authorization_expires_at TIMESTAMPTZ,
  approver_primary_ref TEXT,
  approver_secondary_ref TEXT,
  max_concurrency INT NOT NULL DEFAULT 0,
  min_request_interval_ms INT NOT NULL DEFAULT 1000,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  kill_switch BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS school_account_bindings (
  id UUID PRIMARY KEY,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id),
  school_id TEXT NOT NULL,
  local_profile_id TEXT,
  subject_hash TEXT,
  masked_student_ref TEXT,
  credential_ref UUID,
  credential_kind TEXT,
  status TEXT NOT NULL,
  consent_version TEXT NOT NULL DEFAULT 'v1',
  verified_at TIMESTAMPTZ,
  credential_expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(cloud_user_id, school_id, local_profile_id)
);

CREATE TABLE IF NOT EXISTS consent_records (
  id UUID PRIMARY KEY,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id),
  school_binding_id UUID REFERENCES school_account_bindings(id),
  purpose TEXT NOT NULL,
  document_version TEXT NOT NULL,
  document_sha256 TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS encrypted_credentials (
  id UUID PRIMARY KEY,
  binding_id UUID NOT NULL REFERENCES school_account_bindings(id),
  secret_type TEXT NOT NULL,
  ciphertext BYTEA NOT NULL,
  nonce BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  wrapped_dek BYTEA NOT NULL,
  kms_key_id TEXT NOT NULL,
  aad_context TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservation_plans (
  id UUID PRIMARY KEY,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id),
  school_binding_id UUID NOT NULL REFERENCES school_account_bindings(id),
  policy_version TEXT NOT NULL,
  price_version TEXT NOT NULL,
  preferences_json JSONB NOT NULL,
  timezone_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservation_jobs (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES reservation_plans(id),
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id),
  school_binding_id UUID NOT NULL REFERENCES school_account_bindings(id),
  school_id TEXT NOT NULL,
  booking_local_date DATE NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL,
  state_version BIGINT NOT NULL DEFAULT 0,
  lock_token BIGINT NOT NULL DEFAULT 0,
  attempt_count INT NOT NULL DEFAULT 0,
  attempt_started_at TIMESTAMPTZ,
  result_verified_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plan_id, booking_local_date)
);

CREATE INDEX IF NOT EXISTS reservation_jobs_due_idx ON reservation_jobs(due_at, state);
CREATE INDEX IF NOT EXISTS reservation_jobs_user_idx ON reservation_jobs(cloud_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reservation_jobs_school_idx ON reservation_jobs(school_id, state, due_at);

CREATE TABLE IF NOT EXISTS school_reservations (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL UNIQUE REFERENCES reservation_jobs(id),
  school_id TEXT NOT NULL,
  external_booking_id TEXT,
  evidence_sha256 TEXT,
  official_status TEXT NOT NULL,
  verified_at TIMESTAMPTZ,
  region_alias TEXT,
  seat_alias TEXT,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  UNIQUE(school_id, external_booking_id)
);

CREATE TABLE IF NOT EXISTS reservation_orders (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL UNIQUE REFERENCES reservation_jobs(id),
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id),
  price_micropeach BIGINT NOT NULL CHECK (price_micropeach >= 0),
  price_version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL,
  school_result TEXT NOT NULL,
  payment_state TEXT NOT NULL,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_operations (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES reservation_orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('DEBIT','REFUND')),
  event_key TEXT NOT NULL UNIQUE,
  amount_micropeach BIGINT NOT NULL CHECK (amount_micropeach > 0),
  status TEXT NOT NULL,
  sso_request_id TEXT,
  sso_event_id TEXT,
  last_error_code TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(order_id, kind)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(created_at) WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS security_audit_events (
  id UUID PRIMARY KEY,
  actor_kind TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  outcome TEXT NOT NULL,
  request_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_notifications (
  id UUID PRIMARY KEY,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_role_bindings (
  id UUID PRIMARY KEY,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id),
  role TEXT NOT NULL,
  school_scope TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(cloud_user_id, role)
);

COMMIT;
