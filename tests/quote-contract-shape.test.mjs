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
