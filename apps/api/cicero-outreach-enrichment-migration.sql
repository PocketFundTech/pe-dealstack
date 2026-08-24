-- Adds enrichment fields to OutreachContact for the Clay/Apollo/Anymail
-- "Enrich" action. Additive only, idempotent -- safe to re-run.

ALTER TABLE "OutreachContact"
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS "linkedinUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "enrichedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "enrichmentSource" TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "enrichmentData" JSONB;

-- enrichmentData holds the raw response(s) keyed by provider, e.g.
-- {"apollo": {...}, "clay": {...}, "anymailFinder": {...}} -- kept so
-- fields we didn't think to promote to a column aren't thrown away, and so
-- future providers don't need another migration.
