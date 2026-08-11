import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';
import {
  logAuditEvent,
  AUDIT_ACTIONS,
  RESOURCE_TYPES,
  SEVERITY,
} from '../services/auditLog.js';
import { notifyStaffAccess } from '../services/staffAccessNotifier.js';

const router = Router();

const patchSchema = z
  .object({
    staffAccessWebhookUrl: z
      .string()
      .url()
      .nullable()
      .or(z.literal(''))
      .transform((v) => (v === '' ? null : v))
      .optional(),
    staffAccessNotifyEmail: z
      .string()
      .email()
      .nullable()
      .or(z.literal(''))
      .transform((v) => (v === '' ? null : v))
      .optional(),
  })
  .strict();

/**
 * PATCH /api/organizations/me/staff-access-webhook
 * Admin-only. Updates per-org Slack webhook URL + notification email used
 * for STAFF_ACCESS events. Setting a non-null value also fires a one-shot
 * test event so the customer can verify the wiring.
 */
router.patch('/me/staff-access-webhook', async (req: Request, res: Response) => {
  try {
    const user = req.user;
    const role = (user?.role || '').toLowerCase();
    if (!user || role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const validation = patchSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid body',
        details: validation.error.errors,
      });
    }

    const updates = validation.data;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const orgId = getOrgId(req);

    const { data, error } = await supabase
      .from('Organization')
      .update(updates)
      .eq('id', orgId)
      .select('id, name, staffAccessWebhookUrl, staffAccessNotifyEmail')
      .single();

    if (error || !data) {
      log.error('staff-access-webhook update failed', error);
      return res.status(500).json({ error: 'Update failed' });
    }

    // Fire a test event so the customer can verify their wiring immediately.
    // Best-effort — failures are logged but the request still succeeds.
    const willTest =
      (updates.staffAccessWebhookUrl !== undefined && updates.staffAccessWebhookUrl !== null) ||
      (updates.staffAccessNotifyEmail !== undefined && updates.staffAccessNotifyEmail !== null);

    if (willTest) {
      try {
        await notifyStaffAccess(orgId, {
          staffEmail: 'security-test@pocket-fund.com',
          method: 'TEST',
          path: '/api/test',
          testMode: true,
        });
      } catch (notifyErr) {
        log.warn('staff-access-webhook test event failed', { err: notifyErr });
      }
    }

    try {
      await logAuditEvent(
        {
          userId: user.id,
          userEmail: user.email,
          userRole: user.role,
          organizationId: orgId,
          action: AUDIT_ACTIONS.STAFF_WEBHOOK_TEST,
          resourceType: RESOURCE_TYPES.SETTINGS,
          resourceId: orgId,
          resourceName: data.name,
          description: 'Staff-access notification config updated',
          metadata: {
            webhookUrlConfigured: !!data.staffAccessWebhookUrl,
            notifyEmailConfigured: !!data.staffAccessNotifyEmail,
          },
          severity: SEVERITY.INFO,
        },
        req,
      );
    } catch (auditErr) {
      log.warn('audit log write failed for staff-access-webhook', { err: auditErr });
    }

    return res.json(data);
  } catch (err) {
    log.error('staff-access-webhook patch error', err);
    return res.status(500).json({ error: 'Failed to update staff-access webhook config' });
  }
});

export default router;
