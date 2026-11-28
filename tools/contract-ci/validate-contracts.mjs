#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  CONTRACT_STATUSES,
  parseEndpointInventory,
  parseOpenApiOperations,
  partitionByStatus,
  routeKey
} from "./contract-utils.mjs";
import {
  analyzeYamlStrictParserSelfTest,
  analyzeYamlSyntax
} from "./strict-yaml.mjs";

const rootDir = process.cwd();

function assert(condition, message) {
  if (!condition) {
    console.error(`[CONTRACT-CI FAIL] ${message}`);
    process.exit(1);
  }
}

const systemContractPath = path.join(rootDir, "SYSTEM_CONTRACT.md");
assert(fs.existsSync(systemContractPath), "SYSTEM_CONTRACT.md must exist at repository root");
const systemContractText = fs.readFileSync(systemContractPath, "utf8");
assert(
  (systemContractText.includes("T-30") || systemContractText.includes("T−30")) &&
    (systemContractText.includes("T-5") || systemContractText.includes("T−5")),
  "SYSTEM_CONTRACT.md must enforce T-30m / T-5m / T triple schedule"
);
assert(systemContractText.includes("OpenAPI 3.1.2"), "SYSTEM_CONTRACT.md must enforce OpenAPI 3.1.2+");

const openApiPath = path.join(rootDir, "contracts/openapi/cloud-v1.yaml");
const inventoryPath = path.join(rootDir, "contracts/endpoints/endpoint-inventory.yaml");
assert(fs.existsSync(openApiPath), "contracts/openapi/cloud-v1.yaml must exist");
assert(fs.existsSync(inventoryPath), "contracts/endpoints/endpoint-inventory.yaml must exist");

const openApiText = fs.readFileSync(openApiPath, "utf8");
assert(openApiText.startsWith("openapi: 3.1.2"), "OpenAPI version must be >= 3.1.2");

assertYamlDuplicateKeyScannerSelfTest();
assertStrictYamlParserSelfTest();
const contractYamlFiles = collectYamlFiles(path.join(rootDir, "contracts"));
assert(contractYamlFiles.length >= 5, "Expected at least 5 YAML files under contracts/");
for (const yamlFile of contractYamlFiles) {
  const displayPath = path.relative(rootDir, yamlFile).split(path.sep).join("/");
  const yamlText = fs.readFileSync(yamlFile, "utf8");
  assertNoYamlSyntaxErrors(yamlText, displayPath);
  assertNoDuplicateYamlMappingKeys(yamlText, displayPath);
}

function yamlScalar(value) {
  return String(value || "").trim().replace(/^['"]/, "").replace(/['"]$/, "");
}

// YAML duplicate keys are fail-closed contract defects: strict YAML parsers may silently
// keep only the later mapping entry in looser consumers. The contract repositories use a
// stable block-style YAML subset, so this dependency-free structural scanner validates
// sibling keys while respecting sequence-item boundaries and block scalar content.
function analyzeYamlDuplicateKeys(yamlText, label) {
  const lines = yamlText.split(/\r?\n/);
  const duplicates = [];
  const errors = [];

  function lineInfo(index) {
    const raw = lines[index];
    if (!raw || /^\s*$/.test(raw)) return null;
    if (/^ *\t/.test(raw)) {
      errors.push(label + ":" + (index + 1) + ": tab indentation is unsupported in contract YAML");
    }
    const indent = (raw.match(/^ */) || [""])[0].length;
    const text = raw.slice(indent).trimEnd();
    if (!text || text.startsWith("#")) return null;
    return { index, indent, text, line: index + 1 };
  }

  function nextInfo(index) {
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const info = lineInfo(cursor);
      if (info) return info;
    }
    return null;
  }

  function stripYamlComment(text) {
    let quote = null;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === quote) {
          if (quote === "'" && text[index + 1] === "'") index += 1;
          else quote = null;
        } else if (char === "\\" && quote === "\"") {
          index += 1;
        }
        continue;
      }
      if (char === "'" || char === "\"") {
        quote = char;
        continue;
      }
      if (char === "#" && (index === 0 || /\s/.test(text[index - 1]))) {
        return text.slice(0, index).trimEnd();
      }
    }
    return text.trim();
  }

  function parseSequenceItem(info) {
    if (info.text === "-") return { body: "", separatorLength: 0 };
    const match = info.text.match(/^-( +)(.*)$/);
    if (!match) return null;
    return { body: match[2], separatorLength: match[1].length };
  }

  function decodeDoubleQuotedKey(rawKey) {
    if (rawKey.length < 2 || !rawKey.endsWith("\"")) {
      return { key: rawKey, error: "unterminated double-quoted key" };
    }
    const inner = rawKey.slice(1, -1);
    const simpleEscapes = {
      "0": "\0",
      "a": "\x07",
      "b": "\b",
      "t": "\t",
      "n": "\n",
      "v": "\v",
      "f": "\f",
      "r": "\r",
      "e": "\x1b",
      " ": " ",
      "\"": "\"",
      "/": "/",
      "\\": "\\",
      "N": "\u0085",
      "_": "\u00a0",
      "L": "\u2028",
      "P": "\u2029"
    };
    let key = "";
    for (let index = 0; index < inner.length; index += 1) {
      const char = inner[index];
      if (char !== "\\") {
        key += char;
        continue;
      }
      index += 1;
      if (index >= inner.length) return { key: rawKey, error: "truncated escape sequence" };
      const escape = inner[index];
      if (Object.prototype.hasOwnProperty.call(simpleEscapes, escape)) {
        key += simpleEscapes[escape];
        continue;
      }
      const digitCount = escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : 0;
      if (digitCount === 0) return { key: rawKey, error: "unsupported escape sequence \\" + escape };
      const hex = inner.slice(index + 1, index + 1 + digitCount);
      if (hex.length !== digitCount || !/^[0-9a-fA-F]+$/.test(hex)) {
        return { key: rawKey, error: "truncated or non-hexadecimal \\" + escape + " escape" };
      }
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return { key: rawKey, error: "escape sequence is outside the supported Unicode scalar range" };
      }
      key += String.fromCodePoint(codePoint);
      index += digitCount;
    }
    return { key };
  }

  function canonicalizeYamlKey(rawKey) {
    if (rawKey.startsWith("'")) {
      if (rawKey.length < 2 || !rawKey.endsWith("'")) {
        return { key: rawKey, error: "unterminated single-quoted key" };
      }
      return { key: rawKey.slice(1, -1).replace(/''/g, "'") };
    }
    if (rawKey.startsWith("\"")) return decodeDoubleQuotedKey(rawKey);
    return { key: rawKey };
  }

  function unsupportedYamlKeyProperty(rawKey) {
    if (rawKey.startsWith("'") || rawKey.startsWith("\"")) return false;
    if (rawKey === "<<") return true;
    return /^[!&*]\S*(?:\s+|$)/.test(rawKey);
  }

  function parseMappingKey(text, line) {
    let quote = null;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === quote) {
          if (quote === "'" && text[index + 1] === "'") index += 1;
          else quote = null;
        } else if (char === "\\" && quote === "\"") {
          index += 1;
        }
        continue;
      }
      if ((char === "'" || char === "\"") && index === 0) {
        quote = char;
        continue;
      }
      if (char !== ":") continue;
      if (index + 1 < text.length && !/\s/.test(text[index + 1])) continue;
      const rawKey = text.slice(0, index).trim();
      if (!rawKey) return null;
      let invalidKey = false;
      if (unsupportedYamlKeyProperty(rawKey)) {
        errors.push(label + ":" + line + ": unsupported YAML key node property " + JSON.stringify(rawKey) + "; anchors/tags/aliases/merge keys are outside the supported contract subset");
        invalidKey = true;
      }
      const canonical = canonicalizeYamlKey(rawKey);
      if (canonical.error) {
        errors.push(label + ":" + line + ": invalid YAML quoted key " + JSON.stringify(rawKey) + ": " + canonical.error);
        invalidKey = true;
      }
      return { key: canonical.key, invalidKey, value: stripYamlComment(text.slice(index + 1)) };
    }
    return null;
  }

  function isBlockScalarValue(value) {
    return /^[|>][+-]?(?:\d+)?(?:\s*(?:#.*)?)?$/.test(value);
  }

  function hasYamlNodePropertyPrefix(value) {
    return /^(?:&|!|\*)\S*(?:\s+|$)/.test(value.trimStart());
  }

  function containsFlowMappingStart(value) {
    let first = 0;
    while (first < value.length && /\s/.test(value[first])) first += 1;
    if (value[first] !== "{" && value[first] !== "[") return false;
    let quote = null;
    for (let index = first; index < value.length; index += 1) {
      const char = value[index];
      if (quote) {
        if (char === quote) {
          if (quote === "'" && value[index + 1] === "'") index += 1;
          else quote = null;
        } else if (char === "\\" && quote === "\"") {
          index += 1;
        }
        continue;
      }
      if (char === "'" || char === "\"") {
        quote = char;
        continue;
      }
      if (char !== "{") continue;
      let previous = index - 1;
      while (previous >= 0 && /\s/.test(value[previous])) previous -= 1;
      if (previous < 0 || value[previous] === "[" || value[previous] === "," || value[previous] === ":") return true;
    }
    return false;
  }

  function skipBlockScalar(startIndex, parentIndent) {
    let index = startIndex + 1;
    while (index < lines.length) {
      const raw = lines[index];
      if (!raw || /^\s*$/.test(raw)) {
        index += 1;
        continue;
      }
      const indent = (raw.match(/^ */) || [""])[0].length;
      if (indent <= parentIndent) break;
      index += 1;
    }
    return index;
  }

  function isPlainScalarValue(value) {
    return value !== "" && !isBlockScalarValue(value) && !/^[\[\]{}"']/.test(value);
  }

  function stripPlainScalarComment(text) {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "#" && (index === 0 || text[index - 1] === " " || text[index - 1] === "\t")) {
        return text.slice(0, index).trimEnd();
      }
    }
    return text.trimEnd();
  }

  function skipPlainScalarContinuation(startIndex, parentIndent) {
    let index = startIndex + 1;
    while (index < lines.length) {
      const raw = lines[index];
      if (!raw || /^\s*$/.test(raw)) {
        index += 1;
        continue;
      }
      const indent = (raw.match(/^ */) || [""])[0].length;
      if (indent <= parentIndent) break;
      const text = raw.slice(indent).trimEnd();
      const content = stripPlainScalarComment(text);
      if (/:(?:\s|$)/.test(content)) {
        errors.push(label + ":" + (index + 1) + ": mapping syntax cannot appear inside a plain-scalar continuation");
      }
      index += 1;
    }
    return index;
  }

  function registerKey(keys, key, line) {
    if (keys.has(key)) {
      duplicates.push(label + ":" + line + ": duplicate mapping key " + JSON.stringify(key) + " (first at line " + keys.get(key) + ")");
    } else {
      keys.set(key, line);
    }
  }

  function consumeValue(lineIndex, keyIndent, value) {
    if (hasYamlNodePropertyPrefix(value)) {
      errors.push(label + ":" + (lineIndex + 1) + ": unsupported YAML anchor/tag node property; duplicate keys cannot be proven absent");
    }
    if (containsFlowMappingStart(value)) {
      errors.push(label + ":" + (lineIndex + 1) + ": unsupported flow mapping in contract block YAML; duplicate keys cannot be proven absent");
    }
    if (isBlockScalarValue(value)) return skipBlockScalar(lineIndex, keyIndent);
    if (value === "") {
      const next = nextInfo(lineIndex + 1);
      if (next && next.indent > keyIndent) return parseBlock(next.index, next.indent);
      if (next && next.indent === keyIndent && parseSequenceItem(next)) return parseSequence(next.index, next.indent);
    } else if (isPlainScalarValue(value)) {
      return skipPlainScalarContinuation(lineIndex, keyIndent);
    }
    return lineIndex + 1;
  }

  function parseMapping(startIndex, indent, initialKeys = new Map()) {
    const keys = initialKeys;
    let index = startIndex;
    while (index < lines.length) {
      const info = nextInfo(index);
      if (!info) return lines.length;
      index = info.index;
      if (info.indent < indent) return index;
      if (info.indent > indent) {
        errors.push(label + ":" + info.line + ": unsupported indentation " + info.indent + "; expected mapping key at indent " + indent);
        index += 1;
        continue;
      }
      if (parseSequenceItem(info)) return index;
      const parsed = parseMappingKey(info.text, info.line);
      if (!parsed) {
        errors.push(label + ":" + info.line + ": unsupported non-mapping YAML line in mapping context");
        index += 1;
        continue;
      }
      if (!parsed.invalidKey) registerKey(keys, parsed.key, info.line);
      index = consumeValue(index, indent, parsed.value);
    }
    return index;
  }

  function parseSequence(startIndex, indent) {
    let index = startIndex;
    while (index < lines.length) {
      const info = nextInfo(index);
      if (!info) return lines.length;
      index = info.index;
      if (info.indent < indent) return index;
      if (info.indent > indent) {
        errors.push(label + ":" + info.line + ": unsupported indentation " + info.indent + "; expected sequence item at indent " + indent);
        index += 1;
        continue;
      }
      const item = parseSequenceItem(info);
      if (!item) return index;
      if (item.body === "") {
        const next = nextInfo(index + 1);
        if (next && next.indent > indent) index = parseBlock(next.index, next.indent);
        else index += 1;
        continue;
      }
      if (isBlockScalarValue(item.body)) {
        index = skipBlockScalar(index, indent);
        continue;
      }
      if (hasYamlNodePropertyPrefix(item.body)) {
        errors.push(label + ":" + info.line + ": unsupported YAML anchor/tag node property in sequence item; duplicate keys cannot be proven absent");
        index += 1;
        continue;
      }
      if (containsFlowMappingStart(item.body)) {
        errors.push(label + ":" + info.line + ": unsupported flow mapping in sequence item; duplicate keys cannot be proven absent");
        index += 1;
        continue;
      }
      const parsedInlineKey = parseMappingKey(item.body, info.line);
      if (parsedInlineKey) {
        const mapIndent = indent + 1 + item.separatorLength;
        const keys = new Map();
        if (!parsedInlineKey.invalidKey) registerKey(keys, parsedInlineKey.key, info.line);
        const afterInlineValue = consumeValue(index, mapIndent, parsedInlineKey.value);
        index = parseMapping(afterInlineValue, mapIndent, keys);
        continue;
      }
      index += 1;
    }
    return index;
  }

  function parseBlock(startIndex, indent) {
    const info = nextInfo(startIndex);
    if (!info) return lines.length;
    if (info.indent !== indent) {
      errors.push(label + ":" + info.line + ": inconsistent block indentation " + info.indent + "; expected " + indent);
      return info.index + 1;
    }
    return parseSequenceItem(info) ? parseSequence(info.index, indent) : parseMapping(info.index, indent);
  }

  let cursor = 0;
  while (cursor < lines.length) {
    const info = nextInfo(cursor);
    if (!info) break;
    const nextCursor = parseBlock(info.index, info.indent);
    if (nextCursor <= cursor) {
      errors.push(label + ":" + info.line + ": duplicate-key scanner made no progress");
      break;
    }
    cursor = nextCursor;
  }
  return { duplicates, errors };
}

function assertYamlDuplicateKeyScannerSelfTest() {
  const negative = analyzeYamlDuplicateKeys(
    "paths:\n  /a:\n    get: first\n  /a:\n    delete: second\n",
    "negative-duplicate-path.yaml"
  );
  assert(
    negative.errors.length === 0 && negative.duplicates.length === 1 && negative.duplicates[0].includes("duplicate mapping key"),
    "duplicate-key scanner negative self-test must catch exactly one repeated YAML path key"
  );
  const sequenceControl = analyzeYamlDuplicateKeys(
    "items:\n  - method: GET\n    path: /a\n  - method: POST\n    path: /a\n",
    "sequence-control.yaml"
  );
  assert(
    sequenceControl.errors.length === 0 && sequenceControl.duplicates.length === 0,
    "duplicate-key scanner must allow repeated keys in separate sequence items"
  );
  const blockScalarControl = analyzeYamlDuplicateKeys(
    "root:\n  description: |\n    key: text, not YAML structure\n    key: still text\n  sibling: true\n",
    "block-scalar-control.yaml"
  );
  assert(
    blockScalarControl.errors.length === 0 && blockScalarControl.duplicates.length === 0,
    "duplicate-key scanner must ignore block scalar content"
  );
  const flowMappingControl = analyzeYamlDuplicateKeys(
    "root: {key: first, key: duplicate}\n",
    "flow-mapping-control.yaml"
  );
  assert(
    flowMappingControl.errors.length > 0,
    "duplicate-key scanner must fail closed on unsupported flow mappings"
  );
  const flowSequenceControl = analyzeYamlDuplicateKeys(
    "items:\n  - {required: [name], required: [description]}\n",
    "flow-sequence-control.yaml"
  );
  assert(
    flowSequenceControl.errors.length > 0,
    "duplicate-key scanner must fail closed on flow mappings in sequence items"
  );
  const indentlessSequenceNegative = analyzeYamlDuplicateKeys(
    "root:\n  additionalProperties: false\n  enum:\n  - KEEP_VISIBLE\n  additionalProperties: true\n",
    "indentless-sequence-negative.yaml"
  );
  assert(
    indentlessSequenceNegative.errors.length === 0 && indentlessSequenceNegative.duplicates.length === 1,
    "duplicate-key scanner must preserve mapping scope across indentless sequences"
  );
  const compactIndentlessSequenceNegative = analyzeYamlDuplicateKeys(
    "items:\n  - additionalProperties: false\n    anyOf:\n    - type: object\n    additionalProperties: true\n",
    "compact-indentless-sequence-negative.yaml"
  );
  assert(
    compactIndentlessSequenceNegative.errors.length === 0 && compactIndentlessSequenceNegative.duplicates.length === 1,
    "duplicate-key scanner must preserve compact sequence-item mapping scope across indentless sequences"
  );
  const plainPlaceholderControl = analyzeYamlDuplicateKeys(
    "root:\n  description: Uses {boardId}, {postId} as plain text\n",
    "plain-placeholder-control.yaml"
  );
  assert(
    plainPlaceholderControl.errors.length === 0 && plainPlaceholderControl.duplicates.length === 0,
    "duplicate-key scanner must allow comma-separated placeholders in plain scalars"
  );
  const wrappedScalarControl = analyzeYamlDuplicateKeys(
    "root:\n  description: first line\n    continuation text\n  sibling: true\n",
    "wrapped-scalar-control.yaml"
  );
  assert(
    wrappedScalarControl.errors.length === 0 && wrappedScalarControl.duplicates.length === 0,
    "duplicate-key scanner must consume wrapped plain-scalar continuations"
  );
  const tabCommentControl = analyzeYamlDuplicateKeys(
    "# comment with\ttab\nroot: true\n",
    "tab-comment-control.yaml"
  );
  assert(
    tabCommentControl.errors.length === 0 && tabCommentControl.duplicates.length === 0,
    "duplicate-key scanner must allow tabs inside comments"
  );
  const anchoredBlockControl = analyzeYamlDuplicateKeys(
    "root:\n  payload: &payload\n    type: object\n    type: string\n",
    "anchored-block-control.yaml"
  );
  assert(
    anchoredBlockControl.errors.length > 0,
    "duplicate-key scanner must fail closed on anchored block mappings"
  );
  const anchoredFlowControl = analyzeYamlDuplicateKeys(
    "root:\n  examples: &examples [{action: removed, action: restored}]\n",
    "anchored-flow-control.yaml"
  );
  assert(
    anchoredFlowControl.errors.length > 0,
    "duplicate-key scanner must fail closed on anchored flow sequences"
  );
  const commentedContinuationControl = analyzeYamlDuplicateKeys(
    "root:\n  description: first line\n    continuation text # Note: pagination applies\n  sibling: true\n",
    "commented-continuation-control.yaml"
  );
  assert(
    commentedContinuationControl.errors.length === 0 && commentedContinuationControl.duplicates.length === 0,
    "duplicate-key scanner must allow colons inside plain-scalar continuation comments"
  );
  const malformedContinuationControl = analyzeYamlDuplicateKeys(
    "root:\n  description: first line\n    format: uuid\n  sibling: true\n",
    "malformed-continuation-control.yaml"
  );
  assert(
    malformedContinuationControl.errors.length > 0,
    "duplicate-key scanner must reject mapping syntax inside plain-scalar continuations"
  );
  const quotedContinuationCommentControl = analyzeYamlDuplicateKeys(
    "root:\n  description: first line\n    \"Retry\" # Note: manual retry\n  sibling: true\n",
    "quoted-continuation-comment-control.yaml"
  );
  assert(
    quotedContinuationCommentControl.errors.length === 0 && quotedContinuationCommentControl.duplicates.length === 0,
    "duplicate-key scanner must allow colons inside quoted plain-scalar continuation comments"
  );
  const malformedQuotedContinuationControl = analyzeYamlDuplicateKeys(
    "root:\n  description: first line\n    \"Retry\": manual\n  sibling: true\n",
    "malformed-quoted-continuation-control.yaml"
  );
  assert(
    malformedQuotedContinuationControl.errors.length > 0,
    "duplicate-key scanner must reject quoted mapping syntax inside plain-scalar continuations"
  );
  const mergeKeyControl = analyzeYamlDuplicateKeys(
    "root:\n  <<: *base\n",
    "merge-key-control.yaml"
  );
  assert(
    mergeKeyControl.errors.length > 0,
    "duplicate-key scanner must fail closed on YAML merge keys"
  );
  const aliasControl = analyzeYamlDuplicateKeys(
    "root:\n  payload: *base\n",
    "alias-control.yaml"
  );
  assert(
    aliasControl.errors.length > 0,
    "duplicate-key scanner must fail closed on YAML aliases outside the supported subset"
  );
  const escapedKeyNegative = analyzeYamlDuplicateKeys(
    "root:\n  a: first\n  \"\\x61\": second\n",
    "escaped-key-negative.yaml"
  );
  assert(
    escapedKeyNegative.errors.length === 0 &&
      escapedKeyNegative.duplicates.length === 1 &&
      escapedKeyNegative.duplicates[0] === "escaped-key-negative.yaml:3: duplicate mapping key \"a\" (first at line 2)",
    "duplicate-key scanner must canonicalize double-quoted \\x escapes with exact line/key evidence"
  );
  const unicodeEscapeMatrix = analyzeYamlDuplicateKeys(
    "root:\n  a: first\n  \"\\x61\": second\n  \"\\u0061\": third\n  \"\\U00000061\": fourth\n",
    "unicode-escape-matrix.yaml"
  );
  assert(
    unicodeEscapeMatrix.errors.length === 0 &&
      unicodeEscapeMatrix.duplicates.length === 3 &&
      unicodeEscapeMatrix.duplicates[0].includes("unicode-escape-matrix.yaml:3: duplicate mapping key \"a\"") &&
      unicodeEscapeMatrix.duplicates[1].includes("unicode-escape-matrix.yaml:4: duplicate mapping key \"a\"") &&
      unicodeEscapeMatrix.duplicates[2].includes("unicode-escape-matrix.yaml:5: duplicate mapping key \"a\""),
    "duplicate-key scanner must canonicalize \\x, \\u, and \\U double-quoted key escapes"
  );
  const threeFormKeyMatrix = analyzeYamlDuplicateKeys(
    "root:\n  a: first\n  'a': second\n  \"a\": third\n",
    "three-form-key-matrix.yaml"
  );
  assert(
    threeFormKeyMatrix.errors.length === 0 &&
      threeFormKeyMatrix.duplicates.length === 2 &&
      threeFormKeyMatrix.duplicates[0].includes("three-form-key-matrix.yaml:3: duplicate mapping key \"a\"") &&
      threeFormKeyMatrix.duplicates[1].includes("three-form-key-matrix.yaml:4: duplicate mapping key \"a\""),
    "duplicate-key scanner must treat plain, single-quoted, and double-quoted forms of the same key as duplicates"
  );
  const taggedKeyNegative = analyzeYamlDuplicateKeys(
    "root:\n  a: first\n  !!str a: second\n",
    "tagged-key-negative.yaml"
  );
  assert(
    taggedKeyNegative.errors.length === 1 &&
      taggedKeyNegative.errors[0] === "tagged-key-negative.yaml:3: unsupported YAML key node property \"!!str a\"; anchors/tags/aliases/merge keys are outside the supported contract subset" &&
      taggedKeyNegative.duplicates.length === 0,
    "duplicate-key scanner must reject tagged keys with exact line/key evidence"
  );
  const keyPropertyMatrix = analyzeYamlDuplicateKeys(
    "root:\n  &anchor a: first\n  *aliasKey: second\n  !!str a: third\n  <<: merged\n",
    "key-property-matrix.yaml"
  );
  assert(
    keyPropertyMatrix.errors.length === 4 &&
      keyPropertyMatrix.errors[0].includes("key-property-matrix.yaml:2: unsupported YAML key node property \"&anchor a\"") &&
      keyPropertyMatrix.errors[1].includes("key-property-matrix.yaml:3: unsupported YAML key node property \"*aliasKey\"") &&
      keyPropertyMatrix.errors[2].includes("key-property-matrix.yaml:4: unsupported YAML key node property \"!!str a\"") &&
      keyPropertyMatrix.errors[3].includes("key-property-matrix.yaml:5: unsupported YAML key node property \"<<\""),
    "duplicate-key scanner must reject anchor, alias, tag, and merge node properties in key position"
  );
  const quotedMergeLiteralControl = analyzeYamlDuplicateKeys(
    "root:\n  \"<<\": literal string key\n",
    "quoted-merge-literal-control.yaml"
  );
  assert(
    quotedMergeLiteralControl.errors.length === 0 && quotedMergeLiteralControl.duplicates.length === 0,
    "duplicate-key scanner must allow a quoted literal << key"
  );
  const invalidEscapeControl = analyzeYamlDuplicateKeys(
    "root:\n  \"\\x6g\": invalid\n",
    "invalid-escape-control.yaml"
  );
  assert(
    invalidEscapeControl.errors.length > 0,
    "duplicate-key scanner must fail closed on malformed double-quoted key escapes"
  );
}

function assertStrictYamlParserSelfTest() {
  const failures = analyzeYamlStrictParserSelfTest();
  assert(
    failures.length === 0,
    "strict YAML parser self-test failed: " + failures.slice(0, 5).join(" | ")
  );
}

function assertNoYamlSyntaxErrors(yamlText, label) {
  const result = analyzeYamlSyntax(yamlText, label);
  assert(
    result.errors.length === 0,
    "Strict YAML syntax parse failed for " + label + ": " + result.errors.slice(0, 5).join(" | ")
  );
}

function assertNoDuplicateYamlMappingKeys(yamlText, label) {
  const result = analyzeYamlDuplicateKeys(yamlText, label);
  const problems = [...result.errors, ...result.duplicates];
  assert(
    problems.length === 0,
    "Duplicate-key/strict YAML scan failed for " + label + ": " + problems.slice(0, 5).join(" | ")
  );
}

function collectYamlFiles(directory) {
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...collectYamlFiles(fullPath));
    else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) out.push(fullPath);
  }
  return out.sort();
}

function parseComponentParameters(lines) {
  const parameters = new Map();
  let inParameters = false;
  let currentName = null;
  for (const line of lines) {
    if (/^  parameters:\s*$/.test(line)) {
      inParameters = true;
      currentName = null;
      continue;
    }
    if (inParameters && /^  [A-Za-z0-9_-]+:\s*$/.test(line) && !/^  parameters:\s*$/.test(line)) {
      inParameters = false;
      currentName = null;
    }
    if (!inParameters) continue;
    const nameMatch = line.match(/^    ([A-Za-z0-9_-]+):\s*$/);
    if (nameMatch) {
      currentName = nameMatch[1];
      parameters.set(currentName, {});
      continue;
    }
    if (!currentName) continue;
    const fieldMatch = line.match(/^      (name|in|required):\s*(.+?)\s*$/);
    if (fieldMatch) {
      parameters.get(currentName)[fieldMatch[1]] = yamlScalar(fieldMatch[2]);
    }
  }
  return parameters;
}

function parseOpenApiParameterDeclarations(lines) {
  const pathParameters = new Map();
  const operationParameters = new Map();
  let inPaths = false;
  let currentPath = null;
  let currentMethod = null;
  let parameterContext = null;
  let currentParameter = null;

  function appendParameter() {
    if (!currentParameter) return;
    if (parameterContext === "path" && currentPath) {
      if (!pathParameters.has(currentPath)) pathParameters.set(currentPath, []);
      pathParameters.get(currentPath).push(currentParameter);
    }
    if (parameterContext === "operation" && currentPath && currentMethod) {
      const key = currentMethod.toUpperCase() + " " + currentPath;
      if (!operationParameters.has(key)) operationParameters.set(key, []);
      operationParameters.get(key).push(currentParameter);
    }
    currentParameter = null;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths && /^[a-zA-Z0-9_-]+:\s*$/.test(line)) {
      appendParameter();
      inPaths = false;
      parameterContext = null;
      continue;
    }
    if (!inPaths) continue;

    const pathMatch = line.match(/^  (\/[^\s:]*):\s*$/);
    if (pathMatch) {
      appendParameter();
      currentPath = pathMatch[1];
      currentMethod = null;
      parameterContext = null;
      continue;
    }
    const methodMatch = line.match(/^    (get|post|patch|delete|put):\s*$/);
    if (methodMatch && currentPath) {
      appendParameter();
      currentMethod = methodMatch[1].toUpperCase();
      parameterContext = null;
      continue;
    }

    if (currentPath && !currentMethod && /^    parameters:\s*$/.test(line)) {
      appendParameter();
      parameterContext = "path";
      continue;
    }
    if (currentPath && currentMethod && /^      parameters:\s*$/.test(line)) {
      appendParameter();
      parameterContext = "operation";
      continue;
    }
    if (!parameterContext) continue;

    if (
      (parameterContext === "path" && /^    [A-Za-z0-9_-]+:\s*/.test(line) && !/^    parameters:\s*$/.test(line)) ||
      (parameterContext === "operation" && /^      [A-Za-z0-9_-]+:\s*/.test(line) && !/^      parameters:\s*$/.test(line))
    ) {
      appendParameter();
      parameterContext = null;
      continue;
    }

    const indent = (line.match(/^ */) || [""])[0].length;
    const expectedItemIndent = parameterContext === "path" ? 6 : 8;
    const itemMatch = indent === expectedItemIndent ? line.slice(expectedItemIndent).match(/^-\s+(.+?)\s*$/) : null;
    if (itemMatch) {
      appendParameter();
      const item = itemMatch[1];
      const refMatch = item.match(/^\$ref:\s*(.+?)\s*$/);
      const nameMatch = item.match(/^name:\s*(.+?)\s*$/);
      if (refMatch) {
        currentParameter = { ref: yamlScalar(refMatch[1]), line: index + 1 };
      } else if (nameMatch) {
        currentParameter = { name: yamlScalar(nameMatch[1]), line: index + 1 };
      }
      continue;
    }
    if (!currentParameter) continue;
    const fieldMatch = indent === expectedItemIndent + 2
      ? line.slice(expectedItemIndent + 2).match(/^(name|in|required):\s*(.+?)\s*$/)
      : null;
    if (fieldMatch) {
      currentParameter[fieldMatch[1]] = yamlScalar(fieldMatch[2]);
    }
  }
  appendParameter();
  return { pathParameters, operationParameters };
}

function templateParametersForPath(pathTemplate) {
  return [...new Set([...pathTemplate.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]))];
}

function resolveParameterDeclaration(declaration, componentParameters, displayKey) {
  if (!declaration.ref) return declaration;
  const prefix = "#/components/parameters/";
  assert(declaration.ref.startsWith(prefix), "Unsupported parameter $ref at " + displayKey + ": " + declaration.ref);
  const componentName = declaration.ref.slice(prefix.length);
  const component = componentParameters.get(componentName);
  assert(component, "Missing components/parameters/" + componentName + " referenced by " + displayKey);
  return { ...component, ref: declaration.ref, line: declaration.line };
}

function assertStrictPathTemplateParameters(lines) {
  const componentParameters = parseComponentParameters(lines);
  const declarations = parseOpenApiParameterDeclarations(lines);
  for (const [key, operationId] of openApiOps.entries()) {
    const splitAt = key.indexOf(" ");
    const pathTemplate = key.slice(splitAt + 1);
    const templateParameters = templateParametersForPath(pathTemplate);
    const templateSet = new Set(templateParameters);
    const rawDeclarations = [
      ...(declarations.pathParameters.get(pathTemplate) || []),
      ...(declarations.operationParameters.get(key) || [])
    ];
    const resolved = rawDeclarations.map((declaration) =>
      resolveParameterDeclaration(declaration, componentParameters, key + " (" + operationId + ")")
    );
    for (const parameterName of templateParameters) {
      const matches = resolved.filter((declaration) => declaration.name === parameterName);
      assert(
        matches.length > 0,
        "Missing required path parameter declaration for " + key + " (" + operationId + "): " + parameterName
      );
      for (const match of matches) {
        assert(
          match.in === "path",
          "Path template parameter " + parameterName + " for " + key + " (" + operationId + ") must declare in: path"
        );
        assert(
          match.required === "true",
          "Path template parameter " + parameterName + " for " + key + " (" + operationId + ") must declare required: true"
        );
      }
    }
    for (const declaration of resolved) {
      if (declaration.in !== "path") continue;
      assert(
        templateSet.has(declaration.name),
        "Declared path parameter " + declaration.name + " is not present in path template " + pathTemplate + " (" + operationId + ")"
      );
    }
  }
}

// Extract paths & methods from OpenAPI YAML, including explicit lifecycle metadata.
const lines = openApiText.split(/\r?\n/);
const openApiOperations = parseOpenApiOperations(openApiText);
const openApiOps = new Map();
const openApiOperationByKey = new Map();
const openApiOperationIds = new Set();
for (const operation of openApiOperations) {
  const key = routeKey(operation);
  assert(
    CONTRACT_STATUSES.includes(operation.status),
    `Unsupported x-dis-status for ${key} (${operation.operationId}): ${operation.status}`
  );
  assert(!openApiOperationIds.has(operation.operationId), `Duplicate operationId in OpenAPI: ${operation.operationId}`);
  assert(!openApiOps.has(key), `Duplicate method+path in OpenAPI: ${key}`);
  openApiOperationIds.add(operation.operationId);
  openApiOps.set(key, operation.operationId);
  openApiOperationByKey.set(key, operation);
}

assert(openApiOps.size >= 45, `Expected at least 45 operations in OpenAPI, found ${openApiOps.size}`);
assertStrictPathTemplateParameters(lines);

// Parse error and permission catalogs used by machine-readable operation metadata.
const errorCatalogPath = path.join(rootDir, "contracts/errors/error-catalog.yaml");
const permissionCatalogPath = path.join(rootDir, "contracts/permissions/permission-catalog.yaml");
const asyncApiPath = path.join(rootDir, "contracts/asyncapi/events-v1.yaml");
assert(fs.existsSync(errorCatalogPath), "contracts/errors/error-catalog.yaml must exist");
assert(fs.existsSync(permissionCatalogPath), "contracts/permissions/permission-catalog.yaml must exist");
assert(fs.existsSync(asyncApiPath), "contracts/asyncapi/events-v1.yaml must exist");
const errorCatalogText = fs.readFileSync(errorCatalogPath, "utf8");
const permissionCatalogText = fs.readFileSync(permissionCatalogPath, "utf8");
const asyncApiText = fs.readFileSync(asyncApiPath, "utf8");
const catalogErrorCodes = new Set(
  [...errorCatalogText.matchAll(/^\s*-\s*code:\s*([A-Z0-9_]+)\s*$/gm)].map((match) => match[1])
);
const catalogPermissionIds = new Set(
  [...permissionCatalogText.matchAll(/^\s*-\s*id:\s*([A-Za-z0-9._-]+)\s*$/gm)].map((match) => match[1])
);

// Parse endpoint-inventory.yaml. Missing status means active for backward compatibility;
// planned/reserved entries are contract-only until a future implementation card flips them.
const invText = fs.readFileSync(inventoryPath, "utf8");
const inventoryOperations = parseEndpointInventory(invText);
const invOps = new Map();
const inventoryOperationByKey = new Map();
const inventoryOperationIds = new Set();
for (const endpoint of inventoryOperations) {
  const key = routeKey(endpoint);
  assert(endpoint.method && endpoint.path && endpoint.operationId, `Incomplete endpoint inventory entry: ${key}`);
  assert(endpoint.auth, `Missing auth mode in endpoint inventory entry: ${key}`);
  assert(endpoint.owner, `Missing owner in endpoint inventory entry: ${key}`);
  assert(
    CONTRACT_STATUSES.includes(endpoint.status),
    `Unsupported endpoint inventory status for ${key} (${endpoint.operationId}): ${endpoint.status}`
  );
  assert(!inventoryOperationIds.has(endpoint.operationId), `Duplicate operationId in endpoint inventory: ${endpoint.operationId}`);
  assert(!invOps.has(key), `Duplicate method+path in endpoint inventory: ${key}`);
  if (endpoint.status === "planned" || endpoint.status === "reserved") {
    assert(
      typeof endpoint.contractCard === "string" && /^CT-[0-9]+$/.test(endpoint.contractCard),
      `Missing machine-readable contract_card for ${endpoint.status} endpoint: ${key}`
    );
  }
  inventoryOperationIds.add(endpoint.operationId);
  invOps.set(key, endpoint.operationId);
  inventoryOperationByKey.set(key, endpoint);
}

// OpenAPI and endpoint inventory must be identical within each lifecycle class.
// In particular, active remains the runtime parity surface; planned/reserved are explicit
// contract-only surfaces rather than hidden extra operations.
const openApiPartitions = partitionByStatus(openApiOperations);
const inventoryPartitions = partitionByStatus(inventoryOperations);
assert(openApiPartitions.unknown.length === 0, "OpenAPI contains operations with unknown x-dis-status");
assert(inventoryPartitions.unknown.length === 0, "endpoint inventory contains operations with unknown status");
for (const status of CONTRACT_STATUSES) {
  const openApiForStatus = openApiPartitions[status];
  const inventoryForStatus = inventoryPartitions[status];
  assert(
    openApiForStatus.length === inventoryForStatus.length,
    `${status} endpoint count mismatch: OpenAPI=${openApiForStatus.length} Inventory=${inventoryForStatus.length}`
  );
  const inventoryKeys = new Map(inventoryForStatus.map((endpoint) => [routeKey(endpoint), endpoint]));
  const openApiKeys = new Map(openApiForStatus.map((operation) => [routeKey(operation), operation]));
  for (const operation of openApiForStatus) {
    const key = routeKey(operation);
    const inventory = inventoryKeys.get(key);
    assert(inventory, `${status} endpoint missing from endpoint-inventory.yaml: ${key}`);
    assert(
      inventory.operationId === operation.operationId,
      `operationId mismatch for ${key}: OpenAPI=${operation.operationId} vs Inventory=${inventory.operationId}`
    );
  }
  for (const endpoint of inventoryForStatus) {
    assert(openApiKeys.has(routeKey(endpoint)), `${status} inventory endpoint missing from OpenAPI: ${routeKey(endpoint)}`);
  }
}

function operationBlock(operation) {
  const start = operation.line - 1;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^components:\s*$/.test(line) || /^  \//.test(line) || /^    (get|post|patch|delete|put):\s*$/.test(line)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// Validate machine-readable CT metadata. This is deliberately strict only for planned/reserved
// operations so the existing active contract is not rewritten merely to satisfy new metadata.
const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
for (const operation of openApiOperations) {
  const key = routeKey(operation);
  for (const code of operation.errorCodes) {
    assert(catalogErrorCodes.has(code), `x-dis-error-codes references missing error catalog code ${code} at ${key}`);
  }
  for (const permission of operation.permissions) {
    assert(catalogPermissionIds.has(permission), `x-dis-permissions references missing permission ${permission} at ${key}`);
  }
  for (const eventName of operation.events) {
    assert(
      asyncApiText.includes("  " + eventName + ":\n"),
      `x-dis-events references missing AsyncAPI channel ${eventName} at ${key}`
    );
  }
  if (operation.status !== "planned" && operation.status !== "reserved") continue;
  assert(operation.apiVersion === "v1", `${operation.status} endpoint must declare x-dis-api-version: v1 at ${key}`);
  assert(operation.compatibility, `${operation.status} endpoint must declare x-dis-compatibility at ${key}`);
  assert(operation.permissions.length > 0, `${operation.status} endpoint must declare x-dis-permissions at ${key}`);
  assert(operation.errorCodes.length > 0, `${operation.status} endpoint must declare x-dis-error-codes at ${key}`);
  if (operation.status === "planned" && writeMethods.has(operation.method)) {
    assert(
      operation.idempotency === "required",
      `planned write endpoint must declare x-dis-idempotency: required at ${key}`
    );
    const block = operationBlock(operation);
    assert(
      block.includes("#/components/parameters/IdempotencyKeyHeader") || block.includes("name: Idempotency-Key"),
      `planned write endpoint must declare the Idempotency-Key header at ${key}`
    );
  }
}

// Validate JSON Schemas
const schemaDir = path.join(rootDir, "contracts/schemas");
const schemaFiles = fs.readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json"));
assert(schemaFiles.length >= 4, "Expected at least 4 JSON schemas in contracts/schemas");
for (const file of schemaFiles) {
  const parsed = JSON.parse(fs.readFileSync(path.join(schemaDir, file), "utf8"));
  assert(
    parsed.$schema === "https://json-schema.org/draft/2020-12/schema",
    `Schema ${file} must use draft 2020-12`
  );
  assert(typeof parsed.title === "string" && parsed.title.length > 0, `Schema ${file} must have a title`);
}

console.log(
  `[CONTRACT-CI PASS] Verified SYSTEM_CONTRACT.md, strict full YAML syntax parse + duplicate-key scan across ${contractYamlFiles.length} YAML files, ${openApiPartitions.active.length} active + ${openApiPartitions.planned.length} planned + ${openApiPartitions.reserved.length} reserved OpenAPI 3.1.2 operations (100% lifecycle inventory parity), and ${schemaFiles.length} JSON Schema 2020-12 files.`
);
