-- ============================================================
-- LegalDocument + LegalDocTemplate tables — NDA library v1
-- (extensible to LOI / Term Sheet / Definitive Agreement / Side Letter)
--
-- Each LegalDocument row points at a live Google Doc; we never store
-- the document body. counterpartyName is free text (no Contact FK)
-- so v1 ships without a contact reconciliation step.
--
-- Soft-delete convention: set metadata->>'deletedAt' to an ISO timestamp.
-- We deliberately do NOT add a deletedAt column — keeping the soft-delete
-- flag inside metadata lets the table extend to other doc types without
-- forcing every consumer to filter by yet-another nullable column.
--
-- Org-scoping mirrors CustomGraph: every row carries organizationId so
-- the API layer can enforce isolation via plain equality predicates.
--
-- Run in your Supabase SQL Editor. Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS "LegalDocument" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL,
  "dealId" TEXT NOT NULL,
  "createdById" TEXT,
  "docType" TEXT NOT NULL DEFAULT 'NDA'
    CHECK ("docType" IN ('NDA','LOI','TERM_SHEET','DEFINITIVE_AGREEMENT','SIDE_LETTER','OTHER')),
  "title" TEXT NOT NULL,
  "counterpartyName" TEXT,
  "counterpartyEmail" TEXT,
  "status" TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK ("status" IN ('DRAFT','SENT','SIGNED','EXPIRED')),
  "googleDocId" TEXT NOT NULL,
  "googleDocUrl" TEXT NOT NULL,
  "googleDriveFolderId" TEXT,
  "templateId" TEXT,
  "effectiveDate" DATE,
  "signedAt" TIMESTAMPTZ,
  "expiresAt" DATE,
  "lastSyncedAt" TIMESTAMPTZ,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot-path indexes
CREATE INDEX IF NOT EXISTS "LegalDocument_organizationId_idx"
  ON "LegalDocument"("organizationId");
CREATE INDEX IF NOT EXISTS "LegalDocument_dealId_idx"
  ON "LegalDocument"("dealId");
CREATE INDEX IF NOT EXISTS "LegalDocument_docType_idx"
  ON "LegalDocument"("docType");

-- Org-scoped template library. placeholderMap lets an admin override
-- the default placeholder set (e.g. swap [COUNTERPARTY] for [PARTY_B]).
CREATE TABLE IF NOT EXISTS "LegalDocTemplate" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "docType" TEXT NOT NULL DEFAULT 'NDA',
  "googleDocId" TEXT NOT NULL,
  "placeholderMap" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "isDefault" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "LegalDocTemplate_organizationId_idx"
  ON "LegalDocTemplate"("organizationId");

-- Workspace customers paste their Shared Drive folder ID here. Personal-
-- Gmail customers degrade to provisioning a folder in the connecting
-- user's My Drive on first connect.
ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "googleDriveFolderId" TEXT;
ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "googleDriveTemplatesFolderId" TEXT;

-- Reuse the shared trigger function (defined in custom-graph-migration.sql
-- and memo-schema.sql). Safe to re-create — CREATE OR REPLACE preserves
-- any existing triggers that already bind to it.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$ LANGUAGE 'plpgsql';

DROP TRIGGER IF EXISTS update_legaldocument_updated_at ON "LegalDocument";
CREATE TRIGGER update_legaldocument_updated_at
  BEFORE UPDATE ON "LegalDocument"
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_legaldoctemplate_updated_at ON "LegalDocTemplate";
CREATE TRIGGER update_legaldoctemplate_updated_at
  BEFORE UPDATE ON "LegalDocTemplate"
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
