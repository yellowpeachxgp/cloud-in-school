# Campus Cloud Operations & Deployment Runbook

## 1. Deployment Topology (`103.236.61.117`)

- Domestic Campus Cloud runs via Docker Compose (`docker-compose.yml`) bound to `127.0.0.1:18080` (API) and `127.0.0.1:18081` (Operations Console) behind OpenResty TLS reverse proxy (`campus.yellowpeachxgp.com`).
- XPEACH SSO runs on `40.160.138.219` (`sso.xpeach.codes/t/acme`).

## 2. Emergency School Kill-Switch

To immediately halt all automated library operations for a school and downgrade to `MOCK_ONLY`:

```bash
curl -X POST https://campus.yellowpeachxgp.com/api/v1/admin/schools/haut/kill-switch \
  -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"kill_switch": true}'
```

## 3. Place-Status Operations Moderator Grants

`place.status.moderate` is never implied by a global role, SECURITY_AUDITOR, or an ordinary campus binding. Deployment operators provision it only through startup-managed configuration in the store the API reads:

```bash
CLOUD_OPERATIONS_SCHOOL_GRANTS='[{"cloud_user_id":"<cloud-user-uuid>","school_id":"haut","permission":"place.status.moderate","granted_by_ref":"<change-ref>"}]'
```

Keep the value as one-line JSON, then restart the API. Startup reconciles entries before opening the socket. Removing an entry and restarting revokes that bootstrap-managed grant; manually written active grants with the same scope are not revoked. Every grant/revoke is audit-recorded without exposing a public moderation-provisioning API.

## 4. Database Migration & Rollback

- Forward migrations: `packages/db/migrations/0001_initial_campus_cloud.sql`, `0002_triple_schedule_and_parcel_hub.sql`
- Rollback scripts: `0001_initial_campus_cloud.down.sql`, `0002_triple_schedule_and_parcel_hub.down.sql`
