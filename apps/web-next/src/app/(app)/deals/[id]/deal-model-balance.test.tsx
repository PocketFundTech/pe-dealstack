/**
 * "Build model" panel — fix plan E3: working capital (DSO / DIO / DPO or
 * NWC %), capex %, debt tranches and minimum cash per case, previewed with
 * the shared calculator (the workbook's arithmetic), and models saved
 * before E3 still loading.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { projectModel, summariseCase } from "@ai-crm/shared";
import { BASE_VALUES, LINES, OPENING, assumptions, casesResponse, legacyAssumptions } from "./deal-model-fixture.test-helpers";

const get = vi.fn();
const put = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (...a: unknown[]) => get(...a), put: (...a: unknown[]) => put(...a) } }));
vi.mock("@/providers/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/app/(app)/deal-intake/components", () => ({ authFetchRaw: vi.fn() }));

import { DealModelPanel } from "./deal-model-panel";

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  get.mockResolvedValue(casesResponse());
  put.mockResolvedValue({ success: true });
});

async function renderPanel() {
  render(<DealModelPanel dealId="deal-1" />);
  await screen.findByText("Working capital, capex & debt");
}

const pctText = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

describe("DealModelPanel — working capital, capex and debt (E3)", () => {
  it("shows DSO / DIO / DPO and capex % per year, and the opening net debt refinanced at entry", async () => {
    await renderPanel();
    expect(screen.getByLabelText("Working capital method")).toHaveValue("DAYS");
    expect(screen.getByLabelText("DSO Y1")).toHaveValue(48);
    expect(screen.getByLabelText("DPO Y5")).toHaveValue(40);
    expect(screen.getByLabelText("Capex % Y1")).toHaveValue(4);
    expect(screen.getByTestId("opening-net-debt")).toHaveTextContent("$3.7m");
    const expected = projectModel(LINES, BASE_VALUES, assumptions(), OPENING);
    expect(within(screen.getByTestId("balance-out-dnwc")).getByText(expected.deltaNwc[0].toFixed(1))).toBeInTheDocument();
    expect(within(screen.getByTestId("balance-out-lfcf")).getByText(expected.leveredFcf[1].toFixed(1))).toBeInTheDocument();
  });

  it("moves ΔNWC and the active case's IRR when DSO changes — same arithmetic as the workbook", async () => {
    await renderPanel();
    fireEvent.change(screen.getByLabelText("DSO Y1"), { target: { value: "90" } });
    const changed = assumptions();
    changed.balanceDrivers!.dso = [90, 48, 48, 48, 48];
    const p = projectModel(LINES, BASE_VALUES, changed, OPENING);
    await waitFor(() => expect(within(screen.getByTestId("balance-out-dnwc")).getByText(p.deltaNwc[0].toFixed(1))).toBeInTheDocument());
    expect(screen.getByTestId("summary-IRR-Base")).toHaveTextContent(pctText(summariseCase(LINES, BASE_VALUES, changed, OPENING).irr));
    expect(screen.getByRole("tab", { name: "Base •" })).toBeInTheDocument();
  });

  it("switches working capital to % of revenue for every case, and saves it", async () => {
    await renderPanel();
    fireEvent.change(screen.getByLabelText("Working capital method"), { target: { value: "PCT_REVENUE" } });
    expect(screen.getByLabelText("NWC % Y1")).toHaveValue(9);
    expect(screen.queryByLabelText("DSO Y1")).toBeNull();
    for (const c of ["Low", "Base", "High"]) expect(screen.getByRole("tab", { name: `${c} •` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Low •" }));
    expect(screen.getByLabelText("Working capital method")).toHaveValue("PCT_REVENUE");
    fireEvent.click(screen.getByRole("button", { name: "Save Low" }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1].balanceDrivers.nwcMethod).toBe("PCT_REVENUE");
  });

  it("offers maintenance + growth capex", async () => {
    await renderPanel();
    fireEvent.change(screen.getByLabelText("Capex method"), { target: { value: "SPLIT" } });
    expect(screen.getByLabelText("Maintenance capex % Y1")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Growth capex % Y2"), { target: { value: "2" } });
    expect(screen.getByLabelText("Growth capex % Y2")).toHaveValue(2);
  });

  it("edits the second tranche and minimum cash per case — the equity cheque follows", async () => {
    await renderPanel();
    fireEvent.change(screen.getByLabelText("Second tranche size"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Minimum cash"), { target: { value: "0.5" } });
    const p = projectModel(LINES, BASE_VALUES, { ...assumptions(), debt2Quantum: 1, minCash: 0.5 }, OPENING);
    await waitFor(() => expect(screen.getByText(`$${p.equity.toFixed(1)}m`)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save Base" }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1]).toMatchObject({ debt2Quantum: 1, minCash: 0.5 });
  });

  it("loads a case saved before E3 (scalar NWC / capex %) as % of revenue drivers", async () => {
    const res = casesResponse();
    res.cases[1].assumptions = legacyAssumptions();
    get.mockResolvedValue(res);
    await renderPanel();
    expect(screen.getByLabelText("Working capital method")).toHaveValue("PCT_REVENUE");
    expect(screen.getByLabelText("NWC % Y3")).toHaveValue(10);
    expect(screen.getByLabelText("Capex % Y1")).toHaveValue(3);
    expect(screen.getByLabelText("Second tranche size")).toHaveValue(0);
    const p = projectModel(LINES, BASE_VALUES, legacyAssumptions(), OPENING);
    expect(p.capex[0]).toBeCloseTo(p.revenue[0] * 0.03, 9);
    expect(within(screen.getByTestId("balance-out-capex")).getByText(p.capex[0].toFixed(1))).toBeInTheDocument();
  });
});
