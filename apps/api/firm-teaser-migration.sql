CREATE TABLE IF NOT EXISTS "DealTeaser" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId" UUID NOT NULL REFERENCES "Deal"(id) ON DELETE CASCADE,
  "organizationId" UUID NOT NULL,
  "profileId" TEXT NOT NULL,
  headline TEXT NOT NULL,
  fits JSONB NOT NULL DEFAULT '[]',
  model TEXT,
  stale BOOLEAN NOT NULL DEFAULT false,
  "generatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE ("dealId", "profileId")
);
CREATE INDEX IF NOT EXISTS "idx_dealteaser_dealId" ON "DealTeaser"("dealId");
CREATE INDEX IF NOT EXISTS "idx_dealteaser_org" ON "DealTeaser"("organizationId");
