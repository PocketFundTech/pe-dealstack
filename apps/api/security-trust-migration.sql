-- ============================================================
-- Security & Trust Migration — Organization.requireMFA
-- Adds organization-level toggle to require all members to enable 2FA.
-- Default: false (no behavior change for existing orgs).
--
-- To apply: psql "$SUPABASE_DB_URL" -f apps/api/security-trust-migration.sql
-- Or run via the Supabase SQL editor.
-- ============================================================

ALTER TABLE public."Organization"
  ADD COLUMN IF NOT EXISTS "requireMFA" boolean NOT NULL DEFAULT false;
