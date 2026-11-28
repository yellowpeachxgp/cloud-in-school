import path from "node:path";
import fs from "node:fs";
import {
  REPO_ROOT,
  ContractError,
  DEFAULT_RESERVATION_PRICE_MICROPEACH,
  DEFAULT_SCHOOL_ID,
  MICROPEACH_PER_PEACH
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
import { CommunityService } from "../../../packages/community/src/index.mjs";
import { AvailabilityService } from "../../../packages/availability/src/index.mjs";
import { PlaceStatusService } from "../../../packages/place-status/src/index.mjs";
import { LedgerService } from "../../../packages/ledger/src/index.mjs";
import { SyncService } from "../../../packages/sync/src/index.mjs";
import {
  PluginRegistryAndBroker,
  loadPluginDirectory
} from "../../../packages/plugin-sdk/src/index.mjs";
import { RedisGatewayBuffer } from "../../../packages/redis-buffer/src/index.mjs";
import { createCampusRouter } from "./router.mjs";
import { createCoreRoutes, createExtensionRoutes } from "./routes/index.mjs";

// Host-owned reference command implementations. They preserve the documented
// built-in example behavior without evaluating the plugin artifacts themselves.
async function referenceGreetCampusHandler({ userId }) {
  return {
    greeting: `欢迎使用河南工业大学扩展卡片 (${userId})`,
    campus: "莲花街校区",
    timestamp: new Date().toISOString()
  };
}

async function referenceQueryStationHoursHandler() {
  return {
    station_name: "莲花街北苑菜鸟驿站",
    open_hours: "08:30 - 21:00",
    crowd_level: "LOW",
    supports_self_pickup: true
  };
}

const DEFAULT_REFERENCE_PLUGIN_SOURCES = Object.freeze([
  {
    pluginId: "org.example.hello-campus",
    dir: path.join(REPO_ROOT, "examples/hello-campus-plugin"),
    commandHandlers: { greetCampus: referenceGreetCampusHandler }
  },
  {
    pluginId: "org.example.parcel-station",
    dir: path.join(REPO_ROOT, "examples/parcel-station-plugin"),
    commandHandlers: { queryStationHours: referenceQueryStationHoursHandler }
  }
]);

// Host-configured trust for the bundled signed examples. The public key is
// pinned to the publisher id here in host configuration; it is never read
// from the plugin package or accepted from an install request.
const DEFAULT_REFERENCE_PLUGIN_TRUST_ROOT = Object.freeze({
  "dis-official-examples-2026": "MCowBQYDK2VwAyEArHKa2jgA8ALyo4xS8gB7jJs8HNS9LJy670FXblTj8XA="
});

function trustRootWithReferenceEntries(optionValue) {
  const defaults = Object.entries(DEFAULT_REFERENCE_PLUGIN_TRUST_ROOT);
  if (optionValue === null || optionValue === undefined || optionValue === "") return defaults;
  if (optionValue instanceof Map) return [...defaults, ...optionValue.entries()];
  if (Array.isArray(optionValue)) return [...defaults, ...optionValue];
  if (typeof optionValue === "string") return [...defaults, optionValue];
  if (typeof optionValue === "object") return [...defaults, ...Object.entries(optionValue)];
  throw new ContractError(
    "BAD_REQUEST",
    "pluginTrustedPublisherKeys must be a publisher-to-public-key mapping"
  );
}

function sanitizeReferencePluginError(error) {
  if (error?.code === "ENOENT") {
    return "required reference plugin file is missing";
  }
  const rawMessage = error instanceof Error ? error.message : String(error);
  return rawMessage.split(REPO_ROOT).join("<repo>");
}

function loadSignedReferencePlugins({ pluginBroker, sources, logger = console }) {
  const statuses = [];
  for (const source of sources || []) {
    const sourcePluginId = source?.pluginId || source?.plugin_id || "unknown";
    try {
      if (!source?.dir) {
        throw new Error("reference plugin source directory is missing");
      }
      const loaded = loadPluginDirectory(source.dir);
      const publisherId = loaded.manifest?.signature?.key_id;
      const publicKeyBase64 = pluginBroker.trustedPublicKeyForPublisher(publisherId);
      if (!publicKeyBase64) {
        const error = new Error(
          "reference plugin publisher '" + String(publisherId || "unknown") + "' is missing from the configured trust root"
        );
        error.code = "PLUGIN_REFERENCE_UNTRUSTED";
        throw error;
      }
      // The packaged public key remains required as a consistency attestation,
      // but it is never trusted by itself. A missing file preserves the AC-04/S5
      // degraded-load signal; a mismatch means the package and host root diverged.
      const packagedPublicKey = fs.readFileSync(path.join(source.dir, "plugin-signing-public.key"), "utf8").trim();
      if (packagedPublicKey !== publicKeyBase64) {
        throw new ContractError(
          "PLUGIN_SIGNATURE_INVALID",
          "reference plugin packaged public key does not match the configured publisher trust root"
        );
      }
      const verified = pluginBroker.registerPluginPackage({
        manifest: loaded.manifest,
        artifactMap: loaded.artifactMap,
        publicKeyBase64,
        commandHandlers: source.commandHandlers || {},
        isHostReference: true
      });
      statuses.push({
        plugin_id: verified.plugin_id,
        name: verified.name,
        version: verified.version,
        status: "LOADED",
        error_code: null,
        error_message: null
      });
    } catch (error) {
      const status = {
        plugin_id: sourcePluginId,
        name: null,
        version: null,
        status: "FAILED",
        error_code: error?.code || "PLUGIN_REFERENCE_LOAD_FAILED",
        error_message: sanitizeReferencePluginError(error)
      };
      statuses.push(status);
      logger?.warn?.(
        `[reference-plugins] ${status.plugin_id} load failed (${status.error_code}): ${status.error_message}`
      );
    }
  }
  return statuses;
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
  const community = options.community || new CommunityService(store);
  const availability = options.availability || new AvailabilityService(store);
  const placeStatus = options.placeStatus || new PlaceStatusService(store);
  const ledger = options.ledger || new LedgerService(store);
  const syncE2ee = options.syncE2ee || new SyncService(store);
  // Production fail-closed gate: dangerous combinations must abort startup —
  // a mock/sandbox write path, missing durable snapshot or absent KMS material
  // can never be "test leftovers" in production.
  const isProductionEnv = process.env.NODE_ENV === "production";
  if (isProductionEnv) {
    const violations = [];
    if (schoolProvider?.mockBackend) {
      violations.push("schoolProvider.mockBackend must not be configured in production");
    }
    if (schoolProvider?.allowSandboxFallback) {
      violations.push("schoolProvider.allowSandboxFallback must be false in production");
    }
    if (financeBridge?.allowSandboxFallback && !financeBridge?.realDebitsEnabled) {
      violations.push("financeBridge sandbox fallback must be disabled in production");
    }
    if (!store?.snapshotPath || store?.requireDurableSnapshot !== true) {
      violations.push("durable snapshot (snapshotPath + requireDurableSnapshot) is required in production");
    }
    if (!options.kmsVault && !process.env.KMS_MASTER_SEED) {
      violations.push("KMS_MASTER_SEED is required in production");
    }
    if (violations.length > 0) {
      throw new Error(
        "Refusing to start in production mode:\n - " + violations.join("\n - ")
      );
    }
  }
  const pluginBroker = options.pluginBroker || new PluginRegistryAndBroker({
    store,
    environment: options.environment || process.env.NODE_ENV || "development",
    trustedPublisherKeys: trustRootWithReferenceEntries(options.pluginTrustedPublisherKeys),
    allowUnlistedPublishers: options.pluginAllowUnlistedPublishers,
    failureThreshold: options.pluginFailureThreshold
  });
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

  // Pre-register the two signed reference plugins. Each plugin is isolated:
  // one broken/missing reference package must not prevent the other one from
  // loading, and failures are logged + surfaced instead of being swallowed.
  const referencePluginSources =
    options.referencePluginSources === undefined
      ? DEFAULT_REFERENCE_PLUGIN_SOURCES
      : options.referencePluginSources;
  const referencePluginLoadStatus = loadSignedReferencePlugins({
    pluginBroker,
    sources: referencePluginSources,
    logger: options.referencePluginLogger || console
  });

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

  const drainState = { isDraining: false };
  const isDraining = () => Boolean(drainState.isDraining);

  const ctx = {
    store,
    kmsVault,
    identity,
    cookieVault,
    schoolProvider,
    financeBridge,
    financeService,
    reservationEngine,
    parcelHub,
    community,
    availability,
    placeStatus,
    ledger,
    syncE2ee,
    pluginBroker,
    referencePluginLoadStatus,
    redisBuffer,
    trustProxyHeaders,
    allowSandboxProviders,
    drainState,
    isDraining,
    syncUserToSso,
    buildUserSyncSnapshot,
    extractBearer,
    isAdminOrOperatorAuth
  };

  const coreRoutes = createCoreRoutes(ctx);
  const extensionRoutes = createExtensionRoutes(ctx);
  ctx.getCoreRouteCount = () => coreRoutes.length;
  const router = createCampusRouter(ctx, { coreRoutes, extensionRoutes });

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
    community,
    availability,
    placeStatus,
    ledger,
    syncE2ee,
    pluginBroker,
    referencePluginLoadStatus,
    redisBuffer,
    inject: router.inject,
    createHttpServer: router.createHttpServer,
    getRegisteredRoutes: router.getRegisteredRoutes,
    getRegisteredCoreRoutes: router.getRegisteredCoreRoutes,
    getRegisteredExtensionRoutes: router.getRegisteredExtensionRoutes,
    getRouteBehaviorFingerprint: router.getRouteBehaviorFingerprint,
    setDraining: router.setDraining,
    isDraining: router.isDraining,
    registerLifecycleTask: router.registerLifecycleTask,
    unregisterLifecycleTask: router.unregisterLifecycleTask,
    getInFlightTasks: router.getInFlightTasks,
    getInFlightWrites: router.getInFlightWrites
  };
}
