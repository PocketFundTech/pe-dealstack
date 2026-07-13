-- Phase 1: Claude extraction engine (spec 2026-07-11)
-- RUN MANUALLY in Supabase SQL editor — Vercel deploys code but never runs SQL.

-- 1) Allow 'claude' as an extractionSource on FinancialStatement.
-- Default Postgres name for an inline column CHECK is <table>_<column>_check.
-- If the DROP fails, find the real name with:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = '"FinancialStatement"'::regclass AND contype = 'c';
ALTER TABLE "FinancialStatement"
  DROP CONSTRAINT IF EXISTS "FinancialStatement_extractionSource_check";
ALTER TABLE "FinancialStatement"
  ADD CONSTRAINT "FinancialStatement_extractionSource_check"
  CHECK ("extractionSource" IN ('gpt4o', 'azure', 'vision', 'manual', 'claude'));

-- 2) Price rows so UsageEvent cost attribution works for the new models.
-- (modelPrices.ts caches this table; costUsd=0 + priceLookupFailed=true otherwise.)
INSERT INTO "ModelPrice" (model, provider, "inputPricePer1M", "outputPricePer1M") VALUES
  ('claude-fable-5',  'anthropic', 10, 50),
  ('claude-opus-4-8', 'anthropic',  5, 25),
  ('claude-sonnet-5', 'anthropic',  3, 15),
  ('claude-haiku-4-5','anthropic',  1,  5)
ON CONFLICT (model) DO UPDATE
  SET "inputPricePer1M" = EXCLUDED."inputPricePer1M",
      "outputPricePer1M" = EXCLUDED."outputPricePer1M",
      provider = EXCLUDED.provider;
