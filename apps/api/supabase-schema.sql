-- AI CRM Database Schema for Supabase
-- Run this SQL in Supabase SQL Editor to create tables

-- Create Company table
CREATE TABLE IF NOT EXISTS "Company" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  industry TEXT,
  description TEXT,
  website TEXT,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create Deal table
CREATE TABLE IF NOT EXISTS "Deal" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  "companyId" UUID NOT NULL REFERENCES "Company"(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'INITIAL_REVIEW',
  status TEXT NOT NULL DEFAULT 'ACTIVE',

  -- Financial metrics
  "irrProjected" DOUBLE PRECISION,
  mom DOUBLE PRECISION,
  ebitda DOUBLE PRECISION,
  revenue DOUBLE PRECISION,

  -- Deal details
  industry TEXT,
  "dealSize" DOUBLE PRECISION,
  description TEXT,
  "aiThesis" TEXT,

  -- Metadata
  icon TEXT DEFAULT 'business_center',
  "lastDocument" TEXT,
  "lastDocumentUpdated" TIMESTAMP WITH TIME ZONE,

  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create Document table
CREATE TABLE IF NOT EXISTS "Document" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId" UUID NOT NULL REFERENCES "Deal"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'OTHER',
  "fileUrl" TEXT,
  "fileSize" INTEGER,
  "mimeType" TEXT,

  -- AI extracted data
  "extractedData" JSONB,
  confidence DOUBLE PRECISION,

  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create Activity table
CREATE TABLE IF NOT EXISTS "Activity" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId" UUID NOT NULL REFERENCES "Deal"(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  metadata JSONB,

  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS "idx_deal_companyId" ON "Deal"("companyId");
CREATE INDEX IF NOT EXISTS "idx_deal_stage" ON "Deal"(stage);
CREATE INDEX IF NOT EXISTS "idx_deal_status" ON "Deal"(status);
CREATE INDEX IF NOT EXISTS "idx_deal_updatedAt" ON "Deal"("updatedAt");
CREATE INDEX IF NOT EXISTS "idx_document_dealId" ON "Document"("dealId");
CREATE INDEX IF NOT EXISTS "idx_document_type" ON "Document"(type);
CREATE INDEX IF NOT EXISTS "idx_activity_dealId" ON "Activity"("dealId");
CREATE INDEX IF NOT EXISTS "idx_activity_createdAt" ON "Activity"("createdAt");
CREATE INDEX IF NOT EXISTS "idx_company_name" ON "Company"(name);

-- Legacy global seed data (Apex Logistics / MediCare Plus / Nebula Systems /
-- Titan Freight) was removed. Sample deals are now created per-organization
-- via apps/api/src/services/sampleDealService.ts when a new org signs up,
-- which respects multi-tenancy (organizationId scoping) introduced after the
-- original seed was written.

-- Enable Row Level Security (optional - for future auth)
-- ALTER TABLE "Company" ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE "Deal" ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE "Document" ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE "Activity" ENABLE ROW LEVEL SECURITY;

-- Create policies (optional - for future auth)
-- CREATE POLICY "Enable read access for all users" ON "Company" FOR SELECT USING (true);
-- CREATE POLICY "Enable read access for all users" ON "Deal" FOR SELECT USING (true);
-- CREATE POLICY "Enable read access for all users" ON "Document" FOR SELECT USING (true);
-- CREATE POLICY "Enable read access for all users" ON "Activity" FOR SELECT USING (true);
