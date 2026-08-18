/**
 * PROD REGRESSION (2026-08-18): PortfolioSignalsWidget called
 * `api.get("/ai/scan-signals")` while the route is `router.post`. Every scan
 * 404'd, so the Portfolio Signal Monitor looked unbuilt — even though the
 * backend had been returning real signals the whole time. The widget was
 * also hidden by default, so nobody hit the error often enough to report it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));

import { PortfolioSignalsWidget } from "./dashboard-widgets";
import { DEFAULT_VISIBLE } from "./widgets/registry";

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  post.mockResolvedValue({ signals: [], processedCount: 0 });
});

describe("PortfolioSignalsWidget", () => {
  it("scans via POST (the route's actual method), never GET", async () => {
    render(<PortfolioSignalsWidget />);
    await userEvent.click(screen.getByRole("button", { name: /scan signals/i }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe("/ai/scan-signals");
    expect(get).not.toHaveBeenCalled();
  });

  it("renders returned signals", async () => {
    post.mockResolvedValue({
      processedCount: 1,
      signals: [{
        title: "Tightening VOC regulations",
        description: "New EPA limits affect coatings formulation.",
        severity: "warning",
        signalType: "market_shift",
        dealName: "Meridian Industrial Coatings",
        suggestedAction: "Confirm compliance roadmap in diligence.",
      }],
    });
    render(<PortfolioSignalsWidget />);
    await userEvent.click(screen.getByRole("button", { name: /scan signals/i }));
    expect(await screen.findByText(/Tightening VOC regulations/i)).toBeInTheDocument();
  });

  it("is visible on the dashboard out of the box", () => {
    // It was registered but omitted from DEFAULT_VISIBLE, so a user had to
    // know to add it via "Add Widget" — the feature was effectively invisible.
    expect(DEFAULT_VISIBLE).toContain("portfolio-signals");
  });
});
