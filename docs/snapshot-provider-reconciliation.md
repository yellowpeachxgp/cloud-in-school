# Snapshot and provider reconciliation follow-up

Based on main f689e5b4bd6f33b6ebf5147adb87291ebaff1ef5. This branch does not replace or merge the earlier billing-safety and line-audit branches.

- Preserve language headers, diagnostic translation, explicit rejection retry waves and synchronous persistence introduced on main.
- Successful live writes now require an explicit booking ID and exact school/binding/date/seat/time readback. Missing IDs, mismatches and ambiguous transport outcomes remain RESULT_UNKNOWN and stop further writes. Duplicate errors or unrelated existing bookings cannot become paid successes.
- Snapshot creation requires a stable `plan_id`. Existing server IDs or mapped client IDs are not recreated. Cancellation IDs are retained per user, including cancellations arriving before creation; disabled/deleted/tombstoned entries follow the cancellation path. Client IDs are persisted atomically with plan creation. No new consent is inferred from a reservation snapshot.
- Snapshot clients must use the explicit plan mutation endpoint for edits to an existing plan. ID-less legacy entries are ignored rather than interpreted as new work.
- The two older branches also edit provider/API/reservation code. Do not resolve merge conflicts by taking this entire file over their stricter authorization, durable intent and billing protections. Their strict single-write implementation should remain authoritative; retain the new cancellation/client-ID synchronization logic and language diagnostics deliberately.
- This narrow follow-up is not a claim that unmerged prior findings on main are resolved. No production calls, payments, deployments, config-example uploads or PR creation were performed.

Validation: isolated local Node suite plus contract checker; live provider behavior tested only through synthetic stubs. External fetch/TLS/TCP blocked, loopback mock Redis permitted. Remote CI only triggers on main pushes or PRs, not this branch push.
