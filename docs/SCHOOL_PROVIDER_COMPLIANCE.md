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
