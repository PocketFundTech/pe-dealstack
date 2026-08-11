-- ============================================================
-- Deal Scorecard Migration — Deal.scorecard
-- Adds the JSONB column holding the two-layer scorecard verdict.
--
-- To apply: psql "$SUPABASE_DB_URL" -f apps/api/scorecard-migration.sql
-- Or run via the Supabase SQL editor. (Vercel does NOT run this.)
-- ============================================================

ALTER TABLE public."Deal"
  ADD COLUMN IF NOT EXISTS "scorecard" jsonb;
