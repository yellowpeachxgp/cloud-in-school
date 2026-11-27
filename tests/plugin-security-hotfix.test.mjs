import test from "node:test";
import assert from "node:assert/strict";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import { generateEd25519KeyPair } from "../packages/crypto/src/index.mjs";
import { buildSignedPluginManifest } from "../packages/plugin-sdk/src/index.mjs";

function createUserSession(app, subject) {
  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes/t/acme",
    subject,
    displayName: "Plugin Security Tester"
  });
  const session = app.identity.issueDeviceSession(user, "Android");
  return {
    user,
    headers: { authorization: `Bearer ${session.access_token}` }
  };
}

function signedTestPlugin({ keyPair, version, permissions }) {
  const artifact = `export async function execute(ctx) {\n  return { version: \"${version}\", payload: ctx.payload };\n}\n`;
  const artifactMap = { "dist/index.mjs": artifact };
  const draft = {
    schema_version: "dis-extension/v2",
    plugin_id: "org.example.permission-hotfix",
    name: "Permission Hotfix Fixture",
    version,
    min_host_api: 2,
    max_host_api: 2,
    permissions,
    allowed_origins: ["https://plugin.example.com"],
    ui_slots: [
      {
        slot_id: "campus.services",
        card_id: "org.example.permission-hotfix.card",
        title: "Permission Hotfix Fixture",
        subtitle: "signed test fixture",
        action_command: "ping"
      }
    ],
    commands: [
      {
        name: "ping",
        description: "Declarative ping fixture",
        required_permission: "ui.slot.render",
        type: "open_url",
        url: "https://plugin.example.com/ping"
      }
    ]
  };
  return {
    artifact,
    manifest: buildSignedPluginManifest({
      manifestDraft: draft,
      artifactMap,
      privateKeyBase64: keyPair.privateKeyBase64
    })
  };
}

async function installSignedFixture(app, headers, fixture, publicKeyBase64) {
  return app.inject({
    method: "POST",
    url: "/api/v1/plugins/install",
    headers,
    body: {
      manifest: fixture.manifest,
      artifact_map: { "dist/index.mjs": fixture.artifact },
      public_key_base64: publicKeyBase64
    }
  });
}

async function invokePingWithOrigin(app, headers) {
  return app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.permission-hotfix/commands/ping/invoke",
    headers,
    body: { requested_origin: "https://plugin.example.com" }
  });
}

async function invokePing(app, headers) {
  return app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.permission-hotfix/commands/ping/invoke",
    headers,
    body: {}
  });
}

test("AC-11/AC-12: upgrade permission deltas require review, stay fail-closed, and rollback shrinks grants", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { headers, user } = createUserSession(app, "plugin_permission_hotfix_user");
  const keyPair = generateEd25519KeyPair();
  const v1Permissions = ["ui.slot.render"];
  const v2Permissions = [
    "ui.slot.render",
    "network.request",
    "account.session",
    "location.coarse"
  ];
  const v1 = signedTestPlugin({ keyPair, version: "1.0.0", permissions: v1Permissions });
  const v2 = signedTestPlugin({ keyPair, version: "1.1.0", permissions: v2Permissions });

  const installV1 = await installSignedFixture(app, headers, v1, keyPair.publicKeyBase64);
  assert.equal(installV1.status, 201);
  assert.equal(installV1.body.data.status, "ENABLED");
  assert.equal(installV1.body.data.active_version, "1.0.0");
  assert.deepEqual(installV1.body.data.granted_permissions, v1Permissions);

  const installV2 = await installSignedFixture(app, headers, v2, keyPair.publicKeyBase64);
  assert.equal(installV2.status, 201);
  assert.equal(installV2.body.data.status, "PENDING_PERMISSION_REVIEW");
  assert.equal(installV2.body.data.active_version, "1.0.0", "old version must continue until review");
  assert.equal(installV2.body.data.pending_version, "1.1.0");
  assert.deepEqual(installV2.body.data.pending_permissions, [
    "network.request",
    "account.session",
    "location.coarse"
  ]);
  assert.deepEqual(installV2.body.data.granted_permissions, v1Permissions);

  const oldVersionStillActive = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.permission-hotfix/commands/ping/invoke",
    headers,
    body: {}
  });
  assert.equal(oldVersionStillActive.status, 200);
  assert.equal(oldVersionStillActive.body.data.version, "1.0.0");
  const pendingSlots = app.pluginBroker.getResolvedUiSlotDescriptors(user.id, "campus.services");
  assert.equal(
    pendingSlots.find((slot) => slot.plugin_id === "org.example.permission-hotfix")?.plugin_version,
    "1.0.0"
  );

  const deniedBeforeReview = await invokePingWithOrigin(app, headers);
  assert.equal(deniedBeforeReview.status, 403);
  assert.equal(deniedBeforeReview.body.error.code, "PLUGIN_PERMISSION_DENIED");

  const confirm = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.permission-hotfix/lifecycle",
    headers,
    body: { action: "ENABLE" }
  });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.data.status, "ENABLED");
  assert.equal(confirm.body.data.active_version, "1.1.0");
  assert.equal(confirm.body.data.pending_version, null);
  assert.deepEqual(confirm.body.data.granted_permissions, v2Permissions);

  const allowedAfterReview = await invokePingWithOrigin(app, headers);
  assert.equal(allowedAfterReview.status, 200);

  const rollback = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.permission-hotfix/lifecycle",
    headers,
    body: { action: "ROLLBACK" }
  });
  assert.equal(rollback.status, 200);
  assert.equal(rollback.body.data.active_version, "1.0.0");
  assert.deepEqual(rollback.body.data.granted_permissions, v1Permissions);

  const deniedAfterRollback = await invokePingWithOrigin(app, headers);
  assert.equal(deniedAfterRollback.status, 403);
  assert.equal(deniedAfterRollback.body.error.code, "PLUGIN_PERMISSION_DENIED");
});

test("S1 edge: disable/enable pauses and resumes review without activating the upgrade", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { headers } = createUserSession(app, "plugin_permission_pause_user");
  const keyPair = generateEd25519KeyPair();
  const v1 = signedTestPlugin({ keyPair, version: "1.0.0", permissions: ["ui.slot.render"] });
  const v2 = signedTestPlugin({
    keyPair,
    version: "1.1.0",
    permissions: ["ui.slot.render", "network.request"]
  });

  await installSignedFixture(app, headers, v1, keyPair.publicKeyBase64);
  const pending = await installSignedFixture(app, headers, v2, keyPair.publicKeyBase64);
  assert.equal(pending.body.data.status, "PENDING_PERMISSION_REVIEW");

  const disabled = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.permission-hotfix/lifecycle",
    headers,
    body: { action: "DISABLE" }
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.data.status, "DISABLED");
  assert.equal(disabled.body.data.pending_version, "1.1.0");

  const restagedWhileDisabled = await installSignedFixture(app, headers, v2, keyPair.publicKeyBase64);
  assert.equal(restagedWhileDisabled.status, 201);
  assert.equal(restagedWhileDisabled.body.data.status, "DISABLED");
  assert.equal(restagedWhileDisabled.body.data.active_version, "1.0.0");
  assert.equal(restagedWhileDisabled.body.data.pending_version, "1.1.0");
  assert.deepEqual(restagedWhileDisabled.body.data.granted_permissions, ["ui.slot.render"]);

  const resumed = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.permission-hotfix/lifecycle",
    headers,
    body: { action: "ENABLE" }
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.data.status, "PENDING_PERMISSION_REVIEW");
  assert.equal(resumed.body.data.active_version, "1.0.0");
  assert.equal(resumed.body.data.pending_version, "1.1.0");
  assert.deepEqual(resumed.body.data.granted_permissions, ["ui.slot.render"]);
});

test("W6-HOTFIX regression: pre-disabled upgrade cannot invoke until the two-step enable confirmation", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { headers } = createUserSession(app, "plugin_permission_pre_disabled_user");
  const keyPair = generateEd25519KeyPair();
  const v1Permissions = ["ui.slot.render"];
  const v2Permissions = ["ui.slot.render", "network.request"];
  const v1 = signedTestPlugin({ keyPair, version: "1.0.0", permissions: v1Permissions });
  const v2 = signedTestPlugin({ keyPair, version: "1.1.0", permissions: v2Permissions });

  const installV1 = await installSignedFixture(app, headers, v1, keyPair.publicKeyBase64);
  assert.equal(installV1.status, 201);
  assert.equal(installV1.body.data.status, "ENABLED");

  const disabledBeforeUpgrade = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.permission-hotfix/lifecycle",
    headers,
    body: { action: "DISABLE" }
  });
  assert.equal(disabledBeforeUpgrade.status, 200);
  assert.equal(disabledBeforeUpgrade.body.data.status, "DISABLED");
  assert.equal(disabledBeforeUpgrade.body.data.pending_version, null);

  const upgradeWhileDisabled = await installSignedFixture(app, headers, v2, keyPair.publicKeyBase64);
  assert.equal(upgradeWhileDisabled.status, 201);
  assert.equal(upgradeWhileDisabled.body.data.status, "DISABLED");
  assert.equal(upgradeWhileDisabled.body.data.active_version, "1.0.0");
  assert.equal(upgradeWhileDisabled.body.data.pending_version, "1.1.0");
  assert.deepEqual(upgradeWhileDisabled.body.data.pending_permissions, ["network.request"]);
  assert.deepEqual(upgradeWhileDisabled.body.data.granted_permissions, v1Permissions);

  const invokeWhileDisabled = await invokePing(app, headers);
  assert.equal(invokeWhileDisabled.status, 403);
  assert.equal(invokeWhileDisabled.body.error.code, "PLUGIN_PERMISSION_DENIED");

  const firstEnable = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.permission-hotfix/lifecycle",
    headers,
    body: { action: "ENABLE" }
  });
  assert.equal(firstEnable.status, 200);
  assert.equal(firstEnable.body.data.status, "PENDING_PERMISSION_REVIEW");
  assert.equal(firstEnable.body.data.active_version, "1.0.0");
  assert.equal(firstEnable.body.data.pending_version, "1.1.0");
  assert.deepEqual(firstEnable.body.data.pending_permissions, ["network.request"]);
  assert.deepEqual(firstEnable.body.data.granted_permissions, v1Permissions);

  const newPermissionStillDenied = await invokePingWithOrigin(app, headers);
  assert.equal(newPermissionStillDenied.status, 403);
  assert.equal(newPermissionStillDenied.body.error.code, "PLUGIN_PERMISSION_DENIED");

  const secondEnable = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.permission-hotfix/lifecycle",
    headers,
    body: { action: "ENABLE" }
  });
  assert.equal(secondEnable.status, 200);
  assert.equal(secondEnable.body.data.status, "ENABLED");
  assert.equal(secondEnable.body.data.active_version, "1.1.0");
  assert.equal(secondEnable.body.data.pending_version, null);
  assert.deepEqual(secondEnable.body.data.pending_permissions, []);
  assert.deepEqual(secondEnable.body.data.granted_permissions, v2Permissions);

  const allowedAfterExplicitConfirmation = await invokePingWithOrigin(app, headers);
  assert.equal(allowedAfterExplicitConfirmation.status, 200);
  assert.equal(allowedAfterExplicitConfirmation.body.data.version, "1.1.0");
});

test("W6-HOTFIX regression: pre-disabled reinstall or same-permission upgrade stays disabled", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { headers } = createUserSession(app, "plugin_permission_disabled_reinstall_user");
  const keyPair = generateEd25519KeyPair();
  const permissions = ["ui.slot.render"];
  const v1 = signedTestPlugin({ keyPair, version: "1.0.0", permissions });
  const v101 = signedTestPlugin({ keyPair, version: "1.0.1", permissions });

  const installV1 = await installSignedFixture(app, headers, v1, keyPair.publicKeyBase64);
  assert.equal(installV1.status, 201);
  assert.equal(installV1.body.data.status, "ENABLED");

  const disabled = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.permission-hotfix/lifecycle",
    headers,
    body: { action: "DISABLE" }
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.data.status, "DISABLED");

  const reinstallSameVersion = await installSignedFixture(app, headers, v1, keyPair.publicKeyBase64);
  assert.equal(reinstallSameVersion.status, 201);
  assert.equal(reinstallSameVersion.body.data.status, "DISABLED");
  assert.equal(reinstallSameVersion.body.data.active_version, "1.0.0");
  assert.equal(reinstallSameVersion.body.data.pending_version, null);

  const invokeAfterReinstall = await invokePing(app, headers);
  assert.equal(invokeAfterReinstall.status, 403);
  assert.equal(invokeAfterReinstall.body.error.code, "PLUGIN_PERMISSION_DENIED");

  const samePermissionUpgrade = await installSignedFixture(app, headers, v101, keyPair.publicKeyBase64);
  assert.equal(samePermissionUpgrade.status, 201);
  assert.equal(samePermissionUpgrade.body.data.status, "DISABLED");
  assert.equal(samePermissionUpgrade.body.data.active_version, "1.0.1");
  assert.equal(samePermissionUpgrade.body.data.previous_version, "1.0.0");
  assert.equal(samePermissionUpgrade.body.data.pending_version, null);
  assert.deepEqual(samePermissionUpgrade.body.data.granted_permissions, permissions);

  const invokeAfterUpgrade = await invokePing(app, headers);
  assert.equal(invokeAfterUpgrade.status, 403);
  assert.equal(invokeAfterUpgrade.body.error.code, "PLUGIN_PERMISSION_DENIED");

  const explicitEnable = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.permission-hotfix/lifecycle",
    headers,
    body: { action: "ENABLE" }
  });
  assert.equal(explicitEnable.status, 200);
  assert.equal(explicitEnable.body.data.status, "ENABLED");
  assert.equal(explicitEnable.body.data.active_version, "1.0.1");
});

test("W6-HOTFIX regression: pre-disabled rollback stays disabled until explicit enable", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const { headers } = createUserSession(app, "plugin_permission_disabled_rollback_user");
  const keyPair = generateEd25519KeyPair();
  const permissions = ["ui.slot.render"];
  const v1 = signedTestPlugin({ keyPair, version: "1.0.0", permissions });
  const v2 = signedTestPlugin({ keyPair, version: "1.1.0", permissions });

  await installSignedFixture(app, headers, v1, keyPair.publicKeyBase64);
  const upgradeBeforeDisable = await installSignedFixture(app, headers, v2, keyPair.publicKeyBase64);
  assert.equal(upgradeBeforeDisable.status, 201);
  assert.equal(upgradeBeforeDisable.body.data.status, "ENABLED");
  assert.equal(upgradeBeforeDisable.body.data.active_version, "1.1.0");
  assert.equal(upgradeBeforeDisable.body.data.previous_version, "1.0.0");

  const disabled = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.permission-hotfix/lifecycle",
    headers,
    body: { action: "DISABLE" }
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.data.status, "DISABLED");

  const rollback = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.permission-hotfix/lifecycle",
    headers,
    body: { action: "ROLLBACK" }
  });
  assert.equal(rollback.status, 200);
  assert.equal(rollback.body.data.status, "DISABLED");
  assert.equal(rollback.body.data.active_version, "1.0.0");
  assert.equal(rollback.body.data.previous_version, "1.1.0");
  assert.equal(rollback.body.data.pending_version, null);
  assert.deepEqual(rollback.body.data.granted_permissions, permissions);

  const invokeAfterRollback = await invokePing(app, headers);
  assert.equal(invokeAfterRollback.status, 403);
  assert.equal(invokeAfterRollback.body.error.code, "PLUGIN_PERMISSION_DENIED");

  const explicitEnable = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/org.example.permission-hotfix/lifecycle",
    headers,
    body: { action: "ENABLE" }
  });
  assert.equal(explicitEnable.status, 200);
  assert.equal(explicitEnable.body.data.status, "ENABLED");
  assert.equal(explicitEnable.body.data.active_version, "1.0.0");
});
