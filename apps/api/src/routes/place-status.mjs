import { route } from "./route-table.mjs";

export function createPlaceStatusRoutes(ctx) {
  const { placeStatus } = ctx;

  return [
    route("POST", "/api/v1/places/{placeRef}/reports", "createPlaceStatusReport", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      placeStatus.createReport(auth, params, body, headers, nowMs)
    ),
    route("GET", "/api/v1/places/{placeRef}/reports", "listPlaceStatusReports", "bearer", async ({ auth, params, query, nowMs }) =>
      placeStatus.listReports(auth, params, query, nowMs)
    ),
    route("GET", "/api/v1/places/status", "queryPlaceStatus", "bearer", async ({ auth, query, nowMs }) =>
      placeStatus.queryStatus(auth, query, nowMs)
    ),
    route("POST", "/api/v1/places/status/subscriptions", "createPlaceStatusSubscription", "bearer", async ({ auth, body, headers, nowMs }) =>
      placeStatus.createSubscription(auth, body, headers, nowMs)
    ),
    route("GET", "/api/v1/places/status/subscriptions", "listPlaceStatusSubscriptions", "bearer", async ({ auth, query }) =>
      placeStatus.listSubscriptions(auth, query)
    ),
    route("DELETE", "/api/v1/places/status/subscriptions/{subscriptionId}", "deletePlaceStatusSubscription", "bearer", async ({ auth, params, headers, nowMs }) =>
      placeStatus.deleteSubscription(auth, params, headers, nowMs)
    ),
    route("POST", "/api/v1/place-reports/{reportId}/flag", "flagPlaceStatusReport", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      placeStatus.flagReport(auth, params, body, headers, nowMs)
    ),
    route("GET", "/api/v1/admin/place-report-flags", "listPlaceReportFlags", "bearer", async ({ auth, query }) =>
      placeStatus.listFlags(auth, query)
    ),
    route("POST", "/api/v1/admin/place-report-flags/{flagId}/review", "reviewPlaceReportFlag", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      placeStatus.reviewFlag(auth, params, body, headers, nowMs)
    )
  ];
}
