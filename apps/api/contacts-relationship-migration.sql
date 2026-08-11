-- ============================================================
-- Contact ↔ Contact Relationship (Connections) Migration
-- Run this in Supabase SQL Editor
-- ============================================================
--
-- BACKFILL: The "ContactRelationship" table is referenced end-to-end by the
-- code (routes in apps/api/src/routes/contacts-connections.ts at L161-281, plus
-- the contacts UI) but has NO migration anywhere, so the live DB lacks it. The
-- GET /api/contacts/:id/connections handler defensively returns { connections: [] }
-- when the table is absent (L182-186), which means the feature SILENTLY no-ops.
-- This migration creates the table the code already expects, with exact
-- column-name parity (drift here = silent failure).
--
-- Org-scoping note: contacts-connections.ts scopes every relationship operation
-- by calling verifyContactAccess(contactId, orgId) FIRST (see L165, L206, L262),
-- which resolves Contact -> organizationId. The relationship rows themselves
-- carry NO organizationId column — ownership is derived through the Contact FKs,
-- exactly like the sibling "ContactInteraction" and "ContactDeal" tables in
-- contacts-migration.sql. We mirror that pattern and do NOT add organizationId.
-- ============================================================

-- ─── Contact Relationship Table (contact ↔ contact, directional edge) ──
CREATE TABLE IF NOT EXISTS "ContactRelationship" (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "contactId" UUID NOT NULL REFERENCES "Contact"(id) ON DELETE CASCADE,
  "relatedContactId" UUID NOT NULL REFERENCES "Contact"(id) ON DELETE CASCADE,
  type TEXT NOT NULL
    CHECK (type IN ('KNOWS', 'REFERRED_BY', 'REPORTS_TO', 'COLLEAGUE', 'INTRODUCED_BY')),
  notes TEXT,
  "createdBy" UUID REFERENCES "User"(id),
  "createdAt" TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  -- Prevent duplicate edges between the same ordered pair of contacts.
  -- The POST handler relies on this: a 23505 violation is mapped to
  -- "This connection already exists" (HTTP 409).
  UNIQUE ("contactId", "relatedContactId"),
  -- Guard against self-relationships at the DB level (the route also rejects
  -- relatedContactId === id with HTTP 400, this is defense-in-depth).
  CHECK ("contactId" <> "relatedContactId")
);

COMMENT ON TABLE "ContactRelationship" IS 'Directional contact-to-contact relationships (connections). Created/read/deleted by apps/api/src/routes/contacts-connections.ts. Org ownership is derived through the Contact FKs, not a local organizationId.';
COMMENT ON COLUMN "ContactRelationship"."contactId" IS 'Source contact of the relationship edge (the "from" side; outgoing direction in the connections API).';
COMMENT ON COLUMN "ContactRelationship"."relatedContactId" IS 'Target contact of the relationship edge (the "to" side; incoming direction in the connections API).';
COMMENT ON COLUMN "ContactRelationship".type IS 'Relationship kind: KNOWS, REFERRED_BY, REPORTS_TO, COLLEAGUE, INTRODUCED_BY.';
COMMENT ON COLUMN "ContactRelationship".notes IS 'Optional free-text note about the relationship (max 2000 chars enforced in the API layer).';
COMMENT ON COLUMN "ContactRelationship"."createdBy" IS 'User who created the relationship. Nullable — the API only sets it when req.user.id exists.';

-- ─── Indexes ─────────────────────────────────────────────────
-- Both directions are queried in GET /:id/connections (one filter per side).
CREATE INDEX IF NOT EXISTS idx_contact_relationship_contact ON "ContactRelationship" ("contactId");
CREATE INDEX IF NOT EXISTS idx_contact_relationship_related ON "ContactRelationship" ("relatedContactId");
CREATE INDEX IF NOT EXISTS idx_contact_relationship_created_by ON "ContactRelationship" ("createdBy");

-- ─── RLS ─────────────────────────────────────────────────────
-- Sibling tables (Contact, ContactInteraction, ContactDeal) enable RLS with
-- permissive USING (true) policies; access control is enforced in the API layer
-- via verifyContactAccess. Mirror that here.
ALTER TABLE "ContactRelationship" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "contact_relationship_select" ON "ContactRelationship" FOR SELECT USING (true);
CREATE POLICY "contact_relationship_insert" ON "ContactRelationship" FOR INSERT WITH CHECK (true);
CREATE POLICY "contact_relationship_delete" ON "ContactRelationship" FOR DELETE USING (true);
