# API Test Failure Triage

**Date:** 2026-05-18
**Phase / Task:** Phase 2 Task 2.2 of `.planning/REMEDIATION_ROADMAP.md`
**Baseline:** 11 failed / 775 passed / 34 skipped (constant across recent commits)
**Result:** 0 failed / 776 passed / 44 skipped

This document dispositions the 11 pre-existing failures so they no longer block
CI gating (Task 2.1). The goal is to surface real issues honestly while
unblocking the CI workflow.

## Summary Table

| # | File / Test | Classification | Action Taken | Notes |
|---|-------------|----------------|--------------|-------|
| 1 | `tests/db-optimizations.test.ts > Performance indexes migration > should have the migration file` | Stale test (file references hypothetical migration that was never authored) | `describe.skip` with explanation in the test file | See "DB Optimizations" below |
| 2 | `tests/db-optimizations.test.ts > ... should create Deal indexes` | Same as #1 (cascading ENOENT) | Skipped via parent `describe.skip` | — |
| 3 | `tests/db-optimizations.test.ts > ... should create Company name index` | Same as #1 | Skipped via parent | — |
| 4 | `tests/db-optimizations.test.ts > ... should create Document indexes` | Same as #1 | Skipped via parent | — |
| 5 | `tests/db-optimizations.test.ts > ... should create Activity index` | Same as #1 | Skipped via parent | — |
| 6 | `tests/db-optimizations.test.ts > ... should create AuditLog indexes` | Same as #1 | Skipped via parent | — |
| 7 | `tests/db-optimizations.test.ts > ... should create Memo index` | Same as #1 | Skipped via parent | — |
| 8 | `tests/db-optimizations.test.ts > ... should create DocumentChunk indexes for RAG` | Same as #1 | Skipped via parent | — |
| 9 | `tests/db-optimizations.test.ts > ... should use IF NOT EXISTS for all indexes` | Same as #1 | Skipped via parent | — |
| 10 | `tests/db-optimizations.test.ts > ... should reference trigram extension in comments` | Same as #1 | Skipped via parent | — |
| 11 | `tests/financial-validator.test.ts > validateFinancials > should flag very low revenue` | Stale test — code policy intentionally changed | Updated assertion to match current code | See "Financial Validator" below |
| 12 (file) | `tests/org-isolation.test.ts` (whole suite) | Integration test — requires real Supabase | Gated behind `RUN_INTEGRATION_TESTS=1` env var | See "Org Isolation" below |

The optimistic-locking sub-describe inside `tests/db-optimizations.test.ts` was
NOT skipped and continues to run (5 tests, all passing).

---

## DB Optimizations (Failures 1–10)

### The problem

`tests/db-optimizations.test.ts` opens with:

```ts
const migrationPath = path.join(__dirname, '../prisma/migrations/add_performance_indexes.sql');
```

That path does not exist. There is no `prisma/migrations/` directory under
`apps/api/` — this project does not use Prisma migrations; it uses manually
authored `apps/api/*.sql` files applied to Supabase by hand (per the codebase
convention documented in `MEMORY.md` and `project_supabase_migrations.md`).

The test also asserts the migration creates indexes named:
`idx_deal_status`, `idx_deal_stage`, `idx_deal_created`, `idx_company_name`,
`idx_doc_deal`, `idx_doc_status`, `idx_activity_deal`, `idx_audit_action`,
`idx_audit_entity`, `idx_audit_user`, `idx_audit_time`, `idx_memo_deal`,
`idx_chunk_deal`, `idx_chunk_doc`.

None of these are in the actual performance migration recently authored as
part of Phase 5 Task 5.5
(`apps/api/performance-indexes-migration.sql`). That file adds:
`idx_user_authid`, `idx_notification_user_unread`,
`idx_notification_user_created`, `idx_task_deal`,
`idx_task_assignedto_status`, `idx_auditlog_org_created`.

The actual SQL file's own comment block explicitly lists every index the test
expects under "Indexes deliberately NOT added (already exist elsewhere)" —
they were authored in earlier migrations (`supabase-schema.sql`,
`vdr-schema.sql`, `memo-schema.sql`, `contacts-migration.sql`, etc.).

### Why this is stale, not a real bug

The test was written aspirationally — describing a single canonical
"all performance indexes" SQL file that was never produced because the indexes
were already scattered across feature migrations as those features landed.
Asserting on a non-existent file blocks the suite without surfacing any real
defect.

### Action taken

Marked the `Performance indexes migration` describe with `describe.skip` and
added a multi-paragraph comment explaining the situation and pointing to this
triage document. The optimistic-locking sub-suite in the same file continues
to run normally (5 tests, all green).

### Follow-up (optional)

If we want a canonical "list of every performance index expected in
production" assertion, the right path is to either:

1. Generate that list at runtime by reading `pg_indexes` against a test
   Supabase project, or
2. Author a `performance-indexes-canonical.sql` aggregator and update the test
   to point at it.

Both are design decisions beyond the scope of Phase 2 Task 2.2.

---

## Financial Validator (Failure 11)

### The problem

```
tests/financial-validator.test.ts > validateFinancials > should flag very low revenue
AssertionError: expected true to be false
```

The test asserted that `revenue: 0.05` (= $50,000 in the millions-unit
convention used throughout the codebase) should trigger `isValid: false`.

The code (`apps/api/src/services/financialValidator.ts`, line 64–67) only
flags revenue when it is greater than 0 and less than `0.0001` (= $100).
$50K revenue is intentionally allowed.

### Why this is stale, not a real bug

Confirmed via git blame:

- Original threshold (commit `680adb2`): `data.revenue < 0.1` (i.e. flag below
  $100K).
- Current threshold (commit `ebd4440`, `fix(core): resolve invitation user
  lookup bugs and implement cascading deal deletion UI/API`): `data.revenue <
  0.0001` (i.e. flag below $100), with the explicit code comment:

  > Only flag if less than $100 — micro-acquisitions with $1K+ revenue are valid

  The warning message also changed from "too low" to "extremely low".

The test was not updated when the policy changed.

### Action taken

Updated the test to:

- Use `revenue: 0.00005` ($50, below the new $100 threshold).
- Assert the warning contains `'extremely low'` (current wording).
- Added an inline comment explaining the policy and pointing at commit
  `ebd4440`.

This is a test correction, not a behavior change. The product behavior
(micro-acquisitions valid) is preserved.

---

## Org Isolation (Failure 12 — whole suite)

### The problem

```
FAIL tests/org-isolation.test.ts [ tests/org-isolation.test.ts ]
Error: Login failed for ganeshjagtap006@gmail.com: fetch failed
```

The suite calls real Supabase auth (`supabase.auth.signInWithPassword`) in
`beforeAll`. There is no Supabase reachable in CI and no `TEST_ORG_A_*` /
`TEST_ORG_B_*` credentials configured. The file header itself documents the
prerequisites:

```ts
// Prerequisites:
//   1. API server running: cd apps/api && npm run dev
//   2. .env.test file with test credentials (see .env.test.example)
```

This is an integration test, not a unit test.

### Action taken

Gated the entire suite behind `RUN_INTEGRATION_TESTS=1`:

```ts
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === '1'
  || process.env.RUN_INTEGRATION_TESTS === 'true';
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;
```

Both top-level `describe` blocks were converted to `describeIntegration`. The
`beforeAll` short-circuits with `if (!RUN_INTEGRATION) return;` so it does not
attempt to log in when the flag is off.

CI sees the file as one skipped suite. Developers running with credentials
locally can opt in:

```
RUN_INTEGRATION_TESTS=1 npx vitest run tests/org-isolation.test.ts
```

---

## Net effect on the suite

Before:

```
Test Files  3 failed | 65 passed (68)
     Tests  11 failed | 775 passed | 34 skipped (820)
```

After:

```
Test Files  67 passed | 1 skipped (68)
     Tests  776 passed | 44 skipped (820)
```

No source code was modified. All changes are in `apps/api/tests/`. The suite
is now ready for CI gating (Task 2.1).
