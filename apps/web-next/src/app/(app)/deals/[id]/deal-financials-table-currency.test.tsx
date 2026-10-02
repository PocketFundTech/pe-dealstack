/**
 * Fix plan G10: a statement table whose columns come from documents in
 * different currencies said so nowhere — the header showed the first
 * column's currency for the whole table.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FinancialTable } from "./deal-financials-table";

const stmt = (period: string, currency: string, revenue: number) => ({
  id: `${period}-${currency}`, statementType: "INCOME_STATEMENT", period, periodType: "HISTORICAL",
  currency, unitScale: "MILLIONS", lineItems: { revenue }, extractionConfidence: 90, isActive: true,
}) as never;

describe("FinancialTable currency", () => {
  it("warns when columns are in different currencies", () => {
    render(<FinancialTable statements={[stmt("2023", "USD", 20), stmt("2024", "INR", 1800)]} statementType="INCOME_STATEMENT" conflicts={[]} />);
    expect(screen.getByRole("note")).toHaveTextContent("different currencies (USD, INR)");
    expect(screen.getByText(/mixed currencies/)).toBeInTheDocument();
  });

  it("says nothing extra for a single currency", () => {
    render(<FinancialTable statements={[stmt("2023", "USD", 20), stmt("2024", "USD", 22)]} statementType="INCOME_STATEMENT" conflicts={[]} />);
    expect(screen.queryByRole("note")).toBeNull();
  });
});
