import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";

const SNAP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "r6snap-"));
let snapSeq = 0;
function snapApp() {
  return createCampusCloudApp({
    requireAdminAccess: false,
    storeOptions: {
      snapshotPath: path.join(SNAP_DIR, `state-${++snapSeq}.json`),
      requireDurableSnapshot: true
    }
  });
}
import { createShutdownController } from "../apps/api/src/shutdown.mjs";

function setupBoundUser(app, nowMs) {
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: `r6_${Math.random().toString(36).slice(2, 9)}`,
    displayName: "R6 Student"
  });
  const session = app.identity.issueDeviceSession(user, "R6 Device", null, 1, nowMs);
  return { user, session, authHeaders: { authorization: `Bearer ${session.access_token}` } };
}

async function provision(app, authHeaders, nowMs, studentNo = "20248888") {
  const c = await app.inject({ method: "POST", url: "/api/v1/me/consents", headers: authHeaders, body: { school_id: "haut" }, nowMs });
  const b = await app.inject({ method: "POST", url: "/api/v1/school-bindings", headers: authHeaders, body: { school_id: "haut", student_no: studentNo }, nowMs });
  await app.inject({
    method: "POST", url: `/api/v1/school-bindings/${b.body.data.id}/complete`,
    headers: authHeaders, body: { consent_id: c.body.data.id, delegated_secret: "r6_secret" }, nowMs
  });
  return { consent: c.body.data.id, binding: b.body.data.id };
}

const planBody = (binding, consent, extra = {}) => ({
  school_binding_id: binding,
  consent_id: consent,
  target_local_date: "2026-11-16",
  target_local_time: "07:00:00",
  ...extra
});

// ---------------------------------------------------------------------------
// C2a: replace_existing — a commit failure must restore the ORIGINAL plan,
// not strand the user with neither.
// ---------------------------------------------------------------------------
test("R6-1: replace_existing commit failure restores old plan/job/events exactly", async () => {
  const app = snapApp();
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const { user, authHeaders } = setupBoundUser(app, nowMs);
  const { consent, binding } = await provision(app, authHeaders, nowMs);

  const first = await app.inject({
    method: "POST", url: "/api/v1/reservation-plans", headers: authHeaders,
    body: planBody(binding, consent), nowMs
  });
  assert.equal(first.status, 201);
  const oldJob = Array.from(app.store.reservationJobs.values()).find((j) => j.plan_id === first.body.data.plan_id);
  const oldPlan = app.store.reservationPlans.get(first.body.data.plan_id);
  const oldEventStates = new Map(
    Array.from(app.store.scheduleEvents.values()).map((e) => [e.id, { status: e.status, actual_at: e.actual_at }])
  );
  const oldJobVersion = oldJob.state_version;

  app.store._persistFaultInject = "tmp_write";
  const second = await app.inject({
    method: "POST", url: "/api/v1/reservation-plans", headers: authHeaders,
    body: planBody(binding, consent, { replace_existing: true }), nowMs: nowMs + 1000
  });
  assert.equal(second.status, 503);
  assert.equal(second.body.error?.code || second.body.code, "STORAGE_PERSISTENCE_FAILED");

  // Original state fully restored — never left half-cancelled.
  assert.equal(oldPlan.enabled, true);
  assert.equal(oldJob.state, "ARMED");
  assert.equal(oldJob.state_version, oldJobVersion);
  for (const [id, prev] of oldEventStates) {
    const ev = app.store.scheduleEvents.get(id);
    assert.equal(ev.status, prev.status);
    assert.equal(ev.actual_at, prev.actual_at);
  }
  // No orphan new objects.
  const plans = Array.from(app.store.reservationPlans.values());
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, first.body.data.plan_id);
  app.store._persistFaultInject = null;
});

// ---------------------------------------------------------------------------
// C2b: post-rename failure = commit UNKNOWN — never rolled back over a
// published snapshot; the persisted receipt reconciles the retry.
// ---------------------------------------------------------------------------
test("R6-2: post-rename failure keeps state + reports UNKNOWN; retry reconciles via receipt", async () => {
  const app = snapApp();
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const { user, authHeaders } = setupBoundUser(app, nowMs);
  const { consent, binding } = await provision(app, authHeaders, nowMs);

  app.store._persistFaultInject = "dir_fsync";
  const res = await app.inject({
    method: "POST", url: "/api/v1/reservation-plans",
    headers: { ...authHeaders, "idempotency-key": "r6-c2b" },
    body: planBody(binding, consent), nowMs
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.error?.code || res.body.code, "STORAGE_COMMIT_UNKNOWN");

  // State stays live (may be durable) — NO rollback over a published rename.
  assert.equal(app.store.reservationPlans.size, 1);
  assert.equal(app.store.idempotencyRecords.size, 1, "receipt survives the unknown commit");

  // Retry with the same key — the receipt dedupes instead of creating a second plan.
  const retry = await app.inject({
    method: "POST", url: "/api/v1/reservation-plans",
    headers: { ...authHeaders, "idempotency-key": "r6-c2b" },
    body: planBody(binding, consent), nowMs: nowMs + 1000
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.code, "REQUEST_DUPLICATE");
  assert.equal(app.store.reservationPlans.size, 1);
  app.store._persistFaultInject = null;
});

test("R6-3: pre-rename stage matrix — every pre-publish stage rolls back cleanly", async () => {
  for (const stage of ["tmp_open", "tmp_write", "tmp_fsync", "rename"]) {
    const app = snapApp();
    const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
    const { authHeaders } = setupBoundUser(app, nowMs);
    const { consent, binding } = await provision(app, authHeaders, nowMs);
    app.store._persistFaultInject = stage;
    const res = await app.inject({
      method: "POST", url: "/api/v1/reservation-plans",
      headers: { ...authHeaders, "idempotency-key": "r6-mx-" + stage },
      body: planBody(binding, consent), nowMs
    });
    assert.equal(res.status, 503, stage);
    assert.equal(res.body.error?.code || res.body.code, "STORAGE_PERSISTENCE_FAILED", stage);
    assert.equal(app.store.reservationPlans.size, 0, stage + " must not leak");
    assert.equal(app.store.scheduleEvents.size, 0);
    assert.equal(app.store.idempotencyRecords.size, 0);
  }
});

// ---------------------------------------------------------------------------
// C1b: bounded shutdown — terminate is invoked with the final verdict code.
// ---------------------------------------------------------------------------
test("R6-4: terminate fires with the final verdict code after the verdict", async () => {
  const app = snapApp();
  const calls = [];
  const { shutdown } = createShutdownController({
    app,
    server: { close: (cb) => setTimeout(cb, 5) },
    stopBackgroundTasks: () => {},
    logLine: () => {},
    setExitCode: () => {},
    maxDrainMs: 1_000,
    terminate: (code) => calls.push(code)
  });
  await shutdown("SIGTERM");
  assert.deepEqual(calls, [0], "happy path terminates 0");

  const app2 = snapApp();
  const calls2 = [];
  const hung = app2.registerLifecycleTask("scanner");
  const { shutdown: sd2 } = createShutdownController({
    app: app2,
    server: { close: (cb) => {/* never */} },
    stopBackgroundTasks: () => {},
    logLine: () => {},
    setExitCode: () => {},
    maxDrainMs: 200,
    terminate: (code) => calls2.push(code)
  });
  await sd2("SIGTERM");
  assert.deepEqual(calls2, [3], "unresolved work + unconfirmed close terminates 3");
  app2.unregisterLifecycleTask(hung);
});
