import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ContractError, redactSensitiveFields } from "../../contracts/src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

export function listMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR).sort();
  const upFiles = files.filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"));
  return upFiles.map((upFile) => {
    const base = upFile.replace(/\.sql$/, "");
    const downFile = `${base}.down.sql`;
    const upPath = path.join(MIGRATIONS_DIR, upFile);
    const downPath = path.join(MIGRATIONS_DIR, downFile);
    return {
      version: base,
      upPath,
      downPath,
      upSql: fs.readFileSync(upPath, "utf8"),
      downSql: fs.existsSync(downPath) ? fs.readFileSync(downPath, "utf8") : null
    };
  });
}

export class CloudDatabaseStore {
  constructor({ snapshotPath = null, pricingMicropeach = 1000 } = {}) {
    this.snapshotPath = snapshotPath;
    this.pricingMicropeach = pricingMicropeach;
    this.appliedMigrations = new Set();

    // Identity & Sessions
    this.users = new Map(); // id -> user
    this.userRoles = new Map(); // userId -> Set<string>
    this.authTransactions = new Map(); // loginTxn -> txn
    this.exchangeTickets = new Map(); // appTicket -> ticket
    this.deviceSessions = new Map(); // sessionId -> session

    // School & Credentials & Consents
    this.schoolIntegrations = new Map(); // school_id -> integration config
    this.schoolBindings = new Map(); // bindingId -> binding
    this.encryptedCredentials = new Map(); // credId -> encrypted record
    this.consents = new Map(); // consentId -> consent

    // Reservations & Triple-Schedule
    this.reservationPlans = new Map(); // planId -> plan
    this.reservationJobs = new Map(); // jobId -> job
    this.scheduleEvents = new Map(); // eventId -> event
    this.schoolReservations = new Map(); // jobId -> verified school reservation

    // Finance & Outbox
    this.reservationOrders = new Map(); // orderId -> order
    this.financeOperations = new Map(); // eventKey -> operation
    this.outboxEvents = [];

    // Parcel Hub
    this.parcels = new Map(); // parcelId -> parcel
    this.parcelEvents = new Map(); // parcelId -> events[]
    this.parcelSourceConnections = new Map(); // connectionId -> connection
    this.parcelSyncJobs = new Map(); // jobId -> sync job

    // Plugins
    this.pluginInstallations = new Map(); // `${userId}:${pluginId}` -> installation

    // Notifications, Audit, Idempotency
    this.notifications = new Map(); // notificationId -> notification
    this.auditEvents = [];
    this.idempotencyRecords = new Map(); // `${scope}|${actor}|${key}` -> { requestHash, status, body }

    this._seedDefaults();
    this.runMigrations();
    this._loadSnapshot();
  }

  _loadSnapshot() {
    if (!this.snapshotPath) return;
    try {
      if (!fs.existsSync(this.snapshotPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.snapshotPath, "utf8"));
      const loadMap = (map, arr) => {
        if (!Array.isArray(arr)) return;
        for (const [k, v] of arr) map.set(k, v);
      };
      loadMap(this.users, raw.users);
      if (Array.isArray(raw.userRoles)) {
        for (const [k, arr] of raw.userRoles) {
          this.userRoles.set(k, new Set(Array.isArray(arr) ? arr : ["USER"]));
        }
      }
      loadMap(this.deviceSessions, raw.deviceSessions);
      loadMap(this.schoolBindings, raw.schoolBindings);
      loadMap(this.encryptedCredentials, raw.encryptedCredentials);
      loadMap(this.consents, raw.consents);
      loadMap(this.reservationPlans, raw.reservationPlans);
      loadMap(this.reservationJobs, raw.reservationJobs);
      loadMap(this.scheduleEvents, raw.scheduleEvents);
      loadMap(this.schoolReservations, raw.schoolReservations);
      loadMap(this.reservationOrders, raw.reservationOrders);
      loadMap(this.financeOperations, raw.financeOperations);
      loadMap(this.parcels, raw.parcels);
      loadMap(this.parcelEvents, raw.parcelEvents);
      loadMap(this.parcelSourceConnections, raw.parcelSourceConnections);
      loadMap(this.parcelSyncJobs, raw.parcelSyncJobs);
      loadMap(this.pluginInstallations, raw.pluginInstallations);
      loadMap(this.notifications, raw.notifications);
      if (Array.isArray(raw.auditEvents)) {
        this.auditEvents = raw.auditEvents.slice(-500);
      }
    } catch {
      // Ignore corrupt snapshot
    }
  }

  saveSnapshot() {
    if (!this.snapshotPath) return;
    try {
      const dir = path.dirname(this.snapshotPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {
        users: Array.from(this.users.entries()),
        userRoles: Array.from(this.userRoles.entries()).map(([k, set]) => [k, Array.from(set)]),
        deviceSessions: Array.from(this.deviceSessions.entries()),
        schoolBindings: Array.from(this.schoolBindings.entries()),
        encryptedCredentials: Array.from(this.encryptedCredentials.entries()),
        consents: Array.from(this.consents.entries()),
        reservationPlans: Array.from(this.reservationPlans.entries()),
        reservationJobs: Array.from(this.reservationJobs.entries()),
        scheduleEvents: Array.from(this.scheduleEvents.entries()),
        schoolReservations: Array.from(this.schoolReservations.entries()),
        reservationOrders: Array.from(this.reservationOrders.entries()),
        financeOperations: Array.from(this.financeOperations.entries()),
        parcels: Array.from(this.parcels.entries()),
        parcelEvents: Array.from(this.parcelEvents.entries()),
        parcelSourceConnections: Array.from(this.parcelSourceConnections.entries()),
        parcelSyncJobs: Array.from(this.parcelSyncJobs.entries()),
        pluginInstallations: Array.from(this.pluginInstallations.entries()),
        notifications: Array.from(this.notifications.entries()),
        auditEvents: this.auditEvents.slice(-500)
      };
      const tmp = `${this.snapshotPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
      fs.renameSync(tmp, this.snapshotPath);
    } catch {
      // Ignore write error
    }
  }

  _seedDefaults() {
    this.schoolIntegrations.set("haut", {
      school_id: "haut",
      display_name: "河南工业大学 (HAUT)",
      provider_id: "school.haut.library",
      enabled: true,
      kill_switch: false,
      authorization_evidence_ref: null, // Default MOCK_ONLY until dual-person approval + evidence
      approver_primary_ref: null,
      approver_secondary_ref: null,
      updated_at: new Date().toISOString()
    });
  }

  runMigrations() {
    const migrations = listMigrations();
    for (const m of migrations) {
      if (!m.upSql.includes("CREATE TABLE") && !m.upSql.includes("ALTER TABLE")) {
        throw new Error(`Invalid migration SQL in ${m.version}`);
      }
      if (!m.downSql) {
        throw new Error(`Missing rollback .down.sql for ${m.version}`);
      }
      this.appliedMigrations.add(m.version);
    }
    return Array.from(this.appliedMigrations);
  }

  rollbackLastMigration() {
    const list = Array.from(this.appliedMigrations);
    if (list.length === 0) return null;
    const last = list[list.length - 1];
    this.appliedMigrations.delete(last);
    return last;
  }

  findOrCreateCloudUser({
    issuer,
    subject,
    displayName = "XPEACH User",
    username = null,
    email = null,
    emailVerified = false,
    group = null,
    affCode = null,
    role = null,
    ssoCreatedAt = null,
    ssoLastLoginAt = null,
    ssoAccessToken = null,
    ssoRefreshToken = null,
    peachWallet = null
  }) {
    const existing = Array.from(this.users.values()).find(
      (u) => u.issuer === issuer && u.subject === subject
    );
    if (existing) {
      if (displayName) existing.display_name = displayName;
      if (username) existing.username = username;
      if (email) existing.email = email;
      if (emailVerified !== undefined) existing.email_verified = Boolean(emailVerified);
      if (group) existing.group = group;
      if (affCode) existing.aff_code = affCode;
      if (role) existing.role = role;
      if (ssoCreatedAt) existing.sso_created_at = ssoCreatedAt;
      if (ssoLastLoginAt) existing.sso_last_login_at = ssoLastLoginAt;
      if (ssoAccessToken) existing.sso_access_token = ssoAccessToken;
      if (ssoRefreshToken) existing.sso_refresh_token = ssoRefreshToken;
      if (peachWallet && typeof peachWallet === "object") {
        existing.peach_wallet = { ...(existing.peach_wallet || {}), ...peachWallet };
      }
      this._syncAdminRoleIfEligible(existing);
      this.saveSnapshot();
      return existing;
    }
    const id = crypto.randomUUID();
    const user = {
      id,
      issuer,
      subject,
      username: username || displayName || "XPEACH User",
      display_name: displayName,
      email: email || null,
      email_verified: Boolean(emailVerified),
      group: group || peachWallet?.group || "默认分组",
      aff_code: affCode || peachWallet?.affCode || null,
      role: role || "user",
      sso_created_at: ssoCreatedAt || new Date().toISOString(),
      sso_last_login_at: ssoLastLoginAt || new Date().toISOString(),
      sso_access_token: ssoAccessToken || null,
      sso_refresh_token: ssoRefreshToken || null,
      peach_wallet: peachWallet && typeof peachWallet === "object" ? { ...peachWallet } : null,
      status: "ACTIVE",
      created_at: new Date().toISOString()
    };
    this.users.set(id, user);
    if (!this.userRoles.has(id)) {
      this.userRoles.set(id, new Set(["USER"]));
    }
    this._syncAdminRoleIfEligible(user);
    this.saveSnapshot();
    return user;
  }

  _syncAdminRoleIfEligible(user) {
    if (!user) return;
    if (
      user.role === "admin" ||
      user.subject === "856f-cf51-b064-5d84" ||
      user.username === "yellowpeach" ||
      user.group === "管理员分组"
    ) {
      const roles = this.userRoles.get(user.id) || new Set(["USER"]);
      roles.add("ADMIN");
      roles.add("OPERATOR");
      roles.add("FINANCE");
      this.userRoles.set(user.id, roles);
    }
  }

  getUserRoles(cloudUserId) {
    const set = this.userRoles.get(cloudUserId);
    return set ? Array.from(set) : ["USER"];
  }

  setUserRoles(cloudUserId, roles) {
    this.userRoles.set(cloudUserId, new Set(["USER", ...(roles || [])]));
    this.saveSnapshot();
  }

  requireRole(authContext, requiredRoles) {
    if (!authContext || !authContext.cloudUserId) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Authentication required");
    }
    const roles = authContext.roles || this.getUserRoles(authContext.cloudUserId);
    const allowed = requiredRoles.some((r) => roles.includes(r));
    if (!allowed) {
      throw new ContractError(
        "FORBIDDEN",
        `Insufficient RBAC role; required one of: ${requiredRoles.join(", ")}`
      );
    }
  }

  recordAudit({
    actor_kind = "SYSTEM",
    actor_ref = "system",
    action,
    resource_kind,
    resource_ref,
    outcome = "SUCCESS",
    detail = null
  }) {
    const entry = {
      id: crypto.randomUUID(),
      actor_kind,
      actor_ref,
      action,
      resource_kind,
      resource_ref,
      outcome,
      detail: detail ? redactSensitiveFields(detail) : null,
      created_at: new Date().toISOString()
    };
    this.auditEvents.push(entry);
    this.saveSnapshot();
    return entry;
  }

  addNotification({ cloudUserId, category, title, body }) {
    const id = crypto.randomUUID();
    const n = {
      id,
      cloud_user_id: cloudUserId,
      category,
      title,
      body,
      read_at: null,
      created_at: new Date().toISOString()
    };
    this.notifications.set(id, n);
    this.saveSnapshot();
    return n;
  }

  haltAllUserPlansAndBindings(cloudUserId, reason = "CONSENT_WITHDRAWN", nowMs = Date.now()) {
    const ts = new Date(nowMs).toISOString();
    const cancelledJobIds = [];

    for (const b of this.schoolBindings.values()) {
      if (b.cloud_user_id === cloudUserId && !b.revoked_at) {
        b.revoked_at = ts;
        b.status = "REVOKED";
        if (b.credential_ref && this.encryptedCredentials.has(b.credential_ref)) {
          this.encryptedCredentials.get(b.credential_ref).revoked_at = ts;
        }
      }
    }

    for (const c of this.consents.values()) {
      if (c.cloud_user_id === cloudUserId && !c.withdrawn_at) {
        c.withdrawn_at = ts;
      }
    }

    for (const p of this.reservationPlans.values()) {
      if (p.cloud_user_id === cloudUserId && p.enabled) {
        p.enabled = false;
      }
    }

    for (const j of this.reservationJobs.values()) {
      if (
        j.cloud_user_id === cloudUserId &&
        !["CONFIRMED", "FAILED", "CANCELLED", "EXPIRED", "REVOKED"].includes(j.state)
      ) {
        j.state = "CANCELLED";
        j.state_version += 1;
        j.last_error_code = reason;
        cancelledJobIds.push(j.id);
      }
    }

    this.recordAudit({
      actor_kind: "USER",
      actor_ref: cloudUserId,
      action: "HALT_ALL_PLANS_AND_BINDINGS",
      resource_kind: "cloud_user",
      resource_ref: cloudUserId,
      outcome: reason,
      detail: { cancelled_job_ids: cancelledJobIds }
    });

    return { cancelledJobIds };
  }

  revokeSchoolBindingCascade(cloudUserId, bindingId, reason = "BINDING_REVOKED", nowMs = Date.now()) {
    const binding = this.schoolBindings.get(bindingId);
    if (!binding || binding.cloud_user_id !== cloudUserId) {
      throw new ContractError("NOT_FOUND", "School binding not found");
    }
    const ts = new Date(nowMs).toISOString();
    binding.revoked_at = ts;
    binding.status = "REVOKED";
    if (binding.credential_ref && this.encryptedCredentials.has(binding.credential_ref)) {
      this.encryptedCredentials.get(binding.credential_ref).revoked_at = ts;
    }

    const cancelledJobIds = [];
    for (const p of this.reservationPlans.values()) {
      if (p.school_binding_id === bindingId) {
        p.enabled = false;
      }
    }
    for (const j of this.reservationJobs.values()) {
      if (
        j.school_binding_id === bindingId &&
        !["CONFIRMED", "FAILED", "CANCELLED", "EXPIRED", "REVOKED"].includes(j.state)
      ) {
        j.state = "CANCELLED";
        j.state_version += 1;
        j.last_error_code = reason;
        cancelledJobIds.push(j.id);
      }
    }

    this.recordAudit({
      actor_kind: "USER",
      actor_ref: cloudUserId,
      action: "REVOKE_SCHOOL_BINDING",
      resource_kind: "school_binding",
      resource_ref: bindingId,
      outcome: reason,
      detail: { cancelled_job_ids: cancelledJobIds }
    });

    return { binding, cancelledJobIds };
  }
}
