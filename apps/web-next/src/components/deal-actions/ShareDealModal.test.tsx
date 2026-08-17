import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShareDealModal } from "./ShareDealModal";

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiDelete = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue({ shares: [] });
});

describe("ShareDealModal", () => {
  it("creates a share with defaults and shows the returned link", async () => {
    apiPost.mockResolvedValue({ share: { id: "s1" }, url: "http://localhost:3002/portal/tok123" });
    render(<ShareDealModal dealId="deal-1" dealName="Neptune" onClose={() => {}} />);

    fireEvent.click(screen.getByText("Create link"));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith("/deals/deal-1/shares", expect.objectContaining({
        includeFinancials: true,
        includeDocuments: true,
        includeMemos: true,
      }));
      expect(screen.getByDisplayValue("http://localhost:3002/portal/tok123")).toBeTruthy();
    });
  });

  it("lists existing shares with view counts and revokes on click", async () => {
    apiGet.mockResolvedValue({
      shares: [{ id: "s1", label: "Partner", invitedEmail: null, url: "u", viewCount: 3, lastViewedAt: "2026-08-05T00:00:00Z", createdAt: "2026-08-01T00:00:00Z", revokedAt: null }],
    });
    apiDelete.mockResolvedValue({ success: true });
    render(<ShareDealModal dealId="deal-1" dealName="Neptune" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("Partner")).toBeTruthy());
    expect(screen.getByText(/3 views/)).toBeTruthy();

    fireEvent.click(screen.getByText("Revoke"));
    await waitFor(() => {
      expect(apiDelete).toHaveBeenCalledWith("/deals/deal-1/shares/s1");
    });
  });

  it("sends section toggles and email when set", async () => {
    apiPost.mockResolvedValue({ share: { id: "s1" }, url: "u" });
    render(<ShareDealModal dealId="deal-1" dealName="Neptune" onClose={() => {}} />);

    fireEvent.click(screen.getByLabelText("Memos"));
    fireEvent.change(screen.getByPlaceholderText("client@firm.com (optional)"), { target: { value: "a@b.com" } });
    fireEvent.click(screen.getByText("Create link"));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith("/deals/deal-1/shares", expect.objectContaining({
        includeMemos: false,
        invitedEmail: "a@b.com",
      }));
    });
  });
});
