# QA Report — AI Reports (Memo Builder) deep test — 2026-10-11

Full click-through of every control on the AI Reports page (`/memo-builder`), following `docs/QA-TESTING-MASTER-PROMPT.md`. Tested on the real account's "Apex Precision — Test Memo". Production AI is still out of credits (known issue, `docs/QA-REPORT-2026-10-06.md` #12) — that's not re-litigated here except where it surfaces a **new, distinct** bug in how the error is handled.

---

## What works correctly

- **Memo list sidebar:** All/Draft/Review/Final filter tabs all work, including correct empty states ("No memos found. Create your first investment memo.") for filters with zero matches.
- **Search box:** filters the memo list correctly by title substring.
- **Section controls:** refresh, edit (opens a raw-HTML textarea editor with a helpful hint: "You can use HTML tags like `<p>`, `<ul>`, `<li>`, `<strong>` for formatting"), save, and delete (with a proper "This cannot be undone" confirm dialog) all work.
- **Share:** copies the internal memo URL to the clipboard with a toast confirmation. Confirmed via network inspection this is **not** a public/external link (no API call fires) — it's a same-app deep link requiring login, so no security concern like the deal-sharing portal.
- **Export dropdown:** all three options work — Export as PDF (downloads), Export as Markdown (downloads), Copy to Clipboard (toast confirmation).
- **Legal docs for this deal panel:** collapses/expands correctly.
- **Generate All:** shows a proper progress dialog ("Generating exit analysis... (10/12)") with a working Cancel button.
- **AI Analyst panel collapse:** the chevron collapses the whole right panel to a thin strip, giving the memo canvas more width — works correctly.
- **AI Analyst quick-action chips** ("Rewrite for Tone", "Add EBITDA Bridge"): clicking pre-fills the chat input with a prompt rather than auto-sending — a safe, sensible UX.

---

## New findings

### A. "Change Template" is a dead end — the template manager is empty

Every memo's sidebar shows "Using: Standard IC Memo", with a "Change Template" link. Clicking it navigates to `/templates`, a "Firm-Wide Template Manager" with three tabs (Investment Memos, Diligence Checklists, Outreach Sequences) — **all three show "No templates found."**

There is no way to see what "Standard IC Memo" actually is, no way to select a different existing template (none are listed), and no indication of which template is currently applied. The only actions are "New Template" and "Create from Scratch" — neither helps someone who just wants to switch to a different pre-built template, because none exist in this list despite one clearly being in active use by every memo.

**Fix direction:** either seed "Standard IC Memo" as a real, visible entry in this list (most likely — it's probably a hardcoded default that was never migrated into the template-manager data model), or remove/relabel "Change Template" until there's something to change to.

### B. Three different, inconsistent error messages for the same root cause — one of them is factually wrong

This is the most important finding. The same underlying problem (Anthropic API credit exhaustion) surfaces **three different ways** depending on which code path triggered it:

1. **Raw error dump** (original section content, e.g. sections never touched by "Generate All"):
   ```
   [Section generation failed: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_..."}]
   ```
   This is the previously-reported bug (#12) — correct diagnostic info, but shown raw to end users and leaks into exports.

2. **"Generate All" bulk regeneration** overwrites sections with a cleaner-looking but **factually wrong** message:
   ```
   [AI couldn't generate this section: AI API key is invalid or missing. Please check your configuration.]
   ```

3. **AI Analyst chat** (clicking "Add EBITDA Bridge" then sending) shows the same wrong message in a clean chat bubble:
   ```
   AI API key is invalid or missing. Please check your configuration.
   ```

The real cause — confirmed consistently everywhere else in the app including `vercel logs` per this repo's own `CLAUDE.md` — is **credit balance exhaustion**, not an invalid or missing API key. Paths #2 and #3 appear to go through a *different*, more generic error handler that doesn't inspect the actual Anthropic error type/message and defaults to an "invalid API key" assumption.

**Why this matters:** an engineer debugging via the UI (rather than logs) would be misdirected into checking API key configuration instead of the Plans & Billing credit balance — exactly backwards from the real fix. This is a classification bug independent of the credit balance itself being empty.

**Fix direction:** find the error handler used by the "Generate All" and AI Analyst chat code paths and make it surface the actual Anthropic error type/message (as path #1 does, just without the raw JSON) instead of a hardcoded "API key invalid" assumption. Ideally there's one error-formatting function all three paths funnel through, with a friendly, *accurate* message: something like "AI is temporarily unavailable (credit balance exhausted) — contact your administrator" when the underlying error type is `invalid_request_error` with "credit balance" in the message, versus a genuinely different message for an actual auth/key failure.

### C. Duplicate sections confirmed again, now also directly observable after "Generate All"

Re-confirms `docs/QA-REPORT-2026-10-06.md` #16b: this memo still has 17 sections where ~12 are expected, with Quality of Earnings, Management Assessment, Operational Deep Dive, Value Creation Plan, and Exit Analysis each appearing twice. "Generate All" dutifully (and wastefully, if credits were available) tried to regenerate both copies of every duplicated section.

### D. "Compliance Check" panel makes a static claim that's currently untrue

The panel reads "All citations are verified against the data room" regardless of actual section content — right now every section is either a raw error or "AI couldn't generate this section," i.e., there are no citations to verify, yet the panel asserts they're all verified. Minor, but worth either making this panel conditional on there being real generated content, or rewording it to not imply a guarantee that isn't being checked.

---

## Scope note

Scrolled and clicked through the entire page: filter tabs, search, full memo list, every per-section icon (refresh/edit/save/delete) on multiple sections, Share, both Export dropdown items plus Copy to Clipboard, Change Template, Compliance Check, Legal docs toggle, Generate All (full progress-to-completion), AI Analyst chat (chip pre-fill + send), and the panel collapse control. Did not test drag-reordering sections (the `drag_indicator` handles) since that requires simulating a drag gesture rather than a click — flagging as untested, not confirmed working.

---

## Addendum: Settings deep sweep + fixes shipped (same session, continued)

Two of this file's findings now have PRs open:
- **Finding B (misleading AI error message)** → PR #217 `fix/ai-error-classification-consistency` — migrated all 5 remaining call sites (memo chat, deal chat ×2, global chat ×2, Generate-All regenerate) from the legacy `classifyAIError(message)` to `classifyAIErrorObject(err)`, matching the pattern already fixed in `pipeline.ts`. Test-first, red→green verified, full suite + typecheck clean.
- **Finding A (fake "Standard IC Memo" label / Change Template dead end)** → PR #218 `fix/memo-template-label-accuracy` — the label was a hardcoded fallback never backed by a real template, and the page's only caller never even passed a real name. Now shows an accurate "No custom template" message instead of a fake specific name, with "Browse Templates" as the CTA. Test-first, red→green verified.

Further testing this session (Settings sub-pages, not yet in a prior report):

- **General, Security, Notifications, Firm Context, Firm Profile, Investment Criteria, Firm Teaser, Team** — no console errors on any of these; all forms, toggles, and modals work correctly.
- **Scroll-spy bug (original report #5) reproduces again** — confirmed twice more in Settings: clicking "Notifications" left "Firm Context" highlighted while Notification Preferences content showed; clicking "Firm Profile" left "Investment Criteria" partially highlighted too. Same unfixed issue, now confirmed across more of the page than previously documented.
- **Notification toggles correctly track unsaved state** — toggling a switch triggers a real browser "leave site?" warning on navigation, and the change correctly reverts if you leave without saving. Good, deliberate UX — not a bug.
- **Firm Profile AI research is honest, not hallucinated** — with "Firm Website" pointing at an unrelated company (oasisindia.in, a fertility clinic — likely stale/wrong test data, not a code bug), the AI-generated description correctly said *"The provided website content is for Oasis Fertility... not an investment firm called 'PocketFund'. No information about an investment firm named PocketFund was found in the source material"* instead of fabricating a plausible-sounding firm profile. Worth noting as a positive finding, and worth telling the founder the Firm Website field itself looks misconfigured (not a code issue).
- **Firm Teaser "Add profile"** — creates and deletes cleanly, with a proper "This cannot be undone" confirm dialog.
