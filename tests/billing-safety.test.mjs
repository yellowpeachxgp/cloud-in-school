import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { IsolatedFinanceBridge, buildRefundEventKey } from "../packages/finance/src/index.mjs";
import { getReservationPriceVersion } from "../packages/contracts/src/index.mjs";
import { renderConsoleHtml } from "../apps/console/src/main.mjs";

const nowMs = Date.parse("2026-11-03T06:00:00+08:00");
function appWithSandbox(options = {}) {
  return createCampusCloudApp({ ...options,
    financeBridgeOptions: { realDebitsEnabled: false, allowSandboxFallback: true, internalServiceKey: "", ...options.financeBridgeOptions }
  });
}
function durableStoreOptions(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-finance-regression-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { snapshotPath: path.join(dir, "store.json") };
}
function actor(app, name, role = "FINANCE_OPERATOR") {
  const user = app.store.findOrCreateCloudUser({ issuer: "https://sso.example.invalid", subject: `test_${name}` });
  app.store.setUserRoles(user.id, [role]);
  const session = app.identity.issueDeviceSession(user, "Isolated regression", null, 1, nowMs);
  return { user, headers: { authorization: `Bearer ${session.access_token}` } };
}
function paidFixture(options = {}) {
  const app = appWithSandbox(options);
  const customer = actor(app, "customer", "USER");
  const first = actor(app, "first");
  const second = actor(app, "second");
  app.financeBridge.setSandboxBalance(customer.user.id, 10_000);
  const order = { id: crypto.randomUUID(), job_id: crypto.randomUUID(), cloud_user_id: customer.user.id,
    price_micropeach: 10_000, price_peach: 1, payment_state: "PAID", school_result: "CONFIRMED" };
  app.store.reservationOrders.set(order.id, order);
  return { app, customer, first, second, order };
}
async function refund(fixture, operator, body = {}, route = "quick-refund") {
  return fixture.app.inject({ method: "POST", url: `/api/v1/admin/orders/${fixture.order.id}/${route}`,
    headers: operator.headers, body, nowMs });
}
async function createPlanFixture(app) {
  const customer = actor(app, "plan", "USER");
  app.financeBridge.setSandboxBalance(customer.user.id, 50_000);
  const inject = (url, body) => app.inject({ method: "POST", url, headers: customer.headers, body, nowMs });
  const binding = await inject("/api/v1/school-bindings", { school_id: "haut", student_no: "SYNTHETIC001" });
  assert.equal(binding.status, 201);
  await inject(`/api/v1/school-bindings/${binding.body.data.id}/complete`, { delegated_secret: "mock_secret" });
  const consent = await inject("/api/v1/me/consents", { school_id: "haut" });
  const quote = (await app.inject({ method: "GET", url: "/api/v1/pricing/library-booking", nowMs })).body.data;
  return { customer, inject, quote, payload: {
    school_binding_id: binding.body.data.id, consent_id: consent.body.data.id,
    target_local_date: "2026-11-03", target_local_time: "07:00:00",
    accepted_price_version: quote.price_version, accepted_price_micropeach: quote.cloud_hosted_mode_micropeach
  } };
}

test("Billing boundary: explicit false or unset switch cannot POST with a service key", async (t) => {
  const old = process.env.FINANCE_ENABLE_REAL_DEBITS;
  t.after(() => { if (old === undefined) delete process.env.FINANCE_ENABLE_REAL_DEBITS; else process.env.FINANCE_ENABLE_REAL_DEBITS = old; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("Unexpected network"); });
  for (const flag of [undefined, "false", "FALSE", "0", ""]) {
    if (flag === undefined) delete process.env.FINANCE_ENABLE_REAL_DEBITS; else process.env.FINANCE_ENABLE_REAL_DEBITS = flag;
    const bridge = new IsolatedFinanceBridge({ internalServiceKey: "synthetic-not-a-secret", allowSandboxFallback: false });
    assert.equal(bridge.realDebitsEnabled, false);
    for (const delta of [-10_000, 10_000]) {
      await assert.rejects(() => bridge.adjustBalanceIdempotent({ cloudUserId: "real-user", ssoSubject: "real-user",
        deltaMicropeach: delta, eventKey: delta < 0 ? `dis:reservation:${crypto.randomUUID()}:debit:v1` : `dis:reservation:${crypto.randomUUID()}:refund:v1`, reason: "Test" }),
      (err) => err.code === "SSO_UNAVAILABLE");
    }
  }
  process.env.FINANCE_ENABLE_REAL_DEBITS = "true";
  assert.equal(new IsolatedFinanceBridge({ internalServiceKey: "synthetic" }).realDebitsEnabled, true);
  assert.equal(new IsolatedFinanceBridge({ realDebitsEnabled: false, internalServiceKey: "synthetic" }).realDebitsEnabled, false);
  assert.equal(new IsolatedFinanceBridge({ realDebitsEnabled: "false", internalServiceKey: "synthetic" }).realDebitsEnabled, false);
  const nonProductionRealUser = new IsolatedFinanceBridge({ realDebitsEnabled: false,
    internalServiceKey: "synthetic", allowSandboxFallback: true });
  await assert.rejects(() => nonProductionRealUser.adjustBalanceIdempotent({
    cloudUserId: "real-user", ssoSubject: "real-user", deltaMicropeach: -10_000,
    eventKey: `dis:reservation:${crypto.randomUUID()}:debit:v1`, reason: "No fake paid state"
  }), (err) => err.code === "SSO_UNAVAILABLE");
  assert.equal(calls, 0);
});

test("Refund HTTP paths require a second authenticated actor, not a supplied approver string", async () => {
  const f = paidFixture();
  const started = await refund(f, f.first, { second_approver_ref: f.second.user.id, reason: "Duplicate service" });
  assert.equal(started.status, 202);
  assert.equal(f.order.payment_state, "PAID");
  assert.equal(f.app.financeBridge.getSandboxBalance(f.customer.user.id), 10_000);
  const requestId = f.order.refund_request.id;
  const selfApproved = await refund(f, f.first, { refund_request_id: requestId });
  assert.equal(selfApproved.status, 403);
  const guessed = await refund(f, f.second, { refund_request_id: crypto.randomUUID() });
  assert.equal(guessed.status, 409);
  const unauthorized = await refund(f, f.customer, { refund_request_id: requestId });
  assert.equal(unauthorized.status, 403);
  const changed = await refund(f, f.second, { refund_request_id: requestId, amount_micropeach: 5_000, reason: "Duplicate service" }, "refund");
  assert.equal(changed.status, 409);
  const approved = await refund(f, f.second, { refund_request_id: requestId });
  assert.equal(approved.status, 200);
  assert.equal(f.order.refund_request.requested_by, f.first.user.id);
  assert.equal(f.order.refund_request.approved_by, f.second.user.id);
  assert.equal(f.order.refunded_micropeach, 10_000);
  assert.equal(f.app.financeBridge.getSandboxBalance(f.customer.user.id), 20_000);
  assert.equal((await refund(f, f.second, { refund_request_id: requestId })).status, 200);
  assert.equal(f.app.financeBridge.getSandboxBalance(f.customer.user.id), 20_000);
});

test("Refund approval survives snapshot reload and uses the original amount after price change", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refund-approval-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshotPath = path.join(dir, "store.json");
  const f = paidFixture({ storeOptions: { snapshotPath } });
  const started = await refund(f, f.first, { amount_micropeach: 4_000, reason: "Partial refund" }, "refund");
  assert.equal(started.status, 202);
  const requestId = f.order.refund_request.id;
  const reloaded = appWithSandbox({ storeOptions: { snapshotPath, pricingMicropeach: 30_000 } });
  reloaded.financeBridge.setSandboxBalance(f.customer.user.id, 10_000);
  f.app = reloaded;
  f.order = reloaded.store.reservationOrders.get(f.order.id);
  assert.equal(f.order.refund_request.id, requestId);
  const approved = await refund(f, f.second, { amount_micropeach: 4_000, reason: "Partial refund", refund_request_id: requestId }, "refund");
  assert.equal(approved.status, 200);
  assert.equal(f.order.refunded_micropeach, 4_000);
  assert.equal(reloaded.financeBridge.getSandboxBalance(f.customer.user.id), 14_000);
});

test("Refund failure responses and thrown failures remain unpaid, auditable and retryable", async (t) => {
  for (const bridgeResult of [{ ok: false, error: "WALLET_INSUFFICIENT" }, { ok: false, error: "OTHER_FAILURE" }, {}, null, new Error("timeout")]) {
    const f = paidFixture();
    await refund(f, f.first, { reason: "Failed bridge" });
    const id = f.order.refund_request.id;
    const bridge = f.app.financeBridge;
    const original = bridge.adjustBalanceIdempotent.bind(bridge);
    bridge.adjustBalanceIdempotent = async () => { if (bridgeResult instanceof Error) throw bridgeResult; return bridgeResult; };
    const result = await refund(f, f.second, { refund_request_id: id });
    assert.ok(result.status >= 400);
    assert.equal(f.order.payment_state, "PAID");
    assert.equal(f.order.refund_request.status, "FAILED_RETRYABLE");
    assert.equal(f.app.store.financeOperations.get(buildRefundEventKey(f.order.id)).status, "FAILED_RETRYABLE");
    assert.equal(bridge.getSandboxBalance(f.customer.user.id), 10_000);
    bridge.adjustBalanceIdempotent = original;
    assert.equal((await refund(f, f.second, { refund_request_id: id })).status, 200);
    assert.equal(bridge.getSandboxBalance(f.customer.user.id), 20_000);
  }
});

test("Price acceptance rejects missing/stale quotes and settlement locks the agreed price", async () => {
  const app = appWithSandbox();
  const f = await createPlanFixture(app);
  const missing = { ...f.payload };
  delete missing.accepted_price_version;
  assert.equal((await f.inject("/api/v1/reservation-plans", missing)).status, 409);
  assert.equal((await f.inject("/api/v1/reservation-plans", { ...f.payload, accepted_price_version: "obsolete" })).status, 409);
  assert.equal((await f.inject("/api/v1/reservation-plans", { ...f.payload, accepted_price_micropeach: 1_000 })).status, 409);
  assert.equal(app.store.reservationJobs.size, 0);
  const created = await f.inject("/api/v1/reservation-plans", f.payload);
  assert.equal(created.status, 201);
  app.store.pricingMicropeach = 20_000;
  const newQuote = (await app.inject({ method: "GET", url: "/api/v1/pricing/library-booking" })).body.data;
  assert.notEqual(newQuote.price_version, f.quote.price_version);
  const jobId = created.body.data.job_id;
  await app.reservationEngine.runScheduleEvent(jobId, "PRECHECK", nowMs + 1800000);
  await app.reservationEngine.runScheduleEvent(jobId, "FINAL_CHECK", nowMs + 3300000);
  const result = await app.reservationEngine.runScheduleEvent(jobId, "FIRE", nowMs + 3600000);
  assert.equal(result.job.state, "CONFIRMED");
  assert.equal(result.order.price_micropeach, 10_000);
  assert.equal(result.order.price_version, f.quote.price_version);
  assert.equal(app.financeBridge.getSandboxBalance(f.customer.user.id), 40_000);
  await assert.rejects(() => app.financeService.createAndSettleOrderForConfirmedJob({
    job: { id: crypto.randomUUID(), cloud_user_id: f.customer.user.id }, plan: { price_version: "obsolete" }
  }), (err) => err.code === "CONFLICT");
});

test("Zero-price accepted quote is NOT_REQUIRED even if current price is later positive", async () => {
  const app = appWithSandbox({ storeOptions: { pricingMicropeach: 0 } });
  const f = await createPlanFixture(app);
  const created = await f.inject("/api/v1/reservation-plans", f.payload);
  assert.equal(created.status, 201);
  const job = app.store.reservationJobs.get(created.body.data.job_id);
  const plan = app.store.reservationPlans.get(job.plan_id);
  app.store.pricingMicropeach = 10_000;
  const order = await app.financeService.createAndSettleOrderForConfirmedJob({ job, plan });
  assert.equal(order.price_micropeach, 0);
  assert.equal(order.payment_state, "NOT_REQUIRED");
  assert.equal(app.financeBridge.getSandboxBalance(f.customer.user.id), 50_000);
});

test("Debit failure other than insufficient balance cannot be marked PAID", async () => {
  const f = paidFixture();
  f.order.payment_state = "DEBIT_PENDING";
  f.app.financeBridge.adjustBalanceIdempotent = async () => ({ ok: false, error: "UPSTREAM_REJECTED" });
  await assert.rejects(() => f.app.financeService.executeDebitForOrder(f.order.id), (err) => err.code === "SSO_UNAVAILABLE");
  assert.equal(f.order.payment_state, "DEBIT_PENDING");
});

test("Console handler renders actual payment state and accepted order amount", () => {
  const html = renderConsoleHtml({ user: { id: "test-viewer" }, pricingMicropeach: 20_000 });
  const start = html.indexOf("function handleExecuteJobResult(execRes)");
  const end = html.indexOf("var btnFireNow", start);
  const messages = [];
  const context = { showToast: (text) => messages.push(text), setTimeout: () => {} };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  for (const state of ["PAID", "PAYMENT_DUE", "NOT_REQUIRED", "DEBIT_PENDING"]) {
    context.handleExecuteJobResult({ data: { job: { state: "CONFIRMED" }, order: { payment_state: state, price_micropeach: 4_000 } } });
  }
  assert.match(messages[0], /扣除 0.4 🍑/);
  assert.match(messages[1], /待支付/);
  assert.match(messages[2], /无需支付/);
  assert.match(messages[3], /待核实/);
  for (const message of messages.slice(1)) assert.doesNotMatch(message, /已从.*扣除/);
  assert.match(html, /var ACCEPTED_PRICE_MICROPEACH = 20000/);
  assert.ok(html.includes(getReservationPriceVersion(20_000)));
});


test("Actual finance HTTP bridge: 409 cannot be reported as a successful refund", async (t) => {
  const f = paidFixture({ storeOptions: durableStoreOptions(t), financeBridgeOptions: { realDebitsEnabled: true,
    allowSandboxFallback: false, internalServiceKey: "synthetic-key-not-a-real-credential" } });
  f.app.financeBridge.sandboxBalancesMicropeach.delete(f.customer.user.id);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: false, error: "insufficient_peach_balance" }),
      { status: 409, headers: { "content-type": "application/json" } });
  });
  assert.equal((await refund(f, f.first, { reason: "HTTP bridge rejection" })).status, 202);
  assert.equal(calls.length, 0);
  assert.equal((await refund(f, f.second, { refund_request_id: f.order.refund_request.id })).status, 503);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].url, /\/peach\/adjust$/);
  assert.equal(JSON.parse(calls[0].options.body).delta_peach, 1);
  assert.equal(f.order.payment_state, "PAID");
  assert.equal(f.app.store.financeOperations.get(buildRefundEventKey(f.order.id)).last_error_code, "WALLET_INSUFFICIENT");
});

test("A revoked initiating operator cannot have their pending request approved", async () => {
  const f = paidFixture();
  await refund(f, f.first, { reason: "Revoked role" });
  f.app.store.setUserRoles(f.first.user.id, ["USER"]);
  const response = await refund(f, f.second, { refund_request_id: f.order.refund_request.id });
  assert.equal(response.status, 403);
  assert.equal(f.order.payment_state, "PAID");
  assert.equal(f.app.financeBridge.getSandboxBalance(f.customer.user.id), 10_000);
});


test("Live wallet debit boundary rejects mock-only and unverified jobs, including manual reconciliation", async (t) => {
  const f = paidFixture({ storeOptions: durableStoreOptions(t), financeBridgeOptions: { realDebitsEnabled: true,
    allowSandboxFallback: false, internalServiceKey: "synthetic-key-not-a-real-credential" } });
  f.app.financeBridge.sandboxBalancesMicropeach.delete(f.customer.user.id);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true, peachBalance: 4, request_id: "synthetic-response" }),
      { status: 200, headers: { "content-type": "application/json" } });
  });
  const job = { id: f.order.job_id, cloud_user_id: f.customer.user.id, state: "CONFIRMED",
    capability: "MOCK_ONLY", result_verified_at: new Date(nowMs).toISOString() };
  const plan = { price_micropeach: 10_000, price_version: getReservationPriceVersion(10_000),
    price_accepted_at: new Date(nowMs).toISOString() };
  f.app.store.reservationJobs.set(job.id, job);
  f.order.payment_state = "DEBIT_PENDING";
  await assert.rejects(() => f.app.financeService.executeDebitForOrder(f.order.id), (err) => err.code === "SCHOOL_PERMISSION_REQUIRED");
  f.app.store.reservationOrders.delete(f.order.id);
  await assert.rejects(() => f.app.financeService.createAndSettleOrderForConfirmedJob({ job, plan }),
    (err) => err.code === "SCHOOL_PERMISSION_REQUIRED");
  job.capability = "AUTHORIZED_AUTOMATION";
  f.app.store.schoolReservations.set(job.id, { official_status: "CONFIRMED",
    external_booking_id: "haut_mock_2026-11-03_seat", evidence_sha256: "synthetic-evidence" });
  await assert.rejects(() => f.app.financeService.createAndSettleOrderForConfirmedJob({ job, plan }),
    (err) => err.code === "SCHOOL_PERMISSION_REQUIRED");
  assert.equal(calls.length, 0);
  f.app.store.schoolReservations.get(job.id).external_booking_id = "12345";
  const saveSnapshot = f.app.store.saveSnapshot.bind(f.app.store);
  f.app.store.saveSnapshot = () => false;
  await assert.rejects(() => f.app.financeService.createAndSettleOrderForConfirmedJob({ job, plan }),
    (err) => err.code === "CONFLICT");
  assert.equal(calls.length, 0, "Failed durable debit intent must prevent wallet writes");
  f.app.store.saveSnapshot = saveSnapshot;
  const order = await f.app.financeService.createAndSettleOrderForConfirmedJob({ job, plan });
  assert.equal(order.payment_state, "PAID");
  assert.equal(calls.filter((c) => c.url.endsWith("/peach/adjust")).length, 1);
});


test("Live refunds cannot execute if exact approval and operation state cannot be persisted", async (t) => {
  for (const failedSave of [() => false, () => { throw new Error("disk full"); }]) {
    const f = paidFixture({ storeOptions: durableStoreOptions(t), financeBridgeOptions: {
      realDebitsEnabled: true, allowSandboxFallback: false, internalServiceKey: "synthetic" } });
    f.app.financeBridge.sandboxBalancesMicropeach.delete(f.customer.user.id);
    let calls = 0;
    f.app.financeBridge.adjustBalanceIdempotent = async () => { calls += 1; return { ok: true }; };
    assert.equal((await refund(f, f.first, { reason: "Durability gate" })).status, 202);
    f.app.store.saveSnapshot = failedSave;
    const response = await refund(f, f.second, { refund_request_id: f.order.refund_request.id });
    assert.ok(response.status >= 400);
    assert.equal(calls, 0);
    assert.equal(f.order.payment_state, "PAID");
  }
});

test("Live wallet request initiation requires a configured durable store", async () => {
  const f = paidFixture({ financeBridgeOptions: { realDebitsEnabled: true,
    allowSandboxFallback: false, internalServiceKey: "synthetic" } });
  f.app.financeBridge.sandboxBalancesMicropeach.delete(f.customer.user.id);
  let calls = 0;
  f.app.financeBridge.adjustBalanceIdempotent = async () => { calls += 1; return { ok: true }; };
  const response = await refund(f, f.first, { reason: "No durable store" });
  assert.equal(response.status, 409);
  assert.equal((await refund(f, f.first, { reason: "No durable store" })).status, 409);
  assert.equal(calls, 0);
  assert.equal(f.order.payment_state, "PAID");
});


test("Concurrent execute-now and terminal replays return the saved payment result without another debit", async () => {
  const app = appWithSandbox();
  const f = await createPlanFixture(app);
  const created = await f.inject("/api/v1/reservation-plans", f.payload);
  assert.equal(created.status, 201);
  const jobId = created.body.data.job_id;
  const fireMs = nowMs + 3600000;
  const session = app.identity.issueDeviceSession(f.customer.user, "Replay regression", null, 1, fireMs);
  const execute = () => app.inject({ method: "POST", url: `/api/v1/reservation-jobs/${jobId}/execute-now`,
    headers: { authorization: `Bearer ${session.access_token}` }, body: {}, nowMs: fireMs });
  const results = await Promise.all([execute(), execute()]);
  for (const response of results) {
    assert.equal(response.status, 200);
    assert.equal(response.body.data.job.state, "CONFIRMED");
    assert.equal(response.body.data.order.payment_state, "PAID");
    assert.equal(response.body.data.order.price_micropeach, 10_000);
  }
  assert.equal(results[0].body.data.order.id, results[1].body.data.order.id);
  assert.equal(app.store.reservationOrders.size, 1);
  assert.equal(app.financeBridge.getSandboxBalance(f.customer.user.id), 40_000);
  app.financeBridge.adjustBalanceIdempotent = async () => { throw new Error("Terminal replay must not call wallet"); };
  const order = app.store.reservationOrders.get(results[0].body.data.order.id);
  for (const state of ["PAID", "PAYMENT_DUE", "NOT_REQUIRED", "REFUNDED"]) {
    order.payment_state = state;
    const response = await execute();
    assert.equal(response.status, 200);
    assert.equal(response.body.data.order.id, order.id);
    assert.equal(response.body.data.order.payment_state, state);
    const replay = await app.reservationEngine.runScheduleEvent(jobId, "FIRE", fireMs);
    assert.equal(replay.order.id, order.id);
    assert.equal(replay.order.payment_state, state);
  }
  assert.equal(app.financeBridge.getSandboxBalance(f.customer.user.id), 40_000);
});
