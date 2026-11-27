import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { AVAILABILITY_DELETED_USER_TOMBSTONE } from "../packages/availability/src/index.mjs";

const BASE_NOW = Date.parse("2026-12-01T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
let keySeq = 0;
let userSeq = 0;

function nextKey(prefix) {
  keySeq += 1;
  return prefix + "-" + keySeq + "-12345678";
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function createTestApp() {
  return createCampusCloudApp({ requireAdminAccess: false });
}

function setupUser(app, label, { schoolId = "haut", bind = true, nowMs = BASE_NOW } = {}) {
  const user = app.store.findOrCreateCloudUser({
    issuer: app.identity.expectedIssuer,
    subject: "sub_" + label + "_" + crypto.randomUUID().slice(0, 8),
    username: label,
    displayName: label
  });
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

async function createStudyGroup(app, owner, nowMs = BASE_NOW, overrides = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/groups",
    headers: { ...owner.auth, "idempotency-key": nextKey("w402-create-group") },
    body: {
      school_id: "haut",
      type: "study",
      name: "共同空闲测试组",
      description: "W4-02 availability/polls",
      ...overrides
    },
    nowMs
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function createInvite(app, owner, groupId, { maxUses = 5, nowMs = BASE_NOW } = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/groups/" + groupId + "/invites",
    headers: { ...owner.auth, "idempotency-key": nextKey("w402-create-invite") },
    body: { expires_at: iso(nowMs + 24 * HOUR), max_uses: maxUses, label: "共同空闲" },
    nowMs
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function acceptInvite(app, user, code, nowMs = BASE_NOW) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/group-invites/" + code + "/accept",
    headers: { ...user.auth, "idempotency-key": nextKey("w402-accept-invite") },
    nowMs
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

function memberRow(app, groupId, cloudUserId) {
  const row = Array.from(app.store.groupMembers.values()).find(
    (member) => member.group_id === groupId && member.cloud_user_id === cloudUserId && member.status === "ACTIVE"
  );
  assert.ok(row, "expected active membership row");
  return row;
}

async function putAvailability(app, user, groupId, blocks, { ttlSeconds = 7200, nowMs = BASE_NOW, key = nextKey("w402-put-availability") } = {}) {
  return app.inject({
    method: "PUT",
    url: "/api/v1/groups/" + groupId + "/availability/me",
    headers: { ...user.auth, "idempotency-key": key },
    body: { blocks, ttl_seconds: ttlSeconds },
    nowMs
  });
}

async function queryAvailability(app, user, groupId, body, { nowMs = BASE_NOW, key = nextKey("w402-query-availability") } = {}) {
  return app.inject({
    method: "POST",
    url: "/api/v1/groups/" + groupId + "/availability/query",
    headers: { ...user.auth, "idempotency-key": key },
    body,
    nowMs
  });
}

async function createPoll(app, user, groupId, body, { nowMs = BASE_NOW, key = nextKey("w402-create-poll") } = {}) {
  return app.inject({
    method: "POST",
    url: "/api/v1/groups/" + groupId + "/polls",
    headers: { ...user.auth, "idempotency-key": key },
    body,
    nowMs
  });
}

function pollBodies(startMs) {
  return {
    title: "期末复习碰面",
    options: [
      { start_at: iso(startMs), end_at: iso(startMs + 60 * 60_000) },
      { start_at: iso(startMs + 2 * HOUR), end_at: iso(startMs + 3 * HOUR) }
    ],
    voting_deadline_at: iso(startMs - 30 * 60_000)
  };
}

test("W4-02 availability PUT: strict time-block-only validation, normalization, durable replay, and event minimization", async () => {
  const app = createTestApp();
  const owner = setupUser(app, "w402_owner_put");
  const group = await createStudyGroup(app, owner);
  const ownerMember = memberRow(app, group.group_id, owner.user.id);

  const missingKey = await app.inject({
    method: "PUT",
    url: "/api/v1/groups/" + group.group_id + "/availability/me",
    headers: owner.auth,
    body: { blocks: [], ttl_seconds: 1800 },
    nowMs: BASE_NOW
  });
  assert.equal(missingKey.status, 400);

  const invalidBodies = [
    { blocks: [{ start_at: iso(BASE_NOW + 15 * 60_000), end_at: iso(BASE_NOW + 60 * 60_000) }], ttl_seconds: 1800 },
    { blocks: [{ start_at: iso(BASE_NOW), end_at: iso(BASE_NOW + 45 * 60_000) }], ttl_seconds: 1800 },
    {
      blocks: [
        { start_at: iso(BASE_NOW), end_at: iso(BASE_NOW + HOUR) },
        { start_at: iso(BASE_NOW + 30 * 60_000), end_at: iso(BASE_NOW + 2 * HOUR) }
      ],
      ttl_seconds: 1800
    },
    { blocks: [{ start_at: iso(BASE_NOW), end_at: iso(BASE_NOW + HOUR), title: "高数课" }], ttl_seconds: 1800 },
    { blocks: [], ttl_seconds: 1799 },
    { blocks: [], ttl_seconds: 7776001 }
  ];
  for (const [index, body] of invalidBodies.entries()) {
    const response = await putAvailability(app, owner, group.group_id, body.blocks, {
      ttlSeconds: body.ttl_seconds,
      key: nextKey("w402-invalid-" + index)
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, "AVAILABILITY_BLOCK_INVALID");
  }

  const putKey = nextKey("w402-put-replay");
  const inputBlocks = [
    { start_at: iso(BASE_NOW + 2 * HOUR), end_at: iso(BASE_NOW + 3 * HOUR) },
    { start_at: iso(BASE_NOW + 30 * 60_000), end_at: iso(BASE_NOW + HOUR) }
  ];
  const put = await putAvailability(app, owner, group.group_id, inputBlocks, { key: putKey, ttlSeconds: 7200 });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.code, "GROUP_AVAILABILITY_REPLACED");
  assert.equal(put.body.data.member_id, ownerMember.id);
  assert.equal(put.body.data.sharing_level, "BUSY_BLOCKS_30MIN");
  assert.equal(put.body.data.block_count, 2);
  assert.deepEqual(
    put.body.data.blocks,
    [
      { start_at: iso(BASE_NOW + 30 * 60_000), end_at: iso(BASE_NOW + HOUR) },
      { start_at: iso(BASE_NOW + 2 * HOUR), end_at: iso(BASE_NOW + 3 * HOUR) }
    ],
    "server stores and returns only normalized start/end time blocks"
  );
  assert.equal(put.body.data.expires_at, iso(BASE_NOW + 2 * HOUR));
  assert.equal(app.store.groupMembers.get(ownerMember.id).sharing_level, "BUSY_BLOCKS_30MIN");
  assert.equal(app.store.busyBlocks.size, 2);
  for (const row of app.store.busyBlocks.values()) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ["created_at", "end_at", "group_id", "id", "member_id", "school_id", "start_at"].sort(),
      "busy block rows must not carry title, reason, location, notes, or free-form payload"
    );
  }

  const shareRevision = app.store.availabilityShares.get(ownerMember.id).revision;
  const updatedEventsBefore = app.store.outboxEvents.filter((event) => event.event_type === "group.availability.updated").length;
  const replay = await putAvailability(app, owner, group.group_id, inputBlocks, { key: putKey, ttlSeconds: 7200 });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.code, "REQUEST_DUPLICATE");
  assert.equal(replay.body.data.member_id, ownerMember.id);
  assert.equal(app.store.availabilityShares.get(ownerMember.id).revision, shareRevision);
  assert.equal(app.store.busyBlocks.size, 2);
  assert.equal(
    app.store.outboxEvents.filter((event) => event.event_type === "group.availability.updated").length,
    updatedEventsBefore,
    "durable replay must not duplicate availability revisions or outbox events"
  );

  const mismatch = await putAvailability(app, owner, group.group_id, [], { key: putKey, ttlSeconds: 7200 });
  assert.equal(mismatch.status, 409);

  const updated = app.store.outboxEvents.find((event) => event.event_type === "group.availability.updated");
  assert.ok(updated, "expected group.availability.updated outbox event");
  assert.equal(updated.payload_json.reason, "SHARE_REPLACED");
  assert.equal(updated.payload_json.block_count, 2);
  assert.equal(updated.payload_json.sharing_level, "BUSY_BLOCKS_30MIN");
  assert.equal(Object.hasOwn(updated.payload_json, "blocks"), false, "event payload must never embed raw blocks");
});

test("W4-02 availability query: UNKNOWN never counts as free, raw blocks stay hidden, TTL expiry deletes shares", async () => {
  const app = createTestApp();
  const owner = setupUser(app, "w402_owner_query");
  const member = setupUser(app, "w402_member_query");
  const unknown = setupUser(app, "w402_unknown_query");
  const group = await createStudyGroup(app, owner);
  const invite = await createInvite(app, owner, group.group_id, { maxUses: 2 });
  const acceptedMember = await acceptInvite(app, member, invite.code);
  const acceptedUnknown = await acceptInvite(app, unknown, invite.code);
  assert.ok(acceptedMember.member_id);
  assert.ok(acceptedUnknown.member_id);
  const ownerMember = memberRow(app, group.group_id, owner.user.id);
  const memberMember = memberRow(app, group.group_id, member.user.id);
  const unknownMember = memberRow(app, group.group_id, unknown.user.id);

  assert.equal((await putAvailability(app, owner, group.group_id, [], { ttlSeconds: 1800 })).status, 200);
  assert.equal(
    (await putAvailability(app, member, group.group_id, [
      { start_at: iso(BASE_NOW + 30 * 60_000), end_at: iso(BASE_NOW + 90 * 60_000) }
    ], { ttlSeconds: 1800 })).status,
    200
  );

  const queryBody = {
    window_start_at: iso(BASE_NOW),
    window_end_at: iso(BASE_NOW + 2 * HOUR),
    duration_minutes: 30,
    min_attendees: 2,
    member_ids: [ownerMember.id, memberMember.id]
  };
  const queryKey = nextKey("w402-query-replay");
  const query = await queryAvailability(app, owner, group.group_id, queryBody, { key: queryKey });
  assert.equal(query.status, 200, JSON.stringify(query.body));
  assert.equal(query.body.code, "GROUP_AVAILABILITY_QUERIED");
  assert.deepEqual(
    query.body.data.candidates.map((candidate) => candidate.start_at),
    [iso(BASE_NOW), iso(BASE_NOW + 90 * 60_000)],
    "only windows in which both explicitly sharing members are free may be candidates"
  );
  for (const candidate of query.body.data.candidates) {
    assert.equal(candidate.available_member_count, 2);
    assert.equal(candidate.busy_member_count, 0);
    assert.equal(candidate.unknown_member_count, 0);
    for (const row of candidate.member_results) {
      assert.deepEqual(Object.keys(row).sort(), ["member_id", "sharing_level", "status"].sort());
      assert.equal(row.status, "AVAILABLE");
    }
  }
  assert.equal(JSON.stringify(query.body.data).includes('"blocks"'), false, "query response must not expose raw busy blocks");

  const replay = await queryAvailability(app, owner, group.group_id, queryBody, { key: queryKey });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.code, "REQUEST_DUPLICATE");
  assert.deepEqual(replay.body.data, query.body.data);

  const allMembersQuery = await queryAvailability(app, owner, group.group_id, {
    window_start_at: iso(BASE_NOW),
    window_end_at: iso(BASE_NOW + 2 * HOUR),
    duration_minutes: 30,
    min_attendees: 3
  });
  assert.equal(allMembersQuery.status, 200);
  assert.equal(allMembersQuery.body.data.candidates.length, 0, "the non-sharing third member is UNKNOWN and never counts as free");

  const subsetUnknownQuery = await queryAvailability(app, owner, group.group_id, {
    window_start_at: iso(BASE_NOW),
    window_end_at: iso(BASE_NOW + 30 * 60_000),
    duration_minutes: 30,
    min_attendees: 2,
    member_ids: [ownerMember.id, unknownMember.id]
  });
  assert.equal(subsetUnknownQuery.status, 200);
  assert.equal(subsetUnknownQuery.body.data.candidates.length, 0, "UNKNOWN in an explicit member subset is not AVAILABLE");

  const invalidGranularity = await queryAvailability(app, owner, group.group_id, {
    ...queryBody,
    granularity_minutes: 15
  });
  assert.equal(invalidGranularity.status, 400);
  assert.equal(invalidGranularity.body.error.code, "AVAILABILITY_QUERY_INVALID");
  const invalidMember = await queryAvailability(app, owner, group.group_id, {
    ...queryBody,
    member_ids: [ownerMember.id, crypto.randomUUID()]
  });
  assert.equal(invalidMember.status, 400);
  assert.equal(invalidMember.body.error.code, "AVAILABILITY_QUERY_INVALID");

  const expiredQuery = await queryAvailability(app, owner, group.group_id, queryBody, {
    nowMs: BASE_NOW + 30 * 60_000,
    key: nextKey("w402-query-expired")
  });
  assert.equal(expiredQuery.status, 200);
  assert.equal(expiredQuery.body.data.candidates.length, 0, "TTL expiry at expires_at makes members UNKNOWN immediately");
  assert.equal(app.store.busyBlocks.size, 0, "expired raw blocks are deleted rather than merely hidden");
  for (const memberId of [ownerMember.id, memberMember.id]) {
    assert.equal(app.store.availabilityShares.get(memberId).status, "EXPIRED");
    assert.equal(app.store.groupMembers.get(memberId).sharing_level, "NONE");
  }
  const expiredEvents = app.store.outboxEvents.filter(
    (event) => event.event_type === "group.availability.updated" && event.payload_json.reason === "TTL_EXPIRED"
  );
  assert.equal(expiredEvents.length, 2);
  assert.ok(expiredEvents.every((event) => event.payload_json.block_count === 0 && Object.hasOwn(event.payload_json, "blocks") === false));
});

test("W4-02 withdrawal: self-service NONE, DELETE endpoint, member exit, and group archive erase raw blocks immediately", async () => {
  const app = createTestApp();
  const owner = setupUser(app, "w402_owner_withdraw");
  const member = setupUser(app, "w402_member_withdraw");
  const group = await createStudyGroup(app, owner);
  const invite = await createInvite(app, owner, group.group_id, { maxUses: 1 });
  await acceptInvite(app, member, invite.code);
  const memberRowBefore = memberRow(app, group.group_id, member.user.id);
  const busy = [{ start_at: iso(BASE_NOW + HOUR), end_at: iso(BASE_NOW + 2 * HOUR) }];

  assert.equal((await putAvailability(app, member, group.group_id, busy)).status, 200);
  assert.equal(app.store.busyBlocks.size, 1);
  const patchNone = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + group.group_id + "/members/" + memberRowBefore.id,
    headers: { ...member.auth, "idempotency-key": nextKey("w402-patch-none") },
    body: { sharing_level: "NONE" },
    nowMs: BASE_NOW + 1000
  });
  assert.equal(patchNone.status, 200, JSON.stringify(patchNone.body));
  assert.equal(patchNone.body.data.sharing_level, "NONE");
  assert.equal(app.store.busyBlocks.size, 0, "self-service sharing_level=NONE deletes raw blocks immediately");
  assert.equal(app.store.availabilityShares.get(memberRowBefore.id).status, "WITHDRAWN");

  assert.equal((await putAvailability(app, member, group.group_id, busy, { nowMs: BASE_NOW + 2000 })).status, 200);
  assert.equal(app.store.busyBlocks.size, 1);
  const deleteShare = await app.inject({
    method: "DELETE",
    url: "/api/v1/groups/" + group.group_id + "/availability/me",
    headers: { ...member.auth, "idempotency-key": nextKey("w402-delete-share") },
    nowMs: BASE_NOW + 3000
  });
  assert.equal(deleteShare.status, 200, JSON.stringify(deleteShare.body));
  assert.equal(deleteShare.body.data.sharing_level, "NONE");
  assert.equal(app.store.busyBlocks.size, 0, "DELETE availability removes every raw block regardless of TTL");
  assert.equal(app.store.availabilityShares.get(memberRowBefore.id).status, "WITHDRAWN");

  assert.equal((await putAvailability(app, member, group.group_id, busy, { nowMs: BASE_NOW + 4000 })).status, 200);
  assert.equal(app.store.busyBlocks.size, 1);
  const leave = await app.inject({
    method: "DELETE",
    url: "/api/v1/groups/" + group.group_id + "/members/" + memberRowBefore.id,
    headers: { ...member.auth, "idempotency-key": nextKey("w402-leave-group") },
    nowMs: BASE_NOW + 5000
  });
  assert.equal(leave.status, 200, JSON.stringify(leave.body));
  assert.equal(app.store.busyBlocks.size, 0, "member exit withdraws and deletes raw blocks immediately");
  assert.equal(app.store.availabilityShares.get(memberRowBefore.id).status, "WITHDRAWN");

  const archiveInvite = await createInvite(app, owner, group.group_id, { maxUses: 1, nowMs: BASE_NOW + 6000 });
  const secondMember = setupUser(app, "w402_member_archive");
  await acceptInvite(app, secondMember, archiveInvite.code, BASE_NOW + 6000);
  const secondRow = memberRow(app, group.group_id, secondMember.user.id);
  assert.equal((await putAvailability(app, secondMember, group.group_id, busy, { nowMs: BASE_NOW + 7000 })).status, 200);
  assert.equal(app.store.busyBlocks.size, 1);
  const archive = await app.inject({
    method: "DELETE",
    url: "/api/v1/groups/" + group.group_id,
    headers: { ...owner.auth, "idempotency-key": nextKey("w402-archive-group") },
    nowMs: BASE_NOW + 8000
  });
  assert.equal(archive.status, 200, JSON.stringify(archive.body));
  assert.equal(app.store.busyBlocks.size, 0, "group archival deletes member raw blocks in the same commit");
  assert.equal(app.store.availabilityShares.get(secondRow.id).status, "WITHDRAWN");
});

test("W4-02 polls: create/vote/confirm lifecycle, terminal idempotency, permissions, and deadline closure", async () => {
  const app = createTestApp();
  const owner = setupUser(app, "w402_owner_poll");
  const member = setupUser(app, "w402_member_poll");
  const group = await createStudyGroup(app, owner);
  const invite = await createInvite(app, owner, group.group_id, { maxUses: 1 });
  await acceptInvite(app, member, invite.code);
  memberRow(app, group.group_id, owner.user.id);
  const memberRowInGroup = memberRow(app, group.group_id, member.user.id);

  const invalid = await createPoll(app, owner, group.group_id, {
    title: "非法选项",
    options: [
      { start_at: iso(BASE_NOW + 2 * HOUR + 15 * 60_000), end_at: iso(BASE_NOW + 3 * HOUR) },
      { start_at: iso(BASE_NOW + 4 * HOUR), end_at: iso(BASE_NOW + 5 * HOUR) }
    ],
    voting_deadline_at: iso(BASE_NOW + HOUR)
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "POLL_OPTION_INVALID");

  const createKey = nextKey("w402-create-poll-replay");
  const body = pollBodies(BASE_NOW + 2 * HOUR);
  const created = await createPoll(app, owner, group.group_id, body, { key: createKey });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.status, "OPEN");
  assert.equal(created.body.data.options.length, 2);
  assert.ok(created.body.data.options.every((option) => option.vote_count === 0));
  assert.equal(created.headers.Location, "/api/v1/polls/" + created.body.data.poll_id);
  const pollId = created.body.data.poll_id;
  const firstOption = created.body.data.options[0].option_id;
  const secondOption = created.body.data.options[1].option_id;

  const createReplay = await createPoll(app, owner, group.group_id, body, { key: createKey });
  assert.equal(createReplay.status, 200);
  assert.equal(createReplay.body.code, "REQUEST_DUPLICATE");
  assert.equal(createReplay.body.data.poll_id, pollId);
  assert.equal(app.store.meetingPolls.size, 1);
  assert.equal(app.store.pollOptions.size, 2);

  const voteKey = nextKey("w402-vote-first");
  const vote1 = await app.inject({
    method: "POST",
    url: "/api/v1/polls/" + pollId + "/votes",
    headers: { ...member.auth, "idempotency-key": voteKey },
    body: { option_id: firstOption },
    nowMs: BASE_NOW + 1000
  });
  assert.equal(vote1.status, 200, JSON.stringify(vote1.body));
  const voteId = vote1.body.data.vote.vote_id;
  assert.equal(vote1.body.data.poll.my_vote_option_id, firstOption);
  const voteReplay = await app.inject({
    method: "POST",
    url: "/api/v1/polls/" + pollId + "/votes",
    headers: { ...member.auth, "idempotency-key": voteKey },
    body: { option_id: firstOption },
    nowMs: BASE_NOW + 2000
  });
  assert.equal(voteReplay.status, 200);
  assert.equal(voteReplay.body.code, "REQUEST_DUPLICATE");
  assert.equal(app.store.pollVotes.size, 1);

  const voteChange = await app.inject({
    method: "POST",
    url: "/api/v1/polls/" + pollId + "/votes",
    headers: { ...member.auth, "idempotency-key": nextKey("w402-vote-change") },
    body: { option_id: secondOption },
    nowMs: BASE_NOW + 3000
  });
  assert.equal(voteChange.status, 200);
  assert.equal(voteChange.body.data.vote.vote_id, voteId, "changing a vote updates the single membership-period row");
  assert.equal(app.store.pollVotes.size, 1);
  const changedCounts = Object.fromEntries(voteChange.body.data.poll.options.map((option) => [option.option_id, option.vote_count]));
  assert.equal(changedCounts[firstOption], 0);
  assert.equal(changedCounts[secondOption], 1);

  const memberConfirm = await app.inject({
    method: "POST",
    url: "/api/v1/polls/" + pollId + "/confirm",
    headers: { ...member.auth, "idempotency-key": nextKey("w402-member-confirm-denied") },
    body: { option_id: secondOption },
    nowMs: BASE_NOW + 4000
  });
  assert.equal(memberConfirm.status, 403);
  assert.equal(memberConfirm.body.error.code, "POLL_PERMISSION_DENIED");

  const confirmKey = nextKey("w402-confirm-replay");
  const confirm = await app.inject({
    method: "POST",
    url: "/api/v1/polls/" + pollId + "/confirm",
    headers: { ...owner.auth, "idempotency-key": confirmKey },
    body: { option_id: secondOption },
    nowMs: BASE_NOW + 5000
  });
  assert.equal(confirm.status, 201, JSON.stringify(confirm.body));
  assert.equal(confirm.body.data.poll.status, "CONFIRMED");
  assert.equal(confirm.body.data.confirmed_event.option_id, secondOption);
  assert.equal(confirm.body.data.confirmed_event.start_at, iso(BASE_NOW + 4 * HOUR));
  assert.equal(app.store.confirmedGroupEvents.size, 1);
  const confirmedOutbox = app.store.outboxEvents.filter((event) => event.event_type === "group.event.confirmed");
  assert.equal(confirmedOutbox.length, 1);
  assert.match(confirmedOutbox[0].payload_json.event_key, /^dis:group:[0-9a-f-]{36}:event:[0-9a-f-]{36}:confirmed:v1$/);
  assert.equal(confirmedOutbox[0].payload_json.total_votes, 1);

  const confirmReplay = await app.inject({
    method: "POST",
    url: "/api/v1/polls/" + pollId + "/confirm",
    headers: { ...owner.auth, "idempotency-key": confirmKey },
    body: { option_id: secondOption },
    nowMs: BASE_NOW + 6000
  });
  assert.equal(confirmReplay.status, 200);
  assert.equal(confirmReplay.body.code, "REQUEST_DUPLICATE");
  assert.equal(app.store.confirmedGroupEvents.size, 1);
  assert.equal(app.store.outboxEvents.filter((event) => event.event_type === "group.event.confirmed").length, 1);

  const secondConfirm = await app.inject({
    method: "POST",
    url: "/api/v1/polls/" + pollId + "/confirm",
    headers: { ...owner.auth, "idempotency-key": nextKey("w402-second-confirm") },
    body: { option_id: secondOption },
    nowMs: BASE_NOW + 7000
  });
  assert.equal(secondConfirm.status, 409);
  assert.equal(secondConfirm.body.error.code, "POLL_ALREADY_CONFIRMED");

  const closedBody = pollBodies(BASE_NOW + 2 * HOUR);
  closedBody.voting_deadline_at = iso(BASE_NOW + 30 * 60_000);
  const closedPoll = await createPoll(app, owner, group.group_id, closedBody, { nowMs: BASE_NOW });
  assert.equal(closedPoll.status, 201);
  const closedVote = await app.inject({
    method: "POST",
    url: "/api/v1/polls/" + closedPoll.body.data.poll_id + "/votes",
    headers: { ...member.auth, "idempotency-key": nextKey("w402-closed-vote") },
    body: { option_id: closedPoll.body.data.options[0].option_id },
    nowMs: BASE_NOW + 30 * 60_000
  });
  assert.equal(closedVote.status, 409);
  assert.equal(closedVote.body.error.code, "POLL_VOTING_CLOSED");
  const closedDetail = await app.inject({
    method: "GET",
    url: "/api/v1/polls/" + closedPoll.body.data.poll_id,
    headers: member.auth,
    nowMs: BASE_NOW + 30 * 60_000
  });
  assert.equal(closedDetail.status, 200);
  assert.equal(closedDetail.body.data.status, "CLOSED");
  assert.equal(closedDetail.body.data.my_vote_option_id, null);
  assert.ok(memberRowInGroup.id);
});

test("W4-02 conflict detection: new busy overlap emits advisory conflict only and never reschedules confirmed events", async () => {
  const app = createTestApp();
  const owner = setupUser(app, "w402_owner_conflict");
  const member = setupUser(app, "w402_member_conflict");
  const group = await createStudyGroup(app, owner);
  const invite = await createInvite(app, owner, group.group_id, { maxUses: 1 });
  await acceptInvite(app, member, invite.code);
  const memberRowInGroup = memberRow(app, group.group_id, member.user.id);

  const created = await createPoll(app, owner, group.group_id, pollBodies(BASE_NOW + 2 * HOUR));
  assert.equal(created.status, 201);
  const pollId = created.body.data.poll_id;
  const option = created.body.data.options[0];
  const confirm = await app.inject({
    method: "POST",
    url: "/api/v1/polls/" + pollId + "/confirm",
    headers: { ...owner.auth, "idempotency-key": nextKey("w402-confirm-conflict") },
    body: { option_id: option.option_id },
    nowMs: BASE_NOW + 1000
  });
  assert.equal(confirm.status, 201);
  const confirmedEventId = confirm.body.data.confirmed_event.event_id;

  const overlapping = [{
    start_at: iso(BASE_NOW + 2 * HOUR + 30 * 60_000),
    end_at: iso(BASE_NOW + 3 * HOUR)
  }];
  const put = await putAvailability(app, member, group.group_id, overlapping, { nowMs: BASE_NOW + 2000 });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const conflicts = app.store.outboxEvents.filter((event) => event.event_type === "group.event.conflict_detected");
  assert.equal(conflicts.length, 1);
  const payload = conflicts[0].payload_json;
  assert.equal(payload.confirmed_event_id, confirmedEventId);
  assert.equal(payload.member_id, memberRowInGroup.id);
  assert.equal(payload.overlap_start_at, iso(BASE_NOW + 2 * HOUR + 30 * 60_000));
  assert.equal(payload.overlap_end_at, iso(BASE_NOW + 3 * HOUR));
  assert.equal(payload.automatic_rescheduling, false);
  const confirmed = app.store.confirmedGroupEvents.get(confirmedEventId);
  assert.equal(confirmed.start_at, iso(BASE_NOW + 2 * HOUR));
  assert.equal(confirmed.end_at, iso(BASE_NOW + 3 * HOUR));
  assert.equal(confirmed.status, "CONFIRMED", "conflict detection is advisory only and must not mutate the terminal event");
});

test("W4-02 erasure: export contains availability domain and data-delete removes blocks/votes, detaches group-owned polls, and scrubs receipts/events", async () => {
  const app = createTestApp();
  const owner = setupUser(app, "w402_owner_erasure");
  const member = setupUser(app, "w402_member_erasure");
  const group = await createStudyGroup(app, owner);
  const invite = await createInvite(app, owner, group.group_id, { maxUses: 1 });
  await acceptInvite(app, member, invite.code);
  const memberRowBeforeDelete = memberRow(app, group.group_id, member.user.id);

  assert.equal((await putAvailability(app, member, group.group_id, [
    { start_at: iso(BASE_NOW + HOUR), end_at: iso(BASE_NOW + 2 * HOUR) }
  ])).status, 200);
  const created = await createPoll(app, member, group.group_id, pollBodies(BASE_NOW + 2 * HOUR));
  assert.equal(created.status, 201);
  const vote = await app.inject({
    method: "POST",
    url: "/api/v1/polls/" + created.body.data.poll_id + "/votes",
    headers: { ...member.auth, "idempotency-key": nextKey("w402-erasure-vote") },
    body: { option_id: created.body.data.options[0].option_id },
    nowMs: BASE_NOW + 1000
  });
  assert.equal(vote.status, 200);

  const exported = await app.inject({
    method: "POST",
    url: "/api/v1/me/data-export",
    headers: member.auth,
    nowMs: BASE_NOW + 2000
  });
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.equal(exported.body.data.availability_shares.length, 1);
  assert.equal(exported.body.data.availability_busy_blocks.length, 1);
  assert.equal(exported.body.data.availability_polls.length, 1);
  assert.equal(exported.body.data.availability_poll_votes.length, 1);
  assert.equal(exported.body.data.availability_busy_blocks[0].start_at, iso(BASE_NOW + HOUR));

  const deleted = await app.inject({
    method: "POST",
    url: "/api/v1/me/data-delete",
    headers: member.auth,
    nowMs: BASE_NOW + 3000
  });
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
  const purged = deleted.body.data.availability_purged;
  assert.equal(purged.shares_deleted, 1);
  assert.equal(purged.busy_blocks_deleted, 1);
  assert.equal(purged.poll_votes_deleted, 1);
  assert.equal(purged.polls_detached, 1);
  assert.equal(app.store.availabilityShares.has(memberRowBeforeDelete.id), false);
  assert.equal(Array.from(app.store.busyBlocks.values()).some((row) => row.member_id === memberRowBeforeDelete.id), false);
  assert.equal(Array.from(app.store.pollVotes.values()).some((row) => row.member_id === memberRowBeforeDelete.id), false);
  assert.equal(app.store.meetingPolls.get(created.body.data.poll_id).created_by_member_id, AVAILABILITY_DELETED_USER_TOMBSTONE);
  for (const key of app.store.idempotencyRecords.keys()) {
    assert.equal(key.includes(member.user.id), false, "erased user id must not remain in availability idempotency keys");
  }
  for (const event of app.store.outboxEvents.filter((row) => ["group_availability", "group_event", "group_event_conflict"].includes(row.aggregate_type))) {
    assert.equal(JSON.stringify(event.payload_json).includes(member.user.id), false, "availability event payload must pseudonymize erased cloud user id");
  }
});

test("W4-02 durability: pre-publish failure rolls back availability commit and restart restores snapshot state", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-w402-availability-atomic-"));
  const snapshotPath = path.join(tmpDir, "cloud-state.json");
  try {
    const app = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    const owner = setupUser(app, "w402_owner_atomic");
    const group = await createStudyGroup(app, owner);
    const ownerMember = memberRow(app, group.group_id, owner.user.id);
    const key = nextKey("w402-atomic-put");
    const blocks = [{ start_at: iso(BASE_NOW + HOUR), end_at: iso(BASE_NOW + 2 * HOUR) }];

    app.store._persistFaultInject = "tmp_write";
    const failed = await putAvailability(app, owner, group.group_id, blocks, { key });
    assert.equal(failed.status, 503, JSON.stringify(failed.body));
    assert.equal(failed.body.error.code, "STORAGE_PERSISTENCE_FAILED");
    assert.equal(app.store.availabilityShares.has(ownerMember.id), false, "pre-publish failure must roll back share metadata");
    assert.equal(app.store.busyBlocks.size, 0, "pre-publish failure must roll back raw blocks");
    assert.equal(app.store.groupMembers.get(ownerMember.id).sharing_level, "NONE", "pre-publish failure must roll back sharing_level");
    assert.equal(
      app.store.outboxEvents.some((event) => event.event_type === "group.availability.updated"),
      false,
      "pre-publish failure must roll back the availability outbox event"
    );
    assert.equal(
      Array.from(app.store.idempotencyRecords.keys()).some((row) => row.startsWith("replaceMyGroupAvailability|" + owner.user.id + "|" + key)),
      false,
      "pre-publish failure must not retain an idempotency receipt"
    );

    app.store._persistFaultInject = null;
    const accepted = await putAvailability(app, owner, group.group_id, blocks, { key });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.code, "GROUP_AVAILABILITY_REPLACED", "same key retries as the first durable attempt after pre-publish rollback");
    assert.equal(app.store.busyBlocks.size, 1);
    const poll = await createPoll(app, owner, group.group_id, pollBodies(BASE_NOW + 2 * HOUR), { nowMs: BASE_NOW + 500 });
    assert.equal(poll.status, 201, JSON.stringify(poll.body));

    const restarted = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    assert.equal(restarted.store.availabilityShares.get(ownerMember.id).status, "ACTIVE", "share metadata survives restart");
    assert.equal(restarted.store.busyBlocks.size, 1, "quantized busy block survives restart");
    assert.equal(restarted.store.groupMembers.get(ownerMember.id).sharing_level, "BUSY_BLOCKS_30MIN");
    assert.equal(
      Array.from(restarted.store.busyBlocks.values())[0].start_at,
      iso(BASE_NOW + HOUR)
    );

    const commitProbe = {
      reservationPlans: [],
      reservationJobs: [],
      scheduleEvents: [],
      priceQuotes: [],
      idempotencyRecords: [],
      groups: Array.from(restarted.store.groups.entries()),
      groupMembers: Array.from(restarted.store.groupMembers.entries()),
      groupInvites: Array.from(restarted.store.groupInvites.entries()),
      availabilityShares: Array.from(restarted.store.availabilityShares.entries()),
      busyBlocks: Array.from(restarted.store.busyBlocks.entries()),
      meetingPolls: Array.from(restarted.store.meetingPolls.entries()),
      pollOptions: Array.from(restarted.store.pollOptions.entries()),
      pollVotes: Array.from(restarted.store.pollVotes.entries()),
      confirmedGroupEvents: Array.from(restarted.store.confirmedGroupEvents.entries()),
      campusGraphPlaces: [],
      placeReports: [],
      placeReportFlags: [],
      placeStatusSubscriptions: []
    };
    assert.doesNotThrow(() => restarted.store._validateCommitUnit(commitProbe), "valid availability/poll snapshot must pass invariant validation");

    const invalidTtl = structuredClone(commitProbe);
    invalidTtl.availabilityShares[0][1].ttl_seconds = 1799;
    assert.throws(() => restarted.store._validateCommitUnit(invalidTtl), /TTL/);

    const overlapping = structuredClone(commitProbe);
    const firstBlock = overlapping.busyBlocks[0][1];
    overlapping.busyBlocks.push([
      "corrupt-overlap",
      { ...firstBlock, id: "corrupt-overlap", start_at: iso(BASE_NOW + 90 * 60_000), end_at: iso(BASE_NOW + 150 * 60_000) }
    ]);
    assert.throws(() => restarted.store._validateCommitUnit(overlapping), /重叠/);

    const duplicateOption = structuredClone(commitProbe);
    const firstOption = duplicateOption.pollOptions[0][1];
    duplicateOption.pollOptions.push(["corrupt-option", { ...firstOption, id: "corrupt-option" }]);
    assert.throws(() => restarted.store._validateCommitUnit(duplicateOption), /重复时间窗/);

    const badTerminal = structuredClone(commitProbe);
    const terminalOption = badTerminal.pollOptions[0][1];
    badTerminal.confirmedGroupEvents.push([
      "corrupt-confirmed",
      {
        id: "corrupt-confirmed",
        poll_id: terminalOption.poll_id,
        option_id: terminalOption.id,
        group_id: group.group_id,
        school_id: "haut",
        start_at: terminalOption.start_at,
        end_at: terminalOption.end_at,
        status: "CONFIRMED",
        confirmed_by_member_id: ownerMember.id,
        confirmed_at: iso(BASE_NOW + 600)
      }
    ]);
    assert.throws(() => restarted.store._validateCommitUnit(badTerminal), /终态/);
    clearTimeout(restarted.store._snapshotFlushTimer);

    app.store._persistFaultInject = "dir_fsync";
    const unknown = await app.inject({
      method: "DELETE",
      url: "/api/v1/groups/" + group.group_id + "/availability/me",
      headers: { ...owner.auth, "idempotency-key": nextKey("w402-atomic-delete") },
      nowMs: BASE_NOW + 1000
    });
    assert.equal(unknown.status, 503, JSON.stringify(unknown.body));
    assert.equal(unknown.body.error.code, "STORAGE_COMMIT_UNKNOWN");
    assert.equal(app.store.availabilityShares.get(ownerMember.id).status, "WITHDRAWN", "post-publish unknown must not roll memory back");
    assert.equal(app.store.busyBlocks.size, 0, "post-publish unknown keeps the candidate erased state");
    clearTimeout(app.store._snapshotFlushTimer);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
