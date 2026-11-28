import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";

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
  key = nextKey("sync-blob-put"),
  nowMs = BASE_NOW,
  mutateBody = null
} = {}) {
  const cipher = cipherBlob(1024, seed);
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
  assert.ok(current.ciphertext_base64.length > 0, "current row must retain exact ciphertext bytes only");
  assert.equal(current.ciphertext_size_bytes, 1024);
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
  const invalidSize = await app.inject({
    method: "PUT",
    url: "/api/v1/sync/blobs/" + crypto.randomUUID(),
    headers: { ...fixture.auth, "x-dis-sync-device-id": deviceId, "idempotency-key": nextKey("sync-invalid-size") },
    body: invalidSizeBody
  });
  assert.equal(invalidSize.status, 400);
  assert.equal(invalidSize.body.error.code, "SYNC_ENVELOPE_INVALID");
  assert.ok(Array.from(app.store.syncTransferUsage.values()).filter((row) => row.direction === "INGRESS").length >= 2, "every authenticated PUT attempt must count ingress even when validation rejects");

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
    ciphertext_base64: cipherBlob().ciphertext_base64,
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
    ciphertext_base64: cipherBlob().ciphertext_base64,
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
      ciphertext_base64: cipherBlob().ciphertext_base64,
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
  const beforeIngressRows = Array.from(app.store.syncTransferUsage.values()).filter((row) => row.direction === "INGRESS").length;
  const ingressBlocked = await putBlob(app, fixture, deviceId, crypto.randomUUID());
  assert.equal(ingressBlocked.status, 429);
  assert.equal(ingressBlocked.body.error.code, "SYNC_BANDWIDTH_QUOTA_EXCEEDED");
  const afterIngressRows = Array.from(app.store.syncTransferUsage.values()).filter((row) => row.direction === "INGRESS").length;
  assert.equal(afterIngressRows, beforeIngressRows + 1, "even bandwidth-rejected authenticated PUT attempts count ingress once");
});
