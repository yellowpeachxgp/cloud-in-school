# Day in School Plugin SDK Guide (`dis-extension/v2`)

> 状态：W6-00 运行时规范事实源。本文只描述**当前两端实际实现**的 snake_case
> `dis-extension/v2`，不把尚未完成的契约面或插件能力写成已实现。
>
> **契约边界（必须读懂）**：CT-01 当前独占两仓 `contracts/**`。因此
> `contracts/schemas/plugin-extension-v2.schema.json`、
> `contracts/compatibility/host-api-matrix.yaml` 和
> `contracts/fixtures/plugins/` 的字面收敛**不在本切片内**，AC-01…AC-03 的契约面验收仍需
> CT-01 合并后的后续微切片。本切片使用且不伪装为契约共享夹具的运行时文件是：
>
> - `packages/plugin-sdk/schema/plugin-extension-v2-runtime.schema.json`（运行时 Schema）
> - `packages/plugin-sdk/runtime/host-api-matrix.json`（运行时 host API 事实源）
> - `packages/plugin-sdk/test-fixtures/runtime-plugin-manifests/`（云端运行时测试夹具）
> - Android `core/school-packages/src/test/resources/runtime-plugin-manifest-fixtures/`（同名运行时测试夹具）

## 1. 支持边界：声明式，不执行插件代码

1. 正式运行时格式是 snake_case `dis-extension/v2`；`dis-plugin/v2` 只作为兼容别名保留。
2. 宿主只解析清单、验证 Ed25519 签名、验证 SHA-256 产物摘要、按权限 Broker 暴露声明式描述符。
3. **宿主不会加载或执行 `entry_artifacts` 中的 JavaScript、Dex、脚本或任意代码。**
   两个内置示例里的 `dist/index.mjs` 只是签名完整性示例字节；文件头也明确标注「不会被执行」。
   示例命令的可调用行为由宿主内置 reference handler 提供，不是从插件产物动态调用。
4. 第三方 declarative command 只允许 `open_host_route / open_url / show_data` 三类声明式语义：分别返回宿主白名单路由、受 `allowed_origins` 约束的 HTTPS 打开意图、或插件签名数据。未知或缺失类型返回 `PLUGIN_COMMAND_UNSUPPORTED`；响应不得回显调用方 payload。宿主内置 reference handler 只服务随宿主发布的示例，不从插件产物加载。
5. 不支持远程 Dex、任意脚本热加载、反射宿主私有实现、共享校园登录凭据或财务密钥。

## 2. 清单字段表（运行时 snake_case）

必填字段：

| 字段 | 类型 | 运行时规则 |
|---|---|---|
| `schema_version` | string | `dis-extension/v2`；兼容别名 `dis-plugin/v2` |
| `plugin_id` | string | 5–120 字符，`a-z0-9` 段以点连接，例如 `org.example.hello-campus` |
| `name` | string | 1–80 字符，且必须包含至少一个非空白字符（纯空白被拒绝；非空白内容前后的空格按原样保留）。空白集与 ECMAScript `\s` 完全一致：U+FEFF 算空白，U+001C–U+001F 不算空白 |
| `version` | string | `MAJOR.MINOR.PATCH[-prerelease]`；数字段不允许前导零 |
| `min_host_api` / `max_host_api` | integer literal | 1–2147483647 的整数且 `min <= max`；当前 host API 为 2，区间必须包含 2。JSON 源文本必须是整数字面量（如 `2`）；`1.0`、`2e0` 这类小数/指数形式即使数值为整数也被拒绝 |
| `permissions` | string array | 只能包含 §5 权限目录中的 ID |
| `allowed_origins` | string array | 只能是无路径 HTTPS origin，例如 `https://plugin.example.com`；不允许 `http:` 或路径 |
| `ui_slots` | object array | 每项必须有 `slot_id / card_id / title / action_command`，可选 `subtitle`；`title` 为 1–60 字符且不能是纯空白（空白集同上，与 ECMAScript `\s` 一致） |
| `commands` | object array | 每项必须有 `name`，可选 `description / required_permission`；第三方声明式命令另可声明 `type`（`open_host_route/open_url/show_data`）及对应 `route/url/artifact_path`。未知 `type` 可解析但调用时 fail-closed 为 `PLUGIN_COMMAND_UNSUPPORTED` |
| `entry_artifacts` | object array | 每项必须有 `path / sha256 / size_bytes`；`size_bytes` 为 0–2147483647 的整数字面量（按现有内存内摘要核验实现选择最严合理上限，超大文件待未来流式契约另行设计） |

可选字段：

| 字段 | 类型 | 运行时规则 |
|---|---|---|
| `legacy_schema_version` | string | 若存在，只能是 `dis-campus-plugin/v1`；其他值、空值或非字符串都会被拒绝。Android 解析后保留该标记 |
| `signature` | object | `algorithm=Ed25519`、`key_id`、`value_base64`。结构校验时可选；签名包安装/验证时必需 |

未知顶层字段、未知嵌套字段会被拒绝。`path` 采用安全方向的过严规则：绝对路径、Windows 盘符、NUL、以及**任何包含 `..` 子串的文件名**都会被拒绝；这意味着 `a..b.js` 目前也会被拒绝。

清单源文本按 Android CanonicalJson 的严格词法边界解析：重复对象键拒绝，任何数字面量超过 64 个字符也拒绝。该严格模式只作用于插件清单入口（含 CLI 与 `loadPluginDirectory`），不改变通用 API JSON 请求体解析。

## 3. 六个运行时 UI 槽位

权威运行时列表来自 `packages/plugin-sdk/runtime/host-api-matrix.json`；Android 使用同名运行时资源并在测试中逐项比对。当前状态必须诚实区分「描述符可解析」与「宿主界面已渲染」：

| 槽位 | 设计含义 / 预定渲染位置 | 当前实现状态 |
|---|---|---|
| `home.cards` | 首页卡片区 | 云端可解析并返回描述符；Android 只有清单解析，尚未接入首页渲染 |
| `campus.services` | 校园服务网格/入口 | 云端可解析；示例 hello-campus 使用；Android 尚未渲染 |
| `library.actions` | 图书馆操作区 | 云端可解析；Android 尚未渲染 |
| `parcel.cards` | 快递卡片区 | 云端可解析；示例 parcel-station 使用；Android 尚未渲染 |
| `parcel.providers` | 快递来源/Provider 区 | 云端可解析；Android 尚未渲染 |
| `settings.entries` | 设置页扩展入口 | 云端可解析；Android 尚未渲染 |

槽位数量上限、尺寸约束和停用/错误占位属于 W6-02；本切片不宣称已完成。

## 4. 生命周期状态机（当前实现）

```text
未安装
  └─ install signed package ─> ENABLED

ENABLED
  ├─ DISABLE ─> DISABLED
  ├─ same-permission upgrade ─> ENABLED(new active_version)
  ├─ upgrade with added permissions ─> PENDING_PERMISSION_REVIEW(old version keeps running)
  ├─ ROLLBACK ─> ENABLED(target version, grants shrink to target declaration)
  └─ UNINSTALL ─> UNINSTALLED

PENDING_PERMISSION_REVIEW
  ├─ ENABLE(显式确认权限差集) ─> ENABLED(pending version)
  ├─ DISABLE ─> DISABLED(保留 pending_version，不确认权限)
  └─ ROLLBACK ─> ENABLED(target version, pending cleared, grants shrink)

DISABLED
  ├─ ENABLE ─> ENABLED；若仍有 pending_version，先回到 PENDING_PERMISSION_REVIEW
  ├─ same-permission reinstall/upgrade ─> DISABLED(不会被静默重新启用)
  └─ UNINSTALL ─> UNINSTALLED
```

首次安装视为用户显式同意该版本声明的权限。升级新增的权限不会静默授予；回滚会把授权收缩为「已授权 ∩ 目标版本声明」。W6-01a 当前实现还包括：按 `(cloud_user_id, school_id)` 隔离安装、逐项 `REVOKE_PERMISSION`、SQL 0011/快照持久化、卸载清理授权与 scoped storage/cache、连续故障自动停用，以及管理端 kill switch。

## 4.1 发布者信任根与持久化边界

- 云端 Broker 不持有、生成或持久化任何发布者私钥；运行时只验证公钥签名。
- 生产模式只接受 `PLUGIN_TRUSTED_PUBLISHER_KEYS`（逗号/空白分隔的 SPKI base64 公钥清单）中的发布者公钥；管理员角色也不能绕过该信任根。随宿主内置的 reference 示例由宿主明确标记为 host reference，不等价于开放第三方信任。
- 非生产模式为方便本地开发允许未列入信任根的公钥注册；同一 `plugin_id` 仍会被首次公钥固定，后续替换公钥失败。该宽松行为只在非生产有效，不得作为生产兼容承诺。
- SQL 0011 定义 `plugin_publishers / plugin_versions / plugin_installations / plugin_permission_grants / plugin_storage_entries / plugin_cache_entries / plugin_runtime_states`；当前内存 Snapshot Store 镜像同一模型用于测试与开发部署。

## 5. 权限目录（声明 ≠ 能力已实现）

当前权限 ID 以 `contracts/permissions/permission-catalog.yaml` 为契约目录。插件运行时 Schema 枚举覆盖其中 `scope: plugin`、`scope: host_and_plugin` 与 `scope: host_only_gated` 的条目（后两者的授予仍受宿主门禁约束）；`scope: user_school_scope` 的条目是组队等领域功能的用户态权限，**插件清单声明它们会被运行时以 `runtime_permission_unknown` 拒绝**。声明权限只表示请求能力，是否真正可用取决于宿主 Broker 与对应功能实现。

插件可声明权限（运行时 Schema 枚举集合）：

| 权限 | 当前语义与诚实状态 |
|---|---|
| `network.request` | 只允许访问 `allowed_origins` 中的 HTTPS origin；路径/方法/purpose 细粒度约束仍待 W6-01a 完整落地 |
| `account.session` | 通过 Broker 使用特定学校/平台会话作用域；不暴露原始凭据 |
| `storage.scoped` | 云端 Broker 已有按安装实例隔离的内部 scoped storage；Android 使用每 Profile 文件分区。该权限仍不是通用宿主 API，跨设备同步与容量配额待后续卡片 |
| `notification.send` | 经宿主通知通道发送清理后的通知；实现接入仍不完整 |
| `location.coarse` | 粗粒度校园位置，用于驿站/楼宇匹配 |
| `library.booking.read` | 读取图书馆区域、座位快照和当前用户预约 |
| `library.booking.create` | host-only gated 写操作；第三方插件不能凭声明绕过学校授权和用户确认 |
| `parcel.read` | 读取当前 campus profile 内 canonical parcel、轨迹、驿站信息 |
| `parcel.ai.invoke` | BYOK/用户单独同意的 AI 调用，默认关闭 |
| `ui.slot.render` | 渲染声明式扩展卡片描述符的基础权限 |
| `parcel.write.import` | 校园驿站类插件提交规范化包裹快照；仍需授权与审计 |

用户-学校作用域（`scope: user_school_scope`，组队契约域；**不是插件可声明权限**，此处仅为完整性登记）：

| 权限 | 当前语义与诚实状态 |
|---|---|
| `group.read` | 读取同一 school_id 作用域内当前用户可见的小组与活跃成员关系 |
| `group.create` | 完成校园绑定后在对应 school_id 作用域创建学习/宿舍/社团/项目小组 |
| `group.join` | 在匹配的 school_id 作用域内接受有效小组邀请或扫码载荷 |
| `group.manage` | 更新或归档小组；要求组内 GROUP_OWNER/GROUP_ADMIN 授权 |
| `group.invite.manage` | 创建或吊销限时、限次小组邀请；要求 GROUP_OWNER/GROUP_ADMIN 授权 |
| `group.member.manage` | 管理成员角色、共享级别、移出或自助退出；school 作用域隔离强制 |
| `group.availability.write` | CT-02 planned 语义：上传、替换或撤销调用者自己的量化忙闲块分享；绝不能写其他成员忙闲 |
| `group.availability.read` | CT-02 planned 语义：进行隐私最小化交集查询并读取成员 AVAILABLE/BUSY/UNKNOWN 状态；查询结果不暴露原始忙闲块 |
| `group.poll.create` | CT-02 planned 语义：同一 school 作用域的活跃成员创建带截止时间的群组时间投票 |
| `group.poll.read` | CT-02 planned 语义：读取投票选项、截止时间、各选项结果、调用者投票和确认状态 |
| `group.poll.vote` | CT-02 planned 语义：在投票 OPEN 期间投出或修改调用者的单选投票 |
| `group.poll.confirm` | CT-02 planned 语义：把投票选项确认为终态群组事项；限投票创建者或同 school 作用域 GROUP_OWNER/GROUP_ADMIN |

CT-03 contract-first planned 权限（同样全部是 `scope: user_school_scope`；此处登记的是 CT-03 契约线授权语义，**不是插件可声明权限**，也不表示账本/值日/报修运行时实现已经 active）：

| 权限 | 当前语义与诚实状态 |
|---|---|
| `group.ledger.read` | CT-03 planned 语义：读取同组同 school 作用域内只追加账本 postings、确定性分摊、成员余额和结算历史 |
| `group.ledger.write` | CT-03 planned 语义：追加费用、退款或更正 postings；不执行支付，也不改写既有 postings |
| `group.settlement.write` | CT-03 planned 语义：授权当事方提出、确认或取消结算记录；确认只记录双方认可，绝不移动资金 |
| `group.duty.read` | CT-03 planned 语义：读取值日轮换计划、生成任务、分配状态和完成确认状态 |
| `group.duty.write` | CT-03 planned 语义：完成分配给调用者的值日任务，并按当事方/组内角色规则请求或处理单任务换班/代班 |
| `group.duty.confirm` | CT-03 planned 语义：确认其他活跃成员的值日任务完成；禁止自我确认 |
| `group.duty.manage` | CT-03 planned 语义：创建和更新值日轮换计划；要求组内 GROUP_OWNER/GROUP_ADMIN 授权 |
| `group.repair.read` | CT-03 planned 语义：读取宿舍报修记录、流转状态和评价状态 |
| `group.repair.write` | CT-03 planned 语义：提交报修记录、编辑仍可编辑的报修元数据并提交一次性评价；不联系外部维修系统 |
| `group.repair.manage` | CT-03 planned 语义：分流、指派、推进、解决、驳回或关闭报修记录；要求组内 GROUP_OWNER/GROUP_ADMIN 授权 |

CT-02/CT-03 上述端点在契约中均为 `planned`；登记授权语义不表示忙闲、投票、账本、值日或报修运行时实现已经 active。这些条目全部是 `scope: user_school_scope` 的用户态权限，**没有新增任何插件可声明权限**；插件清单声明它们同样会被 `runtime_permission_unknown` 拒绝。

## 6. CLI（`dis-plugin`）

```bash
# 1. 生成一个已签名的示例插件目录
npx dis-plugin init ./my-campus-plugin --id org.example.my-campus-plugin

# 2. 校验运行时 Schema、权限、6 个槽位和产物路径
npx dis-plugin validate ./my-campus-plugin

# 3. 重新计算 entry_artifacts 的 SHA-256 并签名
npx dis-plugin sign ./my-campus-plugin

# 4. 验证 Ed25519 签名和产物摘要
npx dis-plugin verify ./my-campus-plugin
```

命令矩阵：

| 命令 | 行为 |
|---|---|
| `init` | 生成 `dist/index.mjs`、公钥、插件目录 `.gitignore` 和已签名 `manifest.json`；私钥写入 `~/.dis-plugin/keys/<plugin-id>/`（或 `DIS_PLUGIN_KEY_HOME`），绝不写入插件目录 |
| `validate` | 只做清单结构与语义校验，不验证签名 |
| `sign` | 重新计算摘要并写入签名 |
| `package` | 当前是 `sign` 的别名；ZIP 打包属于 W6-01b |
| `verify` | 验证签名、摘要和安全路径 |
| `test` | 当前是 `verify` 的别名；离线 simulate 属于 W6-01b |

**密钥卫生规则**：`init` 生成的 `plugin-signing-private.key` 只保存在插件目录外的用户密钥目录；插件目录自带 `.gitignore` 作为第二道防线。绝对不要提交、上传或分享该私钥；公开发布只需要 `manifest.json`、声明的产物和 `plugin-signing-public.key`。`sign` 默认从外部密钥目录读取，也会先拒绝 `../x`、绝对路径、反斜杠或盘符等越界产物路径。

## 7. 内置示例与加载可观测性

- `examples/hello-campus-plugin`：`campus.services` 卡片 + `greetCampus` 示例命令。
- `examples/parcel-station-plugin`：`parcel.cards` 卡片 + `queryStationHours` 示例命令。
- 两个示例都只提交公钥 `plugin-signing-public.key`；`dist/index.mjs` 文件头明确说明宿主只验证完整性、不执行产物代码。
- `createCampusCloudApp()` 启动时逐个加载示例；失败会写警告日志，并由 `GET /api/v1/features` 的 `reference_plugins` 字段报告 `LOADED/FAILED`、数量、错误码和去标识化错误消息。删除公钥时应看到 `DEGRADED`，不再静默为空。

## 8. 运行时验证错误分类

云端 `ContractError.detail.runtime_validation_code` 与 Android `PackageException.runtimeValidationCode` 使用同一组运行时分类，便于两端夹具测试比较结论；它们不是 contracts error-catalog 的新契约错误码。

| 分类 | 含义 |
|---|---|
| `runtime_schema_invalid` | 缺必填字段、类型错误、未知字段或一般取值非法 |
| `runtime_format_unsupported` | `schema_version` 不是 `dis-extension/v2` 或兼容别名 |
| `runtime_host_api_range_invalid` | `min_host_api > max_host_api` |
| `runtime_host_api_out_of_range` | 当前 host API 不在声明区间内 |
| `runtime_permission_unknown` | 权限不在权限目录 |
| `runtime_origin_invalid` | origin 不是无路径 HTTPS origin |
| `runtime_slot_unknown` | 槽位不在六个运行时槽位内 |
| `runtime_path_unsafe` | Zip-Slip、绝对路径、盘符、NUL 或过严 `..` 规则命中 |
| `runtime_digest_invalid` | SHA-256 不是 64 位小写 hex |
| `runtime_signature_invalid` | 签名对象结构非法； cryptographic verification 另有签名验证错误 |

## 9. 开发者最小流程

1. `npx dis-plugin init ./my-campus-plugin --id org.example.my-campus-plugin`
2. 修改 `manifest.json` 中的名称、槽位、命令和 `allowed_origins`。
3. 把私钥移到安全位置或至少确认它不会进入 Git；不要复制示例公钥冒充自己的发布者身份。
4. `npx dis-plugin sign ./my-campus-plugin --key <私钥路径>`
5. `npx dis-plugin verify ./my-campus-plugin --pub <公钥路径>`
6. 通过公开安装 API 或宿主导入入口提交签名清单与产物；不要修改宿主源码来“注册”插件。

如果目标是贡献正式插件，请先阅读 `SYSTEM_CONTRACT.md`：插件不能绕过签名、权限 Broker、Account/School Scope 或学校授权；声明式卡片 + 声明式命令 + 签名数据包是首期唯一扩展形式。
