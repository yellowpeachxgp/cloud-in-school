#!/usr/bin/env node
/**
 * Auditable, rollback-safe inspection and sanitization tool for persisted `cloud-state.json`
 * Moments data (legacy unowned posts & historical "【私密联系发起人】" prefix comments).
 *
 * Usage (offline / maintenance window — never edit a live unstopped process file in place):
 *   1. Dry-run audit (read-only):
 *      node scripts/audit-and-sanitize-moments-state.mjs --state /path/to/cloud-state.json --check
 *   2. Apply with mandatory backup & SHA-256 verification:
 *      node scripts/audit-and-sanitize-moments-state.mjs --state /path/to/cloud-state.json --apply --backup /path/to/cloud-state.backup.json
 *   3. Rollback from backup:
 *      node scripts/audit-and-sanitize-moments-state.mjs --state /path/to/cloud-state.json --rollback /path/to/cloud-state.backup.json
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function inspectAndSanitizeMomentsSnapshotObject(rawStateObj) {
  const cloned = structuredClone(rawStateObj || {});
  const moments = cloned.momentsState;
  const report = {
    total_posts: 0,
    legacy_unowned_posts: [],
    legacy_private_prefix_comments_unflagged: [],
    mutated_comments_count: 0
  };

  if (!moments || !Array.isArray(moments.posts)) {
    return { sanitizedState: cloned, report, mutated: false };
  }

  let mutated = false;
  report.total_posts = moments.posts.length;

  for (const post of moments.posts) {
    if (!post || typeof post !== "object") continue;
    if (!post.owner_cloud_user_id) {
      report.legacy_unowned_posts.push({
        id: post.id,
        title: post.title,
        status: post.status,
        contact_visibility: post.contact_visibility || "PUBLIC",
        has_masked_student_no: Boolean(String(post.author_student_no_masked || "").trim()),
        created_at: post.created_at || null
      });
    }
    if (!Array.isArray(post.comments)) {
      post.comments = [];
      mutated = true;
    }
    for (const c of post.comments) {
      if (!c || typeof c !== "object") continue;
      const content = String(c.content || "").trim();
      if (content.startsWith("【私密联系发起人】") && c.is_private_to_initiator !== true) {
        report.legacy_private_prefix_comments_unflagged.push({
          post_id: post.id,
          comment_id: c.id,
          created_at: c.created_at || null
        });
        c.is_private_to_initiator = true;
        report.mutated_comments_count += 1;
        mutated = true;
      }
    }
  }

  return { sanitizedState: cloned, report, mutated };
}

function parseArgs(argv) {
  const out = { check: true, apply: false, statePath: "", backupPath: "", rollbackPath: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--apply") {
      out.apply = true;
      out.check = false;
    } else if (a === "--state") out.statePath = argv[++i] || "";
    else if (a === "--backup") out.backupPath = argv[++i] || "";
    else if (a === "--rollback") {
      out.rollbackPath = argv[++i] || "";
      out.check = false;
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);
  if (!args.statePath) {
    console.error("Missing required --state <path/to/cloud-state.json>");
    process.exit(2);
  }
  const resolvedState = path.resolve(args.statePath);

  if (args.rollbackPath) {
    const resolvedBackup = path.resolve(args.rollbackPath);
    const backupBuf = fs.readFileSync(resolvedBackup);
    JSON.parse(backupBuf.toString("utf8"));
    const tmpPath = `${resolvedState}.rollback.tmp`;
    fs.writeFileSync(tmpPath, backupBuf);
    fs.renameSync(tmpPath, resolvedState);
    console.log(
      JSON.stringify(
        {
          action: "ROLLBACK_COMPLETED",
          restored_from: resolvedBackup,
          target: resolvedState,
          sha256: sha256Hex(backupBuf)
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  const rawBuf = fs.readFileSync(resolvedState);
  const beforeSha256 = sha256Hex(rawBuf);
  const parsed = JSON.parse(rawBuf.toString("utf8"));
  const { sanitizedState, report, mutated } = inspectAndSanitizeMomentsSnapshotObject(parsed);

  if (!args.apply) {
    console.log(
      JSON.stringify(
        {
          mode: "CHECK_ONLY",
          state_path: resolvedState,
          before_sha256: beforeSha256,
          would_mutate: mutated,
          report
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  if (!args.backupPath) {
    console.error("--apply requires --backup <path/to/backup.json> for verifiable rollback");
    process.exit(2);
  }
  const resolvedBackup = path.resolve(args.backupPath);
  fs.mkdirSync(path.dirname(resolvedBackup), { recursive: true });
  fs.writeFileSync(resolvedBackup, rawBuf);
  if (sha256Hex(fs.readFileSync(resolvedBackup)) !== beforeSha256) {
    throw new Error("Backup SHA-256 verification failed; aborting without modifying state");
  }

  const nextBuf = Buffer.from(`${JSON.stringify(sanitizedState, null, 2)}\n`, "utf8");
  const tmpPath = `${resolvedState}.sanitize.tmp`;
  fs.writeFileSync(tmpPath, nextBuf);
  fs.renameSync(tmpPath, resolvedState);
  const afterSha256 = sha256Hex(fs.readFileSync(resolvedState));

  console.log(
    JSON.stringify(
      {
        mode: "APPLIED",
        state_path: resolvedState,
        backup_path: resolvedBackup,
        before_sha256: beforeSha256,
        after_sha256: afterSha256,
        mutated,
        report
      },
      null,
      2
    )
  );
}
