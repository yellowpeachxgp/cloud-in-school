# Day in School · SYSTEM CONTRACT (强制产品契约)

> 版本：3.0 / 2026-11-02。适用于 Android、Campus Cloud、学校 Provider 和未来全部插件；既有功能亦必须整改。  
> 完整 Master Handoff 的第 27–30 章是解释与实施细则。本文为提交到根目录、持续参与 CI 审查的宪法文件。  
> SSO 源码零修改；学校许可及资金真实使用边界不因插件扩展而豁免。

## I. 最高优先级 MUST

1. 用户预约目标时间 `T` 可自定义，仅在校方规则的时段内生效；T−30 初检、T−5 复检、T 执行是三个独立可恢复持久事件；所有阶段不得绕过学校许可、Android 后台限制和用户授权。
2. 每个已有/新增功能必须对应 Feature ID、契约/Schema、声明式权限、Lifecycle、可注入 Port、实现 Adapter、可发现 Registry、测试和 Developer 文档。
3. 新 Cloud HTTP API 以 OpenAPI 3.1.2+ Contract-First；每个端点必须有请求体/响应体/HTTP 码、错误码、幂等、授权、版本、示例、兼容性说明；事件以版本化 AsyncAPI 契约。
4. 原生客户端及服务端外部插件必须在公开扩展点范围内**零修改宿主源代码/二进制**完成注册、启用、运行、禁用、升级、回滚、卸载；CI 必须执行非官方示例插件签名安装验收。
5. 扩展必须通过签名、完整性、权限 Broker、生命周期与 Account/School Scope，禁止通过私有实现反射或分享系统财务密钥、校园登录凭据获得“插件化”。
6. 保留既有 `dis-campus-plugin/v1` 兼容，引入通用 `dis-extension/v2`；无满足 Android 安全与分发政策的依据时不得用远程 Dex/任意脚本热加载；已发布的声明式 Slot 和命令协议内承诺零改宿主。
7. 全部现有 Gradle/Cloud 模块清点与重构，不符合 Clean Architecture / 模块契约 / 文档完整度一律整改。禁止留下只有 README、无运行中 Schema 的接口。
8. 免费 LOCAL_DEVICE 不绑定 SSO、不上传校园密码、不收 🍑；云端经 Cloud BFF 接既有 SSO，不修改其代码、Schema、发行令牌行为；任何校方真实自动写操作以学校授权为前置门禁。
9. 源码审查、编译、契约测试、SDK 生成 Diff、旧数据无损迁移、插件零改集成、安全越权测试、模拟学校三阶段验证、Android 12–16 设备测试必须有可重放证据。

## II. 禁止事项

- 将 07:00 写死作为预约时间、遗漏 T−5 复检、把通知当成保活机制；
- 新功能仍须改 MainActivity/Cloud 主路由才可作为第三方插件注册；
- 让插件绕过签名/权限/校方许可；SSO 密钥进入 App/学校 Worker；
- 未测试真实自动预约却宣称已兼容校方系统；未授权擅自自动代签到；
- 把静态接口、Enum 或 `dis-campus-plugin/v1` 的既有学校包机制冒充完整的插件化产品；
- 将未生成的 OpenAPI 与示例标注为实际已实现；仅凭 CI 绿灯宣布生产级完成。

## III. 可交付的证明

- 新注册任意 T 的 Mock 任务，产生完整 T−30/T−5/T 状态审计；窗口外明确拒绝；
- 没有学校写授权时只有 Mock/官方手动模式；
- 运行中 HTTP API 与 `contracts/openapi` 操作列表自动双向比对 100%；
- 第三方 `hello-campus` 插件只使用公开 SDK 完成 Card+Command+学校 Mock 数据接入，宿主 Git tree 和构建校验 SHA 不变；
- 旧学校包、HAUT 功能、历史 Room 数据、四小组件全部可恢复和回归；
- 持续测试任意插件失效/跨账号访问/签名替换/升级回滚都 fail-closed，不泄漏学校或 XPEACH 秘密。

## IV. 完整开发文档

参见 `DayInSchool_Cloud_XPEACH_SSO_OneShot_Master_Handoff_Contract_First_Plugin_Dynamic_Scheduling_v3.md`，重点第 27、28、29、30 章；新增用户功能与全系统历史模块同等受约束。


## v4 补充强制契约：Parcel Hub 多平台插件

1. 快递聚合领域必须有稳定的 `ParcelDiscoveryProvider`、`ParcelAccountProvider`、`ShipmentTrackingProvider`、`PickupCodeProvider`、`ParcelEnrichmentProvider`、`ParcelUiContribution` SPI，与独立的 `ParcelSourceConnection`、`SourceObservation`、`Parcel`、`PickupEvidence` 数据模型。
2. 小米、京东、淘宝/菜鸟、拼多多均为独立授权域；不允许声称小米登录可获取其它平台账号授权。账号、会话、手机号与 XPEACH SSO 不可混淆。XPEACH Cloud 不承担第三方平台凭据托管。
3. 新快递 Provider 安装、权限申请、版本升级、回滚、来源声明与 UI Slots 必须通过已发布宿主契约完成。提供公开 OpenAPI/JSON Schema、SDK、Mock Server、示例插件与安装测试。
4. 被验证的正式 API 与研究中的非官方私有协议严格分层，未取得生产授权时必须默认关闭，不允许通过代理池、设备标识仿冒、规避风控、越过 CAPTCHA 进行商业自动化。
5. 平台 Cookie/Token、AI Key、手机号与取件码须独立加密并按 Profile 隔离；Release 禁止 WebView 调试与登录敏感日志；不允许全局清空其它 Provider/学校/SSO 的 Cookie。
6. 上游 Open Source MIT 代码有明确版权和许可保留要求；商用权与第三方物流平台的数据访问许可是两种独立事项。每个 Provider 需生产授权证据、回滚及阻断开关。
7. Parcel Hub 核心功能免费本地优先；AI、云同步及跨设备服务须单独同意。手机号验证只能证明手机号控制权，不能凭此擅自查询任何快递公司的个人包裹。
8. Argon 必须交付全套与 v3 共存的自动化门禁、外部贡献者无需修改宿主的安装演示，以及 `PROVIDER_AUTHORITY_MATRIX`；并区分开发完成与真实运营获批。
