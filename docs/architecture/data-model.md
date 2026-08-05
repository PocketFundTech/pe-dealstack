# Data Model

> Reference for the Supabase Postgres schema. The canonical ER diagram is [`docs/diagrams/07-er-diagram.mmd`](../diagrams/07-er-diagram.mmd). Last cross-checked against the live database schema on 2026-04-29.

All tables use UUID primary keys. Money values are stored according to `unitScale` (defaults to **MILLIONS** for financial statements).

## Tenancy

Every row is owned by an [`Organization`](#organization). Two scoping patterns:

- **Direct** — table has an `organizationId` FK column.
- **Indirect** — table is reached through a parent `Deal`; org access is verified by walking up.

| Pattern | Tables |
| --- | --- |
| Direct (12) | `User`, `Deal`, `Company`, `Contact`, `Task`, `Memo`, `MemoTemplate`, `Invitation`, `AuditLog`, `Notification`, `Watchlist` |
| Indirect via Deal | `Document`, `Folder`, `FolderInsight`, `Activity`, `FinancialStatement`, `DocumentChunk`, `DealTeamMember`, `ChatMessage`, `Conversation`, `MemoSection`, `MemoConversation`, `MemoChatMessage`, `MemoTemplateSection`, `ContactDeal`, `ContactInteraction`, `ContactRelationship` |

## Core entities

### Organization

The tenant root.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `name` | text | Firm name |
| `slug` | text unique | URL-safe |
| `logo`, `industry`, `website` | text | |
| `settings` | jsonb | Includes `firmProfile` (Firm Research Agent output) |
| `plan`, `maxUsers` | text, int | Billing tier — default `FREE` / 10 |
| `isActive` | boolean | Disable to lock out org |
| `createdBy` | uuid | |

### User

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | Internal user id |
| `authId` | uuid unique | **Supabase Auth UUID** — different from `id`. Always resolve via `authId` when matching session. |
| `email` | text unique | |
| `name`, `avatar`, `title`, `phone`, `department`, `firmName` | text | |
| `role` | text | Default `MEMBER`. Common values: `ADMIN`, `MEMBER`, `VIEWER`, `OPS`. (No DB CHECK — set by app.) |
| `organizationId` | uuid FK | |
| `isActive` | boolean | |
| `lastLoginAt` | timestamptz | |
| `preferences` | jsonb | UI prefs |
| `onboardingStatus` | jsonb | Default `{ steps: { createDeal: false, tryDealChat: false, uploadDocument: false, inviteTeamMember: false, reviewExtraction: false }, welcomeShown: false, checklistDismissed: false }` |

> **Gotcha**: the frontend sees `session.user.id` (Supabase Auth UUID), but the API's `User` table has its own `id`. Match via `authId` to bridge them.

### Deal

The unit of work. Owns documents, financials, activities, chats, memos.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `name`, `description` | text | |
| `companyId` | uuid FK | Target company (required) |
| `organizationId` | uuid FK | Tenant |
| `stage` | text | Default `INITIAL_REVIEW`. Values: `INITIAL_REVIEW` → `DUE_DILIGENCE` → `IOI_SUBMITTED` → `LOI_NEGOTIATION` → `CLOSING` → `CLOSED_WON`. Terminals: `CLOSED_LOST`, `PASSED`. (No DB CHECK — app-enforced.) |
| `status` | text | Default `ACTIVE`. Values: `ACTIVE`, `CLOSED_WON`, `CLOSED_LOST`, `PASSED` |
| `priority` | text | Default `MEDIUM`. Values: `LOW`, `MEDIUM`, `HIGH`, `URGENT` |
| `dealSize`, `revenue`, `ebitda`, `irrProjected`, `mom` | float | Numeric values (in millions per app convention) |
| `currency` | text | Default `USD` |
| `industry`, `source`, `icon` | text | |
| `assignedTo` | uuid FK → User | Lead |
| `targetCloseDate`, `actualCloseDate` | date | |
| `tags` | text[] | |
| `aiThesis` | text | LLM-generated thesis |
| `aiRisks` | jsonb | Risk extraction |
| `extractionConfidence`, `needsReview`, `reviewReasons` | int, boolean, jsonb | Set by ingest agent |
| `aiCacheUpdatedAt` | timestamptz | |
| `lastDocument`, `lastDocumentUpdated` | text, timestamptz | Cached for list views |
| `customFields` | jsonb | Bag for unmapped Deal-Import columns |

### Company

| Column | Notes |
| --- | --- |
| `name`, `industry`, `description`, `website`, `logo` | core fields |
| `headquarters`, `foundedYear`, `employeeCount`, `annualRevenue`, `linkedinUrl` | enrichment |
| `organizationId` | uuid FK |

Auto-created when Deal Import sees a new `companyName` (case-insensitive lookup, deduped per-batch).

### Contact / ContactInteraction / ContactDeal / ContactRelationship

`Contact` (org-scoped) — `firstName`, `lastName`, `email`, `phone`, `title`, `company`, `linkedinUrl`, `notes`, `tags`, `lastContactedAt`.

`Contact.type` CHECK ∈ `{BANKER, ADVISOR, EXECUTIVE, LP, LEGAL, OTHER}`.

`ContactInteraction.type` CHECK ∈ `{NOTE, MEETING, CALL, EMAIL, OTHER}` — title, description, date.

`ContactDeal.role` CHECK ∈ `{BANKER, ADVISOR, BOARD_MEMBER, MANAGEMENT, OTHER}` — pivots a contact onto a deal.

`ContactRelationship.type` CHECK ∈ `{KNOWS, REFERRED_BY, REPORTS_TO, COLLEAGUE, INTRODUCED_BY}` — contact↔contact graph (powers the network view).

Relationship score (0–100) is computed in `routes/contacts-insights.ts` from recency (40), frequency (40), deals (20). Cached client-side.

### Document

| Column | Notes |
| --- | --- |
| `dealId` | uuid FK — required (orphan documents vanish from VDR) |
| `folderId` | uuid FK — auto-assigned in `documents-upload.ts` if missing |
| `name`, `fileUrl`, `fileSize`, `mimeType` | core |
| `type` | text — default `OTHER` (no DB CHECK; app values: `CIM`, `TEASER`, `FINANCIAL`, `LEGAL`, `TAX`, `OTHER`) |
| `extractedData`, `extractedText`, `confidence` | jsonb, text, float |
| `aiAnalysis`, `aiAnalyzedAt` | jsonb, timestamptz |
| `tags`, `isHighlighted`, `status` | text[], boolean, text (default `pending`) |
| `embeddingStatus` | CHECK ∈ `{pending, processing, completed, failed}` — vector indexing state |
| `chunkCount`, `embeddedAt` | int, timestamptz |
| `uploadedBy` | uuid FK → User |

### Folder / FolderInsight

`Folder` is a self-referential tree (`parentId`). `isRestricted` toggles RBAC gating. `sortOrder` controls UI position. `fileCount` is denormalised for list views.

`FolderInsight` is generated by `services/folderInsightsGenerator.ts`:

- `summary` — text overview
- `completionPercent`
- `redFlags` — jsonb array
- `missingDocuments` — jsonb array

### FinancialStatement

The output of the Financial Agent.

| Column | Notes |
| --- | --- |
| `dealId`, `documentId` | FKs |
| `statementType` | CHECK ∈ `{INCOME_STATEMENT, BALANCE_SHEET, CASH_FLOW}` |
| `period` | text — e.g. `2023`, `Q1 2024`, `LTM Mar 2024` |
| `periodType` | CHECK ∈ `{HISTORICAL, PROJECTED, LTM}` |
| `lineItems` | jsonb — every revenue/cost/EBITDA/cash-flow line |
| `currency` | text — default `USD` |
| `unitScale` | CHECK ∈ `{MILLIONS, THOUSANDS, ACTUALS}` — default `MILLIONS` |
| `extractionConfidence` | int 0–100 (CHECK enforced) |
| `extractionSource` | CHECK ∈ `{gpt4o, azure, vision, manual}` |
| `extractedAt`, `reviewedAt`, `reviewedBy` | audit trail |
| `isActive` | boolean — partial unique index `WHERE isActive = true` enforces one active row per `(dealId, statementType, period)` |
| `mergeStatus` | CHECK ∈ `{auto, needs_review, user_resolved}` |

Every CHECK above is at the DB level — application bugs can't bypass them.

### DocumentChunk

Vector chunks of `extractedText`. Powers full-text search inside the deal chat agent's `search_documents` tool.

| Column | Notes |
| --- | --- |
| `documentId`, `dealId` | FKs |
| `chunkIndex`, `tokenCount` | int |
| `content` | text |
| `embedding` | **pgvector** column (USER-DEFINED type) |
| `metadata` | jsonb |

### Conversation / ChatMessage

Per-deal chat history.

`Conversation` — title and ownership for a chat thread on a deal (`dealId`, `userId`, `title`).

`ChatMessage` — `dealId`, `userId` (text), `role` CHECK ∈ `{user, assistant, system}`, `content`, `metadata` jsonb. Used by Deal Chat agent.

### Memo / MemoSection / MemoConversation / MemoChatMessage / MemoTemplate / MemoTemplateSection

`Memo` — `dealId`, `organizationId`, `title`, `projectName`, `sponsor`, `memoDate`, `version`, `createdBy`, `lastEditedBy`, `collaborators uuid[]`, `complianceChecked`, `complianceNotes`, `metadata`.

- `type` CHECK ∈ `{IC_MEMO, TEASER, SUMMARY, CUSTOM}`.
- `status` CHECK ∈ `{DRAFT, REVIEW, FINAL, ARCHIVED}`.

`MemoSection.type` CHECK ∈ **17** values: `EXECUTIVE_SUMMARY`, `COMPANY_OVERVIEW`, `FINANCIAL_PERFORMANCE`, `QUALITY_OF_EARNINGS`, `MARKET_DYNAMICS`, `COMPETITIVE_LANDSCAPE`, `MANAGEMENT_ASSESSMENT`, `OPERATIONAL_DEEP_DIVE`, `RISK_ASSESSMENT`, `DEAL_STRUCTURE`, `VALUE_CREATION`, `VALUE_CREATION_PLAN`, `EXIT_STRATEGY`, `EXIT_ANALYSIS`, `RECOMMENDATION`, `APPENDIX`, `CUSTOM`. Section status CHECK ∈ `{DRAFT, APPROVED, NEEDS_REVIEW}`. Carries `aiGenerated`, `aiModel`, `aiPrompt`, `citations` jsonb, `tableData` jsonb, `chartConfig` jsonb.

`MemoConversation` — chat thread scoped to a memo (`memoId`, `userId`, `title`).

`MemoChatMessage` — messages inside a `MemoConversation`. Role CHECK ∈ `{user, assistant, system}`.

`MemoTemplate` — `name`, `description`, `category` (default `INVESTMENT_MEMO`), `isGoldStandard`, `isLegacy`, `isActive`, `usageCount`, `permissions` (default `FIRM_WIDE`), `createdBy`, `organizationId`.

`MemoTemplateSection` — `templateId`, `title`, `description`, `aiEnabled`, `aiPrompt`, `mandatory`, `requiresApproval`, `sortOrder`.

### Activity

Timeline events on a deal.

| Column | Notes |
| --- | --- |
| `dealId`, `userId` | FKs |
| `type` | text — values include `NOTE_ADDED`, `CALL_LOGGED`, `MEETING_LOGGED`, `EMAIL_LOGGED`, `STAGE_CHANGED`, `DOCUMENT_UPLOADED`, `DOCUMENT_REQUESTED`, `DEAL_IMPORTED`, `DEAL_CREATED`, `MEMO_CREATED`, `EXTRACTION_TRIGGERED` (no DB CHECK) |
| `title`, `description`, `metadata` | text, text, jsonb |
| `scheduledAt`, `completedAt` | timestamptz — for upcoming/logged calls/meetings |
| `participants` | text[] |

### Notification

Per-user in-app alerts.

| Column | Notes |
| --- | --- |
| `userId`, `organizationId` | FKs |
| `type`, `title`, `message` | core |
| `dealId`, `documentId` | optional FKs for context |
| `isRead` | boolean |

### Invitation

| Column | Notes |
| --- | --- |
| `email`, `firmName` | text |
| `role` | CHECK ∈ `{ADMIN, MEMBER, VIEWER}` (no `OPS` here) |
| `invitedBy`, `organizationId` | FKs |
| `status` | CHECK ∈ `{PENDING, ACCEPTED, EXPIRED, REVOKED}` |
| `token` | unique |
| `expiresAt`, `acceptedAt` | timestamptz |

### DealTeamMember

Many-to-many `Deal ↔ User`.

| Column | Notes |
| --- | --- |
| `dealId`, `userId` | FKs |
| `role` | text — default `MEMBER` (free-text) |
| `accessLevel` | CHECK ∈ `{view, edit, admin}` — overlays the org role for sensitive deals |
| `addedAt` | timestamptz |

### Task

| Column | Notes |
| --- | --- |
| `title`, `description` | text |
| `status` | CHECK ∈ `{PENDING, IN_PROGRESS, COMPLETED, STUCK}` |
| `priority` | CHECK ∈ `{LOW, MEDIUM, HIGH, URGENT}` |
| `assignedTo`, `dealId`, `createdBy`, `organizationId` | FKs |
| `dueDate`, `firmName` | timestamptz, text |

### AuditLog

Append-only security/operations log.

| Column | Notes |
| --- | --- |
| `userId`, `organizationId` | FKs |
| `action`, `entityType`, `entityId`, `entityName`, `description` | core |
| `changes`, `metadata` | jsonb |
| `severity` | text — default `INFO` (values used by app: `INFO`, `WARNING`, `ERROR`, `CRITICAL`) |
| `ipAddress`, `userAgent`, `userEmail`, `userRole`, `requestId` | text |

> Schema uses `entityType` / `entityId` (not `resourceType` / `resourceId`).

### ApiKey

Machine-to-machine read-only API keys (`x-api-key` header auth).

| Column | Notes |
| --- | --- |
| `organizationId`, `createdBy` | FKs — key is org-scoped; requests act as VIEWER attributed to creator |
| `name` | display label |
| `keyHash` | SHA-256 of the raw key (unique) — raw key shown once at creation, never stored |
| `prefix` | first chars of raw key, for key lists |
| `scopes` | text[] — default `{read}` (GET-only); `write` reserved |
| `lastUsedAt`, `revokedAt` | lifecycle |

### Watchlist

Saved companies a firm wants to track without yet creating a deal.

| Column | Notes |
| --- | --- |
| `companyName`, `industry`, `notes` | text |
| `addedBy`, `organizationId` | FKs |

## AI Usage Tracking tables (added May 2026)

Four tables + three `User` columns added by the AI Usage Tracking system. See [`docs/AI-USAGE-TRACKING.md`](../AI-USAGE-TRACKING.md) for full DDL, seeded data, and usage details.

| Table | Purpose | FK targets |
|---|---|---|
| `UsageEvent` | Truth ledger — one row per AI call. Captures user, org, operation, model, provider, tokens, costUsd, credits, status, durationMs, metadata. | `User.id`, `Organization.id` |
| `ModelPrice` | Per-1M-token pricing reference (14+ models seeded). 10-min in-memory TTL cache. | — (lookup table) |
| `OperationCredits` | Operation label → user-facing credits mapping (29 ops seeded). Falls back to 1 credit + warn log for unknown ops. | — (lookup table) |
| `UsageAlert` | Dedup table for runaway-monitor alerts. Currently dormant (monitor was removed before shipping). | `User.id` |

`User` table additions:

| Column | Type | Purpose |
|---|---|---|
| `isInternal` | boolean default false | Pocket Fund team flag — grants `/internal/usage` access |
| `isThrottled` | boolean default false | Soft throttle: 1 req / 2s. Set via admin Leaderboard. |
| `isBlocked` | boolean default false | Hard kill-switch: all AI calls refuse with 403. Set via admin Leaderboard. |

## Migrations

Migration files live in [`apps/api/`](../../apps/api/) (e.g. `organization-migration.sql`, `onboarding-migration.sql`). Run on staging before production. See [`docs/DATABASE_MIGRATIONS.md`](../DATABASE_MIGRATIONS.md).

## Common gotchas

- **Auth UUID vs internal id.** Frontend session id ≠ `User.id`. Always join via `User.authId`.
- **Mixed period scales.** Charts must call `filterConsistentPeriods()` to avoid mixing annual totals with quarterly data.
- **`extractionSource` CHECK.** Will reject `'gpt4o-excel'` etc. Pick one of the four allowed values.
- **`unitScale` matters.** Don't assume millions — if a row has `unitScale = THOUSANDS`, charts must rescale.
- **`overflow-x-auto` clips dropdowns.** Not a data issue, but it bites every new engineer. Use `flex-wrap` instead.
- **`organizationId` on every query.** Forgetting `.eq('organizationId', orgId)` (or `verifyDealAccess`) is a tenancy bug. The integration tests in `tests/org-isolation.test.ts` exist to catch it — run them before merging.
- **Memo conversations are separate** from deal conversations. `MemoConversation`/`MemoChatMessage` are memo-scoped; `Conversation`/`ChatMessage` are deal-scoped. Don't conflate.
