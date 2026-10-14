-- Usage cost backfill (2026-10-11) — AI cost plan item H3
--
-- 785 calls on claude-sonnet-4-5 / claude-sonnet-4-6 were recorded at $0 or
-- below list price, so the ledger shows ~$27.86 all-time instead of ~$54:
--   * claude-sonnet-4-5 (and its dated ids, e.g. claude-sonnet-4-5-20250929)
--     has never had a ModelPrice row.
--   * claude-sonnet-4-6 was only added on 2026-09-29
--     (usage-cost-accuracy-migration.sql); every earlier call recorded $0.
-- Unpriced rows carry metadata.priceLookupFailed = true.
--
-- Run the sections IN ORDER in the Supabase SQL editor. Sections 1 and 3 are
-- read-only. Section 2 and 4 write; 4 runs in a transaction and only ever
-- RAISES a row's cost to the current list price (it never lowers one).
--
-- Prices (USD per 1M tokens, Claude API list prices, re-verify before changing):
--   claude-sonnet-4-5  $3 / $15     claude-sonnet-4-6  $3 / $15
-- Cache multipliers on input price — same as modelPrices.ts: Anthropic read
-- 0.1x, 5-minute write 1.25x, 1-hour write 2x; other providers 1x. An explicit
-- cache price on the ModelPrice row wins.


-- ─── 1. Diagnose (read-only) ─────────────────────────────────────────────
-- Models in the ledger with no price, after stripping a dated -YYYYMMDD
-- suffix (getModelPrice does the same). Anything listed here besides
-- claude-sonnet-4-5 / 4-6 needs a price added to section 2 before section 4
-- runs. Ignore non-LLM providers (gemini embeddings, apify, azure, tavily):
-- they are priced per unit in code, not from ModelPrice, and section 4 only
-- touches anthropic / openai / openrouter rows.
SELECT e.model, e.provider, COUNT(*) AS calls,
       SUM(e."promptTokens") AS input_tokens, SUM(e."completionTokens") AS output_tokens
FROM public."UsageEvent" e
LEFT JOIN public."ModelPrice" p
  ON p.model = e.model OR p.model = regexp_replace(e.model, '-\d{8}$', '')
WHERE e.model IS NOT NULL AND p.model IS NULL
GROUP BY 1, 2
ORDER BY calls DESC;


-- ─── 2. Add the missing prices (idempotent) ──────────────────────────────
INSERT INTO public."ModelPrice" (model, provider, "inputPricePer1M", "outputPricePer1M") VALUES
  ('claude-sonnet-4-5', 'anthropic', 3.0, 15.0),
  ('claude-sonnet-4-6', 'anthropic', 3.0, 15.0)
ON CONFLICT (model) DO UPDATE SET
  provider           = EXCLUDED.provider,
  "inputPricePer1M"  = EXCLUDED."inputPricePer1M",
  "outputPricePer1M" = EXCLUDED."outputPricePer1M",
  "updatedAt"        = now();


-- ─── 3. Preview the backfill (read-only) ─────────────────────────────────
-- What section 4 will change, per model. Check the totals look right
-- (expected: roughly +$26 across claude-sonnet-4-5 / 4-6) before running 4.
WITH priced AS (
  SELECT e.id, e.model, e."costUsd" AS old_cost,
    (e."promptTokens" / 1e6) * p."inputPricePer1M"
    + (e."completionTokens" / 1e6) * p."outputPricePer1M"
    + (COALESCE((e.metadata->>'cacheReadTokens')::numeric, 0) / 1e6)
        * COALESCE(p."cacheReadPricePer1M", p."inputPricePer1M" * CASE WHEN p.provider = 'anthropic' THEN 0.1 ELSE 1 END)
    + (COALESCE((e.metadata->>'cacheWrite5mTokens')::numeric, 0) / 1e6)
        * COALESCE(p."cacheWrite5mPricePer1M", p."inputPricePer1M" * CASE WHEN p.provider = 'anthropic' THEN 1.25 ELSE 1 END)
    + (COALESCE((e.metadata->>'cacheWrite1hTokens')::numeric, 0) / 1e6)
        * COALESCE(p."cacheWrite1hPricePer1M", p."inputPricePer1M" * CASE WHEN p.provider = 'anthropic' THEN 2 ELSE 1 END)
      AS new_cost
  FROM public."UsageEvent" e
  JOIN LATERAL (
    SELECT * FROM public."ModelPrice" mp
    WHERE mp.model = e.model OR mp.model = regexp_replace(e.model, '-\d{8}$', '')
    ORDER BY (mp.model = e.model) DESC
    LIMIT 1
  ) p ON true
  WHERE e.provider IN ('anthropic', 'openai', 'openrouter')
    AND NOT (COALESCE(e.metadata, '{}'::jsonb) ? 'costSource')          -- provider-reported cost: leave alone
    AND NOT (COALESCE(e.metadata, '{}'::jsonb) ? 'costBackfilledAt')    -- already backfilled
)
SELECT model, COUNT(*) AS rows_to_fix,
       ROUND(SUM(old_cost)::numeric, 4) AS old_total_usd,
       ROUND(SUM(new_cost)::numeric, 4) AS new_total_usd,
       ROUND(SUM(new_cost - old_cost)::numeric, 4) AS added_usd
FROM priced
WHERE new_cost > old_cost + 0.000001
GROUP BY model
ORDER BY added_usd DESC;


-- ─── 4. Backfill (writes, in a transaction) ──────────────────────────────
-- Same selection as section 3. Each fixed row keeps its old cost in
-- metadata.previousCostUsd and is stamped metadata.costBackfilledAt, so the
-- change is auditable and section 3/4 skip it on a re-run.
BEGIN;

WITH priced AS (
  SELECT e.id, e."costUsd" AS old_cost,
    (e."promptTokens" / 1e6) * p."inputPricePer1M"
    + (e."completionTokens" / 1e6) * p."outputPricePer1M"
    + (COALESCE((e.metadata->>'cacheReadTokens')::numeric, 0) / 1e6)
        * COALESCE(p."cacheReadPricePer1M", p."inputPricePer1M" * CASE WHEN p.provider = 'anthropic' THEN 0.1 ELSE 1 END)
    + (COALESCE((e.metadata->>'cacheWrite5mTokens')::numeric, 0) / 1e6)
        * COALESCE(p."cacheWrite5mPricePer1M", p."inputPricePer1M" * CASE WHEN p.provider = 'anthropic' THEN 1.25 ELSE 1 END)
    + (COALESCE((e.metadata->>'cacheWrite1hTokens')::numeric, 0) / 1e6)
        * COALESCE(p."cacheWrite1hPricePer1M", p."inputPricePer1M" * CASE WHEN p.provider = 'anthropic' THEN 2 ELSE 1 END)
      AS new_cost
  FROM public."UsageEvent" e
  JOIN LATERAL (
    SELECT * FROM public."ModelPrice" mp
    WHERE mp.model = e.model OR mp.model = regexp_replace(e.model, '-\d{8}$', '')
    ORDER BY (mp.model = e.model) DESC
    LIMIT 1
  ) p ON true
  WHERE e.provider IN ('anthropic', 'openai', 'openrouter')
    AND NOT (COALESCE(e.metadata, '{}'::jsonb) ? 'costSource')
    AND NOT (COALESCE(e.metadata, '{}'::jsonb) ? 'costBackfilledAt')
)
UPDATE public."UsageEvent" u
SET "costUsd" = priced.new_cost,
    metadata  = (COALESCE(u.metadata, '{}'::jsonb) - 'priceLookupFailed')
                || jsonb_build_object(
                     'previousCostUsd',  priced.old_cost,
                     'costBackfilledAt', '2026-10-11'
                   )
FROM priced
WHERE u.id = priced.id
  AND priced.new_cost > priced.old_cost + 0.000001;

-- Check the row count the UPDATE reported (expected ~785), then:
COMMIT;
-- …or ROLLBACK; if anything looks wrong.


-- ─── 5. Verify (read-only) ───────────────────────────────────────────────
-- All-time total (was ~$27.86, expected ~$54):
--   SELECT ROUND(SUM("costUsd")::numeric, 2) FROM public."UsageEvent";
-- No Sonnet 4.5/4.6 call left at $0 with tokens:
--   SELECT model, COUNT(*) FROM public."UsageEvent"
--   WHERE model LIKE 'claude-sonnet-4-%' AND "costUsd" = 0
--     AND "promptTokens" + "completionTokens" > 0
--   GROUP BY 1;   → no rows
