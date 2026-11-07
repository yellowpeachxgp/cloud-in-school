# Line-audit follow-up: review and rollout requirements

This change is stacked on `fix/review-safety-and-themes` (draft PR #1). It does
not merge, deploy, migrate production, contact a school, or authorize a payment.

## Configuration and session compatibility

The existing `.env.example` is deliberately unchanged in this follow-up: its
publication update was blocked by a safety review. Do not use its old signing-key
reference as resolved key material. Production configuration must be handled
separately by an authorized operator; missing new variables fail closed.


- Production startup now fails closed unless `CLOUD_SESSION_SIGNING_SECRET` and
  `KMS_MASTER_SEED` each contain independently generated, secret-manager-resolved
  random material of at least 32 bytes. `secret://...` references are not key
  material. `CLOUD_SESSION_SIGNING_KEY_REF` is no longer used as a signing key.
- Without explicit configuration, development instances use fresh process-local
  keys. Persistent/restart tests explicitly configure random test keys. Operators
  must keep the resolved production keys stable in approved secret storage.
- This remains a local envelope vault, not an implementation of a remote KMS.
  Existing encrypted records need a planned key migration/key-ring import before
  changing KMS material. Do not rotate a live key merely by deploying this branch.
- Missing/deleted sessions or users are no longer reconstructed from access,
  refresh or browser tokens. Loss of the session store requires login again.
  If prior deployment used published default key material, coordinate key rotation,
  session revocation and credential re-enrolment with the operator first.
- Upstream SSO admin grants are recomputed when profiles/roles are read. Explicit
  local grants set through `setUserRoles` are persisted separately on the user.
  Legacy unlabelled elevated grants fail closed and need deliberate reassignment.
  This does not add realtime SSO demotion webhooks; a new upstream profile is still
  needed before an upstream change is known.
- Browser logout revokes only its existing session family, not school delegation
  or other devices. The legacy GET route remains for compatibility; converting it
  to a CSRF-protected POST is a separate API/UI contract change.

## Gateway and SDK compatibility

- Anonymous authentication limits are server-owned (60/minute/operation). Buckets
  use the transport peer address, never client-selected limit or proxy headers.
  Behind a reverse proxy this intentionally groups clients by proxy IP. Review
  proxy-level per-client throttling and capacity before rollout; no arbitrary
  forwarded-header trust has been added in this patch.
- SDK baseUrl is the origin (a trailing `/api` is tolerated). Mobile OIDC start
  and exchange, wallet, parcels and plugin calls use the current routes.
- `createReservationPlan` and `listReservationOrders` are the supported booking/
  billing methods. The former fictional `createReservationOrder` now throws an
  explicit migration error instead of inventing a client-created financial order.
  `getReservationOrder` filters the authenticated user's order listing.
- Parcel source sandbox overrides cannot bypass production restrictions. Existing
  duplicate parcel records are not destructively deduplicated; the natural-key
  index is rebuilt for future writes. PICKED_UP is terminal under ordinary sync.

## Verification and remaining limits

94 Node tests pass with external fetch/TCP/TLS blocked and only local mock Redis
allowed. Fourteen focused regressions cover config, sessions, logout, demotion,
limiting, Redis timeout FIFO, parcel restart/state/policy, actual rendered parcel
submission, SDK routes, stale cache fills, cookie logout and CSRF compatibility.
Console HTML no longer embeds bearer tokens; browser calls use the existing
HttpOnly same-origin cookie and existing cross-origin mutation checks. Browser
login no longer saves session credentials in localStorage. Contract inventory check covers 88
operations and four schema headers; it is not full JSON-schema proof.

Mobile drawer code is wired with focus cycling, Escape/backdrop closing and a CSS
open state. Browser/device visual QA was not available and remains required.
No real school/wallet behavior, multi-process transaction safety, production
secret migration or deployment readiness is claimed.
