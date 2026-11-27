import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCampusCloudApp as createCampusCloudAppBase } from "../apps/api/src/app.mjs";
import { splitLedgerSharesExact } from "../packages/ledger/src/money.mjs";

const BASE_NOW = Date.parse("2026-12-01T00:00:00.000Z");
const DAY = 86_400_000;
let keySeq = 0;
let userSeq = 0;

function createCampusCloudApp(options) {
  const app = createCampusCloudAppBase(options);
  const rawInject = app.inject.bind(app);
  app.inject = (request) => rawInject({ nowMs: BASE_NOW, ...request });
  return app;
}

function nextKey(prefix) {
  keySeq += 1;
  return prefix + "-" + keySeq + "-12345678";
}

function createTestApp(options = {}) {
  return createCampusCloudApp({ requireAdminAccess: false, ...options });
}

function setupUser(app, label, { schoolId = "haut", bind = true, nowMs = BASE_NOW } = {}) {
  const user = app.store.findOrCreateCloudUser({
    issuer: app.identity.expectedIssuer,
    subject: "sub_" + label + "_" + crypto.randomUUID().slice(0, 8),
    username: label,
    displayName: label
  });
  const session = app.identity.issueDeviceSession(user, label, null, 1, nowMs, "MOBILE_APP");
  if (bind) {
    const binding = {
      id: crypto.randomUUID(),
      cloud_user_id: user.id,
      school_id: schoolId,
      student_no: "2024" + String(300000 + (++userSeq)),
      status: "DELEGATED_ACTIVE",
      credential_ref: null,
      consent_id: null,
      auth_version: 1,
      created_at: new Date(nowMs).toISOString(),
      revoked_at: null
    };
    app.store.schoolBindings.set(binding.id, binding);
    app.store.indexUserScoped?.("schoolBindings", binding.id, user.id);
  }
  return { user, session, auth: { authorization: "Bearer " + session.access_token } };
}

function writeHeaders(user, key = nextKey("w403-write")) {
  return { ...user.auth, "idempotency-key": key };
}

async function createGroup(app, owner, overrides = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/groups",
    headers: writeHeaders(owner, nextKey("w403-create-group")),
    body: {
      school_id: "haut",
      type: "dorm",
      name: "宿舍协作测试组",
      description: "ledger duty repair",
      ...overrides
    }
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function inviteAndAccept(app, owner, user, groupId) {
  const invite = await app.inject({
    method: "POST",
    url: "/api/v1/groups/" + groupId + "/invites",
    headers: writeHeaders(owner, nextKey("w403-create-invite")),
    body: { expires_at: new Date(BASE_NOW + DAY).toISOString(), max_uses: 2, label: "宿舍" }
  });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/group-invites/" + invite.body.data.code + "/accept",
    headers: writeHeaders(user, nextKey("w403-accept-invite"))
  });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  return accepted.body.data;
}

function memberRow(app, groupId, cloudUserId) {
  const row = Array.from(app.store.groupMembers.values()).find(
    (member) => member.group_id === groupId && member.cloud_user_id === cloudUserId && member.status === "ACTIVE"
  );
  assert.ok(row, "expected active member row");
  return row;
}

async function createEntry(app, user, groupId, body, key = nextKey("w403-entry")) {
  return app.inject({
    method: "POST",
    url: "/api/v1/groups/" + groupId + "/ledger/entries",
    headers: writeHeaders(user, key),
    body
  });
}

async function createRota(app, user, groupId, body, key = nextKey("w403-rota")) {
  return app.inject({
    method: "POST",
    url: "/api/v1/groups/" + groupId + "/rotas",
    headers: writeHeaders(user, key),
    body
  });
}

async function createRepair(app, user, groupId, body = {}, key = nextKey("w403-repair")) {
  return app.inject({
    method: "POST",
    url: "/api/v1/groups/" + groupId + "/repairs",
    headers: writeHeaders(user, key),
    body: {
      title: "水龙头滴水",
      category: "PLUMBING",
      location_text: "5 号楼 111",
      description: "宿舍水龙头持续滴水",
      ...body
    }
  });
}

async function setupDormGroup(app, label = "main") {
  const owner = setupUser(app, label + "_owner");
  const memberA = setupUser(app, label + "_member_a");
  const memberB = setupUser(app, label + "_member_b");
  const group = await createGroup(app, owner);
  await inviteAndAccept(app, owner, memberA, group.group_id);
  await inviteAndAccept(app, owner, memberB, group.group_id);
  const ownerMember = memberRow(app, group.group_id, owner.user.id);
  const aMember = memberRow(app, group.group_id, memberA.user.id);
  const bMember = memberRow(app, group.group_id, memberB.user.id);
  return { owner, memberA, memberB, group, ownerMember, aMember, bMember };
}

test("W4-03 money: largest remainder, lexicographic tie-break, negative abs-then-negate, and exact conservation", () => {
  const ids = ["a-member", "b-member", "z-member"];
  const positive = splitLedgerSharesExact(100, ids, { type: "EQUAL" });
  assert.deepEqual(positive.map((row) => [row.participant_member_id, Number(row.amount_fen)]), [
    ["a-member", 34],
    ["b-member", 33],
    ["z-member", 33]
  ]);
  assert.equal(positive.reduce((sum, row) => sum + row.amount_fen, 0n), 100n);

  const negative = splitLedgerSharesExact(-101, ids, { type: "EQUAL" });
  assert.deepEqual(negative.map((row) => [row.participant_member_id, Number(row.amount_fen)]), [
    ["a-member", -34],
    ["b-member", -34],
    ["z-member", -33]
  ], "negative totals allocate abs first and then negate every share");
  assert.equal(negative.reduce((sum, row) => sum + row.amount_fen, 0n), -101n);

  const weighted = splitLedgerSharesExact(100, ids, {
    type: "RATIOS",
    ratio_weights: [
      { member_id: "a-member", weight: 1 },
      { member_id: "b-member", weight: 2 }
    ]
  });
  assert.deepEqual(weighted.map((row) => [row.participant_member_id, Number(row.amount_fen)]), [
    ["a-member", 33],
    ["b-member", 67]
  ]);
});

test("W4-03 money: split-fixtures-v1 shared with Android core:ledger match fen-for-fen", () => {
  const fixturePath = path.join(process.cwd(), "tests/fixtures/split-fixtures-v1.csv");
  const lines = fs.readFileSync(fixturePath, "utf8").split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
  assert.equal(lines.length, 9, "split-fixtures-v1 currently carries nine shared cases");
  for (const line of lines) {
    const [caseId, mode, totalRaw, membersRaw, ruleSpec, expectedRaw] = line.split("|");
    const members = membersRaw.split(",");
    let rule;
    if (mode === "EQUAL") rule = { type: "EQUAL" };
    else if (mode === "SELECTED") rule = { type: "SELECTED", participant_member_ids: ruleSpec.split(",") };
    else if (mode === "RATIO") {
      rule = {
        type: "RATIO",
        weights: Object.fromEntries(ruleSpec.split(",").map((row) => {
          const [id, weight] = row.split(":");
          return [id, weight];
        }))
      };
    } else if (mode === "STAY_DAYS") {
      rule = {
        type: "STAY_DAYS",
        days: Object.fromEntries(ruleSpec.split(",").map((row) => {
          const [id, days] = row.split(":");
          return [id, days];
        }))
      };
    } else {
      throw new Error("unknown fixture mode " + mode);
    }
    const actual = splitLedgerSharesExact(totalRaw, members, rule);
    const expected = expectedRaw.split(",").map((row) => {
      const [participant, fen] = row.split("=");
      return { participant_member_id: participant, amount_fen: BigInt(fen) };
    });
    assert.deepEqual(
      actual.map((row) => [row.participant_member_id, row.amount_fen.toString()]),
      expected.map((row) => [row.participant_member_id, row.amount_fen.toString()]),
      caseId + " must match the shared Android fixture exactly"
    );
    assert.equal(
      actual.reduce((sum, row) => sum + row.amount_fen, 0n).toString(),
      totalRaw,
      caseId + " must conserve the signed total"
    );
  }
});

test("W4-03 ledger: immutable entries, correction chain, zero-sum balances, two-party settlement, stale revision, and durable replay", async () => {
  const app = createTestApp();
  const ctx = await setupDormGroup(app, "ledger");
  const ids = [ctx.ownerMember.id, ctx.aMember.id, ctx.bMember.id].sort();
  const key = nextKey("w403-entry-replay");
  const createBody = {
    title: "公共洗衣液",
    note: "本月宿舍公共用品",
    amount_fen: 100,
    paid_by_member_id: ctx.ownerMember.id,
    occurred_at: new Date(BASE_NOW).toISOString(),
    split_rule: { type: "SELECTED", participant_member_ids: [...ids].reverse() }
  };
  const first = await createEntry(app, ctx.owner, ctx.group.group_id, createBody, key);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.data.shares.length, 3);
  assert.deepEqual(first.body.data.shares.map((row) => row.participant_member_id), ids, "shares are lexicographically sorted independent of input order");
  assert.equal(first.body.data.shares.reduce((sum, row) => sum + row.amount_fen, 0), 100);
  const tieWinner = ids[0];
  assert.equal(first.body.data.shares.find((row) => row.participant_member_id === tieWinner).amount_fen, 34);

  const replay = await createEntry(app, ctx.owner, ctx.group.group_id, createBody, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.code, "REQUEST_DUPLICATE");
  assert.equal(replay.body.data.entry_id, first.body.data.entry_id);
  assert.equal(app.store.ledgerEntries.size, 1, "durable replay must not duplicate immutable entries");

  const zero = await createEntry(app, ctx.owner, ctx.group.group_id, { ...createBody, amount_fen: 0 }, nextKey("w403-zero"));
  assert.equal(zero.status, 400);
  const decimal = await createEntry(app, ctx.owner, ctx.group.group_id, { ...createBody, amount_fen: 100.5 }, nextKey("w403-decimal"));
  assert.equal(decimal.status, 400);

  const negative = await createEntry(app, ctx.owner, ctx.group.group_id, {
    title: "多收退回",
    amount_fen: -101,
    paid_by_member_id: ctx.ownerMember.id,
    occurred_at: new Date(BASE_NOW + 1000).toISOString(),
    split_rule: { type: "SELECTED", participant_member_ids: ids }
  });
  assert.equal(negative.status, 201, JSON.stringify(negative.body));
  assert.equal(negative.body.data.shares.reduce((sum, row) => sum + row.amount_fen, 0), -101);
  assert.deepEqual(negative.body.data.shares.map((row) => row.amount_fen).sort((a, b) => a - b), [-34, -34, -33]);

  const correction = await app.inject({
    method: "POST",
    url: "/api/v1/groups/" + ctx.group.group_id + "/ledger/entries/" + first.body.data.entry_id + "/amend",
    headers: writeHeaders(ctx.owner, nextKey("w403-amend")),
    body: {
      reason: "少算一名成员",
      amount_fen: -20,
      paid_by_member_id: ctx.ownerMember.id,
      occurred_at: new Date(BASE_NOW + 2000).toISOString(),
      split_rule: { type: "SELECTED", participant_member_ids: ids }
    }
  });
  assert.equal(correction.status, 201, JSON.stringify(correction.body));
  assert.equal(correction.body.data.entry_kind, "CORRECTION");
  assert.equal(correction.body.data.corrects_entry_id, first.body.data.entry_id);
  assert.equal(app.store.ledgerEntries.get(first.body.data.entry_id).amount_fen, 100, "original posting is never rewritten");

  const secondCorrection = await app.inject({
    method: "POST",
    url: "/api/v1/groups/" + ctx.group.group_id + "/ledger/entries/" + correction.body.data.entry_id + "/amend",
    headers: writeHeaders(ctx.owner, nextKey("w403-amend-chain")),
    body: {
      reason: "更正链补差",
      amount_fen: 5,
      paid_by_member_id: ctx.ownerMember.id,
      occurred_at: new Date(BASE_NOW + 3000).toISOString(),
      split_rule: { type: "SELECTED", participant_member_ids: ids }
    }
  });
  assert.equal(secondCorrection.status, 201, JSON.stringify(secondCorrection.body));
  assert.equal(secondCorrection.body.data.corrects_entry_id, correction.body.data.entry_id, "corrections can target an earlier correction");

  const balances = await app.inject({
    method: "GET",
    url: "/api/v1/groups/" + ctx.group.group_id + "/ledger/balances",
    headers: ctx.owner.auth
  });
  assert.equal(balances.status, 200, JSON.stringify(balances.body));
  assert.equal(balances.body.data.zero_sum_check_fen, 0);
  assert.equal(balances.body.data.balance_revision, 4);
  assert.equal(balances.body.data.members.reduce((sum, row) => sum + row.balance_fen, 0), 0);
  const byId = Object.fromEntries(balances.body.data.members.map((row) => [row.member_id, row]));
  const memberUser = (memberRow) =>
    memberRow.id === ctx.ownerMember.id ? ctx.owner : memberRow.id === ctx.aMember.id ? ctx.memberA : ctx.memberB;
  const allMembers = [ctx.ownerMember, ctx.aMember, ctx.bMember];
  const creditorMember = allMembers.find((item) => byId[item.id].balance_fen > 0);
  const debtorMember = allMembers.find((item) => byId[item.id].balance_fen < 0);
  assert.ok(creditorMember, "zero-sum mixed postings produce a creditor");
  assert.ok(debtorMember, "zero-sum mixed postings produce a debtor");
  const creditorUser = memberUser(creditorMember);

  const settlement = await app.inject({
    method: "POST",
    url: "/api/v1/groups/" + ctx.group.group_id + "/settlements",
    headers: writeHeaders(memberUser(debtorMember), nextKey("w403-settlement")),
    body: {
      debtor_member_id: debtorMember.id,
      creditor_member_id: creditorMember.id,
      amount_fen: 1,
      basis_balance_revision: balances.body.data.balance_revision,
      note: "线下已核对"
    }
  });
  assert.equal(settlement.status, 201, JSON.stringify(settlement.body));
  assert.equal(settlement.body.data.status, "PENDING_BOTH_CONFIRMATIONS");

  const debtorUser = memberUser(debtorMember);
  const confirm1 = await app.inject({
    method: "POST",
    url: "/api/v1/settlements/" + settlement.body.data.settlement_id + "/confirm",
    headers: writeHeaders(debtorUser, nextKey("w403-confirm-debtor")),
    body: { basis_balance_revision: settlement.body.data.basis_balance_revision }
  });
  assert.equal(confirm1.status, 200, JSON.stringify(confirm1.body));
  assert.equal(confirm1.body.data.status, "PENDING_CREDITOR_CONFIRMATION");

  const repeatSameParty = await app.inject({
    method: "POST",
    url: "/api/v1/settlements/" + settlement.body.data.settlement_id + "/confirm",
    headers: writeHeaders(debtorUser, nextKey("w403-confirm-debtor-repeat")),
    body: { basis_balance_revision: settlement.body.data.basis_balance_revision }
  });
  assert.equal(repeatSameParty.status, 200);
  assert.equal(repeatSameParty.body.data.status, "PENDING_CREDITOR_CONFIRMATION", "same-party confirmation is an idempotent no-op");

  const confirm2 = await app.inject({
    method: "POST",
    url: "/api/v1/settlements/" + settlement.body.data.settlement_id + "/confirm",
    headers: writeHeaders(creditorUser, nextKey("w403-confirm-creditor")),
    body: { basis_balance_revision: settlement.body.data.basis_balance_revision }
  });
  assert.equal(confirm2.status, 200, JSON.stringify(confirm2.body));
  assert.equal(confirm2.body.data.status, "CONFIRMED");
  const settlementEvent = app.store.outboxEvents.find((event) => event.event_type === "settlement.confirmed");
  assert.equal(settlementEvent.payload_json.payment_executed, false, "CONFIRMED is only mutual acknowledgement, never payment success");

  const balancesAfter = await app.inject({
    method: "GET",
    url: "/api/v1/groups/" + ctx.group.group_id + "/ledger/balances",
    headers: ctx.owner.auth
  });
  assert.equal(balancesAfter.body.data.balance_revision, 5, "confirmed settlement increments the balance revision");
  assert.equal(balancesAfter.body.data.members.reduce((sum, row) => sum + row.balance_fen, 0), 0);

  const staleProposal = await app.inject({
    method: "POST",
    url: "/api/v1/groups/" + ctx.group.group_id + "/settlements",
    headers: writeHeaders(debtorUser, nextKey("w403-stale-proposal")),
    body: {
      debtor_member_id: debtorMember.id,
      creditor_member_id: creditorMember.id,
      amount_fen: 1,
      basis_balance_revision: balancesAfter.body.data.balance_revision
    }
  });
  assert.equal(staleProposal.status, 201, JSON.stringify(staleProposal.body));
  await app.inject({
    method: "POST",
    url: "/api/v1/groups/" + ctx.group.group_id + "/ledger/entries/" + first.body.data.entry_id + "/amend",
    headers: writeHeaders(ctx.owner, nextKey("w403-stale-amend")),
    body: {
      reason: "使旧结算过期",
      amount_fen: 1,
      paid_by_member_id: ctx.ownerMember.id,
      occurred_at: new Date(BASE_NOW + 4000).toISOString(),
      split_rule: { type: "SELECTED", participant_member_ids: ids }
    }
  });
  const staleConfirm = await app.inject({
    method: "POST",
    url: "/api/v1/settlements/" + staleProposal.body.data.settlement_id + "/confirm",
    headers: writeHeaders(debtorUser, nextKey("w403-stale-confirm")),
    body: { basis_balance_revision: staleProposal.body.data.basis_balance_revision }
  });
  assert.equal(staleConfirm.status, 409);
  assert.equal(staleConfirm.body.error.code, "SETTLEMENT_BALANCE_STALE");

  const history = await app.inject({
    method: "GET",
    url: "/api/v1/groups/" + ctx.group.group_id + "/ledger/entries?corrects_entry_id=" + first.body.data.entry_id,
    headers: ctx.owner.auth
  });
  assert.equal(history.status, 200);
  assert.equal(history.body.data.length, 2, "direct correction history remains append-only and visible");
});

test("W4-03 duty: deterministic rota tasks, peer completion confirmation, skip disposition, and audited one-task cover reassignment", async () => {
  const app = createTestApp();
  const ctx = await setupDormGroup(app, "duty");
  const rotation = [ctx.ownerMember.id, ctx.aMember.id, ctx.bMember.id];
  const denied = await createRota(app, ctx.memberA, ctx.group.group_id, {
    title: "扫地",
    rotation_member_ids: rotation,
    frequency: "WEEKLY",
    days_of_week: [2],
    start_date: "2026-12-01",
    time_zone: "Asia/Shanghai",
    generate_weeks_ahead: 3
  });
  assert.equal(denied.status, 403);

  const rota = await createRota(app, ctx.owner, ctx.group.group_id, {
    title: "扫地",
    rotation_member_ids: rotation,
    frequency: "WEEKLY",
    days_of_week: [2],
    start_date: "2026-12-01",
    time_zone: "Asia/Shanghai",
    generate_weeks_ahead: 3
  });
  assert.equal(rota.status, 201, JSON.stringify(rota.body));
  const tasks = await app.inject({
    method: "GET",
    url: "/api/v1/groups/" + ctx.group.group_id + "/duty-tasks?from_date=2026-12-01&to_date=2026-12-31",
    headers: ctx.owner.auth
  });
  assert.equal(tasks.status, 200, JSON.stringify(tasks.body));
  assert.equal(tasks.body.data.length, 3);
  assert.deepEqual(tasks.body.data.map((row) => row.due_date), ["2026-12-01", "2026-12-08", "2026-12-15"]);
  assert.deepEqual(tasks.body.data.map((row) => row.assigned_member_id), rotation);

  const firstTask = tasks.body.data[0];
  const wrongComplete = await app.inject({
    method: "POST",
    url: "/api/v1/duty-tasks/" + firstTask.task_id + "/complete",
    headers: writeHeaders(ctx.memberA, nextKey("w403-wrong-complete")),
    body: {}
  });
  assert.equal(wrongComplete.status, 403);
  const complete = await app.inject({
    method: "POST",
    url: "/api/v1/duty-tasks/" + firstTask.task_id + "/complete",
    headers: writeHeaders(ctx.owner, nextKey("w403-complete")),
    body: { completion_note: "已完成并拍照" }
  });
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  assert.equal(complete.body.data.status, "COMPLETED");
  const selfConfirm = await app.inject({
    method: "POST",
    url: "/api/v1/duty-tasks/" + firstTask.task_id + "/confirm",
    headers: writeHeaders(ctx.owner, nextKey("w403-self-confirm")),
    body: {}
  });
  assert.equal(selfConfirm.status, 403);
  assert.equal(selfConfirm.body.error.code, "DUTY_CONFIRMATION_NOT_ALLOWED");
  const confirm = await app.inject({
    method: "POST",
    url: "/api/v1/duty-tasks/" + firstTask.task_id + "/confirm",
    headers: writeHeaders(ctx.memberA, nextKey("w403-confirm-task")),
    body: { confirmation_note: "确认干净" }
  });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  assert.equal(confirm.body.data.status, "CONFIRMED");
  const terminalComplete = await app.inject({
    method: "POST",
    url: "/api/v1/duty-tasks/" + firstTask.task_id + "/complete",
    headers: writeHeaders(ctx.owner, nextKey("w403-terminal-complete")),
    body: {}
  });
  assert.equal(terminalComplete.status, 409);

  const secondTask = tasks.body.data[1];
  const skip = await app.inject({
    method: "POST",
    url: "/api/v1/duty-tasks/" + secondTask.task_id + "/skip",
    headers: writeHeaders(ctx.owner, nextKey("w403-skip")),
    body: { skip_reason: "请假且无 accepted cover" }
  });
  assert.equal(skip.status, 200, JSON.stringify(skip.body));
  assert.equal(skip.body.data.status, "SKIPPED");

  const thirdTask = tasks.body.data[2];
  const swap = await app.inject({
    method: "POST",
    url: "/api/v1/rotas/" + rota.body.data.rota_id + "/swaps",
    headers: writeHeaders(ctx.memberB, nextKey("w403-swap")),
    body: {
      duty_task_id: thirdTask.task_id,
      type: "COVER",
      target_member_id: ctx.ownerMember.id,
      reason: "考试周冲突"
    }
  });
  assert.equal(swap.status, 201, JSON.stringify(swap.body));
  const resolve = await app.inject({
    method: "POST",
    url: "/api/v1/duty-swaps/" + swap.body.data.swap_id + "/resolve",
    headers: writeHeaders(ctx.owner, nextKey("w403-swap-resolve")),
    body: { action: "ACCEPT", resolution_note: "本周我顶班" }
  });
  assert.equal(resolve.status, 200, JSON.stringify(resolve.body));
  assert.equal(resolve.body.data.status, "ACCEPTED");
  const afterTasks = await app.inject({
    method: "GET",
    url: "/api/v1/groups/" + ctx.group.group_id + "/duty-tasks?status=PENDING",
    headers: ctx.owner.auth
  });
  assert.equal(afterTasks.body.data.find((row) => row.task_id === thirdTask.task_id).assigned_member_id, ctx.ownerMember.id);
  const swapHistory = await app.inject({
    method: "GET",
    url: "/api/v1/rotas/" + rota.body.data.rota_id + "/swaps?status=ACCEPTED",
    headers: ctx.owner.auth
  });
  assert.equal(swapHistory.body.data.length, 1, "terminal accepted swap remains visible for audit");

  const originalAssignments = new Map(app.store.dutyTasks instanceof Map ? Array.from(app.store.dutyTasks.entries()) : []);
  const update = await app.inject({
    method: "PATCH",
    url: "/api/v1/rotas/" + rota.body.data.rota_id,
    headers: writeHeaders(ctx.owner, nextKey("w403-rota-update")),
    body: { rotation_member_ids: [rotation[1], rotation[2], rotation[0]], generate_weeks_ahead: 3 }
  });
  assert.equal(update.status, 200, JSON.stringify(update.body));
  for (const [taskId, before] of originalAssignments) {
    assert.equal(app.store.dutyTasks.get(taskId).assigned_member_id, before.assigned_member_id, "rota metadata update never rewrites existing duty tasks");
  }
});

test("W4-03 repairs: group-only workflow, revisioned edits, explicit transitions, one-time reporter review, and no official work order claim", async () => {
  const app = createTestApp();
  const ctx = await setupDormGroup(app, "repair");
  const create = await createRepair(app, ctx.memberA, ctx.group.group_id);
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const repairId = create.body.data.repair_id;
  assert.equal(create.body.data.status, "OPEN");

  const update = await app.inject({
    method: "PATCH",
    url: "/api/v1/repairs/" + repairId,
    headers: writeHeaders(ctx.memberA, nextKey("w403-repair-update")),
    body: { description: "水龙头滴水变大，需要协调处理" }
  });
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.equal(app.store.repairTicketRevisions.size, 1, "metadata edit is revisioned");

  const invalidTransition = await app.inject({
    method: "POST",
    url: "/api/v1/repairs/" + repairId + "/status",
    headers: writeHeaders(ctx.owner, nextKey("w403-repair-invalid-transition")),
    body: { to_status: "RESOLVED" }
  });
  assert.equal(invalidTransition.status, 409);
  assert.equal(invalidTransition.body.error.code, "REPAIR_STATUS_TRANSITION_INVALID");

  for (const [action, toStatus, extra] of [
    ["triage", "TRIAGED", { assigned_member_id: ctx.ownerMember.id }],
    ["start", "IN_PROGRESS", {}],
    ["resolve", "RESOLVED", { note: "宿舍内部已协调更换" }]
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/repairs/" + repairId + "/status",
      headers: writeHeaders(ctx.owner, nextKey("w403-repair-" + action)),
      body: { to_status: toStatus, ...extra }
    });
    assert.equal(response.status, 200, action + ": " + JSON.stringify(response.body));
    assert.equal(response.body.data.status, toStatus);
  }

  const closeBeforeReview = await app.inject({
    method: "POST",
    url: "/api/v1/repairs/" + repairId + "/status",
    headers: writeHeaders(ctx.owner, nextKey("w403-close-before-review")),
    body: { to_status: "CLOSED" }
  });
  assert.equal(closeBeforeReview.status, 409);
  const review = await app.inject({
    method: "POST",
    url: "/api/v1/repairs/" + repairId + "/review",
    headers: writeHeaders(ctx.memberA, nextKey("w403-review")),
    body: { rating: 5, comment: "处理及时" }
  });
  assert.equal(review.status, 201, JSON.stringify(review.body));
  const secondReview = await app.inject({
    method: "POST",
    url: "/api/v1/repairs/" + repairId + "/review",
    headers: writeHeaders(ctx.memberA, nextKey("w403-review-second")),
    body: { rating: 4 }
  });
  assert.equal(secondReview.status, 409);
  assert.equal(secondReview.body.error.code, "REPAIR_REVIEW_INVALID");
  const close = await app.inject({
    method: "POST",
    url: "/api/v1/repairs/" + repairId + "/status",
    headers: writeHeaders(ctx.owner, nextKey("w403-repair-close")),
    body: { to_status: "CLOSED" }
  });
  assert.equal(close.status, 200, JSON.stringify(close.body));
  assert.equal(close.body.data.status, "CLOSED");
  const workflowEvents = app.store.outboxEvents.filter((event) => event.aggregate_type === "repair");
  assert.ok(workflowEvents.every((event) => event.payload_json.official_work_order !== true), "repair events can never claim an official work order");
  assert.ok(workflowEvents.some((event) => event.event_type === "repair.reviewed"));
});

test("W4-03 erasure and durability: export coverage, post-delete event/receipt scrubbing, pre-publish rollback, and restart snapshot restore", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dis-w403-ledger-atomic-"));
  const snapshotPath = path.join(tmpDir, "cloud-state.json");
  try {
    const app = createTestApp({ storeOptions: { snapshotPath, requireDurableSnapshot: true } });
    const ctx = await setupDormGroup(app, "erase");
    const ids = [ctx.ownerMember.id, ctx.aMember.id, ctx.bMember.id].sort();
    const entryKey = nextKey("w403-atomic-entry");
    const entryBody = {
      title: "垃圾袋",
      amount_fen: 90,
      paid_by_member_id: ctx.ownerMember.id,
      occurred_at: new Date(BASE_NOW).toISOString(),
      split_rule: { type: "SELECTED", participant_member_ids: ids }
    };
    app.store._persistFaultInject = "tmp_write";
    const failed = await createEntry(app, ctx.owner, ctx.group.group_id, entryBody, entryKey);
    assert.equal(failed.status, 503, JSON.stringify(failed.body));
    assert.equal(failed.body.error.code, "STORAGE_PERSISTENCE_FAILED");
    assert.equal(app.store.ledgerEntries.size, 0, "pre-publish failure rolls back the entry");
    assert.equal(app.store.ledgerBalanceRevisions.size, 0, "pre-publish failure also rolls back a newly-created balance revision row");
    assert.equal(app.store.outboxEvents.some((event) => event.event_type === "ledger.entry.created"), false);
    app.store._persistFaultInject = null;
    const created = await createEntry(app, ctx.owner, ctx.group.group_id, entryBody, entryKey);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.shares.reduce((sum, row) => sum + row.amount_fen, 0), 90);

    const rota = await createRota(app, ctx.owner, ctx.group.group_id, {
      title: "倒垃圾",
      rotation_member_ids: ids,
      frequency: "DAILY",
      start_date: "2026-12-01",
      time_zone: "Asia/Shanghai",
      generate_weeks_ahead: 1
    });
    assert.equal(rota.status, 201, JSON.stringify(rota.body));
    const repair = await createRepair(app, ctx.memberA, ctx.group.group_id);
    assert.equal(repair.status, 201, JSON.stringify(repair.body));

    const exported = await app.inject({ method: "POST", url: "/api/v1/me/data-export", headers: ctx.owner.auth });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.equal(exported.body.data.ledger_entries.length, 1);
    assert.equal(exported.body.data.duty_rotas.length, 1);
    assert.ok(exported.body.data.duty_tasks.length > 0);

    const restarted = createCampusCloudApp({
      requireAdminAccess: false,
      storeOptions: { snapshotPath, requireDurableSnapshot: true }
    });
    assert.equal(restarted.store.ledgerEntries.size, 1, "ledger entry survives restart");
    assert.equal(restarted.store.dutyRotas.size, 1, "duty rota survives restart");
    assert.equal(restarted.store.repairTickets.size, 1, "repair ticket survives restart");
    const commitProbe = {
      reservationPlans: [], reservationJobs: [], scheduleEvents: [], priceQuotes: [], idempotencyRecords: [],
      groups: Array.from(restarted.store.groups.entries()),
      groupMembers: Array.from(restarted.store.groupMembers.entries()),
      groupInvites: Array.from(restarted.store.groupInvites.entries()),
      availabilityShares: [], busyBlocks: [], meetingPolls: [], pollOptions: [], pollVotes: [], confirmedGroupEvents: [],
      ledgerEntries: Array.from(restarted.store.ledgerEntries.entries()),
      ledgerBalanceRevisions: Array.from(restarted.store.ledgerBalanceRevisions.entries()),
      settlements: Array.from(restarted.store.settlements.entries()),
      dutyRotas: Array.from(restarted.store.dutyRotas.entries()),
      dutyTasks: Array.from(restarted.store.dutyTasks.entries()),
      dutySwaps: Array.from(restarted.store.dutySwaps.entries()),
      repairTickets: Array.from(restarted.store.repairTickets.entries()),
      repairTicketRevisions: Array.from(restarted.store.repairTicketRevisions.entries()),
      repairReviews: Array.from(restarted.store.repairReviews.entries()),
      campusGraphPlaces: [], placeReports: [], placeReportFlags: [], placeStatusSubscriptions: []
    };
    assert.doesNotThrow(() => restarted.store._validateCommitUnit(commitProbe), "valid W4-03 snapshot must pass invariant validation");
    const corrupt = structuredClone(commitProbe);
    corrupt.ledgerEntries[0][1].shares[0].amount_fen += 1;
    assert.throws(() => restarted.store._validateCommitUnit(corrupt), /不守恒/);
    clearTimeout(restarted.store._snapshotFlushTimer);

    const deleted = await app.inject({ method: "POST", url: "/api/v1/me/data-delete", headers: ctx.owner.auth });
    assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
    assert.ok(deleted.body.data.ledger_purged, "data-delete reports the ledger purge domain");
    const serializedEvents = JSON.stringify(app.store.outboxEvents.map((event) => event.payload_json));
    assert.equal(serializedEvents.includes(ctx.owner.user.id), false, "ledger/dorm event payloads no longer expose the erased cloud user id");
    assert.equal(Array.from(app.store.idempotencyRecords.keys()).some((key) => key.includes(ctx.owner.user.id) && key.startsWith("createLedgerEntry|")), false);
    clearTimeout(app.store._snapshotFlushTimer);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
