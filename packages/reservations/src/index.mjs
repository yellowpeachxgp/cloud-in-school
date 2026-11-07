import crypto from "node:crypto";
import { ContractError, getReservationPriceVersion } from "../../contracts/src/index.mjs";

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
  const targetAtMs = Date.parse(`${targetLocalDate}T${normalizedTime}+08:00`);
  if (!Number.isFinite(targetAtMs) || new Date(`${targetLocalDate}T00:00:00Z`).toISOString().slice(0, 10) !== targetLocalDate) {
    throw new ContractError("BAD_REQUEST", "target_local_date must be a valid calendar date");
  }
  const windowEndMs = Date.parse(`${targetLocalDate}T${rules.window_end_exclusive}+08:00`);
  if (!Number.isSafeInteger(maxLatenessSeconds) || maxLatenessSeconds < 1 || maxLatenessSeconds > (rules.max_lateness_seconds_limit || 1800)) {
    throw new ContractError("BAD_REQUEST", "max_lateness_seconds must be an integer from 1 to the school limit");
  }
  const clampedLatenessMs = maxLatenessSeconds * 1000;
  let expiresAtMs = Math.min(targetAtMs + clampedLatenessMs, windowEndMs);

  if (nowMs >= expiresAtMs) {
    throw new ContractError("BOOKING_WINDOW_CLOSED", "Target time T has passed its accepted execution window");
  }

  const precheckAtMs = targetAtMs - precheckLeadSeconds * 1000;
  const finalCheckAtMs = targetAtMs - finalCheckLeadSeconds * 1000;
  const diffMs = targetAtMs - nowMs;

  let precheckInitialStatus = "ARMED";
  let finalCheckInitialStatus = "ARMED";
  let precheckDiagnostic = null;
  let finalCheckDiagnostic = null;

  if (diffMs < 30 * 60 * 1000 && diffMs > 5 * 60 * 1000) {
    precheckInitialStatus = "ARMED";
    precheckDiagnostic = "IMMEDIATE_CATCHUP_PRECHECK";
  } else if (diffMs <= 5 * 60 * 1000) {
    precheckInitialStatus = "ARMED";
    finalCheckInitialStatus = "ARMED";
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
    if (!consent || consent.cloud_user_id !== cloudUserId || consent.school_id !== binding.school_id || consent.withdrawn_at || !["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"].every((scope) => Array.isArray(consent.scope_list) && consent.scope_list.includes(scope))) {
      throw new ContractError("CONSENT_WITHDRAWN", "Active consent record is required");
    }

    const acceptedPrice = this.store.pricingMicropeach;
    const priceVersion = getReservationPriceVersion(acceptedPrice);
    if (payload.accepted_price_version !== priceVersion || payload.accepted_price_micropeach !== acceptedPrice) {
      throw new ContractError("CONFLICT", "Accept the current reservation price and version before creating a plan");
    }

    // Conflict check: same user + binding + date active job
    const duplicateActive = Array.from(this.store.reservationJobs.values()).find(
      (j) =>
        j.cloud_user_id === cloudUserId &&
        j.school_binding_id === binding.id &&
        j.booking_local_date === payload.target_local_date &&
        !["CANCELLED", "FAILED", "EXPIRED"].includes(j.state)
    );
    if (duplicateActive) {
      if (payload.replace_existing === true && !this.inFlightJobs.has(duplicateActive.id) && !["CONFIRMED", "EXECUTING", "RESULT_UNKNOWN"].includes(duplicateActive.state) && !duplicateActive.attempt_count) {
        // Validate the complete replacement before retiring the existing plan.
      } else {
        throw new ContractError(
          "CONFLICT",
          `An active reservation plan/job already exists for ${payload.target_local_date}`
        );
      }
    }

    const rules = this.schoolProvider.getRules();
    const defaultLatenessSec = rules.max_lateness_seconds_limit || 1800;
    const requestedLatenessSec = payload.max_lateness_seconds ?? defaultLatenessSec;
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
      schoolIntegration,
      { allowMock: Boolean(this.schoolProvider.mockBackend) || !this.schoolProvider.isLiveAuthorized(schoolIntegration) }
    );

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

    const plan = {
      id: planId,
      cloud_user_id: cloudUserId,
      school_binding_id: binding.id,
      school_id: binding.school_id,
      consent_id: consent.id,
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
      price_version: priceVersion,
      price_micropeach: acceptedPrice,
      price_accepted_at: new Date(nowMs).toISOString(),
      area_code: payload.area_code || (payload.preferred_area_ids && payload.preferred_area_ids[0]) || "4F_NORTH",
      area_name: payload.area_name || "4楼北自习区",
      candidate_seats: payload.candidate_seats || payload.preferred_seat_ids || ["4N-001"],
      slot_window: payload.slot_window || "08:00-22:00",
      preferences_json: {
        preferred_area_ids: payload.preferred_area_ids || (payload.area_code ? [payload.area_code] : ["area-haut-north-4f"]),
        preferred_seat_ids: payload.preferred_seat_ids || payload.candidate_seats || ["N4-088"],
        allow_alternative_seat: payload.allow_alternative_seat !== false
      },
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
        actual_at: null,
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
        actual_at: null,
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
      school_id: binding.school_id,
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
      state: "ARMED",
      capability: executionPath,
      state_version: 1,
      lock_token: 0,
      generation,
      attempt_count: 0,
      attempt_started_at: null,
      result_verified_at: null,
      last_error_code: null,
      created_at: new Date(nowMs).toISOString()
    };

    if (duplicateActive) {
      duplicateActive.state = "CANCELLED";
      duplicateActive.state_version += 1;
      const oldPlan = this.store.reservationPlans.get(duplicateActive.plan_id);
      if (oldPlan) oldPlan.enabled = false;
    }
    this.store.reservationPlans.set(planId, plan);
    this.store.reservationJobs.set(jobId, job);
    for (const ev of events) {
      this.store.scheduleEvents.set(ev.id, ev);
    }

    this.store.saveSnapshot?.();

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
    job.state = nextState;
    job.state_version += 1;
    Object.assign(job, patch);
    return true;
  }

  _decryptBindingCredential(job, binding, nowMs = Date.now()) {
    if (!binding?.credential_ref) return null;
    const credRecord = this.store.encryptedCredentials.get(binding.credential_ref);
    if (!credRecord || credRecord.revoked_at) return null;
    const permit = this.kmsVault.issueAccessPermit({
      taskId: job.id,
      schoolId: job.school_id,
      bindingId: binding.id,
      credentialRef: binding.credential_ref,
      ttlSeconds: 15,
      nowMs
    });
    return this.kmsVault.decryptSecretWithPermit(credRecord, permit, nowMs);
  }

  _updateBindingCredentialTokens(binding, authResult, oldSecret, nowMs = Date.now()) {
    if (!binding || !authResult?.rawToken) return;
    try {
      const parsed = oldSecret && String(oldSecret).trim().startsWith("{") ? JSON.parse(oldSecret) : {};
      const nextPayload = JSON.stringify({
        ...parsed,
        raw_token: authResult.rawToken,
        cas_tgc: authResult.casTgc || parsed.cas_tgc || "",
        cas_jsessionid: authResult.casJsessionId || parsed.cas_jsessionid || "",
        student_no: authResult.userInfo?.userNo || parsed.student_no || binding.student_no || "",
        user_name: authResult.userInfo?.userName || parsed.user_name || ""
      });
      const encrypted = this.kmsVault.encryptSecret({
        bindingId: binding.id,
        schoolId: binding.school_id,
        credentialKind: "DELEGATED_SESSION_BUNDLE",
        plaintext: nextPayload,
        expiresAt: new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString()
      });
      this.store.encryptedCredentials.set(encrypted.id, encrypted);
      binding.credential_ref = encrypted.id;
      binding.credential_expires_at = encrypted.expires_at;
    } catch {
      // Keep existing credential on non-fatal refresh update error
    }
  }

  _requireActiveConsent(job, plan, binding, consent, { allowDisabledPlan = false } = {}) {
    if (!plan || (!plan.enabled && !allowDisabledPlan) || !binding || binding.revoked_at || binding.status !== "DELEGATED_ACTIVE" ||
        binding.cloud_user_id !== job.cloud_user_id || binding.school_id !== job.school_id ||
        !consent || consent.withdrawn_at || consent.cloud_user_id !== job.cloud_user_id ||
        consent.school_id !== job.school_id ||
        !["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"].every((scope) =>
          Array.isArray(consent.scope_list) && consent.scope_list.includes(scope))) {
      throw new ContractError("CONSENT_WITHDRAWN", "Active same-school reservation and credential consent is required");
    }
  }

  _assertLivePolicy(job) {
    if (job.capability !== "AUTHORIZED_AUTOMATION") return;
    const integration = this.store.schoolIntegrations.get(job.school_id);
    this.schoolProvider.assertOperationAllowed("CREATE_BOOKING", integration, { requireLiveAutomation: true });
    if (typeof this.store.getUserRoles === "function") {
      for (const actor of [integration.approver_primary_ref, integration.approver_secondary_ref]) {
        if (!["PLATFORM_OWNER", "SCHOOL_OPERATOR"].some((role) => this.store.getUserRoles(actor).includes(role))) {
          throw new ContractError("SCHOOL_PERMISSION_REQUIRED", "School authorization approver no longer has an eligible role");
        }
      }
    }
  }

  _persistJob(job) {
    const required = job.capability === "AUTHORIZED_AUTOMATION";
    if (typeof this.store.saveSnapshot !== "function" || this.store.saveSnapshot({ required }) !== true) {
      if (required) throw new ContractError("CONFLICT", "Live booking requires durable execution state");
    }
  }

  _assertFireWindow(job, nowMs) {
    const fireAtMs = Date.parse(job.fire_at);
    const expiresAtMs = Date.parse(job.expires_at);
    if (!Number.isFinite(fireAtMs) || !Number.isFinite(expiresAtMs) || nowMs < fireAtMs || nowMs >= expiresAtMs) {
      throw new ContractError("BOOKING_WINDOW_CLOSED", "Outside the accepted target and expiry window");
    }
  }

  async _qualityCheck(job, plan, binding, nowMs) {
    this._assertLivePolicy(job);
    if (!Number.isSafeInteger(plan.price_micropeach) || plan.price_micropeach < 0 ||
        plan.price_version !== getReservationPriceVersion(plan.price_micropeach) || !plan.price_accepted_at) {
      throw new ContractError("CONFLICT", "The plan requires a valid accepted price snapshot before booking");
    }
    const wallet = await this.financeService.getWalletSnapshot(job.cloud_user_id);
    if (!Number.isSafeInteger(wallet?.micropeach_balance) || wallet.micropeach_balance < plan.price_micropeach) {
      throw new ContractError("WALLET_INSUFFICIENT", "Wallet cannot cover the accepted reservation price");
    }
    if (job.capability !== "AUTHORIZED_AUTOMATION") return null;
    if (binding.credential_expires_at && Date.parse(binding.credential_expires_at) <= nowMs) {
      throw new ContractError("SCHOOL_AUTH_EXPIRED", "Delegated credentials have expired");
    }
    const decrypted = this._decryptBindingCredential(job, binding, nowMs);
    if (!this.schoolProvider.parseCredentialBundle(decrypted, binding).isLiveCredential) {
      throw new ContractError("SCHOOL_AUTH_EXPIRED", "A live job requires active delegated credentials");
    }
    return decrypted;
  }

  async runScheduleEvent(jobId, kind, nowMs = Date.now(), options = {}) {
    return this.withJobLock(jobId, async () => {
      const startedAt = Date.now();
      const executionNow = () => nowMs + (Date.now() - startedAt);
      const job = this.store.reservationJobs.get(jobId);
      if (!job) throw new ContractError("NOT_FOUND", "Reservation job not found");
      const plan = this.store.reservationPlans.get(job.plan_id);
      const binding = this.store.schoolBindings.get(job.school_binding_id);
      const consent = plan ? this.store.consents.get(plan.consent_id) : null;
      const event = Array.from(this.store.scheduleEvents.values()).find(
        (e) => e.job_id === jobId && e.kind === kind && e.generation === job.generation
      );
      if (!event) throw new ContractError("NOT_FOUND", `Schedule event ${kind} not found`);
      if (["CONFIRMED", "FAILED", "CANCELLED", "REVOKED", "EXPIRED"].includes(job.state)) {
        if (event.status === "ARMED") event.status = "SKIPPED_TERMINAL";
        return {
          job,
          event,
          schoolReservation: this.store.schoolReservations.get(job.id) || null,
          order: Array.from(this.store.reservationOrders.values()).find((order) => order.job_id === job.id) || null
        };
      }
      try {
        this._requireActiveConsent(job, plan, binding, consent, { allowDisabledPlan: job.attempt_count >= 1 });
        this._assertLivePolicy(job);
      } catch (err) {
        event.status = "ABORTED_REVOKED";
        event.actual_at = new Date(nowMs).toISOString();
        event.diagnostic_code = err.code;
        this.casJobState(job.id, job.state_version, job.attempt_count ? "RESULT_UNKNOWN" : "CANCELLED", { last_error_code: err.code });
        this._persistJob(job);
        return { job, event };
      }

      // Once an intent is recorded, only readback may run, including after a crash in EXECUTING.
      if (job.attempt_count >= 1 || job.state === "RESULT_UNKNOWN" || job.state === "EXECUTING") {
        if (kind !== "FIRE") return { job, event };
        try {
          const decryptedSecret = job.capability === "AUTHORIZED_AUTOMATION" ? this._decryptBindingCredential(job, binding, nowMs) : null;
          const readback = await this.schoolProvider.verifyBookingAuthoritative({ job, binding, decryptedSecret,
            schoolIntegration: this.store.schoolIntegrations.get(job.school_id),
            expectedExternalBookingId: job.pending_external_booking_id });
          if (readback.verified) return this.finalizeConfirmedBooking(job, binding, readback, event, nowMs);
        } catch { /* Uncertain outcomes stay uncertain; never submit a second time. */ }
        event.status = "RESULT_UNKNOWN";
        this.casJobState(job.id, job.state_version, "RESULT_UNKNOWN", { last_error_code: "BOOKING_RESULT_UNKNOWN" });
        this._persistJob(job);
        return { job, event };
      }

      if (!["PRECHECK", "FINAL_CHECK", "FIRE"].includes(kind)) throw new ContractError("BAD_REQUEST", "Unknown schedule event kind");
      if (nowMs < Date.parse(event.due_at)) throw new ContractError("BOOKING_WINDOW_CLOSED", "Schedule stage is not due");
      if (kind === "FIRE") {
        try { this._assertFireWindow(job, nowMs); } catch (err) {
          if (nowMs < Date.parse(job.fire_at)) throw err;
          event.status = "MISSED_WINDOW";
          this.casJobState(job.id, job.state_version, "EXPIRED", { last_error_code: "MISSED_WINDOW" });
          this._persistJob(job);
          return { job, event };
        }
        const completedStages = ["PRECHECK", "FINAL_CHECK"].every((stage) => Array.from(this.store.scheduleEvents.values()).some(
          (e) => e.job_id === job.id && e.generation === job.generation && e.kind === stage && e.status === `${stage}_OK`
        ));
        if (!completedStages) {
          event.diagnostic_code = "PRECHECK_REQUIRED";
          return { job, event };
        }
      }

      let decryptedSecret = null;
      try {
        decryptedSecret = await this._qualityCheck(job, plan, binding, nowMs);
        if (kind !== "FIRE" && job.capability === "AUTHORIZED_AUTOMATION") {
          const prewarm = await this.schoolProvider.prewarmJobTargetSeats({ job, plan, binding, decryptedSecret });
          if (prewarm?.auth) this._updateBindingCredentialTokens(binding, prewarm.auth, decryptedSecret, nowMs);
          if (prewarm?.prewarmed) job.prewarmed_targets = prewarm.prewarmed;
        }
      } catch (err) {
        event.status = `${kind}_NEEDS_USER`;
        event.actual_at = new Date(nowMs).toISOString();
        event.diagnostic_code = err?.code || "QUALITY_CHECK_FAILED";
        this.casJobState(job.id, job.state_version, err?.code === "WALLET_INSUFFICIENT" ? "SKIPPED_FINANCE" : "SKIPPED_AUTH", { last_error_code: event.diagnostic_code });
        this._persistJob(job);
        return { job, event };
      }
      if (kind !== "FIRE") {
        event.status = `${kind}_OK`;
        event.actual_at = new Date(nowMs).toISOString();
        event.diagnostic_code = "READ_ONLY_CHECK_PASSED";
        this.casJobState(job.id, job.state_version, `${kind}_OK`, { last_error_code: null });
        this._persistJob(job);
        return { job, event };
      }

      this._assertFireWindow(job, executionNow());
      this._requireActiveConsent(job, plan, binding, consent);
      this._assertLivePolicy(job);
      this.casJobState(job.id, job.state_version, "EXECUTING", {
        lock_token: job.lock_token + 1, attempt_count: 1, attempt_started_at: new Date(nowMs).toISOString()
      });
      // Durable intent must succeed before entering the provider or sending any write.
      this._persistJob(job);
      let submitRes;
      try {
        submitRes = await this.schoolProvider.executeMockOrAuthorizedCreate({
          job, plan, binding, schoolIntegration: this.store.schoolIntegrations.get(job.school_id),
          decryptedSecret, nowInstant: new Date(executionNow()),
          beforeCreate: async (target) => {
            this._requireActiveConsent(job, plan, binding, this.store.consents.get(plan.consent_id));
            this._assertLivePolicy(job);
            this._assertFireWindow(job, executionNow());
            job.submission_target = target;
            this._persistJob(job);
          }
        });
      } catch (err) {
        submitRes = { outcome: job.submission_target ? "TIMEOUT_AMBIGUOUS" : "FAILED", errorCode: err?.code || "SCHOOL_EXECUTION_ERROR" };
      }
      if (submitRes.rawToken) this._updateBindingCredentialTokens(binding, { rawToken: submitRes.rawToken }, decryptedSecret, nowMs);
      if (submitRes.outcome === "FAILED") {
        event.status = "FAILED";
        event.actual_at = new Date(nowMs).toISOString();
        this.casJobState(job.id, job.state_version, "FAILED", { last_error_code: submitRes.errorCode || "SCHOOL_REJECTED", last_diagnostic_message: submitRes.diagnosticMessage || null });
        this._persistJob(job);
        this.rolloverMultiDayPlanIfEligible(plan, job, submitRes.diagnosticMessage || "当日未抢到", nowMs);
        return { job, event };
      }
      job.pending_external_booking_id = submitRes.externalBookingId || null;
      event.status = "RESULT_UNKNOWN";
      event.actual_at = new Date(nowMs).toISOString();
      this.casJobState(job.id, job.state_version, "RESULT_UNKNOWN", { last_error_code: "BOOKING_RESULT_UNKNOWN" });
      this._persistJob(job);
      if (submitRes.outcome === "TIMEOUT_AMBIGUOUS") return { job, event };
      try {
        const verified = await this.schoolProvider.verifyBookingAuthoritative({ job, binding, decryptedSecret,
          schoolIntegration: this.store.schoolIntegrations.get(job.school_id), rawToken: submitRes.rawToken,
          expectedExternalBookingId: job.pending_external_booking_id });
        if (verified.verified) return this.finalizeConfirmedBooking(job, binding, verified, event, nowMs);
      } catch { /* Readback uncertainty must never be converted to failure or retry. */ }
      return { job, event };
    });
  }

  async cancelConfirmedOrActiveJob(jobId, nowMs = Date.now()) {
    return this.withJobLock(jobId, async () => {
      const job = this.store.reservationJobs.get(jobId);
      if (!job) throw new ContractError("NOT_FOUND", "Reservation job not found");
      const binding = this.store.schoolBindings.get(job.school_binding_id);
      const schoolRes = this.store.schoolReservations.get(job.id);
      const plan = this.store.reservationPlans.get(job.plan_id);
      // Stop future work immediately, but do not invent cancellation of an uncertain/confirmed remote booking.
      if (plan) plan.enabled = false;
      this._persistJob(job);
      if ((job.attempt_count || job.state === "EXECUTING" || job.state === "RESULT_UNKNOWN") && !schoolRes) {
        return { job, school_reservation: null, live_cancel: { cancelled: false, message: "Resolve the pending school result before cancelling the booking" } };
      }
      let liveCancelResult = null;
      if (schoolRes && job.capability === "AUTHORIZED_AUTOMATION") {
        try {
          liveCancelResult = await this.schoolProvider.cancelLiveSeatBooking({
            decryptedSecret: this._decryptBindingCredential(job, binding, nowMs), binding,
            schoolIntegration: this.store.schoolIntegrations.get(job.school_id), externalBookingId: schoolRes.external_booking_id,
            beforeCancel: async () => {
              const currentBinding = this.store.schoolBindings.get(job.school_binding_id);
              if (!currentBinding || currentBinding.revoked_at || currentBinding.status !== "DELEGATED_ACTIVE" ||
                  currentBinding.school_id !== job.school_id || currentBinding.cloud_user_id !== job.cloud_user_id) {
                throw new ContractError("CONSENT_WITHDRAWN", "Cancellation credential authorization was revoked");
              }
              this._requireActiveConsent(job, plan, currentBinding, this.store.consents.get(plan?.consent_id), { allowDisabledPlan: true });
              this._assertLivePolicy(job);
              this._persistJob(job);
            }
          });
        } catch (err) {
          liveCancelResult = { cancelled: false, message: err?.message || "School cancellation failed" };
        }
        if (liveCancelResult?.cancelled !== true) return { job, school_reservation: schoolRes, live_cancel: liveCancelResult };
      }
      this.casJobState(job.id, job.state_version, "CANCELLED");
      if (schoolRes) schoolRes.official_status = "CANCELLED";
      for (const event of this.store.scheduleEvents.values()) {
        if (event.job_id === job.id && event.status === "ARMED") event.status = "CANCELLED";
      }
      this._persistJob(job);
      return { job, school_reservation: schoolRes || null, live_cancel: liveCancelResult };
    });
  }

  rolloverMultiDayPlanIfEligible(plan, finishedJob, outcomeSummary, nowMs = Date.now()) {
    if (!plan || !plan.enabled) return null;
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
        !["CANCELLED", "FAILED", "EXPIRED"].includes(j.state)
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
        actual_at: null,
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
        actual_at: null,
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

    const nextJob = {
      id: nextJobId,
      plan_id: plan.id,
      cloud_user_id: plan.cloud_user_id,
      school_binding_id: plan.school_binding_id,
      school_id: plan.school_id,
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
      state: "ARMED",
      capability: finishedJob?.capability || "MOCK_ONLY",
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
    for (const ev of nextEvents) {
      this.store.scheduleEvents.set(ev.id, ev);
    }
    if (typeof this.store.saveSnapshot === "function") {
      this.store.saveSnapshot();
    }
    return nextJob;
  }

  async finalizeConfirmedBooking(job, binding, verifyRes, event, nowMs = Date.now()) {
    const plan = this.store.reservationPlans.get(job.plan_id);
    const schoolReservation = {
      id: crypto.randomUUID(),
      job_id: job.id,
      school_id: job.school_id,
      external_booking_id: verifyRes.externalBookingId,
      evidence_sha256: verifyRes.evidenceSha256,
      official_status: verifyRes.officialStatus,
      verified_at: new Date(nowMs).toISOString(),
      region_alias: verifyRes.regionAlias || "北四楼自习区",
      seat_alias: verifyRes.seatAlias || "N4-088",
      start_at: verifyRes.startAt || job.submission_target?.start_full || job.fire_at,
      end_at: verifyRes.endAt || job.submission_target?.end_full || job.expires_at
    };
    this.store.schoolReservations.set(job.id, schoolReservation);

    event.status = "CONFIRMED";
    event.actual_at = new Date(nowMs).toISOString();
    this.casJobState(job.id, job.state_version, "CONFIRMED", {
      result_verified_at: new Date(nowMs).toISOString(),
      last_error_code: null
    });

    this._persistJob(job);

    // Create Order + Outbox Event & execute Post-Confirmation Idempotent Debit Saga
    const order = await this.financeService.createAndSettleOrderForConfirmedJob({
      job,
      plan,
      nowMs
    });

    const nextJob = this.rolloverMultiDayPlanIfEligible(
      plan,
      job,
      `已约 ${schoolReservation.region_alias} ${schoolReservation.seat_alias}`,
      nowMs
    );

    this.store.addNotification({
      cloudUserId: job.cloud_user_id,
      category: "RESERVATION_CONFIRMED",
      title: "图书馆座位预约已核实成功",
      body: `座位 ${schoolReservation.region_alias} ${schoolReservation.seat_alias} 已通过学校记录核验，请本人按校规到馆刷脸签到。订单状态：${order.payment_state}${
        nextJob ? ` · 已自动续期次日 ${nextJob.booking_local_date} 抢座（剩余 ${nextJob.remaining_days}/${nextJob.repeat_days} 天）` : ""
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
