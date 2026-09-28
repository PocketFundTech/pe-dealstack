import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { invalidateApiCache } from "@/lib/useApiQuery";

// Mock the api layer so we can assert on request counts and control
// resolve/reject timing for optimistic-mutation rollback tests.
const getMock = vi.fn();
const patchMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    get: (path: string) => getMock(path),
    patch: (path: string, body: unknown) => patchMock(path, body),
    post: (path: string, body: unknown) => postMock(path, body),
  },
}));

import { useDashboardData } from "./use-dashboard-data";

const DEALS_KEY = "/deals?limit=200&sortBy=updatedAt&sortOrder=desc";
const TASKS_KEY = "/tasks?limit=100";

beforeEach(() => {
  getMock.mockReset();
  patchMock.mockReset();
  postMock.mockReset();
  invalidateApiCache(); // clear the module-level useApiQuery cache between tests
  getMock.mockImplementation((path: string) => {
    if (path === DEALS_KEY) return Promise.resolve([{ id: "d1", name: "Apex", stage: "SCREENING" }]);
    if (path === TASKS_KEY) return Promise.resolve({ tasks: [{ id: "t1", title: "Call", status: "PENDING" }] });
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
});

describe("useDashboardData", () => {
  it("loads deals and tasks once, then renders a second mount instantly from cache and revalidates in the background", async () => {
    const first = renderHook(() => useDashboardData());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.deals).toEqual([{ id: "d1", name: "Apex", stage: "SCREENING" }]);
    expect(first.result.current.tasks).toEqual([{ id: "t1", title: "Call", status: "PENDING" }]);
    expect(getMock).toHaveBeenCalledTimes(2); // one /deals + one /tasks

    // Simulate navigating away and back: a fresh mount for the same keys
    // reads the cache instantly (no loading flash), then revalidates once
    // per key in the background so edits made elsewhere show up.
    const second = renderHook(() => useDashboardData());
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.deals).toEqual([{ id: "d1", name: "Apex", stage: "SCREENING" }]);
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(4));
  });

  it("keeps showing cached data (no error state) when a background revalidation fails", async () => {
    const first = renderHook(() => useDashboardData());
    await waitFor(() => expect(first.result.current.loading).toBe(false));

    // Every later request fails (e.g. the transient ERR_TIMED_OUT seen in prod).
    getMock.mockImplementation(() => Promise.reject(new Error("net::ERR_TIMED_OUT")));
    const second = renderHook(() => useDashboardData());
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(second.result.current.refreshing).toBe(false));

    expect(second.result.current.deals).toEqual([{ id: "d1", name: "Apex", stage: "SCREENING" }]);
    expect(second.result.current.dealsError).toBe(false);
    expect(second.result.current.tasksError).toBe(false);
  });

  it("setTaskStatus updates the cache optimistically and rolls back on failure", async () => {
    patchMock.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(async () => {
        await expect(result.current.setTaskStatus("t1", "COMPLETED")).rejects.toThrow("network down");
      }),
    ).resolves.toBeUndefined();

    // Rolled back to the original status after the API call failed.
    expect(result.current.tasks.find((t) => t.id === "t1")?.status).toBe("PENDING");
  });

  it("setTaskStatus commits the optimistic update when the API call succeeds, and a second mount sees it", async () => {
    patchMock.mockResolvedValue({});
    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setTaskStatus("t1", "COMPLETED");
    });

    expect(result.current.tasks.find((t) => t.id === "t1")?.status).toBe("COMPLETED");
    expect(patchMock).toHaveBeenCalledWith("/tasks/t1", { status: "COMPLETED" });

    // The mutation went through the shared useApiQuery cache, so a second
    // consumer (e.g. remounting the Dashboard page) sees the update without
    // any further fetch.
    // The mutation itself triggers no fetch.
    expect(getMock).toHaveBeenCalledTimes(2);
    const second = renderHook(() => useDashboardData());
    expect(second.result.current.tasks.find((t) => t.id === "t1")?.status).toBe("COMPLETED");
  });

  it("assignOwner rolls back the deal's assignedUser on failure", async () => {
    patchMock.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(
        result.current.assignOwner("d1", { id: "u2", name: "Ritish" }),
      ).rejects.toThrow("boom");
    });

    expect(result.current.deals.find((d) => d.id === "d1")?.assignedUser).toBeUndefined();
  });
});
