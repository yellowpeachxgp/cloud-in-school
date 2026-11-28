import { route } from "./route-table.mjs";

export function createE2eeSyncRoutes(ctx) {
  const { syncE2ee } = ctx;

  return [
    route("GET", "/api/v1/sync/devices", "listSyncDevices", "bearer", async ({ auth, query, nowMs }) =>
      syncE2ee.listSyncDevices(auth, query, nowMs)
    ),
    route("PUT", "/api/v1/sync/devices/{deviceId}", "registerSyncDevice", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      syncE2ee.registerSyncDevice(auth, params, body, headers, nowMs)
    ),
    route("DELETE", "/api/v1/sync/devices/{deviceId}", "revokeSyncDevice", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      syncE2ee.revokeSyncDevice(auth, params, body, headers, nowMs)
    ),
    route("PUT", "/api/v1/sync/blobs/{blobId}", "putSyncBlob", "bearer", async ({ auth, params, body, headers, nowMs, requestId, bodyBytes }) =>
      syncE2ee.putSyncBlob(auth, params, body, headers, nowMs, requestId, bodyBytes)
    ),
    route("GET", "/api/v1/sync/blobs/{blobId}", "downloadSyncBlob", "bearer", async ({ auth, params, headers, nowMs, requestId }) =>
      syncE2ee.downloadSyncBlob(auth, params, headers, nowMs, requestId)
    ),
    route("DELETE", "/api/v1/sync/blobs/{blobId}", "deleteSyncBlob", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      syncE2ee.deleteSyncBlob(auth, params, body, headers, nowMs)
    ),
    route("GET", "/api/v1/sync/changes", "listSyncChanges", "bearer", async ({ auth, query, headers, nowMs, requestId }) =>
      syncE2ee.listSyncChanges(auth, query, headers, nowMs, requestId)
    )
  ];
}
