-- Per-org configurable Outreach pipeline behavior: the stale-contact
-- threshold and which auto-advance rules are on. One row per org, created
-- lazily with defaults on first read (see outreachSettingsService.ts) --
-- this migration only creates the table/RLS, it does not seed rows.
-- "Reset to defaults" = DELETE the row; the next read recreates it with
-- defaults, same lazy-create path as a brand-new org.
-- Additive, idempotent -- safe to re-run.

CREATE TABLE IF NOT EXISTS "OutreachSettings" (
  "organizationId" UUID PRIMARY KEY REFERENCES "Organization"(id) ON DELETE CASCADE,
  -- Contacts with no update in this many days show up in the board's
  -- "Stale" view, regardless of which stage they're in. Default matches
  -- what shipped hardcoded before this table existed.
  "staleDays" INTEGER NOT NULL DEFAULT 21,
  -- Source -> Enrich, only when an enrichment pass actually finds
  -- something (see resolveAutoAdvanceStage in outreachEnrichment.ts).
  "autoAdvanceSourceToEnrich" BOOLEAN NOT NULL DEFAULT true,
  -- Enrich -> Send, only once the contact has a real email address.
  "autoAdvanceEnrichToSend" BOOLEAN NOT NULL DEFAULT true,
  -- Send -> Handle Reply, only once a real Send has actually gone out
  -- (routes/outreach-replyio.ts's POST /contacts/:id/send).
  "autoAdvanceSendToHandleReply" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE "OutreachSettings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "OutreachSettings_service_role_only" ON "OutreachSettings";
CREATE POLICY "OutreachSettings_service_role_only" ON "OutreachSettings" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
