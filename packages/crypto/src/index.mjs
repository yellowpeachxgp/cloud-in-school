import crypto from "node:crypto";
import { ContractError } from "../../contracts/src/index.mjs";

/**
 * Domestic CN KMS Envelope Vault & Credential Access Permit Guard.
 * Enforces Section 06.4 & 14:
 * - Unique 256-bit DEK per credential
 * - AES-256-GCM with 96-bit random nonce and strict AAD (`school_id|binding_id|credential_kind|v1`)
 * - DEK wrapped by KMS KEK (`kms_key_id`), supporting zero-downtime KEK rotation
 * - Decryption strictly requires a non-expired, HMAC-verified CredentialAccessPermit bound to `taskId + schoolId + credentialRef`
 */
export class KmsEnvelopeVault {
  constructor(options = {}) {
    this.activeKekId = options.activeKekId || process.env.KMS_KEY_ID || "cn-kms-campus-cloud-kek-v1";
    const configuredKekMaterial =
      options.initialKekMaterial || process.env.KMS_MASTER_SEED || "";
    if (configuredKekMaterial.startsWith("secret://")) {
      throw new Error(
        "Unresolved secret reference for KMS_MASTER_SEED; provide raw secret material"
      );
    }
    if (!configuredKekMaterial && process.env.NODE_ENV === "production") {
      throw new Error(
        "KMS_MASTER_SEED is required in production; refusing insecure built-in default"
      );
    }
    const initialKekMaterial =
      configuredKekMaterial || "cn-campus-cloud-kms-seed-2026-argongate";
    this.kekRing = new Map();
    this.kekRing.set(this.activeKekId, crypto.createHash("sha256").update(initialKekMaterial).digest());
    this.permitSecret = crypto
      .createHash("sha256")
      .update(`${initialKekMaterial}:permit-signer`)
      .digest();
    this.kmsOnline = true;
    this.auditCallback = options.onAudit || (() => {});
  }

  setKmsOnline(online) {
    this.kmsOnline = Boolean(online);
  }

  buildAadContext({ schoolId, bindingId, credentialKind, version = "v1" }) {
    return `${schoolId}|${bindingId}|${credentialKind}|${version}`;
  }

  wrapDek(dekBuffer, kekId = this.activeKekId) {
    if (!this.kmsOnline) {
      throw new ContractError("SCHOOL_AUTH_EXPIRED", "KMS is offline; fail-closed without plaintext fallback");
    }
    const kek = this.kekRing.get(kekId);
    if (!kek) {
      throw new ContractError("SCHOOL_AUTH_EXPIRED", `Unknown KMS KEK ID: ${kekId}`);
    }
    const wrapNonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", kek, wrapNonce);
    cipher.setAAD(Buffer.from(`kms-wrap|${kekId}`, "utf8"));
    const encDek = Buffer.concat([cipher.update(dekBuffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([wrapNonce, tag, encDek]);
  }

  unwrapDek(wrappedDekBuffer, kekId) {
    if (!this.kmsOnline) {
      throw new ContractError("SCHOOL_AUTH_EXPIRED", "KMS is offline; fail-closed without plaintext fallback");
    }
    const kek = this.kekRing.get(kekId);
    if (!kek) {
      throw new ContractError("SCHOOL_AUTH_EXPIRED", `KMS key ${kekId} unavailable or revoked`);
    }
    const buf = Buffer.isBuffer(wrappedDekBuffer)
      ? wrappedDekBuffer
      : Buffer.from(wrappedDekBuffer, "base64");
    const wrapNonce = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encDek = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", kek, wrapNonce);
    decipher.setAAD(Buffer.from(`kms-wrap|${kekId}`, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encDek), decipher.final()]);
  }

  encryptSecret({ bindingId, schoolId, credentialKind, plaintext, expiresAt = null }) {
    if (!plaintext || typeof plaintext !== "string") {
      throw new ContractError("BAD_REQUEST", "Plaintext credential payload must be a non-empty string");
    }
    const dek = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const aadContext = this.buildAadContext({ schoolId, bindingId, credentialKind });
    const cipher = crypto.createCipheriv("aes-256-gcm", dek, nonce);
    cipher.setAAD(Buffer.from(aadContext, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const wrappedDek = this.wrapDek(dek, this.activeKekId);
    dek.fill(0);

    const record = {
      id: crypto.randomUUID(),
      binding_id: bindingId,
      school_id: schoolId,
      secret_type: credentialKind,
      ciphertext: ciphertext.toString("base64"),
      nonce: nonce.toString("base64"),
      auth_tag: authTag.toString("base64"),
      wrapped_dek: wrappedDek.toString("base64"),
      kms_key_id: this.activeKekId,
      aad_context: aadContext,
      expires_at: expiresAt,
      revoked_at: null,
      created_at: new Date().toISOString()
    };
    this.auditCallback({
      actor_kind: "KMS_VAULT",
      actor_ref: "credential-escrow",
      action: "ENCRYPT_CREDENTIAL",
      resource_kind: "encrypted_credential",
      resource_ref: record.id,
      outcome: "SUCCESS"
    });
    return record;
  }

  issueAccessPermit({ taskId, schoolId, bindingId, credentialRef, ttlSeconds = 30, nowMs = Date.now() }) {
    const notAfterEpochMs = nowMs + Math.min(Math.max(ttlSeconds, 5), 120) * 1000;
    const payload = `${taskId}|${schoolId}|${bindingId}|${credentialRef}|${notAfterEpochMs}`;
    const signature = crypto.createHmac("sha256", this.permitSecret).update(payload).digest("hex");
    return {
      taskId,
      schoolId,
      bindingId,
      credentialRef,
      notAfterEpochMs,
      signature
    };
  }

  verifyAccessPermit(permit, expectedRecord, nowMs = Date.now()) {
    if (!permit || typeof permit !== "object") {
      throw new ContractError("FORBIDDEN", "Missing CredentialAccessPermit");
    }
    if (nowMs > permit.notAfterEpochMs) {
      throw new ContractError("FORBIDDEN", "CredentialAccessPermit has expired");
    }
    if (
      permit.credentialRef !== expectedRecord.id ||
      permit.bindingId !== expectedRecord.binding_id ||
      permit.schoolId !== expectedRecord.school_id
    ) {
      throw new ContractError("FORBIDDEN", "CredentialAccessPermit scope mismatch");
    }
    const payload = `${permit.taskId}|${permit.schoolId}|${permit.bindingId}|${permit.credentialRef}|${permit.notAfterEpochMs}`;
    const expectedSig = crypto.createHmac("sha256", this.permitSecret).update(payload).digest("hex");
    if (
      permit.signature.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(permit.signature), Buffer.from(expectedSig))
    ) {
      throw new ContractError("FORBIDDEN", "CredentialAccessPermit signature invalid");
    }
  }

  decryptSecretWithPermit(record, permit, nowMs = Date.now()) {
    if (!record) {
      throw new ContractError("SCHOOL_AUTH_EXPIRED", "Credential record not found");
    }
    if (record.revoked_at) {
      throw new ContractError("CONSENT_WITHDRAWN", "Credential has been revoked");
    }
    if (record.expires_at && new Date(record.expires_at).getTime() <= nowMs) {
      throw new ContractError("SCHOOL_AUTH_EXPIRED", "Delegated credential has expired");
    }
    this.verifyAccessPermit(permit, record, nowMs);

    const dek = this.unwrapDek(record.wrapped_dek, record.kms_key_id);
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        dek,
        Buffer.from(record.nonce, "base64")
      );
      decipher.setAAD(Buffer.from(record.aad_context, "utf8"));
      decipher.setAuthTag(Buffer.from(record.auth_tag, "base64"));
      const plainBuf = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")),
        decipher.final()
      ]);
      this.auditCallback({
        actor_kind: "WORKER_SCHOOL",
        actor_ref: permit.taskId,
        action: "DECRYPT_CREDENTIAL_WITH_PERMIT",
        resource_kind: "encrypted_credential",
        resource_ref: record.id,
        outcome: "SUCCESS"
      });
      return plainBuf.toString("utf8");
    } finally {
      dek.fill(0);
    }
  }

  rotateKek(newKekId, newSeedMaterial, records = []) {
    const newKek = crypto.createHash("sha256").update(newSeedMaterial).digest();
    this.kekRing.set(newKekId, newKek);
    const prevKekId = this.activeKekId;
    this.activeKekId = newKekId;
    let rotatedCount = 0;
    for (const rec of records) {
      if (rec.revoked_at) continue;
      const dek = this.unwrapDek(rec.wrapped_dek, rec.kms_key_id);
      try {
        rec.wrapped_dek = this.wrapDek(dek, newKekId).toString("base64");
        rec.kms_key_id = newKekId;
        rotatedCount++;
      } finally {
        dek.fill(0);
      }
    }
    this.auditCallback({
      actor_kind: "KMS_ROTATION",
      actor_ref: newKekId,
      action: "ROTATE_KEK",
      resource_kind: "kms_key",
      resource_ref: `${prevKekId}->${newKekId}`,
      outcome: `ROTATED_${rotatedCount}`
    });
    return { previousKekId: prevKekId, activeKekId: newKekId, rotatedCount };
  }
}

/**
 * Escrow one plaintext credential bundle for every target binding, ONE
 * independently encrypted record per binding (own UUID/DEK/nonce/AAD).
 *
 * Regression guard: previously the school-login path encrypted a single record
 * bound to ONE binding's AAD context and then assigned the same credential_ref
 * to every same-student binding. Any other binding resolving that ref fails
 * the permit's bindingId scope check — or worse, would share a credential
 * scope across bindings. Every write entry point must go through this helper.
 *
 * Order of operations: all new records are encrypted + stored first; only
 * afterwards are records that became unreferenced revoked. A mid-way failure
 * therefore can never leave a binding pointing at a record that does not
 * exist, and never destroys the last usable credential before its
 * replacement is durable.
 *
 * @returns {Map<string, object>} bindingId -> newly created credential record
 */
export function escrowCredentialForBindings({
  store,
  kmsVault,
  bindings,
  cloudUserId,
  schoolId,
  studentNo = null,
  credentialKind = "DELEGATED_SESSION_BUNDLE",
  plaintext,
  expiresAt,
  nowMs = Date.now()
}) {
  if (!plaintext || typeof plaintext !== "string") {
    throw new ContractError("BAD_REQUEST", "Plaintext credential payload must be a non-empty string");
  }
  const targets = [...new Map((bindings || []).filter(Boolean).map((b) => [b.id, b])).values()];
  if (targets.length === 0) {
    throw new ContractError("BAD_REQUEST", "escrowCredentialForBindings requires at least one target binding");
  }
  for (const b of targets) {
    if (cloudUserId && b.cloud_user_id !== cloudUserId) {
      throw new ContractError("FORBIDDEN", "Credential escrow target binding belongs to another user");
    }
    if (b.school_id !== schoolId) {
      throw new ContractError("FORBIDDEN", "Credential escrow target binding belongs to another school");
    }
    if (studentNo != null && String(b.student_no || "").trim() !== String(studentNo).trim()) {
      throw new ContractError(
        "FORBIDDEN",
        "Credential escrow target binding student_no does not match the verified student identity"
      );
    }
  }

  // 1) Encrypt a fresh record per binding (independent DEK + AAD scope)
  const newRecords = new Map();
  for (const b of targets) {
    newRecords.set(
      b.id,
      kmsVault.encryptSecret({
        bindingId: b.id,
        schoolId,
        credentialKind,
        plaintext,
        expiresAt
      })
    );
  }

  // 2) Persist + atomically re-point each binding to ITS OWN record
  const previousRefs = targets.map((b) => b.credential_ref).filter(Boolean);
  for (const b of targets) {
    const rec = newRecords.get(b.id);
    store.encryptedCredentials.set(rec.id, rec);
    b.credential_ref = rec.id;
    b.credential_expires_at = rec.expires_at;
  }

  // 3) Only after the new records exist: revoke previous records that are no
  //    longer referenced by ANY binding (shared legacy refs stay readable).
  const stillReferenced = new Set(
    [...store.schoolBindings.values()].map((x) => x.credential_ref).filter(Boolean)
  );
  const revokedOldRefIds = [];
  for (const ref of previousRefs) {
    if (!stillReferenced.has(ref) && store.encryptedCredentials.has(ref)) {
      const old = store.encryptedCredentials.get(ref);
      if (!old.revoked_at) {
        old.revoked_at = new Date(nowMs).toISOString();
      }
      revokedOldRefIds.push(ref);
    }
  }
  return newRecords;
}

/**
 * Read-only consistency audit of binding -> credential_ref integrity.
 * Reports structural violations only; never outputs plaintext or ciphertext.
 */
export function auditCredentialRefConsistency(store, nowMs = Date.now()) {
  const issues = [];
  const refUsage = new Map();
  for (const b of store.schoolBindings.values()) {
    if (!b?.credential_ref) continue;
    refUsage.set(b.credential_ref, (refUsage.get(b.credential_ref) || 0) + 1);
    const rec = store.encryptedCredentials.get(b.credential_ref);
    if (!rec) {
      issues.push({
        type: "MISSING_CREDENTIAL_RECORD",
        binding_id: b.id,
        credential_ref: b.credential_ref
      });
      continue;
    }
    if (rec.binding_id !== b.id) {
      issues.push({
        type: "BINDING_ID_MISMATCH",
        binding_id: b.id,
        credential_ref: b.credential_ref,
        record_binding_id: rec.binding_id
      });
    }
    if (rec.school_id !== b.school_id) {
      issues.push({
        type: "SCHOOL_MISMATCH",
        binding_id: b.id,
        credential_ref: b.credential_ref,
        record_school_id: rec.school_id
      });
    }
    const recordOwner = rec.binding_id ? store.schoolBindings.get(rec.binding_id) : null;
    if (recordOwner && recordOwner.cloud_user_id !== b.cloud_user_id) {
      issues.push({
        type: "CROSS_USER_REFERENCE",
        binding_id: b.id,
        credential_ref: b.credential_ref,
        record_binding_id: rec.binding_id
      });
    }
    if (rec.revoked_at && !b.revoked_at && b.status !== "REVOKED") {
      issues.push({
        type: "REVOKED_RECORD_IN_USE",
        binding_id: b.id,
        credential_ref: b.credential_ref
      });
    }
    if (
      rec.expires_at &&
      new Date(rec.expires_at).getTime() <= nowMs &&
      !b.revoked_at &&
      b.status !== "REVOKED"
    ) {
      issues.push({
        type: "EXPIRED_RECORD_IN_USE",
        binding_id: b.id,
        credential_ref: b.credential_ref
      });
    }
  }
  for (const [ref, count] of refUsage) {
    if (count > 1) {
      issues.push({
        type: "SHARED_CREDENTIAL_REF",
        credential_ref: ref,
        binding_count: count
      });
    }
  }
  return {
    checked_at: new Date(nowMs).toISOString(),
    issue_count: issues.length,
    issues
  };
}

/**
 * Canonical JSON serialization + Ed25519 signing/verification for `dis-extension/v2` and `dis-campus-plugin/v1`.
 */
export function canonicalizeJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalizeJson(value[k])}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function generateEd25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyBase64: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")
  };
}

export function signPluginManifest(manifest, privateKeyBase64) {
  const canonical = canonicalizeJson(manifest);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8"
  });
  const sig = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKey);
  return sig.toString("base64");
}

export function verifyPluginManifestSignature(manifest, signatureBase64, publicKeyBase64) {
  try {
    const canonical = canonicalizeJson(manifest);
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki"
    });
    return crypto.verify(
      null,
      Buffer.from(canonical, "utf8"),
      publicKey,
      Buffer.from(signatureBase64, "base64")
    );
  } catch {
    return false;
  }
}
