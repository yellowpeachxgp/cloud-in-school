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
    prewarmed_targets: {
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
