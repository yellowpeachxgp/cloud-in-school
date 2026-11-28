import { route } from "./route-table.mjs";

export function createContentCatalogRoutes(ctx) {
  const { contentCatalog } = ctx;

  return [
    route("GET", "/api/v1/content-packs", "listContentPacks", "bearer", async ({ auth, query }) =>
      contentCatalog.listContentPacks(auth, query)
    ),
    route("GET", "/api/v1/content-packs/{packId}/versions", "listContentPackVersions", "bearer", async ({ auth, params, query }) =>
      contentCatalog.listContentPackVersions(auth, params, query)
    ),
    route("GET", "/api/v1/content-packs/{packId}/versions/{version}", "getContentPackVersion", "bearer", async ({ auth, params }) =>
      contentCatalog.getContentPackVersion(auth, params)
    ),
    route("GET", "/api/v1/content-packs/{packId}/versions/{version}/download", "downloadContentPackArtifact", "bearer", async ({ auth, params, nowMs }) =>
      contentCatalog.downloadContentPackArtifact(auth, params, nowMs)
    ),
    route("POST", "/api/v1/content-pack-submissions", "createContentPackSubmission", "bearer", async ({ auth, body, headers, nowMs }) =>
      contentCatalog.createContentPackSubmission(auth, body, headers, nowMs)
    ),
    route("GET", "/api/v1/content-pack-submissions/{submissionId}", "getContentPackSubmission", "bearer", async ({ auth, params }) =>
      contentCatalog.getContentPackSubmission(auth, params)
    ),
    route("GET", "/api/v1/admin/content-pack-submissions", "listContentPackSubmissionReviews", "bearer", async ({ auth, query }) =>
      contentCatalog.listContentPackSubmissionReviews(auth, query)
    ),
    route("POST", "/api/v1/admin/content-pack-submissions/{submissionId}/review", "reviewContentPackSubmission", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      contentCatalog.reviewContentPackSubmission(auth, params, body, headers, nowMs)
    ),
    route("POST", "/api/v1/admin/content-packs", "publishContentPackVersion", "bearer", async ({ auth, body, headers, nowMs }) =>
      contentCatalog.publishContentPackVersion(auth, body, headers, nowMs)
    ),
    route("POST", "/api/v1/admin/content-packs/{packId}/versions/{version}/retire", "retireContentPackVersion", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      contentCatalog.retireContentPackVersion(auth, params, body, headers, nowMs)
    )
  ];
}
