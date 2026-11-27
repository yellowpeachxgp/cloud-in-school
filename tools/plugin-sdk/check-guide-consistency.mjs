#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, loadPermissionCatalog } from "../../packages/contracts/src/index.mjs";
import { runtimeHostApiEntry } from "../../packages/plugin-sdk/src/runtime-contract.mjs";

const guidePath = path.join(REPO_ROOT, "docs/PLUGIN_SDK_GUIDE.md");
const guide = fs.readFileSync(guidePath, "utf8");
const failures = [];

function expectContains(text, label) {
  if (!guide.includes(text)) {
    failures.push(`PLUGIN_SDK_GUIDE.md missing ${label}: ${text}`);
  }
}

for (const command of [
  "keygen",
  "init",
  "validate",
  "sign",
  "pack",
  "package",
  "verify",
  "test",
  "simulate",
  "doctor"
]) {
  expectContains("`" + command + "`", `CLI command ${command}`);
}

for (const templateMarker of ["--template card", "--template service", "--template datapack"]) {
  expectContains(templateMarker, "init template documentation " + templateMarker);
}

const hostEntry = runtimeHostApiEntry(2);
for (const slot of hostEntry?.supported_ui_slots || []) {
  expectContains("`" + slot + "`", `runtime UI slot ${slot}`);
}

const catalog = loadPermissionCatalog();
for (const permission of catalog.permissions || []) {
  expectContains("`" + permission.id + "`", `permission ${permission.id}`);
}

for (const boundary of [
  "宿主不会加载或执行",
  "不把尚未完成的契约面或插件能力写成已实现",
  "contracts/fixtures/plugins/",
  "cloud-in-school/contracts 是唯一权威",
  "plugin-signing-private.key",
  "reference_plugins",
  "runtime_validation_code"
]) {
  expectContains(boundary, "honesty boundary");
}

for (const example of ["hello-campus-plugin", "parcel-station-plugin"]) {
  const artifactPath = path.join(REPO_ROOT, "examples", example, "dist/index.mjs");
  const artifact = fs.readFileSync(artifactPath, "utf8");
  if (!artifact.includes("never evaluates plugin artifact code")) {
    failures.push(`${example} artifact does not carry the non-execution warning comment`);
  }
}

if ((hostEntry?.supported_ui_slots || []).length !== 6) {
  failures.push("runtime host_api 2 must expose exactly 6 UI slots");
}

if (failures.length > 0) {
  console.error("[PLUGIN-GUIDE FAIL]");
  for (const failure of failures) console.error("- " + failure);
  process.exit(1);
}

console.log(
  `[PLUGIN-GUIDE PASS] CLI commands, 6 runtime slots, ${(catalog.permissions || []).length} permissions, honesty boundaries, and artifact warnings are documented.`
);
