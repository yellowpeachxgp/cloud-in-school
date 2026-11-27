// JSON source-position helpers for runtime formats whose contract distinguishes
// integer literals (2) from decimal/exponent literals with an integer numeric
// value (2.0 or 2e0). JSON.parse erases that lexical distinction, so the small
// scanner below records number literals per object while returning the normal
// JavaScript object shape expected by the rest of the cloud runtime.

export const JSON_NUMBER_LITERALS = Symbol.for("campus-json-number-literals/v1");

function isObjectLike(value) {
  return value !== null && typeof value === "object";
}

function formatPath(segments) {
  let out = "$";
  for (const segment of segments) {
    out += typeof segment === "number" ? "[" + segment + "]" : "." + segment;
  }
  return out;
}

function defineLiteralMetadata(target, literals) {
  if (!isObjectLike(target)) return;
  Object.defineProperty(target, JSON_NUMBER_LITERALS, {
    value: Object.freeze(literals),
    enumerable: false,
    configurable: true,
    writable: false
  });
}

/**
 * Parse JSON and attach non-enumerable number-literal metadata to every object
 * and array in the returned graph. Metadata paths are relative to the object
 * carrying them, so extracting body.manifest still exposes $.min_host_api.
 *
 * The scanner is structural rather than value-guided: object keys are decoded
 * independently, which keeps duplicate-key input from desynchronising the
 * lexical scan from the JSON text. Duplicate-key acceptance remains unchanged
 * because the value itself still comes from JSON.parse.
 */
export function parseJsonWithNumberLiterals(jsonText) {
  const parsed = JSON.parse(jsonText);
  if (!isObjectLike(parsed)) return parsed;

  const text = String(jsonText);
  let index = 0;
  const records = [];
  const activeRecords = [];

  function fail(message) {
    throw new SyntaxError("JSON number literal scanner desynchronized: " + message + " at byte " + index);
  }

  function skipWhitespace() {
    while (
      index < text.length &&
      (text[index] === " " || text[index] === "\t" || text[index] === "\n" || text[index] === "\r")
    ) {
      index += 1;
    }
  }

  function expectChar(expected) {
    if (text[index] !== expected) fail("expected '" + expected + "'");
    index += 1;
  }

  function scanStringToken() {
    const start = index;
    expectChar('"');
    while (index < text.length) {
      const ch = text[index++];
      if (ch === '"') {
        return JSON.parse(text.slice(start, index));
      }
      if (ch === "\\") {
        index += 1;
      }
    }
    fail("unterminated string");
  }

  function scanNumberLiteral(segments) {
    const start = index;
    if (text[index] === "-") index += 1;
    if (text[index] === "0") {
      index += 1;
    } else if (text[index] >= "1" && text[index] <= "9") {
      index += 1;
      while (text[index] >= "0" && text[index] <= "9") index += 1;
    } else {
      fail("expected number integer part");
    }
    if (text[index] === ".") {
      index += 1;
      while (text[index] >= "0" && text[index] <= "9") index += 1;
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      while (text[index] >= "0" && text[index] <= "9") index += 1;
    }
    const literal = text.slice(start, index);
    for (const record of activeRecords) {
      if (segments.length < record.segments.length) continue;
      const belongs = record.segments.every((segment, position) => segments[position] === segment);
      if (!belongs) continue;
      const relative = formatPath(segments.slice(record.segments.length));
      record.literals[relative] = literal;
    }
  }

  function scanPrimitiveLiteral(literal) {
    if (!text.startsWith(literal, index)) fail("expected " + literal);
    index += literal.length;
  }

  function scanArray(segments) {
    expectChar("[");
    const record = { segments: [...segments], literals: Object.create(null) };
    records.push(record);
    activeRecords.push(record);
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      activeRecords.pop();
      return;
    }
    let itemIndex = 0;
    while (index < text.length) {
      scanValue([...segments, itemIndex]);
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        itemIndex += 1;
        continue;
      }
      if (text[index] === "]") {
        index += 1;
        activeRecords.pop();
        return;
      }
      fail("expected array separator");
    }
    fail("unterminated array");
  }

  function scanObject(segments) {
    expectChar("{");
    const record = { segments: [...segments], literals: Object.create(null) };
    records.push(record);
    activeRecords.push(record);
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      activeRecords.pop();
      return;
    }
    while (index < text.length) {
      skipWhitespace();
      const key = scanStringToken();
      skipWhitespace();
      expectChar(":");
      scanValue([...segments, key]);
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "}") {
        index += 1;
        activeRecords.pop();
        return;
      }
      fail("expected object separator");
    }
    fail("unterminated object");
  }

  function scanValue(segments) {
    skipWhitespace();
    const ch = text[index];
    if (ch === "{") return scanObject(segments);
    if (ch === "[") return scanArray(segments);
    if (ch === '"') {
      scanStringToken();
      return;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) return scanNumberLiteral(segments);
    if (ch === "t") return scanPrimitiveLiteral("true");
    if (ch === "f") return scanPrimitiveLiteral("false");
    if (ch === "n") return scanPrimitiveLiteral("null");
    fail("expected JSON value");
  }

  scanValue([]);
  skipWhitespace();
  if (index !== text.length) fail("trailing content");

  for (const record of records) {
    let node = parsed;
    for (const segment of record.segments) {
      node = node?.[segment];
    }
    defineLiteralMetadata(node, record.literals);
  }
  return parsed;
}

/** Preserve source metadata when the HTTP boundary sanitizes JSON objects. */
export function copyJsonNumberLiteralMetadata(source, target) {
  if (!isObjectLike(source) || !isObjectLike(target)) return target;
  const literals = source[JSON_NUMBER_LITERALS];
  if (literals) {
    Object.defineProperty(target, JSON_NUMBER_LITERALS, {
      value: literals,
      enumerable: false,
      configurable: true,
      writable: false
    });
  }
  return target;
}

/** Return the exact source literal for a metadata path, or null when unknown. */
export function jsonNumberLiteralAt(value, path) {
  if (!isObjectLike(value)) return null;
  const literals = value[JSON_NUMBER_LITERALS];
  if (!literals) return null;
  return Object.prototype.hasOwnProperty.call(literals, path) ? literals[path] : null;
}
