-- Financial Extraction Cache — Schema Migration
-- Run this in Supabase SQL Editor.
--
-- Keys cached AI extraction results by SHA-256 of the document content
-- (post-OCR text) plus the extraction mode + model tier. Re-extracting the
-- same document — whether re-uploaded as a new row, retried after an error,
-- or triggered by the user clicking "re-extract" — returns the cached result
-- without re-paying the OpenAI / Azure / LlamaParse cost.
--
-- Refs: .planning/REMEDIATION_ROADMAP.md Phase 4 Task 4.9
-- Refs: .planning/codebase/CONCERNS.md §3.4

CREATE TABLE IF NOT EXISTS public."FinancialExtractionCache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "contentHash" text NOT NULL,
  "extractionMode" text NOT NULL DEFAULT 'default',
  "modelTier" text NOT NULL DEFAULT 'tier1',
  "result" jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL,
  "hitCount" integer NOT NULL DEFAULT 0,
  "lastHitAt" timestamptz
);

-- Lookup index: (contentHash, extractionMode, modelTier) is the full cache key.
-- UNIQUE so getCached/putCached can do upserts and avoid duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS "FinancialExtractionCache_lookup_idx"
  ON public."FinancialExtractionCache" ("contentHash", "extractionMode", "modelTier");

-- Expiry index: powers background cleanup of stale rows.
CREATE INDEX IF NOT EXISTS "FinancialExtractionCache_expiresAt_idx"
  ON public."FinancialExtractionCache" ("expiresAt");
