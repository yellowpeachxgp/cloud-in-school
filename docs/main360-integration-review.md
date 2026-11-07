# Main 36074cd integration review

Scope: entire commit 36074cda3d472ab08eceddce67c659e671a039b7 relative to 9d5e69391b56391d0b8344f0cbb615b21a6474fb, integrated into the prior audited/contained tree. This is not a claim of a fresh full-repository audit.

Preserved upstream changes: admin-only WEB_CONSOLE flow with MOBILE_APP access separate, owner/admin/member role mapping, authenticated encrypted cookie v2, asymmetric OIDC signature checks, readiness minimization, malformed path rejection, server-controlled rate limits, issuer/subject/session/order/user/event indexes, batched scheduler collection, and profile-sync throttling. Moments/public claims and live school writes remain closed.

Safety corrections during integration:
- Keep synchronous checked snapshot persistence, including required=true error handling. A 200 ms unref debounce cannot satisfy durable intent/revocation guarantees, so that optimization is not adopted. flushSnapshotSync remains supported.
- Derived scoped/event/order indexes follow ordinary Map set/delete/clear; reads recheck current record ownership. Compound issuer/subject keys use a JSON tuple, not ambiguous `issuer|subject` concatenation.
- SSO-derived privileges are recomputed, separate from explicitly labelled local grants. Legacy mixed grants do not survive demotion. Subject break-glass grants require an explicitly pinned issuer (adminSsoIssuer option or OIDC_EXPECTED_ISSUER), are dynamic, and disappear when configuration is removed. Unqualified subject-only grants remain disabled.
- Never evict monetary idempotency keys simply because 5000 other operations occurred. Never clear reservation receipts at 2000 records. New keyed creation fails before mutation at capacity, preserving old receipts; operators must reconcile retention/capacity explicitly. Durable distributed retention remains separate work.
- Keep real two-request/two-actor refund approval, not a caller-provided second-approver string. Keep prior active-session/user checks, resolved strong secrets, tombstones, exact booking verification, no repeated ambiguous writes and truthful cancellation.

Compatibility and rollout limits:
- Main's .env.example is retained byte-for-byte with no new configuration content uploaded. The integrated service requires CLOUD_SESSION_SIGNING_SECRET (resolved >=32 bytes); the example's older KEY_REF label is not a usable substitute. Provisioning remains an operator task; missing production material fails closed.
- Old cookies need re-login for v2 and absent-flow legacy sessions fail closed. Ordinary mobile users remain allowed, while console access requires current admin permission by default.
- Trusted forwarded IPs require explicit server configuration and a trusted ingress that strips client headers; default behavior ignores them.
- Legacy synthetic tests use requireAdminAccess:false when testing unrelated service contracts. Dedicated default-setting admin/mobile/cookie tests remain active. Latent live-provider safety tests stub only the hard containment method; separate real-gate tests verify production denial.
- No deployment, production network, real booking/payment, main merge or destructive migration has occurred. Existing exposure, safe Moments reopening, production migration/provisioning, distributed ledger recovery and Android staging remain unverified.

## Profile-sync trailing recovery

The per-user 30-second profile throttle now retains a dirty bit for requests received during a send or throttle window. Each send rebuilds the latest snapshot from authoritative state; concurrent sends for the same user never overlap. Both thrown errors and `{ok:false}` results leave work dirty and schedule a retry after 30 seconds without requiring another request. No failed write is represented as an acknowledged SSO update.

SIGTERM/SIGINT handling stops new HTTP requests and the scanner, waits for current requests/scans, then drains each dirty profile once and closes Redis. A final failed send is logged as a pending count rather than spinning indefinitely. Credentialed active users are resynchronized from restored state on startup, so shutdown failure/process interruption recovers latest state on the next start (not a durable history of every intermediate profile). No guarantee of remote freshness exists while SSO is unavailable or the process remains stopped. Existing source snapshot durability requirements continue to apply. A user without a usable SSO token requires reauthentication; tokens/issuer validation are unchanged.

Offline verification: six deterministic queue/API tests cover throttled/latest payloads, in-flight concurrency, errors/returned failures, shutdown and restart. The API count test stubs reservation creation to isolate profile synchronization; booking safety remains covered by the independent reservation suite. Shutdown queue semantics are tested; OS-signal/process termination is not an end-to-end tested guarantee. Full suite now 140/140 passes; 88-operation contract check passes.
