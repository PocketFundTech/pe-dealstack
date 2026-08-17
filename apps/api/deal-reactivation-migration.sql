-- ============================================================
-- Deal Reactivation Migration — passed-deal revival
--
-- Turns PASSED from a dead end into a dormant state that can wake up:
-- a pass reason, a revisit date, a history of scorecards, and a record
-- of each time a deal became interesting again.
--
-- Depends on scorecard-migration.sql (Deal.scorecard).
--
-- To apply: psql "$SUPABASE_DB_URL" -f apps/api/deal-reactivation-migration.sql
-- Or run via the Supabase SQL editor. (Vercel does NOT run this.)
-- ============================================================

ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "passReason"       text;
ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "passedAt"         timestamptz;
ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "revisitAt"        date;
ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "lastRescoredAt"   timestamptz;
-- Rolling log of superseded scorecards: {score, verdict, scoredAt, model, trigger}
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

ALTER TABLE "DealReactivation" ENABLE ROW LEVEL SECURITY;
