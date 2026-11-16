import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCampusCloudApp } from '../apps/api/src/app.mjs';
import { DeterministicMockSchoolBackend } from '../apps/mock-school/src/main.mjs';

test('前一天创建计划并重启，目标日未开放的预热失败不取消，到点无需手机确认自动执行原日期和原价格', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'future-plan-'));
  const apps = [];
  t.after(() => {
    for (const app of apps) clearTimeout(app.store._snapshotFlushTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const school = new DeterministicMockSchoolBackend();
  const prewarmDates = [];
  let creates = 0;
  const create = school.handleCreateReservation.bind(school);
  school.handleCreateReservation = async args => {
    creates++;
    assert.equal(args.job.booking_local_date, '2026-11-26');
    assert.deepEqual(args.plan.candidate_seats, ['01', '02']);
    assert.equal(args.plan.area_name, '指定自习室');
    return create(args);
  };
  const openApp = () => {
    const app = createCampusCloudApp({ requireAdminAccess: false,
      storeOptions: { snapshotPath: path.join(dir, 'state.json'), requireDurableSnapshot: true },
      schoolProviderOptions: { mockBackend: school },
      financeBridgeOptions: { realDebitsEnabled: false, allowSandboxFallback: true } });
    app.schoolProvider.prewarmJobTargetSeats = async ({ job }) => {
      prewarmDates.push(job.booking_local_date);
      throw new Error('目标日期查询尚未开放');
    };
    apps.push(app);
    return app;
  };
  const nowMs = Date.parse('2026-11-25T22:00:00+08:00');
  let app = openApp();
  const user = app.store.findOrCreateCloudUser({ issuer: 'https://test.invalid', subject: 'future-test', displayName: '隔离测试' });
  app.financeBridge.setSandboxBalance(user.id, 100_000);
  const session = app.identity.issueDeviceSession(user, '隔离设备', null, 1, nowMs);
  const headers = { authorization: `Bearer ${session.access_token}` };
  const consent = await app.inject({ method: 'POST', url: '/api/v1/me/consents', headers, body: { school_id: 'haut' }, nowMs });
  const consentId = consent.body.data.id;
  const bind = await app.inject({ method: 'POST', url: '/api/v1/school-bindings', headers,
    body: { school_id: 'haut', student_no: '20990001', consent_id: consentId }, nowMs });
  const bindingId = bind.body.data.id;
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/school-bindings/${bindingId}/complete`, headers,
    body: { consent_id: consentId, delegated_secret: JSON.stringify({ student_no: '20990001', raw_token: 'isolated-future-session-token-00000000' }) }, nowMs })).status, 200);
  const response = await app.inject({ method: 'POST', url: '/api/v1/reservation-plans',
    headers: { ...headers, 'idempotency-key': 'future-plan-original-key' }, nowMs,
    body: { school_binding_id: bindingId, consent_id: consentId, target_local_date: '2026-11-26', target_local_time: '07:00:00',
      area_name: '指定自习室', preferred_area_ids: ['指定自习室'], candidate_seats: ['01', '02'], preferred_seat_ids: ['01', '02'],
      expected_price_micropeach: 10000 } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creates, 0);
  app.store.flushSnapshotStrictSync();
  clearTimeout(app.store._snapshotFlushTimer);
  app = openApp();
  app.financeBridge.setSandboxBalance(user.id, 100_000);
  const jobId = response.body.data.job_id;
  const fireMs = Date.parse('2026-11-26T07:00:00+08:00');
  // 模拟用户关掉页面后的服务端定时入口，不调用 execute-now 或其他客户端接口。
  assert.equal((await app.reservationEngine.runScheduleEvent(jobId, 'PRECHECK', fireMs - 1800000)).job.state, 'PRECHECK_OK');
  assert.equal((await app.reservationEngine.runScheduleEvent(jobId, 'FINAL_CHECK', fireMs - 300000)).job.state, 'FINAL_CHECK_OK');
  assert.equal(creates, 0);
  assert.ok(prewarmDates.length >= 3);
  assert.ok(prewarmDates.every(date => date === '2026-11-26'));
  app.store.pricingMicropeach = 20000;
  const fired = await app.reservationEngine.runScheduleEvent(jobId, 'FIRE', fireMs + 500);
  assert.equal(fired.job.state, 'CONFIRMED');
  assert.equal(fired.order.payment_state, 'PAID');
  assert.equal(fired.order.price_micropeach, 10000);
  assert.equal(creates, 1);
  await app.reservationEngine.runScheduleEvent(jobId, 'FIRE', fireMs + 1000);
  assert.equal(creates, 1);
});
