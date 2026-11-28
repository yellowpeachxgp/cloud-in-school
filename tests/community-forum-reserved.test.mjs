import test from "node:test";
import assert from "node:assert/strict";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";

const RESERVED_REQUESTS = Object.freeze([
  { method: "GET", path: "/api/v1/boards", operationId: "listBoards", url: "/api/v1/boards?ignored=yes" },
  { method: "GET", path: "/api/v1/boards/{boardId}/posts", operationId: "listBoardPosts", url: "/api/v1/boards/board-demo/posts?cursor=opaque" },
  { method: "POST", path: "/api/v1/posts", operationId: "createPost", url: "/api/v1/posts" },
  { method: "GET", path: "/api/v1/posts/{postId}", operationId: "getPost", url: "/api/v1/posts/post-demo" },
  { method: "DELETE", path: "/api/v1/posts/{postId}", operationId: "deletePost", url: "/api/v1/posts/post-demo" },
  { method: "POST", path: "/api/v1/posts/{postId}/replies", operationId: "createPostReply", url: "/api/v1/posts/post-demo/replies" },
  { method: "GET", path: "/api/v1/search/posts", operationId: "searchPosts", url: "/api/v1/search/posts?q=ignored" },
  { method: "POST", path: "/api/v1/reports", operationId: "createReport", url: "/api/v1/reports" },
  { method: "GET", path: "/api/v1/admin/moderation/queue", operationId: "listModerationQueue", url: "/api/v1/admin/moderation/queue?status=OPEN" },
  { method: "POST", path: "/api/v1/admin/moderation/{itemId}/actions", operationId: "createModerationAction", url: "/api/v1/admin/moderation/item-demo/actions" },
  { method: "POST", path: "/api/v1/media/uploads", operationId: "createMediaUpload", url: "/api/v1/media/uploads" },
  { method: "POST", path: "/api/v1/media/uploads/{uploadId}/complete", operationId: "completeMediaUpload", url: "/api/v1/media/uploads/upload-demo/complete" }
]);

function normalizedEnvelope(body) {
  return {
    ok: body.ok,
    code: body.code,
    error: body.error,
    meta: { ...body.meta, request_id: "<request-id>" }
  };
}

function assertUniform501(res, label) {
  assert.equal(res.status, 501, label + " status");
  assert.equal(res.body.ok, false, label + " ok");
  assert.equal(res.body.code, "FEATURE_NOT_ENABLED", label + " top-level code");
  assert.equal(res.body.error?.code, "FEATURE_NOT_ENABLED", label + " error code");
  assert.equal(res.body.error?.retryable, false, label + " retryable");
  assert.equal(res.body.error?.user_action, "NONE", label + " user action");
  assert.deepEqual(res.body.error?.detail, { feature: "community.forum" }, label + " detail");
  assert.equal(res.body.meta?.api_version, "v1", label + " api version");
  assert.match(res.body.request_id || "", /^req_[a-f0-9]{20}$/, label + " generated request id");
}

test("CT-05 reserved forum/private-message operations return one uniform 501 envelope without side effects", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  assert.deepEqual(
    app.getRegisteredReservedRoutes(),
    RESERVED_REQUESTS.map(({ method, path, operationId }) => ({ method, path, operationId, auth: "public" })),
    "reserved runtime registration must stay separate and exact"
  );
  assert.equal(app.getRegisteredCoreRoutes().some((route) => route.operationId === "listBoards"), false);

  const auditEventsBefore = app.store.auditEvents.length;
  const outboxBefore = app.store.outboxEvents.length;
  const envelopes = [];
  for (const entry of RESERVED_REQUESTS) {
    const res = await app.inject({
      method: entry.method,
      url: entry.url,
      headers: {
        authorization: "Bearer <cloud_access_token>",
        "x-requested-with": "reserved-contract-probe"
      },
      body: entry.method === "GET" ? undefined : { arbitrary: "input is ignored", nested: { retry: true } }
    });
    assertUniform501(res, entry.operationId);
    envelopes.push(JSON.stringify(normalizedEnvelope(res.body)));
  }
  assert.equal(new Set(envelopes).size, 1, "every reserved operation must produce the same envelope except request_id");
  assert.equal(app.store.auditEvents.length, auditEventsBefore, "reserved stubs must not emit audit events");
  assert.equal(app.store.outboxEvents.length, outboxBefore, "reserved stubs must not emit domain/outbox events");
});

test("CT-05 reserved operations ignore malformed and oversized bodies instead of validating input", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  for (const failureMode of ["malformed", "oversized"]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: { "content-type": "application/json" },
      body: undefined,
      bodyParseError: failureMode === "malformed" ? new Error("intentional malformed JSON") : null,
      bodyTooLarge: failureMode === "oversized",
      bodyBytes: failureMode === "oversized" ? 2 * 1024 * 1024 : 2
    });
    assertUniform501(res, failureMode);
  }
});
