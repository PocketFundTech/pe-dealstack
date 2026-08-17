-- ============================================================
-- Deal Model Migration — DealModel
--
-- Saved assumption sets per deal, so a partner's inputs survive between
-- sessions and an exported workbook can be regenerated identically.
--
-- Only the ASSUMPTIONS are persisted, never the workbook itself: the
-- .xlsx is a pure function of (assumptions, extracted financials), and
-- storing binaries would go stale the moment either changed.
--
-- To apply: psql "$SUPABASE_DB_URL" -f apps/api/deal-model-migration.sql
-- Or run via the Supabase SQL editor. (Vercel does NOT run this.)
-- ============================================================

CREATE TABLE IF NOT EXISTS "DealModel" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId"         uuid NOT NULL REFERENCES "Deal"(id) ON DELETE CASCADE,
  "organizationId" uuid NOT NULL,
  name             text NOT NULL DEFAULT 'Base case',
  -- Validated by assumptionsSchema in services/dealModel/assumptions.ts
  assumptions      jsonb NOT NULL,
  "createdBy"      text,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "updatedAt"      timestamptz NOT NULL DEFAULT now(),
  -- One saved case per name per deal, so PUT can upsert cleanly.
  UNIQUE ("dealId", name)
);
CREATE INDEX IF NOT EXISTS "DealModel_dealId_idx" ON "DealModel"("dealId");

ALTER TABLE "DealModel" ENABLE ROW LEVEL SECURITY;
