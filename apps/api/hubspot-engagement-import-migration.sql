-- ============================================================
-- HubSpot Engagement Import Migration (Phase 2)
-- Column: hubspotId on ContactInteraction
-- ============================================================

ALTER TABLE public."ContactInteraction" ADD COLUMN IF NOT EXISTS "hubspotId" text;

-- Compound, not a plain hubspotId unique index: one HubSpot engagement can
-- produce multiple ContactInteraction rows (one per associated local contact),
-- and ContactInteraction has no organizationId column of its own — it's
-- scoped transitively via contactId.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contactinteraction_hubspot
  ON public."ContactInteraction" ("contactId", "hubspotId") WHERE "hubspotId" IS NOT NULL;
