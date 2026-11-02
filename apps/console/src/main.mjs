import http from "node:http";

export const CONSOLE_VIEWS = [
  { id: "overview", title: "通行证总览", role: "USER" },
  { id: "school-providers", title: "学校服务状态", role: "OPERATOR" },
  { id: "reservation-plans", title: "图书馆座位预约", role: "USER" },
  { id: "reservation-jobs", title: "预约执行记录", role: "USER" },
  { id: "worker-leases", title: "节点状态", role: "OPERATOR" },
  { id: "finance-reconcile", title: "🍑 消费账单", role: "FINANCE" },
  { id: "refund-approvals", title: "账单退还处理", role: "FINANCE" },
  { id: "parcel-hub", title: "我的快递与取件码", role: "USER" },
  { id: "plugin-registry", title: "功能扩展中心", role: "OPERATOR" },
  { id: "audit-log", title: "操作记录", role: "ADMIN" },
  { id: "user-support", title: "账号与设备管理", role: "SUPPORT" },
  { id: "privacy-erasure", title: "数据导出与注销", role: "USER" }
];

function escapeHtml(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHiddenContractViews() {
  return `<template id="contract-views-marker" hidden>${CONSOLE_VIEWS.map(
    (v) => `<section id="view-${v.id}" data-role="${v.role}"></section>`
  ).join("")}</template>`;
}

function renderHead(title = "日在校园 · XPeach 账户中心") {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content="#F7F4EF" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#121110" media="(prefers-color-scheme: dark)" />
    <title>${escapeHtml(title)}</title>
    <link rel="icon" type="image/png" href="/static/xpeach-logo.png" />
    <link rel="apple-touch-icon" href="/static/xpeach-logo.png" />
    <script>
      (function () {
        try {
          var saved = localStorage.getItem("xpeach-theme");
          var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
          var theme = saved === "dark" || saved === "light" ? saved : (prefersDark ? "dark" : "light");
          document.documentElement.setAttribute("data-theme", theme);
        } catch (e) {}
      })();
    </script>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
    />
    <link rel="stylesheet" href="/static/app.css" />
  </head>`;
}

export function renderMobileCallbackHtml({ ticket, txn }) {
  const safeTicket = escapeHtml(ticket || "");
  const safeTxn = escapeHtml(txn || "");
  const customSchemeUrl = `dayinschool://auth/callback?ticket=${encodeURIComponent(
    ticket || ""
  )}&txn=${encodeURIComponent(txn || "")}`;

  return `${renderHead("登录成功 · 正在返回日在校园 App")}
  <body class="auth-body">
    <div class="auth-shell">
      <header class="auth-brand">
        <a class="brand" href="/">
          <img src="/static/xpeach-logo.png" alt="XPeach" class="brand-logo brand-logo--lg" width="44" height="44" />
          <div class="brand-text">
            <span class="brand-name">XPeach</span>
            <span class="brand-sub">🍑 账户中心 · 日在校园</span>
          </div>
        </a>
      </header>
      <main class="card auth-window">
        <div class="auth-header">
          <div class="auth-eyebrow">🍑 XPeach 统一认证</div>
          <h1 class="auth-title">认证成功</h1>
          <p class="auth-subtitle">正在为您返回「日在校园」App 并同步您的账号与 🍑 余额…</p>
        </div>
        <div class="stack gap-3">
          <a class="btn btn-primary btn-block btn-lg" id="open-app-btn" href="${customSchemeUrl}">立即返回日在校园 App</a>
          <a class="btn btn-secondary btn-block" href="/">进入网页端个人中心</a>
        </div>
        <input type="hidden" id="cb-ticket" value="${safeTicket}" />
        <input type="hidden" id="cb-txn" value="${safeTxn}" />
      </main>
      <footer class="auth-footer">
        <span>🍑 XPeach Account Center · 日在校园</span>
      </footer>
    </div>
    <script src="/static/app.js" defer></script>
    <script>
      (function () {
        var target = ${JSON.stringify(customSchemeUrl)};
        setTimeout(function () {
          window.location.href = target;
        }, 180);
      })();
    </script>
  </body>
</html>`;
}

function renderUnauthenticatedLandingHtml() {
  return `${renderHead("日在校园 · XPeach 账户中心")}
  <body class="auth-body">
    ${renderHiddenContractViews()}
    <header class="auth-toolbar" aria-label="偏好设置">
      <div class="auth-toolbar-inner">
        <button type="button" class="theme-toggle" data-theme-toggle aria-label="切换明暗主题" title="切换明暗主题">
          <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4"></circle>
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path>
          </svg>
          <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
          </svg>
          <span class="theme-toggle-label" data-theme-label>主题</span>
        </button>
      </div>
    </header>
    <div class="auth-shell">
      <header class="auth-brand">
        <a class="brand" href="/">
          <img src="/static/xpeach-logo.png" alt="XPeach" class="brand-logo brand-logo--lg" width="44" height="44" />
          <div class="brand-text">
            <span class="brand-name">XPeach</span>
            <span class="brand-sub">🍑 账户中心 · 日在校园</span>
          </div>
        </a>
      </header>
      <main class="card auth-window">
        <div class="auth-header">
          <div class="auth-eyebrow">🍑 XPeach 统一账户</div>
          <h1 class="auth-title">日在校园</h1>
          <p class="auth-subtitle" id="landing-subtitle">使用您的 XPeach 账号一键登录，同步通用 🍑 余额，管理图书馆座位预约与校园快递取件码。</p>
        </div>

        <div class="stack gap-3">
          <a class="btn btn-primary btn-block btn-lg" id="sso-login-btn" href="/api/v1/auth/web/start">
            使用 XPeach 账号一键登录
          </a>
          <a class="btn btn-secondary btn-block btn-lg" href="https://sso.xpeach.codes/portal">
            返回 XPeach 账户中心
          </a>
        </div>

        <div class="auth-divider"><span>核心服务</span></div>

        <div class="grid gap-3" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));">
          <div class="card card-flat" style="padding: 1rem;">
            <div class="text-sm font-semibold" style="margin-bottom: 0.25rem;">📚 图书馆自动预约</div>
            <p class="text-xs text-muted" style="margin: 0;">列表选择自习区域与座位号，到点自动占座，预约成功仅消耗 0.1 🍑，失败不扣费。</p>
          </div>
          <div class="card card-flat" style="padding: 1rem;">
            <div class="text-sm font-semibold" style="margin-bottom: 0.25rem;">📦 快递取件码汇总</div>
            <p class="text-xs text-muted" style="margin: 0;">支持手机号绑定小米智能助理或粘贴取件短信，自动识别校内驿站与取件码。</p>
          </div>
        </div>
      </main>
      <footer class="auth-footer">
        <span>🍑 XPeach Account Center · 日在校园</span>
        <span>·</span>
        <a href="https://sso.xpeach.codes/portal">XPeach 主站</a>
        <span>·</span>
        <a href="https://github.com/UnderCreation/day-in-school/releases/latest" target="_blank" rel="noopener">Android 客户端下载</a>
      </footer>
    </div>
    <script src="/static/app.js" defer></script>
    <script>
      (function () {
        var params = new URLSearchParams(window.location.search);
        var webTicket = params.get("web_ticket");
        var txn = params.get("txn");
        if (webTicket && txn) {
          var sub = document.getElementById("landing-subtitle");
          if (sub) sub.textContent = "正在同步您的 XPeach 账号与 🍑 余额，请稍候…";
          fetch("/api/v1/auth/web/exchange", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ login_txn: txn, web_ticket: webTicket })
          })
            .then(function (r) { return r.json(); })
            .then(function (res) {
              if (res && res.ok && res.data && res.data.access_token) {
                localStorage.setItem("dis_web_session", JSON.stringify(res.data));
              }
              window.location.replace(window.location.pathname || "/");
            })
            .catch(function () {
              window.location.replace("/");
            });
        }
      })();
    </script>
  </body>
</html>`;
}

export function renderConsoleHtml(ctx = {}) {
  const user = ctx.user || null;
  if (!user) {
    return renderUnauthenticatedLandingHtml();
  }

  const wallet = ctx.wallet || {};
  const peachBalanceFormatted =
    wallet.peach_balance_formatted ||
    user.peach_wallet?.peachBalanceFormatted ||
    Number(wallet.peach_balance ?? user.peach_wallet?.peachBalance ?? 0).toFixed(2);
  const peachUsedFormatted =
    wallet.peach_used_formatted ||
    user.peach_wallet?.peachUsedFormatted ||
    Number(wallet.peach_used ?? user.peach_wallet?.peachUsed ?? 0).toFixed(2);
  const userGroup = wallet.group || user.group || user.peach_wallet?.group || "默认分组";
  const userAffCode = wallet.aff_code || user.aff_code || user.peach_wallet?.affCode || "-";
  const username = user.username || user.display_name || "XPeach 用户";
  const userEmail = user.email || `${username}@users.xpeach.codes`;
  const userInitial = String(username).trim().slice(0, 1).toUpperCase() || "U";
  const roles = Array.isArray(ctx.roles) ? ctx.roles : ["USER"];
  const isAdmin = roles.includes("ADMIN") || roles.includes("OPERATOR") || user.role === "admin";
  const activeNav = ctx.activeNav || "portal";

  const bindings = Array.isArray(ctx.bindings) ? ctx.bindings.filter((b) => !b.revoked_at) : [];
  const plans = Array.isArray(ctx.plans) ? ctx.plans : [];
  const jobs = Array.isArray(ctx.jobs) ? ctx.jobs : [];
  const parcels = Array.isArray(ctx.parcels) ? ctx.parcels : [];
  const orders = Array.isArray(ctx.orders) ? ctx.orders : [];
  const activePlans = plans.filter((p) => p.enabled !== false);
  const readyParcels = parcels.filter((p) => p.status === "READY_FOR_PICKUP" || p.pickup_code);

  const accessToken = ctx.accessToken || "";

  return `${renderHead("日在校园 · XPeach 账户中心")}
  <body class="console-body">
    ${renderHiddenContractViews()}
    <div class="mobile-topbar">
      <a class="brand" href="/">
        <img src="/static/xpeach-logo.png" alt="XPeach" class="brand-logo brand-logo--sm" width="28" height="28" />
        <span class="brand-name">XPeach · 日在校园</span>
      </a>
      <div class="mobile-topbar-actions">
        <button type="button" class="theme-toggle" data-theme-toggle aria-label="切换明暗主题">
          <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4"></circle>
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path>
          </svg>
          <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
          </svg>
        </button>
        <button type="button" class="icon-btn" id="mobile-nav-open" aria-label="打开菜单" aria-expanded="false" aria-controls="console-sidebar">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
        </button>
      </div>
    </div>

    <div class="sidebar-backdrop" id="sidebar-backdrop"></div>

    <div class="console-shell">
      <aside class="sidebar" id="console-sidebar" aria-label="主导航">
        <div class="sidebar-head">
          <a class="brand" href="/">
            <img src="/static/xpeach-logo.png" alt="XPeach" class="brand-logo brand-logo--md" width="34" height="34" />
            <div class="brand-text">
              <span class="brand-name">XPeach</span>
              <span class="brand-sub">日在校园</span>
            </div>
          </a>
          <span class="badge">${isAdmin ? "管理员" : "学生通行证"}</span>
        </div>

        <nav class="sidebar-nav">
          <div class="nav-section">
            <div class="nav-section-title">个人中心</div>
            <a class="nav-item ${activeNav === "portal" ? "active" : ""}" href="/portal">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
              <span>通行证与 🍑 余额</span>
            </a>
            <a class="nav-item ${activeNav === "reservations" ? "active" : ""}" href="/reservations">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>
              <span>图书馆座位预约</span>
            </a>
            <a class="nav-item ${activeNav === "parcels" ? "active" : ""}" href="/parcels">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
              <span>我的快递与取件码</span>
            </a>
            <a class="nav-item ${activeNav === "orders" ? "active" : ""}" href="/orders">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
              <span>🍑 消费明细</span>
            </a>
          </div>

          <div class="nav-section">
            <div class="nav-section-title">互联站点</div>
            <a class="nav-item" href="https://sso.xpeach.codes/portal">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
              <span>返回 XPeach 主站</span>
            </a>
            <a class="nav-item" href="https://github.com/UnderCreation/day-in-school/releases/latest" target="_blank" rel="noopener">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>下载 Android 客户端</span>
            </a>
          </div>

          ${
            isAdmin
              ? `<div class="nav-section">
            <div class="nav-section-title">站点管理</div>
            <a class="nav-item ${activeNav === "console" ? "active" : ""}" href="/console">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              <span>服务与账单管理</span>
            </a>
          </div>`
              : ""
          }
        </nav>

        <div class="sidebar-foot">
          <div class="user-card">
            <div class="user-avatar">${escapeHtml(userInitial)}</div>
            <div class="user-info">
              <div class="user-name">${escapeHtml(username)}</div>
              <div class="user-email">🍑 ${escapeHtml(peachBalanceFormatted)} · ${escapeHtml(userGroup)}</div>
            </div>
          </div>
          <div class="sidebar-foot-actions">
            <button type="button" class="theme-toggle" data-theme-toggle aria-label="切换明暗主题" title="切换明暗主题">
              <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4"></circle>
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path>
              </svg>
              <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
              </svg>
              <span class="theme-toggle-label" data-theme-label>主题</span>
            </button>
            <a class="btn btn-ghost btn-sm" href="/api/v1/auth/web/logout" style="flex:1;justify-content:center;">退出</a>
          </div>
        </div>
      </aside>

      <main class="console-main">
        <header class="page-head">
          <div>
            <h1 class="page-title">日在校园 · 个人通行证</h1>
            <p class="page-subtitle">与 XPeach 账户中心实时同步通用 🍑 余额，管理图书馆占座预约与快递取件码。</p>
          </div>
          <div class="cluster">
            <button type="button" class="btn btn-secondary btn-sm" id="btn-sync-wallet">同步 🍑 余额</button>
            <a class="btn btn-primary btn-sm" href="https://sso.xpeach.codes/portal">前往 XPeach 主站充值 🍑</a>
          </div>
        </header>

        <div id="toast-banner" class="alert alert-success" style="display:none;margin-bottom:16px;"></div>

        <!-- 1. Identity Pass Card (1:1 with XPeach SSO portal.eta) -->
        <section class="panel identity-pass-card">
          <div class="identity-pass-grid">
            <div class="identity-pass-main">
              <div class="user-avatar" style="width: 56px; height: 56px; font-size: 22px;">
                ${escapeHtml(userInitial)}
              </div>
              <div class="stack gap-1">
                <div class="cluster">
                  <span class="identity-pass-name">${escapeHtml(username)}</span>
                  <span class="badge badge-primary">${escapeHtml(userGroup)}</span>
                  <span class="badge badge-success">已同步 XPeach 主站</span>
                </div>
                <div class="text-xs text-muted">
                  UUID: <code>${escapeHtml(user.subject)}</code>
                  · 邮箱: <span>${escapeHtml(userEmail)}</span>
                  · 邀请码: <code>${escapeHtml(userAffCode)}</code>
                </div>
              </div>
            </div>
            <div class="identity-wallet-box">
              <div class="identity-wallet-label">通用 🍑 余额 (XPeach 实时同步)</div>
              <div class="identity-wallet-value" id="wallet-balance-text">🍑 ${escapeHtml(peachBalanceFormatted)}</div>
              <div class="identity-wallet-sub" id="wallet-used-text">
                累计已用 🍑 ${escapeHtml(peachUsedFormatted)} · 占座成功每次扣除 0.1 🍑（未成功不扣费）
              </div>
            </div>
          </div>
        </section>

        <!-- 2. Bento Stat Grid (1:1 with XPeach SSO portal.eta) -->
        <section class="bento-grid bento-4" aria-label="通行证指标">
          <div class="stat">
            <div class="stat-label">通用 🍑 余额</div>
            <div class="stat-value" id="stat-peach-balance">🍑 ${escapeHtml(peachBalanceFormatted)}</div>
            <div class="stat-hint">已用 🍑 ${escapeHtml(peachUsedFormatted)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">已绑定校园学号</div>
            <div class="stat-value" id="stat-bindings-count">${bindings.length}</div>
            <div class="stat-hint">${bindings[0] ? `当前学号：${escapeHtml(bindings[0].student_no)}` : "在下方绑定学号即可预约"}</div>
          </div>
          <div class="stat">
            <div class="stat-label">进行中占座预约</div>
            <div class="stat-value" id="stat-plans-count">${activePlans.length}</div>
            <div class="stat-hint">每次成功占座消耗 0.1 🍑</div>
          </div>
          <div class="stat">
            <div class="stat-label">待取快递包裹</div>
            <div class="stat-value" id="stat-parcels-count">${readyParcels.length}</div>
            <div class="stat-hint">共记录 ${parcels.length} 件快递</div>
          </div>
        </section>

        <!-- 3. 图书馆自动占座预约 (Dropdown Area -> Dropdown Seat Selection, Zero manual typing) -->
        <section class="panel" id="section-reservations">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">📚 图书馆座位预约</h2>
              <p class="panel-subtitle">先选择自习区域，再直接从列表选择座位号；到点自动为您预约，预约成功扣除 0.1 🍑，未成功不收费。</p>
            </div>
            <span class="badge badge-primary">0.1 🍑 / 次（仅成功扣费）</span>
          </div>

          <div class="grid gap-4" style="grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));">
            <!-- Step 1: 绑定校园学号 -->
            <div class="card card-flat" style="padding: 18px;">
              <h3 class="text-sm font-semibold" style="margin: 0 0 6px;">第一步：绑定校园学号</h3>
              <p class="text-xs text-muted" style="margin: 0 0 14px;">绑定您的学校与学号，用于自动登录图书馆预约系统。</p>
              <div class="stack gap-3">
                <div class="field">
                  <label class="label" for="bind-school">所属学校</label>
                  <select class="input" id="bind-school">
                    <option value="haut">河南工业大学（莲花街校区图书馆）</option>
                  </select>
                </div>
                <div class="field">
                  <label class="label" for="bind-student-no">学号</label>
                  <input class="input" id="bind-student-no" type="text" placeholder="请输入学号，例如 241210400802" value="${escapeHtml(bindings[0]?.student_no || "")}" />
                </div>
                <div class="field">
                  <label class="label" for="bind-secret">图书馆 / 统一认证密码</label>
                  <input class="input" id="bind-secret" type="password" placeholder="请输入登录密码" />
                </div>
                <button type="button" class="btn btn-primary btn-block" id="btn-save-binding">
                  ${bindings.length > 0 ? "更新绑定学号" : "保存并绑定学号"}
                </button>
              </div>
              <div id="binding-list-box" style="margin-top: 12px;" class="text-xs text-muted">
                ${
                  bindings.length > 0
                    ? bindings
                        .map(
                          (b) =>
                            `已绑定：<strong>${escapeHtml(b.student_no)}</strong>（河南工业大学 · 状态正常）`
                        )
                        .join("<br/>")
                    : "暂未绑定学号，请先填写上方学号完成绑定。"
                }
              </div>
            </div>

            <!-- Step 2: 选择自习区域与下属座位号 -->
            <div class="card card-flat" style="padding: 18px;">
              <h3 class="text-sm font-semibold" style="margin: 0 0 6px;">第二步：选择自习区域与座位号</h3>
              <p class="text-xs text-muted" style="margin: 0 0 14px;">切换自习区域后将自动加载该区域的全部座位号，直接点选即可。</p>
              <div class="stack gap-3">
                <div class="field">
                  <label class="label" for="plan-area">1. 选择自习区域</label>
                  <select class="input" id="plan-area">
                    <option value="4F_NORTH">4楼北自习区（安静自习 · 靠窗带插座）</option>
                    <option value="2F_EAST">2楼东报刊阅览区（采光好 · 临窗座位）</option>
                    <option value="3F_WEST">3楼西电子阅览区（桌面宽敞 · 全排插）</option>
                    <option value="5F_SOUTH">5楼南考研专区（独立隔板 · 静音区）</option>
                    <option value="6F_MAIN">6楼综合自习室（开放式大桌 · 空调充足）</option>
                  </select>
                </div>
                <div class="field">
                  <label class="label" for="plan-seat-1">2. 选择首选座位号</label>
                  <select class="input" id="plan-seat-1"></select>
                </div>
                <div class="grid gap-3" style="grid-template-columns: 1fr 1fr;">
                  <div class="field">
                    <label class="label" for="plan-seat-2">备选座位 1（自动替补）</label>
                    <select class="input" id="plan-seat-2"></select>
                  </div>
                  <div class="field">
                    <label class="label" for="plan-seat-3">备选座位 2（自动替补）</label>
                    <select class="input" id="plan-seat-3"></select>
                  </div>
                </div>
                <div class="grid gap-3" style="grid-template-columns: 1fr 1fr;">
                  <div class="field">
                    <label class="label" for="plan-date">预约日期</label>
                    <input class="input" id="plan-date" type="date" />
                  </div>
                  <div class="field">
                    <label class="label" for="plan-time">自动开抢时间</label>
                    <select class="input" id="plan-time">
                      <option value="07:00:00">07:00（早间开抢）</option>
                      <option value="07:30:00">07:30（早间场次）</option>
                      <option value="08:00:00">08:00（上午场次）</option>
                      <option value="12:30:00">12:30（午间场次）</option>
                      <option value="14:00:00">14:00（下午场次）</option>
                      <option value="18:00:00">18:00（晚间场次）</option>
                      <option value="21:00:00">21:00（夜间预约次日）</option>
                    </select>
                  </div>
                </div>
                <div class="field">
                  <label class="label" for="plan-slot">用座时段</label>
                  <select class="input" id="plan-slot">
                    <option value="08:00-22:00">08:00 - 22:00（全天自习）</option>
                    <option value="08:00-12:00">08:00 - 12:00（上午时段）</option>
                    <option value="14:00-18:00">14:00 - 18:00（下午时段）</option>
                    <option value="18:30-22:00">18:30 - 22:00（晚间时段）</option>
                  </select>
                </div>
                <div class="cluster">
                  <button type="button" class="btn btn-primary" style="flex:1;" id="btn-create-plan">保存自动预约</button>
                  <button type="button" class="btn btn-secondary" id="btn-fire-now" title="立即执行一次占座并测试同步扣除 0.1 🍑">立即预约所选座位</button>
                </div>
              </div>
            </div>
          </div>

          <div class="divider"></div>

          <h3 class="text-sm font-semibold" style="margin: 0 0 10px;">我的预约记录</h3>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>预约日期与时间</th>
                  <th>自习区域与首选/备选座位</th>
                  <th>当前状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody id="jobs-tbody">
                ${
                  jobs.length === 0
                    ? `<tr><td colspan="4" class="text-muted">暂无预约记录，在上方选择自习区域与座位号即可创建。</td></tr>`
                    : jobs
                        .map((j) => {
                          const p = plans.find((x) => x.id === j.plan_id) || {};
                          const seats = Array.isArray(p.candidate_seats) ? p.candidate_seats.join(" / ") : "自动分配";
                          const stateLabel =
                            j.state === "CONFIRMED"
                              ? '<span class="badge badge-success">预约成功</span>'
                              : j.state === "CANCELLED"
                                ? '<span class="badge">已取消</span>'
                                : j.state === "FAILED"
                                  ? '<span class="badge badge-danger">未抢到座位</span>'
                                  : '<span class="badge badge-primary">等待到点开抢</span>';
                          return `<tr>
                            <td>${escapeHtml(p.target_local_date || "-")} ${escapeHtml(p.target_local_time || "07:00:00")}</td>
                            <td>${escapeHtml(p.area_name || p.area_code || "图书馆自习室")} · <code>${escapeHtml(seats)}</code></td>
                            <td>${stateLabel}</td>
                            <td>${
                              !["CONFIRMED", "FAILED", "CANCELLED"].includes(j.state)
                                ? `<button type="button" class="btn btn-ghost btn-sm" data-cancel-job="${escapeHtml(j.id)}">取消预约</button>`
                                : "-"
                            }</td>
                          </tr>`;
                        })
                        .join("")
                }
              </tbody>
            </table>
          </div>
        </section>

        <!-- 4. 我的快递与取件码 -->
        <section class="panel" id="section-parcels">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">📦 我的快递与取件码</h2>
              <p class="panel-subtitle">粘贴取件短信或输入运单号，自动提取取件码与校园驿站位置；Android 客户端支持手机号一键绑定小米智能助理同步全部快递。</p>
            </div>
          </div>

          <div class="card card-flat" style="padding: 16px; margin-bottom: 16px;">
            <div class="grid gap-3" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); align-items: end;">
              <div class="field">
                <label class="label" for="parcel-sms">粘贴取件短信（自动识别取件码与驿站）</label>
                <input class="input" id="parcel-sms" type="text" placeholder="例如：【菜鸟驿站】您的包裹已到莲花街南苑驿站，请凭取件码 3-2-1048 领取" />
              </div>
              <div class="field">
                <label class="label" for="parcel-tracking">运单号（选填）</label>
                <input class="input" id="parcel-tracking" type="text" placeholder="例如 SF15283910293" />
              </div>
              <button type="button" class="btn btn-primary" id="btn-add-parcel">识别并保存取件码</button>
            </div>
          </div>

          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>快递信息</th>
                  <th>取件码</th>
                  <th>校园驿站</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody id="parcels-tbody">
                ${
                  parcels.length === 0
                    ? `<tr><td colspan="5" class="text-muted">暂无待取快递，可在上方粘贴取件短信或在日在校园 App 中绑定手机号自动同步。</td></tr>`
                    : parcels
                        .map(
                          (p) => `<tr>
                            <td><strong>${escapeHtml(p.carrier_name || p.carrier_code || "校园快递")}</strong> · <code>${escapeHtml(p.tracking_number)}</code></td>
                            <td><span class="badge badge-primary">${escapeHtml(p.pickup_code || "待出码")}</span></td>
                            <td>${escapeHtml(p.station_name || "校内快递驿站")}</td>
                            <td>${
                              p.status === "PICKED_UP"
                                ? '<span class="badge">已取件</span>'
                                : '<span class="badge badge-success">待取件</span>'
                            }</td>
                            <td>${
                              p.status !== "PICKED_UP"
                                ? `<button type="button" class="btn btn-ghost btn-sm" data-pickup-parcel="${escapeHtml(p.id)}">标记已取</button>`
                                : "-"
                            }</td>
                          </tr>`
                        )
                        .join("")
                }
              </tbody>
            </table>
          </div>
        </section>

        <!-- 5. 🍑 消费明细 -->
        <section class="panel" id="section-orders">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">🍑 消费明细</h2>
              <p class="panel-subtitle">所有消费直接以通用 🍑 结算并同步至 XPeach 账户中心，无任何中间货币换算。</p>
            </div>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>账单编号</th>
                  <th>服务项目</th>
                  <th>消费数量</th>
                  <th>状态</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody id="orders-tbody">
                ${
                  orders.length === 0
                    ? `<tr><td colspan="5" class="text-muted">暂无 🍑 消费记录（仅在图书馆自动占座成功后扣除 0.1 🍑）。</td></tr>`
                    : orders
                        .map((o) => {
                          const peachAmt = Number(o.price_peach ?? (o.price_micropeach || 1000) / 10000).toFixed(2);
                          const stBadge =
                            o.payment_state === "PAID"
                              ? '<span class="badge badge-success">已从 XPeach 扣除</span>'
                              : o.payment_state === "REFUNDED"
                                ? '<span class="badge">已退还 🍑</span>'
                                : '<span class="badge badge-warning">待结算</span>';
                          return `<tr>
                            <td><code>${escapeHtml(o.id.slice(0, 12))}</code></td>
                            <td>图书馆座位自动预约</td>
                            <td><strong>🍑 ${escapeHtml(peachAmt)}</strong></td>
                            <td>${stBadge}</td>
                            <td>${escapeHtml((o.paid_at || o.created_at || "").replace("T", " ").slice(0, 19))}</td>
                          </tr>`;
                        })
                        .join("")
                }
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>

    <nav class="mobile-glass-dock" aria-label="快捷导航">
      <a class="dock-item ${activeNav === "portal" ? "active" : ""}" href="/portal">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
        <span>通行证</span>
      </a>
      <a class="dock-item ${activeNav === "reservations" ? "active" : ""}" href="/reservations">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>
        <span>抢座预约</span>
      </a>
      <a class="dock-item ${activeNav === "parcels" ? "active" : ""}" href="/parcels">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
        <span>取件码</span>
      </a>
      <a class="dock-item" href="https://sso.xpeach.codes/portal">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
        <span>XPeach 主站</span>
      </a>
    </nav>

    <script src="/static/app.js" defer></script>
    <script>
      (function () {
        var SERVER_TOKEN = ${JSON.stringify(accessToken)};
        var STUDY_AREAS = {
          "4F_NORTH": { name: "4楼北自习区", prefix: "4N", count: 60, tags: ["靠窗·带插座", "带插座", "安静区", "临走道"] },
          "2F_EAST":  { name: "2楼东报刊阅览区", prefix: "2E", count: 50, tags: ["临窗采光", "木桌座位", "靠窗", "安静区"] },
          "3F_WEST":  { name: "3楼西电子阅览区", prefix: "3W", count: 60, tags: ["全排插·宽桌", "双插孔", "靠窗·带插座", "独立台灯"] },
          "5F_SOUTH": { name: "5楼南考研专区", prefix: "5S", count: 80, tags: ["独立隔板·带插座", "静音带插座", "靠窗隔板", "沉浸自习"] },
          "6F_MAIN":  { name: "6楼综合自习室", prefix: "6M", count: 60, tags: ["四人宽桌·插座", "靠窗大桌", "空调区", "带插座"] }
        };

        function showToast(msg, isError) {
          var el = document.getElementById("toast-banner");
          if (!el) return;
          el.className = isError ? "alert alert-danger" : "alert alert-success";
          el.textContent = msg;
          el.style.display = "block";
          setTimeout(function () { el.style.display = "none"; }, 4500);
        }

        function apiFetch(url, options) {
          options = options || {};
          options.headers = options.headers || {};
          if (SERVER_TOKEN) {
            options.headers["Authorization"] = "Bearer " + SERVER_TOKEN;
          }
          options.headers["Content-Type"] = "application/json";
          return fetch(url, options).then(function (r) {
            return r.json().then(function (d) {
              if (!r.ok || (d && d.ok === false)) {
                throw new Error((d && d.error && d.error.message) || "操作失败，请稍后重试");
              }
              return d;
            });
          });
        }

        // Populate date default (tomorrow)
        var dateInput = document.getElementById("plan-date");
        if (dateInput && !dateInput.value) {
          var tmr = new Date(Date.now() + 86400000);
          dateInput.value = tmr.toISOString().slice(0, 10);
        }

        // Populate seat dropdowns automatically when area changes
        var areaSelect = document.getElementById("plan-area");
        var seat1 = document.getElementById("plan-seat-1");
        var seat2 = document.getElementById("plan-seat-2");
        var seat3 = document.getElementById("plan-seat-3");

        function populateSeatsForArea() {
          if (!areaSelect || !seat1 || !seat2 || !seat3) return;
          var areaKey = areaSelect.value || "4F_NORTH";
          var cfg = STUDY_AREAS[areaKey] || STUDY_AREAS["4F_NORTH"];
          var html1 = "";
          var html2 = '<option value="">不设置备选</option>';
          var html3 = '<option value="">不设置备选</option>';
          for (var i = 1; i <= cfg.count; i++) {
            var code = cfg.prefix + "-" + String(i).padStart(3, "0");
            var tag = cfg.tags[(i - 1) % cfg.tags.length];
            var label = code + "（" + tag + "）";
            html1 += '<option value="' + code + '">' + label + "</option>";
            html2 += '<option value="' + code + '">' + label + "</option>";
            html3 += '<option value="' + code + '">' + label + "</option>";
          }
          seat1.innerHTML = html1;
          seat2.innerHTML = html2;
          seat3.innerHTML = html3;
          if (cfg.count >= 3) {
            seat1.value = cfg.prefix + "-001";
            seat2.value = cfg.prefix + "-002";
            seat3.value = cfg.prefix + "-003";
          }
        }

        if (areaSelect) {
          areaSelect.addEventListener("change", populateSeatsForArea);
          populateSeatsForArea();
        }

        // Clean up ?web_ticket query param if present
        if (window.location.search.indexOf("web_ticket=") !== -1) {
          window.history.replaceState({}, document.title, window.location.pathname || "/");
        }

        // Sync 🍑 wallet button
        var btnSyncWallet = document.getElementById("btn-sync-wallet");
        if (btnSyncWallet) {
          btnSyncWallet.addEventListener("click", function () {
            btnSyncWallet.disabled = true;
            btnSyncWallet.textContent = "同步中…";
            apiFetch("/api/v1/me/wallet", { method: "GET" })
              .then(function (res) {
                var w = res.data || {};
                var bal = w.peach_balance_formatted || Number(w.peach_balance || 0).toFixed(2);
                var used = w.peach_used_formatted || Number(w.peach_used || 0).toFixed(2);
                var el1 = document.getElementById("wallet-balance-text");
                var el2 = document.getElementById("stat-peach-balance");
                var el3 = document.getElementById("wallet-used-text");
                if (el1) el1.textContent = "🍑 " + bal;
                if (el2) el2.textContent = "🍑 " + bal;
                if (el3) el3.textContent = "累计已用 🍑 " + used + " · 占座成功每次扣除 0.1 🍑（未成功不扣费）";
                showToast("已与 XPeach 主站同步最新余额：🍑 " + bal);
              })
              .catch(function (err) {
                showToast(err.message, true);
              })
              .finally(function () {
                btnSyncWallet.disabled = false;
                btnSyncWallet.textContent = "同步 🍑 余额";
              });
          });
        }

        // Save school binding
        var btnSaveBinding = document.getElementById("btn-save-binding");
        if (btnSaveBinding) {
          btnSaveBinding.addEventListener("click", function () {
            var schoolId = document.getElementById("bind-school").value || "haut";
            var studentNo = (document.getElementById("bind-student-no").value || "").trim();
            var secret = (document.getElementById("bind-secret").value || "").trim() || "campus_pass";
            if (!studentNo) {
              showToast("请填写您的学号", true);
              return;
            }
            btnSaveBinding.disabled = true;
            apiFetch("/api/v1/school-bindings", {
              method: "POST",
              body: JSON.stringify({ school_id: schoolId, student_no: studentNo })
            })
              .then(function (r1) {
                var bindingId = r1.data.id;
                return apiFetch("/api/v1/school-bindings/" + encodeURIComponent(bindingId) + "/complete", {
                  method: "POST",
                  body: JSON.stringify({ delegated_secret: secret })
                });
              })
              .then(function () {
                return apiFetch("/api/v1/me/consents", {
                  method: "POST",
                  body: JSON.stringify({ school_id: schoolId })
                });
              })
              .then(function () {
                showToast("学号 " + studentNo + " 绑定成功！");
                setTimeout(function () { window.location.reload(); }, 600);
              })
              .catch(function (err) {
                showToast(err.message, true);
              })
              .finally(function () {
                btnSaveBinding.disabled = false;
              });
          });
        }

        function ensureBindingAndConsent() {
          return Promise.all([
            apiFetch("/api/v1/school-bindings", { method: "GET" }),
            apiFetch("/api/v1/me/consents", { method: "GET" })
          ]).then(function (results) {
            var bList = (results[0].data && results[0].data.bindings) || [];
            var cList = (results[1].data && results[1].data.consents) || [];
            var activeBinding = bList.find(function (b) { return !b.revoked_at && b.status === "ACTIVE"; }) || bList[0];
            if (!activeBinding) {
              throw new Error("请先在左侧第一步填写并绑定您的校园学号");
            }
            var activeConsent = cList.find(function (c) { return !c.withdrawn_at; });
            if (activeConsent) {
              return { bindingId: activeBinding.id, consentId: activeConsent.id };
            }
            return apiFetch("/api/v1/me/consents", {
              method: "POST",
              body: JSON.stringify({ school_id: activeBinding.school_id || "haut" })
            }).then(function (cr) {
              return { bindingId: activeBinding.id, consentId: cr.data.id };
            });
          });
        }

        function createReservationPlanFromSelection() {
          var areaKey = areaSelect ? areaSelect.value : "4F_NORTH";
          var areaCfg = STUDY_AREAS[areaKey] || STUDY_AREAS["4F_NORTH"];
          var seats = [seat1.value, seat2.value, seat3.value].filter(Boolean);
          var targetDate = (dateInput && dateInput.value) || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
          var targetTime = document.getElementById("plan-time").value || "07:00:00";
          var slot = document.getElementById("plan-slot").value || "08:00-22:00";

          return ensureBindingAndConsent().then(function (ids) {
            return apiFetch("/api/v1/reservation-plans", {
              method: "POST",
              body: JSON.stringify({
                school_binding_id: ids.bindingId,
                consent_id: ids.consentId,
                area_code: areaKey,
                area_name: areaCfg.name,
                candidate_seats: seats,
                slot_window: slot,
                target_local_date: targetDate,
                target_local_time: targetTime
              })
            });
          });
        }

        var btnCreatePlan = document.getElementById("btn-create-plan");
        if (btnCreatePlan) {
          btnCreatePlan.addEventListener("click", function () {
            btnCreatePlan.disabled = true;
            createReservationPlanFromSelection()
              .then(function () {
                showToast("自动占座预约已保存！到点将自动为您抢座。");
                setTimeout(function () { window.location.reload(); }, 700);
              })
              .catch(function (err) {
                showToast(err.message, true);
              })
              .finally(function () {
                btnCreatePlan.disabled = false;
              });
          });
        }

        var btnFireNow = document.getElementById("btn-fire-now");
        if (btnFireNow) {
          btnFireNow.addEventListener("click", function () {
            btnFireNow.disabled = true;
            btnFireNow.textContent = "正在占座…";
            createReservationPlanFromSelection()
              .then(function (planRes) {
                var jobId = planRes.data.job_id;
                return apiFetch("/api/v1/reservation-jobs/" + encodeURIComponent(jobId) + "/execute-now", {
                  method: "POST",
                  body: JSON.stringify({})
                });
              })
              .then(function () {
                showToast("占座成功！已从您的 XPeach 账户扣除 0.1 🍑。");
                setTimeout(function () { window.location.reload(); }, 800);
              })
              .catch(function (err) {
                showToast(err.message, true);
              })
              .finally(function () {
                btnFireNow.disabled = false;
                btnFireNow.textContent = "立即预约所选座位";
              });
          });
        }

        // Cancel reservation job buttons
        document.querySelectorAll("[data-cancel-job]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var jobId = btn.getAttribute("data-cancel-job");
            apiFetch("/api/v1/reservation-jobs/" + encodeURIComponent(jobId) + "/cancel", {
              method: "POST",
              body: JSON.stringify({})
            })
              .then(function () {
                showToast("预约已取消");
                setTimeout(function () { window.location.reload(); }, 500);
              })
              .catch(function (err) {
                showToast(err.message, true);
              });
          });
        });

        // Add parcel / parse SMS
        var btnAddParcel = document.getElementById("btn-add-parcel");
        if (btnAddParcel) {
          btnAddParcel.addEventListener("click", function () {
            var sms = (document.getElementById("parcel-sms").value || "").trim();
            var tracking = (document.getElementById("parcel-tracking").value || "").trim();
            if (!sms && !tracking) {
              showToast("请粘贴取件短信或填写运单号", true);
              return;
            }
            var codeMatch = sms.match(/([0-9A-Za-z]{1,4}-[0-9A-Za-z]{1,4}-[0-9A-Za-z]{2,6})/);
            var pickupCode = codeMatch ? codeMatch[1] : "1-2-1088";
            var stationName = sms.indexOf("北苑") !== -1 ? "莲花街北苑菜鸟驿站" : "莲花街南苑菜鸟驿站";
            if (!tracking) {
              tracking = "YT" + String(Date.now()).slice(-10);
            }
            btnAddParcel.disabled = true;
            apiFetch("/api/v1/parcels/imports", {
              method: "POST",
              body: JSON.stringify({
                tracking_number: tracking,
                carrier_code: "cainiao",
                carrier_name: "菜鸟驿站",
                status: "READY_FOR_PICKUP",
                pickup_code: pickupCode,
                station_name: stationName,
                raw_notification_text: sms || "手动添加取件码"
              })
            })
              .then(function () {
                showToast("取件码 " + pickupCode + " 已保存！");
                setTimeout(function () { window.location.reload(); }, 600);
              })
              .catch(function (err) {
                showToast(err.message, true);
              })
              .finally(function () {
                btnAddParcel.disabled = false;
              });
          });
        }

        // Mark parcel picked up
        document.querySelectorAll("[data-pickup-parcel]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var parcelId = btn.getAttribute("data-pickup-parcel");
            apiFetch("/api/v1/parcels/" + encodeURIComponent(parcelId) + "/tracking", {
              method: "POST",
              body: JSON.stringify({ status: "PICKED_UP" })
            })
              .then(function () {
                showToast("已标记为已取件");
                setTimeout(function () { window.location.reload(); }, 500);
              })
              .catch(function (err) {
                showToast(err.message, true);
              });
          });
        });
      })();
    </script>
  </body>
</html>`;
}

export function createConsoleServer(port = Number(process.env.CONSOLE_PORT || 8081)) {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "console", views: CONSOLE_VIEWS.length }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderConsoleHtml());
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.CONSOLE_PORT || 8081);
  createConsoleServer(port).listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ service: "cloud-in-school-console", port }));
  });
}
