import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCampusCloudApp } from '../apps/api/src/app.mjs';

const nowMs = Date.parse('2026-11-17T02:00:00Z');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-auth-'));
  const snapshotPath = path.join(dir, 'state.json');
  const options = { requireAdminAccess: false, storeOptions: { snapshotPath, requireDurableSnapshot: true } };
  const app = createCampusCloudApp(options);
  t.after(() => { clearTimeout(app.store._snapshotFlushTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  const user = app.store.findOrCreateCloudUser({ issuer: 'https://test.invalid', subject: 'auth-student', displayName: '隔离会话用户' });
  return { app, user, options, snapshotPath };
}

test('客户端已收到登录成功时，会话已在真实临时快照中且立即重建后可续期', async t => {
  const { app, user, options, snapshotPath } = fixture(t);
  const session = app.identity.issueDeviceSession(user, '隔离 Android', null, 1, nowMs, 'MOBILE_APP');
  assert.equal(fs.existsSync(snapshotPath), true);
  clearTimeout(app.store._snapshotFlushTimer);
  const restarted = createCampusCloudApp(options);
  t.after(() => clearTimeout(restarted.store._snapshotFlushTimer));
  const refreshed = await restarted.inject({ method: 'POST', url: '/api/v1/auth/refresh', body: { refresh_token: session.refresh_token }, nowMs: nowMs + 1 });
  assert.equal(refreshed.status, 200);
});

test('实际刷新入口返回成功后立即重建，轮换后的令牌可用且旧令牌仍不可重放', async t => {
  const { app, user, options } = fixture(t);
  const session = app.identity.issueDeviceSession(user, '隔离 Android', null, 1, nowMs, 'MOBILE_APP');
  app.store.flushSnapshotStrictSync();
  const first = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', body: { refresh_token: session.refresh_token }, nowMs: nowMs + 1 });
  assert.equal(first.status, 200);
  clearTimeout(app.store._snapshotFlushTimer);
  const restarted = createCampusCloudApp(options);
  t.after(() => clearTimeout(restarted.store._snapshotFlushTimer));
  const next = await restarted.inject({ method: 'POST', url: '/api/v1/auth/refresh', body: { refresh_token: first.body.data.refresh_token }, nowMs: nowMs + 2 });
  assert.equal(next.status, 200);
  const replay = await restarted.inject({ method: 'POST', url: '/api/v1/auth/refresh', body: { refresh_token: session.refresh_token }, nowMs: nowMs + 3 });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.code, 'SESSION_REPLAY_DETECTED');
});

test('会话刷新在 rename 前失败时不报告成功且旧令牌仍可安全续期', async t => {
  const { app, user } = fixture(t);
  const session = app.identity.issueDeviceSession(user, '隔离 Android', null, 1, nowMs, 'MOBILE_APP');
  app.store.flushSnapshotStrictSync();
  app.store._persistFaultInject = 'tmp_write';
  const failed = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', body: { refresh_token: session.refresh_token }, nowMs: nowMs + 1 });
  assert.equal(failed.status, 503);
  assert.equal(app.store.deviceSessions.size, 1);
  assert.equal([...app.store.deviceSessions.values()][0].consumed_at, null);
  app.store._persistFaultInject = null;
  const retry = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', body: { refresh_token: session.refresh_token }, nowMs: nowMs + 2 });
  assert.equal(retry.status, 200);
});

test('会话刷新 rename 后同步失败保留未知并阻止后续写入，不伪装为确定成功', async t => {
  const { app, user } = fixture(t);
  const session = app.identity.issueDeviceSession(user, '隔离 Android', null, 1, nowMs, 'MOBILE_APP');
  app.store.flushSnapshotStrictSync();
  app.store._persistFaultInject = 'dir_fsync';
  const failed = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', body: { refresh_token: session.refresh_token }, nowMs: nowMs + 1 });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, 'STORAGE_COMMIT_UNKNOWN');
  assert.equal(app.store.storageCommitUnknown, true);
  const blocked = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', body: { refresh_token: session.refresh_token }, nowMs: nowMs + 2 });
  assert.equal(blocked.status, 503);
  app.store._persistFaultInject = null;
  app.store.recoverDurabilitySync();
  assert.equal(app.store.storageCommitUnknown, false);
});

test('实际退出接口确认后立即重建，旧令牌保持撤销且不改变任何预约计划', async t => {
  const { app, user, options } = fixture(t);
  const session = app.identity.issueDeviceSession(user, '隔离 Android', null, 1, nowMs, 'MOBILE_APP');
  app.store.flushSnapshotStrictSync();
  const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { authorization: `Bearer ${session.access_token}` }, nowMs: nowMs + 1 });
  assert.equal(logout.status, 200);
  clearTimeout(app.store._snapshotFlushTimer);
  const restarted = createCampusCloudApp(options);
  t.after(() => clearTimeout(restarted.store._snapshotFlushTimer));
  const me = await restarted.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${session.access_token}` }, nowMs: nowMs + 2 });
  assert.equal(me.status, 401);
  assert.equal(restarted.store.reservationPlans.size, 0);
});

test('实际 main 收到续期成功后 SIGKILL 并重启，新令牌可继续使用且重放撤销耐久保存', { timeout: 30000 }, async t => {
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const { app, user, snapshotPath } = fixture(t);
  const initial = app.identity.issueDeviceSession(user, '真实子进程测试设备', null, 1, Date.now(), 'MOBILE_APP');
  clearTimeout(app.store._snapshotFlushTimer);
  const children = [];
  t.after(() => { for (const c of children) if (c.exitCode === null) c.kill('SIGKILL'); });
  async function start() {
    const child = fork('apps/api/src/main.mjs', [], {
      execArgv: [],
      env: { PATH: process.env.PATH, HOME: path.dirname(snapshotPath), HOST: '127.0.0.1', PORT: '0', CLOUD_SNAPSHOT_PATH: snapshotPath, CLOUD_REQUIRE_DURABLE_SNAPSHOT: 'true', CLOUD_REQUIRE_ADMIN_ACCESS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    children.push(child);
    let pending = '';
    const base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('隔离 main 启动超时')), 12000);
      child.once('error', reject);
      child.stdout.on('data', bytes => {
        pending += bytes;
        for (const line of pending.split('\n')) {
          try { const item = JSON.parse(line); if (item.status === 'listening') { clearTimeout(timeout); resolve(`http://127.0.0.1:${item.port}`); } } catch { /* 等待完整 JSON 行 */ }
        }
      });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`隔离 main 提前退出：${code}`)); });
    });
    return { child, base };
  }
  async function rotate(base, token) {
    const r = await fetch(`${base}/api/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: token }) });
    return { status: r.status, body: await r.json() };
  }
  async function kill(child) { const done = once(child, 'exit'); child.kill('SIGKILL'); const [, signal] = await done; assert.equal(signal, 'SIGKILL'); }
  let running = await start();
  const first = await rotate(running.base, initial.refresh_token);
  assert.equal(first.status, 200);
  await kill(running.child);
  running = await start();
  const second = await rotate(running.base, first.body.data.refresh_token);
  assert.equal(second.status, 200);
  assert.notEqual(second.body.data.refresh_token, first.body.data.refresh_token);
  const replay = await rotate(running.base, initial.refresh_token);
  assert.equal(replay.body.code, 'SESSION_REPLAY_DETECTED');
  await kill(running.child);
  running = await start();
  const revoked = await rotate(running.base, second.body.data.refresh_token);
  assert.equal(revoked.status, 401);
  await kill(running.child);
});

for (const flow of ['MOBILE_APP', 'WEB_PORTAL']) {
  test(`${flow} 登录票据在确定未提交时可重试，成功后不可重放`, async t => {
    const { computeS256Challenge } = await import('../packages/identity/src/index.mjs');
    const { app } = fixture(t);
    const time = Date.now();
    const verifier = 'isolated-valid-pkce-verifier-that-is-at-least-43-characters';
    const start = flow === 'MOBILE_APP'
      ? app.identity.startMobileTransaction({ installEphemeralId: 'isolated-device', codeChallenge: computeS256Challenge(verifier), codeChallengeMethod: 'S256' }, time)
      : app.identity.startWebTransaction({ flowKind: flow, returnTo: '/reservations' }, time);
    const txn = app.store.authTransactions.get(start.login_txn);
    const callback = await app.identity.handleOidcCallback({ state: txn.serverState, code: 'sub:isolated-ticket-user' }, time + 1);
    app.store.flushSnapshotStrictSync();
    const url = flow === 'MOBILE_APP' ? '/api/v1/auth/mobile/exchange' : '/api/v1/auth/web/exchange';
    const body = flow === 'MOBILE_APP'
      ? { login_txn: txn.loginTxn, app_ticket: callback.appTicket, code_verifier: verifier }
      : { login_txn: txn.loginTxn, web_ticket: callback.appTicket };
    app.store._persistFaultInject = 'tmp_write';
    const failed = await app.inject({ method: 'POST', url, body, nowMs: time + 2 });
    assert.equal(failed.status, 503);
    assert.equal(app.store.authTransactions.get(txn.loginTxn)?.status, 'CALLBACK_VERIFIED');
    assert.equal(app.store.exchangeTickets.get(callback.appTicket)?.consumedAtMs, null);
    assert.equal(app.store._idxTxnByServerState.get(txn.serverState), txn.loginTxn);
    app.store._persistFaultInject = null;
    assert.equal((await app.inject({ method: 'POST', url, body, nowMs: time + 3 })).status, 200);
    assert.equal((await app.inject({ method: 'POST', url, body, nowMs: time + 4 })).status, 401);
  });
}

test('数据删除的最终状态在实际接口确认后持久化，而非仅保存撤销会话', async t => {
  const { app, user, options } = fixture(t);
  const session = app.identity.issueDeviceSession(user, '隔离设备', null, 1, nowMs, 'MOBILE_APP');
  const response = await app.inject({ method: 'POST', url: '/api/v1/me/data-delete', headers: { authorization: `Bearer ${session.access_token}` }, nowMs: nowMs + 1 });
  assert.equal(response.status, 202);
  clearTimeout(app.store._snapshotFlushTimer);
  const restarted = createCampusCloudApp(options);
  t.after(() => clearTimeout(restarted.store._snapshotFlushTimer));
  assert.equal(restarted.store.users.get(user.id).status, 'DELETED');
});

test('网页退出首次保存失败后，重试必须确认撤销落盘才可跳转成功', async t => {
  const { app, user, options } = fixture(t);
  const session = app.identity.issueDeviceSession(user, '隔离网页', null, 1, nowMs, 'WEB_PORTAL');
  const cookie = `dis_web_session=${app.identity.signWebSessionCookie({ cloudUserId: user.id, accessToken: session.access_token, refreshToken: session.refresh_token })}`;
  app.store._persistFaultInject = 'tmp_write';
  const failed = await app.inject({ method: 'GET', url: '/api/v1/auth/web/logout', headers: { cookie }, nowMs: nowMs + 1 });
  assert.equal(failed.status, 503);
  const stillFailed = await app.inject({ method: 'GET', url: '/api/v1/auth/web/logout', headers: { cookie }, nowMs: nowMs + 2 });
  assert.equal(stillFailed.status, 503);
  app.store._persistFaultInject = null;
  const retry = await app.inject({ method: 'GET', url: '/api/v1/auth/web/logout', headers: { cookie }, nowMs: nowMs + 3 });
  assert.equal(retry.status, 302);
  clearTimeout(app.store._snapshotFlushTimer);
  const restarted = createCampusCloudApp(options);
  t.after(() => clearTimeout(restarted.store._snapshotFlushTimer));
  const me = await restarted.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${session.access_token}` }, nowMs: nowMs + 4 });
  assert.equal(me.status, 401);
});

test('匿名网页退出不触发整份快照同步重写', async t => {
  const { app } = fixture(t);
  app.store.flushSnapshotStrictSync();
  let writes = 0;
  app.store.onPersistStage = () => writes++;
  const response = await app.inject({ method: 'GET', url: '/api/v1/auth/web/logout', nowMs });
  assert.equal(response.status, 302);
  assert.equal(writes, 0);
});
