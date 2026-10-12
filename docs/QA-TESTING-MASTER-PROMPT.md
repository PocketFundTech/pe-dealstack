# Master prompt: exhaustive click-through QA testing

Copy everything below the line into a fresh Claude Code session (any machine, any repo checkout of this project) to have it run the same testing process used to produce `docs/QA-REPORT-2026-10-06.md`. Fill in the bracketed placeholders first.

---

## Prompt to paste

You are going to do exhaustive, real-browser QA testing of **app.avise.io** (or `[STAGING_URL]` if testing a non-prod environment), the same way a careful human tester would: log in, click every button, fill out every form, and verify the result actually happened — not just that the UI looked fine. Report back in a structured markdown file I can hand to an engineer.

### Tools

Use the `playwright-cli` skill to drive a real Chromium browser. Key commands you'll use constantly:
- `playwright-cli open` / `goto <url>` — navigate
- `playwright-cli snapshot --filename=x.yml` — get the accessibility tree (this is how you find every button/link/input and their refs — don't guess at UI, read the snapshot)
- `playwright-cli click <ref>`, `fill <ref> "<text>"`, `select <ref> "<option>"`, `press <key>`
- `playwright-cli screenshot --filename=x.png` — visual evidence
- `playwright-cli requests` — list network requests since last check; use this to confirm a button's click actually fired the expected API call and what status code came back (a 200/201 you can trust more than a toast)
- `playwright-cli console error` — check for JS errors after every significant action
- `playwright-cli eval "<js>"` — for anything the snapshot/click primitives can't do (scrolling a specific container, reading computed styles, hooking `window.open`/`window.print`, decoding a downloaded file)
- `playwright-cli upload <path>` — for file upload inputs (use the native file chooser that pops up after clicking an upload control)

Read the full `playwright-cli` skill before starting if you haven't used it before.

### Accounts

You need two kinds of test identity:

1. **A disposable QA org you can break freely.** Create it by signing up through the real `/signup` form in the browser (not by hand-crafting database rows — that leaves the org in a broken state with no owner/role set up correctly). If you need a *pre-confirmed* account to skip email verification, you can create one directly via the Supabase Admin Auth API using the service role key from `apps/api/.env` (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`) — but then you still need to go through the real onboarding flow (not skip it) for the org to be set up correctly with its billing/role records. Prefer just using the real `/signup` form with a throwaway email like `qa-test-<timestamp>@example.com` (`example.com` never delivers mail, so invites/NDAs sent during testing reach nobody).

2. **The real production account, if you're given credentials for it.** Use this to test features that only show up with real data (a deal with actual extracted financials, an org with team members, etc.) and to test role-gated features (Admin panel, API Keys, Webhooks — these require an ADMIN role, and a freshly-signed-up org's first user may incorrectly get MEMBER, which is itself a bug to report, not route around).

### Safety boundaries — do not skip these

This is production software with real data and real third parties connected to it (real colleagues, real email addresses, real deal data). Before clicking something, ask: **does this send something to a person who isn't in this conversation, or does it destroy/alter data the user didn't ask me to touch?**

- **Never** click destructive confirm actions (Deactivate Account, Delete Deal, Delete Organization) to completion unless explicitly told to and the target is your own disposable test data.
- **Never** send real communications (email invites, "Nudge" notifications, deal reassignments to real colleagues) on the real account without asking first — even though these are "just a notification," they reach a real human outside this conversation who didn't opt into being part of a test. On a disposable QA org this is fine since there's nobody real to surprise.
- If you hit something the environment's own safety classifier blocks (a "transient failure" or explicit denial), don't try to route around it with another tool/encoding — stop, note it in the report as untested, and tell the user what you were blocked from doing and why.
- If you edit a value on a **real** deal/org to test something (e.g. an entry multiple in a financial model, to check live recalculation), **revert it and re-save** before moving on, and verify the revert actually persisted (reload and check).
- Prefer read-only or reversible actions (download, view, open) over one-way actions when both would prove the same thing.

When genuinely unsure whether an action is safe to complete, stop and ask the user — don't guess.

### Methodology

For **every page** reachable from the main navigation and every sub-page under it:

1. Take a full snapshot. Identify every clickable control: buttons, links, dropdown/select menus, tabs, checkboxes, file upload zones, overflow/"more" menus (⋮), modals triggered from them.
2. Click each one. For each click:
   - Check `requests` for the API call it should have triggered — confirm the status code (2xx = success, 4xx/5xx = investigate), not just that the UI didn't visibly break.
   - Check `console error` for anything new.
   - Screenshot the result.
   - If it opened a modal/form, fill it with realistic test data and submit — don't just open and close every modal, actually complete at least one real flow per feature (create a thing, rename it, delete it, download it) so you catch bugs that only show up after a real round-trip (e.g. "saves successfully but the list doesn't refresh until reload" — you only catch this by actually reloading and checking).
   - If a button visibly does nothing (no navigation, no modal, no network request, no console error), that's a real bug — don't assume you mis-clicked; retry once with a fresh snapshot/ref, then report it as dead if it still does nothing.
3. Test responsive breakpoints for every major page: resize to 390×844 (phone), 768×1024 (tablet), 1280×800 (small laptop), 1920×1080 (desktop). Look for: overflowing/unreachable controls, text truncation, elements rendering vertically instead of horizontally, broken sidebars.
4. Test keyboard navigation on at least a couple of key pages: Tab through interactive elements, confirm focus rings are visible, confirm Enter activates the focused control the same way a click would, confirm Escape closes modals and returns focus sensibly.
5. For any numeric/financial feature (models, extracted statements, calculated returns): sanity-check the actual numbers, not just that something rendered. Cross-reference against source documents if the user gives you real input files — upload them, then compare every extracted figure against the source by hand. Flag anything that looks like a unit-scale error (a 1,000x or 1,000,000x jump between periods), an impossible ratio (IRR > 100%, a multiple > 20x), or numbers that don't match across two places that should agree (a summary tile vs. a detail table).
6. For anything involving an external provider (OAuth connections, e-signature, email send): trace it as far as you can without real credentials — does it reach the real provider's real login/consent screen with correct parameters (client_id, redirect_uri, scopes), or does it error out before getting there? That distinction (reaches-the-provider vs. doesn't) tells you whether the bug is server misconfiguration vs. something else, without needing to actually complete a third-party login.
7. When you find a bug: immediately try to find its root cause in the codebase (`grep`/`Explore` for the error string, the component, the API route) so the report can point an engineer at the right file instead of just the symptom. You don't have to fix it — just locate it if you can do so quickly.

### Annotating screenshots

For every confirmed bug, annotate the screenshot with a red box around the exact element so the reader doesn't have to hunt for it:

```python
from PIL import Image, ImageDraw
img = Image.open("bug.png").convert("RGB")
draw = ImageDraw.Draw(img)
box = (x0, y0, x1, y1)  # pixel coords of the element, from the screenshot
for i in range(4):
    draw.rectangle([box[0]-i, box[1]-i, box[2]+i, box[3]+i], outline=(255, 0, 0))
img.save("bug-annotated.png")
```

Get the coordinates either by eyeballing the screenshot or via `playwright-cli eval` reading `getBoundingClientRect()` on the element and scrolling it into view first.

### Reporting format

Write a single markdown file (`docs/QA-REPORT-<date>.md` or wherever the user wants it) structured like this:

```markdown
# QA Report — <date>

<one paragraph: what was tested, which accounts/environment, what was deliberately not tested and why>

## Summary table
| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | <one-line description> | Critical/High/Medium/Low | 🔴 Open / 🟡 Partial / ✅ Fixed |
...

## 1. <Finding title>
**Status:** ...
<description of what's broken, with concrete numbers/strings/status codes as evidence, not vague adjectives>
**Repro:** <exact steps>
**Root cause:** <file/function if you found it>
**Fix direction:** <concrete suggestion, not just "fix this">

...

## Recommended fix order
<prioritized list with one-line reasoning each>
```

Rules for the report itself:
- Every finding needs **evidence** (a status code, an exact error string, a screenshot reference) — never just "seems broken."
- State severity based on actual impact (data corruption/security > feature completely blocked > confusing but workable > cosmetic), not how annoying it was to find.
- If something looks broken but you're not sure it's not expected behavior (e.g. a confirmation step that seems slow but might just be a cold start), say so explicitly rather than asserting it's a bug.
- Don't pad the report with findings you didn't actually verify — "I clicked this and nothing happened" needs a retry-and-confirm, not a single click.
- Be upfront in the report about what you did *not* test and why (blocked by safety rules, needed real third-party credentials, etc.) — this is as important as what you did test, so the next person doesn't assume full coverage.

### When re-testing a claimed fix

Don't take "it's fixed" on faith — re-run the exact same repro steps from the original finding and check the same evidence (status code, screenshot, absence of the error string). If it's fixed, say so with the new evidence. If it's a different bug now, or only partially fixed, say exactly what changed and what didn't.

---

Now go test **[WHAT TO TEST — e.g. "the entire app, starting from login" or "just the Data Room and NDA features"]** on **[URL]**, logging in with **[CREDENTIALS OR "create your own disposable QA account"]**, and write the report to **[FILE PATH]**.
