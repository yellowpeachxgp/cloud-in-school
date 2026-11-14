import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {
  REPO_ROOT,
  ContractError,
  DEFAULT_RESERVATION_PRICE_MICROPEACH,
  DEFAULT_SCHOOL_ID,
  MICROPEACH_PER_PEACH,
  generateRequestId,
  okEnvelope,
  errorEnvelope,
  loadOpenApiText,
  redactSensitiveFields
} from "../../../packages/contracts/src/index.mjs";
import { CloudDatabaseStore } from "../../../packages/db/src/index.mjs";
import { KmsEnvelopeVault } from "../../../packages/crypto/src/index.mjs";
import { CloudIdentityService } from "../../../packages/identity/src/index.mjs";
import {
  HautLibraryProvider,
  ScopedSchoolCookieVault
} from "../../../packages/school-spi/src/index.mjs";
import {
  TripleScheduleEngine,
  addDaysToLocalDate
} from "../../../packages/reservations/src/index.mjs";
import {
  IsolatedFinanceBridge,
  FinanceSagaService
} from "../../../packages/finance/src/index.mjs";
import { ParcelHubService } from "../../../packages/parcel-hub/src/index.mjs";
import {
  PluginRegistryAndBroker,
  loadPluginDirectory
} from "../../../packages/plugin-sdk/src/index.mjs";
import { greetCampus } from "../../../examples/hello-campus-plugin/dist/index.mjs";
import { queryStationHours } from "../../../examples/parcel-station-plugin/dist/index.mjs";
import {
  renderConsoleHtml,
  renderMobileCallbackHtml,
  CONSOLE_UI_VERSION
} from "../../console/src/main.mjs";
import { RedisGatewayBuffer } from "../../../packages/redis-buffer/src/index.mjs";

function compileRoutePattern(pathTemplate) {
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

export function createCampusCloudApp(options = {}) {
  const store = options.store || new CloudDatabaseStore(options.storeOptions);
  const kmsVault =
    options.kmsVault ||
    new KmsEnvelopeVault({
      onAudit: (ev) => store.recordAudit(ev),
      ...options.kmsOptions
    });
  const identity =
    options.identity ||
    new CloudIdentityService(store, {
      requireAdminAccess: options.requireAdminAccess,
      ...options.identityOptions
    });
  const trustProxyHeaders =
    options.trustProxyHeaders !== undefined
      ? Boolean(options.trustProxyHeaders)
      : process.env.TRUST_PROXY_HEADERS === "true";
  const allowSandboxProviders =
    options.allowSandboxProviders !== undefined
      ? Boolean(options.allowSandboxProviders)
      : process.env.PARCEL_ALLOW_SANDBOX_PROVIDERS === "true";
  const cookieVault = options.cookieVault || new ScopedSchoolCookieVault();
  const schoolProvider =
    options.schoolProvider || new HautLibraryProvider(options.schoolProviderOptions);
  const financeBridge =
    options.financeBridge || new IsolatedFinanceBridge(options.financeBridgeOptions);
  const financeService = options.financeService || new FinanceSagaService(store, financeBridge);
  const reservationEngine =
    options.reservationEngine ||
    new TripleScheduleEngine(store, schoolProvider, financeService, kmsVault);
  const parcelHub =
    options.parcelHub ||
    new ParcelHubService(store, kmsVault, {
      environment: options.environment || process.env.NODE_ENV || "production"
    });
  const pluginBroker = options.pluginBroker || new PluginRegistryAndBroker();
  const redisBuffer =
    options.redisBuffer ||
    new RedisGatewayBuffer({
      enabled:
        options.redisEnabled !== undefined
          ? Boolean(options.redisEnabled)
          : Boolean(process.env.REDIS_URL || process.env.REDIS_HOST || process.env.REDIS_PASSWORD),
      ...options.redisOptions
    });

  if (redisBuffer.client.enabled) {
    redisBuffer.auditAndTuneServerConfig({ applyTuning: true }).catch(() => {});
  }

  // Pre-register the two signed reference plugins
  try {
    const helloDir = path.join(REPO_ROOT, "examples/hello-campus-plugin");
    const helloPub = fs.readFileSync(path.join(helloDir, "plugin-signing-public.key"), "utf8").trim();
    const helloLoaded = loadPluginDirectory(helloDir);
    pluginBroker.registerPluginPackage({
      manifest: helloLoaded.manifest,
      artifactMap: helloLoaded.artifactMap,
      publicKeyBase64: helloPub,
      commandHandlers: { greetCampus }
    });

    const parcelDir = path.join(REPO_ROOT, "examples/parcel-station-plugin");
    const parcelPub = fs
      .readFileSync(path.join(parcelDir, "plugin-signing-public.key"), "utf8")
      .trim();
    const parcelLoaded = loadPluginDirectory(parcelDir);
    pluginBroker.registerPluginPackage({
      manifest: parcelLoaded.manifest,
      artifactMap: parcelLoaded.artifactMap,
      publicKeyBase64: parcelPub,
      commandHandlers: { queryStationHours }
    });
  } catch {
    // Allow tests to initialize even if example dirs are overridden
  }

  const routes = [];
  const extensionRoutes = [];
  function register(method, pathTemplate, operationId, auth, handler) {
    const { regex, paramNames } = compileRoutePattern(pathTemplate);
    routes.push({
      method: method.toUpperCase(),
      path: pathTemplate,
      operationId,
      auth,
      regex,
      paramNames,
      handler
    });
  }

  function registerExtension(method, pathTemplate, operationId, auth, handler) {
    const { regex, paramNames } = compileRoutePattern(pathTemplate);
    extensionRoutes.push({
      method: method.toUpperCase(),
      path: pathTemplate,
      operationId,
      auth,
      regex,
      paramNames,
      handler
    });
  }

  const SECURITY_HEADERS = {
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer"
  };

  function isAdminOrOperatorAuth(auth) {
    if (!auth) return false;
    const roles = Array.isArray(auth.roles) ? auth.roles : [];
    const user = store.users.get(auth.cloudUserId);
    return (
      roles.includes("ADMIN") ||
      roles.includes("OPERATOR") ||
      roles.includes("PLATFORM_OWNER") ||
      roles.includes("OPERATIONS_ADMIN") ||
      roles.includes("SCHOOL_OPERATOR") ||
      roles.includes("FINANCE") ||
      roles.includes("FINANCE_OPERATOR") ||
      user?.role === "admin"
    );
  }

  function extractBearer(headers, nowMs, method = "GET") {
    const authHeader = headers?.authorization || headers?.Authorization || "";
    const m = String(authHeader).match(/^Bearer\s+(.+)$/i);
    let bearerErr = null;
    if (m) {
      try {
        const verified = identity.verifyAccessToken(m[1].trim(), nowMs);
        const u = store.users.get(verified.cloudUserId);
        if (!u || u.status !== "ACTIVE") {
          throw new ContractError("CLOUD_AUTH_REQUIRED", "Cloud user account is inactive or deleted");
        }
        return verified;
      } catch (err) {
        bearerErr = err;
      }
    }
    const cookieAuth = identity.verifyWebSessionCookie(
      headers?.cookie || headers?.Cookie || "",
      nowMs
    );
    if (cookieAuth) {
      const u = store.users.get(cookieAuth.cloudUserId);
      if (!u || u.status !== "ACTIVE") {
        throw new ContractError("CLOUD_AUTH_REQUIRED", "Cloud user account is inactive or deleted");
      }
      const upper = String(method || "GET").toUpperCase();
      if (upper === "POST" || upper === "PUT" || upper === "PATCH" || upper === "DELETE") {
        const secFetchSite = String(
          headers?.["sec-fetch-site"] || headers?.["Sec-Fetch-Site"] || ""
        ).toLowerCase();
        if (secFetchSite === "cross-site") {
          throw new ContractError(
            "FORBIDDEN",
            "Cross-site state-changing cookie request rejected"
          );
        }
        const originHeader = String(headers?.origin || headers?.Origin || "").trim();
        const hostHeader = String(headers?.host || headers?.Host || "").trim();
        if (originHeader && hostHeader) {
          try {
            const parsedOrigin = new URL(originHeader);
            if (parsedOrigin.host.toLowerCase() !== hostHeader.toLowerCase()) {
              throw new ContractError(
                "FORBIDDEN",
                "Cross-origin state-changing cookie request rejected"
              );
            }
          } catch (originErr) {
            if (originErr instanceof ContractError) throw originErr;
            throw new ContractError("FORBIDDEN", "Invalid Origin header");
          }
        }
      }
      return {
        cloudUserId: cookieAuth.cloudUserId,
        familyId: "web_cookie_family",
        sessionId: "web_cookie_session",
        ssoIssuer: cookieAuth.user.issuer,
        ssoSubject: cookieAuth.user.subject,
        roles: cookieAuth.roles
      };
    }
    if (bearerErr) throw bearerErr;
    throw new ContractError("CLOUD_AUTH_REQUIRED", "Missing Bearer Authorization header");
  }

  const ssoSyncState = new Map(); // cloudUserId -> { lastMs, inFlight }

  // Console page perf: never block page render on the SSO finance-matrix call.
  // Serve last-known value; refresh in the background when stale (60s TTL).
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

  // Short-lived per-view payload memo: SPA prefetch + rapid nav clicks would
  // otherwise rebuild identical collections on every request.
  const consoleViewDataMemo = new Map(); // activeNav -> { atMs, data }
  const CONSOLE_VIEW_MEMO_MS = 1_500;

  // /static/* in-memory asset cache (buffer + weak etag; stat revalidated ≤5s).
  const staticAssetCache = new Map(); // filePath -> { buf, etag, mime, atMs }

  async function syncUserToSso(cloudUserId) {
    const st = ssoSyncState.get(cloudUserId);
    if (st?.inFlight) return st.inFlight;
    if (st?.lastMs && Date.now() - st.lastMs < 30_000) return;
    const inFlight = doSyncUserToSso(cloudUserId);
    ssoSyncState.set(cloudUserId, { lastMs: Date.now(), inFlight });
    try {
      await inFlight;
    } finally {
      ssoSyncState.set(cloudUserId, { lastMs: Date.now() });
    }
  }

  async function doSyncUserToSso(cloudUserId) {
    if (typeof store.saveSnapshot === "function") {
      store.saveSnapshot();
    }
    const user = store.users.get(cloudUserId);
    if (!user || !user.sso_access_token) return;
    const bindings = store.recordsForUser("schoolBindings", cloudUserId).filter((b) => !b.revoked_at);
    const plans = store.recordsForUser("reservationPlans", cloudUserId).filter((p) => p.enabled !== false);
    const jobs = store.recordsForUser("reservationJobs", cloudUserId);
    const parcels = parcelHub.listUserParcels(cloudUserId);
    const readyParcels = parcels.filter(
      (p) => p.status !== "PICKED_UP" && (p.status === "READY_FOR_PICKUP" || p.pickup_code)
    );
    const orders = store.recordsForUser("reservationOrders", cloudUserId);
    await identity.syncUserSiteProfileToSso(user, {
      school_bindings_count: bindings.length,
      active_student_no: bindings[0]?.student_no || bindings[0]?.student_no_masked || null,
      active_plans_count: plans.length,
      ready_parcels_count: readyParcels.length,
      orders_count: orders.length,
      recent_parcels: readyParcels.slice(0, 5).map((p) => ({
        id: p.id,
        tracking_number: p.tracking_number,
        pickup_code: p.pickup_code || "",
        station_name: p.station_name || "",
        carrier_name: p.carrier_name || p.carrier_code || "",
        status: p.status
      })),
      recent_jobs: jobs.slice(-5).map((j) => {
        const p = store.reservationPlans.get(j.plan_id) || {};
        return {
          id: j.id,
          plan_id: j.plan_id,
          area_name: p.area_name || p.area_code || "图书馆自习室",
          candidate_seats: p.candidate_seats || [],
          booking_local_date: j.booking_local_date,
          target_local_time: j.target_local_time,
          state: j.state
        };
      })
    });
  }

  async function buildUserSyncSnapshot(cloudUserId) {
    const user = store.users.get(cloudUserId);
    const wallet = await financeService.getWalletSnapshot(cloudUserId);
    const bindings = store.recordsForUser("schoolBindings", cloudUserId)
      .filter((b) => !b.revoked_at)
      .map((b) => ({
        id: b.id,
        school_id: b.school_id,
        student_no: b.student_no || b.student_no_masked || "",
        student_no_masked: b.student_no_masked,
        status: b.status,
        consent_id: b.consent_id || null,
        auth_version: Number(b.auth_version || user?.auth_version || 1),
        created_at: b.created_at
      }));
    const consents = store.recordsForUser("consents", cloudUserId).filter((c) => !c.withdrawn_at);
    const plans = store.recordsForUser("reservationPlans", cloudUserId);
    const jobs = store.recordsForUser("reservationJobs", cloudUserId)
      .map((j) => {
        store.syncJobDisplayStatus?.(j);
        const p = store.reservationPlans.get(j.plan_id) || {};
        const jbId = j.school_binding_id || p.school_binding_id || null;
        const jb = jbId ? store.schoolBindings.get(jbId) : null;
        const sr = store.schoolReservations.get(j.id) || null;
        const attempts = store.attemptsForJob?.(j.id) || [];
        const immutableStudentNo =
          String(j.student_no || p.student_no || jb?.student_no || "").trim() || null;
        const immutableMaskedStudentNo =
          immutableStudentNo && immutableStudentNo.length >= 4
            ? `${immutableStudentNo.slice(0, 2)}***${immutableStudentNo.slice(-2)}`
            : jb?.student_no_masked || null;
        return {
          ...j,
          school_binding_id: jbId,
          student_no: immutableStudentNo,
          student_no_masked: immutableMaskedStudentNo,
          area_code: p.area_code || "4F_NORTH",
          area_name: p.area_name || "4楼北自习区",
          candidate_seats: p.candidate_seats || [],
          slot_window: p.slot_window || "08:00-22:00",
          repeat_days: Math.max(Number(p.repeat_days || 1), Number(j.repeat_days || 1)),
          remaining_days: Number(j.remaining_days ?? p.remaining_days ?? 1),
          end_local_date: p.end_local_date || j.end_local_date || j.booking_local_date,
          parent_plan_enabled: Boolean(p.enabled),
          parent_plan_user_intent_state: p.user_intent_state || "ACTIVE",
          school_reservation: sr,
          attempts
        };
      });
    const orders = store.recordsForUser("reservationOrders", cloudUserId)
      .map((o) => ({
        ...o,
        price_peach: Number(
          o.price_peach ?? (o.price_micropeach || store.pricingMicropeach || DEFAULT_RESERVATION_PRICE_MICROPEACH) / MICROPEACH_PER_PEACH
        )
      }));
    const parcels = parcelHub.listUserParcels(cloudUserId);
    const parcelConnections = parcelHub.listConnections(cloudUserId);
    const campusContent = store.getCampusContent(DEFAULT_SCHOOL_ID, { includeDisabled: false });
    return {
      user: {
        cloud_user_id: user.id,
        sso_issuer: user.issuer,
        sso_subject: user.subject,
        username: user.username || user.display_name,
        display_name: user.display_name,
        email: user.email || null,
        group: wallet.group || user.group || "默认分组",
        aff_code: wallet.aff_code || user.aff_code || null,
        role: user.role || "user"
      },
      wallet: {
        currency_symbol: "🍑",
        peach_balance: wallet.peach_balance,
        peach_balance_formatted: wallet.peach_balance_formatted,
        peach_used: wallet.peach_used,
        peach_used_formatted: wallet.peach_used_formatted,
        group: wallet.group || user.group || "默认分组",
        aff_code: wallet.aff_code || user.aff_code || ""
      },
      auth_version: Number(user?.auth_version || 1),
      school_bindings: bindings,
      consents,
      reservation_plans: plans,
      reservation_jobs: jobs,
      reservation_attempts: store.recordsForUser("reservationAttempts", cloudUserId),
      orders,
      parcels,
      parcel_connections: parcelConnections,
      campus_content: campusContent,
      synced_at: new Date().toISOString()
    };
  }

  // --- 1..3 System & OpenAPI ---
  register("GET", "/healthz", "getHealthz", "none", async () => {
    const redisTelemetry = await redisBuffer.getTelemetrySnapshot();
    return {
      status: 200,
      code: "HEALTH_OK",
      data: {
        service: "cloud-in-school",
        status: "ok",
        version: "4.1.0",
        redis_buffer: {
          enabled: redisTelemetry.enabled,
          connected: redisTelemetry.connected,
          hit_rate_pct: redisTelemetry.hit_rate_pct,
          l1_entries: redisTelemetry.l1_entries
        }
      }
    };
  });

  register("GET", "/readyz", "getReadyz", "none", async () => {
    const redisTelemetry = await redisBuffer.getTelemetrySnapshot();
    return {
      status: 200,
      code: "READY_OK",
      data: {
        ready: kmsVault.kmsOnline,
        migrations_applied: Array.from(store.appliedMigrations),
        school_providers: ["school.haut.library"],
        redis_buffer: { connected: Boolean(redisTelemetry?.connected) }
      }
    };
  });

  register("GET", "/api/v1/openapi.json", "getOpenApiSpec", "none", async () => ({
    status: 200,
    code: "OPENAPI_SPEC",
    data: {
      openapi: "3.1.2",
      spec_yaml_length: loadOpenApiText().length,
      registered_operations: routes.length
    }
  }));

  // --- 4..10 Identity & OIDC BFF ---
  register(
    "POST",
    "/api/v1/auth/mobile/start",
    "startMobileAuthTransaction",
    "anonymous_rate_limited",
    async ({ body, nowMs }) => {
      const res = identity.startMobileTransaction(
        {
          installEphemeralId: body?.install_ephemeral_id,
          codeChallenge: body?.code_challenge,
          codeChallengeMethod: body?.code_challenge_method,
          deviceLabel: body?.device_label
        },
        nowMs
      );
      return { status: 200, code: "AUTH_TXN_STARTED", data: res };
    }
  );

  register("GET", "/api/v1/auth/oidc/start", "startOidcRedirect", "login_txn", async ({ query, nowMs }) => {
    const redirectUrl = identity.buildOidcRedirectUrl(query.get("txn"), nowMs);
    return {
      status: 302,
      headers: { Location: redirectUrl },
      code: "OIDC_REDIRECT",
      data: { redirect_url: redirectUrl }
    };
  });

  register(
    "GET",
    "/api/v1/auth/oidc/callback",
    "handleOidcCallback",
    "oidc_state_nonce",
    async ({ query, nowMs }) => {
      const res = await identity.handleOidcCallback(
        {
          code: query.get("code"),
          state: query.get("state"),
          iss: query.get("iss")
        },
        nowMs
      );
      const headers = { Location: res.appLinkUrl };
      if (res.webSessionCookie) {
        headers["set-cookie"] = `dis_web_session=${encodeURIComponent(
          res.webSessionCookie
        )}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
      }
      return {
        status: 302,
        headers,
        code: "OIDC_CALLBACK_OK",
        data: {
          app_ticket: res.appTicket,
          login_txn: res.loginTxn,
          app_link_url: res.appLinkUrl
        }
      };
    }
  );

  register(
    "POST",
    "/api/v1/auth/mobile/exchange",
    "exchangeMobileAppTicket",
    "single_use_ticket_and_pkce",
    async ({ body, nowMs }) => {
      const res = identity.exchangeMobileTicket(
        {
          loginTxn: body?.login_txn,
          appTicket: body?.app_ticket,
          codeVerifier: body?.code_verifier
        },
        nowMs
      );
      return { status: 200, code: "SESSION_ISSUED", data: res };
    }
  );

  register(
    "POST",
    "/api/v1/auth/refresh",
    "refreshCloudSession",
    "refresh_token_family",
    async ({ body, nowMs }) => {
      const res = identity.refreshSession(body?.refresh_token, nowMs);
      return { status: 200, code: "SESSION_REFRESHED", data: res };
    }
  );

  register("POST", "/api/v1/auth/logout", "logoutCurrentSession", "bearer", async ({ auth, nowMs }) => {
    identity.revokeSessionFamily(auth.familyId, "USER_LOGOUT", nowMs);
    return {
      status: 200,
      code: "LOGGED_OUT",
      data: { family_id: auth.familyId, revoked: true }
    };
  });

  register("POST", "/api/v1/auth/logout-all", "logoutAllSessions", "bearer", async ({ auth, body, nowMs }) => {
    identity.revokeAllUserSessions(auth.cloudUserId, Boolean(body?.unlink_xpeach), nowMs);
    return {
      status: 200,
      code: "LOGGED_OUT_ALL",
      data: { cloud_user_id: auth.cloudUserId, unlinked_xpeach: Boolean(body?.unlink_xpeach) }
    };
  });

  // --- 11..20 Me, Devices, Wallet, Orders, Consents, Data Export/Delete ---
  register("GET", "/api/v1/me", "getMyProfile", "bearer", async ({ auth }) => {
    const user = store.users.get(auth.cloudUserId);
    const wallet = await financeService.getWalletSnapshot(auth.cloudUserId);
    return {
      status: 200,
      code: "PROFILE_OK",
      data: {
        cloud_user_id: user.id,
        sso_issuer: user.issuer,
        sso_subject: user.subject,
        username: user.username || user.display_name,
        display_name: user.display_name,
        email: user.email || null,
        email_verified: Boolean(user.email_verified),
        group: wallet.group || user.group || "默认分组",
        aff_code: wallet.aff_code || user.aff_code || null,
        peach_balance: wallet.peach_balance,
        peach_balance_formatted: wallet.peach_balance_formatted,
        peach_used: wallet.peach_used,
        peach_used_formatted: wallet.peach_used_formatted,
        peach_wallet: user.peach_wallet || null,
        roles: auth.roles,
        status: user.status
      }
    };
  });

  register("GET", "/api/v1/me/devices", "listMyDevices", "bearer", async ({ auth }) => {
    const list = Array.from(store.deviceSessions.values())
      .filter((s) => s.cloud_user_id === auth.cloudUserId && !s.revoked_at && !s.consumed_at)
      .map((s) => ({
        device_id: s.id,
        family_id: s.family_id,
        device_label: s.device_label,
        generation: s.generation,
        created_at: s.created_at,
        expires_at: s.expires_at
      }));
    return { status: 200, code: "DEVICES_LISTED", data: { devices: list } };
  });

  register(
    "DELETE",
    "/api/v1/me/devices/{deviceId}",
    "revokeMyDevice",
    "bearer",
    async ({ auth, params, nowMs }) => {
      const sess = store.deviceSessions.get(params.deviceId);
      if (!sess || sess.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "Device session not found");
      }
      identity.revokeSessionFamily(sess.family_id, "DEVICE_REVOKED_BY_USER", nowMs);
      return { status: 200, code: "DEVICE_REVOKED", data: { device_id: params.deviceId, revoked: true } };
    }
  );

  register("GET", "/api/v1/me/wallet", "getMyWallet", "bearer", async ({ auth }) => {
    const wallet = await financeService.getWalletSnapshot(auth.cloudUserId);
    return { status: 200, code: "WALLET_OK", data: wallet };
  });

  register("GET", "/api/v1/me/orders", "listMyOrders", "bearer", async ({ auth }) => {
    const orders = store.recordsForUser("reservationOrders", auth.cloudUserId);
    return { status: 200, code: "ORDERS_LISTED", data: { orders } };
  });

  register("GET", "/api/v1/me/consents", "listMyConsents", "bearer", async ({ auth }) => {
    const consents = store.recordsForUser("consents", auth.cloudUserId);
    return { status: 200, code: "CONSENTS_LISTED", data: { consents } };
  });

  register("POST", "/api/v1/me/consents", "grantConsent", "bearer", async ({ auth, body, nowMs }) => {
    const user = store.users.get(auth.cloudUserId);
    const authVer = Number(user?.auth_version || 1);
    const schoolId = body?.school_id || "haut";
    const requestedScopes =
      Array.isArray(body?.scope_list) && body.scope_list.length > 0
        ? body.scope_list
        : ["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"];
    const existingActive = store
      .recordsForUser("consents", auth.cloudUserId)
      .find(
        (c) =>
          (c.school_id || DEFAULT_SCHOOL_ID) === schoolId &&
          !c.withdrawn_at &&
          Number(c.auth_version || 1) === authVer
      );
    if (existingActive) {
      const mergedScopes = Array.from(
        new Set([...(existingActive.scope_list || []), ...requestedScopes])
      );
      existingActive.scope_list = mergedScopes;
      for (const b of store.recordsForUser("schoolBindings", auth.cloudUserId)) {
        if (
          b.school_id === schoolId &&
          !b.revoked_at &&
          b.status !== "REVOKED" &&
          Number(b.auth_version || 1) === authVer
        ) {
          b.consent_id = existingActive.id;
        }
      }
      store.saveSnapshot?.();
      return { status: 201, code: "CONSENT_GRANTED", data: existingActive };
    }
    const id = crypto.randomUUID();
    const record = {
      id,
      cloud_user_id: auth.cloudUserId,
      school_id: schoolId,
      scope_list: requestedScopes,
      policy_version: body?.policy_version || "policy-2026-11-v4",
      auth_version: authVer,
      granted_at: new Date(nowMs).toISOString(),
      withdrawn_at: null
    };
    store.consents.set(id, record);
    store.indexUserScoped?.("consents", id, record.cloud_user_id);
    for (const b of store.recordsForUser("schoolBindings", auth.cloudUserId)) {
      if (
        b.school_id === record.school_id &&
        !b.revoked_at &&
        b.status !== "REVOKED" &&
        Number(b.auth_version || 1) === authVer
      ) {
        b.consent_id = record.id;
      }
    }
    return { status: 201, code: "CONSENT_GRANTED", data: record };
  });

  register(
    "DELETE",
    "/api/v1/me/consents/{consentId}",
    "withdrawConsent",
    "bearer",
    async ({ auth, params, nowMs }) => {
      const c = store.consents.get(params.consentId);
      if (!c || c.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "Consent record not found");
      }
      c.withdrawn_at = new Date(nowMs).toISOString();
      const cascade = store.haltAllUserPlansAndBindings(
        auth.cloudUserId,
        "CONSENT_WITHDRAWN",
        nowMs
      );
      return {
        status: 200,
        code: "CONSENT_WITHDRAWN_OK",
        data: {
          consent_id: c.id,
          withdrawn_at: c.withdrawn_at,
          cancelled_job_ids: cascade.cancelledJobIds
        }
      };
    }
  );

  register("POST", "/api/v1/me/data-export", "requestMyDataExport", "bearer", async ({ auth }) => {
    const user = store.users.get(auth.cloudUserId);
    const bindings = store.recordsForUser("schoolBindings", auth.cloudUserId);
    const plans = store.recordsForUser("reservationPlans", auth.cloudUserId);
    const parcels = parcelHub.listUserParcels(auth.cloudUserId);
    const ms = store.momentsState || { posts: [], book_listings: [], anti_lost_tags: [] };
    const momentsPosts = (ms.posts || []).filter((p) => p?.owner_cloud_user_id === auth.cloudUserId);
    const momentsBooks = (ms.book_listings || []).filter((b) => b?.owner_cloud_user_id === auth.cloudUserId);
    const momentsTags = (ms.anti_lost_tags || []).filter((t) => t?.owner_cloud_user_id === auth.cloudUserId);
    return {
      status: 200,
      code: "DATA_EXPORT_READY",
      data: redactSensitiveFields({
        user,
        school_bindings: bindings,
        reservation_plans: plans,
        parcels,
        moments_posts: momentsPosts,
        moments_books: momentsBooks,
        moments_anti_lost_tags: momentsTags
      })
    };
  });

  register("POST", "/api/v1/me/data-delete", "requestMyDataDelete", "bearer", async ({ auth, nowMs }) => {
    const cascade = store.haltAllUserPlansAndBindings(auth.cloudUserId, "USER_DATA_DELETE", nowMs);
    const momentsPurged = store.purgeUserMomentsData?.(auth.cloudUserId, nowMs) || null;
    identity.revokeAllUserSessions(auth.cloudUserId, true, nowMs);
    const user = store.users.get(auth.cloudUserId);
    if (user) user.status = "DELETED";
    return {
      status: 202,
      code: "DATA_DELETE_ACCEPTED",
      data: {
        cloud_user_id: auth.cloudUserId,
        status: "DELETED",
        cancelled_job_ids: cascade.cancelledJobIds,
        moments_purged: momentsPurged
      }
    };
  });

  // --- 21..29 Schools & School Bindings ---
  register("GET", "/api/v1/schools", "listSchools", "public", async () => {
    const { value: schools, cacheStatus } = await redisBuffer.getOrCompute(
      "schools",
      "list",
      300,
      async () =>
        Array.from(store.schoolIntegrations.values()).map((s) => ({
          school_id: s.school_id,
          display_name: s.display_name,
          provider_id: s.provider_id,
          enabled: s.enabled,
          kill_switch: s.kill_switch
        }))
    );
    return {
      status: 200,
      headers: { "x-cache": cacheStatus },
      code: "SCHOOLS_LISTED",
      data: { schools }
    };
  });

  register(
    "GET",
    "/api/v1/schools/{schoolId}/library/capabilities",
    "getSchoolLibraryCapabilities",
    "public",
    async ({ params }) => {
      const { value: capabilities, cacheStatus } = await redisBuffer.getOrCompute(
        "schools",
        `caps:${params.schoolId}`,
        300,
        async () => {
          const integ = store.schoolIntegrations.get(params.schoolId);
          if (!integ) throw new ContractError("NOT_FOUND", `Unknown school: ${params.schoolId}`);
          return schoolProvider.getCapabilities(integ);
        }
      );
      return {
        status: 200,
        headers: { "x-cache": cacheStatus },
        code: "SCHOOL_CAPABILITIES_OK",
        data: { capabilities }
      };
    }
  );

  register(
    "GET",
    "/api/v1/schools/{schoolId}/library/rules",
    "getSchoolLibraryRules",
    "public",
    async ({ params }) => {
      if (params.schoolId !== "haut") {
        throw new ContractError("NOT_FOUND", `Unknown school: ${params.schoolId}`);
      }
      return { status: 200, code: "SCHOOL_RULES_OK", data: schoolProvider.getRules() };
    }
  );

  register(
    "GET",
    "/api/v1/schools/{schoolId}/booking-rules",
    "getSchoolBookingRulesCanonical",
    "public",
    async ({ params }) => {
      if (params.schoolId !== "haut") {
        throw new ContractError("NOT_FOUND", `Unknown school: ${params.schoolId}`);
      }
      return { status: 200, code: "SCHOOL_BOOKING_RULES_OK", data: schoolProvider.getRules() };
    }
  );

  register("GET", "/api/v1/school-bindings", "listMySchoolBindings", "bearer", async ({ auth }) => {
    const bindings = store.recordsForUser("schoolBindings", auth.cloudUserId)
      .map((b) => ({
        id: b.id,
        school_id: b.school_id,
        student_no: b.student_no || b.student_no_masked || "",
        student_no_masked: b.student_no_masked,
        status: b.status,
        created_at: b.created_at,
        revoked_at: b.revoked_at
      }));
    return { status: 200, code: "SCHOOL_BINDINGS_LISTED", data: { bindings } };
  });

  register(
    "POST",
    "/api/v1/school-bindings",
    "initiateSchoolBinding",
    "bearer",
    async ({ auth, body, nowMs }) => {
      const schoolId = body?.school_id || "haut";
      if (!store.schoolIntegrations.has(schoolId)) {
        throw new ContractError("NOT_FOUND", `Unsupported school_id: ${schoolId}`);
      }
      const explicitSno = typeof body?.student_no === "string" ? body.student_no.trim() : "";
      const studentNo = explicitSno || "20240001";
      const authVer = Number(store.users.get(auth.cloudUserId)?.auth_version || 1);
      const activeConsents = store
        .recordsForUser("consents", auth.cloudUserId)
        .filter((c) => (c.school_id || DEFAULT_SCHOOL_ID) === schoolId && !c.withdrawn_at);
      const latestConsent = activeConsents[activeConsents.length - 1] || null;
      if (explicitSno && explicitSno !== "haut_bound_user") {
        const reusableBinding = store
          .recordsForUser("schoolBindings", auth.cloudUserId)
          .find(
            (b) =>
              b.school_id === schoolId &&
              !b.revoked_at &&
              b.status !== "REVOKED" &&
              String(b.student_no || "").trim() === studentNo &&
              Number(b.auth_version || 1) === authVer
          );
        if (reusableBinding) {
          reusableBinding.consent_id =
            body?.consent_id || latestConsent?.id || reusableBinding.consent_id || null;
          store.saveSnapshot();
          return { status: 201, code: "SCHOOL_BINDING_INITIATED", data: reusableBinding };
        }
      }
      const bindingId = crypto.randomUUID();
      const binding = {
        id: bindingId,
        cloud_user_id: auth.cloudUserId,
        school_id: schoolId,
        student_no: studentNo,
        student_no_masked:
          studentNo.length >= 4
            ? `${studentNo.slice(0, 2)}***${studentNo.slice(-2)}`
            : "***",
        status: "PENDING_DELEGATION",
        credential_ref: null,
        credential_expires_at: null,
        consent_id: body?.consent_id || latestConsent?.id || null,
        auth_version: authVer,
        created_at: new Date(nowMs).toISOString(),
        revoked_at: null
      };
      store.schoolBindings.set(bindingId, binding);
      store.indexUserScoped?.("schoolBindings", bindingId, binding.cloud_user_id);
      store.saveSnapshot();
      return { status: 201, code: "SCHOOL_BINDING_INITIATED", data: binding };
    }
  );

  register(
    "POST",
    "/api/v1/school-bindings/{bindingId}/complete",
    "completeSchoolBinding",
    "bearer",
    async ({ auth, params, body, nowMs }) => {
      const binding = store.schoolBindings.get(params.bindingId);
      if (!binding || binding.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "School binding not found");
      }
      if (binding.revoked_at || binding.status === "REVOKED") {
        throw new ContractError("CONSENT_WITHDRAWN", "Revoked school binding cannot be completed");
      }
      const secretPayload = body?.delegated_secret || body?.session_token || "delegated_session_v1";
      if (typeof secretPayload === "string" && secretPayload.trim().startsWith("{")) {
        try {
          const parsedSec = JSON.parse(secretPayload.trim());
          const secSno = String(parsedSec.student_no || parsedSec.studentId || "").trim();
          const bindSno = String(binding.student_no || "").trim();
          if (secSno && bindSno && secSno !== bindSno) {
            throw new ContractError(
              "FORBIDDEN",
              "delegated_secret student_no does not match binding student_no"
            );
          }
        } catch (e) {
          if (e instanceof ContractError) throw e;
        }
      }
      const encrypted = kmsVault.encryptSecret({
        bindingId: binding.id,
        schoolId: binding.school_id,
        credentialKind: body?.credential_kind || "DELEGATED_SESSION_BUNDLE",
        plaintext: secretPayload,
        expiresAt:
          body?.expires_at || new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString()
      });
      // If another active binding for the same school has a DIFFERENT student_no, revoke it first so old student's plans are invalidated!
      const targetBindSno = String(binding.student_no || "").trim();
      for (const other of store.recordsForUser("schoolBindings", auth.cloudUserId)) {
        if (
          other.id !== binding.id &&
          other.school_id === binding.school_id &&
          !other.revoked_at &&
          other.status !== "REVOKED" &&
          targetBindSno &&
          String(other.student_no || "").trim() &&
          String(other.student_no || "").trim() !== targetBindSno
        ) {
          store.revokeSchoolBindingCascade(
            auth.cloudUserId,
            other.id,
            "SCHOOL_IDENTITY_REBOUND",
            nowMs
          );
        }
      }
      const authVer = Number(store.users.get(auth.cloudUserId)?.auth_version || 1);
      const activeConsents = store
        .recordsForUser("consents", auth.cloudUserId)
        .filter((c) => (c.school_id || DEFAULT_SCHOOL_ID) === binding.school_id && !c.withdrawn_at);
      let latestConsent = activeConsents[activeConsents.length - 1] || null;
      if (!latestConsent) {
        const cid = crypto.randomUUID();
        latestConsent = {
          id: cid,
          cloud_user_id: auth.cloudUserId,
          school_id: binding.school_id,
          scope_list: ["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"],
          policy_version: "policy-2026-11-v4",
          auth_version: authVer,
          granted_at: new Date(nowMs).toISOString(),
          withdrawn_at: null
        };
        store.consents.set(cid, latestConsent);
        store.indexUserScoped?.("consents", cid, latestConsent.cloud_user_id);
      }
      store.encryptedCredentials.set(encrypted.id, encrypted);
      binding.credential_ref = encrypted.id;
      binding.credential_expires_at = encrypted.expires_at;
      binding.status = "DELEGATED_ACTIVE";
      binding.auth_version = authVer;
      binding.consent_id = body?.consent_id || latestConsent?.id || binding.consent_id || null;
      if (latestConsent) {
        latestConsent.auth_version = authVer;
      }
      const userForBindSeq = store.users.get(auth.cloudUserId);
      if (userForBindSeq) {
        userForBindSeq._latestBindStartSeq = Number(userForBindSeq._latestBindStartSeq || 0) + 1;
        userForBindSeq._lastBindCommitSeq = Number(userForBindSeq._lastBindCommitSeq || 0) + 1;
      }
      await syncUserToSso(auth.cloudUserId);
      return {
        status: 200,
        code: "SCHOOL_BINDING_COMPLETED",
        data: {
          id: binding.id,
          school_id: binding.school_id,
          student_no: binding.student_no || binding.student_no_masked || "",
          status: binding.status,
          credential_ref: binding.credential_ref,
          credential_expires_at: binding.credential_expires_at
        }
      };
    }
  );

  register(
    "POST",
    "/api/v1/school-bindings/{bindingId}/reauthorize",
    "reauthorizeSchoolBinding",
    "bearer",
    async ({ auth, params, body, nowMs }) => {
      const binding = store.schoolBindings.get(params.bindingId);
      if (!binding || binding.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "School binding not found");
      }
      const reauthSecret = body?.delegated_secret || "reauthorized_session_v1";
      if (typeof reauthSecret === "string" && reauthSecret.trim().startsWith("{")) {
        let parsedReauth;
        try {
          parsedReauth = JSON.parse(reauthSecret.trim());
        } catch {
          throw new ContractError("BAD_REQUEST", "Malformed delegated_secret JSON");
        }
        const secSno = String(parsedReauth?.student_no || parsedReauth?.studentId || "").trim();
        const bindSno = String(binding.student_no || "").trim();
        if (secSno && bindSno && secSno !== bindSno) {
          throw new ContractError(
            "FORBIDDEN",
            "delegated_secret student_no does not match binding student_no"
          );
        }
      }
      if (binding.credential_ref && store.encryptedCredentials.has(binding.credential_ref)) {
        store.encryptedCredentials.get(binding.credential_ref).revoked_at = new Date(nowMs).toISOString();
      }
      const encrypted = kmsVault.encryptSecret({
        bindingId: binding.id,
        schoolId: binding.school_id,
        credentialKind: body?.credential_kind || "DELEGATED_SESSION_BUNDLE",
        plaintext: body?.delegated_secret || "reauthorized_session_v1",
        expiresAt:
          body?.expires_at || new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString()
      });
      const userObj = store.users.get(auth.cloudUserId);
      if (userObj) {
        userObj.auth_version = Number(userObj.auth_version || 1) + 1;
        userObj._latestBindStartSeq = Number(userObj._latestBindStartSeq || 0) + 1;
        userObj._lastBindCommitSeq = Number(userObj._lastBindCommitSeq || 0) + 1;
      }
      const authVer = Number(userObj?.auth_version || 1);
      const activeConsents = store
        .recordsForUser("consents", auth.cloudUserId)
        .filter((c) => (c.school_id || DEFAULT_SCHOOL_ID) === binding.school_id && !c.withdrawn_at);
      const latestConsent = activeConsents[activeConsents.length - 1] || null;
      store.encryptedCredentials.set(encrypted.id, encrypted);
      binding.credential_ref = encrypted.id;
      binding.credential_expires_at = encrypted.expires_at;
      binding.revoked_at = null;
      binding.status = "DELEGATED_ACTIVE";
      binding.auth_version = authVer;
      binding.consent_id = body?.consent_id || latestConsent?.id || null;
      if (latestConsent) {
        latestConsent.auth_version = authVer;
      }
      return {
        status: 200,
        code: "SCHOOL_BINDING_REAUTHORIZED",
        data: {
          id: binding.id,
          status: binding.status,
          credential_ref: binding.credential_ref,
          consent_id: binding.consent_id,
          auth_version: binding.auth_version
        }
      };
    }
  );

  register(
    "DELETE",
    "/api/v1/school-bindings/{bindingId}",
    "revokeSchoolBinding",
    "bearer",
    async ({ auth, params, nowMs }) => {
      const res = store.revokeSchoolBindingCascade(
        auth.cloudUserId,
        params.bindingId,
        "USER_REVOKED_BINDING",
        nowMs
      );
      return {
        status: 200,
        code: "SCHOOL_BINDING_REVOKED",
        data: {
          binding_id: params.bindingId,
          status: res.binding.status,
          cancelled_job_ids: res.cancelledJobIds
        }
      };
    }
  );

  // --- 30..38 Reservation Plans, Jobs & Pricing ---
  register("GET", "/api/v1/reservation-plans", "listReservationPlans", "bearer", async ({ auth }) => {
    const plans = store.recordsForUser("reservationPlans", auth.cloudUserId);
    return { status: 200, code: "RESERVATION_PLANS_LISTED", data: { plans } };
  });

  register(
    "POST",
    "/api/v1/reservation-plans",
    "createReservationPlan",
    "bearer",
    async ({ auth, body, headers, nowMs }) => {
      const idemKey = headers["idempotency-key"] || headers["Idempotency-Key"] || null;
      if (idemKey) {
        const cacheKey = `createReservationPlan|${auth.cloudUserId}|${idemKey}`;
        const bodyHash = crypto.createHash("sha256").update(JSON.stringify(body || {})).digest("hex");
        if (store.idempotencyRecords.has(cacheKey)) {
          const existing = store.idempotencyRecords.get(cacheKey);
          if (existing.bodyHash !== bodyHash) {
            throw new ContractError(
              "CONFLICT",
              "Idempotency-Key reused with different request payload"
            );
          }
          return { status: 200, code: "REQUEST_DUPLICATE", data: existing.data };
        }
        const created = reservationEngine.createPlanAndJob(auth.cloudUserId, body || {}, nowMs);
        if (store.idempotencyRecords.size > 2000) {
          for (const [k, r] of store.idempotencyRecords) {
            if (!r.createdAtMs || nowMs - r.createdAtMs > 86400_000) store.idempotencyRecords.delete(k);
          }
          if (store.idempotencyRecords.size > 2000) store.idempotencyRecords.clear();
        }
        store.idempotencyRecords.set(cacheKey, { bodyHash, data: created, createdAtMs: nowMs });
        await syncUserToSso(auth.cloudUserId);
        return { status: 201, code: "RESERVATION_PLAN_CREATED", data: created };
      }
      const created = reservationEngine.createPlanAndJob(auth.cloudUserId, body || {}, nowMs);
      await syncUserToSso(auth.cloudUserId);
      return { status: 201, code: "RESERVATION_PLAN_CREATED", data: created };
    }
  );

  register(
    "PATCH",
    "/api/v1/reservation-plans/{planId}",
    "updateReservationPlan",
    "bearer",
    async ({ auth, params, body }) => {
      const plan = store.reservationPlans.get(params.planId);
      if (!plan || plan.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "Reservation plan not found");
      }
      const nextSeats = body?.candidate_seats || body?.preferred_seat_ids;
      const nextAreas = body?.preferred_area_ids || (body?.area_name ? [body.area_name] : null);
      if (nextSeats || nextAreas || body?.slot_window !== undefined) {
        const hasInFlightOrAmbiguousJob = Array.from(store.reservationJobs.values()).some(
          (j) =>
            j.plan_id === plan.id &&
            ([
              "EXECUTING",
              "RESULT_UNKNOWN",
              "DELEGATION_STOPPED_RESULT_UNKNOWN",
              "CANCEL_RESULT_UNKNOWN"
            ].includes(j.state) ||
              ["DISPATCH_INTENT", "RESULT_UNKNOWN"].includes(j.external_execution_state))
        );
        if (hasInFlightOrAmbiguousJob) {
          throw new ContractError(
            "CONFLICT",
            "当前计划存在执行中或结果待核对的任务，禁止在核实前原地修改目标区域或候选座位"
          );
        }
      }
      if (Array.isArray(nextSeats) && nextSeats.length > 0) {
        const cleanSeats = nextSeats.map((s) => String(s).trim()).filter(Boolean);
        plan.candidate_seats = cleanSeats;
        plan.preferences_json.preferred_seat_ids = cleanSeats;
      }
      if (Array.isArray(nextAreas) && nextAreas.length > 0) {
        const cleanArea = String(nextAreas[0]).trim();
        plan.area_name = cleanArea;
        plan.area_code = cleanArea;
        plan.preferences_json.preferred_area_ids = [cleanArea];
      }
      if (nextSeats || nextAreas) {
        for (const j of store.reservationJobs.values()) {
          if (
            j.plan_id === plan.id &&
            ["ARMED", "PRECHECK_OK", "FINAL_CHECK_OK", "NEEDS_RECONFIRMATION"].includes(j.state)
          ) {
            j.prewarmed_targets = null;
          }
        }
      }
      if (body?.repeat_days !== undefined || body?.repeatDays !== undefined) {
        const nextRepeat = Math.min(Math.max(Number(body.repeat_days ?? body.repeatDays) || 1, 1), 30);
        plan.repeat_days = nextRepeat;
        plan.remaining_days = Math.min(
          Math.max(Number(body.remaining_days ?? body.remainingDays ?? nextRepeat) || nextRepeat, 1),
          nextRepeat
        );
        plan.end_local_date = addDaysToLocalDate(plan.target_local_date, plan.remaining_days - 1);
        for (const j of store.reservationJobs.values()) {
          if (j.plan_id === plan.id && !["CONFIRMED", "FAILED", "CANCELLED", "EXPIRED"].includes(j.state)) {
            j.repeat_days = plan.repeat_days;
            j.remaining_days = plan.remaining_days;
            j.end_local_date = plan.end_local_date;
          }
        }
      }
      plan.generation += 1;
      await syncUserToSso(auth.cloudUserId);
      return { status: 200, code: "RESERVATION_PLAN_UPDATED", data: plan };
    }
  );

  register(
    "DELETE",
    "/api/v1/reservation-plans/{planId}",
    "cancelReservationPlan",
    "bearer",
    async ({ auth, params, nowMs }) => {
      const stopRes = reservationEngine.stopPlanAndActiveJobs({
        planId: params.planId,
        cloudUserId: auth.cloudUserId,
        reason: "用户停止预约计划委托",
        nowMs
      });
      await syncUserToSso(auth.cloudUserId);
      return {
        status: 200,
        code: "RESERVATION_PLAN_CANCELLED",
        data: {
          plan_id: stopRes.plan_id,
          enabled: false,
          cancelled_job_ids: stopRes.cancelled_job_ids,
          blocking_jobs: stopRes.blocking_jobs
        }
      };
    }
  );

  register("GET", "/api/v1/reservation-jobs", "listReservationJobs", "bearer", async ({ auth }) => {
    const jobs = store.recordsForUser("reservationJobs", auth.cloudUserId).map((j) => {
      store.syncJobDisplayStatus?.(j);
      return j;
    });
    return { status: 200, code: "RESERVATION_JOBS_LISTED", data: { jobs } };
  });

  register(
    "GET",
    "/api/v1/reservation-jobs/{jobId}",
    "getReservationJob",
    "bearer",
    async ({ auth, params }) => {
      const job = store.reservationJobs.get(params.jobId);
      if (!job) throw new ContractError("NOT_FOUND", "Reservation job not found");
      if (job.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("FORBIDDEN", "Cross-user reservation job access denied");
      }
      store.syncJobDisplayStatus?.(job);
      const parentPlan = job.plan_id ? store.reservationPlans.get(job.plan_id) : null;
      const events = store.eventsForJob(job.id);
      const attempts = store.attemptsForJob?.(job.id) || [];
      return {
        status: 200,
        code: "RESERVATION_JOB_OK",
        data: {
          ...job,
          parent_plan_enabled: parentPlan ? Boolean(parentPlan.enabled) : false,
          parent_plan_user_intent_state: parentPlan?.user_intent_state || "ACTIVE",
          schedule_events: events,
          attempts
        }
      };
    }
  );

  register(
    "POST",
    "/api/v1/reservation-jobs/{jobId}/cancel",
    "cancelReservationJob",
    "bearer",
    async ({ auth, params, nowMs }) => {
      const job = store.reservationJobs.get(params.jobId);
      if (!job) throw new ContractError("NOT_FOUND", "Reservation job not found");
      if (job.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("FORBIDDEN", "Cross-user reservation job cancel denied");
      }
      const hadActiveParentOrChildBeforeStop = (() => {
        const p = job.plan_id ? store.reservationPlans.get(job.plan_id) : null;
        if (p?.enabled) return true;
        if (!p) return false;
        return Array.from(store.reservationJobs.values()).some(
          (sib) =>
            sib.plan_id === p.id &&
            sib.id !== job.id &&
            !["FAILED", "EXPIRED", "CANCELLED", "REVOKED", "SCHOOL_CANCELLED", "SKIPPED_FINANCE", "SKIPPED_AUTH"].includes(sib.state)
        );
      })();

      // Always stop parent plan and all undispatched child jobs immediately (even if this jobId is already FAILED/EXPIRED!)
      const stopRes = reservationEngine.stopPlanAndActiveJobs({
        planId: job.plan_id,
        jobId: job.id,
        cloudUserId: auth.cloudUserId,
        reason: "用户停止任务委托",
        nowMs
      });
      await syncUserToSso(auth.cloudUserId);

      if (stopRes.blocking_jobs.length > 0) {
        throw new ContractError(
          "JOB_ALREADY_TERMINAL",
          `委托计划已停止续期，但存在已发出或已确认的子任务（${stopRes.blocking_jobs.map((b) => `${b.id}:${b.state}`).join(",")}），请核实状态或显式执行退座`,
          {
            stopped_plan_id: stopRes.plan_id,
            cancelled_job_ids: stopRes.cancelled_job_ids,
            blocking_jobs: stopRes.blocking_jobs
          }
        );
      }

      if (
        !hadActiveParentOrChildBeforeStop &&
        !stopRes.completed_pending_persistence &&
        ["CONFIRMED", "DELEGATION_STOPPED_SCHOOL_CONFIRMED", "SCHOOL_CANCELLED", "CANCEL_RESULT_UNKNOWN", "FAILED", "CANCELLED", "REVOKED", "EXPIRED", "SKIPPED_FINANCE", "SKIPPED_AUTH"].includes(
          job.state
        ) &&
        stopRes.cancelled_job_ids.length === 0
      ) {
        throw new ContractError("JOB_ALREADY_TERMINAL", `Job is already in terminal state ${job.state}`);
      }

      return {
        status: 200,
        code: "RESERVATION_JOB_CANCELLED",
        data: {
          ...job,
          stopped_plan_id: stopRes.plan_id,
          cancelled_child_job_ids: stopRes.cancelled_job_ids
        }
      };
    }
  );

  register(
    "GET",
    "/api/v1/reservation-jobs/{jobId}/evidence",
    "getReservationJobEvidence",
    "bearer",
    async ({ auth, params }) => {
      const job = store.reservationJobs.get(params.jobId);
      if (!job) throw new ContractError("NOT_FOUND", "Reservation job not found");
      if (job.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("FORBIDDEN", "Cross-user evidence access denied");
      }
      store.syncJobDisplayStatus?.(job);
      const schoolRes = store.schoolReservations.get(job.id) || null;
      const attempts = store.attemptsForJob?.(job.id) || [];
      return {
        status: 200,
        code: "RESERVATION_EVIDENCE_OK",
        data: {
          job_id: job.id,
          state: job.state,
          user_intent_state: job.user_intent_state,
          external_execution_state: job.external_execution_state,
          school_cancellation_state: job.school_cancellation_state,
          display_status: job.display_status,
          status_label: job.status_label,
          billing_state: job.billing_state,
          school_reservation: schoolRes,
          attempts
        }
      };
    }
  );

  register("GET", "/api/v1/pricing/library-booking", "getLibraryBookingPricing", "public", async () => ({
    status: 200,
    code: "PRICING_OK",
    data: {
      price_version: "price-library-cloud-2026-11-v1",
      currency_symbol: "🍑",
      local_device_mode_micropeach: 0,
      cloud_hosted_mode_micropeach: store.pricingMicropeach,
      charge_policy: "POST_CONFIRMATION_ONLY"
    }
  }));

  // --- 39..40 Notifications ---
  register("GET", "/api/v1/notifications", "listMyNotifications", "bearer", async ({ auth }) => {
    const notifications = store.recordsForUser("notifications", auth.cloudUserId);
    return { status: 200, code: "NOTIFICATIONS_LISTED", data: { notifications } };
  });

  register(
    "POST",
    "/api/v1/notifications/{notificationId}/read",
    "markNotificationRead",
    "bearer",
    async ({ auth, params, nowMs }) => {
      const n = store.notifications.get(params.notificationId);
      if (!n || n.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "Notification not found");
      }
      n.read_at = new Date(nowMs).toISOString();
      return { status: 200, code: "NOTIFICATION_READ", data: n };
    }
  );

  // --- 41..52 Parcel Hub ---
  register("GET", "/api/v1/parcels", "listParcels", "bearer", async ({ auth, query }) => {
    const parcels = parcelHub.listUserParcels(auth.cloudUserId, query.get("status"));
    return { status: 200, code: "PARCELS_LISTED", data: { parcels } };
  });

  register(
    "GET",
    "/api/v1/parcels/{parcelId}",
    "getParcelById",
    "bearer",
    async ({ auth, params }) => {
      const parcel = parcelHub.getParcelForUser(auth.cloudUserId, params.parcelId);
      return { status: 200, code: "PARCEL_OK", data: parcel };
    }
  );

  register(
    "GET",
    "/api/v1/parcels/{parcelId}/trace",
    "getParcelTrace",
    "bearer",
    async ({ auth, params }) => {
      const parcel = parcelHub.getParcelForUser(auth.cloudUserId, params.parcelId);
      return {
        status: 200,
        code: "PARCEL_TRACE_OK",
        data: {
          parcel_id: parcel.id,
          tracking_number: parcel.tracking_number,
          checkpoints: parcel.checkpoints,
          field_provenance: parcel.field_provenance
        }
      };
    }
  );

  register(
    "POST",
    "/api/v1/parcels/{parcelId}/tracking",
    "updateParcelTrackingPreference",
    "bearer",
    async ({ auth, params, body }) => {
      const parcel = parcelHub.getParcelForUser(auth.cloudUserId, params.parcelId);
      if (typeof body?.tracking_enabled === "boolean") {
        parcel.tracking_enabled = body.tracking_enabled;
      }
      if (body?.status === "PICKED_UP") {
        parcel.status = "PICKED_UP";
      }
      await syncUserToSso(auth.cloudUserId);
      return { status: 200, code: "PARCEL_TRACKING_UPDATED", data: parcel };
    }
  );

  register("POST", "/api/v1/parcels/imports", "importParcels", "bearer", async ({ auth, body }) => {
    const items = Array.isArray(body?.items) ? body.items : [body];
    const imported = items.map((item) =>
      parcelHub.upsertParcel({
        cloudUserId: auth.cloudUserId,
        trackingNumber: item?.tracking_number,
        carrierCode: item?.carrier_code,
        carrierName: item?.carrier_name,
        providerId: item?.provider_id || "parcel.manual",
        channel: item?.channel || "CLIENT_IMPORT",
        status: item?.status || "IN_TRANSIT",
        pickupCode: item?.pickup_code,
        stationName: item?.station_name,
        itemTitle: item?.item_title,
        rawNotificationText: item?.raw_notification_text,
        checkpoints: item?.checkpoints || [],
        sandboxOverride: allowSandboxProviders
      })
    );
    await syncUserToSso(auth.cloudUserId);
    return { status: 201, code: "PARCELS_IMPORTED", data: imported.length === 1 && !Array.isArray(body?.items) ? { parcels: imported, parcel: imported[0] } : { parcels: imported } };
  });

  register(
    "POST",
    "/api/v1/parcel-sources/{providerId}/authorizations",
    "startParcelSourceAuthorization",
    "bearer",
    async ({ auth, params, body }) => {
      const conn = parcelHub.authorizeProviderAccount({
        cloudUserId: auth.cloudUserId,
        providerId: params.providerId,
        accountAlias: body?.account_alias,
        secretPayload: body?.secret_payload,
        sandboxOverride: allowSandboxProviders
      });
      return { status: 201, code: "PARCEL_SOURCE_AUTHORIZED", data: conn };
    }
  );

  register(
    "GET",
    "/api/v1/parcel-sources/connections",
    "listParcelSourceConnections",
    "bearer",
    async ({ auth }) => ({
      status: 200,
      code: "PARCEL_CONNECTIONS_LISTED",
      data: { connections: parcelHub.listConnections(auth.cloudUserId) }
    })
  );

  register(
    "DELETE",
    "/api/v1/parcel-sources/connections/{connectionId}",
    "revokeParcelSourceConnection",
    "bearer",
    async ({ auth, params }) => {
      const conn = parcelHub.revokeConnection(auth.cloudUserId, params.connectionId);
      return { status: 200, code: "PARCEL_CONNECTION_REVOKED", data: conn };
    }
  );

  register("GET", "/api/v1/parcel-stations", "listParcelStations", "public", async () => ({
    status: 200,
    code: "PARCEL_STATIONS_LISTED",
    data: { stations: parcelHub.listStations() }
  }));

  register("POST", "/api/v1/parcel-sync/jobs", "createParcelSyncJob", "bearer", async ({ auth, body }) => {
    const providerId = body?.provider_id || "parcel.campus-station";
    parcelHub.enforceProviderAuthority(providerId, {
      channel: body?.channel || "CLOUD_BACKGROUND_POLL",
      sandboxOverride: allowSandboxProviders
    });
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      cloud_user_id: auth.cloudUserId,
      provider_id: providerId,
      status: "COMPLETED",
      created_at: new Date().toISOString()
    };
    store.parcelSyncJobs.set(jobId, job);
    return { status: 201, code: "PARCEL_SYNC_JOB_CREATED", data: job };
  });

  register(
    "GET",
    "/api/v1/parcel-sync/jobs/{jobId}",
    "getParcelSyncJob",
    "bearer",
    async ({ auth, params }) => {
      const job = store.parcelSyncJobs.get(params.jobId);
      if (!job || job.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "Parcel sync job not found");
      }
      return { status: 200, code: "PARCEL_SYNC_JOB_OK", data: job };
    }
  );

  register(
    "POST",
    "/api/v1/parcel-ai/requests",
    "invokeParcelAiAssistant",
    "bearer",
    async ({ auth, body }) => {
      const res = parcelHub.invokeParcelAssistant(auth.cloudUserId, {
        mode: body?.mode || "RULE_BASED",
        consentGranted: Boolean(body?.consent_granted)
      });
      return { status: 200, code: "PARCEL_AI_RESPONSE", data: res };
    }
  );

  // --- 53..57 Plugins & Host Features ---
  register("GET", "/api/v1/plugins/registry", "listRegisteredPlugins", "public", async () => ({
    status: 200,
    code: "PLUGIN_REGISTRY_OK",
    data: { plugins: pluginBroker.listAvailablePlugins() }
  }));

  register("POST", "/api/v1/plugins/install", "installSignedPlugin", "bearer", async ({ auth, body }) => {
    if (body?.manifest) {
      const canOverridePublicKey =
        Array.isArray(auth?.roles) &&
        (auth.roles.includes("PLATFORM_OWNER") || auth.roles.includes("ADMIN"));
      if (
        body.public_key_base64 &&
        body.public_key_base64 !== pluginBroker.publicKeyBase64 &&
        process.env.NODE_ENV === "production" &&
        !canOverridePublicKey
      ) {
        throw new ContractError(
          "FORBIDDEN",
          "Custom plugin public_key_base64 registration in production requires PLATFORM_OWNER or ADMIN role"
        );
      }
      pluginBroker.registerPluginPackage({
        manifest: body.manifest,
        artifactMap: body.artifact_map || {},
        publicKeyBase64: body.public_key_base64 || pluginBroker.publicKeyBase64,
        actorUserId: auth.cloudUserId,
        isAdmin: canOverridePublicKey
      });
    }
    const pluginId = body?.plugin_id || body?.manifest?.plugin_id;
    const inst = pluginBroker.installPluginForUser(auth.cloudUserId, pluginId, {
      version: body?.version || body?.manifest?.version
    });
    return { status: 201, code: "PLUGIN_INSTALLED", data: inst };
  });

  register(
    "POST",
    "/api/v1/plugins/{pluginId}/lifecycle",
    "transitionPluginLifecycle",
    "bearer",
    async ({ auth, params, body }) => {
      const res = pluginBroker.transitionUserPlugin(auth.cloudUserId, params.pluginId, {
        action: body?.action,
        targetVersion: body?.target_version
      });
      return { status: 200, code: "PLUGIN_LIFECYCLE_OK", data: res };
    }
  );

  register(
    "POST",
    "/api/v1/plugins/{pluginId}/commands/{commandId}/invoke",
    "invokePluginCommand",
    "bearer",
    async ({ auth, params, body }) => {
      const res = await pluginBroker.invokePluginCommand({
        userId: auth.cloudUserId,
        pluginId: params.pluginId,
        commandName: params.commandId,
        payload: body?.payload || {},
        requestedOrigin: body?.requested_origin || null
      });
      return { status: 200, code: "PLUGIN_COMMAND_EXECUTED", data: res };
    }
  );

  register("GET", "/api/v1/features", "listHostFeatures", "public", async () => ({
    status: 200,
    code: "FEATURES_OK",
    data: {
      host_api_version: 2,
      supported_plugin_schemas: ["dis-extension/v2", "dis-plugin/v2", "dis-campus-plugin/v1"],
      dual_engine_booking: ["LOCAL_DEVICE", "CLOUD_HOSTED", "MANUAL_REMINDER"],
      parcel_providers: parcelHub.listProviders()
    }
  }));

  // --- 58..66 Admin & Operations Console Endpoints ---
  register("GET", "/api/v1/admin/overview", "getAdminOverview", "bearer_rbac", async ({ auth }) => {
    store.requireRole(auth, [
      "PLATFORM_OWNER",
      "OPERATIONS_ADMIN",
      "SCHOOL_OPERATOR",
      "FINANCE_OPERATOR",
      "SECURITY_AUDITOR"
    ]);
    const redisTelemetry = await redisBuffer.getTelemetrySnapshot();
    return {
      status: 200,
      code: "ADMIN_OVERVIEW_OK",
      data: {
        users_count: store.users.size,
        active_bindings_count: Array.from(store.schoolBindings.values()).filter(
          (b) => !b.revoked_at
        ).length,
        jobs_count: store.reservationJobs.size,
        orders_count: store.reservationOrders.size,
        parcels_count: store.parcels.size,
        audit_events_count: store.auditEvents.length,
        redis_buffer: redisTelemetry
      }
    };
  });

  register(
    "GET",
    "/api/v1/admin/schools",
    "listAdminSchoolIntegrations",
    "bearer_rbac",
    async ({ auth }) => {
      store.requireRole(auth, ["PLATFORM_OWNER", "OPERATIONS_ADMIN", "SCHOOL_OPERATOR"]);
      return {
        status: 200,
        code: "ADMIN_SCHOOLS_LISTED",
        data: { schools: Array.from(store.schoolIntegrations.values()) }
      };
    }
  );

  register(
    "POST",
    "/api/v1/admin/schools/{schoolId}/kill-switch",
    "toggleSchoolKillSwitch",
    "bearer_rbac",
    async ({ auth, params, body }) => {
      store.requireRole(auth, ["PLATFORM_OWNER", "OPERATIONS_ADMIN", "SCHOOL_OPERATOR"]);
      const school = store.schoolIntegrations.get(params.schoolId);
      if (!school) throw new ContractError("NOT_FOUND", "School not found");
      school.kill_switch = Boolean(body?.kill_switch);
      school.updated_at = new Date().toISOString();
      await redisBuffer.invalidate("schools");
      store.recordAudit({
        actor_kind: "ADMIN",
        actor_ref: auth.cloudUserId,
        action: "TOGGLE_SCHOOL_KILL_SWITCH",
        resource_kind: "school_integration",
        resource_ref: params.schoolId,
        outcome: school.kill_switch ? "KILL_SWITCH_ON" : "KILL_SWITCH_OFF"
      });
      store.flushSnapshotStrictSync?.();
      return { status: 200, code: "KILL_SWITCH_UPDATED", data: school };
    }
  );

  register(
    "POST",
    "/api/v1/admin/schools/{schoolId}/authorization-approval",
    "approveSchoolAuthorization",
    "bearer_rbac",
    async ({ auth, params, body }) => {
      store.requireRole(auth, ["PLATFORM_OWNER", "SCHOOL_OPERATOR"]);
      const school = store.schoolIntegrations.get(params.schoolId);
      if (!school) throw new ContractError("NOT_FOUND", "School not found");
      if (!body?.secondary_approver_ref || body.secondary_approver_ref === auth.cloudUserId) {
        throw new ContractError(
          "FORBIDDEN",
          "Dual-person approval requires a distinct secondary_approver_ref"
        );
      }
      school.authorization_evidence_ref = body?.authorization_evidence_ref || null;
      school.approver_primary_ref = auth.cloudUserId;
      school.approver_secondary_ref = body.secondary_approver_ref;
      school.updated_at = new Date().toISOString();
      await redisBuffer.invalidate("schools");
      store.recordAudit({
        actor_kind: "ADMIN",
        actor_ref: auth.cloudUserId,
        action: "APPROVE_SCHOOL_AUTHORIZATION",
        resource_kind: "school_integration",
        resource_ref: params.schoolId,
        outcome: school.authorization_evidence_ref ? "AUTHORIZED_AUTOMATION" : "MOCK_ONLY"
      });
      store.flushSnapshotStrictSync?.();
      return { status: 200, code: "SCHOOL_AUTHORIZATION_APPROVED", data: school };
    }
  );

  register(
    "GET",
    "/api/v1/admin/jobs",
    "listAdminReservationJobs",
    "bearer_rbac",
    async ({ auth }) => {
      store.requireRole(auth, ["PLATFORM_OWNER", "OPERATIONS_ADMIN"]);
      return {
        status: 200,
        code: "ADMIN_JOBS_LISTED",
        data: { jobs: Array.from(store.reservationJobs.values()) }
      };
    }
  );

  register("GET", "/api/v1/admin/orders", "listAdminOrders", "bearer_rbac", async ({ auth }) => {
    store.requireRole(auth, ["PLATFORM_OWNER", "FINANCE_OPERATOR"]);
    return {
      status: 200,
      code: "ADMIN_ORDERS_LISTED",
      data: { orders: Array.from(store.reservationOrders.values()) }
    };
  });

  register(
    "POST",
    "/api/v1/admin/orders/{orderId}/reconcile",
    "reconcileAdminOrder",
    "bearer_rbac",
    async ({ auth, params, nowMs }) => {
      store.requireRole(auth, ["PLATFORM_OWNER", "FINANCE_OPERATOR"]);
      const order = await financeService.executeDebitForOrder(params.orderId, nowMs);
      return { status: 200, code: "ADMIN_ORDER_RECONCILED", data: order };
    }
  );

  register(
    "POST",
    "/api/v1/admin/orders/{orderId}/refund",
    "refundAdminOrder",
    "bearer_rbac",
    async ({ auth, params, body, nowMs }) => {
      store.requireRole(auth, ["PLATFORM_OWNER", "FINANCE_OPERATOR"]);
      const order = await financeService.issueRefundForOrder(
        params.orderId,
        {
          amountMicropeach: body?.amount_micropeach,
          reason: body?.reason || "Admin approved refund",
          actorRef: auth.cloudUserId,
          secondApproverRef: body?.second_approver_ref
        },
        nowMs
      );
      return { status: 200, code: "ADMIN_ORDER_REFUNDED", data: order };
    }
  );

  register(
    "GET",
    "/api/v1/admin/audit-events",
    "listAdminAuditEvents",
    "bearer_rbac",
    async ({ auth }) => {
      store.requireRole(auth, [
        "PLATFORM_OWNER",
        "OPERATIONS_ADMIN",
        "SECURITY_AUDITOR"
      ]);
      return {
        status: 200,
        code: "ADMIN_AUDIT_EVENTS_LISTED",
        data: { events: redactSensitiveFields(store.auditEvents) }
      };
    }
  );

  // --- 67..88 Standardized BFF, Sync, Live Library & Cloud-Controlled Campus Content Operations ---
  register("GET", "/api/v1/auth/web/start", "startWebOidcRedirect", "public", async ({ query, nowMs }) => {
    const rawReturnTo = query.get("return_to") || "/";
    const requestedFlow = String(query.get("flow") || "").trim().toLowerCase();
    const isConsoleTarget =
      requestedFlow === "console" ||
      rawReturnTo === "/console" ||
      rawReturnTo.startsWith("/console/");
    const webTxn = identity.startWebTransaction(
      {
        returnTo: rawReturnTo,
        flowKind: isConsoleTarget ? "WEB_CONSOLE" : "WEB_PORTAL"
      },
      nowMs
    );
    return {
      status: 302,
      headers: { Location: webTxn.redirect_url },
      code: "WEB_OIDC_REDIRECT",
      data: webTxn
    };
  });

  register("GET", "/api/v1/auth/web/logout", "logoutWebSession", "public", async ({ headers, nowMs }) => {
    const cookieAuth = identity.verifyWebSessionCookie(headers?.cookie || headers?.Cookie || "", nowMs);
    if (cookieAuth?.cloudUserId) {
      identity.revokeAllUserSessions(cookieAuth.cloudUserId, "WEB_USER_LOGOUT", nowMs);
    }
    return {
      status: 302,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "dis_web_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        Location: "/"
      },
      rawBody: "",
      code: "WEB_LOGGED_OUT",
      data: { logged_out: true }
    };
  });

  register(
    "POST",
    "/api/v1/auth/web/exchange",
    "exchangeWebAuthTicket",
    "single_use_ticket",
    async ({ body, nowMs }) => {
      const sessionRes = identity.exchangeWebTicket(
        {
          loginTxn: body?.login_txn,
          webTicket: body?.web_ticket
        },
        nowMs
      );
      await syncUserToSso(sessionRes.cloud_user_id);
      const cookieVal = identity.signWebSessionCookie({
        cloudUserId: sessionRes.cloud_user_id,
        accessToken: sessionRes.access_token,
        refreshToken: sessionRes.refresh_token
      });
      return {
        status: 200,
        headers: {
          "set-cookie": `dis_web_session=${encodeURIComponent(
            cookieVal
          )}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
        },
        code: "WEB_SESSION_ISSUED",
        data: sessionRes
      };
    }
  );

  register("GET", "/api/v1/auth/mobile/status", "getMobileAuthTransactionStatus", "login_txn", async ({ query, nowMs }) => {
    const statusRes = identity.getMobileTransactionStatus(query.get("txn"), nowMs);
    return {
      status: 200,
      code: "AUTH_TXN_STATUS",
      data: statusRes
    };
  });

  register(
    "POST",
    "/api/v1/auth/oidc/native-login",
    "loginNativeWithSso",
    "anonymous_rate_limited",
    async ({ body, nowMs }) => {
      const nativeRes = await identity.loginNativeWithSso(
        {
          identifier: body?.identifier ?? body?.username ?? body?.email,
          password: body?.password,
          totpCode: body?.totp_code ?? body?.totpCode ?? body?.code,
          installEphemeralId: body?.install_ephemeral_id,
          deviceLabel: body?.device_label
        },
        nowMs
      );
      if (nativeRes.totp_required && !nativeRes.ok) {
        return {
          status: 200,
          code: "TOTP_REQUIRED",
          data: nativeRes
        };
      }
      await syncUserToSso(nativeRes.session.cloud_user_id);
      return {
        status: 200,
        code: "SESSION_ISSUED",
        data: nativeRes.session
      };
    }
  );

  register("GET", "/api/v1/sync/snapshot", "getUserSyncSnapshot", "bearer", async ({ auth }) => {
    const snapshot = await buildUserSyncSnapshot(auth.cloudUserId);
    return {
      status: 200,
      code: "SYNC_SNAPSHOT_OK",
      data: snapshot
    };
  });

  register("POST", "/api/v1/sync/snapshot", "pushUserSyncSnapshot", "bearer", async ({ auth, body, nowMs }) => {
    if (body && typeof body === "object") {
      const serverAuthVersion = Number(store.users.get(auth.cloudUserId)?.auth_version || 1);
      const hasHistoricalRevocationOrWithdrawal =
        serverAuthVersion > 1 ||
        store
          .recordsForUser("schoolBindings", auth.cloudUserId)
          .some((b) => Boolean(b.revoked_at) || b.status === "REVOKED") ||
        store.recordsForUser("consents", auth.cloudUserId).some((c) => Boolean(c.withdrawn_at));

      if (
        body.auth_version !== undefined &&
        body.auth_version !== null &&
        Number(body.auth_version) !== serverAuthVersion
      ) {
        throw new ContractError(
          "CONFLICT",
          "Snapshot auth_version does not match current server authorization version"
        );
      }

      // Phase 1: Full pre-validation of all binding upserts and plan upserts BEFORE any state mutation
      const validatedBindingUpserts = [];
      if (Array.isArray(body.school_binding_upserts)) {
        for (const bItem of body.school_binding_upserts) {
          const studentNo = String(bItem?.student_no || "").trim();
          if (!studentNo) continue;
          const schoolId = bItem?.school_id || DEFAULT_SCHOOL_ID;
          if (!store.schoolIntegrations.has(schoolId)) {
            throw new ContractError("NOT_FOUND", `Unsupported school_id: ${schoolId}`);
          }
          let cleanSecretText = null;
          if (bItem?.delegated_secret && String(bItem.delegated_secret).trim()) {
            cleanSecretText = String(bItem.delegated_secret).trim();
            if (cleanSecretText.startsWith("{")) {
              let parsedSecret;
              try {
                parsedSecret = JSON.parse(cleanSecretText);
              } catch {
                throw new ContractError("BAD_REQUEST", "Malformed delegated_secret JSON");
              }
              const secretSno = String(
                parsedSecret?.student_no || parsedSecret?.studentId || parsedSecret?.userNo || ""
              ).trim();
              if (secretSno && secretSno !== studentNo) {
                throw new ContractError(
                  "FORBIDDEN",
                  "delegated_secret student_no does not match school_binding_upserts student_no"
                );
              }
            }
            if (typeof schoolProvider?.parseCredentialBundle === "function") {
              schoolProvider.parseCredentialBundle(cleanSecretText, { student_no: studentNo });
            }
          }

          const reqBindId = String(
            bItem?.binding_id ||
              bItem?.school_binding_id ||
              bItem?.id ||
              body?.school_binding_id ||
              body?.binding_id ||
              ""
          ).trim();
          const reqConsentId = String(bItem?.consent_id || body?.consent_id || "").trim();
          const reqAuthVer = bItem?.auth_version ?? body?.auth_version ?? null;

          if (reqAuthVer !== null && Number(reqAuthVer) !== serverAuthVersion) {
            throw new ContractError("CONFLICT", "Stale school_binding_upserts auth_version");
          }

          const allBindingsForStudent = store
            .recordsForUser("schoolBindings", auth.cloudUserId)
            .filter(
              (b) =>
                b.school_id === schoolId &&
                String(b.student_no || "").trim() === studentNo
            );
          const sameStudentBindings = allBindingsForStudent.filter(
            (b) => !b.revoked_at && b.status !== "REVOKED"
          );
          const isBindingCurrentlyRevoked =
            allBindingsForStudent.length > 0 && sameStudentBindings.length === 0;

          const userConsentsForSchool = store
            .recordsForUser("consents", auth.cloudUserId)
            .filter((c) => (c.school_id || DEFAULT_SCHOOL_ID) === schoolId);
          const activeConsentsForSchool = userConsentsForSchool.filter((c) => !c.withdrawn_at);
          const isConsentCurrentlyWithdrawn =
            userConsentsForSchool.length > 0 && activeConsentsForSchool.length === 0;

          if (reqBindId) {
            const bObj = store.schoolBindings.get(reqBindId);
            if (
              !bObj ||
              bObj.cloud_user_id !== auth.cloudUserId ||
              bObj.school_id !== schoolId ||
              String(bObj.student_no || "").trim() !== studentNo
            ) {
              throw new ContractError("FORBIDDEN", "Invalid or mismatched binding_id in school_binding_upserts");
            }
            if (
              bObj.revoked_at ||
              bObj.status === "REVOKED" ||
              Number(bObj.auth_version || 1) !== serverAuthVersion
            ) {
              throw new ContractError("CONFLICT", "Revoked or stale binding_id in school_binding_upserts");
            }
          }

          if (reqConsentId) {
            const cObj = store.consents.get(reqConsentId);
            if (
              !cObj ||
              cObj.cloud_user_id !== auth.cloudUserId ||
              (cObj.school_id || DEFAULT_SCHOOL_ID) !== schoolId
            ) {
              throw new ContractError("FORBIDDEN", "Invalid or mismatched consent_id in school_binding_upserts");
            }
            if (cObj.withdrawn_at || Number(cObj.auth_version || 1) !== serverAuthVersion) {
              throw new ContractError("CONFLICT", "Withdrawn or stale consent_id in school_binding_upserts");
            }
          }

          if (reqBindId && reqConsentId) {
            const bObj = store.schoolBindings.get(reqBindId);
            if (bObj.consent_id && bObj.consent_id !== reqConsentId) {
              throw new ContractError(
                "CONFLICT",
                "binding_id and consent_id in school_binding_upserts do not correspond"
              );
            }
          }

          // When the account has undergone revocation/reauthorization (hasHistoricalRevocationOrWithdrawal)
          // and is currently reauthorized (active), any binding upsert MUST carry the current generation
          // binding_id and consent_id (and correspond to each other) so a pre-revocation snapshot cannot overwrite credentials!
          if (
            hasHistoricalRevocationOrWithdrawal &&
            !isBindingCurrentlyRevoked &&
            !isConsentCurrentlyWithdrawn
          ) {
            if (
              !reqBindId ||
              !reqConsentId ||
              reqAuthVer === null ||
              reqAuthVer === undefined ||
              Number(reqAuthVer) !== serverAuthVersion
            ) {
              throw new ContractError(
                "CONFLICT",
                "Stale snapshot rejected: explicit auth_version, binding_id, and consent_id for the current authorization generation are required"
              );
            }
            const bObj = store.schoolBindings.get(reqBindId);
            const cObj = store.consents.get(reqConsentId);
            if (
              !bObj ||
              !cObj ||
              Number(bObj.auth_version || 1) !== serverAuthVersion ||
              Number(cObj.auth_version || 1) !== serverAuthVersion ||
              (bObj.consent_id && bObj.consent_id !== cObj.id)
            ) {
              throw new ContractError(
                "CONFLICT",
                "Stale snapshot rejected: binding_id and consent_id do not match current authorization generation"
              );
            }
          }

          validatedBindingUpserts.push({
            studentNo,
            schoolId,
            cleanSecretText,
            reqBindId: reqBindId || null,
            reqConsentId: reqConsentId || null,
            isBindingCurrentlyRevoked,
            isConsentCurrentlyWithdrawn
          });
        }
      }

      const validatedPlanUpserts = [];
      if (Array.isArray(body.reservation_plan_upserts)) {
        for (const rpItem of body.reservation_plan_upserts) {
          const targetDate = String(rpItem?.target_local_date || "").trim();
          const targetTime = String(rpItem?.target_local_time || "07:00:00").trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) continue;

          const rpBindId = String(
            rpItem?.school_binding_id ||
              rpItem?.binding_id ||
              body?.school_binding_id ||
              body?.binding_id ||
              ""
          ).trim();
          const rpConsentId = String(rpItem?.consent_id || body?.consent_id || "").trim();
          const rpAuthVer = rpItem?.auth_version ?? body?.auth_version ?? null;

          if (rpAuthVer !== null && Number(rpAuthVer) !== serverAuthVersion) {
            throw new ContractError("CONFLICT", "Stale reservation_plan_upserts auth_version");
          }

          if (rpBindId) {
            const bObj = store.schoolBindings.get(rpBindId);
            if (!bObj || bObj.cloud_user_id !== auth.cloudUserId) {
              throw new ContractError("FORBIDDEN", "Invalid school_binding_id in reservation_plan_upserts");
            }
            if (
              bObj.revoked_at ||
              bObj.status !== "DELEGATED_ACTIVE" ||
              Number(bObj.auth_version || 1) !== serverAuthVersion
            ) {
              throw new ContractError("CONFLICT", "Revoked or stale school_binding_id in reservation_plan_upserts");
            }
          }

          if (rpConsentId) {
            const cObj = store.consents.get(rpConsentId);
            if (!cObj || cObj.cloud_user_id !== auth.cloudUserId) {
              throw new ContractError("FORBIDDEN", "Invalid consent_id in reservation_plan_upserts");
            }
            if (cObj.withdrawn_at || Number(cObj.auth_version || 1) !== serverAuthVersion) {
              throw new ContractError("CONFLICT", "Withdrawn or stale consent_id in reservation_plan_upserts");
            }
          }

          if (rpBindId && rpConsentId) {
            const bObj = store.schoolBindings.get(rpBindId);
            const cObj = store.consents.get(rpConsentId);
            if (
              bObj.school_id !== (cObj.school_id || DEFAULT_SCHOOL_ID) ||
              (bObj.consent_id && bObj.consent_id !== cObj.id)
            ) {
              throw new ContractError(
                "CONFLICT",
                "school_binding_id and consent_id in reservation_plan_upserts do not correspond"
              );
            }
          }

          if (hasHistoricalRevocationOrWithdrawal) {
            const hasAnyActiveBind = store
              .recordsForUser("schoolBindings", auth.cloudUserId)
              .some((b) => !b.revoked_at && b.status !== "REVOKED");
            const hasAnyActiveConsent = store
              .recordsForUser("consents", auth.cloudUserId)
              .some((c) => !c.withdrawn_at);
            if (hasAnyActiveBind && hasAnyActiveConsent) {
              if (
                !rpBindId ||
                !rpConsentId ||
                rpAuthVer === null ||
                rpAuthVer === undefined ||
                Number(rpAuthVer) !== serverAuthVersion
              ) {
                throw new ContractError(
                  "CONFLICT",
                  "Stale reservation_plan_upserts rejected: explicit auth_version, school_binding_id, and consent_id for current authorization generation are required"
                );
              }
            }
          }

          validatedPlanUpserts.push({
            rpItem,
            targetDate,
            targetTime,
            rpBindId: rpBindId || null,
            rpConsentId: rpConsentId || null,
            rpAuthVer: rpAuthVer !== null && rpAuthVer !== undefined ? Number(rpAuthVer) : null
          });
        }
      }

      // Phase 2: Atomic state mutation
      for (const {
        studentNo,
        schoolId,
        cleanSecretText,
        reqBindId,
        reqConsentId,
        isBindingCurrentlyRevoked,
        isConsentCurrentlyWithdrawn
      } of validatedBindingUpserts) {
        if (isBindingCurrentlyRevoked || isConsentCurrentlyWithdrawn) {
          continue;
        }

        const allBindingsForStudent = store
          .recordsForUser("schoolBindings", auth.cloudUserId)
          .filter(
            (b) =>
              b.school_id === schoolId &&
              String(b.student_no || "").trim() === studentNo
          );
        const sameStudentBindings = reqBindId
          ? [store.schoolBindings.get(reqBindId)].filter(Boolean)
          : allBindingsForStudent.filter((b) => !b.revoked_at && b.status !== "REVOKED");

        const userConsentsForSchool = store
          .recordsForUser("consents", auth.cloudUserId)
          .filter((c) => (c.school_id || DEFAULT_SCHOOL_ID) === schoolId);
        const activeConsentsForSchool = userConsentsForSchool.filter((c) => !c.withdrawn_at);
        let activeConsentForBind = reqConsentId
          ? store.consents.get(reqConsentId)
          : activeConsentsForSchool[activeConsentsForSchool.length - 1] || null;

        if (!activeConsentForBind && userConsentsForSchool.length === 0) {
          const cid = crypto.randomUUID();
          activeConsentForBind = {
            id: cid,
            cloud_user_id: auth.cloudUserId,
            school_id: schoolId,
            scope_list: ["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"],
            policy_version: "policy-2026-11-v4",
            auth_version: serverAuthVersion,
            granted_at: new Date(nowMs).toISOString(),
            withdrawn_at: null
          };
          store.indexUserScoped?.("consents", cid, auth.cloudUserId);
          store.consents.set(cid, activeConsentForBind);
        }

        if (sameStudentBindings.length === 0) {
          const bindingId = crypto.randomUUID();
          const createdBind = {
            id: bindingId,
            cloud_user_id: auth.cloudUserId,
            school_id: schoolId,
            student_no: studentNo,
            student_no_masked:
              studentNo.length >= 4 ? `${studentNo.slice(0, 2)}***${studentNo.slice(-2)}` : "***",
            status: "DELEGATED_ACTIVE",
            credential_ref: null,
            credential_expires_at: new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString(),
            consent_id: activeConsentForBind?.id || null,
            auth_version: serverAuthVersion,
            created_at: new Date(nowMs).toISOString(),
            revoked_at: null
          };
          store.schoolBindings.set(bindingId, createdBind);
          store.indexUserScoped?.("schoolBindings", bindingId, createdBind.cloud_user_id);
          sameStudentBindings.push(createdBind);
        } else {
          for (const targetBind of sameStudentBindings) {
            targetBind.status = "DELEGATED_ACTIVE";
            targetBind.auth_version = serverAuthVersion;
            if (activeConsentForBind && !targetBind.consent_id) {
              targetBind.consent_id = activeConsentForBind.id;
            }
          }
        }

        if (cleanSecretText) {
          for (const targetBind of sameStudentBindings) {
            const encrypted = kmsVault.encryptSecret({
              bindingId: targetBind.id,
              schoolId,
              credentialKind: "DELEGATED_SESSION_BUNDLE",
              plaintext: cleanSecretText,
              expiresAt: new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString()
            });
            store.encryptedCredentials.set(encrypted.id, encrypted);
            targetBind.credential_ref = encrypted.id;
            targetBind.credential_expires_at = encrypted.expires_at;
            targetBind.status = "DELEGATED_ACTIVE";
            targetBind.auth_version = serverAuthVersion;
          }
        }
        const syncUserObj = store.users.get(auth.cloudUserId);
        if (syncUserObj) {
          syncUserObj._latestBindStartSeq = Number(syncUserObj._latestBindStartSeq || 0) + 1;
          syncUserObj._lastBindCommitSeq = Number(syncUserObj._lastBindCommitSeq || 0) + 1;
        }
      }

      if (Array.isArray(body.parcel_upserts)) {
        for (const pItem of body.parcel_upserts) {
          if (!pItem || !pItem.tracking_number) continue;
          parcelHub.upsertParcel({
            cloudUserId: auth.cloudUserId,
            trackingNumber: pItem.tracking_number,
            carrierCode: pItem.carrier_code || "cainiao",
            carrierName: pItem.carrier_name || "校园快递",
            providerId: pItem.provider_id || "parcel.manual",
            channel: pItem.channel || "CLIENT_IMPORT",
            status: pItem.status || (pItem.pickup_code ? "READY_FOR_PICKUP" : "IN_TRANSIT"),
            pickupCode: pItem.pickup_code || "",
            stationName: pItem.station_name || "",
            itemTitle: pItem.item_title || "",
            rawNotificationText: pItem.raw_notification_text || "",
            checkpoints: Array.isArray(pItem.checkpoints) ? pItem.checkpoints : [],
            sandboxOverride: false
          });
        }
      }

      if (Array.isArray(body.parcel_status_updates)) {
        const userParcels = parcelHub.listUserParcels(auth.cloudUserId);
        for (const uItem of body.parcel_status_updates) {
          const target = userParcels.find(
            (p) =>
              (uItem.parcel_id && p.id === uItem.parcel_id) ||
              (uItem.tracking_number && p.tracking_number === uItem.tracking_number)
          );
          if (target && uItem.status) {
            target.status = uItem.status;
          }
        }
      }

      if (Array.isArray(body.reservation_cancellations)) {
        for (const cancelId of body.reservation_cancellations) {
          const job = store.reservationJobs.get(cancelId);
          if (job && job.cloud_user_id === auth.cloudUserId) {
            reservationEngine.stopPlanAndActiveJobs({
              planId: job.plan_id,
              jobId: job.id,
              cloudUserId: auth.cloudUserId,
              reason: "客户端同步停止任务委托",
              nowMs
            });
          }
          const plan = store.reservationPlans.get(cancelId);
          if (plan && plan.cloud_user_id === auth.cloudUserId) {
            reservationEngine.stopPlanAndActiveJobs({
              planId: plan.id,
              cloudUserId: auth.cloudUserId,
              reason: "客户端同步停止预约计划委托",
              nowMs
            });
          }
        }
      }

      const bindingResults = [];
      for (const bItem of validatedBindingUpserts) {
        if (bItem.isBindingCurrentlyRevoked || bItem.isConsentCurrentlyWithdrawn) {
          bindingResults.push({
            student_no: bItem.studentNo,
            school_id: bItem.schoolId,
            binding_id: bItem.reqBindId || null,
            status: "SKIPPED_REVOKED",
            reason: "学校绑定或委托授权已处于撤销状态，需重新完成在线授权后方可同步凭据"
          });
        } else {
          bindingResults.push({
            student_no: bItem.studentNo,
            school_id: bItem.schoolId,
            binding_id: bItem.reqBindId || null,
            status: "APPLIED",
            reason: null
          });
        }
      }

      const planResults = [];
      if (validatedPlanUpserts.length > 0) {
        const allUserBindings = store.recordsForUser("schoolBindings", auth.cloudUserId);
        const userActiveBindings = allUserBindings.filter(
          (b) =>
            !b.revoked_at &&
            b.status === "DELEGATED_ACTIVE" &&
            Number(b.auth_version || 1) === serverAuthVersion
        );
        const distinctStudentNos = new Set(
          userActiveBindings.map((b) => String(b.student_no || "").trim()).filter(Boolean)
        );
        const defaultActiveBinding =
          distinctStudentNos.size <= 1 ? userActiveBindings[userActiveBindings.length - 1] || null : null;

        for (const { rpItem, targetDate, targetTime, rpBindId, rpConsentId, rpAuthVer } of validatedPlanUpserts) {
          if (!rpBindId || !rpConsentId || rpAuthVer === null || rpAuthVer !== serverAuthVersion) {
            planResults.push({
              target_local_date: targetDate,
              target_local_time: targetTime,
              binding_id: rpBindId || null,
              status: "NEEDS_RECONFIRMATION",
              reason: "预约计划缺少显式绑定的 school_binding_id、consent_id 或 auth_version，拒绝猜测当前授权，需重新确认授权"
            });
            continue;
          }
          const activeBinding = store.schoolBindings.get(rpBindId);
          if (
            !activeBinding ||
            activeBinding.revoked_at ||
            activeBinding.status !== "DELEGATED_ACTIVE" ||
            Number(activeBinding.auth_version || 0) !== serverAuthVersion
          ) {
            planResults.push({
              target_local_date: targetDate,
              target_local_time: targetTime,
              binding_id: rpBindId || null,
              status: "NEEDS_RECONFIRMATION",
              reason: "缺少当前有效学校绑定或绑定授权版本不匹配，需重新确认授权"
            });
            continue;
          }
          const activeConsent = store.consents.get(rpConsentId);

          if (
            !activeConsent ||
            activeConsent.withdrawn_at ||
            Number(activeConsent.auth_version || 0) !== serverAuthVersion ||
            (activeBinding.consent_id && activeBinding.consent_id !== activeConsent.id)
          ) {
            planResults.push({
              target_local_date: targetDate,
              target_local_time: targetTime,
              binding_id: activeBinding.id,
              status: "NEEDS_RECONFIRMATION",
              reason: "委托同意记录已撤回或与当前授权版本不一致，需重新确认授权"
            });
            continue;
          }

          const alreadyActive = Array.from(store.reservationJobs.values()).some(
            (j) =>
              j.cloud_user_id === auth.cloudUserId &&
              j.school_binding_id === activeBinding.id &&
              j.booking_local_date === targetDate &&
              !["CANCELLED", "FAILED", "EXPIRED", "REVOKED", "SCHOOL_CANCELLED", "SKIPPED_FINANCE", "SKIPPED_AUTH"].includes(j.state)
          );
          if (alreadyActive) {
            planResults.push({
              target_local_date: targetDate,
              target_local_time: targetTime,
              binding_id: activeBinding.id,
              status: "ALREADY_ACTIVE",
              reason: null
            });
            continue;
          }
          const areaName = String(rpItem?.area_name || rpItem?.area_code || "五层中区").trim();
          const seats = Array.isArray(rpItem?.candidate_seats)
            ? rpItem.candidate_seats.map((s) => String(s).trim()).filter(Boolean)
            : ["01桌 B座"];
          const repeatDays = Math.min(Math.max(Number(rpItem?.repeat_days ?? 1) || 1, 1), 30);
          const remainingDays = Math.min(
            Math.max(Number(rpItem?.remaining_days ?? repeatDays) || repeatDays, 1),
            repeatDays
          );
          try {
            const created = reservationEngine.createPlanAndJob(
              auth.cloudUserId,
              {
                school_binding_id: activeBinding.id,
                consent_id: activeConsent.id,
                area_code: areaName,
                area_name: areaName,
                candidate_seats: seats,
                preferred_area_ids: [areaName],
                preferred_seat_ids: seats,
                target_local_date: targetDate,
                target_local_time: targetTime,
                slot_window: rpItem?.slot_window || undefined,
                repeat_days: repeatDays,
                remaining_days: remainingDays,
                allow_alternative_seat: rpItem?.allow_alternative_seat === true,
                replace_existing: false
              },
              nowMs
            );
            planResults.push({
              target_local_date: targetDate,
              target_local_time: targetTime,
              binding_id: activeBinding.id,
              plan_id: created.plan_id,
              job_id: created.job_id,
              status: "CREATED",
              reason: null
            });
          } catch (createErr) {
            planResults.push({
              target_local_date: targetDate,
              target_local_time: targetTime,
              binding_id: activeBinding.id,
              status: "SKIPPED_WINDOW_CLOSED",
              reason: createErr?.message || "预约时间窗口已关闭或参数不合法"
            });
          }
        }
      }

      body._computedSyncReport = {
        auth_version: serverAuthVersion,
        binding_results: bindingResults,
        plan_results: planResults
      };

      await syncUserToSso(auth.cloudUserId);
    }

    const snapshot = await buildUserSyncSnapshot(auth.cloudUserId);
    const serverNeedsReconfirmPlans = (snapshot.reservation_plans || []).filter(
      (p) => p.user_intent_state === "NEEDS_RECONFIRMATION"
    );
    const bindingResults = body?._computedSyncReport?.binding_results || [];
    const planResults = body?._computedSyncReport?.plan_results || [];
    const skippedBindings = bindingResults.filter((r) => r.status !== "APPLIED");
    const skippedPlans = planResults.filter(
      (r) => r.status !== "CREATED" && r.status !== "ALREADY_ACTIVE"
    );
    const skippedCount = skippedBindings.length + skippedPlans.length;
    const reconfirmCount =
      serverNeedsReconfirmPlans.length +
      planResults.filter((r) => r.status === "NEEDS_RECONFIRMATION").length;
    snapshot.sync_report = {
      auth_version: snapshot.auth_version,
      binding_results: bindingResults,
      plan_results: planResults,
      skipped_count: skippedCount,
      plans_needing_reconfirmation_count: reconfirmCount,
      summary_message:
        reconfirmCount > 0 || skippedCount > 0
          ? `余额已更新，${reconfirmCount || skippedCount} 项预约计划或绑定需要重新确认授权`
          : "云端数据已完整同步"
    };
    return {
      status: 200,
      code: "SYNC_SNAPSHOT_OK",
      data: snapshot
    };
  });

  register(
    "POST",
    "/api/v1/admin/orders/{orderId}/quick-refund",
    "quickRefundAdminOrder",
    "bearer_admin",
    async ({ auth, params, body, nowMs }) => {
      const isAdminUser =
        auth.roles.includes("ADMIN") ||
        auth.roles.includes("PLATFORM_OWNER") ||
        auth.roles.includes("FINANCE") ||
        auth.roles.includes("FINANCE_OPERATOR") ||
        store.users.get(auth.cloudUserId)?.role === "admin";
      if (!isAdminUser) {
        throw new ContractError("FORBIDDEN", "Admin privileges required for quick refund");
      }
      const orderId = params.orderId;
      const targetOrder = store.reservationOrders.get(orderId);
      if (!targetOrder) {
        throw new ContractError("NOT_FOUND", "Order not found");
      }
      const secondApproverRef =
        typeof body?.second_approver_ref === "string" ? body.second_approver_ref.trim() : "";
      if (!secondApproverRef) {
        throw new ContractError(
          "BAD_REQUEST",
          "second_approver_ref is required; dual-person approval cannot be synthesized"
        );
      }
      const order = await financeService.issueRefundForOrder(
        orderId,
        {
          amountMicropeach:
            targetOrder.price_micropeach ||
            store.pricingMicropeach ||
            DEFAULT_RESERVATION_PRICE_MICROPEACH,
          reason: body?.reason || "站点管理员在后台发起 🍑 退还",
          actorRef: auth.cloudUserId,
          secondApproverRef
        },
        nowMs
      );
      await syncUserToSso(order.cloud_user_id);
      return {
        status: 200,
        code: "ADMIN_ORDER_REFUNDED",
        data: order
      };
    }
  );

  register(
    "POST",
    "/api/v1/reservation-jobs/{jobId}/execute-now",
    "executeReservationJobNow",
    "bearer",
    async ({ auth, params, nowMs }) => {
      const jobId = params.jobId;
      const job = store.reservationJobs.get(jobId);
      if (!job || job.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "Reservation job not found");
      }
      if (
        [
          "CONFIRMED",
          "DELEGATION_STOPPED_SCHOOL_CONFIRMED",
          "SCHOOL_CANCELLED",
          "CANCEL_RESULT_UNKNOWN",
          "CANCELLED",
          "REVOKED",
          "EXPIRED",
          "SKIPPED_FINANCE",
          "SKIPPED_AUTH"
        ].includes(job.state)
      ) {
        const schoolReservation = store.schoolReservations.get(job.id) || null;
        return {
          status: 200,
          code: "RESERVATION_JOB_EXECUTED",
          data: { job, schoolReservation }
        };
      }
      const isAlreadyDispatchedOrUnknown =
        job.state === "RESULT_UNKNOWN" ||
        job.external_execution_state === "RESULT_UNKNOWN" ||
        job.external_execution_state === "DISPATCH_INTENT" ||
        Number(job.attempt_count || 0) >= 1;
      if (!isAlreadyDispatchedOrUnknown) {
        const preRes = await reservationEngine.runScheduleEvent(jobId, "PRECHECK", nowMs);
        if (
          preRes?.job &&
          ["SKIPPED_FINANCE", "SKIPPED_AUTH", "CANCELLED", "REVOKED"].includes(preRes.job.state)
        ) {
          if (preRes.job.state === "SKIPPED_FINANCE") {
            preRes.job.last_error_message =
              "当前 XPeach 账户余额不足（云端抢座成功需 1 🍑），请先补充余额后再执行";
          } else if (preRes.job.state === "SKIPPED_AUTH") {
            preRes.job.last_error_message = "校园学号登录凭据已失效，请重新验证绑定学号";
          }
          return {
            status: 200,
            code: "RESERVATION_JOB_EXECUTED",
            data: preRes
          };
        }
        const finalRes = await reservationEngine.runScheduleEvent(jobId, "FINAL_CHECK", nowMs);
        if (
          finalRes?.job &&
          ["SKIPPED_FINANCE", "SKIPPED_AUTH", "CANCELLED", "REVOKED"].includes(finalRes.job.state)
        ) {
          if (finalRes.job.state === "SKIPPED_AUTH") {
            finalRes.job.last_error_message = "校园学号登录凭据已失效，请重新验证绑定学号";
          }
          return {
            status: 200,
            code: "RESERVATION_JOB_EXECUTED",
            data: finalRes
          };
        }
      }
      const fireRes = await reservationEngine.runScheduleEvent(jobId, "FIRE", nowMs, {
        allowDateFallbackToToday: false,
        manualExecuteNow: true
      });
      await syncUserToSso(auth.cloudUserId);
      return {
        status: 200,
        code: "RESERVATION_JOB_EXECUTED",
        data: fireRes
      };
    }
  );

  register(
    "POST",
    "/api/v1/reservation-jobs/{jobId}/cancel-seat",
    "cancelConfirmedReservationSeat",
    "bearer",
    async ({ auth, params, nowMs }) => {
      const jobId = params.jobId;
      const job = store.reservationJobs.get(jobId);
      if (!job || job.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "Reservation job not found");
      }
      const cancelRes = await reservationEngine.cancelConfirmedOrActiveJob(jobId, nowMs);
      await syncUserToSso(auth.cloudUserId);
      return {
        status: 200,
        code: "RESERVATION_SEAT_CANCELLED",
        data: cancelRes
      };
    }
  );

  register(
    "POST",
    "/api/v1/school-bindings/bind-live",
    "bindLiveSchoolAccount",
    "bearer",
    async ({ auth, headers, body, nowMs }) => {
      const schoolId = body?.school_id || DEFAULT_SCHOOL_ID;
      const studentNoInput = String(body?.student_no || "").trim();
      const passwordInput = String(body?.password || "").trim();
      const rawTokenInput = String(body?.raw_token || "").trim();
      const casTgcInput = String(body?.cas_tgc || "").trim();

      const entryUser = store.users.get(auth.cloudUserId);
      if (!entryUser || entryUser.status !== "ACTIVE") {
        throw new ContractError(
          "CLOUD_AUTH_REQUIRED",
          "Cloud user account is inactive or deleted"
        );
      }
      if (body?.consent_id) {
        const reqConsent = store.consents.get(String(body.consent_id).trim());
        if (!reqConsent || reqConsent.cloud_user_id !== auth.cloudUserId || reqConsent.withdrawn_at) {
          throw new ContractError("CONSENT_WITHDRAWN", "Specified consent is missing or withdrawn");
        }
      }
      if (body?.binding_id || body?.school_binding_id) {
        const reqBindId = String(body.binding_id || body.school_binding_id).trim();
        const reqBind = store.schoolBindings.get(reqBindId);
        if (
          !reqBind ||
          reqBind.cloud_user_id !== auth.cloudUserId ||
          reqBind.revoked_at ||
          reqBind.status === "REVOKED"
        ) {
          throw new ContractError(
            "CONSENT_WITHDRAWN",
            "Specified school binding is missing or revoked"
          );
        }
      }

      const entryAuthVersion = Number(entryUser.auth_version || 1);
      const entryRevocationSeq = Number(entryUser._lastRevocationSeq || 0);
      const entryBindCommitSeq = Number(entryUser._lastBindCommitSeq || 0);
      const requestBindStartSeq = (entryUser._latestBindStartSeq =
        Number(entryUser._latestBindStartSeq || 0) + 1);
      const entryActiveBindingIds = new Set(
        store
          .recordsForUser("schoolBindings", auth.cloudUserId)
          .filter((b) => b.school_id === schoolId && !b.revoked_at && b.status !== "REVOKED")
          .map((b) => b.id)
      );
      const entryActiveConsentIds = new Set(
        store
          .recordsForUser("consents", auth.cloudUserId)
          .filter((c) => (c.school_id || DEFAULT_SCHOOL_ID) === schoolId && !c.withdrawn_at)
          .map((c) => c.id)
      );

      const authRes = await schoolProvider.authenticateHautSession({
        raw_token: rawTokenInput,
        cas_tgc: casTgcInput,
        cas_jsessionid: "",
        student_no: studentNoInput,
        password: passwordInput,
        isLiveCredential: true
      });

      // Re-verify session and account liveness after async school authentication (rejects if logged out or deleted in flight)
      extractBearer(headers, nowMs, "POST");

      const userRecord = store.users.get(auth.cloudUserId);
      if (!userRecord || userRecord.status !== "ACTIVE") {
        throw new ContractError(
          "CLOUD_AUTH_REQUIRED",
          "Cloud user account is inactive or deleted"
        );
      }

      const anyEntryConsentWithdrawn = Array.from(entryActiveConsentIds).some((cid) => {
        const c = store.consents.get(cid);
        return !c || Boolean(c.withdrawn_at);
      });
      const anyEntryBindingRevoked = Array.from(entryActiveBindingIds).some((bid) => {
        const b = store.schoolBindings.get(bid);
        return !b || Boolean(b.revoked_at) || b.status === "REVOKED";
      });
      if (
        Number(userRecord._lastRevocationSeq || 0) !== entryRevocationSeq ||
        anyEntryConsentWithdrawn ||
        anyEntryBindingRevoked
      ) {
        throw new ContractError(
          "CONSENT_WITHDRAWN",
          "学校鉴权等待期间授权同意或学校绑定已被撤回，已拒绝旧绑定请求恢复权限"
        );
      }

      if (
        Number(userRecord.auth_version || 1) !== entryAuthVersion ||
        Number(userRecord._latestBindStartSeq || 0) !== requestBindStartSeq ||
        Number(userRecord._lastBindCommitSeq || 0) !== entryBindCommitSeq
      ) {
        throw new ContractError(
          "CONFLICT",
          "学校鉴权等待期间授权世代已变更或已有更新的绑定请求，已拒绝旧绑定请求覆盖当前状态"
        );
      }

      const resolvedStudentNo = String(authRes.userInfo?.userNo || studentNoInput || "20240001").trim();

      // Strictly forbid in-place mutation of binding.student_no!
      // Any active binding for this school belonging to a DIFFERENT student_no MUST be revoked first (bumping auth_version & halting old plans while preserving confirmed/unknown evidence).
      for (const activeBind of store.recordsForUser("schoolBindings", auth.cloudUserId)) {
        if (
          activeBind.school_id === schoolId &&
          !activeBind.revoked_at &&
          activeBind.status !== "REVOKED" &&
          String(activeBind.student_no || "").trim() !== resolvedStudentNo
        ) {
          store.revokeSchoolBindingCascade(
            auth.cloudUserId,
            activeBind.id,
            "SCHOOL_IDENTITY_REBOUND",
            nowMs
          );
        }
      }

      const currentAuthVersion = Number(userRecord?.auth_version || 1);
      const sameStudentBindings = store
        .recordsForUser("schoolBindings", auth.cloudUserId)
        .filter(
          (b) =>
            b.school_id === schoolId &&
            !b.revoked_at &&
            b.status !== "REVOKED" &&
            String(b.student_no || "").trim() === resolvedStudentNo
        );
      let binding = sameStudentBindings[sameStudentBindings.length - 1] || null;
      if (!binding) {
        const bindingId = crypto.randomUUID();
        binding = {
          id: bindingId,
          cloud_user_id: auth.cloudUserId,
          school_id: schoolId,
          student_no: resolvedStudentNo,
          student_no_masked:
            resolvedStudentNo.length >= 4
              ? `${resolvedStudentNo.slice(0, 2)}***${resolvedStudentNo.slice(-2)}`
              : "***",
          user_name: authRes.userInfo?.userName || "",
          department: authRes.userInfo?.department || "",
          status: "DELEGATED_ACTIVE",
          auth_version: currentAuthVersion,
          credential_ref: null,
          credential_expires_at: null,
          verified_at: new Date(nowMs).toISOString(),
          created_at: new Date(nowMs).toISOString(),
          revoked_at: null
        };
        store.schoolBindings.set(bindingId, binding);
        store.indexUserScoped?.("schoolBindings", bindingId, binding.cloud_user_id);
        sameStudentBindings.push(binding);
      } else {
        for (const sb of sameStudentBindings) {
          if (sb.credential_ref && store.encryptedCredentials.has(sb.credential_ref)) {
            store.encryptedCredentials.get(sb.credential_ref).revoked_at = new Date(
              nowMs
            ).toISOString();
          }
          sb.user_name = authRes.userInfo?.userName || sb.user_name || "";
          sb.department = authRes.userInfo?.department || sb.department || "";
          sb.status = "DELEGATED_ACTIVE";
          sb.auth_version = currentAuthVersion;
          sb.verified_at = new Date(nowMs).toISOString();
        }
      }

      const credBundleJson = JSON.stringify({
        student_no: resolvedStudentNo,
        password: passwordInput,
        raw_token: authRes.rawToken,
        cas_tgc: authRes.casTgc || "",
        cas_jsessionid: authRes.casJsessionId || "",
        user_name: authRes.userInfo?.userName || "",
        department: authRes.userInfo?.department || ""
      });
      const encrypted = kmsVault.encryptSecret({
        bindingId: binding.id,
        schoolId,
        credentialKind: "DELEGATED_SESSION_BUNDLE",
        plaintext: credBundleJson,
        expiresAt: new Date(nowMs + 14 * 24 * 3600 * 1000).toISOString()
      });
      store.encryptedCredentials.set(encrypted.id, encrypted);
      for (const sb of sameStudentBindings) {
        sb.credential_ref = encrypted.id;
        sb.credential_expires_at = encrypted.expires_at;
      }

      let consent = store.recordsForUser("consents", auth.cloudUserId).find(
        (c) => !c.withdrawn_at && Number(c.auth_version || 1) === currentAuthVersion
      );
      if (!consent) {
        const cid = crypto.randomUUID();
        consent = {
          id: cid,
          cloud_user_id: auth.cloudUserId,
          school_id: schoolId,
          scope_list: ["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"],
          policy_version: "policy-2026-11-v4",
          auth_version: currentAuthVersion,
          granted_at: new Date(nowMs).toISOString(),
          withdrawn_at: null
        };
        store.consents.set(cid, consent);
        store.indexUserScoped?.("consents", cid, consent.cloud_user_id);
      }
      for (const sb of sameStudentBindings) {
        sb.consent_id = consent.id;
      }
      userRecord._lastBindCommitSeq = Number(userRecord._lastBindCommitSeq || 0) + 1;
      store.flushSnapshotStrictSync?.();

      await syncUserToSso(auth.cloudUserId);
      return {
        status: 201,
        code: "SCHOOL_BINDING_LIVE_VERIFIED",
        data: {
          id: binding.id,
          consent_id: consent.id,
          student_no: binding.student_no,
          user_name: authRes.userInfo?.userName || "",
          binding,
          consent,
          user_info: authRes.userInfo
        }
      };
    }
  );

  register(
    "GET",
    "/api/v1/schools/haut/library/live-regions",
    "getHautLibraryLiveRegions",
    "bearer",
    async ({ auth, headers, query, nowMs }) => {
      const dateParam =
        query.get("booking_date") ||
        query.get("date") ||
        new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const binding = store.recordsForUser("schoolBindings", auth.cloudUserId).find(
        (b) => !b.revoked_at && b.status !== "REVOKED" && b.credential_ref
      );
      if (!binding) {
        throw new ContractError("CAMPUS_BINDING_REQUIRED", "请先绑定学号与统一认证密码");
      }
      const entryBindAuthVer = Number(binding.auth_version || 1);
      const credRecord = store.encryptedCredentials.get(binding.credential_ref);
      const permit = kmsVault.issueAccessPermit({
        taskId: `live_regions_${Date.now()}`,
        schoolId: binding.school_id,
        bindingId: binding.id,
        credentialRef: binding.credential_ref,
        ttlSeconds: 15,
        nowMs
      });
      const decrypted = kmsVault.decryptSecretWithPermit(credRecord, permit, nowMs);
      const authRes = await schoolProvider.authenticateHautSession(decrypted, binding);
      extractBearer(headers, nowMs, "GET");
      if (
        binding.revoked_at ||
        binding.status === "REVOKED" ||
        Number(binding.auth_version || 1) !== entryBindAuthVer
      ) {
        throw new ContractError("CONSENT_WITHDRAWN", "学校绑定在查询期间已撤销或变更");
      }
      const snap = await schoolProvider.fetchLiveStudyRegions(authRes.rawToken, dateParam);
      const currentBooking = await schoolProvider.fetchCurrentActiveBooking(authRes.rawToken);
      return {
        status: 200,
        code: "LIVE_REGIONS_OK",
        data: {
          ...snap,
          current_booking: currentBooking,
          user_info: authRes.userInfo
        }
      };
    }
  );

  register(
    "GET",
    "/api/v1/schools/haut/library/live-seats",
    "getHautLibraryLiveSeats",
    "bearer",
    async ({ auth, headers, query, nowMs }) => {
      const regionId = Number(query.get("region_id") || 7);
      const dateParam =
        query.get("booking_date") ||
        query.get("date") ||
        new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const binding = store.recordsForUser("schoolBindings", auth.cloudUserId).find(
        (b) => !b.revoked_at && b.status !== "REVOKED" && b.credential_ref
      );
      if (!binding) {
        throw new ContractError("CAMPUS_BINDING_REQUIRED", "请先绑定学号与统一认证密码");
      }
      const entryBindAuthVer = Number(binding.auth_version || 1);
      const credRecord = store.encryptedCredentials.get(binding.credential_ref);
      const permit = kmsVault.issueAccessPermit({
        taskId: `live_seats_${Date.now()}`,
        schoolId: binding.school_id,
        bindingId: binding.id,
        credentialRef: binding.credential_ref,
        ttlSeconds: 15,
        nowMs
      });
      const decrypted = kmsVault.decryptSecretWithPermit(credRecord, permit, nowMs);
      const authRes = await schoolProvider.authenticateHautSession(decrypted, binding);
      extractBearer(headers, nowMs, "GET");
      if (
        binding.revoked_at ||
        binding.status === "REVOKED" ||
        Number(binding.auth_version || 1) !== entryBindAuthVer
      ) {
        throw new ContractError("CONSENT_WITHDRAWN", "学校绑定在查询期间已撤销或变更");
      }
      const snap = await schoolProvider.fetchLiveRegionSeats(authRes.rawToken, regionId, dateParam);
      return {
        status: 200,
        code: "LIVE_SEATS_OK",
        data: snap
      };
    }
  );

  register("GET", "/api/v1/campus-content", "getCampusContent", "public", async ({ query }) => {
    const schoolId = query.get("school_id") || DEFAULT_SCHOOL_ID;
    const { value: content, cacheStatus } = await redisBuffer.getOrCompute(
      "campus_content",
      schoolId.toLowerCase(),
      120,
      async () => store.getCampusContent(schoolId, { includeDisabled: false })
    );
    return {
      status: 200,
      headers: {
        "cache-control": "no-store, no-cache, must-revalidate",
        "x-cache": cacheStatus
      },
      code: "CAMPUS_CONTENT_OK",
      data: content
    };
  });

  async function refreshCampusContentCache(schoolId) {
    const key = String(schoolId || DEFAULT_SCHOOL_ID).toLowerCase();
    await redisBuffer.invalidate("campus_content", key);
    const publicSnapshot = store.getCampusContent(key, { includeDisabled: false });
    await redisBuffer.setAndWarm("campus_content", key, publicSnapshot, 120);
  }

  register("GET", "/api/v1/admin/campus-content", "getAdminCampusContent", "bearer_admin", async ({ query }) => {
    const schoolId = query.get("school_id") || DEFAULT_SCHOOL_ID;
    return {
      status: 200,
      code: "ADMIN_CAMPUS_CONTENT_OK",
      data: store.getCampusContent(schoolId, { includeDisabled: true })
    };
  });

  register("PUT", "/api/v1/admin/campus-content", "updateAdminCampusContent", "bearer_admin", async ({ auth, query, body }) => {
    const schoolId = query.get("school_id") || body?.school_id || DEFAULT_SCHOOL_ID;
    const actorName = store.users.get(auth.cloudUserId)?.username || auth.cloudUserId;
    const updated = store.updateCampusContent(schoolId, body || {}, actorName);
    await refreshCampusContentCache(schoolId);
    return {
      status: 200,
      code: "CAMPUS_CONTENT_UPDATED",
      data: updated
    };
  });

  register("POST", "/api/v1/admin/campus-content/channels", "upsertAdminCampusChannel", "bearer_admin", async ({ auth, body }) => {
    const schoolId = body?.school_id || DEFAULT_SCHOOL_ID;
    const actorName = store.users.get(auth.cloudUserId)?.username || auth.cloudUserId;
    const updated = store.upsertCampusChannel(schoolId, body || {}, actorName);
    await refreshCampusContentCache(schoolId);
    return {
      status: 200,
      code: "CAMPUS_CHANNEL_UPSERTED",
      data: updated
    };
  });

  register(
    "DELETE",
    "/api/v1/admin/campus-content/channels/{channelId}",
    "deleteAdminCampusChannel",
    "bearer_admin",
    async ({ auth, params, query }) => {
      const schoolId = query.get("school_id") || DEFAULT_SCHOOL_ID;
      const actorName = store.users.get(auth.cloudUserId)?.username || auth.cloudUserId;
      const updated = store.deleteCampusChannel(schoolId, params.channelId, actorName);
      await refreshCampusContentCache(schoolId);
      return {
        status: 200,
        code: "CAMPUS_CHANNEL_DELETED",
        data: updated
      };
    }
  );

  register("POST", "/api/v1/admin/campus-content/clubs", "upsertAdminCampusClub", "bearer_admin", async ({ auth, body }) => {
    const schoolId = body?.school_id || DEFAULT_SCHOOL_ID;
    const actorName = store.users.get(auth.cloudUserId)?.username || auth.cloudUserId;
    const updated = store.upsertCampusClub(schoolId, body || {}, actorName);
    await refreshCampusContentCache(schoolId);
    return {
      status: 200,
      code: "CAMPUS_CLUB_UPSERTED",
      data: updated
    };
  });

  register(
    "DELETE",
    "/api/v1/admin/campus-content/clubs/{clubId}",
    "deleteAdminCampusClub",
    "bearer_admin",
    async ({ auth, params, query }) => {
      const schoolId = query.get("school_id") || DEFAULT_SCHOOL_ID;
      const actorName = store.users.get(auth.cloudUserId)?.username || auth.cloudUserId;
      const updated = store.deleteCampusClub(schoolId, params.clubId, actorName);
      await refreshCampusContentCache(schoolId);
      return {
        status: 200,
        code: "CAMPUS_CLUB_DELETED",
        data: updated
      };
    }
  );

  register(
    "POST",
    "/api/v1/admin/campus-content/competitions",
    "upsertAdminCampusCompetition",
    "bearer_admin",
    async ({ auth, body }) => {
      const schoolId = body?.school_id || DEFAULT_SCHOOL_ID;
      const actorName = store.users.get(auth.cloudUserId)?.username || auth.cloudUserId;
      const updated = store.upsertCampusCompetition(schoolId, body || {}, actorName);
      await refreshCampusContentCache(schoolId);
      return {
        status: 200,
        code: "CAMPUS_COMPETITION_UPSERTED",
        data: updated
      };
    }
  );

  register(
    "DELETE",
    "/api/v1/admin/campus-content/competitions/{competitionId}",
    "deleteAdminCampusCompetition",
    "bearer_admin",
    async ({ auth, params, query }) => {
      const schoolId = query.get("school_id") || DEFAULT_SCHOOL_ID;
      const actorName = store.users.get(auth.cloudUserId)?.username || auth.cloudUserId;
      const updated = store.deleteCampusCompetition(schoolId, params.competitionId, actorName);
      await refreshCampusContentCache(schoolId);
      return {
        status: 200,
        code: "CAMPUS_COMPETITION_DELETED",
        data: updated
      };
    }
  );


  // --- Campus Moments (Lost & Found Plaza, Second-Hand Textbooks, Anti-Lost QR Code Tags) ---
  function escapeClaimHtml(raw) {
    return String(raw ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function computePostMatches(targetPost, allPosts) {
    if (!targetPost) return [];
    const oppositeType = targetPost.type === "LOST" ? "FOUND" : "LOST";
    const tokens = String(targetPost.title + " " + targetPost.description + " " + targetPost.location)
      .toLowerCase()
      .split(/[\s,，。！!？?、·/]+/)
      .filter((t) => t.length >= 2);
    return (allPosts || [])
      .filter((p) => p.id !== targetPost.id && p.type === oppositeType && p.status !== "RESOLVED")
      .map((p) => {
        let score = 0;
        if (p.category === targetPost.category) score += 45;
        if (p.campus === targetPost.campus) score += 25;
        const hay = (p.title + " " + p.description + " " + p.location).toLowerCase();
        for (const tk of tokens) {
          if (hay.includes(tk)) score += 12;
        }
        return { post: p, match_score: Math.min(score, 98) };
      })
      .filter((m) => m.match_score >= 45)
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, 3);
  }

  function tryExtractOptionalViewerAuth(headers, nowMs, method = "GET") {
    try {
      const auth = extractBearer(headers, nowMs, method);
      if (!auth?.cloudUserId) return { cloudUserId: null, roles: [], isAdmin: false };
      const roles = Array.isArray(auth.roles) ? auth.roles : store.getUserRoles(auth.cloudUserId);
      const isAdmin = Boolean(
        store.hasAdminAccess?.(auth.cloudUserId) ||
          roles.some((r) => ["ADMIN", "PLATFORM_OWNER", "SUPPORT_OPERATOR"].includes(r))
      );
      return { cloudUserId: auth.cloudUserId, roles, isAdmin };
    } catch {
      return { cloudUserId: null, roles: [], isAdmin: false };
    }
  }

  function isMomentsAdminAuth(auth) {
    if (!auth?.cloudUserId) return false;
    const roles = Array.isArray(auth.roles) ? auth.roles : store.getUserRoles(auth.cloudUserId);
    return Boolean(
      store.hasAdminAccess?.(auth.cloudUserId) ||
        roles.some((r) => ["ADMIN", "PLATFORM_OWNER", "SUPPORT_OPERATOR"].includes(r))
    );
  }

  function verifyHighEntropyLegacyClaimToken(post, rawClaimToken) {
    const storedHex = String(post?.legacy_claim_token_sha256 || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(storedHex)) return false;
    const candidate = typeof rawClaimToken === "string" ? rawClaimToken.trim() : "";
    if (candidate.length < 32) return false;
    const actualDigest = crypto.createHash("sha256").update(candidate, "utf8").digest();
    const expectedDigest = Buffer.from(storedHex, "hex");
    if (actualDigest.length !== expectedDigest.length) return false;
    return crypto.timingSafeEqual(actualDigest, expectedDigest);
  }

  function verifyUniqueTrustedLegacySsoBinding(post, viewerUserId) {
    if (!viewerUserId || !post) return false;
    const expectedIssuer = String(post.legacy_verified_sso_issuer || "").trim();
    const expectedSubject = String(post.legacy_verified_sso_subject || "").trim();
    if (!expectedIssuer || !expectedSubject) return false;
    const viewerUser = store.users.get(viewerUserId);
    if (!viewerUser || viewerUser.status !== "ACTIVE") return false;
    return viewerUser.issuer === expectedIssuer && viewerUser.subject === expectedSubject;
  }

  function isPrivateMomentsComment(c) {
    return Boolean(
      c?.is_private_to_initiator ||
        String(c?.content || "").trim().startsWith("【私密联系发起人】")
    );
  }

  function projectMomentsPostForViewer(post, allPosts, viewerUserId = null, isViewerAdmin = false) {
    if (!post) return null;
    const isOwner = Boolean(
      viewerUserId && post.owner_cloud_user_id && post.owner_cloud_user_id === viewerUserId
    );
    const isLegacyUnowned = !post.owner_cloud_user_id;
    const canManage = Boolean(isOwner || isViewerAdmin);
    // Self-service legacy claim is ONLY enabled when an original high-entropy claim token digest
    // or trusted unique OIDC issuer+subject binding exists — NEVER via masked student_no or contact!
    const canClaimLegacy = Boolean(
      isLegacyUnowned &&
        viewerUserId &&
        (/^[a-f0-9]{64}$/i.test(String(post.legacy_claim_token_sha256 || "").trim()) ||
          verifyUniqueTrustedLegacySsoBinding(post, viewerUserId))
    );
    const isBlocked = Boolean(
      viewerUserId &&
        Array.isArray(post.blocked_user_ids) &&
        post.blocked_user_ids.includes(viewerUserId)
    );
    const hasApprovedRequest =
      !isBlocked &&
      Boolean(
        viewerUserId &&
          Array.isArray(post.contact_requests) &&
          post.contact_requests.some(
            (r) => r.sender_user_id === viewerUserId && r.status === "APPROVED"
          )
      );

    const sanitized = { ...post };
    delete sanitized.owner_cloud_user_id;
    delete sanitized.contact_requests;
    delete sanitized.blocked_user_ids;
    delete sanitized.legacy_claim_token_sha256;
    delete sanitized.legacy_verified_sso_issuer;
    delete sanitized.legacy_verified_sso_subject;
    if (!isViewerAdmin) {
      delete sanitized.reports_count;
    }

    if (sanitized.contact_visibility === "ON_REQUEST" && sanitized.contact) {
      if (!isOwner && !(isViewerAdmin && isLegacyUnowned) && !hasApprovedRequest) {
        sanitized.contact = "需发起联系/认领申请后查看";
        sanitized.has_protected_contact = true;
      } else {
        sanitized.has_protected_contact = false;
      }
    }

    const blockedSet = new Set(Array.isArray(post.blocked_user_ids) ? post.blocked_user_ids : []);
    const rawComments = Array.isArray(post.comments) ? post.comments : [];
    sanitized.comments = rawComments
      .filter((c) => {
        if (!c || c.hidden_by_block) return false;
        if (c.author_user_id && blockedSet.has(c.author_user_id)) return false;
        if (!isPrivateMomentsComment(c)) return true;
        const isCommentAuthor = Boolean(
          viewerUserId && c.author_user_id && c.author_user_id === viewerUserId
        );
        return isOwner || (isViewerAdmin && isLegacyUnowned) || isCommentAuthor;
      })
      .map((c) => {
        const isCommentAuthor = Boolean(
          viewerUserId && c.author_user_id && c.author_user_id === viewerUserId
        );
        const canSeeHint =
          isOwner || (isViewerAdmin && isLegacyUnowned) || isCommentAuthor || !isPrivateMomentsComment(c);
        const projectedComment = {
          id: c.id,
          author_name: c.author_name,
          content: c.content,
          contact_hint: canSeeHint ? String(c.contact_hint || "") : "",
          is_private_to_initiator: isPrivateMomentsComment(c),
          created_at: c.created_at
        };
        return projectedComment;
      });

    const allPostReqs = Array.isArray(post.contact_requests) ? post.contact_requests : [];
    const viewerContactReq =
      viewerUserId && !isOwner
        ? allPostReqs.find((r) => r && r.sender_user_id === viewerUserId) || null
        : null;

    return {
      ...sanitized,
      viewer_role: isOwner ? "OWNER" : isViewerAdmin ? "ADMIN" : viewerUserId ? "AUTHENTICATED" : "GUEST",
      is_owner: isOwner,
      can_manage: canManage,
      is_legacy_unowned: isLegacyUnowned,
      can_claim_legacy: canClaimLegacy,
      contact_requests_count: allPostReqs.length,
      pending_contact_requests_count: canManage
        ? allPostReqs.filter((r) => r && r.status === "PENDING").length
        : 0,
      has_my_contact_request: Boolean(viewerContactReq),
      my_contact_request_status: viewerContactReq ? String(viewerContactReq.status || "PENDING") : null,
      matched_clues: computePostMatches(post, allPosts || []).map((m) => ({
        id: m.post.id,
        type: m.post.type,
        title: m.post.title,
        location: m.post.location,
        contact: m.post.contact_visibility === "ON_REQUEST" ? "需申请查看" : m.post.contact,
        match_score: m.match_score
      }))
    };
  }

  function projectMomentsBookForViewer(book, viewerUserId = null, isViewerAdmin = false) {
    if (!book) return null;
    const isOwner = Boolean(
      viewerUserId && book.owner_cloud_user_id && book.owner_cloud_user_id === viewerUserId
    );
    const isLegacyUnowned = !book.owner_cloud_user_id;
    const sanitized = { ...book };
    delete sanitized.owner_cloud_user_id;
    return {
      ...sanitized,
      is_owner: isOwner,
      can_manage: Boolean(isOwner || isViewerAdmin),
      is_legacy_unowned: isLegacyUnowned
    };
  }

  function projectAntiLostTagForOwnerOrAdmin(tag, viewerUserId = null, isViewerAdmin = false) {
    if (!tag) return null;
    const isOwner = Boolean(
      viewerUserId && tag.owner_cloud_user_id && tag.owner_cloud_user_id === viewerUserId
    );
    if (!isOwner && !isViewerAdmin) return null;
    const sanitized = { ...tag };
    delete sanitized.owner_cloud_user_id;
    return {
      ...sanitized,
      is_owner: isOwner,
      can_manage: true
    };
  }

  function normalizeContactMessages(reqItem, post) {
    if (!reqItem) return [];
    if (Array.isArray(reqItem.messages) && reqItem.messages.length > 0) {
      return reqItem.messages.map((m) => ({
        id: String(m.id || "mcm_legacy"),
        sender_role: m.sender_role === "OWNER" ? "OWNER" : "REQUESTER",
        sender_name: String(m.sender_name || (m.sender_role === "OWNER" ? post?.author_name || "发起人" : reqItem.sender_name || "河工大同学")),
        content: String(m.content || ""),
        created_at: m.created_at || reqItem.created_at
      }));
    }
    const seeded = [];
    if (reqItem.message) {
      seeded.push({
        id: `${reqItem.id}_init`,
        sender_role: "REQUESTER",
        sender_name: String(reqItem.sender_name || "河工大同学"),
        content: String(reqItem.message),
        created_at: reqItem.created_at
      });
    }
    if (reqItem.reply_message) {
      seeded.push({
        id: `${reqItem.id}_reply`,
        sender_role: "OWNER",
        sender_name: String(post?.author_name || "发起人"),
        content: String(reqItem.reply_message),
        created_at: reqItem.updated_at || reqItem.created_at
      });
    }
    return seeded;
  }

  function projectContactRequestForViewer(reqItem, post, { canSeeInitiatorContact = false, canSeeSenderContact = true } = {}) {
    if (!reqItem) return null;
    return {
      id: reqItem.id,
      post_id: reqItem.post_id,
      sender_name: reqItem.sender_name,
      message: reqItem.message,
      contact_info: canSeeSenderContact ? String(reqItem.contact_info || "") : "",
      status: reqItem.status,
      reply_message: reqItem.reply_message || null,
      messages: normalizeContactMessages(reqItem, post),
      initiator_contact: canSeeInitiatorContact ? post?.contact || null : null,
      created_at: reqItem.created_at,
      updated_at: reqItem.updated_at
    };
  }

  registerExtension("GET", "/api/v1/moments/snapshot", "getMomentsSnapshot", "public", async ({ query, headers, nowMs }) => {
    const { cloudUserId: viewerUserId, isAdmin: isViewerAdmin } = tryExtractOptionalViewerAuth(
      headers,
      nowMs,
      "GET"
    );
    const ms = store.momentsState || { posts: [], book_listings: [], anti_lost_tags: [], isbn_catalog: [] };
    const typeFilter = (query.get("type") || "").trim().toUpperCase();
    const campusFilter = (query.get("campus") || "").trim();
    const kw = (query.get("keyword") || "").trim().toLowerCase();
    let posts = Array.isArray(ms.posts) ? ms.posts : [];
    if (typeFilter === "LOST" || typeFilter === "FOUND") {
      posts = posts.filter((p) => p.type === typeFilter);
    }
    if (campusFilter && campusFilter !== "全部" && campusFilter !== "ALL") {
      posts = posts.filter((p) => p.campus === campusFilter);
    }
    if (kw) {
      posts = posts.filter((p) =>
        (p.title + " " + p.category + " " + p.location + " " + p.description).toLowerCase().includes(kw)
      );
    }
    const enrichedPosts = posts.map((p) =>
      projectMomentsPostForViewer(p, ms.posts || [], viewerUserId, isViewerAdmin)
    );
    const projectedBooks = (Array.isArray(ms.book_listings) ? ms.book_listings : [])
      .map((b) => projectMomentsBookForViewer(b, viewerUserId, isViewerAdmin))
      .filter(Boolean);
    // Anti-lost tags contain private owner_contact & finder_contact — return ONLY tags owned by viewer (or admin)!
    const visibleAntiLostTags = viewerUserId
      ? (Array.isArray(ms.anti_lost_tags) ? ms.anti_lost_tags : [])
          .map((t) => projectAntiLostTagForOwnerOrAdmin(t, viewerUserId, isViewerAdmin))
          .filter(Boolean)
      : [];
    return {
      status: 200,
      code: "MOMENTS_SNAPSHOT_OK",
      data: {
        school_id: "haut",
        updated_at: ms.updated_at || new Date().toISOString(),
        posts: enrichedPosts,
        book_listings: projectedBooks,
        anti_lost_tags: visibleAntiLostTags,
        isbn_catalog: Array.isArray(ms.isbn_catalog) ? ms.isbn_catalog : []
      }
    };
  });

  registerExtension("POST", "/api/v1/moments/posts", "createMomentsPost", "public", async ({ body, headers, nowMs }) => {
    const { cloudUserId: viewerUserId, isAdmin: isViewerAdmin } = tryExtractOptionalViewerAuth(
      headers,
      nowMs,
      "POST"
    );
    const title = String(body?.title || "").trim().slice(0, 64);
    if (!title) throw new ContractError("BAD_REQUEST", "请填写物品名称或标题");

    if (
      body?.owner_cloud_user_id !== undefined &&
      body?.owner_cloud_user_id !== null &&
      String(body.owner_cloud_user_id).trim() !== ""
    ) {
      if (!viewerUserId || String(body.owner_cloud_user_id).trim() !== viewerUserId) {
        throw new ContractError(
          "FORBIDDEN",
          "帖子所有者必须由当前登录认证身份决定，禁止匿名或跨账号指定 owner_cloud_user_id"
        );
      }
    }

    if (!viewerUserId) {
      throw new ContractError(
        "CLOUD_AUTH_REQUIRED",
        "发布寻物或招领信息需先登录云端账号，以便后续跨设备结案、删除及处理联系申请"
      );
    }

    const contactVisibility =
      String(body?.contact_visibility || "PUBLIC").toUpperCase() === "ON_REQUEST"
        ? "ON_REQUEST"
        : "PUBLIC";

    const requestedId = body?.id ? String(body.id).trim().slice(0, 40) : "";
    const existingPosts = store.momentsState.posts || [];
    if (requestedId && existingPosts.some((p) => p.id === requestedId)) {
      throw new ContractError("CONFLICT", "该帖子 ID 已存在，禁止覆盖已有失物招领帖或联系申请");
    }

    const nowIso = new Date(nowMs).toISOString();
    const newPost = {
      id: requestedId || ("mp_" + crypto.randomUUID().slice(0, 10)),
      type: String(body?.type || "LOST").toUpperCase() === "FOUND" ? "FOUND" : "LOST",
      title,
      category: String(body?.category || "其他物品").trim().slice(0, 24),
      campus: String(body?.campus || "莲花街校区").trim().slice(0, 24),
      location: String(body?.location || "校内").trim().slice(0, 64),
      description: String(body?.description || "").trim().slice(0, 360),
      contact: String(body?.contact || "").trim().slice(0, 64),
      reward_note: String(body?.reward_note || "").trim().slice(0, 64),
      status: "OPEN",
      author_name: String(body?.author_name || "河工大同学").trim().slice(0, 24),
      author_student_no_masked: String(body?.author_student_no_masked || "").trim().slice(0, 16),
      owner_cloud_user_id: viewerUserId,
      contact_visibility: contactVisibility,
      likes_count: 0,
      favorites_count: 0,
      comments: [],
      contact_requests: [],
      blocked_user_ids: [],
      reports_count: 0,
      created_at: nowIso,
      updated_at: nowIso
    };
    store.momentsState.posts = [newPost, ...existingPosts].slice(0, 200);
    store.momentsState.updated_at = nowIso;
    store.saveSnapshot();
    return {
      status: 201,
      code: "MOMENTS_POST_CREATED",
      data: projectMomentsPostForViewer(newPost, store.momentsState.posts, viewerUserId, isViewerAdmin)
    };
  });

  registerExtension("POST", "/api/v1/moments/posts/{postId}/comments", "addMomentsPostComment", "public", async ({ params, body, headers, nowMs }) => {
    const { cloudUserId: viewerUserId, isAdmin: isViewerAdmin } = tryExtractOptionalViewerAuth(
      headers,
      nowMs,
      "POST"
    );
    const post = (store.momentsState.posts || []).find((p) => p.id === params.postId);
    if (!post) throw new ContractError("NOT_FOUND", "未找到该寻物/招领帖");
    if (viewerUserId && Array.isArray(post.blocked_user_ids) && post.blocked_user_ids.includes(viewerUserId)) {
      throw new ContractError("FORBIDDEN", "发起人已屏蔽来自当前账号的留言或联系请求");
    }
    const content = String(body?.content || "").trim().slice(0, 240);
    if (!content) throw new ContractError("BAD_REQUEST", "留言内容不能为空");
    const isPrivate =
      Boolean(body?.is_private_to_initiator) || content.startsWith("【私密联系发起人】");
    if (isPrivate && !viewerUserId) {
      throw new ContractError(
        "CLOUD_AUTH_REQUIRED",
        "发送仅发起人可见的私密认领留言需先登录云端账号，或使用 /contact-requests 接口"
      );
    }
    const nowIso = new Date(nowMs).toISOString();
    const comment = {
      id: "mc_" + crypto.randomUUID().slice(0, 8),
      author_user_id: viewerUserId || null,
      author_name: String(body?.author_name || "热心同学").trim().slice(0, 24),
      content,
      contact_hint: String(body?.contact_hint || "").trim().slice(0, 48),
      is_private_to_initiator: isPrivate,
      created_at: nowIso
    };
    if (!Array.isArray(post.comments)) post.comments = [];
    post.comments.push(comment);
    post.updated_at = nowIso;
    store.momentsState.updated_at = nowIso;
    store.saveSnapshot();
    return {
      status: 201,
      code: "MOMENTS_COMMENT_ADDED",
      data: projectMomentsPostForViewer(post, store.momentsState.posts, viewerUserId, isViewerAdmin)
    };
  });

  registerExtension(
    "POST",
    "/api/v1/moments/posts/{postId}/contact-requests",
    "createMomentsContactRequest",
    "bearer",
    async ({ auth, params, body, headers, nowMs }) => {
      const post = (store.momentsState.posts || []).find((p) => p.id === params.postId);
      if (!post) throw new ContractError("NOT_FOUND", "未找到该寻物/招领帖");
      if (post.owner_cloud_user_id && post.owner_cloud_user_id === auth.cloudUserId) {
        throw new ContractError(
          "BAD_REQUEST",
          "您是该帖发起人，无需向自己发送认领申请；请在详情页查看并回复他人的私信"
        );
      }
      if (post.status === "RESOLVED" || post.status === "CLOSED") {
        throw new ContractError("CONFLICT", "该失物招领帖已结案或关闭联系");
      }
      if (!Array.isArray(post.blocked_user_ids)) post.blocked_user_ids = [];
      if (post.blocked_user_ids.includes(auth.cloudUserId)) {
        throw new ContractError("FORBIDDEN", "发起人已拒绝或屏蔽来自当前账号的联系申请");
      }
      const message = String(body?.message || "").trim();
      if (!message || message.length > 240) {
        throw new ContractError("BAD_REQUEST", "联系/认领说明长度需在 1–240 字之间");
      }
      const contactInfo = String(body?.contact_info || body?.contact_hint || "").trim().slice(0, 64);
      const idempotencyKey = String(
        headers?.["idempotency-key"] || headers?.["Idempotency-Key"] || body?.client_request_id || ""
      ).trim();

      if (!Array.isArray(post.contact_requests)) post.contact_requests = [];
      if (idempotencyKey) {
        const dup = post.contact_requests.find(
          (r) =>
            r.sender_user_id === auth.cloudUserId &&
            (r.idempotency_key === idempotencyKey ||
              (Array.isArray(r.messages) && r.messages.some((m) => m.idempotency_key === idempotencyKey)))
        );
        if (dup) {
          return {
            status: 200,
            code: "CONTACT_REQUEST_DUPLICATE",
            data: projectContactRequestForViewer(dup, post, {
              canSeeInitiatorContact: dup.status === "APPROVED",
              canSeeSenderContact: true
            })
          };
        }
      }

      const nowIso = new Date(nowMs).toISOString();
      const senderUser = store.users.get(auth.cloudUserId);
      const resolvedSenderName = String(
        body?.sender_name || senderUser?.display_name || "河工大同学"
      )
        .trim()
        .slice(0, 24);

      const existingThread = post.contact_requests.find(
        (r) => r.sender_user_id === auth.cloudUserId && (r.status === "PENDING" || r.status === "APPROVED")
      );
      if (existingThread) {
        const existingMsgs = normalizeContactMessages(existingThread, post);
        const recentThreadMsgs = existingMsgs.filter(
          (m) => m.sender_role === "REQUESTER" && nowMs - new Date(m.created_at).getTime() < 60_000
        );
        if (recentThreadMsgs.length >= 6) {
          throw new ContractError("RATE_LIMITED", "私信发送过于频繁，请稍后再试");
        }
        existingMsgs.push({
          id: "mcm_" + crypto.randomUUID().slice(0, 8),
          sender_role: "REQUESTER",
          sender_name: resolvedSenderName,
          content: message,
          idempotency_key: idempotencyKey || null,
          created_at: nowIso
        });
        existingThread.messages = existingMsgs.slice(-50);
        existingThread.message = message;
        if (contactInfo) existingThread.contact_info = contactInfo;
        existingThread.updated_at = nowIso;
        post.updated_at = nowIso;
        store.momentsState.updated_at = nowIso;
        if (post.owner_cloud_user_id && post.owner_cloud_user_id !== auth.cloudUserId) {
          store.addNotification({
            cloudUserId: post.owner_cloud_user_id,
            category: "MOMENTS_CONTACT_MESSAGE",
            title: `收到「${post.title}」的新认领私信`,
            body: `${resolvedSenderName}：${message}`
          });
        }
        store.saveSnapshot();
        return {
          status: 201,
          code: "CONTACT_MESSAGE_APPENDED",
          data: projectContactRequestForViewer(existingThread, post, {
            canSeeInitiatorContact: existingThread.status === "APPROVED",
            canSeeSenderContact: true
          })
        };
      }

      const recentBySender = post.contact_requests.filter(
        (r) =>
          r.sender_user_id === auth.cloudUserId &&
          nowMs - new Date(r.created_at).getTime() < 60_000
      );
      if (recentBySender.length >= 3) {
        throw new ContractError("RATE_LIMITED", "发送过于频繁，请稍后再试");
      }

      const reqItem = {
        id: "mcr_" + crypto.randomUUID().slice(0, 10),
        post_id: post.id,
        sender_user_id: auth.cloudUserId,
        sender_name: resolvedSenderName,
        message,
        contact_info: contactInfo,
        idempotency_key: idempotencyKey || null,
        status: "PENDING",
        reply_message: null,
        messages: [
          {
            id: "mcm_" + crypto.randomUUID().slice(0, 8),
            sender_role: "REQUESTER",
            sender_name: resolvedSenderName,
            content: message,
            idempotency_key: idempotencyKey || null,
            created_at: nowIso
          }
        ],
        created_at: nowIso,
        updated_at: nowIso
      };
      post.contact_requests.push(reqItem);
      post.updated_at = nowIso;
      store.momentsState.updated_at = nowIso;
      if (post.owner_cloud_user_id && post.owner_cloud_user_id !== auth.cloudUserId) {
        store.addNotification({
          cloudUserId: post.owner_cloud_user_id,
          category: "MOMENTS_CONTACT_REQUEST",
          title: `收到「${post.title}」的认领/联系申请`,
          body: `${reqItem.sender_name}：${message}`
        });
      }
      store.saveSnapshot();
      return {
        status: 201,
        code: "CONTACT_REQUEST_CREATED",
        data: projectContactRequestForViewer(reqItem, post, {
          canSeeInitiatorContact: false,
          canSeeSenderContact: true
        })
      };
    }
  );

  registerExtension(
    "GET",
    "/api/v1/moments/posts/{postId}/contact-requests",
    "listMomentsContactRequests",
    "bearer",
    async ({ auth, params }) => {
      const post = (store.momentsState.posts || []).find((p) => p.id === params.postId);
      if (!post) throw new ContractError("NOT_FOUND", "未找到该寻物/招领帖");
      const allReqs = Array.isArray(post.contact_requests) ? post.contact_requests : [];
      const isOwner = Boolean(post.owner_cloud_user_id && post.owner_cloud_user_id === auth.cloudUserId);
      const isAdmin = isMomentsAdminAuth(auth);
      const canManageRequests = Boolean(isOwner || (isAdmin && !post.owner_cloud_user_id));
      const isSenderBlocked =
        Array.isArray(post.blocked_user_ids) && post.blocked_user_ids.includes(auth.cloudUserId);
      const visibleReqs = canManageRequests
        ? allReqs.map((r) =>
            projectContactRequestForViewer(r, post, {
              canSeeInitiatorContact: false,
              canSeeSenderContact: true
            })
          )
        : allReqs
            .filter((r) => r.sender_user_id === auth.cloudUserId)
            .map((r) =>
              projectContactRequestForViewer(r, post, {
                canSeeInitiatorContact: !isSenderBlocked && r.status === "APPROVED",
                canSeeSenderContact: true
              })
            );
      return {
        status: 200,
        code: "CONTACT_REQUESTS_LISTED",
        data: {
          post_id: post.id,
          is_owner: isOwner,
          can_manage: canManageRequests,
          is_legacy_unowned: !post.owner_cloud_user_id,
          requests: visibleReqs
        }
      };
    }
  );

  registerExtension(
    "POST",
    "/api/v1/moments/posts/{postId}/contact-requests/{requestId}/action",
    "handleMomentsContactRequestAction",
    "bearer",
    async ({ auth, params, body, nowMs }) => {
      const post = (store.momentsState.posts || []).find((p) => p.id === params.postId);
      if (!post) throw new ContractError("NOT_FOUND", "未找到该寻物/招领帖");
      const allReqs = Array.isArray(post.contact_requests) ? post.contact_requests : [];
      const reqItem = allReqs.find((r) => r.id === params.requestId);
      if (!reqItem) throw new ContractError("NOT_FOUND", "未找到该联系申请");
      const isOwner = Boolean(post.owner_cloud_user_id && post.owner_cloud_user_id === auth.cloudUserId);
      const isAdmin = isMomentsAdminAuth(auth);
      const canManageRequests = Boolean(isOwner || (isAdmin && !post.owner_cloud_user_id));
      const isSender = reqItem.sender_user_id === auth.cloudUserId;
      if (!canManageRequests && !isSender && !(isAdmin && ["REJECT", "BLOCK", "REPORT"].includes(String(body?.action || "").toUpperCase()))) {
        throw new ContractError("FORBIDDEN", "无权操作他人的失物招领联系申请");
      }
      const action = String(body?.action || "").toUpperCase();
      const nowIso = new Date(nowMs).toISOString();
      if (action === "APPROVE") {
        if (!canManageRequests) throw new ContractError("FORBIDDEN", "仅发起人（或历史无主帖管理员）可同意公开联系方式");
        if (Array.isArray(post.blocked_user_ids) && post.blocked_user_ids.includes(reqItem.sender_user_id)) {
          throw new ContractError("CONFLICT", "该申请人已被拉黑，请先解除屏蔽");
        }
        const existingMsgs = normalizeContactMessages(reqItem, post);
        reqItem.status = "APPROVED";
        if (body?.reply_message) {
          const cleanReply = String(body.reply_message).trim().slice(0, 240);
          if (cleanReply) {
            reqItem.reply_message = cleanReply;
            existingMsgs.push({
              id: "mcm_" + crypto.randomUUID().slice(0, 8),
              sender_role: "OWNER",
              sender_name: String(post.author_name || "发起人").slice(0, 24),
              content: cleanReply,
              created_at: nowIso
            });
          }
        }
        reqItem.messages = existingMsgs.slice(-50);
        if (reqItem.sender_user_id && reqItem.sender_user_id !== auth.cloudUserId) {
          store.addNotification({
            cloudUserId: reqItem.sender_user_id,
            category: "MOMENTS_CONTACT_APPROVED",
            title: `发起人已同意公开「${post.title}」的联系方式`,
            body: reqItem.reply_message
              ? `发起人附言：${reqItem.reply_message}`
              : "您现在可在该帖详情中查看发起人联系方式或继续私信沟通"
          });
        }
        if (isAdmin && !isOwner) {
          store.recordAudit({
            actor_kind: "ADMIN",
            actor_ref: auth.cloudUserId,
            action: "ADMIN_APPROVE_LEGACY_POST_CONTACT_REQUEST",
            resource_kind: "moments_contact_request",
            resource_ref: reqItem.id,
            outcome: "APPROVED",
            detail: { post_id: post.id }
          });
        }
      } else if (action === "REPLY") {
        if (!canManageRequests && !isSender) {
          throw new ContractError("FORBIDDEN", "仅发起人或申请人本人可在该私信会话中回复");
        }
        if (reqItem.status === "BLOCKED" || reqItem.status === "REJECTED") {
          throw new ContractError("CONFLICT", "当前联系申请已被拒绝或屏蔽，无法继续发送私信");
        }
        if (Array.isArray(post.blocked_user_ids) && post.blocked_user_ids.includes(reqItem.sender_user_id)) {
          throw new ContractError("FORBIDDEN", "当前会话已被屏蔽");
        }
        const replyMsg = String(body?.reply_message || body?.message || "").trim();
        if (!replyMsg || replyMsg.length > 240) {
          throw new ContractError("BAD_REQUEST", "私信回复内容长度需在 1–240 字之间");
        }
        const existingMsgs = normalizeContactMessages(reqItem, post);
        const actorRole = canManageRequests && !isSender ? "OWNER" : "REQUESTER";
        const actorUser = store.users.get(auth.cloudUserId);
        const actorName =
          actorRole === "OWNER"
            ? String(post.author_name || actorUser?.display_name || "发起人").slice(0, 24)
            : String(reqItem.sender_name || actorUser?.display_name || "河工大同学").slice(0, 24);
        existingMsgs.push({
          id: "mcm_" + crypto.randomUUID().slice(0, 8),
          sender_role: actorRole,
          sender_name: actorName,
          content: replyMsg,
          created_at: nowIso
        });
        reqItem.messages = existingMsgs.slice(-50);
        if (actorRole === "OWNER") {
          reqItem.reply_message = replyMsg;
          if (reqItem.sender_user_id && reqItem.sender_user_id !== auth.cloudUserId) {
            store.addNotification({
              cloudUserId: reqItem.sender_user_id,
              category: "MOMENTS_CONTACT_REPLY",
              title: `发起人回复了您在「${post.title}」的私信`,
              body: `${actorName}：${replyMsg}`
            });
          }
        } else {
          reqItem.message = replyMsg;
          if (post.owner_cloud_user_id && post.owner_cloud_user_id !== auth.cloudUserId) {
            store.addNotification({
              cloudUserId: post.owner_cloud_user_id,
              category: "MOMENTS_CONTACT_MESSAGE",
              title: `收到「${post.title}」的新认领私信`,
              body: `${actorName}：${replyMsg}`
            });
          }
        }
      } else if (action === "REJECT") {
        if (!canManageRequests && !isAdmin) throw new ContractError("FORBIDDEN", "仅发起人或管理员可拒绝联系申请");
        reqItem.status = "REJECTED";
        if (isAdmin && !isOwner) {
          store.recordAudit({
            actor_kind: "ADMIN",
            actor_ref: auth.cloudUserId,
            action: "ADMIN_REJECT_MOMENTS_CONTACT_REQUEST",
            resource_kind: "moments_contact_request",
            resource_ref: reqItem.id,
            outcome: "REJECTED",
            detail: { post_id: post.id }
          });
        }
      } else if (action === "BLOCK") {
        if (!canManageRequests && !isAdmin) throw new ContractError("FORBIDDEN", "仅发起人或管理员可屏蔽申请人");
        if (!Array.isArray(post.blocked_user_ids)) post.blocked_user_ids = [];
        if (!post.blocked_user_ids.includes(reqItem.sender_user_id)) {
          post.blocked_user_ids.push(reqItem.sender_user_id);
        }
        // Revoke ALL existing requests (including previously APPROVED ones) & hide comments from this blocked user!
        for (const r of allReqs) {
          if (r.sender_user_id === reqItem.sender_user_id) {
            r.status = "BLOCKED";
            r.updated_at = nowIso;
          }
        }
        if (Array.isArray(post.comments)) {
          for (const c of post.comments) {
            if (c && c.author_user_id === reqItem.sender_user_id) {
              c.hidden_by_block = true;
            }
          }
        }
        if (isAdmin && !isOwner) {
          store.recordAudit({
            actor_kind: "ADMIN",
            actor_ref: auth.cloudUserId,
            action: "ADMIN_BLOCK_MOMENTS_CONTACT_REQUEST",
            resource_kind: "moments_contact_request",
            resource_ref: reqItem.id,
            outcome: "BLOCKED",
            detail: { post_id: post.id, blocked_sender_user_id: reqItem.sender_user_id }
          });
        }
      } else if (action === "REPORT") {
        post.reports_count = Number(post.reports_count || 0) + 1;
        store.recordAudit({
          actor_kind: "USER",
          actor_ref: auth.cloudUserId,
          action: "REPORT_MOMENTS_CONTACT_REQUEST",
          resource_kind: "moments_contact_request",
          resource_ref: reqItem.id,
          outcome: "REPORTED",
          detail: { post_id: post.id, reason: String(body?.reason || "用户举报") }
        });
      } else {
        throw new ContractError("BAD_REQUEST", "不支持的操作类型");
      }
      reqItem.updated_at = nowIso;
      post.updated_at = nowIso;
      store.momentsState.updated_at = nowIso;
      store.saveSnapshot();
      const isSenderBlocked =
        Array.isArray(post.blocked_user_ids) && post.blocked_user_ids.includes(reqItem.sender_user_id);
      const canViewerSeeInitiatorContact =
        !isSenderBlocked && reqItem.status === "APPROVED" && (isSender || canManageRequests);
      const canViewerSeeSenderContact = Boolean(isSender || canManageRequests);
      return {
        status: 200,
        code: "CONTACT_REQUEST_UPDATED",
        data: projectContactRequestForViewer(reqItem, post, {
          canSeeInitiatorContact: canViewerSeeInitiatorContact,
          canSeeSenderContact: canViewerSeeSenderContact
        })
      };
    }
  );

  registerExtension("POST", "/api/v1/moments/posts/{postId}/action", "mutateMomentsPost", "public", async ({ params, body, headers, nowMs }) => {
    const { cloudUserId: viewerUserId, isAdmin: isViewerAdmin } = tryExtractOptionalViewerAuth(
      headers,
      nowMs,
      "POST"
    );
    const posts = store.momentsState.posts || [];
    const idx = posts.findIndex((p) => p.id === params.postId);
    if (idx < 0) throw new ContractError("NOT_FOUND", "未找到该寻物/招领帖");
    const act = String(body?.action || "").toUpperCase();
    const post = posts[idx];
    const nowIso = new Date(nowMs).toISOString();

    if (act === "CLAIM_OWNERSHIP") {
      if (!viewerUserId) {
        throw new ContractError("CLOUD_AUTH_REQUIRED", "认领历史旧帖管理权需先登录云端账号");
      }
      if (post.owner_cloud_user_id) {
        if (post.owner_cloud_user_id === viewerUserId) {
          return {
            status: 200,
            code: "MOMENTS_POST_OWNERSHIP_ALREADY_BOUND",
            data: projectMomentsPostForViewer(post, store.momentsState.posts, viewerUserId, isViewerAdmin)
          };
        }
        throw new ContractError("CONFLICT", "该帖子已绑定归属账号，禁止重复认领管理权");
      }

      if (isViewerAdmin) {
        const targetOwnerId = body?.target_owner_cloud_user_id !== undefined
          ? String(body.target_owner_cloud_user_id || "").trim()
          : viewerUserId;
        const targetUser = targetOwnerId ? store.users.get(targetOwnerId) : null;
        if (!targetOwnerId || !targetUser || targetUser.status !== "ACTIVE") {
          throw new ContractError(
            "BAD_REQUEST",
            "管理员指派归属的目标云端账号不存在或状态非 ACTIVE，拒绝绑定无主旧帖"
          );
        }
        const verificationNote = String(body?.verification_note || body?.reason || "").trim().slice(0, 240);
        if (!verificationNote) {
          throw new ContractError(
            "BAD_REQUEST",
            "管理员人工核验指派历史旧帖归属时必须填写 verification_note 核验依据"
          );
        }
        post.owner_cloud_user_id = targetOwnerId;
        delete post.legacy_claim_token_sha256;
        post.updated_at = nowIso;
        store.momentsState.updated_at = nowIso;
        store.recordAudit({
          actor_kind: "ADMIN",
          actor_ref: viewerUserId,
          action: "ADMIN_ASSIGN_LEGACY_MOMENTS_POST",
          resource_kind: "moments_post",
          resource_ref: post.id,
          outcome: "CLAIMED",
          detail: {
            assigned_owner_cloud_user_id: targetOwnerId,
            verification_mode: "ADMIN_MANUAL_VERIFICATION",
            verification_note: verificationNote
          }
        });
        store.saveSnapshot();
        return {
          status: 200,
          code: "MOMENTS_POST_OWNERSHIP_CLAIMED",
          data: projectMomentsPostForViewer(post, store.momentsState.posts, viewerUserId, isViewerAdmin)
        };
      }

      // Non-admin self-service: strictly forbid masked student_no inference, PENDING_DELEGATION student_no,
      // PUBLIC contact, or ON_REQUEST contact (which approved requesters also know!).
      // Only accept an original high-entropy ownership token or a trusted unique OIDC issuer+subject binding.
      const hasValidClaimToken = verifyHighEntropyLegacyClaimToken(post, body?.claim_token);
      const hasTrustedUniqueSso = verifyUniqueTrustedLegacySsoBinding(post, viewerUserId);
      if (!hasValidClaimToken && !hasTrustedUniqueSso) {
        store.recordAudit({
          actor_kind: "USER",
          actor_ref: viewerUserId,
          action: "REJECT_UNTRUSTED_LEGACY_MOMENTS_CLAIM",
          resource_kind: "moments_post",
          resource_ref: post.id,
          outcome: "REJECTED"
        });
        throw new ContractError(
          "FORBIDDEN",
          "已关闭基于脱敏学号或联系方式的自助认领；缺少原始高熵所有权凭证的历史旧帖仅支持管理员人工核验处理"
        );
      }

      const viewerUser = store.users.get(viewerUserId);
      if (!viewerUser || viewerUser.status !== "ACTIVE") {
        throw new ContractError("FORBIDDEN", "当前云端账号状态异常，无法绑定帖子归属");
      }
      post.owner_cloud_user_id = viewerUserId;
      delete post.legacy_claim_token_sha256;
      post.updated_at = nowIso;
      store.momentsState.updated_at = nowIso;
      store.recordAudit({
        actor_kind: "USER",
        actor_ref: viewerUserId,
        action: "CLAIM_LEGACY_MOMENTS_POST",
        resource_kind: "moments_post",
        resource_ref: post.id,
        outcome: "CLAIMED",
        detail: {
          assigned_owner_cloud_user_id: viewerUserId,
          verification_mode: hasValidClaimToken ? "HIGH_ENTROPY_CLAIM_TOKEN" : "TRUSTED_UNIQUE_SSO_SUBJECT"
        }
      });
      store.saveSnapshot();
      return {
        status: 200,
        code: "MOMENTS_POST_OWNERSHIP_CLAIMED",
        data: projectMomentsPostForViewer(post, store.momentsState.posts, viewerUserId, isViewerAdmin)
      };
    }

    const isOwner = Boolean(
      viewerUserId && post.owner_cloud_user_id && post.owner_cloud_user_id === viewerUserId
    );

    if (act === "DELETE" || act === "RESOLVE" || act === "REOPEN") {
      if (!viewerUserId) {
        throw new ContractError("CLOUD_AUTH_REQUIRED", "修改或删除失物招领帖需先登录云端账号");
      }
      if (!isOwner && !isViewerAdmin) {
        throw new ContractError(
          "FORBIDDEN",
          post.owner_cloud_user_id
            ? "仅帖子发起人本人或平台管理员可执行结案、重开或删除操作"
            : "该历史旧帖尚未绑定发起人账号，请先完成归属核验认领或提交举报由管理员处理"
        );
      }
      if (isViewerAdmin && !isOwner) {
        store.recordAudit({
          actor_kind: "ADMIN",
          actor_ref: viewerUserId,
          action: `ADMIN_${act}_MOMENTS_POST`,
          resource_kind: "moments_post",
          resource_ref: post.id,
          outcome: "SUCCESS",
          detail: { was_legacy_unowned: !post.owner_cloud_user_id }
        });
      }
    }

    if (act === "DELETE") {
      posts.splice(idx, 1);
      store.momentsState.updated_at = nowIso;
      store.saveSnapshot();
      return { status: 200, code: "MOMENTS_POST_DELETED", data: { deleted_id: params.postId } };
    }
    if (act === "RESOLVE") post.status = "RESOLVED";
    else if (act === "REOPEN") post.status = "OPEN";
    else if (act === "LIKE") post.likes_count = Number(post.likes_count || 0) + 1;
    else if (act === "FAVORITE") post.favorites_count = Number(post.favorites_count || 0) + 1;
    else if (act === "REPORT") {
      post.reports_count = Number(post.reports_count || 0) + 1;
      store.recordAudit({
        actor_kind: viewerUserId ? "USER" : "ANONYMOUS",
        actor_ref: viewerUserId || "anonymous",
        action: "REPORT_MOMENTS_POST",
        resource_kind: "moments_post",
        resource_ref: post.id,
        outcome: "REPORTED",
        detail: { reason: String(body?.reason || "用户举报不良或虚假失物招领信息").slice(0, 160) }
      });
    } else {
      throw new ContractError("BAD_REQUEST", "不支持的帖子操作类型");
    }
    post.updated_at = nowIso;
    store.momentsState.updated_at = nowIso;
    store.saveSnapshot();
    return {
      status: 200,
      code: "MOMENTS_POST_UPDATED",
      data: projectMomentsPostForViewer(post, store.momentsState.posts, viewerUserId, isViewerAdmin)
    };
  });

  registerExtension("POST", "/api/v1/moments/books", "createMomentsBookListing", "public", async ({ body, headers, nowMs }) => {
    const { cloudUserId: viewerUserId, isAdmin: isViewerAdmin } = tryExtractOptionalViewerAuth(
      headers,
      nowMs,
      "POST"
    );
    if (!viewerUserId) {
      throw new ContractError(
        "CLOUD_AUTH_REQUIRED",
        "发布闲置教材需先登录云端账号，以便后续下架或删除管理"
      );
    }
    const title = String(body?.title || "").trim().slice(0, 80);
    if (!title) throw new ContractError("BAD_REQUEST", "请填写教材名称");
    const requestedId = body?.id ? String(body.id).trim().slice(0, 40) : "";
    const existingBooks = store.momentsState.book_listings || [];
    if (requestedId && existingBooks.some((b) => b.id === requestedId)) {
      throw new ContractError("CONFLICT", "该教材挂单 ID 已存在，禁止覆盖已有教材信息");
    }
    const nowIso = new Date(nowMs).toISOString();
    const book = {
      id: requestedId || ("mb_" + crypto.randomUUID().slice(0, 10)),
      title,
      isbn: String(body?.isbn || "").trim().slice(0, 24),
      author_publisher: String(body?.author_publisher || "高校教材").trim().slice(0, 64),
      course_name: String(body?.course_name || "").trim().slice(0, 40),
      major_track: String(body?.major_track || "ALL_MAJORS").trim().slice(0, 32),
      campus: String(body?.campus || "莲花街校区").trim().slice(0, 24),
      condition_label: String(body?.condition_label || "九成新").trim().slice(0, 32),
      price_yuan: Math.max(0, Math.min(500, Number(body?.price_yuan ?? 15) || 15)),
      original_price_yuan: Math.max(0, Math.min(999, Number(body?.original_price_yuan ?? 55) || 55)),
      delivery_mode: String(body?.delivery_mode || "校内自提").trim().slice(0, 40),
      contact: String(body?.contact || "").trim().slice(0, 64),
      seller_name: String(body?.seller_name || "河工大同学").trim().slice(0, 24),
      owner_cloud_user_id: viewerUserId,
      status: "AVAILABLE",
      likes_count: 0,
      created_at: nowIso
    };
    store.momentsState.book_listings = [book, ...existingBooks].slice(0, 200);
    store.momentsState.updated_at = nowIso;
    store.saveSnapshot();
    return {
      status: 201,
      code: "MOMENTS_BOOK_CREATED",
      data: projectMomentsBookForViewer(book, viewerUserId, isViewerAdmin)
    };
  });

  registerExtension("POST", "/api/v1/moments/books/{bookId}/action", "mutateMomentsBookListing", "public", async ({ params, body, headers, nowMs }) => {
    const { cloudUserId: viewerUserId, isAdmin: isViewerAdmin } = tryExtractOptionalViewerAuth(
      headers,
      nowMs,
      "POST"
    );
    const books = store.momentsState.book_listings || [];
    const idx = books.findIndex((b) => b.id === params.bookId);
    if (idx < 0) throw new ContractError("NOT_FOUND", "未找到该教材挂单");
    const act = String(body?.action || "").toUpperCase();
    const book = books[idx];
    const isOwner = Boolean(
      viewerUserId && book.owner_cloud_user_id && book.owner_cloud_user_id === viewerUserId
    );
    if (act === "DELETE" || act === "MARK_SOLD" || act === "MARK_AVAILABLE") {
      if (!viewerUserId) {
        throw new ContractError("CLOUD_AUTH_REQUIRED", "修改或删除教材挂单需先登录云端账号");
      }
      if (!isOwner && !isViewerAdmin) {
        throw new ContractError("FORBIDDEN", "仅卖家本人或平台管理员可修改或删除该教材挂单");
      }
    }
    const nowIso = new Date(nowMs).toISOString();
    if (act === "DELETE") {
      books.splice(idx, 1);
      store.momentsState.updated_at = nowIso;
      store.saveSnapshot();
      return { status: 200, code: "MOMENTS_BOOK_DELETED", data: { deleted_id: params.bookId } };
    }
    if (act === "MARK_SOLD") book.status = "SOLD";
    else if (act === "MARK_AVAILABLE") book.status = "AVAILABLE";
    else if (act === "LIKE") book.likes_count = Number(book.likes_count || 0) + 1;
    else throw new ContractError("BAD_REQUEST", "不支持的教材操作类型");
    store.momentsState.updated_at = nowIso;
    store.saveSnapshot();
    return {
      status: 200,
      code: "MOMENTS_BOOK_UPDATED",
      data: projectMomentsBookForViewer(book, viewerUserId, isViewerAdmin)
    };
  });

  registerExtension("GET", "/api/v1/moments/isbn-resolve", "resolveMomentsIsbn", "public", async ({ query }) => {
    const q = (query.get("isbn") || query.get("keyword") || "").replace(/[^0-9a-zA-Z\u4e00-\u9fa5]/g, "").toLowerCase();
    const catalog = store.momentsState?.isbn_catalog || [];
    const matched = q
      ? catalog.find(
          (c) =>
            String(c.isbn || "").toLowerCase().includes(q) ||
            String(c.title || "").toLowerCase().includes(q) ||
            String(c.course_name || "").toLowerCase().includes(q)
        ) || null
      : null;
    return { status: 200, code: "MOMENTS_ISBN_RESOLVED", data: { matched, catalog } };
  });

  registerExtension("POST", "/api/v1/moments/anti-lost-tags", "upsertAntiLostTag", "public", async ({ body, headers, nowMs }) => {
    const { cloudUserId: viewerUserId, isAdmin: isViewerAdmin } = tryExtractOptionalViewerAuth(
      headers,
      nowMs,
      "POST"
    );
    if (!viewerUserId) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "创建或更新随身防丢码需先登录云端账号");
    }
    const itemName = String(body?.item_name || "").trim().slice(0, 48);
    if (!itemName) throw new ContractError("BAD_REQUEST", "请填写随身物品名称");
    const nowIso = new Date(nowMs).toISOString();
    const rawCode = String(body?.tag_code || "").trim().toUpperCase();
    const tagCode = /^HAUT-TAG-[A-Z0-9]{4,10}$/.test(rawCode)
      ? rawCode
      : ("HAUT-TAG-" + crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase());
    const tags = store.momentsState.anti_lost_tags || [];
    const existing = tags.find((t) => t.tag_code === tagCode);
    if (existing) {
      const canMutateExisting =
        isViewerAdmin || (existing.owner_cloud_user_id && existing.owner_cloud_user_id === viewerUserId);
      if (!canMutateExisting) {
        throw new ContractError("CONFLICT", "该防丢码编号已被绑定，禁止覆盖他人防丢码");
      }
    }
    const rawStatus = String(body?.status || existing?.status || "NORMAL").toUpperCase();
    const allowedStatus = ["NORMAL", "LOST", "FOUND_REPORTED", "DISABLED"].includes(rawStatus)
      ? rawStatus
      : "NORMAL";
    const rawVisibility = String(
      body?.contact_visibility ?? existing?.contact_visibility ?? "PRIVATE"
    ).toUpperCase();
    const contactVisibility =
      rawVisibility === "PUBLIC_WHEN_LOST" ? "PUBLIC_WHEN_LOST" : "PRIVATE";
    const ownerDeclaredLost =
      allowedStatus === "LOST" ||
      (allowedStatus === "FOUND_REPORTED" && existing?.owner_declared_lost === true);
    const normalizedOwnerStatus =
      allowedStatus === "FOUND_REPORTED" && !ownerDeclaredLost ? "NORMAL" : allowedStatus;
    const updatedTag = {
      id: existing?.id || ("tag_" + crypto.randomUUID().slice(0, 8)),
      tag_code: tagCode,
      owner_cloud_user_id: existing?.owner_cloud_user_id || viewerUserId,
      item_name: itemName,
      category: String(body?.category || existing?.category || "随身物品").trim().slice(0, 24),
      campus: String(body?.campus || existing?.campus || "莲花街校区").trim().slice(0, 24),
      owner_name: String(body?.owner_name || existing?.owner_name || "河工大同学").trim().slice(0, 24),
      owner_contact: String(body?.owner_contact || existing?.owner_contact || "").trim().slice(0, 64),
      contact_visibility: contactVisibility,
      owner_declared_lost: ownerDeclaredLost,
      return_note: String(body?.return_note || existing?.return_note || "拾到请联系失主或放至就近服务台").trim().slice(0, 160),
      status: normalizedOwnerStatus,
      reports: Array.isArray(existing?.reports) ? existing.reports : [],
      created_at: existing?.created_at || nowIso,
      updated_at: nowIso
    };
    store.momentsState.anti_lost_tags = [
      updatedTag,
      ...tags.filter((t) => t.tag_code !== tagCode)
    ].slice(0, 120);
    store.momentsState.updated_at = nowIso;
    store.saveSnapshot();
    return {
      status: 200,
      code: "ANTI_LOST_TAG_UPSERTED",
      data: projectAntiLostTagForOwnerOrAdmin(updatedTag, viewerUserId, isViewerAdmin)
    };
  });

  registerExtension("POST", "/api/v1/moments/anti-lost-tags/{tagCode}/report-found", "reportAntiLostTagFound", "public", async ({ params, body, nowMs }) => {
    const cleanCode = String(params.tagCode || "").trim().toUpperCase();
    const tags = store.momentsState.anti_lost_tags || [];
    const tag = tags.find((t) => t.tag_code.toUpperCase() === cleanCode);
    if (!tag) throw new ContractError("NOT_FOUND", "未找到防丢码 " + cleanCode);
    if (String(tag.status || "").toUpperCase() === "DISABLED") {
      throw new ContractError("CONFLICT", "该防丢码已由失主停用，不再接收拾得上报");
    }
    const foundLocation = String(body?.found_location || "").trim().slice(0, 80);
    if (!foundLocation) throw new ContractError("BAD_REQUEST", "请填写拾得位置或放置地点");
    const nowIso = new Date(nowMs).toISOString();
    const report = {
      id: "rep_" + crypto.randomUUID().slice(0, 8),
      finder_name: String(body?.finder_name || "热心同学").trim().slice(0, 24),
      found_location: foundLocation,
      finder_contact: String(body?.finder_contact || "").trim().slice(0, 64),
      message: String(body?.message || "").trim().slice(0, 200),
      created_at: nowIso
    };
    if (!Array.isArray(tag.reports)) tag.reports = [];
    tag.reports = [report, ...tag.reports].slice(0, 30);
    // CRITICAL: Anonymous report-found MUST NEVER escalate a NORMAL/restricted tag into LOST/FOUND_REPORTED!
    // Only transition LOST -> FOUND_REPORTED when the owner had ALREADY explicitly declared LOST!
    if (tag.status === "LOST" && tag.owner_declared_lost === true) {
      tag.status = "FOUND_REPORTED";
    }
    tag.last_finder_report_at = nowIso;
    tag.updated_at = nowIso;
    store.momentsState.updated_at = nowIso;
    if (tag.owner_cloud_user_id) {
      store.addNotification({
        cloudUserId: tag.owner_cloud_user_id,
        category: "ANTI_LOST_TAG_FOUND",
        title: `防丢码「${tag.item_name}」收到拾得线索`,
        body: `放置位置：${foundLocation}${report.message ? " · " + report.message : ""}`
      });
    }
    store.saveSnapshot();
    // Public-safe acknowledgment: NEVER leak owner_contact, owner_name, internal status, or historical reports[]!
    return {
      status: 200,
      code: "ANTI_LOST_FOUND_REPORTED",
      data: {
        tag_code: tag.tag_code,
        report_id: report.id,
        report_submitted: true,
        updated_at: nowIso
      }
    };
  });

  async function inject({
    method = "GET",
    url = "/healthz",
    headers = {},
    body = undefined,
    nowMs = Date.now(),
    remoteAddr = null
  }) {
    const requestId = generateRequestId(headers["x-request-id"] || headers["X-Request-Id"]);
    try {
      const parsedUrl = new URL(url, "http://localhost");
      const pathname = parsedUrl.pathname;
      const upperMethod = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();

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
      return {
        status: errEnv.httpStatus,
        headers: {
          ...SECURITY_HEADERS,
          "content-type": "application/json; charset=utf-8",
          "x-request-id": requestId
        },
        body: errEnv.body
      };
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
    });
  }

  function getRegisteredRoutes() {
    return routes.map((r) => ({
      method: r.method,
      path: r.path,
      operationId: r.operationId,
      auth: r.auth
    }));
  }

  return {
    store,
    kmsVault,
    identity,
    cookieVault,
    schoolProvider,
    financeBridge,
    financeService,
    reservationEngine,
    parcelHub,
    pluginBroker,
    redisBuffer,
    inject,
    createHttpServer,
    getRegisteredRoutes
  };
}
