-- Strengthen Organization.slug uniqueness to fix signup race condition.
-- See .planning/REMEDIATION_ROADMAP.md Phase 6 Task 6.7.
--
-- IDEMPOTENT — safe to re-run.
--
-- This migration only adds a unique constraint on Organization.slug.
-- It does NOT add a unique constraint on `name` because two distinct
-- firms can legitimately share the same display name (e.g., two
-- different "Acme Capital" firms).
--
-- Run via: psql "$SUPABASE_DB_URL" -f apps/api/organization-name-unique-migration.sql

-- Step 1: Check for existing duplicate slugs (should be zero).
--   SELECT slug, count(*) FROM public."Organization"
--   GROUP BY slug HAVING count(*) > 1;
-- If non-empty, resolve manually before continuing.

-- Step 2: Add unique constraint on slug.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Organization_slug_unique'
  ) THEN
    ALTER TABLE public."Organization"
      ADD CONSTRAINT "Organization_slug_unique" UNIQUE ("slug");
  END IF;
END$$;
