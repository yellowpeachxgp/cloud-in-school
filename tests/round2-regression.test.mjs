import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { DeterministicMockSchoolBackend } from "../apps/mock-school/src/main.mjs";
import { ContractError } from "../packages/contracts/src/index.mjs";
import { KmsEnvelopeVault } from "../packages/crypto/src/index.mjs";
import {
  classifyMigrationCandidate,
  rekeySharedCredentialRefs
} from "../scripts/rekey-shared-credential-refs.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setupBoundUser(app, nowMs, { peachMicro = 50_000 } = {}) {
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: `sub_${Math.random().toString(36).slice(2, 9)}`,
    displayName: "R2 Test Student"
  });
  const session = app.identity.issueDeviceSession(user, "R2 Test Device", null, 1, nowMs);
  if (peachMicro != null) app.financeBridge.setSandboxBalance(user.id, peachMicro);
  return { user, session, authHeaders: { authorization: `Bearer ${session.access_token}` } };
}

function setupAdmin(app, { role = "admin" } = {}) {
  const user = app.store.findOrCreateCloudUser({
    issuer: app.identity.expectedIssuer,
    subject: `r2_${role}_${Math.random().toString(36).slice(2, 9)}`,
    username: `r2_${role}_admin`,
    role
  });
  const sess = app.identity.issueDeviceSession(user, "R2 Admin");
  return { user, authHeaders: { authorization: `Bearer ${sess.access_token}` } };
}

function demoteAdmin(app, user) {
  user.role = "user";
  app.store.setUserRoles(user.id, ["USER"]);
  app.store.userSsoRoles.delete(user.id);
}

function craftPaidOrder(app, userId, { priceMicro = 10_000 } = {}) {
  const order = {
    id: crypto.randomUUID(),
    order_no: "R2-" + crypto.randomUUID().slice(0, 8),
    cloud_user_id: userId,
    payment_state: "PAID",
    price_micropeach: priceMicro,
    price_peach: priceMicro / 10_000,
    created_at: new Date().toISOString(),
    paid_at: new Date().toISOString()
  };
  app.store.reservationOrders.set(order.id, order);
  return order;
}

// ---------------------------------------------------------------------------
// R2-C1: dispatched RESULT_UNKNOWN refund must survive approver demotion —
// any currently-qualified operator finishes converging it (never FAILED).
// ---------------------------------------------------------------------------
test("R2-1: RESULT_UNKNOWN refund resumes via another qualified operator after approver demotion", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const student = setupBoundUser(app, Date.now(), { peachMicro: 0 });
  const order = craftPaidOrder(app, student.user.id);
  const adminA = setupAdmin(app);
  const adminB = setupAdmin(app);
  const adminC = setupAdmin(app);

  const created = await app.inject({
    method: "POST",
    url: `/api/v1/admin/orders/${order.id}/refund-requests`,
    headers: adminA.authHeaders,
    body: { reason: "用户申请人工退还", amount_micropeach: 10_000 }
  });
  assert.equal(created.status, 202);
  const reqId = created.body.data.refund_request.id;

  const approved = await app.inject({
    method: "POST",
    url: `/api/v1/admin/refund-requests/${reqId}/approve`,
    headers: adminB.authHeaders,
    body: {}
  });
  assert.equal(approved.status, 200);

  // Simulate a dispatch timeout: refund may have applied upstream, result unknown.
  const origAdjust = app.financeBridge.adjustBalanceIdempotent.bind(app.financeBridge);
  let once = true;
  app.financeBridge.adjustBalanceIdempotent = async (args) => {
    if (once && Number(args.deltaMicropeach) > 0) {
      once = false;
      throw new ContractError("SSO_TIMEOUT", "simulated dispatch timeout");
    }
    return origAdjust(args);
  };

  const exec1 = await app.inject({
    method: "POST",
    url: `/api/v1/admin/refund-requests/${reqId}/execute`,
    headers: adminB.authHeaders,
    body: {}
  });
  assert.equal(exec1.status >= 400, true, "timeout should surface as an error");
  const reqAfter = app.store.refundRequests.get(reqId);
  assert.equal(reqAfter.status, "RESULT_UNKNOWN", "dispatched refund must stay unknown, never terminal-failed");

  // Demote the approver — the money lane must NOT freeze.
  demoteAdmin(app, adminB.user);

  // A different qualified operator reconciles with the SAME event key.
  const exec2 = await app.inject({
    method: "POST",
    url: `/api/v1/admin/refund-requests/${reqId}/execute`,
    headers: adminC.authHeaders,
    body: {}
  });
  assert.equal(exec2.status, 200, JSON.stringify(exec2.body));
  assert.equal(app.store.refundRequests.get(reqId).status, "REFUNDED");
  assert.equal(app.store.reservationOrders.get(order.id).payment_state, "REFUNDED");

  // Demoted approver itself can no longer execute anything.
  demoteAdmin(app, adminC.user);
  const exec3 = await app.inject({
    method: "POST",
    url: `/api/v1/admin/refund-requests/${reqId}/execute`,
    headers: adminB.authHeaders,
    body: {}
  });
  assert.equal(exec3.status, 403);
});

// ---------------------------------------------------------------------------
// R2-C2: legacy in-flight refund (no request record) — migrator flags it,
// reconcile uses the ORIGINAL event key; new request only after proven safe.
// ---------------------------------------------------------------------------
test("R2-2: legacy REFUND op is flagged at boot and reconciled read-only by original key", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const student = setupBoundUser(app, Date.now(), { peachMicro: 0 });
  const order = craftPaidOrder(app, student.user.id);
  const admin = setupAdmin(app);
  const eventKey = `dis:reservation:${order.id}:refund:v1`;

  app.store.financeOperations.set(eventKey, {
    id: crypto.randomUUID(),
    order_id: order.id,
    kind: "REFUND",
    event_key: eventKey,
    amount_micropeach: 10_000,
    payload_hash: null,
    refund_request_id: null,
    status: "IN_FLIGHT",
    attempt_count: 1,
    created_at: new Date(Date.now() - 86400_000).toISOString(),
    updated_at: new Date(Date.now() - 86400_000).toISOString()
  });

  // Boot sweep must flag it — never fabricate a request or new key.
  app.store.migrateAndRecoverState(Date.now());
  const op = app.store.financeOperations.get(eventKey);
  assert.equal(op.legacy_reconcile_required, true);
  assert.equal(app.store.refundRequests.size, 0, "must NOT mint a request record for the legacy op");

  // While unresolved, creating a new request must be blocked.
  const blocked = await app.inject({
    method: "POST",
    url: `/api/v1/admin/orders/${order.id}/refund-requests`,
    headers: admin.authHeaders,
    body: { reason: "retry while legacy unresolved", amount_micropeach: 10_000 }
  });
  assert.equal(blocked.status, 409);

  // The queue is visible to ops.
  const list = await app.inject({ method: "GET", url: "/api/v1/admin/refund-requests", headers: admin.authHeaders });
  assert.equal(list.status, 200);
  assert.equal(list.body.data.legacy_reconcile_queue.length, 1);
  assert.equal(list.body.data.legacy_reconcile_queue[0].event_key, eventKey);

  // Reconcile by original key: sandbox probe proves it was never received.
  const rec = await app.inject({
    method: "POST",
    url: `/api/v1/admin/orders/${order.id}/refund-reconcile`,
    headers: admin.authHeaders,
    body: {}
  });
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  assert.equal(rec.body.data.reconciled, "NEVER_RECEIVED");
  assert.equal(app.store.financeOperations.get(eventKey).status, "FAILED");

  // Only NOW may a new dual-person request be created.
  const created = await app.inject({
    method: "POST",
    url: `/api/v1/admin/orders/${order.id}/refund-requests`,
    headers: admin.authHeaders,
    body: { reason: "legacy proven never-received; fresh dual-person request", amount_micropeach: 10_000 }
  });
  assert.equal(created.status, 202);
});

test("R2-3: legacy reconcile converges SUCCEEDED via recorded upstream result", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const student = setupBoundUser(app, Date.now(), { peachMicro: 0 });
  const order = craftPaidOrder(app, student.user.id);
  const admin = setupAdmin(app);
  const eventKey = `dis:reservation:${order.id}:refund:v1`;

  // Sandbox bridge "remembers" the key — upstream actually applied it.
  app.financeBridge.processedIdempotencyKeys.set(eventKey, { ok: true, sso_request_id: "sso_abc" });
  app.store.financeOperations.set(eventKey, {
    id: crypto.randomUUID(),
    order_id: order.id,
    kind: "REFUND",
    event_key: eventKey,
    amount_micropeach: 10_000,
    payload_hash: null,
    refund_request_id: null,
    status: "FAILED_RETRYABLE",
    attempt_count: 3,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  app.store.migrateAndRecoverState(Date.now());

  const rec = await app.inject({
    method: "POST",
    url: `/api/v1/admin/orders/${order.id}/refund-reconcile`,
    headers: admin.authHeaders,
    body: {}
  });
  assert.equal(rec.body.data.reconciled, "SUCCEEDED");
  assert.equal(app.store.reservationOrders.get(order.id).payment_state, "REFUNDED");
});

// ---------------------------------------------------------------------------
// R2-C4a: drain fence — mutating requests are refused 503 once draining; GETs pass.
// ---------------------------------------------------------------------------
test("R2-4: drain fence rejects new writes with SERVER_DRAINING but keeps reads", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { authHeaders } = setupBoundUser(app, Date.now());
  app.setDraining(true);
  const post = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: authHeaders,
    body: { school_id: "haut" }
  });
  assert.equal(post.status, 503);
  assert.equal(post.body.code, "SERVER_DRAINING");
  const get = await app.inject({ method: "GET", url: "/api/v1/me/wallet", headers: authHeaders });
  assert.equal(get.status, 200);
});

// ---------------------------------------------------------------------------
// R2-C4b: real SIGTERM — spawned server must exit within a bounded window and
// stop accepting work (pre-fix: signal only cleared one timer; process ran on).
// ---------------------------------------------------------------------------
test("R2-5: SIGTERM drains and exits the API process within bound", async () => {
  const port = 18347;
  const tmpState = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "r2-sig-")), "state.json");
  const nodeBin =
    ["/opt/homebrew/opt/node@24/bin/node", "/usr/local/bin/node", "/usr/bin/node", process.execPath].find((p) => {
      try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
    }) || "node";
  const child = spawn(nodeBin, ["apps/api/src/main.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      CLOUD_SNAPSHOT_PATH: tmpState,
      CLOUD_REQUIRE_DURABLE_SNAPSHOT: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  try {
    // wait for listen
    const deadline = Date.now() + 15_000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        await new Promise((resolve, reject) => {
          const req = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: 500 }, (res) => {
            res.resume();
            res.statusCode < 500 ? resolve() : reject(new Error("status " + res.statusCode));
          });
          req.on("error", reject);
          req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        });
        up = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    assert.equal(up, true, "server did not come up: " + out.slice(-500));

    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    child.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise((_, rej) => setTimeout(() => rej(new Error("process did not exit within 18s of SIGTERM")), 18_000))
    ]);
    assert.equal(code, 0, "clean shutdown must exit 0, got " + code);
    assert.match(out, /shutdown_complete/);
  } finally {
    child.kill("SIGKILL");
  }
});

// ---------------------------------------------------------------------------
// R2-C5: re-key migration classifier — strict eligibility table; dry-run pure.
// ---------------------------------------------------------------------------
test("R2-6: rekey classifier rejects every unproven dimension; dry-run never mutates input", () => {
  const nowMs = Date.now();
  const owner = {
    id: "bnd_owner", cloud_user_id: "u1", school_id: "haut", student_no: "2024001",
    status: "DELEGATED_ACTIVE", credential_ref: "cred_1"
  };
  const target = { ...owner, id: "bnd_target", status: "VERIFIED_LOCAL_ONLY" };
  const record = {
    id: "cred_1", binding_id: owner.id, school_id: "haut",
    secret_type: "DELEGATED_SESSION_BUNDLE", expires_at: new Date(nowMs + 3600_000).toISOString()
  };

  // Happy path: full proof -> ALLOW
  assert.equal(
    classifyMigrationCandidate({ binding: target, owner, record, nowMs }).decision,
    "ALLOW"
  );
  // Owner revoked -> RECONFIRM, never migrate
  assert.equal(
    classifyMigrationCandidate({ binding: target, owner: { ...owner, revoked_at: "x" }, record, nowMs }).reason,
    "OWNER_REVOKED"
  );
  // Empty student_no on either side -> never "equal"
  assert.equal(
    classifyMigrationCandidate({ binding: { ...target, student_no: "  " }, owner, record, nowMs }).reason,
    "STUDENT_MISMATCH"
  );
  assert.equal(
    classifyMigrationCandidate({ binding: target, owner: { ...owner, student_no: null }, record, nowMs }).reason,
    "STUDENT_MISMATCH"
  );
  // Wrong school anywhere -> reject
  assert.equal(
    classifyMigrationCandidate({ binding: { ...target, school_id: "other" }, owner, record, nowMs }).reason,
    "SCHOOL_MISMATCH"
  );
  assert.equal(
    classifyMigrationCandidate({ binding: target, owner, record: { ...record, school_id: "other" }, nowMs }).reason,
    "SCHOOL_MISMATCH"
  );
  // Owner moved to another credential -> not a proven source
  assert.equal(
    classifyMigrationCandidate({ binding: target, owner: { ...owner, credential_ref: "cred_2" }, record, nowMs }).reason,
    "OWNER_POINTS_ELSEWHERE"
  );
  // Unknown credential kind -> reject (no defaulting)
  assert.equal(
    classifyMigrationCandidate({ binding: target, owner, record: { ...record, secret_type: "MYSTERY" }, nowMs }).reason,
    "UNKNOWN_CREDENTIAL_KIND"
  );
  // No-expiry record -> cannot prove validity
  assert.equal(
    classifyMigrationCandidate({ binding: target, owner, record: { ...record, expires_at: null }, nowMs }).reason,
    "RECORD_NO_EXPIRY_PROOF"
  );
  // Revoked target -> SKIP entirely
  assert.equal(
    classifyMigrationCandidate({ binding: { ...target, status: "REVOKED" }, owner, record, nowMs }).decision,
    "SKIP"
  );
});

test("R2-7: rekey dry-run leaves input untouched; apply grants independent records only to proven bindings", () => {
  const nowMs = Date.now();
  const vault = new KmsEnvelopeVault({});
  const owner = {
    id: "bnd_owner", cloud_user_id: "u1", school_id: "haut", student_no: "2024001",
    status: "DELEGATED_ACTIVE", credential_ref: null
  };
  const shared = vault.encryptSecret({
    bindingId: owner.id,
    schoolId: "haut",
    credentialKind: "DELEGATED_SESSION_BUNDLE",
    plaintext: JSON.stringify({ session_id: "S", raw_token: "T" }),
    expiresAt: new Date(nowMs + 3600_000).toISOString()
  });
  owner.credential_ref = shared.id;
  const good = {
    id: "bnd_good", cloud_user_id: "u1", school_id: "haut", student_no: "2024001",
    status: "VERIFIED_LOCAL_ONLY", credential_ref: shared.id
  };
  const bad = {
    id: "bnd_bad", cloud_user_id: "u1", school_id: "haut", student_no: "", // blank -> unprovable
    status: "VERIFIED_LOCAL_ONLY", credential_ref: shared.id
  };
  const state = {
    schoolBindings: [[owner.id, owner], [good.id, good], [bad.id, bad]],
    encryptedCredentials: [[shared.id, shared]]
  };
  const before = structuredClone(state);

  const dry = rekeySharedCredentialRefs(state, vault, { nowMs, apply: false });
  assert.equal(dry.rawState, state, "dry-run must return the untouched input");
  assert.deepEqual(state, before, "dry-run must not mutate any input object");
  assert.equal(dry.report.rekeyed.length, 1);
  assert.equal(dry.report.needs_reconfirmation.length, 1);

  const applied = rekeySharedCredentialRefs(structuredClone(before), vault, { nowMs, apply: true });
  const outBindings = new Map(applied.rawState.schoolBindings);
  assert.notEqual(outBindings.get("bnd_good").credential_ref, shared.id, "proven binding gets an independent record");
  assert.equal(outBindings.get("bnd_bad").credential_ref, shared.id, "unproven binding keeps the old ref");
  assert.equal(outBindings.get("bnd_bad").credential_needs_reconfirmation, true);
  assert.equal(outBindings.get("bnd_bad").credential_reconfirm_reason, "STUDENT_MISMATCH");
  // Each binding's new record is bound to ITS OWN id.
  const outCreds = new Map(applied.rawState.encryptedCredentials);
  assert.equal(outCreds.get(outBindings.get("bnd_good").credential_ref).binding_id, "bnd_good");
});

// ---------------------------------------------------------------------------
// R2-C6: APPROVE+reply must flow through the unified path: closed-post block,
// per-actor rate limit, dedupe; repeat APPROVE never re-appends/re-notifies.
// ---------------------------------------------------------------------------
test("R2-8: APPROVE+reply obeys closed-post/dedupe rules; repeat APPROVE is a no-op", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const owner = setupBoundUser(app, nowMs);
  const finder = setupBoundUser(app, nowMs);
  const notificationsBefore = app.store.notifications?.size || 0;

  const postRes = await app.inject({
    method: "POST",
    url: "/api/v1/moments/posts",
    headers: owner.authHeaders,
    body: { type: "LOST", title: "丢失钥匙", campus: "莲花街校区", contact_visibility: "ON_REQUEST" },
    nowMs
  });
  const postId = postRes.body.data.id;
  const post = app.store.momentsState.posts.find((p) => p.id === postId);

  const m1 = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests`,
    headers: finder.authHeaders,
    body: { message: "我在三号楼附近", idempotency_key: "r2-req-1" },
    nowMs
  });
  const threadId = m1.body.data.id;
  const thread = post.contact_requests.find((r) => r.id === threadId);

  // APPROVE with an attached reply via the unified path + idempotency key.
  const approve = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests/${threadId}/action`,
    headers: { ...owner.authHeaders, "idempotency-key": "r2-appr-1" },
    body: { action: "APPROVE", reply_message: "请到服务台认领" },
    nowMs: nowMs + 1000
  });
  assert.equal(approve.status, 200);
  assert.equal(thread.status, "APPROVED");
  const msgsAfterApprove = thread.messages.length;
  const notifAfterApprove = app.store.notifications.size;
  assert.equal(notifAfterApprove > notificationsBefore, true, "approval notifies the requester once");

  // Repeat the same APPROVE+reply: idempotent — no second message, no second notify.
  const approveAgain = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests/${threadId}/action`,
    headers: { ...owner.authHeaders, "idempotency-key": "r2-appr-1" },
    body: { action: "APPROVE", reply_message: "请到服务台认领" },
    nowMs: nowMs + 2000
  });
  assert.equal(approveAgain.status, 200);
  assert.equal(thread.messages.length, msgsAfterApprove, "repeated APPROVE must not re-append the reply");
  assert.equal(app.store.notifications.size, notifAfterApprove, "repeated APPROVE must not re-notify");

  // Same APPROVE key but a DIFFERENT reply payload -> 409 payload conflict.
  const approveDiff = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests/${threadId}/action`,
    headers: { ...owner.authHeaders, "idempotency-key": "r2-appr-1" },
    body: { action: "APPROVE", reply_message: "改口：还是别来了" },
    nowMs: nowMs + 3000
  });
  assert.equal(approveDiff.status, 409);

  // APPROVE+reply on a CLOSED post must hit the unified closed-post rule.
  post.status = "CLOSED";
  const closedApprove = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests/${threadId}/action`,
    headers: { ...owner.authHeaders, "idempotency-key": "r2-appr-9" },
    body: { action: "APPROVE", reply_message: "late note" },
    nowMs: nowMs + 4000
  });
  assert.equal(closedApprove.status, 409);
});

// ---------------------------------------------------------------------------
// R2-C7: durable receipts outlive the 50-message visible window — retrying the
// initial POST after its message scrolled out must dedupe, never 409 or dup.
// ---------------------------------------------------------------------------
test("R2-9: initial-message receipt survives message-window truncation", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const owner = setupBoundUser(app, nowMs);
  const finder = setupBoundUser(app, nowMs);

  const postRes = await app.inject({
    method: "POST",
    url: "/api/v1/moments/posts",
    headers: owner.authHeaders,
    body: { type: "FOUND", title: "捡到饭卡", campus: "莲花街校区", contact_visibility: "ON_REQUEST" },
    nowMs
  });
  const postId = postRes.body.data.id;
  const post = app.store.momentsState.posts.find((p) => p.id === postId);

  const init = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests`,
    headers: finder.authHeaders,
    body: { message: "是我的卡", contact_info: "QQ 12345", idempotency_key: "r2-init-1" },
    nowMs
  });
  assert.equal(init.status, 201);
  const threadId = init.body.data.id;
  const thread = post.contact_requests.find((r) => r.id === threadId);

  // Simulate a long conversation pushing the initial message out of the window.
  for (let i = 0; i < 55; i += 1) {
    thread.messages.push({
      id: "filler_" + i,
      sender_role: "REQUESTER",
      sender_name: "x",
      content: "filler " + i,
      created_at: new Date(nowMs + i * 1000).toISOString()
    });
  }
  thread.messages = thread.messages.slice(-50);
  assert.equal(
    thread.messages.some((m) => m.idempotency_key === "r2-init-1"),
    false,
    "initial keyed message is now out of the visible window"
  );

  // Retry the SAME initial request: receipt evidence persists -> duplicate,
  // not a 409, not a second thread.
  const retry = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests`,
    headers: finder.authHeaders,
    body: { message: "是我的卡", contact_info: "QQ 12345", idempotency_key: "r2-init-1" },
    nowMs: nowMs + 60_000
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.code, "CONTACT_REQUEST_DUPLICATE");
  assert.equal(retry.body.data.id, threadId);
  assert.equal(post.contact_requests.filter((r) => r.sender_user_id === finder.user.id).length, 1);

  // Same key but a changed contact_info -> canonical payload differs -> 409.
  const drift = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests`,
    headers: finder.authHeaders,
    body: { message: "是我的卡", contact_info: "WECHAT other", idempotency_key: "r2-init-1" },
    nowMs: nowMs + 61_000
  });
  assert.equal(drift.status, 409);
});

// ---------------------------------------------------------------------------
// R2-C8: expected-quote drift must conflict at plan creation, not silently re-price.
// ---------------------------------------------------------------------------
test("R2-10: plan creation 409s when the client-pinned quote drifted", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const { authHeaders } = setupBoundUser(app, nowMs);
  const c = await app.inject({ method: "POST", url: "/api/v1/me/consents", headers: authHeaders, body: { school_id: "haut" }, nowMs });
  const b = await app.inject({ method: "POST", url: "/api/v1/school-bindings", headers: authHeaders, body: { school_id: "haut", student_no: "20249999" }, nowMs });
  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${b.body.data.id}/complete`,
    headers: authHeaders,
    body: { consent_id: c.body.data.id, delegated_secret: "r2_secret" },
    nowMs
  });
  // Global price drifted vs the quote the client displayed.
  app.store.pricingMicropeach = 20_000;
  const conflict = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: authHeaders,
    body: {
      school_binding_id: b.body.data.id,
      consent_id: c.body.data.id,
      target_local_date: "2026-11-16",
      target_local_time: "07:00:00",
      expected_price_micropeach: 10_000
    },
    nowMs
  });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));

  // Matching quote proceeds and snapshots the CURRENT price immutably.
  const ok = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: authHeaders,
    body: {
      school_binding_id: b.body.data.id,
      consent_id: c.body.data.id,
      target_local_date: "2026-11-16",
      target_local_time: "07:00:00",
      expected_price_micropeach: 20_000
    },
    nowMs
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const plan = app.store.reservationPlans.get(ok.body.data.plan_id || ok.body.data.id);
  assert.equal(plan.accepted_price_micropeach, 20_000);
  assert.equal(plan.price_version, "price-library-cloud-2026-11-v1");
  assert.ok(plan.accepted_at);
});

// ---------------------------------------------------------------------------
// R2-engine: manual exec validation precedes ANY stale/rollover mutation.
// ---------------------------------------------------------------------------
test("R2-11: engine manualExecuteNow validates before expiry/rollover mutations", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const { user, authHeaders } = setupBoundUser(app, nowMs);
  const c = await app.inject({ method: "POST", url: "/api/v1/me/consents", headers: authHeaders, body: { school_id: "haut" }, nowMs });
  const b = await app.inject({ method: "POST", url: "/api/v1/school-bindings", headers: authHeaders, body: { school_id: "haut", student_no: "20248888" }, nowMs });
  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${b.body.data.id}/complete`,
    headers: authHeaders,
    body: { consent_id: c.body.data.id, delegated_secret: "r2_secret" },
    nowMs
  });
  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: authHeaders,
    body: {
      school_binding_id: b.body.data.id,
      consent_id: c.body.data.id,
      target_local_date: "2026-11-16",
      target_local_time: "07:00:00",
      repeat_days: 3,
      remaining_days: 3
    },
    nowMs
  });
  assert.equal(planRes.status, 201);
  const jobId = planRes.body.data.job_id;
  const job = app.store.reservationJobs.get(jobId);
  const before = { state: job.state, version: job.state_version, attempts: job.attempt_count };
  const fireEv = app.store.eventsForJob(jobId).find((e) => e.kind === "FIRE");
  const fireBefore = fireEv?.status;

  // Manual exec on a date that is NOT today — validation must throw BEFORE
  // any MISSED_WINDOW/EXPIRED/rollover mutation happens.
  await assert.rejects(
    () =>
      app.reservationEngine.runScheduleEvent(jobId, "FIRE", nowMs, { manualExecuteNow: true }),
    (err) => err && ["MANUAL_DATE_NOT_ALLOWED", "BOOKING_WINDOW_CLOSED", "BOOKING_NOT_OPEN"].includes(err.code)
  );
  assert.equal(job.state, before.state);
  assert.equal(job.state_version, before.version, "rejected manual exec must not CAS");
  assert.equal(job.attempt_count, before.attempts);
  assert.equal(app.store.eventsForJob(jobId).find((e) => e.kind === "FIRE")?.status, fireBefore, "FIRE event stays ARMED");
  // And the multi-day plan did NOT roll over.
  assert.equal(app.store.reservationJobs.get(jobId).booking_local_date, job.booking_local_date);
});

// ---------------------------------------------------------------------------
// R2-kill-fence: kill-switch flipped DURING the persist-wait still blocks the
// external write — zero dispatches reach the school backend.
// ---------------------------------------------------------------------------
test("R2-12: kill-switch flipped during dispatch-intent persist blocks the write (0 external calls)", async () => {
  const app = createCampusCloudApp({
    requireAdminAccess: false,
    schoolProviderOptions: { mockBackend: new DeterministicMockSchoolBackend() }
  });
  const nowMs = Date.parse("2026-11-16T07:00:00+08:00");
  const { user, authHeaders } = setupBoundUser(app, nowMs);
  const c = await app.inject({ method: "POST", url: "/api/v1/me/consents", headers: authHeaders, body: { school_id: "haut" }, nowMs });
  const b = await app.inject({ method: "POST", url: "/api/v1/school-bindings", headers: authHeaders, body: { school_id: "haut", student_no: "20247777" }, nowMs });
  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${b.body.data.id}/complete`,
    headers: authHeaders,
    body: { consent_id: c.body.data.id, delegated_secret: "r2_secret" },
    nowMs
  });
  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: authHeaders,
    body: {
      school_binding_id: b.body.data.id,
      consent_id: c.body.data.id,
      target_local_date: "2026-11-16",
      target_local_time: "07:00:00"
    },
    nowMs
  });
  const jobId = planRes.body.data.job_id;

  // Count writes at the school backend boundary.
  const backend = app.schoolProvider.mockBackend;
  let writes = 0;
  const origCreate = backend.handleCreateReservation.bind(backend);
  backend.handleCreateReservation = async (args) => { writes += 1; return origCreate(args); };

  // Deterministic mid-flight interleave: the kill switch flips INSIDE the
  // dispatch-intent persist — i.e. the same instant the engine is committing
  // the write intent but before the provider issues the school call. The
  // re-check fence right before the actual write must still block it.
  const origFlush = app.store.flushSnapshotStrictSync.bind(app.store);
  const integ = app.store.schoolIntegrations.get("haut");
  let flipAttempts = 0;
  app.store.flushSnapshotStrictSync = () => {
    origFlush();
    const st = app.store.reservationJobs.get(jobId);
    if (st?.external_execution_state === "DISPATCH_INTENT" && !integ.kill_switch) {
      integ.kill_switch = true;
      flipAttempts += 1;
    }
  };

  let outcome = null;
  try {
    await app.reservationEngine.runScheduleEvent(jobId, "FIRE", nowMs, {});
  } catch (e) {
    outcome = e;
  }
  app.store.flushSnapshotStrictSync = origFlush;
  backend.handleCreateReservation = origCreate;
  integ.kill_switch = false;

  assert.equal(flipAttempts >= 1, true, "the interleave must actually have occurred during persist");
  assert.equal(writes, 0, "no school write may occur once the kill switch flipped");
  // The honest terminal surface after a mid-flight kill: the persisted intent
  // lands in RESULT_UNKNOWN for reconcile (write provably blocked), OR the
  // kill code surfaces directly — what matters is zero external writes.
  const finalJob = app.store.reservationJobs.get(jobId);
  const killed =
    outcome?.code === "SCHOOL_KILL_SWITCH_ACTIVE" ||
    finalJob?.last_error_code === "SCHOOL_KILL_SWITCH_ACTIVE" ||
    ["RESULT_UNKNOWN", "DISPATCH_INTENT"].includes(finalJob?.external_execution_state);
  assert.equal(
    killed,
    true,
    "job must reconcile honestly (kill code or RESULT_UNKNOWN), got " +
      (outcome?.code || finalJob?.last_error_code) +
      "/" +
      finalJob?.external_execution_state
  );
});
