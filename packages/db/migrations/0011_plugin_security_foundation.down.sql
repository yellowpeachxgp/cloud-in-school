-- Rollback migration 0011: remove W6-01a plugin security foundation tables.
-- Legacy installed_plugins remains owned by migration 0002 and is not dropped here.
BEGIN;
DROP TABLE IF EXISTS plugin_runtime_states;
DROP TABLE IF EXISTS plugin_cache_entries;
DROP TABLE IF EXISTS plugin_storage_entries;
DROP TABLE IF EXISTS plugin_permission_grants;
DROP TABLE IF EXISTS plugin_installations;
DROP TABLE IF EXISTS plugin_versions;
DROP TABLE IF EXISTS plugin_publishers;
COMMIT;
