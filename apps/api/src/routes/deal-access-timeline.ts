import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { getAuditLogs, AUDIT_ACTIONS, RESOURCE_TYPES } from '../services/auditLog.js';

const router = Router();

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

interface ViewerSummary {
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  userRole: string | null;
  lastViewedAt: string;
  viewCount: number;
}

interface AuditRow {
  userId: string | null;
  userEmail?: string | null;
  userRole?: string | null;
  createdAt: string;
  metadata?: { userName?: string | null } | null;
  userName?: string | null;
}

/**
 * GET /api/deals/:dealId/access-timeline?days=30
 *
 * Aggregates DEAL_VIEWED audit events for one deal into a per-user summary.
 * Returns the top 10 viewers ordered by lastViewedAt DESC, plus totals.
 *
 * Org-scoped via verifyDealAccess. Cross-org returns 404 (enumeration-safe).
 */
router.get('/:dealId/access-timeline', async (req: Request, res: Response) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);

    const ok = await verifyDealAccess(dealId, orgId);
    if (!ok) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const validation = querySchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid query',
        details: validation.error.errors,
      });
    }
    const days = validation.data.days;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const { data, error } = await getAuditLogs({
      organizationId: orgId,
      resourceType: RESOURCE_TYPES.DEAL,
      resourceId: dealId,
      action: AUDIT_ACTIONS.DEAL_VIEWED,
      startDate,
      limit: 1000,
      offset: 0,
    });

    if (error) {
      log.error('deal-access-timeline audit query failed', error);
      return res.status(500).json({ error: 'Failed to load access timeline' });
    }

    const rows = (data ?? []) as AuditRow[];

    // Aggregate by userId
    const byUser = new Map<string, ViewerSummary>();
    for (const row of rows) {
      const userId = row.userId;
      if (!userId) continue;
      const existing = byUser.get(userId);
      if (existing) {
        existing.viewCount += 1;
        if (new Date(row.createdAt) > new Date(existing.lastViewedAt)) {
          existing.lastViewedAt = row.createdAt;
        }
      } else {
        byUser.set(userId, {
          userId,
          userName: row.userName ?? row.metadata?.userName ?? null,
          userEmail: row.userEmail ?? null,
          userRole: row.userRole ?? null,
          lastViewedAt: row.createdAt,
          viewCount: 1,
        });
      }
    }

    // Backfill missing names from User table in one query
    const idsNeedingNames = Array.from(byUser.values())
      .filter((v) => !v.userName && v.userId)
      .map((v) => v.userId as string);
    if (idsNeedingNames.length > 0) {
      const { data: users } = await supabase
        .from('User')
        .select('id, name, email, role')
        .in('id', idsNeedingNames);
      if (users) {
        for (const u of users as Array<{
          id: string;
          name: string | null;
          email: string | null;
          role: string | null;
        }>) {
          const summary = byUser.get(u.id);
          if (summary) {
            if (!summary.userName) summary.userName = u.name;
            if (!summary.userEmail) summary.userEmail = u.email;
            if (!summary.userRole) summary.userRole = u.role;
          }
        }
      }
    }

    const viewers = Array.from(byUser.values())
      .sort((a, b) => new Date(b.lastViewedAt).getTime() - new Date(a.lastViewedAt).getTime())
      .slice(0, 10);

    const totalViews = rows.length;
    const uniqueViewers = byUser.size;

    return res.json({
      dealId,
      windowDays: days,
      totalViews,
      uniqueViewers,
      viewers,
    });
  } catch (err) {
    log.error('deal-access-timeline error', err);
    return res.status(500).json({ error: 'Failed to load access timeline' });
  }
});

export default router;
