import test from "node:test";
import assert from "node:assert/strict";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { validateAllowedSchoolUrl } from "../packages/school-spi/src/index.mjs";
import { assertSafeRelativeArtifactPath } from "../packages/plugin-sdk/src/index.mjs";
import { redactSensitiveFields } from "../packages/contracts/src/index.mjs";

test("Security Red-Team: Refresh token replay immediately revokes entire device session family (AUTH-014)", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
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
  const app = createCampusCloudApp({ requireAdminAccess: false });
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
  const app = createCampusCloudApp({ requireAdminAccess: false });
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
  const app = createCampusCloudApp({ requireAdminAccess: false });

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

test("Security Red-Team: Production Finance Bridge never grants fake 5.0 🍑 sandbox balance or allows unbacked debits (FIN-REDTEAM-001)", async () => {
  const app = createCampusCloudApp({
    requireAdminAccess: false,
    financeBridgeOptions: {
      realDebitsEnabled: true,
      allowSandboxFallback: false,
      internalServiceKey: ""
    }
  });
  const realUser = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "custom_sso_subject_non_uuid",
    displayName: "Real User Without Sandbox"
  });

  const wallet = await app.financeService.getWalletSnapshot(realUser.id);
  assert.equal(wallet.peach_balance, 0);
  assert.equal(wallet.micropeach_balance, 0);
  assert.equal(wallet.source, "xpeach-sso-uninitialized");
  assert.equal(
    app.financeBridge.sandboxBalancesMicropeach.has(realUser.id),
    false,
    "readWallet must never pollute sandboxBalancesMicropeach for real production users"
  );

  await assert.rejects(
    async () =>
      app.financeBridge.adjustBalanceIdempotent({
        cloudUserId: realUser.id,
        ssoSubject: realUser.subject,
        deltaMicropeach: -10_000,
        eventKey: "dis:reservation:11111111-2222-3333-4444-555555555555:debit:v1",
        reason: "Red-team unbacked debit attempt"
      }),
    (err) => err?.code === "SSO_UNAVAILABLE"
  );
});

test("Security Red-Team: Per-order mutex, terminal REFUNDED state guard, and whitespace approver rejection (FIN-REDTEAM-002)", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "test_fin_mutex_user",
    displayName: "Fin Mutex User"
  });
  app.financeBridge.setSandboxBalance(user.id, 50_000);

  const order = await app.financeService.createAndSettleOrderForConfirmedJob({
    job: { id: "job_fin_mutex_1", cloud_user_id: user.id },
    plan: { id: "plan_fin_mutex_1" }
  });
  assert.equal(order.payment_state, "PAID");
  assert.equal(app.financeBridge.getSandboxBalance(user.id), 40_000);

  const approver = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "fin_mutex_approver_sub",
    username: "admin_2",
    role: "admin",
    displayName: "Fin Approver"
  });

  // Whitespace-only secondApproverRef must be rejected
  await assert.rejects(
    async () =>
      app.financeService.issueRefundForOrder(order.id, {
        amountMicropeach: 10_000,
        reason: "Whitespace approver bypass attempt",
        actorRef: "admin_1",
        secondApproverRef: "   "
      }),
    (err) => err?.code === "FORBIDDEN"
  );

  // Concurrent refund attempts must serialize and only refund once
  const [r1, r2] = await Promise.all([
    app.financeService.issueRefundForOrder(order.id, {
      amountMicropeach: 10_000,
      reason: "Concurrent refund 1",
      actorRef: "admin_1",
      secondApproverRef: "admin_2"
    }),
    app.financeService.issueRefundForOrder(order.id, {
      amountMicropeach: 10_000,
      reason: "Concurrent refund 2",
      actorRef: "admin_1",
      secondApproverRef: "admin_2"
    })
  ]);
  assert.equal(r1.payment_state, "REFUNDED");
  assert.equal(r2.payment_state, "REFUNDED");
  assert.equal(app.financeBridge.getSandboxBalance(user.id), 50_000);

  // Calling executeDebitForOrder on a REFUNDED order must fail with CONFLICT (never clobber REFUNDED back to PAID)
  await assert.rejects(
    async () => app.financeService.executeDebitForOrder(order.id),
    (err) => err?.code === "CONFLICT"
  );
});

test("Security Red-Team: OIDC missing-nonce rejection, unknown school_id DoS guard, and active rate limiting (GATEWAY-REDTEAM-003)", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });

  // 1) Missing nonce in OIDC claims must be rejected
  const webTxn = app.identity.startWebTransaction({ returnTo: "/" });
  const txnObj = app.store.authTransactions.get(webTxn.login_txn);
  await assert.rejects(
    async () =>
      app.identity.handleOidcCallback({
        state: txnObj.serverState,
        code: "simulated_missing_nonce",
        simulatedIdTokenClaims: {
          iss: app.identity.expectedIssuer,
          aud: app.identity.clientId,
          sub: "victim_sub"
          // nonce intentionally omitted
        }
      }),
    /ID Token nonce mismatch/
  );

  // 2) Unknown school_id on GET /api/v1/campus-content returns 404 without allocating store.campusContent entries
  const sizeBefore = app.store.campusContent.size;
  const [miss1, miss2] = await Promise.all([
    app.inject({ method: "GET", url: "/api/v1/campus-content?school_id=nonexistent_school_dos_1" }),
    app.inject({ method: "GET", url: "/api/v1/campus-content?school_id=nonexistent_school_dos_1" })
  ]);
  assert.equal(miss1.status, 404);
  assert.equal(miss2.status, 404);
  assert.equal(
    app.store.campusContent.size,
    sizeBefore,
    "Unknown school_id must not allocate memory in store.campusContent"
  );

  // 3) Active rate limiting on anonymous_rate_limited endpoints (client headers cannot inflate the cap)
  let lastReq = null;
  for (let i = 0; i < 61; i++) {
    lastReq = await app.inject({
      method: "GET",
      url: "/api/v1/auth/mobile/status?txn=txn_nonexistent",
      headers: { "x-rate-limit-key": `spoof_${i}` }
    });
  }
  assert.equal(lastReq.status, 429);
  assert.equal(lastReq.body.code, "RATE_LIMITED");

  // 4) DELETED user cannot authenticate with a pre-deletion JWT
  const delUser = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "deleted_user_sub",
    displayName: "Deleted User"
  });
  const delSess = app.identity.issueDeviceSession(delUser, "Phone");
  delUser.status = "DELETED";
  const afterDel = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { authorization: `Bearer ${delSess.access_token}` }
  });
  assert.equal(afterDel.status, 401);
});

test("Security Red-Team: Triple-schedule per-job mutex, execute-now idempotency, and multi-day rollover prewarmed date rewrite (SCHED-REDTEAM-004)", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "test_sched_redteam_user",
    displayName: "Sched User"
  });
  app.financeBridge.setSandboxBalance(user.id, 100_000);
  const sess = app.identity.issueDeviceSession(user, "Phone");

  const bindInit = await app.inject({
    method: "POST",
    url: "/api/v1/school-bindings",
    headers: { authorization: `Bearer ${sess.access_token}` },
    body: { school_id: "haut", student_no: "20249988" }
  });
  const bindingId = bindInit.body.data.id;
  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${bindingId}/complete`,
    headers: { authorization: `Bearer ${sess.access_token}` },
    body: { credential_kind: "DELEGATED_SESSION_BUNDLE", delegated_secret: "mock_secret" }
  });
  const consentRes = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: { authorization: `Bearer ${sess.access_token}` },
    body: { school_id: "haut" }
  });
  const consentId = consentRes.body.data.id;

  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: {
      authorization: `Bearer ${sess.access_token}`,
      "idempotency-key": "idem_sched_redteam_1"
    },
    body: {
      school_binding_id: bindingId,
      consent_id: consentId,
      area_code: "5F_MID",
      area_name: "五层中区",
      candidate_seats: ["001", "002"],
      target_local_date: "2026-11-08",
      target_local_time: "07:00:00",
      repeat_days: 2
    },
    nowMs: Date.parse("2026-11-08T06:00:00+08:00")
  });
  assert.equal(planRes.status, 201);
  const jobId = planRes.body.data.job_id;
  const job = app.store.reservationJobs.get(jobId);
  job.prewarmed_targets = {
    region_id: 7,
    start_full: "2026-11-08 08:00:00",
    end_full: "2026-11-08 22:00:00"
  };

  // Execute now -> confirms Day 1 and rolls over to Day 2 (2026-11-09)
  const exec1 = await app.inject({
    method: "POST",
    url: `/api/v1/reservation-jobs/${jobId}/execute-now`,
    headers: { authorization: `Bearer ${sess.access_token}` },
    body: {},
    nowMs: Date.parse("2026-11-08T07:00:05+08:00")
  });
  assert.equal(exec1.status, 200);
  assert.equal(exec1.body.data.job.state, "CONFIRMED");

  // Calling execute-now again on an already-CONFIRMED job must return idempotently without clobbering PRECHECK_OK/FINAL_CHECK_OK
  const exec2 = await app.inject({
    method: "POST",
    url: `/api/v1/reservation-jobs/${jobId}/execute-now`,
    headers: { authorization: `Bearer ${sess.access_token}` },
    body: {}
  });
  assert.equal(exec2.status, 200);
  assert.equal(exec2.body.data.job.state, "CONFIRMED");
  const precheckEv = Array.from(app.store.scheduleEvents.values()).find(
    (e) => e.job_id === jobId && e.kind === "PRECHECK"
  );
  assert.notEqual(precheckEv.status, "SKIPPED_TERMINAL");

  // Verify rolled-over Day 2 job has rewritten prewarmed_targets date to 2026-11-09
  const nextJob = app.store.reservationJobs.get(job.next_job_id);
  assert.ok(nextJob);
  assert.equal(nextJob.booking_local_date, "2026-11-09");
  assert.equal(nextJob.prewarmed_targets.start_full, "2026-11-09 08:00:00");
  assert.equal(nextJob.prewarmed_targets.end_full, "2026-11-09 22:00:00");
});

test("Security Red-Team: Admin-only login gate blocks non-admin console flow; app flow stays open with RBAC gating (AUTH-GATE-001)", async () => {
  const app = createCampusCloudApp();
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "plain_student_sub",
    displayName: "Plain Student"
  });
  assert.equal(app.store.hasAdminAccess(user.id), false);

  // Console (backend) flow is blocked at issuance for non-admins
  assert.throws(
    () => app.identity.issueDeviceSession(user, "Campus Cloud Web Console", null, 1, Date.now(), "WEB_CONSOLE"),
    /仅管理员账号可登录云平台后台/
  );

  // Mobile app flow issues normally for any active SSO user
  const sess = app.identity.issueDeviceSession(user, "Phone", null, 1, Date.now(), "MOBILE_APP");
  assert.ok(sess.access_token);
  const ctx = app.identity.verifyAccessToken(sess.access_token);
  assert.equal(ctx.cloudUserId, user.id);

  // Admin endpoints remain RBAC-gated against the member's app token
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/admin/overview",
    headers: { authorization: `Bearer ${sess.access_token}` }
  });
  assert.equal(res.status, 403);

  // A console-flow session whose user lost admin access is rejected at verification
  app.identity.requireAdminAccess = false;
  const webSess = app.identity.issueDeviceSession(user, "Web", null, 1, Date.now(), "WEB_CONSOLE");
  app.identity.requireAdminAccess = true;
  await assert.rejects(
    async () => app.identity.verifyAccessToken(webSess.access_token),
    /FORBIDDEN|仅管理员/
  );

  // Cookie path fails closed the same way
  const cookieVal = app.identity.signWebSessionCookie({
    cloudUserId: user.id,
    accessToken: webSess.access_token,
    refreshToken: webSess.refresh_token
  });
  assert.equal(
    app.identity.verifyWebSessionCookie(`dis_web_session=${encodeURIComponent(cookieVal)}`),
    null
  );
});

test("Security Red-Team: Hardcoded admin backdoor subject grants no implicit roles; env allowlist does (AUTH-GATE-002)", async () => {
  const app = createCampusCloudApp();
  const former = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "856f-cf51-b064-5d84",
    displayName: "Former Backdoor Subject"
  });
  assert.equal(app.store.hasAdminAccess(former.id), false);
  assert.throws(
    () => app.identity.issueDeviceSession(former, "Web"),
    /仅管理员账号可登录/
  );

  const allowApp = createCampusCloudApp({
    storeOptions: { adminSsoSubjects: ["owner_sub_1"] }
  });
  const owner = allowApp.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "owner_sub_1",
    displayName: "Owner"
  });
  assert.equal(allowApp.store.hasAdminAccess(owner.id), true);
  const sess = allowApp.identity.issueDeviceSession(owner, "Web");
  assert.ok(sess.access_token);
  const ctx = allowApp.identity.verifyAccessToken(sess.access_token);
  assert.ok(ctx.roles.includes("PLATFORM_OWNER"));
});

test("Security Red-Team: Rate limiter ignores client-supplied x-rate-limit-* / forwarded headers (AUTH-RL-001)", async () => {
  const app = createCampusCloudApp();
  let lastStatus = 200;
  for (let i = 0; i < 61; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mobile/start",
      headers: {
        "x-rate-limit-key": `spoofed_${i}_${Math.random()}`,
        "x-rate-limit-max": "99999",
        "x-forwarded-for": `10.0.0.${i}`,
        "x-real-ip": `10.0.0.${i}`
      },
      body: {
        install_ephemeral_id: "eph_attacker123456",
        code_challenge: "A".repeat(43),
        code_challenge_method: "S256"
      }
    });
    lastStatus = res.status;
  }
  assert.equal(lastStatus, 429);
});

test("Security Red-Team: sandbox_override request field cannot unlock research-sandbox-only providers (PARCEL-SANDBOX-001)", async () => {
  const app = createCampusCloudApp();
  const admin = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "ops_admin_sub",
    role: "admin",
    displayName: "Ops Admin"
  });
  const sess = app.identity.issueDeviceSession(admin, "Console");
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/parcel-sync/jobs",
    headers: { authorization: `Bearer ${sess.access_token}` },
    body: {
      provider_id: "parcel.taobao.cainiao",
      sandbox_override: true,
      channel: "MANUAL_API_CALL"
    }
  });
  assert.equal(res.status, 403);
});

test("Security Red-Team: Refund requires real distinct approver, not fabricated refs (FIN-DUAL-001)", async () => {
  const app = createCampusCloudApp();
  const actor = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "finance_actor_sub",
    role: "admin",
    displayName: "Finance Actor"
  });
  const order = {
    id: "ord_refund_gate_1",
    cloud_user_id: actor.id,
    price_micropeach: 100000,
    payment_state: "PAID",
    paid_at: new Date().toISOString(),
    created_at: new Date().toISOString()
  };
  app.store.reservationOrders.set(order.id, order);

  await assert.rejects(
    async () =>
      app.financeService.issueRefundForOrder(order.id, {
        amountMicropeach: 1000,
        reason: "test",
        actorRef: actor.id,
        secondApproverRef: `console_approver_${actor.id}`
      }),
    /distinct, existing, ACTIVE approver/
  );
  await assert.rejects(
    async () =>
      app.financeService.issueRefundForOrder(order.id, {
        amountMicropeach: 1000,
        reason: "test",
        actorRef: actor.id,
        secondApproverRef: "nonexistent_user_123"
      }),
    /distinct, existing, ACTIVE approver/
  );
  const outsider = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "plain_outsider_sub",
    displayName: "No Finance Role"
  });
  await assert.rejects(
    async () =>
      app.financeService.issueRefundForOrder(order.id, {
        amountMicropeach: 1000,
        reason: "test",
        actorRef: actor.id,
        secondApproverRef: outsider.id
      }),
    /finance approval role/
  );
});

test("Security Red-Team: Unresolved secret:// references and missing prod secrets fail closed (CRYPTO-001)", async () => {
  const { KmsEnvelopeVault } = await import("../packages/crypto/src/index.mjs");
  assert.throws(
    () => new KmsEnvelopeVault({ initialKekMaterial: "secret://campus-cloud/prod/kms" }),
    /Unresolved secret reference/
  );
  const { CloudIdentityService } = await import("../packages/identity/src/index.mjs");
  const { CloudDatabaseStore } = await import("../packages/db/src/index.mjs");
  const store = new CloudDatabaseStore();
  assert.throws(
    () => new CloudIdentityService(store, { sessionSecret: "secret://x/y" }),
    /Unresolved secret reference/
  );
});

test("Security Red-Team: Orphan refresh token (valid signature, no session record) is rejected (AUTH-RT-001)", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "orphan_rt_sub",
    displayName: "Orphan"
  });
  const sess = app.identity.issueDeviceSession(user, "Phone");
  app.store.deviceSessions.clear();

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    body: { refresh_token: sess.refresh_token }
  });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, "CLOUD_AUTH_REQUIRED");
});

test("Security Red-Team: Tampered v2 web session cookie fails closed (AUTH-COOKIE-001)", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "cookie_user_sub",
    role: "admin",
    displayName: "Cookie User"
  });
  const sess = app.identity.issueDeviceSession(user, "Web");
  const cookieVal = app.identity.signWebSessionCookie({
    cloudUserId: user.id,
    accessToken: sess.access_token,
    refreshToken: sess.refresh_token
  });
  const parts = cookieVal.split(".");
  assert.equal(parts.length, 4);
  parts[3] = Buffer.from("forged").toString("base64url");
  assert.equal(
    app.identity.verifyWebSessionCookie(`dis_web_session=${parts.join(".")}`),
    null
  );
});

test("Security Red-Team: SSO membership role claim drives admin gate; demotion recomputes (AUTH-RBAC-001)", async () => {
  const app = createCampusCloudApp();
  const mk = (sub, role) =>
    app.store.findOrCreateCloudUser({
      issuer: "https://sso.xpeach.codes/t/acme",
      subject: sub,
      displayName: sub,
      role
    });

  const owner = mk("sso_owner_1", "owner");
  assert.equal(app.store.hasAdminAccess(owner.id), true);
  assert.ok(app.store.getUserRoles(owner.id).includes("PLATFORM_OWNER"));

  const admin = mk("sso_admin_1", "admin");
  assert.equal(app.store.hasAdminAccess(admin.id), true);
  assert.ok(app.store.getUserRoles(admin.id).includes("ADMIN"));
  assert.equal(app.store.getUserRoles(admin.id).includes("PLATFORM_OWNER"), false);

  const member = mk("sso_member_1", "member");
  assert.equal(app.store.hasAdminAccess(member.id), false);
  assert.throws(
    () => app.identity.issueDeviceSession(member, "Web"),
    /管理员|administrator/i
  );

  // Demotion at SSO (owner -> member) must strip SSO-derived roles on next login sync
  app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "sso_owner_1",
    displayName: "sso_owner_1",
    role: "member"
  });
  assert.equal(app.store.hasAdminAccess(owner.id), false);

  // Manual setUserRoles grants survive SSO recompute
  app.store.setUserRoles(member.id, ["SECURITY_AUDITOR"]);
  app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "sso_member_1",
    displayName: "sso_member_1",
    role: "member"
  });
  assert.ok(app.store.getUserRoles(member.id).includes("SECURITY_AUDITOR"));
});
