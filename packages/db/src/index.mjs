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

  findOrCreateCloudUser({ issuer, subject, displayName = "XPEACH User" }) {
    const existing = Array.from(this.users.values()).find(
      (u) => u.issuer === issuer && u.subject === subject
    );
    if (existing) {
      if (displayName) existing.display_name = displayName;
      return existing;
    }
    const id = crypto.randomUUID();
    const user = {
      id,
      issuer,
      subject,
      display_name: displayName,
      status: "ACTIVE",
      created_at: new Date().toISOString()
    };
    this.users.set(id, user);
    if (!this.userRoles.has(id)) {
      this.userRoles.set(id, new Set(["USER"]));
    }
    return user;
  }

  getUserRoles(cloudUserId) {
    const set = this.userRoles.get(cloudUserId);
    return set ? Array.from(set) : ["USER"];
  }

  setUserRoles(cloudUserId, roles) {
    this.userRoles.set(cloudUserId, new Set(["USER", ...(roles || [])]));
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
