import test from "node:test";
import assert from "node:assert/strict";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { DeterministicMockSchoolBackend } from "../apps/mock-school/src/main.mjs";

function setupBoundUser(app, nowMs) {
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: `sub_${Math.random().toString(36).slice(2, 9)}`,
    displayName: "Student A"
  });
  const session = app.identity.issueDeviceSession(user, "Android Device", null, 1, nowMs);
  const authHeaders = { authorization: `Bearer ${session.access_token}` };
  return { user, session, authHeaders };
}

test("Triple-Schedule (ADR-005): Arbitrary user-selected Target T (07:00, 08:45, 12:10, 20:59) & T-30m / T-5m / T execution", async () => {
  const mockSchool = new DeterministicMockSchoolBackend();
  const app = createCampusCloudApp({
    requireAdminAccess: false,
    schoolProviderOptions: { mockBackend: mockSchool }
  });

  // Base clock: 2026-11-03 05:30:00+08:00
  const baseNowMs = Date.parse("2026-11-03T05:30:00+08:00");
  const targetTimes = ["07:00:00", "08:45:00", "12:10:00", "20:59:00"];

  for (let i = 0; i < targetTimes.length; i++) {
    const targetTime = targetTimes[i];
    const targetDate = `2026-11-0${3 + i}`;
    const { user, authHeaders } = setupBoundUser(app, baseNowMs);

    const bindRes = await app.inject({
      method: "POST",
      url: "/api/v1/school-bindings",
      headers: authHeaders,
      body: { school_id: "haut", student_no: `2023010${i}` },
      nowMs: baseNowMs
    });
    const bindingId = bindRes.body.data.id;

    await app.inject({
      method: "POST",
      url: `/api/v1/school-bindings/${bindingId}/complete`,
      headers: authHeaders,
      body: { delegated_secret: `cookie_session_${i}` },
      nowMs: baseNowMs
    });

    const consentRes = await app.inject({
      method: "POST",
      url: "/api/v1/me/consents",
      headers: authHeaders,
      body: { school_id: "haut" },
      nowMs: baseNowMs
    });
    const consentId = consentRes.body.data.id;

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/reservation-plans",
      headers: { ...authHeaders, "idempotency-key": `idem_${targetDate}_${targetTime}` },
      body: {
        school_binding_id: bindingId,
        consent_id: consentId,
        target_local_date: targetDate,
        target_local_time: targetTime,
        preferred_seat_ids: [`N4-0${i + 1}`]
      },
      nowMs: baseNowMs
    });
    assert.equal(createRes.status, 201);
    const data = createRes.body.data;

    const expectedTargetMs = Date.parse(`${targetDate}T${targetTime}+08:00`);
    assert.equal(Date.parse(data.target_at), expectedTargetMs);
    assert.equal(Date.parse(data.precheck_at), expectedTargetMs - 30 * 60 * 1000, "Precheck must be T-30m");
    assert.equal(Date.parse(data.final_check_at), expectedTargetMs - 5 * 60 * 1000, "FinalCheck must be T-5m");

    // 1. Run PRECHECK at T-30m
    const preRes = await app.reservationEngine.runScheduleEvent(
      data.job_id,
      "PRECHECK",
      expectedTargetMs - 30 * 60 * 1000
    );
    assert.equal(preRes.job.state, "PRECHECK_OK");

    // 2. Run FINAL_CHECK at T-5m
    const finalRes = await app.reservationEngine.runScheduleEvent(
      data.job_id,
      "FINAL_CHECK",
      expectedTargetMs - 5 * 60 * 1000
    );
    assert.equal(finalRes.job.state, "FINAL_CHECK_OK");

    // 3. Attempting FIRE before T must be rejected (06:59:59 or T-1s)
    await assert.rejects(async () => {
      await app.reservationEngine.runScheduleEvent(data.job_id, "FIRE", expectedTargetMs - 1000);
    });

    // 4. Execute FIRE at T + 726ms (realistic timer tick jitter) -> CONFIRMED + Order PAID
    const fireRes = await app.reservationEngine.runScheduleEvent(
      data.job_id,
      "FIRE",
      expectedTargetMs + 726
    );
    assert.equal(fireRes.job.state, "CONFIRMED");
    assert.ok(fireRes.schoolReservation.evidence_sha256);
    assert.equal(fireRes.order.payment_state, "PAID");
  }
});

test("Triple-Schedule: Rejects out-of-window target T (e.g. 06:59:59 or 21:30:00) and supports late-creation catch-up", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-03T08:40:00+08:00");
  const { authHeaders } = setupBoundUser(app, nowMs);

  const bindRes = await app.inject({
    method: "POST",
    url: "/api/v1/school-bindings",
    headers: authHeaders,
    body: { school_id: "haut", student_no: "20239999" },
    nowMs
  });
  const bindingId = bindRes.body.data.id;
  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${bindingId}/complete`,
    headers: authHeaders,
    body: { delegated_secret: "secret_bundle" },
    nowMs
  });
  const consentRes = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: authHeaders,
    body: { school_id: "haut" },
    nowMs
  });
  const consentId = consentRes.body.data.id;

  // Out of window before 07:00
  const preOpenRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: authHeaders,
    body: {
      school_binding_id: bindingId,
      consent_id: consentId,
      target_local_date: "2026-11-04",
      target_local_time: "06:59:59"
    },
    nowMs
  });
  assert.equal(preOpenRes.status, 422);
  assert.equal(preOpenRes.body.code, "BOOKING_WINDOW_CLOSED");

  // Late creation at 08:40 for T = 09:00 (20m before T -> between T-30m and T-5m)
  const lateRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: authHeaders,
    body: {
      school_binding_id: bindingId,
      consent_id: consentId,
      target_local_date: "2026-11-03",
      target_local_time: "09:00:00"
    },
    nowMs
  });
  assert.equal(lateRes.status, 201);
  assert.equal(lateRes.body.data.status, "PRECHECK_OK");
});

test("Triple-Schedule: Ambiguous timeout enters RESULT_UNKNOWN and resolves via readback without blind retry or premature debit", async () => {
  const mockSchool = new DeterministicMockSchoolBackend();
  mockSchool.setMode("TIMEOUT_AMBIGUOUS");
  const app = createCampusCloudApp({
    requireAdminAccess: false,
    schoolProviderOptions: { mockBackend: mockSchool }
  });

  const nowMs = Date.parse("2026-11-03T06:00:00+08:00");
  const { user, authHeaders } = setupBoundUser(app, nowMs);

  const bindRes = await app.inject({
    method: "POST",
    url: "/api/v1/school-bindings",
    headers: authHeaders,
    body: { school_id: "haut", student_no: "20238888" },
    nowMs
  });
  const bindingId = bindRes.body.data.id;
  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${bindingId}/complete`,
    headers: authHeaders,
    body: { delegated_secret: "secret_bundle" },
    nowMs
  });
  const consentRes = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: authHeaders,
    body: { school_id: "haut" },
    nowMs
  });

  const createRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: authHeaders,
    body: {
      school_binding_id: bindingId,
      consent_id: consentRes.body.data.id,
      target_local_date: "2026-11-03",
      target_local_time: "07:00:00"
    },
    nowMs
  });
  const jobId = createRes.body.data.job_id;
  const fireAtMs = Date.parse("2026-11-03T07:00:00+08:00");

  // 1st FIRE: school submission times out ambiguously -> RESULT_UNKNOWN, zero debit
  const firstFire = await app.reservationEngine.runScheduleEvent(jobId, "FIRE", fireAtMs);
  assert.equal(firstFire.job.state, "RESULT_UNKNOWN");
  assert.equal(firstFire.job.attempt_count, 1);
  const walletMid = await app.financeService.getWalletSnapshot(user.id);
  assert.equal(walletMid.micropeach_balance, 50_000, "No debit allowed while RESULT_UNKNOWN");

  // 2nd FIRE call performs read-only authoritative readback (does NOT increment attempt_count or blind-submit!)
  const reconcileRes = await app.reservationEngine.runScheduleEvent(jobId, "FIRE", fireAtMs + 2000);
  assert.equal(reconcileRes.job.state, "CONFIRMED");
  assert.equal(reconcileRes.job.attempt_count, 1, "Readback must not blind-retry submission");
  assert.equal(reconcileRes.order.payment_state, "PAID");
});

test("Triple-Schedule: Multi-day continuous reservation (repeat_days=7) automatically rolls over and arms next day's job after FIRE", async () => {
  const mockSchool = new DeterministicMockSchoolBackend();
  const app = createCampusCloudApp({
    requireAdminAccess: false,
    schoolProviderOptions: { mockBackend: mockSchool }
  });

  const nowMs = Date.parse("2026-11-04T06:00:00+08:00");
  const { authHeaders } = setupBoundUser(app, nowMs);

  const bindRes = await app.inject({
    method: "POST",
    url: "/api/v1/school-bindings",
    headers: authHeaders,
    body: { school_id: "haut", student_no: "20237777" },
    nowMs
  });
  const bindingId = bindRes.body.data.id;
  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${bindingId}/complete`,
    headers: authHeaders,
    body: { delegated_secret: "secret_bundle" },
    nowMs
  });
  const consentRes = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: authHeaders,
    body: { school_id: "haut" },
    nowMs
  });

  const createRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: authHeaders,
    body: {
      school_binding_id: bindingId,
      consent_id: consentRes.body.data.id,
      target_local_date: "2026-11-04",
      target_local_time: "07:00:00",
      repeat_days: 7
    },
    nowMs
  });
  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.data.repeat_days, 7);
  assert.equal(createRes.body.data.remaining_days, 7);
  assert.equal(createRes.body.data.end_local_date, "2026-11-10");

  const day1JobId = createRes.body.data.job_id;
  const day1FireMs = Date.parse("2026-11-04T07:00:00+08:00");
  const fireRes = await app.reservationEngine.runScheduleEvent(day1JobId, "FIRE", day1FireMs + 200);
  assert.equal(fireRes.job.state, "CONFIRMED");
  assert.ok(fireRes.next_job_id, "Must spawn next day's job automatically when remaining_days > 1");
  assert.equal(fireRes.remaining_days, 6);

  const nextJob = app.store.reservationJobs.get(fireRes.next_job_id);
  assert.ok(nextJob);
  assert.equal(nextJob.booking_local_date, "2026-11-05");
  assert.equal(nextJob.repeat_days, 7);
  assert.equal(nextJob.remaining_days, 6);
  assert.equal(nextJob.state, "ARMED");
});

test("Cloud-Native Campus Content: Public /api/v1/campus-content and Admin control plane dynamically publish channels & clubs", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.now();
  const adminUser = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes",
    subject: "856f-cf51-b064-5d84",
    username: "yellowpeach",
    role: "admin"
  });
  const session = app.identity.issueDeviceSession(adminUser, "Admin Console", null, 1, nowMs);
  const adminHeaders = { authorization: `Bearer ${session.access_token}` };

  const pubRes1 = await app.inject({
    method: "GET",
    url: "/api/v1/campus-content?school_id=haut"
  });
  assert.equal(pubRes1.status, 200);
  assert.equal(pubRes1.body.code, "CAMPUS_CONTENT_OK");
  assert.equal(pubRes1.body.data.channels.length, 0);
  assert.equal(pubRes1.body.data.clubs.length, 3);
  assert.ok(pubRes1.body.data.competitions.length >= 14);
  assert.ok(pubRes1.body.data.competitions.every((c) => c.official_website_url.startsWith("https://")));

  const upsertComp = await app.inject({
    method: "POST",
    url: "/api/v1/admin/campus-content/competitions",
    headers: adminHeaders,
    body: {
      school_id: "haut",
      id: "comp_raicom",
      title: "睿抗机器人开发者大赛 (RAICOM)",
      short_title: "睿抗机器人大赛",
      tier_badge: "教育部白名单 A 类赛事",
      category: "ELECTRONICS_ROBO",
      official_website_url: "https://www.raicom.com.cn",
      recommended_major_tracks: ["CS_AI_SOFTWARE", "EE_AUTOMATION_IOT"],
      pinned: true,
      sort_order: 1
    }
  });
  assert.equal(upsertComp.status, 200);

  const upsertCh = await app.inject({
    method: "POST",
    url: "/api/v1/admin/campus-content/channels",
    headers: adminHeaders,
    body: {
      school_id: "haut",
      id: "ch_ai_lab",
      title: "AI 创新实践频道",
      subtitle: "大模型应用 · 开源项目交流",
      tag_label: "科技",
      invite_url: "https://pd.qq.com/s/hautai",
      pinned: true,
      sort_order: 1
    }
  });
  assert.equal(upsertCh.status, 200);

  const pubRes2 = await app.inject({
    method: "GET",
    url: "/api/v1/campus-content?school_id=haut"
  });
  assert.equal(pubRes2.body.data.channels[0].id, "ch_ai_lab");
  assert.equal(pubRes2.body.data.channels[0].pinned, true);
});


test("HautLibraryProvider: Stops immediately on readback failure (never writes cand[1]) and rejects unrelated seat/date bookings", async () => {
  const { HautLibraryProvider } = await import("../packages/school-spi/src/index.mjs");
  const provider = new HautLibraryProvider();
  const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIyMzEwNDAxMDA0MjgifQ.signature_long_enough_for_live_cred_check";
  const binding = {
    id: "bind-live-test-001",
    school_id: "haut",
    status: "DELEGATED_ACTIVE",
    student_no: "231040100428"
  };
  const plan = {
    id: "plan-live-test-001",
    area_name: "四层西书库北区",
    candidate_seats: ["05桌 A座", "06桌 F座", "08桌 A座"],
    preferences_json: {
      preferred_area_ids: ["四层西书库北区"],
      preferred_seat_ids: ["05桌 A座", "06桌 F座", "08桌 A座"],
      allow_alternative_seat: false
    }
  };
  const job = {
    id: "job-live-test-001",
    school_id: "haut",
    booking_local_date: "2026-11-08",
    auth_version: 1,
    generation: 1,
    prewarmed_targets: {
      binding_id: "bind-live-test-001",
      student_no: "231040100428",
      auth_version: 1,
      plan_generation: 1,
      target_local_date: "2026-11-08",
      expires_at: "2026-11-08T09:00:00+08:00",
      region_id: 13,
      region_name: "四层西书库北区",
      start_full: "2026-11-08 07:30:00",
      end_full: "2026-11-08 22:00:00",
      candidate_seats: [
        { id: 618, seat_name: "四层西书库北区 05桌 A座", short_name: "05桌 A座" },
        { id: 659, seat_name: "四层西书库北区 06桌 F座", short_name: "06桌 F座" },
        { id: 621, seat_name: "四层西书库北区 08桌 A座", short_name: "08桌 A座" }
      ]
    }
  };

  // Case 1: addbooking throws or returns 200, and readback fails -> must stop immediately without writing cand[1] (659)
  const addBookingSeatsCalled1 = [];
  provider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/layout/query")) {
      return { code: 200, msg: "成功", seatList: [] };
    }
    if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
      const m = pathAndQuery.match(/seatid=(\d+)/);
      if (m) addBookingSeatsCalled1.push(Number(m[1]));
      throw new Error("Network timeout during addbooking");
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
      throw new Error("Readback network failure");
    }
    throw new Error("Unexpected call: " + pathAndQuery);
  };

  const res1 = await provider.executeMockOrAuthorizedCreate({
    job,
    plan,
    binding,
    schoolIntegration: { enabled: true, kill_switch: false },
    decryptedSecret: JSON.stringify({ raw_token: fakeJwt }),
    nowInstant: new Date("2026-11-08T00:05:00.000Z") // 08:05:00 CST
  });
  assert.equal(res1.outcome, "TIMEOUT_AMBIGUOUS");
  assert.deepEqual(addBookingSeatsCalled1, [618], "Must stop immediately after cand[0] unknown write without touching cand[1]");

  // Case 2: Readback returns an unrelated booking (wrong seat 01桌 B座 seatId=610 or wrong date 2026-11-07)
  const addBookingSeatsCalled2 = [];
  provider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
      const m = pathAndQuery.match(/seatid=(\d+)/);
      if (m) addBookingSeatsCalled2.push(Number(m[1]));
      return { code: 200, bookingid: 9140049, msg: "成功" };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
      return {
        code: 200,
        data: {
          id: 9140049,
          seatId: 610,
          seatName: "四层西书库北区 01桌 B座",
          regionName: "四层西书库北区",
          buildingLayerRegionId: 13,
          startDate: "2026-11-08 07:30:00",
          endDate: "2026-11-08 22:00:00",
          bookingStatus: "1"
        }
      };
    }
    return { code: 200, rows: [] };
  };

  const res2 = await provider.executeMockOrAuthorizedCreate({
    job,
    plan,
    binding,
    schoolIntegration: { enabled: true, kill_switch: false },
    decryptedSecret: JSON.stringify({ raw_token: fakeJwt }),
    nowInstant: new Date("2026-11-08T00:05:00.000Z")
  });
  assert.notEqual(res2.outcome, "SUBMITTED", "Unrelated seat 01桌 B座 must never be accepted as SUBMITTED");
  assert.deepEqual(addBookingSeatsCalled2, [618], "Must not continue writing cand[1] after cand[0] returned 200");

  const verifyWrongSeat = await provider.verifyBookingAuthoritative({
    job,
    plan,
    binding,
    decryptedSecret: JSON.stringify({ raw_token: fakeJwt }),
    rawToken: fakeJwt,
    expectedExternalBookingId: "9140049"
  });
  assert.equal(verifyWrongSeat.verified, false, "verifyBookingAuthoritative must reject wrong seat 01桌 B座");

  // Case 3: Readback returns matching seat (618 05桌 A座), but wrong date (2026-11-07)
  provider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
      return {
        code: 200,
        data: {
          id: 9137299,
          seatId: 618,
          seatName: "四层西书库北区 05桌 A座",
          regionName: "四层西书库北区",
          buildingLayerRegionId: 13,
          startDate: "2026-11-07 07:30:00",
          endDate: "2026-11-07 22:00:00",
          bookingStatus: "1"
        }
      };
    }
    return { code: 200, rows: [] };
  };
  const verifyWrongDate = await provider.verifyBookingAuthoritative({
    job,
    plan,
    binding,
    decryptedSecret: JSON.stringify({ raw_token: fakeJwt }),
    rawToken: fakeJwt,
    expectedExternalBookingId: "9137299"
  });
  assert.equal(verifyWrongDate.verified, false, "verifyBookingAuthoritative must reject wrong date 2026-11-07");
});


test("Security & Verification: Multi-binding student_no isolation, time-slot window check, and missing-region rejection", async () => {
  const { HautLibraryProvider, isBookingMatchingTarget } = await import("../packages/school-spi/src/index.mjs");
  const provider = new HautLibraryProvider();

  // 1. Same date & same seat, but different time slot (14:00-18:00 vs 07:30-22:00) must be rejected
  assert.equal(
    isBookingMatchingTarget(
      {
        bookingId: "9140001",
        seatId: 618,
        seatName: "四层西书库北区 05桌 A座",
        regionName: "四层西书库北区",
        buildingLayerRegionId: 13,
        startDate: "2026-11-08 14:00:00",
        endDate: "2026-11-08 18:00:00"
      },
      {
        targetDates: ["2026-11-08"],
        expectedStartFull: "2026-11-08 07:30:00",
        expectedEndFull: "2026-11-08 22:00:00",
        regionId: 13,
        regionName: "四层西书库北区",
        specificSeat: { id: 618, seat_name: "四层西书库北区 05桌 A座", short_name: "05桌 A座" }
      }
    ),
    false,
    "Same date and seat with different time slot must be rejected"
  );

  // 2. Missing region info on readback with same-named seat must be rejected
  assert.equal(
    isBookingMatchingTarget(
      {
        bookingId: "9140002",
        seatId: null,
        seatName: "05桌 A座",
        regionName: "",
        buildingLayerRegionId: null,
        startDate: "2026-11-08 07:30:00",
        endDate: "2026-11-08 22:00:00"
      },
      {
        targetDates: ["2026-11-08"],
        expectedStartFull: "2026-11-08 07:30:00",
        expectedEndFull: "2026-11-08 22:00:00",
        regionId: 13,
        regionName: "四层西书库北区",
        wantedSeatNames: ["05桌 A座"]
      }
    ),
    false,
    "Missing region info on readback must be rejected"
  );

  // 3. Different region prefix in seatName when regionName is missing must be rejected
  assert.equal(
    isBookingMatchingTarget(
      {
        bookingId: "9140003",
        seatId: null,
        seatName: "三层西书库北区 05桌 A座",
        regionName: "",
        buildingLayerRegionId: null,
        startDate: "2026-11-08 07:30:00",
        endDate: "2026-11-08 22:00:00"
      },
      {
        targetDates: ["2026-11-08"],
        expectedStartFull: "2026-11-08 07:30:00",
        expectedEndFull: "2026-11-08 22:00:00",
        regionId: 13,
        regionName: "四层西书库北区",
        wantedSeatNames: ["05桌 A座"]
      }
    ),
    false,
    "Seat from 3rd floor must never match 4th floor target when regionName is missing"
  );

  // 4. Credential student_no mismatch with binding must fail closed
  assert.throws(
    () =>
      provider.parseCredentialBundle(
        JSON.stringify({ student_no: "231040100999", password: "secret" }),
        { id: "bind-1", student_no: "231040100428" }
      ),
    /student_no mismatch/i
  );
});


test("P2 Regression: Plan slot_window (14:00-18:00) overrides school open hours (07:30-22:00), atomic sync pre-validation, and non-resurrection of revoked binding/consent", async () => {
  const { HautLibraryProvider } = await import("../packages/school-spi/src/index.mjs");
  const { createCampusCloudApp } = await import("../apps/api/src/app.mjs");
  const provider = new HautLibraryProvider();
  const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIyMzEwNDAxMDA0MjgifQ.signature_long_enough_for_live_cred_check";

  // 1. Plan slot_window is 14:00-18:00 while prewarmed_targets has school open hours 07:30-22:00;
  // full-day booking 07:30-22:00 must be rejected by both executeMockOrAuthorizedCreate and verifyBookingAuthoritative!
  const binding = {
    id: "bind-slot-14-18",
    school_id: "haut",
    status: "DELEGATED_ACTIVE",
    student_no: "231040100428"
  };
  const plan1418 = {
    id: "plan-slot-14-18",
    area_name: "四层西书库北区",
    slot_window: "14:00-18:00",
    candidate_seats: ["05桌 A座"],
    preferences_json: {
      preferred_area_ids: ["四层西书库北区"],
      preferred_seat_ids: ["05桌 A座"],
      allow_alternative_seat: false
    }
  };
  const job1418 = {
    id: "job-slot-14-18",
    school_id: "haut",
    booking_local_date: "2026-11-08",
    prewarmed_targets: {
      region_id: 13,
      region_name: "四层西书库北区",
      start_full: "2026-11-08 07:30:00",
      end_full: "2026-11-08 22:00:00",
      candidate_seats: [
        { id: 618, seat_name: "四层西书库北区 05桌 A座", short_name: "05桌 A座" }
      ]
    }
  };

  provider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
      return { code: 200, bookingid: 9140999, msg: "成功" };
    }
    if (pathAndQuery.startsWith("/seatbook/user/my/crrentbooking")) {
      return {
        code: 200,
        data: {
          id: 9140999,
          seatId: 618,
          seatName: "四层西书库北区 05桌 A座",
          regionName: "四层西书库北区",
          buildingLayerRegionId: 13,
          startDate: "2026-11-08 07:30:00",
          endDate: "2026-11-08 22:00:00",
          bookingStatus: "1"
        }
      };
    }
    return { code: 200, rows: [] };
  };

  const execFullDay = await provider.executeMockOrAuthorizedCreate({
    job: job1418,
    plan: plan1418,
    binding,
    schoolIntegration: { enabled: true, kill_switch: false },
    decryptedSecret: JSON.stringify({ raw_token: fakeJwt }),
    nowInstant: new Date("2026-11-08T00:05:00.000Z")
  });
  assert.notEqual(
    execFullDay.outcome,
    "SUBMITTED",
    "Full-day 07:30-22:00 booking must not be accepted when plan.slot_window is 14:00-18:00"
  );

  const verifyFullDay = await provider.verifyBookingAuthoritative({
    job: job1418,
    plan: plan1418,
    binding,
    decryptedSecret: JSON.stringify({ raw_token: fakeJwt }),
    rawToken: fakeJwt,
    expectedExternalBookingId: "9140999"
  });
  assert.equal(
    verifyFullDay.verified,
    false,
    "verifyBookingAuthoritative must reject 07:30-22:00 booking when plan.slot_window is 14:00-18:00"
  );

  // 2. Atomic sync pre-validation & non-resurrection of revoked binding / withdrawn consent
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { authHeaders: userHeaders } = setupBoundUser(app, Date.now());

  // Mismatched student_no in delegated_secret returns 403 AND creates zero bindings!
  const badSync = await app.inject({
    method: "POST",
    url: "/api/v1/sync/snapshot",
    headers: userHeaders,
    body: {
      school_binding_upserts: [
        {
          school_id: "haut",
          student_no: "231040100111",
          delegated_secret: JSON.stringify({ student_no: "231040100999", password: "pwd" })
        }
      ]
    }
  });
  assert.equal(badSync.status, 403);
  const bindingsAfterBadSync = await app.inject({
    method: "GET",
    url: "/api/v1/school-bindings",
    headers: userHeaders
  });
  assert.equal(
    bindingsAfterBadSync.body.data.bindings.length,
    0,
    "Failed 403 sync must not leave behind a newly created active binding"
  );

  // Valid sync creates binding & consent; then revoking binding prevents resurrection by ordinary sync
  const goodSync = await app.inject({
    method: "POST",
    url: "/api/v1/sync/snapshot",
    headers: userHeaders,
    body: {
      school_binding_upserts: [
        {
          school_id: "haut",
          student_no: "231040100111",
          delegated_secret: JSON.stringify({ student_no: "231040100111", password: "pwd" })
        }
      ]
    }
  });
  assert.equal(goodSync.status, 200);
  const createdBindingId = goodSync.body.data.school_bindings[0].id;

  const revokeRes = await app.inject({
    method: "DELETE",
    url: `/api/v1/school-bindings/${createdBindingId}`,
    headers: userHeaders
  });
  assert.equal(revokeRes.status, 200);

  // Subsequent ordinary sync must NOT resurrect the revoked binding or create a new active binding for 231040100111
  const resyncAfterRevoke = await app.inject({
    method: "POST",
    url: "/api/v1/sync/snapshot",
    headers: userHeaders,
    body: {
      school_binding_upserts: [
        {
          school_id: "haut",
          student_no: "231040100111",
          delegated_secret: JSON.stringify({ student_no: "231040100111", password: "pwd2" })
        }
      ]
    }
  });
  assert.equal(resyncAfterRevoke.status, 200);
  const activeBindingsAfterResync = resyncAfterRevoke.body.data.school_bindings.filter(
    (b) => b.status === "DELEGATED_ACTIVE" && !b.revoked_at
  );
  assert.equal(
    activeBindingsAfterResync.length,
    0,
    "Ordinary snapshot sync must never resurrect a revoked school binding"
  );

  // 3. Stale pre-revocation snapshot must be REJECTED (409 CONFLICT) after reauthorization,
  // whereas a current-generation snapshot (with matching binding_id & consent_id) succeeds!
  const activeConsentId =
    goodSync.body.data.consents?.find((c) => !c.withdrawn_at)?.id ||
    Array.from(app.store.consents.values()).find((c) => !c.withdrawn_at)?.id;
  if (activeConsentId) {
    const withdrawRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/me/consents/${activeConsentId}`,
      headers: userHeaders
    });
    assert.equal(withdrawRes.status, 200);
  }

  // Ordinary sync while withdrawn must still be ignored
  const syncWhileWithdrawn = await app.inject({
    method: "POST",
    url: "/api/v1/sync/snapshot",
    headers: userHeaders,
    body: {
      school_binding_upserts: [
        {
          school_id: "haut",
          student_no: "231040100111",
          delegated_secret: JSON.stringify({ student_no: "231040100111", password: "pwd3" })
        }
      ]
    }
  });
  assert.equal(
    syncWhileWithdrawn.body.data.school_bindings.filter((b) => b.status === "DELEGATED_ACTIVE" && !b.revoked_at).length,
    0,
    "Ordinary sync while consent is withdrawn must not resurrect binding"
  );

  // Now user explicitly grants new consent AND reauthorizes binding (new generation!)
  const newConsentRes = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: userHeaders,
    body: { school_id: "haut" }
  });
  assert.equal(newConsentRes.status, 201);
  const newConsentId = newConsentRes.body.data.id;

  const reauthRes = await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${createdBindingId}/reauthorize`,
    headers: userHeaders,
    body: {
      consent_id: newConsentId,
      delegated_secret: JSON.stringify({ student_no: "231040100111", password: "pwd_reauth" })
    }
  });
  assert.equal(reauthRes.status, 200);

  const futureDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);

  // Replay of a STALE pre-revocation snapshot (unversioned or referencing old consentId) MUST be rejected with 409 CONFLICT
  // and must NOT overwrite pwd_reauth or create a reservation job!
  const staleSnapshotReplay = await app.inject({
    method: "POST",
    url: "/api/v1/sync/snapshot",
    headers: userHeaders,
    body: {
      school_binding_upserts: [
        {
          school_id: "haut",
          student_no: "231040100111",
          delegated_secret: JSON.stringify({ student_no: "231040100111", password: "pwd_stale_old" })
        }
      ],
      reservation_plan_upserts: [
        {
          target_local_date: futureDate,
          target_local_time: "07:00:00",
          area_name: "四层西书库北区",
          candidate_seats: ["05桌 A座"]
        }
      ]
    }
  });
  assert.equal(staleSnapshotReplay.status, 409, "Stale pre-revocation snapshot must be rejected with 409 CONFLICT");
  const bindAfterStale = app.store.schoolBindings.get(createdBindingId);
  const decAfterStale = app.reservationEngine._decryptBindingCredential(
    { id: "diag-stale", school_id: "haut", school_binding_id: createdBindingId },
    bindAfterStale,
    Date.now()
  );
  assert.ok(decAfterStale.includes("pwd_reauth"), "Stale snapshot must not overwrite reauthorized credential");

  // Current-generation snapshot carrying matching binding_id, consent_id, and auth_version succeeds!
  const syncAfterReconsent = await app.inject({
    method: "POST",
    url: "/api/v1/sync/snapshot",
    headers: userHeaders,
    body: {
      auth_version: reauthRes.body.data.auth_version,
      school_binding_upserts: [
        {
          binding_id: createdBindingId,
          consent_id: newConsentId,
          auth_version: reauthRes.body.data.auth_version,
          school_id: "haut",
          student_no: "231040100111",
          delegated_secret: JSON.stringify({ student_no: "231040100111", password: "pwd_synced_after_reconsent" })
        }
      ],
      reservation_plan_upserts: [
        {
          school_binding_id: createdBindingId,
          consent_id: newConsentId,
          auth_version: reauthRes.body.data.auth_version,
          target_local_date: futureDate,
          target_local_time: "07:00:00",
          area_name: "四层西书库北区",
          candidate_seats: ["05桌 A座"]
        }
      ]
    }
  });
  assert.equal(syncAfterReconsent.status, 200);
  const updatedBindObj = app.store.schoolBindings.get(createdBindingId);
  const decryptedAfterSync = app.reservationEngine._decryptBindingCredential(
    { id: "diag-job", school_id: "haut", school_binding_id: createdBindingId },
    updatedBindObj,
    Date.now()
  );
  assert.ok(
    decryptedAfterSync.includes("pwd_synced_after_reconsent"),
    "Current-generation snapshot sync must update credential"
  );
  assert.equal(
    syncAfterReconsent.body.data.reservation_jobs.length,
    1,
    "Current-generation snapshot sync must create reservation job"
  );

  // 4. Multi-binding cascade revocation: revoking one binding must also cancel plans & jobs of all sibling bindings for the same student_no!
  const sibBindInit = await app.inject({
    method: "POST",
    url: "/api/v1/school-bindings",
    headers: userHeaders,
    body: { school_id: "haut", student_no: "231040100111", consent_id: newConsentId }
  });
  const sibBindId = sibBindInit.body.data.id;
  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${sibBindId}/complete`,
    headers: userHeaders,
    body: {
      consent_id: newConsentId,
      delegated_secret: JSON.stringify({ student_no: "231040100111", password: "pwd_sib" })
    }
  });
  const futureDateSib = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const sibPlanRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: userHeaders,
    body: {
      school_binding_id: sibBindId,
      consent_id: newConsentId,
      target_local_date: futureDateSib,
      target_local_time: "07:00:00",
      area_name: "四层西书库北区",
      candidate_seats: ["08桌 A座"]
    }
  });
  assert.equal(sibPlanRes.status, 201);
  const sibJobId = sibPlanRes.body.data.job_id;
  const sibPlanId = sibPlanRes.body.data.plan_id;

  // Revoke createdBindingId (binding 1); sibling binding 2 plan and job must ALSO be cancelled in the same transaction!
  const revokePrimaryRes = await app.inject({
    method: "DELETE",
    url: `/api/v1/school-bindings/${createdBindingId}`,
    headers: userHeaders
  });
  assert.equal(revokePrimaryRes.status, 200);
  assert.equal(app.store.reservationPlans.get(sibPlanId).enabled, false, "Sibling binding plan must be disabled on revoke");
  assert.equal(app.store.reservationJobs.get(sibJobId).state, "CANCELLED", "Sibling binding job must be cancelled on revoke");
});


test("High-Risk Regression: Same binding_id/consent_id snapshot omitting auth_version is rejected after reauthorize, and queued old-version jobs abort before write", async () => {
  const { createCampusCloudApp } = await import("../apps/api/src/app.mjs");
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { authHeaders: userHeaders } = setupBoundUser(app, Date.now());

  const c1Res = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: userHeaders,
    body: { school_id: "haut" }
  });
  const c1Id = c1Res.body.data.id;

  const b1Init = await app.inject({
    method: "POST",
    url: "/api/v1/school-bindings",
    headers: userHeaders,
    body: { school_id: "haut", student_no: "231040100777", consent_id: c1Id }
  });
  const b1Id = b1Init.body.data.id;

  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${b1Id}/complete`,
    headers: userHeaders,
    body: {
      consent_id: c1Id,
      delegated_secret: JSON.stringify({ student_no: "231040100777", password: "pwd_v1" })
    }
  });

  // Create a queued job under auth_version = 1
  const futureDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: userHeaders,
    body: {
      school_binding_id: b1Id,
      consent_id: c1Id,
      target_local_date: futureDate,
      target_local_time: "07:00:00",
      area_name: "四层西书库北区",
      candidate_seats: ["05桌 A座"]
    }
  });
  assert.equal(planRes.status, 201);
  const queuedJobId = planRes.body.data.job_id;

  // Reauthorize in-place reusing the SAME b1Id and SAME c1Id!
  const reauthRes = await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${b1Id}/reauthorize`,
    headers: userHeaders,
    body: {
      consent_id: c1Id,
      delegated_secret: JSON.stringify({ student_no: "231040100777", password: "pwd_v2_reauthorized" })
    }
  });
  assert.equal(reauthRes.status, 200);
  assert.ok(reauthRes.body.data.auth_version > 1);

  // 1. Old snapshot carrying matching binding_id (b1Id) and consent_id (c1Id) but OMITTING auth_version MUST be rejected!
  const omittedVerSync = await app.inject({
    method: "POST",
    url: "/api/v1/sync/snapshot",
    headers: userHeaders,
    body: {
      school_binding_upserts: [
        {
          binding_id: b1Id,
          consent_id: c1Id,
          school_id: "haut",
          student_no: "231040100777",
          delegated_secret: JSON.stringify({ student_no: "231040100777", password: "pwd_v1_stale" })
        }
      ]
    }
  });
  assert.equal(
    omittedVerSync.status,
    409,
    "Snapshot reusing same binding_id & consent_id after reauthorize but omitting auth_version must be rejected with 409"
  );
  const decAfterOmitted = app.reservationEngine._decryptBindingCredential(
    { id: "diag-omitted", school_id: "haut", school_binding_id: b1Id },
    app.store.schoolBindings.get(b1Id),
    Date.now()
  );
  assert.ok(
    decAfterOmitted.includes("pwd_v2_reauthorized"),
    "Reauthorized credential must not be overwritten by snapshot omitting auth_version"
  );

  // 2. The queued job created under old auth_version = 1 MUST abort immediately at execution without entering write path!
  let writeEntered = false;
  app.schoolProvider.executeMockOrAuthorizedCreate = async () => {
    writeEntered = true;
    throw new Error("Must never enter executeMockOrAuthorizedCreate for stale-auth job");
  };
  const fireMs = Date.parse(`${futureDate}T07:00:05+08:00`);
  const execOldJob = await app.reservationEngine.runScheduleEvent(queuedJobId, "FIRE", fireMs);
  assert.equal(writeEntered, false, "Queued job from old auth_version must never enter write path");
  assert.equal(execOldJob.job.state, "CANCELLED", "Queued job from old auth_version must be cancelled");
  assert.equal(execOldJob.event.status, "ABORTED_REVOKED", "Schedule event must be ABORTED_REVOKED");
});


test("P1 Race Regression: Concurrent revocation during in-flight query blocks addbooking write and preserves CANCELLED state (never overwritten with RESULT_UNKNOWN)", async () => {
  const { createCampusCloudApp } = await import("../apps/api/src/app.mjs");
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { authHeaders: userHeaders } = setupBoundUser(app, Date.now());
  const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIyMzEwNDAxMDA4ODgifQ.signature_long_enough_for_live_cred_check";

  const cRes = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: userHeaders,
    body: { school_id: "haut" }
  });
  const consentId = cRes.body.data.id;

  const bInit = await app.inject({
    method: "POST",
    url: "/api/v1/school-bindings",
    headers: userHeaders,
    body: { school_id: "haut", student_no: "231040100888", consent_id: consentId }
  });
  const bindId = bInit.body.data.id;

  await app.inject({
    method: "POST",
    url: `/api/v1/school-bindings/${bindId}/complete`,
    headers: userHeaders,
    body: {
      consent_id: consentId,
      delegated_secret: JSON.stringify({ student_no: "231040100888", raw_token: fakeJwt })
    }
  });

  const targetDate = "2026-11-10";
  const planRes = await app.inject({
    method: "POST",
    url: "/api/v1/reservation-plans",
    headers: userHeaders,
    body: {
      school_binding_id: bindId,
      consent_id: consentId,
      target_local_date: targetDate,
      target_local_time: "07:00:00",
      area_name: "四层西书库北区",
      candidate_seats: ["05桌 A座"]
    }
  });
  assert.equal(planRes.status, 201);
  const jobId = planRes.body.data.job_id;
  const job = app.store.reservationJobs.get(jobId);
  job.prewarmed_targets = {
    binding_id: bindId,
    student_no: "231040100888",
    auth_version: 1,
    plan_generation: 1,
    target_local_date: targetDate,
    expires_at: "2026-11-10T09:00:00+08:00",
    region_id: 13,
    region_name: "四层西书库北区",
    start_full: "2026-11-10 07:30:00",
    end_full: "2026-11-10 22:00:00",
    candidate_seats: [
      { id: 618, seat_name: "四层西书库北区 05桌 A座", short_name: "05桌 A座" }
    ]
  };

  let addbookingCalled = 0;
  app.schoolProvider.wslibGetJson = async (pathAndQuery) => {
    if (pathAndQuery.startsWith("/seatbook/layout/query")) {
      // Simulate user revoking authorization while the read-only gate query is in flight!
      await app.inject({
        method: "DELETE",
        url: `/api/v1/me/consents/${consentId}`,
        headers: userHeaders
      });
      return { code: 200, msg: "成功", seatList: [] };
    }
    if (pathAndQuery.startsWith("/seatbook/user/addbooking")) {
      addbookingCalled += 1;
      return { code: 200, bookingid: 9999999, msg: "成功" };
    }
    return { code: 200, rows: [] };
  };

  const fireMs = Date.parse("2026-11-10T07:00:01+08:00");
  const fireRes = await app.reservationEngine.runScheduleEvent(jobId, "FIRE", fireMs);
  assert.equal(addbookingCalled, 0, "Concurrent revocation during query must block addbooking write");
  assert.equal(fireRes.job.state, "CANCELLED", "Cancelled job state must never be overwritten with RESULT_UNKNOWN");
  assert.equal(fireRes.event.status, "ABORTED_REVOKED", "Event status must be ABORTED_REVOKED");
});
