-- ============================================================
-- DealShare expiry-warning migration
-- Adds the column the expiry-warning cron uses to guarantee it only ever
-- warns a given share link once, even though the cron runs daily.
--
-- Run manually in Supabase per this repo's migration-gate convention.
-- ============================================================

ALTER TABLE "DealShare" ADD COLUMN "expiryWarningSentAt" timestamptz;
