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

test("W6-00 runtime fixtures: SDK conclusions and canonical validation codes are stable", () => {
  const files = fixtureFiles();
  assert.ok(files.length >= 30, `expected at least 30 runtime fixtures, found ${files.length}`);
  assert.ok(files.some((name) => name.startsWith("valid-")), "valid fixtures must exist");
  assert.ok(files.some((name) => name.startsWith("invalid-")), "invalid fixtures must exist");

  for (const fileName of files) {
    const expected = fixtureExpectation(fileName);
    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, fileName), "utf8"));
    if (expected.valid) {
      const normalized = validatePluginManifest(manifest);
      assert.equal(normalized.plugin_id, manifest.plugin_id, fileName);
      continue;
    }

    let thrown = null;
    try {
      validatePluginManifest(manifest);
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
