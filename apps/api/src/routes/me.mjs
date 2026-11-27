import crypto from "node:crypto";
import { route } from "./route-table.mjs";
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
        ...communityExport
      })
    };
  }),

  route("POST", "/api/v1/me/data-delete", "requestMyDataDelete", "bearer", async ({ auth, nowMs }) => {
    const cascade = store.haltAllUserPlansAndBindings(auth.cloudUserId, "USER_DATA_DELETE", nowMs);
    const momentsPurged = store.purgeUserMomentsData?.(auth.cloudUserId, nowMs) || null;
    const communityPurged = community?.purgeUserCommunityData?.(auth.cloudUserId, nowMs) || null;
    // Plans/bindings were already halted above with the USER_DATA_DELETE audit
    // reason; only revoke sessions here (unlinkXpeach stays false).
    identity.revokeAllUserSessions(auth.cloudUserId, {
      unlinkXpeach: false,
      reason: "USER_DATA_DELETE",
      nowMs
    });
    const user = store.users.get(auth.cloudUserId);
    if (user) user.status = "DELETED";
    store.flushSnapshotStrictSync?.();
    return {
      status: 202,
      code: "DATA_DELETE_ACCEPTED",
      data: {
        cloud_user_id: auth.cloudUserId,
        status: "DELETED",
        cancelled_job_ids: cascade.cancelledJobIds,
        moments_purged: momentsPurged,
        community_purged: communityPurged
      }
    };
  })
  ];
}
