-- Migration 0008 down: remove W4-04 place status tables in dependency order.
BEGIN;
DROP TABLE IF EXISTS place_status_subscriptions;
DROP TABLE IF EXISTS place_report_flags;
DROP TABLE IF EXISTS place_status_view;
DROP TABLE IF EXISTS place_reports;
DROP TABLE IF EXISTS campus_graph_places;
COMMIT;
