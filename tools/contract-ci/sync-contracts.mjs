#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_CLOUD_REF = "origin/main";
const MAX_GIT_BUFFER = 64 * 1024 * 1024;

const USAGE = "用法：\n" +
  "  node tools/contract-ci/sync-contracts.mjs sync --cloud-root <云端仓库> --android-root <Android仓库> [--cloud-ref origin/main]\n" +
  "  node tools/contract-ci/sync-contracts.mjs sync --cloud-root <云端仓库> --android-root <Android仓库> --use-cloud-worktree\n" +
  "  node tools/contract-ci/sync-contracts.mjs check --cloud-root <云端仓库或导出目录> --android-root <Android仓库> [--cloud-ref <ref>]\n" +
  "  node tools/contract-ci/sync-contracts.mjs fingerprint --root <仓库>\n" +
  "\n" +
  "规则：\n" +
  "  - cloud-in-school/contracts/ 是唯一权威；sync 只从云端复制到 Android，绝不反向复制。\n" +
  "  - sync 默认读取云端 git origin/main；只有显式 --use-cloud-worktree 才读取云端当前工作区。\n" +
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
  return resolved;
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

function finalizeEntries(entries) {
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

function readCloudContracts(options) {
  const cloudRoot = resolveExistingDir(options.cloudRoot, "--cloud-root");
  if (options.useCloudWorktree) {
    return { ...fingerprintDirectory(cloudRoot), cloudRoot, commit: null, ref: "WORKTREE" };
  }
  const ref = options.cloudRef || (options.command === "sync" ? DEFAULT_CLOUD_REF : null);
  if (ref) {
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

function removeEmptyDirectories(directory, contractsRoot) {
  for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
    if (child.isDirectory()) {
      removeEmptyDirectories(path.join(directory, child.name), contractsRoot);
    }
  }
  if (directory !== contractsRoot && fs.readdirSync(directory).length === 0) {
    fs.rmdirSync(directory);
  }
}

function writeContractsToAndroid(cloud, androidRoot) {
  requireAndroidRoot(androidRoot);
  const target = fingerprintDirectory(androidRoot);
  const targetEntries = entriesMap(target);
  const targetContractsRoot = path.join(androidRoot, "contracts");
  const sourcePaths = new Set(cloud.entries.map((entry) => entry.path));
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let deleted = 0;

  for (const entry of cloud.entries) {
    if (!entry.content) fail("内部错误：缺少 contracts/" + entry.path + " 的云端内容");
    const destination = path.join(targetContractsRoot, entry.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const before = targetEntries.get(entry.path);
    if (!before) {
      created += 1;
    } else if (before.sha256 !== entry.sha256) {
      updated += 1;
    } else {
      unchanged += 1;
    }
    if (!before || before.sha256 !== entry.sha256) {
      fs.writeFileSync(destination, entry.content);
    }
  }

  for (const entry of target.entries) {
    if (!sourcePaths.has(entry.path)) {
      fs.unlinkSync(path.join(targetContractsRoot, entry.path));
      deleted += 1;
    }
  }
  removeEmptyDirectories(targetContractsRoot, targetContractsRoot);
  const after = fingerprintDirectory(androidRoot);
  const comparisonAfter = compareFingerprints(cloud, after);
  if (!comparisonAfter.equal) {
    printComparison(comparisonAfter);
    fail("sync 后两棵 contracts/ 树仍不一致；未写入的文件必须手工检查");
  }
  return { created, updated, unchanged, deleted, after };
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
  if (path.resolve(cloud.cloudRoot) === path.resolve(androidRoot)) {
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
