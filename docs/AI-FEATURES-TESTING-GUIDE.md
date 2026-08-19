# Avise — AI Features Testing Guide

**For:** QA / Non-technical team members
**Last Updated:** March 10, 2026
**What this covers:** Step-by-step instructions to test all 5 AI-powered features built in Sessions 35-36.

> **Prerequisites:**
> - You must be logged in to Avise
> - You need at least 1 deal and 1 contact in the system
> - The API server must be running (ask the dev team if unsure)

---

## Quick Overview

| # | Feature | Where to Find It | What It Does |
|---|---------|-------------------|--------------|
| 1 | AI Contact Enrichment | Contacts page | Auto-fills a contact's profile using AI |
| 2 | AI Meeting Prep | Deal page | Generates a meeting brief for a deal |
| 3 | AI Email Drafter | Deal page | Writes professional emails with compliance checks |
| 4 | AI Deal Signals | Dashboard | Scans your portfolio for risks and opportunities |
| 5 | Email Templates | Inside Email Drafter | Pre-built email structures for common PE scenarios |

---

gan
## Test 1: AI Contact Enrichment

**Where:** Contacts page (`/contacts.html`)

### Steps:
1. Go to the **Contacts** page from the sidebar
2. Click on any contact card to open the detail panel (slides in from the right)
3. In the detail panel, look for the **"AI Enrich"** button — it has a sparkle icon and is near the top action buttons
4. Click **"AI Enrich"**
5. Wait 5-15 seconds (the button will show a spinning icon and say "Enriching...")

### What to expect:
- The button changes to "Enriching..." with a spinner while processing
- After completion, you should see enrichment results appear below the contact details
- Results may include: **job title, company info, industry, location, bio, areas of expertise, deal relevance score**
- A **confidence badge** shows how confident the AI is (green = high, amber = medium, red = low)
- If confidence is **70% or above** — data is auto-saved to the contact
- If confidence is **below 70%** — it's flagged for your review before saving

### What to check:
- [ ] Button shows loading state while processing
- [ ] Results appear after processing completes
- [ ] Confidence score is visible
- [ ] No error messages appear
- [ ] If you refresh the page and reopen the contact, enriched data persists (if confidence was high)

### If something goes wrong:
- **"Contact not found" error** — Make sure you have a contact selected (clicked on a card)
- **Spinning forever** — The AI request may have timed out. Wait 30 seconds, then try again
- **Network error** — Check if the API server is running (ask dev team)

---

## Test 2: AI Meeting Prep

**Where:** Deal page (`/deal.html?id=...`)

### Steps:
1. Go to any **Deal page** (click a deal from the pipeline or dashboard)
2. In the top-right corner, click the **three-dot menu** (⋮ button)
3. Scroll down in the dropdown — you'll see an **"AI Tools"** section header
4. Click **"Meeting Prep"** (has a calendar/note icon)
5. A full-screen modal opens with two optional fields:
   - **Meeting Topic** — e.g., "Q3 financial review", "Initial discussion", "Due diligence kickoff"
   - **Meeting Date** — pick a date or leave blank for "Today"
6. Click **"Generate Brief"**
7. Wait 10-20 seconds

### What to expect:
- A loading spinner shows while the AI generates the brief
- After completion, you'll see a structured brief with these sections:
  - **Headline** — one-line summary of the meeting context
  - **Deal Summary** — key facts about the deal
  - **Contact Profile** — who you're meeting with (if a contact is linked)
  - **Key Talking Points** — bullet points of what to discuss
  - **Questions to Ask** — suggested questions for the meeting
  - **Risks to Address** — potential concerns to bring up
  - **Document Highlights** — relevant docs from the data room
  - **Suggested Agenda** — proposed meeting flow
- Each section is displayed in a clean card layout

### What to check:
- [ ] Modal opens correctly when clicking "Meeting Prep"
- [ ] Generate button shows loading state
- [ ] Brief appears with all sections after generation
- [ ] Content is relevant to the specific deal (mentions deal name, industry, etc.)
- [ ] Modal can be closed with the X button or clicking outside
- [ ] No error messages

### Tips:
- The more data a deal has (financials, documents, contacts), the better the brief will be
- Try with different topics to see how the output changes

---

## Test 3: AI Email Drafter

**Where:** Deal page (`/deal.html?id=...`)

### Steps:
1. Go to any **Deal page**
2. Click the **three-dot menu** (⋮) in the top-right
3. Under **"AI Tools"**, click **"Draft Email"** (has a pencil/note icon)
4. A full-screen modal opens with these fields:
   - **Purpose** (required) — What the email is about. E.g., "Schedule a follow-up meeting to discuss Q3 financials" or "Request due diligence documents"
   - **Template** (optional) — Pick from 7 pre-built templates:
     - Initial Deal Outreach
     - Follow-Up After Meeting
     - Due Diligence Document Request
     - LOI Introduction
     - Deal Status Update
     - Meeting Request
     - Thank You / Relationship Building
   - **Tone** (optional) — Choose: Professional, Friendly, Formal, Direct, or Warm
5. Click **"Generate Draft"**
6. Wait 15-25 seconds (this runs 3 AI checks: draft → tone check → compliance check)

### What to expect:
- Loading spinner while AI generates the email
- After completion, you'll see:
  - **Subject Line** — suggested email subject
  - **Email Body** — full draft text, properly formatted
  - **Tone Score** — a gauge/score (0-100) showing how well the tone matches your selection
  - **Tone Notes** — specific feedback on the tone
  - **Compliance Status** — either a green "Ready for Review" badge or a red "Compliance Issues" badge
  - **Compliance Issues** (if any) — specific items flagged (e.g., promissory language, MNPI concerns)
  - **Suggestions** — tips to improve the email
  - **Copy to Clipboard** button — one-click copy of the email text

### What to check:
- [ ] Modal opens and templates load in the dropdown
- [ ] All 7 templates appear in the template picker
- [ ] All 5 tone options appear in the tone selector
- [ ] Generate button shows loading state
- [ ] Email draft appears with subject and body
- [ ] Tone score is displayed (number between 0-100)
- [ ] Compliance status badge is visible (green or red)
- [ ] "Copy to Clipboard" button works — paste into a text editor to verify
- [ ] Content is relevant to the deal
- [ ] Try different templates and tones to see output differences

### Compliance checks explained:
The AI checks the email for:
- Material non-public information (MNPI) leaks
- Promissory/binding language that shouldn't be in email
- Forward-looking statements without disclaimers
- Confidentiality concerns
- Regulatory issues (FCPA, anti-bribery)

---

## Test 4: AI Deal Signals (Portfolio Scanner)

**Where:** Dashboard page (`/dashboard.html`)

### Steps:
1. Go to the **Dashboard** (main home page after login)
2. Look for the **"AI Deal Signals"** widget card — it should be in the right column
3. You'll see an empty state message: "No signals yet. Click Scan to analyze your portfolio."
4. Click the **"Scan Signals"** button (navy blue button with radar icon)
5. Wait 15-30 seconds (scans up to 30 active deals in your portfolio)

### What to expect:
- The button changes to "Scanning..." with a spinning icon
- A loading animation appears in the widget
- After completion, you'll see **signal cards** — each one represents a risk or opportunity detected:
  - **Critical signals** — Red badge, high priority (e.g., leadership change, risk escalation)
  - **Warning signals** — Amber/yellow badge, medium priority (e.g., financial event, competitive threat)
  - **Info signals** — Blue badge, informational (e.g., growth opportunity, milestone approaching)
- Each signal card shows:
  - **Signal type badge** (e.g., "Leadership Change", "Market Shift", "Financial Event")
  - **Deal name** it relates to
  - **Title** — brief description of the signal
  - **Description** — 1-2 sentence explanation
  - **Suggested Action** — what you should do next

### What to check:
- [ ] "Scan Signals" button shows loading state
- [ ] Empty state message disappears when scanning starts
- [ ] Signal cards appear after scan completes
- [ ] Each signal has a colored severity badge (red/amber/blue)
- [ ] Signal type is labeled (e.g., "market_shift", "risk_escalation")
- [ ] Deal name is shown on each signal
- [ ] Description and suggested action are present
- [ ] Multiple deals are covered (not just one)
- [ ] No error messages

### Notes:
- You need at least a few active deals for meaningful signals
- The AI generates realistic signals based on deal stage, industry, and current data
- Critical/warning signals are also saved as activities on the deal's activity feed

---

## Test 5: Email Templates (inside Email Drafter)

**Where:** Inside the Email Drafter modal (see Test 3)

### Steps:
1. Open the Email Drafter modal (Deal page → ⋮ menu → Draft Email)
2. Click the **Template** dropdown
3. Verify all 7 templates are listed:

| Template | Use Case |
|----------|----------|
| Initial Deal Outreach | First contact with a target company |
| Follow-Up After Meeting | Thank you + recap after a meeting |
| Due Diligence Document Request | Requesting docs during DD phase |
| LOI Introduction | Introducing letter of intent terms |
| Deal Status Update | Updating stakeholders on deal progress |
| Meeting Request | Requesting a new meeting |
| Thank You / Relationship Building | Nurturing relationships post-deal |

4. Select a template, enter a purpose, and generate — the output should follow the template's structure

### What to check:
- [ ] All 7 templates appear in the dropdown
- [ ] Template names match the table above
- [ ] Selecting a template doesn't break the form
- [ ] Generated email follows the template structure (check if sections match)

---

## Troubleshooting

| Problem | Likely Cause | Solution |
|---------|-------------|----------|
| Button does nothing when clicked | JavaScript error | Open browser console (F12 → Console tab) and share the red error with the dev team |
| "Failed to fetch" or network error | API server is down | Ask dev team to check if the API is running on port 3001 |
| "Contact not found" / "Deal not found" | Missing data | Make sure you have the contact/deal open before clicking the AI button |
| Spinning forever (> 60 seconds) | AI timeout | Refresh the page and try again. If it keeps happening, the AI provider (OpenAI) may be slow |
| "No LLM provider configured" | Missing API key | Ask dev team to check the `OPENAI_API_KEY` environment variable |
| Empty or generic results | Not enough deal data | Add more info to the deal (financials, documents, contacts) and try again |

---

## How to Report Bugs

When reporting an issue, please include:
1. **Which feature** you were testing (e.g., "AI Meeting Prep")
2. **What you clicked** (step-by-step)
3. **What happened** vs. **what you expected**
4. **Screenshot** of the error (if visible)
5. **Console errors** — Press F12, go to Console tab, screenshot any red text
6. **Deal/Contact name** you were testing with

---

*This guide covers all AI features built in Sessions 35-36. All other features (Pipeline, VDR, Financials, Analysis, Contacts CRUD) are covered in the main app and have been working since earlier sessions.*
