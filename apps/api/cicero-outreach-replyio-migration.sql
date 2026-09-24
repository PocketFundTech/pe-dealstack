-- Adds Reply.io send/reply-tracking fields to OutreachContact. Additive
-- only, idempotent -- safe to re-run. replyIntent is included now but left
-- unpopulated by any code yet -- Claude-based intent tagging is a separate
-- follow-up pending resolution of the Claude credential question.

ALTER TABLE "OutreachContact"
  ADD COLUMN IF NOT EXISTS "replyIoCampaignId" TEXT,
  ADD COLUMN IF NOT EXISTS "sentAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "lastReplyText" TEXT,
  ADD COLUMN IF NOT EXISTS "lastReplyAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "replyIntent" TEXT;
