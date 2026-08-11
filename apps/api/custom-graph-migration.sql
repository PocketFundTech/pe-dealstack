-- ============================================================
-- CustomGraph table — per-deal user-defined charts
-- Phase 2 of the /graphs feature (was localStorage-only in Phase 1).
-- Run this in your Supabase SQL Editor to create the table.
-- ============================================================
--
-- A CustomGraph is a saved chart definition that belongs to a deal
-- (one deal -> many graphs). The series jsonb encodes which metrics
-- to plot and how (bar/line/area + color); the rendering layer reads
-- those metrics off the per-deal FinancialStatement timeseries.
--
-- Org-scoping mirrors MemoTemplate: every row carries the
-- organizationId so the API layer can enforce isolation via plain
-- equality predicates without joining through Deal on every read.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "CustomGraph" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL,
  "dealId" TEXT NOT NULL,
  "createdById" TEXT,
  "title" TEXT NOT NULL,
  "chartType" TEXT NOT NULL CHECK ("chartType" IN ('bar', 'line', 'area', 'combo')),
  "series" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot-path indexes: list-by-org (cross-deal page) and list-by-deal
-- (per-deal page) are both common.
CREATE INDEX IF NOT EXISTS "CustomGraph_organizationId_idx"
  ON "CustomGraph"("organizationId");
CREATE INDEX IF NOT EXISTS "CustomGraph_dealId_idx"
  ON "CustomGraph"("dealId");

-- updatedAt trigger — mirrors the convention used by Memo / MemoSection
-- (see memo-schema.sql). Reuses the shared update_updated_at_column()
-- function defined there; safe to create-or-replace it here in case
-- this migration runs first on a fresh database.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$ LANGUAGE 'plpgsql';

DROP TRIGGER IF EXISTS update_customgraph_updated_at ON "CustomGraph";
CREATE TRIGGER update_customgraph_updated_at
  BEFORE UPDATE ON "CustomGraph"
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
