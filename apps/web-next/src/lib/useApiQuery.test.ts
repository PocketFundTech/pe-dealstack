import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

// Mock the api layer the hook fetches through.
const getMock = vi.fn();
vi.mock("./api", () => ({
  api: { get: (path: string) => getMock(path) },
}));

import { useApiQuery, invalidateApiCache, mutateApiCache } from "./useApiQuery";

beforeEach(() => {
  getMock.mockReset();
  invalidateApiCache(); // clear the module-level cache between tests
});

describe("useApiQuery", () => {
  it("loads then returns data; isLoading is true only while uncached", async () => {
    getMock.mockResolvedValue([{ id: "d1" }]);

    const { result } = renderHook(() => useApiQuery<{ id: string }[]>("/deals"));

    // No cached data yet → loading.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();

    await waitFor(() => expect(result.current.data).toEqual([{ id: "d1" }]));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it("serves cached data INSTANTLY on a second mount (no loading flash)", async () => {
    getMock.mockResolvedValue([{ id: "d1" }]);

    const first = renderHook(() => useApiQuery("/deals"));
    await waitFor(() => expect(first.result.current.data).toBeDefined());

    // Second mount for the same key reads the cache synchronously.
    const second = renderHook(() => useApiQuery("/deals"));
    expect(second.result.current.data).toEqual([{ id: "d1" }]);
    expect(second.result.current.isLoading).toBe(false);
  });

  it("dedupes concurrent requests for the same key", async () => {
    let resolve!: (v: unknown) => void;
    getMock.mockReturnValue(new Promise((r) => (resolve = r)));

    const a = renderHook(() => useApiQuery("/deals"));
    const b = renderHook(() => useApiQuery("/deals"));

    expect(getMock).toHaveBeenCalledTimes(1); // shared in-flight request

    await act(async () => {
      resolve([{ id: "d1" }]);
    });

    await waitFor(() => {
      expect(a.result.current.data).toEqual([{ id: "d1" }]);
      expect(b.result.current.data).toEqual([{ id: "d1" }]);
    });
  });

  it("refetch() pulls fresh data and updates the cache", async () => {
    getMock.mockResolvedValueOnce([{ id: "v1" }]).mockResolvedValueOnce([{ id: "v2" }]);

    const { result } = renderHook(() => useApiQuery("/deals"));
    await waitFor(() => expect(result.current.data).toEqual([{ id: "v1" }]));

    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data).toEqual([{ id: "v2" }]);
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it("mutate() updates cached data and notifies subscribers without a fetch", async () => {
    getMock.mockResolvedValue([{ id: "v1" }]);

    const { result } = renderHook(() => useApiQuery<{ id: string }[]>("/deals"));
    await waitFor(() => expect(result.current.data).toEqual([{ id: "v1" }]));

    act(() => {
      result.current.mutate([{ id: "optimistic" }]);
    });
    expect(result.current.data).toEqual([{ id: "optimistic" }]);
    expect(getMock).toHaveBeenCalledTimes(1); // no extra fetch
  });

  it("surfaces fetch errors", async () => {
    getMock.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useApiQuery("/deals"));

    await waitFor(() => expect(result.current.error?.message).toBe("boom"));
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it("is inert when key is null or disabled", async () => {
    const { result } = renderHook(() => useApiQuery(null));
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);

    const disabled = renderHook(() => useApiQuery("/deals", { enabled: false }));
    expect(disabled.result.current.data).toBeUndefined();

    // Neither should have fetched.
    expect(getMock).not.toHaveBeenCalled();
  });

  it("skips revalidation while a cached entry is within staleTime", async () => {
    mutateApiCache("/deals", [{ id: "cached" }]);
    getMock.mockResolvedValue([{ id: "fresh" }]);

    const { result } = renderHook(() =>
      useApiQuery("/deals", { staleTime: 60_000 }),
    );

    // Cached data shown immediately; no network call because it's fresh.
    expect(result.current.data).toEqual([{ id: "cached" }]);
    await waitFor(() => expect(result.current.isValidating).toBe(false));
    expect(getMock).not.toHaveBeenCalled();
  });
});
