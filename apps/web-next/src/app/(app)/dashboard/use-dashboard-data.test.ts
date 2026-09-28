import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

// This suite covers the part of the hook that changed: snoozes moved from
// localStorage (triage.ts readSnoozes/writeSnoozes) to the server
// (GET/POST/DELETE /api/snoozes). Deals/tasks loading and the other
// mutations (setTaskStatus, assignOwner, addTask) are unchanged and
// untested here as they were before this change.
const getMock = vi.fn();
const postMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (...a: unknown[]) => getMock(...a), post: (...a: unknown[]) => postMock(...a), delete: (...a: unknown[]) => deleteMock(...a) },
}));
vi.mock("@/lib/appEvents", () => ({ onDealsChanged: () => () => {} }));

import { useDashboardData } from "./use-dashboard-data";

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  deleteMock.mockReset();
  postMock.mockResolvedValue({ success: true });
  deleteMock.mockResolvedValue({ success: true });
});

describe("useDashboardData — snoozes", () => {
  it("fetches /snoozes alongside deals/tasks and converts ISO strings to epoch ms", async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith("/deals")) return Promise.resolve({ deals: [] });
      if (path.startsWith("/tasks")) return Promise.resolve({ tasks: [] });
      if (path === "/snoozes") return Promise.resolve({ snoozes: { "task:t1": "2026-10-05T00:00:00.000Z" } });
      throw new Error(`unexpected: ${path}`);
    });

    const { result } = renderHook(() => useDashboardData());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snoozes).toEqual({ "task:t1": new Date("2026-10-05T00:00:00.000Z").getTime() });
  });

  it("degrades gracefully (empty snoozes, no crash) when the snoozes fetch fails", async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith("/deals")) return Promise.resolve({ deals: [] });
      if (path.startsWith("/tasks")) return Promise.resolve({ tasks: [] });
      if (path === "/snoozes") return Promise.reject(new Error("500"));
      throw new Error(`unexpected: ${path}`);
    });

    const { result } = renderHook(() => useDashboardData());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snoozes).toEqual({});
  });

  it("snooze() updates state immediately and POSTs the item key + ISO expiry", async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith("/deals")) return Promise.resolve({ deals: [] });
      if (path.startsWith("/tasks")) return Promise.resolve({ tasks: [] });
      if (path === "/snoozes") return Promise.resolve({ snoozes: {} });
      throw new Error(`unexpected: ${path}`);
    });

    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.snooze("stale:d1", 7));

    // Optimistic — reflected before the POST resolves.
    expect(result.current.snoozes["stale:d1"]).toBeGreaterThan(Date.now());

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, body] = postMock.mock.calls[0];
    expect(path).toBe("/snoozes");
    expect(body.itemKey).toBe("stale:d1");
    expect(new Date(body.until).getTime()).toBe(result.current.snoozes["stale:d1"]);
  });

  it("unsnooze() clears state immediately and DELETEs the URL-encoded item key", async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith("/deals")) return Promise.resolve({ deals: [] });
      if (path.startsWith("/tasks")) return Promise.resolve({ tasks: [] });
      if (path === "/snoozes") return Promise.resolve({ snoozes: { "unowned:d1": "2026-10-05T00:00:00.000Z" } });
      throw new Error(`unexpected: ${path}`);
    });

    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.snoozes["unowned:d1"]).toBeDefined());

    act(() => result.current.unsnooze("unowned:d1"));

    expect(result.current.snoozes["unowned:d1"]).toBeUndefined();
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("/snoozes/unowned%3Ad1"));
  });

  it("snooze()/unsnooze() don't throw when the API call fails (fire-and-forget)", async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith("/deals")) return Promise.resolve({ deals: [] });
      if (path.startsWith("/tasks")) return Promise.resolve({ tasks: [] });
      if (path === "/snoozes") return Promise.resolve({ snoozes: {} });
      throw new Error(`unexpected: ${path}`);
    });
    postMock.mockRejectedValue(new Error("network down"));
    deleteMock.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(() => act(() => result.current.snooze("stale:d1", 1))).not.toThrow();
    expect(() => act(() => result.current.unsnooze("stale:d1"))).not.toThrow();
    // State still updates optimistically even though the persist call is failing.
    await waitFor(() => expect(postMock).toHaveBeenCalled());
  });
});
