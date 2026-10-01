import { describe, it, expect, vi } from "vitest";
import { runExtractAll } from "./deal-financials-extract-all";

const doc = (id: string, status: string, periods = 0) => ({ id, name: id, status, periodsStored: periods });

describe("runExtractAll", () => {
  it("re-sends pending documents until none remain and merges the rounds", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({
        documentsProcessed: [doc("a", "completed", 4), doc("b", "completed", 2), doc("c", "pending")],
        result: { periodsStored: 6, documentsUsed: 2, documentsFailed: 0, warnings: [] },
        pendingDocumentIds: ["c"],
      })
      .mockResolvedValueOnce({
        documentsProcessed: [doc("c", "completed", 3)],
        result: { periodsStored: 3, documentsUsed: 1, documentsFailed: 0, warnings: [] },
        pendingDocumentIds: [],
      });
    const progress: string[] = [];
    const r = await runExtractAll(post as never, "deal-1", {
      timeoutMs: 1000, onProgress: (p) => progress.push(`${p.done}/${p.total}`),
    });

    expect(post).toHaveBeenNthCalledWith(1, "/deals/deal-1/financials/extract", { mode: "all_financials" }, expect.anything());
    expect(post).toHaveBeenNthCalledWith(2, "/deals/deal-1/financials/extract", { mode: "all_financials", documentIds: ["c"] }, expect.anything());
    expect(r.result?.periodsStored).toBe(9);
    expect(r.result?.documentsUsed).toBe(3);
    expect(r.documentsProcessed?.map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(progress).toEqual(["2/3", "3/3"]);
    expect(r.result?.allFailed).toBe(false);
  });

  it("stops (with a warning) when a round makes no progress", async () => {
    const post = vi.fn().mockResolvedValue({
      documentsProcessed: [doc("a", "pending")], result: { warnings: [] }, pendingDocumentIds: ["a"],
    });
    const r = await runExtractAll(post as never, "deal-1", { timeoutMs: 1000 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(r.result?.warnings?.[0]).toContain("not reached");
  });
});
