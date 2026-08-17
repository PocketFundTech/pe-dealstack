-- ============================================================
-- Document Request Migration — DocRequest + DocRequestItem + DocRequestEvent
--
-- A structured document ask sent to a broker/seller, fulfilled through a
-- tokenized public upload page. Mirrors the DealShare/DealShareView shape
-- (see deal-share-migration.sql) — same token model, same revoke/expiry
-- semantics, same RLS backstop.
--
-- To apply: psql "$SUPABASE_DB_URL" -f apps/api/doc-request-migration.sql
-- Or run via the Supabase SQL editor. (Vercel does NOT run this.)
-- ============================================================

CREATE TABLE IF NOT EXISTS "DocRequest" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId"         uuid NOT NULL REFERENCES "Deal"(id) ON DELETE CASCADE,
  "organizationId" uuid NOT NULL,
  token            text NOT NULL UNIQUE,        -- 32-byte crypto-random hex
  "recipientEmail" text,
  "recipientName"  text,
  message          text,                        -- optional note shown on the page
  status           text NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN','PARTIAL','FULFILLED','CANCELLED')),
  "createdBy"      text,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "expiresAt"      timestamptz,                 -- null = no expiry
  "revokedAt"      timestamptz,
  "lastRemindedAt" timestamptz,
  "reminderCount"  integer NOT NULL DEFAULT 0,  -- capped in services/docRequests.ts
  "completedAt"    timestamptz
);
CREATE INDEX IF NOT EXISTS "DocRequest_dealId_idx" ON "DocRequest"("dealId");
CREATE INDEX IF NOT EXISTS "DocRequest_org_status_idx" ON "DocRequest"("organizationId", status);

CREATE TABLE IF NOT EXISTS "DocRequestItem" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "requestId"   uuid NOT NULL REFERENCES "DocRequest"(id) ON DELETE CASCADE,
  label         text NOT NULL,                  -- "3-year P&L"
  "docType"     text,                           -- maps to Document.type where known
  notes         text,
  required      boolean NOT NULL DEFAULT true,
  "sortOrder"   integer NOT NULL DEFAULT 0,
  "documentId"  uuid REFERENCES "Document"(id) ON DELETE SET NULL,
  "fulfilledAt" timestamptz
);
CREATE INDEX IF NOT EXISTS "DocRequestItem_requestId_idx" ON "DocRequestItem"("requestId");

-- View/upload log for the public page (mirrors DealShareView).
CREATE TABLE IF NOT EXISTS "DocRequestEvent" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "requestId" uuid NOT NULL REFERENCES "DocRequest"(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('VIEWED','UPLOADED','COMPLETED')),
  "itemId"    uuid REFERENCES "DocRequestItem"(id) ON DELETE SET NULL,
  "userAgent" text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "DocRequestEvent_requestId_idx" ON "DocRequestEvent"("requestId");

-- RLS backstop (matches rls-hardening-migration.sql's Option C): enable RLS
-- with no policies so the browser anon key gets zero rows via PostgREST —
-- request TOKENS must never be readable client-side. The Express API uses
-- the service role, which bypasses RLS.
ALTER TABLE "DocRequest"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocRequestItem"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocRequestEvent" ENABLE ROW LEVEL SECURITY;
