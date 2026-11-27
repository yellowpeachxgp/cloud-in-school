#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_CLOUD_REF = "origin/main";
const MAX_GIT_BUFFER = 64 * 1024 * 1024;
const CLOUD_REPOSITORY_NAME = "cloud-in-school";
const ORIGIN_MAIN_FETCH_REFSPEC = "+refs/heads/main:refs/remotes/origin/main";

const USAGE = "用法：\n" +
  "  node tools/contract-ci/sync-contracts.mjs sync --cloud-root <云端仓库> --android-root <Android仓库> [--cloud-ref origin/main]\n" +
  "  node tools/contract-ci/sync-contracts.mjs sync --cloud-root <云端仓库> --android-root <Android仓库> --use-cloud-worktree\n" +
  "  node tools/contract-ci/sync-contracts.mjs check --cloud-root <云端仓库 checkout 或完整导出> --android-root <Android仓库> [--cloud-ref <ref>]\n" +
  "  node tools/contract-ci/sync-contracts.mjs fingerprint --root <仓库>\n" +
  "\n" +
  "规则：\n" +
  "  - cloud-in-school/contracts/ 是唯一权威；sync 只从云端复制到 Android，绝不反向复制。\n" +
  "  - sync 默认先执行 git fetch origin +refs/heads/main:refs/remotes/origin/main，再读取云端 git origin/main；显式 --cloud-ref 或 --use-cloud-worktree 时不自动 fetch。\n" +
  "  - sync 先完整 staging 并备份受影响文件；每个文件用临时文件加 rename 替换，异常时按逆序回滚。\n" +
  "  - check 对两棵 contracts/ 树做递归文件清单与 SHA-256 逐字节比对。\n";

function fail(message, exitCode = 1) {
  console.error("[CONTRACT-SYNC FAIL] " + message);
  process.exit(exitCode);
}

function usage(exitCode = 0) {
  console.log(USAGE);
  process.exit(exitCode);
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage(argv.length === 0 ? 2 : 0);
  }
  const command = argv[0];
  if (!["sync", "check", "fingerprint"].includes(command)) {
    fail("未知命令：" + command, 2);
  }
  const options = {
    command,
    cloudRoot: null,
    androidRoot: null,
    root: null,
    cloudRef: null,
    useCloudWorktree: false
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = (name) => {
      if (arg.startsWith(name + "=")) return arg.slice(name.length + 1);
      if (arg === name) {
        i += 1;
        if (i >= argv.length || argv[i].startsWith("--")) fail(name + " 缺少值", 2);
        return argv[i];
      }
      return null;
    };
    let value = readValue("--cloud-root");
    if (value !== null) {
      options.cloudRoot = value;
      continue;
    }
    value = readValue("--android-root");
    if (value !== null) {
      options.androidRoot = value;
      continue;
    }
    value = readValue("--root");
    if (value !== null) {
      options.root = value;
      continue;
    }
    value = readValue("--cloud-ref");
    if (value !== null) {
      options.cloudRef = value;
      continue;
    }
    if (arg === "--use-cloud-worktree") {
      options.useCloudWorktree = true;
      continue;
    }
    fail("未知参数：" + arg, 2);
  }
  return options;
}

function resolveExistingDir(input, label) {
  if (!input) fail("必须提供 " + label, 2);
  const resolved = path.resolve(input);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    fail(label + " 不存在：" + input);
  }
  if (!stat.isDirectory()) fail(label + " 不是目录：" + input);
  return fs.realpathSync(resolved);
}

function sameRealPath(first, second) {
  const left = fs.realpathSync(first);
  const right = fs.realpathSync(second);
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function repoRelativeContractPath(relativeInsideContracts) {
  return "contracts/" + relativeInsideContracts;
}

function assertSafeRelativePath(relativePath) {
  const parts = relativePath.split("/");
  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("contracts/ 中包含不安全或不可移植的相对路径：" + relativePath);
  }
}

function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortPaths(paths) {
  return paths.sort(comparePaths);
}

function sortEntries(entries) {
  return entries.sort((a, b) => comparePaths(a.path, b.path));
}

function pathPortabilityKey(relativePath) {
  return relativePath.normalize("NFKD").toLowerCase();
}

function pathWithParentPrefixes(relativePath) {
  const parts = relativePath.split("/");
  const prefixes = [];
  for (let index = 1; index <= parts.length; index += 1) {
    prefixes.push(parts.slice(0, index).join("/"));
  }
  return prefixes;
}

function collectCasePortableSpellings(paths, label) {
  const spellings = new Map();
  for (const relativePath of paths) {
    for (const candidate of pathWithParentPrefixes(relativePath)) {
      const key = pathPortabilityKey(candidate);
      const before = spellings.get(key);
      if (before && before !== candidate) {
        fail(label + " 中包含仅大小写或 Unicode 规范化不同的不可移植路径：" + before + " 与 " + candidate + "；已 fail-closed");
      }
      spellings.set(key, candidate);
    }
  }
  return spellings;
}

function assertNoCrossCaseAliases(cloud, targetPaths) {
  const cloudSpellings = collectCasePortableSpellings(
    cloud.entries.map((entry) => entry.path),
    "云端 contracts/"
  );
  const targetSpellings = collectCasePortableSpellings(targetPaths, "Android contracts/");
  for (const [key, cloudSpelling] of cloudSpellings) {
    const targetSpelling = targetSpellings.get(key);
    if (targetSpelling && targetSpelling !== cloudSpelling) {
      fail(
        "检测到大小写不敏感 alias 风险：云端 contracts/" + cloudSpelling +
          " 与 Android contracts/" + targetSpelling + " 仅大小写或 Unicode 规范化不同；已 fail-closed，未执行写入/删除"
      );
    }
  }
}

function assertNoFileDirectoryConflicts(cloud, androidRoot) {
  const contractsRoot = path.join(androidRoot, "contracts");
  for (const entry of cloud.entries) {
    const parts = entry.path.split("/");
    let parentRelative = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      parentRelative = parentRelative ? parentRelative + "/" + parts[index] : parts[index];
      const parentStat = lstatIfExists(path.join(contractsRoot, parentRelative));
      if (parentStat && !parentStat.isDirectory()) {
        fail(
          "检测到 file↔directory 风险：云端 contracts/" + entry.path +
            " 需要目录 contracts/" + parentRelative + "，但 Android 同路径不是目录；已 fail-closed"
        );
      }
    }
    const destinationStat = lstatIfExists(path.join(contractsRoot, entry.path));
    if (destinationStat && !destinationStat.isFile()) {
      fail(
        "检测到 file↔directory 风险：云端文件 contracts/" + entry.path +
          " 在 Android 同路径不是普通文件；已 fail-closed"
      );
    }
  }
}

function finalizeEntries(entries) {
  collectCasePortableSpellings(entries.map((entry) => entry.path), "contracts/");
  const sorted = sortEntries(entries);
  const seen = new Set();
  for (const entry of sorted) {
    if (seen.has(entry.path)) fail("contracts/ 中出现重复路径：" + entry.path);
    seen.add(entry.path);
  }
  const manifest = sorted
    .map((entry) => entry.sha256 + "  " + repoRelativeContractPath(entry.path))
    .join("\n") + "\n";
  return {
    entries: sorted,
    treeSha256: sha256(Buffer.from(manifest, "utf8")),
    manifest
  };
}

function listContractFiles(root) {
  const contractsRoot = path.join(root, "contracts");
  let stat;
  try {
    stat = fs.lstatSync(contractsRoot);
  } catch {
    fail("缺少 contracts/ 目录");
  }
  if (!stat.isDirectory()) fail("contracts 必须是目录，不能是符号链接或普通文件");
  const files = [];
  const walk = (directory) => {
    const children = fs.readdirSync(directory, { withFileTypes: true });
    for (const child of children) {
      const fullPath = path.join(directory, child.name);
      if (child.isDirectory()) {
        walk(fullPath);
      } else if (child.isFile()) {
        const relative = path.relative(contractsRoot, fullPath).split(path.sep).join("/");
        assertSafeRelativePath(relative);
        files.push(relative);
      } else {
        const displayPath = path.relative(contractsRoot, fullPath).split(path.sep).join("/");
        fail("contracts/ 只允许普通文件和目录；发现符号链接或特殊文件：contracts/" + displayPath);
      }
    }
  };
  walk(contractsRoot);
  return sortPaths(files);
}

function fingerprintDirectory(root) {
  const contractsRoot = path.join(root, "contracts");
  const entries = listContractFiles(root).map((relative) => {
    const content = fs.readFileSync(path.join(contractsRoot, relative));
    return { path: relative, sha256: sha256(content), content };
  });
  if (entries.length === 0) fail("contracts/ 目录为空");
  return finalizeEntries(entries);
}

function runGit(cloudRoot, args) {
  const result = spawnSync("git", args, {
    cwd: cloudRoot,
    encoding: "buffer",
    maxBuffer: MAX_GIT_BUFFER
  });
  if (result.error) fail("无法执行 git：" + result.error.message);
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "";
    fail("git " + args[0] + " 失败" + (stderr ? "：" + stderr : ""));
  }
  return result.stdout;
}

function probeGit(cloudRoot, args) {
  const result = spawnSync("git", args, {
    cwd: cloudRoot,
    encoding: "utf8",
    maxBuffer: MAX_GIT_BUFFER
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout).trim();
}

function assertNotSparseCloudCheckout(cloudRoot) {
  const insideWorkTree = probeGit(cloudRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree !== "true") return;
  const sparse = probeGit(cloudRoot, ["config", "--bool", "core.sparseCheckout"]);
  if (sparse === "true") {
    fail("--cloud-root 是 sparse checkout；为避免把缺失文件误当权威删除，已 fail-closed。请使用完整 checkout/完整导出或 git ref");
  }
}

function readContractsFromGitRef(cloudRoot, ref) {
  if (!ref || ref.startsWith("-")) fail("--cloud-ref 不能为空或以短横线开头", 2);
  const commit = runGit(cloudRoot, ["rev-parse", "--verify", ref + "^{commit}"])
    .toString("utf8")
    .trim();
  const rawList = runGit(cloudRoot, ["ls-tree", "-r", "--name-only", "-z", commit, "--", "contracts"]);
  const paths = rawList
    .toString("utf8")
    .split("\0")
    .filter((item) => item.length > 0)
    .filter((item) => item.startsWith("contracts/"));
  if (paths.length === 0) fail("云端引用 " + ref + " (" + commit + ") 中没有 contracts/ 文件");
  const entries = paths.map((repoPath) => {
    const relative = repoPath.slice("contracts/".length);
    assertSafeRelativePath(relative);
    const content = runGit(cloudRoot, ["show", commit + ":" + repoPath]);
    return { path: relative, sha256: sha256(content), content };
  });
  return { ...finalizeEntries(entries), commit, ref };
}

function requireCloudRoot(cloudRoot) {
  const packageJsonPath = path.join(cloudRoot, "package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    fail("--cloud-root 必须是 cloud-in-school 仓库 checkout 或完整导出（缺少可解析 package.json）；为避免错误同步，已停止");
  }
  if (packageJson.name !== CLOUD_REPOSITORY_NAME) {
    fail("--cloud-root 必须是 cloud-in-school 仓库 checkout 或完整导出（package.json name 不匹配）；为避免错误同步，已停止");
  }
  const apiSource = path.join(cloudRoot, "apps", "api", "src");
  let apiStat;
  try {
    apiStat = fs.statSync(apiSource);
  } catch {
    fail("--cloud-root 缺少 apps/api/src；不是可识别的 cloud-in-school 仓库，已停止");
  }
  if (!apiStat.isDirectory()) {
    fail("--cloud-root 的 apps/api/src 不是目录；不是可识别的 cloud-in-school 仓库，已停止");
  }
}

function readCloudContracts(options) {
  const cloudRoot = resolveExistingDir(options.cloudRoot, "--cloud-root");
  requireCloudRoot(cloudRoot);
  assertNotSparseCloudCheckout(cloudRoot);
  if (options.useCloudWorktree) {
    return { ...fingerprintDirectory(cloudRoot), cloudRoot, commit: null, ref: "WORKTREE" };
  }
  const usingDefaultSyncRef = options.command === "sync" && !options.cloudRef;
  const ref = options.cloudRef || (options.command === "sync" ? DEFAULT_CLOUD_REF : null);
  if (ref) {
    if (usingDefaultSyncRef) {
      // 发布的同步路径必须先刷新 remote-tracking ref；否则本机陈旧的 origin/main
      // 会让 sync 在旧快照上“成功”，无法发现云端 main 已经前进。
      runGit(cloudRoot, ["fetch", "origin", ORIGIN_MAIN_FETCH_REFSPEC]);
    }
    return { ...readContractsFromGitRef(cloudRoot, ref), cloudRoot };
  }
  return { ...fingerprintDirectory(cloudRoot), cloudRoot, commit: null, ref: "WORKTREE" };
}

function entriesMap(fingerprint) {
  return new Map(fingerprint.entries.map((entry) => [entry.path, entry]));
}

function compareFingerprints(cloud, android) {
  const cloudEntries = entriesMap(cloud);
  const androidEntries = entriesMap(android);
  const missingInAndroid = [];
  const extraInAndroid = [];
  const different = [];
  for (const [relative, cloudEntry] of cloudEntries) {
    const androidEntry = androidEntries.get(relative);
    if (!androidEntry) {
      missingInAndroid.push(relative);
    } else if (androidEntry.sha256 !== cloudEntry.sha256) {
      different.push({ path: relative, cloud: cloudEntry.sha256, android: androidEntry.sha256 });
    }
  }
  for (const relative of androidEntries.keys()) {
    if (!cloudEntries.has(relative)) extraInAndroid.push(relative);
  }
  return {
    equal: missingInAndroid.length === 0 && extraInAndroid.length === 0 && different.length === 0,
    missingInAndroid: sortPaths(missingInAndroid),
    extraInAndroid: sortPaths(extraInAndroid),
    different: sortEntries(different)
  };
}

function printComparison(comparison) {
  for (const relative of comparison.missingInAndroid) {
    console.error("MISSING_IN_ANDROID contracts/" + relative);
  }
  for (const relative of comparison.extraInAndroid) {
    console.error("EXTRA_IN_ANDROID contracts/" + relative);
  }
  for (const item of comparison.different) {
    console.error("HASH_MISMATCH contracts/" + item.path + " cloud=" + item.cloud + " android=" + item.android);
  }
}

function requireAndroidRoot(androidRoot) {
  if (!fs.existsSync(path.join(androidRoot, "settings.gradle.kts"))) {
    fail("--android-root 必须是 day-in-school 仓库 checkout（缺少 settings.gradle.kts）；为避免误删，已停止");
  }
}

function listContractDirectories(root) {
  const contractsRoot = path.join(root, "contracts");
  const directories = [];
  const walk = (directory) => {
    for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const fullPath = path.join(directory, child.name);
      directories.push(path.relative(contractsRoot, fullPath).split(path.sep).join("/"));
      walk(fullPath);
    }
  };
  walk(contractsRoot);
  return new Set(directories);
}

function removeEmptyDirectories(directory, contractsRoot, preservedDirectories = new Set()) {
  for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
    if (child.isDirectory()) {
      removeEmptyDirectories(path.join(directory, child.name), contractsRoot, preservedDirectories);
    }
  }
  const relative = path.relative(contractsRoot, directory).split(path.sep).join("/");
  if (
    directory !== contractsRoot &&
    fs.readdirSync(directory).length === 0 &&
    !preservedDirectories.has(relative)
  ) {
    fs.rmdirSync(directory);
  }
}

function lstatIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function copyFileThenRename(source, destination, transactionRoot) {
  // 临时文件固定在事务目录中，异常清理或保留 backup 时都不会把半成品留在 contracts/。
  // 事务目录与 contracts/ 同在 Android 仓库根目录下；若部署方把 contracts/ 挂载为独立文件系统，
  // rename 会以 EXDEV 失败并触发回滚，而不会退化为非原子复制。
  const temporary = path.join(transactionRoot, "atomic-rename.tmp");
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, destination);
}

function stageCloudContracts(transactionRoot, cloud) {
  const stagingRoot = path.join(transactionRoot, "staging");
  const stagingContractsRoot = path.join(stagingRoot, "contracts");
  for (const entry of cloud.entries) {
    if (!entry.content) throw new Error("内部错误：缺少 contracts/" + entry.path + " 的云端内容");
    const destination = path.join(stagingContractsRoot, entry.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, entry.content);
  }
  const staged = fingerprintDirectory(stagingRoot);
  const comparison = compareFingerprints(cloud, staged);
  if (!comparison.equal) {
    printComparison(comparison);
    throw new Error("staging 与云端 contracts/ 不一致；未触碰 Android contracts/");
  }
  return staged;
}

function backupTargetFile(androidRoot, transactionRoot, relative) {
  const source = path.join(androidRoot, "contracts", relative);
  const backup = path.join(transactionRoot, "backup", "contracts", relative);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(source, backup);
}

function restoreBackupFile(androidRoot, transactionRoot, relative) {
  const backup = path.join(transactionRoot, "backup", "contracts", relative);
  const destination = path.join(androidRoot, "contracts", relative);
  if (!lstatIfExists(backup)) throw new Error("缺少回滚备份 contracts/" + relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  copyFileThenRename(backup, destination, transactionRoot);
}

function removeCreatedFile(androidRoot, relative) {
  const destination = path.join(androidRoot, "contracts", relative);
  const stat = lstatIfExists(destination);
  if (!stat) return;
  if (!stat.isFile()) throw new Error("回滚新增文件时遇到非普通文件 contracts/" + relative);
  fs.unlinkSync(destination);
}

function rollbackSyncOperations(androidRoot, transactionRoot, operations, preexistingDirectories) {
  const errors = [];
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index];
    try {
      if (operation.type === "write" && !operation.hadBefore) {
        removeCreatedFile(androidRoot, operation.relative);
      } else {
        restoreBackupFile(androidRoot, transactionRoot, operation.relative);
      }
    } catch (error) {
      errors.push("contracts/" + operation.relative + ": " + error.message);
    }
  }
  try {
    removeEmptyDirectories(
      path.join(androidRoot, "contracts"),
      path.join(androidRoot, "contracts"),
      preexistingDirectories
    );
  } catch (error) {
    errors.push("清理空目录: " + error.message);
  }
  if (errors.length > 0) throw new Error(errors.join("；"));
}

function writeTransactionManifest(transactionRoot, cloud, target, writeEntries, deleteEntries) {
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    cloudRef: cloud.ref,
    cloudCommit: cloud.commit,
    beforeTreeSha256: target.treeSha256,
    expectedTreeSha256: cloud.treeSha256,
    writes: writeEntries.map((item) => ({ path: item.relative, hadBefore: item.hadBefore })),
    deletes: deleteEntries.map((entry) => ({ path: entry.path }))
  };
  fs.writeFileSync(path.join(transactionRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function cleanupTransactionRoot(transactionRoot) {
  try {
    fs.rmSync(transactionRoot, { recursive: true, force: true });
    return null;
  } catch (error) {
    return error;
  }
}

function warnCleanupFailure(error) {
  console.error("[CONTRACT-SYNC WARN] 事务临时目录清理失败：" + error.message);
}

function writeContractsToAndroid(cloud, androidRoot) {
  requireAndroidRoot(androidRoot);
  assertNoFileDirectoryConflicts(cloud, androidRoot);
  const target = fingerprintDirectory(androidRoot);
  const preexistingDirectories = listContractDirectories(androidRoot);
  assertNoCrossCaseAliases(cloud, [
    ...target.entries.map((entry) => entry.path),
    ...preexistingDirectories
  ]);
  const targetEntries = entriesMap(target);
  const targetContractsRoot = path.join(androidRoot, "contracts");
  const sourcePaths = new Set(cloud.entries.map((entry) => entry.path));
  const writeEntries = [];
  const deleteEntries = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let deleted = 0;

  for (const entry of cloud.entries) {
    const before = targetEntries.get(entry.path);
    if (!before) {
      created += 1;
      writeEntries.push({ entry, relative: entry.path, hadBefore: false });
    } else if (before.sha256 !== entry.sha256) {
      updated += 1;
      writeEntries.push({ entry, relative: entry.path, hadBefore: true });
    } else {
      unchanged += 1;
    }
  }
  for (const entry of target.entries) {
    if (!sourcePaths.has(entry.path)) {
      deleteEntries.push(entry);
      deleted += 1;
    }
  }

  const transactionRoot = fs.mkdtempSync(path.join(androidRoot, ".contracts-sync-"));
  const operations = [];
  let result = null;
  try {
    const staged = stageCloudContracts(transactionRoot, cloud);
    const backupPaths = new Set();
    for (const item of writeEntries) {
      if (item.hadBefore) backupPaths.add(item.relative);
    }
    for (const entry of deleteEntries) backupPaths.add(entry.path);
    for (const relative of sortPaths([...backupPaths])) {
      backupTargetFile(androidRoot, transactionRoot, relative);
    }
    writeTransactionManifest(transactionRoot, cloud, target, writeEntries, deleteEntries);

    for (const item of writeEntries) {
      const stagedSource = path.join(transactionRoot, "staging", "contracts", item.relative);
      const destination = path.join(targetContractsRoot, item.relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      copyFileThenRename(stagedSource, destination, transactionRoot);
      operations.push({ type: "write", relative: item.relative, hadBefore: item.hadBefore });
    }
    for (const entry of deleteEntries) {
      fs.unlinkSync(path.join(targetContractsRoot, entry.path));
      operations.push({ type: "delete", relative: entry.path });
    }
    removeEmptyDirectories(targetContractsRoot, targetContractsRoot);

    const after = fingerprintDirectory(androidRoot);
    const comparisonAfter = compareFingerprints(cloud, after);
    if (!comparisonAfter.equal) {
      printComparison(comparisonAfter);
      throw new Error("sync 后两棵 contracts/ 树仍不一致");
    }
    if (staged.treeSha256 !== after.treeSha256) {
      throw new Error("staging 与最终 contracts/ 树指纹不一致");
    }
    result = { created, updated, unchanged, deleted, after };
  } catch (error) {
    let rollbackError = null;
    try {
      rollbackSyncOperations(androidRoot, transactionRoot, operations, preexistingDirectories);
    } catch (rollbackFailure) {
      rollbackError = rollbackFailure;
    }
    if (rollbackError) {
      console.error(
        "[CONTRACT-SYNC FAIL] 回滚不完整；事务备份保留在 Android 仓库根目录的 " +
          path.basename(transactionRoot) + "：" + rollbackError.message
      );
      fail("sync 失败且回滚不完整：" + error.message);
    }
    const cleanupAfterRollback = cleanupTransactionRoot(transactionRoot);
    if (cleanupAfterRollback) warnCleanupFailure(cleanupAfterRollback);
    fail("sync 失败，已回滚到同步前状态：" + error.message);
  }

  const cleanupError = cleanupTransactionRoot(transactionRoot);
  if (cleanupError) warnCleanupFailure(cleanupError);
  return result;
}

function runCheck(options) {
  const cloud = readCloudContracts(options);
  const androidRoot = resolveExistingDir(options.androidRoot, "--android-root");
  const android = fingerprintDirectory(androidRoot);
  const comparison = compareFingerprints(cloud, android);
  if (!comparison.equal) {
    printComparison(comparison);
    fail(
      "两仓 contracts/ 不一致：缺失 " + comparison.missingInAndroid.length +
        "，多余 " + comparison.extraInAndroid.length +
        "，哈希不同 " + comparison.different.length
    );
  }
  console.log(
    "[CONTRACT-SYNC PASS] " + cloud.entries.length + " 个 contracts 文件逐字节一致；tree_sha256=" + cloud.treeSha256
  );
}

function runSync(options) {
  const cloud = readCloudContracts(options);
  const androidRoot = resolveExistingDir(options.androidRoot, "--android-root");
  if (sameRealPath(cloud.cloudRoot, androidRoot)) {
    fail("--cloud-root 与 --android-root 不能是同一个目录");
  }
  const result = writeContractsToAndroid(cloud, androidRoot);
  const source = cloud.commit ? cloud.ref + "@" + cloud.commit : "云端工作区";
  console.log(
    "[CONTRACT-SYNC PASS] 已从 " + source + " 同步 " + cloud.entries.length + " 个 contracts 文件：新增 " +
      result.created + "，更新 " + result.updated + "，删除 " + result.deleted + "，未变 " + result.unchanged +
      "；tree_sha256=" + result.after.treeSha256
  );
}

function runFingerprint(options) {
  const root = resolveExistingDir(options.root, "--root");
  const fingerprint = fingerprintDirectory(root);
  process.stdout.write(fingerprint.manifest);
  console.log("CONTRACTS_TREE_SHA256=" + fingerprint.treeSha256);
}

const options = parseArgs(process.argv.slice(2));
if (options.command === "check") runCheck(options);
if (options.command === "sync") runSync(options);
if (options.command === "fingerprint") runFingerprint(options);
