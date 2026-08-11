-- apps/api/document-fingerprint-migration.sql
--
-- Adds a SHA-256 fingerprint column to Document rows. Fingerprint is computed
-- at upload time from the original file bytes, so any tampering downstream
-- (replaced storage object, modified file) is detectable.
--
-- Idempotent. Safe to re-run.
--
-- To apply (Supabase SQL Editor or psql):
--   ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "fileSha256" TEXT NULL;

ALTER TABLE "Document"
  ADD COLUMN IF NOT EXISTS "fileSha256" TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_document_filesha256
  ON "Document" ("fileSha256")
  WHERE "fileSha256" IS NOT NULL;
