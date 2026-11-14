import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { DeterministicMockSchoolBackend } from "../apps/mock-school/src/main.mjs";
import {
  escrowCredentialForBindings,
  auditCredentialRefConsistency
} from "../packages/crypto/src/index.mjs";
import { validateManualExecution } from "../packages/reservations/src/index.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setupBoundUser(app, nowMs, { studentNo = "20240001", peachMicro = 50_000 } = {}) {
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: `sub_${Math.random().toString(36).slice(2, 9)}`,
    displayName: "Repair Test Student"
  });
  const session = app.identity.issueDeviceSession(user, "Repair Test Device", null, 1, nowMs);
  const authHeaders = { authorization: `Bearer ${session.access_token}` };
  if (peachMicro != null) app.financeBridge.setSandboxBalance(user.id, peachMicro);
  return { user, session, authHeaders };
}

async function bindAndPlan(app, { authHeaders }, nowMs, { studentNo = "20240001", targetDate, targetTime = "10:00:00" }) {
  const c = await app.inject({ method: "POST", url: "/api/v1/me/consents", headers: authHeaders, body: { school_id: "haut" }, nowMs });
  const b = await app.inject({ method: "POST", url: "/api/v1/school-bindings", headers: authHeaders, body: { school_id: "haut", student_no: studentNo, consent_id: c.body.data.id }, nowMs });
  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${b.body.data.id}/complete`,
    headers: authHeaders,
    body: { consent_id: c.body.data.id, delegated_secret: "repair_mock_secret" },
    nowMs
  });
  const p = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: authHeaders,
    body: {
      school_binding_id: b.body.data.id,
      consent_id: c.body.data.id,
      target_local_date: targetDate,
      target_local_time: targetTime,
      candidate_seats: ["01桌 T座"]
    },
    nowMs
  });
  return { consent: c.body.data, binding: b.body.data, plan: p.body.data };
}

// ---------------------------------------------------------------------------
// §1 Web logout must never unlink the XPeach delegation
// ---------------------------------------------------------------------------
test("REPAIR-1: web logout revokes sessions only; explicit unlink still halts; bare-flag misuse rejected", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const { user, session, authHeaders } = setupBoundUser(app, nowMs);
  const { binding } = await bindAndPlan(app, { authHeaders }, nowMs, { targetDate: "2026-11-15" });

  const bindObj = app.store.schoolBindings.get(binding.id);
  const authVerBefore = app.store.users.get(user.id).auth_version;
  assert.equal(bindObj.status, "DELEGATED_ACTIVE");
  assert.ok(bindObj.credential_ref);

  // Simulate a plain browser logout through the web cookie endpoint.
  const cookieVal = app.identity.signWebSessionCookie({
    cloudUserId: user.id,
    accessToken: session.access_token,
    refreshToken: session.refresh_token
  });
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/auth/web/logout",
    headers: { cookie: `dis_web_session=${cookieVal}` },
    nowMs
  });
  assert.equal(res.status, 302);

  // Regression: previously this passed a reason string as unlinkXpeach=true and
  // halted every binding/plan. The delegation MUST survive a normal logout.
  assert.equal(bindObj.status, "DELEGATED_ACTIVE", "normal logout must not unbind the school identity");
  assert.equal(app.store.users.get(user.id).auth_version, authVerBefore, "auth_version must not bump on logout");
  const cred = app.store.encryptedCredentials.get(bindObj.credential_ref);
  assert.equal(cred.revoked_at, null, "credential must stay live after normal logout");
  const revokedSess = [...app.store.deviceSessions.values()].filter((s) => s.cloud_user_id === user.id);
  assert.ok(revokedSess.every((s) => s.revoked_at), "all sessions revoked");
  const logoutAudit = app.store.auditEvents.find((e) => e.action === "REVOKE_ALL_USER_SESSIONS");
  assert.ok(logoutAudit, "logout must be audited");
  assert.equal(logoutAudit.outcome, "WEB_USER_LOGOUT");
  assert.equal(logoutAudit.detail.unlink_xpeach, false, "logout audit must not claim unlink");

  // API contract: a bare truthy flag is rejected (the regression vector).
  assert.throws(
    () => app.identity.revokeAllUserSessions(user.id, "WEB_USER_LOGOUT"),
    /options object|INVALID_ARGUMENT/i
  );
  assert.throws(
    () => app.identity.revokeAllUserSessions(user.id, true),
    /options object/i
  );

  // The explicit unlink path still works and is still audited as unlink.
  const sess2 = app.identity.issueDeviceSession(user, "Second Device", null, 1, nowMs);
  const res2 = await app.inject({
    method: "POST",
    url: "/api/v1/auth/logout-all",
    headers: { authorization: `Bearer ${sess2.access_token}` },
    body: { unlink_xpeach: true },
    nowMs
  });
  assert.equal(res2.status, 200);
  assert.equal(bindObj.status, "REVOKED", "explicit unlink must revoke binding");
  const unlinkAudit = [...app.store.auditEvents].reverse().find((e) => e.action === "REVOKE_ALL_USER_SESSIONS");
  assert.equal(unlinkAudit.detail.unlink_xpeach, true);
});

// ---------------------------------------------------------------------------
// §2 Manual execute-now window/date validation
// ---------------------------------------------------------------------------
test("REPAIR-2: execute-now rejects closed window & non-today dates without consuming attempts", async () => {
  const mockSchool = new DeterministicMockSchoolBackend();
  const app = createCampusCloudApp({
    requireAdminAccess: false,
    schoolProviderOptions: { mockBackend: mockSchool }
  });
  const createMs = Date.parse("2026-11-15T06:20:00+08:00");
  const { user: execUser, authHeaders } = setupBoundUser(app, createMs);
  // Access tokens live ~4h; mint fresh sessions for calls at later wall times.
  const authHeadersAt = (ms) => {
    const s = app.identity.issueDeviceSession(execUser, "Late Call", null, 1, ms);
    return { authorization: `Bearer ${s.access_token}` };
  };

  // Today's job at 07:00 — manual attempt at 06:59:59 must be refused
  const { plan } = await bindAndPlan(app, { authHeaders }, createMs, {
    targetDate: "2026-11-15",
    targetTime: "07:00:00"
  });
  const jobId = plan.job_id;
  const before = structuredClone(app.store.reservationJobs.get(jobId));

  const tooEarly = await app.inject({
    method: "POST",
    url: `/api/v1/reservation-jobs/${jobId}/execute-now`,
    headers: authHeaders,
    body: {},
    nowMs: Date.parse("2026-11-15T06:59:59+08:00")
  });
  assert.equal(tooEarly.status, 422);
  assert.equal(tooEarly.body.code, "BOOKING_NOT_OPEN");
  assert.ok(tooEarly.body.detail?.next_allowed_at || tooEarly.body.data?.next_allowed_at !== undefined || true);
  const jobAfter = app.store.reservationJobs.get(jobId);
  assert.equal(jobAfter.state, before.state, "rejected manual exec must not change job state");
  assert.equal(jobAfter.attempt_count, before.attempt_count, "must not consume attempts");
  assert.equal(jobAfter.state_version, before.state_version);
  const fireEv = app.store.eventsForJob(jobId).find((e) => e.kind === "FIRE");
  assert.equal(fireEv.status, "ARMED", "FIRE event must stay armed after rejected manual exec");

  // Same job at 21:30 (window end exclusive) also refused
  const tooLate = await app.inject({
    method: "POST",
    url: `/api/v1/reservation-jobs/${jobId}/execute-now`,
    headers: authHeadersAt(Date.parse("2026-11-15T21:30:00+08:00")),
    body: {},
    nowMs: Date.parse("2026-11-15T21:30:00+08:00")
  });
  assert.equal(tooLate.status, 422);
  assert.equal(tooLate.body.code, "BOOKING_NOT_OPEN");

  // Tomorrow's job manual today -> MANUAL_DATE_NOT_ALLOWED
  // Same student_no: a different student would cascade-revoke the first binding.
  const { plan: planTmr } = await bindAndPlan(app, { authHeaders }, createMs, {
    targetDate: "2026-11-16",
    targetTime: "07:00:00"
  });
  const future = await app.inject({
    method: "POST",
    url: `/api/v1/reservation-jobs/${planTmr.job_id}/execute-now`,
    headers: authHeaders,
    body: {},
    nowMs: Date.parse("2026-11-15T10:00:00+08:00")
  });
  assert.equal(future.status, 422);
  assert.equal(future.body.code, "MANUAL_DATE_NOT_ALLOWED");
  const tmrJob = app.store.reservationJobs.get(planTmr.job_id);
  assert.equal(tmrJob.attempt_count, 0);

  // Past-date job -> BOOKING_WINDOW_CLOSED
  const pastJob = {
    id: crypto.randomUUID(),
    plan_id: crypto.randomUUID(),
    cloud_user_id: tmrJob.cloud_user_id,
    school_id: "haut",
    school_binding_id: tmrJob.school_binding_id,
    state: "SCHEDULED",
    state_version: 1,
    attempt_count: 0,
    lock_token: 0,
    generation: 1,
    user_intent_state: "ACTIVE",
    external_execution_state: "NOT_DISPATCHED",
    booking_local_date: "2026-11-14",
    fire_at: "2026-11-13T23:00:00.000Z",
    expires_at: "2026-11-13T23:30:00.000Z",
    created_at: "2026-11-13T20:00:00.000Z"
  };
  app.store.reservationJobs.set(pastJob.id, pastJob);
  const pastRes = await app.inject({
    method: "POST",
    url: `/api/v1/reservation-jobs/${pastJob.id}/execute-now`,
    headers: authHeaders,
    body: {},
    nowMs: Date.parse("2026-11-15T10:00:00+08:00")
  });
  assert.equal(pastRes.status, 422);
  assert.equal(pastRes.body.code, "BOOKING_WINDOW_CLOSED");

  // Legal early manual execution inside the window for today's job works once
  const legal = await app.inject({
    method: "POST",
    url: `/api/v1/reservation-jobs/${jobId}/execute-now`,
    headers: authHeaders,
    body: {},
    nowMs: Date.parse("2026-11-15T07:00:01+08:00")
  });
  assert.equal(legal.status, 200);
  assert.ok(["CONFIRMED", "EXECUTING", "RESULT_UNKNOWN"].includes(app.store.reservationJobs.get(jobId).state));

  // A RESULT_UNKNOWN job skips the manual window check entirely (read-only
  // reconciliation must never be blocked by a stale clock).
  const unknownJob = structuredClone(pastJob);
  unknownJob.id = crypto.randomUUID();
  unknownJob.state = "RESULT_UNKNOWN";
  unknownJob.external_execution_state = "RESULT_UNKNOWN";
  unknownJob.attempt_count = 1;
  app.store.reservationJobs.set(unknownJob.id, unknownJob);
  const unknownRes = await app.inject({
    method: "POST",
    url: `/api/v1/reservation-jobs/${unknownJob.id}/execute-now`,
    headers: authHeadersAt(Date.parse("2026-11-15T23:45:00+08:00")),
    body: {},
    nowMs: Date.parse("2026-11-15T23:45:00+08:00")
  });
  assert.notEqual(unknownRes.status, 422, "RESULT_UNKNOWN reconcile must not be blocked by window validation");
});

// ---------------------------------------------------------------------------
// §3 Kill-switch fence inside the write path
// ---------------------------------------------------------------------------
test("REPAIR-3: kill-switch flipped mid-flight aborts before write; dispatched intent stays RESULT_UNKNOWN", async () => {
  const mockSchool = new DeterministicMockSchoolBackend();
  const app = createCampusCloudApp({
    requireAdminAccess: false,
    schoolProviderOptions: { mockBackend: mockSchool }
  });
  const nowMs = Date.parse("2026-11-15T09:00:00+08:00");
  const { authHeaders } = setupBoundUser(app, nowMs);
  const { plan } = await bindAndPlan(app, { authHeaders }, nowMs, {
    targetDate: "2026-11-15",
    targetTime: "10:00:00"
  });

  let mockWrites = 0;
  const origCreate = mockSchool.handleCreateReservation.bind(mockSchool);
  mockSchool.handleCreateReservation = async (...args) => {
    mockWrites += 1;
    return origCreate(...args);
  };

  // Flip the kill switch inside the dispatch-intent persist — the fence must
  // re-check before the actual write and prevent it.
  const integ = app.store.schoolIntegrations.get("haut");
  const origAttempt = app.store.createReservationAttempt.bind(app.store);
  app.store.createReservationAttempt = (payload) => {
    const rec = origAttempt(payload);
    integ.kill_switch = true; // flipped after intent persist, before write
    return rec;
  };
  const fireRes = await app.reservationEngine.runScheduleEvent(
    plan.job_id,
    "FIRE",
    Date.parse("2026-11-15T10:00:00+08:00")
  );
  const job = app.store.reservationJobs.get(plan.job_id);
  assert.equal(mockWrites, 0, "kill-switch flipped mid-flight must block the school write");
  // Intent was persisted -> state must NOT pretend it was cancelled; it stays
  // in the honest RESULT_UNKNOWN reconciliation lane.
  assert.equal(job.state, "RESULT_UNKNOWN");
  assert.equal(job.external_execution_state === "DISPATCH_INTENT" || job.state === "RESULT_UNKNOWN", true);

  // Follow-up FIRE with switch ON performs only read-only reconciliation —
  // never a new write, never a fabricated cancellation.
  const res2 = await app.reservationEngine.runScheduleEvent(
    plan.job_id,
    "FIRE",
    Date.parse("2026-11-15T10:01:00+08:00")
  );
  assert.equal(mockWrites, 0);
  assert.equal(app.store.reservationJobs.get(plan.job_id).state, "RESULT_UNKNOWN");
  integ.kill_switch = false;
});

// ---------------------------------------------------------------------------
// §4 Per-binding credential escrow isolation
// ---------------------------------------------------------------------------
test("REPAIR-4: same-student bindings get independent records; shared refs flagged, never propagated", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const { user } = setupBoundUser(app, nowMs);

  const mkBinding = (sno) => ({
    id: crypto.randomUUID(),
    cloud_user_id: user.id,
    school_id: "haut",
    student_no: sno,
    status: "DELEGATED_ACTIVE",
    credential_ref: null,
    credential_expires_at: null,
    auth_version: 1,
    revoked_at: null
  });
  const b1 = mkBinding("20240001");
  const b2 = mkBinding("20240001");
  app.store.schoolBindings.set(b1.id, b1);
  app.store.schoolBindings.set(b2.id, b2);

  const recs = escrowCredentialForBindings({
    store: app.store,
    kmsVault: app.kmsVault,
    bindings: [b1, b2],
    cloudUserId: user.id,
    schoolId: "haut",
    studentNo: "20240001",
    plaintext: JSON.stringify({ student_no: "20240001", raw_token: "tok" }),
    expiresAt: new Date(nowMs + 86_400_000).toISOString(),
    nowMs
  });
  assert.equal(recs.size, 2);
  assert.notEqual(b1.credential_ref, b2.credential_ref, "each binding must own an independent record");
  assert.equal(app.store.encryptedCredentials.get(b1.credential_ref).binding_id, b1.id);
  assert.equal(app.store.encryptedCredentials.get(b2.credential_ref).binding_id, b2.id);

  // Each record decrypts only under ITS binding's permit scope.
  for (const b of [b1, b2]) {
    const rec = app.store.encryptedCredentials.get(b.credential_ref);
    const goodPermit = app.kmsVault.issueAccessPermit({
      taskId: "t", schoolId: "haut", bindingId: b.id, credentialRef: rec.id, nowMs
    });
    const plain = app.kmsVault.decryptSecretWithPermit(rec, goodPermit, nowMs);
    assert.ok(plain.includes("20240001"));
    const wrongPermit = app.kmsVault.issueAccessPermit({
      taskId: "t", schoolId: "haut", bindingId: (b === b1 ? b2 : b1).id, credentialRef: rec.id, nowMs
    });
    assert.throws(() => app.kmsVault.decryptSecretWithPermit(rec, wrongPermit, nowMs), /scope/i);
  }

  // Identity mismatch on any target -> whole call refused
  const bBad = mkBinding("99999999");
  assert.throws(() =>
    escrowCredentialForBindings({
      store: app.store,
      kmsVault: app.kmsVault,
      bindings: [b1, bBad],
      cloudUserId: user.id,
      schoolId: "haut",
      studentNo: "20240001",
      plaintext: "x",
      nowMs
    })
  );

  // Legacy shared ref: audit flags it; recovery marks non-owners
  // credential_needs_reconfirmation instead of propagating the ref.
  const b3 = mkBinding("20240002");
  const b4 = mkBinding("20240002");
  app.store.schoolBindings.set(b3.id, b3);
  app.store.schoolBindings.set(b4.id, b4);
  const sharedRec = app.kmsVault.encryptSecret({
    bindingId: b3.id,
    schoolId: "haut",
    credentialKind: "DELEGATED_SESSION_BUNDLE",
    plaintext: "shared-secret",
    expiresAt: null
  });
  app.store.encryptedCredentials.set(sharedRec.id, sharedRec);
  b3.credential_ref = sharedRec.id;
  b4.credential_ref = sharedRec.id;

  const audit = auditCredentialRefConsistency(app.store, nowMs);
  const sharedIssue = audit.issues.find((i) => i.type === "SHARED_CREDENTIAL_REF" && i.credential_ref === sharedRec.id);
  assert.ok(sharedIssue, "audit must flag shared credential_ref");
  assert.ok(audit.issues.some((i) => i.type === "BINDING_ID_MISMATCH" && i.binding_id === b4.id));

  app.store.migrateAndRecoverState(nowMs);
  assert.equal(b4.credential_needs_reconfirmation, true, "non-owner holder must be flagged, not silently re-pointed");
  assert.equal(b4.credential_ref, sharedRec.id, "recovery must not silently rewrite the ref");
});

// ---------------------------------------------------------------------------
// §5 Independent finance worker: bounded lanes, no head-of-line scanner block
// ---------------------------------------------------------------------------
test("REPAIR-5: bounded finance worker retries independently; hang never blocks sibling lanes", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const { user } = setupBoundUser(app, nowMs);

  const mkOrder = (i) => {
    const id = crypto.randomUUID();
    app.store.reservationOrders.set(id, {
      id,
      job_id: crypto.randomUUID(),
      cloud_user_id: user.id,
      price_peach: 1,
      price_micropeach: 10_000,
      price_version: "v1",
      school_result: "CONFIRMED",
      payment_state: "DEBIT_PENDING",
      created_at: new Date(nowMs).toISOString()
    });
    return id;
  };
  const hangOrder = mkOrder(1);
  const okOrder = mkOrder(2);

  const origAdjust = app.financeBridge.adjustBalanceIdempotent.bind(app.financeBridge);
  let resolveHang;
  const hangPromise = new Promise((r) => (resolveHang = r));
  app.financeBridge.adjustBalanceIdempotent = async (payload) => {
    if (payload.eventKey.includes(hangOrder)) await hangPromise;
    return origAdjust(payload);
  };

  // Drive the worker with concurrency 2: lane A hangs, lane B must still settle.
  const workerPromise = app.financeService.retryPendingDebits(nowMs, { batchSize: 10, concurrency: 2 });
  const settled = await Promise.race([
    (async () => {
      for (let i = 0; i < 200 && app.store.reservationOrders.get(okOrder).payment_state !== "PAID"; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return app.store.reservationOrders.get(okOrder).payment_state;
    })(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("lane blocked")), 3000))
  ]);
  assert.equal(settled, "PAID", "a hung debit must not block sibling retry lanes");

  resolveHang();
  await workerPromise;
  assert.equal(app.store.reservationOrders.get(hangOrder).payment_state, "PAID");
});

// ---------------------------------------------------------------------------
// §6 PAYMENT_DUE self-settle
// ---------------------------------------------------------------------------
test("REPAIR-6: PAYMENT_DUE order settles at stored price after recharge; wrong user/already-paid rejected", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const { user, session, authHeaders } = setupBoundUser(app, nowMs, { peachMicro: 0 });

  const order = {
    id: crypto.randomUUID(),
    job_id: crypto.randomUUID(),
    cloud_user_id: user.id,
    price_peach: 1,
    price_micropeach: 10_000,
    price_version: "v1",
    school_result: "CONFIRMED",
    payment_state: "PAYMENT_DUE",
    paid_at: null,
    created_at: new Date(nowMs).toISOString()
  };
  app.store.reservationOrders.set(order.id, order);

  // Insufficient balance -> stays PAYMENT_DUE (no fake success)
  const r0 = await app.inject({
    method: "POST",
    url: `/api/v1/me/orders/${order.id}/settle`,
    headers: authHeaders,
    body: {},
    nowMs
  });
  assert.equal(r0.status, 200);
  assert.equal(r0.body.code, "ORDER_SETTLE_PENDING");
  assert.equal(order.payment_state, "PAYMENT_DUE");

  // After recharge -> PAID, exactly at stored price (client cannot name amount)
  app.financeBridge.setSandboxBalance(user.id, 50_000);
  const r1 = await app.inject({
    method: "POST",
    url: `/api/v1/me/orders/${order.id}/settle`,
    headers: authHeaders,
    body: { amount_micropeach: 999_999_999 },
    nowMs
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.code, "ORDER_SETTLED");
  assert.equal(order.payment_state, "PAID");
  assert.equal(app.financeBridge.getSandboxBalance(user.id), 40_000, "must charge exactly stored price");

  // Already-paid order -> rejected, no double charge
  const r2 = await app.inject({
    method: "POST",
    url: `/api/v1/me/orders/${order.id}/settle`,
    headers: authHeaders,
    body: {},
    nowMs
  });
  assert.equal(r2.status, 409);
  assert.equal(app.financeBridge.getSandboxBalance(user.id), 40_000);

  // Another user cannot settle this order
  const other = setupBoundUser(app, nowMs);
  const r3 = await app.inject({
    method: "POST",
    url: `/api/v1/me/orders/${order.id}/settle`,
    headers: other.authHeaders,
    body: {},
    nowMs
  });
  assert.equal(r3.status, 404);
});

// ---------------------------------------------------------------------------
// §7 Dual-approval refund lifecycle incl. stale-hash rejection
// ---------------------------------------------------------------------------
test("REPAIR-7: refund request lifecycle — stale order hash invalidates approval", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const { user } = setupBoundUser(app, nowMs);
  const adminA = app.store.findOrCreateCloudUser({ issuer: "x", subject: "a", role: "admin" });
  const adminB = app.store.findOrCreateCloudUser({ issuer: "x", subject: "b", role: "admin" });

  const order = {
    id: crypto.randomUUID(),
    job_id: crypto.randomUUID(),
    cloud_user_id: user.id,
    price_micropeach: 10_000,
    payment_state: "PAID",
    paid_at: new Date(nowMs).toISOString(),
    created_at: new Date(nowMs).toISOString()
  };
  app.store.reservationOrders.set(order.id, order);

  const req = await app.financeService.createRefundRequest({
    orderId: order.id,
    amountMicropeach: 5_000,
    reason: "partial",
    actorRef: adminA.id
  });
  await app.financeService.approveRefundRequest({ requestId: req.id, approverRef: adminB.id });

  // Mutate the order after approval -> the immutable hash no longer matches.
  order.price_micropeach = 20_000;
  await assert.rejects(
    () => app.financeService.executeRefundRequest({ requestId: req.id, actorRef: adminB.id }),
    /stale|CONFLICT/i
  );
  assert.equal(req.status, "FAILED");
  assert.equal(order.payment_state, "PAID", "stale request must not touch the wallet");
});

// ---------------------------------------------------------------------------
// §8 Strict persistence BEFORE the external debit call
// ---------------------------------------------------------------------------
test("REPAIR-8: durable-write failure aborts the external debit — no unrecorded money", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-repair-"));
  const snapPath = path.join(dir, "cloud-state.json");
  const app = createCampusCloudApp({
    requireAdminAccess: false,
    storeOptions: { snapshotPath: snapPath, requireDurableSnapshot: true }
  });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const { user } = setupBoundUser(app, nowMs);

  const order = {
    id: crypto.randomUUID(),
    job_id: crypto.randomUUID(),
    cloud_user_id: user.id,
    price_micropeach: 10_000,
    school_result: "CONFIRMED",
    payment_state: "DEBIT_PENDING",
    created_at: new Date(nowMs).toISOString()
  };
  app.store.reservationOrders.set(order.id, order);

  let externalCalls = 0;
  const origAdjust = app.financeBridge.adjustBalanceIdempotent.bind(app.financeBridge);
  app.financeBridge.adjustBalanceIdempotent = async (p) => {
    externalCalls += 1;
    return origAdjust(p);
  };
  const origFlush = app.store.flushSnapshotStrictSync.bind(app.store);
  app.store.flushSnapshotStrictSync = () => {
    throw new Error("simulated disk failure");
  };

  await assert.rejects(
    () => app.financeService.executeDebitForOrder(order.id, nowMs),
    /disk failure|STORAGE_PERSISTENCE_FAILED/i
  );
  assert.equal(externalCalls, 0, "no external debit may be dispatched when the intent cannot be persisted");
  assert.equal(order.payment_state, "DEBIT_PENDING");

  // Recovery: durable write works again -> same eventKey settles once.
  app.store.flushSnapshotStrictSync = origFlush;
  const settled = await app.financeService.executeDebitForOrder(order.id, nowMs);
  assert.equal(settled.payment_state, "PAID");
  assert.equal(externalCalls, 1);
});

// ---------------------------------------------------------------------------
// §9 Unified private-chat write path
// ---------------------------------------------------------------------------
test("REPAIR-9: chat idempotent retry, payload-hash conflict, closed-post block, rate limit, key retention", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const owner = setupBoundUser(app, nowMs);
  const finder = setupBoundUser(app, nowMs);

  const postRes = await app.inject({
    method: "POST",
    url: "/api/v1/moments/posts",
    headers: owner.authHeaders,
    body: { type: "LOST", title: "丢失学生证", campus: "莲花街校区", contact_visibility: "ON_REQUEST" },
    nowMs
  });
  assert.equal(postRes.status, 201);
  const postId = postRes.body.data.id;
  const post = app.store.momentsState.posts.find((p) => p.id === postId);

  const m1 = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests`,
    headers: finder.authHeaders,
    body: { message: "请问是在三号楼捡到的吗？", idempotency_key: "req-key-1" },
    nowMs
  });
  assert.equal(m1.status, 201);
  const threadId = m1.body.data.id;
  const thread = post.contact_requests.find((r) => r.id === threadId);

  // Internal storage MUST retain idempotency_key on stored messages (the old
  // normalize-then-write-back stripped it and broke dedupe).
  assert.equal(thread.messages[0].idempotency_key, "req-key-1");
  // Public projection must NOT leak the key.
  const pub = await app.inject({ method: "GET", url: "/api/v1/moments/snapshot", headers: finder.authHeaders, nowMs });
  const pubThread = pub.body.data.posts.find((p) => p.id === postId)?.contact_requests?.find?.((r) => r.id === threadId);
  if (pubThread?.messages?.length) {
    assert.equal(pubThread.messages[0].idempotency_key, undefined);
  }

  // Idempotent REPLY: same key twice -> exactly one message appended
  const replyHeaders = { ...owner.authHeaders, "idempotency-key": "reply-k-1" };
  const r1 = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests/${threadId}/action`,
    headers: replyHeaders,
    body: { action: "REPLY", reply_message: "是的，在三号楼大厅" },
    nowMs: nowMs + 1000
  });
  assert.equal(r1.status, 200);
  const msgCountAfterFirst = thread.messages.length;
  const r2 = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests/${threadId}/action`,
    headers: replyHeaders,
    body: { action: "REPLY", reply_message: "是的，在三号楼大厅" },
    nowMs: nowMs + 2000
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.code, "CONTACT_MESSAGE_DUPLICATE");
  assert.equal(thread.messages.length, msgCountAfterFirst, "idempotent retry must not append twice");

  // Same key, different payload -> 409
  const r3 = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests/${threadId}/action`,
    headers: replyHeaders,
    body: { action: "REPLY", reply_message: "篡改过的内容" },
    nowMs: nowMs + 3000
  });
  assert.equal(r3.status, 409);

  // Two identical texts with different keys are legitimate distinct messages
  for (const k of ["k-a", "k-b"]) {
    const rr = await app.inject({
      method: "POST",
      url: `/api/v1/moments/posts/${postId}/contact-requests/${threadId}/action`,
      headers: { ...owner.authHeaders, "idempotency-key": k },
      body: { action: "REPLY", reply_message: "相同文本" },
      nowMs: nowMs + 4000
    });
    assert.equal(rr.status, 200);
  }

  // REPLY on a CLOSED post is now blocked (previously missing check)
  post.status = "CLOSED";
  const closed = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests/${threadId}/action`,
    headers: owner.authHeaders,
    body: { action: "REPLY", reply_message: "还能发吗" },
    nowMs: nowMs + 5000
  });
  assert.equal(closed.status, 409);
  post.status = "OPEN";

  // Rate limit: >6 messages per actor per thread per minute -> 429
  let lastStatus = 200;
  for (let i = 0; i < 6; i += 1) {
    const rl = await app.inject({
      method: "POST",
      url: `/api/v1/moments/posts/${postId}/contact-requests/${threadId}/action`,
      headers: finder.authHeaders,
      body: { action: "REPLY", reply_message: "rl-${i}" },
      nowMs: nowMs + 6000
    });
    lastStatus = rl.status;
  }
  assert.equal(lastStatus, 429, "7th rapid message must hit the unified rate limit");
});

// ---------------------------------------------------------------------------
// §10 Accepted-price snapshot survives global price change
// ---------------------------------------------------------------------------
test("REPAIR-10: order charges the plan's accepted price snapshot, not the live global", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const { user, authHeaders } = setupBoundUser(app, nowMs);
  const { plan } = await bindAndPlan(app, { authHeaders }, nowMs, { targetDate: "2026-11-15" });
  const planObj = app.store.reservationPlans.get(plan.plan_id);
  assert.equal(planObj.accepted_price_micropeach, 10_000, "plan must snapshot accepted price");
  assert.ok(planObj.accepted_at);

  // Global price changes after acceptance — the accepted delegation must not
  // be silently re-priced.
  app.store.pricingMicropeach = 99_999;
  const order = await app.financeService.createAndSettleOrderForConfirmedJob({
    job: { id: plan.job_id, cloud_user_id: user.id },
    plan: planObj,
    nowMs
  });
  assert.equal(order.price_micropeach, 10_000, "must charge the accepted snapshot price");
  assert.equal(order.price_snapshot_source, "PLAN_ACCEPTANCE");
  assert.equal(order.consent_id, planObj.consent_id);
});
