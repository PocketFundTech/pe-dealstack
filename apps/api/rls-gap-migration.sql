-- apps/api/rls-gap-migration.sql
--
-- Closes the RLS gap on tables added after security-hardening-migration.sql.
-- Pattern is identical to that file: backend uses the service-role key
-- (bypasses RLS), so these policies only block unauthenticated direct
-- anon-key access to the Supabase REST/realtime endpoints.
--
-- Idempotent — safe to re-run.

-- ── Organization ────────────────────────────────────────────────────────────
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_organization_all" ON "Organization";
CREATE POLICY "auth_organization_all" ON "Organization"
  FOR ALL USING (auth.uid() IS NOT NULL);

-- ── Integrations ────────────────────────────────────────────────────────────
ALTER TABLE "Integration" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_integration_all" ON "Integration";
CREATE POLICY "auth_integration_all" ON "Integration"
  FOR ALL USING (auth.uid() IS NOT NULL);

ALTER TABLE "IntegrationEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_integration_event_all" ON "IntegrationEvent";
CREATE POLICY "auth_integration_event_all" ON "IntegrationEvent"
  FOR ALL USING (auth.uid() IS NOT NULL);

ALTER TABLE "IntegrationActivity" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_integration_activity_all" ON "IntegrationActivity";
CREATE POLICY "auth_integration_activity_all" ON "IntegrationActivity"
  FOR ALL USING (auth.uid() IS NOT NULL);

-- ── Usage tracking ──────────────────────────────────────────────────────────
ALTER TABLE "UsageEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_usage_event_all" ON "UsageEvent";
CREATE POLICY "auth_usage_event_all" ON "UsageEvent"
  FOR ALL USING (auth.uid() IS NOT NULL);

ALTER TABLE "UsageAlert" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_usage_alert_all" ON "UsageAlert";
CREATE POLICY "auth_usage_alert_all" ON "UsageAlert"
  FOR ALL USING (auth.uid() IS NOT NULL);

-- ModelPrice and OperationCredits are admin config tables — block anon access.
ALTER TABLE "ModelPrice" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_model_price_all" ON "ModelPrice";
CREATE POLICY "auth_model_price_all" ON "ModelPrice"
  FOR ALL USING (auth.uid() IS NOT NULL);

ALTER TABLE "OperationCredits" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_operation_credits_all" ON "OperationCredits";
CREATE POLICY "auth_operation_credits_all" ON "OperationCredits"
  FOR ALL USING (auth.uid() IS NOT NULL);

-- ── VDR / Folder insights ───────────────────────────────────────────────────
ALTER TABLE "FolderInsight" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_folder_insight_all" ON "FolderInsight";
CREATE POLICY "auth_folder_insight_all" ON "FolderInsight"
  FOR ALL USING (auth.uid() IS NOT NULL);

-- ── Agent memory / AI cache ─────────────────────────────────────────────────
-- These tables are created by agent-memory-migration.sql. The DO block skips
-- gracefully if that migration hasn't been run yet.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'AgentMemoryIndustry') THEN
    ALTER TABLE "AgentMemoryIndustry" ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "auth_agent_memory_industry_all" ON "AgentMemoryIndustry";
    CREATE POLICY "auth_agent_memory_industry_all" ON "AgentMemoryIndustry" FOR ALL USING (auth.uid() IS NOT NULL);
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'AgentMemoryExtraction') THEN
    ALTER TABLE "AgentMemoryExtraction" ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "auth_agent_memory_extraction_all" ON "AgentMemoryExtraction";
    CREATE POLICY "auth_agent_memory_extraction_all" ON "AgentMemoryExtraction" FOR ALL USING (auth.uid() IS NOT NULL);
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'AgentMemoryDealHistory') THEN
    ALTER TABLE "AgentMemoryDealHistory" ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "auth_agent_memory_deal_history_all" ON "AgentMemoryDealHistory";
    CREATE POLICY "auth_agent_memory_deal_history_all" ON "AgentMemoryDealHistory" FOR ALL USING (auth.uid() IS NOT NULL);
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'NarrativeInsightCache') THEN
    ALTER TABLE "NarrativeInsightCache" ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "auth_narrative_insight_cache_all" ON "NarrativeInsightCache";
    CREATE POLICY "auth_narrative_insight_cache_all" ON "NarrativeInsightCache" FOR ALL USING (auth.uid() IS NOT NULL);
  END IF;
END $$;
