import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampusCloudApp } from '../apps/api/src/app.mjs';

for (const validCookie of [false, true]) {
  test(`浏览器返回过期登录链接时${validCookie ? '沿有效会话回到工作台' : '展示可重新登录的中文页面'}`, async () => {
    const app = createCampusCloudApp({ requireAdminAccess: false });
    const now = Date.now();
    const txn = app.identity.startWebTransaction({ flowKind: 'WEB_PORTAL', returnTo: '/reservations' }, now - 16 * 60_000);
    const state = app.store.authTransactions.get(txn.login_txn).serverState;
    const headers = { accept: 'text/html' };
    if (validCookie) {
      const user = app.store.findOrCreateCloudUser({ issuer: 'https://test.invalid', subject: 'recovery-user' });
      const s = app.identity.issueDeviceSession(user, '隔离网页', null, 1, now, 'WEB_PORTAL');
      headers.cookie = `dis_web_session=${app.identity.signWebSessionCookie({ cloudUserId: user.id, accessToken: s.access_token, refreshToken: s.refresh_token })}`;
    }
    const sessions = app.store.deviceSessions.size;
    const result = await app.inject({ method: 'GET', url: `/api/v1/auth/oidc/callback?code=test_expired&state=${state}`, headers, nowMs: now });
    if (validCookie) {
      assert.equal(result.status, 303);
      assert.equal(result.headers.Location, '/reservations');
      assert.equal(result.headers['set-cookie'], undefined);
    } else {
      assert.equal(result.status, 401);
      assert.match(result.headers['content-type'], /text\/html/);
      assert.match(result.rawBody, /登录链接已过期或已使用/);
      assert.match(result.rawBody, /href="\/reservations"/);
    }
    assert.equal(app.store.deviceSessions.size, sessions);
    assert.equal(result.headers['referrer-policy'], 'no-referrer');
    const json = await app.inject({ method: 'GET', url: `/api/v1/auth/oidc/callback?code=test_expired&state=${state}`, headers: { ...headers, accept: 'application/json' }, nowMs: now });
    assert.equal(json.status, 401);
    assert.equal(json.body.code, 'CLOUD_AUTH_REQUIRED');
  });
}

test('成功回调后浏览器重复打开原链接，沿原有效 Cookie 返回工作台且不重复签发', async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const now = Date.now();
  const start = app.identity.startWebTransaction({ flowKind: 'WEB_PORTAL' }, now);
  const state = app.store.authTransactions.get(start.login_txn).serverState;
  const url = `/api/v1/auth/oidc/callback?code=sub:isolated-replay-user&state=${state}`;
  const first = await app.inject({ method: 'GET', url, headers: { accept: 'text/html' }, nowMs: now });
  assert.equal(first.status, 302);
  const sessions = app.store.deviceSessions.size;
  const replay = await app.inject({ method: 'GET', url, headers: { accept: 'text/html', cookie: first.headers['set-cookie'].split(';')[0] }, nowMs: now + 1 });
  assert.equal(replay.status, 303); assert.equal(replay.headers.Location, '/reservations');
  assert.equal(app.store.deviceSessions.size, sessions); assert.equal(replay.headers['set-cookie'], undefined);
});

test('持久化结果未知时，即使浏览器持有效 Cookie 也不能走登录恢复伪装成功', async t => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callback-unknown-'));
  const app = createCampusCloudApp({ requireAdminAccess: false, storeOptions: { snapshotPath: path.join(dir, 'state.json'), requireDurableSnapshot: true } });
  t.after(() => { clearTimeout(app.store._snapshotFlushTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  const now = Date.now();
  const user = app.store.findOrCreateCloudUser({ issuer: 'https://test.invalid', subject: 'callback-current' });
  const session = app.identity.issueDeviceSession(user, '隔离浏览器', null, 1, now, 'WEB_PORTAL');
  const cookie = `dis_web_session=${app.identity.signWebSessionCookie({ cloudUserId: user.id, accessToken: session.access_token, refreshToken: session.refresh_token })}`;
  const start = app.identity.startWebTransaction({ flowKind: 'WEB_PORTAL' }, now);
  const state = app.store.authTransactions.get(start.login_txn).serverState;
  app.store._persistFaultInject = 'dir_fsync';
  const result = await app.inject({ method: 'GET', url: `/api/v1/auth/oidc/callback?code=sub:callback-current&state=${state}`, headers: { accept: 'text/html', cookie }, nowMs: now });
  assert.equal(result.status, 503); assert.equal(result.body.code, 'STORAGE_COMMIT_UNKNOWN');
  assert.equal(result.headers.Location, undefined); assert.equal(app.store.storageCommitUnknown, true);
});
