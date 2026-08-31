-- ⛔ MIGRATION GATE: do not consider new-device-login email "live" until the
-- founder has manually run this SQL in Supabase and confirmed it. See
-- docs/PENDING-MIGRATIONS.md and the project's migration-gate convention
-- (Supabase migrations are NOT run automatically by Vercel deploys).

CREATE TABLE "KnownLoginDevice" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL,
  "fingerprintHash" text NOT NULL,
  "firstSeenAt" timestamptz NOT NULL DEFAULT now(),
  "lastSeenAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE("userId", "fingerprintHash")
);

CREATE INDEX ON "KnownLoginDevice"("userId");
