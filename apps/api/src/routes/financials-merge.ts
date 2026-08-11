import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { refreshDealCache } from '../services/dealCacheWriteback.js';

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
          // Carry the source-document unit scale + currency through so the
          // frontend can format each version correctly (one doc may be in
          // ACTUALS, another in MILLIONS — the UI must not assume MILLIONS).
          unitScale: v.unitScale,
          currency: v.currency,
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

    const user = (req as any).user;
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

    // Determine the winner BEFORE mutating anything. A resolved period must
    // never be left with zero active versions — that silently hides the
    // period from the reconciler, producing empty ground truth even though
    // the data was extracted. So require an explicit choice and validate it
    // belongs to this period.
    const versionIds = new Set(versions.map((v: any) => v.id));
    const targetId = chosenVersionId ?? (customLineItems ? versions[0].id : undefined);

    if (!targetId) {
      return res.status(400).json({
        error: 'Must provide chosenVersionId or customLineItems to resolve a conflict',
      });
    }
    if (!versionIds.has(targetId)) {
      return res.status(400).json({
        error: 'chosenVersionId does not belong to this statementType/period',
      });
    }

    // Deactivate every version for this period…
    const allIds = versions.map((v: any) => v.id);
    await supabase
      .from('FinancialStatement')
      .update({ isActive: false, mergeStatus: 'user_resolved' })
      .in('id', allIds);

    // …then reactivate exactly the winner, so the period always keeps one
    // active statement.
    await supabase
      .from('FinancialStatement')
      .update({
        isActive: true,
        mergeStatus: 'user_resolved',
        reviewedAt: new Date().toISOString(),
        reviewedBy: user?.id ?? null,
        ...(customLineItems
          ? { lineItems: customLineItems, extractionSource: 'manual' }
          : {}),
      })
      .eq('id', targetId);

    // Refresh cache so deal headline reflects the newly active version.
    await refreshDealCache(dealId);

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

    const user = (req as any).user;
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

    // Refresh cache once after bulk resolution flips isActive across groups.
    if (resolved > 0) {
      await refreshDealCache(dealId);
    }

    res.json({ resolved });
  } catch (err) {
    log.error('POST financials resolve-all error', err);
    res.status(500).json({ error: 'Failed to auto-resolve conflicts' });
  }
});

// ─── 6d: DELETE /api/deals/:dealId/financials/by-document/:documentId ──
// Soft-removes all FinancialStatement rows extracted from a specific
// document. Used when a misclassified one-pager / marketing PDF pollutes
// the deal's financials — caller wants to drop those rows without
// deleting the underlying Document.
router.delete('/deals/:dealId/financials/by-document/:documentId', async (req, res) => {
  try {
    const { dealId, documentId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    // Confirm doc belongs to deal — prevents cross-deal removal via guessed IDs.
    const { data: doc } = await supabase
      .from('Document')
      .select('id')
      .eq('id', documentId)
      .eq('dealId', dealId)
      .maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // Soft-delete FS rows. Schema has `isActive` (see financial-merge-migration.sql).
    // Soft over hard so the rows can be restored from an audit log if needed.
    const { data: removed, error } = await supabase
      .from('FinancialStatement')
      .update({ isActive: false, updatedAt: new Date().toISOString() })
      .eq('dealId', dealId)
      .eq('documentId', documentId)
      .eq('isActive', true)
      .select('id');
    if (error) {
      log.error('Error removing FS rows by document', error);
      return res.status(500).json({ error: 'Failed' });
    }

    const removedCount = removed?.length ?? 0;

    // Refresh headline cache so deal page updates immediately.
    await refreshDealCache(dealId);

    log.info('FinancialStatement rows removed by document', { dealId, documentId, removedCount });
    return res.json({ success: true, removedCount });
  } catch (err: any) {
    log.error('DELETE financials/by-document error', err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
});

export default router;
