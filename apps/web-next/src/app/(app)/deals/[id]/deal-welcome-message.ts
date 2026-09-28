// ---------------------------------------------------------------------------
// Deal-chat welcome message builder.
//
// Renders the AI assistant's opening message for a deal as a MARKDOWN
// STRING so it goes through the same `AiMessageBody` / `renderMarkdown` /
// DOMPurify pipeline as every other assistant reply, instead of hand-rolled
// JSX. That fixes two problems with the old inline JSX in deal-tabs.tsx:
//   1. A dense, unstructured single paragraph ("I've analyzed the documents
//      for X. <15-line thesis>. What would you like to know?").
//   2. A literal ".." when the deal/company name itself ends in a period
//      (e.g. "Jantar Energia sp. z o.o." + the template's own ". ").
//
// This is a pure function — no React, no fetch — so it's unit-testable in
// isolation from the chat UI.
// ---------------------------------------------------------------------------

import type { DealDetail } from "./deal-detail-shared";
import { formatFinancialValue, formatPercent, pickHeadlineMetrics } from "@/lib/formatters";

/** Strip trailing periods/whitespace from a name so "…o.o." + "." never
 * collapses into "…o.o..". Keeps internal abbreviation periods (sp. z o.o.)
 * intact — only the trailing edge is trimmed. */
function stripTrailingPeriods(name: string): string {
  return name.replace(/[.\s]+$/, "");
}

// Abbreviations (and their trailing-period forms) that must NOT be treated
// as a sentence boundary when splitting `aiThesis` into sentences. Matched
// case-insensitively against the token immediately before the period.
// Note: "o.o" (as in "sp. z o.o.") is intentionally NOT listed — its own
// trailing period legitimately ends a sentence/clause most of the time; the
// single-letter guard below already protects the "o.o" internal period.
const ABBREVIATIONS = [
  "sp", "z", "inc", "ltd", "llc", "co", "corp", "l.p", "llp",
  "mr", "mrs", "ms", "dr", "jr", "sr", "vs", "etc", "e.g", "i.e",
  "fy", "q1", "q2", "q3", "q4", "no", "st", "ave",
];

/**
 * Split free text into sentences without breaking on:
 *   - abbreviations ("sp. z o.o.", "Inc.", "e.g.")
 *   - decimals ("1.44x", "$3.5M", "12.5%")
 *   - ellipses ("...")
 *
 * This is intentionally simple (not a full sentence tokenizer) — it only
 * needs to be safe enough for CIM-style thesis prose in the deal record.
 */
export function splitIntoSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences: string[] = [];
  let start = 0;

  // Walk character by character looking for a sentence-ending punctuation
  // mark (. ! ?) that is followed by whitespace + an uppercase letter (or
  // end of string), and is NOT part of a decimal number or a known
  // abbreviation.
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;

    const before = trimmed.slice(0, i);
    const after = trimmed.slice(i + 1);

    // Decimal guard: a digit immediately before AND after the period
    // ("1.44x", "3.5M") is never a sentence boundary.
    if (ch === "." && /\d$/.test(before) && /^\d/.test(after)) continue;

    // Abbreviation guard: the word fragment immediately before the period
    // (letters/digits only, no spaces) matches a known abbreviation.
    if (ch === ".") {
      const wordMatch = before.match(/([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)$/);
      const word = wordMatch ? wordMatch[1].toLowerCase() : "";
      if (ABBREVIATIONS.includes(word)) continue;
      // A single letter immediately before the period ("o.o.", "J.P.",
      // "e.g.") is almost always mid-abbreviation, not a sentence end —
      // this also covers the interior periods of multi-part abbreviations
      // like "o.o." that ABBREVIATIONS can't fully enumerate one dot at a
      // time.
      if (word.length === 1) continue;
    }

    // Must be followed by whitespace (or end of string) — "1.44x" already
    // excluded above, this also skips things like "e.g.something" glued
    // with no space, which we don't try to split.
    const nextChar = trimmed[i + 1];
    if (nextChar !== undefined && !/\s/.test(nextChar)) continue;

    sentences.push(trimmed.slice(start, i + 1).trim());
    start = i + 1;
  }

  const rest = trimmed.slice(start).trim();
  if (rest) sentences.push(rest);

  return sentences.filter(Boolean);
}

/** First `count` sentences of `text`, safely split. Returns "" if `text` is
 * empty/whitespace. */
function leadSentences(text: string | undefined, count: number): string {
  if (!text) return "";
  return splitIntoSentences(text).slice(0, count).join(" ");
}

interface MetricLine {
  label: string;
  value: string;
}

function buildKeyMetrics(deal: DealDetail): MetricLine[] {
  const lines: MetricLine[] = [];
  const headline = pickHeadlineMetrics(deal);

  if (headline.revenue != null) {
    lines.push({
      label: "Revenue",
      value: formatFinancialValue(headline.revenue, headline.unitScale, {
        currency: headline.currency,
      }),
    });
  }
  if (headline.ebitda != null) {
    lines.push({
      label: "EBITDA",
      value: formatFinancialValue(headline.ebitda, headline.unitScale, {
        currency: headline.currency,
      }),
    });
  }
  if (headline.ebitdaMargin != null) {
    lines.push({ label: "EBITDA margin", value: formatPercent(headline.ebitdaMargin) });
  }
  if (deal.dealSize != null) {
    lines.push({
      label: "Deal size",
      value: formatFinancialValue(deal.dealSize, "MILLIONS", { currency: deal.currency }),
    });
  }
  if (deal.industry) {
    lines.push({ label: "Industry", value: deal.industry });
  }

  return lines;
}

/**
 * Build the AI assistant's opening chat message for a deal as a markdown
 * string, ready to pass through `AiMessageBody` / `renderMarkdown`.
 *
 * Falls back to a short generic greeting when the deal has no AI thesis yet
 * (matches the previous JSX fallback branch).
 */
export function buildWelcomeMessage(deal: DealDetail | null): string {
  if (!deal?.aiThesis) {
    return [
      "I'm ready to help analyze this deal. Ask me about financials, risks, or any uploaded documents.",
      "",
      "What would you like to know?",
    ].join("\n");
  }

  const name = stripTrailingPeriods(deal.name || "this deal");
  const lead = leadSentences(deal.aiThesis, 2);

  const opening = lead
    ? `I've analyzed the documents for **${name}**. ${lead}`
    : `I've analyzed the documents for **${name}**.`;
  const sections: string[] = [opening];

  const metrics = buildKeyMetrics(deal);
  if (metrics.length > 0) {
    sections.push(
      [
        "",
        "**Key metrics**",
        ...metrics.map((m) => `- ${m.label}: ${m.value}`),
      ].join("\n"),
    );
  }

  const highlights = (deal.aiRisks?.investmentHighlights ?? []).filter(Boolean).slice(0, 3);
  if (highlights.length > 0) {
    sections.push(
      ["", "**Highlights**", ...highlights.map((h) => `- ${h}`)].join("\n"),
    );
  }

  const risks = (deal.aiRisks?.keyRisks ?? []).filter(Boolean).slice(0, 3);
  if (risks.length > 0) {
    sections.push(["", "**Key risks**", ...risks.map((r) => `- ${r}`)].join("\n"));
  }

  sections.push("", "What would you like to know about this deal?");

  return sections.join("\n");
}
