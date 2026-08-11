-- Research concurrency lock: prevents two enrich-firm runs racing for the
-- same org across serverless instances. The prior guard (an in-process
-- Set in firmResearchAgent/index.ts) explicitly could not do this — see
-- design spec §3.2.
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "researchLockedAt" timestamptz;
