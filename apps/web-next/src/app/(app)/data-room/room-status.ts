// Pure Data Room index logic: coverage, attention rules, tabs and sorting.
// Unit-tested in room-status.test.ts. Stats come from three light per-deal
// endpoints (folders with fileCount, doc-requests, shares) — see
// use-room-stats.ts.

import { DAY_MS, dayOffset, isLiveDeal } from "../dashboard/triage";
import type { Deal as DashDeal } from "../dashboard/components";

export interface RoomDeal {
  id: string;
  name?: string;
  companyName?: string;
  industry?: string;
  stage?: string;
  status?: string;
  createdAt: string;
  updatedAt?: string;
  lastDocument?: string | null;
  lastDocumentUpdated?: string | null;
  Company?: { industry?: string };
}

export interface RoomFolder { id: string; name: string; fileCount?: number }
export interface RoomRequest {
  id: string;
  status: string;
  createdAt: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
  completedAt?: string | null;
  receivedCount: number;
  totalCount: number;
}
export interface RoomShare { id: string; createdAt: string; expiresAt?: string | null; revokedAt?: string | null; viewCount: number; lastViewedAt?: string | null }

export interface RoomStats {
  folders: RoomFolder[];
  requests: RoomRequest[];
  shares: RoomShare[];
}

export const roomName = (d: RoomDeal) => d.name || d.companyName || "Untitled room";
export const roomIndustry = (d: RoomDeal) => d.Company?.industry || d.industry || "";

export function isPassed(d: RoomDeal): boolean {
  return d.status === "PASSED" || d.status === "ARCHIVED" || d.stage === "PASSED" || d.stage === "CLOSED_LOST";
}

// ---------------------------------------------------------------------------
// Derived per-room status
// ---------------------------------------------------------------------------

export interface RoomStatus {
  documents: number;
  foldersTotal: number;
  foldersFilled: number;
  coverage: number; // 0–1
  openRequests: RoomRequest[];
  liveShares: RoomShare[];
  shareViews: number;
  attention: string[]; // human-readable reasons, empty when fine
}

const isOpenRequest = (r: RoomRequest, now: number) =>
  !r.revokedAt && !r.completedAt && r.status !== "CANCELLED" && r.status !== "COMPLETED" && !(r.expiresAt && new Date(r.expiresAt).getTime() < now);
const isLiveShare = (s: RoomShare, now: number) => !s.revokedAt && !(s.expiresAt && new Date(s.expiresAt).getTime() < now);

// Stages at which a thin data room is a problem.
const DILIGENCE_OR_LATER = new Set(["DUE_DILIGENCE", "IOI_SUBMITTED", "LOI_SUBMITTED", "LOI_OFFER", "NEGOTIATION", "CLOSING"]);

export function roomStatus(deal: RoomDeal, stats: RoomStats, now: number): RoomStatus {
  const foldersTotal = stats.folders.length;
  const foldersFilled = stats.folders.filter((f) => (f.fileCount ?? 0) > 0).length;
  const documents = stats.folders.reduce((s, f) => s + (f.fileCount ?? 0), 0);
  const coverage = foldersTotal ? foldersFilled / foldersTotal : 0;
  const openRequests = stats.requests.filter((r) => isOpenRequest(r, now));
  const liveShares = stats.shares.filter((s) => isLiveShare(s, now));

  const attention: string[] = [];
  if (!isPassed(deal) && DILIGENCE_OR_LATER.has(deal.stage || "") && foldersTotal > 0 && coverage < 0.5) {
    attention.push(`Only ${foldersFilled} of ${foldersTotal} folders have files`);
  }
  for (const r of openRequests) {
    if (r.expiresAt && dayOffset(r.expiresAt, now) <= 3) {
      attention.push(`Request expires ${dayOffset(r.expiresAt, now) <= 0 ? "today" : `in ${dayOffset(r.expiresAt, now)}d`}`);
    } else if (r.receivedCount === 0 && now - new Date(r.createdAt).getTime() >= 7 * DAY_MS) {
      attention.push("Request unanswered for 7+ days");
    }
  }
  for (const s of liveShares) {
    if (s.expiresAt && dayOffset(s.expiresAt, now) <= 3) {
      attention.push(`Share link expires ${dayOffset(s.expiresAt, now) <= 0 ? "today" : `in ${dayOffset(s.expiresAt, now)}d`}`);
    }
  }

  return {
    documents, foldersTotal, foldersFilled, coverage, openRequests, liveShares,
    shareViews: liveShares.reduce((s, x) => s + x.viewCount, 0),
    attention: [...new Set(attention)],
  };
}

// ---------------------------------------------------------------------------
// Tabs, search, sort
// ---------------------------------------------------------------------------

export type RoomTab = "ACTIVE" | "ATTENTION" | "PASSED" | "ALL";
export type RoomSort = "UPLOAD" | "COVERAGE" | "NAME";

export function matchesSearch(d: RoomDeal, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return roomName(d).toLowerCase().includes(s) || roomIndustry(d).toLowerCase().includes(s);
}

export function inTab(d: RoomDeal, tab: RoomTab, status: RoomStatus | undefined): boolean {
  if (tab === "ALL") return true;
  if (tab === "PASSED") return isPassed(d);
  if (tab === "ATTENTION") return !isPassed(d) && !!status && status.attention.length > 0;
  return !isPassed(d);
}

const lastActivity = (d: RoomDeal) => new Date(d.lastDocumentUpdated || d.updatedAt || d.createdAt).getTime();

export function sortRooms(rooms: RoomDeal[], sort: RoomSort, statuses: Map<string, RoomStatus>): RoomDeal[] {
  const list = [...rooms];
  if (sort === "NAME") return list.sort((a, b) => roomName(a).localeCompare(roomName(b)));
  if (sort === "COVERAGE") {
    // Unknown (still loading) coverage sorts last.
    const cov = (d: RoomDeal) => statuses.get(d.id)?.coverage ?? -1;
    return list.sort((a, b) => cov(b) - cov(a) || lastActivity(b) - lastActivity(a));
  }
  return list.sort((a, b) => lastActivity(b) - lastActivity(a));
}

/** "Nino Burgers" appears 4×: which names need a disambiguating line? */
export function duplicateNames(rooms: RoomDeal[]): Set<string> {
  const seen = new Map<string, number>();
  for (const r of rooms) seen.set(roomName(r), (seen.get(roomName(r)) ?? 0) + 1);
  return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name));
}

export const isLiveRoom = (d: RoomDeal) => isLiveDeal(d as unknown as DashDeal);
