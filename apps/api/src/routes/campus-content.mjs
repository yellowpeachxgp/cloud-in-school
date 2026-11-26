import { route } from "./route-table.mjs";
import {
  DEFAULT_SCHOOL_ID
} from "../../../../packages/contracts/src/index.mjs";

export function createCampusContentRoutes(ctx) {
  const {
    store,
    redisBuffer
  } = ctx;

  async function refreshCampusContentCache(schoolId) {
    const key = String(schoolId || DEFAULT_SCHOOL_ID).toLowerCase();
    await redisBuffer.invalidate("campus_content", key);
    const publicSnapshot = store.getCampusContent(key, { includeDisabled: false });
    await redisBuffer.setAndWarm("campus_content", key, publicSnapshot, 120);
  }

  return [
  route("GET", "/api/v1/campus-content", "getCampusContent", "public", async ({ query }) => {
    const schoolId = query.get("school_id") || DEFAULT_SCHOOL_ID;
    const { value: content, cacheStatus } = await redisBuffer.getOrCompute(
      "campus_content",
      schoolId.toLowerCase(),
      120,
      async () => store.getCampusContent(schoolId, { includeDisabled: false })
    );
    return {
      status: 200,
      headers: {
        "cache-control": "no-store, no-cache, must-revalidate",
        "x-cache": cacheStatus
      },
      code: "CAMPUS_CONTENT_OK",
      data: content
    };
  }),

  route("GET", "/api/v1/admin/campus-content", "getAdminCampusContent", "bearer_admin", async ({ query }) => {
    const schoolId = query.get("school_id") || DEFAULT_SCHOOL_ID;
    return {
      status: 200,
      code: "ADMIN_CAMPUS_CONTENT_OK",
      data: store.getCampusContent(schoolId, { includeDisabled: true })
    };
  }),

  route("PUT", "/api/v1/admin/campus-content", "updateAdminCampusContent", "bearer_admin", async ({ auth, query, body }) => {
    const schoolId = query.get("school_id") || body?.school_id || DEFAULT_SCHOOL_ID;
    const actorName = store.users.get(auth.cloudUserId)?.username || auth.cloudUserId;
    const updated = store.updateCampusContent(schoolId, body || {}, actorName);
    await refreshCampusContentCache(schoolId);
    return {
      status: 200,
      code: "CAMPUS_CONTENT_UPDATED",
      data: updated
    };
  }),

  route("POST", "/api/v1/admin/campus-content/channels", "upsertAdminCampusChannel", "bearer_admin", async ({ auth, body }) => {
    const schoolId = body?.school_id || DEFAULT_SCHOOL_ID;
    const actorName = store.users.get(auth.cloudUserId)?.username || auth.cloudUserId;
    const updated = store.upsertCampusChannel(schoolId, body || {}, actorName);
    await refreshCampusContentCache(schoolId);
    return {
      status: 200,
      code: "CAMPUS_CHANNEL_UPSERTED",
      data: updated
    };
  }),

  route(
    "DELETE",
    "/api/v1/admin/campus-content/channels/{channelId}",
    "deleteAdminCampusChannel",
    "bearer_admin",
    async ({ auth, params, query }) => {
      const schoolId = query.get("school_id") || DEFAULT_SCHOOL_ID;
      const actorName = store.users.get(auth.cloudUserId)?.username || auth.cloudUserId;
      const updated = store.deleteCampusChannel(schoolId, params.channelId, actorName);
      await refreshCampusContentCache(schoolId);
      return {
        status: 200,
        code: "CAMPUS_CHANNEL_DELETED",
        data: updated
      };
    }
  ),

  route("POST", "/api/v1/admin/campus-content/clubs", "upsertAdminCampusClub", "bearer_admin", async ({ auth, body }) => {
    const schoolId = body?.school_id || DEFAULT_SCHOOL_ID;
    const actorName = store.users.get(auth.cloudUserId)?.username || auth.cloudUserId;
    const updated = store.upsertCampusClub(schoolId, body || {}, actorName);
    await refreshCampusContentCache(schoolId);
    return {
      status: 200,
      code: "CAMPUS_CLUB_UPSERTED",
      data: updated
    };
  }),

  route(
    "DELETE",
    "/api/v1/admin/campus-content/clubs/{clubId}",
    "deleteAdminCampusClub",
    "bearer_admin",
    async ({ auth, params, query }) => {
      const schoolId = query.get("school_id") || DEFAULT_SCHOOL_ID;
      const actorName = store.users.get(auth.cloudUserId)?.username || auth.cloudUserId;
      const updated = store.deleteCampusClub(schoolId, params.clubId, actorName);
      await refreshCampusContentCache(schoolId);
      return {
        status: 200,
        code: "CAMPUS_CLUB_DELETED",
        data: updated
      };
    }
  ),

  route(
    "POST",
    "/api/v1/admin/campus-content/competitions",
    "upsertAdminCampusCompetition",
    "bearer_admin",
    async ({ auth, body }) => {
      const schoolId = body?.school_id || DEFAULT_SCHOOL_ID;
      const actorName = store.users.get(auth.cloudUserId)?.username || auth.cloudUserId;
      const updated = store.upsertCampusCompetition(schoolId, body || {}, actorName);
      await refreshCampusContentCache(schoolId);
      return {
        status: 200,
        code: "CAMPUS_COMPETITION_UPSERTED",
        data: updated
      };
    }
  ),

  route(
    "DELETE",
    "/api/v1/admin/campus-content/competitions/{competitionId}",
    "deleteAdminCampusCompetition",
    "bearer_admin",
    async ({ auth, params, query }) => {
      const schoolId = query.get("school_id") || DEFAULT_SCHOOL_ID;
      const actorName = store.users.get(auth.cloudUserId)?.username || auth.cloudUserId;
      const updated = store.deleteCampusCompetition(schoolId, params.competitionId, actorName);
      await refreshCampusContentCache(schoolId);
      return {
        status: 200,
        code: "CAMPUS_COMPETITION_DELETED",
        data: updated
      };
    }
  )
  ];
}
