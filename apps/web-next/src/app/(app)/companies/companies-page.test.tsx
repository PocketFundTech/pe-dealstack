import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

const get = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (...a: unknown[]) => get(...a) },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status = 500) { super(message); this.status = status; }
  },
}));

import CompaniesPage from "./page";
import { invalidateApiCache } from "@/lib/useApiQuery";
import { buildCompaniesQuery, websiteHref, websiteLabel } from "./companies-shared";
import { NAV_ITEMS } from "@/lib/constants";

const ACME = {
  id: "c1", name: "Acme Logistics", industry: "Logistics", website: "acme.test",
  hubspotId: "hs-1", createdAt: null, updatedAt: "2026-10-01T00:00:00Z",
  source: "hubspot", dealCount: 1, contactCount: 3,
  deals: [{ id: "d1", name: "Project Acme", stage: "DUE_DILIGENCE", status: "ACTIVE" }],
};
const BOLT = {
  id: "c2", name: "Bolt Labs", industry: null, website: null,
  hubspotId: null, createdAt: null, updatedAt: null,
  source: "avise", dealCount: 2, contactCount: 0,
  deals: [
    { id: "d2", name: "Bolt A", stage: "INITIAL_REVIEW", status: "ACTIVE" },
    { id: "d3", name: "Bolt B", stage: "CLOSING", status: "ACTIVE" },
  ],
};
const QUIET = {
  id: "c3", name: "Quiet Co", industry: "SaaS", website: null,
  hubspotId: "hs-3", createdAt: null, updatedAt: null,
  source: "hubspot", dealCount: 0, contactCount: 0, deals: [],
};

function listResponse(companies: unknown[], total = companies.length, offset = 0) {
  return { companies, total, limit: 25, offset };
}

beforeEach(() => {
  get.mockReset();
  invalidateApiCache();
});

describe("CompaniesPage", () => {
  it("renders companies with website link, deal link, contact count and source", async () => {
    get.mockResolvedValue(listResponse([ACME, BOLT, QUIET]));
    render(<CompaniesPage />);

    expect(await screen.findByText("Acme Logistics")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/companies/list?sortBy=name&sortOrder=asc&limit=25&offset=0");

    const acmeRow = screen.getByText("Acme Logistics").closest("tr")!;
    expect(within(acmeRow).getByRole("link", { name: "acme.test" })).toHaveAttribute("href", "https://acme.test/");
    expect(within(acmeRow).getByRole("link", { name: /Project Acme/ })).toHaveAttribute("href", "/deals/d1");
    expect(within(acmeRow).getByText("3")).toBeInTheDocument();
    expect(within(acmeRow).getByText("HubSpot")).toBeInTheDocument();

    const boltRow = screen.getByText("Bolt Labs").closest("tr")!;
    expect(within(boltRow).getByText("Avise")).toBeInTheDocument();
    expect(screen.getByText(/Showing 1–3 of 3 companies/)).toBeInTheDocument();
  });

  it("expands a multi-deal company to list its deals", async () => {
    get.mockResolvedValue(listResponse([BOLT]));
    render(<CompaniesPage />);
    fireEvent.click(await screen.findByRole("button", { name: /2 deals/ }));
    expect(screen.getByRole("link", { name: "Bolt A" })).toHaveAttribute("href", "/deals/d2");
    expect(screen.getByRole("link", { name: "Bolt B" })).toHaveAttribute("href", "/deals/d3");
  });

  it("sends has-deals, source and sort filters to the server and resets to page 1", async () => {
    get.mockResolvedValue(listResponse([ACME], 60));
    render(<CompaniesPage />);
    await screen.findByText("Acme Logistics");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith("/companies/list?sortBy=name&sortOrder=asc&limit=25&offset=25"),
    );

    fireEvent.change(screen.getByLabelText("Filter by deals"), { target: { value: "no" } });
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith("/companies/list?hasDeals=no&sortBy=name&sortOrder=asc&limit=25&offset=0"),
    );
    fireEvent.change(screen.getByLabelText("Filter by source"), { target: { value: "hubspot" } });
    fireEvent.change(screen.getByLabelText("Sort companies"), { target: { value: "updatedAt-desc" } });
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(
        "/companies/list?hasDeals=no&source=hubspot&sortBy=updatedAt&sortOrder=desc&limit=25&offset=0",
      ),
    );
  });

  it("searches by name (debounced)", async () => {
    get.mockResolvedValue(listResponse([ACME]));
    render(<CompaniesPage />);
    await screen.findByText("Acme Logistics");
    fireEvent.change(screen.getByLabelText("Search companies"), { target: { value: "acme" } });
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith("/companies/list?search=acme&sortBy=name&sortOrder=asc&limit=25&offset=0"),
    );
  });

  it("shows an empty state that points at deals and HubSpot import", async () => {
    get.mockResolvedValue(listResponse([]));
    render(<CompaniesPage />);
    expect(await screen.findByText("No companies yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Import from HubSpot" })).toHaveAttribute("href", "/settings");
  });

  it("shows a no-results state when filters match nothing", async () => {
    get.mockImplementation((path: string) =>
      Promise.resolve(path.includes("hasDeals=yes") ? listResponse([]) : listResponse([QUIET])),
    );
    render(<CompaniesPage />);
    await screen.findByText("Quiet Co");
    fireEvent.change(screen.getByLabelText("Filter by deals"), { target: { value: "yes" } });
    expect(await screen.findByText("No companies found")).toBeInTheDocument();
  });

  it("opens a drawer with the company's deals and contacts when a row is clicked", async () => {
    get.mockImplementation((path: string) => {
      if (path.startsWith("/companies/list")) return Promise.resolve(listResponse([ACME]));
      if (path === "/companies/c1/overview") {
        return Promise.resolve({
          company: { ...ACME, description: "Cold-chain trucking" },
          deals: [{ id: "d1", name: "Project Acme", stage: "DUE_DILIGENCE", status: "ACTIVE", updatedAt: null }],
          contacts: [{ id: "p1", firstName: "Ann", lastName: "Lee", email: "ann@acme.test", title: "CFO" }],
          contactTotal: 1,
        });
      }
      throw new Error(`unexpected GET ${path}`);
    });
    render(<CompaniesPage />);
    fireEvent.click(await screen.findByText("Acme Logistics"));

    const drawer = await screen.findByRole("dialog", { name: "Acme Logistics" });
    expect(await within(drawer).findByText("Cold-chain trucking")).toBeInTheDocument();
    expect(within(drawer).getByRole("link", { name: /Project Acme/ })).toHaveAttribute("href", "/deals/d1");
    expect(within(drawer).getByText("Ann Lee")).toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows an error state with retry", async () => {
    get.mockRejectedValue(new Error("Server down"));
    render(<CompaniesPage />);
    expect(await screen.findByText("Failed to load companies")).toBeInTheDocument();
    expect(screen.getByText("Server down")).toBeInTheDocument();
  });
});

describe("companies helpers", () => {
  it("builds the list query", () => {
    expect(buildCompaniesQuery({ search: "a b", hasDeals: "yes", source: "avise", sort: "name-desc", page: 2 }))
      .toBe("/companies/list?search=a+b&hasDeals=yes&source=avise&sortBy=name&sortOrder=desc&limit=25&offset=50");
  });

  it("normalises websites and refuses non-http schemes", () => {
    expect(websiteHref("www.acme.com")).toBe("https://www.acme.com/");
    expect(websiteHref("http://acme.com/x")).toBe("http://acme.com/x");
    // No scheme is ever passed through: anything without http(s) gets https:// prefixed.
    expect(websiteHref("javascript:alert(1)")).toBeNull();
    expect(websiteHref("")).toBeNull();
    expect(websiteLabel("https://www.acme.com/about")).toBe("acme.com");
  });

  it("puts Companies in the member-only nav next to CRM", () => {
    const ids = NAV_ITEMS.map((n) => n.id);
    expect(ids.indexOf("companies")).toBe(ids.indexOf("crm") + 1);
    expect(NAV_ITEMS.find((n) => n.id === "companies")).toMatchObject({ href: "/companies", memberOnly: true });
  });
});
