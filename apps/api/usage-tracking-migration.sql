-- ============================================================
-- AI Usage Tracking Migration
-- Spec: docs/superpowers/specs/2026-05-05-ai-usage-tracking-design.md
--
-- Adds:
--   - UsageEvent (truth ledger of every AI call)
--   - ModelPrice (per-1M-token pricing reference, seeded)
--   - OperationCredits (operation → user-facing credits, seeded)
--   - UsageAlert (dedup table for runaway-threshold alerts)
--   - User.isInternal | isThrottled | isBlocked (access + safety flags)
--
-- Run order: this file is safe to run as a single transaction.
-- All statements use IF NOT EXISTS / ON CONFLICT and are idempotent.
-- ============================================================

BEGIN;

-- ============================================================
-- Phase 1: User table additions (access flags + safety net)
-- ============================================================

ALTER TABLE public."User"
  ADD COLUMN IF NOT EXISTS "isInternal"  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "isThrottled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "isBlocked"   boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_user_internal
  ON public."User" ("isInternal") WHERE "isInternal" = true;

CREATE INDEX IF NOT EXISTS idx_user_throttled
  ON public."User" ("isThrottled") WHERE "isThrottled" = true;

CREATE INDEX IF NOT EXISTS idx_user_blocked
  ON public."User" ("isBlocked") WHERE "isBlocked" = true;

-- ============================================================
-- Phase 2: UsageEvent (the truth ledger)
-- One row per AI call. Captures user, org, operation, tokens, cost, credits.
-- ============================================================

CREATE TABLE IF NOT EXISTS public."UsageEvent" (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"          uuid NOT NULL REFERENCES public."User"(id) ON DELETE CASCADE,
  "organizationId"  uuid NOT NULL REFERENCES public."Organization"(id) ON DELETE CASCADE,
  operation         text NOT NULL,
  model             text,
  provider          text NOT NULL,
  "promptTokens"    integer DEFAULT 0,
  "completionTokens" integer DEFAULT 0,
  "totalTokens"     integer DEFAULT 0,
  units             integer DEFAULT 0,
  "costUsd"         numeric(12,6) NOT NULL DEFAULT 0,
  credits           integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'success',
  "durationMs"      integer,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT usage_event_status_check CHECK (status IN ('success', 'error', 'rate_limited', 'blocked')),
  CONSTRAINT usage_event_provider_check CHECK (provider IN (
    'openai', 'openrouter', 'gemini', 'anthropic', 'apify', 'azure_doc_intelligence'
  ))
);

CREATE INDEX IF NOT EXISTS idx_usage_event_user_created
  ON public."UsageEvent" ("userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_usage_event_org_created
  ON public."UsageEvent" ("organizationId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_usage_event_operation
  ON public."UsageEvent" (operation, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_usage_event_status
  ON public."UsageEvent" (status) WHERE status <> 'success';

-- ============================================================
-- Phase 3: ModelPrice (per-1M-token reference, seeded)
-- ============================================================

CREATE TABLE IF NOT EXISTS public."ModelPrice" (
  model              text PRIMARY KEY,
  provider           text NOT NULL,
  "inputPricePer1M"  numeric(10,4) NOT NULL,
  "outputPricePer1M" numeric(10,4) NOT NULL,
  "updatedAt"        timestamptz NOT NULL DEFAULT now()
);

-- Seed with current prices. Verify against provider docs before production rollout.
-- All values in USD per 1,000,000 tokens.
INSERT INTO public."ModelPrice" (model, provider, "inputPricePer1M", "outputPricePer1M") VALUES
  -- OpenAI direct
  ('gpt-4o',                       'openai',     2.5000, 10.0000),
  ('gpt-4o-mini',                  'openai',     0.1500,  0.6000),
  ('gpt-4.1',                      'openai',     2.0000,  8.0000),
  ('gpt-4.1-mini',                 'openai',     0.4000,  1.6000),
  ('gpt-4-turbo',                  'openai',    10.0000, 30.0000),
  -- OpenRouter (used as default in this codebase)
  ('openai/gpt-4o',                'openrouter', 2.5000, 10.0000),
  ('openai/gpt-4o-mini',           'openrouter', 0.1500,  0.6000),
  ('openai/gpt-4.1',               'openrouter', 2.0000,  8.0000),
  ('openai/gpt-4.1-mini',          'openrouter', 0.4000,  1.6000),
  ('anthropic/claude-sonnet-4.6',  'openrouter', 3.0000, 15.0000),
  ('anthropic/claude-haiku-4.5',   'openrouter', 1.0000,  5.0000),
  ('anthropic/claude-opus-4',      'openrouter',15.0000, 75.0000),
  -- Google Gemini direct
  ('gemini-1.5-pro',               'gemini',     1.2500,  5.0000),
  ('gemini-1.5-flash',             'gemini',     0.0750,  0.3000)
ON CONFLICT (model) DO UPDATE SET
  provider           = EXCLUDED.provider,
  "inputPricePer1M"  = EXCLUDED."inputPricePer1M",
  "outputPricePer1M" = EXCLUDED."outputPricePer1M",
  "updatedAt"        = now();

-- ============================================================
-- Phase 4: OperationCredits (operation → user-facing credits, seeded)
-- ============================================================

CREATE TABLE IF NOT EXISTS public."OperationCredits" (
  operation   text PRIMARY KEY,
  credits     integer NOT NULL,
  description text
);

INSERT INTO public."OperationCredits" (operation, credits, description) VALUES
  ('deal_chat',            1,  'One chat message in the deal chat agent'),
  ('financial_extraction', 20, 'Extract financial statements from a CIM or Excel'),
  ('firm_research',        40, 'Run firm research agent (scrape + search + synthesize)'),
  ('memo_generation',      15, 'Generate a memo or memo section'),
  ('deal_import_mapping',   5, 'GPT-4o column mapping for deal import'),
  ('folder_insights',       8, 'Generate folder-level insights'),
  ('multi_doc_analysis',   10, 'Cross-document synthesis'),
  ('narrative_insights',    6, 'Narrative summary of a deal or folder'),
  ('deal_analysis',         5, 'LBO / red-flags / ratios analysis triggered by user'),
  ('meeting_prep',         10, 'Meeting prep agent'),
  ('signal_monitor',        3, 'Background signal/news monitor'),
  ('web_search',            1, 'One Apify Google search call'),
  ('pdf_ocr',               2, 'One page of Azure Document Intelligence extraction')
ON CONFLICT (operation) DO UPDATE SET
  credits     = EXCLUDED.credits,
  description = EXCLUDED.description;

-- ============================================================
-- Phase 5: UsageAlert (dedup so we only alert once per user/day/kind)
-- ============================================================

CREATE TABLE IF NOT EXISTS public."UsageAlert" (
  "userId"    uuid NOT NULL REFERENCES public."User"(id) ON DELETE CASCADE,
  "alertDate" date NOT NULL,
  kind        text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY ("userId", "alertDate", kind),
  CONSTRAINT usage_alert_kind_check CHECK (kind IN ('cost', 'tokens'))
);

-- ============================================================
-- Phase 6: Bootstrap internal admin flag for Pocket Fund team
-- Adjust the email list before running, or run a follow-up UPDATE
-- after migration if you'd rather not edit this file.
-- ============================================================

UPDATE public."User"
SET "isInternal" = true
WHERE email IN (
  'dev@pocket-fund.com',
  'ganeshjagtap006@gmail.com',
  'hello@pocket-fund.com'
);

COMMIT;

-- ============================================================
-- Verification queries (run these after migration to confirm)
-- ============================================================
-- SELECT COUNT(*) FROM public."ModelPrice";        -- Expect ≥ 14
-- SELECT COUNT(*) FROM public."OperationCredits";  -- Expect ≥ 13
-- SELECT email, "isInternal" FROM public."User" WHERE "isInternal" = true;
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'User' AND column_name IN ('isInternal','isThrottled','isBlocked');
