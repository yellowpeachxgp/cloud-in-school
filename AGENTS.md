# 代理协作守则（AGENTS.md）

> 本文件是仓库内代理协作的强制入口。根目录 `SYSTEM_CONTRACT.md` 是最高产品契约；本文与总体规划冲突时，依次服从 `SYSTEM_CONTRACT.md`、总体规划 §0.5、总体规划正文。

## 1. 必读材料

- 本仓库根目录 `SYSTEM_CONTRACT.md`。
- 总体规划与任务卡（权威副本在 Android 仓库）：
  - `docs/roadmap/MASTER_PLAN.md`（**§0.5 用户决策优先**）
  - `docs/roadmap/AGENT_TASK_CARDS.md`
- Android 仓库 `task-notes/campus/TASKBOARD.md`、`DECISIONS.md`、`DEVBOX.md`（合入 main 后为进度与决策的唯一来源）。

`cloud-in-school` 不复制路线图；云端代理应阅读 Android 仓库公开副本：`https://github.com/yellowpeachxgp/day-in-school/blob/main/docs/roadmap/MASTER_PLAN.md` 与同目录 `AGENT_TASK_CARDS.md`。

## 2. §0.5 用户决策摘要（D1–D16）

1. **D1 不与学校合作**：只使用公开资料和用户本人账号只读访问；代理产出数据一律 `UNVERIFIED`；校方授权写能力默认关闭且不追求官方授权。
2. **D2 论坛和私信只留接口**：云端保留端点写进 OpenAPI、统一 `501 FEATURE_NOT_ENABLED`；不建表、不写业务逻辑。Android 只定义 `CommunityForumPort` / `DisabledForumPort`，默认关闭，无 UI 入口。
3. **D3 AI 为用户自带 Key（BYOK）**：Key 仅端侧加密保存、按 Profile 隔离；不进备份、日志、诊断；云端不代理、不存储；默认关闭，发送前必须可预览，只允许 HTTPS。
4. **D4 两阶段执行**：先 swe-2.1 完成全部 `[S]` 卡和骨架 UI，再交 neon 做 `[N]`；两个阶段不重叠。
5. **D5 全程在开发机构建和测试**：本机只保留代理会话、源码 worktree 和轻量命令。
6. **D6 与企业项目共用开发机且互不干扰**：校园资源只用 `cis-` 前缀和校园专用目录；不得触碰企业容器、runner、目录；严禁全局 prune。
7. **D7 全程 10 个子代理并发**：槽 1–8 通用，槽 9 集成列车，槽 10 阶段联调验收。
8. **D8 合并方式**：`main` 是唯一集成分支；只用 merge commit；禁止 squash、rebase、force push、改写历史。
9. **D9 交叉审阅**：每个 PR 至少 1 个未参与者审阅；迁移、擦除、凭据/Key、契约、自动化风险、备份格式类 PR 需要 2 个独立审阅者。
10. **D10 推理强度**：封闭清单内的简单任务为 `high`，其余一律 `xhigh`。
11. **D11 CI 边界**：两个公开仓库继续用 GitHub 托管 runner；禁止给公开仓库注册开发机自托管 runner。开发机现场门禁是第一道关，托管 CI 是合并记录。
12. **D12 发布边界**：不推 `v*` 标签、不建 Release、不部署生产、不碰正式签名密钥。
13. **D13 GitHub 公开操作需用户确认**：issue 回复、关闭、加标签先写 `task-notes/campus/issue-replies.md` 草稿，用户确认后由主代理执行；正常创建 PR 不在此列。
14. **D14 编号统一分配**：Room 版本号和云端 SQL 迁移编号由主代理分配；带迁移 PR 按编号顺序合入。
15. **D15 契约权威**：`cloud-in-school/contracts/` 是唯一权威，Android `contracts/` 是同步副本；契约同一时间只由契约线（INF-02、CT 系列）修改。
16. **D16 开发机与秘密不入库**：仓库、脚本、PR、Issue、任务板、日志和汇总只写 `<devbox>` 或 `$CIS_DEVBOX`；任何真实地址、账号、密码、Token、Key 都不得写入。

## 3. 工作方式（§12 摘要）

- 一张卡一个分支，从最新 `origin/main` 拉出；不做分支叠分支。分支命名通常为 `feat/cis-<卡号>-<简称>` 或 `chore/cis-<卡号>-<简称>`。
- 本机 worktree 路径：`/Volumes/SN 770/Developer/campus-worktrees/<仓库>/<分支>`；每个子代理独占目录和分支。
- 本机禁止：`./gradlew`（任何任务）、Android Studio、Kotlin/Java 语言服务器、模拟器、`npm install`、`npm test`、`node --test`、Docker、全仓索引。
- 构建、测试、Lint、截图、模拟器和容器只在 `<devbox>` 上执行。禁止 ssh 内联 heredoc 写文件；文件在本机 worktree 编辑后通过 git 传输。
- 每完成一个可验证的小步就提交并推送。提交信息使用中文，正文包含：卡号 / 能力编号 / 改动 / 原因 / 实际验证 / 风险与恢复。
- PR 前必须通过相应现场门禁；PR 正文列出卡号、计划小节、能力编号、提交清单、实际门禁命令和结果。
- 只由主代理或集成列车按 merge 方式合入；子代理不自行合并 PR。
- `task-notes/campus/TASKBOARD.md` 是进度唯一来源；`DECISIONS.md` 记录 D1–D16 和后续自主决策。自主决策顺序：计划推荐默认 → 与已决事项一致 → 对隐私和数据更保守。

## 4. 开发机门禁清单

门禁形式：`ssh "$CIS_DEVBOX" /srv/xpeach-dev/campus/bin/cis-gate <仓库> <分支> <quick|android|android-full|cloud|contracts|secrets> [参数]`。

| 门禁 | 内容 | 何时必须跑 |
|---|---|---|
| `quick` | 指定模块的 `testDebugUnitTest`（参数传模块名） | 开发中随时 |
| `android` | Android 单测、Lint、Debug 构建及后续架构护栏 | 每个 Android PR 前 |
| `android-full` | `android` + Release Lint/构建 + 全部 Room 迁移链 | 列车、阶段验收、终验 |
| `cloud` | `npm ci && npm test && npm run contract:check`，需要数据库时使用 `cis-*` 容器 | 每个云端 PR 前 |
| `contracts` | 两仓 `contracts/` 一致性和两仓 contract-ci | 任何改动契约的 PR |
| `secrets` | 开发机地址、私网/公网 IP 字面量、Token、私钥头、`.env` | 每个 PR |

本仓库的敏感信息扫描可独立运行：`node tools/secret-scan/scan.mjs`（只读扫描，具体规则见 `tools/secret-scan/README.md`）。

## 5. 热点文件归属

同一时间只派给一个子代理；越界先回报主代理。

| 仓库 | 文件 | 规则 |
|---|---|---|
| Android | `core/database/**/CampusRepository.kt` | W0-05 独占直到合入 |
| Android | `core/database/**/HautDatabase.kt`、`core/database/schemas/**` | 按主代理分配的 Room 版本号串行 |
| Android | `settings.gradle.kts` | 新模块注册只追加；冲突保留两边 |
| Android | 所有 `build.gradle.kts`、`gradle/**` | W0-07 合入前由 W0-07 独占；之后只改本模块构建文件 |
| Android | `app/**/MainActivity.kt`、`AppGraph` | 新功能入口和依赖装配按列车顺序串行 |
| Android | `feature/settings/**` | W0-06c 合入前独占 |
| 两仓 | `contracts/**` | 只由契约线（INF-02、CT 系列）修改 |
| 云端 | `apps/api/src/app.mjs`、`router.mjs` | W0-08 合入前独占；之后新增路由只追加到对应领域路由 |
| 云端 | `packages/db/migrations/**` | 按主代理分配的迁移编号串行 |
| 两仓 | `.github/workflows/**` | 只由 INF 系列和 W0-07 修改 |

## 6. 禁止事项

- 禁止把 07:00 写死为预约时间、遗漏 T−5 复检、把通知当保活机制。
- 禁止让新功能仍须修改 MainActivity / Cloud 主路由才能作为第三方插件注册。
- 禁止插件绕过签名、权限 Broker、Account/School Scope 或校方许可；禁止 SSO 密钥进入 App / 学校 Worker。
- 禁止未经验证宣称真实学校兼容、未授权自动代签到、用静态接口冒充完整插件化。
- 禁止将未生成的 OpenAPI 或示例标注为已实现；禁止仅凭 CI 绿灯宣布生产级完成。
- 禁止另造 `DataProvenance` / `VerificationLevel` / `CapabilityState` / `SchoolAccountScope` 等价类型。
- 新表必须注册到擦除链路并有「擦除后为 0」测试；没在真机或真实学校账号验证的，不标 `DEVICE_TESTED` / `SCHOOL_VERIFIED`。
- 云端端点必须先改契约（只有契约线能改 `contracts/`）再实现；用户可见功能必须带骨架 UI 与覆盖完整状态矩阵的 PreviewFixtures。
- 不推 `v*` 标签，不建 GitHub Release，不部署生产，不在 GitHub 回复或关闭 issue（除非用户已按 D13 确认）。
