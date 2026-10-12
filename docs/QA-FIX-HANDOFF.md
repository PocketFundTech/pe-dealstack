# QA fix handoff — start here (as of 11 Oct 2026)

This is the **current** list of what is still broken on app.avise.io after the browser QA rounds of 2–11 Oct 2026, and how to fix each item. The dated reports next to this file are the history, with full evidence. Where they say a PR is "open" or "unmerged", this file is the one that's up to date.

| File | What it is |
|---|---|
| `QA-REPORT-2026-10-06.md` | First full report, findings #1–#20 with repro steps |
| `QA-REPORT-2026-10-11.md` | Re-check of the above, plus #21 (DMpro) and #22 (Companies page) |
| `QA-REPORT-2026-10-11-ai-reports.md` | Memo builder (AI Reports) and Settings deep test, findings A–D |
| `FIX-REPORT-integrations-truncation-and-folder-404.md` | Root cause of the Integrations bug (fixed in #216), and why the folder 404 is not a bug |
| `QA-TESTING-MASTER-PROMPT.md` | How to re-run this testing (playwright-cli, a throwaway org, red-box screenshots) |
| `qa-screenshots/` | Annotated screenshots; the red box marks the problem |

**Don't work on these:** mobile navigation at 390px, and the Feedback button's "PE OS Beta" Google Form. The founder has deprioritised both.

---

## Already fixed (no action)

| What | Fixed by |
|---|---|
| Unit-scale checks + impossible-returns warning in the model (942% IRR) | #196 (but Luktara's stored data is still wrong, see P0-2) |
| Integration names cut to "Gr…", "G…" | #216 |
| Chat / Generate All said "API key invalid" when the real cause was credit | #217 |
| Memo sidebar named a fake "Standard IC Memo" template | #218 |
| "Pocket Fund" branding, hydration error #418, "Change Stage" opening Close Deal, dead "New deal" button, Gmail/Google OAuth 503 | Earlier PRs, each re-verified live on 6 or 11 Oct |

`GET /api/folders/{id}/insights` returning 404 is intentional: 404 means no insights yet. See the FIX-REPORT. Don't fix it.

---

## P0 — blocks everything AI

### P0-1. All AI calls fail in production: the API key isn't workspace-scoped
- **Seen 11 Oct:** every Anthropic call returns *"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header"*. Memos, chat, extraction and Re-extract all fail.
- **Ops fix (founder / anyone with Vercel + Anthropic console access):** in the Anthropic console, create a key **inside a workspace**. Set it as `ANTHROPIC_API_KEY` in the Vercel project `pe-dealstack` (production), then redeploy. To check it worked: `vercel logs --environment production --since 1h --query "workspace"` should show nothing new.
- **Code fix (small):** `classifyProviderRejection` in `apps/api/src/utils/aiErrors.ts:113` doesn't recognise this error. It's a 400 `invalid_request_error`, so it returns `null` and users see a generic failure. Add a hint such as `'not scoped to a workspace'` → reason `'auth'`, so the message says it's a key/config problem. Add a test next to `apps/api/tests/aiErrors.test.ts`.

### P0-2. Luktara Industries: revenue stored ×1000 → nonsense model (942% IRR)
- **Blocked on P0-1.**
- **Cause:** these are old GPT-4o extraction rows (`extractionSource: "gpt4o"`, before 18 Aug) from one file, `1_income_statement_model_1_0.xlsx`. All rows are tagged MILLIONS, but 2014–2021 hold 362500 where the source says 362.511 (USD m). The 2014–2021 rows are also mislabelled HISTORICAL, and 2012–2013 don't match the source. #196 makes the validator and model flag this, but the stored rows stay wrong until they're re-extracted.
- **Fix:** once P0-1 is done, open Luktara → Financial Statements → **Re-extract**. Verify that 2014 revenue ≈ **$362.5M** (not $362.5B), the balance-sheet errors are gone, and the model's IRR is sane.
- **If it's still wrong after re-extracting with the current Claude engine:** the bug is in extraction itself. Start in `apps/api/src/services/extraction/` (Excel container path) and `financialPeriodNormalizer.ts`.
- Screenshots: `luktara-validation-annotated.png`, `model-absurd-returns-annotated.png`, `revenue-jump-annotated.png`.

---

## P1 — trust / data accuracy

### P1-1. Impossible EBITDA margin shown as a plain number (DMpro: 111%)
- Deal header tiles show Revenue (LTM) $3.5B and **EBITDA Margin 111%** on a $20K deal, with no warning. The monthly figures from `CIM - DMPRO.docx.pdf` swing by 200–500% in both directions. Each swing gets only a "verify" *warning*.
- **Fix:**
  - Any margin outside about −50%…100% must render with a warning badge, never as a clean headline number. Tile code: `apps/web-next/src/app/(app)/deals/[id]/deal-layout.tsx`, `deals/deals-deal-card.tsx`.
  - Consider escalating repeated ±400% swings within one document/window to an *error* in `apps/api/src/services/financialValidator.ts`.
  - After P0-1, audit the other live deals for the same pattern.
- Screenshot: `dmpro-margin-annotated.png`.

### P1-2. Raw provider error JSON inside memo sections and exported PDFs
- Older memo sections contain `[Section generation failed: 400 {"type":"error",...,"request_id":"req_..."}]`, and it gets exported into the PDF. New failures are now classified (#217), but sections saved before that still hold the raw text. Extraction errors shown per document have the same problem.
- **Fix:** when rendering and exporting (memo canvas, PDF, Markdown, copy-to-clipboard), detect section content that starts with `[Section generation failed:` and show a friendly "Not generated yet — click regenerate" placeholder, kept out of exports. Optionally add a one-off cleanup of stored rows. The placeholder is written in `apps/api/src/services/agents/memoAgent/pipeline.ts` (~line 199, and its catch block).
- Screenshot: `memo-raw-error-annotated.png`.

### P1-3. Client portal: no watermark, and Revoke doesn't kill already-issued links (security)
- Internal Data Room downloads are watermarked. Portal downloads serve the original file through a 1-hour Supabase signed URL, and that URL still returns 200 **after** the share is revoked.
- **Fix:**
  - Stream portal files through the API with the same watermarking as internal downloads, re-checking the share's revoked/expired state on every request.
  - Default new share links to an expiry (e.g. 30 days, not "Never").
  - Fill or hide the blank "Overview" card.
- **Code:** `apps/api/src/routes/portal.ts`, `deals-share.ts`, and the watermark logic used by `documents.ts`.
- Screenshot: `portal-annotated.png`.

---

## P2 — product polish (premium feel)

### P2-1. Memo builder
- **a. Layout at 1280px:** three side panels squeeze the canvas to ~230px, and headings render one letter per line. Auto-collapse the AI Analyst panel below ~1440px. Screenshot: `memo-crushed-1280-annotated.png`.
- **b. Duplicate sections:** existing memos have 17 sections instead of 12. Quality of Earnings, Management Assessment, Operational Deep Dive, Value Creation Plan and Exit Analysis each appear twice. Generate All regenerates both copies.
  - First check whether a *new* memo still duplicates. A related fix is described in the comment at `apps/api/src/routes/memos-mutate.ts:185`.
  - If new memos are clean, de-duplicate existing memos with a one-off script.
- **c. PDF export is image-only** (rasterised JPEG pages, 10 s+, no progress indicator). Render from HTML/text instead so it's searchable, and show progress. Screenshot: `memo-pdf-annotated.png`.
- **d. "Compliance Check"** says "All citations are verified" even when there's no content. Make it conditional or reword it.

### P2-2. NDA outputs all require Google Workspace; downloads fail silently
- Send by email, Download .docx, Download PDF and Dropbox Sign all go through Google Docs. Microsoft 365 firms can't produce an NDA.
- The download error ("Google isn't connected…") only goes to the console. The e-sign dialog duplicates its error text, and its "Retry" can never succeed.
- **Fix:**
  - Short term: show the error in the UI, de-duplicate the string, and replace "Retry" with "Connect Google".
  - Longer term: render the .docx/PDF on the server without Google.
- Screenshots: `nda-download-annotated.png`, `nda-esign-annotated.png`, `nda-send-annotated.png`.

### P2-3. Workspace creator gets MEMBER, not ADMIN
- The person who signs up and creates a new org can't create API keys or webhooks for it.
- **Cause:** both `apps/api/src/middleware/auth.ts:135/177` and `apps/api/src/services/userService.ts:87` default to `'MEMBER'`.
- **Fix:** give the first user of a newly created org ADMIN. Seen on two fresh `/signup` orgs.

### P2-4. Single team invite: no success toast, list stale until reload
- `POST /api/invitations` returns 201, but the modal closes silently. Copy the bulk-CSV flow, which shows a banner and refreshes the list.
- Code: `apps/web-next/src/app/(app)/settings/TeamSection.tsx`. Screenshot: `invite-pending-annotated.png`.

### P2-5. Settings sub-nav scroll-spy highlights the wrong item
- Clicking Notifications highlights Firm Context, and two items can be highlighted at once. The last section never highlights at the bottom of the page.
- Fix the IntersectionObserver logic in `apps/web-next/src/app/(app)/settings/page.tsx`. Screenshot: `settings-scrollspy-bug-annotated.png`.

### P2-6. Tablet (768px) header overflow
- On the deal page, Edit Deal and the notification bell are off-screen. On the dashboard, the search bar wraps and pipeline labels are clipped.
- Add a 768–1024px breakpoint: collapse the sidebar and move header actions into an overflow menu.
- Screenshots: `tablet-deal-annotated.png`, `tablet-dashboard-annotated.png`.

---

## How to work on these

- **Branching:** one PR per item, branched from fresh `origin/main`. Write the test first and check it goes red → green. Conventional commits (`fix(memo):`, `fix(portal):` …).
- **Verifying live:** re-test on app.avise.io with the method in `QA-TESTING-MASTER-PROMPT.md`. Use a disposable org signed up with an `@example.com` address. Never test destructive actions on real customer orgs.
- **AI rule:** any new Claude call must follow `CLAUDE.md`: inject today's date into prompts, use prompt caching for repeated prefixes, and run AI only when a user clicks.
- **Before blaming code for AI failures:** check production logs for credit or key problems first (P0-1).
