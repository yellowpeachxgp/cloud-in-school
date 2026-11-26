#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "../..");
const MAX_FILE_BYTES = 20 * 1024 * 1024;
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

const IPV4_RE = /(?<![0-9A-Za-z_.])((?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3})(?![0-9A-Za-z_.])/g;
const IPV6_CANDIDATE_RE = /(?<![0-9A-Za-z_.])(?:[0-9A-Fa-f]{0,4}:){2,}(?:[0-9A-Fa-f]{0,4}|[0-9]{1,3}(?:\.[0-9]{1,3}){3})?(?![0-9A-Za-z_.])/g;
const USER_AT_HOST_RE = /(?<![0-9A-Za-z_.+-])([A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+)(?![0-9A-Za-z_.-])/g;
const DEVBOX_ACCOUNT_LITERAL = ["xpeach", "dev"].join("-");
const DEVBOX_ROOT_LITERAL = "/srv/" + DEVBOX_ACCOUNT_LITERAL;
const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g;
const SENSITIVE_ASSIGNMENT_RE = /([A-Za-z0-9_-]*(?:password|passwd|pwd|token|cookie|secret|api[_-]?key|access[_-]?key)[A-Za-z0-9_-]*)\s*[:=]\s*["\']([^"\'\r\n]{4,})["\']/gi;
const ENV_SECRET_ASSIGNMENT_RE = /^\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|COOKIE|SECRET|API_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*([^\s#]+)/;

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
    "Usage: node tools/secret-scan/scan.mjs [--root <repo>] [--format text|json]",
    "",
    "Read-only scanner for repository content. Findings are redacted; only fingerprints are printed."
  ].join("\n"));
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, format: "text", help: false };
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
  const hextets = normalized.match(/[0-9a-f]{1,4}/g) || [];
  return hextets.length >= 2;
}

function readAllowlist(root) {
  const file = path.join(root, "tools", "secret-scan", "allowlist.txt");
  const entries = [];
  if (!fs.existsSync(file)) return entries;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "").trim();
    if (!withoutComment) continue;
    const parts = withoutComment.split(/\s+/);
    if (parts.length < 3) continue;
    const [rule, hash, pathGlob] = parts;
    if (!/^[a-z0-9-]+$/.test(rule) || !/^[0-9a-f]{64}$/.test(hash)) continue;
    entries.push({ rule, hash, pathGlob });
  }
  return entries;
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function allowlistMatches(entries, rule, value, file) {
  const hash = sha256Hex(value);
  return entries.some(entry => entry.rule === rule && entry.hash === hash && pathMatches(entry.pathGlob, file));
}

function fingerprint(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 12) + "/len" + String(value).length;
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

function devboxNeedles() {
  const raw = (process.env.CIS_DEVBOX || "").trim();
  if (!raw) return [];
  const withoutPort = raw.replace(/:\d+$/, "");
  const host = withoutPort.includes("@") ? withoutPort.split("@").pop() : withoutPort;
  const cleanHost = host.replace(/^\[/, "").replace(/\]$/, "");
  return [...new Set([raw, withoutPort, host, cleanHost])].filter(value => value && value.length >= 4);
}

function scanIpLine({ findings, seen, file, lineNumber, line, allowlist }) {
  for (const match of line.matchAll(IPV4_RE)) {
    const ip = match[1];
    if (isNonNetworkDottedQuad(line, ip)) continue;
    if (isDefaultAllowedIp(ip)) continue;
    if (allowlistMatches(allowlist, "ip-literal", ip, file)) continue;
    addFinding(findings, seen, file, lineNumber, "ip-literal", ip);
  }

  for (const match of line.matchAll(IPV6_CANDIDATE_RE)) {
    const ip = match[0];
    if (!isScanworthyIpv6(ip)) continue;
    if (isDefaultAllowedIp(ip)) continue;
    if (allowlistMatches(allowlist, "ip-literal-v6", ip, file)) continue;
    addFinding(findings, seen, file, lineNumber, "ip-literal-v6", ip);
  }

  for (const match of line.matchAll(USER_AT_HOST_RE)) {
    const userAtHost = match[1];
    const user = userAtHost.split("@")[0];
    if (["this", "return", "break", "continue"].includes(user)) continue;
    if (allowlistMatches(allowlist, "user-at-host", userAtHost, file)) continue;
    addFinding(findings, seen, file, lineNumber, "user-at-host", userAtHost);
  }

  if (line.includes(DEVBOX_ACCOUNT_LITERAL)) {
    addFinding(findings, seen, file, lineNumber, "devbox-account-or-path", DEVBOX_ACCOUNT_LITERAL);
  }
  if (line.includes(DEVBOX_ROOT_LITERAL)) {
    addFinding(findings, seen, file, lineNumber, "devbox-account-or-path", DEVBOX_ROOT_LITERAL);
  }

  const matchedDevboxNeedles = devboxNeedles()
    .filter(needle => line.includes(needle))
    .sort((a, b) => b.length - a.length);
  if (matchedDevboxNeedles.length > 0) {
    addFinding(findings, seen, file, lineNumber, "devbox-address", matchedDevboxNeedles[0]);
  }
}

function cleanEnvSecretValue(rawValue) {
  let value = rawValue.trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

function isInsideQuotedText(line, index) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < index; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
    }
  }
  return quote !== null;
}

function isCredentialKey(key) {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  if (/^(password|passwd|pwd|token|cookie|secret|apikey|accesskey|clientsecret|rawtoken|passtoken|servicetoken|sessiontoken|accesstoken|refreshtoken|authtoken)$/.test(normalized)) return true;
  return /(?:password|passwd|accesstoken|refreshtoken|authtoken|clientsecret|apikey|accesskey|rawtoken|passtoken|servicetoken|sessiontoken)$/.test(normalized);
}

function scanSensitiveAssignments({ findings, seen, file, lineNumber, line, allowlist }) {
  const candidates = [];
  for (const match of line.matchAll(SENSITIVE_ASSIGNMENT_RE)) {
    if (isCredentialKey(match[1]) && !isInsideQuotedText(line, match.index)) candidates.push(match[2]);
  }
  const envMatch = line.match(ENV_SECRET_ASSIGNMENT_RE);
  if (envMatch) candidates.push(cleanEnvSecretValue(envMatch[1]));

  for (const value of candidates) {
    if (!value || value.length < 4) continue;
    if (value.startsWith("$")) continue;
    if (value.includes(String.fromCharCode(36, 123))) continue;
    if (allowlistMatches(allowlist, "sensitive-assignment", value, file)) continue;
    addFinding(findings, seen, file, lineNumber, "sensitive-assignment", value);
  }
}

function scanTextFile(root, file, allowlist, findings, seen, warnings) {
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
    warnings.push({ file, warning: "file-over-20MiB-not-content-scanned" });
    return false;
  }
  const buffer = fs.readFileSync(absolute);
  if (isProbablyBinary(buffer)) return false;
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    scanIpLine({ findings, seen, file, lineNumber, line, allowlist });

    for (const match of line.matchAll(PRIVATE_KEY_RE)) {
      addFinding(findings, seen, file, lineNumber, "private-key-header", match[0]);
    }

    for (const rule of TOKEN_RULES) {
      for (const match of line.matchAll(rule.pattern)) {
        if (allowlistMatches(allowlist, rule.id, match[0], file)) continue;
        addFinding(findings, seen, file, lineNumber, rule.id, match[0]);
      }
    }

    scanSensitiveAssignments({ findings, seen, file, lineNumber, line, allowlist });
  }
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
    throw new Error("Not a git worktree: " + root);
  }

  const allowlist = readAllowlist(root);
  const trackedFiles = listTrackedFiles(root);
  const findings = [];
  const warnings = [];
  const seen = new Set();
  let scannedFiles = 0;

  for (const file of trackedFiles) {
    if (isDotEnvName(path.posix.basename(file))) {
      addFinding(findings, seen, file, 0, "dotenv-file", path.posix.basename(file));
    }
    if (scanTextFile(root, file, allowlist, findings, seen, warnings)) scannedFiles += 1;
  }

  for (const file of walkDotEnvFiles(root)) {
    if (isDotEnvName(path.posix.basename(file))) {
      addFinding(findings, seen, file, 0, trackedFiles.includes(file) ? "dotenv-file" : "dotenv-file-untracked", path.posix.basename(file));
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  const result = {
    ok: findings.length === 0,
    root,
    scannedFiles,
    trackedFiles: trackedFiles.length,
    allowlistEntries: allowlist.length,
    findings,
    warnings
  };

  if (options.format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else if (findings.length === 0) {
    console.log("SECRET_SCAN_PASS files=" + scannedFiles + " tracked=" + trackedFiles.length + " findings=0 allowlistEntries=" + allowlist.length + " warnings=" + warnings.length);
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
