import { render, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getMock = vi.fn(async () => ({ unreadCount: 3 }));
vi.mock("@/lib/api", () => ({ api: { get: (...args: unknown[]) => getMock(...(args as [])) } }));
vi.mock("./AuthProvider", () => ({ useAuth: () => ({ session: { user: { id: "user-1" } } }) }));

import { NotificationCountProvider } from "./NotificationCountProvider";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

describe("NotificationCountProvider polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getMock.mockReset();
    getMock.mockImplementation(async () => ({ unreadCount: 3 }));
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls every 15s while the tab is visible", async () => {
    render(<NotificationCountProvider>child</NotificationCountProvider>);
    await act(async () => {}); // let the initial poll resolve (the next one is scheduled from its completion)
    expect(getMock).toHaveBeenCalledTimes(1); // initial load
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it("does not poll while the tab is hidden, then catches up when it becomes visible", async () => {
    render(<NotificationCountProvider>child</NotificationCountProvider>);
    expect(getMock).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(getMock).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it("backs off after failures (15s -> 30s -> 60s), warns once per outage, and resumes 15s after recovering", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getMock.mockRejectedValue(new Error("Failed to fetch"));
    render(<NotificationCountProvider>child</NotificationCountProvider>);
    await act(async () => {});
    expect(getMock).toHaveBeenCalledTimes(1); // initial poll fails

    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(getMock).toHaveBeenCalledTimes(1); // no retry yet: backed off to 30s
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(getMock).toHaveBeenCalledTimes(2); // 30s after the first failure

    await act(async () => { vi.advanceTimersByTime(59_000); });
    expect(getMock).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(getMock).toHaveBeenCalledTimes(3); // 60s after the second failure

    // One warning for the whole outage, not one per attempt.
    expect(warn).toHaveBeenCalledTimes(1);

    // Recovery: next attempt succeeds, then polling returns to every 15s.
    getMock.mockResolvedValue({ unreadCount: 1 });
    await act(async () => { vi.advanceTimersByTime(120_000); });
    const afterRecovery = getMock.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(getMock.mock.calls.length).toBe(afterRecovery + 1);
    warn.mockRestore();
  });

  it("never waits longer than 5 minutes between retries", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    getMock.mockRejectedValue(new Error("Failed to fetch"));
    render(<NotificationCountProvider>child</NotificationCountProvider>);
    await act(async () => {});
    // Drive many failures, then check the gap is capped at 5 minutes.
    for (let i = 0; i < 12; i++) { await act(async () => { vi.advanceTimersByTime(300_000); }); }
    const before = getMock.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(300_000); });
    expect(getMock.mock.calls.length).toBe(before + 1);
  });
});
