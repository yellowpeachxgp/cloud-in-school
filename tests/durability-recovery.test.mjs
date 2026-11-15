import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCampusCloudApp } from '../apps/api/src/app.mjs';

const nowMs = Date.parse('2026-11-15T10:00:00+08:00');
async function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durability-'));
  const snapshotPath = path.join(dir, 'state.json');
  const app = createCampusCloudApp({ requireAdminAccess: false, storeOptions: { snapshotPath, requireDurableSnapshot: true, ...options } });
  t.after(() => { clearTimeout(app.store._snapshotFlushTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  const user = app.store.findOrCreateCloudUser({ issuer: 'https://test.invalid', subject: 'test_durable', displayName: '测试学生' });
  const session = app.identity.issueDeviceSession(user, '测试设备', null, 1, nowMs);
  const headers = { authorization: `Bearer ${session.access_token}` };
  const request = (method, url, body, key) => app.inject({ method, url, body, headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) }, nowMs });
  const consent = (await request('POST', '/api/v1/me/consents', { school_id: 'haut' })).body.data.id;
  const binding = (await request('POST', '/api/v1/school-bindings', { school_id: 'haut', student_no: '2026999999' })).body.data.id;
  await request('POST', `/api/v1/school-bindings/${binding}/complete`, { consent_id: consent, delegated_secret: 'test-secret' });
  app.store.flushSnapshotStrictSync();
  const body = { school_binding_id: binding, consent_id: consent, target_local_date: '2026-11-16', target_local_time: '07:00:00' };
  return { app, snapshotPath, headers, body, request };
}

test('目录同步持续失败时，同键重试不能把内存回执当作耐久成功', async t => {
  const { app, request, body } = await setup(t);
  app.store._persistFaultInject = 'dir_fsync';
  const first = await request('POST', '/api/v1/reservation-plans', body, 'unknown');
  assert.equal(first.body.code, 'STORAGE_COMMIT_UNKNOWN');
  for (const key of ['unknown', 'another']) {
    const res = await request('POST', '/api/v1/reservation-plans', body, key);
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'STORAGE_COMMIT_UNKNOWN');
  }
  assert.equal(app.store.reservationPlans.size, 1);
  app.store._persistFaultInject = null;
  const recovered = await request('POST', '/api/v1/reservation-plans', body, 'unknown');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.data.plan_id, [...app.store.reservationPlans.keys()][0]);
  assert.equal((await request('POST', '/api/v1/reservation-plans', { ...body, target_local_time: '08:00:00' }, 'unknown')).status, 409);
});

test('恢复时核验完整快照内容，等长篡改也不能返回确定成功', async t => {
  const { app, request, body, snapshotPath } = await setup(t);
  app.store._persistFaultInject = 'dir_fsync';
  await request('POST', '/api/v1/reservation-plans', body, 'corrupt');
  fs.writeFileSync(snapshotPath, fs.readFileSync(snapshotPath, 'utf8').replace('07:00:00', '08:00:00'));
  app.store._persistFaultInject = null;
  const res = await request('POST', '/api/v1/reservation-plans', body, 'corrupt');
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'STORAGE_COMMIT_UNKNOWN');
});

test('报价、消费回执和旧计划替换在重启后保持同一提交结果', async t => {
  const { app, request, body, snapshotPath, headers } = await setup(t);
  const old = await request('POST', '/api/v1/reservation-plans', body, 'old');
  const quote = (await request('GET', '/api/v1/reservation-quote')).body.data;
  app.store._persistFaultInject = 'dir_fsync';
  const replacement = { ...body, quote_id: quote.quote_id, replace_existing: true };
  assert.equal((await request('POST', '/api/v1/reservation-plans', replacement, 'replace')).status, 503);
  clearTimeout(app.store._snapshotFlushTimer); app.store.storageCommitUnknown = true;
  const restarted = createCampusCloudApp({ requireAdminAccess: false, storeOptions: { snapshotPath, requireDurableSnapshot: true } });
  t.after(() => clearTimeout(restarted.store._snapshotFlushTimer));
  const retry = await restarted.inject({ method: 'POST', url: '/api/v1/reservation-plans', headers: { ...headers, 'idempotency-key': 'replace' }, body: replacement, nowMs });
  assert.equal(retry.status, 200);
  assert.equal(restarted.store.reservationPlans.size, 2);
  assert.equal(restarted.store.reservationPlans.get(old.body.data.plan_id).enabled, false);
  assert.equal(restarted.store.priceQuotes.has(quote.quote_id), false);
  assert.equal(restarted.store.idempotencyRecords.size, 2);
});

import { SnapshotFs } from './helpers/snapshot-fs.mjs';
import { fork } from 'node:child_process';
import { once } from 'node:events';

for (const stage of ['tmp_open', 'tmp_write', 'tmp_fsync', 'intent_write', 'intent_fsync', 'intent_dir_fsync', 'rename']) {
  test(`发布前故障 ${stage} 恢复旧计划与原报价`, async t => {
    const { app, body, request } = await setup(t);
    const old = await request('POST', '/api/v1/reservation-plans', body, 'old');
    const quote = (await request('GET', '/api/v1/reservation-quote')).body.data;
    app.store._persistFaultInject = stage;
    const result = await request('POST', '/api/v1/reservation-plans', { ...body, quote_id: quote.quote_id, replace_existing: true }, 'new');
    assert.equal(result.body.code, 'STORAGE_PERSISTENCE_FAILED');
    assert.equal(app.store.reservationPlans.size, 1);
    assert.equal(app.store.reservationPlans.get(old.body.data.plan_id).enabled, true);
    assert.equal(app.store.priceQuotes.has(quote.quote_id), true);
    assert.equal(app.store.idempotencyRecords.size, 1);
  });
}

test('假文件系统：rename 可见但目录未耐久，重启恢复旧快照后同键仅创建一次', async t => {
  const io = new SnapshotFs();
  const { app, body, request, snapshotPath, headers } = await setup(t, { snapshotFs: io });
  const old = await request('POST', '/api/v1/reservation-plans', body, 'old');
  app.store._persistFaultInject = 'dir_fsync';
  const replacement = { ...body, replace_existing: true };
  assert.equal((await request('POST', '/api/v1/reservation-plans', replacement, 'new')).status, 503);
  io.crash();
  clearTimeout(app.store._snapshotFlushTimer); app.store.storageCommitUnknown = true;
  const restarted = createCampusCloudApp({ requireAdminAccess: false, storeOptions: { snapshotPath, snapshotFs: io, requireDurableSnapshot: true } });
  t.after(() => clearTimeout(restarted.store._snapshotFlushTimer));
  assert.equal(restarted.store.reservationPlans.get(old.body.data.plan_id).enabled, true);
  const input = { method: 'POST', url: '/api/v1/reservation-plans', body: replacement, headers: { ...headers, 'idempotency-key': 'new' }, nowMs };
  assert.equal((await restarted.inject(input)).status, 201);
  assert.equal((await restarted.inject(input)).status, 200);
  assert.equal(restarted.store.reservationPlans.size, 2);
});

test('假文件系统：持久候选快照核验失败时启动拒绝，恢复同步后只重放原回执', async t => {
  const io = new SnapshotFs();
  const { app, body, request, snapshotPath, headers } = await setup(t, { snapshotFs: io });
  app.store._persistFaultInject = 'verify_content';
  const first = await request('POST', '/api/v1/reservation-plans', body, 'candidate');
  assert.equal(first.status, 503);
  io.crash(); clearTimeout(app.store._snapshotFlushTimer); app.store.storageCommitUnknown = true;
  io.failDirectorySync = true;
  assert.throws(() => createCampusCloudApp({ requireAdminAccess: false, storeOptions: { snapshotPath, snapshotFs: io, requireDurableSnapshot: true } }), { code: 'STORAGE_COMMIT_UNKNOWN' });
  io.failDirectorySync = false;
  const restarted = createCampusCloudApp({ requireAdminAccess: false, storeOptions: { snapshotPath, snapshotFs: io, requireDurableSnapshot: true } });
  t.after(() => clearTimeout(restarted.store._snapshotFlushTimer));
  const result = await restarted.inject({ method: 'POST', url: '/api/v1/reservation-plans', body, headers: { ...headers, 'idempotency-key': 'candidate' }, nowMs });
  assert.equal(result.status, 200);
  assert.equal(restarted.store.reservationPlans.size, 1);
});

test('不同键并发请求在未知提交屏障前串行判定，后台和停止入口同样被隔离', async t => {
  const { app, body, request } = await setup(t);
  app.store._persistFaultInject = 'dir_fsync';
  const results = await Promise.all(['a', 'b', 'c'].map(key => request('POST', '/api/v1/reservation-plans', body, key)));
  assert.ok(results.every(res => res.status === 503));
  assert.equal(app.store.reservationPlans.size, 1);
  assert.equal((await request('DELETE', `/api/v1/reservation-plans/${[...app.store.reservationPlans.keys()][0]}`)).status, 503);
  await assert.rejects(app.financeService.retryPendingDebits(nowMs), { code: 'STORAGE_COMMIT_UNKNOWN' });
  await assert.rejects(app.reservationEngine.runScheduleEvent([...app.store.reservationJobs.keys()][0], 'FIRE', nowMs), { code: 'STORAGE_COMMIT_UNKNOWN' });
  app.store._persistFaultInject = null;
});

for (const stage of ['tmp_open', 'tmp_fsync', 'intent_fsync', 'intent_dir_fsync', 'rename', 'post_rename', 'dir_fsync', 'verify_content', 'intent_clear', 'intent_clear_fsync']) {
  test(`临时真实文件系统进程崩溃与重启：${stage}`, { timeout: 20_000 }, async t => {
    const { app, body, request, snapshotPath, headers } = await setup(t);
    const old = await request('POST', '/api/v1/reservation-plans', body, 'old');
    app.store.flushSnapshotStrictSync(); clearTimeout(app.store._snapshotFlushTimer); app.store.storageCommitUnknown = true;
    const replacement = { ...body, replace_existing: true };
    const input = { method: 'POST', url: '/api/v1/reservation-plans', body: replacement, headers: { ...headers, 'idempotency-key': 'crash' }, nowMs };
    const inputPath = path.join(path.dirname(snapshotPath), 'request.json');
    fs.writeFileSync(inputPath, JSON.stringify({ snapshotPath, stage, request: input }));
    const child = fork('tests/helpers/crash-create.mjs', [inputPath], { execArgv: [], env: { PATH: process.env.PATH, HOME: path.dirname(snapshotPath) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => child.kill('SIGKILL'));
    let stderr = ''; child.stderr.on('data', b => { stderr += b; });
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, 'SIGKILL', `${stage}: ${code} ${stderr}`);
    assert.equal(fs.readFileSync(`${inputPath}.checkpoint`, "utf8"), stage);
    const restarted = createCampusCloudApp({ requireAdminAccess: false, storeOptions: { snapshotPath, requireDurableSnapshot: true } });
    t.after(() => clearTimeout(restarted.store._snapshotFlushTimer));
    const published = ['post_rename', 'dir_fsync', 'verify_content', 'intent_clear', 'intent_clear_fsync'].includes(stage);
    assert.equal(restarted.store.reservationPlans.get(old.body.data.plan_id).enabled, !published);
    const retry = await restarted.inject(input);
    assert.equal(retry.status, published ? 200 : 201, JSON.stringify(retry.body));
    assert.equal((await restarted.inject(input)).status, 200);
    assert.equal(restarted.store.reservationPlans.size, 2);
    assert.equal(restarted.store.idempotencyRecords.size, 2);
  });
}

test('幂等回执冻结原始结果且兼容旧 hash，回执数量不触发静默丢弃', async t => {
  const { app, body, request } = await setup(t);
  const created = await request('POST', '/api/v1/reservation-plans', body, 'frozen');
  const expected = structuredClone(created.body.data);
  delete expected.pending_sso_sync;
  for (const event of app.store.scheduleEvents.values()) event.status = 'TEST_CHANGED';
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  const retry = await request('POST', '/api/v1/reservation-plans', reordered, 'frozen');
  assert.deepEqual(retry.body.data, expected);
  const key = [...app.store.idempotencyRecords.keys()][0];
  const receipt = app.store.idempotencyRecords.get(key);
  delete receipt.hashVersion;
  receipt.bodyHash = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(body)).digest('hex');
  assert.equal((await request('POST', '/api/v1/reservation-plans', body, 'frozen')).status, 200);
  for (let i = 0; i < 2100; i++) app.store.idempotencyRecords.set(`legacy-${i}`, { data: {}, bodyHash: 'test' });
  app.store.flushSnapshotStrictSync();
  const raw = JSON.parse(fs.readFileSync(app.store.snapshotPath, 'utf8'));
  assert.equal(raw.idempotencyRecords.length, 2101);
});

test('修改预约入口在发布前失败恢复原参数，发布后未知时隔离后续修改', async t => {
  const { app, body, request } = await setup(t);
  const created = await request('POST', '/api/v1/reservation-plans', body, 'patch');
  const plan = app.store.reservationPlans.get(created.body.data.plan_id);
  const original = structuredClone(plan);
  app.store._persistFaultInject = 'tmp_write';
  const failed = await request('PATCH', `/api/v1/reservation-plans/${plan.id}`, { candidate_seats: ['新座位'] });
  assert.equal(failed.status, 503);
  assert.deepEqual(plan, original);
  app.store._persistFaultInject = 'dir_fsync';
  assert.equal((await request('PATCH', `/api/v1/reservation-plans/${plan.id}`, { candidate_seats: ['新座位'] })).body.code, 'STORAGE_COMMIT_UNKNOWN');
  assert.equal((await request('PATCH', `/api/v1/reservation-plans/${plan.id}`, { candidate_seats: ['另一个座位'] })).status, 503);
  assert.deepEqual(plan.candidate_seats, ['新座位']);
  app.store._persistFaultInject = null;
});

test('已签发未消费报价跨重启仍能在同一提交单元内消费', async t => {
  const { app, body, request, snapshotPath, headers } = await setup(t);
  const quote = (await request('GET', '/api/v1/reservation-quote')).body.data;
  clearTimeout(app.store._snapshotFlushTimer); app.store.storageCommitUnknown = true;
  const restarted = createCampusCloudApp({ requireAdminAccess: false, storeOptions: { snapshotPath, requireDurableSnapshot: true } });
  t.after(() => clearTimeout(restarted.store._snapshotFlushTimer));
  assert.equal(restarted.store.priceQuotes.has(quote.quote_id), true);
  const result = await restarted.inject({ method: 'POST', url: '/api/v1/reservation-plans', body: { ...body, quote_id: quote.quote_id }, headers: { ...headers, 'idempotency-key': 'quote-restart' }, nowMs });
  assert.equal(result.status, 201);
  assert.equal(restarted.store.priceQuotes.has(quote.quote_id), false);
  const raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.equal(raw.priceQuotes.length, 0);
  assert.equal(raw.reservationPlans[0][1].accepted_quote_id, quote.quote_id);
  assert.equal(raw.idempotencyRecords.length, 1);
});

import { scanDueScheduleEvents } from '../apps/scheduler/src/main.mjs';
import { ContractError } from '../packages/contracts/src/index.mjs';

test('在途任务遇到存储隔离时不改写任务状态或把待执行事件误标为失败', async t => {
  const { app, body, request } = await setup(t);
  await request('POST', '/api/v1/reservation-plans', body, 'in-flight');
  const job = [...app.store.reservationJobs.values()][0];
  const before = structuredClone(job);
  app.store.storageCommitUnknown = true;
  assert.throws(() => app.reservationEngine.casJobState(job.id, job.state_version, 'FAILED'), { code: 'STORAGE_COMMIT_UNKNOWN' });
  assert.deepEqual(job, before);
  assert.throws(() => app.reservationEngine.rolloverMultiDayPlanIfEligible([...app.store.reservationPlans.values()][0], job, '测试'), { code: 'STORAGE_COMMIT_UNKNOWN' });
  app.store.storageCommitUnknown = false;
  const event = [...app.store.scheduleEvents.values()][0];
  event.due_at = new Date(nowMs - 1).toISOString();
  app.reservationEngine.runScheduleEvent = async () => { app.store.storageCommitUnknown = true; throw new ContractError('STORAGE_COMMIT_UNKNOWN', '测试隔离'); };
  await scanDueScheduleEvents(app, nowMs);
  assert.equal(event.status, 'ARMED');
});
