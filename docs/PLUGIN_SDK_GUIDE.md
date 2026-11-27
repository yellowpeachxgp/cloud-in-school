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
4. 当前第三方 declarative command 的云端 broker 仍有遗留回显语义；它是兼容行为，不代表插件代码已被执行。
   `open_host_route / open_url / show_data` 的严格声明式命令类型属于 W6-01a，不在本切片宣称完成。
5. 不支持远程 Dex、任意脚本热加载、反射宿主私有实现、共享校园登录凭据或财务密钥。

## 2. 清单字段表（运行时 snake_case）

必填字段：

| 字段 | 类型 | 运行时规则 |
|---|---|---|
| `schema_version` | string | `dis-extension/v2`；兼容别名 `dis-plugin/v2` |
| `plugin_id` | string | 5–120 字符，`a-z0-9` 段以点连接，例如 `org.example.hello-campus` |
| `name` | string | 1–80 字符 |
| `version` | string | `MAJOR.MINOR.PATCH[-prerelease]`；数字段不允许前导零 |
| `min_host_api` / `max_host_api` | integer | 正整数且 `min <= max`；当前 host API 为 2，区间必须包含 2 |
| `permissions` | string array | 只能包含 §5 权限目录中的 ID |
| `allowed_origins` | string array | 只能是无路径 HTTPS origin，例如 `https://plugin.example.com`；不允许 `http:` 或路径 |
| `ui_slots` | object array | 每项必须有 `slot_id / card_id / title / action_command`，可选 `subtitle` |
| `commands` | object array | 每项必须有 `name`，可选 `description / required_permission` |
| `entry_artifacts` | object array | 每项必须有 `path / sha256 / size_bytes` |

可选字段：

| 字段 | 类型 | 运行时规则 |
|---|---|---|
| `legacy_schema_version` | string | v1 适配结果可标记 `dis-campus-plugin/v1` |
| `signature` | object | `algorithm=Ed25519`、`key_id`、`value_base64`。结构校验时可选；签名包安装/验证时必需 |

未知顶层字段、未知嵌套字段会被拒绝。`path` 采用安全方向的过严规则：绝对路径、Windows 盘符、NUL、以及**任何包含 `..` 子串的文件名**都会被拒绝；这意味着 `a..b.js` 目前也会被拒绝。

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

首次安装视为用户显式同意该版本声明的权限。升级新增的权限不会静默授予；回滚会把授权收缩为「已授权 ∩ 目标版本声明」。持久化、逐项撤权、学校作用域、卸载数据清理与故障隔离属于 W6-01a，本文不宣称已完成。

## 5. 权限目录（声明 ≠ 能力已实现）

当前权限 ID 以 `contracts/permissions/permission-catalog.yaml` 为契约目录。插件运行时 Schema 枚举覆盖其中 `scope: plugin`、`scope: host_and_plugin` 与 `scope: host_only_gated` 的条目（后两者的授予仍受宿主门禁约束）；`scope: user_school_scope` 的条目是组队等领域功能的用户态权限，**插件清单声明它们会被运行时以 `runtime_permission_unknown` 拒绝**。声明权限只表示请求能力，是否真正可用取决于宿主 Broker 与对应功能实现。

插件可声明权限（运行时 Schema 枚举集合）：

| 权限 | 当前语义与诚实状态 |
|---|---|
| `network.request` | 只允许访问 `allowed_origins` 中的 HTTPS origin；路径/方法/purpose 细粒度约束仍待 W6-01a 完整落地 |
| `account.session` | 通过 Broker 使用特定学校/平台会话作用域；不暴露原始凭据 |
| `storage.scoped` | **保留/未实现**：当前没有插件分区存储；不要因为目录中存在该 ID 就宣称可用 |
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
| `init` | 生成 `dist/index.mjs`、公钥/私钥和已签名 `manifest.json` |
| `validate` | 只做清单结构与语义校验，不验证签名 |
| `sign` | 重新计算摘要并写入签名 |
| `package` | 当前是 `sign` 的别名；ZIP 打包属于 W6-01b |
| `verify` | 验证签名、摘要和安全路径 |
| `test` | 当前是 `verify` 的别名；离线 simulate 属于 W6-01b |

**密钥卫生警告**：当前 `init` 会把 `plugin-signing-private.key` 写在插件目录中。绝对不要提交、上传或分享该文件；如果只需要公开发布插件，提交的是 `manifest.json`、产物和 `plugin-signing-public.key`。CLI 把私钥迁出插件目录并生成 `.gitignore` 是 W6-01a/AC-24 的明确待办，本指南不把现状描述为安全终态。

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
