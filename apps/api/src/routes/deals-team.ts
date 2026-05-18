import { Router } from 'express';
import { supabase } from '../supabase.js';
import { z } from 'zod';
import { log } from '../utils/logger.js';
import { captureAgentError } from '../utils/sentryHelpers.js';
import { createNotification } from './notifications.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';

const router = Router();

// Validation schemas
const addTeamMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['LEAD', 'MEMBER', 'VIEWER']).optional().default('MEMBER'),
});

// GET /api/deals/:id/team - Get team members for a deal
router.get('/:id/team', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(id, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const { data, error } = await supabase
      .from('DealTeamMember')
      .select(`
        id,
        role,
        addedAt,
        user:User(id, name, avatar, email, title, department)
      `)
      .eq('dealId', id)
      .order('addedAt', { ascending: true });

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    log.error('Error fetching team members', error);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// POST /api/deals/:id/team - Add team member to deal
router.post('/:id/team', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(id, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const data = addTeamMemberSchema.parse(req.body);

    // Idempotent upsert: if the user is already on the team, treat this as a
    // role change (or no-op). The Assign Deal modal doesn't filter out
    // existing members from the dropdown, so picking the same person to
    // change their role must be allowed.
    const { data: existing } = await supabase
      .from('DealTeamMember')
      .select('id, role')
      .eq('dealId', id)
      .eq('userId', data.userId)
      .single();

    let member;
    let action: 'inserted' | 'updated' | 'noop';
    if (existing) {
      if (existing.role === data.role) {
        // Same role — idempotent no-op, return the existing record.
        const { data: full, error: getErr } = await supabase
          .from('DealTeamMember')
          .select(`
            id,
            role,
            addedAt,
            user:User(id, name, avatar, email, title)
          `)
          .eq('id', existing.id)
          .single();
        if (getErr) throw getErr;
        member = full;
        action = 'noop';
      } else {
        // Different role — update.
        const { data: updated, error: updErr } = await supabase
          .from('DealTeamMember')
          .update({ role: data.role })
          .eq('id', existing.id)
          .select(`
            id,
            role,
            addedAt,
            user:User(id, name, avatar, email, title)
          `)
          .single();
        if (updErr) throw updErr;
        member = updated;
        action = 'updated';
      }
    } else {
      const { data: inserted, error: insErr } = await supabase
        .from('DealTeamMember')
        .insert({
          dealId: id,
          userId: data.userId,
          role: data.role,
        })
        .select(`
          id,
          role,
          addedAt,
          user:User(id, name, avatar, email, title)
        `)
        .single();
      if (insErr) throw insErr;
      member = inserted;
      action = 'inserted';
    }

    // For LEAD role, also update Deal.assignedTo so the deal page's
    // "Lead Partner" field (which reads from deal.assignedUser, the relation
    // off Deal.assignedTo) reflects the new lead. Same fix as the chat
    // agent's update_deal_field tool.
    if (data.role === 'LEAD' && action !== 'noop') {
      const { error: dealErr } = await supabase
        .from('Deal')
        .update({ assignedTo: data.userId, updatedAt: new Date().toISOString() })
        .eq('id', id)
        .eq('organizationId', orgId);
      if (dealErr) {
        // Best-effort propagation — the team-member side already succeeded.
        log.error('Failed to update Deal.assignedTo for new lead partner', dealErr);
      }
    }

    if (action === 'inserted') {
      await supabase.from('Activity').insert({
        dealId: id,
        userId: data.userId,
        type: 'TEAM_MEMBER_ADDED',
        title: `Team member added`,
        description: `Added as ${data.role}`,
      });

      // Notify the new team member (fire-and-forget)
      const { data: dealInfo } = await supabase.from('Deal').select('name').eq('id', id).single();
      createNotification({
        userId: data.userId,
        type: 'DEAL_UPDATE',
        title: `You were added to "${dealInfo?.name || 'a deal'}" as ${data.role}`,
        dealId: id,
      }).catch(err => {
        log.error('Notification error (team member added)', err);
        captureAgentError(err, { context: 'notification:deal_team_added' }, 'warning');
      });
    } else if (action === 'updated') {
      await supabase.from('Activity').insert({
        dealId: id,
        userId: data.userId,
        type: 'TEAM_MEMBER_ADDED',
        title: `Team member role updated`,
        description: `Role changed from ${existing!.role} to ${data.role}`,
      });
    }
    // action === 'noop' → nothing changed, skip activity + notification.

    const status = action === 'inserted' ? 201 : 200;
    res.status(status).json(member);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log.error('Error adding team member', error);
    res.status(500).json({ error: 'Failed to add team member' });
  }
});

// PATCH /api/deals/:dealId/team/:memberId - Update team member role
router.patch('/:dealId/team/:memberId', async (req, res) => {
  try {
    const { dealId, memberId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const { role } = req.body;

    if (!['LEAD', 'MEMBER', 'VIEWER'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const { data: member, error } = await supabase
      .from('DealTeamMember')
      .update({ role })
      .eq('id', memberId)
      .eq('dealId', dealId)
      .select(`
        id,
        role,
        addedAt,
        user:User(id, name, avatar, email, title)
      `)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Team member not found' });
      }
      throw error;
    }

    res.json(member);
  } catch (error) {
    log.error('Error updating team member', error);
    res.status(500).json({ error: 'Failed to update team member' });
  }
});

// DELETE /api/deals/:dealId/team/:memberId - Remove team member
router.delete('/:dealId/team/:memberId', async (req, res) => {
  try {
    const { dealId, memberId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const { error } = await supabase
      .from('DealTeamMember')
      .delete()
      .eq('id', memberId)
      .eq('dealId', dealId);

    if (error) throw error;

    res.status(204).send();
  } catch (error) {
    log.error('Error removing team member', error);
    res.status(500).json({ error: 'Failed to remove team member' });
  }
});

export default router;
