/**
 * Live rehearsal (15 Oct): the "73% confidence · 2 items to review" chip in
 * the dark-blue Financial Statements header was dark-on-dark and pushed the
 * title onto two lines at laptop width.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FinancialShell } from "./deal-financials-table";

describe("FinancialShell confidence chip", () => {
  it("is a solid, readable pill that never wraps, and the title never wraps", () => {
    render(<FinancialShell avgConfidence={73} reviewCount={2}><div /></FinancialShell>);
    const chip = screen.getByText(/73% confidence/);
    expect(chip.className).toMatch(/bg-amber-100/);
    expect(chip.className).toMatch(/text-amber-900/);
    expect(chip.className).toMatch(/whitespace-nowrap/);
    expect(screen.getByText("Financial Statements").className).toMatch(/whitespace-nowrap/);
  });

  it("uses a solid green pill when confidence is high", () => {
    render(<FinancialShell avgConfidence={92} reviewCount={0}><div /></FinancialShell>);
    expect(screen.getByText(/92% confidence/).className).toMatch(/bg-emerald-100/);
  });
});
