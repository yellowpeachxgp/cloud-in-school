import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {
  REPO_ROOT,
  ContractError,
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
import { TripleScheduleEngine } from "../../../packages/reservations/src/index.mjs";
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

  function extractBearer(headers, nowMs) {
    const authHeader = headers?.authorization || headers?.Authorization || "";
    const m = String(authHeader).match(/^Bearer\s+(.+)$/i);
    let bearerErr = null;
    if (m) {
      try {
        return identity.verifyAccessToken(m[1].trim(), nowMs);
      } catch (err) {
        bearerErr = err;
      }
    }
    const cookieAuth = identity.verifyWebSessionCookie(
      headers?.cookie || headers?.Cookie || "",
      nowMs
    );
    if (cookieAuth) {
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
          school_reservation: sr
        };
      });
    const orders = Array.from(store.reservationOrders.values())
      .filter((o) => o.cloud_user_id === cloudUserId)
      .map((o) => ({
        ...o,
        price_peach: Number(o.price_peach ?? (o.price_micropeach || 1000) / 10000)
      }));
    const parcels = parcelHub.listUserParcels(cloudUserId);
    const parcelConnections = parcelHub.listConnections(cloudUserId);
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
      synced_at: new Date().toISOString()
    };
  }

  // --- 1..3 System & OpenAPI ---
  register("GET", "/healthz", "getHealthz", "none", async () => ({
    status: 200,
    code: "HEALTH_OK",
    data: {
      service: "cloud-in-school",
      status: "ok",
      version: "4.0.0"
    }
  }));

  register("GET", "/readyz", "getReadyz", "none", async () => ({
    status: 200,
    code: "READY_OK",
    data: {
      ready: kmsVault.kmsOnline,
      migrations_applied: Array.from(store.appliedMigrations),
      school_providers: ["school.haut.library"]
    }
  }));

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
  register("GET", "/api/v1/schools", "listSchools", "public", async () => ({
    status: 200,
    code: "SCHOOLS_LISTED",
    data: {
      schools: Array.from(store.schoolIntegrations.values()).map((s) => ({
        school_id: s.school_id,
        display_name: s.display_name,
        provider_id: s.provider_id,
        enabled: s.enabled,
        kill_switch: s.kill_switch
      }))
    }
  }));

  register(
    "GET",
    "/api/v1/schools/{schoolId}/library/capabilities",
    "getSchoolLibraryCapabilities",
    "public",
    async ({ params }) => {
      const integ = store.schoolIntegrations.get(params.schoolId);
      if (!integ) throw new ContractError("NOT_FOUND", `Unknown school: ${params.schoolId}`);
      return {
        status: 200,
        code: "SCHOOL_CAPABILITIES_OK",
        data: { capabilities: schoolProvider.getCapabilities(integ) }
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
      if (body?.preferred_seat_ids) {
        plan.preferences_json.preferred_seat_ids = body.preferred_seat_ids;
      }
      if (body?.preferred_area_ids) {
        plan.preferences_json.preferred_area_ids = body.preferred_area_ids;
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
    async ({ auth, params }) => {
      const plan = store.reservationPlans.get(params.planId);
      if (!plan || plan.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "Reservation plan not found");
      }
      plan.enabled = false;
      for (const j of store.reservationJobs.values()) {
        if (j.plan_id === plan.id && !["CONFIRMED", "FAILED", "CANCELLED"].includes(j.state)) {
          j.state = "CANCELLED";
          j.state_version += 1;
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
      job.state = "CANCELLED";
      job.state_version += 1;
      await syncUserToSso(auth.cloudUserId);
      return { status: 200, code: "RESERVATION_JOB_CANCELLED", data: job };
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
      price_version: "price-library-cloud-2026-11-v1",
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
      pluginBroker.registerPluginPackage({
        manifest: body.manifest,
        artifactMap: body.artifact_map || {},
        publicKeyBase64: body.public_key_base64 || pluginBroker.publicKeyBase64
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
        audit_events_count: store.auditEvents.length
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
      store.recordAudit({
        actor_kind: "ADMIN",
        actor_ref: auth.cloudUserId,
        action: "TOGGLE_SCHOOL_KILL_SWITCH",
        resource_kind: "school_integration",
        resource_ref: params.schoolId,
        outcome: school.kill_switch ? "KILL_SWITCH_ON" : "KILL_SWITCH_OFF"
      });
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
        if (
          !cookieAuth &&
          referer.includes("sso.xpeach.codes") &&
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

        let consoleCtx = { activeNav };
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

      if (upperMethod === "GET" && pathname === "/api/v1/auth/web/start") {
        const webTxn = identity.startWebTransaction(
          { returnTo: parsedUrl.searchParams.get("return_to") || "/" },
          nowMs
        );
        return {
          status: 302,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": requestId,
            Location: webTxn.redirect_url
          },
          body: okEnvelope("WEB_OIDC_REDIRECT", webTxn, requestId)
        };
      }

      if (upperMethod === "GET" && pathname === "/api/v1/auth/web/logout") {
        return {
          status: 302,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "x-request-id": requestId,
            "set-cookie": "dis_web_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
            Location: "/"
          },
          rawBody: "",
          body: okEnvelope("WEB_LOGGED_OUT", { logged_out: true }, requestId)
        };
      }

      if (upperMethod === "POST" && pathname === "/api/v1/auth/web/exchange") {
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
            "content-type": "application/json; charset=utf-8",
            "x-request-id": requestId,
            "set-cookie": `dis_web_session=${encodeURIComponent(
              cookieVal
            )}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
          },
          body: okEnvelope("WEB_SESSION_ISSUED", sessionRes, requestId)
        };
      }

      if (pathname === "/api/v1/sync/snapshot" && (upperMethod === "GET" || upperMethod === "POST")) {
        const auth = extractBearer(headers, nowMs);
        if (upperMethod === "POST" && body && typeof body === "object") {
          // 1) School binding upserts from Android App
          if (Array.isArray(body.school_binding_upserts)) {
            for (const bItem of body.school_binding_upserts) {
              const studentNo = String(bItem?.student_no || "").trim();
              if (!studentNo) continue;
              const schoolId = bItem?.school_id || "haut";
              let existingBinding = Array.from(store.schoolBindings.values()).find(
                (b) =>
                  b.cloud_user_id === auth.cloudUserId &&
                  b.school_id === schoolId &&
                  !b.revoked_at
              );
              if (!existingBinding) {
                const bindingId = crypto.randomUUID();
                existingBinding = {
                  id: bindingId,
                  cloud_user_id: auth.cloudUserId,
                  school_id: schoolId,
                  student_no: studentNo,
                  student_no_masked:
                    studentNo.length >= 4
                      ? `${studentNo.slice(0, 2)}***${studentNo.slice(-2)}`
                      : "***",
                  status: "DELEGATED_ACTIVE",
                  credential_ref: null,
                  credential_expires_at: new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString(),
                  created_at: new Date(nowMs).toISOString(),
                  revoked_at: null
                };
                store.schoolBindings.set(bindingId, existingBinding);
              } else {
                existingBinding.student_no = studentNo;
                existingBinding.student_no_masked =
                  studentNo.length >= 4
                    ? `${studentNo.slice(0, 2)}***${studentNo.slice(-2)}`
                    : "***";
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
                (c) => c.cloud_user_id === auth.cloudUserId && !c.withdrawn_at
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

          // 2) Parcel upserts from Android App (e.g. Xiaomi Express / SMS import)
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
                sandboxOverride: true
              });
            }
          }

          // 3) Parcel status updates (e.g. PICKED_UP)
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

          // 4) Reservation cancellations from Android App
          if (Array.isArray(body.reservation_cancellations)) {
            for (const cancelId of body.reservation_cancellations) {
              const job = store.reservationJobs.get(cancelId);
              if (job && job.cloud_user_id === auth.cloudUserId && job.state !== "CANCELLED") {
                await reservationEngine.cancelConfirmedOrActiveJob(job.id, nowMs).catch(() => {
                  job.state = "CANCELLED";
                  job.state_version += 1;
                });
              }
              const plan = store.reservationPlans.get(cancelId);
              if (plan && plan.cloud_user_id === auth.cloudUserId) {
                plan.enabled = false;
                for (const j of store.reservationJobs.values()) {
                  if (j.plan_id === plan.id && j.state !== "CANCELLED") {
                    await reservationEngine.cancelConfirmedOrActiveJob(j.id, nowMs).catch(() => {
                      j.state = "CANCELLED";
                      j.state_version += 1;
                    });
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
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": requestId
          },
          body: okEnvelope("SYNC_SNAPSHOT_OK", snapshot, requestId)
        };
      }

      const quickRefundMatch = pathname.match(/^\/api\/v1\/admin\/orders\/([^/]+)\/quick-refund$/);
      if (upperMethod === "POST" && quickRefundMatch) {
        const auth = extractBearer(headers, nowMs);
        const isAdminUser =
          auth.roles.includes("ADMIN") ||
          auth.roles.includes("OPERATOR") ||
          auth.roles.includes("FINANCE") ||
          store.users.get(auth.cloudUserId)?.role === "admin";
        if (!isAdminUser) {
          throw new ContractError("FORBIDDEN", "Admin privileges required for quick refund");
        }
        const orderId = decodeURIComponent(quickRefundMatch[1]);
        const targetOrder = store.reservationOrders.get(orderId);
        if (!targetOrder) {
          throw new ContractError("NOT_FOUND", "Order not found");
        }
        const order = await financeService.issueRefundForOrder(
          orderId,
          {
            amountMicropeach: targetOrder.price_micropeach || 1000,
            reason: body?.reason || "站点管理员在后台发起 🍑 退还",
            actorRef: auth.cloudUserId,
            secondApproverRef: `console_approver_${auth.cloudUserId}`
          },
          nowMs
        );
        await syncUserToSso(order.cloud_user_id);
        return {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": requestId
          },
          body: okEnvelope("ADMIN_ORDER_REFUNDED", order, requestId)
        };
      }

      const execNowMatch = pathname.match(/^\/api\/v1\/reservation-jobs\/([^/]+)\/execute-now$/);
      if (upperMethod === "POST" && execNowMatch) {
        const auth = extractBearer(headers, nowMs);
        const jobId = decodeURIComponent(execNowMatch[1]);
        const job = store.reservationJobs.get(jobId);
        if (!job || job.cloud_user_id !== auth.cloudUserId) {
          throw new ContractError("NOT_FOUND", "Reservation job not found");
        }
        const effectiveFireMs = Math.max(nowMs, new Date(job.fire_at).getTime());
        await reservationEngine.runScheduleEvent(jobId, "PRECHECK", effectiveFireMs);
        await reservationEngine.runScheduleEvent(jobId, "FINAL_CHECK", effectiveFireMs);
        const fireRes = await reservationEngine.runScheduleEvent(jobId, "FIRE", effectiveFireMs, {
          allowDateFallbackToToday: true
        });
        await syncUserToSso(auth.cloudUserId);
        return {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": requestId
          },
          body: okEnvelope("RESERVATION_JOB_EXECUTED", fireRes, requestId)
        };
      }

      const cancelSeatMatch = pathname.match(/^\/api\/v1\/reservation-jobs\/([^/]+)\/cancel-seat$/);
      if (upperMethod === "POST" && cancelSeatMatch) {
        const auth = extractBearer(headers, nowMs);
        const jobId = decodeURIComponent(cancelSeatMatch[1]);
        const job = store.reservationJobs.get(jobId);
        if (!job || job.cloud_user_id !== auth.cloudUserId) {
          throw new ContractError("NOT_FOUND", "Reservation job not found");
        }
        const cancelRes = await reservationEngine.cancelConfirmedOrActiveJob(jobId, nowMs);
        await syncUserToSso(auth.cloudUserId);
        return {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": requestId
          },
          body: okEnvelope("RESERVATION_SEAT_CANCELLED", cancelRes, requestId)
        };
      }

      if (upperMethod === "POST" && pathname === "/api/v1/school-bindings/bind-live") {
        const auth = extractBearer(headers, nowMs);
        const schoolId = body?.school_id || "haut";
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
            student_no_masked:
              resolvedStudentNo.length >= 4
                ? `${resolvedStudentNo.slice(0, 2)}***${resolvedStudentNo.slice(-2)}`
                : "***",
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
          binding.student_no_masked =
            resolvedStudentNo.length >= 4
              ? `${resolvedStudentNo.slice(0, 2)}***${resolvedStudentNo.slice(-2)}`
              : "***";
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
          (c) => c.cloud_user_id === auth.cloudUserId && !c.withdrawn_at
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
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": requestId
          },
          body: okEnvelope(
            "SCHOOL_BINDING_LIVE_VERIFIED",
            {
              id: binding.id,
              consent_id: consent.id,
              student_no: binding.student_no,
              user_name: authRes.userInfo?.userName || "",
              binding,
              consent,
              user_info: authRes.userInfo
            },
            requestId
          )
        };
      }

      if (upperMethod === "GET" && pathname === "/api/v1/schools/haut/library/live-regions") {
        const auth = extractBearer(headers, nowMs);
        const dateParam =
          parsedUrl.searchParams.get("booking_date") ||
          parsedUrl.searchParams.get("date") ||
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
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": requestId
          },
          body: okEnvelope(
            "LIVE_REGIONS_OK",
            {
              ...snap,
              current_booking: currentBooking,
              user_info: authRes.userInfo
            },
            requestId
          )
        };
      }

      if (upperMethod === "GET" && pathname === "/api/v1/schools/haut/library/live-seats") {
        const auth = extractBearer(headers, nowMs);
        const regionId = Number(parsedUrl.searchParams.get("region_id") || 7);
        const dateParam =
          parsedUrl.searchParams.get("booking_date") ||
          parsedUrl.searchParams.get("date") ||
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
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": requestId
          },
          body: okEnvelope("LIVE_SEATS_OK", snap, requestId)
        };
      }

      let matchedRoute = null;
      let params = {};
      for (const route of routes) {
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
      if (matchedRoute.auth === "bearer" || matchedRoute.auth === "bearer_rbac") {
        auth = extractBearer(headers, nowMs);
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
          "content-type": "application/json; charset=utf-8",
          "x-request-id": requestId,
          ...(result.headers || {})
        },
        body: envelope
      };
    } catch (err) {
      const errEnv = errorEnvelope(err, requestId);
      return {
        status: errEnv.httpStatus,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-request-id": requestId
        },
        body: errEnv.body
      };
    }
  }

  function createHttpServer() {
    return http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let parsedBody = undefined;
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = undefined;
        }
      }
      const response = await inject({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsedBody
      });
      res.writeHead(response.status, response.headers);
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
    inject,
    createHttpServer,
    getRegisteredRoutes
  };
}
