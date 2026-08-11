-- Gmail → Auto Deal Creation & Update (Phases A+B+C minimum scaffolding)
--
-- Adds:
--   1. Deal provenance columns so an AI-created deal is recognisable later
--   2. IntegrationActivity.dealRelevance (classifier output) for observability
--   3. DealUpdateProposal table for sensitive-field updates that need human approval
--
-- All statements are idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS),
-- so this file is safe to re-run.

-- ─── 1. Deal provenance ────────────────────────────────────────────────────
ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "sourceConfidence" INT;
ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "sourceMessageId" TEXT;
ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "sourceThreadIds" TEXT[] NOT NULL DEFAULT '{}';

-- Idempotency for the Gmail sync path: same Gmail message → same Deal, never duplicate.
-- Partial unique index so only rows with sourceMessageId set are constrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_sourceMessageId_unique
  ON public."Deal"("organizationId", "sourceMessageId")
  WHERE "sourceMessageId" IS NOT NULL;

-- Fast lookup when a new email arrives on a known thread → existing Deal.
CREATE INDEX IF NOT EXISTS idx_deal_sourceThreadIds
  ON public."Deal" USING GIN ("sourceThreadIds");

-- ─── 2. Classifier output on IntegrationActivity ───────────────────────────
-- Stores { isRelevant, confidence, dealType, reasoning, hints } for each
-- AI-classified email. Used for the future review queue UI and for tuning.
ALTER TABLE public."IntegrationActivity"
  ADD COLUMN IF NOT EXISTS "dealRelevance" JSONB;

-- ─── 3. DealUpdateProposal ─────────────────────────────────────────────────
-- Sensitive-field updates (dealSize / stage / revenue / ebitda / ownerId)
-- never auto-apply. They land here for human review.
CREATE TABLE IF NOT EXISTS public."DealUpdateProposal" (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId"          UUID NOT NULL REFERENCES public."Deal"(id) ON DELETE CASCADE,
  "organizationId"  UUID NOT NULL REFERENCES public."Organization"(id) ON DELETE CASCADE,
  field             TEXT NOT NULL,
  "oldValue"        JSONB,
  "newValue"        JSONB,
  confidence        DOUBLE PRECISION NOT NULL,
  "sourceQuote"     TEXT,
  "sourceActivityId" UUID REFERENCES public."IntegrationActivity"(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','accepted','rejected','superseded')),
  "decidedByUserId" UUID REFERENCES public."User"(id) ON DELETE SET NULL,
  "decidedAt"       TIMESTAMPTZ,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deal_update_proposal_org_status
  ON public."DealUpdateProposal"("organizationId", status, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_deal_update_proposal_deal
  ON public."DealUpdateProposal"("dealId", status, "createdAt" DESC);

-- RLS — same pattern as IntegrationActivity (see rls-gap-migration.sql).
-- Authentication-only at the DB layer; org-scoping enforced by the
-- middleware (orgScope.ts) on the API routes. Service-role bypasses RLS.
ALTER TABLE public."DealUpdateProposal" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_deal_update_proposal_all" ON public."DealUpdateProposal";
CREATE POLICY "auth_deal_update_proposal_all" ON public."DealUpdateProposal"
  FOR ALL USING (auth.uid() IS NOT NULL);
