import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { COMMUNITY_DELETED_USER_TOMBSTONE } from "../packages/community/src/index.mjs";
import { CloudDatabaseStore } from "../packages/db/src/index.mjs";

const BASE_NOW = Date.parse("2026-11-27T10:00:00.000Z");
let keySeq = 0;
let userSeq = 0;

function nextKey(prefix) {
  keySeq += 1;
  return prefix + "-" + keySeq + "-12345678";
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
      student_no: "2024" + String(100000 + (++userSeq)),
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
    headers: { ...owner.auth, "idempotency-key": nextKey("create-group") },
    body: {
      school_id: "haut",
      type: "study",
      name: "操作系统互助组",
      description: "三十分钟粒度忙闲块",
      ...overrides
    },
    nowMs
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function createInvite(app, owner, groupId, { maxUses = 5, expiresAt = "2026-11-28T10:00:00.000Z", nowMs = BASE_NOW } = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/groups/" + groupId + "/invites",
    headers: { ...owner.auth, "idempotency-key": nextKey("create-invite") },
    body: { expires_at: expiresAt, max_uses: maxUses, label: "期末互助" },
    nowMs
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function acceptInvite(app, user, codeOrPayload, nowMs = BASE_NOW) {
  return app.inject({
    method: "POST",
    url: "/api/v1/group-invites/" + encodeURIComponent(codeOrPayload) + "/accept",
    headers: { ...user.auth, "idempotency-key": nextKey("accept-invite") },
    nowMs
  });
}

test("W4-01 groups: CRUD validation, school scope, durable idempotent replay, and pagination metadata", async () => {
  const app = createTestApp();
  const owner = setupUser(app, "owner_crud");
  const unbound = setupUser(app, "unbound_crud", { bind: false });
  const otherSchool = setupUser(app, "other_school", { schoolId: "other-university" });

  const missingKey = await app.inject({
    method: "POST",
    url: "/api/v1/groups",
    headers: owner.auth,
    body: { school_id: "haut", type: "study", name: "缺少幂等键" }
  });
  assert.equal(missingKey.status, 400);

  const noBinding = await app.inject({
    method: "POST",
    url: "/api/v1/groups",
    headers: { ...unbound.auth, "idempotency-key": nextKey("create-unbound") },
    body: { school_id: "haut", type: "study", name: "未绑定用户" }
  });
  assert.equal(noBinding.status, 409);
  assert.equal(noBinding.body.error.code, "CAMPUS_BINDING_REQUIRED");

  const createKey = nextKey("create-replay");
  const body = { school_id: "haut", type: "study", name: "幂等创建组", description: "首次" };
  const first = await app.inject({
    method: "POST",
    url: "/api/v1/groups",
    headers: { ...owner.auth, "idempotency-key": createKey },
    body
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.my_role, "OWNER");
  assert.equal(first.body.data.member_count, 1);
  assert.equal(first.headers.Location, "/api/v1/groups/" + first.body.data.group_id);

  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/groups",
    headers: { ...owner.auth, "idempotency-key": createKey },
    body
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.code, "REQUEST_DUPLICATE");
  assert.equal(replay.body.data.group_id, first.body.data.group_id);
  assert.equal(app.store.groups.size, 1);

  const mismatch = await app.inject({
    method: "POST",
    url: "/api/v1/groups",
    headers: { ...owner.auth, "idempotency-key": createKey },
    body: { ...body, name: "同键不同载荷" }
  });
  assert.equal(mismatch.status, 409);

  const crossSchool = await app.inject({
    method: "GET",
    url: "/api/v1/groups?school_id=haut",
    headers: otherSchool.auth
  });
  assert.equal(crossSchool.status, 403);
  assert.equal(crossSchool.body.error.code, "SCHOOL_SCOPE_MISMATCH");

  const outsider = setupUser(app, "outsider_crud");
  const hidden = await app.inject({
    method: "GET",
    url: "/api/v1/groups/" + first.body.data.group_id,
    headers: outsider.auth
  });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.error.code, "GROUP_NOT_FOUND");

  const patchKey = nextKey("patch-group");
  const patch = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + first.body.data.group_id,
    headers: { ...owner.auth, "idempotency-key": patchKey },
    body: { name: "幂等创建组·更新", description: null }
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.data.name, "幂等创建组·更新");
  assert.equal(patch.body.data.description, null);
  const patchReplay = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + first.body.data.group_id,
    headers: { ...owner.auth, "idempotency-key": patchKey },
    body: { name: "幂等创建组·更新", description: null }
  });
  assert.equal(patchReplay.status, 200);
  assert.equal(patchReplay.body.code, "REQUEST_DUPLICATE");

  const second = await createStudyGroup(app, owner, BASE_NOW + 1000, { name: "第二学习组", description: "分页" });
  assert.ok(second.group_id);
  const crossTargetKeyReplay = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + second.group_id,
    headers: { ...owner.auth, "idempotency-key": patchKey },
    body: { name: "幂等创建组·更新", description: null }
  });
  assert.equal(crossTargetKeyReplay.status, 409, "same idempotency key must not replay across a different target resource");
  const page1 = await app.inject({
    method: "GET",
    url: "/api/v1/groups?school_id=haut&type=study&limit=1",
    headers: owner.auth
  });
  assert.equal(page1.status, 200);
  assert.equal(page1.body.data.length, 1);
  assert.ok(page1.body.meta.next_cursor);
  const page2 = await app.inject({
    method: "GET",
    url: "/api/v1/groups?school_id=haut&type=study&limit=1&cursor=" + encodeURIComponent(page1.body.meta.next_cursor),
    headers: owner.auth
  });
  assert.equal(page2.status, 200);
  assert.equal(page2.body.data.length, 1);
  assert.notEqual(page2.body.data[0].group_id, page1.body.data[0].group_id);

  const joinedEvents = app.store.outboxEvents.filter((event) => event.event_type === "group.member.joined");
  assert.equal(joinedEvents.length, 2);
  assert.equal(joinedEvents[0].payload_json.reason, "GROUP_CREATED");
  assert.match(joinedEvents[0].payload_json.event_key, /^dis:group:[0-9a-f-]{36}:member:[0-9a-f-]{36}:joined:v1$/);
});

test("W4-01 invites: QR payload, use limit, expiry, revocation, accept replay, and GROUP_ALREADY_MEMBER", async () => {
  const app = createTestApp();
  const owner = setupUser(app, "owner_invite");
  const memberA = setupUser(app, "member_a");
  const memberB = setupUser(app, "member_b");
  const memberC = setupUser(app, "member_c");
  const group = await createStudyGroup(app, owner);
  const invite = await createInvite(app, owner, group.group_id, { maxUses: 2 });
  assert.match(invite.qr_payload, /^dis-group-invite:v1:[A-Za-z0-9_-]{8,64}$/);

  const acceptAKey = nextKey("accept-replay");
  const acceptA = await app.inject({
    method: "POST",
    url: "/api/v1/group-invites/" + invite.code + "/accept",
    headers: { ...memberA.auth, "idempotency-key": acceptAKey }
  });
  assert.equal(acceptA.status, 201);
  assert.equal(acceptA.body.data.role, "MEMBER");
  assert.equal(acceptA.body.data.sharing_level, "NONE");
  assert.notEqual(acceptA.body.data.display_name, memberA.user.display_name, "group display name must be a school-scoped pseudonym");

  const replayA = await app.inject({
    method: "POST",
    url: "/api/v1/group-invites/" + invite.code + "/accept",
    headers: { ...memberA.auth, "idempotency-key": acceptAKey }
  });
  assert.equal(replayA.status, 200);
  assert.equal(replayA.body.code, "REQUEST_DUPLICATE");
  assert.equal(replayA.body.data.member_id, acceptA.body.data.member_id);
  assert.equal(app.store.groupInvites.get(invite.invite_id).used_count, 1);

  const already = await acceptInvite(app, memberA, invite.code);
  assert.equal(already.status, 409);
  assert.equal(already.body.error.code, "GROUP_ALREADY_MEMBER");
  assert.equal(app.store.groupInvites.get(invite.invite_id).used_count, 1);

  const acceptQr = await acceptInvite(app, memberB, invite.qr_payload);
  assert.equal(acceptQr.status, 201);
  assert.equal(app.store.groupInvites.get(invite.invite_id).used_count, 2);
  assert.equal(app.store.groupInvites.get(invite.invite_id).status, "EXHAUSTED");

  const exhausted = await acceptInvite(app, memberC, invite.code);
  assert.equal(exhausted.status, 409);
  assert.equal(exhausted.body.error.code, "GROUP_INVITE_EXHAUSTED");

  const expiring = await createInvite(app, owner, group.group_id, {
    maxUses: 1,
    expiresAt: "2026-11-27T10:00:01.000Z"
  });
  const expired = await acceptInvite(app, memberC, expiring.code, BASE_NOW + 2_000);
  assert.equal(expired.status, 410);
  assert.equal(expired.body.error.code, "GROUP_INVITE_EXPIRED");

  const revokedInvite = await createInvite(app, owner, group.group_id, { maxUses: 3 });
  const revokeKey = nextKey("revoke-invite");
  const revoked = await app.inject({
    method: "DELETE",
    url: "/api/v1/groups/" + group.group_id + "/invites/" + revokedInvite.invite_id,
    headers: { ...owner.auth, "idempotency-key": revokeKey }
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.data.revoked, true);
  const revokeReplay = await app.inject({
    method: "DELETE",
    url: "/api/v1/groups/" + group.group_id + "/invites/" + revokedInvite.invite_id,
    headers: { ...owner.auth, "idempotency-key": revokeKey }
  });
  assert.equal(revokeReplay.status, 200);
  assert.equal(revokeReplay.body.code, "REQUEST_DUPLICATE");
  const afterRevoke = await acceptInvite(app, memberC, revokedInvite.code);
  assert.equal(afterRevoke.status, 404);
  assert.equal(afterRevoke.body.error.code, "GROUP_INVITE_INVALID");

  const joinedAccepted = app.store.outboxEvents.filter(
    (event) => event.event_type === "group.member.joined" && event.payload_json.reason === "INVITE_ACCEPTED"
  );
  assert.equal(joinedAccepted.length, 2);
  for (const event of joinedAccepted) {
    assert.equal(event.payload_json.sharing_level, "NONE");
    assert.equal(event.payload_json.reason, "INVITE_ACCEPTED");
  }
});

test("W4-01 members: owner transfer is atomic, last owner is protected, leave withdraws sharing, rejoin mints member_id, archive emits left events", async () => {
  const app = createTestApp();
  const owner = setupUser(app, "owner_members");
  const member = setupUser(app, "member_members");
  const group = await createStudyGroup(app, owner);
  const invite = await createInvite(app, owner, group.group_id, { maxUses: 4 });
  const accepted = await acceptInvite(app, member, invite.code);
  assert.equal(accepted.status, 201);
  const memberId = accepted.body.data.member_id;

  const memberPatchForbidden = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + group.group_id,
    headers: { ...member.auth, "idempotency-key": nextKey("member-patch-group") },
    body: { name: "越权改名" }
  });
  assert.equal(memberPatchForbidden.status, 403);
  assert.equal(memberPatchForbidden.body.error.code, "GROUP_PERMISSION_DENIED");

  const selfSharing = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + group.group_id + "/members/" + memberId,
    headers: { ...member.auth, "idempotency-key": nextKey("self-sharing") },
    body: { sharing_level: "BUSY_BLOCKS_30MIN" }
  });
  assert.equal(selfSharing.status, 200);
  assert.equal(selfSharing.body.data.sharing_level, "BUSY_BLOCKS_30MIN");

  const transfer = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + group.group_id + "/members/" + memberId,
    headers: { ...owner.auth, "idempotency-key": nextKey("owner-transfer") },
    body: { role: "OWNER" }
  });
  assert.equal(transfer.status, 200);
  assert.equal(transfer.body.data.role, "OWNER");
  const activeMembers = Array.from(app.store.groupMembers.values()).filter(
    (row) => row.group_id === group.group_id && row.status === "ACTIVE"
  );
  assert.equal(activeMembers.filter((row) => row.role === "OWNER").length, 1);
  const oldOwnerRow = activeMembers.find((row) => row.cloud_user_id === owner.user.id);
  assert.equal(oldOwnerRow.role, "MEMBER");

  const leave = await app.inject({
    method: "DELETE",
    url: "/api/v1/groups/" + group.group_id + "/members/" + oldOwnerRow.id,
    headers: { ...owner.auth, "idempotency-key": nextKey("self-leave") }
  });
  assert.equal(leave.status, 200);
  assert.equal(leave.body.data.reason, "SELF_LEFT");
  assert.equal(leave.body.data.sharing_level, "NONE");
  assert.equal(app.store.groupMembers.get(oldOwnerRow.id).sharing_level, "NONE");
  assert.equal(app.store.groupMembers.get(oldOwnerRow.id).status, "LEFT");

  const lastOwnerLeave = await app.inject({
    method: "DELETE",
    url: "/api/v1/groups/" + group.group_id + "/members/" + memberId,
    headers: { ...member.auth, "idempotency-key": nextKey("last-owner-leave") }
  });
  assert.equal(lastOwnerLeave.status, 409);
  assert.equal(lastOwnerLeave.body.error.code, "GROUP_LAST_OWNER_REQUIRED");

  const rejoin = await acceptInvite(app, owner, invite.code);
  assert.equal(rejoin.status, 201);
  assert.notEqual(rejoin.body.data.member_id, oldOwnerRow.id);
  const eventKeys = new Set(
    app.store.outboxEvents
      .filter((event) => event.aggregate_type === "group_member")
      .map((event) => event.payload_json.event_key)
  );
  assert.equal(
    eventKeys.size,
    app.store.outboxEvents.filter((event) => event.aggregate_type === "group_member").length,
    "joined/left event keys must remain unique across membership periods"
  );

  const archive = await app.inject({
    method: "DELETE",
    url: "/api/v1/groups/" + group.group_id,
    headers: { ...member.auth, "idempotency-key": nextKey("archive-group") }
  });
  assert.equal(archive.status, 200);
  assert.equal(archive.body.data.memberships_ended, 2);
  const leftEvents = app.store.outboxEvents.filter(
    (event) => event.event_type === "group.member.left" && event.payload_json.reason === "GROUP_ARCHIVED"
  );
  assert.equal(leftEvents.length, 2);
  for (const event of leftEvents) {
    assert.equal(event.payload_json.sharing_level, "NONE");
    assert.equal(event.payload_json.reason, "GROUP_ARCHIVED");
  }
  const afterArchive = await app.inject({
    method: "GET",
    url: "/api/v1/groups/" + group.group_id,
    headers: member.auth
  });
  assert.equal(afterArchive.status, 404);
});

test("W4-01 privacy: community data is exported and data-delete detaches membership, invites, ownership, and event user ids", async () => {
  const app = createTestApp();
  const owner = setupUser(app, "owner_privacy");
  const member = setupUser(app, "member_privacy");
  const group = await createStudyGroup(app, owner);
  const invite = await createInvite(app, owner, group.group_id, { maxUses: 2 });
  const accepted = await acceptInvite(app, member, invite.code);
  assert.equal(accepted.status, 201);

  const exported = await app.inject({
    method: "POST",
    url: "/api/v1/me/data-export",
    headers: owner.auth
  });
  assert.equal(exported.status, 200);
  assert.equal(exported.body.data.community_groups.length, 1);
  assert.equal(exported.body.data.community_group_members.length, 1);
  assert.equal(exported.body.data.community_group_invites.length, 1);

  const deleted = await app.inject({
    method: "POST",
    url: "/api/v1/me/data-delete",
    headers: owner.auth
  });
  assert.equal(deleted.status, 202);
  assert.ok(deleted.body.data.community_purged);
  assert.equal(deleted.body.data.community_purged.memberships_removed, 1);
  assert.equal(deleted.body.data.community_purged.invites_deleted, 1);
  assert.equal(deleted.body.data.community_purged.ownership_transfers, 1);

  assert.equal(
    Array.from(app.store.groupMembers.values()).some((row) => row.cloud_user_id === owner.user.id),
    false,
    "deleted user membership rows must be removed"
  );
  assert.equal(
    Array.from(app.store.groupInvites.values()).some((row) => row.created_by === owner.user.id),
    false,
    "deleted user invite rows must be removed"
  );
  const survivingGroup = app.store.groups.get(group.group_id);
  assert.equal(survivingGroup.created_by, COMMUNITY_DELETED_USER_TOMBSTONE);
  const survivingMember = Array.from(app.store.groupMembers.values()).find(
    (row) => row.group_id === group.group_id && row.status === "ACTIVE"
  );
  assert.equal(survivingMember.cloud_user_id, member.user.id);
  assert.equal(survivingMember.role, "OWNER");
  for (const event of app.store.outboxEvents.filter((row) => row.aggregate_type === "group_member")) {
    assert.notEqual(event.payload_json.cloud_user_id, owner.user.id);
    assert.notEqual(event.payload_json.actor_cloud_user_id, owner.user.id);
  }

  const solo = setupUser(app, "owner_solo_delete");
  const soloGroup = await createStudyGroup(app, solo);
  const soloDeleted = await app.inject({
    method: "POST",
    url: "/api/v1/me/data-delete",
    headers: solo.auth
  });
  assert.equal(soloDeleted.status, 202);
  assert.equal(app.store.groups.has(soloGroup.group_id), false, "sole-member caller-created group shell must be removed after data delete");
});


test("W4-01 privacy regression: deleting the creator of an archived group cascades dead LEFT history instead of orphaning snapshot rows", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-community-archived-delete-"));
  const snapshotPath = path.join(tmpDir, "cloud-state.json");
  try {
    const app = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    const owner = setupUser(app, "owner_archived_delete");
    const member = setupUser(app, "member_archived_delete");
    const group = await createStudyGroup(app, owner);
    const invite = await createInvite(app, owner, group.group_id, { maxUses: 2 });
    assert.equal((await acceptInvite(app, member, invite.code)).status, 201);

    const archive = await app.inject({
      method: "DELETE",
      url: "/api/v1/groups/" + group.group_id,
      headers: { ...owner.auth, "idempotency-key": nextKey("archive-before-delete") }
    });
    assert.equal(archive.status, 200, JSON.stringify(archive.body));
    assert.equal(archive.body.data.memberships_ended, 2);
    assert.equal(
      Array.from(app.store.groupMembers.values()).filter((row) => row.group_id === group.group_id && row.status === "LEFT").length,
      2,
      "archive keeps two historical LEFT membership periods before erasure"
    );

    const deleted = await app.inject({
      method: "POST",
      url: "/api/v1/me/data-delete",
      headers: owner.auth
    });
    assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
    assert.equal(deleted.body.data.community_purged.groups_deleted, 1);
    assert.equal(deleted.body.data.community_purged.memberships_removed, 1, "the erased user's own row is counted once");
    assert.equal(
      deleted.body.data.community_purged.cascaded_memberships_removed,
      1,
      "the other user's dead LEFT history cascades with the orphaning group shell"
    );
    assert.equal(app.store.groups.has(group.group_id), false);
    assert.equal(
      Array.from(app.store.groupMembers.values()).some((row) => row.group_id === group.group_id),
      false,
      "no historical member row may remain orphaned after the group shell is removed"
    );

    const restarted = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    assert.equal(restarted.store.groups.has(group.group_id), false);
    assert.equal(
      Array.from(restarted.store.groupMembers.values()).some((row) => row.group_id === group.group_id),
      false,
      "restarted snapshot validation must not see archived-group member orphans"
    );
    clearTimeout(restarted.store._snapshotFlushTimer);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test("W4-01 member governance: cross-school accept is isolated, last owner cannot demote self, and admin removal emits ADMIN_REMOVED with sharing withdrawn", async () => {
  const app = createTestApp();
  const owner = setupUser(app, "owner_governance");
  const adminCandidate = setupUser(app, "admin_candidate");
  const memberC = setupUser(app, "member_removee");
  const crossSchool = setupUser(app, "cross_acceptor", { schoolId: "other-university" });
  const group = await createStudyGroup(app, owner);
  const invite = await createInvite(app, owner, group.group_id, { maxUses: 4 });

  const crossAccept = await acceptInvite(app, crossSchool, invite.code);
  assert.equal(crossAccept.status, 403);
  assert.equal(crossAccept.body.error.code, "SCHOOL_SCOPE_MISMATCH");

  const acceptedAdmin = await acceptInvite(app, adminCandidate, invite.code);
  assert.equal(acceptedAdmin.status, 201);
  const acceptedC = await acceptInvite(app, memberC, invite.code);
  assert.equal(acceptedC.status, 201);

  const ownerRow = Array.from(app.store.groupMembers.values()).find(
    (row) => row.group_id === group.group_id && row.cloud_user_id === owner.user.id && row.status === "ACTIVE"
  );
  const selfDemote = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + group.group_id + "/members/" + ownerRow.id,
    headers: { ...owner.auth, "idempotency-key": nextKey("owner-self-demote") },
    body: { role: "MEMBER" }
  });
  assert.equal(selfDemote.status, 409);
  assert.equal(selfDemote.body.error.code, "GROUP_LAST_OWNER_REQUIRED");

  const promote = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + group.group_id + "/members/" + acceptedAdmin.body.data.member_id,
    headers: { ...owner.auth, "idempotency-key": nextKey("promote-admin") },
    body: { role: "ADMIN" }
  });
  assert.equal(promote.status, 200);
  assert.equal(promote.body.data.role, "ADMIN");

  const share = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + group.group_id + "/members/" + acceptedC.body.data.member_id,
    headers: { ...memberC.auth, "idempotency-key": nextKey("removee-share") },
    body: { sharing_level: "BUSY_BLOCKS_30MIN" }
  });
  assert.equal(share.status, 200);

  const removed = await app.inject({
    method: "DELETE",
    url: "/api/v1/groups/" + group.group_id + "/members/" + acceptedC.body.data.member_id,
    headers: { ...adminCandidate.auth, "idempotency-key": nextKey("admin-remove") }
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.data.reason, "ADMIN_REMOVED");
  const removedRow = app.store.groupMembers.get(acceptedC.body.data.member_id);
  assert.equal(removedRow.status, "REMOVED");
  assert.equal(removedRow.sharing_level, "NONE");
  const removalEvents = app.store.outboxEvents.filter(
    (event) => event.event_type === "group.member.left" && event.payload_json.reason === "ADMIN_REMOVED"
  );
  assert.equal(removalEvents.length, 1);
  assert.equal(removalEvents[0].payload_json.sharing_level, "NONE");
  assert.equal(removalEvents[0].payload_json.actor_cloud_user_id, adminCandidate.user.id);
});

test("W4-01 durability: group, invite, member and idempotency receipts survive snapshot restart without duplicate replay", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-community-w401-"));
  const snapshotPath = path.join(tmpDir, "cloud-state.json");
  try {
    const app1 = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    const owner = setupUser(app1, "owner_durable");
    const member = setupUser(app1, "member_durable");
    const createKey = "durability-create-123";
    const createBody = { school_id: "haut", type: "project", name: "耐久项目组" };
    const created = await app1.inject({
      method: "POST",
      url: "/api/v1/groups",
      headers: { ...owner.auth, "idempotency-key": createKey },
      body: createBody
    });
    assert.equal(created.status, 201);
    const groupId = created.body.data.group_id;

    const app2 = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    const replayCreate = await app2.inject({
      method: "POST",
      url: "/api/v1/groups",
      headers: { ...owner.auth, "idempotency-key": createKey },
      body: createBody
    });
    assert.equal(replayCreate.status, 200);
    assert.equal(replayCreate.body.code, "REQUEST_DUPLICATE");
    assert.equal(app2.store.groups.size, 1);

    const inviteKey = "durability-invite-123";
    const inviteBody = { expires_at: "2026-11-28T10:00:00.000Z", max_uses: 2 };
    const invite = await app2.inject({
      method: "POST",
      url: "/api/v1/groups/" + groupId + "/invites",
      headers: { ...owner.auth, "idempotency-key": inviteKey },
      body: inviteBody
    });
    assert.equal(invite.status, 201);
    const inviteCode = invite.body.data.code;

    const app3 = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    const replayInvite = await app3.inject({
      method: "POST",
      url: "/api/v1/groups/" + groupId + "/invites",
      headers: { ...owner.auth, "idempotency-key": inviteKey },
      body: inviteBody
    });
    assert.equal(replayInvite.status, 200);
    assert.equal(replayInvite.body.code, "REQUEST_DUPLICATE");
    assert.equal(app3.store.groupInvites.size, 1);

    const acceptKey = "durability-accept-123";
    const accepted = await app3.inject({
      method: "POST",
      url: "/api/v1/group-invites/" + inviteCode + "/accept",
      headers: { ...member.auth, "idempotency-key": acceptKey }
    });
    assert.equal(accepted.status, 201);

    const app4 = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    const replayAccept = await app4.inject({
      method: "POST",
      url: "/api/v1/group-invites/" + inviteCode + "/accept",
      headers: { ...member.auth, "idempotency-key": acceptKey }
    });
    assert.equal(replayAccept.status, 200);
    assert.equal(replayAccept.body.code, "REQUEST_DUPLICATE");
    assert.equal(replayAccept.body.data.member_id, accepted.body.data.member_id);
    assert.equal(
      Array.from(app4.store.groupMembers.values()).filter(
        (row) => row.group_id === groupId && row.status === "ACTIVE"
      ).length,
      2
    );
    assert.equal(app4.store.groupInvites.get(invite.body.data.invite_id).used_count, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("W4-01 atomicity: pre-commit storage failure rolls back owner transfer and same key may reconcile", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-community-atomic-"));
  const snapshotPath = path.join(tmpDir, "cloud-state.json");
  try {
    const app = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    const owner = setupUser(app, "owner_atomic");
    const member = setupUser(app, "member_atomic");
    const group = await createStudyGroup(app, owner);
    const invite = await createInvite(app, owner, group.group_id, { maxUses: 2 });
    const accepted = await acceptInvite(app, member, invite.code);
    assert.equal(accepted.status, 201);
    const targetId = accepted.body.data.member_id;
    const ownerRow = Array.from(app.store.groupMembers.values()).find(
      (row) => row.group_id === group.group_id && row.cloud_user_id === owner.user.id && row.status === "ACTIVE"
    );
    const targetRow = app.store.groupMembers.get(targetId);
    const transferKey = "atomic-owner-transfer-123";

    app.store._persistFaultInject = "tmp_write";
    const failed = await app.inject({
      method: "PATCH",
      url: "/api/v1/groups/" + group.group_id + "/members/" + targetId,
      headers: { ...owner.auth, "idempotency-key": transferKey },
      body: { role: "OWNER" }
    });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error.code, "STORAGE_PERSISTENCE_FAILED");
    assert.equal(ownerRow.role, "OWNER", "pre-commit failure must restore the original owner");
    assert.equal(targetRow.role, "MEMBER", "pre-commit failure must restore the target role");
    assert.equal(
      Array.from(app.store.idempotencyRecords.keys()).some((key) => key.endsWith("|" + transferKey)),
      false,
      "failed pre-publish transfer must not leave a durable success receipt"
    );

    app.store._persistFaultInject = null;
    const retry = await app.inject({
      method: "PATCH",
      url: "/api/v1/groups/" + group.group_id + "/members/" + targetId,
      headers: { ...owner.auth, "idempotency-key": transferKey },
      body: { role: "OWNER" }
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.data.role, "OWNER");
    assert.equal(ownerRow.role, "MEMBER");
    assert.equal(targetRow.role, "OWNER");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("W4-01 sharing privacy (AUTO-030): sharing_level is strict self-service; owner and admin patches of other members are always rejected", async () => {
  const app = createTestApp();
  const owner = setupUser(app, "owner_sharing");
  const admin = setupUser(app, "admin_sharing");
  const member = setupUser(app, "member_sharing");
  const group = await createStudyGroup(app, owner);
  const invite = await createInvite(app, owner, group.group_id, { maxUses: 4 });
  assert.equal((await acceptInvite(app, admin, invite.code)).status, 201);
  const acceptedMember = await acceptInvite(app, member, invite.code);
  assert.equal(acceptedMember.status, 201);
  const memberId = acceptedMember.body.data.member_id;

  // Owner cannot open, change, or withdraw another member's sharing — even as a no-op.
  for (const level of ["BUSY_BLOCKS_30MIN", "NONE"]) {
    const ownerPatch = await app.inject({
      method: "PATCH",
      url: "/api/v1/groups/" + group.group_id + "/members/" + memberId,
      headers: { ...owner.auth, "idempotency-key": nextKey("owner-sharing-" + level) },
      body: { sharing_level: level }
    });
    assert.equal(ownerPatch.status, 403, "owner patching another member sharing_level must be rejected");
    assert.equal(ownerPatch.body.error.code, "GROUP_PERMISSION_DENIED");
  }
  assert.equal(app.store.groupMembers.get(memberId).sharing_level, "NONE", "rejected patches must not mutate sharing_level");

  // A combined role+sharing payload is rejected atomically: the role part must not apply either.
  const adminMemberRow = Array.from(app.store.groupMembers.values()).find(
    (row) => row.group_id === group.group_id && row.cloud_user_id === admin.user.id && row.status === "ACTIVE"
  );
  const combined = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + group.group_id + "/members/" + adminMemberRow.id,
    headers: { ...owner.auth, "idempotency-key": nextKey("combined-role-sharing") },
    body: { role: "ADMIN", sharing_level: "BUSY_BLOCKS_30MIN" }
  });
  assert.equal(combined.status, 403);
  assert.equal(combined.body.error.code, "GROUP_PERMISSION_DENIED");
  assert.equal(app.store.groupMembers.get(adminMemberRow.id).role, "MEMBER", "rejected combined patch must not apply the role part");
  assert.equal(app.store.groupMembers.get(adminMemberRow.id).sharing_level, "NONE");

  // Promote admin through a clean role-only patch, then verify the admin is equally denied.
  const promote = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + group.group_id + "/members/" + adminMemberRow.id,
    headers: { ...owner.auth, "idempotency-key": nextKey("promote-admin-clean") },
    body: { role: "ADMIN" }
  });
  assert.equal(promote.status, 200);
  const adminPatch = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + group.group_id + "/members/" + memberId,
    headers: { ...admin.auth, "idempotency-key": nextKey("admin-sharing") },
    body: { sharing_level: "BUSY_BLOCKS_30MIN" }
  });
  assert.equal(adminPatch.status, 403);
  assert.equal(adminPatch.body.error.code, "GROUP_PERMISSION_DENIED");
  assert.equal(app.store.groupMembers.get(memberId).sharing_level, "NONE");

  // A plain member is equally denied on another member, while self-service stays available.
  const memberOnAdmin = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + group.group_id + "/members/" + adminMemberRow.id,
    headers: { ...member.auth, "idempotency-key": nextKey("member-on-admin-sharing") },
    body: { sharing_level: "NONE" }
  });
  assert.equal(memberOnAdmin.status, 403);
  const selfService = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + group.group_id + "/members/" + memberId,
    headers: { ...member.auth, "idempotency-key": nextKey("self-service-sharing") },
    body: { sharing_level: "BUSY_BLOCKS_30MIN" }
  });
  assert.equal(selfService.status, 200);
  assert.equal(selfService.body.data.sharing_level, "BUSY_BLOCKS_30MIN");
  assert.equal(app.store.groupMembers.get(memberId).sharing_level, "BUSY_BLOCKS_30MIN");
});

test("W4-01 erasure probe: data-delete scrubs community idempotency receipts — own receipts dropped, foreign replay payloads pseudonymized", async () => {
  const app = createTestApp();
  const owner = setupUser(app, "owner_erasure");
  const member = setupUser(app, "member_erasure");
  const group = await createStudyGroup(app, owner);
  const invite = await createInvite(app, owner, group.group_id, { maxUses: 2 });
  const accepted = await acceptInvite(app, member, invite.code);
  assert.equal(accepted.status, 201);

  // Promote the member to ADMIN and let them rename the group: their durable
  // receipt payload then embeds the original created_by (the owner's id).
  const ownerRow = Array.from(app.store.groupMembers.values()).find(
    (row) => row.group_id === group.group_id && row.cloud_user_id === owner.user.id && row.status === "ACTIVE"
  );
  const promote = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + group.group_id + "/members/" + accepted.body.data.member_id,
    headers: { ...owner.auth, "idempotency-key": nextKey("erasure-promote") },
    body: { role: "ADMIN" }
  });
  assert.equal(promote.status, 200);
  const renameKey = nextKey("erasure-rename");
  const renamed = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + group.group_id,
    headers: { ...member.auth, "idempotency-key": renameKey },
    body: { name: "改名后的互助组" }
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.created_by, owner.user.id, "pre-delete receipt payload embeds the creator id");

  const keysBefore = Array.from(app.store.idempotencyRecords.keys());
  assert.ok(keysBefore.some((key) => key.startsWith("createGroup|" + owner.user.id + "|")), "own createGroup receipt exists before delete");
  assert.ok(keysBefore.some((key) => key.startsWith("createGroupInvite|" + owner.user.id + "|")), "own invite receipt exists before delete");

  const deleted = await app.inject({
    method: "POST",
    url: "/api/v1/me/data-delete",
    headers: owner.auth
  });
  assert.equal(deleted.status, 202);
  assert.ok(deleted.body.data.community_purged.idempotency_receipts_deleted >= 2, "own community receipts are dropped");
  assert.ok(deleted.body.data.community_purged.idempotency_receipts_pseudonymized >= 1, "foreign receipts referencing the erased id are pseudonymized");

  for (const key of app.store.idempotencyRecords.keys()) {
    assert.ok(!key.includes(owner.user.id), "no idempotency receipt key may embed the erased user id: " + key);
  }
  for (const [key, record] of app.store.idempotencyRecords.entries()) {
    assert.ok(
      !JSON.stringify(record).includes(owner.user.id),
      "no idempotency receipt payload may embed the erased user id: " + key
    );
  }

  // The member's own durable receipt survives but replays the pseudonymized view.
  const replay = await app.inject({
    method: "PATCH",
    url: "/api/v1/groups/" + group.group_id,
    headers: { ...member.auth, "idempotency-key": renameKey },
    body: { name: "改名后的互助组" }
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.code, "REQUEST_DUPLICATE");
  assert.equal(replay.body.data.created_by, COMMUNITY_DELETED_USER_TOMBSTONE, "replayed receipt must not re-expose the erased creator id");
  assert.equal(app.store.groups.get(group.group_id).created_by, COMMUNITY_DELETED_USER_TOMBSTONE);
  assert.ok(ownerRow, "ownership transfer fixture sanity");
  const survivingOwner = Array.from(app.store.groupMembers.values()).find(
    (row) => row.group_id === group.group_id && row.status === "ACTIVE"
  );
  assert.ok(survivingOwner, "an active successor must remain");
  assert.equal(survivingOwner.cloud_user_id, member.user.id);
  assert.equal(survivingOwner.role, "OWNER");
});

test("W4-01 atomicity: data-delete is a single commit unit — pre-publish flush failure rolls back every mutation; post-publish failure stays commit-unknown", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-community-delete-atomic-"));
  const snapshotPath = path.join(tmpDir, "cloud-state.json");
  try {
    const app = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    const owner = setupUser(app, "owner_delete_atomic");
    const member = setupUser(app, "member_delete_atomic");
    const group = await createStudyGroup(app, owner);
    const invite = await createInvite(app, owner, group.group_id, { maxUses: 2 });
    assert.equal((await acceptInvite(app, member, invite.code)).status, 201);
    app.store._persistFaultInject = "tmp_write";
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/me/data-delete",
      headers: owner.auth
    });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error.code, "STORAGE_PERSISTENCE_FAILED");

    // Memory must be fully rolled back: nothing halfway erased, nothing halfway revoked.
    assert.equal(app.store.users.get(owner.user.id).status, "ACTIVE", "user status must roll back");
    assert.equal(app.store.groups.get(group.group_id).created_by, owner.user.id, "group ownership must roll back");
    const ownerMembership = Array.from(app.store.groupMembers.values()).find(
      (row) => row.group_id === group.group_id && row.cloud_user_id === owner.user.id
    );
    assert.ok(ownerMembership, "membership row must roll back");
    assert.equal(ownerMembership.status, "ACTIVE");
    assert.equal(ownerMembership.role, "OWNER", "ownership transfer must roll back");
    // Re-read through the store: rollback is overlay discard, so live row
    // object identity is preserved rather than replaced by cloned records.
    const rolledBinding = Array.from(app.store.schoolBindings.values()).find(
      (row) => row.cloud_user_id === owner.user.id
    );
    const rolledSession = Array.from(app.store.deviceSessions.values()).find(
      (row) => row.cloud_user_id === owner.user.id
    );
    assert.equal(rolledBinding.revoked_at, null, "school binding revocation must roll back");
    assert.equal(rolledBinding.status, "DELEGATED_ACTIVE");
    assert.equal(rolledSession.revoked_at, null, "session revocation must roll back");
    assert.equal(
      Array.from(app.store.groupInvites.values()).some((row) => row.created_by === owner.user.id),
      true,
      "invite rows must roll back"
    );
    assert.ok(
      Array.from(app.store.idempotencyRecords.keys()).some((key) => key.startsWith("createGroup|" + owner.user.id + "|")),
      "idempotency receipts must roll back"
    );

    // The durable snapshot never published the half-delete: a fresh restart still sees the pre-delete world.
    const diskProbe = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    assert.equal(diskProbe.store.users.get(owner.user.id).status, "ACTIVE");
    assert.equal(diskProbe.store.groups.get(group.group_id).created_by, owner.user.id);
    clearTimeout(diskProbe.store._snapshotFlushTimer);

    // With the fault cleared the same request succeeds as one atomic unit and persists everywhere.
    app.store._persistFaultInject = null;
    const deleted = await app.inject({
      method: "POST",
      url: "/api/v1/me/data-delete",
      headers: owner.auth
    });
    assert.equal(deleted.status, 202);
    assert.equal(app.store.users.get(owner.user.id).status, "DELETED");
    const restarted = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    assert.equal(restarted.store.users.get(owner.user.id).status, "DELETED", "delete must be durable after restart");
    assert.equal(restarted.store.groups.get(group.group_id).created_by, COMMUNITY_DELETED_USER_TOMBSTONE);
    assert.equal(
      Array.from(restarted.store.groupMembers.values()).some((row) => row.cloud_user_id === owner.user.id),
      false
    );
    for (const key of restarted.store.idempotencyRecords.keys()) {
      assert.ok(!key.includes(owner.user.id), "restarted receipts must not embed the erased user id");
    }
    clearTimeout(restarted.store._snapshotFlushTimer);

    // Post-publish failure is commit-unknown by design: memory is NOT rolled back because
    // the durable candidate may already carry the fully-erased state.
    const app2 = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    const owner2 = setupUser(app2, "owner_delete_unknown");
    const group2 = await createStudyGroup(app2, owner2);
    app2.store._persistFaultInject = "dir_fsync";
    const unknown = await app2.inject({
      method: "POST",
      url: "/api/v1/me/data-delete",
      headers: owner2.auth
    });
    assert.equal(unknown.status, 503);
    assert.equal(unknown.body.error.code, "STORAGE_COMMIT_UNKNOWN");
    assert.equal(app2.store.users.get(owner2.user.id).status, "DELETED", "post-publish unknown must not roll memory back");
    assert.equal(app2.store.groups.has(group2.group_id), false, "post-publish unknown keeps the erased memory state");
    clearTimeout(app2.store._snapshotFlushTimer);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test("W4-01 atomicity scale: copy-on-write rollback handles 200k events, preserves object identity, and keeps async cross-await writes connected", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-community-delete-scale-"));
  const snapshotPath = path.join(tmpDir, "cloud-state.json");
  try {
    const store = new CloudDatabaseStore({ snapshotPath, requireDurableSnapshot: true });
    const userId = crypto.randomUUID();
    const user = {
      id: userId,
      issuer: "https://issuer.example",
      subject: "scale-subject",
      username: "scale-user",
      display_name: "scale-user",
      status: "ACTIVE",
      auth_version: 1,
      created_at: new Date(BASE_NOW).toISOString()
    };
    store.users.set(userId, user);
    for (let index = 0; index < 200000; index += 1) {
      store.outboxEvents.push({
        id: "scale-event-" + index,
        aggregate_type: "scale_probe",
        event_type: "scale.probed",
        payload_json: { index, cloud_user_id: userId },
        created_at: new Date(BASE_NOW + index).toISOString()
      });
    }
    store.flushSnapshotStrictSync();

    const userRef = store.users.get(userId);
    const outboxRef = store.outboxEvents;
    const firstEventRef = store.outboxEvents[0];
    const auditLength = store.auditEvents.length;
    const externalReferenceWrite = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      userRef.auth_version = 99;
    })();
    store._persistFaultInject = "tmp_write";
    assert.throws(
      () => store.runAtomicCommitUnit(() => {
        const transactionalUser = store.users.get(userId);
        transactionalUser.status = "DELETED";
        store.outboxEvents.push({
          id: "scale-event-overflow",
          aggregate_type: "scale_probe",
          event_type: "scale.probed",
          payload_json: { index: 200000, cloud_user_id: userId },
          created_at: new Date(BASE_NOW + 200000).toISOString()
        });
        store.recordAudit({
          actor_kind: "USER",
          actor_ref: userId,
          action: "SCALE_ATOMIC_DELETE_PROBE",
          resource_kind: "user",
          resource_ref: userId,
          outcome: "USER_DATA_DELETE"
        });
      }),
      (err) => err?.code === "STORAGE_PERSISTENCE_FAILED",
      "pre-publish failure must surface as a retryable storage failure"
    );

    assert.equal(store.users.get(userId), userRef, "rollback must preserve row object identity");
    assert.equal(userRef.status, "ACTIVE", "discard of the write overlay restores the pre-delete value without cloning");
    assert.equal(store.outboxEvents, outboxRef, "rollback must preserve the live event array identity");
    assert.equal(store.outboxEvents.length, 200000, "no partial event append may survive the aborted unit");
    assert.equal(store.outboxEvents[0], firstEventRef, "existing event rows keep their object identity");
    assert.equal(store.outboxEvents.some((event) => event.id === "scale-event-overflow"), false);
    assert.equal(store.auditEvents.length, auditLength, "no partial audit append may survive the aborted unit");
    await externalReferenceWrite;
    assert.equal(userRef.auth_version, 99, "original reference write across await must remain connected after rollback");

    store._persistFaultInject = null;
    store.flushSnapshotStrictSync();

    const restarted = new CloudDatabaseStore({ snapshotPath, requireDurableSnapshot: true });
    assert.equal(restarted.users.get(userId).auth_version, 99, "original reference write across await must be durable after restart");
    assert.equal(restarted.outboxEvents.length, 200000);
    clearTimeout(restarted._snapshotFlushTimer);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
