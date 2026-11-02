# Day in School & Campus Cloud (v4 Argon) — 全项目安全审计与授权红队渗透测试报告

- **审计日期**: 2026-11-02
- **审计范围**:
  1. Android 客户端 (`yellowpeachxgp/day-in-school`, Room v6, Android Keystore AES-256-GCM, WebView Navigation Guard, Parcel Hub OTP Blacklist, Plugin Host v2)
  2. 国内 Campus Cloud 服务端 (`yellowpeachxgp/cloud-in-school`, `103.236.61.117`, `127.0.0.1:18180–18183`, OpenResty, PostgreSQL `cloud_in_school`)
  3. XPEACH SSO 身份与钱包集成边界 (`40.160.138.219`, `https://sso.xpeach.codes/t/acme`, OIDC Confidential BFF + S256 PKCE, Zero-SSO-Change)
  4. 统一扩展插件生态 (`dis-extension/v2`, `dis-plugin/v2`, `dis-campus-plugin/v1`, Ed25519 Signature, Zip-Slip Guard, Sandboxed Command Broker)

---

## 一、八大红队测试域与实测结果

| 编号 | 检测域 | 红队攻击向量与测试方法 | 实测响应 / 防御表现 | 严重度 | 状态 |
|---|---|---|---|---|---|
| **RT-AUTH-01** | OIDC / PKCE / 回调与单次票据 | 1) 发送 `code_challenge_method=plain` 降级请求<br>2) 篡改 OIDC `state` / `nonce`<br>3) 二次重放已消费的 `app_ticket` | 1) 返回 `400 BAD_REQUEST` (`Only S256 PKCE code_challenge_method is permitted`)<br>2) 状态不匹配直接拒绝并记录审计事件<br>3) `app_ticket` 原子单次消费，二次重放立即拒绝 | Critical | **PASS** |
| **RT-AUTH-02** | Refresh Token 家族重放检测 (`AUTH-014`) | 盗用并重放已轮换的旧 `refresh_token` | 立即触发 `family_id` 级联吊销，当前设备家族下所有有效会话全部失效，返回 `401 CLOUD_AUTH_REQUIRED` | Critical | **PASS** |
| **RT-IDOR-01** | 跨租户 / 跨用户越权 (IDOR) | 用户 B 携带合法 Token 访问用户 A 的 `school_account_binding`、`reservation_job`、`parcel_item` 或调用 `/api/v1/admin/*` | 全部被租户与所有者隔离策略拦截，返回 `403 FORBIDDEN` 或 `404 NOT_FOUND`，零跨租户数据泄露 | High | **PASS** |
| **RT-SSRF-01** | SSRF 与非官方域名跳转 | 向学校连接器或插件 Broker 注入 `http://127.0.0.1`、`http://169.254.169.254/latest/meta-data/`、`file:///etc/passwd`、`https://evil-haut.edu.cn.attacker.com` | 全部被 `assertAllowedSchoolUrl` 与 `SafeWebNavigationPolicy` 拦截，抛出 `403 SSRF_TARGET_BLOCKED` | Critical | **PASS** |
| **RT-FIN-01** | 钱包并发扣费与重试幂等 (`PAY-001..020`) | 针对同一已确认预约单并发发起 `100` 次扣款请求；模拟预约确认后余额不足；模拟超额退款与单人自批退款 | 1) `100` 并发下凭确定性幂等键 `dis:reservation:<orderUUID>:debit:v1` 精确只扣款 `1` 次 (`0.10 🍑`)<br>2) 预约确认后余额不足标记为 `PAYMENT_DUE`，绝不取消已成功的图书馆座位<br>3) 单人自批退款与超额退款均被拒绝 (`409 CONFLICT`) | Critical | **PASS** |
| **RT-CRED-01** | 凭据加密、OTP 短信过滤与 DLP 脱敏 | 1) 检查数据库与日志是否出现明文校园密码、`CASTGC`、`JSESSIONID`、`Bearer` Token<br>2) 向 Parcel Hub 注入银行/登录验证码短信 `【工商银行】您的登录验证码为 384920` | 1) 校园凭据经 KMS AES-256-GCM 信封加密存储，仅在持有短期 `CredentialAccessPermit` 时内存解密；日志由 `redactSensitiveFields` 强制脱敏为 `[REDACTED]`<br>2) 验证码短信被 `OTP_BLACKLIST_KEYWORDS` 100% 过滤返回 `null` | High | **PASS** |
| **RT-PLUG-01** | 插件签名绕过、篡改与 Zip-Slip 路径穿越 | 1) 安装包含 `../etc/passwd` 路径条目的插件包<br>2) 修改插件代码但保留原签名<br>3) 调用未在 Manifest 声明的权限或网络域名 | 1) 立即拦截并抛出 `400 PLUGIN_ARCHIVE_UNSAFE_PATH`<br>2) SHA-256 文件摘要与 Ed25519 签名校验失败 (`400 PLUGIN_SIGNATURE_INVALID`)<br>3) Broker 拒绝未声明权限 (`403 PLUGIN_PERMISSION_DENIED`) | High | **PASS** |
| **RT-INFRA-01** | 主机端口暴露、进程权限与 Git 历史扫描 | 1) 扫描 `103.236.61.117` 监听端口与 systemd 进程权限<br>2) 扫描 `/etc/cloud-in-school/cloud.env` 权限<br>3) 扫描双仓库 Git 历史 | 1) `18180–18183` 仅绑定 `127.0.0.1`，全部以无登录权限账号 `discloud:discloud` 运行<br>2) `/etc/cloud-in-school/cloud.env` 权限为 `640 root:discloud`<br>3) `day-in-school` 与 `cloud-in-school` Git 历史零私钥、零明文密码、零 Cookie 泄露 | High | **PASS** |

---

## 二、审计发现与闭环修复记录

1. **发现项 `AUD-01` (Low)**: `apps/console/src/main.mjs` 初版在独立启动时默认监听 `0.0.0.0`。
   - **修复**: 修改为默认监听 `process.env.HOST || "127.0.0.1"` (Commit `e82ad61`)，并在 `103.236.61.117` 上由 `ss -tlnp` 实测确认为 `127.0.0.1:18181`。
2. **发现项 `AUD-02` (Info)**: `103.236.61.117` 上 `18080` 端口已被既有 Mailcow 容器占用。
   - **修复**: 将 Campus Cloud 服务端口段迁移至 `127.0.0.1:18180–18183`，与既有生产服务完全隔离。

---

## 三、最终安全门禁结论

- **未修复的 Critical / High 漏洞数量**: `0`
- **红队自动化回归测试套件 (`tests/security-redteam.test.mjs` + `tests/finance-saga-concurrency.test.mjs`)**: **100% PASS**
- **终极安全门禁结论**: **PASS (准予正式交付)**
