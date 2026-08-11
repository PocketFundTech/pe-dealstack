-- Phase 0: Integrations platform
-- Two tables: Integration (one row per user/provider connection) and
-- IntegrationEvent (webhook event log, used for dedupe + audit).
-- All camelCase identifiers are quoted so Postgres preserves their case;
-- downstream Supabase JS code references them as-is.

CREATE TABLE IF NOT EXISTS public."Integration" (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId"         UUID NOT NULL REFERENCES public."Organization"(id) ON DELETE CASCADE,
  "userId"                 UUID NOT NULL REFERENCES public."User"(id) ON DELETE CASCADE,
  provider                 TEXT NOT NULL CHECK (provider IN ('granola','gmail','google_calendar','fireflies','otter','_mock')),
  status                   TEXT NOT NULL CHECK (status IN ('connected','token_expired','revoked','error')),
  "externalAccountId"      TEXT,
  "externalAccountEmail"   TEXT,
  "accessTokenEncrypted"   TEXT,
  "refreshTokenEncrypted"  TEXT,
  "tokenExpiresAt"         TIMESTAMPTZ,
  scopes                   TEXT[] NOT NULL DEFAULT '{}',
  settings                 JSONB  NOT NULL DEFAULT '{}',
  "lastSyncAt"             TIMESTAMPTZ,
  "lastSyncError"          TEXT,
  "consecutiveFailures"    INT NOT NULL DEFAULT 0,
  "createdAt"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_user_provider
  ON public."Integration"("userId", provider);
CREATE INDEX IF NOT EXISTS idx_integration_org
  ON public."Integration"("organizationId");
CREATE INDEX IF NOT EXISTS idx_integration_provider_status
  ON public."Integration"(provider, status);

CREATE TABLE IF NOT EXISTS public."IntegrationEvent" (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "integrationId" UUID NOT NULL REFERENCES public."Integration"(id) ON DELETE CASCADE,
  "externalId"    TEXT NOT NULL,
  type            TEXT NOT NULL,
  payload         JSONB,
  "receivedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "processedAt"   TIMESTAMPTZ,
  error           TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_event_dedupe
  ON public."IntegrationEvent"("integrationId", "externalId");
CREATE INDEX IF NOT EXISTS idx_integration_event_unprocessed
  ON public."IntegrationEvent"("integrationId", "processedAt")
  WHERE "processedAt" IS NULL;

-- Extend Notification type enum to include integration-related types.
-- DROP IF EXISTS is a safe no-op when the constraint is missing,
-- so this is idempotent across reruns.
ALTER TABLE public."Notification"
  DROP CONSTRAINT IF EXISTS "Notification_type_check";
ALTER TABLE public."Notification"
  ADD CONSTRAINT "Notification_type_check"
  CHECK (type IN (
    'DEAL_UPDATE','DOCUMENT_UPLOADED','MENTION','AI_INSIGHT','TASK_ASSIGNED','COMMENT','SYSTEM',
    'INTEGRATION_SYNC_FAILED','INTEGRATION_RECONNECT_NEEDED','NEW_TRANSCRIPT','STALE_THREAD','MEETING_BRIEF_READY'
  ));
