#!/usr/bin/env node
/**
 * Auditable, rollback-safe inspection and sanitization tool for persisted `cloud-state.json`
 * Moments data (legacy unowned posts & historical "【私密联系发起人】" prefix comments).
 *
 * Safety invariants:
 * - Rejects same physical file between --state and --backup/--rollback (including symlinks, hardlinks, relative/dir aliases).
 * - Creates backup exclusively ("wx") without overwriting any existing backup file, fsyncs, and verifies SHA-256 BEFORE touching --state.
 * - Writes sanitized output to an exclusive sibling temp file, fsyncs, verifies JSON + SHA-256, then atomically renames over --state.
 * - Any failure during backup or temp write leaves --state 100% unmodified.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function isSameInode(statA, statB) {
  return Boolean(
    statA &&
      statB &&
      statA.dev !== undefined &&
      statA.ino !== undefined &&
      statA.dev === statB.dev &&
      statA.ino === statB.ino
  );
}

export function inspectAndSanitizeMomentsSnapshotObject(rawStateObj) {
  const cloned = structuredClone(rawStateObj || {});
  const moments = cloned.momentsState;
  const report = {
    total_posts: 0,
    legacy_unowned_posts: [],
    legacy_unowned_books_count: 0,
    legacy_unowned_tags_count: 0,
    legacy_private_prefix_comments_unflagged: [],
    mutated_comments_count: 0
  };

  if (!moments || typeof moments !== "object") {
    return { sanitizedState: cloned, report, mutated: false };
  }

  let mutated = false;
  if (Array.isArray(moments.book_listings)) {
    report.legacy_unowned_books_count = moments.book_listings.filter(
      (b) => b && !b.owner_cloud_user_id
    ).length;
  }
  if (Array.isArray(moments.anti_lost_tags)) {
    report.legacy_unowned_tags_count = moments.anti_lost_tags.filter(
      (t) => t && !t.owner_cloud_user_id
    ).length;
  }

  if (!Array.isArray(moments.posts)) {
    return { sanitizedState: cloned, report, mutated };
  }
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

function writeFileExclusiveAndFsync(targetPath, buf, fsImpl = fs) {
  const fd = fsImpl.openSync(targetPath, "wx", 0o600);
  let closed = false;
  try {
    let offset = 0;
    while (offset < buf.length) {
      const written = fsImpl.writeSync(fd, buf, offset, buf.length - offset);
      if (written <= 0) {
        throw new Error(`Short write while writing ${targetPath}`);
      }
      offset += written;
    }
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    closed = true;
  } catch (err) {
    if (!closed) {
      try {
        fsImpl.closeSync(fd);
      } catch {}
    }
    try {
      fsImpl.unlinkSync(targetPath);
    } catch {}
    throw err;
  }
}

export function applyMomentsStateSanitizationFile({ statePath, backupPath, fsImpl = fs }) {
  if (!statePath || !String(statePath).trim()) {
    throw new Error("Missing required statePath");
  }
  if (!backupPath || !String(backupPath).trim()) {
    throw new Error("--apply requires a distinct backupPath for verifiable rollback");
  }

  const resolvedState = path.resolve(statePath);
  const resolvedBackup = path.resolve(backupPath);
  if (resolvedBackup === resolvedState) {
    throw new Error("Backup path must not be identical to state file path");
  }

  const stateStat = fsImpl.statSync(resolvedState);
  if (!stateStat.isFile()) {
    throw new Error("State path must point to a regular file");
  }
  const realStatePath = fsImpl.realpathSync(resolvedState);

  // Check if backup path already exists (regular file, symlink, hardlink, or directory)
  let existingBackupLstat = null;
  try {
    existingBackupLstat = fsImpl.lstatSync(resolvedBackup);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }

  if (existingBackupLstat) {
    let existingBackupTargetStat = null;
    try {
      existingBackupTargetStat = fsImpl.statSync(resolvedBackup);
    } catch {}
    if (isSameInode(stateStat, existingBackupTargetStat)) {
      throw new Error("Backup path resolves to the same physical file (link/alias) as state file");
    }
    throw new Error("Backup file already exists; refusing to overwrite existing backup");
  }

  // Read & parse source state before creating any directories/files
  const rawBuf = fsImpl.readFileSync(realStatePath);
  const beforeSha256 = sha256Hex(rawBuf);
  const parsed = JSON.parse(rawBuf.toString("utf8"));
  const { sanitizedState, report, mutated } = inspectAndSanitizeMomentsSnapshotObject(parsed);

  // Ensure backup parent directory exists and verify directory symlink aliases do not collide with realStatePath
  const backupParentDir = path.dirname(resolvedBackup);
  fsImpl.mkdirSync(backupParentDir, { recursive: true });
  const realBackupParentDir = fsImpl.realpathSync(backupParentDir);
  const canonicalBackupTarget = path.join(realBackupParentDir, path.basename(resolvedBackup));
  if (canonicalBackupTarget === realStatePath) {
    throw new Error("Backup path alias resolves to the same physical path as state file");
  }

  // 1. Exclusive backup creation ("wx") + fsync + inode & SHA-256 verification
  writeFileExclusiveAndFsync(resolvedBackup, rawBuf, fsImpl);
  const createdBackupStat = fsImpl.statSync(resolvedBackup);
  if (isSameInode(stateStat, createdBackupStat)) {
    throw new Error("Backup file unexpectedly shares inode with state file; aborting");
  }
  const verifiedBackupBuf = fsImpl.readFileSync(resolvedBackup);
  if (sha256Hex(verifiedBackupBuf) !== beforeSha256) {
    throw new Error("Backup SHA-256 verification failed; aborting without modifying state");
  }

  // 2. Write sanitized output to sibling exclusive temp file, verify, then atomically replace realStatePath
  const nextBuf = Buffer.from(`${JSON.stringify(sanitizedState, null, 2)}\n`, "utf8");
  const expectedAfterSha256 = sha256Hex(nextBuf);
  const tmpPath = path.join(
    path.dirname(realStatePath),
    `.${path.basename(realStatePath)}.sanitize.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`
  );

  writeFileExclusiveAndFsync(tmpPath, nextBuf, fsImpl);
  try {
    const tmpVerifyBuf = fsImpl.readFileSync(tmpPath);
    if (sha256Hex(tmpVerifyBuf) !== expectedAfterSha256) {
      throw new Error("Sanitized temp file SHA-256 verification failed");
    }
    JSON.parse(tmpVerifyBuf.toString("utf8"));
    fsImpl.renameSync(tmpPath, realStatePath);
  } catch (err) {
    try {
      fsImpl.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }

  const afterSha256 = sha256Hex(fsImpl.readFileSync(realStatePath));
  return {
    mode: "APPLIED",
    state_path: realStatePath,
    backup_path: resolvedBackup,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
    mutated,
    report
  };
}

export function rollbackMomentsStateFromBackup({ statePath, backupPath, fsImpl = fs }) {
  const resolvedState = path.resolve(statePath || "");
  const resolvedBackup = path.resolve(backupPath || "");
  if (!statePath || !backupPath || resolvedState === resolvedBackup) {
    throw new Error("Rollback requires distinct statePath and backupPath");
  }
  const backupStat = fsImpl.statSync(resolvedBackup);
  if (!backupStat.isFile()) {
    throw new Error("Backup path must be a regular file");
  }
  let realStateTarget = resolvedState;
  try {
    const stateStat = fsImpl.statSync(resolvedState);
    if (isSameInode(stateStat, backupStat)) {
      throw new Error("Rollback backup resolves to the same physical file as state file");
    }
    realStateTarget = fsImpl.realpathSync(resolvedState);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }

  const backupBuf = fsImpl.readFileSync(resolvedBackup);
  JSON.parse(backupBuf.toString("utf8"));
  const expectedSha256 = sha256Hex(backupBuf);
  const tmpPath = path.join(
    path.dirname(realStateTarget),
    `.${path.basename(realStateTarget)}.rollback.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`
  );
  writeFileExclusiveAndFsync(tmpPath, backupBuf, fsImpl);
  try {
    if (sha256Hex(fsImpl.readFileSync(tmpPath)) !== expectedSha256) {
      throw new Error("Rollback temp file verification failed");
    }
    fsImpl.renameSync(tmpPath, realStateTarget);
  } catch (err) {
    try {
      fsImpl.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
  return {
    action: "ROLLBACK_COMPLETED",
    restored_from: resolvedBackup,
    target: realStateTarget,
    sha256: expectedSha256
  };
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

const invokedEntryHref = (() => {
  try {
    return process.argv[1] ? pathToFileURL(fs.realpathSync(process.argv[1])).href : "";
  } catch {
    return process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
  }
})();

if (import.meta.url === invokedEntryHref) {
  const args = parseArgs(process.argv);
  if (!args.statePath) {
    console.error("Missing required --state <path/to/cloud-state.json>");
    process.exit(2);
  }

  if (args.rollbackPath) {
    const res = rollbackMomentsStateFromBackup({
      statePath: args.statePath,
      backupPath: args.rollbackPath
    });
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }

  if (!args.apply) {
    const resolvedState = path.resolve(args.statePath);
    const rawBuf = fs.readFileSync(resolvedState);
    const beforeSha256 = sha256Hex(rawBuf);
    const parsed = JSON.parse(rawBuf.toString("utf8"));
    const { report, mutated } = inspectAndSanitizeMomentsSnapshotObject(parsed);
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

  const applied = applyMomentsStateSanitizationFile({
    statePath: args.statePath,
    backupPath: args.backupPath
  });
  console.log(JSON.stringify(applied, null, 2));
}
