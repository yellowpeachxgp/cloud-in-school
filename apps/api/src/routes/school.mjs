import crypto from "node:crypto";
import { route } from "./route-table.mjs";
import {
  ContractError,
  DEFAULT_SCHOOL_ID
} from "../../../../packages/contracts/src/index.mjs";
import {
  escrowCredentialForBindings
} from "../../../../packages/crypto/src/index.mjs";

export function createSchoolRoutes(ctx) {
  const {
    store,
    kmsVault,
    schoolProvider,
    redisBuffer,
    syncUserToSso,
    extractBearer
  } = ctx;

  return [
  route("GET", "/api/v1/schools", "listSchools", "public", async () => {
    const { value: schools, cacheStatus } = await redisBuffer.getOrCompute(
      "schools",
      "list",
      300,
      async () =>
        Array.from(store.schoolIntegrations.values()).map((s) => ({
          school_id: s.school_id,
          display_name: s.display_name,
          provider_id: s.provider_id,
          enabled: s.enabled,
          kill_switch: s.kill_switch
        }))
    );
    return {
      status: 200,
      headers: { "x-cache": cacheStatus },
      code: "SCHOOLS_LISTED",
      data: { schools }
    };
  }),

  route(
    "GET",
    "/api/v1/schools/{schoolId}/library/capabilities",
    "getSchoolLibraryCapabilities",
    "public",
    async ({ params }) => {
      const { value: capabilities, cacheStatus } = await redisBuffer.getOrCompute(
        "schools",
        `caps:${params.schoolId}`,
        300,
        async () => {
          const integ = store.schoolIntegrations.get(params.schoolId);
          if (!integ) throw new ContractError("NOT_FOUND", `Unknown school: ${params.schoolId}`);
          return schoolProvider.getCapabilities(integ);
        }
      );
      return {
        status: 200,
        headers: { "x-cache": cacheStatus },
        code: "SCHOOL_CAPABILITIES_OK",
        data: { capabilities }
      };
    }
  ),

  route(
    "GET",
    "/api/v1/schools/{schoolId}/library/rules",
    "getSchoolLibraryRules",
    "public",
    async ({ params }) => {
      if (params.schoolId !== "haut") {
        throw new ContractError("NOT_FOUND", `Unknown school: ${params.schoolId}`);
      }
      return { status: 200, code: "SCHOOL_RULES_OK", data: schoolProvider.getRules() };
    }
  ),

  route(
    "GET",
    "/api/v1/schools/{schoolId}/booking-rules",
    "getSchoolBookingRulesCanonical",
    "public",
    async ({ params }) => {
      if (params.schoolId !== "haut") {
        throw new ContractError("NOT_FOUND", `Unknown school: ${params.schoolId}`);
      }
      return { status: 200, code: "SCHOOL_BOOKING_RULES_OK", data: schoolProvider.getRules() };
    }
  ),

  route("GET", "/api/v1/school-bindings", "listMySchoolBindings", "bearer", async ({ auth }) => {
    const bindings = store.recordsForUser("schoolBindings", auth.cloudUserId)
      .map((b) => ({
        id: b.id,
        school_id: b.school_id,
        student_no: b.student_no || b.student_no_masked || "",
        student_no_masked: b.student_no_masked,
        status: b.status,
        created_at: b.created_at,
        revoked_at: b.revoked_at
      }));
    return { status: 200, code: "SCHOOL_BINDINGS_LISTED", data: { bindings } };
  }),

  route(
    "POST",
    "/api/v1/school-bindings",
    "initiateSchoolBinding",
    "bearer",
    async ({ auth, body, nowMs }) => {
      const schoolId = body?.school_id || DEFAULT_SCHOOL_ID;
      if (!store.schoolIntegrations.has(schoolId)) {
        throw new ContractError("NOT_FOUND", `Unsupported school_id: ${schoolId}`);
      }
      const explicitSno = typeof body?.student_no === "string" ? body.student_no.trim() : "";
      const studentNo = explicitSno || "20240001";
      const authVer = Number(store.users.get(auth.cloudUserId)?.auth_version || 1);
      const latestConsent =
        store.getLatestActiveConsent(auth.cloudUserId, schoolId, authVer) ||
        store.getLatestActiveConsent(auth.cloudUserId, schoolId);
      const reqConsentId = body?.consent_id ? String(body.consent_id).trim() : "";
      if (reqConsentId) {
        const reqConsent = store.consents.get(reqConsentId);
        if (reqConsent && (reqConsent.withdrawn_at || reqConsent.cloud_user_id !== auth.cloudUserId)) {
          throw new ContractError("CONSENT_WITHDRAWN", "Specified consent record is invalid or withdrawn");
        }
      }
      const effectiveConsentId = latestConsent?.id || reqConsentId || null;
      if (explicitSno && explicitSno !== "haut_bound_user") {
        const reusableBinding = store.getPreferredActiveSchoolBinding(auth.cloudUserId, schoolId, {
          studentNo,
          authVersion: authVer,
          nowMs
        });
        if (reusableBinding) {
          reusableBinding.consent_id = effectiveConsentId || reusableBinding.consent_id || null;
          store.saveSnapshot();
          return { status: 201, code: "SCHOOL_BINDING_INITIATED", data: reusableBinding };
        }
      }
      const bindingId = crypto.randomUUID();
      const binding = {
        id: bindingId,
        cloud_user_id: auth.cloudUserId,
        school_id: schoolId,
        student_no: studentNo,
        student_no_masked:
          studentNo.length >= 4
            ? `${studentNo.slice(0, 2)}***${studentNo.slice(-2)}`
            : "***",
        status: "PENDING_DELEGATION",
        credential_ref: null,
        credential_expires_at: null,
        consent_id: effectiveConsentId,
        auth_version: authVer,
        created_at: new Date(nowMs).toISOString(),
        revoked_at: null
      };
      store.schoolBindings.set(bindingId, binding);
      store.indexUserScoped?.("schoolBindings", bindingId, binding.cloud_user_id);
      store.saveSnapshot();
      return { status: 201, code: "SCHOOL_BINDING_INITIATED", data: binding };
    }
  ),

  route(
    "POST",
    "/api/v1/school-bindings/{bindingId}/complete",
    "completeSchoolBinding",
    "bearer",
    async ({ auth, params, body, nowMs }) => {
      const binding = store.schoolBindings.get(params.bindingId);
      if (!binding || binding.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "School binding not found");
      }
      if (binding.revoked_at || binding.status === "REVOKED") {
        throw new ContractError("CONSENT_WITHDRAWN", "Revoked school binding cannot be completed");
      }
      const secretPayload = body?.delegated_secret || body?.session_token || "delegated_session_v1";
      if (typeof secretPayload === "string" && secretPayload.trim().startsWith("{")) {
        try {
          const parsedSec = JSON.parse(secretPayload.trim());
          const secSno = String(parsedSec.student_no || parsedSec.studentId || "").trim();
          const bindSno = String(binding.student_no || "").trim();
          if (secSno && bindSno && secSno !== bindSno) {
            throw new ContractError(
              "FORBIDDEN",
              "delegated_secret student_no does not match binding student_no"
            );
          }
        } catch (e) {
          if (e instanceof ContractError) throw e;
        }
      }
      const escrowed = escrowCredentialForBindings({
        store,
        kmsVault,
        bindings: [binding],
        cloudUserId: auth.cloudUserId,
        schoolId: binding.school_id,
        studentNo: binding.student_no,
        credentialKind: body?.credential_kind || "DELEGATED_SESSION_BUNDLE",
        plaintext: secretPayload,
        expiresAt:
          body?.expires_at || new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString(),
        nowMs
      });
      const encrypted = escrowed.get(binding.id);
      // If another active binding for the same school has a DIFFERENT student_no, revoke it first so old student's plans are invalidated!
      const targetBindSno = String(binding.student_no || "").trim();
      for (const other of store.recordsForUser("schoolBindings", auth.cloudUserId)) {
        if (
          other.id !== binding.id &&
          other.school_id === binding.school_id &&
          !other.revoked_at &&
          other.status !== "REVOKED" &&
          targetBindSno &&
          String(other.student_no || "").trim() &&
          String(other.student_no || "").trim() !== targetBindSno
        ) {
          store.revokeSchoolBindingCascade(
            auth.cloudUserId,
            other.id,
            "SCHOOL_IDENTITY_REBOUND",
            nowMs
          );
        }
      }
      const authVer = Number(store.users.get(auth.cloudUserId)?.auth_version || 1);
      let latestConsent =
        store.getLatestActiveConsent?.(auth.cloudUserId, binding.school_id, authVer) ||
        store.getLatestActiveConsent?.(auth.cloudUserId, binding.school_id, null) ||
        null;
      if (!latestConsent) {
        const cid = crypto.randomUUID();
        latestConsent = {
          id: cid,
          cloud_user_id: auth.cloudUserId,
          school_id: binding.school_id,
          scope_list: ["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"],
          policy_version: "policy-2026-11-v4",
          auth_version: authVer,
          granted_at: new Date(nowMs).toISOString(),
          withdrawn_at: null
        };
        store.consents.set(cid, latestConsent);
        store.indexUserScoped?.("consents", cid, latestConsent.cloud_user_id);
      }
      store.encryptedCredentials.set(encrypted.id, encrypted);
      binding.credential_ref = encrypted.id;
      binding.credential_expires_at = encrypted.expires_at;
      binding.status = "DELEGATED_ACTIVE";
      binding.auth_version = authVer;
      binding.consent_id = latestConsent?.id || body?.consent_id || binding.consent_id || null;
      store.clearIntegrityReconfirmForBindings?.([binding]);
      if (latestConsent) {
        latestConsent.auth_version = authVer;
      }
      const userForBindSeq = store.users.get(auth.cloudUserId);
      if (userForBindSeq) {
        userForBindSeq._latestBindStartSeq = Number(userForBindSeq._latestBindStartSeq || 0) + 1;
        userForBindSeq._lastBindCommitSeq = Number(userForBindSeq._lastBindCommitSeq || 0) + 1;
      }
      await syncUserToSso(auth.cloudUserId);
      return {
        status: 200,
        code: "SCHOOL_BINDING_COMPLETED",
        data: {
          id: binding.id,
          school_id: binding.school_id,
          student_no: binding.student_no || binding.student_no_masked || "",
          status: binding.status,
          credential_ref: binding.credential_ref,
          credential_expires_at: binding.credential_expires_at
        }
      };
    }
  ),

  route(
    "POST",
    "/api/v1/school-bindings/{bindingId}/reauthorize",
    "reauthorizeSchoolBinding",
    "bearer",
    async ({ auth, params, body, nowMs }) => {
      const binding = store.schoolBindings.get(params.bindingId);
      if (!binding || binding.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "School binding not found");
      }
      const reauthSecret = body?.delegated_secret || "reauthorized_session_v1";
      if (typeof reauthSecret === "string" && reauthSecret.trim().startsWith("{")) {
        let parsedReauth;
        try {
          parsedReauth = JSON.parse(reauthSecret.trim());
        } catch {
          throw new ContractError("BAD_REQUEST", "Malformed delegated_secret JSON");
        }
        const secSno = String(parsedReauth?.student_no || parsedReauth?.studentId || "").trim();
        const bindSno = String(binding.student_no || "").trim();
        if (secSno && bindSno && secSno !== bindSno) {
          throw new ContractError(
            "FORBIDDEN",
            "delegated_secret student_no does not match binding student_no"
          );
        }
      }
      // Old credential records are revoked inside the helper only after the
      // replacement record has been stored (no window without a usable ref).
      const escrowed = escrowCredentialForBindings({
        store,
        kmsVault,
        bindings: [binding],
        cloudUserId: auth.cloudUserId,
        schoolId: binding.school_id,
        studentNo: binding.student_no,
        credentialKind: body?.credential_kind || "DELEGATED_SESSION_BUNDLE",
        plaintext: body?.delegated_secret || "reauthorized_session_v1",
        expiresAt:
          body?.expires_at || new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString(),
        nowMs
      });
      const encrypted = escrowed.get(binding.id);
      const userObj = store.users.get(auth.cloudUserId);
      if (userObj) {
        userObj.auth_version = Number(userObj.auth_version || 1) + 1;
        userObj._latestBindStartSeq = Number(userObj._latestBindStartSeq || 0) + 1;
        userObj._lastBindCommitSeq = Number(userObj._lastBindCommitSeq || 0) + 1;
      }
      const authVer = Number(userObj?.auth_version || 1);
      const latestConsent =
        store.getLatestActiveConsent?.(auth.cloudUserId, binding.school_id, authVer) ||
        store.getLatestActiveConsent?.(auth.cloudUserId, binding.school_id, null) ||
        null;
      store.encryptedCredentials.set(encrypted.id, encrypted);
      binding.credential_ref = encrypted.id;
      binding.credential_expires_at = encrypted.expires_at;
      binding.revoked_at = null;
      binding.status = "DELEGATED_ACTIVE";
      binding.auth_version = authVer;
      binding.consent_id = latestConsent?.id || body?.consent_id || null;
      store.clearIntegrityReconfirmForBindings?.([binding]);
      if (latestConsent) {
        latestConsent.auth_version = authVer;
      }
      return {
        status: 200,
        code: "SCHOOL_BINDING_REAUTHORIZED",
        data: {
          id: binding.id,
          status: binding.status,
          credential_ref: binding.credential_ref,
          consent_id: binding.consent_id,
          auth_version: binding.auth_version
        }
      };
    }
  ),

  route(
    "DELETE",
    "/api/v1/school-bindings/{bindingId}",
    "revokeSchoolBinding",
    "bearer",
    async ({ auth, params, nowMs }) => {
      const res = store.revokeSchoolBindingCascade(
        auth.cloudUserId,
        params.bindingId,
        "USER_REVOKED_BINDING",
        nowMs
      );
      return {
        status: 200,
        code: "SCHOOL_BINDING_REVOKED",
        data: {
          binding_id: params.bindingId,
          status: res.binding.status,
          cancelled_job_ids: res.cancelledJobIds
        }
      };
    }
  ),

  route(
    "POST",
    "/api/v1/school-bindings/bind-live",
    "bindLiveSchoolAccount",
    "bearer",
    async ({ auth, headers, body, nowMs }) => {
      const schoolId = body?.school_id || DEFAULT_SCHOOL_ID;
      const studentNoInput = String(body?.student_no || "").trim();
      const passwordInput = String(body?.password || "").trim();
      const rawTokenInput = String(body?.raw_token || "").trim();
      const casTgcInput = String(body?.cas_tgc || "").trim();

      const entryUser = store.users.get(auth.cloudUserId);
      if (!entryUser || entryUser.status !== "ACTIVE") {
        throw new ContractError(
          "CLOUD_AUTH_REQUIRED",
          "Cloud user account is inactive or deleted"
        );
      }
      if (body?.consent_id) {
        const reqConsent = store.consents.get(String(body.consent_id).trim());
        if (!reqConsent || reqConsent.cloud_user_id !== auth.cloudUserId || reqConsent.withdrawn_at) {
          throw new ContractError("CONSENT_WITHDRAWN", "Specified consent is missing or withdrawn");
        }
      }
      if (body?.binding_id || body?.school_binding_id) {
        const reqBindId = String(body.binding_id || body.school_binding_id).trim();
        const reqBind = store.schoolBindings.get(reqBindId);
        if (
          !reqBind ||
          reqBind.cloud_user_id !== auth.cloudUserId ||
          reqBind.revoked_at ||
          reqBind.status === "REVOKED"
        ) {
          throw new ContractError(
            "CONSENT_WITHDRAWN",
            "Specified school binding is missing or revoked"
          );
        }
      }

      const entryAuthVersion = Number(entryUser.auth_version || 1);
      const entryRevocationSeq = Number(entryUser._lastRevocationSeq || 0);
      const entryBindCommitSeq = Number(entryUser._lastBindCommitSeq || 0);
      const requestBindStartSeq = (entryUser._latestBindStartSeq =
        Number(entryUser._latestBindStartSeq || 0) + 1);
      const entryActiveBindingIds = new Set(
        store
          .recordsForUser("schoolBindings", auth.cloudUserId)
          .filter((b) => b.school_id === schoolId && !b.revoked_at && b.status !== "REVOKED")
          .map((b) => b.id)
      );
      const entryActiveConsentIds = new Set(
        store
          .recordsForUser("consents", auth.cloudUserId)
          .filter((c) => (c.school_id || DEFAULT_SCHOOL_ID) === schoolId && !c.withdrawn_at)
          .map((c) => c.id)
      );

      const authRes = await schoolProvider.authenticateHautSession({
        raw_token: rawTokenInput,
        cas_tgc: casTgcInput,
        cas_jsessionid: "",
        student_no: studentNoInput,
        password: passwordInput,
        isLiveCredential: true
      });

      // Re-verify session and account liveness after async school authentication (rejects if logged out or deleted in flight)
      extractBearer(headers, nowMs, "POST");

      const userRecord = store.users.get(auth.cloudUserId);
      if (!userRecord || userRecord.status !== "ACTIVE") {
        throw new ContractError(
          "CLOUD_AUTH_REQUIRED",
          "Cloud user account is inactive or deleted"
        );
      }

      const anyEntryConsentWithdrawn = Array.from(entryActiveConsentIds).some((cid) => {
        const c = store.consents.get(cid);
        return !c || Boolean(c.withdrawn_at);
      });
      const anyEntryBindingRevoked = Array.from(entryActiveBindingIds).some((bid) => {
        const b = store.schoolBindings.get(bid);
        return !b || Boolean(b.revoked_at) || b.status === "REVOKED";
      });
      if (
        Number(userRecord._lastRevocationSeq || 0) !== entryRevocationSeq ||
        anyEntryConsentWithdrawn ||
        anyEntryBindingRevoked
      ) {
        throw new ContractError(
          "CONSENT_WITHDRAWN",
          "学校鉴权等待期间授权同意或学校绑定已被撤回，已拒绝旧绑定请求恢复权限"
        );
      }

      if (
        Number(userRecord.auth_version || 1) !== entryAuthVersion ||
        Number(userRecord._latestBindStartSeq || 0) !== requestBindStartSeq ||
        Number(userRecord._lastBindCommitSeq || 0) !== entryBindCommitSeq
      ) {
        throw new ContractError(
          "CONFLICT",
          "学校鉴权等待期间授权世代已变更或已有更新的绑定请求，已拒绝旧绑定请求覆盖当前状态"
        );
      }

      const resolvedStudentNo = String(authRes.userInfo?.userNo || studentNoInput || "20240001").trim();

      // Strictly forbid in-place mutation of binding.student_no!
      // Any active binding for this school belonging to a DIFFERENT student_no MUST be revoked first (bumping auth_version & halting old plans while preserving confirmed/unknown evidence).
      for (const activeBind of store.recordsForUser("schoolBindings", auth.cloudUserId)) {
        if (
          activeBind.school_id === schoolId &&
          !activeBind.revoked_at &&
          activeBind.status !== "REVOKED" &&
          String(activeBind.student_no || "").trim() !== resolvedStudentNo
        ) {
          store.revokeSchoolBindingCascade(
            auth.cloudUserId,
            activeBind.id,
            "SCHOOL_IDENTITY_REBOUND",
            nowMs
          );
        }
      }

      const currentAuthVersion = Number(userRecord?.auth_version || 1);
      const sameStudentBindings = store
        .recordsForUser("schoolBindings", auth.cloudUserId)
        .filter(
          (b) =>
            b.school_id === schoolId &&
            !b.revoked_at &&
            b.status !== "REVOKED" &&
            String(b.student_no || "").trim() === resolvedStudentNo
        );
      let binding =
        store.getPreferredActiveSchoolBinding?.(auth.cloudUserId, schoolId, {
          studentNo: resolvedStudentNo,
          nowMs
        }) ||
        sameStudentBindings[sameStudentBindings.length - 1] ||
        null;
      if (!binding) {
        const bindingId = crypto.randomUUID();
        binding = {
          id: bindingId,
          cloud_user_id: auth.cloudUserId,
          school_id: schoolId,
          student_no: resolvedStudentNo,
          student_no_masked:
            resolvedStudentNo.length >= 4
              ? `${resolvedStudentNo.slice(0, 2)}***${resolvedStudentNo.slice(-2)}`
              : "***",
          user_name: authRes.userInfo?.userName || "",
          department: authRes.userInfo?.department || "",
          status: "DELEGATED_ACTIVE",
          auth_version: currentAuthVersion,
          credential_ref: null,
          credential_expires_at: null,
          verified_at: new Date(nowMs).toISOString(),
          created_at: new Date(nowMs).toISOString(),
          revoked_at: null
        };
        store.schoolBindings.set(bindingId, binding);
        store.indexUserScoped?.("schoolBindings", bindingId, binding.cloud_user_id);
        sameStudentBindings.push(binding);
      } else {
        for (const sb of sameStudentBindings) {
          sb.user_name = authRes.userInfo?.userName || sb.user_name || "";
          sb.department = authRes.userInfo?.department || sb.department || "";
          sb.status = "DELEGATED_ACTIVE";
          sb.auth_version = currentAuthVersion;
          sb.verified_at = new Date(nowMs).toISOString();
        }
      }

      const credBundleJson = JSON.stringify({
        student_no: resolvedStudentNo,
        password: passwordInput,
        raw_token: authRes.rawToken,
        cas_tgc: authRes.casTgc || "",
        cas_jsessionid: authRes.casJsessionId || "",
        user_name: authRes.userInfo?.userName || "",
        department: authRes.userInfo?.department || ""
      });
      // Per-binding credential escrow: every same-student binding gets its OWN
      // encrypted record (independent DEK/AAD bound to that binding id). A
      // single shared credential_ref breaks the permit's bindingId scope check
      // for every non-owner binding and conflates credential isolation.
      // Orphaned old records are revoked inside the helper only AFTER the new
      // records are stored.
      escrowCredentialForBindings({
        store,
        kmsVault,
        bindings: sameStudentBindings,
        cloudUserId: auth.cloudUserId,
        schoolId,
        studentNo: resolvedStudentNo,
        credentialKind: "DELEGATED_SESSION_BUNDLE",
        plaintext: credBundleJson,
        expiresAt: new Date(nowMs + 14 * 24 * 3600 * 1000).toISOString(),
        nowMs
      });
      store.clearIntegrityReconfirmForBindings?.(sameStudentBindings);

      let consent =
        store.getLatestActiveConsent?.(auth.cloudUserId, schoolId, currentAuthVersion) || null;
      if (!consent) {
        const cid = crypto.randomUUID();
        consent = {
          id: cid,
          cloud_user_id: auth.cloudUserId,
          school_id: schoolId,
          scope_list: ["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"],
          policy_version: "policy-2026-11-v4",
          auth_version: currentAuthVersion,
          granted_at: new Date(nowMs).toISOString(),
          withdrawn_at: null
        };
        store.consents.set(cid, consent);
        store.indexUserScoped?.("consents", cid, consent.cloud_user_id);
      }
      for (const sb of sameStudentBindings) {
        sb.consent_id = consent.id;
      }
      userRecord._lastBindCommitSeq = Number(userRecord._lastBindCommitSeq || 0) + 1;
      store.flushSnapshotStrictSync?.();

      await syncUserToSso(auth.cloudUserId);
      return {
        status: 201,
        code: "SCHOOL_BINDING_LIVE_VERIFIED",
        data: {
          id: binding.id,
          consent_id: consent.id,
          student_no: binding.student_no,
          user_name: authRes.userInfo?.userName || "",
          binding,
          consent,
          user_info: authRes.userInfo
        }
      };
    }
  ),

  route(
    "GET",
    "/api/v1/schools/haut/library/live-regions",
    "getHautLibraryLiveRegions",
    "bearer",
    async ({ auth, headers, query, nowMs }) => {
      const dateParam =
        query.get("booking_date") ||
        query.get("date") ||
        new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const binding =
        store.getPreferredActiveSchoolBinding?.(auth.cloudUserId, DEFAULT_SCHOOL_ID, {
          requireCredential: true,
          nowMs
        }) || null;
      if (!binding) {
        throw new ContractError("CAMPUS_BINDING_REQUIRED", "请先绑定学号与统一认证密码");
      }
      const entryBindAuthVer = Number(binding.auth_version || 1);
      const credRecord = store.encryptedCredentials.get(binding.credential_ref);
      const permit = kmsVault.issueAccessPermit({
        taskId: `live_regions_${Date.now()}`,
        schoolId: binding.school_id,
        bindingId: binding.id,
        credentialRef: binding.credential_ref,
        ttlSeconds: 15,
        nowMs
      });
      const decrypted = kmsVault.decryptSecretWithPermit(credRecord, permit, nowMs);
      const authRes = await schoolProvider.authenticateHautSession(decrypted, binding);
      extractBearer(headers, nowMs, "GET");
      if (
        binding.revoked_at ||
        binding.status === "REVOKED" ||
        Number(binding.auth_version || 1) !== entryBindAuthVer
      ) {
        throw new ContractError("CONSENT_WITHDRAWN", "学校绑定在查询期间已撤销或变更");
      }
      const snap = await schoolProvider.fetchLiveStudyRegions(authRes.rawToken, dateParam);
      const currentBooking = await schoolProvider.fetchCurrentActiveBooking(authRes.rawToken);
      return {
        status: 200,
        code: "LIVE_REGIONS_OK",
        data: {
          ...snap,
          current_booking: currentBooking,
          user_info: authRes.userInfo
        }
      };
    }
  ),

  route(
    "GET",
    "/api/v1/schools/haut/library/live-seats",
    "getHautLibraryLiveSeats",
    "bearer",
    async ({ auth, headers, query, nowMs }) => {
      const regionId = Number(query.get("region_id") || 7);
      const dateParam =
        query.get("booking_date") ||
        query.get("date") ||
        new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const binding =
        store.getPreferredActiveSchoolBinding?.(auth.cloudUserId, DEFAULT_SCHOOL_ID, {
          requireCredential: true,
          nowMs
        }) || null;
      if (!binding) {
        throw new ContractError("CAMPUS_BINDING_REQUIRED", "请先绑定学号与统一认证密码");
      }
      const entryBindAuthVer = Number(binding.auth_version || 1);
      const credRecord = store.encryptedCredentials.get(binding.credential_ref);
      const permit = kmsVault.issueAccessPermit({
        taskId: `live_seats_${Date.now()}`,
        schoolId: binding.school_id,
        bindingId: binding.id,
        credentialRef: binding.credential_ref,
        ttlSeconds: 15,
        nowMs
      });
      const decrypted = kmsVault.decryptSecretWithPermit(credRecord, permit, nowMs);
      const authRes = await schoolProvider.authenticateHautSession(decrypted, binding);
      extractBearer(headers, nowMs, "GET");
      if (
        binding.revoked_at ||
        binding.status === "REVOKED" ||
        Number(binding.auth_version || 1) !== entryBindAuthVer
      ) {
        throw new ContractError("CONSENT_WITHDRAWN", "学校绑定在查询期间已撤销或变更");
      }
      const snap = await schoolProvider.fetchLiveRegionSeats(authRes.rawToken, regionId, dateParam);
      return {
        status: 200,
        code: "LIVE_SEATS_OK",
        data: snap
      };
    }
  )
  ];
}
