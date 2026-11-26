import crypto from "node:crypto";
import { route } from "./route-table.mjs";
import {
  ContractError
} from "../../../../packages/contracts/src/index.mjs";
import {
  addDaysToLocalDate,
  validateManualExecution
} from "../../../../packages/reservations/src/index.mjs";

export function createReservationsRoutes(ctx) {
  const {
    store,
    schoolProvider,
    reservationEngine,
    syncUserToSso
  } = ctx;

  const PRICE_QUOTE_TTL_MS = 10 * 60 * 1000;

  return [
  route("GET", "/api/v1/reservation-plans", "listReservationPlans", "bearer", async ({ auth }) => {
    const plans = store.recordsForUser("reservationPlans", auth.cloudUserId);
    return { status: 200, code: "RESERVATION_PLANS_LISTED", data: { plans } };
  }),

  route("GET", "/api/v1/reservation-quote", "getReservationQuote", "bearer", async ({ auth, nowMs }) => {
    const quoteId = "q_" + crypto.randomUUID().slice(0, 12);
    const quote = {
      quote_id: quoteId,
      cloud_user_id: auth.cloudUserId,
      amount_micropeach: Number.isInteger(store.pricingMicropeach) ? store.pricingMicropeach : 10_000,
      price_version: "price-library-cloud-2026-11-v1",
      unit: "PER_CONFIRMED_RESERVATION",
      issued_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + PRICE_QUOTE_TTL_MS).toISOString()
    };
    quote.quote_hash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          quote_id: quoteId,
          user: auth.cloudUserId,
          amount: quote.amount_micropeach,
          version: quote.price_version,
          expires: quote.expires_at
        })
      )
      .digest("hex");
    store.priceQuotes = store.priceQuotes || new Map();
    if (store.priceQuotes.size > 10_000) {
      for (const [k, q] of store.priceQuotes) {
        if (Date.parse(q.expires_at) <= nowMs) store.priceQuotes.delete(k);
      }
    }
    store.priceQuotes.set(quoteId, quote);
    try {
      store.flushSnapshotStrictSync?.();
    } catch (err) {
      if (err.commitPublished === false) store.priceQuotes.delete(quoteId);
      throw err;
    }
    return { status: 200, code: "RESERVATION_QUOTE_ISSUED", data: quote };
  }),

  route(
    "POST",
    "/api/v1/reservation-plans",
    "createReservationPlan",
    "bearer",
    async ({ auth, body, headers, nowMs }) => {
      const idemKey = headers["idempotency-key"] || headers["Idempotency-Key"] || null;
      if (idemKey) {
        const cacheKey = `createReservationPlan|${auth.cloudUserId}|${idemKey}`;
        const canonical = value => Array.isArray(value) ? value.map(canonical)
          : value && typeof value === "object"
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
        const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
        const bodyHash = hash(body || {});
        const canonicalBodyHash = hash(canonical(body || {}));
        if (store.idempotencyRecords.has(cacheKey)) {
          const existing = store.idempotencyRecords.get(cacheKey);
          if (existing.hashVersion === 2 ? existing.canonicalHash !== canonicalBodyHash : existing.bodyHash !== bodyHash) {
            throw new ContractError(
              "CONFLICT",
              "Idempotency-Key reused with different request payload"
            );
          }
          return { status: 200, code: "REQUEST_DUPLICATE", data: existing.data };
        }
        // 回执与业务对象同寿命；不能清空回执后允许旧键再次创建。
        const created = reservationEngine.createPlanAndJob(auth.cloudUserId, body || {}, nowMs, {
          idempotencyCacheKey: cacheKey,
          idempotencyBodyHash: bodyHash,
          idempotencyCanonicalHash: canonicalBodyHash
        });
        let ssoSyncFailed = false;
        try {
          await syncUserToSso(auth.cloudUserId);
        } catch {
          ssoSyncFailed = true;
        }
        return {
          status: 201,
          code: "RESERVATION_PLAN_CREATED",
          data: { ...created, pending_sso_sync: ssoSyncFailed }
        };
      }
      const created = reservationEngine.createPlanAndJob(auth.cloudUserId, body || {}, nowMs);
      await syncUserToSso(auth.cloudUserId);
      return { status: 201, code: "RESERVATION_PLAN_CREATED", data: created };
    }
  ),

  route(
    "PATCH",
    "/api/v1/reservation-plans/{planId}",
    "updateReservationPlan",
    "bearer",
    async ({ auth, params, body }) => {
      const plan = store.reservationPlans.get(params.planId);
      if (!plan || plan.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "Reservation plan not found");
      }
      const records = [plan, ...Array.from(store.reservationJobs.values()).filter(job => job.plan_id === plan.id)];
      const before = records.map(record => [record, structuredClone(record)]);
      try {
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
        store.flushSnapshotStrictSync?.();
      } catch (err) {
        if (err.commitPublished !== true && err.code !== "STORAGE_COMMIT_UNKNOWN") {
          for (const [record, previous] of before) {
            for (const key of Object.keys(record)) delete record[key];
            Object.assign(record, previous);
          }
        }
        throw err;
      }
      await syncUserToSso(auth.cloudUserId);
      return { status: 200, code: "RESERVATION_PLAN_UPDATED", data: plan };
    }
  ),

  route(
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
  ),

  route("GET", "/api/v1/reservation-jobs", "listReservationJobs", "bearer", async ({ auth }) => {
    const jobs = store.recordsForUser("reservationJobs", auth.cloudUserId).map((j) => {
      store.syncJobDisplayStatus?.(j);
      return j;
    });
    return { status: 200, code: "RESERVATION_JOBS_LISTED", data: { jobs } };
  }),

  route(
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
  ),

  route(
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
  ),

  route(
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
  ),

  route("GET", "/api/v1/pricing/library-booking", "getLibraryBookingPricing", "public", async () => ({
    status: 200,
    code: "PRICING_OK",
    data: {
      price_version: "price-library-cloud-2026-11-v1",
      currency_symbol: "🍑",
      local_device_mode_micropeach: 0,
      cloud_hosted_mode_micropeach: store.pricingMicropeach,
      charge_policy: "POST_CONFIRMATION_ONLY"
    }
  })),

  route(
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
        // Validate the explicit manual window BEFORE any PRECHECK/state change:
        // a rejected manual execution must consume nothing (task stays armed).
        // Jobs already dispatched/RESULT_UNKNOWN skip this and proceed to the
        // read-only reconciliation path below.
        const manualVerdict = validateManualExecution({
          job,
          schoolRules: schoolProvider.getRules(),
          nowMs
        });
        if (!manualVerdict.ok) {
          throw new ContractError(
            manualVerdict.code,
            manualVerdict.message,
            manualVerdict.detail
          );
        }
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
  ),

  route(
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
  )
  ];
}
