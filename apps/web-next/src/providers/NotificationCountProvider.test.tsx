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
    getMock.mockClear();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls every 15s while the tab is visible", async () => {
    render(<NotificationCountProvider>child</NotificationCountProvider>);
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
});
