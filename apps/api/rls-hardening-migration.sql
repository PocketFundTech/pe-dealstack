-- ============================================================
-- RLS Hardening — Lock Out Browser Anon Key (Option C)
-- ============================================================
--
-- TRUST MODEL (important for future maintainers):
-- Express + service role key is the authorization boundary for this
-- application. All data queries go through the Express API; the
-- browser does not query Supabase directly (verified via grep:
-- zero supabase.from() calls in apps/web-next/, zero realtime
-- subscriptions).
--
-- These RLS policies exist as a defense-in-depth BACKSTOP: if a user
-- opens devtools and tries to query Supabase directly using the
-- public anon key + their JWT, they get zero rows back. Authorization
-- is still enforced inside Express via orgMiddleware + verifyXAccess
-- (see apps/api/src/middleware/orgScope.ts).
--
-- Service role bypasses RLS automatically (Postgres built-in: any
-- role with BYPASSRLS skips policy evaluation; Supabase grants this
-- to the service_role), so the Express API is unaffected.
--
-- If you later add Supabase Realtime subscriptions or direct browser
-- queries (e.g., for chat/dashboard live updates), you will need to
-- replace these policies with org-scoped policies that filter by
-- auth.uid() and a custom-claim organizationId. Until then, Option C
-- is the minimal correct configuration.
--
-- IDEMPOTENT — safe to re-run.
-- ============================================================

-- ─── Step 1: Drop the existing permissive policies ───
--
-- The prior `security-hardening-migration.sql` created policies that
-- only check `auth.uid() IS NOT NULL` — which is "is the request
-- authenticated?", not "does this row belong to the requester's org?".
-- Same-shaped policies live in `contacts-migration.sql`,
-- `chat-history-migration.sql`, `memo-schema.sql`, `audit-schema.sql`,
-- `invitation-migration.sql`, `usage-tracking-migration.sql`,
-- `watchlist-migration.sql`.
--
-- We drop ALL policies on each tenant table so the deny-all policies
-- below are the only ones evaluated.

DO $$
DECLARE
  tbl text;
  pol record;
  tables text[] := ARRAY[
    'Organization',
    'User',
    'Deal',
    'Document',
    'Folder',
    'FolderInsight',
    'Activity',
    'FinancialStatement',
    'DocumentChunk',
    'Company',
    'Contact',
    'ContactInteraction',
    'ContactDeal',
    'Conversation',
    'ChatMessage',
    'Memo',
    'MemoSection',
    'MemoConversation',
    'MemoChatMessage',
    'MemoTemplate',
    'MemoTemplateSection',
    'Task',
    'Notification',
    'AuditLog',
    'Invitation',
    'UsageEvent',
    'UsageAlert',
    'OperationCredits',
    'ModelPrice',
    'Watchlist',
    'DealTeamMember',
    'FinancialExtractionCache',
    'AgentMemoryIndustry',
    'AgentMemoryExtraction',
    'AgentMemoryDealHistory',
    'NarrativeInsightCache'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- Only act if the table actually exists in this database.
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = tbl AND c.relkind = 'r'
    ) THEN
      FOR pol IN
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = tbl
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
                       pol.policyname, tbl);
      END LOOP;
    END IF;
  END LOOP;
END$$;

-- ─── Step 2: Enable RLS + apply deny-all to anon, authenticated ───
--
-- Per-table: enable RLS and create a single FOR ALL policy that
-- denies every operation for the `anon` and `authenticated` roles.
-- The `service_role` (used by Express via SUPABASE_SERVICE_ROLE_KEY)
-- has BYPASSRLS so its queries are unaffected.
--
-- Using USING (false) WITH CHECK (false) means:
--   - SELECT  → 0 rows
--   - INSERT  → policy violation
--   - UPDATE  → 0 rows affected (row invisible)
--   - DELETE  → 0 rows affected (row invisible)
--
-- Wrapped in DO $$ ... $$ guards so missing tables (e.g. Watchlist
-- in environments where that feature flag never ran) don't abort.

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'Organization',
    'User',
    'Deal',
    'Document',
    'Folder',
    'FolderInsight',
    'Activity',
    'FinancialStatement',
    'DocumentChunk',
    'Company',
    'Contact',
    'ContactInteraction',
    'ContactDeal',
    'Conversation',
    'ChatMessage',
    'Memo',
    'MemoSection',
    'MemoConversation',
    'MemoChatMessage',
    'MemoTemplate',
    'MemoTemplateSection',
    'Task',
    'Notification',
    'AuditLog',
    'Invitation',
    'UsageEvent',
    'UsageAlert',
    'OperationCredits',
    'ModelPrice',
    'Watchlist',
    'DealTeamMember',
    'FinancialExtractionCache',
    'AgentMemoryIndustry',
    'AgentMemoryExtraction',
    'AgentMemoryDealHistory',
    'NarrativeInsightCache'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = tbl AND c.relkind = 'r'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      -- Idempotency: drop the deny-all policy if it already exists,
      -- then recreate it. (Step 1 already dropped everything, but
      -- being explicit keeps this block independently re-runnable.)
      EXECUTE format(
        'DROP POLICY IF EXISTS %I ON public.%I',
        tbl || '_service_role_only', tbl
      );
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
        tbl || '_service_role_only', tbl
      );
    END IF;
  END LOOP;
END$$;

-- ─── Step 3: Verification (run manually after applying) ───
--
-- As the authenticated role (browser anon key + a real JWT), every
-- tenant table should return 0 rows:
--
--   SET ROLE authenticated;
--   SELECT count(*) FROM public."Deal";        -- expect 0
--   SELECT count(*) FROM public."Document";    -- expect 0
--   SELECT count(*) FROM public."Organization";-- expect 0
--   SELECT count(*) FROM public."User";        -- expect 0
--   RESET ROLE;
--
-- As the service_role (used by Express), the same queries should
-- return real data:
--
--   SET ROLE service_role;
--   SELECT count(*) FROM public."Deal";        -- real count
--   RESET ROLE;
--
-- Listing active policies:
--
--   SELECT tablename, policyname, roles, qual
--   FROM pg_policies
--   WHERE schemaname = 'public'
--   ORDER BY tablename, policyname;
--
-- Each tenant table should show exactly one policy named
-- `<TableName>_service_role_only` scoped to {anon, authenticated}
-- with qual `false`.
--
-- ============================================================
-- NOTE: This migration does NOT touch the `auth` schema (Supabase
-- Auth tables remain untouched), nor public-by-design storage
-- buckets (`avatars`, `org-logos`). The `documents` storage bucket
-- continues to be served via service-role-signed URLs from Express.
-- ============================================================
