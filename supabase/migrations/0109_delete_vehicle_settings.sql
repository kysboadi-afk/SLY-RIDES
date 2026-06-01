-- Migration 0109: Vehicle system_settings are kept.
-- The original DELETE has been reverted — vehicle settings remain active.
-- No-op: this migration is intentionally left as a comment-only statement
-- so that the migration sequence remains intact for existing databases.
SELECT 1 WHERE false; -- no-op
