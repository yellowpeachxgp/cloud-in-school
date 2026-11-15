import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";

// Cross-repo contract pinning (R6-QUOTE): the real handler output MUST keep
// the exact field set the Android client parses. A field rename/type change
// here breaks this test BEFORE it breaks the client.
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "reservation-quote-envelope.json"
);

test("R6-QUOTE: handler output matches the shared cross-repo contract fixture shape", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const nowMs = Date.parse("2026-11-15T10:00:00+08:00");
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "fixture_contract",
    displayName: "Contract"
  });
  const sess = app.identity.issueDeviceSession(user, "Contract Device", null, 1, nowMs);
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/reservation-quote",
    headers: { authorization: "Bearer " + sess.access_token },
    nowMs
  });
  assert.equal(res.status, 200);

  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(
    Object.keys(res.body.data).sort(),
    Object.keys(fixture.body.data).sort(),
    "response field set must match the client-consumed contract fixture"
  );
  const d = res.body.data;
  // Contract invariants the Android parser depends on — pin types, not values.
  assert.equal(typeof d.quote_id, "string");
  assert.match(d.quote_id, /^q_/);
  assert.equal(typeof d.cloud_user_id, "string");
  assert.ok(Number.isInteger(d.amount_micropeach), "amount_micropeach must be a JSON integer");
  assert.ok(d.amount_micropeach > 0);
  assert.equal(typeof d.price_version, "string", "price_version is an opaque STRING token");
  assert.ok(d.price_version.length > 0);
  assert.equal(d.unit, "PER_CONFIRMED_RESERVATION", "billing-scope unit literal — client allowlist");
  assert.ok(!Number.isNaN(Date.parse(d.issued_at)));
  assert.ok(!Number.isNaN(Date.parse(d.expires_at)));
  assert.equal(typeof d.quote_hash, "string");
  assert.match(d.quote_hash, /^[0-9a-f]{64}$/);
});

import { captureReservationFixtures } from '../tools/contract-ci/generate-reservation-fixtures.mjs';

test('完整 handler 响应与共享 fixture 一致，仅归一化随机标识和摘要', async () => {
  const captured = await captureReservationFixtures();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const errors = JSON.parse(fs.readFileSync(new URL('./fixtures/reservation-error-envelopes.json', import.meta.url), 'utf8'));
  const stableQuote = value => {
    const copy = structuredClone(value);
    delete copy._meta;
    copy.body.data.quote_id = '<随机报价标识>';
    copy.body.data.cloud_user_id = '<假身份标识>';
    copy.body.data.quote_hash = '<摘要>';
    return copy;
  };
  assert.deepEqual(stableQuote(captured.quote), stableQuote(fixture));
  assert.deepEqual(captured.errors.cases, errors.cases);
  assert.equal(fixture._meta.handler_sha256, captured.quote._meta.handler_sha256, 'handler 更新后必须重新生成 fixture 并同步 Day');
  assert.equal(captured.errors.cases[1].body.code, 'STORAGE_COMMIT_UNKNOWN');
  assert.equal(captured.errors.cases[2].http_status, 503);
});
