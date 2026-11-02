# Campus Cloud Architecture (`SYSTEM_CONTRACT.md` Compliant)

## 1. Domain Boundaries & Trust Zones

- **Zone A (Public Client Edge)**: Android App (`day-in-school`) & Operations Console (`apps/console`).
- **Zone B (Domestic Campus Cloud Core — `103.236.61.117`)**: `apps/api`, `apps/scheduler`, `apps/worker-school`, `packages/db`, `packages/crypto`.
- **Zone C (Isolated Finance Bridge)**: `apps/finance-bridge` & `packages/finance` — the only component authorized to hold `SSO_INTERNAL_SERVICE_KEY` and call XPEACH SSO `/api/v1/users/:uuid/peach/adjust`.
- **Zone D (XPEACH SSO — `40.160.138.219`)**: Unmodified identity provider (`https://sso.xpeach.codes/t/acme`) and 🍑 wallet ledger.

## 2. ADR-005 Triple-Schedule State Machine

For any user-chosen target time `T` within `[07:00:00, 21:30:00)` (`Asia/Shanghai`):
- `PRECHECK` at `T - 30m` (`1800s`): read-only validation of binding, consent, school rules, and wallet balance.
- `FINAL_CHECK` at `T - 5m` (`300s`): read-only quality gate verifying session freshness and kill-switch state.
- `FIRE` at `T`: acquires CAS lock (`state_version`), issues 15-second `CredentialAccessPermit`, submits reservation, performs authoritative readback verification, and triggers post-confirmation debit saga.
