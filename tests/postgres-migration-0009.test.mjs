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

test("PostgreSQL migration 0009: content catalog enforces artifact, review separation, lifecycle, and rollback invariants", (t) => {
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
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0009_content_pack_catalog.sql >/dev/null
# Repeating UP must be safe before rows exist.
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0009_content_pack_catalog.sql >/dev/null

psql -h /tmp -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'EOSQL'
INSERT INTO cloud_users (id, display_name, status)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'Submitter', 'ACTIVE'),
  ('22222222-2222-4222-8222-222222222222', 'Reviewer', 'ACTIVE'),
  ('33333333-3333-4333-8333-333333333333', 'Publisher', 'ACTIVE'),
  ('44444444-4444-4444-8444-444444444444', 'Retirer', 'ACTIVE');
INSERT INTO content_pack_submissions (
  submission_id, status, artifact_format, kind, school_id, pack_id, version,
  artifact_sha256, artifact_size_bytes, artifact, contribution_reference,
  provenance_json, submission_note, submitter_cloud_user_id
) VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'PENDING_REVIEW', 'dis-datapack/v1', 'procedure-guide',
  'haut', 'haut.procedures', '2026.11.1',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 3, decode('7b7d0a', 'hex'),
  'https://github.com/example/content-pack/pull/1',
  '{"sources":[],"verified_at":"2026-11-20","review_by":"2027-05-20","maintainers":["github:example"],"verification_level":"UNVERIFIED"}'::jsonb,
  'public-source candidate', '11111111-1111-4111-8111-111111111111'
);
EOSQL

# Artifact byte length must exactly match the declared size.
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO content_pack_submissions (submission_id,status,artifact_format,kind,school_id,pack_id,version,artifact_sha256,artifact_size_bytes,artifact,contribution_reference,provenance_json,submitter_cloud_user_id) VALUES ('abababab-abab-4aba-8aba-abababababab','PENDING_REVIEW','dis-datapack/v1','procedure-guide','haut','haut.other','2026.11.1','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',5,decode('7b7d0a','hex'),'https://example.com/pr','{}'::jsonb,'11111111-1111-4111-8111-111111111111');" >/dev/null 2>&1; then
  echo "FAIL: mismatched artifact byte length accepted"; exit 1;
fi

# A datapack whose first pack_id segment is not the complete dot-free school scope is rejected.
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO content_pack_submissions (submission_id,status,artifact_format,kind,school_id,pack_id,version,artifact_sha256,artifact_size_bytes,artifact,contribution_reference,provenance_json,submitter_cloud_user_id) VALUES ('acacacac-acac-4aca-8aca-acacacacacac','PENDING_REVIEW','dis-datapack/v1','procedure-guide','haut','other.procedures','2026.11.1','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',3,decode('7b7d0a','hex'),'https://example.com/pr','{}'::jsonb,'11111111-1111-4111-8111-111111111111');" >/dev/null 2>&1; then
  echo "FAIL: datapack school/pack scope mismatch accepted"; exit 1;
fi

# The database itself must enforce submitter != reviewer even if application logic is bypassed.
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO content_pack_reviews (review_id,submission_id,action,reviewer_cloud_user_id,review_note) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','APPROVE','11111111-1111-4111-8111-111111111111',NULL);" >/dev/null 2>&1; then
  echo "FAIL: self-review accepted by database trigger"; exit 1;
fi
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'EOSQL'
INSERT INTO content_pack_reviews (review_id,submission_id,action,reviewer_cloud_user_id,review_note)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','APPROVE','22222222-2222-4222-8222-222222222222',NULL);
UPDATE content_pack_submissions SET status='APPROVED', updated_at=now() WHERE submission_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
INSERT INTO content_pack_versions (
  school_id, pack_id, version, kind, artifact_format, artifact_sha256, artifact_size_bytes, artifact,
  signature_json, provenance_json, lifecycle_status, submission_id, publisher_cloud_user_id
) VALUES (
  'haut','haut.procedures','2026.11.1','procedure-guide','dis-datapack/v1',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',3,decode('7b7d0a','hex'),
  '{"algorithm":"Ed25519"}'::jsonb,
  '{"sources":[],"verified_at":"2026-11-20","review_by":"2027-05-20","maintainers":["github:example"],"verification_level":"UNVERIFIED"}'::jsonb,
  'PUBLISHED','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333'
);
EOSQL

# Retirement is append-only metadata with a complete lifecycle shape.
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "UPDATE content_pack_versions SET lifecycle_status='RETIRED' WHERE pack_id='haut.procedures' AND version='2026.11.1';" >/dev/null 2>&1; then
  echo "FAIL: incomplete retirement shape accepted"; exit 1;
fi
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'EOSQL'
UPDATE content_pack_versions
   SET lifecycle_status='RETIRED', retired_at=now(), retirement_reason='OUTDATED',
       retirement_detail='superseded in test', retired_by_cloud_user_id='44444444-4444-4444-8444-444444444444'
 WHERE pack_id='haut.procedures' AND version='2026.11.1';
INSERT INTO content_pack_rate_windows (cloud_user_id, operation_kind, window_started_at, request_count)
VALUES ('11111111-1111-4111-8111-111111111111','DOWNLOAD',now(),1);
EOSQL

# Format/kind mismatch is rejected by the version table shape constraint.
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'EOSQL'
INSERT INTO content_pack_submissions (
  submission_id, status, artifact_format, kind, school_id, pack_id, version,
  artifact_sha256, artifact_size_bytes, artifact, contribution_reference,
  provenance_json, submitter_cloud_user_id
) VALUES (
  'dededede-dede-4ded-8ded-dededededede', 'APPROVED', 'dis-campus-plugin/v1', 'school-profile',
  'haut', 'haut.bad', '2026.11.2',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 3, decode('7b7d0a', 'hex'),
  'https://example.com/pr2', '{}'::jsonb, '11111111-1111-4111-8111-111111111111'
);
EOSQL
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO content_pack_versions (school_id,pack_id,version,kind,artifact_format,artifact_sha256,artifact_size_bytes,artifact,signature_json,provenance_json,lifecycle_status,submission_id,publisher_cloud_user_id) VALUES ('haut','haut.bad','2026.11.2','procedure-guide','dis-campus-plugin/v1','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',3,decode('7b7d0a','hex'),'{}'::jsonb,'{}'::jsonb,'PUBLISHED','dededede-dede-4ded-8ded-dededededede','33333333-3333-4333-8333-333333333333');" >/dev/null 2>&1; then
  echo "FAIL: format/kind mismatch accepted"; exit 1;
fi

psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0009_content_pack_catalog.down.sql >/dev/null
# Repeating DOWN is safe.
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0009_content_pack_catalog.down.sql >/dev/null
remaining=$(psql -h /tmp -U postgres -Atc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('content_pack_submissions','content_pack_reviews','content_pack_versions','content_pack_rate_windows');")
[ "$remaining" = "0" ] || { echo "FAIL: down migration left content catalog tables behind: $remaining"; exit 1; }
# UP after DOWN recreates the schema.
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0009_content_pack_catalog.sql >/dev/null
recreated=$(psql -h /tmp -U postgres -Atc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('content_pack_submissions','content_pack_reviews','content_pack_versions','content_pack_rate_windows');")
[ "$recreated" = "4" ] || { echo "FAIL: up-after-down did not recreate content catalog schema: $recreated"; exit 1; }

echo "PG_MIGRATION_0009_VERIFIED_OK"
`;
  const out = execFileSync(
    dockerBin,
    ["run", "--rm", "--network", "none", "--user", "postgres", "-v", migrationsDir + ":/migrations:ro", pgImage, "sh", "-c", script],
    { encoding: "utf8", timeout: 60_000 }
  );
  assert.ok(out.includes("PG_MIGRATION_0009_VERIFIED_OK"), "Unexpected PostgreSQL output: " + out);
});
