-- Migration 0009 down: remove W5-02 content catalog tables in dependency order.
BEGIN;
DROP TRIGGER IF EXISTS content_pack_reviews_separation_trg ON content_pack_reviews;
DROP FUNCTION IF EXISTS content_pack_enforce_review_separation();
DROP TABLE IF EXISTS content_pack_rate_windows;
DROP TABLE IF EXISTS content_pack_versions;
DROP TABLE IF EXISTS content_pack_reviews;
DROP TABLE IF EXISTS content_pack_submissions;
COMMIT;
