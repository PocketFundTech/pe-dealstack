-- Usage cost accuracy (2026-09-29)
--
-- Makes the UsageEvent ledger price every Anthropic token correctly and adds
-- the table the daily reconciliation job writes to. Idempotent — safe to re-run.
--
-- Prices verified 2026-09-29 against the Claude API reference (list prices,
-- USD per 1M tokens). Re-verify before changing:
--   claude-fable-5     $10 / $50      claude-fable-5-1  $10 / $50 (cache read $0.25)
--   claude-opus-5      $5  / $25      claude-opus-4-8   $5  / $25
--   claude-sonnet-5    $2  / $10      claude-sonnet-4-6 $3  / $15
--   claude-haiku-4-5   $1  / $5
-- Cache multipliers on input price: read 0.1x, 5-minute write 1.25x,
-- 1-hour write 2x — applied in code (modelPrices.ts) unless a row sets an
-- explicit cache price below.

-- 1. Optional explicit cache prices (NULL = use the standard multiplier).
ALTER TABLE public."ModelPrice" ADD COLUMN IF NOT EXISTS "cacheReadPricePer1M"    numeric(12,6);
ALTER TABLE public."ModelPrice" ADD COLUMN IF NOT EXISTS "cacheWrite5mPricePer1M" numeric(12,6);
ALTER TABLE public."ModelPrice" ADD COLUMN IF NOT EXISTS "cacheWrite1hPricePer1M" numeric(12,6);

-- 2. Correct and complete the Anthropic prices.
--    Fixes claude-sonnet-5 (was seeded at 3/15 — every chat/memo/NDA/scorecard
--    row was overstated 50%) and adds claude-sonnet-4-6 (was missing — deal
--    chat and legacy extraction recorded $0). Supersedes
--    model-prices-anthropic-direct-seed.sql.
INSERT INTO public."ModelPrice" (model, provider, "inputPricePer1M", "outputPricePer1M", "cacheReadPricePer1M") VALUES
  ('claude-fable-5',            'anthropic', 10.0, 50.0, NULL),
  ('claude-fable-5-1',          'anthropic', 10.0, 50.0, 0.25),
  ('claude-opus-5',             'anthropic',  5.0, 25.0, NULL),
  ('claude-opus-4-8',           'anthropic',  5.0, 25.0, NULL),
  ('claude-sonnet-5',           'anthropic',  2.0, 10.0, NULL),
  ('claude-sonnet-4-6',         'anthropic',  3.0, 15.0, NULL),
  ('claude-haiku-4-5',          'anthropic',  1.0,  5.0, NULL),
  ('claude-haiku-4-5-20251001', 'anthropic',  1.0,  5.0, NULL)
ON CONFLICT (model) DO UPDATE SET
  provider              = EXCLUDED.provider,
  "inputPricePer1M"     = EXCLUDED."inputPricePer1M",
  "outputPricePer1M"    = EXCLUDED."outputPricePer1M",
  "cacheReadPricePer1M" = EXCLUDED."cacheReadPricePer1M",
  "updatedAt"           = now();

-- 3. Allow the providers that were previously untrackable.
ALTER TABLE public."UsageEvent" DROP CONSTRAINT IF EXISTS usage_event_provider_check;
ALTER TABLE public."UsageEvent" ADD CONSTRAINT usage_event_provider_check CHECK (provider IN (
  'openai', 'openrouter', 'gemini', 'anthropic', 'apify', 'azure_doc_intelligence',
  'tavily', 'llamaparse'
));

-- 4. Daily reconciliation of our ledger against Anthropic's own cost report
--    (Admin API /v1/organizations/cost_report). One row per UTC day.
CREATE TABLE IF NOT EXISTS public."UsageReconciliation" (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "day"               date NOT NULL UNIQUE,
  provider            text NOT NULL DEFAULT 'anthropic',
  "ledgerCostUsd"     numeric(12,6) NOT NULL,
  "providerCostUsd"   numeric(12,6) NOT NULL,
  "driftUsd"          numeric(12,6) NOT NULL,
  "driftPct"          numeric(8,3),
  "ledgerTokens"      bigint NOT NULL DEFAULT 0,
  "providerTokens"    bigint NOT NULL DEFAULT 0,
  breakdown           jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public."UsageReconciliation" ENABLE ROW LEVEL SECURITY;

-- Verify:
-- SELECT model, "inputPricePer1M", "outputPricePer1M", "cacheReadPricePer1M"
--   FROM public."ModelPrice" WHERE model LIKE 'claude-%' ORDER BY model;
--   → claude-sonnet-5 must read 2 / 10; claude-sonnet-4-6 must exist at 3 / 15.
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'usage_event_provider_check';
--   → must include 'tavily' and 'llamaparse'.
-- SELECT to_regclass('public."UsageReconciliation"');  → not null
