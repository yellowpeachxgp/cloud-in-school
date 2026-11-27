import { ContractError } from "../../contracts/src/index.mjs";

export const INT64_MIN = -(1n << 63n);
export const INT64_MAX = (1n << 63n) - 1n;
const SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

function ledgerError(code, message) {
  return new ContractError(code, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function fenToJsonValue(value) {
  const big = value instanceof BigInt ? value : BigInt(value);
  return big >= SAFE_MIN && big <= SAFE_MAX ? Number(big) : big.toString();
}

export function fenToStorageValue(value) {
  return fenToJsonValue(value);
}

export function fenToBigInt(value) {
  if (value instanceof BigInt) return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw ledgerError("ARITHMETIC_OVERFLOW", "integer fen value is outside the exactly representable runtime integer range");
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw ledgerError("BAD_REQUEST", "integer fen value must be a signed integer");
}

export function parseLedgerAmountInput(value, field, { literal = null, allowZero = false, positive = false } = {}) {
  if (literal !== null && literal !== undefined && !/^-?\d+$/.test(String(literal))) {
    throw ledgerError("BAD_REQUEST", field + " must be a plain integer fen literal, not a floating-point or exponent literal");
  }
  let big;
  if (value instanceof BigInt) {
    big = value;
  } else if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw ledgerError("BAD_REQUEST", field + " must be an integer number of fen");
    }
    if (Number.isSafeInteger(value)) {
      big = BigInt(value);
    } else if (literal !== null && literal !== undefined) {
      big = BigInt(String(literal));
    } else {
      throw ledgerError("ARITHMETIC_OVERFLOW", field + " cannot be represented exactly as a JSON number without its source literal");
    }
  } else if (typeof value === "string" && /^-?\d+$/.test(value)) {
    // Internal/domain callers may pass decimal strings for exact int64 values. The HTTP
    // schema still accepts JSON numbers only; service ingress never treats strings as numbers.
    big = BigInt(value);
  } else {
    throw ledgerError("BAD_REQUEST", field + " must be an integer number of fen");
  }
  if (big < INT64_MIN || big > INT64_MAX) {
    throw ledgerError("ARITHMETIC_OVERFLOW", field + " is outside signed 64-bit fen range");
  }
  if (!allowZero && big === 0n) {
    throw ledgerError("BAD_REQUEST", field + " must be non-zero");
  }
  if (positive && big <= 0n) {
    throw ledgerError("NON_POSITIVE_SETTLEMENT_AMOUNT", field + " must be strictly positive fen");
  }
  return big;
}

function validateParticipantId(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw ledgerError("EMPTY_IDENTIFIER", "participant identifiers must not be empty");
  }
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code < 33 || code > 126) {
      throw ledgerError("INVALID_IDENTIFIER", "participant identifiers must use printable non-whitespace ASCII for stable cross-platform ordering");
    }
  }
  return raw;
}

function validateMembers(memberIds) {
  const list = Array.from(memberIds || [], validateParticipantId);
  if (list.length === 0) {
    throw ledgerError("EMPTY_PARTICIPANTS", "at least one participant is required");
  }
  const counts = new Map();
  for (const id of list) counts.set(id, (counts.get(id) || 0) + 1);
  const duplicates = Array.from(counts.entries()).filter(([, count]) => count > 1).map(([id]) => id).sort();
  if (duplicates.length > 0) {
    throw ledgerError("DUPLICATE_PARTICIPANT", "duplicate participant ids: " + duplicates.join(","));
  }
  return new Set(list);
}

function normalizeWeightMap(raw) {
  if (raw instanceof Map) return new Map(raw);
  if (Array.isArray(raw)) {
    const out = new Map();
    for (const row of raw) {
      if (!row || typeof row !== "object") continue;
      const id = row.member_id ?? row.participant_member_id ?? row.participantId ?? row.participantId;
      const weight = row.weight ?? row.days;
      out.set(validateParticipantId(id), weight instanceof BigInt ? weight : BigInt(weight));
    }
    return out;
  }
  if (isPlainObject(raw)) {
    const out = new Map();
    for (const [id, weight] of Object.entries(raw)) out.set(validateParticipantId(id), weight instanceof BigInt ? weight : BigInt(weight));
    return out;
  }
  return new Map();
}

function validateKnown(ids, members) {
  const unknown = Array.from(ids).filter((id) => !members.has(id)).sort();
  if (unknown.length > 0) {
    throw ledgerError("UNKNOWN_PARTICIPANT", "participants are not members of this split: " + unknown.join(","));
  }
}

function noEffectiveParticipants() {
  return ledgerError("NO_EFFECTIVE_PARTICIPANTS", "the split rule selects no participant with a positive weight");
}

function positiveWeights(raw, members, invalidCode, label) {
  validateKnown(raw.keys(), members);
  const negative = [];
  const positive = new Map();
  for (const [id, rawWeight] of raw) {
    let weight;
    try {
      weight = fenToBigInt(rawWeight);
    } catch {
      throw ledgerError(invalidCode, label + " must be a non-negative integer");
    }
    if (weight < 0n) {
      negative.push(id);
      continue;
    }
    if (weight > 0n) positive.set(id, weight);
  }
  if (negative.length > 0) {
    throw ledgerError(invalidCode, label + " must not be negative for: " + negative.sort().join(","));
  }
  if (positive.size === 0) throw noEffectiveParticipants();
  return positive;
}

function positiveWeightsFor(rule, members) {
  const type = rule?.type;
  if (type === "EQUAL") return new Map(Array.from(members, (id) => [id, 1n]));
  if (type === "SELECTED") {
    const selected = Array.from(rule.participant_member_ids || rule.participantIds || [], validateParticipantId);
    validateKnown(selected, members);
    const counts = new Map();
    for (const id of selected) counts.set(id, (counts.get(id) || 0) + 1);
    if (Array.from(counts.values()).some((count) => count > 1)) {
      throw ledgerError("DUPLICATE_PARTICIPANT", "duplicate selected participant ids");
    }
    if (selected.length === 0) throw noEffectiveParticipants();
    return new Map(selected.map((id) => [id, 1n]));
  }
  if (type === "RATIOS" || type === "RATIO") {
    return positiveWeights(normalizeWeightMap(rule.ratio_weights || rule.weights), members, "INVALID_RATIO_WEIGHT", "ratio weight");
  }
  if (type === "STAY_DAYS") {
    return positiveWeights(normalizeWeightMap(rule.stay_days || rule.days), members, "INVALID_STAY_DAYS", "stay days");
  }
  throw ledgerError("BAD_REQUEST", "split_rule.type is not an allowed value");
}

export function allocateLargestRemainderExact(totalFenInput, weights) {
  const total = fenToBigInt(totalFenInput);
  const participants = Array.from(weights.keys()).sort();
  if (participants.length === 0) throw noEffectiveParticipants();
  if (total === 0n) {
    return participants.map((id) => ({ participant_member_id: id, amount_fen: 0n }));
  }
  const negative = total < 0n;
  const magnitude = negative ? -total : total;
  let denominator = 0n;
  for (const id of participants) {
    const weight = fenToBigInt(weights.get(id));
    if (weight <= 0n) throw noEffectiveParticipants();
    denominator += weight;
  }
  const rows = participants.map((id) => {
    const weight = fenToBigInt(weights.get(id));
    const numerator = magnitude * weight;
    return {
      participant_member_id: id,
      base: numerator / denominator,
      remainder: numerator % denominator
    };
  });
  const baseSum = rows.reduce((sum, row) => sum + row.base, 0n);
  const extra = magnitude - baseSum;
  if (extra < 0n || extra >= BigInt(rows.length)) {
    throw new Error("largest-remainder invariant violated");
  }
  const priority = [...rows].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.participant_member_id < b.participant_member_id ? -1 : a.participant_member_id > b.participant_member_id ? 1 : 0;
  });
  const recipients = new Set(priority.slice(0, Number(extra)).map((row) => row.participant_member_id));
  return rows.map((row) => {
    let share = row.base + (recipients.has(row.participant_member_id) ? 1n : 0n);
    if (negative) share = -share;
    if (share < INT64_MIN || share > INT64_MAX) {
      throw ledgerError("ARITHMETIC_OVERFLOW", "split share overflowed signed 64-bit fen");
    }
    return { participant_member_id: row.participant_member_id, amount_fen: share };
  });
}

/** Exact Android core:ledger-compatible split. Return amounts are BigInt for lossless arithmetic. */
export function splitLedgerSharesExact(totalFen, memberIds, rule) {
  const members = validateMembers(memberIds);
  const weights = positiveWeightsFor(rule, members);
  return allocateLargestRemainderExact(totalFen, weights);
}

/** JSON-facing variant: safe integers stay numbers; outside-safe int64 values remain exact decimal strings. */
export function splitLedgerShares(totalFen, memberIds, rule) {
  return splitLedgerSharesExact(totalFen, memberIds, rule).map((share) => ({
    participant_member_id: share.participant_member_id,
    amount_fen: fenToJsonValue(share.amount_fen)
  }));
}
