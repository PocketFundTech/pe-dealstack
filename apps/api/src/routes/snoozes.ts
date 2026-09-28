import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { resolveUserId } from './notifications.js';

const router = Router();

// Snoozes are the dashboard "Today queue"'s Snooze action, persisted so a
// snooze made on one device is respected on another (was localStorage —
// see apps/web-next/.../dashboard/triage.ts SNOOZE_STORAGE_KEY, removed in
// this change). Scoped to the user, not an organization: itemKey already
// encodes what's being snoozed (e.g. "task:<id>"), and a snooze is a
// personal "don't show me this again yet" preference, not org data.
//
// Requires dashboard-snooze-migration.sql — see docs/PENDING-MIGRATIONS.md.

const upsertSchema = z.object({
  itemKey: z.string().min(1).max(200),
  until: z.string().datetime(),
});

async function requireInternalUserId(req: Request, res: Response): Promise<string | null> {
  const authId = req.user?.id;
  if (!authId) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  const internalUserId = await resolveUserId(authId);
  if (!internalUserId) {
    res.status(403).json({ error: 'User not found' });
    return null;
  }
  return internalUserId;
}

// GET /api/snoozes — this user's currently-active snoozes, as
// { snoozes: { [itemKey]: isoUntil } }. Expired rows are filtered out
// server-side (until > now) rather than left for the client to prune.
router.get('/snoozes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = await requireInternalUserId(req, res);
    if (!userId) return;

    const { data, error } = await supabase
      .from('DashboardSnooze')
      .select('itemKey, until')
      .eq('userId', userId)
      .gt('until', new Date().toISOString());
    if (error) throw error;

    const snoozes: Record<string, string> = {};
    for (const row of data ?? []) snoozes[row.itemKey] = row.until;
    res.json({ snoozes });
  } catch (error) {
    log.error('List snoozes failed', error);
    next(error);
  }
});

// POST /api/snoozes — snooze (or re-snooze) one item. Upserts on
// (userId, itemKey) so repeating a snooze just moves the expiry out.
router.post('/snoozes', async (req: Request, res: Response, next: NextFunction) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
  }
  try {
    const userId = await requireInternalUserId(req, res);
    if (!userId) return;

    const { error } = await supabase
      .from('DashboardSnooze')
      .upsert(
        { userId, itemKey: parsed.data.itemKey, until: parsed.data.until },
        { onConflict: 'userId,itemKey' },
      );
    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    log.error('Create snooze failed', error);
    next(error);
  }
});

// DELETE /api/snoozes/:itemKey — undo a snooze (the Today queue's Undo
// action). itemKey is URL-encoded by the caller since it contains a colon
// and a UUID, e.g. "task:3eda9d69-...".
router.delete('/snoozes/:itemKey', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = await requireInternalUserId(req, res);
    if (!userId) return;

    const { error } = await supabase
      .from('DashboardSnooze')
      .delete()
      .eq('userId', userId)
      .eq('itemKey', req.params.itemKey);
    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    log.error('Delete snooze failed', error);
    next(error);
  }
});

export default router;
