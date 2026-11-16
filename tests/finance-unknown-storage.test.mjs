import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudDatabaseStore } from '../packages/db/src/index.mjs';
import { FinanceSagaService, buildDebitEventKey, buildFinancePayloadHash } from '../packages/finance/src/index.mjs';

test('恢复的真实资金未知操作只回查，不自动重发扣款', async () => {
  const store = new CloudDatabaseStore();
  const eventKey = buildDebitEventKey('test-order');
  store.reservationOrders.set('test-order', { id: 'test-order', job_id: 'test-job', cloud_user_id: 'test-user', school_result: 'CONFIRMED', payment_state: 'DEBIT_PENDING', price_micropeach: 10000, price_peach: 1 });
  store.financeOperations.set(eventKey, { order_id: 'test-order', event_key: eventKey, amount_micropeach: 10000, status: 'IN_FLIGHT', attempt_count: 1, payload_hash: buildFinancePayloadHash({ kind: 'DEBIT', orderId: 'test-order', eventKey, amountMicropeach: 10000 }) });
  let writes = 0, reads = 0;
  const bridge = { realDebitsEnabled: true,
    async queryOperationResult() { reads++; return { outcome: 'UNKNOWN' }; },
    async adjustBalanceIdempotent() { writes++; return { ok: true }; }
  };
  const finance = new FinanceSagaService(store, bridge);
  await assert.rejects(finance.executeDebitForOrder('test-order'), { code: 'PAYMENT_RECONCILING' });
  assert.equal(writes, 0);
  assert.equal(reads, 1);
  assert.equal(store.reservationOrders.get('test-order').payment_state, 'DEBIT_PENDING');
  bridge.queryOperationResult = async () => ({ outcome: 'APPLIED', ssoRequestId: 'test-proof' });
  assert.equal((await finance.executeDebitForOrder('test-order')).payment_state, 'PAID');
  assert.equal(writes, 0);
});
