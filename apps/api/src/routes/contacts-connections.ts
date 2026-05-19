import { Router } from 'express';
import type { Request } from 'express';
import { supabase } from '../supabase.js';
import { z } from 'zod';
import { log } from '../utils/logger.js';
import { getOrgId, verifyContactAccess, verifyDealAccess } from '../middleware/orgScope.js';

const router = Router();

// ─── Validation Schemas ──────────────────────────────────────

const interactionTypes = ['NOTE', 'MEETING', 'CALL', 'EMAIL', 'OTHER'] as const;
const dealRoles = ['BANKER', 'ADVISOR', 'BOARD_MEMBER', 'MANAGEMENT', 'OTHER'] as const;
const relationshipTypes = ['KNOWS', 'REFERRED_BY', 'REPORTS_TO', 'COLLEAGUE', 'INTRODUCED_BY'] as const;

const createInteractionSchema = z.object({
  type: z.enum(interactionTypes).default('NOTE'),
  title: z.string().max(200).optional().or(z.literal('')),
  description: z.string().max(10000).optional().or(z.literal('')),
  date: z.string().optional(),
});

const linkDealSchema = z.object({
  dealId: z.string().uuid(),
  role: z.enum(dealRoles).default('OTHER'),
});

const createConnectionSchema = z.object({
  relatedContactId: z.string().uuid(),
  type: z.enum(relationshipTypes),
  notes: z.string().max(2000).optional().or(z.literal('')),
});

// ─── POST /api/contacts/:id/interactions — Add interaction ──

router.post('/:id/interactions', async (req: Request, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const contactAccess = await verifyContactAccess(id, orgId);
    if (!contactAccess) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const validation = createInteractionSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.errors });
    }

    const data = validation.data;

    const { data: interaction, error } = await supabase
      .from('ContactInteraction')
      .insert({
        contactId: id,
        type: data.type,
        title: data.title || null,
        description: data.description || null,
        date: data.date || new Date().toISOString(),
        createdBy: req.user?.id,
      })
      .select()
      .single();

    if (error) throw error;

    // Update lastContactedAt on the contact
    await supabase
      .from('Contact')
      .update({ lastContactedAt: data.date || new Date().toISOString(), updatedAt: new Date().toISOString() })
      .eq('id', id);

    log.info('Interaction added', { contactId: id, type: data.type });

    res.status(201).json(interaction);
  } catch (error) {
    log.error('Add interaction error', error);
    res.status(500).json({ error: 'Failed to add interaction' });
  }
});

// ─── POST /api/contacts/:id/deals — Link contact to deal ────

router.post('/:id/deals', async (req: Request, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const contactAccess = await verifyContactAccess(id, orgId);
    if (!contactAccess) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const validation = linkDealSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.errors });
    }

    const { dealId, role } = validation.data;

    // Also verify the deal belongs to the same org
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const { data: link, error } = await supabase
      .from('ContactDeal')
      .insert({
        contactId: id,
        dealId,
        role,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Contact is already linked to this deal' });
      }
      throw error;
    }

    log.info('Contact linked to deal', { contactId: id, dealId, role });

    res.status(201).json(link);
  } catch (error) {
    log.error('Link deal error', error);
    res.status(500).json({ error: 'Failed to link deal' });
  }
});

// ─── DELETE /api/contacts/:contactId/deals/:dealId — Unlink ─

router.delete('/:contactId/deals/:dealId', async (req: Request, res) => {
  try {
    const { contactId, dealId } = req.params;
    const orgId = getOrgId(req);
    const contactAccess = await verifyContactAccess(contactId, orgId);
    if (!contactAccess) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const { error } = await supabase
      .from('ContactDeal')
      .delete()
      .eq('contactId', contactId)
      .eq('dealId', dealId);

    if (error) throw error;

    log.info('Contact unlinked from deal', { contactId, dealId });

    res.json({ success: true });
  } catch (error) {
    log.error('Unlink deal error', error);
    res.status(500).json({ error: 'Failed to unlink deal' });
  }
});

// ─── GET /api/contacts/:id/connections — List connections (bidirectional) ─

router.get('/:id/connections', async (req: Request, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const contactAccess = await verifyContactAccess(id, orgId);
    if (!contactAccess) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // Fetch where this contact is either side of the relationship
    // ContactRelationship table may not exist yet — return empty if so
    const { data: asSource, error: e1 } = await supabase
      .from('ContactRelationship')
      .select('*, contact:relatedContactId(id, firstName, lastName, type, company, title)')
      .eq('contactId', id);

    const { data: asTarget, error: e2 } = await supabase
      .from('ContactRelationship')
      .select('*, contact:contactId(id, firstName, lastName, type, company, title)')
      .eq('relatedContactId', id);

    // If table doesn't exist, return empty connections
    if (e1 || e2) {
      res.json({ connections: [] });
      return;
    }

    const connections = [
      ...(asSource || []).map((r: any) => ({ id: r.id, type: r.type, notes: r.notes, contact: r.contact, direction: 'outgoing' })),
      ...(asTarget || []).map((r: any) => ({ id: r.id, type: r.type, notes: r.notes, contact: r.contact, direction: 'incoming' })),
    ];

    res.json({ connections });
  } catch (error) {
    log.error('List connections error', error);
    res.status(500).json({ error: 'Failed to list connections' });
  }
});

// ─── POST /api/contacts/:id/connections — Create connection ─

router.post('/:id/connections', async (req: Request, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const contactAccess = await verifyContactAccess(id, orgId);
    if (!contactAccess) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const validation = createConnectionSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.errors });
    }

    const { relatedContactId, type, notes } = validation.data;

    if (relatedContactId === id) {
      return res.status(400).json({ error: 'Cannot create a connection to the same contact' });
    }

    // F-15: verify the related contact is also in the caller's org.
    // Without this, a user could create a relationship from their own contact
    // pointing at any other org's contact and the GET handler would echo that
    // contact's identity (firstName, lastName, company, title) back through the join.
    const relatedAccess = await verifyContactAccess(relatedContactId, orgId);
    if (!relatedAccess) {
      return res.status(404).json({ error: 'Related contact not found' });
    }

    const insertData: any = {
      contactId: id,
      relatedContactId,
      type,
      notes: notes || null,
    };
    // Only set createdBy if user ID exists — FK may fail if User table ID differs from auth ID
    if (req.user?.id) {
      insertData.createdBy = req.user.id;
    }

    const { data: connection, error } = await supabase
      .from('ContactRelationship')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      log.error('Connection insert error', { code: error.code, message: error.message, details: error.details, hint: error.hint });
      if (error.code === '23505') {
        return res.status(409).json({ error: 'This connection already exists' });
      }
      throw error;
    }

    log.info('Connection created', { contactId: id, relatedContactId, type });

    res.status(201).json(connection);
  } catch (error) {
    log.error('Create connection error', error);
    res.status(500).json({ error: 'Failed to create connection' });
  }
});

// ─── DELETE /api/contacts/:id/connections/:connectionId — Remove connection ─

router.delete('/:id/connections/:connectionId', async (req: Request, res) => {
  try {
    const { id, connectionId } = req.params;
    const orgId = getOrgId(req);
    const contactAccess = await verifyContactAccess(id, orgId);
    if (!contactAccess) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // F-16: constrain delete to relationships involving the verified contact.
    // Without this filter, a caller can delete any ContactRelationship row in
    // any org just by knowing its id.
    const { error } = await supabase
      .from('ContactRelationship')
      .delete()
      .eq('id', connectionId)
      .or(`contactId.eq.${id},relatedContactId.eq.${id}`);

    if (error) throw error;

    log.info('Connection removed', { connectionId });

    res.json({ success: true });
  } catch (error) {
    log.error('Delete connection error', error);
    res.status(500).json({ error: 'Failed to remove connection' });
  }
});

export default router;
