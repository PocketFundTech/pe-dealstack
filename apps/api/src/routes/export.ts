import { Router } from 'express';
import type { Request } from 'express';
import { supabase } from '../supabase.js';
import { z } from 'zod';
import { AuditLog } from '../services/auditLog.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';

const router = Router();

// ─── Query Schema ────────────────────────────────────────────

const exportQuerySchema = z.object({
  format: z.enum(['csv', 'json']).optional().default('json'),
  stage: z.string().optional(),
  status: z.string().optional(),
  industry: z.string().optional(),
});

// ─── GET /api/export/deals — Export deals as JSON or CSV ─────

router.get('/deals', async (req: Request, res) => {
  try {
    const validation = exportQuerySchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid query parameters', details: validation.error.errors });
    }

    const { format, stage, status, industry } = validation.data;
    const orgId = getOrgId(req);

    let query = supabase
      .from('Deal')
      .select('*, company:Company(name, industry)')
      .eq('organizationId', orgId)
      .order('createdAt', { ascending: false });

    if (stage) query = query.eq('stage', stage);
    if (status) query = query.eq('status', status);
    if (industry) query = query.ilike('industry', `%${industry}%`);

    const { data: deals, error } = await query;

    if (error) throw error;

    // Audit the export
    await AuditLog.log(req, {
      action: 'BULK_EXPORT',
      resourceType: 'DEAL',
      description: `Exported ${deals?.length || 0} deals as ${format.toUpperCase()}`,
      metadata: { format, count: deals?.length, filters: { stage, status, industry } },
    });

    if (format === 'csv') {
      const headers = [
        'Name', 'Company', 'Industry', 'Revenue ($M)', 'EBITDA ($M)',
        'Deal Size ($M)', 'IRR (%)', 'MoM', 'Stage', 'Status',
        'Priority', 'Confidence (%)', 'Needs Review', 'Source', 'Created',
      ];

      const rows = (deals || []).map((d: any) => [
        d.name,
        d.company?.name || '',
        d.industry || d.company?.industry || '',
        d.revenue,
        d.ebitda,
        d.dealSize,
        d.irrProjected,
        d.mom,
        d.stage,
        d.status,
        d.priority,
        d.extractionConfidence,
        d.needsReview ? 'Yes' : 'No',
        d.source || '',
        d.createdAt,
      ]);

      // Escape CSV values (handle commas, quotes, newlines)
      const escapeCSV = (val: any): string => {
        if (val === null || val === undefined) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const csv = [
        headers.join(','),
        ...rows.map(r => r.map(escapeCSV).join(',')),
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=deals-export-${Date.now()}.csv`);
      return res.send(csv);
    }

    // JSON format
    res.json({ success: true, count: deals?.length || 0, deals });
  } catch (error) {
    log.error('Export error', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

export default router;
