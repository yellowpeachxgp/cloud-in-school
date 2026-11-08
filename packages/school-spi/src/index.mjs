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
        const studentNo = String(parsed.student_no || parsed.studentId || fallbackStudentNo).trim();
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
      } catch {
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

  async fetchCurrentActiveBooking(rawToken) {
    const curJson = await this.wslibGetJson("/seatbook/user/my/crrentbooking", rawToken);
    const data = curJson?.data || curJson?.booking || null;
    if (data && data.id && ["1", "2", "3", "4"].includes(String(data.bookingStatus))) {
      return {
        bookingId: String(data.id),
        seatId: data.seatId ? Number(data.seatId) : null,
        seatName: String(data.seatName || "").trim(),
        regionName: String(data.regionName || "").trim(),
        buildingLayerRegionId: data.buildingLayerRegionId ? Number(data.buildingLayerRegionId) : null,
        startDate: String(data.startDate || "").trim(),
        endDate: String(data.endDate || "").trim(),
        bookingStatus: Number(data.bookingStatus)
      };
    }
    const inProgJson = await this.wslibGetJson(
      "/seatbook/user/mybookingInProgress?bookingstatus=0&pageSize=15&pageNum=1",
      rawToken
    ).catch(() => null);
    const rows = inProgJson?.rows || [];
    for (const row of rows) {
      if (row && row.id && ["1", "2", "3", "4"].includes(String(row.bookingStatus))) {
        return {
          bookingId: String(row.id),
          seatId: row.seatId ? Number(row.seatId) : null,
          seatName: String(row.seatName || "").trim(),
          regionName: String(row.regionName || "").trim(),
          buildingLayerRegionId: row.buildingLayerRegionId ? Number(row.buildingLayerRegionId) : null,
          startDate: String(row.startDate || "").trim(),
          endDate: String(row.endDate || "").trim(),
          bookingStatus: Number(row.bookingStatus)
        };
      }
    }
    return null;
  }

  async cancelLiveSeatBooking({ decryptedSecret, binding, externalBookingId }) {
    const auth = await this.authenticateHautSession(decryptedSecret, binding);
    const rawToken = auth.rawToken;
    let targetBookingId =
      externalBookingId && /^\d+$/.test(String(externalBookingId).trim())
        ? String(externalBookingId).trim()
        : null;

    if (!targetBookingId) {
      const current = await this.fetchCurrentActiveBooking(rawToken);
      if (current?.bookingId) {
        targetBookingId = current.bookingId;
      }
    }
    if (!targetBookingId) {
      return {
        cancelled: true,
        alreadyReleased: true,
        message: "当前账号下无生效中的图书馆座位预约"
      };
    }

    const cancelJson = await this.wslibGetJson(
      `/seatbook/user/cancel?bookingid=${encodeURIComponent(targetBookingId)}&channelType=1003`,
      rawToken
    );
    if (cancelJson?.code === 200) {
      return {
        cancelled: true,
        bookingId: targetBookingId,
        message: cancelJson?.msg || "已成功取消学校图书馆座位预约并释放座位"
      };
    }

    // Fallback to signoff if booking window already started
    const signOffJson = await this.wslibGetJson(
      `/seatbook/user/signoff?bookingid=${encodeURIComponent(targetBookingId)}`,
      rawToken
    ).catch(() => null);
    if (signOffJson?.code === 200) {
      return {
        cancelled: true,
        bookingId: targetBookingId,
        message: "已自动通过签退释放学校图书馆座位"
      };
    }

    return {
      cancelled: false,
      bookingId: targetBookingId,
      message: cancelJson?.msg || signOffJson?.msg || "取消座位预约未成功"
    };
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

    const openTime = cleanSpiText(primaryRegion.open_time, "07:30") || "07:30";
    const closeTime = cleanSpiText(primaryRegion.close_time, "22:00") || "22:00";
    const openFull = `${targetDate} ${openTime.split(":").length === 2 ? `${openTime}:00` : openTime}`;
    const closeFull = `${targetDate} ${closeTime.split(":").length === 2 ? `${closeTime}:00` : closeTime}`;

    const prewarmed = {
      region_id: primaryRegion.id,
      region_name: primaryRegion.region_name,
      open_time: openTime,
      close_time: closeTime,
      start_full: openFull,
      end_full: closeFull,
      candidate_seats: matchedCandidateSeats,
      prewarmed_at: new Date().toISOString()
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
    allowDateFallbackToToday = false
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

    if (this.mockBackend) {
      return this.mockBackend.handleCreateReservation({ job, plan, binding, nowInstant });
    }

    const credBundle = this.parseCredentialBundle(decryptedSecret, binding);
    if (credBundle.isLiveCredential) {
      // Use cached raw_token immediately at 07:00:00 if present so Wave 0 has zero auth RTT;
      // otherwise authenticate now.
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
      ).map((s) => String(s).trim()).filter(Boolean);
      const prewarmed = job.prewarmed_targets;
      const hasExplicitCandidateSeats =
        wantedSeats.length > 0 ||
        (Array.isArray(prewarmed?.candidate_seats) && prewarmed.candidate_seats.length > 0);
      // Never silently book an unrequested random seat (e.g. 01桌 B座) when the user explicitly chose candidate seats
      const allowAlt =
        !hasExplicitCandidateSeats && plan.preferences_json?.allow_alternative_seat === true;

      let lastMsg = "";
      const isMorningOpeningWindow = fireLocalTime >= "07:00:00" && fireLocalTime < "07:25:00";
      const isExactOpeningBurst = fireLocalTime >= "07:00:00" && fireLocalTime <= "07:00:03";

      // Wave 0 Ultra-Fast Path: if prewarmed candidate seat IDs exist, protect against pre-opening 3s Redis seat lock
      // and retry only the user-selected candidate seats in strict priority order.
      if (
        prewarmed &&
        Array.isArray(prewarmed.candidate_seats) &&
        prewarmed.candidate_seats.length > 0 &&
        prewarmed.start_full &&
        prewarmed.end_full &&
        (isMorningOpeningWindow || prewarmed.start_full.startsWith(datesToTry[0]))
      ) {
        // Canary gate probe at 07:00:00..07:00:03 so a slightly lagging wslib clock never locks cand[0] for 3 seconds
        if (isExactOpeningBurst) {
          for (let probeIdx = 0; probeIdx < 12; probeIdx++) {
            if (probeIdx > 0) {
              await new Promise((resolve) => setTimeout(resolve, 110));
            }
            const canarySeatId = 999901 + probeIdx;
            const probeRes = await this.wslibGetJson(
              `/seatbook/user/addbooking?channel=1003&seatid=${canarySeatId}&starttime=${encodeURIComponent(
                prewarmed.start_full
              )}&endtime=${encodeURIComponent(prewarmed.end_full)}`,
              rawToken
            ).catch(() => null);
            const probeRawMsg = String(probeRes?.raw_msg || probeRes?.msg || "").trim();
            const probeMsg = translateWslibDiagnosticMessage(probeRawMsg);
            if (!isWslibNotYetOpenMessage(probeRawMsg) && !isWslibNotYetOpenMessage(probeMsg)) {
              break;
            }
          }
        }

        const seatLockedUntilMs = new Map();
        const permanentlyOccupiedIds = new Set();
        const fastWaveDelaysMs = [0, 180, 220, 250, 280, 320, 380, 450, 520, 600, 700, 800, 900, 1000, 1000, 1000];
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
          try {
            let needWaitOpening = false;
            let hasLockedCandidate = false;
            for (const cand of prewarmed.candidate_seats) {
              if (permanentlyOccupiedIds.has(cand.id)) {
                continue;
              }
              if ((seatLockedUntilMs.get(cand.id) || 0) > Date.now()) {
                hasLockedCandidate = true;
                continue;
              }
              const addRes = await this.wslibGetJson(
                `/seatbook/user/addbooking?channel=1003&seatid=${encodeURIComponent(
                  cand.id
                )}&starttime=${encodeURIComponent(
                  prewarmed.start_full
                )}&endtime=${encodeURIComponent(prewarmed.end_full)}`,
                rawToken
              );
              const rawErrText = String(addRes?.raw_msg || addRes?.msg || "").trim();
              lastMsg = translateWslibDiagnosticMessage(rawErrText);
              if (addRes?.code === 200) {
                const bookedId = addRes?.bookingid ? String(addRes.bookingid) : null;
                const confirmed = await this.fetchCurrentActiveBooking(rawToken);
                return {
                  outcome: "SUBMITTED",
                  externalBookingId: confirmed?.bookingId || bookedId || String(cand.id),
                  seatAlias: confirmed?.seatName || cand.seat_name,
                  regionAlias: confirmed?.regionName || prewarmed.region_name,
                  rawToken
                };
              }
              if (isWslibSeatOccupiedByOthersMessage(rawErrText, addRes?.code) || isWslibSeatOccupiedByOthersMessage(lastMsg, addRes?.code)) {
                permanentlyOccupiedIds.add(cand.id);
                continue;
              }
              if (isWslibAlreadyBookedMessage(rawErrText) || isWslibAlreadyBookedMessage(lastMsg)) {
                const existing = await this.fetchCurrentActiveBooking(rawToken);
                if (existing) {
                  return {
                    outcome: "SUBMITTED",
                    externalBookingId: existing.bookingId,
                    seatAlias: existing.seatName,
                    regionAlias: existing.regionName,
                    rawToken
                  };
                }
              }
              if (isWslibNotYetOpenMessage(rawErrText) || isWslibNotYetOpenMessage(lastMsg)) {
                // wslib places a 3.0s Redis lock on any seatid hit before opening; record it and break immediately
                // so we never domino-lock cand[1] and cand[2] while the gate is still closed!
                seatLockedUntilMs.set(cand.id, Date.now() + 3050);
                needWaitOpening = true;
                break;
              }
              if (isWslibSeatLockedMessage(rawErrText, addRes?.code) || isWslibSeatLockedMessage(lastMsg, addRes?.code)) {
                if ((seatLockedUntilMs.get(cand.id) || 0) <= Date.now()) {
                  seatLockedUntilMs.set(cand.id, Date.now() + 1050);
                }
                hasLockedCandidate = true;
                continue;
              }
            }
            if (permanentlyOccupiedIds.size >= prewarmed.candidate_seats.length) {
              break;
            }
            if (!needWaitOpening && !hasLockedCandidate) {
              break;
            }
          } catch (err) {
            if (err?.code === "SCHOOL_AUTH_EXPIRED") {
              const freshAuth = await this.authenticateHautSession(
                { ...credBundle, raw_token: "" },
                binding
              );
              rawToken = freshAuth.rawToken;
            }
            lastMsg = err?.message || lastMsg;
          }
        }
      }

      // Check if user already has an active seat booking before full discovery waves
      try {
        const existingActive = await this.fetchCurrentActiveBooking(rawToken);
        if (existingActive) {
          return {
            outcome: "SUBMITTED",
            externalBookingId: existingActive.bookingId,
            seatAlias: existingActive.seatName,
            regionAlias: existingActive.regionName,
            rawToken
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

      const waveDelaysMs = [0, 300, 600, 900, 1300, 1800, 2400];
      for (let wave = 0; wave < waveDelaysMs.length; wave++) {
        if (waveDelaysMs[wave] > 0) {
          await new Promise((resolve) => setTimeout(resolve, waveDelaysMs[wave]));
        }
        try {
          for (const targetDate of datesToTry) {
            const regSnap = await this.fetchLiveStudyRegions(rawToken, targetDate);
            const allRegions = regSnap.regions || [];
            if (allRegions.length === 0) continue;

            // Match region by name/floor, or fall back to regions with available seats
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
            if (matchedRegions.length === 0) {
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
              const availSeats = (seatSnap.seats || []).filter((s) => s.available);
              if (availSeats.length === 0) continue;

              const orderedCandidates = [];
              for (const wanted of wantedSeats) {
                const cleanWanted = wanted.replace(/号座?$/, "").trim();
                const found = availSeats.find(
                  (s) =>
                    s.seat_name === cleanWanted ||
                    s.short_name === cleanWanted ||
                    s.seat_name.endsWith(cleanWanted) ||
                    s.short_name.endsWith(cleanWanted) ||
                    String(s.id) === cleanWanted
                );
                if (found && !orderedCandidates.some((c) => c.id === found.id)) {
                  orderedCandidates.push(found);
                }
              }
              if (allowAlt) {
                for (const altSeat of availSeats.slice(0, 5)) {
                  if (!orderedCandidates.some((c) => c.id === altSeat.id)) {
                    orderedCandidates.push(altSeat);
                  }
                }
              }

              for (const seat of orderedCandidates.slice(0, 5)) {
                const addRes = await this.wslibGetJson(
                  `/seatbook/user/addbooking?channel=1003&seatid=${encodeURIComponent(
                    seat.id
                  )}&starttime=${encodeURIComponent(
                    seatSnap.start_full
                  )}&endtime=${encodeURIComponent(seatSnap.end_full)}`,
                  rawToken
                );
                lastMsg = String(addRes?.msg || "").trim();
                if (addRes?.code === 200) {
                  const bookedId = addRes?.bookingid ? String(addRes.bookingid) : null;
                  const confirmed = await this.fetchCurrentActiveBooking(rawToken);
                  return {
                    outcome: "SUBMITTED",
                    externalBookingId: confirmed?.bookingId || bookedId || String(seat.id),
                    seatAlias: confirmed?.seatName || seat.seat_name,
                    regionAlias: confirmed?.regionName || region.region_name,
                    rawToken
                  };
                }
                const rawSeatErr = String(addRes?.raw_msg || addRes?.msg || "").trim();
                lastMsg = translateWslibDiagnosticMessage(rawSeatErr);
                if (isWslibAlreadyBookedMessage(rawSeatErr) || isWslibAlreadyBookedMessage(lastMsg)) {
                  const confirmed = await this.fetchCurrentActiveBooking(rawToken);
                  if (confirmed) {
                    return {
                      outcome: "SUBMITTED",
                      externalBookingId: confirmed.bookingId,
                      seatAlias: confirmed.seatName,
                      regionAlias: confirmed.regionName,
                      rawToken
                    };
                  }
                }
                if (isWslibNotYetOpenMessage(rawSeatErr) || isWslibNotYetOpenMessage(lastMsg)) {
                  break;
                }
              }
            }
          }
        } catch (err) {
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
      }

      try {
        const finalConfirmed = await this.fetchCurrentActiveBooking(rawToken);
        if (finalConfirmed && finalConfirmed.bookingId) {
          return {
            outcome: "SUBMITTED",
            externalBookingId: finalConfirmed.bookingId,
            seatAlias: finalConfirmed.seatName,
            regionAlias: finalConfirmed.regionName,
            rawToken
          };
        }
      } catch {
        // Ignore readback error on final fallback
      }

      return {
        outcome: "FAILED",
        errorCode: "SCHOOL_REJECTED",
        diagnosticMessage: translateWslibDiagnosticMessage(lastMsg) || "目标自习室暂无可用空座或不在开放预约时段"
      };
    }

    // Default deterministic mock reservation result (safe sandbox for unit/redteam tests)
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

  async verifyBookingAuthoritative({
    job,
    binding,
    decryptedSecret = null,
    rawToken = null,
    expectedExternalBookingId
  }) {
    if (this.mockBackend) {
      return this.mockBackend.handleVerifyReservation({ job, binding, expectedExternalBookingId });
    }

    const credBundle = this.parseCredentialBundle(decryptedSecret, binding);
    if (credBundle.isLiveCredential && !String(expectedExternalBookingId || "").startsWith("haut_mock_")) {
      let tokenToUse = rawToken;
      if (!tokenToUse) {
        const auth = await this.authenticateHautSession(credBundle, binding);
        tokenToUse = auth.rawToken;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        const active = await this.fetchCurrentActiveBooking(tokenToUse);
        if (active && active.bookingId) {
          const evidenceSha256 = crypto
            .createHash("sha256")
            .update(`haut_live|${binding.id}|${active.bookingId}|${active.seatName}|CONFIRMED`)
            .digest("hex");
          return {
            verified: true,
            externalBookingId: active.bookingId,
            officialStatus: "CONFIRMED",
            seatAlias: active.seatName,
            regionAlias: active.regionName,
            startAt: active.startDate,
            endAt: active.endDate,
            evidenceSha256
          };
        }
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
