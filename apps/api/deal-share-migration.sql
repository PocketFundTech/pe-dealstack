-- ============================================================
-- Deal Sharing Migration — DealShare + DealShareView
-- Tokenized external deal sharing (client portal) + view tracking.
--
-- To apply: psql "$SUPABASE_DB_URL" -f apps/api/deal-share-migration.sql
-- Or run via the Supabase SQL editor. (Vercel does NOT run this.)
-- ============================================================

CREATE TABLE IF NOT EXISTS "DealShare" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId" uuid NOT NULL REFERENCES "Deal"(id) ON DELETE CASCADE,
  "organizationId" uuid NOT NULL,
  token text NOT NULL UNIQUE,          -- 32-byte crypto-random hex
  label text,                          -- e.g. "Healthcare partner"
  "invitedEmail" text,                 -- informational + used for send-email
  "includeFinancials" boolean NOT NULL DEFAULT true,
  "includeDocuments" boolean NOT NULL DEFAULT true,
  "includeMemos" boolean NOT NULL DEFAULT true,
  "createdBy" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz,             -- null = no expiry
  "revokedAt" timestamptz
);
CREATE INDEX IF NOT EXISTS "DealShare_dealId_idx" ON "DealShare"("dealId");

CREATE TABLE IF NOT EXISTS "DealShareView" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shareId" uuid NOT NULL REFERENCES "DealShare"(id) ON DELETE CASCADE,
  "viewedAt" timestamptz NOT NULL DEFAULT now(),
  "userAgent" text
);
CREATE INDEX IF NOT EXISTS "DealShareView_shareId_idx" ON "DealShareView"("shareId");
