-- apps/api/staff-access-log-migration.sql
--
-- Adds the per-org notification config for the customer-visible Pocket Fund
-- staff access log feature. Both columns are nullable; default behavior is
-- "no notifications until the customer opts in".
--
-- Idempotent. Safe to re-run.
--
-- To apply:
--   psql "$SUPABASE_DB_URL" -f apps/api/staff-access-log-migration.sql
-- Or via the Supabase SQL Editor (paste the body below).

ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "staffAccessWebhookUrl" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "staffAccessNotifyEmail" TEXT NULL;
