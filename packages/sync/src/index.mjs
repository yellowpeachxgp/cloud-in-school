import crypto from "node:crypto";
import { ContractError, API_VERSION } from "../../contracts/src/index.mjs";

export const SYNC_BUCKET_SIZES = Object.freeze([1024, 4096, 16384, 65536, 262144, 1048576]);
export const SYNC_VECTOR_MAX_ENTRIES = 512;
export const SYNC_COUNTER_MAX = 2147483647;
export const SYNC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const SYNC_QUOTAS = Object.freeze({
  activeDevices: 32,
  registeredDevices: 256,
  liveBlobs: 4096,
  livePaddedBytes: 268435456,
  ingressBytesPer24h: 536870912,
  egressBytesPer24h: 536870912
});

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const KEY_ID_RE = /^[A-Za-z0-9._:-]+$/;
const NONCE_RE = /^[A-Za-z0-9+/]{16}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const PRE_RENAME_STAGES = new Set(["tmp_open", "tmp_write", "tmp_fsync", "tmp_close", "rename"]);
const E2EE_PURPOSE = "E2EE_CLOUD_SYNC";
const BUCKET_SET = new Set(SYNC_BUCKET_SIZES);
const WRITE_RATE_LIMIT_PER_MINUTE = 120;
const READ_RATE_LIMIT_PER_MINUTE = 240;
const RATE_WINDOW_MS = 60_000;
const TRANSFER_WINDOW_MS = 24 * 60 * 60 * 1000;

function iso(nowMs) {
  return new Date(nowMs).toISOString();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function badRequest(message) {
  return new ContractError("BAD_REQUEST", message);
}

function syncError(code, message, detail = undefined) {
  return new ContractError(code, message, detail);
}

function requireString(value, field, { min = 1, max = Infinity, trim = true } = {}) {
  if (typeof value !== "string") throw badRequest(field + " must be a string");
  const clean = trim ? value.trim() : value;
  if (clean.length < min) throw badRequest(field + " must not be empty");
  if (clean.length > max) throw badRequest(field + " exceeds maximum length " + max);
  return clean;
}

function optionalString(value, field, { max = Infinity } = {}) {
  if (value === undefined || value === null) return null;
  return requireString(value, field, { min: 0, max });
}

function requireUuid(value, field) {
  const clean = requireString(value, field, { max: 64 });
  if (!UUID_RE.test(clean)) throw badRequest(field + " must be a UUID");
  return clean.toLowerCase();
}

function requireNoUnknownFields(body, allowedFields, label) {
  if (!isPlainObject(body)) throw badRequest(label + " must be a JSON object");
  for (const key of Object.keys(body)) {
    if (!allowedFields.includes(key)) throw badRequest(label + " contains unsupported field: " + key);
  }
}

function normalizeHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) out[String(key).toLowerCase()] = value;
  return {
    idempotencyKey: out["idempotency-key"] || null,
    syncDeviceId: out["x-dis-sync-device-id"] || null
  };
}

function mutateObject(obj, patch, undo) {
  const before = {};
  for (const key of Object.keys(patch)) before[key] = Object.hasOwn(obj, key) ? obj[key] : undefined;
  undo.push(() => {
    for (const key of Object.keys(patch)) {
      if (before[key] === undefined) delete obj[key];
      else obj[key] = before[key];
    }
  });
  Object.assign(obj, patch);
}

function setMapCommitted(map, key, value, undo) {
  const had = map.has(key);
  const before = map.get(key);
  map.set(key, value);
  undo.push(() => {
    if (had) map.set(key, before);
    else map.delete(key);
  });
}

function deleteMapCommitted(map, key, undo) {
  if (!map.has(key)) return;
  const before = map.get(key);
  map.delete(key);
  undo.push(() => map.set(key, before));
}

function pushArrayCommitted(array, value, undo) {
  array.push(value);
  undo.push(() => {
    const index = array.lastIndexOf(value);
    if (index >= 0) array.splice(index, 1);
  });
}

function deviceKey(userId, deviceId) {
  return userId + ":" + deviceId;
}

function blobKey(userId, blobId) {
  return userId + ":" + blobId;
}

function mutationKey(userId, sequence) {
  return userId + ":" + String(sequence);
}

function usageWindowKey(userId, kind, windowStartMs) {
  return userId + ":" + kind + ":" + String(windowStartMs);
}

function parseLimit(raw, fallback = 20) {
  if (raw == null || raw === "") return fallback;
  if (!/^\d+$/.test(String(raw))) throw badRequest("limit must be an integer");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) throw badRequest("limit must be between 1 and 100");
  return value;
}

function decodeStrictBase64(value, field) {
  if (typeof value !== "string" || !BASE64_RE.test(value) || value.length % 4 !== 0) {
    throw syncError("SYNC_ENVELOPE_INVALID", field + " must be canonical base64 without whitespace");
  }
  return Buffer.from(value, "base64");
}

function normalizeVector(value, field = "base_vector") {
  if (!Array.isArray(value)) {
    throw syncError("SYNC_VECTOR_INVALID", field + " must be an array of device/counter entries");
  }
  if (value.length > SYNC_VECTOR_MAX_ENTRIES) {
    throw syncError("SYNC_VECTOR_INVALID", field + " exceeds the 512-entry protocol bound");
  }
  const seen = new Set();
  const out = [];
  let previous = null;
  for (const entry of value) {
    if (!isPlainObject(entry)) throw syncError("SYNC_VECTOR_INVALID", field + " entries must be objects");
    requireNoUnknownFields(entry, ["device_id", "counter"], field + " entry");
    const deviceId = requireUuid(entry.device_id, field + ".device_id");
    if (!Number.isSafeInteger(entry.counter) || entry.counter < 1 || entry.counter > SYNC_COUNTER_MAX) {
      throw syncError("SYNC_VECTOR_INVALID", field + ".counter must be an integer in 1..2147483647");
    }
    if (seen.has(deviceId)) throw syncError("SYNC_VECTOR_INVALID", field + " contains duplicate device_id entries");
    seen.add(deviceId);
    if (previous !== null && deviceId.localeCompare(previous) <= 0) {
      throw syncError("SYNC_VECTOR_INVALID", field + " entries must be serialized in ascending lexical device UUID order");
    }
    previous = deviceId;
    out.push({ device_id: deviceId, counter: entry.counter });
  }
  return out;
}

function vectorMap(vector) {
  const out = new Map();
  for (const entry of vector || []) out.set(entry.device_id, entry.counter);
  return out;
}

function vectorsEqual(left, right) {
  const a = vectorMap(left);
  const b = vectorMap(right);
  if (a.size !== b.size) return false;
  for (const [deviceId, counter] of a) {
    if (b.get(deviceId) !== counter) return false;
  }
  return true;
}

function compareVectorEntries(a, b) {
  return a.device_id.localeCompare(b.device_id);
}

function validateEncryption(value) {
  if (!isPlainObject(value)) throw syncError("SYNC_ENVELOPE_INVALID", "encryption must be an object");
  requireNoUnknownFields(value, ["format", "cipher_suite", "padding_scheme", "key_id", "nonce_base64"], "encryption");
  if (value.format !== "dis-sync-e2ee/v1") throw syncError("SYNC_ENVELOPE_INVALID", "encryption.format must be dis-sync-e2ee/v1");
  if (value.cipher_suite !== "AES-256-GCM") throw syncError("SYNC_ENVELOPE_INVALID", "encryption.cipher_suite must be AES-256-GCM");
  if (value.padding_scheme !== "DIS_SYNC_SIZE_BUCKETS_POW4_V1") {
    throw syncError("SYNC_ENVELOPE_INVALID", "encryption.padding_scheme must be DIS_SYNC_SIZE_BUCKETS_POW4_V1");
  }
  const keyId = requireString(value.key_id, "encryption.key_id", { min: 8, max: 128, trim: false });
  if (!KEY_ID_RE.test(keyId)) throw syncError("SYNC_ENVELOPE_INVALID", "encryption.key_id must remain an opaque non-secret identifier");
  const nonce = requireString(value.nonce_base64, "encryption.nonce_base64", { min: 16, max: 16, trim: false });
  if (!NONCE_RE.test(nonce) || Buffer.from(nonce, "base64").length !== 12) {
    throw syncError("SYNC_ENVELOPE_INVALID", "encryption.nonce_base64 must encode a 12-byte AES-GCM nonce without padding");
  }
  return {
    format: value.format,
    cipher_suite: value.cipher_suite,
    padding_scheme: value.padding_scheme,
    key_id: keyId,
    nonce_base64: nonce
  };
}

function publicEncryption(encryption) {
  return encryption ? clone(encryption) : null;
}

function metadataView(row) {
  return {
    blob_id: row.blob_id,
    change_kind: row.change_kind,
    version_vector: clone(row.version_vector || []),
    author_device_id: row.author_device_id,
    change_sequence: row.change_sequence,
    encryption: publicEncryption(row.encryption),
    ciphertext_sha256: row.ciphertext_sha256 ?? null,
    ciphertext_size_bytes: row.ciphertext_size_bytes ?? null,
    committed_at: row.committed_at
  };
}

function deviceView(row) {
  return {
    device_id: row.device_id,
    status: row.status,
    device_label: row.device_label ?? null,
    platform: row.platform,
    sync_protocol_version: row.sync_protocol_version,
    registered_at: row.registered_at,
    revoked_at: row.revoked_at ?? null,
    revocation_reason: row.revocation_reason ?? null,
    last_seen_at: row.last_seen_at ?? null
  };
}

function consentHasE2eeScope(consent) {
  if (!consent) return false;
  if (consent.purpose === E2EE_PURPOSE) return true;
  return Array.isArray(consent.scope_list) && consent.scope_list.includes(E2EE_PURPOSE);
}

function validE2eeDocument(consent) {
  return Boolean(
    consent &&
    typeof consent.document_version === "string" &&
    consent.document_version.trim().length > 0 &&
    typeof consent.document_sha256 === "string" &&
    HEX_SHA256_RE.test(consent.document_sha256)
  );
}

function responseBodyForEstimate(code, data, requestId, extraMeta = null) {
  return {
    ok: true,
    code,
    request_id: requestId,
    data,
    meta: {
      request_id: requestId,
      api_version: API_VERSION,
      next_cursor: null,
      ...(extraMeta || {})
    }
  };
}

function byteLengthJson(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sortBySequence(rows) {
  return [...rows].sort((a, b) => a.change_sequence - b.change_sequence || a.blob_id.localeCompare(b.blob_id));
}

export class SyncService {
  constructor(store) {
    this.store = store;
    for (const field of [
      "syncUserStates", "syncDevices", "syncBlobs", "syncMutations", "syncBlobAntiResurrection",
      "syncCursors", "syncTransferUsage", "syncRateWindows"
    ]) {
      if (!this.store[field]) this.store[field] = new Map();
    }
  }

  _idempotency(operation, auth, headers, body, targetFingerprint = null) {
    const { idempotencyKey } = normalizeHeaders(headers);
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw badRequest("Idempotency-Key header is required and must be 8..128 characters");
    }
    const normalizedBody = body === undefined || body === null ? {} : body;
    const fingerprintBody = targetFingerprint ? { target: targetFingerprint, body: normalizedBody } : normalizedBody;
    const bodyHash = sha256Json(fingerprintBody);
    const canonicalHash = sha256Json(canonicalize(fingerprintBody));
    const cacheKey = operation + "|" + auth.cloudUserId + "|" + idempotencyKey;
    const existing = this.store.idempotencyRecords.get(cacheKey);
    if (existing) {
      const matches = existing.hashVersion === 2 ? existing.canonicalHash === canonicalHash : existing.bodyHash === bodyHash;
      if (!matches) throw new ContractError("CONFLICT", "Idempotency-Key reused with different request payload");
      return {
        replay: {
          status: 200,
          code: "REQUEST_DUPLICATE",
          data: clone(existing.data),
          ...(existing.headers ? { headers: clone(existing.headers) } : {})
        }
      };
    }
    return { replay: null, receipt: { cacheKey, bodyHash, canonicalHash } };
  }

  _commitWithReceipt(apply, receipt, nowMs) {
    const undo = [];
    let flushStarted = false;
    const rollback = () => {
      for (let index = undo.length - 1; index >= 0; index -= 1) {
        try { undo[index](); } catch { /* indexes are rebuilt below either way */ }
      }
      if (receipt?.cacheKey) this.store.idempotencyRecords.delete(receipt.cacheKey);
      this.store._rebuildIndexes?.();
    };
    try {
      const result = apply(undo);
      if (receipt?.cacheKey) {
        this.store.idempotencyRecords.set(receipt.cacheKey, {
          bodyHash: receipt.bodyHash,
          canonicalHash: receipt.canonicalHash,
          hashVersion: 2,
          data: clone(result.data),
          ...(result.headers ? { headers: clone(result.headers) } : {}),
          createdAtMs: nowMs
        });
      }
      flushStarted = true;
      if (typeof this.store.flushSnapshotStrictSync === "function") this.store.flushSnapshotStrictSync();
      else if (typeof this.store.flushSnapshotSync === "function") this.store.flushSnapshotSync();
      else if (typeof this.store.saveSnapshot === "function") this.store.saveSnapshot();
      return result;
    } catch (err) {
      if (!flushStarted) {
        rollback();
        throw err;
      }
      const stage = err?.persistStage || null;
      if (err?.code === "STORAGE_COMMIT_UNKNOWN" && !stage && err?.commitPublished === undefined) {
        rollback();
        throw err;
      }
      if (err?.commitPublished === false || (err?.commitPublished !== true && (!stage || PRE_RENAME_STAGES.has(stage)))) {
        rollback();
        throw new ContractError(
          "STORAGE_PERSISTENCE_FAILED",
          "E2EE 同步提交未能持久化，请稍后按原 Idempotency-Key 重试；未产生半提交状态"
        );
      }
      throw new ContractError(
        "STORAGE_COMMIT_UNKNOWN",
        "E2EE 同步提交结果未知：快照可能已发布但核验失败。请携带原 Idempotency-Key 重试以对账，不要另起新键",
        { persist_stage: stage, durability: "UNKNOWN", retry_same_key: true }
      );
    }
  }

  _commitMutation(apply, nowMs) {
    return this._commitWithReceipt(apply, null, nowMs);
  }

  _stateFor(userId) {
    return this.store.syncUserStates.get(userId) || null;
  }

  _ensureUserState(userId, nowMs, undo) {
    let state = this.store.syncUserStates.get(userId);
    if (!state) {
      state = {
        cloud_user_id: userId,
        latest_change_sequence: 0,
        compaction_epoch: 0,
        consent_withdrawn_at: null,
        retention_expires_at: null,
        reauthorized_at: null,
        expired_cleanup_at: null,
        updated_at: iso(nowMs)
      };
      setMapCommitted(this.store.syncUserStates, userId, state, undo);
    }
    return state;
  }

  _activeE2eeConsents(userId, nowMs) {
    return Array.from(this.store.consents.values()).filter((consent) => {
      if (!consent || consent.cloud_user_id !== userId || !consentHasE2eeScope(consent)) return false;
      if (consent.withdrawn_at) return false;
      if (!validE2eeDocument(consent)) return false;
      if (consent.expires_at) {
        const expiry = Date.parse(consent.expires_at);
        if (!Number.isFinite(expiry) || expiry <= nowMs) return false;
      }
      return true;
    });
  }

  _hasActiveE2eeConsent(userId, nowMs) {
    return this._activeE2eeConsents(userId, nowMs).length > 0;
  }

  _requireE2eeConsent(userId, nowMs) {
    if (!this._hasActiveE2eeConsent(userId, nowMs)) {
      throw syncError("SYNC_CONSENT_REQUIRED", "E2EE cloud sync requires an active explicit E2EE_CLOUD_SYNC consent");
    }
  }

  _validateRegistrationConsent(userId, consentId, nowMs) {
    const consent = this.store.consents.get(consentId);
    const active = consent && this._activeE2eeConsents(userId, nowMs).some((row) => row.id === consent.id);
    if (!consent || consent.cloud_user_id !== userId || !consentHasE2eeScope(consent) || !active) {
      throw syncError("SYNC_CONSENT_REQUIRED", "consent_id is missing, withdrawn, expired, mismatched, or lacks the required E2EE disclosure document");
    }
    return consent;
  }

  _lifecycleIntent(userId, nowMs) {
    const state = this._stateFor(userId);
    if (!state?.consent_withdrawn_at || !state.retention_expires_at) return null;
    const expiryMs = Date.parse(state.retention_expires_at);
    if (!Number.isFinite(expiryMs)) return "cleanup";
    const active = this._hasActiveE2eeConsent(userId, nowMs);
    if (active && nowMs < expiryMs) return "reauthorized";
    if (nowMs >= expiryMs && !state.expired_cleanup_at) return "cleanup";
    return null;
  }

  _settleConsentLifecycle(userId, nowMs) {
    const prior = this._stateFor(userId);
    if (
      prior?.expired_cleanup_at &&
      !prior.consent_withdrawn_at &&
      this._hasActiveE2eeConsent(userId, nowMs)
    ) {
      // A cleanup cycle is complete once it has run.  Clearing only the completion
      // marker here lets a later, independent withdrawal start a fresh 30-day
      // lifecycle; it never restores the ciphertext/devices already erased or revoked.
      this._commitMutation((undo) => {
        const state = this._ensureUserState(userId, nowMs, undo);
        mutateObject(state, { expired_cleanup_at: null, reauthorized_at: iso(nowMs), updated_at: iso(nowMs) }, undo);
        return { settled: "post_cleanup_reauthorized" };
      }, nowMs);
    }
    const intent = this._lifecycleIntent(userId, nowMs);
    if (!intent) return;
    this._commitMutation((undo) => {
      const state = this._ensureUserState(userId, nowMs, undo);
      if (intent === "reauthorized") this._applyConsentReauthorized(state, nowMs, undo);
      else this._applyConsentExpiryCleanup(userId, state, nowMs, undo);
      return { settled: intent };
    }, nowMs);
  }

  _applyConsentReauthorized(state, nowMs, undo) {
    mutateObject(state, {
      consent_withdrawn_at: null,
      retention_expires_at: null,
      reauthorized_at: iso(nowMs),
      updated_at: iso(nowMs)
    }, undo);
  }

  _applyConsentExpiryCleanup(userId, state, nowMs, undo) {
    const ts = iso(nowMs);
    for (const [key, blob] of Array.from(this.store.syncBlobs.entries())) {
      if (blob?.cloud_user_id === userId) deleteMapCommitted(this.store.syncBlobs, key, undo);
    }
    for (const [key, mutation] of Array.from(this.store.syncMutations.entries())) {
      if (mutation?.cloud_user_id === userId) deleteMapCommitted(this.store.syncMutations, key, undo);
    }
    for (const [cursorId, cursor] of Array.from(this.store.syncCursors.entries())) {
      if (cursor?.cloud_user_id === userId) deleteMapCommitted(this.store.syncCursors, cursorId, undo);
    }
    for (const device of this._devicesForUser(userId)) {
      mutateObject(device, { acknowledged_cursor_position: 0 }, undo);
      if (device.status === "ACTIVE") {
        this._revokeDeviceInPlace(device, "CONSENT_WITHDRAWN", nowMs, undo, true);
      }
    }
    mutateObject(state, {
      consent_withdrawn_at: null,
      retention_expires_at: null,
      expired_cleanup_at: ts,
      updated_at: ts
    }, undo);
  }

  settleConsentLifecycle(userId, nowMs = Date.now()) {
    this._settleConsentLifecycle(userId, nowMs);
  }

  handleConsentWithdrawn(userId, consent, nowMs = Date.now()) {
    if (!consentHasE2eeScope(consent)) return null;
    if (this._hasActiveE2eeConsent(userId, nowMs)) return null;
    const state = this._stateFor(userId) || {
      cloud_user_id: userId,
      latest_change_sequence: 0,
      compaction_epoch: 0,
      consent_withdrawn_at: null,
      retention_expires_at: null,
      reauthorized_at: null,
      expired_cleanup_at: null,
      updated_at: iso(nowMs)
    };
    if (!this.store.syncUserStates.has(userId)) this.store.syncUserStates.set(userId, state);
    if (!state.consent_withdrawn_at) {
      const ts = iso(nowMs);
      state.consent_withdrawn_at = ts;
      state.retention_expires_at = iso(nowMs + SYNC_RETENTION_MS);
      state.updated_at = ts;
    }
    for (const cursor of this.store.syncCursors.values()) {
      if (cursor.cloud_user_id === userId && !cursor.invalidated_at) cursor.invalidated_at = iso(nowMs);
    }
    for (const device of this._devicesForUser(userId)) device.acknowledged_cursor_position = 0;
    return {
      consent_withdrawn_at: state.consent_withdrawn_at,
      retention_expires_at: state.retention_expires_at
    };
  }

  _devicesForUser(userId) {
    return Array.from(this.store.syncDevices.values())
      .filter((device) => device?.cloud_user_id === userId)
      .sort((a, b) => Date.parse(a.registered_at) - Date.parse(b.registered_at) || a.device_id.localeCompare(b.device_id));
  }

  _mutationsForUser(userId) {
    return sortBySequence(Array.from(this.store.syncMutations.values()).filter((row) => row?.cloud_user_id === userId));
  }

  _consumeRateLimitInPlace(userId, kind, nowMs, undo) {
    const windowStart = Math.floor(nowMs / RATE_WINDOW_MS) * RATE_WINDOW_MS;
    const key = usageWindowKey(userId, kind, windowStart);
    let row = this.store.syncRateWindows.get(key);
    if (!row) {
      row = {
        cloud_user_id: userId,
        operation_kind: kind,
        window_started_at: iso(windowStart),
        window_started_ms: windowStart,
        request_count: 0
      };
      setMapCommitted(this.store.syncRateWindows, key, row, undo);
    }
    const limit = kind === "WRITE" ? WRITE_RATE_LIMIT_PER_MINUTE : READ_RATE_LIMIT_PER_MINUTE;
    if (row.request_count >= limit) {
      throw syncError("SYNC_RATE_LIMITED", "encrypted synchronization " + kind.toLowerCase() + " rate limit reached");
    }
    mutateObject(row, { request_count: row.request_count + 1 }, undo);
    for (const [oldKey, oldRow] of Array.from(this.store.syncRateWindows.entries())) {
      if (oldRow?.cloud_user_id === userId && Number(oldRow.window_started_ms || 0) < windowStart - 2 * RATE_WINDOW_MS) {
        deleteMapCommitted(this.store.syncRateWindows, oldKey, undo);
      }
    }
  }

  _transferRows(userId, direction, nowMs) {
    const cutoff = nowMs - TRANSFER_WINDOW_MS;
    return Array.from(this.store.syncTransferUsage.values()).filter((row) => (
      row?.cloud_user_id === userId &&
      row.direction === direction &&
      Date.parse(row.occurred_at) >= cutoff
    ));
  }

  _transferTotal(userId, direction, nowMs) {
    return this._transferRows(userId, direction, nowMs).reduce((sum, row) => sum + Number(row.bytes || 0), 0);
  }

  _pruneTransferUsageInPlace(userId, direction, nowMs, undo) {
    const cutoff = nowMs - TRANSFER_WINDOW_MS;
    for (const [usageId, row] of Array.from(this.store.syncTransferUsage.entries())) {
      if (row?.cloud_user_id === userId && row.direction === direction && Date.parse(row.occurred_at) < cutoff) {
        deleteMapCommitted(this.store.syncTransferUsage, usageId, undo);
      }
    }
  }

  _appendTransferUsageInPlace(userId, direction, bytes, nowMs, undo) {
    this._pruneTransferUsageInPlace(userId, direction, nowMs, undo);
    const usageId = crypto.randomUUID();
    setMapCommitted(this.store.syncTransferUsage, usageId, {
      id: usageId,
      cloud_user_id: userId,
      direction,
      bytes,
      occurred_at: iso(nowMs)
    }, undo);
    return this._transferTotal(userId, direction, nowMs);
  }

  _recordIngressAttempt(userId, bytes, nowMs) {
    const result = this._commitMutation((undo) => {
      const total = this._appendTransferUsageInPlace(userId, "INGRESS", Math.max(1, bytes), nowMs, undo);
      return { total };
    }, nowMs);
    if (result.total > SYNC_QUOTAS.ingressBytesPer24h) {
      throw syncError("SYNC_BANDWIDTH_QUOTA_EXCEEDED", "rolling 24-hour sync ingress quota exceeded", {
        dimension: "INGRESS",
        limit_bytes: SYNC_QUOTAS.ingressBytesPer24h,
        used_bytes: result.total
      });
    }
  }

  _consumeEgressInPlace(userId, bytes, nowMs, undo) {
    this._pruneTransferUsageInPlace(userId, "EGRESS", nowMs, undo);
    const current = this._transferTotal(userId, "EGRESS", nowMs);
    if (current + bytes > SYNC_QUOTAS.egressBytesPer24h) {
      throw syncError("SYNC_BANDWIDTH_QUOTA_EXCEEDED", "rolling 24-hour sync egress quota exceeded", {
        dimension: "EGRESS",
        limit_bytes: SYNC_QUOTAS.egressBytesPer24h,
        used_bytes: current,
        response_bytes: bytes
      });
    }
    this._appendTransferUsageInPlace(userId, "EGRESS", Math.max(1, bytes), nowMs, undo);
  }

  _activeDevice(userId, rawDeviceId, { notFoundAs = "SYNC_DEVICE_NOT_FOUND" } = {}) {
    const cleanDeviceId = requireUuid(rawDeviceId, "X-Dis-Sync-Device-Id");
    const device = this.store.syncDevices.get(deviceKey(userId, cleanDeviceId));
    if (!device) throw syncError(notFoundAs, "sync device is not registered for the authenticated user");
    if (device.status === "REVOKED") throw syncError("SYNC_DEVICE_REVOKED", "sync device was permanently revoked");
    return device;
  }

  _requireBoundActiveDevice(auth, headers) {
    const { syncDeviceId } = normalizeHeaders(headers);
    if (!syncDeviceId) throw badRequest("X-Dis-Sync-Device-Id header is required");
    const device = this._activeDevice(auth.cloudUserId, syncDeviceId);
    if (!auth.familyId || device.session_family_id !== auth.familyId) {
      throw syncError("SYNC_PERMISSION_DENIED", "sync device is not bound to the authenticated cloud session family");
    }
    return device;
  }

  _touchDeviceInPlace(device, nowMs, undo) {
    mutateObject(device, { last_seen_at: iso(nowMs) }, undo);
  }

  _appendDeviceEvent(device, action, nowMs, undo) {
    const eventId = crypto.randomUUID();
    const occurredAt = iso(nowMs);
    const payload = {
      event_id: eventId,
      event_key: "dis:sync:user:" + device.cloud_user_id + ":device:" + device.device_id + ":" + action + ":v1",
      event_type: action,
      occurred_at: occurredAt,
      cloud_user_id: device.cloud_user_id,
      device_id: device.device_id,
      status: device.status,
      revocation_reason: device.revocation_reason ?? null
    };
    pushArrayCommitted(this.store.outboxEvents, {
      id: eventId,
      aggregate_type: "sync_device",
      aggregate_id: device.device_id,
      event_type: "sync.device." + action,
      payload_json: payload,
      created_at: occurredAt,
      delivered_at: null
    }, undo);
    return payload;
  }

  _appendBlobEvent(row, action, nowMs, undo) {
    const eventId = crypto.randomUUID();
    const occurredAt = iso(nowMs);
    const payload = {
      event_id: eventId,
      event_key: "dis:sync:user:" + row.cloud_user_id + ":blob:" + row.blob_id + ":change:" + row.change_sequence + ":" + action + ":v1",
      event_type: action,
      occurred_at: occurredAt,
      cloud_user_id: row.cloud_user_id,
      blob_id: row.blob_id,
      author_device_id: row.author_device_id,
      change_sequence: row.change_sequence,
      version_vector: clone(row.version_vector),
      ...(action === "written" ? {
        encryption_format: row.encryption.format,
        cipher_suite: row.encryption.cipher_suite,
        padding_scheme: row.encryption.padding_scheme,
        key_id: row.encryption.key_id,
        nonce_base64: row.encryption.nonce_base64,
        ciphertext_sha256: row.ciphertext_sha256,
        ciphertext_size_bytes: row.ciphertext_size_bytes
      } : {
        tombstone_reason: "USER_DELETE"
      })
    };
    pushArrayCommitted(this.store.outboxEvents, {
      id: eventId,
      aggregate_type: "sync_blob",
      aggregate_id: row.blob_id,
      event_type: "sync.blob." + action,
      payload_json: payload,
      created_at: occurredAt,
      delivered_at: null
    }, undo);
    return payload;
  }

  _revokeSessionsForFamily(userId, familyId, nowMs, undo) {
    const ts = iso(nowMs);
    for (const session of this.store.deviceSessions.values()) {
      if (session?.cloud_user_id === userId && session.family_id === familyId && !session.revoked_at) {
        mutateObject(session, { revoked_at: ts }, undo);
      }
    }
  }

  _invalidateDeviceCursorsInPlace(userId, deviceId, nowMs, undo) {
    const ts = iso(nowMs);
    for (const cursor of this.store.syncCursors.values()) {
      if (cursor.cloud_user_id === userId && cursor.device_id === deviceId && !cursor.invalidated_at) {
        mutateObject(cursor, { invalidated_at: ts }, undo);
      }
    }
  }

  _revokeDeviceInPlace(device, reason, nowMs, undo, emitEvent) {
    const ts = iso(nowMs);
    if (device.status !== "REVOKED") {
      mutateObject(device, {
        status: "REVOKED",
        revoked_at: ts,
        revocation_reason: reason,
        acknowledged_cursor_position: 0
      }, undo);
      this._invalidateDeviceCursorsInPlace(device.cloud_user_id, device.device_id, nowMs, undo);
      this._revokeSessionsForFamily(device.cloud_user_id, device.session_family_id, nowMs, undo);
      if (emitEvent) this._appendDeviceEvent(device, "revoked", nowMs, undo);
    }
  }

  listSyncDevices(auth, query, nowMs = Date.now()) {
    this._settleConsentLifecycle(auth.cloudUserId, nowMs);
    return this._commitMutation((undo) => {
      this._consumeRateLimitInPlace(auth.cloudUserId, "READ", nowMs, undo);
      return {
        status: 200,
        code: "SYNC_DEVICES_LISTED",
        data: this._devicesForUser(auth.cloudUserId).map(deviceView)
      };
    }, nowMs);
  }

  registerSyncDevice(auth, params, body, headers, nowMs = Date.now()) {
    this._settleConsentLifecycle(auth.cloudUserId, nowMs);
    const deviceId = requireUuid(params.deviceId, "deviceId");
    const { replay, receipt } = this._idempotency("registerSyncDevice", auth, headers, body, { device_id: deviceId });
    if (replay) return replay;
    requireNoUnknownFields(body, ["consent_id", "device_label", "platform", "sync_protocol_version"], "register sync device request");
    const consentId = requireUuid(body.consent_id, "consent_id");
    const platform = requireString(body.platform, "platform", { max: 32 });
    if (platform !== "ANDROID") throw syncError("SYNC_DEVICE_INVALID", "platform must be ANDROID in dis-sync-e2ee/v1");
    if (body.sync_protocol_version !== 1) throw syncError("SYNC_DEVICE_INVALID", "sync_protocol_version must be 1");
    const label = optionalString(body.device_label, "device_label", { max: 80 });
    if (!auth.familyId) throw syncError("SYNC_DEVICE_INVALID", "authenticated cloud session family is required for sync device binding");
    const key = deviceKey(auth.cloudUserId, deviceId);
    const existing = this.store.syncDevices.get(key);
    if (existing?.status === "REVOKED") {
      throw syncError("SYNC_DEVICE_REVOKED", "sync device id was previously revoked and is permanently closed");
    }
    if (existing) {
      const same = existing.session_family_id === auth.familyId &&
        existing.consent_id === consentId &&
        (existing.device_label ?? null) === label &&
        existing.platform === platform &&
        existing.sync_protocol_version === 1;
      if (!same) {
        throw syncError("SYNC_DEVICE_CONFLICT", "sync device id is already bound to different immutable registration metadata or session family");
      }
      return { status: 200, code: "SYNC_DEVICE_REGISTERED", data: deviceView(existing) };
    }
    const consent = this._validateRegistrationConsent(auth.cloudUserId, consentId, nowMs);
    const devices = this._devicesForUser(auth.cloudUserId);
    const activeCount = devices.filter((device) => device.status === "ACTIVE").length;
    if (activeCount + 1 > SYNC_QUOTAS.activeDevices) {
      throw syncError("SYNC_QUOTA_EXCEEDED", "active sync device quota exceeded", { dimension: "ACTIVE_DEVICES", limit: SYNC_QUOTAS.activeDevices });
    }
    if (devices.length + 1 > SYNC_QUOTAS.registeredDevices) {
      throw syncError("SYNC_QUOTA_EXCEEDED", "total sync device registration quota exceeded", { dimension: "REGISTERED_DEVICES", limit: SYNC_QUOTAS.registeredDevices });
    }
    return this._commitWithReceipt((undo) => {
      this._consumeRateLimitInPlace(auth.cloudUserId, "WRITE", nowMs, undo);
      this._ensureUserState(auth.cloudUserId, nowMs, undo);
      const record = {
        cloud_user_id: auth.cloudUserId,
        device_id: deviceId,
        session_family_id: auth.familyId,
        consent_id: consent.id,
        device_label: label,
        platform,
        sync_protocol_version: 1,
        status: "ACTIVE",
        registered_at: iso(nowMs),
        revoked_at: null,
        revocation_reason: null,
        last_seen_at: iso(nowMs),
        acknowledged_cursor_position: 0
      };
      setMapCommitted(this.store.syncDevices, key, record, undo);
      this._appendDeviceEvent(record, "registered", nowMs, undo);
      return { status: 201, code: "SYNC_DEVICE_REGISTERED", data: deviceView(record) };
    }, receipt, nowMs);
  }

  revokeSyncDevice(auth, params, body, headers, nowMs = Date.now()) {
    this._settleConsentLifecycle(auth.cloudUserId, nowMs);
    const deviceId = requireUuid(params.deviceId, "deviceId");
    const normalizedBody = body === undefined || body === null ? {} : body;
    const { replay, receipt } = this._idempotency("revokeSyncDevice", auth, headers, normalizedBody, { device_id: deviceId });
    if (replay) return replay;
    requireNoUnknownFields(normalizedBody, ["reason"], "revoke sync device request");
    const reason = normalizedBody.reason === undefined ? "USER_REMOVED" : normalizedBody.reason;
    if (!["USER_REMOVED", "LOST_OR_STOLEN", "SECURITY_REKEY"].includes(reason)) {
      throw badRequest("reason must be USER_REMOVED, LOST_OR_STOLEN, or SECURITY_REKEY");
    }
    const device = this.store.syncDevices.get(deviceKey(auth.cloudUserId, deviceId));
    if (!device) throw syncError("SYNC_DEVICE_NOT_FOUND", "sync device is not registered for the authenticated user");
    if (device.status === "REVOKED") {
      return { status: 200, code: "SYNC_DEVICE_REVOKED", data: deviceView(device) };
    }
    return this._commitWithReceipt((undo) => {
      this._consumeRateLimitInPlace(auth.cloudUserId, "WRITE", nowMs, undo);
      this._revokeDeviceInPlace(device, reason, nowMs, undo, true);
      return { status: 200, code: "SYNC_DEVICE_REVOKED", data: deviceView(device) };
    }, receipt, nowMs);
  }

  _validateBlobWriteVector(blobId, deviceId, baseVectorRaw, writerCounterRaw, existing) {
    const baseVector = normalizeVector(baseVectorRaw, "base_vector");
    if (!Number.isSafeInteger(writerCounterRaw) || writerCounterRaw < 1 || writerCounterRaw > SYNC_COUNTER_MAX) {
      throw syncError("SYNC_VECTOR_INVALID", "writer_counter must be an integer in 1..2147483647");
    }
    const currentVector = existing ? existing.version_vector : [];
    if (!vectorsEqual(baseVector, currentVector)) {
      throw syncError("SYNC_VECTOR_CONFLICT", "base_vector is stale, advanced, or concurrent with the current server vector", {
        blob_id: blobId,
        current_vector: clone(currentVector),
        current_change_sequence: existing?.change_sequence ?? 0,
        current_ciphertext_sha256: existing?.ciphertext_sha256 ?? null
      });
    }
    const baseMap = vectorMap(baseVector);
    const baseCounter = baseMap.get(deviceId) || 0;
    if (!baseMap.has(deviceId) && baseVector.length >= SYNC_VECTOR_MAX_ENTRIES) {
      throw syncError("SYNC_VECTOR_OVERFLOW", "write would introduce the 513th distinct device entry");
    }
    if (baseCounter >= SYNC_COUNTER_MAX) {
      throw syncError("SYNC_VECTOR_OVERFLOW", "writer counter increment would exceed 2147483647");
    }
    if (writerCounterRaw !== baseCounter + 1) {
      throw syncError("SYNC_VECTOR_INVALID", "writer_counter must be exactly the base counter for the uploading device plus one");
    }
    const nextMap = new Map(baseMap);
    nextMap.set(deviceId, writerCounterRaw);
    return Array.from(nextMap.entries())
      .map(([device_id, counter]) => ({ device_id, counter }))
      .sort(compareVectorEntries);
  }

  _checkLiveBlobQuota(userId, blobId, nextSize, undo) {
    let count = 0;
    let bytes = 0;
    for (const row of this.store.syncBlobs.values()) {
      if (row?.cloud_user_id !== userId || row.blob_id === blobId || row.change_kind !== "UPSERT") continue;
      count += 1;
      bytes += Number(row.ciphertext_size_bytes || 0);
    }
    count += 1;
    bytes += nextSize;
    if (count > SYNC_QUOTAS.liveBlobs) {
      throw syncError("SYNC_QUOTA_EXCEEDED", "live sync blob count quota exceeded", { dimension: "LIVE_BLOBS", limit: SYNC_QUOTAS.liveBlobs });
    }
    if (bytes > SYNC_QUOTAS.livePaddedBytes) {
      throw syncError("SYNC_QUOTA_EXCEEDED", "live padded sync ciphertext byte quota exceeded", { dimension: "LIVE_PADDED_CIPHERTEXT_BYTES", limit: SYNC_QUOTAS.livePaddedBytes });
    }
  }

  _nextChangeSequenceInPlace(userId, nowMs, undo) {
    const state = this._ensureUserState(userId, nowMs, undo);
    const next = Number(state.latest_change_sequence || 0) + 1;
    mutateObject(state, { latest_change_sequence: next, updated_at: iso(nowMs) }, undo);
    return next;
  }

  putSyncBlob(auth, params, body, headers, nowMs = Date.now(), requestId = undefined, bodyBytes = null) {
    const ingressBytes = Number.isSafeInteger(bodyBytes) && bodyBytes > 0 ? bodyBytes : byteLengthJson(body || {});
    this._recordIngressAttempt(auth.cloudUserId, ingressBytes, nowMs);
    this._settleConsentLifecycle(auth.cloudUserId, nowMs);
    this._requireE2eeConsent(auth.cloudUserId, nowMs);
    const device = this._requireBoundActiveDevice(auth, headers);
    const blobId = requireUuid(params.blobId, "blobId");
    const { replay, receipt } = this._idempotency("putSyncBlob", auth, headers, body, { blob_id: blobId, device_id: device.device_id });
    if (replay) return replay;
    requireNoUnknownFields(body, ["encryption", "ciphertext_base64", "ciphertext_sha256", "base_vector", "writer_counter"], "sync blob put request");
    const encryption = validateEncryption(body.encryption);
    const ciphertextBase64 = requireString(body.ciphertext_base64, "ciphertext_base64", { max: 1398104, trim: false });
    const ciphertext = decodeStrictBase64(ciphertextBase64, "ciphertext_base64");
    if (ciphertext.length > SYNC_BUCKET_SIZES[SYNC_BUCKET_SIZES.length - 1]) {
      throw syncError("SYNC_BLOB_TOO_LARGE", "decoded ciphertext exceeds the 1,048,576-byte sync block ceiling");
    }
    if (!BUCKET_SET.has(ciphertext.length)) {
      throw syncError("SYNC_ENVELOPE_INVALID", "decoded ciphertext length including the AEAD tag must exactly equal one fixed POW4 bucket");
    }
    const digest = requireString(body.ciphertext_sha256, "ciphertext_sha256", { min: 64, max: 64, trim: false });
    if (!HEX_SHA256_RE.test(digest) || crypto.createHash("sha256").update(ciphertext).digest("hex") !== digest) {
      throw syncError("SYNC_ENVELOPE_INVALID", "ciphertext_sha256 must be the exact digest of the ciphertext bytes, never plaintext");
    }
    const key = blobKey(auth.cloudUserId, blobId);
    const existing = this.store.syncBlobs.get(key) || null;
    const antiMarker = this.store.syncBlobAntiResurrection.get(key);
    if (antiMarker || existing?.change_kind === "TOMBSTONE") {
      throw syncError("SYNC_BLOB_DELETED", "blob id was permanently tombstoned and cannot be resurrected");
    }
    const acceptedVector = this._validateBlobWriteVector(blobId, device.device_id, body.base_vector, body.writer_counter, existing);
    return this._commitWithReceipt((undo) => {
      this._consumeRateLimitInPlace(auth.cloudUserId, "WRITE", nowMs, undo);
      this._touchDeviceInPlace(device, nowMs, undo);
      this._checkLiveBlobQuota(auth.cloudUserId, blobId, ciphertext.length, undo);
      const sequence = this._nextChangeSequenceInPlace(auth.cloudUserId, nowMs, undo);
      const committedAt = iso(nowMs);
      const row = {
        cloud_user_id: auth.cloudUserId,
        blob_id: blobId,
        change_kind: "UPSERT",
        version_vector: acceptedVector,
        author_device_id: device.device_id,
        change_sequence: sequence,
        encryption,
        ciphertext_base64: ciphertextBase64,
        ciphertext_sha256: digest,
        ciphertext_size_bytes: ciphertext.length,
        committed_at: committedAt
      };
      const mutation = { ...row };
      delete mutation.ciphertext_base64;
      setMapCommitted(this.store.syncBlobs, key, row, undo);
      setMapCommitted(this.store.syncMutations, mutationKey(auth.cloudUserId, sequence), mutation, undo);
      this._appendBlobEvent(row, "written", nowMs, undo);
      return { status: existing ? 200 : 201, code: "SYNC_BLOB_WRITTEN", data: metadataView(row) };
    }, receipt, nowMs);
  }

  downloadSyncBlob(auth, params, headers, nowMs = Date.now(), requestId = undefined) {
    this._settleConsentLifecycle(auth.cloudUserId, nowMs);
    this._requireE2eeConsent(auth.cloudUserId, nowMs);
    const device = this._requireBoundActiveDevice(auth, headers);
    const blobId = requireUuid(params.blobId, "blobId");
    const key = blobKey(auth.cloudUserId, blobId);
    const existing = this.store.syncBlobs.get(key) || null;
    const antiMarker = this.store.syncBlobAntiResurrection.get(key);
    if (!existing) {
      if (antiMarker) throw syncError("SYNC_BLOB_DELETED", "blob id is permanently tombstoned");
      throw syncError("SYNC_BLOB_NOT_FOUND", "encrypted sync blob does not exist");
    }
    if (existing.change_kind === "TOMBSTONE") throw syncError("SYNC_BLOB_DELETED", "blob is tombstoned and ciphertext is unavailable");
    const data = {
      metadata: metadataView(existing),
      ciphertext_base64: existing.ciphertext_base64
    };
    const responseBytes = byteLengthJson(responseBodyForEstimate("SYNC_BLOB_DOWNLOADED", data, requestId || "req_estimate"));
    return this._commitMutation((undo) => {
      this._consumeRateLimitInPlace(auth.cloudUserId, "READ", nowMs, undo);
      this._touchDeviceInPlace(device, nowMs, undo);
      this._consumeEgressInPlace(auth.cloudUserId, responseBytes, nowMs, undo);
      return { status: 200, code: "SYNC_BLOB_DOWNLOADED", data };
    }, nowMs);
  }

  deleteSyncBlob(auth, params, body, headers, nowMs = Date.now()) {
    this._settleConsentLifecycle(auth.cloudUserId, nowMs);
    this._requireE2eeConsent(auth.cloudUserId, nowMs);
    const device = this._requireBoundActiveDevice(auth, headers);
    const blobId = requireUuid(params.blobId, "blobId");
    const { replay, receipt } = this._idempotency("deleteSyncBlob", auth, headers, body, { blob_id: blobId, device_id: device.device_id });
    if (replay) return replay;
    requireNoUnknownFields(body, ["base_vector", "writer_counter"], "sync blob delete request");
    const key = blobKey(auth.cloudUserId, blobId);
    const existing = this.store.syncBlobs.get(key) || null;
    if (!existing) throw syncError("SYNC_BLOB_NOT_FOUND", "encrypted sync blob does not exist");
    const acceptedVector = this._validateBlobWriteVector(blobId, device.device_id, body.base_vector, body.writer_counter, existing);
    if (existing.change_kind === "TOMBSTONE") {
      return { status: 200, code: "SYNC_BLOB_DELETED", data: metadataView(existing) };
    }
    return this._commitWithReceipt((undo) => {
      this._consumeRateLimitInPlace(auth.cloudUserId, "WRITE", nowMs, undo);
      this._touchDeviceInPlace(device, nowMs, undo);
      const sequence = this._nextChangeSequenceInPlace(auth.cloudUserId, nowMs, undo);
      const committedAt = iso(nowMs);
      const row = {
        cloud_user_id: auth.cloudUserId,
        blob_id: blobId,
        change_kind: "TOMBSTONE",
        version_vector: acceptedVector,
        author_device_id: device.device_id,
        change_sequence: sequence,
        encryption: null,
        ciphertext_sha256: null,
        ciphertext_size_bytes: null,
        committed_at: committedAt
      };
      setMapCommitted(this.store.syncBlobs, key, row, undo);
      setMapCommitted(this.store.syncMutations, mutationKey(auth.cloudUserId, sequence), { ...row }, undo);
      if (!this.store.syncBlobAntiResurrection.has(key)) {
        setMapCommitted(this.store.syncBlobAntiResurrection, key, {
          cloud_user_id: auth.cloudUserId,
          blob_id: blobId,
          first_tombstone_change_sequence: sequence,
          tombstoned_at: committedAt
        }, undo);
      }
      this._appendBlobEvent(row, "deleted", nowMs, undo);
      return { status: 200, code: "SYNC_BLOB_DELETED", data: metadataView(row) };
    }, receipt, nowMs);
  }

  _cursorHash(token) {
    return crypto.createHash("sha256").update(String(token)).digest("hex");
  }

  _issueCursorInPlace(userId, deviceId, position, scanEpoch, terminal, nowMs, undo) {
    const token = "synccur_" + crypto.randomBytes(32).toString("base64url");
    const cursorId = crypto.randomUUID();
    setMapCommitted(this.store.syncCursors, cursorId, {
      id: cursorId,
      cloud_user_id: userId,
      device_id: deviceId,
      token_sha256: this._cursorHash(token),
      position,
      scan_epoch: scanEpoch,
      terminal,
      created_at: iso(nowMs),
      last_used_at: null,
      invalidated_at: null
    }, undo);
    return token;
  }

  _findCursor(userId, deviceId, token) {
    if (typeof token !== "string" || token.length < 8 || token.length > 1024) {
      throw syncError("SYNC_CURSOR_INVALID", "sync cursor is malformed");
    }
    const hash = this._cursorHash(token);
    const cursor = Array.from(this.store.syncCursors.values()).find((row) => row.token_sha256 === hash);
    if (!cursor || cursor.cloud_user_id !== userId || cursor.device_id !== deviceId || cursor.invalidated_at) {
      throw syncError("SYNC_CURSOR_INVALID", "sync cursor is malformed, cross-device, or invalidated");
    }
    return cursor;
  }

  _cursorlessRows(userId, epoch, afterPosition, compactionEpoch) {
    const latestByBlob = new Map();
    for (const row of this._mutationsForUser(userId)) {
      if (row.change_sequence <= epoch) latestByBlob.set(row.blob_id, row);
    }
    return sortBySequence(Array.from(latestByBlob.values()).filter((row) => {
      if (row.change_sequence <= afterPosition) return false;
      if (row.change_kind === "UPSERT") return true;
      return row.change_sequence > compactionEpoch;
    }));
  }

  _incrementalRows(userId, epoch, afterPosition) {
    return this._mutationsForUser(userId).filter((row) => row.change_sequence > afterPosition && row.change_sequence <= epoch);
  }

  listSyncChanges(auth, query, headers, nowMs = Date.now(), requestId = undefined) {
    this._settleConsentLifecycle(auth.cloudUserId, nowMs);
    this._requireE2eeConsent(auth.cloudUserId, nowMs);
    const device = this._requireBoundActiveDevice(auth, headers);
    const limit = parseLimit(query.get("limit"), 20);
    const rawCursor = query.get("cursor");
    const stateBefore = this._stateFor(auth.cloudUserId) || { latest_change_sequence: 0, compaction_epoch: 0 };
    let inputCursor = null;
    if (rawCursor) inputCursor = this._findCursor(auth.cloudUserId, device.device_id, rawCursor);
    if (inputCursor && inputCursor.position < Number(stateBefore.compaction_epoch || 0)) {
      throw syncError("SYNC_CURSOR_EXPIRED", "sync cursor is below the retained compaction epoch; resync without cursor");
    }
    const cursorless = !inputCursor;
    const scanEpoch = inputCursor && !inputCursor.terminal ? inputCursor.scan_epoch : Number(stateBefore.latest_change_sequence || 0);
    const startPosition = inputCursor ? inputCursor.position : 0;
    const compactionEpoch = Number(stateBefore.compaction_epoch || 0);
    const rows = cursorless
      ? this._cursorlessRows(auth.cloudUserId, scanEpoch, startPosition, compactionEpoch)
      : this._incrementalRows(auth.cloudUserId, scanEpoch, startPosition);
    const page = rows.slice(0, limit).map(metadataView);
    const hasMore = rows.length > limit;
    const nextPosition = hasMore ? rows[limit - 1].change_sequence : scanEpoch;
    return this._commitMutation((undo) => {
      this._consumeRateLimitInPlace(auth.cloudUserId, "READ", nowMs, undo);
      this._touchDeviceInPlace(device, nowMs, undo);
      if (inputCursor) {
        mutateObject(inputCursor, { last_used_at: iso(nowMs) }, undo);
        if (inputCursor.position > Number(device.acknowledged_cursor_position || 0)) {
          mutateObject(device, { acknowledged_cursor_position: inputCursor.position }, undo);
        }
      }
      const terminal = !hasMore;
      const nextCursor = this._issueCursorInPlace(
        auth.cloudUserId,
        device.device_id,
        nextPosition,
        scanEpoch,
        terminal,
        nowMs,
        undo
      );
      const meta = {
        has_more: hasMore,
        next_cursor: nextCursor,
        snapshot_epoch: scanEpoch,
        compaction_epoch: compactionEpoch
      };
      const data = page;
      const responseBytes = byteLengthJson(responseBodyForEstimate("SYNC_CHANGES_LISTED", data, requestId || "req_estimate", meta));
      this._consumeEgressInPlace(auth.cloudUserId, responseBytes, nowMs, undo);
      return { status: 200, code: "SYNC_CHANGES_LISTED", data, meta };
    }, nowMs);
  }

  exportUserData(cloudUserId) {
    const blobs = Array.from(this.store.syncBlobs.values())
      .filter((row) => row?.cloud_user_id === cloudUserId)
      .sort((a, b) => a.change_sequence - b.change_sequence)
      .map((row) => ({
        ...metadataView(row),
        ...(row.change_kind === "UPSERT" ? { ciphertext_base64: row.ciphertext_base64 } : {})
      }));
    const mutations = this._mutationsForUser(cloudUserId).map(metadataView);
    return {
      sync_user_state: clone(this.store.syncUserStates.get(cloudUserId) || null),
      sync_devices: this._devicesForUser(cloudUserId).map(deviceView),
      sync_blobs: blobs,
      sync_blob_mutations: mutations,
      sync_blob_anti_resurrection: Array.from(this.store.syncBlobAntiResurrection.values())
        .filter((row) => row?.cloud_user_id === cloudUserId)
        .map((row) => clone(row)),
      sync_cursors: Array.from(this.store.syncCursors.values())
        .filter((row) => row?.cloud_user_id === cloudUserId)
        .map((row) => ({
          device_id: row.device_id,
          position: row.position,
          scan_epoch: row.scan_epoch,
          terminal: row.terminal,
          created_at: row.created_at,
          last_used_at: row.last_used_at,
          invalidated_at: row.invalidated_at
        })),
      sync_transfer_usage: Array.from(this.store.syncTransferUsage.values())
        .filter((row) => row?.cloud_user_id === cloudUserId)
        .map((row) => clone(row))
    };
  }

  purgeUserSyncData(cloudUserId, nowMs = Date.now()) {
    const counts = {};
    const purgeMap = (field, predicate) => {
      let count = 0;
      for (const [key, row] of Array.from(this.store[field].entries())) {
        if (predicate(row, key)) {
          this.store[field].delete(key);
          count += 1;
        }
      }
      return count;
    };
    counts.devices = purgeMap("syncDevices", (row) => row?.cloud_user_id === cloudUserId);
    counts.blobs = purgeMap("syncBlobs", (row) => row?.cloud_user_id === cloudUserId);
    counts.mutations = purgeMap("syncMutations", (row) => row?.cloud_user_id === cloudUserId);
    counts.anti_resurrection = purgeMap("syncBlobAntiResurrection", (row) => row?.cloud_user_id === cloudUserId);
    counts.cursors = purgeMap("syncCursors", (row) => row?.cloud_user_id === cloudUserId);
    counts.transfer_usage = purgeMap("syncTransferUsage", (row) => row?.cloud_user_id === cloudUserId);
    counts.rate_windows = purgeMap("syncRateWindows", (row) => row?.cloud_user_id === cloudUserId);
    counts.user_states = purgeMap("syncUserStates", (row, key) => key === cloudUserId || row?.cloud_user_id === cloudUserId);
    counts.idempotency_receipts = 0;
    for (const op of ["registerSyncDevice", "revokeSyncDevice", "putSyncBlob", "deleteSyncBlob"]) {
      const prefix = op + "|" + cloudUserId + "|";
      for (const key of Array.from(this.store.idempotencyRecords.keys())) {
        if (key.startsWith(prefix)) {
          this.store.idempotencyRecords.delete(key);
          counts.idempotency_receipts += 1;
        }
      }
    }
    for (const event of this.store.outboxEvents || []) {
      if (event?.payload_json?.cloud_user_id === cloudUserId && String(event.event_type || "").startsWith("sync.")) {
        event.payload_json = { redacted: true, purged_at: iso(nowMs) };
        event.delivered_at = event.delivered_at || iso(nowMs);
      }
    }
    return { ...counts, purged_at: iso(nowMs) };
  }
}

export const E2EE_SYNC_PURPOSE = E2EE_PURPOSE;
