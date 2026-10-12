import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';

const router = Router();

/** Stay well inside the 300s function limit; the client calls again for the rest. */
const INDEX_BUDGET_MS = 45_000;
const BATCH = 25;

/** Documents with extracted text that have never been indexed for chat (e.g. HubSpot imports). */
async function countPending(dealId: string): Promise<number> {
  const { count, error } = await supabase
    .from('Document').select('id', { count: 'exact', head: true })
    .eq('dealId', dealId).not('extractedText', 'is', null).or('embeddingStatus.is.null,embeddingStatus.eq.pending');
  if (error) throw error;
  return count ?? 0;
}

router.get('/:dealId/documents/index-pending', async (req: Request, res: Response) => {
  try {
    const { dealId } = req.params;
    if (!(await verifyDealAccess(dealId, getOrgId(req)))) return res.status(404).json({ error: 'Deal not found' });
    res.json({ pending: await countPending(dealId) });
  } catch (err) {
    log.error('GET index-pending failed', err);
    res.status(500).json({ error: 'Could not count documents waiting to be indexed' });
  }
});

/**
 * POST — index (embed) pending documents for Deal Chat. User-clicked AI, so it
 * runs regardless of AI_BACKGROUND_JOBS. Returns what's left; the client
 * repeats until `remaining` is 0.
 */
router.post('/:dealId/documents/index-pending', async (req: Request, res: Response) => {
  try {
    const { dealId } = req.params;
    if (!(await verifyDealAccess(dealId, getOrgId(req)))) return res.status(404).json({ error: 'Deal not found' });
    const { embedDocument } = await import('../rag.js');
    const { data, error } = await supabase
      .from('Document').select('id, extractedText')
      .eq('dealId', dealId).not('extractedText', 'is', null).or('embeddingStatus.is.null,embeddingStatus.eq.pending')
      .order('createdAt', { ascending: true }).limit(BATCH);
    if (error) throw error;

    const started = Date.now();
    let indexed = 0;
    let failed = 0;
    let firstError: string | null = null;
    for (const doc of (data ?? []) as Array<{ id: string; extractedText: string }>) {
      if (Date.now() - started > INDEX_BUDGET_MS) break;
      const r = await embedDocument(doc.id, dealId, doc.extractedText);
      if (r.success) indexed += 1;
      else { failed += 1; firstError ??= r.error ?? 'Indexing failed'; }
    }
    res.json({ indexed, failed, remaining: await countPending(dealId), error: firstError });
  } catch (err) {
    log.error('POST index-pending failed', err);
    res.status(500).json({ error: 'Could not index documents' });
  }
});

export default router;
