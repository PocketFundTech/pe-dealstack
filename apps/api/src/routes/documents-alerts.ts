import { Router } from 'express';
import { supabase } from '../supabase.js';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';

const router = Router();

/**
 * GET /api/documents/alerts
 *
 * Returns documents across the org that need attention:
 *   - extractedText IS NULL  → "Pending Analysis"
 *   - aiAnalyzedAt IS NULL   → "Ready for AI" (extracted but not analyzed)
 *
 * Joins through Deal to filter by organizationId. Returns at most 20 items
 * with the deal name + a 'state' tag the frontend uses for badge color.
 */
router.get('/alerts', async (req: any, res) => {
  try {
    const orgId = getOrgId(req);

    // Pre-fetch deal IDs for this org, then filter Document at the DB layer.
    // The previous implementation fetched the 50 most-recent rows globally
    // and filtered in JS by deal.organizationId — small orgs could see zero
    // alerts when 50 newer rows from other tenants crowded theirs out.
    // Mirrors the pattern used by /api/activities/recent (F-2 fix).
    const { data: deals, error: dealsErr } = await supabase
      .from('Deal')
      .select('id')
      .eq('organizationId', orgId);

    if (dealsErr) throw dealsErr;

    const dealIds = (deals || []).map((d: { id: string }) => d.id);
    if (dealIds.length === 0) {
      return res.json({ items: [] });
    }

    const { data, error } = await supabase
      .from('Document')
      .select(`
        id,
        name,
        type,
        createdAt,
        extractedText,
        aiAnalyzedAt,
        deal:Deal!dealId(id, name)
      `)
      .in('dealId', dealIds)
      .order('createdAt', { ascending: false })
      .limit(50);

    if (error) throw error;

    const items = (data || [])
      .filter((d: any) => !d.extractedText || !d.aiAnalyzedAt)
      .slice(0, 20)
      .map((d: any) => ({
        id: d.id,
        name: d.name,
        type: d.type,
        createdAt: d.createdAt,
        dealId: d.deal?.id,
        dealName: d.deal?.name,
        state: !d.extractedText ? 'pending' : 'ready_for_ai',
      }));

    res.json({ items });
  } catch (err) {
    log.error('Document alerts error', err);
    res.status(500).json({ error: 'Failed to load document alerts' });
  }
});

export default router;
