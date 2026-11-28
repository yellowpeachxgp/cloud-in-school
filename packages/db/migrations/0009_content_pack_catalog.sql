-- Migration 0009: W5-02 signed content package catalog, immutable versions,
-- maintainer review separation, lifecycle retirement, and rate accounting (CT-06).
-- The catalog stores public-source package artifacts only; it never stores credentials,
-- submitter SSO identities, or trust-root private keys.
BEGIN;

CREATE TABLE IF NOT EXISTS content_pack_submissions (
  submission_id UUID PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('PENDING_REVIEW','CHANGES_REQUESTED','APPROVED','REJECTED','PUBLISHED')),
  artifact_format TEXT NOT NULL CHECK (artifact_format IN ('dis-campus-plugin/v1','dis-datapack/v1')),
  kind TEXT NOT NULL CHECK (kind IN ('school-profile','campus-guide','procedure-guide','opportunity-catalog','facility-catalog','indoor-graph','period-preset','pharmacy-catalog')),
  school_id TEXT NOT NULL CHECK (school_id ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  pack_id TEXT NOT NULL CHECK (pack_id ~ '^[a-z0-9][a-z0-9._-]{2,127}$'),
  version TEXT NOT NULL CHECK (version ~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$'),
  artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_size_bytes INTEGER NOT NULL CHECK (artifact_size_bytes BETWEEN 1 AND 16777216),
  artifact BYTEA NOT NULL,
  contribution_reference TEXT NOT NULL CHECK (contribution_reference ~ '^https://' AND char_length(contribution_reference) <= 2048),
  provenance_json JSONB NOT NULL CHECK (jsonb_typeof(provenance_json) = 'object'),
  submission_note TEXT CHECK (submission_note IS NULL OR char_length(submission_note) <= 2000),
  -- Logical user reference only. Erasure pseudonymizes published history and removes unpublished rows.
  submitter_cloud_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_pack_submissions_artifact_size_shape_check
    CHECK (octet_length(artifact) = artifact_size_bytes),
  CONSTRAINT content_pack_submissions_format_kind_shape_check CHECK (
    (artifact_format = 'dis-campus-plugin/v1' AND kind IN ('school-profile','campus-guide')) OR
    (artifact_format = 'dis-datapack/v1' AND kind IN ('procedure-guide','opportunity-catalog','facility-catalog','indoor-graph','period-preset','pharmacy-catalog'))
  ),
  CONSTRAINT content_pack_submissions_datapack_school_shape_check CHECK (
    artifact_format <> 'dis-datapack/v1' OR split_part(pack_id, '.', 1) = school_id
  ),
  CONSTRAINT content_pack_submissions_reviewed_shape_check CHECK (
    (status = 'PENDING_REVIEW') OR (updated_at >= created_at)
  )
);

CREATE INDEX IF NOT EXISTS content_pack_submissions_review_queue_idx
  ON content_pack_submissions (school_id, status, kind, created_at DESC, submission_id);
CREATE INDEX IF NOT EXISTS content_pack_submissions_submitter_idx
  ON content_pack_submissions (submitter_cloud_user_id, created_at DESC, submission_id);
CREATE INDEX IF NOT EXISTS content_pack_submissions_pack_idx
  ON content_pack_submissions (pack_id, version, status);

CREATE TABLE IF NOT EXISTS content_pack_reviews (
  review_id UUID PRIMARY KEY,
  submission_id UUID NOT NULL UNIQUE REFERENCES content_pack_submissions(submission_id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('APPROVE','REQUEST_CHANGES','REJECT')),
  reviewer_cloud_user_id UUID NOT NULL,
  review_note TEXT CHECK (review_note IS NULL OR char_length(review_note) BETWEEN 1 AND 2000),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_pack_reviews_note_required_shape_check CHECK (
    (action = 'APPROVE') OR (review_note IS NOT NULL AND char_length(review_note) > 0)
  )
);

CREATE INDEX IF NOT EXISTS content_pack_reviews_reviewer_idx
  ON content_pack_reviews (reviewer_cloud_user_id, reviewed_at DESC, review_id);

CREATE OR REPLACE FUNCTION content_pack_enforce_review_separation() RETURNS trigger AS $$
DECLARE
  immutable_submitter UUID;
BEGIN
  SELECT submitter_cloud_user_id INTO immutable_submitter
    FROM content_pack_submissions
   WHERE submission_id = NEW.submission_id;
  IF immutable_submitter IS NULL THEN
    RAISE EXCEPTION 'CONTENT_PACK_SUBMISSION_NOT_FOUND: review submission missing' USING ERRCODE = '23503';
  END IF;
  IF NEW.reviewer_cloud_user_id = immutable_submitter THEN
    RAISE EXCEPTION 'CONTENT_PACK_SUBMITTER_CANNOT_REVIEW: submitter and reviewer principals must differ' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_pack_reviews_separation_trg ON content_pack_reviews;
CREATE TRIGGER content_pack_reviews_separation_trg
  BEFORE INSERT OR UPDATE ON content_pack_reviews
  FOR EACH ROW EXECUTE FUNCTION content_pack_enforce_review_separation();

CREATE TABLE IF NOT EXISTS content_pack_versions (
  school_id TEXT NOT NULL CHECK (school_id ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  pack_id TEXT NOT NULL CHECK (pack_id ~ '^[a-z0-9][a-z0-9._-]{2,127}$'),
  version TEXT NOT NULL CHECK (version ~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$'),
  kind TEXT NOT NULL CHECK (kind IN ('school-profile','campus-guide','procedure-guide','opportunity-catalog','facility-catalog','indoor-graph','period-preset','pharmacy-catalog')),
  artifact_format TEXT NOT NULL CHECK (artifact_format IN ('dis-campus-plugin/v1','dis-datapack/v1')),
  artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_size_bytes INTEGER NOT NULL CHECK (artifact_size_bytes BETWEEN 1 AND 16777216),
  artifact BYTEA NOT NULL,
  signature_json JSONB NOT NULL CHECK (jsonb_typeof(signature_json) = 'object'),
  provenance_json JSONB NOT NULL CHECK (jsonb_typeof(provenance_json) = 'object'),
  min_host_api INTEGER CHECK (min_host_api IS NULL OR min_host_api BETWEEN 1 AND 2147483647),
  min_app_version_code INTEGER CHECK (min_app_version_code IS NULL OR min_app_version_code BETWEEN 1 AND 2147483647),
  release_note TEXT CHECK (release_note IS NULL OR char_length(release_note) <= 1000),
  lifecycle_status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (lifecycle_status IN ('PUBLISHED','RETIRED')),
  submission_id UUID NOT NULL UNIQUE REFERENCES content_pack_submissions(submission_id) ON DELETE RESTRICT,
  publisher_cloud_user_id UUID NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  retirement_reason TEXT CHECK (retirement_reason IS NULL OR retirement_reason IN ('INCORRECT_DATA','OUTDATED','SECURITY','LICENSE','MAINTAINER_REQUEST','OTHER')),
  retirement_detail TEXT CHECK (retirement_detail IS NULL OR char_length(retirement_detail) <= 1000),
  retired_by_cloud_user_id UUID,
  PRIMARY KEY (pack_id, version),
  CONSTRAINT content_pack_versions_artifact_size_shape_check
    CHECK (octet_length(artifact) = artifact_size_bytes),
  CONSTRAINT content_pack_versions_format_kind_shape_check CHECK (
    (artifact_format = 'dis-campus-plugin/v1' AND kind IN ('school-profile','campus-guide')) OR
    (artifact_format = 'dis-datapack/v1' AND kind IN ('procedure-guide','opportunity-catalog','facility-catalog','indoor-graph','period-preset','pharmacy-catalog'))
  ),
  CONSTRAINT content_pack_versions_datapack_school_shape_check CHECK (
    artifact_format <> 'dis-datapack/v1' OR split_part(pack_id, '.', 1) = school_id
  ),
  CONSTRAINT content_pack_versions_lifecycle_shape_check CHECK (
    (lifecycle_status = 'PUBLISHED' AND retired_at IS NULL AND retirement_reason IS NULL AND retired_by_cloud_user_id IS NULL) OR
    (lifecycle_status = 'RETIRED' AND retired_at IS NOT NULL AND retirement_reason IS NOT NULL AND retired_by_cloud_user_id IS NOT NULL)
  ),
  CONSTRAINT content_pack_versions_other_reason_detail_check CHECK (
    retirement_reason IS DISTINCT FROM 'OTHER' OR (retirement_detail IS NOT NULL AND char_length(retirement_detail) > 0)
  )
);

CREATE INDEX IF NOT EXISTS content_pack_versions_catalog_idx
  ON content_pack_versions (school_id, kind, artifact_format, lifecycle_status, pack_id);
CREATE INDEX IF NOT EXISTS content_pack_versions_publisher_idx
  ON content_pack_versions (publisher_cloud_user_id, published_at DESC, pack_id, version);
CREATE INDEX IF NOT EXISTS content_pack_versions_submission_idx
  ON content_pack_versions (submission_id);

CREATE TABLE IF NOT EXISTS content_pack_rate_windows (
  cloud_user_id UUID NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('SUBMIT','DOWNLOAD')),
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  PRIMARY KEY (cloud_user_id, operation_kind, window_started_at)
);

CREATE INDEX IF NOT EXISTS content_pack_rate_windows_cleanup_idx
  ON content_pack_rate_windows (window_started_at);

COMMIT;
