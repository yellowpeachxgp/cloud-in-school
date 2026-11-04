import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ContractError, loadPermissionCatalog } from "../../contracts/src/index.mjs";
import {
  generateEd25519KeyPair,
  signPluginManifest,
  verifyPluginManifestSignature,
  sha256Hex
} from "../../crypto/src/index.mjs";

export const SUPPORTED_UI_SLOTS = Object.freeze([
  "home.cards",
  "campus.services",
  "library.actions",
  "parcel.cards",
  "parcel.providers",
  "settings.entries"
]);

export function adaptLegacyCampusManifest(rawManifest) {
  if (!rawManifest || typeof rawManifest !== "object") {
    throw new ContractError("BAD_REQUEST", "Manifest must be an object");
  }
  if (rawManifest.schema_version === "dis-campus-plugin/v1") {
    return {
      schema_version: "dis-extension/v2",
      legacy_schema_version: "dis-campus-plugin/v1",
      plugin_id: rawManifest.package_id || rawManifest.plugin_id,
      name: rawManifest.school_name || rawManifest.name,
      version: rawManifest.version || "1.0.0",
      min_host_api: rawManifest.min_host_api ?? 1,
      max_host_api: rawManifest.max_host_api ?? 2,
      permissions: rawManifest.permissions || ["account.session", "ui.slot.render"],
      allowed_origins: rawManifest.allowed_origins || [],
      ui_slots: rawManifest.ui_slots || [
        {
          slot_id: "campus.services",
          card_id: `${rawManifest.package_id || "legacy"}.card`,
          title: rawManifest.school_name || rawManifest.name || "Campus Plugin",
          subtitle: "Migrated from dis-campus-plugin/v1",
          action_command: "open_service"
        }
      ],
      commands: rawManifest.commands || [
        {
          name: "open_service",
          description: "Open legacy campus service entry",
          required_permission: "ui.slot.render"
        }
      ],
      entry_artifacts: rawManifest.entry_artifacts || [],
      signature: rawManifest.signature
    };
  }
  return rawManifest;
}

export function assertSafeRelativeArtifactPath(relPath) {
  if (typeof relPath !== "string" || !relPath.trim()) {
    throw new ContractError("BAD_REQUEST", "Artifact path must be non-empty string");
  }
  if (
    relPath.startsWith("/") ||
    relPath.startsWith("\\") ||
    relPath.includes("..") ||
    relPath.includes("\0") ||
    /^[a-zA-Z]:/.test(relPath)
  ) {
    throw new ContractError(
      "BAD_REQUEST",
      `Unsafe artifact path rejected (zip-slip/traversal protection): ${relPath}`
    );
  }
  const normalized = path.posix.normalize(relPath.replace(/\\/g, "/"));
  if (normalized.startsWith("..") || normalized.startsWith("/")) {
    throw new ContractError(
      "BAD_REQUEST",
      `Normalized artifact path escapes plugin root: ${relPath}`
    );
  }
  return normalized;
}

export function validatePluginManifest(rawManifest, { hostApiVersion = 2 } = {}) {
  const manifest = adaptLegacyCampusManifest(rawManifest);

  if (!["dis-extension/v2", "dis-plugin/v2"].includes(manifest.schema_version)) {
    throw new ContractError(
      "BAD_REQUEST",
      `Unsupported plugin schema_version: ${manifest.schema_version}`
    );
  }

  if (!manifest.plugin_id || !/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(manifest.plugin_id)) {
    throw new ContractError("BAD_REQUEST", `Invalid plugin_id '${manifest.plugin_id}'`);
  }

  if (!manifest.version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new ContractError("BAD_REQUEST", `Invalid semver version '${manifest.version}'`);
  }

  const minHost = Number(manifest.min_host_api ?? 2);
  const maxHost = Number(manifest.max_host_api ?? 2);
  if (hostApiVersion < minHost || hostApiVersion > maxHost) {
    throw new ContractError(
      "BAD_REQUEST",
      `Plugin requires host API [${minHost}..${maxHost}], current host is ${hostApiVersion}`,
      { min_host_api: minHost, max_host_api: maxHost, current_host_api: hostApiVersion }
    );
  }

  const catalog = loadPermissionCatalog();
  const validPermissions = new Set((catalog.permissions || []).map((p) => p.id));
  for (const perm of manifest.permissions || []) {
    if (!validPermissions.has(perm)) {
      throw new ContractError(
        "PLUGIN_PERMISSION_DENIED",
        `Plugin declares unknown or forbidden permission '${perm}'`
      );
    }
  }

  for (const slot of manifest.ui_slots || []) {
    if (!SUPPORTED_UI_SLOTS.includes(slot.slot_id)) {
      throw new ContractError(
        "BAD_REQUEST",
        `Unsupported UI extension slot '${slot.slot_id}'`
      );
    }
  }

  for (const art of manifest.entry_artifacts || []) {
    assertSafeRelativeArtifactPath(art.path);
    if (!art.sha256 || !/^[a-f0-9]{64}$/i.test(art.sha256)) {
      throw new ContractError(
        "PLUGIN_SIGNATURE_INVALID",
        `Invalid sha256 digest declaration for ${art.path}`
      );
    }
  }

  return manifest;
}

export function buildSignedPluginManifest({
  manifestDraft,
  artifactMap = {},
  privateKeyBase64,
  keyId = "dis-plugin-root-2026"
}) {
  const entryArtifacts = Object.entries(artifactMap).map(([relPath, content]) => {
    const safePath = assertSafeRelativeArtifactPath(relPath);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    return {
      path: safePath,
      sha256: sha256Hex(buf),
      size_bytes: buf.length
    };
  });

  const unsignedManifest = {
    ...manifestDraft,
    entry_artifacts: entryArtifacts
  };
  delete unsignedManifest.signature;

  const sigBase64 = signPluginManifest(unsignedManifest, privateKeyBase64);
  return {
    ...unsignedManifest,
    signature: {
      algorithm: "Ed25519",
      key_id: keyId,
      value_base64: sigBase64
    }
  };
}

export function verifySignedPluginPackage({
  manifest,
  artifactMap = {},
  publicKeyBase64,
  hostApiVersion = 2
}) {
  const normalized = validatePluginManifest(manifest, { hostApiVersion });
  const sigObj = manifest.signature;
  const sigValue = typeof sigObj === "string" ? sigObj : sigObj?.value_base64;
  if (!sigValue) {
    throw new ContractError("PLUGIN_SIGNATURE_INVALID", "Missing Ed25519 plugin signature");
  }

  const unsignedCopy = { ...manifest };
  delete unsignedCopy.signature;

  const ok = verifyPluginManifestSignature(unsignedCopy, sigValue, publicKeyBase64);
  if (!ok) {
    throw new ContractError(
      "PLUGIN_SIGNATURE_INVALID",
      "Ed25519 plugin signature verification failed"
    );
  }

  for (const declared of normalized.entry_artifacts || []) {
    const safePath = assertSafeRelativeArtifactPath(declared.path);
    const actualContent = artifactMap[safePath];
    if (actualContent === undefined) {
      throw new ContractError(
        "PLUGIN_SIGNATURE_INVALID",
        `Missing declared plugin artifact '${safePath}'`
      );
    }
    const buf = Buffer.isBuffer(actualContent)
      ? actualContent
      : Buffer.from(String(actualContent), "utf8");
    const actualHash = sha256Hex(buf);
    if (actualHash.toLowerCase() !== declared.sha256.toLowerCase()) {
      throw new ContractError(
        "PLUGIN_SIGNATURE_INVALID",
        `SHA-256 digest mismatch for artifact '${safePath}'`,
        { expected: declared.sha256, actual: actualHash }
      );
    }
  }

  return normalized;
}

export class PluginRegistryAndBroker {
  constructor({ publicKeyBase64 = null, privateKeyBase64 = null, hostApiVersion = 2 } = {}) {
    if (!publicKeyBase64 || !privateKeyBase64) {
      const pair = generateEd25519KeyPair();
      this.publicKeyBase64 = publicKeyBase64 || pair.publicKeyBase64;
      this.privateKeyBase64 = privateKeyBase64 || pair.privateKeyBase64;
    } else {
      this.publicKeyBase64 = publicKeyBase64;
      this.privateKeyBase64 = privateKeyBase64;
    }
    this.hostApiVersion = hostApiVersion;
    this.packages = new Map(); // `${pluginId}@${version}` -> { manifest, artifactMap, commandHandlers }
    this.latestVersionByPlugin = new Map();
    this.versionsByPlugin = new Map();
    this.ownerKeyByPlugin = new Map(); // pluginId -> publicKeyBase64
    this.ownerUserByPlugin = new Map(); // pluginId -> userId
    this.userInstallations = new Map(); // `${userId}:${pluginId}` -> installation
  }

  registerPluginPackage({
    manifest,
    artifactMap = {},
    commandHandlers = {},
    publicKeyBase64 = this.publicKeyBase64,
    actorUserId = null,
    isAdmin = false
  }) {
    const verified = verifySignedPluginPackage({
      manifest,
      artifactMap,
      publicKeyBase64,
      hostApiVersion: this.hostApiVersion
    });

    const existingKey = this.ownerKeyByPlugin.get(verified.plugin_id);
    if (existingKey && existingKey !== publicKeyBase64 && !isAdmin) {
      throw new ContractError(
        "PLUGIN_SIGNATURE_INVALID",
        `Plugin '${verified.plugin_id}' is pinned to a different signing public key`
      );
    }
    const existingOwner = this.ownerUserByPlugin.get(verified.plugin_id);
    if (existingOwner && actorUserId && existingOwner !== actorUserId && !isAdmin) {
      throw new ContractError(
        "FORBIDDEN",
        `Plugin '${verified.plugin_id}' is owned by another publisher`
      );
    }
    if (!existingKey) {
      this.ownerKeyByPlugin.set(verified.plugin_id, publicKeyBase64);
    }
    if (!existingOwner && actorUserId) {
      this.ownerUserByPlugin.set(verified.plugin_id, actorUserId);
    }

    const key = `${verified.plugin_id}@${verified.version}`;
    this.packages.set(key, {
      manifest: verified,
      artifactMap,
      commandHandlers,
      registered_at: new Date().toISOString()
    });

    const list = this.versionsByPlugin.get(verified.plugin_id) || [];
    if (!list.includes(verified.version)) {
      list.push(verified.version);
      this.versionsByPlugin.set(verified.plugin_id, list);
    }
    this.latestVersionByPlugin.set(verified.plugin_id, verified.version);
    return verified;
  }

  listAvailablePlugins() {
    const result = [];
    for (const [pluginId, latestVer] of this.latestVersionByPlugin.entries()) {
      const pkg = this.packages.get(`${pluginId}@${latestVer}`);
      if (pkg) {
        result.push({
          plugin_id: pluginId,
          name: pkg.manifest.name,
          latest_version: latestVer,
          available_versions: this.versionsByPlugin.get(pluginId) || [latestVer],
          permissions: pkg.manifest.permissions,
          ui_slots: pkg.manifest.ui_slots,
          commands: pkg.manifest.commands || []
        });
      }
    }
    return result;
  }

  installPluginForUser(userId, pluginId, { version = null } = {}) {
    const targetVersion = version || this.latestVersionByPlugin.get(pluginId);
    if (!targetVersion) {
      throw new ContractError("NOT_FOUND", `Plugin '${pluginId}' not found`);
    }
    const pkg = this.packages.get(`${pluginId}@${targetVersion}`);
    if (!pkg) {
      throw new ContractError("NOT_FOUND", `Plugin '${pluginId}@${targetVersion}' not found`);
    }

    const installKey = `${userId}:${pluginId}`;
    const existing = this.userInstallations.get(installKey);
    const nowIso = new Date().toISOString();

    const record = {
      installation_id: existing?.installation_id || crypto.randomUUID(),
      user_id: userId,
      plugin_id: pluginId,
      active_version: targetVersion,
      previous_version:
        existing && existing.active_version !== targetVersion
          ? existing.active_version
          : existing?.previous_version || null,
      status: "ENABLED",
      granted_permissions: [...(pkg.manifest.permissions || [])],
      installed_at: existing?.installed_at || nowIso,
      updated_at: nowIso
    };
    this.userInstallations.set(installKey, record);
    return record;
  }

  transitionUserPlugin(userId, pluginId, { action, targetVersion = null }) {
    const installKey = `${userId}:${pluginId}`;
    const inst = this.userInstallations.get(installKey);
    if (!inst) {
      throw new ContractError("NOT_FOUND", `Plugin '${pluginId}' is not installed for user`);
    }

    const nowIso = new Date().toISOString();
    if (action === "ENABLE") {
      inst.status = "ENABLED";
      inst.updated_at = nowIso;
      return inst;
    }
    if (action === "DISABLE") {
      inst.status = "DISABLED";
      inst.updated_at = nowIso;
      return inst;
    }
    if (action === "ROLLBACK") {
      const rollbackVer = targetVersion || inst.previous_version;
      if (!rollbackVer || !this.packages.has(`${pluginId}@${rollbackVer}`)) {
        throw new ContractError(
          "BAD_REQUEST",
          `No valid rollback version available for plugin '${pluginId}'`
        );
      }
      inst.previous_version = inst.active_version;
      inst.active_version = rollbackVer;
      inst.status = "ENABLED";
      inst.updated_at = nowIso;
      return inst;
    }
    if (action === "UNINSTALL") {
      this.userInstallations.delete(installKey);
      return {
        plugin_id: pluginId,
        status: "UNINSTALLED",
        uninstalled_at: nowIso
      };
    }

    throw new ContractError("BAD_REQUEST", `Unsupported lifecycle action: ${action}`);
  }

  getResolvedUiSlotDescriptors(userId, slotId = null) {
    const descriptors = [];
    for (const inst of this.userInstallations.values()) {
      if (inst.user_id !== userId || inst.status !== "ENABLED") continue;
      const pkg = this.packages.get(`${inst.plugin_id}@${inst.active_version}`);
      if (!pkg) continue;
      if (!(inst.granted_permissions || []).includes("ui.slot.render")) continue;

      for (const slot of pkg.manifest.ui_slots || []) {
        if (slotId && slot.slot_id !== slotId) continue;
        descriptors.push({
          plugin_id: inst.plugin_id,
          plugin_version: inst.active_version,
          slot_id: slot.slot_id,
          card_id: slot.card_id,
          title: slot.title,
          subtitle: slot.subtitle || "",
          action_command: slot.action_command
        });
      }
    }
    return descriptors;
  }

  async invokePluginCommand({
    userId,
    pluginId,
    commandName,
    payload = {},
    requestedOrigin = null
  }) {
    const installKey = `${userId}:${pluginId}`;
    const inst = this.userInstallations.get(installKey);
    if (!inst || inst.status !== "ENABLED") {
      throw new ContractError(
        "PLUGIN_PERMISSION_DENIED",
        `Plugin '${pluginId}' is not installed and enabled for user`
      );
    }

    const pkg = this.packages.get(`${pluginId}@${inst.active_version}`);
    if (!pkg) {
      throw new ContractError("NOT_FOUND", "Active plugin package missing");
    }

    const cmdSpec = (pkg.manifest.commands || []).find((c) => c.name === commandName);
    if (!cmdSpec) {
      throw new ContractError(
        "BAD_REQUEST",
        `Command '${commandName}' is not declared in plugin manifest`
      );
    }

    if (
      cmdSpec.required_permission &&
      !(inst.granted_permissions || []).includes(cmdSpec.required_permission)
    ) {
      throw new ContractError(
        "PLUGIN_PERMISSION_DENIED",
        `Plugin '${pluginId}' lacks permission '${cmdSpec.required_permission}'`
      );
    }

    if (requestedOrigin) {
      const hasNetPerm =
        (inst.granted_permissions || []).includes("network.request") ||
        (inst.granted_permissions || []).includes("network.http.allowlist");
      if (!hasNetPerm) {
        throw new ContractError(
          "PLUGIN_PERMISSION_DENIED",
          `Plugin '${pluginId}' attempted outbound network access without 'network.request'`
        );
      }
      const allowedOrigins = pkg.manifest.allowed_origins || [];
      if (!allowedOrigins.includes(requestedOrigin)) {
        throw new ContractError(
          "PLUGIN_PERMISSION_DENIED",
          `Origin '${requestedOrigin}' is not in plugin's allowed_origins`
        );
      }
    }

    const handler = pkg.commandHandlers?.[commandName];
    if (typeof handler === "function") {
      const result = await handler({
        userId,
        pluginId,
        version: inst.active_version,
        payload
      });
      return {
        plugin_id: pluginId,
        version: inst.active_version,
        command: commandName,
        executed: true,
        output: result
      };
    }

    return {
      plugin_id: pluginId,
      version: inst.active_version,
      command: commandName,
      executed: true,
      output: {
        message: `Executed declarative command '${commandName}' on ${pluginId}@${inst.active_version}`,
        echo: payload
      }
    };
  }
}

export function loadPluginDirectory(pluginDir) {
  const manifestPath = path.join(pluginDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const artifactMap = {};
  for (const art of manifest.entry_artifacts || []) {
    const safePath = assertSafeRelativeArtifactPath(art.path);
    const fullPath = path.join(pluginDir, safePath);
    if (fs.existsSync(fullPath)) {
      artifactMap[safePath] = fs.readFileSync(fullPath);
    }
  }
  return { manifest, artifactMap };
}
