# Billing safety and client migration

## Price acceptance

Clients must fetch `GET /api/v1/pricing/library-booking` and show the quote before submitting a plan. Send `accepted_price_version` and `accepted_price_micropeach` matching the displayed quote. Missing, stale or changed quotes return 409. The default price is **1 🍑 = 10,000 micropeach** per confirmed reservation. The concurrency fixture's 1,000-micropeach order is a test amount, not the default.

Each accepted plan stores its amount, quote version and acceptance time. Settlement and recurring jobs use that snapshot, not the latest global price. Zero-price quotes remain free. Existing plans without a recorded accepted amount cannot be safely backfilled from today's price; obtain fresh acceptance by creating a new plan before further execution. Existing orders retain their own saved amount.

## Two-person refunds

Both refund routes use the same two-step service and require `FINANCE_OPERATOR` or `PLATFORM_OWNER`:

1. Operator A requests a refund. The standard `/refund` route takes `amount_micropeach` and `reason`; `/quick-refund` starts a full refund. A 202 response contains `refund_request.id`, the exact amount/reason, requester and pending status. No money moves.
2. A different authenticated operator B reviews the saved request and submits its `refund_request_id`. Standard `/refund` must also repeat the exact amount and reason. The console's approval button uses the saved request. Both operators must still have the finance role.
3. Only an explicit successful bridge result changes the order to `REFUNDED`. Failed or malformed responses leave it `PAID` and record a retryable failure. The same second approver can retry the same immutable proposal. The response includes `refunded_micropeach`, including partial refunds.

Caller-supplied `second_approver_ref` is no longer approval. The initiating operator cannot approve their own request. Approval data persists with the order snapshot. Real-wallet requests and adjustments require successful durable snapshot writes; missing storage, a failed write or an unconfirmed save prevents the wallet call. One refund operation per order remains the existing model; partial refund marks that refund terminal.

## Live payments and limits

`FINANCE_ENABLE_REAL_DEBITS=true` is required to enable real wallet adjustments (debits and refunds). A service key alone does not enable writes. An explicit constructor `realDebitsEnabled: false` also disables them. Real users cannot be marked paid using a synthetic fallback when writes are disabled. A real debit also requires an `AUTHORIZED_AUTOMATION` job with verified non-mock school evidence; mock-only jobs cannot debit a real wallet, including through manual reconciliation.

Tests use synthetic accounts and stubbed HTTP. Run `node --import ./tests/helpers/block-network.mjs --test tests/*.test.mjs` to block external fetch/TCP/TLS, allowing only the local mock Redis fixture, then `npm run contract:check`.

The application still uses snapshot storage and process-local order locks. Multi-process transactions, crash-safe wallet reconciliation and upstream idempotency guarantees require independent integration verification; these local regressions do not establish them. Reconciliation of existing unpaid orders is manual through the authenticated admin reconcile endpoint. No production transactions or database deployment are part of these changes.
