// ─── Clay inbound sourcing import ────────────────────────────────────
//
// Clay has no query/search API to call outward — confirmed in
// services/outreachEnrichment.ts's module header (no synchronous "search
// companies by filter" endpoint on a normal plan). Sourcing here works the
// other way round from that file's enrichment integration: a human filters
// a company list inside Clay's own UI (industry, location, employee size),
// then Clay pushes the resulting rows OUT to us via an outbound HTTP
// webhook action a human configures inside Clay's table
// (routes/outreach-clay-import-webhook.ts receives it).
//
// ─── Expected payload shape (OUR contract, not a confirmed Clay field
//     dictionary — Clay has no fixed schema for this direction) ─────────
//
// This module does not know Clay's actual outbound column names, because
// they're whatever the human names the columns in their Clay table. What
// it expects is documented here as the target shape; the human configuring
// Clay's "Send Webhook" action must map their table's columns to these
// keys (Clay's webhook action lets you name each JSON field it sends —
// point each one at the matching key below):
//
//   {
//     "companyName": "Acme Technologies Pvt Ltd",   // required
//     "contactName": "Priya Sharma",                 // decision-maker, if identified
//     "email": "priya@acme.com",
//     "phone": "+91 98765 43210",
//     "title": "VP Operations",
//     "linkedinUrl": "https://linkedin.com/in/...",
//     "location": "Mumbai, India",
//     "employeeSize": "51-200",
//     "industry": "Manufacturing",
//     "sourceUrl": "https://...",                    // Clay row / source link
//     "cin": "U72200MH2015PTC262812"                 // optional, most reliable de-dupe key
//   }
//
// The webhook route accepts this shape three ways, since Clay's "Send
// Webhook" action can be configured to fire per-row or batched:
//   - a bare array of the objects above
//   - { "rows": [ ...objects... ] }  (or "data"/"records", same idea)
//   - a single un-wrapped object (one row per webhook call)
// See normalizeClayPayloadToRows() below.
//
// ─── De-duplication — the genuinely hard part, per this feature's source
//     planning doc: NEVER silently merge on a fuzzy signal ─────────────
//
// Priority order, most confident first:
//   1. CIN (Corporate Identification Number) exact match, when the
//      incoming row has one and an existing contact's cin matches.
//   2. Email exact match (case-insensitive).
//   3. Company name match AFTER normalizing common suffixes ("Pvt Ltd",
//      "Private Limited", "Ltd", "LLP", "Inc", "Corp", ...) — exact after
//      normalization is treated as confident.
//   4. Anything short of that — partial/fuzzy company-name similarity, no
//      email or CIN to confirm — is NEVER auto-merged. It's created as a
//      brand-new contact with needsMatchReview=true and a clear
//      matchReviewReason, left for a human to resolve.
//   5. No signal at all → brand-new contact, sourceProvider='clay', filed
//      in the org's lowest-position OutreachStage ("Source").

import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { recordTouch } from './outreachTouchLog.js';

// ─── Payload validation ──────────────────────────────────────────────

const clayImportRowSchema = z
  .object({
    companyName: z.string().trim().min(1),
    contactName: z.string().trim().optional(),
    email: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    title: z.string().trim().optional(),
    linkedinUrl: z.string().trim().optional(),
    location: z.string().trim().optional(),
    employeeSize: z.union([z.string(), z.number()]).optional(),
    industry: z.string().trim().optional(),
    sourceUrl: z.string().trim().optional(),
    cin: z.string().trim().optional(),
  })
  .passthrough();

export type ClayImportRow = z.infer<typeof clayImportRowSchema>;

/**
 * Normalizes whatever shape Clay's webhook action actually sends into a
 * flat array of unvalidated row objects — see the module header for the
 * three accepted shapes. Returns [] for anything unrecognized; callers
 * treat that as "nothing to import", not an error.
 */
export function normalizeClayPayloadToRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;

  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.rows)) return obj.rows;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.records)) return obj.records;
    // A single un-wrapped row — Clay's webhook action can be configured to
    // fire once per row instead of batching.
    if ('companyName' in obj) return [obj];
  }

  return [];
}

// ─── Matching helpers ────────────────────────────────────────────────

const COMPANY_SUFFIX_RE =
  /\b(pvt\.?|private)\s+(ltd\.?|limited)\b|\b(ltd\.?|limited|llp|inc\.?|incorporated|corp\.?|corporation|co\.?|company|plc)\b/gi;

/** Lowercase, strip common company suffixes (Indian + generic), collapse punctuation/whitespace. */
function normalizeCompanyName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(COMPANY_SUFFIX_RE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeCin(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

function wordSet(s: string): Set<string> {
  return new Set(s.split(' ').filter(Boolean));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const unionSize = a.size + b.size - intersection;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

// Deliberately conservative: this is a heuristic, not a real fuzzy-match
// library (none is in this codebase's dependencies) — its only job is to
// decide "similar enough to warrant a human looking at it", never "similar
// enough to merge automatically". Word-overlap ratio, plus a floor for
// straight substring containment (e.g. "Acme" inside "Acme Technologies").
const AMBIGUOUS_SIMILARITY_THRESHOLD = 0.34;

function companyMatchScore(normalizedIncoming: string, normalizedExisting: string): number {
  if (!normalizedIncoming || !normalizedExisting) return 0;
  if (normalizedIncoming === normalizedExisting) return 1;
  const substring =
    normalizedIncoming.length >= 3 &&
    normalizedExisting.length >= 3 &&
    (normalizedIncoming.includes(normalizedExisting) || normalizedExisting.includes(normalizedIncoming));
  const jaccard = jaccardSimilarity(wordSet(normalizedIncoming), wordSet(normalizedExisting));
  return substring ? Math.max(jaccard, 0.5) : jaccard;
}

// ─── DB row shapes ───────────────────────────────────────────────────

interface ExistingContactRow {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  cin: string | null;
}

export interface ClayImportSummary {
  received: number;
  created: number;
  updated: number;
  flaggedForReview: number;
}

type RowOutcome = 'updated' | 'created' | 'created_flagged' | 'skipped';

// ─── Update path (CIN / email / confident company-name match) ────────

async function updateExistingContact(
  orgId: string,
  existingContact: ExistingContactRow,
  row: ClayImportRow,
  matchedBy: 'cin' | 'email' | 'company_name',
): Promise<void> {
  const { data: current, error: fetchError } = await supabase
    .from('OutreachContact')
    .select('*')
    .eq('id', existingContact.id)
    .eq('organizationId', orgId)
    .single();

  if (fetchError || !current) {
    log.error('outreachClayImport: could not load matched contact to update', fetchError, { contactId: existingContact.id });
    return;
  }

  // Fill-blank-only — same rule as the Enrich route
  // (routes/outreach.ts POST /contacts/:id/enrich): a re-import must never
  // clobber a human-edited field. `name` is NOT NULL on this table and
  // therefore never blank, so it's deliberately never touched here.
  const updates: Record<string, any> = {
    updatedAt: new Date().toISOString(),
    enrichmentData: {
      ...(current.enrichmentData || {}),
      clayImport: { importedAt: new Date().toISOString(), matchedBy, raw: row },
    },
  };
  if (row.email && !current.email) updates.email = row.email;
  if (row.phone && !current.phone) updates.phone = row.phone;
  if (row.title && !current.title) updates.title = row.title;
  if (row.linkedinUrl && !current.linkedinUrl) updates.linkedinUrl = row.linkedinUrl;
  if (row.cin && !current.cin) updates.cin = normalizeCin(row.cin);

  const { error: updateError } = await supabase
    .from('OutreachContact')
    .update(updates)
    .eq('id', existingContact.id)
    .eq('organizationId', orgId);

  if (updateError) {
    log.error('outreachClayImport: failed to update matched contact', updateError, { contactId: existingContact.id, matchedBy });
    return;
  }

  await recordTouch({
    organizationId: orgId,
    contactId: existingContact.id,
    channel: 'clay_import',
    type: 'reimported',
    direction: 'inbound',
    metadata: { matchedBy, companyName: row.companyName, sourceUrl: row.sourceUrl || null },
  });
}

// ─── Create path (no match, or ambiguous → flagged) ───────────────────

async function createNewContact(
  orgId: string,
  row: ClayImportRow,
  sourceStageId: string | null,
  matchReview: { needsMatchReview: boolean; matchReviewReason: string | null },
): Promise<ExistingContactRow | null> {
  if (!sourceStageId) {
    log.error('outreachClayImport: cannot create contact, no OutreachStage resolved for org', { companyName: row.companyName });
    return null;
  }

  const insertPayload = {
    organizationId: orgId,
    stageId: sourceStageId,
    name: row.contactName?.trim() || row.companyName.trim(),
    company: row.companyName,
    email: row.email || null,
    phone: row.phone || null,
    title: row.title || null,
    linkedinUrl: row.linkedinUrl || null,
    channel: 'proprietary' as const,
    sourceProvider: 'clay',
    needsMatchReview: matchReview.needsMatchReview,
    matchReviewReason: matchReview.matchReviewReason,
    cin: row.cin ? normalizeCin(row.cin) : null,
    enrichmentData: { clayImport: { importedAt: new Date().toISOString(), raw: row } },
  };

  const { data: created, error } = await supabase
    .from('OutreachContact')
    .insert(insertPayload)
    .select('id, name, company, email, cin')
    .single();

  if (error || !created) {
    log.error('outreachClayImport: failed to create new contact', error, { companyName: row.companyName });
    return null;
  }

  await recordTouch({
    organizationId: orgId,
    contactId: created.id,
    channel: 'clay_import',
    type: 'sourced',
    direction: 'inbound',
    metadata: {
      companyName: row.companyName,
      contactName: row.contactName || null,
      sourceUrl: row.sourceUrl || null,
      needsMatchReview: matchReview.needsMatchReview,
      matchReviewReason: matchReview.matchReviewReason,
    },
  });

  return created as ExistingContactRow;
}

// ─── Per-row dispatch ────────────────────────────────────────────────

async function matchAndUpsertRow(
  orgId: string,
  row: ClayImportRow,
  existing: ExistingContactRow[],
  sourceStageId: string | null,
): Promise<RowOutcome> {
  const normalizedIncomingCin = row.cin ? normalizeCin(row.cin) : null;
  const normalizedIncomingEmail = row.email ? row.email.trim().toLowerCase() : null;
  const normalizedIncomingCompany = normalizeCompanyName(row.companyName);

  if (normalizedIncomingCin) {
    const match = existing.find((c) => c.cin && normalizeCin(c.cin) === normalizedIncomingCin);
    if (match) {
      await updateExistingContact(orgId, match, row, 'cin');
      return 'updated';
    }
  }

  if (normalizedIncomingEmail) {
    const match = existing.find((c) => c.email && c.email.trim().toLowerCase() === normalizedIncomingEmail);
    if (match) {
      await updateExistingContact(orgId, match, row, 'email');
      return 'updated';
    }
  }

  let bestAmbiguous: ExistingContactRow | null = null;
  let bestScore = 0;
  for (const c of existing) {
    if (!c.company) continue;
    const normalizedExisting = normalizeCompanyName(c.company);
    const score = companyMatchScore(normalizedIncomingCompany, normalizedExisting);
    if (score >= 1) {
      await updateExistingContact(orgId, c, row, 'company_name');
      return 'updated';
    }
    if (score >= AMBIGUOUS_SIMILARITY_THRESHOLD && score > bestScore) {
      bestScore = score;
      bestAmbiguous = c;
    }
  }

  if (bestAmbiguous) {
    const created = await createNewContact(orgId, row, sourceStageId, {
      needsMatchReview: true,
      matchReviewReason: `Possible duplicate of existing contact "${bestAmbiguous.name}" (company "${bestAmbiguous.company}") — company name similar but not exact, no email or CIN to confirm.`,
    });
    if (created) {
      existing.push(created);
      return 'created_flagged';
    }
    return 'skipped';
  }

  const created = await createNewContact(orgId, row, sourceStageId, { needsMatchReview: false, matchReviewReason: null });
  if (created) {
    existing.push(created);
    return 'created';
  }
  return 'skipped';
}

// ─── Entry point ─────────────────────────────────────────────────────

/**
 * Processes one Clay webhook delivery's worth of rows against the given
 * org. Never throws — every per-row failure is caught, logged, and counted
 * as "received but not created/updated" so one bad row can't take down the
 * rest of the batch or bubble a 500 back to Clay.
 */
export async function processClayImportBatch(orgId: string, rawRows: unknown[]): Promise<ClayImportSummary> {
  const summary: ClayImportSummary = { received: rawRows.length, created: 0, updated: 0, flaggedForReview: 0 };
  if (rawRows.length === 0) return summary;

  const { data: existingContacts, error: existingError } = await supabase
    .from('OutreachContact')
    .select('id, name, company, email, cin')
    .eq('organizationId', orgId)
    .order('createdAt', { ascending: true });

  if (existingError) {
    // Can't dedupe safely without the existing set — abort the whole batch
    // rather than risk mass-duplicating contacts. Logged loudly since this
    // usually means the touch-log migration (which adds the `cin` column
    // this select reads) hasn't been applied yet — see
    // cicero-outreach-touch-log-migration.sql.
    log.error('outreachClayImport: failed to load existing contacts, aborting batch', existingError, { orgId });
    return summary;
  }

  const existing = (existingContacts || []) as ExistingContactRow[];

  const { data: stages, error: stageError } = await supabase
    .from('OutreachStage')
    .select('id')
    .eq('organizationId', orgId)
    .order('position', { ascending: true })
    .limit(1);

  if (stageError) {
    log.error('outreachClayImport: failed to load source stage', stageError, { orgId });
  }
  const sourceStageId: string | null = stages?.[0]?.id ?? null;
  if (!sourceStageId) {
    log.error('outreachClayImport: no OutreachStage found for org — new contacts cannot be created this run', { orgId });
  }

  for (const raw of rawRows) {
    try {
      const parsed = clayImportRowSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn('outreachClayImport: skipping row that failed validation', { issues: parsed.error.errors });
        continue;
      }

      const outcome = await matchAndUpsertRow(orgId, parsed.data, existing, sourceStageId);
      if (outcome === 'updated') summary.updated++;
      else if (outcome === 'created') summary.created++;
      else if (outcome === 'created_flagged') {
        summary.created++;
        summary.flaggedForReview++;
      }
    } catch (err) {
      log.error('outreachClayImport: unexpected error processing row', err);
    }
  }

  return summary;
}
