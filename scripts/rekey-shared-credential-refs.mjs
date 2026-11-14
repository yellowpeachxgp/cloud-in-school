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
 *      binding_id: verifies same cloud_user_id + school_id + student_no as
 *      the record owner, decrypts the ORIGINAL record via a correctly scoped
 *      permit for its owner binding, then re-encrypts an INDEPENDENT record
 *      per affected binding and re-points credential_ref.
 *   3. Bindings that cannot be safely proven (missing owner binding,
 *      different user/school/student identity, revoked/expired/undecryptable
 *      record) are marked credential_needs_reconfirmation = true so the user
 *      re-verifies instead of us guessing. Migration NEVER decrypts a record
 *      whose owner binding cannot be identified, and NEVER revives plans.
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

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, ".rekey-" + process.pid + "-" + Date.now() + ".tmp");
  const payload = Buffer.from(JSON.stringify(obj, null, 2));
  fs.writeFileSync(tmp, payload);
  const fd = fs.openSync(tmp, "r+");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  const check = JSON.parse(fs.readFileSync(tmp, "utf8"));
  if (sha256Hex(Buffer.from(JSON.stringify(check))) !== sha256Hex(Buffer.from(JSON.stringify(JSON.parse(payload.toString("utf8")))))) {
    fs.rmSync(tmp, { force: true });
    throw new Error("Post-write verification failed; refusing rename");
  }
  fs.renameSync(tmp, filePath);
}

export function rekeySharedCredentialRefs(rawState, kmsVault, { nowMs = Date.now(), apply = false } = {}) {
  const bindings = new Map(rawState.schoolBindings || []);
  const creds = new Map(rawState.encryptedCredentials || []);
  const ts = new Date(nowMs).toISOString();
  const report = {
    checked_at: ts,
    apply,
    total_bindings: bindings.size,
    shared_ref_groups: 0,
    mismatched_bindings: [],
    rekeyed: [],
    needs_reconfirmation: [],
    skipped_active_owner: 0
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
      if (mismatched || b.credential_needs_reconfirmation) {
        candidateSet.add(b.id);
      }
    }
  }

  for (const bindId of candidateSet) {
    const b = bindings.get(bindId);
    if (!b || b.revoked_at || b.status === "REVOKED") continue;
    const rec = creds.get(b.credential_ref);
    const owner = rec?.binding_id ? bindings.get(rec.binding_id) : null;
    const identityProvable =
      rec &&
      owner &&
      owner.cloud_user_id === b.cloud_user_id &&
      owner.school_id === b.school_id &&
      String(owner.student_no || "").trim() === String(b.student_no || "").trim() &&
      !rec.revoked_at &&
      (!rec.expires_at || new Date(rec.expires_at).getTime() > nowMs);

    if (!identityProvable) {
      b.credential_needs_reconfirmation = true;
      report.needs_reconfirmation.push({ binding_id: b.id, credential_ref: b.credential_ref });
      continue;
    }

    // Decrypt via a permit correctly scoped to the RECORD OWNER binding.
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
      report.needs_reconfirmation.push({ binding_id: b.id, credential_ref: b.credential_ref });
      continue;
    }

    const fresh = kmsVault.encryptSecret({
      bindingId: b.id,
      schoolId: b.school_id,
      credentialKind: rec.secret_type || "DELEGATED_SESSION_BUNDLE",
      plaintext,
      expiresAt: rec.expires_at
    });
    plaintext = null;
    if (apply) {
      creds.set(fresh.id, fresh);
      b.credential_ref = fresh.id;
      b.credential_expires_at = fresh.expires_at;
      b.credential_needs_reconfirmation = false;
    }
    report.rekeyed.push({ binding_id: b.id, old_ref: rec.id, new_ref: fresh.id });
  }

  if (apply) {
    rawState.schoolBindings = [...bindings.entries()];
    rawState.encryptedCredentials = [...creds.entries()];
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
  const { report } = rekeySharedCredentialRefs(raw, vault, { apply: args.apply });
  console.log(JSON.stringify(report, null, 2));
  if (args.apply) {
    const backup = statePath + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(statePath, backup);
    const fd = fs.openSync(backup, "r+");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    atomicWriteJson(statePath, raw);
    console.log("Applied. Backup at " + backup);
  } else {
    console.log("Dry-run only. Re-run with --apply to persist.");
  }
}
