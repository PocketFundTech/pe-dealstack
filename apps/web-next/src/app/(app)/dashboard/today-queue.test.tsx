import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TodayQueue } from "./today-queue";
import { UndoBar } from "@/components/dash/undo-bar";
import { buildTodayQueue, DAY_MS } from "./triage";
import type { Deal, Task } from "./components";

const NOW = new Date(2026, 8, 27, 10).getTime();
const at = (d: number) => new Date(NOW + d * DAY_MS).toISOString();

const tasks: Task[] = [{ id: "t1", title: "Send QoE scope to Meridian", status: "PENDING", dueDate: at(-2) }];
const deals: Deal[] = [
  { id: "d1", name: "Apex Precision", stage: "DUE_DILIGENCE", updatedAt: at(-1) },
  { id: "d2", name: "Project Cedar", stage: "INITIAL_REVIEW", updatedAt: at(-30), assignedUser: { name: "Ganesh" } },
];

function renderQueue(overrides: Partial<Parameters<typeof TodayQueue>[0]> = {}) {
  const props = {
    items: buildTodayQueue(deals, tasks, { userId: "me", now: NOW }),
    loading: false,
    error: false,
    now: NOW,
    nextTask: null,
    onRetry: vi.fn(),
    onComplete: vi.fn(),
    onSnooze: vi.fn(),
    onAssign: vi.fn(),
    loadTeam: vi.fn().mockResolvedValue([{ id: "u2", name: "Ritish Maheshwari" }]),
    ...overrides,
  };
  render(<TodayQueue {...props} />);
  return props;
}

describe("TodayQueue", () => {
  it("lists overdue, unowned and stale items in priority order", () => {
    renderQueue();
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(rows[0]).toMatch(/Overdue.*Send QoE scope.*2 days overdue/);
    expect(rows[1]).toMatch(/No owner.*Apex Precision/);
    expect(rows[2]).toMatch(/Going stale.*Project Cedar.*No update in 30 days/);
  });

  it("completes a task and snoozes an item", async () => {
    const props = renderQueue();
    await userEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(props.onComplete).toHaveBeenCalledWith(tasks[0]);
    await userEvent.click(screen.getAllByRole("button", { name: /snooze/i })[0]);
    expect(props.onSnooze).toHaveBeenCalledWith(expect.objectContaining({ key: "task:t1" }));
  });

  it("assigns an owner from the team menu", async () => {
    const props = renderQueue();
    await userEvent.click(screen.getByRole("button", { name: /assign/i }));
    await userEvent.click(await screen.findByRole("option", { name: /Ritish Maheshwari/ }));
    expect(props.onAssign).toHaveBeenCalledWith(deals[0], { id: "u2", name: "Ritish Maheshwari" });
  });

  it("shows the next deadline when the queue is empty", () => {
    renderQueue({ items: [], nextTask: { id: "n", title: "IC memo draft", status: "PENDING", dueDate: at(1) } });
    expect(screen.getByText(/clear for today/i)).toBeInTheDocument();
    expect(screen.getByText(/IC memo draft/)).toBeInTheDocument();
  });
});

describe("UndoBar", () => {
  it("runs undo and dismisses", async () => {
    const undo = vi.fn();
    const onDismiss = vi.fn();
    render(<UndoBar notice={{ id: 1, message: "Done: Send QoE scope", undo }} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
