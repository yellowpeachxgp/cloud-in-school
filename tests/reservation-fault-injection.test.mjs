import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    binding_id: bindingId,
    student_no: "2026990101",
    auth_version: 1,
    plan_generation: 1,
    target_local_date: "2026-11-10",
    slot_window: "08:00-22:00",
    expires_at: "2026-11-10T07:30:00+08:00",
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

test("Fault Injection 6 (P1 Durable Pre-Write Flush): DISPATCH_INTENT is synchronously flushed to disk (0ms) BEFORE addbooking is sent, and disk persistence failure blocks external write", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-durable-flush-"));
  const snapFile = path.join(tmpDir, "cloud-state.json");
  const tokenNowMs = Date.parse("2026-11-13T06:00:00+08:00");
  const fireNowMs = Date.parse("2026-11-13T07:00:02+08:00");

  const app = createCampusCloudApp({
    requireAdminAccess: false,
    storeOptions: { snapshotPath: snapFile }
  });
  const { authHeaders, consentId, bindingId } = await setupBoundUser(app, tokenNowMs);

  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: {
      ...authHeaders,
      "idempotency-key": "idem_durable_flush_6"
    },
    body: {
      school_binding_id: bindingId,
      consent_id: consentId,
      target_local_date: "2026-11-13",
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
  job.prewarmed_targets = {
    binding_id: bindingId,
    student_no: "2026990101",
    auth_version: 1,
    plan_generation: 1,
    target_local_date: "2026-11-13",
    slot_window: "08:00-22:00",
    expires_at: "2026-11-13T07:30:00+08:00",
    region_id: 23,
    region_name: "五层中区",
    open_time: "07:30",
    close_time: "22:00",
    start_full: "2026-11-13 08:00:00",
    end_full: "2026-11-13 22:00:00",
    candidate_seats: [{ id: 501, seat_id: 501, seat_name: "五层中区05桌 A座", short_name: "05桌 A座" }]
  };

  let diskStateAtExactMomentOfWrite = null;
  let crashedSnapCopy = null;
  app.schoolProvider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
      // Read the disk file IMMEDIATELY (0ms) when addbooking is invoked, before any 200ms timer could fire!
      const rawDisk = fs.readFileSync(snapFile, "utf8");
      crashedSnapCopy = rawDisk;
      diskStateAtExactMomentOfWrite = JSON.parse(rawDisk);
      return { code: 200, bookingid: "66554433", msg: "预约成功" };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
      return {
        code: 200,
        data: {
          id: "66554433",
          seatId: 501,
          seatName: "五层中区05桌 A座",
          regionName: "五层中区",
          buildingLayerRegionId: 23,
          startDate: "2026-11-13 08:00:00",
          endDate: "2026-11-13 22:00:00",
          bookingStatus: 1
        }
      };
    }
    return { code: 200, rows: [] };
  };

  await app.reservationEngine.runScheduleEvent(jobId, "FIRE", fireNowMs);
  assert.ok(diskStateAtExactMomentOfWrite, "Snapshot must exist on disk at the exact moment addbooking is called");
  const diskJobsMap = new Map(diskStateAtExactMomentOfWrite.reservationJobs || []);
  const diskAttemptsMap = new Map(diskStateAtExactMomentOfWrite.reservationAttempts || []);
  const diskJob = diskJobsMap.get(jobId);
  assert.equal(
    diskJob?.external_execution_state,
    "DISPATCH_INTENT",
    "Disk snapshot at the moment of addbooking must already record external_execution_state=DISPATCH_INTENT"
  );
  assert.equal(diskAttemptsMap.size, 1, "Disk snapshot at the moment of addbooking must already contain the attempt record");

  // Simulate process crash at the exact moment addbooking was sent by restoring crashedSnapCopy and booting a new app instance
  const crashRecoverFile = path.join(tmpDir, "cloud-crashed.json");
  fs.writeFileSync(crashRecoverFile, crashedSnapCopy, "utf8");
  const recoveredApp = createCampusCloudApp({
    requireAdminAccess: false,
    storeOptions: { snapshotPath: crashRecoverFile }
  });
  const recoveredJob = recoveredApp.store.reservationJobs.get(jobId);
  assert.equal(
    recoveredJob.state,
    "RESULT_UNKNOWN",
    "Process restart from mid-write disk snapshot must recover job as RESULT_UNKNOWN (never ARMED)"
  );
  assert.equal(recoveredJob.external_execution_state, "RESULT_UNKNOWN");

  // Part B: Disk persistence failure BEFORE external write must fail-closed and NEVER call addbooking!
  const planRes2 = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: {
      ...authHeaders,
      "idempotency-key": "idem_durable_flush_fail_6b"
    },
    body: {
      school_binding_id: bindingId,
      consent_id: consentId,
      target_local_date: "2026-11-14",
      target_local_time: "07:00:00",
      slot_window: "08:00-22:00",
      area_name: "五层中区",
      candidate_seats: ["05桌 A座"],
      preferred_area_ids: ["五层中区"],
      preferred_seat_ids: ["05桌 A座"]
    },
    nowMs: tokenNowMs
  });
  const jobId2 = planRes2.body.data.job_id;
  const job2 = app.store.reservationJobs.get(jobId2);
  job2.prewarmed_targets = {
    binding_id: bindingId,
    student_no: "2026990101",
    auth_version: 1,
    plan_generation: 1,
    target_local_date: "2026-11-14",
    slot_window: "08:00-22:00",
    expires_at: "2026-11-14T07:30:00+08:00",
    region_id: 23,
    region_name: "五层中区",
    open_time: "07:30",
    close_time: "22:00",
    start_full: "2026-11-14 08:00:00",
    end_full: "2026-11-14 22:00:00",
    candidate_seats: [{ id: 501, seat_id: 501, seat_name: "五层中区05桌 A座", short_name: "05桌 A座" }]
  };

  // Point snapshotPath to an invalid path where directory creation/file open will fail (a file used as parent dir)
  const blockerFile = path.join(tmpDir, "blocker-not-a-dir");
  fs.writeFileSync(blockerFile, "x", "utf8");
  app.store.snapshotPath = path.join(blockerFile, "impossible.json");

  let writeCountWhenDiskFails = 0;
  app.schoolProvider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
      writeCountWhenDiskFails += 1;
      return { code: 200, bookingid: "should_never_happen" };
    }
    return { code: 200, rows: [] };
  };

  const fireFailRes = await app.reservationEngine.runScheduleEvent(
    jobId2,
    "FIRE",
    Date.parse("2026-11-14T07:00:02+08:00")
  );
  assert.equal(writeCountWhenDiskFails, 0, "Must NEVER call addbooking when pre-write disk persistence fails");
  assert.equal(fireFailRes.job.external_execution_state, "SCHOOL_REJECTED");
  assert.equal(fireFailRes.job.last_error_code, "STORAGE_PERSISTENCE_FAILED");
});

test("Fault Injection 7 (P1 Authoritative School Cancellation): When cancel & signoff both fail or list is incomplete, cancelLiveSeatBooking returns CANCEL_RESULT_UNKNOWN (never false SCHOOL_CANCELLED)", async () => {
  const provider = new HautLibraryProvider({});

  // Scenario A: cancel & signoff both fail (code 500), and crrentbooking/mybookingInProgress return empty -> must NOT claim SCHOOL_CANCELLED!
  provider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/cancel")) {
      return { code: 500, msg: "取消失败" };
    }
    if (pathAndQuery.startsWith("/seatbook/user/signoff")) {
      return { code: 500, msg: "签退失败" };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
      return { code: 200, data: null };
    }
    if (pathAndQuery.startsWith("/seatbook/user/mybookingInProgress")) {
      return { code: 200, rows: [], total: 0 };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/bookinglist")) {
      return { code: 200, rows: [] };
    }
    return { code: 200 };
  };

  const resBothFailed = await provider.cancelLiveSeatBooking({
    decryptedSecret: JSON.stringify({
      student_no: "2026990101",
      raw_token: "tok_live_fault_test_0123456789_abcdef_xyz"
    }),
    binding: { student_no: "2026990101" },
    externalBookingId: "55443322"
  });
  assert.equal(resBothFailed.cancelled, false, "Must NOT report cancelled=true when cancel and signoff both failed");
  assert.equal(resBothFailed.outcome, "CANCEL_RESULT_UNKNOWN");
  assert.equal(resBothFailed.school_cancellation_state, "CANCEL_RESULT_UNKNOWN");

  // Scenario B: cancel returns 200, crrentbooking returns another booking (id=11111111), and mybookingInProgress still has targetBookingId (55443322) active!
  provider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/cancel")) {
      return { code: 200, msg: "ok" };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
      return {
        code: 200,
        data: { id: "11111111", bookingStatus: 1, seatName: "其他座" }
      };
    }
    if (pathAndQuery.startsWith("/seatbook/user/mybookingInProgress")) {
      return {
        code: 200,
        rows: [{ id: "55443322", bookingStatus: 1, seatName: "五层中区05桌 A座" }],
        total: 1
      };
    }
    return { code: 200, rows: [] };
  };

  const resStillInProgress = await provider.cancelLiveSeatBooking({
    decryptedSecret: JSON.stringify({
      student_no: "2026990101",
      raw_token: "tok_live_fault_test_0123456789_abcdef_xyz"
    }),
    binding: { student_no: "2026990101" },
    externalBookingId: "55443322"
  });
  assert.equal(
    resStillInProgress.cancelled,
    false,
    "Must check mybookingInProgress even when crrentbooking is non-empty, and detect targetBookingId is still active"
  );
  assert.equal(resStillInProgress.outcome, "CANCEL_RESULT_UNKNOWN");

  // Scenario C: cancel returns 200, but mybookingInProgress returns an incomplete/paginated list (total: 60, rows: 15) -> must return CANCEL_RESULT_UNKNOWN
  provider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/cancel")) {
      return { code: 200, msg: "ok" };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
      return { code: 200, data: null };
    }
    if (pathAndQuery.startsWith("/seatbook/user/mybookingInProgress")) {
      return { code: 200, rows: [], total: 5 };
    }
    return { code: 200, rows: [] };
  };

  const resIncompleteList = await provider.cancelLiveSeatBooking({
    decryptedSecret: JSON.stringify({
      student_no: "2026990101",
      raw_token: "tok_live_fault_test_0123456789_abcdef_xyz"
    }),
    binding: { student_no: "2026990101" },
    externalBookingId: "55443322"
  });
  assert.equal(resIncompleteList.cancelled, false, "Incomplete/truncated list must return CANCEL_RESULT_UNKNOWN");
  assert.equal(resIncompleteList.outcome, "CANCEL_RESULT_UNKNOWN");
});

test("Fault Injection 8 (Multi-Device & Engine Switch Coordination): Second device / replace_existing cannot overwrite an in-flight, RESULT_UNKNOWN, or CONFIRMED job for the same student and date", async () => {
  const tokenNowMs = Date.parse("2026-11-15T06:00:00+08:00");
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { authHeaders, consentId, bindingId } = await setupBoundUser(app, tokenNowMs);

  const planRes1 = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: {
      ...authHeaders,
      "idempotency-key": "idem_multidevice_a"
    },
    body: {
      school_binding_id: bindingId,
      consent_id: consentId,
      target_local_date: "2026-11-15",
      target_local_time: "07:00:00",
      slot_window: "08:00-22:00",
      area_name: "五层中区",
      candidate_seats: ["05桌 A座"],
      preferred_area_ids: ["五层中区"],
      preferred_seat_ids: ["05桌 A座"],
      replace_existing: true
    },
    nowMs: tokenNowMs
  });
  assert.equal(planRes1.status, 201);
  const jobId1 = planRes1.body.data.job_id;
  const job1 = app.store.reservationJobs.get(jobId1);

  // Transition job1 to RESULT_UNKNOWN (write already dispatched)
  job1.state = "RESULT_UNKNOWN";
  job1.external_execution_state = "RESULT_UNKNOWN";

  // Device B attempts to submit a replacement plan for the same student & date with replace_existing: true
  const planRes2 = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: {
      ...authHeaders,
      "idempotency-key": "idem_multidevice_b"
    },
    body: {
      school_binding_id: bindingId,
      consent_id: consentId,
      target_local_date: "2026-11-15",
      target_local_time: "07:00:00",
      slot_window: "08:00-22:00",
      area_name: "五层中区",
      candidate_seats: ["06桌 B座"],
      preferred_area_ids: ["五层中区"],
      preferred_seat_ids: ["06桌 B座"],
      replace_existing: true
    },
    nowMs: tokenNowMs + 1000
  });
  assert.equal(planRes2.status, 409, "Must reject replace_existing when existing job is in RESULT_UNKNOWN");
  assert.equal(app.store.reservationJobs.get(jobId1).state, "RESULT_UNKNOWN");
});

test("Fault Injection 9 (Morning 07:00:00 Root-Cause Regression): Wave 0 refreshes expired 401 token instead of aborting as RESULT_UNKNOWN, and preserves #1 candidate seat priority when cand[0] hits temporary 1122 Redis lock", async () => {
  const tokenNowMs = Date.parse("2026-11-16T06:00:00+08:00");
  const fireNowMs = Date.parse("2026-11-16T07:00:01+08:00");
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { authHeaders, consentId, bindingId } = await setupBoundUser(app, tokenNowMs);

  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: {
      ...authHeaders,
      "idempotency-key": "idem_morning_priority_9"
    },
    body: {
      school_binding_id: bindingId,
      consent_id: consentId,
      target_local_date: "2026-11-16",
      target_local_time: "07:00:00",
      area_name: "四层西书库北区",
      candidate_seats: ["05桌 A座", "07桌 F座"],
      preferred_area_ids: ["四层西书库北区"],
      preferred_seat_ids: ["05桌 A座", "07桌 F座"]
    },
    nowMs: tokenNowMs
  });
  assert.equal(planRes.status, 201);
  const jobId = planRes.body.data.job_id;
  const job = app.store.reservationJobs.get(jobId);
  job.prewarmed_targets = {
    binding_id: bindingId,
    student_no: "2026990101",
    auth_version: 1,
    plan_generation: 1,
    target_local_date: "2026-11-16",
    expires_at: "2026-11-16T07:30:00+08:00",
    region_id: 13,
    region_name: "四层西书库北区",
    open_time: "07:30",
    close_time: "22:00",
    start_full: "2026-11-16 07:30:00",
    end_full: "2026-11-16 22:00:00",
    candidate_seats: [
      { id: 601, seat_id: 601, seat_name: "四层西书库北区 05桌 A座", short_name: "05桌 A座" },
      { id: 660, seat_id: 660, seat_name: "四层西书库北区 07桌 F座", short_name: "07桌 F座" }
    ]
  };

  let reauthed = false;
  app.schoolProvider.authenticateHautSession = async () => {
    reauthed = true;
    return {
      rawToken: "tok_refreshed_after_401_0123456789_abcdef_xyz",
      userInfo: { userNo: "2026990101", userName: "Student" }
    };
  };

  const addbookingCalls = [];
  app.schoolProvider.wslibGetJson = async (pathAndQuery, rawToken) => {
    if (pathAndQuery.startsWith("/seatbook/layout/query")) {
      return {
        code: 200,
        layout: { regionName: "四层西书库北区" },
        seatList: [
          { id: 601, seatName: "四层西书库北区 05桌 A座", seatStatus: 2 },
          { id: 660, seatName: "四层西书库北区 07桌 F座", seatStatus: 2 }
        ]
      };
    }
    if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
      addbookingCalls.push({ pathAndQuery, rawToken });
      if (addbookingCalls.length === 1) {
        // Call 1: Overnight cached token expired (401)
        const err = new Error("图书馆登录 Token 已过期");
        err.code = "SCHOOL_AUTH_EXPIRED";
        throw err;
      }
      if (addbookingCalls.length === 2) {
        // Call 2 (after token refresh): cand[0] (601) hits temporary 1122 seat lock at 07:00:01
        return { code: 1122, msg: "本座位已锁定 请稍后再试!" };
      }
      // Call 3 (next wave after lock clears): must still target cand[0] (601), NOT skip to cand[1] (660)!
      return { code: 200, bookingid: "9149999", msg: "成功" };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
      return {
        code: 200,
        data: {
          id: "9149999",
          seatId: 601,
          seatName: "四层西书库北区 05桌 A座",
          regionName: "四层西书库北区",
          buildingLayerRegionId: 13,
          startDate: "2026-11-16 07:30:00",
          endDate: "2026-11-16 22:00:00",
          bookingStatus: 1
        }
      };
    }
    return { code: 200, rows: [] };
  };

  const fireRes = await app.reservationEngine.runScheduleEvent(jobId, "FIRE", fireNowMs);
  assert.equal(reauthed, true, "Must automatically re-authenticate when overnight cached token returns 401");
  assert.equal(fireRes.job.state, "CONFIRMED");
  assert.equal(fireRes.schoolReservation.external_booking_id, "9149999");
  assert.equal(fireRes.schoolReservation.seat_alias, "四层西书库北区 05桌 A座");
  assert.ok(
    addbookingCalls.every((c) => c.pathAndQuery.includes("seatid=601")),
    "Must never skip #1 preferred seat (601) to book #2 seat (660) when #1 seat is merely in temporary 1122 Redis lock"
  );
});

test("Fault Injection 10 (Section 3.2 & 3.3 Gate): Explicit 08:00-22:00 slot_window is preserved verbatim, invalid replace_existing preserves old plan/events, expired prewarm is invalidated, and missing snapshotPath in requireDurableSnapshot mode fails closed", async () => {
  const tokenNowMs = Date.parse("2026-11-17T06:00:00+08:00");
  const fireNowMs = Date.parse("2026-11-17T07:00:02+08:00");
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { authHeaders, consentId, bindingId } = await setupBoundUser(app, tokenNowMs);

  // 1. Create plan with explicit slot_window "08:00-22:00"
  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: {
      ...authHeaders,
      "idempotency-key": "idem_sec3_gate_10a"
    },
    body: {
      school_binding_id: bindingId,
      consent_id: consentId,
      target_local_date: "2026-11-17",
      target_local_time: "07:00:00",
      slot_window: "08:00-22:00",
      area_name: "四层西书库北区",
      candidate_seats: ["05桌 A座"],
      preferred_area_ids: ["四层西书库北区"],
      preferred_seat_ids: ["05桌 A座"]
    },
    nowMs: tokenNowMs
  });
  assert.equal(planRes.status, 201);
  const planId = planRes.body.data.plan_id;
  const jobId = planRes.body.data.job_id;
  const plan = app.store.reservationPlans.get(planId);
  const job = app.store.reservationJobs.get(jobId);
  assert.equal(plan.has_explicit_slot_window, true);
  assert.equal(plan.slot_window, "08:00-22:00");

  // 2. Invalid replace_existing (out-of-window time 06:59:59) MUST NOT cancel the existing plan/job/events!
  const invalidReplaceRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: {
      ...authHeaders,
      "idempotency-key": "idem_sec3_gate_10b_invalid"
    },
    body: {
      school_binding_id: bindingId,
      consent_id: consentId,
      target_local_date: "2026-11-17",
      target_local_time: "06:59:59",
      area_name: "四层西书库北区",
      candidate_seats: ["06桌 B座"],
      replace_existing: true
    },
    nowMs: tokenNowMs + 500
  });
  assert.equal(invalidReplaceRes.status, 422);
  assert.equal(plan.enabled, true, "Existing plan must remain enabled when replacement validation fails");
  assert.equal(job.state, "ARMED", "Existing job must remain ARMED when replacement validation fails");
  assert.ok(
    app.store.eventsForJob(jobId).every((ev) => ev.status === "ARMED"),
    "Existing schedule events must remain ARMED when replacement validation fails"
  );

  // 3. Prewarm preserves explicit 08:00-22:00 even when region open_time is 07:30-22:00
  app.schoolProvider.authenticateHautSession = async () => ({
    rawToken: "tok_sec3_prewarm_0123456789_abcdef_xyz",
    userInfo: { userNo: "2026990101", userName: "Student" }
  });
  app.schoolProvider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/layout/building")) {
      return { code: 200, builderInfo: [{ id: "1", buildingName: "莲花街图书馆" }] };
    }
    if (pathAndQuery.startsWith("/seatbook/layout/region")) {
      return {
        code: 200,
        regionList: [
          {
            id: 13,
            regionName: "四层西书库北区",
            openDate: "07:30",
            closeDate: "22:00",
            num: 100,
            cannum: 80,
            isOpen: 1
          }
        ]
      };
    }
    if (pathAndQuery.startsWith("/seatbook/layout/query")) {
      return {
        code: 200,
        layout: { regionName: "四层西书库北区" },
        seatList: [{ id: 601, seatName: "四层西书库北区 05桌 A座", seatStatus: 2 }]
      };
    }
    return { code: 200 };
  };

  await app.reservationEngine.runScheduleEvent(jobId, "PRECHECK", Date.parse("2026-11-17T06:30:00+08:00"));
  assert.ok(job.prewarmed_targets, "PRECHECK must populate scoped prewarmed_targets");
  assert.equal(
    job.prewarmed_targets.start_full,
    "2026-11-17 08:00:00",
    "Explicit 08:00-22:00 must NOT be replaced by school open_time 07:30:00"
  );
  assert.equal(job.prewarmed_targets.binding_id, bindingId);
  assert.equal(job.prewarmed_targets.student_no, "2026990101");

  // 4. If FINAL_CHECK prewarm fails, stale prewarmed_targets must be invalidated (set to null)
  app.schoolProvider.wslibGetJson = async () => {
    throw new Error("Network error during FINAL_CHECK prewarm");
  };
  await app.reservationEngine.runScheduleEvent(jobId, "FINAL_CHECK", Date.parse("2026-11-17T06:55:00+08:00"));
  assert.equal(job.prewarmed_targets, null, "Failed FINAL_CHECK refresh must invalidate stale prewarmed_targets");

  // 5. requireDurableSnapshot=true without snapshotPath must fail-closed before any external write
  app.store.requireDurableSnapshot = true;
  app.store.snapshotPath = null;
  let writeAttemptedWithoutSnapshotPath = false;
  app.schoolProvider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/layout/building")) {
      return { code: 200, builderInfo: [{ id: "1", buildingName: "莲花街图书馆" }] };
    }
    if (pathAndQuery.startsWith("/seatbook/layout/region")) {
      return {
        code: 200,
        regionList: [
          {
            id: 13,
            regionName: "四层西书库北区",
            openDate: "07:30",
            closeDate: "22:00",
            num: 100,
            cannum: 80,
            isOpen: 1
          }
        ]
      };
    }
    if (pathAndQuery.startsWith("/seatbook/layout/query")) {
      return {
        code: 200,
        layout: { regionName: "四层西书库北区" },
        seatList: [{ id: 601, seatName: "四层西书库北区 05桌 A座", seatStatus: 2 }]
      };
    }
    if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
      writeAttemptedWithoutSnapshotPath = true;
      return { code: 200, bookingid: "should_not_happen" };
    }
    return { code: 200, rows: [] };
  };

  const fireBlockedRes = await app.reservationEngine.runScheduleEvent(jobId, "FIRE", fireNowMs);
  assert.equal(writeAttemptedWithoutSnapshotPath, false, "Must fail-closed before addbooking when requireDurableSnapshot=true and snapshotPath is missing");
  assert.equal(fireBlockedRes.job.last_error_code, "STORAGE_PERSISTENCE_FAILED");
});

test("Fault Injection 11 (Prewarm Missing Metadata & Date Mismatch, Legacy Auth Non-Guessing & Abnormal Cancel Readback)", async () => {
  const tokenNowMs = Date.parse("2026-11-16T06:10:00+08:00");
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { cloudUserId, authHeaders, bindingId, consentId } = await setupBoundUser(app, tokenNowMs);

  // 1. Create a plan for 2026-11-16 at 07:00:00, and inject a legacy/stale prewarmed_targets with 2026-11-15 start_full & missing metadata
  const createRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: {
      ...authHeaders,
      "idempotency-key": "idem_fi11_prewarm"
    },
    body: {
      school_binding_id: bindingId,
      consent_id: consentId,
      preferred_area_ids: ["四层西书库北区"],
      preferred_seat_ids: ["05桌 A座"],
      target_local_date: "2026-11-16",
      target_local_time: "07:00:00",
      slot_window: "08:00-22:00"
    },
    nowMs: tokenNowMs
  });
  assert.equal(createRes.status, 201);
  const jobId = createRes.body.data.job_id;
  const job = app.store.reservationJobs.get(jobId);

  // Inject legacy prewarmed_targets missing target_local_date/binding_id/expires_at and carrying 2026-11-15 date!
  job.prewarmed_targets = {
    region_id: 13,
    region_name: "四层西书库北区",
    start_full: "2026-11-15 08:00:00",
    end_full: "2026-11-15 22:00:00",
    candidate_seats: [{ id: 601, seat_name: "四层西书库北区 05桌 A座", short_name: "05桌 A座" }]
  };

  let addBookingUrls = [];
  app.schoolProvider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/layout/building")) {
      return { code: 200, builderInfo: [{ id: "1", buildingName: "莲花街图书馆" }] };
    }
    if (pathAndQuery.startsWith("/seatbook/layout/region")) {
      return {
        code: 200,
        regionList: [
          {
            id: 13,
            regionName: "四层西书库北区",
            openDate: "07:30",
            closeDate: "22:00",
            num: 100,
            cannum: 80,
            isOpen: 1
          }
        ]
      };
    }
    if (pathAndQuery.startsWith("/seatbook/layout/query")) {
      return {
        code: 200,
        layout: { regionName: "四层西书库北区" },
        seatList: [{ id: 601, seatName: "四层西书库北区 05桌 A座", seatStatus: 2 }]
      };
    }
    if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
      addBookingUrls.push(decodeURIComponent(pathAndQuery));
      return { code: 200, bookingid: "bk_1116_ok", data: { id: "bk_1116_ok" } };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
      if (addBookingUrls.length === 0) {
        return { code: 200, data: null };
      }
      return {
        code: 200,
        data: {
          id: "bk_1116_ok",
          seatId: 601,
          seatName: "四层西书库北区 05桌 A座",
          regionName: "四层西书库北区",
          startDate: "2026-11-16 08:00:00",
          endDate: "2026-11-16 22:00:00",
          bookingStatus: 1
        }
      };
    }
    if (pathAndQuery.startsWith("/seatbook/user/mybookingInProgress")) {
      return { code: 200, total: 1, rows: [] };
    }
    return { code: 200 };
  };

  const fireRes = await app.reservationEngine.runScheduleEvent(
    jobId,
    "FIRE",
    Date.parse("2026-11-16T07:00:00+08:00")
  );
  assert.equal(fireRes.job.state, "CONFIRMED");
  assert.equal(addBookingUrls.length, 1);
  assert.ok(
    addBookingUrls[0].includes("starttime=2026-11-16 08:00:00"),
    `Expected 2026-11-16 in addbooking URL, got: ${addBookingUrls[0]}`
  );

  // 2. Abnormal cancellation readback: if bookinglist throws error or returns non-cancelled status, must return CANCEL_RESULT_UNKNOWN
  app.schoolProvider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/cancel")) {
      return { code: 200, msg: "操作已受理" };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
      return { code: 200, data: null };
    }
    if (pathAndQuery.startsWith("/seatbook/user/mybookingInProgress")) {
      return { code: 200, total: 0, rows: [] };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/bookinglist")) {
      return {
        code: 200,
        total: 1,
        rows: [{ id: "bk_1116_ok", bookingStatus: "0", bookingStatusName: "处理中" }]
      };
    }
    return { code: 200 };
  };
  const cancelRes = await app.reservationEngine.cancelConfirmedOrActiveJob(jobId);
  assert.equal(cancelRes.job.school_cancellation_state, "CANCEL_RESULT_UNKNOWN");
  assert.equal(cancelRes.live_cancel.cancelled, false);

  // 3. Legacy plan missing auth_version must NOT infer current auth in migrateAndRecoverState
  const legacyPlanId = "plan_legacy_no_ver";
  app.store.reservationPlans.set(legacyPlanId, {
    id: legacyPlanId,
    cloud_user_id: cloudUserId,
    school_id: "haut",
    school_binding_id: bindingId,
    consent_id: consentId,
    // auth_version is intentionally missing!
    enabled: true,
    target_local_date: "2026-11-18",
    target_local_time: "07:00:00"
  });
  app.store.migrateAndRecoverState();
  const migratedLegacyPlan = app.store.reservationPlans.get(legacyPlanId);
  assert.equal(migratedLegacyPlan.user_intent_state, "NEEDS_RECONFIRMATION");
  assert.equal(migratedLegacyPlan.enabled, false);
});

test("Fault Injection 12 (Strict Cancellation Readback Formats): Malformed crrentbooking / mybookingInProgress / bookinglist responses or missing explicit cancelled record MUST return CANCEL_RESULT_UNKNOWN", async () => {
  const provider = new HautLibraryProvider({});
  const secret = JSON.stringify({
    student_no: "2026990101",
    raw_token: "tok_cancel_strict_format_0123456789_abcdef"
  });
  const binding = { student_no: "2026990101" };

  // Case A: crrentbooking omits numeric code: 200 (e.g. { data: null } or { code: "500", data: null })
  provider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/cancel")) return { code: 200, msg: "ok" };
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) return { data: null };
    if (pathAndQuery.startsWith("/seatbook/user/mybookingInProgress")) {
      return { code: 200, total: 0, rows: [] };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/bookinglist")) {
      return {
        code: 200,
        total: 1,
        rows: [{ id: "99887766", bookingStatus: 5, bookingStatusName: "已取消" }]
      };
    }
    return { code: 200 };
  };
  const resMissingCurCode = await provider.cancelLiveSeatBooking({
    decryptedSecret: secret,
    binding,
    externalBookingId: "99887766"
  });
  assert.equal(resMissingCurCode.cancelled, false);
  assert.equal(resMissingCurCode.outcome, "CANCEL_RESULT_UNKNOWN");

  // Case B: mybookingInProgress omits numeric code: 200 or omits explicit total (e.g. { code: "500", rows: [] } or { code: 200, rows: [] })
  provider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/cancel")) return { code: 200, msg: "ok" };
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) return { code: 200, data: null };
    if (pathAndQuery.startsWith("/seatbook/user/mybookingInProgress")) {
      return { code: "500", rows: [], total: 0 };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/bookinglist")) {
      return {
        code: 200,
        total: 1,
        rows: [{ id: "99887766", bookingStatus: 5, bookingStatusName: "已取消" }]
      };
    }
    return { code: 200 };
  };
  const resStringInProgCode = await provider.cancelLiveSeatBooking({
    decryptedSecret: secret,
    binding,
    externalBookingId: "99887766"
  });
  assert.equal(resStringInProgCode.cancelled, false);
  assert.equal(resStringInProgCode.outcome, "CANCEL_RESULT_UNKNOWN");

  provider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/cancel")) return { code: 200, msg: "ok" };
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) return { code: 200, data: null };
    if (pathAndQuery.startsWith("/seatbook/user/mybookingInProgress")) {
      return { code: 200, rows: [] }; // missing total!
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/bookinglist")) {
      return {
        code: 200,
        total: 1,
        rows: [{ id: "99887766", bookingStatus: 5, bookingStatusName: "已取消" }]
      };
    }
    return { code: 200 };
  };
  const resMissingTotal = await provider.cancelLiveSeatBooking({
    decryptedSecret: secret,
    binding,
    externalBookingId: "99887766"
  });
  assert.equal(resMissingTotal.cancelled, false);
  assert.equal(resMissingTotal.outcome, "CANCEL_RESULT_UNKNOWN");

  // Case C: bookinglist omits rows array ({ code: 200 }) or omits targetBookingId cancelled record ({ code: 200, total: 0, rows: [] })
  provider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/cancel")) return { code: 200, msg: "ok" };
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) return { code: 200, data: null };
    if (pathAndQuery.startsWith("/seatbook/user/mybookingInProgress")) {
      return { code: 200, total: 0, rows: [] };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/bookinglist")) {
      return { code: 200 }; // missing rows!
    }
    return { code: 200 };
  };
  const resMissingHistRows = await provider.cancelLiveSeatBooking({
    decryptedSecret: secret,
    binding,
    externalBookingId: "99887766"
  });
  assert.equal(resMissingHistRows.cancelled, false);
  assert.equal(resMissingHistRows.outcome, "CANCEL_RESULT_UNKNOWN");

  provider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/cancel")) return { code: 200, msg: "ok" };
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) return { code: 200, data: null };
    if (pathAndQuery.startsWith("/seatbook/user/mybookingInProgress")) {
      return { code: 200, total: 0, rows: [] };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/bookinglist")) {
      return { code: 200, total: 0, rows: [] }; // no explicit cancelled record for 99887766!
    }
    return { code: 200 };
  };
  const resNoExplicitEvidence = await provider.cancelLiveSeatBooking({
    decryptedSecret: secret,
    binding,
    externalBookingId: "99887766"
  });
  assert.equal(resNoExplicitEvidence.cancelled, false);
  assert.equal(resNoExplicitEvidence.outcome, "CANCEL_RESULT_UNKNOWN");
});

test("Fault Injection 13 (P2 Cancellation Terminal Whitelist): Intermediate '取消处理中', '取消失败', unknown/defaulted codes, and code/label contradictions stay CANCEL_RESULT_UNKNOWN", async () => {
  const provider = new HautLibraryProvider({});
  const secret = JSON.stringify({
    student_no: "2026990101",
    raw_token: "tok_cancel_terminal_whitelist_0123456789"
  });
  const binding = { student_no: "2026990101" };

  // Case D: Intermediate ("取消处理中"), failure ("取消失败"), unknown/defaulted codes (0, 7, 8, 9, 99),
  // and code/label contradictions MUST ALL stay CANCEL_RESULT_UNKNOWN!
  const nonTerminalOrContradictoryRows = [
    { id: "99887766", bookingStatus: 5, bookingStatusName: "取消处理中" },
    { id: "99887766", bookingStatus: "", bookingStatusName: "取消处理中" },
    { id: "99887766", bookingStatus: 5, bookingStatusName: "取消失败" },
    { id: "99887766", bookingStatus: 1, bookingStatusName: "取消失败" },
    { id: "99887766", bookingStatus: 0, bookingStatusName: "未知状态" },
    { id: "99887766", bookingStatus: 7, bookingStatusName: "已违约" },
    { id: "99887766", bookingStatus: 8, bookingStatusName: "异常释放" },
    { id: "99887766", bookingStatus: 9, bookingStatusName: "系统结束" },
    { id: "99887766", bookingStatus: 99, bookingStatusName: "" },
    { id: "99887766", bookingStatus: 5, bookingStatusName: "已签退" }, // code vs label contradiction
    { id: "99887766", bookingStatus: 1, bookingStatusName: "已取消" } // active code vs cancelled label contradiction
  ];

  for (const badRow of nonTerminalOrContradictoryRows) {
    provider.wslibGetJson = async (pathAndQuery) => {
      if (pathAndQuery.startsWith("/seatbook/user/cancel")) return { code: 200, msg: "操作已受理" };
      if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) return { code: 200, data: null };
      if (pathAndQuery.startsWith("/seatbook/user/mybookingInProgress")) {
        return { code: 200, total: 1, rows: [badRow] };
      }
      if (pathAndQuery.startsWith("/seatbook/user/my/bookinglist")) {
        return { code: 200, total: 1, rows: [badRow] };
      }
      return { code: 200 };
    };
    const badRes = await provider.cancelLiveSeatBooking({
      decryptedSecret: secret,
      binding,
      externalBookingId: "99887766"
    });
    assert.equal(
      badRes.cancelled,
      false,
      `Must NOT treat ${JSON.stringify(badRow)} as SCHOOL_CANCELLED`
    );
    assert.equal(badRes.outcome, "CANCEL_RESULT_UNKNOWN");
    assert.equal(badRes.school_cancellation_state, "CANCEL_RESULT_UNKNOWN");
  }

  // Case E: Explicit terminal whitelist (5="已取消" and 6="已签退") -> SCHOOL_CANCELLED
  for (const validTerminalRow of [
    { id: "99887766", bookingStatus: 5, bookingStatusName: "已取消" },
    { id: "99887766", bookingStatus: 6, bookingStatusName: "已签退" }
  ]) {
    provider.wslibGetJson = async (pathAndQuery) => {
      if (pathAndQuery.startsWith("/seatbook/user/cancel")) return { code: 200, msg: "取消成功" };
      if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) return { code: 200, data: null };
      if (pathAndQuery.startsWith("/seatbook/user/mybookingInProgress")) {
        return { code: 200, total: 1, rows: [validTerminalRow] };
      }
      if (pathAndQuery.startsWith("/seatbook/user/my/bookinglist")) {
        return { code: 200, total: 1, rows: [validTerminalRow] };
      }
      return { code: 200 };
    };
    const resAuthoritativeOk = await provider.cancelLiveSeatBooking({
      decryptedSecret: secret,
      binding,
      externalBookingId: "99887766"
    });
    assert.equal(resAuthoritativeOk.cancelled, true);
    assert.equal(resAuthoritativeOk.outcome, "SCHOOL_CANCELLED");
    assert.equal(resAuthoritativeOk.school_cancellation_state, "SCHOOL_CANCELLED");
  }
});

test("Fault Injection 14 (Restart State Preservation, Paginated Cancel on mybookinghis, PATCH Lock & Sync Stop-Without-Live-Cancel)", async () => {
  const tokenNowMs = Date.parse("2026-11-18T06:00:00+08:00");
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { authHeaders, consentId, bindingId } = await setupBoundUser(app, tokenNowMs);

  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: { ...authHeaders, "idempotency-key": "idem_fi14_plan" },
    body: {
      school_binding_id: bindingId,
      consent_id: consentId,
      target_local_date: "2026-11-18",
      target_local_time: "07:00:00",
      slot_window: "08:00-22:00",
      area_name: "五层中区",
      candidate_seats: ["05桌 A座"]
    },
    nowMs: tokenNowMs
  });
  assert.equal(planRes.status, 201);
  const planId = planRes.body.data.plan_id;
  const jobId = planRes.body.data.job_id;
  const job = app.store.reservationJobs.get(jobId);

  // 1. PATCH /reservation-plans MUST reject (409) when job is in RESULT_UNKNOWN
  job.state = "RESULT_UNKNOWN";
  job.external_execution_state = "RESULT_UNKNOWN";
  job.attempt_count = 1;
  const patchWhileUnknown = await app.inject({
    method: "PATCH",
    url: `/api/v1/reservation-plans/${planId}`,
    headers: authHeaders,
    body: { area_name: "四层北区", candidate_seats: ["09桌 B座"] },
    nowMs: tokenNowMs + 500
  });
  assert.equal(patchWhileUnknown.status, 409);

  // 2. execute-now on RESULT_UNKNOWN job MUST NOT clobber RESULT_UNKNOWN via PRECHECK/FINAL_CHECK!
  app.schoolProvider.wslibGetJson = async () => {
    throw new Error("Transient network timeout during readback");
  };
  const execUnknownRes = await app.inject({
    method: "POST",
    url: `/api/v1/reservation-jobs/${jobId}/execute-now`,
    headers: authHeaders,
    body: {},
    nowMs: Date.parse("2026-11-18T07:02:00+08:00")
  });
  assert.equal(execUnknownRes.status, 200);
  assert.equal(app.store.reservationJobs.get(jobId).state, "RESULT_UNKNOWN");

  // 3. Offline sync push of reservation_cancellations on an already-CONFIRMED job MUST mark DELEGATION_STOPPED_SCHOOL_CONFIRMED (NOT auto-cancel live school seat!)
  let schoolCancelCalled = false;
  app.schoolProvider.cancelLiveSeatBooking = async () => {
    schoolCancelCalled = true;
    return { cancelled: true, outcome: "SCHOOL_CANCELLED", school_cancellation_state: "SCHOOL_CANCELLED" };
  };
  job.state = "CONFIRMED";
  job.external_execution_state = "SCHOOL_CONFIRMED";
  job.user_intent_state = "ACTIVE";
  job.external_booking_id = "88112233";
  app.store.schoolReservations.set(jobId, {
    id: "sr_fi14",
    job_id: jobId,
    school_id: "haut",
    external_booking_id: "88112233",
    official_status: "CONFIRMED",
    seat_alias: "05桌 A座",
    region_alias: "五层中区",
    evidence_sha256: "deadbeef88112233"
  });

  const syncStopRes = await app.inject({
    method: "POST",
    url: "/api/v1/sync/snapshot",
    headers: authHeaders,
    body: { reservation_cancellations: [jobId] },
    nowMs: Date.parse("2026-11-18T07:05:00+08:00")
  });
  assert.equal(syncStopRes.status, 200);
  assert.equal(schoolCancelCalled, false, "Sync queue-stop must NEVER auto-cancel a confirmed school seat");
  assert.equal(job.user_intent_state, "STOP_REQUESTED");
  assert.equal(job.display_status, "DELEGATION_STOPPED_SCHOOL_CONFIRMED");

  // 4. Restart recovery (migrateAndRecoverState) after consent withdrawal MUST preserve DELEGATION_STOPPED_SCHOOL_CONFIRMED!
  await app.inject({
    method: "DELETE",
    url: `/api/v1/me/consents/${consentId}`,
    headers: authHeaders,
    nowMs: Date.parse("2026-11-18T07:06:00+08:00")
  });
  job.state = "DELEGATION_STOPPED_SCHOOL_CONFIRMED";
  job.external_execution_state = "SCHOOL_CONFIRMED";
  app.store.migrateAndRecoverState(Date.parse("2026-11-18T07:07:00+08:00"));
  assert.equal(job.state, "DELEGATION_STOPPED_SCHOOL_CONFIRMED");
  assert.equal(job.external_execution_state, "SCHOOL_CONFIRMED");
  assert.equal(app.store.reservationPlans.get(planId).user_intent_state, "REVOKED");

  // 5. cancelLiveSeatBooking bounded pagination on /seatbook/user/mybookinghis (total=45, target on page 2) + 401 re-auth
  const provider = new HautLibraryProvider({});
  let reauthed = false;
  provider.authenticateHautSession = async () => {
    reauthed = true;
    return { rawToken: "tok_fresh_cancel_reauth_0123456789" };
  };
  const page1Rows = Array.from({ length: 20 }, (_, i) => ({
    id: String(70000001 + i),
    bookingStatus: 6,
    bookingStatusName: "已签退"
  }));
  const page2Rows = [
    ...Array.from({ length: 10 }, (_, i) => ({
      id: String(70000021 + i),
      bookingStatus: 6,
      bookingStatusName: "已签退"
    })),
    { id: "88112233", bookingStatus: 5, bookingStatusName: "已取消" }
  ];
  provider.wslibGetJson = async (pathAndQuery, tok) => {
    if (tok === "tok_expired_cancel_000") {
      const err = new Error("Token 401 expired");
      err.code = "SCHOOL_AUTH_EXPIRED";
      throw err;
    }
    if (pathAndQuery.startsWith("/seatbook/user/cancel")) return { code: 200, msg: "ok" };
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) return { code: 200, data: null };
    if (pathAndQuery.startsWith("/seatbook/user/mybookingInProgress")) {
      return { code: 200, total: 0, rows: [] };
    }
    if (pathAndQuery.startsWith("/seatbook/user/mybookinghis")) {
      if (pathAndQuery.includes("pageNum=1")) return { code: 200, total: 45, rows: page1Rows };
      if (pathAndQuery.includes("pageNum=2")) return { code: 200, total: 45, rows: page2Rows };
    }
    return { code: 404 };
  };
  const pagedCancelRes = await provider.cancelLiveSeatBooking({
    decryptedSecret: JSON.stringify({ student_no: "2026990101", raw_token: "tok_expired_cancel_000" }),
    binding: { student_no: "2026990101" },
    externalBookingId: "88112233"
  });
  assert.equal(reauthed, true);
  assert.equal(pagedCancelRes.cancelled, true);
  assert.equal(pagedCancelRes.outcome, "SCHOOL_CANCELLED");
});

test("Fault Injection 15 (Out-of-Lock Cancel vs Blocked FIRE & Rolled-Over Child Jobs): cancelConfirmedOrActiveJob records immediate stop intent while FIRE holds withJobLock, blocking write/debit/rollover and never faking SCHOOL_CANCELLED; cancelling old FAILED/EXPIRED job stops parent plan & rolled-over child jobs", async () => {
  const tokenNowMs = Date.parse("2026-11-20T06:00:00+08:00");
  const fireNowMs = Date.parse("2026-11-20T07:00:01+08:00");

  // --- Scenario A: FIRE blocked BEFORE external write (during /seatbook/region/query) when cancelConfirmedOrActiveJob is called ---
  {
    const app = createCampusCloudApp({ requireAdminAccess: false });
    const { authHeaders, consentId, bindingId, cloudUserId } = await setupBoundUser(app, tokenNowMs);
    app.financeBridge.setSandboxBalance(cloudUserId, 50_000);

    const planRes = await app.inject({
      method: "POST",
      url: "/api/v1/reservation-plans",
      headers: { ...authHeaders, "idempotency-key": "idem_fi15_prewrite_cancel" },
      body: {
        school_binding_id: bindingId,
        consent_id: consentId,
        target_local_date: "2026-11-20",
        target_local_time: "07:00:00",
        slot_window: "08:00-22:00",
        area_name: "五层中区",
        candidate_seats: ["05桌 A座"],
        preferred_area_ids: ["五层中区"],
        preferred_seat_ids: ["05桌 A座"],
        repeat_days: 5,
        remaining_days: 5
      },
      nowMs: tokenNowMs
    });
    assert.equal(planRes.status, 201);
    const jobId = planRes.body.data.job_id;
    const planId = app.store.reservationJobs.get(jobId).plan_id;

    let releaseDiscoveryBarrier;
    const discoveryBarrier = new Promise((r) => {
      releaseDiscoveryBarrier = r;
    });
    let notifyDiscoveryEntered;
    const discoveryEntered = new Promise((r) => {
      notifyDiscoveryEntered = r;
    });
    let addBookingCount = 0;

    app.schoolProvider.wslibGetJson = async (pathAndQuery) => {
      if (pathAndQuery.startsWith("/seatbook/layout/building")) {
        notifyDiscoveryEntered();
        await discoveryBarrier;
        return {
          code: 200,
          data: [{ id: 1, buildingName: "莲花街图书馆" }]
        };
      }
      if (pathAndQuery.startsWith("/seatbook/layout/query")) {
        return {
          code: 200,
          layout: { regionName: "五层中区" },
          seatList: [{ id: 501, seatName: "五层中区05桌 A座", seatStatus: 2 }]
        };
      }
      if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
        addBookingCount += 1;
        return { code: 200, bookingid: "bk_should_not_happen" };
      }
      return { code: 200, data: null, total: 0, rows: [] };
    };

    const firePromise = app.reservationEngine.runScheduleEvent(jobId, "FIRE", fireNowMs);
    await discoveryEntered;

    // Issue cancel-seat WHILE FIRE holds withJobLock(jobId)!
    const cancelPromise = app.inject({
      method: "POST",
      url: `/api/v1/reservation-jobs/${jobId}/cancel-seat`,
      headers: authHeaders,
      nowMs: fireNowMs + 500
    });

    // Stop intent MUST already be set BEFORE discoveryBarrier is released!
    assert.equal(app.store.reservationPlans.get(planId).enabled, false);
    assert.equal(app.store.reservationJobs.get(jobId).user_intent_state, "STOP_REQUESTED");

    releaseDiscoveryBarrier();
    const [, cancelHttpRes] = await Promise.all([firePromise, cancelPromise]);
    assert.equal(cancelHttpRes.status, 200);
    assert.equal(addBookingCount, 0, "Cancel before external write must prevent addbooking");
    assert.equal(app.store.reservationJobs.get(jobId).state, "CANCELLED");
    assert.equal(app.store.recordsForUser("reservationOrders", cloudUserId).length, 0, "Zero debit allowed");
    assert.equal(app.store.recordsForUser("reservationJobs", cloudUserId).length, 1, "Zero rollover allowed");
    assert.equal(app.financeBridge.getSandboxBalance(cloudUserId), 50_000);
  }

  // --- Scenario B: FIRE blocked DURING external addbooking write, which returns success AFTER cancelConfirmedOrActiveJob was issued ---
  {
    const app = createCampusCloudApp({ requireAdminAccess: false });
    const { authHeaders, consentId, bindingId, cloudUserId } = await setupBoundUser(app, tokenNowMs);
    app.financeBridge.setSandboxBalance(cloudUserId, 50_000);

    const planRes = await app.inject({
      method: "POST",
      url: "/api/v1/reservation-plans",
      headers: { ...authHeaders, "idempotency-key": "idem_fi15_inflight_success_interleave" },
      body: {
        school_binding_id: bindingId,
        consent_id: consentId,
        target_local_date: "2026-11-20",
        target_local_time: "07:00:00",
        slot_window: "08:00-22:00",
        area_name: "五层中区",
        candidate_seats: ["05桌 A座"],
        preferred_area_ids: ["五层中区"],
        preferred_seat_ids: ["05桌 A座"],
        repeat_days: 5,
        remaining_days: 5
      },
      nowMs: tokenNowMs
    });
    const jobId = planRes.body.data.job_id;
    const jobObj = app.store.reservationJobs.get(jobId);
    const planId = jobObj.plan_id;
    jobObj.prewarmed_targets = {
      binding_id: bindingId,
      student_no: "2026990101",
      auth_version: 1,
      plan_generation: 1,
      target_local_date: "2026-11-20",
      slot_window: "08:00-22:00",
      expires_at: "2026-11-20T07:30:00+08:00",
      region_id: 23,
      region_name: "五层中区",
      open_time: "07:30",
      close_time: "22:00",
      start_full: "2026-11-20 08:00:00",
      end_full: "2026-11-20 22:00:00",
      candidate_seats: [{ id: 501, seat_id: 501, seat_name: "五层中区05桌 A座", short_name: "05桌 A座" }]
    };

    let releaseWriteBarrier;
    const writeBarrier = new Promise((r) => {
      releaseWriteBarrier = r;
    });
    let notifyWriteEntered;
    const writeEntered = new Promise((r) => {
      notifyWriteEntered = r;
    });
    let cancelEndpointCalled = 0;

    app.schoolProvider.wslibGetJson = async (pathAndQuery) => {
      if (pathAndQuery.startsWith("/seatbook/layout/query")) {
        return {
          code: 200,
          layout: { regionName: "五层中区" },
          seatList: [{ id: 501, seatName: "五层中区05桌 A座", seatStatus: 2 }]
        };
      }
      if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
        notifyWriteEntered();
        await writeBarrier;
        return { code: 200, bookingid: "bk_interleaved_7788", msg: "预约成功" };
      }
      if (pathAndQuery.startsWith("/seatbook/user/cancel")) {
        cancelEndpointCalled += 1;
        return { code: 500, msg: "should not auto-cancel during in-flight stop" };
      }
      if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
        return {
          code: 200,
          data: {
            id: "bk_interleaved_7788",
            seatName: "五层中区05桌 A座",
            regionName: "五层中区",
            startTime: "2026-11-20 08:00:00",
            endTime: "2026-11-20 22:00:00",
            bookingStatus: 1,
            bookingStatusName: "预约成功"
          }
        };
      }
      if (pathAndQuery.startsWith("/seatbook/user/mybookingInProgress")) {
        return { code: 200, total: 0, rows: [] };
      }
      return { code: 200, total: 0, rows: [] };
    };

    const firePromise = app.reservationEngine.runScheduleEvent(jobId, "FIRE", fireNowMs);
    await writeEntered;

    const cancelPromise = app.inject({
      method: "POST",
      url: `/api/v1/reservation-jobs/${jobId}/cancel-seat`,
      headers: authHeaders,
      nowMs: fireNowMs + 600
    });

    assert.equal(app.store.reservationPlans.get(planId).enabled, false);
    assert.equal(app.store.reservationJobs.get(jobId).user_intent_state, "STOP_REQUESTED");

    releaseWriteBarrier();
    const [, cancelHttpRes] = await Promise.all([firePromise, cancelPromise]);
    assert.equal(cancelHttpRes.status, 200);

    const finalJob = app.store.reservationJobs.get(jobId);
    const savedSr = app.store.schoolReservations.get(jobId);
    assert.equal(finalJob.state, "DELEGATION_STOPPED_SCHOOL_CONFIRMED");
    assert.equal(finalJob.external_execution_state, "SCHOOL_CONFIRMED");
    assert.equal(finalJob.school_cancellation_state, "MANUAL_ACTION_REQUIRED");
    assert.equal(finalJob.billing_state, "HELD_PENDING_REVIEW");
    assert.equal(savedSr?.external_booking_id, "bk_interleaved_7788");
    assert.equal(cancelHttpRes.body.data.live_cancel.cancelled, false, "Must NEVER fake SCHOOL_CANCELLED");
    assert.equal(cancelEndpointCalled, 0);
    assert.equal(app.store.recordsForUser("reservationOrders", cloudUserId).length, 0, "Must NEVER debit after stop intent");
    assert.equal(app.store.recordsForUser("reservationJobs", cloudUserId).length, 1, "Must NEVER roll over next day job");
    assert.equal(app.financeBridge.getSandboxBalance(cloudUserId), 50_000);
  }

  // --- Scenario C: Multi-day plan where Day-1 job FAILED and rolled over Day-2 ARMED job; cancelling via Day-1 jobId stops parent plan AND Day-2 job ---
  {
    const app = createCampusCloudApp({ requireAdminAccess: false });
    const { authHeaders, consentId, bindingId, cloudUserId } = await setupBoundUser(app, tokenNowMs);

    const planRes = await app.inject({
      method: "POST",
      url: "/api/v1/reservation-plans",
      headers: { ...authHeaders, "idempotency-key": "idem_fi15_rollover_stop" },
      body: {
        school_binding_id: bindingId,
        consent_id: consentId,
        target_local_date: "2026-11-20",
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
    const day1JobId = planRes.body.data.job_id;
    const planId = app.store.reservationJobs.get(day1JobId).plan_id;

    // Force Day-1 job to FAIL (no buildings/regions available) so multi-day rollover creates Day-2 ARMED child job
    app.schoolProvider.wslibGetJson = async (pathAndQuery) => {
      if (pathAndQuery.startsWith("/seatbook/layout/building")) {
        return { code: 200, data: [] };
      }
      return { code: 200, total: 0, rows: [] };
    };

    const day1Fire = await app.reservationEngine.runScheduleEvent(day1JobId, "FIRE", fireNowMs);
    assert.equal(day1Fire.job.state, "FAILED");
    const allJobsAfterDay1 = app.store.recordsForUser("reservationJobs", cloudUserId);
    assert.equal(allJobsAfterDay1.length, 2, "Day-2 job should have rolled over");
    const day2Job = allJobsAfterDay1.find((j) => j.id !== day1JobId);
    assert.equal(day2Job.booking_local_date, "2026-11-21");
    assert.equal(app.store.reservationPlans.get(planId).enabled, true);

    // Client still holding old day1JobId sends cancel -> MUST disable parent plan AND cancel day2Job!
    const cancelOldJobRes = await app.inject({
      method: "POST",
      url: `/api/v1/reservation-jobs/${day1JobId}/cancel`,
      headers: authHeaders,
      nowMs: fireNowMs + 5_000
    });
    assert.equal(cancelOldJobRes.status, 200);
    assert.equal(app.store.reservationPlans.get(planId).enabled, false);
    assert.equal(app.store.reservationPlans.get(planId).user_intent_state, "STOP_REQUESTED");
    assert.equal(app.store.reservationJobs.get(day2Job.id).state, "CANCELLED");
    assert.ok(cancelOldJobRes.body.data.cancelled_child_job_ids.includes(day2Job.id));
  }
});

test("Fault Injection 16 (Cloud #1 — Preserve CANCEL_RESULT_UNKNOWN & Independent Confirmed Evidence Across Stop / Plan Delete / Unbind / Restart)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-cloud-fi16-"));
  const snapshotPath = path.join(tmpDir, "cloud-state.json");
  try {
    const tokenNowMs = Date.parse("2026-11-20T06:00:00+08:00");
    const fireNowMs = Date.parse("2026-11-20T07:00:02+08:00");
    const app = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    const { authHeaders, consentId, bindingId, cloudUserId } = await setupBoundUser(app, tokenNowMs);

    const planRes = await app.inject({
      method: "POST",
      url: "/api/v1/reservation-plans",
      headers: { ...authHeaders, "idempotency-key": "idem_fi16_unknown_cancel" },
      body: {
        school_binding_id: bindingId,
        consent_id: consentId,
        target_local_date: "2026-11-20",
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
    const planId = job.plan_id;
    job.prewarmed_targets = {
      binding_id: bindingId,
      student_no: "2026990101",
      auth_version: 1,
      plan_generation: 1,
      target_local_date: "2026-11-20",
      slot_window: "08:00-22:00",
      expires_at: "2026-11-20T07:30:00+08:00",
      region_id: 23,
      region_name: "五层中区",
      open_time: "07:30",
      close_time: "22:00",
      start_full: "2026-11-20 08:00:00",
      end_full: "2026-11-20 22:00:00",
      candidate_seats: [{ id: 501, seat_id: 501, seat_name: "五层中区05桌 A座", short_name: "05桌 A座" }]
    };
    app.schoolProvider.wslibGetJson = async (pathAndQuery) => {
      if (pathAndQuery.startsWith("/seatbook/layout/query")) {
        return {
          code: 200,
          layout: { regionName: "五层中区" },
          seatList: [{ id: 501, seatName: "五层中区05桌 A座", seatStatus: 2 }]
        };
      }
      if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
        return { code: 200, bookingid: "99007788", msg: "预约成功" };
      }
      if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
        return {
          code: 200,
          data: {
            id: "99007788",
            seatId: 501,
            seatName: "五层中区05桌 A座",
            regionName: "五层中区",
            buildingLayerRegionId: 23,
            startDate: "2026-11-20 08:00:00",
            endDate: "2026-11-20 22:00:00",
            bookingStatus: 1
          }
        };
      }
      return { code: 200, rows: [], total: 0 };
    };

    // 1. Confirm seat via offline mocked FIRE
    const fireRes = await app.reservationEngine.runScheduleEvent(jobId, "FIRE", fireNowMs);
    assert.equal(fireRes.job.state, "CONFIRMED");
    assert.equal(fireRes.job.external_execution_state, "SCHOOL_CONFIRMED");
    const originalSr = app.store.schoolReservations.get(jobId);
    assert.ok(originalSr?.external_booking_id);
    const originalBookingId = originalSr.external_booking_id;
    const originalSha = originalSr.evidence_sha256;

    // 2. Live school seat cancel times out -> CANCEL_RESULT_UNKNOWN (and verify CANCEL_IN_PROGRESS was flushed before call!)
    let flushedCancelInProgressBeforeNetwork = false;
    app.schoolProvider.cancelLiveSeatBooking = async () => {
      const persistedDuringCall = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
      const diskJob = persistedDuringCall.reservationJobs.find(([id]) => id === jobId)?.[1];
      flushedCancelInProgressBeforeNetwork =
        diskJob?.school_cancellation_state === "CANCEL_IN_PROGRESS";
      throw new Error("Upstream cancelbooking read timeout");
    };
    const cancelSeatRes = await app.inject({
      method: "POST",
      url: `/api/v1/reservation-jobs/${jobId}/cancel-seat`,
      headers: authHeaders,
      nowMs: fireNowMs + 10_000
    });
    assert.equal(cancelSeatRes.status, 200);
    assert.equal(
      flushedCancelInProgressBeforeNetwork,
      true,
      "CANCEL_IN_PROGRESS must be strictly persisted to disk before external cancel network call"
    );

    const assertUnknownCancelPreserved = (targetApp, stepLabel) => {
      const j = targetApp.store.reservationJobs.get(jobId);
      const sr = targetApp.store.schoolReservations.get(jobId);
      assert.equal(
        j.school_cancellation_state,
        "CANCEL_RESULT_UNKNOWN",
        `${stepLabel}: school_cancellation_state must stay CANCEL_RESULT_UNKNOWN`
      );
      assert.equal(
        j.state,
        "CANCEL_RESULT_UNKNOWN",
        `${stepLabel}: job.state must stay CANCEL_RESULT_UNKNOWN`
      );
      assert.equal(
        j.display_status,
        "CANCEL_RESULT_UNKNOWN",
        `${stepLabel}: display_status must NOT become DELEGATION_STOPPED_SCHOOL_CONFIRMED`
      );
      assert.equal(
        j.status_label,
        "退座结果待核对",
        `${stepLabel}: status_label must NOT claim seat is still active ("委托已停止，但学校预约已成功")`
      );
      assert.equal(
        j.external_execution_state,
        "SCHOOL_CONFIRMED",
        `${stepLabel}: original execution axis must remain SCHOOL_CONFIRMED`
      );
      assert.equal(
        sr?.official_status,
        "CANCEL_RESULT_UNKNOWN",
        `${stepLabel}: school_reservation.official_status must reflect unknown cancellation`
      );
      assert.equal(
        sr?.confirmed_official_status,
        "CONFIRMED",
        `${stepLabel}: independent original confirmation status must remain preserved`
      );
      assert.equal(
        sr?.confirmed_booking_evidence?.external_booking_id,
        originalBookingId,
        `${stepLabel}: independent original booking ID must remain preserved`
      );
      assert.equal(
        sr?.confirmed_booking_evidence?.evidence_sha256,
        originalSha,
        `${stepLabel}: independent original evidence_sha256 must remain preserved`
      );
    };

    assertUnknownCancelPreserved(app, "after cancel-seat timeout");

    // 3. Repeated job stop (POST /reservation-jobs/{id}/cancel -> 409 blocking_jobs, invokes stopPlanAndActiveJobs)
    const repeatStopJob = await app.inject({
      method: "POST",
      url: `/api/v1/reservation-jobs/${jobId}/cancel`,
      headers: authHeaders,
      nowMs: fireNowMs + 15_000
    });
    assert.equal(repeatStopJob.status, 409);
    assertUnknownCancelPreserved(app, "after repeated POST /reservation-jobs/{id}/cancel");

    // 4. Plan deletion / stop (DELETE /reservation-plans/{id})
    const delPlanRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/reservation-plans/${planId}`,
      headers: authHeaders,
      nowMs: fireNowMs + 20_000
    });
    assert.equal(delPlanRes.status, 200);
    assertUnknownCancelPreserved(app, "after DELETE /reservation-plans/{id}");

    // 5. Client sync snapshot with reservation_cancellations
    const syncCancelRes = await app.inject({
      method: "POST",
      url: "/api/v1/sync/snapshot",
      headers: authHeaders,
      body: { reservation_cancellations: [jobId, planId] },
      nowMs: fireNowMs + 25_000
    });
    assert.equal(syncCancelRes.status, 200);
    assertUnknownCancelPreserved(app, "after sync reservation_cancellations");

    // 6. School binding revocation / unlinking (DELETE /school-bindings/{bindingId})
    const unbindRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/school-bindings/${bindingId}`,
      headers: authHeaders,
      nowMs: fireNowMs + 30_000
    });
    assert.equal(unbindRes.status, 200);
    assertUnknownCancelPreserved(app, "after DELETE /school-bindings/{id}");

    // 7. Calling cancel-seat AGAIN after credentials were revoked MUST still preserve CANCEL_RESULT_UNKNOWN
    const cancelAfterUnbind = await app.inject({
      method: "POST",
      url: `/api/v1/reservation-jobs/${jobId}/cancel-seat`,
      headers: authHeaders,
      nowMs: fireNowMs + 35_000
    });
    assert.equal(cancelAfterUnbind.status, 200);
    assertUnknownCancelPreserved(app, "after cancel-seat with revoked credentials");

    // 8. Consent withdrawal (DELETE /me/consents/{consentId})
    const withdrawRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/me/consents/${consentId}`,
      headers: authHeaders,
      nowMs: fireNowMs + 40_000
    });
    assert.equal(withdrawRes.status, 200);
    assertUnknownCancelPreserved(app, "after DELETE /me/consents/{id}");

    // 9. Process restart from snapshotPath -> migrateAndRecoverState + GET /evidence + /sync/snapshot
    const restartedApp = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    assertUnknownCancelPreserved(restartedApp, "after process restart from snapshot");

    const restartedUser = restartedApp.store.users.get(cloudUserId);
    const restartedSession = restartedApp.identity.issueDeviceSession(
      restartedUser,
      "Android Restarted",
      null,
      restartedUser.auth_version,
      fireNowMs + 45_000
    );
    const restartedHeaders = { authorization: `Bearer ${restartedSession.access_token}` };
    const evRes = await restartedApp.inject({
      method: "GET",
      url: `/api/v1/reservation-jobs/${jobId}/evidence`,
      headers: restartedHeaders,
      nowMs: fireNowMs + 46_000
    });
    assert.equal(evRes.status, 200);
    assert.equal(evRes.body.data.display_status, "CANCEL_RESULT_UNKNOWN");
    assert.equal(evRes.body.data.status_label, "退座结果待核对");
    assert.equal(evRes.body.data.school_cancellation_state, "CANCEL_RESULT_UNKNOWN");
    assert.equal(
      evRes.body.data.school_reservation.confirmed_booking_evidence.external_booking_id,
      originalBookingId
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Fault Injection 17 (Cloud #2 — Verifiable Stop Persistence & Fail-Closed on Disk Write Failure, Restart, Retry & FIRE Interleaving)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-cloud-fi17-"));
  const snapshotPath = path.join(tmpDir, "cloud-state.json");
  const blockerFile = path.join(tmpDir, "not-a-directory");
  fs.writeFileSync(blockerFile, "blocker", "utf8");
  const unwritableSnapshotPath = path.join(blockerFile, "cloud-state.json");

  try {
    const tokenNowMs = Date.parse("2026-11-20T06:00:00+08:00");
    const fireNowMs = Date.parse("2026-11-20T07:00:00+08:00");
    const app = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    const { authHeaders, consentId, bindingId } = await setupBoundUser(app, tokenNowMs);

    const planRes = await app.inject({
      method: "POST",
      url: "/api/v1/reservation-plans",
      headers: { ...authHeaders, "idempotency-key": "idem_fi17_strict_stop" },
      body: {
        school_binding_id: bindingId,
        consent_id: consentId,
        target_local_date: "2026-11-20",
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
    assert.equal(planRes.status, 201);
    const jobId = planRes.body.data.job_id;
    const planId = app.store.reservationJobs.get(jobId).plan_id;
    app.store.flushSnapshotStrictSync();

    // Inject deterministic disk persistence failure (unwritable path under regular file)
    app.store.snapshotPath = unwritableSnapshotPath;

    // 1. DELETE /reservation-plans/{planId} MUST fail closed with 503 STORAGE_PERSISTENCE_FAILED (never 200 OK!)
    const failedPlanStop = await app.inject({
      method: "DELETE",
      url: `/api/v1/reservation-plans/${planId}`,
      headers: authHeaders,
      nowMs: tokenNowMs + 1_000
    });
    assert.equal(failedPlanStop.status, 503);
    assert.equal(failedPlanStop.body.ok, false);
    assert.equal(failedPlanStop.body.code, "STORAGE_PERSISTENCE_FAILED");
    assert.equal(failedPlanStop.body.error.retryable, true);

    // 2. POST /reservation-jobs/{jobId}/cancel MUST ALSO fail closed with 503 STORAGE_PERSISTENCE_FAILED
    const failedJobCancel = await app.inject({
      method: "POST",
      url: `/api/v1/reservation-jobs/${jobId}/cancel`,
      headers: authHeaders,
      nowMs: tokenNowMs + 2_000
    });
    assert.equal(failedJobCancel.status, 503);
    assert.equal(failedJobCancel.body.code, "STORAGE_PERSISTENCE_FAILED");

    // 3. Interleaved FIRE in the live process after stop failed to flush MUST still honor in-memory stop intent (0 writes, 0 debits, 0 rollover!)
    let externalWriteCalls = 0;
    app.schoolProvider.executeMockOrAuthorizedCreate = async ({ assertStillAuthorized }) => {
      assertStillAuthorized();
      externalWriteCalls += 1;
      return { outcome: "CONFIRMED" };
    };
    const interleavedFire = await app.reservationEngine.runScheduleEvent(jobId, "FIRE", fireNowMs);
    assert.equal(externalWriteCalls, 0, "FIRE must never dispatch external write after stop intent");
    assert.notEqual(interleavedFire.job.state, "CONFIRMED");
    assert.equal(app.store.reservationOrders.size, 0, "Zero wallet debit on stopped job");

    // 4. Disk recovers -> client retries POST /reservation-jobs/{jobId}/cancel -> MUST succeed (200 OK) and verifiably persist!
    app.store.snapshotPath = snapshotPath;
    const retryCancelOk = await app.inject({
      method: "POST",
      url: `/api/v1/reservation-jobs/${jobId}/cancel`,
      headers: authHeaders,
      nowMs: fireNowMs + 3_000
    });
    assert.equal(retryCancelOk.status, 200, "Idempotent retry after I/O recovery must complete with 200 OK");
    assert.equal(retryCancelOk.body.code, "RESERVATION_JOB_CANCELLED");

    // 5. Process restart from persisted snapshot MUST read back disabled plan & CANCELLED job (never ACTIVE/ARMED!)
    const restartedApp = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    const reloadedPlan = restartedApp.store.reservationPlans.get(planId);
    const reloadedJob = restartedApp.store.reservationJobs.get(jobId);
    assert.equal(reloadedPlan.enabled, false);
    assert.equal(reloadedPlan.user_intent_state, "STOP_REQUESTED");
    assert.equal(reloadedJob.state, "CANCELLED");
    assert.equal(reloadedJob.user_intent_state, "STOP_REQUESTED");
    for (const ev of restartedApp.store.eventsForJob(jobId)) {
      assert.notEqual(ev.status, "ARMED", "No ARMED schedule events may survive persisted stop");
    }

    // 6. Consent withdrawal & binding revocation ALSO fail closed on disk write failure
    app.store.snapshotPath = unwritableSnapshotPath;
    const failedUnbind = await app.inject({
      method: "DELETE",
      url: `/api/v1/school-bindings/${bindingId}`,
      headers: authHeaders,
      nowMs: fireNowMs + 4_000
    });
    assert.equal(failedUnbind.status, 503);
    assert.equal(failedUnbind.body.code, "STORAGE_PERSISTENCE_FAILED");

    const failedConsentWithdraw = await app.inject({
      method: "DELETE",
      url: `/api/v1/me/consents/${consentId}`,
      headers: authHeaders,
      nowMs: fireNowMs + 5_000
    });
    assert.equal(failedConsentWithdraw.status, 503);
    assert.equal(failedConsentWithdraw.body.code, "STORAGE_PERSISTENCE_FAILED");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Fault Injection 18 (Cloud #3 — Strict Directory open/fsync/close Error Propagation, Pending Retention & Zero External Calls)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-cloud-fi18-"));
  const snapshotPath = path.join(tmpDir, "cloud-state.json");
  const origOpenSync = fs.openSync;
  const origFsyncSync = fs.fsyncSync;
  const origCloseSync = fs.closeSync;

  try {
    const tokenNowMs = Date.parse("2026-11-20T06:00:00+08:00");
    const fireNowMs = Date.parse("2026-11-20T07:00:02+08:00");
    const app = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    const { authHeaders, consentId, bindingId } = await setupBoundUser(app, tokenNowMs);

    const planRes = await app.inject({
      method: "POST",
      url: "/api/v1/reservation-plans",
      headers: { ...authHeaders, "idempotency-key": "idem_fi18_dir_fsync" },
      body: {
        school_binding_id: bindingId,
        consent_id: consentId,
        target_local_date: "2026-11-20",
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
    assert.equal(planRes.status, 201);
    const jobId = planRes.body.data.job_id;
    const job = app.store.reservationJobs.get(jobId);
    const planId = job.plan_id;

    // Confirm seat offline so we can also test cancel-seat external call count = 0 on dir I/O fault
    job.prewarmed_targets = {
      binding_id: bindingId,
      student_no: "2026990101",
      auth_version: 1,
      plan_generation: 1,
      target_local_date: "2026-11-20",
      slot_window: "08:00-22:00",
      expires_at: "2026-11-20T07:30:00+08:00",
      region_id: 23,
      region_name: "五层中区",
      open_time: "07:30",
      close_time: "22:00",
      start_full: "2026-11-20 08:00:00",
      end_full: "2026-11-20 22:00:00",
      candidate_seats: [{ id: 501, seat_id: 501, seat_name: "五层中区05桌 A座", short_name: "05桌 A座" }]
    };
    app.schoolProvider.wslibGetJson = async (pathAndQuery) => {
      if (pathAndQuery.startsWith("/seatbook/layout/query")) {
        return {
          code: 200,
          layout: { regionName: "五层中区" },
          seatList: [{ id: 501, seatName: "五层中区05桌 A座", seatStatus: 2 }]
        };
      }
      if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
        return { code: 200, bookingid: "99118822", msg: "预约成功" };
      }
      if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
        return {
          code: 200,
          data: {
            id: "99118822",
            seatId: 501,
            seatName: "五层中区05桌 A座",
            regionName: "五层中区",
            buildingLayerRegionId: 23,
            startDate: "2026-11-20 08:00:00",
            endDate: "2026-11-20 22:00:00",
            bookingStatus: 1
          }
        };
      }
      return { code: 200, rows: [] };
    };
    const fireRes = await app.reservationEngine.runScheduleEvent(jobId, "FIRE", fireNowMs);
    assert.equal(fireRes.job.state, "CONFIRMED");

    let externalLiveCancelCalls = 0;
    app.schoolProvider.cancelLiveSeatBooking = async () => {
      externalLiveCancelCalls += 1;
      return { cancelled: true, outcome: "SCHOOL_CANCELLED", school_cancellation_state: "SCHOOL_CANCELLED" };
    };

    let faultMode = "none"; // "open_eacces" | "fsync_eio" | "close_eio" | "fsync_einval"
    const activeDirFds = new Set();

    fs.openSync = function (targetPath, flags, mode) {
      if (String(targetPath) === tmpDir) {
        if (faultMode === "open_eacces") {
          const err = new Error("Simulated directory openSync permission error");
          err.code = "EACCES";
          throw err;
        }
        const fd = origOpenSync.call(fs, targetPath, flags, mode);
        activeDirFds.add(fd);
        return fd;
      }
      return origOpenSync.call(fs, targetPath, flags, mode);
    };

    fs.fsyncSync = function (fd) {
      if (activeDirFds.has(fd)) {
        if (faultMode === "fsync_eio") {
          const err = new Error("Simulated directory fsyncSync EIO");
          err.code = "EIO";
          throw err;
        }
        if (faultMode === "fsync_einval") {
          const err = new Error("Filesystem does not support directory fsync");
          err.code = "EINVAL";
          throw err;
        }
      }
      return origFsyncSync.call(fs, fd);
    };

    fs.closeSync = function (fd) {
      const isDir = activeDirFds.has(fd);
      activeDirFds.delete(fd);
      const res = origCloseSync.call(fs, fd);
      if (isDir && faultMode === "close_eio") {
        const err = new Error("Simulated directory closeSync EIO");
        err.code = "EIO";
        throw err;
      }
      return res;
    };

    // 1. Directory openSync EACCES on stopPlan -> 503 STORAGE_PERSISTENCE_FAILED & _stopPersistencePending preserved!
    faultMode = "open_eacces";
    const stopOpenErrRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/reservation-plans/${planId}`,
      headers: authHeaders,
      nowMs: fireNowMs + 5_000
    });
    assert.equal(stopOpenErrRes.status, 503);
    assert.equal(stopOpenErrRes.body.code, "STORAGE_PERSISTENCE_FAILED");
    assert.equal(Boolean(app.store.reservationPlans.get(planId)._stopPersistencePending), true);
    assert.equal(Boolean(app.store.reservationJobs.get(jobId)._stopPersistencePending), true);

    // 2. Directory fsyncSync EIO on cancel-seat -> 503 STORAGE_PERSISTENCE_FAILED, _stopPersistencePending preserved, 0 external cancel calls!
    faultMode = "fsync_eio";
    const cancelSeatFsyncErrRes = await app.inject({
      method: "POST",
      url: `/api/v1/reservation-jobs/${jobId}/cancel-seat`,
      headers: authHeaders,
      nowMs: fireNowMs + 6_000
    });
    assert.equal(cancelSeatFsyncErrRes.status, 503);
    assert.equal(cancelSeatFsyncErrRes.body.code, "STORAGE_PERSISTENCE_FAILED");
    assert.equal(externalLiveCancelCalls, 0, "Must NEVER call external school cancel when dir fsync fails");
    assert.equal(Boolean(app.store.reservationPlans.get(planId)._stopPersistencePending), true);
    assert.equal(Boolean(app.store.reservationJobs.get(jobId)._stopPersistencePending), true);

    // 3. Directory closeSync EIO on cancel-seat -> 503 STORAGE_PERSISTENCE_FAILED, _stopPersistencePending preserved, 0 external cancel calls!
    faultMode = "close_eio";
    const cancelSeatCloseErrRes = await app.inject({
      method: "POST",
      url: `/api/v1/reservation-jobs/${jobId}/cancel-seat`,
      headers: authHeaders,
      nowMs: fireNowMs + 7_000
    });
    assert.equal(cancelSeatCloseErrRes.status, 503);
    assert.equal(cancelSeatCloseErrRes.body.code, "STORAGE_PERSISTENCE_FAILED");
    assert.equal(externalLiveCancelCalls, 0, "Must NEVER call external school cancel when dir close fails");
    assert.equal(Boolean(app.store.reservationJobs.get(jobId)._stopPersistencePending), true);

    // 4. Unsupported directory fsync (EINVAL) is cleanly distinguished from real I/O failure -> succeeds & clears _stopPersistencePending!
    faultMode = "fsync_einval";
    const cancelSeatEinvalOk = await app.inject({
      method: "POST",
      url: `/api/v1/reservation-jobs/${jobId}/cancel-seat`,
      headers: authHeaders,
      nowMs: fireNowMs + 8_000
    });
    assert.equal(cancelSeatEinvalOk.status, 200);
    assert.equal(externalLiveCancelCalls, 1);
    assert.equal(Boolean(app.store.reservationPlans.get(planId)._stopPersistencePending), false);
    assert.equal(Boolean(app.store.reservationJobs.get(jobId)._stopPersistencePending), false);
    assert.equal(app.store.reservationJobs.get(jobId).state, "SCHOOL_CANCELLED");
  } finally {
    fs.openSync = origOpenSync;
    fs.fsyncSync = origFsyncSync;
    fs.closeSync = origCloseSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Fault Injection 19 (Cloud P1 #1 — Rebinding School Identity A->B->A Invalidates Old A Plans, Blocks Cross-Student Token Use, Preserves Confirmed/Unknown Evidence & Immutable Snapshot student_no, While Allowing Same-Student Renewal)", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`Offline test blocked unexpected network fetch: ${url}`);
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-cloud-fi19-"));
  const snapshotPath = path.join(tmpDir, "cloud-state.json");

  try {
    const t0 = Date.parse("2026-11-20T06:00:00+08:00");
    const fireMs = Date.parse("2026-11-20T07:00:02+08:00");
    const app = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });

    const user = app.store.findOrCreateCloudUser({
      issuer: "https://sso.xpeach.codes/t/acme",
      subject: "sub_fi19_rebind_p1",
      displayName: "Rebind Safety User"
    });
    const session = app.identity.issueDeviceSession(user, "Android", null, 1, t0);
    const authHeaders = { authorization: `Bearer ${session.access_token}` };

    // Mock school auth & seat endpoints completely offline
    app.schoolProvider.authenticateHautSession = async ({ student_no, raw_token }) => ({
      rawToken: raw_token || `tok_mock_${student_no}_0123456789abcdef`,
      casTgc: "",
      casJsessionId: "",
      userInfo: {
        userNo: student_no,
        userName: `User_${student_no}`,
        department: "信息科学与工程学院"
      }
    });

    const addbookingCalls = [];
    let liveCancelCalls = 0;
    app.schoolProvider.cancelLiveSeatBooking = async () => {
      liveCancelCalls += 1;
      return { cancelled: true, outcome: "SCHOOL_CANCELLED", school_cancellation_state: "SCHOOL_CANCELLED" };
    };
    app.schoolProvider.wslibGetJson = async (pathAndQuery, rawToken) => {
      if (pathAndQuery.startsWith("/seatbook/layout/query")) {
        return {
          code: 200,
          layout: { regionName: "五层中区" },
          seatList: [{ id: 501, seatName: "五层中区05桌 A座", seatStatus: 2 }]
        };
      }
      if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
        addbookingCalls.push({ pathAndQuery, rawToken });
        return { code: 200, bookingid: `bk_${addbookingCalls.length}`, msg: "预约成功" };
      }
      if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
        const lastId = `bk_${addbookingCalls.length}`;
        const dateMatch = lastId === "bk_1" ? "2026-11-20" : "2026-11-22";
        return {
          code: 200,
          data: {
            id: lastId,
            seatId: 501,
            seatName: "五层中区05桌 A座",
            regionName: "五层中区",
            buildingLayerRegionId: 23,
            startDate: `${dateMatch} 08:00:00`,
            endDate: `${dateMatch} 22:00:00`,
            bookingStatus: 1
          }
        };
      }
      return { code: 200, rows: [] };
    };

    // 1. Bind Student A ("20240001") via bind-live
    const bindARes = await app.inject({
      method: "POST",
      url: "/api/v1/school-bindings/bind-live",
      headers: authHeaders,
      body: {
        school_id: "haut",
        student_no: "20240001",
        raw_token: "tok_live_student_A_fake_session_00000001"
      },
      nowMs: t0
    });
    assert.equal(bindARes.status, 201);
    const bindAId = bindARes.body.data.id;
    const consentAId = bindARes.body.data.consent_id;

    // Create 3 jobs for A: (a) confirmed on 2026-11-20, (b) RESULT_UNKNOWN on 2026-11-21, (c) queued ARMED on 2026-11-22
    const createJobFor = async (bId, cId, dateStr, idem) => {
      const r = await app.inject({
        method: "POST",
        url: "/api/v1/reservation-plans",
        headers: { ...authHeaders, "idempotency-key": idem },
        body: {
          school_binding_id: bId,
          consent_id: cId,
          target_local_date: dateStr,
          target_local_time: "07:00:00",
          slot_window: "08:00-22:00",
          area_name: "五层中区",
          candidate_seats: ["05桌 A座"],
          preferred_area_ids: ["五层中区"],
          preferred_seat_ids: ["05桌 A座"],
          repeat_days: 2,
          remaining_days: 2
        },
        nowMs: t0 + 1_000
      });
      assert.equal(r.status, 201);
      const jId = r.body.data.job_id;
      const j = app.store.reservationJobs.get(jId);
      j.prewarmed_targets = {
        binding_id: bId,
        student_no: app.store.schoolBindings.get(bId).student_no,
        auth_version: app.store.schoolBindings.get(bId).auth_version,
        plan_generation: 1,
        target_local_date: dateStr,
        slot_window: "08:00-22:00",
        expires_at: `${dateStr}T07:30:00+08:00`,
        region_id: 23,
        region_name: "五层中区",
        open_time: "07:30",
        close_time: "22:00",
        start_full: `${dateStr} 08:00:00`,
        end_full: `${dateStr} 22:00:00`,
        candidate_seats: [{ id: 501, seat_id: 501, seat_name: "五层中区05桌 A座", short_name: "05桌 A座" }]
      };
      return jId;
    };

    const jobAConfId = await createJobFor(bindAId, consentAId, "2026-11-20", "idem_fi19_A_conf");
    const confFire = await app.reservationEngine.runScheduleEvent(jobAConfId, "FIRE", fireMs);
    assert.equal(confFire.job.state, "CONFIRMED");
    assert.equal(addbookingCalls.length, 1);
    assert.equal(addbookingCalls[0].rawToken, "tok_live_student_A_fake_session_00000001");

    // Cancel rolled-over Day-2 of jobAConf so 2026-11-21 can hold jobAUnknown
    for (const j of app.store.reservationJobs.values()) {
      if (j.id !== jobAConfId && j.booking_local_date === "2026-11-21") {
        j.state = "CANCELLED";
      }
    }

    const jobAUnknownId = await createJobFor(bindAId, consentAId, "2026-11-21", "idem_fi19_A_unk");
    const jobAUnknown = app.store.reservationJobs.get(jobAUnknownId);
    jobAUnknown.state = "RESULT_UNKNOWN";
    jobAUnknown.external_execution_state = "RESULT_UNKNOWN";

    const jobAQueuedId = await createJobFor(bindAId, consentAId, "2026-11-22", "idem_fi19_A_queued");

    // 2. Rebind A -> B ("20240002") via POST /api/v1/school-bindings/bind-live!
    const bindBRes = await app.inject({
      method: "POST",
      url: "/api/v1/school-bindings/bind-live",
      headers: authHeaders,
      body: {
        school_id: "haut",
        student_no: "20240002",
        raw_token: "tok_live_student_B_fake_session_00000002"
      },
      nowMs: fireMs + 5_000
    });
    assert.equal(bindBRes.status, 201);
    const bindBId = bindBRes.body.data.id;
    const consentBId = bindBRes.body.data.consent_id;
    assert.notEqual(bindBId, bindAId, "Rebinding to a different student_no MUST NOT mutate binding in-place");
    assert.equal(app.store.schoolBindings.get(bindAId).student_no, "20240001");
    assert.ok(app.store.schoolBindings.get(bindAId).revoked_at, "Old A binding must be revoked on rebind to B");

    // 3. Running FIRE on A's queued job MUST NOT call addbooking with B's token!
    const callsBeforeBlockedAFire = addbookingCalls.length;
    const blockedAFire = await app.reservationEngine.runScheduleEvent(
      jobAQueuedId,
      "FIRE",
      Date.parse("2026-11-22T07:00:02+08:00")
    );
    assert.equal(addbookingCalls.length, callsBeforeBlockedAFire, "Zero external addbooking calls allowed for A's plan after rebinding to B!");
    assert.equal(blockedAFire.job.state, "CANCELLED");

    // 4. A's confirmed & unknown evidence MUST be preserved, AND sync/snapshot MUST keep student_no = "20240001" on ALL of A's jobs!
    assert.equal(app.store.reservationJobs.get(jobAConfId).display_status, "DELEGATION_STOPPED_SCHOOL_CONFIRMED");
    assert.equal(app.store.schoolReservations.get(jobAConfId).external_booking_id, "bk_1");
    assert.equal(app.store.reservationJobs.get(jobAUnknownId).state, "RESULT_UNKNOWN");

    // Calling cancel-seat on A's confirmed job while bound to B MUST NOT invoke live cancel with B's credentials!
    const cancelAConfUnderB = await app.inject({
      method: "POST",
      url: `/api/v1/reservation-jobs/${jobAConfId}/cancel-seat`,
      headers: authHeaders,
      nowMs: fireMs + 6_000
    });
    assert.equal(cancelAConfUnderB.status, 200);
    assert.equal(liveCancelCalls, 0, "Must NEVER cancel A's seat using B's credentials");

    const snapUnderB = await app.inject({
      method: "POST",
      url: "/api/v1/sync/snapshot",
      headers: authHeaders,
      body: {},
      nowMs: fireMs + 7_000
    });
    assert.equal(snapUnderB.status, 200);
    for (const aJobId of [jobAConfId, jobAUnknownId, jobAQueuedId]) {
      const sj = snapUnderB.body.data.reservation_jobs.find((x) => x.id === aJobId);
      assert.ok(sj, `Expected historical job ${aJobId} in sync snapshot`);
      assert.equal(sj.student_no, "20240001", `Historical A job ${aJobId} must NEVER be mislabeled as B (20240002)!`);
    }

    // 5. Same-student normal renewal: B creates plan on 2026-11-22, refreshes B's own token via bind-live ("20240002"), and FIRE + multi-day rollover succeed!
    const jobBId = await createJobFor(bindBId, consentBId, "2026-11-22", "idem_fi19_B_active");
    const refreshSameB = await app.inject({
      method: "POST",
      url: "/api/v1/school-bindings/bind-live",
      headers: authHeaders,
      body: {
        school_id: "haut",
        student_no: "20240002",
        raw_token: "tok_live_student_B_refreshed_session_002"
      },
      nowMs: fireMs + 8_000
    });
    assert.equal(refreshSameB.status, 201);
    assert.equal(refreshSameB.body.data.id, bindBId, "Same-student bind-live refresh keeps binding active");

    const fireB = await app.reservationEngine.runScheduleEvent(
      jobBId,
      "FIRE",
      Date.parse("2026-11-22T07:00:02+08:00")
    );
    assert.equal(fireB.job.state, "CONFIRMED");
    assert.equal(addbookingCalls[addbookingCalls.length - 1].rawToken, "tok_live_student_B_refreshed_session_002");
    assert.ok(fireB.next_job_id, "Same-student multi-day rollover must succeed");
    assert.equal(app.store.reservationJobs.get(fireB.next_job_id).student_no, "20240002");

    // 6. Rebind back B -> A (A -> B -> A): B's rolled-over job is invalidated, old A1 job stays cancelled, and new A2 plan works!
    const day22AuthMs = Date.parse("2026-11-22T07:30:00+08:00");
    const day22Session = app.identity.issueDeviceSession(
      user,
      "Android",
      null,
      user.auth_version,
      day22AuthMs
    );
    const day22Headers = { authorization: `Bearer ${day22Session.access_token}` };

    const rebindBackARes = await app.inject({
      method: "POST",
      url: "/api/v1/school-bindings/bind-live",
      headers: day22Headers,
      body: {
        school_id: "haut",
        student_no: "20240001",
        raw_token: "tok_live_student_A_rebound_session_00003"
      },
      nowMs: day22AuthMs + 1_000
    });
    assert.equal(rebindBackARes.status, 201);
    assert.notEqual(rebindBackARes.body.data.id, bindBId);
    assert.notEqual(rebindBackARes.body.data.id, bindAId);

    const callsBeforeBlockedBRollover = addbookingCalls.length;
    const blockedBRollover = await app.reservationEngine.runScheduleEvent(
      fireB.next_job_id,
      "FIRE",
      Date.parse("2026-11-23T07:00:02+08:00")
    );
    assert.equal(addbookingCalls.length, callsBeforeBlockedBRollover, "B's rolled-over job must not fire after rebinding back to A");
    assert.equal(blockedBRollover.job.state, "CANCELLED");

    // New A2 plan created under rebound A binding works cleanly AND defense-in-depth blocks direct binding.student_no tamper!
    const bindA2Id = rebindBackARes.body.data.id;
    const consentA2Id = rebindBackARes.body.data.consent_id;
    const rA2 = await app.inject({
      method: "POST",
      url: "/api/v1/reservation-plans",
      headers: { ...day22Headers, "idempotency-key": "idem_fi19_A2_after_aba" },
      body: {
        school_binding_id: bindA2Id,
        consent_id: consentA2Id,
        target_local_date: "2026-11-22",
        target_local_time: "08:00:00",
        slot_window: "09:00-22:00",
        area_name: "五层中区",
        candidate_seats: ["05桌 A座"],
        preferred_area_ids: ["五层中区"],
        preferred_seat_ids: ["05桌 A座"]
      },
      nowMs: day22AuthMs + 2_000
    });
    assert.equal(rA2.status, 201);
    const jobA2Id = rA2.body.data.job_id;
    // Simulate direct tamper of binding.student_no in memory without bumping auth_version: _isJobAuthorizationCurrent & snapshot MUST still protect A!
    app.store.schoolBindings.get(bindA2Id).student_no = "20249999";
    const callsBeforeTamperFire = addbookingCalls.length;
    const blockedTamperFire = await app.reservationEngine.runScheduleEvent(
      jobA2Id,
      "FIRE",
      Date.parse("2026-11-22T08:00:02+08:00")
    );
    assert.equal(addbookingCalls.length, callsBeforeTamperFire, "_isJobAuthorizationCurrent must block tampered binding.student_no");
    assert.equal(blockedTamperFire.job.state, "CANCELLED");

    const snapAfterTamper = await app.inject({
      method: "POST",
      url: "/api/v1/sync/snapshot",
      headers: day22Headers,
      body: {},
      nowMs: day22AuthMs + 10_000
    });
    const sjA2 = snapAfterTamper.body.data.reservation_jobs.find((x) => x.id === jobA2Id);
    assert.equal(sjA2.student_no, "20240001", "Snapshot must prioritize immutable job/plan student_no over mutated binding.student_no");
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Fault Injection 20 (Cloud P1-1 — Async Revocation / Rebind / Logout During Pending bind-live Never Resurrects Revoked Authorization, While Post-Revocation Explicit New bind-live Succeeds)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fi20-async-bind-live-revoke-"));
  const origFetch = globalThis.fetch;
  let blockedNetwork = 0;
  globalThis.fetch = async () => {
    blockedNetwork += 1;
    throw new Error("OFFLINE_TEST_GUARD: unexpected external fetch blocked");
  };

  try {
    const baseMs = Date.parse("2026-11-21T10:00:00+08:00");
    const newApp = (name) =>
      createCampusCloudApp({
        requireAdminAccess: false,
        redisEnabled: false,
        storeOptions: {
          snapshotPath: path.join(tmpDir, `${name}.json`),
          requireDurableSnapshot: true
        }
      });

    async function setupBoundFixture(name, studentNo = "2026990101", secret = "mock_review_secret") {
      const app = newApp(name);
      const user = app.store.findOrCreateCloudUser({
        issuer: "https://offline.invalid",
        subject: `offline_${name}`,
        displayName: "Offline review fixture"
      });
      const s = app.identity.issueDeviceSession(user, "Offline", null, 1, baseMs);
      const headers = { authorization: `Bearer ${s.access_token}` };
      const req = (method, url, body, delta = 0, customHeaders = headers) =>
        app.inject({ method, url, headers: customHeaders, body, nowMs: baseMs + delta });
      const c = await req("POST", "/api/v1/me/consents", { school_id: "haut" });
      assert.equal(c.status, 201);
      const b = await req("POST", "/api/v1/school-bindings", {
        school_id: "haut",
        student_no: studentNo,
        consent_id: c.body.data.id
      });
      assert.equal(b.status, 201);
      const r = await req("POST", `/api/v1/school-bindings/${b.body.data.id}/complete`, {
        credential_kind: "DELEGATED_SESSION_BUNDLE",
        consent_id: c.body.data.id,
        delegated_secret: secret
      });
      assert.equal(r.status, 200);
      return { app, user, s, headers, req, bindingId: b.body.data.id, consentId: c.body.data.id };
    }

    // 20a: DELETE /me/consents/{id} while same-student bind-live is awaiting authenticateHautSession
    {
      const { app, user, req, bindingId, consentId } = await setupBoundFixture("consent-withdraw-race");
      let enterAuth;
      let finishAuth;
      const started = new Promise((r) => {
        enterAuth = r;
      });
      const held = new Promise((r) => {
        finishAuth = r;
      });
      app.schoolProvider.authenticateHautSession = async () => {
        enterAuth();
        await held;
        return {
          rawToken: "offline_fake_token_012345678901234567890123456",
          userInfo: { userNo: "2026990101" }
        };
      };

      const pendingBind = req("POST", "/api/v1/school-bindings/bind-live", {
        school_id: "haut",
        student_no: "2026990101",
        raw_token: "fake_offline_input"
      });
      await started;

      const withdrawRes = await req("DELETE", `/api/v1/me/consents/${consentId}`, null, 100);
      assert.equal(withdrawRes.status, 200);
      assert.equal(
        app.store.recordsForUser("schoolBindings", user.id).filter((b) => !b.revoked_at).length,
        0
      );
      assert.equal(
        app.store.recordsForUser("consents", user.id).filter((c) => !c.withdrawn_at).length,
        0
      );
      assert.equal(user.auth_version, 2);

      finishAuth();
      const staleBindRes = await pendingBind;
      assert.equal(
        staleBindRes.status,
        403,
        "Stale bind-live started before consent withdrawal must be rejected and never return 201"
      );
      assert.equal(staleBindRes.body.error.code, "CONSENT_WITHDRAWN");
      assert.equal(
        app.store.recordsForUser("schoolBindings", user.id).filter((b) => !b.revoked_at).length,
        0,
        "Revoked binding must not be resurrected by stale bind-live"
      );
      assert.equal(
        app.store.recordsForUser("consents", user.id).filter((c) => !c.withdrawn_at).length,
        0,
        "Withdrawn consent must not be resurrected by stale bind-live"
      );
      assert.equal(Boolean(app.store.schoolBindings.get(bindingId).revoked_at), true);
      const unrevokedCreds = Array.from(app.store.encryptedCredentials.values()).filter(
        (cred) => !cred.revoked_at
      );
      assert.equal(unrevokedCreds.length, 0, "No unrevoked credentials may exist after consent withdrawal");

      // 20e: Explicit NEW bind-live initiated AFTER consent withdrawal completes MUST succeed cleanly
      app.schoolProvider.authenticateHautSession = async () => ({
        rawToken: "offline_fresh_post_revoke_token_012345678901234",
        userInfo: { userNo: "2026990101", userName: "PostRevokeUser" }
      });
      const explicitNewBind = await req(
        "POST",
        "/api/v1/school-bindings/bind-live",
        {
          school_id: "haut",
          student_no: "2026990101",
          raw_token: "fresh_post_revoke_input"
        },
        500
      );
      assert.equal(explicitNewBind.status, 201, "Explicit new bind-live after revocation must succeed");
      assert.equal(
        app.store.recordsForUser("schoolBindings", user.id).filter((b) => !b.revoked_at).length,
        1
      );
      assert.equal(
        app.store.recordsForUser("consents", user.id).filter((c) => !c.withdrawn_at).length,
        1
      );
    }

    // 20b: DELETE /school-bindings/{id} while bind-live is awaiting authenticateHautSession
    {
      const { app, user, req } = await setupBoundFixture("binding-revoke-race");
      let enterAuth;
      let finishAuth;
      const started = new Promise((r) => {
        enterAuth = r;
      });
      const held = new Promise((r) => {
        finishAuth = r;
      });
      app.schoolProvider.authenticateHautSession = async () => {
        enterAuth();
        await held;
        return {
          rawToken: "offline_fake_token_binding_revoke_01234567890123",
          userInfo: { userNo: "2026990101" }
        };
      };

      const pendingBind = req("POST", "/api/v1/school-bindings/bind-live", {
        school_id: "haut",
        student_no: "2026990101",
        raw_token: "fake_offline_input_2"
      });
      await started;

      const activeBind = app.store.recordsForUser("schoolBindings", user.id).find((b) => !b.revoked_at);
      const revokeBindRes = await req("DELETE", `/api/v1/school-bindings/${activeBind.id}`, null, 100);
      assert.equal(revokeBindRes.status, 200);
      assert.equal(
        app.store.recordsForUser("schoolBindings", user.id).filter((b) => !b.revoked_at).length,
        0
      );

      finishAuth();
      const staleBindRes = await pendingBind;
      assert.equal(staleBindRes.status, 403, "Stale bind-live must be rejected when binding was revoked in flight");
      assert.equal(staleBindRes.body.error.code, "CONSENT_WITHDRAWN");
      assert.equal(
        app.store.recordsForUser("schoolBindings", user.id).filter((b) => !b.revoked_at).length,
        0
      );
    }

    // 20c: Concurrent bind-live ordering (Order 1: newer rebind B finishes before older A; Order 2: older B1 resolves before newer B2)
    {
      const { app, user, req } = await setupBoundFixture("concurrent-rebind-race", "2026990101");
      let enterOldA;
      let finishOldA;
      const startedOldA = new Promise((r) => {
        enterOldA = r;
      });
      const heldOldA = new Promise((r) => {
        finishOldA = r;
      });

      app.schoolProvider.authenticateHautSession = async (input) => {
        if (input.raw_token === "slow_old_A") {
          enterOldA();
          await heldOldA;
          return {
            rawToken: "tok_resolved_slow_old_A_01234567890123456789",
            userInfo: { userNo: "2026990101" }
          };
        }
        return {
          rawToken: "tok_resolved_fast_new_B_01234567890123456789",
          userInfo: { userNo: "2026990202" }
        };
      };

      const pendingOldA = req(
        "POST",
        "/api/v1/school-bindings/bind-live",
        { school_id: "haut", student_no: "2026990101", raw_token: "slow_old_A" },
        10
      );
      await startedOldA;

      const fastNewB = await req(
        "POST",
        "/api/v1/school-bindings/bind-live",
        { school_id: "haut", student_no: "2026990202", raw_token: "fast_new_B" },
        50
      );
      assert.equal(fastNewB.status, 201);
      assert.equal(fastNewB.body.data.student_no, "2026990202");

      finishOldA();
      const staleOldARes = await pendingOldA;
      assert.ok(
        staleOldARes.status === 409 || staleOldARes.status === 403,
        `Expected stale bind-live A to be rejected with 409/403 after newer rebind B, got ${staleOldARes.status}`
      );
      const activeBindingsAfterOrder1 = app.store
        .recordsForUser("schoolBindings", user.id)
        .filter((b) => !b.revoked_at);
      assert.equal(activeBindingsAfterOrder1.length, 1);
      assert.equal(activeBindingsAfterOrder1[0].student_no, "2026990202");

      // Order 2: Older B1 starts at t=100, newer B2 starts at t=110 while B1 is still in flight; B1 resolves first, then B2 resolves second
      let enterB1;
      let finishB1;
      let enterB2;
      let finishB2;
      const startedB1 = new Promise((r) => {
        enterB1 = r;
      });
      const heldB1 = new Promise((r) => {
        finishB1 = r;
      });
      const startedB2 = new Promise((r) => {
        enterB2 = r;
      });
      const heldB2 = new Promise((r) => {
        finishB2 = r;
      });

      app.schoolProvider.authenticateHautSession = async (input) => {
        if (input.raw_token === "older_B1") {
          enterB1();
          await heldB1;
          return {
            rawToken: "tok_older_B1_session_0123456789012345678901",
            userInfo: { userNo: "2026990202" }
          };
        }
        enterB2();
        await heldB2;
        return {
          rawToken: "tok_newer_B2_session_0123456789012345678902",
          userInfo: { userNo: "2026990202" }
        };
      };

      const pendingB1 = req(
        "POST",
        "/api/v1/school-bindings/bind-live",
        { school_id: "haut", student_no: "2026990202", raw_token: "older_B1" },
        100
      );
      await startedB1;

      const pendingB2 = req(
        "POST",
        "/api/v1/school-bindings/bind-live",
        { school_id: "haut", student_no: "2026990202", raw_token: "newer_B2" },
        110
      );
      await startedB2;

      // Resolve older B1 FIRST -> must be rejected because newer B2 was already initiated!
      finishB1();
      const resB1 = await pendingB1;
      assert.equal(resB1.status, 409, "Superseded older concurrent bind-live B1 must be rejected with 409");

      // Resolve newer B2 SECOND -> must succeed!
      finishB2();
      const resB2 = await pendingB2;
      assert.equal(resB2.status, 201, "Latest concurrent bind-live B2 must succeed");
    }

    // 20d: Session logout while bind-live is awaiting authenticateHautSession
    {
      const { app, user, req } = await setupBoundFixture("logout-during-bind-race");
      let enterAuth;
      let finishAuth;
      const started = new Promise((r) => {
        enterAuth = r;
      });
      const held = new Promise((r) => {
        finishAuth = r;
      });
      app.schoolProvider.authenticateHautSession = async () => {
        enterAuth();
        await held;
        return {
          rawToken: "offline_fake_token_logout_01234567890123456789",
          userInfo: { userNo: "2026990101" }
        };
      };

      const pendingBind = req("POST", "/api/v1/school-bindings/bind-live", {
        school_id: "haut",
        student_no: "2026990101",
        raw_token: "logout_race_input"
      });
      await started;

      const logoutRes = await req("POST", "/api/v1/auth/logout", {}, 100);
      assert.equal(logoutRes.status, 200);

      finishAuth();
      const staleBindRes = await pendingBind;
      assert.equal(staleBindRes.status, 401, "bind-live whose session logged out during auth must be rejected with 401");
      assert.equal(staleBindRes.body.error.code, "CLOUD_AUTH_REQUIRED");
      assert.ok(user);
    }

    assert.equal(blockedNetwork, 0);
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Fault Injection 21 (Cloud P1-2 — Async Revocation Inside cancel-seat Provider Across Initial Auth, 401 Re-login, and Signoff Fallback Blocks Subsequent Writes, Preserves Zero-Write vs Post-Dispatch State, and Blocks Stale Credential Refresh Ciphertext)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fi21-async-cancel-revoke-"));
  const origFetch = globalThis.fetch;
  let blockedNetwork = 0;
  globalThis.fetch = async () => {
    blockedNetwork += 1;
    throw new Error("OFFLINE_TEST_GUARD: unexpected external fetch blocked");
  };

  try {
    const baseMs = Date.parse("2026-11-21T12:00:00+08:00");
    const newApp = (name) =>
      createCampusCloudApp({
        requireAdminAccess: false,
        redisEnabled: false,
        storeOptions: {
          snapshotPath: path.join(tmpDir, `${name}.json`),
          requireDurableSnapshot: true
        }
      });

    async function setupCancelFixture(name, secret) {
      const app = newApp(name);
      const user = app.store.findOrCreateCloudUser({
        issuer: "https://offline.invalid",
        subject: `offline_${name}`,
        displayName: "Offline cancel review fixture"
      });
      const s = app.identity.issueDeviceSession(user, "Offline", null, 1, baseMs);
      const headers = { authorization: `Bearer ${s.access_token}` };
      const req = (method, url, body, delta = 0) =>
        app.inject({ method, url, headers, body, nowMs: baseMs + delta });
      const c = await req("POST", "/api/v1/me/consents", { school_id: "haut" });
      assert.equal(c.status, 201);
      const b = await req("POST", "/api/v1/school-bindings", {
        school_id: "haut",
        student_no: "2026990101",
        consent_id: c.body.data.id
      });
      assert.equal(b.status, 201);
      const r = await req("POST", `/api/v1/school-bindings/${b.body.data.id}/complete`, {
        credential_kind: "DELEGATED_SESSION_BUNDLE",
        consent_id: c.body.data.id,
        delegated_secret: secret
      });
      assert.equal(r.status, 200);
      const bindingId = b.body.data.id;
      const consentId = c.body.data.id;
      const binding = app.store.schoolBindings.get(bindingId);
      const plan = {
        id: "offline-plan",
        cloud_user_id: user.id,
        school_binding_id: bindingId,
        school_id: "haut",
        consent_id: consentId,
        student_no: binding.student_no,
        auth_version: 1,
        enabled: true,
        user_intent_state: "ACTIVE",
        remaining_days: 1
      };
      const job = {
        id: "offline-job",
        plan_id: plan.id,
        cloud_user_id: user.id,
        school_binding_id: bindingId,
        school_id: "haut",
        consent_id: consentId,
        student_no: binding.student_no,
        auth_version: 1,
        state: "CONFIRMED",
        state_version: 1,
        user_intent_state: "ACTIVE",
        external_execution_state: "SCHOOL_CONFIRMED",
        school_cancellation_state: "NOT_REQUESTED",
        external_booking_id: "offline-exact-123"
      };
      app.store.reservationPlans.set(plan.id, plan);
      app.store.indexUserScoped("reservationPlans", plan.id, user.id);
      app.store.reservationJobs.set(job.id, job);
      app.store.indexUserScoped("reservationJobs", job.id, user.id);
      app.store.schoolReservations.set(job.id, {
        id: "offline-res",
        job_id: job.id,
        external_booking_id: "offline-exact-123",
        official_status: "CONFIRMED",
        confirmed_official_status: "CONFIRMED",
        evidence_sha256: "offline_evidence"
      });
      return { app, user, req, bindingId, consentId, binding, plan, job };
    }

    // Timeline ①: initial-auth (no raw_token, binding revoked while authenticateHautSession is in flight BEFORE 1st write)
    // -> 0 external writes, zero-write revocation preserves MANUAL_ACTION_REQUIRED / DELEGATION_STOPPED_SCHOOL_CONFIRMED
    {
      const secret = JSON.stringify({
        student_no: "2026990101",
        raw_token: "",
        password: "offline_fake_password"
      });
      const { app, req, bindingId, binding, job } = await setupCancelFixture("cancel-initial-auth", secret);
      let revoked = false;
      const calls = [];
      app.schoolProvider.authenticateHautSession = async () => {
        if (!revoked) {
          const r = await req("DELETE", `/api/v1/school-bindings/${bindingId}`, null, 1);
          assert.equal(r.status, 200);
          revoked = true;
        }
        return {
          rawToken: "offline_new_token_012345678901234567890123456",
          userInfo: { userNo: binding.student_no }
        };
      };
      app.schoolProvider.wslibGetJson = async (url) => {
        if (url.includes("/cancel?") || url.includes("/signoff?")) {
          calls.push({ path: url.split("?")[0], afterRevocation: revoked });
          return { code: 200 };
        }
        return { code: 200, rows: [], total: 0 };
      };
      app.schoolProvider.fetchActiveBookings = async () => [];

      const result = await req("POST", `/api/v1/reservation-jobs/${job.id}/cancel-seat`, {}, 2);
      assert.equal(result.status, 200);
      assert.equal(
        calls.length,
        0,
        "Timeline ①: zero external cancel/signoff writes may be dispatched when binding was revoked during initial authenticateHautSession"
      );
      assert.equal(job.user_intent_state, "REVOKED");
      assert.equal(job.external_execution_state, "SCHOOL_CONFIRMED");
      assert.equal(
        job.school_cancellation_state,
        "MANUAL_ACTION_REQUIRED",
        "Zero-write revocation must be MANUAL_ACTION_REQUIRED (not SCHOOL_CANCELLED and not CANCEL_RESULT_UNKNOWN)"
      );
      assert.equal(job.state, "DELEGATION_STOPPED_SCHOOL_CONFIRMED");
      assert.equal(result.body.data.live_cancel.cancelled, false);
      const sr = app.store.schoolReservations.get(job.id);
      assert.equal(sr.external_booking_id, "offline-exact-123");
      assert.equal(sr.confirmed_official_status, "CONFIRMED");
    }

    // Timeline ②: reauth-after-401 (1st /seatbook/user/cancel returns 401, binding revoked during re-login authenticateHautSession)
    // -> 1st write was dispatched before revocation, 2nd retry write & signoff fallback MUST be blocked -> CANCEL_RESULT_UNKNOWN
    {
      const secret = JSON.stringify({
        student_no: "2026990101",
        raw_token: "offline_fake_token_012345678901234567890123456",
        password: "offline_fake_password"
      });
      const { app, req, bindingId, binding, job } = await setupCancelFixture("cancel-reauth-after-401", secret);
      let revoked = false;
      const calls = [];
      app.schoolProvider.authenticateHautSession = async () => {
        if (!revoked) {
          const r = await req("DELETE", `/api/v1/school-bindings/${bindingId}`, null, 1);
          assert.equal(r.status, 200);
          revoked = true;
        }
        return {
          rawToken: "offline_new_token_012345678901234567890123456",
          userInfo: { userNo: binding.student_no }
        };
      };
      app.schoolProvider.wslibGetJson = async (url) => {
        if (url.includes("/cancel?") || url.includes("/signoff?")) {
          calls.push({ path: url.split("?")[0], afterRevocation: revoked });
          if (calls.length === 1) return { code: 401 };
          return { code: 200 };
        }
        return { code: 200, rows: [], total: 0 };
      };
      app.schoolProvider.fetchActiveBookings = async () => [];

      const result = await req("POST", `/api/v1/reservation-jobs/${job.id}/cancel-seat`, {}, 2);
      assert.equal(result.status, 200);
      assert.equal(
        calls.filter((c) => c.afterRevocation).length,
        0,
        "Timeline ②: no retry cancel or fallback signoff write may be dispatched after revocation during 401 re-login"
      );
      assert.equal(calls.length, 1, "Only the pre-revocation 1st cancel attempt was dispatched");
      assert.equal(job.user_intent_state, "REVOKED");
      assert.equal(job.external_execution_state, "SCHOOL_CONFIRMED");
      assert.equal(
        job.school_cancellation_state,
        "CANCEL_RESULT_UNKNOWN",
        "Post-dispatch revocation must record CANCEL_RESULT_UNKNOWN (never SCHOOL_CANCELLED or zero-write MANUAL_ACTION_REQUIRED)"
      );
      assert.equal(job.state, "CANCEL_RESULT_UNKNOWN");
      assert.equal(result.body.data.live_cancel.cancelled, false);
      const sr = app.store.schoolReservations.get(job.id);
      assert.equal(sr.official_status, "CANCEL_RESULT_UNKNOWN");
      assert.equal(sr.confirmed_official_status, "CONFIRMED");
      assert.equal(sr.confirmed_booking_evidence.external_booking_id, "offline-exact-123");
    }

    // Timeline ③: fallback-after-error (1st /seatbook/user/cancel throws after revocation -> /seatbook/user/signoff fallback MUST be blocked)
    {
      const secret = JSON.stringify({
        student_no: "2026990101",
        raw_token: "offline_fake_token_012345678901234567890123456",
        password: "offline_fake_password"
      });
      const { app, req, consentId, binding, job } = await setupCancelFixture("cancel-fallback-after-error", secret);
      let revoked = false;
      const calls = [];
      app.schoolProvider.authenticateHautSession = async () => ({
        rawToken: "offline_new_token_012345678901234567890123456",
        userInfo: { userNo: binding.student_no }
      });
      app.schoolProvider.wslibGetJson = async (url) => {
        if (url.includes("/cancel?") || url.includes("/signoff?")) {
          calls.push({ path: url.split("?")[0], afterRevocation: revoked });
          if (calls.length === 1) {
            const r = await req("DELETE", `/api/v1/me/consents/${consentId}`, null, 1);
            assert.equal(r.status, 200);
            revoked = true;
            throw new Error("offline response lost");
          }
          return { code: 200 };
        }
        return { code: 200, rows: [], total: 0 };
      };
      app.schoolProvider.fetchActiveBookings = async () => [];

      const result = await req("POST", `/api/v1/reservation-jobs/${job.id}/cancel-seat`, {}, 2);
      assert.equal(result.status, 200);
      assert.equal(
        calls.filter((c) => c.afterRevocation).length,
        0,
        "Timeline ③: fallback /seatbook/user/signoff must be blocked when consent/binding was revoked during 1st cancel write"
      );
      assert.equal(calls.length, 1);
      assert.equal(job.user_intent_state, "REVOKED");
      assert.equal(job.school_cancellation_state, "CANCEL_RESULT_UNKNOWN");
      assert.equal(job.state, "CANCEL_RESULT_UNKNOWN");
      assert.equal(result.body.data.live_cancel.cancelled, false);
      const sr = app.store.schoolReservations.get(job.id);
      assert.equal(sr.confirmed_booking_evidence.external_booking_id, "offline-exact-123");
    }

    // Timeline ④: Async credential refresh (_updateBindingCredentialTokens in createPlanAndJob background prewarm & PRECHECK)
    // finishing AFTER binding revocation must NEVER write unrevoked ciphertext to encryptedCredentials or overwrite revoked binding
    {
      const secret = JSON.stringify({
        student_no: "2026990101",
        raw_token: "offline_fake_token_012345678901234567890123456",
        password: "offline_fake_password"
      });
      const { app, req, bindingId, consentId, binding } = await setupCancelFixture(
        "async-cred-refresh-revoke",
        secret
      );
      let enterPrewarm;
      let finishPrewarm;
      const prewarmStarted = new Promise((r) => {
        enterPrewarm = r;
      });
      const prewarmHeld = new Promise((r) => {
        finishPrewarm = r;
      });
      app.schoolProvider.prewarmJobTargetSeats = async () => {
        enterPrewarm();
        await prewarmHeld;
        return {
          auth: {
            rawToken: "refreshed_after_revocation_token_012345678901234",
            userInfo: { userNo: "2026990101" }
          },
          prewarmed: { region_id: 7, candidate_seats: [] }
        };
      };

      const createPlanRes = await req(
        "POST",
        "/api/v1/reservation-plans",
        {
          school_binding_id: bindingId,
          consent_id: consentId,
          target_local_date: "2026-11-22",
          target_local_time: "07:00:00",
          slot_window: "08:00-22:00",
          area_name: "五层东区",
          candidate_seats: ["01桌 A座"]
        },
        10
      );
      assert.equal(createPlanRes.status, 201);
      await prewarmStarted;

      const revokeRes = await req("DELETE", `/api/v1/school-bindings/${bindingId}`, null, 20);
      assert.equal(revokeRes.status, 200);
      assert.ok(binding.revoked_at);

      finishPrewarm();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Also test direct _updateBindingCredentialTokens call on revoked binding
      app.reservationEngine._updateBindingCredentialTokens(
        binding,
        {
          rawToken: "direct_refresh_after_revocation_token_0123456789",
          userInfo: { userNo: "2026990101" }
        },
        secret,
        baseMs + 50
      );

      const unrevokedForBinding = Array.from(app.store.encryptedCredentials.values()).filter(
        (c) => c.binding_id === bindingId && !c.revoked_at
      );
      assert.equal(
        unrevokedForBinding.length,
        0,
        "Revoked binding must never receive a new unrevoked encryptedCredentials entry from late async refresh"
      );
    }

    assert.equal(blockedNetwork, 0);
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
