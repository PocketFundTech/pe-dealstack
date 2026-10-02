-- Invitation → deal (QA #4, bulk invite preview)
-- Run in the Supabase SQL Editor. Idempotent — safe to re-run.
--
-- Lets an invitation carry the deal the invitee should be added to; on
-- accept they join that deal's team. The code works before this runs: the
-- invitation is still sent, just without the deal (the result says so).

ALTER TABLE public."Invitation"
  ADD COLUMN IF NOT EXISTS "dealId" uuid REFERENCES public."Deal"(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';

-- Verify:
-- select column_name from information_schema.columns where table_name = 'Invitation' and column_name = 'dealId';  -- 1 row
