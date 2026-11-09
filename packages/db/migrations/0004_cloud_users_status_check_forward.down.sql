BEGIN;

UPDATE cloud_users
SET status = 'DELETION_REQUESTED'
WHERE status = 'DELETED';

ALTER TABLE cloud_users DROP CONSTRAINT IF EXISTS cloud_users_status_check;
ALTER TABLE cloud_users
  ADD CONSTRAINT cloud_users_status_check
  CHECK (status IN ('ACTIVE', 'DISABLED', 'DELETION_REQUESTED'));

COMMIT;
