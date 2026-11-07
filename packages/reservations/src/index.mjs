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

    // Conflict check: same user + binding + date active job
    const duplicateActive = Array.from(this.store.reservationJobs.values()).find(
      (j) =>
        j.cloud_user_id === cloudUserId &&
        j.school_binding_id === binding.id &&
        j.booking_local_date === payload.target_local_date &&
        !["CANCELLED", "FAILED", "EXPIRED"].includes(j.state)
    );
    if (duplicateActive) {
      if (payload.replace_existing === true && duplicateActive.state !== "CONFIRMED") {
        duplicateActive.state = "CANCELLED";
        duplicateActive.state_version += 1;
        const oldPlan = this.store.reservationPlans.get(duplicateActive.plan_id);
        if (oldPlan) oldPlan.enabled = false;
      } else {
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
      price_version: payload.accepted_price_version || "price-library-cloud-2026-11-v1",
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
      state: schedule.finalCheckDiagnostic
        ? "FINAL_CHECK_OK"
        : schedule.precheckDiagnostic
          ? "PRECHECK_OK"
          : "ARMED",
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

    this.store.reservationPlans.set(planId, plan);
    this.store.reservationJobs.set(jobId, job);
    for (const ev of events) {
      this.store.scheduleEvents.set(ev.id, ev);
    }
    if (typeof this.store.saveSnapshot === "function") {
      this.store.saveSnapshot();
    }

    // Asynchronously prewarm target region & candidate seat IDs on job creation when live credentials exist
    if (
      binding.credential_ref &&
      typeof this.schoolProvider.prewarmJobTargetSeats === "function"
    ) {
      Promise.resolve()
        .then(async () => {
          const decrypted = this._decryptBindingCredential(job, binding, Date.now());
          const prewarmRes = await this.schoolProvider.prewarmJobTargetSeats({
            job,
            plan,
            binding,
            decryptedSecret: decrypted
          });
          if (prewarmRes?.auth) {
            this._updateBindingCredentialTokens(binding, prewarmRes.auth, decrypted, Date.now());
          }
          if (prewarmRes?.prewarmed) {
            job.prewarmed_targets = prewarmRes.prewarmed;
          }
          if (typeof this.store.saveSnapshot === "function") {
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
    job.state = nextState;
    job.state_version += 1;
    Object.assign(job, patch);
    if (typeof this.store.saveSnapshot === "function") {
      this.store.saveSnapshot();
    }
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

  async runScheduleEvent(jobId, kind, nowMs = Date.now(), options = {}) {
    return this.withJobLock(jobId, async () => {
      const job = this.store.reservationJobs.get(jobId);
      if (!job) throw new ContractError("NOT_FOUND", "Reservation job not found");
      const plan = this.store.reservationPlans.get(job.plan_id);
      const binding = this.store.schoolBindings.get(job.school_binding_id);
      const consent = plan ? this.store.consents.get(plan.consent_id) : null;

      const event = Array.from(this.store.scheduleEvents.values()).find(
        (e) => e.job_id === jobId && e.kind === kind && e.generation === job.generation
      );
      if (!event) {
        throw new ContractError("NOT_FOUND", `Schedule event ${kind} not found for job ${jobId}`);
      }
      if (["CONFIRMED", "FAILED", "CANCELLED", "REVOKED"].includes(job.state)) {
        if (event.status === "ARMED") {
          event.status = "SKIPPED_TERMINAL";
        }
        const schoolReservation = this.store.schoolReservations.get(job.id) || null;
        return { job, event, schoolReservation };
      }

      // Revocation check before any stage
      if (!plan?.enabled || !binding || binding.revoked_at || !consent || consent.withdrawn_at) {
        event.status = "ABORTED_REVOKED";
        event.actual_at = new Date(nowMs).toISOString();
        this.casJobState(jobId, job.state_version, "CANCELLED", { last_error_code: "CONSENT_WITHDRAWN" });
        return { job, event };
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
              last_error_code: "WALLET_INSUFFICIENT"
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
              last_error_code: decErr?.code || "SCHOOL_AUTH_EXPIRED"
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
                if (prewarmRes?.auth) {
                  this._updateBindingCredentialTokens(binding, prewarmRes.auth, decrypted, nowMs);
                }
                if (prewarmRes?.prewarmed) {
                  job.prewarmed_targets = prewarmRes.prewarmed;
                }
              } else {
                const authRes = await this.schoolProvider.authenticateHautSession(bundle, binding);
                this._updateBindingCredentialTokens(binding, authRes, decrypted, nowMs);
              }
            } catch {
              // Will retry at FINAL_CHECK
            }
          }
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
            last_error_code: "SCHOOL_AUTH_EXPIRED"
          });
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
              last_error_code: decErr?.code || "SCHOOL_AUTH_EXPIRED"
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
                if (prewarmRes?.auth) {
                  this._updateBindingCredentialTokens(binding, prewarmRes.auth, decrypted, nowMs);
                }
                if (prewarmRes?.prewarmed) {
                  job.prewarmed_targets = prewarmRes.prewarmed;
                }
              } else {
                const authRes = await this.schoolProvider.authenticateHautSession(bundle, binding);
                this._updateBindingCredentialTokens(binding, authRes, decrypted, nowMs);
              }
            } catch (err) {
              event.diagnostic_code = err?.code || "FINAL_CHECK_AUTH_WARN";
            }
          }
        }
        event.status = "FINAL_CHECK_OK";
        event.actual_at = new Date(nowMs).toISOString();
        event.diagnostic_code = event.diagnostic_code || "READ_ONLY_FINAL_CHECK_PASSED";
        this.casJobState(jobId, job.state_version, "FINAL_CHECK_OK");
        return { job, event };
      }

      if (kind === "FIRE") {
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

        // Existing armed/ambiguous jobs must not bypass containment through scheduler
        // execution or adopt an unrelated live readback and settle it as a new booking.
        if (!this.schoolProvider.mockBackend && this.schoolProvider.parseCredentialBundle(decryptedSecret, binding).isLiveCredential) {
          event.status = "FIRE_NEEDS_USER";
          event.diagnostic_code = "SCHOOL_PERMISSION_REQUIRED";
          event.actual_at = new Date(nowMs).toISOString();
          if (job.state !== "RESULT_UNKNOWN") this.casJobState(jobId, job.state_version, "SKIPPED_AUTH", {last_error_code: "SCHOOL_PERMISSION_REQUIRED"});
          this.store.saveSnapshot?.();
          return {job, event};
        }

        // Never blind-retry if already submitted or RESULT_UNKNOWN
        if (job.state === "RESULT_UNKNOWN" || job.attempt_count >= 1) {
          try {
            const readback = await this.schoolProvider.verifyBookingAuthoritative({
              job,
              binding,
              decryptedSecret,
              expectedExternalBookingId: job.pending_external_booking_id
            });
            if (readback.verified) {
              return this.finalizeConfirmedBooking(job, binding, readback, event, nowMs);
            }
          } catch {
            // Keep RESULT_UNKNOWN on transient verification failure
          }
          return { job, event };
        }

        // Check window & expiration (ensure at least 30m grace window after fire_at even on legacy jobs where expires_at === fire_at)
        const fireAtMs = new Date(job.fire_at).getTime();
        const rawExpiresAtMs = new Date(job.expires_at).getTime();
        const effectiveExpiresAtMs = Math.max(rawExpiresAtMs, fireAtMs + 1800 * 1000);
        if (nowMs < fireAtMs) {
          throw new ContractError("BOOKING_WINDOW_CLOSED", "Cannot execute FIRE before target time T");
        }
        if (nowMs > effectiveExpiresAtMs) {
          event.status = "MISSED_WINDOW";
          event.actual_at = new Date(nowMs).toISOString();
          this.casJobState(jobId, job.state_version, "EXPIRED", { last_error_code: "MISSED_WINDOW" });
          this.rolloverMultiDayPlanIfEligible(plan, job, "错过开抢窗口", nowMs);
          return { job, event };
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
            allowDateFallbackToToday: Boolean(options.allowDateFallbackToToday)
          });
        } catch (err) {
          submitRes = {
            outcome: "FAILED",
            errorCode: err?.code || "SCHOOL_EXECUTION_ERROR",
            diagnosticMessage: err?.message || "学校选座接口请求异常"
          };
        }

        if (submitRes.rawToken) {
          this._updateBindingCredentialTokens(
            binding,
            { rawToken: submitRes.rawToken },
            decryptedSecret,
            nowMs
          );
        }

        if (submitRes.outcome === "TIMEOUT_AMBIGUOUS") {
          job.pending_external_booking_id = submitRes.externalBookingId || null;
          event.status = "RESULT_UNKNOWN";
          event.actual_at = new Date(nowMs).toISOString();
          this.casJobState(jobId, job.state_version, "RESULT_UNKNOWN", {
            last_error_code: "BOOKING_RESULT_UNKNOWN"
          });
          return { job, event };
        }

        if (submitRes.outcome === "FAILED") {
          event.status = "FAILED";
          event.actual_at = new Date(nowMs).toISOString();
          this.casJobState(jobId, job.state_version, "FAILED", {
            last_error_code: submitRes.errorCode || "SCHOOL_REJECTED",
            last_diagnostic_message: submitRes.diagnosticMessage || null
          });
          this.rolloverMultiDayPlanIfEligible(plan, job, submitRes.diagnosticMessage || "当日未抢到", nowMs);
          return { job, event };
        }

        // Authoritative readback verification (HTTP 200 alone is never sufficient!)
        let verifyRes = { verified: false };
        try {
          verifyRes = await this.schoolProvider.verifyBookingAuthoritative({
            job,
            binding,
            decryptedSecret,
            rawToken: submitRes.rawToken || null,
            expectedExternalBookingId: submitRes.externalBookingId
          });
        } catch {
          verifyRes = { verified: false };
        }
        if (!verifyRes.verified) {
          job.pending_external_booking_id = submitRes.externalBookingId;
          event.status = "RESULT_UNKNOWN";
          event.actual_at = new Date(nowMs).toISOString();
          this.casJobState(jobId, job.state_version, "RESULT_UNKNOWN", {
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
          nowMs
        );
      }

      throw new ContractError("BAD_REQUEST", `Unknown schedule event kind: ${kind}`);
    });
  }

  async cancelConfirmedOrActiveJob(jobId, nowMs = Date.now()) {
    const job = this.store.reservationJobs.get(jobId);
    if (!job) throw new ContractError("NOT_FOUND", "Reservation job not found");
    const binding = this.store.schoolBindings.get(job.school_binding_id);
    const schoolRes = this.store.schoolReservations.get(job.id);
    let liveCancelResult = null;

    if (
      binding &&
      typeof this.schoolProvider.cancelLiveSeatBooking === "function" &&
      (job.state === "CONFIRMED" || schoolRes?.external_booking_id)
    ) {
      const decryptedSecret = this._decryptBindingCredential(job, binding, nowMs);
      const bundle = this.schoolProvider.parseCredentialBundle(decryptedSecret, binding);
      if (bundle.isLiveCredential) {
        liveCancelResult = await this.schoolProvider.cancelLiveSeatBooking({
          decryptedSecret,
          binding,
          externalBookingId: schoolRes?.external_booking_id
        });
      }
    }

    job.state = "CANCELLED";
    job.state_version += 1;
    if (schoolRes) {
      schoolRes.official_status = "CANCELLED";
    }
    const plan = this.store.reservationPlans.get(job.plan_id);
    if (plan) {
      plan.enabled = false;
    }
    if (typeof this.store.saveSnapshot === "function") {
      this.store.saveSnapshot();
    }
    return {
      job,
      school_reservation: schoolRes || null,
      live_cancel: liveCancelResult
    };
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
      state: nextSchedule.finalCheckDiagnostic
        ? "FINAL_CHECK_OK"
        : nextSchedule.precheckDiagnostic
          ? "PRECHECK_OK"
          : "ARMED",
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
      start_at: job.fire_at,
      end_at: job.expires_at
    };
    this.store.schoolReservations.set(job.id, schoolReservation);

    event.status = "CONFIRMED";
    event.actual_at = new Date(nowMs).toISOString();
    this.casJobState(job.id, job.state_version, "CONFIRMED", {
      result_verified_at: new Date(nowMs).toISOString(),
      last_error_code: null
    });

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
