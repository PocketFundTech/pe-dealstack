/**
 * An empty deal (no statements) must still offer per-document extraction,
 * so a user can extract ONE file instead of running the bulk extraction
 * over every spreadsheet + CIM.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const get = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (...a: unknown[]) => get(...a), post: vi.fn() },
}));

import { FinancialStatementsPanel } from "./deal-financials";

function mockApi(documents: unknown[]) {
  get.mockImplementation(async (p?: string) => {
    const path = String(p ?? "");
    if (path.endsWith("/financials/validation")) return { flags: [] };
    if (path.endsWith("/financials/conflicts")) return { conflicts: [], count: 0 };
    if (path.endsWith("/financials")) return [];
    return { documents };
  });
}

describe("FinancialStatementsPanel empty state", () => {
  beforeEach(() => get.mockReset());

  it("offers per-document extract when the deal has documents but no statements", async () => {
    mockApi([{ id: "d1", name: "Model.xlsx", type: "EXCEL" }]);
    render(<FinancialStatementsPanel dealId="deal-1" />);
    await waitFor(() => expect(screen.getByText(/Extract a single document/i)).toBeTruthy());
    expect(screen.getByText("Model.xlsx")).toBeTruthy();
  });

  it("shows no per-document list when the deal has no documents", async () => {
    mockApi([]);
    render(<FinancialStatementsPanel dealId="deal-1" />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Extract a single document/i)).toBeNull();
  });
});
