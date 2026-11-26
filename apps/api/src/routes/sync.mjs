import crypto from "node:crypto";
import { route } from "./route-table.mjs";
import {
  ContractError,
  DEFAULT_SCHOOL_ID
} from "../../../../packages/contracts/src/index.mjs";
import {
  escrowCredentialForBindings
} from "../../../../packages/crypto/src/index.mjs";

export function createSyncRoutes(ctx) {
  const {
    store,
    kmsVault,
    schoolProvider,
    reservationEngine,
    parcelHub,
    syncUserToSso,
    buildUserSyncSnapshot
  } = ctx;

  return [
  route("GET", "/api/v1/sync/snapshot", "getUserSyncSnapshot", "bearer", async ({ auth }) => {
    const snapshot = await buildUserSyncSnapshot(auth.cloudUserId);
    return {
      status: 200,
      code: "SYNC_SNAPSHOT_OK",
      data: snapshot
    };
  }),

  route("POST", "/api/v1/sync/snapshot", "pushUserSyncSnapshot", "bearer", async ({ auth, body, nowMs }) => {
    if (body && typeof body === "object") {
      const serverAuthVersion = Number(store.users.get(auth.cloudUserId)?.auth_version || 1);
      const hasHistoricalRevocationOrWithdrawal =
        serverAuthVersion > 1 ||
        store
          .recordsForUser("schoolBindings", auth.cloudUserId)
          .some((b) => Boolean(b.revoked_at) || b.status === "REVOKED") ||
        store.recordsForUser("consents", auth.cloudUserId).some((c) => Boolean(c.withdrawn_at));

      if (
        body.auth_version !== undefined &&
        body.auth_version !== null &&
        Number(body.auth_version) !== serverAuthVersion
      ) {
        throw new ContractError(
          "CONFLICT",
          "Snapshot auth_version does not match current server authorization version"
        );
      }

      // Phase 1: Full pre-validation of all binding upserts and plan upserts BEFORE any state mutation
      const validatedBindingUpserts = [];
      if (Array.isArray(body.school_binding_upserts)) {
        for (const bItem of body.school_binding_upserts) {
          const studentNo = String(bItem?.student_no || "").trim();
          if (!studentNo) continue;
          const schoolId = bItem?.school_id || DEFAULT_SCHOOL_ID;
          if (!store.schoolIntegrations.has(schoolId)) {
            throw new ContractError("NOT_FOUND", `Unsupported school_id: ${schoolId}`);
          }
          let cleanSecretText = null;
          if (bItem?.delegated_secret && String(bItem.delegated_secret).trim()) {
            cleanSecretText = String(bItem.delegated_secret).trim();
            if (cleanSecretText.startsWith("{")) {
              let parsedSecret;
              try {
                parsedSecret = JSON.parse(cleanSecretText);
              } catch {
                throw new ContractError("BAD_REQUEST", "Malformed delegated_secret JSON");
              }
              const secretSno = String(
                parsedSecret?.student_no || parsedSecret?.studentId || parsedSecret?.userNo || ""
              ).trim();
              if (secretSno && secretSno !== studentNo) {
                throw new ContractError(
                  "FORBIDDEN",
                  "delegated_secret student_no does not match school_binding_upserts student_no"
                );
              }
            }
            if (typeof schoolProvider?.parseCredentialBundle === "function") {
              schoolProvider.parseCredentialBundle(cleanSecretText, { student_no: studentNo });
            }
          }

          const reqBindId = String(
            bItem?.binding_id ||
              bItem?.school_binding_id ||
              bItem?.id ||
              body?.school_binding_id ||
              body?.binding_id ||
              ""
          ).trim();
          const reqConsentId = String(bItem?.consent_id || body?.consent_id || "").trim();
          const reqAuthVer = bItem?.auth_version ?? body?.auth_version ?? null;

          if (reqAuthVer !== null && Number(reqAuthVer) !== serverAuthVersion) {
            throw new ContractError("CONFLICT", "Stale school_binding_upserts auth_version");
          }

          const allBindingsForStudent = store
            .recordsForUser("schoolBindings", auth.cloudUserId)
            .filter(
              (b) =>
                b.school_id === schoolId &&
                String(b.student_no || "").trim() === studentNo
            );
          const sameStudentBindings = allBindingsForStudent.filter(
            (b) => !b.revoked_at && b.status !== "REVOKED"
          );
          const isBindingCurrentlyRevoked =
            allBindingsForStudent.length > 0 && sameStudentBindings.length === 0;

          const userConsentsForSchool = store
            .recordsForUser("consents", auth.cloudUserId)
            .filter((c) => (c.school_id || DEFAULT_SCHOOL_ID) === schoolId);
          const activeConsentsForSchool = userConsentsForSchool.filter((c) => !c.withdrawn_at);
          const isConsentCurrentlyWithdrawn =
            userConsentsForSchool.length > 0 && activeConsentsForSchool.length === 0;

          if (reqBindId) {
            const bObj = store.schoolBindings.get(reqBindId);
            if (
              !bObj ||
              bObj.cloud_user_id !== auth.cloudUserId ||
              bObj.school_id !== schoolId ||
              String(bObj.student_no || "").trim() !== studentNo
            ) {
              throw new ContractError("FORBIDDEN", "Invalid or mismatched binding_id in school_binding_upserts");
            }
            if (
              bObj.revoked_at ||
              bObj.status === "REVOKED" ||
              Number(bObj.auth_version || 1) !== serverAuthVersion
            ) {
              throw new ContractError("CONFLICT", "Revoked or stale binding_id in school_binding_upserts");
            }
          }

          if (reqConsentId) {
            const cObj = store.consents.get(reqConsentId);
            if (
              !cObj ||
              cObj.cloud_user_id !== auth.cloudUserId ||
              (cObj.school_id || DEFAULT_SCHOOL_ID) !== schoolId
            ) {
              throw new ContractError("FORBIDDEN", "Invalid or mismatched consent_id in school_binding_upserts");
            }
            if (cObj.withdrawn_at || Number(cObj.auth_version || 1) !== serverAuthVersion) {
              throw new ContractError("CONFLICT", "Withdrawn or stale consent_id in school_binding_upserts");
            }
          }

          if (reqBindId && reqConsentId) {
            const bObj = store.schoolBindings.get(reqBindId);
            if (bObj.consent_id && bObj.consent_id !== reqConsentId) {
              throw new ContractError(
                "CONFLICT",
                "binding_id and consent_id in school_binding_upserts do not correspond"
              );
            }
          }

          // When the account has undergone revocation/reauthorization (hasHistoricalRevocationOrWithdrawal)
          // and is currently reauthorized (active), any binding upsert MUST carry the current generation
          // binding_id and consent_id (and correspond to each other) so a pre-revocation snapshot cannot overwrite credentials!
          if (
            hasHistoricalRevocationOrWithdrawal &&
            !isBindingCurrentlyRevoked &&
            !isConsentCurrentlyWithdrawn
          ) {
            if (
              !reqBindId ||
              !reqConsentId ||
              reqAuthVer === null ||
              reqAuthVer === undefined ||
              Number(reqAuthVer) !== serverAuthVersion
            ) {
              throw new ContractError(
                "CONFLICT",
                "Stale snapshot rejected: explicit auth_version, binding_id, and consent_id for the current authorization generation are required"
              );
            }
            const bObj = store.schoolBindings.get(reqBindId);
            const cObj = store.consents.get(reqConsentId);
            if (
              !bObj ||
              !cObj ||
              Number(bObj.auth_version || 1) !== serverAuthVersion ||
              Number(cObj.auth_version || 1) !== serverAuthVersion ||
              (bObj.consent_id && bObj.consent_id !== cObj.id)
            ) {
              throw new ContractError(
                "CONFLICT",
                "Stale snapshot rejected: binding_id and consent_id do not match current authorization generation"
              );
            }
          }

          validatedBindingUpserts.push({
            studentNo,
            schoolId,
            cleanSecretText,
            reqBindId: reqBindId || null,
            reqConsentId: reqConsentId || null,
            isBindingCurrentlyRevoked,
            isConsentCurrentlyWithdrawn
          });
        }
      }

      const validatedPlanUpserts = [];
      if (Array.isArray(body.reservation_plan_upserts)) {
        for (const rpItem of body.reservation_plan_upserts) {
          const targetDate = String(rpItem?.target_local_date || "").trim();
          const targetTime = String(rpItem?.target_local_time || "07:00:00").trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) continue;

          const rpBindId = String(
            rpItem?.school_binding_id ||
              rpItem?.binding_id ||
              body?.school_binding_id ||
              body?.binding_id ||
              ""
          ).trim();
          const rpConsentId = String(rpItem?.consent_id || body?.consent_id || "").trim();
          const rpAuthVer = rpItem?.auth_version ?? body?.auth_version ?? null;

          if (rpAuthVer !== null && Number(rpAuthVer) !== serverAuthVersion) {
            throw new ContractError("CONFLICT", "Stale reservation_plan_upserts auth_version");
          }

          if (rpBindId) {
            const bObj = store.schoolBindings.get(rpBindId);
            if (!bObj || bObj.cloud_user_id !== auth.cloudUserId) {
              throw new ContractError("FORBIDDEN", "Invalid school_binding_id in reservation_plan_upserts");
            }
            if (
              bObj.revoked_at ||
              bObj.status !== "DELEGATED_ACTIVE" ||
              Number(bObj.auth_version || 1) !== serverAuthVersion
            ) {
              throw new ContractError("CONFLICT", "Revoked or stale school_binding_id in reservation_plan_upserts");
            }
          }

          if (rpConsentId) {
            const cObj = store.consents.get(rpConsentId);
            if (!cObj || cObj.cloud_user_id !== auth.cloudUserId) {
              throw new ContractError("FORBIDDEN", "Invalid consent_id in reservation_plan_upserts");
            }
            if (cObj.withdrawn_at || Number(cObj.auth_version || 1) !== serverAuthVersion) {
              throw new ContractError("CONFLICT", "Withdrawn or stale consent_id in reservation_plan_upserts");
            }
          }

          if (rpBindId && rpConsentId) {
            const bObj = store.schoolBindings.get(rpBindId);
            const cObj = store.consents.get(rpConsentId);
            if (
              bObj.school_id !== (cObj.school_id || DEFAULT_SCHOOL_ID) ||
              (bObj.consent_id && bObj.consent_id !== cObj.id)
            ) {
              throw new ContractError(
                "CONFLICT",
                "school_binding_id and consent_id in reservation_plan_upserts do not correspond"
              );
            }
          }

          if (hasHistoricalRevocationOrWithdrawal) {
            const hasAnyActiveBind = store
              .recordsForUser("schoolBindings", auth.cloudUserId)
              .some((b) => !b.revoked_at && b.status !== "REVOKED");
            const hasAnyActiveConsent = store
              .recordsForUser("consents", auth.cloudUserId)
              .some((c) => !c.withdrawn_at);
            if (hasAnyActiveBind && hasAnyActiveConsent) {
              if (
                !rpBindId ||
                !rpConsentId ||
                rpAuthVer === null ||
                rpAuthVer === undefined ||
                Number(rpAuthVer) !== serverAuthVersion
              ) {
                throw new ContractError(
                  "CONFLICT",
                  "Stale reservation_plan_upserts rejected: explicit auth_version, school_binding_id, and consent_id for current authorization generation are required"
                );
              }
            }
          }

          validatedPlanUpserts.push({
            rpItem,
            targetDate,
            targetTime,
            rpBindId: rpBindId || null,
            rpConsentId: rpConsentId || null,
            rpAuthVer: rpAuthVer !== null && rpAuthVer !== undefined ? Number(rpAuthVer) : null
          });
        }
      }

      // Phase 2: Atomic state mutation
      for (const {
        studentNo,
        schoolId,
        cleanSecretText,
        reqBindId,
        reqConsentId,
        isBindingCurrentlyRevoked,
        isConsentCurrentlyWithdrawn
      } of validatedBindingUpserts) {
        if (isBindingCurrentlyRevoked || isConsentCurrentlyWithdrawn) {
          continue;
        }

        const allBindingsForStudent = store
          .recordsForUser("schoolBindings", auth.cloudUserId)
          .filter(
            (b) =>
              b.school_id === schoolId &&
              String(b.student_no || "").trim() === studentNo
          );
        const sameStudentBindings = reqBindId
          ? [store.schoolBindings.get(reqBindId)].filter(Boolean)
          : allBindingsForStudent.filter((b) => !b.revoked_at && b.status !== "REVOKED");

        const userConsentsForSchool = store
          .recordsForUser("consents", auth.cloudUserId)
          .filter((c) => (c.school_id || DEFAULT_SCHOOL_ID) === schoolId);
        let activeConsentForBind = reqConsentId
          ? store.consents.get(reqConsentId)
          : store.getLatestActiveConsent?.(auth.cloudUserId, schoolId, serverAuthVersion) ||
            store.getLatestActiveConsent?.(auth.cloudUserId, schoolId, null) ||
            null;

        if (!activeConsentForBind && userConsentsForSchool.length === 0) {
          const cid = crypto.randomUUID();
          activeConsentForBind = {
            id: cid,
            cloud_user_id: auth.cloudUserId,
            school_id: schoolId,
            scope_list: ["LIBRARY_SEAT_RESERVATION", "CREDENTIAL_ESCROW"],
            policy_version: "policy-2026-11-v4",
            auth_version: serverAuthVersion,
            granted_at: new Date(nowMs).toISOString(),
            withdrawn_at: null
          };
          store.indexUserScoped?.("consents", cid, auth.cloudUserId);
          store.consents.set(cid, activeConsentForBind);
        }

        if (sameStudentBindings.length === 0) {
          const bindingId = crypto.randomUUID();
          const createdBind = {
            id: bindingId,
            cloud_user_id: auth.cloudUserId,
            school_id: schoolId,
            student_no: studentNo,
            student_no_masked:
              studentNo.length >= 4 ? `${studentNo.slice(0, 2)}***${studentNo.slice(-2)}` : "***",
            status: "DELEGATED_ACTIVE",
            credential_ref: null,
            credential_expires_at: new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString(),
            consent_id: activeConsentForBind?.id || null,
            auth_version: serverAuthVersion,
            created_at: new Date(nowMs).toISOString(),
            revoked_at: null
          };
          store.schoolBindings.set(bindingId, createdBind);
          store.indexUserScoped?.("schoolBindings", bindingId, createdBind.cloud_user_id);
          sameStudentBindings.push(createdBind);
        } else {
          for (const targetBind of sameStudentBindings) {
            targetBind.status = "DELEGATED_ACTIVE";
            targetBind.auth_version = serverAuthVersion;
            if (activeConsentForBind) {
              const curBindConsent = targetBind.consent_id
                ? store.consents.get(targetBind.consent_id)
                : null;
              if (
                !curBindConsent ||
                curBindConsent.withdrawn_at ||
                Number(curBindConsent.auth_version || 1) !== serverAuthVersion ||
                (!reqConsentId && curBindConsent.id !== activeConsentForBind.id)
              ) {
                targetBind.consent_id = activeConsentForBind.id;
              }
            }
          }
        }

        if (cleanSecretText) {
          escrowCredentialForBindings({
            store,
            kmsVault,
            bindings: sameStudentBindings,
            cloudUserId: auth.cloudUserId,
            schoolId,
            studentNo,
            credentialKind: "DELEGATED_SESSION_BUNDLE",
            plaintext: cleanSecretText,
            expiresAt: new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString(),
            nowMs
          });
          store.clearIntegrityReconfirmForBindings?.(sameStudentBindings);
          for (const targetBind of sameStudentBindings) {
            targetBind.status = "DELEGATED_ACTIVE";
            targetBind.auth_version = serverAuthVersion;
          }
        }
        const syncUserObj = store.users.get(auth.cloudUserId);
        if (syncUserObj) {
          syncUserObj._latestBindStartSeq = Number(syncUserObj._latestBindStartSeq || 0) + 1;
          syncUserObj._lastBindCommitSeq = Number(syncUserObj._lastBindCommitSeq || 0) + 1;
        }
      }

      if (Array.isArray(body.parcel_upserts)) {
        for (const pItem of body.parcel_upserts) {
          if (!pItem || !pItem.tracking_number) continue;
          parcelHub.upsertParcel({
            cloudUserId: auth.cloudUserId,
            trackingNumber: pItem.tracking_number,
            carrierCode: pItem.carrier_code || "cainiao",
            carrierName: pItem.carrier_name || "校园快递",
            providerId: pItem.provider_id || "parcel.manual",
            channel: pItem.channel || "CLIENT_IMPORT",
            status: pItem.status || (pItem.pickup_code ? "READY_FOR_PICKUP" : "IN_TRANSIT"),
            pickupCode: pItem.pickup_code || "",
            stationName: pItem.station_name || "",
            itemTitle: pItem.item_title || "",
            rawNotificationText: pItem.raw_notification_text || "",
            checkpoints: Array.isArray(pItem.checkpoints) ? pItem.checkpoints : [],
            sandboxOverride: false
          });
        }
      }

      if (Array.isArray(body.parcel_status_updates)) {
        const userParcels = parcelHub.listUserParcels(auth.cloudUserId);
        for (const uItem of body.parcel_status_updates) {
          const target = userParcels.find(
            (p) =>
              (uItem.parcel_id && p.id === uItem.parcel_id) ||
              (uItem.tracking_number && p.tracking_number === uItem.tracking_number)
          );
          if (target && uItem.status) {
            target.status = uItem.status;
          }
        }
      }

      if (Array.isArray(body.reservation_cancellations)) {
        for (const cancelId of body.reservation_cancellations) {
          const job = store.reservationJobs.get(cancelId);
          if (job && job.cloud_user_id === auth.cloudUserId) {
            reservationEngine.stopPlanAndActiveJobs({
              planId: job.plan_id,
              jobId: job.id,
              cloudUserId: auth.cloudUserId,
              reason: "客户端同步停止任务委托",
              nowMs
            });
          }
          const plan = store.reservationPlans.get(cancelId);
          if (plan && plan.cloud_user_id === auth.cloudUserId) {
            reservationEngine.stopPlanAndActiveJobs({
              planId: plan.id,
              cloudUserId: auth.cloudUserId,
              reason: "客户端同步停止预约计划委托",
              nowMs
            });
          }
        }
      }

      const bindingResults = [];
      for (const bItem of validatedBindingUpserts) {
        if (bItem.isBindingCurrentlyRevoked || bItem.isConsentCurrentlyWithdrawn) {
          bindingResults.push({
            student_no: bItem.studentNo,
            school_id: bItem.schoolId,
            binding_id: bItem.reqBindId || null,
            status: "SKIPPED_REVOKED",
            reason: "学校绑定或委托授权已处于撤销状态，需重新完成在线授权后方可同步凭据"
          });
        } else {
          bindingResults.push({
            student_no: bItem.studentNo,
            school_id: bItem.schoolId,
            binding_id: bItem.reqBindId || null,
            status: "APPLIED",
            reason: null
          });
        }
      }

      const planResults = [];
      if (validatedPlanUpserts.length > 0) {
        const allUserBindings = store.recordsForUser("schoolBindings", auth.cloudUserId);
        const userActiveBindings = allUserBindings.filter(
          (b) =>
            !b.revoked_at &&
            b.status === "DELEGATED_ACTIVE" &&
            Number(b.auth_version || 1) === serverAuthVersion
        );
        const distinctStudentNos = new Set(
          userActiveBindings.map((b) => String(b.student_no || "").trim()).filter(Boolean)
        );
        const defaultActiveBinding =
          distinctStudentNos.size <= 1 ? userActiveBindings[userActiveBindings.length - 1] || null : null;

        for (const { rpItem, targetDate, targetTime, rpBindId, rpConsentId, rpAuthVer } of validatedPlanUpserts) {
          if (!rpBindId || !rpConsentId || rpAuthVer === null || rpAuthVer !== serverAuthVersion) {
            planResults.push({
              target_local_date: targetDate,
              target_local_time: targetTime,
              binding_id: rpBindId || null,
              status: "NEEDS_RECONFIRMATION",
              reason: "预约计划缺少显式绑定的 school_binding_id、consent_id 或 auth_version，拒绝猜测当前授权，需重新确认授权"
            });
            continue;
          }
          const activeBinding = store.schoolBindings.get(rpBindId);
          if (
            !activeBinding ||
            activeBinding.revoked_at ||
            activeBinding.status !== "DELEGATED_ACTIVE" ||
            Number(activeBinding.auth_version || 0) !== serverAuthVersion
          ) {
            planResults.push({
              target_local_date: targetDate,
              target_local_time: targetTime,
              binding_id: rpBindId || null,
              status: "NEEDS_RECONFIRMATION",
              reason: "缺少当前有效学校绑定或绑定授权版本不匹配，需重新确认授权"
            });
            continue;
          }
          const activeConsent = store.consents.get(rpConsentId);

          if (
            !activeConsent ||
            activeConsent.withdrawn_at ||
            Number(activeConsent.auth_version || 0) !== serverAuthVersion ||
            (activeBinding.consent_id && activeBinding.consent_id !== activeConsent.id)
          ) {
            planResults.push({
              target_local_date: targetDate,
              target_local_time: targetTime,
              binding_id: activeBinding.id,
              status: "NEEDS_RECONFIRMATION",
              reason: "委托同意记录已撤回或与当前授权版本不一致，需重新确认授权"
            });
            continue;
          }

          const alreadyActive = Array.from(store.reservationJobs.values()).some(
            (j) =>
              j.cloud_user_id === auth.cloudUserId &&
              j.school_binding_id === activeBinding.id &&
              j.booking_local_date === targetDate &&
              !["CANCELLED", "FAILED", "EXPIRED", "REVOKED", "SCHOOL_CANCELLED", "SKIPPED_FINANCE", "SKIPPED_AUTH"].includes(j.state)
          );
          if (alreadyActive) {
            planResults.push({
              target_local_date: targetDate,
              target_local_time: targetTime,
              binding_id: activeBinding.id,
              status: "ALREADY_ACTIVE",
              reason: null
            });
            continue;
          }
          const areaName = String(rpItem?.area_name || rpItem?.area_code || "五层中区").trim();
          const seats = Array.isArray(rpItem?.candidate_seats)
            ? rpItem.candidate_seats.map((s) => String(s).trim()).filter(Boolean)
            : ["01桌 B座"];
          const repeatDays = Math.min(Math.max(Number(rpItem?.repeat_days ?? 1) || 1, 1), 30);
          const remainingDays = Math.min(
            Math.max(Number(rpItem?.remaining_days ?? repeatDays) || repeatDays, 1),
            repeatDays
          );
          try {
            const created = reservationEngine.createPlanAndJob(
              auth.cloudUserId,
              {
                school_binding_id: activeBinding.id,
                consent_id: activeConsent.id,
                area_code: areaName,
                area_name: areaName,
                candidate_seats: seats,
                preferred_area_ids: [areaName],
                preferred_seat_ids: seats,
                target_local_date: targetDate,
                target_local_time: targetTime,
                slot_window: rpItem?.slot_window || undefined,
                repeat_days: repeatDays,
                remaining_days: remainingDays,
                allow_alternative_seat: rpItem?.allow_alternative_seat === true,
                replace_existing: false
              },
              nowMs
            );
            planResults.push({
              target_local_date: targetDate,
              target_local_time: targetTime,
              binding_id: activeBinding.id,
              plan_id: created.plan_id,
              job_id: created.job_id,
              status: "CREATED",
              reason: null
            });
          } catch (createErr) {
            planResults.push({
              target_local_date: targetDate,
              target_local_time: targetTime,
              binding_id: activeBinding.id,
              status: "SKIPPED_WINDOW_CLOSED",
              reason: createErr?.message || "预约时间窗口已关闭或参数不合法"
            });
          }
        }
      }

      body._computedSyncReport = {
        auth_version: serverAuthVersion,
        binding_results: bindingResults,
        plan_results: planResults
      };

      await syncUserToSso(auth.cloudUserId);
    }

    const snapshot = await buildUserSyncSnapshot(auth.cloudUserId);
    const serverNeedsReconfirmPlans = (snapshot.reservation_plans || []).filter(
      (p) => p.user_intent_state === "NEEDS_RECONFIRMATION"
    );
    const bindingResults = body?._computedSyncReport?.binding_results || [];
    const planResults = body?._computedSyncReport?.plan_results || [];
    const skippedBindings = bindingResults.filter((r) => r.status !== "APPLIED");
    const skippedPlans = planResults.filter(
      (r) => r.status !== "CREATED" && r.status !== "ALREADY_ACTIVE"
    );
    const skippedCount = skippedBindings.length + skippedPlans.length;
    const reconfirmCount =
      serverNeedsReconfirmPlans.length +
      planResults.filter((r) => r.status === "NEEDS_RECONFIRMATION").length;
    snapshot.sync_report = {
      auth_version: snapshot.auth_version,
      binding_results: bindingResults,
      plan_results: planResults,
      skipped_count: skippedCount,
      plans_needing_reconfirmation_count: reconfirmCount,
      summary_message:
        reconfirmCount > 0 || skippedCount > 0
          ? `余额已更新，${reconfirmCount || skippedCount} 项预约计划或绑定需要重新确认授权`
          : "云端数据已完整同步"
    };
    return {
      status: 200,
      code: "SYNC_SNAPSHOT_OK",
      data: snapshot
    };
  })
  ];
}
