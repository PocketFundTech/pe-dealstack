import { describe, it, expect } from "vitest";
import { buildWelcomeMessage, splitIntoSentences } from "./deal-welcome-message";
import type { DealDetail } from "./deal-detail-shared";

function makeDeal(overrides: Partial<DealDetail> = {}): DealDetail {
  return {
    id: "deal-1",
    name: "Jantar Energia sp. z o.o.",
    stage: "DUE_DILIGENCE",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("splitIntoSentences", () => {
  it("does not split on abbreviations like 'sp. z o.o.'", () => {
    const sentences = splitIntoSentences(
      "Project Bursztyn is the sale of Jantar Energia sp. z o.o. The buyer is a strategic acquirer.",
    );
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toContain("sp. z o.o.");
  });

  it("does not split on decimals like '1.44x'", () => {
    const sentences = splitIntoSentences("The multiple is 1.44x revenue. That is above market.");
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toContain("1.44x");
  });

  it("splits plain sentences normally", () => {
    const sentences = splitIntoSentences("First sentence. Second sentence. Third sentence.");
    expect(sentences).toHaveLength(3);
  });

  it("returns an empty array for empty input", () => {
    expect(splitIntoSentences("")).toEqual([]);
    expect(splitIntoSentences("   ")).toEqual([]);
  });
});

describe("buildWelcomeMessage", () => {
  it("never produces a double period even when the deal name ends in a period-like abbreviation", () => {
    const deal = makeDeal({
      name: "Jantar Energia sp. z o.o.",
      aiThesis: "Project Bursztyn is the sale of 100% of the company. The buyer is a strategic acquirer.",
    });
    const md = buildWelcomeMessage(deal);
    expect(md).not.toContain("..");
    // Trailing period is stripped from the name before bolding, then a
    // single period is appended by the template — never two in a row.
    expect(md).toContain("**Jantar Energia sp. z o.o**.");
  });

  it("falls back to a generic greeting when there is no aiThesis", () => {
    const deal = makeDeal({ aiThesis: undefined });
    const md = buildWelcomeMessage(deal);
    expect(md).toContain("I'm ready to help analyze this deal");
    expect(md).not.toContain("**Key metrics**");
  });

  it("returns the generic greeting for a null deal", () => {
    const md = buildWelcomeMessage(null);
    expect(md).toContain("I'm ready to help analyze this deal");
  });

  it("includes only the first two sentences of aiThesis", () => {
    const deal = makeDeal({
      aiThesis:
        "Sentence one is here. Sentence two is here. Sentence three should not appear. Sentence four should not appear.",
    });
    const md = buildWelcomeMessage(deal);
    expect(md).toContain("Sentence one is here.");
    expect(md).toContain("Sentence two is here.");
    expect(md).not.toContain("Sentence three");
    expect(md).not.toContain("Sentence four");
  });

  it("omits the Key metrics section when no financial fields are present", () => {
    const deal = makeDeal({ aiThesis: "A short thesis.", revenue: undefined, ebitda: undefined, dealSize: undefined, industry: undefined });
    const md = buildWelcomeMessage(deal);
    expect(md).not.toContain("**Key metrics**");
  });

  it("includes a Key metrics section built from cached revenue/EBITDA/currency", () => {
    const deal = makeDeal({
      aiThesis: "A short thesis.",
      cachedRevenue: 42_300_000,
      cachedEbitda: 8_100_000,
      cachedEbitdaMargin: 19.1,
      cachedCurrency: "USD",
      industry: "Industrial Services",
    });
    const md = buildWelcomeMessage(deal);
    expect(md).toContain("**Key metrics**");
    expect(md).toContain("Revenue: $42.3M");
    expect(md).toContain("EBITDA: $8.1M");
    expect(md).toContain("EBITDA margin: 19.1%");
    expect(md).toContain("Industry: Industrial Services");
  });

  it("includes Highlights and Key risks sections, capped at 3 each", () => {
    const deal = makeDeal({
      aiThesis: "A short thesis.",
      aiRisks: {
        investmentHighlights: ["Strong margins", "Sticky customers", "Low capex", "Should be dropped"],
        keyRisks: ["Customer concentration", "Key-man risk", "FX exposure", "Should be dropped too"],
      },
    });
    const md = buildWelcomeMessage(deal);
    expect(md).toContain("**Highlights**");
    expect(md).toContain("- Strong margins");
    expect(md).toContain("- Sticky customers");
    expect(md).toContain("- Low capex");
    expect(md).not.toContain("Should be dropped");
    expect(md).toContain("**Key risks**");
    expect(md).toContain("- Customer concentration");
    expect(md).not.toContain("Should be dropped too");
  });

  it("omits Highlights/Key risks sections when aiRisks is absent", () => {
    const deal = makeDeal({ aiThesis: "A short thesis.", aiRisks: undefined });
    const md = buildWelcomeMessage(deal);
    expect(md).not.toContain("**Highlights**");
    expect(md).not.toContain("**Key risks**");
  });

  it("always ends with the call-to-action question", () => {
    const deal = makeDeal({ aiThesis: "A short thesis." });
    const md = buildWelcomeMessage(deal);
    expect(md.trim().endsWith("What would you like to know about this deal?")).toBe(true);
  });
});
