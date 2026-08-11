import { Router } from 'express';
import type { Request } from 'express';
import { supabase } from '../supabase.js';
import { z } from 'zod';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
// Sub-routers
import contactsInsightsRouter from './contacts-insights.js';
import contactsConnectionsRouter from './contacts-connections.js';

const router = Router();

// Postgres unique-violation error code. The partial unique index
// idx_contact_email_org_unique (see contact-email-unique-migration.sql)
// enforces one contact per (lower(email), organizationId); a 23505 from an
// insert is mapped to HTTP 409 as a race fallback for the pre-insert lookup.
const PG_UNIQUE_VIOLATION = '23505';

// Mount sub-routers
router.use('/', contactsInsightsRouter);
router.use('/', contactsConnectionsRouter);

// Look up an existing contact in the org by case-insensitive email match.
// Returns the contact id when a duplicate exists, else null. Empty/missing
// emails never dedupe (a contact without an email can always be created).
async function findContactIdByEmail(orgId: string, email: string | null | undefined): Promise<string | null> {
  const normalized = (email || '').trim();
  if (!normalized) return null;

  // ilike treats % and _ as LIKE wildcards. Emails can legitimately contain
  // underscores, so escape both to force a literal (case-insensitive) match.
  const escaped = normalized.replace(/([%_\\])/g, '\\$1');

  const { data, error } = await supabase
    .from('Contact')
    .select('id')
    .eq('organizationId', orgId)
    .ilike('email', escaped)
    .limit(1)
    .maybeSingle();

  if (error) {
    // Surface the failure to the caller rather than silently allowing a dupe.
    throw error;
  }
  return data?.id ?? null;
}

// ─── Validation Schemas ──────────────────────────────────────

const contactTypes = ['BANKER', 'ADVISOR', 'EXECUTIVE', 'LP', 'LEGAL', 'OTHER'] as const;

const createContactSchema = z.object({
  firstName: z.string().min(1, 'First name is required').max(100),
  lastName: z.string().min(1, 'Last name is required').max(100),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().max(30).optional().or(z.literal('')),
  title: z.string().max(100).optional().or(z.literal('')),
  company: z.string().max(200).optional().or(z.literal('')),
  type: z.enum(contactTypes).default('OTHER'),
  linkedinUrl: z.string().max(500).optional().or(z.literal('')),
  notes: z.string().max(5000).optional().or(z.literal('')),
  tags: z.array(z.string().max(50)).max(20).optional(),
  // Follow-up reminder. Accept an ISO 8601 datetime (with or without offset)
  // or a date-only string (YYYY-MM-DD), or null to clear (PATCH).
  followUpAt: z
    .union([
      z.string().datetime({ offset: true }),
      z.string().datetime(),
      z.string().date(),
    ])
    .nullable()
    .optional(),
  followUpNote: z.string().max(500).optional().or(z.literal('')),
});

const updateContactSchema = createContactSchema.partial();

const contactsQuerySchema = z.object({
  search: z.string().max(200).optional(),
  type: z.enum(contactTypes).optional(),
  company: z.string().max(200).optional(),
  tag: z.string().max(50).optional(),
  sortBy: z.enum(['name', 'company', 'lastContactedAt', 'createdAt']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const importContactsSchema = z.object({
  contacts: z.array(createContactSchema).min(1).max(500),
});

// ─── GET /api/contacts — List contacts with filters ─────────

router.get('/', async (req: Request, res) => {
  try {
    const query = contactsQuerySchema.safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({ error: 'Invalid query parameters', details: query.error.errors });
    }

    const { search, type, company, tag, sortBy, sortOrder, limit = 50, offset = 0 } = query.data;

    const orgId = getOrgId(req);

    let q = supabase
      .from('Contact')
      .select('*, ContactDeal(count)', { count: 'exact' })
      .eq('organizationId', orgId);

    if (type) q = q.eq('type', type);
    if (company) q = q.ilike('company', `%${company}%`);
    if (tag) q = q.contains('tags', [tag]);

    if (search) {
      q = q.or(`firstName.ilike.%${search}%,lastName.ilike.%${search}%,email.ilike.%${search}%,company.ilike.%${search}%`);
    }

    // Sorting
    if (sortBy === 'name') {
      q = q.order('lastName', { ascending: sortOrder !== 'desc' })
           .order('firstName', { ascending: sortOrder !== 'desc' });
    } else if (sortBy === 'company') {
      q = q.order('company', { ascending: sortOrder !== 'desc', nullsFirst: false });
    } else if (sortBy === 'lastContactedAt') {
      q = q.order('lastContactedAt', { ascending: sortOrder === 'asc', nullsFirst: false });
    } else {
      // Default: sort by createdAt. Honor sortOrder so "Oldest First" works.
      q = q.order('createdAt', { ascending: sortOrder === 'asc' });
    }

    q = q.range(offset, offset + limit - 1);

    const { data: contacts, error, count } = await q;

    if (error) throw error;

    res.json({
      contacts: contacts || [],
      total: count || 0,
      limit,
      offset,
    });
  } catch (error) {
    log.error('List contacts error', error);
    res.status(500).json({ error: 'Failed to list contacts' });
  }
});

// ─── GET /api/contacts/export — Export contacts as CSV ───────

router.get('/export', async (req: Request, res) => {
  try {
    const orgId = getOrgId(req);
    const query = contactsQuerySchema.safeParse(req.query);
    const { search, type, sortBy, sortOrder } = query.success ? query.data : {} as any;

    let q = supabase
      .from('Contact')
      .select('firstName, lastName, email, phone, title, company, type, linkedinUrl, tags, lastContactedAt, createdAt')
      .eq('organizationId', orgId);

    if (type) q = q.eq('type', type);
    if (search) {
      q = q.or(`firstName.ilike.%${search}%,lastName.ilike.%${search}%,email.ilike.%${search}%,company.ilike.%${search}%`);
    }

    if (sortBy === 'name') {
      q = q.order('lastName', { ascending: sortOrder !== 'desc' })
           .order('firstName', { ascending: sortOrder !== 'desc' });
    } else if (sortBy === 'company') {
      q = q.order('company', { ascending: sortOrder !== 'desc', nullsFirst: false });
    } else if (sortBy === 'lastContactedAt') {
      q = q.order('lastContactedAt', { ascending: sortOrder === 'asc', nullsFirst: false });
    } else {
      // Default: sort by createdAt. Honor sortOrder so "Oldest First" works.
      q = q.order('createdAt', { ascending: sortOrder === 'asc' });
    }

    const { data: contacts, error } = await q;
    if (error) throw error;

    const headers = ['First Name', 'Last Name', 'Email', 'Phone', 'Title', 'Company', 'Type', 'LinkedIn', 'Tags', 'Last Contacted', 'Date Added'];

    const escCsv = (val: any) => {
      if (val == null) return '';
      const s = String(val);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const rows = (contacts || []).map(c => [
      escCsv(c.firstName),
      escCsv(c.lastName),
      escCsv(c.email),
      escCsv(c.phone),
      escCsv(c.title),
      escCsv(c.company),
      escCsv(c.type),
      escCsv(c.linkedinUrl),
      escCsv((c.tags || []).join('; ')),
      escCsv(c.lastContactedAt ? new Date(c.lastContactedAt).toLocaleDateString() : ''),
      escCsv(c.createdAt ? new Date(c.createdAt).toLocaleDateString() : ''),
    ].join(','));

    const csv = [headers.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-export-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csv);
  } catch (error) {
    log.error('Export contacts error', error);
    res.status(500).json({ error: 'Failed to export contacts' });
  }
});

// ─── GET /api/contacts/:id — Get contact with details ───────

router.get('/:id', async (req: Request, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const { data: contact, error } = await supabase
      .from('Contact')
      .select('*')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (error || !contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // Fetch interactions
    const { data: interactions } = await supabase
      .from('ContactInteraction')
      .select('*')
      .eq('contactId', id)
      .order('date', { ascending: false });

    // Fetch linked deals
    const { data: contactDeals } = await supabase
      .from('ContactDeal')
      .select('*, Deal(id, name, stage, status, industry, icon)')
      .eq('contactId', id)
      .order('createdAt', { ascending: false });

    res.json({
      ...contact,
      interactions: interactions || [],
      linkedDeals: (contactDeals || []).map((cd: any) => ({
        ...cd.Deal,
        linkRole: cd.role,
        linkedAt: cd.createdAt,
      })),
    });
  } catch (error) {
    log.error('Get contact error', error);
    res.status(500).json({ error: 'Failed to get contact' });
  }
});

// ─── POST /api/contacts — Create contact ────────────────────

router.post('/', async (req: Request, res) => {
  try {
    const validation = createContactSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.errors });
    }

    const data = validation.data;

    const orgId = getOrgId(req);

    // Reject duplicates by case-insensitive email within the org. Empty emails
    // are allowed through (a contact without an email never dedupes).
    const existingContactId = await findContactIdByEmail(orgId, data.email);
    if (existingContactId) {
      return res.status(409).json({
        error: 'A contact with this email already exists',
        existingContactId,
      });
    }

    const { data: contact, error } = await supabase
      .from('Contact')
      .insert({
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email || null,
        phone: data.phone || null,
        title: data.title || null,
        company: data.company || null,
        type: data.type,
        linkedinUrl: data.linkedinUrl || null,
        notes: data.notes || null,
        tags: data.tags || [],
        followUpAt: data.followUpAt || null,
        followUpNote: data.followUpNote || null,
        createdBy: req.user?.id,
        organizationId: orgId,
      })
      .select()
      .single();

    if (error) {
      // Race fallback: two concurrent inserts (e.g. a double-clicked Gmail
      // suggestion) can both pass the lookup above. The DB's partial unique
      // index then rejects the loser with 23505 — map it to the same 409.
      if (error.code === PG_UNIQUE_VIOLATION) {
        const raceWinnerId = await findContactIdByEmail(orgId, data.email);
        return res.status(409).json({
          error: 'A contact with this email already exists',
          existingContactId: raceWinnerId,
        });
      }
      log.error('Supabase insert error', { code: error.code, message: error.message, details: error.details, hint: error.hint });
      return res.status(500).json({ error: 'Failed to create contact', details: error.message });
    }

    log.info('Contact created', { contactId: contact.id, name: `${data.firstName} ${data.lastName}` });

    // Auto-enrich in background (fire-and-forget) — don't block the response
    const { isLLMAvailable } = await import('../services/llm.js');
    if (isLLMAvailable()) {
      const { runContactEnrichment } = await import('../services/agents/contactEnrichment/index.js');
      runContactEnrichment({
        contactId: contact.id,
        organizationId: orgId,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        company: data.company,
        title: data.title,
      }).then(result => {
        log.info('Auto-enrichment complete', { contactId: contact.id, confidence: result.confidence, status: result.status });
      }).catch(err => {
        log.error('Auto-enrichment failed (non-blocking)', { contactId: contact.id, error: err.message });
      });
    }

    res.status(201).json(contact);
  } catch (error: any) {
    log.error('Create contact error', error);
    res.status(500).json({ error: 'Failed to create contact', details: error?.message });
  }
});

// ─── PATCH /api/contacts/:id — Update contact ───────────────

router.patch('/:id', async (req: Request, res) => {
  try {
    const { id } = req.params;
    const validation = updateContactSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.errors });
    }

    const updates: Record<string, any> = { updatedAt: new Date().toISOString() };
    const data = validation.data;

    if (data.firstName !== undefined) updates.firstName = data.firstName;
    if (data.lastName !== undefined) updates.lastName = data.lastName;
    if (data.email !== undefined) updates.email = data.email || null;
    if (data.phone !== undefined) updates.phone = data.phone || null;
    if (data.title !== undefined) updates.title = data.title || null;
    if (data.company !== undefined) updates.company = data.company || null;
    if (data.type !== undefined) updates.type = data.type;
    if (data.linkedinUrl !== undefined) updates.linkedinUrl = data.linkedinUrl || null;
    if (data.notes !== undefined) updates.notes = data.notes || null;
    if (data.tags !== undefined) updates.tags = data.tags;
    // followUpAt: accept an ISO string to set, or explicit null to clear.
    if (data.followUpAt !== undefined) updates.followUpAt = data.followUpAt ?? null;
    if (data.followUpNote !== undefined) updates.followUpNote = data.followUpNote || null;

    const orgId = getOrgId(req);

    const { data: contact, error } = await supabase
      .from('Contact')
      .update(updates)
      .eq('id', id)
      .eq('organizationId', orgId)
      .select()
      .single();

    if (error) throw error;
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    log.info('Contact updated', { contactId: id });

    res.json(contact);
  } catch (error) {
    log.error('Update contact error', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// ─── DELETE /api/contacts/:id — Delete contact ──────────────

router.delete('/:id', async (req: Request, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const { error } = await supabase
      .from('Contact')
      .delete()
      .eq('id', id)
      .eq('organizationId', orgId);

    if (error) throw error;

    log.info('Contact deleted', { contactId: id });

    res.json({ success: true });
  } catch (error) {
    log.error('Delete contact error', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// ─── POST /api/contacts/import — Bulk import contacts ───────

router.post('/import', async (req: Request, res) => {
  try {
    const validation = importContactsSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.errors });
    }

    const orgId = getOrgId(req);
    const { contacts } = validation.data;
    const results = {
      success: 0,
      failed: 0,
      errors: [] as string[],
      skippedDuplicates: 0,
      duplicateEmails: [] as string[],
    };

    // Load every email already in the org once, so we can dedupe the batch in
    // memory (case-insensitive) instead of one round-trip per row.
    const { data: existing, error: existingError } = await supabase
      .from('Contact')
      .select('email')
      .eq('organizationId', orgId)
      .not('email', 'is', null);

    if (existingError) throw existingError;

    // Tracks both pre-existing emails and ones inserted earlier in THIS batch,
    // so two rows with the same email don't both get created.
    const seenEmails = new Set<string>(
      (existing || [])
        .map((row) => (row.email || '').trim().toLowerCase())
        .filter((e) => e.length > 0),
    );

    for (const c of contacts) {
      const normalizedEmail = (c.email || '').trim().toLowerCase();

      // Skip (don't fail) rows whose email already exists in the org or earlier
      // in this batch. Rows without an email are always imported.
      if (normalizedEmail && seenEmails.has(normalizedEmail)) {
        results.skippedDuplicates++;
        results.duplicateEmails.push(c.email || '');
        continue;
      }

      const { error } = await supabase
        .from('Contact')
        .insert({
          firstName: c.firstName,
          lastName: c.lastName,
          email: c.email || null,
          phone: c.phone || null,
          title: c.title || null,
          company: c.company || null,
          type: c.type || 'OTHER',
          linkedinUrl: c.linkedinUrl || null,
          notes: c.notes || null,
          tags: c.tags || [],
          createdBy: req.user?.id,
          organizationId: orgId,
        });

      if (error) {
        // The DB unique index is the source of truth: a concurrent import could
        // still collide. Treat that as a skipped duplicate, not a failure.
        if (error.code === PG_UNIQUE_VIOLATION) {
          results.skippedDuplicates++;
          results.duplicateEmails.push(c.email || '');
          continue;
        }
        results.failed++;
        results.errors.push(`${c.firstName} ${c.lastName}: ${error.message}`);
      } else {
        results.success++;
        if (normalizedEmail) seenEmails.add(normalizedEmail);
      }
    }

    log.info('Contacts import complete', {
      total: contacts.length,
      success: results.success,
      failed: results.failed,
      skippedDuplicates: results.skippedDuplicates,
    });

    res.status(201).json({
      success: true,
      imported: results.success,
      failed: results.failed,
      errors: results.errors,
      skippedDuplicates: results.skippedDuplicates,
      duplicateEmails: results.duplicateEmails,
    });
  } catch (error) {
    log.error('Import contacts error', error);
    res.status(500).json({ error: 'Failed to import contacts' });
  }
});

export default router;
