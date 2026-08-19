# Avise — Go-To-Market Strategy

**Product:** AI-Powered CRM for Private Equity Deal Management
**Stage:** Early-stage, live product on Vercel (pe-dealstack.vercel.app)
**Date:** March 25, 2026
**Target:** First 10 paying customers in 90 days

---

## 1. Launch Readiness Check

### MVP Feature Audit — READY

| Feature | Status | Launch-Critical? |
|---------|--------|-----------------|
| Deal Pipeline (Kanban + table) | Live | Yes |
| Virtual Data Room (VDR) | Live | Yes |
| AI Financial Extraction (GPT-4o + Azure) | Live | Yes — **this is the wedge** |
| Contact CRM + Relationship Scores | Live | Nice-to-have |
| Investment Memo Builder | Live | Yes — high perceived value |
| AI Deal Chat (LangGraph agent) | Live | Demo differentiator |
| Multi-tenant Org Isolation | Live | Yes (enterprise-grade security) |
| Meeting Prep Agent | Live | Nice-to-have |
| Portfolio Monitoring | Coming Soon | No — launch without it |

**Verdict:** MVP is sufficient. The AI financial extraction + memo builder combo is the wedge — no competitor does automated CIM-to-financial-model extraction at this price point.

### TAM Sanity Check
- ~4,700 PE firms in the US (PitchBook data)
- ~2,100 M&A advisory firms
- ~3,200 VC firms with deal flow needs
- At $1,000/mo average = **$120M addressable at 1% penetration**
- You only need 10 firms at $1K/mo = $10K MRR. That's 0.1% of addressable market. Very achievable.

### Kill Risk
**Enterprise sales cycle length.** PE firms are slow buyers (2-6 months). Mitigation: target emerging managers (Fund I-III, <$500M AUM) who make decisions in days, not quarters. They're also the most underserved — DealCloud prices them out.

---

## 2. Pre-Launch: Weeks 1-3

### Target Audience — Where They Are

| Channel | Who's There | Activity Level |
|---------|-------------|----------------|
| **LinkedIn** | PE associates, VPs, MDs | High — daily scrollers |
| **r/privateequity** (6K members) | Junior PE, aspiring PE | Moderate |
| **r/financialcareers** (180K) | Broader finance | High |
| **Wall Street Oasis (WSO)** forums | Analysts to Partners | High, skeptical |
| **PE Twitter/X** (#privateequity, #dealflow) | GPs, LPs, advisors | Growing |
| **Axial Network** | Lower middle-market deal community | Niche but perfect |
| **SearchFunder.com** | Search fund / ETA community | Underserved, deal-flow hungry |

### Content Calendar (Pre-Launch)

Post these across LinkedIn + relevant subreddits:

1. **"How we automated CIM financial extraction with GPT-4o"** — Technical deep-dive showing before/after of manual Excel work vs. AI extraction. Post on LinkedIn + r/privateequity.

2. **"The real cost of DealCloud for a Fund I PE shop"** — Positioning piece. DealCloud is $50K+/year. You're 10x cheaper. Post on LinkedIn + SearchFunder.

3. **"Why PE firms still email Excel files in 2026"** — Pain-point content about VDR adoption. Gets engagement from people who live this frustration daily. LinkedIn.

4. **"I built an AI that reads CIMs and extracts financials in 30 seconds"** — Demo video (Loom, 2 min). Twitter/X thread + LinkedIn.

5. **"Investment memo templates used by top PE firms"** — Lead magnet. Gated PDF download on landing page. Share on WSO + LinkedIn.

### Waitlist: NO
Skip the waitlist. The product is live. Instead, offer a **14-day free trial** with white-glove onboarding (you personally set up their first deal). At this stage, your time per customer is your competitive advantage.

### Landing Page Must-Haves
Your `landingpage.html` needs these specific sections:
1. **Hero:** "AI-Powered Deal Management for PE" + 30-sec demo GIF showing CIM upload → financial extraction
2. **Pain → Solution:** 3 panels — (a) Manual CIM analysis takes hours → AI does it in 30 seconds, (b) Scattered deal data → unified pipeline, (c) $50K/yr CRM tools → Avise at 10% of the cost
3. **Live Product Screenshots:** Deal pipeline, VDR, financial extraction results, memo builder
4. **Social Proof:** Even without customers — use "Built by PE professionals" + logos of tech stack (Supabase, OpenAI, etc.) + "Trusted by X deals processed"
5. **Pricing:** Transparent. Show 2 tiers. Don't hide pricing behind "Contact Sales."
6. **CTA:** "Start Free Trial — No Credit Card Required"

### Demo Strategy
- **Format:** 2-minute Loom video showing the "magic moment" — upload a real CIM PDF → watch AI extract financials → auto-populate memo
- **Where:** Embed on landing page, pin to LinkedIn profile, attach to every cold outreach
- **Do NOT** make a 15-minute product tour. Nobody watches those.

### Social Proof Before Customers
- Ask 3-5 PE professionals to beta test for 2 weeks → get testimonial quotes
- Post "X CIMs processed" counter on the landing page (even if it's your test data — it shows the product works)
- LinkedIn recommendations from beta users

---

## 3. Launch Day Plan

### Primary Channels (ranked by fit)

#### 1. LinkedIn (Highest Priority)
PE professionals live on LinkedIn. This is your #1 channel.

- **Launch post format:** Personal story + product. "After watching PE associates spend 6 hours per CIM on manual data entry, I built Avise..."
- **Include:** Demo GIF, 3 bullet features, pricing, link
- **When:** Tuesday or Wednesday, 8:00 AM EST
- **Tag:** 5-10 PE professionals you know. Ask 20 people to comment in the first hour (algorithm boost)
- **Follow-up:** Comment on your own post with a detailed breakdown of one feature
- **DM campaign:** Personally message 50 PE contacts with a tailored one-liner + demo link

#### 2. Product Hunt
Good for credibility + backlinks, but PE buyers aren't browsing PH.

- **Best day:** Tuesday or Wednesday
- **Prep:** Get a hunter with 1K+ followers (check Hunterai.co)
- **Tagline:** "AI-powered CRM that reads your CIMs and builds investment memos"
- **Assets needed:** Logo, 5 product screenshots, maker comment explaining the story
- **Goal:** Top 5 of the day for the badge. Use it as social proof everywhere.

#### 3. Targeted Communities (SearchFunder + WSO)
- **SearchFunder.com:** Post in their tools/resources section. This community is actively looking for affordable deal management tools. Frame as "built for emerging managers."
- **Wall Street Oasis:** Post in PE forum. Be genuine, expect skepticism, answer every question. Don't shill — share the technical approach to financial extraction.
- **r/privateequity:** "Show-off Saturday" or similar thread. Link to the Loom demo. Keep it conversational.

**Skip Hacker News** — PE/finance tools don't resonate there. The audience is developer-focused, not your buyer.

---

## 4. Post-Launch Growth: First 90 Days

### Channel Prioritization

| Rank | Channel | Est. CAC | Time to Results | First Action This Week |
|------|---------|----------|-----------------|----------------------|
| 1 | **LinkedIn Outbound** | $0-50 | 1-2 weeks | Write 3 posts, DM 50 PE professionals with personalized messages |
| 2 | **Content SEO** | $0 (time) | 60-90 days | Publish "AI financial extraction for PE" blog post targeting long-tail keywords |
| 3 | **Partnerships** | $0 | 30-60 days | Reach out to 3 PE-focused consultants/placement agents for referral deals |
| 4 | **Cold Email** | $50-100/mo (tools) | 2-4 weeks | Build list of 200 emerging PE firms (<$500M AUM), send 5-email sequence |
| 5 | **PE Conferences** | $500-2K | 60-90 days | Attend 1 regional PE event as participant (not exhibitor — too expensive) |

### Content Strategy — 5 SEO-Targeted Posts

| # | Title | Target Keyword | Distribution |
|---|-------|---------------|-------------|
| 1 | "How AI is Automating CIM Analysis for PE Firms" | ai cim analysis private equity | LinkedIn article + blog + r/privateequity |
| 2 | "DealCloud Alternatives for Emerging PE Managers (2026)" | dealcloud alternatives | Blog (SEO) + SearchFunder + Google Ads ($2/click) |
| 3 | "Building a Virtual Data Room: What PE Firms Actually Need" | virtual data room private equity | Blog + LinkedIn + Quora answers |
| 4 | "Investment Memo Template: The Framework Top PE Firms Use" | investment memo template PE | Gated PDF lead magnet + LinkedIn + WSO |
| 5 | "The True Cost of Manual Financial Extraction in PE Due Diligence" | financial extraction automation | LinkedIn + blog + email newsletter |

### Partnerships & Community

**3 Communities to Engage:**
1. **SearchFunder.com** — Search fund / ETA operators actively building deal flow. Underserved by existing tools. Become a regular contributor before pitching.
2. **PE Stack (pestack.com)** — PE technology review community. Get Avise listed and reviewed.
3. **Emerging Manager community on LinkedIn** — Follow/engage with accounts like @PrivateEquityGuy, @BuyoutInsider. Comment on their posts consistently for 4 weeks before sharing Avise.

**2 Partnership Opportunities:**
1. **PE-focused accounting firms** (Grant Thornton PE practice, BDO, Citrin Cooperman) — they advise emerging managers on tech stack. Offer referral commission (15-20% first year).
2. **Supabase / Vercel partner directories** — Get listed as a "Built with Supabase/Vercel" showcase. Free distribution to technical co-founders at PE-adjacent firms.

**1 Growth Hack:**
**"Free CIM Analysis" lead gen tool.** Let anyone upload a CIM PDF and get AI-extracted financials emailed to them — no signup required. Capture email + firm name. This is your product's magic moment as a free tool. Convert 10-20% to full trial. Build at `pe-dealstack.vercel.app/free-cim-analysis`.

---

## 5. Metrics Dashboard — First 90 Days

| Metric | Day 30 | Day 60 | Day 90 | Tool | Below-Target Action |
|--------|--------|--------|--------|------|-------------------|
| **Website Visitors** | 500 | 2,000 | 5,000 | Vercel Analytics / Plausible | Double LinkedIn posting frequency, start Google Ads |
| **Free Trial Signups** | 15 | 40 | 80 | Supabase dashboard (User table count) | Simplify signup flow, add demo video to landing page |
| **Trial → Paid Conversion** | 10% (2 paid) | 15% (6 paid) | 20% (16 paid) | Manual tracking (spreadsheet) | Add white-glove onboarding calls, survey churned trials |
| **MRR** | $1,500 | $5,000 | $10,000 | Stripe dashboard | Raise prices (you're probably too cheap), add annual discount |
| **CIMs Processed (product usage)** | 50 | 200 | 500 | API logs / Supabase query | Users aren't reaching "aha moment" — fix onboarding to first CIM upload in <5 min |

---

## 6. Budget Allocation ($500/month)

| Category | Monthly Spend | What |
|----------|--------------|------|
| **Cold email tooling** | $100 | Apollo.io or Instantly.ai — build PE firm list, send 5-email sequences |
| **LinkedIn Sales Navigator** | $100 | Find decision-makers at target firms, InMail credits |
| **Loom Pro** | $15 | Custom demo videos for outreach |
| **Domain + email** | $15 | Professional email for outreach (not @gmail) |
| **Google Ads (branded + competitor)** | $200 | Bid on "DealCloud alternative", "PE CRM software", your brand name |
| **Design (Fiverr)** | $70 | Product Hunt assets, social media templates, one-pager PDF |
| **Total** | **$500** | |

### Free Activities (Highest ROI)
- LinkedIn posting (3x/week) — $0
- Community engagement (SearchFunder, WSO, Reddit) — $0
- Cold DMs to PE professionals — $0
- SEO blog content — $0
- Product Hunt launch — $0
- Beta user testimonial collection — $0

### One Investment Under $200 with Outsized Impact
**Apollo.io ($99/mo)** — gives you a database of every PE firm employee with email + title + firm AUM. Build a list of 500 VPs/Associates at firms with <$500M AUM. Send a 5-email cold sequence with the CIM demo video. At a 2% conversion rate, that's 10 trial signups from one month of emails.

---

## 7. Pricing Strategy

Based on competitive positioning:

| | DealCloud | 4Degrees | Affinity | **Avise** |
|---|-----------|----------|----------|-----------|
| Price | $50K+/yr | $25K+/yr | $30K+/yr | **$6-18K/yr** |
| AI Extraction | No | No | No | **Yes** |
| Setup Time | 3-6 months | 1-2 months | 2-4 weeks | **Same day** |
| Target | Large PE ($1B+) | Mid-market | Relationship-focused | **Emerging managers** |

### Recommended Tiers

| Tier | Price | Users | Best For |
|------|-------|-------|----------|
| **Starter** | $499/mo | Up to 5 | Search funds, solo GPs |
| **Professional** | $1,499/mo | Up to 15 | Fund I-III PE firms |
| **Enterprise** | Custom | Unlimited | $1B+ AUM firms |

---

## 8. Week 1 Action Items

- [ ] Record 2-min Loom demo (CIM upload → extraction → memo)
- [ ] Write LinkedIn launch post (personal story format)
- [ ] DM 50 PE professionals with tailored message + demo link
- [ ] Sign up for Apollo.io, build first list of 200 emerging managers
- [ ] Post on SearchFunder.com tools section
- [ ] Set up Vercel Analytics or Plausible for website tracking
- [ ] Create "Free CIM Analysis" landing page concept

---

*Generated using Avise GTM Strategy Framework — March 25, 2026*
