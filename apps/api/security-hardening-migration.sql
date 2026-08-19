-- ============================================================
-- Security Hardening Migration — Avise
-- Run this AFTER switching the 'documents' bucket to private
-- in the Supabase Dashboard.
-- ============================================================

-- ─── Step 1: Strip public URL prefix from Document.fileUrl ───
-- Converts full public URLs to storage paths:
--   https://xxx.supabase.co/storage/v1/object/public/documents/dealId/file.pdf
--   → dealId/file.pdf

UPDATE "Document"
SET "fileUrl" = regexp_replace(
  "fileUrl",
  '^https://[^/]+/storage/v1/object/public/documents/',
  ''
)
WHERE "fileUrl" LIKE '%/storage/v1/object/public/documents/%';

-- ─── Step 2: Enable RLS on core tables ───
-- Backend uses service role key (bypasses RLS).
-- This protects against direct client-side queries using the anon key.

ALTER TABLE "Company" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Deal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Activity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinancialStatement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Folder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealTeamMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;

-- Policies: require authenticated user for all operations
CREATE POLICY "auth_company_all" ON "Company" FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_deal_all" ON "Deal" FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_document_all" ON "Document" FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_activity_all" ON "Activity" FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_user_all" ON "User" FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_task_all" ON "Task" FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_financial_all" ON "FinancialStatement" FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_folder_all" ON "Folder" FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_team_member_all" ON "DealTeamMember" FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_notification_all" ON "Notification" FOR ALL USING (auth.uid() IS NOT NULL);

-- ─── Step 3: Fix Contact tables — replace USING (true) with auth check ───
DROP POLICY IF EXISTS "contacts_select" ON "Contact";
DROP POLICY IF EXISTS "contacts_insert" ON "Contact";
DROP POLICY IF EXISTS "contacts_update" ON "Contact";
DROP POLICY IF EXISTS "contacts_delete" ON "Contact";

CREATE POLICY "auth_contact_select" ON "Contact" FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_contact_insert" ON "Contact" FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_contact_update" ON "Contact" FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_contact_delete" ON "Contact" FOR DELETE USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "interactions_select" ON "ContactInteraction";
DROP POLICY IF EXISTS "interactions_insert" ON "ContactInteraction";
DROP POLICY IF EXISTS "interactions_delete" ON "ContactInteraction";

CREATE POLICY "auth_interaction_select" ON "ContactInteraction" FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_interaction_insert" ON "ContactInteraction" FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_interaction_delete" ON "ContactInteraction" FOR DELETE USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "contact_deal_select" ON "ContactDeal";
DROP POLICY IF EXISTS "contact_deal_insert" ON "ContactDeal";
DROP POLICY IF EXISTS "contact_deal_delete" ON "ContactDeal";

CREATE POLICY "auth_contact_deal_select" ON "ContactDeal" FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_contact_deal_insert" ON "ContactDeal" FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_contact_deal_delete" ON "ContactDeal" FOR DELETE USING (auth.uid() IS NOT NULL);

-- ─── Step 4: Fix ChatMessage — replace allow-all with auth check ───
DROP POLICY IF EXISTS "Allow all for chat messages" ON "ChatMessage";

CREATE POLICY "auth_chat_message_all" ON "ChatMessage" FOR ALL USING (auth.uid() IS NOT NULL);

-- ============================================================
-- MANUAL STEPS (Supabase Dashboard):
-- 1. Storage → documents bucket → Settings → Toggle to PRIVATE
-- 2. Storage → Create new bucket 'avatars' → Set as PUBLIC
-- 3. Storage → Create new bucket 'org-logos' → Set as PUBLIC
-- 4. Authentication → Settings → Set minimum password length to 10
-- ============================================================
