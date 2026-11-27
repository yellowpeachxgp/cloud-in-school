-- Migration 0006: W4-02 privacy-minimizing availability shares, time polls, votes, and confirmed events
-- Contract CT-02: only quantized time blocks are stored; sharing has a bounded TTL;
-- poll options are time windows; confirmation creates exactly one terminal group event.
BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- member_id is already the primary key; this non-partial unique index lets scoped
-- foreign keys prove that a member row also belongs to the claimed group+school.
CREATE UNIQUE INDEX IF NOT EXISTS group_members_member_scope_unique_idx
  ON group_members (member_id, group_id, school_id);

CREATE TABLE IF NOT EXISTS availability_shares (
  member_id UUID PRIMARY KEY,
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'WITHDRAWN', 'EXPIRED')),
  ttl_seconds INTEGER NOT NULL CHECK (ttl_seconds BETWEEN 1800 AND 7776000),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  CONSTRAINT availability_shares_member_scope_fk
    FOREIGN KEY (member_id, group_id, school_id)
    REFERENCES group_members (member_id, group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT availability_shares_group_scope_fk
    FOREIGN KEY (group_id, school_id)
    REFERENCES "groups" (group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT availability_shares_status_shape_check
    CHECK (
      (status = 'ACTIVE' AND withdrawn_at IS NULL AND expired_at IS NULL) OR
      (status = 'WITHDRAWN' AND withdrawn_at IS NOT NULL AND expired_at IS NULL) OR
      (status = 'EXPIRED' AND expired_at IS NOT NULL AND withdrawn_at IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS availability_shares_member_scope_unique_idx
  ON availability_shares (member_id, group_id, school_id);
CREATE INDEX IF NOT EXISTS availability_shares_expiry_idx
  ON availability_shares (status, expires_at);

CREATE TABLE IF NOT EXISTS busy_blocks (
  busy_block_id UUID PRIMARY KEY,
  member_id UUID NOT NULL,
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT busy_blocks_share_scope_fk
    FOREIGN KEY (member_id, group_id, school_id)
    REFERENCES availability_shares (member_id, group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT busy_blocks_time_shape_check
    CHECK (
      end_at > start_at AND
      (end_at - start_at) >= interval '30 minutes' AND
      (extract(epoch from start_at)::numeric % 1800) = 0 AND
      (extract(epoch from end_at)::numeric % 1800) = 0
    ),
  CONSTRAINT busy_blocks_no_overlap_excl
    EXCLUDE USING gist (
      member_id WITH =,
      tstzrange(start_at, end_at, '[)') WITH &&
    )
);

CREATE INDEX IF NOT EXISTS busy_blocks_member_time_idx
  ON busy_blocks (member_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS busy_blocks_group_time_idx
  ON busy_blocks (group_id, school_id, start_at, end_at);

CREATE TABLE IF NOT EXISTS meeting_polls (
  poll_id UUID PRIMARY KEY,
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'CONFIRMED')),
  voting_deadline_at TIMESTAMPTZ NOT NULL,
  created_by_member_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  confirmed_option_id UUID,
  confirmed_event_id UUID,
  CONSTRAINT meeting_polls_group_scope_fk
    FOREIGN KEY (group_id, school_id)
    REFERENCES "groups" (group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT meeting_polls_creator_scope_fk
    FOREIGN KEY (created_by_member_id, group_id, school_id)
    REFERENCES group_members (member_id, group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT meeting_polls_status_shape_check
    CHECK (
      (status = 'OPEN' AND closed_at IS NULL AND confirmed_at IS NULL AND confirmed_option_id IS NULL AND confirmed_event_id IS NULL) OR
      (status = 'CLOSED' AND closed_at IS NOT NULL AND confirmed_at IS NULL AND confirmed_option_id IS NULL AND confirmed_event_id IS NULL) OR
      (status = 'CONFIRMED' AND closed_at IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_option_id IS NOT NULL AND confirmed_event_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS meeting_polls_scope_unique_idx
  ON meeting_polls (poll_id, group_id, school_id);
CREATE INDEX IF NOT EXISTS meeting_polls_group_status_idx
  ON meeting_polls (group_id, school_id, status, voting_deadline_at);

CREATE TABLE IF NOT EXISTS poll_options (
  option_id UUID PRIMARY KEY,
  poll_id UUID NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT poll_options_poll_fk
    FOREIGN KEY (poll_id)
    REFERENCES meeting_polls (poll_id)
    ON DELETE CASCADE,
  CONSTRAINT poll_options_time_shape_check
    CHECK (
      end_at > start_at AND
      (end_at - start_at) >= interval '30 minutes' AND
      (extract(epoch from start_at)::numeric % 1800) = 0 AND
      (extract(epoch from end_at)::numeric % 1800) = 0
    ),
  CONSTRAINT poll_options_exact_window_unique
    UNIQUE (poll_id, start_at, end_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS poll_options_option_poll_unique_idx
  ON poll_options (option_id, poll_id);
CREATE INDEX IF NOT EXISTS poll_options_poll_time_idx
  ON poll_options (poll_id, start_at, end_at);

CREATE TABLE IF NOT EXISTS poll_votes (
  vote_id UUID PRIMARY KEY,
  poll_id UUID NOT NULL,
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  member_id UUID NOT NULL,
  option_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT poll_votes_poll_scope_fk
    FOREIGN KEY (poll_id, group_id, school_id)
    REFERENCES meeting_polls (poll_id, group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT poll_votes_member_scope_fk
    FOREIGN KEY (member_id, group_id, school_id)
    REFERENCES group_members (member_id, group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT poll_votes_option_poll_fk
    FOREIGN KEY (option_id, poll_id)
    REFERENCES poll_options (option_id, poll_id)
    ON DELETE CASCADE,
  CONSTRAINT poll_votes_one_per_member_unique
    UNIQUE (poll_id, member_id),
  CONSTRAINT poll_votes_time_order_check
    CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS poll_votes_option_idx
  ON poll_votes (poll_id, option_id);
CREATE INDEX IF NOT EXISTS poll_votes_member_idx
  ON poll_votes (member_id, poll_id);

CREATE TABLE IF NOT EXISTS confirmed_group_events (
  confirmed_event_id UUID PRIMARY KEY,
  poll_id UUID NOT NULL UNIQUE,
  option_id UUID NOT NULL,
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status = 'CONFIRMED'),
  confirmed_by_member_id UUID NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT confirmed_group_events_poll_scope_fk
    FOREIGN KEY (poll_id, group_id, school_id)
    REFERENCES meeting_polls (poll_id, group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT confirmed_group_events_option_poll_fk
    FOREIGN KEY (option_id, poll_id)
    REFERENCES poll_options (option_id, poll_id)
    ON DELETE CASCADE,
  CONSTRAINT confirmed_group_events_member_scope_fk
    FOREIGN KEY (confirmed_by_member_id, group_id, school_id)
    REFERENCES group_members (member_id, group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT confirmed_group_events_time_shape_check
    CHECK (
      end_at > start_at AND
      (end_at - start_at) >= interval '30 minutes' AND
      (extract(epoch from start_at)::numeric % 1800) = 0 AND
      (extract(epoch from end_at)::numeric % 1800) = 0
    )
);

CREATE INDEX IF NOT EXISTS confirmed_group_events_group_time_idx
  ON confirmed_group_events (group_id, school_id, start_at, end_at);

COMMIT;
