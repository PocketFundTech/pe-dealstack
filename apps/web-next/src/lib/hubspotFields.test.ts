import { describe, it, expect } from "vitest";
import { humanizeHubspotKey, formatHubspotValue, visibleHubspotFields } from "./hubspotFields";

describe("humanizeHubspotKey", () => {
  it("maps known HubSpot standard keys to readable CRM labels", () => {
    expect(humanizeHubspotKey("closedate")).toBe("Close Date");
    expect(humanizeHubspotKey("numberofemployees")).toBe("Employees");
    expect(humanizeHubspotKey("lifecyclestage")).toBe("Lifecycle Stage");
  });

  it("title-cases snake_case custom keys", () => {
    expect(humanizeHubspotKey("fund_vintage")).toBe("Fund Vintage");
    expect(humanizeHubspotKey("sector_focus")).toBe("Sector Focus");
  });

  it("leaves an already-readable single word capitalised", () => {
    expect(humanizeHubspotKey("industry")).toBe("Industry");
  });
});

describe("formatHubspotValue", () => {
  it("formats an ISO timestamp as a readable date", () => {
    expect(formatHubspotValue("2026-07-15T00:00:00Z")).toBe("15 Jul 2026");
  });

  it("leaves plain strings untouched", () => {
    expect(formatHubspotValue("SaaS")).toBe("SaaS");
  });

  it("does not mangle numeric strings into dates", () => {
    expect(formatHubspotValue("2026")).toBe("2026");
  });
});

describe("visibleHubspotFields", () => {
  it("drops blank and null values", () => {
    const out = visibleHubspotFields({ fund_vintage: "2021", empty: "", missing: null });
    expect(out.map((f) => f.key)).toEqual(["fund_vintage"]);
  });

  it("returns an empty list for null properties", () => {
    expect(visibleHubspotFields(null)).toEqual([]);
  });

  it("sorts fields alphabetically by their readable label", () => {
    const out = visibleHubspotFields({ sector_focus: "SaaS", closedate: "2026-07-15T00:00:00Z" });
    expect(out.map((f) => f.label)).toEqual(["Close Date", "Sector Focus"]);
  });

  it("exposes the formatted value alongside the raw key", () => {
    const [field] = visibleHubspotFields({ closedate: "2026-07-15T00:00:00Z" });
    expect(field).toEqual({ key: "closedate", label: "Close Date", value: "15 Jul 2026" });
  });
});
