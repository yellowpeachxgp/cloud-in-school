import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import {
  loadEndpointInventory,
  loadOpenApiText
} from "../packages/contracts/src/index.mjs";
import { CONSOLE_VIEWS, renderConsoleHtml } from "../apps/console/src/main.mjs";

test("Contract Parity: 100% bidirectional parity between registered HTTP routes, endpoint-inventory.yaml, and OpenAPI 3.1.2 spec", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const registered = app.getRegisteredRoutes();
  const inventory = loadEndpointInventory();
  const openApiText = loadOpenApiText();

  assert.equal(inventory.length, 88, "endpoint-inventory.yaml must declare 88 operations");
  assert.equal(registered.length, 88, "CampusCloudApp must register all 88 operations");

  const regByKey = new Map(registered.map((r) => [`${r.method} ${r.path}`, r]));
  const invByKey = new Map(inventory.map((e) => [`${e.method} ${e.path}`, e]));

  for (const [key, inv] of invByKey.entries()) {
    const reg = regByKey.get(key);
    assert.ok(reg, `Missing registered route for inventory entry: ${key}`);
    assert.equal(reg.operationId, inv.operationId, `operationId mismatch on ${key}`);
    assert.equal(reg.auth, inv.auth, `auth mode mismatch on ${key} (${reg.operationId})`);
    assert.ok(
      openApiText.includes(`operationId: ${inv.operationId}`),
      `OpenAPI 3.1.2 spec missing operationId: ${inv.operationId}`
    );
  }

  for (const [key] of regByKey.entries()) {
    assert.ok(invByKey.has(key), `Uninventoried shadow route registered: ${key}`);
  }
});

test("Contract Parity: Operations Console exposes all 12 mandatory views", () => {
  assert.equal(CONSOLE_VIEWS.length, 12);
  const html = renderConsoleHtml();
  for (const view of CONSOLE_VIEWS) {
    assert.ok(html.includes(`id="view-${view.id}"`), `Missing console view ${view.id}`);
  }
});

test("UI SDK & Pricing Parity: Unified XPeach Web UI SDK, Liquid Glass mode, /console/content admin route, and 1 🍑 pricing", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  assert.equal(app.store.pricingMicropeach, 10_000, "Default reservation price must be 10,000 micropeach (1 🍑)");

  const cssRes = await app.inject({ method: "GET", url: "/static/xpeach-sdk.css" });
  assert.equal(cssRes.status, 200);
  assert.ok(String(cssRes.rawBody).includes("--xp-radius-card"));
  assert.ok(String(cssRes.rawBody).includes("liquid-glass"));

  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes",
    subject: "856f-cf51-b064-5d84",
    username: "yellowpeach",
    role: "admin"
  });
  const cookieVal = app.identity.signWebSessionCookie({
    cloudUserId: user.id,
    accessToken: "tok",
    refreshToken: "ref"
  });
  const commRes = await app.inject({
    method: "GET",
    url: "/console/content",
    headers: { cookie: `dis_web_session=${encodeURIComponent(cookieVal)}` }
  });
  assert.equal(commRes.status, 200);
  assert.ok(commRes.rawBody.includes("炽夜空动漫社"));
  assert.ok(commRes.rawBody.includes("硬件技术联盟"));
  assert.ok(commRes.rawBody.includes("计算机服务社"));
  assert.ok(commRes.rawBody.includes("xp-entity-header"));
  assert.ok(!commRes.rawBody.includes("0.1 🍑"));

  // Retired user-facing pages redirect to the admin dashboard
  const retiredRes = await app.inject({
    method: "GET",
    url: "/community",
    headers: { cookie: `dis_web_session=${encodeURIComponent(cookieVal)}` }
  });
  assert.equal(retiredRes.status, 302);
  assert.equal(retiredRes.headers?.location || retiredRes.headers?.Location, "/console");
});

test("School Integration Durability: HAUT AUTHORIZED_AUTOMATION approval and kill-switch persist across snapshot restart", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-school-integ-"));
  const snapshotPath = path.join(tmpDir, "cloud-state.json");
  try {
    const app1 = createCampusCloudApp({ storeOptions: { snapshotPath } });
    const capsBefore = await app1.inject({
      method: "GET",
      url: "/api/v1/schools/haut/library/capabilities"
    });
    assert.equal(capsBefore.status, 200);
    const createBefore = capsBefore.body.data.capabilities.find((c) => c.capability === "CREATE_BOOKING");
    assert.equal(createBefore?.availability_state, "MOCK_ONLY");

    const owner = app1.store.findOrCreateCloudUser({
      issuer: "https://sso.xpeach.codes/t/acme",
      subject: "owner_haut_sub",
      username: "yellowpeach",
      role: "owner"
    });
    const approver2 = app1.store.findOrCreateCloudUser({
      issuer: "https://sso.xpeach.codes/t/acme",
      subject: "ops_approver_sub",
      username: "ops_admin",
      role: "admin"
    });
    const ownerSess = app1.identity.issueDeviceSession(owner, "Admin Console");

    const approveRes = await app1.inject({
      method: "POST",
      url: "/api/v1/admin/schools/haut/authorization-approval",
      headers: { authorization: `Bearer ${ownerSess.access_token}` },
      body: {
        authorization_evidence_ref: "haut-prod-live-automation-2026-11",
        secondary_approver_ref: approver2.id
      }
    });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.data.authorization_evidence_ref, "haut-prod-live-automation-2026-11");

    // Simulate service restart by loading a fresh CampusCloudApp from snapshotPath
    const app2 = createCampusCloudApp({ storeOptions: { snapshotPath } });
    const capsAfterRestart = await app2.inject({
      method: "GET",
      url: "/api/v1/schools/haut/library/capabilities"
    });
    assert.equal(capsAfterRestart.status, 200);
    for (const capName of ["READ_MY_BOOKINGS", "VERIFY_BOOKING", "CREATE_BOOKING"]) {
      const entry = capsAfterRestart.body.data.capabilities.find((c) => c.capability === capName);
      assert.equal(
        entry?.availability_state,
        "AUTHORIZED_AUTOMATION",
        `${capName} must remain AUTHORIZED_AUTOMATION after snapshot restart`
      );
    }

    // Verify kill-switch toggle also persists across restart
    const ownerSess2 = app2.identity.issueDeviceSession(owner, "Admin Console 2");
    const killRes = await app2.inject({
      method: "POST",
      url: "/api/v1/admin/schools/haut/kill-switch",
      headers: { authorization: `Bearer ${ownerSess2.access_token}` },
      body: { kill_switch: true }
    });
    assert.equal(killRes.status, 200);

    const app3 = createCampusCloudApp({ storeOptions: { snapshotPath } });
    const capsKilled = await app3.inject({
      method: "GET",
      url: "/api/v1/schools/haut/library/capabilities"
    });
    const createKilled = capsKilled.body.data.capabilities.find((c) => c.capability === "CREATE_BOOKING");
    assert.equal(createKilled?.availability_state, "MOCK_ONLY");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Web Cloud Seat-Booking (WEB_PORTAL) allows XPeach member students on /reservations while strictly gating /console and /api/v1/admin/*", async () => {
  const app = createCampusCloudApp(); // default requireAdminAccess=true

  // Seed another student's binding to verify strict per-user isolation on Web Portal
  const otherStudent = app.store.findOrCreateCloudUser({
    issuer: app.identity.expectedIssuer,
    subject: "other_student_sub",
    username: "other_student_secret",
    role: "member"
  });
  app.store.schoolBindings.set("bind_other_1", {
    id: "bind_other_1",
    cloud_user_id: otherStudent.id,
    school_id: "haut",
    student_no: "2023998877",
    status: "DELEGATED_ACTIVE",
    auth_version: 1,
    created_at: new Date().toISOString()
  });
  app.store.indexUserScoped?.("schoolBindings", "bind_other_1", otherStudent.id);

  // 1) Unauthenticated GET /reservations presents the student Cloud Seat-Booking login portal
  const unauthPortal = await app.inject({ method: "GET", url: "/reservations" });
  assert.equal(unauthPortal.status, 200);
  assert.ok(unauthPortal.rawBody.includes("图书馆云端抢座"));
  assert.ok(unauthPortal.rawBody.includes("flow=portal"));

  // Unauthenticated GET /console presents the Admin-Only login gate
  const unauthConsole = await app.inject({ method: "GET", url: "/console" });
  assert.equal(unauthConsole.status, 200);
  assert.ok(unauthConsole.rawBody.includes("运维管理控制台"));
  assert.ok(unauthConsole.rawBody.includes("flow=console"));

  // 2) Member student completes Web OIDC Portal login flow
  const startRes = await app.inject({
    method: "GET",
    url: "/api/v1/auth/web/start?return_to=/reservations"
  });
  assert.equal(startRes.status, 302);
  const loginTxn = startRes.body.data.login_txn;
  const txnObj = app.store.authTransactions.get(loginTxn);
  assert.equal(txnObj.flowKind, "WEB_PORTAL");

  const cbRes = await app.identity.handleOidcCallback({
    state: txnObj.serverState,
    code: "sim_portal_code",
    simulatedIdTokenClaims: {
      iss: app.identity.expectedIssuer,
      aud: app.identity.clientId,
      sub: "student_member_sub_01",
      preferred_username: "haut_student_01",
      role: "member",
      nonce: txnObj.serverNonce,
      exp: Math.floor((Date.now() + 300_000) / 1000)
    }
  });
  assert.ok(cbRes.webSessionCookie);
  assert.ok(cbRes.appLinkUrl.includes("/reservations?web_ticket="));

  const exchRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/web/exchange",
    body: {
      login_txn: loginTxn,
      web_ticket: cbRes.appTicket
    }
  });
  assert.equal(exchRes.status, 200);
  const setCookieHeader = exchRes.headers["set-cookie"] || "";
  const cookieHeader = setCookieHeader.split(";")[0];
  const portalToken = exchRes.body.data.access_token;

  // 3) Member accesses / and /reservations with full Cloud Seat-Booking workbench and zero cross-user leakage
  for (const portalUrl of ["/", "/reservations"]) {
    const pageRes = await app.inject({
      method: "GET",
      url: portalUrl,
      headers: { cookie: cookieHeader }
    });
    assert.equal(pageRes.status, 200);
    assert.ok(pageRes.rawBody.includes('id="section-reservations"'));
    assert.ok(pageRes.rawBody.includes("云端定时抢座工作台"));
    assert.ok(!pageRes.rawBody.includes("2023998877"), "Must never leak another user's school binding");
    assert.ok(!pageRes.rawBody.includes("other_student_secret"), "Must never leak admin user directory");
  }

  // 4) Member's WEB_PORTAL token can call user-scoped APIs, but is 403 FORBIDDEN on /api/v1/admin/*
  const myPlans = await app.inject({
    method: "GET",
    url: "/api/v1/reservation-plans",
    headers: { authorization: `Bearer ${portalToken}` }
  });
  assert.equal(myPlans.status, 200);

  const adminOverview = await app.inject({
    method: "GET",
    url: "/api/v1/admin/overview",
    headers: { authorization: `Bearer ${portalToken}` }
  });
  assert.equal(adminOverview.status, 403);

  // 5) Member visiting /console or /console/jobs with WEB_PORTAL cookie is blocked by non-admin gate
  for (const adminPage of ["/console", "/console/jobs"]) {
    const consoleAttempt = await app.inject({
      method: "GET",
      url: adminPage,
      headers: { cookie: cookieHeader }
    });
    assert.equal(consoleAttempt.status, 200);
    assert.ok(consoleAttempt.rawBody.includes("当前登录账号无管理员权限"));
    assert.ok(consoleAttempt.rawBody.includes("返回我的云端抢座工作台"));
    assert.ok(!consoleAttempt.rawBody.includes("other_student_secret"));
  }

  // 6) Starting login from /console (WEB_CONSOLE flow) still blocks member at OIDC callback
  const consoleStart = await app.inject({
    method: "GET",
    url: "/api/v1/auth/web/start?return_to=/console"
  });
  const consoleTxn = app.store.authTransactions.get(consoleStart.body.data.login_txn);
  assert.equal(consoleTxn.flowKind, "WEB_CONSOLE");
  await assert.rejects(
    async () =>
      app.identity.handleOidcCallback({
        state: consoleTxn.serverState,
        code: "sim_console_code",
        simulatedIdTokenClaims: {
          iss: app.identity.expectedIssuer,
          aud: app.identity.clientId,
          sub: "student_member_sub_01",
          role: "member",
          nonce: consoleTxn.serverNonce,
          exp: Math.floor((Date.now() + 300_000) / 1000)
        }
      }),
    /仅管理员账号可登录云平台后台/
  );
});
