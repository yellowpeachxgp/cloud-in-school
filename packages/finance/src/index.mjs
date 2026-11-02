import crypto from "node:crypto";
import { ContractError } from "../../contracts/src/index.mjs";

/**
 * Zero-SSO-Change Finance Bridge & Post-Confirmation Saga Engine.
 * Enforces Section 04.3, 09, 18.5 (PAY-001 through PAY-020):
 * - Single debit path (`POST /api/v1/users/:uuid/peach/adjust` on XPEACH SSO)
 * - Deterministic idempotency keys:
 *   - Debit:  `dis:reservation:<orderUUID>:debit:v1`
 *   - Refund: `dis:reservation:<orderUUID>:refund:v1`
 * - Never claims balance hold/freeze (`hold_supported: false`)
 * - If wallet balance was spent on another site before post-confirmation debit completes, sets `PAYMENT_DUE` without cancelling the student's confirmed library seat!
 */
export const MICROPEACH_PER_PEACH = 10_000;

export function buildDebitEventKey(orderId) {
  return `dis:reservation:${orderId}:debit:v1`;
}

export function buildRefundEventKey(orderId) {
  return `dis:reservation:${orderId}:refund:v1`;
}

export class IsolatedFinanceBridge {
  constructor(options = {}) {
    this.ssoBaseUrl = options.ssoBaseUrl || process.env.SSO_FINANCE_BASE_URL || "https://sso.xpeach.codes";
    this.internalServiceKey =
      options.internalServiceKey || process.env.SSO_INTERNAL_SERVICE_KEY || "";
    this.realDebitsEnabled = Boolean(
      options.realDebitsEnabled ?? process.env.FINANCE_ENABLE_REAL_DEBITS === "true"
    );
    // Simulated SSO ledger for sandbox/contract testing when realDebitsEnabled=false
    this.sandboxBalancesMicropeach = new Map();
    this.processedIdempotencyKeys = new Map();
    this.inFlightLocks = new Map();
  }

  setSandboxBalance(cloudUserId, micropeach) {
    this.sandboxBalancesMicropeach.set(cloudUserId, Number(micropeach));
  }

  getSandboxBalance(cloudUserId) {
    if (!this.sandboxBalancesMicropeach.has(cloudUserId)) {
      this.sandboxBalancesMicropeach.set(cloudUserId, 50_000); // default 5.0 🍑 in sandbox
    }
    return this.sandboxBalancesMicropeach.get(cloudUserId);
  }

  async readWallet(cloudUserId, ssoSubject) {
    if (this.realDebitsEnabled && this.internalServiceKey && ssoSubject) {
      const resp = await fetch(
        `${this.ssoBaseUrl.replace(/\/+$/, "")}/api/v1/users/${encodeURIComponent(ssoSubject)}/peach`,
        {
          method: "GET",
          headers: {
            "X-Internal-Service-Key": this.internalServiceKey,
            Accept: "application/json"
          }
        }
      );
      if (!resp.ok) {
        throw new ContractError("SSO_UNAVAILABLE", `SSO wallet query returned HTTP ${resp.status}`);
      }
      const data = await resp.json();
      const peachBalance = Number(data.peachBalance ?? data.peach_balance ?? 0);
      return {
        cloud_user_id: cloudUserId,
        currency_symbol: "🍑",
        peach_balance: peachBalance,
        micropeach_balance: Math.round(peachBalance * MICROPEACH_PER_PEACH),
        hold_supported: false,
        fetched_at: new Date().toISOString(),
        source: "xpeach-sso-live"
      };
    }

    const micro = this.getSandboxBalance(cloudUserId);
    return {
      cloud_user_id: cloudUserId,
      currency_symbol: "🍑",
      peach_balance: micro / MICROPEACH_PER_PEACH,
      micropeach_balance: micro,
      hold_supported: false,
      fetched_at: new Date().toISOString(),
      source: "xpeach-sso-sandbox"
    };
  }

  async adjustBalanceIdempotent({
    cloudUserId,
    ssoSubject,
    deltaMicropeach,
    eventKey,
    reason
  }) {
    if (!Number.isInteger(deltaMicropeach) || deltaMicropeach === 0) {
      throw new ContractError("BAD_REQUEST", "deltaMicropeach must be a non-zero integer");
    }
    if (!eventKey || !/^dis:reservation:[0-9a-fA-F-]{36}:(debit|refund):v1$/.test(eventKey)) {
      throw new ContractError("BAD_REQUEST", `Invalid Finance Bridge idempotency event_key: ${eventKey}`);
    }

    // Serialize concurrent requests for the exact same idempotency key
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

      if (this.realDebitsEnabled && this.internalServiceKey && ssoSubject) {
        const deltaPeach = deltaMicropeach / MICROPEACH_PER_PEACH;
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
              delta_peach: deltaPeach,
              idempotency_key: eventKey,
              source_site: "dis",
              reason
            })
          }
        );
        const body = await resp.json();
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
        const out = {
          ok: true,
          deduplicated: Boolean(body.deduplicated),
          ssoRequestId: `sso_req_${crypto.randomUUID().slice(0, 12)}`,
          balanceAfterMicropeach: Math.round(Number(body.peachBalance ?? 0) * MICROPEACH_PER_PEACH)
        };
        this.processedIdempotencyKeys.set(eventKey, out);
        return out;
      }

      const currentMicro = this.getSandboxBalance(cloudUserId);
      if (deltaMicropeach < 0 && currentMicro + deltaMicropeach < 0) {
        return {
          ok: false,
          error: "WALLET_INSUFFICIENT",
          deduplicated: false,
          balanceAfterMicropeach: currentMicro
        };
      }
      const nextMicro = currentMicro + deltaMicropeach;
      this.sandboxBalancesMicropeach.set(cloudUserId, nextMicro);
      const out = {
        ok: true,
        deduplicated: false,
        ssoRequestId: `sso_sim_${crypto.randomUUID().slice(0, 12)}`,
        balanceAfterMicropeach: nextMicro
      };
      this.processedIdempotencyKeys.set(eventKey, out);
      return out;
    } finally {
      this.inFlightLocks.delete(eventKey);
      releaseLock();
    }
  }
}

export class FinanceSagaService {
  constructor(store, financeBridge) {
    this.store = store;
    this.financeBridge = financeBridge;
  }

  async getWalletSnapshot(cloudUserId) {
    const user = this.store.users.get(cloudUserId);
    return this.financeBridge.readWallet(cloudUserId, user?.subject);
  }

  async createAndSettleOrderForConfirmedJob({ job, plan, nowMs = Date.now() }) {
    let order = Array.from(this.store.reservationOrders.values()).find((o) => o.job_id === job.id);
    if (!order) {
      const orderId = crypto.randomUUID();
      order = {
        id: orderId,
        job_id: job.id,
        cloud_user_id: job.cloud_user_id,
        price_micropeach: this.store.pricingMicropeach,
        price_version: plan?.price_version || "price-library-cloud-2026-11-v1",
        accepted_at: plan?.created_at || new Date(nowMs).toISOString(),
        school_result: "CONFIRMED",
        payment_state: this.store.pricingMicropeach === 0 ? "NOT_REQUIRED" : "DEBIT_PENDING",
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
    const order = this.store.reservationOrders.get(orderId);
    if (!order) throw new ContractError("NOT_FOUND", "Reservation order not found");
    if (order.school_result !== "CONFIRMED") {
      throw new ContractError("CONFLICT", "Cannot debit an unconfirmed school reservation");
    }

    const eventKey = buildDebitEventKey(order.id);
    let op = this.store.financeOperations.get(eventKey);
    if (!op) {
      op = {
        id: crypto.randomUUID(),
        order_id: order.id,
        kind: "DEBIT",
        event_key: eventKey,
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
    op.updated_at = new Date(nowMs).toISOString();
    const user = this.store.users.get(order.cloud_user_id);

    const bridgeRes = await this.financeBridge.adjustBalanceIdempotent({
      cloudUserId: order.cloud_user_id,
      ssoSubject: user?.subject,
      deltaMicropeach: -order.price_micropeach,
      eventKey,
      reason: `Day in School confirmed reservation order ${order.id}`
    });

    if (!bridgeRes.ok && bridgeRes.error === "WALLET_INSUFFICIENT") {
      // School reservation succeeded, but user spent balance elsewhere -> PAYMENT_DUE (never cancel school booking!)
      op.status = "FAILED_INSUFFICIENT";
      op.last_error_code = "WALLET_INSUFFICIENT";
      order.payment_state = "PAYMENT_DUE";
      return order;
    }

    op.status = "SUCCEEDED";
    op.sso_request_id = bridgeRes.ssoRequestId;
    order.payment_state = "PAID";
    order.paid_at = order.paid_at || new Date(nowMs).toISOString();
    return order;
  }

  async issueRefundForOrder(orderId, { amountMicropeach, reason, actorRef, secondApproverRef }, nowMs = Date.now()) {
    const order = this.store.reservationOrders.get(orderId);
    if (!order) throw new ContractError("NOT_FOUND", "Order not found");
    if (order.payment_state !== "PAID" && order.payment_state !== "REFUNDED") {
      throw new ContractError("CONFLICT", "Only PAID orders are eligible for refund");
    }
    if (!secondApproverRef || secondApproverRef === actorRef) {
      throw new ContractError("FORBIDDEN", "Dual-person approval (distinct second_approver_ref) is required for refunds");
    }
    if (!Number.isInteger(amountMicropeach) || amountMicropeach <= 0 || amountMicropeach > order.price_micropeach) {
      throw new ContractError(
        "BAD_REQUEST",
        `Refund amount ${amountMicropeach} must be between 1 and paid amount ${order.price_micropeach}`
      );
    }

    const eventKey = buildRefundEventKey(order.id);
    let op = this.store.financeOperations.get(eventKey);
    if (!op) {
      op = {
        id: crypto.randomUUID(),
        order_id: order.id,
        kind: "REFUND",
        event_key: eventKey,
        amount_micropeach: amountMicropeach,
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
    const user = this.store.users.get(order.cloud_user_id);
    const bridgeRes = await this.financeBridge.adjustBalanceIdempotent({
      cloudUserId: order.cloud_user_id,
      ssoSubject: user?.subject,
      deltaMicropeach: amountMicropeach,
      eventKey,
      reason: `Refund for order ${order.id}: ${reason}`
    });

    op.status = "SUCCEEDED";
    op.sso_request_id = bridgeRes.ssoRequestId;
    order.payment_state = "REFUNDED";
    this.store.recordAudit({
      actor_kind: "FINANCE_OPERATOR",
      actor_ref: `${actorRef}+${secondApproverRef}`,
      action: "REFUND_ORDER",
      resource_kind: "reservation_order",
      resource_ref: order.id,
      outcome: "REFUNDED"
    });
    return order;
  }
}
