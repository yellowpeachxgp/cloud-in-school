-- Migration 0011: W6-01a durable plugin security foundation
-- Extends the legacy installed_plugins registry with publisher trust, immutable signed
-- versions, account+school scoped installations, authorization, scoped storage/cache,
-- and failure/kill-switch runtime state. Runtime snapshot storage mirrors this schema.
BEGIN;

CREATE TABLE IF NOT EXISTS plugin_publishers (
  publisher_id TEXT PRIMARY KEY,
  public_key_base64 TEXT NOT NULL UNIQUE,
  owner_cloud_user_id UUID REFERENCES cloud_users(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plugin_versions (
  plugin_id TEXT NOT NULL REFERENCES installed_plugins(plugin_id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  publisher_id TEXT NOT NULL REFERENCES plugin_publishers(publisher_id),
  manifest_json JSONB NOT NULL,
  signature_base64 TEXT NOT NULL,
  public_key_base64 TEXT NOT NULL,
  artifact_payloads_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  registered_by_cloud_user_id UUID REFERENCES cloud_users(id),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, version)
);

CREATE INDEX IF NOT EXISTS plugin_versions_publisher_idx
  ON plugin_versions(publisher_id, plugin_id);

CREATE TABLE IF NOT EXISTS plugin_installations (
  id UUID PRIMARY KEY,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  school_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL REFERENCES installed_plugins(plugin_id) ON DELETE CASCADE,
  active_version TEXT,
  previous_version TEXT,
  pending_version TEXT,
  pending_permissions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('ENABLED','DISABLED','PENDING_PERMISSION_REVIEW')),
  granted_permissions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(cloud_user_id, school_id, plugin_id),
  CHECK (active_version IS NULL OR pending_version IS NULL OR active_version <> pending_version)
);

CREATE INDEX IF NOT EXISTS plugin_installations_scope_idx
  ON plugin_installations(cloud_user_id, school_id, status);

CREATE INDEX IF NOT EXISTS plugin_installations_plugin_idx
  ON plugin_installations(plugin_id, status);

CREATE TABLE IF NOT EXISTS plugin_permission_grants (
  installation_id UUID NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (installation_id, permission)
);

CREATE TABLE IF NOT EXISTS plugin_storage_entries (
  id UUID PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  value_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(installation_id, namespace, storage_key)
);

CREATE TABLE IF NOT EXISTS plugin_cache_entries (
  id UUID PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  value_json JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(installation_id, namespace, cache_key)
);

CREATE TABLE IF NOT EXISTS plugin_runtime_states (
  plugin_id TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failure_count >= 0),
  auto_disabled BOOLEAN NOT NULL DEFAULT FALSE,
  disabled_reason TEXT,
  kill_switch BOOLEAN NOT NULL DEFAULT FALSE,
  kill_switch_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
