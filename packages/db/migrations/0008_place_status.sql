-- Migration 0008: W4-04 TTL-aware Campus Graph place status reports, divergence
-- aggregation revisions, subscriptions, flags, and review decisions.
-- Contract CT-04: user-reported evidence only; no official realtime status is represented.
BEGIN;

CREATE TABLE IF NOT EXISTS campus_graph_places (
  place_ref TEXT PRIMARY KEY CHECK (
    place_ref ~ '^[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}/(campus|building|floor|room|facility|entrance|indoor_node)/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  school_id TEXT NOT NULL,
  campus_id TEXT NOT NULL,
  place_type TEXT NOT NULL CHECK (place_type IN ('campus', 'building', 'floor', 'room', 'facility', 'entrance', 'indoor_node')),
  slug TEXT NOT NULL,
  latitude DOUBLE PRECISION CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  verification_level TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_level IN ('UNVERIFIED', 'VERIFIED')),
  source_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT campus_graph_places_identity_shape_check
    CHECK (place_ref = school_id || '/' || campus_id || '/' || place_type || '/' || slug),
  CONSTRAINT campus_graph_places_scope_unique
    UNIQUE (place_ref, school_id, campus_id, place_type)
);

CREATE INDEX IF NOT EXISTS campus_graph_places_school_bbox_idx
  ON campus_graph_places (school_id, latitude, longitude, place_type);

-- Bootstrap rows are deliberately marked UNVERIFIED. Coordinates are coarse
-- building-centroid anchors for bbox filtering, not a published official graph.
INSERT INTO campus_graph_places
  (place_ref, school_id, campus_id, place_type, slug, latitude, longitude, verification_level, source_ref)
VALUES
  ('haut/lianhuajie/campus/lianhuajie', 'haut', 'lianhuajie', 'campus', 'lianhuajie', 34.830500, 113.543500, 'UNVERIFIED', 'dis-place-status:bootstrap-building-centroid:v1'),
  ('haut/lianhuajie/building/5', 'haut', 'lianhuajie', 'building', '5', 34.831240, 113.546790, 'UNVERIFIED', 'dis-place-status:bootstrap-building-centroid:v1'),
  ('haut/lianhuajie/floor/5-1', 'haut', 'lianhuajie', 'floor', '5-1', 34.831240, 113.546790, 'UNVERIFIED', 'dis-place-status:bootstrap-building-centroid:v1'),
  ('haut/lianhuajie/room/5-111', 'haut', 'lianhuajie', 'room', '5-111', 34.831240, 113.546790, 'UNVERIFIED', 'dis-place-status:bootstrap-building-centroid:v1'),
  ('haut/lianhuajie/entrance/5-south', 'haut', 'lianhuajie', 'entrance', '5-south', 34.831240, 113.546790, 'UNVERIFIED', 'dis-place-status:bootstrap-building-centroid:v1'),
  ('haut/lianhuajie/facility/5-study-seats', 'haut', 'lianhuajie', 'facility', '5-study-seats', 34.831240, 113.546790, 'UNVERIFIED', 'dis-place-status:bootstrap-building-centroid:v1'),
  ('haut/lianhuajie/indoor_node/5-1-lobby', 'haut', 'lianhuajie', 'indoor_node', '5-1-lobby', 34.831240, 113.546790, 'UNVERIFIED', 'dis-place-status:bootstrap-building-centroid:v1')
ON CONFLICT (place_ref) DO NOTHING;

CREATE TABLE IF NOT EXISTS place_reports (
  report_id UUID PRIMARY KEY,
  place_ref TEXT NOT NULL,
  school_id TEXT NOT NULL,
  campus_id TEXT NOT NULL,
  place_type TEXT NOT NULL CHECK (place_type IN ('campus', 'building', 'floor', 'room', 'facility', 'entrance', 'indoor_node')),
  metric TEXT NOT NULL CHECK (metric IN ('ACCESS', 'OPERATION', 'OCCUPANCY', 'SAFETY')),
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'CLOSED', 'RESTRICTED', 'WORKING', 'DEGRADED', 'OUT_OF_SERVICE', 'QUIET', 'MODERATE', 'CROWDED', 'FULL', 'SAFE', 'HAZARD')),
  observed_at TIMESTAMPTZ NOT NULL,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  ttl_seconds INTEGER NOT NULL CHECK (ttl_seconds IN (1800, 3600, 7200, 86400)),
  report_kind TEXT NOT NULL CHECK (report_kind IN ('OBSERVATION', 'CORRECTION')),
  corrects_report_id UUID REFERENCES place_reports(report_id),
  -- Logical user references, intentionally not hard FKs: erase flows tombstone the
  -- user id while preserving an opaque per-reporter key for aggregate correctness.
  reporter_cloud_user_id UUID NOT NULL,
  reporter_key TEXT NOT NULL,
  note TEXT CHECK (note IS NULL OR char_length(note) <= 280),
  moderation_state TEXT NOT NULL DEFAULT 'VISIBLE'
    CHECK (moderation_state IN ('VISIBLE', 'UNDER_REVIEW', 'EXCLUDED_INCORRECT', 'EXCLUDED_ABUSE')),
  aggregation_eligible BOOLEAN NOT NULL DEFAULT TRUE,
  ttl_expiry_accounted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT place_reports_place_scope_fk
    FOREIGN KEY (place_ref, school_id, campus_id, place_type)
    REFERENCES campus_graph_places (place_ref, school_id, campus_id, place_type),
  CONSTRAINT place_reports_metric_state_shape_check CHECK (
    (metric = 'ACCESS' AND state IN ('OPEN', 'CLOSED', 'RESTRICTED')) OR
    (metric = 'OPERATION' AND state IN ('WORKING', 'DEGRADED', 'OUT_OF_SERVICE')) OR
    (metric = 'OCCUPANCY' AND state IN ('QUIET', 'MODERATE', 'CROWDED', 'FULL')) OR
    (metric = 'SAFETY' AND state IN ('SAFE', 'HAZARD'))
  ),
  CONSTRAINT place_reports_ttl_matches_metric_check CHECK (
    (metric = 'OCCUPANCY' AND ttl_seconds = 1800) OR
    (metric = 'SAFETY' AND ttl_seconds = 3600) OR
    (metric = 'ACCESS' AND ttl_seconds = 7200) OR
    (metric = 'OPERATION' AND ttl_seconds = 86400)
  ),
  CONSTRAINT place_reports_expiry_from_observed_check
    CHECK (expires_at = observed_at + (ttl_seconds * INTERVAL '1 second')),
  CONSTRAINT place_reports_correction_shape_check CHECK (
    (report_kind = 'CORRECTION' AND corrects_report_id IS NOT NULL AND corrects_report_id <> report_id) OR
    (report_kind = 'OBSERVATION' AND corrects_report_id IS NULL)
  ),
  CONSTRAINT place_reports_moderation_eligibility_shape_check CHECK (
    (aggregation_eligible = FALSE) = (moderation_state IN ('EXCLUDED_INCORRECT', 'EXCLUDED_ABUSE'))
  )
);

CREATE INDEX IF NOT EXISTS place_reports_place_metric_time_idx
  ON place_reports (school_id, place_ref, metric, observed_at DESC, report_id);
CREATE INDEX IF NOT EXISTS place_reports_reporter_scope_idx
  ON place_reports (reporter_cloud_user_id, school_id, reported_at);
CREATE INDEX IF NOT EXISTS place_reports_corrects_idx
  ON place_reports (corrects_report_id) WHERE corrects_report_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS place_reports_expiry_scan_idx
  ON place_reports (expires_at) WHERE ttl_expiry_accounted_at IS NULL;

CREATE TABLE IF NOT EXISTS place_status_view (
  school_id TEXT NOT NULL,
  place_ref TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('ACCESS', 'OPERATION', 'OCCUPANCY', 'SAFETY')),
  aggregation_revision BIGINT NOT NULL CHECK (aggregation_revision >= 0),
  effective_state TEXT NOT NULL CHECK (effective_state IN ('OPEN', 'CLOSED', 'RESTRICTED', 'WORKING', 'DEGRADED', 'OUT_OF_SERVICE', 'QUIET', 'MODERATE', 'CROWDED', 'FULL', 'SAFE', 'HAZARD', 'CONTESTED', 'UNKNOWN')),
  unknown_reason TEXT CHECK (unknown_reason IS NULL OR unknown_reason IN ('NO_REPORTS', 'ALL_EXPIRED', 'ALL_EXCLUDED')),
  divergent_states JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(divergent_states) = 'array'),
  active_report_count INTEGER NOT NULL DEFAULT 0 CHECK (active_report_count >= 0),
  reporter_count INTEGER NOT NULL DEFAULT 0 CHECK (reporter_count >= 0),
  latest_reported_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  aggregation_algorithm TEXT NOT NULL DEFAULT 'LATEST_PER_REPORTER_ANY_DIVERGENCE_CONTESTED_V1'
    CHECK (aggregation_algorithm = 'LATEST_PER_REPORTER_ANY_DIVERGENCE_CONTESTED_V1'),
  official_realtime_status BOOLEAN NOT NULL DEFAULT FALSE CHECK (official_realtime_status = FALSE),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, place_ref, metric)
);

CREATE TABLE IF NOT EXISTS place_report_flags (
  flag_id UUID PRIMARY KEY,
  report_id UUID NOT NULL REFERENCES place_reports(report_id),
  place_ref TEXT NOT NULL,
  school_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('INCORRECT', 'STALE', 'ABUSE', 'PII', 'SPAM', 'OTHER')),
  detail TEXT CHECK (detail IS NULL OR char_length(detail) <= 500),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED_KEEP_VISIBLE', 'RESOLVED_EXCLUDED', 'REJECTED')),
  flagger_cloud_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  review_action TEXT CHECK (review_action IS NULL OR review_action IN ('KEEP_VISIBLE', 'EXCLUDE_INCORRECT', 'EXCLUDE_ABUSE', 'REJECT_FLAG')),
  review_note TEXT CHECK (review_note IS NULL OR char_length(review_note) BETWEEN 1 AND 500),
  reviewer_cloud_user_id UUID,
  CONSTRAINT place_report_flags_review_shape_check CHECK (
    (status = 'OPEN' AND reviewed_at IS NULL AND review_action IS NULL AND reviewer_cloud_user_id IS NULL) OR
    (status <> 'OPEN' AND reviewed_at IS NOT NULL AND review_action IS NOT NULL AND reviewer_cloud_user_id IS NOT NULL)
  ),
  CONSTRAINT place_report_flags_status_action_shape_check CHECK (
    (status = 'RESOLVED_KEEP_VISIBLE' AND review_action = 'KEEP_VISIBLE') OR
    (status = 'RESOLVED_EXCLUDED' AND review_action IN ('EXCLUDE_INCORRECT', 'EXCLUDE_ABUSE')) OR
    (status = 'REJECTED' AND review_action = 'REJECT_FLAG') OR
    (status = 'OPEN')
  )
);

CREATE INDEX IF NOT EXISTS place_report_flags_queue_idx
  ON place_report_flags (school_id, status, created_at DESC, flag_id);
CREATE INDEX IF NOT EXISTS place_report_flags_report_idx
  ON place_report_flags (report_id, flagger_cloud_user_id, status);
CREATE INDEX IF NOT EXISTS place_report_flags_flagger_idx
  ON place_report_flags (flagger_cloud_user_id, school_id, created_at);

CREATE TABLE IF NOT EXISTS place_status_subscriptions (
  subscription_id UUID PRIMARY KEY,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  school_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('PLACE', 'AREA')),
  place_ref TEXT REFERENCES campus_graph_places(place_ref),
  min_latitude DOUBLE PRECISION CHECK (min_latitude IS NULL OR min_latitude BETWEEN -90 AND 90),
  min_longitude DOUBLE PRECISION CHECK (min_longitude IS NULL OR min_longitude BETWEEN -180 AND 180),
  max_latitude DOUBLE PRECISION CHECK (max_latitude IS NULL OR max_latitude BETWEEN -90 AND 90),
  max_longitude DOUBLE PRECISION CHECK (max_longitude IS NULL OR max_longitude BETWEEN -180 AND 180),
  place_types JSONB CHECK (place_types IS NULL OR jsonb_typeof(place_types) = 'array'),
  metrics JSONB NOT NULL CHECK (jsonb_typeof(metrics) = 'array' AND jsonb_array_length(metrics) > 0),
  delivery_channel TEXT NOT NULL DEFAULT 'IN_APP_NOTIFICATION' CHECK (delivery_channel = 'IN_APP_NOTIFICATION'),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  CONSTRAINT place_status_subscriptions_target_shape_check CHECK (
    (target_type = 'PLACE' AND place_ref IS NOT NULL AND min_latitude IS NULL AND min_longitude IS NULL AND max_latitude IS NULL AND max_longitude IS NULL) OR
    (target_type = 'AREA' AND place_ref IS NULL AND min_latitude IS NOT NULL AND min_longitude IS NOT NULL AND max_latitude IS NOT NULL AND max_longitude IS NOT NULL AND min_latitude < max_latitude AND min_longitude < max_longitude)
  ),
  CONSTRAINT place_status_subscriptions_cancel_shape_check
    CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS place_status_subscriptions_user_idx
  ON place_status_subscriptions (cloud_user_id, school_id, status, created_at);
CREATE INDEX IF NOT EXISTS place_status_subscriptions_event_match_idx
  ON place_status_subscriptions (school_id, status, target_type, place_ref);

-- Explicit per-school operations authorization. A global operations role or an
-- ordinary campus binding is never sufficient for place.status.moderate.
CREATE TABLE IF NOT EXISTS operations_school_grants (
  grant_id UUID PRIMARY KEY,
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  school_id TEXT NOT NULL CHECK (char_length(school_id) BETWEEN 1 AND 128),
  permission TEXT NOT NULL CHECK (permission ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  granted_by_ref TEXT NOT NULL CHECK (char_length(granted_by_ref) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT operations_school_grants_status_shape_check
    CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS operations_school_grants_active_unique
  ON operations_school_grants (cloud_user_id, school_id, permission)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS operations_school_grants_scope_idx
  ON operations_school_grants (cloud_user_id, school_id, permission, status);

COMMIT;
