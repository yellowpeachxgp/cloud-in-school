import test from "node:test";
import assert from "node:assert/strict";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { HautLibraryProvider } from "../packages/school-spi/src/index.mjs";

async function setupBoundUser(app, nowMs) {
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: `sub_fault_${Math.random().toString(36).slice(2, 9)}`,
    displayName: "Fault Test Student"
  });
  const session = app.identity.issueDeviceSession(user, "Android Device", null, 1, nowMs);
  const authHeaders = { authorization: `Bearer ${session.access_token}` };

  const consentRes = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: authHeaders,
    body: { school_id: "haut" },
    nowMs
  });
  const consentId = consentRes.body.data.id;

  const bindRes = await app.inject({
    method: "POST",
    url: "/api/v1/school-bindings",
    headers: authHeaders,
    body: { school_id: "haut", student_no: "2026990101", consent_id: consentId },
    nowMs
  });
  const bindingId = bindRes.body.data.id;

  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${bindingId}/complete`,
    headers: authHeaders,
    body: {
      credential_kind: "DELEGATED_SESSION_BUNDLE",
      consent_id: consentId,
      delegated_secret: JSON.stringify({
        student_no: "2026990101",
        raw_token: "tok_live_fault_test_0123456789_abcdef_xyz"
      })
    },
    nowMs
  });

  return { authHeaders, consentId, bindingId, cloudUserId: user.id };
}

test("Fault Injection 1 (Cloud P1 Fix): Revocation AFTER addbooking is dispatched preserves confirmed school booking, sets DELEGATION_STOPPED_SCHOOL_CONFIRMED, holds billing, and blocks rollover", async () => {
  const tokenNowMs = Date.parse("2026-11-10T06:00:00+08:00");
  const fireNowMs = Date.parse("2026-11-10T07:00:02+08:00");
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { authHeaders, consentId, bindingId, cloudUserId } = await setupBoundUser(app, tokenNowMs);

  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: {
      ...authHeaders,
      "idempotency-key": "idem_post_dispatch_revoke_1"
    },
    body: {
      school_binding_id: bindingId,
      consent_id: consentId,
      target_local_date: "2026-11-10",
      target_local_time: "07:00:00",
      slot_window: "08:00-22:00",
      area_name: "五层中区",
      candidate_seats: ["05桌 A座"],
      preferred_area_ids: ["五层中区"],
      preferred_seat_ids: ["05桌 A座"],
      repeat_days: 3,
      remaining_days: 3
    },
    nowMs: tokenNowMs
  });
  assert.equal(planRes.status, 201);
  const jobId = planRes.body.data.job_id;
  const job = app.store.reservationJobs.get(jobId);
  job.prewarmed_targets = {
    region_id: 23,
    region_name: "五层中区",
    open_time: "07:30",
    close_time: "22:00",
    start_full: "2026-11-10 08:00:00",
    end_full: "2026-11-10 22:00:00",
    candidate_seats: [{ id: 501, seat_id: 501, seat_name: "五层中区05桌 A座", short_name: "05桌 A座" }]
  };

  let addbookingWriteCount = 0;
  app.schoolProvider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/layout/query")) {
      return {
        code: 200,
        layout: { regionName: "五层中区" },
        seatList: [{ id: 501, seatName: "五层中区05桌 A座", seatStatus: 2 }]
      };
    }
    if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
      addbookingWriteCount += 1;
      // User revokes authorization WHILE addbooking HTTP request is in flight!
      const revokeRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/school-bindings/${bindingId}`,
        headers: authHeaders,
        nowMs: fireNowMs + 20
      });
      assert.equal(revokeRes.status, 200);
      // School server completes the booking and returns bookingid
      return {
        code: 200,
        bookingid: "99887766",
        msg: "预约成功"
      };
    }
    return { code: 200 };
  };

  const fireRes = await app.reservationEngine.runScheduleEvent(jobId, "FIRE", fireNowMs);
  assert.equal(addbookingWriteCount, 1, "Exactly 1 addbooking write was dispatched before revocation");

  // 1. State must NEVER be CANCELLED when school succeeded after dispatch!
  assert.notEqual(fireRes.job.state, "CANCELLED", "Must never discard post-dispatch confirmed booking as CANCELLED");
  assert.equal(fireRes.job.state, "DELEGATION_STOPPED_SCHOOL_CONFIRMED");
  assert.equal(fireRes.job.user_intent_state, "REVOKED");
  assert.equal(fireRes.job.external_execution_state, "SCHOOL_CONFIRMED");
  assert.equal(fireRes.job.school_cancellation_state, "MANUAL_ACTION_REQUIRED");
  assert.equal(fireRes.job.billing_state, "HELD_PENDING_REVIEW");
  assert.equal(fireRes.job.display_status, "DELEGATION_STOPPED_SCHOOL_CONFIRMED");
  assert.equal(fireRes.job.status_label, "委托已停止，但学校预约已成功");
  assert.equal(fireRes.job.external_booking_id, "99887766");

  // 2. School reservation record & persistent attempt MUST be saved with booking ID
  const savedRes = app.store.schoolReservations.get(jobId);
  assert.ok(savedRes, "schoolReservations must be saved even when revoked mid-flight");
  assert.equal(savedRes.external_booking_id, "99887766");
  assert.equal(savedRes.official_status, "CONFIRMED");
  assert.equal(savedRes.school_cancellation_state, "MANUAL_ACTION_REQUIRED");

  const attempts = app.store.attemptsForJob(jobId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].external_execution_state, "SCHOOL_CONFIRMED");
  assert.equal(attempts[0].external_booking_id, "99887766");
  assert.equal(attempts[0].billing_state, "HELD_PENDING_REVIEW");

  // 3. Zero wallet charge and zero multi-day rollover after revocation
  const userOrders = app.store.recordsForUser("reservationOrders", cloudUserId);
  assert.equal(userOrders.length, 0, "Must not auto-charge wallet when revoked mid-flight");
  assert.equal(fireRes.next_job_id, null, "Must not roll over multi-day plan after revocation");
});

test("Fault Injection 2: Revocation during post-write readback (verifyBookingAuthoritative) also preserves confirmed school booking and blocks billing/rollover", async () => {
  const tokenNowMs = Date.parse("2026-11-11T06:00:00+08:00");
  const fireNowMs = Date.parse("2026-11-11T07:00:05+08:00");
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { authHeaders, consentId, bindingId, cloudUserId } = await setupBoundUser(app, tokenNowMs);

  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: {
      ...authHeaders,
      "idempotency-key": "idem_readback_revoke_2"
    },
    body: {
      school_binding_id: bindingId,
      consent_id: consentId,
      target_local_date: "2026-11-11",
      target_local_time: "07:00:00",
      slot_window: "08:00-22:00",
      area_name: "五层中区",
      candidate_seats: ["05桌 A座"],
      preferred_area_ids: ["五层中区"],
      preferred_seat_ids: ["05桌 A座"],
      repeat_days: 2,
      remaining_days: 2
    },
    nowMs: tokenNowMs
  });
  const jobId = planRes.body.data.job_id;
  const job = app.store.reservationJobs.get(jobId);
  job.prewarmed_targets = {
    region_id: 23,
    region_name: "五层中区",
    open_time: "07:30",
    close_time: "22:00",
    start_full: "2026-11-11 08:00:00",
    end_full: "2026-11-11 22:00:00",
    candidate_seats: [{ id: 501, seat_id: 501, seat_name: "五层中区05桌 A座", short_name: "05桌 A座" }]
  };

  let readbackCallCount = 0;
  app.schoolProvider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
      return { code: 200, bookingid: "88776655", msg: "预约成功" };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
      readbackCallCount += 1;
      if (readbackCallCount >= 2) {
        // User withdraws consent during authoritative readback!
        await app.inject({
          method: "DELETE",
          url: `/api/v1/me/consents/${consentId}`,
          headers: authHeaders,
          nowMs: fireNowMs + 50
        });
      }
      return {
        code: 200,
        data: {
          id: "88776655",
          seatId: 501,
          seatName: "五层中区05桌 A座",
          regionName: "五层中区",
          buildingLayerRegionId: 23,
          startDate: "2026-11-11 08:00:00",
          endDate: "2026-11-11 22:00:00",
          bookingStatus: 1
        }
      };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/bookinglist")) {
      return { code: 200, rows: [] };
    }
    return { code: 200 };
  };

  const fireRes = await app.reservationEngine.runScheduleEvent(jobId, "FIRE", fireNowMs);
  assert.equal(fireRes.job.state, "DELEGATION_STOPPED_SCHOOL_CONFIRMED");
  assert.equal(fireRes.job.external_execution_state, "SCHOOL_CONFIRMED");
  assert.equal(fireRes.job.user_intent_state, "REVOKED");
  assert.equal(fireRes.job.external_booking_id, "88776655");
  assert.ok(app.store.schoolReservations.get(jobId));
  assert.equal(app.store.recordsForUser("reservationOrders", cloudUserId).length, 0);
  assert.equal(fireRes.next_job_id, null);
});

test("Fault Injection 3: Crash recovery after DISPATCH_INTENT transitions to RESULT_UNKNOWN and reconciles via readback with zero duplicate writes", async () => {
  const tokenNowMs = Date.parse("2026-11-12T06:00:00+08:00");
  const fireNowMs = Date.parse("2026-11-12T07:00:05+08:00");
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { authHeaders, consentId, bindingId } = await setupBoundUser(app, tokenNowMs);

  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: {
      ...authHeaders,
      "idempotency-key": "idem_crash_recovery_3"
    },
    body: {
      school_binding_id: bindingId,
      consent_id: consentId,
      target_local_date: "2026-11-12",
      target_local_time: "07:00:00",
      slot_window: "08:00-22:00",
      area_name: "五层中区",
      candidate_seats: ["05桌 A座"],
      preferred_area_ids: ["五层中区"],
      preferred_seat_ids: ["05桌 A座"]
    },
    nowMs: tokenNowMs
  });
  const jobId = planRes.body.data.job_id;
  const job = app.store.reservationJobs.get(jobId);

  // Simulate process crash right after DISPATCH_INTENT was persisted before response arrived
  const attempt = app.store.createReservationAttempt({
    job_id: jobId,
    plan_id: job.plan_id,
    cloud_user_id: job.cloud_user_id,
    school_id: "haut",
    student_no: "2026990101",
    binding_id: bindingId,
    consent_id: consentId,
    auth_version: 1,
    target_local_date: "2026-11-12",
    slot_window: "08:00-22:00",
    candidate_seat_id: "501",
    candidate_seat_name: "05桌 A座",
    candidate_region_name: "五层中区",
    external_execution_state: "DISPATCH_INTENT"
  });
  job.state = "EXECUTING";
  job.external_execution_state = "DISPATCH_INTENT";
  job.latest_attempt_id = attempt.id;

  // Run startup crash recovery
  app.store.migrateAndRecoverState(fireNowMs + 1000);
  assert.equal(job.state, "RESULT_UNKNOWN");
  assert.equal(job.external_execution_state, "RESULT_UNKNOWN");
  assert.equal(job.display_status, "RESULT_UNKNOWN");
  assert.equal(job.status_label, "结果待核对");

  // Subsequent FIRE reconciles via readback without sending another addbooking write!
  let writeCountAfterRecovery = 0;
  app.schoolProvider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
      writeCountAfterRecovery += 1;
      return { code: 200, bookingid: "should_not_be_called" };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
      return {
        code: 200,
        data: {
          id: "77665544",
          seatId: 501,
          seatName: "五层中区05桌 A座",
          regionName: "五层中区",
          buildingLayerRegionId: 23,
          startDate: "2026-11-12 08:00:00",
          endDate: "2026-11-12 22:00:00",
          bookingStatus: 1
        }
      };
    }
    return { code: 200, rows: [] };
  };

  const reconcileRes = await app.reservationEngine.runScheduleEvent(jobId, "FIRE", fireNowMs + 2000);
  assert.equal(writeCountAfterRecovery, 0, "Crash-recovered job must reconcile via readback and never re-send addbooking");
  assert.equal(reconcileRes.job.state, "CONFIRMED");
  assert.equal(reconcileRes.job.external_execution_state, "SCHOOL_CONFIRMED");
  assert.equal(reconcileRes.schoolReservation.external_booking_id, "77665544");
});

test("Fault Injection 4: School cancellation strictly requires exact external_booking_id (never guesses via fetchCurrentActiveBooking) and records CANCEL_RESULT_UNKNOWN on timeout", async () => {
  const provider = new HautLibraryProvider({});
  let currentBookingQueried = false;
  let cancelCalledWith = null;
  provider.authenticateHautSession = async () => ({ rawToken: "tok_cancel_test" });
  provider.fetchCurrentActiveBooking = async () => {
    currentBookingQueried = true;
    return { bookingId: "99999999" };
  };
  provider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/cancel")) {
      cancelCalledWith = pathAndQuery;
      throw new Error("Socket timeout during school cancel");
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
      throw new Error("Readback also timed out");
    }
    return { code: 200 };
  };

  // 1. Missing externalBookingId -> must refuse to cancel and never call fetchCurrentActiveBooking!
  const missingIdRes = await provider.cancelLiveSeatBooking({
    decryptedSecret: JSON.stringify({ student_no: "2026990101", raw_token: "tok_cancel_test" }),
    binding: { student_no: "2026990101" },
    externalBookingId: ""
  });
  assert.equal(missingIdRes.cancelled, false);
  assert.equal(missingIdRes.outcome, "MISSING_EXACT_BOOKING_ID");
  assert.equal(missingIdRes.school_cancellation_state, "MANUAL_ACTION_REQUIRED");
  assert.equal(currentBookingQueried, false, "Must never guess active booking ID when externalBookingId is missing");
  assert.equal(cancelCalledWith, null);

  // 2. Timeout during cancel with exact externalBookingId -> CANCEL_RESULT_UNKNOWN
  const timeoutRes = await provider.cancelLiveSeatBooking({
    decryptedSecret: JSON.stringify({ student_no: "2026990101", raw_token: "tok_cancel_test" }),
    binding: { student_no: "2026990101" },
    externalBookingId: "12345678"
  });
  assert.equal(timeoutRes.cancelled, false);
  assert.equal(timeoutRes.outcome, "CANCEL_RESULT_UNKNOWN");
  assert.equal(timeoutRes.school_cancellation_state, "CANCEL_RESULT_UNKNOWN");
  assert.ok(cancelCalledWith?.includes("bookingid=12345678"));
});

test("Fault Injection 5: Legacy plans without verifiable authorization provenance migrate to NEEDS_RECONFIRMATION and are reported in sync_report", async () => {
  const tokenNowMs = Date.now();
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { authHeaders, cloudUserId } = await setupBoundUser(app, tokenNowMs);

  // Inject a legacy plan without verifiable binding/consent provenance
  const legacyPlanId = "plan_legacy_no_provenance";
  app.store.reservationPlans.set(legacyPlanId, {
    id: legacyPlanId,
    cloud_user_id: cloudUserId,
    school_binding_id: null,
    consent_id: null,
    school_id: "haut",
    target_local_date: "2026-11-25",
    target_local_time: "07:00:00",
    enabled: true,
    created_at: new Date(tokenNowMs).toISOString()
  });
  app.store.indexUserScoped("reservationPlans", legacyPlanId, cloudUserId);

  app.store.migrateAndRecoverState(tokenNowMs);
  const migratedPlan = app.store.reservationPlans.get(legacyPlanId);
  assert.equal(migratedPlan.enabled, false);
  assert.equal(migratedPlan.user_intent_state, "NEEDS_RECONFIRMATION");

  const syncRes = await app.inject({
    method: "POST",
    url: "/api/v1/sync/snapshot",
    headers: authHeaders,
    body: {},
    nowMs: tokenNowMs
  });
  assert.equal(syncRes.status, 200);
  assert.equal(syncRes.body.data.sync_report.plans_needing_reconfirmation_count, 1);
  assert.ok(syncRes.body.data.sync_report.summary_message.includes("需要重新确认授权"));
});
