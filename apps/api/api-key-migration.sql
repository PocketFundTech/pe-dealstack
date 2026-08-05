-- ============================================================
-- ApiKey — machine-to-machine read-only API keys
-- Lets external tools (agents, reporting scripts, integrations)
-- pull org data without a user password / short-lived JWT.
-- Keys are stored as SHA-256 hashes; the raw key is shown once
-- at creation and never persisted.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS "ApiKey" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE,
  "createdBy" UUID REFERENCES "User"(id) ON DELETE SET NULL,

  name TEXT NOT NULL,
  -- SHA-256 hex digest of the full key. Unique so lookup-by-hash is the auth path.
  "keyHash" TEXT NOT NULL UNIQUE,
  -- First characters of the raw key (e.g. "peos_a1b2c3d4"), for display in key lists.
  prefix TEXT NOT NULL,
  -- Scope model: 'read' = GET/HEAD only. Reserved for future: 'write'.
  scopes TEXT[] NOT NULL DEFAULT ARRAY['read'],

  "lastUsedAt" TIMESTAMPTZ,
  "revokedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_apikey_org" ON "ApiKey"("organizationId");
