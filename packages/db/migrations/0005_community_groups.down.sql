-- Rollback 0005: remove W4-01 community group tables.
-- DROP ... IF EXISTS keeps the rollback safe to repeat; dependent indexes are dropped with tables.
BEGIN;

DROP TABLE IF EXISTS group_invites;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS "groups";

COMMIT;
