import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import vm from "node:vm";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { DeterministicMockSchoolBackend } from "../apps/mock-school/src/main.mjs";
import { renderConsoleHtml } from "../apps/console/src/main.mjs";

function createTestApp() {
  return createCampusCloudApp({
    requireAdminAccess: false,
    schoolProviderOptions: { mockBackend: new DeterministicMockSchoolBackend() }
  });
}

function setupUser(app, nowMs, { subject = `sub_${crypto.randomUUID().slice(0, 8)}`, peachMicro = 50_000 } = {}) {
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject,
    displayName: "Multi-Consent Student"
  });
  const session = app.identity.issueDeviceSession(user, "Test Device", null, 1, nowMs);
  const authHeaders = { authorization: `Bearer ${session.access_token}` };
  app.financeBridge.setSandboxBalance(user.id, peachMicro);
  return { user, session, authHeaders };
}

function seedConsent(store, userId, { id = crypto.randomUUID(), schoolId = "haut", authVersion = 1, grantedAt } = {}) {
  const c = {
    id,
    cloud_user_id: userId,
    school_id: schoolId,
    scope_list: ["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"],
    policy_version: "policy-2026-11-v4",
    auth_version: authVersion,
    granted_at: grantedAt,
    withdrawn_at: null
  };
  store.consents.set(id, c);
  store.indexUserScoped?.("consents", id, userId);
  return c;
}

function seedBindingWithCred(app, userId, { id = crypto.randomUUID(), schoolId = "haut", studentNo = "20240001", consentId, authVersion = 1, nowMs, reconfirmReason = null } = {}) {
  const binding = {
    id,
    cloud_user_id: userId,
    school_id: schoolId,
    student_no: studentNo,
    student_no_masked: "20***01",
    status: "DELEGATED_ACTIVE",
    credential_ref: null,
    credential_expires_at: new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString(),
    consent_id: consentId,
    auth_version: authVersion,
    created_at: new Date(nowMs).toISOString(),
    revoked_at: null,
    ...(reconfirmReason
      ? { credential_needs_reconfirmation: true, credential_reconfirm_reason: reconfirmReason }
      : {})
  };
  const rec = app.kmsVault.encryptSecret({
    bindingId: binding.id,
    schoolId,
    credentialKind: "DELEGATED_SESSION_BUNDLE",
    plaintext: JSON.stringify({ student_no: studentNo, raw_token: `tok_${binding.id}`, password: "pw" }),
    expiresAt: new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString(),
    nowMs
  });
  app.store.encryptedCredentials.set(rec.id, rec);
  binding.credential_ref = rec.id;
  app.store.schoolBindings.set(binding.id, binding);
  app.store.indexUserScoped?.("schoolBindings", binding.id, userId);
  return binding;
}

test("Multi-consent recovery: grantConsent, initiateSchoolBinding, live queries prefer latest consent & healthy binding, and FIRE succeeds", async () => {
  const app = createTestApp();
  const nowMs = Date.parse("2026-11-18T10:00:00+08:00");
  const { user, authHeaders } = setupUser(app, nowMs);

  // Historical un-withdrawn consents for same user & school (oldest -> newest)
  const c0 = seedConsent(app.store, user.id, { grantedAt: "2026-11-03T10:00:00.000Z" });
  const c1 = seedConsent(app.store, user.id, { grantedAt: "2026-11-03T12:00:00.000Z" });
  const c2 = seedConsent(app.store, user.id, { grantedAt: "2026-11-04T09:00:00.000Z" });
  // Interleaved other school consent should never shadow HAUT's latest consent
  seedConsent(app.store, user.id, { schoolId: "other_school", grantedAt: "2026-11-05T09:00:00.000Z" });

  // Healthy older binding aligned to c2 vs broken newest binding aligned to c0 + INTEGRITY_MISMATCH
  const bHealthy = seedBindingWithCred(app, user.id, { consentId: c2.id, nowMs });
  const bBroken = seedBindingWithCred(app, user.id, {
    consentId: c0.id,
    nowMs: nowMs + 1000,
    reconfirmReason: "INTEGRITY_MISMATCH"
  });

  // POST /me/consents must return latest active HAUT consent (c2), not oldest c0
  const consentRes = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: authHeaders,
    body: { school_id: "haut" },
    nowMs
  });
  assert.equal(consentRes.status, 201);
  assert.equal(consentRes.body.data.id, c2.id);

  // POST /school-bindings must prefer healthy binding instead of INTEGRITY_MISMATCH bBroken
  const bindRes = await app.inject({
    method: "POST",
    url: "/api/v1/school-bindings",
    headers: authHeaders,
    body: { school_id: "haut", student_no: "20240001", consent_id: c2.id },
    nowMs
  });
  assert.equal(bindRes.status, 201);
  assert.equal(bindRes.body.data.id, bHealthy.id);

  // Create plan and execute full lifecycle through FIRE without ABORTED_REVOKED
  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: authHeaders,
    body: {
      school_binding_id: bHealthy.id,
      consent_id: c2.id,
      area_name: "五层中区",
      candidate_seats: ["01桌 A座"],
      target_local_date: "2026-11-19",
      target_local_time: "07:00:00"
    },
    nowMs
  });
  assert.equal(planRes.status, 201);
  const jobId = planRes.body.data.job_id;

  await app.reservationEngine.runScheduleEvent(jobId, "PRECHECK", Date.parse("2026-11-19T06:30:00+08:00"));
  assert.equal(app.store.reservationJobs.get(jobId).state, "PRECHECK_OK");

  await app.reservationEngine.runScheduleEvent(jobId, "FINAL_CHECK", Date.parse("2026-11-19T06:55:00+08:00"));
  assert.equal(app.store.reservationJobs.get(jobId).state, "FINAL_CHECK_OK");

  await app.reservationEngine.runScheduleEvent(jobId, "FIRE", Date.parse("2026-11-19T07:00:00+08:00"));
  assert.equal(app.store.reservationJobs.get(jobId).state, "CONFIRMED");

  // Also assert live-regions picks bHealthy rather than bBroken (which had consent_id c0)
  let checkedToken = null;
  const origAuth = app.schoolProvider.authenticateHautSession.bind(app.schoolProvider);
  const origRegions = app.schoolProvider.fetchLiveStudyRegions.bind(app.schoolProvider);
  const origActive = app.schoolProvider.fetchCurrentActiveBooking.bind(app.schoolProvider);
  app.schoolProvider.authenticateHautSession = async (dec, b) => {
    checkedToken = b?.id;
    return {
      rawToken: "mock_live_tok",
      userInfo: { userName: "测试", department: "计科" }
    };
  };
  app.schoolProvider.fetchLiveStudyRegions = async () => ({
    booking_date: "2026-11-19",
    total_available: 1,
    regions: [{ region_id: 7, region_name: "五层中区", available: 1 }]
  });
  app.schoolProvider.fetchCurrentActiveBooking = async () => null;
  try {
    const lr = await app.inject({
      method: "GET",
      url: "/api/v1/schools/haut/library/live-regions?booking_date=2026-11-19",
      headers: authHeaders,
      nowMs
    });
    assert.equal(lr.status, 200);
    assert.equal(checkedToken, bHealthy.id);
  } finally {
    app.schoolProvider.authenticateHautSession = origAuth;
    app.schoolProvider.fetchLiveStudyRegions = origRegions;
    app.schoolProvider.fetchCurrentActiveBooking = origActive;
  }

  // Ensure c1 wasn't accidentally mutated or withdrawn
  assert.equal(c1.withdrawn_at, null);
});

test("Multi-consent recovery: bind-live picks school-scoped latest consent, clears INTEGRITY_MISMATCH after fresh escrow, and succeeds through FIRE", async () => {
  const app = createTestApp();
  const nowMs = Date.parse("2026-11-18T11:00:00+08:00");
  const { user, authHeaders } = setupUser(app, nowMs);

  const cHautOld = seedConsent(app.store, user.id, { schoolId: "haut", grantedAt: "2026-11-03T10:00:00.000Z" });
  const cHautLatest = seedConsent(app.store, user.id, { schoolId: "haut", grantedAt: "2026-11-04T10:00:00.000Z" });
  seedConsent(app.store, user.id, { schoolId: "other_school", grantedAt: "2026-11-05T10:00:00.000Z" });

  const bFlagged = seedBindingWithCred(app, user.id, {
    consentId: cHautOld.id,
    studentNo: "20240009",
    nowMs,
    reconfirmReason: "INTEGRITY_MISMATCH"
  });

  const origAuth = app.schoolProvider.authenticateHautSession.bind(app.schoolProvider);
  app.schoolProvider.authenticateHautSession = async ({ student_no, raw_token }) => ({
    rawToken: raw_token || `tok_mock_${student_no}_0123456789abcdef`,
    casTgc: "",
    casJsessionId: "",
    userInfo: { userNo: student_no, userName: "测试同学", department: "软件学院" }
  });
  let liveBind;
  try {
    liveBind = await app.inject({
      method: "POST",
      url: "/api/v1/school-bindings/bind-live",
      headers: authHeaders,
      body: {
        school_id: "haut",
        student_no: "20240009",
        raw_token: "tok_live_20240009_fake_session_00000001"
      },
      nowMs
    });
  } finally {
    app.schoolProvider.authenticateHautSession = origAuth;
  }
  assert.equal(liveBind.status, 201);
  assert.equal(liveBind.body.data.consent_id, cHautLatest.id);
  assert.equal(bFlagged.consent_id, cHautLatest.id);
  assert.equal(bFlagged.credential_needs_reconfirmation, false);
  assert.equal(bFlagged.credential_reconfirm_reason, null);

  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: authHeaders,
    body: {
      school_binding_id: bFlagged.id,
      consent_id: cHautLatest.id,
      area_name: "五层中区",
      candidate_seats: ["02桌 A座"],
      target_local_date: "2026-11-19",
      target_local_time: "07:00:00"
    },
    nowMs
  });
  assert.equal(planRes.status, 201);
  const jobId = planRes.body.data.job_id;
  await app.reservationEngine.runScheduleEvent(jobId, "PRECHECK", Date.parse("2026-11-19T06:30:00+08:00"));
  assert.equal(app.store.reservationJobs.get(jobId).state, "PRECHECK_OK");
  await app.reservationEngine.runScheduleEvent(jobId, "FINAL_CHECK", Date.parse("2026-11-19T06:55:00+08:00"));
  assert.equal(app.store.reservationJobs.get(jobId).state, "FINAL_CHECK_OK");
  await app.reservationEngine.runScheduleEvent(jobId, "FIRE", Date.parse("2026-11-19T07:00:00+08:00"));
  assert.equal(app.store.reservationJobs.get(jobId).state, "CONFIRMED");
});

test("createPlanAndJob fails fast with CONSENT_WITHDRAWN when caller explicitly supplies a superseded consent", async () => {
  const app = createTestApp();
  const nowMs = Date.parse("2026-11-18T12:00:00+08:00");
  const { user, authHeaders } = setupUser(app, nowMs);

  const cOld = seedConsent(app.store, user.id, { grantedAt: "2026-11-03T10:00:00.000Z" });
  seedConsent(app.store, user.id, { grantedAt: "2026-11-04T10:00:00.000Z" });
  const bOld = seedBindingWithCred(app, user.id, { consentId: cOld.id, nowMs });

  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: authHeaders,
    body: {
      school_binding_id: bOld.id,
      consent_id: cOld.id,
      area_name: "五层中区",
      candidate_seats: ["01桌 B座"],
      target_local_date: "2026-11-19",
      target_local_time: "07:00:00"
    },
    nowMs
  });
  assert.equal(planRes.status, 403);
  assert.equal(planRes.body.code, "CONSENT_WITHDRAWN");
  assert.equal(app.store.recordsForUser("reservationPlans", user.id).length, 0);
});

test("migrateAndRecoverState realigns active bindings onto latestActiveConsent without resurrecting stopped historical plans or auto-clearing reconfirm flags", () => {
  const app = createTestApp();
  const nowMs = Date.parse("2026-11-18T12:30:00+08:00");
  const { user } = setupUser(app, nowMs);

  const c0 = seedConsent(app.store, user.id, { grantedAt: "2026-11-03T10:00:00.000Z" });
  const c1 = seedConsent(app.store, user.id, { grantedAt: "2026-11-03T11:00:00.000Z" });
  const cLatest = seedConsent(app.store, user.id, { grantedAt: "2026-11-04T12:00:00.000Z" });

  const b0 = seedBindingWithCred(app, user.id, { consentId: c0.id, nowMs });
  const b1 = seedBindingWithCred(app, user.id, {
    consentId: c0.id,
    nowMs: nowMs + 1000,
    reconfirmReason: "INTEGRITY_MISMATCH"
  });
  const bNonIntegrity = seedBindingWithCred(app, user.id, {
    consentId: c1.id,
    nowMs: nowMs + 2000,
    reconfirmReason: "SHARED_NO_TARGET"
  });

  const histPlanId = crypto.randomUUID();
  const histPlan = {
    id: histPlanId,
    cloud_user_id: user.id,
    school_binding_id: b0.id,
    consent_id: c0.id,
    student_no: "20240001",
    auth_version: 1,
    area_name: "四层西书库北区",
    candidate_seats: ["03桌 A座"],
    target_local_date: "2026-11-18",
    target_local_time: "07:00:00",
    enabled: false,
    user_intent_state: "STOP_REQUESTED",
    last_error_code: "CONSENT_WITHDRAWN"
  };
  app.store.reservationPlans.set(histPlanId, histPlan);
  app.store.indexUserScoped?.("reservationPlans", histPlanId, user.id);

  app.store.migrateAndRecoverState(nowMs + 5000);

  assert.equal(b0.consent_id, cLatest.id);
  assert.equal(b1.consent_id, cLatest.id);
  assert.equal(bNonIntegrity.consent_id, cLatest.id);
  // Historical aborted plan remains untouched & stopped
  assert.equal(histPlan.enabled, false);
  assert.equal(histPlan.user_intent_state, "STOP_REQUESTED");
  assert.equal(histPlan.consent_id, c0.id);
  // Startup recovery never auto-clears reconfirmation flags (R3/R4 invariant)
  assert.equal(b1.credential_needs_reconfirmation, true);
  assert.equal(b1.credential_reconfirm_reason, "INTEGRITY_MISMATCH");
  assert.equal(bNonIntegrity.credential_needs_reconfirmation, true);
  assert.equal(bNonIntegrity.credential_reconfirm_reason, "SHARED_NO_TARGET");
});

test("Web /reservations portal ensureBindingAndConsent picks healthy binding and latest active consent even when binding carries stale consent_id", async () => {
  const html = renderConsoleHtml({ user: { id: "web_u1" }, activeNav: "reservations" });
  const start = html.indexOf("function ensureBindingAndConsent()");
  const end = html.indexOf("function createReservationPlanFromSelection()", start);
  assert.ok(start > 0 && end > start, "ensureBindingAndConsent function must exist in rendered reservations HTML");

  const context = vm.createContext({
    Promise,
    Number,
    String,
    JSON,
    Error,
    apiFetch(url) {
      if (url === "/api/v1/school-bindings") {
        return Promise.resolve({
          data: {
            bindings: [
              {
                id: "b_healthy",
                school_id: "haut",
                status: "DELEGATED_ACTIVE",
                auth_version: 1,
                consent_id: "c_old",
                credential_ref: "cred_ok",
                credential_needs_reconfirmation: false
              },
              {
                id: "b_broken_newer",
                school_id: "haut",
                status: "DELEGATED_ACTIVE",
                auth_version: 1,
                consent_id: "c_old",
                credential_ref: "cred_bad",
                credential_needs_reconfirmation: true
              }
            ]
          }
        });
      }
      if (url === "/api/v1/me/consents") {
        return Promise.resolve({
          data: {
            consents: [
              { id: "c_old", school_id: "haut", auth_version: 1, withdrawn_at: null },
              { id: "c_latest", school_id: "haut", auth_version: 1, withdrawn_at: null }
            ]
          }
        });
      }
      throw new Error("Unexpected extra POST/call: " + url);
    }
  });

  vm.runInContext(html.slice(start, end), context);
  const res = await context.ensureBindingAndConsent();
  assert.equal(res.bindingId, "b_healthy");
  assert.equal(res.consentId, "c_latest");
});
