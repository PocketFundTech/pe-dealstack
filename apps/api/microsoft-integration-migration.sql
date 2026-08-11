-- ============================================================
-- Microsoft integrations (Outlook + Microsoft 365)
--
-- Adds the two new provider ids to the CHECK constraints that gate the
-- Integration.provider and IntegrationActivity.source columns. Without this,
-- the OAuth callback's INSERT into Integration (and every synced
-- IntegrationActivity row) fails the existing constraint.
--
-- No new tables — Outlook/Microsoft 365 reuse the existing Integration +
-- IntegrationActivity schema, exactly like Gmail / Google Workspace.
--
-- Idempotent: drops and re-adds the named constraints. Run in Supabase SQL
-- Editor (or psql -f).
-- ============================================================

-- Integration.provider — the connection's provider id.
ALTER TABLE public."Integration"
  DROP CONSTRAINT IF EXISTS "Integration_provider_check";
ALTER TABLE public."Integration"
  ADD CONSTRAINT "Integration_provider_check"
  CHECK (provider IN (
    'granola','gmail','google_calendar','outlook','microsoft365','fireflies','otter','_mock'
  ));

-- IntegrationActivity.source — the provider that produced a synced item.
ALTER TABLE public."IntegrationActivity"
  DROP CONSTRAINT IF EXISTS "IntegrationActivity_source_check";
ALTER TABLE public."IntegrationActivity"
  ADD CONSTRAINT "IntegrationActivity_source_check"
  CHECK (source IN (
    'granola','gmail','google_calendar','outlook','microsoft365','fireflies','otter','_mock'
  ));

-- Verify:
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conname IN ('Integration_provider_check','IntegrationActivity_source_check');
