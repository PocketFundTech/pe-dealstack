-- Outreach pipeline board: Phase 1 "Foundation" schema from Cicero Capital's
-- workflow deck (org-scoped, not Cicero-specific in schema -- gating to their
-- org happens at the Express/frontend layer, same as every other feature).
-- Manual/human-operated board for now; automation (Reply.io/Clay/Apollo/etc)
-- plugs into OutreachContact.stageId later once those integrations exist.
-- Idempotent -- safe to re-run.

CREATE TABLE IF NOT EXISTS "OutreachStage" (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "organizationId" UUID NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE ("organizationId", position)
);

CREATE TABLE IF NOT EXISTS "OutreachContact" (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "organizationId" UUID NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE,
  "stageId" UUID NOT NULL REFERENCES "OutreachStage"(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT,
  channel TEXT NOT NULL DEFAULT 'proprietary' CHECK (channel IN ('proprietary', 'broker')),
  notes TEXT,
  "assignedTo" UUID REFERENCES "User"(id),
  "createdBy" UUID REFERENCES "User"(id),
  "createdAt" TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  "updatedAt" TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outreach_stage_org ON "OutreachStage" ("organizationId");
CREATE INDEX IF NOT EXISTS idx_outreach_contact_org ON "OutreachContact" ("organizationId");
CREATE INDEX IF NOT EXISTS idx_outreach_contact_stage ON "OutreachContact" ("stageId");

-- RLS: deny-all for anon/authenticated, matching this project's trust model
-- (Express + service role key is the authorization boundary; RLS here is
-- defense-in-depth only -- see rls-hardening-migration.sql).
ALTER TABLE "OutreachStage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutreachContact" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "OutreachStage_service_role_only" ON "OutreachStage";
CREATE POLICY "OutreachStage_service_role_only" ON "OutreachStage" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "OutreachContact_service_role_only" ON "OutreachContact";
CREATE POLICY "OutreachContact_service_role_only" ON "OutreachContact" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- Seed Cicero Capital's default stage list with the 6 stages from their deck
-- (Source -> Enrich -> Send -> Handle Reply -> Escalate -> Meeting Booked).
-- PROVISIONAL: their "stage-list workshop with leadership" may change these
-- names/order -- stages are just data, editable later without a migration.
INSERT INTO "OutreachStage" ("organizationId", name, position)
SELECT o.id, s.name, s.position
FROM "Organization" o
CROSS JOIN (VALUES
  ('Source', 1),
  ('Enrich', 2),
  ('Send', 3),
  ('Handle Reply', 4),
  ('Escalate', 5),
  ('Meeting Booked', 6)
) AS s(name, position)
WHERE o.slug = 'cicero-capital'
  AND NOT EXISTS (
    SELECT 1 FROM "OutreachStage" existing WHERE existing."organizationId" = o.id
  );

-- Verify:
-- SELECT name, position FROM "OutreachStage" os JOIN "Organization" o ON o.id = os."organizationId" WHERE o.slug = 'cicero-capital' ORDER BY position;
