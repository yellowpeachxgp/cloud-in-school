import crypto from "node:crypto";
import { ContractError } from "../../contracts/src/index.mjs";

const GROUP_TYPES = new Set(["study", "dorm", "club", "project"]);
const GROUP_ROLES = new Set(["OWNER", "ADMIN", "MEMBER"]);
const GROUP_SHARING_LEVELS = new Set(["NONE", "BUSY_BLOCKS_30MIN"]);
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const QR_PREFIX = "dis-group-invite:v1:";
const DELETED_USER_TOMBSTONE = "00000000-0000-0000-0000-000000000000";
const PRE_RENAME_STAGES = new Set(["tmp_open", "tmp_write", "tmp_fsync", "tmp_close", "rename"]);

function iso(nowMs) {
  return new Date(nowMs).toISOString();
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

function requireAllowed(value, allowed, field) {
  if (!allowed.has(value)) throw badRequest(field + " is not an allowed value");
  return value;
}

function requireNoUnknownFields(body, allowedFields, label) {
  if (!isPlainObject(body)) throw badRequest(label + " must be a JSON object");
  for (const key of Object.keys(body)) {
    if (!allowedFields.includes(key)) {
      throw badRequest(label + " contains unsupported field: " + key);
    }
  }
}

function parseDateTimeMs(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw badRequest(field + " must be an RFC3339 date-time string");
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw badRequest(field + " must be a valid date-time");
  return ms;
}

function parseLimit(raw, fallback = 20) {
  if (raw == null || raw === "") return fallback;
  if (!/^\d+$/.test(String(raw))) throw badRequest("limit must be an integer");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw badRequest("limit must be between 1 and 100");
  }
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

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function pseudonymFor(cloudUserId, schoolId) {
  const animals = ["松鼠", "白鹭", "刺猬", "熊猫", "狐狸", "鹿", "獾", "燕子"];
  const digest = crypto
    .createHash("sha256")
    .update("dis-community-alias:v1:" + schoolId + ":" + cloudUserId)
    .digest();
  const animal = animals[digest[0] % animals.length];
  const serial = String(digest.readUInt16BE(1) % 10000).padStart(4, "0");
  return "校园·" + animal + " " + serial;
}

function sortedByTimeThenId(rows, timeField) {
  return [...rows].sort((a, b) => {
    const at = Date.parse(a[timeField] || 0);
    const bt = Date.parse(b[timeField] || 0);
    if (at !== bt) return at - bt;
    return String(a.id || a.member_id || a.invite_id || "").localeCompare(
      String(b.id || b.member_id || b.invite_id || "")
    );
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

export class CommunityService {
  constructor(store) {
    this.store = store;
    if (!this.store.groups) this.store.groups = new Map();
    if (!this.store.groupMembers) this.store.groupMembers = new Map();
    if (!this.store.groupInvites) this.store.groupInvites = new Map();
  }

  _idempotency(operation, auth, headers, body) {
    const { idempotencyKey } = normalizeBearerHeaders(headers);
    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 128
    ) {
      throw badRequest("Idempotency-Key header is required and must be 8..128 characters");
    }
    const normalizedBody = body === undefined || body === null ? {} : body;
    const bodyHash = sha256Json(normalizedBody);
    const canonicalHash = sha256Json(canonicalize(normalizedBody));
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
          "群组提交未能持久化，请稍后按原 Idempotency-Key 重试；未产生半提交状态"
        );
      }
      throw new ContractError(
        "STORAGE_COMMIT_UNKNOWN",
        "群组提交结果未知：快照可能已发布但核验失败。请携带原 Idempotency-Key 重试以对账，不要另起新键",
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
        "A verified active campus binding is required before using school-scoped groups"
      );
    }
    throw new ContractError(
      "SCHOOL_SCOPE_MISMATCH",
      "Requested group resource belongs to a different school_id isolation scope"
    );
  }

  _activeMembersForGroup(groupId) {
    return Array.from(this.store.groupMembers.values()).filter(
      (member) => member.group_id === groupId && member.status === "ACTIVE"
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

  _requireGroupManager(group, auth) {
    const member = this._requireVisibleMember(group, auth);
    if (!["OWNER", "ADMIN"].includes(member.role)) {
      throw new ContractError("GROUP_PERMISSION_DENIED", "Group owner or admin role is required");
    }
    return member;
  }

  _groupView(group, cloudUserId) {
    const activeMembers = this._activeMembersForGroup(group.id);
    const mine = activeMembers.find((member) => member.cloud_user_id === cloudUserId);
    return {
      group_id: group.id,
      school_id: group.school_id,
      type: group.type,
      name: group.name,
      description: group.description ?? null,
      status: group.status,
      created_by: group.created_by,
      created_at: group.created_at,
      updated_at: group.updated_at,
      archived_at: group.archived_at ?? null,
      member_count: activeMembers.length,
      my_role: mine?.role || "MEMBER"
    };
  }

  _memberView(member) {
    return {
      member_id: member.id,
      group_id: member.group_id,
      school_id: member.school_id,
      cloud_user_id: member.cloud_user_id,
      display_name: member.display_name ?? null,
      role: member.role,
      sharing_level: member.sharing_level,
      status: member.status,
      joined_at: member.joined_at,
      left_at: member.left_at ?? null
    };
  }

  _inviteStatus(invite, nowMs) {
    if (invite.status === "REVOKED" || invite.revoked_at) return "REVOKED";
    if (Date.parse(invite.expires_at) <= nowMs) return "EXPIRED";
    if (Number(invite.used_count) >= Number(invite.max_uses)) return "EXHAUSTED";
    return "ACTIVE";
  }

  _inviteView(invite, nowMs) {
    return {
      invite_id: invite.id,
      group_id: invite.group_id,
      school_id: invite.school_id,
      code: invite.code,
      qr_payload: invite.qr_payload,
      label: invite.label ?? null,
      status: this._inviteStatus(invite, nowMs),
      expires_at: invite.expires_at,
      max_uses: invite.max_uses,
      used_count: invite.used_count,
      created_by: invite.created_by,
      created_at: invite.created_at,
      revoked_at: invite.revoked_at ?? null
    };
  }

  _appendMemberEvent({ group, member, actorCloudUserId, action, reason, occurredAt }, undo) {
    const eventId = crypto.randomUUID();
    const payload = {
      event_id: eventId,
      event_key:
        "dis:group:" + group.id + ":member:" + member.id + ":" + action + ":v1",
      event_type: action,
      occurred_at: occurredAt,
      group_id: group.id,
      school_id: group.school_id,
      member_id: member.id,
      cloud_user_id: member.cloud_user_id,
      actor_cloud_user_id: actorCloudUserId,
      role: member.role,
      sharing_level: member.sharing_level,
      reason
    };
    pushArrayCommitted(
      this.store.outboxEvents,
      {
        id: eventId,
        aggregate_type: "group_member",
        aggregate_id: member.id,
        event_type: "group.member." + action,
        payload_json: payload,
        created_at: occurredAt,
        delivered_at: null
      },
      undo
    );
    return payload;
  }

  listGroups(auth, query, nowMs = Date.now()) {
    const schoolId = requireString(query.get("school_id"), "school_id", { max: 80 });
    this._requireSchoolBinding(auth, schoolId);
    const rawType = query.get("type");
    const type = rawType ? requireAllowed(rawType, GROUP_TYPES, "type") : null;
    const limit = parseLimit(query.get("limit"));
    const cursor = query.get("cursor") || null;
    const rows = sortedByTimeThenId(
      Array.from(this.store.groups.values()).filter((group) => {
        if (group.status !== "ACTIVE" || group.school_id !== schoolId) return false;
        if (type && group.type !== type) return false;
        return Boolean(this._activeMembership(group.id, auth.cloudUserId));
      }),
      "created_at"
    );
    const { page, nextCursor } = paginateRows(rows, { cursor, limit }, (row) => row.id);
    return {
      status: 200,
      code: "GROUPS_LISTED",
      data: page.map((group) => this._groupView(group, auth.cloudUserId)),
      nextCursor
    };
  }

  createGroup(auth, body, headers, nowMs = Date.now()) {
    const idem = this._idempotency("createGroup", auth, headers, body);
    if (idem.replay) return idem.replay;
    requireNoUnknownFields(body, ["school_id", "type", "name", "description"], "CreateGroupRequest");
    const schoolId = requireString(body.school_id, "school_id", { max: 80 });
    const type = requireAllowed(body.type, GROUP_TYPES, "type");
    const name = requireString(body.name, "name", { max: 80 });
    const description =
      body.description === undefined
        ? null
        : requireString(body.description, "description", { min: 0, max: 500 });
    this._requireSchoolBinding(auth, schoolId);
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const group = {
        id: crypto.randomUUID(),
        school_id: schoolId,
        type,
        name,
        description,
        status: "ACTIVE",
        created_by: auth.cloudUserId,
        created_at: ts,
        updated_at: ts,
        archived_at: null
      };
      const member = {
        id: crypto.randomUUID(),
        group_id: group.id,
        school_id: schoolId,
        cloud_user_id: auth.cloudUserId,
        display_name: pseudonymFor(auth.cloudUserId, schoolId),
        role: "OWNER",
        sharing_level: "NONE",
        status: "ACTIVE",
        joined_at: ts,
        left_at: null
      };
      setMapCommitted(this.store.groups, group.id, group, undo);
      setMapCommitted(this.store.groupMembers, member.id, member, undo);
      this.store.indexUserScoped?.("groupMembers", member.id, member.cloud_user_id);
      this._appendMemberEvent(
        {
          group,
          member,
          actorCloudUserId: auth.cloudUserId,
          action: "joined",
          reason: "GROUP_CREATED",
          occurredAt: ts
        },
        undo
      );
      return {
        status: 201,
        code: "GROUP_CREATED",
        data: this._groupView(group, auth.cloudUserId),
        headers: { Location: "/api/v1/groups/" + group.id }
      };
    }, idem.receipt, nowMs);
  }

  getGroup(auth, params) {
    const group = this._requireActiveGroup(params.groupId);
    this._requireVisibleMember(group, auth);
    return { status: 200, code: "GROUP_OK", data: this._groupView(group, auth.cloudUserId) };
  }

  updateGroup(auth, params, body, headers, nowMs = Date.now()) {
    const idem = this._idempotency("updateGroup:" + String(params?.groupId || ""), auth, headers, body);
    if (idem.replay) return idem.replay;
    requireNoUnknownFields(body, ["name", "description"], "UpdateGroupRequest");
    const hasName = Object.hasOwn(body, "name");
    const hasDescription = Object.hasOwn(body, "description");
    if (!hasName && !hasDescription) {
      throw badRequest("UpdateGroupRequest requires name or description");
    }
    const patch = {};
    if (hasName) patch.name = requireString(body.name, "name", { max: 80 });
    if (hasDescription) {
      patch.description =
        body.description === null
          ? null
          : requireString(body.description, "description", { min: 0, max: 500 });
    }
    const group = this._requireActiveGroup(params.groupId);
    this._requireGroupManager(group, auth);
    return this._commitWithReceipt((undo) => {
      mutateObject(group, { ...patch, updated_at: iso(nowMs) }, undo);
      return { status: 200, code: "GROUP_UPDATED", data: this._groupView(group, auth.cloudUserId) };
    }, idem.receipt, nowMs);
  }

  archiveGroup(auth, params, headers, nowMs = Date.now()) {
    const idem = this._idempotency("deleteGroup:" + String(params?.groupId || ""), auth, headers, {});
    if (idem.replay) return idem.replay;
    const group = this._requireActiveGroup(params.groupId);
    this._requireGroupManager(group, auth);
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      mutateObject(group, { status: "ARCHIVED", archived_at: ts, updated_at: ts }, undo);
      const activeMembers = this._activeMembersForGroup(group.id);
      for (const member of activeMembers) {
        mutateObject(
          member,
          { status: "LEFT", sharing_level: "NONE", left_at: ts },
          undo
        );
        this._appendMemberEvent(
          {
            group,
            member,
            actorCloudUserId: auth.cloudUserId,
            action: "left",
            reason: "GROUP_ARCHIVED",
            occurredAt: ts
          },
          undo
        );
      }
      return {
        status: 200,
        code: "GROUP_ARCHIVED",
        data: {
          group_id: group.id,
          archived: true,
          archived_at: ts,
          memberships_ended: activeMembers.length
        }
      };
    }, idem.receipt, nowMs);
  }

  createGroupInvite(auth, params, body, headers, nowMs = Date.now()) {
    const idem = this._idempotency("createGroupInvite:" + String(params?.groupId || ""), auth, headers, body);
    if (idem.replay) return idem.replay;
    requireNoUnknownFields(body, ["expires_at", "max_uses", "label"], "CreateGroupInviteRequest");
    const expiresMs = parseDateTimeMs(body.expires_at, "expires_at");
    if (expiresMs <= nowMs) throw badRequest("expires_at must be in the future");
    if (!Number.isInteger(body.max_uses) || body.max_uses < 1 || body.max_uses > 1000) {
      throw badRequest("max_uses must be an integer between 1 and 1000");
    }
    const label =
      body.label === undefined ? null : requireString(body.label, "label", { max: 80 });
    const group = this._requireActiveGroup(params.groupId);
    this._requireGroupManager(group, auth);
    return this._commitWithReceipt((undo) => {
      let code = "";
      do {
        code = crypto.randomBytes(12).toString("base64url");
      } while (Array.from(this.store.groupInvites.values()).some((invite) => invite.code === code));
      const ts = iso(nowMs);
      const invite = {
        id: crypto.randomUUID(),
        group_id: group.id,
        school_id: group.school_id,
        code,
        qr_payload: QR_PREFIX + code,
        label,
        status: "ACTIVE",
        expires_at: new Date(expiresMs).toISOString(),
        max_uses: body.max_uses,
        used_count: 0,
        created_by: auth.cloudUserId,
        created_at: ts,
        revoked_at: null
      };
      setMapCommitted(this.store.groupInvites, invite.id, invite, undo);
      return {
        status: 201,
        code: "GROUP_INVITE_CREATED",
        data: this._inviteView(invite, nowMs)
      };
    }, idem.receipt, nowMs);
  }

  _normalizeInviteCode(raw) {
    let value = requireString(raw, "code", { max: 128 });
    if (value.startsWith(QR_PREFIX)) value = value.slice(QR_PREFIX.length);
    if (!INVITE_CODE_RE.test(value)) throw badRequest("code must be an invite code or dis-group-invite:v1 QR payload");
    return value;
  }

  acceptGroupInvite(auth, params, headers, nowMs = Date.now()) {
    const idem = this._idempotency("acceptGroupInvite:" + String(params?.code || ""), auth, headers, {});
    if (idem.replay) return idem.replay;
    const code = this._normalizeInviteCode(params.code);
    const invite = Array.from(this.store.groupInvites.values()).find(
      (row) => row.code === code || row.qr_payload === QR_PREFIX + code
    );
    if (!invite || invite.revoked_at || invite.status === "REVOKED") {
      throw new ContractError("GROUP_INVITE_INVALID", "Group invite code does not exist or was revoked");
    }
    const group = this.store.groups.get(invite.group_id);
    if (!group || group.status !== "ACTIVE" || group.school_id !== invite.school_id) {
      throw new ContractError("GROUP_INVITE_INVALID", "Group invite does not match an active school-scoped group");
    }
    this._requireSchoolBinding(auth, invite.school_id);
    if (this._activeMembership(group.id, auth.cloudUserId)) {
      throw new ContractError("GROUP_ALREADY_MEMBER", "User already has an active membership in this group");
    }
    if (Date.parse(invite.expires_at) <= nowMs) {
      throw new ContractError("GROUP_INVITE_EXPIRED", "Group invite code passed its expiration time");
    }
    if (Number(invite.used_count) >= Number(invite.max_uses)) {
      throw new ContractError("GROUP_INVITE_EXHAUSTED", "Group invite code reached its maximum use count");
    }
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const member = {
        id: crypto.randomUUID(),
        group_id: group.id,
        school_id: group.school_id,
        cloud_user_id: auth.cloudUserId,
        display_name: pseudonymFor(auth.cloudUserId, group.school_id),
        role: "MEMBER",
        sharing_level: "NONE",
        status: "ACTIVE",
        joined_at: ts,
        left_at: null
      };
      setMapCommitted(this.store.groupMembers, member.id, member, undo);
      this.store.indexUserScoped?.("groupMembers", member.id, member.cloud_user_id);
      const nextCount = Number(invite.used_count) + 1;
      mutateObject(
        invite,
        {
          used_count: nextCount,
          ...(nextCount >= Number(invite.max_uses) ? { status: "EXHAUSTED" } : {})
        },
        undo
      );
      this._appendMemberEvent(
        {
          group,
          member,
          actorCloudUserId: auth.cloudUserId,
          action: "joined",
          reason: "INVITE_ACCEPTED",
          occurredAt: ts
        },
        undo
      );
      return { status: 201, code: "GROUP_INVITE_ACCEPTED", data: this._memberView(member) };
    }, idem.receipt, nowMs);
  }

  revokeGroupInvite(auth, params, headers, nowMs = Date.now()) {
    const idem = this._idempotency("revokeGroupInvite:" + String(params?.groupId || "") + ":" + String(params?.inviteId || ""), auth, headers, {});
    if (idem.replay) return idem.replay;
    const group = this._requireActiveGroup(params.groupId);
    this._requireGroupManager(group, auth);
    const inviteId = requireUuid(params.inviteId, "inviteId");
    const invite = this.store.groupInvites.get(inviteId);
    if (!invite || invite.group_id !== group.id || invite.school_id !== group.school_id) {
      throw new ContractError("GROUP_NOT_FOUND", "Group invite does not exist in this school-scoped group");
    }
    if (this._inviteStatus(invite, nowMs) === "REVOKED") {
      return this._commitWithReceipt(() => ({
        status: 200,
        code: "GROUP_INVITE_REVOKED",
        data: { invite_id: invite.id, group_id: group.id, revoked: true, already_revoked: true, revoked_at: invite.revoked_at }
      }), idem.receipt, nowMs);
    }
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      mutateObject(invite, { status: "REVOKED", revoked_at: ts }, undo);
      return {
        status: 200,
        code: "GROUP_INVITE_REVOKED",
        data: { invite_id: invite.id, group_id: group.id, revoked: true, already_revoked: false, revoked_at: ts }
      };
    }, idem.receipt, nowMs);
  }

  listGroupMembers(auth, params, query) {
    const group = this._requireActiveGroup(params.groupId);
    this._requireVisibleMember(group, auth);
    const limit = parseLimit(query.get("limit"));
    const cursor = query.get("cursor") || null;
    const rows = sortedByTimeThenId(this._activeMembersForGroup(group.id), "joined_at");
    const { page, nextCursor } = paginateRows(rows, { cursor, limit }, (row) => row.id);
    return {
      status: 200,
      code: "GROUP_MEMBERS_LISTED",
      data: page.map((member) => this._memberView(member)),
      nextCursor
    };
  }

  _activeOwners(groupId) {
    return this._activeMembersForGroup(groupId).filter((member) => member.role === "OWNER");
  }

  updateGroupMember(auth, params, body, headers, nowMs = Date.now()) {
    const idem = this._idempotency("updateGroupMember:" + String(params?.groupId || "") + ":" + String(params?.memberId || ""), auth, headers, body);
    if (idem.replay) return idem.replay;
    requireNoUnknownFields(body, ["role", "sharing_level"], "UpdateGroupMemberRequest");
    const hasRole = Object.hasOwn(body, "role");
    const hasSharing = Object.hasOwn(body, "sharing_level");
    if (!hasRole && !hasSharing) {
      throw badRequest("UpdateGroupMemberRequest requires role or sharing_level");
    }
    const desiredRole = hasRole ? requireAllowed(body.role, GROUP_ROLES, "role") : null;
    const desiredSharing = hasSharing
      ? requireAllowed(body.sharing_level, GROUP_SHARING_LEVELS, "sharing_level")
      : null;
    const group = this._requireActiveGroup(params.groupId);
    const actorMember = this._requireVisibleMember(group, auth);
    const memberId = requireUuid(params.memberId, "memberId");
    const target = this.store.groupMembers.get(memberId);
    if (!target || target.group_id !== group.id || target.school_id !== group.school_id || target.status !== "ACTIVE") {
      throw new ContractError("GROUP_MEMBER_NOT_FOUND", "Group membership does not exist or is not active");
    }
    const self = target.cloud_user_id === auth.cloudUserId;
    if (self) {
      if (hasRole && desiredRole !== target.role) {
        if (target.role === "OWNER") {
          throw new ContractError(
            "GROUP_LAST_OWNER_REQUIRED",
            "The last group owner cannot be demoted before ownership transfer"
          );
        }
        throw new ContractError("GROUP_PERMISSION_DENIED", "Members cannot change their own group role");
      }
    } else {
      if (!["OWNER", "ADMIN"].includes(actorMember.role)) {
        throw new ContractError("GROUP_PERMISSION_DENIED", "Group owner or admin role is required");
      }
      if (hasRole && desiredRole !== target.role) {
        if (desiredRole === "OWNER") {
          if (actorMember.role !== "OWNER") {
            throw new ContractError("GROUP_PERMISSION_DENIED", "Only the current owner can transfer ownership");
          }
        } else if (target.role === "OWNER") {
          const remainingOwners = this._activeOwners(group.id).filter((member) => member.id !== target.id);
          if (remainingOwners.length === 0) {
            throw new ContractError(
              "GROUP_LAST_OWNER_REQUIRED",
              "The last group owner cannot be demoted before ownership transfer"
            );
          }
          if (actorMember.role !== "OWNER") {
            throw new ContractError("GROUP_PERMISSION_DENIED", "Only an owner can demote another owner");
          }
        }
      }
    }
    return this._commitWithReceipt((undo) => {
      if (hasRole && desiredRole !== target.role) {
        if (desiredRole === "OWNER") {
          for (const owner of this._activeOwners(group.id)) {
            if (owner.id !== target.id) mutateObject(owner, { role: "MEMBER" }, undo);
          }
        }
        mutateObject(target, { role: desiredRole }, undo);
      }
      if (hasSharing && desiredSharing !== target.sharing_level) {
        mutateObject(target, { sharing_level: desiredSharing }, undo);
      }
      return { status: 200, code: "GROUP_MEMBER_UPDATED", data: this._memberView(target) };
    }, idem.receipt, nowMs);
  }

  removeGroupMember(auth, params, headers, nowMs = Date.now()) {
    const idem = this._idempotency("removeGroupMember:" + String(params?.groupId || "") + ":" + String(params?.memberId || ""), auth, headers, {});
    if (idem.replay) return idem.replay;
    const group = this._requireActiveGroup(params.groupId);
    const actorMember = this._requireVisibleMember(group, auth);
    const memberId = requireUuid(params.memberId, "memberId");
    const target = this.store.groupMembers.get(memberId);
    if (!target || target.group_id !== group.id || target.school_id !== group.school_id || target.status !== "ACTIVE") {
      throw new ContractError("GROUP_MEMBER_NOT_FOUND", "Group membership does not exist or is not active");
    }
    const self = target.cloud_user_id === auth.cloudUserId;
    if (!self) {
      if (!["OWNER", "ADMIN"].includes(actorMember.role)) {
        throw new ContractError("GROUP_PERMISSION_DENIED", "Group owner or admin role is required to remove a member");
      }
      if (target.role === "OWNER" && actorMember.role !== "OWNER") {
        throw new ContractError("GROUP_PERMISSION_DENIED", "Only an owner can remove another owner");
      }
    }
    const ownerCount = this._activeOwners(group.id).length;
    if (target.role === "OWNER" && ownerCount <= 1) {
      throw new ContractError(
        "GROUP_LAST_OWNER_REQUIRED",
        "The last group owner cannot leave or be removed before ownership transfer"
      );
    }
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const reason = self ? "SELF_LEFT" : "ADMIN_REMOVED";
      mutateObject(
        target,
        {
          status: self ? "LEFT" : "REMOVED",
          sharing_level: "NONE",
          left_at: ts
        },
        undo
      );
      this._appendMemberEvent(
        {
          group,
          member: target,
          actorCloudUserId: auth.cloudUserId,
          action: "left",
          reason,
          occurredAt: ts
        },
        undo
      );
      return {
        status: 200,
        code: self ? "GROUP_LEFT" : "GROUP_MEMBER_REMOVED",
        data: {
          group_id: group.id,
          member_id: target.id,
          ended: true,
          reason,
          sharing_level: "NONE",
          left_at: ts
        }
      };
    }, idem.receipt, nowMs);
  }

  exportUserData(cloudUserId) {
    const memberships = Array.from(this.store.groupMembers.values()).filter(
      (member) => member.cloud_user_id === cloudUserId
    );
    const groupIds = new Set(memberships.map((member) => member.group_id));
    for (const group of this.store.groups.values()) {
      if (group.created_by === cloudUserId) groupIds.add(group.id);
    }
    const groups = Array.from(this.store.groups.values()).filter((group) => groupIds.has(group.id));
    const invites = Array.from(this.store.groupInvites.values()).filter(
      (invite) => invite.created_by === cloudUserId
    );
    return {
      community_groups: clone(groups),
      community_group_members: clone(memberships),
      community_group_invites: clone(invites)
    };
  }

  purgeUserCommunityData(cloudUserId, nowMs = Date.now()) {
    const ts = iso(nowMs);
    const userMemberships = Array.from(this.store.groupMembers.values()).filter(
      (member) => member.cloud_user_id === cloudUserId
    );
    let membershipsRemoved = 0;
    let ownershipTransfers = 0;
    let groupsArchived = 0;
    let groupsDeleted = 0;
    let invitesDeleted = 0;
    let eventsScrubbed = 0;

    for (const member of userMemberships) {
      const group = this.store.groups.get(member.group_id);
      if (group && member.status === "ACTIVE" && group.status === "ACTIVE") {
        if (member.role === "OWNER" && this._activeOwners(group.id).length <= 1) {
          const successors = sortedByTimeThenId(
            this._activeMembersForGroup(group.id).filter((row) => row.id !== member.id),
            "joined_at"
          );
          const successor =
            successors.find((row) => row.role === "ADMIN") || successors[0] || null;
          if (successor) {
            successor.role = "OWNER";
            ownershipTransfers += 1;
          } else {
            group.status = "ARCHIVED";
            group.archived_at = group.archived_at || ts;
            group.updated_at = ts;
            groupsArchived += 1;
          }
        }
        member.role = member.role;
        member.status = "LEFT";
        member.sharing_level = "NONE";
        member.left_at = ts;
        this._appendMemberEvent(
          {
            group,
            member,
            actorCloudUserId: cloudUserId,
            action: "left",
            reason: "SELF_LEFT",
            occurredAt: ts
          },
          []
        );
      }
    }

    for (const member of userMemberships) {
      if (this.store.groupMembers.delete(member.id)) membershipsRemoved += 1;
    }

    for (const invite of Array.from(this.store.groupInvites.values())) {
      if (invite.created_by === cloudUserId) {
        if (this.store.groupInvites.delete(invite.id)) invitesDeleted += 1;
      }
    }

    for (const group of Array.from(this.store.groups.values())) {
      const activeCount = this._activeMembersForGroup(group.id).length;
      if (activeCount === 0) {
        for (const invite of Array.from(this.store.groupInvites.values())) {
          if (invite.group_id === group.id) this.store.groupInvites.delete(invite.id);
        }
        if (this.store.groups.delete(group.id)) groupsDeleted += 1;
      } else if (group.created_by === cloudUserId) {
        group.created_by = DELETED_USER_TOMBSTONE;
        group.updated_at = ts;
      }
    }

    for (const event of this.store.outboxEvents || []) {
      if (event?.aggregate_type !== "group_member" || !event.payload_json) continue;
      let touched = false;
      if (event.payload_json.cloud_user_id === cloudUserId) {
        event.payload_json.cloud_user_id = DELETED_USER_TOMBSTONE;
        touched = true;
      }
      if (event.payload_json.actor_cloud_user_id === cloudUserId) {
        event.payload_json.actor_cloud_user_id = DELETED_USER_TOMBSTONE;
        touched = true;
      }
      if (touched) eventsScrubbed += 1;
    }

    this.store._rebuildIndexes?.();
    return {
      memberships_removed: membershipsRemoved,
      ownership_transfers: ownershipTransfers,
      groups_archived: groupsArchived,
      groups_deleted: groupsDeleted,
      invites_deleted: invitesDeleted,
      events_scrubbed: eventsScrubbed
    };
  }
}

export const COMMUNITY_DELETED_USER_TOMBSTONE = DELETED_USER_TOMBSTONE;
