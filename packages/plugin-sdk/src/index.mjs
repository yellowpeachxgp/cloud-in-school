import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ContractError, DEFAULT_SCHOOL_ID, loadPermissionCatalog, parseJsonWithNumberLiterals } from "../../contracts/src/index.mjs";
import {
  canonicalizeJson,
  signPluginManifest,
  verifyPluginManifestSignature,
  sha256Hex
} from "../../crypto/src/index.mjs";
import {
  RUNTIME_UI_SLOTS,
  RUNTIME_VALIDATION_CODES,
  assertPluginRuntimeSchema,
  pluginManifestValidationError
} from "./runtime-contract.mjs";

// W6-00 runtime fact source: the six slots currently implemented by the cloud
// SDK and Android parser. The contracts/** matrix still contains the older,
// wider contract-surface list and is intentionally not edited by this card
// while CT-01 owns contracts/**.
export const SUPPORTED_UI_SLOTS = RUNTIME_UI_SLOTS;
export const PLUGIN_PACKAGE_SECURITY_TRUSTED = "TRUSTED";
export const PLUGIN_PACKAGE_SECURITY_COMPROMISED = "COMPROMISED";
export const PLUGIN_INSTALLATION_QUARANTINED = "QUARANTINED";

const PLUGIN_MANIFEST_JSON_PARSE_OPTIONS = Object.freeze({
  rejectDuplicateKeys: true,
  maxNumberLiteralLength: 64
});

/**
 * Parse plugin manifest source text with the same strict lexical boundaries as
 * Android's canonical JSON parser: duplicate object keys are rejected and any
 * number literal longer than 64 characters is rejected before validation.
 * Generic API JSON parsing remains intentionally unchanged; this strict mode is
 * scoped to plugin-manifest ingress.
 */
export function parsePluginManifestJson(jsonText) {
  try {
    return parseJsonWithNumberLiterals(jsonText, PLUGIN_MANIFEST_JSON_PARSE_OPTIONS);
  } catch (error) {
    throw pluginManifestValidationError(
      RUNTIME_VALIDATION_CODES.SCHEMA_INVALID,
      "Plugin manifest JSON parse failure: " + (error?.message || String(error))
    );
  }
}

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
      ...(rawManifest.signature ? { signature: rawManifest.signature } : {})
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
  const parsedInput = typeof rawManifest === "string" ? parsePluginManifestJson(rawManifest) : rawManifest;
  const manifest = adaptLegacyCampusManifest(parsedInput);

  // W6-00: validate the exact snake_case runtime shape before semantic checks.
  // The transitional schema is packages/plugin-sdk/schema/, not contracts/**;
  // the CT contract-surface slice remains explicitly pending.
  assertPluginRuntimeSchema(manifest);

  const minHost = manifest.min_host_api;
  const maxHost = manifest.max_host_api;
  if (minHost > maxHost) {
    throw pluginManifestValidationError(
      RUNTIME_VALIDATION_CODES.HOST_API_RANGE_INVALID,
      `Plugin host API range is inverted [${minHost}..${maxHost}]`,
      { min_host_api: minHost, max_host_api: maxHost }
    );
  }
  if (hostApiVersion < minHost || hostApiVersion > maxHost) {
    throw pluginManifestValidationError(
      RUNTIME_VALIDATION_CODES.HOST_API_OUT_OF_RANGE,
      `Plugin requires host API [${minHost}..${maxHost}], current host is ${hostApiVersion}`,
      { min_host_api: minHost, max_host_api: maxHost, current_host_api: hostApiVersion }
    );
  }

  // The runtime schema carries the current permission enum; this second check
  // keeps the SDK honest if the runtime schema and permission catalog drift.
  const catalog = loadPermissionCatalog();
  const validPermissions = new Set((catalog.permissions || []).map((p) => p.id));
  for (const perm of manifest.permissions || []) {
    if (!validPermissions.has(perm)) {
      throw pluginManifestValidationError(
        RUNTIME_VALIDATION_CODES.PERMISSION_UNKNOWN,
        `Plugin declares unknown or forbidden permission '${perm}'`,
        { permission: perm }
      );
    }
  }
  for (const command of manifest.commands || []) {
    if (command.required_permission && !validPermissions.has(command.required_permission)) {
      throw pluginManifestValidationError(
        RUNTIME_VALIDATION_CODES.PERMISSION_UNKNOWN,
        `Command '${command.name}' requires unknown permission '${command.required_permission}'`,
        { permission: command.required_permission, command: command.name }
      );
    }
  }

  for (const slot of manifest.ui_slots || []) {
    if (!SUPPORTED_UI_SLOTS.includes(slot.slot_id)) {
      throw pluginManifestValidationError(
        RUNTIME_VALIDATION_CODES.SLOT_UNKNOWN,
        `Unsupported UI extension slot '${slot.slot_id}'`,
        { slot_id: slot.slot_id, runtime_slots: [...SUPPORTED_UI_SLOTS] }
      );
    }
  }

  for (const art of manifest.entry_artifacts || []) {
    try {
      assertSafeRelativeArtifactPath(art.path);
    } catch (error) {
      throw pluginManifestValidationError(
        RUNTIME_VALIDATION_CODES.PATH_UNSAFE,
        error.message,
        { artifact_path: art.path }
      );
    }
    if (!/^[a-f0-9]{64}$/.test(art.sha256)) {
      throw pluginManifestValidationError(
        RUNTIME_VALIDATION_CODES.DIGEST_INVALID,
        `Invalid lowercase sha256 digest declaration for ${art.path}`,
        { artifact_path: art.path }
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

  const declaredArtifactPaths = new Set();
  for (const declared of normalized.entry_artifacts || []) {
    declaredArtifactPaths.add(assertSafeRelativeArtifactPath(declared.path));
  }
  const undeclaredArtifacts = Object.keys(artifactMap || {}).filter((artifactPath) => !declaredArtifactPaths.has(artifactPath));
  if (undeclaredArtifacts.length > 0) {
    throw new ContractError(
      "PLUGIN_SIGNATURE_INVALID",
      "Plugin artifact payload contains entries not declared in the signed manifest: " + undeclaredArtifacts.sort().join(", ")
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

function uniquePermissionList(permissions) {
  return [...new Set(Array.isArray(permissions) ? permissions : [])];
}

function intersectPermissionLists(grantedPermissions, declaredPermissions) {
  const granted = new Set(uniquePermissionList(grantedPermissions));
  return uniquePermissionList(declaredPermissions).filter((permission) => granted.has(permission));
}

function isOperationallyEnabled(installation) {
  // PENDING_PERMISSION_REVIEW means the *new* version is not active yet. The
  // previously active version must continue to run with its old grant set.
  return installation?.status === "ENABLED" || installation?.status === "PENDING_PERMISSION_REVIEW";
}

function normalizeSchoolId(schoolId = DEFAULT_SCHOOL_ID) {
  const normalized = String(schoolId || DEFAULT_SCHOOL_ID).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(normalized)) {
    throw new ContractError("BAD_REQUEST", "Invalid plugin school scope: " + normalized);
  }
  return normalized;
}

function pluginPackageKey(pluginId, version) {
  return String(pluginId) + "@" + String(version);
}

function pluginInstallationKey(userId, schoolId, pluginId) {
  return String(userId) + ":" + normalizeSchoolId(schoolId) + ":" + String(pluginId);
}

function permissionGrantKey(installationId, permission) {
  return String(installationId) + ":" + String(permission);
}

function scopedEntryKey(installationId, namespace, key) {
  return String(installationId) + ":" + String(namespace || "default") + ":" + String(key);
}

function normalizeArtifactMapForPersistence(artifactMap = {}) {
  const normalized = {};
  for (const [artifactPath, content] of Object.entries(artifactMap || {})) {
    const safePath = assertSafeRelativeArtifactPath(artifactPath);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
    normalized[safePath] = buffer.toString("base64");
  }
  return normalized;
}

function artifactMapForVerification(storedArtifactMap = {}) {
  const result = {};
  for (const [artifactPath, encoded] of Object.entries(storedArtifactMap || {})) {
    result[artifactPath] = Buffer.from(String(encoded || ""), "base64");
  }
  return result;
}

function createMemoryPluginStore() {
  const store = {
    installedPlugins: new Map(),
    pluginPublishers: new Map(),
    pluginVersions: new Map(),
    pluginInstallations: new Map(),
    pluginPermissionGrants: new Map(),
    pluginStorageEntries: new Map(),
    pluginCacheEntries: new Map(),
    pluginRuntimeStates: new Map(),
    auditEvents: [],
    saveSnapshot() {},
    recordAudit(entry) {
      const audit = {
        id: crypto.randomUUID(),
        actor_kind: entry.actor_kind || "SYSTEM",
        actor_ref: entry.actor_ref || "plugin-broker",
        action: entry.action,
        resource_kind: entry.resource_kind,
        resource_ref: entry.resource_ref,
        outcome: entry.outcome || "SUCCESS",
        detail: entry.detail || null,
        created_at: new Date().toISOString()
      };
      store.auditEvents.push(audit);
      return audit;
    }
  };
  return store;
}

function assertTrustedPublisherKeyMaterial(publisherId, publicKeyBase64) {
  if (typeof publisherId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(publisherId)) {
    throw new ContractError(
      "BAD_REQUEST",
      "Plugin trust root publisher ids must be explicit stable key_id strings"
    );
  }
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(String(publicKeyBase64 || ""), "base64"),
      format: "der",
      type: "spki"
    });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not-ed25519");
  } catch {
    throw new ContractError(
      "BAD_REQUEST",
      "Plugin trust root for publisher '" + publisherId + "' is not an Ed25519 SPKI public key"
    );
  }
}

function parseTrustedPublisherEntry(entry) {
  if (Array.isArray(entry) && entry.length === 2) {
    return [String(entry[0] || "").trim(), String(entry[1] || "").trim()];
  }
  if (entry && typeof entry === "object") {
    return [
      String(entry.publisher_id || entry.publisherId || entry.key_id || "").trim(),
      String(entry.public_key_base64 || entry.publicKeyBase64 || "").trim()
    ];
  }
  const text = String(entry || "").trim();
  const separator = text.indexOf("=");
  if (separator <= 0) {
    throw new ContractError(
      "BAD_REQUEST",
      "Plugin trust root entries must use explicit publisher=public-key mappings"
    );
  }
  return [text.slice(0, separator).trim(), text.slice(separator + 1).trim()];
}

function trustedPublisherEntriesFromString(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new ContractError(
        "BAD_REQUEST",
        "Plugin trust root JSON mapping is invalid: " + (error?.message || String(error))
      );
    }
    return Object.entries(parsed || {});
  }
  return trimmed.split(/[,\n\r\t ]+/).map((item) => item.trim()).filter(Boolean);
}

function parseTrustedPublisherKeyMap(value) {
  let entries = [];
  if (value instanceof Map) {
    entries = [...value.entries()];
  } else if (Array.isArray(value)) {
    entries = value.flatMap((item) => typeof item === "string" ? trustedPublisherEntriesFromString(item) : [item]);
  } else if (typeof value === "string") {
    entries = trustedPublisherEntriesFromString(value);
  } else if (value && typeof value === "object") {
    entries = Object.entries(value);
  }
  const result = new Map();
  for (const entry of entries) {
    const [publisherId, publicKeyBase64] = parseTrustedPublisherEntry(entry);
    assertTrustedPublisherKeyMaterial(publisherId, publicKeyBase64);
    if (result.has(publisherId) && result.get(publisherId) !== publicKeyBase64) {
      throw new ContractError(
        "BAD_REQUEST",
        "Plugin trust root contains conflicting keys for publisher '" + publisherId + "'"
      );
    }
    result.set(publisherId, publicKeyBase64);
  }
  return result;
}

function ownerIdOfInstallation(installation) {
  return installation?.cloud_user_id || installation?.user_id || null;
}

function installationResponseShape(installation) {
  if (!installation) return installation;
  return {
    ...installation,
    cloud_user_id: installation.cloud_user_id || installation.user_id,
    user_id: installation.user_id || installation.cloud_user_id,
    school_id: normalizeSchoolId(installation.school_id || DEFAULT_SCHOOL_ID)
  };
}

function canonicalManifestText(manifest) {
  try {
    return canonicalizeJson(manifest);
  } catch {
    return JSON.stringify(manifest);
  }
}

function durableManifestCopy(manifest) {
  // parsePluginManifestJson attaches non-enumerable lexical metadata used only
  // for validation. structuredClone copies the JSON data without that parser
  // metadata, keeping durable plugin records safe for the data-delete candidate
  // reconcile algorithm and for snapshot serialization.
  return structuredClone(manifest);
}

function publisherIdForManifest(manifest) {
  return manifest?.signature?.key_id || "unknown-publisher";
}

function decodeStoredArtifactText(pkg, artifactPath) {
  const encoded = pkg?.artifactMap?.[artifactPath];
  if (encoded === undefined) return null;
  return Buffer.from(String(encoded), "base64").toString("utf8");
}

const DECLARATIVE_COMMAND_TYPES = new Set(["open_host_route", "open_url", "show_data"]);
const HOST_ROUTE_ALLOWLIST = new Set([
  "home",
  "campus",
  "campus.services",
  "library",
  "parcel",
  "settings",
  "settings.plugins"
]);

function assertValidDeclarativeTarget(commandSpec, pkg) {
  if (commandSpec.type === "open_host_route") {
    const routeName = String(commandSpec.route || "").trim();
    if (!HOST_ROUTE_ALLOWLIST.has(routeName)) {
      throw new ContractError(
        "PLUGIN_COMMAND_UNSUPPORTED",
        "Declarative open_host_route target is not in the host route allowlist"
      );
    }
    return { type: "open_host_route", route: routeName };
  }
  if (commandSpec.type === "open_url") {
    const targetUrl = String(commandSpec.url || "").trim();
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      throw new ContractError("PLUGIN_COMMAND_UNSUPPORTED", "Declarative open_url target is not a valid URL");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new ContractError("PLUGIN_PERMISSION_DENIED", "Declarative open_url target must be a credential-free HTTPS URL");
    }
    const origin = parsed.origin;
    if (!(pkg?.manifest?.allowed_origins || []).includes(origin)) {
      throw new ContractError(
        "PLUGIN_PERMISSION_DENIED",
        "Origin '" + origin + "' is not in plugin's allowed_origins"
      );
    }
    return { type: "open_url", url: parsed.toString(), origin };
  }
  if (commandSpec.type === "show_data") {
    const artifactPath = String(commandSpec.artifact_path || "").trim();
    if (!artifactPath) {
      throw new ContractError("PLUGIN_COMMAND_UNSUPPORTED", "Declarative show_data command lacks artifact_path");
    }
    const safePath = assertSafeRelativeArtifactPath(artifactPath);
    const declared = (pkg?.manifest?.entry_artifacts || []).some((artifact) => artifact.path === safePath);
    if (!declared) {
      throw new ContractError(
        "PLUGIN_PERMISSION_DENIED",
        "show_data artifact is not part of the signed plugin package"
      );
    }
    const dataText = decodeStoredArtifactText(pkg, safePath);
    if (dataText === null) {
      throw new ContractError("NOT_FOUND", "Signed plugin data artifact is unavailable");
    }
    return { type: "show_data", artifact_path: safePath, data_text: dataText };
  }
  throw new ContractError(
    "PLUGIN_COMMAND_UNSUPPORTED",
    "Unsupported plugin command type: " + String(commandSpec.type || "missing")
  );
}

export class PluginRegistryAndBroker {
  constructor(options = {}) {
    if (Object.prototype.hasOwnProperty.call(options, "privateKeyBase64")) {
      throw new ContractError(
        "BAD_REQUEST",
        "Plugin broker must not be configured with publisher private keys"
      );
    }
    const {
      publicKeyBase64 = null,
      hostApiVersion = 2,
      store = null,
      environment = process.env.NODE_ENV || "development",
      trustedPublisherKeys = null,
      allowUnlistedPublishers = null,
      failureThreshold = 3
    } = options;
    this.hostApiVersion = hostApiVersion;
    this.environment = environment;
    this.trustedPublisherKeyById = parseTrustedPublisherKeyMap(
      trustedPublisherKeys ?? process.env.PLUGIN_TRUSTED_PUBLISHER_KEYS ?? ""
    );
    // Kept only as a read-only compatibility view of trusted key material. Trust
    // decisions are always keyed by publisher id, never by an unscoped key set.
    this.trustedPublisherKeys = new Set(this.trustedPublisherKeyById.values());
    // A constructor public key is only a non-production direct-registration
    // fallback. It is never a trust-root entry and never becomes an HTTP input.
    this.publisherKeyFallbackBase64 = publicKeyBase64;
    this.publicKeyBase64 = null;
    this.allowUnlistedPublishers = allowUnlistedPublishers !== null
      ? Boolean(allowUnlistedPublishers)
      : this.environment !== "production";
    this.failureThreshold = Math.max(1, Number(failureThreshold || 3));

    this.store = store || createMemoryPluginStore();
    this.installedPlugins = this.store.installedPlugins;
    this.pluginPublishers = this.store.pluginPublishers;
    this.packages = this.store.pluginVersions;
    this.userInstallations = this.store.pluginInstallations;
    this.pluginPermissionGrants = this.store.pluginPermissionGrants;
    this.pluginStorageEntries = this.store.pluginStorageEntries;
    this.pluginCacheEntries = this.store.pluginCacheEntries;
    this.pluginRuntimeStates = this.store.pluginRuntimeStates;

    // Volatile host-owned reference handlers only. They are intentionally not
    // persisted and are never deserialized from plugin artifacts.
    this.commandHandlersByPackage = new Map();
    // Successful cryptographic verification cache. Keys always include a digest
    // of the exact persisted manifest + artifact payload bytes plus the effective
    // trust-root key, so any post-cache mutation forces a fresh verification.
    this.packageVerificationCache = new Map();
    this.packageVerificationCacheLimit = 256;
    this.latestVersionByPlugin = new Map();
    this.versionsByPlugin = new Map();
    this.ownerKeyByPlugin = new Map();
    this.ownerUserByPlugin = new Map();

    this._migrateLegacyInstallations();
    this._rebuildRegistryIndexes();
  }

  _persist() {
    this.store.saveSnapshot?.();
  }

  _audit(entry) {
    return this.store.recordAudit?.({
      actor_kind: "SYSTEM",
      actor_ref: "plugin-broker",
      outcome: "SUCCESS",
      ...entry
    });
  }

  _migrateLegacyInstallations() {
    let mutated = false;
    for (const [key, installation] of Array.from(this.userInstallations.entries())) {
      const parts = String(key).split(":");
      if (parts.length === 2) {
        const userId = parts[0];
        const pluginId = parts[1];
        const schoolId = normalizeSchoolId(installation?.school_id || DEFAULT_SCHOOL_ID);
        this.userInstallations.delete(key);
        const migrated = installationResponseShape({ ...installation, school_id: schoolId });
        this.userInstallations.set(pluginInstallationKey(userId, schoolId, pluginId), migrated);
        mutated = true;
      } else if (installation && !installation.school_id) {
        installation.school_id = DEFAULT_SCHOOL_ID;
        mutated = true;
      }
    }
    if (mutated) this._persist();
  }

  _rebuildRegistryIndexes() {
    this.latestVersionByPlugin.clear();
    this.versionsByPlugin.clear();
    this.ownerKeyByPlugin.clear();
    this.ownerUserByPlugin.clear();
    let markedTrusted = false;
    for (const [key, pkg] of this.packages.entries()) {
      const pluginId = pkg?.plugin_id || pkg?.manifest?.plugin_id;
      const version = pkg?.version || pkg?.manifest?.version;
      if (!pluginId || !version) continue;
      try {
        // Snapshot contents are durable data, not proof of trust. Re-resolve the
        // publisher through the current configured root and re-verify the stored
        // signed payload before making a restored version installable. Failure is
        // not just an index skip: the version and its active installations enter
        // explicit quarantine so later invoke/UI paths cannot read them as active.
        this._verifyStoredPackageIntegrityOrQuarantine(pkg, {
          packageKey: key,
          source: "restart-restore"
        });
      } catch {
        // Revoked, re-keyed, or tampered packages fail closed: they remain in the
        // durable snapshot for audit/forensics but receive no runtime index.
        continue;
      }
      if (!pkg.security_state) {
        pkg.security_state = PLUGIN_PACKAGE_SECURITY_TRUSTED;
        this.packages.set(key, pkg);
        markedTrusted = true;
      }
      const list = this.versionsByPlugin.get(pluginId) || [];
      if (!list.includes(version)) list.push(version);
      this.versionsByPlugin.set(pluginId, list);
      this.latestVersionByPlugin.set(pluginId, version);
      if (pkg.public_key_base64 && !this.ownerKeyByPlugin.has(pluginId)) {
        this.ownerKeyByPlugin.set(pluginId, pkg.public_key_base64);
      }
      if (pkg.registered_by_cloud_user_id && !this.ownerUserByPlugin.has(pluginId)) {
        this.ownerUserByPlugin.set(pluginId, pkg.registered_by_cloud_user_id);
      }
    }
    if (markedTrusted) this._persist();
  }

  trustedPublicKeyForPublisher(publisherId) {
    return this.trustedPublisherKeyById.get(String(publisherId || "")) || null;
  }

  _packageVerificationCacheKey(pkg, verificationKey) {
    const artifactParts = [];
    for (const artifactPath of Object.keys(pkg?.artifactMap || {}).sort()) {
      artifactParts.push(artifactPath + "\u0000" + String(pkg.artifactMap[artifactPath]));
    }
    const contentDigest = sha256Hex(Buffer.from([
      canonicalManifestText(pkg?.manifest || {}),
      artifactParts.join("\u0001"),
      String(pkg?.plugin_id || ""),
      String(pkg?.version || ""),
      String(pkg?.publisher_id || ""),
      String(pkg?.signature_base64 || ""),
      String(pkg?.public_key_base64 || "")
    ].join("\u0002"), "utf8"));
    // The content digest is mandatory: a verification hit is valid only for the
    // exact bytes that were verified. Trust-root key and host API are included so
    // configuration changes cannot reuse a stale positive decision.
    return [this.hostApiVersion, verificationKey, contentDigest].join(":");
  }

  _cachePackageVerification(cacheKey, normalizedManifest) {
    if (this.packageVerificationCache.size >= this.packageVerificationCacheLimit) {
      const oldestKey = this.packageVerificationCache.keys().next().value;
      this.packageVerificationCache.delete(oldestKey);
    }
    this.packageVerificationCache.set(cacheKey, normalizedManifest);
  }

  _verifyStoredPackageIntegrityCached(pkg) {
    const publisherId = publisherIdForManifest(pkg?.manifest || {});
    const verificationKey = this._publisherKeyForRegistration(
      publisherId,
      pkg?.public_key_base64 || null
    );
    const cacheKey = this._packageVerificationCacheKey(pkg, verificationKey);
    if (this.packageVerificationCache.has(cacheKey)) {
      return this.packageVerificationCache.get(cacheKey);
    }
    const normalized = this._verifyStoredPackageIntegrity(pkg, {
      publisherId,
      verificationKey
    });
    this._cachePackageVerification(cacheKey, normalized);
    return normalized;
  }

  _verifyStoredPackageIntegrityOrQuarantine(pkg, { packageKey = null, source = "runtime-use" } = {}) {
    const hadQuarantineState = Boolean(
      pkg?.security_state && pkg.security_state !== PLUGIN_PACKAGE_SECURITY_TRUSTED
    );
    try {
      // Even a previously quarantined record is re-proven from bytes rather than
      // trusted because of its marker. If the exact signed content later verifies
      // again, the package may leave quarantine; the historical compromise audit
      // remains durable. This keeps fail-closed tamper handling without turning a
      // repaired valid signed package into a permanent immutable-version brick.
      const normalized = this._verifyStoredPackageIntegrityCached(pkg);
      if (hadQuarantineState && pkg?.security_state !== PLUGIN_PACKAGE_SECURITY_TRUSTED) {
        pkg.security_state = PLUGIN_PACKAGE_SECURITY_TRUSTED;
        delete pkg.security_reason;
        delete pkg.security_failure_message;
        delete pkg.quarantined_at;
        delete pkg.quarantine_source;
        if (packageKey) this.packages.set(packageKey, pkg);
        this._audit({
          action: "PLUGIN_PACKAGE_QUARANTINE_RELEASED",
          resource_kind: "plugin_version",
          resource_ref: packageKey || pluginPackageKey(pkg.plugin_id, pkg.version),
          detail: {
            plugin_id: pkg.plugin_id || normalized.plugin_id,
            version: pkg.version || normalized.version,
            source
          }
        });
        this._persist();
      }
      return normalized;
    } catch (error) {
      this._quarantinePackage(pkg, error, { packageKey, source });
      throw error;
    }
  }

  _quarantinePackage(pkg, error, { packageKey = null, source = "runtime-use" } = {}) {
    if (!pkg || typeof pkg !== "object") {
      return { package_key: null, quarantined_installations: [] };
    }
    const pluginId = pkg.plugin_id || pkg.manifest?.plugin_id || "unknown-plugin";
    const version = pkg.version || pkg.manifest?.version || "unknown-version";
    const key = packageKey || pluginPackageKey(pluginId, version);
    const nowIso = new Date().toISOString();
    const firstTransition = pkg.security_state !== PLUGIN_PACKAGE_SECURITY_COMPROMISED;
    if (firstTransition) {
      pkg.security_state = PLUGIN_PACKAGE_SECURITY_COMPROMISED;
      pkg.security_reason = error?.code || "PLUGIN_SIGNATURE_INVALID";
      pkg.security_failure_message = String(error?.message || "persisted plugin package verification failed").slice(0, 240);
      pkg.quarantined_at = nowIso;
      pkg.quarantine_source = source;
      this.packages.set(key, pkg);
    }

    // Restore-time isolation is explicit installation state. Runtime invoke/UI
    // detection also fails closed on every use, but does not rewrite the user's
    // installation state underneath lifecycle operations; this preserves the
    // reviewed activation/revoke/rollback semantics once the exact signed bytes
    // verify again.
    const shouldQuarantineInstallations = source === "restart-restore";
    const newlyQuarantined = [];
    for (const [installationKey, installation] of this.userInstallations.entries()) {
      if (!shouldQuarantineInstallations) break;
      if (installation?.plugin_id !== pluginId || installation?.active_version !== version) continue;
      if (installation.status === PLUGIN_INSTALLATION_QUARANTINED) continue;
      const shaped = installationResponseShape({
        ...installation,
        pre_quarantine_status: installation.status,
        status: PLUGIN_INSTALLATION_QUARANTINED,
        quarantine_reason: "ACTIVE_PACKAGE_COMPROMISED",
        quarantined_at: nowIso,
        updated_at: nowIso
      });
      this.userInstallations.set(installationKey, shaped);
      this._syncPermissionGrantRows(shaped);
      newlyQuarantined.push(shaped);
    }

    if (firstTransition) {
      this._audit({
        action: "PLUGIN_PACKAGE_QUARANTINED",
        resource_kind: "plugin_version",
        resource_ref: key,
        outcome: "FAIL_CLOSED",
        detail: {
          plugin_id: pluginId,
          version,
          security_state: PLUGIN_PACKAGE_SECURITY_COMPROMISED,
          reason: pkg.security_reason,
          source,
          quarantined_installations: newlyQuarantined.length
        }
      });
    }
    for (const installation of newlyQuarantined) {
      this._audit({
        action: "PLUGIN_INSTALLATION_QUARANTINED",
        resource_kind: "plugin_installation",
        resource_ref: installation.installation_id,
        outcome: "FAIL_CLOSED",
        detail: {
          plugin_id: pluginId,
          version,
          school_id: installation.school_id,
          installation_status: PLUGIN_INSTALLATION_QUARANTINED,
          reason: "ACTIVE_PACKAGE_COMPROMISED",
          source
        }
      });
    }
    if (firstTransition || newlyQuarantined.length > 0) this._persist();
    return {
      package_key: key,
      quarantined_installations: newlyQuarantined.map((installation) => installation.installation_id)
    };
  }

  _verifyStoredPackageIntegrity(pkg, { publisherId = null, verificationKey = null } = {}) {
    const effectivePublisherId = publisherId || publisherIdForManifest(pkg?.manifest || {});
    const effectiveVerificationKey = verificationKey || this._publisherKeyForRegistration(
      effectivePublisherId,
      pkg?.public_key_base64 || null
    );
    const normalized = verifySignedPluginPackage({
      manifest: pkg?.manifest,
      artifactMap: artifactMapForVerification(pkg?.artifactMap || {}),
      publicKeyBase64: effectiveVerificationKey,
      hostApiVersion: this.hostApiVersion
    });
    if (pkg?.plugin_id && pkg.plugin_id !== normalized.plugin_id) {
      throw new ContractError(
        "PLUGIN_SIGNATURE_INVALID",
        "Persisted plugin version record plugin_id does not match its signed manifest"
      );
    }
    if (pkg?.version && pkg.version !== normalized.version) {
      throw new ContractError(
        "PLUGIN_SIGNATURE_INVALID",
        "Persisted plugin version record version does not match its signed manifest"
      );
    }
    if (pkg?.publisher_id && pkg.publisher_id !== publisherIdForManifest(normalized)) {
      throw new ContractError(
        "PLUGIN_SIGNATURE_INVALID",
        "Persisted plugin version record publisher does not match its signed manifest"
      );
    }
    const normalizedSignature = typeof normalized.signature === "string"
      ? normalized.signature
      : normalized.signature?.value_base64 || "";
    if (pkg?.signature_base64 && normalizedSignature && pkg.signature_base64 !== normalizedSignature) {
      throw new ContractError(
        "PLUGIN_SIGNATURE_INVALID",
        "Persisted plugin version signature metadata does not match its signed manifest"
      );
    }
    return normalized;
  }

  _publisherKeyForRegistration(publisherId, suppliedPublicKeyBase64 = null) {
    const normalizedPublisherId = String(publisherId || "").trim();
    const trustedKey = this.trustedPublicKeyForPublisher(normalizedPublisherId);
    const pinnedKey = this.pluginPublishers.get(normalizedPublisherId)?.public_key_base64 || null;
    if (trustedKey) {
      if (pinnedKey && pinnedKey !== trustedKey) {
        throw new ContractError(
          "PLUGIN_SIGNATURE_INVALID",
          "Configured publisher trust root conflicts with the pinned publisher key"
        );
      }
      if (suppliedPublicKeyBase64 && suppliedPublicKeyBase64 !== trustedKey) {
        throw new ContractError(
          "PLUGIN_SIGNATURE_INVALID",
          "Supplied publisher key does not match the configured trust root"
        );
      }
      return trustedKey;
    }
    if (!this.allowUnlistedPublishers) {
      throw new ContractError(
        "PLUGIN_SIGNATURE_INVALID",
        "Plugin publisher '" + normalizedPublisherId + "' is not in the configured trust root"
      );
    }
    if (pinnedKey) {
      if (suppliedPublicKeyBase64 && suppliedPublicKeyBase64 !== pinnedKey) {
        throw new ContractError(
          "PLUGIN_SIGNATURE_INVALID",
          "Plugin publisher key_id is pinned to a different public key"
        );
      }
      return pinnedKey;
    }
    if (suppliedPublicKeyBase64) return suppliedPublicKeyBase64;
    throw new ContractError(
      "PLUGIN_SIGNATURE_INVALID",
      "No trusted public key is configured for publisher '" + normalizedPublisherId + "'"
    );
  }

  _runtimeState(pluginId) {
    const existing = this.pluginRuntimeStates.get(pluginId);
    if (existing) return existing;
    return {
      plugin_id: pluginId,
      failure_count: 0,
      consecutive_failure_count: 0,
      auto_disabled: false,
      disabled_reason: null,
      kill_switch: false,
      kill_switch_reason: null,
      updated_at: new Date().toISOString()
    };
  }

  _saveRuntimeState(state) {
    state.updated_at = new Date().toISOString();
    this.pluginRuntimeStates.set(state.plugin_id, state);
    this._persist();
    return state;
  }

  _syncPermissionGrantRows(installation) {
    const installationId = installation.installation_id;
    const nowIso = new Date().toISOString();
    const active = new Set(uniquePermissionList(installation.granted_permissions));
    for (const [key, row] of Array.from(this.pluginPermissionGrants.entries())) {
      if (row?.installation_id !== installationId) continue;
      if (!active.has(row.permission) && !row.revoked_at) {
        row.revoked_at = nowIso;
        this.pluginPermissionGrants.set(key, row);
      }
    }
    for (const permission of active) {
      const key = permissionGrantKey(installationId, permission);
      const existing = this.pluginPermissionGrants.get(key);
      if (!existing) {
        this.pluginPermissionGrants.set(key, {
          installation_id: installationId,
          permission,
          granted_at: nowIso,
          revoked_at: null
        });
      } else if (existing.revoked_at) {
        existing.revoked_at = null;
        existing.granted_at = nowIso;
        this.pluginPermissionGrants.set(key, existing);
      }
    }
  }

  _saveInstallation(key, installation) {
    const shaped = installationResponseShape(installation);
    this.userInstallations.set(key, shaped);
    this._syncPermissionGrantRows(shaped);
    this._persist();
    return shaped;
  }

  _deleteInstallationData(installation) {
    const installationId = installation.installation_id;
    const counts = {
      permission_grants: 0,
      storage_entries: 0,
      cache_entries: 0
    };
    for (const [key, row] of Array.from(this.pluginPermissionGrants.entries())) {
      if (row?.installation_id === installationId) {
        this.pluginPermissionGrants.delete(key);
        counts.permission_grants += 1;
      }
    }
    for (const [key, row] of Array.from(this.pluginStorageEntries.entries())) {
      if (row?.installation_id === installationId) {
        this.pluginStorageEntries.delete(key);
        counts.storage_entries += 1;
      }
    }
    for (const [key, row] of Array.from(this.pluginCacheEntries.entries())) {
      if (row?.installation_id === installationId) {
        this.pluginCacheEntries.delete(key);
        counts.cache_entries += 1;
      }
    }
    return counts;
  }

  _findInstallation(userId, pluginId, schoolId = null) {
    if (schoolId) {
      const key = pluginInstallationKey(userId, schoolId, pluginId);
      const installation = this.userInstallations.get(key);
      return installation ? { key, installation } : null;
    }
    const defaultKey = pluginInstallationKey(userId, DEFAULT_SCHOOL_ID, pluginId);
    if (this.userInstallations.has(defaultKey)) {
      return { key: defaultKey, installation: this.userInstallations.get(defaultKey) };
    }
    const matches = [];
    for (const [key, installation] of this.userInstallations.entries()) {
      if (ownerIdOfInstallation(installation) === userId && installation?.plugin_id === pluginId) {
        matches.push({ key, installation });
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new ContractError(
        "BAD_REQUEST",
        "Plugin installation is ambiguous across school scopes; pass school_id"
      );
    }
    return null;
  }

  registerPluginPackage({
    manifest,
    artifactMap = {},
    commandHandlers = {},
    publicKeyBase64 = null,
    actorUserId = null,
    isAdmin = false,
    isHostReference = false
  }) {
    const schemaValidatedManifest = validatePluginManifest(manifest, {
      hostApiVersion: this.hostApiVersion
    });
    const publisherId = publisherIdForManifest(schemaValidatedManifest);
    // isHostReference intentionally has no trust bypass: host examples and
    // third-party packages use the same publisher-id keyed trust decision.
    void isHostReference;
    publicKeyBase64 = this._publisherKeyForRegistration(
      publisherId,
      publicKeyBase64 || this.publisherKeyFallbackBase64 || null
    );
    const persistedArtifacts = normalizeArtifactMapForPersistence(artifactMap);
    const verified = verifySignedPluginPackage({
      manifest: schemaValidatedManifest,
      artifactMap: artifactMapForVerification(persistedArtifacts),
      publicKeyBase64,
      hostApiVersion: this.hostApiVersion
    });
    const pluginId = verified.plugin_id;
    const version = verified.version;
    const key = pluginPackageKey(pluginId, version);

    const existingPublisher = this.pluginPublishers.get(publisherId);
    if (existingPublisher && existingPublisher.public_key_base64 !== publicKeyBase64) {
      throw new ContractError(
        "PLUGIN_SIGNATURE_INVALID",
        "Plugin publisher key_id is pinned to a different public key"
      );
    }

    const existingKey = this.ownerKeyByPlugin.get(pluginId);
    if (existingKey && existingKey !== publicKeyBase64 && !isAdmin) {
      throw new ContractError(
        "PLUGIN_SIGNATURE_INVALID",
        "Plugin '" + pluginId + "' is pinned to a different signing public key"
      );
    }
    const existingOwner = this.ownerUserByPlugin.get(pluginId);
    if (existingOwner && actorUserId && existingOwner !== actorUserId && !isAdmin) {
      throw new ContractError(
        "FORBIDDEN",
        "Plugin '" + pluginId + "' is owned by another publisher"
      );
    }

    const existingPackage = this.packages.get(key);
    if (existingPackage) {
      // Re-registration is also a use of durable state. A tampered persisted copy
      // must be quarantined and rejected before any immutable-version comparison;
      // a valid incoming copy never silently repairs or overwrites that evidence.
      this._verifyStoredPackageIntegrityOrQuarantine(existingPackage, {
        packageKey: key,
        source: "registration"
      });
      if (
        existingPackage.public_key_base64 !== publicKeyBase64 ||
        canonicalManifestText(existingPackage.manifest) !== canonicalManifestText(verified)
      ) {
        throw new ContractError(
          "CONFLICT",
          "Signed plugin version is immutable and conflicts with the persisted version"
        );
      }
      if (Object.keys(commandHandlers || {}).length > 0) {
        this.commandHandlersByPackage.set(key, { ...commandHandlers });
      }
      return existingPackage.manifest;
    }

    if (!existingPublisher) {
      this.pluginPublishers.set(publisherId, {
        publisher_id: publisherId,
        public_key_base64: publicKeyBase64,
        owner_cloud_user_id: actorUserId || null,
        status: "ACTIVE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }
    const registryNowIso = new Date().toISOString();
    const existingRegistryRoot = this.installedPlugins.get(pluginId);
    const durableManifest = durableManifestCopy(verified);
    this.installedPlugins.set(pluginId, {
      plugin_id: pluginId,
      format: verified.schema_version,
      version,
      publisher: publisherId,
      lifecycle_state: "REGISTERED",
      manifest_json: durableManifest,
      previous_manifest_json: existingRegistryRoot?.manifest_json || null,
      signature_base64: verified.signature?.value_base64 || "",
      public_key_base64: publicKeyBase64,
      installed_at: existingRegistryRoot?.installed_at || registryNowIso,
      updated_at: registryNowIso
    });
    if (!existingKey) this.ownerKeyByPlugin.set(pluginId, publicKeyBase64);
    if (!existingOwner && actorUserId) this.ownerUserByPlugin.set(pluginId, actorUserId);

    const record = {
      plugin_id: pluginId,
      version,
      publisher_id: publisherId,
      manifest: durableManifest,
      artifactMap: persistedArtifacts,
      signature_base64: verified.signature?.value_base64 || "",
      public_key_base64: publicKeyBase64,
      security_state: PLUGIN_PACKAGE_SECURITY_TRUSTED,
      registered_by_cloud_user_id: actorUserId || null,
      registered_at: new Date().toISOString()
    };
    this.packages.set(key, record);
    if (Object.keys(commandHandlers || {}).length > 0) {
      this.commandHandlersByPackage.set(key, { ...commandHandlers });
    }

    const list = this.versionsByPlugin.get(pluginId) || [];
    if (!list.includes(version)) list.push(version);
    this.versionsByPlugin.set(pluginId, list);
    this.latestVersionByPlugin.set(pluginId, version);
    this._persist();
    this._audit({
      actor_kind: actorUserId ? "USER" : "SYSTEM",
      actor_ref: actorUserId || "plugin-broker",
      action: "REGISTER_PLUGIN_VERSION",
      resource_kind: "plugin_version",
      resource_ref: key,
      detail: { plugin_id: pluginId, version, publisher_id: publisherId }
    });
    return verified;
  }

  listAvailablePlugins() {
    const result = [];
    for (const [pluginId, latestVer] of this.latestVersionByPlugin.entries()) {
      const pkg = this.packages.get(pluginPackageKey(pluginId, latestVer));
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

  installPluginForUser(userId, pluginId, { version = null, schoolId = DEFAULT_SCHOOL_ID, publicKeyBase64 = null } = {}) {
    const scopedSchoolId = normalizeSchoolId(schoolId);
    const targetVersion = version || this.latestVersionByPlugin.get(pluginId);
    if (!targetVersion) {
      throw new ContractError("NOT_FOUND", "Plugin '" + pluginId + "' not found");
    }
    const pkg = this.packages.get(pluginPackageKey(pluginId, targetVersion));
    if (!pkg) {
      throw new ContractError("NOT_FOUND", "Plugin '" + pluginId + "@" + targetVersion + "' not found");
    }
    // Installation is an activation decision, not a cache read. Re-prove the
    // exact persisted signed package against the current trust root and every
    // declared artifact digest before deriving permissions or changing state,
    // including when the caller explicitly selects a version.
    this._verifyStoredPackageIntegrityOrQuarantine(pkg, {
      packageKey: pluginPackageKey(pluginId, targetVersion),
      source: "install"
    });
    if (publicKeyBase64 !== null && publicKeyBase64 !== undefined) {
      const publisherId = publisherIdForManifest(pkg.manifest);
      const effectivePublisherKey = this._publisherKeyForRegistration(
        publisherId,
        pkg.public_key_base64 || null
      );
      if (publicKeyBase64 !== effectivePublisherKey) {
        throw new ContractError(
          "PLUGIN_SIGNATURE_INVALID",
          "Supplied publisher key does not match the effective publisher trust root or pinned key"
        );
      }
    }

    const installKey = pluginInstallationKey(userId, scopedSchoolId, pluginId);
    const existing = this.userInstallations.get(installKey);
    const nowIso = new Date().toISOString();
    const targetPermissions = uniquePermissionList(pkg.manifest.permissions);

    if (!existing) {
      // Initial installation is the user's explicit consent point. Upgrades are
      // treated differently below: newly declared permissions are never granted
      // silently while an older version continues to run.
      const record = installationResponseShape({
        installation_id: crypto.randomUUID(),
        cloud_user_id: userId,
        user_id: userId,
        school_id: scopedSchoolId,
        plugin_id: pluginId,
        active_version: targetVersion,
        previous_version: null,
        pending_version: null,
        pending_permissions: [],
        status: "ENABLED",
        granted_permissions: targetPermissions,
        installed_at: nowIso,
        updated_at: nowIso
      });
      this._saveInstallation(installKey, record);
      this._audit({
        actor_kind: "USER",
        actor_ref: userId,
        action: "INSTALL_PLUGIN",
        resource_kind: "plugin_installation",
        resource_ref: record.installation_id,
        detail: { plugin_id: pluginId, school_id: scopedSchoolId, version: targetVersion }
      });
      return record;
    }

    if (existing.status === PLUGIN_INSTALLATION_QUARANTINED) {
      throw new ContractError(
        "PLUGIN_PERMISSION_DENIED",
        "Plugin installation is quarantined after persisted package integrity failure; uninstall it before any new installation"
      );
    }

    const currentGranted = uniquePermissionList(existing.granted_permissions);
    const addedPermissions = targetPermissions.filter((permission) => !currentGranted.includes(permission));

    if (addedPermissions.length > 0) {
      // Fail-closed upgrade path (W6-HOTFIX/S1): keep the old active version
      // and its already-approved grant set until the user explicitly confirms
      // the permission delta. Never mix the new version with partial new grants.
      const record = {
        ...existing,
        active_version: existing.active_version,
        previous_version: existing.previous_version || null,
        pending_version: targetVersion,
        pending_permissions: addedPermissions,
        // A disabled installation must stay disabled while the upgrade is
        // staged. Its first explicit ENABLE resumes the review state; it does
        // not confirm the new permissions by itself.
        status: existing.status === "DISABLED" ? "DISABLED" : "PENDING_PERMISSION_REVIEW",
        granted_permissions: currentGranted,
        updated_at: nowIso
      };
      return this._saveInstallation(installKey, record);
    }

    const record = {
      ...existing,
      active_version: targetVersion,
      previous_version:
        existing.active_version !== targetVersion
          ? existing.active_version
          : existing.previous_version || null,
      pending_version: null,
      pending_permissions: [],
      // Reinstalling or applying a same-permission upgrade must never reactivate
      // a disabled installation. Only an explicit lifecycle ENABLE may do that.
      status: existing.status === "DISABLED" ? "DISABLED" : "ENABLED",
      // Permission grants are always the approved set intersected with what the
      // active version actually declares; a silent re-install must not re-grant
      // permissions that are no longer declared or approved.
      granted_permissions: intersectPermissionLists(currentGranted, targetPermissions),
      updated_at: nowIso
    };
    return this._saveInstallation(installKey, record);
  }

  confirmPendingPluginPermissions(userId, pluginId, { schoolId = null } = {}) {
    const found = this._findInstallation(userId, pluginId, schoolId);
    if (!found) {
      throw new ContractError("NOT_FOUND", "Plugin '" + pluginId + "' is not installed for user");
    }
    const { key: installKey, installation: inst } = found;
    if (inst.status !== "PENDING_PERMISSION_REVIEW" || !inst.pending_version) {
      throw new ContractError("BAD_REQUEST", "Plugin '" + pluginId + "' has no pending permission review");
    }
    const pendingPkg = this.packages.get(pluginPackageKey(pluginId, inst.pending_version));
    if (!pendingPkg) {
      throw new ContractError(
        "BAD_REQUEST",
        "Pending plugin version '" + pluginId + "@" + inst.pending_version + "' is no longer available"
      );
    }
    // Confirmation activates the pending package. Apply the same fail-closed
    // standard as rollback: re-resolve the publisher through the current trust
    // root, re-verify the signature, and re-check every declared artifact before
    // touching the active version or grant set.
    this._verifyStoredPackageIntegrityOrQuarantine(pendingPkg, {
      packageKey: pluginPackageKey(pluginId, inst.pending_version),
      source: "permission-confirmation"
    });
    const nowIso = new Date().toISOString();
    const targetPermissions = uniquePermissionList(pendingPkg.manifest.permissions);
    const confirmed = {
      ...inst,
      previous_version:
        inst.active_version !== inst.pending_version ? inst.active_version : inst.previous_version || null,
      active_version: inst.pending_version,
      pending_version: null,
      pending_permissions: [],
      status: "ENABLED",
      // Confirmation approves the complete permission set declared by the
      // pending version, including the previously granted permissions it keeps.
      granted_permissions: targetPermissions,
      updated_at: nowIso
    };
    return this._saveInstallation(installKey, confirmed);
  }

  transitionUserPlugin(userId, pluginId, {
    action,
    targetVersion = null,
    permission = null,
    schoolId = null,
    actorIsAdmin = false,
    reason = null
  }) {
    const found = this._findInstallation(userId, pluginId, schoolId);
    if (!found) {
      throw new ContractError("NOT_FOUND", "Plugin '" + pluginId + "' is not installed for user");
    }
    const { key: installKey, installation: inst } = found;
    const nowIso = new Date().toISOString();

    if (inst.status === PLUGIN_INSTALLATION_QUARANTINED && action !== "UNINSTALL") {
      throw new ContractError(
        "PLUGIN_PERMISSION_DENIED",
        "Plugin installation is quarantined after persisted package integrity failure; only UNINSTALL cleanup is allowed"
      );
    }

    if (action === "ENABLE") {
      // PENDING_PERMISSION_REVIEW is a distinct approval gate. In that state
      // the lifecycle ENABLE action is the explicit user confirmation.
      if (inst.status === "PENDING_PERMISSION_REVIEW") {
        return this.confirmPendingPluginPermissions(userId, pluginId, { schoolId });
      }
      // Disabling pauses a pending review. The first ENABLE from DISABLED only
      // resumes the review state with the old version and old grant set; a
      // second ENABLE while PENDING_PERMISSION_REVIEW is the explicit confirmation
      // that authorizes the pending version. ENABLE must never silently confirm
      // or discard the pending permission delta.
      inst.status = inst.pending_version ? "PENDING_PERMISSION_REVIEW" : "ENABLED";
      inst.updated_at = nowIso;
      return this._saveInstallation(installKey, inst);
    }
    if (action === "DISABLE") {
      inst.status = "DISABLED";
      inst.updated_at = nowIso;
      return this._saveInstallation(installKey, inst);
    }
    if (action === "REVOKE_PERMISSION") {
      if (!permission || typeof permission !== "string") {
        throw new ContractError("BAD_REQUEST", "REVOKE_PERMISSION requires a permission field");
      }
      const activePkg = this.packages.get(pluginPackageKey(pluginId, inst.active_version));
      if (!activePkg) {
        throw new ContractError("NOT_FOUND", "Active plugin package missing for permission revocation");
      }
      // Revocation interprets the active manifest, so the persisted package must
      // first re-prove publisher trust, signature validity, and all declared
      // artifact digests. Tampering therefore fails closed without changing grants.
      this._verifyStoredPackageIntegrityOrQuarantine(activePkg, {
        packageKey: pluginPackageKey(pluginId, inst.active_version),
        source: "permission-revocation"
      });
      if (!(activePkg.manifest.permissions || []).includes(permission)) {
        throw new ContractError(
          "BAD_REQUEST",
          "Permission '" + permission + "' is not declared by the active plugin version"
        );
      }
      inst.granted_permissions = uniquePermissionList(inst.granted_permissions).filter((item) => item !== permission);
      inst.updated_at = nowIso;
      const saved = this._saveInstallation(installKey, inst);
      this._audit({
        actor_kind: actorIsAdmin ? "ADMIN" : "USER",
        actor_ref: userId,
        action: "REVOKE_PLUGIN_PERMISSION",
        resource_kind: "plugin_installation",
        resource_ref: inst.installation_id,
        detail: { plugin_id: pluginId, permission, reason: reason || null }
      });
      return saved;
    }
    if (action === "ROLLBACK") {
      const rollbackVer = targetVersion || inst.previous_version;
      const rollbackPkg = rollbackVer ? this.packages.get(pluginPackageKey(pluginId, rollbackVer)) : null;
      if (!rollbackVer || !rollbackPkg) {
        throw new ContractError(
          "BAD_REQUEST",
          "No valid rollback version available for plugin '" + pluginId + "'"
        );
      }
      // Rollback must re-prove the exact target package before activation. The
      // persisted copy is durable evidence, not trusted input: a revoked publisher,
      // tampered manifest, missing artifact, or digest mismatch makes rollback
      // fail closed without changing the currently active version.
      this._verifyStoredPackageIntegrityOrQuarantine(rollbackPkg, {
        packageKey: pluginPackageKey(pluginId, rollbackVer),
        source: "rollback"
      });
      const rollbackPermissions = uniquePermissionList(rollbackPkg.manifest.permissions);
      inst.previous_version = inst.active_version;
      inst.active_version = rollbackVer;
      inst.pending_version = null;
      inst.pending_permissions = [];
      // W6-HOTFIX/S2: rollback is fail-closed. Grants that only existed for the
      // newer version are removed immediately; the surviving set is exactly
      // granted ∩ target-version-declared.
      inst.granted_permissions = intersectPermissionLists(inst.granted_permissions, rollbackPermissions);
      // Rollback changes the selected version, not the user's enablement intent.
      // A disabled installation remains disabled until an explicit ENABLE.
      inst.status = inst.status === "DISABLED" ? "DISABLED" : "ENABLED";
      inst.updated_at = nowIso;
      return this._saveInstallation(installKey, inst);
    }
    if (action === "UNINSTALL") {
      const cleanup = this._deleteInstallationData(inst);
      this.userInstallations.delete(installKey);
      this._persist();
      this._audit({
        actor_kind: actorIsAdmin ? "ADMIN" : "USER",
        actor_ref: userId,
        action: "UNINSTALL_PLUGIN",
        resource_kind: "plugin_installation",
        resource_ref: inst.installation_id,
        detail: {
          plugin_id: pluginId,
          school_id: inst.school_id,
          cleanup,
          reason: reason || null
        }
      });
      return {
        plugin_id: pluginId,
        school_id: inst.school_id,
        status: "UNINSTALLED",
        cleanup,
        uninstalled_at: nowIso
      };
    }

    throw new ContractError("BAD_REQUEST", "Unsupported lifecycle action: " + action);
  }

  adminDisablePlugin(pluginId, { actorUserId = "admin", reason = null } = {}) {
    const state = this._runtimeState(pluginId);
    state.kill_switch = true;
    state.kill_switch_reason = reason || "ADMIN_KILL_SWITCH";
    let disabledCount = 0;
    for (const [key, installation] of this.userInstallations.entries()) {
      if (installation?.plugin_id !== pluginId) continue;
      if (installation.status !== "DISABLED") {
        installation.status = "DISABLED";
        installation.disabled_reason = state.kill_switch_reason;
        installation.updated_at = new Date().toISOString();
        this.userInstallations.set(key, installation);
        disabledCount += 1;
      }
    }
    this._saveRuntimeState(state);
    this._audit({
      actor_kind: "ADMIN",
      actor_ref: actorUserId,
      action: "PLUGIN_KILL_SWITCH_DISABLE",
      resource_kind: "plugin",
      resource_ref: pluginId,
      detail: { reason: state.kill_switch_reason, disabled_installations: disabledCount }
    });
    return { ...state, disabled_installations: disabledCount };
  }

  getResolvedUiSlotDescriptors(userId, slotId = null, { schoolId = null } = {}) {
    const descriptors = [];
    for (const inst of this.userInstallations.values()) {
      if (ownerIdOfInstallation(inst) !== userId || !isOperationallyEnabled(inst)) continue;
      if (schoolId && normalizeSchoolId(inst.school_id) !== normalizeSchoolId(schoolId)) continue;
      if (this._runtimeState(inst.plugin_id).kill_switch || this._runtimeState(inst.plugin_id).auto_disabled) continue;
      const pkg = this.packages.get(pluginPackageKey(inst.plugin_id, inst.active_version));
      if (!pkg) continue;
      if (!(inst.granted_permissions || []).includes("ui.slot.render")) continue;
      try {
        // UI descriptors are security-sensitive output derived from the signed
        // manifest. Re-prove the exact persisted package before reading even one
        // slot field; successful decisions are cached by a content-digest key.
        this._verifyStoredPackageIntegrityOrQuarantine(pkg, {
          packageKey: pluginPackageKey(inst.plugin_id, inst.active_version),
          source: "ui-descriptor"
        });
      } catch {
        continue;
      }

      for (const slot of pkg.manifest.ui_slots || []) {
        if (slotId && slot.slot_id !== slotId) continue;
        descriptors.push({
          plugin_id: inst.plugin_id,
          plugin_version: inst.active_version,
          school_id: inst.school_id,
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

  putPluginStorage(userId, pluginId, key, value, { schoolId = null, namespace = "default", cache = false } = {}) {
    const found = this._findInstallation(userId, pluginId, schoolId);
    if (!found) throw new ContractError("NOT_FOUND", "Plugin is not installed in this scope");
    const installation = found.installation;
    if (!cache && !(installation.granted_permissions || []).includes("storage.scoped")) {
      throw new ContractError(
        "PLUGIN_PERMISSION_DENIED",
        "Plugin lacks storage.scoped permission"
      );
    }
    const target = cache ? this.pluginCacheEntries : this.pluginStorageEntries;
    const rowKey = scopedEntryKey(installation.installation_id, namespace, key);
    const nowIso = new Date().toISOString();
    target.set(rowKey, {
      id: crypto.randomUUID(),
      installation_id: installation.installation_id,
      namespace,
      key: String(key),
      value,
      created_at: target.get(rowKey)?.created_at || nowIso,
      updated_at: nowIso
    });
    this._persist();
    return target.get(rowKey);
  }

  getPluginStorage(userId, pluginId, key, { schoolId = null, namespace = "default", cache = false } = {}) {
    const found = this._findInstallation(userId, pluginId, schoolId);
    if (!found) return null;
    const target = cache ? this.pluginCacheEntries : this.pluginStorageEntries;
    return target.get(scopedEntryKey(found.installation.installation_id, namespace, key)) || null;
  }

  pluginDataCounts(installationId) {
    const count = (map) => Array.from(map.values()).filter((row) => row?.installation_id === installationId).length;
    return {
      permission_grants: count(this.pluginPermissionGrants),
      storage_entries: count(this.pluginStorageEntries),
      cache_entries: count(this.pluginCacheEntries)
    };
  }

  _recordCommandFailure(pluginId, error) {
    const state = this._runtimeState(pluginId);
    state.failure_count = Number(state.failure_count || 0) + 1;
    state.consecutive_failure_count = Number(state.consecutive_failure_count || 0) + 1;
    let autoDisabledNow = false;
    if (state.consecutive_failure_count >= this.failureThreshold && !state.auto_disabled) {
      state.auto_disabled = true;
      state.disabled_reason = "CONSECUTIVE_COMMAND_FAILURES:" + (error?.code || error?.name || "UNKNOWN");
      autoDisabledNow = true;
      for (const [key, installation] of this.userInstallations.entries()) {
        if (installation?.plugin_id !== pluginId) continue;
        installation.status = "DISABLED";
        installation.disabled_reason = state.disabled_reason;
        installation.updated_at = new Date().toISOString();
        this.userInstallations.set(key, installation);
      }
    }
    this._saveRuntimeState(state);
    if (autoDisabledNow) {
      this._audit({
        action: "PLUGIN_AUTO_DISABLED",
        resource_kind: "plugin",
        resource_ref: pluginId,
        outcome: "FAIL_CLOSED",
        detail: {
          consecutive_failure_count: state.consecutive_failure_count,
          reason: state.disabled_reason
        }
      });
    }
    return state;
  }

  _recordCommandSuccess(pluginId) {
    const state = this._runtimeState(pluginId);
    if (state.consecutive_failure_count === 0) return;
    state.consecutive_failure_count = 0;
    this._saveRuntimeState(state);
  }

  async invokePluginCommand({
    userId,
    pluginId,
    commandName,
    payload = {},
    requestedOrigin = null,
    schoolId = null
  }) {
    const found = this._findInstallation(userId, pluginId, schoolId);
    const inst = found?.installation;
    if (!inst || !isOperationallyEnabled(inst)) {
      throw new ContractError(
        "PLUGIN_PERMISSION_DENIED",
        "Plugin '" + pluginId + "' is not installed and enabled for user"
      );
    }
    const runtimeState = this._runtimeState(pluginId);
    if (runtimeState.kill_switch || runtimeState.auto_disabled) {
      throw new ContractError(
        "PLUGIN_PERMISSION_DENIED",
        "Plugin '" + pluginId + "' is disabled by runtime isolation"
      );
    }

    const pkg = this.packages.get(pluginPackageKey(pluginId, inst.active_version));
    if (!pkg) {
      throw new ContractError("NOT_FOUND", "Active plugin package missing");
    }
    // Invocation is a use of persisted signed artifacts, never a trusted cache
    // read. Re-verify publisher trust, signature, and every declared artifact
    // before interpreting the manifest. The memory cache key includes the exact
    // content digest, so post-restore tampering cannot reuse a stale pass.
    this._verifyStoredPackageIntegrityOrQuarantine(pkg, {
      packageKey: pluginPackageKey(pluginId, inst.active_version),
      source: "command-invoke"
    });

    const cmdSpec = (pkg.manifest.commands || []).find((c) => c.name === commandName);
    if (!cmdSpec) {
      throw new ContractError(
        "BAD_REQUEST",
        "Command '" + commandName + "' is not declared in plugin manifest"
      );
    }

    if (
      cmdSpec.required_permission &&
      !(inst.granted_permissions || []).includes(cmdSpec.required_permission)
    ) {
      throw new ContractError(
        "PLUGIN_PERMISSION_DENIED",
        "Plugin '" + pluginId + "' lacks permission '" + cmdSpec.required_permission + "'"
      );
    }

    const commandHandlers = this.commandHandlersByPackage.get(pluginPackageKey(pluginId, inst.active_version)) || {};
    const handler = commandHandlers[commandName];
    if (cmdSpec.type && !DECLARATIVE_COMMAND_TYPES.has(cmdSpec.type)) {
      throw new ContractError(
        "PLUGIN_COMMAND_UNSUPPORTED",
        "Unsupported plugin command type: " + String(cmdSpec.type)
      );
    }
    if (!cmdSpec.type && typeof handler !== "function") {
      throw new ContractError(
        "PLUGIN_COMMAND_UNSUPPORTED",
        "Third-party declarative command type is missing or unsupported"
      );
    }

    if (requestedOrigin) {
      const hasNetPerm =
        (inst.granted_permissions || []).includes("network.request") ||
        (inst.granted_permissions || []).includes("network.http.allowlist");
      if (!hasNetPerm) {
        throw new ContractError(
          "PLUGIN_PERMISSION_DENIED",
          "Plugin '" + pluginId + "' attempted outbound network access without 'network.request'"
        );
      }
      const allowedOrigins = pkg.manifest.allowed_origins || [];
      if (!allowedOrigins.includes(requestedOrigin)) {
        throw new ContractError(
          "PLUGIN_PERMISSION_DENIED",
          "Origin '" + requestedOrigin + "' is not in plugin's allowed_origins"
        );
      }
    }

    if (typeof handler === "function" && !cmdSpec.type) {
      try {
        // Host-owned reference handlers are part of the host binary. They are
        // never loaded from plugin artifacts and must not echo request payloads.
        const result = await handler({
          userId,
          pluginId,
          version: inst.active_version
        });
        this._recordCommandSuccess(pluginId);
        return {
          plugin_id: pluginId,
          version: inst.active_version,
          command: commandName,
          executed: true,
          output: result
        };
      } catch (error) {
        this._recordCommandFailure(pluginId, error);
        throw error;
      }
    }

    const output = assertValidDeclarativeTarget(cmdSpec, pkg);
    this._recordCommandSuccess(pluginId);
    return {
      plugin_id: pluginId,
      version: inst.active_version,
      command: commandName,
      executed: true,
      output
    };
  }
}

export function loadPluginDirectory(pluginDir) {
  const manifestPath = path.join(pluginDir, "manifest.json");
  const manifest = parsePluginManifestJson(fs.readFileSync(manifestPath, "utf8"));
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
