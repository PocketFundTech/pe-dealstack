/**
 * "Build model" panel — fix plan E1: a driver row per P&L line (accounts
 * collapsible under their parent), and a live preview that is the
 * workbook's arithmetic (EBITDA = revenue − costs), not growth × EBITDA.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { projectModel } from "@ai-crm/shared";
import { LINES, assumptions, modelResponse } from "./deal-model-fixture.test-helpers";

const get = vi.fn();
const put = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (...a: unknown[]) => get(...a), put: (...a: unknown[]) => put(...a) } }));
const showToast = vi.fn();
vi.mock("@/providers/ToastProvider", () => ({ useToast: () => ({ showToast }) }));
vi.mock("@/app/(app)/deal-intake/components", () => ({ authFetchRaw: vi.fn() }));

import { DealModelPanel } from "./deal-model-panel";

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  get.mockResolvedValue(modelResponse());
  put.mockResolvedValue({ success: true });
});

async function renderPanel() {
  render(<DealModelPanel dealId="deal-1" />);
  await screen.findByText("P&L drivers by line (5 years)");
}

describe("DealModelPanel — per-line drivers", () => {
  it("lists every line, with accounts collapsed under their parent until expanded", async () => {
    await renderPanel();
    expect(screen.getByTestId("driver-row-revenue")).toBeInTheDocument();
    expect(screen.getByTestId("driver-row-ebitda")).toBeInTheDocument();
    expect(screen.queryByTestId("driver-row-cogs_cement")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand COGS" }));
    expect(screen.getByTestId("driver-row-cogs_cement")).toBeInTheDocument();
    expect(screen.getByLabelText("Cement method")).toHaveValue("PCT_REVENUE");
  });

  it("shows subtotals read-only, computed as the workbook does", async () => {
    await renderPanel();
    const expected = projectModel(LINES, modelResponse().baseValues, assumptions());
    const row = screen.getByTestId("driver-row-ebitda");
    expect(within(row).getByText("Subtotal")).toBeInTheDocument();
    expect(within(row).getByText(expected.ebitda[0].toFixed(1))).toBeInTheDocument();
    // margin × revenue: 100 − 30 − 7 − 50 = 13%
    expect(expected.ebitda[0]).toBeCloseTo(27.3 * 1.1 * 0.13, 6);
  });

  it("moves the preview when a cost driver changes", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Expand COGS" }));
    const before = screen.getByTestId("driver-row-ebitda").textContent;
    fireEvent.change(screen.getByLabelText("Cement Y1"), { target: { value: "20" } });
    const changed = assumptions();
    changed.lineDrivers.cogs_cement = { method: "PCT_REVENUE", values: [20, 30, 30, 30, 30] };
    const expected = projectModel(LINES, modelResponse().baseValues, changed);
    await waitFor(() => expect(screen.getByTestId("driver-row-ebitda").textContent).not.toBe(before));
    expect(within(screen.getByTestId("driver-row-ebitda")).getByText(expected.ebitda[0].toFixed(1))).toBeInTheDocument();
  });

  it("keeps the figures when the method changes (30% of revenue → the same amount, Fixed)", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Expand COGS" }));
    fireEvent.change(screen.getByLabelText("Cement method"), { target: { value: "FIXED" } });
    expect(screen.getByLabelText("Cement Y1")).toHaveValue(Math.round(27.3 * 1.1 * 0.3 * 1000) / 1000);
  });

  it("saves the line drivers", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [path, body] = put.mock.calls[0];
    expect(path).toBe("/deals/deal-1/model");
    expect(body.lineDrivers.cogs_cement.values).toEqual([30, 30, 30, 30, 30]);
  });
});
