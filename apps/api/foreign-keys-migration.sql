-- ============================================================
-- UUID column types + foreign-key constraints for
-- LegalDocument, LegalDocTemplate, CustomGraph
--
-- Two-part migration:
--
-- 1) Convert TEXT id / foreign-key columns to native UUID
--    Phase 1/2 migrations defined these as `TEXT ... DEFAULT
--    gen_random_uuid()::text`, but Deal / Organization / User use
--    native UUID. Postgres rejects FKs across incompatible types:
--      ERROR 42804: foreign key constraint cannot be implemented
--      DETAIL: columns are of incompatible types: text and uuid
--    Casting to UUID via `USING col::uuid` succeeds because every
--    row we've inserted so far already holds a valid UUID string.
--
-- 2) Add FOREIGN KEY constraints so PostgREST can resolve the
--    embedded-join syntax we use throughout the routes:
--      .select('*, deal:Deal(id, projectName:name, target:companyName)')
--    Without these, PostgREST returns PGRST200 the moment a row
--    exists to join.
--
-- Each per-table block is guarded by an information_schema.tables
-- existence check so the migration is safe to run even if you
-- haven't applied custom-graph-migration.sql yet (it'll just skip
-- CustomGraph). Constraints + column type changes are individually
-- guarded too — re-runnable.
--
-- Final NOTIFY tells PostgREST to drop its schema cache and rebuild,
-- so the new FKs are visible to the API within seconds (no restart).
--
-- Run in Supabase SQL Editor.
-- ============================================================

-- ───────────────────────────────────────────────────────────
-- LegalDocument: types + FKs
-- ───────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'LegalDocument') THEN
    RAISE NOTICE 'LegalDocument table not found — skipping (run legal-document-migration.sql first if you want NDAs)';
    RETURN;
  END IF;

  -- Type conversions
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'LegalDocument' AND column_name = 'id') = 'text' THEN
    ALTER TABLE "LegalDocument" ALTER COLUMN "id" DROP DEFAULT;
    ALTER TABLE "LegalDocument" ALTER COLUMN "id" TYPE UUID USING "id"::uuid;
    ALTER TABLE "LegalDocument" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
  END IF;
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'LegalDocument' AND column_name = 'organizationId') = 'text' THEN
    ALTER TABLE "LegalDocument" ALTER COLUMN "organizationId" TYPE UUID USING "organizationId"::uuid;
  END IF;
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'LegalDocument' AND column_name = 'dealId') = 'text' THEN
    ALTER TABLE "LegalDocument" ALTER COLUMN "dealId" TYPE UUID USING "dealId"::uuid;
  END IF;
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'LegalDocument' AND column_name = 'createdById') = 'text' THEN
    ALTER TABLE "LegalDocument" ALTER COLUMN "createdById" TYPE UUID USING "createdById"::uuid;
  END IF;
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'LegalDocument' AND column_name = 'templateId') = 'text' THEN
    ALTER TABLE "LegalDocument" ALTER COLUMN "templateId" TYPE UUID USING "templateId"::uuid;
  END IF;

  -- Foreign keys
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LegalDocument_dealId_fkey') THEN
    ALTER TABLE "LegalDocument"
      ADD CONSTRAINT "LegalDocument_dealId_fkey"
        FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LegalDocument_organizationId_fkey') THEN
    ALTER TABLE "LegalDocument"
      ADD CONSTRAINT "LegalDocument_organizationId_fkey"
        FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE NOT VALID;
  END IF;
  -- templateId FK is added in the LegalDocTemplate block (after that table is guaranteed UUID)
END
$$;

-- ───────────────────────────────────────────────────────────
-- LegalDocTemplate: types + FKs
-- ───────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'LegalDocTemplate') THEN
    RAISE NOTICE 'LegalDocTemplate table not found — skipping';
    RETURN;
  END IF;

  -- Type conversions
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'LegalDocTemplate' AND column_name = 'id') = 'text' THEN
    ALTER TABLE "LegalDocTemplate" ALTER COLUMN "id" DROP DEFAULT;
    ALTER TABLE "LegalDocTemplate" ALTER COLUMN "id" TYPE UUID USING "id"::uuid;
    ALTER TABLE "LegalDocTemplate" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
  END IF;
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'LegalDocTemplate' AND column_name = 'organizationId') = 'text' THEN
    ALTER TABLE "LegalDocTemplate" ALTER COLUMN "organizationId" TYPE UUID USING "organizationId"::uuid;
  END IF;

  -- Foreign keys
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LegalDocTemplate_organizationId_fkey') THEN
    ALTER TABLE "LegalDocTemplate"
      ADD CONSTRAINT "LegalDocTemplate_organizationId_fkey"
        FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE NOT VALID;
  END IF;

  -- LegalDocument → LegalDocTemplate FK now that both sides are UUID
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'LegalDocument')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LegalDocument_templateId_fkey') THEN
    ALTER TABLE "LegalDocument"
      ADD CONSTRAINT "LegalDocument_templateId_fkey"
        FOREIGN KEY ("templateId") REFERENCES "LegalDocTemplate"("id") ON DELETE SET NULL NOT VALID;
  END IF;
END
$$;

-- ───────────────────────────────────────────────────────────
-- CustomGraph: types + FKs (skipped entirely if you haven't
-- run custom-graph-migration.sql yet)
-- ───────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'CustomGraph') THEN
    RAISE NOTICE 'CustomGraph table not found — skipping (run custom-graph-migration.sql first if you want graphs)';
    RETURN;
  END IF;

  -- Type conversions
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'CustomGraph' AND column_name = 'id') = 'text' THEN
    ALTER TABLE "CustomGraph" ALTER COLUMN "id" DROP DEFAULT;
    ALTER TABLE "CustomGraph" ALTER COLUMN "id" TYPE UUID USING "id"::uuid;
    ALTER TABLE "CustomGraph" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
  END IF;
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'CustomGraph' AND column_name = 'organizationId') = 'text' THEN
    ALTER TABLE "CustomGraph" ALTER COLUMN "organizationId" TYPE UUID USING "organizationId"::uuid;
  END IF;
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'CustomGraph' AND column_name = 'dealId') = 'text' THEN
    ALTER TABLE "CustomGraph" ALTER COLUMN "dealId" TYPE UUID USING "dealId"::uuid;
  END IF;
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'CustomGraph' AND column_name = 'createdById') = 'text' THEN
    ALTER TABLE "CustomGraph" ALTER COLUMN "createdById" TYPE UUID USING "createdById"::uuid;
  END IF;

  -- Foreign keys
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomGraph_dealId_fkey') THEN
    ALTER TABLE "CustomGraph"
      ADD CONSTRAINT "CustomGraph_dealId_fkey"
        FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomGraph_organizationId_fkey') THEN
    ALTER TABLE "CustomGraph"
      ADD CONSTRAINT "CustomGraph_organizationId_fkey"
        FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE NOT VALID;
  END IF;
END
$$;

-- ───────────────────────────────────────────────────────────
-- Document → User (uploadedBy): the FK was left commented out in
-- vdr-schema.sql (the `uploadedBy` column is added as a bare UUID),
-- so PostgREST can't resolve the `uploader:User!uploadedBy` embed
-- used by GET /deals/:dealId/documents — it returns PGRST200 → 500.
-- Adding the constraint resolves the relationship.
-- ───────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'Document') THEN
    RAISE NOTICE 'Document table not found — skipping';
    RETURN;
  END IF;

  -- Normalise the column to UUID so the FK to User(id) is type-compatible.
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'Document' AND column_name = 'uploadedBy') = 'text' THEN
    ALTER TABLE "Document" ALTER COLUMN "uploadedBy" TYPE UUID USING "uploadedBy"::uuid;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Document_uploadedBy_fkey') THEN
    ALTER TABLE "Document"
      ADD CONSTRAINT "Document_uploadedBy_fkey"
        FOREIGN KEY ("uploadedBy") REFERENCES "User"("id") ON DELETE SET NULL NOT VALID;
  END IF;
END
$$;

-- ───────────────────────────────────────────────────────────
-- Force PostgREST to rebuild its relationship cache
-- ───────────────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';
