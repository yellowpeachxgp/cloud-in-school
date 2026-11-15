import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { DeterministicMockSchoolBackend } from "../apps/mock-school/src/main.mjs";
import { KmsEnvelopeVault } from "../packages/crypto/src/index.mjs";
import {
  classifyMigrationCandidate,
  rekeySharedCredentialRefs
} from "../scripts/rekey-shared-credential-refs.mjs";

function setupBoundUser(app, nowMs, { peachMicro = 50_000 } = {}) {
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: `r3_${Math.random().toString(36).slice(2, 9)}`,
    displayName: "R3 Student"
  });
  const session = app.identity.issueDeviceSession(user, "R3 Device", null, 1, nowMs);
  if (peachMicro != null) app.financeBridge.setSandboxBalance(user.id, peachMicro);
  return { user, session, authHeaders: { authorization: `Bearer ${session.access_token}` } };
}

function setupAdmin(app) {
  const user = app.store.findOrCreateCloudUser({
    issuer: app.identity.expectedIssuer,
    subject: `r3_admin_${Math.random().toString(36).slice(2, 9)}`,
    username: "r3_admin",
    role: "admin"
  });
  const sess = app.identity.issueDeviceSession(user, "R3 Admin");
  return { user, authHeaders: { authorization: `Bearer ${sess.access_token}` } };
}

function craftPaidOrder(app, userId, priceMicro = 10_000) {
  const order = {
    id: crypto.randomUUID(),
    order_no: "R3-" + crypto.randomUUID().slice(0, 8),
    cloud_user_id: userId,
    payment_state: "PAID",
    price_micropeach: priceMicro,
    price_peach: priceMicro / 10_000,
    created_at: new Date().toISOString()
  };
  app.store.reservationOrders.set(order.id, order);
  return order;
}

// ---------------------------------------------------------------------------
// F1: HTTP 404 can NEVER prove a refund was never received — every ambiguous
// probe outcome stays UNKNOWN, op stays queued, no new refund request unlocks.
// ---------------------------------------------------------------------------
test("R3-1: bare-404/timeout/unverified-readback probes fail CLOSED into UNKNOWN", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const student = setupBoundUser(app, Date.now(), { peachMicro: 0 });
  const order = craftPaidOrder(app, student.user.id);
  const admin = setupAdmin(app);
  const eventKey = `dis:reservation:${order.id}:refund:v1`;

  // Force "real" bridge mode: the read-back contract is unverified — even a
  // clean 404 is ambiguous (route? gateway? retention?).
  app.financeBridge.realDebitsEnabled = true;
  const outcomes = [];
  app.financeBridge.queryOperationResult = app.financeBridge.queryOperationResult.bind(app.financeBridge);

  app.store.financeOperations.set(eventKey, {
    id: crypto.randomUUID(),
    order_id: order.id,
    kind: "REFUND",
    event_key: eventKey,
    amount_micropeach: 10_000,
    refund_request_id: null,
    status: "IN_FLIGHT",
    attempt_count: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  app.store.migrateAndRecoverState(Date.now());

  const probe = await app.financeBridge.queryOperationResult(eventKey, {
    expectedMicropeach: 10_000,
    cloudUserId: student.user.id
  });
  assert.equal(probe.outcome, "UNKNOWN", "unverified readback contract must never assert non-receipt");

  const rec = await app.inject({
    method: "POST",
    url: `/api/v1/admin/orders/${order.id}/refund-reconcile`,
    headers: admin.authHeaders,
    body: {}
  });
  assert.equal(rec.body.data.reconciled, "UNKNOWN");
  assert.equal(app.store.financeOperations.get(eventKey).status, "IN_FLIGHT", "op must NOT be terminally failed on ambiguous evidence");

  // A bare-404 fake (route missing, gateway 404) also proves nothing.
  app.financeBridge.queryOperationResult = async () => ({ outcome: "UNKNOWN", reason: "probe_http_404" });
  const rec2 = await app.inject({
    method: "POST",
    url: `/api/v1/admin/orders/${order.id}/refund-reconcile`,
    headers: admin.authHeaders,
    body: {}
  });
  assert.equal(rec2.body.data.reconciled, "UNKNOWN");

  // And still no new refund may be created — the op is unresolved.
  const blocked = await app.inject({
    method: "POST",
    url: `/api/v1/admin/orders/${order.id}/refund-requests`,
    headers: admin.authHeaders,
    body: { reason: "must stay blocked", amount_micropeach: 10_000 }
  });
  assert.equal(blocked.status, 409);
});

test("R3-2: verified APPLIED converges; proven NOT_APPLIED unlocks; evidence persisted", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const student = setupBoundUser(app, Date.now(), { peachMicro: 0 });
  const admin = setupAdmin(app);

  // Case A: APPLIED
  const orderA = craftPaidOrder(app, student.user.id);
  const keyA = `dis:reservation:${orderA.id}:refund:v1`;
  app.store.financeOperations.set(keyA, {
    id: crypto.randomUUID(), order_id: orderA.id, kind: "REFUND", event_key: keyA,
    amount_micropeach: 10_000, refund_request_id: null, status: "IN_FLIGHT",
    attempt_count: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  app.financeBridge.queryOperationResult = async (k) => ({
    outcome: "APPLIED", event_key: k, provider: "probe", protocol_version: "v1",
    probed_at: new Date().toISOString(), result: { sso_request_id: "sso_1" }
  });
  const rA = await app.inject({
    method: "POST", url: `/api/v1/admin/orders/${orderA.id}/refund-reconcile`,
    headers: admin.authHeaders, body: {}
  });
  assert.equal(rA.body.data.reconciled, "SUCCEEDED");
  assert.equal(app.store.reservationOrders.get(orderA.id).payment_state, "REFUNDED");
  assert.ok(app.store.financeOperations.get(keyA).reconcile_evidence, "evidence must persist on the op");

  // Case B: PROVEN_NOT_APPLIED — unlocks a fresh dual-person request
  const orderB = craftPaidOrder(app, student.user.id);
  const keyB = `dis:reservation:${orderB.id}:refund:v1`;
  app.store.financeOperations.set(keyB, {
    id: crypto.randomUUID(), order_id: orderB.id, kind: "REFUND", event_key: keyB,
    amount_micropeach: 10_000, refund_request_id: null, status: "IN_FLIGHT",
    attempt_count: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  app.financeBridge.queryOperationResult = async (k) => ({
    outcome: "PROVEN_NOT_APPLIED", event_key: k, provider: "probe", protocol_version: "v1",
    probed_at: new Date().toISOString(), result: { status: "NOT_RECEIVED" }
  });
  const rB = await app.inject({
    method: "POST", url: `/api/v1/admin/orders/${orderB.id}/refund-reconcile`,
    headers: admin.authHeaders, body: {}
  });
  assert.equal(rB.body.data.reconciled, "NEVER_RECEIVED");
  const freed = await app.inject({
    method: "POST", url: `/api/v1/admin/orders/${orderB.id}/refund-requests`,
    headers: admin.authHeaders, body: { reason: "verified never received", amount_micropeach: 10_000 }
  });
  assert.equal(freed.status, 202);
});

// ---------------------------------------------------------------------------
// C1: RESULT_UNKNOWN resume must probe read-only FIRST; a same-key POST only
// after proven-safe key reuse or proven non-application.
// ---------------------------------------------------------------------------
test("R3-3: RESULT_UNKNOWN resume probes before any re-POST; unverified real bridge stays manual", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const student = setupBoundUser(app, Date.now(), { peachMicro: 0 });
  const order = craftPaidOrder(app, student.user.id);
  const adminA = setupAdmin(app);
  const adminB = setupAdmin(app);

  const created = await app.inject({
    method: "POST", url: `/api/v1/admin/orders/${order.id}/refund-requests`,
    headers: adminA.authHeaders, body: { reason: "resume-probe test", amount_micropeach: 10_000 }
  });
  const reqId = created.body.data.refund_request.id;
  await app.inject({
    method: "POST", url: `/api/v1/admin/refund-requests/${reqId}/approve`,
    headers: adminB.authHeaders, body: {}
  });

  // Timeout on dispatch -> RESULT_UNKNOWN
  const origAdjust = app.financeBridge.adjustBalanceIdempotent.bind(app.financeBridge);
  let once = true;
  app.financeBridge.adjustBalanceIdempotent = async (a) => {
    if (once) { once = false; throw Object.assign(new Error("timeout"), { code: "SSO_TIMEOUT" }); }
    return origAdjust(a);
  };
  await app.inject({
    method: "POST", url: `/api/v1/admin/refund-requests/${reqId}/execute`,
    headers: adminB.authHeaders, body: {}
  });
  assert.equal(app.store.refundRequests.get(reqId).status, "RESULT_UNKNOWN");

  // Unverified upstream contract: query returns UNKNOWN and key reuse is NOT
  // proven — the resume must refuse to re-POST.
  app.financeBridge.realDebitsEnabled = true;
  app.financeBridge.queryOperationResult = async () => ({ outcome: "UNKNOWN", reason: "probe_unresolved" });
  let postCount = 0;
  app.financeBridge.adjustBalanceIdempotent = async (a) => { postCount += 1; return origAdjust(a); };
  const resumeBlocked = await app.inject({
    method: "POST", url: `/api/v1/admin/refund-requests/${reqId}/execute`,
    headers: adminB.authHeaders, body: {}
  });
  assert.equal(resumeBlocked.status, 409);
  assert.equal(postCount, 0, "no re-POST when key reuse is unproven");
  assert.match(app.store.refundRequests.get(reqId).result_error, /MANUAL_REVIEW/);

  // Now the upstream contract IS verified: APPLIED converges without a write.
  app.financeBridge.queryOperationResult = async (k) => ({
    outcome: "APPLIED", event_key: k, result: { sso_request_id: "s1" }
  });
  const resumeConverge = await app.inject({
    method: "POST", url: `/api/v1/admin/refund-requests/${reqId}/execute`,
    headers: adminB.authHeaders, body: {}
  });
  assert.equal(resumeConverge.status, 200);
  assert.equal(postCount, 0, "APPLIED readback converges with zero money writes");
  assert.equal(app.store.reservationOrders.get(order.id).payment_state, "REFUNDED");
});

// ---------------------------------------------------------------------------
// S1: lifecycle registry covers background tasks, not just HTTP.
// ---------------------------------------------------------------------------
test("R3-4: lifecycle registry tracks scanner/finance/http tasks and drain state", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const t1 = app.registerLifecycleTask("scanner");
  const t2 = app.registerLifecycleTask("finance");
  const t3 = app.registerLifecycleTask("scanner");
  let counts = app.getInFlightTasks();
  assert.deepEqual(counts, { scanner: 2, finance: 1 });
  app.unregisterLifecycleTask(t1);
  counts = app.getInFlightTasks();
  assert.deepEqual(counts, { scanner: 1, finance: 1 });
  app.unregisterLifecycleTask(t2);
  app.unregisterLifecycleTask(t3);
  assert.deepEqual(app.getInFlightTasks(), {});
  // draining fence stays coherent
  const { authHeaders } = setupBoundUser(app, Date.now());
  app.setDraining(true);
  const res = await app.inject({ method: "POST", url: "/api/v1/me/consents", headers: authHeaders, body: { school_id: "haut" } });
  assert.equal(res.status, 503);
  assert.equal(app.isDraining(), true);
});

// ---------------------------------------------------------------------------
// M1: authorization-type reconfirm reasons can never be cleared by migration.
// ---------------------------------------------------------------------------
test("R3-5: rekey never decrypts or clears non-integrity reconfirm reasons", () => {
  const nowMs = Date.now();
  const vault = new KmsEnvelopeVault({});
  const owner = {
    id: "bnd_o", cloud_user_id: "u1", school_id: "haut", student_no: "2024001",
    status: "DELEGATED_ACTIVE", credential_ref: null
  };
  const shared = vault.encryptSecret({
    bindingId: owner.id, schoolId: "haut", credentialKind: "DELEGATED_SESSION_BUNDLE",
    plaintext: JSON.stringify({ session_id: "S" }),
    expiresAt: new Date(nowMs + 3600_000).toISOString()
  });
  owner.credential_ref = shared.id;
  const mk = (id, reason) => ({
    id, cloud_user_id: "u1", school_id: "haut", student_no: "2024001",
    status: "VERIFIED_LOCAL_ONLY", credential_ref: shared.id,
    credential_needs_reconfirmation: true, credential_reconfirm_reason: reason
  });
  const risk = mk("bnd_risk", "RISK_REVIEW");
  const revoked = mk("bnd_revoked", "USER_REVOKED");
  const unknown = mk("bnd_unknown", null);
  const integrity = mk("bnd_integ", "INTEGRITY_MISMATCH");
  const state = {
    schoolBindings: [[owner.id, owner], [risk.id, risk], [revoked.id, revoked], [unknown.id, unknown], [integrity.id, integrity]],
    encryptedCredentials: [[shared.id, shared]]
  };
  const { rawState: out, report } = rekeySharedCredentialRefs(structuredClone(state), vault, { nowMs, apply: true });
  const b = new Map(out.schoolBindings);
  // Integrity-caused flag: migrated + cleared.
  assert.notEqual(b.get("bnd_integ").credential_ref, shared.id);
  assert.equal(b.get("bnd_integ").credential_needs_reconfirmation, false);
  // Authorization/unknown causes: untouched — no decrypt, same ref, flag kept.
  for (const id of ["bnd_risk", "bnd_revoked", "bnd_unknown"]) {
    assert.equal(b.get(id).credential_ref, shared.id, id + " must not be re-keyed");
    assert.equal(b.get(id).credential_needs_reconfirmation, true, id + " flag must survive");
  }
  assert.equal(report.rekeyed.length, 1);
  assert.ok(report.skipped.some((x) => String(x.reason).includes("RECONFIRM_REASON_NOT_CLEARABLE")));
});

// ---------------------------------------------------------------------------
// C1/C2: one canonical formula — cross-entry retry dedupes; separator fields
// can never collide; legacy receipts verify by version.
// ---------------------------------------------------------------------------
test("R3-6: second-message retry via create entry dedupes (was 409); separator ambiguity rejected honestly", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const owner = setupBoundUser(app, nowMs);
  const finder = setupBoundUser(app, nowMs);

  const postRes = await app.inject({
    method: "POST", url: "/api/v1/moments/posts", headers: owner.authHeaders,
    body: { type: "LOST", title: "丢失书包", campus: "莲花街校区", contact_visibility: "ON_REQUEST" }, nowMs
  });
  const postId = postRes.body.data.id;
  const post = app.store.momentsState.posts.find((p) => p.id === postId);

  const init = await app.inject({
    method: "POST", url: `/api/v1/moments/posts/${postId}/contact-requests`,
    headers: finder.authHeaders,
    body: { message: "first", idempotency_key: "c1-first" }, nowMs
  });
  assert.equal(init.status, 201);

  // Second message through the create path (existing thread): first send 201,
  // the same request retried after a lost response must dedupe, NOT 409.
  const second = await app.inject({
    method: "POST", url: `/api/v1/moments/posts/${postId}/contact-requests`,
    headers: finder.authHeaders,
    body: { message: "second", contact_info: "QQ", idempotency_key: "c1-second" }, nowMs: nowMs + 1000
  });
  assert.equal(second.status, 201);
  const retry = await app.inject({
    method: "POST", url: `/api/v1/moments/posts/${postId}/contact-requests`,
    headers: finder.authHeaders,
    body: { message: "second", contact_info: "QQ", idempotency_key: "c1-second" }, nowMs: nowMs + 2000
  });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.code, "CONTACT_REQUEST_DUPLICATE");
  const thread = post.contact_requests.find((r) => r.id === init.body.data.id);
  const secondMsgCount = thread.messages.filter((m) => m.content === "second").length;
  assert.equal(secondMsgCount, 1, "retried message must not append twice");

  // Separator ambiguity: {a|b, c} vs {a, b|c} are DIFFERENT payloads —
  // structured canonical form must not collide them into a false duplicate.
  const post2 = await app.inject({
    method: "POST", url: "/api/v1/moments/posts", headers: owner.authHeaders,
    body: { type: "LOST", title: "丢失雨伞", campus: "莲花街校区", contact_visibility: "ON_REQUEST" }, nowMs
  });
  const p2id = post2.body.data.id;
  const c1 = await app.inject({
    method: "POST", url: `/api/v1/moments/posts/${p2id}/contact-requests`,
    headers: finder.authHeaders,
    body: { message: "a|b", contact_info: "c", idempotency_key: "collide-1" }, nowMs: nowMs + 3000
  });
  assert.equal(c1.status, 201);
  const c2 = await app.inject({
    method: "POST", url: `/api/v1/moments/posts/${p2id}/contact-requests`,
    headers: finder.authHeaders,
    body: { message: "a", contact_info: "b|c", idempotency_key: "collide-1" }, nowMs: nowMs + 4000
  });
  assert.equal(c2.status, 409, "different payload under same key must conflict, not dedupe");
});

// ---------------------------------------------------------------------------
// Quote contract: server-issued quote pins price; stale/expired/foreign/wrong
// quote 409s; one-shot consumption; legacy clients marked honestly.
// ---------------------------------------------------------------------------
test("R3-7: server quote pins price at plan creation; stale quote 409s", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const { user, authHeaders } = setupBoundUser(app, nowMs);
  const other = setupBoundUser(app, nowMs);
  const c = await app.inject({ method: "POST", url: "/api/v1/me/consents", headers: authHeaders, body: { school_id: "haut" }, nowMs });
  const b = await app.inject({ method: "POST", url: "/api/v1/school-bindings", headers: authHeaders, body: { school_id: "haut", student_no: "20246666" }, nowMs });
  await app.inject({
    method: "POST", url: `/api/v1/school-bindings/${b.body.data.id}/complete`,
    headers: authHeaders, body: { consent_id: c.body.data.id, delegated_secret: "r3_secret" }, nowMs
  });

  const quoteRes = await app.inject({ method: "GET", url: "/api/v1/reservation-quote", headers: authHeaders, nowMs });
  assert.equal(quoteRes.status, 200);
  const quote = quoteRes.body.data;
  assert.equal(quote.amount_micropeach, app.store.pricingMicropeach);
  assert.ok(quote.quote_hash);

  // Another user's quote is refused.
  const foreign = await app.inject({
    method: "POST", url: "/api/v1/reservation-plans", headers: other.authHeaders,
    body: { school_binding_id: "any", consent_id: "any", quote_id: quote.quote_id }, nowMs
  });
  assert.notEqual(foreign.status, 201);

  // Happy path with quote_id.
  const ok = await app.inject({
    method: "POST", url: "/api/v1/reservation-plans", headers: authHeaders,
    body: {
      school_binding_id: b.body.data.id, consent_id: c.body.data.id,
      target_local_date: "2026-11-16", target_local_time: "07:00:00",
      quote_id: quote.quote_id
    },
    nowMs
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const plan = app.store.reservationPlans.get(ok.body.data.plan_id || ok.body.data.id);
  assert.equal(plan.acceptance_source, "SERVER_QUOTE");
  assert.equal(plan.accepted_quote_id, quote.quote_id);
  // Quote is consumed — replay refused.
  const replay = await app.inject({
    method: "POST", url: "/api/v1/reservation-plans", headers: authHeaders,
    body: {
      school_binding_id: b.body.data.id, consent_id: c.body.data.id,
      target_local_date: "2026-11-16", target_local_time: "07:00:00",
      quote_id: quote.quote_id
    },
    nowMs: nowMs + 1000
  });
  assert.equal(replay.status, 409);

  // Expired quote → 409.
  const q2 = await app.inject({ method: "GET", url: "/api/v1/reservation-quote", headers: authHeaders, nowMs });
  const expired = await app.inject({
    method: "POST", url: "/api/v1/reservation-plans", headers: authHeaders,
    body: {
      school_binding_id: b.body.data.id, consent_id: c.body.data.id,
      target_local_date: "2026-11-16", target_local_time: "07:00:00",
      quote_id: q2.body.data.quote_id
    },
    nowMs: nowMs + 11 * 60 * 1000
  });
  assert.equal(expired.status, 409);

  // No quote/expected_price → allowed but honestly marked (different date —
  // same-date jobs would legitimately conflict).
  const legacy = await app.inject({
    method: "POST", url: "/api/v1/reservation-plans", headers: authHeaders,
    body: {
      school_binding_id: b.body.data.id, consent_id: c.body.data.id,
      target_local_date: "2026-11-17", target_local_time: "07:00:00"
    },
    nowMs: nowMs + 12 * 60 * 1000
  });
  assert.equal(legacy.status, 201);
  const legacyPlan = app.store.reservationPlans.get(legacy.body.data.plan_id || legacy.body.data.id);
  assert.equal(legacyPlan.acceptance_source, "LEGACY_NO_QUOTE");
});
