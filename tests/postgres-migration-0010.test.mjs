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

test("PostgreSQL migration 0010: E2EE sync schema enforces ciphertext-only bucket, tombstone, cursor, and device-quota invariants", (t) => {
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
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0010_e2ee_sync_block_storage.sql >/dev/null
# Repeating UP must be safe.
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0010_e2ee_sync_block_storage.sql >/dev/null

prohibited=$(psql -h /tmp -U postgres -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name LIKE 'sync\_%' AND column_name IN ('plaintext','plaintext_sha256','plaintext_hash','content','content_type','title','password','private_key','key_encryption_key','key_derivation_secret');")
[ "$prohibited" = "0" ] || { echo "FAIL: sync schema contains plaintext/key-material columns"; exit 1; }

mutation_has_ciphertext=$(psql -h /tmp -U postgres -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='sync_blob_mutations' AND column_name='ciphertext';")
[ "$mutation_has_ciphertext" = "0" ] || { echo "FAIL: mutation history stores ciphertext bytes"; exit 1; }

psql -h /tmp -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'EOSQL'
INSERT INTO cloud_users (id, display_name, status)
VALUES ('11111111-1111-4111-8111-111111111111', 'SyncUser', 'ACTIVE');
INSERT INTO consent_records (id, cloud_user_id, purpose, document_version, document_sha256, granted_at)
VALUES (
  '99999999-9999-4999-8999-999999999999',
  '11111111-1111-4111-8111-111111111111',
  'E2EE_CLOUD_SYNC',
  'e2ee-sync-consent-v1',
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  now()
);
INSERT INTO sync_user_states (cloud_user_id, latest_change_sequence, compaction_epoch)
VALUES ('11111111-1111-4111-8111-111111111111', 0, 0);
INSERT INTO sync_devices (
  cloud_user_id, device_id, session_family_id, consent_id, device_label, platform,
  sync_protocol_version, status, registered_at
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '44444444-4444-4444-8444-444444444444',
  '99999999-9999-4999-8999-999999999999',
  'Android test device',
  'ANDROID',
  1,
  'ACTIVE',
  now()
);
INSERT INTO sync_blob_current (
  cloud_user_id, blob_id, change_kind, version_vector, author_device_id, change_sequence,
  encryption_format, cipher_suite, padding_scheme, key_id, nonce_base64,
  ciphertext, ciphertext_sha256, ciphertext_size_bytes, committed_at
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'UPSERT',
  '[{"device_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","counter":1}]'::jsonb,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  1,
  'dis-sync-e2ee/v1', 'AES-256-GCM', 'DIS_SYNC_SIZE_BUCKETS_POW4_V1',
  'demo-key-0001', 'YMeL9qr7MabYnhal',
  decode(repeat('01', 1024), 'hex'),
  '56449943d67692d1f639471a79675e5e501690a7f311c1848d407c44543b3082',
  1024,
  now()
);
INSERT INTO sync_blob_mutations (
  cloud_user_id, change_sequence, blob_id, change_kind, version_vector, author_device_id,
  encryption_format, cipher_suite, padding_scheme, key_id, nonce_base64,
  ciphertext_sha256, ciphertext_size_bytes, committed_at
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  1,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'UPSERT',
  '[{"device_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","counter":1}]'::jsonb,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'dis-sync-e2ee/v1', 'AES-256-GCM', 'DIS_SYNC_SIZE_BUCKETS_POW4_V1',
  'demo-key-0001', 'YMeL9qr7MabYnhal',
  '56449943d67692d1f639471a79675e5e501690a7f311c1848d407c44543b3082',
  1024,
  now()
);
UPDATE sync_user_states SET latest_change_sequence = 1 WHERE cloud_user_id = '11111111-1111-4111-8111-111111111111';
EOSQL

# A padded bucket declared as 1024 must contain exactly 1024 decoded ciphertext bytes.
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO sync_blob_current (cloud_user_id, blob_id, change_kind, version_vector, author_device_id, change_sequence, encryption_format, cipher_suite, padding_scheme, key_id, nonce_base64, ciphertext, ciphertext_sha256, ciphertext_size_bytes) VALUES ('11111111-1111-4111-8111-111111111111', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'UPSERT', '[]'::jsonb, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 'dis-sync-e2ee/v1', 'AES-256-GCM', 'DIS_SYNC_SIZE_BUCKETS_POW4_V1', 'demo-key-0001', 'YMeL9qr7MabYnhal', decode(repeat('01', 1000), 'hex'), '56449943d67692d1f639471a79675e5e501690a7f311c1848d407c44543b3082', 1024);" >/dev/null 2>&1; then
  echo "FAIL: non-exact padded ciphertext length accepted"; exit 1;
fi

# Tombstones are metadata-only and cannot retain ciphertext or encryption material.
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO sync_blob_mutations (cloud_user_id, change_sequence, blob_id, change_kind, version_vector, author_device_id, encryption_format, cipher_suite, padding_scheme, key_id, nonce_base64, ciphertext_sha256, ciphertext_size_bytes) VALUES ('11111111-1111-4111-8111-111111111111', 2, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'TOMBSTONE', '[]'::jsonb, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dis-sync-e2ee/v1', 'AES-256-GCM', 'DIS_SYNC_SIZE_BUCKETS_POW4_V1', 'demo-key-0001', 'YMeL9qr7MabYnhal', '56449943d67692d1f639471a79675e5e501690a7f311c1848d407c44543b3082', 1024);" >/dev/null 2>&1; then
  echo "FAIL: tombstone mutation with encryption material accepted"; exit 1;
fi

# Vector storage is hard-capped at 512 device entries in both current state and mutation history.
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'EOSQL'
INSERT INTO sync_blob_mutations (cloud_user_id, change_sequence, blob_id, change_kind, version_vector, author_device_id, encryption_format, cipher_suite, padding_scheme, key_id, nonce_base64, ciphertext_sha256, ciphertext_size_bytes)
SELECT
  '11111111-1111-4111-8111-111111111111', 2, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'UPSERT',
  jsonb_agg(jsonb_build_object('device_id', (('dddddddd-dddd-4ddd-8ddd-' || lpad(to_hex(g), 12, '0'))::uuid)::text, 'counter', 1)),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dis-sync-e2ee/v1', 'AES-256-GCM', 'DIS_SYNC_SIZE_BUCKETS_POW4_V1',
  'demo-key-0001', 'YMeL9qr7MabYnhal', '56449943d67692d1f639471a79675e5e501690a7f311c1848d407c44543b3082', 1024
FROM generate_series(1, 513) AS g;
EOSQL
then
  echo "FAIL: 513-entry vector accepted"; exit 1;
fi

# Device quota is fail-closed at 32 ACTIVE registrations.  One device already exists.
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'EOSQL'
INSERT INTO sync_devices (cloud_user_id, device_id, session_family_id, consent_id, device_label, platform, sync_protocol_version, status, registered_at)
SELECT
  '11111111-1111-4111-8111-111111111111',
  (('bbbbbbbb-bbbb-4bbb-8bbb-' || lpad(to_hex(g), 12, '0'))::uuid),
  '44444444-4444-4444-8444-444444444444',
  '99999999-9999-4999-8999-999999999999',
  'quota-' || g,
  'ANDROID', 1, 'ACTIVE', now()
FROM generate_series(1, 31) AS g;
EOSQL
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO sync_devices (cloud_user_id, device_id, session_family_id, consent_id, device_label, platform, sync_protocol_version, status, registered_at) VALUES ('11111111-1111-4111-8111-111111111111', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '44444444-4444-4444-8444-444444444444', '99999999-9999-4999-8999-999999999999', 'thirty-three', 'ANDROID', 1, 'ACTIVE', now());" >/dev/null 2>&1; then
  echo "FAIL: 33rd ACTIVE sync device accepted"; exit 1;
fi

# Cursor positions cannot move beyond their represented scan epoch.
if psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO sync_cursors (cursor_id, cloud_user_id, device_id, token_sha256, position, scan_epoch, terminal) VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 2, 1, false);" >/dev/null 2>&1; then
  echo "FAIL: cursor position beyond scan epoch accepted"; exit 1;
fi

# Anti-resurrection markers and transfer accounting tables exist with the expected user scope.
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'EOSQL'
INSERT INTO sync_blob_anti_resurrection (cloud_user_id, blob_id, first_tombstone_change_sequence, tombstoned_at)
VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, now());
INSERT INTO sync_transfer_usage (cloud_user_id, direction, bytes, occurred_at)
VALUES ('11111111-1111-4111-8111-111111111111', 'INGRESS', 1024, now());
INSERT INTO sync_cursors (cursor_id, cloud_user_id, device_id, token_sha256, position, scan_epoch, terminal)
VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1, 1, true);
EOSQL

psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0010_e2ee_sync_block_storage.down.sql >/dev/null
# Repeating DOWN is safe.
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0010_e2ee_sync_block_storage.down.sql >/dev/null
remaining=$(psql -h /tmp -U postgres -Atc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('sync_user_states','sync_devices','sync_blob_current','sync_blob_mutations','sync_blob_anti_resurrection','sync_cursors','sync_transfer_usage','sync_rate_windows');")
[ "$remaining" = "0" ] || { echo "FAIL: down migration left sync tables behind: $remaining"; exit 1; }
# UP after DOWN recreates the schema.
psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -f /migrations/0010_e2ee_sync_block_storage.sql >/dev/null
recreated=$(psql -h /tmp -U postgres -Atc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('sync_user_states','sync_devices','sync_blob_current','sync_blob_mutations','sync_blob_anti_resurrection','sync_cursors','sync_transfer_usage','sync_rate_windows');")
[ "$recreated" = "8" ] || { echo "FAIL: up-after-down did not recreate sync schema: $recreated"; exit 1; }

echo "PG_MIGRATION_0010_VERIFIED_OK"
`;
  const out = execFileSync(
    dockerBin,
    ["run", "--rm", "--network", "none", "--user", "postgres", "-v", migrationsDir + ":/migrations:ro", pgImage, "sh", "-c", script],
    { encoding: "utf8", timeout: 60_000 }
  );
  assert.ok(out.includes("PG_MIGRATION_0010_VERIFIED_OK"), "Unexpected PostgreSQL output: " + out);
});
