-- Preserve authorization/attempt evidence on rollback. Removing it could enable a duplicate
-- write or lose the ability to resolve an uncertain school result. Roll back application
-- behavior only with all school writes disabled.
BEGIN;
UPDATE school_integrations SET kill_switch = TRUE;
COMMIT;
