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

// ─── Companies page (web app) ────────────────────────────────────────
//
// GET /api/companies/list — one page of companies with deal + contact counts.
// GET /api/companies/:id/overview — one company with its deals and contacts.
//
// Kept separate from GET / (which public API-key clients rely on, returning a
// bare array with every deal embedded) so the page can paginate server-side —
// orgs that imported HubSpot can have thousands of companies.
//
// Counts are batched, never per row: deals come from one embedded select
// (soft-deleted deals filtered out in the embed), contacts from one extra
// query for the whole page. Contact has no companyId FK — only a free-text
// `company` name — so a contact belongs to a company when the names match
// case-insensitively.

const companiesListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  hasDeals: z.enum(['all', 'yes', 'no']).default('all'),
  source: z.enum(['all', 'hubspot', 'avise']).default('all'),
  sortBy: z.enum(['name', 'updatedAt']).default('name'),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Escape LIKE wildcards so user text / company names match literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * One PostgREST `or()` term matching `company` case-insensitively and exactly.
 * The value is double-quoted (names contain commas, dots, parentheses) and
 * PostgREST's `*` wildcard alias is replaced by `_`; any over-match that
 * causes is removed by the exact comparison in countContactsByCompanyName.
 */
function companyNameTerm(name: string): string {
  const pattern = escapeLike(name).replace(/\*/g, '_');
  return `company.ilike."${pattern.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const normName = (name: string | null | undefined) => (name ?? '').trim().toLowerCase();

const CONTACT_COUNT_PAGE = 1000;
const CONTACT_COUNT_MAX_PAGES = 20;

/**
 * Contact counts for a page of company names in one query (paged by 1000 rows
 * only if the page's companies have more contacts than that between them).
 */
export async function countContactsByCompanyName(
  orgId: string,
  names: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const wanted = [...new Set(names.map(normName).filter(Boolean))];
  if (wanted.length === 0) return counts;
  const wantedSet = new Set(wanted);
  const orFilter = [...new Set(names.filter((n) => normName(n)).map((n) => n.trim()))]
    .map(companyNameTerm)
    .join(',');

  for (let page = 0; page < CONTACT_COUNT_MAX_PAGES; page++) {
    const from = page * CONTACT_COUNT_PAGE;
    const { data, error } = await supabase
      .from('Contact')
      .select('company')
      .eq('organizationId', orgId)
      .or(orFilter)
      .range(from, from + CONTACT_COUNT_PAGE - 1);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ company: string | null }>) {
      const key = normName(row.company);
      if (wantedSet.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (!data || data.length < CONTACT_COUNT_PAGE) break;
  }
  return counts;
}

type DealStub = { id: string; name: string | null; stage?: string | null; status?: string | null };

router.get('/list', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const params = companiesListQuerySchema.safeParse(req.query);
    if (!params.success) {
      return res.status(400).json({ error: 'Invalid query parameters', details: params.error.errors });
    }
    const { search, hasDeals, source, sortBy, limit, offset } = params.data;
    const ascending = (params.data.sortOrder ?? (sortBy === 'name' ? 'asc' : 'desc')) === 'asc';

    let query = supabase
      .from('Company')
      .select(
        'id, name, industry, website, hubspotId, createdAt, updatedAt, deals:Deal(id, name, stage, status)',
        { count: 'exact' },
      )
      .eq('organizationId', orgId)
      // Soft-deleted deals don't count — and don't make a company "have deals".
      .is('deals.deletedAt', null);

    if (search) query = query.ilike('name', `%${escapeLike(search)}%`);
    if (source === 'hubspot') query = query.not('hubspotId', 'is', null);
    if (source === 'avise') query = query.is('hubspotId', null);
    // Filtering on the embed itself: not-null = has ≥1 live deal (inner join),
    // null = none (anti-join). Both respect the deletedAt filter above.
    if (hasDeals === 'yes') query = query.not('deals', 'is', null);
    if (hasDeals === 'no') query = query.is('deals', null);

    query = query
      .order(sortBy, { ascending, nullsFirst: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    const rows = (data ?? []) as Array<Record<string, any> & { name: string; deals?: DealStub[] | null }>;
    const contactCounts = await countContactsByCompanyName(orgId, rows.map((r) => r.name));

    const companies = rows.map(({ deals, ...company }) => {
      const live = deals ?? [];
      return {
        ...company,
        source: company.hubspotId ? 'hubspot' : 'avise',
        dealCount: live.length,
        deals: live.map((d) => ({ id: d.id, name: d.name, stage: d.stage ?? null, status: d.status ?? null })),
        contactCount: contactCounts.get(normName(company.name)) ?? 0,
      };
    });

    res.json({ companies, total: count ?? 0, limit, offset });
  } catch (error) {
    log.error('Error listing companies', error);
    res.status(500).json({ error: 'Failed to list companies' });
  }
});

const OVERVIEW_CONTACT_LIMIT = 100;

router.get('/:id/overview', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const { data: company, error } = await supabase
      .from('Company')
      .select('id, name, industry, description, website, hubspotId, createdAt, updatedAt')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'Company not found' });
      throw error;
    }

    const name = (company.name ?? '').trim();
    const [dealsRes, contactsRes] = await Promise.all([
      supabase
        .from('Deal')
        .select('id, name, stage, status, updatedAt')
        .eq('companyId', id)
        .eq('organizationId', orgId)
        .is('deletedAt', null)
        .order('updatedAt', { ascending: false }),
      name
        ? supabase
            .from('Contact')
            .select('id, firstName, lastName, email, title', { count: 'exact' })
            .eq('organizationId', orgId)
            .ilike('company', escapeLike(name).replace(/\*/g, '_'))
            .order('lastName', { ascending: true })
            .limit(OVERVIEW_CONTACT_LIMIT)
        : Promise.resolve({ data: [], error: null, count: 0 }),
    ]);
    if (dealsRes.error) throw dealsRes.error;
    if (contactsRes.error) throw contactsRes.error;

    res.json({
      company: { ...company, source: company.hubspotId ? 'hubspot' : 'avise' },
      deals: dealsRes.data ?? [],
      contacts: contactsRes.data ?? [],
      contactTotal: contactsRes.count ?? (contactsRes.data ?? []).length,
    });
  } catch (error) {
    log.error('Error fetching company overview', error);
    res.status(500).json({ error: 'Failed to fetch company' });
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
