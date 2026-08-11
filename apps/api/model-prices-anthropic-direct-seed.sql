-- ModelPrice seed: anthropic-DIRECT model ids.
--
-- The existing seed (usage-tracking-migration.sql) has the OpenRouter-style
-- 'anthropic/claude-sonnet-4.6' (dotted, slash-prefixed), but the app runs
-- Anthropic DIRECT (chatProvider=anthropic, routedThroughOpenRouter=false) with
-- the hyphenated id 'claude-sonnet-4-6'. That exact string isn't in ModelPrice,
-- so recordUsageEvent logs "unknown model claude-sonnet-4-6, costUsd=0" and
-- usage cost is undercounted. This adds the direct ids.
--
-- Prices in USD per 1,000,000 tokens; mirror the Sonnet/Haiku tiers already
-- seeded for the OpenRouter variants. VERIFY against current Anthropic pricing
-- before relying on these for billing.
-- Idempotent (ON CONFLICT upsert) — safe to re-run.

INSERT INTO public."ModelPrice" (model, provider, "inputPricePer1M", "outputPricePer1M") VALUES
  ('claude-sonnet-4-6', 'anthropic',  3.0000, 15.0000),
  ('claude-haiku-4-5',  'anthropic',  1.0000,  5.0000)
ON CONFLICT (model) DO UPDATE SET
  provider           = EXCLUDED.provider,
  "inputPricePer1M"  = EXCLUDED."inputPricePer1M",
  "outputPricePer1M" = EXCLUDED."outputPricePer1M",
  "updatedAt"        = now();

-- Verify:
-- SELECT model, provider, "inputPricePer1M", "outputPricePer1M"
--   FROM public."ModelPrice" WHERE model LIKE 'claude-%';
