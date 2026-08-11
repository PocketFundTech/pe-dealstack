import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getAuditLogs } from '../services/auditLog.js';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';

const router = Router();

const querySchema = z.object({
  resourceType: z.string().optional(),
  action: z.string().optional(),
  severity: z.string().optional(),
  userId: z.string().uuid().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

function csvEscape(v: any): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ─── GET /api/audit/export.csv — Stream filtered audit log as CSV ───
//
// Admin-only. Org-scoped. Mounted BEFORE the main /api/audit router so this
// path is matched before the generic GET '/' handler.

router.get('/export.csv', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const role = (user?.role || '').toLowerCase();
    if (!['admin', 'partner', 'principal'].includes(role)) {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const validation = querySchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid query', details: validation.error.errors });
    }
    const f = validation.data;
    const orgId = getOrgId(req);

    const { data, error } = await getAuditLogs({
      organizationId: orgId,
      resourceType: f.resourceType as any,
      action: f.action as any,
      severity: f.severity as any,
      userId: f.userId,
      startDate: f.startDate ? new Date(f.startDate) : undefined,
      endDate: f.endDate ? new Date(f.endDate) : undefined,
      limit: 50000,
      offset: 0,
    });

    if (error) {
      log.error('audit export error', error);
      return res.status(500).json({ error: 'Export failed' });
    }

    const filename = `pocket-fund-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Header row. DB stores entityType/entityId; surface them as resourceType/resourceId
    // so the CSV matches the filter UI vocabulary.
    res.write('timestamp,userId,userEmail,action,resourceType,resourceId,resourceName,severity,ipAddress,description,metadata\n');

    for (const row of (data || [])) {
      const meta = row.metadata;
      const metaStr = meta == null
        ? ''
        : (typeof meta === 'object' ? JSON.stringify(meta) : String(meta));
      res.write([
        csvEscape(row.createdAt),
        csvEscape(row.userId),
        csvEscape(row.userEmail),
        csvEscape(row.action),
        csvEscape(row.entityType),
        csvEscape(row.entityId),
        csvEscape(row.entityName),
        csvEscape(row.severity),
        csvEscape(row.ipAddress),
        csvEscape(row.description),
        csvEscape(metaStr),
      ].join(',') + '\n');
    }

    res.end();
  } catch (err) {
    log.error('audit export exception', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

export default router;
