ALTER TABLE reservation_orders DROP COLUMN IF EXISTS refunded_at;
ALTER TABLE reservation_orders DROP COLUMN IF EXISTS refunded_micropeach;
ALTER TABLE reservation_orders DROP COLUMN IF EXISTS refund_request;
ALTER TABLE reservation_plans DROP COLUMN IF EXISTS price_accepted_at;
ALTER TABLE reservation_plans DROP COLUMN IF EXISTS price_micropeach;
