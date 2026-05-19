import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';

const router = Router();

// ─── 6a: GET /api/deals/:dealId/financials/conflicts ─────────
// Returns all periods with overlapping extractions from different documents

router.get('/deals/:dealId/financials/conflicts', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    const { data: rows, error } = await supabase
      .from('FinancialStatement')
      .select('*, Document(id, name)')
      .eq('dealId', dealId)
      .eq('mergeStatus', 'needs_review')
      .order('statementType', { ascending: true })
      .order('period', { ascending: true });

    if (error) throw error;

    // Group by (statementType, period)
    const conflicts = new Map<string, any[]>();
    for (const row of rows ?? []) {
      const key = `${row.statementType}|${row.period}`;
      if (!conflicts.has(key)) conflicts.set(key, []);
      conflicts.get(key)!.push(row);
    }

    const result = Array.from(conflicts.entries()).map(([key, versions]) => {
      const [statementType, period] = key.split('|');
      return {
        statementType,
        period,
        versions: versions.map(v => ({
          id: v.id,
          documentId: v.documentId,
          documentName: (v as any).Document?.name ?? 'Unknown',
          isActive: v.isActive,
          lineItems: v.lineItems,
          extractionConfidence: v.extractionConfidence,
          extractionSource: v.extractionSource,
          extractedAt: v.extractedAt,
          reviewedAt: v.reviewedAt,
        })),
      };
    });

    res.json({ conflicts: result, count: result.length });
  } catch (err) {
    log.error('GET financials conflicts error', err);
    res.status(500).json({ error: 'Failed to fetch conflicts' });
  }
});

// ─── 6b: POST /api/deals/:dealId/financials/resolve ──────────
// User picks a version for an overlapping period

const resolveSchema = z.object({
  statementType: z.string(),
  period: z.string(),
  chosenVersionId: z.string().uuid().optional(),
  customLineItems: z.record(z.number().nullable()).optional(),
});

router.post('/deals/:dealId/financials/resolve', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    const user = req.user;
    const { statementType, period, chosenVersionId, customLineItems } = resolveSchema.parse(req.body);

    // Get all versions for this conflict
    const { data: versions, error } = await supabase
      .from('FinancialStatement')
      .select('id, isActive')
      .eq('dealId', dealId)
      .eq('statementType', statementType)
      .eq('period', period);

    if (error || !versions?.length) {
      return res.status(404).json({ error: 'No versions found for this period' });
    }

    // F-24: verify the supplied chosenVersionId belongs to the versions
    // pre-fetched for THIS (dealId, statementType, period). Without this
    // gate the later activation update fires `.eq('id', chosenVersionId)`
    // alone — letting a caller flip `isActive=true` on any other org's
    // FinancialStatement row. The versions array is already org-scoped
    // (it was filtered by dealId which passed verifyDealAccess), so a
    // membership check is sufficient.
    if (chosenVersionId && !versions.some((v: any) => v.id === chosenVersionId)) {
      return res.status(400).json({ error: 'chosenVersionId does not belong to this conflict' });
    }

    // Deactivate all versions
    const allIds = versions.map((v: any) => v.id);
    await supabase
      .from('FinancialStatement')
      .update({ isActive: false, mergeStatus: 'user_resolved' })
      .in('id', allIds);

    if (customLineItems) {
      // User provided custom values
      const targetId = chosenVersionId ?? versions[0].id;
      await supabase
        .from('FinancialStatement')
        .update({
          isActive: true,
          mergeStatus: 'user_resolved',
          lineItems: customLineItems,
          extractionSource: 'manual',
          reviewedAt: new Date().toISOString(),
          reviewedBy: user?.id ?? null,
        })
        .eq('id', targetId);
    } else if (chosenVersionId) {
      // User picked an existing version
      await supabase
        .from('FinancialStatement')
        .update({
          isActive: true,
          mergeStatus: 'user_resolved',
          reviewedAt: new Date().toISOString(),
          reviewedBy: user?.id ?? null,
        })
        .eq('id', chosenVersionId);
    }

    res.json({ success: true });
  } catch (err) {
    log.error('POST financials resolve error', err);
    res.status(500).json({ error: 'Failed to resolve conflict' });
  }
});

// ─── 6c: POST /api/deals/:dealId/financials/resolve-all ──────
// Bulk resolve: auto-pick by strategy (highest_confidence or latest_document)

router.post('/deals/:dealId/financials/resolve-all', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    const user = req.user;
    const strategy = req.body.strategy ?? 'highest_confidence';

    const { data: rows, error } = await supabase
      .from('FinancialStatement')
      .select('*')
      .eq('dealId', dealId)
      .eq('mergeStatus', 'needs_review');

    if (error) throw error;
    if (!rows?.length) return res.json({ resolved: 0 });

    // Group by (statementType, period)
    const groups = new Map<string, any[]>();
    for (const row of rows) {
      const key = `${row.statementType}|${row.period}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    let resolved = 0;
    for (const [, versions] of groups) {
      // Sort by strategy — winner is first
      const sorted = [...versions].sort((a: any, b: any) =>
        strategy === 'latest_document'
          ? new Date(b.extractedAt).getTime() - new Date(a.extractedAt).getTime()
          : b.extractionConfidence - a.extractionConfidence,
      );

      // Deactivate all
      const ids = versions.map((v: any) => v.id);
      await supabase
        .from('FinancialStatement')
        .update({ isActive: false, mergeStatus: 'user_resolved' })
        .in('id', ids);

      // Activate winner
      await supabase
        .from('FinancialStatement')
        .update({
          isActive: true,
          mergeStatus: 'user_resolved',
          reviewedAt: new Date().toISOString(),
          reviewedBy: user?.id ?? null,
        })
        .eq('id', sorted[0].id);

      resolved++;
    }

    res.json({ resolved });
  } catch (err) {
    log.error('POST financials resolve-all error', err);
    res.status(500).json({ error: 'Failed to auto-resolve conflicts' });
  }
});

export default router;
