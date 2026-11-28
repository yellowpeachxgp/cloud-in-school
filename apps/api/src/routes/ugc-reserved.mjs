import { ContractError } from "../../../../packages/contracts/src/index.mjs";
import { route } from "./route-table.mjs";

const RESERVED_COMMUNITY_FORUM_DETAIL = Object.freeze({ feature: "community.forum" });

async function reservedCommunityForumHandler() {
  throw new ContractError(
    "FEATURE_NOT_ENABLED",
    "社区论坛与私信接口当前未启用",
    RESERVED_COMMUNITY_FORUM_DETAIL
  );
}

function reservedRoute(method, path, operationId) {
  // CT-05/D2：这些路由只是契约预留桩。它们故意不接收 ctx、store 或领域服务，
  // 因此不存在表读写、业务校验、事件发射或隐藏副作用；未来若获准启用，
  // 必须在同一 PR 用真实实现替换并把契约从 reserved 翻为 active。
  return route(method, path, operationId, "public", reservedCommunityForumHandler);
}

export function createReservedUgcRoutes() {
  return [
    reservedRoute("GET", "/api/v1/boards", "listBoards"),
    reservedRoute("GET", "/api/v1/boards/{boardId}/posts", "listBoardPosts"),
    reservedRoute("POST", "/api/v1/posts", "createPost"),
    reservedRoute("GET", "/api/v1/posts/{postId}", "getPost"),
    reservedRoute("DELETE", "/api/v1/posts/{postId}", "deletePost"),
    reservedRoute("POST", "/api/v1/posts/{postId}/replies", "createPostReply"),
    reservedRoute("GET", "/api/v1/search/posts", "searchPosts"),
    reservedRoute("POST", "/api/v1/reports", "createReport"),
    reservedRoute("GET", "/api/v1/admin/moderation/queue", "listModerationQueue"),
    reservedRoute("POST", "/api/v1/admin/moderation/{itemId}/actions", "createModerationAction"),
    reservedRoute("POST", "/api/v1/media/uploads", "createMediaUpload"),
    reservedRoute("POST", "/api/v1/media/uploads/{uploadId}/complete", "completeMediaUpload")
  ];
}
