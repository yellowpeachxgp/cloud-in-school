import http from "node:http";

export const CONSOLE_VIEWS = Object.freeze([
  { id: "overview", title: "1. 全局系统与服务健康总览 (System Overview)" },
  { id: "schools", title: "2. 学校接入、能力状态与授权证据 (School Integrations)" },
  { id: "kill-switch", title: "3. 紧急熔断开关与降级策略 (Kill-Switch Control)" },
  { id: "triple-schedule", title: "4. ADR-005 三阶段调度监控 (T-30m / T-5m / T Queue)" },
  { id: "reservation-jobs", title: "5. 预约任务执行与权威回读核验 (Reservation Jobs)" },
  { id: "orders-ledger", title: "6. 订单与 🍑 钱包账务流水 (Orders & Peach Ledger)" },
  { id: "reconciliation", title: "7. 异常订单对账与 PAYMENT_DUE 追缴 (Reconciliation)" },
  { id: "refund-approvals", title: "8. 双人复核退款审批台 (Dual-Person Refund Approvals)" },
  { id: "parcel-governance", title: "9. Parcel Hub 来源授权矩阵治理 (Parcel Provider Matrix)" },
  { id: "plugin-registry", title: "10. 插件签名与权限审计台 (Signed Plugin Registry)" },
  { id: "kms-vault", title: "11. KMS 信封加密与密钥轮换状态 (KMS Envelope Vault)" },
  { id: "audit-trail", title: "12. 全链路安全与红队审计日志 (Immutable Security Audit Trail)" }
]);

export function renderMobileCallbackHtml({ ticket = "", txn = "" } = {}) {
  const safeTicket = String(ticket).replace(/[^a-zA-Z0-9_-]/g, "");
  const safeTxn = String(txn).replace(/[^a-zA-Z0-9_-]/g, "");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>XPEACH SSO 认证完成 — 日在校园</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; box-sizing: border-box; }
    .box { max-width: 440px; width: 100%; background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 28px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.35); }
    .badge { display: inline-block; background: rgba(56, 189, 248, 0.15); color: #38bdf8; padding: 6px 14px; border-radius: 999px; font-size: 13px; font-weight: 600; margin-bottom: 12px; }
    h1 { font-size: 20px; margin: 0 0 10px; color: #f8fafc; }
    p { font-size: 14px; color: #94a3b8; line-height: 1.6; margin: 0 0 18px; }
    code { display: block; background: #0f172a; border: 1px solid #334155; padding: 10px; border-radius: 8px; color: #cbd5e1; font-size: 12px; word-break: break-all; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="box">
    <div class="badge">XPEACH OIDC Verified</div>
    <h1>XPEACH 账号认证已完成</h1>
    <p>正在将一次性安全凭据返回「日在校园」客户端完成绑定，请稍候…</p>
    <code id="callback-meta" data-ticket="${safeTicket}" data-txn="${safeTxn}">txn=${safeTxn}</code>
  </div>
</body>
</html>`;
}

export function renderConsoleHtml() {
  const navItems = CONSOLE_VIEWS.map(
    (v, idx) =>
      `<button class="nav-btn${idx === 0 ? " active" : ""}" data-target="view-${v.id}" onclick="switchTab('view-${v.id}', this)">${v.title}</button>`
  ).join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Day in School (日在校园) — Campus Cloud 运营与用户门户</title>
  <style>
    :root {
      --bg: #0b1120;
      --panel: #111827;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-hover: #0284c7;
      --ok: #22c55e;
      --warn: #f59e0b;
      --err: #ef4444;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); }
    header {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      padding: 16px 24px; background: rgba(17, 24, 39, 0.92); border-bottom: 1px solid var(--border);
      position: sticky; top: 0; z-index: 20; backdrop-filter: blur(10px); gap: 12px;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-logo {
      width: 38px; height: 38px; border-radius: 10px;
      background: linear-gradient(135deg, #38bdf8, #6366f1);
      display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 18px;
    }
    .brand h1 { font-size: 18px; margin: 0; color: var(--text); }
    .brand p { font-size: 12px; margin: 2px 0 0; color: var(--muted); }
    .auth-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 600;
      background: rgba(34, 197, 94, 0.14); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3);
    }
    .btn {
      background: var(--accent); color: #0f172a; border: none; border-radius: 8px;
      padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none;
      display: inline-flex; align-items: center; gap: 6px; transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.9; }
    .btn-outline {
      background: transparent; color: var(--text); border: 1px solid var(--border);
    }
    .btn-danger { background: var(--err); color: #fff; }
    .layout { display: grid; grid-template-columns: 290px 1fr; min-height: calc(100vh - 72px); }
    @media (max-width: 960px) { .layout { grid-template-columns: 1fr; } }
    aside {
      background: var(--panel); border-right: 1px solid var(--border); padding: 16px 12px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .nav-btn {
      text-align: left; background: transparent; color: var(--muted); border: 1px solid transparent;
      padding: 10px 12px; border-radius: 8px; font-size: 13px; cursor: pointer; transition: all 0.15s;
    }
    .nav-btn:hover { background: rgba(255,255,255,0.04); color: var(--text); }
    .nav-btn.active {
      background: rgba(56, 189, 248, 0.12); color: var(--accent);
      border-color: rgba(56, 189, 248, 0.3); font-weight: 600;
    }
    main { padding: 24px; max-width: 1360px; width: 100%; }
    .kpi-row {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 22px;
    }
    .kpi {
      background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px;
    }
    .kpi .label { font-size: 12px; color: var(--muted); }
    .kpi .value { font-size: 24px; font-weight: 700; margin-top: 6px; color: var(--text); }
    .kpi .sub { font-size: 12px; color: var(--accent); margin-top: 4px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 16px; }
    .card {
      background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 18px;
      margin-bottom: 16px;
    }
    .card h2 { font-size: 16px; margin: 0 0 8px; color: var(--accent); }
    .card p { font-size: 13px; color: var(--muted); margin: 0 0 12px; line-height: 1.5; }
    .form-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; align-items: center; }
    input, select {
      background: #0f172a; border: 1px solid var(--border); color: var(--text);
      padding: 8px 12px; border-radius: 8px; font-size: 13px;
    }
    pre {
      background: #0f172a; border: 1px solid var(--border); border-radius: 8px;
      padding: 12px; font-size: 12px; color: #cbd5e1; overflow-x: auto; max-height: 260px; margin: 10px 0 0;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
    th, td { border-bottom: 1px solid var(--border); padding: 8px 10px; text-align: left; }
    th { color: var(--muted); font-weight: 600; }
    .toast {
      display: none; margin-bottom: 16px; padding: 12px 16px; border-radius: 10px;
      background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.4); color: var(--text); font-size: 13px;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-logo">日</div>
      <div>
        <h1>Day in School — Campus Cloud 运营与用户控制台 (v4 Argon)</h1>
        <p>国内业务节点：campus.yellowpeachxgp.com · 统一身份与账本：sso.xpeach.codes</p>
      </div>
    </div>
    <div class="auth-bar">
      <span class="pill" id="health-pill">● 服务在线 (200 OK)</span>
      <span id="user-badge" style="font-size:13px;color:var(--muted);">当前未登录 XPEACH 账号</span>
      <a class="btn" id="sso-login-btn" href="/api/v1/auth/web/start">使用 XPEACH SSO 登录</a>
      <button class="btn btn-outline" id="sso-logout-btn" style="display:none;" onclick="logoutCloud()">退出登录</button>
      <a class="btn btn-outline" href="/api/v1/openapi.json" target="_blank">OpenAPI 3.1 契约</a>
    </div>
  </header>

  <div class="layout">
    <aside>
      <div style="font-size:11px;color:var(--muted);padding:4px 10px 8px;text-transform:uppercase;letter-spacing:0.06em;">
        12 大核心治理与业务视图
      </div>
      ${navItems}
      <button class="nav-btn" onclick="showAllViews(this)">展开全部 12 视图总览</button>
    </aside>

    <main>
      <div id="toast-box" class="toast"></div>

      <div class="kpi-row">
        <div class="kpi">
          <div class="label">系统健康与数据库迁移</div>
          <div class="value" id="kpi-health">ONLINE</div>
          <div class="sub" id="kpi-migrations">KMS & PostgreSQL Schema Ready</div>
        </div>
        <div class="kpi">
          <div class="label">当前绑定 XPEACH 账户</div>
          <div class="value" id="kpi-user">未登录</div>
          <div class="sub" id="kpi-wallet">点击右上角跳转 sso.xpeach.codes 登录</div>
        </div>
        <div class="kpi">
          <div class="label">高校 Provider 与双引擎预约</div>
          <div class="value" id="kpi-school">河工大 (HAUT)</div>
          <div class="sub" id="kpi-pricing">本地免费 / 云端托管成功确认后扣费</div>
        </div>
        <div class="kpi">
          <div class="label">已签名注册插件与快递源</div>
          <div class="value" id="kpi-plugins">2 插件 · 8 快递源</div>
          <div class="sub">Ed25519 强校验 · 小米/京东/菜鸟/拼多多</div>
        </div>
      </div>

      <div id="views-container">
        <section class="card" id="view-overview">
          <h2>1. 全局系统与服务健康总览 (System Overview)</h2>
          <p>Status: Active & Enforced — 实时聚合 API 网关、KMS 信封密库、三阶段调度引擎与 XPEACH 账本桥接状态。</p>
          <div class="form-row">
            <button class="btn" onclick="refreshAllData()">刷新实时运行指标</button>
            <a class="btn btn-outline" href="/healthz" target="_blank">查看 /healthz</a>
            <a class="btn btn-outline" href="/readyz" target="_blank">查看 /readyz</a>
          </div>
          <pre id="overview-json">正在加载系统实时健康数据...</pre>
        </section>

        <section class="card" id="view-schools">
          <h2>2. 学校接入、能力状态与授权证据 (School Integrations)</h2>
          <p>Status: Active & Enforced — 管理已接入高校（河南工业大学 <code>haut</code>）预约窗口规则、账号绑定与加密凭据委托。</p>
          <div class="form-row">
            <input id="bind-student-no" placeholder="输入学号 (如 2023100101)" value="2023100101" />
            <input id="bind-secret" type="password" placeholder="图书馆会话令牌或 CAS 委托凭据" value="haut_session_token_live" />
            <button class="btn" onclick="bindSchoolAccount()">绑定河工大账号并托管加密凭据</button>
          </div>
          <pre id="schools-json">正在加载高校能力矩阵与绑定状态...</pre>
        </section>

        <section class="card" id="view-kill-switch">
          <h2>3. 紧急熔断开关与降级策略 (Kill-Switch Control)</h2>
          <p>Status: Active & Enforced — 当目标高校系统维护或接口异常时，一键触发服务端熔断并安全取消排队任务。</p>
          <div class="form-row">
            <select id="ks-school"><option value="haut">河南工业大学 (haut)</option></select>
            <input id="ks-reason" placeholder="熔断/恢复原因说明" value="例行安全巡检演练" style="min-width:240px;" />
            <button class="btn btn-danger" onclick="toggleKillSwitch(true)">开启紧急熔断 (HALT)</button>
            <button class="btn" onclick="toggleKillSwitch(false)">解除熔断恢复服务</button>
          </div>
          <pre id="killswitch-json">当前熔断状态：正常放行 (kill_switch = false)</pre>
        </section>

        <section class="card" id="view-triple-schedule">
          <h2>4. ADR-005 三阶段调度监控 (T-30m / T-5m / T Queue)</h2>
          <p>Status: Active & Enforced — 支持创建智能定时抢座计划：在目标时刻 T 前 30 分钟预检、T 前 5 分钟终检刷新令牌、T 准点提交抢座。</p>
          <div class="form-row">
            <input id="plan-area" placeholder="场馆/阅览室 (如 东区四楼北自习室)" value="东区四楼北自习室" />
            <input id="plan-seat" placeholder="首选座位号 (如 A036)" value="A036" />
            <input id="plan-date" placeholder="预约日期 (YYYY-MM-DD)" value="2026-11-04" />
            <select id="plan-mode">
              <option value="CLOUD_HOSTED">云端全托管定时抢座 (T-30m/T-5m/T)</option>
              <option value="LOCAL_DEVICE">本机免费定时抢座</option>
            </select>
            <button class="btn" onclick="createReservationPlan()">创建定时抢座计划</button>
          </div>
          <pre id="plans-json">登录后可查看并管理您的智能定时抢座计划...</pre>
        </section>

        <section class="card" id="view-reservation-jobs">
          <h2>5. 预约任务执行与权威回读核验 (Reservation Jobs)</h2>
          <p>Status: Active & Enforced — 展示每一次 T-30m / T-5m / T 调度事件、权威回读核验凭证 (Evidence) 与任务取消操作。</p>
          <div class="form-row">
            <button class="btn btn-outline" onclick="loadAuthenticatedData()">刷新任务队列与核验凭证</button>
          </div>
          <pre id="jobs-json">登录后显示预约任务执行状态与学校侧权威回读证据...</pre>
        </section>

        <section class="card" id="view-orders-ledger">
          <h2>6. 订单与 🍑 钱包账务流水 (Orders & Peach Ledger)</h2>
          <p>Status: Active & Enforced — 严格遵循 POST_CONFIRMATION_ONLY（仅在学校侧座位权威确认成功后扣减 🍑，失败 0 扣费）。</p>
          <pre id="wallet-orders-json">登录后显示您的 XPEACH 🍑 钱包余额与云端托管预约订单流水...</pre>
        </section>

        <section class="card" id="view-reconciliation">
          <h2>7. 异常订单对账与 PAYMENT_DUE 追缴 (Reconciliation)</h2>
          <p>Status: Active & Enforced — 若座位已锁定成功但用户在其他站点耗尽 🍑 余额，订单记为 PAYMENT_DUE，绝不回滚取消学生已抢到的图书馆座位。</p>
          <pre id="reconciliation-json">对账策略：dis:reservation:&lt;orderUUID&gt;:debit:v1 幂等键保护 · PAYMENT_DUE 非破坏性挂账追缴已启用。</pre>
        </section>

        <section class="card" id="view-refund-approvals">
          <h2>8. 双人复核退款审批台 (Dual-Person Refund Approvals)</h2>
          <p>Status: Active & Enforced — 财务退款强制要求发起人与第二复核人 (second_approver_ref) 分离，防止单点越权退费。</p>
          <div class="form-row">
            <input id="refund-order-id" placeholder="订单 UUID" />
            <input id="refund-amount" type="number" placeholder="退款 micropeach (如 10000)" value="10000" />
            <input id="refund-approver" placeholder="第二审批人 ID (如 auditor_02)" value="auditor_02" />
            <button class="btn btn-outline" onclick="submitRefund()">提交双人复核退款</button>
          </div>
          <pre id="refund-json">等待管理员提交退款审批指令...</pre>
        </section>

        <section class="card" id="view-parcel-governance">
          <h2>9. Parcel Hub 来源授权矩阵治理 (Parcel Provider Matrix)</h2>
          <p>Status: Active & Enforced — 聚合小米智能助理、京东、淘宝/菜鸟、拼多多与短信取件码解析，并强制拦截银行/登录敏感验证码。</p>
          <div class="form-row">
            <input id="parcel-no" placeholder="运单号 (如 SF1588990011)" value="SF1588990011" />
            <input id="parcel-carrier" placeholder="承运商 (如 顺丰速运)" value="顺丰速运" />
            <input id="parcel-sms" placeholder="取件短信内容" value="【菜鸟驿站】请凭取件码 12-3-4056 到莲花街北苑驿站取件" style="min-width:280px;" />
            <button class="btn" onclick="createParcelItem()">解析并归档包裹</button>
          </div>
          <pre id="parcels-json">正在加载 Parcel Hub 8 大来源授权矩阵...</pre>
        </section>

        <section class="card" id="view-plugin-registry">
          <h2>10. 插件签名与权限审计台 (Signed Plugin Registry)</h2>
          <p>Status: Active & Enforced — Ed25519 签名校验、SHA-256 产物哈希锁定与零宿主修改沙箱调用。</p>
          <div class="form-row">
            <select id="plugin-id">
              <option value="example.hello-campus">example.hello-campus (校园问候插件)</option>
              <option value="campus.parcel.station-assistant">campus.parcel.station-assistant (驿站营业助手插件)</option>
            </select>
            <button class="btn" onclick="invokePluginSandbox()">在受限沙箱中执行插件命令</button>
          </div>
          <pre id="plugins-json">正在加载已签名插件注册表...</pre>
        </section>

        <section class="card" id="view-kms-vault">
          <h2>11. KMS 信封加密与密钥轮换状态 (KMS Envelope Vault)</h2>
          <p>Status: Active & Enforced — 所有学校委派凭据与快递平台会话均使用 AES-256-GCM + HKDF 信封加密，绑定 (binding_id|school_id|credential_kind) AAD。</p>
          <pre id="kms-json">KMS Envelope Encryption: AES-256-GCM Active · Fail-Closed Enforced</pre>
        </section>

        <section class="card" id="view-audit-trail">
          <h2>12. 全链路安全与红队审计日志 (Immutable Security Audit Trail)</h2>
          <p>Status: Active & Enforced — 记录每一次身份签发、KMS 加解密、熔断开关、退款复核与权限边界拦截事件。</p>
          <pre id="audit-json">登录后自动拉取最新安全审计流水...</pre>
        </section>
      </div>
    </main>
  </div>

  <script>
    let accessToken = sessionStorage.getItem("dis_cloud_access_token") || "";
    let currentUser = null;
    let firstSchoolBindingId = null;

    function showToast(msg) {
      const el = document.getElementById("toast-box");
      el.textContent = msg;
      el.style.display = "block";
      setTimeout(() => { el.style.display = "none"; }, 6000);
    }

    function switchTab(targetId, btn) {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      if (btn) btn.classList.add("active");
      document.querySelectorAll("#views-container > section").forEach((sec) => {
        sec.style.display = sec.id === targetId ? "block" : "none";
      });
    }

    function showAllViews(btn) {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      if (btn) btn.classList.add("active");
      document.querySelectorAll("#views-container > section").forEach((sec) => {
        sec.style.display = "block";
      });
    }

    async function apiFetch(path, options = {}) {
      const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
      if (accessToken) {
        headers["Authorization"] = "Bearer " + accessToken;
      }
      const res = await fetch(path, Object.assign({}, options, { headers }));
      const data = await res.json().catch(() => ({}));
      return { status: res.status, ok: res.ok, body: data };
    }

    async function handleWebTicketIfPresent() {
      const params = new URLSearchParams(window.location.search);
      const webTicket = params.get("web_ticket");
      const txn = params.get("txn");
      if (webTicket && txn) {
        const res = await apiFetch("/api/v1/auth/web/exchange", {
          method: "POST",
          body: JSON.stringify({ login_txn: txn, web_ticket: webTicket })
        });
        if (res.ok && res.body?.data?.access_token) {
          accessToken = res.body.data.access_token;
          sessionStorage.setItem("dis_cloud_access_token", accessToken);
          showToast("✅ XPEACH SSO 登录成功！欢迎回来，" + (res.body.data.display_name || res.body.data.sso_subject));
          window.history.replaceState({}, document.title, window.location.pathname);
        } else {
          showToast("⚠️ SSO 登录凭据交换失败：" + (res.body?.error?.message || res.status));
        }
      }
    }

    async function logoutCloud() {
      if (accessToken) {
        await apiFetch("/api/v1/auth/logout", { method: "POST" });
      }
      accessToken = "";
      currentUser = null;
      sessionStorage.removeItem("dis_cloud_access_token");
      document.getElementById("user-badge").textContent = "当前未登录 XPEACH 账号";
      document.getElementById("sso-login-btn").style.display = "inline-flex";
      document.getElementById("sso-logout-btn").style.display = "none";
      document.getElementById("kpi-user").textContent = "未登录";
      document.getElementById("kpi-wallet").textContent = "点击右上角跳转 sso.xpeach.codes 登录";
      showToast("已安全退出当前云端会话");
    }

    async function loadPublicData() {
      const [health, ready, schools, rules, pricing, providers, plugins] = await Promise.all([
        apiFetch("/healthz"),
        apiFetch("/readyz"),
        apiFetch("/api/v1/schools"),
        apiFetch("/api/v1/schools/haut/booking-rules"),
        apiFetch("/api/v1/pricing/library-booking"),
        apiFetch("/api/v1/parcel-providers"),
        apiFetch("/api/v1/plugins")
      ]);
      document.getElementById("overview-json").textContent = JSON.stringify(
        { health: health.body?.data, ready: ready.body?.data, pricing: pricing.body?.data },
        null,
        2
      );
      document.getElementById("schools-json").textContent = JSON.stringify(
        { schools: schools.body?.data?.schools, haut_booking_rules: rules.body?.data },
        null,
        2
      );
      document.getElementById("parcels-json").textContent = JSON.stringify(
        { provider_authority_matrix: providers.body?.data },
        null,
        2
      );
      document.getElementById("plugins-json").textContent = JSON.stringify(
        plugins.body?.data,
        null,
        2
      );
      document.getElementById("kms-json").textContent = JSON.stringify(
        {
          kms_online: ready.body?.data?.ready,
          migrations_applied: ready.body?.data?.migrations_applied,
          envelope_cipher: "AES-256-GCM + HKDF-SHA256",
          aad_binding: "binding_id|school_id|credential_kind"
        },
        null,
        2
      );
    }

    async function loadAuthenticatedData() {
      if (!accessToken) return;
      const [me, wallet, bindings, plans, jobs, orders, parcels] = await Promise.all([
        apiFetch("/api/v1/me"),
        apiFetch("/api/v1/me/wallet"),
        apiFetch("/api/v1/school-bindings"),
        apiFetch("/api/v1/reservation-plans"),
        apiFetch("/api/v1/reservation-jobs"),
        apiFetch("/api/v1/me/orders"),
        apiFetch("/api/v1/parcels")
      ]);
      if (!me.ok) {
        accessToken = "";
        sessionStorage.removeItem("dis_cloud_access_token");
        return;
      }
      currentUser = me.body.data;
      const w = wallet.body?.data || {};
      document.getElementById("user-badge").textContent =
        "已登录：" + currentUser.display_name + " (" + currentUser.sso_subject.slice(0, 10) + "…)";
      document.getElementById("sso-login-btn").style.display = "none";
      document.getElementById("sso-logout-btn").style.display = "inline-flex";
      document.getElementById("kpi-user").textContent = currentUser.display_name;
      document.getElementById("kpi-wallet").textContent =
        "余额：" + (w.peach_balance ?? 0) + " 🍑 (" + (w.micropeach_balance ?? 0) + " micropeach)";

      const bindingList = bindings.body?.data?.bindings || [];
      if (bindingList.length > 0) {
        firstSchoolBindingId = bindingList[0].id;
      }
      document.getElementById("schools-json").textContent = JSON.stringify(
        { my_school_bindings: bindingList },
        null,
        2
      );
      document.getElementById("plans-json").textContent = JSON.stringify(
        plans.body?.data || {},
        null,
        2
      );
      document.getElementById("jobs-json").textContent = JSON.stringify(
        jobs.body?.data || {},
        null,
        2
      );
      document.getElementById("wallet-orders-json").textContent = JSON.stringify(
        { wallet: w, orders: orders.body?.data?.orders || [] },
        null,
        2
      );
      if (parcels.ok) {
        document.getElementById("parcels-json").textContent = JSON.stringify(
          { my_parcels: parcels.body?.data?.parcels || [] },
          null,
          2
        );
      }
    }

    async function bindSchoolAccount() {
      if (!accessToken) {
        showToast("请先点击右上角「使用 XPEACH SSO 登录」后再绑定学校账号");
        return;
      }
      const studentNo = document.getElementById("bind-student-no").value.trim();
      const secret = document.getElementById("bind-secret").value.trim();
      const initRes = await apiFetch("/api/v1/school-bindings", {
        method: "POST",
        body: JSON.stringify({ school_id: "haut", student_no: studentNo })
      });
      if (!initRes.ok) {
        showToast("发起学校绑定失败：" + (initRes.body?.error?.message || initRes.status));
        return;
      }
      const bindingId = initRes.body.data.id;
      const compRes = await apiFetch("/api/v1/school-bindings/" + bindingId + "/complete", {
        method: "POST",
        body: JSON.stringify({
          credential_kind: "DELEGATED_SESSION_BUNDLE",
          delegated_secret: secret
        })
      });
      if (compRes.ok) {
        firstSchoolBindingId = bindingId;
        showToast("✅ 河工大账号已成功绑定并由 KMS 信封加密托管！");
        await loadAuthenticatedData();
      }
    }

    async function createReservationPlan() {
      if (!accessToken) {
        showToast("请先点击右上角「使用 XPEACH SSO 登录」后再创建定时抢座计划");
        return;
      }
      if (!firstSchoolBindingId) {
        await bindSchoolAccount();
      }
      const area = document.getElementById("plan-area").value.trim();
      const seat = document.getElementById("plan-seat").value.trim();
      const dateStr = document.getElementById("plan-date").value.trim();
      const mode = document.getElementById("plan-mode").value;
      const res = await apiFetch("/api/v1/reservation-plans", {
        method: "POST",
        headers: { "Idempotency-Key": "web_plan_" + Date.now() },
        body: JSON.stringify({
          school_id: "haut",
          binding_id: firstSchoolBindingId,
          mode,
          target_date: dateStr,
          target_execute_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          preferred_area_ids: [area],
          preferred_seat_ids: [seat],
          time_slot: { start: "08:00", end: "22:00" }
        })
      });
      if (res.ok) {
        showToast("✅ 已创建 T-30m / T-5m / T 智能定时抢座计划：" + area + " " + seat);
        await loadAuthenticatedData();
      } else {
        showToast("创建抢座计划失败：" + (res.body?.error?.message || res.status));
      }
    }

    async function createParcelItem() {
      if (!accessToken) {
        showToast("请先登录 XPEACH 账号后再归档包裹");
        return;
      }
      const tracking = document.getElementById("parcel-no").value.trim();
      const carrier = document.getElementById("parcel-carrier").value.trim();
      const sms = document.getElementById("parcel-sms").value.trim();
      const res = await apiFetch("/api/v1/parcels", {
        method: "POST",
        body: JSON.stringify({
          provider_id: "parcel.notification-parser",
          tracking_number: tracking,
          carrier_name: carrier,
          raw_notification_text: sms
        })
      });
      if (res.ok) {
        showToast("✅ 包裹已归档并提取取件码！");
        await loadAuthenticatedData();
      } else {
        showToast("归档包裹失败：" + (res.body?.error?.message || res.status));
      }
    }

    async function invokePluginSandbox() {
      const pluginId = document.getElementById("plugin-id").value;
      const cmd = pluginId === "example.hello-campus" ? "greetCampus" : "queryStationHours";
      const payload =
        pluginId === "example.hello-campus"
          ? { studentName: currentUser?.display_name || "河工大同学" }
          : { stationId: "north-cainiao" };
      const res = await apiFetch("/api/v1/plugins/" + encodeURIComponent(pluginId) + "/invoke", {
        method: "POST",
        body: JSON.stringify({ command: cmd, payload })
      });
      document.getElementById("plugins-json").textContent = JSON.stringify(res.body, null, 2);
      showToast("已执行签名插件沙箱调用：" + pluginId + "#" + cmd);
    }

    async function toggleKillSwitch(killSwitch) {
      const schoolId = document.getElementById("ks-school").value;
      const reason = document.getElementById("ks-reason").value;
      const res = await apiFetch("/api/v1/admin/schools/" + schoolId + "/kill-switch", {
        method: "POST",
        body: JSON.stringify({ kill_switch: killSwitch, reason })
      });
      document.getElementById("killswitch-json").textContent = JSON.stringify(res.body, null, 2);
    }

    async function submitRefund() {
      const orderId = document.getElementById("refund-order-id").value.trim();
      const amount = Number(document.getElementById("refund-amount").value);
      const approver = document.getElementById("refund-approver").value.trim();
      if (!orderId) {
        showToast("请输入要退款的订单 UUID");
        return;
      }
      const res = await apiFetch("/api/v1/admin/orders/" + encodeURIComponent(orderId) + "/refund", {
        method: "POST",
        body: JSON.stringify({
          amount_micropeach: amount,
          second_approver_ref: approver,
          reason: "Console dual-person approved refund"
        })
      });
      document.getElementById("refund-json").textContent = JSON.stringify(res.body, null, 2);
    }

    async function refreshAllData() {
      await loadPublicData();
      await loadAuthenticatedData();
    }

    (async () => {
      await handleWebTicketIfPresent();
      await refreshAllData();
    })();
  </script>
</body>
</html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.CONSOLE_PORT || 8081);
  const host = process.env.HOST || "127.0.0.1";
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "ops-console", views: CONSOLE_VIEWS.length }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderConsoleHtml());
  });
  server.listen(port, host, () => {
    console.log(JSON.stringify({ service: "ops-console", host, port, views: CONSOLE_VIEWS.length }));
  });
}
