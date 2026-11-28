#!/usr/bin/env node
// Dependency-free strict YAML syntax validation for the contract repository's
// intentionally conservative YAML subset. Unsupported YAML features fail closed;
// accepted files are structurally parsed rather than scanned with regexes.

export function analyzeYamlSyntax(yamlText, label = "contracts.yaml") {
  const errors = [];
  const rawLines = yamlText.split(/\r\n|\r|\n/);

  function fail(line, message) {
    errors.push(label + ":" + line + ": " + message);
  }

  function leadingIndent(raw) {
    let count = 0;
    while (count < raw.length && raw[count] === " ") count += 1;
    return count;
  }

  function isYamlPrintable(codePoint) {
    return (
      codePoint === 0x09 ||
      (codePoint >= 0x20 && codePoint <= 0x7e) ||
      codePoint === 0x85 ||
      (codePoint >= 0xa0 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    );
  }

  const infos = rawLines.map((raw, index) => {
    const line = index + 1;
    let column = 0;
    for (const char of raw) {
      column += 1;
      const codePoint = char.codePointAt(0);
      const allowedBom = index === 0 && column === 1 && codePoint === 0xfeff;
      if (codePoint === 0x85 || codePoint === 0x2028 || codePoint === 0x2029) {
        fail(line, "Unicode line-break character U+" + codePoint.toString(16).toUpperCase().padStart(4, "0") + " is outside the ASCII line-break contract subset at column " + column);
      } else if (!isYamlPrintable(codePoint) && !allowedBom) {
        fail(line, "non-printable YAML character U+" + codePoint.toString(16).toUpperCase().padStart(4, "0") + " at column " + column);
      }
    }
    const indent = leadingIndent(raw);
    if (raw[indent] === "\t") {
      fail(line, "tab indentation is not valid YAML indentation");
    }
    const text = raw.slice(indent).trimEnd();
    if (!text || text.startsWith("#")) return null;
    return { index, line, indent, text, raw };
  });

  function isBlankRaw(index) {
    return rawLines[index] === undefined || /^\s*$/.test(rawLines[index]);
  }

  function isCommentRaw(index) {
    const raw = rawLines[index] || "";
    const indent = leadingIndent(raw);
    return raw.slice(indent).startsWith("#");
  }

  function nextSignificant(index) {
    for (let cursor = index; cursor < infos.length; cursor += 1) {
      if (infos[cursor]) return infos[cursor];
    }
    return null;
  }

  function parseSequenceItem(info) {
    if (info.text === "-") return { body: "", separatorLength: 0 };
    const match = info.text.match(/^-( +)(.*)$/);
    if (!match) return null;
    return { body: match[2], separatorLength: match[1].length };
  }

  function scanSingleQuoted(text, start) {
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === "'") {
        if (text[index + 1] === "'") {
          index += 2;
          continue;
        }
        return { end: index + 1 };
      }
      index += 1;
    }
    return { error: "unterminated single-quoted scalar" };
  }

  const doubleEscapes = new Set([
    "0", "a", "b", "t", "n", "v", "f", "r", "e", " ", "\"", "/", "\\",
    "N", "_", "L", "P"
  ]);

  function scanDoubleQuoted(text, start) {
    let index = start + 1;
    while (index < text.length) {
      const char = text[index];
      if (char === "\"") return { end: index + 1 };
      if (char === "\\") {
        index += 1;
        if (index >= text.length) return { error: "truncated escape in double-quoted scalar" };
        const escape = text[index];
        if (doubleEscapes.has(escape)) {
          index += 1;
          continue;
        }
        const digits = escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : 0;
        if (!digits) return { error: "unsupported escape sequence \\" + escape + " in double-quoted scalar" };
        const hex = text.slice(index + 1, index + 1 + digits);
        if (hex.length !== digits || !/^[0-9a-fA-F]+$/.test(hex)) {
          return { error: "truncated or non-hexadecimal \\" + escape + " escape in double-quoted scalar" };
        }
        const codePoint = Number.parseInt(hex, 16);
        if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          return { error: "double-quoted escape is outside the Unicode scalar range" };
        }
        index += 1 + digits;
        continue;
      }
      index += 1;
    }
    return { error: "unterminated double-quoted scalar" };
  }

  function parseMappingKey(text, line) {
    if (!text) return null;
    if (text === "?" || text.startsWith("? ")) {
      return { error: "explicit complex YAML keys are outside the supported contract subset" };
    }

    let keyEnd = -1;
    let quoted = false;
    if (text[0] === "'" || text[0] === "\"") {
      quoted = true;
      const scanned = text[0] === "'" ? scanSingleQuoted(text, 0) : scanDoubleQuoted(text, 0);
      if (scanned.error) return { error: scanned.error + " in mapping key" };
      let cursor = scanned.end;
      while (cursor < text.length && text[cursor] === " ") cursor += 1;
      if (text[cursor] !== ":") return null;
      keyEnd = cursor;
    } else {
      for (let index = 0; index < text.length; index += 1) {
        if (text[index] !== ":") continue;
        const next = text[index + 1];
        if (next === undefined || /\s/.test(next)) {
          keyEnd = index;
          break;
        }
      }
    }

    if (keyEnd < 0) return null;
    const rawKey = text.slice(0, keyEnd).trim();
    if (!rawKey) return null;
    return {
      key: rawKey,
      quoted,
      value: text.slice(keyEnd + 1),
      error: null
    };
  }

  function validateMappingKey(parsed, line) {
    if (!parsed || parsed.error) return;
    if (!parsed.quoted) {
      if (parsed.key === "<<") {
        fail(line, "YAML merge keys are outside the supported contract subset");
      }
      if (/^[!&*]/.test(parsed.key)) {
        fail(line, "YAML anchor, tag, or alias key node properties are outside the supported contract subset");
      }
    }
  }

  function stripPlainComment(text) {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "#" && (index === 0 || /\s/.test(text[index - 1]))) {
        return text.slice(0, index).trimEnd();
      }
    }
    return text.trimEnd();
  }

  function parseInlineValue(text, line, columnOffset = 0, context = "block") {
    let pos = 0;

    function inlineFail(message, at = pos) {
      const err = new Error(message);
      err.yamlInline = true;
      err.column = columnOffset + at + 1;
      throw err;
    }

    function skipSpaces() {
      const start = pos;
      while (pos < text.length && (text[pos] === " " || text[pos] === "\t")) pos += 1;
      return pos - start;
    }

    function commentCanStart() {
      return pos === 0 || /\s/.test(text[pos - 1]);
    }

    function finish(node) {
      skipSpaces();
      if (pos >= text.length) return node;
      if (text[pos] === "#" && commentCanStart()) {
        pos = text.length;
        return node;
      }
      inlineFail("unexpected trailing characters after YAML node: " + JSON.stringify(text.slice(pos)));
      return node;
    }

    function isFlowDelimiter(char) {
      return char === "," || char === "]" || char === "}";
    }

    function parsePlain(flowContext) {
      const start = pos;
      const first = text[pos];
      if ((first === "-" || first === "?" || first === ":") && (pos + 1 >= text.length || /\s/.test(text[pos + 1]))) {
        inlineFail("YAML indicator " + JSON.stringify(first) + " cannot start an inline plain scalar here");
      }
      if (first === "@" || first === String.fromCharCode(96) || first === "%") {
        inlineFail("reserved YAML indicator " + JSON.stringify(first) + " cannot start a plain scalar");
      }
      if (first === "," || first === "]" || first === "}") {
        inlineFail("unexpected flow indicator " + JSON.stringify(first));
      }

      while (pos < text.length) {
        const char = text[pos];
        if (char === "#" && (pos === start || /\s/.test(text[pos - 1]))) break;
        if (flowContext === "flow" && isFlowDelimiter(char)) break;
        if (char === ":") {
          const next = text[pos + 1];
          if (
            next === undefined ||
            /\s/.test(next) ||
            (flowContext === "flow" && isFlowDelimiter(next))
          ) {
            inlineFail("mapping value syntax cannot appear inside a plain scalar");
          }
        }
        pos += 1;
      }
      const raw = text.slice(start, pos).trimEnd();
      if (!raw) inlineFail("empty plain scalar is not a valid inline YAML node", start);
      return { kind: "plain", raw };
    }

    function parseQuoted(kind) {
      const scanned = kind === "single" ? scanSingleQuoted(text, pos) : scanDoubleQuoted(text, pos);
      if (scanned.error) inlineFail(scanned.error + "; multiline quoted scalars are outside the supported contract subset");
      pos = scanned.end;
      return { kind };
    }

    function parseBlockScalarHeader() {
      const style = text[pos];
      pos += 1;
      let chomp = null;
      let indentIndicator = null;
      while (pos < text.length) {
        const char = text[pos];
        if (char === "+" || char === "-") {
          if (chomp) inlineFail("duplicate chomping indicator in block scalar header");
          chomp = char;
          pos += 1;
          continue;
        }
        if (/^[1-9]$/.test(char)) {
          if (indentIndicator) inlineFail("duplicate indentation indicator in block scalar header");
          indentIndicator = Number(char);
          pos += 1;
          continue;
        }
        break;
      }
      const spaces = skipSpaces();
      if (pos < text.length && text[pos] !== "#") {
        inlineFail("invalid block scalar header trailing content");
      }
      if (pos < text.length && text[pos] === "#" && spaces === 0) {
        inlineFail("block scalar header comment must be separated by whitespace");
      }
      pos = text.length;
      return { kind: "blockScalar", style, chomp, indentIndicator };
    }

    function parseFlowKey() {
      skipSpaces();
      if (pos >= text.length) inlineFail("unterminated flow mapping");
      if (text[pos] === "'" || text[pos] === "\"") {
        parseQuoted(text[pos] === "'" ? "single" : "double");
        return;
      }
      if (text[pos] === "?" && (pos + 1 >= text.length || /\s/.test(text[pos + 1]))) {
        inlineFail("explicit complex flow mapping keys are outside the supported contract subset");
      }
      const start = pos;
      while (pos < text.length) {
        const char = text[pos];
        if (char === ":") {
          const next = text[pos + 1];
          if (next === undefined || /\s/.test(next) || isFlowDelimiter(next)) return;
        }
        if (char === "," || char === "}") return;
        if (char === "#" && (pos === start || /\s/.test(text[pos - 1]))) inlineFail("comment inside an unterminated flow mapping");
        pos += 1;
      }
      inlineFail("unterminated flow mapping key", start);
    }

    function validateFlowKeyText(keyText) {
      const trimmed = keyText.trim();
      if (!trimmed) inlineFail("empty flow mapping keys are outside the supported contract subset");
      if (trimmed === "<<") inlineFail("YAML merge keys are outside the supported contract subset");
      if (/^[!&*]/.test(trimmed)) inlineFail("anchors, tags, and aliases are outside the supported contract subset");
    }

    function parseFlowMapping() {
      pos += 1;
      skipSpaces();
      if (pos < text.length && text[pos] === "}") {
        pos += 1;
        return { kind: "flowMapping" };
      }
      while (pos < text.length) {
        const keyStart = pos;
        if (text[pos] === "'" || text[pos] === "\"") {
          parseFlowKey();
        } else {
          parseFlowKey();
          validateFlowKeyText(text.slice(keyStart, pos));
        }
        skipSpaces();
        if (text[pos] === ":") {
          const next = text[pos + 1];
          if (!(next === undefined || /\s/.test(next) || isFlowDelimiter(next))) {
            inlineFail("flow mapping colon must be followed by separation space or a flow delimiter");
          }
          pos += 1;
          skipSpaces();
          if (pos < text.length && text[pos] !== "," && text[pos] !== "}") parseNode("flow");
        }
        skipSpaces();
        if (pos >= text.length) inlineFail("unterminated flow mapping");
        if (text[pos] === ",") {
          pos += 1;
          skipSpaces();
          if (text[pos] === "}") {
            pos += 1;
            return { kind: "flowMapping" };
          }
          continue;
        }
        if (text[pos] === "}") {
          pos += 1;
          return { kind: "flowMapping" };
        }
        inlineFail("expected ',' or '}' in flow mapping");
      }
      inlineFail("unterminated flow mapping");
      return { kind: "error" };
    }

    function parseFlowSequence() {
      pos += 1;
      skipSpaces();
      if (pos < text.length && text[pos] === "]") {
        pos += 1;
        return { kind: "flowSequence" };
      }
      while (pos < text.length) {
        skipSpaces();
        if (pos >= text.length) inlineFail("unterminated flow sequence");
        if (text[pos] === "," || text[pos] === "]") {
          inlineFail("empty flow sequence entries are outside the supported contract subset");
        }
        parseNode("flow");
        skipSpaces();
        if (pos >= text.length) inlineFail("unterminated flow sequence");
        if (text[pos] === ",") {
          pos += 1;
          skipSpaces();
          if (text[pos] === "]") {
            pos += 1;
            return { kind: "flowSequence" };
          }
          continue;
        }
        if (text[pos] === "]") {
          pos += 1;
          return { kind: "flowSequence" };
        }
        inlineFail("expected ',' or ']' in flow sequence");
      }
      inlineFail("unterminated flow sequence");
      return { kind: "error" };
    }

    function parseNode(flowContext) {
      skipSpaces();
      if (pos >= text.length) inlineFail("missing YAML node");
      const char = text[pos];
      if (char === "[") return parseFlowSequence();
      if (char === "{") return parseFlowMapping();
      if (char === "'") return parseQuoted("single");
      if (char === "\"") return parseQuoted("double");
      if (char === "|" || char === ">") return parseBlockScalarHeader();
      if (char === "&" || char === "!" || char === "*") {
        inlineFail("YAML anchors, tags, and aliases are outside the supported contract subset");
      }
      return parsePlain(flowContext);
    }

    try {
      skipSpaces();
      if (pos >= text.length || text[pos] === "#") {
        finish({ kind: "empty" });
        return { kind: "empty" };
      }
      const node = parseNode(context);
      return finish(node);
    } catch (error) {
      if (!error || !error.yamlInline) throw error;
      fail(line, error.message + " (column " + error.column + ")");
      return { kind: "error" };
    }
  }

  function validatePlainContinuation(info) {
    const content = stripPlainComment(info.text);
    if (/:(?:\s|$)/.test(content)) {
      fail(info.line, "mapping value syntax cannot appear inside a plain-scalar continuation");
    }
  }

  function consumePlainContinuation(lineIndex, parentIndent) {
    let cursor = lineIndex + 1;
    while (cursor < rawLines.length) {
      if (isBlankRaw(cursor)) {
        let probe = cursor + 1;
        while (probe < rawLines.length && isBlankRaw(probe)) probe += 1;
        if (probe >= rawLines.length || isCommentRaw(probe) || !infos[probe] || infos[probe].indent <= parentIndent) break;
        cursor = probe;
      }
      if (isCommentRaw(cursor)) break;
      const info = infos[cursor];
      if (!info) break;
      if (info.indent <= parentIndent) break;
      validatePlainContinuation(info);
      cursor += 1;
    }
    return cursor;
  }

  function consumeBlockScalar(lineIndex, parentIndent, node) {
    let cursor = lineIndex + 1;
    let contentIndent = null;
    const explicitIndent = node.indentIndicator ? parentIndent + node.indentIndicator : null;
    while (cursor < rawLines.length) {
      const raw = rawLines[cursor];
      if (/^\s*$/.test(raw)) {
        cursor += 1;
        continue;
      }
      const indent = leadingIndent(raw);
      if (contentIndent === null) {
        if (indent <= parentIndent) return cursor;
        if (explicitIndent !== null && indent < explicitIndent) {
          fail(cursor + 1, "block scalar content is indented less than its explicit indentation indicator");
          cursor += 1;
          continue;
        }
        contentIndent = explicitIndent === null ? indent : explicitIndent;
        cursor += 1;
        continue;
      }
      if (indent < contentIndent) {
        if (indent <= parentIndent) return cursor;
        fail(cursor + 1, "line is indented less than block scalar content but too deeply to be a structural sibling");
        cursor += 1;
        continue;
      }
      cursor += 1;
    }
    return cursor;
  }

  function consumeMappingValue(lineIndex, keyIndent, valueText) {
    const inline = parseInlineValue(valueText, lineIndex + 1, 0, "block");
    if (inline.kind === "empty") {
      const next = nextSignificant(lineIndex + 1);
      if (next && next.indent > keyIndent) return parseBlockNode(next.index, next.indent, keyIndent);
      if (next && next.indent === keyIndent && parseSequenceItem(next)) return parseSequence(next.index, keyIndent);
      return lineIndex + 1;
    }
    if (inline.kind === "error") return lineIndex + 1;
    if (inline.kind === "blockScalar") return consumeBlockScalar(lineIndex, keyIndent, inline);
    if (inline.kind === "plain") return consumePlainContinuation(lineIndex, keyIndent);
    return lineIndex + 1;
  }

  function parseMapping(startIndex, indent) {
    let cursor = startIndex;
    while (cursor < rawLines.length) {
      const info = nextSignificant(cursor);
      if (!info) return rawLines.length;
      if (info.indent < indent) return info.index;
      if (info.indent > indent) {
        fail(info.line, "unexpected indentation " + info.indent + "; expected mapping key at indent " + indent);
        cursor = info.index + 1;
        continue;
      }
      if (parseSequenceItem(info)) return info.index;
      const parsed = parseMappingKey(info.text, info.line);
      if (!parsed) {
        fail(info.line, "unsupported non-mapping YAML line in mapping context");
        cursor = info.index + 1;
        continue;
      }
      if (parsed.error) {
        fail(info.line, parsed.error);
        cursor = info.index + 1;
        continue;
      }
      validateMappingKey(parsed, info.line);
      cursor = consumeMappingValue(info.index, indent, parsed.value);
    }
    return cursor;
  }

  function parseSequence(startIndex, indent) {
    let cursor = startIndex;
    while (cursor < rawLines.length) {
      const info = nextSignificant(cursor);
      if (!info) return rawLines.length;
      if (info.indent < indent) return info.index;
      if (info.indent > indent) {
        fail(info.line, "unexpected indentation " + info.indent + "; expected sequence item at indent " + indent);
        cursor = info.index + 1;
        continue;
      }
      const item = parseSequenceItem(info);
      if (!item) return info.index;
      if (item.body === "") {
        const next = nextSignificant(info.index + 1);
        if (next && next.indent > indent) cursor = parseBlockNode(next.index, next.indent, indent);
        else cursor = info.index + 1;
        continue;
      }

      const compactKey = parseMappingKey(item.body, info.line);
      if (compactKey) {
        if (compactKey.error) {
          fail(info.line, compactKey.error);
          cursor = info.index + 1;
          continue;
        }
        validateMappingKey(compactKey, info.line);
        const keyIndent = indent + 1 + item.separatorLength;
        const afterInlineValue = consumeMappingValue(info.index, keyIndent, compactKey.value);
        cursor = parseMapping(afterInlineValue, keyIndent);
        continue;
      }

      const inline = parseInlineValue(item.body, info.line, indent + 1 + item.separatorLength, "block");
      if (inline.kind === "blockScalar") cursor = consumeBlockScalar(info.index, indent, inline);
      else if (inline.kind === "plain") cursor = consumePlainContinuation(info.index, indent);
      else cursor = info.index + 1;
    }
    return cursor;
  }

  function parseBlockScalarNode(info, parentIndent) {
    const inline = parseInlineValue(info.text, info.line, info.indent, "block");
    if (inline.kind === "plain") return consumePlainContinuation(info.index, parentIndent);
    if (inline.kind === "blockScalar") return consumeBlockScalar(info.index, info.indent, inline);
    return info.index + 1;
  }

  function parseBlockNode(startIndex, indent, parentIndent) {
    const info = nextSignificant(startIndex);
    if (!info) return rawLines.length;
    if (info.indent !== indent) {
      fail(info.line, "inconsistent block indentation " + info.indent + "; expected " + indent);
    }
    if (parseSequenceItem(info)) return parseSequence(info.index, indent);
    const mappingKey = parseMappingKey(info.text, info.line);
    if (mappingKey) return parseMapping(info.index, indent);
    return parseBlockScalarNode(info, parentIndent);
  }

  const first = nextSignificant(0);
  if (first) {
    if (first.indent !== 0) {
      fail(first.line, "document root must start at indentation zero in contract YAML");
    }
    if (first.text === "---" || first.text === "..." || first.text.startsWith("%")) {
      fail(first.line, "YAML directives and document markers are outside the supported contract subset");
    } else {
      const end = parseBlockNode(first.index, first.indent, -1);
      const trailing = nextSignificant(end);
      if (trailing) {
        fail(trailing.line, "unexpected trailing YAML content after the document root node");
      }
    }
  }
  return { errors };
}

export function analyzeYamlStrictParserSelfTest() {
  const cases = [
    {
      name: "strict-valid-contract-shape.yaml",
      expectError: false,
      text: "version: 1.0.0\nendpoints:\n  - method: GET\n    path: /healthz\n    tags: [health, public]\n    nested: [a, [b, c,], {d: e,},]\n    pattern: ^[a-z0-9][a-z0-9_-]{1,63}$\n    ref: '#/components/schemas/X'\n    description: >-\n      Signed artifact family. dis-datapack/v1: implementations must parse exact bytes.\n"
    },
    {
      name: "strict-ct06-negative.yaml",
      expectError: true,
      text: "components:\n  schemas:\n    ContentPackArtifactFormat:\n      description: Signed artifact family. dis-datapack/v1: implementations must parse exact bytes.\n"
    },
    {
      name: "strict-continuation-negative.yaml",
      expectError: true,
      text: "root:\n  description: first line\n    format: uuid\n  sibling: true\n"
    },
    {
      name: "strict-commented-continuation-control.yaml",
      expectError: false,
      text: "root:\n  description: first line\n    continuation text # Note: pagination applies\n  sibling: true\n"
    },
    {
      name: "strict-unterminated-flow-negative.yaml",
      expectError: true,
      text: "root: [active, planned\n"
    },
    {
      name: "strict-mismatched-flow-negative.yaml",
      expectError: true,
      text: "root: [active, {planned: reserved]\n"
    },
    {
      name: "strict-quoted-trailing-negative.yaml",
      expectError: true,
      text: "root: 'abc' junk\n"
    },
    {
      name: "strict-double-quote-control.yaml",
      expectError: false,
      text: "root: \"line\\nfeed\"\n"
    },
    {
      name: "strict-tab-negative.yaml",
      expectError: true,
      text: "root:\n\tchild: true\n"
    },
    {
      name: "strict-block-indent-negative.yaml",
      expectError: true,
      text: "root:\n  description: |\n      content\n    bad\n  sibling: true\n"
    },
    {
      name: "strict-anchor-negative.yaml",
      expectError: true,
      text: "root: &anchor value\n"
    },
    {
      name: "strict-control-character-negative.yaml",
      expectError: true,
      text: "root: bad\x01control\n"
    },
    {
      name: "strict-unicode-linebreak-negative.yaml",
      expectError: true,
      text: "root: bad\u2028break\n"
    },
    {
      name: "strict-colon-end-negative.yaml",
      expectError: true,
      text: "root: abc def:\n"
    },
    {
      name: "strict-indentless-sequence-control.yaml",
      expectError: false,
      text: "root:\n  enum:\n  - ALPHA\n  - BETA\n  sibling: true\n"
    }
  ];
  const failures = [];
  for (const testCase of cases) {
    const errors = analyzeYamlSyntax(testCase.text, testCase.name).errors;
    if (testCase.expectError && errors.length === 0) {
      failures.push(testCase.name + " must be rejected by the strict YAML parser");
    }
    if (!testCase.expectError && errors.length > 0) {
      failures.push(testCase.name + " must parse cleanly but failed: " + errors.slice(0, 3).join(" | "));
    }
  }
  return failures;
}
