import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCampusCloudApp } from '../../apps/api/src/app.mjs';

/** 假身份、临时存储，所有响应均由实际 HTTP handler 生成。 */
export async function captureReservationFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reservation-fixture-'));
  const app = createCampusCloudApp({ requireAdminAccess: false, storeOptions: { snapshotPath: path.join(dir, 'state.json'), requireDurableSnapshot: true } });
  const nowMs = Date.parse('2026-11-15T10:00:00+08:00');
  try {
    const user = app.store.findOrCreateCloudUser({ issuer: 'https://fixture.invalid', subject: 'test_quote_contract', displayName: '契约测试学生' });
    const session = app.identity.issueDeviceSession(user, '契约测试设备', null, 1, nowMs);
    const headers = { authorization: `Bearer ${session.access_token}` };
    const request = (name, method, url, body) => app.inject({ method, url, body, headers: { ...headers, 'x-request-id': `req_fixture_${name}`, 'idempotency-key': 'fixture-create' }, nowMs });
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/reservation-quote', headers: { 'x-request-id': 'req_fixture_quote_auth' }, nowMs });
    const quote = await request('quote_ok', 'GET', '/api/v1/reservation-quote');
    const consent = (await request('consent', 'POST', '/api/v1/me/consents', { school_id: 'haut' })).body.data.id;
    const binding = (await request('binding', 'POST', '/api/v1/school-bindings', { school_id: 'haut', student_no: '2026998888' })).body.data.id;
    await request('complete', 'POST', `/api/v1/school-bindings/${binding}/complete`, { consent_id: consent, delegated_secret: 'test-fixture-secret' });
    app.store._persistFaultInject = 'tmp_open';
    const createUncommitted = await request('create_uncommitted', 'POST', '/api/v1/reservation-plans', { school_binding_id: binding, consent_id: consent, target_local_date: '2026-11-16', target_local_time: '07:00:00', quote_id: quote.body.data.quote_id });
    app.store._persistFaultInject = 'dir_fsync';
    const createUnknown = await request('create_unknown', 'POST', '/api/v1/reservation-plans', { school_binding_id: binding, consent_id: consent, target_local_date: '2026-11-16', target_local_time: '07:00:00', quote_id: quote.body.data.quote_id });
    const quoteUnknown = await request('quote_unknown', 'GET', '/api/v1/reservation-quote');
    const wrap = res => ({ http_status: res.status, body: res.body });
    const meta = {
      generated_by: 'cloud-in-school 实际 apps/api handler；工具仅使用假身份和临时存储',
      // W0-08: pin the canonical route entries and normalized handler source for
      // the operations participating in this fixture, rather than the physical
      // app.mjs file bytes. Pure file moves no longer invalidate the fixture.
      handler_sha256: app.getRouteBehaviorFingerprint([
        'getReservationQuote',
        'createReservationPlan',
        'grantConsent',
        'initiateSchoolBinding',
        'completeSchoolBinding'
      ])
    };
    return { quote: { _meta: meta, ...wrap(quote) }, errors: { _meta: meta, cases: [
      { name: 'quote_auth', ...wrap(unauthorized) },
      { name: 'create_unknown', ...wrap(createUnknown) },
      { name: 'quote_unknown', ...wrap(quoteUnknown) },
      { name: 'create_uncommitted', ...wrap(createUncommitted) }
    ] } };
  } finally {
    clearTimeout(app.store._snapshotFlushTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixtures = await captureReservationFixtures();
  const destinations = [new URL('../../tests/fixtures/', import.meta.url)];
  if (process.argv[2]) destinations.push(path.join(path.resolve(process.argv[2]), 'core/campusservices/src/test/resources'));
  for (const destination of destinations) {
    fs.mkdirSync(destination, { recursive: true });
    for (const [name, data] of [['reservation-quote-envelope.json', fixtures.quote], ['reservation-error-envelopes.json', fixtures.errors]]) {
      fs.writeFileSync(destination instanceof URL ? new URL(name, destination) : path.join(destination, name), JSON.stringify(data, null, 2) + '\n');
    }
  }
  console.log('已由 Cloud 实际 handler 生成成功及错误响应，写入 Cloud 与指定 Day 测试资源。');
}
