import { TextDecoder } from "node:util";
import { dataPackInvalid } from "./errors.mjs";

export const DATAPACK_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const RFC8785_MAX_DEPTH = 64;

function fail(message, detail = undefined) {
  throw dataPackInvalid(message, detail);
}

function isBytes(value) {
  return value instanceof Uint8Array || Buffer.isBuffer(value);
}

/** Decode exact artifact bytes as strict UTF-8; replacement characters are never accepted silently. */
export function strictDecodeUtf8(bytes) {
  if (!isBytes(bytes)) {
    fail("dis-datapack/v1 artifact must be exact bytes, not a lossy string");
  }
  if (bytes.length === 0) {
    fail("dis-datapack/v1 artifact is empty");
  }
  if (bytes.length > DATAPACK_MAX_ARTIFACT_BYTES) {
    fail("dis-datapack/v1 artifact exceeds the 16 MiB v1 ceiling", {
      reason: "ARTIFACT_TOO_LARGE",
      sizeBytes: bytes.length
    });
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("dis-datapack/v1 artifact is not valid UTF-8", { reason: "INVALID_UTF8" });
  }
}

/** RFC 8785 requires valid Unicode; lone UTF-16 surrogates must fail closed. */
export function assertValidUnicodeString(value, what = "string") {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        fail(`dis-datapack/v1 ${what} contains a lone high surrogate`, { reason: "INVALID_UNICODE" });
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      fail(`dis-datapack/v1 ${what} contains a lone low surrogate`, { reason: "INVALID_UNICODE" });
    }
  }
}

function compareUtf16CodeUnits(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = left.charCodeAt(index) - right.charCodeAt(index);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

function canonicalize(value, depth, activeObjects) {
  if (depth > RFC8785_MAX_DEPTH) {
    fail("dis-datapack/v1 JSON nesting exceeds the 64-level safety limit", { reason: "TOO_DEEP" });
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("dis-datapack/v1 number is not representable as finite IEEE-754 double", { reason: "NON_FINITE_NUMBER" });
    }
    // ECMAScript Number::toString is the RFC 8785 number serialization algorithm, including -0 -> 0.
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertValidUnicodeString(value, "string value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (activeObjects.has(value)) {
      fail("dis-datapack/v1 value contains an object cycle", { reason: "CYCLE" });
    }
    activeObjects.add(value);
    const out = `[${value.map((item) => canonicalize(item, depth + 1, activeObjects)).join(",")}]`;
    activeObjects.delete(value);
    return out;
  }
  if (value !== null && typeof value === "object") {
    if (activeObjects.has(value)) {
      fail("dis-datapack/v1 value contains an object cycle", { reason: "CYCLE" });
    }
    activeObjects.add(value);
    const keys = Object.keys(value);
    for (const key of keys) assertValidUnicodeString(key, "object key");
    keys.sort(compareUtf16CodeUnits);
    const parts = [];
    for (const key of keys) {
      const child = value[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol") {
        fail("dis-datapack/v1 object contains a non-JSON value", { reason: "NON_JSON_VALUE", key });
      }
      parts.push(`${JSON.stringify(key)}:${canonicalize(child, depth + 1, activeObjects)}`);
    }
    activeObjects.delete(value);
    return `{${parts.join(",")}}`;
  }
  fail("dis-datapack/v1 value contains a non-JSON primitive", { reason: "NON_JSON_VALUE" });
}

/** Canonicalize an in-memory JSON value according to RFC 8785/JCS and return UTF-8 text. */
export function canonicalizeRfc8785(value) {
  return canonicalize(value, 0, new Set());
}

/**
 * Parse exact artifact bytes and enforce the CT-06 exact-byte chain:
 * bytes == RFC8785(parse(bytes)). No whitespace/key-order/string-escape/number variant is normalized into acceptance.
 */
export function parseExactCanonicalJson(bytes) {
  const sourceText = strictDecodeUtf8(bytes);
  let value;
  try {
    value = JSON.parse(sourceText);
  } catch (error) {
    fail("dis-datapack/v1 artifact is not valid JSON", { reason: "INVALID_JSON", message: error.message });
  }
  const canonicalText = canonicalizeRfc8785(value);
  const canonicalBytes = Buffer.from(canonicalText, "utf8");
  if (!canonicalBytes.equals(Buffer.from(bytes))) {
    fail("dis-datapack/v1 artifact bytes are not exact RFC-8785 canonical bytes", {
      reason: "EXACT_CANONICAL_BYTES_REQUIRED"
    });
  }
  return { value, canonicalText, canonicalBytes };
}
