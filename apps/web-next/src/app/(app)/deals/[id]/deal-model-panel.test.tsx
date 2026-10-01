/**
 * "Build model" panel — fix plan E1: a driver row per P&L line (accounts
 * collapsible under their parent), and a live preview that is the
 * workbook's arithmetic (EBITDA = revenue − costs), not growth × EBITDA.
 * E2: Low / Base / High tabs, save per case, three-case summary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { projectModel, summariseCase } from "@ai-crm/shared";
import { BASE_VALUES, LINES, OPENING, assumptions, casesResponse, seeded } from "./deal-model-fixture.test-helpers";

const get = vi.fn();
const put = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (...a: unknown[]) => get(...a), put: (...a: unknown[]) => put(...a) } }));
const showToast = vi.fn();
vi.mock("@/providers/ToastProvider", () => ({ useToast: () => ({ showToast }) }));
const authFetchRaw = vi.fn();
vi.mock("@/app/(app)/deal-intake/components", () => ({ authFetchRaw: (...a: unknown[]) => authFetchRaw(...a) }));

import { DealModelPanel } from "./deal-model-panel";

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  authFetchRaw.mockReset();
  get.mockResolvedValue(casesResponse());
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
    const expected = projectModel(LINES, BASE_VALUES, assumptions());
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
    const expected = projectModel(LINES, BASE_VALUES, changed);
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
    fireEvent.click(screen.getByRole("button", { name: "Save Base" }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [path, body] = put.mock.calls[0];
    expect(path).toBe("/deals/deal-1/model?case=Base");
    expect(body.lineDrivers.cogs_cement.values).toEqual([30, 30, 30, 30, 30]);
  });
});

describe("DealModelPanel — Low / Base / High (E2)", () => {
  it("loads all three cases and summarises IRR, MoM and exit EV side by side", async () => {
    await renderPanel();
    expect(get).toHaveBeenCalledWith("/deals/deal-1/model/cases");
    for (const [c, a] of [["Low", seeded("Low")], ["Base", assumptions()], ["High", seeded("High")]] as const) {
      const s = summariseCase(LINES, BASE_VALUES, a, OPENING);
      expect(screen.getByTestId(`summary-IRR-${c}`)).toHaveTextContent(`${(s.irr! * 100).toFixed(1)}%`);
      expect(screen.getByTestId(`summary-MoM-${c}`)).toHaveTextContent(`${s.mom!.toFixed(2)}x`);
    }
    expect(screen.getByRole("tab", { name: "Low (seeded)" })).toBeInTheDocument();
  });

  it("switches case with the tabs and saves only that case", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("tab", { name: "High (seeded)" }));
    expect(screen.getByRole("tab", { name: "High (seeded)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Revenue Y1")).toHaveValue(13); // High revenue growth
    fireEvent.click(screen.getByRole("button", { name: "Save High" }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][0]).toBe("/deals/deal-1/model?case=High");
    expect(put.mock.calls[0][1].exitMultiple).toBe(6);
    await waitFor(() => expect(screen.getByRole("tab", { name: "High" })).toBeInTheDocument());
  });

  it("edits move only the active case's summary", async () => {
    await renderPanel();
    const lowBefore = screen.getByTestId("summary-IRR-Low").textContent;
    const baseBefore = screen.getByTestId("summary-IRR-Base").textContent;
    fireEvent.click(screen.getByRole("tab", { name: "Low (seeded)" }));
    fireEvent.change(screen.getByLabelText("Revenue Y1"), { target: { value: "0" } });
    await waitFor(() => expect(screen.getByTestId("summary-IRR-Low").textContent).not.toBe(lowBefore));
    expect(screen.getByTestId("summary-IRR-Base").textContent).toBe(baseBefore);
    expect(screen.getByRole("tab", { name: "Low •" })).toBeInTheDocument();
  });

  it("downloads all three cases, opened on the active one", async () => {
    authFetchRaw.mockResolvedValue({ ok: false, json: async () => ({ error: "stop here" }) });
    await renderPanel();
    fireEvent.click(screen.getByRole("tab", { name: "High (seeded)" }));
    fireEvent.click(screen.getByRole("button", { name: /Download/ }));
    await waitFor(() => expect(authFetchRaw).toHaveBeenCalled());
    const [path, init] = authFetchRaw.mock.calls[0];
    expect(path).toBe("/deals/deal-1/model/export?case=High");
    const body = JSON.parse(init.body);
    expect(Object.keys(body.cases)).toEqual(["Low", "Base", "High"]);
    expect(body.activeCase).toBe("High");
  });
});
