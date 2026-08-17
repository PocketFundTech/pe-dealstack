import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PortalView, type PortalPayload } from "./portal-view";

function payload(overrides: Partial<PortalPayload> = {}): PortalPayload {
  return {
    share: { label: "Partner", sharedBy: "Acme Capital", includeFinancials: true, includeDocuments: true, includeMemos: true },
    deal: { name: "Project Neptune", industry: "Software", dealSize: 12, revenue: 10, ebitda: 2, currency: "USD", description: "A software deal." },
    financials: [{ statementType: "INCOME_STATEMENT", period: "FY2023", lineItems: { Revenue: 10 } }],
    documents: [{ id: "doc-1", name: "CIM.pdf", type: "CIM", fileSize: 2048 }],
    memos: [],
    ...overrides,
  };
}

describe("PortalView", () => {
  it("renders deal name, org attribution, and enabled sections", () => {
    render(<PortalView state={{ status: "ready", payload: payload() }} token="tok" />);
    expect(screen.getByText("Project Neptune")).toBeTruthy();
    expect(screen.getByText(/Shared by Acme Capital/)).toBeTruthy();
    expect(screen.getByText("CIM.pdf")).toBeTruthy();
    expect(screen.getByText(/INCOME_STATEMENT/)).toBeTruthy();
    // Download link targets the public download endpoint with the token
    const link = screen.getByText("Download").closest("a");
    expect(link?.getAttribute("href")).toBe("/api/public/portal/tok/documents/doc-1/download");
  });

  it("hides disabled/empty sections", () => {
    render(
      <PortalView
        state={{ status: "ready", payload: payload({ financials: undefined, documents: undefined, memos: undefined }) }}
        token="tok"
      />,
    );
    expect(screen.queryByText("Financials")).toBeNull();
    expect(screen.queryByText("Documents")).toBeNull();
    expect(screen.queryByText("Memos")).toBeNull();
  });

  it("renders the revoked/expired screen for gone state", () => {
    render(<PortalView state={{ status: "gone", message: "This link has been revoked." }} token="tok" />);
    expect(screen.getByText("This link is no longer active")).toBeTruthy();
    expect(screen.getByText("This link has been revoked.")).toBeTruthy();
  });

  it("sanitizes memo HTML — script tags never reach the DOM", () => {
    const evil = payload({
      memos: [{ id: "m1", title: "IC Memo", sections: [{ title: "Thesis", content: '<p>ok</p><script>window.__pwned = true;</script>' }] }],
    });
    const { container } = render(<PortalView state={{ status: "ready", payload: evil }} token="tok" />);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("ok")).toBeTruthy();
  });
});
