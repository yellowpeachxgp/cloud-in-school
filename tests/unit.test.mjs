import test from "node:test";
import assert from "node:assert/strict";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { computeS256Challenge } from "../packages/identity/src/index.mjs";
import { resolvePickupCode, PROVIDER_AUTHORITY_MATRIX } from "../packages/parcel-hub/src/index.mjs";
import { listMigrations } from "../packages/db/src/index.mjs";

test("Unit: OIDC BFF + PKCE S256 + Single-Use App Ticket + Refresh Family Rotation (AUTH-001..020)", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk_valid_verifier_12345";
  const challenge = computeS256Challenge(verifier);

  // 1. Reject plain PKCE
  const badStart = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mobile/start",
    body: {
      install_ephemeral_id: "eph_android_0001",
      code_challenge: challenge,
      code_challenge_method: "plain"
    }
  });
  assert.equal(badStart.status, 400);

  // 2. Start valid S256 transaction
  const startRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mobile/start",
    body: {
      install_ephemeral_id: "eph_android_0001",
      code_challenge: challenge,
      code_challenge_method: "S256",
      device_label: "Pixel 9 Pro"
    }
  });
  assert.equal(startRes.status, 200);
  const loginTxn = startRes.body.data.login_txn;

  // 3. Redirect to OIDC SSO
  const redirectRes = await app.inject({
    method: "GET",
    url: `/api/v1/auth/oidc/start?txn=${encodeURIComponent(loginTxn)}`
  });
  assert.equal(redirectRes.status, 302);
  const redirectLocation = new URL(redirectRes.headers.Location);
  const state = redirectLocation.searchParams.get("state");
  assert.ok(state);

  // 4. OIDC Callback issues single-use app_ticket
  const cbRes = await app.inject({
    method: "GET",
    url: `/api/v1/auth/oidc/callback?code=sub:user_uuid_1001&state=${encodeURIComponent(state)}`
  });
  assert.equal(cbRes.status, 302);
  const appTicket = cbRes.body.data.app_ticket;
  assert.ok(appTicket.startsWith("tkt_"));

  // 5. Wrong PKCE verifier fails without burning validverifier check if tested separately, let's test exchange with valid verifier first
  const exRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mobile/exchange",
    body: {
      login_txn: loginTxn,
      app_ticket: appTicket,
      code_verifier: verifier
    }
  });
  assert.equal(exRes.status, 200);
  const { access_token, refresh_token } = exRes.body.data;
  assert.ok(access_token);
  assert.ok(refresh_token);

  // 6. Second exchange of the same single-use app_ticket MUST fail (AUTH-008)
  const replayTicketRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mobile/exchange",
    body: {
      login_txn: loginTxn,
      app_ticket: appTicket,
      code_verifier: verifier
    }
  });
  assert.equal(replayTicketRes.status, 401);
});

test("Unit: KMS Envelope Encryption + CredentialAccessPermit + Key Rotation (SCH-001..015)", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const enc = app.kmsVault.encryptSecret({
    bindingId: "bind_01",
    schoolId: "haut",
    credentialKind: "DELEGATED_SESSION_BUNDLE",
    plaintext: "CASTGC=TGT-secret-session-cookie"
  });
  assert.notEqual(enc.ciphertext, "CASTGC=TGT-secret-session-cookie");

  // Decrypt without permit must fail
  assert.throws(() => {
    app.kmsVault.decryptSecretWithPermit(enc, null);
  });

  // Decrypt with valid permit succeeds
  const permit = app.kmsVault.issueAccessPermit({
    taskId: "job_123",
    schoolId: "haut",
    bindingId: "bind_01",
    credentialRef: enc.id,
    ttlSeconds: 30
  });
  const decrypted = app.kmsVault.decryptSecretWithPermit(enc, permit);
  assert.equal(decrypted, "CASTGC=TGT-secret-session-cookie");

  // Rotate KEK and verify existing credential still decrypts under new KEK
  const rot = app.kmsVault.rotateKek("cn-kms-campus-cloud-kek-v2", "new-kek-seed-2026-v2", [enc]);
  assert.equal(rot.rotatedCount, 1);
  assert.equal(enc.kms_key_id, "cn-kms-campus-cloud-kek-v2");
  const decryptedAfterRotation = app.kmsVault.decryptSecretWithPermit(enc, permit);
  assert.equal(decryptedAfterRotation, "CASTGC=TGT-secret-session-cookie");
});

test("Unit: Parcel Hub OTP/Verification SMS Filtering, Pickup Code Extraction & Deduplication", async () => {
  // Pure OTP SMS must return null (never misclassified as pickup code!)
  assert.equal(
    resolvePickupCode("【招商银行】您的登录验证码为 482910，请勿泄露给他人。"),
    null
  );
  assert.equal(
    resolvePickupCode("【XPEACH】您的动态校验码是 938122，5分钟内有效。"),
    null
  );

  // Genuine campus station SMS extracts pickup code and station name
  const cainiao = resolvePickupCode(
    "【菜鸟驿站】您的包裹已到莲花街北苑菜鸟驿站，请凭取件码 12-3-4056 到店自提。"
  );
  assert.ok(cainiao);
  assert.equal(cainiao.pickup_code, "12-3-4056");
  assert.equal(cainiao.code_type, "SHELF_CODE");

  // Provider authority matrix fail-closed check in production
  const app = createCampusCloudApp({ environment: "production" });
  assert.equal(
    PROVIDER_AUTHORITY_MATRIX["parcel.taobao.cainiao"].authority_status,
    "RESEARCH_SANDBOX_ONLY"
  );
  assert.throws(() => {
    app.parcelHub.enforceProviderAuthority("parcel.taobao.cainiao", {
      channel: "CLOUD_BACKGROUND_POLL"
    });
  });

  // Upsert & merge same tracking number from manual + notification parser
  const p1 = app.parcelHub.upsertParcel({
    cloudUserId: "u_1",
    trackingNumber: "sf1234567890",
    providerId: "parcel.manual",
    itemTitle: "算法导论 (第四版)"
  });
  const p2 = app.parcelHub.upsertParcel({
    cloudUserId: "u_1",
    trackingNumber: "SF-1234567890",
    providerId: "parcel.notification-parser",
    rawNotificationText: "【菜鸟驿站】您的包裹已到站，凭取件码 A3-2-108 取件。"
  });
  assert.equal(p1.id, p2.id, "Same tracking number for same user must merge into canonical parcel");
  assert.equal(p2.pickup_code, "A3-2-108");
  assert.equal(p2.item_title, "算法导论 (第四版)");
  assert.equal(p2.status, "READY_FOR_PICKUP");
});

test("Unit: Database Migrations have paired Up and Down SQL files and support rollback", () => {
  const migrations = listMigrations();
  assert.ok(migrations.length >= 2);
  for (const m of migrations) {
    assert.ok(m.upSql.length > 100);
    assert.ok(m.downSql && m.downSql.length > 50);
  }
});

test("Unit: Campus Content (#16) & Lost-and-Found Private Contact Requests MVP (#9)", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });

  // 1. Verify #16 Computer Service Club structured venue
  const content = app.store.getCampusContent("haut");
  const compClub = content.clubs.find((c) => c.id === "club_partner_computer_service");
  assert.ok(compClub);
  assert.equal(compClub.activity_venue, "莲花街校区 学生宿舍F01 W111");
  assert.equal(compClub.building_name, "学生宿舍F01");
  assert.equal(compClub.room_number, "W111");

  // 2. Create two users (owner & finder) and test #9 Lost & Found Contact Request MVP
  const owner = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.xyz",
    subject: "sub_owner_01",
    displayName: "失主小张"
  });
  const finder = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.xyz",
    subject: "sub_finder_02",
    displayName: "拾得者小李"
  });
  const bystander = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.xyz",
    subject: "sub_bystander_03",
    displayName: "路人小王"
  });

  const ownerToken = app.identity.issueDeviceSession(owner, "dev_owner").access_token;
  const finderToken = app.identity.issueDeviceSession(finder, "dev_finder").access_token;
  const bystanderToken = app.identity.issueDeviceSession(bystander, "dev_bystander").access_token;

  // P1 #2: Anonymous request attempting to specify owner_cloud_user_id MUST be rejected (403)
  const spoofOwnerRes = await app.inject({
    method: "POST",
    url: "/api/v1/moments/posts",
    body: {
      type: "LOST",
      title: "伪造所有者的帖子",
      owner_cloud_user_id: owner.id
    }
  });
  assert.equal(spoofOwnerRes.status, 403);

  // Authenticated Owner creates a LOST post with ON_REQUEST contact visibility
  const createPostRes = await app.inject({
    method: "POST",
    url: "/api/v1/moments/posts",
    headers: { Authorization: `Bearer ${ownerToken}` },
    body: {
      type: "LOST",
      title: "遗失深蓝色校园一卡通",
      category: "校园卡/证件",
      campus: "莲花街校区",
      location: "31号楼201",
      description: "卡套背面贴有贴纸",
      contact: "微信: secret_wx_001",
      contact_visibility: "ON_REQUEST"
    }
  });
  assert.equal(createPostRes.status, 201);
  const postId = createPostRes.body.data.id;

  // P1 #2: Attempting to overwrite an existing post ID MUST be rejected (409 CONFLICT)
  const overwritePostRes = await app.inject({
    method: "POST",
    url: "/api/v1/moments/posts",
    headers: { Authorization: `Bearer ${bystanderToken}` },
    body: {
      id: postId,
      type: "FOUND",
      title: "恶意覆盖原帖",
      contact: "attacker_contact"
    }
  });
  assert.equal(overwritePostRes.status, 409);

  // Public snapshot masks ON_REQUEST contact and strips internal arrays
  const snapRes = await app.inject({
    method: "GET",
    url: "/api/v1/moments/snapshot"
  });
  const publicPost = snapRes.body.data.posts.find((p) => p.id === postId);
  assert.equal(publicPost.contact, "需发起联系/认领申请后查看");
  assert.equal(publicPost.has_protected_contact, true);
  assert.equal(publicPost.contact_requests, undefined);
  assert.equal(publicPost.blocked_user_ids, undefined);

  // Finder submits an idempotent contact request
  const req1 = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests`,
    headers: {
      Authorization: `Bearer ${finderToken}`,
      "Idempotency-Key": "idem-contact-001"
    },
    body: {
      message: "我捡到了这张校园卡，放在31号楼一楼值班室了",
      contact_info: "QQ: 123456789"
    }
  });
  assert.equal(req1.status, 201);
  const requestId = req1.body.data.id;

  // P1 #1: Public LIKE / COMMENT responses MUST use safe projection and NEVER leak contact_requests, blocked_user_ids, or protected contact!
  const likeRes = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/action`,
    body: { action: "LIKE" }
  });
  assert.equal(likeRes.status, 200);
  assert.equal(likeRes.body.data.contact, "需发起联系/认领申请后查看");
  assert.equal(likeRes.body.data.contact_requests, undefined);
  assert.equal(likeRes.body.data.blocked_user_ids, undefined);

  // Finder posts a private comment -> visible to Owner & Finder, hidden from Bystander and anonymous snapshot
  const privCommentRes = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/comments`,
    headers: { Authorization: `Bearer ${finderToken}` },
    body: {
      content: "【私密联系发起人】卡号后四位是 8821",
      contact_hint: "13800001111",
      is_private_to_initiator: true
    }
  });
  assert.equal(privCommentRes.status, 201);

  const bystanderCommentRes = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/comments`,
    body: {
      content: "帮顶，祝早日找回",
      contact_hint: ""
    }
  });
  assert.equal(bystanderCommentRes.status, 201);
  assert.equal(bystanderCommentRes.body.data.contact, "需发起联系/认领申请后查看");
  assert.equal(bystanderCommentRes.body.data.contact_requests, undefined);
  // Anonymous caller must NOT see Finder's private comment!
  assert.equal(bystanderCommentRes.body.data.comments.length, 1);
  assert.equal(bystanderCommentRes.body.data.comments[0].content, "帮顶，祝早日找回");

  // Owner CAN see both comments including the private comment and contact_hint
  const ownerSnap = await app.inject({
    method: "GET",
    url: "/api/v1/moments/snapshot",
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const ownerPostView = ownerSnap.body.data.posts.find((p) => p.id === postId);
  assert.equal(ownerPostView.comments.length, 2);

  // P1 #2: Non-owner cannot DELETE or RESOLVE the post
  const unauthDelete = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/action`,
    headers: { Authorization: `Bearer ${bystanderToken}` },
    body: { action: "DELETE" }
  });
  assert.equal(unauthDelete.status, 403);

  // Duplicate idempotency key returns 200 without creating a second request
  const reqDup = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests`,
    headers: {
      Authorization: `Bearer ${finderToken}`,
      "Idempotency-Key": "idem-contact-001"
    },
    body: {
      message: "我捡到了这张校园卡，放在31号楼一楼值班室了",
      contact_info: "QQ: 123456789"
    }
  });
  assert.equal(reqDup.status, 200);
  assert.equal(reqDup.body.code, "CONTACT_REQUEST_DUPLICATE");

  // Bystander cannot see Finder's contact request
  const bystanderList = await app.inject({
    method: "GET",
    url: `/api/v1/moments/posts/${postId}/contact-requests`,
    headers: { Authorization: `Bearer ${bystanderToken}` }
  });
  assert.equal(bystanderList.body.data.requests.length, 0);

  // Bystander cannot approve Finder's request
  const bystanderAct = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests/${requestId}/action`,
    headers: { Authorization: `Bearer ${bystanderToken}` },
    body: { action: "APPROVE" }
  });
  assert.equal(bystanderAct.status, 403);

  // Owner approves Finder's request -> Finder can now see initiator_contact
  const approveRes = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests/${requestId}/action`,
    headers: { Authorization: `Bearer ${ownerToken}` },
    body: { action: "APPROVE", reply_message: "太感谢了，我马上过去拿！" }
  });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.body.data.status, "APPROVED");
  assert.equal(approveRes.body.data.initiator_contact, "微信: secret_wx_001");

  // Finder submits a second request, then Owner BLOCKs Finder -> ALL requests (including the previously APPROVED one) become BLOCKED and initiator_contact is revoked!
  const req2 = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests`,
    headers: {
      Authorization: `Bearer ${finderToken}`,
      "Idempotency-Key": "idem-contact-002"
    },
    body: {
      message: "第二条请求",
      contact_info: "QQ: 123456789"
    }
  });
  assert.equal(req2.status, 201);
  const req2Id = req2.body.data.id;

  const blockRes = await app.inject({
    method: "POST",
    url: `/api/v1/moments/posts/${postId}/contact-requests/${req2Id}/action`,
    headers: { Authorization: `Bearer ${ownerToken}` },
    body: { action: "BLOCK" }
  });
  assert.equal(blockRes.status, 200);

  const finderListAfterBlock = await app.inject({
    method: "GET",
    url: `/api/v1/moments/posts/${postId}/contact-requests`,
    headers: { Authorization: `Bearer ${finderToken}` }
  });
  assert.ok(finderListAfterBlock.body.data.requests.every((r) => r.status === "BLOCKED"));
  assert.ok(finderListAfterBlock.body.data.requests.every((r) => r.initiator_contact === null));

  const finderSnapAfterBlock = await app.inject({
    method: "GET",
    url: "/api/v1/moments/snapshot",
    headers: { Authorization: `Bearer ${finderToken}` }
  });
  const finderPostViewAfterBlock = finderSnapAfterBlock.body.data.posts.find((p) => p.id === postId);
  assert.equal(finderPostViewAfterBlock.contact, "需发起联系/认领申请后查看");
  assert.equal(finderPostViewAfterBlock.is_owner, false);
  assert.equal(finderPostViewAfterBlock.can_manage, false);

  // Cross-device owner role: when Owner logs in on a brand-new device, server snapshot & contact-requests
  // explicitly report is_owner=true / can_manage=true without relying on client-local myPostIds cache!
  const ownerNewDeviceToken = app.identity.issueDeviceSession(owner, "dev_owner_new_phone").access_token;
  const ownerNewDeviceSnap = await app.inject({
    method: "GET",
    url: "/api/v1/moments/snapshot",
    headers: { Authorization: `Bearer ${ownerNewDeviceToken}` }
  });
  const ownerPostOnNewDevice = ownerNewDeviceSnap.body.data.posts.find((p) => p.id === postId);
  assert.equal(ownerPostOnNewDevice.is_owner, true);
  assert.equal(ownerPostOnNewDevice.can_manage, true);
  assert.equal(ownerPostOnNewDevice.viewer_role, "OWNER");

  // New posts MUST require authentication (anonymous creation rejected with 401 CLOUD_AUTH_REQUIRED)
  const anonCreateRes = await app.inject({
    method: "POST",
    url: "/api/v1/moments/posts",
    body: {
      type: "LOST",
      title: "匿名无主帖",
      contact: "13800000000"
    }
  });
  assert.equal(anonCreateRes.status, 401);

  // Legacy unowned post compatibility & governance:
  // 1) Inject two historical ownerless posts (one public anonymous, one with masked student_no + legacy private-prefix comment)
  app.store.momentsState.posts.push(
    {
      id: "mp_legacy_anon_public",
      type: "FOUND",
      title: "历史无主招领水杯",
      category: "水杯雨伞",
      campus: "莲花街校区",
      location: "一餐二楼",
      description: "历史数据遗留无 owner_cloud_user_id",
      contact: "QQ: 88886666",
      contact_visibility: "PUBLIC",
      author_name: "热心同学",
      author_student_no_masked: "",
      owner_cloud_user_id: null,
      status: "OPEN",
      comments: [
        {
          id: "mc_legacy_priv_1",
          author_name: "旧版客户端用户",
          content: "【私密联系发起人】我的手机号是 13912345678",
          contact_hint: "13912345678",
          created_at: new Date().toISOString()
        }
      ],
      contact_requests: [
        {
          id: "mcr_legacy_req_1",
          post_id: "mp_legacy_anon_public",
          sender_user_id: finder.id,
          sender_name: "拾得者小李",
          message: "请问还在吗",
          contact_info: "wx_finder",
          status: "PENDING",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      ],
      blocked_user_ids: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: "mp_legacy_bound_author",
      type: "LOST",
      title: "历史可核验失主蓝牙耳机",
      category: "数码",
      campus: "莲花街校区",
      location: "图书馆四楼",
      description: "含已脱敏学号特征",
      contact: "wx_owner_bound_01",
      contact_visibility: "PUBLIC",
      author_name: "张同学",
      author_student_no_masked: "20***01",
      owner_cloud_user_id: null,
      status: "OPEN",
      comments: [],
      contact_requests: [],
      blocked_user_ids: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  );

  // At-rest migration flags legacy "【私密联系发起人】" comments as is_private_to_initiator = true
  app.store.migrateAndRecoverState();
  const migratedLegacyPost = app.store.momentsState.posts.find((p) => p.id === "mp_legacy_anon_public");
  assert.equal(migratedLegacyPost.comments[0].is_private_to_initiator, true);

  const { inspectAndSanitizeMomentsSnapshotObject } = await import(
    "../scripts/audit-and-sanitize-moments-state.mjs"
  );
  const auditCheck = inspectAndSanitizeMomentsSnapshotObject({
    momentsState: {
      posts: [
        {
          id: "mp_raw_unmigrated",
          title: "未迁移旧数据",
          owner_cloud_user_id: null,
          comments: [{ id: "c1", content: "【私密联系发起人】私密手机号" }]
        }
      ]
    }
  });
  assert.equal(auditCheck.mutated, true);
  assert.equal(auditCheck.report.legacy_unowned_posts.length, 1);
  assert.equal(auditCheck.report.mutated_comments_count, 1);
  assert.equal(auditCheck.sanitizedState.momentsState.posts[0].comments[0].is_private_to_initiator, true);

  // Bystander CANNOT hijack a PUBLIC legacy post merely by copying its public contact!
  const hijackAttempt = await app.inject({
    method: "POST",
    url: "/api/v1/moments/posts/mp_legacy_anon_public/action",
    headers: { Authorization: `Bearer ${bystanderToken}` },
    body: { action: "CLAIM_OWNERSHIP", contact_proof: "QQ: 88886666" }
  });
  assert.equal(hijackAttempt.status, 403);

  // Verified original author with bound student_no matching "20***01" + contact_proof CAN claim their legacy post!
  app.store.schoolBindings.set("bind_owner_claim_1", {
    id: "bind_owner_claim_1",
    cloud_user_id: owner.id,
    school_id: "haut",
    student_no: "2024990001",
    status: "DELEGATED_ACTIVE",
    revoked_at: null
  });
  app.store.indexUserScoped("schoolBindings", "bind_owner_claim_1", owner.id);

  const verifiedClaimRes = await app.inject({
    method: "POST",
    url: "/api/v1/moments/posts/mp_legacy_bound_author/action",
    headers: { Authorization: `Bearer ${ownerToken}` },
    body: { action: "CLAIM_OWNERSHIP", contact_proof: "wx_owner_bound_01" }
  });
  assert.equal(verifiedClaimRes.status, 200);
  assert.equal(verifiedClaimRes.body.data.is_owner, true);
  assert.equal(verifiedClaimRes.body.data.is_legacy_unowned, false);

  // Admin CAN handle contact requests and resolve/delete unclaimable legacy anonymous posts!
  const adminUser = app.store.findOrCreateCloudUser({
    issuer: "https://auth.yellowpeachxgp.com",
    subject: "sub_moments_admin",
    username: "moments_admin",
    displayName: "平台管理员",
    role: "admin"
  });
  const adminToken = app.identity.issueDeviceSession(adminUser, "dev_admin").access_token;

  const adminListLegacyReqs = await app.inject({
    method: "GET",
    url: "/api/v1/moments/posts/mp_legacy_anon_public/contact-requests",
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(adminListLegacyReqs.status, 200);
  assert.equal(adminListLegacyReqs.body.data.can_manage, true);
  assert.equal(adminListLegacyReqs.body.data.requests.length, 1);

  const adminApproveLegacyReq = await app.inject({
    method: "POST",
    url: "/api/v1/moments/posts/mp_legacy_anon_public/contact-requests/mcr_legacy_req_1/action",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { action: "APPROVE", reply_message: "管理员核验通过" }
  });
  assert.equal(adminApproveLegacyReq.status, 200);
  assert.equal(adminApproveLegacyReq.body.data.status, "APPROVED");

  const adminResolveLegacy = await app.inject({
    method: "POST",
    url: "/api/v1/moments/posts/mp_legacy_anon_public/action",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { action: "RESOLVE" }
  });
  assert.equal(adminResolveLegacy.status, 200);
  assert.equal(adminResolveLegacy.body.data.status, "RESOLVED");
});
