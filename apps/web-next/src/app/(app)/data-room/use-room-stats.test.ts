import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// The hook keeps a module-level cache + a "tried the summary endpoint
// already" flag, both intentionally not reset by any production code path
// (it's a session-lived cache, same pattern as useApiQuery's, just without
// a public invalidate — nothing else needs to reset it). Reset the module
// itself between tests instead of adding a test-only export.
const getMock = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (path: string) => getMock(path) },
  NotFoundError: class NotFoundError extends Error {},
}));

async function freshHook() {
  vi.resetModules();
  return (await import("./use-room-stats")).useRoomStats;
}

beforeEach(() => {
  getMock.mockReset();
});

describe("useRoomStats", () => {
  it("seeds every room from the summary endpoint in one call, skipping per-room fetches", async () => {
    getMock.mockImplementation((path: string) => {
      if (path === "/data-rooms/summary") {
        return Promise.resolve({
          rooms: {
            d1: { folders: [{ id: "f1", name: "Financials", fileCount: 3 }], requests: [], shares: [] },
            d2: { folders: [], requests: [], shares: [] },
          },
        });
      }
      throw new Error(`unexpected per-room call: ${path}`);
    });

    const useRoomStats = await freshHook();
    const { result } = renderHook(() => useRoomStats(["d1", "d2"]));

    await waitFor(() => expect(result.current.stats.size).toBe(2));
    expect(result.current.stats.get("d1")?.folders).toEqual([{ id: "f1", name: "Financials", fileCount: 3 }]);
    expect(result.current.stats.get("d2")).toEqual({ folders: [], requests: [], shares: [] });
    // Exactly one call total — the summary endpoint, no per-room fan-out.
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith("/data-rooms/summary");
  });

  it("falls back to the per-room endpoints when the summary call fails", async () => {
    getMock.mockImplementation((path: string) => {
      if (path === "/data-rooms/summary") return Promise.reject(new Error("500"));
      if (path === "/deals/d1/folders") return Promise.resolve([{ id: "f1", name: "Financials", fileCount: 1 }]);
      if (path === "/deals/d1/doc-requests") return Promise.resolve({ requests: [] });
      if (path === "/deals/d1/shares") return Promise.resolve({ shares: [] });
      throw new Error(`unexpected call: ${path}`);
    });

    const useRoomStats = await freshHook();
    const { result } = renderHook(() => useRoomStats(["d1"]));

    await waitFor(() => expect(result.current.stats.get("d1")).toBeDefined());
    expect(result.current.stats.get("d1")?.folders).toEqual([{ id: "f1", name: "Financials", fileCount: 1 }]);
    // Summary attempted once, then the full per-room fan-out for d1.
    expect(getMock).toHaveBeenCalledWith("/data-rooms/summary");
    expect(getMock).toHaveBeenCalledWith("/deals/d1/folders");
    expect(getMock).toHaveBeenCalledWith("/deals/d1/doc-requests");
    expect(getMock).toHaveBeenCalledWith("/deals/d1/shares");
  });

  it("still fetches per-room for an id the summary response omitted", async () => {
    getMock.mockImplementation((path: string) => {
      if (path === "/data-rooms/summary") {
        return Promise.resolve({ rooms: { d1: { folders: [], requests: [], shares: [] } } });
      }
      if (path === "/deals/d2/folders") return Promise.resolve([]);
      if (path === "/deals/d2/doc-requests") return Promise.resolve({ requests: [] });
      if (path === "/deals/d2/shares") return Promise.resolve({ shares: [] });
      throw new Error(`unexpected call: ${path}`);
    });

    const useRoomStats = await freshHook();
    // d2 is a brand-new deal the org-scoped summary snapshot doesn't know about yet.
    const { result } = renderHook(() => useRoomStats(["d1", "d2"]));

    await waitFor(() => expect(result.current.stats.size).toBe(2));
    expect(getMock).toHaveBeenCalledWith("/deals/d2/folders");
  });
});
