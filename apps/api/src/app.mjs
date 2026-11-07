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
  getReservationPriceVersion,
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
  renderMobileCallbackHtml
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
  const identity = options.identity || new CloudIdentityService(store, options.identityOptions);
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

  async function syncUserToSso(cloudUserId) {
    if (typeof store.saveSnapshot === "function") {
      store.saveSnapshot();
    }
    const user = store.users.get(cloudUserId);
    if (!user || !user.sso_access_token) return;
    const bindings = Array.from(store.schoolBindings.values()).filter(
      (b) => b.cloud_user_id === cloudUserId && !b.revoked_at
    );
    const plans = Array.from(store.reservationPlans.values()).filter(
      (p) => p.cloud_user_id === cloudUserId && p.enabled !== false
    );
    const jobs = Array.from(store.reservationJobs.values()).filter(
      (j) => j.cloud_user_id === cloudUserId
    );
    const parcels = parcelHub.listUserParcels(cloudUserId);
    const readyParcels = parcels.filter(
      (p) => p.status !== "PICKED_UP" && (p.status === "READY_FOR_PICKUP" || p.pickup_code)
    );
    const orders = Array.from(store.reservationOrders.values()).filter(
      (o) => o.cloud_user_id === cloudUserId
    );
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
    const bindings = Array.from(store.schoolBindings.values())
      .filter((b) => b.cloud_user_id === cloudUserId && !b.revoked_at)
      .map((b) => ({
        id: b.id,
        school_id: b.school_id,
        student_no: b.student_no || b.student_no_masked || "",
        student_no_masked: b.student_no_masked,
        status: b.status,
        created_at: b.created_at
      }));
    const consents = Array.from(store.consents.values()).filter(
      (c) => c.cloud_user_id === cloudUserId && !c.withdrawn_at
    );
    const plans = Array.from(store.reservationPlans.values()).filter(
      (p) => p.cloud_user_id === cloudUserId
    );
    const jobs = Array.from(store.reservationJobs.values())
      .filter((j) => j.cloud_user_id === cloudUserId)
      .map((j) => {
        const p = store.reservationPlans.get(j.plan_id) || {};
        const sr = store.schoolReservations.get(j.id) || null;
        return {
          ...j,
          area_code: p.area_code || "4F_NORTH",
          area_name: p.area_name || "4楼北自习区",
          candidate_seats: p.candidate_seats || [],
          slot_window: p.slot_window || "08:00-22:00",
          repeat_days: Number(p.repeat_days ?? j.repeat_days ?? 1),
          remaining_days: Number(p.remaining_days ?? j.remaining_days ?? 1),
          end_local_date: p.end_local_date || j.end_local_date || j.booking_local_date,
          school_reservation: sr
        };
      });
    const orders = Array.from(store.reservationOrders.values())
      .filter((o) => o.cloud_user_id === cloudUserId)
      .map((o) => ({
        ...o,
        price_peach: Number(
          o.price_peach ?? o.price_micropeach / MICROPEACH_PER_PEACH
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
      school_bindings: bindings,
      consents,
      reservation_plans: plans,
      reservation_jobs: jobs,
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
        redis_buffer: redisTelemetry
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
    const orders = Array.from(store.reservationOrders.values()).filter(
      (o) => o.cloud_user_id === auth.cloudUserId
    );
    return { status: 200, code: "ORDERS_LISTED", data: { orders } };
  });

  register("GET", "/api/v1/me/consents", "listMyConsents", "bearer", async ({ auth }) => {
    const consents = Array.from(store.consents.values()).filter(
      (c) => c.cloud_user_id === auth.cloudUserId
    );
    return { status: 200, code: "CONSENTS_LISTED", data: { consents } };
  });

  register("POST", "/api/v1/me/consents", "grantConsent", "bearer", async ({ auth, body, nowMs }) => {
    const id = crypto.randomUUID();
    const record = {
      id,
      cloud_user_id: auth.cloudUserId,
      school_id: body?.school_id || "haut",
      scope_list: body?.scope_list || ["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"],
      policy_version: body?.policy_version || "policy-2026-11-v4",
      granted_at: new Date(nowMs).toISOString(),
      withdrawn_at: null
    };
    store.consents.set(id, record);
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
    const bindings = Array.from(store.schoolBindings.values()).filter(
      (b) => b.cloud_user_id === auth.cloudUserId
    );
    const plans = Array.from(store.reservationPlans.values()).filter(
      (p) => p.cloud_user_id === auth.cloudUserId
    );
    const parcels = parcelHub.listUserParcels(auth.cloudUserId);
    return {
      status: 200,
      code: "DATA_EXPORT_READY",
      data: redactSensitiveFields({
        user,
        school_bindings: bindings,
        reservation_plans: plans,
        parcels
      })
    };
  });

  register("POST", "/api/v1/me/data-delete", "requestMyDataDelete", "bearer", async ({ auth, nowMs }) => {
    const cascade = store.haltAllUserPlansAndBindings(auth.cloudUserId, "USER_DATA_DELETE", nowMs);
    identity.revokeAllUserSessions(auth.cloudUserId, true, nowMs);
    const user = store.users.get(auth.cloudUserId);
    if (user) user.status = "DELETED";
    return {
      status: 202,
      code: "DATA_DELETE_ACCEPTED",
      data: {
        cloud_user_id: auth.cloudUserId,
        status: "DELETED",
        cancelled_job_ids: cascade.cancelledJobIds
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
    const bindings = Array.from(store.schoolBindings.values())
      .filter((b) => b.cloud_user_id === auth.cloudUserId)
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
      const studentNo = String(body?.student_no || "").trim() || "20240001";
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
        created_at: new Date(nowMs).toISOString(),
        revoked_at: null
      };
      store.schoolBindings.set(bindingId, binding);
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
      const secretPayload = body?.delegated_secret || body?.session_token || "delegated_session_v1";
      const encrypted = kmsVault.encryptSecret({
        bindingId: binding.id,
        schoolId: binding.school_id,
        credentialKind: body?.credential_kind || "DELEGATED_SESSION_BUNDLE",
        plaintext: secretPayload,
        expiresAt:
          body?.expires_at || new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString()
      });
      store.encryptedCredentials.set(encrypted.id, encrypted);
      binding.credential_ref = encrypted.id;
      binding.credential_expires_at = encrypted.expires_at;
      binding.status = "DELEGATED_ACTIVE";
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
      store.encryptedCredentials.set(encrypted.id, encrypted);
      binding.credential_ref = encrypted.id;
      binding.credential_expires_at = encrypted.expires_at;
      binding.revoked_at = null;
      binding.status = "DELEGATED_ACTIVE";
      return {
        status: 200,
        code: "SCHOOL_BINDING_REAUTHORIZED",
        data: {
          id: binding.id,
          status: binding.status,
          credential_ref: binding.credential_ref
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
    const plans = Array.from(store.reservationPlans.values()).filter(
      (p) => p.cloud_user_id === auth.cloudUserId
    );
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
        store.idempotencyRecords.set(cacheKey, { bodyHash, data: created });
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
      const planJobs = Array.from(store.reservationJobs.values()).filter(j => j.plan_id === plan.id);
      if (planJobs.some(j => reservationEngine.inFlightJobs.has(j.id) || j.attempt_count || ["EXECUTING", "RESULT_UNKNOWN", "CONFIRMED"].includes(j.state))) {
        throw new ContractError("CONFLICT", "Cannot edit a plan during or after a booking attempt");
      }
      if (body?.preferred_seat_ids) {
        plan.preferences_json.preferred_seat_ids = body.preferred_seat_ids;
        plan.candidate_seats = body.preferred_seat_ids;
      }
      if (body?.preferred_area_ids) {
        plan.preferences_json.preferred_area_ids = body.preferred_area_ids;
        plan.area_name = body.preferred_area_ids[0];
        plan.area_code = body.preferred_area_ids[0];
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
      for (const job of planJobs) {
        if (["CANCELLED", "FAILED", "EXPIRED"].includes(job.state)) continue;
        job.generation = plan.generation;
        job.prewarmed_targets = null;
        job.state = "ARMED";
        job.state_version += 1;
        for (const event of store.scheduleEvents.values()) {
          if (event.job_id !== job.id) continue;
          event.generation = plan.generation;
          event.status = "ARMED";
          event.actual_at = null;
          event.diagnostic_code = null;
        }
      }
      await syncUserToSso(auth.cloudUserId);
      return { status: 200, code: "RESERVATION_PLAN_UPDATED", data: plan };
    }
  );

  register(
    "DELETE",
    "/api/v1/reservation-plans/{planId}",
    "cancelReservationPlan",
    "bearer",
    async ({ auth, params }) => {
      const plan = store.reservationPlans.get(params.planId);
      if (!plan || plan.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "Reservation plan not found");
      }
      plan.enabled = false;
      for (const j of store.reservationJobs.values()) {
        if (j.plan_id === plan.id && !["CONFIRMED", "FAILED", "CANCELLED"].includes(j.state)) {
          await reservationEngine.cancelConfirmedOrActiveJob(j.id);
        }
      }
      await syncUserToSso(auth.cloudUserId);
      return { status: 200, code: "RESERVATION_PLAN_CANCELLED", data: { plan_id: plan.id, enabled: false } };
    }
  );

  register("GET", "/api/v1/reservation-jobs", "listReservationJobs", "bearer", async ({ auth }) => {
    const jobs = Array.from(store.reservationJobs.values()).filter(
      (j) => j.cloud_user_id === auth.cloudUserId
    );
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
      const events = Array.from(store.scheduleEvents.values()).filter((e) => e.job_id === job.id);
      return { status: 200, code: "RESERVATION_JOB_OK", data: { ...job, schedule_events: events } };
    }
  );

  register(
    "POST",
    "/api/v1/reservation-jobs/{jobId}/cancel",
    "cancelReservationJob",
    "bearer",
    async ({ auth, params }) => {
      const job = store.reservationJobs.get(params.jobId);
      if (!job) throw new ContractError("NOT_FOUND", "Reservation job not found");
      if (job.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("FORBIDDEN", "Cross-user reservation job cancel denied");
      }
      if (["CONFIRMED", "FAILED", "CANCELLED", "EXPIRED"].includes(job.state)) {
        throw new ContractError("JOB_ALREADY_TERMINAL", `Job is already in terminal state ${job.state}`);
      }
      const result = await reservationEngine.cancelConfirmedOrActiveJob(job.id);
      await syncUserToSso(auth.cloudUserId);
      return { status: result.job.state === "CANCELLED" ? 200 : 409, code: result.job.state === "CANCELLED" ? "RESERVATION_JOB_CANCELLED" : "BOOKING_RESULT_UNKNOWN", data: result };
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
      const schoolRes = store.schoolReservations.get(job.id) || null;
      return {
        status: 200,
        code: "RESERVATION_EVIDENCE_OK",
        data: {
          job_id: job.id,
          state: job.state,
          school_reservation: schoolRes
        }
      };
    }
  );

  register("GET", "/api/v1/pricing/library-booking", "getLibraryBookingPricing", "public", async () => ({
    status: 200,
    code: "PRICING_OK",
    data: {
      price_version: getReservationPriceVersion(store.pricingMicropeach),
      currency_symbol: "🍑",
      local_device_mode_micropeach: 0,
      cloud_hosted_mode_micropeach: store.pricingMicropeach,
      charge_policy: "POST_CONFIRMATION_ONLY"
    }
  }));

  // --- 39..40 Notifications ---
  register("GET", "/api/v1/notifications", "listMyNotifications", "bearer", async ({ auth }) => {
    const notifications = Array.from(store.notifications.values()).filter(
      (n) => n.cloud_user_id === auth.cloudUserId
    );
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
        sandboxOverride: Boolean(item?.sandbox_override)
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
        sandboxOverride: Boolean(body?.sandbox_override)
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
      sandboxOverride: Boolean(body?.sandbox_override)
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
      if (typeof body?.kill_switch !== "boolean") throw new ContractError("BAD_REQUEST", "kill_switch must be an explicit boolean");
      store.requireRole({ cloudUserId: auth.cloudUserId, roles: store.getUserRoles(auth.cloudUserId) }, ["PLATFORM_OWNER", "OPERATIONS_ADMIN", "SCHOOL_OPERATOR"]);
      if (!body.kill_switch) {
        schoolProvider.assertOperationAllowed("CREATE_BOOKING", { ...school, kill_switch: false }, { requireLiveAutomation: true });
      }
      school.kill_switch = body.kill_switch;
      school.updated_at = new Date().toISOString();
      try { store.saveSnapshot({ required: true }); } catch (err) {
        // Never leave an unpersisted permission expansion active in this process.
        school.kill_switch = true;
        throw err;
      }
      store.recordAudit({
        actor_kind: "ADMIN", actor_ref: auth.cloudUserId, action: "TOGGLE_SCHOOL_KILL_SWITCH",
        resource_kind: "school_integration", resource_ref: params.schoolId,
        outcome: school.kill_switch ? "KILL_SWITCH_ON" : "KILL_SWITCH_OFF"
      });
      await redisBuffer.invalidate("schools");
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
      const roles = ["PLATFORM_OWNER", "SCHOOL_OPERATOR"];
      store.requireRole({ cloudUserId: auth.cloudUserId, roles: store.getUserRoles(auth.cloudUserId) }, roles);
      if (body?.secondary_approver_ref) throw new ContractError("BAD_REQUEST", "The second operator must authenticate and approve the request themselves");
      const pending = school.authorization_request;
      if (body?.authorization_request_id) {
        if (!pending || pending.id !== body.authorization_request_id || pending.status !== "PENDING") throw new ContractError("CONFLICT", "Authorization request is not pending");
        if (pending.primary_actor_ref === auth.cloudUserId) throw new ContractError("FORBIDDEN", "A different authenticated operator must approve");
        store.requireRole({ cloudUserId: pending.primary_actor_ref, roles: store.getUserRoles(pending.primary_actor_ref) }, roles);
        if (Date.parse(pending.expires_at) <= Date.now()) throw new ContractError("CONFLICT", "Authorization evidence has expired");
        if ((body.evidence_ref && body.evidence_ref !== pending.evidence_ref) || (body.expires_at && body.expires_at !== pending.expires_at)) throw new ContractError("CONFLICT", "Approval must match the original evidence and expiry");
        school.authorization_approval = { ...pending, status: "APPROVED", secondary_actor_ref: auth.cloudUserId, approved_at: new Date().toISOString() };
        school.authorization_evidence_ref = pending.evidence_ref;
        school.approver_primary_ref = pending.primary_actor_ref;
        school.approver_secondary_ref = auth.cloudUserId;
        pending.status = "APPROVED";
      } else {
        const evidenceRef = String(body?.evidence_ref || body?.authorization_evidence_ref || "").trim();
        if (!evidenceRef || !Number.isFinite(Date.parse(body?.expires_at)) || Date.parse(body.expires_at) <= Date.now()) throw new ContractError("BAD_REQUEST", "Non-empty evidence_ref and future expires_at are required");
        school.authorization_request = { id: crypto.randomUUID(), status: "PENDING", evidence_ref: evidenceRef, expires_at: body.expires_at, primary_actor_ref: auth.cloudUserId, requested_at: new Date().toISOString() };
        school.authorization_approval = null;
        school.authorization_evidence_ref = null;
        school.approver_primary_ref = null;
        school.approver_secondary_ref = null;
      }
      // Approval never disables the kill switch implicitly.
      school.kill_switch = true;
      school.updated_at = new Date().toISOString();
      try { store.saveSnapshot({ required: true }); } catch (err) {
        school.authorization_approval = null;
        school.authorization_evidence_ref = null;
        school.approver_primary_ref = null;
        school.approver_secondary_ref = null;
        throw err;
      }
      store.recordAudit({ actor_kind: "ADMIN", actor_ref: auth.cloudUserId, action: "APPROVE_SCHOOL_AUTHORIZATION", resource_kind: "school_integration", resource_ref: params.schoolId, outcome: school.authorization_approval ? "APPROVED" : "PENDING_SECOND_APPROVAL" });
      await redisBuffer.invalidate("schools");
      return { status: 200, code: school.authorization_approval ? "SCHOOL_AUTHORIZATION_APPROVED" : "SCHOOL_AUTHORIZATION_PENDING", data: school };
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
          refundRequestId: body?.refund_request_id
        },
        nowMs
      );
      const refunded = order.payment_state === "REFUNDED";
      return { status: refunded ? 200 : 202,
        code: refunded ? "ADMIN_ORDER_REFUNDED" : "REFUND_APPROVAL_REQUIRED", data: order };
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
    const webTxn = identity.startWebTransaction({ returnTo: query.get("return_to") || "/" }, nowMs);
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
      if (Array.isArray(body.school_binding_upserts)) {
        for (const bItem of body.school_binding_upserts) {
          const studentNo = String(bItem?.student_no || "").trim();
          if (!studentNo) continue;
          const schoolId = bItem?.school_id || DEFAULT_SCHOOL_ID;
          let existingBinding = Array.from(store.schoolBindings.values()).find(
            (b) => b.cloud_user_id === auth.cloudUserId && b.school_id === schoolId && !b.revoked_at
          );
          if (!existingBinding) {
            const bindingId = crypto.randomUUID();
            existingBinding = {
              id: bindingId,
              cloud_user_id: auth.cloudUserId,
              school_id: schoolId,
              student_no: studentNo,
              student_no_masked: studentNo.length >= 4 ? `${studentNo.slice(0, 2)}***${studentNo.slice(-2)}` : "***",
              status: "DELEGATED_ACTIVE",
              credential_ref: null,
              credential_expires_at: new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString(),
              created_at: new Date(nowMs).toISOString(),
              revoked_at: null
            };
            store.schoolBindings.set(bindingId, existingBinding);
          } else {
            existingBinding.student_no = studentNo;
            existingBinding.student_no_masked = studentNo.length >= 4 ? `${studentNo.slice(0, 2)}***${studentNo.slice(-2)}` : "***";
            existingBinding.status = "DELEGATED_ACTIVE";
          }
          if (bItem?.delegated_secret && String(bItem.delegated_secret).trim()) {
            const encrypted = kmsVault.encryptSecret({
              bindingId: existingBinding.id,
              schoolId,
              credentialKind: "DELEGATED_SESSION_BUNDLE",
              plaintext: String(bItem.delegated_secret).trim(),
              expiresAt: new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString()
            });
            store.encryptedCredentials.set(encrypted.id, encrypted);
            existingBinding.credential_ref = encrypted.id;
            existingBinding.credential_expires_at = encrypted.expires_at;
          }
          const hasActiveConsent = Array.from(store.consents.values()).some(
            (c) => c.cloud_user_id === auth.cloudUserId && c.school_id === schoolId && !c.withdrawn_at && ["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"].every((scope) => c.scope_list?.includes(scope))
          );
          if (!hasActiveConsent) {
            const cid = crypto.randomUUID();
            store.consents.set(cid, {
              id: cid,
              cloud_user_id: auth.cloudUserId,
              school_id: schoolId,
              scope_list: ["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"],
              policy_version: "policy-2026-11-v4",
              granted_at: new Date(nowMs).toISOString(),
              withdrawn_at: null
            });
          }
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
          if (job && job.cloud_user_id === auth.cloudUserId && job.state !== "CANCELLED") {
            await reservationEngine.cancelConfirmedOrActiveJob(job.id, nowMs);
          }
          const plan = store.reservationPlans.get(cancelId);
          if (plan && plan.cloud_user_id === auth.cloudUserId) {
            plan.enabled = false;
            for (const j of store.reservationJobs.values()) {
              if (j.plan_id === plan.id && j.state !== "CANCELLED") {
                await reservationEngine.cancelConfirmedOrActiveJob(j.id, nowMs);
              }
            }
          }
        }
      }

      await syncUserToSso(auth.cloudUserId);
    }

    const snapshot = await buildUserSyncSnapshot(auth.cloudUserId);
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
      store.requireRole(auth, ["PLATFORM_OWNER", "FINANCE_OPERATOR"]);
      const orderId = params.orderId;
      const targetOrder = store.reservationOrders.get(orderId);
      if (!targetOrder) {
        throw new ContractError("NOT_FOUND", "Order not found");
      }
      const refundRequest = targetOrder.refund_request;
      const order = await financeService.issueRefundForOrder(
        orderId,
        {
          amountMicropeach: refundRequest?.amount_micropeach ?? targetOrder.price_micropeach,
          reason: body?.reason || refundRequest?.reason || "站点管理员在后台发起 🍑 退还",
          actorRef: auth.cloudUserId,
          refundRequestId: body?.refund_request_id
        },
        nowMs
      );
      const refunded = order.payment_state === "REFUNDED";
      if (refunded) await syncUserToSso(order.cloud_user_id);
      return {
        status: refunded ? 200 : 202,
        code: refunded ? "ADMIN_ORDER_REFUNDED" : "REFUND_APPROVAL_REQUIRED",
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
      if (job.state === "CONFIRMED") {
        const schoolReservation = store.schoolReservations.get(job.id) || null;
        return {
          status: 200,
          code: "RESERVATION_JOB_EXECUTED",
          data: {
            job,
            schoolReservation,
            order: Array.from(store.reservationOrders.values()).find((order) => order.job_id === job.id) || null
          }
        };
      }
      if (nowMs < Date.parse(job.fire_at)) throw new ContractError("BOOKING_WINDOW_CLOSED", "Cannot execute before the accepted target time");
      await reservationEngine.runScheduleEvent(jobId, "PRECHECK", nowMs);
      await reservationEngine.runScheduleEvent(jobId, "FINAL_CHECK", nowMs);
      const fireRes = await reservationEngine.runScheduleEvent(jobId, "FIRE", nowMs);
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
        status: cancelRes.job.state === "CANCELLED" ? 200 : 409,
        code: cancelRes.job.state === "CANCELLED" ? "RESERVATION_SEAT_CANCELLED" : "SCHOOL_CANCELLATION_UNCONFIRMED",
        data: cancelRes
      };
    }
  );

  register(
    "POST",
    "/api/v1/school-bindings/bind-live",
    "bindLiveSchoolAccount",
    "bearer",
    async ({ auth, body, nowMs }) => {
      const schoolId = body?.school_id || DEFAULT_SCHOOL_ID;
      const studentNoInput = String(body?.student_no || "").trim();
      const passwordInput = String(body?.password || "").trim();
      const rawTokenInput = String(body?.raw_token || "").trim();
      const casTgcInput = String(body?.cas_tgc || "").trim();

      const authRes = await schoolProvider.authenticateHautSession({
        raw_token: rawTokenInput,
        cas_tgc: casTgcInput,
        cas_jsessionid: "",
        student_no: studentNoInput,
        password: passwordInput,
        isLiveCredential: true
      });

      const resolvedStudentNo = authRes.userInfo?.userNo || studentNoInput || "20240001";
      let binding = Array.from(store.schoolBindings.values()).find(
        (b) => b.cloud_user_id === auth.cloudUserId && b.school_id === schoolId && !b.revoked_at
      );
      if (!binding) {
        const bindingId = crypto.randomUUID();
        binding = {
          id: bindingId,
          cloud_user_id: auth.cloudUserId,
          school_id: schoolId,
          student_no: resolvedStudentNo,
          student_no_masked: resolvedStudentNo.length >= 4 ? `${resolvedStudentNo.slice(0, 2)}***${resolvedStudentNo.slice(-2)}` : "***",
          user_name: authRes.userInfo?.userName || "",
          department: authRes.userInfo?.department || "",
          status: "DELEGATED_ACTIVE",
          credential_ref: null,
          credential_expires_at: null,
          created_at: new Date(nowMs).toISOString(),
          revoked_at: null
        };
        store.schoolBindings.set(bindingId, binding);
      } else {
        binding.student_no = resolvedStudentNo;
        binding.student_no_masked = resolvedStudentNo.length >= 4 ? `${resolvedStudentNo.slice(0, 2)}***${resolvedStudentNo.slice(-2)}` : "***";
        binding.user_name = authRes.userInfo?.userName || binding.user_name || "";
        binding.department = authRes.userInfo?.department || binding.department || "";
        binding.status = "DELEGATED_ACTIVE";
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
      binding.credential_ref = encrypted.id;
      binding.credential_expires_at = encrypted.expires_at;

      let consent = Array.from(store.consents.values()).find(
        (c) => c.cloud_user_id === auth.cloudUserId && c.school_id === schoolId && !c.withdrawn_at && ["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"].every((scope) => c.scope_list?.includes(scope))
      );
      if (!consent) {
        const cid = crypto.randomUUID();
        consent = {
          id: cid,
          cloud_user_id: auth.cloudUserId,
          school_id: schoolId,
          scope_list: ["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"],
          policy_version: "policy-2026-11-v4",
          granted_at: new Date(nowMs).toISOString(),
          withdrawn_at: null
        };
        store.consents.set(cid, consent);
      }

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
    async ({ auth, query, nowMs }) => {
      const dateParam =
        query.get("booking_date") ||
        query.get("date") ||
        new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const binding = Array.from(store.schoolBindings.values()).find(
        (b) => b.cloud_user_id === auth.cloudUserId && !b.revoked_at && b.credential_ref
      );
      if (!binding) {
        throw new ContractError("CAMPUS_BINDING_REQUIRED", "请先绑定学号与统一认证密码");
      }
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
    async ({ auth, query, nowMs }) => {
      const regionId = Number(query.get("region_id") || 7);
      const dateParam =
        query.get("booking_date") ||
        query.get("date") ||
        new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const binding = Array.from(store.schoolBindings.values()).find(
        (b) => b.cloud_user_id === auth.cloudUserId && !b.revoked_at && b.credential_ref
      );
      if (!binding) {
        throw new ContractError("CAMPUS_BINDING_REQUIRED", "请先绑定学号与统一认证密码");
      }
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

  async function inject({
    method = "GET",
    url = "/healthz",
    headers = {},
    body = undefined,
    nowMs = Date.now()
  }) {
    const requestId = generateRequestId(headers["x-request-id"] || headers["X-Request-Id"]);
    try {
      const parsedUrl = new URL(url, "http://localhost");
      const pathname = parsedUrl.pathname;
      const upperMethod = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();

      // Static assets copied 1:1 from xpeach-sso (/static/app.css, /static/app.js, /static/xpeach-logo.png)
      if (upperMethod === "GET" && (pathname.startsWith("/static/") || pathname === "/favicon.ico")) {
        const staticDir = path.join(REPO_ROOT, "apps/console/public/static");
        const fileName =
          pathname === "/favicon.ico"
            ? "xpeach-logo.png"
            : path.basename(pathname);
        const filePath = path.join(staticDir, fileName);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(fileName).toLowerCase();
          const mime =
            ext === ".css"
              ? "text/css; charset=utf-8"
              : ext === ".js"
                ? "application/javascript; charset=utf-8"
                : ext === ".png"
                  ? "image/png"
                  : "application/octet-stream";
          const buf = fs.readFileSync(filePath);
          return {
            status: 200,
            headers: {
              "content-type": mime,
              "cache-control": "public, max-age=3600",
              "x-request-id": requestId
            },
            rawBody: buf,
            body: okEnvelope("STATIC_ASSET_OK", { file: fileName }, requestId)
          };
        }
      }

      const webConsoleRoutes = new Map([
        ["/", "portal"],
        ["/portal", "portal"],
        ["/reservations", "reservations"],
        ["/parcels", "parcels"],
        ["/community", "community"],
        ["/orders", "orders"],
        ["/console", "console"],
        ["/console/", "console"]
      ]);

      if (upperMethod === "GET" && webConsoleRoutes.has(pathname)) {
        const activeNav = webConsoleRoutes.get(pathname);
        const cookieAuth = identity.verifyWebSessionCookie(
          headers?.cookie || headers?.Cookie || "",
          nowMs
        );
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
          isTrustedSsoReferer &&
          !parsedUrl.searchParams.has("web_ticket") &&
          !parsedUrl.searchParams.has("code")
        ) {
          const webTxn = identity.startWebTransaction({ returnTo: pathname }, nowMs);
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
          pricingMicropeach: store.pricingMicropeach,
          campusContent: store.getCampusContent(DEFAULT_SCHOOL_ID, { includeDisabled: false })
        };
        if (cookieAuth) {
          const wallet = await financeService.getWalletSnapshot(cookieAuth.cloudUserId);
          const bindings = Array.from(store.schoolBindings.values()).filter(
            (b) => b.cloud_user_id === cookieAuth.cloudUserId
          );
          const plans = Array.from(store.reservationPlans.values()).filter(
            (p) => p.cloud_user_id === cookieAuth.cloudUserId
          );
          const jobs = Array.from(store.reservationJobs.values()).filter(
            (j) => j.cloud_user_id === cookieAuth.cloudUserId
          );
          const parcels = parcelHub.listUserParcels(cookieAuth.cloudUserId);
          const orders = Array.from(store.reservationOrders.values()).filter(
            (o) => o.cloud_user_id === cookieAuth.cloudUserId
          );
          const isAdminUser =
            cookieAuth.roles.includes("ADMIN") ||
            cookieAuth.roles.includes("OPERATOR") ||
            cookieAuth.roles.includes("FINANCE") ||
            cookieAuth.roles.includes("FINANCE_OPERATOR") ||
            cookieAuth.roles.includes("PLATFORM_OWNER") ||
            cookieAuth.user.role === "admin";
          let adminCtx = {};
          if (isAdminUser && activeNav === "console") {
            const financeMatrix = await financeBridge.getSiteFinanceMatrix();
            adminCtx = {
              adminStats: {
                users_count: store.users.size,
                active_bindings_count: Array.from(store.schoolBindings.values()).filter(
                  (b) => !b.revoked_at
                ).length,
                jobs_count: store.reservationJobs.size,
                orders_count: store.reservationOrders.size,
                parcels_count: store.parcels.size,
                audit_events_count: store.auditEvents.length
              },
              allOrders: Array.from(store.reservationOrders.values()).map((o) => {
                const u = store.users.get(o.cloud_user_id);
                return {
                  ...o,
                  username: u?.username || u?.display_name || o.cloud_user_id,
                  sso_subject: u?.subject || "-"
                };
              }),
              allJobs: Array.from(store.reservationJobs.values()),
              schools: Array.from(store.schoolIntegrations.values()),
              campusContent: store.getCampusContent(DEFAULT_SCHOOL_ID, { includeDisabled: true }),
              auditEvents: store.auditEvents.slice(-50).reverse(),
              financeMatrix
            };
          }
          consoleCtx = {
            user: cookieAuth.user,
            wallet,
            roles: cookieAuth.roles,
            activeNav,
            bindings,
            plans,
            jobs,
            parcels,
            orders,
            pricingMicropeach: store.pricingMicropeach,
            campusContent: store.getCampusContent(DEFAULT_SCHOOL_ID, { includeDisabled: false }),
            accessToken: cookieAuth.accessToken,
            ...adminCtx
          };
        }

        return {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store, no-cache, must-revalidate",
            "x-request-id": requestId
          },
          rawBody: renderConsoleHtml(consoleCtx),
          body: okEnvelope("CONSOLE_PORTAL_OK", { portal: "cloud-in-school-console" }, requestId)
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
            params[name] = decodeURIComponent(m[idx + 1]);
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
          String(
            headers?.["x-rate-limit-key"] ||
              headers?.["x-real-ip"] ||
              headers?.["x-forwarded-for"] ||
              "anon_default"
          )
            .split(",")[0]
            .trim() || "anon_default";
        const maxReqs = Math.max(1, Number(headers?.["x-rate-limit-max"]) || 60);
        const rl = await redisBuffer.checkRateLimit(
          `${matchedRoute.operationId}:${clientIp}`,
          maxReqs,
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
        body: parsedBody
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
