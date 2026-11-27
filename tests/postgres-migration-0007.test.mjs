import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { REPO_ROOT } from "../packages/contracts/src/index.mjs";

function findLocalDockerWithPostgres() {
  for (const bin of ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "docker"]) {
    try {
      const images = execFileSync(bin, ["images", "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
      if (images.split(/\r?\n/).includes("postgres:17-alpine")) return bin + "|postgres:17-alpine";
      if (images.split(/\r?\n/).includes("postgres:15-alpine")) return bin + "|postgres:15-alpine";
    } catch {}
  }
  return null;
}

test("PostgreSQL migration 0007: CT-03 ledger/duty/repair invariants and repeatable up/down", (t) => {
  const found = findLocalDockerWithPostgres();
  if (!found) {
    t.skip("Local offline postgres Docker image not available on this host");
    return;
  }
  const [dockerBin, pgImage] = found.split("|");
  const migrationsDir = path.join(REPO_ROOT, "packages/db/migrations");
  const script = String.raw`
set -eu
initdb -D /tmp/pgdata >/dev/null
pg_ctl -D /tmp/pgdata -o "-k /tmp" -w start >/dev/null
trap 'pg_ctl -D /tmp/pgdata -m immediate stop >/dev/null 2>&1 || true' EXIT
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0001_initial_campus_cloud.sql >/dev/null
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0005_community_groups.sql >/dev/null
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0007_ledger_dorm_collaboration.sql >/dev/null
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0007_ledger_dorm_collaboration.sql >/dev/null
must_fail() { label="$1"; sql="$2"; if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "$sql" >/dev/null 2>&1; then echo "FAIL: $label"; exit 1; fi; }

psql -h /tmp -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'EOSQL'
INSERT INTO cloud_users (id, display_name, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Owner', 'ACTIVE'),
  ('22222222-2222-4222-8222-222222222222', 'Member', 'ACTIVE');
INSERT INTO "groups" (group_id, school_id, type, name, status, created_by)
VALUES ('55555555-5555-4555-8555-555555555555', 'haut', 'dorm', 'Dorm 5-111', 'ACTIVE', '11111111-1111-4111-8111-111111111111');
INSERT INTO group_members (member_id, group_id, school_id, cloud_user_id, role, sharing_level, status, joined_at) VALUES
  ('77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'haut', '11111111-1111-4111-8111-111111111111', 'OWNER', 'NONE', 'ACTIVE', now()),
  ('88888888-8888-4888-8888-888888888888', '55555555-5555-4555-8555-555555555555', 'haut', '22222222-2222-4222-8222-222222222222', 'MEMBER', 'NONE', 'ACTIVE', now());
INSERT INTO ledger_entries (entry_id, group_id, school_id, entry_kind, title, amount_fen, paid_by_member_id, occurred_at, split_rule_json, created_by_member_id)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '55555555-5555-4555-8555-555555555555', 'haut', 'EXPENSE', '公共用品', 101, '77777777-7777-4777-8777-777777777777', now(), '{"type":"EQUAL"}'::jsonb, '77777777-7777-4777-8777-777777777777');
INSERT INTO ledger_entry_shares (entry_id, participant_member_id, amount_fen) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '77777777-7777-4777-8777-777777777777', 51),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '88888888-8888-4888-8888-888888888888', 50);
INSERT INTO settlements (settlement_id, group_id, school_id, debtor_member_id, creditor_member_id, amount_fen, basis_balance_revision, status, created_by_member_id)
VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '55555555-5555-4555-8555-555555555555', 'haut', '88888888-8888-4888-8888-888888888888', '77777777-7777-4777-8777-777777777777', 50, 1, 'PENDING_BOTH_CONFIRMATIONS', '88888888-8888-4888-8888-888888888888');
INSERT INTO duty_rotas (rota_id, group_id, school_id, title, rotation_member_ids, frequency, days_of_week, start_date, time_zone, generate_weeks_ahead, status, created_by_member_id)
VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '55555555-5555-4555-8555-555555555555', 'haut', '扫地', '["77777777-7777-4777-8777-777777777777","88888888-8888-4888-8888-888888888888"]'::jsonb, 'WEEKLY', '[2]'::jsonb, '2026-12-01', 'Asia/Shanghai', 2, 'ACTIVE', '77777777-7777-4777-8777-777777777777');
INSERT INTO duty_tasks (task_id, rota_id, group_id, school_id, title, assigned_member_id, due_date, status)
VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '55555555-5555-4555-8555-555555555555', 'haut', '扫地', '77777777-7777-4777-8777-777777777777', '2026-12-01', 'PENDING');
INSERT INTO repair_tickets (repair_id, group_id, school_id, title, category, location_text, description, reporter_member_id, status)
VALUES ('12121212-1212-4212-8212-121212121212', '55555555-5555-4555-8555-555555555555', 'haut', '水龙头', 'PLUMBING', '5-111', '滴水', '88888888-8888-4888-8888-888888888888', 'OPEN');
INSERT INTO repair_reviews (review_id, repair_id, group_id, school_id, reviewer_member_id, rating)
VALUES ('abababab-abab-4aba-8aba-abababababab', '12121212-1212-4212-8212-121212121212', '55555555-5555-4555-8555-555555555555', 'haut', '88888888-8888-4888-8888-888888888888', 5);
EOSQL

must_fail "zero ledger amount accepted" "INSERT INTO ledger_entries (entry_id, group_id, school_id, entry_kind, title, amount_fen, paid_by_member_id, occurred_at, split_rule_json, created_by_member_id) VALUES ('bbbbbbbb-0000-4000-8000-bbbbbbbbbbb1', '55555555-5555-4555-8555-555555555555', 'haut', 'EXPENSE', '零额', 0, '77777777-7777-4777-8777-777777777777', now(), '{\"type\":\"EQUAL\"}'::jsonb, '77777777-7777-4777-8777-777777777777')"
must_fail "unlinked correction accepted" "INSERT INTO ledger_entries (entry_id, group_id, school_id, entry_kind, title, amount_fen, paid_by_member_id, occurred_at, split_rule_json, created_by_member_id) VALUES ('bbbbbbbb-0000-4000-8000-bbbbbbbbbbb2', '55555555-5555-4555-8555-555555555555', 'haut', 'CORRECTION', '坏更正', -1, '77777777-7777-4777-8777-777777777777', now(), '{\"type\":\"EQUAL\"}'::jsonb, '77777777-7777-4777-8777-777777777777')"
must_fail "duplicate share participant accepted" "INSERT INTO ledger_entry_shares (entry_id, participant_member_id, amount_fen) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '77777777-7777-4777-8777-777777777777', 1)"
must_fail "same settlement parties accepted" "INSERT INTO settlements (settlement_id, group_id, school_id, debtor_member_id, creditor_member_id, amount_fen, basis_balance_revision, status, created_by_member_id) VALUES ('cccccccc-0000-4000-8000-ccccccccccc1', '55555555-5555-4555-8555-555555555555', 'haut', '77777777-7777-4777-8777-777777777777', '77777777-7777-4777-8777-777777777777', 1, 1, 'PENDING_BOTH_CONFIRMATIONS', '77777777-7777-4777-8777-777777777777')"
must_fail "bad settlement terminal shape accepted" "INSERT INTO settlements (settlement_id, group_id, school_id, debtor_member_id, creditor_member_id, amount_fen, basis_balance_revision, status, created_by_member_id, confirmed_at) VALUES ('cccccccc-0000-4000-8000-ccccccccccc2', '55555555-5555-4555-8555-555555555555', 'haut', '88888888-8888-4888-8888-888888888888', '77777777-7777-4777-8777-777777777777', 1, 1, 'CONFIRMED', '77777777-7777-4777-8777-777777777777', now())"
must_fail "weekly rota without weekday accepted" "INSERT INTO duty_rotas (rota_id, group_id, school_id, title, rotation_member_ids, frequency, days_of_week, start_date, time_zone, generate_weeks_ahead, status, created_by_member_id) VALUES ('dddddddd-0000-4000-8000-ddddddddddd1', '55555555-5555-4555-8555-555555555555', 'haut', '坏轮班', '[\"77777777-7777-4777-8777-777777777777\",\"88888888-8888-4888-8888-888888888888\"]'::jsonb, 'WEEKLY', '[]'::jsonb, '2026-12-01', 'Asia/Shanghai', 2, 'ACTIVE', '77777777-7777-4777-8777-777777777777')"
must_fail "SKIPPED task without audit reason accepted" "INSERT INTO duty_tasks (task_id, rota_id, group_id, school_id, title, assigned_member_id, due_date, status, skipped_at, skipped_by_member_id) VALUES ('eeeeeeee-0000-4000-8000-eeeeeeeeeee1', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '55555555-5555-4555-8555-555555555555', 'haut', '扫地', '77777777-7777-4777-8777-777777777777', '2026-12-02', 'SKIPPED', now(), '77777777-7777-4777-8777-777777777777')"
must_fail "accepted swap without resolution shape accepted" "INSERT INTO duty_swaps (swap_id, rota_id, duty_task_id, group_id, school_id, type, requested_by_member_id, target_member_id, status) VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '55555555-5555-4555-8555-555555555555', 'haut', 'COVER', '77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888', 'ACCEPTED')"
must_fail "official work-order claim accepted" "INSERT INTO repair_tickets (repair_id, group_id, school_id, title, category, location_text, description, reporter_member_id, status, official_work_order) VALUES ('12121212-0000-4000-8000-121212121212', '55555555-5555-4555-8555-555555555555', 'haut', '坏工单', 'OTHER', '5-111', '错误声明', '88888888-8888-4888-8888-888888888888', 'OPEN', TRUE)"
must_fail "second review for same repair accepted" "INSERT INTO repair_reviews (review_id, repair_id, group_id, school_id, reviewer_member_id, rating) VALUES ('abababab-0000-4000-8000-abababababab', '12121212-1212-4212-8212-121212121212', '55555555-5555-4555-8555-555555555555', 'haut', '88888888-8888-4888-8888-888888888888', 4)"
must_fail "cross-school duty task accepted" "INSERT INTO duty_tasks (task_id, rota_id, group_id, school_id, title, assigned_member_id, due_date, status) VALUES ('eeeeeeee-0000-4000-8000-eeeeeeeeeee2', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '55555555-5555-4555-8555-555555555555', 'other-school', '扫地', '77777777-7777-4777-8777-777777777777', '2026-12-02', 'PENDING')"

psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0007_ledger_dorm_collaboration.sql >/dev/null
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0007_ledger_dorm_collaboration.down.sql >/dev/null
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0007_ledger_dorm_collaboration.down.sql >/dev/null
remaining=$(psql -h /tmp -U postgres -Atc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('ledger_entries','ledger_entry_shares','ledger_balance_revisions','settlements','duty_rotas','duty_tasks','duty_swaps','repair_tickets','repair_ticket_revisions','repair_reviews');")
[ "$remaining" = "0" ] || { echo "FAIL: down left W4-03 tables: $remaining"; exit 1; }
community_remaining=$(psql -h /tmp -U postgres -Atc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('groups','group_members','group_invites');")
[ "$community_remaining" = "3" ] || { echo "FAIL: down removed community tables"; exit 1; }
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0007_ledger_dorm_collaboration.sql >/dev/null
recreated=$(psql -h /tmp -U postgres -Atc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('ledger_entries','ledger_entry_shares','ledger_balance_revisions','settlements','duty_rotas','duty_tasks','duty_swaps','repair_tickets','repair_ticket_revisions','repair_reviews');")
[ "$recreated" = "10" ] || { echo "FAIL: recreated $recreated tables rather than 10"; exit 1; }
echo "PG_MIGRATION_0007_VERIFIED_OK"
`;
  const out = execFileSync(dockerBin, ["run", "--rm", "--network", "none", "--user", "postgres", "-v", migrationsDir + ":/migrations:ro", pgImage, "sh", "-c", script], { encoding: "utf8", timeout: 60_000 });
  assert.ok(out.includes("PG_MIGRATION_0007_VERIFIED_OK"), "Unexpected PostgreSQL output: " + out);
});
