// ---------------------------------------------------------------------------
// dealchat-skills — Phase 0/1
//
// Slash-command "skill" registry for the deal chat. Each skill exposes a
// `buildPrompt(deal)` that returns a single, self-contained question the
// existing LangChain ReAct agent (apps/api) can answer with its 14 tools.
//
// Prompts are intentionally verbose and explicit: section headers, citation
// requirements, "do not fabricate" guardrails. They mirror the quality bar
// set by `buildSuggestionPrompts` in deal-tabs-suggestions.tsx — and raise
// it. The agent's system prompt already enforces the Financial Data
// Protocol; these prompts repeat the key constraint so each skill is
// usable in isolation (and survives any future agent prompt churn).
//
// `requires` advertises optional preconditions for the menu UI to surface
// a hint when the current deal doesn't satisfy them ("needs financials").
// It does NOT block invocation — the user can always send the prompt.
// ---------------------------------------------------------------------------

import type { DealDetail } from "@/app/(app)/deals/[id]/deal-detail-shared";

// Re-export the canonical type under the name the spec uses, so consumers
// can `import type { Deal } from "@/lib/dealchat-skills"` without having
// to know it lives next to the chat UI.
export type Deal = DealDetail;

export type SkillCategory = "memo" | "risk" | "research" | "analysis" | "visual" | "workflow";

export interface SkillRequirements {
  financials?: boolean;
  documents?: boolean;
  sector?: boolean;
  /**
   * Skill needs at least one connected mail/calendar integration for the
   * CURRENT user (Gmail, Google Calendar, and — when shipped — Outlook /
   * Outlook Calendar). Set on skills like `/follow-ups` that pull live
   * data from the user's own mailbox. The check is satisfaction-only —
   * `unmetRequirements()` reads `ctx.hasMailIntegration` to decide. If
   * the caller doesn't pass `ctx`, the requirement is treated as unmet
   * (conservative — better to badge than to silently hide a missing-
   * data condition).
   */
  mailIntegration?: boolean;
}

/**
 * Optional runtime context for `unmetRequirements` — provides facts that
 * can't be derived from the Deal alone (e.g., whether the current user has
 * connected their Gmail / Calendar). Keeping this in one bag means new
 * cross-entity requirement checks can be added without changing every
 * caller's signature.
 */
export interface SkillRequirementContext {
  /** True if the current user has at least one connected mail OR calendar
   *  integration (Gmail / Google Calendar today; Outlook variants when
   *  shipped). Used by skills with `requires.mailIntegration`. */
  hasMailIntegration?: boolean;
}

export interface Skill {
  id: string;
  command: string;
  label: string;
  description: string;
  category: SkillCategory;
  requires?: SkillRequirements;
  buildPrompt: (deal: Deal) => string;
}

// ---------------------------------------------------------------------------
// Helpers — keep prompts DRY without sacrificing self-containment.
// ---------------------------------------------------------------------------

function nameOf(deal: Deal): string {
  return deal.companyName || deal.name || "this company";
}

function industryOf(deal: Deal): string | null {
  return deal.industry?.trim() ? deal.industry : null;
}

const CITATION_REMINDER =
  "Every numeric claim must cite its source (tool name + period, e.g., `get_deal_financials FY2024`). If a data point is not available from the tools, state that explicitly — DO NOT fabricate numbers, ranges, or document references.";

// Unit-handling reminder injected into every numeric skill. Financial values
// returned by `get_deal_financials` can be stored at any scale (K/M/B/raw);
// the row's `unit` field (or table header) is the source of truth. Assuming
// millions when the row is actually in thousands shipped six bug reports —
// A3, B2, B8, C1, C2 — so every numeric prompt now repeats this guardrail.
const UNIT_REMINDER =
  "When citing numerical values, ALWAYS use the unit that `get_deal_financials` returns (look for the `unit` field on each row or the table header — it may be K, M, or B). Do NOT assume millions. If a row's unit is `K`, render the value as `$6.9K`, not `$6.9M`. Preserve the row's currency too.";

// Unit-handling reminder specific to chart skills — the `generate_chart` tool
// renders the y-axis with whatever unit suffix the producer sets (default M),
// so emitting a chart without a `unit` field for raw-dollar values yields the
// $0.0M-on-every-tick bug. Every chart skill repeats this so each prompt is
// usable in isolation.
const CHART_UNIT_REMINDER = [
  "UNIT FIELD ON THE CHART SPEC (required):",
  "- Read the unitScale from `get_deal_financials` output (look for `[scale: ACTUALS]`, `[scale: THOUSANDS]`, `[scale: MILLIONS]`, `[scale: BILLIONS]` in the markdown).",
  "- When calling `generate_chart`, you MUST set the `unit` field to match: ACTUALS -> 'units', THOUSANDS -> 'K', MILLIONS -> 'M', BILLIONS -> 'B'. Do not omit it.",
  "- Skipping `unit` defaults the y-axis to millions; raw-dollar series then render as $0.0M on every tick.",
  "- For percentage / margin / growth-rate charts, set `unit: 'units'` (no currency suffix is applied — the axis is unitless).",
].join("\n");

// Top-of-prompt anchor injected as the FIRST line of every buildPrompt to
// keep the highest-priority guardrails in the model's recency window. In
// long prompts (~40+ lines like ic-memo) the LLM's attention to tail-of-
// prompt instructions degrades; the same rules repeated up front anchor
// behaviour throughout the generation. Detailed CITATION/UNIT reminders
// still ship at the bottom of each prompt for completeness.
const TOP_ANCHOR =
  "GROUND RULES: cite every numeric claim (tool name + period), use the unit each row reports (K/M/B/units/%/x — never assume), never fabricate numbers or document references.";

// Shared "available data" rules used by every chart skill. Extracted so a
// rule change lands in one place (was previously copy-pasted 3× across
// chartRevenue/chartMargin/chartCompMults — drift risk on rule updates).
const CHART_DATA_RULES = [
  `"Available data" rules (do NOT misread these as empty):`,
  `- If \`get_deal_financials\` returns any line that says "Found N financial statements" with N >= 1, the deal HAS extracted financials. Use them — even when the breakdown shows "0 active, N pending review" or "(pending merge review)". Pending-review statements are real, extracted data; they're just queued for a duplicate-resolution UI step.`,
  `- A single period is still data. Render a single-bar / bar chart from it.`,
  `- Treat a monthly-only period set the same as an annual one. Chart the monthly points directly; do not require an FY rollup.`,
].join("\n");

// Final echo reminder appended at the END of every chart-skill prompt.
// Counterweight to the MANDATORY top-of-prompt line: long chart prompts
// run ~30 lines, so models occasionally "forget" the echo rule by the
// time they generate output. Bracketing the reminder at top AND bottom
// of the prompt is the cheapest reliability fix.
const CHART_ECHO_REMINDER =
  "FINAL REMINDER: your reply MUST contain the raw ```chart...``` block from generate_chart — verbatim, fences included. If you summarize, paraphrase, or strip the fences, the chart does NOT render.";

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

const icMemo: Skill = {
  id: "ic-memo",
  command: "/ic-memo",
  label: "Investment Committee memo",
  description: "Full IC-grade memo with thesis, financials, risks, and recommendation.",
  category: "memo",
  requires: { financials: true, documents: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    const industry = industryOf(deal);
    const industryClause = industry ? ` in the ${industry} sector` : "";
    return [
      TOP_ANCHOR,
      "",
      `Draft a full Investment Committee memo for ${name}${industryClause}. Target 600-900 words total — if you exceed 900, you're over-explaining; tighten. Use the exact section headers below, in this order:`,
      "",
      "## Executive Summary",
      "A 4-6 sentence overview: what the company does, deal size/structure if known, headline financials, and a one-line recommendation.",
      "",
      "## Target Overview",
      `Business model, products/services, end markets, geographic footprint, and key customers. Pull what you can from \`search_documents\` and \`get_deal_documents\`. Cite the source document name for non-obvious claims.`,
      "",
      "## Investment Thesis",
      "Exactly three numbered pillars. Each pillar: a bolded one-line claim, followed by 2-3 supporting sentences with specific evidence (financial metric or document quote).",
      "",
      "## Financial Performance",
      `Use \`get_deal_financials\` to cite revenue, EBITDA, gross margin, and growth rate for the latest 2-3 periods. Format as a small markdown table. Call out any trend (acceleration/deceleration, margin expansion/compression) and tie it back to commentary in the documents (via \`search_documents\`).`,
      "",
      "## Key Risks",
      "List 4-6 risks. For EACH risk: a one-line description, the specific document or financial line that surfaced it (cite via `search_documents` result), and a proposed mitigant. Group risks as: Commercial / Financial / Operational / Legal-Regulatory.",
      "",
      "## Valuation Framing",
      "Use `compare_deals` if comparables exist. Provide an EV/EBITDA range, an EV/Revenue range, and the implied enterprise value at the midpoint. If no comps are available, say so and outline 3 reference points an analyst should source externally.",
      "",
      "## Recommended Next Steps",
      "A bulleted list of 5-8 concrete diligence actions, each tied to a specific gap identified above.",
      "",
      CITATION_REMINDER,
      UNIT_REMINDER,
      `If \`get_deal_financials\` returns nothing, write the Financial Performance section as "Financial extraction has not completed for this deal — required inputs: [list]." and continue with the rest of the memo.`,
    ].join("\n");
  },
};

const qoeFlags: Skill = {
  id: "qoe-flags",
  command: "/qoe-flags",
  label: "QoE red flags",
  description: "Quality of Earnings red flags grouped by category with severity.",
  category: "risk",
  requires: { financials: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    return [
      TOP_ANCHOR,
      "",
      `Identify Quality of Earnings (QoE) red flags for ${name}. Pull data from \`get_analysis_summary\` AND \`get_deal_financials\`. Cross-reference \`search_documents\` for any narrative that supports or contradicts the numbers.`,
      "",
      "Format as a bulleted list, grouped by these EXACT category headers (in this order):",
      "",
      "### Revenue Quality",
      "### EBITDA Adjustments",
      "### Working Capital",
      "### Cash Conversion",
      "### Accounting Hygiene",
      "",
      "For EACH bullet:",
      "- Start with a severity emoji prefix: 🔴 critical (deal-breaker or material misstatement risk), 🟡 diligence (needs confirmatory work), or 🟢 standard (note for the file).",
      "- State the flag in one sentence.",
      "- Cite the document basis (document name + section/page if available) OR the financial line item + period.",
      `- One-line "why it matters" rationale.`,
      "",
      "Example bullet:",
      "- 🔴 **Revenue growth outpaces AR growth by 40pp in FY24** — `get_deal_financials FY2023-FY2024` shows revenue +28%, AR +68%. Indicates potential channel-stuffing or extended payment terms. Confirm via aged AR detail.",
      "",
      `If a category has no flags, write "No flags identified in available data." under that header — do not invent issues.`,
      "",
      CITATION_REMINDER,
      UNIT_REMINDER,
    ].join("\n");
  },
};

const mgmtQa: Skill = {
  id: "mgmt-qa",
  command: "/mgmt-qa",
  label: "Management Q&A prep",
  description: "20 sector-aware management questions across four buckets.",
  category: "analysis",
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    const industry = industryOf(deal);
    const industryClause = industry
      ? `Tailor every question to the ${industry} sector — generic questions are not useful here.`
      : "Use whatever sector signal you can extract from `search_documents` and `get_deal_documents` to keep questions specific. If sector is truly unknown, note that at the top and proceed with the best inference.";
    return [
      TOP_ANCHOR,
      "",
      `Generate 20 management-call questions for ${name}. Exactly 5 questions per bucket, in this order:`,
      "",
      "## Strategy & Vision",
      "## Financial Performance & Drivers",
      "## Operational & Org",
      "## Market & Competitive",
      "",
      industryClause,
      "",
      `CRITICAL: Every question must reference something specific about THIS deal — a financial line item (cite \`get_deal_financials\`), a document insight (cite \`search_documents\`), or a known fact about ${name}. Examples of what NOT to do:`,
      `- ❌ "What is your growth strategy?"`,
      `- ✅ "Your FY24 revenue of $X grew 12% vs. a 28% three-year CAGR — what changed in FY24, and what's the recovery plan for FY25?"`,
      "",
      "Each question is numbered (1-5 within each bucket) and one paragraph, with the citation in backticks.",
      "",
      CITATION_REMINDER,
      UNIT_REMINDER,
    ].join("\n");
  },
};

const compBench: Skill = {
  id: "comp-bench",
  command: "/comp-bench",
  label: "Comparables benchmark",
  description: "Markdown comp table plus out/under/in-line commentary.",
  category: "analysis",
  requires: { financials: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    const industry = industryOf(deal);
    return [
      TOP_ANCHOR,
      "",
      `Build a comparables benchmark for ${name}${industry ? ` (${industry})` : ""}. Use the \`compare_deals\` tool to pull a comp set.`,
      "",
      "## Comp Table",
      "Render a markdown table with these columns: Company | Revenue (latest period) | EBITDA Margin | Revenue Growth (YoY) | EV/EBITDA (if available). Include the target as the first row and bold its name.",
      "",
      "## Commentary",
      "Three paragraphs, in this order — each titled with a bolded lead-in:",
      "- **Where the target out-performs**: name 1-3 metrics where the target beats the comp median and quote both values.",
      "- **Where the target under-performs**: same, but the other direction.",
      "- **Where the target is in line**: highlight metrics within ~10% of the comp median.",
      "",
      `If \`compare_deals\` returns an empty set, state that no comparable deals were found in the firm's database, and suggest exactly 3 external search terms the analyst could use (industry + size band + geography) to source comps manually. Do not invent comparable companies.`,
      "",
      CITATION_REMINDER,
      UNIT_REMINDER,
    ].join("\n");
  },
};

const onePager: Skill = {
  id: "one-pager",
  command: "/one-pager",
  label: "One-pager brief",
  description: "Tight ~250-word brief: snapshot, thesis, financials, risks, asks.",
  category: "memo",
  requires: { financials: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    return [
      TOP_ANCHOR,
      "",
      `Produce a strict ~250-word one-pager for ${name}. Total length MUST be between 220 and 280 words. Use these exact section headers and formats:`,
      "",
      "## Snapshot",
      "Four KPIs as a single line each, formatted `**Metric:** value (period, source)`. Pull from `get_deal_financials` / `get_analysis_summary`. Pick the four most decision-relevant KPIs (typically: revenue, EBITDA margin, growth rate, cash conversion).",
      "",
      "## Thesis",
      "Exactly 3 bullets. Each ≤ 25 words. State the thesis pillar and one supporting metric or document fact.",
      "",
      "## Financial Highlights",
      "Exactly 5 bullets. Each ≤ 20 words. Numeric and cited.",
      "",
      "## Top 3 Risks",
      "Exactly 3 bullets. Each ≤ 20 words. Severity emoji prefix (🔴 / 🟡 / 🟢).",
      "",
      "## Asks",
      "Bulleted list of what the deal team needs to advance — data, intros, approvals. ≤ 5 items.",
      "",
      "No rambling. No intro paragraph. No closing sign-off.",
      "",
      CITATION_REMINDER,
      UNIT_REMINDER,
    ].join("\n");
  },
};

const ddChecklist: Skill = {
  id: "dd-checklist",
  command: "/dd-checklist",
  label: "Sector-specific DD checklist",
  description: "Concrete diligence items tailored to the deal's sector.",
  category: "analysis",
  requires: { sector: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    const industry = industryOf(deal);
    if (!industry) {
      return [
        `A sector-specific DD checklist needs the deal's industry. ${name} has no industry on file.`,
        "",
        "HARD STOP: reply with ONLY this single question and NOTHING else: \"What sector should this checklist be tailored to?\". Do NOT produce any checklist items, do NOT list possible sectors, do NOT propose a generic template. A generic checklist is strictly worse than no checklist; the user will tell you the sector and you'll re-run the skill with that input.",
      ].join("\n");
    }
    return [
      TOP_ANCHOR,
      "",
      `Generate a due diligence checklist for ${name} tailored to the ${industry} sector. Use these four bucket headers in this order:`,
      "",
      "## Commercial",
      "## Financial",
      "## Legal & Regulatory",
      "## Tech & Operations",
      "",
      "Each bucket: approximately 8 concrete items as a checkbox list (`- [ ] ...`). CRITICAL — every item must be specific, not generic. Compare:",
      `- ❌ "Review revenue concentration."`,
      `- ✅ "Validate whether the $4.2M FY24 enterprise revenue includes the Q4 one-time true-up disclosed in the Aug-2025 board deck."`,
      "",
      `Use \`get_deal_financials\`, \`search_documents\`, and \`get_deal_documents\` to seed each item with a specific deal fact, document name, or financial line. If a bucket has fewer than 5 deal-specific items available, include the most relevant ${industry}-standard items to reach 8 — but flag them with "[sector-standard]" so the analyst knows they're not driven by deal data.`,
      "",
      CITATION_REMINDER,
      UNIT_REMINDER,
    ].join("\n");
  },
};

const newsScan: Skill = {
  id: "news-scan",
  command: "/news-scan",
  label: "News scan (target + domain)",
  description: "Top news about the target first; domain context only if target is quiet.",
  category: "research",
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    const industry = industryOf(deal);
    return [
      TOP_ANCHOR,
      "",
      // COST DISCIPLINE: each web_search costs 1 credit. Default to ONE
      // target query. Only run the SECOND domain query when the target
      // signal is too thin to fill the brief on its own. Never run a
      // domain query "just in case".
      `Surface news on ${name} with target-first relevance. The \`web_search\` tool costs credits per call — run AT MOST 2 calls.`,
      "",
      `QUERY 1 (target — always run): \`web_search({ query: "${name}${industry ? ` ${industry}` : ""}", topic: "news", max_results: 10 })\`. Including the industry in the query helps disambiguate same-name namesakes. NO recency filter — small/private companies may not have anything in a 90-day window; we want the top headlines whatever their date.`,
      "",
      industry
        ? `QUERY 2 (domain — ONLY run if QUERY 1 returned FEWER THAN 2 target-matched items after filtering): \`web_search({ query: "${industry} industry news", topic: "news", max_results: 6 })\`. This is a contextual top-up, NOT a parallel news source — domain items should NEVER outnumber target items in the final output. If QUERY 1 produced 2+ target hits, SKIP this query entirely.`
        : `QUERY 2 (domain): SKIP — this deal has no \`industry\` tag set. Note in your reply that the industry field is unset and recommend the user fill it in.`,
      "",
      "Filtering (apply BEFORE writing the output):",
      `- Target items MUST name ${name} directly in the title or snippet (not a same-name competitor or an unrelated entity that happens to share the name).`,
      "- DROP any result that is product documentation, evergreen marketing pages, Trustpilot/G2 reviews, directory listings, generic SEO content, or AI-generated comparison fluff.",
      "- Domain items are kept only if they describe a discrete, dated event (funding climate shift, M&A activity, regulatory change, pricing dynamic, demand inflection, competitive move).",
      "",
      "Output structure:",
      "",
      `## Top news for ${name}`,
      "(All target-matched items, most-recent first. Lead with the most material event — funding, acquisition, executive change, customer win, lawsuit — even if it's older than a typical 90-day news window.)",
      "",
      industry
        ? `## ${industry} — domain context`
        : "## Domain context",
      "(ONLY include this section if it ADDs to the brief beyond the target items. Cap at 3 items. If QUERY 2 wasn't run or returned nothing material, OMIT this section entirely — do NOT pad with industry items to make the output look longer.)",
      "",
      "For EVERY item:",
      "- One-sentence summary.",
      "- **Provide a clickable link.** Cite as `[Source — YYYY-MM-DD](URL)`. The URL is mandatory; never cite a source without its link.",
      `- One-line "so what" for the deal team.`,
      "",
      `If QUERY 1 returns NOTHING target-matched after filtering, write under the target header: "No direct press coverage surfaced for ${name} in the news index. For private/small companies this is expected." Do NOT fabricate target headlines to fill the gap. If QUERY 2 then surfaces useful domain items, include them as context — but make it explicit that the target itself has no recent press.`,
      "",
      `If both queries return nothing usable, write: "No material news identified in target or domain searches. Recommend the deal team check LinkedIn, Crunchbase, and industry newsletters directly." List the queries you ran so the analyst can verify.`,
      "",
      `If the \`web_search\` tool returns "Web search is not configured" or "Search failed: ..." on the first call, do NOT retry — say so explicitly and recommend a manual search. Do not fabricate headlines or URLs.`,
      "",
      CITATION_REMINDER,
    ].join("\n");
  },
};

const competitorScan: Skill = {
  id: "competitor-scan",
  command: "/competitor-scan",
  label: "Competitive landscape",
  description: "Top 5 competitors plus landscape commentary; requires web_search.",
  category: "research",
  requires: { sector: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    const industry = industryOf(deal) || "the target's";
    return [
      TOP_ANCHOR,
      "",
      // COST DISCIPLINE: each web_search costs 1 credit. Default to ONE
      // query. Only escalate to a second if the first returned fewer than
      // 3 distinct competitors. Never run 3 just to fill the cap.
      `Map ${name}'s competitive landscape. The \`web_search\` tool costs credits per call — run ONE query first and only escalate if it returned fewer than 3 distinct competitors.`,
      "",
      `PRIMARY QUERY: \`web_search({ query: "best ${industry} companies competitors comparison", topic: "general", max_results: 10 })\` — comparison/listicle phrasing surfaces comp sets fastest.`,
      "",
      `ESCALATION (only if PRIMARY returned <3 distinct competitor names): one additional call with \`query: "${name} vs alternatives", topic: "general", max_results: 10\`. Do NOT escalate beyond this.`,
      "",
      "## Top 5 Competitors",
      "For EACH (list however many surface — don't pad with weak names):",
      "- **Name** (with linked source `[Source — YYYY-MM-DD](URL)`)",
      "- **Positioning**: one sentence on how they compete (price, segment, geography, tech).",
      "- **Scale**: revenue band or employee count, with the source cited if known.",
      "- **Recent strategic move**: most recent newsworthy action in the last 12 months (write \"not findable\" if you can't source one — don't fabricate).",
      "",
      "## Landscape Commentary",
      "Two paragraphs:",
      `1. **Structural dynamics** — fragmentation, consolidation, who's winning share and why. Tie back to specific competitors above.`,
      `2. **Where ${name} fits** — based on \`search_documents\` / \`get_deal_documents\`, position ${name} against the comp set: differentiators, gaps, the most threatening competitor and why.`,
      "",
      `If the \`web_search\` tool is unavailable, say so explicitly and recommend a manual search — do not fabricate competitors. If fewer than 5 credible competitors surface, list only what you have and propose 3 manual sources (G2 category page, Capterra alternatives, specific subreddit) the analyst can check.`,
      "",
      CITATION_REMINDER,
      UNIT_REMINDER,
    ].join("\n");
  },
};

// ---------------------------------------------------------------------------
// Workflow skills — daily-driver actions analysts run on a deal in flight.
// Each one wraps an existing agent tool (`generate_meeting_prep`,
// `draft_email`, `get_deal_activity`) with prompt structure tuned for the
// PE deal-team context. These are intentionally lighter than the memo
// skills — the analyst typically invokes them mid-flow.
// ---------------------------------------------------------------------------

const meetingPrep: Skill = {
  id: "meeting-prep",
  command: "/meeting-prep",
  label: "Meeting prep brief",
  description: "Pre-call brief for an upcoming mgmt / seller / banker meeting: last activity, open items, suggested questions.",
  category: "workflow",
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    return [
      TOP_ANCHOR,
      "",
      `Produce a call-prep brief for an upcoming meeting on ${name}. Use TWO tools, in this order:`,
      `1. \`generate_meeting_prep\` — pass through any attendee/topic context from the analyst's additional-context block (see bottom). The tool returns a headline, summary, talking points, suggested questions, risks, and agenda.`,
      `2. \`get_deal_activity\` with limit 20 — pull the most recent activity timeline so the brief reflects what's actually happened on this deal recently.`,
      "",
      "Combine the two into ONE markdown brief with these EXACT section headers in this order:",
      "",
      "## Headline",
      "(One line — meeting framing. Lift from `generate_meeting_prep` headline.)",
      "",
      "## Last activity",
      "(3-6 bullets, most-recent first. Format: `[YYYY-MM-DD] **type** — title`. Drop pure system-noise rows (cache refreshes, auto-ingest pings) — keep substantive touchpoints. If the timeline is empty, write \"No activity recorded — this is the first touchpoint.\")",
      "",
      "## Open items",
      `(Bullets — explicit follow-ups, asks, or unresolved threads inferred from the activity log AND any open commitments mentioned in \`search_documents\`. Each item: \`- **<owner>** — <what's owed> _(from <activity date or doc name>)_\`. If ownership is ambiguous, write \"unassigned\". If nothing is open, write \"No open items identified in the activity log.\" — do NOT invent items to fill the section.)`,
      "",
      "## Talking points",
      "(4-6 bullets — pull from `generate_meeting_prep`. Tighten each to one line.)",
      "",
      "## Questions to ask",
      "(6-10 numbered questions — pull from `generate_meeting_prep`. CRITICAL: each question must reference a specific deal fact (financial line, doc quote, recent activity). Generic questions waste a call slot — drop them.)",
      "",
      "## Risks to address",
      "(Bullets — pull from `generate_meeting_prep` risks. Each: one-line description + the diligence ask that would close it. Omit this section entirely if the tool returns none — do NOT pad.)",
      "",
      "Keep total length under 500 words. The analyst will skim this on the way to the call.",
      "",
      CITATION_REMINDER,
      UNIT_REMINDER,
    ].join("\n");
  },
};

const emailDraft: Skill = {
  id: "email-draft",
  command: "/email-draft",
  label: "Email draft",
  description: "Draft a deal-related email — to mgmt, broker, legal, LP — with subject, body, and compliance check.",
  category: "workflow",
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    return [
      TOP_ANCHOR,
      "",
      `Draft a deal-related email for ${name}. Call the \`draft_email\` tool — it returns subject + body + a compliance check. ECHO that output verbatim in your reply (do not paraphrase the body — the analyst will copy-paste it).`,
      "",
      "Parse the analyst's additional-context block (below) for two fields the tool requires:",
      "- **recipient** — who the email is for (e.g., \"management team\", \"sell-side broker\", \"outside counsel\", \"LP advisory committee\"). Infer when phrased indirectly — \"to broker about Q3 financials\" → recipient: \"sell-side broker\".",
      "- **purpose** — what the email is asking for (e.g., \"request additional financials\", \"schedule site visit\", \"follow up on LOI\", \"flag a diligence concern\").",
      "",
      "If EITHER field cannot be inferred from the analyst's context (or no context was provided), do NOT call the tool. Instead, reply with ONLY this single prompt and nothing else:",
      "",
      `> To draft this email I need two things: **recipient** (who it's to) and **purpose** (what it should accomplish). Re-run as e.g. \`/email-draft to broker, requesting Q3 financials and YTD pipeline\`.`,
      "",
      "Default tone is `formal`. Switch to `direct` if the analyst's context contains words like \"firm\", \"push back\", \"escalate\", \"chase\". Switch to `casual` only when explicitly asked.",
      "",
      "After echoing the tool's output, add ONE short \"why this framing\" line (≤ 25 words) so the analyst knows the tradeoff you made on tone or emphasis. If the compliance check flagged anything, surface those notes prominently — analysts will edit before sending.",
      "",
      CITATION_REMINDER,
    ].join("\n");
  },
};

// ---------------------------------------------------------------------------
// /follow-ups — unified action-item synthesis across THREE data sources:
// in-app activity (`get_deal_activity`), live Gmail (`get_recent_emails_for_deal`),
// and Google Calendar (`get_upcoming_meetings_for_deal`). The two integration
// tools sit behind a 5-min per-(dealId, userId, args) cache so re-running this
// skill is cheap; error strings (not-connected / token-expired) always re-eval.
// The prompt handles each tool's failure modes explicitly — surfaced as
// callouts at the top of the reply — so a missing integration degrades
// gracefully rather than refusing the whole task.
// ---------------------------------------------------------------------------
const followUps: Skill = {
  id: "follow-ups",
  command: "/follow-ups",
  label: "Action-item follow-ups",
  description: "Unified action-item checklist synthesized from deal activity, Gmail, and Google Calendar.",
  category: "workflow",
  // The skill technically runs without a mail integration — it'll just return
  // in-app activity rows. But that's the same surface as not running the
  // skill, so we badge the menu entry to nudge the user to connect first.
  // Invocation is NOT blocked — the badge is a hint, matching how
  // `requires: { sector: true }` works for /dd-checklist.
  requires: { mailIntegration: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    return [
      TOP_ANCHOR,
      "",
      `Synthesize ONE unified action-item checklist for ${name} by pulling from THREE data sources. Call ALL THREE tools (in this order, then merge — do NOT skip a tool because another returned data):`,
      "",
      `1. \`get_deal_activity\` with \`limit: 25\` — in-app activity timeline (notes, doc uploads, stage changes, commitments logged by the deal team).`,
      `2. \`get_recent_emails_for_deal\` with DEFAULT args — live Gmail search scoped to the deal's contacts + company name. If the analyst's additional-context block names a different lookback (e.g., "last 60 days") or limit, pass it through as \`lookback_days\` / \`limit\` (caps: 90 / 50). Otherwise call it with NO args and let the tool use its defaults (30 days, 25 messages).`,
      `3. \`get_upcoming_meetings_for_deal\` with DEFAULT args — live Google Calendar (past 7 days + next 14 days).`,
      "",
      "Once all three responses are in, merge into ONE checklist ordered by inferred urgency (deal-blocking → soft follow-up). Use ONLY the rules below to decide what counts as an action item.",
      "",
      "## What counts as an action item",
      "- Something a named (or implied) person OWES — a data ask, deliverable, meeting to schedule, document to review, decision to make.",
      "- Pure status/system rows (cache refreshes, automated ingest, stage changes without a commitment) are NOT action items — skip them.",
      "- A commitment that was later marked done in a subsequent activity / email / meeting note is CLOSED — exclude.",
      "- When ownership is ambiguous, write `\"unassigned\"` rather than guessing a name.",
      "",
      "## Email-derived rules (`get_recent_emails_for_deal`)",
      "- Scan each message for explicit asks (\"can you send X\", \"please confirm Y\", \"could you review Z by [date]\"), reply-by dates, and self-commitments (\"I'll send you the model on Monday\" → owner: the sender's side, typically the deal team).",
      "- Read `From` and `To` from the formatted message lines. SENDER = the person making the ask; RECIPIENT = the one who owes the deliverable.",
      "- For self-commitments by the deal team (sender = deal team), owner is the deal team member by name (or `\"deal team\"` if no name is in the From line).",
      "- Source format: `_(source: email \"<Subject>\" on YYYY-MM-DD)_`.",
      "",
      "## Calendar-derived rules (`get_upcoming_meetings_for_deal`)",
      "- FUTURE meeting (start date > today): if NO diligence pack / agenda / pre-read is referenced in `get_deal_activity` for the same date, emit an action item `\"Pre-read owed before <Title>\"` with owner = deal team.",
      "- PAST meeting (start date > 24h ago): if NO post-meeting note appears in `get_deal_activity` referencing that meeting, emit `\"Follow-up notes owed from <Title>\"` with owner = deal team.",
      "- Source format: `_(source: meeting \"<Title>\" on YYYY-MM-DD)_`.",
      "",
      "## Failure-mode handling (CRITICAL — read carefully)",
      "Each integration tool may return an error string instead of data. Surface each one as a one-line callout at the TOP of the reply (ABOVE the checklist), then proceed with whatever the other tools returned:",
      "",
      "- If `get_recent_emails_for_deal` returns `\"Gmail not connected for this user. To enable email-based follow-ups, connect Gmail in Settings → Integrations.\"` OR `\"Gmail connection expired. Please reconnect Gmail in Settings → Integrations.\"` OR `\"Failed to read Gmail. Please try again.\"` — surface verbatim as: `> ⚠️ <verbatim message from tool>`",
      "- If `get_recent_emails_for_deal` returns `\"No contacts or company name available to scope Gmail search for this deal. Add at least one contact to the deal first.\"` — surface as: `> ℹ️ Gmail search skipped: no contacts on this deal yet. Add a contact in the Contacts tab to enable email-based follow-ups.`",
      "- If `get_upcoming_meetings_for_deal` returns `\"Google Calendar not connected for this user. To enable meeting-based follow-ups, connect Google Calendar in Settings → Integrations.\"` OR `\"Google Calendar connection expired. Please reconnect Google Calendar in Settings → Integrations.\"` OR `\"Failed to read Google Calendar. Please try again.\"` — surface verbatim as: `> ⚠️ <verbatim message from tool>`",
      "- If ALL THREE tools return empty / error states, the reply is just the callouts — NO checklist, NO padding, NO \"no items\" placeholder.",
      "",
      "## Output format",
      "",
      "**MANDATORY FIRST LINE — data-source provenance (always emit, even when sources are empty or errored):**",
      "",
      "`_Pulled from: in-app activity (N items) · Gmail (M emails) · Calendar (K events)_`",
      "",
      "Where:",
      "- `N` = the count of activity rows returned by `get_deal_activity` (count the bulleted lines under \"Recent Activity (N items)\" in its output). If the tool returned `\"No activities recorded for this deal.\"`, write `(0 items)`.",
      "- `M` = the count of email messages returned by `get_recent_emails_for_deal` (read the `N messages from last D days` count in its first line). If the tool returned ANY error or skip string (Gmail not connected / expired / no scope / failure), write `(skipped — see banner)`.",
      "- `K` = the count of calendar events returned by `get_upcoming_meetings_for_deal` (read the `N events` count). Same fallback: `(skipped — see banner)` on any error/skip response.",
      "",
      "This line is for the analyst to verify the skill actually queried Gmail/Calendar — never omit it, never paraphrase the format. It goes at the very top, BEFORE any ⚠️ / ℹ️ callouts.",
      "",
      "After the provenance line, emit callouts (zero or more, one per failed/skipped integration) on their own lines, then ONE markdown checklist ordered by urgency:",
      "",
      "- [ ] **<owner>** — <action> _(source: <activity type> on YYYY-MM-DD)_",
      "- [ ] **<owner>** — <action> _(source: email \"<Subject>\" on YYYY-MM-DD)_",
      "- [ ] **<owner>** — <action> _(source: meeting \"<Title>\" on YYYY-MM-DD)_",
      "",
      "Below the checklist, write a 1-2 sentence summary: how many items are open, who carries the most, and which item is most likely to block the deal advancing. Skip the summary entirely if there are zero items.",
      "",
      "Do NOT fabricate action items to fill the list. Do NOT re-state the failure callouts inside the checklist. Do NOT include duplicate items if the same commitment surfaces in two sources — pick the most recent source and cite that one.",
      "",
      CITATION_REMINDER,
      "",
      "FINAL REMINDER: the provenance line `_Pulled from: in-app activity (N items) · Gmail (M emails) · Calendar (K events)_` is MANDATORY as the very first line of your reply. Without it the analyst can't tell whether Gmail/Calendar were queried or skipped — that's the whole point of this skill being trustworthy.",
    ].join("\n");
  },
};

// ---------------------------------------------------------------------------
// Risk skills (web-backed) — surface external regulatory / legal signals
// that aren't in the deal's own documents. Sector-required so the search
// has enough signal to be useful; hard-stop on missing industry matches
// the ddChecklist pattern.
// ---------------------------------------------------------------------------

const regulatoryRisk: Skill = {
  id: "regulatory-risk",
  command: "/regulatory-risk",
  label: "Regulatory risk scan",
  description: "Recent regulatory actions and pending legislation affecting the deal's sector.",
  category: "risk",
  requires: { sector: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    const industry = industryOf(deal);
    if (!industry) {
      return [
        `A regulatory-risk scan needs the deal's industry. ${name} has no industry on file.`,
        "",
        "HARD STOP: reply with ONLY this single question and NOTHING else: \"What sector should the regulatory scan target?\". Do NOT run a generic regulatory query, do NOT list possible sectors, do NOT propose a template. A generic regulatory scan is worse than none — it gives false comfort.",
      ].join("\n");
    }
    return [
      TOP_ANCHOR,
      "",
      // COST DISCIPLINE: each web_search costs 1 credit. Default to ONE
      // sector-wide query; escalate ONCE to a jurisdiction-specific query
      // only if the primary surfaced nothing or the analyst named a
      // jurisdiction in additional context. Never run 3.
      `Scan recent regulatory actions and pending legislation affecting ${name} as a ${industry} business. The \`web_search\` tool costs credits per call — run AT MOST 2 calls.`,
      "",
      `QUERY 1 (sector-wide — always run): \`web_search({ query: "${industry} regulation 2026 enforcement legislation", topic: "news", recency_days: 365, max_results: 10 })\`. The 365-day window catches the regulatory cycle without missing items from earlier in the year.`,
      "",
      `QUERY 2 (jurisdiction-specific — ONLY run if QUERY 1 returned FEWER THAN 3 substantive items, OR if the analyst's additional context names a jurisdiction): \`web_search({ query: "<jurisdiction> ${industry} rulemaking 2026", topic: "news", max_results: 6 })\`. If QUERY 1 already produced enough material, SKIP this call.`,
      "",
      "Filtering (apply BEFORE writing the output):",
      "- Each item must describe a concrete regulatory event: rule proposal, final rule, enforcement action, settlement, statute, court ruling, agency guidance. Drop op-eds, analyst commentary, marketing blogs, evergreen explainers.",
      `- Each item must plausibly touch ${industry} businesses — not an adjacent sector that happens to share a keyword.`,
      "- Dated within the last 18 months unless it's a still-pending bill or rulemaking.",
      "",
      "Output structure — group items under these EXACT headers (OMIT a header entirely if it has no items; do NOT write \"no items\" placeholders):",
      "",
      "## Final rules / enforcement actions",
      "(In force or already settled. Highest priority — direct cost or compliance implications today.)",
      "",
      "## Pending rulemaking / proposed rules",
      "(Open comment periods, NPRMs, draft regs. Affects the deal's forward-looking compliance burden.)",
      "",
      "## Pending legislation",
      "(Bills in committee or under debate. Lower probability, larger blast radius if passed.)",
      "",
      "## Litigation / case law",
      "(Court rulings or active cases that re-interpret existing rules.)",
      "",
      "For EACH item:",
      "- **One-line headline** with severity prefix: 🔴 deal-material (could change valuation, contract terms, or close-ability), 🟡 diligence (worth a workstream / Q for management), 🟢 monitor (note for the file).",
      "- Jurisdiction tag in brackets: `[US-Federal]`, `[US-CA]`, `[EU]`, `[UK]`, etc.",
      "- **Clickable source link** — cite as `[Source — YYYY-MM-DD](URL)`. The URL is mandatory.",
      `- One-line "deal implication" tied to ${name}: what it means for the thesis, the close, or post-close ops.`,
      "",
      `If QUERY 1 returns nothing material after filtering, write: "No discrete regulatory events surfaced in the public news index for ${industry} in the last 18 months. Recommend the deal team check the relevant agency feeds (Federal Register, SEC EDGAR, state AG offices, equivalent foreign regulators) directly." Do NOT fabricate rule names, agency citations, or bill numbers.`,
      "",
      `If the \`web_search\` tool returns "Web search is not configured" or "Search failed: ...", do NOT retry — say so explicitly and recommend a manual search.`,
      "",
      CITATION_REMINDER,
    ].join("\n");
  },
};

// ---------------------------------------------------------------------------
// Research skills (web-backed) — outside-in market context for the deal.
// Both require a sector for the search to be useful.
// ---------------------------------------------------------------------------

const precedentTransactions: Skill = {
  id: "precedent-transactions",
  command: "/precedent-transactions",
  label: "Precedent transactions",
  description: "Recent M&A in the deal's industry, with multiples where available.",
  category: "research",
  requires: { sector: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    const industry = industryOf(deal);
    if (!industry) {
      return [
        `Precedent-transactions research needs the deal's industry. ${name} has no industry on file.`,
        "",
        "HARD STOP: reply with ONLY this single question and NOTHING else: \"What sector should the precedent-transaction search target?\". Do NOT propose generic M&A categories — the result would be useless.",
      ].join("\n");
    }
    return [
      TOP_ANCHOR,
      "",
      // COST DISCIPLINE: each web_search costs 1 credit. Default to ONE
      // M&A query. Escalate to a multiples-specific query only if the
      // primary returned <3 announced transactions with disclosed values.
      `Surface recent precedent M&A transactions in ${industry} relevant to ${name}. The \`web_search\` tool costs credits per call — run AT MOST 2 calls.`,
      "",
      `QUERY 1 (M&A activity — always run): \`web_search({ query: "${industry} acquisition merger announced 2025 2026", topic: "news", recency_days: 540, max_results: 10 })\`. The ~18-month window captures both the last full year and YTD.`,
      "",
      `QUERY 2 (multiples-specific — ONLY run if QUERY 1 returned FEWER THAN 3 transactions with disclosed values/multiples): \`web_search({ query: "${industry} acquisition EV/EBITDA multiple revenue multiple", topic: "general", max_results: 6 })\`. If QUERY 1 already surfaced enough deals with valuations, SKIP this call.`,
      "",
      "Filtering (apply BEFORE writing the output):",
      "- Each transaction must be a real, announced or closed M&A deal — drop rumor pieces, op-eds, generic industry reports, and SEO listicles.",
      `- The target must plausibly be in ${industry} (same sub-segment ideally — not just an adjacent vertical that shares a keyword).`,
      "- Announced or closed within the last ~18 months. Older landmark deals can be included ONLY if they're still the dominant reference comp for the sector — flag those clearly.",
      "",
      "Output structure:",
      "",
      "## Precedent transactions",
      "Render a markdown table with these columns: `Target | Acquirer | Date (YYYY-MM) | Deal value | EV/Revenue | EV/EBITDA | Source`. Use `n/d` (not disclosed) for any cell the source did not report — NEVER fabricate a multiple. Sort by date, most recent first.",
      "",
      "## Multiple ranges",
      "Below the table, if you have at least 3 deals with disclosed multiples, compute and quote the EV/Revenue range and EV/EBITDA range (low — median — high). If fewer than 3, write `Insufficient disclosed multiples (N=<x>) to compute a range — flag for a CapIQ / PitchBook pull.`",
      "",
      `## What this implies for ${name}`,
      `Two-sentence read on what the comp set implies for ${name}'s valuation framing — premium-to-median, discount-to-median, or in-line. Tie back to the target's size band and growth profile (use \`get_deal_financials\` for the target's revenue / margin context if available).`,
      "",
      "For EVERY row in the table, the Source column must contain a clickable link in the form `[Source — YYYY-MM-DD](URL)`. The URL is mandatory.",
      "",
      `If QUERY 1 returns nothing usable, write: "No public precedent transactions surfaced for ${industry} in the search window. Recommend the deal team pull from CapIQ, PitchBook, or Mergermarket directly." Do NOT fabricate target names, acquirer names, or multiples.`,
      "",
      `If the \`web_search\` tool is unavailable or fails on the first call, say so explicitly and recommend a manual paid-database pull — do not retry, do not fabricate transactions.`,
      "",
      CITATION_REMINDER,
      UNIT_REMINDER,
    ].join("\n");
  },
};

const sectorThesis: Skill = {
  id: "sector-thesis",
  command: "/sector-thesis",
  label: "Sector thesis brief",
  description: "Sector landscape — tailwinds, headwinds, regulatory shifts, M&A activity — grounded in the deal's docs.",
  category: "research",
  requires: { sector: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    const industry = industryOf(deal);
    if (!industry) {
      return [
        `A sector-thesis brief needs the deal's industry. ${name} has no industry on file.`,
        "",
        "HARD STOP: reply with ONLY this single question and NOTHING else: \"What sector should the thesis target?\". Do NOT propose a generic sector landscape.",
      ].join("\n");
    }
    return [
      TOP_ANCHOR,
      "",
      // COST DISCIPLINE: web_search costs credits per call AND we layer in
      // search_documents (free) to ground the brief in the target's own
      // materials. Cap web calls at 2.
      `Build a sector thesis for ${industry}, grounded in the deal context for ${name}. Use TWO data sources:`,
      `1. \`web_search\` — AT MOST 2 calls for current sector context.`,
      "2. `search_documents` — pull the deal's own CIM / mgmt deck / market section to anchor the brief in what the seller is already claiming about the sector.",
      "",
      `WEB QUERY 1 (always run): \`web_search({ query: "${industry} market trends outlook 2026", topic: "news", recency_days: 365, max_results: 10 })\` — captures current tailwinds/headwinds, demand inflections, recent industry shifts.`,
      "",
      `WEB QUERY 2 (ONLY run if QUERY 1 returned thin or off-topic results): \`web_search({ query: "${industry} consolidation M&A deal activity", topic: "news", recency_days: 365, max_results: 6 })\` — fills the M&A activity section if QUERY 1 skewed too far toward macro.`,
      "",
      "DOC SEARCHES (free — run 1-2): `search_documents` for terms like \"market size\", \"competitive landscape\", \"growth drivers\", \"regulatory environment\" to pull what the seller's materials say about the sector.",
      "",
      "Filtering:",
      "- Web items must describe a discrete trend, event, or data point. Drop SEO/AI fluff, evergreen marketing pages, vendor blogs.",
      "- Doc items must be from THIS deal's materials (cite the document name + section).",
      "",
      "Output — 400-600 words total. Use these EXACT section headers in this order:",
      "",
      `## ${industry} — at a glance`,
      "(2-3 sentences — what the sector is, current state, the one thing a generalist needs to know before reading further.)",
      "",
      "## Tailwinds",
      "(3-5 bullets. Each: one-line driver + a specific data point or event + cited source link. Prefer quantified claims — \"market growing 12% CAGR per [Source]\" beats \"strong growth.\")",
      "",
      "## Headwinds",
      "(3-5 bullets, same structure. Be honest — every sector has them.)",
      "",
      "## Regulatory shifts",
      "(Bullets — rules, bills, enforcement actions affecting the sector. Lift relevant items from web search; tag jurisdiction. If nothing material, write \"No material regulatory shifts surfaced in the last 12 months\" — do NOT pad.)",
      "",
      "## M&A activity",
      "(Bullets — most material recent transactions or consolidation themes. Each: target + acquirer + date + one-line significance. If thin, write \"Limited public M&A activity surfaced — recommend a CapIQ pull\" rather than padding.)",
      "",
      `## Implication for ${name}'s thesis`,
      `(Two paragraphs — tie the sector context back to THIS deal. Where does ${name} sit relative to the tailwinds? Which headwinds bite the hardest? What does the seller's own framing (from \`search_documents\`) miss or over-emphasize? This is the section the deal team actually reads — make it specific.)`,
      "",
      "Cite EVERY external claim with `[Source — YYYY-MM-DD](URL)`. Cite document claims with the document name + page/section if available.",
      "",
      `If \`web_search\` returns "Web search is not configured" or fails, build the brief from \`search_documents\` ALONE and flag at the top: "Sector context drawn only from the deal's own materials — external sector signals unavailable in this turn." Do NOT fabricate sector data.`,
      "",
      CITATION_REMINDER,
      UNIT_REMINDER,
    ].join("\n");
  },
};

// ---------------------------------------------------------------------------
// Phase 2 research/analysis skills — deeper-cut variants of the Phase 0/1
// research workstreams, plus a documents-first concentration analysis.
//
// Naming overlap callout (coexisting on purpose):
//   - `/regulatory-scan` complements `/regulatory-risk`. The risk skill is
//     enforcement-event-driven (🔴/🟡/🟢 per item) for IC discussion; the
//     scan is landscape-shaped (framework + pending + target-specific +
//     diligence checklist) for upstream sector orientation.
//   - `/ma-precedents` complements `/precedent-transactions`. The latter is
//     a table-first quick comp pull; ma-precedents layers in size-band
//     filtering, valuation context, and explicit gaps/caveats.
// ---------------------------------------------------------------------------

const regulatoryScan: Skill = {
  id: "regulatory-scan",
  command: "/regulatory-scan",
  label: "Regulatory & compliance scan",
  description:
    "Regulatory landscape, pending legislation, and compliance risks for the target's sector.",
  category: "research",
  requires: { sector: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    const industry = industryOf(deal);
    const searchYears = `${new Date().getFullYear() - 1} ${new Date().getFullYear()}`;

    if (!industry) {
      return [
        `A regulatory scan needs the deal's industry to be useful. ${name} has no industry on file.`,
        "",
        "Reply with ONLY this question: 'What sector/industry is this company in?' — then STOP. Do not produce a generic regulatory overview. A sector-blind regulatory scan is noise, not signal.",
      ].join("\n");
    }

    return [
      TOP_ANCHOR,
      "",
      `Map the regulatory and compliance landscape for ${name} in the ${industry} sector. Combine internal deal documents (\`search_documents\`, \`get_deal_documents\`) with external web research (\`web_search\`) to build a complete picture.`,
      "",
      "## Step 1 — Internal document scan (always run first)",
      `Run exactly 4 \`search_documents\` calls with these queries:`,
      `1. \`search_documents("regulatory compliance license permit")\``,
      `2. \`search_documents("litigation lawsuit enforcement penalty")\``,
      `3. \`search_documents("${industry} regulation")\``,
      `4. \`search_documents("insurance coverage indemnification")\``,
      `Also call \`get_deal_documents\` once and scan document titles for anything suggesting legal, regulatory, or compliance content.`,
      "",
      "## Step 2 — External web research",
      `The \`web_search\` tool costs credits per call — run AT MOST 3 calls total, in this priority order:`,
      "",
      `QUERY 1 (always run): \`web_search({ query: "${industry} regulation compliance ${searchYears}", topic: "news", max_results: 10 })\` — surfaces recent regulatory changes, proposed rules, and enforcement trends.`,
      "",
      `QUERY 2 (always run): \`web_search({ query: "${name} regulatory compliance lawsuit", topic: "news", max_results: 10 })\` — surfaces target-specific regulatory events (fines, audits, lawsuits, certifications).`,
      "",
      `QUERY 3 (ONLY if the first two returned <3 usable results combined): \`web_search({ query: "${industry} pending legislation proposed rules", topic: "general", max_results: 10 })\`. If QUERY 1+2 produced 3+ usable items, SKIP this query.`,
      "",
      `If the \`web_search\` tool returns "Web search is not configured" or errors on the first call, do NOT retry — note that web search is unavailable, skip Step 2, and proceed with internal results only. Flag in your output that the external regulatory scan is incomplete.`,
      "",
      "## TOTAL NO-DATA PATH",
      `If Step 1 (all 4 \`search_documents\` calls + \`get_deal_documents\`) returned zero regulatory, compliance, legal, or insurance content AND Step 2 (web search) returned zero usable results or was unavailable, do NOT produce the section-by-section output below. Instead write:`,
      `"Regulatory scan for ${name} found no regulatory, compliance, or legal content in deal documents and no material results from web search. This likely means regulatory documents have not been uploaded. Request from the target: (1) regulatory correspondence file, (2) current licenses and permits, (3) pending or recent litigation summary, (4) insurance certificate of coverage, (5) compliance audit reports (SOC 2, ISO 27001, etc.)."`,
      `Then STOP — do not produce ANY of the sections below. An empty skeleton with "nothing found" under every header is worse than no output.`,
      "",
      "## Output structure (only if Step 1 or Step 2 produced usable results)",
      "",
      `### Current Regulatory Framework`,
      `List ONLY regulations that surfaced from Step 1 or Step 2 results. For each:`,
      "- **Regulation name** (e.g., GDPR, HIPAA, SOX Section 404)",
      "- One-sentence scope: what it requires and who it applies to.",
      `- **Relevance to ${name}**: one sentence connecting it to something specific in the deal docs or financials. If a regulation is common knowledge for ${industry} but did NOT appear in any tool result, you may include it — but mark it \`[general knowledge — not found in deal data]\` and do NOT cite a source you didn't actually retrieve.`,
      "",
      `Cap at 5 regulations. If Step 1 and Step 2 surfaced fewer than 3, list only what you found — do NOT pad with regulations from your training data.`,
      "",
      `### Pending / Proposed Changes`,
      `Regulations or legislation currently in draft, proposed, or comment period that could affect ${name}. ONLY include items that appeared in web search results. For each:`,
      "- **Name/bill number** with source link `[Source — YYYY-MM-DD](URL)`.",
      "- Expected timeline (effective date or next legislative milestone).",
      `- **Impact assessment**: one sentence on how it would affect ${name}'s business model, cost structure, or market access.`,
      "",
      `If web search was unavailable or nothing material surfaced, write: "No pending legislation identified in web search results. This does not mean none exists — recommend checking congress.gov, Federal Register, and ${industry}-specific regulatory trackers directly." Do NOT invent upcoming regulations.`,
      "",
      `### Target-Specific Compliance Risks`,
      `Risks specific to ${name} — drawn from deal documents, financials, and web results. For EACH:`,
      "- Severity emoji: 🔴 critical (could block or unwind the deal), 🟡 diligence (needs confirmatory work pre-close), 🟢 standard (monitor post-close).",
      "- One-sentence risk description.",
      "- Source citation (document name + section, or web link).",
      "- Proposed mitigant or diligence action.",
      "",
      "Examples of what NOT to list:",
      `- ❌ "The company may face regulatory risk." (too vague — which regulation? what risk?)`,
      `- ✅ "🟡 ${name}'s SOC 2 Type II report expires in Q3 2025 (board deck, p.14). If the audit lapses, enterprise clients with compliance mandates may churn. Mitigant: confirm renewal timeline with CTO."`,
      "",
      `If no target-specific risks surface from documents or web, write: "No target-specific compliance risks identified in available data. Recommend requesting: (1) most recent SOC 2 / ISO 27001 report, (2) regulatory correspondence file, (3) insurance certificate of coverage."`,
      "",
      `### Regulatory Diligence Checklist`,
      `5-8 concrete diligence items as checkboxes (\`- [ ] ...\`). Each must name a specific document to request, person to interview, or verification to perform:`,
      `- ❌ "Review regulatory compliance." (generic — which regulation? which document?)`,
      `- ✅ "- [ ] Request ${name}'s current business license and verify expiry date with CFO."`,
      "",
      CITATION_REMINDER,
      UNIT_REMINDER,
    ].join("\n");
  },
};

const maPrecedents: Skill = {
  id: "ma-precedents",
  command: "/ma-precedents",
  label: "M&A precedent transactions",
  description:
    "Recent M&A transactions in the target's space with multiples and deal rationale.",
  category: "research",
  requires: { sector: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    const industry = industryOf(deal);
    const searchYears = `${new Date().getFullYear() - 1} ${new Date().getFullYear()}`;

    if (!industry) {
      return [
        `An M&A precedents scan needs the deal's industry. ${name} has no industry on file.`,
        "",
        "Reply with ONLY this question: 'What sector/industry should I search for precedent transactions in?' — then STOP. Do not produce a generic M&A overview.",
      ].join("\n");
    }

    return [
      TOP_ANCHOR,
      "",
      `Surface recent M&A precedent transactions relevant to ${name} in the ${industry} sector. Combine the firm's internal comparable data (\`compare_deals\`) with external web research (\`web_search\`).`,
      "",
      "## Step 1 — Determine target size band",
      `Call \`get_deal_financials\` or check the deal record's revenue / cachedRevenue for ${name}. Use this to set the relevant transaction size range: look for precedent deals within roughly 0.3x–5x the target's revenue. If \`get_deal_financials\` returns no revenue data and the deal record has no cachedRevenue, skip size-band filtering entirely — note "target revenue unknown, no size filter applied" in Gaps & Caveats and include all transaction sizes from Steps 2-3.`,
      "",
      "## Step 2 — Internal precedents",
      `Call \`compare_deals\` to pull any comparable transactions the firm has tracked. These are the highest-quality data points — they come with verified financials.`,
      "",
      "## Step 3 — External precedents",
      `The \`web_search\` tool costs credits per call — run AT MOST 3 calls total, in this priority order:`,
      "",
      `QUERY 1 (always run): \`web_search({ query: "${industry} acquisition M&A deal ${searchYears}", topic: "news", max_results: 10 })\` — surfaces recent transactions in the space.`,
      "",
      `QUERY 2 (always run): \`web_search({ query: "${industry} private equity buyout valuation multiple", topic: "general", max_results: 10 })\` — surfaces valuation context and PE activity.`,
      "",
      `QUERY 3 (ONLY if QUERY 1+2 returned <3 distinct transactions): \`web_search({ query: "${name} competitors acquired merger", topic: "news", max_results: 10 })\`. Skip if you already have 3+ transactions.`,
      "",
      `If the \`web_search\` tool returns "Web search is not configured" or errors on the first call, do NOT retry — skip Step 3, proceed with internal precedents only, and note that external research could not be performed.`,
      "",
      "## Filtering (apply BEFORE writing output)",
      "- Only include transactions where the TARGET operates in the same or adjacent sector.",
      "- Apply the size band from Step 1 if available. If the target's revenue is ~$20M, a $15B mega-deal is not a useful comp — exclude it.",
      "- DROP any result that is a rumor without a credible source, a press release about a \"strategic partnership\" (not an acquisition), or an AI-generated listicle with no primary sources.",
      "",
      "## TOTAL NO-DATA PATH",
      `If \`compare_deals\` returned no comparable transactions AND \`web_search\` was unavailable or returned zero usable transactions after filtering, do NOT produce an empty table. Instead write:`,
      `"No precedent transactions found for ${name} (${industry}). compare_deals returned no internal comps and web search returned no usable results (or was unavailable). Recommend sourcing precedents from:"`,
      "Then list: (1) PitchBook — filter by sector + size band + geography, (2) Capital IQ — M&A screener with same filters, (3) Mergermarket — deal intelligence for sector-specific coverage.",
      `Then STOP — do not produce ANY of the sections below. An empty precedent table is misleading, not helpful.`,
      "",
      "## Output structure (only if Step 2 or Step 3 produced usable transactions)",
      "",
      "### Precedent Transactions Table",
      "Render a markdown table with these columns:",
      "| Date | Target | Acquirer | Deal Value | EV/Revenue | EV/EBITDA | Source |",
      "",
      "Rules:",
      "- Sort ALL rows by date, most recent first — regardless of whether the source is internal or external.",
      "- Mark internal precedents (from `compare_deals`) with `[internal]` in the Source column.",
      "- If a multiple is not disclosed, write `n/d` — do NOT estimate or back-calculate from partial data.",
      "- Source column: clickable link `[Source](URL)` for web results, `[internal]` for `compare_deals` results.",
      "- Include the target deal's own metrics as the LAST row (bolded name), pulled from `get_deal_financials` / `get_analysis_summary`, so the analyst can visually compare.",
      "",
      "Example of what NOT to include:",
      `- ❌ A $50M "strategic partnership" press release with no acquisition or equity stake — this is not an M&A precedent.`,
      `- ✅ A $120M acquisition of a ${industry} company by a PE firm, with disclosed EV/EBITDA of 9.2x, sourced from a credible news outlet.`,
      "",
      "### Valuation Context",
      "Two paragraphs (always include both):",
      `1. **Multiple ranges** — what EV/Revenue and EV/EBITDA ranges do these precedents imply? State the median and range explicitly. If fewer than 3 data points have disclosed multiples, write: "Sample too small (N disclosed multiples) to compute a reliable median — treat as directional only."`,
      `2. **Where ${name} would sit** — based on the target's financials (from \`get_deal_financials\`), where does it fall in the precedent range? Above median, below, in line? Why — growth rate, margin profile, scale?`,
      "",
      `Optional third paragraph — ONLY include if 3+ transactions share a visible structural trait (e.g., all PE buyouts, all included earn-outs, all cross-border). If the data is too heterogeneous, OMIT this paragraph entirely — do NOT force a narrative from sparse data:`,
      `3. **Deal structure trends** — describe the shared trait and its implication for ${name}'s deal.`,
      "",
      "### Gaps & Caveats",
      "Bullet list of what's missing:",
      "- Transactions that were likely excluded by the search (e.g., unreported private deals).",
      "- Data quality warnings (e.g., 'Only 2 of 6 transactions had disclosed EBITDA multiples').",
      "- Size band used for filtering and any transactions excluded because of it (or 'target revenue unknown, no size filter applied').",
      "- Suggest 2-3 specific paid databases (PitchBook, Capital IQ, Mergermarket) the analyst should check for fuller coverage.",
      "",
      CITATION_REMINDER,
      UNIT_REMINDER,
    ].join("\n");
  },
};

const customerConcentration: Skill = {
  id: "customer-concentration",
  command: "/customer-concentration",
  label: "Customer concentration analysis",
  description:
    "Revenue concentration, top-customer dependency, churn signals, and contract renewal risk.",
  category: "analysis",
  requires: { documents: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);

    return [
      TOP_ANCHOR,
      "",
      `Analyze customer concentration and revenue dependency risk for ${name}. Pull data from ALL available internal sources: \`get_deal_financials\`, \`get_analysis_summary\`, \`search_documents\`, and \`get_deal_documents\`. Use ONLY the thresholds defined in this prompt for severity ratings — do NOT override them with claimed industry norms or benchmarks.`,
      "",
      "## Data Gathering (do all of these before writing output)",
      `1. \`get_deal_financials\` — look for revenue breakdowns by customer, segment, geography, or product line. Check multiple periods to identify trends.`,
      `2. \`search_documents\` — run exactly 4 searches:`,
      `   - \`search_documents("customer concentration top account")\``,
      `   - \`search_documents("churn retention attrition")\``,
      `   - \`search_documents("contract renewal backlog")\``,
      `   - \`search_documents("revenue breakdown segment geography")\``,
      `3. \`get_deal_documents\` — scan document titles for CIM, management presentation, customer list, or revenue bridge documents.`,
      `4. \`get_analysis_summary\` — check if the AI analysis has already flagged concentration risk.`,
      "",
      "## TOTAL NO-DATA PATH",
      `If ALL four data sources return no customer, revenue, segment, or contract information whatsoever, do NOT produce the section-by-section skeleton with empty findings. Instead write:`,
      `"Customer concentration analysis cannot be performed for ${name} — no customer, revenue, or contract data found in financials or documents. Request these from the target before re-running:"`,
      "Then list as a numbered list: (1) revenue-by-customer schedule for last 3 fiscal years, (2) contract summary with renewal dates and terms, (3) retention/churn metrics by cohort, (4) revenue breakdown by segment/geography, (5) aged AR report.",
      `Then STOP — do not produce ANY of the sections below. An empty skeleton with "Cannot assess" under every dimension is worse than no output.`,
      "",
      "## Output structure (only if at least one data source returned usable information)",
      "",
      "### Revenue Concentration Profile",
      "If customer-level revenue data is available (from financials or documents), render a table:",
      "| Customer | Revenue | % of Total | Trend (YoY) | Contract Status |",
      "",
      "Rules:",
      "- Sort by revenue share, largest first.",
      "- Include as many customers as the data supports — do NOT cap at an arbitrary number.",
      "- If exact revenue per customer isn't available but the documents mention 'top 5 customers represent X% of revenue', cite that directly.",
      "- Trend column: ↑ growing share, ↓ shrinking share, → stable, `n/a` if single period.",
      "- Contract Status: pull from documents if available (e.g., 'renews Q3 2025', 'month-to-month', 'master agreement through 2027'). Write `not disclosed` if not found.",
      "",
      "If NO customer-level data exists but other aggregate data does (e.g., segment splits, retention rates), write:",
      `"No customer-level revenue breakdown found in financials or documents for ${name}. This is itself a diligence flag — request a revenue-by-customer schedule from the target."`,
      "Then proceed with whatever aggregate signals you CAN extract in the sections below.",
      "",
      "### Concentration Risk Assessment",
      "Score and explain each of these four dimensions. For each, state the finding, cite the source, and assign a severity (🔴 / 🟡 / 🟢):",
      "",
      "1. **Top-customer dependency** — Does any single customer represent >15% of revenue? Do the top 3 represent >40%? Top 10 >70%?",
      "   - 🔴 if any single customer >25% or top 3 >50%",
      "   - 🟡 if any single customer 15-25% or top 3 40-50%",
      "   - 🟢 if no single customer >15% and top 3 <40%",
      "   - If the data doesn't exist to calculate this, flag it as 🟡 with 'Cannot assess — customer-level data not available'.",
      "",
      "2. **Revenue type mix** — What portion is recurring (subscription, contract) vs. transactional (one-time, project-based)? Cite the source.",
      "   - 🔴 if >60% non-recurring with no backlog visibility",
      "   - 🟡 if 30-60% non-recurring or unclear mix",
      "   - 🟢 if >70% recurring/contracted",
      "",
      "3. **Churn / retention signals** — Any evidence of customer losses, declining retention rates, or shrinking account values?",
      "   - 🔴 if named customer losses or declining NRR/GRR documented",
      "   - 🟡 if retention metrics are absent (can't confirm either way)",
      "   - 🟢 if documented high retention (>90% GRR or >110% NRR)",
      "",
      "4. **Contract renewal risk** — Any major contracts expiring within 12 months of expected close? Any month-to-month arrangements with top customers?",
      "   - 🔴 if a top-3 customer contract expires within 6 months with no renewal evidence",
      "   - 🟡 if renewal timelines are undisclosed for top customers",
      "   - 🟢 if top customers are locked in through 12+ months post-close",
      "",
      "### Trend Analysis",
      "If multi-period data is available, write 2-3 sentences on how concentration has changed over time:",
      "- Is the customer base diversifying or consolidating?",
      "- Are the largest accounts growing faster or slower than the total?",
      "- Any new logos appearing that could become material?",
      "",
      "If only single-period data exists, write: `Single-period data — trend analysis not possible. Request 3-year revenue-by-customer schedule.`",
      "",
      "### Diligence Actions",
      "Bullet list of 5-8 concrete next steps as checkboxes (`- [ ] ...`). Each must be specific:",
      `- ❌ "Assess customer concentration." (generic — what specifically should the analyst do?)`,
      `- ✅ "- [ ] Request revenue-by-customer schedule for FY22-FY24 with contract end dates, billing terms, and auto-renewal clauses."`,
      "",
      "Prioritize actions that fill the specific gaps identified above.",
      "",
      CITATION_REMINDER,
      UNIT_REMINDER,
    ].join("\n");
  },
};

// ---------------------------------------------------------------------------
// Visual skills (Phase 3) — each invokes the `generate_chart` tool so the
// chart renders inline in the chat bubble. Prompts are explicit about
// which data source to read (get_deal_financials / compare_deals) and
// fall back to deal-record summary fields when extraction is empty so the
// analyst always gets a chart instead of a refusal.
// ---------------------------------------------------------------------------

// Bug guard (DMpro): the agent was reading "Found N financial statements
// (0 active, N pending review)" or single-period payloads as "empty" and
// refusing to render. The prompts below now say explicitly that ANY
// statement count > 0 — including 100% pending-review and including a
// single period — IS available data and the agent must call
// generate_chart instead of falling back to summary fields.
const chartRevenue: Skill = {
  id: "chart-revenue",
  command: "/chart-revenue",
  label: "Revenue trend chart",
  description: "Line/bar chart of revenue across all available periods.",
  category: "visual",
  requires: { financials: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    return [
      TOP_ANCHOR,
      "",
      `**MANDATORY: (1) call \`generate_chart\` and (2) ECHO ITS FENCED OUTPUT VERBATIM into your final reply.** The tool returns a \`\`\`chart...\`\`\` block — copy it whole (opening fence, JSON line, closing fence) into your message. Paraphrasing or stripping the fences means NO chart renders.`,
      "",
      `Use \`get_deal_financials\` to retrieve revenue for ${name} across all available periods, then call \`generate_chart\` with a chart titled "Revenue trend" showing period on X and revenue on Y. Prefer a line chart when 2+ periods are available; use a single-bar chart when only one data point exists. Pass y-values at the SAME scale as the source row's unitScale (do not pre-convert) and set the spec's \`unit\` field to match — see the unit-field block below.`,
      "",
      "Render the chart with WHATEVER data is available — 1, 2, or 10 periods are all valid. The analyst wants the visual; do not skip the chart because the series is short.",
      "",
      CHART_DATA_RULES,
      "",
      `If \`get_deal_financials\` returns LITERALLY "No financial statements extracted for this deal yet." or "Error fetching financial data.", check the deal record's summary fields (revenue / cachedRevenue) for ${name}. If those have values, render a single-bar chart from them and label the chart caption as "Deal Record summary field — single LTM/snapshot value, not a time series".`,
      "",
      "Below the chart, write a 2-sentence commentary on the trend (direction, magnitude, any inflection). If only one data point was available, prefix the commentary with `Limited data (1 period)` so the analyst sees the caveat.",
      "",
      "**NO-DATA PATH (RED BANNER — ONLY IF ALL ELSE FAILS):** If both `get_deal_financials` AND the deal record yielded zero numeric revenue values, emit a fenced ```nodata block instead of prose:",
      "",
      "```nodata",
      `Cannot render revenue trend for ${name}: no extracted financial statements and no cached revenue on the deal record.`,
      "",
      "Next step: upload a P&L or financial statement, then re-run /chart-revenue.",
      "```",
      "",
      "Do NOT use prose for the no-data case. The ```nodata block renders as a red banner on the analyst's screen; a paragraph does not.",
      "",
      CHART_UNIT_REMINDER,
      "",
      CITATION_REMINDER,
      "",
      CHART_ECHO_REMINDER,
    ].join("\n");
  },
};

const chartMargin: Skill = {
  id: "chart-margin",
  command: "/chart-margin",
  label: "Margin trajectory chart",
  description: "Chart of gross and EBITDA margins over time (or snapshot).",
  category: "visual",
  requires: { financials: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    return [
      TOP_ANCHOR,
      "",
      `**MANDATORY: (1) call \`generate_chart\` and (2) ECHO ITS FENCED OUTPUT VERBATIM into your final reply.** The tool returns a \`\`\`chart...\`\`\` block — copy it whole (opening fence, JSON line, closing fence) into your message. Paraphrasing or stripping the fences means NO chart renders.`,
      "",
      `Use \`get_deal_financials\` for ${name} to pull all available periods (target 6+, but use whatever is returned). Call \`generate_chart\` with a chart titled "Gross & EBITDA margins". When 2+ periods are available, render a line chart with TWO series (gross_margin, ebitda_margin) on the Y axis (%) and period on X. When only one period (or only a single computed snapshot) is available, render a bar chart with one bar per metric. Margins are PERCENTAGES — set the spec's \`unit\` field to \`"%"\` (not \`"units"\`) so the axis labels render as \`12.5%\` / \`-30.6%\` instead of \`$12.5\` / \`-$30.6\`. Pass y-values as the percent number itself (e.g., 12.5 for 12.5%, NOT 0.125).`,
      "",
      "Render the chart with WHATEVER data is available — 1, 2, or more periods are all valid. Do not skip the chart because the series is short.",
      "",
      CHART_DATA_RULES,
      "",
      `If \`get_deal_financials\` returns LITERALLY "No financial statements extracted for this deal yet." or "Error fetching financial data.", check the deal record's summary fields (revenue / cachedRevenue, ebitda / cachedEbitda) for ${name}. If those exist, compute snapshot EBITDA margin (ebitda / revenue) and render a single-bar chart. Label the caption as "Deal Record summary field — single LTM/snapshot value, not a time series".`,
      "",
      "Below the chart, write a 2-3 sentence commentary on margin trajectory — flag any compression or expansion and tie it back to a specific period. If only one data point was available, prefix the commentary with `Limited data (1 period)`.",
      "",
      "**NO-DATA PATH (RED BANNER — ONLY IF ALL ELSE FAILS):** If both `get_deal_financials` AND the deal record yielded zero usable margin data, emit a fenced ```nodata block instead of prose:",
      "",
      "```nodata",
      `Cannot render margin trajectory for ${name}: no extracted financial statements and no cached revenue/EBITDA on the deal record.`,
      "",
      "Next step: upload a P&L, then re-run /chart-margin.",
      "```",
      "",
      "Do NOT use prose for the no-data case. The ```nodata block renders as a red banner; a paragraph does not.",
      "",
      CHART_UNIT_REMINDER,
      "",
      CITATION_REMINDER,
      "",
      CHART_ECHO_REMINDER,
    ].join("\n");
  },
};

const chartCompMults: Skill = {
  id: "chart-comp-mults",
  command: "/chart-comp-mults",
  label: "Comparable EV/EBITDA chart",
  description: "Bar chart of EV/EBITDA across the comparable set (or target snapshot).",
  category: "visual",
  requires: { financials: true },
  buildPrompt: (deal) => {
    const name = nameOf(deal);
    return [
      TOP_ANCHOR,
      "",
      `**MANDATORY: (1) call \`generate_chart\` and (2) ECHO ITS FENCED OUTPUT VERBATIM into your final reply.** The tool returns a \`\`\`chart...\`\`\` block — copy it whole (opening fence, JSON line, closing fence) into your message. Paraphrasing or stripping the fences means NO chart renders.`,
      "",
      `Use \`compare_deals\` to get comparable EV/EBITDA multiples for ${name} (if available). Call \`generate_chart\` with a bar chart titled "EV/EBITDA — comparable set" with company on X and multiple on Y. EV/EBITDA values are MULTIPLES (e.g., 8.5 = 8.5x) — set the spec's \`unit\` field to \`"x"\` (not \`"units"\`) so the y-axis renders \`8.5x\` instead of \`$8.5\`. Pass y-values as the multiple itself (e.g., 8.5 for 8.5x).`,
      "",
      "Render the chart with WHATEVER data is available — even 1 or 2 comparables (plus the target) is a valid visual.",
      "",
      `If \`compare_deals\` returns no comparables, render a chart from the target itself: use the deal record's revenue / cachedRevenue and ebitda / cachedEbitda for ${name} as a 2-bar chart ("Revenue" and "EBITDA"). Cached revenue / EBITDA are in ACTUAL DOLLARS — set the spec's \`unit\` field to \`"units"\` when emitting that fallback chart. Label the source as "Deal Record summary field — target only, no comparable set available".`,
      "",
      `Highlight the target company (${name}) by name in your commentary below the chart — call out whether it trades at a premium, discount, or in line with the comp median when comps exist, or note "Limited data (target only)" if no comps were available.`,
      "",
      "**NO-DATA PATH (RED BANNER — ONLY IF ALL ELSE FAILS):** If `compare_deals` returns nothing AND the deal record has no revenue/EBITDA values, emit a fenced ```nodata block instead of prose:",
      "",
      "```nodata",
      `Cannot render EV/EBITDA chart for ${name}: no comparable deals in the portfolio and no cached revenue/EBITDA on the deal record.`,
      "",
      "Next step: add comparable deals to the portfolio, or upload financials so the target snapshot can be charted.",
      "```",
      "",
      "Do NOT use prose for the no-data case. The ```nodata block renders as a red banner; a paragraph does not.",
      "",
      CHART_UNIT_REMINDER,
      "",
      CITATION_REMINDER,
      "",
      CHART_ECHO_REMINDER,
    ].join("\n");
  },
};

// ---------------------------------------------------------------------------
// Registry + filter
// ---------------------------------------------------------------------------

export const SKILLS: Skill[] = [
  icMemo,
  qoeFlags,
  mgmtQa,
  compBench,
  onePager,
  ddChecklist,
  newsScan,
  competitorScan,
  meetingPrep,
  emailDraft,
  followUps,
  regulatoryRisk,
  precedentTransactions,
  sectorThesis,
  regulatoryScan,
  maPrecedents,
  customerConcentration,
  chartRevenue,
  chartMargin,
  chartCompMults,
];

export function filterSkills(query: string): Skill[] {
  const q = query.trim().toLowerCase();
  if (!q) return SKILLS;
  return SKILLS.filter((s) => {
    // Match against the command WITHOUT the leading slash too — the menu
    // is rendered when the textarea starts with `/`, and the typical
    // caller slices that off before passing the query in. Matching both
    // forms makes filterSkills robust to either caller convention.
    const cmd = s.command.toLowerCase();
    const cmdNoSlash = cmd.startsWith("/") ? cmd.slice(1) : cmd;
    // Also matches against the description so analysts searching by intent
    // ("red flags", "memo", "valuation") land on the right skill even when
    // those words aren't in the command or label. e.g. "red flags" hits
    // qoeFlags whose description reads "...red flags grouped by category".
    return (
      cmd.includes(q) ||
      cmdNoSlash.includes(q) ||
      s.label.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
    );
  });
}

// ---------------------------------------------------------------------------
// Skill-command parser — used by the chat submit path to detect when the
// user typed a known command and may have appended free-form context after
// it. Returns the matched skill and any trailing text (trimmed). The match
// is anchored: the command must appear at the start of the input,
// followed by either end-of-string OR whitespace. This lets us safely
// distinguish `/ic-memo` from `/ic-memo-v2` (hypothetical future skill).
// ---------------------------------------------------------------------------

export function findSkillCommand(input: string): { skill: Skill; extra: string } | null {
  const trimmed = input.trimStart();
  for (const skill of SKILLS) {
    if (trimmed === skill.command) {
      return { skill, extra: "" };
    }
    if (
      trimmed.startsWith(skill.command + " ") ||
      trimmed.startsWith(skill.command + "\n") ||
      trimmed.startsWith(skill.command + "\t")
    ) {
      return { skill, extra: trimmed.slice(skill.command.length).trim() };
    }
  }
  return null;
}

/**
 * Expand a chat input that begins with a known skill command into the full
 * agent-facing prompt. If `extra` text follows the command, it's appended as
 * an "Additional context from analyst" block so the agent treats it as a
 * user steering signal on top of the skill's structured request.
 * Returns the raw input unchanged when no command matches.
 */
export function expandChatInput(input: string, deal: Deal | null): string {
  if (!deal) return input;
  const match = findSkillCommand(input);
  if (!match) return input;
  const base = match.skill.buildPrompt(deal);
  if (!match.extra) return base;
  return `${base}\n\n---\n**Additional context from the analyst:**\n${match.extra}`;
}

// ---------------------------------------------------------------------------
// Requirement check — used by the menu UI to show "needs financials" hints.
// Returns the list of unmet requirement labels (empty if all satisfied).
// ---------------------------------------------------------------------------

export function unmetRequirements(
  skill: Skill,
  deal: Deal | null,
  ctx?: SkillRequirementContext,
): string[] {
  if (!skill.requires || !deal) return [];
  const unmet: string[] = [];
  const r = skill.requires;
  if (r.financials) {
    const hasFinancials =
      deal.cachedRevenue != null ||
      deal.cachedEbitda != null ||
      deal.revenue != null ||
      deal.ebitda != null;
    if (!hasFinancials) unmet.push("needs financials");
  }
  if (r.documents) {
    if (!deal.documents || deal.documents.length === 0) unmet.push("needs documents");
  }
  if (r.sector) {
    if (!deal.industry || !deal.industry.trim()) unmet.push("needs sector");
  }
  if (r.mailIntegration) {
    // Conservative — if the caller didn't pass ctx, treat as unmet. Prevents
    // a missing-context bug from silently hiding the "connect Gmail" badge.
    if (!ctx?.hasMailIntegration) unmet.push("needs Gmail or Outlook");
  }
  return unmet;
}
