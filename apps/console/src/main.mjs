import http from "node:http";
import {
  DEFAULT_RESERVATION_PRICE_MICROPEACH,
  MICROPEACH_PER_PEACH,
  formatPeachFromMicropeach
} from "../../../packages/contracts/src/index.mjs";
import {
  cleanDisplayText,
  escapeHtml,
  xpeachBadge,
  xpeachStatusDot,
  xpeachBentoTile,
  xpeachEmptyState,
  xpeachClubCard,
  xpeachChannelCard,
  xpeachCompetitionCard,
  xpeachOrderRowCard,
  xpeachSchoolControlCard,
  xpeachAuditRowCard
} from "./ui-sdk.mjs";

export const CONSOLE_VIEWS = [
  { id: "overview", title: "运维总览", role: "ADMIN" },
  { id: "jobs", title: "预约任务管理", role: "OPERATOR" },
  { id: "orders", title: "账单与退还", role: "FINANCE" },
  { id: "audit", title: "审计事件检索", role: "ADMIN" },
  { id: "schools", title: "学校服务管理", role: "OPERATOR" },
  { id: "content", title: "校园内容云控", role: "OPERATOR" },
  { id: "users", title: "接入用户管理", role: "SUPPORT" },
  { id: "finance-reconcile", title: "🍑 财务对账", role: "FINANCE" },
  { id: "refund-approvals", title: "账单退还审批", role: "FINANCE" },
  { id: "plugin-registry", title: "功能扩展中心", role: "OPERATOR" },
  { id: "audit-log", title: "操作审计日志", role: "ADMIN" },
  { id: "user-support", title: "账号支持", role: "SUPPORT" }
];

export const CONSOLE_UI_VERSION = "20261108a";

function renderHiddenContractViews() {
  return `<template id="contract-views-marker" hidden>${CONSOLE_VIEWS.map(
    (v) => `<section id="view-${v.id}" data-role="${v.role}"></section>`
  ).join("")}</template>`;
}

function renderHead(title = "日在校园 · 运维管理控制台") {
  return `<!doctype html>
<html lang="zh-CN" data-ui-style="liquid-glass">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content="#f4f7fb" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#0b1120" media="(prefers-color-scheme: dark)" />
    <title>${escapeHtml(title)}</title>
    <link rel="icon" type="image/png" href="/static/xpeach-logo.png" />
    <link rel="apple-touch-icon" href="/static/xpeach-logo.png" />
    <script>
      (function () {
        try {
          var savedTheme = localStorage.getItem("xpeach-theme");
          var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
          var theme = savedTheme === "dark" || savedTheme === "light" ? savedTheme : (prefersDark ? "dark" : "light");
          document.documentElement.setAttribute("data-theme", theme);
          var savedStyle = localStorage.getItem("xpeach-ui-style");
          var uiStyle = savedStyle === "flutter-m3" || savedStyle === "liquid-glass" ? savedStyle : "liquid-glass";
          document.documentElement.setAttribute("data-ui-style", uiStyle);
        } catch (e) {}
      })();
    </script>
    <link rel="stylesheet" href="/static/app.css?v=${CONSOLE_UI_VERSION}" />
    <link rel="stylesheet" href="/static/xpeach-sdk.css?v=${CONSOLE_UI_VERSION}" />
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
      <main class="card auth-window xp-card">
        <div class="auth-header">
          <div class="auth-eyebrow">🍑 XPeach 统一认证</div>
          <h1 class="auth-title">认证成功</h1>
          <p class="auth-subtitle">正在为您返回「日在校园」App 并同步您的账号与 🍑 余额…</p>
        </div>
        <div class="stack gap-3">
          <a class="btn btn-primary btn-block btn-lg" id="open-app-btn" href="${customSchemeUrl}">立即返回日在校园 App</a>
          <a class="btn btn-secondary btn-block" href="/">进入运维管理控制台</a>
        </div>
        <input type="hidden" id="cb-ticket" value="${safeTicket}" />
        <input type="hidden" id="cb-txn" value="${safeTxn}" />
      </main>
      <footer class="auth-footer">
        <span>🍑 XPeach Account Center · 日在校园</span>
      </footer>
    </div>
    <script src="/static/app.js?v=${CONSOLE_UI_VERSION}" defer></script>
    <script>
      (function () {
        var target = ${JSON.stringify(customSchemeUrl).replace(/</g, "\\u003c")};
        setTimeout(function () {
          window.location.href = target;
        }, 180);
      })();
    </script>
  </body>
</html>`;
}

function renderUnauthenticatedLandingHtml() {
  return `${renderHead("日在校园 · 运维管理控制台")}
  <body class="auth-body">
    ${renderHiddenContractViews()}
    <header class="auth-toolbar" aria-label="偏好设置">
      <div class="auth-toolbar-inner" style="display:flex;gap:8px;align-items:center;">
        <button type="button" class="xp-pill xp-pill--compact" data-ui-style-toggle title="切换 Flutter M3 / 液态毛玻璃设计风格">
          <span data-ui-style-label>✨ 液态毛玻璃</span>
        </button>
        <button type="button" class="icon-btn theme-toggle" data-theme-toggle aria-label="切换明暗主题" title="切换明暗主题">
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
            <span class="brand-sub">日在校园</span>
          </div>
        </a>
      </header>
      <main class="card auth-window xp-card">
        <div class="auth-header">
          <div class="auth-eyebrow">🍑 XPeach 管理员认证</div>
          <h1 class="auth-title">日在校园 · 运维管理控制台</h1>
          <p class="auth-subtitle" id="landing-subtitle">仅限 owner/admin 管理员登录。登录后可执行预约任务监控、账单对账退还、学校服务熔断与校园内容云控。</p>
        </div>

        <div class="stack gap-3">
          <a class="btn btn-primary btn-block btn-lg" id="sso-login-btn" href="/api/v1/auth/web/start">
            使用 XPeach 管理员账号登录
          </a>
          <a class="btn btn-secondary btn-block btn-lg" href="https://sso.xpeach.codes/portal">
            返回 XPeach 账户中心
          </a>
        </div>

        <div class="auth-divider"><span>运维能力概览</span></div>

        <div class="xp-card-grid" style="grid-template-columns: repeat(auto-fit, minmax(185px, 1fr)); gap: 10px;">
          <div class="xp-well">
            <div class="xp-entity-title" style="font-size: 14px;">预约任务调度监控</div>
            <p class="xp-entity-summary" style="font-size: 12px; margin-top: 4px;">查看全站占座任务、三段式调度事件与失败诊断状态。</p>
          </div>
          <div class="xp-well">
            <div class="xp-entity-title" style="font-size: 14px;">账单对账与一键退还</div>
            <p class="xp-entity-summary" style="font-size: 12px; margin-top: 4px;">全站 🍑 消费账单对账，支持幂等一键退还至用户钱包。</p>
          </div>
          <div class="xp-well">
            <div class="xp-entity-title" style="font-size: 14px;">内容云控与安全审计</div>
            <p class="xp-entity-summary" style="font-size: 12px; margin-top: 4px;">社团、竞赛、频道与横幅公告实时下发，全程审计留痕。</p>
          </div>
        </div>
      </main>
      <footer class="auth-footer">
        <span>XPeach · 日在校园</span>
        <span>·</span>
        <a href="https://sso.xpeach.codes/portal">XPeach 主站</a>
        <span>·</span>
        <a href="https://github.com/yellowpeachxgp/day-in-school/releases/latest" target="_blank" rel="noopener">Android 客户端下载</a>
      </footer>
    </div>
    <script src="/static/app.js?v=${CONSOLE_UI_VERSION}" defer></script>
    <script>
      (function () {
        var styleBtn = document.querySelector("[data-ui-style-toggle]");
        var styleLabel = document.querySelector("[data-ui-style-label]");
        function syncStyleLabel() {
          if (!styleLabel) return;
          var cur = document.documentElement.getAttribute("data-ui-style") || "liquid-glass";
          styleLabel.textContent = cur === "liquid-glass" ? "毛玻璃" : "经典 M3";
        }
        syncStyleLabel();
        if (styleBtn) {
          styleBtn.addEventListener("click", function () {
            var cur = document.documentElement.getAttribute("data-ui-style") || "liquid-glass";
            var next = cur === "liquid-glass" ? "flutter-m3" : "liquid-glass";
            document.documentElement.setAttribute("data-ui-style", next);
            try { localStorage.setItem("xpeach-ui-style", next); } catch (e) {}
            syncStyleLabel();
          });
        }

        var params = new URLSearchParams(window.location.search);
        var webTicket = params.get("web_ticket");
        var txn = params.get("txn");
        if (webTicket && txn) {
          var sub = document.getElementById("landing-subtitle");
          if (sub) sub.textContent = "正在登录，请稍候…";
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
  const pricingMicropeach = Number(ctx.pricingMicropeach ?? DEFAULT_RESERVATION_PRICE_MICROPEACH);
  const pricePeachText = formatPeachFromMicropeach(pricingMicropeach);
  const user = ctx.user || null;
  if (!user) {
    return renderUnauthenticatedLandingHtml();
  }

  const username = user.username || user.display_name || "站点管理员";
  const userInitial = String(username).trim().slice(0, 1).toUpperCase() || "A";
  const userRoleLabel =
    user.role === "owner"
      ? "平台所有者"
      : user.role === "admin"
        ? "站点管理员"
        : roles.includes("PLATFORM_OWNER")
          ? "平台所有者"
          : roles.includes("ADMIN") || roles.includes("OPERATIONS_ADMIN")
            ? "站点管理员"
            : roles.includes("FINANCE_OPERATOR")
              ? "财务运营"
              : roles.includes("SECURITY_AUDITOR")
                ? "安全审计"
                : roles.length > 0
                  ? "运维成员"
                  : "运维成员";
  const roles = Array.isArray(ctx.roles) ? ctx.roles : [];
  const isAdmin =
    roles.includes("ADMIN") ||
    roles.includes("OPERATOR") ||
    roles.includes("FINANCE") ||
    roles.includes("SUPPORT") ||
    roles.includes("PLATFORM_OWNER") ||
    user.role === "admin" ||
    user.role === "owner";
  const activeNav = ctx.activeNav || "console";

  const adminStats = ctx.adminStats && typeof ctx.adminStats === "object" ? ctx.adminStats : {};
  const allJobs = Array.isArray(ctx.allJobs) ? ctx.allJobs : [];
  const allEvents = Array.isArray(ctx.allEvents) ? ctx.allEvents : null;
  const allOrders = Array.isArray(ctx.allOrders) ? ctx.allOrders : [];
  const allUsers = Array.isArray(ctx.allUsers) ? ctx.allUsers : [];
  const schools = Array.isArray(ctx.schools) ? ctx.schools : [];
  const auditEvents = Array.isArray(ctx.auditEvents) ? ctx.auditEvents : [];
  const financeMatrix = ctx.financeMatrix && typeof ctx.financeMatrix === "object" ? ctx.financeMatrix : null;

  const campusContent = ctx.campusContent || {
    version: 2,
    updated_at: "",
    bulletin: {
      enabled: true,
      title: "河工大社团与竞赛目录",
      content: "汇总校内合作社团招新群与常见学科竞赛信息。",
      tag: "社团与竞赛"
    },
    channels: [],
    clubs: []
  };
  const ccBulletin = campusContent.bulletin || {};
  const ccChannels = Array.isArray(campusContent.channels) ? campusContent.channels : [];
  const ccClubs = Array.isArray(campusContent.clubs) ? campusContent.clubs : [];
  const ccCompetitions = Array.isArray(campusContent.competitions) ? campusContent.competitions : [];

  const accessToken = ctx.accessToken || "";

  const pageHeaderConfig = {
    console: {
      title: "运维总览",
      subtitle: "站点运行指标、学校服务状态、接入用户与最近审计事件。"
    },
    jobs: {
      title: "预约任务管理",
      subtitle: "全站图书馆占座任务与三段式调度事件监控。"
    },
    orders: {
      title: "账单与退还",
      subtitle: "全站 🍑 消费账单对账与一键退还。"
    },
    audit: {
      title: "审计日志",
      subtitle: "安全与操作审计事件检索，敏感字段已在服务端脱敏。"
    },
    schools: {
      title: "学校服务管理",
      subtitle: "图书馆服务熔断开关与运维授权审批。"
    },
    content: {
      title: "校园内容云控",
      subtitle: "社团、竞赛、频道与社区横幅公告的云端下发管理。"
    }
  }[activeNav] || {
    title: "运维总览",
    subtitle: "站点运行指标、学校服务状态、接入用户与最近审计事件。"
  };

  function jobStateBadge(state) {
    if (state === "CONFIRMED") return xpeachBadge("已成功", "success");
    if (state === "FAILED") return xpeachBadge("执行失败", "danger");
    if (state === "CANCELLED") return xpeachBadge("已取消", "neutral");
    if (state === "EXPIRED") return xpeachBadge("已过期", "warning");
    if (state === "FINAL_CHECK_OK") return xpeachBadge("终检通过", "primary");
    if (state === "PRECHECK_OK") return xpeachBadge("预检通过", "primary");
    return xpeachBadge(state || "ARMED", "primary");
  }

  function renderAdminJobRow(job) {
    const j = job || {};
    const state = cleanDisplayText(j.state, "ARMED");
    const ownerLabel = cleanDisplayText(j.username || j.cloud_user_id, "-");
    const planLabel = cleanDisplayText(j.plan_label || j.plan_id, "-");
    const repDays = Number(j.repeat_days || 1);
    const createdText = cleanDisplayText((j.created_at || "").replace("T", " ").slice(0, 19), "-");
    const searchText =
      `${j.id || ""} ${ownerLabel} ${j.cloud_user_id || ""} ${planLabel} ${j.school_id || ""} ${state} ${j.booking_local_date || ""}`.toLowerCase();
    return `
      <article class="xp-row-card" data-job-row data-job-state="${escapeHtml(state)}" data-job-search="${escapeHtml(searchText)}">
        <div class="xp-row-card-main">
          <div class="xp-icon-box xp-icon-box--sm" aria-hidden="true">💺</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow">
              <span class="xp-row-card-title">${escapeHtml(ownerLabel)}</span>
              <code class="xp-code-pill">${escapeHtml(planLabel)}</code>
              ${repDays > 1 ? xpeachBadge(`连续 ${repDays} 天`, "primary") : ""}
              ${jobStateBadge(state)}
            </div>
            <div class="xp-row-card-meta">
              <span>预约日期：<strong>${escapeHtml(j.booking_local_date || "-")}</strong></span>
              <span>执行时间：<code>${escapeHtml(j.target_local_time || "-")}</code></span>
              <span>代次：${escapeHtml(String(j.generation ?? 1))}</span>
              <span>任务：<code>${escapeHtml(String(j.id || "-").slice(0, 12))}</code></span>
              <span>创建：${escapeHtml(createdText)}</span>
              ${j.last_error_code ? `<span>错误：<code>${escapeHtml(j.last_error_code)}</code></span>` : ""}
            </div>
          </div>
        </div>
      </article>`;
  }

  function renderScheduleEventRow(ev) {
    const e = ev || {};
    const kindLabel =
      { PRECHECK: "预检 (T-30m)", FINAL_CHECK: "终检 (T-5m)", FIRE: "点火执行 (T)" }[e.kind] ||
      cleanDisplayText(e.kind, "EVENT");
    const status = cleanDisplayText(e.status, "ARMED");
    const statusTone = /FAIL|ERROR/i.test(status)
      ? "danger"
      : status === "DONE" || status === "FIRED" || status === "COMPLETED"
        ? "success"
        : "primary";
    const dueText = cleanDisplayText((e.due_at || "").replace("T", " ").slice(0, 19), "-");
    const actualText = e.actual_at
      ? cleanDisplayText(String(e.actual_at).replace("T", " ").slice(0, 19), "-")
      : "未触发";
    return `
      <article class="xp-row-card" data-event-row>
        <div class="xp-row-card-main">
          <div class="xp-icon-box xp-icon-box--sm" aria-hidden="true">⏱️</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow">
              <span class="xp-row-card-title">${escapeHtml(kindLabel)}</span>
              ${xpeachBadge(status, statusTone)}
              ${xpeachBadge(`代次 ${e.generation ?? 1}`, "neutral")}
            </div>
            <div class="xp-row-card-meta">
              <span>任务：<code>${escapeHtml(String(e.job_id || "-").slice(0, 12))}</code></span>
              <span>计划时间：<code>${escapeHtml(dueText)}</code></span>
              <span>实际执行：${escapeHtml(actualText)}</span>
              ${e.diagnostic_code ? `<span>诊断：<code>${escapeHtml(e.diagnostic_code)}</code></span>` : ""}
            </div>
          </div>
        </div>
      </article>`;
  }

  function renderAdminUserRow(usr) {
    const u = usr || {};
    const displayName = cleanDisplayText(u.display_name || u.username, "未命名用户");
    const userRoles = Array.isArray(u.roles) ? u.roles.filter(Boolean) : [];
    const statusText = cleanDisplayText(u.status, "ACTIVE").toUpperCase();
    const statusTone =
      statusText === "ACTIVE" ? "success" : statusText === "DISABLED" || statusText === "SUSPENDED" ? "danger" : "neutral";
    return `
      <article class="xp-row-card" data-user-row>
        <div class="xp-row-card-main">
          <div class="xp-icon-box xp-icon-box--sm" aria-hidden="true">👤</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow">
              <span class="xp-row-card-title">${escapeHtml(displayName)}</span>
              ${xpeachBadge(`@${cleanDisplayText(u.username, "-")}`, "primary")}
              ${xpeachBadge(statusText, statusTone)}
              ${userRoles.slice(0, 4).map((r) => xpeachBadge(r, "peach")).join("")}
            </div>
            <div class="xp-row-card-meta">
              <span>主体：<code>${escapeHtml(u.subject || "-")}</code></span>
              <span>角色：<code>${escapeHtml(u.role || "user")}</code></span>
              <span>ID：<code>${escapeHtml(String(u.id || "-").slice(0, 12))}</code></span>
            </div>
          </div>
        </div>
      </article>`;
  }

  function renderAdminAuditRow(ev) {
    const e = ev || {};
    const timeText = cleanDisplayText((e.created_at || "").replace("T", " ").slice(0, 19), "-");
    const outcome = cleanDisplayText(e.outcome, "SUCCESS");
    const outcomeTone =
      outcome === "DENY" || outcome === "ERROR" || outcome === "FAILED"
        ? "danger"
        : outcome === "SUCCESS" || outcome === "ALLOW"
          ? "success"
          : "warning";
    const searchText =
      `${e.actor_kind || ""} ${e.actor_ref || ""} ${e.action || ""} ${e.resource_kind || ""} ${e.resource_ref || ""} ${outcome}`.toLowerCase();
    return `
      <article class="xp-row-card" data-audit-row data-audit-search="${escapeHtml(searchText)}">
        <div class="xp-row-card-main">
          <div class="xp-icon-box xp-icon-box--sm" aria-hidden="true">🛡️</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow">
              <span class="xp-row-card-title">${escapeHtml(e.action || "AUDIT_EVENT")}</span>
              ${xpeachBadge(outcome, outcomeTone)}
              ${xpeachBadge(e.actor_kind || "SYSTEM", "neutral")}
            </div>
            <div class="xp-row-card-meta">
              <span>👤 操作者：<code>${escapeHtml(e.actor_ref || "-")}</code></span>
              <span>🎯 资源：<code>${escapeHtml(e.resource_kind || "resource")}:${escapeHtml(String(e.resource_ref || "-").slice(0, 24))}</code></span>
              <span>🕒 ${escapeHtml(timeText)}</span>
              ${e.detail ? `<span>详情：<code>${escapeHtml(JSON.stringify(e.detail)).slice(0, 80)}</code></span>` : ""}
            </div>
          </div>
        </div>
      </article>`;
  }

  function renderFinanceMatrixCard() {
    if (!financeMatrix) return "";
    const matrixData =
      financeMatrix.data && typeof financeMatrix.data === "object" ? financeMatrix.data : financeMatrix;
    const scalarEntries = Object.entries(matrixData)
      .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
      .slice(0, 10);
    const jsonText = JSON.stringify(financeMatrix, null, 2) || "{}";
    return `
      <section class="xp-card" style="margin-bottom: 18px;">
        <div class="xp-entity-header" style="margin-bottom: 14px;">
          <div class="xp-icon-box xp-icon-box--success" aria-hidden="true">💹</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow" style="justify-content: space-between;">
              <h2 class="xp-entity-title">XPeach 财务大盘对账矩阵</h2>
              ${xpeachBadge("跨站实时同步", "success")}
            </div>
            <p class="xp-entity-summary" style="margin-top: 2px;">来自 XPeach 主站财务矩阵接口的站点级 🍑 结算汇总。</p>
          </div>
        </div>
        ${
          scalarEntries.length > 0
            ? `<div class="xp-well" style="margin-bottom: 12px; display: flex; flex-direction: column; gap: 6px;">
                ${scalarEntries
                  .map(
                    ([k, v]) =>
                      `<div class="xp-meta-row"><span>${escapeHtml(k)}：</span><strong>${escapeHtml(String(v))}</strong></div>`
                  )
                  .join("")}
              </div>`
            : ""
        }
        <details class="xp-well" style="margin: 0;">
          <summary class="text-xs text-muted" style="cursor: pointer;">查看原始矩阵 JSON</summary>
          <pre style="margin: 10px 0 0; white-space: pre-wrap; word-break: break-all; font-size: 12px;"><code>${escapeHtml(
            jsonText.length > 6000 ? `${jsonText.slice(0, 6000)}…` : jsonText
          )}</code></pre>
        </details>
      </section>`;
  }

  function renderSchoolsSection() {
    return `
      <section class="xp-card" style="margin-bottom: 18px;">
        <div class="xp-entity-header" style="margin-bottom: 14px;">
          <div class="xp-icon-box" aria-hidden="true">🏫</div>
          <div class="xp-entity-title-col">
            <h2 class="xp-entity-title">学校图书馆服务状态管理</h2>
            <p class="xp-entity-summary" style="margin-top: 2px;">当学校图书馆系统临时维护时，可在此一键开启/恢复预约保护熔断开关。</p>
          </div>
        </div>
        <div class="xp-row-list">
          ${
            schools.length === 0
              ? xpeachEmptyState({
                  icon: "🏫",
                  title: "暂无接入学校",
                  subtitle: "学校服务集成由部署配置下发。"
                })
              : schools.map((s) => xpeachSchoolControlCard(s)).join("")
          }
        </div>
      </section>`;
  }

  function renderDashboardView() {
    const stats = adminStats;
    return `
      <section class="xp-bento-grid" aria-label="站点运行指标">
        ${xpeachBentoTile({
          label: "已接入 XPeach 用户",
          value: String(stats.users_count ?? 0),
          hint: `已绑定学号：${stats.active_bindings_count ?? 0} 人`,
          badge: xpeachBadge("OIDC PKCE", "primary")
        })}
        ${xpeachBentoTile({
          label: "累计占座预约任务",
          value: String(stats.jobs_count ?? 0),
          hint: "三段式准点调度 (T-30m/T-5m/T)",
          badge: xpeachBadge("ADR-005", "success")
        })}
        ${xpeachBentoTile({
          label: "累计 🍑 结算账单",
          value: String(stats.orders_count ?? 0),
          hint: "实时上报 XPeach 主站账本",
          badge: xpeachBadge(`${pricePeachText} 🍑/次`, "peach")
        })}
        ${xpeachBentoTile({
          label: "全站同步快递包裹",
          value: String(stats.parcels_count ?? 0),
          hint: `安全审计记录：${stats.audit_events_count ?? 0} 条`,
          badge: xpeachBadge("KMS 加密", "primary")
        })}
      </section>

      ${renderSchoolsSection()}

      <section class="xp-card" style="margin-bottom: 18px;">
        <div class="xp-entity-header" style="margin-bottom: 14px;">
          <div class="xp-icon-box" aria-hidden="true">👥</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow" style="justify-content: space-between;">
              <h2 class="xp-entity-title">接入用户 (${allUsers.length})</h2>
              ${xpeachBadge("XPeach OIDC 接入", "primary")}
            </div>
            <p class="xp-entity-summary" style="margin-top: 2px;">已通过 XPeach 统一认证接入本站的全站用户与角色分配。</p>
          </div>
        </div>
        <div class="xp-row-list">
          ${
            allUsers.length === 0
              ? xpeachEmptyState({
                  icon: "👥",
                  title: "暂无接入用户",
                  subtitle: "用户通过 XPeach SSO 登录后自动接入。"
                })
              : allUsers.map((u) => renderAdminUserRow(u)).join("")
          }
        </div>
      </section>

      <section class="xp-card" style="margin-bottom: 18px;">
        <div class="xp-entity-header" style="margin-bottom: 14px;">
          <div class="xp-icon-box" aria-hidden="true">🛡️</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow" style="justify-content: space-between;">
              <h2 class="xp-entity-title">最近安全与操作审计记录</h2>
              <a class="xp-pill xp-pill--compact" href="/console/audit">查看全部 →</a>
            </div>
            <p class="xp-entity-summary" style="margin-top: 2px;">自动记录凭据加密托管、预约执行、社团云控变更与账单退还操作。</p>
          </div>
        </div>
        <div class="xp-row-list">
          ${
            auditEvents.length === 0
              ? xpeachEmptyState({
                  icon: "🛡️",
                  title: "暂无操作记录"
                })
              : auditEvents
                  .slice(0, 10)
                  .map((ev) => xpeachAuditRowCard(ev))
                  .join("")
          }
        </div>
      </section>

      ${renderFinanceMatrixCard()}`;
  }

  function renderJobsView() {
    return `
      <section class="xp-card" id="section-jobs" style="margin-bottom: 18px;">
        <div class="xp-entity-header" style="margin-bottom: 14px;">
          <div class="xp-icon-box" aria-hidden="true">💺</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow" style="justify-content: space-between;">
              <h2 class="xp-entity-title">全站预约任务 (${allJobs.length})</h2>
              ${xpeachBadge("三段式准点调度", "primary")}
            </div>
            <p class="xp-entity-summary" style="margin-top: 2px;">按状态筛选或搜索任务 ID、用户名与计划标识，监控占座任务执行结果。</p>
          </div>
        </div>
        <div class="xp-search-bar" style="margin-bottom: 12px;">
          <input class="input xp-search-input" id="jobs-search" type="search" placeholder="搜索任务 ID、用户名、计划或日期…" />
          <div class="xp-pill-bar" id="jobs-state-pills">
            <button type="button" class="xp-pill xp-pill--compact xp-pill--active" data-job-state-filter="ALL">全部 (${allJobs.length})</button>
            <button type="button" class="xp-pill xp-pill--compact" data-job-state-filter="ACTIVE">进行中</button>
            <button type="button" class="xp-pill xp-pill--compact" data-job-state-filter="CONFIRMED">已成功</button>
            <button type="button" class="xp-pill xp-pill--compact" data-job-state-filter="FAILED">失败</button>
            <button type="button" class="xp-pill xp-pill--compact" data-job-state-filter="CANCELLED">已取消</button>
            <button type="button" class="xp-pill xp-pill--compact" data-job-state-filter="EXPIRED">已过期</button>
          </div>
        </div>
        <div class="xp-row-list" id="jobs-admin-list">
          ${
            allJobs.length === 0
              ? xpeachEmptyState({
                  icon: "💺",
                  title: "暂无预约任务",
                  subtitle: "用户在客户端创建占座计划后将在此列出。"
                })
              : allJobs.map((j) => renderAdminJobRow(j)).join("")
          }
        </div>
      </section>

      ${
        allEvents
          ? `<section class="xp-card">
        <div class="xp-entity-header" style="margin-bottom: 14px;">
          <div class="xp-icon-box" aria-hidden="true">⏱️</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow" style="justify-content: space-between;">
              <h2 class="xp-entity-title">调度事件 (${allEvents.length})</h2>
              ${xpeachBadge("PRECHECK · FINAL_CHECK · FIRE", "primary")}
            </div>
            <p class="xp-entity-summary" style="margin-top: 2px;">每个占座任务的三段式持久化调度事件与诊断状态。</p>
          </div>
        </div>
        <div class="xp-row-list">
          ${
            allEvents.length === 0
              ? xpeachEmptyState({
                  icon: "⏱️",
                  title: "暂无调度事件",
                  subtitle: "任务创建后会生成预检、终检与执行三条调度事件。"
                })
              : allEvents.map((ev) => renderScheduleEventRow(ev)).join("")
          }
        </div>
      </section>`
          : ""
      }`;
  }

  function renderOrdersAdminView() {
    return `
      <section class="xp-card" style="margin-bottom: 18px;">
        <div class="xp-entity-header" style="margin-bottom: 14px;">
          <div class="xp-icon-box xp-icon-box--peach" aria-hidden="true">🍑</div>
          <div class="xp-entity-title-col">
            <h2 class="xp-entity-title">全站消费账单对账与一键退还</h2>
            <p class="xp-entity-summary" style="margin-top: 2px;">每一笔扣费与退还均通过幂等密钥实时同步至 XPeach 主站用户钱包与跨站财务大盘。</p>
          </div>
        </div>
        <div class="xp-row-list">
          ${
            allOrders.length === 0
              ? xpeachEmptyState({
                  icon: "🍑",
                  title: "暂无全站 🍑 消费账单记录"
                })
              : allOrders
                  .map((o) =>
                    xpeachOrderRowCard(o, {
                      isAdmin: true,
                      pricingMicropeach,
                      micropeachPerPeach: MICROPEACH_PER_PEACH
                    })
                  )
                  .join("")
          }
        </div>
      </section>

      ${renderFinanceMatrixCard()}`;
  }

  function renderAuditView() {
    return `
      <section class="xp-card" id="section-audit">
        <div class="xp-entity-header" style="margin-bottom: 14px;">
          <div class="xp-icon-box" aria-hidden="true">🛡️</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow" style="justify-content: space-between;">
              <h2 class="xp-entity-title">安全与操作审计日志 (${auditEvents.length})</h2>
              ${xpeachBadge("服务端已脱敏", "success")}
            </div>
            <p class="xp-entity-summary" style="margin-top: 2px;">按操作者、动作、资源或结果关键字检索全站审计事件。</p>
          </div>
        </div>
        <div class="xp-search-bar" style="margin-bottom: 12px;">
          <input class="input xp-search-input" id="audit-search" type="search" placeholder="搜索操作者、动作、资源或结果…" />
        </div>
        <div class="xp-row-list" id="audit-admin-list">
          ${
            auditEvents.length === 0
              ? xpeachEmptyState({
                  icon: "🛡️",
                  title: "暂无审计事件",
                  subtitle: "管理操作与系统事件将自动记录在此。"
                })
              : auditEvents.map((ev) => renderAdminAuditRow(ev)).join("")
          }
        </div>
      </section>`;
  }

  function renderSchoolsView() {
    const schoolOptions =
      schools.length > 0
        ? schools
            .map(
              (s) =>
                `<option value="${escapeHtml(s.school_id || "haut")}">${escapeHtml(s.display_name || s.school_id || "河南工业大学")} (${escapeHtml(s.school_id || "haut")})</option>`
            )
            .join("")
        : `<option value="haut">河南工业大学 (haut)</option>`;
    return `
      ${renderSchoolsSection()}

      <section class="xp-card">
        <div class="xp-entity-header" style="margin-bottom: 14px;">
          <div class="xp-icon-box xp-icon-box--peach" aria-hidden="true">✅</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow" style="justify-content: space-between;">
              <h2 class="xp-entity-title">运维授权审批</h2>
              ${xpeachBadge("双人复核", "peach")}
            </div>
            <p class="xp-entity-summary" style="margin-top: 2px;">提交学校级敏感操作（如恢复熔断、批量变更）的二级授权审批记录。</p>
          </div>
        </div>
        <div class="xp-well" style="padding: 16px;">
          <div class="xp-form-grid-3">
            <div class="field">
              <label class="label" for="aa-school">目标学校</label>
              <select class="input" id="aa-school">${schoolOptions}</select>
            </div>
            <div class="field">
              <label class="label" for="aa-approver">二级审批人标识</label>
              <input class="input" id="aa-approver" type="text" placeholder="如 admin:liwei 或 owner:yellowpeach" />
            </div>
            <div class="field">
              <label class="label" for="aa-evidence">授权凭证引用</label>
              <input class="input" id="aa-evidence" type="text" placeholder="如 ticket-2026-0001 / 审批单链接" />
            </div>
          </div>
          <div class="xp-action-bar">
            <span class="text-xs text-muted">POST /api/v1/admin/schools/{schoolId}/authorization-approval</span>
            <button type="button" class="xp-pill xp-pill--active" id="btn-submit-auth-approval">提交授权审批</button>
          </div>
        </div>
      </section>`;
  }

  function renderContentView() {
    return `
      <section class="xp-card" id="section-campus-content-admin" style="margin-bottom: 18px;">
        <div class="xp-entity-header" style="margin-bottom: 16px;">
          <div class="xp-icon-box" aria-hidden="true">📢</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow" style="justify-content: space-between;">
              <h2 class="xp-entity-title">合作社团与校园频道云控中心 (实时热更新)</h2>
              ${xpeachBadge(`云控 v${campusContent.version || 2} · ${ccClubs.length} 社团 / ${ccChannels.length} 频道`, "success")}
            </div>
            <p class="xp-entity-summary" style="margin-top: 2px;">在后台动态新增、置顶、隐藏或修改合作社团 QQ 群号与校园频道，保存后所有「日在校园」Android 客户端与网页端实时生效。</p>
          </div>
        </div>

        <!-- 1. 顶部社区横幅公告云控 -->
        <div class="xp-well" style="padding: 16px; margin-bottom: 18px;">
          <div class="xp-badge-flow" style="justify-content: space-between; margin-bottom: 10px;">
            <h3 class="xp-entity-title" style="font-size: 15px;">1. 社区顶部横幅公告 (App 与网页端置顶展示)</h3>
            ${xpeachBadge(ccBulletin.enabled !== false ? "当前已启用" : "当前已隐藏", ccBulletin.enabled !== false ? "primary" : "neutral")}
          </div>
          <div class="xp-form-grid-3">
            <div class="field">
              <label class="label" for="cc-bulletin-title">公告标题</label>
              <input class="input" id="cc-bulletin-title" type="text" value="${escapeHtml(ccBulletin.title || "")}" placeholder="例如：河工大合作社团与交流群云端直通车" />
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
          <div class="xp-action-bar">
            <span class="text-xs text-muted">保存后将自动递增云控版本号并同步至全端</span>
            <button type="button" class="xp-pill xp-pill--active" id="btn-save-bulletin">保存并下发横幅公告</button>
          </div>
        </div>

        <!-- 2. 合作社团名录云控管理 (5层无遮挡卡片网格 + 编辑表单) -->
        <div class="xp-well" style="padding: 16px; margin-bottom: 18px;">
          <div class="xp-badge-flow" style="justify-content: space-between; margin-bottom: 12px;">
            <h3 class="xp-entity-title" style="font-size: 15px;">2. 合作社团名录云控管理 (${ccClubs.length} 个社团)</h3>
            ${xpeachStatusDot("与 Android 社团卡片 1:1 视觉对齐", "success")}
          </div>
          <div class="xp-card-grid" style="margin-bottom: 16px;">
            ${
              ccClubs.length === 0
                ? xpeachEmptyState({
                    icon: "🤝",
                    title: "暂无学生社团配置",
                    subtitle: "在下方填写社团名称与 QQ 群号即可新增并实时下发。"
                  })
                : ccClubs.map((cl) => xpeachClubCard(cl, { isAdmin: true })).join("")
            }
          </div>
          <div class="xp-form-grid-3">
            <div class="field">
              <label class="label" for="cc-club-id">社团 ID (编辑自动填入，留空自动生成)</label>
              <input class="input" id="cc-club-id" type="text" placeholder="如 club_partner_chiyekong_acg" />
            </div>
            <div class="field">
              <label class="label" for="cc-club-name">社团名称</label>
              <input class="input" id="cc-club-name" type="text" placeholder="如 炽夜空动漫社" />
            </div>
            <div class="field">
              <label class="label" for="cc-club-category">社团分类</label>
              <select class="input" id="cc-club-category">
                <option value="TECH_INNOVATION">科技创新</option>
                <option value="ART_PERFORMANCE">文艺展演</option>
                <option value="ACADEMIC_CULTURE">学术文化</option>
                <option value="SPORTS_FITNESS">体育竞技</option>
                <option value="VOLUNTEER_ORG">志愿与组织</option>
              </select>
            </div>
            <div class="field">
              <label class="label" for="cc-club-qq">纳新/交流 QQ 群号</label>
              <input class="input" id="cc-club-qq" type="text" placeholder="如 314623763" />
            </div>
            <div class="field">
              <label class="label" for="cc-club-unit">挂靠/指导单位</label>
              <input class="input" id="cc-club-unit" type="text" placeholder="如 校团委社团管理部" />
            </div>
            <div class="field">
              <label class="label" for="cc-club-venue">常规活动场地</label>
              <input class="input" id="cc-club-venue" type="text" placeholder="如 大学生活动中心" />
            </div>
            <div class="field">
              <label class="label" for="cc-club-highlights">亮点标签 (逗号分隔)</label>
              <input class="input" id="cc-club-highlights" type="text" placeholder="如 合作社团,动漫文化节,Cosplay/宅舞" />
            </div>
            <div class="field">
              <label class="label" for="cc-club-sort">排序权重 (越小越靠前)</label>
              <input class="input" id="cc-club-sort" type="number" value="10" />
            </div>
          </div>
          <div class="field" style="margin-top: 10px;">
            <label class="label" for="cc-club-summary">社团活动简介</label>
            <input class="input" id="cc-club-summary" type="text" placeholder="简要介绍社团主要活动方向与技术交流内容" />
          </div>
          <div class="xp-action-bar">
            <span class="text-xs text-muted">点击上方社团卡片的「编辑/改群号」可快速回填表单</span>
            <button type="button" class="xp-pill xp-pill--active" id="btn-save-club">新增 / 更新合作社团</button>
          </div>
        </div>

        <!-- 3. 学科竞赛清单与专业发展指南云控管理 -->
        <div class="xp-well" style="padding: 16px; margin-bottom: 18px;">
          <div class="xp-badge-flow" style="justify-content: space-between; margin-bottom: 12px;">
            <h3 class="xp-entity-title" style="font-size: 15px;">3. 学科竞赛清单与专业指南云控管理 (${ccCompetitions.length} 项赛事)</h3>
            ${xpeachBadge("支持按专业赛道与合作社团联动下发", "peach")}
          </div>
          <div class="xp-card-grid" style="margin-bottom: 16px;">
            ${
              ccCompetitions.length === 0
                ? xpeachEmptyState({
                    icon: "🏆",
                    title: "暂无学科竞赛配置",
                    subtitle: "在下方表单填写竞赛名称与官网链接即可新增并实时下发。"
                  })
                : ccCompetitions.map((cp) => xpeachCompetitionCard(cp, { isAdmin: true })).join("")
            }
          </div>
          <div class="xp-form-grid-3">
            <div class="field">
              <label class="label" for="cc-comp-id">竞赛 ID (编辑自动填入，留空自动生成)</label>
              <input class="input" id="cc-comp-id" type="text" placeholder="如 comp_lanqiao" />
            </div>
            <div class="field">
              <label class="label" for="cc-comp-title">竞赛完整名称</label>
              <input class="input" id="cc-comp-title" type="text" placeholder="如 蓝桥杯全国软件和信息技术专业人才大赛" />
            </div>
            <div class="field">
              <label class="label" for="cc-comp-short">竞赛简称</label>
              <input class="input" id="cc-comp-short" type="text" placeholder="如 蓝桥杯" />
            </div>
            <div class="field">
              <label class="label" for="cc-comp-tier">赛事级别徽标</label>
              <input class="input" id="cc-comp-tier" type="text" value="教育部白名单 A 类赛事" />
            </div>
            <div class="field">
              <label class="label" for="cc-comp-category">兴趣发展分类</label>
              <select class="input" id="cc-comp-category">
                <option value="ALGO_PROGRAMMING">算法与程序设计</option>
                <option value="ELECTRONICS_ROBO">电子与机器人硬件</option>
                <option value="MATH_MODELING">数学建模与数据分析</option>
                <option value="INNOVATION_ENTREPRENEURSHIP">创新创业与双创孵化</option>
                <option value="CYBER_SECURITY_AI">网安与人工智能</option>
                <option value="DIGITAL_MEDIA_ART">数媒创意与外语综合</option>
              </select>
            </div>
            <div class="field">
              <label class="label" for="cc-comp-url">官方网站 (HTTPS)</label>
              <input class="input" id="cc-comp-url" type="url" placeholder="https://dasai.lanqiao.cn" />
            </div>
            <div class="field">
              <label class="label" for="cc-comp-majors">适合专业赛道 (逗号分隔枚举)</label>
              <input class="input" id="cc-comp-majors" type="text" placeholder="CS_AI_SOFTWARE,EE_AUTOMATION_IOT,ALL_MAJORS" />
            </div>
            <div class="field">
              <label class="label" for="cc-comp-tags">能力/兴趣标签 (逗号分隔)</label>
              <input class="input" id="cc-comp-tags" type="text" placeholder="算法编程,单片机/EDA,保研加分" />
            </div>
            <div class="field">
              <label class="label" for="cc-comp-window">报名与赛程时间窗</label>
              <input class="input" id="cc-comp-window" type="text" placeholder="每年 10月–12月报名 · 次年 4月省赛" />
            </div>
            <div class="field">
              <label class="label" for="cc-comp-college">校内承办学院</label>
              <input class="input" id="cc-comp-college" type="text" placeholder="信息科学与工程学院" />
            </div>
            <div class="field">
              <label class="label" for="cc-comp-club-name">关联组队合作社团名称</label>
              <input class="input" id="cc-comp-club-name" type="text" placeholder="如 计算机服务社 / 硬件技术联盟" />
            </div>
            <div class="field">
              <label class="label" for="cc-comp-club-qq">关联社团 QQ 群号</label>
              <input class="input" id="cc-comp-club-qq" type="text" placeholder="如 1043885481" />
            </div>
          </div>
          <div class="xp-form-grid-3" style="margin-top: 10px;">
            <div class="field" style="grid-column: span 2;">
              <label class="label" for="cc-comp-roadmap">备赛成长路线</label>
              <input class="input" id="cc-comp-roadmap" type="text" placeholder="从零基础入门到冲奖的学习路径建议" />
            </div>
            <div class="field">
              <label class="label" for="cc-comp-sort">排序权重</label>
              <input class="input" id="cc-comp-sort" type="number" value="20" />
            </div>
          </div>
          <div class="field" style="margin-top: 10px;">
            <label class="label" for="cc-comp-summary">赛事简介与参赛价值</label>
            <input class="input" id="cc-comp-summary" type="text" placeholder="介绍赛事含金量、考察形式与适合人群" />
          </div>
          <div class="xp-action-bar">
            <span class="text-xs text-muted">保存后实时同步下发至全校 Android 客户端与网页端「竞赛指南」</span>
            <button type="button" class="xp-pill xp-pill--active" id="btn-save-comp">新增 / 更新学科竞赛</button>
          </div>
        </div>

        <!-- 4. 校园频道云控管理 -->
        <div class="xp-well" style="padding: 16px;">
          <div class="xp-badge-flow" style="justify-content: space-between; margin-bottom: 12px;">
            <h3 class="xp-entity-title" style="font-size: 15px;">4. 校园频道云控列表 (${ccChannels.length} 个频道 · 当前默认置空)</h3>
            ${xpeachBadge(ccChannels.length === 0 ? "已置空" : `${ccChannels.length} 个启用`, "neutral")}
          </div>
          ${
            ccChannels.length === 0
              ? `<p class="text-xs text-muted" style="margin: 0 0 12px;">当前校园频道处于置空状态（客户端展示空状态提示）。如需后续开放频道，可在下方表单新增。</p>`
              : `<div class="xp-card-grid" style="margin-bottom: 14px;">${ccChannels.map((ch) => xpeachChannelCard(ch, { isAdmin: true })).join("")}</div>`
          }
          <div class="xp-form-grid-3">
            <div class="field">
              <label class="label" for="cc-ch-id">频道 ID (选填)</label>
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
              <label class="label" for="cc-ch-sort">排序权重</label>
              <input class="input" id="cc-ch-sort" type="number" value="10" />
            </div>
          </div>
          <div class="xp-action-bar">
            <span class="text-xs text-muted">频道列表为空时，App 自动展示「校园频道暂时置空」卡片</span>
            <button type="button" class="xp-pill" id="btn-save-channel">新增 / 更新校园频道</button>
          </div>
        </div>
      </section>`;
  }

  const activeMainHtml =
    activeNav === "jobs"
      ? renderJobsView()
      : activeNav === "orders"
        ? renderOrdersAdminView()
        : activeNav === "audit"
          ? renderAuditView()
          : activeNav === "schools"
            ? renderSchoolsView()
            : activeNav === "content"
              ? renderContentView()
              : renderDashboardView();

  return `${renderHead("日在校园 · 运维管理控制台")}
  <body class="console-body">
    ${renderHiddenContractViews()}
    <div class="mobile-topbar">
      <a class="brand" href="/">
        <img src="/static/xpeach-logo.png" alt="XPeach" class="brand-logo brand-logo--sm" width="28" height="28" />
        <span class="brand-title">XPeach · 日在校园</span>
      </a>
      <div class="mobile-topbar-actions">
        <button type="button" class="xp-pill xp-pill--compact" data-ui-style-toggle title="切换液态毛玻璃 / 经典 M3">
          <span data-ui-style-label>✨ 毛玻璃</span>
        </button>
        <button type="button" class="icon-btn theme-toggle" data-theme-toggle aria-label="切换明暗主题">
          <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4"></circle>
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path>
          </svg>
          <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
          </svg>
        </button>
      </div>
    </div>

    <div class="console-shell">
      <aside class="sidebar" id="console-sidebar" aria-label="主导航">
        <div class="sidebar-top">
          <a class="brand" href="/">
            <img src="/static/xpeach-logo.png" alt="XPeach" class="brand-logo brand-logo--md" width="34" height="34" />
            <div class="brand-copy">
              <span class="brand-title">XPeach</span>
              <span class="brand-caption">日在校园</span>
            </div>
          </a>
          ${xpeachBadge(isAdmin ? "运维管理" : "只读访客", "primary")}
        </div>

        <nav class="sidebar-nav">
          <div class="nav-section">
            <div class="nav-section-title">站点管理</div>
            <a class="nav-item ${activeNav === "console" ? "active" : ""}" href="/console">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
              <span>运维总览</span>
            </a>
            <a class="nav-item ${activeNav === "jobs" ? "active" : ""}" href="/console/jobs">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>
              <span>预约任务</span>
            </a>
            <a class="nav-item ${activeNav === "orders" ? "active" : ""}" href="/console/orders">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
              <span>账单退还</span>
            </a>
            <a class="nav-item ${activeNav === "audit" ? "active" : ""}" href="/console/audit">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              <span>审计日志</span>
            </a>
            <a class="nav-item ${activeNav === "schools" ? "active" : ""}" href="/console/schools">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/></svg>
              <span>学校服务</span>
            </a>
            <a class="nav-item ${activeNav === "content" ? "active" : ""}" href="/console/content">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>
              <span>内容云控</span>
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
        </nav>

        <div class="sidebar-foot">
          <div class="user-card">
            <div class="user-avatar">${escapeHtml(userInitial)}</div>
            <div class="user-meta">
              <div class="user-name">${escapeHtml(username)}</div>
              <div class="user-role">${escapeHtml(userRoleLabel)}</div>
            </div>
            <div class="sidebar-foot-actions">
              <button type="button" class="icon-btn theme-toggle" data-theme-toggle aria-label="切换明暗主题" title="切换明暗主题">
                <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="4"></circle>
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path>
                </svg>
                <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
                </svg>
              </button>
              <a class="icon-btn user-logout-btn" href="/api/v1/auth/web/logout" title="退出登录" aria-label="退出登录">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                  <path d="M16 17l5-5-5-5"></path>
                  <path d="M21 12H9"></path>
                </svg>
              </a>
            </div>
          </div>
        </div>
      </aside>

      <main class="console-main">
        <header class="page-head">
          <div>
            <h1 class="page-title">${escapeHtml(pageHeaderConfig.title)}</h1>
            <p class="page-subtitle">${escapeHtml(pageHeaderConfig.subtitle)}</p>
          </div>
          <div class="xp-action-group">
            <button type="button" class="xp-pill xp-pill--compact" data-ui-style-toggle title="切换液态毛玻璃 / 经典 M3 视觉语言">
              <span data-ui-style-label>✨ 液态毛玻璃</span>
            </button>
            <a class="xp-pill xp-pill--compact" href="https://sso.xpeach.codes/portal">XPeach 主站 ↗</a>
          </div>
        </header>

        <div id="toast-banner" class="alert alert-success" style="display:none;margin-bottom:16px;"></div>

        ${activeMainHtml}
      </main>
    </div>

    <nav class="mobile-glass-dock" aria-label="快捷导航">
      <a class="mobile-dock-item ${activeNav === "console" ? "active" : ""}" href="/console">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
        <span>总览</span>
      </a>
      <a class="mobile-dock-item ${activeNav === "jobs" ? "active" : ""}" href="/console/jobs">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>
        <span>任务</span>
      </a>
      <a class="mobile-dock-item ${activeNav === "orders" ? "active" : ""}" href="/console/orders">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        <span>账单</span>
      </a>
      <a class="mobile-dock-item ${activeNav === "audit" ? "active" : ""}" href="/console/audit">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        <span>审计</span>
      </a>
      <a class="mobile-dock-item ${activeNav === "content" ? "active" : ""}" href="/console/content">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>
        <span>云控</span>
      </a>
    </nav>

    <script src="/static/app.js?v=${CONSOLE_UI_VERSION}" defer></script>
    <script>
      (function () {
        var SERVER_TOKEN = ${JSON.stringify(accessToken).replace(/</g, "\\u003c")};
        var PRICE_PEACH_TEXT = ${JSON.stringify(pricePeachText)};
        function escHtml(v) {
          return String(v == null ? "" : v)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }

        // Liquid Glass / Flutter M3 UI style switcher
        function syncAllStyleLabels() {
          var cur = document.documentElement.getAttribute("data-ui-style") || "liquid-glass";
          document.querySelectorAll("[data-ui-style-label]").forEach(function (el) {
            el.textContent = cur === "liquid-glass" ? "✨ 液态毛玻璃" : "🎨 经典 M3";
          });
        }
        syncAllStyleLabels();
        document.querySelectorAll("[data-ui-style-toggle]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var cur = document.documentElement.getAttribute("data-ui-style") || "liquid-glass";
            var next = cur === "liquid-glass" ? "flutter-m3" : "liquid-glass";
            document.documentElement.setAttribute("data-ui-style", next);
            try { localStorage.setItem("xpeach-ui-style", next); } catch (e) {}
            syncAllStyleLabels();
          });
        });

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

        // Clean up ?web_ticket query param if present
        if (window.location.search.indexOf("web_ticket=") !== -1) {
          window.history.replaceState({}, document.title, window.location.pathname || "/");
        }

        // Copy QQ Group on admin club / competition cards
        document.querySelectorAll("[data-copy-qq]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var qq = btn.getAttribute("data-copy-qq") || "";
            var name = btn.getAttribute("data-copy-club-name") || "合作社团";
            if (navigator.clipboard && qq) {
              navigator.clipboard.writeText(qq).catch(function () {});
            }
            showToast("已复制「" + name + "」官方 QQ 群号：" + qq);
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
                showToast("已将 " + PRICE_PEACH_TEXT + " 🍑 原路退还至用户 XPeach 账户！");
                setTimeout(function () { window.location.reload(); }, 600);
              })
              .catch(function (err) {
                btn.disabled = false;
                btn.textContent = "退还 🍑";
                showToast(err.message, true);
              });
          });
        });

        // Admin: jobs table state pills + text search
        var jobsSearchInput = document.getElementById("jobs-search");
        var activeJobStateFilter = "ALL";
        var TERMINAL_JOB_STATES = ["CONFIRMED", "FAILED", "CANCELLED", "EXPIRED"];
        function filterAdminJobs() {
          var q = jobsSearchInput ? jobsSearchInput.value.trim().toLowerCase() : "";
          document.querySelectorAll("[data-job-row]").forEach(function (row) {
            var st = row.getAttribute("data-job-state") || "";
            var haystack = row.getAttribute("data-job-search") || "";
            var stOk =
              activeJobStateFilter === "ALL" ||
              (activeJobStateFilter === "ACTIVE"
                ? TERMINAL_JOB_STATES.indexOf(st) === -1
                : st === activeJobStateFilter);
            var qOk = !q || haystack.indexOf(q) !== -1;
            row.style.display = stOk && qOk ? "" : "none";
          });
        }
        if (jobsSearchInput) {
          jobsSearchInput.addEventListener("input", filterAdminJobs);
        }
        document.querySelectorAll("[data-job-state-filter]").forEach(function (pill) {
          pill.addEventListener("click", function () {
            activeJobStateFilter = pill.getAttribute("data-job-state-filter") || "ALL";
            document.querySelectorAll("[data-job-state-filter]").forEach(function (p) {
              p.classList.toggle("xp-pill--active", p === pill);
            });
            filterAdminJobs();
          });
        });

        // Admin: audit table text search
        var auditSearchInput = document.getElementById("audit-search");
        function filterAuditRows() {
          var q = auditSearchInput ? auditSearchInput.value.trim().toLowerCase() : "";
          document.querySelectorAll("[data-audit-row]").forEach(function (row) {
            var haystack = row.getAttribute("data-audit-search") || "";
            row.style.display = !q || haystack.indexOf(q) !== -1 ? "" : "none";
          });
        }
        if (auditSearchInput) {
          auditSearchInput.addEventListener("input", filterAuditRows);
        }

        // Admin: school authorization-approval submission
        var btnAuthApproval = document.getElementById("btn-submit-auth-approval");
        if (btnAuthApproval) {
          btnAuthApproval.addEventListener("click", function () {
            var schoolEl = document.getElementById("aa-school");
            var schoolId = ((schoolEl && schoolEl.value) || "haut").trim();
            var approver = (document.getElementById("aa-approver").value || "").trim();
            var evidence = (document.getElementById("aa-evidence").value || "").trim();
            if (!approver || !evidence) {
              showToast("请填写二级审批人标识与授权凭证引用", true);
              return;
            }
            btnAuthApproval.disabled = true;
            apiFetch(
              "/api/v1/admin/schools/" + encodeURIComponent(schoolId) + "/authorization-approval",
              {
                method: "POST",
                body: JSON.stringify({
                  secondary_approver_ref: approver,
                  authorization_evidence_ref: evidence
                })
              }
            )
              .then(function () {
                showToast("授权审批已提交并记录审计！");
                setTimeout(function () { window.location.reload(); }, 600);
              })
              .catch(function (err) {
                btnAuthApproval.disabled = false;
                showToast(err.message, true);
              });
          });
        }

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
                showToast("合作社团信息已保存并实时下发！");
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

        var btnSaveComp = document.getElementById("btn-save-comp");
        if (btnSaveComp) {
          btnSaveComp.addEventListener("click", function () {
            var title = (document.getElementById("cc-comp-title").value || "").trim();
            if (!title) {
              showToast("请填写学科竞赛名称", true);
              return;
            }
            btnSaveComp.disabled = true;
            apiFetch("/api/v1/admin/campus-content/competitions", {
              method: "POST",
              body: JSON.stringify({
                school_id: "haut",
                id: (document.getElementById("cc-comp-id").value || "").trim() || undefined,
                title: title,
                short_title: (document.getElementById("cc-comp-short").value || title).trim(),
                tier_badge: (document.getElementById("cc-comp-tier").value || "教育部白名单 A 类赛事").trim(),
                category: document.getElementById("cc-comp-category").value || "INNOVATION_ENTREPRENEURSHIP",
                official_website_url: (document.getElementById("cc-comp-url").value || "").trim(),
                recommended_major_tracks: (document.getElementById("cc-comp-majors").value || "ALL_MAJORS").trim(),
                interest_tags: (document.getElementById("cc-comp-tags").value || "").trim(),
                registration_window: (document.getElementById("cc-comp-window").value || "").trim(),
                haut_host_college: (document.getElementById("cc-comp-college").value || "").trim(),
                partner_club_name: (document.getElementById("cc-comp-club-name").value || "").trim(),
                partner_club_qq: (document.getElementById("cc-comp-club-qq").value || "").trim(),
                skill_roadmap: (document.getElementById("cc-comp-roadmap").value || "").trim(),
                summary: (document.getElementById("cc-comp-summary").value || "").trim(),
                sort_order: Number(document.getElementById("cc-comp-sort").value || 20)
              })
            })
              .then(function () {
                showToast("学科竞赛信息已保存并实时下发！");
                setTimeout(function () { window.location.reload(); }, 500);
              })
              .catch(function (err) {
                btnSaveComp.disabled = false;
                showToast(err.message, true);
              });
          });
        }

        document.querySelectorAll("[data-edit-comp]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            try {
              var cp = JSON.parse(btn.getAttribute("data-edit-comp"));
              document.getElementById("cc-comp-id").value = cp.id || "";
              document.getElementById("cc-comp-title").value = cp.title || "";
              document.getElementById("cc-comp-short").value = cp.short_title || "";
              document.getElementById("cc-comp-tier").value = cp.tier_badge || "教育部白名单 A 类赛事";
              document.getElementById("cc-comp-category").value = cp.category || "INNOVATION_ENTREPRENEURSHIP";
              document.getElementById("cc-comp-url").value = cp.official_website_url || "";
              document.getElementById("cc-comp-majors").value = (cp.recommended_major_tracks || []).join(",");
              document.getElementById("cc-comp-tags").value = (cp.interest_tags || []).join(",");
              document.getElementById("cc-comp-window").value = cp.registration_window || "";
              document.getElementById("cc-comp-college").value = cp.haut_host_college || "";
              document.getElementById("cc-comp-club-name").value = cp.partner_club_name || "";
              document.getElementById("cc-comp-club-qq").value = cp.partner_club_qq || "";
              document.getElementById("cc-comp-roadmap").value = cp.skill_roadmap || "";
              document.getElementById("cc-comp-summary").value = cp.summary || "";
              document.getElementById("cc-comp-sort").value = cp.sort_order || 20;
              document.getElementById("cc-comp-title").focus();
            } catch (e) {}
          });
        });

        document.querySelectorAll("[data-toggle-pin-comp]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var cp = JSON.parse(btn.getAttribute("data-toggle-pin-comp"));
            apiFetch("/api/v1/admin/campus-content/competitions", {
              method: "POST",
              body: JSON.stringify({ id: cp.id, title: cp.title, pinned: !cp.pinned })
            }).then(function () {
              showToast(!cp.pinned ? "已置顶竞赛" : "已取消置顶");
              setTimeout(function () { window.location.reload(); }, 400);
            });
          });
        });

        document.querySelectorAll("[data-toggle-enable-comp]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var cp = JSON.parse(btn.getAttribute("data-toggle-enable-comp"));
            var nextEnabled = cp.enabled === false;
            apiFetch("/api/v1/admin/campus-content/competitions", {
              method: "POST",
              body: JSON.stringify({ id: cp.id, title: cp.title, enabled: nextEnabled })
            }).then(function () {
              showToast(nextEnabled ? "已启用竞赛展示" : "已隐藏竞赛");
              setTimeout(function () { window.location.reload(); }, 400);
            });
          });
        });

        document.querySelectorAll("[data-delete-comp]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var id = btn.getAttribute("data-delete-comp");
            apiFetch("/api/v1/admin/campus-content/competitions/" + encodeURIComponent(id), {
              method: "DELETE"
            }).then(function () {
              showToast("竞赛已删除");
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
  const securityHeaders = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin"
  };
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { ...securityHeaders, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "console", views: CONSOLE_VIEWS.length }));
      return;
    }
    res.writeHead(200, { ...securityHeaders, "content-type": "text/html; charset=utf-8" });
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
