// ─── Deal create / update / delete routes ─────────────────────────
// POST   /api/deals                      — create (DEAL_CREATE perm)
// POST   /api/deals/:id/follow-up-questions — AI follow-up questions
// PATCH  /api/deals/:id                  — update (with optimistic locking)
// DELETE /api/deals/:id                  — delete (DEAL_DELETE perm + cascade)

import { Router } from 'express';
import { supabase } from '../supabase.js';
import { z } from 'zod';
import { requirePermission, PERMISSIONS } from '../middleware/rbac.js';
import { getOrgId } from '../middleware/orgScope.js';
import { AuditLog } from '../services/auditLog.js';
import { log } from '../utils/logger.js';
import { createNotification, notifyDealTeam, resolveUserId } from './notifications.js';
import { createDealSchema, updateDealSchema } from './deals-schemas.js';

const router = Router();

// POST /api/deals - Create new deal (requires DEAL_CREATE permission)
router.post('/', requirePermission(PERMISSIONS.DEAL_CREATE), async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const data = createDealSchema.parse(req.body);

    let companyId = data.companyId;

    // Create company if it doesn't exist
    if (!companyId && data.companyName) {
      const { data: company, error: companyError } = await supabase
        .from('Company')
        .insert({
          name: data.companyName,
          industry: data.industry,
          organizationId: orgId,
        })
        .select()
        .single();

      if (companyError) throw companyError;
      companyId = company.id;
    }

    if (!companyId) {
      return res.status(400).json({ error: 'Company ID or name is required' });
    }

    const { data: deal, error: dealError } = await supabase
      .from('Deal')
      .insert({
        name: data.name,
        companyId,
        stage: data.stage,
        status: data.status,
        irrProjected: data.irrProjected,
        mom: data.mom,
        ebitda: data.ebitda,
        revenue: data.revenue,
        industry: data.industry,
        dealSize: data.dealSize,
        description: data.description,
        aiThesis: data.aiThesis,
        icon: data.icon || 'business_center',
        assignedTo: data.assignedTo,
        priority: data.priority || 'MEDIUM',
        tags: data.tags,
        targetCloseDate: data.targetCloseDate,
        source: data.source,
        customFields: data.customFields || {},
        organizationId: orgId,
      })
      .select(`
        *,
        company:Company(*),
        assignedUser:User!assignedTo(id, name, avatar, email)
      `)
      .single();

    if (dealError) throw dealError;

    // Log activity
    await supabase.from('Activity').insert({
      dealId: deal.id,
      type: 'STATUS_UPDATED',
      title: 'Deal Created',
      description: `New deal "${deal.name}" created`,
    });

    // Audit log
    await AuditLog.dealCreated(req, deal.id, deal.name);

    // Notify: deal created (fire-and-forget)
    if (req.user?.id) {
      resolveUserId(req.user.id).then(internalId => {
        if (internalId) {
          createNotification({
            userId: internalId,
            type: 'DEAL_UPDATE',
            title: `New deal created: ${deal.name}`,
            dealId: deal.id,
          });
        }
      }).catch(err => log.error('Notification error (deal create)', err));
    }

    // Auto-archive sample deals when user creates their first real deal
    if (!data.tags?.includes('sample')) {
      void supabase
        .from('Deal')
        .update({ status: 'ARCHIVED' })
        .eq('organizationId', orgId)
        .contains('tags', ['sample'])
        .then(({ error: archiveErr }) => {
          if (archiveErr) log.error('Failed to archive sample deal', archiveErr);
          else log.info('Sample deal archived after real deal creation', { orgId });
        }, () => {}); // Fire-and-forget
    }

    res.status(201).json(deal);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log.error('Error creating deal', error);
    res.status(500).json({ error: 'Failed to create deal' });
  }
});

// POST /api/deals/:id/follow-up-questions - Generate AI follow-up questions
router.post('/:id/follow-up-questions', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // Verify deal access
    const { data: deal } = await supabase
      .from('Deal')
      .select('id')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const extraction = req.body.extraction || req.body;
    const { generateFollowUpQuestions } = await import('../services/followUpQuestions.js');
    const questions = await generateFollowUpQuestions(extraction);
    res.json({ questions });
  } catch (error) {
    log.error('Follow-up questions error', error);
    res.status(500).json({ error: 'Failed to generate follow-up questions' });
  }
});

// PATCH /api/deals/:id - Update deal
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const data = updateDealSchema.parse(req.body);

    // Get existing deal (scoped to org)
    const { data: existingDeal, error: fetchError } = await supabase
      .from('Deal')
      .select('*')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (fetchError || !existingDeal) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // Optimistic locking
    if (req.body.lastKnownUpdatedAt) {
      const clientTimestamp = new Date(req.body.lastKnownUpdatedAt).getTime();
      const serverTimestamp = new Date(existingDeal.updatedAt).getTime();
      if (clientTimestamp < serverTimestamp) {
        return res.status(409).json({
          error: 'Deal was modified by another user. Please refresh and try again.',
          updatedAt: existingDeal.updatedAt,
        });
      }
    }

    // Update deal
    const { data: deal, error: updateError } = await supabase
      .from('Deal')
      .update({
        ...data,
        companyId: undefined,
      })
      .eq('id', id)
      .eq('organizationId', orgId)
      .select(`
        *,
        company:Company(*),
        documents:Document(*),
        activities:Activity(*)
      `)
      .single();

    if (updateError) throw updateError;

    // Log stage change
    if (data.stage && data.stage !== existingDeal.stage) {
      await supabase.from('Activity').insert({
        dealId: deal.id,
        type: 'STAGE_CHANGED',
        title: `Stage changed to ${data.stage}`,
        description: `Deal stage changed from ${existingDeal.stage} to ${data.stage}`,
      });
    }

    // Audit log
    await AuditLog.dealUpdated(req, deal.id, deal.name, data);

    // Notify team: deal updated (fire-and-forget)
    if (req.user?.id) {
      resolveUserId(req.user.id).then(internalId => {
        const stageChanged = data.stage && data.stage !== existingDeal.stage;
        const title = stageChanged
          ? `Deal "${deal.name}" stage changed to ${data.stage}`
          : `Deal "${deal.name}" was updated`;
        notifyDealTeam(deal.id, 'DEAL_UPDATE', title, undefined, internalId || undefined);
      }).catch(err => log.error('Notification error (deal update)', err));
    }

    res.json(deal);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log.error('Error updating deal', error);
    res.status(500).json({ error: 'Failed to update deal' });
  }
});

// DELETE /api/deals/:id - Delete deal (requires DEAL_DELETE permission)
router.delete('/:id', requirePermission(PERMISSIONS.DEAL_DELETE), async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const { data: deal } = await supabase
      .from('Deal')
      .select('name, "deletedAt"')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (!deal) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // Soft-delete: set deletedAt instead of hard-deleting. Child records
    // (Document, Folder, Memo, etc.) stay intact. After the 30-day window
    // expires, a separate cleanup process can hard-delete them.
    // The deals list query filters on deletedAt IS NULL so soft-deleted
    // deals are hidden from the main UI but remain available in /trash.
    const deletedAt = new Date().toISOString();
    const { error } = await supabase
      .from('Deal')
      .update({ deletedAt })
      .eq('id', id)
      .eq('organizationId', orgId);

    if (error) throw error;

    await AuditLog.dealDeleted(req, id, deal?.name || 'Unknown');

    log.info('Deal soft-deleted', { dealId: id, dealName: deal.name });
    res.status(204).send();
  } catch (error) {
    log.error('Error deleting deal', error);
    res.status(500).json({ error: 'Failed to delete deal' });
  }
});

export default router;
