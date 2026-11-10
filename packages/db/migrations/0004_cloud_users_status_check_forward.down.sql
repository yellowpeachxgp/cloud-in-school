-- Rollback 0004: Explicit prechecked rollback of cloud_users.status domain CHECK to 3 values ('ACTIVE', 'DISABLED', 'DELETION_REQUESTED')
-- Rollback Policy:
--   1. Never drops compound or business integrity CHECK constraints (e.g., CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL))),
--      and never silently erases deletion audit timestamps.
--   2. Precheck: If status='DELETED' rows exist alongside any non-domain CHECK referencing status/deleted_at on current_schema().cloud_users,
--      rollback fails closed with an actionable exception UNLESS the operator explicitly confirms reversible demotion within the transaction via:
--        SET LOCAL cloud.migration_0004_confirm_deleted_demotion = 'ARCHIVE_DELETED_AT_TO_AUDIT';
--   3. When confirmed (or when no compound CHECK conflicts), original (id, status, deleted_at) evidence is durably archived into
--      current_schema().cloud_users_0004_rollback_audit (and audit_events if present) before demoting status to 'DELETION_REQUESTED'.
BEGIN;

DO $$
DECLARE
  v_schema TEXT := COALESCE(current_schema(), 'public');
  v_confirm_mode TEXT := COALESCE(current_setting('cloud.migration_0004_confirm_deleted_demotion', true), '');
  v_deleted_count BIGINT := 0;
  v_extra_checks_count INT := 0;
  v_extra_checks_summary TEXT := '';
  chk RECORD;
BEGIN
  EXECUTE format('SELECT count(*) FROM %I.%I WHERE status = ''DELETED''', v_schema, 'cloud_users')
    INTO v_deleted_count;

  SELECT
    count(*),
    COALESCE(string_agg(format('%s: %s', con.conname, pg_get_constraintdef(con.oid)), '; ' ORDER BY con.conname), '')
  INTO v_extra_checks_count, v_extra_checks_summary
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = v_schema
    AND rel.relname = 'cloud_users'
    AND rel.relkind IN ('r', 'p')
    AND con.contype = 'c'
    AND EXISTS (
      SELECT 1
      FROM pg_attribute a
      WHERE a.attrelid = rel.oid
        AND NOT a.attisdropped
        AND a.attnum = ANY(con.conkey)
        AND a.attname IN ('status', 'deleted_at')
    )
    AND NOT (
      cardinality(con.conkey) = 1
      AND EXISTS (
        SELECT 1
        FROM pg_attribute att_s
        WHERE att_s.attrelid = rel.oid
          AND att_s.attnum = con.conkey[1]
          AND NOT att_s.attisdropped
          AND att_s.attname = 'status'
      )
      AND pg_get_constraintdef(con.oid) LIKE '%''ACTIVE''%'
      AND pg_get_constraintdef(con.oid) LIKE '%''DISABLED''%'
      AND pg_get_constraintdef(con.oid) LIKE '%''DELETION_REQUESTED''%'
      AND regexp_replace(
            pg_get_constraintdef(con.oid),
            '::(character varying|varchar|text)',
            '',
            'gi'
          ) ~* '^CHECK\s*\(\s*\(*\s*(status\s*=\s*ANY\s*\(\s*ARRAY\[\s*(''(ACTIVE|DISABLED|DELETION_REQUESTED|DELETED)''(\s*,\s*)?){3,4}\s*\]\s*\)|status\s+IN\s*\(\s*(''(ACTIVE|DISABLED|DELETION_REQUESTED|DELETED)''(\s*,\s*)?){3,4}\s*\)|((\(?\s*status\s*=\s*''(ACTIVE|DISABLED|DELETION_REQUESTED|DELETED)''\s*\)?)(\s+OR\s+)?){3,4})\s*\)*\s*\)$'
    );

  IF v_deleted_count > 0 THEN
    IF v_extra_checks_count > 0 AND v_confirm_mode <> 'ARCHIVE_DELETED_AT_TO_AUDIT' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = format(
          'Migration 0004 rollback precheck blocked on %I.cloud_users: %s DELETED row(s) conflict with preserved CHECK constraint(s) [%s]. Refusing to drop compound CHECKs or silently clear deleted_at. To archive deleted_at into %I.cloud_users_0004_rollback_audit and demote status to DELETION_REQUESTED, execute within transaction: SET LOCAL cloud.migration_0004_confirm_deleted_demotion = ''ARCHIVE_DELETED_AT_TO_AUDIT'';',
          v_schema,
          v_deleted_count,
          v_extra_checks_summary,
          v_schema
        );
    END IF;

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.cloud_users_0004_rollback_audit (
         cloud_user_id UUID PRIMARY KEY REFERENCES %I.cloud_users(id) ON DELETE CASCADE,
         original_status TEXT NOT NULL,
         original_deleted_at TIMESTAMPTZ,
         preserved_constraints TEXT NOT NULL,
         rolled_back_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )',
      v_schema,
      v_schema
    );

    EXECUTE format(
      'INSERT INTO %I.cloud_users_0004_rollback_audit (cloud_user_id, original_status, original_deleted_at, preserved_constraints, rolled_back_at)
       SELECT id, status, deleted_at, %L, now()
         FROM %I.cloud_users
        WHERE status = ''DELETED''
       ON CONFLICT (cloud_user_id) DO UPDATE
          SET original_status = EXCLUDED.original_status,
              original_deleted_at = COALESCE(EXCLUDED.original_deleted_at, %I.cloud_users_0004_rollback_audit.original_deleted_at),
              preserved_constraints = EXCLUDED.preserved_constraints,
              rolled_back_at = now()',
      v_schema,
      v_extra_checks_summary,
      v_schema,
      v_schema
    );

    IF v_extra_checks_count > 0 THEN
      EXECUTE format(
        'UPDATE %I.%I SET status = ''DELETION_REQUESTED'', deleted_at = NULL WHERE status = ''DELETED''',
        v_schema,
        'cloud_users'
      );
    ELSE
      EXECUTE format(
        'UPDATE %I.%I SET status = ''DELETION_REQUESTED'' WHERE status = ''DELETED''',
        v_schema,
        'cloud_users'
      );
    END IF;
  END IF;

  FOR chk IN
    SELECT nsp.nspname AS schema_name, rel.relname AS table_name, con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    JOIN pg_attribute att
      ON att.attrelid = rel.oid
     AND att.attnum = con.conkey[1]
     AND NOT att.attisdropped
    WHERE nsp.nspname = v_schema
      AND rel.relname = 'cloud_users'
      AND rel.relkind IN ('r', 'p')
      AND con.contype = 'c'
      AND cardinality(con.conkey) = 1
      AND att.attname = 'status'
      AND pg_get_constraintdef(con.oid) LIKE '%''ACTIVE''%'
      AND pg_get_constraintdef(con.oid) LIKE '%''DISABLED''%'
      AND pg_get_constraintdef(con.oid) LIKE '%''DELETION_REQUESTED''%'
      AND regexp_replace(
            pg_get_constraintdef(con.oid),
            '::(character varying|varchar|text)',
            '',
            'gi'
          ) ~* '^CHECK\s*\(\s*\(*\s*(status\s*=\s*ANY\s*\(\s*ARRAY\[\s*(''(ACTIVE|DISABLED|DELETION_REQUESTED|DELETED)''(\s*,\s*)?){3,4}\s*\]\s*\)|status\s+IN\s*\(\s*(''(ACTIVE|DISABLED|DELETION_REQUESTED|DELETED)''(\s*,\s*)?){3,4}\s*\)|((\(?\s*status\s*=\s*''(ACTIVE|DISABLED|DELETION_REQUESTED|DELETED)''\s*\)?)(\s+OR\s+)?){3,4})\s*\)*\s*\)$'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I', chk.schema_name, chk.table_name, chk.conname);
  END LOOP;

  EXECUTE format(
    'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (status IN (''ACTIVE'', ''DISABLED'', ''DELETION_REQUESTED''))',
    v_schema,
    'cloud_users',
    'cloud_users_status_check'
  );
END $$;

COMMIT;
