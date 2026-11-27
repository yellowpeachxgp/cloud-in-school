import { route } from "./route-table.mjs";

export function createAvailabilityRoutes(ctx) {
  const { availability } = ctx;

  return [
    route("PUT", "/api/v1/groups/{groupId}/availability/me", "replaceMyGroupAvailability", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      availability.replaceMyGroupAvailability(auth, params, body, headers, nowMs)
    ),
    route("DELETE", "/api/v1/groups/{groupId}/availability/me", "deleteMyGroupAvailability", "bearer", async ({ auth, params, headers, nowMs }) =>
      availability.deleteMyGroupAvailability(auth, params, headers, nowMs)
    ),
    route("POST", "/api/v1/groups/{groupId}/availability/query", "queryGroupAvailability", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      availability.queryGroupAvailability(auth, params, body, headers, nowMs)
    ),
    route("POST", "/api/v1/groups/{groupId}/polls", "createGroupPoll", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      availability.createGroupPoll(auth, params, body, headers, nowMs)
    ),
    route("GET", "/api/v1/polls/{pollId}", "getGroupPoll", "bearer", async ({ auth, params, nowMs }) =>
      availability.getGroupPoll(auth, params, nowMs)
    ),
    route("POST", "/api/v1/polls/{pollId}/votes", "upsertGroupPollVote", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      availability.upsertGroupPollVote(auth, params, body, headers, nowMs)
    ),
    route("POST", "/api/v1/polls/{pollId}/confirm", "confirmGroupPoll", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      availability.confirmGroupPoll(auth, params, body, headers, nowMs)
    )
  ];
}
