import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const post = vi.fn();
vi.mock("@/lib/api", () => ({ api: { post: (...a: unknown[]) => post(...a) } }));
vi.mock("@/providers/NotificationCountProvider", () => ({ useNotificationCount: () => ({ refresh: () => Promise.resolve() }) }));

import { SendReminderModal } from "./SendReminderModal";
import type { AdminDeal, AdminTeamMember } from "./types";

const users: AdminTeamMember[] = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Harish", email: "h@x.com" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Ritish", email: "r@x.com" },
];
const deals: AdminDeal[] = [{ id: "33333333-3333-4333-8333-333333333333", name: "LTDIdeas", stage: "INITIAL_REVIEW", updatedAt: new Date().toISOString() }];

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({});
});

describe("Send reminder sheet", () => {
  it("opens pre-filled from a row's Nudge and sends that reminder", async () => {
    const onToast = vi.fn();
    const onClose = vi.fn();
    render(
      <div className="dash">
        <SendReminderModal
          open
          onClose={onClose}
          deals={deals}
          users={users}
          onToast={onToast}
          prefill={{ userId: users[0].id, dealId: deals[0].id, message: "Quick nudge: Borderless review is overdue." }}
        />
      </div>,
    );

    expect(screen.getByRole("dialog", { name: /send a reminder/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue(/Quick nudge: Borderless review/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /send reminder/i }));

    expect(post).toHaveBeenCalledWith("/notifications", expect.objectContaining({
      userId: users[0].id,
      dealId: deals[0].id,
      message: "Quick nudge: Borderless review is overdue.",
    }));
    expect(onToast).toHaveBeenCalledWith(expect.stringMatching(/sent/i), "success");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<div className="dash"><SendReminderModal open onClose={onClose} deals={deals} users={users} onToast={vi.fn()} /></div>);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
