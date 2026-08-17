-- ============================================================
-- HubSpot Engagement Deal-Fallback Migration
-- Column: hubspotId on Activity
-- ============================================================
-- Notes/calls/meetings/emails/tasks imported from HubSpot with no
-- resolvable Contact association now fall back to the associated Deal's
-- activity feed instead of being dropped. This adds the dedup column
-- Activity needs to support that, mirroring the ContactInteraction
-- pattern in hubspot-engagement-import-migration.sql.

ALTER TABLE public."Activity" ADD COLUMN IF NOT EXISTS "hubspotId" text;

-- Compound, not a plain hubspotId unique index: one HubSpot engagement can
-- be associated with several deals, producing one Activity row per deal.
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_hubspot
  ON public."Activity" ("dealId", "hubspotId") WHERE "hubspotId" IS NOT NULL;
