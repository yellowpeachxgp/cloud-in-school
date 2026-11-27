-- Rollback 0006: remove W4-02 availability and poll tables.
-- DROP ... IF EXISTS keeps the rollback safe to repeat; dependent constraints and indexes drop with tables.
BEGIN;

DROP TABLE IF EXISTS confirmed_group_events;
DROP TABLE IF EXISTS poll_votes;
DROP TABLE IF EXISTS poll_options;
DROP TABLE IF EXISTS meeting_polls;
DROP TABLE IF EXISTS busy_blocks;
DROP TABLE IF EXISTS availability_shares;
DROP INDEX IF EXISTS group_members_member_scope_unique_idx;

COMMIT;
