-- apps/api/soft-delete-recovery-migration.sql
--
-- Adds the deletedAt column to Deal so deletes become soft-deletes within a
-- 30-day restore window. The /api/deals list query filters on deletedAt
-- IS NULL; /api/deals/trash returns the soft-deleted ones; /api/deals/:id/
-- restore brings them back.
--
-- Idempotent. Safe to re-run.

ALTER TABLE "Deal"
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ NULL;

-- Partial index for the trash list query (only over the few soft-deleted rows)
CREATE INDEX IF NOT EXISTS idx_deal_deleted_at
  ON "Deal" ("deletedAt")
  WHERE "deletedAt" IS NOT NULL;
