// ─── Deal list / detail routes ────────────────────────────────────
// GET /api/deals/stats/summary — counts + by-stage breakdown
// GET /api/deals               — list with company + assignedUser + team
// GET /api/deals/:id           — single deal with full eager-loaded graph
//
// /stats/summary must be registered before /:id so the Express router
// matches the literal path before the param route.

import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../supabase.js';
import { z } from 'zod';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import { NotFoundError } from '../middleware/errorHandler.js';
import type { SortableByDate } from '../types/index.js';
import { dealsQuerySchema } from './deals-schemas.js';
import {
  logFromRequest,
  AUDIT_ACTIONS,
  RESOURCE_TYPES,
  SEVERITY,
} from '../services/auditLog.js';

const router = Router();

// GET /api/deals/stats/summary - Get deal statistics (must be before :id route)
router.get('/stats/summary', async (req, res) => {
  try {
    const orgId = getOrgId(req);

    const { count: total } = await supabase
      .from('Deal')
      .select('*', { count: 'exact', head: true })
      .eq('organizationId', orgId);

    const { count: active } = await supabase
      .from('Deal')
      .select('*', { count: 'exact', head: true })
      .eq('organizationId', orgId)
      .eq('status', 'ACTIVE');

    const { count: passed } = await supabase
      .from('Deal')
      .select('*', { count: 'exact', head: true })
      .eq('organizationId', orgId)
      .eq('status', 'PASSED');

    const { data: deals } = await supabase
      .from('Deal')
      .select('stage')
      .eq('organizationId', orgId)
      .eq('status', 'ACTIVE');

    const byStage = deals?.reduce((acc: Record<string, number>, deal) => {
      acc[deal.stage] = (acc[deal.stage] || 0) + 1;
      return acc;
    }, {});

    res.json({
      total: total || 0,
      active: active || 0,
      passed: passed || 0,
      byStage: Object.entries(byStage || {}).map(([stage, count]) => ({ stage, count })),
    });
  } catch (error) {
    log.error('Error fetching stats', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// GET /api/deals - Get all deals with company info
router.get('/', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const params = dealsQuerySchema.parse(req.query);

    let query = supabase
      .from('Deal')
      .select(`
        *,
        company:Company(*),
        assignedUser:User!assignedTo(id, name, avatar, email),
        teamMembers:DealTeamMember(
          id,
          role,
          addedAt,
          user:User(id, name, avatar, email)
        )
      `)
      .eq('organizationId', orgId)
      // Hide soft-deleted deals from the main list. They live in /trash until
      // hard-deleted after the 30-day grace period.
      .is('deletedAt', null);

    // Apply filters
    if (params.stage) query = query.eq('stage', params.stage);
    if (params.status) query = query.eq('status', params.status);
    if (params.industry) query = query.ilike('industry', `%${params.industry}%`);
    if (params.assignedTo) query = query.eq('assignedTo', params.assignedTo);
    if (params.priority) query = query.eq('priority', params.priority);

    // Deal size range filters
    if (params.minDealSize) query = query.gte('dealSize', params.minDealSize);
    if (params.maxDealSize) query = query.lte('dealSize', params.maxDealSize);

    // Text search across multiple fields
    if (params.search) {
      const searchTerm = `%${params.search}%`;
      query = query.or(`name.ilike.${searchTerm},industry.ilike.${searchTerm},aiThesis.ilike.${searchTerm}`);
    }

    // Sorting
    const sortField = params.sortBy || 'updatedAt';
    const ascending = params.sortOrder === 'asc';
    query = query.order(sortField, { ascending, nullsFirst: false });

    const { data, error } = await query;

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid query parameters', details: error.errors });
    }
    log.error('Error fetching deals', error);
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

// GET /api/deals/:id - Get single deal
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const { data, error } = await supabase
      .from('Deal')
      .select(`
        *,
        company:Company(*),
        assignedUser:User!assignedTo(id, name, avatar, email, title),
        teamMembers:DealTeamMember(
          id,
          role,
          addedAt,
          user:User(id, name, avatar, email, title, department)
        ),
        documents:Document(
          id,
          name,
          type,
          fileUrl,
          fileSize,
          aiAnalysis,
          createdAt
        ),
        activities:Activity(
          id,
          type,
          title,
          description,
          createdAt,
          user:User!userId(id, name, avatar)
        ),
        folders:Folder(
          id,
          name,
          fileCount,
          isRestricted
        )
      `)
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new NotFoundError('Deal');
      }
      throw error;
    }

    // Sort activities by date (most recent first)
    if (data?.activities) {
      data.activities.sort((a: SortableByDate, b: SortableByDate) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    }

    // Best-effort: log a DEAL_VIEWED event so the per-deal access timeline
    // has data to show. Fire-and-forget; never block the response.
    void logFromRequest(req, AUDIT_ACTIONS.DEAL_VIEWED, {
      resourceType: RESOURCE_TYPES.DEAL,
      resourceId: data.id,
      resourceName: data.name ?? null,
      description: `Viewed deal: ${data.name ?? data.id}`,
      severity: SEVERITY.INFO,
    }).catch((err) => log.warn('DEAL_VIEWED audit failed', { err, dealId: data.id }));

    res.json(data);
  } catch (error) {
    next(error);
  }
});

export default router;
