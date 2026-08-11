-- Add 'BILLIONS' to the FinancialStatement.unitScale CHECK constraint.
--
-- Run after deploying the "honor source unit" extraction changes (commit
-- on audit/phase1-2-wrapup that touches financialClassifier.ts +
-- visionExtractor.ts). The classifier's UnitScale type now includes
-- BILLIONS so the LLM can preserve $B-scale source values verbatim;
-- without this migration, any extraction that returns BILLIONS will hit a
-- Postgres CHECK violation on insert.
--
-- Idempotent — safe to re-run. Only touches the unitScale CHECK on the
-- FinancialStatement table; no data changes.

ALTER TABLE "FinancialStatement"
  DROP CONSTRAINT IF EXISTS "FinancialStatement_unitScale_check";

ALTER TABLE "FinancialStatement"
  ADD CONSTRAINT "FinancialStatement_unitScale_check"
  CHECK ("unitScale" IN ('MILLIONS', 'THOUSANDS', 'ACTUALS', 'BILLIONS'));
