/**
 * Fix plan H3 — the Balance Sheet section shows the entry and projected
 * net-assets columns and says whether the check balances.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { projectModel } from "@ai-crm/shared";
import { BASE_VALUES, LINES, OPENING, assumptions } from "./deal-model-fixture.test-helpers";
import { BalanceSheetSection } from "./deal-model-balance-sheet";

describe("BalanceSheetSection", () => {
  it("renders entry + every projected year and reports the check as balanced", () => {
    const a = assumptions();
    const p = projectModel(LINES, BASE_VALUES, a, OPENING);
    render(<BalanceSheetSection assumptions={a} projection={p} opening={OPENING} currency="USD" />);
    expect(screen.getByText("Goodwill")).toBeInTheDocument();
    expect(screen.getByText("Total net assets")).toBeInTheDocument();
    expect(screen.getByTestId("balance-check")).toHaveTextContent("Balances");
    // One "Closing" entry column plus one per projected year.
    expect(screen.getAllByText(/^Y[1-5]$/)).toHaveLength(a.projectionYears);
  });

  it("renders nothing without a projection (e.g. no entry EBITDA)", () => {
    const { container } = render(<BalanceSheetSection assumptions={assumptions()} projection={null} currency="USD" />);
    expect(container).toBeEmptyDOMElement();
  });
});
