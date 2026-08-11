import { Router, Request, Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';
import { logAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES, SEVERITY } from '../services/auditLog.js';

const router = Router();

const RESTORE_WINDOW_DAYS = 30;

/**
 * GET /api/deals/trash
 *
 * Returns deals that have been soft-deleted but are still within the
 * 30-day restore window. Org-scoped. Available to any authenticated user
 * who can normally see deals — same access surface as the main list.
 */
router.get('/trash', async (req: Request, res: Response) => {
  try {
    const orgId = getOrgId(req);
    const cutoff = new Date(Date.now() - RESTORE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const { data, error } = await supabase
      .from('Deal')
      .select(`
        id, name, stage, status, "dealSize", "deletedAt", "updatedAt",
        company:Company(id, name)
      `)
      .eq('organizationId', orgId)
      .not('deletedAt', 'is', null)
      .gte('deletedAt', cutoff.toISOString())
      .order('deletedAt', { ascending: false });

    if (error) {
      log.error('Trash query failed', error);
      return res.status(500).json({ error: 'Failed to load trash' });
    }

    return res.json({
      restoreWindowDays: RESTORE_WINDOW_DAYS,
      deals: data ?? [],
    });
  } catch (err) {
    log.error('Trash route error', err);
    return res.status(500).json({ error: 'Failed to load trash' });
  }
});

/**
 * POST /api/deals/:id/restore
 *
 * Clears deletedAt on a deal that's still inside the 30-day window.
 * Cross-org access returns 404 (verifyDealAccess pattern).
 */
router.post('/:id/restore', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const { data: deal, error: fetchErr } = await supabase
      .from('Deal')
      .select('id, name, "deletedAt"')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (fetchErr || !deal) {
      return res.status(404).json({ error: 'Deal not found' });
    }
    if (!deal.deletedAt) {
      return res.status(400).json({ error: 'Deal is not deleted' });
    }

    const deletedAtMs = new Date(deal.deletedAt as string).getTime();
    const expiresMs = deletedAtMs + RESTORE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if (Date.now() > expiresMs) {
      return res.status(410).json({
        error: 'Restore window expired',
        message: `Deals can be restored within ${RESTORE_WINDOW_DAYS} days of deletion.`,
      });
    }

    const { error: updErr } = await supabase
      .from('Deal')
      .update({ deletedAt: null })
      .eq('id', id)
      .eq('organizationId', orgId);

    if (updErr) {
      log.error('Restore update failed', updErr);
      return res.status(500).json({ error: 'Restore failed' });
    }

    try {
      await logAuditEvent(
        {
          userId: (req as any).user?.id,
          userEmail: (req as any).user?.email,
          userRole: (req as any).user?.role,
          organizationId: orgId,
          action: AUDIT_ACTIONS.DEAL_UPDATED,
          resourceType: RESOURCE_TYPES.DEAL,
          resourceId: id,
          resourceName: deal.name as string,
          description: `Restored deal: ${deal.name}`,
          severity: SEVERITY.INFO,
          metadata: { restoredFromTrash: true },
        },
        req,
      );
    } catch (auditErr) {
      log.warn('audit log write failed for deal restore', { err: auditErr });
    }

    return res.json({ success: true, dealId: id });
  } catch (err) {
    log.error('Restore route error', err);
    return res.status(500).json({ error: 'Restore failed' });
  }
});

export default router;
