-- Phase 1: IntegrationActivity table for provider-sourced events
-- (Granola meetings, Gmail emails, Calendar events, etc.).
-- Separate from the existing Activity table so the human-action log stays clean.
-- A single provider event can match multiple deals/contacts in our CRM, so we
-- store arrays rather than denormalizing one row per (event, deal) pair.

CREATE TABLE IF NOT EXISTS public."IntegrationActivity" (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "integrationId" UUID NOT NULL REFERENCES public."Integration"(id) ON DELETE CASCADE,
  "organizationId" UUID NOT NULL REFERENCES public."Organization"(id) ON DELETE CASCADE,
  "userId"        UUID NOT NULL REFERENCES public."User"(id) ON DELETE CASCADE,
  source          TEXT NOT NULL CHECK (source IN ('granola','gmail','google_calendar','fireflies','otter','_mock')),
  "externalId"    TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('MEETING','EMAIL','CALENDAR_EVENT')),
  "dealIds"       UUID[] NOT NULL DEFAULT '{}',
  "contactIds"    UUID[] NOT NULL DEFAULT '{}',
  title           TEXT NOT NULL,
  summary         TEXT,
  "occurredAt"    TIMESTAMPTZ NOT NULL,
  "durationSeconds" INT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  "aiExtraction"  JSONB,
  "rawTranscript" TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (integration, source, externalId). Re-syncing the same event from
-- the same connected integration becomes an upsert and never creates duplicates.
-- Two users in the same firm who both attended the same Granola meeting will
-- each get their own row, scoped to their own connection — no overwrites.
CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_activity_dedupe
  ON public."IntegrationActivity"("integrationId", source, "externalId");

-- Org-scoped lists.
CREATE INDEX IF NOT EXISTS idx_integration_activity_org_occurred
  ON public."IntegrationActivity"("organizationId", "occurredAt" DESC);

-- Fast lookup of activities for a given deal or contact.
-- GIN indexes are the right shape for `WHERE col @> ARRAY[id]` containment queries.
CREATE INDEX IF NOT EXISTS idx_integration_activity_dealIds
  ON public."IntegrationActivity" USING GIN ("dealIds");
CREATE INDEX IF NOT EXISTS idx_integration_activity_contactIds
  ON public."IntegrationActivity" USING GIN ("contactIds");

-- Filter by type when rendering "all meetings" / "all emails" tabs.
CREATE INDEX IF NOT EXISTS idx_integration_activity_org_type
  ON public."IntegrationActivity"("organizationId", type, "occurredAt" DESC);
