-- ============================================================
-- API Keys Migration — ApiKey
-- Org-scoped API keys so external tools (n8n, Zapier, Make, scripts) can call
-- the Avise API without a browser session. Keys act as the admin who created
-- them, inside that admin's organization.
--
-- Key format:  avise_sk_<43 url-safe chars>   (shown to the user ONCE)
-- Stored:      SHA-256 hex of the full key + a display prefix + last 4 chars.
--
-- Run manually in the Supabase SQL Editor (Vercel does NOT run this).
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS "ApiKey" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE,
  "userId" uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,  -- key acts as this user
  name text NOT NULL,                    -- e.g. "n8n — deal intake"
  "keyHash" text NOT NULL UNIQUE,        -- sha256 hex of the full key
  "keyPrefix" text NOT NULL,             -- e.g. "avise_sk_AbCd" (display only)
  "lastFour" text NOT NULL,              -- display only
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "lastUsedAt" timestamptz,
  "expiresAt" timestamptz,               -- null = never expires
  "revokedAt" timestamptz
);
CREATE INDEX IF NOT EXISTS "ApiKey_organizationId_idx" ON "ApiKey"("organizationId");

-- RLS backstop (same as DealShare): RLS on, no policies, so the browser anon
-- key can never read key hashes via PostgREST. The API uses the service role.
ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;

-- Verify
SELECT to_regclass('public."ApiKey"') AS api_key_table;  -- not null
