# PE OS — HubSpot Import Testing Guide

**For:** QA / Non-technical team members
**Last Updated:** 2026-08-12

**What this covers:** Step-by-step instructions to test the HubSpot CRM import — connecting a HubSpot account, importing Companies/Contacts/Deals, importing activity history (Notes/Calls/Meetings/Emails/Tasks), and the edge cases fixed across PRs #88, #89, #91, #100, and #79.

> **Prerequisites:**
>
> - You must be logged in to PE OS as an org admin
> - You need a HubSpot account you can create a **Private App** in (a free HubSpot developer test account works fine — don't point this at a real client's live HubSpot portal for a first test pass)
> - All of #88/#89/#91/#100/#79 are merged and deployed to production as of 2026-08-11, and the `hubspotId` column migration (`apps/api/hubspot-engagement-import-migration.sql`) has been run manually in Supabase — both confirmed, you're clear to start
> - **This is genuinely the first live test of this feature end to end.** Everything up to now has been verified against automated tests and mocks, never against HubSpot's real API — treat anything that looks off as worth reporting, not as "probably just me"
> - Budget ~30-45 minutes for a full pass

---

## Quick Overview

| # | Area | Where to Find It | What It Does |
|---|------|-------------------|---------------|
| 1 | Connect | Settings → Integrations | Store a HubSpot Private App token |
| 2 | Core import | Settings → Integrations | Pull Companies, Contacts, Deals from HubSpot |
| 3 | Custom fields | Contact/Deal detail page | Any HubSpot field without a dedicated column shows in an "Imported from HubSpot" card |
| 4 | Re-import safety | Settings → Integrations | "Overwrite existing values" checkbox controls whether re-running can correct data |
| 5 | Activity history | Contact detail page | Notes, Calls, Meetings, Emails, Tasks show in the contact's interaction feed |
| 6 | Missing-scope handling | Settings → Integrations | Import still succeeds for Companies/Contacts/Deals even if engagement scopes are missing |

---

## Step 0: Set up test data in HubSpot

Before testing, create a small, deliberately messy set of test records in HubSpot so you can verify edge cases, not just the happy path:

1. **A Company** with a custom property (e.g. create a custom property called `fund_vintage`, set it to `2021`) and standard fields filled in: industry, address (city/state/country), employee count, website.
2. **2-3 Contacts**, at least one linked to the company above, with a job title, phone, and mobile phone.
3. **A Deal** linked to the company, with an amount, a close date, and a stage — pick a stage that isn't obviously "won" or "lost" in name (e.g. "1st Pass Review" or "Qualification") so you can check stage-mapping doesn't misfile it.
4. **On one contact**, log at least one of each: a Note, a Call (with a duration), a Meeting (with 2+ attendees if your portal allows it), and a Task (with a due date, status, and priority).
5. **Two companies with the exact same name** (e.g. two "Acme Inc" records) — tests the duplicate-name handling.

### Get your Private App token

1. In HubSpot: **Settings → Integrations → Private Apps → Create a private app**
2. Under **Scopes**, grant all 11 of the following (the error message in PE OS will also list these if you forget one):
   - `crm.objects.companies.read`
   - `crm.objects.contacts.read`
   - `crm.objects.deals.read`
   - `crm.objects.notes.read`
   - `crm.objects.calls.read`
   - `crm.objects.meetings.read`
   - `crm.objects.emails.read`
   - `crm.objects.tasks.read`
   - `crm.schemas.companies.read`
   - `crm.schemas.contacts.read`
   - `crm.schemas.deals.read`
3. Copy the token — it starts with `pat-`. You'll paste it into PE OS in Test 1.

> **Note:** three of the object-read scope names (`calls.read`, `meetings.read`, `tasks.read`) were not independently confirmed against HubSpot's own docs when this was built — if any of them don't appear in your portal's scope picker, that's expected and worth reporting back, not a sign you're doing something wrong. The three `crm.schemas.*` scopes are what let custom-field discovery work at all — without them, custom fields silently don't import (see Test 6).

---

## Test 1: Connect HubSpot

**Where:** Settings → Integrations

### Steps:
1. Go to **Settings**, find the **HubSpot CRM Import** card
2. Paste your Private App token into the field
3. Click **Connect HubSpot**

### What to expect:
- On success: the card switches to a "connected" view with a green dot and a **Disconnect** button
- On failure: a red error message explaining what's wrong

### What to check:
- [ ] A token with a typo or missing "pat-" prefix shows a clear "didn't recognize this token" error, not a generic failure
- [ ] If you deliberately create a Private App with only the original 3 scopes (companies/contacts/deals) and try to connect, note whether you get a scope warning or it just connects — **known gap:** connect-time validation only checks the `companies` scope, so a token missing engagement scopes will connect successfully here and only fail later, mid-import. That's expected, not a bug to report.

### If something goes wrong:
- **"HubSpot rejected this token"** — regenerate the Private App token in HubSpot and re-paste
- **Nothing happens on click** — check the browser console for a network error; the API may not be deployed yet

---

## Test 2: Core import (Companies, Contacts, Deals)

**Where:** Settings → Integrations, after connecting

### Steps:
1. Leave **"Overwrite existing values with HubSpot data"** unchecked (default)
2. Click **Import from HubSpot**
3. Watch the progress card — it polls every 2 seconds and shows per-object counts

### What to expect:
- Status moves from "running" to "completed"
- Each of Companies/Contacts/Deals shows a count like "3 imported · 0 failed"

### What to check — field accuracy:
- [ ] Your test Company's `fund_vintage` custom field, industry, address, employee count, and website all made it in (custom field appears on the deal/contact linked to it — see Test 3 for where)
- [ ] Contacts show job title, phone, **and** mobile phone (not just phone)
- [ ] The Deal's stage matches what you set in HubSpot — specifically, if you used an ambiguous name like "1st Pass Review," confirm it did **not** get mapped to a "declined/passed" state in PE OS. Open the deal and check its pipeline stage.
- [ ] The Deal's close date and amount are correct
- [ ] The two duplicate-named companies both imported without one overwriting the other or the import erroring out

### What to check — re-running is safe:
1. Click **Import from HubSpot** a second time, still with "Overwrite" unchecked
2. [ ] Counts don't double (re-import matches existing records, doesn't create duplicates)
3. Go into HubSpot and change the Company's industry field, then re-import
4. [ ] With "Overwrite" **unchecked**: the changed value should NOT overwrite what's already in PE OS
5. Check **"Overwrite existing values with HubSpot data"** and re-import
6. [ ] With "Overwrite" **checked**: the changed value from HubSpot now DOES win

### If something goes wrong:
- **Status shows "failed" with a raw error mentioning MISSING_SCOPES** — go back to your Private App and confirm all 11 scopes from Step 0 are granted
- **A count looks wrong** — check the failed count too; a non-zero "failed" means specific records errored (check server logs, or report back with the object type and count)

---

## Test 3: Custom fields and imported data visibility

**Where:** Contact detail panel, Deal overview tab

### Steps:
1. Open the Contact linked to your test Company
2. Scroll to find a card titled **"Imported from HubSpot"**
3. Open the linked Deal and check its overview tab for the same kind of card

### What to expect:
- The card lists field/value pairs for anything HubSpot sent that doesn't have a dedicated PE OS column — this is where your `fund_vintage` custom field should appear
- Dates (like a close date stored in this blob) render as readable dates, not raw numbers
- If there are more than 8 fields, a "Show N more" button appears

### What to check:
- [ ] `fund_vintage` (or whatever custom field you created) appears with a readable label, not the raw HubSpot internal name
- [ ] No card appears at all for a record that was **not** imported from HubSpot (e.g. a contact you created manually in PE OS) — the card should only show up when there's actually HubSpot data to display

---

## Test 4: Activity history import (Notes, Calls, Meetings, Emails, Tasks)

**Where:** Contact detail panel, "Activity"/interaction feed

### Steps:
1. Make sure you logged at least one Note, Call, Meeting, and Task on a contact in HubSpot (Step 0.4)
2. Run (or re-run) **Import from HubSpot**
3. Open that contact's detail panel and look at the interaction feed

### What to expect:
- Each HubSpot Note/Call/Meeting/Email/Task appears as an interaction entry
- A Call shows its duration and direction in the description
- A Meeting shows its outcome in the description
- A Task's title is prefixed with `[Task]` and its description includes status and priority
- If your test Meeting had 2+ attendees, it should appear on **each** attendee's contact page, not just one

### What to check:
- [ ] All 5 types you logged in HubSpot show up somewhere in PE OS
- [ ] The multi-attendee meeting appears on every attendee's feed
- [ ] Re-running the import doesn't duplicate these entries
- [ ] An engagement in HubSpot associated with a **company only** (no contact) — expected to be silently skipped, not imported anywhere. This is a known, deliberate scope decision, not a bug.

### If something goes wrong:
- **Nothing shows up at all** — check the progress card's per-object counts for `notes`/`calls`/`meetings`/`emails`/`tasks`; if they're all "0 imported," the token may be missing engagement scopes (expected if you skipped some in Step 0)

---

## Test 5: Missing-scope handling (the main thing PR #91's later fixes were about)

**Where:** Settings → Integrations

This is the scenario that motivated the most back-and-forth in this feature's build — worth testing deliberately, not just as a side effect of Test 4.

### Steps:
1. In HubSpot, create a **second** Private App token with only the original 3 scopes: `crm.objects.companies.read`, `crm.objects.contacts.read`, `crm.objects.deals.read` — deliberately leave out all 5 engagement scopes
2. Disconnect your current connection in PE OS, connect with this new token
3. Run **Import from HubSpot**

### What to expect:
- Companies, Contacts, and Deals should still import successfully with real counts
- The job should end with status **"completed"**, not "failed" — even though notes/calls/meetings/emails/tasks all show "0 imported"
- An error message should be visible somewhere on the card (in small text near the status), mentioning a 403 or missing scope — this is expected raw/technical text, not yet a friendly message (known gap)
- The status line should **not** show something self-contradictory like "completed (syncing tasks)"

### What to check:
- [ ] Status shows "completed," not "failed"
- [ ] Companies/Contacts/Deals counts are non-zero and correct
- [ ] No lingering "(syncing tasks)" or similar text next to "completed"
- [ ] Reconnect with your full-scope token afterward and re-import — engagement data should now import on top, without needing to redo Companies/Contacts/Deals

### If something goes wrong:
- **Status shows "failed" instead of "completed"** — this would be a real regression of the main fix in this feature; report it with a screenshot of the full status line
- **Companies/Contacts/Deals show 0 imported too** — something more fundamental broke; report immediately, don't continue testing

---

## Test 6: Missing schema-scope handling (this is what PR #79 fixed — the most important test in this guide)

**Where:** Settings → Integrations, plus the "Imported from HubSpot" card from Test 3

This is the specific silent-failure mode PR #79 exists to prevent: a token with full object-read access but no schema-read access imports every record successfully, with correct-looking counts — but every custom field silently vanishes, with no error, no failed count, nothing to notice unless you specifically go looking.

### Steps:
1. In HubSpot, create a **third** Private App token with all 8 object-read scopes (companies/contacts/deals + the 5 engagement types) but **deliberately leave out all 3 `crm.schemas.*` scopes**
2. Disconnect your current connection in PE OS, connect with this new token
3. Run **Import from HubSpot**
4. Open the Contact/Deal linked to your test Company (the one with the `fund_vintage` custom field from Step 0) and check the "Imported from HubSpot" card

### What to expect:
- The import completes with status "completed" and non-zero counts for every object type — nothing about the job status or counts looks wrong
- The **"Imported from HubSpot" card is missing your custom field** (`fund_vintage` or whatever you created), or the card doesn't appear at all
- This is the exact bug PR #79 fixed the *messaging* for — the underlying HubSpot API behavior (property discovery 403s and silently falls back to standard fields) is unavoidable without the schema scopes; what changed is that the app now tells you upfront which scopes to grant, in the pre-connect instructions and the connect-time error message

### What to check:
- [ ] Job status still shows "completed" with normal-looking counts (confirms this failure mode is genuinely silent at the job-status level, which is why the scope messaging matters)
- [ ] Custom field is confirmed missing from the "Imported from HubSpot" card
- [ ] Reconnect with the full 11-scope token from Step 0 and re-import — the custom field should now appear

### If something goes wrong:
- **Custom field imports fine even without schema scopes** — worth reporting as a pleasant surprise, but re-verify you actually excluded all 3 schema scopes from the test token, since this would contradict the documented HubSpot API behavior this fix was based on
- **Job status shows "failed"** — same regression concern as Test 5

---

## Known limitations (expected — don't report these as new bugs)

- Connect-time validation only checks the `companies` scope, not the other 10. A token missing any other scope (engagement or schema) connects successfully and only shows the problem after you import — this is exactly why Tests 5 and 6 exist as deliberate checks, not just incidental ones.
- The mid-import error text is the raw HubSpot error string, not a friendly "here's which scope to grant" message.
- The "Import finished" success toast fires whenever status is "completed," even if some engagement types failed on missing scopes — check the detail card underneath, not just the toast, for the full picture.
- If an import ever hits its internal safety cap or crashes mid-run, the status card can show a stale "(syncing X)" next to the final status — a known, low-priority cosmetic gap, unlikely to come up with the small test dataset in this guide.
- No dedicated Task entity exists yet — imported HubSpot Tasks show up as generic interaction-feed entries, not as a separate to-do list with due-date reminders.
- Engagements associated with a company or deal but **no contact** are not imported anywhere (by design, this phase is contact-scoped only).
- A HubSpot portal with more than 250 custom properties on one object type will have some properties silently dropped (logged server-side, not surfaced in the UI).

## If you find something not on this list

Note down: which test number, what you did, what you expected, what actually happened, and the exact text of any error message shown. Screenshots of the Settings → Integrations progress card are especially useful since it's the main source of truth during an import.
