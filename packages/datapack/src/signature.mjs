import crypto from "node:crypto";
import { dataPackSignatureInvalid } from "./errors.mjs";
import { DATAPACK_FORMAT } from "./schema.mjs";

export const DATAPACK_SIGNATURE_ALGORITHM = "Ed25519";
export const DATAPACK_SIGNATURE_SCHEME = "DIS_DATAPACK_CANONICAL_JSON_SHA256_V1";
export const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const LOWER_SHA256 = /^[0-9a-f]{64}$/;
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

function fail(message, detail = undefined) {
  throw dataPackSignatureInvalid(message, detail);
}

export function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Exact signed payload: UTF-8 format line + LF + lowercase canonical sha256 hex + LF. */
export function dataPackSignaturePayload(canonicalBytes) {
  const canonicalDigest = sha256Hex(canonicalBytes);
  return Buffer.from(DATAPACK_FORMAT + "\n" + canonicalDigest + "\n", "utf8");
}

export function dataPackSignaturePayloadSha256(canonicalBytes) {
  return sha256Hex(dataPackSignaturePayload(canonicalBytes));
}

export function rawEd25519FromSpkiDer(der) {
  const key = Buffer.from(der);
  if (key.length !== ED25519_SPKI_PREFIX.length + 32 || !key.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    fail("Ed25519 public key is not a valid SPKI DER encoding", { reason: "PUBLIC_KEY_INVALID" });
  }
  return key.subarray(ED25519_SPKI_PREFIX.length);
}

export function spkiDerFromRawEd25519(rawKey) {
  const raw = Buffer.from(rawKey);
  if (raw.length !== 32) fail("raw Ed25519 public key must be 32 bytes", { reason: "PUBLIC_KEY_INVALID" });
  return Buffer.concat([ED25519_SPKI_PREFIX, raw]);
}

export function fingerprintRawEd25519PublicKey(rawKey) {
  return sha256Hex(rawKey);
}

function normalizeTrustedPublicKey(publicKeyBase64) {
  let der;
  try {
    der = Buffer.from(publicKeyBase64, "base64");
  } catch {
    fail("trusted Ed25519 public key is not valid base64", { reason: "PUBLIC_KEY_INVALID" });
  }
  let raw;
  if (der.length === 32) {
    raw = der;
    der = spkiDerFromRawEd25519(raw);
  } else {
    raw = rawEd25519FromSpkiDer(der);
  }
  return {
    der,
    raw,
    fingerprint: fingerprintRawEd25519PublicKey(raw),
    keyObject: crypto.createPublicKey({ key: der, format: "der", type: "spki" })
  };
}

export function normalizeTrustedKeyring(trustedKeys) {
  const entries = [];
  if (Array.isArray(trustedKeys)) {
    for (const key of trustedKeys) entries.push(normalizeTrustedPublicKey(key));
  } else if (trustedKeys && typeof trustedKeys === "object") {
    for (const [fingerprint, key] of Object.entries(trustedKeys)) {
      const normalized = normalizeTrustedPublicKey(key);
      if (fingerprint !== normalized.fingerprint) {
        fail("trusted keyring fingerprint does not match its raw Ed25519 public key", {
          reason: "TRUST_ROOT_FINGERPRINT_MISMATCH",
          fingerprint
        });
      }
      entries.push(normalized);
    }
  }
  if (entries.length === 0) fail("trusted Ed25519 keyring is empty", { reason: "TRUST_ROOT_EMPTY" });
  return new Map(entries.map((entry) => [entry.fingerprint, entry]));
}

function validateDetachedSignatureShape(signature) {
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) {
    fail("dis-datapack/v1 detached signature must be an object", { reason: "SIGNATURE_SHAPE_INVALID" });
  }
  const allowed = ["algorithm", "scheme", "public_key_fingerprint", "value", "signed_payload_sha256"];
  for (const key of Object.keys(signature)) {
    if (!allowed.includes(key)) fail("dis-datapack/v1 detached signature has an additional property", { reason: "SIGNATURE_SHAPE_INVALID", key });
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(signature, key)) {
      fail("dis-datapack/v1 detached signature is missing " + key, { reason: "SIGNATURE_SHAPE_INVALID", key });
    }
  }
  if (signature.algorithm !== DATAPACK_SIGNATURE_ALGORITHM) {
    fail("dis-datapack/v1 detached signature algorithm must be Ed25519", { reason: "SIGNATURE_ALGORITHM_INVALID" });
  }
  if (signature.scheme !== DATAPACK_SIGNATURE_SCHEME) {
    fail("dis-datapack/v1 detached signature scheme is unsupported", { reason: "SIGNATURE_SCHEME_INVALID" });
  }
  if (!LOWER_SHA256.test(signature.public_key_fingerprint || "")) {
    fail("dis-datapack/v1 public key fingerprint must be lowercase sha256 hex", { reason: "PUBLIC_KEY_FINGERPRINT_INVALID" });
  }
  if (!SIGNATURE_BASE64.test(signature.value || "")) {
    fail("dis-datapack/v1 signature value is not a base64-encoded 64-byte Ed25519 signature", { reason: "SIGNATURE_VALUE_INVALID" });
  }
  if (!LOWER_SHA256.test(signature.signed_payload_sha256 || "")) {
    fail("dis-datapack/v1 signed payload digest must be lowercase sha256 hex", { reason: "SIGNED_PAYLOAD_DIGEST_INVALID" });
  }
  return signature;
}

/** Sign already-validated exact canonical bytes and return the CT-06 detached signature object shape. */
export function signCanonicalDataPackBytes(canonicalBytes, privateKeyBase64, publicKeyBase64) {
  const normalizedPublic = normalizeTrustedPublicKey(publicKeyBase64);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8"
  });
  const payload = dataPackSignaturePayload(canonicalBytes);
  const value = crypto.sign(null, payload, privateKey);
  if (value.length !== 64) fail("Ed25519 signing did not produce a 64-byte signature", { reason: "SIGNATURE_VALUE_INVALID" });
  return {
    algorithm: DATAPACK_SIGNATURE_ALGORITHM,
    scheme: DATAPACK_SIGNATURE_SCHEME,
    public_key_fingerprint: normalizedPublic.fingerprint,
    value: value.toString("base64"),
    signed_payload_sha256: sha256Hex(payload)
  };
}

/** Verify a CT-06 detached signature over exact canonical artifact bytes. Throws fail-closed on every mismatch. */
export function verifyCanonicalDataPackSignature(canonicalBytes, signature, trustedKeys) {
  const checked = validateDetachedSignatureShape(signature);
  const keyring = normalizeTrustedKeyring(trustedKeys);
  const trusted = keyring.get(checked.public_key_fingerprint);
  if (!trusted) {
    fail("dis-datapack/v1 signer is not in the pinned publisher trust root", { reason: "UNTRUSTED_SIGNER" });
  }
  const payload = dataPackSignaturePayload(canonicalBytes);
  const actualPayloadDigest = sha256Hex(payload);
  if (actualPayloadDigest !== checked.signed_payload_sha256) {
    fail("dis-datapack/v1 signed payload digest does not match the artifact-derived payload", {
      reason: "SIGNED_PAYLOAD_DIGEST_MISMATCH",
      expected: actualPayloadDigest
    });
  }
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(checked.value, "base64");
  } catch {
    fail("dis-datapack/v1 signature value is not valid base64", { reason: "SIGNATURE_VALUE_INVALID" });
  }
  if (signatureBytes.length !== 64) {
    fail("dis-datapack/v1 signature value must decode to exactly 64 bytes", { reason: "SIGNATURE_VALUE_INVALID" });
  }
  const verified = crypto.verify(null, payload, trusted.keyObject, signatureBytes);
  if (!verified) {
    fail("dis-datapack/v1 Ed25519 signature verification failed", { reason: "SIGNATURE_VERIFY_FAILED" });
  }
  return {
    signature: { ...checked },
    publicKeyFingerprint: trusted.fingerprint,
    payloadSha256: actualPayloadDigest
  };
}
