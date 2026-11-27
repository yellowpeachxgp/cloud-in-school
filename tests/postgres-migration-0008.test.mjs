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

test("PostgreSQL migration 0008: place-status tables enforce CT-04 TTL/correction/review invariants and up/down/repeat are safe", (t) => {
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
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0008_place_status.sql >/dev/null
# Repeating UP must be safe before and after bootstrap rows exist.
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0008_place_status.sql >/dev/null

graph_count=$(psql -h /tmp -U postgres -Atc "SELECT count(*) FROM campus_graph_places WHERE verification_level='UNVERIFIED';")
[ "$graph_count" -ge 7 ] || { echo "FAIL: bootstrap graph rows missing: $graph_count"; exit 1; }

psql -h /tmp -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'EOSQL'
INSERT INTO cloud_users (id, display_name, status)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'Reporter', 'ACTIVE'),
  ('22222222-2222-4222-8222-222222222222', 'Reviewer', 'ACTIVE');
INSERT INTO place_reports (
  report_id, place_ref, school_id, campus_id, place_type, metric, state,
  observed_at, reported_at, expires_at, ttl_seconds, report_kind,
  reporter_cloud_user_id, reporter_key, note, moderation_state, aggregation_eligible
) VALUES (
  '55555555-5555-4555-8555-555555555555',
  'haut/lianhuajie/room/5-111', 'haut', 'lianhuajie', 'room',
  'OCCUPANCY', 'CROWDED',
  '2026-11-27T09:50:00+00:00', '2026-11-27T10:00:00+00:00',
  '2026-11-27T10:20:00+00:00', 1800, 'OBSERVATION',
  '11111111-1111-4111-8111-111111111111', 'reporter-one', NULL, 'VISIBLE', TRUE
);
INSERT INTO place_reports (
  report_id, place_ref, school_id, campus_id, place_type, metric, state,
  observed_at, reported_at, expires_at, ttl_seconds, report_kind, corrects_report_id,
  reporter_cloud_user_id, reporter_key, note, moderation_state, aggregation_eligible
) VALUES (
  '66666666-6666-4666-8666-666666666666',
  'haut/lianhuajie/room/5-111', 'haut', 'lianhuajie', 'room',
  'OCCUPANCY', 'FULL',
  '2026-11-27T09:55:00+00:00', '2026-11-27T10:00:00+00:00',
  '2026-11-27T10:25:00+00:00', 1800, 'CORRECTION', '55555555-5555-4555-8555-555555555555',
  '11111111-1111-4111-8111-111111111111', 'reporter-one', NULL, 'VISIBLE', TRUE
);
EOSQL

# Metric/state matrix is fixed: OCCUPANCY cannot use ACCESS state OPEN.
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO place_reports (report_id, place_ref, school_id, campus_id, place_type, metric, state, observed_at, expires_at, ttl_seconds, report_kind, reporter_cloud_user_id, reporter_key) VALUES ('77777777-7777-4777-8777-777777777777', 'haut/lianhuajie/room/5-111', 'haut', 'lianhuajie', 'room', 'OCCUPANCY', 'OPEN', now() - interval '1 minute', now() + interval '29 minute', 1800, 'OBSERVATION', '11111111-1111-4111-8111-111111111111', 'bad');" >/dev/null 2>&1; then
  echo "FAIL: invalid metric/state pair accepted"; exit 1;
fi

# expires_at must be observed_at + fixed TTL, never ingestion time plus TTL.
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO place_reports (report_id, place_ref, school_id, campus_id, place_type, metric, state, observed_at, expires_at, ttl_seconds, report_kind, reporter_cloud_user_id, reporter_key) VALUES ('88888888-8888-4888-8888-888888888888', 'haut/lianhuajie/room/5-111', 'haut', 'lianhuajie', 'room', 'OCCUPANCY', 'QUIET', now() - interval '10 minute', now() + interval '30 minute', 1800, 'OBSERVATION', '11111111-1111-4111-8111-111111111111', 'bad-expiry');" >/dev/null 2>&1; then
  echo "FAIL: ingestion-time TTL shape accepted"; exit 1;
fi

# OBSERVATION cannot carry a correction link.
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO place_reports (report_id, place_ref, school_id, campus_id, place_type, metric, state, observed_at, expires_at, ttl_seconds, report_kind, corrects_report_id, reporter_cloud_user_id, reporter_key) VALUES ('99999999-9999-4999-8999-999999999999', 'haut/lianhuajie/room/5-111', 'haut', 'lianhuajie', 'room', 'OCCUPANCY', 'QUIET', now() - interval '1 minute', now() + interval '29 minute', 1800, 'OBSERVATION', '55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', 'bad-kind');" >/dev/null 2>&1; then
  echo "FAIL: OBSERVATION with correction link accepted"; exit 1;
fi

psql -h /tmp -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'EOSQL'
INSERT INTO place_status_view (
  school_id, place_ref, metric, aggregation_revision, effective_state,
  unknown_reason, divergent_states, active_report_count, reporter_count,
  aggregation_algorithm, official_realtime_status
) VALUES (
  'haut', 'haut/lianhuajie/room/5-111', 'OCCUPANCY', 1, 'CONTESTED',
  NULL, '[{"state":"CROWDED","report_count":1,"reporter_count":1}]'::jsonb, 1, 1,
  'LATEST_PER_REPORTER_ANY_DIVERGENCE_CONTESTED_V1', FALSE
);
INSERT INTO place_report_flags (
  flag_id, report_id, place_ref, school_id, reason, detail, status,
  flagger_cloud_user_id
) VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '55555555-5555-4555-8555-555555555555',
  'haut/lianhuajie/room/5-111', 'haut', 'INCORRECT', NULL, 'OPEN',
  '22222222-2222-4222-8222-222222222222'
);
INSERT INTO place_status_subscriptions (
  subscription_id, cloud_user_id, school_id, target_type, place_ref,
  metrics, status
) VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222',
  'haut', 'PLACE', 'haut/lianhuajie/room/5-111', '["OCCUPANCY"]'::jsonb, 'ACTIVE'
);
INSERT INTO operations_school_grants (
  grant_id, cloud_user_id, school_id, permission, status, granted_by_ref
) VALUES (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '22222222-2222-4222-8222-222222222222',
  'haut', 'place.status.moderate', 'ACTIVE', 'migration-test'
);
EOSQL

# The aggregate representation can never claim an official realtime feed.
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO place_status_view (school_id, place_ref, metric, aggregation_revision, effective_state, official_realtime_status) VALUES ('haut', 'haut/lianhuajie/room/5-111', 'ACCESS', 1, 'OPEN', TRUE);" >/dev/null 2>&1; then
  echo "FAIL: official realtime status true accepted"; exit 1;
fi

# AREA subscriptions must carry a strictly ordered coarse bbox.
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO place_status_subscriptions (subscription_id, cloud_user_id, school_id, target_type, metrics, status) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '22222222-2222-4222-8222-222222222222', 'haut', 'AREA', '[\"OCCUPANCY\"]'::jsonb, 'ACTIVE');" >/dev/null 2>&1; then
  echo "FAIL: AREA subscription without bbox accepted"; exit 1;
fi

# Per-school operations grants are explicit and at most one ACTIVE row exists per scope.
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO operations_school_grants (grant_id, cloud_user_id, school_id, permission, status, granted_by_ref) VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '22222222-2222-4222-8222-222222222222', 'haut', 'place.status.moderate', 'ACTIVE', 'duplicate');" >/dev/null 2>&1; then
  echo "FAIL: duplicate ACTIVE operations grant accepted"; exit 1;
fi

psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0008_place_status.down.sql >/dev/null
# Repeating DOWN is safe.
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0008_place_status.down.sql >/dev/null
remaining=$(psql -h /tmp -U postgres -Atc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('campus_graph_places','place_reports','place_status_view','place_report_flags','place_status_subscriptions','operations_school_grants');")
[ "$remaining" = "0" ] || { echo "FAIL: down migration left tables behind: $remaining"; exit 1; }
# UP after DOWN recreates the schema and bootstrap graph.
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0008_place_status.sql >/dev/null
recreated=$(psql -h /tmp -U postgres -Atc "SELECT count(*) FROM campus_graph_places;")
[ "$recreated" -ge 7 ] || { echo "FAIL: up-after-down did not recreate graph rows"; exit 1; }

echo "PG_MIGRATION_0008_VERIFIED_OK"
`;
  const out = execFileSync(
    dockerBin,
    ["run", "--rm", "--network", "none", "--user", "postgres", "-v", migrationsDir + ":/migrations:ro", pgImage, "sh", "-c", script],
    { encoding: "utf8", timeout: 60_000 }
  );
  assert.ok(out.includes("PG_MIGRATION_0008_VERIFIED_OK"), "Unexpected PostgreSQL output: " + out);
});
