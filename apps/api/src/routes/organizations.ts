import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';
import { invalidateOrgMfa } from '../middleware/authContextCache.js';
import {
  logAuditEvent,
  AUDIT_ACTIONS,
  RESOURCE_TYPES,
  SEVERITY,
} from '../services/auditLog.js';

const router = Router();

/**
 * GET /api/organizations/me
 * Returns the requesting user's organization.
 */
router.get('/me', async (req: Request, res: Response) => {
  try {
    const orgId = getOrgId(req);
    const { data, error } = await supabase
      .from('Organization')
      .select(
        'id, name, slug, logo, industry, plan, maxUsers, isActive, requireMFA, staffAccessWebhookUrl, staffAccessNotifyEmail',
      )
      .eq('id', orgId)
      .single();

    if (error || !data) {
      log.error('organizations/me lookup failed', error);
      return res.status(404).json({ error: 'Organization not found' });
    }

    return res.json(data);
  } catch (err) {
    log.error('organizations/me error', err);
    return res.status(500).json({ error: 'Failed to load organization' });
  }
});

/**
 * PATCH /api/organizations/me
 * Admin-only: update org-level settings (currently just requireMFA).
 */
const patchSchema = z
  .object({
    requireMFA: z.boolean().optional(),
  })
  .strict();

router.patch('/me', async (req: Request, res: Response) => {
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
      .select('id, name, requireMFA')
      .single();

    if (error || !data) {
      log.error('organizations/me update failed', error);
      return res.status(500).json({ error: 'Update failed' });
    }

    // MFA policy may have changed — drop the cached value so the new setting
    // is enforced on the very next request rather than after the TTL.
    if (updates.requireMFA !== undefined) {
      invalidateOrgMfa(orgId);
    }

    if (updates.requireMFA !== undefined) {
      try {
        await logAuditEvent(
          {
            userId: user.id,
            userEmail: user.email,
            userRole: user.role,
            organizationId: orgId,
            action: updates.requireMFA
              ? AUDIT_ACTIONS.ORG_MFA_REQUIRED
              : AUDIT_ACTIONS.ORG_MFA_NOT_REQUIRED,
            resourceType: RESOURCE_TYPES.SETTINGS,
            resourceId: orgId,
            resourceName: data.name,
            description: `Organization MFA requirement set to ${updates.requireMFA}`,
            metadata: { requireMFA: updates.requireMFA },
            severity: SEVERITY.WARNING,
          },
          req,
        );
      } catch (auditErr) {
        log.warn('audit log write failed for org MFA toggle', { err: auditErr });
      }
    }

    return res.json(data);
  } catch (err) {
    log.error('organizations/me patch error', err);
    return res.status(500).json({ error: 'Failed to update organization' });
  }
});

export default router;
