# 学校图书馆预约与校园服务合规门禁矩阵（SCHOOL_PROVIDER_COMPLIANCE）

> **强制契约**：依据 `SYSTEM_CONTRACT.md`、ADR-001、ADR-004 与 ADR-005，所有学校图书馆预约及校园服务能力必须按学校与操作粒度受 `SchoolCapabilityClaim` 与 `kill_switch` 双重门禁控制。

## 1. 河南工业大学（`schoolId = "haut"`）图书馆座位预约能力矩阵

| 能力标识 (`LibraryCapability`) | 本地模式 (`LOCAL_DEVICE`) 状态 | 云端模式 (`CLOUD_HOSTED`) 状态 | 证据等级与合规约束 |
|---|---|---|---|
| `READ_BOOKING_RULES` | `VERIFIED_READ_ONLY` | `VERIFIED_READ_ONLY` | 依据校方公开规则（`Asia/Shanghai`，当日开放预约窗口 `07:00:00`–`21:30:00`，开馆 `07:30`–`22:00`），版本化缓存 |
| `READ_AREAS` | `VERIFIED_READ_ONLY` | `MOCK_ONLY` | 本机使用用户本人已登录官方会话只读查询区域 |
| `READ_SEATS` | `VERIFIED_READ_ONLY` | `MOCK_ONLY` | 本机受频控只读查询，严禁全馆高频扫描 |
| `READ_MY_BOOKINGS` | `VERIFIED_READ_ONLY` | `MOCK_ONLY`（获书面委托许可前） | 查询本人当前与当日历史预约记录（`/spacelink/api/seatbook/user/my/crrentbooking` & `/bookinglist`） |
| `VERIFY_BOOKING` | `VERIFIED_READ_ONLY` | `MOCK_ONLY` | 提交后必须通过权威只读接口核验 `bookingId`、座位与状态，不得仅凭 HTTP 200 判定成功 |
| `CREATE_BOOKING` | `MOCK_ONLY` / `MANUAL_ONLY`（生产真实自动提交默认关闭） | `MOCK_ONLY` / `DISABLED_BY_SCHOOL`（`kill_switch = true`） | **硬性门禁**：未取得校方书面第三方自动预约与商业服务许可前，真实自动提交保持关闭；提供完整的 `T-30m / T-5m / T` 三阶段 Mock 闭环与到点打开官方选座页面能力 |
| `CANCEL_BOOKING` | `VERIFIED_READ_ONLY`（本人主动触发） | `MOCK_ONLY` | 仅限用户本人主动点击取消；Cloud 不得在扣费失败时自动取消学生已成功的预约 |
| `TEMPORARY_LEAVE` / `SIGN_OUT` | `VERIFIED_READ_ONLY`（本人主动触发） | `NOT_IMPLEMENTED` | 仅限本机用户本人操作 |
| `SIGN_IN` | `DISABLED_BY_SCHOOL`（禁止自动代签） | `DISABLED_BY_SCHOOL`（禁止自动代签） | **一票否决红线**：校方规定本人到馆刷脸签到，严禁本地自动调度或 Cloud Worker 模拟到馆签到或利用签到接口绕过取消限制 |

## 2. 三阶段任意合法目标时刻 `T` 调度合规不变量

1. 用户可在学校当日允许窗口（如 HAUT `07:00:00`–`21:30:00`）内选择任意合法目标时刻 `T`（如 `07:00`、`08:45`、`12:10`、`18:30`）。
2. 系统固定生成三个独立持久化事件：
   - `PRECHECK = T - 30 minutes`：只读检查权限、规则窗口、网络与会话有效性，严禁写操作，检查完毕立即释放资源。
   - `FINAL_CHECK = T - 5 minutes`：只读复核质量门禁，严禁写操作，检查完毕立即释放资源。
   - `FIRE = T`：再次强检窗口、授权、Kill Switch 与已有预约去重后，仅在获准时执行最多一次创建请求并回读确认。
3. 严禁硬编码 `07:00`，严禁省略 `T - 5 minutes` 复检，严禁 30 分钟常驻前台服务保活，严禁在 `RESULT_UNKNOWN` 状态下盲目重发创建请求。

## 3. 预约执行安全回归修复

- 默认 `kill_switch = true`。开启真实写入需持久存储，并由两个不同、当前有权限的已登录操作员分别提交/批准同一份有效期内的学校许可。请求中的第二人姓名/ID 不等于第二次授权。
- `POST /admin/schools/{schoolId}/authorization-approval` 首次提交 `evidence_ref`、未来的 `expires_at`；第二人提交返回的 `authorization_request_id`。批准不会自动关闭 Kill Switch，需单独显式传 `kill_switch: false`。现有仅保存两个字符串的旧许可不再支持真实执行。
- 校方配置、执行意图和准确座位/起止时间目标进入原子快照并 fsync 成功后，才允许一个创建请求。快照不可写或缺少持久路径时真实提交关闭；Mock 仍可使用。
- 创建计划时确定 `MOCK_ONLY` 或 `AUTHORIZED_AUTOMATION`，Mock 任务不会因后来开启校方许可而升级为真实预约。Mock 不解密、预热或读取真实学校凭据。
- 同学校、同用户、含预约与凭据托管范围的有效同意是所有阶段的前置条件。初检和复检必须实际成功；晚创建仅使检查立即到期，不直接标成成功。FIRE 再检查钱包、许可、凭据、原始目标时间及到期时间；提交前再次检查授权。
- `execute-now` 不伪造未来时钟，不提前执行，也不改约到另一日期。合法日期及用户接受的延迟范围按原值执行，不补加 30 分钟宽限。
- 当前预约读取失败、格式不明或结果截断不能证明没有预约。任何已发送创建请求的结果不明确时保留 `RESULT_UNKNOWN`，只回读，不切换座位、重发或重试登录后的写操作。重启中的 `EXECUTING` 同样只回读。
- 成功核验须匹配尝试目标的学校、绑定、座位 ID、预约日、完整起止时间、有效状态，以及已知的校方预约 ID；HTTP 200 本身不构成成功证据。
- 取消只针对明确的校方预约 ID，提交前重新授权，并回读确认其已不存在。拒绝、超时或核验失败不写本地 `CANCELLED`，也不降级成签退。停止计划或撤回同意不等同取消已提交的校方预约；有有效同意的停止计划仍可进行待定结果核验。
- 旧计划没有有效价格快照时必须重新接受价格并创建，不得先预约再发现无法结算。

### 验证与适用边界

`node --import ./tests/helpers/block-network.mjs --test tests/*.test.mjs` 禁止外部 HTTP/TLS/TCP，仅允许测试内本机 Mock Redis。新增 `provider-live-safety.test.mjs` 和 `reservation-safety.test.mjs` 通过注入传输执行真实 provider/engine 分支，未向学校发送任何请求。

这些是隔离回归证据，不是学校兼容性或生产批准证明。当前运行时为单进程内存 Map + 原子文件快照；不得把多个独立进程/副本指向同一快照来获得分布式 CAS。多实例上线前仍需事务数据库、跨进程互斥、真实授权凭证审核及获准的集成验证。SQL 0004 为新增字段的数据库迁移定义，本次未连接或迁移生产数据库。
