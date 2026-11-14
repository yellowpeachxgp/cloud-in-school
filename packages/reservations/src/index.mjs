import crypto from "node:crypto";
import { ContractError } from "../../contracts/src/index.mjs";

/**
 * ADR-005 Dynamic Target Time T (T-30m / T-5m / T) Triple-Schedule Reservation Engine.
 * Enforces:
 * - Arbitrary user-selected target local time T within school's official daily window (e.g. 07:00:00 to 21:30:00 Asia/Shanghai)
 * - Precheck := T - 30 minutes (1800s), FinalCheck := T - 5 minutes (300s), Fire := T
 * - Three independent durable events in `booking_schedule_events` (`PRECHECK`, `FINAL_CHECK`, `FIRE`)
 * - Late creation catch-up rules (Section 27.02)
 * - CAS state transitions (`state_version`) and `RESULT_UNKNOWN` readback-first invariant (zero blind retry on timeout)
 */
export function normalizeLocalTimeString(timeStr) {
  if (typeof timeStr !== "string") {
    throw new ContractError("BAD_REQUEST", "target_local_time must be a string");
  }
  const trimmed = timeStr.trim();
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) {
    return `${trimmed}:00`;
  }
  if (/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(trimmed)) {
    return trimmed;
  }
  throw new ContractError("BAD_REQUEST", `Invalid target_local_time format: ${timeStr}`);
}

export function addDaysToLocalDate(yyyyMmDd, deltaDays) {
  const [y, m, d] = String(yyyyMmDd || "")
    .split("-")
    .map(Number);
  if (!y || !m || !d) return String(yyyyMmDd || "");
  const dt = new Date(Date.UTC(y, m - 1, d + Number(deltaDays || 0)));
  return dt.toISOString().slice(0, 10);
}

export function computeTripleSchedule({
  targetLocalDate,
  targetLocalTime,
  rules,
  precheckLeadSeconds = 1800,
  finalCheckLeadSeconds = 300,
  maxLatenessSeconds = 1800,
  nowMs = Date.now()
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetLocalDate || "")) {
    throw new ContractError("BAD_REQUEST", "target_local_date must be YYYY-MM-DD");
  }
  const normalizedTime = normalizeLocalTimeString(targetLocalTime);
  if (precheckLeadSeconds !== 1800 || finalCheckLeadSeconds !== 300) {
    throw new ContractError(
      "BAD_REQUEST",
      "ADR-005 requires fixed precheck_lead_seconds=1800 (T-30m) and final_check_lead_seconds=300 (T-5m)"
    );
  }
  if (normalizedTime < rules.window_start || normalizedTime >= rules.window_end_exclusive) {
    throw new ContractError(
      "BOOKING_WINDOW_CLOSED",
      `Target time ${normalizedTime} is outside school booking window [${rules.window_start}, ${rules.window_end_exclusive})`
    );
  }

  // Parse in Asia/Shanghai (+08:00)
  let targetAtMs = Date.parse(`${targetLocalDate}T${normalizedTime}+08:00`);
  const windowEndMs = Date.parse(`${targetLocalDate}T${rules.window_end_exclusive}+08:00`);
  const effectiveLatenessSeconds =
    typeof maxLatenessSeconds === "number" && maxLatenessSeconds > 0
      ? maxLatenessSeconds
      : rules.max_lateness_seconds_limit || 1800;
  const clampedLatenessMs =
    Math.min(Math.max(effectiveLatenessSeconds, 300), rules.max_lateness_seconds_limit || 1800) * 1000;
  let expiresAtMs = Math.min(targetAtMs + clampedLatenessMs, windowEndMs);

  if (nowMs > targetAtMs) {
    if (nowMs < windowEndMs) {
      // User selected today's date during open hours with an earlier default slot (e.g. 07:00:00);
      // upgrade to immediate catch-up within today's open window.
      targetAtMs = Math.min(nowMs + 2000, windowEndMs - 1000);
      expiresAtMs = Math.min(targetAtMs + Math.max(clampedLatenessMs, 300_000), windowEndMs);
    } else {
      throw new ContractError(
        "BOOKING_WINDOW_CLOSED",
        "Target time T has already passed its execution window (MISSED_WINDOW)"
      );
    }
  }

  const precheckAtMs = targetAtMs - precheckLeadSeconds * 1000;
  const finalCheckAtMs = targetAtMs - finalCheckLeadSeconds * 1000;
  const diffMs = targetAtMs - nowMs;

  let precheckInitialStatus = "ARMED";
  let finalCheckInitialStatus = "ARMED";
  let precheckDiagnostic = null;
  let finalCheckDiagnostic = null;

  if (diffMs < 30 * 60 * 1000 && diffMs > 5 * 60 * 1000) {
    precheckInitialStatus = "PRECHECK_LATE_OK";
    precheckDiagnostic = "IMMEDIATE_CATCHUP_PRECHECK";
  } else if (diffMs <= 5 * 60 * 1000 && diffMs > 0) {
    precheckInitialStatus = "PRECHECK_LATE_OK";
    finalCheckInitialStatus = "FINAL_CHECK_LATE_OK";
    precheckDiagnostic = "MERGED_IMMEDIATE_PRECHECK";
    finalCheckDiagnostic = "MERGED_IMMEDIATE_FINAL_CHECK";
  }

  return {
    targetLocalDate,
    targetLocalTime: normalizedTime,
    targetAtIso: new Date(targetAtMs).toISOString(),
    precheckAtIso: new Date(precheckAtMs).toISOString(),
    finalCheckAtIso: new Date(finalCheckAtMs).toISOString(),
    expiresAtIso: new Date(expiresAtMs).toISOString(),
    targetAtMs,
    precheckAtMs,
    finalCheckAtMs,
    expiresAtMs,
    precheckInitialStatus,
    finalCheckInitialStatus,
    precheckDiagnostic,
    finalCheckDiagnostic
  };
}

export class TripleScheduleEngine {
  constructor(store, schoolProvider, financeService, kmsVault) {
    this.store = store;
    this.schoolProvider = schoolProvider;
    this.financeService = financeService;
    this.kmsVault = kmsVault;
    this.inFlightJobs = new Map();
  }

  async withJobLock(jobId, fn) {
    while (this.inFlightJobs.has(jobId)) {
      await this.inFlightJobs.get(jobId);
    }
    let release;
    const p = new Promise((resolve) => {
      release = resolve;
    });
    this.inFlightJobs.set(jobId, p);
    try {
      return await fn();
    } finally {
      this.inFlightJobs.delete(jobId);
      release();
    }
  }

  createPlanAndJob(cloudUserId, payload, nowMs = Date.now()) {
    const binding = this.store.schoolBindings.get(payload.school_binding_id);
    if (!binding || binding.cloud_user_id !== cloudUserId) {
      throw new ContractError("CAMPUS_BINDING_REQUIRED", "School binding not found or not owned by user");
    }
    if (binding.revoked_at || binding.status === "REVOKED") {
      throw new ContractError("CONSENT_WITHDRAWN", "School binding has been revoked");
    }

    const consent = this.store.consents.get(payload.consent_id);
    if (!consent || consent.cloud_user_id !== cloudUserId || consent.withdrawn_at) {
      throw new ContractError("CONSENT_WITHDRAWN", "Active consent record is required");
    }
    if ((consent.school_id || binding.school_id) !== binding.school_id) {
      throw new ContractError("FORBIDDEN", "Consent school_id does not match binding school_id");
    }
    if (binding.consent_id && binding.consent_id !== consent.id) {
      throw new ContractError("CONFLICT", "Consent does not correspond to the target school binding");
    }
    if (
      binding.auth_version !== undefined &&
      consent.auth_version !== undefined &&
      Number(binding.auth_version) !== Number(consent.auth_version)
    ) {
      throw new ContractError("CONFLICT", "Binding and consent authorization versions do not match");
    }

    // Conflict check: same user/student_no + date active or in-flight job across bindings/devices
    const targetStudentNo = String(binding.student_no || "").trim();
    const matchingJobsForDate = Array.from(this.store.reservationJobs.values()).filter((j) => {
      if (j.booking_local_date !== payload.target_local_date) return false;
      if (
        [
          "CANCELLED",
          "REVOKED",
          "FAILED",
          "EXPIRED",
          "SCHOOL_CANCELLED",
          "SKIPPED_FINANCE",
          "SKIPPED_AUTH"
        ].includes(j.state)
      ) {
        return false;
      }
      if (j.school_binding_id === binding.id) return true;
      if (j.cloud_user_id === cloudUserId && j.school_id === binding.school_id) {
        const otherBind = this.store.schoolBindings.get(j.school_binding_id);
        const otherSno = String(otherBind?.student_no || "").trim();
        if (!targetStudentNo || !otherSno || otherSno === targetStudentNo) return true;
      }
      return false;
    });

    const unpaidDueOrders = this.store
      .recordsForUser("reservationOrders", cloudUserId)
      .filter((o) => o && o.payment_state === "PAYMENT_DUE");
    if (unpaidDueOrders.length > 0) {
      throw new ContractError(
        "CONFLICT",
        "您存在待补扣 🍑 的历史成功预约订单，请先补充 XPeach 余额完成结算后再开启新委托"
      );
    }

    if (matchingJobsForDate.length > 0) {
      const unreplaceableJob = matchingJobsForDate.find(
        (j) =>
          (j.external_execution_state &&
            j.external_execution_state !== "NOT_DISPATCHED" &&
            j.external_execution_state !== "SCHOOL_REJECTED") ||
          [
            "EXECUTING",
            "RESULT_UNKNOWN",
            "CONFIRMED",
            "DELEGATION_STOPPED_SCHOOL_CONFIRMED",
            "CANCEL_RESULT_UNKNOWN"
          ].includes(j.state)
      );
      if (unreplaceableJob) {
        throw new ContractError(
          "CONFLICT",
          `A reservation for ${payload.target_local_date} is already dispatched, awaiting verification (${unreplaceableJob.state}), or confirmed on school; refusing duplicate submission`
        );
      }
      if (payload.replace_existing !== true) {
        throw new ContractError(
          "CONFLICT",
          `An active reservation plan/job already exists for ${payload.target_local_date}`
        );
      }
    }

    const rules = this.schoolProvider.getRules();
    const defaultLatenessSec = rules.max_lateness_seconds_limit || 1800;
    const requestedLatenessSec =
      typeof payload.max_lateness_seconds === "number" && payload.max_lateness_seconds > 0
        ? payload.max_lateness_seconds
        : defaultLatenessSec;
    const schedule = computeTripleSchedule({
      targetLocalDate: payload.target_local_date,
      targetLocalTime: payload.target_local_time,
      rules,
      precheckLeadSeconds: payload.precheck_lead_seconds ?? 1800,
      finalCheckLeadSeconds: payload.final_check_lead_seconds ?? 300,
      maxLatenessSeconds: requestedLatenessSec,
      nowMs
    });

    const schoolIntegration = this.store.schoolIntegrations.get(binding.school_id);
    const { executionPath } = this.schoolProvider.assertOperationAllowed(
      "CREATE_BOOKING",
      schoolIntegration
    );

    const explicitSlotWindow =
      typeof payload.slot_window === "string" && payload.slot_window.trim().length > 0
        ? payload.slot_window.trim()
        : null;
    if (
      explicitSlotWindow &&
      !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\s*-\s*([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(
        explicitSlotWindow
      )
    ) {
      throw new ContractError("BAD_REQUEST", `Invalid slot_window format: ${explicitSlotWindow}`);
    }

    // Only after full schedule, capability, and slot_window validation succeeds do we replace existing queued jobs!
    if (matchingJobsForDate.length > 0 && payload.replace_existing === true) {
      const ts = new Date(nowMs).toISOString();
      for (const dupJob of matchingJobsForDate) {
        dupJob.user_intent_state = "STOP_REQUESTED";
        dupJob.external_execution_state = "NOT_DISPATCHED";
        dupJob.state = "CANCELLED";
        dupJob.state_version += 1;
        this.store.syncJobDisplayStatus?.(dupJob);
        for (const ev of this.store.eventsForJob(dupJob.id)) {
          if (ev.status === "ARMED") {
            ev.status = "ABORTED_REVOKED";
            ev.actual_at = ts;
          }
        }
        const oldPlan = this.store.reservationPlans.get(dupJob.plan_id);
        if (oldPlan) {
          oldPlan.enabled = false;
          oldPlan.user_intent_state = "STOP_REQUESTED";
        }
      }
    }

    const planId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const generation = 1;
    const repeatDays = Math.min(
      Math.max(Number(payload.repeat_days ?? payload.repeatDays ?? 1) || 1, 1),
      30
    );
    const remainingDays = Math.min(
      Math.max(Number(payload.remaining_days ?? payload.remainingDays ?? repeatDays) || repeatDays, 1),
      repeatDays
    );
    const endLocalDate = addDaysToLocalDate(schedule.targetLocalDate, remainingDays - 1);

    const currentAuthVersion = Number(
      this.store.users?.get(cloudUserId)?.auth_version ||
        binding.auth_version ||
        consent.auth_version ||
        1
    );
    const plan = {
      id: planId,
      cloud_user_id: cloudUserId,
      school_binding_id: binding.id,
      school_id: binding.school_id,
      consent_id: consent.id,
      auth_version: currentAuthVersion,
      execution_mode: "CLOUD_HOSTED",
      target_local_date: schedule.targetLocalDate,
      target_local_time: schedule.targetLocalTime,
      repeat_days: repeatDays,
      remaining_days: remainingDays,
      end_local_date: endLocalDate,
      timezone_id: rules.time_zone,
      precheck_lead_seconds: 1800,
      final_check_lead_seconds: 300,
      max_lateness_seconds: requestedLatenessSec,
      policy_version: payload.accepted_policy_version || rules.rule_version,
      price_version: payload.accepted_price_version || "price-library-cloud-2026-11-v1",
      area_code: payload.area_code || (payload.preferred_area_ids && payload.preferred_area_ids[0]) || "4F_NORTH",
      area_name:
        payload.area_name ||
        (Array.isArray(payload.preferred_area_ids) && payload.preferred_area_ids[0]) ||
        payload.area_code ||
        "4楼北自习区",
      candidate_seats: payload.candidate_seats || payload.preferred_seat_ids || ["4N-001"],
      slot_window: explicitSlotWindow || "07:30-22:00",
      has_explicit_slot_window: Boolean(explicitSlotWindow),
      preferences_json: {
        preferred_area_ids: payload.preferred_area_ids || (payload.area_code ? [payload.area_code] : ["area-haut-north-4f"]),
        preferred_seat_ids: payload.preferred_seat_ids || payload.candidate_seats || ["N4-088"],
        allow_alternative_seat: payload.allow_alternative_seat === true
      },
      user_intent_state: "ACTIVE",
      student_no: String(binding.student_no || "").trim(),
      generation,
      enabled: true,
      created_at: new Date(nowMs).toISOString()
    };

    const events = [
      {
        id: crypto.randomUUID(),
        job_id: jobId,
        plan_id: planId,
        kind: "PRECHECK",
        due_at: schedule.precheckAtIso,
        actual_at: schedule.precheckDiagnostic ? new Date(nowMs).toISOString() : null,
        status: schedule.precheckInitialStatus,
        generation,
        diagnostic_code: schedule.precheckDiagnostic
      },
      {
        id: crypto.randomUUID(),
        job_id: jobId,
        plan_id: planId,
        kind: "FINAL_CHECK",
        due_at: schedule.finalCheckAtIso,
        actual_at: schedule.finalCheckDiagnostic ? new Date(nowMs).toISOString() : null,
        status: schedule.finalCheckInitialStatus,
        generation,
        diagnostic_code: schedule.finalCheckDiagnostic
      },
      {
        id: crypto.randomUUID(),
        job_id: jobId,
        plan_id: planId,
        kind: "FIRE",
        due_at: schedule.targetAtIso,
        actual_at: null,
        status: "ARMED",
        generation,
        diagnostic_code: null
      }
    ];

    const job = {
      id: jobId,
      plan_id: planId,
      cloud_user_id: cloudUserId,
      school_binding_id: binding.id,
      consent_id: consent.id,
      auth_version: currentAuthVersion,
      school_id: binding.school_id,
      student_no: targetStudentNo,
      booking_local_date: schedule.targetLocalDate,
      target_local_time: schedule.targetLocalTime,
      repeat_days: repeatDays,
      remaining_days: remainingDays,
      end_local_date: endLocalDate,
      precheck_at: schedule.precheckAtIso,
      final_check_at: schedule.finalCheckAtIso,
      fire_at: schedule.targetAtIso,
      due_at: schedule.targetAtIso,
      expires_at: schedule.expiresAtIso,
      state: schedule.finalCheckDiagnostic
        ? "FINAL_CHECK_OK"
        : schedule.precheckDiagnostic
          ? "PRECHECK_OK"
          : "ARMED",
      capability: executionPath,
      state_version: 1,
      lock_token: 0,
      generation,
      user_intent_state: "ACTIVE",
      external_execution_state: "NOT_DISPATCHED",
      school_cancellation_state: "NOT_REQUESTED",
      billing_state: "NOT_BILLED",
      display_status: schedule.finalCheckDiagnostic
        ? "FINAL_CHECK_OK"
        : schedule.precheckDiagnostic
          ? "PRECHECK_OK"
          : "ARMED",
      status_label: "委托待执行",
      confirmed_seat_id: null,
      confirmed_seat_name: null,
      confirmed_region_name: null,
      external_booking_id: null,
      attempt_count: 0,
      attempt_started_at: null,
      result_verified_at: null,
      last_error_code: null,
      created_at: new Date(nowMs).toISOString()
    };

    this.store.reservationPlans.set(planId, plan);
    this.store.indexUserScoped?.("reservationPlans", planId, cloudUserId);
    this.store.reservationJobs.set(jobId, job);
    this.store.indexUserScoped?.("reservationJobs", jobId, cloudUserId);
    for (const ev of events) {
      this.store.scheduleEvents.set(ev.id, ev);
      this.store.indexScheduleEvent?.(ev.id, ev);
    }
    if (typeof this.store.flushSnapshotSync === "function") {
      this.store.flushSnapshotSync();
    } else if (typeof this.store.saveSnapshot === "function") {
      this.store.saveSnapshot();
    }

    // Asynchronously prewarm target region & candidate seat IDs on job creation when live credentials exist
    if (
      binding.credential_ref &&
      typeof this.schoolProvider.prewarmJobTargetSeats === "function"
    ) {
      const prewarmAuthVer = Number(job.auth_version ?? plan.auth_version ?? 1);
      Promise.resolve()
        .then(async () => {
          if (
            !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
            (job.user_intent_state && job.user_intent_state !== "ACTIVE")
          ) {
            return;
          }
          const decrypted = this._decryptBindingCredential(job, binding, Date.now());
          const prewarmRes = await this.schoolProvider.prewarmJobTargetSeats({
            job,
            plan,
            binding,
            decryptedSecret: decrypted
          });
          if (
            !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
            (job.user_intent_state && job.user_intent_state !== "ACTIVE")
          ) {
            return;
          }
          if (prewarmRes?.auth) {
            this._updateBindingCredentialTokens(
              binding,
              prewarmRes.auth,
              decrypted,
              Date.now(),
              prewarmAuthVer
            );
          }
          if (prewarmRes?.prewarmed) {
            job.prewarmed_targets = prewarmRes.prewarmed;
          }
          if (typeof this.store.flushSnapshotSync === "function") {
            this.store.flushSnapshotSync();
          } else if (typeof this.store.saveSnapshot === "function") {
            this.store.saveSnapshot();
          }
        })
        .catch(() => {});
    }

    return {
      plan_id: planId,
      job_id: jobId,
      execution_mode: "CLOUD_HOSTED",
      target_local_date: schedule.targetLocalDate,
      target_local_time: schedule.targetLocalTime,
      repeat_days: repeatDays,
      remaining_days: remainingDays,
      end_local_date: endLocalDate,
      target_at: schedule.targetAtIso,
      precheck_at: schedule.precheckAtIso,
      final_check_at: schedule.finalCheckAtIso,
      school_window: {
        start: rules.window_start,
        end_exclusive: rules.window_end_exclusive,
        time_zone: rules.time_zone
      },
      status: job.state,
      capability: executionPath,
      schedule_events: events
    };
  }

  casJobState(jobId, expectedVersion, nextState, patch = {}) {
    const job = this.store.reservationJobs.get(jobId);
    if (!job || job.state_version !== expectedVersion) {
      return false;
    }
    if (
      ["CANCELLED", "REVOKED"].includes(job.state) &&
      nextState !== "CANCELLED" &&
      nextState !== "REVOKED" &&
      (!job.external_execution_state || job.external_execution_state === "NOT_DISPATCHED")
    ) {
      return false;
    }
    if (
      ["CANCELLED", "REVOKED"].includes(nextState) &&
      job.external_execution_state &&
      job.external_execution_state !== "NOT_DISPATCHED" &&
      job.external_execution_state !== "SCHOOL_REJECTED"
    ) {
      this.store._applyRevocationToJob?.(
        job,
        patch.last_diagnostic_message || "委托已停止",
        new Date().toISOString()
      );
      return false;
    }
    job.state = nextState;
    job.state_version += 1;
    Object.assign(job, patch);
    this.store.syncJobDisplayStatus?.(job);
    if (typeof this.store.flushSnapshotSync === "function") {
      this.store.flushSnapshotSync();
    } else if (typeof this.store.saveSnapshot === "function") {
      this.store.saveSnapshot();
    }
    return true;
  }

  _decryptBindingCredential(job, binding, nowMs = Date.now()) {
    if (!binding || binding.id !== job.school_binding_id || !binding.credential_ref) return null;
    const plan = job.plan_id ? this.store.reservationPlans?.get(job.plan_id) : null;
    const isTrackedReservationJob =
      Boolean(this.store.reservationJobs?.has?.(job.id)) ||
      Boolean(job.plan_id) ||
      Boolean(job.student_no);
    const expectedSno = isTrackedReservationJob
      ? String(job.student_no || plan?.student_no || "").trim()
      : String(binding.student_no || "").trim();
    const bindSno = String(binding.student_no || "").trim();
    if (!expectedSno || !bindSno || expectedSno !== bindSno) {
      throw new ContractError(
        "CONSENT_WITHDRAWN",
        "School binding identity no longer matches immutable job/plan student_no"
      );
    }
    const credRecord = this.store.encryptedCredentials.get(binding.credential_ref);
    if (!credRecord || credRecord.revoked_at || credRecord.binding_id !== binding.id) return null;
    const permit = this.kmsVault.issueAccessPermit({
      taskId: job.id,
      schoolId: job.school_id,
      bindingId: binding.id,
      credentialRef: binding.credential_ref,
      ttlSeconds: 15,
      nowMs
    });
    const plaintext = this.kmsVault.decryptSecretWithPermit(credRecord, permit, nowMs);
    if (typeof plaintext === "string" && plaintext.trim().startsWith("{")) {
      let parsedBundle = null;
      try {
        parsedBundle = JSON.parse(plaintext.trim());
      } catch {
        parsedBundle = null;
      }
      const bundleSno = String(parsedBundle?.student_no || parsedBundle?.studentId || "").trim();
      if (bundleSno && bundleSno !== expectedSno) {
        throw new ContractError(
          "CONSENT_WITHDRAWN",
          "Decrypted school credential student_no does not match immutable job/plan student_no"
        );
      }
    }
    if (typeof this.schoolProvider?.parseCredentialBundle === "function") {
      this.schoolProvider.parseCredentialBundle(plaintext, binding);
    }
    return plaintext;
  }

  _updateBindingCredentialTokens(
    binding,
    authResult,
    oldSecret,
    nowMs = Date.now(),
    expectedAuthVersion = null
  ) {
    if (!binding || !authResult?.rawToken) return false;
    const liveBind = this.store.schoolBindings?.get?.(binding.id) || binding;
    if (!liveBind || liveBind.revoked_at || liveBind.status === "REVOKED") {
      return false;
    }
    const liveUser = this.store.users?.get?.(liveBind.cloud_user_id) || null;
    if (liveUser && liveUser.status && liveUser.status !== "ACTIVE") {
      return false;
    }
    const currentUserAuthVer = Number(liveUser?.auth_version ?? liveBind.auth_version ?? 1);
    const currentBindAuthVer = Number(liveBind.auth_version ?? 1);
    if (currentBindAuthVer !== currentUserAuthVer) {
      return false;
    }
    if (
      expectedAuthVersion !== null &&
      expectedAuthVersion !== undefined &&
      Number(expectedAuthVersion) !== currentUserAuthVer
    ) {
      return false;
    }
    if (liveBind.consent_id && this.store.consents?.has?.(liveBind.consent_id)) {
      const liveConsent = this.store.consents.get(liveBind.consent_id);
      if (!liveConsent || liveConsent.withdrawn_at) {
        return false;
      }
    }
    const returnedSno = String(authResult?.userInfo?.userNo || "").trim();
    const bindSno = String(liveBind.student_no || "").trim();
    if (returnedSno && bindSno && returnedSno !== bindSno) {
      throw new ContractError(
        "CONSENT_WITHDRAWN",
        "Refreshed school session student_no does not match bound school identity"
      );
    }
    try {
      const parsed =
        oldSecret && String(oldSecret).trim().startsWith("{") ? JSON.parse(oldSecret) : {};
      const nextPayload = JSON.stringify({
        ...parsed,
        raw_token: authResult.rawToken,
        cas_tgc: authResult.casTgc || parsed.cas_tgc || "",
        cas_jsessionid: authResult.casJsessionId || parsed.cas_jsessionid || "",
        student_no: authResult.userInfo?.userNo || parsed.student_no || liveBind.student_no || "",
        user_name: authResult.userInfo?.userName || parsed.user_name || ""
      });
      const encrypted = this.kmsVault.encryptSecret({
        bindingId: liveBind.id,
        schoolId: liveBind.school_id,
        credentialKind: "DELEGATED_SESSION_BUNDLE",
        plaintext: nextPayload,
        expiresAt: new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString()
      });
      if (liveBind.revoked_at || liveBind.status === "REVOKED") {
        return false;
      }
      const prevRef = liveBind.credential_ref;
      if (prevRef && this.store.encryptedCredentials.has(prevRef)) {
        this.store.encryptedCredentials.get(prevRef).revoked_at = new Date(nowMs).toISOString();
      }
      this.store.encryptedCredentials.set(encrypted.id, encrypted);
      liveBind.credential_ref = encrypted.id;
      liveBind.credential_expires_at = encrypted.expires_at;
      if (typeof this.store.recordsForUser === "function") {
        for (const sib of this.store.recordsForUser("schoolBindings", liveBind.cloud_user_id)) {
          if (
            sib.id !== liveBind.id &&
            sib.school_id === liveBind.school_id &&
            !sib.revoked_at &&
            sib.status !== "REVOKED" &&
            String(sib.student_no || "").trim() === bindSno &&
            Number(sib.auth_version ?? 1) === currentBindAuthVer
          ) {
            sib.credential_ref = encrypted.id;
            sib.credential_expires_at = encrypted.expires_at;
          }
        }
      }
      return true;
    } catch {
      // Keep existing credential on non-fatal refresh update error
      return false;
    }
  }

  _isJobAuthorizationCurrent(job, plan, binding, consent) {
    if (
      !job ||
      !plan ||
      !plan.enabled ||
      (plan.user_intent_state && plan.user_intent_state !== "ACTIVE") ||
      (job.user_intent_state && job.user_intent_state !== "ACTIVE") ||
      !binding ||
      binding.revoked_at ||
      binding.status === "REVOKED" ||
      !consent ||
      consent.withdrawn_at
    ) {
      return false;
    }
    if (binding.id !== job.school_binding_id || binding.cloud_user_id !== job.cloud_user_id) {
      return false;
    }
    if (plan.school_binding_id && plan.school_binding_id !== binding.id) {
      return false;
    }
    const planSno = String(plan.student_no || "").trim();
    const jobSno = String(job.student_no || planSno).trim();
    const bindSno = String(binding.student_no || "").trim();
    if (!planSno || !jobSno || !bindSno || planSno !== bindSno || jobSno !== bindSno) {
      return false;
    }
    if (consent.cloud_user_id !== job.cloud_user_id) {
      return false;
    }
    if ((consent.school_id || binding.school_id) !== binding.school_id) {
      return false;
    }
    if (job.consent_id && consent.id !== job.consent_id) {
      return false;
    }
    if (plan.consent_id && consent.id !== plan.consent_id) {
      return false;
    }
    if (binding.consent_id && binding.consent_id !== consent.id) {
      return false;
    }
    const userAuthVer = Number(this.store.users?.get(job.cloud_user_id)?.auth_version || 1);
    const bindAuthVer = Number(binding.auth_version || 1);
    const consentAuthVer = Number(consent.auth_version || 1);
    const jobAuthVer = Number(job.auth_version ?? plan.auth_version ?? 1);
    const planAuthVer = Number(plan.auth_version ?? jobAuthVer);
    if (
      jobAuthVer !== userAuthVer ||
      planAuthVer !== userAuthVer ||
      bindAuthVer !== userAuthVer ||
      consentAuthVer !== userAuthVer
    ) {
      return false;
    }
    if (typeof this.store.recordsForUser === "function") {
      const activeSchoolConsents = this.store
        .recordsForUser("consents", job.cloud_user_id)
        .filter((c) => (c.school_id || job.school_id) === job.school_id && !c.withdrawn_at);
      if (activeSchoolConsents.length > 0) {
        const latestActiveConsent = activeSchoolConsents[activeSchoolConsents.length - 1];
        if (latestActiveConsent.id !== consent.id) {
          return false;
        }
      }
    }
    return true;
  }

  _abortJobForStaleAuthorization(job, plan, event, nowMs = Date.now()) {
    const ts = new Date(nowMs).toISOString();
    if (event) {
      event.status = "ABORTED_REVOKED";
      event.actual_at = ts;
    }
    if (plan) {
      plan.enabled = false;
      if (plan.user_intent_state === "ACTIVE") {
        plan.user_intent_state = "REVOKED";
      }
    }
    for (const ev of this.store.eventsForJob(job.id)) {
      if (ev.status === "ARMED") {
        ev.status = "ABORTED_REVOKED";
        ev.actual_at = ts;
      }
    }
    if (job.external_execution_state && job.external_execution_state !== "NOT_DISPATCHED") {
      this.store._applyRevocationToJob?.(
        job,
        "任务所属授权版本或同意记录已失效，但外部请求已派发",
        ts
      );
      if (typeof this.store.saveSnapshot === "function") {
        this.store.saveSnapshot();
      }
      const schoolReservation = this.store.schoolReservations.get(job.id) || null;
      return { job, event, schoolReservation };
    }

    job.user_intent_state =
      job.user_intent_state === "STOP_REQUESTED" ? "STOP_REQUESTED" : "REVOKED";
    job.external_execution_state = "NOT_DISPATCHED";
    if (job.state !== "CANCELLED" && job.state !== "REVOKED") {
      job.state = "CANCELLED";
      job.state_version += 1;
      job.last_error_code = "CONSENT_WITHDRAWN";
      job.last_diagnostic_message = "任务所属授权版本或同意记录已失效，已终止旧授权任务";
    }
    this.store.syncJobDisplayStatus?.(job);
    if (typeof this.store.flushSnapshotSync === "function") {
      this.store.flushSnapshotSync();
    } else if (typeof this.store.saveSnapshot === "function") {
      this.store.saveSnapshot();
    }
    return { job, event };
  }

  recordConfirmedBookingAfterRevocation(
    job,
    plan,
    binding,
    bookingResult,
    attemptRecord,
    event,
    nowMs = Date.now()
  ) {
    const ts = new Date(nowMs).toISOString();
    const externalBookingId = String(
      bookingResult?.externalBookingId ||
        job.external_booking_id ||
        job.pending_external_booking_id ||
        attemptRecord?.external_booking_id ||
        ""
    ).trim();
    const intentState =
      job.user_intent_state === "STOP_REQUESTED" ? "STOP_REQUESTED" : "REVOKED";
    if (!externalBookingId) {
      if (plan) {
        plan.enabled = false;
        plan.user_intent_state = intentState;
      }
      job.user_intent_state = intentState;
      job.external_execution_state = "RESULT_UNKNOWN";
      job.school_cancellation_state = "MANUAL_ACTION_REQUIRED";
      job.billing_state = "HELD_PENDING_REVIEW";
      job.last_error_code = "BOOKING_RESULT_UNKNOWN";
      job.last_diagnostic_message =
        "委托已停止，但缺少完整的学校预约编号凭据，已转入待核对状态（禁止盲目重试或升级为已确认）";
      job.state = "RESULT_UNKNOWN";
      job.state_version += 1;
      this.store.syncJobDisplayStatus?.(job);
      if (event) {
        event.status = "RESULT_UNKNOWN";
        event.actual_at = ts;
      }
      if (typeof this.store.flushSnapshotSync === "function") {
        this.store.flushSnapshotSync();
      } else if (typeof this.store.saveSnapshot === "function") {
        this.store.saveSnapshot();
      }
      return {
        job,
        event,
        schoolReservation: null,
        order: null,
        next_job_id: null,
        remaining_days: 0
      };
    }
    const regionAlias =
      bookingResult?.regionAlias ||
      attemptRecord?.candidate_region_name ||
      plan?.area_name ||
      "北四楼自习区";
    const seatAlias =
      bookingResult?.seatAlias ||
      attemptRecord?.candidate_seat_name ||
      plan?.candidate_seats?.[0] ||
      "N4-088";
    const evidenceSha256 =
      bookingResult?.evidenceSha256 ||
      crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            jobId: job.id,
            bindingId: binding?.id || job.school_binding_id,
            externalBookingId,
            seatAlias,
            regionAlias,
            revokedAfterDispatch: true
          })
        )
        .digest("hex");

    const schoolReservation = {
      id: this.store.schoolReservations.get(job.id)?.id || crypto.randomUUID(),
      job_id: job.id,
      school_id: job.school_id,
      external_booking_id: externalBookingId,
      evidence_sha256: evidenceSha256,
      official_status: "CONFIRMED",
      confirmed_official_status: "CONFIRMED",
      confirmed_booking_evidence: {
        external_booking_id: externalBookingId,
        seat_alias: seatAlias,
        region_alias: regionAlias,
        evidence_sha256: evidenceSha256,
        verified_at: ts,
        start_at: bookingResult?.startFull || bookingResult?.startAt || job.fire_at,
        end_at: bookingResult?.endFull || bookingResult?.endAt || job.expires_at
      },
      user_intent_state: intentState,
      school_cancellation_state: "MANUAL_ACTION_REQUIRED",
      verified_at: ts,
      region_alias: regionAlias,
      seat_alias: seatAlias,
      start_at: bookingResult?.startFull || bookingResult?.startAt || job.fire_at,
      end_at: bookingResult?.endFull || bookingResult?.endAt || job.expires_at
    };
    this.store.schoolReservations.set(job.id, schoolReservation);

    const attemptId = attemptRecord?.id || job.latest_attempt_id;
    if (attemptId) {
      this.store.updateReservationAttempt?.(attemptId, {
        external_execution_state: "SCHOOL_CONFIRMED",
        user_intent_state_at_completion: intentState,
        completed_at: ts,
        external_booking_id: externalBookingId,
        candidate_seat_name: seatAlias,
        candidate_region_name: regionAlias,
        readback_verified: Boolean(bookingResult?.verified),
        readback_evidence: {
          external_booking_id: externalBookingId,
          seat_alias: seatAlias,
          region_alias: regionAlias,
          evidence_sha256: evidenceSha256
        },
        billing_state: "HELD_PENDING_REVIEW"
      });
    }

    if (plan) {
      plan.enabled = false;
      plan.user_intent_state = intentState;
    }

    job.user_intent_state = intentState;
    job.external_execution_state = "SCHOOL_CONFIRMED";
    job.school_cancellation_state = "MANUAL_ACTION_REQUIRED";
    job.billing_state = "HELD_PENDING_REVIEW";
    job.external_booking_id = externalBookingId;
    job.confirmed_seat_name = seatAlias;
    job.confirmed_region_name = regionAlias;
    job.result_verified_at = ts;
    job.last_error_code = "DELEGATION_STOPPED_AFTER_DISPATCH";
    job.last_diagnostic_message =
      "委托已停止，但学校预约已成功（系统未自动扣费，未续期次日，请核对或按需取消该预约）";
    job.state = "DELEGATION_STOPPED_SCHOOL_CONFIRMED";
    job.state_version += 1;
    this.store.syncJobDisplayStatus?.(job);

    if (event) {
      event.status = "DELEGATION_STOPPED_SCHOOL_CONFIRMED";
      event.actual_at = ts;
      event.diagnostic_code = "DELEGATION_STOPPED_AFTER_DISPATCH";
    }
    for (const ev of this.store.eventsForJob(job.id)) {
      if (ev.status === "ARMED") {
        ev.status = "ABORTED_REVOKED";
        ev.actual_at = ts;
      }
    }

    this.store.addNotification?.({
      cloudUserId: job.cloud_user_id,
      category: "RESERVATION_REQUIRES_ATTENTION",
      title: "委托已停止，但学校预约已成功",
      body: `您在预约请求发出后停止或撤回了委托，但学校端已完成座位预约（${regionAlias} ${seatAlias}，预约号：${externalBookingId}）。系统未扣费且已停止后续计划，请前往核对或按需取消该笔学校预约。`
    });

    if (typeof this.store.flushSnapshotSync === "function") {
      this.store.flushSnapshotSync();
    } else if (typeof this.store.saveSnapshot === "function") {
      this.store.saveSnapshot();
    }
    return {
      job,
      event,
      schoolReservation,
      order: null,
      next_job_id: null,
      remaining_days: plan?.remaining_days ?? 0
    };
  }

  async runScheduleEvent(jobId, kind, nowMs = Date.now(), options = {}) {
    return this.withJobLock(jobId, async () => {
      const job = this.store.reservationJobs.get(jobId);
      if (!job) throw new ContractError("NOT_FOUND", "Reservation job not found");
      const plan = this.store.reservationPlans.get(job.plan_id);
      const binding = this.store.schoolBindings.get(job.school_binding_id);
      const consent = plan ? this.store.consents.get(plan.consent_id) : null;

      const event = this.store.eventsForJob(jobId).find(
        (e) => e.kind === kind && e.generation === job.generation
      );
      if (!event) {
        throw new ContractError("NOT_FOUND", `Schedule event ${kind} not found for job ${jobId}`);
      }
      if (
        [
          "CONFIRMED",
          "DELEGATION_STOPPED_SCHOOL_CONFIRMED",
          "SCHOOL_CANCELLED",
          "CANCEL_RESULT_UNKNOWN",
          "FAILED",
          "CANCELLED",
          "EXPIRED",
          "REVOKED",
          "SKIPPED_FINANCE",
          "SKIPPED_AUTH"
        ].includes(job.state)
      ) {
        if (event.status === "ARMED") {
          event.status = "SKIPPED_TERMINAL";
        }
        const schoolReservation = this.store.schoolReservations.get(job.id) || null;
        return { job, event, schoolReservation };
      }

      const isUnknownPostDispatch =
        job.state === "RESULT_UNKNOWN" ||
        job.external_execution_state === "RESULT_UNKNOWN" ||
        job.external_execution_state === "DISPATCH_INTENT" ||
        job.attempt_count >= 1;

      if (kind !== "FIRE" && isUnknownPostDispatch) {
        // Never allow PRECHECK or FINAL_CHECK to overwrite an already-dispatched or RESULT_UNKNOWN job!
        if (event.status === "ARMED") {
          event.status = "SKIPPED_ALREADY_DISPATCHED";
        }
        return {
          job,
          event,
          schoolReservation: this.store.schoolReservations.get(job.id) || null
        };
      }

      if (kind === "FIRE" && isUnknownPostDispatch) {
        // Never blind-retry an already-dispatched or RESULT_UNKNOWN job!
        const hasUsableEscrowCredential = Boolean(
          binding && !binding.revoked_at && binding.status !== "REVOKED" && binding.credential_ref
        );
        const canReconcileStoppedJob =
          hasUsableEscrowCredential &&
          (options.allowPostRevokeReadback === true || job.user_intent_state === "STOP_REQUESTED");
        if (
          (!this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
            (job.user_intent_state && job.user_intent_state !== "ACTIVE")) &&
          !canReconcileStoppedJob
        ) {
          if (job.user_intent_state !== "REVOKED" && job.user_intent_state !== "STOP_REQUESTED") {
            this.store._applyRevocationToJob?.(
              job,
              "委托已停止，已发出的请求结果待核对",
              new Date(nowMs).toISOString()
            );
            if (typeof this.store.flushSnapshotSync === "function") {
              this.store.flushSnapshotSync();
            } else if (typeof this.store.saveSnapshot === "function") {
              this.store.saveSnapshot();
            }
          }
          return {
            job,
            event,
            schoolReservation: this.store.schoolReservations.get(job.id) || null
          };
        }

        let decryptedSecret = null;
        try {
          decryptedSecret = this._decryptBindingCredential(job, binding, nowMs);
        } catch {
          return { job, event };
        }
        try {
          const latestAttempt = this.store.latestAttemptForJob?.(job.id) || null;
          const readback = await this.schoolProvider.verifyBookingAuthoritative({
            job,
            plan,
            binding,
            decryptedSecret,
            expectedExternalBookingId:
              job.pending_external_booking_id ||
              job.external_booking_id ||
              latestAttempt?.external_booking_id ||
              null,
            expectedSeatAlias: latestAttempt?.candidate_seat_name || null,
            expectedRegionAlias: latestAttempt?.candidate_region_name || null
          });
          if (readback.verified) {
            if (
              !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
              (job.user_intent_state && job.user_intent_state !== "ACTIVE")
            ) {
              return this.recordConfirmedBookingAfterRevocation(
                job,
                plan,
                binding,
                readback,
                latestAttempt,
                event,
                nowMs
              );
            }
            return this.finalizeConfirmedBooking(job, binding, readback, event, nowMs, latestAttempt);
          }
          if (readback.officialStatus === "MISMATCHED_TARGET_SEAT_OR_DATE") {
            if (latestAttempt) {
              this.store.updateReservationAttempt?.(latestAttempt.id, {
                external_execution_state: "SCHOOL_REJECTED",
                completed_at: new Date(nowMs).toISOString()
              });
            }
            job.external_execution_state = "SCHOOL_REJECTED";
            event.status = "FAILED";
            event.actual_at = new Date(nowMs).toISOString();
            this.casJobState(jobId, job.state_version, "FAILED", {
              external_execution_state: "SCHOOL_REJECTED",
              last_error_code: "SCHOOL_REJECTED",
              last_diagnostic_message: "回查到的有效预约与目标候选座位或日期不匹配"
            });
            return { job, event };
          }
        } catch {
          // Keep RESULT_UNKNOWN on transient verification failure
        }
        return { job, event };
      }

      // Strict authorization version, binding, and consent correspondence check before any stage
      if (
        !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
        (job.user_intent_state && job.user_intent_state !== "ACTIVE")
      ) {
        return this._abortJobForStaleAuthorization(job, plan, event, nowMs);
      }

      if (kind === "PRECHECK") {
        // Read-only precheck at T-30m: check binding, rules, wallet availability
        try {
          const wallet = await this.financeService.getWalletSnapshot(job.cloud_user_id);
          if (wallet.micropeach_balance < this.store.pricingMicropeach) {
            event.status = "PRECHECK_NEEDS_USER";
            event.diagnostic_code = "WALLET_INSUFFICIENT";
            event.actual_at = new Date(nowMs).toISOString();
            this.casJobState(jobId, job.state_version, "SKIPPED_FINANCE", {
              last_error_code: "WALLET_INSUFFICIENT",
              last_diagnostic_message: "当前 XPeach 账户余额不足 1 🍑，本次云端抢座已跳过（未扣费）"
            });
            this._disarmRemainingScheduleEvents(jobId, "SKIPPED_TERMINAL", nowMs);
            this.store.addNotification?.({
              cloudUserId: job.cloud_user_id,
              category: "RESERVATION_SKIPPED_FINANCE",
              title: "云端抢座因余额不足已暂停",
              body: `您预约 ${job.booking_local_date} 的图书馆抢座任务在预检时检测到余额不足 1 🍑，已安全跳过（未扣费）。请前往 XPeach 充值后重新开启委托。`
            });
            return { job, event };
          }
        } catch {
          // Proceed if wallet check encounters transient network issue
        }
        if (binding.credential_ref && typeof this.schoolProvider.parseCredentialBundle === "function") {
          let decrypted = null;
          try {
            decrypted = this._decryptBindingCredential(job, binding, nowMs);
          } catch (decErr) {
            event.status = "PRECHECK_NEEDS_USER";
            event.diagnostic_code = decErr?.code || "SCHOOL_AUTH_EXPIRED";
            event.actual_at = new Date(nowMs).toISOString();
            this.casJobState(jobId, job.state_version, "SKIPPED_AUTH", {
              last_error_code: decErr?.code || "SCHOOL_AUTH_EXPIRED",
              last_diagnostic_message: "学校图书馆绑定授权已过期或失效，请重新验证学号与密码"
            });
            this._disarmRemainingScheduleEvents(jobId, "SKIPPED_TERMINAL", nowMs);
            this.store.addNotification?.({
              cloudUserId: job.cloud_user_id,
              category: "RESERVATION_SKIPPED_AUTH",
              title: "云端抢座需重新验证学校账号",
              body: `您预约 ${job.booking_local_date} 的图书馆抢座任务因学校授权凭证过期已暂停（未扣费），请重新绑定学号与密码。`
            });
            return { job, event };
          }
          const bundle = this.schoolProvider.parseCredentialBundle(decrypted, binding);
          if (bundle.isLiveCredential) {
            try {
              if (typeof this.schoolProvider.prewarmJobTargetSeats === "function") {
                const prewarmRes = await this.schoolProvider.prewarmJobTargetSeats({
                  job,
                  plan,
                  binding,
                  decryptedSecret: decrypted
                });
                if (
                  !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
                  (job.user_intent_state && job.user_intent_state !== "ACTIVE")
                ) {
                  return this._abortJobForStaleAuthorization(job, plan, event, nowMs);
                }
                if (prewarmRes?.auth) {
                  this._updateBindingCredentialTokens(
                    binding,
                    prewarmRes.auth,
                    decrypted,
                    nowMs,
                    job.auth_version
                  );
                }
                if (
                  prewarmRes?.prewarmed &&
                  Array.isArray(prewarmRes.prewarmed.candidate_seats) &&
                  prewarmRes.prewarmed.candidate_seats.length > 0
                ) {
                  job.prewarmed_targets = prewarmRes.prewarmed;
                } else {
                  job.prewarmed_targets = null;
                }
              } else {
                const authRes = await this.schoolProvider.authenticateHautSession(bundle, binding);
                if (
                  !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
                  (job.user_intent_state && job.user_intent_state !== "ACTIVE")
                ) {
                  return this._abortJobForStaleAuthorization(job, plan, event, nowMs);
                }
                this._updateBindingCredentialTokens(
                  binding,
                  authRes,
                  decrypted,
                  nowMs,
                  job.auth_version
                );
              }
            } catch {
              job.prewarmed_targets = null;
              // Will retry at FINAL_CHECK
            }
          }
        }
        if (
          !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
          (job.user_intent_state && job.user_intent_state !== "ACTIVE")
        ) {
          return this._abortJobForStaleAuthorization(job, plan, event, nowMs);
        }
        event.status = "PRECHECK_OK";
        event.actual_at = new Date(nowMs).toISOString();
        event.diagnostic_code = "READ_ONLY_PRECHECK_PASSED";
        this.casJobState(jobId, job.state_version, "PRECHECK_OK");
        return { job, event };
      }

      if (kind === "FINAL_CHECK") {
        // Read-only final quality gate at T-5m
        if (binding.credential_expires_at && new Date(binding.credential_expires_at).getTime() <= nowMs) {
          event.status = "FINAL_CHECK_NEEDS_USER";
          event.diagnostic_code = "SCHOOL_AUTH_EXPIRED";
          event.actual_at = new Date(nowMs).toISOString();
          this.casJobState(jobId, job.state_version, "SKIPPED_AUTH", {
            last_error_code: "SCHOOL_AUTH_EXPIRED",
            last_diagnostic_message: "学校图书馆绑定授权已过期，请重新验证学号与密码"
          });
          this._disarmRemainingScheduleEvents(jobId, "SKIPPED_TERMINAL", nowMs);
          return { job, event };
        }
        if (binding.credential_ref && typeof this.schoolProvider.parseCredentialBundle === "function") {
          let decrypted = null;
          try {
            decrypted = this._decryptBindingCredential(job, binding, nowMs);
          } catch (decErr) {
            event.status = "FINAL_CHECK_NEEDS_USER";
            event.diagnostic_code = decErr?.code || "SCHOOL_AUTH_EXPIRED";
            event.actual_at = new Date(nowMs).toISOString();
            this.casJobState(jobId, job.state_version, "SKIPPED_AUTH", {
              last_error_code: decErr?.code || "SCHOOL_AUTH_EXPIRED",
              last_diagnostic_message: "学校图书馆绑定授权已失效，请重新验证学号与密码"
            });
            this._disarmRemainingScheduleEvents(jobId, "SKIPPED_TERMINAL", nowMs);
            return { job, event };
          }
          const bundle = this.schoolProvider.parseCredentialBundle(decrypted, binding);
          if (bundle.isLiveCredential) {
            try {
              if (typeof this.schoolProvider.prewarmJobTargetSeats === "function") {
                const prewarmRes = await this.schoolProvider.prewarmJobTargetSeats({
                  job,
                  plan,
                  binding,
                  decryptedSecret: decrypted
                });
                if (
                  !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
                  (job.user_intent_state && job.user_intent_state !== "ACTIVE")
                ) {
                  return this._abortJobForStaleAuthorization(job, plan, event, nowMs);
                }
                if (prewarmRes?.auth) {
                  this._updateBindingCredentialTokens(
                    binding,
                    prewarmRes.auth,
                    decrypted,
                    nowMs,
                    job.auth_version
                  );
                }
                if (
                  prewarmRes?.prewarmed &&
                  Array.isArray(prewarmRes.prewarmed.candidate_seats) &&
                  prewarmRes.prewarmed.candidate_seats.length > 0
                ) {
                  job.prewarmed_targets = prewarmRes.prewarmed;
                } else {
                  job.prewarmed_targets = null;
                }
              } else {
                const authRes = await this.schoolProvider.authenticateHautSession(bundle, binding);
                if (
                  !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
                  (job.user_intent_state && job.user_intent_state !== "ACTIVE")
                ) {
                  return this._abortJobForStaleAuthorization(job, plan, event, nowMs);
                }
                this._updateBindingCredentialTokens(
                  binding,
                  authRes,
                  decrypted,
                  nowMs,
                  job.auth_version
                );
              }
            } catch (err) {
              job.prewarmed_targets = null;
              if (err?.code === "SCHOOL_AUTH_INVALID") {
                event.status = "FINAL_CHECK_NEEDS_USER";
                event.diagnostic_code = "SCHOOL_AUTH_INVALID";
                event.actual_at = new Date(nowMs).toISOString();
                this.casJobState(jobId, job.state_version, "SKIPPED_AUTH", {
                  last_error_code: "SCHOOL_AUTH_INVALID",
                  last_diagnostic_message:
                    err?.message || "学校统一身份认证学号或密码校验未通过，请重新绑定后再试"
                });
                this._disarmRemainingScheduleEvents(jobId, "SKIPPED_TERMINAL", nowMs);
                return { job, event };
              }
              event.diagnostic_code = err?.code || "FINAL_CHECK_AUTH_WARN";
            }
          }
        }
        if (
          !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
          (job.user_intent_state && job.user_intent_state !== "ACTIVE")
        ) {
          return this._abortJobForStaleAuthorization(job, plan, event, nowMs);
        }
        event.status = "FINAL_CHECK_OK";
        event.actual_at = new Date(nowMs).toISOString();
        event.diagnostic_code = event.diagnostic_code || "READ_ONLY_FINAL_CHECK_PASSED";
        this.casJobState(jobId, job.state_version, "FINAL_CHECK_OK");
        return { job, event };
      }

      if (kind === "FIRE") {
        const liveSchoolIntegration = this.store.schoolIntegrations.get(binding.school_id);
        if (liveSchoolIntegration?.kill_switch === true) {
          event.status = "ABORTED_KILL_SWITCH";
          event.diagnostic_code = "SCHOOL_KILL_SWITCH_ACTIVE";
          event.actual_at = new Date(nowMs).toISOString();
          this.casJobState(jobId, job.state_version, "CANCELLED", {
            last_error_code: "SCHOOL_KILL_SWITCH_ACTIVE",
            last_diagnostic_message: "学校自动化紧急熔断开关已启用，本次云端抢座已安全中止（未扣费）"
          });
          this._disarmRemainingScheduleEvents(jobId, "SKIPPED_TERMINAL", nowMs);
          return { job, event };
        }
        let decryptedSecret;
        try {
          decryptedSecret = this._decryptBindingCredential(job, binding, nowMs);
        } catch (decErr) {
          event.status = "FAILED";
          event.diagnostic_code = decErr?.code || "SCHOOL_AUTH_EXPIRED";
          event.actual_at = new Date(nowMs).toISOString();
          this.casJobState(jobId, job.state_version, "FAILED", {
            last_error_code: decErr?.code || "SCHOOL_AUTH_EXPIRED"
          });
          return { job, event };
        }

        // Check window & expiration (ensure at least 30m grace window after fire_at even on legacy jobs where expires_at === fire_at)
        const fireAtMs = new Date(job.fire_at).getTime();
        const rawExpiresAtMs = new Date(job.expires_at).getTime();
        const effectiveExpiresAtMs = Math.max(rawExpiresAtMs, fireAtMs + 1800 * 1000);
        if (!options.manualExecuteNow && nowMs < fireAtMs) {
          throw new ContractError("BOOKING_WINDOW_CLOSED", "Cannot execute FIRE before target time T");
        }
        const shTodayStr = new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
        const isPastBookingDate = Boolean(job.booking_local_date && job.booking_local_date < shTodayStr);
        if (options.manualExecuteNow ? isPastBookingDate : nowMs > effectiveExpiresAtMs) {
          event.status = "MISSED_WINDOW";
          event.actual_at = new Date(nowMs).toISOString();
          this.casJobState(jobId, job.state_version, "EXPIRED", { last_error_code: "MISSED_WINDOW" });
          this.rolloverMultiDayPlanIfEligible(plan, job, "错过开抢窗口", nowMs);
          return { job, event };
        }

        // Re-verify authorization version & consent immediately before acquiring execution lock and writing
        if (
          !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
          (job.user_intent_state && job.user_intent_state !== "ACTIVE")
        ) {
          return this._abortJobForStaleAuthorization(job, plan, event, nowMs);
        }

        // Acquire CAS execution lock
        const locked = this.casJobState(jobId, job.state_version, "EXECUTING", {
          lock_token: job.lock_token + 1,
          attempt_count: job.attempt_count + 1,
          attempt_started_at: new Date(nowMs).toISOString()
        });
        if (!locked) {
          return { job, event };
        }
        const executingStateVersion = job.state_version;
        const isStillAuthorized = () =>
          this._isJobAuthorizationCurrent(job, plan, binding, consent) &&
          (!job.user_intent_state || job.user_intent_state === "ACTIVE") &&
          job.state === "EXECUTING" &&
          job.state_version === executingStateVersion;

        const assertStillAuthorized = () => {
          if (!isStillAuthorized()) {
            throw new ContractError(
              "CONSENT_WITHDRAWN",
              "Authorization or job was revoked before external booking write"
            );
          }
        };

        let writeDispatchedInThisRun = false;
        let hasUnresolvedInFlightWrite = false;
        let activeAttempt = null;

        const onBeforeExternalWrite = async (targetInfo = {}) => {
          assertStillAuthorized();
          const attempt = this.store.createReservationAttempt({
            job_id: job.id,
            plan_id: job.plan_id,
            cloud_user_id: job.cloud_user_id,
            school_id: job.school_id,
            student_no: String(binding.student_no || "").trim(),
            binding_id: binding.id,
            consent_id: job.consent_id || plan?.consent_id || binding.consent_id,
            auth_version: Number(job.auth_version ?? plan?.auth_version ?? binding.auth_version ?? 1),
            target_local_date: targetInfo.targetDate || job.booking_local_date,
            slot_window: targetInfo.slotWindow || plan?.slot_window || "",
            candidate_seat_id: String(
              targetInfo.cand?.id ||
                targetInfo.cand?.seat_id ||
                targetInfo.cand?.seat_name ||
                "primary"
            ),
            candidate_seat_name: String(
              targetInfo.cand?.seat_name || targetInfo.cand?.short_name || ""
            ),
            candidate_region_name: String(targetInfo.regionName || ""),
            user_intent_state_at_dispatch: job.user_intent_state || "ACTIVE",
            dispatch_intent_at: new Date(nowMs).toISOString()
          });
          job.external_execution_state = "DISPATCH_INTENT";
          job.latest_attempt_id = attempt.id;
          this.store.syncJobDisplayStatus?.(job);
          try {
            if (typeof this.store.flushSnapshotStrictSync === "function") {
              this.store.flushSnapshotStrictSync();
            } else if (typeof this.store.flushSnapshotSync === "function") {
              this.store.flushSnapshotSync();
            } else if (typeof this.store.saveSnapshot === "function") {
              this.store.saveSnapshot();
            }
          } catch (persistErr) {
            // Rollback in-memory attempt if disk persistence failed and abort BEFORE calling school write API!
            this.store.reservationAttempts?.delete(attempt.id);
            job.external_execution_state = "NOT_DISPATCHED";
            job.latest_attempt_id = null;
            this.store.syncJobDisplayStatus?.(job);
            throw persistErr;
          }
          writeDispatchedInThisRun = true;
          hasUnresolvedInFlightWrite = true;
          activeAttempt = attempt;
          return attempt;
        };

        const onAfterExternalWrite = async (attemptId, outcomeInfo = {}) => {
          if (outcomeInfo.writeDispatched !== false) {
            writeDispatchedInThisRun = true;
          }
          if (outcomeInfo.explicitlyRejected === true || outcomeInfo.writeDispatched === false) {
            hasUnresolvedInFlightWrite = false;
          }
          const idToUpdate = attemptId || activeAttempt?.id;
          if (idToUpdate) {
            const patch = {
              raw_response_code: outcomeInfo.rawResponseCode ?? null,
              raw_response_msg: outcomeInfo.rawResponseMsg ?? null,
              external_booking_id: outcomeInfo.externalBookingId ?? null,
              candidate_seat_name:
                outcomeInfo.seatAlias || activeAttempt?.candidate_seat_name || "",
              candidate_region_name:
                outcomeInfo.regionAlias || activeAttempt?.candidate_region_name || "",
              user_intent_state_at_completion: job.user_intent_state || "ACTIVE"
            };
            if (outcomeInfo.explicitlyRejected === true) {
              patch.external_execution_state = "SCHOOL_REJECTED";
              patch.completed_at = new Date(nowMs).toISOString();
            }
            this.store.updateReservationAttempt?.(idToUpdate, patch);
          }
          if (outcomeInfo.externalBookingId) {
            job.pending_external_booking_id = outcomeInfo.externalBookingId;
            job.external_booking_id = outcomeInfo.externalBookingId;
          }
          if (typeof this.store.flushSnapshotSync === "function") {
            this.store.flushSnapshotSync();
          } else if (typeof this.store.saveSnapshot === "function") {
            this.store.saveSnapshot();
          }
        };

        const schoolIntegration = this.store.schoolIntegrations.get(job.school_id);
        let submitRes;
        try {
          submitRes = await this.schoolProvider.executeMockOrAuthorizedCreate({
            job,
            plan,
            binding,
            schoolIntegration,
            decryptedSecret,
            nowInstant: new Date(nowMs),
            allowDateFallbackToToday: Boolean(options.allowDateFallbackToToday),
            assertStillAuthorized,
            isStillAuthorized,
            onBeforeExternalWrite,
            onAfterExternalWrite
          });
        } catch (err) {
          if (
            !writeDispatchedInThisRun &&
            (err?.code === "CONSENT_WITHDRAWN" || !isStillAuthorized())
          ) {
            return this._abortJobForStaleAuthorization(job, plan, event, nowMs);
          }
          if (
            writeDispatchedInThisRun &&
            !hasUnresolvedInFlightWrite &&
            (err?.code === "CONSENT_WITHDRAWN" || !isStillAuthorized())
          ) {
            submitRes = {
              outcome: "FAILED",
              writeDispatched: true,
              revokedDuringFlight: true,
              errorCode: "SCHOOL_REJECTED",
              diagnosticMessage: "委托已停止且此前尝试的座位已被学校明确拒绝，未发起后续候选写入"
            };
          } else {
            submitRes = {
              outcome: hasUnresolvedInFlightWrite ? "TIMEOUT_AMBIGUOUS" : "FAILED",
              writeDispatched: writeDispatchedInThisRun,
              errorCode: err?.code || "SCHOOL_EXECUTION_ERROR",
              diagnosticMessage: err?.message || "学校选座接口请求异常"
            };
          }
        }

        const wasDispatched = Boolean(writeDispatchedInThisRun || submitRes?.writeDispatched);
        const revokedAfterDispatch =
          !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
          (job.user_intent_state && job.user_intent_state !== "ACTIVE") ||
          Boolean(submitRes?.revokedDuringFlight) ||
          job.state !== "EXECUTING" ||
          job.state_version !== executingStateVersion;

        // If no external write was dispatched and authorization was revoked during read-only query, abort cleanly as CANCELLED
        if (!wasDispatched && revokedAfterDispatch) {
          return this._abortJobForStaleAuthorization(job, plan, event, nowMs);
        }

        if (submitRes.rawToken && !revokedAfterDispatch) {
          this._updateBindingCredentialTokens(
            binding,
            { rawToken: submitRes.rawToken },
            decryptedSecret,
            nowMs
          );
        }

        const ts = new Date(nowMs).toISOString();
        if (submitRes.outcome === "TIMEOUT_AMBIGUOUS" || submitRes.outcome === "RESULT_UNKNOWN") {
          if (activeAttempt) {
            this.store.updateReservationAttempt?.(activeAttempt.id, {
              external_execution_state: "RESULT_UNKNOWN",
              user_intent_state_at_completion: revokedAfterDispatch
                ? job.user_intent_state === "STOP_REQUESTED"
                  ? "STOP_REQUESTED"
                  : "REVOKED"
                : "ACTIVE",
              completed_at: ts,
              external_booking_id: submitRes.externalBookingId || null
            });
          }
          job.pending_external_booking_id = submitRes.externalBookingId || null;
          job.external_execution_state = "RESULT_UNKNOWN";
          if (revokedAfterDispatch) {
            job.user_intent_state =
              job.user_intent_state === "STOP_REQUESTED" ? "STOP_REQUESTED" : "REVOKED";
            if (plan) {
              plan.enabled = false;
              plan.user_intent_state = job.user_intent_state;
            }
          }
          event.status = "RESULT_UNKNOWN";
          event.actual_at = ts;
          job.state = "RESULT_UNKNOWN";
          job.state_version += 1;
          job.last_error_code = "BOOKING_RESULT_UNKNOWN";
          job.last_diagnostic_message =
            submitRes.diagnosticMessage ||
            (revokedAfterDispatch ? "委托已停止，但已发出的选座请求结果待核对" : null);
          this.store.syncJobDisplayStatus?.(job);
          if (typeof this.store.flushSnapshotSync === "function") {
            this.store.flushSnapshotSync();
          } else if (typeof this.store.saveSnapshot === "function") {
            this.store.saveSnapshot();
          }
          return { job, event };
        }

        if (submitRes.outcome === "FAILED") {
          if (activeAttempt) {
            this.store.updateReservationAttempt?.(activeAttempt.id, {
              external_execution_state: "SCHOOL_REJECTED",
              user_intent_state_at_completion: revokedAfterDispatch
                ? job.user_intent_state === "STOP_REQUESTED"
                  ? "STOP_REQUESTED"
                  : "REVOKED"
                : "ACTIVE",
              completed_at: ts
            });
          }
          job.external_execution_state = "SCHOOL_REJECTED";
          if (revokedAfterDispatch) {
            job.user_intent_state =
              job.user_intent_state === "STOP_REQUESTED" ? "STOP_REQUESTED" : "REVOKED";
            if (plan) {
              plan.enabled = false;
              plan.user_intent_state = job.user_intent_state;
            }
            event.status = "ABORTED_REVOKED";
            event.actual_at = ts;
            job.state = "CANCELLED";
            job.state_version += 1;
            job.last_error_code = submitRes.errorCode || "SCHOOL_REJECTED";
            job.last_diagnostic_message =
              submitRes.diagnosticMessage || "委托已停止且当次学校预约未成功";
            this.store.syncJobDisplayStatus?.(job);
            if (typeof this.store.saveSnapshot === "function") {
              this.store.saveSnapshot();
            }
            return { job, event };
          }
          event.status = "FAILED";
          event.actual_at = ts;
          this.casJobState(jobId, executingStateVersion, "FAILED", {
            external_execution_state: "SCHOOL_REJECTED",
            last_error_code: submitRes.errorCode || "SCHOOL_REJECTED",
            last_diagnostic_message: submitRes.diagnosticMessage || null
          });
          this.rolloverMultiDayPlanIfEligible(
            plan,
            job,
            submitRes.diagnosticMessage || "当日未抢到",
            nowMs
          );
          return { job, event };
        }

        // If external write succeeded (SUBMITTED) and user revoked while it was in flight,
        // NEVER discard the result! Persist the booking evidence and mark DELEGATION_STOPPED_SCHOOL_CONFIRMED.
        if (revokedAfterDispatch) {
          return this.recordConfirmedBookingAfterRevocation(
            job,
            plan,
            binding,
            submitRes,
            activeAttempt,
            event,
            nowMs
          );
        }

        // Authoritative readback verification (HTTP 200 alone is never sufficient!)
        let verifyRes = { verified: false };
        try {
          verifyRes = await this.schoolProvider.verifyBookingAuthoritative({
            job,
            plan,
            binding,
            decryptedSecret,
            rawToken: submitRes.rawToken || null,
            expectedExternalBookingId: submitRes.externalBookingId,
            expectedSeatAlias: submitRes.seatAlias || null,
            expectedRegionAlias: submitRes.regionAlias || null,
            expectedStartFull: submitRes.startFull || null,
            expectedEndFull: submitRes.endFull || null
          });
        } catch {
          verifyRes = { verified: false, officialStatus: "READBACK_ERROR" };
        }

        const revokedDuringVerify =
          !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
          (job.user_intent_state && job.user_intent_state !== "ACTIVE") ||
          job.state !== "EXECUTING" ||
          job.state_version !== executingStateVersion;

        if (revokedDuringVerify) {
          if (
            verifyRes.verified ||
            (submitRes.externalBookingId &&
              verifyRes.officialStatus !== "MISMATCHED_TARGET_SEAT_OR_DATE")
          ) {
            return this.recordConfirmedBookingAfterRevocation(
              job,
              plan,
              binding,
              {
                ...submitRes,
                ...verifyRes,
                externalBookingId: verifyRes.externalBookingId || submitRes.externalBookingId,
                seatAlias: verifyRes.seatAlias || submitRes.seatAlias,
                regionAlias: verifyRes.regionAlias || submitRes.regionAlias
              },
              activeAttempt,
              event,
              nowMs
            );
          }
          if (verifyRes.officialStatus === "MISMATCHED_TARGET_SEAT_OR_DATE") {
            if (activeAttempt) {
              this.store.updateReservationAttempt?.(activeAttempt.id, {
                external_execution_state: "SCHOOL_REJECTED",
                completed_at: new Date(nowMs).toISOString()
              });
            }
            job.external_execution_state = "SCHOOL_REJECTED";
            job.user_intent_state =
              job.user_intent_state === "STOP_REQUESTED" ? "STOP_REQUESTED" : "REVOKED";
            job.state = "CANCELLED";
            job.state_version += 1;
            this.store.syncJobDisplayStatus?.(job);
            if (typeof this.store.saveSnapshot === "function") {
              this.store.saveSnapshot();
            }
            return { job, event };
          }
          if (activeAttempt) {
            this.store.updateReservationAttempt?.(activeAttempt.id, {
              external_execution_state: "RESULT_UNKNOWN",
              completed_at: new Date(nowMs).toISOString()
            });
          }
          job.pending_external_booking_id = submitRes.externalBookingId || null;
          job.external_execution_state = "RESULT_UNKNOWN";
          job.user_intent_state =
            job.user_intent_state === "STOP_REQUESTED" ? "STOP_REQUESTED" : "REVOKED";
          job.state = "RESULT_UNKNOWN";
          job.state_version += 1;
          this.store.syncJobDisplayStatus?.(job);
          if (typeof this.store.flushSnapshotSync === "function") {
            this.store.flushSnapshotSync();
          } else if (typeof this.store.saveSnapshot === "function") {
            this.store.saveSnapshot();
          }
          return { job, event };
        }

        if (!verifyRes.verified) {
          if (verifyRes.officialStatus === "MISMATCHED_TARGET_SEAT_OR_DATE") {
            if (activeAttempt) {
              this.store.updateReservationAttempt?.(activeAttempt.id, {
                external_execution_state: "SCHOOL_REJECTED",
                completed_at: new Date(nowMs).toISOString()
              });
            }
            event.status = "FAILED";
            event.actual_at = new Date(nowMs).toISOString();
            this.casJobState(jobId, executingStateVersion, "FAILED", {
              external_execution_state: "SCHOOL_REJECTED",
              last_error_code: "SCHOOL_REJECTED",
              last_diagnostic_message: "回查到的有效预约与目标候选座位或日期不匹配"
            });
            this.rolloverMultiDayPlanIfEligible(plan, job, "当日预约核验不匹配", nowMs);
            return { job, event };
          }
          if (activeAttempt) {
            this.store.updateReservationAttempt?.(activeAttempt.id, {
              external_execution_state: "RESULT_UNKNOWN",
              completed_at: new Date(nowMs).toISOString(),
              external_booking_id: submitRes.externalBookingId || null
            });
          }
          job.pending_external_booking_id = submitRes.externalBookingId;
          event.status = "RESULT_UNKNOWN";
          event.actual_at = new Date(nowMs).toISOString();
          this.casJobState(jobId, executingStateVersion, "RESULT_UNKNOWN", {
            external_execution_state: "RESULT_UNKNOWN",
            last_error_code: "BOOKING_RESULT_UNKNOWN"
          });
          return { job, event };
        }

        return this.finalizeConfirmedBooking(
          job,
          binding,
          {
            ...verifyRes,
            seatAlias: verifyRes.seatAlias || submitRes.seatAlias,
            regionAlias: verifyRes.regionAlias || submitRes.regionAlias
          },
          event,
          nowMs,
          activeAttempt
        );
      }

      throw new ContractError("BAD_REQUEST", `Unknown schedule event kind: ${kind}`);
    });
  }

  _disarmRemainingScheduleEvents(jobId, status = "SKIPPED_TERMINAL", nowMs = Date.now()) {
    const ts = new Date(nowMs).toISOString();
    for (const ev of this.store.eventsForJob(jobId)) {
      if (ev.status === "ARMED") {
        ev.status = status;
        ev.actual_at = ev.actual_at || ts;
      }
    }
    if (typeof this.store.saveSnapshot === "function") {
      this.store.saveSnapshot();
    }
  }

  _flushStopStateStrict() {
    if (typeof this.store.flushSnapshotStrictSync === "function") {
      this.store.flushSnapshotStrictSync();
    } else if (typeof this.store.flushSnapshotSync === "function") {
      this.store.flushSnapshotSync();
    } else if (typeof this.store.saveSnapshot === "function") {
      this.store.saveSnapshot();
    }
  }

  stopPlanAndActiveJobs({
    planId = null,
    jobId = null,
    cloudUserId = null,
    reason = "用户停止预约计划委托",
    nowMs = Date.now()
  } = {}) {
    const targetJob = jobId ? this.store.reservationJobs.get(jobId) : null;
    if (jobId && !targetJob) {
      throw new ContractError("NOT_FOUND", "Reservation job not found");
    }
    if (targetJob && cloudUserId && targetJob.cloud_user_id !== cloudUserId) {
      throw new ContractError("FORBIDDEN", "Cross-user reservation job cancel denied");
    }
    const resolvedPlanId = planId || targetJob?.plan_id || null;
    const plan = resolvedPlanId ? this.store.reservationPlans.get(resolvedPlanId) : null;
    if (planId && (!plan || (cloudUserId && plan.cloud_user_id !== cloudUserId))) {
      throw new ContractError("NOT_FOUND", "Reservation plan not found");
    }

    const relatedJobs = plan
      ? Array.from(this.store.reservationJobs.values()).filter((j) => j.plan_id === plan.id)
      : targetJob
        ? [targetJob]
        : [];
    const hadPendingStopPersistence = Boolean(
      plan?._stopPersistencePending || relatedJobs.some((j) => j?._stopPersistencePending)
    );

    const ts = new Date(nowMs).toISOString();
    if (plan) {
      plan.enabled = false;
      plan.remaining_days = 0;
      if (plan.user_intent_state !== "REVOKED") {
        plan.user_intent_state = "STOP_REQUESTED";
      }
      plan.updated_at = ts;
      plan._stopPersistencePending = true;
    }

    const cancelledJobIds = [];
    const blockingJobs = [];

    for (const j of relatedJobs) {
      j._stopPersistencePending = true;
      for (const ev of this.store.eventsForJob(j.id)) {
        if (ev.status === "ARMED") {
          ev.status = "ABORTED_REVOKED";
          ev.actual_at = ts;
        }
      }

      if (
        [
          "FAILED",
          "EXPIRED",
          "CANCELLED",
          "REVOKED",
          "SCHOOL_CANCELLED",
          "SKIPPED_FINANCE",
          "SKIPPED_AUTH"
        ].includes(j.state)
      ) {
        j.remaining_days = 0;
        if (j.user_intent_state !== "REVOKED") {
          j.user_intent_state = "STOP_REQUESTED";
        }
        this.store.syncJobDisplayStatus?.(j);
        continue;
      }

      const sr = this.store.schoolReservations.get(j.id) || null;
      const hasDispatchedOrConfirmed =
        (j.external_execution_state &&
          j.external_execution_state !== "NOT_DISPATCHED" &&
          j.external_execution_state !== "SCHOOL_REJECTED") ||
        [
          "CONFIRMED",
          "DELEGATION_STOPPED_SCHOOL_CONFIRMED",
          "CANCEL_RESULT_UNKNOWN",
          "RESULT_UNKNOWN"
        ].includes(j.state) ||
        Boolean(sr?.external_booking_id) ||
        Boolean(j.external_booking_id) ||
        Boolean(j.pending_external_booking_id);

      if (j.state === "EXECUTING") {
        // Out-of-lock immediate stop intent: FIRE will observe user_intent_state !== 'ACTIVE' at the next check!
        if (j.user_intent_state !== "REVOKED") {
          j.user_intent_state = "STOP_REQUESTED";
        }
        j.remaining_days = 0;
        this.store.syncJobDisplayStatus?.(j);
        blockingJobs.push({
          id: j.id,
          booking_local_date: j.booking_local_date,
          state: j.state,
          external_execution_state: j.external_execution_state || "NOT_DISPATCHED",
          external_booking_id: sr?.external_booking_id || j.external_booking_id || null
        });
        continue;
      }

      if (hasDispatchedOrConfirmed) {
        const wasRevoked = j.user_intent_state === "REVOKED";
        this.store._applyRevocationToJob?.(j, reason, ts);
        if (!wasRevoked && j.user_intent_state === "REVOKED") {
          j.user_intent_state = "STOP_REQUESTED";
        }
        j.remaining_days = 0;
        this.store.syncJobDisplayStatus?.(j);
        blockingJobs.push({
          id: j.id,
          booking_local_date: j.booking_local_date,
          state: j.state,
          external_execution_state: j.external_execution_state || "RESULT_UNKNOWN",
          school_cancellation_state: j.school_cancellation_state || "NOT_REQUESTED",
          external_booking_id: sr?.external_booking_id || j.external_booking_id || null
        });
      } else {
        j.user_intent_state = j.user_intent_state === "REVOKED" ? "REVOKED" : "STOP_REQUESTED";
        j.external_execution_state =
          j.external_execution_state === "SCHOOL_REJECTED" ? "SCHOOL_REJECTED" : "NOT_DISPATCHED";
        j.state = "CANCELLED";
        j.remaining_days = 0;
        j.state_version += 1;
        j.last_diagnostic_message = reason;
        this.store.syncJobDisplayStatus?.(j);
        cancelledJobIds.push(j.id);
      }
    }

    this._flushStopStateStrict();

    return {
      plan_id: plan?.id || null,
      plan_enabled: plan ? Boolean(plan.enabled) : false,
      target_job: targetJob || null,
      cancelled_job_ids: cancelledJobIds,
      blocking_jobs: blockingJobs,
      completed_pending_persistence: hadPendingStopPersistence
    };
  }

  async cancelConfirmedOrActiveJob(jobId, nowMs = Date.now()) {
    const preLockJob = this.store.reservationJobs.get(jobId);
    if (!preLockJob) throw new ContractError("NOT_FOUND", "Reservation job not found");
    const preLockSchoolRes = this.store.schoolReservations.get(preLockJob.id);
    const hadUnknownCancelAtEntry =
      preLockJob.state === "CANCEL_RESULT_UNKNOWN" ||
      preLockJob.school_cancellation_state === "CANCEL_RESULT_UNKNOWN" ||
      preLockJob.school_cancellation_state === "CANCEL_IN_PROGRESS" ||
      preLockSchoolRes?.school_cancellation_state === "CANCEL_RESULT_UNKNOWN" ||
      preLockSchoolRes?.school_cancellation_state === "CANCEL_IN_PROGRESS" ||
      preLockSchoolRes?.official_status === "CANCEL_RESULT_UNKNOWN";
    const wasConfirmedAtCancelEntry =
      preLockJob.external_execution_state === "SCHOOL_CONFIRMED" ||
      preLockJob.state === "CONFIRMED" ||
      preLockJob.state === "DELEGATION_STOPPED_SCHOOL_CONFIRMED" ||
      preLockJob.state === "CANCEL_RESULT_UNKNOWN" ||
      hadUnknownCancelAtEntry ||
      Boolean(preLockSchoolRes?.external_booking_id) ||
      Boolean(preLockJob.external_booking_id);

    // Record stop intent IMMEDIATELY outside withJobLock so any in-flight FIRE sees STOP_REQUESTED
    // before external write, before billing debit, and before multi-day rollover!
    // Also durably flushes stop intent via flushSnapshotStrictSync (fails closed on I/O error).
    this.stopPlanAndActiveJobs({
      planId: preLockJob.plan_id,
      jobId,
      cloudUserId: preLockJob.cloud_user_id,
      reason: "用户请求取消或停止预约任务",
      nowMs
    });

    return this.withJobLock(jobId, async () => {
      const job = this.store.reservationJobs.get(jobId);
      if (!job) throw new ContractError("NOT_FOUND", "Reservation job not found");
      const binding = this.store.schoolBindings.get(job.school_binding_id);
      const plan = this.store.reservationPlans.get(job.plan_id);
      const schoolRes = this.store.schoolReservations.get(job.id);
      const ts = new Date(nowMs).toISOString();
      const hadUnknownCancel =
        hadUnknownCancelAtEntry ||
        job.state === "CANCEL_RESULT_UNKNOWN" ||
        job.school_cancellation_state === "CANCEL_RESULT_UNKNOWN" ||
        job.school_cancellation_state === "CANCEL_IN_PROGRESS" ||
        schoolRes?.school_cancellation_state === "CANCEL_RESULT_UNKNOWN" ||
        schoolRes?.school_cancellation_state === "CANCEL_IN_PROGRESS" ||
        schoolRes?.official_status === "CANCEL_RESULT_UNKNOWN";

      // Re-ensure plan and any newly rolled-over sibling jobs are stopped after lock acquisition
      if (plan) {
        plan.enabled = false;
        plan.remaining_days = 0;
        plan._stopPersistencePending = true;
        if (plan.user_intent_state === "ACTIVE" || !plan.user_intent_state) {
          plan.user_intent_state = "STOP_REQUESTED";
        }
        for (const sib of this.store.reservationJobs.values()) {
          if (sib.plan_id === plan.id && sib.id !== job.id) {
            if (
              (!sib.external_execution_state || sib.external_execution_state === "NOT_DISPATCHED") &&
              !["CONFIRMED", "DELEGATION_STOPPED_SCHOOL_CONFIRMED", "RESULT_UNKNOWN", "CANCEL_RESULT_UNKNOWN", "SCHOOL_CANCELLED", "FAILED", "EXPIRED", "CANCELLED"].includes(sib.state)
            ) {
              sib.user_intent_state = "STOP_REQUESTED";
              sib.external_execution_state = "NOT_DISPATCHED";
              sib.state = "CANCELLED";
              sib.remaining_days = 0;
              sib.state_version += 1;
              sib._stopPersistencePending = true;
              this.store.syncJobDisplayStatus?.(sib);
            }
          }
        }
      }
      for (const ev of this.store.eventsForJob(job.id)) {
        if (ev.status === "ARMED") {
          ev.status = "ABORTED_REVOKED";
          ev.actual_at = ts;
        }
      }

      if (job.state === "SCHOOL_CANCELLED") {
        this._flushStopStateStrict();
        return {
          job,
          school_reservation: schoolRes || null,
          live_cancel: {
            cancelled: true,
            outcome: "SCHOOL_CANCELLED",
            school_cancellation_state: "SCHOOL_CANCELLED",
            bookingId: schoolRes?.external_booking_id || job.external_booking_id || null
          }
        };
      }

      const hasExternalDispatch =
        (job.external_execution_state &&
          job.external_execution_state !== "NOT_DISPATCHED" &&
          job.external_execution_state !== "SCHOOL_REJECTED") ||
        job.state === "CONFIRMED" ||
        job.state === "DELEGATION_STOPPED_SCHOOL_CONFIRMED" ||
        job.state === "CANCEL_RESULT_UNKNOWN" ||
        hadUnknownCancel ||
        Boolean(schoolRes?.external_booking_id) ||
        Boolean(job.external_booking_id) ||
        Boolean(job.pending_external_booking_id);

      // Case 1: Never dispatched (or explicitly rejected by school before/during stop) -> purely stop delegation
      if (!hasExternalDispatch) {
        job.user_intent_state =
          job.user_intent_state === "REVOKED" ? "REVOKED" : "STOP_REQUESTED";
        job.external_execution_state =
          job.external_execution_state === "SCHOOL_REJECTED" ? "SCHOOL_REJECTED" : "NOT_DISPATCHED";
        if (!["FAILED", "EXPIRED"].includes(job.state)) {
          job.state = "CANCELLED";
        }
        job.remaining_days = 0;
        job.state_version += 1;
        job._stopPersistencePending = true;
        this.store.syncJobDisplayStatus?.(job);
        this._flushStopStateStrict();
        return {
          job,
          school_reservation: null,
          live_cancel: null
        };
      }

      // Case 2: External booking is in RESULT_UNKNOWN or DISPATCH_INTENT -> do not pretend cancelled
      if (
        job.external_execution_state === "RESULT_UNKNOWN" ||
        job.external_execution_state === "DISPATCH_INTENT"
      ) {
        job.user_intent_state =
          job.user_intent_state === "REVOKED" ? "REVOKED" : "STOP_REQUESTED";
        job.external_execution_state = "RESULT_UNKNOWN";
        job.state = "RESULT_UNKNOWN";
        job.remaining_days = 0;
        job.state_version += 1;
        job._stopPersistencePending = true;
        this.store.syncJobDisplayStatus?.(job);
        this._flushStopStateStrict();
        return {
          job,
          school_reservation: schoolRes || null,
          live_cancel: {
            cancelled: false,
            outcome: "RESULT_UNKNOWN",
            message: "委托已停止，但此前已发出的预约请求结果待核对，未确认前无法宣称学校端已取消"
          }
        };
      }

      // Case 2.5: Cancel was requested while FIRE was in flight (not yet confirmed at entry), and FIRE's in-flight write succeeded!
      // Preserve DELEGATION_STOPPED_SCHOOL_CONFIRMED & booking evidence without faking school seat cancellation or charging/rolling over!
      const exactBookingId = String(
        schoolRes?.external_booking_id ||
          job.external_booking_id ||
          job.pending_external_booking_id ||
          ""
      ).trim();

      if (!wasConfirmedAtCancelEntry) {
        job.user_intent_state =
          job.user_intent_state === "REVOKED" ? "REVOKED" : "STOP_REQUESTED";
        job.external_execution_state = exactBookingId ? "SCHOOL_CONFIRMED" : "RESULT_UNKNOWN";
        job.school_cancellation_state = "MANUAL_ACTION_REQUIRED";
        job.billing_state = "HELD_PENDING_REVIEW";
        job.state = exactBookingId ? "DELEGATION_STOPPED_SCHOOL_CONFIRMED" : "RESULT_UNKNOWN";
        job.remaining_days = 0;
        job.state_version += 1;
        job._stopPersistencePending = true;
        if (schoolRes) {
          schoolRes.confirmed_official_status = schoolRes.confirmed_official_status || "CONFIRMED";
          schoolRes.school_cancellation_state = "MANUAL_ACTION_REQUIRED";
        }
        this.store.syncJobDisplayStatus?.(job);
        this._flushStopStateStrict();
        return {
          job,
          school_reservation: schoolRes || null,
          live_cancel: {
            cancelled: false,
            outcome: exactBookingId ? "CONFIRMED_DURING_IN_FLIGHT_STOP" : "RESULT_UNKNOWN",
            school_cancellation_state: "MANUAL_ACTION_REQUIRED",
            bookingId: exactBookingId || null,
            message: exactBookingId
              ? `委托已停止（未扣费、未续期），但此前已发出的抢座请求已在学校端成功锁定座位（预约号：${exactBookingId}），如需退座请显式发起学校退座`
              : "委托已停止，但缺少精确预约编号，请核实学校端记录"
          }
        };
      }

      // Case 3: Confirmed booking existed before cancel-seat request -> require exact booking ID and check permission policy

      if (!exactBookingId) {
        job.user_intent_state =
          job.user_intent_state === "REVOKED" ? "REVOKED" : "STOP_REQUESTED";
        job.school_cancellation_state = hadUnknownCancel
          ? "CANCEL_RESULT_UNKNOWN"
          : "MANUAL_ACTION_REQUIRED";
        job.state = hadUnknownCancel
          ? "CANCEL_RESULT_UNKNOWN"
          : "DELEGATION_STOPPED_SCHOOL_CONFIRMED";
        job.state_version += 1;
        job._stopPersistencePending = true;
        if (hadUnknownCancel) {
          this.store._preserveConfirmedEvidenceForUnknownCancel?.(schoolRes, job);
        }
        this.store.syncJobDisplayStatus?.(job);
        this._flushStopStateStrict();
        return {
          job,
          school_reservation: schoolRes || null,
          live_cancel: {
            cancelled: false,
            outcome: hadUnknownCancel ? "CANCEL_RESULT_UNKNOWN" : "MISSING_EXACT_BOOKING_ID",
            school_cancellation_state: job.school_cancellation_state,
            message: hadUnknownCancel
              ? "缺少精确预约编号，保留此前退座待核对状态与原始预约证据"
              : "缺少精确关联的学校预约 ID，已保留预约证据并标记需人工或用户自行处理"
          }
        };
      }

      // If binding/credentials were revoked or school identity changed, forbid using credentials for school API calls
      const expectedCancelSno = String(
        job.student_no || plan?.student_no || binding?.student_no || ""
      ).trim();
      const cancelStartUser = this.store.users?.get?.(job.cloud_user_id) || null;
      const cancelStartAuthVer = Number(
        cancelStartUser?.auth_version ?? binding?.auth_version ?? job.auth_version ?? 1
      );
      const cancelStartRevokeSeq = Number(cancelStartUser?._lastRevocationSeq || 0);
      const cancelConsentId = job.consent_id || plan?.consent_id || binding?.consent_id || null;

      const isCancelAuthorizationStillValid = () => {
        const liveBind = binding?.id ? this.store.schoolBindings.get(binding.id) : null;
        if (
          !liveBind ||
          liveBind.revoked_at ||
          liveBind.status === "REVOKED" ||
          !liveBind.credential_ref
        ) {
          return false;
        }
        const liveBindSno = String(liveBind.student_no || "").trim();
        if (expectedCancelSno && (!liveBindSno || liveBindSno !== expectedCancelSno)) {
          return false;
        }
        if (
          plan?.student_no &&
          String(plan.student_no).trim() &&
          String(plan.student_no).trim() !== liveBindSno
        ) {
          return false;
        }
        const liveUser = this.store.users?.get?.(job.cloud_user_id) || null;
        if (liveUser) {
          if (liveUser.status && liveUser.status !== "ACTIVE") return false;
          if (Number(liveUser.auth_version || 1) !== cancelStartAuthVer) return false;
          if (Number(liveUser._lastRevocationSeq || 0) !== cancelStartRevokeSeq) return false;
        }
        if (Number(liveBind.auth_version ?? cancelStartAuthVer) !== cancelStartAuthVer) {
          return false;
        }
        if (cancelConsentId && this.store.consents?.has?.(cancelConsentId)) {
          const liveConsent = this.store.consents.get(cancelConsentId);
          if (!liveConsent || liveConsent.withdrawn_at) return false;
          if (Number(liveConsent.auth_version ?? cancelStartAuthVer) !== cancelStartAuthVer) {
            return false;
          }
        } else if (typeof this.store.recordsForUser === "function") {
          const activeConsents = this.store
            .recordsForUser("consents", job.cloud_user_id)
            .filter((c) => (c.school_id || job.school_id) === job.school_id && !c.withdrawn_at);
          if (activeConsents.length === 0) return false;
        }
        return true;
      };

      if (!isCancelAuthorizationStillValid()) {
        job.user_intent_state = "REVOKED";
        job.external_execution_state = "SCHOOL_CONFIRMED";
        job.school_cancellation_state = hadUnknownCancel
          ? "CANCEL_RESULT_UNKNOWN"
          : "MANUAL_ACTION_REQUIRED";
        job.state = hadUnknownCancel
          ? "CANCEL_RESULT_UNKNOWN"
          : "DELEGATION_STOPPED_SCHOOL_CONFIRMED";
        job.state_version += 1;
        job._stopPersistencePending = true;
        if (hadUnknownCancel) {
          this.store._preserveConfirmedEvidenceForUnknownCancel?.(schoolRes, job);
        } else if (schoolRes) {
          schoolRes.confirmed_official_status = schoolRes.confirmed_official_status || "CONFIRMED";
          schoolRes.school_cancellation_state = "MANUAL_ACTION_REQUIRED";
        }
        this.store.syncJobDisplayStatus?.(job);
        this._flushStopStateStrict();
        return {
          job,
          school_reservation: schoolRes || null,
          live_cancel: {
            cancelled: false,
            outcome: hadUnknownCancel
              ? "CANCEL_RESULT_UNKNOWN"
              : "REVOKED_CREDENTIALS_MANUAL_REQUIRED",
            school_cancellation_state: job.school_cancellation_state,
            bookingId: exactBookingId,
            message: hadUnknownCancel
              ? "学校绑定凭据已撤销，保留此前已发起的退座待核对状态与原始预约证据，请在学校端核实该预约号"
              : "学校绑定凭据已撤销，按权限策略不再代调学校接口，请使用预约号在学校端自行取消"
          }
        };
      }

      job.user_intent_state =
        job.user_intent_state === "REVOKED" ? "REVOKED" : "STOP_REQUESTED";
      job.school_cancellation_state = "CANCEL_IN_PROGRESS";
      job._stopPersistencePending = true;
      if (schoolRes) {
        schoolRes.confirmed_official_status = schoolRes.confirmed_official_status || "CONFIRMED";
        schoolRes.school_cancellation_state = "CANCEL_IN_PROGRESS";
      }
      this.store.syncJobDisplayStatus?.(job);
      // Persist CANCEL_IN_PROGRESS strictly BEFORE external live seat cancel call (crash-safe & fail-closed)
      this._flushStopStateStrict();

      let providerSupportsWriteTracking = false;
      let externalCancelWriteCount = 0;
      let revokedDuringCancelFlow = false;

      const assertCancelStillAuthorized = () => {
        if (!isCancelAuthorizationStillValid()) {
          revokedDuringCancelFlow = true;
          throw new ContractError(
            "CONSENT_WITHDRAWN",
            "退座执行期间学校绑定或授权同意已撤回，已拦截后续学校退座请求"
          );
        }
      };

      let liveCancelResult = null;
      if (typeof this.schoolProvider.cancelLiveSeatBooking === "function") {
        try {
          const decryptedSecret = this._decryptBindingCredential(job, binding, nowMs);
          liveCancelResult = await this.schoolProvider.cancelLiveSeatBooking({
            decryptedSecret,
            binding,
            externalBookingId: exactBookingId,
            expectedStudentNo: expectedCancelSno,
            expectedAuthVersion: cancelStartAuthVer,
            onWriteTrackingReady: () => {
              providerSupportsWriteTracking = true;
            },
            beforeReauth: async () => {
              assertCancelStillAuthorized();
            },
            beforeEachExternalWrite: async () => {
              assertCancelStillAuthorized();
              externalCancelWriteCount += 1;
            }
          });
        } catch (err) {
          const isRevokedErr =
            err?.code === "CONSENT_WITHDRAWN" ||
            revokedDuringCancelFlow ||
            !isCancelAuthorizationStillValid();
          const zeroWritesDispatched =
            providerSupportsWriteTracking && externalCancelWriteCount === 0;
          if (isRevokedErr && zeroWritesDispatched && !hadUnknownCancel) {
            job.user_intent_state = "REVOKED";
            liveCancelResult = {
              cancelled: false,
              outcome: "REVOKED_BEFORE_CANCEL_WRITE_MANUAL_REQUIRED",
              school_cancellation_state: "MANUAL_ACTION_REQUIRED",
              writeDispatched: false,
              bookingId: exactBookingId,
              message:
                "学校鉴权等待期间绑定或授权已撤销，未发出任何学校退座写请求；已保留原预约确认证据，请使用预约号在学校端自行处理"
            };
          } else {
            if (isRevokedErr) {
              job.user_intent_state = "REVOKED";
            }
            liveCancelResult = {
              cancelled: false,
              outcome: "CANCEL_RESULT_UNKNOWN",
              school_cancellation_state: "CANCEL_RESULT_UNKNOWN",
              writeDispatched: !zeroWritesDispatched,
              bookingId: exactBookingId,
              message: isRevokedErr
                ? "学校退座请求发出后授权或绑定被撤销，已拦截后续重试/签退写请求，此前已发出请求的退座结果待核对"
                : err?.message || "学校取消接口调用异常，取消结果待核对"
            };
          }
        }
      }

      if (liveCancelResult?.cancelled) {
        job.school_cancellation_state = "SCHOOL_CANCELLED";
        job.state = "SCHOOL_CANCELLED";
        job.state_version += 1;
        if (schoolRes) {
          schoolRes.confirmed_official_status = schoolRes.confirmed_official_status || "CONFIRMED";
          schoolRes.official_status = "SCHOOL_CANCELLED";
          schoolRes.school_cancellation_state = "SCHOOL_CANCELLED";
        }
      } else if (
        !hadUnknownCancel &&
        liveCancelResult?.school_cancellation_state === "MANUAL_ACTION_REQUIRED"
      ) {
        job.external_execution_state = "SCHOOL_CONFIRMED";
        job.school_cancellation_state = "MANUAL_ACTION_REQUIRED";
        job.state = "DELEGATION_STOPPED_SCHOOL_CONFIRMED";
        job.state_version += 1;
        if (schoolRes) {
          schoolRes.confirmed_official_status = schoolRes.confirmed_official_status || "CONFIRMED";
          schoolRes.official_status = "CONFIRMED";
          schoolRes.school_cancellation_state = "MANUAL_ACTION_REQUIRED";
        }
      } else {
        job.school_cancellation_state = "CANCEL_RESULT_UNKNOWN";
        job.state = "CANCEL_RESULT_UNKNOWN";
        job.state_version += 1;
        this.store._preserveConfirmedEvidenceForUnknownCancel?.(schoolRes, job);
      }

      job._stopPersistencePending = true;
      this.store.syncJobDisplayStatus?.(job);
      this._flushStopStateStrict();
      return {
        job,
        school_reservation: schoolRes || null,
        live_cancel: liveCancelResult
      };
    });
  }

  rolloverMultiDayPlanIfEligible(plan, finishedJob, outcomeSummary, nowMs = Date.now()) {
    if (!plan || !plan.enabled) return null;
    if (plan.user_intent_state && plan.user_intent_state !== "ACTIVE") return null;
    if (
      finishedJob &&
      ((finishedJob.user_intent_state && finishedJob.user_intent_state !== "ACTIVE") ||
        finishedJob.external_execution_state === "RESULT_UNKNOWN" ||
        finishedJob.external_execution_state === "DISPATCH_INTENT")
    ) {
      return null;
    }
    const binding = this.store.schoolBindings.get(plan.school_binding_id);
    const consent = this.store.consents.get(plan.consent_id);
    if (!this._isJobAuthorizationCurrent(finishedJob || plan, plan, binding, consent)) {
      return null;
    }

    const rem = Number(plan.remaining_days ?? finishedJob?.remaining_days ?? 1);
    if (rem <= 1) {
      plan.remaining_days = 0;
      if (finishedJob) finishedJob.remaining_days = 0;
      if (typeof this.store.saveSnapshot === "function") {
        this.store.saveSnapshot();
      }
      return null;
    }

    const baseDate = finishedJob?.booking_local_date || plan.target_local_date;
    const nextDate = addDaysToLocalDate(baseDate, 1);
    const existingNext = Array.from(this.store.reservationJobs.values()).find(
      (j) =>
        j.plan_id === plan.id &&
        j.booking_local_date === nextDate &&
        !["CANCELLED", "REVOKED", "FAILED", "EXPIRED", "SCHOOL_CANCELLED", "SKIPPED_FINANCE", "SKIPPED_AUTH"].includes(j.state)
    );
    if (existingNext) return existingNext;

    const nextRemaining = rem - 1;
    const repeatDays = Number(plan.repeat_days || rem);
    const nextEndDate = addDaysToLocalDate(nextDate, nextRemaining - 1);
    const nextGen = (Number(plan.generation) || 1) + 1;

    plan.remaining_days = nextRemaining;
    plan.repeat_days = repeatDays;
    plan.target_local_date = nextDate;
    plan.end_local_date = nextEndDate;
    plan.generation = nextGen;
    plan.updated_at = new Date(nowMs).toISOString();

    const rules = this.schoolProvider.getRules();
    const nextSchedule = computeTripleSchedule({
      targetLocalDate: nextDate,
      targetLocalTime: plan.target_local_time || "07:00:00",
      rules,
      precheckLeadSeconds: 1800,
      finalCheckLeadSeconds: 300,
      maxLatenessSeconds: plan.max_lateness_seconds || 1800,
      nowMs
    });

    const nextJobId = crypto.randomUUID();
    const nextEvents = [
      {
        id: crypto.randomUUID(),
        job_id: nextJobId,
        plan_id: plan.id,
        kind: "PRECHECK",
        due_at: nextSchedule.precheckAtIso,
        actual_at: nextSchedule.precheckDiagnostic ? new Date(nowMs).toISOString() : null,
        status: nextSchedule.precheckInitialStatus,
        generation: nextGen,
        diagnostic_code: nextSchedule.precheckDiagnostic
      },
      {
        id: crypto.randomUUID(),
        job_id: nextJobId,
        plan_id: plan.id,
        kind: "FINAL_CHECK",
        due_at: nextSchedule.finalCheckAtIso,
        actual_at: nextSchedule.finalCheckDiagnostic ? new Date(nowMs).toISOString() : null,
        status: nextSchedule.finalCheckInitialStatus,
        generation: nextGen,
        diagnostic_code: nextSchedule.finalCheckDiagnostic
      },
      {
        id: crypto.randomUUID(),
        job_id: nextJobId,
        plan_id: plan.id,
        kind: "FIRE",
        due_at: nextSchedule.targetAtIso,
        actual_at: null,
        status: "ARMED",
        generation: nextGen,
        diagnostic_code: null
      }
    ];

    let rolledPrewarmed = null;
    if (finishedJob?.prewarmed_targets && typeof finishedJob.prewarmed_targets === "object") {
      rolledPrewarmed = {
        ...finishedJob.prewarmed_targets,
        target_local_date: nextDate,
        plan_generation: nextGen,
        start_full:
          typeof finishedJob.prewarmed_targets.start_full === "string"
            ? finishedJob.prewarmed_targets.start_full.replace(/^\d{4}-\d{2}-\d{2}/, nextDate)
            : `${nextDate} 08:00:00`,
        end_full:
          typeof finishedJob.prewarmed_targets.end_full === "string"
            ? finishedJob.prewarmed_targets.end_full.replace(/^\d{4}-\d{2}-\d{2}/, nextDate)
            : `${nextDate} 22:00:00`,
        prewarmed_at: new Date(nowMs).toISOString()
      };
    }

    const nextState = nextSchedule.finalCheckDiagnostic
      ? "FINAL_CHECK_OK"
      : nextSchedule.precheckDiagnostic
        ? "PRECHECK_OK"
        : "ARMED";

    const nextJob = {
      id: nextJobId,
      plan_id: plan.id,
      cloud_user_id: plan.cloud_user_id,
      school_binding_id: plan.school_binding_id,
      consent_id: plan.consent_id,
      auth_version: Number(plan.auth_version ?? finishedJob?.auth_version ?? 1),
      school_id: plan.school_id,
      student_no: String(plan.student_no || finishedJob?.student_no || binding?.student_no || "").trim(),
      booking_local_date: nextDate,
      target_local_time: nextSchedule.targetLocalTime,
      repeat_days: repeatDays,
      remaining_days: nextRemaining,
      end_local_date: nextEndDate,
      precheck_at: nextSchedule.precheckAtIso,
      final_check_at: nextSchedule.finalCheckAtIso,
      fire_at: nextSchedule.targetAtIso,
      due_at: nextSchedule.targetAtIso,
      expires_at: nextSchedule.expiresAtIso,
      state: nextState,
      user_intent_state: "ACTIVE",
      external_execution_state: "NOT_DISPATCHED",
      school_cancellation_state: "NOT_REQUESTED",
      billing_state: "NOT_BILLED",
      display_status: nextState,
      status_label: "委托待执行",
      capability: finishedJob?.capability || "AUTHORIZED_AUTOMATION",
      state_version: 1,
      lock_token: 0,
      generation: nextGen,
      attempt_count: 0,
      attempt_started_at: null,
      result_verified_at: null,
      last_error_code: null,
      last_diagnostic_message: `连续抢座已自动续期次日 ${nextDate}（剩余 ${nextRemaining}/${repeatDays} 天 · 上一轮：${outcomeSummary || "已完成"}）`,
      prewarmed_targets: rolledPrewarmed,
      created_at: new Date(nowMs).toISOString()
    };

    if (finishedJob) {
      finishedJob.remaining_days = 0;
      finishedJob.next_job_id = nextJobId;
    }

    this.store.reservationJobs.set(nextJobId, nextJob);
    this.store.indexUserScoped?.("reservationJobs", nextJobId, nextJob.cloud_user_id);
    for (const ev of nextEvents) {
      this.store.scheduleEvents.set(ev.id, ev);
      this.store.indexScheduleEvent?.(ev.id, ev);
    }
    if (typeof this.store.flushSnapshotSync === "function") {
      this.store.flushSnapshotSync();
    } else if (typeof this.store.saveSnapshot === "function") {
      this.store.saveSnapshot();
    }
    return nextJob;
  }

  async finalizeConfirmedBooking(
    job,
    binding,
    verifyRes,
    event,
    nowMs = Date.now(),
    attemptRecord = null
  ) {
    const plan = this.store.reservationPlans.get(job.plan_id);
    const consent = plan ? this.store.consents.get(plan.consent_id) : null;
    const ts = new Date(nowMs).toISOString();

    // If user revoked or stopped right before finalizeConfirmedBooking, preserve booking without charging or rolling over!
    if (
      !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
      (job.user_intent_state && job.user_intent_state !== "ACTIVE")
    ) {
      return this.recordConfirmedBookingAfterRevocation(
        job,
        plan,
        binding,
        verifyRes,
        attemptRecord,
        event,
        nowMs
      );
    }

    const schoolReservation = {
      id: this.store.schoolReservations.get(job.id)?.id || crypto.randomUUID(),
      job_id: job.id,
      school_id: job.school_id,
      external_booking_id: verifyRes.externalBookingId,
      evidence_sha256: verifyRes.evidenceSha256,
      official_status: verifyRes.officialStatus,
      confirmed_official_status: verifyRes.officialStatus,
      confirmed_booking_evidence: {
        external_booking_id: verifyRes.externalBookingId,
        seat_alias: verifyRes.seatAlias || "N4-088",
        region_alias: verifyRes.regionAlias || "北四楼自习区",
        evidence_sha256: verifyRes.evidenceSha256,
        verified_at: ts,
        start_at: job.fire_at,
        end_at: job.expires_at
      },
      user_intent_state: "ACTIVE",
      school_cancellation_state: "NOT_REQUESTED",
      verified_at: ts,
      region_alias: verifyRes.regionAlias || "北四楼自习区",
      seat_alias: verifyRes.seatAlias || "N4-088",
      start_at: job.fire_at,
      end_at: job.expires_at
    };
    this.store.schoolReservations.set(job.id, schoolReservation);

    const attemptId = attemptRecord?.id || job.latest_attempt_id;
    if (attemptId) {
      this.store.updateReservationAttempt?.(attemptId, {
        external_execution_state: "SCHOOL_CONFIRMED",
        user_intent_state_at_completion: "ACTIVE",
        completed_at: ts,
        external_booking_id: verifyRes.externalBookingId,
        candidate_seat_name: schoolReservation.seat_alias,
        candidate_region_name: schoolReservation.region_alias,
        readback_verified: true,
        readback_evidence: {
          external_booking_id: verifyRes.externalBookingId,
          seat_alias: schoolReservation.seat_alias,
          region_alias: schoolReservation.region_alias,
          evidence_sha256: verifyRes.evidenceSha256
        }
      });
    }

    event.status = "CONFIRMED";
    event.actual_at = ts;
    this.casJobState(job.id, job.state_version, "CONFIRMED", {
      user_intent_state: "ACTIVE",
      external_execution_state: "SCHOOL_CONFIRMED",
      school_cancellation_state: "NOT_REQUESTED",
      external_booking_id: verifyRes.externalBookingId,
      confirmed_seat_name: schoolReservation.seat_alias,
      confirmed_region_name: schoolReservation.region_alias,
      result_verified_at: ts,
      last_error_code: null
    });

    // Step 2: Check authorization/intent eligibility right before billing
    if (
      !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
      (job.user_intent_state && job.user_intent_state !== "ACTIVE")
    ) {
      return this.recordConfirmedBookingAfterRevocation(
        job,
        plan,
        binding,
        verifyRes,
        attemptRecord,
        event,
        nowMs
      );
    }

    // Create Order + Outbox Event & execute Post-Confirmation Idempotent Debit Saga
    if (
      !this._isJobAuthorizationCurrent(job, plan, binding, consent) ||
      (job.user_intent_state && job.user_intent_state !== "ACTIVE") ||
      (plan && (!plan.enabled || (plan.user_intent_state && plan.user_intent_state !== "ACTIVE")))
    ) {
      return this.recordConfirmedBookingAfterRevocation(
        job,
        plan,
        binding,
        verifyRes,
        attemptRecord,
        event,
        nowMs
      );
    }
    let order = null;
    try {
      order = await this.financeService.createAndSettleOrderForConfirmedJob({
        job,
        plan,
        nowMs
      });
    } catch {
      const existingOrderId = this.store._idxOrderByJob?.get(job.id);
      order = existingOrderId ? this.store.reservationOrders.get(existingOrderId) || null : null;
    }
    const paymentState = order?.payment_state || "DEBIT_PENDING";
    job.billing_state = paymentState;
    if (attemptId && order?.id) {
      this.store.updateReservationAttempt?.(attemptId, {
        billing_order_id: order.id,
        billing_state: job.billing_state
      });
    }

    // Step 3: Check authorization/intent AND settled/retryable payment eligibility right before multi-day rollover
    let nextJob = null;
    if (paymentState === "PAYMENT_DUE") {
      if (plan) {
        plan.enabled = false;
        plan.remaining_days = 0;
        plan.updated_at = ts;
      }
      if (typeof this.store.saveSnapshot === "function") {
        this.store.saveSnapshot();
      }
    } else if (
      this._isJobAuthorizationCurrent(job, plan, binding, consent) &&
      (!job.user_intent_state || job.user_intent_state === "ACTIVE")
    ) {
      nextJob = this.rolloverMultiDayPlanIfEligible(
        plan,
        job,
        `已约 ${schoolReservation.region_alias} ${schoolReservation.seat_alias}`,
        nowMs
      );
    }

    this.store.addNotification({
      cloudUserId: job.cloud_user_id,
      category: "RESERVATION_CONFIRMED",
      title: "图书馆座位预约已核实成功",
      body: `座位 ${schoolReservation.region_alias} ${schoolReservation.seat_alias} 已通过学校记录核验，请本人按校规到馆刷脸签到。订单状态：${paymentState}${
        nextJob
          ? ` · 已自动续期次日 ${nextJob.booking_local_date} 抢座（剩余 ${nextJob.remaining_days}/${nextJob.repeat_days} 天）`
          : ""
      }`
    });

    return {
      job,
      event,
      schoolReservation,
      order,
      next_job_id: nextJob?.id || null,
      remaining_days: plan?.remaining_days ?? 0
    };
  }
}
