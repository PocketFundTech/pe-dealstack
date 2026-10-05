"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, NotFoundError } from "@/lib/api";
import type { RoomFolder, RoomRequest, RoomShare, RoomStats } from "./room-status";

// Stats come from GET /data-rooms/summary — one org-scoped request that
// returns every room's { folders, requests, shares } in a single response
// (added after the page shipped with a per-room fan-out; see below). Tried
// once per page load; on success it seeds every room at once, so the
// per-room fetches below never fire. On failure (network error, or an
// older deployed API that predates this route mid-rollout) it falls back
// to the original per-room fan-out, unchanged:
//   GET /deals/:id/folders       → folders with fileCount
//   GET /deals/:id/doc-requests  → { requests }
//   GET /deals/:id/shares        → { shares }
// Per-room fetches run at most CONCURRENCY at a time, in the order given
// (callers pass the on-screen order so visible cards fill first). Results
// are cached for the browser session so returning to the page renders
// instantly, and quietly refreshed when older than FRESH_MS.

const CONCURRENCY = 4;
const FRESH_MS = 5 * 60 * 1000;

const cache = new Map<string, { at: number; stats: RoomStats }>();
// Module-scoped like `cache` — try the summary endpoint once per page load,
// not once per mount (the page can remount, e.g. on a tab switch back).
let summaryAttempted = false;

async function fetchSummary(): Promise<Map<string, RoomStats> | null> {
  try {
    const res = await api.get<{ rooms: Record<string, RoomStats> }>("/data-rooms/summary");
    const m = new Map<string, RoomStats>();
    for (const [id, stats] of Object.entries(res.rooms ?? {})) m.set(id, stats);
    return m;
  } catch (err) {
    // Any failure (network, 500, or a mid-deploy 404 against an older API
    // build) just means the per-room fan-out below carries the page — this
    // endpoint is a faster first paint, not a new source of truth.
    console.warn("[data-room] summary endpoint failed, falling back to per-room stats:", err);
    return null;
  }
}

async function orEmpty<T>(p: Promise<T>, empty: T): Promise<T> {
  try {
    return await p;
  } catch (err) {
    // A room without folders / requests / shares can 404 — that's "none".
    if (err instanceof NotFoundError) return empty;
    throw err;
  }
}

async function fetchStats(dealId: string): Promise<RoomStats> {
  const [folders, requests, shares] = await Promise.all([
    orEmpty(api.get<RoomFolder[]>(`/deals/${dealId}/folders`), [] as RoomFolder[]),
    orEmpty(api.get<{ requests: RoomRequest[] }>(`/deals/${dealId}/doc-requests`), { requests: [] }),
    orEmpty(api.get<{ shares: RoomShare[] }>(`/deals/${dealId}/shares`), { shares: [] }),
  ]);
  return {
    folders: Array.isArray(folders) ? folders : [],
    requests: requests.requests ?? [],
    shares: shares.shares ?? [],
  };
}

export function useRoomStats(orderedIds: string[]) {
  const [stats, setStats] = useState<Map<string, RoomStats>>(() => {
    const m = new Map<string, RoomStats>();
    for (const [id, v] of cache) m.set(id, v.stats);
    return m;
  });
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const queued = orderedIds.join(",");

  const run = useCallback(async (ids: string[]) => {
    if (!summaryAttempted) {
      summaryAttempted = true;
      const summary = await fetchSummary();
      if (summary) {
        const now = Date.now();
        setStats((prev) => {
          const next = new Map(prev);
          for (const [id, roomStats] of summary) {
            cache.set(id, { at: now, stats: roomStats });
            next.set(id, roomStats);
          }
          return next;
        });
      }
    }

    const todo = ids.filter((id) => {
      const hit = cache.get(id);
      return !inFlight.current.has(id) && (!hit || Date.now() - hit.at > FRESH_MS);
    });
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const id = todo[next++];
        inFlight.current.add(id);
        try {
          const s = await fetchStats(id);
          cache.set(id, { at: Date.now(), stats: s });
          setStats((prev) => new Map(prev).set(id, s));
          setFailed((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
        } catch (err) {
          console.warn(`[data-room] stats failed for ${id}:`, err);
          setFailed((prev) => new Set(prev).add(id));
        } finally {
          inFlight.current.delete(id);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    if (queued) run(queued.split(","));
  }, [queued, run]);

  const retry = useCallback((id: string) => {
    cache.delete(id);
    run([id]);
  }, [run]);

  return { stats, failed, retry };
}
