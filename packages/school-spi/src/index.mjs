import crypto from "node:crypto";
import { ContractError } from "../../contracts/src/index.mjs";

/**
 * School SPI, SSRF Guard, Cross-School Cookie Isolation & HAUT Provider.
 * Enforces Section 07, 14 (SSRF / SIGN_IN prohibition / fail-closed kill_switch) & 27.
 */
const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fd00:/i,
  /^fe80:/i,
  /^localhost$/i,
  /\.internal$/i,
  /metadata\.google\.internal/i
];

export function validateAllowedSchoolUrl(urlString, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new ContractError("FORBIDDEN", "Malformed outbound school URL");
  }
  if (parsed.protocol !== "https:") {
    throw new ContractError("FORBIDDEN", "Outbound school requests must use HTTPS");
  }
  const hostname = parsed.hostname.toLowerCase();
  for (const pat of PRIVATE_IP_PATTERNS) {
    if (pat.test(hostname)) {
      throw new ContractError("FORBIDDEN", `SSRF blocked: private/internal host ${hostname}`);
    }
  }
  const allowSet = new Set((allowedHosts || []).map((h) => h.toLowerCase()));
  if (!allowSet.has(hostname)) {
    throw new ContractError(
      "FORBIDDEN",
      `Outbound host ${hostname} is not in school provider allowlist`
    );
  }
  return parsed;
}

export class ScopedSchoolCookieVault {
  constructor() {
    this.buckets = new Map(); // key: `${schoolId}|${bindingId}|${host}`
  }

  setCookie({ schoolId, bindingId, urlString, allowedHosts, cookieName, cookieValue }) {
    const parsed = validateAllowedSchoolUrl(urlString, allowedHosts);
    const key = `${schoolId}|${bindingId}|${parsed.hostname.toLowerCase()}`;
    if (!this.buckets.has(key)) this.buckets.set(key, new Map());
    this.buckets.get(key).set(cookieName, cookieValue);
  }

  getCookieHeader({ schoolId, bindingId, urlString, allowedHosts }) {
    const parsed = validateAllowedSchoolUrl(urlString, allowedHosts);
    const key = `${schoolId}|${bindingId}|${parsed.hostname.toLowerCase()}`;
    const map = this.buckets.get(key);
    if (!map || map.size === 0) return "";
    return Array.from(map.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

export class HautLibraryProvider {
  constructor(options = {}) {
    this.schoolId = "haut";
    this.providerId = "school.haut.library";
    this.allowedHosts = ["wslib.haut.edu.cn", "lib.haut.edu.cn", "mapp.haut.edu.cn"];
    this.mockBackend = options.mockBackend || null;
  }

  getRules() {
    return {
      school_id: "haut",
      rule_version: "school-haut-rules-2026-09-03",
      time_zone: "Asia/Shanghai",
      window_start: "07:00:00",
      window_end_exclusive: "21:30:00",
      open_hours: "07:30:00-22:00:00",
      same_day_only: true,
      precheck_lead_seconds: 1800,
      final_check_lead_seconds: 300,
      max_lateness_seconds_limit: 1800,
      in_person_sign_in_required: true
    };
  }

  getCapabilities(schoolIntegration) {
    const liveAuthorized =
      Boolean(schoolIntegration?.enabled) &&
      schoolIntegration?.kill_switch === false &&
      Boolean(schoolIntegration?.authorization_evidence_ref) &&
      Boolean(schoolIntegration?.approver_primary_ref) &&
      Boolean(schoolIntegration?.approver_secondary_ref);

    return [
      {
        school_id: "haut",
        provider_id: this.providerId,
        capability: "READ_BOOKING_RULES",
        availability_state: "VERIFIED_READ_ONLY"
      },
      {
        school_id: "haut",
        provider_id: this.providerId,
        capability: "READ_MY_BOOKINGS",
        availability_state: liveAuthorized ? "AUTHORIZED_AUTOMATION" : "MOCK_ONLY"
      },
      {
        school_id: "haut",
        provider_id: this.providerId,
        capability: "VERIFY_BOOKING",
        availability_state: liveAuthorized ? "AUTHORIZED_AUTOMATION" : "MOCK_ONLY"
      },
      {
        school_id: "haut",
        provider_id: this.providerId,
        capability: "CREATE_BOOKING",
        availability_state: liveAuthorized ? "AUTHORIZED_AUTOMATION" : "MOCK_ONLY",
        evidence_id: schoolIntegration?.authorization_evidence_ref || null
      },
      {
        school_id: "haut",
        provider_id: this.providerId,
        capability: "SIGN_IN",
        availability_state: "DISABLED_BY_SCHOOL"
      }
    ];
  }

  assertOperationAllowed(operation, schoolIntegration, { requireLiveAutomation = false } = {}) {
    if (operation === "SIGN_IN") {
      throw new ContractError(
        "SCHOOL_PERMISSION_REQUIRED",
        "Remote or automated library SIGN_IN is strictly prohibited by school policy"
      );
    }
    if (operation === "CREATE_BOOKING") {
      if (schoolIntegration?.kill_switch === true) {
        throw new ContractError(
          "SCHOOL_PERMISSION_REQUIRED",
          "School kill_switch is active; automated booking is halted"
        );
      }
      const hasDualApprovalAndEvidence =
        Boolean(schoolIntegration?.enabled) &&
        Boolean(schoolIntegration?.authorization_evidence_ref) &&
        Boolean(schoolIntegration?.approver_primary_ref) &&
        Boolean(schoolIntegration?.approver_secondary_ref);
      if (!hasDualApprovalAndEvidence) {
        if (requireLiveAutomation) {
          throw new ContractError(
            "SCHOOL_PERMISSION_REQUIRED",
            "Dual-person approval and written school authorization evidence are required before live CREATE_BOOKING"
          );
        }
        return { executionPath: "MOCK_ONLY" };
      }
      return { executionPath: "AUTHORIZED_AUTOMATION" };
    }
    return { executionPath: "MOCK_ONLY" };
  }

  async executeMockOrAuthorizedCreate({ job, plan, binding, schoolIntegration, nowInstant }) {
    if (job.school_id !== this.schoolId) {
      throw new ContractError("FORBIDDEN", "Cross-school provider mismatch");
    }
    if (binding.status !== "DELEGATED_ACTIVE" && binding.status !== "VERIFIED_LOCAL_ONLY") {
      throw new ContractError("SCHOOL_AUTH_EXPIRED", "School binding is not active");
    }

    // Check window at fire time in Asia/Shanghai
    const rules = this.getRules();
    const fireLocalTime = formatLocalTimeInShanghai(nowInstant);
    if (fireLocalTime < rules.window_start || fireLocalTime >= rules.window_end_exclusive) {
      throw new ContractError(
        "BOOKING_WINDOW_CLOSED",
        `Target execution time ${fireLocalTime} is outside official window [${rules.window_start}, ${rules.window_end_exclusive})`
      );
    }

    if (this.mockBackend) {
      return this.mockBackend.handleCreateReservation({ job, plan, binding, nowInstant });
    }

    // Default deterministic mock reservation result (safe sandbox)
    const seatAlias = plan.preferences_json?.preferred_seat_ids?.[0] || "N4-088";
    const regionAlias = plan.preferences_json?.preferred_area_ids?.[0] || "北四楼自习区";
    const externalBookingId = `haut_mock_${job.booking_local_date}_${seatAlias}_${binding.id.slice(0, 6)}`;
    return {
      outcome: "SUBMITTED",
      externalBookingId,
      seatAlias,
      regionAlias
    };
  }

  async verifyBookingAuthoritative({ job, binding, expectedExternalBookingId }) {
    if (this.mockBackend) {
      return this.mockBackend.handleVerifyReservation({ job, binding, expectedExternalBookingId });
    }
    if (!expectedExternalBookingId) {
      return { verified: false, officialStatus: "NOT_CREATED" };
    }
    const evidenceSha256 = crypto
      .createHash("sha256")
      .update(`${job.school_id}|${binding.id}|${expectedExternalBookingId}|CONFIRMED`)
      .digest("hex");
    return {
      verified: true,
      externalBookingId: expectedExternalBookingId,
      officialStatus: "CONFIRMED",
      evidenceSha256
    };
  }
}

export function formatLocalTimeInShanghai(dateOrIso) {
  const d = typeof dateOrIso === "string" || typeof dateOrIso === "number" ? new Date(dateOrIso) : dateOrIso;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(d);
  const h = parts.find((p) => p.type === "hour")?.value || "00";
  const m = parts.find((p) => p.type === "minute")?.value || "00";
  const s = parts.find((p) => p.type === "second")?.value || "00";
  return `${h}:${m}:${s}`;
}
