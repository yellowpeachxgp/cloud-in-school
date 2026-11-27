-- Migration 0007: W4-03 append-only group ledger, two-party settlements, dorm duty rotations, swaps, and informal repair coordination
-- Contract CT-03: integer-fen accounting only (never payment execution), correction chains,
-- deterministic server-side duty projections, audited swaps, and non-official repair records.
BEGIN;

CREATE TABLE IF NOT EXISTS ledger_entries (
  entry_id UUID PRIMARY KEY,
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('EXPENSE', 'REFUND', 'CORRECTION')),
  corrects_entry_id UUID REFERENCES ledger_entries(entry_id) ON DELETE RESTRICT,
  correction_reason TEXT CHECK (correction_reason IS NULL OR char_length(correction_reason) BETWEEN 1 AND 240),
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  amount_fen BIGINT NOT NULL CHECK (amount_fen <> 0),
  -- Membership-period ids are logical references. They are intentionally not hard FKs:
  -- account erasure removes identifying membership rows while append-only group audit rows
  -- may retain the already-pseudonymous participant ref required for zero-sum reconciliation.
  paid_by_member_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  split_rule_json JSONB NOT NULL,
  created_by_member_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entries_group_scope_fk
    FOREIGN KEY (group_id, school_id)
    REFERENCES "groups" (group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT ledger_entries_correction_shape_check
    CHECK (
      (entry_kind = 'CORRECTION' AND corrects_entry_id IS NOT NULL AND correction_reason IS NOT NULL) OR
      (entry_kind IN ('EXPENSE', 'REFUND') AND corrects_entry_id IS NULL AND correction_reason IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS ledger_entries_group_created_idx
  ON ledger_entries (group_id, created_at DESC, entry_id);
CREATE INDEX IF NOT EXISTS ledger_entries_corrects_idx
  ON ledger_entries (corrects_entry_id) WHERE corrects_entry_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ledger_entry_shares (
  entry_id UUID NOT NULL REFERENCES ledger_entries(entry_id) ON DELETE CASCADE,
  participant_member_id UUID NOT NULL,
  amount_fen BIGINT NOT NULL,
  PRIMARY KEY (entry_id, participant_member_id)
);

CREATE INDEX IF NOT EXISTS ledger_entry_shares_participant_idx
  ON ledger_entry_shares (participant_member_id);

CREATE TABLE IF NOT EXISTS ledger_balance_revisions (
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  balance_revision BIGINT NOT NULL DEFAULT 0 CHECK (balance_revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, school_id),
  CONSTRAINT ledger_balance_revisions_group_scope_fk
    FOREIGN KEY (group_id, school_id)
    REFERENCES "groups" (group_id, school_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settlements (
  settlement_id UUID PRIMARY KEY,
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  debtor_member_id UUID NOT NULL,
  creditor_member_id UUID NOT NULL,
  amount_fen BIGINT NOT NULL CHECK (amount_fen > 0),
  basis_balance_revision BIGINT NOT NULL CHECK (basis_balance_revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING_BOTH_CONFIRMATIONS', 'PENDING_DEBTOR_CONFIRMATION', 'PENDING_CREDITOR_CONFIRMATION', 'CONFIRMED', 'CANCELLED')),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 240),
  created_by_member_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  debtor_confirmed_at TIMESTAMPTZ,
  creditor_confirmed_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancelled_by_party TEXT CHECK (cancelled_by_party IS NULL OR cancelled_by_party IN ('DEBTOR', 'CREDITOR')),
  cancelled_by_member_id UUID,
  CONSTRAINT settlements_group_scope_fk
    FOREIGN KEY (group_id, school_id)
    REFERENCES "groups" (group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT settlements_distinct_parties_check
    CHECK (debtor_member_id <> creditor_member_id),
  CONSTRAINT settlements_status_shape_check
    CHECK (
      (status = 'PENDING_BOTH_CONFIRMATIONS' AND debtor_confirmed_at IS NULL AND creditor_confirmed_at IS NULL AND confirmed_at IS NULL AND cancelled_at IS NULL AND cancelled_by_party IS NULL AND cancelled_by_member_id IS NULL) OR
      (status = 'PENDING_DEBTOR_CONFIRMATION' AND debtor_confirmed_at IS NULL AND creditor_confirmed_at IS NOT NULL AND confirmed_at IS NULL AND cancelled_at IS NULL AND cancelled_by_party IS NULL AND cancelled_by_member_id IS NULL) OR
      (status = 'PENDING_CREDITOR_CONFIRMATION' AND debtor_confirmed_at IS NOT NULL AND creditor_confirmed_at IS NULL AND confirmed_at IS NULL AND cancelled_at IS NULL AND cancelled_by_party IS NULL AND cancelled_by_member_id IS NULL) OR
      (status = 'CONFIRMED' AND debtor_confirmed_at IS NOT NULL AND creditor_confirmed_at IS NOT NULL AND confirmed_at IS NOT NULL AND cancelled_at IS NULL AND cancelled_by_party IS NULL AND cancelled_by_member_id IS NULL) OR
      (status = 'CANCELLED' AND confirmed_at IS NULL AND cancelled_at IS NOT NULL AND cancelled_by_party IS NOT NULL AND cancelled_by_member_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS settlements_group_created_idx
  ON settlements (group_id, created_at DESC, settlement_id);
CREATE INDEX IF NOT EXISTS settlements_party_idx
  ON settlements (debtor_member_id, creditor_member_id);

CREATE TABLE IF NOT EXISTS duty_rotas (
  rota_id UUID PRIMARY KEY,
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 80),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 500),
  rotation_member_ids JSONB NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('DAILY', 'WEEKLY')),
  days_of_week JSONB NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  time_zone TEXT NOT NULL,
  generate_weeks_ahead INTEGER NOT NULL CHECK (generate_weeks_ahead BETWEEN 1 AND 12),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
  next_rotation_index BIGINT NOT NULL DEFAULT 0 CHECK (next_rotation_index >= 0),
  generated_through_date DATE,
  created_by_member_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT duty_rotas_group_scope_fk
    FOREIGN KEY (group_id, school_id)
    REFERENCES "groups" (group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT duty_rotas_rotation_shape_check
    CHECK (jsonb_typeof(rotation_member_ids) = 'array' AND jsonb_array_length(rotation_member_ids) BETWEEN 2 AND 100),
  CONSTRAINT duty_rotas_days_shape_check
    CHECK (jsonb_typeof(days_of_week) = 'array' AND jsonb_array_length(days_of_week) <= 7),
  CONSTRAINT duty_rotas_weekly_days_check
    CHECK (frequency <> 'WEEKLY' OR jsonb_array_length(days_of_week) > 0),
  CONSTRAINT duty_rotas_dates_check
    CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT duty_rotas_rota_scope_unique UNIQUE (rota_id, school_id)
);

CREATE INDEX IF NOT EXISTS duty_rotas_group_created_idx
  ON duty_rotas (group_id, created_at DESC, rota_id);

CREATE TABLE IF NOT EXISTS duty_tasks (
  task_id UUID PRIMARY KEY,
  rota_id UUID NOT NULL REFERENCES duty_rotas(rota_id) ON DELETE CASCADE,
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 80),
  assigned_member_id UUID NOT NULL,
  due_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'CONFIRMED', 'SKIPPED')),
  completion_note TEXT CHECK (completion_note IS NULL OR char_length(completion_note) <= 240),
  completed_at TIMESTAMPTZ,
  completed_by_member_id UUID,
  confirmation_note TEXT CHECK (confirmation_note IS NULL OR char_length(confirmation_note) <= 240),
  confirmed_at TIMESTAMPTZ,
  confirmed_by_member_id UUID,
  skip_reason TEXT CHECK (skip_reason IS NULL OR char_length(skip_reason) BETWEEN 1 AND 240),
  skipped_at TIMESTAMPTZ,
  skipped_by_member_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT duty_tasks_group_scope_fk
    FOREIGN KEY (group_id, school_id)
    REFERENCES "groups" (group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT duty_tasks_rota_scope_fk
    FOREIGN KEY (rota_id, school_id)
    REFERENCES duty_rotas (rota_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT duty_tasks_status_shape_check
    CHECK (
      (status = 'PENDING' AND completed_at IS NULL AND completed_by_member_id IS NULL AND confirmed_at IS NULL AND confirmed_by_member_id IS NULL AND skip_reason IS NULL AND skipped_at IS NULL AND skipped_by_member_id IS NULL) OR
      (status = 'COMPLETED' AND completed_at IS NOT NULL AND completed_by_member_id IS NOT NULL AND confirmed_at IS NULL AND confirmed_by_member_id IS NULL AND skip_reason IS NULL AND skipped_at IS NULL AND skipped_by_member_id IS NULL) OR
      (status = 'CONFIRMED' AND completed_at IS NOT NULL AND completed_by_member_id IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_by_member_id IS NOT NULL AND skip_reason IS NULL AND skipped_at IS NULL AND skipped_by_member_id IS NULL) OR
      (status = 'SKIPPED' AND completed_at IS NULL AND completed_by_member_id IS NULL AND confirmed_at IS NULL AND confirmed_by_member_id IS NULL AND skip_reason IS NOT NULL AND skipped_at IS NOT NULL AND skipped_by_member_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS duty_tasks_group_due_idx
  ON duty_tasks (group_id, due_date, task_id);
CREATE INDEX IF NOT EXISTS duty_tasks_assignee_idx
  ON duty_tasks (assigned_member_id, status, due_date);

CREATE TABLE IF NOT EXISTS duty_swaps (
  swap_id UUID PRIMARY KEY,
  rota_id UUID NOT NULL REFERENCES duty_rotas(rota_id) ON DELETE CASCADE,
  duty_task_id UUID NOT NULL REFERENCES duty_tasks(task_id) ON DELETE CASCADE,
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('SWAP', 'COVER')),
  requested_by_member_id UUID NOT NULL,
  target_member_id UUID NOT NULL,
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 240),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED')),
  resolution_note TEXT CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 240),
  resolved_by_member_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT duty_swaps_group_scope_fk
    FOREIGN KEY (group_id, school_id)
    REFERENCES "groups" (group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT duty_swaps_rota_scope_fk
    FOREIGN KEY (rota_id, school_id)
    REFERENCES duty_rotas (rota_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT duty_swaps_status_shape_check
    CHECK (
      (status = 'PENDING' AND resolved_at IS NULL AND resolved_by_member_id IS NULL) OR
      (status IN ('ACCEPTED', 'REJECTED', 'CANCELLED') AND resolved_at IS NOT NULL AND resolved_by_member_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS duty_swaps_rota_created_idx
  ON duty_swaps (rota_id, created_at DESC, swap_id);
CREATE INDEX IF NOT EXISTS duty_swaps_task_idx
  ON duty_swaps (duty_task_id, status);

CREATE TABLE IF NOT EXISTS repair_tickets (
  repair_id UUID PRIMARY KEY,
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  category TEXT NOT NULL CHECK (category IN ('PLUMBING', 'ELECTRICAL', 'FURNITURE', 'NETWORK', 'CLEANING', 'SAFETY', 'OTHER')),
  location_text TEXT NOT NULL CHECK (char_length(btrim(location_text)) BETWEEN 1 AND 120),
  description TEXT NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 2000),
  reporter_member_id UUID NOT NULL,
  assigned_member_id UUID,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED', 'CLOSED')),
  status_revision BIGINT NOT NULL DEFAULT 1 CHECK (status_revision >= 1),
  resolution_note TEXT CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500),
  review_id UUID,
  official_work_order BOOLEAN NOT NULL DEFAULT FALSE CHECK (official_work_order = FALSE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  triaged_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  CONSTRAINT repair_tickets_group_scope_fk
    FOREIGN KEY (group_id, school_id)
    REFERENCES "groups" (group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT repair_tickets_closed_shape_check
    CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL)),
  CONSTRAINT repair_tickets_rejected_shape_check
    CHECK ((status = 'REJECTED') = (rejected_at IS NOT NULL)),
  CONSTRAINT repair_tickets_resolved_shape_check
    CHECK ((status IN ('RESOLVED', 'CLOSED')) = (resolved_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS repair_tickets_group_created_idx
  ON repair_tickets (group_id, created_at DESC, repair_id);
CREATE INDEX IF NOT EXISTS repair_tickets_reporter_idx
  ON repair_tickets (reporter_member_id, status);

CREATE TABLE IF NOT EXISTS repair_ticket_revisions (
  revision_id UUID PRIMARY KEY,
  repair_id UUID NOT NULL REFERENCES repair_tickets(repair_id) ON DELETE CASCADE,
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  editor_member_id UUID NOT NULL,
  before_json JSONB NOT NULL,
  after_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT repair_ticket_revisions_group_scope_fk
    FOREIGN KEY (group_id, school_id)
    REFERENCES "groups" (group_id, school_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS repair_ticket_revisions_repair_idx
  ON repair_ticket_revisions (repair_id, created_at, revision_id);

CREATE TABLE IF NOT EXISTS repair_reviews (
  review_id UUID PRIMARY KEY,
  repair_id UUID NOT NULL UNIQUE REFERENCES repair_tickets(repair_id) ON DELETE CASCADE,
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  reviewer_member_id UUID NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT CHECK (comment IS NULL OR char_length(comment) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT repair_reviews_group_scope_fk
    FOREIGN KEY (group_id, school_id)
    REFERENCES "groups" (group_id, school_id)
    ON DELETE CASCADE
);

COMMIT;
