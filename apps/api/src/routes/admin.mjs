import { route } from "./route-table.mjs";
import {
  ContractError,
  DEFAULT_RESERVATION_PRICE_MICROPEACH,
  redactSensitiveFields
} from "../../../../packages/contracts/src/index.mjs";
import {
  auditCredentialRefConsistency
} from "../../../../packages/crypto/src/index.mjs";

export function createAdminRoutes(ctx) {
  const {
    store,
    identity,
    financeService,
    redisBuffer,
    syncUserToSso
  } = ctx;

  return [
  route("GET", "/api/v1/admin/overview", "getAdminOverview", "bearer_rbac", async ({ auth }) => {
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
  }),

  route(
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
  ),

  route(
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
  ),

  route(
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
  ),

  route(
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
  ),

  route("GET", "/api/v1/admin/orders", "listAdminOrders", "bearer_rbac", async ({ auth }) => {
    store.requireRole(auth, ["PLATFORM_OWNER", "FINANCE_OPERATOR"]);
    return {
      status: 200,
      code: "ADMIN_ORDERS_LISTED",
      data: { orders: Array.from(store.reservationOrders.values()) }
    };
  }),

  route(
    "POST",
    "/api/v1/admin/orders/{orderId}/reconcile",
    "reconcileAdminOrder",
    "bearer_rbac",
    async ({ auth, params, nowMs }) => {
      store.requireRole(auth, ["PLATFORM_OWNER", "FINANCE_OPERATOR"]);
      const order = await financeService.executeDebitForOrder(params.orderId, nowMs);
      return { status: 200, code: "ADMIN_ORDER_RECONCILED", data: order };
    }
  ),

  route(
    "POST",
    "/api/v1/admin/orders/{orderId}/refund",
    "refundAdminOrder",
    "bearer_rbac",
    async ({ auth, params, body, nowMs }) => {
      store.requireRole(auth, ["PLATFORM_OWNER", "FINANCE_OPERATOR"]);
      // Back-compat: a bare refund call now creates a dual-approval REQUEST and
      // returns 202. The refund only executes after a SECOND authenticated
      // admin approves it via /admin/refund-requests/{id}/approve + /execute.
      const req = await financeService.createRefundRequest(
        {
          orderId: params.orderId,
          amountMicropeach: body?.amount_micropeach,
          reason: body?.reason || "Admin approved refund",
          actorRef: auth.cloudUserId
        },
        nowMs
      );
      return { status: 202, code: "REFUND_REQUEST_CREATED", data: { refund_request: req } };
    }
  ),

  route(
    "POST",
    "/api/v1/admin/orders/{orderId}/refund-requests",
    "createRefundRequest",
    "bearer_rbac",
    async ({ auth, params, body, nowMs }) => {
      store.requireRole(auth, ["PLATFORM_OWNER", "FINANCE_OPERATOR"]);
      const req = await financeService.createRefundRequest(
        {
          orderId: params.orderId,
          amountMicropeach: body?.amount_micropeach,
          reason: body?.reason,
          actorRef: auth.cloudUserId
        },
        nowMs
      );
      return { status: 202, code: "REFUND_REQUEST_CREATED", data: { refund_request: req } };
    }
  ),

  route(
    "GET",
    "/api/v1/admin/refund-requests",
    "listRefundRequests",
    "bearer_rbac",
    async ({ auth }) => {
      store.requireRole(auth, ["PLATFORM_OWNER", "FINANCE_OPERATOR", "SECURITY_AUDITOR"]);
      // Legacy operations (pre-dual-approval) that are parked in the reconcile
      // queue are surfaced alongside requests — ops staff must SEE them.
      const legacyOps = Array.from(store.financeOperations.values()).filter(
        (op) => op.kind === "REFUND" && op.legacy_reconcile_required
      );
      return {
        status: 200,
        code: "REFUND_REQUESTS_LISTED",
        data: {
          refund_requests: Array.from(store.refundRequests.values()),
          legacy_reconcile_queue: legacyOps.map((op) => ({
            order_id: op.order_id,
            event_key: op.event_key,
            status: op.status,
            attempt_count: op.attempt_count,
            last_error_code: op.last_error_code,
            created_at: op.created_at,
            updated_at: op.updated_at
          }))
        }
      };
    }
  ),

  route(
    "POST",
    "/api/v1/admin/orders/{orderId}/refund-reconcile",
    "reconcileLegacyRefund",
    "bearer_rbac",
    async ({ auth, params, nowMs }) => {
      store.requireRole(auth, ["PLATFORM_OWNER", "FINANCE_OPERATOR"]);
      const result = await financeService.reconcileLegacyRefundOperation(
        params.orderId,
        { actorRef: auth.cloudUserId },
        nowMs
      );
      if (result.order?.cloud_user_id) await syncUserToSso(result.order.cloud_user_id);
      return { status: 200, code: "LEGACY_REFUND_RECONCILED", data: result };
    }
  ),

  route(
    "POST",
    "/api/v1/admin/refund-requests/{requestId}/approve",
    "approveRefundRequest",
    "bearer_rbac",
    async ({ auth, params, nowMs }) => {
      store.requireRole(auth, ["PLATFORM_OWNER", "FINANCE_OPERATOR"]);
      // Approver identity comes from the authenticated session ONLY.
      const req = await financeService.approveRefundRequest(
        { requestId: params.requestId, approverRef: auth.cloudUserId },
        nowMs
      );
      return { status: 200, code: "REFUND_REQUEST_APPROVED", data: { refund_request: req } };
    }
  ),

  route(
    "POST",
    "/api/v1/admin/refund-requests/{requestId}/execute",
    "executeRefundRequest",
    "bearer_rbac",
    async ({ auth, params, nowMs }) => {
      store.requireRole(auth, ["PLATFORM_OWNER", "FINANCE_OPERATOR"]);
      const { request, order } = await financeService.executeRefundRequest(
        { requestId: params.requestId, actorRef: auth.cloudUserId },
        nowMs
      );
      if (order?.cloud_user_id) await syncUserToSso(order.cloud_user_id);
      return {
        status: 200,
        code: "ADMIN_ORDER_REFUNDED",
        data: { refund_request: request, order }
      };
    }
  ),

  route(
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
  ),

  route(
    "GET",
    "/api/v1/admin/credential-integrity",
    "auditCredentialIntegrity",
    "bearer_rbac",
    async ({ auth, nowMs }) => {
      store.requireRole(auth, [
        "PLATFORM_OWNER",
        "OPERATIONS_ADMIN",
        "SECURITY_AUDITOR"
      ]);
      // Read-only audit: reports structural violations and non-sensitive ids
      // only — never outputs plaintext/ciphertext/credentials.
      const report = auditCredentialRefConsistency(store, nowMs);
      return { status: 200, code: "CREDENTIAL_INTEGRITY_AUDIT_OK", data: report };
    }
  ),

  route(
    "GET",
    "/api/v1/admin/finance-worker/metrics",
    "getFinanceWorkerMetrics",
    "bearer_rbac",
    async ({ auth, nowMs }) => {
      store.requireRole(auth, ["PLATFORM_OWNER", "OPERATIONS_ADMIN", "FINANCE_OPERATOR"]);
      const metrics =
        typeof financeService.getFinanceWorkerMetrics === "function"
          ? financeService.getFinanceWorkerMetrics(nowMs)
          : { pending_debit_orders: 0 };
      return { status: 200, code: "FINANCE_WORKER_METRICS_OK", data: metrics };
    }
  ),

  route(
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
      // Dual-person approval can no longer be synthesized via a body field.
      // quick-refund now creates a PENDING request (202) that a SECOND
      // authenticated admin must approve + execute.
      const req = await financeService.createRefundRequest(
        {
          orderId,
          amountMicropeach:
            targetOrder.price_micropeach ||
            store.pricingMicropeach ||
            DEFAULT_RESERVATION_PRICE_MICROPEACH,
          reason: body?.reason || "站点管理员在后台发起 🍑 退还",
          actorRef: auth.cloudUserId
        },
        nowMs
      );
      return {
        status: 202,
        code: "REFUND_REQUEST_CREATED",
        data: { refund_request: req }
      };
    }
  )
  ];
}
