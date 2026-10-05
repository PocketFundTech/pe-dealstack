-- Financials — canonical period + source provenance columns
-- Fix plan A4 + B1 (docs/FINANCIALS-FIX-PLAN.md). Run in the Supabase SQL Editor.
--
-- Idempotent — safe to re-run. The code works BEFORE and AFTER this runs:
-- until it does, extraction writes without these columns (one warning in the
-- API log) and matches periods by parsing the label instead.
--
-- After running, backfill existing rows (fills the columns; changes nothing else):
--   cd apps/api && npx tsx scripts/backfill-statement-period-keys.ts --dry-run
--   cd apps/api && npx tsx scripts/backfill-statement-period-keys.ts

-- ─── Canonical period (A4) ──────────────────────────────────────
-- "FY2024 (Jan - Dec 2024)" and "2024" share periodKey '2024'; a 9-month
-- "2025 YTD (Jan - Sep 2025)" is periodKind 'YTD', periodMonths 9.
ALTER TABLE "FinancialStatement" ADD COLUMN IF NOT EXISTS "periodKey" TEXT;
ALTER TABLE "FinancialStatement" ADD COLUMN IF NOT EXISTS "periodKind" TEXT;
ALTER TABLE "FinancialStatement" ADD COLUMN IF NOT EXISTS "periodMonths" INTEGER;
ALTER TABLE "FinancialStatement" ADD COLUMN IF NOT EXISTS "periodEndDate" DATE;

DO $$ BEGIN
  ALTER TABLE "FinancialStatement" ADD CONSTRAINT "FinancialStatement_periodKind_check"
    CHECK ("periodKind" IS NULL OR "periodKind" IN ('FY', 'YTD', 'LTM', 'Q', 'H', 'M', 'EST'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Source provenance (B1) ─────────────────────────────────────
-- sourceKind: the company's reported statement vs a valuation / analysis
-- model built from it. sheetName: the spreadsheet tab it came from.
ALTER TABLE "FinancialStatement" ADD COLUMN IF NOT EXISTS "sourceKind" TEXT;
ALTER TABLE "FinancialStatement" ADD COLUMN IF NOT EXISTS "sheetName" TEXT;

DO $$ BEGIN
  ALTER TABLE "FinancialStatement" ADD CONSTRAINT "FinancialStatement_sourceKind_check"
    CHECK ("sourceKind" IS NULL OR "sourceKind" IN ('source_statement', 'model_derived'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Index for the cross-document conflict lookup ───────────────
CREATE INDEX IF NOT EXISTS idx_financial_statement_period_key
  ON "FinancialStatement" ("dealId", "statementType", "periodKey")
  WHERE "isActive" = true;

-- Make PostgREST see the new columns immediately.
NOTIFY pgrst, 'reload schema';

-- ─── Verify ─────────────────────────────────────────────────────
-- select column_name, data_type from information_schema.columns
--  where table_name = 'FinancialStatement'
--    and column_name in ('periodKey','periodKind','periodMonths','periodEndDate','sourceKind','sheetName');
--  -- expect 6 rows
--
-- After the backfill, every row has a key:
-- select count(*) filter (where "periodKey" is null) as missing, count(*) as total from "FinancialStatement";
