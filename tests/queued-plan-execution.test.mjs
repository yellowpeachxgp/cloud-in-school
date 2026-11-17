import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCampusCloudApp } from '../apps/api/src/app.mjs';
import { HautLibraryProvider } from '../packages/school-spi/src/index.mjs';
import { DeterministicMockSchoolBackend } from '../apps/mock-school/src/main.mjs';
import { scanDueScheduleEvents } from '../apps/scheduler/src/main.mjs';

const scenarioNames = { CONFIRM: '确认成功', TIMEOUT_AMBIGUOUS: '超时后权威回查', LIVE_ADAPTER: '实际学校接口适配层', LIVE_EXPIRED_AT_FIRE: '执行瞬间登录失效', LIVE_COLD_EXPIRED_DURING_QUERY: '未能预热且查询中登录失效' };

for (const mode of ['CONFIRM', 'TIMEOUT_AMBIGUOUS', 'LIVE_ADAPTER', 'LIVE_EXPIRED_AT_FIRE', 'LIVE_COLD_EXPIRED_DURING_QUERY']) {
  test(`隔离演练已提交参数：过期 Cookie 自动密码续期、重启、准点扫描：${scenarioNames[mode]}`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queued-plan-'));
    const snapshotPath = path.join(dir, 'state.json');
    const fire = Date.parse('2026-11-18T07:00:00+08:00');
    let clock = Date.parse('2026-11-17T13:35:00+08:00');
    t.mock.method(Date, 'now', () => clock);
    const backend = new DeterministicMockSchoolBackend(); backend.setMode(mode);
    let submissions = 0, passwordLogins = 0;
    const createSchoolBooking = backend.handleCreateReservation.bind(backend);
    backend.handleCreateReservation = async args => {
      assert.ok(clock >= fire, '不得提前向假学校提交');
      assert.equal(args.plan.area_name, '四层西书库北区');
      assert.deepEqual(args.plan.candidate_seats, ['03桌 A座', '04桌 A座', '05桌 A座']);
      submissions++; return createSchoolBooking(args);
    };
    const provider = new HautLibraryProvider(mode.startsWith('LIVE_') ? { allowSandboxFallback: false } : { mockBackend: backend });
    let liveBooking = null;
    let coldQueryExpired = false;
    const info = { userNo: '2026998888', userName: '隔离学生' };
    // 仅替换学校外部 I/O。执行真实 authenticateHautSession 的 JWT、Cookie、密码三级恢复逻辑。
    if (!mode.startsWith('LIVE_')) provider.validateWslibTokenOnline = async token => token === `fresh-test-token-${passwordLogins}` &&
      (clock < fire - 5 * 60_000 || passwordLogins >= 2) ? info : null;
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
      const parsed = new URL(url);
      if (mode.startsWith('LIVE_') && parsed.hostname === 'wslib.haut.edu.cn') {
        const json = value => Response.json(value);
        if (mode === 'LIVE_EXPIRED_AT_FIRE' && clock >= fire && passwordLogins < 3) return json({ code: 401, msg: '假学校登录已过期' });
        if (parsed.pathname.endsWith('/h5user/my/userinfo')) {
          const valid = options.headers?.Authorization === `Bearer fresh-test-token-${passwordLogins}` &&
            (clock < fire - 5 * 60_000 || passwordLogins >= 2);
          return json(valid ? { code: 200, data: info } : { code: 401 });
        }
        if (parsed.pathname.endsWith('/getDefaultTime')) return json({ code: 200, startDate: '2026-11-18', endDate: '2026-11-18', startTime: '07:30', endTime: '22:00' });
        if (parsed.pathname.endsWith('/layout/building')) return json({ code: 200, builderInfo: [{ id: 1, buildingName: '隔离图书馆' }] });
        if (parsed.pathname.endsWith('/layout/region') && mode === 'LIVE_COLD_EXPIRED_DURING_QUERY') {
          if (clock < fire) return json({ code: 500, msg: '尚未开放' });
          if (!coldQueryExpired) { coldQueryExpired = true; return json({ code: 401, msg: '登录态已过期' }); }
        }
        if (parsed.pathname.endsWith('/layout/region')) return json({ code: 200, regionList: clock < fire - 5 * 60_000 ? [] : [{ id: 13, regionName: '四层西书库北区', openDate: '07:30', closeDate: '22:00' }] });
        if (parsed.pathname.endsWith('/layout/query')) return json({ code: 200, layout: { regionName: '四层西书库北区' }, seatList: ['03桌 A座','04桌 A座','05桌 A座'].map((name,n) => ({ id:100+n, seatName:`四层西书库北区 ${name}`, seatStatus:2 })) });
        if (parsed.pathname.endsWith('/crrentbooking')) return json({ code: 200, data: liveBooking });
        if (parsed.pathname.endsWith('/mybookingInProgress')) return json({ code: 200, rows: liveBooking ? [liveBooking] : [], total: liveBooking ? 1 : 0 });
        if (parsed.pathname.endsWith('/addbooking')) {
          assert.ok(clock >= fire, '真实适配器也不得提前派发');
          assert.equal(parsed.searchParams.get('seatid'), '100');
          assert.equal(parsed.searchParams.get('starttime'), '2026-11-18 07:30:00');
          assert.equal(parsed.searchParams.get('endtime'), '2026-11-18 22:00:00');
          submissions++;
          liveBooking = { id: 'isolated-booking-001', seatId: 100, seatName: '四层西书库北区 03桌 A座', regionName: '四层西书库北区', buildingLayerRegionId: 13, startDate: '2026-11-18 07:30:00', endDate: '2026-11-18 22:00:00', bookingStatus: 1 };
          return json({ code: 200, bookingid: liveBooking.id });
        }
        throw new Error('未配置的假学校请求');
      }
      assert.equal(parsed.hostname, 'mapp.haut.edu.cn', '测试不得发出真实网络请求');
      if (options.method === 'POST') {
        assert.equal(new URLSearchParams(options.body).get('username'), info.userNo);
        passwordLogins++;
        return new Response(null, { status: 302, headers: { location: `https://wslib.haut.edu.cn/?token=fresh-test-token-${passwordLogins}` } });
      }
      return new Response('<form id="fm1"><input name="lt" value="fake-lt"><input name="execution" value="fake-execution"></form>');
    });
    if (!mode.startsWith('LIVE_')) provider.fetchLiveStudyRegions = async () => ({ regions: clock < fire - 5 * 60_000 ? [] : [
      { id: 13, region_name: '四层西书库北区', layer_name: '四层', open_time: '07:30', close_time: '22:00' }
    ] });
    if (!mode.startsWith('LIVE_')) provider.fetchLiveRegionSeats = async () => ({ seats: ['03桌 A座', '04桌 A座', '05桌 A座'].map((name, n) => ({ id: 100 + n, short_name: name, seat_name: `四层西书库北区 ${name}` })) });
    const apps = [];
    const start = () => {
      const app = createCampusCloudApp({ requireAdminAccess: false, schoolProvider: provider,
        financeBridgeOptions: { realDebitsEnabled: false, allowSandboxFallback: true },
        storeOptions: { snapshotPath, requireDurableSnapshot: true } });
      apps.push(app); return app;
    };
    t.after(() => { for (const app of apps) clearTimeout(app.store._snapshotFlushTimer); fs.rmSync(dir, { recursive: true, force: true }); });
    let app = start();
    const user = app.store.findOrCreateCloudUser({ issuer: 'https://test.invalid', subject: 'test_queued_user' });
    app.financeBridge.setSandboxBalance(user.id, 50000);
    if (mode.startsWith('LIVE_')) app.store.schoolIntegrations.set('haut', { school_id:'haut', enabled:true, kill_switch:false, authorization_evidence_ref:'isolated-test-evidence', approver_primary_ref:'fake-owner', approver_secondary_ref:'fake-reviewer' });
    const session = app.identity.issueDeviceSession(user, '隔离 Android', null, 1, clock, 'MOBILE_APP');
    const headers = { authorization: `Bearer ${session.access_token}`, 'idempotency-key': `isolated-${mode}` };
    const request = (method, url, body) => app.inject({ method, url, body, headers, nowMs: clock });
    const consent = (await request('POST', '/api/v1/me/consents', { school_id: 'haut' })).body.data.id;
    const binding = (await request('POST', '/api/v1/school-bindings', { school_id: 'haut', student_no: info.userNo, consent_id: consent })).body.data.id;
    await request('POST', `/api/v1/school-bindings/${binding}/complete`, { consent_id: consent,
      delegated_secret: JSON.stringify({ student_no: info.userNo, password: '仅隔离测试', raw_token: 'expired-test-jwt', cas_tgc: 'expired-test-cookie' }) });
    const payload = { school_binding_id: binding, consent_id: consent, target_local_date: '2026-11-18', target_local_time: '07:00:00',
      area_code: '四层西书库北区', area_name: '四层西书库北区', candidate_seats: ['03桌 A座', '04桌 A座', '05桌 A座'],
      preferred_area_ids: ['四层西书库北区'], preferred_seat_ids: ['03桌 A座', '04桌 A座', '05桌 A座'],
      slot_window: '07:30-22:00', repeat_days: 1, expected_price_micropeach: 10000 };
    const created = await request('POST', '/api/v1/reservation-plans', payload);
    assert.equal(created.status, 201);
    assert.equal((await request('POST', '/api/v1/reservation-plans', payload)).status, 200);
    assert.equal(app.store.reservationPlans.size, 1);
    // 创建后的异步只读预热先完成，再推进模拟时钟到次日。
    await new Promise(resolve => setImmediate(resolve));
    const jobId = created.body.data.job_id;
    clock = fire - 30 * 60_000 - 1;
    assert.deepEqual(await scanDueScheduleEvents(app, clock), []);
    clock++;
    await scanDueScheduleEvents(app, clock);
    assert.equal(app.store.reservationJobs.get(jobId).state, 'PRECHECK_OK');
    assert.equal(passwordLogins, mode === 'LIVE_COLD_EXPIRED_DURING_QUERY' ? 2 : 1); assert.equal(submissions, 0);
    app.store.flushSnapshotStrictSync(); clearTimeout(app.store._snapshotFlushTimer);
    app = start(); app.financeBridge.setSandboxBalance(user.id, 50000);
    clock = fire - 5 * 60_000;
    await scanDueScheduleEvents(app, clock);
    const job = app.store.reservationJobs.get(jobId);
    assert.equal(job.state, 'FINAL_CHECK_OK');
    assert.equal(passwordLogins, mode === 'LIVE_COLD_EXPIRED_DURING_QUERY' ? 3 : 2);
    if (mode === 'LIVE_COLD_EXPIRED_DURING_QUERY') assert.equal(job.prewarmed_targets, null);
    else {
      assert.equal(job.prewarmed_targets.target_local_date, '2026-11-18');
      assert.deepEqual(job.prewarmed_targets.candidate_seats.map(s => s.short_name), payload.candidate_seats);
    }
    clock = fire - 1;
    assert.deepEqual(await scanDueScheduleEvents(app, clock), []); assert.equal(submissions, 0);
    clock = fire;
    await scanDueScheduleEvents(app, clock);
    assert.equal(submissions, 1);
    if (mode === 'TIMEOUT_AMBIGUOUS') {
      assert.equal(job.state, 'RESULT_UNKNOWN'); assert.equal(app.store.financeOperations.size, 0);
      clock += 15001; await scanDueScheduleEvents(app, clock);
    }
    assert.equal(job.state, 'CONFIRMED');
    if (mode === 'LIVE_EXPIRED_AT_FIRE') assert.equal(passwordLogins, 3);
    assert.equal(app.store.reservationOrders.size, 1);
    assert.equal([...app.store.reservationOrders.values()][0].payment_state, 'PAID');
    clock += 250; await scanDueScheduleEvents(app, clock);
    assert.equal(submissions, 1); assert.equal(app.store.financeOperations.size, 1);
    app.store.flushSnapshotStrictSync(); clearTimeout(app.store._snapshotFlushTimer);
    app = start(); await scanDueScheduleEvents(app, clock);
    assert.equal(submissions, 1); assert.equal(app.store.reservationJobs.get(jobId).state, 'CONFIRMED');
  });
}
