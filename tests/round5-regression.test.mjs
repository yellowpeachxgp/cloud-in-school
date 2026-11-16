import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { createShutdownController } from "../apps/api/src/shutdown.mjs";

function setupBoundUser(app, nowMs) {
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: `r5_${Math.random().toString(36).slice(2, 9)}`,
    displayName: "R5 Student"
  });
  const session = app.identity.issueDeviceSession(user, "R5 Device", null, 1, nowMs);
  return { user, session, authHeaders: { authorization: `Bearer ${session.access_token}` } };
}

function provision(app, authHeaders, nowMs, studentNo = "20248888") {
  return app
    .inject({ method: "POST", url: "/api/v1/me/consents", headers: authHeaders, body: { school_id: "haut" }, nowMs })
    .then((c) =>
      app
        .inject({ method: "POST", url: "/api/v1/school-bindings", headers: authHeaders, body: { school_id: "haut", student_no: studentNo }, nowMs })
        .then((b) =>
          app.inject({
            method: "POST",
            url: `/api/v1/school-bindings/${b.body.data.id}/complete`,
            headers: authHeaders,
            body: { consent_id: c.body.data.id, delegated_secret: "r5_secret" },
            nowMs
          }).then(() => ({ consent: c.body.data.id, binding: b.body.data.id }))
        )
    );
}

// ---------------------------------------------------------------------------
// C1: close must be CONFIRMED — unconfirmed/errored/rejected close => exit 3;
// no 500ms floor past deadline; second signal accelerates the close wait.
// ---------------------------------------------------------------------------
test("R5-1a: close callback never arrives -> serverClosed:false, exit 3, no floor", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const logs = [];
  let exitCode = null;
  const started = Date.now();
  const { shutdown } = createShutdownController({
    app,
    server: { close: (cb) => {/* never calls back */} },
    stopBackgroundTasks: () => {},
    logLine: (l) => logs.push(l),
    setExitCode: (c) => { exitCode = c; },
    maxDrainMs: 400
  });
  const res = await shutdown("SIGTERM");
  const elapsed = Date.now() - started;
  assert.equal(res.drained, false);
  assert.equal(res.tasksDrained, true);
  assert.equal(res.serverClosed, false);
  assert.equal(exitCode, 3);
  assert.ok(elapsed < 1500, `no 500ms+ floor past deadline (elapsed=${elapsed})`);
  const closeLog = logs.find((l) => l.phase === "server_close_unresolved");
  assert.ok(closeLog && closeLog.serverClosed === false);
  assert.equal(logs.find((l) => l.phase === "shutdown_complete").serverClosed, false);
});

test("R5-1b: close callback error + sync throw are non-success", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  let exitCode = null;
  const { shutdown } = createShutdownController({
    app,
    server: { close: (cb) => cb(new Error("close boom")) },
    stopBackgroundTasks: () => {},
    logLine: () => {},
    setExitCode: (c) => { exitCode = c; },
    maxDrainMs: 300
  });
  await shutdown("SIGTERM");
  assert.equal(exitCode, 3);

  const app2 = createCampusCloudApp({ requireAdminAccess: false });
  let exit2 = null;
  const { shutdown: sd2 } = createShutdownController({
    app: app2,
    server: { close: () => { throw new Error("sync throw"); } },
    stopBackgroundTasks: () => {},
    logLine: () => {},
    setExitCode: (c) => { exit2 = c; },
    maxDrainMs: 300
  });
  const res2 = await sd2("SIGTERM");
  assert.equal(res2.serverClosed, false);
  assert.equal(exit2, 3);
});

test("R5-1c: second signal during close accelerates the wait", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  let exitCode = null;
  const { shutdown } = createShutdownController({
    app,
    server: { close: (cb) => {/* hangs */} },
    stopBackgroundTasks: () => {},
    logLine: () => {},
    setExitCode: (c) => { exitCode = c; },
    maxDrainMs: 60_000
  });
  const started = Date.now();
  const p = shutdown("SIGTERM");
  await new Promise((r) => setTimeout(r, 150)); // let close stage begin
  shutdown("SIGINT"); // shortens deadline to ~2s, not 60s
  await p;
  assert.ok(Date.now() - started < 10_000, "close wait respected accelerated deadline");
  assert.equal(exitCode, 3);
});

test("R5-1d: happy path — drained + persisted + confirmed close -> exit 0", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  let exitCode = null;
  const { shutdown } = createShutdownController({
    app,
    server: { close: (cb) => setTimeout(cb, 10) },
    stopBackgroundTasks: () => {},
    logLine: () => {},
    setExitCode: (c) => { exitCode = c; },
    maxDrainMs: 2_000
  });
  const res = await shutdown("SIGTERM");
  assert.equal(res.serverClosed, true);
  assert.equal(exitCode, 0);
});

// ---------------------------------------------------------------------------
// C2: plan+job+events+quote+receipt is ONE recoverable commit — strict
// persistence failure rolls everything back; a committed receipt replays the
// original result across restarts.
// ---------------------------------------------------------------------------
test("R5-2a: persist failure rolls back plan/job/events/quote/receipt exactly", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const { user, authHeaders } = setupBoundUser(app, nowMs);
  const { consent, binding } = await provision(app, authHeaders, nowMs);
  const q = await app.inject({ method: "GET", url: "/api/v1/reservation-quote", headers: authHeaders, nowMs });
  const quote = q.body.data;

  const orig = app.store.flushSnapshotStrictSync.bind(app.store);
  let calls = 0;
  app.store.flushSnapshotStrictSync = () => {
    calls += 1;
    throw new Error("disk full injected");
  };
  const res = await app.inject({
    method: "POST", url: "/api/v1/reservation-plans", headers: { ...authHeaders, "idempotency-key": "r5-c2a" },
    body: {
      school_binding_id: binding, consent_id: consent,
      target_local_date: "2026-11-16", target_local_time: "07:00:00",
      quote_id: quote.quote_id
    },
    nowMs
  });
  assert.equal(res.status, 503, JSON.stringify(res.body));
  // Zero visible partial state.
  assert.equal(app.store.reservationPlans.size, 0);
  assert.equal(app.store.reservationJobs.size, 0);
  assert.equal(app.store.scheduleEvents.size, 0);
  assert.equal(app.store.idempotencyRecords.size, 0);
  assert.ok(app.store.priceQuotes.has(quote.quote_id), "quote restored after rollback");

  // Retry with the same quote now commits.
  app.store.flushSnapshotStrictSync = orig;
  const ok = await app.inject({
    method: "POST", url: "/api/v1/reservation-plans", headers: { ...authHeaders, "idempotency-key": "r5-c2a" },
    body: {
      school_binding_id: binding, consent_id: consent,
      target_local_date: "2026-11-16", target_local_time: "07:00:00",
      quote_id: quote.quote_id
    },
    nowMs: nowMs + 1000
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test("R5-2b: durable receipt replays original result across restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r5snap-"));
  const snapPath = path.join(dir, "cloud-state.json");
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");

  const app1 = createCampusCloudApp({
    requireAdminAccess: false,
    storeOptions: { snapshotPath: snapPath, requireDurableSnapshot: true }
  });
  const { user, authHeaders } = setupBoundUser(app1, nowMs);
  const { consent, binding } = await provision(app1, authHeaders, nowMs);
  const create = await app1.inject({
    method: "POST", url: "/api/v1/reservation-plans", headers: { ...authHeaders, "idempotency-key": "r5-c2b" },
    body: {
      school_binding_id: binding, consent_id: consent,
      target_local_date: "2026-11-16", target_local_time: "07:00:00",
      expected_price_micropeach: app1.store.pricingMicropeach
    },
    nowMs
  });
  assert.equal(create.status, 201);
  const originalPlanId = create.body.data.plan_id;

  // "Restart": brand-new app loading the same snapshot.
  const app2 = createCampusCloudApp({
    requireAdminAccess: false,
    storeOptions: { snapshotPath: snapPath, requireDurableSnapshot: true }
  });
  const retry = await app2.inject({
    method: "POST", url: "/api/v1/reservation-plans", headers: { ...authHeaders, "idempotency-key": "r5-c2b" },
    body: {
      school_binding_id: binding, consent_id: consent,
      target_local_date: "2026-11-16", target_local_time: "07:00:00",
      expected_price_micropeach: app1.store.pricingMicropeach
    },
    nowMs: nowMs + 2000
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.code, "REQUEST_DUPLICATE");
  assert.equal(retry.body.data.plan_id, originalPlanId, "same committed result, never a second plan");
  assert.equal(
    Array.from(app2.store.reservationJobs.values()).filter((j) => j.plan_id === originalPlanId).length,
    1,
    "exactly one job group survives restart"
  );

  // Different payload under the same key conflicts even after restart.
  const conf = await app2.inject({
    method: "POST", url: "/api/v1/reservation-plans", headers: { ...authHeaders, "idempotency-key": "r5-c2b" },
    body: {
      school_binding_id: binding, consent_id: consent,
      target_local_date: "2026-11-17", target_local_time: "07:00:00"
    },
    nowMs: nowMs + 3000
  });
  assert.equal(conf.status, 409);
  fs.rmSync(dir, { recursive: true, force: true });
});
