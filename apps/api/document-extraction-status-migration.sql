-- Per-document financial extraction status (QA #12, "3 of 6 done")
-- Run in the Supabase SQL Editor. Idempotent — safe to re-run.
--
-- "Extract all" writes each document's status here as it goes
-- (queued → running → done / failed / pending) so the page can show live
-- progress, whichever serverless instance answers the poll. The code works
-- before this runs: the page just shows elapsed time, as before.

ALTER TABLE public."Document" ADD COLUMN IF NOT EXISTS "financialExtraction" jsonb;

NOTIFY pgrst, 'reload schema';

-- Verify:
-- select column_name from information_schema.columns where table_name = 'Document' and column_name = 'financialExtraction';  -- 1 row
