# Moments cloud containment (breaking availability change)

Based on main 9d5e69391b56391d0b8344f0cbb615b21a6474fb. This is a fail-closed containment fix, not a completed authorization/ownership implementation or production deployment.

## Risk and decision
Nine Moments extension routes were public: callers could overwrite caller-selected post/book IDs, mutate or delete other records, replace known tag codes, and fetch contacts/report histories in a bulk snapshot. Public claim HTML also disclosed owner contact information. Existing stored rows have no verified tenant/owner attribution, and main has not incorporated the separate session-security remediation. Adding a Bearer label alone would not establish a safe ownership boundary.

All methods under `/api/v1/moments` now return 403/FORBIDDEN before authentication, dispatch, persistence or reads; all `/claim` routes return a uniform 404 without confirming whether a tag exists. There is no enable switch. The original handlers are unreachable behind this prefix-wide guard, including unknown future routes. Existing data is retained but not served; nothing is deleted or rewritten by containment.

## Client contract and interruption
Cloud plaza browsing, ISBN lookup, publishing, comments, social actions, textbook listings, tag management and public finder reporting are unavailable. Even authenticated owners get the same denial. Never label a local draft published, a finder report delivered, or a QR claim page operational after this response. No retry with anonymous auth or direct school/system fallback. Local offline drafts and local ISBN/catalog data remain available without SSO; login is not a requirement for those device-only features. The Android worker has been informed of the exact 403/404 contract.

## Required before reopening
- Integrate audited session authentication and verify active issuer/tenant/client boundaries.
- Attribute records to authenticated owner IDs server-side; enforce owner and tenant checks on every read/write. Unknown legacy ownership must remain quarantined, not claimed from body IDs.
- Minimize public fields and exclude contact information, tag lists and finder reports from public snapshots. Sharing contacts requires explicit scoped user consent.
- Use unguessable, revocable, narrowly scoped public-report capabilities with server-controlled rate limits and response minimization; do not expose owner/finder contacts in claim pages.
- Validate CSRF, replay, update-ID collision, anonymous/cross-user/cross-tenant isolation and migration behavior before removing the guard. A configuration change alone is insufficient.

## Verification and limits
Offline tests exercise all nine endpoints, post/book actions, anonymous and malformed credentials, two users in the same issuer plus a different issuer, known/unknown claim codes, method/path variations, zero persistence, unchanged records and health availability. These tests prove containment, not a usable multi-tenant Moments feature. Existing exposed data cannot be recalled by this code; production exposure assessment and any notifications require separate review. No production systems were contacted, no data migration/deletion performed, and no deployment/merge requested.

## Live school automation containment
The current main provider does not reliably enforce verified school approval at the actual write boundary. As a second containment measure, live-credential booking execution and live cancellation now fail closed, independent of legacy enabled/approver strings. Existing live FIRE tasks stop before submission or ambiguous-result settlement; they are not rolled into new work. RESULT_UNKNOWN remains unknown and must be checked through the official service. Mock execution stays available. Snapshot cancellation no longer converts a thrown cancellation error into a false CANCELLED state.

This interrupts real cloud booking automation and cloud cancellation. Users must use the official school service to check or cancel existing bookings; disabling automation does not release existing seats. Reopening requires verified school authorization and integration of the separately audited execution/finance/session protections, not a runtime flag. Read-only school queries are not disabled by this change.

HTTP transport note: malformed JSON, oversized bodies or transport-level rejection may return 400/413 before the application guard. The application-level 403/404 contract applies to requests that reach dispatch. Android compatibility must be checked on the companion client fix; these server tests do not claim device QA.
