import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { findSectionIndex } from "./section-handlers";

const read = (f: string) => readFileSync(join(__dirname, f), "utf8");

describe("memo canvas layout classes", () => {
  it("keeps a sane min width and never breaks words per letter", () => {
    const src = read("editor.tsx");
    expect(src).toContain("min-w-[560px]");
    expect(src).not.toContain("overflow-wrap:anywhere");
  });
  it("AI Analyst overlays the canvas below 1440px instead of squeezing it", () => {
    expect(read("chat.tsx")).toContain("max-[1439px]:absolute");
  });
});

describe("findSectionIndex", () => {
  const prev = [
    { type: "FINANCIAL_PERFORMANCE", title: "Financial Performance" },
    { type: "FINANCIAL_PERFORMANCE", title: "Quality of Earnings" },
    { type: "EXIT_STRATEGY", title: "Exit Analysis" },
  ];
  it("matches by title so remapped generator types don't append duplicates", () => {
    expect(findSectionIndex(prev, { type: "QUALITY_OF_EARNINGS", title: "Quality of Earnings" })).toBe(1);
    expect(findSectionIndex(prev, { type: "EXIT_ANALYSIS", title: "Exit Analysis" })).toBe(2);
  });
  it("falls back to type, then -1", () => {
    expect(findSectionIndex(prev, { type: "EXIT_STRATEGY", title: "Exit Strategy" })).toBe(2);
    expect(findSectionIndex(prev, { type: "RISK_ASSESSMENT", title: "Risk" })).toBe(-1);
  });
});
