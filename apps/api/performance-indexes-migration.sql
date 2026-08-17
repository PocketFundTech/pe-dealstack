-- ============================================================
-- Performance Indexes Migration
-- Refs: .planning/REMEDIATION_ROADMAP.md Phase 5 Task 5.5
--       .planning/codebase/ARCHITECT_REVIEW.md
--
-- Adds indexes on hot Supabase columns that get hit by every
-- authenticated request or by org-scoped list queries. Without
-- these indexes, every `.eq('xxx', y)` filter on these columns
-- degrades to a sequential scan as the tables grow.
--
-- All statements use `CREATE INDEX IF NOT EXISTS` and are
-- idempotent. Safe to re-run.
--
-- To apply (manual migration, per project convention):
--   psql "$SUPABASE_DB_URL" -f apps/api/performance-indexes-migration.sql
-- Or paste into the Supabase SQL editor.
--
-- Note on CONCURRENTLY: This file runs as a single transaction
-- (psql -f). CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block, so it is omitted here. Each statement
-- acquires a brief ShareLock on the target table. That is fine
-- for the table sizes we have today.
--
-- For very large tables (>1M rows) — none currently — copy the
-- specific statement out, drop the IF NOT EXISTS shell, and run
-- it standalone with CONCURRENTLY to avoid the lock:
--   CREATE INDEX CONCURRENTLY idx_foo ON "Foo"("bar");
-- ============================================================

BEGIN;

-- ============================================================
-- User.authId — hit on EVERY authenticated request
-- orgScope middleware does `SELECT ... FROM "User" WHERE "authId" = ?`
-- to resolve the internal User row from the Supabase auth UUID.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_authid
  ON public."User" ("authId");

-- ============================================================
-- Notification — unread count and per-user list
-- Routes: GET /notifications (filter by isRead), GET /notifications/unread-count
-- ============================================================

-- Partial index for the unread badge / unread-count endpoint.
CREATE INDEX IF NOT EXISTS idx_notification_user_unread
  ON public."Notification" ("userId") WHERE "isRead" = false;

-- Per-user notification list ordered by recency.
CREATE INDEX IF NOT EXISTS idx_notification_user_created
  ON public."Notification" ("userId", "createdAt" DESC);

-- ============================================================
-- Task — per-deal task list + "my tasks" view
-- Routes: GET /deals/:id/tasks, GET /tasks?assignedTo=...&status=...
-- (idx_task_org already exists from organization-migration.sql)
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_task_deal
  ON public."Task" ("dealId");

CREATE INDEX IF NOT EXISTS idx_task_assignedto_status
  ON public."Task" ("assignedTo", status);

-- ============================================================
-- AuditLog — composite for the audit log viewer with date range
-- Routes: GET /audit-export, GET /admin/audit-log
-- The existing idx_auditlog_org and idx_auditlog_createdat exist
-- as separate single-column indexes, but the common query is
-- "give me the last N audit log entries for org X", which is best
-- served by a composite (org, createdAt DESC).
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_auditlog_org_created
  ON public."AuditLog" ("organizationId", "createdAt" DESC);

COMMIT;

-- ============================================================
-- Verification queries (run these after migration to confirm)
-- ============================================================
-- SELECT indexname FROM pg_indexes
--  WHERE schemaname = 'public'
--    AND indexname IN (
--      'idx_user_authid',
--      'idx_notification_user_unread',
--      'idx_notification_user_created',
--      'idx_task_deal',
--      'idx_task_assignedto_status',
--      'idx_auditlog_org_created'
--    );
-- -- Expect 6 rows.

-- ============================================================
-- Indexes deliberately NOT added (already exist elsewhere)
-- ============================================================
-- Deal.organizationId           -> idx_deal_org (organization-migration.sql)
-- Deal.companyId/stage/status   -> idx_deal_* (supabase-schema.sql)
-- Document.dealId/folderId/type -> idx_document_* (vdr-schema.sql)
-- Folder.dealId/parentId/sortOrder -> idx_folder_* (vdr-schema.sql)
-- Activity.dealId/createdAt     -> idx_activity_* (supabase-schema.sql)
-- ChatMessage.dealId + composite-> idx_chat_message_* (chat-history-migration.sql)
-- FinancialStatement.dealId     -> idx_financial_statement_deal_id (financial-statement-migration.sql)
-- User.organizationId/firmName  -> idx_user_org, idx_user_firm_name (organization-migration.sql)
-- User.isInternal/Throttled/Blocked -> idx_user_* (usage-tracking-migration.sql)
-- UsageEvent.(userId,createdAt) -> idx_usage_event_user_created (usage-tracking-migration.sql)
-- UsageEvent.(orgId,createdAt)  -> idx_usage_event_org_created (usage-tracking-migration.sql)
-- DealTeamMember.dealId/userId  -> idx_deal_team_member_* (team-sharing-migration.sql)
-- Contact.organizationId/etc.   -> idx_contact_* (contacts-migration.sql, organization-migration.sql)
-- Memo.dealId/status/orgId      -> idx_memo_* (memo-schema.sql, memo-org-migration.sql)
-- MemoSection.memoId            -> idx_memosection_memoId (memo-schema.sql)
-- Invitation.org/status/token   -> idx_invitation_* (invitation-migration.sql, organization-migration.sql)
-- Task.organizationId           -> idx_task_org (organization-migration.sql)
-- Notification.organizationId   -> idx_notification_org (organization-migration.sql)
-- AuditLog.organizationId       -> idx_auditlog_org (audit-schema.sql)
-- AuditLog.createdAt            -> idx_auditlog_createdat (audit-schema.sql)
-- Conversation.dealId           -> N/A: no Conversation table; ChatMessage.dealId is used.
