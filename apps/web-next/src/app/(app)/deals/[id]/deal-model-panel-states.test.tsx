/**
 * Fix plan G7: the Build model panel says why it can't show something.
 * Before: a server failure looked like "No model yet", missing entry EBITDA
 * silently hid the returns tiles, and IRR / MoM showed a bare "—".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApiError } from "@/lib/api";
import { casesResponse } from "./deal-model-fixture.test-helpers";
import { returnsGapReason } from "./deal-model-notices";

const get = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  api: { get: (...a: unknown[]) => get(...a), put: vi.fn() },
}));
vi.mock("@/providers/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/app/(app)/deal-intake/components", () => ({ authFetchRaw: vi.fn() }));

import { DealModelPanel } from "./deal-model-panel";

beforeEach(() => get.mockReset());

describe("DealModelPanel states", () => {
  it("a load failure shows the server's reason and retries", async () => {
    get.mockRejectedValueOnce(new ApiError("Couldn't load this deal's statements from the database. Retry in a moment.", 503, "MODEL_DB_ERROR"));
    get.mockResolvedValueOnce(casesResponse());
    render(<DealModelPanel dealId="deal-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load this deal's statements");
    expect(screen.queryByText("No model yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Build model");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("no extracted financials is an explained empty state, not an error", async () => {
    get.mockResolvedValue({ ...casesResponse(), history: [] });
    render(<DealModelPanel dealId="deal-1" />);
    expect(await screen.findByText("No model yet")).toBeInTheDocument();
    expect(screen.getByText(/no extracted financial statements/)).toBeInTheDocument();
  });

  it("explains why entry value and returns are missing when there is no EBITDA", async () => {
    const res = casesResponse();
    get.mockResolvedValue({ ...res, base: { ...res.base!, ebitda: null, entrySource: "missing" } });
    render(<DealModelPanel dealId="deal-1" />);
    await screen.findByText("Build model");
    expect(screen.getByRole("note")).toHaveTextContent("No EBITDA was found or derived for the base period (FY2024 A)");
  });
});

describe("returnsGapReason", () => {
  it("names a zero equity cheque", () => {
    expect(returnsGapReason({ equity: 0, exitEquity: 5, irr: null, mom: null })).toContain("equity cheque is zero");
  });
  it("names equity wiped out at exit", () => {
    expect(returnsGapReason({ equity: 10, exitEquity: -2, irr: null, mom: -0.2 })).toContain("worth nothing");
  });
  it("is quiet when both are computed (including a 0.0x MoM)", () => {
    expect(returnsGapReason({ equity: 10, exitEquity: 0.0001, irr: -0.9, mom: 0 })).toBeNull();
  });
});
