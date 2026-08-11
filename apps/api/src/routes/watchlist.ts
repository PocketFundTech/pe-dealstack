import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import { resolveUserId } from './notifications.js';

const router = Router();

const createSchema = z.object({
  companyName: z.string().min(1).max(200),
  industry: z.string().max(100).optional().or(z.literal('')),
  notes: z.string().max(2000).optional().or(z.literal('')),
});

// ─── Pagination (Task 5.3.5) ──────────────────────────────────
// Default 50 (a watchlist is shorter than a deal list), cap 500.
const PAGINATION_DEFAULT = 50;
const PAGINATION_MAX = 500;
const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGINATION_MAX).default(PAGINATION_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

// ─── GET /api/watchlist — list for current org ────────────────
router.get('/', async (req: Request, res) => {
  try {
    const orgId = getOrgId(req);

    const paginationParsed = paginationSchema.safeParse(req.query);
    if (!paginationParsed.success) {
      return res.status(400).json({ error: 'Invalid pagination', details: paginationParsed.error.errors });
    }
    const { limit, offset } = paginationParsed.data;

    const { data, error } = await supabase
      .from('Watchlist')
      .select('*')
      .eq('organizationId', orgId)
      .order('createdAt', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const items = data || [];
    res.json({
      items,
      pagination: { limit, offset, hasMore: items.length === limit },
    });
  } catch (err) {
    log.error('List watchlist error', err);
    res.status(500).json({ error: 'Failed to load watchlist' });
  }
});

// ─── POST /api/watchlist — add a new entry ────────────────────
router.post('/', async (req: Request, res) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.errors });
    }

    const orgId = getOrgId(req);
    // Watchlist.addedBy FKs to User.id (the table PK), not the Supabase
    // authId. Same fix pattern as 2d7912e for create-demo-deal.
    const addedBy = req.user?.id ? await resolveUserId(req.user.id) : null;

    const { data, error } = await supabase
      .from('Watchlist')
      .insert({
        organizationId: orgId,
        companyName: parsed.data.companyName.trim(),
        industry: parsed.data.industry?.trim() || null,
        notes: parsed.data.notes?.trim() || null,
        addedBy,
      })
      .select('*')
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    log.error('Create watchlist item error', err);
    res.status(500).json({ error: 'Failed to add watchlist item' });
  }
});

// ─── DELETE /api/watchlist/:id — remove (org-scoped) ──────────
router.delete('/:id', async (req: Request, res) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;

    // Verify org ownership before deleting (return 404 to prevent enumeration)
    const { data: existing, error: lookupErr } = await supabase
      .from('Watchlist')
      .select('id, organizationId')
      .eq('id', id)
      .single();

    if (lookupErr || !existing || existing.organizationId !== orgId) {
      return res.status(404).json({ error: 'Watchlist item not found' });
    }

    const { error } = await supabase
      .from('Watchlist')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    log.error('Delete watchlist item error', err);
    res.status(500).json({ error: 'Failed to delete watchlist item' });
  }
});

export default router;
