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
        required_permission: "ui.slot.render"
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
