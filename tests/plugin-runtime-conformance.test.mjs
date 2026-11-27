import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "../packages/contracts/src/index.mjs";
import {
  SUPPORTED_UI_SLOTS,
  loadPluginDirectory,
  validatePluginManifest
} from "../packages/plugin-sdk/src/index.mjs";
import {
  runtimeHostApiEntry,
  validatePluginRuntimeSchema
} from "../packages/plugin-sdk/src/runtime-contract.mjs";

const FIXTURE_DIR = path.join(
  REPO_ROOT,
  "packages/plugin-sdk/test-fixtures/runtime-plugin-manifests"
);

function fixtureExpectation(fileName) {
  if (fileName.startsWith("valid-")) return { valid: true, code: null };
  const match = fileName.match(/^invalid-(runtime_[a-z_]+)-/);
  assert.ok(match, `fixture name does not encode a runtime validation code: ${fileName}`);
  return { valid: false, code: match[1] };
}

function fixtureFiles() {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function readFixtureText(fileName) {
  return fs.readFileSync(path.join(FIXTURE_DIR, fileName), "utf8");
}

test("W6-00 runtime fixtures: SDK conclusions and canonical validation codes are stable", () => {
  const files = fixtureFiles();
  assert.ok(files.length >= 30, `expected at least 30 runtime fixtures, found ${files.length}`);
  assert.ok(files.some((name) => name.startsWith("valid-")), "valid fixtures must exist");
  assert.ok(files.some((name) => name.startsWith("invalid-")), "invalid fixtures must exist");

  for (const fileName of files) {
    const expected = fixtureExpectation(fileName);
    const manifestText = readFixtureText(fileName);
    if (expected.valid) {
      const normalized = validatePluginManifest(manifestText);
      assert.equal(normalized.plugin_id, "org.example.runtime-fixture", fileName);
      continue;
    }

    let thrown = null;
    try {
      validatePluginManifest(manifestText);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, `${fileName} must be rejected`);
    assert.equal(
      thrown.detail?.runtime_validation_code,
      expected.code,
      `${fileName}: expected ${expected.code}, got ${thrown.detail?.runtime_validation_code} (${thrown.message})`
    );
  }
});

test("W6-00 parity gaps: legacy enum, ECMAScript whitespace, integer caps, and strict lexical JSON", () => {
  const legacy = validatePluginManifest(readFixtureText("valid-legacy-schema-version.json"));
  assert.equal(legacy.legacy_schema_version, "dis-campus-plugin/v1");

  const padded = validatePluginManifest(readFixtureText("valid-display-strings-padded-nonblank.json"));
  assert.equal(padded.name, "  Runtime Fixture Plugin  ");
  assert.equal(padded.ui_slots[0].title, "  Runtime Fixture Card  ");

  const controlWhitespaceName = validatePluginManifest(readFixtureText("valid-ecma-whitespace-u001e-name.json"));
  assert.equal(controlWhitespaceName.name, "\u001e");
  const hostBoundary = validatePluginManifest(readFixtureText("valid-host-api-int32-max.json"));
  assert.equal(hostBoundary.max_host_api, 2147483647);
  const sizeBoundary = validatePluginManifest(readFixtureText("valid-size-bytes-int32-max.json"));
  assert.equal(sizeBoundary.entry_artifacts[0].size_bytes, 2147483647);

  for (const fileName of [
    "invalid-runtime_schema_invalid-invalid-legacy-schema-version.json",
    "invalid-runtime_schema_invalid-blank-name.json",
    "invalid-runtime_schema_invalid-blank-ui-slot-title.json",
    "invalid-runtime_schema_invalid-decimal-integer-min-host-api.json",
    "invalid-runtime_schema_invalid-ecma-whitespace-feff-name.json",
    "invalid-runtime_schema_invalid-host-api-int32-overflow.json",
    "invalid-runtime_schema_invalid-size-bytes-int32-overflow.json",
    "invalid-runtime_schema_invalid-duplicate-top-level-key.json",
    "invalid-runtime_schema_invalid-overlong-number-literal.json",
    "invalid-runtime_schema_invalid-unknown-top-level-field.json",
    "invalid-runtime_schema_invalid-ui-slot-extra-field.json",
    "invalid-runtime_schema_invalid-command-extra-field.json",
    "invalid-runtime_signature_invalid-signature-extra-field.json"
  ]) {
    assert.throws(
      () => validatePluginManifest(readFixtureText(fileName)),
      (error) => error?.detail?.runtime_validation_code === "runtime_schema_invalid",
      fileName + " must fail with runtime_schema_invalid"
    );
  }
});

test("W6-00 runtime host matrix: SDK slot list is exactly the runtime host_api 2 slot list", () => {
  const hostEntry = runtimeHostApiEntry(2);
  assert.ok(hostEntry, "runtime host_api 2 entry must exist");
  assert.equal(hostEntry.format, "dis-extension/v2");
  assert.equal(hostEntry.dynamic_code_loading_allowed, false);
  assert.deepEqual([...SUPPORTED_UI_SLOTS], hostEntry.supported_ui_slots);
  assert.deepEqual(hostEntry.supported_ui_slots, [
    "home.cards",
    "campus.services",
    "library.actions",
    "parcel.cards",
    "parcel.providers",
    "settings.entries"
  ]);
});

test("W6-01a contract debt: transitional runtime surfaces are explicitly registered outside contracts", () => {
  const registryPath = path.join(REPO_ROOT, "packages/plugin-sdk/runtime/contract-debt.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  assert.match(registry.authority_notice, /not a contract/);
  assert.match(registry.authority_notice, /cloud-in-school\/contracts/);
  const byId = new Map((registry.debts || []).map((debt) => [debt.id, debt]));
  for (const id of [
    "PLUGIN_RUNTIME_SCHEMA_TRANSITION",
    "PLUGIN_RUNTIME_HOST_MATRIX_TRANSITION",
    "PLUGIN_RUNTIME_FIXTURES_OUTSIDE_CONTRACTS",
    "PLUGIN_LIFECYCLE_SECURITY_RUNTIME_EXTENSION"
  ]) {
    assert.ok(byId.has(id), "missing contract debt entry " + id);
    assert.equal(byId.get(id).status, "OPEN_CONTRACT_DEBT");
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, byId.get(id).runtime_fact_source)),
      "runtime fact source must exist for " + id
    );
  }
  assert.deepEqual(
    byId.get("PLUGIN_RUNTIME_SCHEMA_TRANSITION").unregistered_runtime_fields,
    ["type", "route", "url", "artifact_path"],
    "declarative command runtime fields must be itemized rather than silently treated as contract-registered"
  );
});

test("W6-00 examples: both signed reference manifests pass the transitional runtime schema", () => {
  for (const dirName of ["hello-campus-plugin", "parcel-station-plugin"]) {
    const loaded = loadPluginDirectory(path.join(REPO_ROOT, "examples", dirName));
    assert.deepEqual(validatePluginRuntimeSchema(loaded.manifest), [], dirName);
    const normalized = validatePluginManifest(loaded.manifest);
    assert.equal(normalized.schema_version, "dis-extension/v2");
  }
});

test("W6-00 honest guide: documented CLI, slots, permissions, and boundaries match runtime facts", () => {
  const scriptPath = path.join(REPO_ROOT, "tools/plugin-sdk/check-guide-consistency.mjs");
  const output = execFileSync("node", [scriptPath], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.match(output, /PLUGIN-GUIDE PASS/);
});

test("W6-00 CLI init: generated manifest passes the transitional runtime schema and semantic validation", async (t) => {
  const os = await import("node:os");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-w600-cli-init-"));
  try {
    const cliPath = path.join(REPO_ROOT, "packages/plugin-sdk/bin/dis-plugin.mjs");
    const keyHome = fs.mkdtempSync(path.join(os.tmpdir(), "dis-w600-keys-"));
    try {
      execFileSync("node", [cliPath, "init", tmpDir, "--id", "org.example.w600-runtime"], {
        stdio: "pipe",
        env: { ...process.env, DIS_PLUGIN_KEY_HOME: keyHome }
      });
    } finally {
      fs.rmSync(keyHome, { recursive: true, force: true });
    }
    const loaded = loadPluginDirectory(tmpDir);
    assert.deepEqual(validatePluginRuntimeSchema(loaded.manifest), []);
    const normalized = validatePluginManifest(loaded.manifest);
    assert.equal(normalized.plugin_id, "org.example.w600-runtime");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
