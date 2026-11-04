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

function cleanDisplayText(val, fallback = "") {
  if (val === null || val === undefined) return fallback;
  const trimmed = String(val).trim();
  if (!trimmed) return fallback;
  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "undefined" || lower === "none" || lower === "nil") {
    return fallback;
  }
  const cleaned = trimmed
    .replace(/\s*·\s*null\b/gi, "")
    .replace(/\bnull\s*·\s*/gi, "")
    .trim();
  return cleaned || fallback;
}

function escapeHtml(val) {
  return String(cleanDisplayText(val, ""))
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
      href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
    />
    <link rel="stylesheet" href="/static/app.css" />
    <style>
      .area-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 12px;
      }
      .area-pill {
        appearance: none;
        border: 1px solid var(--border, rgba(120, 113, 108, 0.24));
        background: var(--surface-muted, rgba(120, 113, 108, 0.06));
        color: var(--text, inherit);
        padding: 7px 13px;
        border-radius: 999px;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.16s ease;
      }
      .area-pill.active {
        background: #E86A33;
        border-color: #E86A33;
        color: #fff;
        box-shadow: 0 4px 12px rgba(232, 106, 51, 0.25);
      }
      .seat-visual-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
        gap: 8px;
        max-height: 216px;
        overflow-y: auto;
        padding: 10px;
        border-radius: 12px;
        border: 1px solid var(--border, rgba(120, 113, 108, 0.2));
        background: var(--surface-muted, rgba(120, 113, 108, 0.04));
      }
      .seat-chip {
        appearance: none;
        border: 1px solid var(--border, rgba(120, 113, 108, 0.22));
        background: var(--surface, #fff);
        color: var(--text, inherit);
        border-radius: 10px;
        padding: 7px 6px;
        text-align: center;
        cursor: pointer;
        transition: all 0.14s ease;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      [data-theme="dark"] .seat-chip {
        background: rgba(255, 255, 255, 0.04);
      }
      .seat-chip-code {
        font-family: "JetBrains Mono", monospace;
        font-size: 12.5px;
        font-weight: 700;
      }
      .seat-chip-tag {
        font-size: 10.5px;
        opacity: 0.72;
      }
      .seat-chip.selected-primary {
        border-color: #E86A33;
        background: rgba(232, 106, 51, 0.14);
        color: #E86A33;
      }
      .seat-chip.selected-backup {
        border-color: #10B981;
        background: rgba(16, 185, 129, 0.12);
        color: #10B981;
      }
      .pickup-station-group {
        border: 1px solid var(--border, rgba(120, 113, 108, 0.22));
        border-radius: 14px;
        padding: 16px;
        background: var(--surface-muted, rgba(120, 113, 108, 0.04));
      }
      .pickup-code-card {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        border-radius: 12px;
        background: var(--surface, #fff);
        border: 1px solid var(--border, rgba(120, 113, 108, 0.18));
      }
      [data-theme="dark"] .pickup-code-card {
        background: rgba(255, 255, 255, 0.04);
      }
      .pickup-code-number {
        font-family: "JetBrains Mono", monospace;
        font-size: 22px;
        font-weight: 800;
        letter-spacing: 0.5px;
        color: #E86A33;
      }
    </style>
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
            <p class="text-xs text-muted" style="margin: 0;">可视化点选自习区域与座位号，到点自动占座，预约成功仅消耗 0.1 🍑，失败不扣费。</p>
          </div>
          <div class="card card-flat" style="padding: 1rem;">
            <div class="text-sm font-semibold" style="margin-bottom: 0.25rem;">📦 快递取件码汇总</div>
            <p class="text-xs text-muted" style="margin: 0;">支持手机号绑定小米智能助理或粘贴取件短信，按驿站汇总展示大字号取件码。</p>
          </div>
        </div>
      </main>
      <footer class="auth-footer">
        <span>🍑 XPeach Account Center · 日在校园</span>
        <span>·</span>
        <a href="https://sso.xpeach.codes/portal">XPeach 主站</a>
        <span>·</span>
        <a href="https://github.com/yellowpeachxgp/day-in-school/releases/latest" target="_blank" rel="noopener">Android 客户端下载</a>
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

function groupParcelsByStation(parcels) {
  const map = new Map();
  for (const p of parcels) {
    const station = cleanDisplayText(p.station_name, "校内菜鸟驿站");
    if (!map.has(station)) map.set(station, []);
    map.get(station).push(p);
  }
  return Array.from(map.entries());
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
  const isAdmin =
    roles.includes("ADMIN") ||
    roles.includes("OPERATOR") ||
    roles.includes("FINANCE") ||
    user.role === "admin";
  const activeNav = ctx.activeNav || "portal";

  const bindings = Array.isArray(ctx.bindings) ? ctx.bindings.filter((b) => !b.revoked_at) : [];
  const activeStudentNo = bindings[0]?.student_no || bindings[0]?.student_no_masked || "";
  const plans = Array.isArray(ctx.plans) ? ctx.plans : [];
  const jobs = Array.isArray(ctx.jobs) ? ctx.jobs : [];
  const parcels = (Array.isArray(ctx.parcels) ? ctx.parcels : []).map((p) => {
    const cleanCode = cleanDisplayText(p?.pickup_code, "");
    const cleanStation = cleanDisplayText(p?.station_name, "");
    const cleanTitle = cleanDisplayText(p?.item_title, "");
    const cleanCarrier = cleanDisplayText(p?.carrier_name, "") || cleanDisplayText(p?.carrier_code, "") || "校园快递";
    return {
      ...p,
      pickup_code: cleanCode || null,
      station_name: cleanStation || null,
      item_title: cleanTitle || null,
      carrier_name: cleanCarrier
    };
  });
  const orders = Array.isArray(ctx.orders) ? ctx.orders : [];
  const activePlans = plans.filter((p) => p.enabled !== false);
  const readyParcels = parcels.filter(
    (p) => p.status !== "PICKED_UP" && (p.status === "READY_FOR_PICKUP" || Boolean(p.pickup_code))
  );
  const stationGroups = groupParcelsByStation(readyParcels);

  const accessToken = ctx.accessToken || "";

  const pageHeaderConfig = {
    portal: {
      title: "日在校园 · 个人通行证",
      subtitle: "与 XPeach 账户中心实时同步通用 🍑 余额，一站式查看待取快递与今日图书馆占座状态。"
    },
    reservations: {
      title: "📚 图书馆座位自动预约",
      subtitle: "点选楼层自习区与心仪座位号（支持首选 + 2 个备选），到点自动占座；成功仅扣 0.1 🍑，未成功不扣费。"
    },
    parcels: {
      title: "📦 我的快递与取件码",
      subtitle: "按校园驿站分组展示大字号取件码，支持粘贴取件短信智能提取，并与日在校园 App 双向同步。"
    },
    orders: {
      title: "🍑 消费与退还明细",
      subtitle: "所有消费直接以 XPeach 通用 🍑 结算，账单实时同步至 XPeach 主站。"
    },
    console: {
      title: "⚙️ 站点服务与 🍑 账单管理",
      subtitle: "管理学校图书馆服务开关、核对跨站 🍑 消费账单并处理一键退还。"
    }
  }[activeNav] || {
    title: "日在校园 · 个人通行证",
    subtitle: "与 XPeach 账户中心实时同步通用 🍑 余额。"
  };

  function renderIdentityPassSection() {
    return `
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
                通行证 ID: <code>${escapeHtml(user.subject)}</code>
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

      <section class="bento-grid bento-4" aria-label="通行证指标">
        <div class="stat">
          <div class="stat-label">通用 🍑 余额</div>
          <div class="stat-value" id="stat-peach-balance">🍑 ${escapeHtml(peachBalanceFormatted)}</div>
          <div class="stat-hint">已用 🍑 ${escapeHtml(peachUsedFormatted)}</div>
        </div>
        <div class="stat">
          <div class="stat-label">已绑定校园学号</div>
          <div class="stat-value" id="stat-bindings-count">${bindings.length > 0 ? "已绑定" : "未绑定"}</div>
          <div class="stat-hint">${activeStudentNo ? `学号：${escapeHtml(activeStudentNo)}` : "前往抢座页面即可绑定"}</div>
        </div>
        <div class="stat">
          <div class="stat-label">进行中占座预约</div>
          <div class="stat-value" id="stat-plans-count">${activePlans.length}</div>
          <div class="stat-hint">成功占座仅消耗 0.1 🍑</div>
        </div>
        <div class="stat">
          <div class="stat-label">待取快递包裹</div>
          <div class="stat-value" id="stat-parcels-count">${readyParcels.length}</div>
          <div class="stat-hint">共记录 ${parcels.length} 件快递</div>
        </div>
      </section>`;
  }

  function renderPortalView() {
    const activeJobs = jobs.filter((j) => !["CANCELLED", "FAILED", "EXPIRED"].includes(j.state));
    return `
      ${renderIdentityPassSection()}

      <div class="grid gap-4" style="grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));">
        <!-- 待取快递动态提醒卡 -->
        <section class="panel" style="margin: 0;">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">📦 待取快递提醒</h2>
              <p class="panel-subtitle">${
                readyParcels.length > 0
                  ? `您有 ${readyParcels.length} 件包裹已到达校园驿站，请凭取件码领取`
                  : "当前没有待取快递，粘贴取件短信或在 App 绑定手机号即可自动同步"
              }</p>
            </div>
            <a class="btn btn-secondary btn-sm" href="/parcels">管理快递 →</a>
          </div>
          ${
            stationGroups.length === 0
              ? `<div class="card card-flat" style="padding: 16px;">
                  <div class="text-sm font-semibold" style="margin-bottom: 4px;">暂无待取包裹</div>
                  <p class="text-xs text-muted" style="margin: 0 0 12px;">收到菜鸟驿站或丰巢短信后，可在「我的快递与取件码」页面一键识别，或在日在校园 Android 客户端绑定小米智能助理自动拉取。</p>
                  <a class="btn btn-primary btn-sm" href="/parcels">录入取件码</a>
                </div>`
              : `<div class="stack gap-3">
                  ${stationGroups
                    .map(
                      ([station, list]) => `
                    <div class="pickup-station-group">
                      <div class="cluster" style="justify-content: space-between; margin-bottom: 10px;">
                        <span class="text-sm font-semibold">📍 ${escapeHtml(station)}</span>
                        <span class="badge badge-primary">${list.length} 件待取</span>
                      </div>
                      <div class="stack gap-2">
                        ${list
                          .slice(0, 3)
                          .map(
                            (p) => `
                          <div class="pickup-code-card">
                            <div>
                              <div class="pickup-code-number">${escapeHtml(p.pickup_code || "待出码")}</div>
                              <div class="text-xs text-muted">${escapeHtml(p.carrier_name || p.carrier_code || "校园快递")} · ${escapeHtml(p.item_title || p.tracking_number)}</div>
                            </div>
                            <button type="button" class="btn btn-secondary btn-sm" data-pickup-parcel="${escapeHtml(p.id)}">✓ 已取件</button>
                          </div>`
                          )
                          .join("")}
                      </div>
                    </div>`
                    )
                    .join("")}
                </div>`
          }
        </section>

        <!-- 今日图书馆占座与预约状态卡 -->
        <section class="panel" style="margin: 0;">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">💺 图书馆占座动态</h2>
              <p class="panel-subtitle">${
                activeJobs.length > 0
                  ? `当前共有 ${activeJobs.length} 项有效预约或进行中抢座任务`
                  : "提前选好自习室与座位号，明早 07:00 自动为您抢座"
              }</p>
            </div>
            <a class="btn btn-primary btn-sm" href="/reservations">去选座预约 →</a>
          </div>
          ${
            activeJobs.length === 0
              ? `<div class="card card-flat" style="padding: 16px;">
                  <div class="text-sm font-semibold" style="margin-bottom: 4px;">暂未设置今日/明日抢座计划</div>
                  <p class="text-xs text-muted" style="margin: 0 0 12px;">支持河南工业大学莲花街校区图书馆全部楼层区域列表点选，首选座位被占时毫秒级自动切换备选座位。</p>
                  <a class="btn btn-secondary btn-sm" href="/reservations">立即配置自动抢座</a>
                </div>`
              : `<div class="stack gap-2">
                  ${activeJobs
                    .slice(0, 4)
                    .map((j) => {
                      const p = plans.find((x) => x.id === j.plan_id) || {};
                      const seats = Array.isArray(p.candidate_seats) ? p.candidate_seats.join(" / ") : "4N-001";
                      const repDays = Number(p.repeat_days || j.repeat_days || 1);
                      const remDays = Number(p.remaining_days ?? j.remaining_days ?? repDays);
                      const repeatBadge =
                        repDays > 1
                          ? `<span class="badge badge-primary">连续 ${repDays} 天 (剩 ${remDays} 天)</span>`
                          : "";
                      const badge =
                        j.state === "CONFIRMED"
                          ? '<span class="badge badge-success">已占座成功</span>'
                          : '<span class="badge badge-primary">等待到点开抢</span>';
                      return `<div class="pickup-code-card">
                        <div>
                          <div class="text-sm font-semibold">${escapeHtml(p.area_name || "4楼北自习区")} · <code>${escapeHtml(seats)}</code></div>
                          <div class="text-xs text-muted">日期：${escapeHtml(j.booking_local_date || p.target_local_date || "-")} · 时段：${escapeHtml(p.slot_window || "08:00-22:00")}</div>
                        </div>
                        <div class="cluster">
                          ${repeatBadge}
                          ${badge}
                          ${
                            j.state !== "CONFIRMED"
                              ? `<button type="button" class="btn btn-ghost btn-sm" data-cancel-job="${escapeHtml(j.id)}">取消</button>`
                              : ""
                          }
                        </div>
                      </div>`;
                    })
                    .join("")}
                </div>`
          }
        </section>
      </div>`;
  }

  function renderReservationsView() {
    return `
      <section class="panel" id="section-reservations">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">📚 图书馆座位自动预约</h2>
            <p class="panel-subtitle">第一步绑定您的学号，第二步点选楼层区域与座位号即可，无需手写任何复杂代码。</p>
          </div>
          <span class="badge badge-primary">0.1 🍑 / 次（仅占座成功扣费 · 余额 🍑 ${escapeHtml(peachBalanceFormatted)}）</span>
        </div>

        <div class="grid gap-4" style="grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));">
          <!-- Step 1: 绑定校园学号 -->
          <div class="card card-flat" style="padding: 18px;">
            <div class="cluster" style="justify-content: space-between; margin-bottom: 6px;">
              <h3 class="text-sm font-semibold" style="margin: 0;">第一步：绑定校园学号</h3>
              ${
                activeStudentNo
                  ? `<span class="badge badge-success">已绑定 ${escapeHtml(activeStudentNo)}</span>`
                  : `<span class="badge badge-warning">待绑定</span>`
              }
            </div>
            <p class="text-xs text-muted" style="margin: 0 0 14px;">绑定您的学校与学号，用于自动登录图书馆预约系统并同步至日在校园 App。</p>
            <div class="stack gap-3">
              <div class="field">
                <label class="label" for="bind-school">所属学校</label>
                <select class="input" id="bind-school">
                  <option value="haut">河南工业大学（莲花街校区图书馆）</option>
                </select>
              </div>
              <div class="field">
                <label class="label" for="bind-student-no">校园学号</label>
                <input class="input" id="bind-student-no" type="text" placeholder="请输入 12 位学号，例如 241210400802" value="${escapeHtml(activeStudentNo)}" />
              </div>
              <div class="field">
                <label class="label" for="bind-secret">图书馆 / 统一认证密码</label>
                <input class="input" id="bind-secret" type="password" placeholder="请输入登录密码（加密托管，仅用于自动抢座）" />
              </div>
              <button type="button" class="btn btn-primary btn-block" id="btn-save-binding">
                ${activeStudentNo ? "更新绑定学号与密码" : "保存并绑定学号"}
              </button>
            </div>
            <div id="binding-list-box" style="margin-top: 12px;" class="text-xs text-muted">
              ${
                activeStudentNo
                  ? `当前生效学号：<strong>${escapeHtml(activeStudentNo)}</strong>（河南工业大学 · 与 App 实时互通）`
                  : "暂未绑定学号，请先填写上方学号完成绑定。"
              }
            </div>
          </div>

          <!-- Step 2: 选择自习区域与下属座位号 -->
          <div class="card card-flat" style="padding: 18px;">
            <div class="cluster" style="justify-content: space-between; margin-bottom: 6px;">
              <h3 class="text-sm font-semibold" style="margin: 0;">第二步：点选自习区域与座位号</h3>
              <span class="badge badge-success" id="live-region-badge" style="display:none;">已连接河工大图书馆实时座位</span>
            </div>
            <p class="text-xs text-muted" style="margin: 0 0 10px;">点击下方楼层标签或在列表中切换区域，直接点击座位卡片即可设为首选/备选座位。</p>

            <div class="area-pills" id="area-pills-bar">
              <button type="button" class="area-pill active" data-area-pill="4F_NORTH">4楼北自习区</button>
              <button type="button" class="area-pill" data-area-pill="2F_EAST">2楼东阅览区</button>
              <button type="button" class="area-pill" data-area-pill="3F_WEST">3楼西电子区</button>
              <button type="button" class="area-pill" data-area-pill="5F_SOUTH">5楼南考研区</button>
              <button type="button" class="area-pill" data-area-pill="6F_MAIN">6楼综合自习室</button>
            </div>

            <div class="stack gap-3">
              <div class="field">
                <label class="label" for="plan-area">1. 当前自习区域</label>
                <select class="input" id="plan-area">
                  <option value="4F_NORTH">4楼北自习区（安静自习 · 靠窗带插座）</option>
                  <option value="2F_EAST">2楼东报刊阅览区（采光好 · 临窗座位）</option>
                  <option value="3F_WEST">3楼西电子阅览区（桌面宽敞 · 全排插）</option>
                  <option value="5F_SOUTH">5楼南考研专区（独立隔板 · 静音区）</option>
                  <option value="6F_MAIN">6楼综合自习室（开放式大桌 · 空调充足）</option>
                </select>
              </div>

              <div class="field">
                <div class="cluster" style="justify-content: space-between; margin-bottom: 4px;">
                  <label class="label" style="margin: 0;">2. 点击座位卡片快速选座（橙色=首选，绿色=备选）</label>
                  <span class="text-xs text-muted" id="seat-selection-summary">已选：4N-001 / 4N-002 / 4N-003</span>
                </div>
                <div class="seat-visual-grid" id="seat-visual-grid"></div>
              </div>

              <div class="grid gap-3" style="grid-template-columns: 1fr 1fr 1fr;">
                <div class="field">
                  <label class="label" for="plan-seat-1">首选座位</label>
                  <select class="input" id="plan-seat-1"></select>
                </div>
                <div class="field">
                  <label class="label" for="plan-seat-2">备选座位 1</label>
                  <select class="input" id="plan-seat-2"></select>
                </div>
                <div class="field">
                  <label class="label" for="plan-seat-3">备选座位 2</label>
                  <select class="input" id="plan-seat-3"></select>
                </div>
              </div>

              <div class="grid gap-3" style="grid-template-columns: 1fr 1fr 1fr;">
                <div class="field">
                  <label class="label" for="plan-date">预约开始日期</label>
                  <input class="input" id="plan-date" type="date" />
                </div>
                <div class="field">
                  <label class="label" for="plan-time">自动开抢时间</label>
                  <select class="input" id="plan-time">
                    <option value="07:00:00">07:00（早间准点开抢）</option>
                    <option value="07:30:00">07:30（早间场次）</option>
                    <option value="08:00:00">08:00（上午场次）</option>
                    <option value="12:30:00">12:30（午间场次）</option>
                    <option value="14:00:00">14:00（下午场次）</option>
                    <option value="18:00:00">18:00（晚间场次）</option>
                    <option value="21:00:00">21:00（夜间预约次日）</option>
                  </select>
                </div>
                <div class="field">
                  <label class="label" for="plan-repeat-days">连续自动抢座周期</label>
                  <select class="input" id="plan-repeat-days">
                    <option value="1">仅抢 1 天（单次）</option>
                    <option value="3">连续 3 天自动抢座</option>
                    <option value="7">连续 7 天（一整周每天早间自动抢）</option>
                    <option value="14">连续 14 天（两周自动续期）</option>
                    <option value="30">连续 30 天（整月自动续期）</option>
                  </select>
                </div>
              </div>
              <div class="field">
                <label class="label" for="plan-slot">自习用座时段</label>
                <select class="input" id="plan-slot">
                  <option value="08:00-22:00">08:00 - 22:00（全天沉浸自习）</option>
                  <option value="08:00-12:00">08:00 - 12:00（上午时段）</option>
                  <option value="14:00-18:00">14:00 - 18:00（下午时段）</option>
                  <option value="18:30-22:00">18:30 - 22:00（晚间时段）</option>
                </select>
              </div>
              <div class="cluster">
                <button type="button" class="btn btn-primary" style="flex:1;" id="btn-create-plan">保存自动抢座计划</button>
                <button type="button" class="btn btn-secondary" id="btn-fire-now">立即预约所选座位</button>
              </div>
            </div>
          </div>
        </div>

        <div class="divider"></div>

        <h3 class="text-sm font-semibold" style="margin: 0 0 10px;">我的预约与抢座记录</h3>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>用座日期与开抢时间</th>
                <th>自习区域与候选座位</th>
                <th>用座时段 / 连续周期</th>
                <th>当前状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="jobs-tbody">
              ${
                jobs.length === 0
                  ? `<tr><td colspan="5" class="text-muted">暂无预约记录，在上方选择自习区域与座位号即可创建。</td></tr>`
                  : jobs
                      .map((j) => {
                        const p = plans.find((x) => x.id === j.plan_id) || {};
                        const seats = Array.isArray(p.candidate_seats) ? p.candidate_seats.join(" / ") : "自动分配";
                        const repDays = Number(p.repeat_days || j.repeat_days || 1);
                        const remDays = Number(p.remaining_days ?? j.remaining_days ?? repDays);
                        const repeatInfo =
                          repDays > 1
                            ? ` · <span class="badge badge-primary">连续 ${repDays} 天 (剩 ${remDays} 天)</span>`
                            : " · 单日";
                        const stateLabel =
                          j.state === "CONFIRMED"
                            ? '<span class="badge badge-success">已占座成功 (扣除 0.1 🍑)</span>'
                            : j.state === "CANCELLED"
                              ? '<span class="badge">已取消 (未扣费)</span>'
                              : j.state === "FAILED"
                                ? '<span class="badge badge-danger">未抢到座位 (未扣费)</span>'
                                : j.state === "EXPIRED"
                                  ? '<span class="badge badge-danger">已过开抢时间窗 (未扣费)</span>'
                                  : '<span class="badge badge-primary">已就绪 · 等待到点开抢</span>';
                        return `<tr>
                          <td>${escapeHtml(j.booking_local_date || p.target_local_date || "-")} ${escapeHtml(p.target_local_time || j.target_local_time || "07:00:00")}</td>
                          <td><strong>${escapeHtml(p.area_name || p.area_code || "4楼北自习区")}</strong> · <code>${escapeHtml(seats)}</code></td>
                          <td>${escapeHtml(p.slot_window || "08:00-22:00")}${repeatInfo}</td>
                          <td>${stateLabel}</td>
                          <td>${
                            j.state === "CONFIRMED"
                              ? `<button type="button" class="btn btn-secondary btn-sm" data-cancel-seat-job="${escapeHtml(j.id)}">退座释放</button>`
                              : !["CONFIRMED", "FAILED", "CANCELLED"].includes(j.state)
                                ? `<div class="cluster"><button type="button" class="btn btn-primary btn-sm" data-execute-now-job="${escapeHtml(j.id)}">⚡ 立即抢一次</button><button type="button" class="btn btn-ghost btn-sm" data-cancel-job="${escapeHtml(j.id)}">取消预约</button></div>`
                                : "-"
                          }</td>
                        </tr>`;
                      })
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </section>`;
  }

  function renderParcelsView() {
    return `
      <section class="panel" id="section-parcels">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">📦 我的快递与取件码</h2>
            <p class="panel-subtitle">粘贴菜鸟驿站/丰巢取件短信自动识别取件码与驿站位置，所有包裹与日在校园 Android 客户端实时同步。</p>
          </div>
          <span class="badge badge-primary">${readyParcels.length} 件待取件</span>
        </div>

        <!-- 短信智能粘贴识别框 -->
        <div class="card card-flat" style="padding: 16px; margin-bottom: 18px;">
          <div class="grid gap-3" style="grid-template-columns: 2fr 1fr auto; align-items: end;">
            <div class="field">
              <label class="label" for="parcel-sms">粘贴取件短信（实时识别取件码与校园驿站）</label>
              <input class="input" id="parcel-sms" type="text" placeholder="例如：【菜鸟驿站】您的包裹已到莲花街北苑菜鸟驿站，请凭取件码 3-2-1048 领取" />
            </div>
            <div class="field">
              <label class="label" for="parcel-tracking">运单号（选填，不填自动生成）</label>
              <input class="input" id="parcel-tracking" type="text" placeholder="例如 SF15283910293" />
            </div>
            <button type="button" class="btn btn-primary" id="btn-add-parcel">识别并保存取件码</button>
          </div>
          <div id="sms-preview-chip" class="text-xs text-muted" style="margin-top: 8px;">
            💡 提示：在「日在校园」App 中可通过手机号一键绑定小米智能助理，全自动同步您的所有校园快递与取件码。
          </div>
        </div>

        <!-- 按驿站分组的大字号取件码卡片 -->
        ${
          stationGroups.length > 0
            ? `<div class="grid gap-3" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); margin-bottom: 20px;">
                ${stationGroups
                  .map(
                    ([station, list]) => `
                  <div class="pickup-station-group">
                    <div class="cluster" style="justify-content: space-between; margin-bottom: 10px;">
                      <span class="text-sm font-semibold">📍 ${escapeHtml(station)}</span>
                      <span class="badge badge-primary">${list.length} 件待取</span>
                    </div>
                    <div class="stack gap-2">
                      ${list
                        .map(
                          (p) => `
                        <div class="pickup-code-card">
                          <div>
                            <div class="pickup-code-number">${escapeHtml(p.pickup_code || "待出码")}</div>
                            <div class="text-xs text-muted">${escapeHtml(p.carrier_name || p.carrier_code || "校园快递")} · <code>${escapeHtml(p.tracking_number)}</code></div>
                          </div>
                          <button type="button" class="btn btn-primary btn-sm" data-pickup-parcel="${escapeHtml(p.id)}">✓ 我已取件</button>
                        </div>`
                        )
                        .join("")}
                    </div>
                  </div>`
                  )
                  .join("")}
              </div>`
            : ""
        }

        <h3 class="text-sm font-semibold" style="margin: 0 0 10px;">全部快递记录</h3>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>快递品牌与单号</th>
                <th>取件码</th>
                <th>校园驿站</th>
                <th>当前状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="parcels-tbody">
              ${
                parcels.length === 0
                  ? `<tr><td colspan="5" class="text-muted">暂无快递记录，可在上方粘贴取件短信或在日在校园 App 中绑定手机号自动同步。</td></tr>`
                  : parcels
                      .map((p) => {
                        const codeDisplay = p.pickup_code
                          ? p.pickup_code
                          : p.status === "PICKED_UP"
                            ? "已签收"
                            : "待出码";
                        const statusBadge =
                          p.status === "PICKED_UP"
                            ? '<span class="badge">已取件</span>'
                            : p.pickup_code || p.status === "READY_FOR_PICKUP"
                              ? '<span class="badge badge-success">待取件</span>'
                              : '<span class="badge badge-primary">运输派送中</span>';
                        return `<tr>
                          <td><strong>${escapeHtml(p.carrier_name || p.carrier_code || "校园快递")}</strong> · <code>${escapeHtml(p.tracking_number)}</code></td>
                          <td><code style="font-size: 14px; font-weight: 700; color: #E86A33;">${escapeHtml(codeDisplay)}</code></td>
                          <td>${escapeHtml(p.station_name || "校内菜鸟驿站")}</td>
                          <td>${statusBadge}</td>
                          <td>${
                            p.status !== "PICKED_UP"
                              ? `<button type="button" class="btn btn-ghost btn-sm" data-pickup-parcel="${escapeHtml(p.id)}">标记已取</button>`
                              : "-"
                          }</td>
                        </tr>`;
                      })
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </section>`;
  }

  function renderOrdersView() {
    return `
      ${renderIdentityPassSection()}
      <section class="panel" id="section-orders">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">🍑 消费与退还明细</h2>
            <p class="panel-subtitle">所有消费直接以 XPeach 通用 🍑 结算并实时同步至 XPeach 主站，预约未成功或取消不扣取任何 🍑。</p>
          </div>
          <a class="btn btn-secondary btn-sm" href="https://sso.xpeach.codes/portal">前往 XPeach 主站查看总账单 →</a>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>账单编号</th>
                <th>服务项目</th>
                <th>🍑 数量</th>
                <th>结算状态</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody id="orders-tbody">
              ${
                orders.length === 0
                  ? `<tr><td colspan="5" class="text-muted">暂无 🍑 消费记录（仅在图书馆自动占座核验成功后扣除 0.1 🍑）。</td></tr>`
                  : orders
                      .map((o) => {
                        const peachAmt = Number(o.price_peach ?? (o.price_micropeach || 1000) / 10000).toFixed(2);
                        const stBadge =
                          o.payment_state === "PAID"
                            ? '<span class="badge badge-success">已从 XPeach 扣除</span>'
                            : o.payment_state === "REFUNDED"
                              ? '<span class="badge">已退还 🍑 至 XPeach</span>'
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
      </section>`;
  }

  function renderAdminConsoleView() {
    const stats = ctx.adminStats || {
      users_count: 1,
      active_bindings_count: bindings.length,
      jobs_count: jobs.length,
      orders_count: orders.length,
      parcels_count: parcels.length,
      audit_events_count: 0
    };
    const allOrders = Array.isArray(ctx.allOrders) ? ctx.allOrders : orders;
    const schools = Array.isArray(ctx.schools) ? ctx.schools : [];
    const auditEvents = Array.isArray(ctx.auditEvents) ? ctx.auditEvents : [];
    const campusContent = ctx.campusContent || {
      version: 1,
      updated_at: "",
      bulletin: {
        enabled: true,
        title: "河工大社团纳新与校园频道云端直通车",
        content: "全校学生社团招新 QQ 群与校园互助频道已接入云端实时下发。",
        tag: "云端实时同步"
      },
      channels: [],
      clubs: []
    };
    const ccBulletin = campusContent.bulletin || {};
    const ccChannels = Array.isArray(campusContent.channels) ? campusContent.channels : [];
    const ccClubs = Array.isArray(campusContent.clubs) ? campusContent.clubs : [];

    return `
      <section class="bento-grid bento-4" aria-label="站点运行指标">
        <div class="stat">
          <div class="stat-label">已接入 XPeach 用户</div>
          <div class="stat-value">${stats.users_count}</div>
          <div class="stat-hint">已绑定学号：${stats.active_bindings_count} 人</div>
        </div>
        <div class="stat">
          <div class="stat-label">累计占座预约任务</div>
          <div class="stat-value">${stats.jobs_count}</div>
          <div class="stat-hint">自动三段式准点调度</div>
        </div>
        <div class="stat">
          <div class="stat-label">累计 🍑 结算账单</div>
          <div class="stat-value">${stats.orders_count}</div>
          <div class="stat-hint">实时上报 XPeach 主站账本</div>
        </div>
        <div class="stat">
          <div class="stat-label">全站同步快递包裹</div>
          <div class="stat-value">${stats.parcels_count}</div>
          <div class="stat-hint">安全审计记录：${stats.audit_events_count} 条</div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">🏫 学校图书馆服务状态管理</h2>
            <p class="panel-subtitle">当学校图书馆系统临时维护时，可在此一键开启/恢复预约保护开关。</p>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>学校名称</th>
                <th>服务模块</th>
                <th>当前状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${schools
                .map(
                  (s) => `<tr>
                    <td><strong>${escapeHtml(s.display_name)}</strong></td>
                    <td>莲花街校区图书馆选座系统</td>
                    <td>${
                      s.kill_switch
                        ? '<span class="badge badge-danger">维护暂停中</span>'
                        : '<span class="badge badge-success">运行正常</span>'
                    }</td>
                    <td>
                      <button type="button" class="btn btn-secondary btn-sm" data-toggle-kill="${escapeHtml(s.school_id)}" data-current-kill="${s.kill_switch ? "true" : "false"}">
                        ${s.kill_switch ? "恢复预约服务" : "暂停预约服务"}
                      </button>
                    </td>
                  </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel" id="section-campus-content-admin">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">📢 校园频道与学生社团云控中心 (实时热更新)</h2>
            <p class="panel-subtitle">在后台动态新增、置顶、隐藏或修改校园 QQ 频道与学生社团群号，保存后所有「日在校园」App 客户端实时生效（当前云控版本：v${escapeHtml(String(campusContent.version || 1))}）。</p>
          </div>
          <span class="badge badge-success">云原生实时下发 · ${ccChannels.length} 频道 / ${ccClubs.length} 社团</span>
        </div>

        <!-- 1. 顶部社区横幅公告云控 -->
        <div class="card card-flat" style="padding: 16px; margin-bottom: 16px;">
          <div class="cluster" style="justify-content: space-between; margin-bottom: 10px;">
            <h3 class="text-sm font-semibold" style="margin: 0;">1. 社区顶部横幅公告 (App 社团与频道页置顶展示)</h3>
            <span class="badge badge-primary">${ccBulletin.enabled !== false ? "当前已展示" : "当前已隐藏"}</span>
          </div>
          <div class="grid gap-3" style="grid-template-columns: 2fr 1fr 1fr;">
            <div class="field">
              <label class="label" for="cc-bulletin-title">公告标题</label>
              <input class="input" id="cc-bulletin-title" type="text" value="${escapeHtml(ccBulletin.title || "")}" placeholder="例如：2026 秋季社团百团大战招新开启" />
            </div>
            <div class="field">
              <label class="label" for="cc-bulletin-tag">角标标签</label>
              <input class="input" id="cc-bulletin-tag" type="text" value="${escapeHtml(ccBulletin.tag || "云端实时同步")}" />
            </div>
            <div class="field">
              <label class="label" for="cc-bulletin-enabled">展示状态</label>
              <select class="input" id="cc-bulletin-enabled">
                <option value="true" ${ccBulletin.enabled !== false ? "selected" : ""}>启用展示</option>
                <option value="false" ${ccBulletin.enabled === false ? "selected" : ""}>隐藏横幅</option>
              </select>
            </div>
          </div>
          <div class="field" style="margin-top: 10px;">
            <label class="label" for="cc-bulletin-content">公告正文</label>
            <input class="input" id="cc-bulletin-content" type="text" value="${escapeHtml(ccBulletin.content || "")}" placeholder="输入向全校学生展示的引导说明文案" />
          </div>
          <div style="margin-top: 10px;">
            <button type="button" class="btn btn-primary btn-sm" id="btn-save-bulletin">保存并下发横幅公告</button>
          </div>
        </div>

        <!-- 2. 校园频道云控管理 -->
        <div class="card card-flat" style="padding: 16px; margin-bottom: 16px;">
          <div class="cluster" style="justify-content: space-between; margin-bottom: 10px;">
            <h3 class="text-sm font-semibold" style="margin: 0;">2. 校园频道云控列表 (${ccChannels.length} 个频道)</h3>
          </div>
          <div class="table-wrap" style="margin-bottom: 14px;">
            <table class="table">
              <thead>
                <tr>
                  <th>排序 / 状态</th>
                  <th>频道名称 & 标签</th>
                  <th>副标题描述</th>
                  <th>跳转链接 (invite_url)</th>
                  <th>云控操作</th>
                </tr>
              </thead>
              <tbody>
                ${
                  ccChannels.length === 0
                    ? `<tr><td colspan="5" class="text-muted">暂无校园频道配置</td></tr>`
                    : ccChannels
                        .map(
                          (ch) => `<tr>
                            <td>
                              <code>#${escapeHtml(String(ch.sort_order ?? 100))}</code>
                              ${ch.pinned ? '<span class="badge badge-primary">置顶</span>' : ""}
                              ${
                                ch.enabled !== false
                                  ? '<span class="badge badge-success">启用</span>'
                                  : '<span class="badge badge-danger">已隐藏</span>'
                              }
                            </td>
                            <td><strong>${escapeHtml(ch.title)}</strong> <span class="badge">${escapeHtml(ch.tag_label || "频道")}</span><div class="text-xs text-muted"><code>${escapeHtml(ch.id)}</code></div></td>
                            <td>${escapeHtml(ch.subtitle || "-")}</td>
                            <td><code>${escapeHtml(ch.invite_url || "-")}</code></td>
                            <td>
                              <div class="cluster">
                                <button type="button" class="btn btn-secondary btn-sm" data-edit-channel='${escapeHtml(JSON.stringify(ch))}'>编辑</button>
                                <button type="button" class="btn btn-ghost btn-sm" data-toggle-pin-channel='${escapeHtml(JSON.stringify(ch))}'>${ch.pinned ? "取消置顶" : "置顶"}</button>
                                <button type="button" class="btn btn-ghost btn-sm" data-toggle-enable-channel='${escapeHtml(JSON.stringify(ch))}'>${ch.enabled !== false ? "隐藏" : "启用"}</button>
                                <button type="button" class="btn btn-ghost btn-sm" data-delete-channel="${escapeHtml(ch.id)}">删除</button>
                              </div>
                            </td>
                          </tr>`
                        )
                        .join("")
                }
              </tbody>
            </table>
          </div>
          <div class="grid gap-3" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));">
            <div class="field">
              <label class="label" for="cc-ch-id">频道 ID (编辑自动填入，留空自动生成)</label>
              <input class="input" id="cc-ch-id" type="text" placeholder="如 ch_official_main" />
            </div>
            <div class="field">
              <label class="label" for="cc-ch-title">频道名称</label>
              <input class="input" id="cc-ch-title" type="text" placeholder="如 工大主频道" />
            </div>
            <div class="field">
              <label class="label" for="cc-ch-tag">分类标签</label>
              <input class="input" id="cc-ch-tag" type="text" placeholder="如 主频道 / 新生 / 学习" />
            </div>
            <div class="field">
              <label class="label" for="cc-ch-url">频道邀请链接</label>
              <input class="input" id="cc-ch-url" type="text" placeholder="https://pd.qq.com/s/..." />
            </div>
            <div class="field">
              <label class="label" for="cc-ch-subtitle">副标题简介</label>
              <input class="input" id="cc-ch-subtitle" type="text" placeholder="版本更新 · 校园消息 · 答疑" />
            </div>
            <div class="field">
              <label class="label" for="cc-ch-sort">排序权重 (越小越靠前)</label>
              <input class="input" id="cc-ch-sort" type="number" value="10" />
            </div>
          </div>
          <div class="cluster" style="margin-top: 10px;">
            <button type="button" class="btn btn-primary btn-sm" id="btn-save-channel">新增 / 更新校园频道</button>
          </div>
        </div>

        <!-- 3. 学生社团云控管理 -->
        <div class="card card-flat" style="padding: 16px;">
          <div class="cluster" style="justify-content: space-between; margin-bottom: 10px;">
            <h3 class="text-sm font-semibold" style="margin: 0;">3. 学生社团名录云控管理 (${ccClubs.length} 个社团)</h3>
          </div>
          <div class="table-wrap" style="margin-bottom: 14px; max-height: 420px; overflow-y: auto;">
            <table class="table">
              <thead>
                <tr>
                  <th>排序 / 状态</th>
                  <th>社团名称 & 分类</th>
                  <th>指导单位 & 活动场地</th>
                  <th>纳新 QQ 群号</th>
                  <th>云控操作</th>
                </tr>
              </thead>
              <tbody>
                ${
                  ccClubs.length === 0
                    ? `<tr><td colspan="5" class="text-muted">暂无学生社团配置</td></tr>`
                    : ccClubs
                        .map(
                          (cl) => `<tr>
                            <td>
                              <code>#${escapeHtml(String(cl.sort_order ?? 100))}</code>
                              ${cl.pinned ? '<span class="badge badge-primary">置顶</span>' : ""}
                              ${
                                cl.enabled !== false
                                  ? '<span class="badge badge-success">启用</span>'
                                  : '<span class="badge badge-danger">已隐藏</span>'
                              }
                            </td>
                            <td><strong>${escapeHtml(cl.name)}</strong> <span class="badge">${escapeHtml(cl.category_label || cl.category)}</span><div class="text-xs text-muted">${escapeHtml((cl.highlights || []).join(" · "))}</div></td>
                            <td>${escapeHtml(cl.affiliated_unit || "-")} · ${escapeHtml(cl.activity_venue || "-")}</td>
                            <td><code>${escapeHtml(cl.qq_group_number || "-")}</code></td>
                            <td>
                              <div class="cluster">
                                <button type="button" class="btn btn-secondary btn-sm" data-edit-club='${escapeHtml(JSON.stringify(cl))}'>编辑/改群号</button>
                                <button type="button" class="btn btn-ghost btn-sm" data-toggle-pin-club='${escapeHtml(JSON.stringify(cl))}'>${cl.pinned ? "取消置顶" : "置顶"}</button>
                                <button type="button" class="btn btn-ghost btn-sm" data-toggle-enable-club='${escapeHtml(JSON.stringify(cl))}'>${cl.enabled !== false ? "隐藏" : "启用"}</button>
                                <button type="button" class="btn btn-ghost btn-sm" data-delete-club="${escapeHtml(cl.id)}">删除</button>
                              </div>
                            </td>
                          </tr>`
                        )
                        .join("")
                }
              </tbody>
            </table>
          </div>
          <div class="grid gap-3" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));">
            <div class="field">
              <label class="label" for="cc-club-id">社团 ID (编辑自动填入，留空自动生成)</label>
              <input class="input" id="cc-club-id" type="text" placeholder="如 club_acm" />
            </div>
            <div class="field">
              <label class="label" for="cc-club-name">社团名称</label>
              <input class="input" id="cc-club-name" type="text" placeholder="如 ACM 程序设计协会" />
            </div>
            <div class="field">
              <label class="label" for="cc-club-category">社团分类</label>
              <select class="input" id="cc-club-category">
                <option value="TECH_INNOVATION">科技创新</option>
                <option value="ACADEMIC_CULTURE">学术文化</option>
                <option value="ART_PERFORMANCE">文艺展演</option>
                <option value="SPORTS_FITNESS">体育竞技</option>
                <option value="VOLUNTEER_ORG">志愿与组织</option>
              </select>
            </div>
            <div class="field">
              <label class="label" for="cc-club-qq">纳新 QQ 群号</label>
              <input class="input" id="cc-club-qq" type="text" placeholder="如 784512903" />
            </div>
            <div class="field">
              <label class="label" for="cc-club-unit">挂靠/指导单位</label>
              <input class="input" id="cc-club-unit" type="text" placeholder="如 信息科学与工程学院" />
            </div>
            <div class="field">
              <label class="label" for="cc-club-venue">常规活动场地</label>
              <input class="input" id="cc-club-venue" type="text" placeholder="如 8号教学楼机房" />
            </div>
            <div class="field">
              <label class="label" for="cc-club-highlights">亮点标签 (逗号分隔)</label>
              <input class="input" id="cc-club-highlights" type="text" placeholder="如 蓝桥杯,ACM集训,算法入门" />
            </div>
            <div class="field">
              <label class="label" for="cc-club-sort">排序权重</label>
              <input class="input" id="cc-club-sort" type="number" value="50" />
            </div>
          </div>
          <div class="field" style="margin-top: 10px;">
            <label class="label" for="cc-club-summary">社团活动简介</label>
            <input class="input" id="cc-club-summary" type="text" placeholder="简要介绍社团主要活动与新人福利" />
          </div>
          <div class="cluster" style="margin-top: 10px;">
            <button type="button" class="btn btn-primary btn-sm" id="btn-save-club">新增 / 更新学生社团</button>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">🍑 全站消费账单对账与一键退还</h2>
            <p class="panel-subtitle">每一笔扣费与退还均通过幂等密钥实时同步至 XPeach 主站用户钱包与跨站财务大盘。</p>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>账单号</th>
                <th>所属用户</th>
                <th>消费 🍑</th>
                <th>状态</th>
                <th>结算时间</th>
                <th>管理员操作</th>
              </tr>
            </thead>
            <tbody>
              ${
                allOrders.length === 0
                  ? `<tr><td colspan="6" class="text-muted">暂无全站 🍑 消费账单记录。</td></tr>`
                  : allOrders
                      .map((o) => {
                        const peachAmt = Number(o.price_peach ?? (o.price_micropeach || 1000) / 10000).toFixed(2);
                        const stBadge =
                          o.payment_state === "PAID"
                            ? '<span class="badge badge-success">已扣费</span>'
                            : o.payment_state === "REFUNDED"
                              ? '<span class="badge">已退还 🍑</span>'
                              : '<span class="badge badge-warning">待结算</span>';
                        return `<tr>
                          <td><code>${escapeHtml(o.id.slice(0, 12))}</code></td>
                          <td><strong>${escapeHtml(o.username || "-")}</strong> · <code>${escapeHtml(o.sso_subject || "-")}</code></td>
                          <td><strong>🍑 ${escapeHtml(peachAmt)}</strong></td>
                          <td>${stBadge}</td>
                          <td>${escapeHtml((o.paid_at || o.created_at || "").replace("T", " ").slice(0, 19))}</td>
                          <td>
                            ${
                              o.payment_state === "PAID"
                                ? `<button type="button" class="btn btn-ghost btn-sm" data-refund-order="${escapeHtml(o.id)}">退还 🍑</button>`
                                : "-"
                            }
                          </td>
                        </tr>`;
                      })
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">🛡️ 最近安全与操作审计记录</h2>
            <p class="panel-subtitle">自动记录凭据加密托管、预约执行与账单退还操作。</p>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作类型</th>
                <th>目标资源</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              ${
                auditEvents.length === 0
                  ? `<tr><td colspan="4" class="text-muted">暂无操作记录。</td></tr>`
                  : auditEvents
                      .slice(0, 15)
                      .map(
                        (ev) => `<tr>
                          <td>${escapeHtml((ev.created_at || "").replace("T", " ").slice(0, 19))}</td>
                          <td><strong>${escapeHtml(ev.action)}</strong></td>
                          <td><code>${escapeHtml(ev.resource_kind)}:${escapeHtml(String(ev.resource_ref || "").slice(0, 16))}</code></td>
                          <td><span class="badge badge-success">${escapeHtml(ev.outcome)}</span></td>
                        </tr>`
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </section>`;
  }

  const activeMainHtml =
    activeNav === "reservations"
      ? renderReservationsView()
      : activeNav === "parcels"
        ? renderParcelsView()
        : activeNav === "orders"
          ? renderOrdersView()
          : activeNav === "console" && isAdmin
            ? renderAdminConsoleView()
            : renderPortalView();

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
              ${readyParcels.length > 0 ? `<span class="badge badge-primary" style="margin-left:auto;">${readyParcels.length}</span>` : ""}
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
            <a class="nav-item" href="https://github.com/yellowpeachxgp/day-in-school/releases/latest" target="_blank" rel="noopener">
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
            <h1 class="page-title">${escapeHtml(pageHeaderConfig.title)}</h1>
            <p class="page-subtitle">${escapeHtml(pageHeaderConfig.subtitle)}</p>
          </div>
          <div class="cluster">
            <button type="button" class="btn btn-secondary btn-sm" id="btn-sync-wallet">同步 🍑 余额</button>
            <a class="btn btn-primary btn-sm" href="https://sso.xpeach.codes/portal">前往 XPeach 主站充值 🍑</a>
          </div>
        </header>

        <div id="toast-banner" class="alert alert-success" style="display:none;margin-bottom:16px;"></div>

        ${activeMainHtml}
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
      <a class="dock-item ${activeNav === "orders" ? "active" : ""}" href="/orders">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        <span>🍑 账单</span>
      </a>
    </nav>

    <script src="/static/app.js" defer></script>
    <script>
      (function () {
        var SERVER_TOKEN = ${JSON.stringify(accessToken)};
        var STUDY_AREAS = {
          "4F_NORTH": { name: "4楼北自习区", prefix: "4N", count: 60, tags: ["靠窗·插座", "带插座", "安静区", "临走道"] },
          "2F_EAST":  { name: "2楼东报刊阅览区", prefix: "2E", count: 50, tags: ["临窗采光", "木桌座位", "靠窗", "安静区"] },
          "3F_WEST":  { name: "3楼西电子阅览区", prefix: "3W", count: 60, tags: ["全排插·宽桌", "双插孔", "靠窗·插座", "独立台灯"] },
          "5F_SOUTH": { name: "5楼南考研专区", prefix: "5S", count: 80, tags: ["独立隔板", "静音插座", "靠窗隔板", "沉浸自习"] },
          "6F_MAIN":  { name: "6楼综合自习室", prefix: "6M", count: 60, tags: ["四人宽桌", "靠窗大桌", "空调充足", "带插座"] }
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

        // Populate date default in Asia/Shanghai (today if before 07:00, tomorrow if 07:00 or later)
        var dateInput = document.getElementById("plan-date");
        if (dateInput && !dateInput.value) {
          var shNow = new Date(Date.now() + 8 * 3600000);
          var shHour = shNow.getUTCHours();
          var targetSh = shHour < 7 ? shNow : new Date(shNow.getTime() + 86400000);
          dateInput.value = targetSh.toISOString().slice(0, 10);
        }

        // Interactive area pills + visual seat grid + dropdowns (with live HAUT library loader)
        var areaSelect = document.getElementById("plan-area");
        var areaPillsBar = document.getElementById("area-pills-bar");
        var liveBadge = document.getElementById("live-region-badge");
        var seat1 = document.getElementById("plan-seat-1");
        var seat2 = document.getElementById("plan-seat-2");
        var seat3 = document.getElementById("plan-seat-3");
        var seatGrid = document.getElementById("seat-visual-grid");
        var seatSummary = document.getElementById("seat-selection-summary");
        var LIVE_REGIONS_MAP = {};

        function updateSeatGridHighlights() {
          if (!seatGrid || !seat1 || !seat2 || !seat3) return;
          var s1 = seat1.value;
          var s2 = seat2.value;
          var s3 = seat3.value;
          var chosen = [s1, s2, s3].filter(Boolean);
          if (seatSummary) {
            seatSummary.textContent = "已选：" + (chosen.length ? chosen.join(" / ") : "请点击下方座位");
          }
          seatGrid.querySelectorAll(".seat-chip").forEach(function (chip) {
            var code = chip.getAttribute("data-seat-code");
            chip.classList.remove("selected-primary", "selected-backup");
            if (code === s1) {
              chip.classList.add("selected-primary");
            } else if (code === s2 || code === s3) {
              chip.classList.add("selected-backup");
            }
          });
        }

        function bindSeatChipsClick() {
          if (!seatGrid || !seat1 || !seat2 || !seat3) return;
          seatGrid.querySelectorAll(".seat-chip").forEach(function (chip) {
            chip.addEventListener("click", function () {
              if (chip.disabled) return;
              var code = chip.getAttribute("data-seat-code");
              if (seat1.value === code) return;
              if (seat2.value === code) {
                seat2.value = seat1.value;
                seat1.value = code;
              } else if (seat3.value === code) {
                seat3.value = seat2.value;
                seat2.value = seat1.value;
                seat1.value = code;
              } else {
                seat3.value = seat2.value;
                seat2.value = seat1.value;
                seat1.value = code;
              }
              updateSeatGridHighlights();
            });
          });
        }

        function populateSeatsFromList(seatItems) {
          if (!seat1 || !seat2 || !seat3) return;
          var html1 = "";
          var html2 = '<option value="">不设置备选</option>';
          var html3 = '<option value="">不设置备选</option>';
          var gridHtml = "";
          var availableCodes = [];

          seatItems.forEach(function (item) {
            var code = item.code;
            var tag = item.tag;
            var isAvail = item.available !== false;
            var label = code + "（" + tag + "）";
            html1 += '<option value="' + code + '">' + label + "</option>";
            html2 += '<option value="' + code + '">' + label + "</option>";
            html3 += '<option value="' + code + '">' + label + "</option>";
            if (isAvail) availableCodes.push(code);
            gridHtml +=
              '<button type="button" class="seat-chip' + (isAvail ? "" : " occupied") + '" data-seat-code="' +
              code +
              '"><span class="seat-chip-code">' +
              code +
              '</span><span class="seat-chip-tag">' +
              tag +
              "</span></button>";
          });

          seat1.innerHTML = html1;
          seat2.innerHTML = html2;
          seat3.innerHTML = html3;
          if (seatGrid) {
            seatGrid.innerHTML = gridHtml;
            bindSeatChipsClick();
          }
          var pickPool = availableCodes.length >= 3 ? availableCodes : seatItems.map(function (x) { return x.code; });
          if (pickPool.length >= 1) seat1.value = pickPool[0];
          if (pickPool.length >= 2) seat2.value = pickPool[1];
          if (pickPool.length >= 3) seat3.value = pickPool[2];
          updateSeatGridHighlights();
        }

        function populateSeatsForArea() {
          if (!areaSelect || !seat1 || !seat2 || !seat3) return;
          var areaKey = areaSelect.value || "4F_NORTH";
          document.querySelectorAll("[data-area-pill]").forEach(function (pill) {
            pill.classList.toggle("active", pill.getAttribute("data-area-pill") === areaKey);
          });

          if (LIVE_REGIONS_MAP[areaKey]) {
            var bDate = (dateInput && dateInput.value) || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
            apiFetch(
              "/api/v1/schools/haut/library/live-seats?region_id=" +
                encodeURIComponent(areaKey) +
                "&booking_date=" +
                encodeURIComponent(bDate),
              { method: "GET" }
            )
              .then(function (res) {
                var seats = (res.data && res.data.seats) || [];
                if (seats.length > 0) {
                  populateSeatsFromList(
                    seats.map(function (s) {
                      var cleanShort = (s.short_name && s.short_name !== "null") ? s.short_name : "";
                      var cleanFull = (s.seat_name && s.seat_name !== "null") ? s.seat_name : "";
                      return {
                        code: cleanShort || cleanFull || String(s.seat_id),
                        tag: s.available ? "空闲可选" : "已占",
                        available: Boolean(s.available)
                      };
                    })
                  );
                } else {
                  var rMeta = LIVE_REGIONS_MAP[areaKey];
                  var totalCount = Math.min(Math.max(Number(rMeta && rMeta.totalSeats) || 60, 20), 200);
                  var genItems = [];
                  for (var k = 1; k <= totalCount; k++) {
                    genItems.push({ code: String(k).padStart(3, "0") + "号", tag: "空闲可选", available: true });
                  }
                  populateSeatsFromList(genItems);
                }
              })
              .catch(function () {});
            return;
          }

          var cfg = STUDY_AREAS[areaKey] || STUDY_AREAS["4F_NORTH"];
          var fallbackItems = [];
          for (var i = 1; i <= cfg.count; i++) {
            var code = cfg.prefix + "-" + String(i).padStart(3, "0");
            var tag = cfg.tags[(i - 1) % cfg.tags.length];
            fallbackItems.push({ code: code, tag: tag, available: true });
          }
          populateSeatsFromList(fallbackItems);
        }

        function loadLiveRegionsIfBound() {
          if (!areaSelect) return;
          var bDate = (dateInput && dateInput.value) || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
          apiFetch("/api/v1/schools/haut/library/live-regions?booking_date=" + encodeURIComponent(bDate), {
            method: "GET"
          })
            .then(function (res) {
              var regions = (res.data && res.data.regions) || [];
              if (!regions.length) return;
              LIVE_REGIONS_MAP = {};
              var optHtml = "";
              var pillsHtml = "";
              regions.forEach(function (r, idx) {
                var key = String(r.region_id);
                LIVE_REGIONS_MAP[key] = {
                  name: r.region_name,
                  layerName: r.layer_name,
                  totalSeats: r.total_seats,
                  availableSeats: r.available_seats
                };
                optHtml +=
                  '<option value="' +
                  key +
                  '">' +
                  r.layer_name +
                  " · " +
                  r.region_name +
                  "（空闲 " +
                  r.available_seats +
                  "/" +
                  r.total_seats +
                  "）</option>";
                if (idx < 8) {
                  pillsHtml +=
                    '<button type="button" class="area-pill' +
                    (idx === 0 ? " active" : "") +
                    '" data-area-pill="' +
                    key +
                    '">' +
                    r.region_name +
                    " (" +
                    r.available_seats +
                    ")</button>";
                }
              });
              areaSelect.innerHTML = optHtml;
              if (areaPillsBar && pillsHtml) {
                areaPillsBar.innerHTML = pillsHtml;
                areaPillsBar.querySelectorAll("[data-area-pill]").forEach(function (pill) {
                  pill.addEventListener("click", function () {
                    areaSelect.value = pill.getAttribute("data-area-pill");
                    populateSeatsForArea();
                  });
                });
              }
              if (liveBadge) {
                liveBadge.style.display = "inline-flex";
              }
              populateSeatsForArea();
            })
            .catch(function () {});
        }

        if (areaSelect) {
          areaSelect.addEventListener("change", populateSeatsForArea);
          if (dateInput) dateInput.addEventListener("change", loadLiveRegionsIfBound);
          if (seat1) seat1.addEventListener("change", updateSeatGridHighlights);
          if (seat2) seat2.addEventListener("change", updateSeatGridHighlights);
          if (seat3) seat3.addEventListener("change", updateSeatGridHighlights);
          document.querySelectorAll("[data-area-pill]").forEach(function (pill) {
            pill.addEventListener("click", function () {
              areaSelect.value = pill.getAttribute("data-area-pill");
              populateSeatsForArea();
            });
          });
          populateSeatsForArea();
          loadLiveRegionsIfBound();
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

        // Save school binding (live CAS verification + encrypted credential custody)
        var btnSaveBinding = document.getElementById("btn-save-binding");
        if (btnSaveBinding) {
          btnSaveBinding.addEventListener("click", function () {
            var schoolId = document.getElementById("bind-school").value || "haut";
            var studentNo = (document.getElementById("bind-student-no").value || "").trim();
            var secret = (document.getElementById("bind-secret").value || "").trim();
            if (!studentNo) {
              showToast("请填写您的校园学号", true);
              return;
            }
            if (!secret) {
              showToast("请填写您的教务/图书馆通行密码", true);
              return;
            }
            btnSaveBinding.disabled = true;
            btnSaveBinding.textContent = "正在验证学号…";
            apiFetch("/api/v1/school-bindings/bind-live", {
              method: "POST",
              body: JSON.stringify({ school_id: schoolId, student_no: studentNo, password: secret })
            })
              .then(function (r) {
                var uName = r.data && r.data.user_name ? "（" + r.data.user_name + "）" : "";
                showToast("学号 " + studentNo + uName + " 验证并绑定成功！");
                setTimeout(function () { window.location.reload(); }, 600);
              })
              .catch(function (err) {
                showToast(err.message, true);
              })
              .finally(function () {
                btnSaveBinding.disabled = false;
                btnSaveBinding.textContent = "一键验证并绑定学号";
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
            var activeBinding =
              bList.find(function (b) {
                return !b.revoked_at && (b.status === "DELEGATED_ACTIVE" || b.status === "ACTIVE");
              }) ||
              bList.find(function (b) {
                return !b.revoked_at;
              });
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
          var areaCfg = LIVE_REGIONS_MAP[areaKey] || STUDY_AREAS[areaKey] || STUDY_AREAS["4F_NORTH"];
          var seats = [seat1.value, seat2.value, seat3.value].filter(Boolean);
          var targetDate = (dateInput && dateInput.value) || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
          var targetTime = document.getElementById("plan-time").value || "07:00:00";
          var repeatEl = document.getElementById("plan-repeat-days");
          var repeatDays = Number((repeatEl && repeatEl.value) || 1) || 1;
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
                target_local_time: targetTime,
                repeat_days: repeatDays,
                remaining_days: repeatDays,
                replace_existing: true
              })
            });
          });
        }

        var btnCreatePlan = document.getElementById("btn-create-plan");
        if (btnCreatePlan) {
          btnCreatePlan.addEventListener("click", function () {
            btnCreatePlan.disabled = true;
            var repeatEl = document.getElementById("plan-repeat-days");
            var repeatDays = Number((repeatEl && repeatEl.value) || 1) || 1;
            createReservationPlanFromSelection()
              .then(function () {
                showToast(
                  repeatDays > 1
                    ? "已保存连续 " + repeatDays + " 天自动抢座计划！每天早间将自动为您准点抢座并续期次日任务。"
                    : "自动抢座计划已保存！到点将自动为您抢座，并已同步至日在校园 App。"
                );
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

        function handleExecuteJobResult(execRes) {
          var data = (execRes && execRes.data) || {};
          var job = data.job || {};
          var sr = data.schoolReservation || data.school_reservation || {};
          if (job.state === "CONFIRMED") {
            var alias = sr.seat_alias ? "（" + sr.seat_alias + "）" : "";
            showToast("占座成功！" + alias + " 已从您的 XPeach 账户扣除 0.1 🍑。");
          } else {
            showToast("未能锁定所选座位（座位已被占用或未绑定正确图书馆密码），本次未扣费", true);
          }
          setTimeout(function () { window.location.reload(); }, 900);
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
              .then(handleExecuteJobResult)
              .catch(function (err) {
                showToast(err.message, true);
              })
              .finally(function () {
                btnFireNow.disabled = false;
                btnFireNow.textContent = "立即预约所选座位";
              });
          });
        }

        document.querySelectorAll("[data-execute-now-job]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var jobId = btn.getAttribute("data-execute-now-job");
            btn.disabled = true;
            btn.textContent = "抢座中…";
            apiFetch("/api/v1/reservation-jobs/" + encodeURIComponent(jobId) + "/execute-now", {
              method: "POST",
              body: JSON.stringify({})
            })
              .then(handleExecuteJobResult)
              .catch(function (err) {
                showToast(err.message, true);
                btn.disabled = false;
                btn.textContent = "⚡ 立即抢一次";
              });
          });
        });

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

        // Release live confirmed seat booking buttons
        document.querySelectorAll("[data-cancel-seat-job]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var jobId = btn.getAttribute("data-cancel-seat-job");
            btn.disabled = true;
            btn.textContent = "释放中…";
            apiFetch("/api/v1/reservation-jobs/" + encodeURIComponent(jobId) + "/cancel-seat", {
              method: "POST",
              body: JSON.stringify({})
            })
              .then(function (r) {
                showToast((r.data && r.data.message) || "座位已成功取消释放");
                setTimeout(function () { window.location.reload(); }, 500);
              })
              .catch(function (err) {
                showToast(err.message, true);
                btn.disabled = false;
                btn.textContent = "退座释放";
              });
          });
        });

        // Real-time SMS pickup code preview
        var smsInput = document.getElementById("parcel-sms");
        var smsPreview = document.getElementById("sms-preview-chip");
        function parseSmsText(sms) {
          var codeMatch = sms.match(/([0-9A-Za-z]{1,4}-[0-9A-Za-z]{1,4}-[0-9A-Za-z]{2,6})/) ||
                          sms.match(/取件码[为是：:\\s]*([0-9A-Za-z-]{4,12})/);
          var pickupCode = codeMatch ? codeMatch[1] : "";
          var stationName = "莲花街南苑菜鸟驿站";
          if (sms.indexOf("北苑") !== -1) stationName = "莲花街北苑菜鸟驿站";
          else if (sms.indexOf("东苑") !== -1) stationName = "莲花街东苑快递中心";
          else if (sms.indexOf("丰巢") !== -1) stationName = "学生公寓丰巢智能柜";
          var carrierName = "菜鸟驿站";
          if (sms.indexOf("顺丰") !== -1) carrierName = "顺丰速运";
          else if (sms.indexOf("京东") !== -1) carrierName = "京东快递";
          else if (sms.indexOf("中通") !== -1) carrierName = "中通快递";
          else if (sms.indexOf("圆通") !== -1) carrierName = "圆通速递";
          else if (sms.indexOf("申通") !== -1) carrierName = "申通快递";
          else if (sms.indexOf("韵达") !== -1) carrierName = "韵达快递";
          else if (sms.indexOf("极兔") !== -1) carrierName = "极兔速递";
          return { pickupCode: pickupCode, stationName: stationName, carrierName: carrierName };
        }

        if (smsInput && smsPreview) {
          smsInput.addEventListener("input", function () {
            var val = smsInput.value.trim();
            if (!val) {
              smsPreview.textContent = "💡 提示：在「日在校园」App 中可通过手机号一键绑定小米智能助理，全自动同步您的所有校园快递与取件码。";
              return;
            }
            var parsed = parseSmsText(val);
            if (parsed.pickupCode) {
              smsPreview.innerHTML = "✅ 已识别取件码：<strong style='color:#E86A33;'>" + parsed.pickupCode + "</strong> · 驿站：<strong>" + parsed.stationName + "</strong> · 快递：<strong>" + parsed.carrierName + "</strong>";
            } else {
              smsPreview.textContent = "正在识别取件码格式（例如 3-2-1048）…";
            }
          });
        }

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
            var parsed = parseSmsText(sms);
            var pickupCode = parsed.pickupCode || "1-2-1088";
            var stationName = parsed.stationName;
            var carrierName = parsed.carrierName;
            if (!tracking) {
              tracking = "YT" + String(Date.now()).slice(-10);
            }
            btnAddParcel.disabled = true;
            apiFetch("/api/v1/parcels/imports", {
              method: "POST",
              body: JSON.stringify({
                tracking_number: tracking,
                carrier_code: "cainiao",
                carrier_name: carrierName,
                status: "READY_FOR_PICKUP",
                pickup_code: pickupCode,
                station_name: stationName,
                raw_notification_text: sms || "网页端录入取件码"
              })
            })
              .then(function () {
                showToast("取件码 " + pickupCode + " 已保存并同步至 App！");
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
                setTimeout(function () { window.location.reload(); }, 450);
              })
              .catch(function (err) {
                showToast(err.message, true);
              });
          });
        });

        // Admin: toggle school kill-switch
        document.querySelectorAll("[data-toggle-kill]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var schoolId = btn.getAttribute("data-toggle-kill");
            var currentKill = btn.getAttribute("data-current-kill") === "true";
            apiFetch("/api/v1/admin/schools/" + encodeURIComponent(schoolId) + "/kill-switch", {
              method: "POST",
              body: JSON.stringify({ kill_switch: !currentKill })
            })
              .then(function () {
                showToast(!currentKill ? "已暂停该校预约服务" : "已恢复该校预约服务");
                setTimeout(function () { window.location.reload(); }, 500);
              })
              .catch(function (err) {
                showToast(err.message, true);
              });
          });
        });

        // Admin: 1-click order refund
        document.querySelectorAll("[data-refund-order]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var orderId = btn.getAttribute("data-refund-order");
            btn.disabled = true;
            btn.textContent = "退还中…";
            apiFetch("/api/v1/admin/orders/" + encodeURIComponent(orderId) + "/quick-refund", {
              method: "POST",
              body: JSON.stringify({ reason: "管理员在站点后台执行一键退还 🍑" })
            })
              .then(function () {
                showToast("已将 0.1 🍑 原路退还至用户 XPeach 账户！");
                setTimeout(function () { window.location.reload(); }, 600);
              })
              .catch(function (err) {
                btn.disabled = false;
                btn.textContent = "退还 🍑";
                showToast(err.message, true);
              });
          });
        });

        // Admin: Cloud-Controlled Campus Channels & Student Clubs
        var btnSaveBulletin = document.getElementById("btn-save-bulletin");
        if (btnSaveBulletin) {
          btnSaveBulletin.addEventListener("click", function () {
            btnSaveBulletin.disabled = true;
            apiFetch("/api/v1/admin/campus-content", {
              method: "PUT",
              body: JSON.stringify({
                school_id: "haut",
                bulletin: {
                  title: (document.getElementById("cc-bulletin-title").value || "").trim(),
                  tag: (document.getElementById("cc-bulletin-tag").value || "云端实时同步").trim(),
                  content: (document.getElementById("cc-bulletin-content").value || "").trim(),
                  enabled: document.getElementById("cc-bulletin-enabled").value !== "false"
                }
              })
            })
              .then(function () {
                showToast("社区横幅公告已更新并实时下发至全校客户端！");
                setTimeout(function () { window.location.reload(); }, 500);
              })
              .catch(function (err) {
                btnSaveBulletin.disabled = false;
                showToast(err.message, true);
              });
          });
        }

        var btnSaveChannel = document.getElementById("btn-save-channel");
        if (btnSaveChannel) {
          btnSaveChannel.addEventListener("click", function () {
            var title = (document.getElementById("cc-ch-title").value || "").trim();
            if (!title) {
              showToast("请填写校园频道名称", true);
              return;
            }
            btnSaveChannel.disabled = true;
            apiFetch("/api/v1/admin/campus-content/channels", {
              method: "POST",
              body: JSON.stringify({
                school_id: "haut",
                id: (document.getElementById("cc-ch-id").value || "").trim() || undefined,
                title: title,
                tag_label: (document.getElementById("cc-ch-tag").value || "频道").trim(),
                invite_url: (document.getElementById("cc-ch-url").value || "").trim(),
                subtitle: (document.getElementById("cc-ch-subtitle").value || "").trim(),
                sort_order: Number(document.getElementById("cc-ch-sort").value || 50)
              })
            })
              .then(function () {
                showToast("校园频道已保存并下发！");
                setTimeout(function () { window.location.reload(); }, 500);
              })
              .catch(function (err) {
                btnSaveChannel.disabled = false;
                showToast(err.message, true);
              });
          });
        }

        document.querySelectorAll("[data-edit-channel]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            try {
              var ch = JSON.parse(btn.getAttribute("data-edit-channel"));
              document.getElementById("cc-ch-id").value = ch.id || "";
              document.getElementById("cc-ch-title").value = ch.title || "";
              document.getElementById("cc-ch-tag").value = ch.tag_label || "";
              document.getElementById("cc-ch-url").value = ch.invite_url || "";
              document.getElementById("cc-ch-subtitle").value = ch.subtitle || "";
              document.getElementById("cc-ch-sort").value = ch.sort_order || 10;
              document.getElementById("cc-ch-title").focus();
            } catch (e) {}
          });
        });

        document.querySelectorAll("[data-toggle-pin-channel]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var ch = JSON.parse(btn.getAttribute("data-toggle-pin-channel"));
            apiFetch("/api/v1/admin/campus-content/channels", {
              method: "POST",
              body: JSON.stringify({ id: ch.id, title: ch.title, pinned: !ch.pinned })
            }).then(function () {
              showToast(!ch.pinned ? "已置顶频道" : "已取消置顶");
              setTimeout(function () { window.location.reload(); }, 400);
            });
          });
        });

        document.querySelectorAll("[data-toggle-enable-channel]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var ch = JSON.parse(btn.getAttribute("data-toggle-enable-channel"));
            var nextEnabled = ch.enabled === false;
            apiFetch("/api/v1/admin/campus-content/channels", {
              method: "POST",
              body: JSON.stringify({ id: ch.id, title: ch.title, enabled: nextEnabled })
            }).then(function () {
              showToast(nextEnabled ? "已启用频道" : "已隐藏频道");
              setTimeout(function () { window.location.reload(); }, 400);
            });
          });
        });

        document.querySelectorAll("[data-delete-channel]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var id = btn.getAttribute("data-delete-channel");
            apiFetch("/api/v1/admin/campus-content/channels/" + encodeURIComponent(id), {
              method: "DELETE"
            }).then(function () {
              showToast("频道已删除");
              setTimeout(function () { window.location.reload(); }, 400);
            });
          });
        });

        var btnSaveClub = document.getElementById("btn-save-club");
        if (btnSaveClub) {
          btnSaveClub.addEventListener("click", function () {
            var name = (document.getElementById("cc-club-name").value || "").trim();
            if (!name) {
              showToast("请填写学生社团名称", true);
              return;
            }
            btnSaveClub.disabled = true;
            apiFetch("/api/v1/admin/campus-content/clubs", {
              method: "POST",
              body: JSON.stringify({
                school_id: "haut",
                id: (document.getElementById("cc-club-id").value || "").trim() || undefined,
                name: name,
                category: document.getElementById("cc-club-category").value || "TECH_INNOVATION",
                qq_group_number: (document.getElementById("cc-club-qq").value || "").trim(),
                affiliated_unit: (document.getElementById("cc-club-unit").value || "").trim(),
                activity_venue: (document.getElementById("cc-club-venue").value || "").trim(),
                highlights: (document.getElementById("cc-club-highlights").value || "").trim(),
                summary: (document.getElementById("cc-club-summary").value || "").trim(),
                sort_order: Number(document.getElementById("cc-club-sort").value || 50)
              })
            })
              .then(function () {
                showToast("学生社团信息已保存并实时下发！");
                setTimeout(function () { window.location.reload(); }, 500);
              })
              .catch(function (err) {
                btnSaveClub.disabled = false;
                showToast(err.message, true);
              });
          });
        }

        document.querySelectorAll("[data-edit-club]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            try {
              var cl = JSON.parse(btn.getAttribute("data-edit-club"));
              document.getElementById("cc-club-id").value = cl.id || "";
              document.getElementById("cc-club-name").value = cl.name || "";
              document.getElementById("cc-club-category").value = cl.category || "TECH_INNOVATION";
              document.getElementById("cc-club-qq").value = cl.qq_group_number || "";
              document.getElementById("cc-club-unit").value = cl.affiliated_unit || "";
              document.getElementById("cc-club-venue").value = cl.activity_venue || "";
              document.getElementById("cc-club-highlights").value = (cl.highlights || []).join(",");
              document.getElementById("cc-club-summary").value = cl.summary || "";
              document.getElementById("cc-club-sort").value = cl.sort_order || 50;
              document.getElementById("cc-club-name").focus();
            } catch (e) {}
          });
        });

        document.querySelectorAll("[data-toggle-pin-club]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var cl = JSON.parse(btn.getAttribute("data-toggle-pin-club"));
            apiFetch("/api/v1/admin/campus-content/clubs", {
              method: "POST",
              body: JSON.stringify({ id: cl.id, name: cl.name, pinned: !cl.pinned })
            }).then(function () {
              showToast(!cl.pinned ? "已置顶社团" : "已取消置顶");
              setTimeout(function () { window.location.reload(); }, 400);
            });
          });
        });

        document.querySelectorAll("[data-toggle-enable-club]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var cl = JSON.parse(btn.getAttribute("data-toggle-enable-club"));
            var nextEnabled = cl.enabled === false;
            apiFetch("/api/v1/admin/campus-content/clubs", {
              method: "POST",
              body: JSON.stringify({ id: cl.id, name: cl.name, enabled: nextEnabled })
            }).then(function () {
              showToast(nextEnabled ? "已启用社团展示" : "已隐藏社团");
              setTimeout(function () { window.location.reload(); }, 400);
            });
          });
        });

        document.querySelectorAll("[data-delete-club]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var id = btn.getAttribute("data-delete-club");
            apiFetch("/api/v1/admin/campus-content/clubs/" + encodeURIComponent(id), {
              method: "DELETE"
            }).then(function () {
              showToast("社团已删除");
              setTimeout(function () { window.location.reload(); }, 400);
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
