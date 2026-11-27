import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCampusCloudApp as createCampusCloudAppBase } from "../apps/api/src/app.mjs";
import { PLACE_STATUS_DELETED_USER_TOMBSTONE } from "../packages/place-status/src/index.mjs";

const BASE_NOW = Date.parse("2026-11-27T10:00:00.000Z");
const PLACE = "haut/lianhuajie/room/5-111";
const ENCODED_PLACE = encodeURIComponent(PLACE);
let keySeq = 0;
let userSeq = 0;

function createCampusCloudApp(options) {
  const app = createCampusCloudAppBase(options);
  const rawInject = app.inject.bind(app);
  app.inject = (request) => rawInject({ nowMs: BASE_NOW, ...request });
  return app;
}

function nextKey(prefix) {
  keySeq += 1;
  return prefix + "-" + keySeq + "-12345678";
}

function createTestApp(options = {}) {
  return createCampusCloudApp({ requireAdminAccess: false, ...options });
}

function setupUser(app, label, { schoolId = "haut", bind = true, admin = false, nowMs = BASE_NOW } = {}) {
  const user = app.store.findOrCreateCloudUser({
    issuer: app.identity.expectedIssuer,
    subject: "sub_" + label + "_" + crypto.randomUUID().slice(0, 8),
    username: label,
    displayName: label
  });
  if (admin) user.role = "admin";
  const session = app.identity.issueDeviceSession(user, label, null, 1, nowMs, "MOBILE_APP");
  if (bind) {
    const binding = {
      id: crypto.randomUUID(),
      cloud_user_id: user.id,
      school_id: schoolId,
      student_no: "2024" + String(200000 + (++userSeq)),
      status: "DELEGATED_ACTIVE",
      credential_ref: null,
      consent_id: null,
      auth_version: 1,
      created_at: new Date(nowMs).toISOString(),
      revoked_at: null
    };
    app.store.schoolBindings.set(binding.id, binding);
    app.store.indexUserScoped?.("schoolBindings", binding.id, user.id);
  }
  return { user, session, auth: { authorization: "Bearer " + session.access_token } };
}

function writeHeaders(user, key = nextKey("place-write")) {
  return { ...user.auth, "idempotency-key": key };
}

async function createReport(app, user, overrides = {}, { nowMs = BASE_NOW, key = nextKey("report") } = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/places/" + ENCODED_PLACE + "/reports",
    headers: writeHeaders(user, key),
    body: {
      metric: "OCCUPANCY",
      state: "CROWDED",
      observed_at: new Date(nowMs - 10 * 60_000).toISOString(),
      report_kind: "OBSERVATION",
      ...overrides
    },
    nowMs
  });
  return response;
}

async function queryOne(app, user, metric = "OCCUPANCY", nowMs = BASE_NOW) {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/places/status?school_id=haut&place_refs=" + ENCODED_PLACE + "&metrics=" + metric,
    headers: user.auth,
    nowMs
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.length, 1);
  return response.body.data[0];
}

test("W4-04 report creation: validation, school scope, observed_at TTL, immutable history, and durable idempotent replay", async () => {
  const app = createTestApp();
  const author = setupUser(app, "author_validation");
  const unbound = setupUser(app, "unbound_validation", { bind: false });
  const otherSchool = setupUser(app, "other_school_validation", { schoolId: "other-university" });

  const missingKey = await app.inject({
    method: "POST",
    url: "/api/v1/places/" + ENCODED_PLACE + "/reports",
    headers: author.auth,
    body: { metric: "OCCUPANCY", state: "CROWDED", observed_at: new Date(BASE_NOW).toISOString(), report_kind: "OBSERVATION" }
  });
  assert.equal(missingKey.status, 400);

  const badRefResponse = await app.inject({
    method: "POST",
    url: "/api/v1/places/not-a-valid-ref/reports",
    headers: writeHeaders(author),
    body: { metric: "OCCUPANCY", state: "CROWDED", observed_at: new Date(BASE_NOW).toISOString(), report_kind: "OBSERVATION" }
  });
  assert.equal(badRefResponse.status, 400);
  assert.equal(badRefResponse.body.error.code, "PLACE_REF_INVALID");

  const unknownRefResponse = await app.inject({
    method: "POST",
    url: "/api/v1/places/" + encodeURIComponent("haut/lianhuajie/room/9-999") + "/reports",
    headers: writeHeaders(author),
    body: { metric: "OCCUPANCY", state: "CROWDED", observed_at: new Date(BASE_NOW).toISOString(), report_kind: "OBSERVATION" }
  });
  assert.equal(unknownRefResponse.status, 404);
  assert.equal(unknownRefResponse.body.error.code, "PLACE_NOT_FOUND");

  for (const [label, body, expectedCode] of [
    ["metric-state", { metric: "OCCUPANCY", state: "OPEN", observed_at: new Date(BASE_NOW).toISOString(), report_kind: "OBSERVATION" }, "PLACE_STATUS_REPORT_INVALID"],
    ["expired", { metric: "OCCUPANCY", state: "CROWDED", observed_at: new Date(BASE_NOW - 1800_000).toISOString(), report_kind: "OBSERVATION" }, "PLACE_STATUS_REPORT_INVALID"],
    ["future", { metric: "OCCUPANCY", state: "CROWDED", observed_at: new Date(BASE_NOW + 6 * 60_000).toISOString(), report_kind: "OBSERVATION" }, "PLACE_STATUS_REPORT_INVALID"],
    ["pii", { metric: "OCCUPANCY", state: "CROWDED", observed_at: new Date(BASE_NOW).toISOString(), report_kind: "OBSERVATION", note: "联系人 13812345678" }, "PLACE_STATUS_REPORT_INVALID"]
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/places/" + ENCODED_PLACE + "/reports",
      headers: writeHeaders(author),
      body,
      nowMs: BASE_NOW
    });
    assert.equal(response.status, 400, label + ": " + JSON.stringify(response.body));
    assert.equal(response.body.error.code, expectedCode, label);
  }

  const noBinding = await createReport(app, unbound, { observed_at: new Date(BASE_NOW).toISOString() });
  assert.equal(noBinding.status, 409);
  assert.equal(noBinding.body.error.code, "CAMPUS_BINDING_REQUIRED");
  const wrongSchool = await createReport(app, otherSchool, { observed_at: new Date(BASE_NOW).toISOString() });
  assert.equal(wrongSchool.status, 403);
  assert.equal(wrongSchool.body.error.code, "SCHOOL_SCOPE_MISMATCH");

  const observedMs = BASE_NOW - 60_000;
  const key = nextKey("create-replay");
  const first = await createReport(app, author, { observed_at: new Date(observedMs).toISOString(), note: "后排基本坐满" }, { key });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.data.ttl_seconds, 1800);
  assert.equal(Date.parse(first.body.data.expires_at) - observedMs, 1800_000, "TTL must start at observed_at, never reported_at");
  assert.equal(first.body.data.reported_at, new Date(BASE_NOW).toISOString());
  assert.equal(first.body.data.is_own_report, true);
  assert.ok(!first.body.data.reporter_alias.includes(author.user.id), "public alias must not expose the cloud user id");

  const replay = await createReport(app, author, { observed_at: new Date(observedMs).toISOString(), note: "后排基本坐满" }, { key });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.code, "REQUEST_DUPLICATE");
  assert.equal(replay.body.data.report_id, first.body.data.report_id);

  const conflict = await app.inject({
    method: "POST",
    url: "/api/v1/places/" + ENCODED_PLACE + "/reports",
    headers: writeHeaders(author, key),
    body: { metric: "OCCUPANCY", state: "QUIET", observed_at: new Date(observedMs).toISOString(), report_kind: "OBSERVATION" }
  });
  assert.equal(conflict.status, 409);

  const history = await app.inject({
    method: "GET",
    url: "/api/v1/places/" + ENCODED_PLACE + "/reports?metric=OCCUPANCY&include_expired=true",
    headers: author.auth
  });
  assert.equal(history.status, 200);
  assert.equal(history.body.data.length, 1);
  assert.equal(history.body.data[0].note, "后排基本坐满");
  const changed = app.store.outboxEvents.filter((event) => event.event_type === "place.status.changed");
  assert.equal(changed.length, 1, "idempotent replay must not emit a duplicate event");
  assert.equal(changed[0].payload_json.official_realtime_status, false);
  assert.equal(changed[0].payload_json.trigger_type, "REPORT_ACCEPTED");
});

test("W4-04 aggregation: latest-per-reporter corrections stay append-only and any divergence is CONTESTED", async () => {
  const app = createTestApp();
  const alice = setupUser(app, "alice_divergence");
  const bob = setupUser(app, "bob_divergence");

  const a1 = await createReport(app, alice, { state: "CROWDED", observed_at: new Date(BASE_NOW - 10 * 60_000).toISOString() });
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  const b1 = await createReport(app, bob, { state: "QUIET", observed_at: new Date(BASE_NOW - 8 * 60_000).toISOString() });
  assert.equal(b1.status, 201, JSON.stringify(b1.body));

  let view = await queryOne(app, alice);
  assert.equal(view.effective_state, "CONTESTED");
  assert.equal(view.aggregation_algorithm, "LATEST_PER_REPORTER_ANY_DIVERGENCE_CONTESTED_V1");
  assert.deepEqual(view.divergent_states.map((row) => row.state).sort(), ["CROWDED", "QUIET"]);
  assert.equal(view.reporter_count, 2);
  assert.equal(view.provenance.kind, "USER_REPORTED");
  assert.equal(view.provenance.freshness, "FRESH");

  const correction = await app.inject({
    method: "POST",
    url: "/api/v1/places/" + ENCODED_PLACE + "/reports",
    headers: writeHeaders(alice),
    body: {
      metric: "OCCUPANCY",
      state: "FULL",
      observed_at: new Date(BASE_NOW - 5 * 60_000).toISOString(),
      report_kind: "CORRECTION",
      corrects_report_id: a1.body.data.report_id,
      note: "门口排队，实际已满"
    }
  });
  assert.equal(correction.status, 201, JSON.stringify(correction.body));
  view = await queryOne(app, alice);
  assert.equal(view.effective_state, "CONTESTED");
  assert.deepEqual(view.divergent_states.map((row) => row.state).sort(), ["FULL", "QUIET"]);

  const history = await app.inject({
    method: "GET",
    url: "/api/v1/places/" + ENCODED_PLACE + "/reports?metric=OCCUPANCY&include_expired=true",
    headers: alice.auth
  });
  assert.equal(history.status, 200);
  const original = history.body.data.find((row) => row.report_id === a1.body.data.report_id);
  assert.ok(original, "correction must never rewrite or delete the original observation");
  assert.equal(original.state, "CROWDED");
  assert.deepEqual(original.corrected_by_report_ids, [correction.body.data.report_id]);
  const correctionRow = history.body.data.find((row) => row.report_id === correction.body.data.report_id);
  assert.equal(correctionRow.corrects_report_id, a1.body.data.report_id);

  const foreignCorrection = await app.inject({
    method: "POST",
    url: "/api/v1/places/" + ENCODED_PLACE + "/reports",
    headers: writeHeaders(bob),
    body: {
      metric: "OCCUPANCY",
      state: "QUIET",
      observed_at: new Date(BASE_NOW - 2 * 60_000).toISOString(),
      report_kind: "CORRECTION",
      corrects_report_id: a1.body.data.report_id
    }
  });
  assert.equal(foreignCorrection.status, 201, JSON.stringify(foreignCorrection.body));
  view = await queryOne(app, alice);
  assert.equal(view.effective_state, "CONTESTED", "a foreign correction is the foreign reporter's own observation, never an authority override");
  assert.deepEqual(view.divergent_states.map((row) => row.state).sort(), ["FULL", "QUIET"]);
  const originalAfterForeign = (await app.inject({
    method: "GET",
    url: "/api/v1/places/" + ENCODED_PLACE + "/reports?metric=OCCUPANCY",
    headers: alice.auth
  })).body.data.find((row) => row.report_id === a1.body.data.report_id);
  assert.equal(originalAfterForeign.state, "CROWDED");
  assert.ok(originalAfterForeign.corrected_by_report_ids.includes(foreignCorrection.body.data.report_id));
});

test("W4-04 TTL expiry: expiry is lazy-recomputed from observed_at, becomes UNKNOWN, emits TTL_EXPIRED, and bbox filtering is honest", async () => {
  const app = createTestApp();
  const author = setupUser(app, "author_ttl");
  const created = await createReport(app, author, {
    state: "CROWDED",
    observed_at: new Date(BASE_NOW - 25 * 60_000).toISOString()
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const freshView = await queryOne(app, author, "OCCUPANCY", BASE_NOW + 4 * 60_000);
  assert.equal(freshView.effective_state, "CROWDED");
  assert.equal(freshView.expires_at, new Date(BASE_NOW + 5 * 60_000).toISOString());

  const expiredView = await queryOne(app, author, "OCCUPANCY", BASE_NOW + 6 * 60_000);
  assert.equal(expiredView.effective_state, "UNKNOWN");
  assert.equal(expiredView.unknown_reason, "ALL_EXPIRED");
  assert.equal(expiredView.expires_at, null);
  assert.equal(expiredView.provenance.freshness, "STALE");
  const ttlEvents = app.store.outboxEvents.filter(
    (event) => event.event_type === "place.status.changed" && event.payload_json.trigger_type === "TTL_EXPIRED"
  );
  assert.equal(ttlEvents.length, 1);
  assert.equal(ttlEvents[0].payload_json.previous_effective_state, "CROWDED");
  assert.equal(ttlEvents[0].payload_json.effective_state, "UNKNOWN");
  assert.equal(ttlEvents[0].payload_json.trigger_report_id, created.body.data.report_id);
  assert.match(ttlEvents[0].payload_json.event_key, /^dis:place-status:report:[0-9a-fA-F-]{36}:revision:[0-9]+:v1$/);
  assert.equal(ttlEvents[0].payload_json.official_realtime_status, false);

  const bbox = "34.8310,113.5460,34.8315,113.5471";
  const withoutExpired = await app.inject({
    method: "GET",
    url: "/api/v1/places/status?school_id=haut&bbox=" + bbox + "&metrics=OCCUPANCY&place_types=room",
    headers: author.auth,
    nowMs: BASE_NOW + 6 * 60_000
  });
  assert.equal(withoutExpired.status, 200);
  assert.equal(withoutExpired.body.data.length, 0, "bbox default excludes places whose reports are all expired");
  const withExpired = await app.inject({
    method: "GET",
    url: "/api/v1/places/status?school_id=haut&bbox=" + bbox + "&metrics=OCCUPANCY&place_types=room&include_expired=true",
    headers: author.auth,
    nowMs: BASE_NOW + 6 * 60_000
  });
  assert.equal(withExpired.status, 200);
  assert.equal(withExpired.body.data.length, 1);
  assert.equal(withExpired.body.data[0].effective_state, "UNKNOWN");
  assert.equal(withExpired.body.data[0].unknown_reason, "ALL_EXPIRED");

  const noReports = await queryOne(app, author, "ACCESS", BASE_NOW + 6 * 60_000);
  assert.equal(noReports.effective_state, "UNKNOWN");
  assert.equal(noReports.unknown_reason, "NO_REPORTS");
  assert.equal(noReports.aggregation_revision, 0);
});

test("W4-04 subscriptions: create/list/cancel idempotently and fan out only in-app notifications", async () => {
  const app = createTestApp();
  const subscriber = setupUser(app, "subscriber_fanout");
  const author = setupUser(app, "author_fanout");

  const invalid = await app.inject({
    method: "POST",
    url: "/api/v1/places/status/subscriptions",
    headers: writeHeaders(subscriber),
    body: { school_id: "haut", target: { type: "AREA" }, metrics: ["OCCUPANCY"] }
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "PLACE_STATUS_SUBSCRIPTION_INVALID");

  const key = nextKey("subscription-replay");
  const body = {
    school_id: "haut",
    target: { type: "PLACE", place_ref: PLACE },
    metrics: ["OCCUPANCY", "ACCESS"]
  };
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/places/status/subscriptions",
    headers: writeHeaders(subscriber, key),
    body
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.delivery_channel, "IN_APP_NOTIFICATION");
  assert.equal(created.body.data.status, "ACTIVE");
  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/places/status/subscriptions",
    headers: writeHeaders(subscriber, key),
    body
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.subscription_id, created.body.data.subscription_id);

  const listed = await app.inject({
    method: "GET",
    url: "/api/v1/places/status/subscriptions?school_id=haut&status=ACTIVE",
    headers: subscriber.auth
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.length, 1);

  const firstReport = await createReport(app, author, { state: "CROWDED", observed_at: new Date(BASE_NOW - 60_000).toISOString() });
  assert.equal(firstReport.status, 201, JSON.stringify(firstReport.body));
  const inbox = Array.from(app.store.notifications.values()).filter((row) => row.cloud_user_id === subscriber.user.id && row.category === "place_status");
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].body, /非官方实时状态/);
  assert.ok(!inbox[0].body.includes("后排"), "notification fan-out must not copy free-text report notes");

  const deleteKey = nextKey("cancel-subscription");
  const cancelled = await app.inject({
    method: "DELETE",
    url: "/api/v1/places/status/subscriptions/" + created.body.data.subscription_id,
    headers: writeHeaders(subscriber, deleteKey)
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.status, "CANCELLED");
  const cancelReplay = await app.inject({
    method: "DELETE",
    url: "/api/v1/places/status/subscriptions/" + created.body.data.subscription_id,
    headers: writeHeaders(subscriber, deleteKey)
  });
  assert.equal(cancelReplay.status, 200);
  assert.equal(cancelReplay.body.code, "REQUEST_DUPLICATE");

  const second = await createReport(app, subscriber, { state: "QUIET", observed_at: new Date(BASE_NOW).toISOString() });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const inboxAfter = Array.from(app.store.notifications.values()).filter((row) => row.cloud_user_id === subscriber.user.id && row.category === "place_status");
  assert.equal(inboxAfter.length, 1, "cancelled subscription must stop future fan-out");

  const foreignDelete = await app.inject({
    method: "DELETE",
    url: "/api/v1/places/status/subscriptions/" + created.body.data.subscription_id,
    headers: writeHeaders(author)
  });
  assert.equal(foreignDelete.status, 404);
  assert.equal(foreignDelete.body.error.code, "PLACE_STATUS_SUBSCRIPTION_NOT_FOUND");
});

test("W4-04 flag abuse control: fresh duplicate keys are rate-limited while true receipt replay remains free", async () => {
  const app = createTestApp();
  const author = setupUser(app, "author_flag_receipt_limit");
  const flagger = setupUser(app, "flagger_receipt_limit");
  const report = await createReport(app, author, { state: "CROWDED", observed_at: new Date(BASE_NOW - 60_000).toISOString() });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  const flagBody = { reason: "INCORRECT", detail: "重复举报回执写入限速" };

  const initial = await app.inject({
    method: "POST",
    url: "/api/v1/place-reports/" + report.body.data.report_id + "/flag",
    headers: writeHeaders(flagger),
    body: flagBody
  });
  assert.equal(initial.status, 201, JSON.stringify(initial.body));
  let lastFoldedKey = null;
  for (let index = 0; index < 19; index += 1) {
    lastFoldedKey = nextKey("flag-folded-abuse");
    const folded = await app.inject({
      method: "POST",
      url: "/api/v1/place-reports/" + report.body.data.report_id + "/flag",
      headers: writeHeaders(flagger, lastFoldedKey),
      body: flagBody
    });
    assert.equal(folded.status, 200, JSON.stringify(folded.body));
  }
  const receiptPrefix = "flagPlaceStatusReport|" + flagger.user.id + "|";
  assert.equal(Array.from(app.store.idempotencyRecords.keys()).filter((key) => key.startsWith(receiptPrefix)).length, 20);
  assert.equal(app.store.placeReportFlags.size, 1, "duplicate folds still must not create additional flag rows");

  const limited = await app.inject({
    method: "POST",
    url: "/api/v1/place-reports/" + report.body.data.report_id + "/flag",
    headers: writeHeaders(flagger),
    body: flagBody
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "PLACE_STATUS_RATE_LIMITED");

  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/place-reports/" + report.body.data.report_id + "/flag",
    headers: writeHeaders(flagger, lastFoldedKey),
    body: flagBody
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.code, "REQUEST_DUPLICATE", "replaying an existing receipt must not consume fresh-write budget");
});

test("W4-04 flags and moderation: queue is school-scoped, exclusion recomputes without rewriting observations", async () => {
  const app = createTestApp();
  const author = setupUser(app, "author_moderation");
  const flagger = setupUser(app, "flagger_moderation");
  const moderator = setupUser(app, "moderator_moderation", { admin: true });
  const regular = setupUser(app, "regular_moderation");

  const report = await createReport(app, author, { state: "CROWDED", observed_at: new Date(BASE_NOW - 60_000).toISOString() });
  assert.equal(report.status, 201, JSON.stringify(report.body));

  const nonModeratorQueue = await app.inject({
    method: "GET",
    url: "/api/v1/admin/place-report-flags?school_id=haut",
    headers: regular.auth
  });
  assert.equal(nonModeratorQueue.status, 403);
  assert.equal(nonModeratorQueue.body.error.code, "PLACE_STATUS_PERMISSION_DENIED");

  const flagKey = nextKey("flag-replay");
  const flagBody = { reason: "INCORRECT", detail: "20:10 现场门口仍开放，原上报需复核" };
  const flagged = await app.inject({
    method: "POST",
    url: "/api/v1/place-reports/" + report.body.data.report_id + "/flag",
    headers: writeHeaders(flagger, flagKey),
    body: flagBody
  });
  assert.equal(flagged.status, 201, JSON.stringify(flagged.body));
  assert.equal(flagged.body.data.status, "OPEN");
  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/place-reports/" + report.body.data.report_id + "/flag",
    headers: writeHeaders(flagger, flagKey),
    body: flagBody
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.flag_id, flagged.body.data.flag_id);
  const foldedKey = nextKey("flag-folded");
  const folded = await app.inject({
    method: "POST",
    url: "/api/v1/place-reports/" + report.body.data.report_id + "/flag",
    headers: writeHeaders(flagger, foldedKey),
    body: flagBody
  });
  assert.equal(folded.status, 200);
  assert.equal(folded.body.data.flag_id, flagged.body.data.flag_id, "identical active flags by the same caller are folded");
  const conflictingFlag = await app.inject({
    method: "POST",
    url: "/api/v1/place-reports/" + report.body.data.report_id + "/flag",
    headers: writeHeaders(flagger),
    body: { reason: "STALE" }
  });
  assert.equal(conflictingFlag.status, 400);
  assert.equal(conflictingFlag.body.error.code, "PLACE_REPORT_FLAG_INVALID");

  const queue = await app.inject({
    method: "GET",
    url: "/api/v1/admin/place-report-flags?school_id=haut&status=OPEN&place_ref=" + encodeURIComponent(PLACE),
    headers: moderator.auth
  });
  assert.equal(queue.status, 200, JSON.stringify(queue.body));
  assert.equal(queue.body.data.length, 1);
  assert.equal(queue.body.data[0].flag_id, flagged.body.data.flag_id);
  assert.equal(Object.hasOwn(queue.body.data[0], "flagger_cloud_user_id"), false, "queue DTO must not expose flagger user ids");

  const review = await app.inject({
    method: "POST",
    url: "/api/v1/admin/place-report-flags/" + flagged.body.data.flag_id + "/review",
    headers: writeHeaders(moderator),
    body: { action: "EXCLUDE_INCORRECT", review_note: "两名 reviewer 复核现场照片后排除" }
  });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.equal(review.body.data.flag.status, "RESOLVED_EXCLUDED");
  assert.equal(review.body.data.flag.review_action, "EXCLUDE_INCORRECT");
  assert.equal(review.body.data.status_view.effective_state, "UNKNOWN");
  assert.equal(review.body.data.status_view.unknown_reason, "ALL_EXCLUDED");

  const storedReport = app.store.placeReports.get(report.body.data.report_id);
  assert.equal(storedReport.state, "CROWDED", "moderation must never rewrite the user observation");
  assert.equal(storedReport.moderation_state, "EXCLUDED_INCORRECT");
  assert.equal(storedReport.aggregation_eligible, false);
  const moderationEvents = app.store.outboxEvents.filter(
    (event) => event.event_type === "place.status.changed" && event.payload_json.trigger_type === "MODERATION_REVIEW"
  );
  assert.equal(moderationEvents.length, 1);
  assert.equal(moderationEvents[0].payload_json.moderation_action, "EXCLUDE_INCORRECT");
  assert.equal(moderationEvents[0].payload_json.effective_state, "UNKNOWN");
  assert.ok(app.store.auditEvents.some((event) => event.action === "place_report_flag.review" && event.resource_ref === flagged.body.data.flag_id));

  const hiddenHistory = await app.inject({
    method: "GET",
    url: "/api/v1/places/" + ENCODED_PLACE + "/reports?metric=OCCUPANCY&include_expired=true",
    headers: author.auth
  });
  assert.equal(hiddenHistory.status, 200);
  assert.equal(hiddenHistory.body.data.length, 0, "moderation-excluded rows are omitted from the normal user history");

  const secondReview = await app.inject({
    method: "POST",
    url: "/api/v1/admin/place-report-flags/" + flagged.body.data.flag_id + "/review",
    headers: writeHeaders(moderator),
    body: { action: "KEEP_VISIBLE", review_note: "重复处置" }
  });
  assert.equal(secondReview.status, 409);
  assert.equal(secondReview.body.error.code, "PLACE_REPORT_REVIEW_INVALID");

  const foldedAfterReview = await app.inject({
    method: "POST",
    url: "/api/v1/place-reports/" + report.body.data.report_id + "/flag",
    headers: writeHeaders(flagger, foldedKey),
    body: flagBody
  });
  assert.equal(foldedAfterReview.status, 200);
  assert.equal(foldedAfterReview.body.code, "REQUEST_DUPLICATE");
  assert.equal(foldedAfterReview.body.data.flag_id, flagged.body.data.flag_id);
  assert.equal(
    Array.from(app.store.placeReportFlags.values()).filter((row) => row.report_id === report.body.data.report_id).length,
    1,
    "a folded fresh key must remain protected by its receipt after review closes the original flag"
  );
});

test("W4-04 durability: reports, aggregate revisions, subscriptions, and idempotent receipts survive snapshot restart", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-place-status-"));
  const snapshotPath = path.join(tmpDir, "cloud-state.json");
  try {
    const app1 = createTestApp({ storeOptions: { snapshotPath } });
    const author = setupUser(app1, "author_durable");
    const key = nextKey("durable-report");
    const body = { metric: "ACCESS", state: "OPEN", observed_at: new Date(BASE_NOW - 60_000).toISOString(), report_kind: "OBSERVATION" };
    const created = await app1.inject({
      method: "POST",
      url: "/api/v1/places/" + ENCODED_PLACE + "/reports",
      headers: writeHeaders(author, key),
      body
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const subscription = await app1.inject({
      method: "POST",
      url: "/api/v1/places/status/subscriptions",
      headers: writeHeaders(author),
      body: { school_id: "haut", target: { type: "PLACE", place_ref: PLACE }, metrics: ["ACCESS"] }
    });
    assert.equal(subscription.status, 201, JSON.stringify(subscription.body));

    const app2 = createTestApp({ storeOptions: { snapshotPath } });
    const replay = await app2.inject({
      method: "POST",
      url: "/api/v1/places/" + ENCODED_PLACE + "/reports",
      headers: writeHeaders(author, key),
      body
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.code, "REQUEST_DUPLICATE");
    assert.equal(replay.body.data.report_id, created.body.data.report_id);
    const view = await queryOne(app2, author, "ACCESS");
    assert.equal(view.effective_state, "OPEN");
    assert.ok(view.aggregation_revision >= 1);
    const subs = await app2.inject({
      method: "GET",
      url: "/api/v1/places/status/subscriptions?school_id=haut",
      headers: author.auth
    });
    assert.equal(subs.status, 200);
    assert.equal(subs.body.data.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("W4-04 atomicity: pre-publish persistence failure rolls back report, aggregate, outbox, and idempotency receipt", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-place-atomic-"));
  const snapshotPath = path.join(tmpDir, "cloud-state.json");
  try {
    const app = createTestApp({ storeOptions: { snapshotPath } });
    const author = setupUser(app, "author_atomic");
    const key = nextKey("atomic-report");
    app.store._persistFaultInject = "tmp_write";
    const failed = await createReport(app, author, { state: "CROWDED", observed_at: new Date(BASE_NOW - 60_000).toISOString() }, { key });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error.code, "STORAGE_PERSISTENCE_FAILED");
    app.store._persistFaultInject = null;
    assert.equal(app.store.placeReports.size, 0, "pre-publish failure must roll back the report row");
    assert.equal(app.store.placeStatusAggregates.size, 0, "pre-publish failure must roll back aggregate revision");
    assert.equal(app.store.outboxEvents.filter((event) => event.event_type === "place.status.changed").length, 0);
    assert.equal(Array.from(app.store.idempotencyRecords.keys()).some((row) => row.endsWith("|" + key)), false);

    const retry = await createReport(app, author, { state: "CROWDED", observed_at: new Date(BASE_NOW - 60_000).toISOString() }, { key });
    assert.equal(retry.status, 201, JSON.stringify(retry.body), "same-key retry after a proven non-commit must be safe");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("W4-04 privacy: export/delete covers reports, flags, subscriptions, notes, reporter identity, and idempotency receipts", async () => {
  const app = createTestApp();
  const author = setupUser(app, "author_erasure_place");
  const flagger = setupUser(app, "flagger_erasure_place");
  const moderator = setupUser(app, "moderator_erasure_place", { admin: true });

  const report = await createReport(app, author, { note: "我坐在后排靠窗", observed_at: new Date(BASE_NOW - 60_000).toISOString() });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  const subscription = await app.inject({
    method: "POST",
    url: "/api/v1/places/status/subscriptions",
    headers: writeHeaders(author),
    body: { school_id: "haut", target: { type: "PLACE", place_ref: PLACE }, metrics: ["OCCUPANCY"] }
  });
  assert.equal(subscription.status, 201, JSON.stringify(subscription.body));
  const flag = await app.inject({
    method: "POST",
    url: "/api/v1/place-reports/" + report.body.data.report_id + "/flag",
    headers: writeHeaders(flagger),
    body: { reason: "OTHER", detail: "需要人工复核" }
  });
  assert.equal(flag.status, 201, JSON.stringify(flag.body));
  const review = await app.inject({
    method: "POST",
    url: "/api/v1/admin/place-report-flags/" + flag.body.data.flag_id + "/review",
    headers: writeHeaders(moderator),
    body: { action: "KEEP_VISIBLE", review_note: "证据不足，保留可见" }
  });
  assert.equal(review.status, 200, JSON.stringify(review.body));

  const exportBefore = await app.inject({ method: "POST", url: "/api/v1/me/data-export", headers: author.auth });
  assert.equal(exportBefore.status, 200);
  assert.equal(exportBefore.body.data.place_status_reports.length, 1);
  assert.equal(exportBefore.body.data.place_status_subscriptions.length, 1);
  for (const actor of [flagger, moderator]) {
    const actorExport = app.placeStatus.exportUserData(actor.user.id);
    assert.equal(actorExport.place_status_report_flags.length, 1);
    const exportedFlag = actorExport.place_status_report_flags[0];
    assert.equal(Object.hasOwn(exportedFlag, "flagger_cloud_user_id"), false);
    assert.equal(Object.hasOwn(exportedFlag, "reviewer_cloud_user_id"), false);
    assert.ok(!JSON.stringify(exportedFlag).includes(flagger.user.id), "flag export must not expose the other flagger account id");
    assert.ok(!JSON.stringify(exportedFlag).includes(moderator.user.id), "flag export must not expose the other reviewer account id");
  }

  const deleted = await app.inject({ method: "POST", url: "/api/v1/me/data-delete", headers: author.auth });
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
  assert.equal(deleted.body.data.place_status_purged.reports_detached, 1);
  assert.equal(deleted.body.data.place_status_purged.subscriptions_deleted, 1);
  assert.equal(deleted.body.data.place_status_purged.notes_redacted, 1);

  const exportAfter = app.placeStatus.exportUserData(author.user.id);
  assert.equal(exportAfter.place_status_reports.length, 0, "erased user must have zero exportable report rows");
  assert.equal(exportAfter.place_status_subscriptions.length, 0, "erased user must have zero exportable subscriptions");
  assert.equal(Array.from(app.store.placeStatusSubscriptions.values()).filter((row) => row.cloud_user_id === author.user.id).length, 0);
  const storedReport = app.store.placeReports.get(report.body.data.report_id);
  assert.equal(storedReport.cloud_user_id, PLACE_STATUS_DELETED_USER_TOMBSTONE);
  assert.notEqual(storedReport.reporter_key, author.user.id);
  assert.equal(storedReport.note, null);
  for (const key of app.store.idempotencyRecords.keys()) {
    assert.ok(!key.includes(author.user.id), "idempotency receipt keys must not retain erased user id: " + key);
  }

  // Independent flag/review rows remain auditable but never expose the erased reporter's public identity.
  const queue = await app.inject({
    method: "GET",
    url: "/api/v1/admin/place-report-flags?school_id=haut",
    headers: moderator.auth
  });
  assert.equal(queue.status, 200);
  assert.equal(queue.body.data.length, 1);
  assert.equal(Object.hasOwn(queue.body.data[0], "flagger_cloud_user_id"), false);
});

test("W4-04 TTL expiry: staggered deadlines publish ordered state transitions instead of skipping intermediate truth", async () => {
  const app = createTestApp();
  const alice = setupUser(app, "alice_staggered_ttl");
  const bob = setupUser(app, "bob_staggered_ttl");

  const quiet = await createReport(app, alice, {
    state: "QUIET",
    observed_at: new Date(BASE_NOW - 10 * 60_000).toISOString()
  });
  assert.equal(quiet.status, 201, JSON.stringify(quiet.body));
  const crowded = await createReport(app, bob, {
    state: "CROWDED",
    observed_at: new Date(BASE_NOW - 5 * 60_000).toISOString()
  });
  assert.equal(crowded.status, 201, JSON.stringify(crowded.body));
  const initial = await queryOne(app, alice, "OCCUPANCY", BASE_NOW);
  assert.equal(initial.effective_state, "CONTESTED");

  const finalView = await queryOne(app, alice, "OCCUPANCY", BASE_NOW + 26 * 60_000);
  assert.equal(finalView.effective_state, "UNKNOWN");
  assert.equal(finalView.unknown_reason, "ALL_EXPIRED");
  const ttlEvents = app.store.outboxEvents
    .filter((event) => event.event_type === "place.status.changed" && event.payload_json.trigger_type === "TTL_EXPIRED")
    .map((event) => event.payload_json);
  assert.equal(ttlEvents.length, 2, JSON.stringify(ttlEvents, null, 2));
  assert.deepEqual(
    ttlEvents.map((payload) => [payload.previous_effective_state, payload.effective_state]),
    [["CONTESTED", "CROWDED"], ["CROWDED", "UNKNOWN"]]
  );
  assert.deepEqual(
    ttlEvents.map((payload) => payload.trigger_report_id),
    [quiet.body.data.report_id, crowded.body.data.report_id]
  );
  assert.equal(ttlEvents[0].expires_at, new Date(BASE_NOW + 25 * 60_000).toISOString());
  assert.equal(ttlEvents[1].expires_at, null);
  for (const payload of ttlEvents) {
    assert.equal(payload.occurred_at, new Date(BASE_NOW + 26 * 60_000).toISOString(), "lazy expiry publication time is the sweep time");
    assert.equal(payload.official_realtime_status, false);
  }
});

test("W4-04 TTL expiry: simultaneous deadlines collapse to one aggregate transition", async () => {
  const app = createTestApp();
  const alice = setupUser(app, "alice_simultaneous_ttl");
  const bob = setupUser(app, "bob_simultaneous_ttl");
  const observed = new Date(BASE_NOW - 10 * 60_000).toISOString();

  const quiet = await createReport(app, alice, { state: "QUIET", observed_at: observed });
  assert.equal(quiet.status, 201, JSON.stringify(quiet.body));
  const crowded = await createReport(app, bob, { state: "CROWDED", observed_at: observed });
  assert.equal(crowded.status, 201, JSON.stringify(crowded.body));
  assert.equal((await queryOne(app, alice, "OCCUPANCY", BASE_NOW)).effective_state, "CONTESTED");

  const finalView = await queryOne(app, alice, "OCCUPANCY", BASE_NOW + 21 * 60_000);
  assert.equal(finalView.effective_state, "UNKNOWN");
  const ttlEvents = app.store.outboxEvents
    .filter((event) => event.event_type === "place.status.changed" && event.payload_json.trigger_type === "TTL_EXPIRED")
    .map((event) => event.payload_json);
  assert.equal(ttlEvents.length, 1, "same-deadline reports expire as one grouped recomputation, not duplicate contradictory alerts");
  assert.equal(ttlEvents[0].previous_effective_state, "CONTESTED");
  assert.equal(ttlEvents[0].effective_state, "UNKNOWN");
  assert.ok([quiet.body.data.report_id, crowded.body.data.report_id].includes(ttlEvents[0].trigger_report_id));
  assert.equal(ttlEvents[0].expires_at, null);
});

test("W4-04 subscription fan-out: lazy expiry alerts respect the subscription start time", async () => {
  const app = createTestApp();
  const alice = setupUser(app, "alice_expiry_subscription_time");
  const bob = setupUser(app, "bob_expiry_subscription_time");
  const middleSubscriber = setupUser(app, "subscriber_between_expiries");
  const lateSubscriber = setupUser(app, "subscriber_after_expiries");

  const quiet = await createReport(app, alice, {
    state: "QUIET",
    observed_at: new Date(BASE_NOW - 10 * 60_000).toISOString()
  });
  assert.equal(quiet.status, 201, JSON.stringify(quiet.body));
  const crowded = await createReport(app, bob, {
    state: "CROWDED",
    observed_at: new Date(BASE_NOW - 5 * 60_000).toISOString()
  });
  assert.equal(crowded.status, 201, JSON.stringify(crowded.body));

  for (const [subscriber, subscribedAt] of [
    [middleSubscriber, BASE_NOW + 22 * 60_000],
    [lateSubscriber, BASE_NOW + 26 * 60_000]
  ]) {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/places/status/subscriptions",
      headers: writeHeaders(subscriber),
      body: { school_id: "haut", target: { type: "PLACE", place_ref: PLACE }, metrics: ["OCCUPANCY"] },
      nowMs: subscribedAt
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }

  const sweepMs = BASE_NOW + 27 * 60_000;
  const finalView = await queryOne(app, alice, "OCCUPANCY", sweepMs);
  assert.equal(finalView.effective_state, "UNKNOWN");
  const ttlEvents = app.store.outboxEvents
    .filter((event) => event.event_type === "place.status.changed" && event.payload_json.trigger_type === "TTL_EXPIRED")
    .map((event) => event.payload_json);
  assert.equal(ttlEvents.length, 2, "ordered expiry facts must remain in the outbox even when inbox fan-out is filtered");
  for (const payload of ttlEvents) assert.equal(payload.occurred_at, new Date(sweepMs).toISOString());

  const notificationsFor = (user) => Array.from(app.store.notifications.values())
    .filter((row) => row.cloud_user_id === user.user.id && row.category === "place_status");
  const middleInbox = notificationsFor(middleSubscriber);
  assert.equal(middleInbox.length, 1, "a subscriber present for the second deadline receives only that later transition");
  assert.match(middleInbox[0].body, /变为 UNKNOWN/);
  assert.equal(middleInbox[0].created_at, new Date(sweepMs).toISOString(), "inbox delivery keeps the lazy publication timestamp");
  assert.equal(notificationsFor(lateSubscriber).length, 0, "a subscriber created after both deadlines must not receive already-ended intermediate states");
});

test("W4-04 subscription fan-out: exact-place type filters and revoked bindings suppress new alerts", async () => {
  const app = createTestApp();
  const filteredSubscriber = setupUser(app, "subscriber_type_filtered");
  const activeSubscriber = setupUser(app, "subscriber_binding_revoked");
  const author = setupUser(app, "author_subscription_scope");

  for (const [subscriber, target] of [
    [filteredSubscriber, { type: "PLACE", place_ref: PLACE, place_types: ["facility"] }],
    [activeSubscriber, { type: "PLACE", place_ref: PLACE }]
  ]) {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/places/status/subscriptions",
      headers: writeHeaders(subscriber),
      body: { school_id: "haut", target, metrics: ["OCCUPANCY", "ACCESS"] }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }

  const occupancy = await createReport(app, author, {
    metric: "OCCUPANCY",
    state: "CROWDED",
    observed_at: new Date(BASE_NOW - 60_000).toISOString()
  });
  assert.equal(occupancy.status, 201, JSON.stringify(occupancy.body));
  const notificationsFor = (user) => Array.from(app.store.notifications.values())
    .filter((row) => row.cloud_user_id === user.user.id && row.category === "place_status");
  assert.equal(notificationsFor(filteredSubscriber).length, 0, "room event must not match a facility-only exact-place filter");
  assert.equal(notificationsFor(activeSubscriber).length, 1);

  const binding = Array.from(app.store.schoolBindings.values())
    .find((row) => row.cloud_user_id === activeSubscriber.user.id && row.school_id === "haut");
  assert.ok(binding);
  binding.revoked_at = new Date(BASE_NOW + 60_000).toISOString();

  const access = await createReport(app, author, {
    metric: "ACCESS",
    state: "OPEN",
    observed_at: new Date(BASE_NOW - 60_000).toISOString()
  });
  assert.equal(access.status, 201, JSON.stringify(access.body));
  assert.ok(app.store.outboxEvents.some((event) =>
    event.event_type === "place.status.changed" && event.payload_json.metric === "ACCESS"
  ), "test must prove an ACCESS event was emitted before asserting fan-out suppression");
  assert.equal(notificationsFor(activeSubscriber).length, 1, "revoked school binding must stop new subscription alerts");
  assert.equal(notificationsFor(filteredSubscriber).length, 0);
});

test("W4-04 moderation authorization: read-only security auditor may inspect but cannot exclude reports", async () => {
  const app = createTestApp();
  const author = setupUser(app, "author_auditor_scope");
  const flagger = setupUser(app, "flagger_auditor_scope");
  const auditor = setupUser(app, "security_auditor_scope");
  app.store.setUserRoles(auditor.user.id, ["SECURITY_AUDITOR"]);

  const report = await createReport(app, author, { state: "CROWDED", observed_at: new Date(BASE_NOW - 60_000).toISOString() });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  const flag = await app.inject({
    method: "POST",
    url: "/api/v1/place-reports/" + report.body.data.report_id + "/flag",
    headers: writeHeaders(flagger),
    body: { reason: "INCORRECT", detail: "现场情况需要复核" }
  });
  assert.equal(flag.status, 201, JSON.stringify(flag.body));

  const queue = await app.inject({
    method: "GET",
    url: "/api/v1/admin/place-report-flags?school_id=haut&status=OPEN",
    headers: auditor.auth
  });
  assert.equal(queue.status, 200, JSON.stringify(queue.body));
  assert.equal(queue.body.data.length, 1);

  const review = await app.inject({
    method: "POST",
    url: "/api/v1/admin/place-report-flags/" + flag.body.data.flag_id + "/review",
    headers: writeHeaders(auditor),
    body: { action: "EXCLUDE_INCORRECT", review_note: "只读审计员不应能执行排除" }
  });
  assert.equal(review.status, 403);
  assert.equal(review.body.error.code, "PLACE_STATUS_PERMISSION_DENIED");
  assert.equal(app.store.placeReports.get(report.body.data.report_id).aggregation_eligible, true);
});

test("W4-04 moderation expiry attribution: overdue TTL is swept before exclusion so review does not absorb expiry", async () => {
  const app = createTestApp();
  const author = setupUser(app, "author_moderation_expiry");
  const flagger = setupUser(app, "flagger_moderation_expiry");
  const moderator = setupUser(app, "moderator_moderation_expiry", { admin: true });

  const report = await createReport(app, author, {
    state: "CROWDED",
    observed_at: new Date(BASE_NOW - 25 * 60_000).toISOString()
  });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  const flag = await app.inject({
    method: "POST",
    url: "/api/v1/place-reports/" + report.body.data.report_id + "/flag",
    headers: writeHeaders(flagger),
    body: { reason: "INCORRECT", detail: "过期边界需要复核" }
  });
  assert.equal(flag.status, 201, JSON.stringify(flag.body));

  const review = await app.inject({
    method: "POST",
    url: "/api/v1/admin/place-report-flags/" + flag.body.data.flag_id + "/review",
    headers: writeHeaders(moderator),
    body: { action: "EXCLUDE_INCORRECT", review_note: "复核时上报已经超过 TTL" },
    nowMs: BASE_NOW + 6 * 60_000
  });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.equal(review.body.data.status_view.effective_state, "UNKNOWN");

  const changed = app.store.outboxEvents
    .filter((event) => event.event_type === "place.status.changed")
    .map((event) => event.payload_json);
  const ttlEvents = changed.filter((payload) => payload.trigger_type === "TTL_EXPIRED");
  const moderationEvents = changed.filter((payload) => payload.trigger_type === "MODERATION_REVIEW");
  assert.equal(ttlEvents.length, 1);
  assert.equal(ttlEvents[0].previous_effective_state, "CROWDED");
  assert.equal(ttlEvents[0].effective_state, "UNKNOWN");
  assert.equal(ttlEvents[0].trigger_report_id, report.body.data.report_id);
  assert.equal(moderationEvents.length, 0, "exclusion after natural expiry must not be misattributed as the status-changing cause");
});

test("W4-04 erasure: flag detail is removed from foreign review receipt replay after flagger deletion", async () => {
  const app = createTestApp();
  const author = setupUser(app, "author_receipt_erasure");
  const flagger = setupUser(app, "flagger_receipt_erasure");
  const moderator = setupUser(app, "moderator_receipt_erasure", { admin: true });
  const detail = "需要复核的旗标细节-7421";

  const report = await createReport(app, author, { state: "CROWDED", observed_at: new Date(BASE_NOW - 60_000).toISOString() });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  const flag = await app.inject({
    method: "POST",
    url: "/api/v1/place-reports/" + report.body.data.report_id + "/flag",
    headers: writeHeaders(flagger),
    body: { reason: "OTHER", detail }
  });
  assert.equal(flag.status, 201, JSON.stringify(flag.body));
  const reviewKey = nextKey("review-receipt-erasure");
  const reviewBody = { action: "KEEP_VISIBLE", review_note: "证据不足，保留可见" };
  const reviewed = await app.inject({
    method: "POST",
    url: "/api/v1/admin/place-report-flags/" + flag.body.data.flag_id + "/review",
    headers: writeHeaders(moderator, reviewKey),
    body: reviewBody
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.data.flag.detail, detail);

  const deleted = await app.inject({ method: "POST", url: "/api/v1/me/data-delete", headers: flagger.auth });
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
  assert.equal(deleted.body.data.place_status_purged.flags_detached, 1);
  assert.ok(
    deleted.body.data.place_status_purged.idempotency_receipt_flag_details_redacted >= 1,
    JSON.stringify(deleted.body.data.place_status_purged)
  );

  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/admin/place-report-flags/" + flag.body.data.flag_id + "/review",
    headers: writeHeaders(moderator, reviewKey),
    body: reviewBody
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.code, "REQUEST_DUPLICATE");
  assert.equal(replay.body.data.flag.detail, null, "review receipt replay must not resurrect erased flag detail");
  assert.equal(app.store.placeReportFlags.get(flag.body.data.flag_id).detail, null);
  assert.ok(!JSON.stringify(Array.from(app.store.idempotencyRecords.values())).includes(detail), "no retained receipt may contain erased flag detail");
});
