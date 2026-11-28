import { dataPackInvalid } from "./errors.mjs";

export const DATAPACK_FORMAT = "dis-datapack/v1";
export const DATAPACK_KINDS = Object.freeze([
  "procedure-guide",
  "opportunity-catalog",
  "facility-catalog",
  "indoor-graph",
  "period-preset",
  "pharmacy-catalog"
]);
export const DATAPACK_VERIFICATION_LEVELS = Object.freeze([
  "UNVERIFIED",
  "SOURCE_CONFIRMED",
  "MOCK_TESTED",
  "DEVICE_TESTED",
  "SCHOOL_VERIFIED",
  "DISTRIBUTION_READY"
]);

const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const SCHOOL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const VERSION_PATTERN = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/;
const MAINTAINER_PATTERN = /^[a-z0-9-]+:[^\s]+$/;
const ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,119}$/;
const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const DATE_TIME_PATTERN = /^([0-9]{4}-[0-9]{2}-[0-9]{2})[Tt]([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?([Zz]|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$/;
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function fail(path, message) {
  throw dataPackInvalid("dis-datapack/v1 schema violation at " + path + ": " + message, {
    reason: "SCHEMA_INVALID",
    path
  });
}

function child(path, key) {
  return path + "." + key;
}

function codePointLength(value) {
  return [...value].length;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectObject(value, path, allowedKeys, requiredKeys) {
  if (!isPlainObject(value)) fail(path, "must be an object");
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) fail(child(path, key), "additional property is not allowed");
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(child(path, key), "required property is missing");
  }
  return value;
}

function expectArray(value, path, minItems = 0) {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length < minItems) fail(path, "must contain at least " + minItems + " item(s)");
  return value;
}

function expectString(value, path, { min = 0, max = Infinity, pattern = null } = {}) {
  if (typeof value !== "string") fail(path, "must be a string");
  const length = codePointLength(value);
  if (length < min) fail(path, "length must be at least " + min);
  if (length > max) fail(path, "length must be at most " + max);
  if (pattern && !pattern.test(value)) fail(path, "does not match required pattern " + pattern);
  return value;
}

function expectNullableString(value, path, options = {}) {
  if (value === null) return null;
  return expectString(value, path, options);
}

function expectBoolean(value, path) {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function expectNullableBoolean(value, path) {
  if (value === null) return null;
  return expectBoolean(value, path);
}

function expectInteger(value, path, { minimum = null, maximum = null } = {}) {
  if (typeof value !== "number" || !Number.isInteger(value)) fail(path, "must be an integer");
  if (minimum !== null && value < minimum) fail(path, "must be >= " + minimum);
  if (maximum !== null && value > maximum) fail(path, "must be <= " + maximum);
  return value;
}

function expectNullableInteger(value, path, range = {}) {
  if (value === null) return null;
  return expectInteger(value, path, range);
}

function expectNumber(value, path, { minimum = null, maximum = null } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  if (minimum !== null && value < minimum) fail(path, "must be >= " + minimum);
  if (maximum !== null && value > maximum) fail(path, "must be <= " + maximum);
  return value;
}

function expectNullableNumber(value, path, range = {}) {
  if (value === null) return null;
  return expectNumber(value, path, range);
}

function expectEnum(value, path, allowed) {
  if (!allowed.includes(value)) fail(path, "must be one of " + allowed.join(", "));
  return value;
}

function expectNullableEnum(value, path, allowed) {
  if (value === null) return null;
  return expectEnum(value, path, allowed);
}

function validCalendarDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

function expectDate(value, path) {
  expectString(value, path);
  if (!validCalendarDate(value)) fail(path, "must be a valid RFC 3339 full-date");
  return value;
}

function expectDateTime(value, path) {
  expectString(value, path);
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match || !validCalendarDate(match[1])) {
    fail(path, "must be a valid RFC 3339 date-time");
  }
  return value;
}

function isRfc3986UriCharactersValid(value) {
  const allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~:/?#[]@!$&\u0027()*+,;=";
  const hex = "0123456789abcdefABCDEF";
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (ch === "%") {
      if (index + 2 >= value.length || !hex.includes(value[index + 1]) || !hex.includes(value[index + 2])) return false;
      index += 2;
      continue;
    }
    if (!allowed.includes(ch)) return false;
  }
  return true;
}

function validPortComponent(port) {
  if (port === "") return true;
  if (!/^[0-9]+$/.test(port)) return false;
  return Number(port) <= 65535;
}

function validIpv4Address(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^[0-9]{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    return Number(part) <= 255;
  });
}

function ipv6PieceGroupCount(pieces) {
  let count = 0;
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    if (/^[0-9A-Fa-f]{1,4}$/.test(piece)) {
      count += 1;
    } else if (index === pieces.length - 1 && validIpv4Address(piece)) {
      count += 2;
    } else {
      return -1;
    }
  }
  return count;
}

/** RFC 3986 IPv6address grammar; IPvFuture is intentionally not accepted for HTTPS datapack links. */
function isValidIpv6Literal(value) {
  if (!value || !/^[0-9A-Fa-f:.]+$/.test(value)) return false;
  const firstCompression = value.indexOf("::");
  const hasCompression = firstCompression >= 0;
  if (hasCompression && firstCompression !== value.lastIndexOf("::")) return false;
  const parseSide = (side) => {
    if (side === "") return [];
    const pieces = side.split(":");
    if (pieces.some((piece) => piece === "")) return null;
    return pieces;
  };
  if (!hasCompression) {
    const pieces = parseSide(value);
    return pieces !== null && ipv6PieceGroupCount(pieces) === 8;
  }
  const left = parseSide(value.slice(0, firstCompression));
  const right = parseSide(value.slice(firstCompression + 2));
  if (left === null || right === null) return false;
  // An embedded IPv4 tail is only legal as the final 32 bits of the whole address.
  // Counting it on the left of "::" would let 192.0.2.1:: pass even though the
  // compressed zeroes, not the IPv4 tail, occupy the end of the address.
  if (left.some((piece) => piece.includes("."))) return false;
  const leftGroups = ipv6PieceGroupCount(left);
  const rightGroups = ipv6PieceGroupCount(right);
  if (leftGroups < 0 || rightGroups < 0) return false;
  return leftGroups + rightGroups < 8;
}

/**
 * Validate the authority component and the only legal positions of raw square brackets.
 * RFC 3986 brackets delimit an IP-literal host; they are not valid raw query/path/fragment
 * characters, so native array spellings such as program[]=x must be percent-encoded.
 */
function validateHttpsAuthorityAndBracketPlacement(value, path) {
  const authorityStart = "https://".length;
  let authorityEnd = value.length;
  for (let index = authorityStart; index < value.length; index += 1) {
    const ch = value[index];
    if (ch === "/" || ch === "?" || ch === "#") {
      authorityEnd = index;
      break;
    }
  }
  const authority = value.slice(authorityStart, authorityEnd);
  if (!authority) fail(path, "must include a non-empty URI authority");

  const hostStart = authority.indexOf("@") >= 0 ? authority.indexOf("@") + 1 : 0;
  const hostAndPort = authority.slice(hostStart);
  if (!hostAndPort) fail(path, "must include a non-empty URI host");
  if (hostAndPort.includes("@")) fail(path, "must percent-encode additional @ characters in URI userinfo");

  const allowedOpenBracket = authorityStart + hostStart;
  let allowedCloseBracket = -1;
  if (hostAndPort.startsWith("[")) {
    const close = hostAndPort.indexOf("]");
    if (close <= 1) fail(path, "must contain a closed non-empty IP-literal host");
    const literal = hostAndPort.slice(1, close);
    if (literal.includes("[") || literal.includes("]")) fail(path, "must not nest raw brackets in an IP-literal host");
    if (!isValidIpv6Literal(literal)) fail(path, "must use an RFC 3986 IPv6 literal host");
    const rest = hostAndPort.slice(close + 1);
    if (rest) {
      if (!rest.startsWith(":")) fail(path, "must not append non-port text to an IP-literal host");
      if (!validPortComponent(rest.slice(1))) fail(path, "must use a decimal port in the supported URI range");
    }
    allowedCloseBracket = allowedOpenBracket + close;
  } else {
    if (hostAndPort.includes("[") || hostAndPort.includes("]")) fail(path, "must wrap an IP-literal host in exactly one bracket pair");
    if (hostAndPort.indexOf(":") !== hostAndPort.lastIndexOf(":")) fail(path, "must bracket an IPv6 literal host");
    const colon = hostAndPort.lastIndexOf(":");
    if (colon >= 0) {
      if (!validPortComponent(hostAndPort.slice(colon + 1))) fail(path, "must use a decimal port in the supported URI range");
      if (colon === 0) fail(path, "must include a non-empty URI host");
    }
  }

  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (ch !== "[" && ch !== "]") continue;
    if (hostAndPort.startsWith("[") && (index === allowedOpenBracket || index === allowedCloseBracket)) continue;
    fail(path, "must percent-encode square brackets outside an IP-literal host");
  }
}

function expectHttpsUri(value, path) {
  expectString(value, path, { pattern: /^https:\/\// });
  if (!isRfc3986UriCharactersValid(value)) fail(path, "must be an RFC 3986 URI without raw non-ASCII/control characters or invalid percent escapes");
  // RFC 3986 uses the first # as the fragment delimiter; the fragment grammar
  // itself does not admit another raw #, so nested fragment text must be encoded.
  if (value.indexOf("#") !== value.lastIndexOf("#")) fail(path, "must percent-encode additional # characters in a URI fragment");
  validateHttpsAuthorityAndBracketPlacement(value, path);
  return value;
}

function expectUniqueStrings(values, path) {
  if (new Set(values).size !== values.length) fail(path, "must not contain duplicate strings");
  return values;
}

function validateSource(value, path) {
  const object = expectObject(value, path, ["url", "title", "retrievedAt"], ["url", "title", "retrievedAt"]);
  return {
    url: expectHttpsUri(object.url, child(path, "url")),
    title: expectString(object.title, child(path, "title"), { min: 1, max: 200 }),
    retrievedAt: expectDate(object.retrievedAt, child(path, "retrievedAt"))
  };
}

function validateSources(value, path) {
  return expectArray(value, path, 1).map((item, index) => validateSource(item, path + "[" + index + "]"));
}

function validateProvenance(value, path) {
  if (value === undefined) return undefined;
  const object = expectObject(value, path, ["sources", "verifiedAt", "reviewBy", "verificationLevel"], []);
  const out = {};
  if (object.sources !== undefined) out.sources = validateSources(object.sources, child(path, "sources"));
  if (object.verifiedAt !== undefined) out.verifiedAt = expectDate(object.verifiedAt, child(path, "verifiedAt"));
  if (object.reviewBy !== undefined) out.reviewBy = expectDate(object.reviewBy, child(path, "reviewBy"));
  if (object.verificationLevel !== undefined) {
    out.verificationLevel = expectEnum(object.verificationLevel, child(path, "verificationLevel"), DATAPACK_VERIFICATION_LEVELS);
  }
  return out;
}

function validateMaterial(value, path) {
  const object = expectObject(value, path, ["name", "required", "validDays", "note"], ["name"]);
  return {
    name: expectString(object.name, child(path, "name"), { min: 1, max: 200 }),
    required: object.required === undefined ? true : expectBoolean(object.required, child(path, "required")),
    validDays: object.validDays === undefined ? null : expectNullableInteger(object.validDays, child(path, "validDays"), { minimum: 1, maximum: 3650 }),
    note: object.note === undefined ? null : expectNullableString(object.note, child(path, "note"), { max: 500 })
  };
}

function validateMaterials(value, path) {
  if (value === undefined) return [];
  return expectArray(value, path).map((item, index) => validateMaterial(item, path + "[" + index + "]"));
}

function validateContact(value, path) {
  const object = expectObject(value, path, ["kind", "value", "label"], ["kind", "value"]);
  return {
    kind: expectEnum(object.kind, child(path, "kind"), ["office", "phone", "email", "website"]),
    value: expectString(object.value, child(path, "value"), { min: 1, max: 240 }),
    label: object.label === undefined ? null : expectNullableString(object.label, child(path, "label"), { max: 120 })
  };
}

function validateContacts(value, path) {
  if (value === undefined) return [];
  return expectArray(value, path).map((item, index) => validateContact(item, path + "[" + index + "]"));
}

function validateProcedureStep(value, path) {
  const object = expectObject(value, path, ["id", "title", "instruction", "placeRef", "estimatedMinutes"], ["id", "title", "instruction"]);
  return {
    id: expectString(object.id, child(path, "id"), { min: 1, max: 80 }),
    title: expectString(object.title, child(path, "title"), { min: 1, max: 160 }),
    instruction: expectString(object.instruction, child(path, "instruction"), { min: 1, max: 2000 }),
    placeRef: object.placeRef === undefined ? null : expectNullableString(object.placeRef, child(path, "placeRef"), { max: 240 }),
    estimatedMinutes: object.estimatedMinutes === undefined ? null : expectNullableInteger(object.estimatedMinutes, child(path, "estimatedMinutes"), { minimum: 0, maximum: 10080 })
  };
}

function validateProcedureQuestion(value, path) {
  const object = expectObject(value, path, ["id", "question", "options"], ["id", "question", "options"]);
  const options = expectArray(object.options, child(path, "options"), 2).map((option, optionIndex) => {
    const optionPath = child(path, "options") + "[" + optionIndex + "]";
    const optionObject = expectObject(option, optionPath, ["value", "label", "nextStepId"], ["value", "label"]);
    return {
      value: expectString(optionObject.value, child(optionPath, "value"), { min: 1, max: 80 }),
      label: expectString(optionObject.label, child(optionPath, "label"), { min: 1, max: 160 }),
      nextStepId: optionObject.nextStepId === undefined ? null : expectNullableString(optionObject.nextStepId, child(optionPath, "nextStepId"), { max: 80 })
    };
  });
  return {
    id: expectString(object.id, child(path, "id"), { min: 1, max: 80 }),
    question: expectString(object.question, child(path, "question"), { min: 1, max: 500 }),
    options
  };
}

function validateBaseItem(object, path) {
  const base = {
    id: expectString(object.id, child(path, "id"), { min: 1, max: 120, pattern: ITEM_ID_PATTERN }),
    title: expectString(object.title, child(path, "title"), { min: 1, max: 160 })
  };
  if (object.summary !== undefined) base.summary = expectString(object.summary, child(path, "summary"), { max: 500 });
  const provenance = validateProvenance(object.provenance, child(path, "provenance"));
  if (provenance !== undefined) base.provenance = provenance;
  return base;
}

function validateProcedureGuideItem(value, path) {
  const allowed = ["id", "title", "summary", "provenance", "steps", "questions", "materials", "placeRef", "officeHours", "contacts", "dependsOn"];
  const object = expectObject(value, path, allowed, ["id", "title", "steps"]);
  const base = validateBaseItem(object, path);
  return {
    ...base,
    steps: expectArray(object.steps, child(path, "steps"), 1).map((item, index) => validateProcedureStep(item, child(path, "steps") + "[" + index + "]")),
    questions: object.questions === undefined ? [] : expectArray(object.questions, child(path, "questions")).map((item, index) => validateProcedureQuestion(item, child(path, "questions") + "[" + index + "]")),
    materials: validateMaterials(object.materials, child(path, "materials")),
    placeRef: object.placeRef === undefined ? null : expectNullableString(object.placeRef, child(path, "placeRef"), { max: 240 }),
    officeHours: object.officeHours === undefined ? null : expectNullableString(object.officeHours, child(path, "officeHours"), { max: 240 }),
    contacts: validateContacts(object.contacts, child(path, "contacts")),
    dependsOn: object.dependsOn === undefined ? [] : expectUniqueStrings(expectArray(object.dependsOn, child(path, "dependsOn")).map((item, index) => expectString(item, child(path, "dependsOn") + "[" + index + "]", { max: 120 })), child(path, "dependsOn"))
  };
}

function validateRequirement(value, path) {
  const object = expectObject(value, path, ["id", "text", "computable"], ["id", "text"]);
  return {
    id: expectString(object.id, child(path, "id"), { min: 1, max: 80 }),
    text: expectString(object.text, child(path, "text"), { min: 1, max: 500 }),
    computable: object.computable === undefined ? false : expectBoolean(object.computable, child(path, "computable"))
  };
}

function validateOpportunityCatalogItem(value, path) {
  const allowed = ["id", "title", "summary", "provenance", "category", "organizer", "deadlineAt", "requirements", "materials", "applicationUrl"];
  const object = expectObject(value, path, allowed, ["id", "title", "category", "requirements", "materials"]);
  const base = validateBaseItem(object, path);
  return {
    ...base,
    category: expectEnum(object.category, child(path, "category"), ["certification", "competition", "grant", "scholarship", "program"]),
    organizer: object.organizer === undefined ? null : expectNullableString(object.organizer, child(path, "organizer"), { max: 200 }),
    deadlineAt: object.deadlineAt === undefined ? null : (object.deadlineAt === null ? null : expectDateTime(object.deadlineAt, child(path, "deadlineAt"))),
    requirements: expectArray(object.requirements, child(path, "requirements"), 1).map((item, index) => validateRequirement(item, child(path, "requirements") + "[" + index + "]")),
    materials: validateMaterials(object.materials, child(path, "materials")),
    applicationUrl: object.applicationUrl === undefined ? null : (object.applicationUrl === null ? null : expectHttpsUri(object.applicationUrl, child(path, "applicationUrl")))
  };
}

function validateFacilityCatalogItem(value, path) {
  const allowed = ["id", "title", "summary", "provenance", "facilityType", "placeRef", "capabilities", "openingHours", "accessNotes"];
  const object = expectObject(value, path, allowed, ["id", "title", "facilityType", "placeRef"]);
  const base = validateBaseItem(object, path);
  return {
    ...base,
    facilityType: expectString(object.facilityType, child(path, "facilityType"), { min: 1, max: 80 }),
    placeRef: expectString(object.placeRef, child(path, "placeRef"), { min: 3, max: 240 }),
    capabilities: object.capabilities === undefined ? [] : expectUniqueStrings(expectArray(object.capabilities, child(path, "capabilities")).map((item, index) => expectString(item, child(path, "capabilities") + "[" + index + "]", { max: 80 })), child(path, "capabilities")),
    openingHours: object.openingHours === undefined ? null : expectNullableString(object.openingHours, child(path, "openingHours"), { max: 240 }),
    accessNotes: object.accessNotes === undefined ? null : expectNullableString(object.accessNotes, child(path, "accessNotes"), { max: 500 })
  };
}

function validateIndoorGraphItem(value, path) {
  const allowed = ["id", "title", "summary", "provenance", "itemType", "placeRef", "levelRef", "nodeKind", "latitude", "longitude", "fromNodeId", "toNodeId", "distanceMeters", "accessible"];
  const object = expectObject(value, path, allowed, ["id", "title", "itemType"]);
  const base = validateBaseItem(object, path);
  return {
    ...base,
    itemType: expectEnum(object.itemType, child(path, "itemType"), ["node", "edge", "level"]),
    placeRef: object.placeRef === undefined ? null : expectNullableString(object.placeRef, child(path, "placeRef"), { max: 240 }),
    levelRef: object.levelRef === undefined ? null : expectNullableString(object.levelRef, child(path, "levelRef"), { max: 120 }),
    nodeKind: object.nodeKind === undefined ? null : expectNullableEnum(object.nodeKind, child(path, "nodeKind"), ["room", "corridor", "stairs", "elevator", "entrance", "junction"]),
    latitude: object.latitude === undefined ? null : expectNullableNumber(object.latitude, child(path, "latitude"), { minimum: -90, maximum: 90 }),
    longitude: object.longitude === undefined ? null : expectNullableNumber(object.longitude, child(path, "longitude"), { minimum: -180, maximum: 180 }),
    fromNodeId: object.fromNodeId === undefined ? null : expectNullableString(object.fromNodeId, child(path, "fromNodeId"), { max: 120 }),
    toNodeId: object.toNodeId === undefined ? null : expectNullableString(object.toNodeId, child(path, "toNodeId"), { max: 120 }),
    distanceMeters: object.distanceMeters === undefined ? null : expectNullableNumber(object.distanceMeters, child(path, "distanceMeters"), { minimum: 0, maximum: 10000 }),
    accessible: object.accessible === undefined ? null : expectNullableBoolean(object.accessible, child(path, "accessible"))
  };
}

function validatePeriod(value, path) {
  const object = expectObject(value, path, ["index", "start", "end"], ["index", "start", "end"]);
  return {
    index: expectInteger(object.index, child(path, "index"), { minimum: 1, maximum: 40 }),
    start: expectString(object.start, child(path, "start"), { pattern: TIME_PATTERN }),
    end: expectString(object.end, child(path, "end"), { pattern: TIME_PATTERN })
  };
}

function validatePeriodPresetItem(value, path) {
  const allowed = ["id", "title", "summary", "provenance", "periods"];
  const object = expectObject(value, path, allowed, ["id", "title", "periods"]);
  const base = validateBaseItem(object, path);
  return {
    ...base,
    periods: expectArray(object.periods, child(path, "periods"), 1).map((item, index) => validatePeriod(item, child(path, "periods") + "[" + index + "]"))
  };
}

function validatePharmacyCatalogItem(value, path) {
  const allowed = ["id", "title", "summary", "provenance", "category", "specification", "usageNote", "stockState"];
  const object = expectObject(value, path, allowed, ["id", "title", "category"]);
  const base = validateBaseItem(object, path);
  return {
    ...base,
    category: expectString(object.category, child(path, "category"), { min: 1, max: 120 }),
    specification: object.specification === undefined ? null : expectNullableString(object.specification, child(path, "specification"), { max: 160 }),
    usageNote: object.usageNote === undefined ? null : expectNullableString(object.usageNote, child(path, "usageNote"), { max: 500 }),
    stockState: object.stockState === undefined ? "UNKNOWN" : expectEnum(object.stockState, child(path, "stockState"), ["UNKNOWN", "LISTED_ONLY", "REPORTED_AVAILABLE", "REPORTED_UNAVAILABLE"])
  };
}

function validateItem(value, path, kind) {
  switch (kind) {
    case "procedure-guide": return validateProcedureGuideItem(value, path);
    case "opportunity-catalog": return validateOpportunityCatalogItem(value, path);
    case "facility-catalog": return validateFacilityCatalogItem(value, path);
    case "indoor-graph": return validateIndoorGraphItem(value, path);
    case "period-preset": return validatePeriodPresetItem(value, path);
    case "pharmacy-catalog": return validatePharmacyCatalogItem(value, path);
    default: fail(path, "unsupported item kind " + kind);
  }
}

/** Validate a parsed unsigned dis-datapack/v1 document and return a normalized copy with schema defaults applied. */
export function validateDisDatapack(value) {
  const root = expectObject(value, "$", [
    "format",
    "packId",
    "schoolId",
    "kind",
    "version",
    "sources",
    "verifiedAt",
    "reviewBy",
    "maintainers",
    "verificationLevel",
    "items"
  ], ["format", "packId", "schoolId", "kind", "version", "sources", "verifiedAt", "reviewBy", "maintainers", "items"]);

  const format = expectEnum(root.format, "$.format", [DATAPACK_FORMAT]);
  const packId = expectString(root.packId, "$.packId", { min: 3, max: 128, pattern: PACK_ID_PATTERN });
  const schoolId = expectString(root.schoolId, "$.schoolId", { min: 2, max: 64, pattern: SCHOOL_ID_PATTERN });
  if (packId.split(".")[0] !== schoolId) {
    fail("$.packId", "first dot-separated segment must equal the complete dot-free schoolId");
  }
  const kind = expectEnum(root.kind, "$.kind", DATAPACK_KINDS);
  const version = expectString(root.version, "$.version", { pattern: VERSION_PATTERN });
  const maintainers = expectUniqueStrings(expectArray(root.maintainers, "$.maintainers", 1).map((item, index) =>
    expectString(item, "$.maintainers[" + index + "]", { min: 2, max: 120, pattern: MAINTAINER_PATTERN })
  ), "$.maintainers");
  return {
    format,
    packId,
    schoolId,
    kind,
    version,
    sources: validateSources(root.sources, "$.sources"),
    verifiedAt: expectDate(root.verifiedAt, "$.verifiedAt"),
    reviewBy: expectDate(root.reviewBy, "$.reviewBy"),
    maintainers,
    verificationLevel: root.verificationLevel === undefined
      ? "UNVERIFIED"
      : expectEnum(root.verificationLevel, "$.verificationLevel", DATAPACK_VERIFICATION_LEVELS),
    items: expectArray(root.items, "$.items").map((item, index) => validateItem(item, "$.items[" + index + "]", kind))
  };
}
