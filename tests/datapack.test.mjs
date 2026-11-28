import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  DATAPACK_KINDS,
  DATAPACK_VERIFICATION_LEVELS,
  canonicalizeRfc8785,
  dataPackFreshness,
  dataPackSignaturePayload,
  dataPackSignaturePayloadSha256,
  decodeDataPackArtifact,
  signDataPackArtifact,
  validateDisDatapack,
  verifyDataPackArtifact
} from "../packages/datapack/src/index.mjs";

const FIXTURE_PATH = "tests/fixtures/datapack/valid-procedure.json";
const FIXTURE_SHA256 = "8a10ddfd1cc74d5b3f50b8208becef0ad8014b7702878bc16e7ee7446224bf47";
const FIXTURE_PAYLOAD_SHA256 = "8a7b6bb837654d944d64bd0b67134a70abbc331ba56064f889d124c5e09d4aad";

function fixtureBytes() {
  return fs.readFileSync(FIXTURE_PATH);
}

function fixtureObject() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
}

function canonicalBytes(value) {
  return Buffer.from(canonicalizeRfc8785(value), "utf8");
}

function expectDataPackError(code, fn, reason = null) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    if (reason) assert.equal(error.detail?.reason, reason);
    return true;
  });
}

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyBase64: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")
  };
}

function doubleFromHex(hex) {
  const buffer = Buffer.from(hex, "hex");
  return buffer.readDoubleBE(0);
}

test("W5-01 RFC-8785 number serialization matches the RFC Appendix B samples", () => {
  const samples = [
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"]
  ];
  for (const [hex, expected] of samples) {
    assert.equal(canonicalizeRfc8785(doubleFromHex(hex)), expected, hex);
  }
});

test("W5-01 RFC-8785 sorts object keys by raw UTF-16 code units", () => {
  const input = {
    "\u20ac": "Euro Sign",
    "\r": "Carriage Return",
    "\ufb33": "Hebrew Letter Dalet With Dagesh",
    "1": "One",
    "\ud83d\ude00": "Emoji: Grinning Face",
    "\u0080": "Control",
    "\u00f6": "Latin Small Letter O With Diaeresis"
  };
  const canonical = canonicalizeRfc8785(input);
  const orderedKeys = [
    "\r",
    "1",
    String.fromCharCode(0x80),
    "ö",
    "€",
    "😀",
    "דּ"
  ];
  const expected = "{" + orderedKeys.map((key) => JSON.stringify(key) + ":" + JSON.stringify(input[key])).join(",") + "}";
  assert.equal(canonical, expected);
  assert.equal(canonicalizeRfc8785("\u000f"), "\"\\u000f\"");
});

test("W5-01 valid fixture passes exact-byte decoding, schema validation, digest and freshness states", () => {
  const decoded = decodeDataPackArtifact(fixtureBytes());
  assert.equal(decoded.pack.packId, "haut.procedures");
  assert.equal(decoded.pack.kind, "procedure-guide");
  assert.equal(decoded.pack.verificationLevel, "UNVERIFIED");
  assert.equal(decoded.artifactSha256, FIXTURE_SHA256);
  assert.equal(Buffer.from(dataPackSignaturePayload(decoded.canonicalBytes)).toString("utf8"), "dis-datapack/v1\n" + FIXTURE_SHA256 + "\n");
  assert.equal(dataPackFreshness(decoded.pack, "2027-05-20"), "CURRENT");
  assert.equal(dataPackFreshness(decoded.pack, "2027-05-21"), "REVIEW_DUE");
});


test("W5-01 merged CT-06 schema keeps the mirrored root shape and fixed enum sets", () => {
  const schema = JSON.parse(fs.readFileSync("contracts/schemas/dis-datapack-v1.schema.json", "utf8"));
  assert.deepEqual(schema.required, [
    "format",
    "packId",
    "schoolId",
    "kind",
    "version",
    "sources",
    "verifiedAt",
    "reviewBy",
    "maintainers",
    "items"
  ]);
  assert.deepEqual([...DATAPACK_KINDS], schema.properties.kind.enum);
  assert.deepEqual([...DATAPACK_VERIFICATION_LEVELS], schema.properties.verificationLevel.enum);
  assert.match(schema.description, /bytes to equal RFC8785\(parse\(bytes\)\)/);
  assert.match(schema.description, /dis-datapack\/v1, LF, lowercase SHA-256/);
  for (const defName of [
    "procedureGuideItem",
    "opportunityCatalogItem",
    "facilityCatalogItem",
    "indoorGraphItem",
    "periodPresetItem",
    "pharmacyCatalogItem"
  ]) {
    assert.ok(schema.$defs[defName], defName);
  }
});

test("W5-01 exact-byte chain rejects whitespace key-order escape and number variants", () => {
  const pretty = JSON.stringify(fixtureObject(), null, 2);
  expectDataPackError("CONTENT_PACK_INVALID", () => decodeDataPackArtifact(Buffer.from(pretty, "utf8")), "EXACT_CANONICAL_BYTES_REQUIRED");

  const reordered = "{\"format\":\"dis-datapack/v1\",\"kind\":\"procedure-guide\",\"items\":[],\"packId\":\"haut.procedures\",\"schoolId\":\"haut\",\"version\":\"2026.11.1\",\"sources\":[{\"url\":\"https://example.com/haut/procedure-guide\",\"title\":\"学校办事流程公开页\",\"retrievedAt\":\"2026-11-20\"}],\"verifiedAt\":\"2026-11-20\",\"reviewBy\":\"2027-05-20\",\"maintainers\":[\"github:example-maintainer\"]}";
  expectDataPackError("CONTENT_PACK_INVALID", () => decodeDataPackArtifact(Buffer.from(reordered, "utf8")), "EXACT_CANONICAL_BYTES_REQUIRED");

  const numberVariant = fixtureBytes().toString("utf8").replace("\"estimatedMinutes\":15", "\"estimatedMinutes\":15.0");
  expectDataPackError("CONTENT_PACK_INVALID", () => decodeDataPackArtifact(Buffer.from(numberVariant, "utf8")), "EXACT_CANONICAL_BYTES_REQUIRED");

  const escapeVariant = fixtureBytes().toString("utf8").replace("学生证或校园卡", "\\u5b66\\u751f\\u8bc1\\u6216\\u6821\\u56ed\\u5361");
  expectDataPackError("CONTENT_PACK_INVALID", () => decodeDataPackArtifact(Buffer.from(escapeVariant, "utf8")), "EXACT_CANONICAL_BYTES_REQUIRED");
});

test("W5-01 malformed UTF-8 nonfinite numbers duplicate keys and lone surrogates fail closed", () => {
  expectDataPackError("CONTENT_PACK_INVALID", () => decodeDataPackArtifact(Buffer.from([0x7b, 0x80, 0x7d])), "INVALID_UTF8");
  expectDataPackError("CONTENT_PACK_INVALID", () => decodeDataPackArtifact(Buffer.from("{\"a\":1e999}", "utf8")), "NON_FINITE_NUMBER");
  expectDataPackError("CONTENT_PACK_INVALID", () => decodeDataPackArtifact(Buffer.from("{\"a\":1,\"a\":1}", "utf8")), "EXACT_CANONICAL_BYTES_REQUIRED");
  expectDataPackError("CONTENT_PACK_INVALID", () => decodeDataPackArtifact(Buffer.from("{\"\\udead\":1}", "utf8")), "INVALID_UNICODE");
});

test("W5-01 schema validator covers all six CT-06 kinds and applies documented defaults", () => {
  const root = fixtureObject();
  const make = (kind, items) => validateDisDatapack({ ...root, kind, items });
  const procedure = make("procedure-guide", fixtureObject().items);
  assert.equal(procedure.items[0].materials[0].required, true);

  const opportunity = make("opportunity-catalog", [{
    id: "certification-example",
    title: "示例证书",
    category: "certification",
    requirements: [{ id: "eligible", text: "在校学生" }],
    materials: []
  }]);
  assert.equal(opportunity.items[0].requirements[0].computable, false);

  const facility = make("facility-catalog", [{
    id: "service-desk-example",
    title: "服务台",
    facilityType: "service-desk",
    placeRef: "haut/lianhuajie/building/administration"
  }]);
  assert.equal(facility.items[0].facilityType, "service-desk");

  const indoor = make("indoor-graph", [{
    id: "node-1",
    title: "入口节点",
    itemType: "node",
    nodeKind: "entrance",
    latitude: 34.0,
    longitude: 113.0
  }]);
  assert.equal(indoor.items[0].latitude, 34);

  const period = make("period-preset", [{
    id: "default-periods",
    title: "默认作息",
    periods: [{ index: 1, start: "08:00", end: "08:45" }]
  }]);
  assert.equal(period.items[0].periods.length, 1);

  const pharmacy = make("pharmacy-catalog", [{
    id: "medicine-example",
    title: "示例药品",
    category: "otc"
  }]);
  assert.equal(pharmacy.items[0].stockState, "UNKNOWN");
});

test("W5-01 schema validator rejects additional properties type errors duplicates and pack scope mismatch", () => {
  const valid = fixtureObject();
  const canonicalValidate = (value) => decodeDataPackArtifact(canonicalBytes(value));

  expectDataPackError("CONTENT_PACK_INVALID", () => canonicalValidate({ ...valid, unexpected: true }));
  expectDataPackError("CONTENT_PACK_INVALID", () => canonicalValidate({ ...valid, packId: "other.procedures" }));
  expectDataPackError("CONTENT_PACK_INVALID", () => canonicalValidate({ ...valid, maintainers: ["github:a", "github:a"] }));
  expectDataPackError("CONTENT_PACK_INVALID", () => canonicalValidate({ ...valid, sources: [{ ...valid.sources[0], url: "http://example.com" }] }));

  const badItem = structuredClone(valid);
  badItem.items[0].unexpected = true;
  expectDataPackError("CONTENT_PACK_INVALID", () => canonicalValidate(badItem));

  const badStep = structuredClone(valid);
  badStep.items[0].steps[0].estimatedMinutes = 10081;
  expectDataPackError("CONTENT_PACK_INVALID", () => canonicalValidate(badStep));
});

test("W5-01 detached Ed25519 signature uses exact payload shape and verifies with pinned trust root", () => {
  const keys = keyPair();
  const bytes = fixtureBytes();
  const signature = signDataPackArtifact(bytes, keys.privateKeyBase64, keys.publicKeyBase64);
  assert.equal(signature.algorithm, "Ed25519");
  assert.equal(signature.scheme, "DIS_DATAPACK_CANONICAL_JSON_SHA256_V1");
  assert.equal(signature.signed_payload_sha256, FIXTURE_PAYLOAD_SHA256);
  assert.match(signature.public_key_fingerprint, /^[0-9a-f]{64}$/);
  assert.match(signature.value, /^[A-Za-z0-9+/]{86}==$/);

  const verified = verifyDataPackArtifact(bytes, signature, [keys.publicKeyBase64]);
  assert.equal(verified.verificationStatus, "SIGNATURE_VERIFIED");
  assert.equal(verified.signatureVerification.payloadSha256, FIXTURE_PAYLOAD_SHA256);
});

test("W5-01 signature verification rejects semantic tampering wrong payload hash wrong signer and malformed signature", () => {
  const keys = keyPair();
  const bytes = fixtureBytes();
  const signature = signDataPackArtifact(bytes, keys.privateKeyBase64, keys.publicKeyBase64);

  const tamperedPack = structuredClone(fixtureObject());
  tamperedPack.items[0].title = "被篡改的标题";
  const tamperedBytes = canonicalBytes(tamperedPack);
  const tamperedPayloadSignature = { ...signature, signed_payload_sha256: dataPackSignaturePayloadSha256(tamperedBytes) };
  expectDataPackError("CONTENT_PACK_SIGNATURE_INVALID", () => verifyDataPackArtifact(tamperedBytes, tamperedPayloadSignature, [keys.publicKeyBase64]), "SIGNATURE_VERIFY_FAILED");

  expectDataPackError("CONTENT_PACK_SIGNATURE_INVALID", () => verifyDataPackArtifact(bytes, { ...signature, signed_payload_sha256: "0".repeat(64) }, [keys.publicKeyBase64]), "SIGNED_PAYLOAD_DIGEST_MISMATCH");

  const attacker = keyPair();
  expectDataPackError("CONTENT_PACK_SIGNATURE_INVALID", () => verifyDataPackArtifact(bytes, signature, [attacker.publicKeyBase64]), "UNTRUSTED_SIGNER");
  assert.throws(() => signDataPackArtifact(bytes, attacker.privateKeyBase64, keys.publicKeyBase64), (error) => error.detail?.reason === "PUBLIC_KEY_PAIR_MISMATCH");

  expectDataPackError("CONTENT_PACK_SIGNATURE_INVALID", () => verifyDataPackArtifact(bytes, { ...signature, value: signature.value.slice(0, -4) }, [keys.publicKeyBase64]), "SIGNATURE_VALUE_INVALID");
});
