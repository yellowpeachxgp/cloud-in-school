import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampusCloudApp } from '../apps/api/src/app.mjs';
import { renderConsoleHtml } from '../apps/console/src/main.mjs';

for (const [micro, displayed] of [[15000, '1.5'], [1, '0.0001'], [10001, '1.0001']]) {
  test(`真实后台模板精确展示退还金额：${micro} 微桃`, () => {
    const html = renderConsoleHtml({ user: { id: 'test-admin', role: 'admin' }, activeNav: 'orders',
      refundRequests: [{ id: 'test-refund', order_id: 'test-order', status: 'PENDING_APPROVAL', amount_micropeach: micro }] });
    assert.ok(html.includes(`退还申请 ${displayed} 🍑`));
  });
}

test('后台按钮实际生成的申请路由能由真实 handler 受理，且未执行资金写入', async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const user = app.store.findOrCreateCloudUser({ issuer: app.identity.expectedIssuer, subject: 'test-refund-admin', role: 'admin' });
  const session = app.identity.issueDeviceSession(user, '隔离验收');
  const order = { id: 'test-order', cloud_user_id: user.id, price_micropeach: 15000, price_peach: 1.5,
    payment_state: 'PAID', paid_at: new Date().toISOString() };
  app.store.reservationOrders.set(order.id, order);
  let moneyWrites = 0;
  app.financeBridge.adjustBalanceIdempotent = async () => { moneyWrites++; throw new Error('禁止资金写入'); };
  const html = renderConsoleHtml({ user, activeNav: 'orders', allOrders: [order] });
  // 从真实模板按钮代码提取路由后缀；请求体与按钮提交的 reason 一致，不补造金额。
  const suffix = html.match(/apiFetch\("\/api\/v1\/admin\/orders\/" \+ encodeURIComponent\(orderId\) \+ "([^"]+)"/)[1];
  const response = await app.inject({ method: 'POST', url: `/api/v1/admin/orders/${order.id}${suffix}`,
    headers: { authorization: `Bearer ${session.access_token}` }, body: { reason: '隔离全额退还申请' } });
  assert.equal(response.status, 202, JSON.stringify(response.body));
  assert.equal(response.body.data.refund_request.amount_micropeach, 15000);
  assert.equal(response.body.data.refund_request.status, 'PENDING_APPROVAL');
  assert.equal(order.payment_state, 'PAID');
  assert.equal(moneyWrites, 0);
});
