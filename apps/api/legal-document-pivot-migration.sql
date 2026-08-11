-- ============================================================
-- Phase 2 pivot: NDAs are in-app HTML, not Google Docs.
--
-- The Phase 1 schema in legal-document-migration.sql wired
-- LegalDocument + LegalDocTemplate to a Google Doc per row.
-- We're abandoning Drive entirely:
--   * Templates carry their own HTML body (uploaded as .docx / .html / .md)
--   * NDAs carry their own HTML body (substituted from a template)
--   * Outbound delivery is a Resend email with an .docx attachment
--
-- Run AFTER legal-document-migration.sql. Idempotent — safe to re-run.
-- Schema-additive: existing Google Doc IDs on already-created rows are
-- preserved (we just drop NOT NULL); we never drop a data-bearing
-- column on the document tables.
-- ============================================================

-- ---- LegalDocument ----
-- Drive columns become optional so the new in-app flow can omit them.
ALTER TABLE "LegalDocument" ALTER COLUMN "googleDocId"  DROP NOT NULL;
ALTER TABLE "LegalDocument" ALTER COLUMN "googleDocUrl" DROP NOT NULL;

-- HTML body lives on the row. contentSnapshot captures the exact HTML
-- that was rendered into the outbound .docx so we always have an audit
-- trail of what we sent, even if the user keeps editing `content` after.
ALTER TABLE "LegalDocument" ADD COLUMN IF NOT EXISTS "content"             TEXT;
ALTER TABLE "LegalDocument" ADD COLUMN IF NOT EXISTS "contentSnapshot"     TEXT;
ALTER TABLE "LegalDocument" ADD COLUMN IF NOT EXISTS "sentAt"              TIMESTAMPTZ;
ALTER TABLE "LegalDocument" ADD COLUMN IF NOT EXISTS "sentToEmail"         TEXT;
ALTER TABLE "LegalDocument" ADD COLUMN IF NOT EXISTS "counterpartyAddress" TEXT;
ALTER TABLE "LegalDocument" ADD COLUMN IF NOT EXISTS "jurisdiction"        TEXT;

-- ---- LegalDocTemplate ----
-- Same DROP NOT NULL on googleDocId so admin-uploaded templates need no
-- Drive presence at all. Add: parsed HTML body, original filename for
-- display, upload + verify timestamps, and the placeholder list the
-- admin manually marked up after upload.
ALTER TABLE "LegalDocTemplate" ALTER COLUMN "googleDocId" DROP NOT NULL;
ALTER TABLE "LegalDocTemplate" ADD COLUMN IF NOT EXISTS "bodyHtml"         TEXT;
ALTER TABLE "LegalDocTemplate" ADD COLUMN IF NOT EXISTS "originalFileName" TEXT;
ALTER TABLE "LegalDocTemplate" ADD COLUMN IF NOT EXISTS "uploadedAt"       TIMESTAMPTZ;
ALTER TABLE "LegalDocTemplate" ADD COLUMN IF NOT EXISTS "verifiedAt"       TIMESTAMPTZ;
ALTER TABLE "LegalDocTemplate"
  ADD COLUMN IF NOT EXISTS "placeholderKeys" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ---- Organization ----
-- Drive folder columns were Phase 1 only — nothing reads them after
-- this pivot. Safe to drop because they were always optional and
-- nullable; admins paste-configured them, no critical data lost.
ALTER TABLE "Organization" DROP COLUMN IF EXISTS "googleDriveFolderId";
ALTER TABLE "Organization" DROP COLUMN IF EXISTS "googleDriveTemplatesFolderId";
