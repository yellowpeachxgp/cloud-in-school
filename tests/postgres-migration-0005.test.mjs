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

test("PostgreSQL migration 0005: community tables enforce CT-01 lifecycle invariants and up/down/repeat are safe", (t) => {
  const found = findLocalDockerWithPostgres();
  if (!found) {
    t.skip("Local offline postgres Docker image not available on this host");
    return;
  }
  const [dockerBin, pgImage] = found.split("|");
  const migrationsDir = path.join(REPO_ROOT, "packages/db/migrations");
  const script = "    set -eu\n    initdb -D /tmp/pgdata >/dev/null\n    pg_ctl -D /tmp/pgdata -o \"-k /tmp\" -w start >/dev/null\n    trap 'pg_ctl -D /tmp/pgdata -m immediate stop >/dev/null 2>&1 || true' EXIT\n\n    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0001_initial_campus_cloud.sql >/dev/null\n    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0005_community_groups.sql >/dev/null\n    # Repeating UP must be safe before any rows exist.\n    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0005_community_groups.sql >/dev/null\n\n    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 <<'EOSQL' >/dev/null\n      INSERT INTO cloud_users (id, display_name, status)\n      VALUES\n        ('11111111-1111-4111-8111-111111111111', 'Owner', 'ACTIVE'),\n        ('22222222-2222-4222-8222-222222222222', 'Member', 'ACTIVE');\n      INSERT INTO \"groups\" (group_id, school_id, type, name, status, created_by)\n      VALUES ('55555555-5555-4555-8555-555555555555', 'haut', 'study', 'OS Study', 'ACTIVE', '11111111-1111-4111-8111-111111111111');\n      INSERT INTO group_members (member_id, group_id, school_id, cloud_user_id, role, sharing_level, status, joined_at)\n      VALUES ('77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'haut', '22222222-2222-4222-8222-222222222222', 'MEMBER', 'BUSY_BLOCKS_30MIN', 'ACTIVE', now());\nEOSQL\n\n    # The partial unique index forbids a second ACTIVE period for the same user/group.\n    if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c \"INSERT INTO group_members (member_id, group_id, school_id, cloud_user_id, role, sharing_level, status, joined_at) VALUES ('88888888-8888-4888-8888-888888888888', '55555555-5555-4555-8555-555555555555', 'haut', '22222222-2222-4222-8222-222222222222', 'MEMBER', 'NONE', 'ACTIVE', now());\" >/dev/null 2>&1; then\n      echo \"FAIL: duplicate ACTIVE membership period was accepted\" >&2\n      exit 1\n    fi\n\n    # Composite school scope foreign key forbids cross-school member rows.\n    if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c \"INSERT INTO group_members (member_id, group_id, school_id, cloud_user_id, role, sharing_level, status, joined_at) VALUES ('99999999-9999-4999-8999-999999999999', '55555555-5555-4555-8555-555555555555', 'other-school', '22222222-2222-4222-8222-222222222222', 'MEMBER', 'NONE', 'ACTIVE', now());\" >/dev/null 2>&1; then\n      echo \"FAIL: cross-school member row was accepted\" >&2\n      exit 1\n    fi\n\n    # Leaving with sharing still enabled violates the immediate-withdrawal invariant.\n    if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c \"UPDATE group_members SET status = 'LEFT', left_at = now() WHERE member_id = '77777777-7777-4777-8777-777777777777';\" >/dev/null 2>&1; then\n      echo \"FAIL: LEFT membership kept BUSY_BLOCKS_30MIN sharing\" >&2\n      exit 1\n    fi\n\n    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 <<'EOSQL' >/dev/null\n      UPDATE group_members\n         SET status = 'LEFT', sharing_level = 'NONE', left_at = now()\n       WHERE member_id = '77777777-7777-4777-8777-777777777777';\n      INSERT INTO group_members (member_id, group_id, school_id, cloud_user_id, role, sharing_level, status, joined_at)\n      VALUES ('88888888-8888-4888-8888-888888888888', '55555555-5555-4555-8555-555555555555', 'haut', '22222222-2222-4222-8222-222222222222', 'MEMBER', 'NONE', 'ACTIVE', now());\n      INSERT INTO group_invites (invite_id, group_id, school_id, code, qr_payload, status, expires_at, max_uses, used_count, created_by)\n      VALUES ('66666666-6666-4666-8666-666666666666', '55555555-5555-4555-8555-555555555555', 'haut', 'AbC123xy', 'dis-group-invite:v1:AbC123xy', 'ACTIVE', now() + interval '1 day', 2, 1, '11111111-1111-4111-8111-111111111111');\nEOSQL\n\n    ACTIVE_PERIODS=$(psql -h /tmp -U postgres -tAc \"SELECT count(*) FROM group_members WHERE group_id = '55555555-5555-4555-8555-555555555555' AND cloud_user_id = '22222222-2222-4222-8222-222222222222' AND status = 'ACTIVE';\")\n    [ \"$ACTIVE_PERIODS\" = \"1\" ]\n\n    if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c \"UPDATE group_invites SET used_count = 3 WHERE invite_id = '66666666-6666-4666-8666-666666666666';\" >/dev/null 2>&1; then\n      echo \"FAIL: invite used_count exceeded max_uses\" >&2\n      exit 1\n    fi\n    if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c \"UPDATE group_invites SET qr_payload = 'wrong-prefix:AbC123xy' WHERE invite_id = '66666666-6666-4666-8666-666666666666';\" >/dev/null 2>&1; then\n      echo \"FAIL: malformed QR payload was accepted\" >&2\n      exit 1\n    fi\n\n    # DOWN is repeatable and removes the migration-owned tables; UP again is repeatable after rollback.\n    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0005_community_groups.down.sql >/dev/null\n    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0005_community_groups.down.sql >/dev/null\n    REMAINING=$(psql -h /tmp -U postgres -tAc \"SELECT count(*) FROM pg_tables WHERE schemaname = current_schema() AND tablename IN ('groups', 'group_members', 'group_invites');\")\n    [ \"$REMAINING\" = \"0\" ]\n    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0005_community_groups.sql >/dev/null\n    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0005_community_groups.sql >/dev/null\n    echo \"PG_MIGRATION_0005_VERIFIED_OK\"";
  const out = execFileSync(
    dockerBin,
    ["run", "--rm", "--network", "none", "--user", "postgres", "-v", migrationsDir + ":/migrations:ro", pgImage, "sh", "-c", script],
    { encoding: "utf8", timeout: 45_000 }
  );
  assert.ok(out.includes("PG_MIGRATION_0005_VERIFIED_OK"), "Unexpected PostgreSQL output: " + out);
});
