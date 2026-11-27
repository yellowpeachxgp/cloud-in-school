import crypto from "node:crypto";
import { ContractError } from "../../contracts/src/index.mjs";

export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PRE_RENAME_STAGES = new Set(["tmp_open", "tmp_write", "tmp_fsync", "tmp_close", "rename"]);
export const LEDGER_DELETED_USER_TOMBSTONE = "00000000-0000-0000-0000-000000000000";

export const LEDGER_IDEMPOTENCY_OPS = Object.freeze([
  "createLedgerEntry",
  "amendLedgerEntry",
  "createSettlement",
  "confirmSettlement",
  "cancelSettlement",
  "createDutyRota",
  "updateDutyRota",
  "completeDutyTask",
  "confirmDutyTaskCompletion",
  "skipDutyTask",
  "requestDutySwap",
  "resolveDutySwap",
  "createRepairTicket",
  "updateRepairTicket",
  "transitionRepairStatus",
  "submitRepairReview"
]);

export function iso(nowMs) {
  return new Date(nowMs).toISOString();
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function badRequest(message) {
  return new ContractError("BAD_REQUEST", message);
}

export function requireString(value, field, { min = 1, max = Infinity, trim = true } = {}) {
  if (typeof value !== "string") throw badRequest(field + " must be a string");
  const clean = trim ? value.trim() : value;
  if (clean.length < min) throw badRequest(field + " must not be empty");
  if (clean.length > max) throw badRequest(field + " exceeds maximum length " + max);
  return clean;
}

export function optionalString(value, field, { max = Infinity } = {}) {
  if (value === undefined || value === null) return null;
  return requireString(value, field, { min: 0, max });
}

export function requireUuid(value, field) {
  const clean = requireString(value, field, { max: 64 });
  if (!UUID_RE.test(clean)) throw badRequest(field + " must be a UUID");
  return clean;
}

export function requireAllowed(value, allowed, field) {
  if (!allowed.has(value)) throw badRequest(field + " is not an allowed value");
  return value;
}

export function requireNoUnknownFields(body, allowedFields, label) {
  if (!isPlainObject(body)) throw badRequest(label + " must be a JSON object");
  for (const key of Object.keys(body)) {
    if (!allowedFields.includes(key)) throw badRequest(label + " contains unsupported field: " + key);
  }
}

export function parseDateTimeMs(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw badRequest(field + " must be an RFC3339 date-time string with an explicit timezone");
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw badRequest(field + " must be a valid date-time");
  return ms;
}

export function normalizeDateTimeIso(value, field) {
  return new Date(parseDateTimeMs(value, field)).toISOString();
}

export function parseLimit(raw, fallback = 20) {
  if (raw == null || raw === "") return fallback;
  if (!/^\d+$/.test(String(raw))) throw badRequest("limit must be an integer");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) throw badRequest("limit must be between 1 and 100");
  return value;
}

export function normalizeBearerHeaders(headers = {}) {
  return {
    idempotencyKey:
      headers["idempotency-key"] ||
      headers["Idempotency-Key"] ||
      headers["IDEMPOTENCY-KEY"] ||
      null
  };
}

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function sortedByTimeThenId(rows, timeField, { descending = false } = {}) {
  return [...rows].sort((a, b) => {
    const at = Date.parse(a[timeField] || 0);
    const bt = Date.parse(b[timeField] || 0);
    if (at !== bt) return descending ? bt - at : at - bt;
    const aid = String(a.id || a.entry_id || a.settlement_id || a.rota_id || a.task_id || a.swap_id || a.repair_id || "");
    const bid = String(b.id || b.entry_id || b.settlement_id || b.rota_id || b.task_id || b.swap_id || b.repair_id || "");
    return descending ? bid.localeCompare(aid) : aid.localeCompare(bid);
  });
}

export function paginateRows(rows, { cursor, limit }, idForRow) {
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

export function mutateObject(obj, patch, undo) {
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

export function setMapCommitted(map, key, value, undo) {
  const had = map.has(key);
  const before = map.get(key);
  map.set(key, value);
  undo.push(() => {
    if (had) map.set(key, before);
    else map.delete(key);
  });
}

export function pushArrayCommitted(array, value, undo) {
  array.push(value);
  undo.push(() => {
    const index = array.lastIndexOf(value);
    if (index >= 0) array.splice(index, 1);
  });
}

export function pseudonymizeExactUserIdRefs(value, cloudUserId, tombstone = LEDGER_DELETED_USER_TOMBSTONE, counter = { count: 0 }) {
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

export class DormCollaborationBase {
  constructor(store) {
    this.store = store;
    for (const [field, comment] of [
      ["ledgerEntries", "entryId -> immutable ledger posting"],
      ["ledgerBalanceRevisions", "groupId -> monotonic integer revision"],
      ["settlements", "settlementId -> two-party settlement record"],
      ["dutyRotas", "rotaId -> duty rotation"],
      ["dutyTasks", "taskId -> generated duty task"],
      ["dutySwaps", "swapId -> swap/cover audit record"],
      ["repairTickets", "repairId -> informal repair ticket"],
      ["repairReviews", "reviewId -> one-time reporter review"],
      ["repairTicketRevisions", "revisionId -> immutable repair edit audit row"]
    ]) {
      if (!this.store[field]) this.store[field] = new Map();
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
        throw new ContractError("STORAGE_PERSISTENCE_FAILED", "提交未能持久化，请稍后按原 Idempotency-Key 重试；未产生半提交状态");
      }
      throw new ContractError("STORAGE_COMMIT_UNKNOWN", "提交结果未知：快照可能已发布但核验失败。请携带原 Idempotency-Key 重试以对账，不要另起新键", {
        persist_stage: stage,
        durability: "UNKNOWN",
        retry_same_key: true
      });
    }
  }

  _activeSchoolBindings(cloudUserId) {
    return Array.from(this.store.schoolBindings.values()).filter((binding) =>
      binding && binding.cloud_user_id === cloudUserId && !binding.revoked_at && binding.status === "DELEGATED_ACTIVE"
    );
  }

  _requireSchoolBinding(auth, schoolId) {
    const cleanSchoolId = requireString(schoolId, "school_id", { max: 80 });
    const activeBindings = this._activeSchoolBindings(auth.cloudUserId);
    const binding = activeBindings.find((row) => (row.school_id || "haut") === cleanSchoolId);
    if (binding) return binding;
    if (activeBindings.length === 0) {
      throw new ContractError("CAMPUS_BINDING_REQUIRED", "A verified active campus binding is required before using school-scoped dorm collaboration");
    }
    throw new ContractError("SCHOOL_SCOPE_MISMATCH", "Requested resource belongs to a different school_id isolation scope");
  }

  _activeMembersForGroup(groupId) {
    return Array.from(this.store.groupMembers.values()).filter((member) => member.group_id === groupId && member.status === "ACTIVE");
  }

  _activeMembership(groupId, cloudUserId) {
    return Array.from(this.store.groupMembers.values()).find((member) =>
      member.group_id === groupId && member.cloud_user_id === cloudUserId && member.status === "ACTIVE"
    );
  }

  _requireActiveGroup(groupId) {
    const cleanGroupId = requireUuid(groupId, "groupId");
    const group = this.store.groups.get(cleanGroupId);
    if (!group || group.status !== "ACTIVE") throw new ContractError("GROUP_NOT_FOUND", "Group does not exist, is archived, or is not visible");
    return group;
  }

  _requireVisibleMember(group, auth) {
    this._requireSchoolBinding(auth, group.school_id);
    const member = this._activeMembership(group.id, auth.cloudUserId);
    if (!member) throw new ContractError("GROUP_NOT_FOUND", "Group is not visible in the caller school scope");
    return member;
  }

  _requireGroupManager(group, auth, permissionCode = "GROUP_PERMISSION_DENIED") {
    const member = this._requireVisibleMember(group, auth);
    if (!["OWNER", "ADMIN"].includes(member.role)) throw new ContractError(permissionCode, "Group owner or admin role is required");
    return member;
  }

  _requireDirectResourceMember(group, auth, permissionCode) {
    this._requireSchoolBinding(auth, group.school_id);
    const member = this._activeMembership(group.id, auth.cloudUserId);
    if (!member) throw new ContractError(permissionCode, "Caller is not an active group member allowed to access this resource");
    return member;
  }

  _memberById(memberId) {
    return this.store.groupMembers.get(memberId) || null;
  }

  _memberCloudUserId(memberId) {
    return this._memberById(memberId)?.cloud_user_id || null;
  }

  _samePersonAsMember(memberId, cloudUserId) {
    const owner = this._memberCloudUserId(memberId);
    return Boolean(owner && owner === cloudUserId);
  }

  _activeMemberById(groupId, memberId) {
    const member = this._memberById(memberId);
    return member && member.group_id === groupId && member.status === "ACTIVE" ? member : null;
  }

  _appendOutboxEvent({ aggregateType, aggregateId, eventType, payload, occurredAt }, undo) {
    pushArrayCommitted(this.store.outboxEvents, {
      id: payload.event_id,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      event_type: eventType,
      payload_json: payload,
      created_at: occurredAt,
      delivered_at: null
    }, undo);
    return payload;
  }
}
