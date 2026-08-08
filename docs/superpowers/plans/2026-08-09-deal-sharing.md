# Client Portal / Deal Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners share a deal via a revocable tokenized link; external people open a clean read-only public portal page (overview/financials/documents/memos per share toggles) with view tracking and signed-URL-only document downloads.

**Architecture:** Two new tables (`DealShare`, `DealShareView`, manual migration). Owner-side CRUD in `routes/deals-share.ts` (authenticated, org-scoped). Public read API in `routes/portal.ts` mounted at `/api/public/portal` (same pattern as public invitations). Public Next.js page at `/portal/[token]`. Share modal wired into the existing `DealActionsMenu`.

**Tech Stack:** Express + Supabase (existing patterns), `crypto.randomBytes` tokens, `getSignedDownloadUrl()` (existing), Resend (existing optional pattern), Vitest + supertest, Next.js public route.

**Branch:** `feat/deal-sharing` off `origin/main` (1304d8d). **Baseline:** apps/api 1050 passed / 17 pre-existing failures (pdf-watermark collection error, db-optimizations ×10, financial-validator ×1, trackedLLM ×3, agent-nodes ×3) — any new failure beyond these is a regression from this work.

---

### Task 1: Migration + owner-side share API

**Files:** Create `apps/api/deal-share-migration.sql`, `apps/api/src/routes/deals-share.ts`, `apps/api/tests/deals-share.test.ts`; modify `apps/api/src/app.ts` (mount).

- [ ] Migration SQL exactly as in the spec (`DealShare` + `DealShareView` + indexes).
- [ ] Failing tests: create share (returns token ≥64 hex chars, portal URL, defaults all sections on, org-scoped via mocked `verifyDealAccess`); cross-org 404; list shares with aggregated `viewCount`/`lastViewedAt`; revoke sets `revokedAt`; invalid body 400.
- [ ] Implement route (zod-validated, `crypto.randomBytes(32).toString('hex')`, Activity log on create, optional Resend email mirroring `sendInvitationEmail`'s null-safe pattern, `APP_URL` env for link base with localhost:3002 fallback). Mount under `/api/deals` beside `dealsRouter`.
- [ ] Tests pass → commit `feat(sharing): DealShare model + owner-side share management API`.

### Task 2: Public portal API

**Files:** Create `apps/api/src/routes/portal.ts`, `apps/api/tests/portal-public.test.ts`; modify `apps/api/src/app.ts` (public mount beside `/api/public/invitations`).

- [ ] Failing tests: valid token returns share+deal payload and records a view row; unknown token 404; revoked 410; expired 410; disabled sections omitted from payload (`financials`/`documents`/`memos` keys absent when toggled off); download endpoint 302s to signed URL for an in-deal doc, 404 for a doc outside the deal, 403/404 when documents disabled; no auth required (no user on request).
- [ ] Implement: token lookup, status checks mirroring `invitations-accept.ts` semantics, fire-and-forget view insert, payload assembly (Deal metadata whitelist per spec — explicitly NOT team/scorecard/aiThesis; active FinancialStatements; Document id/name/type/fileSize; Memos + MemoSections title/content), org name from Organization. Download: re-validate token → confirm doc.dealId matches → `getSignedDownloadUrl` → 302.
- [ ] Tests pass → commit `feat(sharing): public portal API — token-gated read-only deal payload + signed downloads`.

### Task 3: Portal page + middleware allowance

**Files:** Create `apps/web-next/src/app/portal/[token]/page.tsx` (+ split components if >500 lines); verify/modify `apps/web-next/src/middleware.ts`; test `apps/web-next/src/app/portal/portal-view.test.tsx` (component-level render states).

- [ ] Check `middleware.ts` matcher — ensure `/portal/*` is reachable unauthenticated (public routes like `/security`, `/pricing` already are; follow whatever mechanism they use).
- [ ] Failing tests: portal view renders deal name + org attribution from payload; renders 410 screen for revoked; hides disabled sections.
- [ ] Implement page: client component fetching `/api/public/portal/:token` with plain `fetch` (public — deliberately NOT `api.ts`, which attaches auth and redirects to /login on 401), banker styling, sections per spec, downloads via `/api/public/portal/:token/documents/:id/download`, sanitized memo rendering via existing `lib/markdown.ts` helpers, PE OS footer.
- [ ] Tests pass + `tsc --noEmit` no new errors → commit `feat(sharing): public portal page`.

### Task 4: Share modal + deal-page wiring

**Files:** Create `apps/web-next/src/components/deal-actions/ShareDealModal.tsx`, test `ShareDealModal.test.tsx`; modify `apps/web-next/src/app/(app)/deals/[id]/deal-panels.tsx` (menu item) and whatever parent wires modals (follow DraftEmailModal's wiring).

- [ ] Failing tests: create flow calls `api.post` with form values and shows the returned URL; revoke calls `api.delete` and removes the row; section toggles default on.
- [ ] Implement modal (label, email, three toggles, expiry preset 7/30/90/never, copy-link row, shares list with views + revoke) and add "Share deal" to `DealActionsMenu` following the existing modal-opener pattern.
- [ ] Full web-next suite + `tsc --noEmit` clean of new errors → commit `feat(sharing): ShareDealModal + deal actions menu entry`.

### Task 5: Manual verification (not a coding task)

Standing caveat: no local Supabase/Resend credentials in this worktree — end-to-end verification is impossible here and is not claimed. Before merge, with real credentials: (1) run `apps/api/deal-share-migration.sql` in Supabase (manual), (2) share a real deal, open the link in an incognito window, verify sections/downloads/410-after-revoke, (3) confirm view count increments for the owner, (4) confirm email delivery when an invitee address is set.

---

## Rollout

No flag; additive. Deploy coupling: manual migration. Merges independently of the AI-rebuild stack (based on origin/main).
