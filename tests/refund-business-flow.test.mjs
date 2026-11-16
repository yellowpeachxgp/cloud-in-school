import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCampusCloudApp } from '../apps/api/src/app.mjs';
import { IsolatedFinanceBridge } from '../packages/finance/src/index.mjs';
import { renderConsoleHtml } from '../apps/console/src/main.mjs';

async function approvedRefund(t, financeBridge) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-business-'));
  const app = createCampusCloudApp({ requireAdminAccess: false, ...(financeBridge ? { financeBridge } : {}),
    storeOptions: { snapshotPath: path.join(dir, 'state.json'), requireDurableSnapshot: true } });
  t.after(() => { clearTimeout(app.store._snapshotFlushTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  const account = (subject, role) => app.store.findOrCreateCloudUser({ issuer: 'https://review.invalid', subject, role });
  const buyer = account('review-buyer', 'user');
  const adminA = account('review-admin-a', 'admin');
  const adminB = account('review-admin-b', 'admin');
  const token = user => ({ authorization: `Bearer ${app.identity.issueDeviceSession(user, '隔离业务回归').access_token}` });
  const headersA = token(adminA), headersB = token(adminB);
  const order = { id: '10000000-0000-4000-8000-000000000001', cloud_user_id: buyer.id, payment_state: 'PAID', price_micropeach: 10000,
    price_peach: 1, paid_at: new Date().toISOString() };
  app.store.reservationOrders.set(order.id, order);
  const created = await app.inject({ method: 'POST', url: `/api/v1/admin/orders/${order.id}/refund-requests`,
    headers: headersA, body: { amount_micropeach: 10000, reason: '隔离退款回归' } });
  assert.equal(created.status, 202);
  const requestId = created.body.data.refund_request.id;
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/admin/refund-requests/${requestId}/approve`, headers: headersB })).status, 200);
  const execute = () => app.inject({ method: 'POST', url: `/api/v1/admin/refund-requests/${requestId}/execute`, headers: headersB });
  return { app, order, requestId, execute, adminA };
}

test('真实资金桥收到上游 409 时不能把订单伪装为已退款，重试只查原键', async t => {
  const originalFetch = globalThis.fetch;
  let posts = 0, reads = 0;
  // 使用真实资金桥和隔离 HTTP 端口；不向任何外部服务发请求。
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://sso.review.invalid');
    assert.equal(options.method, 'POST');
    posts++;
    return new Response(JSON.stringify({ ok: false, error: 'operation_conflict' }), { status: 409 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const bridge = new IsolatedFinanceBridge({ realDebitsEnabled: true, allowSandboxFallback: false,
    ssoBaseUrl: 'https://sso.review.invalid', internalServiceKey: 'isolated-review-only' });
  bridge.queryOperationResult = async () => { reads++; return { outcome: 'UNKNOWN' }; };
  const { app, order, requestId, execute } = await approvedRefund(t, bridge);
  const first = await execute();
  assert.equal(first.body.ok, false, JSON.stringify(first.body));
  assert.equal(order.payment_state, 'PAID');
  assert.equal(app.store.refundRequests.get(requestId).status, 'RESULT_UNKNOWN');
  assert.equal(posts, 1);
  assert.equal((await execute()).body.ok, false);
  assert.equal(posts, 1, '未知结果不能自动再发退款');
  assert.equal(reads, 1);
});

test('真实退款 handler 已返回到账时，后台实际回调展示已到账', async t => {
  const { app, order, execute, adminA } = await approvedRefund(t);
  let moneyCalls = 0;
  app.financeBridge.adjustBalanceIdempotent = async () => { moneyCalls++; return { ok: true, ssoRequestId: 'review-applied' }; };
  const response = await execute();
  assert.equal(response.status, 200);
  assert.equal(response.body.data.refund_request.status, 'REFUNDED');
  const html = renderConsoleHtml({ user: adminA, activeNav: 'orders', allOrders: [order] });
  const section = html.slice(html.indexOf('document.querySelectorAll("[data-execute-refund]")'));
  const callback = section.match(/\.then\(function \(res\) \{([\s\S]*?)\n\s*\}\)/)[1];
  const messages = [];
  new Function('res', 'showToast', 'setTimeout', 'window', callback)(
    response.body, message => messages.push(message), () => {}, { location: { reload() {} } });
  assert.deepEqual(messages, ['退还已到账，账单已同步。']);
  assert.equal(moneyCalls, 1);
});
