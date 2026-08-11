-- ============================================================
-- HubSpot Import Migration
-- Tables: HubSpotConnection, ImportJob
-- Columns: hubspotId / hubspotProperties on Contact, Company, Deal
-- ============================================================

CREATE TABLE IF NOT EXISTS public."HubSpotConnection" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL UNIQUE,
  "authType" text NOT NULL DEFAULT 'private_app'
    CHECK ("authType" IN ('private_app','oauth')),
  "accessToken" text NOT NULL,           -- encrypted (AES-256-GCM)
  "refreshToken" text,                   -- encrypted (oauth only)
  "tokenExpiresAt" timestamptz,
  "portalId" text,
  "connectedBy" uuid REFERENCES public."User"(id),
  "createdAt" timestamptz DEFAULT now() NOT NULL,
  "updatedAt" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public."ImportJob" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL,
  source text NOT NULL DEFAULT 'hubspot',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','failed','cancelled')),
  "objectCounts" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "currentObject" text,
  cursor text,
  error text,
  "startedBy" uuid REFERENCES public."User"(id),
  "startedAt" timestamptz,
  "finishedAt" timestamptz,
  "createdAt" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_importjob_org ON public."ImportJob" ("organizationId");
CREATE INDEX IF NOT EXISTS idx_importjob_status ON public."ImportJob" (status);

ALTER TABLE public."Contact" ADD COLUMN IF NOT EXISTS "hubspotId" text;
ALTER TABLE public."Contact" ADD COLUMN IF NOT EXISTS "hubspotProperties" jsonb;
ALTER TABLE public."Company" ADD COLUMN IF NOT EXISTS "hubspotId" text;
ALTER TABLE public."Company" ADD COLUMN IF NOT EXISTS "hubspotProperties" jsonb;
ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "hubspotId" text;
ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "hubspotProperties" jsonb;

-- One imported row per (org, hubspotId) per object type → idempotent re-import.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_hubspot
  ON public."Contact" ("organizationId", "hubspotId") WHERE "hubspotId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_hubspot
  ON public."Company" ("organizationId", "hubspotId") WHERE "hubspotId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_hubspot
  ON public."Deal" ("organizationId", "hubspotId") WHERE "hubspotId" IS NOT NULL;
