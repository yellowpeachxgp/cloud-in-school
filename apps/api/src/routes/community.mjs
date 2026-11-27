import { route } from "./route-table.mjs";

export function createCommunityRoutes(ctx) {
  const { community } = ctx;

  return [
    route("GET", "/api/v1/groups", "listGroups", "bearer", async ({ auth, query, nowMs }) =>
      community.listGroups(auth, query, nowMs)
    ),
    route("POST", "/api/v1/groups", "createGroup", "bearer", async ({ auth, body, headers, nowMs }) =>
      community.createGroup(auth, body, headers, nowMs)
    ),
    route("GET", "/api/v1/groups/{groupId}", "getGroup", "bearer", async ({ auth, params }) =>
      community.getGroup(auth, params)
    ),
    route("PATCH", "/api/v1/groups/{groupId}", "updateGroup", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      community.updateGroup(auth, params, body, headers, nowMs)
    ),
    route("DELETE", "/api/v1/groups/{groupId}", "deleteGroup", "bearer", async ({ auth, params, headers, nowMs }) =>
      community.archiveGroup(auth, params, headers, nowMs)
    ),
    route("POST", "/api/v1/groups/{groupId}/invites", "createGroupInvite", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      community.createGroupInvite(auth, params, body, headers, nowMs)
    ),
    route("POST", "/api/v1/group-invites/{code}/accept", "acceptGroupInvite", "bearer", async ({ auth, params, headers, nowMs }) =>
      community.acceptGroupInvite(auth, params, headers, nowMs)
    ),
    route("DELETE", "/api/v1/groups/{groupId}/invites/{inviteId}", "revokeGroupInvite", "bearer", async ({ auth, params, headers, nowMs }) =>
      community.revokeGroupInvite(auth, params, headers, nowMs)
    ),
    route("GET", "/api/v1/groups/{groupId}/members", "listGroupMembers", "bearer", async ({ auth, params, query }) =>
      community.listGroupMembers(auth, params, query)
    ),
    route("PATCH", "/api/v1/groups/{groupId}/members/{memberId}", "updateGroupMember", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      community.updateGroupMember(auth, params, body, headers, nowMs)
    ),
    route("DELETE", "/api/v1/groups/{groupId}/members/{memberId}", "removeGroupMember", "bearer", async ({ auth, params, headers, nowMs }) =>
      community.removeGroupMember(auth, params, headers, nowMs)
    )
  ];
}
