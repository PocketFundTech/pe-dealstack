/** 5 Oct testing, item 10: documents showed "AI analysed" when no AI had run. */
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/api", () => ({ api: {} }));
import { transformDocument } from "./api";
import { CUSTOM_FILTER_PRESETS } from "./filters";

const doc = (over: Record<string, unknown>) => ({
  id: "d", dealId: "x", name: "P&L.xlsx", type: "FINANCIALS", createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z", ...over,
});
const aiFilter = CUSTOM_FILTER_PRESETS.find((f) => f.id === "ai-analyzed")!;

describe("data-room analysis badge", () => {
  it("text extracted but no AI result → 'Text extracted', not counted as AI analysed", () => {
    const f = transformDocument(doc({ status: "completed" }));
    expect(f.analysis.label).toBe("Text extracted");
    expect(f.analysis.type).toBe("ready");
    expect(aiFilter.filterFn(f)).toBe(false);
  });

  it("a real AI result is still 'Analysis Complete'", () => {
    expect(transformDocument(doc({ status: "completed", aiAnalyzedAt: "2026-10-05T01:00:00Z" })).analysis.label).toBe("Analysis Complete");
    const withAi = transformDocument(doc({ status: "completed", aiAnalysis: { summary: "Revenue grew" } }));
    expect(aiFilter.filterFn(withAi)).toBe(true);
  });
});
