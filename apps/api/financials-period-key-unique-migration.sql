-- Financials — one active row per canonical period (fix plan G9)
-- docs/FINANCIALS-FIX-PLAN.md → Phase G, PR C. Run in the Supabase SQL Editor.
--
-- Why: "2024" and "FY2024 (Jan - Dec 2024)" are the same fiscal year
-- (periodKey '2024'), but the only database guard was a unique index on the
-- raw label, so both could stay active — two columns for one year in the
-- financials table and the model, possibly with different numbers.
--
-- ORDER (the script refuses to run otherwise):
--   1. Backfill period keys on older rows (fills periodKey; changes nothing else):
--        cd apps/api && npx tsx scripts/backfill-statement-period-keys.ts --dry-run
--        cd apps/api && npx tsx scripts/backfill-statement-period-keys.ts
--   2. Run this file.
--
-- What it does:
--   a) Where a deal has more than one ACTIVE row for the same statement type
--      and canonical period, keeps one active — a reported statement over a
--      model-derived one, then the highest extraction confidence, then the
--      newest — flags it 'needs_review', and deactivates the rest (rows are
--      kept, only isActive changes).
--   b) Adds a unique index so it can't happen again.
-- Idempotent — safe to re-run.

-- ─── Guard: period keys must be backfilled first ────────────────
DO $$
DECLARE missing integer;
BEGIN
  SELECT count(*) INTO missing FROM "FinancialStatement" WHERE "isActive" = true AND "periodKey" IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION '% active FinancialStatement rows have no periodKey. Run apps/api/scripts/backfill-statement-period-keys.ts first, then re-run this file.', missing;
  END IF;
END $$;

-- ─── a) Flag the row that stays active where duplicates exist ───
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER w AS rn,
         COUNT(*) OVER (PARTITION BY "dealId", "statementType", "periodKey") AS n
  FROM "FinancialStatement"
  WHERE "isActive" = true
  WINDOW w AS (
    PARTITION BY "dealId", "statementType", "periodKey"
    ORDER BY ("sourceKind" IS DISTINCT FROM 'model_derived') DESC,
             "extractionConfidence" DESC NULLS LAST,
             "extractedAt" DESC NULLS LAST,
             id
  )
)
UPDATE "FinancialStatement" f
SET "mergeStatus" = 'needs_review'
FROM ranked r
WHERE f.id = r.id AND r.rn = 1 AND r.n > 1;

-- ─── a) Deactivate the duplicates ───────────────────────────────
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY "dealId", "statementType", "periodKey"
           ORDER BY ("sourceKind" IS DISTINCT FROM 'model_derived') DESC,
                    "extractionConfidence" DESC NULLS LAST,
                    "extractedAt" DESC NULLS LAST,
                    id
         ) AS rn
  FROM "FinancialStatement"
  WHERE "isActive" = true
)
UPDATE "FinancialStatement" f
SET "isActive" = false
FROM ranked r
WHERE f.id = r.id AND r.rn > 1;

-- ─── b) One active row per deal / statement type / canonical period ──
CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_statement_active_period_key_unique
  ON "FinancialStatement" ("dealId", "statementType", "periodKey")
  WHERE "isActive" = true AND "periodKey" IS NOT NULL;

NOTIFY pgrst, 'reload schema';

-- ─── Verify ─────────────────────────────────────────────────────
-- select
--   (select count(*) from pg_indexes where indexname = 'idx_financial_statement_active_period_key_unique') as unique_index,   -- 1
--   (select count(*) from (
--      select 1 from "FinancialStatement" where "isActive"
--      group by "dealId", "statementType", "periodKey" having count(*) > 1) d) as duplicate_groups,                           -- 0
--   (select count(*) from "FinancialStatement" where "isActive" and "periodKey" is null) as active_without_key;                 -- 0
