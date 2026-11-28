import { parseExactCanonicalJson } from "./rfc8785.mjs";
import { validateDisDatapack } from "./schema.mjs";
import {
  sha256Hex,
  signCanonicalDataPackBytes,
  verifyCanonicalDataPackSignature
} from "./signature.mjs";

export { DataPackError } from "./errors.mjs";
export {
  DATAPACK_MAX_ARTIFACT_BYTES,
  canonicalizeRfc8785,
  parseExactCanonicalJson,
  strictDecodeUtf8
} from "./rfc8785.mjs";
export {
  DATAPACK_FORMAT,
  DATAPACK_KINDS,
  DATAPACK_VERIFICATION_LEVELS,
  validateDisDatapack
} from "./schema.mjs";
export {
  DATAPACK_SIGNATURE_ALGORITHM,
  DATAPACK_SIGNATURE_SCHEME,
  dataPackSignaturePayload,
  dataPackSignaturePayloadSha256,
  fingerprintRawEd25519PublicKey,
  normalizeTrustedKeyring,
  rawEd25519FromSpkiDer,
  sha256Hex,
  signCanonicalDataPackBytes,
  spkiDerFromRawEd25519,
  verifyCanonicalDataPackSignature
} from "./signature.mjs";

/** Strictly decode exact artifact bytes, enforce exact-byte RFC-8785 canonicality, then validate the CT-06 schema shape. */
export function decodeDataPackArtifact(artifactBytes) {
  const parsed = parseExactCanonicalJson(artifactBytes);
  const pack = validateDisDatapack(parsed.value);
  return {
    pack,
    canonicalText: parsed.canonicalText,
    canonicalBytes: parsed.canonicalBytes,
    artifactSha256: sha256Hex(parsed.canonicalBytes)
  };
}

/** Sign a complete artifact only after exact canonicality and schema validation have passed. */
export function signDataPackArtifact(artifactBytes, privateKeyBase64, publicKeyBase64) {
  const decoded = decodeDataPackArtifact(artifactBytes);
  return signCanonicalDataPackBytes(decoded.canonicalBytes, privateKeyBase64, publicKeyBase64);
}

/** Strictly decode, schema-validate, and verify a detached signature against a pinned trust root. */
export function verifyDataPackArtifact(artifactBytes, detachedSignature, trustedKeys) {
  const decoded = decodeDataPackArtifact(artifactBytes);
  const verification = verifyCanonicalDataPackSignature(decoded.canonicalBytes, detachedSignature, trustedKeys);
  return {
    ...decoded,
    signatureVerification: verification,
    verificationStatus: "SIGNATURE_VERIFIED"
  };
}

function utcDateString(input) {
  if (input instanceof Date) return input.toISOString().slice(0, 10);
  return String(input);
}

/**
 * v1 freshness is explicit and intentionally narrow: the artifact has no hard expiry field.
 * Passing the reviewBy date means consumers must render REVIEW_DUE; catalog RETIRED is W5-02 lifecycle state, not artifact freshness.
 */
export function dataPackFreshness(pack, today = new Date()) {
  const current = utcDateString(today);
  return current > pack.reviewBy ? "REVIEW_DUE" : "CURRENT";
}
