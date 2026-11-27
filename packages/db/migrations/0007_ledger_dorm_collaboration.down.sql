-- Rollback 0007: remove W4-03 ledger, settlement, duty, swap, and repair coordination tables.
-- DROP ... IF EXISTS keeps the rollback safe to repeat; dependent indexes are dropped with tables.
BEGIN;

DROP TABLE IF EXISTS repair_reviews;
DROP TABLE IF EXISTS repair_ticket_revisions;
DROP TABLE IF EXISTS repair_tickets;
DROP TABLE IF EXISTS duty_swaps;
DROP TABLE IF EXISTS duty_tasks;
DROP TABLE IF EXISTS duty_rotas;
DROP TABLE IF EXISTS settlements;
DROP TABLE IF EXISTS ledger_balance_revisions;
DROP TABLE IF EXISTS ledger_entry_shares;
DROP TABLE IF EXISTS ledger_entries;

COMMIT;
