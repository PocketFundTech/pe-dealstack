import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const get = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (...a: unknown[]) => get(...a), post: vi.fn(), delete: vi.fn() } }));
vi.mock("@/providers/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { DocRequestsPanel } from "./doc-requests-panel";

const openRequest = {
  id: "r1", status: "OPEN", recipientEmail: "cfo@t.com", recipientName: null, message: null, revokedAt: null,
  createdAt: "2026-10-05T10:00:00Z", expiresAt: null, url: "https://x/upload/t", items: [],
};

beforeEach(() => { get.mockReset(); get.mockResolvedValue({ requests: [openRequest] }); });

describe("DocRequestsPanel refresh (5 Oct testing, item 14)", () => {
  it("refresh button reloads the requests", async () => {
    render(<DocRequestsPanel dealId="d1" />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Refresh document requests" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("reloads when the tab becomes visible again", async () => {
    render(<DocRequestsPanel dealId="d1" />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});
