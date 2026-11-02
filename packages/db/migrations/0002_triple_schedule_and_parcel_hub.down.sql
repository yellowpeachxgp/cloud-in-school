BEGIN;
DROP TABLE IF EXISTS parcel_sync_jobs;
DROP TABLE IF EXISTS parcel_tracking_events;
DROP TABLE IF EXISTS parcel_source_observations;
DROP TABLE IF EXISTS parcels;
DROP TABLE IF EXISTS parcel_source_connections;
DROP TABLE IF EXISTS installed_plugins;
DROP TABLE IF EXISTS booking_schedule_events;
COMMIT;
