import crypto from "node:crypto";
import { ContractError } from "../../contracts/src/index.mjs";

const PLACE_TYPES = new Set(["campus", "building", "floor", "room", "facility", "entrance", "indoor_node"]);
const METRICS = new Set(["ACCESS", "OPERATION", "OCCUPANCY", "SAFETY"]);
const METRIC_TTL_SECONDS = Object.freeze({
  OCCUPANCY: 1800,
  SAFETY: 3600,
  ACCESS: 7200,
  OPERATION: 86400
});
const STATES_BY_METRIC = Object.freeze({
  ACCESS: new Set(["OPEN", "CLOSED", "RESTRICTED"]),
  OPERATION: new Set(["WORKING", "DEGRADED", "OUT_OF_SERVICE"]),
  OCCUPANCY: new Set(["QUIET", "MODERATE", "CROWDED", "FULL"]),
  SAFETY: new Set(["SAFE", "HAZARD"])
});
const REPORT_KINDS = new Set(["OBSERVATION", "CORRECTION"]);
const FLAG_REASONS = new Set(["INCORRECT", "STALE", "ABUSE", "PII", "SPAM", "OTHER"]);
const FLAG_STATUSES = new Set(["OPEN", "RESOLVED_KEEP_VISIBLE", "RESOLVED_EXCLUDED", "REJECTED"]);
const REVIEW_ACTIONS = new Set(["KEEP_VISIBLE", "EXCLUDE_INCORRECT", "EXCLUDE_ABUSE", "REJECT_FLAG"]);
const SUBSCRIPTION_STATUSES = new Set(["ACTIVE", "CANCELLED"]);
const TARGET_TYPES = new Set(["PLACE", "AREA"]);
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PLACE_REF_RE = /^[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/(campus|building|floor|room|facility|entrance|indoor_node)\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PRE_RENAME_STAGES = new Set(["tmp_open", "tmp_write", "tmp_fsync", "tmp_close", "rename"]);
const DELETED_USER_TOMBSTONE = "00000000-0000-0000-0000-000000000000";
const REPORT_RATE_LIMIT_PER_HOUR = 30;
const FLAG_RATE_LIMIT_PER_HOUR = 20;

export const PLACE_STATUS_AGGREGATION_ALGORITHM = "LATEST_PER_REPORTER_ANY_DIVERGENCE_CONTESTED_V1";
export const PLACE_STATUS_DELETED_USER_TOMBSTONE = DELETED_USER_TOMBSTONE;

const PLACE_STATUS_IDEMPOTENCY_OPS = Object.freeze([
  "createPlaceStatusReport",
  "createPlaceStatusSubscription",
  "deletePlaceStatusSubscription",
  "flagPlaceStatusReport",
  "reviewPlaceReportFlag"
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

function placeInvalid(message) {
  return new ContractError("PLACE_STATUS_REPORT_INVALID", message);
}

function subscriptionInvalid(message) {
  return new ContractError("PLACE_STATUS_SUBSCRIPTION_INVALID", message);
}

function flagInvalid(message) {
  return new ContractError("PLACE_REPORT_FLAG_INVALID", message);
}

function requireString(value, field, { min = 1, max = Infinity, trim = true, error = badRequest } = {}) {
  if (typeof value !== "string") throw error(field + " must be a string");
  const clean = trim ? value.trim() : value;
  if (clean.length < min) throw error(field + " must not be empty");
  if (clean.length > max) throw error(field + " exceeds maximum length " + max);
  return clean;
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

function parseDateTimeMs(value, field, error = badRequest) {
  if (typeof value !== "string" || !DATE_TIME_RE.test(value)) {
    throw error(field + " must be an RFC3339 date-time string with an explicit timezone");
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw error(field + " must be a valid date-time");
  return ms;
}

function parseBooleanQuery(raw, field, defaultValue) {
  if (raw == null || raw === "") return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw badRequest(field + " must be a boolean");
}

function parseLimit(raw, fallback = 20) {
  if (raw == null || raw === "") return fallback;
  if (!/^\d+$/.test(String(raw))) throw badRequest("limit must be an integer");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) throw badRequest("limit must be between 1 and 100");
  return value;
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

function pseudonymFor(cloudUserId, schoolId) {
  const animals = ["松鼠", "白鹭", "刺猬", "熊猫", "狐狸", "鹿", "獾", "燕子"];
  const digest = crypto
    .createHash("sha256")
    .update("dis-place-status-alias:v1:" + schoolId + ":" + cloudUserId)
    .digest();
  const animal = animals[digest[0] % animals.length];
  const serial = String(digest.readUInt16BE(1) % 10000).padStart(4, "0");
  return "校园·" + animal + " " + serial;
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

function assertNoPii(text, field, error) {
  if (text != null && containsPiiLikeSecret(text)) {
    throw error(field + " must not contain student numbers, phone numbers, ID numbers, passwords, tokens, or other PII");
  }
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

function pushArrayCommitted(array, value, undo) {
  array.push(value);
  undo.push(() => {
    const index = array.lastIndexOf(value);
    if (index >= 0) array.splice(index, 1);
  });
}

function paginateRows(rows, { cursor, limit }, idForRow) {
  let start = 0;
  if (cursor) {
    const idx = rows.findIndex((row) => idForRow(row) === cursor);
    if (idx < 0) throw badRequest("cursor does not match the sorted result window");
    start = idx + 1;
  }
  const page = rows.slice(start, start + limit);
  const nextCursor = start + limit < rows.length && page.length > 0 ? idForRow(page[page.length - 1]) : null;
  return { page, nextCursor };
}

function parsePlaceRef(value, errorCode = "PLACE_REF_INVALID") {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!PLACE_REF_RE.test(clean)) {
    throw new ContractError(errorCode, "Place reference must be a valid <schoolId>/<campusId>/<type>/<slug> Campus Graph id");
  }
  const [school_id, campus_id, place_type, slug] = clean.split("/");
  return { place_ref: clean, school_id, campus_id, place_type, slug };
}

function requireUniqueEnumList(raw, allowed, field, error = badRequest) {
  if (raw == null || raw === "") return null;
  const values = String(raw).split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw error(field + " must not be empty");
  if (new Set(values).size !== values.length) throw error(field + " must not contain duplicates");
  for (const value of values) {
    if (!allowed.has(value)) throw error(field + " contains unsupported value: " + value);
  }
  return values;
}

function validateMetricArray(value, error = subscriptionInvalid) {
  if (!Array.isArray(value) || value.length === 0) throw error("metrics must be a non-empty array");
  if (new Set(value).size !== value.length) throw error("metrics must not contain duplicates");
  for (const metric of value) {
    if (!METRICS.has(metric)) throw error("metrics contains unsupported value: " + String(metric));
  }
  return [...value];
}

function parseBboxText(raw, error = badRequest) {
  if (typeof raw !== "string" || raw.length > 120) throw error("bbox must be minLat,minLng,maxLat,maxLng");
  const parts = raw.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw error("bbox must contain four finite numbers");
  }
  const [min_latitude, min_longitude, max_latitude, max_longitude] = parts;
  return validateBbox({ min_latitude, min_longitude, max_latitude, max_longitude }, error);
}

function validateBbox(value, error = subscriptionInvalid) {
  if (!isPlainObject(value)) throw error("bbox must be an object");
  const allowed = ["min_latitude", "min_longitude", "max_latitude", "max_longitude"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw error("bbox contains unsupported field: " + key);
  }
  const bbox = {};
  for (const key of allowed) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) throw error("bbox." + key + " must be finite");
    bbox[key] = value[key];
  }
  if (bbox.min_latitude < -90 || bbox.max_latitude > 90 || bbox.min_latitude >= bbox.max_latitude) {
    throw error("bbox latitude must be within [-90,90] and min strictly below max");
  }
  if (bbox.min_longitude < -180 || bbox.max_longitude > 180 || bbox.min_longitude >= bbox.max_longitude) {
    throw error("bbox longitude must be within [-180,180] and min strictly below max");
  }
  return bbox;
}

function bboxContains(bbox, place) {
  return (
    typeof place?.latitude === "number" &&
    typeof place?.longitude === "number" &&
    place.latitude >= bbox.min_latitude &&
    place.latitude <= bbox.max_latitude &&
    place.longitude >= bbox.min_longitude &&
    place.longitude <= bbox.max_longitude
  );
}

function pseudonymizeUserIdRefs(value, cloudUserId, tombstone, counter) {
  if (typeof value === "string") {
    if (value === cloudUserId) {
      counter.count += 1;
      return tombstone;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => pseudonymizeUserIdRefs(entry, cloudUserId, tombstone, counter));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = pseudonymizeUserIdRefs(value[key], cloudUserId, tombstone, counter);
    }
    return out;
  }
  return value;
}

function redactFlagDetailRefs(value, erasedFlagIds, counter) {
  if (Array.isArray(value)) return value.map((entry) => redactFlagDetailRefs(entry, erasedFlagIds, counter));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = redactFlagDetailRefs(value[key], erasedFlagIds, counter);
    }
    if (
      typeof value.flag_id === "string" &&
      erasedFlagIds.has(value.flag_id) &&
      Object.hasOwn(value, "detail") &&
      value.detail !== null
    ) {
      out.detail = null;
      counter.count += 1;
    }
    return out;
  }
  return value;
}

export function createDefaultCampusGraphPlaces() {
  // Bootstrap compatibility snapshot. The coordinates are coarse building-level
  // anchors derived from the already shipped HAUT campus seed data; rows stay
  // explicitly UNVERIFIED and are not an official Campus Graph publication.
  const rows = [
    ["haut/lianhuajie/campus/lianhuajie", 34.8305, 113.5435],
    ["haut/lianhuajie/building/5", 34.83124, 113.54679],
    ["haut/lianhuajie/floor/5-1", 34.83124, 113.54679],
    ["haut/lianhuajie/room/5-111", 34.83124, 113.54679],
    ["haut/lianhuajie/entrance/5-south", 34.83124, 113.54679],
    ["haut/lianhuajie/facility/5-study-seats", 34.83124, 113.54679],
    ["haut/lianhuajie/indoor_node/5-1-lobby", 34.83124, 113.54679]
  ];
  return rows.map(([placeRef, latitude, longitude]) => ({
    ...parsePlaceRef(placeRef),
    latitude,
    longitude,
    verification_level: "UNVERIFIED",
    source_ref: "dis-place-status:bootstrap-building-centroid:v1"
  }));
}

export class PlaceStatusService {
  constructor(store) {
    this.store = store;
    if (!this.store.campusGraphPlaces) this.store.campusGraphPlaces = new Map();
    if (!this.store.placeReports) this.store.placeReports = new Map();
    if (!this.store.placeReportFlags) this.store.placeReportFlags = new Map();
    if (!this.store.placeStatusSubscriptions) this.store.placeStatusSubscriptions = new Map();
    if (!this.store.placeStatusAggregates) this.store.placeStatusAggregates = new Map();
    if (this.store.campusGraphPlaces.size === 0) {
      for (const row of createDefaultCampusGraphPlaces()) this.store.campusGraphPlaces.set(row.place_ref, row);
    }
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
      const matches = existing.hashVersion === 2
        ? existing.canonicalHash === canonicalHash
        : existing.bodyHash === bodyHash;
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
        try { undo[index](); } catch { /* best-effort inverse; indexes are rebuilt below */ }
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
          "地点状态提交未能持久化，请稍后按原 Idempotency-Key 重试；未产生半提交状态"
        );
      }
      throw new ContractError(
        "STORAGE_COMMIT_UNKNOWN",
        "地点状态提交结果未知：快照可能已发布但核验失败。请携带原 Idempotency-Key 重试以对账，不要另起新键",
        { persist_stage: stage, durability: "UNKNOWN", retry_same_key: true }
      );
    }
  }

  _activeSchoolBindings(cloudUserId) {
    return Array.from(this.store.schoolBindings.values()).filter(
      (binding) => binding && binding.cloud_user_id === cloudUserId && !binding.revoked_at && binding.status === "DELEGATED_ACTIVE"
    );
  }

  _requireSchoolBinding(auth, schoolId) {
    const cleanSchoolId = requireString(schoolId, "school_id", { max: 128 });
    const activeBindings = this._activeSchoolBindings(auth.cloudUserId);
    const binding = activeBindings.find((row) => (row.school_id || "haut") === cleanSchoolId);
    if (binding) return binding;
    if (activeBindings.length === 0) {
      throw new ContractError("CAMPUS_BINDING_REQUIRED", "A verified active campus binding is required before using place status");
    }
    throw new ContractError("SCHOOL_SCOPE_MISMATCH", "Requested place status resource belongs to a different school_id isolation scope");
  }

  _moderationRoles(auth) {
    return new Set([...(auth.roles || []), ...(this.store.getUserRoles?.(auth.cloudUserId) || [])]);
  }

  _canWritePlaceModeration(auth) {
    const user = this.store.users.get(auth.cloudUserId);
    const roles = this._moderationRoles(auth);
    return Boolean(
      user?.role === "admin" ||
      ["ADMIN", "OPERATOR", "PLATFORM_OWNER", "OPERATIONS_ADMIN", "SCHOOL_OPERATOR"].some((role) => roles.has(role))
    );
  }

  _canReadPlaceModeration(auth) {
    return this._canWritePlaceModeration(auth) || this._moderationRoles(auth).has("SECURITY_AUDITOR");
  }

  _requireModerator(auth, schoolId, { write = false } = {}) {
    this._requireSchoolBinding(auth, schoolId);
    const allowed = write ? this._canWritePlaceModeration(auth) : this._canReadPlaceModeration(auth);
    if (!allowed) {
      throw new ContractError("PLACE_STATUS_PERMISSION_DENIED", "School-scoped place status moderation permission is required");
    }
  }

  _knownPlace(parsed) {
    const place = this.store.campusGraphPlaces.get(parsed.place_ref);
    if (!place || place.school_id !== parsed.school_id) {
      throw new ContractError("PLACE_NOT_FOUND", "Campus Graph place entity does not exist or is not visible in this school scope");
    }
    return place;
  }

  _parseKnownPlaceRef(value) {
    const parsed = parsePlaceRef(value);
    return this._knownPlace(parsed);
  }

  _reportsFor(placeRef, metric = null, schoolId = null) {
    return Array.from(this.store.placeReports.values()).filter((report) =>
      report.place_ref === placeRef &&
      (!metric || report.metric === metric) &&
      (!schoolId || report.school_id === schoolId)
    );
  }

  _aggregateKey(schoolId, placeRef, metric) {
    return schoolId + "|" + placeRef + "|" + metric;
  }

  _correctionSupersededIds(reports) {
    const byId = new Map(reports.map((report) => [report.id, report]));
    const superseded = new Set();
    for (const correction of reports) {
      if (correction.report_kind !== "CORRECTION" || !correction.corrects_report_id) continue;
      const target = byId.get(correction.corrects_report_id);
      if (target && target.reporter_key === correction.reporter_key) superseded.add(target.id);
    }
    return superseded;
  }

  _latestPerReporter(reports) {
    const superseded = this._correctionSupersededIds(reports);
    const candidates = reports.filter((report) => !superseded.has(report.id));
    const order = new Map(Array.from(this.store.placeReports.keys()).map((id, index) => [id, index]));
    const byReporter = new Map();
    for (const report of candidates) {
      const key = report.reporter_key || report.cloud_user_id;
      const current = byReporter.get(key);
      if (!current) {
        byReporter.set(key, report);
        continue;
      }
      const observedDelta = Date.parse(report.observed_at) - Date.parse(current.observed_at);
      const reportedDelta = Date.parse(report.reported_at) - Date.parse(current.reported_at);
      const orderDelta = (order.get(report.id) ?? 0) - (order.get(current.id) ?? 0);
      if (observedDelta > 0 || (observedDelta === 0 && reportedDelta > 0) || (observedDelta === 0 && reportedDelta === 0 && orderDelta > 0)) {
        byReporter.set(key, report);
      }
    }
    return Array.from(byReporter.values());
  }

  _computeStatusView(place, metric, nowMs, revision = null) {
    const allReports = this._reportsFor(place.place_ref, metric, place.school_id);
    const eligibleReports = allReports.filter((report) => report.aggregation_eligible !== false);
    const latestReports = this._latestPerReporter(eligibleReports);
    const activeReports = latestReports.filter((report) => Date.parse(report.expires_at) > nowMs);
    const byState = new Map();
    for (const report of activeReports) {
      if (!byState.has(report.state)) byState.set(report.state, []);
      byState.get(report.state).push(report);
    }
    const divergent = Array.from(byState.entries()).map(([state, rows]) => ({
      state,
      report_count: rows.length,
      reporter_count: new Set(rows.map((row) => row.reporter_key || row.cloud_user_id)).size,
      latest_observed_at: rows.map((row) => row.observed_at).sort().at(-1)
    })).sort((a, b) =>
      b.report_count - a.report_count ||
      Date.parse(b.latest_observed_at) - Date.parse(a.latest_observed_at) ||
      a.state.localeCompare(b.state)
    );
    let effectiveState = "UNKNOWN";
    if (divergent.length === 1) effectiveState = divergent[0].state;
    else if (divergent.length > 1) effectiveState = "CONTESTED";
    let unknownReason = null;
    if (effectiveState === "UNKNOWN") {
      if (allReports.length === 0) unknownReason = "NO_REPORTS";
      else if (eligibleReports.length === 0) unknownReason = "ALL_EXCLUDED";
      else unknownReason = "ALL_EXPIRED";
    }
    const latestReportedAt = activeReports.length
      ? activeReports.map((row) => row.reported_at).sort().at(-1)
      : null;
    const expiresAt = activeReports.length
      ? activeReports.map((row) => row.expires_at).sort().at(-1)
      : null;
    const aggregateKey = this._aggregateKey(place.school_id, place.place_ref, metric);
    const storedRevision = this.store.placeStatusAggregates.get(aggregateKey)?.aggregation_revision ?? 0;
    return {
      place_ref: place.place_ref,
      school_id: place.school_id,
      campus_id: place.campus_id,
      place_type: place.place_type,
      metric,
      effective_state: effectiveState,
      divergent_states: divergent,
      active_report_count: activeReports.length,
      reporter_count: new Set(activeReports.map((row) => row.reporter_key || row.cloud_user_id)).size,
      latest_reported_at: latestReportedAt,
      expires_at: expiresAt,
      ttl_seconds: METRIC_TTL_SECONDS[metric],
      aggregation_revision: revision ?? storedRevision,
      aggregation_algorithm: PLACE_STATUS_AGGREGATION_ALGORITHM,
      unknown_reason: unknownReason,
      provenance: {
        kind: activeReports.length ? "USER_REPORTED" : "NO_DATA",
        freshness: activeReports.length ? "FRESH" : (eligibleReports.length ? "STALE" : "UNKNOWN"),
        source_count: activeReports.length,
        latest_reported_at: latestReportedAt
      }
    };
  }

  _appendNotificationCommitted({ cloudUserId, category, title, body, createdAt }, undo) {
    const existing = this.store.notifications instanceof Map ? this.store.notifications : null;
    if (!existing) return;
    const id = crypto.randomUUID();
    const notification = {
      id,
      cloud_user_id: cloudUserId,
      category,
      title,
      body,
      read_at: null,
      created_at: createdAt
    };
    setMapCommitted(existing, id, notification, undo);
    this.store.indexUserScoped?.("notifications", id, cloudUserId);
    undo.push(() => {
      const byUser = this.store._idxIdsByUser?.get?.("notifications")?.get?.(cloudUserId);
      byUser?.delete?.(id);
    });
  }

  _fanoutStatusEventCommitted(payload, place, undo, transitionAtMs) {
    const notified = new Set();
    for (const subscription of this.store.placeStatusSubscriptions.values()) {
      if (subscription.status !== "ACTIVE" || subscription.school_id !== payload.school_id) continue;
      if (!subscription.metrics.includes(payload.metric)) continue;
      const subscriptionCreatedMs = Date.parse(subscription.created_at);
      if (!Number.isFinite(subscriptionCreatedMs) || subscriptionCreatedMs > transitionAtMs) continue;
      const target = subscription.target || {};
      let matches = false;
      if (target.type === "PLACE") {
        matches = target.place_ref === payload.place_ref &&
          (!Array.isArray(target.place_types) || target.place_types.includes(payload.place_type));
      } else if (target.type === "AREA") {
        matches = bboxContains(target.bbox, place) && (!Array.isArray(target.place_types) || target.place_types.includes(payload.place_type));
      }
      if (!matches || notified.has(subscription.cloud_user_id)) continue;
      const hasActiveBinding = this._activeSchoolBindings(subscription.cloud_user_id)
        .some((binding) => (binding.school_id || "haut") === subscription.school_id);
      if (!hasActiveBinding) continue;
      notified.add(subscription.cloud_user_id);
      this._appendNotificationCommitted({
        cloudUserId: subscription.cloud_user_id,
        category: "place_status",
        title: "地点状态变化提醒",
        body: payload.place_ref + " 的 " + payload.metric + " 从 " + payload.previous_effective_state + " 变为 " + payload.effective_state + "（用户上报聚合，非官方实时状态）",
        createdAt: payload.occurred_at
      }, undo);
    }
  }

  _emitStatusChangedCommitted({ view, previousEffectiveState, triggerType, triggerReportId, moderationAction = null, occurredAt, transitionAtMs = Date.parse(occurredAt) }, undo) {
    const eventId = crypto.randomUUID();
    const payload = {
      event_id: eventId,
      event_key: "dis:place-status:report:" + triggerReportId + ":revision:" + view.aggregation_revision + ":v1",
      event_type: "changed",
      occurred_at: occurredAt,
      school_id: view.school_id,
      campus_id: view.campus_id,
      place_ref: view.place_ref,
      place_type: view.place_type,
      metric: view.metric,
      previous_effective_state: previousEffectiveState,
      effective_state: view.effective_state,
      trigger_type: triggerType,
      aggregation_revision: view.aggregation_revision,
      active_report_count: view.active_report_count,
      reporter_count: view.reporter_count,
      expires_at: view.expires_at,
      trigger_report_id: triggerReportId,
      moderation_action: moderationAction,
      official_realtime_status: false
    };
    pushArrayCommitted(this.store.outboxEvents, {
      id: eventId,
      aggregate_type: "place_status",
      aggregate_id: view.school_id + "|" + view.place_ref + "|" + view.metric,
      event_type: "place.status.changed",
      payload_json: payload,
      created_at: occurredAt,
      delivered_at: null
    }, undo);
    const place = this.store.campusGraphPlaces.get(view.place_ref);
    this._fanoutStatusEventCommitted(payload, place, undo, transitionAtMs);
    return payload;
  }

  _recomputeAfterInputChange({ place, metric, triggerType, triggerReportId, moderationAction = null, nowMs, evaluationMs = nowMs }, undo) {
    const key = this._aggregateKey(place.school_id, place.place_ref, metric);
    const prior = this.store.placeStatusAggregates.get(key) || null;
    const previousRevision = Number(prior?.aggregation_revision || 0);
    const previousEffective = prior?.last_effective_state || "UNKNOWN";
    const nextRevision = previousRevision + 1;
    const view = this._computeStatusView(place, metric, evaluationMs, nextRevision);
    const nextAggregate = {
      key,
      school_id: place.school_id,
      place_ref: place.place_ref,
      metric,
      aggregation_revision: nextRevision,
      last_effective_state: view.effective_state,
      updated_at: iso(nowMs)
    };
    setMapCommitted(this.store.placeStatusAggregates, key, nextAggregate, undo);
    if (previousEffective !== view.effective_state) {
      this._emitStatusChangedCommitted({
        view,
        previousEffectiveState: previousEffective,
        triggerType,
        triggerReportId,
        moderationAction,
        occurredAt: iso(nowMs),
        transitionAtMs: evaluationMs
      }, undo);
    }
    return view;
  }

  _isLatestIgnoringExpiry(report) {
    const rows = this._reportsFor(report.place_ref, report.metric, report.school_id)
      .filter((row) => row.aggregation_eligible !== false);
    return this._latestPerReporter(rows).some((row) => row.id === report.id);
  }

  _hasDueReports(nowMs, { placeRefs = null } = {}) {
    return Array.from(this.store.placeReports.values()).some((report) =>
      !report.ttl_expiry_accounted_at &&
      Date.parse(report.expires_at) <= nowMs &&
      (!placeRefs || placeRefs.has(report.place_ref))
    );
  }

  _expireDueReportsCommitted(nowMs, undo, { placeRefs = null } = {}) {
    const due = Array.from(this.store.placeReports.values())
      .filter((report) =>
        !report.ttl_expiry_accounted_at &&
        Date.parse(report.expires_at) <= nowMs &&
        (!placeRefs || placeRefs.has(report.place_ref))
      )
      .sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at) || a.id.localeCompare(b.id));
    const dueByExpiry = new Map();
    for (const report of due) {
      const expiryMs = Date.parse(report.expires_at);
      if (!dueByExpiry.has(expiryMs)) dueByExpiry.set(expiryMs, []);
      dueByExpiry.get(expiryMs).push(report);
    }
    for (const [expiryMs, expiringReports] of dueByExpiry.entries()) {
      const affectedAggregates = new Map();
      for (const report of expiringReports) {
        const contributing = report.aggregation_eligible !== false && this._isLatestIgnoringExpiry(report);
        mutateObject(report, { ttl_expiry_accounted_at: iso(nowMs) }, undo);
        if (!contributing) continue;
        const place = this.store.campusGraphPlaces.get(report.place_ref);
        if (!place) continue;
        const key = this._aggregateKey(place.school_id, place.place_ref, report.metric);
        if (!affectedAggregates.has(key)) {
          affectedAggregates.set(key, { place, metric: report.metric, triggerReportId: report.id });
        }
      }
      for (const affected of affectedAggregates.values()) {
        this._recomputeAfterInputChange({
          place: affected.place,
          metric: affected.metric,
          triggerType: "TTL_EXPIRED",
          triggerReportId: affected.triggerReportId,
          nowMs,
          evaluationMs: expiryMs
        }, undo);
      }
    }
  }

  _reportView(report, cloudUserId) {
    const correctedBy = Array.from(this.store.placeReports.values())
      .filter((row) => row.corrects_report_id === report.id)
      .map((row) => row.id)
      .sort();
    return {
      report_id: report.id,
      place_ref: report.place_ref,
      school_id: report.school_id,
      campus_id: report.campus_id,
      place_type: report.place_type,
      metric: report.metric,
      state: report.state,
      observed_at: report.observed_at,
      reported_at: report.reported_at,
      expires_at: report.expires_at,
      ttl_seconds: report.ttl_seconds,
      report_kind: report.report_kind,
      corrects_report_id: report.corrects_report_id ?? null,
      corrected_by_report_ids: correctedBy,
      reporter_alias: pseudonymFor(report.cloud_user_id, report.school_id),
      is_own_report: report.cloud_user_id === cloudUserId,
      note: report.note ?? null,
      moderation_state: report.moderation_state,
      aggregation_eligible: report.aggregation_eligible !== false
    };
  }

  _flagView(flag) {
    return {
      flag_id: flag.id,
      report_id: flag.report_id,
      place_ref: flag.place_ref,
      school_id: flag.school_id,
      reason: flag.reason,
      detail: flag.detail ?? null,
      status: flag.status,
      created_at: flag.created_at,
      reviewed_at: flag.reviewed_at ?? null,
      review_action: flag.review_action ?? null,
      review_note: flag.review_note ?? null
    };
  }

  _subscriptionView(subscription) {
    return {
      subscription_id: subscription.id,
      school_id: subscription.school_id,
      target: clone(subscription.target),
      metrics: [...subscription.metrics],
      delivery_channel: "IN_APP_NOTIFICATION",
      status: subscription.status,
      created_at: subscription.created_at,
      updated_at: subscription.updated_at,
      cancelled_at: subscription.cancelled_at ?? null
    };
  }

  _checkReportRateLimit(auth, nowMs) {
    const since = nowMs - 3600_000;
    const count = Array.from(this.store.placeReports.values()).filter(
      (report) => report.cloud_user_id === auth.cloudUserId && Date.parse(report.reported_at) >= since
    ).length;
    if (count >= REPORT_RATE_LIMIT_PER_HOUR) {
      throw new ContractError("PLACE_STATUS_RATE_LIMITED", "Place status report rate limit reached; retry after the rolling window");
    }
  }

  createReport(auth, params, body, headers, nowMs = Date.now()) {
    const placeRef = params.placeRef;
    const idem = this._idempotency("createPlaceStatusReport", auth, headers, body, { placeRef });
    if (idem.replay) return idem.replay;
    const place = this._parseKnownPlaceRef(placeRef);
    this._requireSchoolBinding(auth, place.school_id);
    requireNoUnknownFields(body, ["metric", "state", "observed_at", "report_kind", "corrects_report_id", "note"], "CreatePlaceStatusReportRequest", placeInvalid);
    const metric = requireString(body.metric, "metric", { error: placeInvalid });
    if (!METRICS.has(metric)) throw placeInvalid("metric is not supported");
    const state = requireString(body.state, "state", { error: placeInvalid });
    if (!STATES_BY_METRIC[metric].has(state)) throw placeInvalid("state is not valid for metric " + metric);
    const reportKind = requireString(body.report_kind, "report_kind", { error: placeInvalid });
    if (!REPORT_KINDS.has(reportKind)) throw placeInvalid("report_kind is not supported");
    const observedMs = parseDateTimeMs(body.observed_at, "observed_at", placeInvalid);
    const ttlSeconds = METRIC_TTL_SECONDS[metric];
    if (observedMs > nowMs + 5 * 60_000) throw placeInvalid("observed_at must not be more than five minutes in the future");
    if (observedMs + ttlSeconds * 1000 <= nowMs) throw placeInvalid("observed_at is already older than the fixed metric TTL");
    let correctsReport = null;
    if (reportKind === "CORRECTION") {
      const correctsId = requireUuid(body.corrects_report_id, "corrects_report_id", placeInvalid);
      correctsReport = this.store.placeReports.get(correctsId);
      if (!correctsReport || correctsReport.aggregation_eligible === false) {
        throw new ContractError("PLACE_STATUS_REPORT_NOT_FOUND", "Correction target report does not exist or is not visible in this school scope");
      }
      if (correctsReport.place_ref !== place.place_ref || correctsReport.metric !== metric || correctsReport.school_id !== place.school_id) {
        throw placeInvalid("Correction target must be for the same place and metric in the same school scope");
      }
    } else if (body.corrects_report_id !== undefined) {
      throw placeInvalid("corrects_report_id is forbidden for OBSERVATION");
    }
    const note = body.note === undefined ? null : requireString(body.note, "note", { min: 0, max: 280, error: placeInvalid });
    assertNoPii(note, "note", placeInvalid);
    this._checkReportRateLimit(auth, nowMs);

    return this._commitWithReceipt((undo) => {
      this._expireDueReportsCommitted(nowMs, undo);
      const ts = iso(nowMs);
      const report = {
        id: crypto.randomUUID(),
        place_ref: place.place_ref,
        school_id: place.school_id,
        campus_id: place.campus_id,
        place_type: place.place_type,
        metric,
        state,
        observed_at: new Date(observedMs).toISOString(),
        reported_at: ts,
        expires_at: new Date(observedMs + ttlSeconds * 1000).toISOString(),
        ttl_seconds: ttlSeconds,
        report_kind: reportKind,
        corrects_report_id: correctsReport?.id ?? null,
        cloud_user_id: auth.cloudUserId,
        reporter_key: auth.cloudUserId,
        note,
        moderation_state: "VISIBLE",
        aggregation_eligible: true,
        ttl_expiry_accounted_at: null
      };
      setMapCommitted(this.store.placeReports, report.id, report, undo);
      this._recomputeAfterInputChange({
        place,
        metric,
        triggerType: reportKind === "CORRECTION" ? "CORRECTION_ACCEPTED" : "REPORT_ACCEPTED",
        triggerReportId: report.id,
        nowMs
      }, undo);
      return {
        status: 201,
        code: "PLACE_STATUS_REPORT_CREATED",
        data: this._reportView(report, auth.cloudUserId)
      };
    }, idem.receipt, nowMs);
  }

  listReports(auth, params, query, nowMs = Date.now()) {
    const place = this._parseKnownPlaceRef(params.placeRef);
    this._requireSchoolBinding(auth, place.school_id);
    const metricRaw = query.get("metric");
    const metric = metricRaw ? requireString(metricRaw, "metric") : null;
    if (metric && !METRICS.has(metric)) throw badRequest("metric is not supported");
    const includeExpired = parseBooleanQuery(query.get("include_expired"), "include_expired", true);
    const limit = parseLimit(query.get("limit"));
    const cursor = query.get("cursor") || null;
    const historyPlaceRefs = new Set([place.place_ref]);
    if (this._hasDueReports(nowMs, { placeRefs: historyPlaceRefs })) {
      this._commitWithReceipt((undo) => {
        this._expireDueReportsCommitted(nowMs, undo, { placeRefs: historyPlaceRefs });
        return { status: 200, code: "PLACE_STATUS_EXPIRY_SWEPT", data: null };
      }, null, nowMs);
    }
    const rows = this._reportsFor(place.place_ref, metric, place.school_id)
      .filter((report) => report.aggregation_eligible !== false)
      .filter((report) => includeExpired || Date.parse(report.expires_at) > nowMs)
      .sort((a, b) => Date.parse(b.reported_at) - Date.parse(a.reported_at) || b.id.localeCompare(a.id));
    const { page, nextCursor } = paginateRows(rows, { cursor, limit }, (row) => row.id);
    return {
      status: 200,
      code: "PLACE_STATUS_REPORTS_LISTED",
      data: page.map((report) => this._reportView(report, auth.cloudUserId)),
      nextCursor
    };
  }

  queryStatus(auth, query, nowMs = Date.now()) {
    const schoolId = requireString(query.get("school_id"), "school_id", { max: 128 });
    this._requireSchoolBinding(auth, schoolId);
    const rawRefs = query.get("place_refs");
    const rawBbox = query.get("bbox");
    if (Boolean(rawRefs) === Boolean(rawBbox)) throw badRequest("exactly one of place_refs or bbox is required");
    const metrics = requireUniqueEnumList(query.get("metrics"), METRICS, "metrics") || Array.from(METRICS);
    const placeTypes = requireUniqueEnumList(query.get("place_types"), PLACE_TYPES, "place_types");
    const includeExpired = parseBooleanQuery(query.get("include_expired"), "include_expired", false);
    const limit = parseLimit(query.get("limit"));
    const cursor = query.get("cursor") || null;
    let places = [];
    let explicit = false;
    if (rawRefs) {
      explicit = true;
      const refs = String(rawRefs).split(",").map((item) => item.trim()).filter(Boolean);
      if (refs.length === 0 || refs.length > 100 || new Set(refs).size !== refs.length) {
        throw badRequest("place_refs must contain 1..100 unique values");
      }
      places = refs.map((ref) => {
        const place = this._parseKnownPlaceRef(ref);
        if (place.school_id !== schoolId) throw new ContractError("SCHOOL_SCOPE_MISMATCH", "place_refs must belong to the requested school_id scope");
        return place;
      });
    } else {
      const bbox = parseBboxText(rawBbox);
      places = Array.from(this.store.campusGraphPlaces.values()).filter((place) =>
        place.school_id === schoolId && bboxContains(bbox, place)
      );
    }
    if (placeTypes) places = places.filter((place) => placeTypes.includes(place.place_type));
    const placeRefSet = new Set(places.map((place) => place.place_ref));
    if (this._hasDueReports(nowMs, { placeRefs: placeRefSet })) {
      this._commitWithReceipt((undo) => {
        this._expireDueReportsCommitted(nowMs, undo, { placeRefs: placeRefSet });
        return { status: 200, code: "PLACE_STATUS_EXPIRY_SWEPT", data: null };
      }, null, nowMs);
    }

    const rows = [];
    for (const place of places) {
      for (const metric of metrics) {
        const view = this._computeStatusView(place, metric, nowMs);
        const hasAnyEligibleReport = this._reportsFor(place.place_ref, metric, place.school_id)
          .some((report) => report.aggregation_eligible !== false);
        if (!explicit && !hasAnyEligibleReport) continue;
        if (!explicit && !includeExpired && view.active_report_count === 0) continue;
        rows.push(view);
      }
    }
    rows.sort((a, b) => a.place_ref.localeCompare(b.place_ref) || a.metric.localeCompare(b.metric));
    const { page, nextCursor } = paginateRows(rows, { cursor, limit }, (row) => row.place_ref + "|" + row.metric);
    return {
      status: 200,
      code: "PLACE_STATUS_QUERIED",
      data: page,
      nextCursor
    };
  }

  _validateSubscriptionTarget(target, schoolId) {
    if (!isPlainObject(target)) throw subscriptionInvalid("target must be an object");
    const type = target.type;
    if (!TARGET_TYPES.has(type)) throw subscriptionInvalid("target.type must be PLACE or AREA");
    const allowed = ["type", "place_ref", "bbox", "place_types"];
    for (const key of Object.keys(target)) {
      if (!allowed.includes(key)) throw subscriptionInvalid("target contains unsupported field: " + key);
    }
    const out = { type };
    if (type === "PLACE") {
      if (!target.place_ref) throw subscriptionInvalid("target.place_ref is required for PLACE subscriptions");
      if (target.bbox !== undefined) throw subscriptionInvalid("target.bbox is forbidden for PLACE subscriptions");
      const place = this._parseKnownPlaceRef(target.place_ref);
      if (place.school_id !== schoolId) throw subscriptionInvalid("target.place_ref must belong to school_id");
      out.place_ref = place.place_ref;
    } else {
      if (!target.bbox) throw subscriptionInvalid("target.bbox is required for AREA subscriptions");
      if (target.place_ref !== undefined) throw subscriptionInvalid("target.place_ref is forbidden for AREA subscriptions");
      out.bbox = validateBbox(target.bbox, subscriptionInvalid);
    }
    if (target.place_types !== undefined) {
      if (!Array.isArray(target.place_types) || target.place_types.length === 0) throw subscriptionInvalid("target.place_types must be a non-empty array");
      if (new Set(target.place_types).size !== target.place_types.length) throw subscriptionInvalid("target.place_types must not contain duplicates");
      for (const placeType of target.place_types) {
        if (!PLACE_TYPES.has(placeType)) throw subscriptionInvalid("target.place_types contains unsupported value: " + String(placeType));
      }
      out.place_types = [...target.place_types];
    }
    return out;
  }

  createSubscription(auth, body, headers, nowMs = Date.now()) {
    const idem = this._idempotency("createPlaceStatusSubscription", auth, headers, body);
    if (idem.replay) return idem.replay;
    requireNoUnknownFields(body, ["school_id", "target", "metrics"], "CreatePlaceStatusSubscriptionRequest", subscriptionInvalid);
    const schoolId = requireString(body.school_id, "school_id", { max: 128, error: subscriptionInvalid });
    this._requireSchoolBinding(auth, schoolId);
    const target = this._validateSubscriptionTarget(body.target, schoolId);
    const metrics = validateMetricArray(body.metrics, subscriptionInvalid);
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const subscription = {
        id: crypto.randomUUID(),
        cloud_user_id: auth.cloudUserId,
        school_id: schoolId,
        target,
        metrics,
        delivery_channel: "IN_APP_NOTIFICATION",
        status: "ACTIVE",
        created_at: ts,
        updated_at: ts,
        cancelled_at: null
      };
      setMapCommitted(this.store.placeStatusSubscriptions, subscription.id, subscription, undo);
      this.store.indexUserScoped?.("placeStatusSubscriptions", subscription.id, auth.cloudUserId);
      undo.push(() => {
        const byUser = this.store._idxIdsByUser?.get?.("placeStatusSubscriptions")?.get?.(auth.cloudUserId);
        byUser?.delete?.(subscription.id);
      });
      return {
        status: 201,
        code: "PLACE_STATUS_SUBSCRIPTION_CREATED",
        data: this._subscriptionView(subscription)
      };
    }, idem.receipt, nowMs);
  }

  listSubscriptions(auth, query) {
    const schoolId = requireString(query.get("school_id"), "school_id", { max: 128 });
    this._requireSchoolBinding(auth, schoolId);
    const rawStatus = query.get("status");
    const status = rawStatus ? requireString(rawStatus, "status") : null;
    if (status && !SUBSCRIPTION_STATUSES.has(status)) throw badRequest("status is not supported");
    const limit = parseLimit(query.get("limit"));
    const cursor = query.get("cursor") || null;
    const rows = Array.from(this.store.placeStatusSubscriptions.values())
      .filter((subscription) =>
        subscription.cloud_user_id === auth.cloudUserId &&
        subscription.school_id === schoolId &&
        (!status || subscription.status === status)
      )
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
    const { page, nextCursor } = paginateRows(rows, { cursor, limit }, (row) => row.id);
    return {
      status: 200,
      code: "PLACE_STATUS_SUBSCRIPTIONS_LISTED",
      data: page.map((subscription) => this._subscriptionView(subscription)),
      nextCursor
    };
  }

  deleteSubscription(auth, params, headers, nowMs = Date.now()) {
    const subscriptionId = requireUuid(params.subscriptionId, "subscriptionId");
    const idem = this._idempotency("deletePlaceStatusSubscription", auth, headers, {}, { subscriptionId });
    if (idem.replay) return idem.replay;
    const subscription = this.store.placeStatusSubscriptions.get(subscriptionId);
    if (!subscription || subscription.cloud_user_id !== auth.cloudUserId) {
      throw new ContractError("PLACE_STATUS_SUBSCRIPTION_NOT_FOUND", "Place status subscription does not exist or does not belong to the caller");
    }
    this._requireSchoolBinding(auth, subscription.school_id);
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      if (subscription.status !== "CANCELLED") {
        mutateObject(subscription, { status: "CANCELLED", updated_at: ts, cancelled_at: ts }, undo);
      }
      return {
        status: 200,
        code: "PLACE_STATUS_SUBSCRIPTION_CANCELLED",
        data: {
          subscription_id: subscription.id,
          status: subscription.status,
          cancelled_at: subscription.cancelled_at
        }
      };
    }, idem.receipt, nowMs);
  }

  _checkFlagRateLimit(auth, nowMs) {
    const since = nowMs - 3600_000;
    const flagCount = Array.from(this.store.placeReportFlags.values()).filter(
      (flag) => flag.flagger_cloud_user_id === auth.cloudUserId && Date.parse(flag.created_at) >= since
    ).length;
    const receiptPrefix = "flagPlaceStatusReport|" + auth.cloudUserId + "|";
    const receiptCount = Array.from(this.store.idempotencyRecords.entries()).filter(([key, record]) =>
      key.startsWith(receiptPrefix) && Number.isFinite(Number(record?.createdAtMs)) && Number(record.createdAtMs) >= since
    ).length;
    if (Math.max(flagCount, receiptCount) >= FLAG_RATE_LIMIT_PER_HOUR) {
      throw new ContractError("PLACE_STATUS_RATE_LIMITED", "Place report flag rate limit reached; retry after the rolling window");
    }
  }

  flagReport(auth, params, body, headers, nowMs = Date.now()) {
    const reportId = requireUuid(params.reportId, "reportId");
    const idem = this._idempotency("flagPlaceStatusReport", auth, headers, body, { reportId });
    if (idem.replay) return idem.replay;
    const report = this.store.placeReports.get(reportId);
    if (!report || report.aggregation_eligible === false) {
      throw new ContractError("PLACE_STATUS_REPORT_NOT_FOUND", "Place status report does not exist or is not visible in this school scope");
    }
    this._requireSchoolBinding(auth, report.school_id);
    requireNoUnknownFields(body, ["reason", "detail"], "CreatePlaceReportFlagRequest", flagInvalid);
    const reason = requireString(body.reason, "reason", { error: flagInvalid });
    if (!FLAG_REASONS.has(reason)) throw flagInvalid("reason is not supported");
    const detail = body.detail === undefined ? null : requireString(body.detail, "detail", { min: 0, max: 500, error: flagInvalid });
    assertNoPii(detail, "detail", flagInvalid);
    this._checkFlagRateLimit(auth, nowMs);
    const existingOpen = Array.from(this.store.placeReportFlags.values()).filter(
      (flag) => flag.report_id === report.id && flag.flagger_cloud_user_id === auth.cloudUserId && flag.status === "OPEN"
    );
    const identical = existingOpen.find((flag) => flag.reason === reason && (flag.detail ?? null) === detail);
    if (identical) {
      return this._commitWithReceipt(() => ({
        status: 200,
        code: "REQUEST_DUPLICATE",
        data: this._flagView(identical)
      }), idem.receipt, nowMs);
    }
    if (existingOpen.length > 0) throw flagInvalid("an active flag by the same caller already exists for this report");
    return this._commitWithReceipt((undo) => {
      const flag = {
        id: crypto.randomUUID(),
        report_id: report.id,
        place_ref: report.place_ref,
        school_id: report.school_id,
        reason,
        detail,
        status: "OPEN",
        created_at: iso(nowMs),
        reviewed_at: null,
        review_action: null,
        review_note: null,
        flagger_cloud_user_id: auth.cloudUserId,
        reviewer_cloud_user_id: null
      };
      setMapCommitted(this.store.placeReportFlags, flag.id, flag, undo);
      mutateObject(report, { moderation_state: "UNDER_REVIEW" }, undo);
      return { status: 201, code: "PLACE_REPORT_FLAG_CREATED", data: this._flagView(flag) };
    }, idem.receipt, nowMs);
  }

  listFlags(auth, query) {
    const schoolId = requireString(query.get("school_id"), "school_id", { max: 128 });
    this._requireModerator(auth, schoolId);
    const rawStatus = query.get("status");
    const status = rawStatus ? requireString(rawStatus, "status") : null;
    if (status && !FLAG_STATUSES.has(status)) throw badRequest("status is not supported");
    const rawPlaceRef = query.get("place_ref");
    if (rawPlaceRef) parsePlaceRef(rawPlaceRef);
    const limit = parseLimit(query.get("limit"));
    const cursor = query.get("cursor") || null;
    const rows = Array.from(this.store.placeReportFlags.values())
      .filter((flag) =>
        flag.school_id === schoolId &&
        (!status || flag.status === status) &&
        (!rawPlaceRef || flag.place_ref === rawPlaceRef)
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id));
    const { page, nextCursor } = paginateRows(rows, { cursor, limit }, (row) => row.id);
    return {
      status: 200,
      code: "PLACE_REPORT_FLAGS_LISTED",
      data: page.map((flag) => this._flagView(flag)),
      nextCursor
    };
  }

  reviewFlag(auth, params, body, headers, nowMs = Date.now()) {
    const flagId = requireUuid(params.flagId, "flagId");
    const idem = this._idempotency("reviewPlaceReportFlag", auth, headers, body, { flagId });
    if (idem.replay) return idem.replay;
    const flag = this.store.placeReportFlags.get(flagId);
    if (!flag) throw new ContractError("PLACE_REPORT_FLAG_NOT_FOUND", "Place report flag does not exist or is not visible in this reviewer school scope");
    this._requireModerator(auth, flag.school_id, { write: true });
    if (flag.status !== "OPEN") throw new ContractError("PLACE_REPORT_REVIEW_INVALID", "Place report flag is already terminal");
    requireNoUnknownFields(body, ["action", "review_note"], "ReviewPlaceReportFlagRequest");
    const action = requireString(body.action, "action");
    if (!REVIEW_ACTIONS.has(action)) throw badRequest("action is not supported");
    const reviewNote = requireString(body.review_note, "review_note", { min: 1, max: 500 });
    assertNoPii(reviewNote, "review_note", badRequest);
    const report = this.store.placeReports.get(flag.report_id);
    if (!report) throw new ContractError("PLACE_STATUS_REPORT_NOT_FOUND", "Referenced report is missing");
    const place = this.store.campusGraphPlaces.get(report.place_ref);
    if (!place) throw new ContractError("PLACE_NOT_FOUND", "Referenced Campus Graph place is missing");

    return this._commitWithReceipt((undo) => {
      this._expireDueReportsCommitted(nowMs, undo, { placeRefs: new Set([report.place_ref]) });
      const ts = iso(nowMs);
      const status = action === "KEEP_VISIBLE"
        ? "RESOLVED_KEEP_VISIBLE"
        : action === "REJECT_FLAG"
          ? "REJECTED"
          : "RESOLVED_EXCLUDED";
      mutateObject(flag, {
        status,
        reviewed_at: ts,
        review_action: action,
        review_note: reviewNote,
        reviewer_cloud_user_id: auth.cloudUserId
      }, undo);
      let reportEligibilityChanged = false;
      if (action === "EXCLUDE_INCORRECT" || action === "EXCLUDE_ABUSE") {
        const excludedState = action === "EXCLUDE_INCORRECT" ? "EXCLUDED_INCORRECT" : "EXCLUDED_ABUSE";
        if (report.aggregation_eligible !== false || report.moderation_state !== excludedState) {
          reportEligibilityChanged = report.aggregation_eligible !== false;
          mutateObject(report, { moderation_state: excludedState, aggregation_eligible: false }, undo);
        }
      } else if (report.moderation_state === "UNDER_REVIEW") {
        const stillOpen = Array.from(this.store.placeReportFlags.values()).some(
          (row) => row.report_id === report.id && row.id !== flag.id && row.status === "OPEN"
        );
        if (!stillOpen) mutateObject(report, { moderation_state: "VISIBLE" }, undo);
      }
      let statusView = this._computeStatusView(place, report.metric, nowMs);
      if (reportEligibilityChanged) {
        statusView = this._recomputeAfterInputChange({
          place,
          metric: report.metric,
          triggerType: "MODERATION_REVIEW",
          triggerReportId: report.id,
          moderationAction: action,
          nowMs
        }, undo);
      }
      pushArrayCommitted(this.store.auditEvents, {
        id: crypto.randomUUID(),
        actor_kind: "USER",
        actor_ref: auth.cloudUserId,
        action: "place_report_flag.review",
        resource_kind: "place_report_flag",
        resource_ref: flag.id,
        outcome: "SUCCESS",
        detail: { action, report_id: report.id, place_ref: report.place_ref },
        created_at: ts
      }, undo);
      return {
        status: 200,
        code: "PLACE_REPORT_FLAG_REVIEWED",
        data: { flag: this._flagView(flag), status_view: statusView }
      };
    }, idem.receipt, nowMs);
  }

  exportUserData(cloudUserId) {
    return {
      place_status_reports: clone(Array.from(this.store.placeReports.values()).filter((row) => row.cloud_user_id === cloudUserId)),
      place_status_report_flags: clone(
        Array.from(this.store.placeReportFlags.values())
          .filter((row) => row.flagger_cloud_user_id === cloudUserId || row.reviewer_cloud_user_id === cloudUserId)
          .map((row) => this._flagView(row))
      ),
      place_status_subscriptions: clone(Array.from(this.store.placeStatusSubscriptions.values()).filter((row) => row.cloud_user_id === cloudUserId))
    };
  }

  purgeUserPlaceStatusData(cloudUserId, nowMs = Date.now()) {
    const erasedReporterKey = "erased-reporter-" + crypto.randomUUID();
    let reportsDetached = 0;
    let notesRedacted = 0;
    let flagsDetached = 0;
    let reviewsDetached = 0;
    let subscriptionsDeleted = 0;
    let reviewNotesRedacted = 0;
    const erasedFlagIds = new Set();
    for (const report of this.store.placeReports.values()) {
      if (report.cloud_user_id !== cloudUserId) continue;
      report.cloud_user_id = DELETED_USER_TOMBSTONE;
      report.reporter_key = erasedReporterKey;
      reportsDetached += 1;
      if (report.note != null) {
        report.note = null;
        notesRedacted += 1;
      }
    }
    for (const flag of this.store.placeReportFlags.values()) {
      if (flag.flagger_cloud_user_id === cloudUserId) {
        erasedFlagIds.add(flag.id);
        flag.flagger_cloud_user_id = DELETED_USER_TOMBSTONE;
        if (flag.detail != null) flag.detail = null;
        flagsDetached += 1;
      }
      if (flag.reviewer_cloud_user_id === cloudUserId) {
        flag.reviewer_cloud_user_id = DELETED_USER_TOMBSTONE;
        if (flag.review_note != null) {
          flag.review_note = null;
          reviewNotesRedacted += 1;
        }
        reviewsDetached += 1;
      }
    }
    for (const subscription of Array.from(this.store.placeStatusSubscriptions.values())) {
      if (subscription.cloud_user_id === cloudUserId && this.store.placeStatusSubscriptions.delete(subscription.id)) {
        subscriptionsDeleted += 1;
      }
    }
    let receiptsDeleted = 0;
    let receiptsPseudonymized = 0;
    let receiptFlagDetailsRedacted = 0;
    if (this.store.idempotencyRecords instanceof Map) {
      const ownPrefixes = PLACE_STATUS_IDEMPOTENCY_OPS.map((op) => op + "|" + cloudUserId + "|");
      for (const [key, record] of Array.from(this.store.idempotencyRecords.entries())) {
        if (ownPrefixes.some((prefix) => key.startsWith(prefix))) {
          this.store.idempotencyRecords.delete(key);
          receiptsDeleted += 1;
          continue;
        }
        if (!record || typeof record !== "object") continue;
        const counter = { count: 0 };
        if (record.data !== undefined) {
          const detailCounter = { count: 0 };
          record.data = redactFlagDetailRefs(record.data, erasedFlagIds, detailCounter);
          receiptFlagDetailsRedacted += detailCounter.count;
          record.data = pseudonymizeUserIdRefs(record.data, cloudUserId, DELETED_USER_TOMBSTONE, counter);
        }
        if (record.headers !== undefined) record.headers = pseudonymizeUserIdRefs(record.headers, cloudUserId, DELETED_USER_TOMBSTONE, counter);
        if (counter.count > 0) receiptsPseudonymized += 1;
      }
    }
    for (const event of this.store.auditEvents || []) {
      if (event?.actor_ref === cloudUserId && String(event.resource_kind || "").startsWith("place_report")) {
        event.actor_ref = DELETED_USER_TOMBSTONE;
      }
    }
    this.store._rebuildIndexes?.();
    return {
      reports_detached: reportsDetached,
      notes_redacted: notesRedacted,
      flags_detached: flagsDetached,
      reviews_detached: reviewsDetached,
      review_notes_redacted: reviewNotesRedacted,
      subscriptions_deleted: subscriptionsDeleted,
      idempotency_receipts_deleted: receiptsDeleted,
      idempotency_receipts_pseudonymized: receiptsPseudonymized,
      idempotency_receipt_flag_details_redacted: receiptFlagDetailsRedacted
    };
  }
}
