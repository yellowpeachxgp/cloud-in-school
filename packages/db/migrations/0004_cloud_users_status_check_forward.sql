-- Migration 0004: Forward upgrade of cloud_users.status CHECK constraint to support 'DELETED' without dropping or truncating existing user rows
BEGIN;

DO $$
DECLARE
  chk RECORD;
BEGIN
  FOR chk IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE rel.relname = 'cloud_users'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I', 'public', 'cloud_users', chk.conname);
  END LOOP;
END $$;

ALTER TABLE cloud_users DROP CONSTRAINT IF EXISTS cloud_users_status_check;
ALTER TABLE cloud_users
  ADD CONSTRAINT cloud_users_status_check
  CHECK (status IN ('ACTIVE', 'DISABLED', 'DELETION_REQUESTED', 'DELETED'));

COMMIT;
