#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCAN = path.join(SCRIPT_DIR, "scan.mjs");

const join = (...parts) => parts.join("");
const dollar = String.fromCharCode(36);
const braceOpen = String.fromCharCode(123);
const braceClose = String.fromCharCode(125);
const template = name => dollar + braceOpen + name + braceClose;

const synthetic = {
  jsonPassword: join("json-", "secret-", "1234"),
  jsonApiKey: join("json-", "api-", "key-1234"),
  yamlPassword: join("yaml-", "secret-", "1234"),
  yamlApiKey: join("yaml-", "api-", "key-1234"),
  yamlQuotedPassword: join("yaml-", "quoted-", "secret-1234"),
  lowerEnvPassword: join("lower-", "env-", "secret-123"),
  upperApiKey: join("upper-", "api-", "key-123"),
  lowerSessionToken: join("lower-", "session-", "token-123"),
  bearerToken: join("abcdef", "1234567890", "abcdef"),
  pgpHeader: join("-----BEGIN ", "PGP PRIVATE ", "KEY BLOCK-----"),
  pemHeader: join("-----BEGIN ", "PRIVATE KEY-----"),
  argExtra: join("runtime-", "arg-", "extra-value"),
  envExtra: join("runtime-", "env-", "extra-value")
};

function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
}

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "ignore", "pipe"] });
}

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cis-secret-scan-selftest-"));
  writeFiles(root, {
    "tools/secret-scan/allowlist.txt": "",
    ...files
  });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "selftest@localhost"]);
  git(root, ["config", "user.name", "secret-scan-selftest"]);
  git(root, ["add", "."]);
  return root;
}

function runScan(root, extraArgs, extraEnv) {
  const args = [SCAN, "--root", root, "--format", "json", ...extraArgs];
  const options = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv }
  };
  try {
    const stdout = execFileSync(process.execPath, args, options);
    return { rc: 0, result: JSON.parse(stdout), stderr: "" };
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : "";
    let result = null;
    try {
      result = JSON.parse(stdout);
    } catch {
      // Keep null and report below.
    }
    return { rc: error.status ?? 2, result, stderr: error.stderr ? String(error.stderr) : "", stdout };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error("SECRET_SCAN_SELFTEST_FAIL " + message);
}

function ruleCounts(result) {
  const counts = new Map();
  for (const finding of result.findings) counts.set(finding.rule, (counts.get(finding.rule) || 0) + 1);
  return counts;
}

const positiveRoot = makeRepo({
  "config.json": "{\"password\":\"" + synthetic.jsonPassword + "\",\"nested\":{\"apiKey\":\"" + synthetic.jsonApiKey + "\"}}\n",
  "config.yaml": [
    "password: " + synthetic.yamlPassword,
    "apiKey: " + synthetic.yamlApiKey,
    "quoted_password: \"" + synthetic.yamlQuotedPassword + "\"",
    ""
  ].join("\n"),
  "shell.sh": [
    "password=" + synthetic.lowerEnvPassword,
    "API_KEY=" + synthetic.upperApiKey,
    "export session_token=" + synthetic.lowerSessionToken,
    ""
  ].join("\n"),
  "http.txt": "Authorization: Bearer " + synthetic.bearerToken + "\n",
  "pgp.asc": synthetic.pgpHeader + "\n",
  "pem.key": synthetic.pemHeader + "\n",
  "extra-arg.txt": "literal=" + synthetic.argExtra + "\n",
  "extra-env.txt": "literal=" + synthetic.envExtra + "\n"
});

const negativeRoot = makeRepo({
  "config.json": "{\"password\":\"" + template("JSON_PASSWORD") + "\"}\n",
  "config.yaml": "password: <yaml-password>\n",
  "shell.sh": [
    "password=" + dollar + "PASSWORD_VALUE",
    "api_key=" + template("API_KEY_VALUE"),
    ""
  ].join("\n"),
  "http.txt": "Authorization: Bearer " + template("TOKEN_VALUE") + "\n",
  "code.js": "const matchedToken = \"abcdef123456\";\n",
  ".env.example": "PASSWORD=<example-password>\n",
  "note.txt": "password and token fields are documented here without assignment. Local worktree /Volumes/example/campus-worktrees/repo/branch is allowed.\n"
});

try {
  const positive = runScan(positiveRoot, ["--extra-literal", synthetic.argExtra], {
    CIS_SECRET_SCAN_EXTRA_LITERALS: synthetic.envExtra
  });
  assert(positive.rc === 1 && positive.result, "positive fixture should exit 1 with JSON findings; rc=" + positive.rc + " stderr=" + positive.stderr);
  const counts = ruleCounts(positive.result);
  assert((counts.get("sensitive-assignment") || 0) >= 8, "quoted/unquoted JSON/YAML and lowercase/uppercase env assignments not fully detected; got " + (counts.get("sensitive-assignment") || 0));
  assert((counts.get("authorization-bearer") || 0) === 1, "Authorization Bearer value not detected");
  assert((counts.get("pgp-private-key-header") || 0) === 1, "PGP private key header not detected");
  assert((counts.get("private-key-header") || 0) === 1, "PEM private key header not detected");
  assert((counts.get("extra-literal") || 0) === 2, "argument and environment supplied extra literals not detected; got " + (counts.get("extra-literal") || 0));

  const negative = runScan(negativeRoot, [], {});
  assert(negative.rc === 0 && negative.result, "negative fixture should exit 0 with JSON result; rc=" + negative.rc + " stderr=" + negative.stderr);
  assert(negative.result.findings.length === 0, "negative fixture should have zero findings, got " + negative.result.findings.length);

  console.log("SECRET_SCAN_SELFTEST_PASS positiveFindings=" + positive.result.findings.length + " negativeFindings=0");
} finally {
  fs.rmSync(positiveRoot, { recursive: true, force: true });
  fs.rmSync(negativeRoot, { recursive: true, force: true });
}
