-- Contact Follow-Up Date — adds a per-contact follow-up reminder timestamp.
-- Run this in Supabase SQL Editor. Idempotent.
--
-- Adds:
--   "followUpAt"   — when the next follow-up with this contact is due (nullable)
--   "followUpNote" — optional one-line reminder of what the follow-up is about
-- Plus a partial index to make "due / upcoming follow-up" queries fast.

ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "followUpAt" TIMESTAMPTZ;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "followUpNote" TEXT;

-- Index for due-follow-up lookups (only rows that actually have a follow-up set).
CREATE INDEX IF NOT EXISTS idx_contact_follow_up_at
  ON "Contact" ("followUpAt")
  WHERE "followUpAt" IS NOT NULL;
