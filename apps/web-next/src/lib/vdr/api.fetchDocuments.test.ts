/**
 * fetchDocuments used to swallow errors and return []. Its callers (the 5s
 * processing poll and the refresh on tab focus) then replaced the visible
 * file list with that empty array, so one failed request made every file
 * in the data room disappear until a full reload. It must surface the
 * failure so callers keep what's on screen.
 */
import { describe, it, expect, vi } from "vitest";

const get = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (path: string) => get(path) } }));

import { fetchDocuments } from "./api";

describe("fetchDocuments", () => {
  it("rejects when the request fails instead of reporting an empty folder", async () => {
    get.mockRejectedValueOnce(new Error("503"));
    await expect(fetchDocuments("deal-1", "folder-1")).rejects.toThrow("503");
  });

  it("returns the documents on success", async () => {
    get.mockResolvedValueOnce({ documents: [{ id: "doc-1" }] });
    await expect(fetchDocuments("deal-1")).resolves.toEqual([{ id: "doc-1" }]);
  });
});
