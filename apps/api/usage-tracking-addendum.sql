-- ============================================================
-- AI Usage Tracking — Operation Credits Addendum
-- Run AFTER usage-tracking-migration.sql, anytime before/after deploy.
-- Idempotent (ON CONFLICT DO UPDATE).
--
-- Adds three operation labels that were introduced when wrapping
-- LangChain agents and the LinkedIn scraper. The wrapper falls back to
-- 1-credit-per-call + warn log for unseeded operations, so this addendum
-- is informational/cosmetic — it primarily tunes the credit values that
-- show up in the user-facing "AI Usage" panel.
-- ============================================================

INSERT INTO public."OperationCredits" (operation, credits, description) VALUES
  -- Canonical domain operations
  ('email_drafting',          5,  'Generate or refine an outbound email draft'),
  ('contact_enrichment',      8,  'Enrich a contact record with public data'),
  ('linkedin_scrape',         5,  'Scrape one LinkedIn profile via Apify'),

  -- Granular labels passed by main's invokeStructured callsites. Each maps
  -- to the same credit value as its parent domain so user-facing totals
  -- stay sensible regardless of which sub-step ran. Admin Live Feed still
  -- shows the granular label for debugging.
  ('emailDrafter.draft',      5,  'Email draft (subagent step)'),
  ('emailDrafter.tone',       2,  'Email tone refinement (subagent step)'),
  ('emailDrafter.compliance', 2,  'Email compliance check (subagent step)'),
  ('meetingPrep.brief',      10,  'Meeting prep brief generation'),
  ('signalMonitor.analyze',   3,  'Signal monitor analysis (background)'),
  ('contactEnrichment.research', 8, 'Contact enrichment research (subagent step)'),
  ('synthesize.firm',        20,  'Firm research synthesis (Phase 1)'),
  ('synthesize.person',      20,  'Person research synthesis (Phase 1)'),
  ('deepResearch.queries',   10,  'Deep research query generation (Phase 2)'),
  ('deepResearch.firm',      20,  'Deep research firm synthesis (Phase 2)'),
  ('deepResearch.person',    20,  'Deep research person synthesis (Phase 2)'),

  -- Gemini embeddings (RAG). High-volume, low-cost; default to small credit.
  ('gemini_embed_doc',        2,  'Gemini embedding of a document''s chunks (ingest)'),
  ('gemini_embed_query',      1,  'Gemini embedding of a single RAG query'),

  -- Quantitative reconciler Phase 2 LLM calls (all MODEL_INSIGHTS / Tier 2).
  -- Sized vs multi_doc_analysis (10) and narrative_insights (6) by max_tokens
  -- and synthesis complexity.
  ('cim_claim_extraction',          10, 'Reconciler: extract verifiable claims from CIM/teaser narrative'),
  ('reconciler_material_findings',  10, 'Reconciler: synthesize material diligence findings'),
  ('reconciler_extraction_feedback', 6, 'Reconciler: audit prior extraction quality vs ground truth'),
  ('reconciler_recommended_actions', 6, 'Reconciler: produce prioritized buyer diligence to-do list')
ON CONFLICT (operation) DO UPDATE SET
  credits     = EXCLUDED.credits,
  description = EXCLUDED.description;

-- claude-haiku-4-5-20251001 used by crossVerifyNode for multi-model ensemble verification.
-- Pricing: $1.00 per 1M input tokens, $5.00 per 1M output tokens.
INSERT INTO public."ModelPrice" (model, provider, "inputPricePer1M", "outputPricePer1M") VALUES
  ('claude-haiku-4-5-20251001', 'anthropic', 1.0000, 5.0000)
ON CONFLICT (model) DO UPDATE SET
  provider           = EXCLUDED.provider,
  "inputPricePer1M"  = EXCLUDED."inputPricePer1M",
  "outputPricePer1M" = EXCLUDED."outputPricePer1M",
  "updatedAt"        = now();

-- Verify:
-- SELECT operation, credits FROM public."OperationCredits" ORDER BY credits DESC;
-- SELECT model, provider, "inputPricePer1M", "outputPricePer1M" FROM public."ModelPrice" WHERE provider = 'anthropic';
