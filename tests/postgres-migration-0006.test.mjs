import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { REPO_ROOT } from "../packages/contracts/src/index.mjs";

function findLocalDockerWithPostgres() {
  const candidates = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "docker"];
  for (const bin of candidates) {
    try {
      const images = execFileSync(bin, ["images", "--format", "{{.Repository}}:{{.Tag}}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000
      });
      if (images.split(/\r?\n/).includes("postgres:17-alpine")) return bin + "|postgres:17-alpine";
      if (images.split(/\r?\n/).includes("postgres:15-alpine")) return bin + "|postgres:15-alpine";
    } catch {
      // Try the next Docker binary candidate.
    }
  }
  return null;
}

test("PostgreSQL migration 0006: availability/poll tables enforce CT-02 privacy, quantization, TTL, vote, and terminal-event invariants", (t) => {
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
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0006_availability_polls.sql >/dev/null
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0006_availability_polls.sql >/dev/null

must_fail() {
  label="$1"; sql="$2"
  if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "$sql" >/dev/null 2>&1; then
    echo "FAIL: $label"; exit 1;
  fi
}

psql -h /tmp -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'EOSQL'
INSERT INTO cloud_users (id, display_name, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Owner', 'ACTIVE'),
  ('22222222-2222-4222-8222-222222222222', 'Member', 'ACTIVE');
INSERT INTO "groups" (group_id, school_id, type, name, status, created_by)
VALUES ('55555555-5555-4555-8555-555555555555', 'haut', 'study', 'OS Study', 'ACTIVE', '11111111-1111-4111-8111-111111111111');
INSERT INTO group_members (member_id, group_id, school_id, cloud_user_id, role, sharing_level, status, joined_at) VALUES
  ('77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'haut', '11111111-1111-4111-8111-111111111111', 'OWNER', 'NONE', 'ACTIVE', now()),
  ('88888888-8888-4888-8888-888888888888', '55555555-5555-4555-8555-555555555555', 'haut', '22222222-2222-4222-8222-222222222222', 'MEMBER', 'BUSY_BLOCKS_30MIN', 'ACTIVE', now());
INSERT INTO availability_shares (member_id, group_id, school_id, revision, status, ttl_seconds, expires_at)
VALUES ('88888888-8888-4888-8888-888888888888', '55555555-5555-4555-8555-555555555555', 'haut', 1, 'ACTIVE', 1800, '2026-12-01T00:30:00+00:00');
INSERT INTO busy_blocks (busy_block_id, member_id, group_id, school_id, start_at, end_at)
VALUES ('99999999-9999-4999-8999-999999999999', '88888888-8888-4888-8888-888888888888', '55555555-5555-4555-8555-555555555555', 'haut', '2026-12-01T00:00:00+00:00', '2026-12-01T00:30:00+00:00');
EOSQL

# UP is repeatable both before and after rows exist.
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0006_availability_polls.sql >/dev/null

# TTL is 30 minutes through 90 days; terminal status timestamps have strict shapes.
must_fail "ttl below 30 minutes accepted" "INSERT INTO availability_shares (member_id, group_id, school_id, revision, status, ttl_seconds, expires_at) VALUES ('77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'haut', 1, 'ACTIVE', 1799, now() + interval '29 minutes');"
must_fail "ttl above 90 days accepted" "INSERT INTO availability_shares (member_id, group_id, school_id, revision, status, ttl_seconds, expires_at) VALUES ('77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'haut', 1, 'ACTIVE', 7776001, now() + interval '91 days');"
must_fail "ACTIVE share with expired_at accepted" "INSERT INTO availability_shares (member_id, group_id, school_id, revision, status, ttl_seconds, expires_at, expired_at) VALUES ('77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'haut', 1, 'ACTIVE', 1800, now() + interval '30 minutes', now());"

# Busy blocks are only quantized time windows: absolute 30-minute boundaries, whole multiples, no overlap, same school scope.
must_fail "unaligned busy block start accepted" "INSERT INTO busy_blocks (busy_block_id, member_id, group_id, school_id, start_at, end_at) VALUES ('aaaaaaaa-0000-4000-8000-aaaaaaaaaaa1', '88888888-8888-4888-8888-888888888888', '55555555-5555-4555-8555-555555555555', 'haut', '2026-12-01T01:15:00+00:00', '2026-12-01T02:00:00+00:00');"
must_fail "non-30-minute-multiple busy block accepted" "INSERT INTO busy_blocks (busy_block_id, member_id, group_id, school_id, start_at, end_at) VALUES ('aaaaaaaa-0000-4000-8000-aaaaaaaaaaa2', '88888888-8888-4888-8888-888888888888', '55555555-5555-4555-8555-555555555555', 'haut', '2026-12-01T02:00:00+00:00', '2026-12-01T02:45:00+00:00');"
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO busy_blocks (busy_block_id, member_id, group_id, school_id, start_at, end_at) VALUES ('aaaaaaaa-0000-4000-8000-aaaaaaaaaaa3', '88888888-8888-4888-8888-888888888888', '55555555-5555-4555-8555-555555555555', 'haut', '2026-12-01T00:30:00+00:00', '2026-12-01T01:00:00+00:00');" >/dev/null
must_fail "overlapping busy block accepted" "INSERT INTO busy_blocks (busy_block_id, member_id, group_id, school_id, start_at, end_at) VALUES ('aaaaaaaa-0000-4000-8000-aaaaaaaaaaa4', '88888888-8888-4888-8888-888888888888', '55555555-5555-4555-8555-555555555555', 'haut', '2026-12-01T00:45:00+00:00', '2026-12-01T01:15:00+00:00');"
must_fail "cross-school busy block accepted" "INSERT INTO busy_blocks (busy_block_id, member_id, group_id, school_id, start_at, end_at) VALUES ('aaaaaaaa-0000-4000-8000-aaaaaaaaaaa5', '88888888-8888-4888-8888-888888888888', '55555555-5555-4555-8555-555555555555', 'other-school', '2026-12-01T02:00:00+00:00', '2026-12-01T02:30:00+00:00');"

psql -h /tmp -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'EOSQL'
INSERT INTO meeting_polls (poll_id, group_id, school_id, title, status, voting_deadline_at, created_by_member_id)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '55555555-5555-4555-8555-555555555555', 'haut', '期末复习', 'OPEN', '2026-12-01T01:30:00+00:00', '77777777-7777-4777-8777-777777777777');
INSERT INTO poll_options (option_id, poll_id, position, start_at, end_at) VALUES
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 0, '2026-12-01T02:00:00+00:00', '2026-12-01T03:00:00+00:00'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, '2026-12-01T04:00:00+00:00', '2026-12-01T05:00:00+00:00');
INSERT INTO poll_votes (vote_id, poll_id, group_id, school_id, member_id, option_id)
VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '55555555-5555-4555-8555-555555555555', 'haut', '88888888-8888-4888-8888-888888888888', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
EOSQL

must_fail "unaligned poll option accepted" "INSERT INTO poll_options (option_id, poll_id, position, start_at, end_at) VALUES ('cccccccc-0000-4000-8000-ccccccccccc1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2, '2026-12-01T06:15:00+00:00', '2026-12-01T07:00:00+00:00');"
must_fail "duplicate exact poll option window accepted" "INSERT INTO poll_options (option_id, poll_id, position, start_at, end_at) VALUES ('cccccccc-0000-4000-8000-ccccccccccc2', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2, '2026-12-01T02:00:00+00:00', '2026-12-01T03:00:00+00:00');"
must_fail "second vote for same member/poll accepted" "INSERT INTO poll_votes (vote_id, poll_id, group_id, school_id, member_id, option_id) VALUES ('eeeeeeee-0000-4000-8000-eeeeeeeeeee1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '55555555-5555-4555-8555-555555555555', 'haut', '88888888-8888-4888-8888-888888888888', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');"
must_fail "cross-school vote accepted" "INSERT INTO poll_votes (vote_id, poll_id, group_id, school_id, member_id, option_id) VALUES ('eeeeeeee-0000-4000-8000-eeeeeeeeeee2', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '55555555-5555-4555-8555-555555555555', 'other-school', '77777777-7777-4777-8777-777777777777', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');"

# Confirmation is terminal and exactly one confirmed event exists per poll.
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'EOSQL'
INSERT INTO confirmed_group_events (confirmed_event_id, poll_id, option_id, group_id, school_id, start_at, end_at, status, confirmed_by_member_id)
VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '55555555-5555-4555-8555-555555555555', 'haut', '2026-12-01T02:00:00+00:00', '2026-12-01T03:00:00+00:00', 'CONFIRMED', '77777777-7777-4777-8777-777777777777');
UPDATE meeting_polls
   SET status = 'CONFIRMED', closed_at = '2026-12-01T01:30:00+00:00', confirmed_at = '2026-12-01T01:30:00+00:00', confirmed_option_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', confirmed_event_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
 WHERE poll_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
EOSQL
must_fail "second confirmed event for same poll accepted" "INSERT INTO confirmed_group_events (confirmed_event_id, poll_id, option_id, group_id, school_id, start_at, end_at, status, confirmed_by_member_id) VALUES ('ffffffff-0000-4000-8000-fffffffffff1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '55555555-5555-4555-8555-555555555555', 'haut', '2026-12-01T04:00:00+00:00', '2026-12-01T05:00:00+00:00', 'CONFIRMED', '77777777-7777-4777-8777-777777777777');"
must_fail "CONFIRMED poll without terminal fields accepted" "INSERT INTO meeting_polls (poll_id, group_id, school_id, title, status, voting_deadline_at, created_by_member_id) VALUES ('bbbbbbbb-0000-4000-8000-bbbbbbbbbbb1', '55555555-5555-4555-8555-555555555555', 'haut', '坏终态', 'CONFIRMED', '2026-12-01T01:30:00+00:00', '77777777-7777-4777-8777-777777777777');"

# DOWN is repeatable, removes only W4-02 tables, and UP after DOWN recreates them.
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0006_availability_polls.down.sql >/dev/null
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0006_availability_polls.down.sql >/dev/null
remaining=$(psql -h /tmp -U postgres -Atc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('availability_shares','busy_blocks','meeting_polls','poll_options','poll_votes','confirmed_group_events');")
[ "$remaining" = "0" ] || { echo "FAIL: down left availability tables behind: $remaining"; exit 1; }
community_remaining=$(psql -h /tmp -U postgres -Atc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('groups','group_members','group_invites');")
[ "$community_remaining" = "3" ] || { echo "FAIL: down removed W4-01 community tables"; exit 1; }
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0006_availability_polls.sql >/dev/null
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0006_availability_polls.sql >/dev/null
recreated=$(psql -h /tmp -U postgres -Atc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('availability_shares','busy_blocks','meeting_polls','poll_options','poll_votes','confirmed_group_events');")
[ "$recreated" = "6" ] || { echo "FAIL: up-after-down recreated $recreated tables rather than 6"; exit 1; }

echo "PG_MIGRATION_0006_VERIFIED_OK"
`;
  const out = execFileSync(
    dockerBin,
    ["run", "--rm", "--network", "none", "--user", "postgres", "-v", migrationsDir + ":/migrations:ro", pgImage, "sh", "-c", script],
    { encoding: "utf8", timeout: 60_000 }
  );
  assert.ok(out.includes("PG_MIGRATION_0006_VERIFIED_OK"), "Unexpected PostgreSQL output: " + out);
});
