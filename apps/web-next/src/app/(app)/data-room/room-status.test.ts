import { describe, it, expect } from "vitest";
import { duplicateNames, inTab, matchesSearch, roomStatus, sortRooms, type RoomDeal, type RoomStats } from "./room-status";
import { DAY_MS } from "../dashboard/triage";

const NOW = new Date(2026, 8, 28, 10).getTime();
const at = (d: number) => new Date(NOW + d * DAY_MS).toISOString();
const deal = (over: Partial<RoomDeal>): RoomDeal => ({ id: "d", name: "Room", stage: "INITIAL_REVIEW", createdAt: at(-30), ...over });
const stats = (over: Partial<RoomStats> = {}): RoomStats => ({ folders: [], requests: [], shares: [], ...over });
const folders = (counts: number[]) => counts.map((n, i) => ({ id: `f${i}`, name: `F${i}`, fileCount: n }));

describe("roomStatus", () => {
  it("computes coverage and document totals from folder file counts", () => {
    const s = roomStatus(deal({}), stats({ folders: folders([3, 0, 5, 0]) }), NOW);
    expect(s).toMatchObject({ documents: 8, foldersTotal: 4, foldersFilled: 2, coverage: 0.5 });
  });

  it("flags thin rooms only at diligence or later", () => {
    const thin = stats({ folders: folders([1, 0, 0, 0]) });
    expect(roomStatus(deal({ stage: "INITIAL_REVIEW" }), thin, NOW).attention).toEqual([]);
    expect(roomStatus(deal({ stage: "DUE_DILIGENCE" }), thin, NOW).attention).toEqual(["Only 1 of 4 folders have files"]);
    expect(roomStatus(deal({ stage: "DUE_DILIGENCE", status: "PASSED" }), thin, NOW).attention).toEqual([]);
  });

  it("flags expiring and unanswered requests, ignoring closed ones", () => {
    const s = roomStatus(deal({}), stats({
      requests: [
        { id: "r1", status: "OPEN", createdAt: at(-2), expiresAt: at(2), receivedCount: 1, totalCount: 5 },
        { id: "r2", status: "OPEN", createdAt: at(-10), expiresAt: at(20), receivedCount: 0, totalCount: 3 },
        { id: "r3", status: "OPEN", createdAt: at(-10), completedAt: at(-1), receivedCount: 3, totalCount: 3 },
        { id: "r4", status: "OPEN", createdAt: at(-10), revokedAt: at(-1), receivedCount: 0, totalCount: 3 },
      ],
    }), NOW);
    expect(s.openRequests.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(s.attention).toEqual(["Request expires in 2d", "Request unanswered for 7+ days"]);
  });

  it("counts live shares and their views, flags expiring links", () => {
    const s = roomStatus(deal({}), stats({
      shares: [
        { id: "s1", createdAt: at(-5), expiresAt: at(1), viewCount: 4 },
        { id: "s2", createdAt: at(-5), revokedAt: at(-1), viewCount: 9 },
        { id: "s3", createdAt: at(-5), expiresAt: at(-1), viewCount: 2 },
      ],
    }), NOW);
    expect(s.liveShares.map((x) => x.id)).toEqual(["s1"]);
    expect(s.shareViews).toBe(4);
    expect(s.attention).toEqual(["Share link expires in 1d"]);
  });
});

describe("tabs, search, sort", () => {
  const a = deal({ id: "a", name: "Apex", industry: "Aerospace", lastDocumentUpdated: at(-1) });
  const b = deal({ id: "b", name: "Nino Burgers", industry: "Food", updatedAt: at(-5) });
  const p = deal({ id: "p", name: "DMpro", status: "PASSED", updatedAt: at(0) });

  it("splits passed rooms out of Active", () => {
    expect([a, b, p].filter((d) => inTab(d, "ACTIVE", undefined)).map((d) => d.id)).toEqual(["a", "b"]);
    expect([a, b, p].filter((d) => inTab(d, "PASSED", undefined)).map((d) => d.id)).toEqual(["p"]);
  });

  it("searches name and industry", () => {
    expect(matchesSearch(a, "aero")).toBe(true);
    expect(matchesSearch(b, "apex")).toBe(false);
  });

  it("sorts by latest upload, and by coverage with unknowns last", () => {
    expect(sortRooms([b, a], "UPLOAD", new Map()).map((d) => d.id)).toEqual(["a", "b"]);
    const statuses = new Map([["b", { coverage: 0.8 } as never]]);
    expect(sortRooms([a, b], "COVERAGE", statuses).map((d) => d.id)).toEqual(["b", "a"]);
  });

  it("finds duplicate room names", () => {
    expect([...duplicateNames([b, b, a])]).toEqual(["Nino Burgers"]);
  });
});
