# Parcel Hub 上游源码审计与逐文件迁移溯源（Provenance Ledger）

## 1. 上游固定版本与许可证信息

- **上游项目**：[Halo0sama/ExpressAssistant](https://github.com/Halo0sama/ExpressAssistant)
- **固定 Commit SHA**：`b892565502d381a58a5a2c57e6d9068e07648c7a`
- **对应版本**：`v0.7.2`（2026-10-21T16:56:22Z）
- **许可证**：MIT License（Copyright © 2026 Halo0sama，见 [`licenses/ExpressAssistant-MIT.txt`](../../licenses/ExpressAssistant-MIT.txt)）
- **审计结论**：仅抽取领域规则、状态机、字段归一化、取件码/ETA 纯函数解析与多来源合并策略；**严禁原样嵌入上游单模块 Activity、XML 布局、明文 SharedPreferences 存储、Release WebView 调试或无鉴权 localhost HTTP 服务**。

---

## 2. 逐文件迁移与重构对照表

| 上游文件路径 (`app/src/main/java/com/halo/expressassistant/...`) | 本项目目标模块与路径 | 迁移与重构说明 | 明确剔除的高风险/不合规实现 |
|---|---|---|---|
| `data/Express.kt` | `:core:parcel-model` | 抽取快递状态枚举、轨迹节点、来源观察记录；重构为稳定 `parcelId` UUID + `(carrierCode, normalizedTrackingNumber)` 与多 `sourceObservations` 模型 | 剔除直接以裸 `mailNo` + `source: String` 覆盖全局记录的做法 |
| `data/Store.kt` | `:core:parcel-data` + `:core:parcel-security` | 重构为 Room 多表（`parcels`, `parcel_source_connections`, `parcel_source_observations`, `parcel_tracking_events`, `parcel_pickup_evidence` 等）及 Keystore AES-GCM 密库 | 剔除 `express_store` 明文 `SharedPreferences` 存储账号 Cookie、Token、手机号及 AI Key |
| `ui/SyncEngine.kt` | `:core:parcel-domain` | 重构为纯协程 `ParcelSyncOrchestrator`，支持分批流式提交（`PARTIAL` / `COMPLETED`）、字段级来源置信度合并与人工覆盖保留 | 剔除与 Activity 强耦合的全局静态调用及部分失败清空历史快照的逻辑 |
| `api/XiaomiApi.kt`, `api/XiaomiPassport.kt`, `api/XiaomiSync.kt`, `api/XiaomiDetail.kt` | `:core:parcel-contract` + `parcel.xiaomi.personal-assistant` Provider | 抽象为受 `PROVIDER_AUTHORITY_MATRIX` 门禁控制的 `ParcelDiscoveryProvider` / `ShipmentTrackingProvider`；区分官方 OAuth 身份与非官方智能助理接口 | 剔除内置私有逆向密钥、伪造设备标识及凭未验证手机号抓包；商业 Release 默认关闭非官方远端抓取 |
| `ui/XiaomiLoginActivity.java` | `:feature:parcel-settings` | 重构为 `ParcelAccountStateMachine`（`UNBOUND` → `AUTH_REQUESTED` → `AUTHORIZING` → `VERIFIED` → `ACTIVE` → `REAUTH_REQUIRED` → `REVOKED`） | 剔除 `WebView.setWebContentsDebuggingEnabled(true)`、Logcat 输出 Cookie/登录 URL/手机号及 `removeAllCookies` |
| `ui/JdLoginActivity.kt`, `api/JdListFetcher.kt`, `api/JdTrackFetcher.kt`, `ui/JdOrderResolver.kt` | `parcel.jd.orders` Provider + `:core:parcel-enrichment` | 抽象为独立京东来源 Provider 与商品信息富化器，严格按 `campusProfileId + connectionId` 隔离会话 | 剔除隐藏 WebView 注入脚本绕风控及跨账号 Cookie 混用 |
| `ui/TbLoginActivity.kt`, `api/TbOrders.kt`, `ui/CaiNiaoGoodsResolver.kt` | `parcel.taobao.cainiao` Provider + `:core:parcel-enrichment` | 抽象为独立淘宝/菜鸟来源 Provider，明确区分卖家开放平台与买家个人物流授权边界 | 剔除将商家 API 伪装成消费者授权或跨域携带 Cookie |
| `ui/PddLoginActivity.kt`, `ui/PddWeb.kt`, `ui/PddListFetcher.kt`, `ui/PddCapture.kt`, `ui/PddTraceFetcher.kt` | `parcel.pdd.orders` Provider | 抽象为独立拼多多来源 Provider，默认 `MANUAL_ONLY` / `MOCK_READY` | 剔除仿冒终端指纹、动态签名规避与未授权页面 Hook |
| `ui/GoodsPresentation.kt`, `ui/EtaParser.kt` | `:core:parcel-enrichment` | 迁移纯函数取件码正则/语义提取（排除 OTP/银行验证码）与规则优先的 ETA 解析器（标记 `RULE_BASED` vs `AI_ESTIMATED`） | 剔除无置信度覆盖用户手动修正取件码的行为 |
| `TrackingWorker.kt`, `TrackingNotifier.kt` | `:feature:parcel-notification` | 重构为遵守 Android 后台限制的 `WorkManager` 周期轮询与独立通知渠道（默认锁屏隐藏取件码与商品名） | 剔除后台拉起隐藏 WebView 与承诺严格 15 分钟唤醒的虚假宣传 |
| `DailyReporter.kt`, `ai/AiClient.kt`, `ui/ChatActivity.kt` | `:feature:parcel-ai` | 实现纯规则本地日报生成器（无需 AI 即可运行）与显式逐字段授权的 AI 快递助手，写工具必须二次确认 | 剔除默认静默外发包裹/手机号/地址到第三方 LLM 的行为 |
| `ui/DetailActivity.kt`, `ui/DonePanelActivity.kt`, `ui/ExpressAdapter.kt` | `:feature:parcel-hub` | 采用本项目 Jetpack Compose Bento 设计系统实现待取件卡片、今日按驿站聚合、在途时间线、日历月视图与归档检索 | 剔除上游 XML / View 布局与“云雀 / Lark”品牌元素 |
| `widget/ExpressWidgetProvider.kt` | `:widget:parcel` | 实现原生桌面快递小组件，支持隐私脱敏开关（默认隐藏取件码，点击进入 App 查看）并与现有 4 款小组件共存 | 剔除锁屏/桌面无条件明文展示敏感取件码与完整手机号 |
| `LocalApiServer.kt`, `tools/express-cli.py` | `:core:parcel-automation` | 重构为受 `PluginBroker` 令牌、Scope 与审计约束的本地自动化接口，**默认关闭** | 剔除 `127.0.0.1:8765` 无鉴权明文 HTTP Server |
| `service/ExpressImportService.kt` | `:feature:parcel-import` | 重构为用户提供显式文本/剪贴板/系统分享/JSON 备份与可选通知识别导入 | 剔除默认要求无障碍服务遍历第三方 App 节点或依赖 `Shizuku` |
