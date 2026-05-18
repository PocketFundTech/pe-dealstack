import { Router } from 'express';
import { supabase } from '../supabase.js';
import { z } from 'zod';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { createNotification } from './notifications.js';

const router = Router();

// Query parameter schemas
const activitiesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const recentActivitiesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Validation schemas
const createActivitySchema = z.object({
  type: z.enum([
    'DOCUMENT_UPLOADED',
    'STAGE_CHANGED',
    'NOTE_ADDED',
    'MEETING_SCHEDULED',
    'CALL_LOGGED',
    'EMAIL_SENT',
    'STATUS_UPDATED'
  ]),
  title: z.string().min(1),
  description: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  // Emails the client picked from the @-mention dropdown. Server resolves
  // them to User rows scoped to this org — avoids the multi-user-same-name
  // ambiguity that text-based regex parsing can't resolve. Email is unique
  // per User and shown in the picker, so the client can always send a
  // canonical identifier without surfacing UUIDs in the UI.
  mentionedEmails: z.array(z.string().email()).optional(),
});

// GET /api/deals/:dealId/activities - List activities for a deal
router.get('/deals/:dealId/activities', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const { limit, offset } = activitiesQuerySchema.parse(req.query);

    const { data, error, count } = await supabase
      .from('Activity')
      .select('*', { count: 'exact' })
      .eq('dealId', dealId)
      .order('createdAt', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({
      data: data || [],
      total: count || 0,
      limit,
      offset,
    });
  } catch (error) {
    log.error('Error fetching activities', error);
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

// POST /api/deals/:dealId/activities - Create activity for a deal
router.post('/deals/:dealId/activities', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const data = createActivitySchema.parse(req.body);

    // Verify deal exists
    const { data: deal, error: dealError } = await supabase
      .from('Deal')
      .select('id, name')
      .eq('id', dealId)
      .single();

    if (dealError || !deal) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const { data: activity, error } = await supabase
      .from('Activity')
      .insert({
        dealId,
        type: data.type,
        title: data.title,
        description: data.description,
        metadata: data.metadata,
      })
      .select()
      .single();

    if (error) throw error;

    // @-mention notifications. Client sends emails picked from the
    // @-dropdown (deal-overview.tsx tracks them in state). We resolve each
    // to a User row scoped to this org — defense-in-depth so a crafted
    // request can't notify users in another tenant. Awaited so the
    // notifications actually land: Vercel's serverless runtime can freeze
    // the function once the response is sent, dropping any pending
    // post-response promises.
    if (data.mentionedEmails && data.mentionedEmails.length > 0) {
      try {
        const { data: validUsers } = await supabase
          .from('User')
          .select('id, email')
          .in('email', data.mentionedEmails)
          .eq('organizationId', orgId);
        const recipients = (validUsers || []).map((u) => ({
          id: u.id as string,
          email: u.email as string,
        }));
        log.info('Mention scan: explicit emails', {
          dealId,
          sent: data.mentionedEmails.length,
          valid: recipients.length,
          emails: recipients.map((r) => r.email),
        });
        if (recipients.length > 0) {
          const snippet = (data.description || '').slice(0, 200);
          const results = await Promise.all(
            recipients.map((r) =>
              createNotification({
                userId: r.id,
                type: 'MENTION',
                title: `You were mentioned in "${deal.name}"`,
                message: snippet,
                dealId,
              }).catch((err) => {
                log.error('Mention notification failed', err);
                return null;
              }),
            ),
          );
          const created = results.filter((r) => r !== null).length;
          log.info('Mention scan: notifications created', { dealId, attempted: recipients.length, created });
        }
      } catch (err) {
        log.error('Mention notification path failed', err);
      }
    }

    res.status(201).json(activity);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log.error('Error creating activity', error);
    res.status(500).json({ error: 'Failed to create activity' });
  }
});

// GET /api/activities/recent - Get recent activities across caller's org deals
// Registered BEFORE `/activities/:id` so Express doesn't match `recent` as a
// path parameter (without this, /recent silently hits the :id handler).
router.get('/activities/recent', async (req, res) => {
  try {
    const { limit } = recentActivitiesQuerySchema.parse(req.query);
    const orgId = getOrgId(req);

    // Pre-fetch deal IDs for this org, then filter activities at the DB layer.
    // Avoids the "load N rows globally, filter in JS" anti-pattern (which can
    // silently drop the caller's own activities when other tenants are busier).
    const { data: deals, error: dealsErr } = await supabase
      .from('Deal')
      .select('id')
      .eq('organizationId', orgId);

    if (dealsErr) throw dealsErr;

    const dealIds = (deals || []).map((d: { id: string }) => d.id);
    if (dealIds.length === 0) {
      return res.json([]);
    }

    const { data, error } = await supabase
      .from('Activity')
      .select(`
        *,
        deal:Deal(id, name, icon, industry)
      `)
      .in('dealId', dealIds)
      .order('createdAt', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    log.error('Error fetching recent activities', error);
    res.status(500).json({ error: 'Failed to fetch recent activities' });
  }
});

// GET /api/activities/:id - Get single activity
router.get('/activities/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // Resolve the activity's dealId first, then verify the deal belongs to caller's org.
    // Returns 404 (not 403) to prevent enumeration of activity ids across tenants.
    const { data: activityRef, error: refError } = await supabase
      .from('Activity')
      .select('id, dealId')
      .eq('id', id)
      .single();

    if (refError || !activityRef?.dealId) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    const dealAccess = await verifyDealAccess(activityRef.dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    const { data, error } = await supabase
      .from('Activity')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Activity not found' });
      }
      throw error;
    }

    res.json(data);
  } catch (error) {
    log.error('Error fetching activity', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// DELETE /api/activities/:id - Delete activity
router.delete('/activities/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('Activity')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.status(204).send();
  } catch (error) {
    log.error('Error deleting activity', error);
    res.status(500).json({ error: 'Failed to delete activity' });
  }
});

export default router;
