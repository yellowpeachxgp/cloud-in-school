import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../../..");

export const API_VERSION = "v1";
export const DEFAULT_SCHOOL_ID = "haut";
export const MICROPEACH_PER_PEACH = 10_000;
export const DEFAULT_RESERVATION_PRICE_MICROPEACH = 10_000; // 1 🍑 per confirmed reservation

export function formatPeachFromMicropeach(micropeach = DEFAULT_RESERVATION_PRICE_MICROPEACH, fractionDigits = null) {
  const num = Number(micropeach ?? DEFAULT_RESERVATION_PRICE_MICROPEACH) / MICROPEACH_PER_PEACH;
  if (!Number.isFinite(num)) return "1";
  if (typeof fractionDigits === "number") return num.toFixed(fractionDigits);
  return Number.isInteger(num) ? String(num) : num.toFixed(2).replace(/\.?0+$/, "");
}

export const ERROR_CODES = Object.freeze({
  CLOUD_AUTH_REQUIRED: { status: 401, retryable: false, userAction: "RECONNECT_XPEACH_BROWSER" },
  SESSION_REPLAY_DETECTED: { status: 401, retryable: false, userAction: "REAUTHENTICATE_ALL" },
  SSO_UNAVAILABLE: { status: 503, retryable: true, userAction: "KEEP_LOCAL_MODE_OR_RETRY_LATER" },
  CAMPUS_BINDING_REQUIRED: { status: 409, retryable: false, userAction: "BIND_SCHOOL_IDENTITY" },
  SCHOOL_PERMISSION_REQUIRED: { status: 403, retryable: false, userAction: "USE_MANUAL_OR_MOCK_MODE" },
  SCHOOL_CAPABILITY_UNVERIFIED: { status: 409, retryable: false, userAction: "USE_OFFICIAL_WEB_ENTRY" },
  SCHOOL_AUTH_EXPIRED: { status: 401, retryable: false, userAction: "REAUTHORIZE_SCHOOL_BINDING" },
  CAPTCHA_OR_MFA_REQUIRED: { status: 409, retryable: false, userAction: "COMPLETE_MANUAL_VERIFICATION" },
  SCHOOL_RATE_LIMITED: { status: 429, retryable: true, userAction: "WAIT_FOR_RATE_LIMIT_WINDOW" },
  BOOKING_WINDOW_CLOSED: { status: 422, retryable: false, userAction: "SELECT_TARGET_TIME_WITHIN_SCHOOL_WINDOW" },
  BOOKING_RESULT_UNKNOWN: { status: 202, retryable: false, userAction: "AWAIT_AUTHORITATIVE_READBACK" },
  WALLET_INSUFFICIENT: { status: 409, retryable: false, userAction: "RECHARGE_PEACH_WALLET" },
  PAYMENT_RECONCILING: { status: 202, retryable: true, userAction: "AWAIT_LEDGER_RECONCILIATION" },
  PAYMENT_DUE: { status: 409, retryable: false, userAction: "SETTLE_OUTSTANDING_ORDER" },
  CONSENT_WITHDRAWN: { status: 403, retryable: false, userAction: "GRANT_CONSENT_IF_DESIRED" },
  JOB_ALREADY_TERMINAL: { status: 409, retryable: false, userAction: "REFRESH_JOB_STATUS" },
  REQUEST_DUPLICATE: { status: 200, retryable: false, userAction: "NONE" },
  PARCEL_SOURCE_AUTH_REQUIRED: { status: 401, retryable: false, userAction: "AUTHORIZE_PARCEL_PROVIDER" },
  PARCEL_PROVIDER_NOT_AUTHORIZED: { status: 403, retryable: false, userAction: "USE_MANUAL_IMPORT_OR_MOCK" },
  PARCEL_CONSENT_REVOKED: { status: 403, retryable: false, userAction: "GRANT_AI_OR_SYNC_CONSENT" },
  PLUGIN_SIGNATURE_INVALID: { status: 400, retryable: false, userAction: "VERIFY_PLUGIN_PACKAGE_SIGNATURE" },
  PLUGIN_PERMISSION_DENIED: { status: 403, retryable: false, userAction: "REVIEW_PLUGIN_PERMISSIONS" },
  FORBIDDEN: { status: 403, retryable: false, userAction: "CHECK_PERMISSIONS" },
  NOT_FOUND: { status: 404, retryable: false, userAction: "CHECK_RESOURCE_ID" },
  BAD_REQUEST: { status: 400, retryable: false, userAction: "FIX_REQUEST_FIELDS" },
  CONFLICT: { status: 409, retryable: false, userAction: "RESOLVE_CONFLICT" }
});

export class ContractError extends Error {
  constructor(code, message, detail = undefined, statusOverride = undefined) {
    super(message);
    const meta = ERROR_CODES[code] || ERROR_CODES.BAD_REQUEST;
    this.code = code;
    this.httpStatus = statusOverride ?? meta.status;
    this.retryable = meta.retryable;
    this.userAction = meta.userAction;
    this.detail = detail;
  }
}

export function generateRequestId(existing = undefined) {
  if (typeof existing === "string" && /^[a-zA-Z0-9_-]{6,64}$/.test(existing)) {
    return existing;
  }
  return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function okEnvelope(code, data, requestId = generateRequestId(), nextCursor = null) {
  return {
    ok: true,
    code,
    request_id: requestId,
    data,
    meta: {
      request_id: requestId,
      api_version: API_VERSION,
      next_cursor: nextCursor
    }
  };
}

export function errorEnvelope(err, requestId = generateRequestId()) {
  const code = err?.code && ERROR_CODES[err.code] ? err.code : "BAD_REQUEST";
  const spec = ERROR_CODES[code];
  const message = err?.message || "Request failed";
  return {
    httpStatus: err?.httpStatus ?? spec.status,
    body: {
      ok: false,
      code,
      request_id: requestId,
      error: {
        code,
        message: redactString(message),
        user_action: err?.userAction ?? spec.userAction,
        retryable: Boolean(err?.retryable ?? spec.retryable),
        ...(err?.detail ? { detail: redactSensitiveFields(err.detail) } : {})
      },
      meta: {
        request_id: requestId,
        api_version: API_VERSION,
        next_cursor: null
      }
    }
  };
}

const SENSITIVE_KEY_PATTERN =
  /password|secret|cookie|set-cookie|castgc|jsessionid|authorization|token|internal_service_key|delegated_secret|private_key|ai_key/i;

export function redactString(input) {
  if (typeof input !== "string") return input;
  return input
    .replace(/(CASTGC\s*=\s*|JSESSIONID\s*=\s*|Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/(password|cookie|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

export function redactSensitiveFields(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return redactString(obj);
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => redactSensitiveFields(item));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redactSensitiveFields(v);
    }
  }
  return out;
}

export function loadOpenApiText() {
  return fs.readFileSync(path.join(REPO_ROOT, "contracts/openapi/cloud-v1.yaml"), "utf8");
}

export function loadPermissionCatalog() {
  const text = fs.readFileSync(path.join(REPO_ROOT, "contracts/permissions/permission-catalog.yaml"), "utf8");
  const ids = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*id:\s*([a-zA-Z0-9._-]+)\s*$/);
    if (m) ids.push({ id: m[1] });
  }
  return { permissions: ids };
}

export function loadHostApiMatrix() {
  return fs.readFileSync(path.join(REPO_ROOT, "contracts/compatibility/host-api-matrix.yaml"), "utf8");
}

export function loadEndpointInventory() {
  const text = fs.readFileSync(path.join(REPO_ROOT, "contracts/endpoints/endpoint-inventory.yaml"), "utf8");
  const endpoints = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const mMatch = line.match(/^\s*-\s*method:\s*([A-Z]+)\s*$/);
    if (mMatch) {
      if (current) endpoints.push(current);
      current = { method: mMatch[1], path: "", operationId: "", auth: "", owner: "" };
      continue;
    }
    if (!current) continue;
    const pMatch = line.match(/^\s*path:\s*(\/[^\s]*)\s*$/);
    if (pMatch) current.path = pMatch[1];
    const oMatch = line.match(/^\s*operationId:\s*([a-zA-Z0-9_]+)\s*$/);
    if (oMatch) current.operationId = oMatch[1];
    const aMatch = line.match(/^\s*auth:\s*([a-zA-Z0-9_]+)\s*$/);
    if (aMatch) current.auth = aMatch[1];
    const wMatch = line.match(/^\s*owner:\s*([a-zA-Z0-9_-]+)\s*$/);
    if (wMatch) current.owner = wMatch[1];
  }
  if (current) endpoints.push(current);
  return endpoints;
}
