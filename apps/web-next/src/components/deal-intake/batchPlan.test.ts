import { describe, it, expect } from "vitest";
import { planFileUpload, resolveDealFromResponse } from "./batchPlan";

describe("planFileUpload", () => {
  it("routes the first file in 'new' mode to /ingest/bulk when it's a spreadsheet", () => {
    expect(
      planFileUpload({ fileName: "financials.xlsx", index: 0, mode: "new", selectedDealId: null, createdDealId: null }),
    ).toEqual({ endpoint: "/ingest/bulk" });
  });

  it("routes the first file in 'new' mode to /ingest when it's not a spreadsheet", () => {
    expect(
      planFileUpload({ fileName: "cim.pdf", index: 0, mode: "new", selectedDealId: null, createdDealId: null }),
    ).toEqual({ endpoint: "/ingest" });
  });

  it("treats .xls and .csv as spreadsheets too", () => {
    expect(planFileUpload({ fileName: "deals.xls", index: 0, mode: "new", selectedDealId: null, createdDealId: null }).endpoint).toBe("/ingest/bulk");
    expect(planFileUpload({ fileName: "deals.csv", index: 0, mode: "new", selectedDealId: null, createdDealId: null }).endpoint).toBe("/ingest/bulk");
  });

  it("routes subsequent files in 'new' mode to /ingest with the deal created by the first file", () => {
    expect(
      planFileUpload({ fileName: "teaser.pdf", index: 1, mode: "new", selectedDealId: null, createdDealId: "deal-1" }),
    ).toEqual({ endpoint: "/ingest", dealId: "deal-1" });
  });

  it("lets a later file create the deal when every earlier file failed (no deal yet)", () => {
    expect(
      planFileUpload({ fileName: "transcript.pdf", index: 2, mode: "new", selectedDealId: null, createdDealId: null }),
    ).toEqual({ endpoint: "/ingest" });
    expect(
      planFileUpload({ fileName: "financials.xlsx", index: 1, mode: "new", selectedDealId: null, createdDealId: null }),
    ).toEqual({ endpoint: "/ingest/bulk" });
  });

  it("routes every file in 'existing' mode to /ingest with the selected deal id, regardless of file type", () => {
    expect(
      planFileUpload({ fileName: "model.xlsx", index: 0, mode: "existing", selectedDealId: "deal-9", createdDealId: null }),
    ).toEqual({ endpoint: "/ingest", dealId: "deal-9" });
    expect(
      planFileUpload({ fileName: "notes.pdf", index: 2, mode: "existing", selectedDealId: "deal-9", createdDealId: null }),
    ).toEqual({ endpoint: "/ingest", dealId: "deal-9" });
  });
});

describe("resolveDealFromResponse", () => {
  it("resolves a single-document ingest response via data.deal", () => {
    expect(resolveDealFromResponse({ deal: { id: "deal-1", name: "Acme" } })).toEqual({
      dealId: "deal-1",
      dealName: "Acme",
      multipleDeals: false,
    });
  });

  it("resolves a bulk import response that created exactly one deal", () => {
    expect(
      resolveDealFromResponse({
        summary: { deals: [{ dealId: "deal-1", companyName: "Acme" }] },
      }),
    ).toEqual({ dealId: "deal-1", dealName: "Acme", multipleDeals: false });
  });

  it("flags a bulk import response that created multiple deals, without picking one", () => {
    expect(
      resolveDealFromResponse({
        summary: {
          deals: [
            { dealId: "deal-1", companyName: "Acme" },
            { dealId: "deal-2", companyName: "Beta" },
          ],
        },
      }),
    ).toEqual({ dealId: null, dealName: null, multipleDeals: true });
  });

  it("returns nulls when the response has neither a deal nor a summary", () => {
    expect(resolveDealFromResponse({})).toEqual({ dealId: null, dealName: null, multipleDeals: false });
  });

  it("returns nulls when a bulk import created zero deals", () => {
    expect(resolveDealFromResponse({ summary: { deals: [] } })).toEqual({
      dealId: null,
      dealName: null,
      multipleDeals: false,
    });
  });
});
