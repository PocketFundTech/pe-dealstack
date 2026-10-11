-- HubSpot import: files attached to deals (2026-10-11, feat/hubspot-relationships-files).
-- Idempotent. The app works before this runs: the files step reports
-- "database migration pending" and every other part of the import is unaffected.

CREATE TABLE IF NOT EXISTS public."HubSpotFileQueue" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "jobId" uuid NOT NULL REFERENCES public."ImportJob"(id) ON DELETE CASCADE,
  "organizationId" uuid NOT NULL,
  "dealId" uuid NOT NULL REFERENCES public."Deal"(id) ON DELETE CASCADE,
  "hubspotFileId" text NOT NULL,
  "sourceEngagementId" text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped','failed')),
  reason text,
  "documentId" uuid,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("jobId", "dealId", "hubspotFileId")
);
CREATE INDEX IF NOT EXISTS idx_hubspotfilequeue_job_status ON public."HubSpotFileQueue" ("jobId", status);

-- Server-only table (service role bypasses RLS). Deny-all so the public anon
-- key can't read it — see docs/CODEBASE-AUDIT-2026-10-11.md S5.
ALTER TABLE public."HubSpotFileQueue" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."Document" ADD COLUMN IF NOT EXISTS "hubspotFileId" text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_deal_hubspotfile
  ON public."Document" ("dealId", "hubspotFileId") WHERE "hubspotFileId" IS NOT NULL;
