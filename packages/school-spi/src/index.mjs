import dns from "node:dns";
try { dns.setDefaultResultOrder("ipv4first"); } catch {}
import crypto from "node:crypto";
import { ContractError } from "../../contracts/src/index.mjs";

/**
 * School SPI, SSRF Guard, Cross-School Cookie Isolation & Live HAUT Library Provider.
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
  /^::ffff:/i,
  /^\[::/i,
  /^fc00:/i,
  /^fd00:/i,
  /^fe80:/i,
  /^localhost$/i,
  /\.internal$/i,
  /metadata\.google\.internal/i
];

export const HAUT_CAS_LOGIN_URL =
  "https://mapp.haut.edu.cn/cas/login?service=https://wslib.haut.edu.cn/stage-api/api/caslogin/ticketlogin";
export const HAUT_WSLIB_API_BASE = "https://wslib.haut.edu.cn/spacelink/api";
const HAUT_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const HAUT_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";

export function translateWslibDiagnosticMessage(rawMsg) {
  const text = String(rawMsg || "").trim();
  if (!text) return "";
  if (/seat\.10042/i.test(text)) return "只能预约1天之内的时间(含当天)";
  if (/seat\.10056/i.test(text)) return "预约开始时间须大于当前时间";
  if (/seat\.10057/i.test(text)) return "只能预约1天之内的时间(含当天)";
  if (/seat\.10058/i.test(text)) return "预约时间不在自习室开放时段内";
  if (/seat\.10062/i.test(text)) return "本座位已锁定 请稍后再试!";
  if (/seat\.10079/i.test(text)) return "未到07:00开放时间或该时段内已有生效预约";
  return text;
}

export function isWslibNotYetOpenMessage(rawMsg) {
  const text = String(rawMsg || "").trim();
  return /未到|未开放|不在.*时间|只能预约1天|尚未开放|seat\.10042|seat\.10057|seat\.10058|seat\.10079/i.test(text);
}

export function isWslibSeatLockedMessage(rawMsg, code = null) {
  if (Number(code) === 1122) return true;
  const text = String(rawMsg || "").trim();
  return /本座位已锁定|已锁定.*稍后再试|seat\.10062/i.test(text);
}

export function isWslibSeatOccupiedByOthersMessage(rawMsg, code = null) {
  const text = String(rawMsg || "").trim();
  return (
    (Number(code) === 404 && /该座位|此座位/.test(text)) ||
    /该座位已有预约|此座位已有预约|该座位已被预约|座位已被占用/i.test(text)
  );
}

export function normalizeSeatComparisonToken(rawSeat, regionName = "") {
  let text = cleanSpiText(rawSeat, "");
  if (!text) return "";
  const cleanReg = cleanSpiText(regionName, "").trim();
  if (cleanReg && text.startsWith(cleanReg)) {
    text = text.slice(cleanReg.length).trim();
  }
  return text
    .replace(/号座?$/g, "")
    .replace(/\s+/g, "")
    .replace(/^0+(\d+)/, "$1")
    .toUpperCase();
}

export function extractDateAndTimeHm(rawDateTime) {
  const text = String(rawDateTime || "").trim();
  const m = text.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::\d{2})?$/);
  if (!m) return null;
  return { date: m[1], hm: m[2] };
}

export function resolvePlanTimeWindow(
  targetDate,
  plan,
  fallbackStartFull = null,
  fallbackEndFull = null
) {
  const dateStr =
    String(targetDate || "").trim() ||
    (fallbackStartFull ? String(fallbackStartFull).trim().slice(0, 10) : "");
  const rawSlotWindow = cleanSpiText(
    plan?.slot_window || plan?.preferences_json?.slot_window || "",
    ""
  );
  const swMatch = rawSlotWindow.match(
    /^(\d{2}:\d{2})(?::(\d{2}))?\s*-\s*(\d{2}:\d{2})(?::(\d{2}))?$/
  );
  if (swMatch && dateStr) {
    const startHm = swMatch[1];
    const startSec = swMatch[2] || "00";
    const endHm = swMatch[3];
    const endSec = swMatch[4] || "00";
    const normalizedSw = `${startHm}-${endHm}`;
    // Only when the plan did NOT explicitly specify a slot_window and holds the implicit "07:30-22:00" placeholder
    // do we fall back to the school's dynamic open window; any explicit user slot_window (including "08:00-22:00")
    // is preserved verbatim throughout prewarm, submission, and readback verification!
    const isImplicitDefaultOnly =
      normalizedSw === "07:30-22:00" && plan?.has_explicit_slot_window === false;
    if (isImplicitDefaultOnly && fallbackStartFull && fallbackEndFull) {
      const fbStart = extractDateAndTimeHm(fallbackStartFull);
      const fbEnd = extractDateAndTimeHm(fallbackEndFull);
      if (fbStart && fbEnd && fbStart.date === dateStr) {
        return {
          startFull: fallbackStartFull,
          endFull: fallbackEndFull,
          slotWindow: `${fbStart.hm}-${fbEnd.hm}`,
          hasExplicitSlotWindow: false
        };
      }
    }
    return {
      startFull: `${dateStr} ${startHm}:${startSec}`,
      endFull: `${dateStr} ${endHm}:${endSec}`,
      slotWindow: normalizedSw,
      hasExplicitSlotWindow: !isImplicitDefaultOnly
    };
  }
  return {
    startFull: fallbackStartFull || (dateStr ? `${dateStr} 07:30:00` : null),
    endFull: fallbackEndFull || (dateStr ? `${dateStr} 22:00:00` : null),
    slotWindow: rawSlotWindow || null,
    hasExplicitSlotWindow: false
  };
}

export function isBookingMatchingTarget(
  booking,
  {
    targetDates = [],
    expectedStartFull = null,
    expectedEndFull = null,
    expectedSlotWindow = null,
    regionId = null,
    regionName = "",
    candidateSeats = [],
    wantedSeatNames = [],
    specificSeat = null,
    expectedBookingId = null
  } = {}
) {
  if (!booking || !booking.bookingId) return false;
  if (
    expectedBookingId &&
    !String(expectedBookingId).startsWith("haut_mock_") &&
    String(booking.bookingId) !== String(expectedBookingId)
  ) {
    return false;
  }

  // 1. Strict date AND time-slot window check
  const actStart = extractDateAndTimeHm(booking.startDate);
  const actEnd = extractDateAndTimeHm(booking.endDate);
  if (!actStart || !actEnd || actStart.date !== actEnd.date) {
    return false;
  }
  const validDates = (targetDates || []).map((d) => String(d || "").trim()).filter(Boolean);
  if (validDates.length > 0 && !validDates.includes(actStart.date)) {
    return false;
  }
  if (expectedStartFull) {
    const expStart = extractDateAndTimeHm(expectedStartFull);
    if (!expStart || actStart.date !== expStart.date || actStart.hm !== expStart.hm) {
      return false;
    }
  }
  if (expectedEndFull) {
    const expEnd = extractDateAndTimeHm(expectedEndFull);
    if (!expEnd || actEnd.date !== expEnd.date || actEnd.hm !== expEnd.hm) {
      return false;
    }
  }
  if (expectedSlotWindow) {
    const swMatch = String(expectedSlotWindow)
      .trim()
      .match(/^(\d{2}:\d{2})(?::\d{2})?\s*-\s*(\d{2}:\d{2})(?::\d{2})?$/);
    if (swMatch) {
      if (actStart.hm !== swMatch[1] || actEnd.hm !== swMatch[2]) {
        return false;
      }
    }
  }

  // 2. Strict positive region verification (missing region info must never pass)
  const cleanWantedRegion = cleanSpiText(regionName, "").trim();
  const bookReg = cleanSpiText(booking.regionName, "");
  const bookSeat = cleanSpiText(booking.seatName, "");
  const hasBookingRegionId =
    booking.buildingLayerRegionId !== null &&
    booking.buildingLayerRegionId !== undefined &&
    String(booking.buildingLayerRegionId).trim() !== "";

  if (regionId !== null && regionId !== undefined && hasBookingRegionId) {
    if (Number(booking.buildingLayerRegionId) !== Number(regionId)) {
      return false;
    }
  }

  const hasValidRegionIdMatch =
    regionId !== null &&
    regionId !== undefined &&
    hasBookingRegionId &&
    Number(booking.buildingLayerRegionId) === Number(regionId);

  if (cleanWantedRegion) {
    if (bookReg) {
      if (bookReg !== cleanWantedRegion) {
        return false;
      }
    } else if (!hasValidRegionIdMatch || !bookSeat.startsWith(cleanWantedRegion)) {
      if (!bookSeat.startsWith(cleanWantedRegion)) {
        return false;
      }
    }
  } else if (regionId !== null && regionId !== undefined) {
    if (!hasValidRegionIdMatch) {
      return false;
    }
  } else if (!bookReg && !hasBookingRegionId) {
    return false;
  }

  const effectiveRegionForNorm = cleanWantedRegion || bookReg;

  const matchesSeatSpec = (spec) => {
    if (!spec) return false;
    if (typeof spec === "object") {
      const specId = spec.id ?? spec.seat_id;
      const hasBothIds =
        specId !== null &&
        specId !== undefined &&
        booking.seatId !== null &&
        booking.seatId !== undefined;
      if (hasBothIds && Number(booking.seatId) !== Number(specId)) {
        return false;
      }
      const normBook = normalizeSeatComparisonToken(booking.seatName, effectiveRegionForNorm);
      const normSpecFull = normalizeSeatComparisonToken(
        spec.seat_name || spec.seatName || "",
        effectiveRegionForNorm
      );
      const normSpecShort = normalizeSeatComparisonToken(
        spec.short_name || spec.shortName || "",
        effectiveRegionForNorm
      );
      if (normBook && (normSpecFull || normSpecShort)) {
        if (normBook !== normSpecFull && normBook !== normSpecShort) {
          return false;
        }
        return true;
      }
      return hasBothIds && Number(booking.seatId) === Number(specId);
    }
    const rawStr = String(spec).trim();
    if (!rawStr) return false;
    if (/^\d+$/.test(rawStr) && booking.seatId !== null && booking.seatId !== undefined) {
      if (String(booking.seatId) === rawStr) return true;
    }
    const normBook = normalizeSeatComparisonToken(booking.seatName, effectiveRegionForNorm);
    const normWanted = normalizeSeatComparisonToken(rawStr, effectiveRegionForNorm);
    return Boolean(normBook && normWanted && normBook === normWanted);
  };

  if (specificSeat) {
    return matchesSeatSpec(specificSeat);
  }

  const candObjects = Array.isArray(candidateSeats) ? candidateSeats.filter(Boolean) : [];
  const candNames = Array.isArray(wantedSeatNames)
    ? wantedSeatNames.map((s) => String(s || "").trim()).filter(Boolean)
    : [];
  if (candObjects.length > 0 || candNames.length > 0) {
    const matchedObj = candObjects.some((c) => matchesSeatSpec(c));
    const matchedName = candNames.some((n) => matchesSeatSpec(n));
    if (!matchedObj && !matchedName) {
      return false;
    }
  }

  return true;
}

export function isWslibAlreadyBookedMessage(rawMsg) {
  const text = String(rawMsg || "").trim();
  if (isWslibSeatOccupiedByOthersMessage(text)) return false;
  return /您已有.*预约|不能重复|已有一个.*预约|只能预约一个座位|当前已有预约|seat\.10060|seat\.10061/i.test(text);
}

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
  if (parsed.username || parsed.password) {
    throw new ContractError("FORBIDDEN", "Outbound school URLs must not contain userinfo credentials");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new ContractError("FORBIDDEN", `Disallowed outbound port: ${parsed.port}`);
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

export function cleanSpiText(raw, fallback = "") {
  if (raw === null || raw === undefined) return fallback;
  const trimmed = String(raw).trim();
  if (!trimmed) return fallback;
  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "undefined" || lower === "none" || lower === "nil") {
    return fallback;
  }
  return trimmed;
}

export function inferFloorFromRegionName(regionName, rawLayerName) {
  const cleanLayer = cleanSpiText(rawLayerName, "");
  if (cleanLayer) return cleanLayer;
  const name = cleanSpiText(regionName, "");
  const m = name.match(/^(一|二|三|四|五|六|七|八|九|十|[1-9]|10)(层|楼)/);
  if (m) return `${m[1]}层`;
  return "图书馆自习区";
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

  normalizeRawToken(token) {
    let cur = String(token || "").trim();
    while (/^Bearer\s+/i.test(cur)) {
      cur = cur.replace(/^Bearer\s+/i, "").trim();
    }
    return cur;
  }

  parseCredentialBundle(rawSecret, binding = null) {
    const fallbackStudentNo = String(binding?.student_no || "").trim();
    if (!rawSecret) {
      return {
        raw_token: "",
        cas_tgc: "",
        cas_jsessionid: "",
        student_no: fallbackStudentNo,
        password: "",
        isLiveCredential: false
      };
    }
    const text = String(rawSecret).trim();
    if (
      text === "delegated_session_v1" ||
      text === "reauthorized_session_v1" ||
      text.startsWith("mock_") ||
      text.startsWith("test_")
    ) {
      return {
        raw_token: "",
        cas_tgc: "",
        cas_jsessionid: "",
        student_no: fallbackStudentNo,
        password: "",
        isLiveCredential: false
      };
    }
    if (text.startsWith("{")) {
      try {
        const parsed = JSON.parse(text);
        const rawToken = this.normalizeRawToken(parsed.raw_token || parsed.rawToken || parsed.token);
        const casTgc = String(parsed.cas_tgc || parsed.casTgcCookie || "").trim();
        const casJsessionId = String(parsed.cas_jsessionid || parsed.casJsessionId || "").trim();
        const explicitStudentNo = String(parsed.student_no || parsed.studentId || "").trim();
        if (explicitStudentNo && fallbackStudentNo && explicitStudentNo !== fallbackStudentNo) {
          throw new ContractError(
            "SCHOOL_AUTH_EXPIRED",
            "Credential student_no mismatch with school binding"
          );
        }
        const studentNo = explicitStudentNo || fallbackStudentNo;
        const password = String(parsed.password || parsed.passwordPlain || "").trim();
        const isLive = Boolean(rawToken.length > 32 || casTgc.length > 10 || (studentNo && password));
        return {
          raw_token: rawToken,
          cas_tgc: casTgc,
          cas_jsessionid: casJsessionId,
          student_no: studentNo,
          password,
          isLiveCredential: isLive
        };
      } catch (err) {
        if (err instanceof ContractError) throw err;
        // Fallback to raw token handling
      }
    }
    const cleanToken = this.normalizeRawToken(text);
    const isJwtLike = cleanToken.length > 32 && cleanToken.includes(".");
    return {
      raw_token: isJwtLike ? cleanToken : "",
      cas_tgc: "",
      cas_jsessionid: "",
      student_no: fallbackStudentNo,
      password: "",
      isLiveCredential: isJwtLike
    };
  }

  async validateWslibTokenOnline(rawToken) {
    const cleanToken = this.normalizeRawToken(rawToken);
    if (!cleanToken) return null;
    const url = `${HAUT_WSLIB_API_BASE}/h5user/my/userinfo`;
    validateAllowedSchoolUrl(url, this.allowedHosts);
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "error",
        headers: {
          "User-Agent": HAUT_USER_AGENT,
          "Accept-Language": HAUT_ACCEPT_LANGUAGE,
          Authorization: `Bearer ${cleanToken}`,
          Accept: "application/json, text/plain, */*"
        },
        signal: AbortSignal.timeout(8000)
      });
      if (res.status !== 200) return null;
      const json = await res.json();
      if (json?.code !== 200 || !json?.data) return null;
      const userNo = cleanSpiText(json.data.userNo, "");
      const userName = cleanSpiText(json.data.userName, "");
      if (!userNo && !userName) return null;
      return {
        userNo,
        userName: userName || userNo,
        department: cleanSpiText(json.data.department, ""),
        cardNo: cleanSpiText(json.data.cardNo, ""),
        breakNum: cleanSpiText(json.data.breakNum, "0") || "0"
      };
    } catch {
      return null;
    }
  }

  async authenticateHautSession(credInput, binding = null) {
    const bundle =
      typeof credInput === "object" && credInput !== null && "isLiveCredential" in credInput
        ? credInput
        : this.parseCredentialBundle(credInput, binding);

    // Level 1: Direct wslib JWT token validation
    if (bundle.raw_token) {
      const userInfo = await this.validateWslibTokenOnline(bundle.raw_token);
      if (userInfo) {
        const expectedSno = String(binding?.student_no || bundle.student_no || "").trim();
        if (expectedSno && userInfo.userNo && String(userInfo.userNo).trim() !== expectedSno) {
          throw new ContractError(
            "SCHOOL_AUTH_EXPIRED",
            "Authenticated userNo does not match school binding student_no"
          );
        }
        return {
          rawToken: bundle.raw_token,
          casTgc: bundle.cas_tgc || "",
          casJsessionId: bundle.cas_jsessionid || "",
          userInfo,
          source: "CACHED_TOKEN"
        };
      }
    }

    // Host-scoped cookie jar so mapp.haut.edu.cn CASTGC is never leaked to wslib.haut.edu.cn
    const jarByHost = new Map();
    const getHostJar = (urlStr) => {
      const host = new URL(urlStr).hostname.toLowerCase();
      if (!jarByHost.has(host)) {
        jarByHost.set(host, new Map());
      }
      return jarByHost.get(host);
    };
    const saveCookies = (res, urlStr) => {
      const hostJar = getHostJar(urlStr);
      const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      for (const sc of setCookies) {
        const [pair] = String(sc).split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) {
          hostJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
      }
    };
    const cookieHeader = (urlStr) => {
      const hostJar = getHostJar(urlStr);
      return Array.from(hostJar.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    };
    const casHostJar = () => getHostJar(HAUT_CAS_LOGIN_URL);

    const followRedirectsForToken = async (initialResp, startUrl) => {
      let r = initialResp;
      let currUrl = startUrl;
      for (let i = 0; i < 12; i++) {
        const loc = r.headers.get("location");
        if (!loc) break;
        const nextUrl = new URL(loc, currUrl)
          .toString()
          .replace(/^http:\/\/(wslib|mapp|lib)\.haut\.edu\.cn/i, "https://$1.haut.edu.cn");
        validateAllowedSchoolUrl(nextUrl, this.allowedHosts);
        const tokenMatch = nextUrl.match(/[?&]token=([^&#;]+)/);
        if (tokenMatch) {
          return this.normalizeRawToken(decodeURIComponent(tokenMatch[1]));
        }
        currUrl = nextUrl;
        const hostCookies = cookieHeader(currUrl);
        r = await fetch(currUrl, {
          method: "GET",
          redirect: "manual",
          headers: {
            "User-Agent": HAUT_USER_AGENT,
            ...(hostCookies ? { Cookie: hostCookies } : {})
          },
          signal: AbortSignal.timeout(9000)
        });
        saveCookies(r, currUrl);
        // When wslib's /stage-api/ Nginx upstream returns 502/503/504, the CAS ST ticket is unconsumed;
        // seamlessly fail over to the healthy /spacelink/api/caslogin/ticketlogin upstream.
        if (
          !r.headers.get("location") &&
          r.status >= 500 &&
          currUrl.includes("/stage-api/api/caslogin/ticketlogin")
        ) {
          const fallbackUrl = currUrl.replace(
            "/stage-api/api/caslogin/ticketlogin",
            "/spacelink/api/caslogin/ticketlogin"
          );
          validateAllowedSchoolUrl(fallbackUrl, this.allowedHosts);
          currUrl = fallbackUrl;
          const fbCookies = cookieHeader(currUrl);
          r = await fetch(currUrl, {
            method: "GET",
            redirect: "manual",
            headers: {
              "User-Agent": HAUT_USER_AGENT,
              ...(fbCookies ? { Cookie: fbCookies } : {})
            },
            signal: AbortSignal.timeout(9000)
          });
          saveCookies(r, currUrl);
        }
      }
      return null;
    };

    // Level 2: Silent CASTGC cookie exchange
    if (bundle.cas_tgc) {
      try {
        casHostJar().set("CASTGC", bundle.cas_tgc);
        if (bundle.cas_jsessionid) casHostJar().set("JSESSIONID", bundle.cas_jsessionid);
        validateAllowedSchoolUrl(HAUT_CAS_LOGIN_URL, this.allowedHosts);
        const r0 = await fetch(HAUT_CAS_LOGIN_URL, {
          method: "GET",
          redirect: "manual",
          headers: {
            "User-Agent": HAUT_USER_AGENT,
            Cookie: cookieHeader(HAUT_CAS_LOGIN_URL)
          },
          signal: AbortSignal.timeout(9000)
        });
        saveCookies(r0, HAUT_CAS_LOGIN_URL);
        if ([301, 302, 303, 307, 308].includes(r0.status)) {
          const freshToken = await followRedirectsForToken(r0, HAUT_CAS_LOGIN_URL);
          if (freshToken) {
            const userInfo = await this.validateWslibTokenOnline(freshToken);
            if (userInfo) {
              return {
                rawToken: freshToken,
                casTgc: casHostJar().get("CASTGC") || bundle.cas_tgc,
                casJsessionId: casHostJar().get("JSESSIONID") || bundle.cas_jsessionid || "",
                userInfo,
                source: "PERSISTED_COOKIE"
              };
            }
          }
        }
      } catch {
        // Proceed to Level 3 password login
      }
    }

    // Level 3: Full CAS login with student_no + password
    if (bundle.student_no && bundle.password) {
      jarByHost.clear();
      validateAllowedSchoolUrl(HAUT_CAS_LOGIN_URL, this.allowedHosts);
      const r1 = await fetch(HAUT_CAS_LOGIN_URL, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": HAUT_USER_AGENT },
        signal: AbortSignal.timeout(10000)
      });
      saveCookies(r1, HAUT_CAS_LOGIN_URL);
      if ([301, 302, 303, 307, 308].includes(r1.status)) {
        const directToken = await followRedirectsForToken(r1, HAUT_CAS_LOGIN_URL);
        if (directToken) {
          const userInfo = await this.validateWslibTokenOnline(directToken);
          if (userInfo) {
            return {
              rawToken: directToken,
              casTgc: casHostJar().get("CASTGC") || "",
              casJsessionId: casHostJar().get("JSESSIONID") || "",
              userInfo,
              source: "CAS_DIRECT"
            };
          }
        }
      }
      const html = await r1.text();
      const lt = (html.match(/name="lt"\s+value="([^"]+)"/) ||
        html.match(/value="([^"]+)"\s+name="lt"/) ||
        [])[1];
      if (!lt) {
        throw new ContractError(
          "SCHOOL_AUTH_EXPIRED",
          "未能从学校统一身份认证页面提取登录令牌 (lt)"
        );
      }
      const execution = (html.match(/name="execution"\s+value="([^"]+)"/) || [null, "e1s1"])[1];
      const actionRaw = (html.match(/<form[^>]*id="fm1"[^>]*action="([^"]+)"/) || [])[1]?.replace(
        /&amp;/g,
        "&"
      );
      const postUrl = actionRaw ? new URL(actionRaw, HAUT_CAS_LOGIN_URL).toString() : HAUT_CAS_LOGIN_URL;
      validateAllowedSchoolUrl(postUrl, this.allowedHosts);

      const encodedPwd = "{gilight}_" + Buffer.from(bundle.password, "utf8").toString("base64");
      const formBody = new URLSearchParams({
        username: bundle.student_no,
        password: encodedPwd,
        lt,
        execution,
        _eventId: "submit"
      }).toString();

      const postHostCookies = cookieHeader(postUrl);
      const r2 = await fetch(postUrl, {
        method: "POST",
        redirect: "manual",
        headers: {
          "User-Agent": HAUT_USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          ...(postHostCookies ? { Cookie: postHostCookies } : {})
        },
        body: formBody,
        signal: AbortSignal.timeout(10000)
      });
      saveCookies(r2, postUrl);
      if (!r2.headers.get("location")) {
        const errBody = await r2.text();
        if (errBody.includes("验证码") || /captcha/i.test(errBody)) {
          throw new ContractError(
            "SCHOOL_AUTH_EXPIRED",
            "学校统一身份认证要求输入图形验证码，请先在 App 选座页登录一次"
          );
        }
        throw new ContractError(
          "SCHOOL_AUTH_EXPIRED",
          "学校统一身份认证未通过，请核对学号与统一认证密码是否正确"
        );
      }
      const freshToken = await followRedirectsForToken(r2, postUrl);
      if (!freshToken) {
        throw new ContractError(
          "SCHOOL_AUTH_EXPIRED",
          "未从图书馆空间预约回调中获取登录 Token"
        );
      }
      const userInfo = (await this.validateWslibTokenOnline(freshToken)) || {
        userNo: bundle.student_no,
        userName: bundle.student_no,
        department: "",
        cardNo: "",
        breakNum: "0"
      };
      return {
        rawToken: freshToken,
        casTgc: casHostJar().get("CASTGC") || "",
        casJsessionId: casHostJar().get("JSESSIONID") || "",
        userInfo,
        source: "BACKGROUND_PASSWORD_LOGIN"
      };
    }

    throw new ContractError(
      "SCHOOL_AUTH_EXPIRED",
      "学校图书馆登录态已过期，请在页面或 App 中绑定学号与统一认证密码"
    );
  }

  async wslibGetJson(pathAndQuery, rawToken) {
    const cleanToken = this.normalizeRawToken(rawToken);
    const url = `${HAUT_WSLIB_API_BASE}${pathAndQuery}`;
    validateAllowedSchoolUrl(url, this.allowedHosts);
    const res = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: {
        "User-Agent": HAUT_USER_AGENT,
        "Accept-Language": HAUT_ACCEPT_LANGUAGE,
        Authorization: `Bearer ${cleanToken}`,
        Accept: "application/json, text/plain, */*"
      },
      signal: AbortSignal.timeout(8500)
    });
    if (res.status === 401) {
      throw new ContractError("SCHOOL_AUTH_EXPIRED", "图书馆登录 Token 已过期");
    }
    const json = await res.json();
    if (json?.code === 401) {
      throw new ContractError("SCHOOL_AUTH_EXPIRED", "图书馆登录 Token 已过期");
    }
    if (json && typeof json.msg === "string" && json.msg.includes("No message found under code")) {
      json.raw_msg = json.msg;
      json.msg = translateWslibDiagnosticMessage(json.msg);
    }
    return json;
  }

  async resolveDefaultBookingWindow(rawToken, regionId, bookingDate) {
    const dtJson = await this.wslibGetJson(
      `/seatbook/layout/getDefaultTime?regionid=${encodeURIComponent(
        regionId || 7
      )}&bookingdate=${encodeURIComponent(bookingDate)}`,
      rawToken
    ).catch(() => null);
    const rawStartDate = cleanSpiText(dtJson?.startDate, "");
    const rawEndDate = cleanSpiText(dtJson?.endDate, "");
    let rawStartTime = cleanSpiText(dtJson?.startTime, "07:30") || "07:30";
    let rawEndTime = cleanSpiText(dtJson?.endTime, "22:00") || "22:00";

    let startFull = rawStartDate.includes(" ")
      ? rawStartDate
      : `${rawStartDate || bookingDate} ${
          rawStartTime.split(":").length === 2 ? `${rawStartTime}:00` : rawStartTime
        }`;
    let endFull = rawEndDate.includes(" ")
      ? rawEndDate
      : `${rawEndDate || bookingDate} ${
          rawEndTime.split(":").length === 2 ? `${rawEndTime}:00` : rawEndTime
        }`;

    // When queried late at night (after 21:50), wslib returns startDate = now+5min >= endDate (22:00:00),
    // which causes /seatbook/layout/query to return code 500 (seat.10058). Clamp to standard 07:30..22:00.
    if (startFull >= endFull || rawStartTime >= "21:50" || !startFull.startsWith(bookingDate)) {
      rawStartTime = "07:30";
      rawEndTime = "22:00";
      startFull = `${bookingDate} 07:30:00`;
      endFull = `${bookingDate} 22:00:00`;
    }

    return {
      startFull,
      endFull,
      startTime: rawStartTime,
      endTime: rawEndTime,
      canSetTime: String(dtJson?.isCanSetTime || "0") !== "0"
    };
  }

  getShanghaiTodayDateString() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());
  }

  async fetchLiveStudyRegions(rawToken, bookingDate) {
    const shanghaiToday = this.getShanghaiTodayDateString();
    const isFutureDate = Boolean(bookingDate && String(bookingDate) > shanghaiToday);
    const queryDate = isFutureDate ? shanghaiToday : bookingDate || shanghaiToday;
    const windowInfo = await this.resolveDefaultBookingWindow(rawToken, 7, queryDate);
    const bJson = await this.wslibGetJson("/seatbook/layout/building", rawToken);
    const buildings = bJson?.builderInfo || bJson?.data?.builderInfo || [{ id: "1", buildingName: "莲花街图书馆" }];
    const regions = [];
    for (const b of buildings) {
      const bId = cleanSpiText(b?.id, "1") || "1";
      const bName = cleanSpiText(b?.buildingName, "莲花街图书馆") || "莲花街图书馆";
      let rJson = await this.wslibGetJson(
        `/seatbook/layout/region?buildingId=${encodeURIComponent(
          bId
        )}&layerid=&starttime=${encodeURIComponent(windowInfo.startFull)}&endtime=${encodeURIComponent(
          windowInfo.endFull
        )}`,
        rawToken
      ).catch(() => null);
      let list = rJson?.regionList || rJson?.data?.regionList || [];
      if (list.length === 0 && queryDate !== shanghaiToday) {
        const fallbackWindow = await this.resolveDefaultBookingWindow(rawToken, 7, shanghaiToday);
        rJson = await this.wslibGetJson(
          `/seatbook/layout/region?buildingId=${encodeURIComponent(
            bId
          )}&layerid=&starttime=${encodeURIComponent(fallbackWindow.startFull)}&endtime=${encodeURIComponent(
            fallbackWindow.endFull
          )}`,
          rawToken
        ).catch(() => null);
        list = rJson?.regionList || rJson?.data?.regionList || [];
      }
      for (const r of list) {
        const regionName = cleanSpiText(r?.regionName, "");
        if (!r?.id || !regionName) continue;
        const totalSeats = Number(r.num || 0);
        const rawAvailable = Number(r.cannum || 0);
        regions.push({
          id: Number(r.id),
          region_id: Number(r.id),
          region_name: regionName,
          building_id: bId,
          building_name: bName,
          layer_name: inferFloorFromRegionName(regionName, r.layerName),
          open_time: cleanSpiText(r.openDate, "07:30") || "07:30",
          close_time: cleanSpiText(r.closeDate, "22:00") || "22:00",
          total_seats: totalSeats,
          available_seats: isFutureDate && totalSeats > 0 ? totalSeats : rawAvailable,
          is_open: Number(r.isOpen ?? 1) !== 0
        });
      }
    }
    return {
      booking_date: bookingDate || shanghaiToday,
      start_full: isFutureDate ? `${bookingDate} 07:30:00` : windowInfo.startFull,
      end_full: isFutureDate ? `${bookingDate} 22:00:00` : windowInfo.endFull,
      regions
    };
  }

  async fetchLiveRegionSeats(rawToken, regionId, bookingDate) {
    const shanghaiToday = this.getShanghaiTodayDateString();
    const isFutureDate = Boolean(bookingDate && String(bookingDate) > shanghaiToday);
    const initialDate = isFutureDate ? shanghaiToday : bookingDate || shanghaiToday;
    const windowInfo = await this.resolveDefaultBookingWindow(rawToken, regionId, initialDate);
    let qJson = await this.wslibGetJson(
      `/seatbook/layout/query?starttime=${encodeURIComponent(
        windowInfo.startFull
      )}&endtime=${encodeURIComponent(windowInfo.endFull)}&regionid=${encodeURIComponent(regionId)}`,
      rawToken
    ).catch(() => null);
    let rawSeats = qJson?.seatList || qJson?.data?.seatList || [];
    if (rawSeats.length === 0 && initialDate !== shanghaiToday) {
      const todayWindow = await this.resolveDefaultBookingWindow(rawToken, regionId, shanghaiToday);
      qJson = await this.wslibGetJson(
        `/seatbook/layout/query?starttime=${encodeURIComponent(
          todayWindow.startFull
        )}&endtime=${encodeURIComponent(todayWindow.endFull)}&regionid=${encodeURIComponent(regionId)}`,
        rawToken
      ).catch(() => null);
      rawSeats = qJson?.seatList || qJson?.data?.seatList || [];
    }
    const regionName = cleanSpiText(qJson?.layout?.regionName, "");
    const seats = rawSeats
      .filter((s) => s?.id && cleanSpiText(s?.seatName, ""))
      .map((s) => {
        const fullName = cleanSpiText(s.seatName, "");
        const shortName =
          regionName && fullName.startsWith(regionName)
            ? fullName.slice(regionName.length).trim()
            : fullName;
        const rawStatus = Number(s.seatStatus ?? 1);
        const seatStatus = isFutureDate ? 2 : rawStatus;
        return {
          id: Number(s.id),
          seat_id: Number(s.id),
          seat_name: fullName,
          short_name: shortName || fullName,
          seat_status: seatStatus,
          available: seatStatus === 2
        };
      });
    return {
      region_id: Number(regionId),
      region_name: regionName,
      booking_date: bookingDate || shanghaiToday,
      start_full: isFutureDate ? `${bookingDate} 07:30:00` : windowInfo.startFull,
      end_full: isFutureDate ? `${bookingDate} 22:00:00` : windowInfo.endFull,
      seats
    };
  }

  async fetchActiveBookings(rawToken, { requireCompleteList = false } = {}) {
    const results = [];
    const seenIds = new Set();
    const curJson = await this.wslibGetJson("/seatbook/user/my/crrentbooking", rawToken);
    if (!curJson || (typeof curJson.code === "number" && curJson.code !== 200)) {
      throw new Error(curJson?.msg || "Failed to read current booking");
    }
    const data = curJson?.data || curJson?.booking || null;
    if (data && data.id && ["1", "2", "3", "4"].includes(String(data.bookingStatus))) {
      const bId = String(data.id);
      seenIds.add(bId);
      results.push({
        bookingId: bId,
        seatId: data.seatId ? Number(data.seatId) : null,
        seatName: String(data.seatName || "").trim(),
        regionName: String(data.regionName || "").trim(),
        buildingLayerRegionId: data.buildingLayerRegionId ? Number(data.buildingLayerRegionId) : null,
        startDate: String(data.startDate || "").trim(),
        endDate: String(data.endDate || "").trim(),
        bookingStatus: Number(data.bookingStatus)
      });
    }
    if (!requireCompleteList && results.length > 0) {
      return results;
    }
    const inProgJson = await this.wslibGetJson(
      "/seatbook/user/mybookingInProgress?bookingstatus=0&pageSize=50&pageNum=1",
      rawToken
    );
    if (!inProgJson || (typeof inProgJson.code === "number" && inProgJson.code !== 200)) {
      throw new Error(inProgJson?.msg || "Failed to read in-progress bookings");
    }
    const rawRows = inProgJson?.rows ?? inProgJson?.data?.rows;
    if (requireCompleteList && !Array.isArray(rawRows)) {
      throw new Error("In-progress booking list response is missing rows array");
    }
    const rows = Array.isArray(rawRows) ? rawRows : [];
    const declaredTotal = Number(inProgJson?.total ?? inProgJson?.data?.total ?? rows.length);
    if (requireCompleteList && Number.isFinite(declaredTotal) && declaredTotal > rows.length) {
      throw new Error("In-progress booking list is paginated/incomplete");
    }
    for (const row of rows) {
      if (row && row.id && ["1", "2", "3", "4"].includes(String(row.bookingStatus))) {
        const bId = String(row.id);
        if (seenIds.has(bId)) continue;
        seenIds.add(bId);
        results.push({
          bookingId: bId,
          seatId: row.seatId ? Number(row.seatId) : null,
          seatName: String(row.seatName || "").trim(),
          regionName: String(row.regionName || "").trim(),
          buildingLayerRegionId: row.buildingLayerRegionId ? Number(row.buildingLayerRegionId) : null,
          startDate: String(row.startDate || "").trim(),
          endDate: String(row.endDate || "").trim(),
          bookingStatus: Number(row.bookingStatus)
        });
      }
    }
    return results;
  }

  async fetchCurrentActiveBooking(rawToken) {
    const list = await this.fetchActiveBookings(rawToken);
    return list[0] || null;
  }

  async submitCandidateSeatAndVerify({
    cand,
    startFull,
    endFull,
    expectedSlotWindow = null,
    targetDate,
    regionId,
    regionName,
    candidateSeats,
    wantedSeats,
    rawToken,
    assertStillAuthorized = null,
    isStillAuthorized = null,
    onBeforeExternalWrite = null,
    onAfterExternalWrite = null
  }) {
    const verifyReadback = async (specificSeat, expectedBookingId = null) => {
      let bookings;
      try {
        bookings = await this.fetchActiveBookings(rawToken);
      } catch {
        return { status: "READBACK_FAILED", matched: null, unrelated: null };
      }
      const matched = bookings.find((b) =>
        isBookingMatchingTarget(b, {
          targetDates: [targetDate],
          expectedStartFull: startFull,
          expectedEndFull: endFull,
          expectedSlotWindow,
          regionId,
          regionName,
          candidateSeats,
          wantedSeatNames: wantedSeats,
          specificSeat,
          expectedBookingId
        })
      );
      if (matched) {
        return { status: "MATCHED", matched, unrelated: null };
      }
      const unrelated = bookings[0] || null;
      return { status: unrelated ? "UNRELATED_FOUND" : "EMPTY", matched: null, unrelated };
    };

    if (typeof assertStillAuthorized === "function") {
      assertStillAuthorized();
    }
    let attemptRecord = null;
    if (typeof onBeforeExternalWrite === "function") {
      attemptRecord = await onBeforeExternalWrite({
        cand,
        targetDate,
        startFull,
        endFull,
        slotWindow: expectedSlotWindow,
        regionId,
        regionName
      });
    }
    let addRes;
    try {
      addRes = await this.wslibGetJson(
        `/seatbook/user/addbooking?channel=1003&seatid=${encodeURIComponent(
          cand.id
        )}&starttime=${encodeURIComponent(startFull)}&endtime=${encodeURIComponent(
          endFull
        )}`,
        rawToken
      );
    } catch (addErr) {
      if (
        addErr?.code === "CONSENT_WITHDRAWN" ||
        addErr?.code === "STORAGE_PERSISTENCE_FAILED" ||
        addErr?.code === "SCHOOL_AUTH_EXPIRED"
      ) {
        if (addErr?.code === "SCHOOL_AUTH_EXPIRED" && typeof onAfterExternalWrite === "function") {
          await onAfterExternalWrite(attemptRecord?.id, {
            writeDispatched: false,
            rawResponseCode: "401",
            rawResponseMsg: "SCHOOL_AUTH_EXPIRED"
          });
        }
        throw addErr;
      }
      if (typeof onAfterExternalWrite === "function") {
        await onAfterExternalWrite(attemptRecord?.id, {
          writeDispatched: true,
          httpError: addErr?.message || "NETWORK_OR_TIMEOUT_ERROR",
          rawResponseCode: String(addErr?.code || "ERROR"),
          rawResponseMsg: String(addErr?.message || ""),
          seatAlias: cand.seat_name,
          regionAlias: regionName,
          startFull,
          endFull
        });
      }
      const stillAuthedOnCatch = typeof isStillAuthorized === "function" ? isStillAuthorized() : true;
      if (!stillAuthedOnCatch) {
        return {
          action: "RETURN_FINAL",
          result: {
            outcome: "TIMEOUT_AMBIGUOUS",
            writeDispatched: true,
            revokedDuringFlight: true,
            attemptId: attemptRecord?.id || null,
            seatAlias: cand.seat_name,
            regionAlias: regionName,
            startFull,
            endFull,
            errorCode: "BOOKING_RESULT_UNKNOWN",
            diagnosticMessage: "委托已停止，但已发出的选座请求响应超时，结果待核对",
            rawToken
          }
        };
      }
      // Ambiguous write failure: verify via readback once, and ALWAYS stop retrying if not confirmed!
      const rb = await verifyReadback(cand, null);
      if (rb.status === "MATCHED" && rb.matched) {
        return {
          action: "RETURN_FINAL",
          result: {
            outcome: "SUBMITTED",
            writeDispatched: true,
            attemptId: attemptRecord?.id || null,
            externalBookingId: rb.matched.bookingId,
            seatAlias: rb.matched.seatName || cand.seat_name,
            regionAlias: rb.matched.regionName || regionName,
            startFull,
            endFull,
            rawToken
          }
        };
      }
      return {
        action: "RETURN_FINAL",
        result: {
          outcome: "TIMEOUT_AMBIGUOUS",
          writeDispatched: true,
          attemptId: attemptRecord?.id || null,
          seatAlias: cand.seat_name,
          regionAlias: regionName,
          startFull,
          endFull,
          errorCode: "BOOKING_RESULT_UNKNOWN",
          diagnosticMessage:
            "选座写入请求响应异常且未能确认目标预约状态，已停止重试以防止重复预约",
          rawToken
        }
      };
    }

    const bookedIdFromAdd = addRes?.bookingid ? String(addRes.bookingid) : null;
    const rawErrText = String(addRes?.raw_msg || addRes?.msg || "").trim();
    const translated = translateWslibDiagnosticMessage(rawErrText);
    if (typeof onAfterExternalWrite === "function") {
      await onAfterExternalWrite(attemptRecord?.id, {
        writeDispatched: true,
        rawResponseCode: addRes && typeof addRes.code !== "undefined" ? String(addRes.code) : "UNKNOWN",
        rawResponseMsg: translated || rawErrText || "",
        externalBookingId: bookedIdFromAdd,
        seatAlias: cand.seat_name,
        regionAlias: regionName,
        startFull,
        endFull
      });
    }

    const stillAuthedAfterAdd = typeof isStillAuthorized === "function" ? isStillAuthorized() : true;
    if (!stillAuthedAfterAdd) {
      if (addRes && addRes.code === 200) {
        if (bookedIdFromAdd) {
          return {
            action: "RETURN_FINAL",
            result: {
              outcome: "SUBMITTED",
              writeDispatched: true,
              revokedDuringFlight: true,
              attemptId: attemptRecord?.id || null,
              externalBookingId: bookedIdFromAdd,
              seatAlias: cand.seat_name,
              regionAlias: regionName,
              startFull,
              endFull,
              rawToken
            }
          };
        }
        return {
          action: "RETURN_FINAL",
          result: {
            outcome: "TIMEOUT_AMBIGUOUS",
            writeDispatched: true,
            revokedDuringFlight: true,
            attemptId: attemptRecord?.id || null,
            seatAlias: cand.seat_name,
            regionAlias: regionName,
            startFull,
            endFull,
            errorCode: "BOOKING_RESULT_UNKNOWN",
            diagnosticMessage: "委托已停止，学校选座返回成功但缺少预约编号，结果待核对",
            rawToken
          }
        };
      }
      if (
        !addRes ||
        typeof addRes.code !== "number" ||
        isWslibAlreadyBookedMessage(rawErrText) ||
        isWslibAlreadyBookedMessage(translated)
      ) {
        return {
          action: "RETURN_FINAL",
          result: {
            outcome: "TIMEOUT_AMBIGUOUS",
            writeDispatched: true,
            revokedDuringFlight: true,
            attemptId: attemptRecord?.id || null,
            seatAlias: cand.seat_name,
            regionAlias: regionName,
            startFull,
            endFull,
            errorCode: "BOOKING_RESULT_UNKNOWN",
            diagnosticMessage: "委托已停止，已发出的选座请求响应待核对",
            rawToken
          }
        };
      }
      return {
        action: "RETURN_FINAL",
        result: {
          outcome: "FAILED",
          writeDispatched: true,
          revokedDuringFlight: true,
          attemptId: attemptRecord?.id || null,
          errorCode: "SCHOOL_REJECTED",
          diagnosticMessage: translated || rawErrText || "委托已停止且当次选座未成功",
          rawToken
        }
      };
    }

    if (!addRes || typeof addRes.code !== "number") {
      const rb = await verifyReadback(cand, null);
      if (rb.status === "MATCHED" && rb.matched) {
        return {
          action: "RETURN_FINAL",
          result: {
            outcome: "SUBMITTED",
            writeDispatched: true,
            attemptId: attemptRecord?.id || null,
            externalBookingId: rb.matched.bookingId,
            seatAlias: rb.matched.seatName || cand.seat_name,
            regionAlias: rb.matched.regionName || regionName,
            startFull,
            endFull,
            rawToken
          }
        };
      }
      return {
        action: "RETURN_FINAL",
        result: {
          outcome: "TIMEOUT_AMBIGUOUS",
          writeDispatched: true,
          attemptId: attemptRecord?.id || null,
          seatAlias: cand.seat_name,
          regionAlias: regionName,
          startFull,
          endFull,
          errorCode: "BOOKING_RESULT_UNKNOWN",
          diagnosticMessage: "选座响应报文格式未知，已停止重试以防止重复预约",
          rawToken
        }
      };
    }

    if (addRes.code === 200) {
      const bookedId = bookedIdFromAdd;
      const rb = await verifyReadback(cand, bookedId);
      if (rb.status === "MATCHED" && rb.matched) {
        return {
          action: "RETURN_FINAL",
          result: {
            outcome: "SUBMITTED",
            writeDispatched: true,
            attemptId: attemptRecord?.id || null,
            externalBookingId: rb.matched.bookingId,
            seatAlias: rb.matched.seatName || cand.seat_name,
            regionAlias: rb.matched.regionName || regionName,
            startFull,
            endFull,
            rawToken
          }
        };
      }
      if (rb.status === "UNRELATED_FOUND" && rb.unrelated) {
        return {
          action: "RETURN_FINAL",
          result: {
            outcome: "FAILED",
            writeDispatched: true,
            attemptId: attemptRecord?.id || null,
            errorCode: "SCHOOL_REJECTED",
            diagnosticMessage: `回查到的预约（${rb.unrelated.seatName || rb.unrelated.bookingId}）与目标候选座位或日期不匹配`,
            rawToken
          }
        };
      }
      return {
        action: "RETURN_FINAL",
        result: {
          outcome: "TIMEOUT_AMBIGUOUS",
          writeDispatched: true,
          attemptId: attemptRecord?.id || null,
          externalBookingId: bookedId,
          seatAlias: cand.seat_name,
          regionAlias: regionName,
          startFull,
          endFull,
          errorCode: "BOOKING_RESULT_UNKNOWN",
          diagnosticMessage: "选座请求已受理但回查未能核实目标座位与日期，已停止重试",
          rawToken
        }
      };
    }

    if (
      isWslibSeatOccupiedByOthersMessage(rawErrText, addRes.code) ||
      isWslibSeatOccupiedByOthersMessage(translated, addRes.code)
    ) {
      return { action: "SEAT_OCCUPIED_BY_OTHERS", lastMsg: translated || rawErrText };
    }

    if (isWslibNotYetOpenMessage(rawErrText) || isWslibNotYetOpenMessage(translated)) {
      return { action: "NOT_YET_OPEN", lastMsg: translated || rawErrText };
    }

    if (
      isWslibSeatLockedMessage(rawErrText, addRes.code) ||
      isWslibSeatLockedMessage(translated, addRes.code)
    ) {
      return { action: "SEAT_LOCKED", lastMsg: translated || rawErrText };
    }

    if (isWslibAlreadyBookedMessage(rawErrText) || isWslibAlreadyBookedMessage(translated)) {
      const rb = await verifyReadback(null, null);
      if (rb.status === "MATCHED" && rb.matched) {
        return {
          action: "RETURN_FINAL",
          result: {
            outcome: "SUBMITTED",
            writeDispatched: true,
            attemptId: attemptRecord?.id || null,
            externalBookingId: rb.matched.bookingId,
            seatAlias: rb.matched.seatName,
            regionAlias: rb.matched.regionName || regionName,
            startFull,
            endFull,
            rawToken
          }
        };
      }
      if (rb.status === "UNRELATED_FOUND" && rb.unrelated) {
        return {
          action: "RETURN_FINAL",
          result: {
            outcome: "FAILED",
            writeDispatched: true,
            attemptId: attemptRecord?.id || null,
            errorCode: "SCHOOL_REJECTED",
            diagnosticMessage: `当前账号已有其他非目标预约（${rb.unrelated.seatName || rb.unrelated.bookingId}），已停止抢座`,
            rawToken
          }
        };
      }
      return {
        action: "RETURN_FINAL",
        result: {
          outcome: "TIMEOUT_AMBIGUOUS",
          writeDispatched: true,
          attemptId: attemptRecord?.id || null,
          errorCode: "BOOKING_RESULT_UNKNOWN",
          diagnosticMessage: "学校提示已有预约但回查未能核实目标座位与日期，已停止重试",
          rawToken
        }
      };
    }

    // Any other unrecognized error response after a write attempt: verify via readback and stop retrying!
    const rb = await verifyReadback(cand, null);
    if (rb.status === "MATCHED" && rb.matched) {
      return {
        action: "RETURN_FINAL",
        result: {
          outcome: "SUBMITTED",
          writeDispatched: true,
          attemptId: attemptRecord?.id || null,
          externalBookingId: rb.matched.bookingId,
          seatAlias: rb.matched.seatName || cand.seat_name,
          regionAlias: rb.matched.regionName || regionName,
          rawToken
        }
      };
    }
    return {
      action: "RETURN_FINAL",
      result: {
        outcome: "TIMEOUT_AMBIGUOUS",
        writeDispatched: true,
        attemptId: attemptRecord?.id || null,
        errorCode: "BOOKING_RESULT_UNKNOWN",
        diagnosticMessage: translated || rawErrText || "选座结果未知，已停止重试",
        rawToken
      }
    };
  }

  async cancelLiveSeatBooking({ decryptedSecret, binding, externalBookingId }) {
    const targetBookingId = externalBookingId ? String(externalBookingId).trim() : "";
    if (!targetBookingId) {
      return {
        cancelled: false,
        outcome: "MISSING_EXACT_BOOKING_ID",
        school_cancellation_state: "MANUAL_ACTION_REQUIRED",
        message: "缺少精确关联的学校预约 ID，拒绝盲目取消当前账号下的其他预约"
      };
    }

    if (this.mockBackend && typeof this.mockBackend.handleCancelReservation === "function") {
      return this.mockBackend.handleCancelReservation({ binding, externalBookingId: targetBookingId });
    }
    if (targetBookingId.startsWith("haut_mock_")) {
      return {
        cancelled: true,
        outcome: "SCHOOL_CANCELLED",
        school_cancellation_state: "SCHOOL_CANCELLED",
        bookingId: targetBookingId,
        message: "已确认取消学校图书馆座位预约并释放座位"
      };
    }

    const credBundle = this.parseCredentialBundle(decryptedSecret, binding);
    let rawToken = credBundle.raw_token;
    if (!rawToken) {
      const auth = await this.authenticateHautSession(credBundle, binding);
      rawToken = auth.rawToken;
    }

    let cancelJson = null;
    let cancelHttpFailed = false;
    try {
      cancelJson = await this.wslibGetJson(
        `/seatbook/user/cancel?bookingid=${encodeURIComponent(targetBookingId)}&channelType=1003`,
        rawToken
      );
    } catch {
      cancelHttpFailed = true;
    }

    let signOffJson = null;
    if (cancelHttpFailed || cancelJson?.code !== 200) {
      signOffJson = await this.wslibGetJson(
        `/seatbook/user/signoff?bookingid=${encodeURIComponent(targetBookingId)}`,
        rawToken
      ).catch(() => null);
      if (signOffJson?.code === 200) {
        cancelJson = signOffJson;
        cancelHttpFailed = false;
      }
    }

    const cancelApiSucceeded = Boolean(!cancelHttpFailed && cancelJson && cancelJson.code === 200);

    // Authoritative verification by exact targetBookingId:
    // 1) Require complete active booking list (both crrentbooking and non-truncated mybookingInProgress)
    // 2) Query booking history/status for exact targetBookingId; if cancel & signoff both failed,
    //    NEVER report SCHOOL_CANCELLED merely because targetBookingId was absent from activeList!
    try {
      const activeList = await this.fetchActiveBookings(rawToken, { requireCompleteList: true });
      const stillActive = activeList.some((b) => String(b.bookingId) === targetBookingId);
      if (stillActive) {
        return {
          cancelled: false,
          outcome: "CANCEL_RESULT_UNKNOWN",
          school_cancellation_state: "CANCEL_RESULT_UNKNOWN",
          bookingId: targetBookingId,
          message: cancelJson?.msg || "回查显示该预约号仍处于生效状态，退座结果待核对"
        };
      }

      // Check exact booking record status in mybookingInProgress / bookinglist if available
      let exactRecordCancelled = false;
      const historyJson = await this.wslibGetJson(
        "/seatbook/user/my/bookinglist?pageSize=20&pageNum=1",
        rawToken
      ).catch(() => null);
      if (historyJson && historyJson.code === 200 && Array.isArray(historyJson.rows)) {
        const matchedRow = historyJson.rows.find((r) => r && String(r.id) === targetBookingId);
        if (matchedRow) {
          const st = String(matchedRow.bookingStatus ?? "").trim();
          const stName = String(matchedRow.bookingStatusName || matchedRow.statusName || "").trim();
          if (["1", "2", "3", "4"].includes(st)) {
            return {
              cancelled: false,
              outcome: "CANCEL_RESULT_UNKNOWN",
              school_cancellation_state: "CANCEL_RESULT_UNKNOWN",
              bookingId: targetBookingId,
              message: "预约记录表显示该预约号仍处于生效状态，退座结果待核对"
            };
          }
          if (["5", "6", "7", "8", "9"].includes(st) || /取消|签退|释放|结束/.test(stName)) {
            exactRecordCancelled = true;
          }
        }
      }

      if (!cancelApiSucceeded && !exactRecordCancelled) {
        return {
          cancelled: false,
          outcome: "CANCEL_RESULT_UNKNOWN",
          school_cancellation_state: "CANCEL_RESULT_UNKNOWN",
          bookingId: targetBookingId,
          message:
            cancelJson?.msg ||
            signOffJson?.msg ||
            "取消与签退接口均未确认成功，且未能按预约号核实取消状态，退座结果待核对"
        };
      }

      return {
        cancelled: true,
        outcome: "SCHOOL_CANCELLED",
        school_cancellation_state: "SCHOOL_CANCELLED",
        bookingId: targetBookingId,
        message: cancelJson?.msg || "已通过学校权威回查确认该笔预约已取消并释放座位"
      };
    } catch {
      return {
        cancelled: false,
        outcome: "CANCEL_RESULT_UNKNOWN",
        school_cancellation_state: "CANCEL_RESULT_UNKNOWN",
        bookingId: targetBookingId,
        message: "取消核验列表不完整或回查超时，退座结果待核对"
      };
    }
  }

  async prewarmJobTargetSeats({ job, plan, binding, decryptedSecret }) {
    const credBundle = this.parseCredentialBundle(decryptedSecret, binding);
    if (!credBundle.isLiveCredential) return null;
    // Force a fresh token verification or CAS login during prewarm
    let auth;
    try {
      auth = await this.authenticateHautSession(credBundle, binding);
    } catch {
      auth = await this.authenticateHautSession({ ...credBundle, raw_token: "" }, binding);
    }
    const rawToken = auth.rawToken;
    const targetDate = job.booking_local_date;
    const preferredArea =
      plan?.area_name ||
      plan?.preferences_json?.preferred_area_ids?.[0] ||
      plan?.area_code ||
      "四层东书库南区";
    const wantedSeats = (
      plan?.candidate_seats ||
      plan?.preferences_json?.preferred_seat_ids ||
      []
    ).map((s) => String(s).trim());

    const regSnap = await this.fetchLiveStudyRegions(rawToken, targetDate);
    const allRegions = regSnap.regions || [];
    if (allRegions.length === 0) {
      return { auth, prewarmed: null };
    }

    const cleanWantedArea = String(preferredArea)
      .replace(/^[1-9]F_[A-Z]+$/i, "")
      .trim();
    const matchedRegions = allRegions.filter(
      (r) =>
        String(r.id) === cleanWantedArea ||
        r.region_name === cleanWantedArea ||
        r.region_name.includes(cleanWantedArea) ||
        cleanWantedArea.includes(r.region_name)
    );
    const primaryRegion = matchedRegions[0] || allRegions[0];
    const seatSnap = await this.fetchLiveRegionSeats(rawToken, primaryRegion.id, targetDate);
    const allSeatsInRegion = seatSnap.seats || [];

    const matchedCandidateSeats = [];
    for (const wanted of wantedSeats) {
      const cleanWanted = wanted.replace(/号座?$/, "").trim();
      const found = allSeatsInRegion.find(
        (s) =>
          s.seat_name === cleanWanted ||
          s.short_name === cleanWanted ||
          s.seat_name.endsWith(cleanWanted) ||
          s.short_name.endsWith(cleanWanted) ||
          String(s.id) === cleanWanted
      );
      if (found && !matchedCandidateSeats.some((c) => c.id === found.id)) {
        matchedCandidateSeats.push({
          id: found.id,
          seat_name: found.seat_name,
          short_name: found.short_name
        });
      }
    }

    if (matchedCandidateSeats.length === 0) {
      return { auth, prewarmed: null };
    }

    const openTime = cleanSpiText(primaryRegion.open_time, "07:30") || "07:30";
    const closeTime = cleanSpiText(primaryRegion.close_time, "22:00") || "22:00";
    const openFull = `${targetDate} ${openTime.split(":").length === 2 ? `${openTime}:00` : openTime}`;
    const closeFull = `${targetDate} ${closeTime.split(":").length === 2 ? `${closeTime}:00` : closeTime}`;
    const resolvedPrewarmWin = resolvePlanTimeWindow(targetDate, plan, openFull, closeFull);
    const nowPrewarmMs = Date.now();

    const prewarmed = {
      binding_id: binding.id,
      student_no: String(binding.student_no || "").trim(),
      auth_version: Number(job.auth_version ?? plan?.auth_version ?? binding.auth_version ?? 1),
      plan_generation: Number(plan?.generation ?? job.generation ?? 1),
      target_local_date: targetDate,
      slot_window: resolvedPrewarmWin.slotWindow || null,
      region_id: primaryRegion.id,
      region_name: primaryRegion.region_name,
      open_time: openTime,
      close_time: closeTime,
      start_full: resolvedPrewarmWin.startFull,
      end_full: resolvedPrewarmWin.endFull,
      candidate_seats: matchedCandidateSeats,
      prewarmed_at: new Date(nowPrewarmMs).toISOString(),
      expires_at: new Date(nowPrewarmMs + 45 * 60 * 1000).toISOString()
    };
    return { auth, prewarmed };
  }

  async executeMockOrAuthorizedCreate({
    job,
    plan,
    binding,
    schoolIntegration,
    decryptedSecret = null,
    nowInstant,
    allowDateFallbackToToday = false,
    assertStillAuthorized = null,
    isStillAuthorized = null,
    onBeforeExternalWrite = null,
    onAfterExternalWrite = null
  }) {
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

    if (typeof assertStillAuthorized === "function") {
      assertStillAuthorized();
    }
    if (this.mockBackend) {
      let attemptRecord = null;
      if (typeof onBeforeExternalWrite === "function") {
        attemptRecord = await onBeforeExternalWrite({
          cand: { id: "mock_seat", seat_name: plan.preferences_json?.preferred_seat_ids?.[0] || "N4-088" },
          targetDate: job.booking_local_date,
          startFull: `${job.booking_local_date} 08:00:00`,
          endFull: `${job.booking_local_date} 22:00:00`,
          slotWindow: plan.slot_window || "08:00-22:00",
          regionId: 7,
          regionName: plan.preferences_json?.preferred_area_ids?.[0] || "北四楼自习区"
        });
      }
      const mockRes = await this.mockBackend.handleCreateReservation({ job, plan, binding, nowInstant });
      if (typeof onAfterExternalWrite === "function") {
        await onAfterExternalWrite(attemptRecord?.id, {
          writeDispatched: true,
          rawResponseCode: mockRes?.outcome === "SUBMITTED" ? "200" : String(mockRes?.errorCode || "MOCK"),
          rawResponseMsg: String(mockRes?.diagnosticMessage || mockRes?.outcome || ""),
          externalBookingId: mockRes?.externalBookingId || null,
          seatAlias: mockRes?.seatAlias || null,
          regionAlias: mockRes?.regionAlias || null
        });
      }
      const stillAuthedAfterMock = typeof isStillAuthorized === "function" ? isStillAuthorized() : true;
      return {
        ...mockRes,
        writeDispatched: true,
        revokedDuringFlight: !stillAuthedAfterMock,
        attemptId: attemptRecord?.id || null
      };
    }

    const credBundle = this.parseCredentialBundle(decryptedSecret, binding);
    if (credBundle.isLiveCredential) {
      let rawToken = credBundle.raw_token;
      if (!rawToken) {
        const auth = await this.authenticateHautSession(credBundle, binding);
        rawToken = auth.rawToken;
      }

      const shanghaiToday = formatLocalDateInShanghai(nowInstant);
      const datesToTry =
        allowDateFallbackToToday && job.booking_local_date !== shanghaiToday
          ? [job.booking_local_date, shanghaiToday]
          : [job.booking_local_date];

      const preferredArea =
        plan.area_name ||
        plan.preferences_json?.preferred_area_ids?.[0] ||
        plan.area_code ||
        "四层东书库南区";
      const wantedSeats = (
        plan.candidate_seats ||
        plan.preferences_json?.preferred_seat_ids ||
        []
      )
        .map((s) => String(s).trim())
        .filter(Boolean);
      const rawPrewarmed = job.prewarmed_targets;
      const nowEpochMs = nowInstant instanceof Date ? nowInstant.getTime() : Date.now();
      const isPrewarmedValid = Boolean(
        rawPrewarmed &&
          Array.isArray(rawPrewarmed.candidate_seats) &&
          rawPrewarmed.candidate_seats.length > 0 &&
          (!rawPrewarmed.binding_id || rawPrewarmed.binding_id === binding.id) &&
          (!rawPrewarmed.student_no ||
            !binding.student_no ||
            String(rawPrewarmed.student_no).trim() === String(binding.student_no).trim()) &&
          (!rawPrewarmed.auth_version ||
            Number(rawPrewarmed.auth_version) ===
              Number(job.auth_version ?? plan?.auth_version ?? binding.auth_version ?? 1)) &&
          (!rawPrewarmed.plan_generation ||
            Number(rawPrewarmed.plan_generation) === Number(plan?.generation ?? job.generation ?? 1)) &&
          (!rawPrewarmed.target_local_date || rawPrewarmed.target_local_date === datesToTry[0]) &&
          (!rawPrewarmed.expires_at || Date.parse(rawPrewarmed.expires_at) >= nowEpochMs)
      );
      const prewarmed = isPrewarmedValid ? rawPrewarmed : null;
      const hasExplicitCandidateSeats =
        wantedSeats.length > 0 ||
        (Array.isArray(prewarmed?.candidate_seats) && prewarmed.candidate_seats.length > 0);
      const allowAlt =
        !hasExplicitCandidateSeats && plan.preferences_json?.allow_alternative_seat === true;

      let lastMsg = "";
      const isMorningOpeningWindow = fireLocalTime >= "07:00:00" && fireLocalTime < "07:25:00";
      const isExactOpeningBurst = fireLocalTime >= "07:00:00" && fireLocalTime <= "07:00:03";

      // Wave 0 Ultra-Fast Path: if prewarmed candidate seat IDs exist and pass scope/TTL validation,
      // use read-only gate check and submit strictly in candidate order; stop immediately on any unknown write result or readback failure.
      if (
        prewarmed &&
        Array.isArray(prewarmed.candidate_seats) &&
        prewarmed.candidate_seats.length > 0 &&
        prewarmed.start_full &&
        prewarmed.end_full &&
        (isMorningOpeningWindow || prewarmed.start_full.startsWith(datesToTry[0]))
      ) {
        if (isExactOpeningBurst && prewarmed.region_id) {
          for (let probeIdx = 0; probeIdx < 12; probeIdx++) {
            if (probeIdx > 0) {
              await new Promise((resolve) => setTimeout(resolve, 110));
            }
            const probeRes = await this.wslibGetJson(
              `/seatbook/layout/query?starttime=${encodeURIComponent(
                prewarmed.start_full
              )}&endtime=${encodeURIComponent(
                prewarmed.end_full
              )}&regionid=${encodeURIComponent(prewarmed.region_id)}`,
              rawToken
            ).catch(() => null);
            if (!probeRes) break;
            const probeRawMsg = String(probeRes?.raw_msg || probeRes?.msg || "").trim();
            const probeMsg = translateWslibDiagnosticMessage(probeRawMsg);
            if (!isWslibNotYetOpenMessage(probeRawMsg) && !isWslibNotYetOpenMessage(probeMsg)) {
              break;
            }
          }
        }

        const targetDateForPrewarmed =
          String(prewarmed.start_full).slice(0, 10) || job.booking_local_date;
        const wave0Win = resolvePlanTimeWindow(
          targetDateForPrewarmed,
          plan,
          prewarmed.start_full,
          prewarmed.end_full
        );
        const seatLockedUntilMs = new Map();
        const permanentlyOccupiedIds = new Set();
        const fastWaveDelaysMs = [
          0, 180, 220, 250, 280, 320, 380, 450, 520, 600, 700, 800, 900, 1000, 1000, 1000
        ];
        for (let fastAttempt = 0; fastAttempt < fastWaveDelaysMs.length; fastAttempt++) {
          if (fastAttempt > 0) {
            const nowMs = Date.now();
            const unlockedRemaining = prewarmed.candidate_seats.filter(
              (c) => !permanentlyOccupiedIds.has(c.id) && (seatLockedUntilMs.get(c.id) || 0) <= nowMs
            );
            let waitMs = fastWaveDelaysMs[fastAttempt];
            if (unlockedRemaining.length === 0) {
              const lockDeadlines = prewarmed.candidate_seats
                .filter((c) => !permanentlyOccupiedIds.has(c.id))
                .map((c) => seatLockedUntilMs.get(c.id) || 0)
                .filter((t) => t > nowMs);
              if (lockDeadlines.length > 0) {
                const earliestUnlock = Math.min(...lockDeadlines);
                waitMs = Math.min(Math.max(earliestUnlock - nowMs + 40, 150), 1200);
              }
            }
            if (waitMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
          }

          if (typeof assertStillAuthorized === "function") assertStillAuthorized();
          let needWaitOpening = false;
          let hasLockedCandidate = false;
          for (const cand of prewarmed.candidate_seats) {
            if (permanentlyOccupiedIds.has(cand.id)) {
              continue;
            }
            if ((seatLockedUntilMs.get(cand.id) || 0) > Date.now()) {
              // Strictly preserve candidate preference order: if the highest-priority remaining seat is in a temporary
              // Redis lock (NOT permanently occupied by others), wait for it to unlock instead of skipping to cand[1]!
              hasLockedCandidate = true;
              break;
            }
            let step;
            try {
              step = await this.submitCandidateSeatAndVerify({
                cand,
                startFull: wave0Win.startFull,
                endFull: wave0Win.endFull,
                expectedSlotWindow: wave0Win.slotWindow,
                targetDate: targetDateForPrewarmed,
                regionId: prewarmed.region_id,
                regionName: prewarmed.region_name || preferredArea,
                candidateSeats: prewarmed.candidate_seats,
                wantedSeats,
                rawToken,
                assertStillAuthorized,
                isStillAuthorized,
                onBeforeExternalWrite,
                onAfterExternalWrite
              });
            } catch (w0Err) {
              if (w0Err?.code === "SCHOOL_AUTH_EXPIRED") {
                const freshAuth = await this.authenticateHautSession(
                  { ...credBundle, raw_token: "" },
                  binding
                );
                rawToken = freshAuth.rawToken;
                step = await this.submitCandidateSeatAndVerify({
                  cand,
                  startFull: wave0Win.startFull,
                  endFull: wave0Win.endFull,
                  expectedSlotWindow: wave0Win.slotWindow,
                  targetDate: targetDateForPrewarmed,
                  regionId: prewarmed.region_id,
                  regionName: prewarmed.region_name || preferredArea,
                  candidateSeats: prewarmed.candidate_seats,
                  wantedSeats,
                  rawToken,
                  assertStillAuthorized,
                  isStillAuthorized,
                  onBeforeExternalWrite,
                  onAfterExternalWrite
                });
              } else {
                throw w0Err;
              }
            }
            if (step.action === "RETURN_FINAL") {
              return step.result;
            }
            if (step.lastMsg) {
              lastMsg = step.lastMsg;
            }
            if (step.action === "SEAT_OCCUPIED_BY_OTHERS") {
              permanentlyOccupiedIds.add(cand.id);
              continue;
            }
            if (step.action === "NOT_YET_OPEN") {
              seatLockedUntilMs.set(cand.id, Date.now() + 3050);
              needWaitOpening = true;
              break;
            }
            if (step.action === "SEAT_LOCKED") {
              if ((seatLockedUntilMs.get(cand.id) || 0) <= Date.now()) {
                seatLockedUntilMs.set(cand.id, Date.now() + 1050);
              }
              hasLockedCandidate = true;
              break;
            }
          }
          if (permanentlyOccupiedIds.size >= prewarmed.candidate_seats.length) {
            break;
          }
          if (!needWaitOpening && !hasLockedCandidate) {
            break;
          }
        }
      }

      // Check if user already has an active seat booking before full discovery waves;
      // strictly verify target date, region, and candidate seat before treating as SUBMITTED.
      try {
        const existingBookings = await this.fetchActiveBookings(rawToken);
        const preWaveWin = resolvePlanTimeWindow(
          datesToTry[0],
          plan,
          prewarmed?.start_full || null,
          prewarmed?.end_full || null
        );
        const matchingExisting = existingBookings.find((b) =>
          isBookingMatchingTarget(b, {
            targetDates: datesToTry,
            expectedStartFull: preWaveWin.startFull,
            expectedEndFull: preWaveWin.endFull,
            expectedSlotWindow: preWaveWin.slotWindow,
            regionId: prewarmed?.region_id ?? null,
            regionName: prewarmed?.region_name || preferredArea,
            candidateSeats: prewarmed?.candidate_seats || [],
            wantedSeatNames: wantedSeats
          })
        );
        if (matchingExisting) {
          return {
            outcome: "SUBMITTED",
            externalBookingId: matchingExisting.bookingId,
            seatAlias: matchingExisting.seatName,
            regionAlias: matchingExisting.regionName,
            rawToken
          };
        }
        const sameDayUnrelated = existingBookings.find((b) => {
          const startStr = String(b.startDate || b.endDate || "").trim();
          return datesToTry.some((d) => startStr.startsWith(d));
        });
        if (sameDayUnrelated) {
          return {
            outcome: "FAILED",
            errorCode: "SCHOOL_REJECTED",
            diagnosticMessage: `当前账号今日已有其他非目标预约（${sameDayUnrelated.seatName || sameDayUnrelated.bookingId}），已停止抢座`
          };
        }
      } catch (err) {
        if (err?.code === "SCHOOL_AUTH_EXPIRED") {
          const freshAuth = await this.authenticateHautSession(
            { ...credBundle, raw_token: "" },
            binding
          );
          rawToken = freshAuth.rawToken;
        }
      }

      const seatLockedInWave = new Map();
      const permanentlyOccupiedInWave = new Set();
      const waveDelaysMs = [0, 300, 600, 900, 1300, 1800, 2400];
      for (let wave = 0; wave < waveDelaysMs.length; wave++) {
        if (waveDelaysMs[wave] > 0) {
          await new Promise((resolve) => setTimeout(resolve, waveDelaysMs[wave]));
        }
        let needWaitOpeningWave = false;
        let hasLockedWave = false;
        try {
          for (const targetDate of datesToTry) {
            const regSnap = await this.fetchLiveStudyRegions(rawToken, targetDate);
            const allRegions = regSnap.regions || [];
            if (allRegions.length === 0) continue;

            const cleanWantedArea = String(preferredArea)
              .replace(/^[1-9]F_[A-Z]+$/i, "")
              .trim();
            let matchedRegions = allRegions.filter(
              (r) =>
                String(r.id) === cleanWantedArea ||
                r.region_name === cleanWantedArea ||
                r.region_name.includes(cleanWantedArea) ||
                cleanWantedArea.includes(r.region_name)
            );
            if (matchedRegions.length === 0 && !hasExplicitCandidateSeats) {
              const floorHint = cleanWantedArea.match(/(一|二|三|四|五|六|七|八|九|十|[1-9])/)?.[1];
              const floorMap = {
                "1": "一层",
                "2": "二层",
                "3": "三层",
                "4": "四层",
                "5": "五层",
                "6": "六层",
                "7": "七层",
                "8": "八层",
                "9": "九层"
              };
              const floorCn = floorMap[floorHint] || (floorHint ? `${floorHint}层` : "");
              if (floorCn) {
                matchedRegions = allRegions.filter(
                  (r) => r.region_name.includes(floorCn) && r.available_seats > 0
                );
              }
            }
            if (allowAlt) {
              const otherAvailRegions = allRegions.filter(
                (r) => r.available_seats > 0 && !matchedRegions.some((m) => m.id === r.id)
              );
              matchedRegions = [...matchedRegions, ...otherAvailRegions.slice(0, 2)];
            }

            for (const region of matchedRegions.slice(0, 3)) {
              const seatSnap = await this.fetchLiveRegionSeats(rawToken, region.id, targetDate);
              const allRegionSeats = seatSnap.seats || [];
              if (allRegionSeats.length === 0) continue;

              const orderedCandidates = [];
              for (const wanted of wantedSeats) {
                const cleanWanted = wanted.replace(/号座?$/, "").trim();
                const found = allRegionSeats.find(
                  (s) =>
                    s.seat_name === cleanWanted ||
                    s.short_name === cleanWanted ||
                    normalizeSeatComparisonToken(s.seat_name, region.region_name) ===
                      normalizeSeatComparisonToken(cleanWanted, region.region_name) ||
                    String(s.id) === cleanWanted
                );
                if (found && !orderedCandidates.some((c) => c.id === found.id)) {
                  orderedCandidates.push(found);
                }
              }
              if (allowAlt) {
                const availSeats = allRegionSeats.filter((s) => s.available);
                for (const altSeat of availSeats.slice(0, 5)) {
                  if (!orderedCandidates.some((c) => c.id === altSeat.id)) {
                    orderedCandidates.push(altSeat);
                  }
                }
              }

              if (typeof assertStillAuthorized === "function") assertStillAuthorized();
              for (const seat of orderedCandidates.slice(0, 5)) {
                if (permanentlyOccupiedInWave.has(seat.id)) continue;
                if ((seatLockedInWave.get(seat.id) || 0) > Date.now()) {
                  hasLockedWave = true;
                  break;
                }
                const discWin = resolvePlanTimeWindow(
                  targetDate,
                  plan,
                  seatSnap.start_full,
                  seatSnap.end_full
                );
                const step = await this.submitCandidateSeatAndVerify({
                  cand: seat,
                  startFull: discWin.startFull,
                  endFull: discWin.endFull,
                  expectedSlotWindow: discWin.slotWindow,
                  targetDate,
                  regionId: region.id,
                  regionName: region.region_name,
                  candidateSeats: orderedCandidates,
                  wantedSeats,
                  rawToken,
                  assertStillAuthorized,
                  isStillAuthorized,
                  onBeforeExternalWrite,
                  onAfterExternalWrite
                });
                if (step.action === "RETURN_FINAL") {
                  return step.result;
                }
                if (step.lastMsg) {
                  lastMsg = step.lastMsg;
                }
                if (step.action === "SEAT_OCCUPIED_BY_OTHERS") {
                  permanentlyOccupiedInWave.add(seat.id);
                  continue;
                }
                if (step.action === "NOT_YET_OPEN") {
                  seatLockedInWave.set(seat.id, Date.now() + 3050);
                  needWaitOpeningWave = true;
                  break;
                }
                if (step.action === "SEAT_LOCKED") {
                  if ((seatLockedInWave.get(seat.id) || 0) <= Date.now()) {
                    seatLockedInWave.set(seat.id, Date.now() + 1050);
                  }
                  hasLockedWave = true;
                  break;
                }
              }
            }
          }
        } catch (err) {
          if (err?.code === "CONSENT_WITHDRAWN" || err?.code === "STORAGE_PERSISTENCE_FAILED") throw err;
          if (err?.code === "SCHOOL_AUTH_EXPIRED") {
            try {
              const freshAuth = await this.authenticateHautSession(
                { ...credBundle, raw_token: "" },
                binding
              );
              rawToken = freshAuth.rawToken;
            } catch (reauthErr) {
              lastMsg = reauthErr?.message || lastMsg;
            }
          } else {
            lastMsg = err?.message || lastMsg;
          }
        }
        if (!needWaitOpeningWave && !hasLockedWave) {
          break;
        }
      }

      return {
        outcome: "FAILED",
        errorCode: "SCHOOL_REJECTED",
        diagnosticMessage:
          translateWslibDiagnosticMessage(lastMsg) || "目标自习室候选座位暂无可用或不在开放预约时段"
      };
    }

    // Default deterministic mock reservation result (safe sandbox for unit/redteam tests)
    if (typeof assertStillAuthorized === "function") {
      assertStillAuthorized();
    }
    const seatAlias = plan.preferences_json?.preferred_seat_ids?.[0] || "N4-088";
    const regionAlias = plan.preferences_json?.preferred_area_ids?.[0] || "北四楼自习区";
    const externalBookingId = `haut_mock_${job.booking_local_date}_${seatAlias}_${binding.id.slice(0, 6)}`;
    let attemptRecord = null;
    if (typeof onBeforeExternalWrite === "function") {
      attemptRecord = await onBeforeExternalWrite({
        cand: { id: seatAlias, seat_name: seatAlias },
        targetDate: job.booking_local_date,
        startFull: `${job.booking_local_date} 08:00:00`,
        endFull: `${job.booking_local_date} 22:00:00`,
        slotWindow: plan.slot_window || "08:00-22:00",
        regionId: 7,
        regionName: regionAlias
      });
    }
    if (typeof onAfterExternalWrite === "function") {
      await onAfterExternalWrite(attemptRecord?.id, {
        writeDispatched: true,
        rawResponseCode: "200",
        rawResponseMsg: "SUBMITTED",
        externalBookingId,
        seatAlias,
        regionAlias
      });
    }
    const stillAuthedSandbox = typeof isStillAuthorized === "function" ? isStillAuthorized() : true;
    return {
      outcome: "SUBMITTED",
      writeDispatched: true,
      revokedDuringFlight: !stillAuthedSandbox,
      attemptId: attemptRecord?.id || null,
      externalBookingId,
      seatAlias,
      regionAlias
    };
  }

  async verifyBookingAuthoritative({
    job,
    plan = null,
    binding,
    decryptedSecret = null,
    rawToken = null,
    expectedExternalBookingId,
    expectedSeatAlias = null,
    expectedRegionAlias = null,
    expectedStartFull = null,
    expectedEndFull = null
  }) {
    if (this.mockBackend) {
      return this.mockBackend.handleVerifyReservation({ job, binding, expectedExternalBookingId });
    }

    const credBundle = this.parseCredentialBundle(decryptedSecret, binding);
    if (credBundle.isLiveCredential && !String(expectedExternalBookingId || "").startsWith("haut_mock_")) {
      let tokenToUse = rawToken || credBundle.raw_token;
      if (!tokenToUse) {
        const auth = await this.authenticateHautSession(credBundle, binding);
        tokenToUse = auth.rawToken;
      }
      const preferredArea =
        expectedRegionAlias ||
        job?.prewarmed_targets?.region_name ||
        plan?.area_name ||
        plan?.preferences_json?.preferred_area_ids?.[0] ||
        plan?.area_code ||
        "";
      const wantedSeats = (
        plan?.candidate_seats ||
        plan?.preferences_json?.preferred_seat_ids ||
        []
      )
        .map((s) => String(s).trim())
        .filter(Boolean);
      const candidateSeats = Array.isArray(job?.prewarmed_targets?.candidate_seats)
        ? job.prewarmed_targets.candidate_seats
        : [];
      const specificSeat = expectedSeatAlias ? { seat_name: expectedSeatAlias } : null;

      let sawUnrelatedActive = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        const bookings = await this.fetchActiveBookings(tokenToUse);
        const verifyDate =
          job?.booking_local_date ||
          (expectedStartFull ? String(expectedStartFull).trim().slice(0, 10) : "");
        const verifyWin = resolvePlanTimeWindow(
          verifyDate,
          plan,
          expectedStartFull || job?.prewarmed_targets?.start_full || null,
          expectedEndFull || job?.prewarmed_targets?.end_full || null
        );
        const matched = bookings.find((b) =>
          isBookingMatchingTarget(b, {
            targetDates: job?.booking_local_date ? [job.booking_local_date] : [],
            expectedStartFull: verifyWin.startFull,
            expectedEndFull: verifyWin.endFull,
            expectedSlotWindow: verifyWin.slotWindow,
            regionId: job?.prewarmed_targets?.region_id ?? null,
            regionName: preferredArea,
            candidateSeats,
            wantedSeatNames: wantedSeats,
            specificSeat,
            expectedBookingId: expectedExternalBookingId || null
          })
        );
        if (matched && matched.bookingId) {
          const evidenceSha256 = crypto
            .createHash("sha256")
            .update(`haut_live|${binding.id}|${matched.bookingId}|${matched.seatName}|CONFIRMED`)
            .digest("hex");
          return {
            verified: true,
            externalBookingId: matched.bookingId,
            officialStatus: "CONFIRMED",
            seatAlias: matched.seatName,
            regionAlias: matched.regionName,
            startAt: matched.startDate,
            endAt: matched.endDate,
            evidenceSha256
          };
        }
        if (bookings.length > 0) {
          sawUnrelatedActive = true;
          break;
        }
      }
      if (sawUnrelatedActive) {
        return { verified: false, officialStatus: "MISMATCHED_TARGET_SEAT_OR_DATE" };
      }
      return { verified: false, officialStatus: "NOT_FOUND_ON_WSLIB" };
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

export function formatLocalDateInShanghai(dateOrIso = new Date()) {
  const d = typeof dateOrIso === "string" || typeof dateOrIso === "number" ? new Date(dateOrIso) : dateOrIso;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value || "2026";
  const m = parts.find((p) => p.type === "month")?.value || "01";
  const day = parts.find((p) => p.type === "day")?.value || "01";
  return `${y}-${m}-${day}`;
}
