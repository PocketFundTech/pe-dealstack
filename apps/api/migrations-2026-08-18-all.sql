-- ================================================================
-- PE OS — combined migration, 2026-08-18
--
-- Runs all three feature migrations in dependency order:
--   1. Document Requests   (doc-request-migration.sql)
--   2. Deal Reactivation   (deal-reactivation-migration.sql)
--   3. NDA Review          (nda-review-migration.sql)
--
-- Safe to run more than once — every statement is IF NOT EXISTS.
-- Wrapped in a transaction: if any statement fails, nothing is applied.
--
-- Apply either way:
--   psql "$SUPABASE_DB_URL" -f apps/api/migrations-2026-08-18-all.sql
--   ...or paste the whole file into the Supabase SQL editor and Run.
--
-- Vercel does NOT run this. It has to be done by hand.
--
-- NOT INCLUDED YET: apps/api/deal-model-migration.sql (Excel model export,
-- feature 4) — that feature is still being built.
-- ================================================================

BEGIN;

-- ================================================================
-- 0. Dependency backstop
-- ================================================================
-- Deal.scorecard should already exist (scorecard-migration.sql, run
-- 2026-08-11). The reactivation engine reads it, so we assert it here
-- rather than discovering it missing at runtime. No-op if present.
ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "scorecard" jsonb;


-- ================================================================
-- 1. DOCUMENT REQUESTS — DocRequest + DocRequestItem + DocRequestEvent
-- ================================================================
-- A structured document ask sent to a broker/seller, fulfilled through a
-- tokenized public upload page. Mirrors the DealShare/DealShareView shape
-- — same token model, same revoke/expiry semantics, same RLS backstop.

CREATE TABLE IF NOT EXISTS "DocRequest" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId"         uuid NOT NULL REFERENCES "Deal"(id) ON DELETE CASCADE,
  "organizationId" uuid NOT NULL,
  token            text NOT NULL UNIQUE,        -- 32-byte crypto-random hex
  "recipientEmail" text,
  "recipientName"  text,
  message          text,                        -- optional note shown on the page
  status           text NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN','PARTIAL','FULFILLED','CANCELLED')),
  "createdBy"      text,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "expiresAt"      timestamptz,                 -- null = no expiry
  "revokedAt"      timestamptz,
  "lastRemindedAt" timestamptz,
  "reminderCount"  integer NOT NULL DEFAULT 0,  -- capped in services/docRequests.ts
  "completedAt"    timestamptz
);
CREATE INDEX IF NOT EXISTS "DocRequest_dealId_idx"     ON "DocRequest"("dealId");
CREATE INDEX IF NOT EXISTS "DocRequest_org_status_idx" ON "DocRequest"("organizationId", status);

CREATE TABLE IF NOT EXISTS "DocRequestItem" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "requestId"   uuid NOT NULL REFERENCES "DocRequest"(id) ON DELETE CASCADE,
  label         text NOT NULL,                  -- "3-year P&L"
  "docType"     text,                           -- maps to Document.type where known
  notes         text,
  required      boolean NOT NULL DEFAULT true,
  "sortOrder"   integer NOT NULL DEFAULT 0,
  "documentId"  uuid REFERENCES "Document"(id) ON DELETE SET NULL,
  "fulfilledAt" timestamptz
);
CREATE INDEX IF NOT EXISTS "DocRequestItem_requestId_idx" ON "DocRequestItem"("requestId");

-- View/upload log for the public page (mirrors DealShareView).
CREATE TABLE IF NOT EXISTS "DocRequestEvent" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "requestId" uuid NOT NULL REFERENCES "DocRequest"(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('VIEWED','UPLOADED','COMPLETED')),
  "itemId"    uuid REFERENCES "DocRequestItem"(id) ON DELETE SET NULL,
  "userAgent" text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "DocRequestEvent_requestId_idx" ON "DocRequestEvent"("requestId");


-- ================================================================
-- 2. DEAL REACTIVATION — dormant-deal columns + DealReactivation
-- ================================================================
-- Turns PASSED from a dead end into a dormant state that can wake up:
-- a pass reason, a revisit date, a history of scorecards, and a record
-- of each time a deal became interesting again.

ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "passReason"     text;
ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "passedAt"       timestamptz;
ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "revisitAt"      date;
ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "lastRescoredAt" timestamptz;
-- Rolling log of superseded scorecards: {score, verdict, scoredAt, trigger}
ALTER TABLE public."Deal"
  ADD COLUMN IF NOT EXISTS "scorecardHistory" jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS "DealReactivation" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId"          uuid NOT NULL REFERENCES "Deal"(id) ON DELETE CASCADE,
  "organizationId"  uuid NOT NULL,
  trigger           text NOT NULL
                      CHECK (trigger IN ('FINANCIALS_UPDATED','CRITERIA_CHANGED','REVISIT_DUE','MANUAL')),
  "previousScore"   integer,
  "newScore"        integer,
  "previousVerdict" text,
  "newVerdict"      text,
  -- { resolvedMisses: [...], gainedHits: [...], newFlags: [...] }
  delta             jsonb,
  status            text NOT NULL DEFAULT 'NEW'
                      CHECK (status IN ('NEW','SEEN','ACTED','DISMISSED')),
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  "seenAt"          timestamptz
);
CREATE INDEX IF NOT EXISTS "DealReactivation_org_status_idx"
  ON "DealReactivation"("organizationId", status);
CREATE INDEX IF NOT EXISTS "DealReactivation_dealId_idx"
  ON "DealReactivation"("dealId");

-- Partial index: the nightly sweep only ever asks "which passed deals in
-- this org are due a look?", so keep the index to exactly those rows.
CREATE INDEX IF NOT EXISTS "Deal_revisit_idx"
  ON "Deal"("organizationId", "revisitAt")
  WHERE stage = 'PASSED';


-- ================================================================
-- 3. NDA REVIEW — NdaReview
-- ================================================================
-- Reviews of INCOMING counterparty NDAs against the firm's playbook.
-- The playbook itself needs no migration — it lives in
-- Organization.settings.ndaPlaybook, same JSON-settings pattern as
-- settings.dealCriteria.
--
-- sourceHtml is stored deliberately: it is the grounding corpus every
-- quoted finding was verified against, so a review stays auditable even
-- if the original upload is later deleted.

CREATE TABLE IF NOT EXISTS "NdaReview" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: a firm may review an NDA before a deal record exists.
  "dealId"           uuid REFERENCES "Deal"(id) ON DELETE CASCADE,
  "organizationId"   uuid NOT NULL,
  "documentId"       uuid REFERENCES "Document"(id) ON DELETE SET NULL,
  "sourceFileName"   text,
  "sourceHtml"       text NOT NULL,
  -- Array of findings; each carries quoteVerified from the grounding gate.
  findings           jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary            text,
  "riskLevel"        text CHECK ("riskLevel" IN ('LOW','MEDIUM','HIGH')),
  -- Playbook as it stood at review time, so an old review still explains
  -- itself after the firm edits its positions.
  "playbookSnapshot" jsonb,
  model              text,
  "reviewedAt"       timestamptz NOT NULL DEFAULT now(),
  "createdBy"        text
);
CREATE INDEX IF NOT EXISTS "NdaReview_dealId_idx" ON "NdaReview"("dealId");
CREATE INDEX IF NOT EXISTS "NdaReview_org_idx"    ON "NdaReview"("organizationId", "reviewedAt" DESC);


-- ================================================================
-- 4. RLS BACKSTOP — do not skip
-- ================================================================
-- Option C from rls-hardening-migration.sql: enable RLS with NO policies,
-- so the browser anon key gets zero rows through PostgREST. DocRequest
-- holds upload TOKENS and NdaReview holds whole contracts — neither may
-- ever be readable client-side. The Express API uses the service role,
-- which bypasses RLS entirely.

ALTER TABLE "DocRequest"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocRequestItem"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocRequestEvent"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealReactivation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NdaReview"        ENABLE ROW LEVEL SECURITY;

COMMIT;


-- ================================================================
-- VERIFICATION — run these after, all three must look right
-- ================================================================

-- (a) Expect exactly 5 rows.
-- select table_name from information_schema.tables
--  where table_schema = 'public'
--    and table_name in ('DocRequest','DocRequestItem','DocRequestEvent',
--                       'DealReactivation','NdaReview')
--  order by table_name;

-- (b) Expect exactly 5 rows (the dormant-deal columns on Deal).
-- select column_name, data_type from information_schema.columns
--  where table_schema = 'public' and table_name = 'Deal'
--    and column_name in ('passReason','passedAt','revisitAt',
--                        'lastRescoredAt','scorecardHistory')
--  order by column_name;

-- (c) relrowsecurity MUST be true on every row — these tables hold
--     upload tokens and full contract text.
-- select relname, relrowsecurity from pg_class
--  where relname in ('DocRequest','DocRequestItem','DocRequestEvent',
--                    'DealReactivation','NdaReview')
--  order by relname;
