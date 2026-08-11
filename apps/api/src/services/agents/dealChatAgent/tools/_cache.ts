// ─── tiny in-memory TTL cache for dealChatAgent tools ─────────────
// Per-(dealId, userId, tool, args) cache so that re-runs of the same
// /follow-ups chat round don't hammer Gmail/Calendar twice in a row.
// Process-local Map — fine for the current single-instance API; if we
// move to multi-instance we'd swap this for Redis behind the same API.

interface CacheEntry {
  data: string;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();

export function getCached(key: string): string | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    store.delete(key);
    return null;
  }
  return hit.data;
}

export function setCached(key: string, data: string, ttlMs: number): void {
  store.set(key, { data, expiresAt: Date.now() + ttlMs });
}

/** Test-only / safety hatch. Not currently called from production paths. */
export function clearCache(): void {
  store.clear();
}
