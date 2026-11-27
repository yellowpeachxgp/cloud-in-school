import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { REPO_ROOT } from "../packages/contracts/src/index.mjs";
import {
  validatePluginManifest,
  loadPluginDirectory
} from "../packages/plugin-sdk/src/index.mjs";
import { validatePluginRuntimeSchema } from "../packages/plugin-sdk/src/runtime-contract.mjs";
import {
  writePluginPackageZip,
  readPluginPackageZip,
  unpackPluginPackage,
  crc32
} from "../packages/plugin-sdk/src/package-zip.mjs";
import { runDisPluginCli } from "../packages/plugin-sdk/src/cli.mjs";

const CLI_PATH = path.join(REPO_ROOT, "packages/plugin-sdk/bin/dis-plugin.mjs");
const RUNTIME_SLOTS = [
  "home.cards",
  "campus.services",
  "library.actions",
  "parcel.cards",
  "parcel.providers",
  "settings.entries"
];

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cliEnv(home) {
  return { ...process.env, DIS_PLUGIN_HOME: home };
}

function runCliOutofProcess(args, home) {
  return execFileSync("node", [CLI_PATH, ...args], {
    encoding: "utf8",
    env: cliEnv(home),
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runCliOutofProcessResult(args, home) {
  try {
    const stdout = runCliOutofProcess(args, home);
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      exitCode: error.status ?? 1,
      stdout: error.stdout?.toString() || "",
      stderr: error.stderr?.toString() || ""
    };
  }
}

async function runCliInProcess(args, home) {
  const out = [];
  const err = [];
  const exitCode = await runDisPluginCli(args, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env: { DIS_PLUGIN_HOME: home }
  });
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n") };
}

function scaffold(template, home, extraArgs = []) {
  const dir = tmpDir("dis-w601b-" + template + "-");
  const result = runCliOutofProcess(
    ["init", dir, "--id", "org.example.ac-" + template, "--template", template, "--keyring", ...extraArgs],
    home
  );
  assert.equal(JSON.parse(result).ok, true);
  return dir;
}

// ---------------------------------------------------------------------------
// keygen
// ---------------------------------------------------------------------------
test("W6-01b keygen: creates keyring keypair with private key outside any project, refuses silent overwrite", async () => {
  const home = tmpDir("dis-w601b-home-");
  const result = await runCliInProcess(["keygen", "--id", "org.example.keygen-case"], home);
  assert.equal(result.exitCode, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.plugin_id, "org.example.keygen-case");
  assert.ok(report.private_key_path.startsWith(path.join(home, "keys")));
  assert.ok(fs.existsSync(report.private_key_path));
  assert.ok(fs.existsSync(report.public_key_path));
  const mode = fs.statSync(report.private_key_path).mode & 0o777;
  assert.equal(mode, 0o600, "private key must be owner-only");

  const second = await runCliInProcess(["keygen", "--id", "org.example.keygen-case"], home);
  assert.notEqual(second.exitCode, 0, "overwrite without --force must fail");
  assert.match(second.stderr, /--force/);

  const rotated = await runCliInProcess(["keygen", "--id", "org.example.keygen-case", "--force"], home);
  assert.equal(rotated.exitCode, 0);
});

// ---------------------------------------------------------------------------
// init templates
// ---------------------------------------------------------------------------
test("W6-01b init: card/service/datapack templates produce valid signed plugins with keyring hygiene", async () => {
  const home = tmpDir("dis-w601b-home-");
  const expectedSlots = { card: "home.cards", service: "campus.services", datapack: "campus.services" };
  for (const template of ["card", "service", "datapack"]) {
    const dir = scaffold(template, home);
    assert.equal(fs.existsSync(path.join(dir, "plugin-signing-private.key")), false, template + ": keyring mode must never write private keys into the project");
    assert.ok(fs.existsSync(path.join(dir, "plugin-signing-public.key")), template);
    const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    assert.ok(gitignore.includes("plugin-signing-private.key"), template + ": .gitignore must cover legacy key file");

    const loaded = loadPluginDirectory(dir);
    assert.deepEqual(validatePluginRuntimeSchema(loaded.manifest), [], template + ": schema clean");
    const normalized = validatePluginManifest(loaded.manifest);
    assert.equal(normalized.plugin_id, "org.example.ac-" + template);
    assert.equal(normalized.ui_slots[0].slot_id, expectedSlots[template]);
    assert.ok(normalized.signature?.value_base64, template + ": manifest is signed at init time");

    const verify = await runCliInProcess(["verify", dir], home);
    assert.equal(verify.exitCode, 0, template + ": verify passes via keyring resolution");
    assert.equal(JSON.parse(verify.stdout).key_source, "keyring");
  }
});

test("W6-01b init legacy default: unchanged W6-00 layout (in-dir keys, campus.services ping)", async () => {
  const home = tmpDir("dis-w601b-home-");
  const dir = tmpDir("dis-w601b-legacy-");
  const out = JSON.parse(runCliOutofProcess(["init", dir, "--id", "org.example.legacy-compat"], home));
  assert.equal(out.template, "legacy");
  assert.equal(out.key_source, "legacy-in-dir");
  assert.ok(fs.existsSync(path.join(dir, "plugin-signing-private.key")), "legacy mode keeps in-dir private key for compatibility");
  const loaded = loadPluginDirectory(dir);
  const normalized = validatePluginManifest(loaded.manifest);
  assert.equal(normalized.ui_slots[0].slot_id, "campus.services");
  assert.equal(normalized.commands[0].name, "ping");
  const verify = await runCliInProcess(["verify", dir], home);
  assert.equal(JSON.parse(verify.stdout).key_source, "legacy-in-dir");
});

// ---------------------------------------------------------------------------
// AC-41: simulate offline for all three templates, error cases exit non-zero
// ---------------------------------------------------------------------------
test("W6-01b AC-41: simulate runs offline for card/service/datapack, emits all 6 slot maps and command results", async () => {
  const home = tmpDir("dis-w601b-home-");
  const expectedSlots = { card: "home.cards", service: "campus.services", datapack: "campus.services" };
  for (const template of ["card", "service", "datapack"]) {
    const dir = scaffold(template, home);
    const result = runCliOutofProcessResult(["simulate", dir], home);
    assert.equal(result.exitCode, 0, template + ": simulate exit 0; stderr=" + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(Object.keys(report.slots).sort(), [...RUNTIME_SLOTS].sort(), template + ": all 6 slots reported");
    const own = report.slots[expectedSlots[template]];
    assert.equal(own.length, 1, template + ": descriptor present in its slot");
    assert.equal(own[0].plugin_id, "org.example.ac-" + template);
    assert.ok(Array.isArray(report.commands) && report.commands.length >= 1);
    assert.equal(report.commands[0].executed, true, template + ": declarative command executes in simulation");
    assert.equal(report.mock_school_context.data_provenance, "SIMULATED_HOST_MOCK");
  }
});

test("W6-01b AC-41 negative: unknown permission makes simulate exit non-zero with an error code", async () => {
  const home = tmpDir("dis-w601b-home-");
  const dir = scaffold("card", home);
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.permissions = ["ui.slot.render", "evil.permission"];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const result = runCliOutofProcessResult(["simulate", dir], home);
  assert.notEqual(result.exitCode, 0, "simulate must fail for an invalid manifest");
  const errorReport = JSON.parse(result.stderr);
  assert.equal(errorReport.ok, false);
  assert.ok(errorReport.code, "an error code is reported");
  assert.equal(errorReport.runtime_validation_code, "runtime_permission_unknown");
});

test("W6-01b AC-41 negative: tampered artifact bytes break signature/digest verification in simulate", async () => {
  const home = tmpDir("dis-w601b-home-");
  const dir = scaffold("card", home);
  const artifactPath = path.join(dir, "assets/card-data.json");
  fs.writeFileSync(artifactPath, fs.readFileSync(artifactPath, "utf8") + " ", "utf8");
  const result = runCliOutofProcessResult(["simulate", dir], home);
  assert.notEqual(result.exitCode, 0);
  const errorReport = JSON.parse(result.stderr);
  assert.equal(errorReport.code, "PLUGIN_SIGNATURE_INVALID");
});

// ---------------------------------------------------------------------------
// pack + zip format
// ---------------------------------------------------------------------------
test("W6-01b pack: deterministic bytes, closed-world entries, round-trip equality", async () => {
  const home = tmpDir("dis-w601b-home-");
  const dir = scaffold("datapack", home);
  const out1 = path.join(dir, "p1.zip");
  const out2 = path.join(dir, "p2.zip");
  const pack1 = JSON.parse(runCliOutofProcess(["pack", dir, "--out", out1], home));
  const pack2 = JSON.parse(runCliOutofProcess(["pack", dir, "--out", out2], home));
  assert.equal(pack1.zip_sha256, pack2.zip_sha256, "pack must be byte-reproducible");
  assert.ok(pack1.entries.includes("manifest.json"));
  assert.ok(pack1.entries.includes("plugin-signing-public.key"));
  assert.ok(pack1.entries.includes("assets/dataset.json"));

  const unpacked = unpackPluginPackage(fs.readFileSync(out1));
  const onDisk = loadPluginDirectory(dir);
  assert.deepEqual(unpacked.manifest, validatePluginManifest(onDisk.manifest));
  for (const [artifactPath, content] of Object.entries(onDisk.artifactMap)) {
    assert.ok(unpacked.artifactMap[artifactPath].equals(content), artifactPath + " round-trips byte-identically");
  }
  assert.ok(unpacked.publicKeyBase64, "public key is embedded for transport");
});

test("W6-01b pack negative: unsigned manifests are refused", async () => {
  const home = tmpDir("dis-w601b-home-");
  const dir = scaffold("card", home);
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  delete manifest.signature;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const result = runCliOutofProcessResult(["pack", dir], home);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /sign/);
});

test("W6-01b zip reader: rejects zip-slip, tampered CRC, and local/central name mismatch", async () => {
  // Writer-side rejection of unsafe paths
  assert.throws(() => writePluginPackageZip([["../evil.json", Buffer.from("x")]]), /unsafe|zip-slip|escapes/i);

  // Reader-side: patch a valid archive so "dist/index.mjs" becomes "..st/index.mjs"
  const artifact = Buffer.from("export const x = 1;\n", "utf8");
  const good = writePluginPackageZip([
    ["manifest.json", Buffer.from("{}", "utf8")],
    ["dist/index.mjs", artifact]
  ]);
  const evil = Buffer.from(good);
  const needle = Buffer.from("dist/index.mjs", "utf8");
  let idx = evil.indexOf(needle);
  assert.ok(idx > 0);
  while (idx !== -1) {
    evil[idx] = 0x2e; // '.'
    evil[idx + 1] = 0x2e; // '.'
    idx = evil.indexOf(needle, idx + 1);
  }
  assert.throws(() => readPluginPackageZip(evil), /zip-slip|unsafe|rejected|escapes/i);

  // CRC tampering: entries are sorted, so dist/index.mjs is the first entry.
  // local header layout: 30 bytes fixed + len("dist/index.mjs")=14 => data starts at 44.
  const crcTampered = Buffer.from(good);
  crcTampered[44 + 2] = crcTampered[44 + 2] ^ 0xff;
  assert.throws(() => readPluginPackageZip(crcTampered), /CRC|corrupt|mismatch|invalid|incorrect/i);

  assert.equal(typeof crc32(Buffer.from("abc")), "number");
});

test("W6-01b pack negative: digest drift inside repacked archive is detected at unpack", async () => {
  const home = tmpDir("dis-w601b-home-");
  const dir = scaffold("card", home);
  const zipOut = path.join(dir, "ok.zip");
  JSON.parse(runCliOutofProcess(["pack", dir, "--out", zipOut], home));
  const unpacked = unpackPluginPackage(fs.readFileSync(zipOut));
  // repack with mutated artifact but the original (stale) manifest
  const entries = [["manifest.json", Buffer.from(JSON.stringify(unpacked.manifest), "utf8")]];
  for (const [artifactPath, content] of Object.entries(unpacked.artifactMap)) {
    entries.push([artifactPath, artifactPath.endsWith("card-data.json") ? Buffer.concat([content, Buffer.from(" ")]) : content]);
  }
  const evilZip = writePluginPackageZip(entries);
  assert.throws(() => unpackPluginPackage(evilZip), /digest mismatch/i);
});

// ---------------------------------------------------------------------------
// AC-42 cloud end: pack zip installs through the real host API
// ---------------------------------------------------------------------------
test("W6-01b AC-42 cloud: pack zip installs through the running host with zero host modification", async () => {
  const home = tmpDir("dis-w601b-home-");
  const dir = scaffold("service", home);
  const zipOut = path.join(dir, "service.zip");
  JSON.parse(runCliOutofProcess(["pack", dir, "--out", zipOut], home));

  const unpacked = unpackPluginPackage(fs.readFileSync(zipOut));
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "w601b_pack_installer",
    displayName: "Pack Installer"
  });
  const session = app.identity.issueDeviceSession(user, "Android");
  const headers = { authorization: "Bearer " + session.access_token };

  const artifactMap = {};
  for (const [artifactPath, content] of Object.entries(unpacked.artifactMap)) {
    artifactMap[artifactPath] = content.toString("utf8");
  }
  const installRes = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/install",
    headers,
    body: {
      manifest: unpacked.manifest,
      artifact_map: artifactMap,
      public_key_base64: unpacked.publicKeyBase64
    }
  });
  assert.equal(installRes.status, 201, JSON.stringify(installRes.body));
  assert.equal(installRes.body.data.active_version, "1.0.0");

  const slots = app.pluginBroker.getResolvedUiSlotDescriptors(user.id, "campus.services");
  assert.ok(slots.some((s) => s.plugin_id === "org.example.ac-service"));

  const invokeRes = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.ac-service/commands/openService/invoke",
    headers,
    body: { payload: { probe: true } }
  });
  assert.equal(invokeRes.status, 200);
  assert.equal(invokeRes.body.data.executed, true);

  const uninstall = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.ac-service/lifecycle",
    headers,
    body: { action: "UNINSTALL" }
  });
  assert.equal(uninstall.status, 200);
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
test("W6-01b doctor: healthy keyring project is fully green; defects map to stable check ids", async () => {
  const home = tmpDir("dis-w601b-home-");
  const dir = scaffold("card", home);
  const healthy = runCliOutofProcessResult(["doctor", dir], home);
  assert.equal(healthy.exitCode, 0, healthy.stderr);
  const report = JSON.parse(healthy.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.summary.fail, 0);
  const ids = report.checks.map((c) => c.id);
  for (const required of [
    "manifest.parse",
    "manifest.schema",
    "manifest.semantics",
    "host_api.compatibility",
    "artifacts.present",
    "artifacts.digest",
    "signature.verify",
    "hygiene.private_key",
    "hygiene.gitignore",
    "pack.readiness"
  ]) {
    assert.ok(ids.includes(required), "doctor reports " + required);
  }
  assert.equal(report.checks.find((c) => c.id === "hygiene.private_key").status, "PASS");

  // missing artifact -> artifacts.present FAIL, exit 1
  fs.rmSync(path.join(dir, "assets/card-data.json"));
  const broken = runCliOutofProcessResult(["doctor", dir], home);
  assert.notEqual(broken.exitCode, 0);
  const brokenReport = JSON.parse(broken.stdout);
  assert.equal(brokenReport.checks.find((c) => c.id === "artifacts.present").status, "FAIL");
});

test("W6-01b doctor: legacy in-dir private key surfaces as WARN, not FAIL", async () => {
  const home = tmpDir("dis-w601b-home-");
  const dir = tmpDir("dis-w601b-legacy-doc-");
  JSON.parse(runCliOutofProcess(["init", dir, "--id", "org.example.legacy-doctor"], home));
  const result = runCliOutofProcessResult(["doctor", dir], home);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.find((c) => c.id === "hygiene.private_key").status, "WARN");
  assert.equal(report.summary.fail, 0, "warnings alone never fail doctor");
});

// ---------------------------------------------------------------------------
// AC-43: the documented zero-to-publish tutorial reproduces out-of-process
// ---------------------------------------------------------------------------
test("W6-01b AC-43: zero-to-publish tutorial steps run end-to-end in a clean directory", async () => {
  const home = tmpDir("dis-w601b-home-");
  const work = tmpDir("dis-w601b-tutorial-");
  const projectDir = path.join(work, "my-campus-card");
  const pluginId = "org.example.tutorial-card";

  // The exact command sequence documented in docs/PLUGIN_SDK_GUIDE.md.
  const steps = [
    ["keygen", "--id", pluginId],
    ["init", projectDir, "--id", pluginId, "--template", "card", "--keyring"],
    ["validate", projectDir],
    ["simulate", projectDir],
    ["doctor", projectDir],
    ["sign", projectDir],
    ["pack", projectDir],
    ["verify", path.join(projectDir, pluginId + "-1.0.0.zip")]
  ];
  for (const step of steps) {
    const result = runCliOutofProcessResult(step, home);
    assert.equal(result.exitCode, 0, "tutorial step fails: " + step.join(" ") + "\nstderr: " + result.stderr);
    const firstLine = result.stdout.trim().split("\n")[0] || "{}";
    assert.equal(JSON.parse(firstLine).ok, true, step[0] + " reports ok");
  }

  // guide consistency: every tutorial verb is documented in the guide
  const guide = fs.readFileSync(path.join(REPO_ROOT, "docs/PLUGIN_SDK_GUIDE.md"), "utf8");
  for (const verb of ["keygen", "init", "validate", "simulate", "doctor", "sign", "pack", "verify"]) {
    assert.ok(guide.includes("dis-plugin " + verb), "guide documents dis-plugin " + verb);
  }
});
