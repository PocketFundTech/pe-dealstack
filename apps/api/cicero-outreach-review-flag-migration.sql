-- Adds a "needs human review" flag to OutreachContact, set by Claude
-- reply-intent classification when it can't confidently read a reply
-- (mirrors the deck's "flagged replies" human checkpoint). Additive only,
-- idempotent -- safe to re-run.

ALTER TABLE "OutreachContact"
  ADD COLUMN IF NOT EXISTS "needsReview" BOOLEAN NOT NULL DEFAULT false;
