import crypto from "node:crypto";
import { ContractError } from "../../contracts/src/index.mjs";

const GROUP_SHARING_LEVELS = new Set(["NONE", "BUSY_BLOCKS_30MIN"]);
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const MIN_TTL_SECONDS = 30 * 60;
const MAX_TTL_SECONDS = 90 * 24 * 60 * 60;
const DELETED_USER_TOMBSTONE = "00000000-0000-0000-0000-000000000000";
const PRE_RENAME_STAGES = new Set(["tmp_open", "tmp_write", "tmp_fsync", "tmp_close", "rename"]);

const AVAILABILITY_IDEMPOTENCY_OPS = Object.freeze([
  "replaceMyGroupAvailability",
  "deleteMyGroupAvailability",
  "queryGroupAvailability",
  "createGroupPoll",
  "upsertGroupPollVote",
  "confirmGroupPoll"
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
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
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

function availabilityBlockInvalid(message) {
  return new ContractError("AVAILABILITY_BLOCK_INVALID", message);
}

function availabilityQueryInvalid(message) {
  return new ContractError("AVAILABILITY_QUERY_INVALID", message);
}

function pollOptionInvalid(message) {
  return new ContractError("POLL_OPTION_INVALID", message);
}

function requireString(value, field, { min = 1, max = Infinity, trim = true } = {}) {
  if (typeof value !== "string") throw badRequest(field + " must be a string");
  const clean = trim ? value.trim() : value;
  if (clean.length < min) throw badRequest(field + " must not be empty");
  if (clean.length > max) throw badRequest(field + " exceeds maximum length " + max);
  return clean;
}

function requireUuid(value, field) {
  const clean = requireString(value, field, { max: 64 });
  if (!UUID_RE.test(clean)) throw badRequest(field + " must be a UUID");
  return clean;
}

function requireNoUnknownFields(body, allowedFields, label, errorFactory = badRequest) {
  if (!isPlainObject(body)) throw errorFactory(label + " must be a JSON object");
  for (const key of Object.keys(body)) {
    if (!allowedFields.includes(key)) {
      throw errorFactory(label + " contains unsupported field: " + key);
    }
  }
}

function requireInteger(value, field, { min = -Infinity, max = Infinity, multipleOf = null, errorFactory = badRequest } = {}) {
  if (!Number.isInteger(value)) throw errorFactory(field + " must be an integer");
  if (value < min || value > max) throw errorFactory(field + " must be between " + min + " and " + max);
  if (multipleOf !== null && value % multipleOf !== 0) {
    throw errorFactory(field + " must be a whole multiple of " + multipleOf);
  }
  return value;
}

function parseDateTimeMs(value, field, errorFactory = badRequest) {
  if (typeof value !== "string") {
    throw errorFactory(field + " must be an RFC3339 date-time string with an explicit timezone");
  }
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!match) {
    throw errorFactory(field + " must be an RFC3339 date-time string with an explicit timezone");
  }
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, offsetRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  if (
    month < 1 || month > 12 || day < 1 || day > 31 ||
    hour > 23 || minute > 59 || second > 59
  ) {
    throw errorFactory(field + " must be a valid RFC3339 date-time");
  }
  if (offsetRaw !== "Z") {
    const offsetMatch = offsetRaw.match(/^[+-](\d{2}):(\d{2})$/);
    if (!offsetMatch || Number(offsetMatch[1]) > 23 || Number(offsetMatch[2]) > 59) {
      throw errorFactory(field + " has an invalid timezone offset");
    }
  }
  const calendarMs = Date.UTC(year, month - 1, day);
  const calendar = new Date(calendarMs);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    throw errorFactory(field + " must be a valid calendar date");
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw errorFactory(field + " must be a valid date-time");
  return ms;
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
  undo.push(() => {
    map.set(key, before);
  });
}

function pushArrayCommitted(array, value, undo) {
  array.push(value);
  undo.push(() => {
    const index = array.lastIndexOf(value);
    if (index >= 0) array.splice(index, 1);
  });
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function compareBlocks(a, b) {
  const startDiff = Date.parse(a.start_at) - Date.parse(b.start_at);
  if (startDiff !== 0) return startDiff;
  const endDiff = Date.parse(a.end_at) - Date.parse(b.end_at);
  if (endDiff !== 0) return endDiff;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function compareMembers(a, b) {
  const joinedDiff = Date.parse(a.joined_at || 0) - Date.parse(b.joined_at || 0);
  if (joinedDiff !== 0) return joinedDiff;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function validateQuantizedWindow(block, label, errorFactory) {
  requireNoUnknownFields(block, ["start_at", "end_at"], label, errorFactory);
  const startMs = parseDateTimeMs(block.start_at, label + ".start_at", errorFactory);
  const endMs = parseDateTimeMs(block.end_at, label + ".end_at", errorFactory);
  if (endMs <= startMs) throw errorFactory(label + ".end_at must be after start_at");
  if (endMs - startMs < THIRTY_MINUTES_MS) {
    throw errorFactory(label + " must last at least 30 minutes");
  }
  if (startMs % THIRTY_MINUTES_MS !== 0 || endMs % THIRTY_MINUTES_MS !== 0) {
    throw errorFactory(label + " must start and end on an absolute 30-minute boundary");
  }
  if ((endMs - startMs) % THIRTY_MINUTES_MS !== 0) {
    throw errorFactory(label + " duration must be a whole multiple of 30 minutes");
  }
  return { startMs, endMs };
}

function validateBlockSet(blocks) {
  if (!Array.isArray(blocks)) throw availabilityBlockInvalid("blocks must be an array");
  if (blocks.length > 200) throw availabilityBlockInvalid("blocks must contain at most 200 entries");
  const parsed = blocks.map((block, index) => ({
    ...validateQuantizedWindow(block, "blocks[" + index + "]", availabilityBlockInvalid),
    index
  }));
  const sorted = [...parsed].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].startMs < sorted[index - 1].endMs) {
      throw availabilityBlockInvalid("blocks must be non-overlapping and must not contain duplicate windows");
    }
  }
  return parsed
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map(({ startMs, endMs }) => ({ startMs, endMs }));
}

function ensureAvailabilityCollections(store) {
  if (!store.availabilityShares) store.availabilityShares = new Map();
  if (!store.busyBlocks) store.busyBlocks = new Map();
  if (!store.meetingPolls) store.meetingPolls = new Map();
  if (!store.pollOptions) store.pollOptions = new Map();
  if (!store.pollVotes) store.pollVotes = new Map();
  if (!store.confirmedGroupEvents) store.confirmedGroupEvents = new Map();
}

function appendAvailabilityUpdatedEvent(store, { group, member, actorCloudUserId, share, reason, occurredAt, blockCount, expiresAt }, undo) {
  const eventId = crypto.randomUUID();
  const payload = {
    event_id: eventId,
    event_key:
      "dis:group:" + group.id + ":availability:" + member.id + ":revision:" + share.revision + ":v1",
    event_type: "updated",
    occurred_at: occurredAt,
    group_id: group.id,
    school_id: group.school_id,
    member_id: member.id,
    cloud_user_id: member.cloud_user_id,
    actor_cloud_user_id: actorCloudUserId,
    sharing_level: member.sharing_level,
    revision: share.revision,
    block_count: blockCount,
    expires_at: expiresAt,
    reason
  };
  pushArrayCommitted(
    store.outboxEvents,
    {
      id: eventId,
      aggregate_type: "group_availability",
      aggregate_id: member.id,
      event_type: "group.availability.updated",
      payload_json: payload,
      created_at: occurredAt,
      delivered_at: null
    },
    undo
  );
  return payload;
}

function deleteBlocksForMember(store, memberId, undo) {
  let deleted = 0;
  for (const [blockId, block] of Array.from(store.busyBlocks.entries())) {
    if (block.member_id !== memberId) continue;
    deleteMapCommitted(store.busyBlocks, blockId, undo);
    deleted += 1;
  }
  return deleted;
}

export function withdrawAvailabilityForMembershipTransition(
  store,
  group,
  member,
  actorCloudUserId,
  occurredAt,
  undo
) {
  ensureAvailabilityCollections(store);
  const removedBlocks = deleteBlocksForMember(store, member.id, undo);
  const hadSharing = member.sharing_level !== "NONE";
  let share = store.availabilityShares.get(member.id) || null;
  const hadActiveShare = share?.status === "ACTIVE";
  if (!hadActiveShare && !hadSharing) {
    return { withdrawn: false, revision: share?.revision ?? null, removed_blocks: removedBlocks };
  }

  if (member.sharing_level !== "NONE") {
    mutateObject(member, { sharing_level: "NONE" }, undo);
  }

  if (!share) {
    share = {
      member_id: member.id,
      group_id: group.id,
      school_id: group.school_id,
      revision: 1,
      status: "WITHDRAWN",
      ttl_seconds: MIN_TTL_SECONDS,
      expires_at: occurredAt,
      created_at: occurredAt,
      updated_at: occurredAt,
      withdrawn_at: occurredAt,
      expired_at: null
    };
    setMapCommitted(store.availabilityShares, member.id, share, undo);
  } else {
    mutateObject(
      share,
      {
        revision: Number(share.revision || 0) + 1,
        status: "WITHDRAWN",
        updated_at: occurredAt,
        withdrawn_at: occurredAt,
        expired_at: null
      },
      undo
    );
  }

  appendAvailabilityUpdatedEvent(
    store,
    {
      group,
      member,
      actorCloudUserId,
      share,
      reason: "SHARE_WITHDRAWN",
      occurredAt,
      blockCount: 0,
      expiresAt: null
    },
    undo
  );
  return { withdrawn: true, revision: share.revision, removed_blocks: removedBlocks };
}

function pseudonymizeUserIdRefs(value, cloudUserId, tombstone, counter) {
  if (typeof value === "string") {
    if (value === cloudUserId) {
      counter.count += 1;
      return tombstone;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => pseudonymizeUserIdRefs(entry, cloudUserId, tombstone, counter));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = pseudonymizeUserIdRefs(value[key], cloudUserId, tombstone, counter);
    }
    return out;
  }
  return value;
}

export class AvailabilityService {
  constructor(store) {
    this.store = store;
    ensureAvailabilityCollections(this.store);
  }

  _idempotency(operation, auth, headers, body, targetFingerprint = null) {
    const { idempotencyKey } = normalizeBearerHeaders(headers);
    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 128
    ) {
      throw badRequest("Idempotency-Key header is required and must be 8..128 characters");
    }
    const normalizedBody = body === undefined || body === null ? {} : body;
    const fingerprintBody = targetFingerprint
      ? { target: targetFingerprint, body: normalizedBody }
      : normalizedBody;
    const bodyHash = sha256Json(fingerprintBody);
    const canonicalHash = sha256Json(canonicalize(fingerprintBody));
    const cacheKey = operation + "|" + auth.cloudUserId + "|" + idempotencyKey;
    const existing = this.store.idempotencyRecords.get(cacheKey);
    if (existing) {
      const matches =
        existing.hashVersion === 2
          ? existing.canonicalHash === canonicalHash
          : existing.bodyHash === bodyHash;
      if (!matches) {
        throw new ContractError("CONFLICT", "Idempotency-Key reused with different request payload");
      }
      return {
        replay: {
          status: 200,
          code: "REQUEST_DUPLICATE",
          data: clone(existing.data),
          ...(existing.headers ? { headers: clone(existing.headers) } : {})
        }
      };
    }
    return {
      replay: null,
      receipt: {
        cacheKey,
        bodyHash,
        canonicalHash
      }
    };
  }

  _commitWithReceipt(apply, receipt, nowMs) {
    const undo = [];
    let flushStarted = false;
    const rollback = () => {
      for (let index = undo.length - 1; index >= 0; index -= 1) {
        try {
          undo[index]();
        } catch {
          // Best-effort inverse; indexes are rebuilt below either way.
        }
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
      if (typeof this.store.flushSnapshotStrictSync === "function") {
        this.store.flushSnapshotStrictSync();
      } else if (typeof this.store.flushSnapshotSync === "function") {
        this.store.flushSnapshotSync();
      } else if (typeof this.store.saveSnapshot === "function") {
        this.store.saveSnapshot();
      }
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
      if (
        err?.commitPublished === false ||
        (err?.commitPublished !== true && (!stage || PRE_RENAME_STAGES.has(stage)))
      ) {
        rollback();
        throw new ContractError(
          "STORAGE_PERSISTENCE_FAILED",
          "忙闲或投票提交未能持久化，请稍后按原 Idempotency-Key 重试；未产生半提交状态"
        );
      }
      throw new ContractError(
        "STORAGE_COMMIT_UNKNOWN",
        "忙闲或投票提交结果未知：快照可能已发布但核验失败。请携带原 Idempotency-Key 重试以对账，不要另起新键",
        { persist_stage: stage, durability: "UNKNOWN", retry_same_key: true }
      );
    }
  }

  _activeSchoolBindings(cloudUserId) {
    return Array.from(this.store.schoolBindings.values()).filter(
      (binding) =>
        binding &&
        binding.cloud_user_id === cloudUserId &&
        !binding.revoked_at &&
        binding.status === "DELEGATED_ACTIVE"
    );
  }

  _requireSchoolBinding(auth, schoolId) {
    const cleanSchoolId = requireString(schoolId, "school_id", { max: 80 });
    const activeBindings = this._activeSchoolBindings(auth.cloudUserId);
    const binding = activeBindings.find((row) => (row.school_id || "haut") === cleanSchoolId);
    if (binding) return binding;
    if (activeBindings.length === 0) {
      throw new ContractError(
        "CAMPUS_BINDING_REQUIRED",
        "A verified active campus binding is required before using school-scoped availability"
      );
    }
    throw new ContractError(
      "SCHOOL_SCOPE_MISMATCH",
      "Requested availability resource belongs to a different school_id isolation scope"
    );
  }

  _activeMembership(groupId, cloudUserId) {
    return Array.from(this.store.groupMembers.values()).find(
      (member) =>
        member.group_id === groupId &&
        member.cloud_user_id === cloudUserId &&
        member.status === "ACTIVE"
    );
  }

  _activeMembersForGroup(groupId) {
    return Array.from(this.store.groupMembers.values())
      .filter((member) => member.group_id === groupId && member.status === "ACTIVE")
      .sort(compareMembers);
  }

  _requireActiveGroup(groupId) {
    const cleanGroupId = requireUuid(groupId, "groupId");
    const group = this.store.groups.get(cleanGroupId);
    if (!group || group.status !== "ACTIVE") {
      throw new ContractError("GROUP_NOT_FOUND", "Group does not exist, is archived, or is not visible");
    }
    return group;
  }

  _requireVisibleMember(group, auth) {
    this._requireSchoolBinding(auth, group.school_id);
    const member = this._activeMembership(group.id, auth.cloudUserId);
    if (!member) {
      throw new ContractError("GROUP_NOT_FOUND", "Group is not visible in the caller school scope");
    }
    return member;
  }

  _blocksForMember(memberId) {
    return Array.from(this.store.busyBlocks.values())
      .filter((block) => block.member_id === memberId)
      .sort(compareBlocks)
      .map((block) => ({
        start_at: block.start_at,
        end_at: block.end_at
      }));
  }

  _shareView(share) {
    const blocks = this._blocksForMember(share.member_id);
    return {
      group_id: share.group_id,
      school_id: share.school_id,
      member_id: share.member_id,
      sharing_level: "BUSY_BLOCKS_30MIN",
      blocks,
      block_count: blocks.length,
      ttl_seconds: share.ttl_seconds,
      expires_at: share.expires_at,
      updated_at: share.updated_at
    };
  }

  _expireShares(nowMs, undo) {
    const ts = iso(nowMs);
    for (const share of Array.from(this.store.availabilityShares.values())) {
      if (share.status !== "ACTIVE" || Date.parse(share.expires_at) > nowMs) continue;
      deleteBlocksForMember(this.store, share.member_id, undo);
      mutateObject(
        share,
        {
          revision: Number(share.revision || 0) + 1,
          status: "EXPIRED",
          updated_at: ts,
          expired_at: ts,
          withdrawn_at: null
        },
        undo
      );
      const member = this.store.groupMembers.get(share.member_id);
      const group = this.store.groups.get(share.group_id);
      if (member && member.sharing_level !== "NONE") {
        mutateObject(member, { sharing_level: "NONE" }, undo);
      }
      if (member && group) {
        appendAvailabilityUpdatedEvent(
          this.store,
          {
            group,
            member,
            actorCloudUserId: member.cloud_user_id,
            share,
            reason: "TTL_EXPIRED",
            occurredAt: ts,
            blockCount: 0,
            expiresAt: share.expires_at
          },
          undo
        );
      }
    }
  }

  _appendConflictEvents({ group, member, share, blocks, occurredAt }, undo) {
    if (!blocks.length) return [];
    const payloads = [];
    for (const confirmed of Array.from(this.store.confirmedGroupEvents.values())) {
      if (confirmed.group_id !== group.id || confirmed.school_id !== group.school_id) continue;
      if (confirmed.status !== "CONFIRMED") continue;
      const confirmedStart = Date.parse(confirmed.start_at);
      const confirmedEnd = Date.parse(confirmed.end_at);
      const overlapping = blocks
        .filter((block) => overlaps(block.startMs, block.endMs, confirmedStart, confirmedEnd))
        .sort((a, b) => a.startMs - b.startMs)[0];
      if (!overlapping) continue;
      const overlapStart = Math.max(overlapping.startMs, confirmedStart);
      const overlapEnd = Math.min(overlapping.endMs, confirmedEnd);
      const eventId = crypto.randomUUID();
      const payload = {
        event_id: eventId,
        event_key:
          "dis:group:" + group.id + ":event:" + confirmed.id + ":member:" + member.id +
          ":conflict:" + share.revision + ":v1",
        event_type: "conflict_detected",
        occurred_at: occurredAt,
        group_id: group.id,
        school_id: group.school_id,
        confirmed_event_id: confirmed.id,
        poll_id: confirmed.poll_id,
        option_id: confirmed.option_id,
        member_id: member.id,
        cloud_user_id: member.cloud_user_id,
        availability_revision: share.revision,
        overlap_start_at: iso(overlapStart),
        overlap_end_at: iso(overlapEnd),
        automatic_rescheduling: false
      };
      pushArrayCommitted(
        this.store.outboxEvents,
        {
          id: eventId,
          aggregate_type: "group_event_conflict",
          aggregate_id: confirmed.id,
          event_type: "group.event.conflict_detected",
          payload_json: payload,
          created_at: occurredAt,
          delivered_at: null
        },
        undo
      );
      payloads.push(payload);
    }
    return payloads;
  }

  replaceMyGroupAvailability(auth, params, body, headers, nowMs = Date.now()) {
    const idem = this._idempotency(
      "replaceMyGroupAvailability",
      auth,
      headers,
      body,
      String(params?.groupId || "")
    );
    if (idem.replay) return idem.replay;
    requireNoUnknownFields(body, ["blocks", "ttl_seconds"], "ReplaceGroupAvailabilityRequest");
    const ttlSeconds = requireInteger(body.ttl_seconds, "ttl_seconds", {
      min: MIN_TTL_SECONDS,
      max: MAX_TTL_SECONDS,
      errorFactory: availabilityBlockInvalid
    });
    const blocks = validateBlockSet(body.blocks);
    const group = this._requireActiveGroup(params.groupId);
    const member = this._requireVisibleMember(group, auth);

    return this._commitWithReceipt((undo) => {
      this._expireShares(nowMs, undo);
      const ts = iso(nowMs);
      const expiresAt = iso(nowMs + ttlSeconds * 1000);
      const existing = this.store.availabilityShares.get(member.id) || null;
      const nextRevision = Number(existing?.revision || 0) + 1;
      const sharePatch = {
        revision: nextRevision,
        status: "ACTIVE",
        ttl_seconds: ttlSeconds,
        expires_at: expiresAt,
        created_at: existing?.created_at || ts,
        updated_at: ts,
        withdrawn_at: null,
        expired_at: null
      };
      let share;
      if (existing) {
        mutateObject(existing, sharePatch, undo);
        share = existing;
      } else {
        share = {
          member_id: member.id,
          group_id: group.id,
          school_id: group.school_id,
          ...sharePatch
        };
        setMapCommitted(this.store.availabilityShares, member.id, share, undo);
      }

      deleteBlocksForMember(this.store, member.id, undo);
      for (const block of blocks) {
        const row = {
          id: crypto.randomUUID(),
          member_id: member.id,
          group_id: group.id,
          school_id: group.school_id,
          start_at: iso(block.startMs),
          end_at: iso(block.endMs),
          created_at: ts
        };
        setMapCommitted(this.store.busyBlocks, row.id, row, undo);
      }
      if (member.sharing_level !== "BUSY_BLOCKS_30MIN") {
        mutateObject(member, { sharing_level: "BUSY_BLOCKS_30MIN" }, undo);
      }

      appendAvailabilityUpdatedEvent(
        this.store,
        {
          group,
          member,
          actorCloudUserId: auth.cloudUserId,
          share,
          reason: "SHARE_REPLACED",
          occurredAt: ts,
          blockCount: blocks.length,
          expiresAt
        },
        undo
      );
      this._appendConflictEvents({ group, member, share, blocks, occurredAt: ts }, undo);

      return {
        status: 200,
        code: "GROUP_AVAILABILITY_REPLACED",
        data: this._shareView(share)
      };
    }, idem.receipt, nowMs);
  }

  deleteMyGroupAvailability(auth, params, headers, nowMs = Date.now()) {
    const idem = this._idempotency(
      "deleteMyGroupAvailability",
      auth,
      headers,
      {},
      String(params?.groupId || "")
    );
    if (idem.replay) return idem.replay;
    const group = this._requireActiveGroup(params.groupId);
    const member = this._requireVisibleMember(group, auth);
    return this._commitWithReceipt((undo) => {
      this._expireShares(nowMs, undo);
      const ts = iso(nowMs);
      const outcome = withdrawAvailabilityForMembershipTransition(
        this.store,
        group,
        member,
        auth.cloudUserId,
        ts,
        undo
      );
      return {
        status: 200,
        code: "GROUP_AVAILABILITY_WITHDRAWN",
        data: {
          group_id: group.id,
          member_id: member.id,
          withdrawn: true,
          already_withdrawn: !outcome.withdrawn,
          sharing_level: "NONE",
          revision: outcome.revision,
          withdrawn_at: ts
        }
      };
    }, idem.receipt, nowMs);
  }

  queryGroupAvailability(auth, params, body, headers, nowMs = Date.now()) {
    const idem = this._idempotency(
      "queryGroupAvailability",
      auth,
      headers,
      body,
      String(params?.groupId || "")
    );
    if (idem.replay) return idem.replay;
    requireNoUnknownFields(
      body,
      ["window_start_at", "window_end_at", "duration_minutes", "min_attendees", "member_ids", "granularity_minutes"],
      "GroupAvailabilityQueryRequest"
    );
    const granularity = body.granularity_minutes === undefined
      ? 30
      : requireInteger(body.granularity_minutes, "granularity_minutes", {
          min: 30,
          multipleOf: 30,
          errorFactory: availabilityQueryInvalid
        });
    const durationMinutes = requireInteger(body.duration_minutes, "duration_minutes", {
      min: 30,
      multipleOf: 30,
      errorFactory: availabilityQueryInvalid
    });
    const minAttendees = requireInteger(body.min_attendees, "min_attendees", {
      min: 1,
      errorFactory: availabilityQueryInvalid
    });
    const windowStartMs = parseDateTimeMs(body.window_start_at, "window_start_at", availabilityQueryInvalid);
    const windowEndMs = parseDateTimeMs(body.window_end_at, "window_end_at", availabilityQueryInvalid);
    const granularityMs = granularity * 60_000;
    const durationMs = durationMinutes * 60_000;
    if (windowEndMs <= windowStartMs) {
      throw availabilityQueryInvalid("window_end_at must be after window_start_at");
    }
    if (windowStartMs % granularityMs !== 0 || windowEndMs % granularityMs !== 0) {
      throw availabilityQueryInvalid("query window boundaries must align to granularity_minutes");
    }
    if (durationMs > windowEndMs - windowStartMs) {
      throw availabilityQueryInvalid("duration_minutes must fit inside the query window");
    }
    let memberIds = null;
    if (body.member_ids !== undefined) {
      if (!Array.isArray(body.member_ids) || body.member_ids.length > 100) {
        throw availabilityQueryInvalid("member_ids must be an array of at most 100 membership IDs");
      }
      memberIds = body.member_ids.map((value, index) => {
        if (typeof value !== "string" || !UUID_RE.test(value)) {
          throw availabilityQueryInvalid("member_ids[" + index + "] must be a UUID");
        }
        return value;
      });
      if (new Set(memberIds).size !== memberIds.length) {
        throw availabilityQueryInvalid("member_ids must not contain duplicates");
      }
    }

    const group = this._requireActiveGroup(params.groupId);
    this._requireVisibleMember(group, auth);
    return this._commitWithReceipt((undo) => {
      this._expireShares(nowMs, undo);
      const activeMembers = this._activeMembersForGroup(group.id);
      let members = activeMembers;
      if (memberIds !== null) {
        const byId = new Map(activeMembers.map((member) => [member.id, member]));
        members = memberIds.map((memberId) => {
          const member = byId.get(memberId);
          if (!member) {
            throw availabilityQueryInvalid("member_ids must reference active members of this group");
          }
          return member;
        });
      }
      if (minAttendees > members.length) {
        throw availabilityQueryInvalid("min_attendees cannot exceed the evaluated active member count");
      }

      const candidates = [];
      const lastStart = windowEndMs - durationMs;
      for (let startMs = windowStartMs; startMs <= lastStart; startMs += granularityMs) {
        const endMs = startMs + durationMs;
        const memberResults = members.map((member) => {
          const share = this.store.availabilityShares.get(member.id);
          const effectiveShare =
            member.sharing_level === "BUSY_BLOCKS_30MIN" &&
            share &&
            share.status === "ACTIVE" &&
            Date.parse(share.expires_at) > nowMs;
          let status = "UNKNOWN";
          if (effectiveShare) {
            const busy = Array.from(this.store.busyBlocks.values()).some(
              (block) =>
                block.member_id === member.id &&
                overlaps(startMs, endMs, Date.parse(block.start_at), Date.parse(block.end_at))
            );
            status = busy ? "BUSY" : "AVAILABLE";
          }
          return {
            member_id: member.id,
            status,
            sharing_level: member.sharing_level
          };
        });
        const available = memberResults.filter((row) => row.status === "AVAILABLE").length;
        if (available < minAttendees) continue;
        candidates.push({
          start_at: iso(startMs),
          end_at: iso(endMs),
          available_member_count: available,
          busy_member_count: memberResults.filter((row) => row.status === "BUSY").length,
          unknown_member_count: memberResults.filter((row) => row.status === "UNKNOWN").length,
          total_member_count: memberResults.length,
          member_results: memberResults
        });
      }

      return {
        status: 200,
        code: "GROUP_AVAILABILITY_QUERIED",
        data: {
          group_id: group.id,
          school_id: group.school_id,
          window_start_at: iso(windowStartMs),
          window_end_at: iso(windowEndMs),
          duration_minutes: durationMinutes,
          granularity_minutes: granularity,
          min_attendees: minAttendees,
          generated_at: iso(nowMs),
          candidates
        }
      };
    }, idem.receipt, nowMs);
  }

  createGroupPoll(auth, params, body, headers, nowMs = Date.now()) {
    const idem = this._idempotency(
      "createGroupPoll",
      auth,
      headers,
      body,
      String(params?.groupId || "")
    );
    if (idem.replay) return idem.replay;
    requireNoUnknownFields(body, ["title", "options", "voting_deadline_at"], "CreateGroupPollRequest");
    if (typeof body.title !== "string" || body.title.trim().length < 1 || body.title.trim().length > 120) {
      throw pollOptionInvalid("title must be a non-empty string of at most 120 characters");
    }
    const title = body.title.trim();
    if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 10) {
      throw pollOptionInvalid("options must contain between 2 and 10 time windows");
    }
    const options = body.options.map((option, index) => ({
      ...validateQuantizedWindow(option, "options[" + index + "]", pollOptionInvalid),
      position: index
    }));
    const exactWindows = new Set();
    for (const option of options) {
      const key = option.startMs + "/" + option.endMs;
      if (exactWindows.has(key)) throw pollOptionInvalid("options must not contain exact duplicate time windows");
      exactWindows.add(key);
    }
    const deadlineMs = parseDateTimeMs(body.voting_deadline_at, "voting_deadline_at", pollOptionInvalid);
    if (deadlineMs <= nowMs) throw pollOptionInvalid("voting_deadline_at must be in the future");
    const earliestStart = Math.min(...options.map((option) => option.startMs));
    if (deadlineMs > earliestStart) {
      throw pollOptionInvalid("voting_deadline_at must be no later than the earliest option start");
    }

    const group = this._requireActiveGroup(params.groupId);
    const member = this._requireVisibleMember(group, auth);
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const poll = {
        id: crypto.randomUUID(),
        group_id: group.id,
        school_id: group.school_id,
        title,
        status: "OPEN",
        voting_deadline_at: iso(deadlineMs),
        created_by_member_id: member.id,
        created_at: ts,
        closed_at: null,
        confirmed_at: null,
        confirmed_option_id: null,
        confirmed_event_id: null
      };
      setMapCommitted(this.store.meetingPolls, poll.id, poll, undo);
      for (const option of options) {
        const row = {
          id: crypto.randomUUID(),
          poll_id: poll.id,
          position: option.position,
          start_at: iso(option.startMs),
          end_at: iso(option.endMs),
          created_at: ts
        };
        setMapCommitted(this.store.pollOptions, row.id, row, undo);
      }
      return {
        status: 201,
        code: "GROUP_POLL_CREATED",
        data: this._pollView(poll, member.id, nowMs),
        headers: { Location: "/api/v1/polls/" + poll.id }
      };
    }, idem.receipt, nowMs);
  }

  _effectivePollStatus(poll, nowMs) {
    if (poll.status === "CONFIRMED") return "CONFIRMED";
    if (poll.status === "CLOSED") return "CLOSED";
    return Date.parse(poll.voting_deadline_at) <= nowMs ? "CLOSED" : "OPEN";
  }

  _pollOptions(pollId) {
    return Array.from(this.store.pollOptions.values())
      .filter((option) => option.poll_id === pollId)
      .sort((a, b) => {
        const positionDiff = Number(a.position || 0) - Number(b.position || 0);
        if (positionDiff !== 0) return positionDiff;
        return compareBlocks(a, b);
      });
  }

  _votesForPoll(pollId) {
    return Array.from(this.store.pollVotes.values()).filter((vote) => vote.poll_id === pollId);
  }

  _voteForMember(pollId, memberId) {
    return Array.from(this.store.pollVotes.values()).find(
      (vote) => vote.poll_id === pollId && vote.member_id === memberId
    ) || null;
  }

  _pollView(poll, memberId, nowMs = Date.now()) {
    const status = this._effectivePollStatus(poll, nowMs);
    const votes = this._votesForPoll(poll.id);
    const mine = memberId ? this._voteForMember(poll.id, memberId) : null;
    const options = this._pollOptions(poll.id).map((option) => {
      const optionVotes = votes.filter((vote) => vote.option_id === option.id);
      return {
        option_id: option.id,
        start_at: option.start_at,
        end_at: option.end_at,
        vote_count: optionVotes.length,
        voter_member_ids: optionVotes.map((vote) => vote.member_id).sort()
      };
    });
    return {
      poll_id: poll.id,
      group_id: poll.group_id,
      school_id: poll.school_id,
      title: poll.title,
      status,
      options,
      voting_deadline_at: poll.voting_deadline_at,
      created_by_member_id: poll.created_by_member_id,
      created_at: poll.created_at,
      closed_at:
        status === "OPEN"
          ? null
          : poll.closed_at || (status === "CLOSED" ? poll.voting_deadline_at : null),
      confirmed_at: poll.confirmed_at ?? null,
      confirmed_option_id: poll.confirmed_option_id ?? null,
      confirmed_event_id: poll.confirmed_event_id ?? null,
      my_vote_option_id: mine?.option_id ?? null
    };
  }

  _requirePollAccess(auth, pollId) {
    const cleanPollId = requireUuid(pollId, "pollId");
    const poll = this.store.meetingPolls.get(cleanPollId);
    if (!poll) {
      throw new ContractError("POLL_NOT_FOUND", "Poll does not exist or is not visible in the caller school scope");
    }
    this._requireSchoolBinding(auth, poll.school_id);
    const member = this._activeMembership(poll.group_id, auth.cloudUserId);
    if (!member) {
      throw new ContractError("POLL_PERMISSION_DENIED", "Caller is not an active member of the poll group");
    }
    return { poll, member };
  }

  _requirePollOption(poll, optionId) {
    const cleanOptionId = requireUuid(optionId, "option_id");
    const option = this.store.pollOptions.get(cleanOptionId);
    if (!option || option.poll_id !== poll.id) {
      throw new ContractError("POLL_OPTION_NOT_FOUND", "Poll option does not exist within the referenced poll");
    }
    return option;
  }

  getGroupPoll(auth, params, nowMs = Date.now()) {
    const { poll, member } = this._requirePollAccess(auth, params.pollId);
    return {
      status: 200,
      code: "GROUP_POLL_OK",
      data: this._pollView(poll, member.id, nowMs)
    };
  }

  _voteView(vote) {
    return {
      vote_id: vote.id,
      poll_id: vote.poll_id,
      member_id: vote.member_id,
      option_id: vote.option_id,
      created_at: vote.created_at,
      updated_at: vote.updated_at
    };
  }

  upsertGroupPollVote(auth, params, body, headers, nowMs = Date.now()) {
    const idem = this._idempotency(
      "upsertGroupPollVote",
      auth,
      headers,
      body,
      String(params?.pollId || "")
    );
    if (idem.replay) return idem.replay;
    requireNoUnknownFields(body, ["option_id"], "UpsertGroupPollVoteRequest");
    const cleanOptionId = requireUuid(body.option_id, "option_id");
    const { poll, member } = this._requirePollAccess(auth, params.pollId);
    if (this._effectivePollStatus(poll, nowMs) === "CONFIRMED") {
      throw new ContractError("POLL_ALREADY_CONFIRMED", "Poll already has a terminal confirmed option");
    }
    if (this._effectivePollStatus(poll, nowMs) === "CLOSED") {
      throw new ContractError("POLL_VOTING_CLOSED", "Voting deadline has passed; no vote or vote change is accepted");
    }
    this._requirePollOption(poll, cleanOptionId);
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      let vote = this._voteForMember(poll.id, member.id);
      if (!vote) {
        vote = {
          id: crypto.randomUUID(),
          poll_id: poll.id,
          group_id: poll.group_id,
          school_id: poll.school_id,
          member_id: member.id,
          option_id: cleanOptionId,
          created_at: ts,
          updated_at: ts
        };
        setMapCommitted(this.store.pollVotes, vote.id, vote, undo);
      } else if (vote.option_id !== cleanOptionId) {
        mutateObject(vote, { option_id: cleanOptionId, updated_at: ts }, undo);
      }
      return {
        status: 200,
        code: "GROUP_POLL_VOTE_UPSERTED",
        data: {
          vote: this._voteView(vote),
          poll: this._pollView(poll, member.id, nowMs)
        }
      };
    }, idem.receipt, nowMs);
  }

  _confirmedEventView(row) {
    return {
      event_id: row.id,
      poll_id: row.poll_id,
      option_id: row.option_id,
      group_id: row.group_id,
      school_id: row.school_id,
      start_at: row.start_at,
      end_at: row.end_at,
      status: row.status,
      confirmed_by_member_id: row.confirmed_by_member_id,
      confirmed_at: row.confirmed_at
    };
  }

  _appendConfirmedEventOutbox({ group, poll, option, confirmed, actorMember, actorCloudUserId, occurredAt }, undo) {
    const eventId = crypto.randomUUID();
    const votes = this._votesForPoll(poll.id);
    const payload = {
      event_id: eventId,
      event_key: "dis:group:" + group.id + ":event:" + confirmed.id + ":confirmed:v1",
      event_type: "confirmed",
      occurred_at: occurredAt,
      group_id: group.id,
      school_id: group.school_id,
      poll_id: poll.id,
      option_id: option.id,
      confirmed_event_id: confirmed.id,
      start_at: option.start_at,
      end_at: option.end_at,
      confirmed_by_member_id: actorMember.id,
      confirmed_by_cloud_user_id: actorCloudUserId,
      vote_count: votes.filter((vote) => vote.option_id === option.id).length,
      total_votes: votes.length
    };
    pushArrayCommitted(
      this.store.outboxEvents,
      {
        id: eventId,
        aggregate_type: "group_event",
        aggregate_id: confirmed.id,
        event_type: "group.event.confirmed",
        payload_json: payload,
        created_at: occurredAt,
        delivered_at: null
      },
      undo
    );
    return payload;
  }

  confirmGroupPoll(auth, params, body, headers, nowMs = Date.now()) {
    const idem = this._idempotency(
      "confirmGroupPoll",
      auth,
      headers,
      body,
      String(params?.pollId || "")
    );
    if (idem.replay) return idem.replay;
    requireNoUnknownFields(body, ["option_id"], "ConfirmGroupPollRequest");
    const cleanOptionId = requireUuid(body.option_id, "option_id");
    const { poll, member } = this._requirePollAccess(auth, params.pollId);
    const canConfirm = poll.created_by_member_id === member.id || ["OWNER", "ADMIN"].includes(member.role);
    if (!canConfirm) {
      throw new ContractError(
        "POLL_PERMISSION_DENIED",
        "Only the poll creator or a group owner/admin may confirm the poll"
      );
    }
    if (this._effectivePollStatus(poll, nowMs) === "CONFIRMED") {
      throw new ContractError("POLL_ALREADY_CONFIRMED", "Poll already has a terminal confirmed option");
    }
    const option = this._requirePollOption(poll, cleanOptionId);
    const group = this.store.groups.get(poll.group_id);
    if (!group || group.status !== "ACTIVE") {
      throw new ContractError("GROUP_NOT_FOUND", "Poll group is archived or no longer visible");
    }
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const closedAt = poll.closed_at ||
        (Date.parse(poll.voting_deadline_at) <= nowMs ? poll.voting_deadline_at : ts);
      const confirmed = {
        id: crypto.randomUUID(),
        poll_id: poll.id,
        option_id: option.id,
        group_id: poll.group_id,
        school_id: poll.school_id,
        start_at: option.start_at,
        end_at: option.end_at,
        status: "CONFIRMED",
        confirmed_by_member_id: member.id,
        confirmed_at: ts
      };
      setMapCommitted(this.store.confirmedGroupEvents, confirmed.id, confirmed, undo);
      mutateObject(
        poll,
        {
          status: "CONFIRMED",
          closed_at: closedAt,
          confirmed_at: ts,
          confirmed_option_id: option.id,
          confirmed_event_id: confirmed.id
        },
        undo
      );
      this._appendConfirmedEventOutbox(
        {
          group,
          poll,
          option,
          confirmed,
          actorMember: member,
          actorCloudUserId: auth.cloudUserId,
          occurredAt: ts
        },
        undo
      );
      return {
        status: 201,
        code: "GROUP_POLL_CONFIRMED",
        data: {
          poll: this._pollView(poll, member.id, nowMs),
          confirmed_event: this._confirmedEventView(confirmed)
        }
      };
    }, idem.receipt, nowMs);
  }

  exportUserData(cloudUserId) {
    const memberships = Array.from(this.store.groupMembers.values()).filter(
      (member) => member.cloud_user_id === cloudUserId
    );
    const memberIds = new Set(memberships.map((member) => member.id));
    const shares = Array.from(this.store.availabilityShares.values()).filter((row) => memberIds.has(row.member_id));
    const blocks = Array.from(this.store.busyBlocks.values()).filter((row) => memberIds.has(row.member_id));
    const polls = Array.from(this.store.meetingPolls.values()).filter((row) => memberIds.has(row.created_by_member_id));
    const pollIds = new Set(polls.map((row) => row.id));
    const options = Array.from(this.store.pollOptions.values()).filter((row) => pollIds.has(row.poll_id));
    const votes = Array.from(this.store.pollVotes.values()).filter((row) => memberIds.has(row.member_id));
    const confirmedEvents = Array.from(this.store.confirmedGroupEvents.values()).filter(
      (row) => memberIds.has(row.confirmed_by_member_id) || pollIds.has(row.poll_id)
    );
    return {
      availability_shares: clone(shares),
      availability_busy_blocks: clone(blocks),
      availability_polls: clone(polls),
      availability_poll_options: clone(options),
      availability_poll_votes: clone(votes),
      availability_confirmed_group_events: clone(confirmedEvents)
    };
  }

  purgeUserAvailabilityData(cloudUserId, nowMs = Date.now()) {
    const ts = iso(nowMs);
    const memberships = Array.from(this.store.groupMembers.values()).filter(
      (member) => member.cloud_user_id === cloudUserId
    );
    const memberIds = new Set(memberships.map((member) => member.id));
    let sharesDeleted = 0;
    let blocksDeleted = 0;
    let votesDeleted = 0;
    let pollsDetached = 0;
    let confirmedEventsDetached = 0;
    let eventsScrubbed = 0;
    let receiptsDeleted = 0;
    let receiptsPseudonymized = 0;

    for (const memberId of memberIds) {
      if (this.store.availabilityShares.delete(memberId)) sharesDeleted += 1;
    }
    for (const [blockId, block] of Array.from(this.store.busyBlocks.entries())) {
      if (memberIds.has(block.member_id) && this.store.busyBlocks.delete(blockId)) blocksDeleted += 1;
    }
    for (const [voteId, vote] of Array.from(this.store.pollVotes.entries())) {
      if (memberIds.has(vote.member_id) && this.store.pollVotes.delete(voteId)) votesDeleted += 1;
    }
    for (const poll of this.store.meetingPolls.values()) {
      if (memberIds.has(poll.created_by_member_id)) {
        poll.created_by_member_id = DELETED_USER_TOMBSTONE;
        poll.detached_at = ts;
        pollsDetached += 1;
      }
    }
    for (const confirmed of this.store.confirmedGroupEvents.values()) {
      if (memberIds.has(confirmed.confirmed_by_member_id)) {
        confirmed.confirmed_by_member_id = DELETED_USER_TOMBSTONE;
        confirmed.detached_at = ts;
        confirmedEventsDetached += 1;
      }
    }

    for (const event of this.store.outboxEvents || []) {
      if (
        !["group_availability", "group_event", "group_event_conflict"].includes(event?.aggregate_type) ||
        !event.payload_json
      ) {
        continue;
      }
      const counter = { count: 0 };
      event.payload_json = pseudonymizeUserIdRefs(
        event.payload_json,
        cloudUserId,
        DELETED_USER_TOMBSTONE,
        counter
      );
      if (counter.count > 0) eventsScrubbed += 1;
    }

    if (this.store.idempotencyRecords instanceof Map) {
      const availabilityPrefixes = AVAILABILITY_IDEMPOTENCY_OPS.map((op) => op + "|");
      const ownPrefixes = AVAILABILITY_IDEMPOTENCY_OPS.map((op) => op + "|" + cloudUserId + "|");
      for (const [key, record] of Array.from(this.store.idempotencyRecords.entries())) {
        if (ownPrefixes.some((prefix) => key.startsWith(prefix))) {
          this.store.idempotencyRecords.delete(key);
          receiptsDeleted += 1;
          continue;
        }
        // Keep this purge domain-scoped: community/group receipts are scrubbed by
        // packages/community in the same data-delete commit unit. Availability
        // receipts are still defensively pseudonymized if a future response embeds
        // the erased cloud user id.
        if (!availabilityPrefixes.some((prefix) => key.startsWith(prefix))) continue;
        if (!record || typeof record !== "object") continue;
        const counter = { count: 0 };
        if (record.data !== undefined) {
          record.data = pseudonymizeUserIdRefs(record.data, cloudUserId, DELETED_USER_TOMBSTONE, counter);
        }
        if (record.headers !== undefined) {
          record.headers = pseudonymizeUserIdRefs(record.headers, cloudUserId, DELETED_USER_TOMBSTONE, counter);
        }
        if (counter.count > 0) receiptsPseudonymized += 1;
      }
    }

    this.store._rebuildIndexes?.();
    return {
      shares_deleted: sharesDeleted,
      busy_blocks_deleted: blocksDeleted,
      poll_votes_deleted: votesDeleted,
      polls_detached: pollsDetached,
      confirmed_events_detached: confirmedEventsDetached,
      events_scrubbed: eventsScrubbed,
      idempotency_receipts_deleted: receiptsDeleted,
      idempotency_receipts_pseudonymized: receiptsPseudonymized
    };
  }
}

export const AVAILABILITY_DELETED_USER_TOMBSTONE = DELETED_USER_TOMBSTONE;
