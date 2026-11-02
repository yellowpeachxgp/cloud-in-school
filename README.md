# Cloud in School (`cloud-in-school`)

Domestic Campus Cloud Backend, XPEACH SSO Confidential Web BFF, ADR-005 Dynamic Target `T` (`T-30m / T-5m / T`) Triple-Schedule Library Reservation Engine, Parcel Hub Multi-Source Express Aggregation API, Sandboxed Plugin Ecosystem (`dis-extension/v2`), and Operations Console for **Day in School (日在校园)**.

## Architecture & Core Subsystems

1. **Contract-First API (`contracts/openapi/cloud-v1.yaml`)**: 66 OpenAPI 3.1.2 operations with 100% bidirectional route parity (`contracts/endpoints/endpoint-inventory.yaml`).
2. **Confidential Web OIDC BFF (`packages/identity`)**: Zero modification to XPEACH SSO (`https://sso.xpeach.codes/t/acme/.well-known/openid-configuration`). Implements S256 PKCE, single-use `app_ticket` (`<= 60s` TTL), and Refresh Token Family rotation with replay detection (`SESSION_REPLAY_DETECTED`).
3. **KMS Envelope Credential Vault (`packages/crypto`)**: AES-256-GCM with unique 256-bit DEKs wrapped by KEK (`kms_key_id`), strict AAD binding, key rotation, and short-lived HMAC `CredentialAccessPermit`.
4. **School SPI & HAUT Library Provider (`packages/school-spi`)**: SSRF outbound guard, scoped cookie vault, daily window `07:00:00`–`21:30:00` (`Asia/Shanghai`), `SIGN_IN` automation prohibition, and authoritative readback verification.
5. **ADR-005 Dynamic Target `T` Triple-Schedule Engine (`packages/reservations`)**: User-selected target time `T` within official school hours, scheduling `PRECHECK` at `T-30m`, `FINAL_CHECK` at `T-5m`, and `FIRE` at `T`, with CAS state transitions and `RESULT_UNKNOWN` readback-first safety.
6. **Zero-SSO-Change Finance Bridge (`packages/finance`)**: Post-confirmation idempotent debit (`dis:reservation:<orderUUID>:debit:v1`), `PAYMENT_DUE` handling without cancelling confirmed seats, and dual-person refund approval (`dis:reservation:<orderUUID>:refund:v1`).
7. **Parcel Hub (`packages/parcel-hub`)**: Enforces `PROVIDER_AUTHORITY_MATRIX`, OTP/verification SMS blacklist filtering, canonical tracking number deduplication, field-level provenance merge, and opt-in AI assistant consent gates.
8. **Plugin SDK & CLI (`packages/plugin-sdk`)**: `dis-plugin` CLI (`init | validate | package | sign | verify | test`), Ed25519 manifest signature + SHA-256 artifact digest verification, `dis-campus-plugin/v1` legacy adapter, and zero-host-code-change installation.

## Quick Verification

```bash
npm run contract:check
npm test
```
