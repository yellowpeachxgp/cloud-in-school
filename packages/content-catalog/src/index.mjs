import crypto from "node:crypto";
import { ContractError } from "../../contracts/src/index.mjs";
import {
  CONTENT_PACK_MAX_ARTIFACT_BYTES,
  CONTENT_PACK_VERSION_RE,
  DATAPACK_FORMAT,
  LEGACY_PLUGIN_FORMAT,
  validateContentPackArtifact,
  verifyContentPackArtifactSignature
} from "./artifact-validation.mjs";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SCHOOL_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const MAINTAINER_RE = /^[a-z0-9-]+:[^\s]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRE_RENAME_STAGES = new Set(["tmp_open", "tmp_write", "tmp_fsync", "tmp_close", "rename"]);
const DELETED_USER_TOMBSTONE = "00000000-0000-0000-0000-000000000000";
const RATE_WINDOW_MS = 60 * 60 * 1000;
const FORMATS = new Set(["dis-campus-plugin/v1", "dis-datapack/v1"]);
const KINDS = new Set(["school-profile", "campus-guide", "procedure-guide", "opportunity-catalog", "facility-catalog", "indoor-graph", "period-preset", "pharmacy-catalog"]);
const VERIFICATION_LEVELS = new Set(["UNVERIFIED", "SOURCE_CONFIRMED", "MOCK_TESTED", "DEVICE_TESTED", "SCHOOL_VERIFIED", "DISTRIBUTION_READY"]);
const SUBMISSION_STATUSES = new Set(["PENDING_REVIEW", "CHANGES_REQUESTED", "APPROVED", "REJECTED", "PUBLISHED"]);
const REVIEW_ACTIONS = new Set(["APPROVE", "REQUEST_CHANGES", "REJECT"]);
const RETIRE_REASONS = new Set(["INCORRECT_DATA", "OUTDATED", "SECURITY", "LICENSE", "MAINTAINER_REQUEST", "OTHER"]);
const CONTENT_PACK_IDEMPOTENCY_OPS = Object.freeze([
  "createContentPackSubmission",
  "reviewContentPackSubmission",
  "publishContentPackVersion",
  "retireContentPackVersion"
]);

function iso(nowMs) {
  return new Date(nowMs).toISOString();
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function badRequest(message) {
  return new ContractError("BAD_REQUEST", message);
}

function contentError(code, message, detail = undefined) {
  return new ContractError(code, message, detail);
}

function packInvalid(message, detail = undefined) {
  return contentError("CONTENT_PACK_INVALID", message, detail);
}

function submissionInvalid(message, detail = undefined) {
  return contentError("CONTENT_PACK_SUBMISSION_INVALID", message, detail);
}

function permissionDenied(message = "Caller lacks the required school-scoped content catalog authorization") {
  return contentError("CONTENT_PACK_PERMISSION_DENIED", message);
}

function requireString(value, field, { min = 1, max = Infinity, trim = true, error = badRequest } = {}) {
  if (typeof value !== "string") throw error(field + " must be a string");
  const clean = trim ? value.trim() : value;
  if (clean.length < min) throw error(field + " must not be empty");
  if (clean.length > max) throw error(field + " exceeds maximum length " + max);
  return clean;
}

function optionalString(value, field, { max = Infinity, error = badRequest } = {}) {
  if (value === undefined || value === null) return null;
  return requireString(value, field, { min: 0, max, error });
}

function requireUuid(value, field, error = badRequest) {
  const clean = requireString(value, field, { max: 64, error });
  if (!UUID_RE.test(clean)) throw error(field + " must be a UUID");
  return clean;
}

function requireNoUnknownFields(body, allowedFields, label, error = badRequest) {
  if (!isPlainObject(body)) throw error(label + " must be a JSON object");
  for (const key of Object.keys(body)) {
    if (!allowedFields.includes(key)) throw error(label + " contains unsupported field: " + key);
  }
}

function normalizeBearerHeaders(headers = {}) {
  return {
    idempotencyKey:
      headers["idempotency-key"] ||
      headers["Idempotency-Key"] ||
      headers["IDEMPOTENCY-KEY"] ||
      null
  };
}

function parseLimit(raw, fallback = 20) {
  if (raw == null || raw === "") return fallback;
  if (!/^\d+$/.test(String(raw))) throw badRequest("limit must be an integer");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) throw badRequest("limit must be between 1 and 100");
  return value;
}

function parseBooleanQuery(raw, field, defaultValue) {
  if (raw == null || raw === "") return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw badRequest(field + " must be a boolean");
}

function paginateRows(rows, { cursor, limit }, idForRow) {
  let start = 0;
  if (cursor) {
    const index = rows.findIndex((row) => idForRow(row) === cursor);
    if (index < 0) throw badRequest("cursor does not match the sorted result window");
    start = index + 1;
  }
  const page = rows.slice(start, start + limit);
  const nextCursor = start + limit < rows.length && page.length > 0 ? idForRow(page[page.length - 1]) : null;
  return { page, nextCursor };
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

function validCalendarDate(value) {
  if (!DATE_RE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function validateHttpsUrl(value, field, max = 2048) {
  const clean = requireString(value, field, { min: 8, max, error: submissionInvalid });
  const asciiUri = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/;
  const hex = "0123456789abcdefABCDEF";
  if (!asciiUri.test(clean)) throw submissionInvalid(field + " must be an RFC3986 HTTPS URI without raw spaces, controls, or non-ASCII characters");
  for (let index = 0; index < clean.length; index += 1) {
    if (clean[index] !== "%") continue;
    if (index + 2 >= clean.length || !hex.includes(clean[index + 1]) || !hex.includes(clean[index + 2])) {
      throw submissionInvalid(field + " contains an invalid percent escape");
    }
    index += 2;
  }
  let parsed;
  try {
    parsed = new URL(clean);
  } catch {
    throw submissionInvalid(field + " must be a valid public HTTPS URL");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
    throw submissionInvalid(field + " must be an HTTPS URL without embedded credentials");
  }
  return clean;
}

function containsPiiLikeSecret(text) {
  const value = String(text || "");
  return (
    /(?<!\d)1[3-9]\d{9}(?!\d)/.test(value) ||
    /(?<!\d)\d{17}[\dXx](?!\d)/.test(value) ||
    /(?<!\d)\d{8,12}(?!\d)/.test(value) ||
    /password|passwd|cookie|token|secret|私钥|密码|学号|身份证|手机号/gi.test(value)
  );
}

function assertPublicSafeText(value, field, error = submissionInvalid) {
  if (value != null && containsPiiLikeSecret(value)) {
    throw error(field + " must not contain student numbers, phone numbers, credentials, tokens, or other private data");
  }
}

function pseudonymousAlias(cloudUserId, schoolId, role = "contributor") {
  const animals = ["松鼠", "白鹭", "刺猬", "熊猫", "狐狸", "鹿", "獾", "燕子"];
  const digest = crypto.createHash("sha256").update("dis-content-pack-alias:v1:" + role + ":" + schoolId + ":" + cloudUserId).digest();
  return "内容包·" + animals[digest[0] % animals.length] + " " + String(digest.readUInt16BE(1) % 10000).padStart(4, "0");
}

function compareVersions(left, right) {
  const parse = (value) => {
    const [core, pre = null] = String(value).split("-", 2);
    return { core: core.split(".").map((part) => Number(part)), pre };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0;
}

function versionKey(packId, version) {
  return String(packId) + "@" + String(version);
}

function downloadPath(packId, version) {
  return "/api/v1/content-packs/" + encodeURIComponent(packId) + "/versions/" + encodeURIComponent(version) + "/download";
}

function pseudonymizeExactUserIdRefs(value, cloudUserId, tombstone = DELETED_USER_TOMBSTONE, counter = { count: 0 }) {
  if (typeof value === "string") {
    if (value === cloudUserId) {
      counter.count += 1;
      return tombstone;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => pseudonymizeExactUserIdRefs(entry, cloudUserId, tombstone, counter));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = pseudonymizeExactUserIdRefs(value[key], cloudUserId, tombstone, counter);
    return out;
  }
  return value;
}

export class ContentPackCatalogService {
  constructor(store, options = {}) {
    this.store = store;
    for (const field of ["contentPackSubmissions", "contentPackReviews", "contentPackVersions", "contentPackRateWindows"]) {
      if (!this.store[field]) this.store[field] = new Map();
    }
    this.trustedKeys = options.trustedKeys || options.contentPackTrustedKeys || {};
    this.legacyPublisherKeys = options.legacyPublisherKeys || options.contentPackLegacyPublisherKeys || {};
    this.submitRateLimitPerHour = Number.isInteger(options.submitRateLimitPerHour) ? options.submitRateLimitPerHour : 12;
    this.downloadRateLimitPerHour = Number.isInteger(options.downloadRateLimitPerHour) ? options.downloadRateLimitPerHour : 120;
  }

  _idempotency(operation, auth, headers, body, targetFingerprint = null) {
    const { idempotencyKey } = normalizeBearerHeaders(headers);
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
        throw new ContractError("STORAGE_PERSISTENCE_FAILED", "内容包提交未能持久化，请稍后按原 Idempotency-Key 重试；未产生半提交状态");
      }
      throw new ContractError("STORAGE_COMMIT_UNKNOWN", "内容包提交结果未知：快照可能已发布但核验失败。请携带原 Idempotency-Key 重试以对账，不要另起新键", {
        persist_stage: stage,
        durability: "UNKNOWN",
        retry_same_key: true
      });
    }
  }

  _consumeRateLimitInPlace(cloudUserId, kind, nowMs, undo) {
    const limit = kind === "SUBMIT" ? this.submitRateLimitPerHour : this.downloadRateLimitPerHour;
    const windowStart = Math.floor(nowMs / RATE_WINDOW_MS) * RATE_WINDOW_MS;
    const key = cloudUserId + ":" + kind + ":" + String(windowStart);
    let row = this.store.contentPackRateWindows.get(key);
    if (!row) {
      row = {
        cloud_user_id: cloudUserId,
        operation_kind: kind,
        window_started_at: iso(windowStart),
        window_started_ms: windowStart,
        request_count: 0
      };
      setMapCommitted(this.store.contentPackRateWindows, key, row, undo);
    }
    if (row.request_count >= limit) {
      throw contentError("CONTENT_PACK_RATE_LIMITED", "content pack " + kind.toLowerCase() + " rate limit reached", {
        operation_kind: kind,
        limit_per_hour: limit
      });
    }
    mutateObject(row, { request_count: row.request_count + 1 }, undo);
    for (const [oldKey, oldRow] of Array.from(this.store.contentPackRateWindows.entries())) {
      if (oldRow?.cloud_user_id === cloudUserId && Number(oldRow.window_started_ms || 0) < windowStart - 2 * RATE_WINDOW_MS) {
        deleteMapCommitted(this.store.contentPackRateWindows, oldKey, undo);
      }
    }
  }

  _countRateLimitAttempt(cloudUserId, kind, nowMs) {
    // Every non-idempotent submission/download attempt is counted before expensive
    // artifact parsing or byte serving. Validation failures therefore cannot be
    // used as an unbounded amplification oracle; the small rate row is durable
    // independently of the larger domain mutation.
    this._commitWithReceipt((undo) => {
      this._consumeRateLimitInPlace(cloudUserId, kind, nowMs, undo);
      return { status: 200, code: "CONTENT_PACK_RATE_COUNTED", data: null };
    }, null, nowMs);
  }

  _requireOperationsGrant(auth, schoolId, permission) {
    if (!this.store.hasOperationsSchoolScope?.(auth.cloudUserId, schoolId, permission)) {
      throw permissionDenied("Explicit operations school-scope grant " + permission + " is required for this content catalog operation");
    }
  }

  _validateProvenance(value) {
    if (!isPlainObject(value)) throw submissionInvalid("provenance must be an object");
    requireNoUnknownFields(value, ["sources", "verified_at", "review_by", "maintainers", "verification_level"], "provenance", submissionInvalid);
    for (const key of ["sources", "verified_at", "review_by", "maintainers", "verification_level"]) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) throw submissionInvalid("provenance." + key + " is required");
    }
    if (!Array.isArray(value.sources) || value.sources.length < 1) throw submissionInvalid("provenance.sources must be a non-empty array");
    const sources = value.sources.map((source, index) => {
      const label = "provenance.sources[" + index + "]";
      if (!isPlainObject(source)) throw submissionInvalid(label + " must be an object");
      requireNoUnknownFields(source, ["url", "title", "retrieved_at"], label, submissionInvalid);
      const url = validateHttpsUrl(source.url, label + ".url");
      const title = requireString(source.title, label + ".title", { min: 1, max: 200, error: submissionInvalid });
      const retrievedAt = requireString(source.retrieved_at, label + ".retrieved_at", { min: 10, max: 10, trim: false, error: submissionInvalid });
      if (!validCalendarDate(retrievedAt)) throw submissionInvalid(label + ".retrieved_at must be a valid date");
      return { url, title, retrieved_at: retrievedAt };
    });
    const verifiedAt = requireString(value.verified_at, "provenance.verified_at", { min: 10, max: 10, trim: false, error: submissionInvalid });
    const reviewBy = requireString(value.review_by, "provenance.review_by", { min: 10, max: 10, trim: false, error: submissionInvalid });
    if (!validCalendarDate(verifiedAt) || !validCalendarDate(reviewBy)) throw submissionInvalid("provenance dates must be valid RFC3339 full dates");
    if (reviewBy < verifiedAt) throw submissionInvalid("provenance.review_by must not be earlier than verified_at");
    if (!Array.isArray(value.maintainers) || value.maintainers.length < 1) throw submissionInvalid("provenance.maintainers must be a non-empty array");
    const maintainers = value.maintainers.map((item, index) => {
      const maintainer = requireString(item, "provenance.maintainers[" + index + "]", { min: 2, max: 120, trim: false, error: submissionInvalid });
      if (!MAINTAINER_RE.test(maintainer)) throw submissionInvalid("provenance.maintainers[" + index + "] must look like github:name");
      return maintainer;
    });
    if (new Set(maintainers).size !== maintainers.length) throw submissionInvalid("provenance.maintainers must not contain duplicates");
    if (!VERIFICATION_LEVELS.has(value.verification_level)) throw submissionInvalid("provenance.verification_level is unsupported");
    return {
      sources,
      verified_at: verifiedAt,
      review_by: reviewBy,
      maintainers,
      verification_level: value.verification_level
    };
  }

  _validateSubmissionCreate(body) {
    requireNoUnknownFields(body, [
      "artifact_format",
      "kind",
      "school_id",
      "pack_id",
      "version",
      "artifact_encoding",
      "artifact_sha256",
      "artifact_base64",
      "contribution_reference",
      "provenance",
      "submission_note"
    ], "content pack submission", submissionInvalid);
    const artifactFormat = requireString(body.artifact_format, "artifact_format", { error: submissionInvalid });
    const kind = requireString(body.kind, "kind", { error: submissionInvalid });
    if (!FORMATS.has(artifactFormat)) throw submissionInvalid("artifact_format is unsupported");
    if (!KINDS.has(kind)) throw submissionInvalid("kind is unsupported");
    const schoolId = requireString(body.school_id, "school_id", { min: 2, max: 64, error: submissionInvalid });
    if (!SCHOOL_ID_RE.test(schoolId)) throw submissionInvalid("school_id must be a dot-free lowercase school scope");
    const packId = requireString(body.pack_id, "pack_id", { min: 3, max: 128, error: submissionInvalid });
    if (!PACK_ID_RE.test(packId)) throw submissionInvalid("pack_id has an invalid shape");
    const version = requireString(body.version, "version", { error: submissionInvalid });
    if (!CONTENT_PACK_VERSION_RE.test(version)) throw submissionInvalid("version must be MAJOR.MINOR.PATCH[-prerelease]");
    if (body.artifact_encoding !== "base64") throw submissionInvalid("artifact_encoding must be base64");
    const declaredDigest = requireString(body.artifact_sha256, "artifact_sha256", { min: 64, max: 64, trim: false, error: submissionInvalid });
    if (!SHA256_RE.test(declaredDigest)) throw submissionInvalid("artifact_sha256 must be lowercase sha256 hex");
    const encoded = requireString(body.artifact_base64, "artifact_base64", { min: 16, max: 23_000_000, trim: false, error: submissionInvalid });
    if (!STRICT_BASE64_RE.test(encoded) || encoded.length % 4 !== 0) throw submissionInvalid("artifact_base64 is not strict canonical base64");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw submissionInvalid("artifact_base64 is not strict canonical base64");
    if (bytes.length < 1 || bytes.length > CONTENT_PACK_MAX_ARTIFACT_BYTES) {
      throw contentError("CONTENT_PACK_ARTIFACT_TOO_LARGE", "content package artifact exceeds the 16 MiB ceiling", {
        artifact_size_bytes: bytes.length,
        maximum: CONTENT_PACK_MAX_ARTIFACT_BYTES
      });
    }
    const actualDigest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actualDigest !== declaredDigest) throw submissionInvalid("artifact_sha256 does not match the exact artifact bytes");
    const contributionReference = validateHttpsUrl(body.contribution_reference, "contribution_reference");
    const provenance = this._validateProvenance(body.provenance);
    const submissionNote = optionalString(body.submission_note, "submission_note", { max: 2000, error: submissionInvalid });
    assertPublicSafeText(submissionNote, "submission_note", submissionInvalid);
    const validation = validateContentPackArtifact({
      artifactFormat,
      kind,
      schoolId,
      packId,
      version,
      artifactBytes: bytes,
      provenance
    });
    return {
      artifactFormat,
      kind,
      schoolId,
      packId,
      version,
      artifactBytes: bytes,
      artifactSha256: actualDigest,
      artifactSizeBytes: bytes.length,
      contributionReference,
      provenance,
      submissionNote,
      validation
    };
  }

  _reviewView(row, reviewerUserId, schoolId) {
    if (!row) return null;
    return {
      action: row.action,
      reviewer_alias: pseudonymousAlias(reviewerUserId, schoolId, "reviewer"),
      reviewed_at: row.reviewed_at,
      review_note: row.review_note ?? null
    };
  }

  _submissionView(row) {
    const review = this.store.contentPackReviews.get(row.submission_id) || null;
    return {
      submission_id: row.submission_id,
      status: row.status,
      artifact_format: row.artifact_format,
      kind: row.kind,
      school_id: row.school_id,
      pack_id: row.pack_id,
      version: row.version,
      artifact_sha256: row.artifact_sha256,
      artifact_size_bytes: row.artifact_size_bytes,
      contribution_reference: row.contribution_reference,
      provenance: clone(row.provenance),
      submission_note: row.submission_note ?? null,
      submitter_alias: pseudonymousAlias(row.submitter_cloud_user_id, row.school_id, "submitter"),
      created_at: row.created_at,
      updated_at: row.updated_at,
      review: this._reviewView(review, review?.reviewer_cloud_user_id, row.school_id)
    };
  }

  _versionView(row) {
    return {
      pack_id: row.pack_id,
      school_id: row.school_id,
      kind: row.kind,
      artifact_format: row.artifact_format,
      version: row.version,
      lifecycle_status: row.lifecycle_status,
      artifact_sha256: row.artifact_sha256,
      artifact_size_bytes: row.artifact_size_bytes,
      signature: clone(row.signature),
      verification_level: row.provenance.verification_level,
      verified_at: row.provenance.verified_at,
      review_by: row.provenance.review_by,
      sources: clone(row.provenance.sources),
      maintainers: clone(row.provenance.maintainers),
      published_at: row.published_at,
      published_by_alias: pseudonymousAlias(row.publisher_cloud_user_id, row.school_id, "publisher"),
      submission_id: row.submission_id,
      download_path: downloadPath(row.pack_id, row.version),
      min_host_api: row.min_host_api ?? null,
      min_app_version_code: row.min_app_version_code ?? null,
      release_note: row.release_note ?? null,
      retired_at: row.retired_at ?? null,
      retirement_reason: row.retirement_reason ?? null,
      retirement_detail: row.retirement_detail ?? null
    };
  }

  _versionsForPack(packId) {
    return Array.from(this.store.contentPackVersions.values())
      .filter((row) => row.pack_id === packId)
      .sort((a, b) => compareVersions(b.version, a.version) || a.published_at.localeCompare(b.published_at));
  }

  _summaryForPack(packId, versions) {
    const visible = [...versions].sort((a, b) => compareVersions(b.version, a.version));
    if (!visible.length) return null;
    const live = visible.find((row) => row.lifecycle_status === "PUBLISHED") || null;
    const basis = live || visible[0];
    const updatedMs = Math.max(...visible.map((row) => Date.parse(row.retired_at || row.published_at)));
    return {
      pack_id: packId,
      school_id: basis.school_id,
      kind: basis.kind,
      artifact_format: basis.artifact_format,
      title: basis.title || basis.pack_id,
      latest_version: live ? live.version : null,
      verification_level: basis.provenance.verification_level,
      review_by: basis.provenance.review_by,
      source_count: basis.provenance.sources.length,
      updated_at: new Date(updatedMs).toISOString()
    };
  }

  _validatePublishBody(body) {
    requireNoUnknownFields(body, ["submission_id", "signature", "release_note"], "content pack publish request");
    const submissionId = requireUuid(body.submission_id, "submission_id");
    if (!isPlainObject(body.signature)) throw contentError("CONTENT_PACK_SIGNATURE_INVALID", "signature must be an object");
    const releaseNote = optionalString(body.release_note, "release_note", { max: 1000 });
    assertPublicSafeText(releaseNote, "release_note", badRequest);
    return { submissionId, signature: clone(body.signature), releaseNote };
  }

  _keysForValidation(validation) {
    if (validation?.format === LEGACY_PLUGIN_FORMAT) {
      const publisher = validation.legacy?.manifest?.publisher;
      const configuredPublishers = Object.keys(this.legacyPublisherKeys || {});
      if (configuredPublishers.length > 0) {
        const publisherKeys = publisher ? this.legacyPublisherKeys?.[publisher] : null;
        if (!publisherKeys) {
          throw contentError("CONTENT_PACK_SIGNATURE_INVALID", "legacy package publisher is not present in the pinned publisher trust root", {
            reason: "UNTRUSTED_PUBLISHER"
          });
        }
        return publisherKeys;
      }
    }
    return this.trustedKeys;
  }

  listContentPacks(auth, query) {
    const schoolId = requireString(query.get("school_id"), "school_id", { min: 2, max: 64 });
    if (!SCHOOL_ID_RE.test(schoolId)) throw badRequest("school_id must be a dot-free lowercase school scope");
    const kind = query.get("kind");
    const artifactFormat = query.get("artifact_format");
    if (kind != null && kind !== "" && !KINDS.has(kind)) throw badRequest("kind is unsupported");
    if (artifactFormat != null && artifactFormat !== "" && !FORMATS.has(artifactFormat)) throw badRequest("artifact_format is unsupported");
    const includeRetired = parseBooleanQuery(query.get("include_retired"), "include_retired", false);
    const limit = parseLimit(query.get("limit"));
    const rowsByPack = new Map();
    for (const row of this.store.contentPackVersions.values()) {
      if (row.school_id !== schoolId) continue;
      if (kind && kind !== "" && row.kind !== kind) continue;
      if (artifactFormat && artifactFormat !== "" && row.artifact_format !== artifactFormat) continue;
      if (!rowsByPack.has(row.pack_id)) rowsByPack.set(row.pack_id, []);
      rowsByPack.get(row.pack_id).push(row);
    }
    const summaries = [];
    for (const [packId, versions] of rowsByPack) {
      const summary = this._summaryForPack(packId, versions);
      if (!summary) continue;
      if (!includeRetired && summary.latest_version === null) continue;
      summaries.push(summary);
    }
    summaries.sort((a, b) => a.pack_id.localeCompare(b.pack_id));
    const { page, nextCursor } = paginateRows(summaries, { cursor: query.get("cursor"), limit }, (row) => row.pack_id);
    return {
      status: 200,
      code: "CONTENT_PACKS_LISTED",
      data: page,
      nextCursor
    };
  }

  _requirePackRows(packId) {
    const cleanPackId = requireString(packId, "packId", { min: 3, max: 128 });
    if (!PACK_ID_RE.test(cleanPackId)) throw badRequest("packId has an invalid shape");
    const rows = this._versionsForPack(cleanPackId);
    if (!rows.length) throw contentError("CONTENT_PACK_NOT_FOUND", "content pack does not exist or is not visible");
    return { packId: cleanPackId, rows };
  }

  listContentPackVersions(auth, params, query) {
    const { packId, rows } = this._requirePackRows(params.packId);
    const includeRetired = parseBooleanQuery(query.get("include_retired"), "include_retired", true);
    const limit = parseLimit(query.get("limit"));
    const visible = rows.filter((row) => includeRetired || row.lifecycle_status === "PUBLISHED");
    const { page, nextCursor } = paginateRows(visible, { cursor: query.get("cursor"), limit }, (row) => row.version);
    return {
      status: 200,
      code: "CONTENT_PACK_VERSIONS_LISTED",
      data: {
        pack: this._summaryForPack(packId, rows),
        versions: page.map((row) => this._versionView(row))
      },
      nextCursor
    };
  }

  _versionRowOrThrow(packId, version) {
    const { packId: cleanPackId, rows } = this._requirePackRows(packId);
    const cleanVersion = requireString(version, "version", { max: 64 });
    if (!CONTENT_PACK_VERSION_RE.test(cleanVersion)) throw badRequest("version must be MAJOR.MINOR.PATCH[-prerelease]");
    const row = rows.find((item) => item.version === cleanVersion);
    if (!row) throw contentError("CONTENT_PACK_VERSION_NOT_FOUND", "content pack version does not exist or is not visible");
    return row;
  }

  getContentPackVersion(auth, params) {
    const row = this._versionRowOrThrow(params.packId, params.version);
    return {
      status: 200,
      code: "CONTENT_PACK_VERSION_OK",
      data: this._versionView(row)
    };
  }

  downloadContentPackArtifact(auth, params, nowMs = Date.now()) {
    this._countRateLimitAttempt(auth.cloudUserId, "DOWNLOAD", nowMs);
    const row = this._versionRowOrThrow(params.packId, params.version);
    if (row.lifecycle_status === "RETIRED") {
      throw contentError("CONTENT_PACK_VERSION_RETIRED", "content pack version has been retired; new downloads are refused");
    }
    const artifact = this.store.readContentPackArtifactVerified(row.artifact_sha256, row.artifact_size_bytes);
    return {
      status: 200,
      code: "CONTENT_PACK_ARTIFACT_DOWNLOADED",
      data: this._versionView(row),
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        "x-content-pack-artifact-sha256": row.artifact_sha256,
        "x-content-pack-format": row.artifact_format,
        "x-content-pack-version": row.version
      },
      rawBody: artifact
    };
  }

  createContentPackSubmission(auth, body, headers, nowMs = Date.now()) {
    const { replay, receipt } = this._idempotency("createContentPackSubmission", auth, headers, body);
    if (replay) return replay;
    this._countRateLimitAttempt(auth.cloudUserId, "SUBMIT", nowMs);
    const prepared = this._validateSubmissionCreate(body);
    return this._commitWithReceipt((undo) => {
      this.store.writeContentPackArtifactDurable(prepared.artifactSha256, prepared.artifactBytes);
      const ts = iso(nowMs);
      const submissionId = crypto.randomUUID();
      const row = {
        submission_id: submissionId,
        status: "PENDING_REVIEW",
        artifact_format: prepared.artifactFormat,
        kind: prepared.kind,
        school_id: prepared.schoolId,
        pack_id: prepared.packId,
        version: prepared.version,
        artifact_sha256: prepared.artifactSha256,
        artifact_size_bytes: prepared.artifactSizeBytes,
        contribution_reference: prepared.contributionReference,
        provenance: clone(prepared.provenance),
        submission_note: prepared.submissionNote,
        submitter_cloud_user_id: auth.cloudUserId,
        title: prepared.validation.title,
        min_host_api: prepared.validation.minHostApi,
        min_app_version_code: prepared.validation.minAppVersionCode,
        created_at: ts,
        updated_at: ts
      };
      setMapCommitted(this.store.contentPackSubmissions, submissionId, row, undo);
      pushArrayCommitted(this.store.auditEvents, {
        id: crypto.randomUUID(),
        actor_kind: "USER",
        actor_ref: auth.cloudUserId,
        action: "content_pack_submission.create",
        resource_kind: "content_pack_submission",
        resource_ref: submissionId,
        outcome: "SUCCESS",
        detail: { school_id: row.school_id, pack_id: row.pack_id, version: row.version, artifact_sha256: row.artifact_sha256 },
        created_at: ts
      }, undo);
      return {
        status: 201,
        code: "CONTENT_PACK_SUBMISSION_CREATED",
        data: this._submissionView(row)
      };
    }, receipt, nowMs);
  }

  getContentPackSubmission(auth, params) {
    const submissionId = requireUuid(params.submissionId, "submissionId");
    const row = this.store.contentPackSubmissions.get(submissionId);
    if (!row || row.submitter_cloud_user_id !== auth.cloudUserId) {
      throw contentError("CONTENT_PACK_SUBMISSION_NOT_FOUND", "content pack submission does not exist or is not visible to the caller");
    }
    return {
      status: 200,
      code: "CONTENT_PACK_SUBMISSION_OK",
      data: this._submissionView(row)
    };
  }

  listContentPackSubmissionReviews(auth, query) {
    const schoolId = requireString(query.get("school_id"), "school_id", { min: 2, max: 64 });
    if (!SCHOOL_ID_RE.test(schoolId)) throw badRequest("school_id must be a dot-free lowercase school scope");
    this._requireOperationsGrant(auth, schoolId, "content_pack.review");
    const status = query.get("status");
    const kind = query.get("kind");
    if (status != null && status !== "" && !SUBMISSION_STATUSES.has(status)) throw badRequest("status is unsupported");
    if (kind != null && kind !== "" && !KINDS.has(kind)) throw badRequest("kind is unsupported");
    const limit = parseLimit(query.get("limit"));
    const rows = Array.from(this.store.contentPackSubmissions.values())
      .filter((row) => row.school_id === schoolId)
      .filter((row) => !status || status === "" || row.status === status)
      .filter((row) => !kind || kind === "" || row.kind === kind)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.submission_id.localeCompare(a.submission_id));
    const { page, nextCursor } = paginateRows(rows, { cursor: query.get("cursor"), limit }, (row) => row.submission_id);
    return {
      status: 200,
      code: "CONTENT_PACK_SUBMISSIONS_LISTED",
      data: page.map((row) => this._submissionView(row)),
      nextCursor
    };
  }

  reviewContentPackSubmission(auth, params, body, headers, nowMs = Date.now()) {
    const submissionId = requireUuid(params.submissionId, "submissionId");
    const { replay, receipt } = this._idempotency("reviewContentPackSubmission", auth, headers, body, { submission_id: submissionId });
    if (replay) return replay;
    requireNoUnknownFields(body, ["action", "review_note"], "content pack review request");
    const action = requireString(body.action, "action");
    if (!REVIEW_ACTIONS.has(action)) throw badRequest("action is unsupported");
    const reviewNote = optionalString(body.review_note, "review_note", { max: 2000 });
    assertPublicSafeText(reviewNote, "review_note", badRequest);
    if ((action === "REQUEST_CHANGES" || action === "REJECT") && !reviewNote) {
      throw badRequest("review_note is required when action is REQUEST_CHANGES or REJECT");
    }
    const submission = this.store.contentPackSubmissions.get(submissionId);
    if (!submission) throw contentError("CONTENT_PACK_SUBMISSION_NOT_FOUND", "content pack submission does not exist");
    this._requireOperationsGrant(auth, submission.school_id, "content_pack.review");
    if (submission.submitter_cloud_user_id === auth.cloudUserId) {
      throw contentError("CONTENT_PACK_SUBMITTER_CANNOT_REVIEW", "submitter and reviewer principals must differ; self-review is forbidden");
    }
    if (submission.status !== "PENDING_REVIEW" || this.store.contentPackReviews.has(submissionId)) {
      throw contentError("CONTENT_PACK_REVIEW_INVALID", "content pack submission is already terminal and cannot be reviewed again");
    }
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const review = {
        review_id: crypto.randomUUID(),
        submission_id: submissionId,
        action,
        reviewer_cloud_user_id: auth.cloudUserId,
        review_note: reviewNote,
        reviewed_at: ts
      };
      setMapCommitted(this.store.contentPackReviews, submissionId, review, undo);
      mutateObject(submission, {
        status: action === "APPROVE" ? "APPROVED" : action === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "REJECTED",
        updated_at: ts
      }, undo);
      pushArrayCommitted(this.store.auditEvents, {
        id: crypto.randomUUID(),
        actor_kind: "USER",
        actor_ref: auth.cloudUserId,
        action: "content_pack_submission.review",
        resource_kind: "content_pack_submission",
        resource_ref: submissionId,
        outcome: "SUCCESS",
        detail: { action, school_id: submission.school_id, pack_id: submission.pack_id, version: submission.version },
        created_at: ts
      }, undo);
      return {
        status: 200,
        code: "CONTENT_PACK_SUBMISSION_REVIEWED",
        data: this._submissionView(submission)
      };
    }, receipt, nowMs);
  }

  publishContentPackVersion(auth, body, headers, nowMs = Date.now()) {
    const { replay, receipt } = this._idempotency("publishContentPackVersion", auth, headers, body);
    if (replay) return replay;
    const prepared = this._validatePublishBody(body);
    const submission = this.store.contentPackSubmissions.get(prepared.submissionId);
    if (!submission) throw contentError("CONTENT_PACK_SUBMISSION_NOT_FOUND", "content pack submission does not exist");
    this._requireOperationsGrant(auth, submission.school_id, "content_pack.publish");
    if (submission.status !== "APPROVED") {
      throw contentError("CONTENT_PACK_REVIEW_REQUIRED", "only an APPROVED submission can be published exactly once");
    }
    const artifact = this.store.readContentPackArtifactVerified(submission.artifact_sha256, submission.artifact_size_bytes);
    const provenance = this._validateProvenance(submission.provenance);
    const validation = validateContentPackArtifact({
      artifactFormat: submission.artifact_format,
      kind: submission.kind,
      schoolId: submission.school_id,
      packId: submission.pack_id,
      version: submission.version,
      artifactBytes: artifact,
      provenance
    });
    const signatureVerification = verifyContentPackArtifactSignature({
      artifactFormat: submission.artifact_format,
      artifactBytes: artifact,
      signature: prepared.signature,
      trustedKeys: this._keysForValidation(validation),
      legacyValidation: validation.legacy || null
    });
    const key = versionKey(submission.pack_id, submission.version);
    if (this.store.contentPackVersions.has(key)) {
      throw contentError("CONTENT_PACK_VERSION_CONFLICT", "immutable pack_id/version already exists; publish a new version instead of rewriting history");
    }
    const existingVersions = this._versionsForPack(submission.pack_id);
    if (existingVersions.some((row) => row.school_id !== submission.school_id || row.kind !== submission.kind || row.artifact_format !== submission.artifact_format)) {
      throw contentError("CONTENT_PACK_VERSION_CONFLICT", "pack_id namespace is immutable across school, kind, and artifact format");
    }
    if (existingVersions.length && compareVersions(submission.version, existingVersions[0].version) <= 0) {
      throw contentError("CONTENT_PACK_VERSION_CONFLICT", "content pack versions must be published in strictly increasing MAJOR.MINOR.PATCH order");
    }
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const auditId = crypto.randomUUID();
      const row = {
        pack_id: submission.pack_id,
        school_id: submission.school_id,
        kind: submission.kind,
        artifact_format: submission.artifact_format,
        version: submission.version,
        lifecycle_status: "PUBLISHED",
        artifact_sha256: submission.artifact_sha256,
        artifact_size_bytes: submission.artifact_size_bytes,
        signature: clone(prepared.signature),
        provenance: clone(submission.provenance),
        title: validation.title,
        min_host_api: validation.minHostApi,
        min_app_version_code: validation.minAppVersionCode,
        release_note: prepared.releaseNote,
        submission_id: submission.submission_id,
        publisher_cloud_user_id: auth.cloudUserId,
        published_at: ts,
        retired_at: null,
        retirement_reason: null,
        retirement_detail: null,
        retired_by_cloud_user_id: null
      };
      setMapCommitted(this.store.contentPackVersions, key, row, undo);
      mutateObject(submission, { status: "PUBLISHED", updated_at: ts }, undo);
      pushArrayCommitted(this.store.auditEvents, {
        id: auditId,
        actor_kind: "USER",
        actor_ref: auth.cloudUserId,
        action: "content_pack_version.publish",
        resource_kind: "content_pack_version",
        resource_ref: key,
        outcome: "SUCCESS",
        detail: {
          school_id: row.school_id,
          pack_id: row.pack_id,
          version: row.version,
          artifact_sha256: row.artifact_sha256,
          signature_payload_sha256: signatureVerification.payloadSha256,
          public_key_fingerprint: signatureVerification.publicKeyFingerprint
        },
        created_at: ts
      }, undo);
      const eventId = crypto.randomUUID();
      const payload = {
        event_id: eventId,
        event_key: "dis:content-pack:submission:" + submission.submission_id + ":published:v1",
        event_type: "published",
        occurred_at: ts,
        school_id: row.school_id,
        pack_id: row.pack_id,
        version: row.version,
        kind: row.kind,
        artifact_format: row.artifact_format,
        artifact_sha256: row.artifact_sha256,
        artifact_size_bytes: row.artifact_size_bytes,
        signature_scheme: row.signature.scheme,
        public_key_fingerprint: row.signature.public_key_fingerprint,
        verification_level: row.provenance.verification_level,
        verified_at: row.provenance.verified_at,
        review_by: row.provenance.review_by,
        source_count: row.provenance.sources.length,
        submission_id: row.submission_id,
        published_by_alias: pseudonymousAlias(row.publisher_cloud_user_id, row.school_id, "publisher"),
        audit_event_id: auditId,
        download_path: downloadPath(row.pack_id, row.version)
      };
      pushArrayCommitted(this.store.outboxEvents, {
        id: eventId,
        aggregate_type: "content_pack_submission",
        aggregate_id: submission.submission_id,
        event_type: "content-pack.published",
        payload_json: payload,
        created_at: ts,
        delivered_at: null
      }, undo);
      return {
        status: 201,
        code: "CONTENT_PACK_VERSION_PUBLISHED",
        data: this._versionView(row)
      };
    }, receipt, nowMs);
  }

  retireContentPackVersion(auth, params, body, headers, nowMs = Date.now()) {
    const cleanPackId = requireString(params.packId, "packId", { min: 3, max: 128 });
    const cleanVersion = requireString(params.version, "version", { max: 64 });
    if (!PACK_ID_RE.test(cleanPackId) || !CONTENT_PACK_VERSION_RE.test(cleanVersion)) throw badRequest("packId or version has an invalid shape");
    const { replay, receipt } = this._idempotency("retireContentPackVersion", auth, headers, body, { pack_id: cleanPackId, version: cleanVersion });
    if (replay) return replay;
    requireNoUnknownFields(body, ["reason", "detail"], "content pack retire request");
    const reason = requireString(body.reason, "reason");
    if (!RETIRE_REASONS.has(reason)) throw badRequest("reason is unsupported");
    const detail = optionalString(body.detail, "detail", { max: 1000 });
    assertPublicSafeText(detail, "detail", badRequest);
    if (reason === "OTHER" && !detail) throw badRequest("detail is required when reason=OTHER");
    const key = versionKey(cleanPackId, cleanVersion);
    const row = this.store.contentPackVersions.get(key);
    if (!row) {
      const packExists = this._versionsForPack(cleanPackId).length > 0;
      if (!packExists) throw contentError("CONTENT_PACK_NOT_FOUND", "content pack does not exist or is not visible");
      throw contentError("CONTENT_PACK_VERSION_NOT_FOUND", "content pack version does not exist or is not visible");
    }
    this._requireOperationsGrant(auth, row.school_id, "content_pack.retire");
    if (row.lifecycle_status === "RETIRED") {
      throw new ContractError("CONFLICT", "content pack version is already retired");
    }
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      mutateObject(row, {
        lifecycle_status: "RETIRED",
        retired_at: ts,
        retirement_reason: reason,
        retirement_detail: detail,
        retired_by_cloud_user_id: auth.cloudUserId
      }, undo);
      pushArrayCommitted(this.store.auditEvents, {
        id: crypto.randomUUID(),
        actor_kind: "USER",
        actor_ref: auth.cloudUserId,
        action: "content_pack_version.retire",
        resource_kind: "content_pack_version",
        resource_ref: key,
        outcome: "SUCCESS",
        detail: { school_id: row.school_id, pack_id: row.pack_id, version: row.version, reason },
        created_at: ts
      }, undo);
      return {
        status: 200,
        code: "CONTENT_PACK_VERSION_RETIRED",
        data: this._versionView(row)
      };
    }, receipt, nowMs);
  }

  exportUserData(cloudUserId) {
    return {
      content_pack_submissions: clone(Array.from(this.store.contentPackSubmissions.values())
        .filter((row) => row.submitter_cloud_user_id === cloudUserId)
        .map((row) => this._submissionView(row))),
      content_pack_reviews: clone(Array.from(this.store.contentPackReviews.values())
        .filter((row) => row.reviewer_cloud_user_id === cloudUserId)),
      content_pack_versions: clone(Array.from(this.store.contentPackVersions.values())
        .filter((row) => row.publisher_cloud_user_id === cloudUserId || row.retired_by_cloud_user_id === cloudUserId)
        .map((row) => this._versionView(row)))
    };
  }

  purgeUserContentPackData(cloudUserId, nowMs = Date.now()) {
    let unpublishedSubmissionsDeleted = 0;
    let publishedSubmissionsPseudonymized = 0;
    let reviewsDetached = 0;
    let versionsDetached = 0;
    let operationsGrantsDeleted = 0;
    let rateRowsDeleted = 0;
    let receiptsDeleted = 0;
    let receiptsPseudonymized = 0;
    const tombstone = DELETED_USER_TOMBSTONE;
    for (const row of Array.from(this.store.contentPackSubmissions.values())) {
      if (row.submitter_cloud_user_id !== cloudUserId) continue;
      if (row.status !== "PUBLISHED") {
        this.store.contentPackSubmissions.delete(row.submission_id);
        this.store.contentPackReviews.delete(row.submission_id);
        unpublishedSubmissionsDeleted += 1;
      } else {
        row.submitter_cloud_user_id = tombstone;
        row.submission_note = null;
        publishedSubmissionsPseudonymized += 1;
      }
    }
    for (const review of this.store.contentPackReviews.values()) {
      if (review.reviewer_cloud_user_id === cloudUserId) {
        review.reviewer_cloud_user_id = tombstone;
        review.review_note = null;
        reviewsDetached += 1;
      }
    }
    for (const version of this.store.contentPackVersions.values()) {
      let touched = false;
      if (version.publisher_cloud_user_id === cloudUserId) {
        version.publisher_cloud_user_id = tombstone;
        touched = true;
      }
      if (version.retired_by_cloud_user_id === cloudUserId) {
        version.retired_by_cloud_user_id = tombstone;
        touched = true;
      }
      if (touched) versionsDetached += 1;
    }
    if (this.store.operationsSchoolGrants instanceof Map) {
      for (const grant of Array.from(this.store.operationsSchoolGrants.values())) {
        if (grant.cloud_user_id === cloudUserId && String(grant.permission || "").startsWith("content_pack.")) {
          this.store.operationsSchoolGrants.delete(grant.id);
          operationsGrantsDeleted += 1;
        }
      }
    }
    for (const [key, row] of Array.from(this.store.contentPackRateWindows.entries())) {
      if (row?.cloud_user_id === cloudUserId) {
        this.store.contentPackRateWindows.delete(key);
        rateRowsDeleted += 1;
      }
    }
    if (this.store.idempotencyRecords instanceof Map) {
      const ownPrefixes = CONTENT_PACK_IDEMPOTENCY_OPS.map((op) => op + "|" + cloudUserId + "|");
      const domainPrefixes = CONTENT_PACK_IDEMPOTENCY_OPS.map((op) => op + "|");
      for (const [key, record] of Array.from(this.store.idempotencyRecords.entries())) {
        if (ownPrefixes.some((prefix) => key.startsWith(prefix))) {
          this.store.idempotencyRecords.delete(key);
          receiptsDeleted += 1;
          continue;
        }
        if (!domainPrefixes.some((prefix) => key.startsWith(prefix)) || !record || typeof record !== "object") continue;
        const counter = { count: 0 };
        if (record.data !== undefined) record.data = pseudonymizeExactUserIdRefs(record.data, cloudUserId, tombstone, counter);
        if (record.headers !== undefined) record.headers = pseudonymizeExactUserIdRefs(record.headers, cloudUserId, tombstone, counter);
        if (counter.count > 0) receiptsPseudonymized += 1;
      }
    }
    for (const event of this.store.auditEvents || []) {
      if (event?.actor_ref === cloudUserId && String(event.resource_kind || "").startsWith("content_pack")) {
        event.actor_ref = tombstone;
      }
    }
    this.store._rebuildIndexes?.();
    return {
      unpublished_submissions_deleted: unpublishedSubmissionsDeleted,
      published_submissions_pseudonymized: publishedSubmissionsPseudonymized,
      reviews_detached: reviewsDetached,
      versions_detached: versionsDetached,
      operations_grants_deleted: operationsGrantsDeleted,
      rate_rows_deleted: rateRowsDeleted,
      idempotency_receipts_deleted: receiptsDeleted,
      idempotency_receipts_pseudonymized: receiptsPseudonymized,
      purged_at: iso(nowMs)
    };
  }
}

export const CONTENT_PACK_DELETED_USER_TOMBSTONE = DELETED_USER_TOMBSTONE;
