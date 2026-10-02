-- ============================================================
-- Read-only API keys — ApiKey.scope
-- Lets an admin create a key that can only GET data, for tools that
-- shouldn't be able to create, edit or delete anything in Avise.
--
-- Run manually in the Supabase SQL Editor (Vercel does NOT run this).
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "scope" text NOT NULL DEFAULT 'full';

ALTER TABLE "ApiKey" DROP CONSTRAINT IF EXISTS "ApiKey_scope_check";
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_scope_check" CHECK ("scope" IN ('full', 'read_only'));

-- Verify
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'ApiKey' AND column_name = 'scope';
