import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { REPO_ROOT } from "../packages/contracts/src/index.mjs";

function findLocalDockerWithPostgres17() {
  const candidates = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "docker"];
  for (const bin of candidates) {
    try {
      const images = execFileSync(bin, ["images", "--format", "{{.Repository}}:{{.Tag}}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000
      });
      if (images.split(/\r?\n/).includes("postgres:17-alpine")) {
        return bin;
      }
      if (images.split(/\r?\n/).includes("postgres:15-alpine")) {
        return `${bin}|postgres:15-alpine`;
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}

test("SQLite Real CHECK Enforcement: naive DELETED->DELETION_REQUESTED keeping deleted_at violates compound CHECK, while reversible audit-archive conversion satisfies it", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE cloud_users (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      deleted_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED', 'DELETION_REQUESTED', 'DELETED')),
      CONSTRAINT chk_deleted_requires_deleted_at CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL))
    );
    CREATE TABLE cloud_users_0004_rollback_audit (
      cloud_user_id TEXT PRIMARY KEY REFERENCES cloud_users(id) ON DELETE CASCADE,
      original_status TEXT NOT NULL,
      original_deleted_at TEXT NOT NULL
    );
    INSERT INTO cloud_users (id, display_name, status, deleted_at)
    VALUES ('11111111-1111-1111-1111-111111111111', 'Alice', 'DELETED', '2026-11-10T04:00:00Z');
  `);

  // Naive update (old 0004.down bug) immediately violates chk_deleted_requires_deleted_at:
  assert.throws(() => {
    db.exec(`UPDATE cloud_users SET status = 'DELETION_REQUESTED' WHERE status = 'DELETED'`);
  }, /CHECK constraint failed/);

  // Confirmed reversible conversion archives original_deleted_at and keeps compound CHECK satisfied:
  db.exec(`
    INSERT INTO cloud_users_0004_rollback_audit (cloud_user_id, original_status, original_deleted_at)
    SELECT id, status, deleted_at FROM cloud_users WHERE status = 'DELETED';
    UPDATE cloud_users SET status = 'DELETION_REQUESTED', deleted_at = NULL WHERE status = 'DELETED';
  `);
  const demoted = db.prepare(`SELECT status, deleted_at FROM cloud_users WHERE id = ?`).get(
    "11111111-1111-1111-1111-111111111111"
  );
  assert.equal(demoted.status, "DELETION_REQUESTED");
  assert.equal(demoted.deleted_at, null);
  const archived = db
    .prepare(`SELECT original_status, original_deleted_at FROM cloud_users_0004_rollback_audit WHERE cloud_user_id = ?`)
    .get("11111111-1111-1111-1111-111111111111");
  assert.equal(archived.original_status, "DELETED");
  assert.equal(archived.original_deleted_at, "2026-11-10T04:00:00Z");
  db.close();
});

test("PostgreSQL 17 Real Engine Integration (Item #4): 0001+0004 UP -> valid DELETED+deleted_at + compound CHECK -> prechecked 0004 DOWN block & confirmed reversible DOWN -> re-UP restoration", (t) => {
  const found = findLocalDockerWithPostgres17();
  if (!found) {
    t.skip("Local offline postgres Docker image not available on this host");
    return;
  }
  const [dockerBin, pgImage = "postgres:17-alpine"] = found.split("|");
  const migrationsDir = path.join(REPO_ROOT, "packages/db/migrations");

  const pgVerifyScript = `
    set -eu
    initdb -D /tmp/pgdata >/dev/null
    pg_ctl -D /tmp/pgdata -o "-k /tmp" -w start >/dev/null
    trap 'pg_ctl -D /tmp/pgdata -m immediate stop >/dev/null 2>&1 || true' EXIT

    # 1. Create legacy 3-value public.cloud_users + compound CHECK + custom-named status check + separate audit.cloud_users schema
    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 <<'EOSQL' >/dev/null
      CREATE SCHEMA audit;
      CREATE TABLE audit.cloud_users (
        id UUID PRIMARY KEY,
        status TEXT NOT NULL CONSTRAINT audit_status_chk CHECK (status IN ('ACTIVE', 'DISABLED', 'DELETION_REQUESTED', 'DELETED')),
        deleted_at TIMESTAMPTZ
      );
      INSERT INTO audit.cloud_users (id, status, deleted_at)
      VALUES ('99999999-9999-9999-9999-999999999999', 'DELETED', '2026-11-09T00:00:00Z');
EOSQL

    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0001_initial_campus_cloud.sql >/dev/null
    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 <<'EOSQL' >/dev/null
      ALTER TABLE public.cloud_users DROP CONSTRAINT IF EXISTS cloud_users_status_check;
      ALTER TABLE public.cloud_users ADD CONSTRAINT chk_legacy_3val_status
        CHECK (status IN ('ACTIVE', 'DISABLED', 'DELETION_REQUESTED'));
      ALTER TABLE public.cloud_users ADD CONSTRAINT chk_deleted_requires_deleted_at
        CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL));
      ALTER TABLE public.cloud_users ADD CONSTRAINT chk_status_trimmed
        CHECK (btrim(status) <> '');
EOSQL

    # 2. Run 0004 UP twice (idempotency) and verify valid DELETED+deleted_at succeeds while DELETED+NULL fails
    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0004_cloud_users_status_check_forward.sql >/dev/null
    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0004_cloud_users_status_check_forward.sql >/dev/null

    if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO public.cloud_users (id, display_name, status, deleted_at) VALUES ('22222222-2222-2222-2222-222222222222', 'BadDel', 'DELETED', NULL);" >/dev/null 2>&1; then
      echo "FAIL: compound check chk_deleted_requires_deleted_at was dropped!" >&2
      exit 1
    fi

    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 <<'EOSQL' >/dev/null
      INSERT INTO public.cloud_users (id, display_name, status, deleted_at)
      VALUES
        ('11111111-1111-1111-1111-111111111111', 'DeletedUser', 'DELETED', '2026-11-10T04:00:00Z'),
        ('33333333-3333-3333-3333-333333333333', 'ActiveUser', 'ACTIVE', NULL);
EOSQL

    # 3. Unconfirmed 0004 DOWN MUST fail closed via precheck with actionable message (preserving DELETED row & compound CHECK)
    set +e
    UNCONFIRMED_OUT=$(psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0004_cloud_users_status_check_forward.down.sql 2>&1)
    UNCONFIRMED_RC=$?
    set -e
    if [ "$UNCONFIRMED_RC" -eq 0 ]; then
      echo "FAIL: unconfirmed 0004 DOWN should have been blocked by precheck!" >&2
      exit 1
    fi
    echo "$UNCONFIRMED_OUT" | grep -q "Migration 0004 rollback precheck blocked"
    echo "$UNCONFIRMED_OUT" | grep -q "chk_deleted_requires_deleted_at"

    STILL_DELETED=$(psql -h /tmp -U postgres -tAc "SELECT status || '|' || to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') FROM public.cloud_users WHERE id = '11111111-1111-1111-1111-111111111111';")
    [ "$STILL_DELETED" = "DELETED|2026-11-10 04:00:00" ]

    # 4. Confirmed 0004 DOWN within session/transaction archives deleted_at, keeps chk_deleted_requires_deleted_at intact, and restores 3-value check
    DOWN_BODY=$(sed -e 's/^BEGIN;//' -e 's/^COMMIT;//' /migrations/0004_cloud_users_status_check_forward.down.sql)
    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 <<EOSQL >/dev/null
      BEGIN;
      SET LOCAL cloud.migration_0004_confirm_deleted_demotion = 'ARCHIVE_DELETED_AT_TO_AUDIT';
      $DOWN_BODY
      COMMIT;
EOSQL

    AFTER_DOWN=$(psql -h /tmp -U postgres -tAc "SELECT status || '|' || COALESCE(deleted_at::text, 'NULL') FROM public.cloud_users WHERE id = '11111111-1111-1111-1111-111111111111';")
    [ "$AFTER_DOWN" = "DELETION_REQUESTED|NULL" ]

    ARCHIVED_AT=$(psql -h /tmp -U postgres -tAc "SELECT original_status || '|' || to_char(original_deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') FROM public.cloud_users_0004_rollback_audit WHERE cloud_user_id = '11111111-1111-1111-1111-111111111111';")
    [ "$ARCHIVED_AT" = "DELETED|2026-11-10 04:00:00" ]

    AUDIT_SCHEMA_UNTOUCHED=$(psql -h /tmp -U postgres -tAc "SELECT status FROM audit.cloud_users WHERE id = '99999999-9999-9999-9999-999999999999';")
    [ "$AUDIT_SCHEMA_UNTOUCHED" = "DELETED" ]

    COMPOUND_PRESENT=$(psql -h /tmp -U postgres -tAc "SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.cloud_users'::regclass AND conname = 'chk_deleted_requires_deleted_at';")
    [ "$COMPOUND_PRESENT" = "1" ]

    # Verify 3-value check now rejects 'DELETED'
    if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO public.cloud_users (id, display_name, status, deleted_at) VALUES ('44444444-4444-4444-4444-444444444444', 'NoDel', 'DELETED', now());" >/dev/null 2>&1; then
      echo "FAIL: 3-value check after DOWN should reject DELETED!" >&2
      exit 1
    fi

    # 5. Re-run 0004 UP -> reversibly restores status='DELETED' and exact original_deleted_at!
    psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0004_cloud_users_status_check_forward.sql >/dev/null
    RESTORED=$(psql -h /tmp -U postgres -tAc "SELECT status || '|' || to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') FROM public.cloud_users WHERE id = '11111111-1111-1111-1111-111111111111';")
    [ "$RESTORED" = "DELETED|2026-11-10 04:00:00" ]
    echo "PG17_VERIFIED_OK"
  `;

  const out = execFileSync(
    dockerBin,
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "postgres",
      "-v",
      `${migrationsDir}:/migrations:ro`,
      pgImage,
      "sh",
      "-c",
      pgVerifyScript
    ],
    { encoding: "utf8", timeout: 30_000 }
  );
  assert.ok(out.includes("PG17_VERIFIED_OK"), `Unexpected PostgreSQL output: ${out}`);
});
