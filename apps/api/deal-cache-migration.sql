-- Phase 2: Deal canonical-cache columns.
--
-- Phase 1 (commit 9a615e4) patched the /deals UI to ignore the legacy
-- Deal.revenue / Deal.ebitda columns and pull headline numbers from
-- /api/deals/financial-summaries instead, because those legacy columns
-- have no unitScale tag — formatCurrency() assumes MILLIONS, so a deal
-- whose revenue was stored as THOUSANDS rendered "$21.5M" for what was
-- actually $21.5K. That was a workaround.
--
-- This migration adds canonical-cache columns to Deal so the financial
-- extraction pipeline can write back the latest period's revenue/EBITDA
-- in ACTUAL DOLLARS (single canonical scale, no per-row unit tag needed).
-- After this lands, every consumer of `deal.cachedRevenue` /
-- `deal.cachedEbitda` gets correct numbers without having to call the
-- bulk summaries endpoint.
--
-- Idempotent — safe to re-run. Each ADD COLUMN uses IF NOT EXISTS.
--
-- The writeback path lives in
-- apps/api/src/services/dealCacheWriteback.ts and is invoked from
-- runDeepPass() in financialExtractionOrchestrator.ts. The one-shot
-- backfill is apps/api/scripts/backfill-deal-cache.ts.

ALTER TABLE "Deal"
  ADD COLUMN IF NOT EXISTS "cachedRevenue" DOUBLE PRECISION;

ALTER TABLE "Deal"
  ADD COLUMN IF NOT EXISTS "cachedEbitda" DOUBLE PRECISION;

ALTER TABLE "Deal"
  ADD COLUMN IF NOT EXISTS "cachedEbitdaMargin" DOUBLE PRECISION;

ALTER TABLE "Deal"
  ADD COLUMN IF NOT EXISTS "cachedPeriod" TEXT;

ALTER TABLE "Deal"
  ADD COLUMN IF NOT EXISTS "cachedCurrency" TEXT;

ALTER TABLE "Deal"
  ADD COLUMN IF NOT EXISTS "cachedAt" TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN "Deal"."cachedRevenue" IS
  'Latest-period revenue, in ACTUAL DOLLARS (unitScale already applied). Refreshed on every FinancialStatement upsert.';
COMMENT ON COLUMN "Deal"."cachedEbitda" IS
  'Latest-period EBITDA, in ACTUAL DOLLARS (unitScale already applied). Refreshed on every FinancialStatement upsert.';
COMMENT ON COLUMN "Deal"."cachedEbitdaMargin" IS
  'EBITDA margin in percent (0-100). Either explicit ebitda_margin_pct from the source row, or computed ebitda/revenue * 100.';
COMMENT ON COLUMN "Deal"."cachedPeriod" IS
  'Period label of the source FinancialStatement row used to populate the cache (e.g. "Mar 2026", "FY25").';
COMMENT ON COLUMN "Deal"."cachedCurrency" IS
  'ISO 4217 currency code from the source FinancialStatement row.';
COMMENT ON COLUMN "Deal"."cachedAt" IS
  'When the cache was last refreshed by the extraction pipeline (or the backfill script).';
