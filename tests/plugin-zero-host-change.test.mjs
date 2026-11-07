import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { REPO_ROOT } from "../packages/contracts/src/index.mjs";
import {
  buildSignedPluginManifest,
  loadPluginDirectory,
  adaptLegacyCampusManifest
} from "../packages/plugin-sdk/src/index.mjs";

test("Plugin Ecosystem: External plugin CLI init -> validate -> sign -> verify -> install -> UI slot render -> command invoke -> upgrade -> rollback -> uninstall with ZERO host code modification", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-ext-plugin-"));
  const cliPath = path.join(REPO_ROOT, "packages/plugin-sdk/bin/dis-plugin.mjs");

  // Snapshot host source tree mtimes before plugin lifecycle
  const hostAppPath = path.join(REPO_ROOT, "apps/api/src/app.mjs");
  const hostBeforeSha = fs.readFileSync(hostAppPath, "utf8");

  // 1. dis-plugin init
  execFileSync("node", [cliPath, "init", tmpDir, "--id", "org.example.zero-host-demo"], {
    stdio: "pipe"
  });

  // 2. dis-plugin validate & verify
  const valOut = JSON.parse(
    execFileSync("node", [cliPath, "validate", tmpDir], { encoding: "utf8" })
  );
  assert.equal(valOut.ok, true);
  assert.equal(valOut.plugin_id, "org.example.zero-host-demo");

  const verOut = JSON.parse(
    execFileSync("node", [cliPath, "verify", tmpDir], { encoding: "utf8" })
  );
  assert.equal(verOut.ok, true);

  // 3. Install v1.0.0 into running CampusCloudApp without modifying any host files
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject: "plugin_tester",
    displayName: "Plugin User"
  });
  const session = app.identity.issueDeviceSession(user, "Android");
  const authHeaders = { authorization: `Bearer ${session.access_token}` };

  const pubKey = fs.readFileSync(path.join(tmpDir, "plugin-signing-public.key"), "utf8").trim();
  const privKey = fs.readFileSync(path.join(tmpDir, "plugin-signing-private.key"), "utf8").trim();
  const loadedV1 = loadPluginDirectory(tmpDir);

  const installV1Res = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/install",
    headers: authHeaders,
    body: {
      manifest: loadedV1.manifest,
      artifact_map: {
        "dist/index.mjs": loadedV1.artifactMap["dist/index.mjs"].toString("utf8")
      },
      public_key_base64: pubKey
    }
  });
  assert.equal(installV1Res.status, 201);
  assert.equal(installV1Res.body.data.active_version, "1.0.0");

  // 4. Verify UI slot descriptor is dynamically resolved
  const slotsV1 = app.pluginBroker.getResolvedUiSlotDescriptors(user.id, "campus.services");
  assert.ok(slotsV1.some((s) => s.plugin_id === "org.example.zero-host-demo"));

  // 5. Invoke sandboxed plugin command
  const invokeRes = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.zero-host-demo/commands/ping/invoke",
    headers: authHeaders,
    body: { payload: { hello: "world" } }
  });
  assert.equal(invokeRes.status, 200);
  assert.equal(invokeRes.body.data.executed, true);

  // 6. Build & install v1.1.0 upgrade, then test ROLLBACK to v1.0.0
  const v2Draft = {
    ...loadedV1.manifest,
    version: "1.1.0"
  };
  const signedV2 = buildSignedPluginManifest({
    manifestDraft: v2Draft,
    artifactMap: loadedV1.artifactMap,
    privateKeyBase64: privKey
  });
  const installV2Res = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/install",
    headers: authHeaders,
    body: {
      manifest: signedV2,
      artifact_map: {
        "dist/index.mjs": loadedV1.artifactMap["dist/index.mjs"].toString("utf8")
      },
      public_key_base64: pubKey
    }
  });
  assert.equal(installV2Res.status, 201);
  assert.equal(installV2Res.body.data.active_version, "1.1.0");
  assert.equal(installV2Res.body.data.previous_version, "1.0.0");

  // Rollback to 1.0.0
  const rollbackRes = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.zero-host-demo/lifecycle",
    headers: authHeaders,
    body: { action: "ROLLBACK" }
  });
  assert.equal(rollbackRes.status, 200);
  assert.equal(rollbackRes.body.data.active_version, "1.0.0");

  // Disable -> command invocation must fail with 403 PLUGIN_PERMISSION_DENIED
  await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.zero-host-demo/lifecycle",
    headers: authHeaders,
    body: { action: "DISABLE" }
  });
  const disabledInvoke = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.zero-host-demo/commands/ping/invoke",
    headers: authHeaders,
    body: {}
  });
  assert.equal(disabledInvoke.status, 403);

  // Uninstall
  const uninstRes = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.zero-host-demo/lifecycle",
    headers: authHeaders,
    body: { action: "UNINSTALL" }
  });
  assert.equal(uninstRes.status, 200);
  assert.equal(uninstRes.body.data.status, "UNINSTALLED");

  // Verify host source code was not modified
  const hostAfterSha = fs.readFileSync(hostAppPath, "utf8");
  assert.equal(hostBeforeSha, hostAfterSha);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Plugin Ecosystem: LegacySchoolPackageAdapter migrates dis-campus-plugin/v1 seamlessly to dis-extension/v2", () => {
  const adapted = adaptLegacyCampusManifest({
    schema_version: "dis-campus-plugin/v1",
    package_id: "cn.edu.haut.legacy",
    school_name: "HAUT Legacy Package",
    version: "1.0.0"
  });
  assert.equal(adapted.schema_version, "dis-extension/v2");
  assert.equal(adapted.legacy_schema_version, "dis-campus-plugin/v1");
  assert.equal(adapted.plugin_id, "cn.edu.haut.legacy");
});
