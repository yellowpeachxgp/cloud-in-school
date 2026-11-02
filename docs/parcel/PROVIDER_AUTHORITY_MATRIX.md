# Parcel Hub 数据源与外部平台授权矩阵（PROVIDER_AUTHORITY_MATRIX）

> **强制契约**：本矩阵由 `SYSTEM_CONTRACT.md` 与 ADR-007 共同约束。任何快递来源 Provider 的运行状态必须由代码中的 `ProviderAuthorityRegistry` 强制校验；未经官方消费者接口正式授权的 Provider 在生产 Release 与 Campus Cloud 服务端一律禁止开启真实远端抓取。

## 1. 权威状态定义（Authority Status）

- `OFFICIAL_AUTHORIZED`：已取得平台正式消费者 API 授权或属于用户本机显式输入，允许在生产环境启用。
- `MOCK_READY`：完整实现领域模型、契约测试与确定性沙盒数据，用于本地演示、CI 与零改宿主插件验证。
- `MANUAL_ONLY`：仅支持用户本人手动输入、系统分享导入或跳转官方 App/网页查看，不执行后台自动采集。
- `RESEARCH_ONLY`：仅限受控开发测试环境验证协议解析，生产构建与国内 Cloud 服务端强制关闭（`enabledByDefault = false, cloudExecutionAllowed = false`）。
- `DISABLED`：全局停用（Kill Switch 激活）。

---

## 2. 平台 Provider 授权矩阵

| Provider ID | 名称 | 身份域 | 生产默认状态 | 是否允许 Cloud 服务端执行 | 必要权限与安全边界 |
|---|---|---|---|---|---|
| `parcel.manual` | 手动录入与分享导入 | 本机当前校园 Profile | `OFFICIAL_AUTHORIZED` | 是（仅用户显式开启云备份时同步脱敏运单） | 无需外部平台账号；支持手动输入运单号、取件码、驿站备注与 JSON 导入 |
| `parcel.notification-parser` | 本机取件通知解析 | 本机当前校园 Profile | `OFFICIAL_AUTHORIZED` | 否（仅本机解析） | 需用户显式开启通知/文本导入；严格过滤登录 OTP 与银行验证码 |
| `parcel.campus-station` | 校园驿站目录与导航联动 | 学校校区 (`schoolId`) | `MOCK_READY` / `OFFICIAL_AUTHORIZED`（静态站点坐标） | 是（只读驿站目录） | 联动 `:core:location` 与 `:feature:map`；实时入库推送需驿站书面合作授权 |
| `parcel.kd100` | 快递100 聚合查询 | 独立 API Key / 用户授权 | `MOCK_READY`（配置正式企业 Key 后可升为 `OFFICIAL_AUTHORIZED`） | 是（需配置受控服务端密钥与配额） | 仅按已验证运单号查询物流轨迹；严禁枚举他人手机号 |
| `parcel.xiaomi.personal-assistant` | 小米智能助理快递源 | 小米账号（**绝不可授权京东/淘宝/拼多多**） | `RESEARCH_ONLY` / `MOCK_READY` | **绝对禁止** | 小米官方 OAuth 仅代表身份登录，不等于授予智能助理私有快递 API 商业许可；Release 默认关闭私有接口远端拉取 |
| `parcel.jd.orders` | 京东订单与物流源 | 京东独立账号 | `MANUAL_ONLY` / `MOCK_READY` | **绝对禁止** | 未取得京东 JOS 消费者个人订单正式 Scope 前，禁止后台隐藏 WebView 抓取 |
| `parcel.taobao.cainiao` | 淘宝/菜鸟裹裹物流源 | 淘宝/菜鸟独立账号 | `MANUAL_ONLY` / `MOCK_READY` | **绝对禁止** | 卖家开放 API 不得替代买家授权；禁止跨域注入或共享 Cookie |
| `parcel.pdd.orders` | 拼多多订单物流源 | 拼多多独立账号 | `MANUAL_ONLY` / `MOCK_READY` | **绝对禁止** | 禁止伪造设备指纹、反风控脚本或后台抓取；支持用户主动导入运单 |
