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
