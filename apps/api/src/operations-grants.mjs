const OPERATIONS_GRANT_ENV_VAR = "CLOUD_OPERATIONS_SCHOOL_GRANTS";
const ENV_GRANT_REF_PREFIX = "ops-env:";
const MAX_BOOTSTRAP_GRANTS = 50;
const MAX_GRANTED_BY_REF_LENGTH = 120;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PERMISSION_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SUPPORTED_OPERATIONS_PERMISSIONS = new Set([
  "place.status.moderate",
  "content_pack.review",
  "content_pack.publish",
  "content_pack.retire"
]);

function configError(message) {
  return new Error(OPERATIONS_GRANT_ENV_VAR + " " + message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanPart(value, field, index, { max = 128 } = {}) {
  if (typeof value !== "string") throw configError("entry " + index + " field " + field + " must be a string");
  const clean = value.trim();
  if (!clean) throw configError("entry " + index + " field " + field + " must not be empty");
  if (clean.length > max) throw configError("entry " + index + " field " + field + " exceeds maximum length " + max);
  if (CONTROL_RE.test(clean)) throw configError("entry " + index + " field " + field + " must not contain control characters");
  return clean;
}

function grantKeyParts(cloudUserId, schoolId, permission) {
  return cloudUserId + "\u001f" + schoolId + "\u001f" + permission;
}

function grantKey(spec) {
  return grantKeyParts(spec.cloud_user_id, spec.school_id, spec.permission);
}

function isActiveGrant(grant) {
  return Boolean(grant) && grant.status === "ACTIVE" && !grant.revoked_at;
}

function isBootstrapManaged(grant) {
  return String(grant?.granted_by_ref || "").startsWith(ENV_GRANT_REF_PREFIX);
}

function envGrantedByRef(spec) {
  return ENV_GRANT_REF_PREFIX + spec.granted_by_ref;
}

export function parseOperationsSchoolGrantSpecs(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError("must be a JSON array of grant objects");
  }
  if (!Array.isArray(parsed)) throw configError("must be a JSON array of grant objects");
  if (parsed.length > MAX_BOOTSTRAP_GRANTS) throw configError("supports at most " + MAX_BOOTSTRAP_GRANTS + " entries");
  const allowedFields = new Set(["cloud_user_id", "school_id", "permission", "granted_by_ref"]);
  const specs = parsed.map((entry, zeroIndex) => {
    const index = zeroIndex + 1;
    if (!isPlainObject(entry)) throw configError("entry " + index + " must be an object");
    for (const key of Object.keys(entry)) {
      if (!allowedFields.has(key)) throw configError("entry " + index + " contains unsupported field " + key);
    }
    const cloudUserId = cleanPart(entry.cloud_user_id, "cloud_user_id", index).toLowerCase();
    if (!UUID_RE.test(cloudUserId)) throw configError("entry " + index + " field cloud_user_id must be a UUID");
    const schoolId = cleanPart(entry.school_id, "school_id", index);
    const permission = cleanPart(entry.permission, "permission", index);
    if (!PERMISSION_RE.test(permission)) throw configError("entry " + index + " field permission is not a dotted permission id");
    if (!SUPPORTED_OPERATIONS_PERMISSIONS.has(permission)) {
      throw configError("entry " + index + " field permission is not a declared operations_school_scope permission");
    }
    const grantedByRef = cleanPart(entry.granted_by_ref ?? "deployment", "granted_by_ref", index, { max: MAX_GRANTED_BY_REF_LENGTH });
    return {
      cloud_user_id: cloudUserId,
      school_id: schoolId,
      permission,
      granted_by_ref: grantedByRef
    };
  });
  const seen = new Set();
  for (const [zeroIndex, spec] of specs.entries()) {
    const key = grantKey(spec);
    if (seen.has(key)) throw configError("entry " + (zeroIndex + 1) + " duplicates an earlier grant scope");
    seen.add(key);
  }
  return specs;
}

export function applyOperationsSchoolGrantBootstrap(store, rawValue, { nowMs = Date.now() } = {}) {
  const specs = parseOperationsSchoolGrantSpecs(rawValue);
  if (!store || !(store.operationsSchoolGrants instanceof Map) || !(store.users instanceof Map)) {
    throw new Error("operations school grant bootstrap requires the CloudDatabaseStore used by the API");
  }
  if (typeof store.grantOperationsSchoolScope !== "function" || typeof store.revokeOperationsSchoolGrant !== "function") {
    throw new Error("operations school grant bootstrap requires grant and revoke support in the API store");
  }
  for (const [zeroIndex] of specs.entries()) {
    if (!store.users.get(specs[zeroIndex].cloud_user_id)) {
      throw configError("entry " + (zeroIndex + 1) + " references an unknown cloud user");
    }
  }

  const nowIso = new Date(nowMs).toISOString();
  const desiredKeys = new Set(specs.map(grantKey));
  const summary = { granted: 0, already_active: 0, ref_updated: 0, revoked: 0 };
  const activeGrantFor = (spec) => Array.from(store.operationsSchoolGrants.values()).find((grant) =>
    isActiveGrant(grant) && grantKeyParts(grant.cloud_user_id, grant.school_id, grant.permission) === grantKey(spec)
  );
  const audit = (grant, outcome, spec = null) => store.recordAudit({
    actor_kind: "SYSTEM",
    actor_ref: "operations-school-grant-bootstrap",
    action: "OPERATIONS_SCHOOL_GRANT_BOOTSTRAP",
    resource_kind: "operations_school_grant",
    resource_ref: grant.id,
    outcome,
    detail: {
      cloud_user_id: grant.cloud_user_id,
      school_id: grant.school_id,
      permission: grant.permission,
      configured_granted_by_ref: spec?.granted_by_ref || null
    }
  });

  for (const spec of specs) {
    const desiredRef = envGrantedByRef(spec);
    const existing = activeGrantFor(spec);
    if (existing) {
      if (isBootstrapManaged(existing) && existing.granted_by_ref !== desiredRef) {
        existing.granted_by_ref = desiredRef;
        existing.updated_at = nowIso;
        summary.ref_updated += 1;
        audit(existing, "GRANT_REF_UPDATED", spec);
      } else {
        summary.already_active += 1;
      }
      continue;
    }
    const grant = store.grantOperationsSchoolScope(spec.cloud_user_id, spec.school_id, spec.permission, {
      grantedByRef: desiredRef,
      nowMs
    });
    summary.granted += 1;
    audit(grant, "GRANTED", spec);
  }

  for (const grant of Array.from(store.operationsSchoolGrants.values())) {
    if (!isActiveGrant(grant) || !isBootstrapManaged(grant)) continue;
    const key = grantKeyParts(grant.cloud_user_id, grant.school_id, grant.permission);
    if (desiredKeys.has(key)) continue;
    if (store.revokeOperationsSchoolGrant(grant.id, nowMs)) {
      summary.revoked += 1;
      audit(grant, "REVOKED");
    }
  }
  if (summary.granted + summary.ref_updated + summary.revoked > 0) {
    // Startup provisioning is a durability boundary too: the socket must not open
    // with a merely scheduled snapshot write that a crash could still lose.
    store.flushSnapshotStrictSync?.();
  }
  return summary;
}
