-- ============================================================
-- Outbound webhooks — WebhookSubscription
-- Lets n8n / Zapier / Make receive events (deal.created, deal.stage_changed,
-- document.uploaded, …) instead of polling. Managed in Settings → Webhooks or
-- via /api/webhook-subscriptions.
--
-- Run manually in the Supabase SQL Editor (Vercel does NOT run this).
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS "WebhookSubscription" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE,
  "createdById" uuid REFERENCES "User"(id) ON DELETE SET NULL,
  url text NOT NULL,                       -- https only, validated by the API
  description text,
  events text[] NOT NULL,                  -- e.g. {deal.created,deal.stage_changed}
  secret text NOT NULL,                    -- HMAC signing secret (whsec_…), shown once
  active boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "lastDeliveryAt" timestamptz,
  "lastStatus" integer,                    -- receiver's HTTP status, null = unreachable
  "lastError" text,
  "failureCount" integer NOT NULL DEFAULT 0 -- consecutive failures
);
CREATE INDEX IF NOT EXISTS "WebhookSubscription_organizationId_idx" ON "WebhookSubscription"("organizationId");

-- RLS backstop: no policies, so the browser anon key can never read secrets.
ALTER TABLE "WebhookSubscription" ENABLE ROW LEVEL SECURITY;

-- Verify
SELECT to_regclass('public."WebhookSubscription"') AS webhook_table;  -- not null
