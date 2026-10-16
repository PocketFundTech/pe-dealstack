import { Router, Request, Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';

const router = Router();

// PostgREST puts `.in()` values in the request URL, so an org with a few
// hundred deals overflows the URL length limit and Supabase answers
// "Bad Request". Query in chunks and concatenate.
const IN_CHUNK_SIZE = 100;

async function selectInChunks<T>(
  ids: string[],
  run: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ data: T[]; error: unknown }> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) chunks.push(ids.slice(i, i + IN_CHUNK_SIZE));
  const results = await Promise.all(chunks.map((c) => run(c)));
  const failed = results.find((r) => r.error);
  if (failed) return { data: [], error: failed.error };
  return { data: results.flatMap((r) => r.data ?? []), error: null };
}

// ─── GET /api/data-rooms/summary ──────────────────────────────────────
//
// One-request replacement for the Data Room index page's per-room fan-out
// (previously 3 requests × N rooms: /deals/:id/folders, /deals/:id/doc-
// requests, /deals/:id/shares — see apps/web-next/.../data-room/use-room-
// stats.ts). Returns the same per-room shape (RoomStats: folders with
// fileCount, requests, shares) keyed by dealId, computed from 5 org-scoped
// queries instead of up to 3N deal-scoped ones.
//
// The frontend hook still calls the three per-deal endpoints as a fallback
// if this one errors, and still caches per-deal — this endpoint is a
// faster first paint, not a new source of truth. Response shape is
// intentionally identical to what those three endpoints already returned
// per deal, so room-status.ts's roomStatus() needed no changes.
router.get('/data-rooms/summary', async (req: Request, res: Response) => {
  try {
    const orgId = getOrgId(req);

    const { data: deals, error: dealsErr } = await supabase
      .from('Deal')
      .select('id')
      .eq('organizationId', orgId)
      .is('deletedAt', null);
    if (dealsErr) throw dealsErr;

    const dealIds = (deals ?? []).map((d: { id: string }) => d.id);
    if (dealIds.length === 0) {
      return res.json({ rooms: {} });
    }

    const [foldersRes, requestsRes, sharesRes] = await Promise.all([
      selectInChunks<any>(dealIds, (c) => supabase.from('Folder').select('id, name, dealId').in('dealId', c)),
      selectInChunks<any>(dealIds, (c) =>
        supabase
          .from('DocRequest')
          .select('id, dealId, status, createdAt, expiresAt, revokedAt, completedAt')
          .in('dealId', c),
      ),
      selectInChunks<any>(dealIds, (c) =>
        supabase.from('DealShare').select('id, dealId, createdAt, expiresAt, revokedAt').in('dealId', c),
      ),
    ]);
    if (foldersRes.error) throw foldersRes.error;
    if (requestsRes.error) throw requestsRes.error;
    if (sharesRes.error) throw sharesRes.error;

    const folders = foldersRes.data ?? [];
    const requests = requestsRes.data ?? [];
    const shares = sharesRes.data ?? [];

    const folderIds = folders.map((f: { id: string }) => f.id);
    const requestIds = requests.map((r: { id: string }) => r.id);
    const shareIds = shares.map((s: { id: string }) => s.id);

    const [docCountsRes, itemsRes, viewsRes] = await Promise.all([
      folderIds.length > 0
        ? selectInChunks<any>(folderIds, (c) => supabase.from('Document').select('folderId').in('folderId', c))
        : Promise.resolve({ data: [], error: null }),
      requestIds.length > 0
        ? selectInChunks<any>(requestIds, (c) =>
            supabase.from('DocRequestItem').select('requestId, fulfilledAt').in('requestId', c),
          )
        : Promise.resolve({ data: [], error: null }),
      shareIds.length > 0
        ? selectInChunks<any>(shareIds, (c) => supabase.from('DealShareView').select('shareId').in('shareId', c))
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (docCountsRes.error) throw docCountsRes.error;
    if (itemsRes.error) throw itemsRes.error;
    if (viewsRes.error) throw viewsRes.error;

    // folderId -> document count
    const fileCountByFolder = new Map<string, number>();
    for (const doc of docCountsRes.data ?? []) {
      if (!doc.folderId) continue;
      fileCountByFolder.set(doc.folderId, (fileCountByFolder.get(doc.folderId) ?? 0) + 1);
    }

    // requestId -> { received, total }
    const itemStatsByRequest = new Map<string, { received: number; total: number }>();
    for (const item of itemsRes.data ?? []) {
      const stats = itemStatsByRequest.get(item.requestId) ?? { received: 0, total: 0 };
      stats.total += 1;
      if (item.fulfilledAt) stats.received += 1;
      itemStatsByRequest.set(item.requestId, stats);
    }

    // shareId -> view count
    const viewCountByShare = new Map<string, number>();
    for (const view of viewsRes.data ?? []) {
      viewCountByShare.set(view.shareId, (viewCountByShare.get(view.shareId) ?? 0) + 1);
    }

    // Assemble per-deal RoomStats, seeded with an empty entry for every deal
    // so a room with nothing yet still gets a (possibly empty) key rather
    // than being absent from the response.
    type RoomBucket = {
      folders: Array<{ id: string; name: string; fileCount: number }>;
      requests: Array<{ id: string; status: string; createdAt: string; expiresAt: string | null; revokedAt: string | null; completedAt: string | null; receivedCount: number; totalCount: number }>;
      shares: Array<{ id: string; createdAt: string; expiresAt: string | null; revokedAt: string | null; viewCount: number; lastViewedAt: string | null }>;
    };
    const rooms: Record<string, RoomBucket> = {};
    for (const id of dealIds) rooms[id] = { folders: [], requests: [], shares: [] };

    for (const f of folders) {
      rooms[f.dealId]?.folders.push({ id: f.id, name: f.name, fileCount: fileCountByFolder.get(f.id) ?? 0 });
    }
    for (const r of requests) {
      const stats = itemStatsByRequest.get(r.id) ?? { received: 0, total: 0 };
      rooms[r.dealId]?.requests.push({
        id: r.id,
        status: r.status,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        revokedAt: r.revokedAt,
        completedAt: r.completedAt,
        receivedCount: stats.received,
        totalCount: stats.total,
      });
    }
    for (const s of shares) {
      rooms[s.dealId]?.shares.push({
        id: s.id,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        revokedAt: s.revokedAt,
        // lastViewedAt isn't consumed by roomStatus()/room-card.tsx today
        // (only viewCount is) — omitted here to avoid a 4th query; add a
        // MAX(viewedAt) grouped query if a future caller needs it.
        viewCount: viewCountByShare.get(s.id) ?? 0,
        lastViewedAt: null,
      });
    }

    res.json({ rooms });
  } catch (error) {
    log.error('Data room summary failed', error);
    res.status(500).json({ error: 'Failed to load data room summary' });
  }
});

export default router;
