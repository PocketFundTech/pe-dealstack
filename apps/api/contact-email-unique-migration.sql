-- ============================================================
-- Contact email de-duplication + unique constraint Migration
-- Run this in Supabase SQL Editor (manual — see CLAUDE.md "Manual SQL
-- migration drift": features silently no-op if this isn't applied).
-- ============================================================
--
-- Two surfaces create contacts with no duplicate checking:
--   * POST /api/contacts (apps/api/src/routes/contacts.ts)
--   * the Gmail-suggestions "Add" flow (web-next GmailSuggestions.tsx),
--     where double-clicking a suggestion creates two identical contacts.
--   * the CSV import handler (POST /api/contacts/import).
--
-- The application layer now rejects duplicate emails (case-insensitive,
-- org-scoped) at create time, but that only protects NEW rows and still
-- has a race window. This migration:
--   (A) cleans up EXISTING duplicates already in the DB, repointing every
--       child reference to the kept (oldest) row, then deleting the dupes;
--   (B) installs a partial unique index so the DB enforces the invariant
--       and the API's 23505 race-fallback has something to catch.
--
-- WHY NO TEMP TABLE / NO TRANSACTION: the Supabase SQL editor does not
-- reliably keep session state between statements (pooled connections), so
-- a TEMP table created in one statement is gone by the next (42P01).
-- Instead, every statement below recomputes the duplicate->kept mapping
-- inline as a CTE. That recomputation is STABLE across all statements
-- because the "Contact" table itself is only mutated in the final DELETE —
-- everything before it only touches child tables.
--
-- Idempotent: safe to run more than once (a re-run finds no duplicates and
-- every statement is a no-op; the index uses IF NOT EXISTS). Also safe if a
-- run fails partway — just run the whole file again.
--
-- Dedup key: (lower(email), "organizationId"), ignoring NULL/empty emails.
-- "Kept" row per group = the one with the oldest "createdAt" (ties broken
-- by id for determinism).
--
-- Child tables referencing "Contact"(id) that must be repointed:
--   * "ContactInteraction"."contactId"            (no unique constraint — plain UPDATE)
--   * "ContactDeal"."contactId"                   (UNIQUE(contactId, dealId))
--   * "ContactRelationship"."contactId"           (UNIQUE(contactId, relatedContactId),
--   * "ContactRelationship"."relatedContactId"     CHECK contactId <> relatedContactId)
--   * "IntegrationActivity"."contactIds" (UUID[])  (array membership, no FK)
--
-- The dup_map CTE repeated in every statement:
--   dup contact id -> kept contact id, one row per duplicate (kept rows
--   excluded). FIRST_VALUE over (lower(email), org) ordered by createdAt.
-- ============================================================

-- ─── (A) Clean up existing duplicates ────────────────────────

-- ── ContactInteraction: no unique constraint, repoint unconditionally. ──
WITH ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY lower(email), "organizationId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS keep_id
  FROM "Contact"
  WHERE email IS NOT NULL AND email <> ''
),
dup_map AS (
  SELECT id AS dup_id, keep_id FROM ranked WHERE id <> keep_id
)
UPDATE "ContactInteraction" ci
SET "contactId" = m.keep_id
FROM dup_map m
WHERE ci."contactId" = m.dup_id;

-- ── ContactDeal: UNIQUE(contactId, dealId). Delete links that would
--    collide with an existing link on the kept contact, then repoint. ──
WITH ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY lower(email), "organizationId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS keep_id
  FROM "Contact"
  WHERE email IS NOT NULL AND email <> ''
),
dup_map AS (
  SELECT id AS dup_id, keep_id FROM ranked WHERE id <> keep_id
)
DELETE FROM "ContactDeal" cd
USING dup_map m
WHERE cd."contactId" = m.dup_id
  AND EXISTS (
    SELECT 1 FROM "ContactDeal" keep
    WHERE keep."contactId" = m.keep_id
      AND keep."dealId" = cd."dealId"
  );

WITH ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY lower(email), "organizationId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS keep_id
  FROM "Contact"
  WHERE email IS NOT NULL AND email <> ''
),
dup_map AS (
  SELECT id AS dup_id, keep_id FROM ranked WHERE id <> keep_id
)
UPDATE "ContactDeal" cd
SET "contactId" = m.keep_id
FROM dup_map m
WHERE cd."contactId" = m.dup_id;

-- ── ContactRelationship: repoint BOTH endpoints. Constraints to respect:
--    UNIQUE(contactId, relatedContactId) and CHECK(contactId <> relatedContactId).
--    Order matters: first remove edges that would self-loop or collide after
--    repointing, then repoint each side. ──

-- 1) Drop edges that would become self-loops once both endpoints map to the
--    same kept contact (edge between two dups of the same group, or an edge
--    from a dup to its own kept row).
WITH ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY lower(email), "organizationId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS keep_id
  FROM "Contact"
  WHERE email IS NOT NULL AND email <> ''
),
dup_map AS (
  SELECT id AS dup_id, keep_id FROM ranked WHERE id <> keep_id
)
DELETE FROM "ContactRelationship" cr
USING dup_map ms, dup_map mt
WHERE cr."contactId" = ms.dup_id
  AND cr."relatedContactId" = mt.dup_id
  AND ms.keep_id = mt.keep_id;

WITH ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY lower(email), "organizationId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS keep_id
  FROM "Contact"
  WHERE email IS NOT NULL AND email <> ''
),
dup_map AS (
  SELECT id AS dup_id, keep_id FROM ranked WHERE id <> keep_id
)
DELETE FROM "ContactRelationship" cr
USING dup_map m
WHERE cr."contactId" = m.dup_id
  AND cr."relatedContactId" = m.keep_id;

WITH ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY lower(email), "organizationId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS keep_id
  FROM "Contact"
  WHERE email IS NOT NULL AND email <> ''
),
dup_map AS (
  SELECT id AS dup_id, keep_id FROM ranked WHERE id <> keep_id
)
DELETE FROM "ContactRelationship" cr
USING dup_map m
WHERE cr."relatedContactId" = m.dup_id
  AND cr."contactId" = m.keep_id;

-- 2) Repoint the "contactId" (source) side, deleting any edge that would
--    duplicate an already-existing (keep_id, relatedContactId) edge.
WITH ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY lower(email), "organizationId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS keep_id
  FROM "Contact"
  WHERE email IS NOT NULL AND email <> ''
),
dup_map AS (
  SELECT id AS dup_id, keep_id FROM ranked WHERE id <> keep_id
)
DELETE FROM "ContactRelationship" cr
USING dup_map m
WHERE cr."contactId" = m.dup_id
  AND EXISTS (
    SELECT 1 FROM "ContactRelationship" keep
    WHERE keep."contactId" = m.keep_id
      AND keep."relatedContactId" = cr."relatedContactId"
  );

WITH ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY lower(email), "organizationId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS keep_id
  FROM "Contact"
  WHERE email IS NOT NULL AND email <> ''
),
dup_map AS (
  SELECT id AS dup_id, keep_id FROM ranked WHERE id <> keep_id
)
UPDATE "ContactRelationship" cr
SET "contactId" = m.keep_id
FROM dup_map m
WHERE cr."contactId" = m.dup_id;

-- 3) Repoint the "relatedContactId" (target) side, same dedupe guard.
WITH ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY lower(email), "organizationId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS keep_id
  FROM "Contact"
  WHERE email IS NOT NULL AND email <> ''
),
dup_map AS (
  SELECT id AS dup_id, keep_id FROM ranked WHERE id <> keep_id
)
DELETE FROM "ContactRelationship" cr
USING dup_map m
WHERE cr."relatedContactId" = m.dup_id
  AND EXISTS (
    SELECT 1 FROM "ContactRelationship" keep
    WHERE keep."relatedContactId" = m.keep_id
      AND keep."contactId" = cr."contactId"
  );

WITH ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY lower(email), "organizationId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS keep_id
  FROM "Contact"
  WHERE email IS NOT NULL AND email <> ''
),
dup_map AS (
  SELECT id AS dup_id, keep_id FROM ranked WHERE id <> keep_id
)
UPDATE "ContactRelationship" cr
SET "relatedContactId" = m.keep_id
FROM dup_map m
WHERE cr."relatedContactId" = m.dup_id;

-- ── IntegrationActivity."contactIds" (UUID[]): no FK, repoint by array
--    rewrite. Replace each dup id with its keep id, then de-dupe the array so
--    a contact never appears twice. Only touches rows containing a dup id. ──
WITH ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY lower(email), "organizationId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS keep_id
  FROM "Contact"
  WHERE email IS NOT NULL AND email <> ''
),
dup_map AS (
  SELECT id AS dup_id, keep_id FROM ranked WHERE id <> keep_id
),
rewritten AS (
  SELECT
    ia.id,
    ARRAY(
      SELECT DISTINCT COALESCE(m.keep_id, cid)
      FROM unnest(ia."contactIds") AS cid
      LEFT JOIN dup_map m ON m.dup_id = cid
    ) AS deduped
  FROM "IntegrationActivity" ia
  WHERE ia."contactIds" && (SELECT COALESCE(array_agg(dup_id), '{}'::uuid[]) FROM dup_map)
)
UPDATE "IntegrationActivity" ia
SET "contactIds" = r.deduped
FROM rewritten r
WHERE ia.id = r.id;

-- ── Finally, delete the now-orphaned duplicate Contact rows. ──
WITH ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY lower(email), "organizationId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS keep_id
  FROM "Contact"
  WHERE email IS NOT NULL AND email <> ''
),
dup_map AS (
  SELECT id AS dup_id, keep_id FROM ranked WHERE id <> keep_id
)
DELETE FROM "Contact" c
USING dup_map m
WHERE c.id = m.dup_id;

-- ─── (B) Enforce uniqueness going forward ────────────────────
--
-- Partial, case-insensitive unique index. NULL and empty emails are excluded
-- so contacts without an email are never blocked. The API maps a 23505 from
-- this index to HTTP 409 (race fallback).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_email_org_unique
  ON "Contact" (lower(email), "organizationId")
  WHERE email IS NOT NULL AND email <> '';
