# Avise — Beta Launch Kit

**Goal:** Onboard 10-15 beta users, validate PMF, collect feedback, iterate fast
**Date:** March 27, 2026

---

## Table of Contents
1. [Readiness Audit](#1-readiness-audit)
2. [Pre-Beta Checklist](#2-pre-beta-checklist)
3. [Beta User Selection](#3-beta-user-selection)
4. [Onboarding Playbook](#4-onboarding-playbook)
5. [Feedback Collection System](#5-feedback-collection-system)
6. [Success Metrics](#6-success-metrics)
7. [Known Issues & Workarounds](#7-known-issues--workarounds)
8. [Communication Templates](#8-communication-templates)
9. [Week-by-Week Beta Plan](#9-week-by-week-beta-plan)
10. [Post-Beta Decision Framework](#10-post-beta-decision-framework)

---

## 1. Readiness Audit

### READY (ship as-is)

| Area | Status | Notes |
|------|--------|-------|
| Deal Pipeline (Kanban) | Ready | Full CRUD, drag-drop, stage management |
| AI Financial Extraction | Ready | 3-layer extraction + self-correction, the core wedge |
| 13 Analysis Modules | Ready | Auto-generated from extracted financials |
| Virtual Data Room | Ready | Upload, folders, smart filters, sharing, insights |
| Investment Memo Builder | Ready | Templates, AI section generation, chat per section |
| Contact CRM | Ready | Import/export, relationship scoring, AI enrichment |
| AI Deal Chat | Ready | 6 tools, document search, financial queries |
| Multi-Tenant Isolation | Ready | 33 endpoints secured, 34 automated tests |
| Auth Flow | Ready | Signup, login, email verify, password reset, team invites |
| Rate Limiting | Ready | 3 tiers: general, AI, write endpoints |
| Error Tracking | Ready | Sentry configured (needs DSN in production) |
| Legal Pages | Ready | Privacy policy + terms of service exist |
| Landing Page | Ready | Hero, features, CTAs |
| Pricing Page | Ready | 3 tiers with monthly/annual toggle |

### NEEDS WORK (fix before beta)

| Area | Issue | Effort | Priority |
|------|-------|--------|----------|
| **No Billing/Payments** | Pricing page has no Stripe integration — CTAs don't collect payment | 2-3 days | P1 for paid beta, skip for free beta |
| **No Product Analytics** | Can't track what users actually do — no Mixpanel/PostHog/Plausible | 1 day | P1 — you're flying blind without this |
| **No Onboarding Flow** | After signup, user lands on empty dashboard with no guidance | 1-2 days | P1 — first impression makes or breaks beta |
| **No Feedback Widget** | No in-app way for beta users to report bugs or give feedback | 0.5 day | P1 — need structured feedback channel |
| **No Welcome Email** | Signup creates account but sends no welcome/getting-started email | 0.5 day | P2 — personal onboarding call covers this |
| **Sentry DSN Not Set** | Error tracking code exists but DSN env var may not be configured | 10 min | P1 — must catch crashes during beta |
| **API Key Rotation** | OpenAI, Gemini, Resend keys may still be dev keys | 30 min | P1 — dev keys have low rate limits |
| **Portfolio Page** | Shows "Coming Soon" — beta users will click it | 0 | P3 — acceptable for beta, set expectations |

### MISSING (not needed for beta, but note it)

| Area | Notes |
|------|-------|
| Stripe Billing | Beta can be free or invoice-based — no self-serve payment needed yet |
| SSO / SAML | Enterprise feature, not needed for beta with <15 users |
| Mobile App | PE workflows are desktop — not a beta blocker |
| Salesforce Integration | Nice-to-have, not a beta requirement |
| Custom Reporting | Build after you know what reports users actually want |

---

## 2. Pre-Beta Checklist

### Technical (Do These First)

- [ ] **Set up product analytics** — Add PostHog (free up to 1M events) or Mixpanel (free up to 20M). Track:
  - Signup completed
  - First deal created
  - First CIM uploaded
  - First extraction completed
  - First memo created
  - First team invite sent
  - Daily active users
  - Feature usage (which modules get opened)
- [ ] **Set Sentry DSN** in Vercel env vars — catch every error from day 1
- [ ] **Rotate API keys** — Fresh OpenAI + Gemini keys with proper rate limits for beta load
- [ ] **Set APP_URL** in Vercel env vars → `https://pe-dealstack.vercel.app` (for invitation links)
- [ ] **Set RESEND_API_KEY** + verify sending domain (or use manual invite links as fallback)
- [ ] **Test the full signup → first deal → CIM upload flow** end-to-end on production
- [ ] **Create a demo deal** with sample CIM data that new users can explore immediately
- [ ] **Set ALLOWED_ORIGINS** if using custom domain

### Product (Build These)

- [ ] **Build onboarding checklist widget** — After signup, show a persistent card:
  ```
  Getting Started with Avise
  ☐ Create your first deal
  ☐ Upload a CIM or financial document
  ☐ Review AI-extracted financials
  ☐ Try "Chat with Deal"
  ☐ Invite a team member
  ```
- [ ] **Add empty states** — When deal list, contacts, or VDR is empty, show helpful CTAs instead of blank pages
- [ ] **Add feedback button** — Floating button or nav item → opens form (Google Form, Typeform, or Canny.io free tier)
- [ ] **Add "Beta" badge** — Small badge in header/sidebar so users know this is beta and set expectations
- [ ] **Prepare sample CIM PDF** — A demo CIM that showcases the extraction magic (anonymized)

### Content & Assets

- [ ] **Record demo video** (2 min Loom) — CIM upload → extraction → analysis → memo
- [ ] **Write help docs** for top 5 workflows (or make Loom walkthroughs):
  1. How to create a deal and upload documents
  2. How AI financial extraction works
  3. How to use "Chat with Deal"
  4. How to build an investment memo
  5. How to invite team members
- [ ] **Prepare beta welcome email** (template below)
- [ ] **Prepare beta feedback survey** (template below)
- [ ] **Create a private Slack channel or WhatsApp group** for beta users (direct line to you)

---

## 3. Beta User Selection

### Ideal Beta User Profile

| Criteria | Why |
|----------|-----|
| **Emerging PE manager** (Fund I-III, <$500M AUM) | Underserved by DealCloud, makes fast decisions, price-sensitive |
| **Associate or VP level** | Primary daily user of any deal management tool |
| **Actively evaluating deals** | Has real CIMs to upload — tests the wedge feature with real data |
| **Technically comfortable** | Won't get blocked by minor UX issues |
| **Willing to give feedback** | Will actually respond to surveys and join calls |
| **Small team (2-5)** | Tests team collaboration without overwhelming support |

### Where to Find Them

| Source | Approach |
|--------|----------|
| **Your personal network** | Best first 5 users — people who'll be honest with you |
| **SearchFunder.com** | Post: "Looking for 10 PE firms to beta test our AI deal management tool — free for 3 months" |
| **LinkedIn DMs** | Target associates/VPs at Fund I-II PE firms. Personalized message + demo video |
| **PE LinkedIn groups** | "Emerging Manager Resources", "Private Equity Professionals" |
| **AngelList / Wellfound** | PE-adjacent startup founders who've raised and manage portfolios |
| **Business school alumni networks** | MBA grads at PE shops — early adopter mentality |

### Beta Cohort Plan

| Cohort | Size | When | Purpose |
|--------|------|------|---------|
| **Alpha** (internal) | 3-5 people | Week 0 | Your team + close friends in PE. Find showstoppers. |
| **Beta Wave 1** | 5 firms | Week 1-2 | Core feedback loop. High-touch onboarding calls. |
| **Beta Wave 2** | 5-10 firms | Week 3-4 | Validate fixes from Wave 1. Lower-touch onboarding. |

---

## 4. Onboarding Playbook

### For Each Beta User (High-Touch)

**Day 0 — Welcome (15 min)**
1. Send welcome email with credentials + demo video link
2. Schedule 30-min onboarding call within 48 hours
3. Add them to beta Slack/WhatsApp group

**Day 1-2 — Onboarding Call (30 min)**
1. Screen-share walkthrough of their first deal setup
2. Upload one of THEIR actual CIMs live — watch their reaction to AI extraction
3. Show them Deal Chat ("ask it anything about this deal")
4. Help them invite 1-2 team members
5. Set expectations: "This is beta — things may break. Here's how to report issues."

**Day 3-7 — Follow Up**
1. Check in via Slack/WhatsApp: "How's it going? Any blockers?"
2. Monitor their analytics — did they create a second deal? Upload more docs?
3. If they're stuck, offer another 15-min call

**Day 14 — Feedback Call (20 min)**
1. What's working? What's frustrating?
2. What features are you actually using daily?
3. Would you pay for this? How much?
4. What would make you recommend this to a peer?

**Day 30 — Decision Call (15 min)**
1. NPS question: "How likely to recommend Avise? (0-10)"
2. Conversion: "We're moving to paid plans next month — interested?"
3. Testimonial ask: "Can I quote you on [thing they said]?"

### Onboarding Checklist (In-App)

```
Welcome to Avise Beta! 🎯

Here's how to get started:

1. Create your first deal
   → Click "New Deal" → Enter company name, sector, stage

2. Upload a CIM or financial document
   → Go to deal → Data Room tab → Upload PDF or Excel

3. Watch AI extract financials
   → Go to deal → Financials tab → Click "Extract"
   → AI reads your document and builds financial tables in ~30 seconds

4. Explore the analysis
   → Scroll down on Financials → 13 analysis modules auto-generated

5. Chat with your deal
   → Deal page → Chat tab → Ask "What are the key risks?"

6. Invite your team
   → Settings → Team → Invite by email
```

---

## 5. Feedback Collection System

### Channels (Use ALL of These)

| Channel | What It Captures | Tool |
|---------|-----------------|------|
| **In-app feedback button** | Bugs, UX friction, feature requests | Canny.io (free) or Google Form |
| **Beta Slack/WhatsApp group** | Quick questions, real-time issues, casual feedback | Slack (free) or WhatsApp |
| **Bi-weekly survey** | Structured satisfaction data, NPS, feature ranking | Typeform or Google Form |
| **Onboarding + feedback calls** | Deep qualitative insights, "aha moments", frustrations | Zoom + notes in a shared doc |
| **Product analytics** | What users actually DO (vs. what they say) | PostHog / Mixpanel |
| **Error tracking** | Crashes, API failures, JS errors | Sentry |

### Beta Feedback Survey (Send Week 2 + Week 4)

```
Avise Beta Feedback — [Week X]

1. How often did you use Avise this week?
   ○ Daily  ○ 2-3 times  ○ Once  ○ Didn't use it

2. Which features did you use? (check all)
   ☐ Deal Pipeline  ☐ Financial Extraction  ☐ Analysis  ☐ VDR
   ☐ Memo Builder  ☐ Deal Chat  ☐ Contacts  ☐ Meeting Prep

3. What's the ONE feature you find most valuable?
   [free text]

4. What's the ONE thing that frustrated you most?
   [free text]

5. Did AI Financial Extraction work well on your documents?
   ○ Perfect  ○ Mostly accurate  ○ Needed corrections  ○ Didn't work

6. How likely are you to recommend Avise to a colleague? (0-10)
   [NPS slider]

7. If Avise cost $499/month, would you pay for it?
   ○ Definitely  ○ Probably  ○ Unsure  ○ No

8. What's missing? What would make this a must-have?
   [free text]
```

### Tracking Spreadsheet

Create a Google Sheet with tabs:

| Tab | Columns |
|-----|---------|
| **Users** | Name, Firm, AUM, Role, Signup Date, Onboarding Call Date, Status (Active/Churned) |
| **Feedback** | Date, User, Type (Bug/Feature/UX), Description, Priority, Status (Open/Fixed) |
| **NPS** | Date, User, Score, Verbatim |
| **Feature Requests** | Feature, # Users Requesting, Effort Estimate, Priority |
| **Activation** | User, First Deal (Y/N + date), First CIM (Y/N + date), First Extraction, First Memo, Invited Team |

---

## 6. Success Metrics

### North Star: "Would you pay for this?"

| Metric | Target (30 days) | How to Measure | Red Flag |
|--------|-------------------|----------------|----------|
| **Activation Rate** | 80% complete first CIM extraction | Analytics + manual tracking | <50% — onboarding is broken |
| **Weekly Active Users** | 60% of beta users use it weekly | PostHog/Mixpanel | <30% — product isn't sticky |
| **CIMs Processed** | 3+ per active user | API logs (extraction endpoint hits) | <1 — extraction isn't reliable enough |
| **NPS Score** | 40+ (good for B2B beta) | Survey responses | <20 — major product issues |
| **Willingness to Pay** | 50%+ say "definitely" or "probably" | Survey Q7 | <30% — value prop isn't landing |
| **Extraction Accuracy** | 85%+ "perfect or mostly accurate" | Survey Q5 + support tickets | <70% — need extraction improvements |
| **Retention (Week 2→4)** | 70% still active in week 4 | Login tracking | <50% — novelty wore off, not habit-forming |

### PMF Signal (Sean Ellis Test)
Ask every beta user: **"How would you feel if you could no longer use Avise?"**
- Very disappointed → PMF signal
- Somewhat disappointed → Getting close
- Not disappointed → Not there yet

**Target: 40%+ say "very disappointed"** = you have PMF.

---

## 7. Known Issues & Workarounds

Share this with beta users proactively (builds trust):

| Issue | Workaround | Fix Timeline |
|-------|------------|-------------|
| Portfolio page says "Coming Soon" | Not available in beta — focus is on deal-level features | Post-beta |
| Invitation emails may not deliver | Use "Share Invite Link Manually" popup to copy the link directly | Free Resend plan limitation |
| Some complex CIM layouts may not extract perfectly | Use "Edit" button to manually correct extracted values. Chat us on Slack. | Continuous improvement |
| AI extraction costs ~$0.05-0.15 per document | No cost to beta users — included free during beta | N/A |
| No mobile app | Use desktop browser (Chrome recommended) | Not planned near-term |
| No Stripe billing | Beta is free. We'll reach out about paid plans before beta ends. | End of beta |

---

## 8. Communication Templates

### Beta Invitation Email

```
Subject: You're invited to beta test Avise — AI-powered deal management

Hi [Name],

I'm building Avise — an AI-powered CRM specifically for private equity deal management.
We're looking for 10 PE professionals to beta test it (free for 3 months).

What it does:
• Upload a CIM → AI extracts financials in 30 seconds (no more manual Excel work)
• 13 analysis modules auto-generated (QoE, ratios, red flags, EBITDA bridge...)
• Chat with your deals in natural language ("What's the revenue CAGR?")
• Built-in VDR, investment memo builder, and contact CRM

Here's a 2-minute demo: [LOOM LINK]

What I'd ask from you:
• Use it on 2-3 real deals over the next month
• Give honest feedback (15-min call every 2 weeks)
• Tell me what's broken and what's missing

Interested? Reply to this email and I'll set up your account today.

[Your name]
Founder, Avise
```

### Beta Welcome Email (After Signup)

```
Subject: Welcome to Avise Beta — here's how to get started

Hi [Name],

Your Avise account is live! Here's everything you need:

🔗 Login: https://pe-dealstack.vercel.app/login
📹 2-min Demo: [LOOM LINK]
💬 Beta Slack Group: [SLACK LINK]

Quick Start (5 minutes):
1. Log in and create your first deal
2. Upload a CIM or financial document to the Data Room
3. Go to the Financials tab and watch AI extract the data
4. Try the Chat tab — ask it anything about your deal

I've booked an onboarding call for [DATE/TIME] to walk you through
everything live. If that doesn't work, reply with a better time.

Questions or bugs? Message me on Slack or reply to this email.

Thanks for being an early believer,
[Your name]
```

### Week 2 Check-In

```
Subject: Quick check-in — how's Avise working for you?

Hi [Name],

It's been 2 weeks since you started using Avise. Quick questions:

1. Have you uploaded any CIMs? How was the extraction?
2. What's the most useful feature so far?
3. Anything broken or frustrating?

Also — here's a 2-minute feedback survey: [SURVEY LINK]

Your feedback directly shapes what we build next. Thanks for being part of this.

[Your name]
```

### Testimonial Request (Day 30+)

```
Subject: Would you be willing to share a quick quote?

Hi [Name],

You mentioned that [specific thing they said about Avise].
Would you be comfortable if I used that as a testimonial on our website?

Something like:
"[Their quote] — [Name], [Title] at [Firm]"

Totally fine to say no or suggest edits. Just means a lot coming from
someone who's actually used it on real deals.

[Your name]
```

---

## 9. Week-by-Week Beta Plan

### Week 0: Prep (Before Any Users)
- [ ] Complete all P1 items from Pre-Beta Checklist
- [ ] Set up analytics (PostHog/Mixpanel)
- [ ] Set up feedback channel (Canny + Slack)
- [ ] Record demo video
- [ ] Prepare sample CIM for onboarding
- [ ] Test full flow end-to-end on production
- [ ] Create beta tracking spreadsheet

### Week 1: Alpha (Internal)
- [ ] Onboard 3-5 internal/close-friend testers
- [ ] Do onboarding calls, find showstoppers
- [ ] Fix critical bugs found in alpha
- [ ] Refine onboarding flow based on what confused people

### Week 2: Beta Wave 1 Launch
- [ ] Send beta invitations to 5 target firms
- [ ] Schedule onboarding calls (within 48 hrs of signup)
- [ ] Monitor analytics daily — who's active, who's stuck?
- [ ] Fix bugs reported in real-time (Slack/WhatsApp)
- [ ] Document common questions → add to help docs

### Week 3: Feedback + Iterate
- [ ] Send Week 2 feedback survey
- [ ] Conduct 15-min feedback calls with each Wave 1 user
- [ ] Prioritize top 3 issues/requests → fix them
- [ ] Ship improvements with changelog update
- [ ] Invite Beta Wave 2 (5-10 more firms)

### Week 4: Wave 2 + Measure
- [ ] Onboard Wave 2 users (lighter touch — written guide + optional call)
- [ ] Send Week 4 survey to Wave 1
- [ ] Calculate activation rate, WAU, NPS
- [ ] Run Sean Ellis test ("how would you feel if...")
- [ ] Start collecting testimonials

### Week 5-6: Iterate + Decide
- [ ] Ship top requested features/fixes
- [ ] Conduct Day 30 calls with Wave 1
- [ ] Ask willingness-to-pay question
- [ ] Compile beta results doc
- [ ] Make go/no-go decision on paid launch

---

## 10. Post-Beta Decision Framework

After 4-6 weeks of beta, evaluate:

| Signal | Go to Paid Launch | Iterate More | Pivot |
|--------|------------------|-------------|-------|
| **NPS** | 40+ | 20-40 | <20 |
| **Sean Ellis ("very disappointed")** | 40%+ | 25-40% | <25% |
| **Willingness to Pay** | 50%+ "definitely/probably" | 30-50% | <30% |
| **Weekly Active Users** | 60%+ | 40-60% | <40% |
| **Extraction Accuracy** | 85%+ satisfied | 70-85% | <70% |
| **Organic Referrals** | Users inviting team without prompting | Only when asked | Nobody invites |

### If GO → Next Steps
1. Set up Stripe billing (2-3 day build)
2. Convert beta users to paid (grandfather beta pricing)
3. Launch on Product Hunt + LinkedIn (see GTM-STRATEGY.md)
4. Start cold outreach with beta testimonials

### If ITERATE → Focus On
1. Fix the #1 reason users aren't activating
2. Improve extraction accuracy if that's the blocker
3. Add the #1 requested feature
4. Run another 4-week beta cycle

---

## File Checklist (Assets to Create)

| Asset | Format | Status |
|-------|--------|--------|
| Demo video (2 min) | Loom | To create |
| Sample CIM PDF | PDF (anonymized) | To create |
| Beta tracking spreadsheet | Google Sheet | To create |
| Feedback survey | Typeform / Google Form | To create |
| Beta Slack/WhatsApp group | Slack or WhatsApp | To create |
| Onboarding checklist (in-app) | Code change | To build |
| Feedback widget (in-app) | Code change | To build |
| Product analytics | PostHog/Mixpanel | To integrate |
| Beta badge (in-app) | Code change | To build |
| Welcome email template | Resend / manual | To set up |
| 5 help doc walkthroughs | Loom or written | To create |

---

*Reference alongside: [AVISE-PRODUCT-SUMMARY.md](AVISE-PRODUCT-SUMMARY.md) | [GTM-STRATEGY.md](GTM-STRATEGY.md)*
