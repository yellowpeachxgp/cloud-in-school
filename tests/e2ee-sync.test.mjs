import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { SnapshotFs } from "./helpers/snapshot-fs.mjs";

const BASE_NOW = Date.parse("2026-12-05T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DOC_SHA = "a".repeat(64);
let keySeq = 0;

function nextKey(prefix) {
  keySeq += 1;
  return prefix + "-" + keySeq + "-12345678";
}

function createTestApp(options = {}) {
  const app = createCampusCloudApp({ requireAdminAccess: false, ...options });
  const rawInject = app.inject.bind(app);
  app.inject = (request) => rawInject({ nowMs: BASE_NOW, ...request });
  return app;
}

function signAuth(app, user, familyId, nowMs) {
  const session = Array.from(app.store.deviceSessions.values()).find((row) => row.cloud_user_id === user.id && row.family_id === familyId && !row.revoked_at);
  assert.ok(session, "expected live cloud session for signing test access token");
  const token = app.identity.signAccessToken({
    sub: user.id,
    familyId,
    sessionId: session.id,
    iss: user.issuer,
    ssoSub: user.subject,
    roles: app.store.getUserRoles(user.id),
    nowMs
  });
  return { authorization: "Bearer " + token };
}

function setupUser(app, label, nowMs = BASE_NOW) {
  const user = app.store.findOrCreateCloudUser({
    issuer: app.identity.expectedIssuer,
    subject: "sub_" + label + "_" + crypto.randomUUID().slice(0, 8),
    username: label,
    displayName: label
  });
  const session = app.identity.issueDeviceSession(user, label, null, 1, nowMs, "MOBILE_APP");
  return {
    user,
    session,
    familyId: session.family_id,
    authAt(ms = BASE_NOW) {
      return signAuth(app, user, session.family_id, ms);
    },
    get auth() {
      return this.authAt(BASE_NOW);
    }
  };
}

function addSession(app, fixture, label, nowMs = BASE_NOW) {
  const session = app.identity.issueDeviceSession(fixture.user, label, null, 1, nowMs, "MOBILE_APP");
  return {
    user: fixture.user,
    session,
    familyId: session.family_id,
    authAt(ms = BASE_NOW) {
      return signAuth(app, fixture.user, session.family_id, ms);
    },
    get auth() {
      return this.authAt(BASE_NOW);
    }
  };
}

async function grantE2ee(app, fixture, nowMs = BASE_NOW) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: fixture.authAt(nowMs),
    body: {
      purpose: "E2EE_CLOUD_SYNC",
      document_version: "e2ee-sync-consent-v1",
      document_sha256: DOC_SHA
    },
    nowMs
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.purpose, "E2EE_CLOUD_SYNC");
  return response.body.data;
}

async function registerDevice(app, fixture, consent, {
  deviceId = crypto.randomUUID(),
  label = "测试 Android",
  key = nextKey("sync-device-register"),
  nowMs = BASE_NOW
} = {}) {
  return app.inject({
    method: "PUT",
    url: "/api/v1/sync/devices/" + deviceId,
    headers: { ...fixture.authAt(nowMs), "idempotency-key": key },
    body: {
      consent_id: consent.id,
      device_label: label,
      platform: "ANDROID",
      sync_protocol_version: 1
    },
    nowMs
  });
}

function encryption() {
  return {
    format: "dis-sync-e2ee/v1",
    cipher_suite: "AES-256-GCM",
    padding_scheme: "DIS_SYNC_SIZE_BUCKETS_POW4_V1",
    key_id: "demo-key-0001",
    nonce_base64: "AAAAAAAAAAAAAAAA"
  };
}

function cipherBlob(size = 1024, seed = 1) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index + seed) % 251;
  const ciphertext_base64 = bytes.toString("base64");
  return {
    ciphertext_base64,
    ciphertext_sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    size
  };
}

function vector(deviceId, counter) {
  return [{ device_id: deviceId, counter }];
}

async function putBlob(app, fixture, deviceId, blobId, {
  counter = 1,
  baseVector = [],
  seed = 1,
  size = 1024,
  key = nextKey("sync-blob-put"),
  nowMs = BASE_NOW,
  mutateBody = null
} = {}) {
  const cipher = cipherBlob(size, seed);
  const body = {
    encryption: encryption(),
    ciphertext_base64: cipher.ciphertext_base64,
    ciphertext_sha256: cipher.ciphertext_sha256,
    base_vector: baseVector,
    writer_counter: counter,
    ...(mutateBody || {})
  };
  return app.inject({
    method: "PUT",
    url: "/api/v1/sync/blobs/" + blobId,
    headers: {
      ...fixture.authAt(nowMs),
      "x-dis-sync-device-id": deviceId,
      "idempotency-key": key
    },
    body,
    nowMs
  });
}

async function deleteBlob(app, fixture, deviceId, blobId, baseVector, counter, {
  key = nextKey("sync-blob-delete"),
  nowMs = BASE_NOW
} = {}) {
  return app.inject({
    method: "DELETE",
    url: "/api/v1/sync/blobs/" + blobId,
    headers: {
      ...fixture.authAt(nowMs),
      "x-dis-sync-device-id": deviceId,
      "idempotency-key": key
    },
    body: { base_vector: baseVector, writer_counter: counter },
    nowMs
  });
}

async function downloadBlob(app, fixture, deviceId, blobId, nowMs = BASE_NOW) {
  return app.inject({
    method: "GET",
    url: "/api/v1/sync/blobs/" + blobId,
    headers: { ...fixture.authAt(nowMs), "x-dis-sync-device-id": deviceId },
    nowMs
  });
}

async function listChanges(app, fixture, deviceId, queryString = "", nowMs = BASE_NOW) {
  return app.inject({
    method: "GET",
    url: "/api/v1/sync/changes" + queryString,
    headers: { ...fixture.authAt(nowMs), "x-dis-sync-device-id": deviceId },
    nowMs
  });
}

async function setupDeviceUser(app, label, nowMs = BASE_NOW) {
  const fixture = setupUser(app, label, nowMs);
  const consent = await grantE2ee(app, fixture, nowMs);
  const deviceId = crypto.randomUUID();
  const registered = await registerDevice(app, fixture, consent, { deviceId, nowMs });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  return { fixture, consent, deviceId };
}

test("W4-11 sync devices: E2EE consent fail-closed, immutable binding, permanent revocation, quotas, and security metadata shape", async () => {
  const app = createTestApp();
  const fixture = setupUser(app, "sync_device_user");
  const deviceId = crypto.randomUUID();

  const missingConsent = await registerDevice(app, fixture, { id: crypto.randomUUID() }, { deviceId });
  assert.equal(missingConsent.status, 403);
  assert.equal(missingConsent.body.error.code, "SYNC_CONSENT_REQUIRED");

  const legacy = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: fixture.auth,
    body: { school_id: "haut" }
  });
  assert.equal(legacy.status, 201);
  const legacyAttempt = await registerDevice(app, fixture, { id: legacy.body.data.id }, { deviceId });
  assert.equal(legacyAttempt.status, 403);
  assert.equal(legacyAttempt.body.error.code, "SYNC_CONSENT_REQUIRED");

  const consent = await grantE2ee(app, fixture);
  const key = nextKey("sync-device-replay");
  const first = await registerDevice(app, fixture, consent, { deviceId, key });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.data.device_id, deviceId);
  assert.equal(first.body.data.status, "ACTIVE");
  assert.equal(first.body.data.last_seen_at !== null, true);
  assert.equal(Object.hasOwn(first.body.data, "session_family_id"), false);
  assert.equal(Object.hasOwn(first.body.data, "consent_id"), false);

  const replay = await registerDevice(app, fixture, consent, { deviceId, key });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.code, "REQUEST_DUPLICATE");
  assert.equal(replay.body.data.device_id, deviceId);

  const changed = await registerDevice(app, fixture, consent, { deviceId, label: "不可改写" });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error.code, "SYNC_DEVICE_CONFLICT");

  const secondSession = addSession(app, fixture, "sync_device_second_session");
  const crossSession = await registerDevice(app, secondSession, consent, { deviceId });
  assert.equal(crossSession.status, 409);
  assert.equal(crossSession.body.error.code, "SYNC_DEVICE_CONFLICT");

  const list = await app.inject({ method: "GET", url: "/api/v1/sync/devices", headers: fixture.auth });
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 1);
  assert.equal(Object.hasOwn(list.body.data[0], "session_family_id"), false);

  const quotaBase = Array.from({ length: 31 }, () => crypto.randomUUID());
  for (const id of quotaBase) {
    const res = await registerDevice(app, fixture, consent, { deviceId: id });
    assert.equal(res.status, 201, "quota setup registration failed: " + JSON.stringify(res.body));
  }
  const quotaExceeded = await registerDevice(app, fixture, consent, { deviceId: crypto.randomUUID() });
  assert.equal(quotaExceeded.status, 403);
  assert.equal(quotaExceeded.body.error.code, "SYNC_QUOTA_EXCEEDED");
  assert.equal(quotaExceeded.body.error.detail.dimension, "ACTIVE_DEVICES");

  const revokeKey = nextKey("sync-device-revoke");
  const revoke = await app.inject({
    method: "DELETE",
    url: "/api/v1/sync/devices/" + deviceId,
    headers: { ...fixture.auth, "idempotency-key": revokeKey },
    body: { reason: "LOST_OR_STOLEN" }
  });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
  assert.equal(revoke.body.data.status, "REVOKED");
  assert.equal(revoke.body.data.revocation_reason, "LOST_OR_STOLEN");
  const familySessions = Array.from(app.store.deviceSessions.values()).filter((row) => row.family_id === fixture.familyId);
  assert.ok(familySessions.length > 0 && familySessions.every((row) => row.revoked_at), "revocation must invalidate the internally bound session family");

  const repeat = await app.inject({
    method: "DELETE",
    url: "/api/v1/sync/devices/" + deviceId,
    headers: { authorization: "Bearer " + fixture.session.access_token, "idempotency-key": nextKey("sync-device-revoke-repeat") },
    body: { reason: "USER_REMOVED" }
  });
  assert.equal(repeat.status, 401, "the revoked session family itself must fail closed on subsequent use");
  const resurrect = await app.inject({
    method: "PUT",
    url: "/api/v1/sync/devices/" + deviceId,
    headers: { authorization: "Bearer " + fixture.session.access_token, "idempotency-key": nextKey("sync-device-resurrect") },
    body: { consent_id: consent.id, device_label: "测试 Android", platform: "ANDROID", sync_protocol_version: 1 }
  });
  assert.equal(resurrect.status, 401);
  const revokedEvents = app.store.outboxEvents.filter((event) => event.event_type === "sync.device.revoked" && event.payload_json.device_id === deviceId);
  assert.equal(revokedEvents.length, 1);
});

test("W4-11 sync blobs: fixed buckets, ciphertext-only storage, strict vector CAS, idempotent replay, and download egress accounting", async () => {
  const app = createTestApp();
  const { fixture, deviceId } = await setupDeviceUser(app, "sync_blob_user");
  const blobId = crypto.randomUUID();
  const putKey = nextKey("sync-put-replay");
  const first = await putBlob(app, fixture, deviceId, blobId, { key: putKey });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.data.change_sequence, 1);
  assert.deepEqual(first.body.data.version_vector, vector(deviceId, 1));
  assert.equal(first.body.data.ciphertext_size_bytes, 1024);

  const current = app.store.syncBlobs.get(fixture.user.id + ":" + blobId);
  assert.equal(Object.hasOwn(current, "ciphertext_base64"), false, "current row must never inline ciphertext bytes");
  assert.equal(Object.hasOwn(current, "ciphertext"), false);
  assert.equal(current.ciphertext_size_bytes, 1024);
  assert.ok(
    app.store.syncCiphertextMemory.has(current.ciphertext_sha256),
    "ciphertext bytes live in the content-addressed sidecar, keyed by their digest"
  );
  const mutation = app.store.syncMutations.get(fixture.user.id + ":1");
  assert.ok(mutation, "metadata mutation row must exist");
  assert.equal(Object.hasOwn(mutation, "ciphertext_base64"), false);
  assert.equal(Object.hasOwn(mutation, "ciphertext"), false);
  const serializedStore = JSON.stringify({
    mutation,
    metadata: first.body.data,
    device: first.body.data.encryption
  });
  assert.equal(serializedStore.includes("plaintext"), false);
  assert.equal(serializedStore.includes("private_key"), false);

  const replay = await putBlob(app, fixture, deviceId, blobId, { key: putKey });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.code, "REQUEST_DUPLICATE");
  assert.equal(replay.body.data.change_sequence, 1);
  assert.equal(app.store.syncMutations.size, 1);

  const invalidSizeBody = (() => {
    const bytes = Buffer.alloc(1000, 7);
    return {
      encryption: encryption(),
      ciphertext_base64: bytes.toString("base64"),
      ciphertext_sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      base_vector: vector(deviceId, 1),
      writer_counter: 2
    };
  })();
  const ingressRowsBefore = Array.from(app.store.syncTransferUsage.values()).filter((row) => row.direction === "INGRESS");
  const ingressBytesBefore = ingressRowsBefore.reduce((sum, row) => sum + Number(row.bytes || 0), 0);
  const invalidSize = await app.inject({
    method: "PUT",
    url: "/api/v1/sync/blobs/" + crypto.randomUUID(),
    headers: { ...fixture.auth, "x-dis-sync-device-id": deviceId, "idempotency-key": nextKey("sync-invalid-size") },
    body: invalidSizeBody
  });
  assert.equal(invalidSize.status, 400);
  assert.equal(invalidSize.body.error.code, "SYNC_ENVELOPE_INVALID");
  const ingressRowsAfter = Array.from(app.store.syncTransferUsage.values()).filter((row) => row.direction === "INGRESS");
  const ingressBytesAfter = ingressRowsAfter.reduce((sum, row) => sum + Number(row.bytes || 0), 0);
  assert.ok(ingressBytesAfter > ingressBytesBefore, "every authenticated PUT attempt must count ingress even when validation rejects");
  assert.ok(
    ingressRowsAfter.length <= ingressRowsBefore.length + 1 && ingressRowsAfter.filter((row) => Number.isSafeInteger(row.bucket_start_ms)).length <= 1,
    "rejected attempts must aggregate into the bounded hour bucket rather than one row per attempt"
  );

  const stale = await putBlob(app, fixture, deviceId, blobId, { baseVector: [], counter: 1, seed: 9 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "SYNC_VECTOR_CONFLICT");
  assert.deepEqual(stale.body.error.detail.current_vector, vector(deviceId, 1));
  assert.equal(Object.hasOwn(stale.body.error.detail, "ciphertext_base64"), false);

  const second = await putBlob(app, fixture, deviceId, blobId, { baseVector: vector(deviceId, 1), counter: 2, seed: 2 });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.data.change_sequence, 2);
  assert.deepEqual(second.body.data.version_vector, vector(deviceId, 2));

  const download = await downloadBlob(app, fixture, deviceId, blobId);
  assert.equal(download.status, 200, JSON.stringify(download.body));
  assert.equal(download.body.data.ciphertext_base64, cipherBlob(1024, 2).ciphertext_base64);
  assert.equal(download.body.data.metadata.change_sequence, 2);
  assert.equal(download.body.data.metadata.encryption.padding_scheme, "DIS_SYNC_SIZE_BUCKETS_POW4_V1");
  assert.ok(Array.from(app.store.syncTransferUsage.values()).some((row) => row.direction === "EGRESS" && row.bytes > 0), "successful download must count egress bytes");
});

test("W4-11 sync tombstones: causal delete, no ciphertext retention, permanent anti-resurrection, and single delete event", async () => {
  const app = createTestApp();
  const { fixture, deviceId } = await setupDeviceUser(app, "sync_tombstone_user");
  const blobId = crypto.randomUUID();
  assert.equal((await putBlob(app, fixture, deviceId, blobId)).status, 201);

  const staleDelete = await deleteBlob(app, fixture, deviceId, blobId, [], 1);
  assert.equal(staleDelete.status, 409);
  assert.equal(staleDelete.body.error.code, "SYNC_VECTOR_CONFLICT");
  assert.equal(app.store.syncBlobs.get(fixture.user.id + ":" + blobId).change_kind, "UPSERT");

  const deleted = await deleteBlob(app, fixture, deviceId, blobId, vector(deviceId, 1), 2);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.data.change_kind, "TOMBSTONE");
  assert.equal(deleted.body.data.ciphertext_sha256, null);
  assert.equal(deleted.body.data.ciphertext_size_bytes, null);
  const tombstone = app.store.syncBlobs.get(fixture.user.id + ":" + blobId);
  assert.equal(Object.hasOwn(tombstone, "ciphertext_base64"), false, "primary storage must drop ciphertext in the same atomic tombstone commit");
  assert.ok(app.store.syncBlobAntiResurrection.has(fixture.user.id + ":" + blobId), "minimal anti-resurrection marker must survive");

  const download = await downloadBlob(app, fixture, deviceId, blobId);
  assert.equal(download.status, 410);
  assert.equal(download.body.error.code, "SYNC_BLOB_DELETED");
  const resurrect = await putBlob(app, fixture, deviceId, blobId, { baseVector: vector(deviceId, 2), counter: 3, seed: 4 });
  assert.equal(resurrect.status, 410);
  assert.equal(resurrect.body.error.code, "SYNC_BLOB_DELETED");

  const repeatDelete = await deleteBlob(app, fixture, deviceId, blobId, vector(deviceId, 2), 3);
  assert.equal(repeatDelete.status, 200);
  assert.equal(repeatDelete.body.data.change_sequence, 2);
  assert.equal(app.store.syncMutations.size, 2, "repeat tombstone must not create a second causal mutation");
  assert.equal(app.store.outboxEvents.filter((event) => event.event_type === "sync.blob.deleted" && event.payload_json.blob_id === blobId).length, 1);

  const missing = await deleteBlob(app, fixture, deviceId, crypto.randomUUID(), [], 1);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "SYNC_BLOB_NOT_FOUND");
});

test("W4-11 sync changes: snapshot_epoch pagination, terminal incremental cursor, device binding, and collapsed cursorless resync", async () => {
  const app = createTestApp();
  const { fixture, consent, deviceId } = await setupDeviceUser(app, "sync_cursor_user");
  const blobA = crypto.randomUUID();
  const blobB = crypto.randomUUID();
  const blobC = crypto.randomUUID();
  assert.equal((await putBlob(app, fixture, deviceId, blobA, { seed: 1 })).status, 201);
  assert.equal((await putBlob(app, fixture, deviceId, blobB, { seed: 2 })).status, 201);
  assert.equal((await putBlob(app, fixture, deviceId, blobC, { seed: 3 })).status, 201);

  const page1 = await listChanges(app, fixture, deviceId, "?limit=1");
  assert.equal(page1.status, 200, JSON.stringify(page1.body));
  assert.equal(page1.body.data.length, 1);
  assert.equal(page1.body.data[0].blob_id, blobA);
  assert.equal(page1.body.meta.has_more, true);
  assert.equal(page1.body.meta.snapshot_epoch, 3);
  assert.equal(page1.body.meta.compaction_epoch, 0);
  assert.ok(page1.body.meta.next_cursor);

  const page2 = await listChanges(app, fixture, deviceId, "?limit=1&cursor=" + encodeURIComponent(page1.body.meta.next_cursor));
  assert.equal(page2.status, 200);
  assert.equal(page2.body.data.length, 1);
  assert.equal(page2.body.data[0].blob_id, blobB);
  assert.equal(page2.body.meta.snapshot_epoch, 3);
  assert.equal(page2.body.meta.has_more, true);

  const page3 = await listChanges(app, fixture, deviceId, "?limit=1&cursor=" + encodeURIComponent(page2.body.meta.next_cursor));
  assert.equal(page3.status, 200);
  assert.equal(page3.body.data.length, 1);
  assert.equal(page3.body.data[0].blob_id, blobC);
  assert.equal(page3.body.meta.has_more, false);
  assert.equal(page3.body.meta.snapshot_epoch, 3);
  const terminalCursor = page3.body.meta.next_cursor;
  assert.ok(terminalCursor);

  const secondSession = addSession(app, fixture, "sync_cursor_second_session");
  const secondDevice = crypto.randomUUID();
  const secondRegistration = await registerDevice(app, secondSession, consent, { deviceId: secondDevice });
  assert.equal(secondRegistration.status, 201, JSON.stringify(secondRegistration.body));
  const crossDevice = await listChanges(app, secondSession, secondDevice, "?cursor=" + encodeURIComponent(terminalCursor));
  assert.equal(crossDevice.status, 400);
  assert.equal(crossDevice.body.error.code, "SYNC_CURSOR_INVALID");

  const blobD = crypto.randomUUID();
  assert.equal((await putBlob(app, fixture, deviceId, blobD, { seed: 4 })).status, 201);
  const incremental = await listChanges(app, fixture, deviceId, "?cursor=" + encodeURIComponent(terminalCursor));
  assert.equal(incremental.status, 200, JSON.stringify(incremental.body));
  assert.deepEqual(incremental.body.data.map((row) => row.blob_id), [blobD]);
  assert.equal(incremental.body.meta.snapshot_epoch, 4);
  assert.equal(incremental.body.meta.has_more, false);

  const updated = await putBlob(app, fixture, deviceId, blobA, { baseVector: vector(deviceId, 1), counter: 2, seed: 8 });
  assert.equal(updated.status, 200);
  const resync = await listChanges(app, fixture, deviceId, "?limit=10");
  assert.equal(resync.status, 200);
  assert.equal(resync.body.data.length, 4);
  const collapsedA = resync.body.data.find((row) => row.blob_id === blobA);
  assert.deepEqual(collapsedA.version_vector, vector(deviceId, 2), "cursorless resync must expose current state, not obsolete intermediate versions");
  assert.equal(resync.body.meta.snapshot_epoch, 5);

  const empty = await listChanges(app, fixture, deviceId, "?cursor=" + encodeURIComponent(resync.body.meta.next_cursor));
  assert.equal(empty.status, 200);
  assert.equal(empty.body.data.length, 0);
  assert.equal(empty.body.meta.has_more, false, "empty page is terminal exactly when has_more=false");
  assert.ok(empty.body.meta.next_cursor);
});

test("W4-11 sync consent lifecycle: withdrawal disables blobs, cursorless reauthorization survives, expiry purges content and auto-revokes devices", async () => {
  const app = createTestApp();
  const { fixture, consent, deviceId } = await setupDeviceUser(app, "sync_lifecycle_user");
  const blobId = crypto.randomUUID();
  assert.equal((await putBlob(app, fixture, deviceId, blobId)).status, 201);
  const firstPage = await listChanges(app, fixture, deviceId, "?limit=1");
  assert.equal(firstPage.status, 200);
  const oldCursor = firstPage.body.meta.next_cursor;
  const schoolBinding = {
    id: crypto.randomUUID(),
    cloud_user_id: fixture.user.id,
    school_id: "haut",
    student_no: "2026990101",
    status: "DELEGATED_ACTIVE",
    credential_ref: null,
    consent_id: null,
    auth_version: 1,
    created_at: new Date(BASE_NOW).toISOString(),
    revoked_at: null
  };
  app.store.schoolBindings.set(schoolBinding.id, schoolBinding);
  app.store.indexUserScoped?.("schoolBindings", schoolBinding.id, fixture.user.id);

  const withdrawn = await app.inject({
    method: "DELETE",
    url: "/api/v1/me/consents/" + consent.id,
    headers: fixture.auth,
    nowMs: BASE_NOW + HOUR
  });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  assert.ok(withdrawn.body.data.sync_withdrawal, "withdrawal response must expose the sync retention lifecycle");
  assert.equal(withdrawn.body.data.sync_withdrawal.retention_expires_at, new Date(BASE_NOW + HOUR + 30 * DAY).toISOString());
  assert.deepEqual(withdrawn.body.data.cancelled_job_ids, [], "withdrawing user-scope E2EE consent must not revoke school delegation");
  assert.equal(app.store.schoolBindings.get(schoolBinding.id).revoked_at, null);

  const blocked = await downloadBlob(app, fixture, deviceId, blobId, BASE_NOW + HOUR + 1);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, "SYNC_CONSENT_REQUIRED");
  const devicesWhileWithdrawn = await app.inject({
    method: "GET",
    url: "/api/v1/sync/devices",
    headers: fixture.authAt(BASE_NOW + HOUR + 2),
    nowMs: BASE_NOW + HOUR + 2
  });
  assert.equal(devicesWhileWithdrawn.status, 200, "device security management remains available after withdrawal");
  const cursorRow = Array.from(app.store.syncCursors.values()).find((row) => row.device_id === deviceId);
  assert.ok(cursorRow?.invalidated_at, "withdrawal must invalidate every device-bound cursor");
  assert.equal(Array.from(app.store.syncDevices.values()).find((row) => row.device_id === deviceId).acknowledged_cursor_position, 0);

  const reauth = await grantE2ee(app, fixture, BASE_NOW + 2 * HOUR);
  const stillBlockedOldCursor = await listChanges(app, fixture, deviceId, "?cursor=" + encodeURIComponent(oldCursor), BASE_NOW + 2 * HOUR + 1);
  assert.equal(stillBlockedOldCursor.status, 400);
  assert.equal(stillBlockedOldCursor.body.error.code, "SYNC_CURSOR_INVALID");
  const resync = await listChanges(app, fixture, deviceId, "?limit=10", BASE_NOW + 2 * HOUR + 2);
  assert.equal(resync.status, 200, JSON.stringify(resync.body));
  assert.equal(resync.body.data.length, 1, "reauthorization within retention preserves ciphertext but requires cursorless resync");

  const secondWithdrawn = await app.inject({
    method: "DELETE",
    url: "/api/v1/me/consents/" + reauth.id,
    headers: fixture.authAt(BASE_NOW + 3 * HOUR),
    nowMs: BASE_NOW + 3 * HOUR
  });
  assert.equal(secondWithdrawn.status, 200);
  const expiryMs = BASE_NOW + 3 * HOUR + 30 * DAY + 1;
  const postExpiryExport = await app.inject({
    method: "POST",
    url: "/api/v1/me/data-export",
    headers: fixture.authAt(expiryMs),
    nowMs: expiryMs
  });
  assert.equal(postExpiryExport.status, 200, JSON.stringify(postExpiryExport.body));
  assert.equal(postExpiryExport.body.data.sync_blobs.length, 0, "post-expiry export must not disclose ciphertext scheduled for deletion");
  assert.equal(postExpiryExport.body.data.sync_blob_mutations.length, 0);
  assert.equal(postExpiryExport.body.data.sync_devices[0].status, "REVOKED");
  assert.equal(postExpiryExport.body.data.sync_devices[0].revocation_reason, "CONSENT_WITHDRAWN");
  const deviceRow = Array.from(app.store.syncDevices.values()).find((row) => row.device_id === deviceId);
  assert.equal(deviceRow.status, "REVOKED");
  assert.equal(deviceRow.revocation_reason, "CONSENT_WITHDRAWN");
  assert.equal(Array.from(app.store.syncBlobs.values()).filter((row) => row.cloud_user_id === fixture.user.id).length, 0);
  assert.equal(Array.from(app.store.syncMutations.values()).filter((row) => row.cloud_user_id === fixture.user.id).length, 0);
  assert.equal(Array.from(app.store.syncCursors.values()).filter((row) => row.cloud_user_id === fixture.user.id).length, 0);
});

test("W4-11 sync export and account erasure: export is ciphertext+metadata only and data-delete leaves zero sync rows", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-e2ee-delete-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshotPath = path.join(dir, "state.json");
  const app = createTestApp({ storeOptions: { snapshotPath, requireDurableSnapshot: true } });
  t.after(() => clearTimeout(app.store._snapshotFlushTimer));
  const { fixture, deviceId } = await setupDeviceUser(app, "sync_export_user");
  const blobId = crypto.randomUUID();
  const put = await putBlob(app, fixture, deviceId, blobId);
  assert.equal(put.status, 201, JSON.stringify(put.body));

  const exported = await app.inject({ method: "POST", url: "/api/v1/me/data-export", headers: fixture.auth });
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.equal(exported.body.data.sync_blobs.length, 1);
  assert.equal(exported.body.data.sync_blobs[0].ciphertext_base64, cipherBlob().ciphertext_base64);
  assert.equal(exported.body.data.sync_blob_mutations.length, 1);
  assert.equal(Object.hasOwn(exported.body.data.sync_blob_mutations[0], "ciphertext_base64"), false);
  assert.equal(Object.hasOwn(exported.body.data.sync_devices[0], "session_family_id"), false);
  assert.equal(Object.hasOwn(exported.body.data.sync_devices[0], "consent_id"), false);

  const deleted = await app.inject({ method: "POST", url: "/api/v1/me/data-delete", headers: fixture.auth });
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
  assert.ok(deleted.body.data.sync_purged);
  for (const field of ["syncDevices", "syncBlobs", "syncMutations", "syncBlobAntiResurrection", "syncCursors", "syncTransferUsage", "syncRateWindows", "syncUserStates"]) {
    assert.equal(app.store[field].size, 0, field + " must be zero after account data deletion");
  }
  for (const key of app.store.idempotencyRecords.keys()) {
    assert.equal(key.includes("putSyncBlob|" + fixture.user.id + "|"), false, "sync idempotency receipts must not retain deleted-account metadata");
  }
});

test("W4-11 sync durability: device, ciphertext metadata, cursor state, and idempotent replay survive restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-e2ee-durable-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshotPath = path.join(dir, "state.json");
  const app = createTestApp({ storeOptions: { snapshotPath, requireDurableSnapshot: true } });
  t.after(() => clearTimeout(app.store._snapshotFlushTimer));
  const { fixture, consent, deviceId } = await setupDeviceUser(app, "sync_durable_user");
  const blobId = crypto.randomUUID();
  const putKey = nextKey("sync-durable-put");
  const put = await putBlob(app, fixture, deviceId, blobId, { key: putKey });
  assert.equal(put.status, 201, JSON.stringify(put.body));
  const page = await listChanges(app, fixture, deviceId, "?limit=1");
  assert.equal(page.status, 200);

  const restarted = createTestApp({ storeOptions: { snapshotPath, requireDurableSnapshot: true } });
  t.after(() => clearTimeout(restarted.store._snapshotFlushTimer));
  const restartedFixture = {
    user: restarted.store.users.get(fixture.user.id),
    familyId: fixture.familyId,
    authAt(ms = BASE_NOW) {
      return signAuth(restarted, this.user, fixture.familyId, ms);
    },
    get auth() {
      return this.authAt(BASE_NOW);
    }
  };
  const download = await downloadBlob(restarted, restartedFixture, deviceId, blobId);
  assert.equal(download.status, 200, JSON.stringify(download.body));
  assert.equal(download.body.data.ciphertext_base64, cipherBlob().ciphertext_base64);
  const replay = await putBlob(restarted, restartedFixture, deviceId, blobId, { key: putKey });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.code, "REQUEST_DUPLICATE");
  assert.equal(replay.body.data.change_sequence, 1);
  assert.equal(Array.from(restarted.store.syncMutations.values()).length, 1);
  assert.equal(Array.from(restarted.store.syncDevices.values()).length, 1);
  assert.equal(Array.from(restarted.store.syncCursors.values()).length >= 1, true);
});

test("W4-11 sync quota fail-closed matrix: vector overflow, live resource quotas, and rolling bandwidth quotas never enter causality", async () => {
  const app = createTestApp();
  const { fixture, deviceId } = await setupDeviceUser(app, "sync_quota_user");
  // Directly seeded rows below carry metadata only, matching the post-split row
  // shape: their shared ciphertext bytes live in the content-addressed sidecar.
  app.store.writeSyncCiphertextDurable(cipherBlob().ciphertext_sha256, Buffer.from(cipherBlob().ciphertext_base64, "base64"));

  const overflowBlob = crypto.randomUUID();
  const manyEntries = [];
  for (let index = 0; index < 512; index += 1) {
    manyEntries.push({ device_id: crypto.randomUUID(), counter: 1 });
  }
  manyEntries.sort((a, b) => a.device_id.localeCompare(b.device_id));
  const overflowKey = fixture.user.id + ":" + overflowBlob;
  app.store.syncBlobs.set(overflowKey, {
    cloud_user_id: fixture.user.id,
    blob_id: overflowBlob,
    change_kind: "UPSERT",
    version_vector: manyEntries,
    author_device_id: deviceId,
    change_sequence: 1,
    encryption: encryption(),
    ciphertext_sha256: cipherBlob().ciphertext_sha256,
    ciphertext_size_bytes: 1024,
    committed_at: new Date(BASE_NOW).toISOString()
  });
  app.store.syncUserStates.set(fixture.user.id, {
    cloud_user_id: fixture.user.id,
    latest_change_sequence: 1,
    compaction_epoch: 0,
    updated_at: new Date(BASE_NOW).toISOString()
  });
  const overflow = await putBlob(app, fixture, deviceId, overflowBlob, {
    baseVector: manyEntries,
    counter: 2
  });
  assert.equal(overflow.status, 409);
  assert.equal(overflow.body.error.code, "SYNC_VECTOR_OVERFLOW");
  assert.equal(app.store.syncUserStates.get(fixture.user.id).latest_change_sequence, 1, "overflow rejection must not enter causality");

  const counterOverflowBlob = crypto.randomUUID();
  app.store.syncBlobs.set(fixture.user.id + ":" + counterOverflowBlob, {
    cloud_user_id: fixture.user.id,
    blob_id: counterOverflowBlob,
    change_kind: "UPSERT",
    version_vector: vector(deviceId, 2147483647),
    author_device_id: deviceId,
    change_sequence: 2,
    encryption: encryption(),
    ciphertext_sha256: cipherBlob().ciphertext_sha256,
    ciphertext_size_bytes: 1024,
    committed_at: new Date(BASE_NOW).toISOString()
  });
  const counterOverflow = await putBlob(app, fixture, deviceId, counterOverflowBlob, {
    baseVector: vector(deviceId, 2147483647),
    counter: 2147483647
  });
  assert.equal(counterOverflow.status, 409);
  assert.equal(counterOverflow.body.error.code, "SYNC_VECTOR_OVERFLOW");

  for (let index = 0; index < 4096; index += 1) {
    const id = crypto.randomUUID();
    app.store.syncBlobs.set(fixture.user.id + ":" + id, {
      cloud_user_id: fixture.user.id,
      blob_id: id,
      change_kind: "UPSERT",
      version_vector: vector(deviceId, 1),
      author_device_id: deviceId,
      change_sequence: 100 + index,
      encryption: encryption(),
      ciphertext_sha256: cipherBlob().ciphertext_sha256,
      ciphertext_size_bytes: 1024,
      committed_at: new Date(BASE_NOW).toISOString()
    });
  }
  const liveCount = await putBlob(app, fixture, deviceId, crypto.randomUUID());
  assert.equal(liveCount.status, 403);
  assert.equal(liveCount.body.error.code, "SYNC_QUOTA_EXCEEDED");
  assert.equal(liveCount.body.error.detail.dimension, "LIVE_BLOBS");

  const usageId = crypto.randomUUID();
  app.store.syncTransferUsage.set(usageId, {
    id: usageId,
    cloud_user_id: fixture.user.id,
    direction: "EGRESS",
    bytes: 536870912,
    occurred_at: new Date(BASE_NOW).toISOString()
  });
  const egressBlocked = await downloadBlob(app, fixture, deviceId, overflowBlob);
  assert.equal(egressBlocked.status, 429);
  assert.equal(egressBlocked.body.error.code, "SYNC_BANDWIDTH_QUOTA_EXCEEDED");

  const ingressId = crypto.randomUUID();
  app.store.syncTransferUsage.set(ingressId, {
    id: ingressId,
    cloud_user_id: fixture.user.id,
    direction: "INGRESS",
    bytes: 536870912,
    occurred_at: new Date(BASE_NOW).toISOString()
  });
  const ingressRowsNow = () => Array.from(app.store.syncTransferUsage.values()).filter((row) => row.direction === "INGRESS");
  const ingressBytesNow = () => ingressRowsNow().reduce((sum, row) => sum + Number(row.bytes || 0), 0);
  const beforeIngressRows = ingressRowsNow().length;
  const beforeIngressBytes = ingressBytesNow();
  const ingressBlocked = await putBlob(app, fixture, deviceId, crypto.randomUUID());
  assert.equal(ingressBlocked.status, 429);
  assert.equal(ingressBlocked.body.error.code, "SYNC_BANDWIDTH_QUOTA_EXCEEDED");
  assert.ok(
    ingressBytesNow() > beforeIngressBytes,
    "even bandwidth-rejected authenticated PUT attempts count their ingress bytes exactly"
  );
  assert.ok(
    ingressRowsNow().length <= beforeIngressRows + 1,
    "rejected attempts aggregate into the bounded hour bucket instead of one durable row per attempt"
  );
});

test("W4-11 review regression: paginated cursorless resync keeps FULL scan mode and never returns obsolete mutations", async () => {
  const app = createTestApp();
  const { fixture, deviceId } = await setupDeviceUser(app, "sync_full_scan_mode_user");
  const blobA = crypto.randomUUID();
  const blobB = crypto.randomUUID();
  assert.equal((await putBlob(app, fixture, deviceId, blobA, { seed: 1 })).status, 201);
  assert.equal((await putBlob(app, fixture, deviceId, blobB, { seed: 2 })).status, 201);
  assert.equal((await putBlob(app, fixture, deviceId, blobB, { baseVector: vector(deviceId, 1), counter: 2, seed: 7 })).status, 200);

  const page1 = await listChanges(app, fixture, deviceId, "?limit=1");
  assert.equal(page1.status, 200, JSON.stringify(page1.body));
  assert.deepEqual(page1.body.data.map((row) => [row.blob_id, row.change_sequence]), [[blobA, 1]]);
  assert.equal(page1.body.meta.has_more, true);
  const continuationRow = Array.from(app.store.syncCursors.values()).find((row) => row.position === 1 && row.terminal === false);
  assert.equal(continuationRow?.scan_mode, "FULL", "nonterminal cursorless continuation must persist FULL scan mode");

  const page2 = await listChanges(app, fixture, deviceId, "?limit=1&cursor=" + encodeURIComponent(page1.body.meta.next_cursor));
  assert.equal(page2.status, 200, JSON.stringify(page2.body));
  assert.deepEqual(page2.body.data.map((row) => [row.blob_id, row.change_sequence]), [[blobB, 3]]);
  assert.equal(page2.body.data.some((row) => row.change_sequence === 2), false, "obsolete intermediate B write must not leak into full resync continuation");
  assert.equal(page2.body.meta.has_more, false);
  const terminalRow = Array.from(app.store.syncCursors.values()).find((row) => row.position === 3 && row.terminal === true);
  assert.equal(terminalRow?.scan_mode, "INCREMENTAL", "terminal cursor starts later incremental scans");
});

test("W4-11 review regression: web cookie sessions cannot register or use device-bound sync devices", async () => {
  const app = createTestApp();
  const fixture = setupUser(app, "sync_web_cookie_user");
  const consent = await grantE2ee(app, fixture);
  const cookieValue = app.identity.signWebSessionCookie({
    cloudUserId: fixture.user.id,
    accessToken: fixture.session.access_token,
    refreshToken: fixture.session.refresh_token
  });
  const cookieHeaders = { cookie: "dis_web_session=" + encodeURIComponent(cookieValue) };
  // signWebSessionCookie intentionally uses the real wall clock, while the rest
  // of this suite uses a fixed future protocol clock.  Exercise the cookie at
  // its real issuance time; the authorization decision itself remains deterministic.
  const cookieNowMs = Date.now();
  const deviceId = crypto.randomUUID();
  const registered = await app.inject({
    method: "PUT",
    url: "/api/v1/sync/devices/" + deviceId,
    headers: { ...cookieHeaders, "idempotency-key": nextKey("sync-web-register") },
    body: { consent_id: consent.id, device_label: "browser", platform: "ANDROID", sync_protocol_version: 1 },
    nowMs: cookieNowMs
  });
  assert.equal(registered.status, 403);
  assert.equal(registered.body.error.code, "SYNC_PERMISSION_DENIED");
  assert.equal(app.store.syncDevices.has(fixture.user.id + ":" + deviceId), false);

  // Defense in depth for rows written by the vulnerable pre-review implementation:
  // even if a web-family binding exists, cookie auth still cannot use it.
  app.store.syncDevices.set(fixture.user.id + ":" + deviceId, {
    cloud_user_id: fixture.user.id,
    device_id: deviceId,
    session_family_id: "web_cookie_family",
    consent_id: consent.id,
    device_label: "legacy web binding",
    platform: "ANDROID",
    sync_protocol_version: 1,
    status: "ACTIVE",
    registered_at: new Date(BASE_NOW).toISOString(),
    revoked_at: null,
    revocation_reason: null,
    last_seen_at: null,
    acknowledged_cursor_position: 0
  });
  const use = await app.inject({
    method: "GET",
    url: "/api/v1/sync/blobs/" + crypto.randomUUID(),
    headers: { ...cookieHeaders, "x-dis-sync-device-id": deviceId },
    nowMs: cookieNowMs
  });
  assert.equal(use.status, 403);
  assert.equal(use.body.error.code, "SYNC_PERMISSION_DENIED");
});

test("W4-11 review regression: timely consent renewal settles by grant time without an intervening worker or sync request", async () => {
  const app = createTestApp();
  const { fixture, consent, deviceId } = await setupDeviceUser(app, "sync_timely_renewal_user");
  const blobId = crypto.randomUUID();
  assert.equal((await putBlob(app, fixture, deviceId, blobId)).status, 201);
  const withdrawMs = BASE_NOW + HOUR;
  const withdrawn = await app.inject({
    method: "DELETE",
    url: "/api/v1/me/consents/" + consent.id,
    headers: fixture.authAt(withdrawMs),
    nowMs: withdrawMs
  });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  const expiryMs = withdrawMs + 30 * DAY;
  const timelyGrantMs = expiryMs - 1000;
  const renewed = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: fixture.authAt(timelyGrantMs),
    body: { purpose: "E2EE_CLOUD_SYNC", document_version: "e2ee-sync-consent-v1", document_sha256: DOC_SHA },
    nowMs: timelyGrantMs
  });
  assert.equal(renewed.status, 201, JSON.stringify(renewed.body));
  const stateAfterGrant = app.store.syncUserStates.get(fixture.user.id);
  assert.equal(stateAfterGrant.consent_withdrawn_at, null, "timely grant must clear the pending withdrawal in the grant commit itself");
  assert.equal(stateAfterGrant.reauthorized_at, new Date(timelyGrantMs).toISOString(), "settlement must use effective grant time, not a later worker clock");

  // No sync endpoint and no worker tick intervened before expiry.  A late worker
  // must still see that the grant happened before the deadline and preserve data.
  app.syncE2ee.settleConsentLifecycle(fixture.user.id, expiryMs + 5000);
  assert.ok(app.store.syncBlobs.has(fixture.user.id + ":" + blobId), "timely-renewed ciphertext must survive a post-deadline worker tick");
  const download = await downloadBlob(app, fixture, deviceId, blobId, expiryMs + 5001);
  assert.equal(download.status, 200, JSON.stringify(download.body));
});

test("W4-11 review regression: post-expiry renewal finishes old cleanup atomically and purges blob receipts/outbox metadata", async () => {
  const app = createTestApp();
  const { fixture, consent, deviceId } = await setupDeviceUser(app, "sync_late_renewal_user");
  const blobId = crypto.randomUUID();
  const putKey = nextKey("sync-expiry-put-receipt");
  assert.equal((await putBlob(app, fixture, deviceId, blobId, { key: putKey })).status, 201);
  const deleteKey = nextKey("sync-expiry-delete-receipt");
  assert.equal((await deleteBlob(app, fixture, deviceId, blobId, vector(deviceId, 1), 2, { key: deleteKey })).status, 200);
  assert.ok(Array.from(app.store.idempotencyRecords.keys()).some((key) => key.startsWith("putSyncBlob|" + fixture.user.id + "|")));
  assert.ok(Array.from(app.store.idempotencyRecords.keys()).some((key) => key.startsWith("deleteSyncBlob|" + fixture.user.id + "|")));
  assert.ok(app.store.outboxEvents.some((event) => event.event_type === "sync.blob.deleted" && Array.isArray(event.payload_json.version_vector)));

  const withdrawMs = BASE_NOW + HOUR;
  const withdrawn = await app.inject({
    method: "DELETE",
    url: "/api/v1/me/consents/" + consent.id,
    headers: fixture.authAt(withdrawMs),
    nowMs: withdrawMs
  });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  const expiryMs = withdrawMs + 30 * DAY;
  const lateGrantMs = expiryMs + 1000;
  const renewed = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: fixture.authAt(lateGrantMs),
    body: { purpose: "E2EE_CLOUD_SYNC", document_version: "e2ee-sync-consent-v1", document_sha256: DOC_SHA },
    nowMs: lateGrantMs
  });
  assert.equal(renewed.status, 201, JSON.stringify(renewed.body));

  assert.equal(Array.from(app.store.syncBlobs.values()).filter((row) => row.cloud_user_id === fixture.user.id).length, 0, "late renewal must finish the expired cleanup before accepting a new lifecycle");
  assert.equal(Array.from(app.store.syncMutations.values()).filter((row) => row.cloud_user_id === fixture.user.id).length, 0);
  assert.equal(Array.from(app.store.syncCursors.values()).filter((row) => row.cloud_user_id === fixture.user.id).length, 0);
  assert.equal(app.store.syncDevices.get(fixture.user.id + ":" + deviceId).status, "REVOKED");
  assert.equal(app.store.syncBlobAntiResurrection.has(fixture.user.id + ":" + blobId), true, "minimal anti-resurrection marker survives expiry cleanup");
  for (const key of app.store.idempotencyRecords.keys()) {
    assert.equal(key.startsWith("putSyncBlob|" + fixture.user.id + "|"), false, "expiry cleanup must erase put receipts containing vectors");
    assert.equal(key.startsWith("deleteSyncBlob|" + fixture.user.id + "|"), false, "expiry cleanup must erase delete receipts containing vectors");
  }
  const blobEvents = app.store.outboxEvents.filter((event) => String(event.event_type).startsWith("sync.blob."));
  assert.ok(blobEvents.length >= 2, "blob outbox shells may remain only in redacted form");
  for (const event of blobEvents) {
    assert.equal(event.payload_json.redacted, true);
    assert.equal(Object.hasOwn(event.payload_json, "version_vector"), false);
    assert.equal(Object.hasOwn(event.payload_json, "key_id"), false);
    assert.equal(Object.hasOwn(event.payload_json, "ciphertext_sha256"), false);
    assert.ok(event.delivered_at, "redacted sync blob events must not remain pending for delivery");
  }
  const deviceEvents = app.store.outboxEvents.filter((event) => String(event.event_type).startsWith("sync.device."));
  assert.ok(deviceEvents.length > 0, "revoked-device security records must survive expiry cleanup");
});

test("W4-11 review regression: school consent cascade leaves independent E2EE consent and retention clock untouched", async () => {
  const app = createTestApp();
  const { fixture, deviceId } = await setupDeviceUser(app, "sync_school_cascade_user");
  const blobId = crypto.randomUUID();
  assert.equal((await putBlob(app, fixture, deviceId, blobId)).status, 201);
  const schoolConsent = await app.inject({
    method: "POST",
    url: "/api/v1/me/consents",
    headers: fixture.auth,
    body: { school_id: "haut" }
  });
  assert.equal(schoolConsent.status, 201, JSON.stringify(schoolConsent.body));
  const withdrawn = await app.inject({
    method: "DELETE",
    url: "/api/v1/me/consents/" + schoolConsent.body.data.id,
    headers: fixture.auth,
    nowMs: BASE_NOW + HOUR
  });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  const activeE2ee = Array.from(app.store.consents.values()).find((row) => row.cloud_user_id === fixture.user.id && row.purpose === "E2EE_CLOUD_SYNC");
  assert.equal(activeE2ee.withdrawn_at, null, "school-only cascade must not withdraw independent E2EE consent");
  const syncState = app.store.syncUserStates.get(fixture.user.id);
  assert.equal(syncState.consent_withdrawn_at ?? null, null, "school-only cascade must not start the E2EE 30-day retention clock");
  assert.equal(syncState.retention_expires_at ?? null, null);
  const download = await downloadBlob(app, fixture, deviceId, blobId, BASE_NOW + HOUR + 1);
  assert.equal(download.status, 200, JSON.stringify(download.body));
});

test("W4-11 review regression: export allowlist preserves AEAD key_id byte-for-byte while redacting free-form labels", async () => {
  const app = createTestApp();
  const { fixture, consent, deviceId } = await setupDeviceUser(app, "sync_export_key_id_user");
  const keyIdEncryption = { ...encryption(), key_id: "token:epoch1" };
  const blobId = crypto.randomUUID();
  const put = await putBlob(app, fixture, deviceId, blobId, { mutateBody: { encryption: keyIdEncryption } });
  assert.equal(put.status, 201, JSON.stringify(put.body));
  const exported = await app.inject({ method: "POST", url: "/api/v1/me/data-export", headers: fixture.auth });
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.equal(exported.body.data.sync_blobs[0].encryption.key_id, "token:epoch1", "validated opaque key_id is AEAD AAD and must survive export byte-for-byte");
  assert.equal(exported.body.data.sync_blob_mutations[0].encryption.key_id, "token:epoch1");
  assert.notEqual(exported.body.data.sync_blobs[0].encryption.key_id, "token=[REDACTED]");
});

test("W4-11 review regression: authenticated malformed, over-limit, and wrong-shape PUT bodies count ingress once at HTTP boundary", async (t) => {
  const app = createTestApp();
  const { fixture, deviceId } = await setupDeviceUser(app, "sync_http_ingress_user");
  const server = app.createHttpServer();
  t.after(() => {
    try { server.closeAllConnections?.(); } catch {}
    server.close();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  async function rawPut(rawBody, label) {
    const response = await fetch("http://127.0.0.1:" + port + "/api/v1/sync/blobs/" + crypto.randomUUID(), {
      method: "PUT",
      headers: {
        ...fixture.auth,
        "content-type": "application/json",
        "x-dis-sync-device-id": deviceId,
        "idempotency-key": nextKey(label)
      },
      body: rawBody
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, body: json, rawText: text };
  }
  const ingressRows = () => Array.from(app.store.syncTransferUsage.values()).filter((row) => row.direction === "INGRESS");
  const ingressBytes = () => ingressRows().reduce((sum, row) => sum + Number(row.bytes || 0), 0);

  const beforeMalformed = ingressBytes();
  const malformedRaw = '{"encryption":';
  const malformed = await rawPut(malformedRaw, "sync-http-malformed");
  assert.equal(malformed.status, 400, malformed.rawText);
  assert.equal(malformed.body.error.code, "BAD_REQUEST");
  assert.equal(ingressBytes(), beforeMalformed + Buffer.byteLength(malformedRaw), "malformed JSON must still meter exactly one authenticated ingress attempt");

  const wrongShapeRaw = JSON.stringify([]);
  const beforeShape = ingressBytes();
  const wrongShape = await rawPut(wrongShapeRaw, "sync-http-wrong-shape");
  assert.equal(wrongShape.status, 400, wrongShape.rawText);
  assert.equal(wrongShape.body.error.code, "BAD_REQUEST");
  assert.equal(ingressBytes(), beforeShape + Buffer.byteLength(wrongShapeRaw), "syntactically valid but wrong-shape JSON must meter exactly one ingress attempt");

  const oversizedRaw = '{"padding":"' + "x".repeat(1536 * 1024) + '"}';
  const beforeOversized = ingressBytes();
  const oversized = await rawPut(oversizedRaw, "sync-http-oversized");
  assert.equal(oversized.status, 413, oversized.rawText);
  assert.equal(oversized.body.error.code, "PAYLOAD_TOO_LARGE");
  const oversizedMetered = ingressBytes() - beforeOversized;
  assert.ok(oversizedMetered > 1536 * 1024, "over-limit metering uses actual boundary bytes already read, got " + oversizedMetered);
  assert.ok(oversizedMetered < Buffer.byteLength(oversizedRaw) + 65536, "over-limit metering must not exceed the bytes actually transferred");

  // Aggregation invariant: same-hour attempts share one bounded bucket row per
  // direction instead of one durable row per attempt, however hard clients retry.
  const bucketRows = ingressRows().filter((row) => Number.isSafeInteger(row.bucket_start_ms));
  assert.ok(bucketRows.length <= 1, "same-bucket attempts must aggregate into at most one ingress row, got " + bucketRows.length);
});


function listSidecarFiles(dir) {
  const root = dir + ".ciphertext";
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const shard of fs.readdirSync(root)) {
    const shardDir = path.join(root, shard);
    if (!fs.statSync(shardDir).isDirectory()) continue;
    for (const name of fs.readdirSync(shardDir)) {
      out.push({ shard, name, filePath: path.join(shardDir, name), size: fs.statSync(path.join(shardDir, name)).size });
    }
  }
  return out;
}

test("W4-11 review regression: ciphertext persists in sidecar files while the JSON snapshot stays metadata-only", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-e2ee-sidecar-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshotPath = path.join(dir, "state.json");
  const app = createTestApp({ storeOptions: { snapshotPath, requireDurableSnapshot: true } });
  t.after(() => clearTimeout(app.store._snapshotFlushTimer));

  const oneMiB = 1048576;
  const uploads = [];
  for (const [userIndex, label] of [[0, "sync_sidecar_a"], [1, "sync_sidecar_b"]]) {
    const setup = await setupDeviceUser(app, label);
    for (let index = 0; index < 4; index += 1) {
      const seed = userIndex * 10 + index + 1;
      const blobId = crypto.randomUUID();
      const put = await putBlob(app, setup.fixture, setup.deviceId, blobId, { size: oneMiB, seed });
      assert.equal(put.status, 201, JSON.stringify(put.body));
      uploads.push({ ...setup, blobId, seed });
    }
  }

  // Structural proof of the fix: 8 MiB of ciphertext is durable, yet the
  // monolithic JSON snapshot carries metadata only — no inline ciphertext key,
  // and its size is bounded by metadata volume rather than by quota volume.
  const snapshotBytes = fs.readFileSync(snapshotPath);
  const snapshotText = snapshotBytes.toString("utf8");
  assert.equal(snapshotText.includes("ciphertext_base64"), false, "JSON snapshot must never inline ciphertext");
  assert.equal(snapshotText.includes("ciphertext\u0000"), false);
  const sidecarFiles = listSidecarFiles(snapshotPath);
  assert.equal(sidecarFiles.length, 8, "every distinct ciphertext digest must be one sidecar file");
  const sidecarTotal = sidecarFiles.reduce((sum, row) => sum + row.size, 0);
  assert.equal(sidecarTotal, 8 * oneMiB, "sidecar must hold exactly the uploaded ciphertext bytes");
  assert.ok(
    snapshotBytes.length < sidecarTotal / 16,
    `snapshot (${snapshotBytes.length}) must stay metadata-bounded far below ciphertext volume (${sidecarTotal})`
  );
  for (const row of sidecarFiles) {
    assert.match(row.name, /^[0-9a-f]{64}\.bin$/, "sidecar files are content-addressed");
    assert.equal(row.shard, row.name.slice(0, 2), "sidecar files shard by digest prefix");
  }

  // Reopen the store: downloads and export rehydrate byte-exact ciphertext.
  const restarted = createTestApp({ storeOptions: { snapshotPath, requireDurableSnapshot: true } });
  t.after(() => clearTimeout(restarted.store._snapshotFlushTimer));
  for (const entry of uploads) {
    const restartedFixture = {
      user: restarted.store.users.get(entry.fixture.user.id),
      familyId: entry.fixture.familyId,
      authAt(ms = BASE_NOW) {
        return signAuth(restarted, this.user, entry.fixture.familyId, ms);
      },
      get auth() {
        return this.authAt(BASE_NOW);
      }
    };
    const download = await downloadBlob(restarted, restartedFixture, entry.deviceId, entry.blobId);
    assert.equal(download.status, 200, JSON.stringify(download.body));
    assert.equal(download.body.data.ciphertext_base64, cipherBlob(oneMiB, entry.seed).ciphertext_base64);
  }
  const first = uploads[0];
  const exportAuth = {
    user: restarted.store.users.get(first.fixture.user.id),
    familyId: first.fixture.familyId,
    authAt(ms = BASE_NOW) {
      return signAuth(restarted, this.user, first.fixture.familyId, ms);
    },
    get auth() {
      return this.authAt(BASE_NOW);
    }
  };
  const exported = await restarted.inject({ method: "POST", url: "/api/v1/me/data-export", headers: exportAuth.auth });
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  const exportedBlob = exported.body.data.sync_blobs.find((row) => row.blob_id === first.blobId);
  assert.equal(exportedBlob.ciphertext_base64, cipherBlob(oneMiB, first.seed).ciphertext_base64);
});

test("W4-11 review regression: tombstone, account erasure, and orphan sweep physically erase sidecar ciphertext", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-e2ee-erasure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshotPath = path.join(dir, "state.json");
  const app = createTestApp({ storeOptions: { snapshotPath, requireDurableSnapshot: true } });
  t.after(() => clearTimeout(app.store._snapshotFlushTimer));
  const { fixture, deviceId } = await setupDeviceUser(app, "sync_erasure_user");

  // Tombstone erasure: deleting the blob unpublishes the reference and the
  // post-publish sweep physically removes the content-addressed bytes.
  const blobId = crypto.randomUUID();
  const put = await putBlob(app, fixture, deviceId, blobId);
  assert.equal(put.status, 201, JSON.stringify(put.body));
  const digest = cipherBlob().ciphertext_sha256;
  const sidecarPath = path.join(snapshotPath + ".ciphertext", digest.slice(0, 2), digest + ".bin");
  assert.equal(fs.existsSync(sidecarPath), true, "uploaded ciphertext must be durable in the sidecar");
  const del = await deleteBlob(app, fixture, deviceId, blobId, vector(deviceId, 1), 2);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(fs.existsSync(sidecarPath), false, "tombstone must physically erase ciphertext after publish");

  // Orphan reclamation: bytes that never became referenced (crash/rollback
  // residue simulated by direct placement) disappear at the next publish sweep.
  const orphanDigest = "0".repeat(64);
  const orphanDir = path.join(snapshotPath + ".ciphertext", "00");
  fs.mkdirSync(orphanDir, { recursive: true });
  const orphanPath = path.join(orphanDir, orphanDigest + ".bin");
  fs.writeFileSync(orphanPath, Buffer.alloc(1024, 7));
  const strayTmpPath = path.join(orphanDir, "abcd".repeat(16) + ".bin.tmp.1.1");
  fs.writeFileSync(strayTmpPath, Buffer.alloc(16, 9));
  const blobId2 = crypto.randomUUID();
  const put2 = await putBlob(app, fixture, deviceId, blobId2, { seed: 5 });
  assert.equal(put2.status, 201, JSON.stringify(put2.body));
  assert.equal(fs.existsSync(orphanPath), false, "unreferenced orphan ciphertext must be swept after publish");
  assert.equal(fs.existsSync(strayTmpPath), false, "temporary write residue must be swept after publish");

  // Account erasure: data-delete republishes without the user's rows and the
  // sweep erases every remaining ciphertext byte of that account.
  const remainingBefore = listSidecarFiles(snapshotPath);
  assert.ok(remainingBefore.length >= 1, "second upload must be durable before erasure");
  const deleted = await app.inject({ method: "POST", url: "/api/v1/me/data-delete", headers: fixture.auth });
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
  assert.equal(listSidecarFiles(snapshotPath).length, 0, "account erasure must physically erase all sidecar ciphertext");
});

test("W4-11 crash regression: tombstone deletion fsyncs the shard so ciphertext cannot resurrect", async (t) => {
  const io = new SnapshotFs();
  const snapshotPath = "/sync-e2ee-tombstone-crash/state.json";
  const app = createTestApp({
    storeOptions: { snapshotPath, requireDurableSnapshot: true, snapshotFs: io }
  });
  t.after(() => {
    clearTimeout(app.store._snapshotFlushTimer);
    clearTimeout(app.store._syncCiphertextSweepRetryTimer);
  });
  const { fixture, deviceId } = await setupDeviceUser(app, "sync_crash_delete_user");
  const blobId = crypto.randomUUID();
  const put = await putBlob(app, fixture, deviceId, blobId);
  assert.equal(put.status, 201, JSON.stringify(put.body));
  const digest = cipherBlob().ciphertext_sha256;
  const sidecarPath = snapshotPath + ".ciphertext/" + digest.slice(0, 2) + "/" + digest + ".bin";
  assert.equal(io.existsSync(sidecarPath), true, "uploaded ciphertext starts durable in the fake filesystem");

  const del = await deleteBlob(app, fixture, deviceId, blobId, vector(deviceId, 1), 2);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(io.existsSync(sidecarPath), false, "post-publish sweep unlinks tombstoned ciphertext");

  io.crash();
  assert.equal(
    io.existsSync(sidecarPath),
    false,
    "power loss after a completed delete must not resurrect the unlinked ciphertext directory entry"
  );

  const restarted = createTestApp({
    storeOptions: { snapshotPath, requireDurableSnapshot: true, snapshotFs: io }
  });
  t.after(() => {
    clearTimeout(restarted.store._snapshotFlushTimer);
    clearTimeout(restarted.store._syncCiphertextSweepRetryTimer);
  });
  const key = fixture.user.id + ":" + blobId;
  assert.equal(restarted.store.syncBlobs.get(key)?.change_kind, "TOMBSTONE");
  assert.equal(restarted.store.syncBlobAntiResurrection.has(key), true);
});

test("W4-11 crash regression: account erasure fsyncs shard deletes so ciphertext cannot resurrect", async (t) => {
  const io = new SnapshotFs();
  const snapshotPath = "/sync-e2ee-erasure-crash/state.json";
  const app = createTestApp({
    storeOptions: { snapshotPath, requireDurableSnapshot: true, snapshotFs: io }
  });
  t.after(() => {
    clearTimeout(app.store._snapshotFlushTimer);
    clearTimeout(app.store._syncCiphertextSweepRetryTimer);
  });
  const { fixture, deviceId } = await setupDeviceUser(app, "sync_crash_erasure_user");
  const blobId = crypto.randomUUID();
  const put = await putBlob(app, fixture, deviceId, blobId);
  assert.equal(put.status, 201, JSON.stringify(put.body));
  const digest = cipherBlob().ciphertext_sha256;
  const sidecarPath = snapshotPath + ".ciphertext/" + digest.slice(0, 2) + "/" + digest + ".bin";
  assert.equal(io.existsSync(sidecarPath), true);

  const deleted = await app.inject({ method: "POST", url: "/api/v1/me/data-delete", headers: fixture.auth });
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
  assert.equal(io.existsSync(sidecarPath), false, "data-delete sweep unlinks erased ciphertext");

  io.crash();
  assert.equal(
    io.existsSync(sidecarPath),
    false,
    "power loss after completed account erasure must not resurrect the ciphertext as an orphan"
  );
  const restarted = createTestApp({
    storeOptions: { snapshotPath, requireDurableSnapshot: true, snapshotFs: io }
  });
  t.after(() => {
    clearTimeout(restarted.store._snapshotFlushTimer);
    clearTimeout(restarted.store._syncCiphertextSweepRetryTimer);
  });
  assert.equal(
    Array.from(restarted.store.syncBlobs.values()).some((row) => row?.cloud_user_id === fixture.user.id),
    false,
    "account erasure metadata must stay deleted across the same power-loss boundary"
  );
});

test("W4-11 review regression: sweep failure is logged, metered, and retried until delete durability is flushed", async (t) => {
  const io = new SnapshotFs();
  const sweepEvents = [];
  const snapshotPath = "/sync-e2ee-sweep-failure/state.json";
  const app = createTestApp({
    storeOptions: {
      snapshotPath,
      requireDurableSnapshot: true,
      snapshotFs: io,
      onSyncCiphertextSweepEvent: (event) => sweepEvents.push(event),
      syncCiphertextSweepRetryBaseMs: 60_000
    }
  });
  t.after(() => {
    clearTimeout(app.store._snapshotFlushTimer);
    clearTimeout(app.store._syncCiphertextSweepRetryTimer);
  });
  const { fixture, deviceId } = await setupDeviceUser(app, "sync_sweep_visible_user");
  const blobId = crypto.randomUUID();
  const put = await putBlob(app, fixture, deviceId, blobId);
  assert.equal(put.status, 201, JSON.stringify(put.body));
  const digest = cipherBlob().ciphertext_sha256;
  const shardDir = snapshotPath + ".ciphertext/" + digest.slice(0, 2);
  const sidecarPath = shardDir + "/" + digest + ".bin";

  const realFsync = io.fsyncSync.bind(io);
  let failShardFsync = false;
  io.fsyncSync = (fd) => {
    const open = io.fds.get(fd);
    if (failShardFsync && open && !open.inode && String(open.p).includes(".ciphertext/")) {
      throw Object.assign(new Error("injected shard directory fsync failure"), { code: "EIO" });
    }
    return realFsync(fd);
  };

  failShardFsync = true;
  const del = await deleteBlob(app, fixture, deviceId, blobId, vector(deviceId, 1), 2);
  assert.equal(del.status, 200, JSON.stringify(del.body), "a post-publish sweep failure must not invalidate the durable tombstone commit");
  const metricsAfterFailure = app.store.syncCiphertextSweepMetrics;
  assert.equal(metricsAfterFailure.failures, 1, "sweep failure must increment operator-visible failure metrics");
  assert.equal(metricsAfterFailure.retry_pending, true);
  assert.equal(metricsAfterFailure.retry_scheduled, true);
  assert.equal(metricsAfterFailure.pending_delete_fsync_shards, 1);
  assert.equal(app.store.syncCiphertextPendingDeleteFsync.has(shardDir), true);
  assert.equal(sweepEvents.length, 1, "sweep failure must emit one structured log event");
  assert.equal(sweepEvents[0].service, "sync-ciphertext-sweep");
  assert.equal(sweepEvents[0].level, "error");
  assert.equal(sweepEvents[0].trigger, "post_publish");
  assert.equal(sweepEvents[0].error_code, "EIO");
  assert.equal(sweepEvents[0].retry_scheduled, true);
  assert.equal(sweepEvents[0].retry_delay_ms, 60_000);
  assert.equal(io.existsSync(sidecarPath), false, "unlink may already be volatile-visible even though durability is unknown");

  // The retry path must not confuse volatile absence with durable erasure: the
  // pending shard fsync is replayed first, then the power-loss barrier is proofed
  // by crashing the fake filesystem.
  failShardFsync = false;
  clearTimeout(app.store._syncCiphertextSweepRetryTimer);
  app.store._syncCiphertextSweepRetryTimer = null;
  const successesBeforeRetry = metricsAfterFailure.successes;
  const swept = app.store.sweepSyncCiphertextOrphans(app.store, { trigger: "manual_test_retry" });
  assert.equal(swept, 0, "the file is already volatile-unlinked; retry owes the shard fsync rather than another unlink");
  assert.equal(metricsAfterFailure.successes, successesBeforeRetry + 1);
  assert.equal(metricsAfterFailure.retry_pending, false);
  assert.equal(metricsAfterFailure.retry_scheduled, false);
  assert.equal(metricsAfterFailure.pending_delete_fsync_shards, 0);
  assert.equal(app.store.syncCiphertextPendingDeleteFsync.size, 0);

  io.crash();
  assert.equal(
    io.existsSync(sidecarPath),
    false,
    "once the visible retry completes, power loss must not resurrect the erased ciphertext"
  );
  const restarted = createTestApp({
    storeOptions: { snapshotPath, requireDurableSnapshot: true, snapshotFs: io }
  });
  t.after(() => {
    clearTimeout(restarted.store._snapshotFlushTimer);
    clearTimeout(restarted.store._syncCiphertextSweepRetryTimer);
  });
  assert.equal(restarted.store.syncBlobs.get(fixture.user.id + ":" + blobId)?.change_kind, "TOMBSTONE");
});

test("W4-11 review regression: missing or corrupted sidecar ciphertext fails closed", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-e2ee-corrupt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshotPath = path.join(dir, "state.json");
  const app = createTestApp({ storeOptions: { snapshotPath, requireDurableSnapshot: true } });
  t.after(() => clearTimeout(app.store._snapshotFlushTimer));
  const { fixture, deviceId } = await setupDeviceUser(app, "sync_corrupt_user");
  const blobId = crypto.randomUUID();
  const put = await putBlob(app, fixture, deviceId, blobId);
  assert.equal(put.status, 201, JSON.stringify(put.body));

  const digest = cipherBlob().ciphertext_sha256;
  const sidecarPath = path.join(snapshotPath + ".ciphertext", digest.slice(0, 2), digest + ".bin");
  fs.writeFileSync(sidecarPath, Buffer.alloc(1024, 255));
  const corrupted = await downloadBlob(app, fixture, deviceId, blobId);
  assert.equal(corrupted.status, 503, JSON.stringify(corrupted.body));
  assert.equal(corrupted.body.error.code, "STORAGE_PERSISTENCE_FAILED");

  fs.unlinkSync(sidecarPath);
  const missing = await downloadBlob(app, fixture, deviceId, blobId);
  assert.equal(missing.status, 503, JSON.stringify(missing.body));
  assert.equal(missing.body.error.code, "STORAGE_PERSISTENCE_FAILED");

  assert.throws(
    () => createTestApp({ storeOptions: { snapshotPath, requireDurableSnapshot: true } }),
    (err) => err?.code === "STORAGE_PERSISTENCE_FAILED" || err?.code === "STORAGE_COMMIT_UNKNOWN",
    "restart over missing referenced ciphertext must fail closed"
  );
});

test("W4-11 review regression: post-exhaustion rejected uploads count exactly but stay in bounded aggregate rows", async () => {
  const app = createTestApp();
  const { fixture, deviceId } = await setupDeviceUser(app, "sync_throttle_user");
  const legacyUsageId = crypto.randomUUID();
  app.store.syncTransferUsage.set(legacyUsageId, {
    id: legacyUsageId,
    cloud_user_id: fixture.user.id,
    direction: "INGRESS",
    bytes: 536870912,
    occurred_at: new Date(BASE_NOW).toISOString()
  });
  const ingressRows = () => Array.from(app.store.syncTransferUsage.values()).filter((row) => row.direction === "INGRESS");
  const ingressBytes = () => ingressRows().reduce((sum, row) => sum + Number(row.bytes || 0), 0);

  const deltas = [];
  for (let index = 0; index < 6; index += 1) {
    const before = ingressBytes();
    const blocked = await putBlob(app, fixture, deviceId, crypto.randomUUID());
    assert.equal(blocked.status, 429, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, "SYNC_BANDWIDTH_QUOTA_EXCEEDED");
    deltas.push(ingressBytes() - before);
  }
  for (const delta of deltas) {
    assert.ok(delta > 0, "every rejected authenticated attempt must still count its ingress bytes exactly");
    assert.equal(delta, deltas[0], "identical over-quota attempts meter identical bytes");
  }
  assert.ok(
    ingressRows().length <= 2,
    "post-exhaustion retries must aggregate into bounded rows instead of one durable row per attempt, got " + ingressRows().length
  );
  const bucketRows = ingressRows().filter((row) => Number.isSafeInteger(row.bucket_start_ms));
  assert.equal(bucketRows.length, 1, "post-exhaustion counting lands in the single aligned hour bucket");
  assert.equal(bucketRows[0].bytes, deltas.reduce((sum, row) => sum + row, 0), "bucket accumulates exactly the rejected bytes");
});

test("W4-11 review regression: multiple accounts reach their exact live-byte quotas and reopen the store", async (t) => {
  // Reviewer verification: the storage layer must not cap sync below the
  // contract quota.  Rows are metadata-only after the sidecar split, so 255
  // seeded one-MiB live rows per account cost metadata volume only; the final
  // real one-MiB upload then reaches exactly 256 MiB of live padded ciphertext
  // and must succeed, the next one must fail with SYNC_QUOTA_EXCEEDED, and a
  // reopened store must still serve the ciphertext.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-e2ee-quota-reach-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshotPath = path.join(dir, "state.json");
  const app = createTestApp({ storeOptions: { snapshotPath, requireDurableSnapshot: true } });
  t.after(() => clearTimeout(app.store._snapshotFlushTimer));

  const oneMiB = 1048576;
  const accounts = [];
  for (const label of ["sync_quota_reach_a", "sync_quota_reach_b"]) {
    const setup = await setupDeviceUser(app, label);
    const shared = cipherBlob(oneMiB, 42);
    app.store.writeSyncCiphertextDurable(shared.ciphertext_sha256, Buffer.from(shared.ciphertext_base64, "base64"));
    for (let index = 0; index < 255; index += 1) {
      const seededBlob = crypto.randomUUID();
      app.store.syncBlobs.set(setup.fixture.user.id + ":" + seededBlob, {
        cloud_user_id: setup.fixture.user.id,
        blob_id: seededBlob,
        change_kind: "UPSERT",
        version_vector: vector(setup.deviceId, 1),
        author_device_id: setup.deviceId,
        change_sequence: index + 1,
        encryption: encryption(),
        ciphertext_sha256: shared.ciphertext_sha256,
        ciphertext_size_bytes: oneMiB,
        committed_at: new Date(BASE_NOW).toISOString()
      });
    }
    app.store.syncUserStates.set(setup.fixture.user.id, {
      cloud_user_id: setup.fixture.user.id,
      latest_change_sequence: 255,
      compaction_epoch: 0,
      consent_withdrawn_at: null,
      retention_expires_at: null,
      reauthorized_at: null,
      expired_cleanup_at: null,
      updated_at: new Date(BASE_NOW).toISOString()
    });
    accounts.push(setup);
  }

  for (const setup of accounts) {
    const reachingBlob = crypto.randomUUID();
    const reaching = await putBlob(app, setup.fixture, setup.deviceId, reachingBlob, { size: oneMiB, seed: 77 });
    assert.equal(reaching.status, 201, "the upload reaching exactly 256 MiB live padded bytes must succeed: " + JSON.stringify(reaching.body));
    const overflow = await putBlob(app, setup.fixture, setup.deviceId, crypto.randomUUID(), { seed: 78 });
    assert.equal(overflow.status, 403);
    assert.equal(overflow.body.error.code, "SYNC_QUOTA_EXCEEDED");
    assert.equal(overflow.body.error.detail.dimension, "LIVE_PADDED_CIPHERTEXT_BYTES");
    setup.reachingBlob = reachingBlob;
  }

  const snapshotBytes = fs.readFileSync(snapshotPath).length;
  assert.ok(snapshotBytes < 4 * 1024 * 1024, "metadata-only snapshot for 512 live blobs stays small, got " + snapshotBytes);

  const restarted = createTestApp({ storeOptions: { snapshotPath, requireDurableSnapshot: true } });
  t.after(() => clearTimeout(restarted.store._snapshotFlushTimer));
  for (const setup of accounts) {
    const restartedFixture = {
      user: restarted.store.users.get(setup.fixture.user.id),
      familyId: setup.fixture.familyId,
      authAt(ms = BASE_NOW) {
        return signAuth(restarted, this.user, setup.fixture.familyId, ms);
      },
      get auth() {
        return this.authAt(BASE_NOW);
      }
    };
    const download = await downloadBlob(restarted, restartedFixture, setup.deviceId, setup.reachingBlob);
    assert.equal(download.status, 200, JSON.stringify(download.body));
    assert.equal(download.body.data.ciphertext_base64, cipherBlob(oneMiB, 77).ciphertext_base64);
  }
});

test("W4-11 review regression: streaming past the body cap yields HTTP 413 instead of a connection reset", async (t) => {
  const app = createTestApp();
  const { fixture, deviceId } = await setupDeviceUser(app, "sync_stream_user");
  const server = app.createHttpServer();
  t.after(() => {
    try { server.closeAllConnections?.(); } catch {}
    server.close();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  const responseText = await new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for the 413 response"));
    }, 10000);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("latin1"));
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      if (chunks.length > 0) resolve(Buffer.concat(chunks).toString("latin1"));
      else reject(err);
    });
    socket.on("connect", async () => {
      const total = 2 * 1024 * 1024;
      const head =
        "PUT /api/v1/sync/blobs/" + crypto.randomUUID() + " HTTP/1.1\r\n" +
        "host: 127.0.0.1\r\n" +
        "authorization: " + fixture.auth.authorization + "\r\n" +
        "content-type: application/json\r\n" +
        "x-dis-sync-device-id: " + deviceId + "\r\n" +
        "idempotency-key: " + nextKey("sync-stream-oversize") + "\r\n" +
        "content-length: " + total + "\r\n" +
        "\r\n";
      socket.write(head);
      // Stream 2 MiB in 256 KiB slices with breathing room: the server crosses
      // the 1.5 MiB cap while bytes are still in flight — the exact shape that
      // used to reset the connection before any response could be written.
      const slice = Buffer.alloc(256 * 1024, 120);
      for (let sent = 0; sent < total; sent += slice.length) {
        await new Promise((resolveWrite) => setTimeout(resolveWrite, 15));
        if (socket.destroyed) break;
        try {
          socket.write(slice);
        } catch {
          break;
        }
      }
    });
  });

  assert.ok(
    responseText.startsWith("HTTP/1.1 413"),
    "over-limit streaming upload must receive an HTTP 413 response head, never a bare reset; got: " + responseText.slice(0, 120)
  );
  assert.ok(responseText.includes("PAYLOAD_TOO_LARGE"), "413 response must carry the JSON error envelope");
});

