import { Router } from 'express';
import { supabase } from '../supabase.js';
import { AuditLog } from '../services/auditLog.js';
import { log } from '../utils/logger.js';
import { analyzeMultipleDocuments } from '../services/multiDocAnalyzer.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';

const router = Router();

// POST /api/deals/:id/analyze — Run multi-document analysis
router.post('/:id/analyze', async (req: any, res) => {
  try {
    const dealId = req.params.id;
    const orgId = getOrgId(req);

    // Verify deal belongs to caller's org. Return 404 (not 403) to prevent
    // enumeration of deal ids across tenants.
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // Fetch deal name for activity + audit log entries.
    const { data: deal, error: dealError } = await supabase
      .from('Deal')
      .select('id, name')
      .eq('id', dealId)
      .single();

    if (dealError || !deal) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const result = await analyzeMultipleDocuments(dealId);

    if (!result) {
      return res.status(400).json({ error: 'Multi-doc analysis requires at least 2 documents for this deal.' });
    }

    // Log activity
    await supabase.from('Activity').insert({
      dealId,
      type: 'AI_ANALYSIS',
      title: 'Multi-document analysis completed',
      description: `Analyzed ${result.documentContributions.length} documents. Found ${result.conflicts.length} conflicts, ${result.gapsFilled.length} gaps filled.`,
    });

    // Audit log
    await AuditLog.log(req, {
      action: 'AI_ANALYSIS',
      resourceType: 'DEAL',
      resourceId: dealId,
      resourceName: deal.name,
      description: `Multi-doc analysis: ${result.documentContributions.length} docs, ${result.conflicts.length} conflicts`,
    });

    res.json({ success: true, analysis: result });
  } catch (error) {
    log.error('Multi-doc analysis error', error);
    res.status(500).json({ error: 'Failed to run multi-document analysis' });
  }
});

export default router;
