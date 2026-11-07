# Day in School & Campus Cloud (v4 Argon) — 全栈交付验收证据总表 (Acceptance Evidence)

## 一、双仓库与生产环境版本对齐表

| 交付资产 | 仓库 / 地址 | 分支 | 验证状态 |
|---|---|---|---|
| **Android 客户端 (`day-in-school`)** | [`https://github.com/yellowpeachxgp/day-in-school`](https://github.com/yellowpeachxgp/day-in-school) | `main` | `./gradlew testDebugUnitTest assembleDebug assembleRelease` **PASS** |
| **国内 Campus Cloud (`cloud-in-school`)** | [`https://github.com/yellowpeachxgp/cloud-in-school`](https://github.com/yellowpeachxgp/cloud-in-school) | `main` | `npm run contract:check && npm test` **19 / 19 PASS** |
| **国内生产服务器 (`103.236.61.117`)** | `/opt/cloud-in-school` (`127.0.0.1:18180–18183`) | `main` | 4 个 systemd 服务 `active`，23 张 PostgreSQL 表就绪 |
| **XPEACH SSO 服务器 (`40.160.138.219`)** | `/root/APPs/xpeach-sso` (`https://sso.xpeach.codes/t/acme`) | 原分支 (零源码修改) | `day-in-school-cloud` OIDC Client 已注册，S256 PKCE 跨服跳转 `303` 实测通过 |

---

## 二、核心契约与业务能力验收矩阵

| 验收维度 | 契约要求 | 实测证据 | 结果 |
|---|---|---|---|
| **OpenAPI 3.1.2 契约一致性** | 66 个接口 100% 双向对齐 `openapi.yaml` 与 `endpoint-inventory.yaml` | `npm run contract:check` & `tests/contract-parity.test.mjs` | **PASS** |
| **ADR-005 校园预约双引擎** | 支持 `[07:00, 21:30)` 内任意自定义时刻 `T`，`T-30m PRECHECK / T-5m FINAL_CHECK / T FIRE`，本机免费 (`LOCAL_DEVICE`) 与云端托管 (`CLOUD_HOSTED`) 双引擎 | `tests/triple-schedule.test.mjs` & `CampusServicesUnitTest.dualEngineReservationPlanner_computesArbitraryTargetTAndThreeAlarms` | **PASS** |
| **Zero-SSO-Change 账务 Saga** | 不改 SSO 源码，仅在学校记录回读核实 (`CONFIRMED`) 后按用户接受的价格快照扣费（默认 `1 🍑 = 10,000 micropeach`），100 并发仅扣 1 次，余额不足转 `PAYMENT_DUE` 不退座 | `tests/finance-saga-concurrency.test.mjs` | **PASS** |
| **Parcel Hub 快递聚合与安全门禁** | 净室重构 `ExpressAssistant`，严密拦截银行/登录 OTP 验证码短信，强制执行 `PROVIDER_AUTHORITY_MATRIX` Fail-Closed 门禁 | `tests/unit.test.mjs` & `CampusServicesUnitTest.parcelHubEngine_blocksOtpSmsAndEnforcesProviderAuthorityMatrix` | **PASS** |
| **零宿主修改插件生态** | CLI `init -> validate -> sign -> verify -> install -> invoke -> upgrade -> rollback -> uninstall`，兼容 `dis-extension/v2` 与 `dis-campus-plugin/v1` | `tests/plugin-zero-host-change.test.mjs` & `PackageManifestCodecTest` | **PASS** |
| **Room v5 -> v6 无损迁移** | 保留全部既有课表、成绩、考试、水电、专注与提醒数据 | `UniversalDatabaseMigrationTest` (`v1 -> v6`) | **PASS** |
| **红队渗透与终极安全审计** | 覆盖 OIDC/PKCE、Token 家族重放、IDOR、SSRF、Zip-Slip、并发扣款、DLP 脱敏与主机最小权限 | `docs/security/SECURITY_AUDIT_AND_REDTEAM_REPORT.md` | **PASS** |
