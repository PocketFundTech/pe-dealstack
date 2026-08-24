-- Fixes the "one row, one stage" data-model problem flagged in the Cicero
-- origination-machine doc: a contact can be quiet on email AND active on
-- LinkedIn at once, and a single mutable stage field can't hold both
-- truths without drifting. OutreachTouch is an append-only event log --
-- one row per action, per channel, timestamped -- kept ALONGSIDE the
-- existing OutreachContact.stageId (not replacing it: the actual stage
-- list still needs the human workshop the source deck calls for, so
-- automatic stage-derivation from touches is deliberately not attempted
-- here). Every automated action (Send, reply sync/webhook, Enrich,
-- Clay-sourced import) should now also write a Touch, so a full history
-- exists from day one instead of only the latest snapshot.
--
-- Also adds sourcing/import fields to OutreachContact for the Clay inbound
-- bulk-import path (Clay has no query API to call outward -- a human
-- filters in Clay's own UI, Clay pushes results to us via a webhook, we
-- de-dupe and import). Ambiguous matches get flagged for a human, never
-- silently merged, per the doc's explicit guidance.
--
-- Additive only, idempotent -- safe to re-run.

CREATE TABLE IF NOT EXISTS "OutreachTouch" (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "organizationId" UUID NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE,
  "contactId" UUID NOT NULL REFERENCES "OutreachContact"(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  type TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
  "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_touch_contact ON "OutreachTouch" ("contactId");
CREATE INDEX IF NOT EXISTS idx_outreach_touch_org ON "OutreachTouch" ("organizationId");
CREATE INDEX IF NOT EXISTS idx_outreach_touch_occurred ON "OutreachTouch" ("occurredAt" DESC);

ALTER TABLE "OutreachTouch" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "OutreachTouch_service_role_only" ON "OutreachTouch";
CREATE POLICY "OutreachTouch_service_role_only" ON "OutreachTouch" FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE "OutreachContact"
  ADD COLUMN IF NOT EXISTS "sourceProvider" TEXT,
  ADD COLUMN IF NOT EXISTS "needsMatchReview" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "matchReviewReason" TEXT,
  -- Corporate Identification Number -- the Indian company registration
  -- number. Optional (Clay's payload may or may not carry it), but when
  -- present it's a far more reliable de-dupe key than a company name match
  -- (routes/outreach-clay-import-webhook.ts checks it first, before email,
  -- before name). Stored uppercased/whitespace-stripped by the import path
  -- that writes it, not enforced here.
  ADD COLUMN IF NOT EXISTS cin TEXT;

CREATE INDEX IF NOT EXISTS idx_outreach_contact_cin ON "OutreachContact" (cin) WHERE cin IS NOT NULL;
