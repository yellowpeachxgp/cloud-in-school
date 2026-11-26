# Campus devbox tools

这些脚本是校园项目在开发机上的公开基础设施源码。脚本只使用 `cis-` 前缀资源和 `<campus-root>/`；**不包含开发机地址、账号、密码、Token 或 Key**。开发机上的脚本从 `<campus-root>/bin` 的自身位置推导 campus root；在本机执行安装或 worktree 助手时必须显式提供环境变量。

## 本机引导

```bash
export CIS_DEVBOX=<devbox>
export CIS_CAMPUS_ROOT=<campus-root>
tools/devbox/cis-install-devbox --provision
```

`cis-install-devbox` 用 `scp` 复制 `cis-*` 到 `$CIS_CAMPUS_ROOT/bin`，不使用 ssh inline heredoc。`--provision` 只做校园范围内的事项：目录树、Gradle 缓存参数、两个公开仓库裸库、campus-local Node.js 22、Android SDK。Android SDK command line tools 从 Google 官方地址下载并做 SHA-256 校验；许可证接受方式与托管 Android CI 相同，已作为 INF-00 自主决策候选留待维护者复核。

## 本机 worktree

```bash
export CIS_DEVBOX=<devbox>
export CIS_CAMPUS_ROOT=<campus-root>
export CIS_LOCAL_WORKTREE_ROOT=<local-campus-worktrees>
tools/devbox/cis-worktree day-in-school feat/example
```

这会从对应 `_seed` 克隆创建独占 worktree，并配置 `devbox` Git remote。地址与远端 campus root 只从环境变量读取。

## 开发循环

```bash
git push devbox feat/example
ssh "$CIS_DEVBOX" "$CIS_CAMPUS_ROOT/bin/cis-gate" day-in-school feat/example android
ssh "$CIS_DEVBOX" "$CIS_CAMPUS_ROOT/bin/cis-gate" cloud-in-school feat/example cloud
```

`cis-gate` 在裸库中把分支解析为确切 SHA，检出到 `build/<仓库>/<分支>`，完整日志写到 `logs/<仓库>/<分支>/<sha>-<门禁>.log`，只回显退出码、SHA、耗时、日志路径、内存摘要和末尾约 60 行。摘要中的峰值内存是门禁期间整机 `MemTotal - min(MemAvailable)`，不是单进程 RSS；systemd scope 可用时还会记录 `CIS_GATE_GRADLE_SCOPE_MEMORY_PEAK_BYTES`（Gradle daemon 跨构建复用时，scope 归属可能混有前序构建）。

## 资源规则

- `cis-gradle` 使用 `locks/gradle.1..4` 四个 `flock` 槽；满员后排队。
- 新构建在 `<campus-root>/PAUSE` 存在时等待；`MemAvailable < 24 GiB` 时等待。
- 优先使用 `systemd-run --user --scope -p MemoryMax=10G`；不可用时退化为 JVM 参数限制并在输出中体现。
- 校园 Gradle cache 是 `<campus-root>/cache/gradle`；其 `gradle.properties` 由 `cis-provision gradle-cache` 生成。
- Android SDK 是 `<campus-root>/android-sdk`，API 36、对应 build-tools 和 platform-tools。
- 只有当前用户在 `kvm` 组时才安装模拟器和系统镜像；否则明确跳过。

## 容器与清理

```bash
cis-containers start cloud-in-school feat/example all
cis-containers status cloud-in-school feat/example all
cis-containers stop cloud-in-school feat/example all
cis-clean --days 7
```

测试容器名精确为 `cis-<仓库>-<分支短名>-<哈希>-<用途>`，只绑定 `127.0.0.1` 随机端口，停止时按确切名字删除；不做全局 prune，不触碰任何非 `cis-` 容器。`cis-clean` 只清理 campus root 内超过 7 天未用的构建 worktree 和日志。

## 门禁

| 门禁 | 当前行为 |
|---|---|
| `quick <模块> [...]` | 指定模块 `testDebugUnitTest` |
| `android` | `testDebugUnitTest :app:lintDebug :app:assembleDebug`；发现 Roborazzi 后追加 `verifyRoborazziDebug`，并动态执行 W0-07 提供的检查入口 |
| `android-full` | `android` 内容加 release lint/assemble；Room 迁移测试由全量单元测试覆盖 |
| `cloud` | `npm ci && npm test && npm run contract:check` |
| `contracts` | 本仓 contract-ci + 与另一仓 `main` 的 `contracts/` 逐文件比对 |
| `secrets` | 调用 INF-01 的 `tools/secret-scan`；未合入时明确返回缺失，不伪造通过 |
