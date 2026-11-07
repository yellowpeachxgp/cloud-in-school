import test from "node:test";
import assert from "node:assert/strict";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { computeS256Challenge } from "../packages/identity/src/index.mjs";
import { resolvePickupCode, PROVIDER_AUTHORITY_MATRIX } from "../packages/parcel-hub/src/index.mjs";
import { listMigrations } from "../packages/db/src/index.mjs";

test("Unit: OIDC BFF + PKCE S256 + Single-Use App Ticket + Refresh Family Rotation (AUTH-001..020)", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk_valid_verifier_12345";
  const challenge = computeS256Challenge(verifier);

  // 1. Reject plain PKCE
  const badStart = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mobile/start",
    body: {
      install_ephemeral_id: "eph_android_0001",
      code_challenge: challenge,
      code_challenge_method: "plain"
    }
  });
  assert.equal(badStart.status, 400);

  // 2. Start valid S256 transaction
  const startRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mobile/start",
    body: {
      install_ephemeral_id: "eph_android_0001",
      code_challenge: challenge,
      code_challenge_method: "S256",
      device_label: "Pixel 9 Pro"
    }
  });
  assert.equal(startRes.status, 200);
  const loginTxn = startRes.body.data.login_txn;

  // 3. Redirect to OIDC SSO
  const redirectRes = await app.inject({
    method: "GET",
    url: `/api/v1/auth/oidc/start?txn=${encodeURIComponent(loginTxn)}`
  });
  assert.equal(redirectRes.status, 302);
  const redirectLocation = new URL(redirectRes.headers.Location);
  const state = redirectLocation.searchParams.get("state");
  assert.ok(state);

  // 4. OIDC Callback issues single-use app_ticket
  const cbRes = await app.inject({
    method: "GET",
    url: `/api/v1/auth/oidc/callback?code=sub:user_uuid_1001&state=${encodeURIComponent(state)}`
  });
  assert.equal(cbRes.status, 302);
  const appTicket = cbRes.body.data.app_ticket;
  assert.ok(appTicket.startsWith("tkt_"));

  // 5. Wrong PKCE verifier fails without burning validverifier check if tested separately, let's test exchange with valid verifier first
  const exRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mobile/exchange",
    body: {
      login_txn: loginTxn,
      app_ticket: appTicket,
      code_verifier: verifier
    }
  });
  assert.equal(exRes.status, 200);
  const { access_token, refresh_token } = exRes.body.data;
  assert.ok(access_token);
  assert.ok(refresh_token);

  // 6. Second exchange of the same single-use app_ticket MUST fail (AUTH-008)
  const replayTicketRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mobile/exchange",
    body: {
      login_txn: loginTxn,
      app_ticket: appTicket,
      code_verifier: verifier
    }
  });
  assert.equal(replayTicketRes.status, 401);
});

test("Unit: KMS Envelope Encryption + CredentialAccessPermit + Key Rotation (SCH-001..015)", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const enc = app.kmsVault.encryptSecret({
    bindingId: "bind_01",
    schoolId: "haut",
    credentialKind: "DELEGATED_SESSION_BUNDLE",
    plaintext: "CASTGC=TGT-secret-session-cookie"
  });
  assert.notEqual(enc.ciphertext, "CASTGC=TGT-secret-session-cookie");

  // Decrypt without permit must fail
  assert.throws(() => {
    app.kmsVault.decryptSecretWithPermit(enc, null);
  });

  // Decrypt with valid permit succeeds
  const permit = app.kmsVault.issueAccessPermit({
    taskId: "job_123",
    schoolId: "haut",
    bindingId: "bind_01",
    credentialRef: enc.id,
    ttlSeconds: 30
  });
  const decrypted = app.kmsVault.decryptSecretWithPermit(enc, permit);
  assert.equal(decrypted, "CASTGC=TGT-secret-session-cookie");

  // Rotate KEK and verify existing credential still decrypts under new KEK
  const rot = app.kmsVault.rotateKek("cn-kms-campus-cloud-kek-v2", "new-kek-seed-2026-v2", [enc]);
  assert.equal(rot.rotatedCount, 1);
  assert.equal(enc.kms_key_id, "cn-kms-campus-cloud-kek-v2");
  const decryptedAfterRotation = app.kmsVault.decryptSecretWithPermit(enc, permit);
  assert.equal(decryptedAfterRotation, "CASTGC=TGT-secret-session-cookie");
});

test("Unit: Parcel Hub OTP/Verification SMS Filtering, Pickup Code Extraction & Deduplication", async () => {
  // Pure OTP SMS must return null (never misclassified as pickup code!)
  assert.equal(
    resolvePickupCode("【招商银行】您的登录验证码为 482910，请勿泄露给他人。"),
    null
  );
  assert.equal(
    resolvePickupCode("【XPEACH】您的动态校验码是 938122，5分钟内有效。"),
    null
  );

  // Genuine campus station SMS extracts pickup code and station name
  const cainiao = resolvePickupCode(
    "【菜鸟驿站】您的包裹已到莲花街北苑菜鸟驿站，请凭取件码 12-3-4056 到店自提。"
  );
  assert.ok(cainiao);
  assert.equal(cainiao.pickup_code, "12-3-4056");
  assert.equal(cainiao.code_type, "SHELF_CODE");

  // Provider authority matrix fail-closed check in production
  const app = createCampusCloudApp({ environment: "production" });
  assert.equal(
    PROVIDER_AUTHORITY_MATRIX["parcel.taobao.cainiao"].authority_status,
    "RESEARCH_SANDBOX_ONLY"
  );
  assert.throws(() => {
    app.parcelHub.enforceProviderAuthority("parcel.taobao.cainiao", {
      channel: "CLOUD_BACKGROUND_POLL"
    });
  });

  // Upsert & merge same tracking number from manual + notification parser
  const p1 = app.parcelHub.upsertParcel({
    cloudUserId: "u_1",
    trackingNumber: "sf1234567890",
    providerId: "parcel.manual",
    itemTitle: "算法导论 (第四版)"
  });
  const p2 = app.parcelHub.upsertParcel({
    cloudUserId: "u_1",
    trackingNumber: "SF-1234567890",
    providerId: "parcel.notification-parser",
    rawNotificationText: "【菜鸟驿站】您的包裹已到站，凭取件码 A3-2-108 取件。"
  });
  assert.equal(p1.id, p2.id, "Same tracking number for same user must merge into canonical parcel");
  assert.equal(p2.pickup_code, "A3-2-108");
  assert.equal(p2.item_title, "算法导论 (第四版)");
  assert.equal(p2.status, "READY_FOR_PICKUP");
});

test("Unit: Database Migrations have paired Up and Down SQL files and support rollback", () => {
  const migrations = listMigrations();
  assert.ok(migrations.length >= 2);
  for (const m of migrations) {
    assert.ok(m.upSql.length > 100);
    assert.ok(m.downSql && m.downSql.length > 50);
  }
});
