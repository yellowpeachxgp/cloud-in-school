import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { REPO_ROOT } from "../packages/contracts/src/index.mjs";
import { generateEd25519KeyPair } from "../packages/crypto/src/index.mjs";
import {
  PluginRegistryAndBroker,
  buildSignedPluginManifest
} from "../packages/plugin-sdk/src/index.mjs";

function createUserSession(app, subject, roles = null) {
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject,
    displayName: "W6-01a Security Tester"
  });
  if (roles) app.store.setUserRoles(user.id, roles);
  const session = app.identity.issueDeviceSession(user, "Android");
  return {
    user,
    headers: { authorization: "Bearer " + session.access_token }
  };
}

function signedPlugin({
  keyPair,
  pluginId = "org.example.w601a-security",
  version = "1.0.0",
  permissions = ["ui.slot.render", "network.request", "storage.scoped"],
  command = null,
  keyId = "dis-plugin-root-2026"
}) {
  const artifact = "signed declarative data for " + version + "\n";
  const artifactMap = { "dist/data.txt": artifact };
  const draft = {
    schema_version: "dis-extension/v2",
    plugin_id: pluginId,
    name: "W6-01a Security Fixture",
    version,
    min_host_api: 2,
    max_host_api: 2,
    permissions,
    allowed_origins: ["https://plugin.example.com"],
    ui_slots: [
      {
        slot_id: "campus.services",
        card_id: pluginId + ".card",
        title: "W6-01a Security Fixture",
        subtitle: "signed test fixture",
        action_command: "ping"
      }
    ],
    commands: [
      command || {
        name: "ping",
        description: "Open an allowlisted HTTPS destination declaratively",
        required_permission: "network.request",
        type: "open_url",
        url: "https://plugin.example.com/ping"
      }
    ]
  };
  return {
    artifact,
    artifactMap,
    manifest: buildSignedPluginManifest({
      manifestDraft: draft,
      artifactMap,
      privateKeyBase64: keyPair.privateKeyBase64,
      keyId
    })
  };
}

function trustedPluginAppOptions(keyPair, extra = {}) {
  return {
    requireAdminAccess: false,
    ...extra,
    pluginTrustedPublisherKeys: {
      "dis-plugin-root-2026": keyPair.publicKeyBase64
    }
  };
}

async function installFixture(app, headers, fixture, publicKeyBase64, schoolId = null) {
  return app.inject({
    method: "POST",
    url: "/api/v1/plugins/install",
    headers,
    body: {
      manifest: fixture.manifest,
      artifact_map: { "dist/data.txt": fixture.artifact },
      ...(schoolId ? { school_id: schoolId } : {})
    }
  });
}

async function invokeFixture(app, headers, pluginId, body = {}) {
  return app.inject({
    method: "POST",
    url: "/api/v1/plugins/" + pluginId + "/commands/ping/invoke",
    headers,
    body
  });
}

test("AC-13: revoking one permission takes effect immediately for network-bound commands", async () => {
  const keyPair = generateEd25519KeyPair();
  const app = createCampusCloudApp(trustedPluginAppOptions(keyPair));
  const { headers } = createUserSession(app, "w601a_revoke_user");
  const fixture = signedPlugin({ keyPair });
  const install = await installFixture(app, headers, fixture, keyPair.publicKeyBase64);
  assert.equal(install.status, 201);

  const allowed = await invokeFixture(app, headers, "org.example.w601a-security", {
    requested_origin: "https://plugin.example.com"
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.data.output.type, "open_url");

  const revoke = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.w601a-security/lifecycle",
    headers,
    body: { action: "REVOKE_PERMISSION", permission: "network.request" }
  });
  assert.equal(revoke.status, 200);
  assert.deepEqual(revoke.body.data.granted_permissions, ["ui.slot.render", "storage.scoped"]);

  const denied = await invokeFixture(app, headers, "org.example.w601a-security", {
    requested_origin: "https://plugin.example.com"
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "PLUGIN_PERMISSION_DENIED");
});

test("AC-14: installations are isolated by cloud user and school scope", async () => {
  const keyPair = generateEd25519KeyPair();
  const app = createCampusCloudApp(trustedPluginAppOptions(keyPair));
  const userA = createUserSession(app, "w601a_scope_user_a");
  const userB = createUserSession(app, "w601a_scope_user_b");
  const fixture = signedPlugin({ keyPair, pluginId: "org.example.w601a-scope" });
  const install = await installFixture(app, userA.headers, fixture, keyPair.publicKeyBase64, "schoolx");
  assert.equal(install.status, 201);
  assert.equal(install.body.data.school_id, "schoolx");

  const crossUser = await invokeFixture(app, userB.headers, "org.example.w601a-scope", {
    school_id: "schoolx"
  });
  assert.equal(crossUser.status, 403);
  assert.equal(crossUser.body.error.code, "PLUGIN_PERMISSION_DENIED");

  const crossSchool = await invokeFixture(app, userA.headers, "org.example.w601a-scope", {
    school_id: "schooly"
  });
  assert.equal(crossSchool.status, 403);
  assert.equal(crossSchool.body.error.code, "PLUGIN_PERMISSION_DENIED");
  assert.equal(app.pluginBroker.getResolvedUiSlotDescriptors(userA.user.id, null, { schoolId: "schooly" }).length, 0);
  assert.equal(app.pluginBroker.getResolvedUiSlotDescriptors(userA.user.id, null, { schoolId: "schoolx" }).length, 1);
});

test("AC-15: package versions, installations, grants, and key pins survive an app restart", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-w601a-restart-"));
  try {
    const snapshotPath = path.join(tmpDir, "snapshot.json");
    const keyPair = generateEd25519KeyPair();
    const fixture = signedPlugin({ keyPair, pluginId: "org.example.w601a-restart" });
    const app1 = createCampusCloudApp(trustedPluginAppOptions(keyPair, {
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    }));
    const { user, headers } = createUserSession(app1, "w601a_restart_user");
    const install = await installFixture(app1, headers, fixture, keyPair.publicKeyBase64);
    assert.equal(install.status, 201);
    app1.store.flushSnapshotStrictSync();

    const app2 = createCampusCloudApp(trustedPluginAppOptions(keyPair, {
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    }));
    const found = app2.pluginBroker._findInstallation(user.id, "org.example.w601a-restart", "haut");
    assert.ok(found, "installation must be restored from the durable snapshot");
    assert.equal(found.installation.active_version, "1.0.0");
    assert.deepEqual(found.installation.granted_permissions, ["ui.slot.render", "network.request", "storage.scoped"]);
    assert.equal(
      app2.pluginBroker.ownerKeyByPlugin.get("org.example.w601a-restart"),
      keyPair.publicKeyBase64,
      "publisher key pinning must be durable"
    );
    const persistedInvoke = await invokeFixture(app2, headers, "org.example.w601a-restart");
    assert.equal(persistedInvoke.status, 200);

    const replacementKey = generateEd25519KeyPair();
    const replacement = signedPlugin({ keyPair: replacementKey, pluginId: "org.example.w601a-restart" });
    assert.throws(
      () => app2.pluginBroker.registerPluginPackage({
        manifest: replacement.manifest,
        artifactMap: replacement.artifactMap,
        publicKeyBase64: replacementKey.publicKeyBase64,
        actorUserId: user.id
      }),
      (error) => error?.code === "PLUGIN_SIGNATURE_INVALID"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AC-16: broker carries no private key and production rejects unlisted publisher keys", () => {
  const keyPair = generateEd25519KeyPair();
  const untrusted = generateEd25519KeyPair();
  const productionBroker = new PluginRegistryAndBroker({
    environment: "production",
    trustedPublisherKeys: { "dis-plugin-root-2026": keyPair.publicKeyBase64 }
  });
  assert.equal(Object.keys(productionBroker).some((key) => /private.*key/i.test(key)), false);
  assert.equal("privateKeyBase64" in productionBroker, false);

  const untrustedFixture = signedPlugin({ keyPair: untrusted, pluginId: "org.example.w601a-untrusted" });
  assert.throws(
    () => productionBroker.registerPluginPackage({
      manifest: untrustedFixture.manifest,
      artifactMap: untrustedFixture.artifactMap,
      publicKeyBase64: untrusted.publicKeyBase64
    }),
    (error) => error?.code === "PLUGIN_SIGNATURE_INVALID"
  );

  const trustedFixture = signedPlugin({ keyPair, pluginId: "org.example.w601a-trusted" });
  const trusted = productionBroker.registerPluginPackage({
    manifest: trustedFixture.manifest,
    artifactMap: trustedFixture.artifactMap,
    publicKeyBase64: keyPair.publicKeyBase64
  });
  assert.equal(trusted.plugin_id, "org.example.w601a-trusted");

  const developmentBroker = new PluginRegistryAndBroker({ environment: "development" });
  const accepted = developmentBroker.registerPluginPackage({
    manifest: untrustedFixture.manifest,
    artifactMap: untrustedFixture.artifactMap,
    publicKeyBase64: untrusted.publicKeyBase64
  });
  assert.equal(accepted.plugin_id, "org.example.w601a-untrusted");
});

test("W6-01a trust root: install route rejects client-supplied public keys", async () => {
  const keyPair = generateEd25519KeyPair();
  const app = createCampusCloudApp(trustedPluginAppOptions(keyPair));
  const { headers } = createUserSession(app, "w601a_route_key_user", ["ADMIN"]);
  const fixture = signedPlugin({ keyPair, pluginId: "org.example.w601a-route-key" });
  const rejected = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/install",
    headers,
    body: {
      manifest: fixture.manifest,
      artifact_map: { "dist/data.txt": fixture.artifact },
      public_key_base64: keyPair.publicKeyBase64
    }
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, "BAD_REQUEST");
  assert.equal(
    app.pluginBroker.listAvailablePlugins().some((plugin) => plugin.plugin_id === "org.example.w601a-route-key"),
    false,
    "a rejected client-supplied key must not register the package"
  );
});

test("W6-01a trust root: explicit publisher mapping rejects host-reference and key-confusion bypasses", () => {
  const keyA = generateEd25519KeyPair();
  const keyB = generateEd25519KeyPair();
  const outsider = generateEd25519KeyPair();
  const broker = new PluginRegistryAndBroker({
    environment: "production",
    trustedPublisherKeys: {
      "publisher-a": keyA.publicKeyBase64,
      "publisher-b": keyB.publicKeyBase64
    }
  });
  assert.equal(broker.trustedPublicKeyForPublisher("publisher-a"), keyA.publicKeyBase64);
  assert.equal(broker.trustedPublicKeyForPublisher("missing"), null);

  const configuredFromText = new PluginRegistryAndBroker({
    environment: "production",
    trustedPublisherKeys: JSON.stringify({ "publisher-a": keyA.publicKeyBase64 })
  });
  assert.equal(configuredFromText.trustedPublicKeyForPublisher("publisher-a"), keyA.publicKeyBase64);

  const valid = signedPlugin({
    keyPair: keyA,
    pluginId: "org.example.w601a-trusted-a",
    keyId: "publisher-a"
  });
  const accepted = broker.registerPluginPackage({
    manifest: valid.manifest,
    artifactMap: valid.artifactMap,
    actorUserId: "publisher-user-a"
  });
  assert.equal(accepted.plugin_id, "org.example.w601a-trusted-a");

  const confused = JSON.parse(JSON.stringify(valid.manifest));
  confused.signature.key_id = "publisher-b";
  assert.throws(
    () => broker.registerPluginPackage({
      manifest: confused,
      artifactMap: valid.artifactMap,
      actorUserId: "attacker"
    }),
    (error) => error?.code === "PLUGIN_SIGNATURE_INVALID",
    "a package signed by publisher-a must not verify under publisher-b's trust-root entry"
  );

  const hostReferenceForgery = signedPlugin({
    keyPair: outsider,
    pluginId: "org.example.w601a-host-reference-forgery",
    keyId: "publisher-outside"
  });
  assert.throws(
    () => broker.registerPluginPackage({
      manifest: hostReferenceForgery.manifest,
      artifactMap: hostReferenceForgery.artifactMap,
      publicKeyBase64: outsider.publicKeyBase64,
      actorUserId: "attacker",
      isHostReference: true
    }),
    (error) => error?.code === "PLUGIN_SIGNATURE_INVALID",
    "isHostReference must not bypass the configured publisher trust root"
  );
});

test("AC-17: third-party commands are declarative, never echo payloads, and reject unsupported or out-of-origin targets", async () => {
  const keyPair = generateEd25519KeyPair();
  const app = createCampusCloudApp(trustedPluginAppOptions(keyPair));
  const { headers } = createUserSession(app, "w601a_command_user");

  const unsupported = signedPlugin({
    keyPair,
    pluginId: "org.example.w601a-unsupported",
    command: {
      name: "ping",
      description: "unsupported command type fixture",
      required_permission: "network.request",
      type: "eval_script"
    }
  });
  assert.equal((await installFixture(app, headers, unsupported, keyPair.publicKeyBase64)).status, 201);
  const unsupportedResult = await invokeFixture(app, headers, "org.example.w601a-unsupported", {
    payload: { secret_marker: "must-not-appear" }
  });
  assert.equal(unsupportedResult.status, 400);
  assert.equal(unsupportedResult.body.error.code, "PLUGIN_COMMAND_UNSUPPORTED");
  assert.equal(JSON.stringify(unsupportedResult.body).includes("must-not-appear"), false);

  const valid = signedPlugin({ keyPair, pluginId: "org.example.w601a-valid-command" });
  assert.equal((await installFixture(app, headers, valid, keyPair.publicKeyBase64)).status, 201);
  const validResult = await invokeFixture(app, headers, "org.example.w601a-valid-command", {
    payload: { secret_marker: "must-not-appear" },
    requested_origin: "https://plugin.example.com"
  });
  assert.equal(validResult.status, 200);
  assert.equal(validResult.body.data.output.type, "open_url");
  assert.equal(JSON.stringify(validResult.body).includes("must-not-appear"), false);

  const outside = signedPlugin({
    keyPair,
    pluginId: "org.example.w601a-outside-origin",
    command: {
      name: "ping",
      description: "out-of-origin declarative target",
      required_permission: "network.request",
      type: "open_url",
      url: "https://evil.example.com/phish"
    }
  });
  assert.equal((await installFixture(app, headers, outside, keyPair.publicKeyBase64)).status, 201);
  const outsideResult = await invokeFixture(app, headers, "org.example.w601a-outside-origin");
  assert.equal(outsideResult.status, 403);
  assert.equal(outsideResult.body.error.code, "PLUGIN_PERMISSION_DENIED");
});

test("AC-18: consecutive failures auto-disable only the failing plugin and admin kill switch is immediate", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const userSession = createUserSession(app, "w601a_failure_user");
  const adminSession = createUserSession(app, "w601a_failure_admin", ["PLATFORM_OWNER"]);
  const keyPair = generateEd25519KeyPair();
  const failing = signedPlugin({
    keyPair,
    pluginId: "org.example.w601a-failing",
    command: {
      name: "ping",
      description: "host-owned reference failure injection point",
      required_permission: "network.request"
    }
  });
  const healthy = signedPlugin({ keyPair, pluginId: "org.example.w601a-healthy" });

  app.pluginBroker.registerPluginPackage({
    manifest: failing.manifest,
    artifactMap: failing.artifactMap,
    publicKeyBase64: keyPair.publicKeyBase64,
    commandHandlers: {
      ping: async () => { throw new Error("injected plugin failure"); }
    }
  });
  app.pluginBroker.registerPluginPackage({
    manifest: healthy.manifest,
    artifactMap: healthy.artifactMap,
    publicKeyBase64: keyPair.publicKeyBase64
  });
  app.pluginBroker.installPluginForUser(userSession.user.id, "org.example.w601a-failing");
  app.pluginBroker.installPluginForUser(userSession.user.id, "org.example.w601a-healthy");

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await assert.rejects(
      app.pluginBroker.invokePluginCommand({
        userId: userSession.user.id,
        pluginId: "org.example.w601a-failing",
        commandName: "ping"
      }),
      /injected plugin failure/
    );
  }
  const failingInstall = app.pluginBroker._findInstallation(userSession.user.id, "org.example.w601a-failing")?.installation;
  assert.equal(failingInstall.status, "DISABLED");
  assert.match(String(failingInstall.disabled_reason), /CONSECUTIVE_COMMAND_FAILURES/);
  assert.ok(app.store.auditEvents.some((event) => event.action === "PLUGIN_AUTO_DISABLED"));

  const healthyResult = await invokeFixture(app, userSession.headers, "org.example.w601a-healthy");
  assert.equal(healthyResult.status, 200);
  const hostFeatures = await app.inject({ method: "GET", url: "/api/v1/features" });
  assert.equal(hostFeatures.status, 200);

  const kill = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.w601a-healthy/lifecycle",
    headers: adminSession.headers,
    body: { action: "DISABLE", scope: "global", reason: "security drill" }
  });
  assert.equal(kill.status, 200);
  assert.equal(kill.body.data.kill_switch, true);
  const killedInvoke = await invokeFixture(app, userSession.headers, "org.example.w601a-healthy");
  assert.equal(killedInvoke.status, 403);
  assert.ok(app.store.auditEvents.some((event) => event.action === "PLUGIN_KILL_SWITCH_DISABLE"));
});

test("AC-19: uninstall removes grants, scoped storage, and cache before any reinstall", async () => {
  const keyPair = generateEd25519KeyPair();
  const app = createCampusCloudApp(trustedPluginAppOptions(keyPair));
  const { user, headers } = createUserSession(app, "w601a_uninstall_user");
  const fixture = signedPlugin({ keyPair, pluginId: "org.example.w601a-uninstall" });
  assert.equal((await installFixture(app, headers, fixture, keyPair.publicKeyBase64)).status, 201);
  const installation = app.pluginBroker._findInstallation(user.id, "org.example.w601a-uninstall")?.installation;
  assert.ok(installation);
  app.pluginBroker.putPluginStorage(user.id, "org.example.w601a-uninstall", "k", { v: 1 });
  app.pluginBroker.putPluginStorage(user.id, "org.example.w601a-uninstall", "cache-key", { v: 2 }, { cache: true });
  const before = app.pluginBroker.pluginDataCounts(installation.installation_id);
  assert.ok(before.permission_grants > 0);
  assert.equal(before.storage_entries, 1);
  assert.equal(before.cache_entries, 1);

  const uninstall = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.w601a-uninstall/lifecycle",
    headers,
    body: { action: "UNINSTALL" }
  });
  assert.equal(uninstall.status, 200);
  assert.deepEqual(app.pluginBroker.pluginDataCounts(installation.installation_id), {
    permission_grants: 0,
    storage_entries: 0,
    cache_entries: 0
  });
  assert.ok(app.store.auditEvents.some((event) => event.action === "UNINSTALL_PLUGIN"));

  assert.equal((await installFixture(app, headers, fixture, keyPair.publicKeyBase64)).status, 201);
  assert.equal(app.pluginBroker.getPluginStorage(user.id, "org.example.w601a-uninstall", "k"), null);
});

test("AC-24: CLI init keeps private keys outside plugin directories and sign rejects traversal artifact paths", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-w601a-cli-plugin-"));
  const keyHome = fs.mkdtempSync(path.join(os.tmpdir(), "dis-w601a-cli-keys-"));
  try {
    const cliPath = path.join(REPO_ROOT, "packages/plugin-sdk/bin/dis-plugin.mjs");
    const initOut = JSON.parse(execFileSync("node", [cliPath, "init", tmpDir, "--id", "org.example.w601a-cli"], {
      encoding: "utf8",
      env: { ...process.env, DIS_PLUGIN_KEY_HOME: keyHome }
    }));
    assert.equal(fs.existsSync(path.join(tmpDir, "plugin-signing-private.key")), false);
    assert.equal(fs.existsSync(path.join(tmpDir, ".gitignore")), true);
    assert.equal(initOut.private_key_path.startsWith(keyHome), true);

    const manifestPath = path.join(tmpDir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.entry_artifacts = [{ path: "../x", sha256: "0".repeat(64), size_bytes: 1 }];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const sign = spawnSync("node", [cliPath, "sign", tmpDir], {
      encoding: "utf8",
      env: { ...process.env, DIS_PLUGIN_KEY_HOME: keyHome }
    });
    assert.notEqual(sign.status, 0);
    assert.match(sign.stderr, /Unsafe artifact path|zip-slip|traversal/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(keyHome, { recursive: true, force: true });
  }
});
