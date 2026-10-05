import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { PortalView, type PortalPayload } from "./portal-view";

function payload(overrides: Partial<PortalPayload> = {}): PortalPayload {
  return {
    share: { label: "Partner", sharedBy: "Acme Capital", sharedAt: "2026-10-01T10:00:00Z", includeFinancials: true, includeDocuments: true, includeMemos: true },
    deal: { name: "Project Neptune", companyName: "NeptuneCo", industry: "Software", stage: "DUE_DILIGENCE", dealSize: 12, revenue: 10, ebitda: 2, currency: "USD", description: "A software deal." },
    financials: [
      { statementType: "INCOME_STATEMENT", period: "2025 YTD (Jan - Sep 2025)", lineItems: { revenue: 9, cogs: -1 } },
      { statementType: "INCOME_STATEMENT", period: "FY2023", lineItems: { revenue: 10, cogs_cement: 4, cogs: 4 } },
    ],
    documents: [{ id: "doc-1", name: "CIM.pdf", type: "CIM", fileSize: 2048 }],
    memos: [],
    ...overrides,
  };
}

describe("PortalView (QA #25c redesign)", () => {
  it("header shows firm, deal, stage badge, company and industry", () => {
    render(<PortalView state={{ status: "ready", payload: payload() }} token="tok" />);
    expect(screen.getByRole("heading", { name: "Project Neptune" })).toBeTruthy();
    expect(screen.getByText("Due Diligence")).toBeTruthy();
    expect(screen.getByText("NeptuneCo · Software")).toBeTruthy();
    expect(screen.getAllByText("Acme Capital").length).toBeGreaterThan(0);
  });

  it("metric cards: revenue, EBITDA, margin and deal size", () => {
    render(<PortalView state={{ status: "ready", payload: payload() }} token="tok" />);
    const metrics = within(screen.getByLabelText("Key metrics"));
    expect(metrics.getByText("EBITDA margin")).toBeTruthy();
    expect(metrics.getByText("20.0%")).toBeTruthy();
    expect(metrics.getByText("Deal size")).toBeTruthy();
  });

  it("tabs only for shared sections; financials in date order with nested accounts", () => {
    render(<PortalView state={{ status: "ready", payload: payload() }} token="tok" />);
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Financials", "Documents1"]); // memos empty → no tab
    expect(screen.getByText("Income statement")).toBeTruthy();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Line item", "FY2023", "2025 YTD (Jan - Sep 2025)"]);
    expect(screen.getByText("Cement")).toBeTruthy(); // cogs_cement nested under COGS
    expect(screen.getByText(/^\(.*1/)).toBeTruthy(); // accounting-style negative
  });

  it("documents tab: download link targets the public endpoint with the token", () => {
    render(<PortalView state={{ status: "ready", payload: payload() }} token="tok" />);
    fireEvent.click(screen.getByRole("tab", { name: /Documents/ }));
    const link = screen.getByText("Download").closest("a");
    expect(screen.getByText("CIM.pdf")).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/api/public/portal/tok/documents/doc-1/download");
  });

  it("footer says who shared it and when", () => {
    render(<PortalView state={{ status: "ready", payload: payload() }} token="tok" />);
    expect(screen.getByText(/on October 1, 2026/)).toBeTruthy();
  });

  it("hides disabled/empty sections", () => {
    render(
      <PortalView
        state={{ status: "ready", payload: payload({ financials: undefined, documents: undefined, memos: undefined }) }}
        token="tok"
      />,
    );
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("renders the revoked/expired screen for gone state", () => {
    render(<PortalView state={{ status: "gone", message: "This link has been revoked." }} token="tok" />);
    expect(screen.getByText("This link is no longer active")).toBeTruthy();
    expect(screen.getByText("This link has been revoked.")).toBeTruthy();
  });

  it("sanitizes memo HTML — script tags never reach the DOM", () => {
    const evil = payload({
      financials: undefined,
      documents: undefined,
      memos: [{ id: "m1", title: "IC Memo", sections: [{ title: "Thesis", content: '<p>ok</p><script>window.__pwned = true;</script>' }] }],
    });
    const { container } = render(<PortalView state={{ status: "ready", payload: evil }} token="tok" />);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("ok")).toBeTruthy();
  });
});
