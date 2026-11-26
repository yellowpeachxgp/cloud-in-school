import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {
  REPO_ROOT,
  ContractError,
  DEFAULT_SCHOOL_ID,
  generateRequestId,
  okEnvelope,
  errorEnvelope
} from "../../../packages/contracts/src/index.mjs";
import {
  renderConsoleHtml,
  renderMobileCallbackHtml,
  renderLoginRecoveryHtml,
  CONSOLE_UI_VERSION
} from "../../console/src/main.mjs";

export function compileRoutePattern(pathTemplate) {
  const paramNames = [];
  const regexSource =
    "^" +
    pathTemplate.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    }) +
    "$";
  return {
    regex: new RegExp(regexSource),
    paramNames
  };
}

function compileRouteTable(routeTable, label) {
  if (!Array.isArray(routeTable)) {
    throw new Error(label + " route table must be an array");
  }
  const seenKeys = new Set();
  const seenOperations = new Set();
  return routeTable.map((routeDef, index) => {
    const keys = Object.keys(routeDef || {}).sort();
    const expected = ["auth", "handler", "method", "operationId", "path"];
    if (keys.join(",") !== expected.join(",")) {
      throw new Error(label + " route " + index + " must have exactly {method,path,operationId,handler,auth}");
    }
    for (const field of ["method", "path", "operationId", "auth"]) {
      if (typeof routeDef[field] !== "string" || routeDef[field].length === 0) {
        throw new Error(label + " route " + index + " has invalid " + field);
      }
    }
    if (typeof routeDef.handler !== "function") {
      throw new Error(label + " route " + index + " handler must be a function");
    }
    const method = routeDef.method.toUpperCase();
    const key = method + " " + routeDef.path;
    if (seenKeys.has(key)) throw new Error("Duplicate " + label + " route: " + key);
    if (seenOperations.has(routeDef.operationId)) {
      throw new Error("Duplicate " + label + " operationId: " + routeDef.operationId);
    }
    seenKeys.add(key);
    seenOperations.add(routeDef.operationId);
    const { regex, paramNames } = compileRoutePattern(routeDef.path);
    return {
      method,
      path: routeDef.path,
      operationId: routeDef.operationId,
      handler: routeDef.handler,
      auth: routeDef.auth,
      regex,
      paramNames
    };
  });
}

function publicRoute(routeDef) {
  return {
    method: routeDef.method,
    path: routeDef.path,
    operationId: routeDef.operationId,
    auth: routeDef.auth
  };
}

function normalizeHandlerSource(handler) {
  const lines = String(handler)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""));
  const continuationIndents = lines
    .slice(1)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^\s*/u)[0].length);
  const commonIndent = continuationIndents.length > 0 ? Math.min(...continuationIndents) : 0;
  return lines
    .map((line, index) => {
      if (index === 0) return line.trim();
      if (!line.trim()) return "";
      return line.slice(Math.min(commonIndent, line.length)).trimEnd();
    })
    .join("\n")
    .trim();
}

function canonicalRouteBehaviorEntry(routeDef) {
  return {
    method: routeDef.method,
    path: routeDef.path,
    operationId: routeDef.operationId,
    auth: routeDef.auth,
    handler_source: normalizeHandlerSource(routeDef.handler)
  };
}

function escapeClaimHtml(raw) {
  return String(raw ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createCampusRouter(ctx, { coreRoutes: coreRouteTable = [], extensionRoutes: extensionRouteTable = [] } = {}) {
  const {
    store,
    financeBridge,
    financeService,
    identity,
    redisBuffer,
    trustProxyHeaders,
    extractBearer,
    isAdminOrOperatorAuth
  } = ctx;
  const routes = compileRouteTable(coreRouteTable, "core");
  const extensionRoutes = compileRouteTable(extensionRouteTable, "extension");

  const SECURITY_HEADERS = {
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer"
  };

  // Console page perf: never block page render on the SSO finance-matrix call.
  // This cache is intentionally created inside createCampusRouter so every app
  // instance receives independent mutable state.
  const financeMatrixCache = { atMs: 0, data: null, inFlight: null };
  const FINANCE_MATRIX_TTL_MS = 60_000;
  function getFinanceMatrixCached(nowMs = Date.now()) {
    const fresh =
      financeMatrixCache.data !== null && nowMs - financeMatrixCache.atMs < FINANCE_MATRIX_TTL_MS;
    if (!fresh && !financeMatrixCache.inFlight) {
      financeMatrixCache.inFlight = financeBridge
        .getSiteFinanceMatrix()
        .then((d) => {
          if (d && typeof d === "object") {
            financeMatrixCache.data = d;
            financeMatrixCache.atMs = Date.now();
          }
        })
        .catch(() => {})
        .finally(() => {
          financeMatrixCache.inFlight = null;
        });
    }
    return financeMatrixCache.data;
  }

  // Short-lived per-view payload memo and static asset cache are per-app router state.
  const consoleViewDataMemo = new Map();
  const CONSOLE_VIEW_MEMO_MS = 1_500;
  const staticAssetCache = new Map();

  function setDraining(value) {
    ctx.drainState.isDraining = Boolean(value);
  }

  // Unified task lifecycle registry (S1): EVERY kind of in-flight work is
  // registered — HTTP mutations, scheduler scans, finance retry batches —
  // so graceful shutdown can actually wait for the real work, not just the
  // HTTP subset.
  function isDraining() {
    return Boolean(ctx.drainState?.isDraining);
  }
  const lifecycleTasks = new Map(); // kind -> Set<taskId>
  let lifecycleSeq = 0;
  function registerLifecycleTask(kind) {
    const id = ++lifecycleSeq;
    const k = String(kind || "task");
    if (!lifecycleTasks.has(k)) lifecycleTasks.set(k, new Set());
    lifecycleTasks.get(k).add(id);
    return { kind: k, id };
  }
  function unregisterLifecycleTask(token) {
    const set = lifecycleTasks.get(token?.kind);
    if (set) {
      set.delete(token.id);
      if (set.size === 0) lifecycleTasks.delete(token.kind);
    }
  }
  function lifecycleTaskCounts() {
    const counts = {};
    for (const [kind, set] of lifecycleTasks) counts[kind] = set.size;
    return counts;
  }

  async function inject({
    method = "GET",
    url = "/healthz",
    headers = {},
    body = undefined,
    nowMs = Date.now(),
    remoteAddr = null
  }) {
    const requestId = generateRequestId(headers["x-request-id"] || headers["X-Request-Id"]);
    const upperMethodEarly = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
    // Graceful shutdown fence: once draining, refuse new mutating work with a
    // retryable 503 — clients see an honest state, never a half-applied write.
    if (isDraining() && upperMethodEarly !== "GET") {
      return {
        status: 503,
        headers: { "retry-after": "2" },
        body: {
          ok: false,
          code: "SERVER_DRAINING",
          request_id: requestId,
          error: { code: "SERVER_DRAINING", message: "服务正在停机维护，请稍后重试" }
        }
      };
    }
    let httpTask = null;
    let requestPathname = null;
    if (upperMethodEarly !== "GET") httpTask = registerLifecycleTask("http");
    try {
      store.recoverDurabilitySync?.();
      store.assertStorageWritable?.();
      const parsedUrl = new URL(url, "http://localhost");
      const pathname = parsedUrl.pathname;
      requestPathname = pathname;
      const upperMethod = upperMethodEarly;

      // Static assets copied 1:1 from xpeach-sso (/static/app.css, /static/app.js, /static/xpeach-logo.png)
      // In-memory buffer cache (5s stat freshness) + weak ETag so repeat loads
      // skip disk I/O and unchanged assets answer 304 instead of re-downloading.
      if (upperMethod === "GET" && (pathname.startsWith("/static/") || pathname === "/favicon.ico")) {
        const staticDir = path.join(REPO_ROOT, "apps/console/public/static");
        const fileName =
          pathname === "/favicon.ico"
            ? "xpeach-logo.png"
            : path.basename(pathname);
        const filePath = path.join(staticDir, fileName);
        let asset = staticAssetCache.get(filePath);
        if (!asset || nowMs - asset.atMs > 5_000) {
          const st = fs.statSync(filePath, { throwIfNoEntry: false });
          if (!st?.isFile()) {
            staticAssetCache.delete(filePath);
            asset = null;
          } else {
            const ext = path.extname(fileName).toLowerCase();
            asset = {
              buf: fs.readFileSync(filePath),
              etag: `W/"${st.size}-${Math.trunc(st.mtimeMs)}"`,
              mime:
                ext === ".css"
                  ? "text/css; charset=utf-8"
                  : ext === ".js"
                    ? "application/javascript; charset=utf-8"
                    : ext === ".png"
                      ? "image/png"
                      : "application/octet-stream",
              atMs: nowMs
            };
            staticAssetCache.set(filePath, asset);
          }
        }
        if (asset) {
          if (
            headers?.["if-none-match"] === asset.etag ||
            headers?.["If-None-Match"] === asset.etag
          ) {
            return {
              status: 304,
              headers: { etag: asset.etag, "cache-control": "public, max-age=3600" },
              rawBody: "",
              body: okEnvelope("STATIC_ASSET_NOT_MODIFIED", { file: fileName }, requestId)
            };
          }
          return {
            status: 200,
            headers: {
              "content-type": asset.mime,
              etag: asset.etag,
              "cache-control": "public, max-age=3600",
              "x-request-id": requestId
            },
            rawBody: asset.buf,
            body: okEnvelope("STATIC_ASSET_OK", { file: fileName }, requestId)
          };
        }
      }

      const webConsoleRoutes = new Map([
        ["/", "reservations"],
        ["/reservations", "reservations"],
        ["/console", "console"],
        ["/console/jobs", "jobs"],
        ["/console/orders", "orders"],
        ["/console/audit", "audit"],
        ["/console/schools", "schools"],
        ["/console/content", "content"]
      ]);
      const retiredConsoleRoutes = new Set(["/community", "/parcels"]);
      const portalAliasRoutes = new Set(["/portal", "/orders"]);

      const consolePathname =
        pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

      if (upperMethod === "GET" && portalAliasRoutes.has(consolePathname)) {
        return {
          status: 302,
          headers: { Location: "/reservations", "cache-control": "no-store", "x-request-id": requestId },
          rawBody: "",
          body: okEnvelope("PORTAL_ROUTE_REDIRECT", { to: "/reservations" }, requestId)
        };
      }

      if (upperMethod === "GET" && retiredConsoleRoutes.has(consolePathname)) {
        return {
          status: 302,
          headers: { Location: "/console", "cache-control": "no-store", "x-request-id": requestId },
          rawBody: "",
          body: okEnvelope("CONSOLE_ROUTE_RETIRED", { to: "/console" }, requestId)
        };
      }

      if (upperMethod === "GET" && webConsoleRoutes.has(consolePathname)) {
        const activeNav = webConsoleRoutes.get(consolePathname);
        const isPortalRoute = activeNav === "reservations";
        // Stage-nav version handshake: a cached page holding an older
        // UI_ASSET_VERSION must full-reload instead of partial-swapping
        // markup built for a different JS/CSS bundle.
        const stageNavVersion = headers?.["x-stage-nav"] || headers?.["X-Stage-Nav"];
        if (stageNavVersion && stageNavVersion !== CONSOLE_UI_VERSION) {
          return {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
              "x-request-id": requestId
            },
            rawBody: JSON.stringify({
              ok: false,
              code: "UI_VERSION_STALE",
              reload: true,
              version: CONSOLE_UI_VERSION
            }),
            body: okEnvelope("UI_VERSION_STALE", { reload: true }, requestId)
          };
        }
        const rawCookieAuth = identity.verifyWebSessionCookie(
          headers?.cookie || headers?.Cookie || "",
          nowMs
        );
        const isCookieAdmin = Boolean(
          rawCookieAuth && store.hasAdminAccess?.(rawCookieAuth.cloudUserId)
        );
        const cookieAuth = isPortalRoute
          ? rawCookieAuth
          : isCookieAdmin
            ? rawCookieAuth
            : null;
        const referer = String(headers?.referer || headers?.Referer || "");
        let isTrustedSsoReferer = false;
        if (referer) {
          try {
            const parsedRef = new URL(referer);
            isTrustedSsoReferer =
              parsedRef.protocol === "https:" && parsedRef.hostname === "sso.xpeach.codes";
          } catch {
            isTrustedSsoReferer = false;
          }
        }
        if (
          !cookieAuth &&
          !(rawCookieAuth && !isPortalRoute) &&
          isTrustedSsoReferer &&
          !parsedUrl.searchParams.has("web_ticket") &&
          !parsedUrl.searchParams.has("code")
        ) {
          const webTxn = identity.startWebTransaction(
            {
              returnTo: isPortalRoute ? "/reservations" : pathname,
              flowKind: isPortalRoute ? "WEB_PORTAL" : "WEB_CONSOLE"
            },
            nowMs
          );
          return {
            status: 302,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "x-request-id": requestId,
              Location: webTxn.redirect_url
            },
            rawBody: "",
            body: okEnvelope("WEB_OIDC_AUTO_REDIRECT", webTxn, requestId)
          };
        }

        let consoleCtx = {
          activeNav,
          authLandingMode: isPortalRoute ? "portal" : "console",
          nonAdminBlocked: Boolean(!isPortalRoute && rawCookieAuth && !isCookieAdmin),
          pricingMicropeach: store.pricingMicropeach,
          campusContent: store.getCampusContent(DEFAULT_SCHOOL_ID, { includeDisabled: false })
        };
        if (cookieAuth) {
          if (isPortalRoute) {
            const wallet = await financeService.getWalletSnapshot(cookieAuth.cloudUserId);
            const userBindings = store.recordsForUser("schoolBindings", cookieAuth.cloudUserId);
            const userPlans = store.recordsForUser("reservationPlans", cookieAuth.cloudUserId);
            const userJobs = store
              .recordsForUser("reservationJobs", cookieAuth.cloudUserId)
              .map((j) => {
                store.syncJobDisplayStatus?.(j);
                return j;
              });
            const userOrders = store.recordsForUser("reservationOrders", cookieAuth.cloudUserId);
            consoleCtx = {
              user: cookieAuth.user,
              roles: cookieAuth.roles,
              activeNav,
              nowIso: new Date(nowMs).toISOString(),
              pricingMicropeach: store.pricingMicropeach,
              accessToken: cookieAuth.accessToken,
              wallet,
              userBindings,
              userPlans,
              userJobs,
              userOrders
            };
          } else {
            const memoEntry = consoleViewDataMemo.get(activeNav);
            let viewData =
              memoEntry && nowMs - memoEntry.atMs < CONSOLE_VIEW_MEMO_MS ? memoEntry.data : null;
            if (!viewData) {
              viewData = {};
              if (activeNav === "console") {
                viewData.adminStats = {
                  users_count: store.users.size,
                  active_bindings_count: Array.from(store.schoolBindings.values()).filter(
                    (b) => !b.revoked_at
                  ).length,
                  jobs_count: store.reservationJobs.size,
                  orders_count: store.reservationOrders.size,
                  parcels_count: store.parcels.size,
                  audit_events_count: store.auditEvents.length
                };
                viewData.allUsers = Array.from(store.users.values()).map((u) => ({
                  id: u.id,
                  username: u.username,
                  display_name: u.display_name,
                  subject: u.subject,
                  role: u.role,
                  status: u.status,
                  roles: store.getUserRoles(u.id)
                }));
                viewData.auditEvents = store.auditEvents.slice(-10).reverse();
                viewData.schools = Array.from(store.schoolIntegrations.values());
                viewData.financeMatrix = getFinanceMatrixCached(nowMs);
              } else if (activeNav === "jobs") {
                viewData.allJobs = Array.from(store.reservationJobs.values()).map((j) => {
                  const u = store.users.get(j.cloud_user_id);
                  const p = j.plan_id ? store.reservationPlans.get(j.plan_id) : null;
                  return {
                    ...j,
                    username: u?.username || u?.display_name || j.cloud_user_id,
                    plan_label: p?.area_name || p?.area_code || null
                  };
                });
                viewData.allEvents = Array.from(store.scheduleEvents.values());
              } else if (activeNav === "orders") {
                viewData.allOrders = Array.from(store.reservationOrders.values()).map((o) => {
                  const u = store.users.get(o.cloud_user_id);
                  return {
                    ...o,
                    username: u?.username || u?.display_name || o.cloud_user_id,
                    sso_subject: u?.subject || "-"
                  };
                });
                // Dual-person refund workflow visibility: pending requests +
                // the legacy reconcile queue must be visible to finance staff.
                viewData.refundRequests = Array.from(store.refundRequests.values());
                viewData.legacyRefundOps = Array.from(store.financeOperations.values()).filter(
                  (op) => op.kind === "REFUND" && op.legacy_reconcile_required
                );
                viewData.financeMatrix = getFinanceMatrixCached(nowMs);
              } else if (activeNav === "audit") {
                viewData.auditEvents = store.auditEvents.slice(-200).reverse();
              } else if (activeNav === "schools") {
                viewData.schools = Array.from(store.schoolIntegrations.values());
              } else if (activeNav === "content") {
                viewData.campusContent = store.getCampusContent(DEFAULT_SCHOOL_ID, {
                  includeDisabled: true
                });
              }
              consoleViewDataMemo.set(activeNav, { atMs: nowMs, data: viewData });
            }
            consoleCtx = {
              user: cookieAuth.user,
              roles: cookieAuth.roles,
              activeNav,
              nowIso: new Date(nowMs).toISOString(),
              pricingMicropeach: store.pricingMicropeach,
              accessToken: cookieAuth.accessToken,
              ...viewData
            };
          }
        }

        return {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store, no-cache, must-revalidate",
            "x-request-id": requestId,
            "x-response-time": `${Date.now() - nowMs}ms`,
            "server-timing": `app;dur=${Date.now() - nowMs}`
          },
          rawBody: renderConsoleHtml(consoleCtx),
          body: okEnvelope("CONSOLE_PORTAL_OK", { portal: "cloud-in-school-console" }, requestId)
        };
      }

      if (upperMethod === "GET" && pathname.startsWith("/claim/")) {
        const rawCode = decodeURIComponent(pathname.slice("/claim/".length)).trim().toUpperCase();
        const foundTag = (store.momentsState?.anti_lost_tags || []).find((t) => t.tag_code.toUpperCase() === rawCode);
        const isDisabledOrMissing = !foundTag || String(foundTag.status || "").toUpperCase() === "DISABLED";
        const activeTag = isDisabledOrMissing ? null : foundTag;
        // Public projection: ONLY expose owner_contact when BOTH owner explicitly set status=LOST (owner_declared_lost === true)
        // AND owner explicitly opted into contact_visibility === 'PUBLIC_WHEN_LOST'!
        // Restricted/private/NORMAL/legacy tags NEVER expose owner_contact, even after anonymous report-found!
        const canPubliclyShowContact = Boolean(
          activeTag &&
            activeTag.contact_visibility === "PUBLIC_WHEN_LOST" &&
            activeTag.owner_declared_lost === true &&
            (activeTag.status === "LOST" || activeTag.status === "FOUND_REPORTED") &&
            activeTag.owner_contact
        );
        const itemTitle = activeTag ? escapeClaimHtml(activeTag.item_name) : "未登记或已停用的防丢标签";
        const ownerName = !activeTag
          ? "未知失主"
          : canPubliclyShowContact
            ? escapeClaimHtml(activeTag.owner_name)
            : "已登记失主";
        const ownerContact = !activeTag
          ? "未找到有效的防丢码登记记录"
          : canPubliclyShowContact
            ? escapeClaimHtml(activeTag.owner_contact)
            : "失主联系方式受隐私保护，请通过下方表单留言通知失主";
        const returnNote = activeTag
          ? escapeClaimHtml(activeTag.return_note)
          : "该防丢码尚未在云端登记或已被失主停用，无法投递拾得通知。";
        const formHtml = activeTag
          ? [
              '<form id="f">',
              '<label>拾得/放置地点 *</label>',
              '<input id="loc" required placeholder="例如：图书馆一楼服务台 / 一餐厅服务台"/>',
              '<label>您的称呼或联系方式</label>',
              '<input id="contact" placeholder="例如：QQ / 微信 / 电话（选填）"/>',
              '<label>补充留言</label>',
              '<textarea id="memo" rows="2" placeholder="描述物品当前放置位置"></textarea>',
              '<button type="submit">通知失主已拾得</button>',
              '<div id="ok" class="msg">已提交拾得线索，失主打开「日在校园」即可收到提醒，感谢您的热心相助！</div>',
              '<div id="err" class="err"></div>',
              '</form>',
              '<script>',
              'document.getElementById("f").addEventListener("submit", function(e){',
              '  e.preventDefault();',
              '  var okEl = document.getElementById("ok"); var errEl = document.getElementById("err");',
              '  okEl.style.display = "none"; errEl.style.display = "none";',
              '  fetch("/api/v1/moments/anti-lost-tags/" + encodeURIComponent(' + JSON.stringify(rawCode) + ') + "/report-found", {',
              '    method: "POST", headers: {"Content-Type": "application/json"},',
              '    body: JSON.stringify({found_location: document.getElementById("loc").value, finder_contact: document.getElementById("contact").value, message: document.getElementById("memo").value})',
              '  }).then(function(r){ return r.json().then(function(j){ if(!r.ok || !j.ok) throw new Error((j.error && j.error.message) || "提交失败，请检查防丢码是否有效"); okEl.style.display = "block"; }); })',
              '  .catch(function(ex){ errEl.textContent = ex.message || "网络异常，未能提交拾得通知"; errEl.style.display = "block"; });',
              '});',
              '</script>'
            ].join("\n")
          : "";
        const html = [
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>',
          '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>',
          '<title>防丢码认领 · ' + escapeClaimHtml(rawCode) + '</title>',
          '<style>',
          'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f4f7fb;color:#111827;margin:0;padding:20px;}',
          '.card{max-width:440px;margin:16px auto;background:#fff;border-radius:18px;padding:22px;box-shadow:0 8px 24px rgba(15,23,42,0.06);}',
          '.badge{display:inline-block;background:#e0f2fe;color:#0369a1;font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;}',
          'h1{font-size:20px;margin:10px 0 4px;}',
          '.meta{font-size:13px;color:#4b5563;margin-bottom:14px;}',
          '.note{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px;font-size:14px;line-height:1.5;margin-bottom:16px;}',
          'label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px;}',
          'input,textarea{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:10px;padding:10px;font-size:14px;}',
          'button{width:100%;margin-top:14px;background:#053968;color:#fff;border:none;border-radius:12px;padding:12px;font-size:15px;font-weight:600;cursor:pointer;}',
          '.msg{margin-top:12px;font-size:13px;color:#059669;font-weight:600;display:none;}',
          '.err{margin-top:12px;font-size:13px;color:#dc2626;font-weight:600;display:none;}',
          '</style></head><body><div class="card">',
          '<span class="badge">日在校园 · 防丢码 ' + escapeClaimHtml(rawCode) + '</span>',
          '<h1>' + itemTitle + '</h1>',
          '<div class="meta">失主：' + ownerName + ' · 联系：' + ownerContact + '</div>',
          '<div class="note">' + returnNote + '</div>',
          formHtml,
          '</div></body></html>'
        ].join("\n");
        return {
          status: activeTag ? 200 : 404,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "x-request-id": requestId
          },
          rawBody: html,
          body: okEnvelope(activeTag ? "CLAIM_PAGE_OK" : "CLAIM_TAG_NOT_FOUND", { tag_code: rawCode }, requestId)
        };
      }

      if (upperMethod === "GET" && pathname === "/app-link/auth/callback") {
        const ticket = parsedUrl.searchParams.get("ticket") || "";
        const txn = parsedUrl.searchParams.get("txn") || "";
        return {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "x-request-id": requestId
          },
          rawBody: renderMobileCallbackHtml({ ticket, txn }),
          body: okEnvelope("MOBILE_CALLBACK_OK", { ticket, txn }, requestId)
        };
      }

      let matchedRoute = null;
      let params = {};
      const allRoutes = [...routes, ...extensionRoutes];
      for (const route of allRoutes) {
        if (route.method !== upperMethod) continue;
        const m = pathname.match(route.regex);
        if (m) {
          matchedRoute = route;
          route.paramNames.forEach((name, idx) => {
            try {
              params[name] = decodeURIComponent(m[idx + 1]);
            } catch {
              throw new ContractError("BAD_REQUEST", "Malformed path parameter encoding");
            }
          });
          break;
        }
      }

      if (!matchedRoute) {
        throw new ContractError("NOT_FOUND", `Route not found: ${upperMethod} ${pathname}`);
      }

      let auth = null;
      if (
        matchedRoute.auth === "anonymous_rate_limited" ||
        matchedRoute.auth === "login_txn" ||
        matchedRoute.auth === "single_use_ticket" ||
        matchedRoute.auth === "oidc_state_nonce"
      ) {
        const clientIp =
          (trustProxyHeaders
            ? String(headers?.["x-forwarded-for"] || "").split(",")[0].trim()
            : "") ||
          remoteAddr ||
          "anon_default";
        const rl = await redisBuffer.checkRateLimit(
          `${matchedRoute.operationId}:${clientIp}`,
          60,
          60,
          nowMs
        );
        if (!rl.allowed) {
          throw new ContractError(
            "RATE_LIMITED",
            `Too many requests for ${matchedRoute.operationId}; limit ${rl.limit}/60s`
          );
        }
      }
      if (
        matchedRoute.auth === "bearer" ||
        matchedRoute.auth === "bearer_rbac" ||
        matchedRoute.auth === "bearer_admin"
      ) {
        auth = extractBearer(headers, nowMs, upperMethod);
        if (matchedRoute.auth === "bearer_admin" && !isAdminOrOperatorAuth(auth)) {
          throw new ContractError("FORBIDDEN", "需要管理员或运营权限");
        }
      }

      store.assertStorageWritable?.();
      const result = await matchedRoute.handler({
        method: upperMethod,
        pathname,
        query: parsedUrl.searchParams,
        params,
        headers,
        body,
        auth,
        nowMs,
        requestId
      });

      const status = result.status || 200;
      const envelope = okEnvelope(result.code || "OK", result.data, requestId);
      return {
        status,
        headers: {
          ...SECURITY_HEADERS,
          "content-type": "application/json; charset=utf-8",
          "x-request-id": requestId,
          ...(result.headers || {})
        },
        ...(result.rawBody !== undefined ? { rawBody: result.rawBody } : {}),
        body: envelope
      };
    } catch (err) {
      const errEnv = errorEnvelope(err, requestId);
      const accept = String(headers?.accept || headers?.Accept || "");
      if (requestPathname === "/api/v1/auth/oidc/callback" && err?.code === "CLOUD_AUTH_REQUIRED" &&
          accept.includes("text/html") && !accept.includes("application/json")) {
        // 旧回调仍拒绝重放；已有独立有效会话时回到工作台，不重新签发票据。
        let currentSession = null;
        try { currentSession = identity.verifyWebSessionCookie(headers?.cookie || headers?.Cookie || "", nowMs); } catch {}
        return {
          status: currentSession ? 303 : errEnv.httpStatus,
          headers: {
            ...SECURITY_HEADERS,
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-request-id": requestId,
            ...(currentSession ? { Location: "/reservations" } : {})
          },
          rawBody: currentSession ? "" : renderLoginRecoveryHtml(),
          body: errEnv.body
        };
      }
      return {
        status: errEnv.httpStatus,
        headers: {
          ...SECURITY_HEADERS,
          "content-type": "application/json; charset=utf-8",
          "x-request-id": requestId
        },
        body: errEnv.body
      };
    } finally {
      if (httpTask) unregisterLifecycleTask(httpTask);
    }
  }

  const MAX_HTTP_BODY_BYTES = 1024 * 1024;

  function sanitizeParsedJson(val) {
    if (!val || typeof val !== "object") return val;
    if (Array.isArray(val)) return val.map(sanitizeParsedJson);
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = sanitizeParsedJson(v);
    }
    return out;
  }

  function createHttpServer() {
    return http.createServer(async (req, res) => {
      try {
        const chunks = [];
        let totalBytes = 0;
        for await (const chunk of req) {
          totalBytes += chunk.length;
          if (totalBytes > MAX_HTTP_BODY_BYTES) {
            res.writeHead(413, {
              ...SECURITY_HEADERS,
              "content-type": "application/json; charset=utf-8"
            });
            res.end(
              JSON.stringify({
                ok: false,
                error: {
                  code: "PAYLOAD_TOO_LARGE",
                  message: "Request body exceeds 1 MB limit"
                }
              })
            );
            req.destroy();
            return;
          }
          chunks.push(chunk);
        }
        const rawBody = Buffer.concat(chunks).toString("utf8");
        let parsedBody = undefined;
        if (rawBody && rawBody.trim().length > 0) {
          try {
            parsedBody = sanitizeParsedJson(JSON.parse(rawBody));
          } catch {
            res.writeHead(400, {
              ...SECURITY_HEADERS,
              "content-type": "application/json; charset=utf-8"
            });
            res.end(
              JSON.stringify({
                ok: false,
                code: "BAD_REQUEST",
                error: {
                  code: "BAD_REQUEST",
                  message: "Malformed JSON request body"
                }
              })
            );
            return;
          }
        }
        const response = await inject({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: parsedBody,
          remoteAddr: req.socket?.remoteAddress || null
        });
        res.writeHead(response.status, {
          ...SECURITY_HEADERS,
          ...(response.headers || {})
        });
        if (typeof response.rawBody === "string" || Buffer.isBuffer(response.rawBody)) {
          res.end(response.rawBody);
        } else {
          res.end(JSON.stringify(response.body));
        }
      } catch (err) {
        // 停机强制关闭未读完的请求会抛 ECONNRESET，必须由 HTTP 边界消化。
        if (!res.destroyed) res.destroy(err);
      }
    });
  }

  function getRegisteredCoreRoutes() {
    return routes.map(publicRoute);
  }

  function getRegisteredExtensionRoutes() {
    return extensionRoutes.map(publicRoute);
  }

  function getRegisteredRoutes() {
    return [...getRegisteredCoreRoutes(), ...getRegisteredExtensionRoutes()];
  }

  function getRouteBehaviorFingerprint(operationIds) {
    const requested = Array.isArray(operationIds) ? operationIds : [];
    const selected = [];
    const missing = [];
    for (const operationId of requested) {
      const found = routes.find((routeDef) => routeDef.operationId === operationId);
      if (found) selected.push(found);
      else missing.push(operationId);
    }
    if (missing.length > 0) {
      throw new Error("Unknown core operationId for route behavior fingerprint: " + missing.join(","));
    }
    const canonical = {
      fingerprint_version: "canonical-route-handler/v1",
      entries: selected.map(canonicalRouteBehaviorEntry)
    };
    return crypto.createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  }

  return {
    inject,
    createHttpServer,
    getRegisteredRoutes,
    getRegisteredCoreRoutes,
    getRegisteredExtensionRoutes,
    getRouteBehaviorFingerprint,
    setDraining,
    isDraining,
    registerLifecycleTask,
    unregisterLifecycleTask,
    getInFlightTasks: () => lifecycleTaskCounts(),
    getInFlightWrites: () => lifecycleTasks.get("http")?.size || 0
  };
}
