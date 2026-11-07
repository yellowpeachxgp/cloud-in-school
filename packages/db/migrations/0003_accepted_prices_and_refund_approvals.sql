-- No backfill from current pricing: legacy plans must obtain fresh price acceptance.
ALTER TABLE reservation_plans ADD COLUMN IF NOT EXISTS price_micropeach BIGINT CHECK (price_micropeach >= 0);
ALTER TABLE reservation_plans ADD COLUMN IF NOT EXISTS price_accepted_at TIMESTAMPTZ;
-- Two authenticated operators approve the same immutable refund proposal.
ALTER TABLE reservation_orders ADD COLUMN IF NOT EXISTS refund_request JSONB;
ALTER TABLE reservation_orders ADD COLUMN IF NOT EXISTS refunded_micropeach BIGINT CHECK (refunded_micropeach > 0);
ALTER TABLE reservation_orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
