# Avise - Database Migrations Guide

This document explains how to manage database schema changes in Avise using Supabase.

## Overview

Avise uses **Supabase PostgreSQL** as its database. Migrations are SQL files that should be run in the Supabase SQL Editor in a specific order.

## Migration Files Location

All migration files are located in `apps/api/`:

```
apps/api/
├── supabase-schema.sql      # 1. Core tables (Company, Deal, Document, Activity)
├── vdr-schema.sql           # 2. VDR tables (Folder, FolderInsight)
├── memo-schema.sql          # 3. Memo Builder tables (Memo, MemoSection, etc.)
├── audit-schema.sql         # 4. Audit logging (AuditLog)
├── ai-cache-migration.sql   # 5. AI cache columns on Deal
├── chat-history-migration.sql # 6. Chat history (ChatMessage)
├── ingest-migration.sql     # 7. Document ingestion queue (if exists)
└── prisma/
    └── migrations/          # Legacy Prisma migrations (reference only)
```

## Migration Execution Order

**IMPORTANT:** Run migrations in this exact order for a fresh database:

| Order | File | Description | Dependencies |
|-------|------|-------------|--------------|
| 1 | `supabase-schema.sql` | Core tables + seed data | None |
| 2 | `vdr-schema.sql` | VDR folders & insights | Deal table |
| 3 | `memo-schema.sql` | Memo builder tables | Deal, User tables |
| 4 | `audit-schema.sql` | Audit logging | User table |
| 5 | `ai-cache-migration.sql` | AI cache columns | Deal table |
| 6 | `chat-history-migration.sql` | Chat history | Deal, User tables |

## How to Run Migrations

### For Fresh Database Setup

1. **Go to Supabase Dashboard**
   - Navigate to: https://supabase.com/dashboard
   - Select your project

2. **Open SQL Editor**
   - Click "SQL Editor" in the left sidebar
   - Click "New Query"

3. **Run each migration in order:**
   ```
   1. Copy contents of supabase-schema.sql → Run
   2. Copy contents of vdr-schema.sql → Run
   3. Copy contents of memo-schema.sql → Run
   4. Copy contents of audit-schema.sql → Run
   5. Copy contents of ai-cache-migration.sql → Run
   6. Copy contents of chat-history-migration.sql → Run
   ```

4. **Verify each migration**
   After each migration, run this query to check tables exist:
   ```sql
   SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public'
   ORDER BY table_name;
   ```

### For Existing Database (Incremental)

If you already have a running database and need to apply new migrations:

1. **Check what tables exist:**
   ```sql
   SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public';
   ```

2. **Only run migrations for tables that don't exist**

3. **For ALTER TABLE migrations** (like `ai-cache-migration.sql`):
   - These use `IF NOT EXISTS` so they're safe to re-run

## Rollback Procedures

### Rolling Back a Table Creation

```sql
-- Example: Remove ChatMessage table
DROP TABLE IF EXISTS "ChatMessage" CASCADE;
```

### Rolling Back Column Additions

```sql
-- Example: Remove AI cache columns from Deal
ALTER TABLE "Deal" DROP COLUMN IF EXISTS "aiRisks";
ALTER TABLE "Deal" DROP COLUMN IF EXISTS "aiCacheUpdatedAt";
```

### Rolling Back VDR Tables

```sql
-- Remove VDR tables (in reverse order due to foreign keys)
DROP TABLE IF EXISTS "FolderInsight" CASCADE;
DROP TABLE IF EXISTS "Folder" CASCADE;
-- Remove columns from Document
ALTER TABLE "Document" DROP COLUMN IF EXISTS "folderId";
ALTER TABLE "Document" DROP COLUMN IF EXISTS "aiAnalysis";
ALTER TABLE "Document" DROP COLUMN IF EXISTS "aiAnalyzedAt";
ALTER TABLE "Document" DROP COLUMN IF EXISTS "tags";
```

### Rolling Back Memo Tables

```sql
DROP TABLE IF EXISTS "MemoChatMessage" CASCADE;
DROP TABLE IF EXISTS "MemoConversation" CASCADE;
DROP TABLE IF EXISTS "MemoSection" CASCADE;
DROP TABLE IF EXISTS "Memo" CASCADE;
```

### Nuclear Option (Full Reset)

**WARNING:** This deletes ALL data!

```sql
-- Drop all tables (use with extreme caution)
DROP TABLE IF EXISTS "MemoChatMessage" CASCADE;
DROP TABLE IF EXISTS "MemoConversation" CASCADE;
DROP TABLE IF EXISTS "MemoSection" CASCADE;
DROP TABLE IF EXISTS "Memo" CASCADE;
DROP TABLE IF EXISTS "FolderInsight" CASCADE;
DROP TABLE IF EXISTS "Folder" CASCADE;
DROP TABLE IF EXISTS "ChatMessage" CASCADE;
DROP TABLE IF EXISTS "AuditLog" CASCADE;
DROP TABLE IF EXISTS "Activity" CASCADE;
DROP TABLE IF EXISTS "Document" CASCADE;
DROP TABLE IF EXISTS "Deal" CASCADE;
DROP TABLE IF EXISTS "Company" CASCADE;
DROP TABLE IF EXISTS "User" CASCADE;

-- Drop functions
DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;
DROP FUNCTION IF EXISTS update_folder_timestamp() CASCADE;
DROP FUNCTION IF EXISTS create_default_vdr_folders(UUID) CASCADE;
DROP FUNCTION IF EXISTS auto_create_vdr_folders() CASCADE;
DROP FUNCTION IF EXISTS cleanup_old_audit_logs(INTEGER) CASCADE;
```

## Verification Queries

### Check All Tables

```sql
SELECT
  table_name,
  (SELECT COUNT(*) FROM information_schema.columns c
   WHERE c.table_name = t.table_name) as column_count
FROM information_schema.tables t
WHERE table_schema = 'public'
ORDER BY table_name;
```

### Check Specific Table Columns

```sql
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'Deal'  -- Replace with table name
ORDER BY ordinal_position;
```

### Check Indexes

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;
```

### Check Row Counts

```sql
SELECT
  'Company' as table_name, COUNT(*) as row_count FROM "Company"
UNION ALL
SELECT 'Deal', COUNT(*) FROM "Deal"
UNION ALL
SELECT 'Document', COUNT(*) FROM "Document"
UNION ALL
SELECT 'Activity', COUNT(*) FROM "Activity"
UNION ALL
SELECT 'Folder', COUNT(*) FROM "Folder"
UNION ALL
SELECT 'Memo', COUNT(*) FROM "Memo";
```

## AI Usage Tracking Migrations (May 2026)

| Order | File | Description |
|-------|------|-------------|
| — | `apps/api/usage-tracking-migration.sql` | Creates `UsageEvent`, `ModelPrice`, `OperationCredits`, `UsageAlert` tables; adds `isInternal`/`isThrottled`/`isBlocked` to `User`; seeds 14 model prices + 13 canonical operations; seeds `isInternal=true` for Pocket Fund team emails. |
| — | `apps/api/usage-tracking-addendum.sql` | Adds 16 additional `OperationCredits` rows (granular `invokeStructured` labels + Gemini embedding ops); adds `claude-haiku-4-5-20251001` to `ModelPrice`. Run after the main migration. |

Both files are idempotent. Run addendum after migration. See [`docs/AI-USAGE-TRACKING.md`](AI-USAGE-TRACKING.md) for full details.

---

## Best Practices

### 1. Always Use IF NOT EXISTS / IF EXISTS

```sql
-- Good: Safe to re-run
CREATE TABLE IF NOT EXISTS "MyTable" (...);
ALTER TABLE "MyTable" ADD COLUMN IF NOT EXISTS "newColumn" TEXT;
DROP TABLE IF EXISTS "MyTable";

-- Bad: Will error if already exists
CREATE TABLE "MyTable" (...);
```

### 2. Test Migrations Locally First

Before running on production:
1. Create a new Supabase project for testing
2. Run all migrations
3. Verify the application works
4. Then apply to production

### 3. Backup Before Major Changes

```sql
-- Create a backup table before destructive changes
CREATE TABLE "Deal_backup_20260205" AS SELECT * FROM "Deal";
```

### 4. Use Transactions for Complex Migrations

```sql
BEGIN;
  -- Multiple related changes
  ALTER TABLE "Deal" ADD COLUMN "newField" TEXT;
  UPDATE "Deal" SET "newField" = 'default';
  ALTER TABLE "Deal" ALTER COLUMN "newField" SET NOT NULL;
COMMIT;
-- If anything fails, ROLLBACK instead
```

### 5. Document Changes

When creating new migrations:
1. Add a comment header with date and purpose
2. Update this document
3. Update LAUNCH-CHECKLIST.md if applicable

## Creating New Migrations

When you need to add a new migration:

1. **Create the SQL file:**
   ```
   apps/api/YYYYMMDD-description-migration.sql
   ```

2. **Add header comment:**
   ```sql
   -- Migration: Add [feature name]
   -- Date: YYYY-MM-DD
   -- Author: [name]
   -- Description: [what this migration does]

   -- Your SQL here
   ```

3. **Use safe patterns:**
   - `IF NOT EXISTS` for CREATE
   - `IF EXISTS` for DROP
   - `ON CONFLICT DO NOTHING` for INSERT

4. **Add verification query at the end:**
   ```sql
   -- Verify migration
   SELECT column_name FROM information_schema.columns
   WHERE table_name = 'YourTable';
   ```

5. **Update this document** with the new migration

## Troubleshooting

### "relation already exists"
The table already exists. Use `CREATE TABLE IF NOT EXISTS`.

### "column does not exist"
Check the column name casing. Supabase uses camelCase with quotes:
- Correct: `"dealId"` (with quotes)
- Wrong: `dealId` (without quotes becomes lowercase)

### "foreign key constraint violation"
Run migrations in the correct order. Parent tables must exist first.

### "permission denied"
Check RLS policies. For development, you can temporarily disable:
```sql
ALTER TABLE "TableName" DISABLE ROW LEVEL SECURITY;
```

---

*Last Updated: February 5, 2026*
