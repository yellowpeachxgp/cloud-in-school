# Integrated audit and snapshot reconciliation

This integration branch merges b4572823b59a444c13a258bbae9d4dd6ff48ae99 and 828c1b3c58abbc4f4dccc964c443b1044376aec4, without updating main or either source branch.

Conflict decisions:
- Keep the prior audited provider's school-scoped dual approval, current authorization checks, durable pre-write target, one write only, no alternate date or retry wave after submission, and strict cancellation readback. The newer main language headers, translated diagnostics and synchronous state persistence remain.
- Require an explicit booking ID from a successful response as well as matching school/binding/date/seat/interval. Missing IDs and uncertain writes stay pending even when an active booking looks similar. This intentionally tightens the older timeout reconciliation test; operator resolution may be necessary instead of automatic settlement.
- Preserve accepted-price/version checks, sandbox/real-money separation, refund dual approval and existing session/authorization fixes.
- Ignore `school_binding_upserts` entirely: background snapshots cannot enrol, reactivate bindings, replace delegated credentials, or grant consent. Clients must use the explicit binding/completion and consent endpoints for those user actions.
- Merge stable client plan IDs and durable per-user cancellation tombstones. A snapshot cannot recreate a known plan or infer new consent. New snapshot plans must include the current explicitly accepted price/version. Alternative seats require explicit true. ID-less legacy entries and snapshots without price acceptance do not create work.
- Keep strict cancellation failures rather than synthesizing CANCELLED after exceptions. Cancellation intent can disable future scheduling without asserting school cancellation success.

The configuration example remains byte-for-byte unchanged. Production secret provisioning described in line-audit-rollout.md remains an operator task. No production school requests, payments, configuration uploads, deployment or main merge were performed.

Validation uses offline synthetic provider stubs and loopback mock Redis; external fetch/TLS/TCP blocked. Branch CI requires a PR or main push and is not implied by local test success.
