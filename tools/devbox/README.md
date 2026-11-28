# Campus devbox tools

这些脚本是校园项目在开发机上的公开基础设施源码。脚本只使用 `cis-` 前缀资源和 `<campus-root>/`；**不包含开发机地址、账号、密码、Token 或 Key**。开发机上的脚本从 `<campus-root>/bin` 的自身位置推导 campus root；在本机执行安装或 worktree 助手时必须显式提供环境变量。

## 本机引导

```bash
export CIS_DEVBOX=<devbox>
export CIS_CAMPUS_ROOT=<campus-root>
tools/devbox/cis-install-devbox --provision
```

`cis-install-devbox` 校验 `CIS_DEVBOX` 只能是 hostname 或 user@hostname 的安全字符形式、拒绝 root 远程用户；先在开发机创建并 canonicalize `CIS_CAMPUS_ROOT`，要求 canonical path 含 campus 组件。它用 `scp` 把受支持脚本上传到 `bin` 内隐藏的 same-directory staging，远端逐个 `bash -n` 验证，再用 `stat -L` 确认 staging 与 `bin` 同文件系统；先 chmod staging 文件，然后逐文件 atomic `mv` 发布。整个过程不使用 ssh inline heredoc，避免直接覆盖运行中的 live script，也不会出现半写入文件（逐文件原子，不宣称整目录事务）。`--provision` 只做校园范围内的事项：目录树、Gradle 缓存参数、两个公开仓库裸库、campus-local Node.js 22、Android SDK。Android SDK command line tools 从 Google 官方地址下载并做 SHA-256 校验；许可证接受方式与托管 Android CI 相同，已作为 INF-00 自主决策候选留待维护者复核。

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

测试容器名精确为 `cis-<仓库>-<分支短名>-<哈希>-<用途>`，只绑定 `127.0.0.1` 随机端口，停止时按确切名字删除；不做全局 prune，不触碰任何非 `cis-` 容器。PostgreSQL 不再使用 trust；PostgreSQL/Redis 每次新建时使用随机密码，连接参数只写入 campus artifacts 下 mode-0600 的 per-container auth 文件，输出只给该文件相对路径，不打印密码。`cis-clean` 只清理 campus root 内超过 7 天未用的构建 worktree 和日志。

## 门禁

| 门禁 | 当前行为 |
|---|---|
| `quick <模块> [...]` | 自动识别模块类型：纯 Kotlin JVM 模块执行 `<模块>:test`，Android 模块执行 `<模块>:testDebugUnitTest`；重复传入同一模块只保留一次 |
| `android` | 显式枚举所有已注册模块：Android 模块 `<模块>:testDebugUnitTest`，纯 JVM 模块 `<模块>:test`；另执行非限定 `lintDebug`（覆盖 app 与全部 Android 库模块，与托管 CI `gradlew lintDebug lintRelease` 一致）和 `:app:assembleDebug`，发现 Roborazzi 后追加 `verifyRoborazziDebug`，并动态执行 W0-07 提供的检查入口 |
| `android-full` | `android` 内容加非限定 `lintRelease`（覆盖 app 与全部 Android 库模块）与 `:app:assembleRelease`；Room 迁移测试由全量单元测试覆盖 |
| `cloud` | 有 `package-lock.json`/`npm-shrinkwrap.json` 时必须 `npm ci`；无 lockfile 且 `package.json` 所有依赖字段均为空时明确记录并跳过安装；有任何依赖却无 lockfile 时失败并要求补 lockfile。随后 `npm test && npm run contract:check`（AUTO-006 候选） |
| `contracts` | 本仓 contract-ci + 与另一仓 `main` 的 `contracts/` 逐文件比对 |
| `secrets` | 调用 INF-01 的 `tools/secret-scan`；未合入时明确返回缺失，不伪造通过 |

Android 模块类型由 `settings.gradle.kts` 的已注册模块和各模块 `build.gradle.kts` 的插件声明静态识别；无法分类时门禁失败而不是静默漏测。`android`/`android-full` 先用常规构建缓存完成编译、`testClasses`、Android 单测、Lint 和组装，再以 `--no-build-cache` 第二段执行纯 JVM `<模块>:test`，因此日志中的 JVM 测试不是远端缓存回放。该识别不需要业务模块提供 `testDebugUnitTest` 兼容别名；新注册且使用标准 Kotlin JVM 插件声明的模块（包括后续时间线等纯 JVM 内核）会自动纳入。
