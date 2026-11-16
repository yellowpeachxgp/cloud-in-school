import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { createShutdownController } from "../apps/api/src/shutdown.mjs";
import { KmsEnvelopeVault } from "../packages/crypto/src/index.mjs";
import { rekeySharedCredentialRefs } from "../scripts/rekey-shared-credential-refs.mjs";

function setupBoundUser(app, nowMs, { peachMicro = 50_000 } = {}) {
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: `r4_${Math.random().toString(36).slice(2, 9)}`,
    displayName: "R4 Student"
  });
  const session = app.identity.issueDeviceSession(user, "R4 Device", null, 1, nowMs);
  if (peachMicro != null) app.financeBridge.setSandboxBalance(user.id, peachMicro);
  return { user, session, authHeaders: { authorization: `Bearer ${session.access_token}` } };
}

// ---------------------------------------------------------------------------
// F1: APPLIED is unreachable without complete expected linkage — same-key is
// necessary but NOT sufficient (amount + account must also match the record).
// ---------------------------------------------------------------------------
test("R4-1: probe without expected linkage can never return APPLIED", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { user } = setupBoundUser(app, Date.now());
  const key = "dis:reservation:" + crypto.randomUUID() + ":refund:v1";

  // A real recorded operation exists — a lazy probe still can't claim APPLIED.
  app.financeBridge.processedIdempotencyKeys.set(key, {
    ok: true, cloud_user_id: user.id, delta_micropeach: 10_000
  });

  const noLinkage = await app.financeBridge.queryOperationResult(key);
  assert.equal(noLinkage.outcome, "UNKNOWN");
  assert.equal(noLinkage.reason, "expected_linkage_fields_missing");

  const amountMismatch = await app.financeBridge.queryOperationResult(key, {
    expectedMicropeach: 20_000, cloudUserId: user.id
  });
  assert.equal(amountMismatch.outcome, "UNKNOWN");
  assert.equal(amountMismatch.reason, "amount_mismatch_vs_recorded");

  const accountMismatch = await app.financeBridge.queryOperationResult(key, {
    expectedMicropeach: 10_000, cloudUserId: "other-user"
  });
  assert.equal(accountMismatch.outcome, "UNKNOWN");
  assert.equal(accountMismatch.reason, "account_mismatch_vs_recorded");

  // Record missing its own linkage fields can never back an APPLIED claim.
  const key2 = "dis:reservation:" + crypto.randomUUID() + ":refund:v1";
  app.financeBridge.processedIdempotencyKeys.set(key2, { ok: true });
  const brokenRecord = await app.financeBridge.queryOperationResult(key2, {
    expectedMicropeach: 10_000, cloudUserId: user.id
  });
  assert.equal(brokenRecord.outcome, "UNKNOWN");
  assert.ok(["recorded_account_missing", "amount_mismatch_vs_recorded"].includes(brokenRecord.reason));

  // Complete linkage → APPLIED.
  const applied = await app.financeBridge.queryOperationResult(key, {
    expectedMicropeach: 10_000, cloudUserId: user.id
  });
  assert.equal(applied.outcome, "APPLIED");
});

// ---------------------------------------------------------------------------
// S1: the REAL shutdown controller — fake tasks: hung → honest non-zero;
// complete → clean zero; second signal accelerates only; no new intake.
// ---------------------------------------------------------------------------
function fakeServer() {
  return { close: (cb) => setTimeout(cb, 5), closeAllConnections: () => {} };
}

test("R4-2a: hung finance task → drained:false, remaining logged, exit 3", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const hung = app.registerLifecycleTask("finance");
  const logs = [];
  let exitCode = null;
  const { shutdown } = createShutdownController({
    app, server: fakeServer(),
    stopBackgroundTasks: () => {},
    logLine: (l) => logs.push(l),
    setExitCode: (c) => { exitCode = c; },
    maxDrainMs: 400
  });
  const result = await shutdown("SIGTERM");
  assert.equal(result.drained, false);
  assert.equal(exitCode, 3);
  const dead = logs.find((l) => l.phase === "drain_deadline");
  assert.ok(dead, "deadline log required");
  assert.deepEqual(dead.remaining, { finance: 1 });
  assert.ok(!logs.some((l) => l.drained === true), "never claims drained");
  assert.equal(app.isDraining(), true);
  app.unregisterLifecycleTask(hung);
});

test("R4-2b: all tasks complete → drained:true exit 0; pre-signal tasks counted", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const t = app.registerLifecycleTask("scanner");
  setTimeout(() => app.unregisterLifecycleTask(t), 30);
  const logs = [];
  let exitCode = null;
  const { shutdown } = createShutdownController({
    app, server: fakeServer(),
    stopBackgroundTasks: () => {},
    logLine: (l) => logs.push(l),
    setExitCode: (c) => { exitCode = c; },
    maxDrainMs: 2_000
  });
  const result = await shutdown("SIGTERM");
  assert.equal(result.drained, true);
  assert.equal(exitCode, 0);
});

test("R4-2c: second signal shares the promise and shortens the deadline", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const hung = app.registerLifecycleTask("scanner");
  const logs = [];
  let exitCode = null;
  const { shutdown } = createShutdownController({
    app, server: fakeServer(),
    stopBackgroundTasks: () => {},
    logLine: (l) => logs.push(l),
    setExitCode: (c) => { exitCode = c; },
    maxDrainMs: 60_000
  });
  const p1 = shutdown("SIGTERM");
  const p2 = shutdown("SIGINT"); // shortens deadline to ~2s instead of 60s
  assert.equal(p1, p2, "same idempotent promise");
  const started = Date.now();
  await p1;
  assert.ok(Date.now() - started < 15_000, "accelerated deadline");
  assert.equal(exitCode, 3);
  assert.equal(logs.filter((l) => l.phase === "draining_started").length, 1, "no second flow");
  app.unregisterLifecycleTask(hung);
});

test("R4-2d: strict-flush failure is a non-success shutdown", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  app.store.flushSnapshotStrictSync = () => { throw new Error("disk full"); };
  let exitCode = null;
  const logs = [];
  const { shutdown } = createShutdownController({
    app, server: fakeServer(),
    stopBackgroundTasks: () => {},
    logLine: (l) => logs.push(l),
    setExitCode: (c) => { exitCode = c; },
    maxDrainMs: 500
  });
  const result = await shutdown("SIGTERM");
  assert.equal(result.persisted, false);
  assert.equal(exitCode, 3);
  assert.ok(logs.some((l) => l.phase === "persist_failed"));
});

// ---------------------------------------------------------------------------
// M1: a source owner flagged for an authorization/risk reason is not a proven
// source — the target is reconfirmation-bound, never issued a decrypt permit.
// ---------------------------------------------------------------------------
test("R4-3: owner with non-integrity reconfirm reason cannot source a rekey", () => {
  const nowMs = Date.now();
  const vault = new KmsEnvelopeVault({});
  const owner = {
    id: "bnd_o", cloud_user_id: "u1", school_id: "haut", student_no: "2024001",
    status: "DELEGATED_ACTIVE",
    credential_needs_reconfirmation: true,
    credential_reconfirm_reason: "RISK_REVIEW",
    credential_ref: null
  };
  const rec = vault.encryptSecret({
    bindingId: owner.id, schoolId: "haut", credentialKind: "DELEGATED_SESSION_BUNDLE",
    plaintext: JSON.stringify({ session_id: "S" }),
    expiresAt: new Date(nowMs + 3600_000).toISOString()
  });
  owner.credential_ref = rec.id;
  const target = {
    id: "bnd_t", cloud_user_id: "u1", school_id: "haut", student_no: "2024001",
    status: "VERIFIED_LOCAL_ONLY", credential_ref: rec.id
  };
  const state = {
    schoolBindings: [[owner.id, owner], [target.id, target]],
    encryptedCredentials: [[rec.id, rec]]
  };
  const { rawState: out, report } = rekeySharedCredentialRefs(structuredClone(state), vault, { nowMs, apply: true });
  const t = new Map(out.schoolBindings).get("bnd_t");
  assert.equal(t.credential_ref, rec.id, "target must NOT be re-keyed from a risky source");
  assert.equal(t.credential_needs_reconfirmation, true);
  assert.match(t.credential_reconfirm_reason, /SOURCE_OWNER_NOT_CLEARABLE/);
  assert.equal(report.rekeyed.length, 0);
});

// ---------------------------------------------------------------------------
// C1: the append path itself now speaks canonical v2 — same-key different
// payload conflicts; same payload dedupes under a versioned receipt.
// ---------------------------------------------------------------------------
test("R4-4: append-path receipts carry canonical v2; cross-entry retry dedupes", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const owner = setupBoundUser(app, nowMs);
  const finder = setupBoundUser(app, nowMs);
  const postRes = await app.inject({
    method: "POST", url: "/api/v1/moments/posts", headers: owner.authHeaders,
    body: { type: "LOST", title: "丢失水杯", campus: "莲花街校区", contact_visibility: "ON_REQUEST" }, nowMs
  });
  const postId = postRes.body.data.id;

  const init = await app.inject({
    method: "POST", url: `/api/v1/moments/posts/${postId}/contact-requests`,
    headers: finder.authHeaders,
    body: { message: "first", idempotency_key: "r4-k1" }, nowMs
  });
  const threadId = init.body.data.id;

  // Append via the messages endpoint — receipt must carry canonical_version 2.
  const m1 = await app.inject({
    method: "POST", url: `/api/v1/moments/posts/${postId}/contact-requests/${threadId}/action`,
    headers: finder.authHeaders,
    body: { action: "REPLY", message: "hello again", idempotency_key: "r4-m1" }, nowMs: nowMs + 1000
  });
  assert.equal(m1.status, 200);
  assert.equal(m1.body.code, "CONTACT_REQUEST_UPDATED", "fresh REPLY append");
  const post = app.store.momentsState.posts.find((p) => p.id === postId);
  const thread = post.contact_requests.find((r) => r.id === threadId);
  const receipt = thread._msgReceipts[finder.user.id + "|message|r4-m1"];
  assert.equal(receipt.canonical_version, 2, "append receipt must carry canonical v2");

  // Same key + same payload through the SAME append path → dedupe.
  const m1retry = await app.inject({
    method: "POST", url: `/api/v1/moments/posts/${postId}/contact-requests/${threadId}/action`,
    headers: finder.authHeaders,
    body: { action: "REPLY", message: "hello again", idempotency_key: "r4-m1" }, nowMs: nowMs + 2000
  });
  assert.equal(m1retry.status, 200);
  assert.equal(m1retry.body.code, "CONTACT_MESSAGE_DUPLICATE");

  // Same key + DIFFERENT payload → honest conflict.
  const m1conf = await app.inject({
    method: "POST", url: `/api/v1/moments/posts/${postId}/contact-requests/${threadId}/action`,
    headers: finder.authHeaders,
    body: { action: "REPLY", message: "different text", idempotency_key: "r4-m1" }, nowMs: nowMs + 3000
  });
  assert.equal(m1conf.status, 409);

  // Delimiter-bearing content cannot collide across different payloads.
  const cA = await app.inject({
    method: "POST", url: `/api/v1/moments/posts/${postId}/contact-requests/${threadId}/action`,
    headers: finder.authHeaders,
    body: { action: "REPLY", message: "x|y", idempotency_key: "r4-coll" }, nowMs: nowMs + 4000
  });
  assert.equal(cA.status, 200);
  assert.equal(cA.body.code, "CONTACT_REQUEST_UPDATED");
  const cB = await app.inject({
    method: "POST", url: `/api/v1/moments/posts/${postId}/contact-requests/${threadId}/action`,
    headers: finder.authHeaders,
    body: { action: "REPLY", message: "x", idempotency_key: "r4-coll" }, nowMs: nowMs + 5000
  });
  assert.equal(cB.status, 409, "distinct content under same key must conflict");
});

// ---------------------------------------------------------------------------
// Q1: a quote survives a failed create — it is consumed only when the
// plan+job actually commit.
// ---------------------------------------------------------------------------
test("R4-5: failed create does not consume the quote; retry with it succeeds", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const { user, authHeaders } = setupBoundUser(app, nowMs);
  const c = await app.inject({ method: "POST", url: "/api/v1/me/consents", headers: authHeaders, body: { school_id: "haut" }, nowMs });
  const b = await app.inject({ method: "POST", url: "/api/v1/school-bindings", headers: authHeaders, body: { school_id: "haut", student_no: "20247777" }, nowMs });
  await app.inject({
    method: "POST", url: `/api/v1/school-bindings/${b.body.data.id}/complete`,
    headers: authHeaders, body: { consent_id: c.body.data.id, delegated_secret: "r4_secret" }, nowMs
  });
  const q = await app.inject({ method: "GET", url: "/api/v1/reservation-quote", headers: authHeaders, nowMs });
  const quote = q.body.data;

  // First create fails on a non-quote validation (bad target date window).
  const bad = await app.inject({
    method: "POST", url: "/api/v1/reservation-plans", headers: authHeaders,
    body: {
      school_binding_id: b.body.data.id, consent_id: c.body.data.id,
      target_local_date: "2020-01-01", target_local_time: "07:00:00",
      quote_id: quote.quote_id
    },
    nowMs
  });
  assert.notEqual(bad.status, 201);
  // Quote must still exist — it was not consumed by the failure.
  assert.ok(app.store.priceQuotes.has(quote.quote_id), "quote survived the failed create");

  // Retry with a valid payload + the SAME quote succeeds.
  const ok = await app.inject({
    method: "POST", url: "/api/v1/reservation-plans", headers: authHeaders,
    body: {
      school_binding_id: b.body.data.id, consent_id: c.body.data.id,
      target_local_date: "2026-11-16", target_local_time: "07:00:00",
      quote_id: quote.quote_id
    },
    nowMs: nowMs + 1000
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.ok(!app.store.priceQuotes.has(quote.quote_id), "quote consumed exactly at commit");
});
