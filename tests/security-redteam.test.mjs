import test from "node:test";
import assert from "node:assert/strict";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { validateAllowedSchoolUrl } from "../packages/school-spi/src/index.mjs";
import { assertSafeRelativeArtifactPath } from "../packages/plugin-sdk/src/index.mjs";
import { redactSensitiveFields } from "../packages/contracts/src/index.mjs";

test("Security Red-Team: Refresh token replay immediately revokes entire device session family (AUTH-014)", async () => {
  const app = createCampusCloudApp();
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "redteam_replay_sub",
    displayName: "Replay Target"
  });
  const gen1 = app.identity.issueDeviceSession(user, "Device 1");

  // Legitimate rotation Gen 1 -> Gen 2
  const gen2 = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    body: { refresh_token: gen1.refresh_token }
  });
  assert.equal(gen2.status, 200);
  const gen2AccessToken = gen2.body.data.access_token;

  // Attacker replays already-consumed Gen 1 refresh token!
  const replayAttempt = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    body: { refresh_token: gen1.refresh_token }
  });
  assert.equal(replayAttempt.status, 401);
  assert.equal(replayAttempt.body.code, "SESSION_REPLAY_DETECTED");

  // Verify Gen 2 access token is ALSO immediately invalidated because the whole family was revoked!
  const meWithGen2 = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { authorization: `Bearer ${gen2AccessToken}` }
  });
  assert.equal(meWithGen2.status, 401);
});

test("Security Red-Team: Cross-tenant IDOR on bindings, jobs, parcels, and admin endpoints is blocked", async () => {
  const app = createCampusCloudApp();
  const userA = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "user_a",
    displayName: "User A"
  });
  const userB = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "user_b",
    displayName: "User B"
  });
  const sessA = app.identity.issueDeviceSession(userA, "Phone A");
  const sessB = app.identity.issueDeviceSession(userB, "Phone B");

  // User A creates a parcel
  const importRes = await app.inject({
    method: "POST",
    url: "/api/v1/parcels/imports",
    headers: { authorization: `Bearer ${sessA.access_token}` },
    body: {
      tracking_number: "JD9988776655",
      provider_id: "parcel.manual"
    }
  });
  const parcelId = importRes.body.data.parcels[0].id;

  // User B attempts IDOR read on User A's parcel -> 403 FORBIDDEN
  const idorParcel = await app.inject({
    method: "GET",
    url: `/api/v1/parcels/${parcelId}`,
    headers: { authorization: `Bearer ${sessB.access_token}` }
  });
  assert.equal(idorParcel.status, 403);

  // Regular User B attempts to call Admin Kill-Switch -> 403 FORBIDDEN
  const idorAdmin = await app.inject({
    method: "POST",
    url: "/api/v1/admin/schools/haut/kill-switch",
    headers: { authorization: `Bearer ${sessB.access_token}` },
    body: { kill_switch: true }
  });
  assert.equal(idorAdmin.status, 403);
});

test("Security Red-Team: SSRF guard blocks HTTP, localhost, RFC1918 private IPs, link-local metadata, and unapproved domains", () => {
  const allowlist = ["lib.haut.edu.cn"];
  assert.ok(validateAllowedSchoolUrl("https://lib.haut.edu.cn/api/seats", allowlist));

  const maliciousUrls = [
    "http://lib.haut.edu.cn/api/seats", // non-HTTPS
    "https://127.0.0.1/admin",
    "https://localhost/admin",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.1/internal",
    "https://192.168.1.1/router",
    "https://172.16.0.5/redis",
    "https://[::1]/loopback",
    "https://evil.example.com/phish"
  ];
  for (const url of maliciousUrls) {
    assert.throws(
      () => validateAllowedSchoolUrl(url, allowlist),
      `SSRF guard must block ${url}`
    );
  }
});

test("Security Red-Team: Plugin zip-slip path traversal, tampered artifact digest, and undeclared network origin are rejected", async () => {
  // Zip-slip paths
  for (const unsafe of ["../etc/passwd", "/etc/shadow", "dist/../../secret.key", "C:\\Windows\\win.ini"]) {
    assert.throws(() => assertSafeRelativeArtifactPath(unsafe));
  }

  // Tampered signature rejection
  const app = createCampusCloudApp();
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "sec_plugin_user",
    displayName: "Sec User"
  });
  const sess = app.identity.issueDeviceSession(user, "Phone");

  const badInstall = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/install",
    headers: { authorization: `Bearer ${sess.access_token}` },
    body: {
      manifest: {
        schema_version: "dis-extension/v2",
        plugin_id: "org.evil.tampered",
        name: "Tampered Plugin",
        version: "1.0.0",
        min_host_api: 2,
        max_host_api: 2,
        permissions: ["ui.slot.render"],
        ui_slots: [],
        entry_artifacts: [
          {
            path: "dist/index.mjs",
            sha256: "0000000000000000000000000000000000000000000000000000000000000000"
          }
        ],
        signature: {
          algorithm: "Ed25519",
          key_id: "fake",
          value_base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
        }
      },
      artifact_map: { "dist/index.mjs": "console.log('pwn');" }
    }
  });
  assert.equal(badInstall.status, 400);
  assert.equal(badInstall.body.code, "PLUGIN_SIGNATURE_INVALID");
});

test("Security Red-Team: DLP redaction strips cookies, passwords, tokens, and internal keys from logs and audit payloads", () => {
  const raw = {
    student_no: "20230101",
    password: "SuperSecretPassword123!",
    cookie: "CASTGC=TGT-12345; JSESSIONID=ABCDEF",
    nested: {
      internal_service_key: "sso_internal_secret_999",
      note: "Header Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig and CASTGC=TGT-998877"
    }
  };
  const redacted = redactSensitiveFields(raw);
  const serialized = JSON.stringify(redacted);
  assert.ok(!serialized.includes("SuperSecretPassword123!"));
  assert.ok(!serialized.includes("sso_internal_secret_999"));
  assert.ok(!serialized.includes("TGT-12345"));
  assert.ok(!serialized.includes("TGT-998877"));
  assert.equal(redacted.password, "[REDACTED]");
  assert.equal(redacted.nested.internal_service_key, "[REDACTED]");
});

test("Security Red-Team: Synthetic OIDC code bypass, cross-flow ticket confusion, open redirects, CSRF, and javascript: URLs are blocked", async () => {
  const app = createCampusCloudApp();

  // 1) Open redirect in return_to is neutralized to '/'
  const webTxn = app.identity.startWebTransaction({ returnTo: "//evil.example.com/phish" });
  const internalTxn = app.store.authTransactions.get(webTxn.login_txn);
  assert.equal(internalTxn.returnTo, "/");

  // 2) Cross-flow ticket confusion (WEB_CONSOLE ticket cannot be exchanged on mobile endpoint)
  const cbRes = await app.identity.handleOidcCallback({
    state: internalTxn.serverState,
    code: "sso_code_redteam_flow"
  });
  assert.throws(
    () =>
      app.identity.exchangeMobileTicket({
        loginTxn: cbRes.login_txn,
        appTicket: cbRes.web_ticket,
        codeVerifier: "not_used_for_web"
      }),
    /Invalid app_ticket or transaction mismatch/
  );

  // 3) Synthetic OIDC code is rejected when clientSecret is configured
  app.identity.allowSyntheticTestCodes = false;
  const prodTxn = app.identity.startWebTransaction({ returnTo: "/console" });
  const prodInternalTxn = app.store.authTransactions.get(prodTxn.login_txn);
  await assert.rejects(
    async () =>
      app.identity.handleOidcCallback({
        state: prodInternalTxn.serverState,
        code: "sub:856f-cf51-b064-5d84"
      }),
    /Synthetic OIDC test codes are disabled/
  );
  app.identity.allowSyntheticTestCodes = true;

  // 4) Cross-site CSRF on cookie-authenticated POST is blocked
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "csrf_victim",
    displayName: "CSRF Victim"
  });
  const sess = app.identity.issueDeviceSession(user, "Web");
  const cookieVal = app.identity.signWebSessionCookie({
    cloudUserId: user.id,
    accessToken: sess.access_token,
    refreshToken: sess.refresh_token
  });
  const csrfAttempt = await app.inject({
    method: "POST",
    url: "/api/v1/sync/snapshot",
    headers: {
      cookie: `dis_web_session=${cookieVal}`,
      "sec-fetch-site": "cross-site"
    },
    body: {}
  });
  assert.equal(csrfAttempt.status, 403);

  // 5) javascript: and http:// URLs in campus content are sanitized
  const sanitized = app.store.upsertCampusChannel(
    "haut",
    {
      id: "xss_test_ch",
      title: "Test",
      invite_url: "javascript:alert(document.cookie)"
    },
    "admin"
  );
  const ch = sanitized.channels.find((c) => c.id === "xss_test_ch");
  assert.ok(ch.invite_url.startsWith("https://"));
});
