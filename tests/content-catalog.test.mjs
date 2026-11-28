import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import {
  fingerprintRawEd25519PublicKey,
  rawEd25519FromSpkiDer,
  signDataPackArtifact
} from "../packages/datapack/src/index.mjs";
import {
  legacySignaturePayload,
  unpackAndValidateLegacySchoolPackage
} from "../packages/content-catalog/src/artifact-validation.mjs";
import { writePluginPackageZip } from "../packages/plugin-sdk/src/package-zip.mjs";

const BASE_NOW = Date.parse("2026-11-28T10:00:00.000Z");
const DATAPACK_FIXTURE = "tests/fixtures/datapack/valid-procedure.json";
let userSeq = 0;

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyBase64: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")
  };
}

function publicFingerprint(publicKeyBase64) {
  return fingerprintRawEd25519PublicKey(rawEd25519FromSpkiDer(Buffer.from(publicKeyBase64, "base64")));
}

function datapackArtifact() {
  return fs.readFileSync(DATAPACK_FIXTURE);
}

function datapackProvenance() {
  return {
    sources: [
      {
        url: "https://example.com/haut/procedure-guide",
        title: "学校办事流程公开页",
        retrieved_at: "2026-11-20"
      }
    ],
    verified_at: "2026-11-20",
    review_by: "2027-05-20",
    maintainers: ["github:example-maintainer"],
    verification_level: "UNVERIFIED"
  };
}

function datapackSubmissionBody(overrides = {}) {
  const artifact = overrides.artifactBytes || datapackArtifact();
  const body = {
    artifact_format: "dis-datapack/v1",
    kind: "procedure-guide",
    school_id: "haut",
    pack_id: "haut.procedures",
    version: "2026.11.1",
    artifact_encoding: "base64",
    artifact_sha256: sha256Hex(artifact),
    artifact_base64: artifact.toString("base64"),
    contribution_reference: "https://github.com/example/content-pack/pull/1",
    provenance: datapackProvenance(),
    submission_note: "公开来源格式测试",
    ...overrides
  };
  delete body.artifactBytes;
  return body;
}

function setupUser(app, label, { operations = [] } = {}) {
  const user = app.store.findOrCreateCloudUser({
    issuer: app.identity.expectedIssuer,
    subject: "sub_" + label + "_" + (++userSeq) + "_" + crypto.randomUUID().slice(0, 8),
    username: label,
    displayName: label
  });
  const session = app.identity.issueDeviceSession(user, label, null, 1, BASE_NOW, "MOBILE_APP");
  for (const permission of operations) {
    app.store.grantOperationsSchoolScope(user.id, "haut", permission, { grantedByRef: "content-catalog-test" });
  }
  return { user, session, auth: { authorization: "Bearer " + session.access_token } };
}

function writeHeaders(user, key) {
  return { ...user.auth, "idempotency-key": key };
}

function createSignedDatapackContext(options = {}) {
  const keys = keyPair();
  const artifact = datapackArtifact();
  const signature = signDataPackArtifact(artifact, keys.privateKeyBase64, keys.publicKeyBase64);
  const trustedKeys = { [signature.public_key_fingerprint]: keys.publicKeyBase64 };
  const app = createCampusCloudApp({
    requireAdminAccess: false,
    contentPackTrustedKeys: trustedKeys,
    ...options
  });
  return { app, keys, artifact, signature, trustedKeys };
}

async function submitDatapack(app, user, { key = "content-submit-0001", body = datapackSubmissionBody() } = {}) {
  return await app.inject({
    method: "POST",
    url: "/api/v1/content-pack-submissions",
    headers: writeHeaders(user, key),
    body,
    nowMs: BASE_NOW
  });
}

async function approveSubmission(app, reviewer, submissionId, key = "content-review-0001") {
  return await app.inject({
    method: "POST",
    url: "/api/v1/admin/content-pack-submissions/" + submissionId + "/review",
    headers: writeHeaders(reviewer, key),
    body: { action: "APPROVE", review_note: "公开来源、Schema 与体积检查通过" },
    nowMs: BASE_NOW
  });
}

async function publishSubmission(app, publisher, submissionId, signature, key = "content-publish-0001") {
  return await app.inject({
    method: "POST",
    url: "/api/v1/admin/content-packs",
    headers: writeHeaders(publisher, key),
    body: { submission_id: submissionId, signature, release_note: "首个公开来源测试包" },
    nowMs: BASE_NOW
  });
}

test("W5-02 dis-datapack lifecycle: submit/review/publish/catalog/download/retire closes exactly once with event and idempotent replay", async () => {
  const { app, artifact, signature } = createSignedDatapackContext();
  const submitter = setupUser(app, "pack_submitter", { operations: ["content_pack.review"] });
  const reviewer = setupUser(app, "pack_reviewer", { operations: ["content_pack.review"] });
  const publisher = setupUser(app, "pack_publisher", { operations: ["content_pack.publish"] });
  const retirer = setupUser(app, "pack_retirer", { operations: ["content_pack.retire"] });
  const reader = setupUser(app, "pack_reader");

  const created = await submitDatapack(app, submitter);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const submissionId = created.body.data.submission_id;
  assert.equal(created.body.data.status, "PENDING_REVIEW");
  assert.equal(created.body.data.review, null);
  assert.ok(!JSON.stringify(created.body.data).includes("artifact_base64"), "submission API must never re-serve artifact bytes");
  assert.ok(!created.body.data.submitter_alias.includes(submitter.user.id), "submitter alias must be pseudonymous");

  const replay = await submitDatapack(app, submitter);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.code, "REQUEST_DUPLICATE");
  assert.equal(replay.body.data.submission_id, submissionId);
  assert.equal(app.store.contentPackSubmissions.size, 1, "idempotent replay must not duplicate submissions");

  const own = await app.inject({ method: "GET", url: "/api/v1/content-pack-submissions/" + submissionId, headers: submitter.auth, nowMs: BASE_NOW });
  assert.equal(own.status, 200);
  const otherRead = await app.inject({ method: "GET", url: "/api/v1/content-pack-submissions/" + submissionId, headers: reader.auth, nowMs: BASE_NOW });
  assert.equal(otherRead.status, 404);
  assert.equal(otherRead.body.error.code, "CONTENT_PACK_SUBMISSION_NOT_FOUND");

  const queueDenied = await app.inject({ method: "GET", url: "/api/v1/admin/content-pack-submissions?school_id=haut", headers: reader.auth, nowMs: BASE_NOW });
  assert.equal(queueDenied.status, 403);
  assert.equal(queueDenied.body.error.code, "CONTENT_PACK_PERMISSION_DENIED");
  const queue = await app.inject({ method: "GET", url: "/api/v1/admin/content-pack-submissions?school_id=haut&status=PENDING_REVIEW", headers: reviewer.auth, nowMs: BASE_NOW });
  assert.equal(queue.status, 200, JSON.stringify(queue.body));
  assert.equal(queue.body.data.length, 1);
  assert.equal(queue.body.data[0].submission_id, submissionId);

  const selfReview = await approveSubmission(app, submitter, submissionId, "content-self-review-0001");
  assert.equal(selfReview.status, 403);
  assert.equal(selfReview.body.error.code, "CONTENT_PACK_SUBMITTER_CANNOT_REVIEW");
  assert.equal(app.store.contentPackSubmissions.get(submissionId).status, "PENDING_REVIEW", "self-review must fail before applying any decision");

  const approved = await approveSubmission(app, reviewer, submissionId);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data.status, "APPROVED");
  assert.equal(approved.body.data.review.action, "APPROVE");
  assert.ok(!approved.body.data.review.reviewer_alias.includes(reviewer.user.id));
  const secondReview = await approveSubmission(app, reviewer, submissionId, "content-review-again-0001");
  assert.equal(secondReview.status, 409);
  assert.equal(secondReview.body.error.code, "CONTENT_PACK_REVIEW_INVALID");

  const outsider = setupUser(app, "pack_publish_outsider");
  const publishDenied = await publishSubmission(app, outsider, submissionId, signature, "content-publish-denied-0001");
  assert.equal(publishDenied.status, 403);
  assert.equal(publishDenied.body.error.code, "CONTENT_PACK_PERMISSION_DENIED");

  const published = await publishSubmission(app, publisher, submissionId, signature);
  assert.equal(published.status, 201, JSON.stringify(published.body));
  assert.equal(published.body.data.lifecycle_status, "PUBLISHED");
  assert.equal(published.body.data.artifact_sha256, sha256Hex(artifact));
  assert.equal(published.body.data.signature.scheme, "DIS_DATAPACK_CANONICAL_JSON_SHA256_V1");
  assert.equal(app.store.contentPackSubmissions.get(submissionId).status, "PUBLISHED");

  const publishReplay = await publishSubmission(app, publisher, submissionId, signature);
  assert.equal(publishReplay.status, 200);
  assert.equal(publishReplay.body.code, "REQUEST_DUPLICATE");
  const publishEvents = app.store.outboxEvents.filter((event) => event.event_type === "content-pack.published");
  assert.equal(publishEvents.length, 1, "exactly one content-pack.published event must be emitted");
  const payload = publishEvents[0].payload_json;
  assert.equal(payload.event_key, "dis:content-pack:submission:" + submissionId + ":published:v1");
  assert.equal(payload.event_type, "published");
  assert.equal(payload.school_id, "haut");
  assert.equal(payload.pack_id, "haut.procedures");
  assert.equal(payload.version, "2026.11.1");
  assert.equal(payload.artifact_sha256, sha256Hex(artifact));
  assert.equal(payload.signature_scheme, "DIS_DATAPACK_CANONICAL_JSON_SHA256_V1");
  assert.equal(payload.source_count, 1);
  assert.ok(!payload.published_by_alias.includes(publisher.user.id));
  assert.ok(app.store.auditEvents.some((entry) => entry.id === payload.audit_event_id && entry.action === "content_pack_version.publish"));

  const catalog = await app.inject({ method: "GET", url: "/api/v1/content-packs?school_id=haut&kind=procedure-guide&artifact_format=dis-datapack/v1", headers: reader.auth, nowMs: BASE_NOW });
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  assert.equal(catalog.body.data.length, 1);
  assert.equal(catalog.body.data[0].latest_version, "2026.11.1");
  assert.equal(catalog.body.data[0].verification_level, "UNVERIFIED");

  const versions = await app.inject({ method: "GET", url: "/api/v1/content-packs/haut.procedures/versions?include_retired=true", headers: reader.auth, nowMs: BASE_NOW });
  assert.equal(versions.status, 200);
  assert.equal(versions.body.data.versions.length, 1);
  const detail = await app.inject({ method: "GET", url: "/api/v1/content-packs/haut.procedures/versions/2026.11.1", headers: reader.auth, nowMs: BASE_NOW });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.download_path, "/api/v1/content-packs/haut.procedures/versions/2026.11.1/download");

  const download = await app.inject({ method: "GET", url: "/api/v1/content-packs/haut.procedures/versions/2026.11.1/download", headers: reader.auth, nowMs: BASE_NOW });
  assert.equal(download.status, 200, JSON.stringify(download.body));
  assert.equal(download.headers["x-content-pack-artifact-sha256"], sha256Hex(artifact));
  assert.equal(download.headers["x-content-pack-format"], "dis-datapack/v1");
  assert.equal(download.headers["x-content-pack-version"], "2026.11.1");
  assert.ok(Buffer.isBuffer(download.rawBody));
  assert.ok(download.rawBody.equals(artifact));

  const retireDenied = await app.inject({
    method: "POST",
    url: "/api/v1/admin/content-packs/haut.procedures/versions/2026.11.1/retire",
    headers: writeHeaders(publisher, "content-retire-denied-0001"),
    body: { reason: "OUTDATED", detail: "测试下架" },
    nowMs: BASE_NOW
  });
  assert.equal(retireDenied.status, 403);
  const retired = await app.inject({
    method: "POST",
    url: "/api/v1/admin/content-packs/haut.procedures/versions/2026.11.1/retire",
    headers: writeHeaders(retirer, "content-retire-0001"),
    body: { reason: "OUTDATED", detail: "测试下架" },
    nowMs: BASE_NOW
  });
  assert.equal(retired.status, 200, JSON.stringify(retired.body));
  assert.equal(retired.body.data.lifecycle_status, "RETIRED");
  const retiredDownload = await app.inject({ method: "GET", url: "/api/v1/content-packs/haut.procedures/versions/2026.11.1/download", headers: reader.auth, nowMs: BASE_NOW });
  assert.equal(retiredDownload.status, 410);
  assert.equal(retiredDownload.body.error.code, "CONTENT_PACK_VERSION_RETIRED");
  const defaultCatalog = await app.inject({ method: "GET", url: "/api/v1/content-packs?school_id=haut", headers: reader.auth, nowMs: BASE_NOW });
  assert.equal(defaultCatalog.body.data.length, 0);
  const auditCatalog = await app.inject({ method: "GET", url: "/api/v1/content-packs?school_id=haut&include_retired=true", headers: reader.auth, nowMs: BASE_NOW });
  assert.equal(auditCatalog.body.data.length, 1);
  assert.equal(auditCatalog.body.data[0].latest_version, null);
  const secondRetire = await app.inject({
    method: "POST",
    url: "/api/v1/admin/content-packs/haut.procedures/versions/2026.11.1/retire",
    headers: writeHeaders(retirer, "content-retire-again-0001"),
    body: { reason: "OUTDATED", detail: "重复下架" },
    nowMs: BASE_NOW
  });
  assert.equal(secondRetire.status, 409);
});

test("W5-02 submission validation rejects non-canonical datapacks, provenance drift, digest mismatch, and unsigned/untrusted publish", async () => {
  const { app, keys, artifact, signature } = createSignedDatapackContext();
  const submitter = setupUser(app, "reject_submitter");
  const reviewer = setupUser(app, "reject_reviewer", { operations: ["content_pack.review"] });
  const publisher = setupUser(app, "reject_publisher", { operations: ["content_pack.publish"] });

  const pretty = Buffer.from(JSON.stringify(JSON.parse(artifact.toString("utf8")), null, 2), "utf8");
  const nonCanonical = await submitDatapack(app, submitter, {
    key: "reject-noncanonical-0001",
    body: datapackSubmissionBody({ artifactBytes: pretty })
  });
  assert.equal(nonCanonical.status, 400);
  assert.equal(nonCanonical.body.error.code, "CONTENT_PACK_INVALID");

  const drifted = datapackSubmissionBody();
  drifted.provenance = { ...drifted.provenance, verified_at: "2026-11-21" };
  const provenanceDrift = await submitDatapack(app, submitter, { key: "reject-provenance-0001", body: drifted });
  assert.equal(provenanceDrift.status, 400);
  assert.equal(provenanceDrift.body.error.code, "CONTENT_PACK_INVALID");

  const badDigest = datapackSubmissionBody({ artifact_sha256: "0".repeat(64) });
  const digestMismatch = await submitDatapack(app, submitter, { key: "reject-digest-0001", body: badDigest });
  assert.equal(digestMismatch.status, 400);
  assert.equal(digestMismatch.body.error.code, "CONTENT_PACK_SUBMISSION_INVALID");

  const wrongKind = datapackSubmissionBody({ kind: "school-profile" });
  const kindMismatch = await submitDatapack(app, submitter, { key: "reject-kind-0001", body: wrongKind });
  assert.equal(kindMismatch.status, 400);
  assert.equal(kindMismatch.body.error.code, "CONTENT_PACK_INVALID");

  const created = await submitDatapack(app, submitter, { key: "reject-valid-submit-0001" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const submissionId = created.body.data.submission_id;
  assert.equal((await approveSubmission(app, reviewer, submissionId, "reject-approve-0001")).status, 200);

  const missingSignature = await publishSubmission(app, publisher, submissionId, null, "reject-missing-signature-0001");
  assert.equal(missingSignature.status, 400);
  assert.equal(missingSignature.body.error.code, "CONTENT_PACK_SIGNATURE_INVALID");

  const untrustedKeys = keyPair();
  const untrustedSignature = signDataPackArtifact(artifact, untrustedKeys.privateKeyBase64, untrustedKeys.publicKeyBase64);
  const untrusted = await publishSubmission(app, publisher, submissionId, untrustedSignature, "reject-untrusted-0001");
  assert.equal(untrusted.status, 400);
  assert.equal(untrusted.body.error.code, "CONTENT_PACK_SIGNATURE_INVALID");
  assert.equal(app.store.contentPackVersions.size, 0, "failed signature verification must not publish a version");

  const valid = await publishSubmission(app, publisher, submissionId, signature, "reject-valid-publish-0001");
  assert.equal(valid.status, 201, JSON.stringify(valid.body));
});

function legacyPackageArtifact({ extraEntries = [], payloadPath = "profile/school.json", payloadBytes = Buffer.from("{\"displayName\":\"合成学校\"}", "utf8") } = {}) {
  const files = { [payloadPath]: sha256Hex(payloadBytes) };
  const manifest = {
    format: "dis-campus-plugin/v1",
    id: "haut.school-profile",
    version: "2026.11.1",
    type: "school-profile",
    publisher: "dis-test-publisher",
    license: "MIT",
    targets: [{ schoolId: "haut" }],
    minHostApi: 1,
    minAppVersionCode: 1,
    capabilities: ["TIMETABLE_READ"],
    requiredPermissions: [],
    files,
    verification: { level: "SOURCE_CONFIRMED", fixtureDigest: "a".repeat(64) }
  };
  return writePluginPackageZip([
    ["manifest.json", Buffer.from(JSON.stringify(manifest), "utf8")],
    [payloadPath, payloadBytes],
    ...extraEntries
  ]);
}

function signLegacyArtifact(artifact, keys) {
  const validation = unpackAndValidateLegacySchoolPackage(artifact);
  const payload = legacySignaturePayload(validation);
  const value = crypto.sign(null, payload, crypto.createPrivateKey({ key: Buffer.from(keys.privateKeyBase64, "base64"), format: "der", type: "pkcs8" }));
  return {
    algorithm: "Ed25519",
    scheme: "DIS_CAMPUS_PLUGIN_MANIFEST_FILES_V1",
    public_key_fingerprint: publicFingerprint(keys.publicKeyBase64),
    value: value.toString("base64"),
    signed_payload_sha256: sha256Hex(payload)
  };
}

function legacySubmissionBody(artifact, overrides = {}) {
  return {
    artifact_format: "dis-campus-plugin/v1",
    kind: "school-profile",
    school_id: "haut",
    pack_id: "haut.school-profile",
    version: "2026.11.1",
    artifact_encoding: "base64",
    artifact_sha256: sha256Hex(artifact),
    artifact_base64: artifact.toString("base64"),
    contribution_reference: "https://github.com/example/legacy-pack/pull/1",
    provenance: {
      ...datapackProvenance(),
      verification_level: "SOURCE_CONFIRMED"
    },
    submission_note: "legacy school package test",
    ...overrides
  };
}

test("W5-02 legacy school package strict zip validation and detached manifest/files signature publish", async () => {
  const keys = keyPair();
  const fingerprint = publicFingerprint(keys.publicKeyBase64);
  const app = createCampusCloudApp({
    requireAdminAccess: false,
    contentPackTrustedKeys: { [fingerprint]: keys.publicKeyBase64 }
  });
  const submitter = setupUser(app, "legacy_submitter");
  const reviewer = setupUser(app, "legacy_reviewer", { operations: ["content_pack.review"] });
  const publisher = setupUser(app, "legacy_publisher", { operations: ["content_pack.publish"] });
  const artifact = legacyPackageArtifact();

  const malicious = legacyPackageArtifact({ extraEntries: [["assets/undeclared.txt", Buffer.from("extra", "utf8")]] });
  const undeclared = await submitDatapack(app, submitter, {
    key: "legacy-undeclared-0001",
    body: legacySubmissionBody(malicious)
  });
  assert.equal(undeclared.status, 400);
  assert.equal(undeclared.body.error.code, "CONTENT_PACK_INVALID");

  const created = await submitDatapack(app, submitter, {
    key: "legacy-submit-0001",
    body: legacySubmissionBody(artifact)
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const submissionId = created.body.data.submission_id;
  assert.equal((await approveSubmission(app, reviewer, submissionId, "legacy-approve-0001")).status, 200);
  const signature = signLegacyArtifact(artifact, keys);
  const published = await publishSubmission(app, publisher, submissionId, signature, "legacy-publish-0001");
  assert.equal(published.status, 201, JSON.stringify(published.body));
  assert.equal(published.body.data.artifact_format, "dis-campus-plugin/v1");
  assert.equal(published.body.data.min_host_api, 1);
  assert.equal(published.body.data.min_app_version_code, 1);
  const download = await app.inject({ method: "GET", url: "/api/v1/content-packs/haut.school-profile/versions/2026.11.1/download", headers: submitter.auth, nowMs: BASE_NOW });
  assert.equal(download.status, 200);
  assert.ok(download.rawBody.equals(artifact));
});

test("W5-02 rate limits count validation attempts and every artifact download", async () => {
  const limited = createSignedDatapackContext({ contentPackSubmitRateLimitPerHour: 1, contentPackDownloadRateLimitPerHour: 1 });
  const submitter = setupUser(limited.app, "rate_submitter");
  const reviewer = setupUser(limited.app, "rate_reviewer", { operations: ["content_pack.review"] });
  const publisher = setupUser(limited.app, "rate_publisher", { operations: ["content_pack.publish"] });

  const pretty = Buffer.from(JSON.stringify(JSON.parse(limited.artifact.toString("utf8")), null, 2), "utf8");
  const invalid = await submitDatapack(limited.app, submitter, {
    key: "rate-invalid-submit-0001",
    body: datapackSubmissionBody({ artifactBytes: pretty })
  });
  assert.equal(invalid.status, 400, "the first invalid submission should still reach artifact validation");
  const throttled = await submitDatapack(limited.app, submitter, { key: "rate-valid-submit-0001" });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.body.error.code, "CONTENT_PACK_RATE_LIMITED");

  const unlimited = createSignedDatapackContext({ contentPackDownloadRateLimitPerHour: 1 });
  const user2 = setupUser(unlimited.app, "rate2_submitter");
  const reviewer2 = setupUser(unlimited.app, "rate2_reviewer", { operations: ["content_pack.review"] });
  const publisher2 = setupUser(unlimited.app, "rate2_publisher", { operations: ["content_pack.publish"] });
  const created = await submitDatapack(unlimited.app, user2, { key: "rate2-submit-0001" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const submissionId = created.body.data.submission_id;
  assert.equal((await approveSubmission(unlimited.app, reviewer2, submissionId, "rate2-approve-0001")).status, 200);
  assert.equal((await publishSubmission(unlimited.app, publisher2, submissionId, unlimited.signature, "rate2-publish-0001")).status, 201);
  const firstDownload = await unlimited.app.inject({ method: "GET", url: "/api/v1/content-packs/haut.procedures/versions/2026.11.1/download", headers: reviewer2.auth, nowMs: BASE_NOW });
  assert.equal(firstDownload.status, 200);
  const secondDownload = await unlimited.app.inject({ method: "GET", url: "/api/v1/content-packs/haut.procedures/versions/2026.11.1/download", headers: reviewer2.auth, nowMs: BASE_NOW });
  assert.equal(secondDownload.status, 429);
  assert.equal(secondDownload.body.error.code, "CONTENT_PACK_RATE_LIMITED");
});

test("W5-02 artifact metadata and sidecar bytes survive snapshot restart before review and publish", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-content-catalog-"));
  const snapshotPath = path.join(tmpDir, "cloud-state.json");
  try {
    const first = createSignedDatapackContext({ storeOptions: { snapshotPath } });
    const submitter = setupUser(first.app, "restart_submitter");
    const created = await submitDatapack(first.app, submitter, { key: "restart-submit-0001" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const submissionId = created.body.data.submission_id;

    const second = createSignedDatapackContext({ storeOptions: { snapshotPath } });
    assert.ok(second.app.store.contentPackSubmissions.has(submissionId), "submission metadata must reload from snapshot");
    const reviewer = setupUser(second.app, "restart_reviewer", { operations: ["content_pack.review"] });
    const publisher = setupUser(second.app, "restart_publisher", { operations: ["content_pack.publish"] });
    assert.equal((await approveSubmission(second.app, reviewer, submissionId, "restart-approve-0001")).status, 200);
    const published = await publishSubmission(second.app, publisher, submissionId, second.signature, "restart-publish-0001");
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const download = await second.app.inject({ method: "GET", url: "/api/v1/content-packs/haut.procedures/versions/2026.11.1/download", headers: reviewer.auth, nowMs: BASE_NOW });
    assert.equal(download.status, 200);
    assert.ok(download.rawBody.equals(second.artifact));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("W5-02 data export contains metadata without artifact bytes and data-delete erases unpublished catalog rows to zero", async () => {
  const { app } = createSignedDatapackContext();
  const submitter = setupUser(app, "erase_submitter");
  const created = await submitDatapack(app, submitter, { key: "erase-submit-0001" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const submissionId = created.body.data.submission_id;

  const exported = await app.inject({ method: "POST", url: "/api/v1/me/data-export", headers: submitter.auth, nowMs: BASE_NOW });
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.equal(exported.body.data.content_pack_submissions.length, 1);
  assert.ok(!JSON.stringify(exported.body.data.content_pack_submissions).includes("artifact_base64"));

  const deleted = await app.inject({ method: "POST", url: "/api/v1/me/data-delete", headers: submitter.auth, nowMs: BASE_NOW });
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
  assert.equal(deleted.body.data.content_pack_purged.unpublished_submissions_deleted, 1);
  assert.equal(app.store.contentPackSubmissions.size, 0, "unpublished submissions must erase to zero");
  assert.equal(app.store.contentPackReviews.size, 0, "unpublished submission reviews must erase to zero");
  assert.ok(!app.store.contentPackSubmissions.has(submissionId));
});
