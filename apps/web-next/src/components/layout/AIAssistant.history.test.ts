import { describe, it, expect, beforeEach } from "vitest";
import { clearHistory, historyBucket, loadHistory, saveHistory } from "./AIAssistant.history";

beforeEach(() => window.localStorage.clear());

describe("AI assistant history (5 Oct testing, item 19)", () => {
  it("keeps one conversation per deal, not one shared 'deal' bucket", () => {
    const a = { type: "deal" as const, dealId: "a" };
    const b = { type: "deal" as const, dealId: "b" };
    saveHistory(a, [{ role: "user", content: "about A" }]);
    expect(loadHistory(b)).toEqual([]);
    expect(loadHistory(a)).toEqual([{ role: "user", content: "about A" }]);
    expect(historyBucket(a)).toBe("deal:a");
  });

  it("clear removes only that conversation", () => {
    const a = { type: "deal" as const, dealId: "a" };
    const portfolio = { type: "dashboard" as const };
    saveHistory(a, [{ role: "user", content: "x" }]);
    saveHistory(portfolio, [{ role: "user", content: "y" }]);
    clearHistory(a);
    expect(loadHistory(a)).toEqual([]);
    expect(loadHistory(portfolio)).toHaveLength(1);
  });
});
