# Smooth Flows — User-Flow Fix List

Audit date: 2026-09-29. Five parallel code reviews (auth/onboarding, deal intake, working a deal,
documents/integrations, app-wide patterns), every finding re-verified against `main` at `115abfd`.
Line numbers are from that commit — re-check before editing, they drift.

Paths: `W/` = `apps/web-next/src/`, `A/` = `apps/api/src/`.

How to work this list: one batch = one PR, failing test first, tick the box when merged.

---

## Batch 1 — Quick high-impact fixes ✅ done 2026-09-30 (PR `fix/flows-batch-1`)

- [x] **"New Deal" buttons open intake in "Update Existing Deal" mode.** Callers pass `openDealIntake` straight as `onClick`, so it receives the click event as a "deal".
  - Where: `W/providers/IngestDealModalProvider.tsx:35-38`; callers `W/app/(app)/dashboard/page.tsx:236`, `dashboard/widgets/quick-actions.tsx:32`, `deals/page.tsx:388`, `:405`.
  - Fix: wrap callers as `() => openDealIntake()`, and have the provider ignore anything without a string `id`.
- [x] **Bulk import "View All Deals" → 404.**
  - Where: `W/app/(app)/deal-intake/components.tsx:408` (links to `/crm`, which doesn't exist).
  - Fix: link to `/deals` via `router.push` + `onClose()`.
- [x] **Stage-change note is thrown away.**
  - Where: textarea `W/app/(app)/deals/[id]/components.tsx:256-265`; PATCH sends only `{ stage }` at `deal-page-handlers.ts:84-86`; no note field in `A/routes/deals-mutate.ts` or `deals-schemas.ts`.
  - Fix: send `note` and write it into the stage-change activity (or remove the textarea).
- [x] **Data-room files vanish after one failed poll.** `fetchDocuments` swallows errors and returns `[]`, and the poll replaces the folder with it.
  - Where: `W/app/(app)/data-room/[dealId]/data-loaders.ts:193-201`, `W/lib/vdr/api.ts:60-73`.
  - Fix: return `null` on error and skip the merge when the fetch failed.
- [x] **Cancel at Google OAuth → raw "Missing code or state" page.**
  - Where: `A/routes/integrations-public.ts:30`.
  - Fix: if `req.query.error` is set or `code` is missing, redirect to `/settings?integrations=error&provider=…&reason=cancelled#section-integrations` and toast "Connection cancelled".
- [x] **"Reconnect needed" has no Reconnect button; sync error never shown.**
  - Where: `W/app/(app)/settings/IntegrationsSection.tsx:47` (badge), `:35` (`lastSyncError` in type, never rendered), `:523-600` (card actions).
  - Fix: for `token_expired`/`error`, make the primary button "Reconnect" (`onConnect()`) and show `lastSyncError`.
- [x] **Contact "Summarize emails" always says "No summary available".** Route doesn't exist; the 404 is treated as empty.
  - Where: `W/app/(app)/contacts/ContactEmailSummary.tsx:27-32, :104`; service exists at `A/services/gmailContactsService.ts:470`.
  - Fix: add `GET /contacts/:id/email-summary` in `A/routes/contacts.ts` calling `getContactEmailSummary`. Mount in the right bundle (see bundle-parity gotcha).
- [x] **Raw JSON shown as error messages.** Express error handler returns `{error:{code,message}}`; `api.ts` `JSON.stringify`s the object.
  - Where: `A/middleware/errorHandler.ts:104-106` → `W/lib/api.ts:90-99` (affects 12 routes using `next(error)`).
  - Fix: in `api.ts`, when `error` is an object, use `error.message` and `error.code`.
- [x] **Data rooms created from the Data Room page never appear on the kanban** (created with stage `SCREENING`, not a kanban stage).
  - Where: `W/app/(app)/data-room/page.tsx:261` (and the dead `msg.includes("403")` check at `:266`); schema `A/routes/deals-schemas.ts:11`; stages `W/lib/constants.ts:54`.
  - Fix: send `INITIAL_REVIEW`, make the schema stage a `z.enum`, check `err.status === 403`.
- [x] **Silent failures in the data room.** Delete / rename / new folder close the dialog and do nothing on failure.
  - Where: `W/app/(app)/data-room/[dealId]/file-handlers.ts:58, 94, 108, 137, 153` (`if (!ok) return;`).
  - Fix: `showToast("Couldn't …", "error")` in each branch.
- [x] **Missing-document "Request" and "Generate insights" give no feedback.**
  - Where: `file-handlers.ts:374-387`, `:291`; `W/components/vdr/InsightsPanel.tsx:270-276`.
  - Fix: success/error toast + disabled state while in flight.
- [x] **Failed pipeline drag snaps back with no message.**
  - Where: `W/app/(app)/deals/page.tsx:280-298`.
  - Fix: `showToast(err.message, "error")` in the catch.
- [x] **Extraction errors mislabelled as "document may be encrypted or unsupported"** (includes 404 "no document" and 429 "too many extractions").
  - Where: `W/app/(app)/deals/[id]/deal-financials.tsx:248-253`.
  - Fix: show `err.message`; for 404 show an "Upload a document" call to action.
- [x] **Old "PEOS" brand on the login page.**
  - Where: `W/app/(auth)/login/page.tsx:225`.

---

## Batch 2 — Onboarding and team invites (first thing a new customer's team touches)

- [ ] **Onboarding "Invite your team" invites nobody.**
  - Where: `W/app/(onboarding)/onboarding/team-task.tsx:6-12, 38`; `onboarding/page.tsx:159-208` (`completeTask` has no team branch).
  - Fix: POST each row to `/invitations` (map Analyst/VP/Partner/Admin → MEMBER/ADMIN), toast failures.
- [ ] **"Use a sample deal" creates no deal**; completion screen then says "still processing".
  - Where: `onboarding/page.tsx:247-256`; `completion-findings.tsx:103-106, 180-185`.
  - Fix: call `/onboarding/create-demo-deal` + `markServerStep("cim")` in `startChecklist`, with busy state and error toast.
- [ ] **Accept-invite fails for anyone with an existing account** ("User already registered").
  - Where: `A/routes/invitations-accept.ts:99-115`; `W/app/(auth)/accept-invite/page.tsx:96, 104`.
  - Fix: detect an existing auth user in `/verify`, show "Sign in to accept", add an authenticated accept endpoint that attaches the user to the org.
- [ ] **Accept-invite can leave a login with no firm, and burns the link.** User-row insert failure is swallowed, invite still marked ACCEPTED.
  - Where: `A/routes/invitations-accept.ts:132-144`.
  - Fix: return 500 before updating status; roll back the auth user so the link can be retried.
- [ ] **After accepting an invite the user bounces to /login.** The returned session is never applied.
  - Where: `W/app/(auth)/accept-invite/page.tsx:98-102, 344`.
  - Fix: `supabase.auth.setSession(data.session)` then go to `/dashboard`; if no session, say "check your email to confirm". Consider `admin.createUser({ email_confirm: true })` since the invite link proves the email.
- [ ] **Expired invites can't be resent or revoked; re-inviting is blocked as "already pending".**
  - Where: `W/app/(app)/settings/TeamSection.tsx:126-165`; `A/routes/invitations.ts:262-277` (duplicate check ignores `expiresAt`), `:161-167` (list); endpoints exist at `invitations-accept.ts:191, 232`.
  - Fix: Resend + Revoke buttons per row, compute EXPIRED from `expiresAt`, ignore expired rows in the duplicate check.
- [ ] **Invited teammates go through the founder onboarding** and can overwrite the org's firm profile.
  - Where: `W/components/onboarding/WelcomeModal.tsx:43`; `onboarding/page.tsx` (no role/invite check); `A/routes/onboarding-firm.ts:18`.
  - Fix: skip or shorten onboarding when `user_metadata.invited` is set or the org already has a firm profile.
- [ ] **Signup with an existing email shows "check your email" and nothing arrives**; button then stays disabled with no resend.
  - Where: `W/app/(auth)/signup/page.tsx:78-105`.
  - Fix: check `data.user?.identities?.length === 0` → "Account exists — log in or reset password"; add Resend + "Enter code" actions.
- [ ] **Email verification: "You can now sign in" + 5s wait + three redirects.**
  - Where: `W/app/(auth)/verify-email/page.tsx:118-132, 241-257`.
  - Fix: user is already signed in — go straight to `/onboarding` with "Continue to setup".
- [ ] **Login "Please verify your email" has no way forward.**
  - Where: `W/app/(auth)/login/page.tsx:428-432`.
  - Fix: "Resend verification" (`auth.resend`) or link to `/verify-email`.
- [ ] **Expired reset link: disabled form, no way to request a new one.**
  - Where: `W/app/(auth)/reset-password/page.tsx:45-57, 168-257`.
  - Fix: "Request a new link" button to `/forgot-password`.
- [ ] **SSO button does nothing.**
  - Where: `W/app/(auth)/login/page.tsx:144-147, 328-335`.
  - Fix: hide it, or toast "SSO available on request — contact us".
- [ ] Polish (auth):
  - Password error text omits the special-character rule (`reset-password/page.tsx:79`).
  - Raw role enum "MEMBER" on accept-invite (`accept-invite/page.tsx:204`) vs Analyst/VP/Partner/Admin in onboarding (`onboarding/types.ts:47`) — one shared role-label map.
  - "Remember me" is never read (`login/page.tsx:34, 276-284`) — wire or remove.
  - Forgot-password locks email + button after sending (`forgot-password/page.tsx:119, 148`) — unlock after a cooldown.
  - Team list load failure shows "No invitations sent yet" (`TeamSection.tsx:41-43`) — error + Retry.
  - MFA step isn't a form: Enter doesn't submit, 6 digits don't auto-submit (`login/page.tsx:365-400`).

---

## Batch 3 — Stop losing users' work

- [ ] **Memo "Generate all" saves nothing until the very end**; full-screen overlay, no Cancel. A refresh, error or the 300s limit loses every section.
  - Where: `A/routes/memos-generate.ts:122-125`; `W/app/(app)/memo-builder/section-handlers.ts:177-185, 232-237`; `memo-builder/generating-overlay.tsx:10`.
  - Fix: persist each section on `section_complete` server-side; treat a stream that ends without `done` as an error; non-blocking progress bar with Cancel (AbortController).
- [ ] **Chat reply that fails midway freezes, shows no error, and isn't saved.**
  - Where: `A/routes/deals-chat-ai.ts:368-373, 396` (error only sent `if (!fullText)`; saves skipped on exception); `W/app/(app)/deals/[id]/deal-page-handlers.ts:386-424`.
  - Fix: always send `{type:'error'}`; save the user message before streaming; client sets `streaming:false` in catch/finally.
- [ ] **Chat: no Retry, no Stop, unhelpful errors.**
  - Where: `deal-page-handlers.ts:408-421` (`isServerError` never matches); legacy bare 500 at `deals-chat-ai.ts:441`; timeout in raw ms at `A/services/agents/dealChatAgent/index.ts:563`; `api.stream` takes no signal (`W/lib/api.ts:289`).
  - Fix: `classifyAIErrorObject` in the legacy catch, branch on `ApiError.status`, Retry on error bubbles, AbortSignal + Stop button, timeout in seconds.
- [ ] **Chat history after reload:** action buttons lost (reads `msg.action`, stored in `metadata.action`), and failed replies return as empty AI bubbles.
  - Where: `W/app/(app)/deals/[id]/page.tsx:158-167`; `A/routes/deals-chat-ai.ts:373`.
- [ ] **Session expiry (401) redirects to /login immediately, losing work**; after login, always lands on /dashboard.
  - Where: `W/lib/api.ts:74-77, 129-132, 200-203`; `W/lib/supabase/middleware.ts:65-68`; `W/app/(auth)/login/page.tsx:80, 132`.
  - Fix: on 401, `refreshSession()` once and retry; then re-auth modal or `/login?next=<path>`; login honours same-origin `next`.
- [ ] **No unsaved-changes protection anywhere** (0 `beforeunload` handlers).
  - Where: `W/app/(app)/nda/FullEditPage.tsx:113`, `memo-builder/section-handlers.ts:53`, `templates/TemplateEditor.tsx`, `settings/page.tsx:397`, `deals/[id]/edit-deal-modal.tsx:186` (backdrop click discards edits).
  - Fix: shared `useUnsavedChanges(isDirty)` hook (beforeunload + in-app link guard); dirty modals confirm before closing.
- [ ] **Closing the upload modal mid-upload loses the result** (and invites a duplicate re-upload).
  - Where: `W/components/deal-intake/IngestDealModal.tsx:31` (Esc), `:51` (backdrop).
  - Fix: block close while processing, or keep the form mounted and toast a link when done.
- [ ] **Stage change wipes team avatars (and possibly scorecard) from the cached deal.**
  - Where: `W/app/(app)/deals/[id]/page.tsx:88-97` (`setDeal(updated)` with a PATCH response lacking `teamMembers`, `A/routes/deals-mutate.ts:212-218`).
  - Fix: `setDeal(prev => ({ ...prev, ...updated }))` or `refetchDeal()`.

---

## Batch 4 — Bigger builds

- [ ] **Deals pipeline silently stops at 50 deals.**
  - Where: `W/app/(app)/deals/page.tsx:90`; memo-builder picker `memo-builder/data-loaders.ts:141`.
  - Fix: paginate / load more, or raise the limit and show "Showing 50 of N".
- [ ] **New deal says "No financial data yet — upload a CIM" while the CIM is still extracting**; background skip/failure is never surfaced.
  - Where: `A/routes/ingest-upload.ts:691-714` (`backgroundExtraction: 'started'` unused); `A/services/ingestDeepPass.ts:36-41, 64-66`; `W/app/(app)/deals/[id]/deal-financials-empty-state.tsx:33-35`; `deal-scorecard-section.tsx:58`.
  - Fix: per-deal extraction status; "Extracting financials… ~1–3 min" with polling; disable manual Extract meanwhile; queue instead of skip; "Couldn't extract automatically — Retry".
- [ ] **Multi-file "new deal" upload: if file 1 fails, each other file creates its own deal.**
  - Where: `W/components/deal-intake/uploadHandlers.ts:121`; `batchPlan.ts:63`.
  - Fix: use the first *successful* file's deal, or stop/ask when file 1 fails.
- [ ] **Failed uploads only say "Upload failed"** — per-file reasons (scanned PDF, AI down, bad type) are hidden; partial failures unmentioned.
  - Where: `uploadHandlers.ts:131, 145`; `IngestDealForm.tsx:421`; `W/components/deal-intake/tab-panels.tsx:73-94`.
  - Fix: show the real reason for single files; keep per-file status visible after processing.
- [ ] **No duplicate-deal check on ingest or bulk import.**
  - Where: `A/routes/ingest-upload.ts:360-362, 420`; `A/routes/ingest-email.ts` (~284-289).
  - Fix: return `possibleDuplicate` → "Add to existing deal / Create anyway".
- [ ] **External brokers can't upload files over ~4.5MB** on document-request links (data room already fixed by #151).
  - Where: `W/app/upload/[token]/upload-view.tsx:84` → `A/routes/doc-request-portal.ts:57-59`.
  - Fix: token-scoped signing endpoint (e.g. `POST /api/public/doc-requests/:token/items/:itemId/sign`) + reuse `uploadViaSignedUrl`'s storage step. Also align data-room client cap (`data-room/[dealId]/upload-helpers.ts:4`, 50MB) with `DATA_ROOM_MAX_FILE_SIZE` (100MB, `W/lib/storageUpload.ts:24`).
- [ ] **No navigation on mobile** (sidebar + header search `hidden md:flex`, no menu button); **deal chat is desktop-only**.
  - Where: `W/components/layout/Sidebar.tsx:125`, `Header.tsx:65`; chat `W/app/(app)/deals/[id]/page.tsx` (`hidden lg:flex`), tabs `deal-detail-shared.ts:143`.
  - Fix: Header menu button opening the Sidebar as a drawer; Chat tab or floating button on small screens.
- [ ] **Shared `<Dialog>` component.** 26 modals don't close on Escape; almost none trap/return focus; only 4 have `role="dialog"`.
  - Where: 56 hand-rolled `fixed inset-0` overlays; good primitive already at `W/components/dash/side-sheet.tsx`.
  - Fix: build `<Dialog>` from SideSheet and migrate overlays.
- [ ] **Model / scorecard / header metrics stale after extraction.**
  - Where: `W/app/(app)/deals/[id]/deal-model-panel.tsx:109-124`; `deal-scorecard-section.tsx:22`.
  - Fix: `onExtracted` → shared refresh (or read the shared financials cache already written at `deal-financials.tsx:96-101`).
- [ ] **HubSpot import: no progress for up to 3.5 min; half-finished import vanishes on return.**
  - Where: `A/routes/hubspot-import.ts:54, 190`; `W/app/(app)/settings/IntegrationsSection.tsx:275-282, 324-358`.
  - Fix: create the job and return its id immediately; drive via `/continue`; on mount resume any running job.

---

## Tier 2 leftovers (confusing / slow — pick up alongside the batches)

- [ ] Contact CSV import: one bad row fails the whole import with no reason; `res.ok` never checked; duplicates reported as failure. `W/app/(app)/contacts/csv-import-modal.tsx:133-140, 246`; `A/routes/contacts.ts:53-55, 90-91, 430`. Validate per row client-side, chunk by 500, show `details` + `skippedDuplicates`.
- [ ] Public portal / upload pages say "link not valid" on any 5xx or network error. `W/app/upload/[token]/page.tsx:29-37`; `W/app/portal/[token]/page.tsx:25-33`; `portal-view.tsx:102-107`. 404 → not found; otherwise "Something went wrong" + Retry.
- [ ] Deal page says "Deal not found" for any failure, no Retry. `W/app/(app)/deals/[id]/deal-page-skeletons.tsx:97-113`.
- [ ] Raw technical messages: `NotFoundError` embeds the path (`W/lib/api.ts:85`); error boundary prints `error.message` (`W/app/(app)/error.tsx:21`); 125 `err instanceof Error ? err.message` sites. Add `getUserMessage(err)` mapping status → friendly copy.
- [ ] Command palette contact search doesn't open the contact (hash never read) and only searches the first 50. `W/components/layout/CommandPalette.results.ts:74`, `CommandPalette.tsx:121`; `A/routes/contacts.ts:103`.
- [ ] Contact detail panel disappears when the load fails. `W/app/(app)/contacts/detail-panel.tsx:56-63, 225`.
- [ ] Contact link modals (Link Deal / Add Connection) have no double-submit guard. `W/app/(app)/contacts/detail-modals.tsx:58/118, 162/223`.
- [ ] Data-room multi-file upload: modal closes immediately (no per-file progress), errors auto-dismiss after 6s, no retry. `W/app/(app)/data-room/[dealId]/file-handlers.ts:329, 368`.
- [ ] Public uploader can "complete" with nothing sent; one file per item. `W/app/upload/[token]/upload-view.tsx:112-121, 221-231, 250-256`.
- [ ] NDA: signature detected while a doc is open doesn't update the open view. `W/app/(app)/nda/page.tsx:157, 189, 353, 365`.
- [ ] Ingest progress label says "Reading with AI…" while still uploading; no elapsed time; single-file step text hidden. `W/components/deal-intake/uploadHandlers.ts:102`; `IngestDealForm.tsx:413-421`.
- [ ] Some file types accepted up front but rejected after upload (`.eml`, `.xlsm`, empty browser MIME type). `A/routes/uploads-sign.ts:27`; `IngestDealForm.tsx:137-154`; `A/routes/ingest-upload.ts:162, 211, 237`.
- [ ] "Import Deals" opens the document modal; the column-mapping CSV importer (`A/routes/deal-import.ts:45`) has no UI; no name-only quick create.
- [ ] Chat file attach: >25MB silently ignored; uploaded doc doesn't appear in Documents until reload. `W/app/(app)/deals/[id]/deal-tabs.tsx:~177, ~192-196`.

## Tier 3 — Polish

- [ ] Share modal: existing links have no Copy button; Revoke has no confirmation; clipboard failure silent. `W/components/deal-actions/ShareDealModal.tsx:176-195, 91-100`.
- [ ] Toasts implemented three ways; settings/data-room timers dismiss newer toasts early. ~~`settings/page.tsx:114`~~ (Settings moved to the global toast in Batch 1), `templates/page.tsx:80`, `data-room/[dealId]/page.tsx:99`, memo-builder. Move all to global `useToast`.
- [ ] Dashboard duplicate requests: `/deals` under 3 keys, `/tasks` under 3. `dashboard/use-dashboard-data.ts:61`, `widgets/deal-funnel.tsx:27`, `widgets/upcoming-deadlines.tsx:36`.
- [ ] Pages still showing a full spinner on every visit: `data-room/page.tsx:49`, `memo-builder/data-loaders.ts:25, 66` → move to `useApiQuery`.
- [ ] Fit popup can appear up to 40s later over the follow-up questions; "reject" resets the form. `W/lib/teaserPoll.ts`; `IngestDealForm.tsx:249-257, 477-480`. Show fit inline instead.
- [ ] Navigation to a new deal does a full app reload (`window.location.href`). `IngestDealForm.tsx:308, 462, 475`; `deal-intake/components.tsx:398`. *(Batch 1: the result card's View Deal / View All Deals links are fixed; the `window.location.href` calls in IngestDealForm remain.)*
- [ ] Integrations: list load failure shows every provider as "Not connected"; ~~OAuth query param never cleared~~ (fixed in Batch 1); "Sync started" shown after a finished sync. `IntegrationsSection.tsx:96-102, 113, 172`.
- [ ] Portal Download on an expired share shows raw JSON. `W/app/portal/portal-view.tsx:192-197`; `A/routes/portal.ts:225`.
- [ ] "Connect Gmail to summarize emails" isn't a link. `ContactEmailSummary.tsx:74`.

---

## Live QA findings — 2026-09-30 (browser click-through on production)

Four `playwright-cli` testers clicked through deals.avise.io as `qa.tester@example.com`
(ADMIN, own "Avise QA Test Org"). Items below are **new** — not in the code audit above.
Each was observed live; evidence screenshots were taken during the run.

### Batch 0 — fix before the next demo ✅ done 2026-09-30 (PR `fix/flows-batch-0`)

- [x] **Financial statements from an Excel upload are wrong, including on the client portal.** ✅ *Fixed in batch 0: crore/lakh scales added and the lossy rounding removed; cache versioned so Re-extract recomputes.*
  - Seen: Excel P&L with Revenue 182.4 / 214.9 / 251.3 and EBITDA 29.1 / 36.5 / 44.2. The deal headline was correct, but the Financial Statements table, the model panel, the deal chat's key metrics and the **public portal** showed Revenue 200/200/300 and **EBITDA 0 for every year**.
  - The deal chat noticed it by itself: the numeric rows were 0 and only the `_source` cells carried the figures.
  - Where to look: the deep-pass Excel extraction in `A/services/ingestDeepPass.ts` → Excel container extraction → statement storage. Check unit scale and the merge of `_source` rows into numeric rows.
- [x] **Valid PDFs can be rejected at ingest and never analysed.** ✅ *Fixed in batch 0: failed text extraction now falls through to Claude's native PDF read; the data room shows "Extraction Failed" instead of pending forever.*
  - `pdf-parse` 1.1.4 (bundles pdf.js from 2017) throws "Invalid PDF structure" on PDFs that use modern object streams. Ingest then returns 422 "may be encrypted…", even though macOS PDFKit reads the same file fine.
  - Claude can read PDFs natively (`INGEST_ENGINE=claude`), but ingest stops at the text-extraction step before Claude is tried.
  - The same PDF sits in the data room as "Pending Analysis" indefinitely.
  - Fix: when text extraction fails, still send the PDF to Claude's native read. Upgrade or replace `pdf-parse`.
  - Where: `A/routes/ingest-upload.ts` Step 1 ("LlamaParse → pdf-parse").
- [x] **"Mark all as read" returns 403 for every user.** ✅ *Fixed in batch 0 (bulk delete had the same bug).*
  - The panel sends the Supabase *auth* id. `GET /notifications` translates auth id → internal id, but `mark-all-read` looks up `User.id = <auth id>`, finds nothing, and answers "outside your organization".
  - The UI hides it: the badge clears, then the notifications come back unread on the next refresh.
  - Fix: resolve the id the same way `GET` does, or better, ignore the client's `userId` and use `req.user`.
  - Where: `A/routes/notifications.ts:274-302`; callers `W/components/layout/NotificationsDropdown.tsx:117`, `NotificationPanel.tsx:132`.
- [x] **The dashboard says "0 live deals" while deals exist.** ⚪ *Not reproducible on re-test: a new Initial Review deal counted at once (3 live, 1 in Sourcing). The tester's dashboard was probably loaded before the other testers created deals.*
  - The Pipeline widget buckets (Sourcing / Diligence / IOI-LOI / Negotiation / Closed) have no slot for `INITIAL_REVIEW`, the default stage of every new deal. `/deals` and `/admin` show the correct count.
- [x] **Data-room insights fail silently.** ✅ *Fixed in batch 0: moved to Claude (same prompt and output shape).*
  - `POST /folders/:id/generate-insights` → 503 "Check that OPENAI_API_KEY is configured". This feature still runs on OpenAI, which has no working key or credit in prod.
  - The panel quietly resets to "No insights yet" (Batch 1 added a toast; confirm it shows).
  - Decide: move this feature to Claude, or configure OpenAI.
- [x] **NDA template saves but never appears.** ⚪ *Not reproducible on re-test: the saved template is listed and New NDA works. "0 saved" counts NDA documents, not templates. A related org-creation race was hardened in batch 0.*
  - `POST /legal-document-templates` → 201, but the gallery keeps showing "0 saved" and "No NDA templates yet". `GET` returns 200 without it, even after a reload.
  - Result: the whole create-NDA → edit → send-for-signature flow is blocked.
- [x] **Firm Profile says "Saved" but the website and LinkedIn fields don't persist.** `POST /onboarding/firm-inputs` → 200; after a reload both fields are empty. ✅ *Fixed in batch 0: the save always worked; `/users/me` never selected `Organization.settings`, so the page reloaded blanks.*
- [x] **Multi-file data-room upload silently drops unsupported files.** ✅ *Fixed in batch 0: the confirm dialog lists each skipped file and why.*
  - Picking a PDF, an XLSX and 2 .txt files → the confirm dialog lists only the PDF and XLSX, with no message about the other two.
  - The error toast only fires when every file is invalid.

### Needs the founder (config, not code)
- [ ] **Gmail / Google "Connect" returns 500** before reaching Google (`POST /integrations/gmail/connect`, `/google_calendar/connect`). This matches the known missing Google OAuth client id/secret pair in Vercel prod env. Granola (API key) works.
- [ ] **Invite emails don't send** ("Invitation created but email could not be sent"). This may only be because `@example.com` bounces. Check the email provider logs with one real address.
- [ ] **NDA "Review their NDA" timed out** (504 after ~108s; the UI did show the error). Likely AI credit or latency; re-test after credits are topped up.

### Also found live (MEDIUM / LOW)
- [ ] Deal header "Change Stage" opens the **Close Deal** (Won/Lost/Passed) modal, even for a deal in Initial Review. Only clicking a pipeline node gives the normal stage picker with its note field.
- [ ] Share links: once the Share modal closes, there's no way to list, copy or revoke existing links. (The code audit expected rows in `ShareDealModal`; the live UI showed none, so check whether the list renders.)
- [ ] Data-room folder file count goes stale (said 3 files while the folder held 1, including in the delete-confirm text). A same-name re-upload returned 200 instead of 201, which suggests leftover orphan rows.
- [ ] Contact detail panel doesn't refresh after editing a field or adding a note (server returned 200/201; the panel updates only after a full reload).
- [ ] Team invite stays **PENDING** after the invitee has accepted and signed in.
- [ ] React hydration error #418 in the console on every `/dashboard`, `/settings` and `/data-room` load. Probably time-based text rendered on the server.
- [ ] Old branding still live:
  - Settings → Security says "Pocket Fund staff access log", links `/assets/pocket-fund-security-overview.pdf` and uses `security@pocket-fund.com`.
  - The Help & Support modal lists `tech@pocketfund.org` and `hello@pocketfund.org`.
  - Sidebar "Feedback" opens an external Google Form titled "PE OS Beta Feedback Form".
- [ ] Clicking a data-room file row downloads it immediately, with no preview and no on-page feedback.
- [ ] The forgot-password page's browser tab title is "Sign In | Avise".
- [ ] LOW:
  - User menu "Profile" and "Settings" both go to `/settings`.
  - Quick Actions "Create Task" linked to `/admin`.
  - `GET /folders/:id/insights` returns 404 for new folders (expected-empty state modelled as an error).
  - The upload dialog shows small files as "0.0 MB".
  - Invite role: "Associate" at invite time shows as "MEMBER" afterwards.
  - Many near-duplicate `GET /notifications?limit=1` calls.

### Seen once, not reproducible
- Portal document download returned 404 "This link is not valid." on `app.avise.io` during the run. Re-tested afterwards with the same token: portal and download work on both `app.avise.io` and `deals.avise.io`.

### Confirmed live — already on this list
Mobile has no navigation · SSO button does nothing · CSV contact import fails the whole batch with no reason · no unsaved-changes guard · invites have no Resend/Revoke · accept-invite lands on bare /login · memo "Generate all" timed out (~85s, `ERR_TIMED_OUT`) and **lost every generated section on reload**.

### Worked well (live)
Excel ingest → deal in ~10s · deal chat (~5s, citations, history persists) · stage change with note (Batch 1 fix confirmed) · data-room create/rename/upload/download/delete · kanban drag persists · Cmd+K search · Investment Criteria save · invite accept end-to-end · "Summarize emails" now says to connect Gmail (Batch 1 fix confirmed) · new data rooms appear on the kanban (Batch 1 fix confirmed) · scorecard shows a clear "set criteria first" message.

---

## Not verified by the audit

- Supabase project settings (email confirmation on/off, PKCE on cross-device reset links) — affects the accept-invite and signup items.
- Real extraction/ingest/memo durations vs the 300s Vercel limit.
- Which `DEAL_CHAT_ENGINE` value production runs.
- Nothing was rendered: mobile layout inside individual pages is untested beyond the nav shell. After each batch, click through the fixed flows with the `playwright-cli` skill.
