import crypto from "node:crypto";
import { ContractError } from "../../contracts/src/index.mjs";

export const PROVIDER_AUTHORITY_MATRIX = Object.freeze({
  "parcel.manual": {
    provider_id: "parcel.manual",
    display_name: "手动添加 / 扫码录入",
    authority_status: "PRODUCTION_ENABLED",
    allow_cloud_background_poll: false,
    allow_client_import: true,
    source_priority: 80
  },
  "parcel.notification-parser": {
    provider_id: "parcel.notification-parser",
    display_name: "本地短信/通知取件码解析",
    authority_status: "PRODUCTION_ENABLED",
    allow_cloud_background_poll: false,
    allow_client_import: true,
    source_priority: 90
  },
  "parcel.campus-station": {
    provider_id: "parcel.campus-station",
    display_name: "授权校园驿站插件数据源",
    authority_status: "PRODUCTION_ENABLED",
    allow_cloud_background_poll: true,
    allow_client_import: true,
    source_priority: 100
  },
  "parcel.kd100": {
    provider_id: "parcel.kd100",
    display_name: "快递100 (用户自带授权 Key)",
    authority_status: "PRODUCTION_ENABLED",
    allow_cloud_background_poll: false,
    allow_client_import: true,
    requires_user_api_key: true,
    source_priority: 70
  },
  "parcel.xiaomi.personal-assistant": {
    provider_id: "parcel.xiaomi.personal-assistant",
    display_name: "小米智能助理快递卡片 (受限手动导入)",
    authority_status: "MANUAL_IMPORT_ONLY",
    allow_cloud_background_poll: false,
    allow_client_import: true,
    source_priority: 65
  },
  "parcel.jd.orders": {
    provider_id: "parcel.jd.orders",
    display_name: "京东订单快照导入 (受限手动导入)",
    authority_status: "MANUAL_IMPORT_ONLY",
    allow_cloud_background_poll: false,
    allow_client_import: true,
    source_priority: 60
  },
  "parcel.taobao.cainiao": {
    provider_id: "parcel.taobao.cainiao",
    display_name: "淘宝/菜鸟包裹导入 (仅限研究沙箱)",
    authority_status: "RESEARCH_SANDBOX_ONLY",
    allow_cloud_background_poll: false,
    allow_client_import: false,
    source_priority: 55
  },
  "parcel.pdd.orders": {
    provider_id: "parcel.pdd.orders",
    display_name: "拼多多订单导入 (仅限研究沙箱)",
    authority_status: "RESEARCH_SANDBOX_ONLY",
    allow_cloud_background_poll: false,
    allow_client_import: false,
    source_priority: 50
  }
});

const OTP_BLACKLIST_KEYWORDS = [
  "验证码",
  "校验码",
  "动态码",
  "登录密码",
  "确认码",
  "verification code",
  "otp",
  "security code"
];

const PICKUP_CONTEXT_KEYWORDS = [
  "取件码",
  "提货码",
  "取货码",
  "凭码",
  "驿站",
  "菜鸟",
  "丰巢",
  "妈妈驿站",
  "兔喜",
  "近邻宝",
  "熊猫快收",
  "货架",
  "快递柜",
  "包裹"
];

export function cleanNullableText(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "undefined" || lower === "none" || lower === "nil") {
    return null;
  }
  return trimmed
    .replace(/\s*·\s*null\b/gi, "")
    .replace(/\bnull\s*·\s*/gi, "")
    .trim() || null;
}

export function normalizeTrackingNumber(raw) {
  const cleaned = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (cleaned.length < 6 || cleaned.length > 32) {
    throw new ContractError("BAD_REQUEST", "Invalid tracking number format", {
      tracking_number: raw
    });
  }
  return cleaned;
}

export function resolvePickupCode(text) {
  if (!text || typeof text !== "string") {
    return null;
  }
  const normalized = text.trim();
  const lower = normalized.toLowerCase();

  const hasOtpWord = OTP_BLACKLIST_KEYWORDS.some((kw) => lower.includes(kw));
  const hasPickupContext = PICKUP_CONTEXT_KEYWORDS.some((kw) => lower.includes(kw));

  if (hasOtpWord && !hasPickupContext) {
    return null;
  }

  const shelfMatch = normalized.match(
    /\b([A-Z0-9]{1,4}-[0-9]{1,3}-[0-9]{3,6}|[A-Z0-9]{1,4}-[0-9]{3,6})\b/i
  );
  if (shelfMatch && hasPickupContext) {
    return {
      pickup_code: shelfMatch[1].toUpperCase(),
      code_type: "SHELF_CODE",
      station_name: extractStationName(normalized)
    };
  }

  const explicitMatch = normalized.match(
    /(?:取件码|提货码|取货码|凭码)[:：\s是为【\[]*([A-Z0-9-]{4,14})[\]】]?/i
  );
  if (explicitMatch) {
    return {
      pickup_code: explicitMatch[1].toUpperCase(),
      code_type: explicitMatch[1].includes("-") ? "SHELF_CODE" : "CABINET_PIN",
      station_name: extractStationName(normalized)
    };
  }

  return null;
}

function extractStationName(text) {
  const match = text.match(
    /【([^】]{2,20}(?:驿站|丰巢|快递柜|服务中心))】|([^\s，,。！!：:]{2,20}(?:菜鸟驿站|妈妈驿站|兔喜生活|丰巢智能柜|近邻宝))/
  );
  if (!match) return null;
  return (match[1] || match[2] || "").trim();
}

export class ParcelHubService {
  constructor(store, kmsVault, { environment = "production" } = {}) {
    this.store = store;
    this.kmsVault = kmsVault;
    this.environment = environment;
    this.parcelIndexByUserTracking = new Map(); // `${userId}:${trackingNumber}` -> parcelId
    this.aiConsents = new Map(); // userId -> { allow_ai_summary, allowed_fields }
  }

  listProviders() {
    return Object.values(PROVIDER_AUTHORITY_MATRIX);
  }

  listStations() {
    return [
      {
        station_id: "haut-lianhua-north-cainiao",
        school_id: "haut",
        station_name: "莲花街校区北苑菜鸟驿站",
        open_hours: "08:30-21:00",
        location_hint: "北苑食堂西侧一楼"
      },
      {
        station_id: "haut-lianhua-south-tuxi",
        school_id: "haut",
        station_name: "莲花街校区南苑兔喜快递超市",
        open_hours: "09:00-20:30",
        location_hint: "南苑宿舍区东门旁"
      }
    ];
  }

  enforceProviderAuthority(providerId, { channel = "CLIENT_IMPORT", sandboxOverride = false } = {}) {
    const entry = PROVIDER_AUTHORITY_MATRIX[providerId];
    if (!entry) {
      throw new ContractError(
        "PARCEL_PROVIDER_NOT_AUTHORIZED",
        `Unregistered parcel provider '${providerId}' is denied by fail-closed policy`
      );
    }
    if (entry.authority_status === "DISABLED") {
      throw new ContractError(
        "PARCEL_PROVIDER_NOT_AUTHORIZED",
        `Parcel provider '${providerId}' is disabled`
      );
    }
    if (channel === "CLOUD_BACKGROUND_POLL" && !entry.allow_cloud_background_poll) {
      throw new ContractError(
        "PARCEL_PROVIDER_NOT_AUTHORIZED",
        `Provider '${providerId}' does not permit server-side background polling`,
        { provider_id: providerId, authority_status: entry.authority_status }
      );
    }
    if (
      entry.authority_status === "RESEARCH_SANDBOX_ONLY" &&
      this.environment === "production" &&
      !sandboxOverride
    ) {
      throw new ContractError(
        "PARCEL_PROVIDER_NOT_AUTHORIZED",
        `Provider '${providerId}' is restricted to RESEARCH_SANDBOX_ONLY and blocked in production`,
        { provider_id: providerId, authority_status: entry.authority_status }
      );
    }
    return entry;
  }

  authorizeProviderAccount({
    cloudUserId,
    providerId,
    accountAlias,
    secretPayload,
    sandboxOverride = false
  }) {
    const provider = this.enforceProviderAuthority(providerId, {
      channel: "CLIENT_IMPORT",
      sandboxOverride
    });
    const connectionId = crypto.randomUUID();
    let credentialRef = null;
    if (secretPayload) {
      const cred = this.kmsVault.encryptSecret({
        bindingId: connectionId,
        schoolId: `parcel:${providerId}`,
        credentialKind: "PARCEL_SOURCE_SECRET",
        plaintext: typeof secretPayload === "string" ? secretPayload : JSON.stringify(secretPayload)
      });
      this.store.encryptedCredentials.set(cred.id, cred);
      credentialRef = cred.id;
    }

    const record = {
      id: connectionId,
      cloud_user_id: cloudUserId,
      provider_id: providerId,
      account_alias: accountAlias || "default",
      authority_status: provider.authority_status,
      credential_ref: credentialRef,
      status: "ACTIVE",
      created_at: new Date().toISOString(),
      revoked_at: null
    };
    this.store.parcelSourceConnections.set(connectionId, record);
    this.store.recordAudit({
      actor_kind: "USER",
      actor_ref: cloudUserId,
      action: "AUTHORIZE_PARCEL_SOURCE",
      resource_kind: "parcel_source_connection",
      resource_ref: connectionId,
      outcome: "ACTIVE"
    });
    return record;
  }

  listConnections(cloudUserId) {
    return Array.from(this.store.parcelSourceConnections.values()).filter(
      (c) => c.cloud_user_id === cloudUserId && !c.revoked_at
    );
  }

  revokeConnection(cloudUserId, connectionId) {
    const conn = this.store.parcelSourceConnections.get(connectionId);
    if (!conn || conn.cloud_user_id !== cloudUserId) {
      throw new ContractError("NOT_FOUND", "Parcel source connection not found");
    }
    const ts = new Date().toISOString();
    conn.revoked_at = ts;
    conn.status = "REVOKED";
    if (conn.credential_ref && this.store.encryptedCredentials.has(conn.credential_ref)) {
      this.store.encryptedCredentials.get(conn.credential_ref).revoked_at = ts;
    }
    this.store.recordAudit({
      actor_kind: "USER",
      actor_ref: cloudUserId,
      action: "REVOKE_PARCEL_SOURCE",
      resource_kind: "parcel_source_connection",
      resource_ref: connectionId,
      outcome: "REVOKED"
    });
    return conn;
  }

  upsertParcel({
    cloudUserId,
    trackingNumber,
    carrierCode = "AUTO",
    carrierName = "快递包裹",
    providerId = "parcel.manual",
    channel = "CLIENT_IMPORT",
    status = "IN_TRANSIT",
    pickupCode = null,
    stationName = null,
    itemTitle = null,
    rawNotificationText = null,
    checkpoints = [],
    sandboxOverride = false
  }) {
    const provider = this.enforceProviderAuthority(providerId, { channel, sandboxOverride });
    const normalizedTracking = normalizeTrackingNumber(trackingNumber);

    const cleanCarrierCode = cleanNullableText(carrierCode) || "AUTO";
    const cleanCarrierName = cleanNullableText(carrierName) || "校园快递";
    const cleanInputPickupCode = cleanNullableText(pickupCode);
    const cleanInputStationName = cleanNullableText(stationName);
    const cleanInputItemTitle = cleanNullableText(itemTitle);
    const cleanRawNotificationText = cleanNullableText(rawNotificationText);

    const extracted = cleanRawNotificationText ? resolvePickupCode(cleanRawNotificationText) : null;
    const effectivePickupCode =
      cleanInputPickupCode || cleanNullableText(extracted?.pickup_code) || null;
    const effectiveStationName =
      cleanInputStationName || cleanNullableText(extracted?.station_name) || null;
    const effectiveStatus =
      effectivePickupCode && (status === "IN_TRANSIT" || status === "OUT_FOR_DELIVERY")
        ? "READY_FOR_PICKUP"
        : status;

    const indexKey = `${cloudUserId}:${normalizedTracking}`;
    const existingId = this.parcelIndexByUserTracking.get(indexKey);
    const nowIso = new Date().toISOString();

    if (!existingId || !this.store.parcels.has(existingId)) {
      const parcelId = crypto.randomUUID();
      const created = {
        id: parcelId,
        cloud_user_id: cloudUserId,
        tracking_number: normalizedTracking,
        carrier_code: cleanCarrierCode,
        carrier_name: cleanCarrierName,
        status: effectiveStatus,
        pickup_code: effectivePickupCode,
        station_name: effectiveStationName,
        item_title: cleanInputItemTitle,
        tracking_enabled: true,
        sources: [
          {
            provider_id: providerId,
            priority: provider.source_priority,
            synced_at: nowIso
          }
        ],
        field_provenance: {
          status: { provider_id: providerId, priority: provider.source_priority, updated_at: nowIso },
          pickup_code: effectivePickupCode
            ? { provider_id: providerId, priority: provider.source_priority, updated_at: nowIso }
            : null,
          station_name: effectiveStationName
            ? { provider_id: providerId, priority: provider.source_priority, updated_at: nowIso }
            : null,
          item_title: cleanInputItemTitle
            ? { provider_id: providerId, priority: provider.source_priority, updated_at: nowIso }
            : null
        },
        checkpoints: this._mergeCheckpoints([], checkpoints),
        created_at: nowIso,
        updated_at: nowIso
      };
      this.store.parcels.set(parcelId, created);
      this.parcelIndexByUserTracking.set(indexKey, parcelId);
      return created;
    }

    const parcel = this.store.parcels.get(existingId);
    const incomingPriority = provider.source_priority;

    // Self-heal any legacy persisted "null" literals on existing parcel records
    parcel.pickup_code = cleanNullableText(parcel.pickup_code);
    parcel.station_name = cleanNullableText(parcel.station_name);
    parcel.item_title = cleanNullableText(parcel.item_title);
    parcel.carrier_name = cleanNullableText(parcel.carrier_name) || "校园快递";
    parcel.carrier_code = cleanNullableText(parcel.carrier_code) || "AUTO";

    if (cleanCarrierName && cleanCarrierName !== "校园快递" && cleanCarrierName !== "快递包裹") {
      parcel.carrier_name = cleanCarrierName;
    }
    if (cleanCarrierCode && cleanCarrierCode !== "AUTO") {
      parcel.carrier_code = cleanCarrierCode;
    }

    const existingSrc = parcel.sources.find((s) => s.provider_id === providerId);
    if (existingSrc) {
      existingSrc.synced_at = nowIso;
    } else {
      parcel.sources.push({
        provider_id: providerId,
        priority: incomingPriority,
        synced_at: nowIso
      });
    }

    const statusRank = {
      CREATED: 10,
      IN_TRANSIT: 20,
      OUT_FOR_DELIVERY: 30,
      READY_FOR_PICKUP: 40,
      PICKED_UP: 50,
      EXCEPTION: 35
    };
    if (
      (statusRank[effectiveStatus] || 0) >= (statusRank[parcel.status] || 0) ||
      incomingPriority >= (parcel.field_provenance.status?.priority || 0) ||
      (parcel.status === "READY_FOR_PICKUP" && !parcel.pickup_code && !effectivePickupCode && effectiveStatus === "IN_TRANSIT")
    ) {
      parcel.status = effectiveStatus;
      parcel.field_provenance.status = {
        provider_id: providerId,
        priority: incomingPriority,
        updated_at: nowIso
      };
    }

    if (
      effectivePickupCode &&
      (!parcel.pickup_code ||
        incomingPriority >= (parcel.field_provenance.pickup_code?.priority || 0))
    ) {
      parcel.pickup_code = effectivePickupCode;
      parcel.field_provenance.pickup_code = {
        provider_id: providerId,
        priority: incomingPriority,
        updated_at: nowIso
      };
    }

    if (
      effectiveStationName &&
      (!parcel.station_name ||
        incomingPriority >= (parcel.field_provenance.station_name?.priority || 0))
    ) {
      parcel.station_name = effectiveStationName;
      parcel.field_provenance.station_name = {
        provider_id: providerId,
        priority: incomingPriority,
        updated_at: nowIso
      };
    }

    if (
      cleanInputItemTitle &&
      (!parcel.item_title ||
        incomingPriority >= (parcel.field_provenance.item_title?.priority || 0))
    ) {
      parcel.item_title = cleanInputItemTitle;
      parcel.field_provenance.item_title = {
        provider_id: providerId,
        priority: incomingPriority,
        updated_at: nowIso
      };
    }

    parcel.checkpoints = this._mergeCheckpoints(parcel.checkpoints, checkpoints);
    parcel.updated_at = nowIso;
    return parcel;
  }

  listUserParcels(cloudUserId, statusFilter = null) {
    return Array.from(this.store.parcels.values())
      .map((p) => {
        if (p) {
          p.pickup_code = cleanNullableText(p.pickup_code);
          p.station_name = cleanNullableText(p.station_name);
          p.item_title = cleanNullableText(p.item_title);
          p.carrier_name = cleanNullableText(p.carrier_name) || "校园快递";
        }
        return p;
      })
      .filter((p) => p.cloud_user_id === cloudUserId && (!statusFilter || p.status === statusFilter))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  getParcelForUser(cloudUserId, parcelId) {
    const p = this.store.parcels.get(parcelId);
    if (!p) throw new ContractError("NOT_FOUND", "Parcel not found");
    if (p.cloud_user_id !== cloudUserId) {
      throw new ContractError("FORBIDDEN", "Cross-user parcel access denied (IDOR blocked)");
    }
    return p;
  }

  setAiConsent(cloudUserId, { allowAiSummary, allowedFields = ["status", "station_name", "pickup_code"] }) {
    this.aiConsents.set(cloudUserId, {
      allow_ai_summary: Boolean(allowAiSummary),
      allowed_fields: allowedFields,
      updated_at: new Date().toISOString()
    });
  }

  invokeParcelAssistant(cloudUserId, { mode = "RULE_BASED", consentGranted = false } = {}) {
    if (mode === "AI_LLM") {
      const savedConsent = this.aiConsents.get(cloudUserId);
      if (!consentGranted && !savedConsent?.allow_ai_summary) {
        throw new ContractError(
          "PARCEL_CONSENT_REVOKED",
          "Explicit field-level AI consent is required before invoking Parcel AI Assistant"
        );
      }
    }
    const parcels = this.listUserParcels(cloudUserId);
    const ready = parcels.filter((p) => p.status === "READY_FOR_PICKUP");
    const transit = parcels.filter((p) => p.status === "IN_TRANSIT" || p.status === "OUT_FOR_DELIVERY");
    const byStation = {};
    for (const p of ready) {
      const st = p.station_name || "默认校园驿站";
      if (!byStation[st]) byStation[st] = [];
      byStation[st].push({
        parcel_id: p.id,
        pickup_code: p.pickup_code,
        tracking_tail: p.tracking_number.slice(-4)
      });
    }
    return {
      mode,
      ready_for_pickup_count: ready.length,
      in_transit_count: transit.length,
      grouped_by_station: byStation,
      summary_text:
        ready.length > 0
          ? `今日共有 ${ready.length} 件待取包裹，分布在 ${Object.keys(byStation).join("、")}。`
          : `暂无待取包裹，另有 ${transit.length} 件包裹在途。`
    };
  }

  _mergeCheckpoints(existing, incoming) {
    const map = new Map();
    for (const cp of [...(existing || []), ...(incoming || [])]) {
      if (!cp || !cp.time || !cp.description) continue;
      map.set(`${cp.time}:${cp.description}`, cp);
    }
    return Array.from(map.values()).sort((a, b) => String(b.time).localeCompare(String(a.time)));
  }
}
