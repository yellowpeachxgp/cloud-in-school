import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { getReservationPriceVersion } from "../packages/contracts/src/index.mjs";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { buildDebitEventKey } from "../packages/finance/src/index.mjs";

test("Finance Saga (PAY-001..020): 100 concurrent debit calls for the same confirmed order deduct wallet exactly once", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "sso_concurrent_user_01",
    displayName: "Concurrency Tester"
  });
  app.financeBridge.setSandboxBalance(user.id, 50_000); // 5.0 🍑

  const orderId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  app.store.reservationOrders.set(orderId, {
    id: orderId,
    job_id: jobId,
    cloud_user_id: user.id,
    price_micropeach: 1_000, // 0.1 🍑
    price_version: "price-library-cloud-2026-11-v1",
    accepted_at: new Date().toISOString(),
    school_result: "CONFIRMED",
    payment_state: "DEBIT_PENDING",
    paid_at: null,
    created_at: new Date().toISOString()
  });

  // Fire 100 concurrent executeDebitForOrder requests
  const results = await Promise.all(
    Array.from({ length: 100 }, () => app.financeService.executeDebitForOrder(orderId))
  );

  for (const r of results) {
    assert.equal(r.payment_state, "PAID");
  }

  const finalWallet = await app.financeService.getWalletSnapshot(user.id);
  assert.equal(
    finalWallet.micropeach_balance,
    49_000,
    "100 concurrent debits with deterministic event_key must deduct 1,000 micropeach exactly once"
  );
  const op = app.store.financeOperations.get(buildDebitEventKey(orderId));
  assert.ok(op);
  assert.equal(op.status, "SUCCEEDED");
});

test("Finance Saga: Post-confirmation insufficient balance sets PAYMENT_DUE without cancelling confirmed library seat", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-03T06:00:00+08:00");
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "sso_spent_elsewhere_user",
    displayName: "Student Spent Elsewhere"
  });
  // Sufficient at T-30m precheck (5.0 🍑)
  app.financeBridge.setSandboxBalance(user.id, 50_000);

  const session = app.identity.issueDeviceSession(user, "Android", null, 1, nowMs);
  const authHeaders = { authorization: `Bearer ${session.access_token}` };

  const bindRes = await app.inject({
    method: "POST",
    url: "/api/v1/school-bindings",
    headers: authHeaders,
    body: { school_id: "haut", student_no: "20237777" },
    nowMs
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${bindRes.body.data.id}/complete`,
    headers: authHeaders,
    body: { delegated_secret: "cookie" },
    nowMs
  });
  const consentRes = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: authHeaders,
    body: { school_id: "haut" },
    nowMs
  });
  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: authHeaders,
    body: {
      school_binding_id: bindRes.body.data.id,
      consent_id: consentRes.body.data.id,
      accepted_price_version: getReservationPriceVersion(app.store.pricingMicropeach),
      accepted_price_micropeach: app.store.pricingMicropeach,
      target_local_date: "2026-11-03",
      target_local_time: "07:00:00"
    },
    nowMs
  });
  const jobId = planRes.body.data.job_id;

  // T-30m precheck passes
  await app.reservationEngine.runScheduleEvent(
    jobId,
    "PRECHECK",
    Date.parse("2026-11-03T06:30:00+08:00")
  );

  await app.reservationEngine.runScheduleEvent(jobId, "FINAL_CHECK", Date.parse("2026-11-03T06:55:00+08:00"));

  // Another site spends the balance after the final FIRE check, during school submission.
  const executeCreate = app.schoolProvider.executeMockOrAuthorizedCreate.bind(app.schoolProvider);
  app.schoolProvider.executeMockOrAuthorizedCreate = async (...args) => {
    const result = await executeCreate(...args);
    app.financeBridge.setSandboxBalance(user.id, 0);
    return result;
  };

  // At T=07:00, booking succeeds and is verified, debit fails with WALLET_INSUFFICIENT -> order is PAYMENT_DUE, seat stays CONFIRMED!
  const fireRes = await app.reservationEngine.runScheduleEvent(
    jobId,
    "FIRE",
    Date.parse("2026-11-03T07:00:00+08:00")
  );
  assert.equal(fireRes.job.state, "CONFIRMED", "Seat reservation must remain CONFIRMED");
  assert.equal(fireRes.order.payment_state, "PAYMENT_DUE", "Order must enter PAYMENT_DUE");

  // Later user recharges wallet and admin/reconciler settles the order
  app.financeBridge.setSandboxBalance(user.id, 10_000);
  const settled = await app.financeService.executeDebitForOrder(fireRes.order.id);
  assert.equal(settled.payment_state, "PAID");
});

test("Finance Saga: Refund requires dual-person approval and cannot exceed paid amount", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "sso_refund_user",
    displayName: "Refund User"
  });
  const orderId = crypto.randomUUID();
  app.store.reservationOrders.set(orderId, {
    id: orderId,
    job_id: crypto.randomUUID(),
    cloud_user_id: user.id,
    price_micropeach: 1_000,
    price_version: "v1",
    accepted_at: new Date().toISOString(),
    school_result: "CONFIRMED",
    payment_state: "PAID",
    paid_at: new Date().toISOString(),
    created_at: new Date().toISOString()
  });
  const approver = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "sso_refund_approver",
    username: "admin_2",
    role: "admin",
    displayName: "Refund Approver"
  });

  const operators = ["requester", "approver"].map((subject) => {
    const actor = app.store.findOrCreateCloudUser({ issuer: "https://sso.xpeach.codes", subject: `test_${subject}` });
    app.store.setUserRoles(actor.id, ["FINANCE_OPERATOR"]);
    return actor;
  });
  const request = { amountMicropeach: 1_000, reason: "Service goodwill refund", actorRef: operators[0].id };
  await assert.rejects(() => app.financeService.issueRefundForOrder(orderId, { ...request, amountMicropeach: 2_000 }));
  const pending = await app.financeService.issueRefundForOrder(orderId, request);
  assert.equal(pending.payment_state, "PAID");
  assert.equal(pending.refund_request.status, "PENDING_APPROVAL");
  const refundRequestId = pending.refund_request.id;
  await assert.rejects(() => app.financeService.issueRefundForOrder(orderId, { ...request, refundRequestId }),
    (err) => err.code === "FORBIDDEN");
  const refunded = await app.financeService.issueRefundForOrder(orderId, {
    ...request, refundRequestId, actorRef: operators[1].id
  });
  assert.equal(refunded.payment_state, "REFUNDED");
});
