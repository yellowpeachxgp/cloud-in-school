#!/usr/bin/env node
/**
 * Controlled re-key migration for shared/mismatched credential_ref records.
 *
 * Background: an earlier bug encrypted ONE credential record bound to a single
 * binding's AAD and assigned the same credential_ref to every same-student
 * binding. Non-owner bindings can never satisfy the access-permit scope check
 * (permit bindingId != record.binding_id), so their decryption always fails.
 *
 * This tool, run in a controlled single-writer process (service STOPPED):
 *   1. Audits every binding -> credential_ref integrity (read-only).
 *   2. For each binding whose ref is shared or bound to a different
 *      binding_id: classifies via classifyMigrationCandidate — strict
 *      identity/authorization proof is required BEFORE any permit is issued.
 *      Only then decrypts the ORIGINAL record via a correctly scoped permit
 *      for its owner binding and re-encrypts an INDEPENDENT record per
 *      affected binding.
 *   3. Everything that cannot be PROVEN keeps its old ref, is never
 *      decrypted, and is marked credential_needs_reconfirmation with an
 *      auditable reason code — users re-verify instead of us guessing.
 *      Migration NEVER decrypts a record whose owner cannot be identified,
 *      NEVER revives plans, and NEVER auto-clears a reconfirmation that was
 *      set for non-integrity reasons.
 *
 * Dry-run is TRULY read-only: inputs are deep-cloned before any analysis, so
 * callers reusing or persisting the passed state can never pick up half-marks.
 * Apply builds a fully staged state first (all new records + all binding
 * updates), swaps it atomically, and only then writes the file.
 *
 * Usage:
 *   node scripts/rekey-shared-credential-refs.mjs --state <cloud-state.json>          # dry-run (default)
 *   node scripts/rekey-shared-credential-refs.mjs --state <cloud-state.json> --apply  # write atomically with .bak backup
 *
 * Requires KMS_MASTER_SEED (same KEK material the service uses) so records can
 * be decrypted/re-encrypted. Never logs plaintext, ciphertext or secrets.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { KmsEnvelopeVault } from "../packages/crypto/src/index.mjs";

// Reconfirmation causes this migration is allowed to clear — the shared-ref
// bug's own integrity defects ONLY. Anything resembling an authorization or
// risk decision (revoked, risk-review, reverify, unknown, blank) is NEVER
// cleared by a credential migration.
const INTEGRITY_CLEARABLE_REASONS = new Set([
  "INTEGRITY_MISMATCH",
  "SHARED_CREDENTIAL_REF",
  "MISMATCHED_RECORD_BINDING",
  "CREDENTIAL_REF_SHARED_DETECTED"
]);

const ALLOWED_CREDENTIAL_KINDS = new Set([
  "DELEGATED_SESSION_BUNDLE",
  "LIVE_SESSION_BUNDLE",
  "ACCOUNT_PASSWORD_BUNDLE"
]);

// Binding statuses that may act as migration source or target.
const LIVE_BINDING_STATUSES = new Set([
  "DELEGATED_ACTIVE",
  "VERIFIED_LOCAL_ONLY",
  "ACTIVE",
  "PENDING_LIVE_VERIFY"
]);

function parseArgs(argv) {
  const args = { apply: false, state: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--state") {
      i += 1;
      args.state = argv[i];
    }
  }
  return args;
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function isNonBlank(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function normalizeStudentNo(v) {
  return isNonBlank(v) ? v.trim().toUpperCase() : null;
}

/**
 * Pure classifier: decides whether a mismatched/shared-ref binding MAY be
 * re-keyed from a given source record. Every unproven dimension fails closed.
 * Returns { decision: "ALLOW" | "RECONFIRM" | "SKIP", reason }.
 *   ALLOW     — full identity + provenance proof; safe to decrypt & re-key
 *   RECONFIRM — evidence insufficient/contradictory; mark for re-verify
 *   SKIP      — binding state makes it ineligible entirely (revoked, no ref)
 */
export function classifyMigrationCandidate({ binding, owner, record, nowMs }) {
  const fail = (reason) => ({ decision: "RECONFIRM", reason });
  const skip = (reason) => ({ decision: "SKIP", reason });

  // 1) Subject sanity: non-empty required identity strings, no || "" collapse.
  if (!binding || !isNonBlank(binding.id)) return skip("MISSING_BINDING");
  if (!isNonBlank(binding.cloud_user_id)) return fail("MISSING_USER_ID");
  if (!isNonBlank(binding.school_id)) return fail("MISSING_SCHOOL_ID");
  if (binding.revoked_at || binding.status === "REVOKED") return skip("TARGET_REVOKED");
  if (!LIVE_BINDING_STATUSES.has(binding.status)) return skip("TARGET_STATUS_INELIGIBLE");
  if (!isNonBlank(binding.credential_ref)) return skip("NO_CREDENTIAL_REF");

  // 2) Record sanity: exists, approved kind, not revoked, valid + unexpired dates.
  if (!record || !isNonBlank(record.id)) return fail("RECORD_MISSING");
  if (binding.credential_ref !== record.id) return fail("REF_RECORD_ID_MISMATCH");
  if (!ALLOWED_CREDENTIAL_KINDS.has(record.secret_type)) {
    return fail("UNKNOWN_CREDENTIAL_KIND");
  }
  if (record.revoked_at) return fail("RECORD_REVOKED");
  if (record.expires_at) {
    const expMs = Date.parse(record.expires_at);
    if (!Number.isFinite(expMs)) return fail("RECORD_EXPIRY_MALFORMED");
    if (expMs <= nowMs) return fail("RECORD_EXPIRED");
  } else {
    // No-expiry historical records cannot be proven still-valid — product/
    // security approval required; never assume forever-valid.
    return fail("RECORD_NO_EXPIRY_PROOF");
  }

  // 3) Owner binding sanity: exists, ALIVE, and STILL points at this record —
  //    an owner that moved to a newer credential is not a proven source.
  if (!owner || !isNonBlank(owner.id)) return fail("OWNER_MISSING");
  if (!isNonBlank(owner.credential_ref) || owner.credential_ref !== record.id) {
    return fail("OWNER_POINTS_ELSEWHERE");
  }
  if (owner.revoked_at || owner.status === "REVOKED") return fail("OWNER_REVOKED");
  if (!LIVE_BINDING_STATUSES.has(owner.status)) return fail("OWNER_STATUS_INELIGIBLE");

  // 4) Identity equality on EVERY dimension — non-empty, uniformly normalized.
  const targetStudent = normalizeStudentNo(binding.student_no);
  const ownerStudent = normalizeStudentNo(owner.student_no);
  if (!targetStudent || !ownerStudent || targetStudent !== ownerStudent) {
    return fail("STUDENT_MISMATCH");
  }
  if (
    !isNonBlank(owner.cloud_user_id) ||
    owner.cloud_user_id !== binding.cloud_user_id
  ) {
    return fail("USER_MISMATCH");
  }
  if (
    !isNonBlank(owner.school_id) ||
    owner.school_id !== binding.school_id ||
    record.school_id !== binding.school_id
  ) {
    return fail("SCHOOL_MISMATCH");
  }

  return { decision: "ALLOW", reason: "PROVEN_SAME_IDENTITY" };
}

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, ".rekey-" + process.pid + "-" + Date.now() + ".tmp");
  const payload = Buffer.from(JSON.stringify(obj, null, 2));
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  const fd = fs.openSync(tmp, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const check = JSON.parse(fs.readFileSync(tmp, "utf8"));
  if (
    sha256Hex(Buffer.from(JSON.stringify(check))) !==
    sha256Hex(Buffer.from(JSON.stringify(JSON.parse(payload.toString("utf8")))))
  ) {
    fs.rmSync(tmp, { force: true });
    throw new Error("Post-write verification failed; refusing rename");
  }
  fs.renameSync(tmp, filePath);
  // fsync the parent dir so the rename itself is durable.
  try {
    const dfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    /* directory fsync is best-effort on some filesystems */
  }
}

export function rekeySharedCredentialRefs(rawState, kmsVault, { nowMs = Date.now(), apply = false } = {}) {
  // Deep isolation: dry-run must be provably read-only; even apply works on a
  // staged copy so a mid-way failure can never leak a half-updated state.
  const staged = structuredClone(rawState);
  const bindings = new Map(staged.schoolBindings || []);
  const creds = new Map(staged.encryptedCredentials || []);
  const ts = new Date(nowMs).toISOString();
  const report = {
    checked_at: ts,
    apply,
    total_bindings: bindings.size,
    shared_ref_groups: 0,
    mismatched_bindings: [],
    rekeyed: [],
    needs_reconfirmation: [],
    skipped: [],
    errors: []
  };

  // Group holders per credential_ref
  const holders = new Map();
  for (const b of bindings.values()) {
    if (!b?.credential_ref) continue;
    if (!holders.has(b.credential_ref)) holders.set(b.credential_ref, []);
    holders.get(b.credential_ref).push(b);
  }

  const candidateSet = new Set();
  for (const [ref, list] of holders) {
    const rec = creds.get(ref);
    if (list.length > 1) report.shared_ref_groups += 1;
    for (const b of list) {
      const mismatched = !rec || rec.binding_id !== b.id;
      // Eligibility gate (M1): a binding enters the migration candidate set
      // only if (a) its ref is provably broken (mismatched/shared — the bug's
      // own symptom, authorization-independent), or (b) it was flagged with a
      // reason the migration is licensed to clear. Flags set for any other
      // reason (risk/revoke/reverify/unknown) are never touched.
      const reason = typeof b.credential_reconfirm_reason === "string" ? b.credential_reconfirm_reason : null;
      const flaggedForIntegrity = Boolean(b.credential_needs_reconfirmation) && reason && INTEGRITY_CLEARABLE_REASONS.has(reason);
      const flaggedForOther = Boolean(b.credential_needs_reconfirmation) && !flaggedForIntegrity;
      if (flaggedForOther) {
        // Report, never decrypt, never clear — authorization decisions are
        // outside a credential migration's remit.
        report.skipped.push({
          binding_id: b.id,
          reason: "RECONFIRM_REASON_NOT_CLEARABLE:" + (reason || "UNKNOWN")
        });
        continue;
      }
      if (mismatched || flaggedForIntegrity) {
        candidateSet.add(b.id);
        report.mismatched_bindings.push({
          binding_id: b.id,
          credential_ref: b.credential_ref,
          record_binding_id: rec?.binding_id ?? null,
          shared_group_size: list.length,
          reconfirm_reason: reason
        });
      }
    }
  }

  // Staged writes — committed only when apply=true after ALL candidates were
  // processed without throwing.
  const stagedNewRecords = [];
  const stagedBindingUpdates = new Map(); // binding_id -> {credential_ref, credential_expires_at}

  for (const bindId of candidateSet) {
    const b = bindings.get(bindId);
    const rec = creds.get(b?.credential_ref);
    const owner = rec?.binding_id ? bindings.get(rec.binding_id) : null;

    // R4-M1: source-owner gate — a record owned by a binding flagged for a
    // non-integrity reason (risk review, revoked, reverify, unknown) is NOT a
    // proven source; re-hosting its plaintext onto a new record would launder
    // an authorization decision. Target gets reconfirmation, never a permit.
    const ownerReason =
      typeof owner?.credential_reconfirm_reason === "string"
        ? owner.credential_reconfirm_reason
        : null;
    if (
      owner &&
      owner.credential_needs_reconfirmation &&
      !INTEGRITY_CLEARABLE_REASONS.has(ownerReason)
    ) {
      b.credential_needs_reconfirmation = true;
      b.credential_reconfirm_reason = "SOURCE_OWNER_NOT_CLEARABLE:" + (ownerReason || "UNKNOWN");
      report.needs_reconfirmation.push({
        binding_id: b.id,
        credential_ref: b.credential_ref,
        reason: b.credential_reconfirm_reason,
        source_owner_binding_id: owner.id
      });
      continue;
    }
    const verdict = classifyMigrationCandidate({ binding: b, owner, record: rec, nowMs });

    if (verdict.decision === "SKIP") {
      report.skipped.push({ binding_id: b?.id || bindId, reason: verdict.reason });
      continue;
    }
    if (verdict.decision === "RECONFIRM") {
      b.credential_needs_reconfirmation = true;
      b.credential_reconfirm_reason = verdict.reason;
      report.needs_reconfirmation.push({
        binding_id: b.id,
        credential_ref: b.credential_ref,
        reason: verdict.reason
      });
      continue;
    }

    // ALLOW — decrypt via a permit correctly scoped to the RECORD OWNER binding.
    let plaintext = null;
    try {
      const permit = kmsVault.issueAccessPermit({
        taskId: "rekey-" + bindId.slice(0, 8),
        schoolId: rec.school_id,
        bindingId: owner.id,
        credentialRef: rec.id,
        ttlSeconds: 30,
        nowMs
      });
      plaintext = kmsVault.decryptSecretWithPermit(rec, permit, nowMs);
    } catch {
      b.credential_needs_reconfirmation = true;
      b.credential_reconfirm_reason = "DECRYPT_FAILED";
      report.needs_reconfirmation.push({
        binding_id: b.id,
        credential_ref: b.credential_ref,
        reason: "DECRYPT_FAILED"
      });
      continue;
    }

    const fresh = kmsVault.encryptSecret({
      bindingId: b.id,
      schoolId: b.school_id,
      credentialKind: rec.secret_type,
      plaintext,
      expiresAt: rec.expires_at
    });
    plaintext = null;
    stagedNewRecords.push(fresh);
    stagedBindingUpdates.set(b.id, {
      credential_ref: fresh.id,
      credential_expires_at: fresh.expires_at
    });
    report.rekeyed.push({ binding_id: b.id, old_ref: rec.id, new_ref: fresh.id });
  }

  if (apply) {
    for (const rec of stagedNewRecords) creds.set(rec.id, rec);
    for (const [id, upd] of stagedBindingUpdates) {
      const b = bindings.get(id);
      if (b) {
        b.credential_ref = upd.credential_ref;
        b.credential_expires_at = upd.credential_expires_at;
        // Cleared cause is provably integrity-only: eligibility gating above
        // guarantees authorization reasons never reached this branch. If a
        // binding somehow still carries an unknown reason, keep it.
        if (!b.credential_reconfirm_reason || INTEGRITY_CLEARABLE_REASONS.has(b.credential_reconfirm_reason)) {
          b.credential_needs_reconfirmation = false;
          b.credential_reconfirm_reason = null;
        }
      }
    }
    staged.schoolBindings = [...bindings.entries()];
    staged.encryptedCredentials = [...creds.entries()];
    return { rawState: staged, report };
  }
  return { rawState, report };
}

const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;
if (isMain) {
  const args = parseArgs(process.argv);
  if (!args.state) {
    console.error("Usage: rekey-shared-credential-refs.mjs --state <cloud-state.json> [--apply]");
    process.exit(2);
  }
  const statePath = path.resolve(args.state);
  const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const vault = new KmsEnvelopeVault({});
  const { rawState: stagedState, report } = rekeySharedCredentialRefs(raw, vault, {
    apply: args.apply
  });
  console.log(JSON.stringify(report, null, 2));
  if (args.apply) {
    const backup = statePath + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(statePath, backup, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(backup, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Write the STAGED state — never the unmodified input object.
    atomicWriteJson(statePath, stagedState);
    console.log("Applied. Backup at " + backup);
  } else {
    console.log("Dry-run only. Re-run with --apply to persist.");
  }
}
