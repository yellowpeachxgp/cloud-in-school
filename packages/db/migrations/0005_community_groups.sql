-- Migration 0005: W4-01 school-scoped community groups, membership periods, and invites
-- Contract CT-01: group type/role lifecycle, QR invite payload, use limits, school isolation,
-- membership-period UUIDs, and immediate sharing withdrawal for non-active members.
BEGIN;

CREATE TABLE IF NOT EXISTS "groups" (
  group_id UUID PRIMARY KEY,
  school_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('study', 'dorm', 'club', 'project')),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 500),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  -- Logical owner reference. Intentionally not a hard FK: account deletion may detach
  -- this field to the documented tombstone without deleting shared group content.
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT groups_archive_shape_check
    CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL)),
  CONSTRAINT groups_group_id_school_id_unique UNIQUE (group_id, school_id)
);

CREATE INDEX IF NOT EXISTS groups_school_status_created_idx
  ON "groups" (school_id, status, created_at, group_id);

CREATE TABLE IF NOT EXISTS group_members (
  member_id UUID PRIMARY KEY,
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  display_name TEXT CHECK (display_name IS NULL OR char_length(display_name) <= 80),
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER')),
  sharing_level TEXT NOT NULL CHECK (sharing_level IN ('NONE', 'BUSY_BLOCKS_30MIN')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'LEFT', 'REMOVED')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ,
  CONSTRAINT group_members_group_scope_fk
    FOREIGN KEY (group_id, school_id)
    REFERENCES "groups" (group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT group_members_lifecycle_shape_check
    CHECK (
      (status = 'ACTIVE' AND left_at IS NULL) OR
      (status IN ('LEFT', 'REMOVED') AND left_at IS NOT NULL)
    ),
  CONSTRAINT group_members_left_sharing_none_check
    CHECK (status = 'ACTIVE' OR sharing_level = 'NONE')
);

-- One user may have many historical membership periods, but at most one ACTIVE
-- period per group. Rejoining therefore always mints a fresh member_id.
CREATE UNIQUE INDEX IF NOT EXISTS group_members_one_active_per_user_idx
  ON group_members (group_id, cloud_user_id)
  WHERE status = 'ACTIVE';

-- Ownership transfer is atomic and exactly one ACTIVE owner exists per group.
CREATE UNIQUE INDEX IF NOT EXISTS group_members_one_active_owner_idx
  ON group_members (group_id)
  WHERE status = 'ACTIVE' AND role = 'OWNER';

CREATE INDEX IF NOT EXISTS group_members_group_active_idx
  ON group_members (group_id, status, joined_at, member_id);
CREATE INDEX IF NOT EXISTS group_members_user_scope_idx
  ON group_members (cloud_user_id, school_id, status);

CREATE TABLE IF NOT EXISTS group_invites (
  invite_id UUID PRIMARY KEY,
  group_id UUID NOT NULL,
  school_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9_-]{8,64}$'),
  qr_payload TEXT NOT NULL UNIQUE CHECK (qr_payload ~ '^dis-group-invite:v1:[A-Za-z0-9_-]{8,64}$'),
  label TEXT CHECK (label IS NULL OR char_length(label) <= 80),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'EXHAUSTED', 'EXPIRED')),
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 1000),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT group_invites_group_scope_fk
    FOREIGN KEY (group_id, school_id)
    REFERENCES "groups" (group_id, school_id)
    ON DELETE CASCADE,
  CONSTRAINT group_invites_qr_matches_code_check
    CHECK (qr_payload = 'dis-group-invite:v1:' || code),
  CONSTRAINT group_invites_used_within_max_check
    CHECK (used_count <= max_uses),
  CONSTRAINT group_invites_revoked_shape_check
    CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS group_invites_group_status_idx
  ON group_invites (group_id, status, expires_at);
CREATE INDEX IF NOT EXISTS group_invites_creator_scope_idx
  ON group_invites (created_by, school_id);

COMMIT;
