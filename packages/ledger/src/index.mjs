import crypto from "node:crypto";
import {
  ContractError,
  jsonNumberLiteralAt
} from "../../contracts/src/index.mjs";
import {
  INT64_MAX,
  INT64_MIN,
  fenToBigInt,
  fenToJsonValue,
  parseLedgerAmountInput,
  splitLedgerSharesExact
} from "./money.mjs";
import {
  DormCollaborationBase,
  UUID_RE,
  badRequest,
  canonicalize,
  clone,
  iso,
  optionalString,
  paginateRows,
  parseDateTimeMs,
  parseLimit,
  pseudonymizeExactUserIdRefs,
  pushArrayCommitted,
  requireAllowed,
  requireNoUnknownFields,
  requireString,
  requireUuid,
  setMapCommitted,
  mutateObject,
  sortedByTimeThenId
} from "./service-utils.mjs";

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

const ENTRY_KINDS = new Set(["EXPENSE", "REFUND"]);
const SETTLEMENT_STATUSES = new Set([
  "PENDING_BOTH_CONFIRMATIONS",
  "PENDING_DEBTOR_CONFIRMATION",
  "PENDING_CREDITOR_CONFIRMATION",
  "CONFIRMED",
  "CANCELLED"
]);
const DUTY_ROTA_STATUSES = new Set(["ACTIVE", "PAUSED", "ARCHIVED"]);
const DUTY_TASK_STATUSES = new Set(["PENDING", "COMPLETED", "CONFIRMED", "SKIPPED"]);
const DUTY_SWAP_TYPES = new Set(["SWAP", "COVER"]);
const DUTY_SWAP_STATUSES = new Set(["PENDING", "ACCEPTED", "REJECTED", "CANCELLED"]);
const DUTY_SWAP_ACTIONS = new Set(["ACCEPT", "REJECT", "CANCEL"]);
const REPAIR_CATEGORIES = new Set(["PLUMBING", "ELECTRICAL", "FURNITURE", "NETWORK", "CLEANING", "SAFETY", "OTHER"]);
const REPAIR_STATUSES = new Set(["OPEN", "TRIAGED", "IN_PROGRESS", "RESOLVED", "REJECTED", "CLOSED"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function domainError(code, message) {
  return new ContractError(code, message);
}

function requireInteger(value, field, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isInteger(value)) throw badRequest(field + " must be an integer");
  if (value < min || value > max) throw badRequest(field + " must be between " + min + " and " + max);
  return value;
}

function parseHttpFen(body, field, options = {}) {
  const value = body?.[field];
  if (typeof value === "string") throw badRequest(field + " must be a JSON integer, not a string");
  return parseLedgerAmountInput(value, field, {
    literal: jsonNumberLiteralAt(body, "$." + field),
    ...options
  });
}

function checkedInt64(big, field) {
  if (big < INT64_MIN || big > INT64_MAX) {
    throw domainError("ARITHMETIC_OVERFLOW", field + " overflowed signed 64-bit fen");
  }
  return big;
}

function addFen(a, b, field = "integer fen arithmetic") {
  return checkedInt64(fenToBigInt(a) + fenToBigInt(b), field);
}

function subFen(a, b, field = "integer fen arithmetic") {
  return checkedInt64(fenToBigInt(a) - fenToBigInt(b), field);
}

function jsonFen(big, field = "integer fen arithmetic") {
  return fenToJsonValue(checkedInt64(big, field));
}

function normalizeIsoDateTime(value, field) {
  return new Date(parseDateTimeMs(value, field)).toISOString();
}

function parseDateOnly(value, field) {
  if (typeof value !== "string" || !DATE_RE.test(value)) throw badRequest(field + " must be a YYYY-MM-DD date");
  const [year, month, day] = value.split("-").map(Number);
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw badRequest(field + " must be a real calendar date");
  }
  return value;
}

function dateToMs(date) {
  return Date.parse(date + "T00:00:00.000Z");
}

function msToDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(date, days) {
  return msToDate(dateToMs(date) + days * 86_400_000);
}

function compareDate(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function maxDate(a, b) {
  return compareDate(a, b) >= 0 ? a : b;
}

function minDate(a, b) {
  return compareDate(a, b) <= 0 ? a : b;
}

function isoWeekday(date) {
  const day = new Date(dateToMs(date)).getUTCDay();
  return day === 0 ? 7 : day;
}

function validateTimeZone(value) {
  const clean = requireString(value, "time_zone", { min: 1, max: 80 });
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: clean }).format(0);
  } catch {
    throw domainError("DUTY_SCHEDULE_INVALID", "time_zone must be a valid IANA time zone");
  }
  return clean;
}

function dateInTimeZone(timeZone, nowMs) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year + "-" + month + "-" + day;
}

function enumQuery(query, name, allowed) {
  const raw = query?.get?.(name);
  if (raw == null || raw === "") return null;
  if (!allowed.has(raw)) throw badRequest(name + " is not an allowed value");
  return raw;
}

function optionalUuidQuery(query, name) {
  const raw = query?.get?.(name);
  if (raw == null || raw === "") return null;
  return requireUuid(raw, name);
}

function normalizeText(value, field, options = {}) {
  if (value === undefined || value === null) return null;
  return requireString(value, field, options);
}

function validateKeySet(body, allowed, label) {
  requireNoUnknownFields(body, allowed, label);
}

function positiveBigIntOutput(value) {
  return Number(fenToBigInt(value));
}

function memberSortRows(rows) {
  return [...rows].sort((a, b) => String(a.member_id).localeCompare(String(b.member_id)));
}

function normalizeAmountForEvent(value) {
  const big = fenToBigInt(value);
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString();
}

export class LedgerService extends DormCollaborationBase {
  constructor(store) {
    super(store);
  }

  _appendLedgerEvent({ aggregateType, aggregateId, eventType, payload }, undo) {
    return this._appendOutboxEvent({ aggregateType, aggregateId, eventType, payload, occurredAt: payload.occurred_at }, undo);
  }

  _revisionRow(group) {
    const key = group.id;
    if (!this.store.ledgerBalanceRevisions.has(key)) {
      this.store.ledgerBalanceRevisions.set(key, {
        id: key,
        group_id: group.id,
        school_id: group.school_id,
        balance_revision: 0,
        updated_at: null
      });
    }
    return this.store.ledgerBalanceRevisions.get(key);
  }

  _currentRevision(group) {
    return Number(this._revisionRow(group).balance_revision || 0);
  }

  _incrementRevision(group, occurredAt, undo) {
    const existed = this.store.ledgerBalanceRevisions.has(group.id);
    const row = this._revisionRow(group);
    const before = { balance_revision: row.balance_revision, updated_at: row.updated_at };
    row.balance_revision = Number(row.balance_revision || 0) + 1;
    row.updated_at = occurredAt;
    undo.push(() => {
      if (!existed) {
        this.store.ledgerBalanceRevisions.delete(group.id);
        return;
      }
      row.balance_revision = before.balance_revision;
      row.updated_at = before.updated_at;
    });
    return row.balance_revision;
  }

  _entryView(entry) {
    return {
      entry_id: entry.id,
      group_id: entry.group_id,
      school_id: entry.school_id,
      entry_kind: entry.entry_kind,
      corrects_entry_id: entry.corrects_entry_id ?? null,
      correction_reason: entry.correction_reason ?? null,
      title: entry.title,
      note: entry.note ?? null,
      amount_fen: clone(entry.amount_fen),
      paid_by_member_id: entry.paid_by_member_id,
      occurred_at: entry.occurred_at,
      split_rule: clone(entry.split_rule),
      shares: clone(entry.shares),
      created_by_member_id: entry.created_by_member_id,
      created_at: entry.created_at
    };
  }

  _settlementView(row) {
    return {
      settlement_id: row.id,
      group_id: row.group_id,
      school_id: row.school_id,
      debtor_member_id: row.debtor_member_id,
      creditor_member_id: row.creditor_member_id,
      amount_fen: clone(row.amount_fen),
      basis_balance_revision: row.basis_balance_revision,
      status: row.status,
      note: row.note ?? null,
      created_by_member_id: row.created_by_member_id,
      created_at: row.created_at,
      debtor_confirmed_at: row.debtor_confirmed_at ?? null,
      creditor_confirmed_at: row.creditor_confirmed_at ?? null,
      confirmed_at: row.confirmed_at ?? null,
      cancelled_at: row.cancelled_at ?? null,
      cancelled_by_party: row.cancelled_by_party ?? null,
      cancelled_by_member_id: row.cancelled_by_member_id ?? null
    };
  }

  _rotaView(row) {
    return {
      rota_id: row.id,
      group_id: row.group_id,
      school_id: row.school_id,
      title: row.title,
      description: row.description ?? null,
      rotation_member_ids: clone(row.rotation_member_ids),
      frequency: row.frequency,
      days_of_week: clone(row.days_of_week),
      start_date: row.start_date,
      end_date: row.end_date ?? null,
      time_zone: row.time_zone,
      generate_weeks_ahead: row.generate_weeks_ahead,
      status: row.status,
      next_rotation_index: row.next_rotation_index,
      generated_through_date: row.generated_through_date ?? null,
      created_by_member_id: row.created_by_member_id,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  _taskView(row) {
    return {
      task_id: row.id,
      rota_id: row.rota_id,
      group_id: row.group_id,
      school_id: row.school_id,
      title: row.title,
      assigned_member_id: row.assigned_member_id,
      due_date: row.due_date,
      status: row.status,
      completion_note: row.completion_note ?? null,
      completed_at: row.completed_at ?? null,
      completed_by_member_id: row.completed_by_member_id ?? null,
      confirmation_note: row.confirmation_note ?? null,
      confirmed_at: row.confirmed_at ?? null,
      confirmed_by_member_id: row.confirmed_by_member_id ?? null,
      skip_reason: row.skip_reason ?? null,
      skipped_at: row.skipped_at ?? null,
      skipped_by_member_id: row.skipped_by_member_id ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  _swapView(row) {
    return {
      swap_id: row.id,
      rota_id: row.rota_id,
      duty_task_id: row.duty_task_id,
      group_id: row.group_id,
      school_id: row.school_id,
      type: row.type,
      requested_by_member_id: row.requested_by_member_id,
      target_member_id: row.target_member_id,
      reason: row.reason ?? null,
      status: row.status,
      resolution_note: row.resolution_note ?? null,
      resolved_by_member_id: row.resolved_by_member_id ?? null,
      created_at: row.created_at,
      resolved_at: row.resolved_at ?? null
    };
  }

  _repairView(row) {
    return {
      repair_id: row.id,
      group_id: row.group_id,
      school_id: row.school_id,
      title: row.title,
      category: row.category,
      location_text: row.location_text,
      description: row.description,
      reporter_member_id: row.reporter_member_id,
      assigned_member_id: row.assigned_member_id ?? null,
      status: row.status,
      resolution_note: row.resolution_note ?? null,
      review_id: row.review_id ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      triaged_at: row.triaged_at ?? null,
      started_at: row.started_at ?? null,
      resolved_at: row.resolved_at ?? null,
      rejected_at: row.rejected_at ?? null,
      closed_at: row.closed_at ?? null
    };
  }

  _reviewView(row) {
    return {
      review_id: row.id,
      repair_id: row.repair_id,
      group_id: row.group_id,
      school_id: row.school_id,
      reviewer_member_id: row.reviewer_member_id,
      rating: row.rating,
      comment: row.comment ?? null,
      created_at: row.created_at
    };
  }

  _groupAndMember(auth, groupId) {
    const group = this._requireActiveGroup(groupId);
    const member = this._requireVisibleMember(group, auth);
    return { group, member };
  }

  _activeMemberIds(groupId) {
    return this._activeMembersForGroup(groupId).map((member) => member.id);
  }

  _requireActiveMemberInGroup(group, memberId, errorCode = "UNKNOWN_PARTICIPANT") {
    const member = this._activeMemberById(group.id, memberId);
    if (!member) throw domainError(errorCode, "member is not active in this group");
    return member;
  }

  _validateSplitRule(rule, group) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw badRequest("split_rule must be an object");
    requireNoUnknownFields(rule, ["type", "participant_member_ids", "ratio_weights", "stay_days"], "split_rule");
    const type = rule.type;
    if (!["EQUAL", "SELECTED", "RATIOS", "STAY_DAYS"].includes(type)) throw badRequest("split_rule.type is not an allowed value");
    const activeIds = new Set(this._activeMemberIds(group.id));
    const validateIds = (raw, field) => {
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) throw badRequest(field + " must contain 1..100 member ids");
      const ids = raw.map((value, index) => requireUuid(value, field + "[" + index + "]"));
      if (new Set(ids).size !== ids.length) throw domainError("DUPLICATE_PARTICIPANT", field + " contains duplicate member ids");
      const unknown = ids.filter((id) => !activeIds.has(id));
      if (unknown.length > 0) throw domainError("UNKNOWN_PARTICIPANT", "split_rule references inactive or unknown members: " + unknown.sort().join(","));
      return ids;
    };
    const forbidden = (fields) => {
      for (const field of fields) {
        if (Object.hasOwn(rule, field)) throw badRequest("split_rule." + field + " is forbidden for type " + type);
      }
    };
    if (type === "EQUAL") {
      forbidden(["participant_member_ids", "ratio_weights", "stay_days"]);
    } else if (type === "SELECTED") {
      forbidden(["ratio_weights", "stay_days"]);
      validateIds(rule.participant_member_ids, "split_rule.participant_member_ids");
    } else if (type === "RATIOS") {
      forbidden(["participant_member_ids", "stay_days"]);
      if (!Array.isArray(rule.ratio_weights) || rule.ratio_weights.length < 1 || rule.ratio_weights.length > 100) {
        throw domainError("INVALID_RATIO_WEIGHT", "split_rule.ratio_weights must contain 1..100 rows");
      }
      const ids = [];
      let positive = 0;
      for (const [index, row] of rule.ratio_weights.entries()) {
        validateKeySet(row, ["member_id", "weight"], "split_rule.ratio_weights[" + index + "]");
        const id = requireUuid(row.member_id, "split_rule.ratio_weights[" + index + "].member_id");
        ids.push(id);
        if (!activeIds.has(id)) throw domainError("UNKNOWN_PARTICIPANT", "ratio weight references inactive or unknown member: " + id);
        if (!Number.isInteger(row.weight) || row.weight < 0 || row.weight > 1_000_000) {
          throw domainError("INVALID_RATIO_WEIGHT", "ratio weight must be an integer between 0 and 1000000");
        }
        if (row.weight > 0) positive += 1;
      }
      if (new Set(ids).size !== ids.length) throw domainError("DUPLICATE_PARTICIPANT", "ratio_weights contains duplicate member ids");
      if (positive === 0) throw domainError("NO_EFFECTIVE_PARTICIPANTS", "ratio split selects no positive weight participant");
    } else if (type === "STAY_DAYS") {
      forbidden(["participant_member_ids", "ratio_weights"]);
      if (!Array.isArray(rule.stay_days) || rule.stay_days.length < 1 || rule.stay_days.length > 100) {
        throw domainError("INVALID_STAY_DAYS", "split_rule.stay_days must contain 1..100 rows");
      }
      const ids = [];
      let positive = 0;
      for (const [index, row] of rule.stay_days.entries()) {
        validateKeySet(row, ["member_id", "days"], "split_rule.stay_days[" + index + "]");
        const id = requireUuid(row.member_id, "split_rule.stay_days[" + index + "].member_id");
        ids.push(id);
        if (!activeIds.has(id)) throw domainError("UNKNOWN_PARTICIPANT", "stay days reference inactive or unknown member: " + id);
        if (!Number.isInteger(row.days) || row.days < 0 || row.days > 366) {
          throw domainError("INVALID_STAY_DAYS", "stay days must be an integer between 0 and 366");
        }
        if (row.days > 0) positive += 1;
      }
      if (new Set(ids).size !== ids.length) throw domainError("DUPLICATE_PARTICIPANT", "stay_days contains duplicate member ids");
      if (positive === 0) throw domainError("NO_EFFECTIVE_PARTICIPANTS", "stay-days split selects no positive day participant");
    }
    return canonicalize(rule);
  }

  _calculateShares(amountBig, group, splitRule) {
    const exact = splitLedgerSharesExact(amountBig, this._activeMemberIds(group.id), splitRule);
    const shares = exact.map((share) => ({
      participant_member_id: share.participant_member_id,
      amount_fen: jsonFen(share.amount_fen, "split share")
    })).sort((a, b) => a.participant_member_id.localeCompare(b.participant_member_id));
    const sum = shares.reduce((acc, row) => acc + fenToBigInt(row.amount_fen), 0n);
    if (sum !== amountBig) throw new Error("split shares do not conserve signed amount");
    return shares;
  }

  _appendEntryOutbox({ group, entry, actorMember, actorCloudUserId, correction = false, balanceRevision, occurredAt }, undo) {
    const eventId = crypto.randomUUID();
    const payload = correction ? {
      event_id: eventId,
      event_key: "dis:group:" + group.id + ":ledger-entry:" + entry.corrects_entry_id + ":correction:" + entry.id + ":v1",
      event_type: "amended",
      occurred_at: occurredAt,
      group_id: group.id,
      school_id: group.school_id,
      entry_id: entry.id,
      corrects_entry_id: entry.corrects_entry_id,
      actor_member_id: actorMember.id,
      actor_cloud_user_id: actorCloudUserId,
      amount_fen: normalizeAmountForEvent(entry.amount_fen),
      paid_by_member_id: entry.paid_by_member_id,
      share_count: entry.shares.length,
      balance_revision: balanceRevision
    } : {
      event_id: eventId,
      event_key: "dis:group:" + group.id + ":ledger-entry:" + entry.id + ":created:v1",
      event_type: "created",
      occurred_at: occurredAt,
      group_id: group.id,
      school_id: group.school_id,
      entry_id: entry.id,
      actor_member_id: actorMember.id,
      actor_cloud_user_id: actorCloudUserId,
      entry_kind: entry.entry_kind,
      amount_fen: normalizeAmountForEvent(entry.amount_fen),
      paid_by_member_id: entry.paid_by_member_id,
      share_count: entry.shares.length,
      balance_revision: balanceRevision
    };
    return this._appendLedgerEvent({
      aggregateType: "ledger_entry",
      aggregateId: entry.id,
      eventType: correction ? "ledger.entry.amended" : "ledger.entry.created",
      payload
    }, undo);
  }

  createLedgerEntry(auth, params, body, headers, nowMs = Date.now()) {
    const groupId = String(params?.groupId || "");
    const idem = this._idempotency("createLedgerEntry", auth, headers, body, { groupId });
    if (idem.replay) return idem.replay;
    validateKeySet(body, ["entry_kind", "title", "note", "amount_fen", "paid_by_member_id", "occurred_at", "split_rule"], "create ledger entry body");
    const { group, member } = this._groupAndMember(auth, groupId);
    const entryKind = body.entry_kind === undefined ? "EXPENSE" : requireAllowed(body.entry_kind, ENTRY_KINDS, "entry_kind");
    const title = requireString(body.title, "title", { max: 120 });
    const note = normalizeText(body.note, "note", { min: 0, max: 500 });
    const amount = parseHttpFen(body, "amount_fen");
    const payerId = requireUuid(body.paid_by_member_id, "paid_by_member_id");
    this._requireActiveMemberInGroup(group, payerId);
    const occurredAt = normalizeIsoDateTime(body.occurred_at, "occurred_at");
    const splitRule = this._validateSplitRule(body.split_rule, group);
    const shares = this._calculateShares(amount, group, splitRule);
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const entry = {
        id: crypto.randomUUID(),
        group_id: group.id,
        school_id: group.school_id,
        entry_kind: entryKind,
        corrects_entry_id: null,
        correction_reason: null,
        title,
        note,
        amount_fen: jsonFen(amount, "amount_fen"),
        paid_by_member_id: payerId,
        occurred_at: occurredAt,
        split_rule: clone(splitRule),
        shares,
        created_by_member_id: member.id,
        created_at: ts
      };
      setMapCommitted(this.store.ledgerEntries, entry.id, entry, undo);
      const revision = this._incrementRevision(group, ts, undo);
      this._appendEntryOutbox({ group, entry, actorMember: member, actorCloudUserId: auth.cloudUserId, balanceRevision: revision, occurredAt: ts }, undo);
      return {
        status: 201,
        code: "LEDGER_ENTRY_CREATED",
        data: this._entryView(entry),
        headers: { Location: "/api/v1/groups/" + group.id + "/ledger/entries" }
      };
    }, idem.receipt, nowMs);
  }

  listLedgerEntries(auth, params, query) {
    const { group } = this._groupAndMember(auth, String(params?.groupId || ""));
    const corrects = optionalUuidQuery(query, "corrects_entry_id");
    const limit = parseLimit(query?.get?.("limit"));
    let rows = Array.from(this.store.ledgerEntries.values()).filter((row) => row.group_id === group.id);
    if (corrects) rows = rows.filter((row) => row.corrects_entry_id === corrects);
    rows = sortedByTimeThenId(rows, "created_at", { descending: true });
    const page = paginateRows(rows, { cursor: query?.get?.("cursor") || null, limit }, (row) => row.id);
    return {
      status: 200,
      code: "LEDGER_ENTRIES_LISTED",
      data: page.page.map((row) => this._entryView(row)),
      nextCursor: page.nextCursor
    };
  }

  amendLedgerEntry(auth, params, body, headers, nowMs = Date.now()) {
    const targetFingerprint = { groupId: String(params?.groupId || ""), entryId: String(params?.entryId || "") };
    const idem = this._idempotency("amendLedgerEntry", auth, headers, body, targetFingerprint);
    if (idem.replay) return idem.replay;
    validateKeySet(body, ["reason", "title", "amount_fen", "paid_by_member_id", "occurred_at", "split_rule"], "amend ledger entry body");
    const { group, member } = this._groupAndMember(auth, String(params?.groupId || ""));
    const targetId = requireUuid(params?.entryId, "entryId");
    const target = this.store.ledgerEntries.get(targetId);
    if (!target || target.group_id !== group.id || target.school_id !== group.school_id) {
      throw domainError("LEDGER_ENTRY_NOT_FOUND", "Ledger entry does not exist or is not visible in this group scope");
    }
    const reason = requireString(body.reason, "reason", { max: 240 });
    const title = body.title === undefined ? target.title : requireString(body.title, "title", { max: 120 });
    const amount = parseHttpFen(body, "amount_fen");
    const payerId = requireUuid(body.paid_by_member_id, "paid_by_member_id");
    this._requireActiveMemberInGroup(group, payerId);
    const occurredAt = normalizeIsoDateTime(body.occurred_at, "occurred_at");
    const splitRule = this._validateSplitRule(body.split_rule, group);
    const shares = this._calculateShares(amount, group, splitRule);
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const entry = {
        id: crypto.randomUUID(),
        group_id: group.id,
        school_id: group.school_id,
        entry_kind: "CORRECTION",
        corrects_entry_id: target.id,
        correction_reason: reason,
        title,
        note: null,
        amount_fen: jsonFen(amount, "amount_fen"),
        paid_by_member_id: payerId,
        occurred_at: occurredAt,
        split_rule: clone(splitRule),
        shares,
        created_by_member_id: member.id,
        created_at: ts
      };
      setMapCommitted(this.store.ledgerEntries, entry.id, entry, undo);
      const revision = this._incrementRevision(group, ts, undo);
      this._appendEntryOutbox({ group, entry, actorMember: member, actorCloudUserId: auth.cloudUserId, correction: true, balanceRevision: revision, occurredAt: ts }, undo);
      return { status: 201, code: "LEDGER_ENTRY_AMENDED", data: this._entryView(entry) };
    }, idem.receipt, nowMs);
  }

  _computeBalances(group) {
    const memberIds = new Set(this._activeMemberIds(group.id));
    const totals = new Map();
    const ensure = (memberId) => {
      if (!totals.has(memberId)) {
        totals.set(memberId, { posting: 0n, shares: 0n, outbound: 0n, inbound: 0n });
      }
      return totals.get(memberId);
    };
    for (const id of memberIds) ensure(id);
    for (const entry of this.store.ledgerEntries.values()) {
      if (entry.group_id !== group.id) continue;
      memberIds.add(entry.paid_by_member_id);
      ensure(entry.paid_by_member_id).posting = addFen(ensure(entry.paid_by_member_id).posting, entry.amount_fen, "posting credit");
      for (const share of entry.shares || []) {
        memberIds.add(share.participant_member_id);
        ensure(share.participant_member_id).shares = addFen(ensure(share.participant_member_id).shares, share.amount_fen, "share cost");
      }
    }
    for (const settlement of this.store.settlements.values()) {
      if (settlement.group_id !== group.id || settlement.status !== "CONFIRMED") continue;
      memberIds.add(settlement.debtor_member_id);
      memberIds.add(settlement.creditor_member_id);
      ensure(settlement.debtor_member_id).outbound = addFen(ensure(settlement.debtor_member_id).outbound, settlement.amount_fen, "outbound settlement");
      ensure(settlement.creditor_member_id).inbound = addFen(ensure(settlement.creditor_member_id).inbound, settlement.amount_fen, "inbound settlement");
    }
    const rows = [];
    let zeroSum = 0n;
    for (const memberId of memberIds) {
      const row = totals.get(memberId) || { posting: 0n, shares: 0n, outbound: 0n, inbound: 0n };
      const balance = checkedInt64(row.posting - row.shares + row.outbound - row.inbound, "member balance");
      zeroSum += balance;
      rows.push({
        member_id: memberId,
        posting_credit_fen: jsonFen(row.posting, "posting credit"),
        share_cost_fen: jsonFen(row.shares, "share cost"),
        outbound_settlement_fen: positiveBigIntOutput(row.outbound),
        inbound_settlement_fen: positiveBigIntOutput(row.inbound),
        balance_fen: jsonFen(balance, "member balance"),
        _big: balance
      });
    }
    if (zeroSum !== 0n) throw new Error("ledger zero-sum invariant violated");
    return memberSortRows(rows).map(({ _big, ...row }) => ({ ...row, _balance_big: _big }));
  }

  getLedgerBalances(auth, params, nowMs = Date.now()) {
    const { group } = this._groupAndMember(auth, String(params?.groupId || ""));
    const rows = this._computeBalances(group).map(({ _balance_big, ...row }) => row);
    return {
      status: 200,
      code: "LEDGER_BALANCES_OK",
      data: {
        group_id: group.id,
        school_id: group.school_id,
        balance_revision: this._currentRevision(group),
        generated_at: iso(nowMs),
        zero_sum_check_fen: 0,
        members: rows
      }
    };
  }

  _balanceBigFor(rows, memberId) {
    return rows.find((row) => row.member_id === memberId)?._balance_big ?? 0n;
  }

  createSettlement(auth, params, body, headers, nowMs = Date.now()) {
    const groupId = String(params?.groupId || "");
    const idem = this._idempotency("createSettlement", auth, headers, body, { groupId });
    if (idem.replay) return idem.replay;
    validateKeySet(body, ["debtor_member_id", "creditor_member_id", "amount_fen", "basis_balance_revision", "note"], "create settlement body");
    const { group, member } = this._groupAndMember(auth, groupId);
    const debtorId = requireUuid(body.debtor_member_id, "debtor_member_id");
    const creditorId = requireUuid(body.creditor_member_id, "creditor_member_id");
    if (debtorId === creditorId) throw domainError("SAME_SETTLEMENT_PARTIES", "settlement debtor and creditor must differ");
    this._requireActiveMemberInGroup(group, debtorId, "SETTLEMENT_PERMISSION_DENIED");
    this._requireActiveMemberInGroup(group, creditorId, "SETTLEMENT_PERMISSION_DENIED");
    const amount = parseHttpFen(body, "amount_fen", { positive: true });
    const basis = requireInteger(body.basis_balance_revision, "basis_balance_revision", { min: 0, max: Number.MAX_SAFE_INTEGER });
    if (basis !== this._currentRevision(group)) throw domainError("SETTLEMENT_BALANCE_STALE", "basis_balance_revision is not the current group balance revision");
    const note = normalizeText(body.note, "note", { min: 0, max: 240 });
    const balances = this._computeBalances(group);
    const debtorBalance = this._balanceBigFor(balances, debtorId);
    const creditorBalance = this._balanceBigFor(balances, creditorId);
    if (debtorBalance >= 0n || creditorBalance <= 0n || amount > -debtorBalance || amount > creditorBalance) {
      throw domainError("SETTLEMENT_AMOUNT_INVALID", "settlement amount exceeds debtor debt magnitude or creditor receivable at the pinned revision");
    }
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const settlement = {
        id: crypto.randomUUID(),
        group_id: group.id,
        school_id: group.school_id,
        debtor_member_id: debtorId,
        creditor_member_id: creditorId,
        amount_fen: jsonFen(amount, "amount_fen"),
        basis_balance_revision: basis,
        status: "PENDING_BOTH_CONFIRMATIONS",
        note,
        created_by_member_id: member.id,
        created_at: ts,
        debtor_confirmed_at: null,
        creditor_confirmed_at: null,
        confirmed_at: null,
        cancelled_at: null,
        cancelled_by_party: null,
        cancelled_by_member_id: null
      };
      setMapCommitted(this.store.settlements, settlement.id, settlement, undo);
      return {
        status: 201,
        code: "SETTLEMENT_CREATED",
        data: this._settlementView(settlement),
        headers: { Location: "/api/v1/settlements/" + settlement.id }
      };
    }, idem.receipt, nowMs);
  }

  listSettlements(auth, params, query) {
    const { group } = this._groupAndMember(auth, String(params?.groupId || ""));
    const status = enumQuery(query, "status", SETTLEMENT_STATUSES);
    const limit = parseLimit(query?.get?.("limit"));
    let rows = Array.from(this.store.settlements.values()).filter((row) => row.group_id === group.id);
    if (status) rows = rows.filter((row) => row.status === status);
    rows = sortedByTimeThenId(rows, "created_at", { descending: true });
    const page = paginateRows(rows, { cursor: query?.get?.("cursor") || null, limit }, (row) => row.id);
    return { status: 200, code: "SETTLEMENTS_LISTED", data: page.page.map((row) => this._settlementView(row)), nextCursor: page.nextCursor };
  }

  _requireSettlementVisible(auth, settlementId) {
    const id = requireUuid(settlementId, "settlementId");
    const settlement = this.store.settlements.get(id);
    if (!settlement) throw domainError("SETTLEMENT_NOT_FOUND", "Settlement does not exist or is not visible");
    const group = this.store.groups.get(settlement.group_id);
    if (!group) throw domainError("SETTLEMENT_NOT_FOUND", "Settlement group is not visible");
    this._requireDirectResourceMember(group, auth, "SETTLEMENT_PERMISSION_DENIED");
    return { settlement, group, member: this._activeMembership(group.id, auth.cloudUserId) };
  }

  getSettlement(auth, params) {
    const { settlement } = this._requireSettlementVisible(auth, params?.settlementId);
    return { status: 200, code: "SETTLEMENT_OK", data: this._settlementView(settlement) };
  }

  _partyForMember(settlement, memberId) {
    if (settlement.debtor_member_id === memberId) return "DEBTOR";
    if (settlement.creditor_member_id === memberId) return "CREDITOR";
    return null;
  }

  _appendSettlementConfirmedEvent({ group, settlement, balanceRevision, occurredAt }, undo) {
    const eventId = crypto.randomUUID();
    const payload = {
      event_id: eventId,
      event_key: "dis:group:" + group.id + ":settlement:" + settlement.id + ":confirmed:v1",
      event_type: "confirmed",
      occurred_at: occurredAt,
      group_id: group.id,
      school_id: group.school_id,
      settlement_id: settlement.id,
      debtor_member_id: settlement.debtor_member_id,
      creditor_member_id: settlement.creditor_member_id,
      debtor_cloud_user_id: this._memberCloudUserId(settlement.debtor_member_id) || LEDGER_DELETED_USER_TOMBSTONE,
      creditor_cloud_user_id: this._memberCloudUserId(settlement.creditor_member_id) || LEDGER_DELETED_USER_TOMBSTONE,
      amount_fen: normalizeAmountForEvent(settlement.amount_fen),
      basis_balance_revision: settlement.basis_balance_revision,
      applied_balance_revision: balanceRevision,
      confirmed_at: settlement.confirmed_at,
      payment_executed: false
    };
    return this._appendLedgerEvent({ aggregateType: "settlement", aggregateId: settlement.id, eventType: "settlement.confirmed", payload }, undo);
  }

  confirmSettlement(auth, params, body, headers, nowMs = Date.now()) {
    const settlementId = String(params?.settlementId || "");
    const idem = this._idempotency("confirmSettlement", auth, headers, body, { settlementId });
    if (idem.replay) return idem.replay;
    validateKeySet(body, ["basis_balance_revision"], "confirm settlement body");
    requireInteger(body?.basis_balance_revision, "basis_balance_revision", { min: 0, max: Number.MAX_SAFE_INTEGER });
    const { settlement, group, member } = this._requireSettlementVisible(auth, settlementId);
    const party = this._partyForMember(settlement, member.id);
    if (!party) throw domainError("SETTLEMENT_PARTY_MISMATCH", "only the settlement debtor or creditor can confirm it");
    if (["CONFIRMED", "CANCELLED"].includes(settlement.status)) {
      throw domainError("SETTLEMENT_INVALID_STATE", "settlement is already terminal");
    }
    if (body.basis_balance_revision !== settlement.basis_balance_revision || this._currentRevision(group) !== settlement.basis_balance_revision) {
      throw domainError("SETTLEMENT_BALANCE_STALE", "ledger balances changed after this settlement was proposed");
    }
    const already = party === "DEBTOR" ? Boolean(settlement.debtor_confirmed_at) : Boolean(settlement.creditor_confirmed_at);
    if (already) {
      return { status: 200, code: "SETTLEMENT_CONFIRMATION_REPLAYED", data: this._settlementView(settlement) };
    }
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      mutateObject(settlement, party === "DEBTOR" ? { debtor_confirmed_at: ts } : { creditor_confirmed_at: ts }, undo);
      if (settlement.debtor_confirmed_at && settlement.creditor_confirmed_at) {
        mutateObject(settlement, { status: "CONFIRMED", confirmed_at: ts }, undo);
        const revision = this._incrementRevision(group, ts, undo);
        this._appendSettlementConfirmedEvent({ group, settlement, balanceRevision: revision, occurredAt: ts }, undo);
      } else {
        mutateObject(settlement, {
          status: settlement.debtor_confirmed_at ? "PENDING_CREDITOR_CONFIRMATION" : "PENDING_DEBTOR_CONFIRMATION"
        }, undo);
      }
      return { status: 200, code: settlement.status === "CONFIRMED" ? "SETTLEMENT_CONFIRMED" : "SETTLEMENT_PARTY_CONFIRMED", data: this._settlementView(settlement) };
    }, idem.receipt, nowMs);
  }

  cancelSettlement(auth, params, body, headers, nowMs = Date.now()) {
    const settlementId = String(params?.settlementId || "");
    const idem = this._idempotency("cancelSettlement", auth, headers, body ?? {}, { settlementId });
    if (idem.replay) return idem.replay;
    validateKeySet(body ?? {}, ["reason"], "cancel settlement body");
    normalizeText(body?.reason, "reason", { min: 0, max: 240 });
    const { settlement, member } = this._requireSettlementVisible(auth, settlementId);
    const party = this._partyForMember(settlement, member.id);
    if (!party) throw domainError("SETTLEMENT_PARTY_MISMATCH", "only the settlement debtor or creditor can cancel it");
    if (["CONFIRMED", "CANCELLED"].includes(settlement.status)) {
      throw domainError("SETTLEMENT_INVALID_STATE", "confirmed or cancelled settlement is terminal");
    }
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      mutateObject(settlement, {
        status: "CANCELLED",
        cancelled_at: ts,
        cancelled_by_party: party,
        cancelled_by_member_id: member.id
      }, undo);
      return { status: 200, code: "SETTLEMENT_CANCELLED", data: this._settlementView(settlement) };
    }, idem.receipt, nowMs);
  }

  _validateRotationMembers(raw, group) {
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 100) throw domainError("DUTY_SCHEDULE_INVALID", "rotation_member_ids must contain 2..100 ordered members");
    const ids = raw.map((value, index) => requireUuid(value, "rotation_member_ids[" + index + "]"));
    if (new Set(ids).size !== ids.length) throw domainError("DUTY_SCHEDULE_INVALID", "rotation_member_ids must be unique");
    for (const id of ids) this._requireActiveMemberInGroup(group, id, "DUTY_SCHEDULE_INVALID");
    return ids;
  }

  _validateDaysOfWeek(raw, frequency, required) {
    if (raw === undefined || raw === null) {
      if (required) throw domainError("DUTY_SCHEDULE_INVALID", "WEEKLY rotations require at least one day_of_week");
      return [];
    }
    if (!Array.isArray(raw) || raw.length > 7) throw domainError("DUTY_SCHEDULE_INVALID", "days_of_week must be an array of at most 7 ISO weekdays");
    for (const day of raw) {
      if (!Number.isInteger(day) || day < 1 || day > 7) throw domainError("DUTY_SCHEDULE_INVALID", "days_of_week values must be ISO weekdays 1..7");
    }
    if (new Set(raw).size !== raw.length) throw domainError("DUTY_SCHEDULE_INVALID", "days_of_week must not contain duplicates");
    if (required && raw.length === 0) throw domainError("DUTY_SCHEDULE_INVALID", "WEEKLY rotations require at least one day_of_week");
    return frequency === "DAILY" ? [] : [...raw].sort((a, b) => a - b);
  }

  _rotaGenerationWindow(rota, nowMs) {
    const today = dateInTimeZone(rota.time_zone, nowMs);
    const first = maxDate(rota.start_date, today);
    let last = addDays(first, Number(rota.generate_weeks_ahead) * 7 - 1);
    if (rota.end_date) last = minDate(last, rota.end_date);
    return compareDate(first, last) > 0 ? null : { first, last };
  }

  _generateTasksForRota(rota, nowMs, undo) {
    if (rota.status !== "ACTIVE") return [];
    const window = this._rotaGenerationWindow(rota, nowMs);
    if (!window) return [];
    const generated = [];
    const existingDates = new Set(Array.from(this.store.dutyTasks.values()).filter((task) => task.rota_id === rota.id).map((task) => task.due_date));
    const totalDays = Math.floor((dateToMs(window.last) - dateToMs(window.first)) / 86_400_000);
    for (let offset = 0; offset <= totalDays; offset += 1) {
      const dueDate = addDays(window.first, offset);
      if (rota.frequency === "WEEKLY" && !rota.days_of_week.includes(isoWeekday(dueDate))) continue;
      if (existingDates.has(dueDate)) continue;
      const assigned = rota.rotation_member_ids[Number(rota.next_rotation_index) % rota.rotation_member_ids.length];
      const ts = iso(nowMs);
      const task = {
        id: crypto.randomUUID(),
        rota_id: rota.id,
        group_id: rota.group_id,
        school_id: rota.school_id,
        title: rota.title,
        assigned_member_id: assigned,
        due_date: dueDate,
        status: "PENDING",
        completion_note: null,
        completed_at: null,
        completed_by_member_id: null,
        confirmation_note: null,
        confirmed_at: null,
        confirmed_by_member_id: null,
        skip_reason: null,
        skipped_at: null,
        skipped_by_member_id: null,
        created_at: ts,
        updated_at: ts
      };
      setMapCommitted(this.store.dutyTasks, task.id, task, undo);
      generated.push(task);
      mutateObject(rota, { next_rotation_index: Number(rota.next_rotation_index) + 1 }, undo);
    }
    if (!rota.generated_through_date || compareDate(rota.generated_through_date, window.last) < 0) {
      mutateObject(rota, { generated_through_date: window.last }, undo);
    }
    return generated;
  }

  createDutyRota(auth, params, body, headers, nowMs = Date.now()) {
    const groupId = String(params?.groupId || "");
    const idem = this._idempotency("createDutyRota", auth, headers, body, { groupId });
    if (idem.replay) return idem.replay;
    validateKeySet(body, ["title", "description", "rotation_member_ids", "frequency", "days_of_week", "start_date", "end_date", "time_zone", "generate_weeks_ahead"], "create duty rota body");
    const { group, member } = this._groupAndMember(auth, groupId);
    if (!["OWNER", "ADMIN"].includes(member.role)) throw domainError("DUTY_PERMISSION_DENIED", "group owner or admin role is required");
    const title = requireString(body.title, "title", { max: 80 });
    const description = normalizeText(body.description, "description", { min: 0, max: 500 });
    const rotation = this._validateRotationMembers(body.rotation_member_ids, group);
    const frequency = requireAllowed(body.frequency, new Set(["DAILY", "WEEKLY"]), "frequency");
    const days = this._validateDaysOfWeek(body.days_of_week, frequency, frequency === "WEEKLY");
    const startDate = parseDateOnly(body.start_date, "start_date");
    const endDate = body.end_date === undefined || body.end_date === null ? null : parseDateOnly(body.end_date, "end_date");
    if (endDate && compareDate(endDate, startDate) < 0) throw domainError("DUTY_SCHEDULE_INVALID", "end_date must not be before start_date");
    const timeZone = validateTimeZone(body.time_zone);
    const weeks = body.generate_weeks_ahead === undefined ? 2 : requireInteger(body.generate_weeks_ahead, "generate_weeks_ahead", { min: 1, max: 12 });
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const rota = {
        id: crypto.randomUUID(),
        group_id: group.id,
        school_id: group.school_id,
        title,
        description,
        rotation_member_ids: rotation,
        frequency,
        days_of_week: days,
        start_date: startDate,
        end_date: endDate,
        time_zone: timeZone,
        generate_weeks_ahead: weeks,
        status: "ACTIVE",
        next_rotation_index: 0,
        generated_through_date: null,
        created_by_member_id: member.id,
        created_at: ts,
        updated_at: ts
      };
      setMapCommitted(this.store.dutyRotas, rota.id, rota, undo);
      this._generateTasksForRota(rota, nowMs, undo);
      mutateObject(rota, { updated_at: ts }, undo);
      return { status: 201, code: "DUTY_ROTA_CREATED", data: this._rotaView(rota), headers: { Location: "/api/v1/rotas/" + rota.id } };
    }, idem.receipt, nowMs);
  }

  listDutyRotas(auth, params, query) {
    const { group } = this._groupAndMember(auth, String(params?.groupId || ""));
    const status = enumQuery(query, "status", DUTY_ROTA_STATUSES);
    const limit = parseLimit(query?.get?.("limit"));
    let rows = Array.from(this.store.dutyRotas.values()).filter((row) => row.group_id === group.id);
    if (status) rows = rows.filter((row) => row.status === status);
    rows = sortedByTimeThenId(rows, "created_at", { descending: true });
    const page = paginateRows(rows, { cursor: query?.get?.("cursor") || null, limit }, (row) => row.id);
    return { status: 200, code: "DUTY_ROTAS_LISTED", data: page.page.map((row) => this._rotaView(row)), nextCursor: page.nextCursor };
  }

  _requireRotaVisible(auth, rotaId) {
    const id = requireUuid(rotaId, "rotaId");
    const rota = this.store.dutyRotas.get(id);
    if (!rota) throw domainError("DUTY_ROTA_NOT_FOUND", "Duty rota does not exist or is not visible");
    const group = this.store.groups.get(rota.group_id);
    if (!group) throw domainError("DUTY_ROTA_NOT_FOUND", "Duty rota group is not visible");
    this._requireDirectResourceMember(group, auth, "DUTY_PERMISSION_DENIED");
    return { rota, group, member: this._activeMembership(group.id, auth.cloudUserId) };
  }

  getDutyRota(auth, params) {
    const { rota } = this._requireRotaVisible(auth, params?.rotaId);
    return { status: 200, code: "DUTY_ROTA_OK", data: this._rotaView(rota) };
  }

  updateDutyRota(auth, params, body, headers, nowMs = Date.now()) {
    const rotaId = String(params?.rotaId || "");
    const idem = this._idempotency("updateDutyRota", auth, headers, body, { rotaId });
    if (idem.replay) return idem.replay;
    validateKeySet(body, ["title", "description", "rotation_member_ids", "frequency", "days_of_week", "end_date", "status", "generate_weeks_ahead"], "update duty rota body");
    if (Object.keys(body || {}).length === 0) throw badRequest("at least one rota field is required");
    const { rota, group, member } = this._requireRotaVisible(auth, rotaId);
    if (!["OWNER", "ADMIN"].includes(member.role)) throw domainError("DUTY_PERMISSION_DENIED", "group owner or admin role is required");
    const next = {
      title: body.title === undefined ? rota.title : requireString(body.title, "title", { max: 80 }),
      description: body.description === undefined ? rota.description : normalizeText(body.description, "description", { min: 0, max: 500 }),
      rotation_member_ids: body.rotation_member_ids === undefined ? clone(rota.rotation_member_ids) : this._validateRotationMembers(body.rotation_member_ids, group),
      frequency: body.frequency === undefined ? rota.frequency : requireAllowed(body.frequency, new Set(["DAILY", "WEEKLY"]), "frequency"),
      end_date: body.end_date === undefined ? rota.end_date : (body.end_date === null ? null : parseDateOnly(body.end_date, "end_date")),
      status: body.status === undefined ? rota.status : requireAllowed(body.status, DUTY_ROTA_STATUSES, "status"),
      generate_weeks_ahead: body.generate_weeks_ahead === undefined ? rota.generate_weeks_ahead : requireInteger(body.generate_weeks_ahead, "generate_weeks_ahead", { min: 1, max: 12 })
    };
    next.days_of_week = this._validateDaysOfWeek(body.days_of_week === undefined ? rota.days_of_week : body.days_of_week, next.frequency, next.frequency === "WEEKLY");
    if (next.end_date && compareDate(next.end_date, rota.start_date) < 0) throw domainError("DUTY_SCHEDULE_INVALID", "end_date must not be before start_date");
    return this._commitWithReceipt((undo) => {
      mutateObject(rota, { ...next, updated_at: iso(nowMs) }, undo);
      this._generateTasksForRota(rota, nowMs, undo);
      return { status: 200, code: "DUTY_ROTA_UPDATED", data: this._rotaView(rota) };
    }, idem.receipt, nowMs);
  }

  listDutyTasks(auth, params, query) {
    const { group } = this._groupAndMember(auth, String(params?.groupId || ""));
    const status = enumQuery(query, "status", DUTY_TASK_STATUSES);
    const assigned = optionalUuidQuery(query, "assigned_member_id");
    const fromDate = query?.get?.("from_date") ? parseDateOnly(query.get("from_date"), "from_date") : null;
    const toDate = query?.get?.("to_date") ? parseDateOnly(query.get("to_date"), "to_date") : null;
    if (fromDate && toDate && compareDate(toDate, fromDate) < 0) throw badRequest("to_date must not be before from_date");
    const limit = parseLimit(query?.get?.("limit"));
    let rows = Array.from(this.store.dutyTasks.values()).filter((row) => row.group_id === group.id);
    if (status) rows = rows.filter((row) => row.status === status);
    if (assigned) rows = rows.filter((row) => row.assigned_member_id === assigned);
    if (fromDate) rows = rows.filter((row) => compareDate(row.due_date, fromDate) >= 0);
    if (toDate) rows = rows.filter((row) => compareDate(row.due_date, toDate) <= 0);
    rows = [...rows].sort((a, b) => compareDate(a.due_date, b.due_date) || String(a.id).localeCompare(String(b.id)));
    const page = paginateRows(rows, { cursor: query?.get?.("cursor") || null, limit }, (row) => row.id);
    return { status: 200, code: "DUTY_TASKS_LISTED", data: page.page.map((row) => this._taskView(row)), nextCursor: page.nextCursor };
  }

  _requireTaskVisible(auth, taskId) {
    const id = requireUuid(taskId, "taskId");
    const task = this.store.dutyTasks.get(id);
    if (!task) throw domainError("DUTY_TASK_NOT_FOUND", "Duty task does not exist or is not visible");
    const group = this.store.groups.get(task.group_id);
    if (!group) throw domainError("DUTY_TASK_NOT_FOUND", "Duty task group is not visible");
    this._requireDirectResourceMember(group, auth, "DUTY_PERMISSION_DENIED");
    return { task, group, member: this._activeMembership(group.id, auth.cloudUserId) };
  }

  _appendDutyTaskEvent({ group, task, actorMember, actorCloudUserId, action, occurredAt }, undo) {
    const eventId = crypto.randomUUID();
    const payload = {
      event_id: eventId,
      event_key: "dis:group:" + group.id + ":duty-task:" + task.id + ":" + action + ":v1",
      event_type: action,
      occurred_at: occurredAt,
      group_id: group.id,
      school_id: group.school_id,
      rota_id: task.rota_id,
      task_id: task.id,
      assigned_member_id: task.assigned_member_id,
      actor_member_id: actorMember.id,
      actor_cloud_user_id: actorCloudUserId,
      due_date: task.due_date,
      status: task.status
    };
    return this._appendLedgerEvent({ aggregateType: "duty_task", aggregateId: task.id, eventType: "duty.task." + action, payload }, undo);
  }

  completeDutyTask(auth, params, body, headers, nowMs = Date.now()) {
    const taskId = String(params?.taskId || "");
    const idem = this._idempotency("completeDutyTask", auth, headers, body ?? {}, { taskId });
    if (idem.replay) return idem.replay;
    validateKeySet(body ?? {}, ["completion_note"], "complete duty task body");
    const note = normalizeText(body?.completion_note, "completion_note", { min: 0, max: 240 });
    const { task, group, member } = this._requireTaskVisible(auth, taskId);
    if (task.assigned_member_id !== member.id) throw domainError("DUTY_PERMISSION_DENIED", "only the currently assigned member can complete this task");
    if (task.status !== "PENDING") throw domainError("DUTY_TASK_INVALID_STATE", "only a PENDING task can be completed");
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      mutateObject(task, {
        status: "COMPLETED",
        completion_note: note,
        completed_at: ts,
        completed_by_member_id: member.id,
        updated_at: ts
      }, undo);
      this._appendDutyTaskEvent({ group, task, actorMember: member, actorCloudUserId: auth.cloudUserId, action: "completed", occurredAt: ts }, undo);
      return { status: 200, code: "DUTY_TASK_COMPLETED", data: this._taskView(task) };
    }, idem.receipt, nowMs);
  }

  confirmDutyTaskCompletion(auth, params, body, headers, nowMs = Date.now()) {
    const taskId = String(params?.taskId || "");
    const idem = this._idempotency("confirmDutyTaskCompletion", auth, headers, body ?? {}, { taskId });
    if (idem.replay) return idem.replay;
    validateKeySet(body ?? {}, ["confirmation_note"], "confirm duty task body");
    const note = normalizeText(body?.confirmation_note, "confirmation_note", { min: 0, max: 240 });
    const { task, group, member } = this._requireTaskVisible(auth, taskId);
    if (task.assigned_member_id === member.id) throw domainError("DUTY_CONFIRMATION_NOT_ALLOWED", "duty completion must be confirmed by a different active member");
    if (task.status !== "COMPLETED") throw domainError("DUTY_TASK_INVALID_STATE", "only a COMPLETED task can be confirmed");
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      mutateObject(task, {
        status: "CONFIRMED",
        confirmation_note: note,
        confirmed_at: ts,
        confirmed_by_member_id: member.id,
        updated_at: ts
      }, undo);
      this._appendDutyTaskEvent({ group, task, actorMember: member, actorCloudUserId: auth.cloudUserId, action: "confirmed", occurredAt: ts }, undo);
      return { status: 200, code: "DUTY_TASK_CONFIRMED", data: this._taskView(task) };
    }, idem.receipt, nowMs);
  }

  skipDutyTask(auth, params, body, headers, nowMs = Date.now()) {
    const taskId = String(params?.taskId || "");
    const idem = this._idempotency("skipDutyTask", auth, headers, body, { taskId });
    if (idem.replay) return idem.replay;
    validateKeySet(body, ["skip_reason"], "skip duty task body");
    const reason = requireString(body?.skip_reason, "skip_reason", { max: 240 });
    const { task, group, member } = this._requireTaskVisible(auth, taskId);
    if (!["OWNER", "ADMIN"].includes(member.role)) throw domainError("DUTY_PERMISSION_DENIED", "group owner or admin role is required to skip a task");
    if (task.status !== "PENDING") throw domainError("DUTY_TASK_INVALID_STATE", "only a PENDING task can be skipped");
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      mutateObject(task, {
        status: "SKIPPED",
        skip_reason: reason,
        skipped_at: ts,
        skipped_by_member_id: member.id,
        updated_at: ts
      }, undo);
      this._appendDutyTaskEvent({ group, task, actorMember: member, actorCloudUserId: auth.cloudUserId, action: "skipped", occurredAt: ts }, undo);
      return { status: 200, code: "DUTY_TASK_SKIPPED", data: this._taskView(task) };
    }, idem.receipt, nowMs);
  }

  _appendDutySwapEvent({ group, swap, actorMember, actorCloudUserId, action, reassigned, occurredAt }, undo) {
    const eventId = crypto.randomUUID();
    const payload = {
      event_id: eventId,
      event_key: "dis:group:" + group.id + ":duty-swap:" + swap.id + ":" + action + ":v1",
      event_type: action,
      occurred_at: occurredAt,
      group_id: group.id,
      school_id: group.school_id,
      rota_id: swap.rota_id,
      duty_task_id: swap.duty_task_id,
      swap_id: swap.id,
      requested_by_member_id: swap.requested_by_member_id,
      target_member_id: swap.target_member_id,
      actor_member_id: actorMember.id,
      actor_cloud_user_id: actorCloudUserId,
      swap_type: swap.type,
      status: swap.status,
      reassigned: Boolean(reassigned)
    };
    return this._appendLedgerEvent({ aggregateType: "duty_swap", aggregateId: swap.id, eventType: "duty.swap." + action, payload }, undo);
  }

  requestDutySwap(auth, params, body, headers, nowMs = Date.now()) {
    const rotaId = String(params?.rotaId || "");
    const idem = this._idempotency("requestDutySwap", auth, headers, body, { rotaId });
    if (idem.replay) return idem.replay;
    validateKeySet(body, ["duty_task_id", "type", "target_member_id", "reason"], "request duty swap body");
    const { rota, group, member } = this._requireRotaVisible(auth, rotaId);
    const taskId = requireUuid(body.duty_task_id, "duty_task_id");
    const task = this.store.dutyTasks.get(taskId);
    if (!task || task.rota_id !== rota.id) throw domainError("DUTY_TASK_NOT_FOUND", "duty task does not belong to this rota");
    if (task.status !== "PENDING") throw domainError("DUTY_SCHEDULE_INVALID", "swap or cover can only target a PENDING duty task");
    const isAssignee = task.assigned_member_id === member.id;
    const isManager = ["OWNER", "ADMIN"].includes(member.role);
    if (!isAssignee && !isManager) throw domainError("DUTY_PERMISSION_DENIED", "only the assignee or a group owner/admin can request a swap");
    const type = requireAllowed(body.type, DUTY_SWAP_TYPES, "type");
    const targetId = requireUuid(body.target_member_id, "target_member_id");
    if (targetId === task.assigned_member_id) throw domainError("DUTY_SCHEDULE_INVALID", "target_member_id must differ from the current assignee");
    this._requireActiveMemberInGroup(group, targetId, "DUTY_SCHEDULE_INVALID");
    const reason = normalizeText(body.reason, "reason", { min: 0, max: 240 });
    const existing = Array.from(this.store.dutySwaps.values()).find((row) => row.duty_task_id === task.id && row.status === "PENDING");
    if (existing) throw domainError("DUTY_SCHEDULE_INVALID", "a pending swap or cover request already exists for this task");
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const swap = {
        id: crypto.randomUUID(),
        rota_id: rota.id,
        duty_task_id: task.id,
        group_id: group.id,
        school_id: group.school_id,
        type,
        requested_by_member_id: member.id,
        target_member_id: targetId,
        reason,
        status: "PENDING",
        resolution_note: null,
        resolved_by_member_id: null,
        created_at: ts,
        resolved_at: null
      };
      setMapCommitted(this.store.dutySwaps, swap.id, swap, undo);
      this._appendDutySwapEvent({ group, swap, actorMember: member, actorCloudUserId: auth.cloudUserId, action: "requested", reassigned: false, occurredAt: ts }, undo);
      return { status: 201, code: "DUTY_SWAP_REQUESTED", data: this._swapView(swap), headers: { Location: "/api/v1/duty-swaps/" + swap.id } };
    }, idem.receipt, nowMs);
  }

  listDutySwaps(auth, params, query) {
    const { rota } = this._requireRotaVisible(auth, params?.rotaId);
    const status = enumQuery(query, "status", DUTY_SWAP_STATUSES);
    const taskId = optionalUuidQuery(query, "duty_task_id");
    const limit = parseLimit(query?.get?.("limit"));
    let rows = Array.from(this.store.dutySwaps.values()).filter((row) => row.rota_id === rota.id);
    if (status) rows = rows.filter((row) => row.status === status);
    if (taskId) rows = rows.filter((row) => row.duty_task_id === taskId);
    rows = sortedByTimeThenId(rows, "created_at", { descending: true });
    const page = paginateRows(rows, { cursor: query?.get?.("cursor") || null, limit }, (row) => row.id);
    return { status: 200, code: "DUTY_SWAPS_LISTED", data: page.page.map((row) => this._swapView(row)), nextCursor: page.nextCursor };
  }

  _requireSwapVisible(auth, swapId) {
    const id = requireUuid(swapId, "swapId");
    const swap = this.store.dutySwaps.get(id);
    if (!swap) throw domainError("DUTY_SWAP_NOT_FOUND", "Duty swap does not exist or is not visible");
    const group = this.store.groups.get(swap.group_id);
    if (!group) throw domainError("DUTY_SWAP_NOT_FOUND", "Duty swap group is not visible");
    this._requireDirectResourceMember(group, auth, "DUTY_PERMISSION_DENIED");
    return { swap, group, member: this._activeMembership(group.id, auth.cloudUserId) };
  }

  getDutySwap(auth, params) {
    const { swap } = this._requireSwapVisible(auth, params?.swapId);
    return { status: 200, code: "DUTY_SWAP_OK", data: this._swapView(swap) };
  }

  resolveDutySwap(auth, params, body, headers, nowMs = Date.now()) {
    const swapId = String(params?.swapId || "");
    const idem = this._idempotency("resolveDutySwap", auth, headers, body, { swapId });
    if (idem.replay) return idem.replay;
    validateKeySet(body, ["action", "resolution_note"], "resolve duty swap body");
    const action = requireAllowed(body?.action, DUTY_SWAP_ACTIONS, "action");
    const note = normalizeText(body?.resolution_note, "resolution_note", { min: 0, max: 240 });
    const { swap, group, member } = this._requireSwapVisible(auth, swapId);
    if (swap.status !== "PENDING") throw domainError("DUTY_SWAP_INVALID_STATE", "terminal swap records cannot be rewritten");
    const isTarget = swap.target_member_id === member.id;
    const isRequester = swap.requested_by_member_id === member.id;
    const isManager = ["OWNER", "ADMIN"].includes(member.role);
    const allowed =
      (action === "CANCEL" && isRequester) ||
      ((action === "ACCEPT" || action === "REJECT") && (isTarget || isManager));
    if (!allowed) throw domainError("DUTY_PERMISSION_DENIED", "caller cannot resolve this swap with the requested action");
    const task = this.store.dutyTasks.get(swap.duty_task_id);
    if (!task) throw domainError("DUTY_TASK_NOT_FOUND", "referenced duty task no longer exists");
    if (action === "ACCEPT" && task.status !== "PENDING") {
      throw domainError("DUTY_SWAP_INVALID_STATE", "acceptance is blocked because the referenced task is no longer PENDING");
    }
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const nextStatus = action === "ACCEPT" ? "ACCEPTED" : action === "REJECT" ? "REJECTED" : "CANCELLED";
      mutateObject(swap, {
        status: nextStatus,
        resolution_note: note,
        resolved_by_member_id: member.id,
        resolved_at: ts
      }, undo);
      let reassigned = false;
      if (action === "ACCEPT") {
        mutateObject(task, { assigned_member_id: swap.target_member_id, updated_at: ts }, undo);
        reassigned = true;
      }
      this._appendDutySwapEvent({ group, swap, actorMember: member, actorCloudUserId: auth.cloudUserId, action: "resolved", reassigned, occurredAt: ts }, undo);
      return { status: 200, code: "DUTY_SWAP_RESOLVED", data: this._swapView(swap) };
    }, idem.receipt, nowMs);
  }

  createRepairTicket(auth, params, body, headers, nowMs = Date.now()) {
    const groupId = String(params?.groupId || "");
    const idem = this._idempotency("createRepairTicket", auth, headers, body, { groupId });
    if (idem.replay) return idem.replay;
    validateKeySet(body, ["title", "category", "location_text", "description"], "create repair ticket body");
    const { group, member } = this._groupAndMember(auth, groupId);
    const title = requireString(body.title, "title", { max: 120 });
    const category = requireAllowed(body.category, REPAIR_CATEGORIES, "category");
    const location = requireString(body.location_text, "location_text", { max: 120 });
    const description = requireString(body.description, "description", { max: 2000 });
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const repair = {
        id: crypto.randomUUID(),
        group_id: group.id,
        school_id: group.school_id,
        title,
        category,
        location_text: location,
        description,
        reporter_member_id: member.id,
        assigned_member_id: null,
        status: "OPEN",
        status_revision: 1,
        resolution_note: null,
        review_id: null,
        official_work_order: false,
        created_at: ts,
        updated_at: ts,
        triaged_at: null,
        started_at: null,
        resolved_at: null,
        rejected_at: null,
        closed_at: null
      };
      setMapCommitted(this.store.repairTickets, repair.id, repair, undo);
      this._appendRepairEvent({ group, repair, actorMember: member, actorCloudUserId: auth.cloudUserId, action: "created", occurredAt: ts }, undo);
      return { status: 201, code: "REPAIR_TICKET_CREATED", data: this._repairView(repair), headers: { Location: "/api/v1/repairs/" + repair.id } };
    }, idem.receipt, nowMs);
  }

  _appendRepairEvent({ group, repair, actorMember, actorCloudUserId, action, occurredAt }, undo) {
    const eventId = crypto.randomUUID();
    const keyAction = action === "created" ? "created" : "status:" + repair.status_revision;
    const payload = {
      event_id: eventId,
      event_key: "dis:group:" + group.id + ":repair:" + repair.id + ":" + keyAction + ":v1",
      event_type: action,
      occurred_at: occurredAt,
      group_id: group.id,
      school_id: group.school_id,
      repair_id: repair.id,
      reporter_member_id: repair.reporter_member_id,
      actor_member_id: actorMember.id,
      actor_cloud_user_id: actorCloudUserId,
      category: repair.category,
      status: repair.status,
      status_revision: repair.status_revision,
      official_work_order: false
    };
    return this._appendLedgerEvent({ aggregateType: "repair", aggregateId: repair.id, eventType: action === "created" ? "repair.created" : "repair.status_changed", payload }, undo);
  }

  listRepairTickets(auth, params, query) {
    const { group } = this._groupAndMember(auth, String(params?.groupId || ""));
    const status = enumQuery(query, "status", REPAIR_STATUSES);
    const limit = parseLimit(query?.get?.("limit"));
    let rows = Array.from(this.store.repairTickets.values()).filter((row) => row.group_id === group.id);
    if (status) rows = rows.filter((row) => row.status === status);
    rows = sortedByTimeThenId(rows, "created_at", { descending: true });
    const page = paginateRows(rows, { cursor: query?.get?.("cursor") || null, limit }, (row) => row.id);
    return { status: 200, code: "REPAIR_TICKETS_LISTED", data: page.page.map((row) => this._repairView(row)), nextCursor: page.nextCursor };
  }

  _requireRepairVisible(auth, repairId) {
    const id = requireUuid(repairId, "repairId");
    const repair = this.store.repairTickets.get(id);
    if (!repair) throw domainError("REPAIR_NOT_FOUND", "Repair ticket does not exist or is not visible");
    const group = this.store.groups.get(repair.group_id);
    if (!group) throw domainError("REPAIR_NOT_FOUND", "Repair ticket group is not visible");
    this._requireDirectResourceMember(group, auth, "REPAIR_PERMISSION_DENIED");
    return { repair, group, member: this._activeMembership(group.id, auth.cloudUserId) };
  }

  getRepairTicket(auth, params) {
    const { repair } = this._requireRepairVisible(auth, params?.repairId);
    return { status: 200, code: "REPAIR_TICKET_OK", data: this._repairView(repair) };
  }

  updateRepairTicket(auth, params, body, headers, nowMs = Date.now()) {
    const repairId = String(params?.repairId || "");
    const idem = this._idempotency("updateRepairTicket", auth, headers, body, { repairId });
    if (idem.replay) return idem.replay;
    validateKeySet(body, ["title", "category", "location_text", "description"], "update repair ticket body");
    if (Object.keys(body || {}).length === 0) throw badRequest("at least one repair field is required");
    const { repair, member } = this._requireRepairVisible(auth, repairId);
    const isReporter = repair.reporter_member_id === member.id;
    const isManager = ["OWNER", "ADMIN"].includes(member.role);
    if (!isReporter && !isManager) throw domainError("REPAIR_PERMISSION_DENIED", "only the reporter or a group owner/admin can edit this repair");
    if (!["OPEN", "TRIAGED"].includes(repair.status)) throw domainError("REPAIR_INVALID_STATE", "repair ticket is no longer editable");
    const patch = {};
    if (body.title !== undefined) patch.title = requireString(body.title, "title", { max: 120 });
    if (body.category !== undefined) patch.category = requireAllowed(body.category, REPAIR_CATEGORIES, "category");
    if (body.location_text !== undefined) patch.location_text = requireString(body.location_text, "location_text", { max: 120 });
    if (body.description !== undefined) patch.description = requireString(body.description, "description", { max: 2000 });
    return this._commitWithReceipt((undo) => {
      const before = {
        title: repair.title,
        category: repair.category,
        location_text: repair.location_text,
        description: repair.description
      };
      mutateObject(repair, { ...patch, updated_at: iso(nowMs) }, undo);
      const revision = {
        id: crypto.randomUUID(),
        repair_id: repair.id,
        group_id: repair.group_id,
        school_id: repair.school_id,
        editor_member_id: member.id,
        before_json: before,
        after_json: {
          title: repair.title,
          category: repair.category,
          location_text: repair.location_text,
          description: repair.description
        },
        created_at: iso(nowMs)
      };
      setMapCommitted(this.store.repairTicketRevisions, revision.id, revision, undo);
      return { status: 200, code: "REPAIR_TICKET_UPDATED", data: this._repairView(repair) };
    }, idem.receipt, nowMs);
  }

  transitionRepairStatus(auth, params, body, headers, nowMs = Date.now()) {
    const repairId = String(params?.repairId || "");
    const idem = this._idempotency("transitionRepairStatus", auth, headers, body, { repairId });
    if (idem.replay) return idem.replay;
    validateKeySet(body, ["to_status", "note", "assigned_member_id"], "transition repair status body");
    const toStatus = requireAllowed(body?.to_status, REPAIR_STATUSES, "to_status");
    const note = normalizeText(body?.note, "note", { min: 0, max: 500 });
    const { repair, group, member } = this._requireRepairVisible(auth, repairId);
    if (!["OWNER", "ADMIN"].includes(member.role)) throw domainError("REPAIR_PERMISSION_DENIED", "group owner or admin role is required for repair status transitions");
    const valid =
      (repair.status === "OPEN" && ["TRIAGED", "REJECTED"].includes(toStatus)) ||
      (repair.status === "TRIAGED" && ["IN_PROGRESS", "REJECTED"].includes(toStatus)) ||
      (repair.status === "IN_PROGRESS" && toStatus === "RESOLVED") ||
      (repair.status === "RESOLVED" && toStatus === "CLOSED");
    if (!valid) throw domainError("REPAIR_STATUS_TRANSITION_INVALID", "requested repair status transition violates the explicit state machine");
    if (toStatus === "CLOSED" && !repair.review_id) {
      throw domainError("REPAIR_STATUS_TRANSITION_INVALID", "a reporter review is required before closing a resolved repair");
    }
    let assigned = repair.assigned_member_id ?? null;
    if (body.assigned_member_id !== undefined) {
      assigned = requireUuid(body.assigned_member_id, "assigned_member_id");
      this._requireActiveMemberInGroup(group, assigned, "REPAIR_PERMISSION_DENIED");
    }
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const patch = {
        status: toStatus,
        status_revision: Number(repair.status_revision || 1) + 1,
        assigned_member_id: assigned,
        updated_at: ts
      };
      if (note !== null) patch.resolution_note = note;
      if (toStatus === "TRIAGED") patch.triaged_at = ts;
      if (toStatus === "IN_PROGRESS") patch.started_at = ts;
      if (toStatus === "RESOLVED") patch.resolved_at = ts;
      if (toStatus === "REJECTED") patch.rejected_at = ts;
      if (toStatus === "CLOSED") patch.closed_at = ts;
      mutateObject(repair, patch, undo);
      this._appendRepairEvent({ group, repair, actorMember: member, actorCloudUserId: auth.cloudUserId, action: "status_changed", occurredAt: ts }, undo);
      return { status: 200, code: "REPAIR_STATUS_CHANGED", data: this._repairView(repair) };
    }, idem.receipt, nowMs);
  }

  submitRepairReview(auth, params, body, headers, nowMs = Date.now()) {
    const repairId = String(params?.repairId || "");
    const idem = this._idempotency("submitRepairReview", auth, headers, body, { repairId });
    if (idem.replay) return idem.replay;
    validateKeySet(body, ["rating", "comment"], "submit repair review body");
    const rating = requireInteger(body?.rating, "rating", { min: 1, max: 5 });
    const comment = normalizeText(body?.comment, "comment", { min: 0, max: 500 });
    const { repair, group, member } = this._requireRepairVisible(auth, repairId);
    if (repair.reporter_member_id !== member.id) throw domainError("REPAIR_PERMISSION_DENIED", "only the reporter can review this repair");
    if (repair.status !== "RESOLVED" || repair.review_id) throw domainError("REPAIR_REVIEW_INVALID", "repair review is allowed only once after RESOLVED");
    return this._commitWithReceipt((undo) => {
      const ts = iso(nowMs);
      const review = {
        id: crypto.randomUUID(),
        repair_id: repair.id,
        group_id: group.id,
        school_id: group.school_id,
        reviewer_member_id: member.id,
        rating,
        comment,
        created_at: ts
      };
      setMapCommitted(this.store.repairReviews, review.id, review, undo);
      mutateObject(repair, { review_id: review.id, updated_at: ts }, undo);
      const eventId = crypto.randomUUID();
      const payload = {
        event_id: eventId,
        event_key: "dis:group:" + group.id + ":repair:" + repair.id + ":review:" + review.id + ":v1",
        event_type: "reviewed",
        occurred_at: ts,
        group_id: group.id,
        school_id: group.school_id,
        repair_id: repair.id,
        review_id: review.id,
        reviewer_member_id: member.id,
        reviewer_cloud_user_id: auth.cloudUserId,
        rating
      };
      this._appendLedgerEvent({ aggregateType: "repair", aggregateId: repair.id, eventType: "repair.reviewed", payload }, undo);
      return { status: 201, code: "REPAIR_REVIEW_CREATED", data: this._reviewView(review) };
    }, idem.receipt, nowMs);
  }

  exportUserData(cloudUserId) {
    const memberships = Array.from(this.store.groupMembers.values()).filter((member) => member.cloud_user_id === cloudUserId);
    const memberIds = new Set(memberships.map((member) => member.id));
    const involves = (ids) => ids.some((id) => memberIds.has(id));
    const entries = Array.from(this.store.ledgerEntries.values()).filter((row) =>
      memberIds.has(row.paid_by_member_id) || memberIds.has(row.created_by_member_id) || (row.shares || []).some((share) => memberIds.has(share.participant_member_id))
    );
    const settlements = Array.from(this.store.settlements.values()).filter((row) =>
      involves([row.debtor_member_id, row.creditor_member_id, row.created_by_member_id, row.cancelled_by_member_id].filter(Boolean))
    );
    const rotas = Array.from(this.store.dutyRotas.values()).filter((row) =>
      memberIds.has(row.created_by_member_id) || (row.rotation_member_ids || []).some((id) => memberIds.has(id))
    );
    const rotaIds = new Set(rotas.map((row) => row.id));
    const tasks = Array.from(this.store.dutyTasks.values()).filter((row) =>
      rotaIds.has(row.rota_id) || involves([row.assigned_member_id, row.completed_by_member_id, row.confirmed_by_member_id, row.skipped_by_member_id].filter(Boolean))
    );
    const swaps = Array.from(this.store.dutySwaps.values()).filter((row) =>
      rotaIds.has(row.rota_id) || involves([row.requested_by_member_id, row.target_member_id, row.resolved_by_member_id].filter(Boolean))
    );
    const repairs = Array.from(this.store.repairTickets.values()).filter((row) => involves([row.reporter_member_id, row.assigned_member_id].filter(Boolean)));
    const repairIds = new Set(repairs.map((row) => row.id));
    return {
      ledger_entries: clone(entries.map((row) => this._entryView(row))),
      ledger_settlements: clone(settlements.map((row) => this._settlementView(row))),
      duty_rotas: clone(rotas.map((row) => this._rotaView(row))),
      duty_tasks: clone(tasks.map((row) => this._taskView(row))),
      duty_swaps: clone(swaps.map((row) => this._swapView(row))),
      repair_tickets: clone(repairs.map((row) => this._repairView(row))),
      repair_ticket_revisions: clone(Array.from(this.store.repairTicketRevisions.values()).filter((row) => repairIds.has(row.repair_id) || memberIds.has(row.editor_member_id))),
      repair_reviews: clone(Array.from(this.store.repairReviews.values()).filter((row) => repairIds.has(row.repair_id) || memberIds.has(row.reviewer_member_id)).map((row) => this._reviewView(row)))
    };
  }

  purgeUserLedgerData(cloudUserId, nowMs = Date.now()) {
    const groupIds = new Set(Array.from(this.store.groups.keys()));
    let ledgerRowsDeleted = 0;
    let settlementsDeleted = 0;
    let dutyRowsDeleted = 0;
    let repairRowsDeleted = 0;
    const deleteCascadeForMissingGroups = () => {
      const missingGroupIds = new Set();
      const check = (row) => row && !groupIds.has(row.group_id) && missingGroupIds.add(row.group_id);
      for (const row of this.store.ledgerEntries.values()) check(row);
      for (const row of this.store.settlements.values()) check(row);
      for (const row of this.store.dutyRotas.values()) check(row);
      for (const row of this.store.repairTickets.values()) check(row);
      for (const groupId of missingGroupIds) {
        for (const [id, row] of Array.from(this.store.ledgerEntries.entries())) if (row.group_id === groupId && this.store.ledgerEntries.delete(id)) ledgerRowsDeleted += 1;
        for (const [id, row] of Array.from(this.store.settlements.entries())) if (row.group_id === groupId && this.store.settlements.delete(id)) settlementsDeleted += 1;
        for (const [id, row] of Array.from(this.store.ledgerBalanceRevisions.entries())) if (row.group_id === groupId) this.store.ledgerBalanceRevisions.delete(id);
        for (const [id, row] of Array.from(this.store.dutyRotas.entries())) if (row.group_id === groupId && this.store.dutyRotas.delete(id)) dutyRowsDeleted += 1;
        for (const [id, row] of Array.from(this.store.dutyTasks.entries())) if (row.group_id === groupId && this.store.dutyTasks.delete(id)) dutyRowsDeleted += 1;
        for (const [id, row] of Array.from(this.store.dutySwaps.entries())) if (row.group_id === groupId && this.store.dutySwaps.delete(id)) dutyRowsDeleted += 1;
        for (const [id, row] of Array.from(this.store.repairTickets.entries())) if (row.group_id === groupId && this.store.repairTickets.delete(id)) repairRowsDeleted += 1;
        for (const [id, row] of Array.from(this.store.repairTicketRevisions.entries())) if (row.group_id === groupId && this.store.repairTicketRevisions.delete(id)) repairRowsDeleted += 1;
        for (const [id, row] of Array.from(this.store.repairReviews.entries())) if (row.group_id === groupId && this.store.repairReviews.delete(id)) repairRowsDeleted += 1;
      }
    };
    deleteCascadeForMissingGroups();

    let eventsScrubbed = 0;
    for (const event of this.store.outboxEvents || []) {
      if (!["ledger_entry", "settlement", "duty_task", "duty_swap", "repair"].includes(event?.aggregate_type) || !event.payload_json) continue;
      const counter = { count: 0 };
      event.payload_json = pseudonymizeExactUserIdRefs(event.payload_json, cloudUserId, LEDGER_DELETED_USER_TOMBSTONE, counter);
      if (counter.count > 0) eventsScrubbed += 1;
    }

    let receiptsDeleted = 0;
    let receiptsPseudonymized = 0;
    if (this.store.idempotencyRecords instanceof Map) {
      const ownPrefixes = LEDGER_IDEMPOTENCY_OPS.map((op) => op + "|" + cloudUserId + "|");
      const domainPrefixes = LEDGER_IDEMPOTENCY_OPS.map((op) => op + "|");
      for (const [key, record] of Array.from(this.store.idempotencyRecords.entries())) {
        if (ownPrefixes.some((prefix) => key.startsWith(prefix))) {
          this.store.idempotencyRecords.delete(key);
          receiptsDeleted += 1;
          continue;
        }
        if (!domainPrefixes.some((prefix) => key.startsWith(prefix)) || !record || typeof record !== "object") continue;
        const counter = { count: 0 };
        if (record.data !== undefined) record.data = pseudonymizeExactUserIdRefs(record.data, cloudUserId, LEDGER_DELETED_USER_TOMBSTONE, counter);
        if (record.headers !== undefined) record.headers = pseudonymizeExactUserIdRefs(record.headers, cloudUserId, LEDGER_DELETED_USER_TOMBSTONE, counter);
        if (counter.count > 0) receiptsPseudonymized += 1;
      }
    }
    this.store._rebuildIndexes?.();
    return {
      cascade_missing_group_ledger_rows_deleted: ledgerRowsDeleted,
      cascade_missing_group_settlements_deleted: settlementsDeleted,
      cascade_missing_group_duty_rows_deleted: dutyRowsDeleted,
      cascade_missing_group_repair_rows_deleted: repairRowsDeleted,
      events_scrubbed: eventsScrubbed,
      idempotency_receipts_deleted: receiptsDeleted,
      idempotency_receipts_pseudonymized: receiptsPseudonymized,
      purged_at: iso(nowMs)
    };
  }
}
