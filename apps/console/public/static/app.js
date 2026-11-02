(() => {
  const root = document.documentElement;
  const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const UI_ASSET_VERSION = "20261030q";

  function escapeCssAttr(val) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(String(val));
    }
    return String(val).replace(/["\\]/g, "\\$&");
  }

  // 1. System-Following Theme Engine (Auto-Follow OS Light/Dark + Instant Toggle)
  function applyEffectiveTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem("xp_theme");
    } catch {
      /* storage unavailable */
    }
    const osDark = darkQuery ? darkQuery.matches : false;
    const effective = saved === "dark" || saved === "light" ? saved : osDark ? "dark" : "light";
    root.setAttribute("data-theme", effective);
    root.style.colorScheme = effective;
  }

  function syncSidebarToggleA11y(isCollapsed) {
    document.querySelectorAll("[data-sidebar-toggle]").forEach((btn) => {
      btn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
      btn.setAttribute("data-collapsed", isCollapsed ? "true" : "false");
    });
  }

  function applySidebarState() {
    try {
      const sbWidth = localStorage.getItem("xp_sidebar_width");
      if (sbWidth && /^\d+(\.\d+)?px$/.test(sbWidth)) {
        const numeric = parseFloat(sbWidth);
        if (numeric >= 180 && numeric <= 380) {
          root.style.setProperty("--sidebar-width", `${Math.round(numeric)}px`);
        }
      }
      const collapsed = localStorage.getItem("xp_sidebar_collapsed") === "1";
      if (collapsed) {
        root.setAttribute("data-sidebar-collapsed", "true");
      } else {
        root.removeAttribute("data-sidebar-collapsed");
      }
      syncSidebarToggleA11y(collapsed);
    } catch {
      /* storage unavailable */
    }
  }

  function setSidebarCollapsed(nextCollapsed) {
    if (nextCollapsed) {
      root.setAttribute("data-sidebar-collapsed", "true");
    } else {
      root.removeAttribute("data-sidebar-collapsed");
    }
    syncSidebarToggleA11y(nextCollapsed);
    try {
      if (nextCollapsed) {
        localStorage.setItem("xp_sidebar_collapsed", "1");
      } else {
        localStorage.removeItem("xp_sidebar_collapsed");
      }
    } catch {
      /* ignore */
    }
  }

  applyEffectiveTheme();
  applySidebarState();

  if (darkQuery) {
    const onSystemThemeChange = () => {
      let saved = null;
      try {
        saved = localStorage.getItem("xp_theme");
      } catch {
        /* ignore */
      }
      if (saved !== "dark" && saved !== "light") {
        applyEffectiveTheme();
      }
    };
    if (typeof darkQuery.addEventListener === "function") {
      darkQuery.addEventListener("change", onSystemThemeChange);
    } else if (typeof darkQuery.addListener === "function") {
      darkQuery.addListener(onSystemThemeChange);
    }
  }

  // 2. Componentized Partial-Update Engine (Links, GET Filter Forms & POST Action Forms)
  let activeNavController = null;

  function snapshotFormInputs(container) {
    const snapshot = new Map();
    if (!container) return snapshot;
    container.querySelectorAll("input, textarea, select").forEach((el, idx) => {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
        return;
      }
      if (el.type === "hidden" || el.type === "submit" || el.type === "button") return;
      const key = `${el.tagName}:${el.name || el.id || idx}`;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        snapshot.set(`${key}:${el.value}`, { checked: el.checked });
      } else {
        snapshot.set(key, { value: el.value });
      }
    });
    return snapshot;
  }

  function restoreFormInputs(container, snapshot) {
    if (!container || !snapshot || snapshot.size === 0) return;
    container.querySelectorAll("input, textarea, select").forEach((el, idx) => {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
        return;
      }
      if (el.type === "hidden" || el.type === "submit" || el.type === "button") return;
      const key = `${el.tagName}:${el.name || el.id || idx}`;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        const entry = snapshot.get(`${key}:${el.value}`);
        if (entry && typeof entry.checked === "boolean") {
          el.checked = entry.checked;
        }
      } else {
        const entry = snapshot.get(key);
        if (entry && typeof entry.value === "string" && entry.value.length > 0) {
          el.value = entry.value;
        }
      }
    });
  }

  function syncShellFragments(nextDoc) {
    if (nextDoc.title) {
      document.title = nextDoc.title;
    }
    const prevLang = root.getAttribute("lang");
    const nextLang = nextDoc.documentElement.getAttribute("lang");
    const langChanged = Boolean(nextLang && nextLang !== prevLang);
    if (nextLang) {
      root.setAttribute("lang", nextLang);
    }

    // Preserve sidebar DOM nodes on normal navigation so logo & pill transitions never flicker
    const curNavItems = document.querySelectorAll(".sidebar-nav .nav-item");
    const nextNavItems = nextDoc.querySelectorAll(".sidebar-nav .nav-item");
    if (!langChanged && curNavItems.length > 0 && curNavItems.length === nextNavItems.length) {
      curNavItems.forEach((curItem, idx) => {
        const nextItem = nextNavItems[idx];
        if (!nextItem) return;
        curItem.classList.toggle("active", nextItem.classList.contains("active"));
        const nextHref = nextItem.getAttribute("href");
        if (nextHref) curItem.setAttribute("href", nextHref);
      });
    } else {
      const curNav = document.querySelector(".sidebar-nav");
      const nextNav = nextDoc.querySelector(".sidebar-nav");
      if (curNav && nextNav) curNav.innerHTML = nextNav.innerHTML;
    }

    const needsSidebarStructureSync =
      !document.querySelector("[data-sidebar-toggle]") ||
      !document.querySelector("[data-sidebar-resizer]");

    const selectors =
      langChanged || needsSidebarStructureSync
        ? [
            ".sidebar-top",
            ".sidebar-foot",
            ".mobile-topbar",
            ".mobile-glass-dock",
            ".portal-topbar",
            ".auth-toolbar",
          ]
        : [".mobile-glass-dock", ".portal-nav"];

    for (const sel of selectors) {
      const curEl = document.querySelector(sel);
      const nextEl = nextDoc.querySelector(sel);
      if (curEl && nextEl) {
        curEl.innerHTML = nextEl.innerHTML;
      }
    }

    // Always sync brand header & brand stylesheet if updated (e.g. after saving Settings)
    for (const brandSel of [".sidebar-top .brand", ".mobile-topbar .brand", ".portal-topbar .portal-brand"]) {
      const curBrand = document.querySelector(brandSel);
      const nextBrand = nextDoc.querySelector(brandSel);
      if (curBrand && nextBrand && curBrand.innerHTML !== nextBrand.innerHTML) {
        curBrand.innerHTML = nextBrand.innerHTML;
      }
    }
    const curBrandCss = document.querySelector('link[rel="stylesheet"][href^="/brand/"]');
    const nextBrandCss = nextDoc.querySelector('link[rel="stylesheet"][href^="/brand/"]');
    if (curBrandCss && nextBrandCss) {
      const nextHref = nextBrandCss.getAttribute("href");
      if (nextHref && curBrandCss.getAttribute("href") !== nextHref) {
        curBrandCss.setAttribute("href", nextHref);
      }
    }

    syncSidebarToggleA11y(root.getAttribute("data-sidebar-collapsed") === "true");
  }

  function showStageAlert(kind, message) {
    const container = document.querySelector("[data-stage-container]") || document.querySelector(".auth-shell");
    if (!container) return;
    let alertEl = container.querySelector(".alert[data-stage-inline-alert]");
    if (!(alertEl instanceof HTMLElement)) {
      alertEl = document.createElement("div");
      alertEl.setAttribute("data-stage-inline-alert", "true");
      alertEl.setAttribute("role", "alert");
      container.prepend(alertEl);
    }
    alertEl.className = `alert alert-${kind === "error" ? "error" : "success"}`;
    alertEl.textContent = message;
    alertEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function applyDocumentUpdate(nextDoc, finalUrl, options = {}) {
    const { pushState = true, preserveScroll = false, preserveInputs = false } = options;
    const prevScrollY = window.scrollY;
    const prevPathname = window.location.pathname;

    // Auto-reload if static stylesheet version changed on the server
    const curCssHref = document.querySelector('link[rel="stylesheet"][href^="/static/app.css"]')?.getAttribute("href");
    const nextCssHref = nextDoc.querySelector('link[rel="stylesheet"][href^="/static/app.css"]')?.getAttribute("href");
    if (curCssHref && nextCssHref && curCssHref !== nextCssHref) {
      window.location.href = finalUrl || window.location.href;
      return;
    }

    const curStage = document.querySelector("[data-stage-container]");
    const nextStage = nextDoc.querySelector("[data-stage-container]");
    const curAuthShell = document.querySelector(".auth-shell");
    const nextAuthShell = nextDoc.querySelector(".auth-shell");

    const curBodyClass = document.body.className;
    const nextBodyClass = nextDoc.body.className;

    // Close any open modal dialogs before swapping
    document.querySelectorAll("dialog[open]").forEach((dlg) => {
      if (dlg instanceof HTMLDialogElement) dlg.close();
    });

    // Remember active in-page tab on same-pathname stage refreshes
    const prevActiveTabTarget =
      curStage?.querySelector("[data-tabs] [data-tab-target].active")?.getAttribute("data-tab-target") ||
      (window.location.hash.startsWith("#tab-") ? window.location.hash.slice(1) : "");

    if (curStage && nextStage && curBodyClass === nextBodyClass) {
      const inputSnapshot = preserveInputs ? snapshotFormInputs(curStage) : null;
      syncShellFragments(nextDoc);
      curStage.innerHTML = nextStage.innerHTML;
      if (inputSnapshot) {
        restoreFormInputs(curStage, inputSnapshot);
      }
      const nextPathnameCheck = finalUrl ? new URL(finalUrl, window.location.origin).pathname : prevPathname;
      if (prevActiveTabTarget && nextPathnameCheck === prevPathname) {
        const tabBtn = curStage.querySelector(
          `[data-tabs] [data-tab-target="${escapeCssAttr(prevActiveTabTarget)}"]`,
        );
        const group = tabBtn?.closest("[data-tabs]");
        if (tabBtn && group) {
          group.querySelectorAll("[data-tab-target]").forEach((btn) => btn.classList.remove("active"));
          group.querySelectorAll("[data-tab-pane]").forEach((pane) => {
            pane.classList.toggle("active", pane.getAttribute("data-tab-pane") === prevActiveTabTarget);
          });
          tabBtn.classList.add("active");
        }
      }
    } else if (curAuthShell && nextAuthShell && curBodyClass === nextBodyClass) {
      const inputSnapshot = preserveInputs ? snapshotFormInputs(curAuthShell) : null;
      syncShellFragments(nextDoc);
      curAuthShell.innerHTML = nextAuthShell.innerHTML;
      if (inputSnapshot) {
        restoreFormInputs(curAuthShell, inputSnapshot);
      }
    } else if (nextDoc.body) {
      // Cross-shell transition (e.g. /portal <-> /console) without full browser reload
      if (nextDoc.title) document.title = nextDoc.title;
      const nextLang = nextDoc.documentElement.getAttribute("lang");
      if (nextLang) root.setAttribute("lang", nextLang);
      document.body.className = nextDoc.body.className;
      document.body.innerHTML = nextDoc.body.innerHTML;
      applySidebarState();
    }

    if (finalUrl) {
      const normalizedFinal = new URL(finalUrl, window.location.origin).href;
      if (pushState && normalizedFinal !== window.location.href) {
        window.history.pushState({ stageUrl: normalizedFinal }, "", normalizedFinal);
      } else if (!pushState && normalizedFinal !== window.location.href) {
        window.history.replaceState({ stageUrl: normalizedFinal }, "", normalizedFinal);
      }
      const nextPathname = new URL(normalizedFinal, window.location.origin).pathname;
      if (preserveScroll || nextPathname === prevPathname) {
        window.scrollTo(0, prevScrollY);
      } else {
        window.scrollTo(0, 0);
      }
    }
  }

  const STAGE_PREFETCH_TTL_MS = 18_000;
  const stagePrefetchCache = new Map();

  function normalizeCacheKey(rawUrl) {
    try {
      const u = new URL(rawUrl, window.location.origin);
      return u.origin === window.location.origin ? u.pathname + u.search : "";
    } catch {
      return "";
    }
  }

  function prefetchStageUrl(rawUrl) {
    const key = normalizeCacheKey(rawUrl);
    if (!key || key === window.location.pathname + window.location.search) return;
    const existing = stagePrefetchCache.get(key);
    if (existing && (existing.promise || existing.expiresAt > Date.now())) {
      return;
    }
    if (stagePrefetchCache.size >= 24) {
      const oldestKey = stagePrefetchCache.keys().next().value;
      if (oldestKey) stagePrefetchCache.delete(oldestKey);
    }
    const entry = {
      html: "",
      finalUrl: rawUrl,
      status: 200,
      expiresAt: 0,
      promise: null,
    };
    entry.promise = fetch(rawUrl, {
      method: "GET",
      credentials: "same-origin",
      redirect: "follow",
      headers: {
        "X-Stage-Nav": UI_ASSET_VERSION,
        "X-Stage-Prefetch": "1",
        Accept: "text/html, application/xhtml+xml",
      },
    })
      .then(async (res) => {
        const ct = res.headers.get("content-type") || "";
        let resOriginOk = true;
        try {
          resOriginOk = new URL(res.url || rawUrl, window.location.origin).origin === window.location.origin;
        } catch {
          resOriginOk = false;
        }
        if (!res.ok || !ct.includes("text/html") || !resOriginOk) {
          stagePrefetchCache.delete(key);
          return null;
        }
        const html = await res.text();
        entry.html = html;
        entry.finalUrl = res.url || rawUrl;
        entry.status = res.status;
        entry.expiresAt = Date.now() + STAGE_PREFETCH_TTL_MS;
        entry.promise = null;
        return entry;
      })
      .catch(() => {
        stagePrefetchCache.delete(key);
        return null;
      });
    stagePrefetchCache.set(key, entry);
  }

  async function navigateStage(targetUrl, options = {}) {
    const {
      pushState = true,
      preserveScroll = false,
      preserveInputs = false,
      method = "GET",
      body = undefined,
      bypassCache = false,
    } = options;

    if (method !== "GET" || bypassCache) {
      stagePrefetchCache.clear();
    }

    if (activeNavController) {
      activeNavController.abort();
    }
    const controller = new AbortController();
    activeNavController = controller;

    const progressBar = document.getElementById("stage-progress-bar");
    const progressTimer = setTimeout(() => {
      if (progressBar) {
        progressBar.classList.remove("is-done");
        progressBar.classList.add("is-loading");
      }
    }, 65);

    const targetParsed = new URL(targetUrl, window.location.origin);
    if (targetParsed.origin !== window.location.origin) {
      window.location.href = targetUrl;
      return;
    }
    const isRouteSwitch =
      method === "GET" &&
      !preserveScroll &&
      targetParsed.pathname !== window.location.pathname;

    let leavingTimer = null;
    const curStageEl = document.querySelector("[data-stage-container]");
    if (curStageEl && isRouteSwitch) {
      leavingTimer = setTimeout(() => {
        curStageEl.classList.remove("stage-initial", "stage-entering", "stage-refresh");
        curStageEl.classList.add("stage-leaving");
      }, 55);
    }

    try {
      let html = "";
      let finalUrl = targetUrl;
      let responseStatus = 200;

      const cacheKey = method === "GET" && !bypassCache ? normalizeCacheKey(targetUrl) : "";
      const cachedEntry = cacheKey ? stagePrefetchCache.get(cacheKey) : null;
      let usedCache = false;

      if (cachedEntry) {
        if (cachedEntry.html && cachedEntry.expiresAt > Date.now()) {
          html = cachedEntry.html;
          finalUrl = cachedEntry.finalUrl;
          responseStatus = cachedEntry.status;
          usedCache = true;
        } else if (cachedEntry.promise) {
          const resolved = await cachedEntry.promise;
          if (resolved && resolved.html) {
            html = resolved.html;
            finalUrl = resolved.finalUrl;
            responseStatus = resolved.status;
            usedCache = true;
          }
        }
      }

      if (!usedCache) {
        const response = await fetch(targetUrl, {
          method,
          body,
          credentials: "same-origin",
          redirect: "follow",
          headers: {
            "X-Stage-Nav": UI_ASSET_VERSION,
            Accept: "text/html, application/xhtml+xml, application/json;q=0.9, */*;q=0.8",
          },
          signal: controller.signal,
        });

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("text/html")) {
          if (method !== "GET" || !response.ok) {
            let errMsg = `请求失败 (HTTP ${response.status})`;
            try {
              const errJson = await response.json();
              if (errJson && typeof errJson.message === "string" && errJson.message) {
                errMsg = errJson.message;
              } else if (errJson && typeof errJson.error === "string" && errJson.error) {
                errMsg = errJson.error;
              }
            } catch {
              /* ignore */
            }
            showStageAlert("error", errMsg);
            return;
          }
          window.location.href = response.url || targetUrl;
          return;
        }

        finalUrl = response.url || targetUrl;
        responseStatus = response.status;
        html = await response.text();

        if (method === "GET" && response.ok && cacheKey) {
          stagePrefetchCache.set(cacheKey, {
            html,
            finalUrl,
            status: responseStatus,
            expiresAt: Date.now() + STAGE_PREFETCH_TTL_MS,
            promise: null,
          });
        }
      }

      const finalParsed = new URL(finalUrl, window.location.origin);
      if (finalParsed.origin !== window.location.origin) {
        window.location.href = finalUrl;
        return;
      }

      const parser = new DOMParser();
      const nextDoc = parser.parseFromString(html, "text/html");

      if (
        responseStatus >= 400 &&
        !nextDoc.querySelector("[data-stage-container]") &&
        !nextDoc.querySelector(".auth-shell")
      ) {
        const fallbackMsg =
          nextDoc.querySelector("p")?.textContent?.trim() ||
          nextDoc.querySelector("h1")?.textContent?.trim() ||
          `请求失败 (HTTP ${responseStatus})`;
        showStageAlert("error", fallbackMsg);
        return;
      }

      const nextPathname = finalParsed.pathname;
      const isInPlace = preserveScroll || nextPathname === window.location.pathname;

      applyDocumentUpdate(nextDoc, finalUrl, {
        pushState,
        preserveScroll,
        preserveInputs,
      });

      const stageEl = document.querySelector("[data-stage-container]");
      if (stageEl) {
        stageEl.classList.remove("stage-leaving", "stage-initial", "stage-entering", "stage-refresh");
        void stageEl.offsetWidth;
        stageEl.classList.add(isInPlace ? "stage-refresh" : "stage-entering");
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
      window.location.href = targetUrl;
    } finally {
      clearTimeout(progressTimer);
      if (leavingTimer) clearTimeout(leavingTimer);
      if (progressBar) {
        progressBar.classList.remove("is-loading");
        progressBar.classList.add("is-done");
      }
      const stageEl = document.querySelector("[data-stage-container]");
      if (stageEl) {
        stageEl.classList.remove("stage-leaving");
      }
    }
  }

  // Expose stage refresh helper for passkeys.js and other interactive modules
  window.xpRefreshStage = () => {
    stagePrefetchCache.clear();
    return navigateStage(window.location.href, {
      pushState: false,
      preserveScroll: true,
      bypassCache: true,
    });
  };

  function canInterceptLink(anchor, event) {
    if (!anchor || !(anchor instanceof HTMLAnchorElement)) return false;
    if (event.defaultPrevented || event.button !== 0) return false;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    if (anchor.hasAttribute("download") || anchor.getAttribute("target") === "_blank") return false;
    if (anchor.getAttribute("data-no-stage-nav") === "true") return false;

    const rawHref = anchor.getAttribute("href");
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) return false;

    let url;
    try {
      url = new URL(anchor.href, window.location.origin);
    } catch {
      return false;
    }

    if (url.origin !== window.location.origin) return false;
    if (url.pathname.endsWith(".csv") || url.pathname.startsWith("/lang/")) return false;
    if (url.pathname === "/console/logout" || url.pathname.startsWith("/auth/")) return false;

    const isConsoleOrPortal =
      url.pathname === "/console" ||
      url.pathname.startsWith("/console/") ||
      url.pathname === "/portal";
    if (!isConsoleOrPortal) return false;

    return Boolean(document.querySelector("[data-stage-container]"));
  }

  function canInterceptForm(form, submitter = null) {
    if (!(form instanceof HTMLFormElement)) return false;
    if (form.getAttribute("data-no-stage-nav") === "true") return false;
    if (form.classList.contains("passkey-form") || form.hasAttribute("data-passkey-register")) return false;
    if (form.getAttribute("target") === "_blank") return false;
    if (
      (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) &&
      (submitter.getAttribute("formtarget") === "_blank" ||
        submitter.getAttribute("data-no-stage-nav") === "true")
    ) {
      return false;
    }

    const rawAction =
      (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement
        ? submitter.getAttribute("formaction")
        : null) ||
      form.getAttribute("action") ||
      window.location.href;
    let url;
    try {
      url = new URL(rawAction, window.location.origin);
    } catch {
      return false;
    }
    if (url.origin !== window.location.origin) return false;
    if (
      url.pathname === "/console/logout" ||
      url.pathname === "/console/login" ||
      url.pathname === "/console/mfa" ||
      url.pathname.startsWith("/interaction/") ||
      url.pathname.startsWith("/auth/") ||
      url.pathname.endsWith(".csv")
    ) {
      return false;
    }

    return Boolean(document.querySelector("[data-stage-container]"));
  }

  window.addEventListener("popstate", () => {
    if (document.querySelector("[data-stage-container]")) {
      void navigateStage(window.location.href, { pushState: false, preserveScroll: false });
    }
  });

  // 3. Delegated Click Handlers
  document.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // Close open <details class="action-popover"> when clicking outside
    document.querySelectorAll("details.action-popover[open]").forEach((popover) => {
      if (!popover.contains(target)) {
        popover.removeAttribute("open");
      }
    });

    // Native <dialog class="glass-modal"> open trigger
    const modalOpenBtn = target.closest("[data-modal-open]");
    if (modalOpenBtn) {
      const modalId = modalOpenBtn.getAttribute("data-modal-open");
      const dialog = modalId ? document.getElementById(modalId) : null;
      if (dialog instanceof HTMLDialogElement) {
        dialog.showModal();
      }
      return;
    }

    // Native <dialog class="glass-modal"> close trigger or backdrop click
    const modalCloseBtn = target.closest("[data-modal-close]");
    if (modalCloseBtn) {
      const dialog = modalCloseBtn.closest("dialog");
      if (dialog instanceof HTMLDialogElement) {
        dialog.close();
      }
      return;
    }
    if (target instanceof HTMLDialogElement && event.target === target) {
      target.close();
      return;
    }

    // Dynamic Reset Password modal trigger
    const resetBtn = target.closest("[data-reset-action]");
    if (resetBtn) {
      const action = resetBtn.getAttribute("data-reset-action");
      const userLabel = resetBtn.getAttribute("data-reset-user") || "";
      const dialog = document.getElementById("modal-reset-password");
      if (dialog instanceof HTMLDialogElement && action) {
        const form = dialog.querySelector("form");
        const labelEl = dialog.querySelector("[data-reset-target-label]");
        const inputEl = dialog.querySelector('input[name="new_password"]');
        if (form instanceof HTMLFormElement) form.action = action;
        if (labelEl) labelEl.textContent = userLabel;
        if (inputEl instanceof HTMLInputElement) inputEl.value = "";
        dialog.showModal();
        if (inputEl instanceof HTMLInputElement) inputEl.focus();
      }
      return;
    }

    // Dynamic Send Email Notification modal trigger
    const notifyBtn = target.closest("[data-notify-action]");
    if (notifyBtn) {
      const action = notifyBtn.getAttribute("data-notify-action");
      const userLabel = notifyBtn.getAttribute("data-notify-user") || "";
      const emailLabel = notifyBtn.getAttribute("data-notify-email") || "";
      const dialog = document.getElementById("modal-notify-user");
      if (dialog instanceof HTMLDialogElement && action) {
        const form = dialog.querySelector("form");
        const labelEl = dialog.querySelector("[data-notify-target-label]");
        const emailEl = dialog.querySelector("[data-notify-target-email]");
        const subjEl = dialog.querySelector('input[name="subject"]');
        const msgEl = dialog.querySelector('textarea[name="message"]');
        if (form instanceof HTMLFormElement) form.action = action;
        if (labelEl) labelEl.textContent = userLabel;
        if (emailEl) emailEl.textContent = emailLabel ? `To: ${emailLabel}` : "";
        if (subjEl instanceof HTMLInputElement) subjEl.value = "";
        if (msgEl instanceof HTMLTextAreaElement) msgEl.value = "";
        dialog.showModal();
        if (subjEl instanceof HTMLInputElement) subjEl.focus();
      }
      return;
    }

    // Sidebar Collapse / Expand Toggle Button
    const sidebarToggleBtn = target.closest("[data-sidebar-toggle]");
    if (sidebarToggleBtn) {
      event.preventDefault();
      event.stopPropagation();
      const isCollapsed = root.getAttribute("data-sidebar-collapsed") === "true";
      setSidebarCollapsed(!isCollapsed);
      if (sidebarToggleBtn instanceof HTMLElement) {
        sidebarToggleBtn.blur();
      }
      return;
    }

    // Theme switcher (Zero Reload + OS Auto-Follow Aware)
    const themeBtn = target.closest("[data-theme-toggle]");
    if (themeBtn) {
      const current = root.getAttribute("data-theme") === "dark" ? "dark" : "light";
      const next = current === "dark" ? "light" : "dark";
      const osDark = darkQuery ? darkQuery.matches : false;
      const osTheme = osDark ? "dark" : "light";
      try {
        if (next === osTheme) {
          localStorage.removeItem("xp_theme");
        } else {
          localStorage.setItem("xp_theme", next);
        }
      } catch {
        /* ignore */
      }
      root.classList.add("theme-transitioning");
      root.setAttribute("data-theme", next);
      root.style.colorScheme = next;
      setTimeout(() => {
        root.classList.remove("theme-transitioning");
      }, 260);
      return;
    }

    // Seamless Language Switcher (Zero Reload, Preserves Session & Typed Form Inputs)
    const langBtn = target.closest('a[href^="/lang/"], [data-lang-switch]');
    if (langBtn instanceof HTMLAnchorElement) {
      event.preventDefault();
      try {
        stagePrefetchCache.clear();
        await fetch(langBtn.href, {
          method: "GET",
          credentials: "same-origin",
          headers: {
            "X-Requested-With": "fetch",
            Accept: "application/json",
          },
        });
        await navigateStage(window.location.href, {
          pushState: false,
          preserveScroll: true,
          preserveInputs: true,
          bypassCache: true,
        });
      } catch {
        window.location.href = langBtn.href;
      }
      return;
    }

    // Localized $i18n Editor Tab Switcher
    const i18nTabBtn = target.closest("[data-i18n-tab]");
    if (i18nTabBtn instanceof HTMLElement) {
      event.preventDefault();
      const editor = i18nTabBtn.closest("[data-i18n-editor]");
      if (editor instanceof HTMLElement) {
        flushLocalizedEditorTextarea(editor);
        const langCode = i18nTabBtn.getAttribute("data-i18n-tab") ?? "";
        const values = readEditorLocalizedValues(editor);
        editor.querySelectorAll("[data-i18n-tab]").forEach((btn) => {
          const isMatch = (btn.getAttribute("data-i18n-tab") ?? "") === langCode;
          btn.classList.toggle("active", isMatch);
          btn.setAttribute("aria-selected", isMatch ? "true" : "false");
        });
        const textarea = editor.querySelector("[data-i18n-textarea]");
        if (textarea instanceof HTMLTextAreaElement) {
          textarea.value = typeof values[langCode] === "string" ? values[langCode] : "";
        }
      }
      return;
    }

    // One-Click Google Translate for a single Localized Editor Field
    const translateFieldBtn = target.closest("[data-i18n-translate-field]");
    if (translateFieldBtn instanceof HTMLButtonElement) {
      event.preventDefault();
      const editor = translateFieldBtn.closest("[data-i18n-editor]");
      if (editor instanceof HTMLElement) {
        await runEditorGoogleTranslate(editor, translateFieldBtn);
      }
      return;
    }

    // One-Click Google Translate for ALL Localized Editor Fields on the page
    const translateAllBtn = target.closest("[data-i18n-translate-all]");
    if (translateAllBtn instanceof HTMLButtonElement) {
      event.preventDefault();
      const editors = Array.from(document.querySelectorAll("[data-i18n-editor]"));
      const origLabel = translateAllBtn.textContent;
      translateAllBtn.disabled = true;
      translateAllBtn.textContent = "🌐 正在翻译全部字段...";
      try {
        for (const ed of editors) {
          if (ed instanceof HTMLElement) {
            await runEditorGoogleTranslate(ed, null);
          }
        }
        const badge = document.getElementById("i18n-translate-status");
        if (badge) badge.textContent = "✓ 全部多语言已翻译";
      } finally {
        translateAllBtn.disabled = false;
        translateAllBtn.textContent = origLabel;
      }
      return;
    }

    // Smooth In-Page Tab Switcher
    const tabBtn = target.closest("[data-tab-target]");
    if (tabBtn) {
      const group = tabBtn.closest("[data-tabs]");
      const targetId = tabBtn.getAttribute("data-tab-target");
      if (group && targetId) {
        group.querySelectorAll("[data-tab-target]").forEach((btn) => btn.classList.remove("active"));
        group.querySelectorAll("[data-tab-pane]").forEach((pane) => {
          const isMatch = pane.getAttribute("data-tab-pane") === targetId;
          pane.classList.toggle("active", isMatch);
        });
        tabBtn.classList.add("active");
        try {
          history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${targetId}`);
        } catch {
          /* ignore */
        }
      }
      return;
    }

    // Weekly Payroll Sheet: One-Click Settle Row ([data-sheet-settle-row])
    const settleRowBtn = target.closest("[data-sheet-settle-row]");
    if (settleRowBtn instanceof HTMLElement) {
      event.preventDefault();
      const role = settleRowBtn.getAttribute("data-sheet-settle-row");
      const form = settleRowBtn.closest("[data-weekly-sheet-form]");
      if (role && form instanceof HTMLFormElement) {
        const decInput = form.querySelector(`input[name="declared_${role}"]`);
        const appInput = form.querySelector(`input[name="approved_${role}"]`);
        const divInput = form.querySelector(`input[name="dividend_${role}"]`);
        const paidInput = form.querySelector(`input[name="paid_${role}"]`);
        const decVal = decInput instanceof HTMLInputElement ? Number.parseFloat(decInput.value || "0") || 0 : 0;
        let appVal = appInput instanceof HTMLInputElement ? Number.parseFloat(appInput.value || "0") || 0 : 0;
        const divVal = divInput instanceof HTMLInputElement ? Number.parseFloat(divInput.value || "0") || 0 : 0;
        if (appVal <= 0 && decVal > 0 && appInput instanceof HTMLInputElement) {
          appVal = decVal;
          appInput.value = decVal.toFixed(2);
        }
        const dueVal = Math.max(0, appVal + divVal);
        if (paidInput instanceof HTMLInputElement) {
          paidInput.value = dueVal.toFixed(2);
        }
        recalculateWeeklyPayrollSheet(form, null);
      }
      return;
    }

    // Audit Event Stream: Expand / Collapse Overflow Rows ([data-audit-overflow-toggle])
    const auditOverflowBtn = target.closest("[data-audit-overflow-toggle]");
    if (auditOverflowBtn instanceof HTMLElement) {
      event.preventDefault();
      const panel = auditOverflowBtn.closest("[data-audit-stream-panel]") || document;
      const table = panel.querySelector("#audit-table");
      if (table instanceof HTMLElement) {
        const nextExpanded = table.getAttribute("data-audit-expanded") !== "true";
        table.setAttribute("data-audit-expanded", nextExpanded ? "true" : "false");
        table.querySelectorAll('tr[data-audit-overflow-row="1"]').forEach((tr) => {
          if (tr instanceof HTMLElement) {
            tr.hidden = !nextExpanded;
          }
        });
        panel.querySelectorAll("[data-audit-overflow-toggle]").forEach((btn) => {
          if (btn instanceof HTMLElement) {
            const label = nextExpanded
              ? btn.getAttribute("data-collapse-label")
              : btn.getAttribute("data-expand-label");
            if (label) btn.textContent = label;
          }
        });
        const statusEl = panel.querySelector("[data-audit-fold-status]");
        if (statusEl instanceof HTMLElement) {
          const hint = nextExpanded
            ? statusEl.getAttribute("data-expanded-hint")
            : statusEl.getAttribute("data-collapsed-hint");
          if (hint) statusEl.textContent = hint;
        }
      }
      return;
    }

    // Audit Event Stream: Collapse / Expand Entire Table Body ([data-audit-panel-toggle])
    const auditPanelBtn = target.closest("[data-audit-panel-toggle]");
    if (auditPanelBtn instanceof HTMLElement) {
      event.preventDefault();
      const panel = auditPanelBtn.closest("[data-audit-stream-panel]");
      const body = panel?.querySelector("[data-audit-stream-body]");
      if (body instanceof HTMLElement) {
        const nextHidden = !body.hidden;
        body.hidden = nextHidden;
        const label = nextHidden
          ? auditPanelBtn.getAttribute("data-expand-text")
          : auditPanelBtn.getAttribute("data-collapse-text");
        if (label) auditPanelBtn.textContent = label;
      }
      return;
    }

    // Email Templates: Open & Scroll to Specific Collapsible Preview Card ([data-open-mail-preview])
    const openPreviewBtn = target.closest("[data-open-mail-preview]");
    if (openPreviewBtn instanceof HTMLElement) {
      event.preventDefault();
      const tplKey = openPreviewBtn.getAttribute("data-open-mail-preview");
      if (tplKey) {
        const card = document.getElementById(`mail-preview-card-${tplKey}`);
        if (card instanceof HTMLDetailsElement) {
          card.open = true;
          card.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
      return;
    }

    // Email Templates: Expand / Collapse All Preview Cards
    const expandAllPreviewsBtn = target.closest("[data-mail-preview-expand-all]");
    if (expandAllPreviewsBtn instanceof HTMLElement) {
      event.preventDefault();
      document.querySelectorAll("details[data-mail-preview-details]").forEach((el) => {
        if (el instanceof HTMLDetailsElement) el.open = true;
      });
      return;
    }

    const collapseAllPreviewsBtn = target.closest("[data-mail-preview-collapse-all]");
    if (collapseAllPreviewsBtn instanceof HTMLElement) {
      event.preventDefault();
      document.querySelectorAll("details[data-mail-preview-details]").forEach((el) => {
        if (el instanceof HTMLDetailsElement) el.open = false;
      });
      return;
    }

    // Email Template Modal: Click Variable Chip to Insert at Cursor ([data-insert-mail-var])
    const insertVarBtn = target.closest("[data-insert-mail-var]");
    if (insertVarBtn instanceof HTMLElement) {
      event.preventDefault();
      const token = insertVarBtn.getAttribute("data-insert-mail-var") || "";
      const dialog = insertVarBtn.closest("[data-mail-tpl-dialog]");
      const htmlInput = dialog?.querySelector('[data-mail-input="html"]');
      if (token && htmlInput instanceof HTMLTextAreaElement) {
        const start = typeof htmlInput.selectionStart === "number" ? htmlInput.selectionStart : htmlInput.value.length;
        const end = typeof htmlInput.selectionEnd === "number" ? htmlInput.selectionEnd : htmlInput.value.length;
        htmlInput.value = htmlInput.value.slice(0, start) + token + htmlInput.value.slice(end);
        htmlInput.focus();
        htmlInput.selectionStart = htmlInput.selectionEnd = start + token.length;
        htmlInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }

    // Copy to clipboard (supports both literal strings and #id selectors)
    const copyBtn = target.closest("[data-copy]");
    if (copyBtn) {
      const rawValue = copyBtn.getAttribute("data-copy");
      if (!rawValue) return;
      let textToCopy = rawValue;
      if (rawValue.startsWith("#") && rawValue.length > 1) {
        const refEl = document.querySelector(rawValue);
        if (refEl) {
          textToCopy = (refEl.textContent || "").trim();
        }
      }
      try {
        await navigator.clipboard.writeText(textToCopy);
        const previous = copyBtn.textContent;
        const isZh = root.lang?.startsWith("zh");
        copyBtn.textContent = isZh ? "已复制 ✓" : "Copied ✓";
        setTimeout(() => {
          copyBtn.textContent = previous;
        }, 1400);
      } catch {
        /* clipboard unavailable */
      }
      return;
    }

    // Intercept internal console/portal link clicks for instant component update
    const anchor = target.closest("a[href]");
    if (anchor && canInterceptLink(anchor, event)) {
      event.preventDefault();
      // Optimistically highlight clicked sidebar/portal/tab/dock/filter nav item immediately
      if (anchor.classList.contains("nav-item")) {
        document.querySelectorAll(".sidebar-nav .nav-item").forEach((el) => el.classList.remove("active"));
        anchor.classList.add("active");
      } else if (anchor.classList.contains("portal-nav-pill")) {
        document.querySelectorAll(".portal-nav .portal-nav-pill").forEach((el) => el.classList.remove("active"));
        anchor.classList.add("active");
      } else if (anchor.classList.contains("mobile-dock-item")) {
        document.querySelectorAll(".mobile-dock .mobile-dock-item").forEach((el) => el.classList.remove("active"));
        anchor.classList.add("active");
      } else if (anchor.classList.contains("center-tab")) {
        anchor.closest(".center-tabs")?.querySelectorAll(".center-tab").forEach((el) => el.classList.remove("active"));
        anchor.classList.add("active");
      } else if (anchor.classList.contains("filter-pill")) {
        anchor.parentElement?.querySelectorAll(".filter-pill").forEach((el) => el.classList.remove("active"));
        anchor.classList.add("active");
      }
      const targetUrl = new URL(anchor.href, window.location.origin);
      const samePath = targetUrl.pathname === window.location.pathname;
      await navigateStage(anchor.href, {
        pushState: true,
        preserveScroll: samePath,
      });
    }
  });

  // Hover & Touch Prefetching for Instant Navigation
  let hoverPrefetchTimer = null;
  document.addEventListener(
    "pointerover",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!anchor || !(anchor instanceof HTMLAnchorElement)) return;
      if (!canInterceptLink(anchor, { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })) {
        return;
      }
      if (hoverPrefetchTimer) clearTimeout(hoverPrefetchTimer);
      hoverPrefetchTimer = setTimeout(() => {
        prefetchStageUrl(anchor.href);
      }, 30);
    },
    { passive: true },
  );

  document.addEventListener(
    "touchstart",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!anchor || !(anchor instanceof HTMLAnchorElement)) return;
      if (!canInterceptLink(anchor, { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })) {
        return;
      }
      prefetchStageUrl(anchor.href);
    },
    { passive: true },
  );

  function readEditorLocalizedValues(editor) {
    if (!(editor instanceof HTMLElement)) return {};
    const cachedAttr = editor.getAttribute("data-i18n-values");
    if (cachedAttr) {
      try {
        return JSON.parse(cachedAttr) || {};
      } catch {
        /* fall through */
      }
    }
    const hiddenInput = editor.querySelector("[data-i18n-hidden]");
    const raw = hiddenInput instanceof HTMLInputElement ? hiddenInput.value : "";
    let parsed = {};
    if (raw && raw.trim().startsWith("{")) {
      try {
        const obj = JSON.parse(raw);
        if (obj && obj.$i18n === 1 && obj.values && typeof obj.values === "object") {
          parsed = { ...obj.values };
        } else {
          parsed = { "": raw };
        }
      } catch {
        parsed = { "": raw };
      }
    } else {
      parsed = raw ? { "": raw } : {};
    }
    editor.setAttribute("data-i18n-values", JSON.stringify(parsed));
    return parsed;
  }

  function serializeLocalizedValues(values) {
    const cleaned = {};
    for (const [k, v] of Object.entries(values || {})) {
      if (typeof v === "string" && v.trim().length > 0) {
        cleaned[k] = v;
      }
    }
    const keys = Object.keys(cleaned);
    if (keys.length === 0) return "";
    if (keys.length === 1 && keys[0] === "") {
      return cleaned[""] || "";
    }
    return JSON.stringify({
      $i18n: 1,
      values: cleaned,
    });
  }

  function syncLocalizedEditorValue(editor, nextValues) {
    editor.setAttribute("data-i18n-values", JSON.stringify(nextValues));
    const hiddenInput = editor.querySelector("[data-i18n-hidden]");
    if (hiddenInput instanceof HTMLInputElement) {
      hiddenInput.value = serializeLocalizedValues(nextValues);
    }
    editor.querySelectorAll("[data-i18n-dot]").forEach((dot) => {
      const code = dot.getAttribute("data-i18n-dot") ?? "";
      const hasVal = typeof nextValues[code] === "string" && nextValues[code].trim().length > 0;
      dot.classList.toggle("visible", hasVal);
    });
  }

  function flushLocalizedEditorTextarea(editor) {
    if (!(editor instanceof HTMLElement)) return;
    const textarea = editor.querySelector("[data-i18n-textarea]");
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    const activeTab = editor.querySelector("[data-i18n-tab].active");
    const activeLangCode = activeTab ? activeTab.getAttribute("data-i18n-tab") ?? "" : "";
    const values = readEditorLocalizedValues(editor);
    const prevVal = typeof values[activeLangCode] === "string" ? values[activeLangCode] : "";
    const nextVal = textarea.value;
    if (activeLangCode === "") {
      if (nextVal !== prevVal) {
        for (const [k, v] of Object.entries(values)) {
          if (k !== "" && v === prevVal) {
            values[k] = nextVal;
          }
        }
        const uiLang = root.getAttribute("lang") || "zh-CN";
        if (typeof values[uiLang] === "string") {
          values[uiLang] = nextVal;
        }
        if (uiLang.startsWith("zh") && typeof values["zh-CN"] === "string") {
          values["zh-CN"] = nextVal;
        }
      }
      values[""] = nextVal;
    } else {
      if (!values[""] || values[""] === prevVal) {
        values[""] = nextVal;
      }
      values[activeLangCode] = nextVal;
    }
    syncLocalizedEditorValue(editor, values);
  }

  async function runEditorGoogleTranslate(editor, triggerBtn) {
    const form = editor.closest("[data-i18n-settings-form]") || document.querySelector("[data-i18n-settings-form]");
    const endpoint =
      form?.getAttribute("data-translate-endpoint") ||
      document.querySelector("[data-translate-endpoint]")?.getAttribute("data-translate-endpoint");
    const csrf =
      form?.getAttribute("data-csrf") ||
      document.querySelector('input[name="_csrf"]')?.value ||
      "";
    if (!endpoint) return;
    try {
      const epUrl = new URL(endpoint, window.location.origin);
      if (epUrl.origin !== window.location.origin) return;
    } catch {
      return;
    }

    flushLocalizedEditorTextarea(editor);

    const textarea = editor.querySelector("[data-i18n-textarea]");
    const activeTab = editor.querySelector("[data-i18n-tab].active");
    const activeLangCode = activeTab ? activeTab.getAttribute("data-i18n-tab") ?? "" : "";
    const values = readEditorLocalizedValues(editor);

    const sourceText =
      (typeof values[activeLangCode] === "string" && values[activeLangCode].trim()) ||
      (typeof values[""] === "string" && values[""].trim()) ||
      (typeof values["zh-CN"] === "string" && values["zh-CN"].trim()) ||
      (typeof values["en"] === "string" && values["en"].trim()) ||
      "";

    if (!sourceText) {
      return;
    }

    const origLabel = triggerBtn ? triggerBtn.textContent : "";
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.textContent = "🌐 翻译中...";
    }
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          _csrf: csrf,
          text: sourceText,
          source_lang: activeLangCode || "auto",
        }),
      });
      if (!res.ok) {
        let errText = `翻译请求失败 (HTTP ${res.status})`;
        try {
          const errJson = await res.json();
          if (errJson?.message) errText = errJson.message;
        } catch {
          /* ignore */
        }
        showStageAlert("error", errText);
        return;
      }
      const data = await res.json();
      const translations = data?.translations || data?.data?.translations;
      if (translations && typeof translations === "object") {
        values[""] = sourceText;
        for (const [langKey, translatedText] of Object.entries(translations)) {
          if (typeof translatedText === "string" && translatedText.trim()) {
            values[langKey] = translatedText;
          }
        }
        syncLocalizedEditorValue(editor, values);
        if (textarea instanceof HTMLTextAreaElement && typeof values[activeLangCode] === "string") {
          textarea.value = values[activeLangCode];
        }
        if (triggerBtn) {
          triggerBtn.textContent = "✓ 已完成多语言翻译";
          setTimeout(() => {
            triggerBtn.textContent = origLabel;
          }, 1800);
        }
      }
    } catch {
      if (triggerBtn) {
        triggerBtn.textContent = origLabel;
      }
    } finally {
      if (triggerBtn) {
        triggerBtn.disabled = false;
      }
    }
  }

  function formatCnyClient(minor) {
    const val = (Number(minor || 0) / 100).toFixed(2);
    const parts = val.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `¥${parts.join(".")}`;
  }

  function recalculateWeeklyPayrollSheet(form, changedInput) {
    if (!(form instanceof HTMLFormElement)) return;
    const autoApproveBox = form.querySelector("[data-sheet-auto-approve]");
    const autoApprove = !(autoApproveBox instanceof HTMLInputElement) || autoApproveBox.checked;

    if (
      changedInput instanceof HTMLInputElement &&
      changedInput.getAttribute("data-sheet-input") === "declared" &&
      autoApprove
    ) {
      const role = changedInput.getAttribute("data-role");
      if (role) {
        const appInput = form.querySelector(`input[name="approved_${role}"]`);
        if (appInput instanceof HTMLInputElement) {
          const decNum = Math.max(0, Number.parseFloat(changedInput.value || "0") || 0);
          appInput.value = decNum.toFixed(2);
        }
      }
    }

    let totalDeclared = 0;
    let totalApproved = 0;
    let totalDividend = 0;
    let totalDue = 0;
    let totalPaid = 0;
    let totalRemaining = 0;

    form.querySelectorAll("tr[data-sheet-row]").forEach((tr) => {
      const role = tr.getAttribute("data-sheet-row");
      if (!role) return;
      const toMinor = (name) => {
        const el = form.querySelector(`input[name="${name}_${role}"]`);
        const num = el instanceof HTMLInputElement ? Number.parseFloat(el.value || "0") : 0;
        return Number.isFinite(num) ? Math.max(0, Math.round(num * 100)) : 0;
      };
      const declaredMinor = toMinor("declared");
      const approvedMinor = toMinor("approved");
      const dividendMinor = toMinor("dividend");
      const paidMinor = toMinor("paid");
      const dueMinor = approvedMinor + dividendMinor;
      const remainingMinor = Math.max(0, dueMinor - paidMinor);

      totalDeclared += declaredMinor;
      totalApproved += approvedMinor;
      totalDividend += dividendMinor;
      totalDue += dueMinor;
      totalPaid += paidMinor;
      totalRemaining += remainingMinor;

      const dueEl = tr.querySelector(`[data-sheet-due="${role}"]`);
      if (dueEl) dueEl.textContent = formatCnyClient(dueMinor);

      const remEl = tr.querySelector(`[data-sheet-remaining="${role}"]`);
      if (remEl) remEl.textContent = formatCnyClient(remainingMinor);

      const statusEl = tr.querySelector(`[data-sheet-status="${role}"]`);
      if (statusEl instanceof HTMLElement) {
        statusEl.className = "badge";
        if (dueMinor === 0 && declaredMinor === 0 && paidMinor === 0) {
          statusEl.textContent = "待申报";
        } else if (declaredMinor > 0 && approvedMinor === 0 && dueMinor === 0) {
          statusEl.textContent = "待审申报";
          statusEl.classList.add("badge-info");
        } else if (remainingMinor === 0 && dueMinor > 0) {
          statusEl.textContent = "已结清";
          statusEl.classList.add("badge-ok");
        } else if (paidMinor > 0 && remainingMinor > 0) {
          statusEl.textContent = "部分已打款";
          statusEl.classList.add("badge-warn");
        } else {
          statusEl.textContent = "待打款";
          statusEl.classList.add("badge-warn");
        }
      }
    });

    const setFooter = (key, minor) => {
      const el = form.querySelector(`[data-sheet-total="${key}"]`);
      if (el) el.textContent = formatCnyClient(minor);
    };
    setFooter("declared", totalDeclared);
    setFooter("approved", totalApproved);
    setFooter("dividend", totalDividend);
    setFooter("due", totalDue);
    setFooter("paid", totalPaid);
    setFooter("remaining", totalRemaining);
  }

  function updateDeclareExpensePreview(form) {
    if (!(form instanceof HTMLElement)) return;
    const amtInput = form.querySelector("[data-declare-amount]");
    const curSelect = form.querySelector("[data-declare-currency]");
    const previewInput = form.querySelector("[data-declare-cny-preview]");
    if (!(amtInput instanceof HTMLInputElement) || !(previewInput instanceof HTMLInputElement)) return;
    const amt = Math.max(0, Number.parseFloat(amtInput.value || "0") || 0);
    const cur = curSelect instanceof HTMLSelectElement ? curSelect.value : "CNY";
    const rate = cur === "GBP" ? 8.916 : cur === "USD" ? 7.125 : 1;
    const cnyMinor = Math.round(amt * rate * 100);
    previewInput.value =
      cur === "CNY"
        ? formatCnyClient(cnyMinor)
        : `${formatCnyClient(cnyMinor)} (按 1 ${cur} ≈ ¥${rate.toFixed(4)} 折算)`;
  }

  function syncActiveTabFromHash() {
    const hash = (window.location.hash || "").replace(/^#/, "");
    if (!hash.startsWith("tab-")) return;
    const tabBtn = document.querySelector(`[data-tab-target="${escapeCssAttr(hash)}"]`);
    if (tabBtn instanceof HTMLElement) {
      const group = tabBtn.closest("[data-tabs]");
      if (group) {
        group.querySelectorAll("[data-tab-target]").forEach((btn) => btn.classList.remove("active"));
        group.querySelectorAll("[data-tab-pane]").forEach((pane) => {
          pane.classList.toggle("active", pane.getAttribute("data-tab-pane") === hash);
        });
        tabBtn.classList.add("active");
      }
    }
  }
  syncActiveTabFromHash();
  window.addEventListener("hashchange", syncActiveTabFromHash);

  // 4. Auto-submit on select[data-auto-submit] & Multi-Language Select Switcher ([data-lang-select])
  document.addEventListener("change", async (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement)) return;
    if (select.hasAttribute("data-lang-select")) {
      const chosenLang = select.value;
      if (!chosenLang) return;
      try {
        await fetch(`/lang/${encodeURIComponent(chosenLang)}`, {
          method: "GET",
          credentials: "same-origin",
          headers: {
            "X-Requested-With": "fetch",
            Accept: "application/json",
          },
        });
        await navigateStage(window.location.href, {
          pushState: false,
          preserveScroll: true,
          preserveInputs: true,
        });
      } catch {
        window.location.href = `/lang/${encodeURIComponent(chosenLang)}`;
      }
      return;
    }
    if (select.hasAttribute("data-declare-currency")) {
      const form = select.closest("[data-declare-expense-form]");
      if (form instanceof HTMLElement) {
        updateDeclareExpensePreview(form);
      }
      return;
    }
    if (select.hasAttribute("data-auto-submit")) {
      select.form?.requestSubmit();
    }
  });

  // 5. Real-time client-side table/card search filter ([data-filter-target] & [data-table-search])
  document.addEventListener("input", (event) => {
    const input = event.target;

    // 4.9 Weekly Payroll Sheet Inline Auto-Calculation ([data-sheet-input])
    if (input instanceof HTMLInputElement && input.hasAttribute("data-sheet-input")) {
      const form = input.closest("[data-weekly-sheet-form]");
      if (form instanceof HTMLFormElement) {
        recalculateWeeklyPayrollSheet(form, input);
      }
      return;
    }

    // 4.9b Declare Expense Modal Multi-Currency Preview ([data-declare-amount])
    if (input instanceof HTMLInputElement && input.hasAttribute("data-declare-amount")) {
      const form = input.closest("[data-declare-expense-form]");
      if (form instanceof HTMLElement) {
        updateDeclareExpensePreview(form);
      }
      return;
    }

    // 5.0 Localized $i18n Editor Textarea Sync
    if (input instanceof HTMLTextAreaElement && input.hasAttribute("data-i18n-textarea")) {
      const editor = input.closest("[data-i18n-editor]");
      if (editor instanceof HTMLElement) {
        flushLocalizedEditorTextarea(editor);
      }
      return;
    }

    // 5a. Live Email Template Preview Updater ([data-mail-input] inside [data-mail-tpl-dialog])
    if (
      (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) &&
      input.hasAttribute("data-mail-input")
    ) {
      const dialog = input.closest("[data-mail-tpl-dialog]");
      if (dialog instanceof HTMLElement) {
        let sampleVars = {};
        try {
          sampleVars = JSON.parse(dialog.getAttribute("data-sample-vars") || "{}");
        } catch {
          sampleVars = {};
        }
        const escapeHtml = (s) =>
          String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        const interpolate = (tplStr, esc) =>
          String(tplStr || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => {
            const raw = sampleVars[k] ?? "";
            return esc ? escapeHtml(raw) : String(raw);
          });

        const wrapClientEnvelope = (innerHtml) => {
          const raw = String(innerHtml || "").trim();
          if (!raw || raw.includes('data-xpeach-email-envelope="1"') || /<!doctype html/i.test(raw)) {
            return raw;
          }
          const badge = escapeHtml(dialog.getAttribute("data-scene-badge") || "官方通知");
          const accent = escapeHtml(dialog.getAttribute("data-scene-accent") || "#EA580C");
          const accentSoft = escapeHtml(dialog.getAttribute("data-scene-accent-soft") || "#FFF7ED");
          const accentBorder = escapeHtml(dialog.getAttribute("data-scene-accent-border") || "#FED7AA");
          return `<div data-xpeach-email-envelope="1" style="background-color:#FAF7F5;padding:32px 14px;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','PingFang SC','Helvetica Neue',sans-serif;color:#1C1917;">
  <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border-radius:20px;border:1px solid #F3E8E2;box-shadow:0 10px 28px rgba(234,88,12,0.06);overflow:hidden;text-align:center;">
    <div style="height:4px;background:linear-gradient(90deg,#FF6B35 0%,#F97316 50%,#FB923C 100%);"></div>
    <div style="padding:32px 32px 26px;">
      <div style="margin-bottom:14px;">
        <img src="https://sso.xpeach.codes/static/xpeach-logo.png" alt="XPeach" width="50" height="50" style="width:50px;height:50px;border-radius:14px;border:1px solid #FED7AA;padding:4px;background:#FFFFFF;box-shadow:0 4px 12px rgba(234,88,12,0.10);display:inline-block;" />
      </div>
      <div style="margin-bottom:14px;">
        <span style="display:inline-block;padding:4px 12px;border-radius:999px;background:${accentSoft};border:1px solid ${accentBorder};color:${accent};font-size:12px;font-weight:600;">XPEACH · ${badge}</span>
      </div>
      <div style="color:#1C1917;font-size:14.5px;line-height:1.68;text-align:left;">
        ${raw}
      </div>
    </div>
    <div style="padding:18px 32px 22px;background:#FDFBF9;border-top:1px solid #F3ECE7;color:#78716C;font-size:12px;line-height:1.6;text-align:center;">
      <div style="margin-bottom:8px;color:#57534E;">
        此邮件由 XPEACH 统一通行证系统自动发送，请勿向任何人透露验证码或密码。
      </div>
      <div style="margin-bottom:4px;">
        <a href="https://sso.xpeach.codes" style="color:#EA580C;text-decoration:none;font-weight:600;">XPEACH 统一通行证</a>
        <span style="color:#D6D3D1;margin:0 6px;">·</span>
        <a href="https://sso.xpeach.codes/user-agreement" style="color:#78716C;text-decoration:none;">用户协议</a>
        <span style="color:#D6D3D1;margin:0 6px;">·</span>
        <a href="https://sso.xpeach.codes/privacy-policy" style="color:#78716C;text-decoration:none;">隐私政策</a>
      </div>
      <div style="color:#A8A29E;font-size:11.5px;">© 2026 XPEACH (xpeach.codes) · sso.xpeach.codes</div>
    </div>
  </div>
</div>`;
        };

        const subjInput = dialog.querySelector('[data-mail-input="subject"]');
        const htmlInput = dialog.querySelector('[data-mail-input="html"]');
        const textInput = dialog.querySelector('[data-mail-input="text"]');

        const liveSubj = dialog.querySelector("[data-mail-live-subject]");
        const liveIframe = dialog.querySelector("[data-mail-live-iframe]");
        const liveText = dialog.querySelector("[data-mail-live-text]");

        if (liveSubj && subjInput instanceof HTMLInputElement) {
          liveSubj.textContent = interpolate(subjInput.value, false);
        }
        if (liveIframe instanceof HTMLIFrameElement && htmlInput instanceof HTMLTextAreaElement) {
          const renderedHtml = wrapClientEnvelope(interpolate(htmlInput.value, true));
          liveIframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#FAF7F5;color:#1C1917;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;}body{padding:8px;box-sizing:border-box;}a{pointer-events:none;}</style></head><body>${renderedHtml}</body></html>`;
        }
        if (liveText && textInput instanceof HTMLTextAreaElement) {
          liveText.textContent = interpolate(textInput.value, false);
        }
      }
      return;
    }

    if (!(input instanceof HTMLInputElement)) return;
    const selector = input.getAttribute("data-filter-target") || input.getAttribute("data-table-search");
    if (!selector) return;
    const query = input.value.trim().toLowerCase();
    const targetContainer = selector.startsWith("#") || selector.startsWith(".") ? document.querySelector(selector) : null;
    const isAuditTable = selector === "#audit-table" && targetContainer instanceof HTMLElement;
    const auditExpanded = isAuditTable && targetContainer.getAttribute("data-audit-expanded") === "true";
    const foldBar = isAuditTable ? document.querySelector("[data-audit-fold-bar]") : null;
    if (foldBar instanceof HTMLElement) {
      foldBar.hidden = query.length > 0;
    }

    let targets;
    if (input.hasAttribute("data-table-search") && !selector.startsWith("#") && !selector.startsWith(".")) {
      const panel = input.closest(".panel") || document;
      targets = panel.querySelectorAll("table tbody tr");
    } else {
      const rowItems = document.querySelectorAll(`${selector} tbody tr, ${selector} [data-filter-item]`);
      targets = rowItems.length > 0 ? rowItems : document.querySelectorAll(selector);
    }
    targets.forEach((item) => {
      const text = (item.textContent || "").toLowerCase();
      if (item instanceof HTMLElement) {
        if (query.length > 0) {
          item.hidden = !text.includes(query);
        } else if (isAuditTable && item.getAttribute("data-audit-overflow-row") === "1") {
          item.hidden = !auditExpanded;
        } else {
          item.hidden = false;
        }
      }
    });
  });

  // 6. Confirmation dialog & Componentized Form Submission (GET & POST without Full Page Reload)
  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    const message = form.getAttribute("data-confirm");
    if (message && !window.confirm(message)) {
      event.preventDefault();
      return;
    }

    const submitter = event.submitter;
    if (event.defaultPrevented || !canInterceptForm(form, submitter)) {
      return;
    }
    const method = (
      (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement
        ? submitter.getAttribute("formmethod")
        : null) ||
      form.getAttribute("method") ||
      "GET"
    ).toUpperCase();

    const rawAction =
      (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement
        ? submitter.getAttribute("formaction")
        : null) ||
      form.getAttribute("action") ||
      window.location.href;

    const actionUrl = new URL(rawAction, window.location.origin);
    form.querySelectorAll("[data-i18n-editor]").forEach((editor) => {
      if (editor instanceof HTMLElement) {
        flushLocalizedEditorTextarea(editor);
      }
    });
    const formData = new FormData(form);
    if (
      (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) &&
      submitter.name
    ) {
      formData.append(submitter.name, submitter.value);
    }

    event.preventDefault();

    if (method === "GET") {
      const params = new URLSearchParams();
      for (const [k, v] of formData.entries()) {
        if (typeof v === "string") {
          params.append(k, v);
        }
      }
      actionUrl.search = params.toString();
      const samePath = actionUrl.pathname === window.location.pathname;
      await navigateStage(actionUrl.href, {
        pushState: true,
        preserveScroll: samePath,
      });
    } else {
      const bodyParams = new URLSearchParams();
      for (const [k, v] of formData.entries()) {
        if (typeof v === "string") {
          bodyParams.append(k, v);
        }
      }
      await navigateStage(actionUrl.href, {
        pushState: true,
        preserveScroll: true,
        method: "POST",
        body: bodyParams,
      });
    }
  });

  // 7. Interactive Drag-to-Resize & Double-Click Collapse Sidebar Engine
  let isResizingSidebar = false;

  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const resizer = target.closest("[data-sidebar-resizer]");
    if (!resizer || event.button !== 0) return;

    event.preventDefault();
    isResizingSidebar = true;
    root.classList.add("is-resizing-sidebar");
    try {
      resizer.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  });

  document.addEventListener("pointermove", (event) => {
    if (!isResizingSidebar) return;
    const sidebar = document.querySelector(".sidebar");
    const leftOffset = sidebar ? sidebar.getBoundingClientRect().left : 13.6;
    const rawWidth = Math.round(event.clientX - leftOffset);

    if (rawWidth < 125) {
      if (root.getAttribute("data-sidebar-collapsed") !== "true") {
        setSidebarCollapsed(true);
      }
      return;
    }

    if (root.getAttribute("data-sidebar-collapsed") === "true" && rawWidth >= 140) {
      setSidebarCollapsed(false);
    }

    if (root.getAttribute("data-sidebar-collapsed") !== "true") {
      const clamped = Math.max(180, Math.min(380, rawWidth));
      root.style.setProperty("--sidebar-width", `${clamped}px`);
      try {
        localStorage.setItem("xp_sidebar_width", `${clamped}px`);
      } catch {
        /* ignore */
      }
    }
  });

  const stopSidebarResize = () => {
    if (!isResizingSidebar) return;
    isResizingSidebar = false;
    root.classList.remove("is-resizing-sidebar");
  };

  document.addEventListener("pointerup", stopSidebarResize);
  document.addEventListener("pointercancel", stopSidebarResize);

  document.addEventListener("dblclick", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const resizer = target.closest("[data-sidebar-resizer]");
    if (!resizer) return;
    const isCollapsed = root.getAttribute("data-sidebar-collapsed") === "true";
    setSidebarCollapsed(!isCollapsed);
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
      if (document.querySelector(".sidebar")) {
        event.preventDefault();
        const isCollapsed = root.getAttribute("data-sidebar-collapsed") === "true";
        setSidebarCollapsed(!isCollapsed);
      }
    }
  });

  // 8. Lightweight rAF-Throttled Liquid Glass Specular Reflection (Desktop Hover Only)
  if (window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    let rafId = 0;
    document.addEventListener(
      "pointermove",
      (event) => {
        if (rafId) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const card = target.closest(".stat, .app-card, .auth-window");
        if (!(card instanceof HTMLElement)) return;
        const clientX = event.clientX;
        const clientY = event.clientY;
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          const rect = card.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;
          const xPct = Math.round(((clientX - rect.left) / rect.width) * 100);
          const yPct = Math.round(((clientY - rect.top) / rect.height) * 100);
          card.style.setProperty("--glass-spot-x", `${xPct}%`);
          card.style.setProperty("--glass-spot-y", `${yPct}%`);
        });
      },
      { passive: true },
    );
  }
})();
