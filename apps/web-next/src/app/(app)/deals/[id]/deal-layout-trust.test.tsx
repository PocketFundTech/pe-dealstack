/**
 * One confidence number + trust gate on the deal header.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const get = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (...a: unknown[]) => get(...a) } }));

import { invalidateApiCache } from "@/lib/useApiQuery";
import { FinancialMetricsRow, FinancialStatusBadge } from "./deal-layout";
import type { DealDetail } from "./deal-detail-shared";

const DEAL_ID = "deal-csp";
const deal: DealDetail = {
  id: DEAL_ID,
  name: "CSP",
  stage: "DUE_DILIGENCE",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  currency: "USD",
  cachedPeriod: "2025",
  cachedRevenue: 12_500_000,
  cachedEbitda: 3_600_000,
  cachedEbitdaMargin: 29,
} as DealDetail;

const stmts = [{ statementType: "INCOME_STATEMENT", period: "2025", periodType: "HISTORICAL", extractionConfidence: 73, lineItems: {} }];
const warnings = [1, 2, 3, 4].map((i) => ({ check: `w${i}`, passed: false, severity: "warning", message: `w${i}`, period: "2025" }));

function mockApi(checks: unknown[]) {
  get.mockImplementation(async (path: string) => {
    if (path.endsWith("/financials/validation")) return { checks, errorCount: 0, warningCount: checks.length, infoCount: 0, overallPassed: true };
    return stmts;
  });
}

beforeEach(() => {
  get.mockReset();
  invalidateApiCache();
});

describe("FinancialStatusBadge", () => {
  it("shows 73% with calm amber reason, never the word low", async () => {
    mockApi(warnings);
    render(<FinancialStatusBadge dealId={DEAL_ID} />);
    const el = await screen.findByText(/73%/);
    await waitFor(() => expect(el.textContent).toContain("4 items to review"));
    expect(el.textContent).not.toMatch(/low/i);
    expect(el.className).toMatch(/amber/);
  });
});

describe("FinancialMetricsRow trust gate", () => {
  it("shows figures normally with warnings only", async () => {
    mockApi(warnings);
    render(<FinancialMetricsRow deal={deal} />);
    expect(await screen.findByText("$12.5M")).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByText(/Needs review/)).toBeNull();
  });

  it("replaces figures with Needs review + reason when an error exists for the card period", async () => {
    mockApi([{ check: "e", passed: false, severity: "error", message: "EBITDA exceeds revenue in 2025", period: "2025" }]);
    render(<FinancialMetricsRow deal={deal} />);
    expect((await screen.findAllByText("Needs review")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/EBITDA exceeds revenue in 2025/).length).toBeGreaterThan(0);
    expect(screen.queryByText("$12.5M")).toBeNull();
  });

  it("does not gate on an error for a different period", async () => {
    mockApi([{ check: "e", passed: false, severity: "error", message: "bad", period: "2024" }]);
    render(<FinancialMetricsRow deal={deal} />);
    expect(await screen.findByText("$12.5M")).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByText("Needs review")).toBeNull();
  });
});
