# PE OS — Build Spec: Doc Requests · NDA Redlining · Deal Reactivation · Model Export

**Author:** Ganesh (founder/eng) · **Date:** 2026-08-18 · **Baseline commit:** `ff52973` on `main`
**Status:** approved for build · **Scope:** four features, built in the order below

---

## 0. How to use this document

You are the implementing session. This document is the source of truth for *what* to build and *why*.

**Before writing any code:**
1. Read `AGENTS.md` (repo root) and `.planning/codebase/CONVENTIONS.md`.
2. Read §2 of this document — **Non-negotiable engineering constraints**. Every one of them exists because it broke production once.
3. Read the "Reuse map" for the feature you're starting. Those files are working implementations of 80% of what you need. Follow their patterns rather than inventing new ones.
4. Build **one feature per branch, one PR each**, in the order given in §7.

**What this document does not do:** it doesn't dictate variable names, component decomposition, or test structure beyond the acceptance criteria. Use the surrounding code's judgment. Where this spec and an existing repo pattern conflict, the repo pattern wins — and flag the conflict in the PR.

**If a requirement here turns out to be wrong or impossible,** stop and say so in the PR description. Do not silently narrow scope.

---

## 1. Why these four

### The product

PE OS is an AI-powered deal-management platform for private-equity buyers — independent sponsors, first-fund PE firms, and search funds in the US lower middle market. Typical customer: **2–4 people, no analysts, 15–50 CIMs/month**, currently running on Gmail + Excel + Dropbox + a free HubSpot seat. Their alternative to us is working Saturdays.

The value unit is the **deal**, not the seat. Pricing is firm-level tiers with a deal-analysis allowance ($299 Sponsor / $999 Fund / $2,500+ Firm). See `docs/plans/2026-07-04-beachhead-pricing-gtm.md`.

### The evidence base

These four features were selected by re-reading all 19 demo calls (`.planning/demo-research/demo-calls.md`), the Pascal beta-user action plan (`docs/PASCAL-FEEDBACK-ACTION-PLAN.md`), and the GTM doc, then diffing every ask against what already ships on `main`.

**Already shipped — do not rebuild:**

| Ask | Where it lives |
|---|---|
| Deal filtering/scoring (the #1 repeated ask) | `services/agents/dealScorecard/`, `routes/deals-scorecard.ts` |
| Client portal / external deal sharing | `routes/deals-share.ts`, `routes/portal.ts`, `/portal/[token]` |
| Teaser go/no-go vs firm criteria | `routes/firm-teaser.ts`, `routes/organization-criteria.ts` |
| Gmail / Outlook / Drive / Calendar / Granola / M365 | `src/integrations/*` |
| Persistent per-deal AI memory | `routes/deals-chat*.ts` |
| Memo generation + rubric grading | `routes/memos-*.ts`, `services/agents/memoAgent/` |
| NDA *generation* + e-sign | `routes/legal-documents.ts`, `services/legalDoc*.ts`, `/nda` |
| Security posture (audit logs, org isolation, trust page) | `routes/audit*.ts`, `routes/admin-security*.ts`, `/security` |

**The pattern in what's left:** the screening half of the funnel is done. Every remaining high-value gap sits *after* the user decides a deal is interesting. That's the thread connecting all four features below.

### The four, and the evidence for each

**1 · Document Request & Seller Upload Portal** — the product tells you in 30 seconds which documents are missing, then abandons you. The user emails the broker manually, chases for a week, and hand-uploads whatever arrives.
> Pascal (beta user, Tier-1 BUILD): *"The bottleneck is the quality of information the seller can provide me. Brokers didn't even ask for the balance sheet."*
> Julian, M17: *"Blocking 4 hrs/wk manually requesting missing docs from CIMs."*
> Christopher, M13: *"Waiting a month for add-back data from a seller."*
> Peter, M19: *"Respond to broker in 2–3 days, across 15–20 deals/mo."*

**2 · NDA Redlining** — we built NDA *generation*, but ~90% of NDAs a buyer signs are the broker's paper. Reviewing incoming counterparty paper is untouched.
> Daniel, M4 (closest-to-perfect ICP): *"30 min manual, up to 5x/day = 2.5 hrs/day. Upload NDA → system knows our criteria → outputs redlined."*
> **This is the largest single time-saving figure quoted in any of the 19 calls.**

**3 · Deal Reactivation Engine** — a passed deal is currently a dead card in a column nobody opens. The CRM gets *less* valuable as it fills up. It should get more valuable.
> Aryamaan, M8 (Beco Capital, $1B): invests in 4 of 1,500/yr. *"The other 1,496 still matter — a passed company might raise again in 2 years."*
> Martin, M14: *"Searchers reject deals that become attractive in 6–12 months. A 4/10 deal becomes an 8/10. No tool does this."*

**4 · Financial Model / Valuation Export to Excel** — the customer's actual deliverable to their IC and their lender is a spreadsheet. We produce prose, and the extraction's value gets discarded at the last step.
> Evan, M15: *"A model, not text — a Google-Sheets-like UI he + partner can see and edit. Plug in own metrics (WACC, DSCR, custom multiples)."*
> Himanshu, M11: *"Teams doing DD on 40 deals/mo need model output, not just text."*
> **Asked unprompted in three separate calls.**

### Explicitly out of scope

- **Transaction comps** (Trevor M3, Julian M12) — real demand, but it's a data-licensing problem, not an engineering one. Answering it from LLM training memory is exactly the contamination failure Julian M12 called trust-breaking and would contradict our published grounding stance. Parked until there's a data source.
- **Deal sourcing / discovery** (Stian, Jeroen, Martin, Binbin) — a different product.
- **LP dashboard, tax-analysis module, voice input, multi-model QoE** — real but lower leverage than these four.

---

## 2. Non-negotiable engineering constraints

Each of these caused a production incident. Violating one costs a day of debugging.

### 2.1 Serverless bundle parity — the single most expensive mistake in this repo

`apps/api/src/app.ts` is **dev-only**. Production runs one of two compiled bundles: `app-lite.ts` or `app-ai.ts`, selected per-request by `pickBundle()` in `apps/web-next/src/lib/api-routing.ts`, proxied through `apps/web-next/src/app/api/[...slug]/route.ts`.

**A route mounted only in `app.ts` works locally and 404s in production.** This happened on 2026-08-14 to six routers at once (`deals-scorecard`, `deals-share`, `portal`, `organization-criteria`, `cron-signal-scan`, `managed-agents-webhooks`).

For every new router you must:
1. Mount it in `app.ts` (dev).
2. Mount it in `app-lite.ts` **and/or** `app-ai.ts` — matching what `pickBundle()` will choose for its path.
3. If the path needs the **ai** bundle and isn't already covered, add it to `api-routing.ts`. Current ai-bundle rules: `/api/ai/*`, `/api/deals/:id/{chat,generate-thesis,analyze-risks,ai-cache,conversations,financials,scorecard}`, `/api/documents/:id/extract-financials`, `/api/conversations*`, `/api/memos/*`, `/api/ingest*`, `/api/onboarding*`, `/api/cron/*`, `/api/webhooks/managed-agents*`. Everything else → **lite**.
4. Run `apps/api/tests/bundle-route-parity.test.ts` — it pins the invariant. Add a case to `apps/web-next/src/lib/api-bundles.test.ts` for any new `pickBundle` rule.

### 2.2 Express mounts specific-before-generic

`routes/deals-list.ts` has a `/:id` catch-all. Any new `/api/deals/...` router with a literal path segment (`/:dealId/doc-requests`, `/:dealId/model`) **must be mounted before `dealsRouter`** in all three app files. See the existing ordered mounts in `app-lite.ts` (`dealAccessTimelineRouter`, `dealsFinancialsTimeseriesRouter`, `dealsShareRouter`, `dealsTeasersRouter`, then `dealsRouter`) and copy the comment style.

### 2.3 Migrations are manual

Vercel does **not** run `apps/api/*.sql`. Every schema change is a new idempotent `.sql` file in `apps/api/`, applied by hand in the Supabase SQL editor. Convention: header comment with the apply command, `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, never drop a data-bearing column. Model on `apps/api/deal-share-migration.sql`.

**Every PR that adds a migration must say so in bold in the description**, with the file path — otherwise the endpoint 500s in prod after merge.

### 2.4 RLS backstop on every new table

The browser holds a Supabase anon key. Every new tenant table gets `ALTER TABLE "X" ENABLE ROW LEVEL SECURITY;` **with no policies** — the Express API uses the service role and bypasses RLS, so the anon key sees zero rows. This is mandatory for any table holding tokens. See the tail of `deal-share-migration.sql`.

### 2.5 Org scoping

Every authenticated route resolves org via `getOrgId(req)` and validates deal ownership via `verifyDealAccess(dealId, orgId)` from `middleware/orgScope.js`. Never trust a `dealId` from the client without it. Never add `organizationId` filtering in JS after an unfiltered fetch — filter at the DB layer (see the F-2 fix comment in `routes/documents-alerts.ts`).

### 2.6 All LLM calls go through `trackedClaudeMessage`

`apps/api/src/services/ai/client.ts`. Never construct an Anthropic client directly.

```ts
const result = await trackedClaudeMessage({
  operation: 'nda_review',        // UsageEvent ledger name — always set
  role: 'chat',                    // 'extraction' | 'chat' | 'fast' | 'memo'
  system: SYSTEM_PROMPT,
  messages: [{ role: 'user', content: userPrompt }],
  outputSchema: MY_JSON_SCHEMA,    // forces structured output
  maxTokens: 4000,
});
const parsed = JSON.parse(result.text);
```

Known traps already handled inside the client — do not re-introduce them:
- Never pass `signal` as a body field (it 400s every call — prod incident 2026-08-14).
- Never send an empty `betas` array (empty `anthropic-beta` header → 400).
- Never send an explicit `thinking` config (Fable 5 rejects it).

Race a client-side timeout the way `services/agents/dealScorecard/index.ts` does.

### 2.7 Grounding

Any agent reading a user-supplied document must answer **only** from that document. This is a customer-facing commitment (Julian M12 called mixing training data with uploaded docs trust-breaking, and our `/security` page states the position). Where a finding quotes source text, **verify the quote is a verbatim substring of the parsed document before persisting it**, and drop or flag findings that fail. Feature 2 specifies this concretely.

### 2.8 Style and structure

- Files under 500 lines. Split when they grow.
- Routes are thin: validate → call service → respond. Logic lives in `services/`.
- API imports are relative with explicit `.js`; web-next imports use `@/`.
- Zod for every request body. `log` from `utils/logger.js`, never `console`.
- UI: Banker Blue `#003366`, white cards, Inter, `#F8F9FA` background, subtle shadows. Never dark surfaces, never `bg-slate-900`.
- Conventional commits: `feat(doc-requests):`, `fix(nda):`.
- Type-check both apps before pushing: `cd apps/api && npx tsc --noEmit`, `cd apps/web-next && npx tsc --noEmit`.
- Tests: `vitest`, in `apps/api/tests/` and co-located in web-next. There are ~148 API test files — match their style.

---

## 3. Feature 1 — Document Request & Seller Upload Portal

**Branch:** `feat/doc-requests` · **Estimate:** ~1 week · **Migration:** yes

### 3.1 User story

> As a deal partner, when the AI tells me the balance sheet and customer concentration are missing, I click **Request documents**, pick or edit a checklist, and send it to the broker. The broker gets an email with a link, drops files onto a page with no login, and the files land in that deal's data room and start extracting. I can see at a glance which items have arrived and nudge on the ones that haven't.

### 3.2 Scope

**In:** checklist templates + custom items; tokenized public upload page; email delivery via Resend; per-item fulfilment tracking; owner-side status view; revoke; reminder email (manual button + a daily cron nudge).

**Out (v1):** two-way messaging with the broker; seller-side accounts; e-signature on the request; AI-generated per-deal checklists (v1 uses static templates + hand-editing — see §3.8).

### 3.3 Reuse map — read these first

| File | What to take from it |
|---|---|
| `apps/api/src/routes/deals-share.ts` | The **exact** shape of this feature's owner side: `crypto.randomBytes(32).toString('hex')` token, expiry, revoke-by-timestamp, `Activity` insert, null-safe Resend send, `portalBaseUrl()` from `APP_URL`. |
| `apps/api/src/routes/portal.ts` | The **exact** shape of the public side: `resolveShare()` returning 404 unknown / 410 revoked-or-expired, strict payload whitelist, fire-and-forget view logging. |
| `apps/api/deal-share-migration.sql` | Migration + RLS-backstop template. |
| `apps/api/src/routes/documents-upload.ts` | `handleDocumentUpload()` is described in-file as *"the single source of truth for 'a document was added to a deal' — do not fork it."* The seller upload path must reuse it (validation, Supabase storage, dedup, PDF/Excel extraction, deep financial pass, VDR folder assignment, RAG embedding, activity/audit/notifications). The Google Drive import route already reuses it by synthesizing a multer-style `req.file`; do the same. |
| `apps/api/src/services/fileValidator.ts` | `validateFile`, `sanitizeFilename`, `ALLOWED_MIME_TYPES`. |
| `apps/web-next/src/app/portal/[token]/page.tsx` | The public-page shell: unauthenticated layout, token fetch, 404/410 states. |
| `apps/api/src/routes/cron-signal-scan.ts` | Cron route shape: `Bearer ${process.env.CRON_SECRET}` check, org batching. |

### 3.4 Data model

New file `apps/api/doc-request-migration.sql`:

```sql
-- DocRequest — a structured document ask sent to a broker/seller,
-- fulfilled through a tokenized public upload page.
CREATE TABLE IF NOT EXISTS "DocRequest" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId"         uuid NOT NULL REFERENCES "Deal"(id) ON DELETE CASCADE,
  "organizationId" uuid NOT NULL,
  token            text NOT NULL UNIQUE,     -- 32-byte crypto-random hex
  "recipientEmail" text,
  "recipientName"  text,
  message          text,                     -- optional note shown on the page
  status           text NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN','PARTIAL','FULFILLED','CANCELLED')),
  "createdBy"      text,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "expiresAt"      timestamptz,
  "revokedAt"      timestamptz,
  "lastRemindedAt" timestamptz,
  "completedAt"    timestamptz
);
CREATE INDEX IF NOT EXISTS "DocRequest_dealId_idx" ON "DocRequest"("dealId");
CREATE INDEX IF NOT EXISTS "DocRequest_org_status_idx" ON "DocRequest"("organizationId", status);

CREATE TABLE IF NOT EXISTS "DocRequestItem" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "requestId"  uuid NOT NULL REFERENCES "DocRequest"(id) ON DELETE CASCADE,
  label        text NOT NULL,               -- "3-year P&L"
  "docType"    text,                        -- maps to Document.type enum where known
  notes        text,
  required     boolean NOT NULL DEFAULT true,
  "sortOrder"  integer NOT NULL DEFAULT 0,
  "documentId" uuid REFERENCES "Document"(id) ON DELETE SET NULL,
  "fulfilledAt" timestamptz
);
CREATE INDEX IF NOT EXISTS "DocRequestItem_requestId_idx" ON "DocRequestItem"("requestId");

-- View/activity log for the public page (mirrors DealShareView).
CREATE TABLE IF NOT EXISTS "DocRequestEvent" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "requestId" uuid NOT NULL REFERENCES "DocRequest"(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('VIEWED','UPLOADED','COMPLETED')),
  "itemId"    uuid REFERENCES "DocRequestItem"(id) ON DELETE SET NULL,
  "userAgent" text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "DocRequestEvent_requestId_idx" ON "DocRequestEvent"("requestId");

ALTER TABLE "DocRequest"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocRequestItem"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocRequestEvent" ENABLE ROW LEVEL SECURITY;
```

### 3.5 Checklist templates

New `apps/api/src/services/docRequestTemplates.ts` — a typed constant, no DB, no migration. Four templates, each a list of `{label, docType, required, notes}`:

- **`STANDARD_DD`** — 3-year P&L; Balance sheet (latest + 2 prior year-ends); Cash flow statement; Trailing-12 monthly P&L; Add-back / normalization schedule; Customer concentration (top 10 by revenue); Revenue by product or service line; Headcount roster by function; AR/AP aging; Tax returns (3 years); Equipment / fixed asset list; Lease agreements; Owner compensation detail.
- **`FINANCIALS_ONLY`** — the first six of the above.
- **`QOE_PREP`** — bank statements (12 months); payment-processor settlement reports; revenue recognition policy; deferred-revenue schedule; inventory detail; related-party transactions.
- **`LEGAL_CORPORATE`** — cap table; org chart / entity structure; material contracts; litigation history; insurance certificates; key licences and permits.

The create endpoint accepts either `templateKey` (expanded server-side) or an explicit `items[]`, so the UI can pre-fill from a template and let the user edit before sending.

### 3.6 API surface

**Owner side** — new `apps/api/src/routes/deals-doc-requests.ts`, mounted on `/api/deals` **before `dealsRouter`** in `app.ts` + `app-lite.ts` (lite bundle: no `pickBundle` change needed).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/deals/:dealId/doc-requests` | Body: `{ templateKey? , items?: [{label, docType?, required?, notes?}], recipientEmail?, recipientName?, message?, expiresInDays? }`. Creates request + items, generates token, sends email when `recipientEmail` and Resend are both present. Returns `{ request, items, url }`. |
| `GET` | `/api/deals/:dealId/doc-requests` | List with items, fulfilment counts, view count, last-viewed. |
| `POST` | `/api/deals/:dealId/doc-requests/:id/remind` | Re-sends the email; stamps `lastRemindedAt`. 429 if reminded within 24h. |
| `PATCH` | `/api/deals/:dealId/doc-requests/:id` | Edit items / message on an open request. |
| `DELETE` | `/api/deals/:dealId/doc-requests/:id` | Soft revoke (`revokedAt`). |

**Public side** — new `apps/api/src/routes/doc-request-portal.ts`, mounted at `/api/public/doc-requests` **without auth middleware**, next to the existing `/api/public/portal` mount, in `app.ts` + `app-lite.ts`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/:token` | Returns the checklist + which items are fulfilled + deal display name + requesting firm name + message. **Strict whitelist — see §3.7.** Logs a `VIEWED` event fire-and-forget. |
| `POST` | `/:token/items/:itemId/upload` | `multipart/form-data`, single file. Validates, uploads via the shared document pipeline, links `Document.id` onto the item, stamps `fulfilledAt`, logs `UPLOADED`, recomputes request status. |
| `POST` | `/:token/complete` | Marks `completedAt`, logs `COMPLETED`, notifies the deal team. |

Token resolution mirrors `portal.ts` exactly: unknown → **404** `"This link is not valid."`, revoked/expired → **410**.

### 3.7 Security requirements (do not compromise)

- The public `GET /:token` payload is a **strict whitelist**: deal name, company name, requesting org name, the request message, and the item list (label / docType / notes / required / fulfilled-boolean). **Never** include financials, documents, memos, scorecard, internal notes, team members, or any id other than item ids. Put a module-level comment saying so, matching `portal.ts`.
- Uploads run the full `validateFile` magic-byte check and `sanitizeFilename`, and are capped at 50 MB and 25 files per request.
- Apply a stricter rate limit to the public upload route than the general `/api/` limiter.
- The upload path must not leak whether a given `itemId` exists on another request — 404 both cases.
- Storage path must be namespaced by the deal, exactly as `handleDocumentUpload` already does. Externally-sourced documents should be distinguishable in the audit log (record the request id in the audit metadata).

### 3.8 Missing-document suggestion (small, high-demo-value)

When opening the request modal, pre-check items that appear absent for the deal: compare the `docType`/label set against existing `Document` rows and extracted `FinancialStatement` coverage (e.g. no `BALANCE_SHEET` rows → pre-check "Balance sheet"). **Deterministic logic, no LLM call.** If it can't be done cleanly in the time budget, ship the plain template picker — this is an enhancement, not a requirement.

### 3.9 Reminders cron

New `apps/api/src/routes/cron-doc-request-reminders.ts` mounted at `/api/cron/doc-request-reminders` (`pickBundle` already routes `/api/cron/*` → **ai**, so mount in `app-ai.ts` + `app.ts`). Auth: `Bearer ${process.env.CRON_SECRET}`.

Logic: find `DocRequest` rows where `status IN ('OPEN','PARTIAL')`, not revoked, not expired, `createdAt` older than 3 days, and (`lastRemindedAt` null or older than 5 days) → send one reminder email, stamp `lastRemindedAt`. Cap reminders at 3 per request, then stop. Add the schedule to root `vercel.json` `crons` (e.g. `"0 8 * * *"`).

### 3.10 Frontend

**Owner side** — inside the existing **Documents** tab on the deal page (do *not* add a new top-level tab; `TABS` in `deal-detail-shared.ts` is deliberately short):
- A "Request documents" primary button in the documents toolbar.
- Modal: template picker → editable checklist (add/remove/rename rows) → recipient email + name + optional message → expiry → Send.
- A "Requests" panel listing open/closed requests with per-item status chips (Waiting / Received), view count, last viewed, **Copy link**, **Remind**, **Revoke**.

**Public page** — new `apps/web-next/src/app/upload/[token]/page.tsx`, modeled on `/portal/[token]/page.tsx`. Unauthenticated, mobile-friendly (brokers open links on phones), branded with the requesting firm's name. Per-item drag-and-drop with progress and clear success state; a "Send" / "I'm done" button that calls `/complete`. Must degrade gracefully to 404/410 screens.

### 3.11 Tests

- Unit: token resolution (valid / unknown / revoked / expired), status recomputation across item fulfilment, template expansion, reminder eligibility windows.
- Security: public `GET /:token` payload contains **no** key outside the whitelist — assert the exact key set, so a future field addition fails the test loudly. Mirror `apps/api/tests/` naming.
- Route parity + `pickBundle` tests updated for the new cron path.

### 3.12 Acceptance

A broker who has never heard of PE OS receives an email, opens one link on a phone, drops three PDFs, and those PDFs appear in the deal's data room with extraction already running — with no account, no password, and nothing else about the deal visible to them.

---

## 4. Feature 2 — NDA Redlining

**Branch:** `feat/nda-review` · **Estimate:** ~1.5–2 weeks · **Migration:** yes

### 4.1 User story

> As a buyer, I receive the broker's NDA. I drop it into PE OS. Within a minute I see: our firm's position on each clause, which clauses in *this* NDA deviate from it, how badly, the exact quoted language that's a problem, and suggested replacement wording I can paste into my reply. What used to take 30 minutes takes two.

### 4.2 Scope

**In:** a firm NDA playbook (org-level, editable); upload or select an existing deal document; clause-by-clause review against the playbook with verbatim source quotes; severity ranking; suggested replacement language; a persisted review record; copy-to-clipboard and an annotated HTML/print export.

**Out (v1) — state this in the PR:** generating a `.docx` **with Word tracked changes**. That needs a docx-writing dependency and revision-mark plumbing we don't have (`mammoth` is docx→html only; `legalDocExportService` round-trips through Google Drive and requires a connected Google account — do **not** reuse it here). v1 ships the in-app review plus copyable language and a print-ready annotated view. Tracked-changes docx is a fast follow.

### 4.3 Reuse map — read these first

| File | What to take from it |
|---|---|
| `apps/api/src/services/agents/dealScorecard/index.ts` | **The template for this whole service.** Structured-output JSON schema constant, system prompt with explicit grounding rules, `trackedClaudeMessage` call, raced timeout with `clearTimeout` in `finally`, persist-then-return, typed custom error class. Copy this structure. |
| `apps/api/src/services/legalDocParseService.ts` | `parseTemplateFile(buffer, kind)` handles `docx` / `html` / `md` / `pdf` → sanitized HTML; `sanitiseLegalDocHtml`; `LegalDocParseError`. Use it — do not write another parser. |
| `apps/api/src/services/legalDocImportService.ts` | How an externally-produced NDA is accepted, validated, and inserted today. Same entry shape. |
| `apps/api/src/routes/organization-criteria.ts` | The **exact** pattern for storing firm-level config in `Organization.settings.<key>` with a Zod schema and no migration. The NDA playbook uses this. |
| `apps/api/src/routes/legal-documents.ts` + `apps/web-next/src/app/(app)/nda/page.tsx` | The existing NDA module and its view state machine — the review flow is a new mode in it, not a new page. |

### 4.4 The firm NDA playbook

Stored at `Organization.settings.ndaPlaybook` — **no migration**, same pattern as `settings.dealCriteria`. New router `apps/api/src/routes/organization-nda-playbook.ts` with `GET` / `PATCH /api/organizations/nda-playbook`, mounted before the generic `organizationsRouter` (§2.2).

```ts
const ndaClausePositionSchema = z.object({
  key: z.string(),                    // stable id, e.g. 'term'
  label: z.string().max(200),         // "Term of agreement"
  ourPosition: z.string().max(2000),  // "2 years from signature"
  acceptable: z.string().max(2000).optional(),  // "18-36 months"
  dealBreaker: z.boolean().default(false),
  fallbackLanguage: z.string().max(4000).optional(),
});

const ndaPlaybookSchema = z.object({
  positions: z.array(ndaClausePositionSchema).max(40).default([]),
  generalNotes: z.string().max(4000).default(''),
});
```

Ship a **default playbook** (`services/ndaPlaybookDefaults.ts`) so the feature works before anyone configures anything — seeded read-time exactly like `organization-criteria.ts` seeds from `firmProfile`, persisting nothing. Default clause keys: `term`, `confidentiality_period`, `definition_of_confidential_info`, `permitted_disclosures`, `non_solicit_employees`, `non_circumvent`, `residuals`, `return_or_destruction`, `governing_law`, `standstill`, `no_obligation`, `remedies_injunctive`, `assignment`, `notice`. Each with a buy-side-market default position.

### 4.5 Data model

New `apps/api/nda-review-migration.sql`:

```sql
CREATE TABLE IF NOT EXISTS "NdaReview" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId"         uuid REFERENCES "Deal"(id) ON DELETE CASCADE,   -- nullable: firm-level review
  "organizationId" uuid NOT NULL,
  "documentId"     uuid REFERENCES "Document"(id) ON DELETE SET NULL,
  "sourceFileName" text,
  "sourceHtml"     text NOT NULL,        -- sanitized parse output (the grounding corpus)
  findings         jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary          text,
  "riskLevel"      text CHECK ("riskLevel" IN ('LOW','MEDIUM','HIGH')),
  "playbookSnapshot" jsonb,              -- playbook as-of review time (audit trail)
  model            text,
  "reviewedAt"     timestamptz NOT NULL DEFAULT now(),
  "createdBy"      text
);
CREATE INDEX IF NOT EXISTS "NdaReview_dealId_idx" ON "NdaReview"("dealId");
CREATE INDEX IF NOT EXISTS "NdaReview_org_idx"    ON "NdaReview"("organizationId");

ALTER TABLE "NdaReview" ENABLE ROW LEVEL SECURITY;
```

### 4.6 The review agent

New `apps/api/src/services/agents/ndaReview/index.ts`, structured exactly like `dealScorecard/index.ts`.

Output schema:

```ts
const NDA_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    riskLevel: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    summary: { type: 'string' },       // 2-3 sentences a partner can read in 10 seconds
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          clauseKey:   { type: 'string' },
          clauseTitle: { type: 'string' },
          status: { type: 'string',
                    enum: ['MISSING', 'ACCEPTABLE', 'DEVIATION', 'DEAL_BREAKER'] },
          severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
          quotedText: { type: 'string' },        // VERBATIM from the NDA, or "" if MISSING
          whyItMatters: { type: 'string' },
          playbookPosition: { type: 'string' },
          suggestedLanguage: { type: 'string' }, // "" when ACCEPTABLE
        },
        required: ['clauseKey','clauseTitle','status','severity','quotedText',
                   'whyItMatters','playbookPosition','suggestedLanguage'],
      },
    },
  },
  required: ['riskLevel', 'summary', 'findings'],
};
```

System prompt requirements — state each explicitly:
- Review **only** the NDA text provided. Never rely on knowledge of this counterparty, this firm, or NDAs seen elsewhere. If a clause is absent, return `MISSING` — never infer what it "probably" says.
- `quotedText` must be copied **verbatim and contiguously** from the provided document. Never paraphrase, never reconstruct.
- Produce one finding per playbook position, plus findings for clauses present in the NDA but absent from the playbook (`clauseKey: "unmapped"`).
- `DEAL_BREAKER` only when the playbook marks the position `dealBreaker` **and** the NDA violates it.
- `suggestedLanguage` must be drafting-ready text the user can paste, not a description of what to change.

**Grounding verification (mandatory, §2.7):** after parsing the model's JSON, for every finding with `status !== 'MISSING'`, normalize whitespace and assert `quotedText` is a substring of the plain-text projection of `sourceHtml`. Findings that fail get `quoteVerified: false` and their quote suppressed in the UI. **Log a warning with the review id and clause key on every failure** — that rate is the health metric for this feature. Do not silently drop.

Role: `'chat'`. Operation: `'nda_review'`. `maxTokens` ~8000. Timeout raced client-side (~60s; NDAs are longer than scorecard inputs), overridable via `NDA_REVIEW_TIMEOUT_MS`.

### 4.7 API surface

New `apps/api/src/routes/nda-review.ts`. These paths are AI-bundle work: `/api/deals/:id/nda-reviews` is **not** covered by the current `AI_DEAL_SUFFIX_RE` — add `nda-reviews` to that alternation in `apps/web-next/src/lib/api-routing.ts`, add a case to `apps/web-next/src/lib/api-bundles.test.ts`, and mount the router in `app-ai.ts` + `app.ts` (before `dealsRouter`).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/deals/:dealId/nda-reviews` | Multipart file **or** `{ documentId }` for a doc already in the VDR. Parses → reviews → persists → returns the full review. |
| `GET` | `/api/deals/:dealId/nda-reviews` | List (summary fields only). |
| `GET` | `/api/nda-reviews/:id` | Full review incl. findings. Org-scoped. |
| `GET` | `/api/nda-reviews/:id/export` | Annotated HTML (print-to-PDF friendly). |

Error contract: parse failure → 400 with `LegalDocParseError`'s code; `AIRefusalError` → 422, not 500; timeout → 504.

### 4.8 Frontend

Extend `apps/web-next/src/app/(app)/nda/page.tsx`'s existing `View` state machine with a `reviewIncoming` mode — the file already documents its modes at the top; add yours there in the same comment block. Keep the page under 500 lines by extracting the review UI into sibling components (`NdaReviewFlow.tsx`, `NdaReviewReport.tsx`), matching how `CreateDocModal` / `UploadExistingFlow` are already split out.

Report layout:
- Header: risk level chip, one-line summary, source filename, reviewed-at, deal link.
- Findings sorted `DEAL_BREAKER` → `DEVIATION` → `MISSING` → `ACCEPTABLE`, then by severity. Collapse `ACCEPTABLE` by default.
- Each finding card: clause title · status chip · quoted NDA language (monospace, in a bordered block, with an "unverified quote" warning when `quoteVerified: false`) · our playbook position · why it matters · suggested language with a **Copy** button.
- Playbook editor lives in Settings, reachable from an inline "Edit playbook" link on the report.

### 4.9 Tests

- Agent: mock `trackedClaudeMessage`; assert schema is passed, timeout is raced and cleared, refusals map to the right error.
- **Grounding: a fabricated `quotedText` that does not appear in the source must be marked unverified — this is the highest-value test in the feature.**
- Playbook Zod round-trip; default seeding when unset.
- Route: 400 on unparseable file, 404 on cross-org deal, `pickBundle('/api/deals/x/nda-reviews')` → `'ai'`.

### 4.10 Acceptance

A user with no configuration uploads a real broker NDA and, in under 60 seconds, gets a ranked list of what deviates from a sensible buy-side default — with every quoted phrase actually present in their document — plus paste-ready replacement language.

---

## 5. Feature 3 — Deal Reactivation Engine

**Branch:** `feat/deal-reactivation` · **Estimate:** ~1 week · **Migration:** yes

### 5.1 User story

> I pass on a deal and record *why*, plus when to look again. Months later — when new financials arrive, when I change my criteria, or when the revisit date lands — PE OS re-scores it automatically and tells me: *"Meridian Logistics: 4/10 → 8/10. EBITDA up 40%, now inside your size range."* My passed pile becomes a pipeline instead of a graveyard.

### 5.2 Scope

**In:** structured pass (reason + revisit date); scorecard history; four re-score triggers; a reactivation record with old→new diff; notification + dashboard surface; dismiss.

**Out (v1):** the company-vs-deal layer architecture change (Aryamaan M8) — genuinely needed eventually, but it's a schema migration across the whole app and must not be smuggled into this feature. `CLOSED_LOST` deals are out of scope; **`PASSED` only** in v1.

### 5.3 Reuse map — read these first

| File | What to take from it |
|---|---|
| `apps/api/src/services/agents/dealScorecard/index.ts` | `scoreDeal(dealId, orgId)` is the engine — **call it, don't reimplement scoring**. Also note `maybeScoreAfterExtraction()`: the never-throws, silent-no-op post-extraction hook. Your financial-update trigger is its sibling. |
| `apps/api/src/routes/organization-criteria.ts` | `PATCH /criteria` is where the criteria-changed trigger fires. |
| `apps/api/src/routes/cron-signal-scan.ts` | Cron auth + org batching (`BATCH_SIZE = 5`, `Promise.all` per batch, `captureAgentError` per failure). |
| `apps/api/src/routes/notifications.ts` | `createNotification()` and `notifyDealTeam()`. |
| `apps/web-next/src/lib/constants.ts` | `STAGES` — `PASSED` already exists; no stage enum change needed. |

### 5.4 Data model

New `apps/api/deal-reactivation-migration.sql`:

```sql
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "passReason"       text;
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "passedAt"         timestamptz;
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "revisitAt"        date;
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "lastRescoredAt"   timestamptz;
ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "scorecardHistory" jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS "DealReactivation" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId"         uuid NOT NULL REFERENCES "Deal"(id) ON DELETE CASCADE,
  "organizationId" uuid NOT NULL,
  trigger          text NOT NULL
                     CHECK (trigger IN ('FINANCIALS_UPDATED','CRITERIA_CHANGED','REVISIT_DUE','MANUAL')),
  "previousScore"   integer,
  "newScore"        integer,
  "previousVerdict" text,
  "newVerdict"      text,
  delta            jsonb,       -- { gainedReasons: [...], resolvedMisses: [...], note: "..." }
  status           text NOT NULL DEFAULT 'NEW'
                     CHECK (status IN ('NEW','SEEN','ACTED','DISMISSED')),
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "seenAt"         timestamptz
);
CREATE INDEX IF NOT EXISTS "DealReactivation_org_status_idx"
  ON "DealReactivation"("organizationId", status);
CREATE INDEX IF NOT EXISTS "DealReactivation_dealId_idx" ON "DealReactivation"("dealId");
CREATE INDEX IF NOT EXISTS "Deal_revisit_idx"
  ON "Deal"("organizationId", "revisitAt") WHERE stage = 'PASSED';

ALTER TABLE "DealReactivation" ENABLE ROW LEVEL SECURITY;
```

`scorecardHistory` entries: `{ score, verdict, scoredAt, model, trigger }` — append the *outgoing* scorecard on each re-score; cap the array at 20 entries.

### 5.5 Service

New `apps/api/src/services/agents/dealReactivation/index.ts`:

```ts
export type ReactivationTrigger =
  'FINANCIALS_UPDATED' | 'CRITERIA_CHANGED' | 'REVISIT_DUE' | 'MANUAL';

/** Re-score one PASSED deal and record a reactivation if it materially improved.
 *  Never throws — callers piggyback on user-facing requests. */
export async function rescorePassedDeal(
  dealId: string, orgId: string, trigger: ReactivationTrigger
): Promise<{ reactivated: boolean; newScore?: number }>;

/** Batched sweep over one org's eligible PASSED deals. */
export async function sweepPassedDeals(
  orgId: string, trigger: ReactivationTrigger
): Promise<{ scanned: number; rescored: number; reactivated: number }>;
```

`rescorePassedDeal` logic:
1. Load deal; bail unless `stage === 'PASSED'`.
2. Snapshot the current `Deal.scorecard` as `previous`.
3. Call `scoreDeal(dealId, orgId)` (it persists `Deal.scorecard` itself).
4. Append `previous` to `scorecardHistory`; stamp `lastRescoredAt`.
5. **Reactivation fires when** `newScore - previousScore >= REACTIVATION_DELTA` (default **15**, env `REACTIVATION_MIN_DELTA`) **or** verdict moved `NO_GO → BORDERLINE|GO` **or** `BORDERLINE → GO`.
6. On fire: insert `DealReactivation` with a `delta` diffing the two `reasons` arrays (which `miss` entries disappeared, which `hit` entries are new), and `notifyDealTeam`.
7. No previous scorecard → score it, record no reactivation (nothing to compare).

### 5.6 Eligibility gate — read this before writing the cron

**Do not re-score every passed deal on every run.** A firm with 300 passed deals would burn 300 LLM calls a day and blow through the tier's deal allowance. A deal is eligible only when at least one is true:

- **`FINANCIALS_UPDATED`** — a `FinancialStatement` row for the deal has `createdAt`/`updatedAt` newer than `lastRescoredAt`.
- **`CRITERIA_CHANGED`** — the org's `dealCriteria` changed after `Deal.scorecard.scoredAt`. (`PATCH /criteria` currently persists no timestamp — **add `updatedAt` into the stored `dealCriteria` object** in `routes/organization-criteria.ts` as part of this feature.)
- **`REVISIT_DUE`** — `revisitAt <= today`.
- **`MANUAL`** — user pressed the button; always eligible.

Additionally: hard floor of **14 days** between automatic re-scores of the same deal, and a per-org cap of **25 automatic re-scores per cron run** (log when the cap truncates a sweep — see §2 / no-silent-caps).

### 5.7 Trigger wiring

1. **Financials updated** — wherever `maybeScoreAfterExtraction` is called today, add the sibling path: if the deal is `PASSED`, call `rescorePassedDeal(..., 'FINANCIALS_UPDATED')` instead. Same never-throws contract; must never affect the extraction response.
2. **Criteria changed** — in `PATCH /api/organizations/criteria`, after a successful save, fire a background sweep. Do not block the response.
3. **Revisit due** — new `apps/api/src/routes/cron-reactivation.ts` at `/api/cron/reactivation` (auto-routed to the **ai** bundle by the existing `/api/cron/*` rule; mount in `app-ai.ts` + `app.ts`). Add a `vercel.json` cron entry, e.g. `"0 7 * * *"`.
4. **Manual** — `POST /api/deals/:dealId/rescore`.

### 5.8 API surface

New `apps/api/src/routes/deals-reactivations.ts`, mounted on `/api/deals` **before `dealsRouter`**.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/deals/reactivations` | Org-wide feed, `status=NEW` by default. **Literal segment before `/:id` — mount order matters.** |
| `POST` | `/api/deals/:dealId/rescore` | Manual re-score. Returns the new scorecard + whether it reactivated. |
| `PATCH` | `/api/deals/:dealId/reactivations/:id` | `{ status: 'SEEN' \| 'ACTED' \| 'DISMISSED' }`. |

Also extend the existing deal-update Zod schema in `routes/deals-mutate.ts` to accept `passReason` and `revisitAt`, and stamp `passedAt` when `stage` transitions to `PASSED`.

Note `/api/deals/:id/rescore` runs an LLM call: add `rescore` to `AI_DEAL_SUFFIX_RE` in `api-routing.ts` and mount the router in `app-ai.ts` as well. (`GET /api/deals/reactivations` is a plain read and stays in lite — mount that router in **both** bundles and keep the handlers in one file; the bundle-parity test only requires presence in at least one, but split routing here means it must be in both.)

### 5.9 Frontend

- **Pass flow:** moving a deal to `PASSED` (kanban drag or stage dropdown) opens a small modal — reason (free text + quick chips: *Too small · Too expensive · Wrong sector · Customer concentration · Owner not ready · Lost to another buyer*) and "Look again in…" (3 / 6 / 12 months / never / custom date). Skippable, but shown by default.
- **Dashboard widget** — "Worth revisiting" listing `status='NEW'` reactivations: deal name, `4/10 → 8/10` delta chip, one-line reason from `delta`, and Open / Dismiss. Follow the existing widget patterns in `apps/web-next/src/app/(app)/dashboard/widgets/`.
- **Deals page** — a "Revisit due" filter, and `revisitAt` shown on passed-deal cards.
- **Deal page** — passed deals show pass reason, revisit date, scorecard history sparkline, and a "Re-score now" button.
- **Notification** on reactivation, via the existing bell.

### 5.10 Tests

- Delta threshold and verdict-crossing logic (table-driven; include the "no previous scorecard" case).
- **Eligibility gate: an ineligible deal must not produce an LLM call.** Assert the mocked `scoreDeal` was not called.
- 14-day floor and per-org cap, including that truncation is logged.
- `scorecardHistory` append + 20-entry cap.
- `rescorePassedDeal` swallows a thrown `scoreDeal` and returns `{reactivated:false}`.
- Cron auth rejects a missing/wrong `CRON_SECRET`.

### 5.11 Acceptance

Pass a deal with a 3-month revisit date; upload improved financials; the deal reappears in "Worth revisiting" with an accurate old→new delta and a human-readable reason — and a firm with 300 passed deals and no new data generates **zero** LLM calls on a cron run.

---

## 6. Feature 4 — Financial Model / Valuation Excel Export

**Branch:** `feat/model-export` · **Estimate:** ~2–3 weeks · **Migration:** yes · **New dependency:** `exceljs`

### 6.1 User story

> The extraction already knows this business's three years of revenue, EBITDA, and margins. I set my assumptions — entry multiple, leverage, growth, exit — and download a real `.xlsx`: historicals, projections, returns, and a sensitivity table, where every derived cell is a **live Excel formula** pointing at an Assumptions tab. My partner opens it, changes the exit multiple, and the IRR updates. That's the file I send my lender.

### 6.2 Scope

**In:** an assumptions schema with sensible defaults derived from extracted financials; persistence of assumptions per deal; a formula-live multi-sheet workbook generator; download from the deal page.

**Out (v1):** an in-app spreadsheet grid editor; PowerPoint export; debt waterfalls beyond a single senior tranche; monthly granularity (annual only).

### 6.3 The one thing that makes this feature real

**Every derived cell must be a live Excel formula referencing the Assumptions sheet.** A workbook of hard-coded computed values is worthless — the entire ask (Evan M15) is that he and his partner can change an input and watch the model respond. If you find yourself writing `cell.value = revenue * margin`, stop: it should be `cell.value = { formula: 'Projections!C5*Assumptions!$B$12' }`.

### 6.4 Reuse map — read these first

| File | What to take from it |
|---|---|
| `apps/api/src/routes/deals-financials-timeseries.ts` | **Your input data.** It already projects `FinancialStatement.lineItems` (snake_case, inconsistent presence) into clean camelCase `FinancialRow`s sorted chronologically, computing derived margins. Reuse its projection helpers rather than re-reading raw `lineItems`. |
| `apps/api/financial-statement-migration.sql` | The `FinancialStatement` shape: `lineItems` JSONB, `currency`, **`unitScale` ∈ MILLIONS/THOUSANDS/ACTUALS**, `periodType` ∈ HISTORICAL/PROJECTED/LTM, `isActive`. |
| `apps/api/src/utils/periodChrono.ts` | `comparePeriodChronologically` — period strings are `"2023"`, `"LTM"`, `"2025E"`, not dates. |
| `apps/api/src/routes/legal-documents.ts` (`/legal-documents/:id/export`) | Proof that returning a binary through the Next.js → Express proxy works, and the header/disposition pattern to copy. |

### 6.5 Correctness traps (these will silently produce a wrong model)

1. **Units.** `AGENTS.md` says values are stored in millions USD, but `FinancialStatement.unitScale` exists and a `financial-statement-billions-migration.sql` shipped. **Normalize every row to a single scale before building the workbook, and stamp the scale on the Assumptions sheet and in every sheet header** ("$ in millions"). A model that silently mixes thousands and millions is worse than no model.
2. **Currency.** Read `FinancialStatement.currency`; don't assume USD. Label it, and refuse to mix currencies across periods — surface an error instead.
3. **Period types.** Only `HISTORICAL` and `LTM` rows belong in Historicals. Never feed a `PROJECTED` row in as history.
4. **Missing periods.** Gaps are normal. Render the gap explicitly rather than shifting rows.
5. **`isActive`.** Only `isActive = true` statements. There's a partial unique index enforcing one active statement per period per type — respect it.

### 6.6 Data model

New `apps/api/deal-model-migration.sql`:

```sql
CREATE TABLE IF NOT EXISTS "DealModel" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId"         uuid NOT NULL REFERENCES "Deal"(id) ON DELETE CASCADE,
  "organizationId" uuid NOT NULL,
  name             text NOT NULL DEFAULT 'Base case',
  assumptions      jsonb NOT NULL,
  "createdBy"      text,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "updatedAt"      timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("dealId", name)
);
CREATE INDEX IF NOT EXISTS "DealModel_dealId_idx" ON "DealModel"("dealId");
ALTER TABLE "DealModel" ENABLE ROW LEVEL SECURITY;
```

### 6.7 Assumptions schema

New `apps/api/src/services/dealModel/assumptions.ts` — Zod schema plus `deriveDefaults(financialRows)`:

```ts
{
  // Entry
  entryMultiple: number,                 // e.g. 5.5
  entryBasis: 'EBITDA' | 'REVENUE',
  transactionFeesPct: number,            // % of EV
  // Capital structure
  debtQuantumMode: 'MULTIPLE' | 'ABSOLUTE',
  debtQuantum: number,                   // xEBITDA or absolute
  interestRate: number,                  // %
  amortPctPerYear: number,               // % of original principal
  cashSweepPct: number,                  // % of FCF to debt paydown
  // Operating projections (length = projectionYears)
  projectionYears: number,               // default 5
  revenueGrowthPct: number[],
  ebitdaMarginPct: number[],
  capexPctRevenue: number,
  nwcPctRevenue: number,
  taxRate: number,
  daPctRevenue: number,
  // Exit & discounting
  exitMultiple: number,
  exitYear: number,
  wacc: number,                          // for the DCF cross-check
  dscrTarget: number,                    // Evan M15 asked for this by name
  // Presentation
  unitScale: 'MILLIONS' | 'THOUSANDS',
  currency: string,
}
```

`deriveDefaults` seeds from extracted data where possible — latest-year revenue/EBITDA, trailing CAGR for growth (capped to something sane), the latest EBITDA margin held flat, entry multiple defaulted from `Deal.evMultiple` when present. Defaults must be *reasonable*, never invented precision; keep the derivation deterministic (no LLM).

### 6.8 Workbook

New `apps/api/src/services/dealModel/workbook.ts` using `exceljs` (add to `apps/api/package.json`; note `xlsx@0.18.5` is already a dep but its community build can't do the cell styling this needs — use `exceljs`, and don't remove `xlsx`, it's used by extraction).

Sheets, in order:

1. **Cover** — deal name, company, date generated, currency + unit scale, list of source documents the financials came from, and a plain-English disclaimer that this is a model built from extracted data and must be verified against source documents.
2. **Assumptions** — every input from §6.7, one cell each, **blue font for input cells** (the banking convention), named ranges or a stable `$B$n` layout. This is the only sheet a user edits.
3. **Historicals** — one column per historical period: revenue, COGS, gross profit, opex, EBITDA, D&A, net income, plus margin rows. Include a "Source" column naming the document/period each figure came from.
4. **Projections** — `projectionYears` columns. Every cell a formula off Historicals + Assumptions. Revenue = prior × (1+growth); EBITDA = revenue × margin; then D&A, EBIT, taxes, capex, ΔNWC → unlevered FCF.
5. **Returns** — sources & uses, entry EV and equity cheque, debt schedule (opening/interest/amort/sweep/closing), DSCR by year against `dscrTarget`, exit EV at `exitMultiple`, equity proceeds, **IRR (`=IRR(...)`) and MoM as real formulas.**
6. **Sensitivity** — a 2-way grid, entry multiple (rows) × exit multiple (columns) → IRR, built as formulas so it recalculates.
7. **Notes** — extraction confidence per statement, any periods that were missing, and any red flags already produced by the financial analysis for this deal.

Formatting: Inter/Calibri, `#,##0.0` for currency, `0.0%` for percentages, `0.0x` for multiples, bold section headers, frozen header rows, column widths set, no gridline noise. It should look like a banker built it.

### 6.9 API surface

New `apps/api/src/routes/deals-model.ts`, mounted on `/api/deals` **before `dealsRouter`** in `app.ts` + `app-lite.ts` (no `pickBundle` change — `/api/deals/:id/model` is not in `AI_DEAL_SUFFIX_RE`, so it lands in **lite**, which is correct: there's no LLM call here).

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/deals/:dealId/model` | Saved assumptions, or `deriveDefaults()` output when none saved, plus the historical rows the model will use. |
| `PUT` | `/api/deals/:dealId/model` | Save/update assumptions. |
| `POST` | `/api/deals/:dealId/model/export` | Returns the `.xlsx` binary. `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `Content-Disposition: attachment; filename="<deal>-model.xlsx"`. Audit-log the export. |

Guard: if the deal has no active `HISTORICAL`/`LTM` income statements, return **400** with an actionable message ("Extract financials for this deal before building a model") rather than emitting an empty workbook.

### 6.10 Frontend

In the deal page's **Financials** area (`deal-financials.tsx` and siblings), add a "Build model" panel:
- Assumption inputs grouped as Entry · Capital structure · Operating · Exit, pre-filled from `GET`, with units and a live preview of entry EV / equity cheque / implied IRR so the user gets feedback before downloading.
- **Download .xlsx** primary button; Save assumptions secondary.
- Empty state when extraction hasn't run, linking to the extraction flow.

Keep new components in their own files — the deal-financials directory is already large and the 500-line cap applies.

### 6.11 Tests

- `deriveDefaults` against fixture financial rows, including gaps, LTM-only, and a single-year deal.
- **Unit normalization: a THOUSANDS-scale statement and a MILLIONS-scale statement must produce identical workbook figures.**
- Workbook generation: assert that projection/returns cells carry `formula`, not literal values — this is the feature's core invariant and must be a hard test.
- IRR formula references the right ranges; sensitivity grid dimensions match the axis inputs.
- Route: 400 when no financials; binary content-type and disposition on success; org scoping.

### 6.12 Acceptance

A deal with three years of extracted financials produces a downloadable `.xlsx` that opens cleanly in Excel and Google Sheets, where changing the exit multiple on the Assumptions sheet updates IRR on the Returns sheet and the whole sensitivity grid — with no `#REF!`, no `#VALUE!`, and no hard-coded derived numbers anywhere.

---

## 7. Build order, branching, PRs

Build **in this order**. It is chosen so the cheap, high-reuse work lands first and the risky work benefits from what's learned.

| # | Feature | Branch | Est. | Why here |
|---|---|---|---|---|
| 1 | Document Requests | `feat/doc-requests` | ~1 wk | Highest reuse (share tokens + portal + upload pipeline all exist), closes the loop the product currently leaves open, lowest technical risk. |
| 2 | Deal Reactivation | `feat/deal-reactivation` | ~1 wk | Reuses `scoreDeal` and the cron pattern; the only feature here that compounds in value. Establishes the cron + eligibility-gate patterns. |
| 3 | NDA Redlining | `feat/nda-review` | ~1.5–2 wk | Largest single time saving quoted by any prospect; extends the existing legal-documents module; the grounding-verification work is novel. |
| 4 | Model Export | `feat/model-export` | ~2–3 wk | Largest build, new dependency, most correctness traps. Do it with the most runway. |

Each branch: cut from `main`, one PR, squash-merge. Do not stack these — they touch different areas and there's no dependency between them.

**Every PR description must include:**
1. Which demo-call feedback it closes (quote the call number).
2. **A bold line naming any `.sql` migration file that must be run manually in Supabase** before the feature works in production.
3. Any new environment variable (`CRON_SECRET` already exists; new ones need adding to Vercel).
4. Any `vercel.json` cron entry added.
5. Confirmation that `apps/api/tests/bundle-route-parity.test.ts` and `apps/web-next/src/lib/api-bundles.test.ts` pass.

---

## 8. Definition of done (per feature)

- [ ] `cd apps/api && npx tsc --noEmit` clean; `cd apps/web-next && npx tsc --noEmit` clean.
- [ ] `cd apps/api && npm run test` — no **new** failures. (`main` carries a known pre-existing failure baseline; record the before/after counts in the PR rather than claiming green.)
- [ ] New router mounted in `app.ts` **and** the correct production bundle(s); `bundle-route-parity.test.ts` passes; `pickBundle` updated + tested if the path needs the ai bundle.
- [ ] Migration file added under `apps/api/`, idempotent, RLS-enabled on every new table, and **called out in the PR description**.
- [ ] Every authenticated route org-scoped via `getOrgId` + `verifyDealAccess`.
- [ ] Every public route's response payload is an explicit whitelist with a test pinning the exact key set.
- [ ] Every LLM call goes through `trackedClaudeMessage` with an `operation` name, a JSON schema, and a raced timeout.
- [ ] Any agent reading a user document verifies its quotes against the source and logs verification failures.
- [ ] No file over 500 lines.
- [ ] UI matches the banker theme (`#003366`, white cards, `#F8F9FA`, Inter). No dark surfaces.
- [ ] `PROGRESS.md` (repo root) updated with an IST-timestamped entry: problem → root cause / rationale → what shipped.

---

## 9. Source documents

| Document | Why you'd open it |
|---|---|
| `.planning/demo-research/demo-calls.md` | All 19 demo calls, structured FEEDBACK / TAKE / ACTIONS. Ground truth for every "why". |
| `docs/PASCAL-FEEDBACK-ACTION-PLAN.md` | The one beta user's feedback, triaged BUILD / POLISH / PARK. |
| `docs/plans/2026-07-04-beachhead-pricing-gtm.md` | Who the customer is, what they'll pay, why the value unit is the deal. |
| `AGENTS.md` | Repo coding standards, ports, gotchas. |
| `.planning/codebase/CONVENTIONS.md` | Naming, imports, client/server component conventions. |
| `.planning/codebase/ARCHITECTURE.md`, `STRUCTURE.md`, `TESTING.md` | Codebase orientation. |
| `docs/DATABASE_MIGRATIONS.md` | The manual-migration workflow in full. |
