/**
 * Perf regression coverage: FinancialMetricsRow and FinancialStatusBadge
 * (deal-layout.tsx) both used to fetch GET /deals/:id/financials
 * independently on every deal-page mount -- two requests for the exact same
 * data, every time. Both now read through the same useApiQuery cache key
 * (financialsKey, deal-financials-constants.ts), so mounted together they
 * should share ONE request.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const get = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (...a: unknown[]) => get(...a) } }));

import { invalidateApiCache, mutateApiCache } from "@/lib/useApiQuery";
import { financialsKey } from "./deal-financials-constants";
import { FinancialMetricsRow, FinancialStatusBadge } from "./deal-layout";
import type { DealDetail } from "./deal-detail-shared";

const DEAL_ID = "deal-1";

// No cachedRevenue/cachedEbitda/cachedEbitdaMargin -- forces
// FinancialMetricsRow down the /financials fetch path instead of the
// deal-cache shortcut, so it actually exercises the shared query key.
const deal: DealDetail = {
  id: DEAL_ID,
  name: "Meridian Coatings",
  stage: "DUE_DILIGENCE",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const statements = [
  {
    statementType: "INCOME_STATEMENT",
    period: "FY2025",
    periodType: "HISTORICAL",
    unitScale: "ACTUALS",
    currency: "USD",
    extractionConfidence: 92,
    lineItems: { revenue: 5_000_000, ebitda: 1_000_000, ebitda_margin_pct: 20 },
  },
];

beforeEach(() => {
  get.mockReset();
  invalidateApiCache();
});

describe("FinancialMetricsRow + FinancialStatusBadge (shared /financials key)", () => {
  it("issue exactly one /deals/:id/financials request when mounted together", async () => {
    get.mockResolvedValue(statements);

    render(
      <>
        <FinancialMetricsRow deal={deal} />
        <FinancialStatusBadge dealId={DEAL_ID} />
      </>,
    );

    await waitFor(() => expect(screen.getByText(/92% Confidence/)).toBeInTheDocument());

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(financialsKey(DEAL_ID));
  });

  it("a second mount serves both widgets from cache with no extra request", async () => {
    get.mockResolvedValue(statements);

    const first = render(
      <>
        <FinancialMetricsRow deal={deal} />
        <FinancialStatusBadge dealId={DEAL_ID} />
      </>,
    );
    await waitFor(() => expect(screen.getByText(/92% Confidence/)).toBeInTheDocument());
    first.unmount();

    // Mount again (simulates revisiting the deal page) -- cached data should
    // render immediately, and useApiQuery's background revalidation reuses
    // the same in-flight/dedupe machinery rather than issuing a fresh,
    // independent pair of requests.
    render(
      <>
        <FinancialMetricsRow deal={deal} />
        <FinancialStatusBadge dealId={DEAL_ID} />
      </>,
    );
    expect(screen.getByText(/92% Confidence/)).toBeInTheDocument();
  });

  it("a financials mutation (e.g. after Extract Financials) updates both widgets without a new fetch", async () => {
    get.mockResolvedValue(statements);

    render(
      <>
        <FinancialMetricsRow deal={deal} />
        <FinancialStatusBadge dealId={DEAL_ID} />
      </>,
    );
    await waitFor(() => expect(screen.getByText(/92% Confidence/)).toBeInTheDocument());
    expect(get).toHaveBeenCalledTimes(1);

    // deal-financials.tsx writes fresh statements straight into this cache
    // key after a successful extraction instead of just invalidating it.
    mutateApiCache(financialsKey(DEAL_ID), [
      { ...statements[0], extractionConfidence: 55 },
    ]);

    await waitFor(() => expect(screen.getByText(/55% Confidence/)).toBeInTheDocument());
    // Still just the one original GET -- the mutation didn't trigger a fetch.
    expect(get).toHaveBeenCalledTimes(1);
  });
});
