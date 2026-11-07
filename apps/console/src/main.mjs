import http from "node:http";
import {
  DEFAULT_RESERVATION_PRICE_MICROPEACH,
  MICROPEACH_PER_PEACH,
  formatPeachFromMicropeach,
  getReservationPriceVersion
} from "../../../packages/contracts/src/index.mjs";
import {
  cleanDisplayText,
  escapeHtml,
  xpeachBadge,
  xpeachStatusDot,
  xpeachBentoTile,
  xpeachEmptyState,
  xpeachBulletinHeroCard,
  xpeachClubCard,
  xpeachChannelCard,
  xpeachCompetitionCard,
  xpeachJobRowCard,
  xpeachParcelRowCard,
  xpeachOrderRowCard,
  xpeachSchoolControlCard,
  xpeachAuditRowCard
} from "./ui-sdk.mjs";

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

function renderHiddenContractViews() {
  return `<template id="contract-views-marker" hidden>${CONSOLE_VIEWS.map(
    (v) => `<section id="view-${v.id}" data-role="${v.role}"></section>`
  ).join("")}</template>`;
}

function renderHead(title = "日在校园 · XPeach 云端通行证") {
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
          var uiStyle = ["liquid-glass", "flutter-m3", "fresh-breeze", "cream-pastel"].includes(savedStyle) ? savedStyle : "liquid-glass";
          document.documentElement.setAttribute("data-ui-style", uiStyle);
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
    <link rel="stylesheet" href="/static/xpeach-sdk.css" />
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
        var target = ${JSON.stringify(customSchemeUrl).replace(/</g, "\\u003c")};
        setTimeout(function () {
          window.location.href = target;
        }, 180);
      })();
    </script>
  </body>
</html>`;
}

function renderUnauthenticatedLandingHtml(pricePeachText = "1") {
  return `${renderHead("日在校园 · XPeach 云端通行证")}
  <body class="auth-body">
    ${renderHiddenContractViews()}
    <header class="auth-toolbar" aria-label="偏好设置">
      <div class="auth-toolbar-inner" style="display:flex;gap:8px;align-items:center;">
        <button type="button" class="xp-pill xp-pill--compact" data-ui-style-toggle title="切换 Flutter M3 / 液态毛玻璃设计风格">
          <span data-ui-style-label>✨ 液态毛玻璃</span>
        </button>
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
            <span class="brand-sub">日在校园</span>
          </div>
        </a>
      </header>
      <main class="card auth-window xp-card">
        <div class="auth-header">
          <div class="auth-eyebrow">XPeach 账号登录</div>
          <h1 class="auth-title">日在校园</h1>
          <p class="auth-subtitle" id="landing-subtitle">使用 XPeach 账号登录，管理图书馆座位预约、快递取件码与校园社团。</p>
        </div>

        <div class="stack gap-3">
          <a class="btn btn-primary btn-block btn-lg" id="sso-login-btn" href="/api/v1/auth/web/start">
            使用 XPeach 账号登录
          </a>
          <a class="btn btn-secondary btn-block btn-lg" href="https://sso.xpeach.codes/portal">
            返回 XPeach 账户中心
          </a>
        </div>

        <div class="auth-divider"><span>功能概览</span></div>

        <div class="xp-card-grid" style="grid-template-columns: repeat(auto-fit, minmax(185px, 1fr)); gap: 10px;">
          <div class="xp-well">
            <div class="xp-entity-title" style="font-size: 14px;">图书馆座位预约</div>
            <p class="xp-entity-summary" style="font-size: 12px; margin-top: 4px;">按区域与座位号定时预约，成功扣 ${escapeHtml(pricePeachText)} 🍑，失败不扣费。</p>
          </div>
          <div class="xp-well">
            <div class="xp-entity-title" style="font-size: 14px;">快递取件码</div>
            <p class="xp-entity-summary" style="font-size: 12px; margin-top: 4px;">粘贴取件短信或从客户端同步，按驿站汇总取件码。</p>
          </div>
          <div class="xp-well">
            <div class="xp-entity-title" style="font-size: 14px;">社团与竞赛</div>
            <p class="xp-entity-summary" style="font-size: 12px; margin-top: 4px;">查看炽夜空动漫社、硬件技术联盟、计算机服务社及学科竞赛信息。</p>
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
    <script src="/static/app.js" defer></script>
    <script>
      (function () {
        var styleBtn = document.querySelector("[data-ui-style-toggle]");
        var styleLabel = document.querySelector("[data-ui-style-label]");
        function syncStyleLabel() {
          if (!styleLabel) return;
          var cur = document.documentElement.getAttribute("data-ui-style") || "liquid-glass";
          styleLabel.textContent = ({ "liquid-glass": "毛玻璃", "flutter-m3": "经典 M3", "fresh-breeze": "清新森系", "cream-pastel": "奶油手账" })[cur] || "毛玻璃";
        }
        syncStyleLabel();
        if (styleBtn) {
          styleBtn.addEventListener("click", function () {
            var cur = document.documentElement.getAttribute("data-ui-style") || "liquid-glass";
            var styles = ["liquid-glass", "flutter-m3", "fresh-breeze", "cream-pastel"];
            var next = styles[(styles.indexOf(cur) + 1) % styles.length];
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
              // The exchange sets an HttpOnly cookie. Never persist bearer credentials in JS storage.
              try { localStorage.removeItem("dis_web_session"); } catch (e) {}
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
  const pricingMicropeach = Number(ctx.pricingMicropeach ?? DEFAULT_RESERVATION_PRICE_MICROPEACH);
  const pricePeachText = formatPeachFromMicropeach(pricingMicropeach);
  const user = ctx.user || null;
  if (!user) {
    return renderUnauthenticatedLandingHtml(pricePeachText);
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
    roles.includes("FINANCE_OPERATOR") ||
    roles.includes("PLATFORM_OWNER") ||
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
    const cleanCarrier =
      cleanDisplayText(p?.carrier_name, "") ||
      cleanDisplayText(p?.carrier_code, "") ||
      "校园快递";
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



  const pageHeaderConfig = {
    portal: {
      title: "概览",
      subtitle: "查看账户余额、待取快递与图书馆预约状态。"
    },
    reservations: {
      title: "图书馆座位预约",
      subtitle: `选择自习区域与备选座位，到点自动提交预约；成功扣 ${pricePeachText} 🍑，失败不扣费。`
    },
    parcels: {
      title: "快递与取件码",
      subtitle: "按驿站分组展示取件码，支持短信识别与客户端同步。"
    },
    community: {
      title: "社团与竞赛",
      subtitle: "河南工业大学合作社团、学科竞赛与校园频道。"
    },
    orders: {
      title: "消费与退还明细",
      subtitle: "查看座位预约扣费与退还记录。"
    },
    console: {
      title: "站点管理",
      subtitle: "管理社团与竞赛内容、图书馆服务状态及消费账单。"
    }
  }[activeNav] || {
    title: "概览",
    subtitle: "查看账户余额、待取快递与图书馆预约状态。"
  };

  function renderIdentityPassSection() {
    return `
      <section class="xp-card identity-pass-card" style="margin-bottom: 16px;">
        <div class="identity-pass-grid">
          <div class="identity-pass-main">
            <div class="user-avatar" style="width: 56px; height: 56px; font-size: 22px;">
              ${escapeHtml(userInitial)}
            </div>
            <div class="xp-entity-title-col">
              <h2 class="xp-entity-title" style="font-size: 18px;">${escapeHtml(username)}</h2>
              <div class="xp-badge-flow">
                ${xpeachBadge(userGroup, "primary")}
                ${xpeachBadge("XPeach 已连接", "success")}
                ${activeStudentNo ? xpeachBadge(`学号 ${activeStudentNo}`, "peach") : ""}
              </div>
              <div class="text-xs text-muted">
                通行证 ID: <code>${escapeHtml(user.subject)}</code>
                · 邮箱: <span>${escapeHtml(userEmail)}</span>
                · 邀请码: <code>${escapeHtml(userAffCode)}</code>
              </div>
            </div>
          </div>
          <div class="identity-wallet-box">
            <div class="identity-wallet-label">账户余额</div>
            <div class="identity-wallet-value" id="wallet-balance-text">🍑 ${escapeHtml(peachBalanceFormatted)}</div>
            <div class="identity-wallet-sub" id="wallet-used-text">
              已用 🍑 ${escapeHtml(peachUsedFormatted)} · 预约成功扣 ${escapeHtml(pricePeachText)} 🍑
            </div>
          </div>
        </div>
      </section>

      <section class="xp-bento-grid" aria-label="通行证核心指标">
        ${xpeachBentoTile({
          label: "账户余额",
          value: `🍑 ${peachBalanceFormatted}`,
          hint: `已用 🍑 ${peachUsedFormatted}`,
          badge: xpeachBadge("XPeach", "primary"),
          valueId: "stat-peach-balance"
        })}
        ${xpeachBentoTile({
          label: "校园学号",
          value: bindings.length > 0 ? "已绑定" : "未绑定",
          hint: activeStudentNo ? `学号：${activeStudentNo}` : "前往预约页面绑定",
          badge: xpeachBadge(bindings.length > 0 ? "已就绪" : "待绑定", bindings.length > 0 ? "success" : "warning"),
          valueId: "stat-bindings-count"
        })}
        ${xpeachBentoTile({
          label: "有效预约",
          value: String(activePlans.length),
          hint: `成功每次扣 ${pricePeachText} 🍑`,
          badge: xpeachBadge(`${pricePeachText} 🍑/次`, "peach"),
          valueId: "stat-plans-count"
        })}
        ${xpeachBentoTile({
          label: "待取快递",
          value: String(readyParcels.length),
          hint: `共 ${parcels.length} 件记录`,
          badge: xpeachBadge(readyParcels.length > 0 ? "待取件" : "已清空", readyParcels.length > 0 ? "peach" : "neutral"),
          valueId: "stat-parcels-count"
        })}
      </section>`;
  }

  function renderPortalView() {
    const activeJobs = jobs.filter((j) => !["CANCELLED", "FAILED", "EXPIRED"].includes(j.state));
    return `
      ${renderIdentityPassSection()}

      <div class="xp-split-grid" style="margin-bottom: 18px;">
        <!-- 待取快递动态提醒卡 -->
        <section class="xp-card">
          <div class="xp-entity-header" style="margin-bottom: 14px;">
            <div class="xp-icon-box xp-icon-box--peach" aria-hidden="true">📦</div>
            <div class="xp-entity-title-col">
              <div class="xp-badge-flow" style="justify-content: space-between;">
                <h2 class="xp-entity-title">待取快递</h2>
                <a class="xp-pill xp-pill--compact" href="/parcels">管理快递 →</a>
              </div>
              <p class="xp-entity-summary" style="margin-top: 2px;">${
                readyParcels.length > 0
                  ? `${readyParcels.length} 件包裹待取`
                  : "当前无待取快递"
              }</p>
            </div>
          </div>
          ${
            stationGroups.length === 0
              ? xpeachEmptyState({
                  icon: "📦",
                  title: "暂无待取包裹",
                  subtitle: "可粘贴取件短信识别，或在客户端同步包裹记录。",
                  actionLabel: "录入取件码",
                  actionHref: "/parcels"
                })
              : `<div class="stack gap-3">
                  ${stationGroups
                    .map(
                      ([station, list]) => `
                    <div class="pickup-station-group">
                      <div class="xp-badge-flow" style="justify-content: space-between; margin-bottom: 10px;">
                        <span class="text-sm font-semibold">${escapeHtml(station)}</span>
                        ${xpeachBadge(`${list.length} 件待取`, "primary")}
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
                            <button type="button" class="xp-pill xp-pill--compact" data-pickup-parcel="${escapeHtml(p.id)}">已取件</button>
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
        <section class="xp-card">
          <div class="xp-entity-header" style="margin-bottom: 14px;">
            <div class="xp-icon-box" aria-hidden="true">💺</div>
            <div class="xp-entity-title-col">
              <div class="xp-badge-flow" style="justify-content: space-between;">
                <h2 class="xp-entity-title">图书馆预约</h2>
                <a class="xp-pill xp-pill--active xp-pill--compact" href="/reservations">新建预约 →</a>
              </div>
              <p class="xp-entity-summary" style="margin-top: 2px;">${
                activeJobs.length > 0
                  ? `${activeJobs.length} 项进行中预约`
                  : "当前无进行中的座位预约"
              }</p>
            </div>
          </div>
          ${
            activeJobs.length === 0
              ? xpeachEmptyState({
                  icon: "📚",
                  title: "暂无预约计划",
                  subtitle: "选择楼层区域与备选座位，到点自动提交预约。",
                  actionLabel: "新建预约",
                  actionHref: "/reservations"
                })
              : `<div class="stack gap-2">
                  ${activeJobs
                    .slice(0, 4)
                    .map((j) => {
                      const p = plans.find((x) => x.id === j.plan_id) || {};
                      const seats = Array.isArray(p.candidate_seats) ? p.candidate_seats.join(" / ") : "4N-001";
                      const repDays = Number(p.repeat_days || j.repeat_days || 1);
                      const remDays = Number(p.remaining_days ?? j.remaining_days ?? repDays);
                      return `<div class="pickup-code-card">
                        <div style="flex:1;min-width:0;">
                          <div class="text-sm font-semibold">${escapeHtml(p.area_name || "4楼北自习区")} · <code>${escapeHtml(seats)}</code></div>
                          <div class="text-xs text-muted">日期：${escapeHtml(j.booking_local_date || p.target_local_date || "-")} · 时段：${escapeHtml(p.slot_window || "08:00-22:00")}</div>
                        </div>
                        <div class="xp-badge-flow">
                          ${repDays > 1 ? xpeachBadge(`连续 ${repDays} 天 (剩 ${remDays} 天)`, "primary") : ""}
                          ${j.state === "CONFIRMED" ? xpeachBadge("已成功", "success") : xpeachBadge("待执行", "primary")}
                          ${
                            j.state !== "CONFIRMED"
                              ? `<button type="button" class="xp-pill xp-pill--compact" data-cancel-job="${escapeHtml(j.id)}">取消</button>`
                              : ""
                          }
                        </div>
                      </div>`;
                    })
                    .join("")}
                </div>`
          }
        </section>
      </div>

      <!-- 合作社团预览 -->
      <section class="xp-card" style="margin-bottom: 18px;">
        <div class="xp-entity-header" style="margin-bottom: 14px;">
          <div class="xp-icon-box" aria-hidden="true">🤝</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow" style="justify-content: space-between;">
              <h2 class="xp-entity-title">合作社团</h2>
              <a class="xp-pill xp-pill--compact" href="/community">查看全部 (${ccClubs.length}) →</a>
            </div>
            <p class="xp-entity-summary" style="margin-top: 2px;">校内合作社团与招新交流群。</p>
          </div>
        </div>
        <div class="xp-card-grid">
          ${ccClubs.map((club) => xpeachClubCard(club, { isAdmin: false })).join("")}
        </div>
      </section>

      <!-- 学科竞赛目录预览 -->
      <section class="xp-card">
        <div class="xp-entity-header" style="margin-bottom: 14px;">
          <div class="xp-icon-box xp-icon-box--peach" aria-hidden="true">🏆</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow" style="justify-content: space-between;">
              <h2 class="xp-entity-title">学科竞赛目录</h2>
              <a class="xp-pill xp-pill--active xp-pill--compact" href="/community#section-community-competitions">查看全部 (${ccCompetitions.length}) →</a>
            </div>
            <p class="xp-entity-summary" style="margin-top: 2px;">按专业方向筛选常见高校学科竞赛与报名信息。</p>
          </div>
        </div>
        <div class="xp-card-grid">
          ${ccCompetitions.slice(0, 4).map((comp) => xpeachCompetitionCard(comp, { isAdmin: false })).join("")}
        </div>
      </section>`;
  }

  function renderCommunityView() {
    return `
      <div class="stack gap-4">
        ${
          ccBulletin.enabled !== false && ccBulletin.title
            ? xpeachBulletinHeroCard({
                title: ccBulletin.title,
                content: ccBulletin.content,
                tag: ccBulletin.tag || "公告",
                version: campusContent.version || 3,
                clubsCount: ccClubs.length,
                competitionsCount: ccCompetitions.length
              })
            : ""
        }

        <section class="xp-card">
          <div class="xp-entity-header" style="margin-bottom: 12px;">
            <div class="xp-icon-box" aria-hidden="true">🤝</div>
            <div class="xp-entity-title-col">
              <div class="xp-badge-flow" style="justify-content: space-between;">
                <h2 class="xp-entity-title">合作社团 (${ccClubs.length})</h2>
                ${xpeachStatusDot("支持复制群号或唤起 QQ", "success")}
              </div>
            </div>
          </div>
          <div class="xp-search-bar" style="margin-bottom: 12px;">
            <input class="input xp-search-input" id="community-club-search" type="search" placeholder="搜索社团、场地或 QQ 群号…" />
            <div class="xp-pill-bar" id="community-category-pills">
              <button type="button" class="xp-pill xp-pill--compact xp-pill--active" data-club-filter="ALL">全部 (${ccClubs.length})</button>
              <button type="button" class="xp-pill xp-pill--compact" data-club-filter="TECH_INNOVATION">科技创新</button>
              <button type="button" class="xp-pill xp-pill--compact" data-club-filter="ART_PERFORMANCE">文艺展演</button>
            </div>
          </div>

          <div class="xp-card-grid" id="community-clubs-grid">
            ${
              ccClubs.length === 0
                ? xpeachEmptyState({
                    icon: "🤝",
                    title: "暂无合作社团",
                    subtitle: "管理员可在后台添加合作社团信息。"
                  })
                : ccClubs.map((club) => xpeachClubCard(club, { isAdmin: false })).join("")
            }
          </div>
        </section>

        <section class="xp-card" id="section-community-competitions">
          <div class="xp-entity-header" style="margin-bottom: 12px;">
            <div class="xp-icon-box xp-icon-box--peach" aria-hidden="true">🏆</div>
            <div class="xp-entity-title-col">
              <div class="xp-badge-flow" style="justify-content: space-between;">
                <h2 class="xp-entity-title">学科竞赛目录 (${ccCompetitions.length})</h2>
                ${xpeachBadge("高校常见赛事", "peach")}
              </div>
              <p class="xp-entity-summary" style="margin-top: 2px;">按专业方向或类别筛选赛事，查看报名时间、备赛要点与官网链接。</p>
            </div>
          </div>

          <div class="xp-well" style="margin-bottom: 14px; display: flex; flex-direction: column; gap: 10px;">
            <input class="input" id="community-comp-search" type="search" placeholder="搜索竞赛、主办单位、专业或社团…" />
            <div>
              <div class="text-xs text-muted" style="margin-bottom: 6px; font-weight: 600;">适用专业</div>
              <div class="xp-pill-bar" id="community-comp-major-pills">
                <button type="button" class="xp-pill xp-pill--compact xp-pill--active" data-comp-major="ALL">全部专业 (${ccCompetitions.length})</button>
                <button type="button" class="xp-pill xp-pill--compact" data-comp-major="CS_AI_SOFTWARE">计算机/软件/AI</button>
                <button type="button" class="xp-pill xp-pill--compact" data-comp-major="EE_AUTOMATION_IOT">电气/自动化/物联</button>
                <button type="button" class="xp-pill xp-pill--compact" data-comp-major="MECH_VEHICLE_ROBO">机械/机电/机器人</button>
                <button type="button" class="xp-pill xp-pill--compact" data-comp-major="FOOD_BIO_CHEM_MAT">粮油/食品/化工</button>
                <button type="button" class="xp-pill xp-pill--compact" data-comp-major="ECON_MGMT_FINANCE">经管/金融/电商</button>
                <button type="button" class="xp-pill xp-pill--compact" data-comp-major="DESIGN_MEDIA_FOREIGN">艺术/新传/外语</button>
                <button type="button" class="xp-pill xp-pill--compact" data-comp-major="MATH_PHYSICS_CIVIL">数理/土木/建筑</button>
              </div>
            </div>
            <div>
              <div class="text-xs text-muted" style="margin-bottom: 6px; font-weight: 600;">赛事类别</div>
              <div class="xp-pill-bar" id="community-comp-cat-pills">
                <button type="button" class="xp-pill xp-pill--compact xp-pill--active" data-comp-cat="ALL">全部类别</button>
                <button type="button" class="xp-pill xp-pill--compact" data-comp-beginner-toggle="true">入门友好</button>
                <button type="button" class="xp-pill xp-pill--compact" data-comp-cat="ALGO_PROGRAMMING">算法编程</button>
                <button type="button" class="xp-pill xp-pill--compact" data-comp-cat="ELECTRONICS_ROBO">硬件机器人</button>
                <button type="button" class="xp-pill xp-pill--compact" data-comp-cat="MATH_MODELING">数学建模</button>
                <button type="button" class="xp-pill xp-pill--compact" data-comp-cat="INNOVATION_ENTREPRENEURSHIP">创新创业</button>
                <button type="button" class="xp-pill xp-pill--compact" data-comp-cat="CYBER_SECURITY_AI">网安与AI</button>
                <button type="button" class="xp-pill xp-pill--compact" data-comp-cat="DIGITAL_MEDIA_ART">数媒与综合</button>
              </div>
            </div>
          </div>

          <div class="xp-card-grid" id="community-competitions-grid">
            ${
              ccCompetitions.length === 0
                ? xpeachEmptyState({
                    icon: "🏆",
                    title: "暂无竞赛指南配置",
                    subtitle: "管理员可在站点后台动态下发学科竞赛与官网名录。"
                  })
                : ccCompetitions.map((comp) => xpeachCompetitionCard(comp, { isAdmin: false })).join("")
            }
          </div>
        </section>

        <section class="xp-card">
          <div class="xp-entity-header" style="margin-bottom: 12px;">
            <div class="xp-icon-box" aria-hidden="true">💬</div>
            <div class="xp-entity-title-col">
              <div class="xp-badge-flow" style="justify-content: space-between;">
                <h2 class="xp-entity-title">校园频道</h2>
                ${xpeachBadge(ccChannels.length > 0 ? `${ccChannels.length} 个频道` : "暂时置空", ccChannels.length > 0 ? "primary" : "neutral")}
              </div>
              <p class="xp-entity-summary" style="margin-top: 2px;">校园互助与专题频道由云端统一管控下发。</p>
            </div>
          </div>
          ${
            ccChannels.length === 0
              ? xpeachEmptyState({
                  icon: "💬",
                  title: "暂无校园频道",
                  subtitle: "当前仅展示合作社团与交流群，频道列表暂未开放。"
                })
              : `<div class="xp-card-grid">${ccChannels.map((ch) => xpeachChannelCard(ch, { isAdmin: false })).join("")}</div>`
          }
        </section>
      </div>`;
  }

  function renderReservationsView() {
    return `
      <section class="xp-card" id="section-reservations">
        <div class="xp-entity-header" style="margin-bottom: 16px;">
          <div class="xp-icon-box" aria-hidden="true">📚</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow" style="justify-content: space-between;">
              <h2 class="xp-entity-title">图书馆座位预约</h2>
              ${xpeachBadge(`${pricePeachText} 🍑 / 次 · 成功扣费 · 余额 🍑 ${peachBalanceFormatted}`, "peach")}
            </div>
            <p class="xp-entity-summary" style="margin-top: 2px;">绑定学号后选择自习区域与备选座位，到点自动提交预约。</p>
          </div>
        </div>

        <div class="xp-split-grid">
          <!-- Step 1: 绑定校园学号 -->
          <div class="xp-well" style="padding: 18px;">
            <div class="xp-badge-flow" style="justify-content: space-between; margin-bottom: 8px;">
              <h3 class="xp-entity-title" style="font-size: 15px;">第一步：绑定校园学号</h3>
              ${
                activeStudentNo
                  ? xpeachBadge(`已绑定 ${activeStudentNo}`, "success")
                  : xpeachBadge("待绑定", "warning")
              }
            </div>
            <p class="text-xs text-muted" style="margin: 0 0 14px;">用于登录图书馆预约系统，绑定状态与客户端同步。</p>
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
                <input class="input" id="bind-secret" type="password" placeholder="请输入登录密码（加密保存，仅用于座位预约）" />
              </div>
              <button type="button" class="btn btn-primary btn-block" id="btn-save-binding">
                ${activeStudentNo ? "更新绑定学号与密码" : "保存并绑定学号"}
              </button>
            </div>
            <div id="binding-list-box" style="margin-top: 12px;" class="text-xs text-muted">
              ${
                activeStudentNo
                  ? `当前绑定学号：<strong>${escapeHtml(activeStudentNo)}</strong>（河南工业大学）`
                  : "尚未绑定学号。"
              }
            </div>
          </div>

          <!-- Step 2: 选择区域与座位 -->
          <div class="xp-well" style="padding: 18px;">
            <div class="xp-badge-flow" style="justify-content: space-between; margin-bottom: 8px;">
              <h3 class="xp-entity-title" style="font-size: 15px;">第二步：选择区域与座位</h3>
              <span class="xp-badge xp-badge--success" id="live-region-badge" style="display:none;">实时座位数据</span>
            </div>
            <p class="text-xs text-muted" style="margin: 0 0 10px;">切换楼层区域并点击座位卡片设置首选与备选座位。</p>

            <div class="xp-pill-bar" id="area-pills-bar" style="margin-bottom: 12px;">
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
                <div class="xp-badge-flow" style="justify-content: space-between; margin-bottom: 4px;">
                  <label class="label" style="margin: 0;">2. 选择座位（蓝色首选，绿色备选）</label>
                  <span class="text-xs text-muted" id="seat-selection-summary">已选：4N-001 / 4N-002 / 4N-003</span>
                </div>
                <div class="seat-visual-grid" id="seat-visual-grid"></div>
              </div>

              <div class="xp-form-grid-3">
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

              <div class="xp-form-grid-3">
                <div class="field">
                  <label class="label" for="plan-date">预约开始日期</label>
                  <input class="input" id="plan-date" type="date" />
                </div>
                <div class="field">
                  <label class="label" for="plan-time">自动执行时间</label>
                  <select class="input" id="plan-time">
                    <option value="07:00:00">07:00（早间场次）</option>
                    <option value="07:30:00">07:30（早间场次）</option>
                    <option value="08:00:00">08:00（上午场次）</option>
                    <option value="12:30:00">12:30（午间场次）</option>
                    <option value="14:00:00">14:00（下午场次）</option>
                    <option value="18:00:00">18:00（晚间场次）</option>
                    <option value="21:00:00">21:00（夜间预约次日）</option>
                  </select>
                </div>
                <div class="field">
                  <label class="label" for="plan-repeat-days">重复周期</label>
                  <select class="input" id="plan-repeat-days">
                    <option value="1">单次（1 天）</option>
                    <option value="3">连续 3 天</option>
                    <option value="7">连续 7 天</option>
                    <option value="14">连续 14 天</option>
                    <option value="30">连续 30 天</option>
                  </select>
                </div>
              </div>
              <div class="field">
                <label class="label" for="plan-slot">自习用座时段</label>
                <select class="input" id="plan-slot">
                  <option value="08:00-22:00">08:00 - 22:00（全天时段）</option>
                  <option value="08:00-12:00">08:00 - 12:00（上午时段）</option>
                  <option value="14:00-18:00">14:00 - 18:00（下午时段）</option>
                  <option value="18:30-22:00">18:30 - 22:00（晚间时段）</option>
                </select>
              </div>
              <div class="xp-action-group">
                <button type="button" class="btn btn-primary" style="flex:1;" id="btn-create-plan">保存预约计划</button>
                <button type="button" class="btn btn-secondary" id="btn-fire-now">立即预约</button>
              </div>
            </div>
          </div>
        </div>

        <div class="divider"></div>

        <h3 class="xp-section-subtitle">预约记录</h3>
        <div class="xp-row-list" id="jobs-tbody">
          ${
            jobs.length === 0
              ? xpeachEmptyState({
                  icon: "💺",
                  title: "暂无预约记录",
                  subtitle: "选择自习区域与座位后即可创建预约计划。"
                })
              : jobs
                  .map((j) => {
                    const p = plans.find((x) => x.id === j.plan_id) || {};
                    return xpeachJobRowCard(j, p, { pricePeachText });
                  })
                  .join("")
          }
        </div>
      </section>`;
  }

  function renderParcelsView() {
    return `
      <section class="xp-card" id="section-parcels">
        <div class="xp-entity-header" style="margin-bottom: 16px;">
          <div class="xp-icon-box xp-icon-box--peach" aria-hidden="true">📦</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow" style="justify-content: space-between;">
              <h2 class="xp-entity-title">快递与取件码</h2>
              ${xpeachBadge(`${readyParcels.length} 件待取件`, "peach")}
            </div>
            <p class="xp-entity-summary" style="margin-top: 2px;">粘贴取件短信提取取件码与驿站位置，数据与客户端同步。</p>
          </div>
        </div>

        <!-- 短信粘贴识别框 -->
        <div class="xp-well" style="padding: 16px; margin-bottom: 18px;">
          <div class="xp-form-grid-3" style="align-items: end;">
            <div class="field" style="grid-column: span 2;">
              <label class="label" for="parcel-sms">取件短信</label>
              <input class="input" id="parcel-sms" type="text" placeholder="例如：【菜鸟驿站】您的包裹已到莲花街北苑菜鸟驿站，请凭取件码 3-2-1048 领取" />
            </div>
            <div class="field">
              <label class="label" for="parcel-tracking">运单号（选填）</label>
              <input class="input" id="parcel-tracking" type="text" placeholder="例如 SF15283910293" />
            </div>
          </div>
          <div class="xp-action-bar" style="margin-top: 10px;">
            <div id="sms-preview-chip" class="text-xs text-muted">
              可在「日在校园」App 中绑定手机号自动同步快递信息。
            </div>
            <button type="button" class="xp-pill xp-pill--active" id="btn-add-parcel">保存取件码</button>
          </div>
        </div>

        <!-- 按驿站分组的大字号取件码卡片 -->
        ${
          stationGroups.length > 0
            ? `<div class="xp-card-grid" style="margin-bottom: 20px;">
                ${stationGroups
                  .map(
                    ([station, list]) => `
                  <div class="pickup-station-group">
                    <div class="xp-badge-flow" style="justify-content: space-between; margin-bottom: 10px;">
                      <span class="text-sm font-semibold">${escapeHtml(station)}</span>
                      ${xpeachBadge(`${list.length} 件待取`, "primary")}
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
                          <button type="button" class="xp-pill xp-pill--active xp-pill--compact" data-pickup-parcel="${escapeHtml(p.id)}">标记已取</button>
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

        <h3 class="xp-section-subtitle">全部快递记录</h3>
        <div class="xp-row-list" id="parcels-tbody">
          ${
            parcels.length === 0
              ? xpeachEmptyState({
                  icon: "📦",
                  title: "暂无快递记录",
                  subtitle: "粘贴取件短信或在客户端中同步包裹记录。"
                })
              : parcels.map((p) => xpeachParcelRowCard(p)).join("")
          }
        </div>
      </section>`;
  }

  function renderOrdersView() {
    return `
      ${renderIdentityPassSection()}
      <section class="xp-card" id="section-orders">
        <div class="xp-entity-header" style="margin-bottom: 14px;">
          <div class="xp-icon-box xp-icon-box--peach" aria-hidden="true">🍑</div>
          <div class="xp-entity-title-col">
            <div class="xp-badge-flow" style="justify-content: space-between;">
              <h2 class="xp-entity-title">消费与退还明细</h2>
              <a class="xp-pill xp-pill--compact" href="https://sso.xpeach.codes/portal">XPeach 账户账单 →</a>
            </div>
            <p class="xp-entity-summary" style="margin-top: 2px;">预约成功扣取 🍑，未成功或已取消不扣费。</p>
          </div>
        </div>
        <div class="xp-row-list" id="orders-tbody">
          ${
            orders.length === 0
              ? xpeachEmptyState({
                  icon: "🍑",
                  title: "暂无消费记录",
                  subtitle: `座位预约成功后扣除 ${pricePeachText} 🍑。`
                })
              : orders
                  .map((o) =>
                    xpeachOrderRowCard(o, {
                      isAdmin: false,
                      pricingMicropeach,
                      micropeachPerPeach: MICROPEACH_PER_PEACH
                    })
                  )
                  .join("")
          }
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

    return `
      <section class="xp-bento-grid" aria-label="站点运行指标">
        ${xpeachBentoTile({
          label: "已接入 XPeach 用户",
          value: String(stats.users_count),
          hint: `已绑定学号：${stats.active_bindings_count} 人`,
          badge: xpeachBadge("OIDC PKCE", "primary")
        })}
        ${xpeachBentoTile({
          label: "累计占座预约任务",
          value: String(stats.jobs_count),
          hint: "三段式准点调度 (T-30m/T-5m/T)",
          badge: xpeachBadge("ADR-005", "success")
        })}
        ${xpeachBentoTile({
          label: "累计 🍑 结算账单",
          value: String(stats.orders_count),
          hint: "实时上报 XPeach 主站账本",
          badge: xpeachBadge(`${pricePeachText} 🍑/次`, "peach")
        })}
        ${xpeachBentoTile({
          label: "全站同步快递包裹",
          value: String(stats.parcels_count),
          hint: `安全审计记录：${stats.audit_events_count} 条`,
          badge: xpeachBadge("KMS 加密", "primary")
        })}
      </section>

      <section class="xp-card" style="margin-bottom: 18px;">
        <div class="xp-entity-header" style="margin-bottom: 14px;">
          <div class="xp-icon-box" aria-hidden="true">🏫</div>
          <div class="xp-entity-title-col">
            <h2 class="xp-entity-title">学校图书馆服务状态管理</h2>
            <p class="xp-entity-summary" style="margin-top: 2px;">当学校图书馆系统临时维护时，可在此一键开启/恢复预约保护熔断开关。</p>
          </div>
        </div>
        <div class="xp-row-list">
          ${schools.map((s) => xpeachSchoolControlCard(s)).join("")}
        </div>
      </section>

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
      </section>

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

      <section class="xp-card">
        <div class="xp-entity-header" style="margin-bottom: 14px;">
          <div class="xp-icon-box" aria-hidden="true">🛡️</div>
          <div class="xp-entity-title-col">
            <h2 class="xp-entity-title">最近安全与操作审计记录</h2>
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
                  .slice(0, 15)
                  .map((ev) => xpeachAuditRowCard(ev))
                  .join("")
          }
        </div>
      </section>`;
  }

  const activeMainHtml =
    activeNav === "reservations"
      ? renderReservationsView()
      : activeNav === "parcels"
        ? renderParcelsView()
        : activeNav === "community"
          ? renderCommunityView()
          : activeNav === "orders"
            ? renderOrdersView()
            : activeNav === "console" && isAdmin
              ? renderAdminConsoleView()
              : renderPortalView();

  return `${renderHead("日在校园 · XPeach 云端通行证")}
  <body class="console-body">
    ${renderHiddenContractViews()}
    <div class="mobile-topbar">
      <a class="brand" href="/">
        <img src="/static/xpeach-logo.png" alt="XPeach" class="brand-logo brand-logo--sm" width="28" height="28" />
        <span class="brand-name">XPeach · 日在校园</span>
      </a>
      <div class="mobile-topbar-actions">
        <button type="button" class="xp-pill xp-pill--compact" data-ui-style-toggle title="切换液态毛玻璃 / 经典 M3">
          <span data-ui-style-label>✨ 毛玻璃</span>
        </button>
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
          ${xpeachBadge(isAdmin ? "管理员" : "学生通行证", "primary")}
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
              ${readyParcels.length > 0 ? `<span class="xp-badge xp-badge--peach" style="margin-left:auto;">${readyParcels.length}</span>` : ""}
            </a>
            <a class="nav-item ${activeNav === "community" ? "active" : ""}" href="/community">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              <span>合作社团与频道</span>
              <span class="xp-badge xp-badge--primary" style="margin-left:auto;">${ccClubs.length}</span>
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
              <span>服务与云控管理</span>
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
          <div class="xp-action-group">
            <button type="button" class="xp-pill xp-pill--compact" data-ui-style-toggle title="切换液态毛玻璃 / 经典 M3 视觉语言">
              <span data-ui-style-label>✨ 液态毛玻璃</span>
            </button>
            <button type="button" class="xp-pill xp-pill--compact" id="btn-sync-wallet">同步 🍑 余额</button>
            <a class="xp-pill xp-pill--active xp-pill--compact" href="https://sso.xpeach.codes/portal">前往 XPeach 主站充值 🍑</a>
          </div>
        </header>

        <div id="toast-banner" class="alert alert-success" style="display:none;margin-bottom:16px;"></div>

        ${activeMainHtml}
      </main>
    </div>

    <nav class="mobile-glass-dock" aria-label="快捷导航">
      <a class="mobile-dock-item ${activeNav === "portal" ? "active" : ""}" href="/portal">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
        <span>通行证</span>
      </a>
      <a class="mobile-dock-item ${activeNav === "reservations" ? "active" : ""}" href="/reservations">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>
        <span>抢座预约</span>
      </a>
      <a class="mobile-dock-item ${activeNav === "parcels" ? "active" : ""}" href="/parcels">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
        <span>取件码</span>
      </a>
      <a class="mobile-dock-item ${activeNav === "community" ? "active" : ""}" href="/community">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
        <span>合作社团</span>
      </a>
      <a class="mobile-dock-item ${activeNav === "orders" ? "active" : ""}" href="/orders">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        <span>🍑 账单</span>
      </a>
    </nav>

    <script src="/static/app.js" defer></script>
    <script>
      (function () {
        var PRICE_PEACH_TEXT = ${JSON.stringify(pricePeachText)};
        var ACCEPTED_PRICE_MICROPEACH = ${JSON.stringify(pricingMicropeach)};
        var ACCEPTED_PRICE_VERSION = ${JSON.stringify(getReservationPriceVersion(pricingMicropeach))};
        function escHtml(v) {
          return String(v == null ? "" : v)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }

        // Cycle all supported UI styles without changing the light/dark preference.
        function syncAllStyleLabels() {
          var cur = document.documentElement.getAttribute("data-ui-style") || "liquid-glass";
          document.querySelectorAll("[data-ui-style-label]").forEach(function (el) {
            el.textContent = ({ "liquid-glass": "毛玻璃", "flutter-m3": "经典 M3", "fresh-breeze": "清新森系", "cream-pastel": "奶油手账" })[cur] || "毛玻璃";
          });
        }
        syncAllStyleLabels();
        document.querySelectorAll("[data-ui-style-toggle]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var cur = document.documentElement.getAttribute("data-ui-style") || "liquid-glass";
            var styles = ["liquid-glass", "flutter-m3", "fresh-breeze", "cream-pastel"];
            var next = styles[(styles.indexOf(cur) + 1) % styles.length];
            document.documentElement.setAttribute("data-ui-style", next);
            try { localStorage.setItem("xpeach-ui-style", next); } catch (e) {}
            syncAllStyleLabels();
          });
        });

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
          // Same-origin HttpOnly session cookie; no bearer token embedded in HTML.
          options.credentials = "same-origin";
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

        // Copy QQ Group & Filter Partner Clubs on /community & /portal
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

        var clubSearchInput = document.getElementById("community-club-search");
        var activeClubFilter = "ALL";
        function filterCommunityClubs() {
          var q = clubSearchInput ? clubSearchInput.value.trim().toLowerCase() : "";
          document.querySelectorAll("[data-club-card]").forEach(function (card) {
            var cat = card.getAttribute("data-club-category") || "";
            var haystack = card.getAttribute("data-club-search") || "";
            var catMatch = activeClubFilter === "ALL" || cat === activeClubFilter;
            var qMatch = !q || haystack.indexOf(q) !== -1;
            card.style.display = catMatch && qMatch ? "" : "none";
          });
        }
        if (clubSearchInput) {
          clubSearchInput.addEventListener("input", filterCommunityClubs);
        }
        document.querySelectorAll("[data-club-filter]").forEach(function (pill) {
          pill.addEventListener("click", function () {
            activeClubFilter = pill.getAttribute("data-club-filter") || "ALL";
            document.querySelectorAll("[data-club-filter]").forEach(function (p) {
              p.classList.toggle("xp-pill--active", p === pill);
            });
            filterCommunityClubs();
          });
        });

        // Copy Official Competition URL & Filter Competitions by Major / Category / Beginner
        document.querySelectorAll("[data-copy-url]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var url = btn.getAttribute("data-copy-url") || "";
            var name = btn.getAttribute("data-copy-comp-name") || "学科竞赛";
            if (navigator.clipboard && url) {
              navigator.clipboard.writeText(url).catch(function () {});
            }
            showToast("已复制「" + name + "」官网链接：" + url);
          });
        });

        var compSearchInput = document.getElementById("community-comp-search");
        var activeCompMajor = "ALL";
        var activeCompCat = "ALL";
        var onlyCompBeginner = false;
        function filterCommunityCompetitions() {
          var q = compSearchInput ? compSearchInput.value.trim().toLowerCase() : "";
          document.querySelectorAll("[data-comp-card]").forEach(function (card) {
            var cat = card.getAttribute("data-comp-category") || "";
            var majors = (card.getAttribute("data-comp-majors") || "").split(",");
            var isBeg = card.getAttribute("data-comp-beginner") === "true";
            var haystack = card.getAttribute("data-comp-search") || "";
            var majorOk =
              activeCompMajor === "ALL" ||
              majors.indexOf("ALL_MAJORS") !== -1 ||
              majors.indexOf(activeCompMajor) !== -1;
            var catOk = activeCompCat === "ALL" || cat === activeCompCat;
            var begOk = !onlyCompBeginner || isBeg;
            var qOk = !q || haystack.indexOf(q) !== -1;
            card.style.display = majorOk && catOk && begOk && qOk ? "" : "none";
          });
        }
        if (compSearchInput) {
          compSearchInput.addEventListener("input", filterCommunityCompetitions);
        }
        document.querySelectorAll("[data-comp-major]").forEach(function (pill) {
          pill.addEventListener("click", function () {
            activeCompMajor = pill.getAttribute("data-comp-major") || "ALL";
            document.querySelectorAll("[data-comp-major]").forEach(function (p) {
              p.classList.toggle("xp-pill--active", p === pill);
            });
            filterCommunityCompetitions();
          });
        });
        document.querySelectorAll("[data-comp-cat]").forEach(function (pill) {
          pill.addEventListener("click", function () {
            activeCompCat = pill.getAttribute("data-comp-cat") || "ALL";
            document.querySelectorAll("[data-comp-cat]").forEach(function (p) {
              p.classList.toggle("xp-pill--active", p === pill);
            });
            filterCommunityCompetitions();
          });
        });
        document.querySelectorAll("[data-comp-beginner-toggle]").forEach(function (pill) {
          pill.addEventListener("click", function () {
            onlyCompBeginner = !onlyCompBeginner;
            pill.classList.toggle("xp-pill--active", onlyCompBeginner);
            filterCommunityCompetitions();
          });
        });

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
            var code = String(item.code || "");
            var tag = String(item.tag || "");
            var safeCode = escHtml(code);
            var safeTag = escHtml(tag);
            var isAvail = item.available !== false;
            var label = safeCode + "（" + safeTag + "）";
            html1 += '<option value="' + safeCode + '">' + label + "</option>";
            html2 += '<option value="' + safeCode + '">' + label + "</option>";
            html3 += '<option value="' + safeCode + '">' + label + "</option>";
            if (isAvail) availableCodes.push(code);
            gridHtml +=
              '<button type="button" class="seat-chip' + (isAvail ? "" : " occupied") + '" data-seat-code="' +
              safeCode +
              '"><span class="seat-chip-code">' +
              safeCode +
              '</span><span class="seat-chip-tag">' +
              safeTag +
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
                var safeKey = escHtml(key);
                var safeLayer = escHtml(r.layer_name);
                var safeName = escHtml(r.region_name);
                var safeAvail = escHtml(r.available_seats);
                var safeTotal = escHtml(r.total_seats);
                LIVE_REGIONS_MAP[key] = {
                  name: r.region_name,
                  layerName: r.layer_name,
                  totalSeats: r.total_seats,
                  availableSeats: r.available_seats
                };
                optHtml +=
                  '<option value="' +
                  safeKey +
                  '">' +
                  safeLayer +
                  " · " +
                  safeName +
                  "（空闲 " +
                  safeAvail +
                  "/" +
                  safeTotal +
                  "）</option>";
                if (idx < 8) {
                  pillsHtml +=
                    '<button type="button" class="area-pill' +
                    (idx === 0 ? " active" : "") +
                    '" data-area-pill="' +
                    safeKey +
                    '">' +
                    safeName +
                    " (" +
                    safeAvail +
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
                if (el3) el3.textContent = "累计已用 🍑 " + used + " · 占座成功每次扣除 " + PRICE_PEACH_TEXT + " 🍑（未成功不扣费）";
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
                accepted_price_version: ACCEPTED_PRICE_VERSION,
                accepted_price_micropeach: ACCEPTED_PRICE_MICROPEACH,
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
            var order = data.order || {};
            if (order.payment_state === "PAID") {
              showToast("占座成功！" + alias + " 已从您的 XPeach 账户扣除 " + (order.price_micropeach / 10000) + " 🍑。");
            } else if (order.payment_state === "PAYMENT_DUE") {
              showToast("占座成功！" + alias + " 余额不足，订单待支付；已确认的座位仍保留。", true);
            } else if (order.payment_state === "NOT_REQUIRED") {
              showToast("占座成功！" + alias + " 本次无需支付。");
            } else {
              showToast("占座成功！" + alias + " 扣费结果待核实，请查看账单。", true);
            }
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
          var stationName = null;
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
              smsPreview.innerHTML = "✅ 已识别取件码：<strong class='xp-meta-highlight'>" + escHtml(parsed.pickupCode) + "</strong> · 驿站：<strong>" + escHtml(parsed.stationName) + "</strong> · 快递：<strong>" + escHtml(parsed.carrierName) + "</strong>";
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
            var pickupCode = parsed.pickupCode || null;
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
                status: pickupCode ? "READY_FOR_PICKUP" : "IN_TRANSIT",
                pickup_code: pickupCode,
                station_name: stationName,
                raw_notification_text: sms || "网页端录入取件码"
              })
            })
              .then(function () {
                showToast(pickupCode ? "取件码 " + pickupCode + " 已保存并同步至 App！" : "运单已保存，等待有效取件码。");
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

        // Admin: one operator requests, another authenticates and approves the saved refund.
        document.querySelectorAll("[data-refund-order]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var orderId = btn.getAttribute("data-refund-order");
            var refundRequestId = btn.getAttribute("data-refund-request") || null;
            var refundPayload = refundRequestId
              ? { refund_request_id: refundRequestId }
              : { reason: "管理员在站点后台申请退还 🍑" };
            var priorLabel = btn.textContent;
            btn.disabled = true;
            btn.textContent = "处理中…";
            apiFetch("/api/v1/admin/orders/" + encodeURIComponent(orderId) + "/quick-refund", {
              method: "POST",
              body: JSON.stringify(refundPayload)
            })
              .then(function (res) {
                var order = (res && res.data) || {};
                if (order.payment_state === "REFUNDED") {
                  showToast("已将 " + (order.refunded_micropeach / 10000) + " 🍑 原路退还至用户 XPeach 账户！");
                } else {
                  showToast("退款申请已保存，需另一位有权限的财务人员登录审批；尚未退款。");
                }
                setTimeout(function () { window.location.reload(); }, 600);
              })
              .catch(function (err) {
                btn.disabled = false;
                btn.textContent = priorLabel;
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
