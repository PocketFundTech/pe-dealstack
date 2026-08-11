import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';

const router = Router();

// Helper: Resolve Supabase auth UUID to internal User table UUID
export async function resolveUserId(authId: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('User')
      .select('id')
      .eq('authId', authId)
      .single();
    return data?.id || null;
  } catch (err) {
    log.warn('notifications: resolveUserId failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// Validation schemas
const createNotificationSchema = z.object({
  userId: z.string().uuid(),
  type: z.enum(['DEAL_UPDATE', 'DOCUMENT_UPLOADED', 'MENTION', 'AI_INSIGHT', 'TASK_ASSIGNED', 'COMMENT', 'SYSTEM', 'CONTACT_FOLLOWUP']),
  title: z.string().min(1).max(255),
  message: z.string().optional(),
  dealId: z.string().uuid().optional(),
  documentId: z.string().uuid().optional(),
});

const updateNotificationSchema = z.object({
  isRead: z.boolean(),
});

const notificationsQuerySchema = z.object({
  userId: z.string().uuid(),
  type: z.enum(['DEAL_UPDATE', 'DOCUMENT_UPLOADED', 'MENTION', 'AI_INSIGHT', 'TASK_ASSIGNED', 'COMMENT', 'SYSTEM', 'CONTACT_FOLLOWUP']).optional(),
  isRead: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const markAllReadSchema = z.object({
  userId: z.string().uuid(),
});

const deleteNotificationsQuerySchema = z.object({
  userId: z.string().uuid(),
  readOnly: z.enum(['true', 'false']).optional(),
});

// GET /api/notifications - List notifications for a user
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = notificationsQuerySchema.parse(req.query);
    const { userId } = params;
    const orgId = getOrgId(req);

    // Resolve userId: could be internal UUID or Supabase auth UUID
    let internalUserId = userId;
    const { data: targetUser } = await supabase
      .from('User')
      .select('id')
      .eq('id', userId)
      .eq('organizationId', orgId)
      .single();

    if (!targetUser) {
      // Try resolving as Supabase auth UUID
      const { data: authUser } = await supabase
        .from('User')
        .select('id')
        .eq('authId', userId)
        .eq('organizationId', orgId)
        .single();

      if (!authUser) {
        return res.status(403).json({ error: 'Cannot access notifications for users outside your organization' });
      }
      internalUserId = authUser.id;
    }

    let query = supabase
      .from('Notification')
      .select(`
        *,
        Deal (
          id,
          name
        )
      `)
      .eq('userId', internalUserId)
      .order('createdAt', { ascending: false });

    if (params.type) {
      query = query.eq('type', params.type);
    }

    if (params.isRead !== undefined) {
      query = query.eq('isRead', params.isRead === 'true');
    }

    if (params.limit) {
      query = query.limit(params.limit);
    }

    if (params.offset) {
      const limitNum = params.limit || 50;
      query = query.range(params.offset, params.offset + limitNum - 1);
    }

    const { data: notifications, error } = await query;

    if (error) throw error;

    // Get unread count
    const { count: unreadCount } = await supabase
      .from('Notification')
      .select('*', { count: 'exact', head: true })
      .eq('userId', internalUserId)
      .eq('isRead', false);

    res.json({
      notifications: notifications || [],
      unreadCount: unreadCount || 0
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/notifications/:id - Get a single notification
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const { data: notification, error } = await supabase
      .from('Notification')
      .select(`
        *,
        Deal (
          id,
          name,
          stage
        )
      `)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Notification not found' });
      }
      throw error;
    }

    // Defense-in-depth: verify notification belongs to a user in this org
    if (notification) {
      const { data: owner } = await supabase
        .from('User')
        .select('id')
        .eq('id', notification.userId)
        .eq('organizationId', orgId)
        .single();
      if (!owner) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    res.json(notification);
  } catch (error) {
    next(error);
  }
});

// POST /api/notifications - Create a notification
// Used by the Admin "Send Reminder" modal (and any other client that needs to
// fire an ad-hoc notification). Routes through createNotification so user
// preferences are honoured; bypassing it caused reminders to silently
// disappear for users who'd opted out of SYSTEM in their settings.
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const validation = createNotificationSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    // Defense-in-depth: verify target user belongs to this org
    const { data: targetUser } = await supabase
      .from('User')
      .select('id')
      .eq('id', validation.data.userId)
      .eq('organizationId', orgId)
      .single();
    if (!targetUser) {
      return res.status(403).json({ error: 'Cannot create notifications for users outside your organization' });
    }

    const notification = await createNotification(validation.data);
    if (!notification) {
      // createNotification swallows DB errors and pref opt-outs alike — return
      // a 202 so the client can show "sent" without leaking the distinction.
      return res.status(202).json({ skipped: true });
    }

    res.status(201).json(notification);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/notifications/:id - Mark as read/unread
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const validation = updateNotificationSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    // Defense-in-depth: verify notification belongs to a user in this org
    const { data: existing } = await supabase
      .from('Notification')
      .select('userId')
      .eq('id', id)
      .single();
    if (existing) {
      const { data: owner } = await supabase
        .from('User')
        .select('id')
        .eq('id', existing.userId)
        .eq('organizationId', orgId)
        .single();
      if (!owner) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const { data: notification, error } = await supabase
      .from('Notification')
      .update(validation.data)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Notification not found' });
      }
      throw error;
    }

    res.json(notification);
  } catch (error) {
    next(error);
  }
});

// POST /api/notifications/mark-all-read - Mark all notifications as read for a user
router.post('/mark-all-read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const { userId } = markAllReadSchema.parse(req.body);

    // Defense-in-depth: verify target user belongs to this org
    const { data: targetUser } = await supabase
      .from('User')
      .select('id')
      .eq('id', userId)
      .eq('organizationId', orgId)
      .single();
    if (!targetUser) {
      return res.status(403).json({ error: 'Cannot modify notifications for users outside your organization' });
    }

    const { error } = await supabase
      .from('Notification')
      .update({ isRead: true })
      .eq('userId', userId)
      .eq('isRead', false);

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/notifications/:id - Delete a notification
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // Defense-in-depth: verify notification belongs to a user in this org
    const { data: existing } = await supabase
      .from('Notification')
      .select('userId')
      .eq('id', id)
      .single();
    if (existing) {
      const { data: owner } = await supabase
        .from('User')
        .select('id')
        .eq('id', existing.userId)
        .eq('organizationId', orgId)
        .single();
      if (!owner) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const { error } = await supabase
      .from('Notification')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// DELETE /api/notifications - Delete all notifications for a user
router.delete('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const params = deleteNotificationsQuerySchema.parse(req.query);

    // Defense-in-depth: verify target user belongs to this org
    const { data: targetUser } = await supabase
      .from('User')
      .select('id')
      .eq('id', params.userId)
      .eq('organizationId', orgId)
      .single();
    if (!targetUser) {
      return res.status(403).json({ error: 'Cannot delete notifications for users outside your organization' });
    }

    let query = supabase
      .from('Notification')
      .delete()
      .eq('userId', params.userId);

    if (params.readOnly === 'true') {
      query = query.eq('isRead', true);
    }

    const { error } = await query;

    if (error) throw error;

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// Helper: Check if a user has opted out of a notification type
async function isNotificationEnabled(userId: string, type: string): Promise<boolean> {
  try {
    const { data: user } = await supabase
      .from('User')
      .select('preferences')
      .eq('id', userId)
      .single();

    if (!user?.preferences) return true; // Default: enabled

    const prefs = typeof user.preferences === 'string'
      ? JSON.parse(user.preferences)
      : user.preferences;

    // Only skip if explicitly set to false
    return prefs?.notifications?.[type] !== false;
  } catch (err) {
    log.warn('notifications: isNotificationEnabled failed, defaulting to enabled', { error: err instanceof Error ? err.message : String(err), userId, type });
    return true; // On error, default to enabled
  }
}

// Utility function to create notifications (exported for use in other routes)
export async function createNotification(data: {
  userId: string;
  type: string;
  title: string;
  message?: string;
  dealId?: string;
  documentId?: string;
}) {
  // Respect user notification preferences
  const enabled = await isNotificationEnabled(data.userId, data.type);
  if (!enabled) {
    log.debug('Notification skipped (user opted out)', { userId: data.userId, type: data.type });
    return null;
  }

  const { data: notification, error } = await supabase
    .from('Notification')
    .insert(data)
    .select()
    .single();

  if (error) {
    log.error('Failed to create notification', error);
    return null;
  }

  return notification;
}

// Utility to notify all team members of a deal
export async function notifyDealTeam(
  dealId: string,
  type: string,
  title: string,
  message?: string,
  excludeUserId?: string
) {
  // Get all team members with their preferences
  const { data: teamMembers, error } = await supabase
    .from('DealTeamMember')
    .select('userId, user:User!userId(preferences)')
    .eq('dealId', dealId);

  if (error || !teamMembers) {
    log.error('Failed to get deal team members', error);
    return;
  }

  // Filter out sender + users who opted out of this notification type
  const notifications = teamMembers
    .filter(tm => {
      if (tm.userId === excludeUserId) return false;
      const user = tm.user as any;
      if (user?.preferences) {
        const prefs = typeof user.preferences === 'string'
          ? JSON.parse(user.preferences)
          : user.preferences;
        if (prefs?.notifications?.[type] === false) return false;
      }
      return true;
    })
    .map(tm => ({
      userId: tm.userId,
      type,
      title,
      message,
      dealId,
    }));

  if (notifications.length > 0) {
    const { error: insertError } = await supabase
      .from('Notification')
      .insert(notifications);

    if (insertError) {
      log.error('Failed to create team notifications', insertError);
    }
  }
}

// ─── Contact follow-up reminders ───────────────────────────────────────────
//
// Scans contacts whose `followUpAt` is due (<= now) and creates a
// CONTACT_FOLLOWUP notification per contact for the given user. Routes through
// createNotification() so user prefs are honoured. Deduped: we skip any contact
// that already has an UNREAD CONTACT_FOLLOWUP notification for this user.
//
// Notification has no contactId column, so we encode the contact id in the
// message with a stable [contact:<id>] marker. That marker is (a) the dedupe
// key and (b) lets the client deep-link to the contact.

const CONTACT_FOLLOWUP_TYPE = 'CONTACT_FOLLOWUP';
const CONTACT_MARKER_RE = /\[contact:([0-9a-f-]{36})\]/i;

function contactMarker(contactId: string): string {
  return `[contact:${contactId}]`;
}

function contactDisplayName(c: { firstName?: string | null; lastName?: string | null; email?: string | null }): string {
  const name = `${c.firstName || ''} ${c.lastName || ''}`.trim();
  return name || c.email || 'a contact';
}

/**
 * Generate CONTACT_FOLLOWUP notifications for a user's org-scoped contacts whose
 * follow-up is due. Returns a summary of what happened.
 *
 * @param orgId          organization scope (contacts are org-scoped)
 * @param internalUserId internal User table UUID (NOT the Supabase auth UUID —
 *                       resolve via resolveUserId() first)
 */
export async function generateContactFollowUpReminders(
  orgId: string,
  internalUserId: string,
): Promise<{ created: number; skipped: number; due: number }> {
  const nowIso = new Date().toISOString();

  // Due contacts: followUpAt set and <= now, scoped to the org.
  const { data: dueContacts, error: dueErr } = await supabase
    .from('Contact')
    .select('id, firstName, lastName, email, company, followUpAt, followUpNote')
    .eq('organizationId', orgId)
    .not('followUpAt', 'is', null)
    .lte('followUpAt', nowIso)
    .order('followUpAt', { ascending: true })
    .limit(100);

  if (dueErr) {
    log.error('generateContactFollowUpReminders: failed to load due contacts', dueErr);
    throw dueErr;
  }

  const due = dueContacts || [];
  if (due.length === 0) {
    return { created: 0, skipped: 0, due: 0 };
  }

  // Existing UNREAD CONTACT_FOLLOWUP notifications for this user → dedupe set.
  const { data: existing, error: existingErr } = await supabase
    .from('Notification')
    .select('message')
    .eq('userId', internalUserId)
    .eq('type', CONTACT_FOLLOWUP_TYPE)
    .eq('isRead', false);

  if (existingErr) {
    log.error('generateContactFollowUpReminders: failed to load existing notifications', existingErr);
    throw existingErr;
  }

  const alreadyNotified = new Set<string>();
  for (const n of existing || []) {
    const m = typeof n.message === 'string' ? n.message.match(CONTACT_MARKER_RE) : null;
    if (m) alreadyNotified.add(m[1].toLowerCase());
  }

  let created = 0;
  let skipped = 0;

  for (const c of due) {
    if (alreadyNotified.has(String(c.id).toLowerCase())) {
      skipped++;
      continue;
    }

    const name = contactDisplayName(c);
    const noteSuffix = c.followUpNote ? ` — ${c.followUpNote}` : '';
    const companySuffix = c.company ? ` (${c.company})` : '';

    const notification = await createNotification({
      userId: internalUserId,
      type: CONTACT_FOLLOWUP_TYPE,
      title: `Follow up with ${name}`,
      // The [contact:<id>] marker is the dedupe key + deep-link anchor.
      message: `Your follow-up with ${name}${companySuffix} is due${noteSuffix} ${contactMarker(c.id)}`,
    });

    if (notification) {
      created++;
      alreadyNotified.add(String(c.id).toLowerCase());
    } else {
      // createNotification returns null on pref opt-out OR insert error.
      skipped++;
    }
  }

  return { created, skipped, due: due.length };
}

// POST /api/notifications/generate-follow-up-reminders
// On-demand reminder generation. Mirrors the NDA on-demand polling pattern
// (POST /legal-documents/check-signatures) — no cron is wired here.
//
// FOLLOW-UP: a scheduled cron to run this automatically is intentionally NOT
// wired. Cron/webhook scheduling is env-fragile and disabled outside prod in
// this codebase (see CLAUDE.md re: Drive files.watch / NDA push detection).
// Re-enable on the verified custom domain alongside the other push jobs.
router.post('/generate-follow-up-reminders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);

    const authId = req.user?.id;
    if (!authId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const internalUserId = await resolveUserId(authId);
    if (!internalUserId) {
      return res.status(403).json({ error: 'User not found in this organization' });
    }

    const result = await generateContactFollowUpReminders(orgId, internalUserId);
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

export default router;
