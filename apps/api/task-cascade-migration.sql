-- Add ON DELETE CASCADE to the Task.dealId FK so deleting a Deal
-- automatically removes its tasks.
--
-- Background: every other table that references Deal(id) was created with
-- ON DELETE CASCADE in its FK definition (see chat-history-migration.sql,
-- agent-memory-migration.sql, contacts-migration.sql, financial-statement-
-- migration.sql, memo-schema.sql, vdr-schema.sql, supabase-schema.sql).
-- The Task table was created later via Supabase Studio without that
-- modifier, so its FK ('Task_dealId_fkey') blocks Deal deletion with
-- Postgres error 23503 ("update or delete on table Deal violates foreign
-- key constraint Task_dealId_fkey on table Task").
--
-- The deal-delete route (apps/api/src/routes/deals-mutate.ts) has a
-- defensive manual `DELETE FROM Task WHERE dealId = X` step that works
-- around this without the migration. Running this migration makes that
-- step redundant — leave it in place anyway as belt-and-suspenders.
--
-- Idempotent — safe to re-run.

ALTER TABLE "Task"
  DROP CONSTRAINT IF EXISTS "Task_dealId_fkey";

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_dealId_fkey"
  FOREIGN KEY ("dealId")
  REFERENCES "Deal"(id)
  ON DELETE CASCADE;
