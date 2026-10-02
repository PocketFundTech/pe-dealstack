import { Router } from 'express';
import { supabase } from '../supabase.js';
import { z } from 'zod';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';

const router = Router();

const createCompanySchema = z.object({
  name: z.string().min(1),
  industry: z.string().optional(),
  description: z.string().optional(),
  website: z.string().url().optional(),
});

const updateCompanySchema = createCompanySchema.partial();

// GET /api/companies - Get all companies
const companiesQuerySchema = z.object({
  updatedSince: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

router.get('/', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const params = companiesQuerySchema.safeParse(req.query);
    if (!params.success) {
      return res.status(400).json({ error: 'Invalid query parameters', details: params.error.errors });
    }
    const { updatedSince, limit, offset = 0 } = params.data;

    let query = supabase
      .from('Company')
      .select(`
        *,
        deals:Deal(*)
      `)
      .eq('organizationId', orgId)
      .order('name', { ascending: true });
    if (updatedSince) query = query.gte('updatedAt', updatedSince.toISOString());
    if (params.data.offset !== undefined) {
      query = query.order('id', { ascending: true }).range(offset, offset + (limit ?? 100) - 1);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    log.error('Error fetching companies', error);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// GET /api/companies/:id - Get single company
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const { data, error } = await supabase
      .from('Company')
      .select(`
        *,
        deals:Deal(
          *,
          documents:Document(*),
          activities:Activity(*)
        )
      `)
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Company not found' });
      }
      throw error;
    }

    res.json(data);
  } catch (error) {
    log.error('Error fetching company', error);
    res.status(500).json({ error: 'Failed to fetch company' });
  }
});

// POST /api/companies - Create new company
router.post('/', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const data = createCompanySchema.parse(req.body);

    const { data: company, error } = await supabase
      .from('Company')
      .insert({
        ...data,
        organizationId: orgId,
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(company);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log.error('Error creating company', error);
    res.status(500).json({ error: 'Failed to create company' });
  }
});

// PATCH /api/companies/:id - Update company
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const data = updateCompanySchema.parse(req.body);

    const { data: company, error } = await supabase
      .from('Company')
      .update({ ...data, updatedAt: new Date().toISOString() })
      .eq('id', id)
      .eq('organizationId', orgId)
      .select(`
        *,
        deals:Deal(*)
      `)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Company not found' });
      }
      throw error;
    }

    res.json(company);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log.error('Error updating company', error);
    res.status(500).json({ error: 'Failed to update company' });
  }
});

// DELETE /api/companies/:id - Delete company
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const { error } = await supabase
      .from('Company')
      .delete()
      .eq('id', id)
      .eq('organizationId', orgId);

    if (error) throw error;

    res.status(204).send();
  } catch (error) {
    log.error('Error deleting company', error);
    res.status(500).json({ error: 'Failed to delete company' });
  }
});

export default router;
