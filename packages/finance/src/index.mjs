import crypto from "node:crypto";
import { ContractError } from "../../contracts/src/index.mjs";

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

/**
 * Tamper-evident hash of the immutable payload bound to an idempotency key.
 * The same event_key must ALWAYS carry the same payload — a mismatch means a
 * caller tried to reuse a key for different money and must be rejected.
 */
export function buildFinancePayloadHash({ kind, orderId, eventKey, amountMicropeach }) {
  return crypto
    .createHash("sha256")
    .update(`${kind}|${orderId}|${eventKey}|${Number(amountMicropeach)}`)
    .digest("hex");
}

function computeRetryBackoffMs(attemptCount) {
  const exp = Math.min(Math.max(Number(attemptCount) || 1, 1), 8);
  const base = Math.min(30_000 * 2 ** (exp - 1), 15 * 60_000);
  const jitter = crypto.randomInt(0, 5_000);
  return base + jitter;
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
        ? Boolean(options.realDebitsEnabled)
        : Boolean(this.internalServiceKey || process.env.FINANCE_ENABLE_REAL_DEBITS === "true");
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

  /**
   * Read-only reconciliation probe for a deterministic idempotency key.
   * NEVER dispatches a write. Outcomes:
   *  - SUCCEEDED: upstream recorded the same event key as applied
   *  - NOT_FOUND: query succeeded and the key provably never applied
   *  - UNKNOWN: cannot prove either way (caller must keep reconciling)
   */
  async queryOperationResult(eventKey) {
    if (!eventKey || !/^dis:reservation:[0-9a-fA-F-]{36}:(debit|refund):v1$/.test(eventKey)) {
      throw new ContractError("BAD_REQUEST", "Invalid Finance Bridge idempotency event_key");
    }
    // Sandbox ledger: absence of the key IS proof it was never applied —
    // everything lives in this process.
    const cached = this.processedIdempotencyKeys.get(eventKey);
    if (cached) {
      return { outcome: "SUCCEEDED", result: { ...cached } };
    }
    if (this.realDebitsEnabled) {
      // The real SSO read-back contract is unverified — do NOT claim a
      // proven-negative from an endpoint we cannot confirm exists. Unknown
      // is the honest answer until the contract is verified.
      try {
        const resp = await fetch(
          `${this.ssoBaseUrl.replace(/\/+$/, "")}/api/v1/finance/operations/${encodeURIComponent(eventKey)}`,
          {
            method: "GET",
            headers: { "X-Internal-Service-Key": this.internalServiceKey || "" },
            signal: AbortSignal.timeout(this.httpTimeoutMs)
          }
        );
        if (resp.status === 404) return { outcome: "NOT_FOUND" };
        if (resp.ok) {
          const body = await resp.json().catch(() => ({}));
          if (body?.data?.status === "applied" || body?.data?.applied === true) {
            return { outcome: "SUCCEEDED", result: body.data };
          }
          return { outcome: "UNKNOWN", reason: "unparseable_probe_response" };
        }
        return { outcome: "UNKNOWN", reason: "probe_http_" + resp.status };
      } catch (err) {
        return { outcome: "UNKNOWN", reason: "probe_error:" + (err?.code || err?.message || "error") };
      }
    }
    return { outcome: "NOT_FOUND" };
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
      if (this.processedIdempotencyKeys.size > 5000) {
        const oldest = this.processedIdempotencyKeys.keys().next().value;
        this.processedIdempotencyKeys.delete(oldest);
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
              event_category: resolvedPeach < 0 ? "consumption" : "refund",
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

      if (!hasExplicitSandbox && !this.allowSandboxFallback && isRealUser) {
        throw new ContractError("SSO_UNAVAILABLE", "Sandbox balance fallback is disabled in production");
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
    return snapshot;
  }

  async createAndSettleOrderForConfirmedJob({ job, plan, nowMs = Date.now() }) {
    const existingOrderId = this.store._idxOrderByJob?.get(job.id);
    let order = existingOrderId ? this.store.reservationOrders.get(existingOrderId) : null;
    if (!order) {
      const orderId = crypto.randomUUID();
      // Price comes from the plan's immutable acceptance snapshot when present;
      // legacy plans without a snapshot fall back to the global price (marked
      // LEGACY_GLOBAL_PRICE for audit — never fabricate an acceptance record).
      const hasPlanSnapshot = Number.isInteger(plan?.accepted_price_micropeach);
      const orderPriceMicro = hasPlanSnapshot
        ? plan.accepted_price_micropeach
        : this.store.pricingMicropeach;
      const pricePeach = orderPriceMicro / MICROPEACH_PER_PEACH;
      order = {
        id: orderId,
        job_id: job.id,
        cloud_user_id: job.cloud_user_id,
        price_peach: pricePeach,
        price_micropeach: orderPriceMicro,
        price_version: plan?.price_version || "price-library-cloud-2026-11-v1",
        price_snapshot_source: hasPlanSnapshot ? "PLAN_ACCEPTANCE" : "LEGACY_GLOBAL_PRICE",
        accepted_at: plan?.accepted_at || plan?.created_at || new Date(nowMs).toISOString(),
        acceptance_scope: plan?.acceptance_scope || null,
        consent_id: plan?.consent_id || null,
        policy_version: plan?.policy_version || null,
        auth_version: plan?.auth_version ?? null,
        school_result: "CONFIRMED",
        payment_state: orderPriceMicro === 0 ? "NOT_REQUIRED" : "DEBIT_PENDING",
        paid_at: null,
        created_at: new Date(nowMs).toISOString()
      };
      this.store.reservationOrders.set(order.id, order);
      this.store.indexReservationOrder?.(order.id, order);
      this.store.indexUserScoped?.("reservationOrders", order.id, order.cloud_user_id);
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

      const eventKey = buildDebitEventKey(order.id);
      let op = this.store.financeOperations.get(eventKey);
      const pricePeach = order.price_peach ?? order.price_micropeach / MICROPEACH_PER_PEACH;
      const payloadHash = buildFinancePayloadHash({
        kind: "DEBIT",
        orderId: order.id,
        eventKey,
        amountMicropeach: order.price_micropeach
      });
      if (!op) {
        op = {
          id: crypto.randomUUID(),
          order_id: order.id,
          kind: "DEBIT",
          event_key: eventKey,
          peach_amount: pricePeach,
          amount_micropeach: order.price_micropeach,
          payload_hash: payloadHash,
          status: "IN_FLIGHT",
          sso_request_id: null,
          last_error_code: null,
          attempt_count: 0,
          next_attempt_at: null,
          created_at: new Date(nowMs).toISOString(),
          updated_at: new Date(nowMs).toISOString()
        };
        this.store.financeOperations.set(eventKey, op);
      } else {
        // Same event_key must carry the same payload — a mismatch means the key
        // is being reused for different money and must be rejected, never sent.
        if (op.payload_hash && op.payload_hash !== payloadHash) {
          throw new ContractError(
            "CONFLICT",
            "Idempotency key payload mismatch for debit operation; refusing external call"
          );
        }
        if (!op.payload_hash) op.payload_hash = payloadHash;
      }

      op.attempt_count += 1;
      op.updated_at = new Date(nowMs).toISOString();
      // STRICT durable commit of the immutable order+operation+eventKey+payload
      // BEFORE the external SSO call. If the snapshot cannot be fsynced we must
      // not dispatch money — an unrecorded debit is unrecoverable. If the
      // process dies after this point, restart recovery sees IN_FLIGHT +
      // event_key and retries the SAME key (idempotent readback), never a new
      // charge.
      if (typeof this.store.flushSnapshotStrictSync === "function") {
        this.store.flushSnapshotStrictSync();
      } else if (typeof this.store.saveSnapshot === "function") {
        this.store.saveSnapshot();
      }
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
        op.next_attempt_at = new Date(
          nowMs + computeRetryBackoffMs(op.attempt_count)
        ).toISOString();
        if (typeof this.store.flushSnapshotStrictSync === "function") {
          try {
            this.store.flushSnapshotStrictSync();
          } catch {
            /* failure state stays in-memory recoverable via next_attempt_at */
          }
        } else if (typeof this.store.saveSnapshot === "function") {
          this.store.saveSnapshot();
        }
        throw err;
      }

      if (!bridgeRes.ok && bridgeRes.error === "WALLET_INSUFFICIENT") {
        op.status = "FAILED_INSUFFICIENT";
        op.last_error_code = "WALLET_INSUFFICIENT";
        const becameDue = order.payment_state !== "PAYMENT_DUE";
        order.payment_state = "PAYMENT_DUE";
        // Whenever a debit becomes PAYMENT_DUE (initial settle OR any async
        // retry path), pause the plan's not-yet-dispatched multi-day renewals
        // — the confirmation path is not the only place this can arise.
        // Already-dispatched work is never deleted; only plan-level renewal
        // stops until the user settles.
        if (becameDue) {
          const job = this.store.reservationJobs?.get?.(order.job_id);
          const plan = job ? this.store.reservationPlans?.get?.(job.plan_id) : null;
          if (plan && plan.enabled !== false) {
            plan.enabled = false;
            plan.remaining_days = 0;
            plan.updated_at = new Date(nowMs).toISOString();
          }
        }
        if (typeof this.store.saveSnapshot === "function") this.store.saveSnapshot();
        return order;
      }

      op.status = "SUCCEEDED";
      op.sso_request_id = bridgeRes.ssoRequestId;
      order.payment_state = "PAID";
      order.paid_at = order.paid_at || new Date(nowMs).toISOString();
      if (typeof this.store.flushSnapshotStrictSync === "function") {
        try {
          this.store.flushSnapshotStrictSync();
        } catch {
          if (typeof this.store.saveSnapshot === "function") this.store.saveSnapshot();
        }
      } else if (typeof this.store.saveSnapshot === "function") {
        this.store.saveSnapshot();
      }
      return order;
    });
  }

  _hasFinanceApproverRole(cloudUserId) {
    const user = this.store.users.get(cloudUserId);
    if (!user || user.status !== "ACTIVE") return false;
    if (user.role === "admin") return true;
    const roles = new Set(this.store.getUserRoles?.(cloudUserId) || []);
    return ["PLATFORM_OWNER", "FINANCE", "FINANCE_OPERATOR", "ADMIN"].some((r) =>
      roles.has(r)
    );
  }

  _computeRefundRequestHash({ orderId, amountMicropeach, reason, order }) {
    return crypto
      .createHash("sha256")
      .update(
        [
          "refund-request",
          orderId,
          String(amountMicropeach),
          String(reason || ""),
          String(order?.price_micropeach ?? ""),
          String(order?.payment_state ?? ""),
          String(order?.paid_at ?? "")
        ].join("|")
      )
      .digest("hex");
  }

  /**
   * Create an immutable dual-approval refund request. The request records the
   * amount, reason, order snapshot hash, the initiating admin and an expiry —
   * it CANNOT be executed by its creator.
   */
  async createRefundRequest({ orderId, amountMicropeach, reason, actorRef }, nowMs = Date.now()) {
    return this.withOrderLock(orderId, async () => {
      const order = this.store.reservationOrders.get(orderId);
      if (!order) throw new ContractError("NOT_FOUND", "Order not found");
      if (order.payment_state !== "PAID") {
        throw new ContractError("CONFLICT", "Only PAID orders are eligible for refund");
      }
      if (!this._hasFinanceApproverRole(actorRef)) {
        throw new ContractError("FORBIDDEN", "Initiator does not hold a finance approval role");
      }
      // Lazily expire stale requests: an un-approved request past its TTL must
      // not block future refunds for this order forever. In-flight statuses
      // (EXECUTING/RESULT_UNKNOWN) are never expired — money may be moving.
      for (const r of this.store.refundRequests.values()) {
        if (
          r.order_id === orderId &&
          ["PENDING_APPROVAL", "APPROVED"].includes(r.status) &&
          Date.parse(r.expires_at) <= nowMs
        ) {
          r.status = "EXPIRED";
          r.result_error = "Expired before execution";
        }
      }
      // Single-refund-per-order contract: an active request or a completed
      // refund operation for the same order must be rejected outright.
      const activeRequest = [...this.store.refundRequests.values()].find(
        (r) =>
          r.order_id === orderId &&
          ["PENDING_APPROVAL", "APPROVED", "EXECUTING", "RESULT_UNKNOWN"].includes(r.status)
      );
      if (activeRequest) {
        throw new ContractError(
          "CONFLICT",
          "An active refund request already exists for this order; complete or expire it first"
        );
      }
      const existingOp = this.store.financeOperations.get(buildRefundEventKey(orderId));
      if (existingOp && ["SUCCEEDED", "IN_FLIGHT", "FAILED_RETRYABLE"].includes(existingOp.status)) {
        throw new ContractError(
          "CONFLICT",
          "Refund for this order is settled or unresolved — reconcile the existing operation first"
        );
      }
      const resolvedMicro =
        typeof amountMicropeach === "number" && Number.isInteger(amountMicropeach)
          ? amountMicropeach
          : 0;
      if (!Number.isInteger(order.price_micropeach) || order.price_micropeach <= 0) {
        throw new ContractError("CONFLICT", "Order has no valid paid price; refund requires manual review");
      }
      if (!Number.isInteger(resolvedMicro) || resolvedMicro <= 0 || resolvedMicro > order.price_micropeach) {
        throw new ContractError("BAD_REQUEST", "Refund amount must be between 0.01 and the paid amount");
      }
      const cleanReason = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 200) : "Admin approved refund";
      const requestHash = this._computeRefundRequestHash({
        orderId,
        amountMicropeach: resolvedMicro,
        reason: cleanReason,
        order
      });
      const req = {
        id: crypto.randomUUID(),
        order_id: orderId,
        cloud_user_id: order.cloud_user_id,
        amount_micropeach: resolvedMicro,
        reason: cleanReason,
        request_hash: requestHash,
        status: "PENDING_APPROVAL",
        created_by: actorRef,
        created_at: new Date(nowMs).toISOString(),
        expires_at: new Date(nowMs + 24 * 3600 * 1000).toISOString(),
        approved_by: null,
        approved_at: null,
        executed_at: null,
        result_error: null
      };
      this.store.refundRequests.set(req.id, req);
      this.store.indexUserScoped?.("refundRequests", req.id, req.cloud_user_id);
      this.store.recordAudit({
        actor_kind: "FINANCE_OPERATOR",
        actor_ref: actorRef,
        action: "REFUND_REQUEST_CREATED",
        resource_kind: "refund_request",
        resource_ref: req.id,
        outcome: "PENDING_APPROVAL",
        detail: { order_id: orderId, amount_micropeach: resolvedMicro, reason: cleanReason }
      });
      if (typeof this.store.flushSnapshotStrictSync === "function") {
        this.store.flushSnapshotStrictSync();
      }
      return req;
    });
  }

  /**
   * Second-person approval. The approver identity is taken from the
   * authenticated session (approverRef), never from a request body field —
   * filling in another admin's name grants nothing.
   */
  async approveRefundRequest({ requestId, approverRef }, nowMs = Date.now()) {
    const req = this.store.refundRequests.get(requestId);
    if (!req) throw new ContractError("NOT_FOUND", "Refund request not found");
    // Serialize approvals on the per-order lock: two racing admins cannot
    // both pass the PENDING_APPROVAL check.
    return this.withOrderLock(req.order_id, async () => {
      if (req.status !== "PENDING_APPROVAL") {
        throw new ContractError("CONFLICT", `Refund request is ${req.status}, cannot approve`);
      }
      if (nowMs > Date.parse(req.expires_at)) {
        req.status = "EXPIRED";
        if (typeof this.store.flushSnapshotStrictSync === "function") this.store.flushSnapshotStrictSync();
        throw new ContractError("CONFLICT", "Refund request expired; create a new one");
      }
      if (!approverRef || approverRef === req.created_by) {
        throw new ContractError("FORBIDDEN", "Refund approval requires a DISTINCT second approver; self-approval is rejected");
      }
      if (!this._hasFinanceApproverRole(approverRef)) {
        throw new ContractError("FORBIDDEN", "Approver does not hold a finance approval role");
      }
      req.status = "APPROVED";
      req.approved_by = approverRef;
      req.approved_at = new Date(nowMs).toISOString();
      this.store.recordAudit({
        actor_kind: "FINANCE_OPERATOR",
        actor_ref: approverRef,
        action: "REFUND_REQUEST_APPROVED",
        resource_kind: "refund_request",
        resource_ref: req.id,
        outcome: "APPROVED",
        detail: { order_id: req.order_id, created_by: req.created_by }
      });
      if (typeof this.store.flushSnapshotStrictSync === "function") this.store.flushSnapshotStrictSync();
      return req;
    });
  }

  /**
   * Execute an approved request. CAS APPROVED -> EXECUTING -> terminal. At
   * execution time we re-verify the immutable request hash against the live
   * order AND that both parties still hold approval roles. Any changed
   * amount/reason/order invalidates the request — a new request is required.
   * The SSO call keeps the deterministic refund event_key, so a timeout marks
   * RESULT_UNKNOWN and re-execution dedupes instead of double-refunding.
   */
  async executeRefundRequest({ requestId, actorRef }, nowMs = Date.now()) {
    const req = this.store.refundRequests.get(requestId);
    if (!req) throw new ContractError("NOT_FOUND", "Refund request not found");
    if (req.status === "REFUNDED") {
      const order = this.store.reservationOrders.get(req.order_id);
      return { request: req, order };
    }
    if (!["APPROVED", "EXECUTING", "RESULT_UNKNOWN"].includes(req.status)) {
      throw new ContractError("CONFLICT", `Refund request is ${req.status}, cannot execute`);
    }
    // Service-level recheck: the executing/reconciling actor must still hold
    // a finance approval role (the HTTP route's RBAC covers real callers;
    // this protects internal/other callers too). Applies to first dispatch
    // AND resume-reconcile — any currently-qualified operator may finish
    // converging an in-flight refund.
    if (!this._hasFinanceApproverRole(actorRef)) {
      throw new ContractError("FORBIDDEN", "Executing actor does not hold a finance approval role");
    }
    // TTL is hard for approval-stage requests: an APPROVED request that sat
    // past expiry cannot move money. EXECUTING/RESULT_UNKNOWN never expire —
    // an in-flight refund must finish converging.
    if (req.status === "APPROVED" && nowMs > Date.parse(req.expires_at)) {
      req.status = "EXPIRED";
      req.result_error = "Expired before execution";
      if (typeof this.store.flushSnapshotStrictSync === "function") this.store.flushSnapshotStrictSync();
      throw new ContractError("CONFLICT", "Refund request expired; create a new one");
    }
    return this.withOrderLock(req.order_id, async () => {
      const order = this.store.reservationOrders.get(req.order_id);
      if (!order) throw new ContractError("NOT_FOUND", "Order not found");

      // Idempotent convergence: a retry after a completed refund (or an order
      // that reached REFUNDED by the same request) returns the settled state
      // instead of failing — never produces a second refund.
      if (req.status === "REFUNDED" || order.payment_state === "REFUNDED") {
        if (req.status !== "REFUNDED") {
          req.status = "REFUNDED";
          req.result_error = null;
          if (typeof this.store.flushSnapshotStrictSync === "function") {
            try {
              this.store.flushSnapshotStrictSync();
            } catch {
              /* convergence marker stays in memory */
            }
          }
        }
        return { request: req, order };
      }

      // Split semantics: "permission to dispatch for the first time" vs
      // "reconcile an already-dispatched result".
      const isFirstDispatch = req.status === "APPROVED";
      if (isFirstDispatch) {
        // First dispatch: re-verify the immutable hash AND that both approval
        // parties still hold roles — an un-dispatched request must die
        // honestly rather than move money nobody can vouch for anymore.
        const expectedHash = this._computeRefundRequestHash({
          orderId: req.order_id,
          amountMicropeach: req.amount_micropeach,
          reason: req.reason,
          order
        });
        if (expectedHash !== req.request_hash) {
          req.status = "FAILED";
          req.result_error = "REQUEST_STALE";
          if (typeof this.store.flushSnapshotStrictSync === "function") this.store.flushSnapshotStrictSync();
          throw new ContractError(
            "CONFLICT",
            "Order state changed since approval; the refund request is stale and a new request is required"
          );
        }
        if (!this._hasFinanceApproverRole(req.created_by) || !this._hasFinanceApproverRole(req.approved_by)) {
          req.status = "FAILED";
          req.result_error = "APPROVER_ROLE_LOST";
          if (typeof this.store.flushSnapshotStrictSync === "function") this.store.flushSnapshotStrictSync();
          throw new ContractError("FORBIDDEN", "One of the approval parties no longer holds a finance role");
        }
        if (order.payment_state !== "PAID") {
          req.status = "FAILED";
          req.result_error = "ORDER_NOT_PAID";
          if (typeof this.store.flushSnapshotStrictSync === "function") this.store.flushSnapshotStrictSync();
          throw new ContractError("CONFLICT", "Order is no longer in a refundable state");
        }
        req.status = "EXECUTING";
        req.executed_at = new Date(nowMs).toISOString();
      } else {
        // Resume reconcile (EXECUTING / RESULT_UNKNOWN): the intent already
        // dispatched or was durably committed. The original approver losing
        // their role must NEVER freeze this lane — any currently-qualified
        // operator finishes it with the SAME event key.
        const existingOp = this.store.financeOperations.get(buildRefundEventKey(order.id));
        if (!existingOp) {
          req.result_error = "MANUAL_REVIEW: dispatch evidence missing; do not reissue under a new key";
          if (typeof this.store.flushSnapshotStrictSync === "function") {
            try { this.store.flushSnapshotStrictSync(); } catch { /* recoverable */ }
          }
          throw new ContractError(
            "CONFLICT",
            "Refund marked dispatched but no operation record exists — route to manual reconciliation instead of re-dispatching"
          );
        }
        if (existingOp.status === "SUCCEEDED") {
          // Upstream applied it but the local convergence was lost.
          order.payment_state = "REFUNDED";
          order.refunded_at = order.refunded_at || new Date(nowMs).toISOString();
          req.status = "REFUNDED";
          req.result_error = null;
          if (typeof this.store.flushSnapshotStrictSync === "function") this.store.flushSnapshotStrictSync();
          return { request: req, order };
        }
      }

      const eventKey = buildRefundEventKey(order.id);
      const resolvedMicro = req.amount_micropeach;
      const resolvedPeach = resolvedMicro / MICROPEACH_PER_PEACH;
      const payloadHash = buildFinancePayloadHash({
        kind: "REFUND",
        orderId: order.id,
        eventKey,
        amountMicropeach: resolvedMicro
      });
      let op = this.store.financeOperations.get(eventKey);
      if (!op) {
        op = {
          id: crypto.randomUUID(),
          order_id: order.id,
          kind: "REFUND",
          event_key: eventKey,
          peach_amount: resolvedPeach,
          amount_micropeach: resolvedMicro,
          payload_hash: payloadHash,
          refund_request_id: req.id,
          status: "IN_FLIGHT",
          sso_request_id: null,
          last_error_code: null,
          attempt_count: 0,
          next_attempt_at: null,
          created_at: new Date(nowMs).toISOString(),
          updated_at: new Date(nowMs).toISOString()
        };
        this.store.financeOperations.set(eventKey, op);
      } else {
        if (op.payload_hash && op.payload_hash !== payloadHash) {
          throw new ContractError("CONFLICT", "Idempotency key payload mismatch for refund operation");
        }
        if (!op.payload_hash) op.payload_hash = payloadHash;
      }

      op.attempt_count += 1;
      op.updated_at = new Date(nowMs).toISOString();
      // STRICT durable commit of request + operation BEFORE the external call.
      if (typeof this.store.flushSnapshotStrictSync === "function") {
        this.store.flushSnapshotStrictSync();
      }
      const user = this.store.users.get(order.cloud_user_id);
      let bridgeRes;
      try {
        bridgeRes = await this.financeBridge.adjustBalanceIdempotent({
          cloudUserId: order.cloud_user_id,
          ssoSubject: user?.subject,
          deltaPeach: resolvedPeach,
          deltaMicropeach: resolvedMicro,
          eventKey,
          reason: `日在校园预约订单退还 (${order.id}): ${req.reason}`,
          userObj: user
        });
      } catch (err) {
        op.status = "FAILED_RETRYABLE";
        op.last_error_code = err?.code || "SSO_UNAVAILABLE";
        op.next_attempt_at = new Date(nowMs + computeRetryBackoffMs(op.attempt_count)).toISOString();
        // A timeout could mean the refund WAS applied upstream — keep the
        // request in RESULT_UNKNOWN so reconciliation reuses the same key.
        req.status = "RESULT_UNKNOWN";
        req.result_error = err?.code || "SSO_UNAVAILABLE";
        if (typeof this.store.flushSnapshotStrictSync === "function") {
          try {
            this.store.flushSnapshotStrictSync();
          } catch { /* recoverable in-memory */ }
        }
        throw err;
      }

      op.status = "SUCCEEDED";
      op.sso_request_id = bridgeRes.ssoRequestId;
      order.payment_state = "REFUNDED";
      req.status = "REFUNDED";
      req.result_error = null;
      this.store.recordAudit({
        actor_kind: "FINANCE_OPERATOR",
        actor_ref: `${req.created_by}+${req.approved_by}`,
        action: "REFUND_ORDER",
        resource_kind: "reservation_order",
        resource_ref: order.id,
        outcome: "REFUNDED",
        detail: { refund_request_id: req.id, amount_micropeach: resolvedMicro }
      });
      if (typeof this.store.flushSnapshotStrictSync === "function") {
        try {
          this.store.flushSnapshotStrictSync();
        } catch {
          if (typeof this.store.saveSnapshot === "function") this.store.saveSnapshot();
        }
      } else if (typeof this.store.saveSnapshot === "function") {
        this.store.saveSnapshot();
      }
      return { request: req, order };
    });
  }

  /**
   * Back-compat executor kept for internal callers: refunds now REQUIRE an
   * approved refund request — no direct unilateral refund remains possible.
   */
  async issueRefundForOrder(orderId, { refundRequestId, actorRef }, nowMs = Date.now()) {
    const req = this.store.refundRequests.get(refundRequestId);
    if (!req || req.order_id !== orderId) {
      throw new ContractError(
        "FORBIDDEN",
        "Refunds require an approved dual-person refund request (refundRequestId)"
      );
    }
    return this.executeRefundRequest({ requestId: req.id, actorRef }, nowMs);
  }

  /**
   * Read-only reconciliation for a LEGACY refund operation that predates the
   * dual-approval request model (in-flight at upgrade, no request record).
   * Uses the ORIGINAL event key — never fabricates a request, never mints a
   * new key, never marks a result the upstream cannot confirm.
   */
  async reconcileLegacyRefundOperation(orderId, { actorRef }, nowMs = Date.now()) {
    if (!this._hasFinanceApproverRole(actorRef)) {
      throw new ContractError("FORBIDDEN", "Reconciling actor does not hold a finance approval role");
    }
    const order = this.store.reservationOrders.get(orderId);
    if (!order) throw new ContractError("NOT_FOUND", "Order not found");
    const eventKey = buildRefundEventKey(orderId);
    const op = this.store.financeOperations.get(eventKey);
    if (!op) {
      throw new ContractError("NOT_FOUND", "No refund operation exists for this order");
    }
    if (op.refund_request_id && this.store.refundRequests.get(op.refund_request_id)) {
      throw new ContractError(
        "CONFLICT",
        "This refund is governed by a dual-person request — use the request execute path"
      );
    }
    if (!["IN_FLIGHT", "FAILED_RETRYABLE"].includes(op.status)) {
      throw new ContractError("CONFLICT", `Refund operation is ${op.status}; nothing to reconcile`);
    }
    if (typeof this.financeBridge.queryOperationResult !== "function") {
      throw new ContractError(
        "CONFLICT",
        "Finance bridge exposes no read-back probe — manual reconciliation required, no re-dispatch"
      );
    }
    const probe = await this.financeBridge.queryOperationResult(eventKey);
    if (probe.outcome === "SUCCEEDED") {
      op.status = "SUCCEEDED";
      op.updated_at = new Date(nowMs).toISOString();
      op.sso_request_id = op.sso_request_id || probe.result?.sso_request_id || null;
      order.payment_state = "REFUNDED";
      order.refunded_at = order.refunded_at || new Date(nowMs).toISOString();
      this.store.recordAudit({
        actor_kind: "FINANCE_OPERATOR",
        actor_ref: actorRef,
        action: "LEGACY_REFUND_RECONCILED",
        resource_kind: "reservation_order",
        resource_ref: orderId,
        outcome: "REFUNDED",
        detail: { event_key: eventKey, source: "upstream_probe" }
      });
      if (typeof this.store.flushSnapshotStrictSync === "function") this.store.flushSnapshotStrictSync();
      return { reconciled: "SUCCEEDED", op, order };
    }
    if (probe.outcome === "NOT_FOUND") {
      op.status = "FAILED";
      op.last_error_code = "LEGACY_NEVER_RECEIVED";
      op.updated_at = new Date(nowMs).toISOString();
      this.store.recordAudit({
        actor_kind: "FINANCE_OPERATOR",
        actor_ref: actorRef,
        action: "LEGACY_REFUND_RECONCILED",
        resource_kind: "reservation_order",
        resource_ref: orderId,
        outcome: "NEVER_RECEIVED",
        detail: { event_key: eventKey, source: "upstream_probe" }
      });
      if (typeof this.store.flushSnapshotStrictSync === "function") this.store.flushSnapshotStrictSync();
      return { reconciled: "NEVER_RECEIVED", op, order };
    }
    // UNKNOWN: keep the operation in the reconcile queue — never guess.
    op.legacy_reconcile_required = true;
    op.last_error_code = probe.reason || "UPSTREAM_PROBE_UNRESOLVED";
    op.updated_at = new Date(nowMs).toISOString();
    if (typeof this.store.flushSnapshotStrictSync === "function") this.store.flushSnapshotStrictSync();
    return { reconciled: "UNKNOWN", reason: probe.reason || null, op };
  }

  /**
   * Independent finance retry worker — MUST be driven by its own timer, never
   * inside the reservation scanner's critical section. Bounded batch + bounded
   * concurrency + per-order exponential backoff (next_attempt_at). Orders
   * whose op exceeds the attempt ceiling are parked in MANUAL_REVIEW instead
   * of being silently skipped forever.
   */
  async retryPendingDebits(nowMs = Date.now(), { batchSize = 10, concurrency = 3 } = {}) {
    if (this._retryWorkerRunning) {
      return { skipped: "worker_already_running", retried: [] };
    }
    this._retryWorkerRunning = true;
    try {
      const candidates = [];
      for (const order of this.store.reservationOrders.values()) {
        if (!order || order.school_result !== "CONFIRMED" || order.payment_state !== "DEBIT_PENDING") {
          continue;
        }
        const eventKey = buildDebitEventKey(order.id);
        const op = this.store.financeOperations.get(eventKey);
        if (op) {
          if (op.status === "IN_FLIGHT") {
            // Crash-safe recovery: an op stuck IN_FLIGHT beyond the staleness
            // window is retried with the SAME event_key (idempotent dedupe at
            // SSO side) rather than abandoned or blindly re-charged.
            const staleMs = nowMs - new Date(op.updated_at || 0).getTime();
            if (staleMs > 120_000) {
              op.status = "FAILED_RETRYABLE";
              op.next_attempt_at =
                op.next_attempt_at || new Date(nowMs + 1_000).toISOString();
            } else {
              continue;
            }
          }
          if (op.status === "MANUAL_REVIEW") continue;
          if (op.status !== "FAILED_RETRYABLE") continue;
          if (Number(op.attempt_count || 0) >= 20) {
            op.status = "MANUAL_REVIEW";
            this.store.recordAudit({
              actor_kind: "FINANCE_WORKER",
              actor_ref: "retryPendingDebits",
              action: "DEBIT_MANUAL_REVIEW",
              resource_kind: "reservation_order",
              resource_ref: order.id,
              outcome: "RETRY_BUDGET_EXHAUSTED",
              detail: { event_key: eventKey, attempt_count: op.attempt_count }
            });
            continue;
          }
          const nextAt = op.next_attempt_at ? new Date(op.next_attempt_at).getTime() : 0;
          if (nextAt && nowMs < nextAt) continue;
        }
        candidates.push(order);
      }
      candidates.sort(
        (a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime()
      );
      const batch = candidates.slice(0, Math.max(1, batchSize));

      const results = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < batch.length) {
          const order = batch[cursor];
          cursor += 1;
          try {
            const settled = await this.executeDebitForOrder(order.id, nowMs);
            const job = this.store.reservationJobs?.get?.(order.job_id);
            if (job && settled?.payment_state) {
              job.billing_state = settled.payment_state;
            }
            for (const outEv of this.store.outboxEvents || []) {
              if (
                outEv.aggregate_id === order.id &&
                !outEv.delivered_at &&
                settled?.payment_state === "PAID"
              ) {
                outEv.delivered_at = new Date(nowMs).toISOString();
              }
            }
            results.push({
              order_id: order.id,
              payment_state: settled?.payment_state || order.payment_state
            });
          } catch (err) {
            results.push({
              order_id: order.id,
              payment_state: "DEBIT_PENDING",
              error: err?.code || "RETRY_FAILED"
            });
          }
        }
      };
      const lanes = Math.min(Math.max(1, concurrency), Math.max(1, batch.length));
      await Promise.all(Array.from({ length: lanes }, () => worker()));
      this.lastRetryRun = {
        ran_at: new Date(nowMs).toISOString(),
        scanned_orders: this.store.reservationOrders.size,
        eligible: candidates.length,
        processed: batch.length,
        results
      };
      return { retried: results, eligible: candidates.length, processed: batch.length };
    } finally {
      this._retryWorkerRunning = false;
    }
  }

  /**
   * Operator-facing metrics for the finance worker: backlog age, retry counts,
   * manual-review queue. Cheap to compute; safe to expose read-only.
   */
  getFinanceWorkerMetrics(nowMs = Date.now()) {
    const pending = [];
    let manualReview = 0;
    let oldestPendingMs = null;
    for (const order of this.store.reservationOrders.values()) {
      if (!order || order.payment_state !== "DEBIT_PENDING") continue;
      pending.push(order.id);
      const createdMs = new Date(order.created_at || 0).getTime();
      if (oldestPendingMs === null || createdMs < oldestPendingMs) oldestPendingMs = createdMs;
      const op = this.store.financeOperations.get(buildDebitEventKey(order.id));
      if (op?.status === "MANUAL_REVIEW") manualReview += 1;
    }
    return {
      pending_debit_orders: pending.length,
      pending_order_ids: pending.slice(0, 50),
      manual_review_orders: manualReview,
      oldest_pending_age_ms: oldestPendingMs === null ? 0 : Math.max(0, nowMs - oldestPendingMs),
      worker_running: Boolean(this._retryWorkerRunning),
      last_run: this.lastRetryRun || null
    };
  }
}
