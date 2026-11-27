import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { REPO_ROOT } from "../packages/contracts/src/index.mjs";

test("AC-04/S5: fresh app loads both signed reference plugins and /api/v1/features reports them", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const availableIds = app.pluginBroker.listAvailablePlugins().map((plugin) => plugin.plugin_id);
  assert.ok(availableIds.includes("org.example.hello-campus"));
  assert.ok(availableIds.includes("org.example.parcel-station"));

  const response = await app.inject({ method: "GET", url: "/api/v1/features" });
  assert.equal(response.status, 200);
  const reference = response.body.data.reference_plugins;
  assert.equal(reference.status, "OK");
  assert.equal(reference.expected_count, 2);
  assert.equal(reference.loaded_count, 2);
  assert.equal(reference.failed_count, 0);
  assert.deepEqual(
    reference.plugins.map((plugin) => [plugin.plugin_id, plugin.status]),
    [
      ["org.example.hello-campus", "LOADED"],
      ["org.example.parcel-station", "LOADED"]
    ]
  );

  // The documented reference commands remain useful through host-owned
  // implementations; the signed artifact bytes are verified but never evaluated.
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "reference_plugin_command_user",
    displayName: "Reference Plugin Tester"
  });
  app.pluginBroker.installPluginForUser(user.id, "org.example.hello-campus");
  app.pluginBroker.installPluginForUser(user.id, "org.example.parcel-station");
  const greeting = await app.pluginBroker.invokePluginCommand({
    userId: user.id,
    pluginId: "org.example.hello-campus",
    commandName: "greetCampus",
    payload: {}
  });
  assert.equal(greeting.output.campus, "莲花街校区");
  const station = await app.pluginBroker.invokePluginCommand({
    userId: user.id,
    pluginId: "org.example.parcel-station",
    commandName: "queryStationHours",
    payload: {}
  });
  assert.equal(station.output.open_hours, "08:30 - 21:00");
});

test("AC-04/S5: missing reference public key is logged and reported by /api/v1/features", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-missing-plugin-key-"));
  try {
    fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
    const sourceDir = path.join(REPO_ROOT, "examples/hello-campus-plugin");
    fs.copyFileSync(path.join(sourceDir, "manifest.json"), path.join(tmpDir, "manifest.json"));
    fs.copyFileSync(path.join(sourceDir, "dist/index.mjs"), path.join(tmpDir, "dist/index.mjs"));

    const warnings = [];
    const app = createCampusCloudApp({
      requireAdminAccess: false,
      referencePluginSources: [
        {
          pluginId: "org.example.hello-campus",
          dir: tmpDir,
          commandHandlers: {}
        }
      ],
      referencePluginLogger: { warn: (message) => warnings.push(String(message)) }
    });

    assert.equal(app.pluginBroker.listAvailablePlugins().length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /org.example.hello-campus/);
    assert.match(warnings[0], /load failed/);

    const response = await app.inject({ method: "GET", url: "/api/v1/features" });
    assert.equal(response.status, 200);
    const reference = response.body.data.reference_plugins;
    assert.equal(reference.status, "DEGRADED");
    assert.equal(reference.loaded_count, 0);
    assert.equal(reference.failed_count, 1);
    assert.equal(reference.plugins[0].plugin_id, "org.example.hello-campus");
    assert.equal(reference.plugins[0].status, "FAILED");
    assert.equal(reference.plugins[0].error_code, "ENOENT");
    assert.equal(reference.plugins[0].error_message, "required reference plugin file is missing");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AC-04/S5: gitignore admits exactly the two reference public keys and never private keys", () => {
  const ignoreLines = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8").split(/\r?\n/);
  const denyKeyIndex = ignoreLines.indexOf("*.key");
  const allowPublicIndex = ignoreLines.indexOf("!examples/**/plugin-signing-public.key");
  assert.ok(denyKeyIndex >= 0, "*.key private-key denial rule must exist");
  assert.ok(allowPublicIndex > denyKeyIndex, "public-key exception must come after *.key");
  assert.equal(ignoreLines.includes("!examples/**/plugin-signing-private.key"), false);
  assert.deepEqual(
    ignoreLines.filter((line) => line.startsWith("!examples/**/") && line.endsWith(".key")),
    ["!examples/**/plugin-signing-public.key"],
    "only the exact public-key filename may be unignored"
  );

  const tracked = execFileSync("git", ["ls-files", "examples"], {
    cwd: REPO_ROOT,
    encoding: "utf8"
  })
    .split(/\r?\n/)
    .filter(Boolean);
  const trackedKeys = tracked.filter((file) => file.endsWith(".key")).sort();
  assert.deepEqual(trackedKeys, [
    "examples/hello-campus-plugin/plugin-signing-public.key",
    "examples/parcel-station-plugin/plugin-signing-public.key"
  ]);
  assert.equal(tracked.some((file) => file.includes("plugin-signing-private.key")), false);
});
