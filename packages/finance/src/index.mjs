import crypto from "node:crypto";
import { ContractError, getReservationPriceVersion } from "../../contracts/src/index.mjs";

/**
 * Direct XPEACH SSO 🍑 Wallet Synchronization & Post-Confirmation Deduction Engine.
 * - Uses 🍑 directly as the unified currency from XPEACH SSO (`GET /api/v1/users/:uuid/peach` & `POST /api/v1/users/:uuid/peach/adjust`).
 * - Deterministic idempotency keys:
 *   - Debit:  `dis:reservation:<orderUUID>:debit:v1`
 *   - Refund: `dis:reservation:<orderUUID>:refund:v1`
 */
export const MICROPEACH_PER_PEACH = 10_000;

export function buildDebitEventKey(orderId) {
  return `dis:reservation:${orderId}:debit:v1`;
}

export function buildRefundEventKey(orderId) {
  return `dis:reservation:${orderId}:refund:v1`;
}

export function isSafeSsoSubject(ssoSubject) {
  if (!ssoSubject || typeof ssoSubject !== "string") return false;
  const trimmed = ssoSubject.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return false;
  if (/[\/\\?#\0\r\n\s]/.test(trimmed)) return false;
  return /^[a-zA-Z0-9._:-]{2,128}$/.test(trimmed);
}

export class IsolatedFinanceBridge {
  constructor(options = {}) {
    this.ssoBaseUrl = options.ssoBaseUrl || process.env.SSO_FINANCE_BASE_URL || "https://sso.xpeach.codes";
    this.internalServiceKey =
      options.internalServiceKey || process.env.SSO_INTERNAL_SERVICE_KEY || "";
    this.realDebitsEnabled =
      options.realDebitsEnabled !== undefined
        ? options.realDebitsEnabled === true
        : process.env.FINANCE_ENABLE_REAL_DEBITS === "true";
    this.allowSandboxFallback =
      options.allowSandboxFallback !== undefined
        ? Boolean(options.allowSandboxFallback)
        : process.env.NODE_ENV !== "production" && !this.realDebitsEnabled;
    this.httpTimeoutMs = Number(options.httpTimeoutMs) || 8_000;
    // Only used when unit tests explicitly call setSandboxBalance() or use synthetic test subjects in non-production
    this.sandboxBalancesMicropeach = new Map();
    this.processedIdempotencyKeys = new Map();
    this.inFlightLocks = new Map();
  }

  setSandboxBalance(cloudUserId, micropeach) {
    this.sandboxBalancesMicropeach.set(cloudUserId, Number(micropeach));
  }

  getSandboxBalance(cloudUserId) {
    if (this.sandboxBalancesMicropeach.has(cloudUserId)) {
      return this.sandboxBalancesMicropeach.get(cloudUserId);
    }
    if (this.allowSandboxFallback) {
      this.sandboxBalancesMicropeach.set(cloudUserId, 50_000);
      return 50_000;
    }
    return 0;
  }

  _isSyntheticTestSubject(ssoSubject) {
    if (!this.allowSandboxFallback) return false;
    if (!ssoSubject || typeof ssoSubject !== "string") return true;
    return (
      ssoSubject.startsWith("xpeach_user_") ||
      ssoSubject.startsWith("sso_") ||
      ssoSubject.startsWith("sub_") ||
      ssoSubject.startsWith("test_")
    );
  }

  async readWallet(cloudUserId, ssoSubject, userObj = null) {
    // 1) Explicit unit test sandbox override
    if (this.sandboxBalancesMicropeach.has(cloudUserId)) {
      const micro = this.sandboxBalancesMicropeach.get(cloudUserId);
      const peach = micro / MICROPEACH_PER_PEACH;
      return {
        cloud_user_id: cloudUserId,
        sso_subject: ssoSubject || null,
        currency_symbol: "🍑",
        peach_balance: peach,
        peach_balance_formatted: peach.toFixed(2),
        peach_used: 0,
        peach_used_formatted: "0.00",
        micropeach_balance: micro,
        hold_supported: false,
        fetched_at: new Date().toISOString(),
        source: "xpeach-sso-sandbox"
      };
    }

    // 2) Live XPEACH SSO query for real SSO users
    const isRealUser = !this._isSyntheticTestSubject(ssoSubject);
    if (isRealUser && isSafeSsoSubject(ssoSubject) && (this.internalServiceKey || userObj?.sso_access_token)) {
      try {
        const headers = { Accept: "application/json" };
        if (this.internalServiceKey) {
          headers["X-Internal-Service-Key"] = this.internalServiceKey;
        } else if (userObj?.sso_access_token) {
          headers.Authorization = `Bearer ${userObj.sso_access_token}`;
        }
        const resp = await fetch(
          `${this.ssoBaseUrl.replace(/\/+$/, "")}/api/v1/users/${encodeURIComponent(ssoSubject)}/peach`,
          {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(this.httpTimeoutMs)
          }
        );
        if (resp.ok) {
          const data = await resp.json();
          const peachBalance = Number(data.peachBalance ?? data.peach_balance ?? 0);
          const peachUsed = Number(data.peachUsed ?? data.peach_used ?? 0);
          const peachBalanceFormatted = String(
            data.peachBalanceFormatted ?? peachBalance.toFixed(2)
          );
          const peachUsedFormatted = String(
            data.peachUsedFormatted ?? peachUsed.toFixed(2)
          );
          const walletObj = {
            quota: Number(data.quota ?? 0),
            usedQuota: Number(data.usedQuota ?? 0),
            requestCount: Number(data.requestCount ?? 0),
            group: data.group || userObj?.group || "默认分组",
            affCode: data.affCode || userObj?.aff_code || "",
            peachBalance,
            peachUsed,
            peachBalanceFormatted,
            peachUsedFormatted
          };
          if (userObj) {
            userObj.peach_wallet = walletObj;
            if (walletObj.group) userObj.group = walletObj.group;
            if (walletObj.affCode) userObj.aff_code = walletObj.affCode;
          }
          return {
            cloud_user_id: cloudUserId,
            sso_subject: ssoSubject,
            username: data.username || userObj?.username || userObj?.display_name,
            currency_symbol: "🍑",
            peach_balance: peachBalance,
            peach_balance_formatted: peachBalanceFormatted,
            peach_used: peachUsed,
            peach_used_formatted: peachUsedFormatted,
            request_count: walletObj.requestCount,
            group: walletObj.group,
            aff_code: walletObj.affCode,
            micropeach_balance: Math.round(peachBalance * MICROPEACH_PER_PEACH),
            hold_supported: false,
            fetched_at: new Date().toISOString(),
            source: "xpeach-sso-live"
          };
        }
      } catch {
        // Fall through to cached peach_wallet on userObj if network call fails
      }
    }

    // 3) Cached SSO peach_wallet from OIDC login (never fake 5.0 🍑!)
    if (userObj?.peach_wallet && typeof userObj.peach_wallet === "object") {
      const pw = userObj.peach_wallet;
      const peachBalance = Number(pw.peachBalance ?? 0);
      const peachUsed = Number(pw.peachUsed ?? 0);
      return {
        cloud_user_id: cloudUserId,
        sso_subject: ssoSubject,
        username: userObj.username || userObj.display_name,
        currency_symbol: "🍑",
        peach_balance: peachBalance,
        peach_balance_formatted: String(pw.peachBalanceFormatted ?? peachBalance.toFixed(2)),
        peach_used: peachUsed,
        peach_used_formatted: String(pw.peachUsedFormatted ?? peachUsed.toFixed(2)),
        request_count: Number(pw.requestCount ?? 0),
        group: pw.group || userObj.group || "默认分组",
        aff_code: pw.affCode || userObj.aff_code || "",
        micropeach_balance: Math.round(peachBalance * MICROPEACH_PER_PEACH),
        hold_supported: false,
        fetched_at: new Date().toISOString(),
        source: "xpeach-sso-cached"
      };
    }

    // 4) If real user has no wallet yet (or sandbox fallback is disabled), return 0.00 🍑 (never fake 5.0 🍑)
    if (isRealUser || !this.allowSandboxFallback) {
      return {
        cloud_user_id: cloudUserId,
        sso_subject: ssoSubject,
        username: userObj?.username || userObj?.display_name,
        currency_symbol: "🍑",
        peach_balance: 0,
        peach_balance_formatted: "0.00",
        peach_used: 0,
        peach_used_formatted: "0.00",
        request_count: 0,
        group: userObj?.group || "默认分组",
        aff_code: userObj?.aff_code || "",
        micropeach_balance: 0,
        hold_supported: false,
        fetched_at: new Date().toISOString(),
        source: "xpeach-sso-uninitialized"
      };
    }

    // 5) Synthetic unit-test fallback (only when allowSandboxFallback is true)
    const micro = this.getSandboxBalance(cloudUserId);
    const peach = micro / MICROPEACH_PER_PEACH;
    return {
      cloud_user_id: cloudUserId,
      sso_subject: ssoSubject || null,
      currency_symbol: "🍑",
      peach_balance: peach,
      peach_balance_formatted: peach.toFixed(2),
      peach_used: 0,
      peach_used_formatted: "0.00",
      micropeach_balance: micro,
      hold_supported: false,
      fetched_at: new Date().toISOString(),
      source: "xpeach-sso-sandbox"
    };
  }

  async adjustBalanceIdempotent({
    cloudUserId,
    ssoSubject,
    deltaPeach,
    deltaMicropeach,
    eventKey,
    reason,
    userObj = null
  }) {
    const resolvedMicro =
      typeof deltaMicropeach === "number" && Number.isInteger(deltaMicropeach)
        ? deltaMicropeach
        : typeof deltaPeach === "number"
          ? Math.round(deltaPeach * MICROPEACH_PER_PEACH)
          : 0;
    const resolvedPeach =
      typeof deltaPeach === "number" ? deltaPeach : resolvedMicro / MICROPEACH_PER_PEACH;

    if (!Number.isInteger(resolvedMicro) || resolvedMicro === 0) {
      throw new ContractError("BAD_REQUEST", "🍑 adjustment amount must be non-zero");
    }
    if (!eventKey || !/^dis:reservation:[0-9a-fA-F-]{36}:(debit|refund):v1$/.test(eventKey)) {
      throw new ContractError("BAD_REQUEST", `Invalid Finance Bridge idempotency event_key: ${eventKey}`);
    }

    while (this.inFlightLocks.has(eventKey)) {
      await this.inFlightLocks.get(eventKey);
    }

    let releaseLock;
    const lockPromise = new Promise((resolve) => {
      releaseLock = resolve;
    });
    this.inFlightLocks.set(eventKey, lockPromise);

    try {
      if (this.processedIdempotencyKeys.has(eventKey)) {
        const cached = this.processedIdempotencyKeys.get(eventKey);
        return { ...cached, deduplicated: true };
      }

      const hasExplicitSandbox = this.sandboxBalancesMicropeach.has(cloudUserId);
      const isRealUser = !hasExplicitSandbox && !this._isSyntheticTestSubject(ssoSubject);

      if (this.realDebitsEnabled && !hasExplicitSandbox) {
        if (!this.internalServiceKey || !isSafeSsoSubject(ssoSubject)) {
          throw new ContractError(
            "SSO_UNAVAILABLE",
            "Real SSO 🍑 debit requires valid SSO subject and internal service key"
          );
        }
        const resp = await fetch(
          `${this.ssoBaseUrl.replace(/\/+$/, "")}/api/v1/users/${encodeURIComponent(ssoSubject)}/peach/adjust`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Internal-Service-Key": this.internalServiceKey,
              "X-Idempotency-Key": eventKey
            },
            body: JSON.stringify({
              delta_peach: resolvedPeach,
              idempotency_key: eventKey,
              source_site: "dis",
              reason
            }),
            signal: AbortSignal.timeout(this.httpTimeoutMs)
          }
        );
        const body = await resp.json().catch(() => ({}));
        if (resp.status === 409 || body.error === "insufficient_peach_balance") {
          return {
            ok: false,
            error: "WALLET_INSUFFICIENT",
            deduplicated: false
          };
        }
        if (!resp.ok || !body.ok) {
          throw new ContractError("SSO_UNAVAILABLE", "SSO peach/adjust call failed");
        }
        const nextPeach = Number(body.wallet?.peachBalance ?? body.peachBalance ?? 0);
        if (userObj && body.wallet) {
          userObj.peach_wallet = body.wallet;
        }
        // Report cross-site financial ledger event to XPeach SSO (/api/v1/finance/events)
        try {
          await fetch(`${this.ssoBaseUrl.replace(/\/+$/, "")}/api/v1/finance/events`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "X-Internal-Service-Key": this.internalServiceKey,
              "X-Idempotency-Key": `${eventKey}:ledger`
            },
            body: JSON.stringify({
              site_short_code: "dis",
              site_name: "日在校园",
              user_id: ssoSubject,
              user_uuid: ssoSubject,
              username: userObj?.username || userObj?.display_name || ssoSubject,
              event_type: resolvedPeach < 0 ? "library_seat_reservation_debit" : "library_seat_reservation_refund",
              direction: resolvedPeach < 0 ? "debit" : "credit",
              peach_amount: Math.abs(resolvedPeach),
              delta_peach: Math.abs(resolvedPeach),
              currency: "PEACH",
              order_ref: eventKey,
              order_no: eventKey,
              idempotency_key: `${eventKey}:ledger`,
              already_applied_on_source: true,
              apply_wallet_sync: false,
              description: reason,
              occurred_at: new Date().toISOString()
            }),
            signal: AbortSignal.timeout(this.httpTimeoutMs)
          });
        } catch {
          // Best-effort cross-site ledger reporting
        }
        const out = {
          ok: true,
          deduplicated: Boolean(body.deduplicated),
          ssoRequestId: body.request_id || `sso_req_${crypto.randomUUID().slice(0, 12)}`,
          peachBalanceAfter: nextPeach,
          balanceAfterMicropeach: Math.round(nextPeach * MICROPEACH_PER_PEACH)
        };
        this.processedIdempotencyKeys.set(eventKey, out);
        return out;
      }

      if (isRealUser) {
        throw new ContractError("SSO_UNAVAILABLE", "Live wallet adjustments are disabled; synthetic sandbox credit cannot settle a real user order");
      }

      const currentMicro = this.getSandboxBalance(cloudUserId);
      if (resolvedMicro < 0 && currentMicro + resolvedMicro < 0) {
        return {
          ok: false,
          error: "WALLET_INSUFFICIENT",
          deduplicated: false,
          peachBalanceAfter: currentMicro / MICROPEACH_PER_PEACH,
          balanceAfterMicropeach: currentMicro
        };
      }
      const nextMicro = currentMicro + resolvedMicro;
      this.sandboxBalancesMicropeach.set(cloudUserId, nextMicro);
      const out = {
        ok: true,
        deduplicated: false,
        ssoRequestId: `sso_sim_${crypto.randomUUID().slice(0, 12)}`,
        peachBalanceAfter: nextMicro / MICROPEACH_PER_PEACH,
        balanceAfterMicropeach: nextMicro
      };
      this.processedIdempotencyKeys.set(eventKey, out);
      return out;
    } finally {
      this.inFlightLocks.delete(eventKey);
      releaseLock();
    }
  }

  async getSiteFinanceMatrix() {
    if (!this.internalServiceKey) {
      return null;
    }
    try {
      const resp = await fetch(
        `${this.ssoBaseUrl.replace(/\/+$/, "")}/api/v1/finance/matrix?site=dis`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Internal-Service-Key": this.internalServiceKey
          },
          signal: AbortSignal.timeout(this.httpTimeoutMs)
        }
      );
      if (!resp.ok) return null;
      return await resp.json().catch(() => null);
    } catch {
      return null;
    }
  }
}

export class FinanceSagaService {
  constructor(store, financeBridge) {
    this.store = store;
    this.financeBridge = financeBridge;
    this.orderLocks = new Map();
  }

  async withOrderLock(lockKey, fn) {
    while (this.orderLocks.has(lockKey)) {
      await this.orderLocks.get(lockKey);
    }
    let release;
    const p = new Promise((resolve) => {
      release = resolve;
    });
    this.orderLocks.set(lockKey, p);
    try {
      return await fn();
    } finally {
      this.orderLocks.delete(lockKey);
      release();
    }
  }

  async getWalletSnapshot(cloudUserId) {
    const user = this.store.users.get(cloudUserId);
    const snapshot = await this.financeBridge.readWallet(cloudUserId, user?.subject, user);
    if (typeof this.store.saveSnapshot === "function") {
      this.store.saveSnapshot();
    }
    return snapshot;
  }

  persistFinancialState(cloudUserId) {
    const required = this.financeBridge.realDebitsEnabled && !this.financeBridge.sandboxBalancesMicropeach?.has(cloudUserId);
    const saved = typeof this.store.saveSnapshot === "function" && this.store.saveSnapshot({ required });
    if (required && saved !== true) {
      throw new ContractError("CONFLICT", "Live wallet operations require durable financial state");
    }
  }

  assertLiveDebitAllowed(job, cloudUserId) {
    if (!this.financeBridge.realDebitsEnabled || this.financeBridge.sandboxBalancesMicropeach?.has(cloudUserId)) return;
    const evidence = job && this.store.schoolReservations.get(job.id);
    if (job?.capability !== "AUTHORIZED_AUTOMATION" || job?.state !== "CONFIRMED" ||
        !job?.result_verified_at || evidence?.official_status !== "CONFIRMED" ||
        !evidence?.external_booking_id || !evidence?.evidence_sha256 ||
        /^(haut_mock_|mock[_-])/.test(String(evidence.external_booking_id))) {
      throw new ContractError("SCHOOL_PERMISSION_REQUIRED", "Only an authorized, verified live reservation may trigger a real debit");
    }
  }

  async createAndSettleOrderForConfirmedJob({ job, plan, nowMs = Date.now() }) {
    let order = Array.from(this.store.reservationOrders.values()).find((o) => o.job_id === job.id);
    if (!order) {
      if (plan?.price_micropeach !== 0) this.assertLiveDebitAllowed(job, job.cloud_user_id);
      // Legacy plans without an accepted quote must be re-created, never charged at today's price.
      const acceptedPrice = plan?.price_micropeach;
      if (!Number.isSafeInteger(acceptedPrice) || acceptedPrice < 0 ||
          plan?.price_version !== getReservationPriceVersion(acceptedPrice) || !plan?.price_accepted_at) {
        throw new ContractError("CONFLICT", "Reservation plan has no valid accepted price snapshot");
      }
      const orderId = crypto.randomUUID();
      const pricePeach = acceptedPrice / MICROPEACH_PER_PEACH;
      order = {
        id: orderId,
        job_id: job.id,
        cloud_user_id: job.cloud_user_id,
        price_peach: pricePeach,
        price_micropeach: acceptedPrice,
        price_version: plan.price_version,
        accepted_at: plan.price_accepted_at,
        school_result: "CONFIRMED",
        payment_state: acceptedPrice === 0 ? "NOT_REQUIRED" : "DEBIT_PENDING",
        paid_at: null,
        created_at: new Date(nowMs).toISOString()
      };
      this.store.reservationOrders.set(order.id, order);
      this.store.outboxEvents.push({
        id: crypto.randomUUID(),
        aggregate_type: "reservation_order",
        aggregate_id: order.id,
        event_type: "ORDER_CHARGE_REQUIRED",
        payload_json: {
          order_id: order.id,
          event_key: buildDebitEventKey(order.id),
          peach_amount: pricePeach,
          amount_micropeach: order.price_micropeach
        },
        created_at: new Date(nowMs).toISOString(),
        delivered_at: null
      });
    }

    if (order.price_micropeach === 0) {
      return order;
    }
    return this.executeDebitForOrder(order.id, nowMs);
  }

  async executeDebitForOrder(orderId, nowMs = Date.now()) {
    return this.withOrderLock(orderId, async () => {
      const order = this.store.reservationOrders.get(orderId);
      if (!order) throw new ContractError("NOT_FOUND", "Reservation order not found");
      if (order.school_result !== "CONFIRMED") {
        throw new ContractError("CONFLICT", "Cannot debit an unconfirmed school reservation");
      }
      if (order.payment_state === "REFUNDED") {
        throw new ContractError("CONFLICT", "Cannot debit an order that has already been refunded");
      }
      if (order.payment_state === "PAID" || order.payment_state === "NOT_REQUIRED") {
        return order;
      }

      this.assertLiveDebitAllowed(this.store.reservationJobs.get(order.job_id), order.cloud_user_id);
      const eventKey = buildDebitEventKey(order.id);
      let op = this.store.financeOperations.get(eventKey);
      const pricePeach = order.price_peach ?? order.price_micropeach / MICROPEACH_PER_PEACH;
      if (!op) {
        op = {
          id: crypto.randomUUID(),
          order_id: order.id,
          kind: "DEBIT",
          event_key: eventKey,
          peach_amount: pricePeach,
          amount_micropeach: order.price_micropeach,
          status: "IN_FLIGHT",
          sso_request_id: null,
          last_error_code: null,
          attempt_count: 0,
          created_at: new Date(nowMs).toISOString(),
          updated_at: new Date(nowMs).toISOString()
        };
        this.store.financeOperations.set(eventKey, op);
      }

      op.attempt_count += 1;
      op.status = "IN_FLIGHT";
      op.updated_at = new Date(nowMs).toISOString();
      this.persistFinancialState(order.cloud_user_id);
      const user = this.store.users.get(order.cloud_user_id);

      let bridgeRes;
      try {
        bridgeRes = await this.financeBridge.adjustBalanceIdempotent({
          cloudUserId: order.cloud_user_id,
          ssoSubject: user?.subject,
          deltaPeach: -pricePeach,
          deltaMicropeach: -order.price_micropeach,
          eventKey,
          reason: `日在校园图书馆占座预约扣费 (${order.id})`,
          userObj: user
        });
      } catch (err) {
        op.status = "FAILED_RETRYABLE";
        op.last_error_code = err?.code || "SSO_UNAVAILABLE";
        this.persistFinancialState(order.cloud_user_id);
        throw err;
      }

      if (bridgeRes?.ok !== true && bridgeRes?.error === "WALLET_INSUFFICIENT") {
        op.status = "FAILED_INSUFFICIENT";
        op.last_error_code = "WALLET_INSUFFICIENT";
        order.payment_state = "PAYMENT_DUE";
        this.persistFinancialState(order.cloud_user_id);
        return order;
      }

      if (bridgeRes?.ok !== true) {
        op.status = "FAILED_RETRYABLE";
        op.last_error_code = bridgeRes?.error || "SSO_UNAVAILABLE";
        this.persistFinancialState(order.cloud_user_id);
        throw new ContractError("SSO_UNAVAILABLE", "Debit was not confirmed by the finance bridge");
      }
      op.status = "SUCCEEDED";
      op.last_error_code = null;
      op.sso_request_id = bridgeRes.ssoRequestId;
      order.payment_state = "PAID";
      order.paid_at = order.paid_at || new Date(nowMs).toISOString();
      this.persistFinancialState(order.cloud_user_id);
      return order;
    });
  }

  async issueRefundForOrder(orderId, { peachAmount, amountMicropeach, reason, actorRef, refundRequestId }, nowMs = Date.now()) {
    return this.withOrderLock(orderId, async () => {
      // actorRef comes only from the authenticated request context, never the request body.
      const cleanActor = typeof actorRef === "string" ? actorRef.trim() : "";
      const requireFinanceActor = (id) => {
        if (!this.store.users.has(id)) throw new ContractError("FORBIDDEN", "Authenticated finance operator required");
        this.store.requireRole({ cloudUserId: id }, ["PLATFORM_OWNER", "FINANCE_OPERATOR"]);
      };
      requireFinanceActor(cleanActor);
      const order = this.store.reservationOrders.get(orderId);
      if (!order) throw new ContractError("NOT_FOUND", "Order not found");
      if (order.payment_state === "REFUNDED") {
        this.persistFinancialState(order.cloud_user_id);
        return order;
      }
      if (order.payment_state !== "PAID") {
        throw new ContractError("CONFLICT", "Only PAID orders are eligible for refund");
      }
      const resolvedMicro =
        typeof amountMicropeach === "number" && Number.isSafeInteger(amountMicropeach)
          ? amountMicropeach
          : typeof peachAmount === "number" ? Math.round(peachAmount * MICROPEACH_PER_PEACH) : 0;
      if (!Number.isSafeInteger(resolvedMicro) || resolvedMicro <= 0 || resolvedMicro > order.price_micropeach) {
        throw new ContractError("BAD_REQUEST", "Refund amount must be positive and no greater than the paid amount");
      }
      const cleanReason = typeof reason === "string" ? reason.trim() : "";
      if (!cleanReason) throw new ContractError("BAD_REQUEST", "Refund reason is required");

      let approval = order.refund_request;
      if (!approval) {
        if (refundRequestId) throw new ContractError("CONFLICT", "Refund request does not exist");
        approval = {
          id: crypto.randomUUID(),
          amount_micropeach: resolvedMicro,
          reason: cleanReason,
          requested_by: cleanActor,
          requested_at: new Date(nowMs).toISOString(),
          approved_by: null,
          approved_at: null,
          status: "PENDING_APPROVAL"
        };
        order.refund_request = approval;
        this.store.recordAudit({ actor_kind: "FINANCE_OPERATOR", actor_ref: cleanActor,
          action: "REQUEST_REFUND", resource_kind: "reservation_order", resource_ref: order.id,
          outcome: "PENDING_APPROVAL" });
        this.persistFinancialState(order.cloud_user_id);
        return order;
      }
      if (approval.amount_micropeach !== resolvedMicro || approval.reason !== cleanReason) {
        throw new ContractError("CONFLICT", "Refund amount and reason must match the saved request");
      }
      if (!refundRequestId && approval.requested_by === cleanActor && approval.status === "PENDING_APPROVAL") {
        this.persistFinancialState(order.cloud_user_id);
        return order; // Idempotent initiation, without approval or money movement.
      }
      if (refundRequestId !== approval.id) throw new ContractError("CONFLICT", "Matching refund_request_id is required");
      if (approval.requested_by === cleanActor) {
        throw new ContractError("FORBIDDEN", "A different authenticated finance operator must approve the refund");
      }
      requireFinanceActor(approval.requested_by);
      if (approval.approved_by && approval.approved_by !== cleanActor) {
        throw new ContractError("FORBIDDEN", "Only the recorded second approver may retry this refund");
      }
      approval.approved_by = cleanActor;
      approval.approved_at ||= new Date(nowMs).toISOString();
      approval.status = "APPROVED";
      // Persist the exact two-party authorization before any outbound adjustment.
      this.persistFinancialState(order.cloud_user_id);

      const eventKey = buildRefundEventKey(order.id);
      const resolvedPeach = resolvedMicro / MICROPEACH_PER_PEACH;
      let op = this.store.financeOperations.get(eventKey);
      if (op && op.amount_micropeach !== resolvedMicro) {
        throw new ContractError("CONFLICT", "Existing refund operation has a different amount");
      }
      if (!op) {
        op = {
          id: crypto.randomUUID(), order_id: order.id, kind: "REFUND", event_key: eventKey,
          peach_amount: resolvedPeach, amount_micropeach: resolvedMicro, status: "IN_FLIGHT",
          sso_request_id: null, last_error_code: null, attempt_count: 0,
          created_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString()
        };
        this.store.financeOperations.set(eventKey, op);
      }
      op.attempt_count += 1;
      op.status = "IN_FLIGHT";
      op.updated_at = new Date(nowMs).toISOString();
      this.persistFinancialState(order.cloud_user_id);
      const user = this.store.users.get(order.cloud_user_id);
      let bridgeRes;
      try {
        bridgeRes = await this.financeBridge.adjustBalanceIdempotent({
          cloudUserId: order.cloud_user_id, ssoSubject: user?.subject,
          deltaPeach: resolvedPeach, deltaMicropeach: resolvedMicro, eventKey,
          reason: `日在校园预约订单退还 (${order.id}): ${approval.reason}`, userObj: user
        });
        if (bridgeRes?.ok !== true) {
          const failure = new ContractError("SSO_UNAVAILABLE", "Refund was not confirmed by the finance bridge");
          failure.bridgeError = bridgeRes?.error || "SSO_UNAVAILABLE";
          throw failure;
        }
      } catch (err) {
        op.status = "FAILED_RETRYABLE";
        op.last_error_code = err?.bridgeError || err?.code || "SSO_UNAVAILABLE";
        approval.status = "FAILED_RETRYABLE";
        this.persistFinancialState(order.cloud_user_id);
        throw err;
      }
      op.status = "SUCCEEDED";
      op.last_error_code = null;
      op.sso_request_id = bridgeRes.ssoRequestId;
      approval.status = "REFUNDED";
      order.payment_state = "REFUNDED";
      order.refunded_micropeach = resolvedMicro;
      order.refunded_at = new Date(nowMs).toISOString();
      this.store.recordAudit({ actor_kind: "FINANCE_OPERATOR",
        actor_ref: `${approval.requested_by}+${cleanActor}`, action: "REFUND_ORDER",
        resource_kind: "reservation_order", resource_ref: order.id, outcome: "REFUNDED" });
      this.persistFinancialState(order.cloud_user_id);
      return order;
    });
  }
}
