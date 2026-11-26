import crypto from "node:crypto";
import { route } from "./route-table.mjs";
import {
  ContractError
} from "../../../../packages/contracts/src/index.mjs";

// Moments is an explicit runtime extension contract pending INF-02/CT contract promotion.
// It is intentionally not represented as an OpenAPI core operation in this module.
export const MOMENTS_EXTENSION_CONTRACT_VERSION = "moments-extension/v0-pending-inf02";

export function createMomentsExtensionRoutes(ctx) {
  const {
    store,
    extractBearer
  } = ctx;

  function computePostMatches(targetPost, allPosts) {
    if (!targetPost) return [];
    const oppositeType = targetPost.type === "LOST" ? "FOUND" : "LOST";
    const tokens = String(targetPost.title + " " + targetPost.description + " " + targetPost.location)
      .toLowerCase()
      .split(/[\s,，。！!？?、·/]+/)
      .filter((t) => t.length >= 2);
    return (allPosts || [])
      .filter((p) => p.id !== targetPost.id && p.type === oppositeType && p.status !== "RESOLVED")
      .map((p) => {
        let score = 0;
        if (p.category === targetPost.category) score += 45;
        if (p.campus === targetPost.campus) score += 25;
        const hay = (p.title + " " + p.description + " " + p.location).toLowerCase();
        for (const tk of tokens) {
          if (hay.includes(tk)) score += 12;
        }
        return { post: p, match_score: Math.min(score, 98) };
      })
      .filter((m) => m.match_score >= 45)
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, 3);
  }

  function tryExtractOptionalViewerAuth(headers, nowMs, method = "GET") {
    try {
      const auth = extractBearer(headers, nowMs, method);
      if (!auth?.cloudUserId) return { cloudUserId: null, roles: [], isAdmin: false };
      const roles = Array.isArray(auth.roles) ? auth.roles : store.getUserRoles(auth.cloudUserId);
      const isAdmin = Boolean(
        store.hasAdminAccess?.(auth.cloudUserId) ||
          roles.some((r) => ["ADMIN", "PLATFORM_OWNER", "SUPPORT_OPERATOR"].includes(r))
      );
      return { cloudUserId: auth.cloudUserId, roles, isAdmin };
    } catch {
      return { cloudUserId: null, roles: [], isAdmin: false };
    }
  }

  function isMomentsAdminAuth(auth) {
    if (!auth?.cloudUserId) return false;
    const roles = Array.isArray(auth.roles) ? auth.roles : store.getUserRoles(auth.cloudUserId);
    return Boolean(
      store.hasAdminAccess?.(auth.cloudUserId) ||
        roles.some((r) => ["ADMIN", "PLATFORM_OWNER", "SUPPORT_OPERATOR"].includes(r))
    );
  }

  function verifyHighEntropyLegacyClaimToken(post, rawClaimToken) {
    const storedHex = String(post?.legacy_claim_token_sha256 || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(storedHex)) return false;
    const candidate = typeof rawClaimToken === "string" ? rawClaimToken.trim() : "";
    if (candidate.length < 32) return false;
    const actualDigest = crypto.createHash("sha256").update(candidate, "utf8").digest();
    const expectedDigest = Buffer.from(storedHex, "hex");
    if (actualDigest.length !== expectedDigest.length) return false;
    return crypto.timingSafeEqual(actualDigest, expectedDigest);
  }

  function verifyUniqueTrustedLegacySsoBinding(post, viewerUserId) {
    if (!viewerUserId || !post) return false;
    const expectedIssuer = String(post.legacy_verified_sso_issuer || "").trim();
    const expectedSubject = String(post.legacy_verified_sso_subject || "").trim();
    if (!expectedIssuer || !expectedSubject) return false;
    const viewerUser = store.users.get(viewerUserId);
    if (!viewerUser || viewerUser.status !== "ACTIVE") return false;
    return viewerUser.issuer === expectedIssuer && viewerUser.subject === expectedSubject;
  }

  function isPrivateMomentsComment(c) {
    return Boolean(
      c?.is_private_to_initiator ||
        String(c?.content || "").trim().startsWith("【私密联系发起人】")
    );
  }

  function projectMomentsPostForViewer(post, allPosts, viewerUserId = null, isViewerAdmin = false) {
    if (!post) return null;
    const isOwner = Boolean(
      viewerUserId && post.owner_cloud_user_id && post.owner_cloud_user_id === viewerUserId
    );
    const isLegacyUnowned = !post.owner_cloud_user_id;
    const canManage = Boolean(isOwner || isViewerAdmin);
    // Self-service legacy claim is ONLY enabled when an original high-entropy claim token digest
    // or trusted unique OIDC issuer+subject binding exists — NEVER via masked student_no or contact!
    const canClaimLegacy = Boolean(
      isLegacyUnowned &&
        viewerUserId &&
        (/^[a-f0-9]{64}$/i.test(String(post.legacy_claim_token_sha256 || "").trim()) ||
          verifyUniqueTrustedLegacySsoBinding(post, viewerUserId))
    );
    const isBlocked = Boolean(
      viewerUserId &&
        Array.isArray(post.blocked_user_ids) &&
        post.blocked_user_ids.includes(viewerUserId)
    );
    const hasApprovedRequest =
      !isBlocked &&
      Boolean(
        viewerUserId &&
          Array.isArray(post.contact_requests) &&
          post.contact_requests.some(
            (r) => r.sender_user_id === viewerUserId && r.status === "APPROVED"
          )
      );

    const sanitized = { ...post };
    delete sanitized.owner_cloud_user_id;
    delete sanitized.contact_requests;
    delete sanitized.blocked_user_ids;
    delete sanitized.legacy_claim_token_sha256;
    delete sanitized.legacy_verified_sso_issuer;
    delete sanitized.legacy_verified_sso_subject;
    if (!isViewerAdmin) {
      delete sanitized.reports_count;
    }

    if (sanitized.contact_visibility === "ON_REQUEST" && sanitized.contact) {
      if (!isOwner && !(isViewerAdmin && isLegacyUnowned) && !hasApprovedRequest) {
        sanitized.contact = "需发起联系/认领申请后查看";
        sanitized.has_protected_contact = true;
      } else {
        sanitized.has_protected_contact = false;
      }
    }

    const blockedSet = new Set(Array.isArray(post.blocked_user_ids) ? post.blocked_user_ids : []);
    const rawComments = Array.isArray(post.comments) ? post.comments : [];
    sanitized.comments = rawComments
      .filter((c) => {
        if (!c || c.hidden_by_block) return false;
        if (c.author_user_id && blockedSet.has(c.author_user_id)) return false;
        if (!isPrivateMomentsComment(c)) return true;
        const isCommentAuthor = Boolean(
          viewerUserId && c.author_user_id && c.author_user_id === viewerUserId
        );
        return isOwner || (isViewerAdmin && isLegacyUnowned) || isCommentAuthor;
      })
      .map((c) => {
        const isCommentAuthor = Boolean(
          viewerUserId && c.author_user_id && c.author_user_id === viewerUserId
        );
        const canSeeHint =
          isOwner || (isViewerAdmin && isLegacyUnowned) || isCommentAuthor || !isPrivateMomentsComment(c);
        const projectedComment = {
          id: c.id,
          author_name: c.author_name,
          content: c.content,
          contact_hint: canSeeHint ? String(c.contact_hint || "") : "",
          is_private_to_initiator: isPrivateMomentsComment(c),
          created_at: c.created_at
        };
        return projectedComment;
      });

    const allPostReqs = Array.isArray(post.contact_requests) ? post.contact_requests : [];
    const viewerContactReq =
      viewerUserId && !isOwner
        ? allPostReqs.find((r) => r && r.sender_user_id === viewerUserId) || null
        : null;

    return {
      ...sanitized,
      viewer_role: isOwner ? "OWNER" : isViewerAdmin ? "ADMIN" : viewerUserId ? "AUTHENTICATED" : "GUEST",
      is_owner: isOwner,
      can_manage: canManage,
      is_legacy_unowned: isLegacyUnowned,
      can_claim_legacy: canClaimLegacy,
      contact_requests_count: allPostReqs.length,
      pending_contact_requests_count: canManage
        ? allPostReqs.filter((r) => r && r.status === "PENDING").length
        : 0,
      has_my_contact_request: Boolean(viewerContactReq),
      my_contact_request_status: viewerContactReq ? String(viewerContactReq.status || "PENDING") : null,
      matched_clues: computePostMatches(post, allPosts || []).map((m) => ({
        id: m.post.id,
        type: m.post.type,
        title: m.post.title,
        location: m.post.location,
        contact: m.post.contact_visibility === "ON_REQUEST" ? "需申请查看" : m.post.contact,
        match_score: m.match_score
      }))
    };
  }

  function projectMomentsBookForViewer(book, viewerUserId = null, isViewerAdmin = false) {
    if (!book) return null;
    const isOwner = Boolean(
      viewerUserId && book.owner_cloud_user_id && book.owner_cloud_user_id === viewerUserId
    );
    const isLegacyUnowned = !book.owner_cloud_user_id;
    const sanitized = { ...book };
    delete sanitized.owner_cloud_user_id;
    return {
      ...sanitized,
      is_owner: isOwner,
      can_manage: Boolean(isOwner || isViewerAdmin),
      is_legacy_unowned: isLegacyUnowned
    };
  }

  function projectAntiLostTagForOwnerOrAdmin(tag, viewerUserId = null, isViewerAdmin = false) {
    if (!tag) return null;
    const isOwner = Boolean(
      viewerUserId && tag.owner_cloud_user_id && tag.owner_cloud_user_id === viewerUserId
    );
    if (!isOwner && !isViewerAdmin) return null;
    const sanitized = { ...tag };
    delete sanitized.owner_cloud_user_id;
    return {
      ...sanitized,
      is_owner: isOwner,
      can_manage: true
    };
  }

  // Internal stored form: preserves idempotency_key + sender_user_id metadata.
  // NEVER use the public projection to write back storage — the old version of
  // this function stripped idempotency_key on every read-then-write, silently
  // breaking send-retry dedupe.
  function normalizeStoredMessages(reqItem, post) {
    if (!reqItem) return [];
    if (Array.isArray(reqItem.messages) && reqItem.messages.length > 0) {
      return reqItem.messages.map((m) => ({
        id: String(m.id || "mcm_legacy"),
        sender_role: m.sender_role === "OWNER" ? "OWNER" : "REQUESTER",
        sender_user_id: m.sender_user_id || (m.sender_role === "OWNER" ? post?.owner_cloud_user_id || null : reqItem.sender_user_id || null),
        sender_name: String(m.sender_name || (m.sender_role === "OWNER" ? post?.author_name || "发起人" : reqItem.sender_name || "河工大同学")),
        content: String(m.content || ""),
        idempotency_key: m.idempotency_key || null,
        created_at: m.created_at || reqItem.created_at
      }));
    }
    const seeded = [];
    if (reqItem.message) {
      seeded.push({
        id: `${reqItem.id}_init`,
        sender_role: "REQUESTER",
        sender_user_id: reqItem.sender_user_id || null,
        sender_name: String(reqItem.sender_name || "河工大同学"),
        content: String(reqItem.message),
        idempotency_key: reqItem.idempotency_key || null,
        created_at: reqItem.created_at
      });
    }
    if (reqItem.reply_message) {
      seeded.push({
        id: `${reqItem.id}_reply`,
        sender_role: "OWNER",
        sender_user_id: post?.owner_cloud_user_id || null,
        sender_name: String(post?.author_name || "发起人"),
        content: String(reqItem.reply_message),
        idempotency_key: reqItem.reply_idempotency_key || null,
        created_at: reqItem.updated_at || reqItem.created_at
      });
    }
    return seeded;
  }

  // Public projection: strips internal metadata (idempotency_key, sender_user_id)
  function projectContactMessages(reqItem, post) {
    return normalizeStoredMessages(reqItem, post).map((m) => ({
      id: m.id,
      sender_role: m.sender_role,
      sender_name: m.sender_name,
      content: m.content,
      created_at: m.created_at
    }));
  }

  function messagePayloadHash(content) {
    return crypto.createHash("sha256").update(String(content), "utf8").digest("hex");
  }

  // Canonical payload v2: structured serialization with a fixed key order —
  // separator-joining was ambiguous ("a|b"+"c" collides with "a"+"b|c") and
  // the create path used a different formula than the append path, so a lost
  // response retried through another entry 409'd a legitimate retry.
  const CONTACT_CANONICAL_VERSION = 2;
  function canonicalContactMessage({ scope, actorUserId, operation, content, contact }) {
    return JSON.stringify({
      v: CONTACT_CANONICAL_VERSION,
      scope: String(scope),
      actor: String(actorUserId || ""),
      op: String(operation),
      content: String(content || ""),
      contact: String(contact || "")
    });
  }

  // Legacy receipt verification: pre-v2 entries only prove the key was used —
  // verify under BOTH historical formulas before deciding; unverifiable
  // payload stays a conservative dedupe, never a silent new write.
  function verifyReceiptPayload(prior, canonicalV2, legacyInitialConcat, legacyContentOnly) {
    if (prior.canonical_version === CONTACT_CANONICAL_VERSION) {
      return prior.payload_hash === messagePayloadHash(canonicalV2) ? "MATCH" : "CONFLICT";
    }
    // v1 / unknown-version receipt: try every old formula.
    const candidates = [legacyInitialConcat, legacyContentOnly].filter((x) => x != null);
    for (const c of candidates) {
      if (prior.payload_hash === messagePayloadHash(c)) return "MATCH_LEGACY";
    }
    return "LEGACY_UNPROVABLE";
  }

  /**
   * Unified private-chat write path. Every append (initial extra message,
   * owner reply, requester reply) goes through here so participant, block /
   * close, length, per-actor rate-limit and idempotency rules can never drift
   * apart between entry points.
   *
   * Idempotency receipts live on reqItem._msgReceipts keyed by
   * (sender_user_id, operation, key) — independent of the 50-message visible
   * window so truncation cannot lose dedupe evidence. Same key + different
   * payload => 409.
   */
  function appendThreadMessage(post, reqItem, { actorUserId, actorRole, actorName, content, contactInfo = "", idempotencyKey, nowMs, isAdminOverride = false }) {
    const nowIso = new Date(nowMs).toISOString();
    const senderUserId = actorUserId || (actorRole === "OWNER" ? post.owner_cloud_user_id : reqItem.sender_user_id);
    if (!isAdminOverride) {
      const isParticipant =
        senderUserId &&
        (senderUserId === post.owner_cloud_user_id || senderUserId === reqItem.sender_user_id);
      if (!isParticipant) {
        throw new ContractError("FORBIDDEN", "非会话参与者不能发送私信");
      }
    }
    if (post.status === "RESOLVED" || post.status === "CLOSED") {
      throw new ContractError("CONFLICT", "该失物招领帖已结案或关闭联系，无法继续发送私信");
    }
    if (reqItem.status === "BLOCKED" || reqItem.status === "REJECTED") {
      throw new ContractError("CONFLICT", "当前联系申请已被拒绝或屏蔽，无法继续发送私信");
    }
    if (Array.isArray(post.blocked_user_ids) && post.blocked_user_ids.includes(reqItem.sender_user_id)) {
      throw new ContractError("FORBIDDEN", "当前会话已被屏蔽");
    }
    const clean = String(content || "").trim();
    if (!clean || clean.length > 240) {
      throw new ContractError("BAD_REQUEST", "私信内容长度需在 1–240 字之间");
    }

    // Idempotent receipt check BEFORE rate limiting: a retry must be free.
    // Canonical v2 (R4-C1): the same fixed-key-order formula as every other
    // entry — append no longer hashes raw content under a v1 receipt.
    const receiptScope = senderUserId + "|message|" + (idempotencyKey || "");
    const canonicalV2 = canonicalContactMessage({
      scope: "p:" + post.id + "|t:" + reqItem.id,
      actorUserId: senderUserId,
      operation: "message",
      content: clean,
      contact: contactInfo || ""
    });
    if (idempotencyKey) {
      if (!reqItem._msgReceipts || typeof reqItem._msgReceipts !== "object") {
        reqItem._msgReceipts = {};
      }
      const prior = reqItem._msgReceipts[receiptScope];
      if (prior) {
        const verdict = verifyReceiptPayload(
          prior,
          canonicalV2,
          // legacy create-path concat formula
          clean + "|" + String(contactInfo || ""),
          // legacy append content-only formula
          clean
        );
        if (verdict === "CONFLICT") {
          throw new ContractError(
            "CONFLICT",
            "同一 Idempotency-Key 被用于不同的消息内容，已拒绝"
          );
        }
        // MATCH / MATCH_LEGACY / LEGACY_UNPROVABLE → conservative dedupe.
        return {
          appended: false,
          duplicate: true,
          message: prior.message_snapshot || null,
          legacy_unprovable: verdict === "LEGACY_UNPROVABLE"
        };
      }
    }

    const stored = normalizeStoredMessages(reqItem, post);
    const recentMine = stored.filter(
      (m) =>
        (m.sender_user_id || (m.sender_role === "OWNER" ? post.owner_cloud_user_id : reqItem.sender_user_id)) === senderUserId &&
        nowMs - new Date(m.created_at).getTime() < 60_000
    );
    if (recentMine.length >= 6) {
      throw new ContractError("RATE_LIMITED", "私信发送过于频繁，请稍后再试");
    }

    const msg = {
      id: "mcm_" + crypto.randomUUID().slice(0, 8),
      sender_role: actorRole === "OWNER" ? "OWNER" : "REQUESTER",
      sender_user_id: senderUserId || null,
      sender_name: String(actorName || "河工大同学").slice(0, 24),
      content: clean,
      idempotency_key: idempotencyKey || null,
      created_at: nowIso
    };
    stored.push(msg);
    reqItem.messages = stored.slice(-50);

    if (idempotencyKey) {
      reqItem._msgReceipts[receiptScope] = {
        message_id: msg.id,
        canonical_version: CONTACT_CANONICAL_VERSION,
        payload_hash: messagePayloadHash(canonicalV2),
        created_at: nowIso,
        message_snapshot: {
          id: msg.id,
          sender_role: msg.sender_role,
          sender_name: msg.sender_name,
          content: msg.content,
          created_at: msg.created_at
        }
      };
      const keys = Object.keys(reqItem._msgReceipts);
      if (keys.length > 100) {
        keys
          .sort(
            (a, b) =>
              new Date(reqItem._msgReceipts[a].created_at || 0).getTime() -
              new Date(reqItem._msgReceipts[b].created_at || 0).getTime()
          )
          .slice(0, keys.length - 100)
          .forEach((k) => delete reqItem._msgReceipts[k]);
      }
    }
    return { appended: true, duplicate: false, message: msg };
  }

  function projectContactRequestForViewer(reqItem, post, { canSeeInitiatorContact = false, canSeeSenderContact = true } = {}) {
    if (!reqItem) return null;
    return {
      id: reqItem.id,
      post_id: reqItem.post_id,
      sender_name: reqItem.sender_name,
      message: reqItem.message,
      contact_info: canSeeSenderContact ? String(reqItem.contact_info || "") : "",
      status: reqItem.status,
      reply_message: reqItem.reply_message || null,
      messages: projectContactMessages(reqItem, post),
      initiator_contact: canSeeInitiatorContact ? post?.contact || null : null,
      created_at: reqItem.created_at,
      updated_at: reqItem.updated_at
    };
  }

  return [
  route("GET", "/api/v1/moments/snapshot", "getMomentsSnapshot", "public", async ({ query, headers, nowMs }) => {
    const { cloudUserId: viewerUserId, isAdmin: isViewerAdmin } = tryExtractOptionalViewerAuth(
      headers,
      nowMs,
      "GET"
    );
    const ms = store.momentsState || { posts: [], book_listings: [], anti_lost_tags: [], isbn_catalog: [] };
    const typeFilter = (query.get("type") || "").trim().toUpperCase();
    const campusFilter = (query.get("campus") || "").trim();
    const kw = (query.get("keyword") || "").trim().toLowerCase();
    let posts = Array.isArray(ms.posts) ? ms.posts : [];
    if (typeFilter === "LOST" || typeFilter === "FOUND") {
      posts = posts.filter((p) => p.type === typeFilter);
    }
    if (campusFilter && campusFilter !== "全部" && campusFilter !== "ALL") {
      posts = posts.filter((p) => p.campus === campusFilter);
    }
    if (kw) {
      posts = posts.filter((p) =>
        (p.title + " " + p.category + " " + p.location + " " + p.description).toLowerCase().includes(kw)
      );
    }
    const enrichedPosts = posts.map((p) =>
      projectMomentsPostForViewer(p, ms.posts || [], viewerUserId, isViewerAdmin)
    );
    const projectedBooks = (Array.isArray(ms.book_listings) ? ms.book_listings : [])
      .map((b) => projectMomentsBookForViewer(b, viewerUserId, isViewerAdmin))
      .filter(Boolean);
    // Anti-lost tags contain private owner_contact & finder_contact — return ONLY tags owned by viewer (or admin)!
    const visibleAntiLostTags = viewerUserId
      ? (Array.isArray(ms.anti_lost_tags) ? ms.anti_lost_tags : [])
          .map((t) => projectAntiLostTagForOwnerOrAdmin(t, viewerUserId, isViewerAdmin))
          .filter(Boolean)
      : [];
    return {
      status: 200,
      code: "MOMENTS_SNAPSHOT_OK",
      data: {
        school_id: "haut",
        updated_at: ms.updated_at || new Date().toISOString(),
        posts: enrichedPosts,
        book_listings: projectedBooks,
        anti_lost_tags: visibleAntiLostTags,
        isbn_catalog: Array.isArray(ms.isbn_catalog) ? ms.isbn_catalog : []
      }
    };
  }),

  route("POST", "/api/v1/moments/posts", "createMomentsPost", "public", async ({ body, headers, nowMs }) => {
    const { cloudUserId: viewerUserId, isAdmin: isViewerAdmin } = tryExtractOptionalViewerAuth(
      headers,
      nowMs,
      "POST"
    );
    const title = String(body?.title || "").trim().slice(0, 64);
    if (!title) throw new ContractError("BAD_REQUEST", "请填写物品名称或标题");

    if (
      body?.owner_cloud_user_id !== undefined &&
      body?.owner_cloud_user_id !== null &&
      String(body.owner_cloud_user_id).trim() !== ""
    ) {
      if (!viewerUserId || String(body.owner_cloud_user_id).trim() !== viewerUserId) {
        throw new ContractError(
          "FORBIDDEN",
          "帖子所有者必须由当前登录认证身份决定，禁止匿名或跨账号指定 owner_cloud_user_id"
        );
      }
    }

    if (!viewerUserId) {
      throw new ContractError(
        "CLOUD_AUTH_REQUIRED",
        "发布寻物或招领信息需先登录云端账号，以便后续跨设备结案、删除及处理联系申请"
      );
    }

    const contactVisibility =
      String(body?.contact_visibility || "PUBLIC").toUpperCase() === "ON_REQUEST"
        ? "ON_REQUEST"
        : "PUBLIC";

    const requestedId = body?.id ? String(body.id).trim().slice(0, 40) : "";
    const existingPosts = store.momentsState.posts || [];
    if (requestedId && existingPosts.some((p) => p.id === requestedId)) {
      throw new ContractError("CONFLICT", "该帖子 ID 已存在，禁止覆盖已有失物招领帖或联系申请");
    }

    const nowIso = new Date(nowMs).toISOString();
    const newPost = {
      id: requestedId || ("mp_" + crypto.randomUUID().slice(0, 10)),
      type: String(body?.type || "LOST").toUpperCase() === "FOUND" ? "FOUND" : "LOST",
      title,
      category: String(body?.category || "其他物品").trim().slice(0, 24),
      campus: String(body?.campus || "莲花街校区").trim().slice(0, 24),
      location: String(body?.location || "校内").trim().slice(0, 64),
      description: String(body?.description || "").trim().slice(0, 360),
      contact: String(body?.contact || "").trim().slice(0, 64),
      reward_note: String(body?.reward_note || "").trim().slice(0, 64),
      status: "OPEN",
      author_name: String(body?.author_name || "河工大同学").trim().slice(0, 24),
      author_student_no_masked: String(body?.author_student_no_masked || "").trim().slice(0, 16),
      owner_cloud_user_id: viewerUserId,
      contact_visibility: contactVisibility,
      likes_count: 0,
      favorites_count: 0,
      comments: [],
      contact_requests: [],
      blocked_user_ids: [],
      reports_count: 0,
      created_at: nowIso,
      updated_at: nowIso
    };
    store.momentsState.posts = [newPost, ...existingPosts].slice(0, 200);
    store.momentsState.updated_at = nowIso;
    store.saveSnapshot();
    return {
      status: 201,
      code: "MOMENTS_POST_CREATED",
      data: projectMomentsPostForViewer(newPost, store.momentsState.posts, viewerUserId, isViewerAdmin)
    };
  }),

  route("POST", "/api/v1/moments/posts/{postId}/comments", "addMomentsPostComment", "public", async ({ params, body, headers, nowMs }) => {
    const { cloudUserId: viewerUserId, isAdmin: isViewerAdmin } = tryExtractOptionalViewerAuth(
      headers,
      nowMs,
      "POST"
    );
    const post = (store.momentsState.posts || []).find((p) => p.id === params.postId);
    if (!post) throw new ContractError("NOT_FOUND", "未找到该寻物/招领帖");
    if (viewerUserId && Array.isArray(post.blocked_user_ids) && post.blocked_user_ids.includes(viewerUserId)) {
      throw new ContractError("FORBIDDEN", "发起人已屏蔽来自当前账号的留言或联系请求");
    }
    const content = String(body?.content || "").trim().slice(0, 240);
    if (!content) throw new ContractError("BAD_REQUEST", "留言内容不能为空");
    const isPrivate =
      Boolean(body?.is_private_to_initiator) || content.startsWith("【私密联系发起人】");
    if (isPrivate && !viewerUserId) {
      throw new ContractError(
        "CLOUD_AUTH_REQUIRED",
        "发送仅发起人可见的私密认领留言需先登录云端账号，或使用 /contact-requests 接口"
      );
    }
    const nowIso = new Date(nowMs).toISOString();
    const comment = {
      id: "mc_" + crypto.randomUUID().slice(0, 8),
      author_user_id: viewerUserId || null,
      author_name: String(body?.author_name || "热心同学").trim().slice(0, 24),
      content,
      contact_hint: String(body?.contact_hint || "").trim().slice(0, 48),
      is_private_to_initiator: isPrivate,
      created_at: nowIso
    };
    if (!Array.isArray(post.comments)) post.comments = [];
    post.comments.push(comment);
    post.updated_at = nowIso;
    store.momentsState.updated_at = nowIso;
    store.saveSnapshot();
    return {
      status: 201,
      code: "MOMENTS_COMMENT_ADDED",
      data: projectMomentsPostForViewer(post, store.momentsState.posts, viewerUserId, isViewerAdmin)
    };
  }),

  route(
    "POST",
    "/api/v1/moments/posts/{postId}/contact-requests",
    "createMomentsContactRequest",
    "bearer",
    async ({ auth, params, body, headers, nowMs }) => {
      const post = (store.momentsState.posts || []).find((p) => p.id === params.postId);
      if (!post) throw new ContractError("NOT_FOUND", "未找到该寻物/招领帖");
      if (post.owner_cloud_user_id && post.owner_cloud_user_id === auth.cloudUserId) {
        throw new ContractError(
          "BAD_REQUEST",
          "您是该帖发起人，无需向自己发送认领申请；请在详情页查看并回复他人的私信"
        );
      }
      if (post.status === "RESOLVED" || post.status === "CLOSED") {
        throw new ContractError("CONFLICT", "该失物招领帖已结案或关闭联系");
      }
      if (!Array.isArray(post.blocked_user_ids)) post.blocked_user_ids = [];
      if (post.blocked_user_ids.includes(auth.cloudUserId)) {
        throw new ContractError("FORBIDDEN", "发起人已拒绝或屏蔽来自当前账号的联系申请");
      }
      const message = String(body?.message || "").trim();
      if (!message || message.length > 240) {
        throw new ContractError("BAD_REQUEST", "联系/认领说明长度需在 1–240 字之间");
      }
      const contactInfo = String(body?.contact_info || body?.contact_hint || "").trim().slice(0, 64);
      const idempotencyKey = String(
        headers?.["idempotency-key"] ||
          headers?.["Idempotency-Key"] ||
          body?.client_request_id ||
          body?.idempotency_key ||
          ""
      ).trim();

      if (!Array.isArray(post.contact_requests)) post.contact_requests = [];
      if (idempotencyKey) {
        const initialScope = auth.cloudUserId + "|message|" + idempotencyKey;
        const dup = post.contact_requests.find((r) => {
          if (r.sender_user_id !== auth.cloudUserId) return false;
          // Authoritative source: per-(actor|op|key) receipts survive the
          // 50-message visible window, so a truncated-away initial message
          // still dedupes correctly.
          if (r._msgReceipts && r._msgReceipts[initialScope]) return true;
          // Legacy evidence (pre-receipt records): only the request-level key
          // or a still-visible keyed message proves the key was used here.
          return (
            r.idempotency_key === idempotencyKey ||
            (Array.isArray(r.messages) && r.messages.some((m) => m.idempotency_key === idempotencyKey))
          );
        });
        if (dup) {
          const receipt = dup._msgReceipts?.[initialScope];
          if (receipt) {
            // Same canonical helper as the append path — one wire formula for
            // every entry point (C1/C2).
            const dupCanonical = canonicalContactMessage({
              scope: "p:" + post.id + "|t:" + dup.id,
              actorUserId: auth.cloudUserId,
              operation: "message",
              content: message,
              contact: contactInfo
            });
            const verdict = verifyReceiptPayload(
              receipt,
              dupCanonical,
              `${message}|${contactInfo}`,
              message
            );
            if (verdict === "CONFLICT") {
              throw new ContractError(
                "CONFLICT",
                "同一 Idempotency-Key 被用于不同的消息内容，已拒绝"
              );
            }
          } else {
            // LEGACY_RECEIPT_UNKNOWN: key is provably used by this thread but
            // the original payload hash is unrecoverable (message truncated or
            // written before receipts existed). Conservative dedupe — return
            // the existing thread rather than 409 a legitimate retry or create
            // a duplicate thread.
            const keyedMsg = (dup.messages || []).find((m) => m.idempotency_key === idempotencyKey);
            const keyedPayload = keyedMsg ? keyedMsg.content : null;
            if (keyedPayload != null && String(keyedPayload).trim() !== message) {
              throw new ContractError(
                "CONFLICT",
                "同一 Idempotency-Key 被用于不同的消息内容，已拒绝"
              );
            }
          }
          return {
            status: 200,
            code: "CONTACT_REQUEST_DUPLICATE",
            data: projectContactRequestForViewer(dup, post, {
              canSeeInitiatorContact: dup.status === "APPROVED",
              canSeeSenderContact: true
            })
          };
        }
      }

      const nowIso = new Date(nowMs).toISOString();
      const senderUser = store.users.get(auth.cloudUserId);
      const resolvedSenderName = String(
        body?.sender_name || senderUser?.display_name || "河工大同学"
      )
        .trim()
        .slice(0, 24);

      const existingThread = post.contact_requests.find(
        (r) => r.sender_user_id === auth.cloudUserId && (r.status === "PENDING" || r.status === "APPROVED")
      );
      if (existingThread) {
        const appendRes = appendThreadMessage(post, existingThread, {
          actorUserId: auth.cloudUserId,
          actorRole: "REQUESTER",
          actorName: resolvedSenderName,
          content: message,
          contactInfo,
          idempotencyKey: idempotencyKey || null,
          nowMs
        });
        if (appendRes.duplicate) {
          return {
            status: 200,
            code: "CONTACT_REQUEST_DUPLICATE",
            data: projectContactRequestForViewer(existingThread, post, {
              canSeeInitiatorContact: existingThread.status === "APPROVED",
              canSeeSenderContact: true
            })
          };
        }
        existingThread.message = message;
        if (contactInfo) existingThread.contact_info = contactInfo;
        existingThread.updated_at = nowIso;
        post.updated_at = nowIso;
        store.momentsState.updated_at = nowIso;
        if (post.owner_cloud_user_id && post.owner_cloud_user_id !== auth.cloudUserId) {
          store.addNotification({
            cloudUserId: post.owner_cloud_user_id,
            category: "MOMENTS_CONTACT_MESSAGE",
            title: `收到「${post.title}」的新认领私信`,
            body: `${resolvedSenderName}：${message}`
          });
        }
        store.saveSnapshot();
        return {
          status: 201,
          code: "CONTACT_MESSAGE_APPENDED",
          data: projectContactRequestForViewer(existingThread, post, {
            canSeeInitiatorContact: existingThread.status === "APPROVED",
            canSeeSenderContact: true
          })
        };
      }

      const recentBySender = post.contact_requests.filter(
        (r) =>
          r.sender_user_id === auth.cloudUserId &&
          nowMs - new Date(r.created_at).getTime() < 60_000
      );
      if (recentBySender.length >= 3) {
        throw new ContractError("RATE_LIMITED", "发送过于频繁，请稍后再试");
      }

      const initialMsgId = "mcm_" + crypto.randomUUID().slice(0, 8);
      const newReqId = "mcr_" + crypto.randomUUID().slice(0, 10);
      const initialCanonicalV2 = canonicalContactMessage({
        scope: "p:" + post.id + "|t:" + newReqId,
        actorUserId: auth.cloudUserId,
        operation: "message",
        content: message,
        contact: contactInfo
      });
      const reqItem = {
        id: newReqId,
        post_id: post.id,
        sender_user_id: auth.cloudUserId,
        sender_name: resolvedSenderName,
        message,
        contact_info: contactInfo,
        idempotency_key: idempotencyKey || null,
        status: "PENDING",
        reply_message: null,
        messages: [
          {
            id: initialMsgId,
            sender_role: "REQUESTER",
            sender_name: resolvedSenderName,
            content: message,
            idempotency_key: idempotencyKey || null,
            created_at: nowIso
          }
        ],
        // Seed the durable receipt for the initial message: dedupe evidence
        // must survive the 50-message visible window (C7).
        _msgReceipts: idempotencyKey
          ? {
              [auth.cloudUserId + "|message|" + idempotencyKey]: {
                message_id: initialMsgId,
                canonical_version: CONTACT_CANONICAL_VERSION,
                payload_hash: messagePayloadHash(initialCanonicalV2),
                created_at: nowIso,
                message_snapshot: {
                  id: initialMsgId,
                  sender_role: "REQUESTER",
                  sender_name: resolvedSenderName,
                  content: message,
                  created_at: nowIso
                }
              }
            }
          : {},
        created_at: nowIso,
        updated_at: nowIso
      };
      post.contact_requests.push(reqItem);
      post.updated_at = nowIso;
      store.momentsState.updated_at = nowIso;
      if (post.owner_cloud_user_id && post.owner_cloud_user_id !== auth.cloudUserId) {
        store.addNotification({
          cloudUserId: post.owner_cloud_user_id,
          category: "MOMENTS_CONTACT_REQUEST",
          title: `收到「${post.title}」的认领/联系申请`,
          body: `${reqItem.sender_name}：${message}`
        });
      }
      store.saveSnapshot();
      return {
        status: 201,
        code: "CONTACT_REQUEST_CREATED",
        data: projectContactRequestForViewer(reqItem, post, {
          canSeeInitiatorContact: false,
          canSeeSenderContact: true
        })
      };
    }
  ),

  route(
    "GET",
    "/api/v1/moments/posts/{postId}/contact-requests",
    "listMomentsContactRequests",
    "bearer",
    async ({ auth, params }) => {
      const post = (store.momentsState.posts || []).find((p) => p.id === params.postId);
      if (!post) throw new ContractError("NOT_FOUND", "未找到该寻物/招领帖");
      const allReqs = Array.isArray(post.contact_requests) ? post.contact_requests : [];
      const isOwner = Boolean(post.owner_cloud_user_id && post.owner_cloud_user_id === auth.cloudUserId);
      const isAdmin = isMomentsAdminAuth(auth);
      const canManageRequests = Boolean(isOwner || (isAdmin && !post.owner_cloud_user_id));
      const isSenderBlocked =
        Array.isArray(post.blocked_user_ids) && post.blocked_user_ids.includes(auth.cloudUserId);
      const visibleReqs = canManageRequests
        ? allReqs.map((r) =>
            projectContactRequestForViewer(r, post, {
              canSeeInitiatorContact: false,
              canSeeSenderContact: true
            })
          )
        : allReqs
            .filter((r) => r.sender_user_id === auth.cloudUserId)
            .map((r) =>
              projectContactRequestForViewer(r, post, {
                canSeeInitiatorContact: !isSenderBlocked && r.status === "APPROVED",
                canSeeSenderContact: true
              })
            );
      return {
        status: 200,
        code: "CONTACT_REQUESTS_LISTED",
        data: {
          post_id: post.id,
          is_owner: isOwner,
          can_manage: canManageRequests,
          is_legacy_unowned: !post.owner_cloud_user_id,
          requests: visibleReqs
        }
      };
    }
  ),

  route(
    "POST",
    "/api/v1/moments/posts/{postId}/contact-requests/{requestId}/action",
    "handleMomentsContactRequestAction",
    "bearer",
    async ({ auth, params, body, headers, nowMs }) => {
      const post = (store.momentsState.posts || []).find((p) => p.id === params.postId);
      if (!post) throw new ContractError("NOT_FOUND", "未找到该寻物/招领帖");
      const allReqs = Array.isArray(post.contact_requests) ? post.contact_requests : [];
      const reqItem = allReqs.find((r) => r.id === params.requestId);
      if (!reqItem) throw new ContractError("NOT_FOUND", "未找到该联系申请");
      const isOwner = Boolean(post.owner_cloud_user_id && post.owner_cloud_user_id === auth.cloudUserId);
      const isAdmin = isMomentsAdminAuth(auth);
      const canManageRequests = Boolean(isOwner || (isAdmin && !post.owner_cloud_user_id));
      const isSender = reqItem.sender_user_id === auth.cloudUserId;
      if (!canManageRequests && !isSender && !(isAdmin && ["REJECT", "BLOCK", "REPORT"].includes(String(body?.action || "").toUpperCase()))) {
        throw new ContractError("FORBIDDEN", "无权操作他人的失物招领联系申请");
      }
      const action = String(body?.action || "").toUpperCase();
      const nowIso = new Date(nowMs).toISOString();
      if (action === "APPROVE") {
        if (!canManageRequests) throw new ContractError("FORBIDDEN", "仅发起人（或历史无主帖管理员）可同意公开联系方式");
        if (Array.isArray(post.blocked_user_ids) && post.blocked_user_ids.includes(reqItem.sender_user_id)) {
          throw new ContractError("CONFLICT", "该申请人已被拉黑，请先解除屏蔽");
        }
        // Idempotent status transition with an explicit allowed-state table:
        // only PENDING may flip to APPROVED; a repeat APPROVE on an already
        // approved thread is a no-op — never re-append, never re-notify.
        const wasApproved = reqItem.status === "APPROVED";
        const approveKey = String(
          headers?.["idempotency-key"] ||
            headers?.["Idempotency-Key"] ||
            body?.idempotency_key ||
            body?.client_message_id ||
            ""
        ).trim();
        let appendedReply = null;
        const cleanReply = String(body?.reply_message || "").trim();
        if (cleanReply) {
          // Any attached text goes through the ONE write path FIRST —
          // closed-post / rate-limit / payload-hash rules gate the append
          // before the status is allowed to change. A failed append must
          // never leave a half-applied APPROVED transition behind.
          const actorUser = store.users.get(auth.cloudUserId);
          const appendRes = appendThreadMessage(post, reqItem, {
            actorUserId: auth.cloudUserId,
            actorRole: "OWNER",
            actorName: String(post.author_name || actorUser?.display_name || "发起人").slice(0, 24),
            content: cleanReply,
            idempotencyKey: approveKey || null,
            nowMs,
            isAdminOverride: Boolean(isAdmin && !isOwner && !isSender)
          });
          appendedReply = appendRes.message?.content || null;
        }
        if (!wasApproved) {
          reqItem.status = "APPROVED";
          if (appendedReply) reqItem.reply_message = appendedReply;
          if (reqItem.sender_user_id && reqItem.sender_user_id !== auth.cloudUserId) {
            store.addNotification({
              cloudUserId: reqItem.sender_user_id,
              category: "MOMENTS_CONTACT_APPROVED",
              title: `发起人已同意公开「${post.title}」的联系方式`,
              body: reqItem.reply_message
                ? `发起人附言：${reqItem.reply_message}`
                : "您现在可在该帖详情中查看发起人联系方式或继续私信沟通"
            });
          }
          if (isAdmin && !isOwner) {
            store.recordAudit({
              actor_kind: "ADMIN",
              actor_ref: auth.cloudUserId,
              action: "ADMIN_APPROVE_LEGACY_POST_CONTACT_REQUEST",
              resource_kind: "moments_contact_request",
              resource_ref: reqItem.id,
              outcome: "APPROVED",
              detail: { post_id: post.id }
            });
          }
        } else if (appendedReply) {
          // Already APPROVED + a (non-duplicate) follow-up note — keep the
          // latest owner note for display but never re-notify.
          reqItem.reply_message = appendedReply;
        }
      } else if (action === "REPLY") {
        if (!canManageRequests && !isSender) {
          throw new ContractError("FORBIDDEN", "仅发起人或申请人本人可在该私信会话中回复");
        }
        const replyMsg = String(body?.reply_message || body?.message || "").trim();
        const replyIdemKey = String(
          headers?.["idempotency-key"] ||
            headers?.["Idempotency-Key"] ||
            body?.idempotency_key ||
            body?.client_message_id ||
            ""
        ).trim();
        const actorRole = canManageRequests && !isSender ? "OWNER" : "REQUESTER";
        const actorUser = store.users.get(auth.cloudUserId);
        const actorName =
          actorRole === "OWNER"
            ? String(post.author_name || actorUser?.display_name || "发起人").slice(0, 24)
            : String(reqItem.sender_name || actorUser?.display_name || "河工大同学").slice(0, 24);
        // Unified write path: participant / block / CLOSED post / length /
        // per-actor rate-limit / idempotent dedupe — previously REPLY skipped
        // the closed-post and rate-limit checks entirely.
        const appendRes = appendThreadMessage(post, reqItem, {
          actorUserId: auth.cloudUserId,
          actorRole,
          actorName,
          content: replyMsg,
          idempotencyKey: replyIdemKey || null,
          nowMs,
          isAdminOverride: Boolean(isAdmin && !isOwner && !isSender)
        });
        if (appendRes.duplicate) {
          return {
            status: 200,
            code: "CONTACT_MESSAGE_DUPLICATE",
            data: { duplicated: true, message: appendRes.message }
          };
        }
        if (actorRole === "OWNER") {
          reqItem.reply_message = appendRes.message.content;
          if (reqItem.sender_user_id && reqItem.sender_user_id !== auth.cloudUserId) {
            store.addNotification({
              cloudUserId: reqItem.sender_user_id,
              category: "MOMENTS_CONTACT_REPLY",
              title: `发起人回复了您在「${post.title}」的私信`,
              body: `${actorName}：${appendRes.message.content}`
            });
          }
        } else {
          reqItem.message = appendRes.message.content;
          if (post.owner_cloud_user_id && post.owner_cloud_user_id !== auth.cloudUserId) {
            store.addNotification({
              cloudUserId: post.owner_cloud_user_id,
              category: "MOMENTS_CONTACT_MESSAGE",
              title: `收到「${post.title}」的新认领私信`,
              body: `${actorName}：${appendRes.message.content}`
            });
          }
        }
      } else if (action === "REJECT") {
        if (!canManageRequests && !isAdmin) throw new ContractError("FORBIDDEN", "仅发起人或管理员可拒绝联系申请");
        reqItem.status = "REJECTED";
        if (isAdmin && !isOwner) {
          store.recordAudit({
            actor_kind: "ADMIN",
            actor_ref: auth.cloudUserId,
            action: "ADMIN_REJECT_MOMENTS_CONTACT_REQUEST",
            resource_kind: "moments_contact_request",
            resource_ref: reqItem.id,
            outcome: "REJECTED",
            detail: { post_id: post.id }
          });
        }
      } else if (action === "BLOCK") {
        if (!canManageRequests && !isAdmin) throw new ContractError("FORBIDDEN", "仅发起人或管理员可屏蔽申请人");
        if (!Array.isArray(post.blocked_user_ids)) post.blocked_user_ids = [];
        if (!post.blocked_user_ids.includes(reqItem.sender_user_id)) {
          post.blocked_user_ids.push(reqItem.sender_user_id);
        }
        // Revoke ALL existing requests (including previously APPROVED ones) & hide comments from this blocked user!
        for (const r of allReqs) {
          if (r.sender_user_id === reqItem.sender_user_id) {
            r.status = "BLOCKED";
            r.updated_at = nowIso;
          }
        }
        if (Array.isArray(post.comments)) {
          for (const c of post.comments) {
            if (c && c.author_user_id === reqItem.sender_user_id) {
              c.hidden_by_block = true;
            }
          }
        }
        if (isAdmin && !isOwner) {
          store.recordAudit({
            actor_kind: "ADMIN",
            actor_ref: auth.cloudUserId,
            action: "ADMIN_BLOCK_MOMENTS_CONTACT_REQUEST",
            resource_kind: "moments_contact_request",
            resource_ref: reqItem.id,
            outcome: "BLOCKED",
            detail: { post_id: post.id, blocked_sender_user_id: reqItem.sender_user_id }
          });
        }
      } else if (action === "REPORT") {
        post.reports_count = Number(post.reports_count || 0) + 1;
        store.recordAudit({
          actor_kind: "USER",
          actor_ref: auth.cloudUserId,
          action: "REPORT_MOMENTS_CONTACT_REQUEST",
          resource_kind: "moments_contact_request",
          resource_ref: reqItem.id,
          outcome: "REPORTED",
          detail: { post_id: post.id, reason: String(body?.reason || "用户举报") }
        });
      } else {
        throw new ContractError("BAD_REQUEST", "不支持的操作类型");
      }
      reqItem.updated_at = nowIso;
      post.updated_at = nowIso;
      store.momentsState.updated_at = nowIso;
      store.saveSnapshot();
      const isSenderBlocked =
        Array.isArray(post.blocked_user_ids) && post.blocked_user_ids.includes(reqItem.sender_user_id);
      const canViewerSeeInitiatorContact =
        !isSenderBlocked && reqItem.status === "APPROVED" && (isSender || canManageRequests);
      const canViewerSeeSenderContact = Boolean(isSender || canManageRequests);
      return {
        status: 200,
        code: "CONTACT_REQUEST_UPDATED",
        data: projectContactRequestForViewer(reqItem, post, {
          canSeeInitiatorContact: canViewerSeeInitiatorContact,
          canSeeSenderContact: canViewerSeeSenderContact
        })
      };
    }
  ),

  route("POST", "/api/v1/moments/posts/{postId}/action", "mutateMomentsPost", "public", async ({ params, body, headers, nowMs }) => {
    const { cloudUserId: viewerUserId, isAdmin: isViewerAdmin } = tryExtractOptionalViewerAuth(
      headers,
      nowMs,
      "POST"
    );
    const posts = store.momentsState.posts || [];
    const idx = posts.findIndex((p) => p.id === params.postId);
    if (idx < 0) throw new ContractError("NOT_FOUND", "未找到该寻物/招领帖");
    const act = String(body?.action || "").toUpperCase();
    const post = posts[idx];
    const nowIso = new Date(nowMs).toISOString();

    if (act === "CLAIM_OWNERSHIP") {
      if (!viewerUserId) {
        throw new ContractError("CLOUD_AUTH_REQUIRED", "认领历史旧帖管理权需先登录云端账号");
      }
      if (post.owner_cloud_user_id) {
        if (post.owner_cloud_user_id === viewerUserId) {
          return {
            status: 200,
            code: "MOMENTS_POST_OWNERSHIP_ALREADY_BOUND",
            data: projectMomentsPostForViewer(post, store.momentsState.posts, viewerUserId, isViewerAdmin)
          };
        }
        throw new ContractError("CONFLICT", "该帖子已绑定归属账号，禁止重复认领管理权");
      }

      if (isViewerAdmin) {
        const targetOwnerId = body?.target_owner_cloud_user_id !== undefined
          ? String(body.target_owner_cloud_user_id || "").trim()
          : viewerUserId;
        const targetUser = targetOwnerId ? store.users.get(targetOwnerId) : null;
        if (!targetOwnerId || !targetUser || targetUser.status !== "ACTIVE") {
          throw new ContractError(
            "BAD_REQUEST",
            "管理员指派归属的目标云端账号不存在或状态非 ACTIVE，拒绝绑定无主旧帖"
          );
        }
        const verificationNote = String(body?.verification_note || body?.reason || "").trim().slice(0, 240);
        if (!verificationNote) {
          throw new ContractError(
            "BAD_REQUEST",
            "管理员人工核验指派历史旧帖归属时必须填写 verification_note 核验依据"
          );
        }
        post.owner_cloud_user_id = targetOwnerId;
        delete post.legacy_claim_token_sha256;
        post.updated_at = nowIso;
        store.momentsState.updated_at = nowIso;
        store.recordAudit({
          actor_kind: "ADMIN",
          actor_ref: viewerUserId,
          action: "ADMIN_ASSIGN_LEGACY_MOMENTS_POST",
          resource_kind: "moments_post",
          resource_ref: post.id,
          outcome: "CLAIMED",
          detail: {
            assigned_owner_cloud_user_id: targetOwnerId,
            verification_mode: "ADMIN_MANUAL_VERIFICATION",
            verification_note: verificationNote
          }
        });
        store.saveSnapshot();
        return {
          status: 200,
          code: "MOMENTS_POST_OWNERSHIP_CLAIMED",
          data: projectMomentsPostForViewer(post, store.momentsState.posts, viewerUserId, isViewerAdmin)
        };
      }

      // Non-admin self-service: strictly forbid masked student_no inference, PENDING_DELEGATION student_no,
      // PUBLIC contact, or ON_REQUEST contact (which approved requesters also know!).
      // Only accept an original high-entropy ownership token or a trusted unique OIDC issuer+subject binding.
      const hasValidClaimToken = verifyHighEntropyLegacyClaimToken(post, body?.claim_token);
      const hasTrustedUniqueSso = verifyUniqueTrustedLegacySsoBinding(post, viewerUserId);
      if (!hasValidClaimToken && !hasTrustedUniqueSso) {
        store.recordAudit({
          actor_kind: "USER",
          actor_ref: viewerUserId,
          action: "REJECT_UNTRUSTED_LEGACY_MOMENTS_CLAIM",
          resource_kind: "moments_post",
          resource_ref: post.id,
          outcome: "REJECTED"
        });
        throw new ContractError(
          "FORBIDDEN",
          "已关闭基于脱敏学号或联系方式的自助认领；缺少原始高熵所有权凭证的历史旧帖仅支持管理员人工核验处理"
        );
      }

      const viewerUser = store.users.get(viewerUserId);
      if (!viewerUser || viewerUser.status !== "ACTIVE") {
        throw new ContractError("FORBIDDEN", "当前云端账号状态异常，无法绑定帖子归属");
      }
      post.owner_cloud_user_id = viewerUserId;
      delete post.legacy_claim_token_sha256;
      post.updated_at = nowIso;
      store.momentsState.updated_at = nowIso;
      store.recordAudit({
        actor_kind: "USER",
        actor_ref: viewerUserId,
        action: "CLAIM_LEGACY_MOMENTS_POST",
        resource_kind: "moments_post",
        resource_ref: post.id,
        outcome: "CLAIMED",
        detail: {
          assigned_owner_cloud_user_id: viewerUserId,
          verification_mode: hasValidClaimToken ? "HIGH_ENTROPY_CLAIM_TOKEN" : "TRUSTED_UNIQUE_SSO_SUBJECT"
        }
      });
      store.saveSnapshot();
      return {
        status: 200,
        code: "MOMENTS_POST_OWNERSHIP_CLAIMED",
        data: projectMomentsPostForViewer(post, store.momentsState.posts, viewerUserId, isViewerAdmin)
      };
    }

    const isOwner = Boolean(
      viewerUserId && post.owner_cloud_user_id && post.owner_cloud_user_id === viewerUserId
    );

    if (act === "DELETE" || act === "RESOLVE" || act === "REOPEN") {
      if (!viewerUserId) {
        throw new ContractError("CLOUD_AUTH_REQUIRED", "修改或删除失物招领帖需先登录云端账号");
      }
      if (!isOwner && !isViewerAdmin) {
        throw new ContractError(
          "FORBIDDEN",
          post.owner_cloud_user_id
            ? "仅帖子发起人本人或平台管理员可执行结案、重开或删除操作"
            : "该历史旧帖尚未绑定发起人账号，请先完成归属核验认领或提交举报由管理员处理"
        );
      }
      if (isViewerAdmin && !isOwner) {
        store.recordAudit({
          actor_kind: "ADMIN",
          actor_ref: viewerUserId,
          action: `ADMIN_${act}_MOMENTS_POST`,
          resource_kind: "moments_post",
          resource_ref: post.id,
          outcome: "SUCCESS",
          detail: { was_legacy_unowned: !post.owner_cloud_user_id }
        });
      }
    }

    if (act === "DELETE") {
      posts.splice(idx, 1);
      store.momentsState.updated_at = nowIso;
      store.saveSnapshot();
      return { status: 200, code: "MOMENTS_POST_DELETED", data: { deleted_id: params.postId } };
    }
    if (act === "RESOLVE") post.status = "RESOLVED";
    else if (act === "REOPEN") post.status = "OPEN";
    else if (act === "LIKE") post.likes_count = Number(post.likes_count || 0) + 1;
    else if (act === "FAVORITE") post.favorites_count = Number(post.favorites_count || 0) + 1;
    else if (act === "REPORT") {
      post.reports_count = Number(post.reports_count || 0) + 1;
      store.recordAudit({
        actor_kind: viewerUserId ? "USER" : "ANONYMOUS",
        actor_ref: viewerUserId || "anonymous",
        action: "REPORT_MOMENTS_POST",
        resource_kind: "moments_post",
        resource_ref: post.id,
        outcome: "REPORTED",
        detail: { reason: String(body?.reason || "用户举报不良或虚假失物招领信息").slice(0, 160) }
      });
    } else {
      throw new ContractError("BAD_REQUEST", "不支持的帖子操作类型");
    }
    post.updated_at = nowIso;
    store.momentsState.updated_at = nowIso;
    store.saveSnapshot();
    return {
      status: 200,
      code: "MOMENTS_POST_UPDATED",
      data: projectMomentsPostForViewer(post, store.momentsState.posts, viewerUserId, isViewerAdmin)
    };
  }),

  route("POST", "/api/v1/moments/books", "createMomentsBookListing", "public", async ({ body, headers, nowMs }) => {
    const { cloudUserId: viewerUserId, isAdmin: isViewerAdmin } = tryExtractOptionalViewerAuth(
      headers,
      nowMs,
      "POST"
    );
    if (!viewerUserId) {
      throw new ContractError(
        "CLOUD_AUTH_REQUIRED",
        "发布闲置教材需先登录云端账号，以便后续下架或删除管理"
      );
    }
    const title = String(body?.title || "").trim().slice(0, 80);
    if (!title) throw new ContractError("BAD_REQUEST", "请填写教材名称");
    const requestedId = body?.id ? String(body.id).trim().slice(0, 40) : "";
    const existingBooks = store.momentsState.book_listings || [];
    if (requestedId && existingBooks.some((b) => b.id === requestedId)) {
      throw new ContractError("CONFLICT", "该教材挂单 ID 已存在，禁止覆盖已有教材信息");
    }
    const nowIso = new Date(nowMs).toISOString();
    const book = {
      id: requestedId || ("mb_" + crypto.randomUUID().slice(0, 10)),
      title,
      isbn: String(body?.isbn || "").trim().slice(0, 24),
      author_publisher: String(body?.author_publisher || "高校教材").trim().slice(0, 64),
      course_name: String(body?.course_name || "").trim().slice(0, 40),
      major_track: String(body?.major_track || "ALL_MAJORS").trim().slice(0, 32),
      campus: String(body?.campus || "莲花街校区").trim().slice(0, 24),
      condition_label: String(body?.condition_label || "九成新").trim().slice(0, 32),
      price_yuan: Math.max(0, Math.min(500, Number(body?.price_yuan ?? 15) || 15)),
      original_price_yuan: Math.max(0, Math.min(999, Number(body?.original_price_yuan ?? 55) || 55)),
      delivery_mode: String(body?.delivery_mode || "校内自提").trim().slice(0, 40),
      contact: String(body?.contact || "").trim().slice(0, 64),
      seller_name: String(body?.seller_name || "河工大同学").trim().slice(0, 24),
      owner_cloud_user_id: viewerUserId,
      status: "AVAILABLE",
      likes_count: 0,
      created_at: nowIso
    };
    store.momentsState.book_listings = [book, ...existingBooks].slice(0, 200);
    store.momentsState.updated_at = nowIso;
    store.saveSnapshot();
    return {
      status: 201,
      code: "MOMENTS_BOOK_CREATED",
      data: projectMomentsBookForViewer(book, viewerUserId, isViewerAdmin)
    };
  }),

  route("POST", "/api/v1/moments/books/{bookId}/action", "mutateMomentsBookListing", "public", async ({ params, body, headers, nowMs }) => {
    const { cloudUserId: viewerUserId, isAdmin: isViewerAdmin } = tryExtractOptionalViewerAuth(
      headers,
      nowMs,
      "POST"
    );
    const books = store.momentsState.book_listings || [];
    const idx = books.findIndex((b) => b.id === params.bookId);
    if (idx < 0) throw new ContractError("NOT_FOUND", "未找到该教材挂单");
    const act = String(body?.action || "").toUpperCase();
    const book = books[idx];
    const isOwner = Boolean(
      viewerUserId && book.owner_cloud_user_id && book.owner_cloud_user_id === viewerUserId
    );
    if (act === "DELETE" || act === "MARK_SOLD" || act === "MARK_AVAILABLE") {
      if (!viewerUserId) {
        throw new ContractError("CLOUD_AUTH_REQUIRED", "修改或删除教材挂单需先登录云端账号");
      }
      if (!isOwner && !isViewerAdmin) {
        throw new ContractError("FORBIDDEN", "仅卖家本人或平台管理员可修改或删除该教材挂单");
      }
    }
    const nowIso = new Date(nowMs).toISOString();
    if (act === "DELETE") {
      books.splice(idx, 1);
      store.momentsState.updated_at = nowIso;
      store.saveSnapshot();
      return { status: 200, code: "MOMENTS_BOOK_DELETED", data: { deleted_id: params.bookId } };
    }
    if (act === "MARK_SOLD") book.status = "SOLD";
    else if (act === "MARK_AVAILABLE") book.status = "AVAILABLE";
    else if (act === "LIKE") book.likes_count = Number(book.likes_count || 0) + 1;
    else throw new ContractError("BAD_REQUEST", "不支持的教材操作类型");
    store.momentsState.updated_at = nowIso;
    store.saveSnapshot();
    return {
      status: 200,
      code: "MOMENTS_BOOK_UPDATED",
      data: projectMomentsBookForViewer(book, viewerUserId, isViewerAdmin)
    };
  }),

  route("GET", "/api/v1/moments/isbn-resolve", "resolveMomentsIsbn", "public", async ({ query }) => {
    const q = (query.get("isbn") || query.get("keyword") || "").replace(/[^0-9a-zA-Z\u4e00-\u9fa5]/g, "").toLowerCase();
    const catalog = store.momentsState?.isbn_catalog || [];
    const matched = q
      ? catalog.find(
          (c) =>
            String(c.isbn || "").toLowerCase().includes(q) ||
            String(c.title || "").toLowerCase().includes(q) ||
            String(c.course_name || "").toLowerCase().includes(q)
        ) || null
      : null;
    return { status: 200, code: "MOMENTS_ISBN_RESOLVED", data: { matched, catalog } };
  }),

  route("POST", "/api/v1/moments/anti-lost-tags", "upsertAntiLostTag", "public", async ({ body, headers, nowMs }) => {
    const { cloudUserId: viewerUserId, isAdmin: isViewerAdmin } = tryExtractOptionalViewerAuth(
      headers,
      nowMs,
      "POST"
    );
    if (!viewerUserId) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "创建或更新随身防丢码需先登录云端账号");
    }
    const itemName = String(body?.item_name || "").trim().slice(0, 48);
    if (!itemName) throw new ContractError("BAD_REQUEST", "请填写随身物品名称");
    const nowIso = new Date(nowMs).toISOString();
    const rawCode = String(body?.tag_code || "").trim().toUpperCase();
    const tagCode = /^HAUT-TAG-[A-Z0-9]{4,10}$/.test(rawCode)
      ? rawCode
      : ("HAUT-TAG-" + crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase());
    const tags = store.momentsState.anti_lost_tags || [];
    const existing = tags.find((t) => t.tag_code === tagCode);
    if (existing) {
      const canMutateExisting =
        isViewerAdmin || (existing.owner_cloud_user_id && existing.owner_cloud_user_id === viewerUserId);
      if (!canMutateExisting) {
        throw new ContractError("CONFLICT", "该防丢码编号已被绑定，禁止覆盖他人防丢码");
      }
    }
    const rawStatus = String(body?.status || existing?.status || "NORMAL").toUpperCase();
    const allowedStatus = ["NORMAL", "LOST", "FOUND_REPORTED", "DISABLED"].includes(rawStatus)
      ? rawStatus
      : "NORMAL";
    const rawVisibility = String(
      body?.contact_visibility ?? existing?.contact_visibility ?? "PRIVATE"
    ).toUpperCase();
    const contactVisibility =
      rawVisibility === "PUBLIC_WHEN_LOST" ? "PUBLIC_WHEN_LOST" : "PRIVATE";
    const ownerDeclaredLost =
      allowedStatus === "LOST" ||
      (allowedStatus === "FOUND_REPORTED" && existing?.owner_declared_lost === true);
    const normalizedOwnerStatus =
      allowedStatus === "FOUND_REPORTED" && !ownerDeclaredLost ? "NORMAL" : allowedStatus;
    const updatedTag = {
      id: existing?.id || ("tag_" + crypto.randomUUID().slice(0, 8)),
      tag_code: tagCode,
      owner_cloud_user_id: existing?.owner_cloud_user_id || viewerUserId,
      item_name: itemName,
      category: String(body?.category || existing?.category || "随身物品").trim().slice(0, 24),
      campus: String(body?.campus || existing?.campus || "莲花街校区").trim().slice(0, 24),
      owner_name: String(body?.owner_name || existing?.owner_name || "河工大同学").trim().slice(0, 24),
      owner_contact: String(body?.owner_contact || existing?.owner_contact || "").trim().slice(0, 64),
      contact_visibility: contactVisibility,
      owner_declared_lost: ownerDeclaredLost,
      return_note: String(body?.return_note || existing?.return_note || "拾到请联系失主或放至就近服务台").trim().slice(0, 160),
      status: normalizedOwnerStatus,
      reports: Array.isArray(existing?.reports) ? existing.reports : [],
      created_at: existing?.created_at || nowIso,
      updated_at: nowIso
    };
    store.momentsState.anti_lost_tags = [
      updatedTag,
      ...tags.filter((t) => t.tag_code !== tagCode)
    ].slice(0, 120);
    store.momentsState.updated_at = nowIso;
    store.saveSnapshot();
    return {
      status: 200,
      code: "ANTI_LOST_TAG_UPSERTED",
      data: projectAntiLostTagForOwnerOrAdmin(updatedTag, viewerUserId, isViewerAdmin)
    };
  }),

  route("POST", "/api/v1/moments/anti-lost-tags/{tagCode}/report-found", "reportAntiLostTagFound", "public", async ({ params, body, nowMs }) => {
    const cleanCode = String(params.tagCode || "").trim().toUpperCase();
    const tags = store.momentsState.anti_lost_tags || [];
    const tag = tags.find((t) => t.tag_code.toUpperCase() === cleanCode);
    if (!tag) throw new ContractError("NOT_FOUND", "未找到防丢码 " + cleanCode);
    if (String(tag.status || "").toUpperCase() === "DISABLED") {
      throw new ContractError("CONFLICT", "该防丢码已由失主停用，不再接收拾得上报");
    }
    const foundLocation = String(body?.found_location || "").trim().slice(0, 80);
    if (!foundLocation) throw new ContractError("BAD_REQUEST", "请填写拾得位置或放置地点");
    const nowIso = new Date(nowMs).toISOString();
    const report = {
      id: "rep_" + crypto.randomUUID().slice(0, 8),
      finder_name: String(body?.finder_name || "热心同学").trim().slice(0, 24),
      found_location: foundLocation,
      finder_contact: String(body?.finder_contact || "").trim().slice(0, 64),
      message: String(body?.message || "").trim().slice(0, 200),
      created_at: nowIso
    };
    if (!Array.isArray(tag.reports)) tag.reports = [];
    tag.reports = [report, ...tag.reports].slice(0, 30);
    // CRITICAL: Anonymous report-found MUST NEVER escalate a NORMAL/restricted tag into LOST/FOUND_REPORTED!
    // Only transition LOST -> FOUND_REPORTED when the owner had ALREADY explicitly declared LOST!
    if (tag.status === "LOST" && tag.owner_declared_lost === true) {
      tag.status = "FOUND_REPORTED";
    }
    tag.last_finder_report_at = nowIso;
    tag.updated_at = nowIso;
    store.momentsState.updated_at = nowIso;
    if (tag.owner_cloud_user_id) {
      store.addNotification({
        cloudUserId: tag.owner_cloud_user_id,
        category: "ANTI_LOST_TAG_FOUND",
        title: `防丢码「${tag.item_name}」收到拾得线索`,
        body: `放置位置：${foundLocation}${report.message ? " · " + report.message : ""}`
      });
    }
    store.saveSnapshot();
    // Public-safe acknowledgment: NEVER leak owner_contact, owner_name, internal status, or historical reports[]!
    return {
      status: 200,
      code: "ANTI_LOST_FOUND_REPORTED",
      data: {
        tag_code: tag.tag_code,
        report_id: report.id,
        report_submitted: true,
        updated_at: nowIso
      }
    };
  })
  ];
}
