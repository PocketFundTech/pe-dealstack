import { describe, it, expect } from "vitest";
import { buildStatementRows, classifyAccount, humanizeKey, hideEmptyRows, UNCLASSIFIED_KEY } from "./deal-financials-layout";

// Line-item keys as the live extraction stored them for the SRM QuickBooks P&L.
const SRM_PL_KEYS = new Set([
  "revenue", "cogs", "gross_profit", "total_opex", "net_income",
  "gross_sales", "discounts", "refunds",
  "sand_cos", "cement_cos", "fly_ash_cos", "large_gravel_cos",
  "bad_debts", "total_insurance",
  "goodwill_amortization_754", "net_other_income",
  "revenue_source", "mystery_account",
]);

describe("P&L layout (SRM regression)", () => {
  const rows = buildStatementRows("INCOME_STATEMENT", SRM_PL_KEYS);
  const order = rows.map((r) => r.key);
  const parentOf = (k: string) => rows.find((r) => r.key === k)?.parent;

  it("reads top-down: Revenue → COGS → Gross Profit → OpEx → D&A → Other → Net Income", () => {
    const sections = rows.filter((r) => !r.isChild).map((r) => r.key);
    expect(sections).toEqual(["revenue", "cogs", "gross_profit", "total_opex", "da", "other_income", "net_income", UNCLASSIFIED_KEY]);
  });

  it("nests raw accounts under their section", () => {
    expect(["gross_sales", "discounts", "refunds"].map(parentOf)).toEqual(["revenue", "revenue", "revenue"]);
    expect(["sand_cos", "cement_cos", "fly_ash_cos", "large_gravel_cos"].map(parentOf)).toEqual(["cogs", "cogs", "cogs", "cogs"]);
    expect(["bad_debts", "total_insurance"].map(parentOf)).toEqual(["total_opex", "total_opex"]);
    expect(parentOf("goodwill_amortization_754")).toBe("da");
    expect(parentOf("net_other_income")).toBe("other_income");
    expect(parentOf("mystery_account")).toBe(UNCLASSIFIED_KEY);
  });

  it("never shows a balance-sheet Goodwill section on the P&L, and skips _source keys", () => {
    expect(order).not.toContain("goodwill");
    expect(order).not.toContain("revenue_source");
  });

  it("children follow their section directly, before the next section", () => {
    expect(order.indexOf("sand_cos")).toBeGreaterThan(order.indexOf("cogs"));
    expect(order.indexOf("sand_cos")).toBeLessThan(order.indexOf("gross_profit"));
  });
});

describe("other statements", () => {
  it("keeps prefixed children on the balance sheet and groups unknowns", () => {
    const rows = buildStatementRows("BALANCE_SHEET", new Set(["cash", "total_assets", "cash_restricted", "weird_line"]));
    expect(rows.find((r) => r.key === "cash_restricted")?.parent).toBe("cash");
    expect(rows.find((r) => r.key === "weird_line")?.parent).toBe(UNCLASSIFIED_KEY);
  });

  it("does not apply P&L keyword rules to the cash flow", () => {
    expect(classifyAccount("CASH_FLOW", "insurance_proceeds")).toBe(UNCLASSIFIED_KEY);
  });
});

describe("labels", () => {
  it("upper-cases only known acronyms", () => {
    expect(humanizeKey("fly_ash_cos")).toBe("Fly Ash COS");
    expect(humanizeKey("net_fee")).toBe("Net Fee");
    expect(humanizeKey("revenue")).toBe("Revenue");
  });
});

describe("hideEmptyRows", () => {
  it("drops empty children and a parent left with no value and no visible children", () => {
    const rows = buildStatementRows("INCOME_STATEMENT", new Set(["revenue", "cogs", "cement_cos", "sand_cos"]));
    const visible = hideEmptyRows(rows, (k) => k === "revenue" || k === "sand_cos");
    expect(visible.map((r) => r.key)).toEqual(["revenue", "cogs", "sand_cos"]);
  });
});
