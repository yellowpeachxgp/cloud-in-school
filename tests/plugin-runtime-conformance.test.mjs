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

const FIXTURE_ROOT = path.join(REPO_ROOT, "contracts/fixtures/plugins");
const FIXTURE_GROUPS = ["valid", "invalid"];

function fixtureExpectation(fileName) {
  if (fileName.startsWith("valid-")) return { valid: true, code: null };
  const match = fileName.match(/^invalid-(runtime_[a-z_]+)-/);
  assert.ok(match, `fixture name does not encode a runtime validation code: ${fileName}`);
  return { valid: false, code: match[1] };
}

function fixtureFiles() {
  return FIXTURE_GROUPS.flatMap((group) =>
    fs
      .readdirSync(path.join(FIXTURE_ROOT, group))
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ group, name }))
  ).sort((a, b) => a.name.localeCompare(b.name));
}

function readFixtureText(fileName) {
  for (const group of FIXTURE_GROUPS) {
    const candidate = path.join(FIXTURE_ROOT, group, fileName);
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
  }
  throw new Error("shared contract fixture is missing: " + fileName);
}

function contractHostApi2Slots() {
  const matrixText = fs.readFileSync(
    path.join(REPO_ROOT, "contracts/compatibility/host-api-matrix.yaml"),
    "utf8"
  );
  const host2 = matrixText.split("  - host_api: 2\n")[1];
  if (!host2) throw new Error("contract host-api matrix is missing host_api 2");
  const slotSection = host2.split("    supported_ui_slots:\n")[1] || "";
  return slotSection
    .split(/\r?\n/)
    .filter((line) => line.startsWith("      - "))
    .map((line) => line.slice("      - ".length).trim());
}

test("W6 contract fixtures: SDK conclusions and canonical validation codes are stable", () => {
  const files = fixtureFiles();
  assert.equal(files.length, 58, `expected exactly 58 shared contract fixtures, found ${files.length}`);
  assert.ok(files.some((file) => file.group === "valid"), "valid fixtures must exist");
  assert.ok(files.some((file) => file.group === "invalid"), "invalid fixtures must exist");

  for (const file of files) {
    const fileName = file.name;
    assert.equal(file.group, fileName.startsWith("valid-") ? "valid" : "invalid", fileName + " must be in the directory matching its name");
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
    "invalid-runtime_schema_invalid-overlong-number-literal.json"
  ]) {
    assert.throws(
      () => validatePluginManifest(readFixtureText(fileName)),
      (error) => error?.detail?.runtime_validation_code === "runtime_schema_invalid",
      fileName + " must fail with runtime_schema_invalid"
    );
  }
});

test("W6 contract host matrix: SDK slot list exactly follows authoritative host_api 2", () => {
  const hostEntry = runtimeHostApiEntry(2);
  assert.ok(hostEntry, "runtime host_api 2 entry must exist");
  assert.equal(hostEntry.format, "dis-extension/v2");
  assert.equal(hostEntry.dynamic_code_loading_allowed, false);
  assert.deepEqual([...SUPPORTED_UI_SLOTS], hostEntry.supported_ui_slots);
  assert.deepEqual(hostEntry.supported_ui_slots, contractHostApi2Slots());
  assert.deepEqual(hostEntry.supported_ui_slots, [
    "home.cards",
    "campus.services",
    "library.actions",
    "parcel.cards",
    "parcel.providers",
    "settings.entries"
  ]);
});

test("W6 contract schema: both signed reference manifests pass the authoritative schema", () => {
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

test("W6 contract schema: CLI init generated manifest passes authoritative schema and semantic validation", async (t) => {
  const os = await import("node:os");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-w600-cli-init-"));
  try {
    const cliPath = path.join(REPO_ROOT, "packages/plugin-sdk/bin/dis-plugin.mjs");
    execFileSync("node", [cliPath, "init", tmpDir, "--id", "org.example.w600-runtime"], {
      stdio: "pipe"
    });
    const loaded = loadPluginDirectory(tmpDir);
    assert.deepEqual(validatePluginRuntimeSchema(loaded.manifest), []);
    const normalized = validatePluginManifest(loaded.manifest);
    assert.equal(normalized.plugin_id, "org.example.w600-runtime");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
