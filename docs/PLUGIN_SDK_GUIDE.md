# Day in School Plugin SDK Guide (`dis-extension/v2`)

> 状态：W6-00 运行时规范事实源 + W6-01b 开发者工具事实源。本文只描述**当前两端实际实现**的 snake_case
> `dis-extension/v2` 与 `dis-plugin` CLI 的真实行为，不把尚未完成的契约面或插件能力写成已实现。
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

QUARANTINED
  └─ UNINSTALL ─> UNINSTALLED（其余 lifecycle 一律拒绝；重启恢复时只有 active_version 未过验的安装会进入该状态）
```

首次安装视为用户显式同意该版本声明的权限。升级新增的权限不会静默授予；回滚会把授权收缩为「已授权 ∩ 目标版本声明」。显式版本安装、待审权限确认、逐项撤权、回滚、命令 invoke 和 UI descriptor 输出在读取持久化包前都会重新解析当前信任根、重验签名与全部声明产物摘要；持久化数据只是证据，不是信任输入。重启恢复时未过验的 package 会标为 `COMPROMISED`，正在使用该版本的 installation 会标为 `QUARANTINED`：不可 invoke、不产生 UI descriptor、只能卸载清理，并写入 `PLUGIN_PACKAGE_QUARANTINED` / `PLUGIN_INSTALLATION_QUARANTINED` 审计。为控制重复验签成本，运行时使用内存成功验签缓存；缓存键必须包含有效信任根公钥、host API 以及持久化 manifest、artifact payload 和版本元数据的内容摘要，任何篡改都会使缓存键改变并触发重验。若之后字节恢复为同一签名包且重验通过，package 可脱离 quarantine；历史审计不会删除，restart 时已 QUARANTINED 的 installation 仍需卸载清理而不会自动恢复启用。W6-01a 当前实现还包括：按 `(cloud_user_id, school_id)` 隔离安装、逐项 `REVOKE_PERMISSION`、SQL 0011/快照持久化、卸载清理授权与 scoped storage/cache、连续故障自动停用，以及管理端 kill switch。

## 4.1 发布者信任根与持久化边界

- 云端 Broker 不持有、生成或持久化任何发布者私钥；运行时只验证公钥签名。
- 生产模式只接受宿主配置里的**显式 `publisher/key_id → Ed25519 SPKI base64 公钥` 映射**；`PLUGIN_TRUSTED_PUBLISHER_KEYS` 可写 JSON 对象（例如 `{"dis-official-examples-2026":"MCow..."}`）或逗号/空白分隔的 `publisher=public-key` 条目；只写裸公钥会因缺少 publisher 映射而启动失败。安装请求若携带 `public_key_base64`，它只是一致性证明：必须与宿主信任根（非生产兼容路径则为已钉扎公钥）完全一致，绝不作为信任输入替换信任根；管理员角色与 host-reference 标记也不能绕过该信任根。
- 非生产模式为方便本地开发允许未列入信任根的公钥注册；同一 `plugin_id` 仍会被首次公钥固定，后续替换公钥失败。该宽松行为只在非生产有效，不得作为生产兼容承诺，也不代表 publisher 命名冲突在生产环境可绕过。
- SQL 0011 定义 `plugin_publishers / plugin_versions / plugin_installations / plugin_permission_grants / plugin_storage_entries / plugin_cache_entries / plugin_runtime_states`；当前内存 Snapshot Store 镜像同一模型用于测试与开发部署。

## 5. 权限目录（声明 ≠ 能力已实现）

当前权限 ID 以 `contracts/permissions/permission-catalog.yaml` 为契约目录。插件运行时 Schema 枚举覆盖其中 `scope: plugin`、`scope: host_and_plugin` 与 `scope: host_only_gated` 的条目（后两者的授予仍受宿主门禁约束）；`scope: user_school_scope` 的条目是组队等领域功能的用户态权限，`scope: user_scope` 的条目是账号级跨设备同步等用户自服务权限，**插件清单声明这两类都会被运行时以 `runtime_permission_unknown` 拒绝**。声明权限只表示请求能力，是否真正可用取决于宿主 Broker 与对应功能实现。

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

CT-04 active 权限（地点状态用户态/审核态授权语义；同样**不是插件可声明权限**；place-status 运行时已随 W4-04 active）：

| 权限 | 当前语义与诚实状态 |
|---|---|
| `place.status.read` | CT-04 active 语义：读取同 school 作用域内用户上报地点状态聚合、分歧、来源与可见纠错历史 |
| `place.status.report` | CT-04 active 语义：提交 Campus Graph 地点的直接观察与只追加纠错；不得冒充官方实时状态 |
| `place.status.subscribe` | CT-04 active 语义：创建、读取和取消调用者自己的地点状态站内通知订阅 |
| `place.status.flag` | CT-04 active 语义：举报错误、过期、滥用、垃圾或含 PII 的地点状态报告，等待显式审核 |
| `place.status.moderate` | CT-04 active 语义：持该校显式 `operations_school_scope` 授权的运营主体审核地点状态举报并保留/排除单个报告；全局角色或普通 campus binding 本身不足以读队列或处置，且审核不得改写用户观察或编造 corrected status |

CT-02/CT-03 上述端点在契约中仍为 `planned`；CT-04 端点已随 W4-04 翻转为 `active`。登记授权语义不表示忙闲、投票、账本、值日或报修运行时实现已经 active。这些条目是领域用户态/运营审核态权限，**没有新增任何插件可声明权限**；插件清单声明它们同样会被 `runtime_permission_unknown` 拒绝。

CT-05 contract-first reserved 权限（论坛与私信用户态/运营审核态授权语义；同样**不是插件可声明权限**。这些端点在契约中是 `reserved` 而非 `planned`：语义上只是将来才可能开启的保留位，当前没有任何运行时实现、不建表、不写业务逻辑，全部统一返回 `501 FEATURE_NOT_ENABLED`）：

| 权限 | 当前语义与诚实状态 |
|---|---|
| `ugc.read` | CT-05 reserved 语义：若将来开启，读取同 school 作用域论坛板块、帖子、楼层回复与帖子搜索结果；当前端点统一返回 501 |
| `ugc.write` | CT-05 reserved 语义：若将来开启，创建帖子、删除调用者本人帖子、追加楼层回复；当前端点统一返回 501 |
| `ugc.report` | CT-05 reserved 语义：若将来开启，对帖子、回复或媒体对象提交用户举报；当前端点统一返回 501 |
| `ugc.media.write` | CT-05 reserved 语义：若将来开启，创建并完成媒体上传槽位（服务端剥离 EXIF、转 WebP、随机 ID、私有桶）；当前端点统一返回 501 |
| `ugc.moderate` | CT-05 reserved 语义：若将来开启，审核运营队列并应用带审计证据的保留/隐藏/删除/驳回处置；不得改写用户内容；当前端点统一返回 501 |

CT-05 上述端点在契约中均为 `reserved`；登记授权语义只为冻结将来开启时的授权模型占位，不表示论坛、私信、审核或媒体上传会以任何时间表落地——按 D2 它们是「将来才可能开启的保留位」，开启前还必须完成 G6 合规核查。这些条目是领域用户态/运营审核态权限，**没有新增任何插件可声明权限**；插件清单声明它们同样会被 `runtime_permission_unknown` 拒绝。

CT-06 contract-first planned 权限（内容包目录用户态/运营审核态授权语义；同样**不是插件可声明权限**。这些端点在契约中是 `planned`：方向已冻结但 runtime-inert，W5-02 实现卡必须在同一 PR 注册运行时并翻转 active）：

| 权限 | 当前语义与诚实状态 |
|---|---|
| `content_pack.read` | CT-06 planned 语义：读取同 school catalog 作用域内学校包/数据包元数据、版本、来源、生命周期与 detached signature facts；目录存在不代表学校验证 |
| `content_pack.download` | CT-06 planned 语义：下载未下架版本的精确 artifact bytes；仍需摘要比对、签名验真、Schema/既有学校包验证与限速 |
| `content_pack.submit` | CT-06 planned 语义：提交公开来源 artifact 与显式 provenance 供维护者审核；受理不代表发布、验证或校方认可 |
| `content_pack.review` | CT-06 planned 语义：持该校显式 operations 授权审核提交队列并批准/要求修改/拒绝；artifact bytes 不经读取 API 再暴露；审核 principal 必须不同于提交 principal，自审以 `CONTENT_PACK_SUBMITTER_CANNOT_REVIEW` fail-closed |
| `content_pack.publish` | CT-06 planned 语义：发布已批准且维护者离线签名的不可变版本；签名信任根、摘要、Schema 与版本顺序仍强制复核；publish 是独立运营授权，submit/review 不隐含 publish，部署不得依赖同一 principal 完成 submit+review+publish |
| `content_pack.retire` | CT-06 planned 语义：独立的高危下架授权；只追加 retirement 元数据、拒绝新下载/安装且不删除历史 |

CT-06 上述端点在契约中均为 `planned`；登记授权语义不表示 content-catalog 运行时已经存在。签名数据包可以是插件产物或独立内容包，但携带/安装数据包本身**不授予任何 `content_pack.*` 宿主权限**。这些条目是领域用户态/运营审核态权限，**没有新增任何插件可声明权限**；插件清单声明它们同样会被 `runtime_permission_unknown` 拒绝。

CT-07 contract-first planned 权限（E2EE 跨设备同步账号级用户自服务授权语义；同样**不是插件可声明权限**。这些端点在契约中是 `planned`：方向已冻结但 runtime-inert，W4-11 实现卡必须在同一 PR 注册运行时并翻转 active）：

| 权限 | 当前语义与诚实状态 |
|---|---|
| `sync.device.read` | CT-07 planned 语义：读取本人 active/revoked 同步设备登记的账户安全元数据；不暴露 ciphertext、plaintext、密钥、session token 或硬件标识 |
| `sync.device.register` | CT-07 planned 语义：在显式 E2EE_CLOUD_SYNC 同意后登记新鲜客户端 installation UUID；设备身份不可复用撤销 tombstone，且不是硬件标识 |
| `sync.device.revoke` | CT-07 planned 语义：永久撤销本人同步设备并使内部绑定 session family 失效；不删除已接受 ciphertext history 或版本向量 authorship |
| `sync.blob.read` | CT-07 planned 语义：读取密文块、非秘密加密元数据、版本向量、tombstone 与增量变更元数据；绝不暗示服务端 plaintext/key 能力 |
| `sync.blob.write` | CT-07 planned 语义：从 active 登记设备按严格版本向量 CAS 上传 ciphertext-only 块；禁止 plaintext/hash、keys 或隐藏冲突 sibling |
| `sync.blob.delete` | CT-07 planned 语义：按严格版本向量 CAS tombstone 密文块，避免删除未看见的并发更新 |

CT-07 上述端点在契约中均为 `planned`；登记授权语义不表示 `packages/sync` 运行时已经存在。端到端加密的密钥 provisioning、备份口令与设备间恢复仍属客户端/Vault 边界，云端不得代理或保存。以上条目是账号级用户自服务权限，**没有新增任何插件可声明权限**；插件清单声明它们同样会被 `runtime_permission_unknown` 拒绝。

## 6. CLI（`dis-plugin`）

CLI 以零依赖纯 Node ESM 实现，Node ≥ 22 即可运行，不需要 `npm install` 任何第三方包。所有命令的成功输出是 stdout 的一行 JSON（`--pretty` 可缩进）；失败输出是 stderr 的一行 JSON，含 `code`，以及适用时的 `runtime_validation_code`（见 §9），退出码非 0。

命令矩阵：

| 命令 | 行为 |
|---|---|
| `keygen` | 在密钥环（`$DIS_PLUGIN_HOME/keys`，缺省 `~/.dis-plugin/keys`）生成 Ed25519 发布者密钥对；私钥权限 0600；拒绝静默覆盖，`--force` 才会换钥 |
| `init` | 按模板生成插件工程：`--template card\|service\|datapack\|legacy`（缺省 `legacy`）；使用/创建密钥环密钥，私钥不进入工程目录 |
| `validate` | 清单结构与语义校验（目录或 pack zip），不验证签名 |
| `sign` | 重新计算 `entry_artifacts` 摘要并签名；读取产物前先做安全路径检查 |
| `pack` | 先完整验签验摘要，再产出确定性 ZIP（见 §7）；`package` 是它的别名 |
| `verify` | 验证 Ed25519 签名、产物摘要与 ZIP 结构（目录或 pack zip）；`test` 是它的别名 |
| `simulate` | 离线模拟宿主：输出 6 个槽位的描述符、声明式命令执行结果和 Mock 学校上下文（见 §8） |
| `doctor` | 发布前复合诊断：Schema、语义、host 兼容、产物、签名、密钥卫生、pack 就绪（见 §8） |

密钥解析顺序（`sign/pack/verify/simulate/doctor` 共用）：

1. 显式 `--key` / `--pub` 路径；
2. 密钥环 `<keys>/<plugin-id>.private.key` / `.public.key`；
3. 从已解析到的私钥数学推导公钥；
4. 工程内 legacy `plugin-signing-private.key` / `plugin-signing-public.key`（兼容行为）；
5. pack zip 内嵌的 `plugin-signing-public.key`（仅 zip 输入；自声明性质，信任决定仍属宿主钉扎/信任根）。

**密钥卫生终态（W6-01a/AC-24）**：`init` 一律使用/创建外部密钥环私钥，插件目录只写入 public key 和 `.gitignore`，绝不会新生成 `plugin-signing-private.key`；`--keyring` 仅作为兼容脚本的无操作标志保留。既有旧工程里残留的 legacy 私钥仍可被 `sign/verify` 兼容读取，但 `doctor` 会给出 WARN；绝对不要提交、上传或分享该文件。

### 6.1 三种 init 模板

| 模板 | 槽位 | 命令 | 产物 | 用途 |
|---|---|---|---|---|
| `card` | `home.cards` | `showCardData` | `dist/index.mjs` + `assets/card-data.json` | 首页声明式卡片，内容以签名数据随包发布 |
| `service` | `campus.services` | `openService` | `dist/index.mjs` | 校园服务入口，声明一个 HTTPS `allowed_origins` 占位 |
| `datapack` | `campus.services` | `queryDataset` | `dist/index.mjs` + `assets/dataset.json` | 签名数据包：数据集作为产物被签名与核验 |
| `legacy` | `campus.services` | `ping` | `dist/index.mjs` | W6-00 兼容脚手架（缺省模板），权限含保留项 `storage.scoped` |

三种模板各自的最小脚手架命令：

```bash
dis-plugin init ./my-card --id org.example.my-card --template card --keyring
dis-plugin init ./my-service --id org.example.my-service --template service --keyring
dis-plugin init ./my-datapack --id org.example.my-datapack --template datapack --keyring
```

模板数据全部标注 `SIMULATED_TEMPLATE_DATA`；真实数据包必须按 SYSTEM_CONTRACT 为每条数据给出 `sources` 与核验状态，不得把示例数据当真实学校数据发布。

## 7. pack ZIP 格式（传输格式事实源）

`dis-plugin pack` 产出的 ZIP 是插件的**传输格式**，不是信任决定：宿主是否接受仍取决于签名钉扎与发布者信任根。

1. 条目封闭集：`manifest.json`（磁盘上的原始字节）+ 可选 `plugin-signing-public.key` + 清单声明的全部产物；出现任何其他条目即拒绝。
2. 确定性：条目按路径排序、deflate（不可压缩时回退 store）、DOS 时间戳固定 1980-01-01，同内容两次打包字节完全相同。
3. 解包安全（云端 `readPluginPackageZip` 与 Android 包管线对齐）：拒绝 zip-slip / 绝对路径 / 反斜杠 / NUL / 重复条目（含大小写不敏感）/ 加密条目 / ZIP64 / 多盘；只支持 store 与 deflate；以中央目录为准并校验本地头文件名一致；逐条校验 CRC-32 与解压后长度；上限为 512 条目、单文件 4 MiB、解压总量 16 MiB。**zip bomb 防护是限量解压**：声明值在解压前先做上限预检，解压本身也带着「声明解压长度」的硬输出上限进行，输出字节数边解压边计数、超限立即中止拒绝——即使中央目录谎报小尺寸，攻击者控制的 deflate 流也不会先被完整解压进内存（回归证据：128 MiB 炸弹的解压中止时 RSS 增量只有几 MiB）。store 条目的压缩/解压两个长度字段必须相等，否则在复制前拒绝。
4. `unpackPluginPackage` 额外强制：清单严格解析 + 运行时校验 + 逐产物 SHA-256 比对，任一失败即拒绝整个包。

## 8. simulate 与 doctor

`simulate` 是离线模拟宿主，**不做任何网络访问**：它把通过验签的包注册进内存中的真实运行时 broker，为模拟用户安装，然后输出：

- `slots`：6 个运行时槽位每个槽位解析出的描述符数组（没有贡献就是空数组）；
- `commands`：每条声明式命令的执行记录（`executed / output` 或 `error / error_code`）；
- `installation`：模拟安装状态与授权集合；
- `mock_school_context`：标注 `SIMULATED_HOST_MOCK` 的示例学校上下文，**不是真实学校数据**，默认作为命令 payload 传入（`--payload '<json>'` 可覆盖，`--origin` 可模拟出站 origin 探测）。

清单、签名或摘要任何一项无效都会以非 0 退出并打印错误码；这就是「故意引入错误时退出码非 0」的验收行为。

`doctor` 输出稳定 check id 的逐项诊断：`manifest.parse`、`manifest.schema`、`manifest.semantics`、`host_api.compatibility`、`artifacts.present`、`artifacts.digest`、`signature.structure`、`signature.verify`、`hygiene.private_key`、`hygiene.gitignore`、`pack.readiness`。任一 FAIL 退出码非 0；WARN（例如 legacy 私钥在工程目录内）不影响退出码。

## 9. 错误码速查

云端 `ContractError.detail.runtime_validation_code` 与 Android `PackageException.runtimeValidationCode` 使用同一组运行时分类，便于两端夹具测试比较结论；它们不是 contracts error-catalog 的新契约错误码。

| 分类 | 含义 | 常见触发 |
|---|---|---|
| `runtime_schema_invalid` | 缺必填字段、类型错误、未知字段或一般取值非法 | 手改清单后少写字段、数字写成 `1.0` |
| `runtime_format_unsupported` | `schema_version` 不是 `dis-extension/v2` 或兼容别名 | 照抄了契约面 camelCase 草稿 |
| `runtime_host_api_range_invalid` | `min_host_api > max_host_api` | 手误 |
| `runtime_host_api_out_of_range` | 当前 host API 不在声明区间内 | 区间忘记包含 2 |
| `runtime_permission_unknown` | 权限不在权限目录 | 声明了 `group.*` 用户态权限或拼写错误 |
| `runtime_origin_invalid` | origin 不是无路径 HTTPS origin | `http:` 或带了路径 |
| `runtime_slot_unknown` | 槽位不在六个运行时槽位内 | 用了契约面草稿里的 14 槽位 |
| `runtime_path_unsafe` | Zip-Slip、绝对路径、盘符、NUL 或过严 `..` 规则命中 | 产物路径含 `../` |
| `runtime_digest_invalid` | SHA-256 不是 64 位小写 hex | 手填摘要 |
| `runtime_signature_invalid` | 签名对象结构非法 | 拷贝时破坏了 base64 |

CLI/宿主层错误码：

| 错误码 | 含义 |
|---|---|
| `PLUGIN_SIGNATURE_INVALID` | 验签失败、摘要不匹配、ZIP 结构/CRC/封闭集违规 |
| `PLUGIN_PERMISSION_DENIED` | 命令所需权限未授予、未声明 origin 出站 |
| `BAD_REQUEST` | 命令未声明、回滚无目标、keygen 覆盖未加 `--force` 等 |
| `CLI_ERROR` / `CLI_USAGE` | 参数错误或文件缺失等 CLI 层失败 |

## 10. 从零到上架（zero-to-publish 教程）

> 前置：Node ≥ 22；克隆本仓库即可，CLI 零第三方依赖，不需要 `npm install`。
> 下文 `dis-plugin` 指 `node packages/plugin-sdk/bin/dis-plugin.mjs`（或 `npm exec dis-plugin`）。
> 本教程的每一步都在验收测试 `tests/plugin-developer-tools.test.mjs` 的 AC-43 用例中原样执行。

```bash
# 1. 生成发布者密钥对（私钥留在密钥环，0600，永不进入工程）
dis-plugin keygen --id org.example.tutorial-card

# 2. 用 card 模板脚手架一个插件工程；--keyring 复用第 1 步的密钥
dis-plugin init ./my-campus-card --id org.example.tutorial-card --template card --keyring

# 3. 编辑 manifest.json：改 name/title，按需调整 permissions 与 allowed_origins
#    编辑 assets/card-data.json：换成你的真实声明式数据（标注来源）

# 4. 校验清单结构与语义
dis-plugin validate ./my-campus-card

# 5. 离线模拟宿主：看 6 个槽位描述符和命令执行结果
dis-plugin simulate ./my-campus-card --pretty

# 6. 发布前复合诊断（应全部 PASS；hygiene 警告要读懂）
dis-plugin doctor ./my-campus-card

# 7. 改过后重新计算摘要并签名（密钥环自动解析，无需 --key）
dis-plugin sign ./my-campus-card

# 8. 打包为确定性 ZIP（pack 前会自动再验一遍签名与摘要）
dis-plugin pack ./my-campus-card

# 9. 验证 ZIP（结构、签名、摘要、封闭集）
dis-plugin verify ./my-campus-card/org.example.tutorial-card-1.0.0.zip
```

第 10 步「上架」：把 zip 中的 `manifest.json`、产物与公钥通过宿主公开的安装入口提交（云端 `POST /api/v1/plugins/install`，或 Android 的插件导入入口——后者属于 W6-01a/W6-02 落地范围）。**永远不要通过修改宿主源码来"注册"插件**；非官方示例插件零改宿主完成全流程是 SYSTEM_CONTRACT I.4 的强制验收。

常见排错：任何一步失败都会打印一行 JSON 错误，先查 `runtime_validation_code`（§9）；`doctor` 的 `pack.readiness` 失败时按它列出的前置检查逐项修复。

## 11. 内置示例与加载可观测性

- `examples/hello-campus-plugin`：`campus.services` 卡片 + `greetCampus` 示例命令。
- `examples/parcel-station-plugin`：`parcel.cards` 卡片 + `queryStationHours` 示例命令。
- 两个示例都只提交公钥 `plugin-signing-public.key`；`dist/index.mjs` 文件头明确说明宿主只验证完整性、不执行产物代码。
- `createCampusCloudApp()` 启动时逐个加载示例；失败会写警告日志，并由 `GET /api/v1/features` 的 `reference_plugins` 字段报告 `LOADED/FAILED`、数量、错误码和去标识化错误消息。删除公钥时应看到 `DEGRADED`，不再静默为空。

## 12. 开发者最小流程（速记）

1. `dis-plugin keygen --id org.example.my-campus-plugin`
2. `dis-plugin init ./my-campus-plugin --id org.example.my-campus-plugin --template card --keyring`
3. 修改 `manifest.json` 中的名称、槽位、命令和 `allowed_origins`。
4. `dis-plugin sign ./my-campus-plugin`（密钥环自动解析；不要复制示例公钥冒充自己的发布者身份）
5. `dis-plugin verify ./my-campus-plugin`
6. 通过公开安装 API 或宿主导入入口提交签名清单与产物；不要修改宿主源码来“注册”插件。

如果目标是贡献正式插件，请先阅读 `SYSTEM_CONTRACT.md`：插件不能绕过签名、权限 Broker、Account/School Scope 或学校授权；声明式卡片 + 声明式命令 + 签名数据包是首期唯一扩展形式。
