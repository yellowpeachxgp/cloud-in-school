import crypto from "node:crypto";
import { ContractError, parseJsonWithNumberLiterals } from "../../contracts/src/index.mjs";
import { canonicalizeJson as canonicalizeLegacyJson, sha256Hex } from "../../crypto/src/index.mjs";
import {
  decodeDataPackArtifact,
  normalizeTrustedKeyring,
  verifyDataPackArtifact
} from "../../datapack/src/index.mjs";
import { readPluginPackageZip } from "../../plugin-sdk/src/package-zip.mjs";

export const CONTENT_PACK_FORMATS = Object.freeze(["dis-campus-plugin/v1", "dis-datapack/v1"]);
export const CONTENT_PACK_KINDS = Object.freeze([
  "school-profile",
  "campus-guide",
  "procedure-guide",
  "opportunity-catalog",
  "facility-catalog",
  "indoor-graph",
  "period-preset",
  "pharmacy-catalog"
]);
export const LEGACY_PLUGIN_FORMAT = "dis-campus-plugin/v1";
export const DATAPACK_FORMAT = "dis-datapack/v1";
export const LEGACY_SIGNATURE_SCHEME = "DIS_CAMPUS_PLUGIN_MANIFEST_FILES_V1";
export const DATAPACK_SIGNATURE_SCHEME = "DIS_DATAPACK_CANONICAL_JSON_SHA256_V1";
export const CONTENT_PACK_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

const LEGACY_KINDS = new Set(["school-profile", "campus-guide"]);
const DATAPACK_KINDS = new Set(["procedure-guide", "opportunity-catalog", "facility-catalog", "indoor-graph", "period-preset", "pharmacy-catalog"]);
const SCHOOL_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{2,127}$/;
export const CONTENT_PACK_VERSION_RE = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/;
const PUBLISHER_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SIGNATURE_BASE64_RE = /^[A-Za-z0-9+/]{86}==$/;
const LICENSE_IDS = new Set(["Apache-2.0", "MIT", "BSD-3-Clause", "CC-BY-4.0", "CC0-1.0"]);
const LEGACY_VERIFICATION_LEVELS = new Set(["SOURCE_CONFIRMED", "MOCK_TESTED", "DEVICE_TESTED", "SCHOOL_VERIFIED", "DISTRIBUTION_READY"]);
const CAPABILITY_KINDS = new Set([
  "ACADEMIC_TERMS_READ",
  "ACADEMIC_CALENDAR_READ",
  "TIMETABLE_READ",
  "GRADES_READ",
  "GRADE_DETAIL_READ",
  "EXAMS_READ",
  "TRAINING_PLAN_READ",
  "SELECTION_QUERY",
  "SELECTION_WRITE",
  "CAMPUS_MAP",
  "CAMPUS_BUILDINGS",
  "LIBRARY_CATALOG",
  "LIBRARY_SEATS",
  "UTILITIES",
  "ROOM_FINDER",
  "COMMUNITY"
]);
const EXECUTABLE_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1",
  ".jar", ".class", ".apk", ".dex", ".js", ".mjs", ".cjs", ".py", ".rb", ".pl", ".pm", ".wasm", ".com", ".scr"
]);
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

function contentError(code, message, detail = undefined) {
  return new ContractError(code, message, detail);
}

export function contentPackInvalid(message, detail = undefined) {
  return contentError("CONTENT_PACK_INVALID", message, detail);
}

export function contentPackSignatureInvalid(message, detail = undefined) {
  return contentError("CONTENT_PACK_SIGNATURE_INVALID", message, detail);
}

function fail(message, detail = undefined) {
  throw contentPackInvalid(message, detail);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, path, allowedKeys, requiredKeys) {
  if (!isPlainObject(value)) fail(path + " must be an object");
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) fail(path + "." + key + " is not allowed in dis-campus-plugin/v1 manifest");
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(path + "." + key + " is required");
  }
  return value;
}

function requireString(value, path, { min = 1, max = Infinity, pattern = null } = {}) {
  if (typeof value !== "string") fail(path + " must be a string");
  if (value.length < min) fail(path + " length must be at least " + min);
  if (value.length > max) fail(path + " length must be at most " + max);
  if (pattern && !pattern.test(value)) fail(path + " does not match " + pattern);
  return value;
}

function requireInteger(value, path, { min = null, max = null } = {}) {
  if (typeof value !== "number" || !Number.isInteger(value)) fail(path + " must be an integer");
  if (min !== null && value < min) fail(path + " must be >= " + min);
  if (max !== null && value > max) fail(path + " must be <= " + max);
  return value;
}

function requireArray(value, path, minItems = 0) {
  if (!Array.isArray(value)) fail(path + " must be an array");
  if (value.length < minItems) fail(path + " must contain at least " + minItems + " item(s)");
  return value;
}

function strictUtf8(bytes, label) {
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    fail(label + " must be exact UTF-8");
  }
}

function validateLegacyPayloadPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 200) fail("legacy package file path length is invalid", { artifact_path: path });
  if (path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("\0") || /^[A-Za-z]:/.test(path)) {
    fail("legacy package file path is unsafe", { artifact_path: path });
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) fail("legacy package file path contains a forbidden character", { artifact_path: path });
  const segments = path.split("/");
  if (segments.length > 8 || segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.length > 64)) {
    fail("legacy package file path has an unsafe segment structure", { artifact_path: path });
  }
  if (!["profile/", "assets/", "rules/"].some((prefix) => path.startsWith(prefix))) {
    fail("legacy package file path is outside profile/, assets/, or rules/", { artifact_path: path });
  }
  return path;
}

function catalogDisplayTitle(value) {
  const chars = [...String(value || "content pack")];
  return chars.length <= 120 ? chars.join("") : chars.slice(0, 120).join("");
}

function executableArtifactReason(path, bytes) {
  const lower = path.toLowerCase();
  const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
  if (EXECUTABLE_EXTENSIONS.has(extension)) return "executable file extension " + extension;
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return "MZ executable magic";
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return "ELF executable magic";
  const machoMagics = [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
    [0xbe, 0xba, 0xfe, 0xca],
    [0xca, 0xfe, 0xba, 0xbf],
    [0xbf, 0xba, 0xfe, 0xca]
  ];
  if (bytes.length >= 4 && machoMagics.some((magic) => magic.every((byte, index) => bytes[index] === byte))) return "Mach-O executable magic";
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) return "script shebang";
  return null;
}

function assertNoExecutablePayload(entries) {
  for (const [path, bytes] of entries) {
    if (path === "manifest.json") continue;
    const reason = executableArtifactReason(path, bytes);
    if (reason) {
      fail("legacy package contains an executable payload type: " + reason, { artifact_path: path });
    }
  }
}

function validateHttpsOrigin(value, path) {
  requireString(value, path, { min: 8, max: 200 });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(path + " must be a valid HTTPS origin");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    fail(path + " must be an HTTPS origin without userinfo, path, query, or fragment");
  }
  return value;
}

function validatePermissionPathPrefix(value, path) {
  requireString(value, path, { min: 1, max: 200 });
  if (!value.startsWith("/")) fail(path + " must start with /");
  if (value !== "/") {
    const segments = value.replace(/[/]+$/, "").split("/").slice(1);
    if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.length > 64 || !/^[A-Za-z0-9._~-]+$/.test(segment))) {
      fail(path + " has an invalid path segment");
    }
  }
  return value;
}

function validateLegacyPermission(value, path) {
  const obj = requireObject(value, path, ["kind", "origins", "paths", "methods", "purposes"], ["kind", "origins", "paths", "methods", "purposes"]);
  if (obj.kind !== "network.request") fail(path + ".kind must be network.request");
  const origins = requireArray(obj.origins, path + ".origins", 1).map((entry, index) => validateHttpsOrigin(requireString(entry, path + ".origins[" + index + "]"), path + ".origins[" + index + "]"));
  const paths = requireArray(obj.paths, path + ".paths", 1).map((entry, index) => validatePermissionPathPrefix(requireString(entry, path + ".paths[" + index + "]"), path + ".paths[" + index + "]"));
  const methods = requireArray(obj.methods, path + ".methods", 1).map((entry, index) => requireString(entry, path + ".methods[" + index + "]"));
  const purposes = requireArray(obj.purposes, path + ".purposes", 1).map((entry, index) => requireString(entry, path + ".purposes[" + index + "]"));
  if (new Set(origins).size !== origins.length || new Set(paths).size !== paths.length) fail(path + " must not duplicate origins or paths");
  if (methods.some((method) => !["GET", "POST"].includes(method))) fail(path + ".methods contains an unsupported method");
  if (purposes.some((purpose) => !["READ", "AUTH", "WRITE"].includes(purpose))) fail(path + ".purposes contains an unsupported purpose");
  if (new Set(methods).size !== methods.length || new Set(purposes).size !== purposes.length) fail(path + " must not duplicate methods or purposes");
  if (purposes.includes("WRITE") && !methods.includes("POST")) fail(path + " WRITE purpose requires POST");
  return { kind: obj.kind, origins, paths, methods, purposes };
}

function lengthPrefixedSha256(parts) {
  const digest = crypto.createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    digest.update(len);
    digest.update(bytes);
  }
  return digest.digest("hex");
}

export function legacyFilesDigest(filesMap) {
  const entries = Object.entries(filesMap).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) fail("legacy package files map must not be empty");
  for (const [path, digest] of entries) {
    if (!SHA256_RE.test(digest)) fail("legacy package file digest must be lowercase sha256 for " + path);
  }
  return lengthPrefixedSha256(entries.map(([path, digest]) => path + "=" + digest));
}

function validateLegacyManifest(manifest, entries) {
  const top = requireObject(manifest, "$", [
    "format",
    "id",
    "version",
    "type",
    "publisher",
    "license",
    "targets",
    "minHostApi",
    "minAppVersionCode",
    "capabilities",
    "requiredPermissions",
    "files",
    "verification"
  ], [
    "format",
    "id",
    "version",
    "type",
    "publisher",
    "license",
    "targets",
    "minHostApi",
    "minAppVersionCode",
    "capabilities",
    "requiredPermissions",
    "files",
    "verification"
  ]);
  if (top.format !== LEGACY_PLUGIN_FORMAT) fail("$.format must be dis-campus-plugin/v1");
  const id = requireString(top.id, "$.id", { min: 3, max: 128, pattern: PACK_ID_RE });
  const version = requireString(top.version, "$.version", { pattern: CONTENT_PACK_VERSION_RE });
  const type = requireString(top.type, "$.type");
  if (!LEGACY_KINDS.has(type)) fail("$.type must be school-profile or campus-guide");
  const publisher = requireString(top.publisher, "$.publisher", { min: 3, max: 64, pattern: PUBLISHER_RE });
  const license = requireString(top.license, "$.license");
  if (!LICENSE_IDS.has(license)) fail("$.license is not in the declarative-content license allowlist");
  const targets = requireArray(top.targets, "$.targets", 1).map((item, index) => {
    const path = "$.targets[" + index + "]";
    const obj = requireObject(item, path, ["schoolId", "provider"], ["schoolId"]);
    return {
      schoolId: requireString(obj.schoolId, path + ".schoolId", { min: 2, max: 64, pattern: SCHOOL_ID_RE }),
      provider: obj.provider === undefined ? null : requireString(obj.provider, path + ".provider", { max: 128, pattern: PROVIDER_RE })
    };
  });
  if (new Set(targets.map((target) => target.schoolId)).size !== targets.length) fail("$.targets must not contain duplicate schoolId entries");
  const minHostApi = requireInteger(top.minHostApi, "$.minHostApi", { min: 1, max: 2147483647 });
  const minAppVersionCode = requireInteger(top.minAppVersionCode, "$.minAppVersionCode", { min: 1, max: 2147483647 });
  const capabilities = requireArray(top.capabilities, "$.capabilities").map((item, index) => requireString(item, "$.capabilities[" + index + "]"));
  if (capabilities.some((capability) => !CAPABILITY_KINDS.has(capability))) fail("$.capabilities contains an unknown capability");
  if (new Set(capabilities).size !== capabilities.length) fail("$.capabilities must not contain duplicates");
  const requiredPermissions = requireArray(top.requiredPermissions, "$.requiredPermissions").map((item, index) => validateLegacyPermission(item, "$.requiredPermissions[" + index + "]"));
  if (!isPlainObject(top.files)) fail("$.files must be an object");
  const files = {};
  for (const [path, digest] of Object.entries(top.files)) {
    validateLegacyPayloadPath(path);
    files[path] = requireString(digest, "$.files." + path, { min: 64, max: 64, pattern: SHA256_RE });
  }
  if (!Object.keys(files).length) fail("$.files must declare at least one payload file");
  const verification = requireObject(top.verification, "$.verification", ["level", "fixtureDigest"], ["level", "fixtureDigest"]);
  const verificationLevel = requireString(verification.level, "$.verification.level");
  if (!LEGACY_VERIFICATION_LEVELS.has(verificationLevel)) fail("$.verification.level is unknown");
  const fixtureDigest = requireString(verification.fixtureDigest, "$.verification.fixtureDigest", { min: 64, max: 64, pattern: SHA256_RE });

  const payloadEntries = new Map();
  for (const [path, bytes] of entries) {
    if (path === "manifest.json") continue;
    validateLegacyPayloadPath(path);
    payloadEntries.set(path, bytes);
  }
  const declaredPaths = new Set(Object.keys(files));
  for (const path of declaredPaths) {
    if (!payloadEntries.has(path)) fail("legacy package is missing declared payload file " + path, { artifact_path: path });
    const actualDigest = sha256Hex(payloadEntries.get(path));
    if (actualDigest !== files[path]) {
      fail("legacy package payload digest mismatches manifest for " + path, { artifact_path: path });
    }
  }
  for (const path of payloadEntries.keys()) {
    if (!declaredPaths.has(path)) fail("legacy package contains an undeclared payload file " + path, { artifact_path: path });
  }
  assertNoExecutablePayload(entries);
  return {
    id,
    version,
    type,
    publisher,
    license,
    targets,
    minHostApi,
    minAppVersionCode,
    capabilities,
    requiredPermissions,
    files,
    verification: { level: verificationLevel, fixtureDigest },
    filesDigest: legacyFilesDigest(files)
  };
}

export function unpackAndValidateLegacySchoolPackage(artifactBytes) {
  let entries;
  try {
    entries = readPluginPackageZip(artifactBytes).entries;
  } catch (error) {
    throw contentPackInvalid("legacy school package zip failed strict structural validation: " + (error?.message || String(error)), {
      reason: "ZIP_STRUCTURE_INVALID"
    });
  }
  if (!entries.has("manifest.json")) {
    fail("legacy school package zip must contain root manifest.json", { reason: "MANIFEST_MISSING" });
  }
  for (const path of entries.keys()) {
    if (path === "manifest.json") continue;
    validateLegacyPayloadPath(path);
  }
  const manifestBytes = entries.get("manifest.json");
  if (manifestBytes.length > 256 * 1024) fail("legacy package manifest exceeds 256 KiB", { reason: "MANIFEST_TOO_LARGE" });
  let parsed;
  try {
    parsed = parseJsonWithNumberLiterals(strictUtf8(manifestBytes, "legacy package manifest"), {
      rejectDuplicateKeys: true,
      maxNumberLiteralLength: 64
    });
  } catch (error) {
    fail("legacy package manifest is not strict JSON: " + (error?.message || String(error)), { reason: "MANIFEST_JSON_INVALID" });
  }
  const manifest = validateLegacyManifest(parsed, entries);
  const canonicalManifestText = canonicalizeLegacyJson(parsed);
  const manifestDigest = sha256Hex(Buffer.from(canonicalManifestText, "utf8"));
  return {
    format: LEGACY_PLUGIN_FORMAT,
    manifest,
    manifestDigest,
    filesDigest: manifest.filesDigest,
    entries,
    title: catalogDisplayTitle(manifest.id),
    minHostApi: manifest.minHostApi,
    minAppVersionCode: manifest.minAppVersionCode
  };
}

function compareSources(apiSources, embeddedSources) {
  if (!Array.isArray(apiSources) || !Array.isArray(embeddedSources) || apiSources.length !== embeddedSources.length) return false;
  return apiSources.every((source, index) => {
    const embedded = embeddedSources[index];
    return source.url === embedded.url && source.title === embedded.title && source.retrieved_at === embedded.retrievedAt;
  });
}

export function provenanceMatchesDataPack(provenance, pack) {
  return Boolean(
    provenance &&
    compareSources(provenance.sources, pack.sources) &&
    provenance.verified_at === pack.verifiedAt &&
    provenance.review_by === pack.reviewBy &&
    Array.isArray(provenance.maintainers) &&
    Array.isArray(pack.maintainers) &&
    provenance.maintainers.length === pack.maintainers.length &&
    provenance.maintainers.every((value, index) => value === pack.maintainers[index]) &&
    provenance.verification_level === (pack.verificationLevel || "UNVERIFIED")
  );
}

export function validateContentPackArtifact({
  artifactFormat,
  kind,
  schoolId,
  packId,
  version,
  artifactBytes,
  provenance
}) {
  if (!CONTENT_PACK_FORMATS.includes(artifactFormat)) throw contentPackInvalid("artifact_format is unsupported");
  if (!CONTENT_PACK_KINDS.includes(kind)) throw contentPackInvalid("kind is unsupported");
  if ((artifactFormat === LEGACY_PLUGIN_FORMAT) !== LEGACY_KINDS.has(kind)) {
    throw contentPackInvalid("artifact_format and kind combination is forbidden", { artifact_format: artifactFormat, kind });
  }
  if (!SCHOOL_ID_RE.test(String(schoolId || ""))) throw contentPackInvalid("school_id must be a dot-free lowercase school scope");
  if (!PACK_ID_RE.test(String(packId || ""))) throw contentPackInvalid("pack_id has an invalid shape");
  if (!CONTENT_PACK_VERSION_RE.test(String(version || ""))) throw contentPackInvalid("version must be MAJOR.MINOR.PATCH[-prerelease]");
  const bytes = Buffer.isBuffer(artifactBytes) ? artifactBytes : Buffer.from(artifactBytes || []);
  if (bytes.length < 1 || bytes.length > CONTENT_PACK_MAX_ARTIFACT_BYTES) {
    throw new ContractError("CONTENT_PACK_ARTIFACT_TOO_LARGE", "content package artifact exceeds the 16 MiB ceiling", {
      artifact_size_bytes: bytes.length,
      maximum: CONTENT_PACK_MAX_ARTIFACT_BYTES
    });
  }

  if (artifactFormat === DATAPACK_FORMAT) {
    let decoded;
    try {
      decoded = decodeDataPackArtifact(bytes);
    } catch (error) {
      if (error?.code === "CONTENT_PACK_INVALID") throw error;
      throw contentPackInvalid("dis-datapack/v1 artifact failed exact-byte or schema validation: " + (error?.message || String(error)));
    }
    const pack = decoded.pack;
    if (pack.packId !== packId || pack.schoolId !== schoolId || pack.kind !== kind || pack.version !== version) {
      throw contentPackInvalid("submission coordinates must exactly match the embedded dis-datapack metadata", {
        embedded: { pack_id: pack.packId, school_id: pack.schoolId, kind: pack.kind, version: pack.version }
      });
    }
    if (packId.split(".")[0] !== schoolId) {
      throw contentPackInvalid("dis-datapack pack_id first dot-separated segment must equal the complete school_id");
    }
    if (!provenanceMatchesDataPack(provenance, pack)) {
      throw contentPackInvalid("submission provenance must duplicate the signature-covered embedded dis-datapack metadata exactly", {
        reason: "PROVENANCE_MISMATCH"
      });
    }
    return {
      format: artifactFormat,
      kind,
      schoolId,
      packId,
      version,
      artifactSha256: decoded.artifactSha256,
      artifactSizeBytes: bytes.length,
      decoded,
      title: catalogDisplayTitle(pack.items[0]?.title || pack.packId),
      minHostApi: null,
      minAppVersionCode: null,
      verificationLevel: pack.verificationLevel || "UNVERIFIED"
    };
  }

  const legacy = unpackAndValidateLegacySchoolPackage(bytes);
  const manifest = legacy.manifest;
  if (manifest.id !== packId || manifest.version !== version || manifest.type !== kind) {
    throw contentPackInvalid("submission coordinates must exactly match the legacy package manifest", {
      embedded: { pack_id: manifest.id, version: manifest.version, kind: manifest.type }
    });
  }
  if (!manifest.targets.some((target) => target.schoolId === schoolId)) {
    throw contentPackInvalid("legacy package targets do not include the requested school_id", { school_id: schoolId });
  }
  return {
    format: artifactFormat,
    kind,
    schoolId,
    packId,
    version,
    artifactSha256: sha256Hex(bytes),
    artifactSizeBytes: bytes.length,
    legacy,
    title: catalogDisplayTitle(manifest.id),
    minHostApi: manifest.minHostApi,
    minAppVersionCode: manifest.minAppVersionCode,
    verificationLevel: provenance?.verification_level || "UNVERIFIED"
  };
}

export function legacySignaturePayload(legacyValidation) {
  return Buffer.from(
    LEGACY_PLUGIN_FORMAT + "\n" + legacyValidation.manifestDigest + "\n" + legacyValidation.filesDigest + "\n",
    "utf8"
  );
}

function validateDetachedSignatureShape(signature, expectedScheme) {
  if (!isPlainObject(signature)) throw contentPackSignatureInvalid("detached signature must be an object", { reason: "SIGNATURE_SHAPE_INVALID" });
  const allowed = ["algorithm", "scheme", "public_key_fingerprint", "value", "signed_payload_sha256"];
  for (const key of Object.keys(signature)) {
    if (!allowed.includes(key)) throw contentPackSignatureInvalid("detached signature has an additional property", { reason: "SIGNATURE_SHAPE_INVALID", key });
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(signature, key)) throw contentPackSignatureInvalid("detached signature is missing " + key, { reason: "SIGNATURE_SHAPE_INVALID", key });
  }
  if (signature.algorithm !== "Ed25519") throw contentPackSignatureInvalid("detached signature algorithm must be Ed25519", { reason: "SIGNATURE_ALGORITHM_INVALID" });
  if (signature.scheme !== expectedScheme) throw contentPackSignatureInvalid("detached signature scheme does not match the artifact format", { reason: "SIGNATURE_SCHEME_INVALID" });
  if (!SHA256_RE.test(signature.public_key_fingerprint || "")) throw contentPackSignatureInvalid("public key fingerprint must be lowercase sha256 hex", { reason: "PUBLIC_KEY_FINGERPRINT_INVALID" });
  if (!SIGNATURE_BASE64_RE.test(signature.value || "")) throw contentPackSignatureInvalid("signature value must be a base64 encoded 64-byte Ed25519 signature", { reason: "SIGNATURE_VALUE_INVALID" });
  if (!SHA256_RE.test(signature.signed_payload_sha256 || "")) throw contentPackSignatureInvalid("signed payload digest must be lowercase sha256 hex", { reason: "SIGNED_PAYLOAD_DIGEST_INVALID" });
  return signature;
}

export function verifyLegacyContentPackSignature(legacyValidation, detachedSignature, trustedKeys) {
  const signature = validateDetachedSignatureShape(detachedSignature, LEGACY_SIGNATURE_SCHEME);
  let keyring;
  try {
    keyring = normalizeTrustedKeyring(trustedKeys);
  } catch (error) {
    throw contentPackSignatureInvalid(error?.message || "legacy content pack trust root is invalid", error?.detail);
  }
  const trusted = keyring.get(signature.public_key_fingerprint);
  if (!trusted) {
    throw contentPackSignatureInvalid("legacy content pack signer is not in the pinned publisher trust root", { reason: "UNTRUSTED_SIGNER" });
  }
  const payload = legacySignaturePayload(legacyValidation);
  const payloadDigest = sha256Hex(payload);
  if (payloadDigest !== signature.signed_payload_sha256) {
    throw contentPackSignatureInvalid("legacy signed payload digest does not match the artifact-derived payload", {
      reason: "SIGNED_PAYLOAD_DIGEST_MISMATCH",
      expected: payloadDigest
    });
  }
  const signatureBytes = Buffer.from(signature.value, "base64");
  if (signatureBytes.length !== 64 || !crypto.verify(null, payload, trusted.keyObject, signatureBytes)) {
    throw contentPackSignatureInvalid("legacy content pack Ed25519 signature verification failed", { reason: "SIGNATURE_VERIFY_FAILED" });
  }
  return {
    signature: { ...signature },
    publicKeyFingerprint: trusted.fingerprint,
    payloadSha256: payloadDigest
  };
}

export function verifyContentPackArtifactSignature({
  artifactFormat,
  artifactBytes,
  signature,
  trustedKeys,
  legacyValidation = null
}) {
  if (artifactFormat === DATAPACK_FORMAT) {
    try {
      return verifyDataPackArtifact(artifactBytes, signature, trustedKeys);
    } catch (error) {
      if (error?.code === "CONTENT_PACK_SIGNATURE_INVALID" || error?.code === "CONTENT_PACK_INVALID") throw error;
      throw contentPackSignatureInvalid(error?.message || "dis-datapack signature verification failed", error?.detail);
    }
  }
  if (!legacyValidation) throw contentPackInvalid("legacy validation is required before signature verification");
  validateDetachedSignatureShape(signature, LEGACY_SIGNATURE_SCHEME);
  return verifyLegacyContentPackSignature(legacyValidation, signature, trustedKeys);
}
