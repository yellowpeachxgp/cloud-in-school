#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "../..");
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const SKIP_DIR_NAMES = new Set([
  ".git",
  ".gradle",
  ".idea",
  ".kotlin",
  ".next",
  ".cxx",
  ".externalNativeBuild",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out"
]);

const IPV4_RE = /(?<![0-9A-Za-z_.])((?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3})(?![0-9A-Za-z_])/g;
const IPV6_CANDIDATE_RE = /(?<![0-9A-Za-z_.])(?:[0-9A-Fa-f]{0,4}:){2,}(?:[0-9A-Fa-f]{0,4}|[0-9]{1,3}(?:\.[0-9]{1,3}){3})?(?![0-9A-Za-z_.])/g;
const USER_AT_HOST_RE = /(?<![0-9A-Za-z_.+-])([A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+)(?![0-9A-Za-z_.-])/g;
const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g;
const PGP_PRIVATE_KEY_RE = new RegExp("-----BEGIN " + "PGP PRIVATE KEY BLOCK-----", "g");
const SENSITIVE_KEY_PATTERN = "[A-Za-z0-9_-]*(?:password|passwd|pwd|passphrase|passcode|token|cookie|secret|api[_-]?key|access[_-]?key)[A-Za-z0-9_-]*";
const SENSITIVE_QUOTED_KEY_ASSIGNMENT_RE = new RegExp(
  "([\"'])(" + SENSITIVE_KEY_PATTERN + ")\\1\\s*[:=]\\s*([\"'\\x60])([^\"'\\x60\\r\\n]{4,})\\3",
  "gi"
);
const SENSITIVE_BARE_KEY_ASSIGNMENT_RE = new RegExp(
  "(?<![A-Za-z0-9_\"'])(" + SENSITIVE_KEY_PATTERN + ")\\s*[:=]\\s*([\"'\\x60])([^\"'\\x60\\r\\n]{4,})\\2",
  "gi"
);
const YAML_SENSITIVE_ASSIGNMENT_RE = new RegExp(
  "^\\s*(?:-\\s*)?[\"']?(" + SENSITIVE_KEY_PATTERN + ")[\"']?\\s*:\\s*([^\\s\"'\\x60][^#\\r\\n]*?)\\s*(?:#.*)?$",
  "i"
);
const YAML_INLINE_SENSITIVE_ASSIGNMENT_RE = new RegExp(
  "(?:^|[\\s\\{\\[,\\-])[\"']?(" + SENSITIVE_KEY_PATTERN + ")[\"']?\\s*:\\s*([^\\s\"'\\x60\\}\\],][^\\}\\]\\r\\n,]*)",
  "gi"
);
const YAML_BLOCK_KEY_RE = new RegExp(
  "^\\s*(?:-\\s*)?[\"']?(" + SENSITIVE_KEY_PATTERN + ")[\"']?\\s*:\\s*[|>](?:[+-])?\\s*(?:#.*)?$",
  "i"
);
const ENV_SECRET_ASSIGNMENT_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=([^\s#]+)/;
const AUTHORIZATION_BEARER_RE = /\b["']?authorization["']?\s*:\s*["']?bearer\s+([A-Za-z0-9][A-Za-z0-9._~+\/-]{7,}={0,2})/gi;

const TOKEN_RULES = [
  { id: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: "openai-or-anthropic-key", pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: "stripe-key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { id: "aws-access-key", pattern: /\bA[KS]IA[0-9A-Z]{16}\b/g },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "pypi-token", pattern: /\bpypi-[A-Za-z0-9_-]{20,}\b/g },
  { id: "uri-with-credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi }
];

const DEFAULT_V4_ALLOW_NETWORKS = [
  ["0.0.0.0", 32],
  ["127.0.0.0", 8],
  ["192.0.2.0", 24],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
];

const DEFAULT_V6_ALLOW_NETWORKS = [
  ["::", 128],
  ["::1", 128],
  ["2001:db8::", 32],
  ["ff00::", 8]
];

function usage() {
  console.log([
    "Usage: node tools/secret-scan/scan.mjs [--root <repo>] [--format text|json] [--extra-literal <value>]...",
    "",
    "Read-only scanner for repository content. Findings are redacted; only fingerprints are printed.",
    "Runtime-sensitive literals may be supplied by repeated --extra-literal arguments or by newline-separated CIS_SECRET_SCAN_EXTRA_LITERALS."
  ].join("\n"));
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, format: "text", help: false, extraLiterals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--root") {
      i += 1;
      if (!argv[i]) throw new Error("--root requires a value");
      options.root = path.resolve(argv[i]);
    } else if (arg === "--format") {
      i += 1;
      if (!argv[i] || !["text", "json"].includes(argv[i])) throw new Error("--format must be text or json");
      options.format = argv[i];
    } else if (arg === "--extra-literal") {
      i += 1;
      if (!argv[i]) throw new Error("--extra-literal requires a value");
      options.extraLiterals.push(argv[i]);
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }
  return options;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob) {
  let body = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        body += ".*";
        i += 1;
      } else {
        body += "[^/]*";
      }
    } else if (ch === "?") {
      body += "[^/]";
    } else {
      body += escapeRegExp(ch);
    }
  }
  return new RegExp("^" + body + "$");
}

function pathMatches(glob, file) {
  return globToRegExp(glob).test(file);
}

function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function ipv4InCidr(ip, network, prefix) {
  const value = ipv4ToInt(ip);
  const base = ipv4ToInt(network);
  if (value === null || base === null || prefix < 0 || prefix > 32) return false;
  const shift = 32 - prefix;
  return (value >>> shift) === (base >>> shift);
}

function expandIpv6(input) {
  let value = input.toLowerCase().split("%")[0];
  const embeddedV4 = value.match(/([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/);
  if (embeddedV4) {
    if (isIP(embeddedV4[1]) !== 4) return null;
    const numeric = ipv4ToInt(embeddedV4[1]);
    const high = (numeric >>> 16).toString(16);
    const low = (numeric & 0xffff).toString(16);
    value = value.slice(0, value.length - embeddedV4[1].length) + high + ":" + low;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (groups.length !== 8) return null;
  const numbers = groups.map(group => Number.parseInt(group, 16));
  if (numbers.some(number => !Number.isInteger(number) || number < 0 || number > 0xffff)) return null;
  return numbers;
}

function ipv6ToBigInt(ip) {
  const groups = expandIpv6(ip);
  if (!groups) return null;
  let value = 0n;
  for (const group of groups) value = (value << 16n) + BigInt(group);
  return value;
}

function ipv6InCidr(ip, network, prefix) {
  const value = ipv6ToBigInt(ip);
  const base = ipv6ToBigInt(network);
  if (value === null || base === null || prefix < 0 || prefix > 128) return false;
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (base >> shift);
}

function isDefaultAllowedIp(ip) {
  const version = isIP(ip);
  if (version === 4) {
    return DEFAULT_V4_ALLOW_NETWORKS.some(([network, prefix]) => ipv4InCidr(ip, network, prefix));
  }
  if (version === 6) {
    return DEFAULT_V6_ALLOW_NETWORKS.some(([network, prefix]) => ipv6InCidr(ip, network, prefix));
  }
  return false;
}

function isScanworthyIpv6(candidate) {
  if (isIP(candidate) !== 6) return false;
  const normalized = candidate.toLowerCase();
  if (normalized === "::" || normalized === "::1" || normalized.includes(".")) return true;
  if (normalized.startsWith("::")) {
    const suffix = normalized.slice(2);
    if (/^[a-f]+$/.test(suffix) && !/[0-9]/.test(suffix)) return false;
  }
  const hextets = normalized.match(/[0-9a-f]{1,4}/g) || [];
  return hextets.length >= 1;
}

function metadataValue(comment, key) {
  const match = comment.match(new RegExp("(?:^|\\s)" + key + "=([^\\s]+)"));
  return match ? match[1] : null;
}

function metadataReason(comment) {
  const match = comment.match(/(?:^|\s)reason=(.+)$/);
  return match ? match[1].trim() : null;
}

function readAllowlist(root) {
  const file = path.join(root, "tools", "secret-scan", "allowlist.txt");
  const entries = [];
  const errors = [];
  if (!fs.existsSync(file)) return entries;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = index + 1;
    const rawLine = lines[index];
    const commentIndex = rawLine.indexOf("#");
    const comment = commentIndex >= 0 ? rawLine.slice(commentIndex + 1).trim() : "";
    const withoutComment = (commentIndex >= 0 ? rawLine.slice(0, commentIndex) : rawLine).trim();
    if (!withoutComment) continue;
    const parts = withoutComment.split(/\s+/);
    if (parts.length !== 4) {
      errors.push("line " + sourceLine + ": expected '<rule> <sha256> <path-glob> <line-or-*>'");
      continue;
    }
    const [rule, hash, pathGlob, lineSpec] = parts;
    if (!/^[a-z0-9-]+$/.test(rule)) errors.push("line " + sourceLine + ": invalid rule name");
    if (!/^[0-9a-f]{64}$/.test(hash)) errors.push("line " + sourceLine + ": invalid sha256 fingerprint");
    let line = null;
    if (lineSpec !== "*") {
      if (!/^\d+$/.test(lineSpec)) {
        errors.push("line " + sourceLine + ": line scope must be a non-negative integer or *");
      } else {
        line = Number.parseInt(lineSpec, 10);
      }
    }
    const owner = metadataValue(comment, "owner");
    const expiry = metadataValue(comment, "expiry");
    const classification = metadataValue(comment, "class");
    const reason = metadataReason(comment);
    if (!owner) errors.push("line " + sourceLine + ": missing owner=<owner> metadata");
    if (!classification) errors.push("line " + sourceLine + ": missing class=<class> metadata");
    if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      errors.push("line " + sourceLine + ": missing or invalid expiry=YYYY-MM-DD metadata");
    } else {
      const expiryTime = Date.parse(expiry + "T23:59:59.999Z");
      if (!Number.isFinite(expiryTime) || expiryTime < Date.now()) errors.push("line " + sourceLine + ": expired allowlist entry");
    }
    if (!reason) errors.push("line " + sourceLine + ": missing reason=<text> metadata");
    entries.push({ rule, hash, pathGlob, line, owner, expiry, classification, reason, sourceLine, usedCount: 0 });
  }
  if (errors.length > 0) {
    throw new Error("invalid tools/secret-scan/allowlist.txt: " + errors.join("; "));
  }
  return entries;
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function allowlistMatches(entries, rule, value, file, lineNumber) {
  const hash = sha256Hex(value);
  const entry = entries.find(candidate =>
    candidate.rule === rule &&
    candidate.hash === hash &&
    pathMatches(candidate.pathGlob, file) &&
    (candidate.line === null || candidate.line === lineNumber)
  );
  if (entry) entry.usedCount += 1;
  return Boolean(entry);
}

function fingerprint(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 12) + "/len" + String(value).length;
}

function redactPathForOutput(value) {
  const configuredRoot = (process.env.CIS_CAMPUS_ROOT || "").trim().replace(/\/+$/, "");
  if (!configuredRoot) return value;
  const candidates = [configuredRoot];
  try {
    const canonicalRoot = fs.realpathSync(configuredRoot).replace(/\/+$/, "");
    if (!candidates.includes(canonicalRoot)) candidates.push(canonicalRoot);
  } catch {
    // Keep the configured spelling when it cannot be canonicalized.
  }
  for (const campusRoot of candidates) {
    if (value === campusRoot) return "<campus-root>";
    if (value.startsWith(campusRoot + "/")) return "<campus-root>" + value.slice(campusRoot.length);
  }
  return value;
}

function addFinding(findings, seen, file, line, rule, value) {
  const fp = fingerprint(value);
  const key = [file, line, rule, fp].join("\0");
  if (seen.has(key)) return;
  seen.add(key);
  findings.push({ file, line, rule, fingerprint: fp });
}

function listTrackedFiles(root) {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return output.split("\0").filter(Boolean).sort();
}

function isDotEnvName(baseName) {
  if (baseName === ".env") return true;
  if (!baseName.startsWith(".env.")) return false;
  return !/^\.env\.(example|sample|template)(?:\.|$)/.test(baseName);
}

function walkDotEnvFiles(root) {
  const results = new Set();
  function walk(relativeDir) {
    const absoluteDir = path.join(root, relativeDir);
    let entries;
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = relativeDir ? relativeDir + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name)) walk(relative);
      } else if (entry.isFile() && isDotEnvName(entry.name)) {
        results.add(relative);
      }
    }
  }
  walk("");
  return [...results].sort();
}

function isProbablyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function isNonNetworkDottedQuad(line, ip) {
  const escaped = escapeRegExp(ip);
  if (new RegExp("(?:Chrome|Chromium|Firefox|Version)/" + escaped + "(?:\\s|$)").test(line)) return true;
  if (/(?:OpenJDK|Java|JDK)\b/i.test(line) && !/(?:https?:\/\/|ssh\b|@)/.test(line)) return true;
  return false;
}

function addRuntimeNeedle(needles, seen, value, rule) {
  const needle = String(value || "").trim();
  if (needle.length < 4) return;
  const key = rule + "\0" + needle;
  if (seen.has(key)) return;
  seen.add(key);
  needles.push({ value: needle, rule });
}

function runtimeSensitiveNeedles(extraLiterals) {
  const needles = [];
  const seen = new Set();
  const add = (value, rule) => addRuntimeNeedle(needles, seen, value, rule);

  const rawDevbox = (process.env.CIS_DEVBOX || "").trim();
  if (rawDevbox) {
    add(rawDevbox, "devbox-address");
    const withoutScheme = rawDevbox.replace(/^ssh:\/\//, "");
    const authority = withoutScheme.split("/")[0];
    add(authority, "devbox-address");
    const userPart = authority.includes("@") ? authority.slice(0, authority.indexOf("@")) : "";
    add(userPart, "devbox-user");
    const hostPort = authority.includes("@") ? authority.slice(authority.indexOf("@") + 1) : authority;
    add(hostPort, "devbox-address");
    let host = hostPort;
    const bracketed = hostPort.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (bracketed) host = bracketed[1];
    else host = hostPort.replace(/:\d+$/, "");
    add(host, "devbox-address");
  }

  const campusRoot = (process.env.CIS_CAMPUS_ROOT || "").trim();
  if (campusRoot) {
    add(campusRoot, "campus-root");
    add(campusRoot.replace(/\/+$/, ""), "campus-root");
  }

  const envExtra = (process.env.CIS_SECRET_SCAN_EXTRA_LITERALS || "").split(/\r?\n/);
  for (const value of envExtra) add(value, "extra-literal");
  for (const value of extraLiterals) add(value, "extra-literal");

  return needles.sort((a, b) => b.value.length - a.value.length);
}

function scanIpLine({ findings, seen, file, lineNumber, line, allowlist, runtimeNeedles }) {
  for (const match of line.matchAll(IPV4_RE)) {
    const ip = match[1];
    if (isNonNetworkDottedQuad(line, ip)) continue;
    if (isDefaultAllowedIp(ip)) continue;
    if (allowlistMatches(allowlist, "ip-literal", ip, file, lineNumber)) continue;
    addFinding(findings, seen, file, lineNumber, "ip-literal", ip);
  }

  for (const match of line.matchAll(IPV6_CANDIDATE_RE)) {
    const ip = match[0];
    if (!isScanworthyIpv6(ip)) continue;
    if (isDefaultAllowedIp(ip)) continue;
    if (allowlistMatches(allowlist, "ip-literal-v6", ip, file, lineNumber)) continue;
    addFinding(findings, seen, file, lineNumber, "ip-literal-v6", ip);
  }

  for (const match of line.matchAll(USER_AT_HOST_RE)) {
    const userAtHost = match[1];
    const user = userAtHost.split("@")[0];
    if (["this", "return", "break", "continue"].includes(user)) continue;
    if (allowlistMatches(allowlist, "user-at-host", userAtHost, file, lineNumber)) continue;
    addFinding(findings, seen, file, lineNumber, "user-at-host", userAtHost);
  }

  for (const needle of runtimeNeedles) {
    if (line.includes(needle.value)) {
      addFinding(findings, seen, file, lineNumber, needle.rule, needle.value);
    }
  }
}

function cleanSecretValue(rawValue) {
  let value = String(rawValue || "").trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

function isTemplateOrPlaceholder(value) {
  const normalized = value.trim();
  if (!normalized) return true;
  if (normalized.startsWith("$")) return true;
  if (normalized.includes(String.fromCharCode(36, 123))) return true;
  if (/^<[^>]+>$/.test(normalized)) return true;
  if (/^\{\{.*\}\}$/.test(normalized)) return true;
  if (/^%[A-Z0-9_]+%$/.test(normalized)) return true;
  if (/^(?:redacted|placeholder|dummy|change-me|changeme)$/i.test(normalized)) return true;
  return false;
}

function isUpperConstantSymbolKey(key) {
  const raw = String(key || "").replace(/^["']+|["']+$/g, "");
  return /^[A-Z0-9_]+$/.test(raw) && raw.includes("_");
}

function isCredentialKey(key) {
  const normalized = String(key || "").replace(/^["']+|["']+$/g, "").toLowerCase().replace(/[-_]/g, "");
  if (normalized === "setcookie") return false;
  if (normalized === "matchedtoken" || normalized === "mutationtoken") return false;
  if (/^(password|passwd|pwd|passphrase|passcode|token|cookie|secret|apikey|accesskey|secretkey|privatekey|clientsecret|apitoken|rawtoken|passtoken|servicetoken|sessiontoken|accesstoken|refreshtoken|authtoken|bearertoken|idtoken|csrftoken|logintoken|privatetoken)$/.test(normalized)) return true;
  if (normalized.endsWith("token")) return true;
  return /(?:password|passwd|pwd|passphrase|passcode|secret|cookie|apitoken|accesstoken|refreshtoken|authtoken|bearertoken|idtoken|clientsecret|apikey|accesskey|secretkey|privatekey|rawtoken|passtoken|servicetoken|sessiontoken)$/.test(normalized);
}

function isYamlFile(file) {
  return /\.(?:ya?ml)$/i.test(file);
}

function isConcatenatedFragment(line, match) {
  const before = line.slice(0, match.index).trimEnd();
  const after = line.slice(match.index + match[0].length).trimStart();
  return before.endsWith("+") || after.startsWith("+");
}

function leadingWhitespaceWidth(line) {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

function scanSensitiveAssignments({ findings, seen, file, lineNumber, line, allowlist, yamlState }) {
  const candidates = [];
  for (const match of line.matchAll(SENSITIVE_QUOTED_KEY_ASSIGNMENT_RE)) {
    if (isCredentialKey(match[2]) && !isUpperConstantSymbolKey(match[2]) && !isConcatenatedFragment(line, match)) candidates.push({ value: match[4], rule: "sensitive-assignment" });
  }
  for (const match of line.matchAll(SENSITIVE_BARE_KEY_ASSIGNMENT_RE)) {
    if (isCredentialKey(match[1]) && !isConcatenatedFragment(line, match)) candidates.push({ value: match[3], rule: "sensitive-assignment" });
  }

  const envMatch = line.match(ENV_SECRET_ASSIGNMENT_RE);
  if (envMatch && isCredentialKey(envMatch[1])) candidates.push({ value: envMatch[2], rule: "sensitive-assignment" });

  if (isYamlFile(file)) {
    const blockKeyMatch = line.match(YAML_BLOCK_KEY_RE);
    if (blockKeyMatch && isCredentialKey(blockKeyMatch[1])) {
      yamlState.pending = true;
      yamlState.indent = leadingWhitespaceWidth(line);
    } else if (yamlState.pending && line.trim()) {
      if (leadingWhitespaceWidth(line) > yamlState.indent) {
        candidates.push({ value: line.trim(), rule: "sensitive-assignment" });
      }
      yamlState.pending = false;
    }

    const yamlMatch = line.match(YAML_SENSITIVE_ASSIGNMENT_RE);
    if (yamlMatch && isCredentialKey(yamlMatch[1])) candidates.push({ value: yamlMatch[2], rule: "sensitive-assignment" });

    for (const match of line.matchAll(YAML_INLINE_SENSITIVE_ASSIGNMENT_RE)) {
      if (isCredentialKey(match[1]) && !isConcatenatedFragment(line, match)) candidates.push({ value: match[2], rule: "sensitive-assignment" });
    }
  }

  for (const match of line.matchAll(AUTHORIZATION_BEARER_RE)) {
    candidates.push({ value: match[1], rule: "authorization-bearer" });
  }

  for (const candidate of candidates) {
    const value = cleanSecretValue(candidate.value);
    if (!value || value.length < 4) continue;
    if (isTemplateOrPlaceholder(value)) continue;
    if (allowlistMatches(allowlist, candidate.rule, value, file, lineNumber)) continue;
    addFinding(findings, seen, file, lineNumber, candidate.rule, value);
  }
}

function scanLineContent({ findings, seen, file, lineNumber, line, allowlist, runtimeNeedles, yamlState }) {
  scanIpLine({ findings, seen, file, lineNumber, line, allowlist, runtimeNeedles });

  for (const match of line.matchAll(PRIVATE_KEY_RE)) {
    addFinding(findings, seen, file, lineNumber, "private-key-header", match[0]);
  }

  for (const match of line.matchAll(PGP_PRIVATE_KEY_RE)) {
    addFinding(findings, seen, file, lineNumber, "pgp-private-key-header", match[0]);
  }

  for (const rule of TOKEN_RULES) {
    for (const match of line.matchAll(rule.pattern)) {
      if (allowlistMatches(allowlist, rule.id, match[0], file, lineNumber)) continue;
      addFinding(findings, seen, file, lineNumber, rule.id, match[0]);
    }
  }

  scanSensitiveAssignments({ findings, seen, file, lineNumber, line, allowlist, yamlState });
}

function scanLines(lines, startLineNumber, context) {
  for (let index = 0; index < lines.length; index += 1) {
    scanLineContent({
      ...context,
      line: lines[index],
      lineNumber: startLineNumber + index
    });
  }
  return startLineNumber + lines.length;
}

function scanLargeTextFileInChunks(absolute, file, allowlist, runtimeNeedles, findings, seen) {
  const fd = fs.openSync(absolute, "r");
  const decoder = new StringDecoder("utf8");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const yamlState = { pending: false, indent: 0 };
  let leftover = "";
  let lineNumber = 1;
  let firstChunk = true;
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      if (firstChunk && isProbablyBinary(chunk.subarray(0, Math.min(bytesRead, 8192)))) return false;
      firstChunk = false;
      leftover += decoder.write(chunk.subarray(0, bytesRead));
      const parts = leftover.split(/\r?\n/);
      leftover = parts.pop() || "";
      if (leftover.length > MAX_LINE_BYTES) {
        throw new Error("oversize line in chunked scan for " + file);
      }
      if (parts.length > 0) {
        lineNumber = scanLines(parts, lineNumber, { findings, seen, file, allowlist, runtimeNeedles, yamlState });
      }
    }
    leftover += decoder.end();
    if (leftover.length > 0) {
      if (leftover.length > MAX_LINE_BYTES) throw new Error("oversize line in chunked scan for " + file);
      scanLines([leftover], lineNumber, { findings, seen, file, allowlist, runtimeNeedles, yamlState });
    }
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function scanTextFile(root, file, allowlist, runtimeNeedles, findings, seen, warnings) {
  const absolute = path.join(root, file);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    warnings.push({ file, warning: "tracked-file-missing" });
    return false;
  }
  if (!stat.isFile()) return false;
  if (stat.size > MAX_FILE_BYTES) {
    warnings.push({ file, warning: "file-over-20MiB-scanned-in-chunks" });
    return scanLargeTextFileInChunks(absolute, file, allowlist, runtimeNeedles, findings, seen);
  }
  const buffer = fs.readFileSync(absolute);
  if (isProbablyBinary(buffer)) return false;
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/);
  const yamlState = { pending: false, indent: 0 };
  scanLines(lines, 1, { findings, seen, file, allowlist, runtimeNeedles, yamlState });
  return true;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const root = path.resolve(options.root);
  if (!fs.existsSync(path.join(root, ".git"))) {
    throw new Error("Not a git worktree: " + redactPathForOutput(root));
  }

  const allowlist = readAllowlist(root);
  const runtimeNeedles = runtimeSensitiveNeedles(options.extraLiterals);
  const trackedFiles = listTrackedFiles(root);
  const findings = [];
  const warnings = [];
  const seen = new Set();
  let scannedFiles = 0;

  for (const file of trackedFiles) {
    if (isDotEnvName(path.posix.basename(file))) {
      addFinding(findings, seen, file, 0, "dotenv-file", path.posix.basename(file));
    }
    if (scanTextFile(root, file, allowlist, runtimeNeedles, findings, seen, warnings)) scannedFiles += 1;
  }

  for (const file of walkDotEnvFiles(root)) {
    if (isDotEnvName(path.posix.basename(file))) {
      addFinding(findings, seen, file, 0, trackedFiles.includes(file) ? "dotenv-file" : "dotenv-file-untracked", path.posix.basename(file));
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  const allowlistUsed = allowlist.filter(entry => entry.usedCount > 0).length;
  const result = {
    ok: findings.length === 0,
    root: redactPathForOutput(root),
    scannedFiles,
    trackedFiles: trackedFiles.length,
    allowlistEntries: allowlist.length,
    allowlistUsed,
    allowlistUsage: allowlist.map((entry, index) => ({
      index,
      pathGlob: entry.pathGlob,
      line: entry.line,
      owner: entry.owner,
      expiry: entry.expiry,
      usedCount: entry.usedCount
    })),
    findings,
    warnings
  };

  if (options.format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else if (findings.length === 0) {
    console.log("SECRET_SCAN_PASS files=" + scannedFiles + " tracked=" + trackedFiles.length + " findings=0 allowlistEntries=" + allowlist.length + " allowlistUsed=" + allowlistUsed + " warnings=" + warnings.length);
    for (const warning of warnings) console.log("SECRET_SCAN_WARNING " + warning.file + " " + warning.warning);
  } else {
    console.log("SECRET_SCAN_FAIL findings=" + findings.length + " files=" + scannedFiles + " tracked=" + trackedFiles.length + " warnings=" + warnings.length);
    for (const finding of findings) {
      console.log(finding.file + ":" + finding.line + " rule=" + finding.rule + " fingerprint=" + finding.fingerprint);
    }
    for (const warning of warnings) console.log("SECRET_SCAN_WARNING " + warning.file + " " + warning.warning);
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}

try {
  main();
} catch (error) {
  console.error("SECRET_SCAN_ERROR " + (error && error.message ? error.message : String(error)));
  process.exitCode = 2;
}
