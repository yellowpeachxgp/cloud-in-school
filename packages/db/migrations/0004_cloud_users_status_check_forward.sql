-- Migration 0004: Forward upgrade of cloud_users.status domain CHECK constraint to support 'DELETED'
-- Targets ONLY current_schema().cloud_users and ONLY single-column status enum-domain CHECK constraints,
-- preserving compound integrity CHECKs (e.g. status + deleted_at), non-domain status CHECKs, other schemas, and existing rows.
-- If a prior confirmed 0004 rollback archived DELETED rows into cloud_users_0004_rollback_audit, reversibly restores status='DELETED' and deleted_at.
BEGIN;

DO $$
DECLARE
  v_schema TEXT := COALESCE(current_schema(), 'public');
  chk RECORD;
BEGIN
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
    'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (status IN (''ACTIVE'', ''DISABLED'', ''DELETION_REQUESTED'', ''DELETED''))',
    v_schema,
    'cloud_users',
    'cloud_users_status_check'
  );

  IF to_regclass(format('%I.%I', v_schema, 'cloud_users_0004_rollback_audit')) IS NOT NULL THEN
    EXECUTE format(
      'UPDATE %I.cloud_users AS u
          SET status = ''DELETED'',
              deleted_at = COALESCE(u.deleted_at, a.original_deleted_at)
         FROM %I.cloud_users_0004_rollback_audit AS a
        WHERE u.id = a.cloud_user_id
          AND u.status = ''DELETION_REQUESTED''',
      v_schema,
      v_schema
    );
    EXECUTE format(
      'DELETE FROM %I.cloud_users_0004_rollback_audit AS a
        USING %I.cloud_users AS u
        WHERE u.id = a.cloud_user_id
          AND u.status = ''DELETED''',
      v_schema,
      v_schema
    );
  END IF;
END $$;

COMMIT;
