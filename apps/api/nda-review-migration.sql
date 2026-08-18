-- ============================================================
-- NDA Review Migration — NdaReview
--
-- Reviews of INCOMING counterparty NDAs against the firm's playbook.
-- The playbook itself needs no migration: it lives in
-- Organization.settings.ndaPlaybook, the same JSON-settings pattern as
-- settings.dealCriteria.
--
-- sourceHtml is stored deliberately — it is the grounding corpus every
-- quoted finding was verified against, so a review stays auditable even
-- if the original upload is later deleted.
--
-- To apply: psql "$SUPABASE_DB_URL" -f apps/api/nda-review-migration.sql
-- Or run via the Supabase SQL editor. (Vercel does NOT run this.)
-- ============================================================

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

ALTER TABLE "NdaReview" ENABLE ROW LEVEL SECURITY;
