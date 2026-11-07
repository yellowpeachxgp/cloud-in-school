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
  if (/seat\.10056/i.test(text)) return "预约开始时间须大于当前时间";
  if (/seat\.10057/i.test(text)) return "只能预约1天之内的时间(含当天)";
  if (/seat\.10058/i.test(text)) return "预约时间不在自习室开放时段内";
  if (/seat\.10062/i.test(text)) return "本座位已锁定 请稍后再试!";
  if (/seat\.10079/i.test(text)) return "未到07:00开放时间或该时段内已有生效预约";
  return text;
}

export function isWslibNotYetOpenMessage(rawMsg) {
  const text = String(rawMsg || "").trim();
  return /未到|未开放|不在.*时间|只能预约|尚未开放|seat\.10057|seat\.10058|seat\.10079/i.test(text);
}

export function isWslibAlreadyBookedMessage(rawMsg) {
  const text = String(rawMsg || "").trim();
  return /已有.*预约|不能重复|已预约|只能预约一个座位|seat\.10060|seat\.10061|seat\.10079/i.test(text);
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
    const liveAuthorized = this.isLiveAuthorized(schoolIntegration);

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

  isLiveAuthorized(integration) {
    const approval = integration?.authorization_approval;
    const primary = cleanSpiText(integration?.approver_primary_ref);
    const secondary = cleanSpiText(integration?.approver_secondary_ref);
    return integration?.school_id === this.schoolId && integration?.enabled === true &&
      integration?.kill_switch === false && Boolean(cleanSpiText(integration?.authorization_evidence_ref)) &&
      Boolean(primary && secondary && primary !== secondary) &&
      Boolean(approval?.id) && approval?.status === "APPROVED" &&
      Date.parse(approval.expires_at) > Date.now() &&
      approval.evidence_ref === integration.authorization_evidence_ref &&
      approval.primary_actor_ref === primary && approval.secondary_actor_ref === secondary;
  }

  assertOperationAllowed(operation, schoolIntegration, { requireLiveAutomation = false, allowMock = false } = {}) {
    if (["SIGN_IN", "SIGN_OFF"].includes(operation)) {
      throw new ContractError("SCHOOL_PERMISSION_REQUIRED", "Automated attendance operations are prohibited");
    }
    if (["CREATE_BOOKING", "CANCEL_BOOKING"].includes(operation)) {
      if (allowMock && !requireLiveAutomation) return { executionPath: "MOCK_ONLY" };
      if (this.isLiveAuthorized(schoolIntegration)) return { executionPath: "AUTHORIZED_AUTOMATION" };
      if (requireLiveAutomation || schoolIntegration?.kill_switch === true) {
        throw new ContractError("SCHOOL_PERMISSION_REQUIRED", "Live writes require same-school authorization, distinct authenticated approvals and an explicitly disabled kill switch");
      }
    }
    return { executionPath: "MOCK_ONLY" };
  }

  assertSchoolScope(job, binding, plan = null) {
    if (job?.school_id !== this.schoolId || binding?.school_id !== this.schoolId ||
        (plan && plan.school_id !== this.schoolId) ||
        (job.school_binding_id && job.school_binding_id !== binding.id)) {
      throw new ContractError("FORBIDDEN", "Cross-school or binding provider mismatch");
    }
  }

  matchesAttempt(active, target, expectedId = null) {
    return Boolean(expectedId && active?.bookingId && target?.seat_id && target?.binding_id &&
      target.school_id === this.schoolId &&
      String(active.bookingId) === String(expectedId) &&
      [1, 2, 3, 4].includes(Number(active.bookingStatus)) &&
      String(active.seatId) === String(target.seat_id) &&
      String(active.startDate).replace("T", " ") === target.start_full &&
      String(active.endDate).replace("T", " ") === target.end_full &&
      target.start_full.slice(0, 10) === target.booking_local_date &&
      target.end_full.slice(0, 10) === target.booking_local_date);
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

  async fetchCurrentActiveBooking(rawToken, { expectedBookingId = null } = {}) {
    const inconclusive = () => new ContractError("BOOKING_VERIFICATION_PENDING", "Authoritative school booking read is inconclusive");
    const normalize = (data) => {
      if (!data || typeof data !== "object" || Array.isArray(data) ||
          !/^\d+$/.test(String(data.id || "")) ||
          !["1", "2", "3", "4"].includes(String(data.bookingStatus))) throw inconclusive();
      return {
        bookingId: String(data.id), seatId: data.seatId ? Number(data.seatId) : null,
        seatName: String(data.seatName || "").trim(), regionName: String(data.regionName || "").trim(),
        buildingLayerRegionId: data.buildingLayerRegionId ? Number(data.buildingLayerRegionId) : null,
        startDate: String(data.startDate || "").trim(), endDate: String(data.endDate || "").trim(),
        bookingStatus: Number(data.bookingStatus)
      };
    };
    const curJson = await this.wslibGetJson("/seatbook/user/my/crrentbooking", rawToken);
    if (curJson?.code !== 200 || (!Object.hasOwn(curJson, "data") && !Object.hasOwn(curJson, "booking"))) throw inconclusive();
    const data = Object.hasOwn(curJson, "data") ? curJson.data : curJson.booking;
    if (data !== null) {
      const active = normalize(data);
      if (!expectedBookingId || active.bookingId === String(expectedBookingId)) return active;
    }
    // Missing, failed or truncated fallback results are not proof of absence.
    const inProgJson = await this.wslibGetJson(
      "/seatbook/user/mybookingInProgress?bookingstatus=0&pageSize=15&pageNum=1", rawToken
    );
    if (inProgJson?.code !== 200 || !Array.isArray(inProgJson.rows)) throw inconclusive();
    const activeRows = inProgJson.rows.map(normalize);
    const match = activeRows.find(row => !expectedBookingId || row.bookingId === String(expectedBookingId));
    if (match) return match;
    if (inProgJson.total !== undefined &&
        (!Number.isInteger(Number(inProgJson.total)) || Number(inProgJson.total) < 0 || Number(inProgJson.total) > activeRows.length)) throw inconclusive();
    if (inProgJson.total === undefined && activeRows.length >= 15) throw inconclusive();
    return null;
  }

  assertLiveAutomationEnabled() {
    throw new ContractError("SCHOOL_PERMISSION_REQUIRED", "Live school automation is disabled; use the official school service");
  }

  async cancelLiveSeatBooking({ decryptedSecret, binding, externalBookingId, schoolIntegration, beforeCancel }) {
    this.assertLiveAutomationEnabled();
    const assertCancellationAllowed = () => {
      if (binding?.school_id !== this.schoolId) throw new ContractError("FORBIDDEN", "Cross-school cancellation");
      if (binding.revoked_at || binding.status !== "DELEGATED_ACTIVE") {
        throw new ContractError("CONSENT_WITHDRAWN", "Active delegated binding is required for cancellation");
      }
      this.assertOperationAllowed("CANCEL_BOOKING", schoolIntegration, { requireLiveAutomation: true });
    };
    assertCancellationAllowed();
    if (!/^\d+$/.test(String(externalBookingId || ""))) {
      throw new ContractError("BAD_REQUEST", "An exact explicit school booking ID is required");
    }
    if (this.mockBackend || !this.parseCredentialBundle(decryptedSecret, binding).isLiveCredential) {
      throw new ContractError("SCHOOL_AUTH_EXPIRED", "Live cancellation requires live credentials");
    }
    const auth = await this.authenticateHautSession(decryptedSecret, binding);
    const current = await this.fetchCurrentActiveBooking(auth.rawToken);
    if (!current || String(current.bookingId) !== String(externalBookingId)) {
      return { cancelled: false, bookingId: String(externalBookingId), message: "Exact booking not found; no cancellation sent" };
    }
    if (typeof beforeCancel !== "function") throw new ContractError("BAD_REQUEST", "Current cancellation authorization callback is required");
    await beforeCancel();
    assertCancellationAllowed();
    const result = await this.wslibGetJson(
      `/seatbook/user/cancel?bookingid=${encodeURIComponent(externalBookingId)}&channelType=1003`, auth.rawToken
    );
    if (result?.code !== 200) {
      return { cancelled: false, bookingId: String(externalBookingId), message: result?.msg || "Cancellation not confirmed" };
    }
    try {
      const remaining = await this.fetchCurrentActiveBooking(auth.rawToken, { expectedBookingId: externalBookingId });
      return { cancelled: remaining === null, bookingId: String(externalBookingId),
        message: remaining === null ? "Cancellation confirmed by school readback" : "Cancellation not confirmed" };
    } catch {
      return { cancelled: false, bookingId: String(externalBookingId), message: "Cancellation readback is inconclusive" };
    }
  }

  matchesRequestedSeat(seat, wanted) {
    const requested = String(wanted || "").replace(/号座?$/, "").trim();
    return requested !== "" && [String(seat.id), seat.seat_name, seat.short_name].includes(requested);
  }

  async prewarmJobTargetSeats({ job, plan, binding, decryptedSecret }) {
    this.assertSchoolScope(job, binding, plan);
    if (this.mockBackend || job.capability === "MOCK_ONLY") return null;
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
      "";
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

    const cleanWantedArea = String(preferredArea).trim();
    const allowAlt = plan.preferences_json?.allow_alternative_seat === true;
    const matchedRegions = allRegions.filter(
      r => cleanWantedArea !== "" && (String(r.id) === cleanWantedArea || r.region_name === cleanWantedArea)
    );
    const primaryRegion = matchedRegions[0] || (allowAlt ? allRegions[0] : null);
    if (!primaryRegion) return { auth, prewarmed: null };
    const seatSnap = await this.fetchLiveRegionSeats(rawToken, primaryRegion.id, targetDate);
    const allSeatsInRegion = seatSnap.seats || [];
    const matchedCandidateSeats = [];
    for (const wanted of wantedSeats) {
      const found = allSeatsInRegion.find(s => this.matchesRequestedSeat(s, wanted));
      if (found && !matchedCandidateSeats.some(c => c.id === found.id)) {
        matchedCandidateSeats.push({ id: found.id, seat_name: found.seat_name, short_name: found.short_name });
      }
    }
    if (matchedCandidateSeats.length === 0) return { auth, prewarmed: null };

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

  async executeMockOrAuthorizedCreate({ job, plan, binding, schoolIntegration, decryptedSecret = null, nowInstant, beforeCreate }) {
    this.assertSchoolScope(job, binding, plan);
    if (!["DELEGATED_ACTIVE", "VERIFIED_LOCAL_ONLY"].includes(binding.status)) {
      throw new ContractError("SCHOOL_AUTH_EXPIRED", "School binding is not active");
    }
    const fireLocalTime = formatLocalTimeInShanghai(nowInstant);
    const rules = this.getRules();
    if (fireLocalTime < rules.window_start || fireLocalTime >= rules.window_end_exclusive) {
      throw new ContractError("BOOKING_WINDOW_CLOSED", "Execution is outside the official booking window");
    }
    const mockOnly = Boolean(this.mockBackend) || job.capability === "MOCK_ONLY";
    const credBundle = this.parseCredentialBundle(decryptedSecret, binding);
    if (!mockOnly && credBundle.isLiveCredential) this.assertLiveAutomationEnabled();
    this.assertOperationAllowed("CREATE_BOOKING", schoolIntegration, {
      allowMock: mockOnly, requireLiveAutomation: !mockOnly && credBundle.isLiveCredential
    });
    if (!mockOnly && job.capability === "AUTHORIZED_AUTOMATION" && !credBundle.isLiveCredential) {
      throw new ContractError("SCHOOL_AUTH_EXPIRED", "Live booking requires live credentials");
    }
    if (mockOnly || !credBundle.isLiveCredential) {
      if (this.mockBackend) return this.mockBackend.handleCreateReservation({ job, plan, binding, nowInstant });
      const seatAlias = plan.preferences_json?.preferred_seat_ids?.[0] || "N4-088";
      return { outcome: "SUBMITTED", externalBookingId: `haut_mock_${job.booking_local_date}_${seatAlias}_${binding.id.slice(0, 6)}`,
        seatAlias, regionAlias: plan.preferences_json?.preferred_area_ids?.[0] || "北四楼自习区" };
    }
    if (job.booking_local_date !== formatLocalDateInShanghai(nowInstant)) {
      throw new ContractError("BOOKING_WINDOW_CLOSED", "Only the exact same-day booking target is allowed");
    }
    const rawToken = credBundle.raw_token || (await this.authenticateHautSession(credBundle, binding)).rawToken;
    const existing = await this.fetchCurrentActiveBooking(rawToken);
    if (job.submission_target || existing) {
      if (job.submission_target?.binding_id === binding.id && job.submission_target.booking_local_date === job.booking_local_date && this.matchesAttempt(existing, job.submission_target, job.pending_external_booking_id)) {
        return { outcome: "SUBMITTED", externalBookingId: existing.bookingId, rawToken };
      }
      return { outcome: "TIMEOUT_AMBIGUOUS", errorCode: "BOOKING_VERIFICATION_PENDING", rawToken };
    }
    let target = null;
    const prewarmed = job.prewarmed_targets;
    const wantedArea = String(plan.area_name || plan.preferences_json?.preferred_area_ids?.[0] || plan.area_code || "").trim();
    const allowAlt = plan.preferences_json?.allow_alternative_seat === true;
    const wantedSeats = (plan.candidate_seats || plan.preferences_json?.preferred_seat_ids || []).map(String);
    const cachedRegionAllowed = allowAlt || (wantedArea !== "" && [String(prewarmed?.region_id), prewarmed?.region_name].includes(wantedArea));
    const cachedSeat = Array.isArray(prewarmed?.candidate_seats) ? prewarmed.candidate_seats.find(
      seat => allowAlt || wantedSeats.some(wanted => this.matchesRequestedSeat(seat, wanted))
    ) : null;
    if (cachedRegionAllowed && cachedSeat && prewarmed.start_full?.startsWith(`${job.booking_local_date} `) &&
        prewarmed.end_full?.startsWith(`${job.booking_local_date} `)) {
      const seat = cachedSeat;
      target = { seat_id: String(seat.id), region_id: String(prewarmed.region_id), start_full: prewarmed.start_full,
        end_full: prewarmed.end_full, seat_alias: seat.seat_name, region_alias: prewarmed.region_name };
    } else {
      const regions = (await this.fetchLiveStudyRegions(rawToken, job.booking_local_date)).regions || [];
      const preferred = regions.filter(r => wantedArea !== "" && (String(r.id) === wantedArea || r.region_name === wantedArea));
      const candidates = allowAlt ? [...preferred, ...regions.filter(r => !preferred.includes(r))] : preferred;
      for (const region of candidates) {
        const snap = await this.fetchLiveRegionSeats(rawToken, region.id, job.booking_local_date);
        const available = (snap.seats || []).filter(s => s.available);
        const seat = available.find(s => wantedSeats.some(w => this.matchesRequestedSeat(s, w))) ||
          (allowAlt ? available[0] : null);
        if (seat) {
          target = { seat_id: String(seat.id), region_id: String(region.id), start_full: snap.start_full,
            end_full: snap.end_full, seat_alias: seat.seat_name, region_alias: region.region_name };
          break;
        }
      }
    }
    if (!target) return { outcome: "FAILED", errorCode: "SCHOOL_REJECTED", diagnosticMessage: "No eligible seat" };
    target = { ...target, school_id: this.schoolId, binding_id: binding.id, booking_local_date: job.booking_local_date };
    if (!/^\d+$/.test(target.seat_id) || !target.start_full?.startsWith(`${job.booking_local_date} `) ||
        !target.end_full?.startsWith(`${job.booking_local_date} `) || target.start_full >= target.end_full) {
      throw new ContractError("BAD_REQUEST", "Invalid exact booking target");
    }
    if (typeof beforeCreate !== "function") throw new ContractError("BAD_REQUEST", "Durable submission intent callback is required");
    await beforeCreate(target);
    job.submission_target = target;
    this.assertOperationAllowed("CREATE_BOOKING", schoolIntegration, { requireLiveAutomation: true });
    // No write retry, alternate seat, date fallback, or reauthentication after this point.
    let response;
    try {
      response = await this.wslibGetJson(`/seatbook/user/addbooking?channel=1003&seatid=${encodeURIComponent(target.seat_id)}&starttime=${encodeURIComponent(target.start_full)}&endtime=${encodeURIComponent(target.end_full)}`, rawToken);
    } catch {
      // The server may have committed even when the transport timed out.
    }
    const expectedId = response?.code === 200 && response?.bookingid ? String(response.bookingid) : null;
    if (expectedId) job.pending_external_booking_id = expectedId;
    let active = null;
    try { active = await this.fetchCurrentActiveBooking(rawToken); } catch { /* Remain uncertain. */ }
    if (this.matchesAttempt(active, target, expectedId)) {
      return { outcome: "SUBMITTED", externalBookingId: active.bookingId, seatAlias: active.seatName, regionAlias: active.regionName, rawToken };
    }
    return { outcome: "TIMEOUT_AMBIGUOUS", externalBookingId: expectedId, errorCode: "BOOKING_VERIFICATION_PENDING", rawToken };
  }

  async verifyBookingAuthoritative({ job, binding, decryptedSecret = null, rawToken = null, expectedExternalBookingId }) {
    this.assertSchoolScope(job, binding);
    if (this.mockBackend) return this.mockBackend.handleVerifyReservation({ job, binding, expectedExternalBookingId });
    const isMockId = /^haut_mock_/.test(String(expectedExternalBookingId || ""));
    const credBundle = this.parseCredentialBundle(decryptedSecret, binding);
    if (isMockId && (job.capability === "MOCK_ONLY" || !credBundle.isLiveCredential)) {
      const prefix = `haut_mock_${job.booking_local_date}_`;
      if (!String(expectedExternalBookingId).startsWith(prefix) || !String(expectedExternalBookingId).endsWith(`_${binding.id.slice(0, 6)}`)) {
        return { verified: false, officialStatus: "TARGET_MISMATCH" };
      }
      return { verified: true, externalBookingId: expectedExternalBookingId, officialStatus: "CONFIRMED",
        evidenceSha256: crypto.createHash("sha256").update(`${job.school_id}|${binding.id}|${expectedExternalBookingId}|CONFIRMED`).digest("hex") };
    }
    const target = job.submission_target;
    if (job.capability === "MOCK_ONLY" || isMockId || !credBundle.isLiveCredential ||
        target?.binding_id !== binding.id || target?.booking_local_date !== job.booking_local_date) {
      return { verified: false, officialStatus: "TARGET_MISMATCH" };
    }
    const token = rawToken || (await this.authenticateHautSession(credBundle, binding)).rawToken;
    const active = await this.fetchCurrentActiveBooking(token);
    const expectedId = expectedExternalBookingId || job.pending_external_booking_id;
    if (expectedExternalBookingId && job.pending_external_booking_id &&
        String(expectedExternalBookingId) !== String(job.pending_external_booking_id)) {
      return { verified: false, officialStatus: "TARGET_MISMATCH" };
    }
    if (!this.matchesAttempt(active, target, expectedId)) return { verified: false, officialStatus: "NOT_FOUND_ON_WSLIB" };
    return { verified: true, externalBookingId: active.bookingId, officialStatus: "CONFIRMED", seatAlias: active.seatName,
      regionAlias: active.regionName, startAt: active.startDate, endAt: active.endDate,
      evidenceSha256: crypto.createHash("sha256").update(JSON.stringify({ binding: binding.id, target, active })).digest("hex") };
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
