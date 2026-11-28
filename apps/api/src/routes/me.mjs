import crypto from "node:crypto";
import { route } from "./route-table.mjs";
import { revokeAllUserSessionsInStore } from "../../../../packages/identity/src/index.mjs";
import { CommunityService } from "../../../../packages/community/src/index.mjs";
import { AvailabilityService } from "../../../../packages/availability/src/index.mjs";
import { PlaceStatusService } from "../../../../packages/place-status/src/index.mjs";
import { LedgerService } from "../../../../packages/ledger/src/index.mjs";
import { SyncService } from "../../../../packages/sync/src/index.mjs";
import {
  ContractError,
  DEFAULT_SCHOOL_ID,
  redactSensitiveFields
} from "../../../../packages/contracts/src/index.mjs";

export function createMeRoutes(ctx) {
  const {
    store,
    identity,
    financeService,
    parcelHub,
    community,
    availability,
    placeStatus,
    ledger,
    syncE2ee,
    syncUserToSso
  } = ctx;

  return [
  route("GET", "/api/v1/me", "getMyProfile", "bearer", async ({ auth }) => {
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
  }),

  route("GET", "/api/v1/me/devices", "listMyDevices", "bearer", async ({ auth }) => {
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
  }),

  route(
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
  ),

  route("GET", "/api/v1/me/wallet", "getMyWallet", "bearer", async ({ auth }) => {
    const wallet = await financeService.getWalletSnapshot(auth.cloudUserId);
    return { status: 200, code: "WALLET_OK", data: wallet };
  }),

  route("GET", "/api/v1/me/orders", "listMyOrders", "bearer", async ({ auth }) => {
    const orders = store.recordsForUser("reservationOrders", auth.cloudUserId);
    return { status: 200, code: "ORDERS_LISTED", data: { orders } };
  }),

  route(
    "POST",
    "/api/v1/me/orders/{orderId}/settle",
    "settleMyOrder",
    "bearer",
    async ({ auth, params, nowMs }) => {
      const order = store.reservationOrders.get(params.orderId);
      if (!order || order.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "Order not found");
      }
      if (order.school_result !== "CONFIRMED") {
        throw new ContractError("CONFLICT", "Order has no confirmed school result to settle");
      }
      if (["PAID", "REFUNDED", "NOT_REQUIRED"].includes(order.payment_state)) {
        throw new ContractError(
          "CONFLICT",
          "Order is already settled; a second charge is never permitted"
        );
      }
      if (!["DEBIT_PENDING", "PAYMENT_DUE"].includes(order.payment_state)) {
        throw new ContractError("CONFLICT", "Order is not awaiting settlement");
      }
      const settled = await financeService.executeDebitForOrder(order.id, nowMs);
      // Paused plans are NOT auto-revived — the user re-enables them
      // explicitly after settling (per delegation-stops-stay-stopped rule).
      await syncUserToSso(auth.cloudUserId);
      return {
        status: 200,
        code: settled.payment_state === "PAID" ? "ORDER_SETTLED" : "ORDER_SETTLE_PENDING",
        data: {
          order: settled,
          payment_state: settled.payment_state,
          message:
            settled.payment_state === "PAID"
              ? "欠款已结算；此前因欠款暂停的委托可在委托页手动重新开启"
              : "余额仍不足，请先为 XPeach 钱包充值后再试"
        }
      };
    }
  ),

  route("GET", "/api/v1/me/consents", "listMyConsents", "bearer", async ({ auth }) => {
    const consents = store.recordsForUser("consents", auth.cloudUserId);
    return { status: 200, code: "CONSENTS_LISTED", data: { consents } };
  }),

  route("POST", "/api/v1/me/consents", "grantConsent", "bearer", async ({ auth, body, nowMs }) => {
    const user = store.users.get(auth.cloudUserId);
    const authVer = Number(user?.auth_version || 1);
    const schoolId = body?.school_id || DEFAULT_SCHOOL_ID;
    const requestedScopes =
      Array.isArray(body?.scope_list) && body.scope_list.length > 0
        ? body.scope_list
        : ["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"];
    const requestedPurpose = typeof body?.purpose === "string" ? body.purpose.trim() : null;
    if (requestedPurpose) {
      const allowedPurposes = new Set([
        "SCHOOL_CREDENTIAL_ESCROW",
        "CLOUD_AUTO_BOOKING",
        "SERVICE_FEE_TERMS",
        "PARCEL_CLOUD_BACKUP",
        "PARCEL_AI_ASSISTANT",
        "E2EE_CLOUD_SYNC"
      ]);
      if (!allowedPurposes.has(requestedPurpose)) {
        throw new ContractError("BAD_REQUEST", "purpose is not a supported consent purpose");
      }
      const documentVersion = String(body?.document_version || "").trim();
      const documentSha256 = String(body?.document_sha256 || "").trim().toLowerCase();
      if (!documentVersion || documentVersion.length > 128) {
        throw new ContractError("BAD_REQUEST", "document_version is required for purpose-scoped consent");
      }
      if (!/^[0-9a-f]{64}$/.test(documentSha256)) {
        throw new ContractError("BAD_REQUEST", "document_sha256 must be a lowercase SHA-256 hex digest");
      }
      const purposeSchoolId = requestedPurpose === "E2EE_CLOUD_SYNC" ? (body?.school_id || "user") : schoolId;
      const activeSamePurpose = store.recordsForUser("consents", auth.cloudUserId).filter((c) => (
        c &&
        (c.school_id || DEFAULT_SCHOOL_ID) === purposeSchoolId &&
        !c.withdrawn_at &&
        Number(c.auth_version || 1) === authVer &&
        c.purpose === requestedPurpose
      ));
      const exact = activeSamePurpose.find((c) => (
        c.document_version === documentVersion && String(c.document_sha256 || "").toLowerCase() === documentSha256
      ));
      if (exact) {
        store.saveSnapshot?.();
        return { status: 201, code: "CONSENT_GRANTED", data: exact };
      }
      const id = crypto.randomUUID();
      const record = {
        id,
        cloud_user_id: auth.cloudUserId,
        school_id: purposeSchoolId,
        purpose: requestedPurpose,
        document_version: documentVersion,
        document_sha256: documentSha256,
        school_binding_id: body?.school_binding_id || null,
        scope_list: [requestedPurpose],
        policy_version: documentVersion,
        auth_version: authVer,
        granted_at: new Date(nowMs).toISOString(),
        withdrawn_at: null
      };
      for (const prior of activeSamePurpose) {
        prior.withdrawn_at = record.granted_at;
        prior.superseded_by_consent_id = id;
      }
      store.consents.set(id, record);
      store.indexUserScoped?.("consents", id, record.cloud_user_id);
      store.saveSnapshot?.();
      return { status: 201, code: "CONSENT_GRANTED", data: record };
    }
    const existingActive = store.getLatestActiveConsent(auth.cloudUserId, schoolId, authVer);
    if (existingActive) {
      const mergedScopes = Array.from(
        new Set([...(existingActive.scope_list || []), ...requestedScopes])
      );
      existingActive.scope_list = mergedScopes;
      for (const b of store.recordsForUser("schoolBindings", auth.cloudUserId)) {
        if (
          (b.school_id || DEFAULT_SCHOOL_ID) === schoolId &&
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
        (b.school_id || DEFAULT_SCHOOL_ID) === record.school_id &&
        !b.revoked_at &&
        b.status !== "REVOKED" &&
        Number(b.auth_version || 1) === authVer
      ) {
        b.consent_id = record.id;
      }
    }
    store.saveSnapshot?.();
    return { status: 201, code: "CONSENT_GRANTED", data: record };
  }),

  route(
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
      const syncWithdrawal = syncE2ee?.handleConsentWithdrawn?.(auth.cloudUserId, c, nowMs) || null;
      const e2eeOnlyConsent =
        c.purpose === "E2EE_CLOUD_SYNC" ||
        (Array.isArray(c.scope_list) && c.scope_list.length === 1 && c.scope_list[0] === "E2EE_CLOUD_SYNC");
      // E2EE cloud sync is an independent user-scope consent.  Withdrawing it must
      // fail-close sync ciphertext processing without revoking school credential
      // escrow or reservation delegation, which are separate consent domains.
      const cascade = e2eeOnlyConsent
        ? { cancelledJobIds: [] }
        : store.haltAllUserPlansAndBindings(
            auth.cloudUserId,
            "CONSENT_WITHDRAWN",
            nowMs
          );
      if (e2eeOnlyConsent) store.flushSnapshotStrictSync?.();
      return {
        status: 200,
        code: "CONSENT_WITHDRAWN_OK",
        data: {
          consent_id: c.id,
          withdrawn_at: c.withdrawn_at,
          sync_withdrawal: syncWithdrawal,
          cancelled_job_ids: cascade.cancelledJobIds
        }
      };
    }
  ),

  route("POST", "/api/v1/me/data-export", "requestMyDataExport", "bearer", async ({ auth }) => {
    const user = store.users.get(auth.cloudUserId);
    const bindings = store.recordsForUser("schoolBindings", auth.cloudUserId);
    const plans = store.recordsForUser("reservationPlans", auth.cloudUserId);
    const parcels = parcelHub.listUserParcels(auth.cloudUserId);
    const ms = store.momentsState || { posts: [], book_listings: [], anti_lost_tags: [] };
    const momentsPosts = (ms.posts || []).filter((p) => p?.owner_cloud_user_id === auth.cloudUserId);
    const momentsBooks = (ms.book_listings || []).filter((b) => b?.owner_cloud_user_id === auth.cloudUserId);
    const momentsTags = (ms.anti_lost_tags || []).filter((t) => t?.owner_cloud_user_id === auth.cloudUserId);
    const communityExport = community?.exportUserData?.(auth.cloudUserId) || {
      community_groups: [],
      community_group_members: [],
      community_group_invites: []
    };
    const availabilityExport = availability?.exportUserData?.(auth.cloudUserId) || {
      availability_shares: [],
      availability_busy_blocks: [],
      availability_polls: [],
      availability_poll_options: [],
      availability_poll_votes: [],
      availability_confirmed_group_events: []
    };
    const placeStatusExport = placeStatus?.exportUserData?.(auth.cloudUserId) || {
      place_status_reports: [],
      place_status_report_flags: [],
      place_status_subscriptions: []
    };
    const syncExport = syncE2ee?.exportUserData?.(auth.cloudUserId) || {
      sync_user_state: null,
      sync_devices: [],
      sync_blobs: [],
      sync_blob_mutations: [],
      sync_blob_anti_resurrection: [],
      sync_cursors: [],
      sync_transfer_usage: []
    };
    const ledgerExport = ledger?.exportUserData?.(auth.cloudUserId) || {
      ledger_entries: [],
      ledger_settlements: [],
      duty_rotas: [],
      duty_tasks: [],
      duty_swaps: [],
      repair_tickets: [],
      repair_ticket_revisions: [],
      repair_reviews: []
    };
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
        moments_anti_lost_tags: momentsTags,
        ...communityExport,
        ...availabilityExport,
        ...placeStatusExport,
        ...ledgerExport,
        ...syncExport
      })
    };
  }),

  route("POST", "/api/v1/me/data-delete", "requestMyDataDelete", "bearer", async ({ auth, nowMs }) => {
    // Data-delete专用原子路径：先在隔离纯数据副本中计算完整删后世界，
    // 单次耐久发布成功后才换 live 状态；发布前故障不触碰 live。这里不复用
    // 已退役的通用 copy-on-write overlay，也不给突变体异步逃逸的机会。
    const outcome = store.runDataDeleteAtomicCommitUnit((staging) => {
      const stagingCommunity = new CommunityService(staging);
      const stagingAvailability = new AvailabilityService(staging);
      const stagingPlaceStatus = new PlaceStatusService(staging);
      const stagingLedger = new LedgerService(staging);
      const stagingSync = new SyncService(staging);
      const cascade = staging.haltAllUserPlansAndBindings(auth.cloudUserId, "USER_DATA_DELETE", nowMs);
      const momentsPurged = staging.purgeUserMomentsData?.(auth.cloudUserId, nowMs) || null;
      // Availability erasure must run before membership rows are removed: its
      // busy blocks and votes are keyed by membership-period IDs.
      const availabilityPurged = stagingAvailability.purgeUserAvailabilityData?.(auth.cloudUserId, nowMs) || null;
      const communityPurged = stagingCommunity.purgeUserCommunityData?.(auth.cloudUserId, nowMs) || null;
      // Ledger erasure runs after community group/member deletion so groups whose
      // final member was erased cascade exactly like SQL 0007 ON DELETE CASCADE;
      // surviving group rows keep pseudonymous membership-period audit refs.
      const ledgerPurged = stagingLedger.purgeUserLedgerData?.(auth.cloudUserId, nowMs) || null;
      const pluginPurged = staging.purgeUserPluginData?.(auth.cloudUserId) || null;
      const placeStatusPurged = stagingPlaceStatus.purgeUserPlaceStatusData?.(auth.cloudUserId, nowMs) || null;
      const syncPurged = stagingSync.purgeUserSyncData?.(auth.cloudUserId, nowMs) || null;
      // Plans/bindings were already halted above with the USER_DATA_DELETE audit
      // reason; only revoke sessions here (unlinkXpeach stays false).
      revokeAllUserSessionsInStore(staging, auth.cloudUserId, {
        unlinkXpeach: false,
        reason: "USER_DATA_DELETE",
        nowMs
      });
      const user = staging.users.get(auth.cloudUserId);
      if (user) user.status = "DELETED";
      return { cascade, momentsPurged, availabilityPurged, communityPurged, ledgerPurged, pluginPurged, placeStatusPurged, syncPurged };
    });
    return {
      status: 202,
      code: "DATA_DELETE_ACCEPTED",
      data: {
        cloud_user_id: auth.cloudUserId,
        status: "DELETED",
        cancelled_job_ids: outcome.cascade.cancelledJobIds,
        moments_purged: outcome.momentsPurged,
        availability_purged: outcome.availabilityPurged,
        community_purged: outcome.communityPurged,
        ledger_purged: outcome.ledgerPurged,
        plugin_purged: outcome.pluginPurged,
        place_status_purged: outcome.placeStatusPurged,
        sync_purged: outcome.syncPurged
      }
    };
  })
  ];
}
