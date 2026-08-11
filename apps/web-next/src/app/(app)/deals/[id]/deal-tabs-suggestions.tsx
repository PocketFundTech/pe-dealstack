"use client";

import { formatHeadlineValue, pickHeadlineMetrics } from "@/lib/formatters";
import type { FinancialSummary } from "@/types";
import type { DealDetail } from "./deal-detail-shared";

// ---------------------------------------------------------------------------
// Suggestion Chips — personalized prompts based on deal data.
// Ported from deal-chat.js (63dd4a0 + cf67cea): always visible,
// contextual copy when deal data is loaded, fall back to defaults otherwise.
// ---------------------------------------------------------------------------

export type SuggestionPrompt = { icon: string; label: string; prompt: string };

export const DEFAULT_PROMPTS: SuggestionPrompt[] = [
  { icon: "warning", label: "Key risks & red flags", prompt: "What are the biggest risks and red flags for this deal? Pull specific data points from the documents." },
  { icon: "analytics", label: "Financial health check", prompt: "Analyze the financial health of this company. What do revenue, margins, and cash flow tell us?" },
  { icon: "lightbulb", label: "Build investment thesis", prompt: "Write a 3-paragraph investment thesis covering: why it's attractive, value creation levers, and key risks with mitigants." },
  { icon: "checklist", label: "Due diligence questions", prompt: "Generate 10 targeted due diligence questions for management, organized by category (financial, operational, legal, commercial)." },
  { icon: "trending_up", label: "Growth & exit potential", prompt: "Outline 3 realistic exit scenarios with estimated timeline and return multiples." },
];

export function buildSuggestionPrompts(
  deal: DealDetail | null,
  summary?: FinancialSummary | null,
): SuggestionPrompt[] {
  if (!deal) return DEFAULT_PROMPTS;

  const name = deal.name || deal.companyName || "this company";
  const industry = deal.industry || null;
  // Resolve revenue / EBITDA via the canonical precedence (cached →
  // summary → legacy). The helper preserves unitScale alongside the
  // values so `formatHeadlineValue` renders at the right magnitude
  // and the margin computation uses values that share a scale.
  const headline = pickHeadlineMetrics(deal, summary ?? null);
  const revenue = headline.revenue;
  const ebitda = headline.ebitda;
  const hasDocs = (deal.documents?.length || 0) > 0;

  const prompts: SuggestionPrompt[] = [];

  // 1. Deal-specific risk analysis
  prompts.push(industry
    ? {
        icon: "warning",
        label: `Risks in ${industry}`,
        prompt: `What are the top 3 risks for ${name} in the ${industry} space? Flag anything from the uploaded documents that concerns you.`,
      }
    : {
        icon: "warning",
        label: "Key risks & red flags",
        prompt: `What are the biggest risks and red flags for ${name}? Pull specific data points from the documents to support your analysis.`,
      });

  // 2. Financial deep-dive
  if (revenue != null && ebitda != null) {
    const fmtRev = formatHeadlineValue(revenue, headline);
    const fmtEbitda = formatHeadlineValue(ebitda, headline);
    // Prefer the helper's authoritative margin (cached → server-precomputed;
    // summary → server-precomputed when present, else (ebitda / revenue) at
    // the same unit scale; legacy → assumed MILLIONS-on-MILLIONS).
    const marginNum =
      headline.ebitdaMargin != null
        ? headline.ebitdaMargin
        : revenue > 0
          ? (ebitda / revenue) * 100
          : null;
    const margin = marginNum != null ? marginNum.toFixed(1) : null;
    prompts.push({
      icon: "analytics",
      label: "Margin & valuation analysis",
      prompt: `${name} shows ${fmtRev} revenue and ${fmtEbitda} EBITDA${margin ? ` (${margin}% margin)` : ""}. How do these margins compare to ${industry || "industry"} benchmarks? What valuation range would you estimate?`,
    });
  } else {
    prompts.push({
      icon: "analytics",
      label: "Financial health check",
      prompt: `Analyze the financial health of ${name}. What do the revenue, margins, and cash flow tell us? Compare to ${industry || "industry"} benchmarks.`,
    });
  }

  // 3. Investment thesis
  prompts.push({
    icon: "lightbulb",
    label: "Build investment thesis",
    prompt: `Write a 3-paragraph investment thesis for ${name}. Cover: (1) why this is an attractive opportunity, (2) key value creation levers post-acquisition, and (3) primary risks and mitigants. Use specific data from the documents.`,
  });

  // 4. DD questions
  prompts.push({
    icon: "checklist",
    label: "Due diligence questions",
    prompt: `Generate 10 targeted due diligence questions for ${name}'s management team. Focus on areas where the documents are weak or data is missing. Organize by category (financial, operational, legal, commercial).`,
  });

  // 5. Docs summary OR growth prompt
  prompts.push(hasDocs
    ? {
        icon: "description",
        label: "Summarize all documents",
        prompt: `Give me a structured summary of all uploaded documents for ${name}. For each document, list: key data points, anything surprising, and what's missing that we'd need for a full DD.`,
      }
    : {
        icon: "trending_up",
        label: "Growth & exit potential",
        prompt: `What is the growth potential for ${name}${industry ? ` in ${industry}` : ""}? Outline 3 realistic exit scenarios with estimated timeline and return multiples.`,
      });

  return prompts;
}

export function SuggestionChips({
  deal,
  onPick,
  summary,
}: {
  deal: DealDetail | null;
  onPick: (prompt: string) => void;
  summary?: FinancialSummary | null;
}) {
  const prompts = buildSuggestionPrompts(deal, summary);
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-2 pb-1.5 border-t border-border-subtle bg-surface-card">
      {prompts.map((p) => (
        <button
          key={p.label}
          type="button"
          onClick={() => onPick(p.prompt)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-left text-xs font-medium rounded-full border transition-all cursor-pointer hover:shadow-sm"
          style={{ color: "#003366", background: "#f0f4f8", borderColor: "rgba(0,51,102,0.15)" }}
          onMouseOver={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#e4ecf4"; (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(0,51,102,0.3)"; }}
          onMouseOut={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#f0f4f8"; (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(0,51,102,0.15)"; }}
        >
          <span className="material-symbols-outlined text-[14px] shrink-0" style={{ color: "#003366" }}>{p.icon}</span>
          <span className="whitespace-nowrap">{p.label}</span>
        </button>
      ))}
    </div>
  );
}
