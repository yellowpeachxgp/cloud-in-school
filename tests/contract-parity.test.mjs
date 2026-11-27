import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import {
  REPO_ROOT,
  loadOpenApiText
} from "../packages/contracts/src/index.mjs";
import {
  parseEndpointInventory,
  parseOpenApiOperations,
  partitionByStatus
} from "../tools/contract-ci/contract-utils.mjs";
import { CONSOLE_UI_VERSION, CONSOLE_VIEWS, renderConsoleHtml } from "../apps/console/src/main.mjs";
import { MOMENTS_EXTENSION_CONTRACT_VERSION } from "../apps/api/src/routes/moments.mjs";

function routeKey(route) {
  return route.method + " " + route.path;
}

function byRouteKey(routes) {
  const out = new Map();
  for (const route of routes) {
    assert.ok(!out.has(routeKey(route)), "duplicate route key: " + routeKey(route));
    out.set(routeKey(route), route);
  }
  return out;
}

function sortedOperationIds(routes) {
  return routes.map((route) => route.operationId).sort();
}

function assertUniqueOperationIds(routes, label) {
  const operationIds = routes.map((route) => route.operationId);
  assert.equal(new Set(operationIds).size, operationIds.length, label + " operationIds must be unique");
}

function assertUniqueRouteKeys(routes, label) {
  const keys = routes.map((route) => routeKey(route));
  assert.equal(new Set(keys).size, keys.length, label + " method+path keys must be unique");
}

function loadInventoryOperations() {
  return parseEndpointInventory(fs.readFileSync(path.join(REPO_ROOT, "contracts/endpoints/endpoint-inventory.yaml"), "utf8"));
}

const EXPECTED_MOMENTS_EXTENSION_ROUTES = Object.freeze([
  { method: "GET", path: "/api/v1/moments/snapshot", operationId: "getMomentsSnapshot", auth: "public" },
  { method: "POST", path: "/api/v1/moments/posts", operationId: "createMomentsPost", auth: "public" },
  { method: "POST", path: "/api/v1/moments/posts/{postId}/comments", operationId: "addMomentsPostComment", auth: "public" },
  { method: "POST", path: "/api/v1/moments/posts/{postId}/contact-requests", operationId: "createMomentsContactRequest", auth: "bearer" },
  { method: "GET", path: "/api/v1/moments/posts/{postId}/contact-requests", operationId: "listMomentsContactRequests", auth: "bearer" },
  { method: "POST", path: "/api/v1/moments/posts/{postId}/contact-requests/{requestId}/action", operationId: "handleMomentsContactRequestAction", auth: "bearer" },
  { method: "POST", path: "/api/v1/moments/posts/{postId}/action", operationId: "mutateMomentsPost", auth: "public" },
  { method: "POST", path: "/api/v1/moments/books", operationId: "createMomentsBookListing", auth: "public" },
  { method: "POST", path: "/api/v1/moments/books/{bookId}/action", operationId: "mutateMomentsBookListing", auth: "public" },
  { method: "GET", path: "/api/v1/moments/isbn-resolve", operationId: "resolveMomentsIsbn", auth: "public" },
  { method: "POST", path: "/api/v1/moments/anti-lost-tags", operationId: "upsertAntiLostTag", auth: "public" },
  { method: "POST", path: "/api/v1/moments/anti-lost-tags/{tagCode}/report-found", operationId: "reportAntiLostTagFound", auth: "public" }
]);

const EXPECTED_CT01_PLANNED_ROUTES = Object.freeze([
  { method: "POST", path: "/api/v1/groups", operationId: "createGroup", auth: "bearer" },
  { method: "GET", path: "/api/v1/groups", operationId: "listGroups", auth: "bearer" },
  { method: "GET", path: "/api/v1/groups/{groupId}", operationId: "getGroup", auth: "bearer" },
  { method: "PATCH", path: "/api/v1/groups/{groupId}", operationId: "updateGroup", auth: "bearer" },
  { method: "DELETE", path: "/api/v1/groups/{groupId}", operationId: "deleteGroup", auth: "bearer" },
  { method: "POST", path: "/api/v1/groups/{groupId}/invites", operationId: "createGroupInvite", auth: "bearer" },
  { method: "POST", path: "/api/v1/group-invites/{code}/accept", operationId: "acceptGroupInvite", auth: "bearer" },
  { method: "DELETE", path: "/api/v1/groups/{groupId}/invites/{inviteId}", operationId: "revokeGroupInvite", auth: "bearer" },
  { method: "GET", path: "/api/v1/groups/{groupId}/members", operationId: "listGroupMembers", auth: "bearer" },
  { method: "PATCH", path: "/api/v1/groups/{groupId}/members/{memberId}", operationId: "updateGroupMember", auth: "bearer" },
  { method: "DELETE", path: "/api/v1/groups/{groupId}/members/{memberId}", operationId: "removeGroupMember", auth: "bearer" }
]);

test("Contract Parity: active core runtime, endpoint inventory, and OpenAPI operationIds are 100% bidirectional", () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const coreRegistered = app.getRegisteredCoreRoutes();
  const allRegistered = app.getRegisteredRoutes();
  const inventory = partitionByStatus(loadInventoryOperations()).active;
  const openApiOperations = partitionByStatus(parseOpenApiOperations(loadOpenApiText())).active;

  assert.equal(inventory.length, 97, "endpoint-inventory.yaml must declare exactly 97 active core operations");
  assert.equal(openApiOperations.length, 97, "OpenAPI must declare exactly 97 active core operations");
  assert.equal(coreRegistered.length, 97, "CampusCloudApp must expose exactly 97 active core operations");
  assert.equal(allRegistered.length, 109, "CampusCloudApp must expose 97 core + 12 explicit extension operations");

  const coreByKey = byRouteKey(coreRegistered);
  const inventoryByKey = byRouteKey(inventory);
  const openApiByKey = byRouteKey(openApiOperations);

  for (const inv of inventory) {
    const key = routeKey(inv);
    const reg = coreByKey.get(key);
    const openApi = openApiByKey.get(key);
    assert.ok(reg, "missing registered core route for active inventory entry: " + key);
    assert.ok(openApi, "missing active OpenAPI operation for active inventory entry: " + key);
    assert.equal(reg.operationId, inv.operationId, "runtime operationId mismatch on active " + key);
    assert.equal(openApi.operationId, inv.operationId, "OpenAPI operationId mismatch on active " + key);
    assert.equal(reg.auth, inv.auth, "auth mode mismatch on active " + key + " (" + reg.operationId + ")");
  }

  for (const openApi of openApiOperations) {
    const key = routeKey(openApi);
    const inv = inventoryByKey.get(key);
    const reg = coreByKey.get(key);
    assert.ok(inv, "active OpenAPI operation missing from active endpoint inventory: " + key);
    assert.ok(reg, "active OpenAPI operation missing from runtime core routes: " + key);
    assert.equal(inv.operationId, openApi.operationId, "inventory operationId mismatch on active " + key);
    assert.equal(reg.operationId, openApi.operationId, "runtime operationId mismatch on active " + key);
  }

  for (const reg of coreRegistered) {
    const key = routeKey(reg);
    assert.ok(inventoryByKey.has(key), "uninventoried shadow active core route registered: " + key);
    assert.ok(openApiByKey.has(key), "active OpenAPI shadow core route registered: " + key);
  }

  assert.deepEqual(sortedOperationIds(inventory), sortedOperationIds(coreRegistered), "active inventory/runtime operationId sets must be identical");
  assert.deepEqual(sortedOperationIds(openApiOperations), sortedOperationIds(coreRegistered), "active OpenAPI/runtime operationId sets must be identical");
});

test("Contract Parity: moments extension runtime inventory is exact and explicitly pending INF-02 (AUTO-012)", () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const extensionRegistered = app.getRegisteredExtensionRoutes();
  const inventory = loadInventoryOperations();
  const openApiOperations = parseOpenApiOperations(loadOpenApiText());
  const coreRegistered = app.getRegisteredCoreRoutes();

  assert.equal(MOMENTS_EXTENSION_CONTRACT_VERSION, "moments-extension/v0-pending-inf02");
  assert.equal(extensionRegistered.length, 12, "moments extension must expose exactly 12 runtime operations");
  assert.deepEqual(
    extensionRegistered,
    EXPECTED_MOMENTS_EXTENSION_ROUTES,
    "moments extension inventory must exactly match method+path+operationId+auth"
  );

  const inventoryKeys = byRouteKey(inventory);
  const openApiKeys = byRouteKey(openApiOperations);
  const coreOperationIds = new Set(coreRegistered.map((route) => route.operationId));
  const extensionOperationIds = new Set(extensionRegistered.map((route) => route.operationId));
  assert.equal(extensionOperationIds.size, extensionRegistered.length, "moments extension operationIds must be unique");

  for (const expected of EXPECTED_MOMENTS_EXTENSION_ROUTES) {
    const key = routeKey(expected);
    assert.ok(expected.path.startsWith("/api/v1/moments"), "moments extension path must stay under /api/v1/moments: " + key);
    assert.ok(!inventoryKeys.has(key), "moments extension must not be silently present in endpoint inventory before INF-02: " + key);
    assert.ok(!openApiKeys.has(key), "moments extension must not be silently present in OpenAPI before INF-02: " + key);
    assert.ok(!coreOperationIds.has(expected.operationId), "moments extension operationId must not overlap core: " + expected.operationId);
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

test("Web Portal & Execute-Now: UI_ASSET_VERSION matches CONSOLE_UI_VERSION, manual execute-now works pre-fire_at, and 0-peach stops at SKIPPED_FINANCE without external write", async () => {
  const appJsPath = new URL("../apps/console/public/static/app.js", import.meta.url);
  const appJsText = fs.readFileSync(appJsPath, "utf8");
  const versionMatch = appJsText.match(/const\s+UI_ASSET_VERSION\s*=\s*"([^"]+)"/);
  assert.ok(versionMatch, "app.js must declare UI_ASSET_VERSION");
  assert.equal(versionMatch[1], CONSOLE_UI_VERSION, "UI_ASSET_VERSION must match CONSOLE_UI_VERSION");

  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-14T10:15:00+08:00");

  // 1) 0-peach user calling execute-now stops cleanly at SKIPPED_FINANCE without invoking schoolProvider
  const start0 = await app.inject({ method: "GET", url: "/api/v1/auth/web/start?flow=portal", nowMs });
  const txn0 = app.store.authTransactions.get(start0.body.data.login_txn);
  const cb0 = await app.identity.handleOidcCallback(
    {
      state: txn0.serverState,
      code: "sim_0_peach",
      simulatedIdTokenClaims: {
        iss: app.identity.expectedIssuer,
        aud: app.identity.clientId,
        sub: "student_zero_peach",
        username: "zero_peach_user",
        role: "member",
        peachBalance: 0,
        nonce: txn0.serverNonce,
        exp: Math.floor((nowMs + 300_000) / 1000)
      }
    },
    nowMs
  );
  const ex0 = await app.inject({
    method: "POST",
    url: "/api/v1/auth/web/exchange",
    body: { login_txn: start0.body.data.login_txn, web_ticket: cb0.appTicket },
    nowMs
  });
  const token0 = ex0.body.data.access_token;
  app.financeBridge.setSandboxBalance(ex0.body.data.cloud_user_id || cb0.user.id, 0);
  const auth0 = { authorization: `Bearer ${token0}` };

  const c0 = await app.inject({ method: "POST", url: "/api/v1/me/consents", headers: auth0, body: { school_id: "haut" }, nowMs });
  const b0 = await app.inject({
    method: "POST",
    url: "/api/v1/school-bindings",
    headers: auth0,
    body: { school_id: "haut", student_no: "2024008801", consent_id: c0.body.data.id },
    nowMs
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${b0.body.data.id}/complete`,
    headers: auth0,
    body: { consent_id: c0.body.data.id, delegated_secret: "mock_secret_0" },
    nowMs
  });
  const p0 = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: auth0,
    body: {
      school_binding_id: b0.body.data.id,
      consent_id: c0.body.data.id,
      area_name: "五层中区",
      candidate_seats: ["01桌 A座"],
      target_local_date: "2026-11-14",
      target_local_time: "18:00:00"
    },
    nowMs
  });
  assert.equal(p0.status, 201);
  let externalWriteCalls = 0;
  const origExecute = app.schoolProvider.executeMockOrAuthorizedCreate.bind(app.schoolProvider);
  app.schoolProvider.executeMockOrAuthorizedCreate = async (...args) => {
    externalWriteCalls += 1;
    return origExecute(...args);
  };
  const exec0 = await app.inject({
    method: "POST",
    url: `/api/v1/reservation-jobs/${p0.body.data.job_id}/execute-now`,
    headers: auth0,
    body: {},
    nowMs
  });
  assert.equal(exec0.status, 200);
  assert.equal(exec0.body.data.job.state, "SKIPPED_FINANCE");
  assert.equal(externalWriteCalls, 0, "0-peach execute-now must stop at PRECHECK without dispatching external booking");

  // 2) Funded user calling execute-now BEFORE fire_at (10:15 vs 18:00) succeeds immediately
  const start1 = await app.inject({ method: "GET", url: "/api/v1/auth/web/start?flow=portal", nowMs });
  const txn1 = app.store.authTransactions.get(start1.body.data.login_txn);
  const cb1 = await app.identity.handleOidcCallback(
    {
      state: txn1.serverState,
      code: "sim_funded_peach",
      simulatedIdTokenClaims: {
        iss: app.identity.expectedIssuer,
        aud: app.identity.clientId,
        sub: "student_funded_peach",
        username: "funded_peach_user",
        role: "member",
        peachBalance: 5,
        nonce: txn1.serverNonce,
        exp: Math.floor((nowMs + 300_000) / 1000)
      }
    },
    nowMs
  );
  const ex1 = await app.inject({
    method: "POST",
    url: "/api/v1/auth/web/exchange",
    body: { login_txn: start1.body.data.login_txn, web_ticket: cb1.appTicket },
    nowMs
  });
  const auth1 = { authorization: `Bearer ${ex1.body.data.access_token}` };
  app.financeBridge.setSandboxBalance(ex1.body.data.cloud_user_id || cb1.user.id, 50_000);
  const c1 = await app.inject({ method: "POST", url: "/api/v1/me/consents", headers: auth1, body: { school_id: "haut" }, nowMs });
  const b1 = await app.inject({
    method: "POST",
    url: "/api/v1/school-bindings",
    headers: auth1,
    body: { school_id: "haut", student_no: "2024008802", consent_id: c1.body.data.id },
    nowMs
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${b1.body.data.id}/complete`,
    headers: auth1,
    body: { consent_id: c1.body.data.id, delegated_secret: "mock_secret_1" },
    nowMs
  });
  const p1 = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: auth1,
    body: {
      school_binding_id: b1.body.data.id,
      consent_id: c1.body.data.id,
      area_name: "五层中区",
      candidate_seats: ["01桌 B座"],
      target_local_date: "2026-11-14",
      target_local_time: "18:00:00"
    },
    nowMs
  });
  assert.equal(p1.status, 201);
  const exec1 = await app.inject({
    method: "POST",
    url: `/api/v1/reservation-jobs/${p1.body.data.job_id}/execute-now`,
    headers: auth1,
    body: {},
    nowMs
  });
  assert.equal(exec1.status, 200);
  assert.equal(exec1.body.data.job.state, "CONFIRMED");
  assert.equal(externalWriteCalls, 1);
});

test("Production Booking Safety & Moments Multi-Turn Chat Regression: no mock-fallback billing, SKIPPED_FINANCE disarms FIRE, kill-switch at FIRE, retryPendingDebits, idempotent consent/binding, and #9 multi-turn chat", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T06:20:00+08:00");

  async function loginStudent(sub, peachMicro) {
    const st = await app.inject({ method: "GET", url: "/api/v1/auth/web/start?flow=portal", nowMs });
    const txn = app.store.authTransactions.get(st.body.data.login_txn);
    const cb = await app.identity.handleOidcCallback(
      {
        state: txn.serverState,
        code: `sim_${sub}`,
        simulatedIdTokenClaims: {
          iss: app.identity.expectedIssuer,
          aud: app.identity.clientId,
          sub,
          username: sub,
          role: "member",
          peachBalance: peachMicro / 10000,
          nonce: txn.serverNonce,
          exp: Math.floor((nowMs + 3_600_000) / 1000)
        }
      },
      nowMs
    );
    const ex = await app.inject({
      method: "POST",
      url: "/api/v1/auth/web/exchange",
      body: { login_txn: st.body.data.login_txn, web_ticket: cb.appTicket },
      nowMs
    });
    const uid = ex.body.data.cloud_user_id || cb.user.id;
    app.financeBridge.setSandboxBalance(uid, peachMicro);
    return { uid, auth: { authorization: `Bearer ${ex.body.data.access_token}` } };
  }

  // 1) 06:30 SKIPPED_FINANCE disarms FINAL_CHECK and FIRE so 07:00 scheduler cannot bypass 0-peach!
  const uZero = await loginStudent("sub_skip_fin_guard", 0);
  const cZero = await app.inject({ method: "POST", url: "/api/v1/me/consents", headers: uZero.auth, body: { school_id: "haut" }, nowMs });
  const bZero = await app.inject({
    method: "POST",
    url: "/api/v1/school-bindings",
    headers: uZero.auth,
    body: { school_id: "haut", student_no: "2024990001", consent_id: cZero.body.data.id },
    nowMs
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${bZero.body.data.id}/complete`,
    headers: uZero.auth,
    body: { consent_id: cZero.body.data.id, delegated_secret: "mock_sec_skip" },
    nowMs
  });
  const planZero = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: uZero.auth,
    body: {
      school_binding_id: bZero.body.data.id,
      consent_id: cZero.body.data.id,
      area_name: "五层中区",
      candidate_seats: ["01桌 A座"],
      target_local_date: "2026-11-15",
      target_local_time: "07:00:00",
      repeat_days: 7,
      remaining_days: 7
    },
    nowMs
  });
  assert.equal(planZero.status, 201);
  const zeroJobId = planZero.body.data.job_id;
  await app.reservationEngine.runScheduleEvent(zeroJobId, "PRECHECK", Date.parse("2026-11-15T06:30:00+08:00"));
  assert.equal(app.store.reservationJobs.get(zeroJobId).state, "SKIPPED_FINANCE");
  const zeroEvents = app.store.eventsForJob(zeroJobId);
  assert.ok(zeroEvents.filter((e) => e.event_type !== "PRECHECK").every((e) => e.status !== "ARMED"));
  await app.reservationEngine.runScheduleEvent(zeroJobId, "FIRE", Date.parse("2026-11-15T07:00:00+08:00"));
  assert.equal(app.store.reservationJobs.get(zeroJobId).state, "SKIPPED_FINANCE", "FIRE must be a no-op after SKIPPED_FINANCE");
  assert.equal(app.store.recordsForUser("reservationJobs", uZero.uid).length, 1, "No Day 2 rollover after SKIPPED_FINANCE");

  // 2) Production allowSandboxFallback=false blocks non-live 'delegated_android_session' without charging 1 🍑
  const uProd = await loginStudent("sub_prod_nomock", 50_000);
  const cProd1 = await app.inject({ method: "POST", url: "/api/v1/me/consents", headers: uProd.auth, body: { school_id: "haut" }, nowMs });
  const cProd2 = await app.inject({ method: "POST", url: "/api/v1/me/consents", headers: uProd.auth, body: { school_id: "haut" }, nowMs });
  assert.equal(cProd2.body.data.id, cProd1.body.data.id, "POST /me/consents reuses active consent");
  const bProd1 = await app.inject({
    method: "POST",
    url: "/api/v1/school-bindings",
    headers: uProd.auth,
    body: { school_id: "haut", student_no: "2024990002", consent_id: cProd1.body.data.id },
    nowMs
  });
  const bProd2 = await app.inject({
    method: "POST",
    url: "/api/v1/school-bindings",
    headers: uProd.auth,
    body: { school_id: "haut", student_no: "2024990002", consent_id: cProd1.body.data.id },
    nowMs
  });
  assert.equal(bProd2.body.data.id, bProd1.body.data.id, "POST /school-bindings reuses active same-student_no binding");
  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${bProd1.body.data.id}/complete`,
    headers: uProd.auth,
    body: { consent_id: cProd1.body.data.id, delegated_secret: "delegated_android_session" },
    nowMs
  });
  const planProd = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: uProd.auth,
    body: {
      school_binding_id: bProd1.body.data.id,
      consent_id: cProd1.body.data.id,
      area_name: "五层中区",
      candidate_seats: ["01桌 C座"],
      target_local_date: "2026-11-15",
      target_local_time: "07:00:00"
    },
    nowMs
  });
  app.schoolProvider.allowSandboxFallback = false;
  try {
    // execute-now now requires an OPEN booking window (07:00-21:30 Asia/Shanghai)
    // for a TODAY booking — drive it at 07:00 so the credential check is reached.
    const execProd = await app.inject({
      method: "POST",
      url: `/api/v1/reservation-jobs/${planProd.body.data.job_id}/execute-now`,
      headers: uProd.auth,
      body: {},
      nowMs: Date.parse("2026-11-15T07:00:00+08:00")
    });
    assert.equal(execProd.body.data.job.state, "FAILED");
    assert.equal(app.store.recordsForUser("reservationOrders", uProd.uid).length, 0, "Zero orders/debits when non-live credential rejected");
  } finally {
    app.schoolProvider.allowSandboxFallback = true;
  }

  // 3) kill_switch enabled right before FIRE aborts FIRE cleanly with SCHOOL_KILL_SWITCH_ACTIVE
  const planKill = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: uProd.auth,
    body: {
      school_binding_id: bProd1.body.data.id,
      consent_id: cProd1.body.data.id,
      area_name: "五层中区",
      candidate_seats: ["01桌 D座"],
      target_local_date: "2026-11-16",
      target_local_time: "07:00:00"
    },
    nowMs
  });
  assert.equal(planKill.status, 201);
  const adminUser = app.store.findOrCreateCloudUser({
    issuer: app.identity.expectedIssuer,
    subject: "ops_killswitch_admin",
    username: "ops_killswitch_admin",
    role: "admin"
  });
  const adminSess = app.identity.issueDeviceSession(adminUser, "Admin KillSwitch");
  const adminAuth = { authorization: `Bearer ${adminSess.access_token}` };
  const ksOn = await app.inject({
    method: "POST",
    url: "/api/v1/admin/schools/haut/kill-switch",
    headers: adminAuth,
    body: { kill_switch: true }
  });
  assert.equal(ksOn.status, 200);
  try {
    await app.reservationEngine.runScheduleEvent(
      planKill.body.data.job_id,
      "FIRE",
      Date.parse("2026-11-16T07:00:00+08:00")
    );
    assert.equal(app.store.reservationJobs.get(planKill.body.data.job_id).state, "CANCELLED");
    assert.equal(app.store.reservationJobs.get(planKill.body.data.job_id).last_error_code, "SCHOOL_KILL_SWITCH_ACTIVE");
  } finally {
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/schools/haut/kill-switch",
      headers: adminAuth,
      body: { kill_switch: false }
    });
  }

  // 4) Transient SSO settlement error -> DEBIT_PENDING -> settled by retryPendingDebits()
  const planRetry = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: uProd.auth,
    body: {
      school_binding_id: bProd1.body.data.id,
      consent_id: cProd1.body.data.id,
      area_name: "五层中区",
      candidate_seats: ["02桌 A座"],
      target_local_date: "2026-11-17",
      target_local_time: "07:00:00"
    },
    nowMs
  });
  const origAdjust = app.financeBridge.adjustBalanceIdempotent.bind(app.financeBridge);
  let failOnce = true;
  app.financeBridge.adjustBalanceIdempotent = async (payload) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("Simulated transient SSO 502");
    }
    return origAdjust(payload);
  };
  try {
    await app.reservationEngine.runScheduleEvent(
      planRetry.body.data.job_id,
      "FIRE",
      Date.parse("2026-11-17T07:00:00+08:00")
    );
    const retryJob = app.store.reservationJobs.get(planRetry.body.data.job_id);
    assert.equal(retryJob.state, "CONFIRMED");
    assert.equal(retryJob.billing_state, "DEBIT_PENDING");
    const retryRes = await app.financeService.retryPendingDebits(Date.parse("2026-11-17T07:00:35+08:00"));
    assert.equal(retryRes.retried.length, 1);
    assert.equal(retryRes.retried[0].payment_state, "PAID");
    assert.equal(retryJob.billing_state, "PAID");
  } finally {
    app.financeBridge.adjustBalanceIdempotent = origAdjust;
  }

  // 5) Moments Lost & Found Multi-Turn Private Chat (#9)
  const uFinder = await loginStudent("sub_chat_finder", 10_000);
  const postRes = await app.inject({
    method: "POST",
    url: "/api/v1/moments/posts",
    headers: uProd.auth,
    body: {
      type: "LOST",
      title: "丢失深蓝色校园卡套",
      campus: "莲花街校区",
      location: "钟楼二楼",
      contact: "微信: owner_wx_99",
      contact_visibility: "ON_REQUEST"
    },
    nowMs
  });
  assert.equal(postRes.status, 201);
  const chatPostId = postRes.body.data.id;

  // Owner cannot send contact request to own post
  const selfReq = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${chatPostId}/contact-requests`,
    headers: uProd.auth,
    body: { message: "我自己测试一下" },
    nowMs
  });
  assert.equal(selfReq.status, 400);

  // Finder sends message 1 -> Owner replies via REPLY -> Finder replies via REPLY -> Owner APPROVEs
  const m1 = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${chatPostId}/contact-requests`,
    headers: uFinder.auth,
    body: { sender_name: "拾得同学", message: "同学你好，卡套背面是不是有小猫贴纸？", contact_info: "QQ: 889900" },
    nowMs
  });
  assert.equal(m1.status, 201);
  const threadId = m1.body.data.id;
  assert.equal(m1.body.data.messages.length, 1);

  const ownerSnap = await app.inject({ method: "GET", url: "/api/v1/moments/snapshot", headers: uProd.auth, nowMs });
  const ownerPostView = ownerSnap.body.data.posts.find((p) => p.id === chatPostId);
  assert.equal(ownerPostView.pending_contact_requests_count, 1);

  const m2 = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${chatPostId}/contact-requests/${threadId}/action`,
    headers: uProd.auth,
    body: { action: "REPLY", reply_message: "对的对的！卡号尾号是 3521！" },
    nowMs: nowMs + 1000
  });
  assert.equal(m2.status, 200);
  assert.equal(m2.body.data.messages.length, 2);
  assert.equal(m2.body.data.messages[1].sender_role, "OWNER");

  const m3 = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${chatPostId}/contact-requests/${threadId}/action`,
    headers: uFinder.auth,
    body: { action: "REPLY", reply_message: "核对上了！我放在钟楼值班室还是当面给你？" },
    nowMs: nowMs + 2000
  });
  assert.equal(m3.status, 200);
  assert.equal(m3.body.data.messages.length, 3);
  assert.equal(m3.body.data.messages[2].sender_role, "REQUESTER");

  const m4 = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${chatPostId}/contact-requests/${threadId}/action`,
    headers: uProd.auth,
    body: { action: "APPROVE", reply_message: "太感谢啦，加我微信当面拿吧！" },
    nowMs: nowMs + 3000
  });
  assert.equal(m4.status, 200);
  assert.equal(m4.body.data.status, "APPROVED");
  assert.equal(m4.body.data.messages.length, 4);
  assert.equal(m4.body.data.initiator_contact, "微信: owner_wx_99");
});

const EXPECTED_CT02_PLANNED_ROUTES = Object.freeze([
  { method: "PUT", path: "/api/v1/groups/{groupId}/availability/me", operationId: "replaceMyGroupAvailability", auth: "bearer" },
  { method: "DELETE", path: "/api/v1/groups/{groupId}/availability/me", operationId: "deleteMyGroupAvailability", auth: "bearer" },
  { method: "POST", path: "/api/v1/groups/{groupId}/availability/query", operationId: "queryGroupAvailability", auth: "bearer" },
  { method: "POST", path: "/api/v1/groups/{groupId}/polls", operationId: "createGroupPoll", auth: "bearer" },
  { method: "GET", path: "/api/v1/polls/{pollId}", operationId: "getGroupPoll", auth: "bearer" },
  { method: "POST", path: "/api/v1/polls/{pollId}/votes", operationId: "upsertGroupPollVote", auth: "bearer" },
  { method: "POST", path: "/api/v1/polls/{pollId}/confirm", operationId: "confirmGroupPoll", auth: "bearer" }
]);

const EXPECTED_CT03_PLANNED_ROUTES = Object.freeze([
  { method: "POST", path: "/api/v1/groups/{groupId}/ledger/entries", operationId: "createLedgerEntry", auth: "bearer" },
  { method: "GET", path: "/api/v1/groups/{groupId}/ledger/entries", operationId: "listLedgerEntries", auth: "bearer" },
  { method: "POST", path: "/api/v1/groups/{groupId}/ledger/entries/{entryId}/amend", operationId: "amendLedgerEntry", auth: "bearer" },
  { method: "GET", path: "/api/v1/groups/{groupId}/ledger/balances", operationId: "getLedgerBalances", auth: "bearer" },
  { method: "POST", path: "/api/v1/groups/{groupId}/settlements", operationId: "createSettlement", auth: "bearer" },
  { method: "GET", path: "/api/v1/groups/{groupId}/settlements", operationId: "listSettlements", auth: "bearer" },
  { method: "GET", path: "/api/v1/settlements/{settlementId}", operationId: "getSettlement", auth: "bearer" },
  { method: "POST", path: "/api/v1/settlements/{settlementId}/confirm", operationId: "confirmSettlement", auth: "bearer" },
  { method: "POST", path: "/api/v1/settlements/{settlementId}/cancel", operationId: "cancelSettlement", auth: "bearer" },
  { method: "POST", path: "/api/v1/groups/{groupId}/rotas", operationId: "createDutyRota", auth: "bearer" },
  { method: "GET", path: "/api/v1/groups/{groupId}/rotas", operationId: "listDutyRotas", auth: "bearer" },
  { method: "GET", path: "/api/v1/rotas/{rotaId}", operationId: "getDutyRota", auth: "bearer" },
  { method: "PATCH", path: "/api/v1/rotas/{rotaId}", operationId: "updateDutyRota", auth: "bearer" },
  { method: "GET", path: "/api/v1/groups/{groupId}/duty-tasks", operationId: "listDutyTasks", auth: "bearer" },
  { method: "POST", path: "/api/v1/duty-tasks/{taskId}/complete", operationId: "completeDutyTask", auth: "bearer" },
  { method: "POST", path: "/api/v1/duty-tasks/{taskId}/confirm", operationId: "confirmDutyTaskCompletion", auth: "bearer" },
  { method: "POST", path: "/api/v1/duty-tasks/{taskId}/skip", operationId: "skipDutyTask", auth: "bearer" },
  { method: "POST", path: "/api/v1/rotas/{rotaId}/swaps", operationId: "requestDutySwap", auth: "bearer" },
  { method: "GET", path: "/api/v1/rotas/{rotaId}/swaps", operationId: "listDutySwaps", auth: "bearer" },
  { method: "GET", path: "/api/v1/duty-swaps/{swapId}", operationId: "getDutySwap", auth: "bearer" },
  { method: "POST", path: "/api/v1/duty-swaps/{swapId}/resolve", operationId: "resolveDutySwap", auth: "bearer" },
  { method: "POST", path: "/api/v1/groups/{groupId}/repairs", operationId: "createRepairTicket", auth: "bearer" },
  { method: "GET", path: "/api/v1/groups/{groupId}/repairs", operationId: "listRepairTickets", auth: "bearer" },
  { method: "GET", path: "/api/v1/repairs/{repairId}", operationId: "getRepairTicket", auth: "bearer" },
  { method: "PATCH", path: "/api/v1/repairs/{repairId}", operationId: "updateRepairTicket", auth: "bearer" },
  { method: "POST", path: "/api/v1/repairs/{repairId}/status", operationId: "transitionRepairStatus", auth: "bearer" },
  { method: "POST", path: "/api/v1/repairs/{repairId}/review", operationId: "submitRepairReview", auth: "bearer" }
]);

const EXPECTED_CT_PLANNED_ROUTE_COUNT = EXPECTED_CT01_PLANNED_ROUTES.length + EXPECTED_CT02_PLANNED_ROUTES.length + EXPECTED_CT03_PLANNED_ROUTES.length;

test("Contract Parity: CT-01/CT-02/CT-03 planned group contracts are explicit, countable, unique, and runtime-inert", () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const coreRegistered = app.getRegisteredCoreRoutes();
  const inventoryPartitions = partitionByStatus(loadInventoryOperations());
  const openApiPartitions = partitionByStatus(parseOpenApiOperations(loadOpenApiText()));
  assert.deepEqual(inventoryPartitions.unknown, [], "endpoint inventory must use only active/planned/reserved statuses");
  assert.deepEqual(openApiPartitions.unknown, [], "OpenAPI x-dis-status must use only active/planned/reserved statuses");

  const plannedInventory = inventoryPartitions.planned;
  const plannedOpenApi = openApiPartitions.planned;
  const reservedInventory = inventoryPartitions.reserved;
  const reservedOpenApi = openApiPartitions.reserved;
  assert.equal(plannedInventory.length, EXPECTED_CT_PLANNED_ROUTE_COUNT, "endpoint-inventory.yaml must declare exactly the expected CT-01+CT-02+CT-03 planned operations");
  assert.equal(plannedOpenApi.length, EXPECTED_CT_PLANNED_ROUTE_COUNT, "OpenAPI must declare exactly the expected CT-01+CT-02+CT-03 planned operations");
  assertUniqueOperationIds(coreRegistered, "active core runtime");
  assertUniqueOperationIds(inventoryPartitions.active, "active endpoint inventory");
  assertUniqueOperationIds(openApiPartitions.active, "active OpenAPI");
  assertUniqueOperationIds(plannedInventory, "planned endpoint inventory");
  assertUniqueOperationIds(plannedOpenApi, "planned OpenAPI");
  assertUniqueRouteKeys(plannedInventory, "planned endpoint inventory");
  assertUniqueRouteKeys(plannedOpenApi, "planned OpenAPI");

  const ct01Inventory = plannedInventory.filter((entry) => entry.contractCard === "CT-01");
  assert.equal(ct01Inventory.length, EXPECTED_CT01_PLANNED_ROUTES.length, "CT-01 inventory entries must be explicitly countable");
  assert.deepEqual(
    ct01Inventory.map(({ method, path, operationId, auth }) => ({ method, path, operationId, auth })),
    EXPECTED_CT01_PLANNED_ROUTES,
    "CT-01 planned inventory must exactly match the approved group/invite/member route slice"
  );

  const ct02Inventory = plannedInventory.filter((entry) => entry.contractCard === "CT-02");
  assert.equal(ct02Inventory.length, EXPECTED_CT02_PLANNED_ROUTES.length, "CT-02 inventory entries must be explicitly countable");
  assert.deepEqual(
    ct02Inventory.map(({ method, path, operationId, auth }) => ({ method, path, operationId, auth })),
    EXPECTED_CT02_PLANNED_ROUTES,
    "CT-02 planned inventory must exactly match the approved availability/poll route slice"
  );

  const ct03Inventory = plannedInventory.filter((entry) => entry.contractCard === "CT-03");
  assert.equal(ct03Inventory.length, EXPECTED_CT03_PLANNED_ROUTES.length, "CT-03 inventory entries must be explicitly countable");
  assert.deepEqual(
    ct03Inventory.map(({ method, path, operationId, auth }) => ({ method, path, operationId, auth })),
    EXPECTED_CT03_PLANNED_ROUTES,
    "CT-03 planned inventory must exactly match the approved ledger/duty/repair route slice"
  );

  const coreByKey = byRouteKey(coreRegistered);
  const plannedInventoryByKey = byRouteKey(plannedInventory);
  const plannedOpenApiByKey = byRouteKey(plannedOpenApi);
  assert.deepEqual(sortedOperationIds(plannedInventory), sortedOperationIds(plannedOpenApi), "planned inventory/OpenAPI operationId sets must be identical");
  for (const planned of plannedInventory) {
    const key = routeKey(planned);
    const openApi = plannedOpenApiByKey.get(key);
    assert.ok(openApi, "planned inventory entry missing from planned OpenAPI operations: " + key);
    assert.equal(openApi.operationId, planned.operationId, "planned OpenAPI operationId mismatch on " + key);
    assert.equal(planned.status, "planned", "planned inventory entry must carry machine-readable status: " + key);
    assert.ok(/^CT-[0-9]+$/.test(planned.contractCard || ""), "planned inventory entry must carry machine-readable contract_card: " + key);
    assert.ok(planned.auth, "planned inventory entry must carry auth mode: " + key);
    assert.ok(!coreByKey.has(key), "planned contract-only endpoint must not silently exist in runtime before W4 implementation: " + key);
  }
  for (const planned of plannedOpenApi) {
    const key = routeKey(planned);
    assert.ok(plannedInventoryByKey.has(key), "planned OpenAPI operation missing from planned endpoint inventory: " + key);
    assert.equal(planned.status, "planned", "planned OpenAPI operation must carry x-dis-status planned: " + key);
  }

  console.log(
    "[CONTRACT-PARITY] active=97 planned=" + plannedOpenApi.length +
      " reserved=" + reservedOpenApi.length + " reserved_inventory=" + reservedInventory.length + " moments_extension=12"
  );
});
