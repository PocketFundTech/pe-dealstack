// ─── Shared contact-import engine (provider-agnostic) ────────────────
//
// De-dupe/match/create/update logic shared by every bulk contact-sourcing
// path on the Outreach board. Originally built as outreachClayImport.ts for
// the Clay inbound webhook; generalized here once a second source (Private
// Circle's manual CSV export, see outreachPrivateCircleImport.ts) needed
// the exact same de-dupe behaviour. Nothing about matching/create/update
// below is provider-specific — the only per-source knobs are threaded
// through as `ContactImportOptions`:
//   - sourceProvider: stored on newly-created OutreachContact rows
//     (OutreachContact.sourceProvider) and recorded inside enrichmentData.
//   - touchChannel: the `channel` value written to every OutreachTouch row
//     this batch produces (services/outreachTouchLog.ts).
//
// outreachClayImport.ts is now a thin wrapper around processContactImportBatch
// below (sourceProvider: 'clay', touchChannel: 'clay_import') so the
// existing Clay webhook route (routes/outreach-clay-import-webhook.ts)
// keeps working completely unchanged. outreachPrivateCircleImport.ts calls
// this module directly with sourceProvider: 'private_circle',
// touchChannel: 'private_circle_import'.
//
// ─── Row shape (OUR contract — see each provider's own module for how its
//     raw input gets mapped into this shape before it reaches this file) ──
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
//     "sourceUrl": "https://...",                    // source record link
//     "cin": "U72200MH2015PTC262812"                 // optional, most reliable de-dupe key
//   }
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
//   5. No signal at all → brand-new contact, sourceProvider=<options.sourceProvider>,
//      filed in the org's lowest-position OutreachStage ("Source").

import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { recordTouch } from './outreachTouchLog.js';

// ─── Row validation ──────────────────────────────────────────────────

export const contactImportRowSchema = z
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

export type ContactImportRow = z.infer<typeof contactImportRowSchema>;

// ─── Matching helpers ────────────────────────────────────────────────

const COMPANY_SUFFIX_RE =
  /\b(pvt\.?|private)\s+(ltd\.?|limited)\b|\b(ltd\.?|limited|llp|inc\.?|incorporated|corp\.?|corporation|co\.?|company|plc)\b/gi;

/** Lowercase, strip common company suffixes (Indian + generic), collapse punctuation/whitespace. */
export function normalizeCompanyName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(COMPANY_SUFFIX_RE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeCin(raw: string): string {
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

export interface ContactImportSummary {
  received: number;
  created: number;
  updated: number;
  flaggedForReview: number;
}

export interface ContactImportResult extends ContactImportSummary {
  /**
   * ids of contacts created THIS run that are neither updates nor
   * flagged-for-review, and had no email in the imported row — exactly the
   * population Part 3's auto-enrichment trigger targets. Populated
   * regardless of caller; callers that don't need it (the Clay webhook
   * route) simply don't read it, so its presence doesn't change that
   * route's documented `{received, created, updated, flaggedForReview}`
   * response shape.
   */
  createdContactIdsMissingEmail: string[];
}

/** Per-source knobs — see module header. */
export interface ContactImportOptions {
  /** Stored on new contacts as OutreachContact.sourceProvider, e.g. 'clay' | 'private_circle'. */
  sourceProvider: string;
  /** OutreachTouch.channel for every touch this batch records, e.g. 'clay_import' | 'private_circle_import'. */
  touchChannel: string;
}

type RowOutcome = 'updated' | 'created' | 'created_flagged' | 'skipped';

// ─── Update path (CIN / email / confident company-name match) ────────

async function updateExistingContact(
  orgId: string,
  existingContact: ExistingContactRow,
  row: ContactImportRow,
  matchedBy: 'cin' | 'email' | 'company_name',
  options: ContactImportOptions,
): Promise<void> {
  const { data: current, error: fetchError } = await supabase
    .from('OutreachContact')
    .select('*')
    .eq('id', existingContact.id)
    .eq('organizationId', orgId)
    .single();

  if (fetchError || !current) {
    log.error('outreachContactImport: could not load matched contact to update', fetchError, { contactId: existingContact.id });
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
      import: { provider: options.sourceProvider, importedAt: new Date().toISOString(), matchedBy, raw: row },
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
    log.error('outreachContactImport: failed to update matched contact', updateError, { contactId: existingContact.id, matchedBy });
    return;
  }

  await recordTouch({
    organizationId: orgId,
    contactId: existingContact.id,
    channel: options.touchChannel,
    type: 'reimported',
    direction: 'inbound',
    metadata: { matchedBy, companyName: row.companyName, sourceUrl: row.sourceUrl || null },
  });
}

// ─── Create path (no match, or ambiguous → flagged) ───────────────────

async function createNewContact(
  orgId: string,
  row: ContactImportRow,
  sourceStageId: string | null,
  matchReview: { needsMatchReview: boolean; matchReviewReason: string | null },
  options: ContactImportOptions,
): Promise<ExistingContactRow | null> {
  if (!sourceStageId) {
    log.error('outreachContactImport: cannot create contact, no OutreachStage resolved for org', { companyName: row.companyName });
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
    sourceProvider: options.sourceProvider,
    needsMatchReview: matchReview.needsMatchReview,
    matchReviewReason: matchReview.matchReviewReason,
    cin: row.cin ? normalizeCin(row.cin) : null,
    enrichmentData: { import: { provider: options.sourceProvider, importedAt: new Date().toISOString(), raw: row } },
  };

  const { data: created, error } = await supabase
    .from('OutreachContact')
    .insert(insertPayload)
    .select('id, name, company, email, cin')
    .single();

  if (error || !created) {
    log.error('outreachContactImport: failed to create new contact', error, { companyName: row.companyName });
    return null;
  }

  await recordTouch({
    organizationId: orgId,
    contactId: created.id,
    channel: options.touchChannel,
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
  row: ContactImportRow,
  existing: ExistingContactRow[],
  sourceStageId: string | null,
  options: ContactImportOptions,
): Promise<{ outcome: RowOutcome; createdId: string | null }> {
  const normalizedIncomingCin = row.cin ? normalizeCin(row.cin) : null;
  const normalizedIncomingEmail = row.email ? row.email.trim().toLowerCase() : null;
  const normalizedIncomingCompany = normalizeCompanyName(row.companyName);

  if (normalizedIncomingCin) {
    const match = existing.find((c) => c.cin && normalizeCin(c.cin) === normalizedIncomingCin);
    if (match) {
      await updateExistingContact(orgId, match, row, 'cin', options);
      return { outcome: 'updated', createdId: null };
    }
  }

  if (normalizedIncomingEmail) {
    const match = existing.find((c) => c.email && c.email.trim().toLowerCase() === normalizedIncomingEmail);
    if (match) {
      await updateExistingContact(orgId, match, row, 'email', options);
      return { outcome: 'updated', createdId: null };
    }
  }

  let bestAmbiguous: ExistingContactRow | null = null;
  let bestScore = 0;
  for (const c of existing) {
    if (!c.company) continue;
    const normalizedExisting = normalizeCompanyName(c.company);
    const score = companyMatchScore(normalizedIncomingCompany, normalizedExisting);
    if (score >= 1) {
      await updateExistingContact(orgId, c, row, 'company_name', options);
      return { outcome: 'updated', createdId: null };
    }
    if (score >= AMBIGUOUS_SIMILARITY_THRESHOLD && score > bestScore) {
      bestScore = score;
      bestAmbiguous = c;
    }
  }

  if (bestAmbiguous) {
    const created = await createNewContact(
      orgId,
      row,
      sourceStageId,
      {
        needsMatchReview: true,
        matchReviewReason: `Possible duplicate of existing contact "${bestAmbiguous.name}" (company "${bestAmbiguous.company}") — company name similar but not exact, no email or CIN to confirm.`,
      },
      options,
    );
    if (created) {
      existing.push(created);
      return { outcome: 'created_flagged', createdId: created.id };
    }
    return { outcome: 'skipped', createdId: null };
  }

  const created = await createNewContact(orgId, row, sourceStageId, { needsMatchReview: false, matchReviewReason: null }, options);
  if (created) {
    existing.push(created);
    return { outcome: 'created', createdId: created.id };
  }
  return { outcome: 'skipped', createdId: null };
}

// ─── Entry point ─────────────────────────────────────────────────────

/**
 * Processes one batch of rows against the given org, using the shared
 * de-dupe/match/create/update logic described in this module's header.
 * Never throws — every per-row failure is caught, logged, and counted as
 * "received but not created/updated" so one bad row can't take down the
 * rest of the batch or bubble a 500 back to the caller.
 */
export async function processContactImportBatch(
  orgId: string,
  rawRows: unknown[],
  options: ContactImportOptions,
): Promise<ContactImportResult> {
  const result: ContactImportResult = {
    received: rawRows.length,
    created: 0,
    updated: 0,
    flaggedForReview: 0,
    createdContactIdsMissingEmail: [],
  };
  if (rawRows.length === 0) return result;

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
    log.error('outreachContactImport: failed to load existing contacts, aborting batch', existingError, { orgId, sourceProvider: options.sourceProvider });
    return result;
  }

  const existing = (existingContacts || []) as ExistingContactRow[];

  const { data: stages, error: stageError } = await supabase
    .from('OutreachStage')
    .select('id')
    .eq('organizationId', orgId)
    .order('position', { ascending: true })
    .limit(1);

  if (stageError) {
    log.error('outreachContactImport: failed to load source stage', stageError, { orgId });
  }
  const sourceStageId: string | null = stages?.[0]?.id ?? null;
  if (!sourceStageId) {
    log.error('outreachContactImport: no OutreachStage found for org — new contacts cannot be created this run', { orgId });
  }

  for (const raw of rawRows) {
    try {
      const parsed = contactImportRowSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn('outreachContactImport: skipping row that failed validation', { issues: parsed.error.errors });
        continue;
      }

      const { outcome, createdId } = await matchAndUpsertRow(orgId, parsed.data, existing, sourceStageId, options);
      if (outcome === 'updated') {
        result.updated++;
      } else if (outcome === 'created') {
        result.created++;
        if (createdId && !parsed.data.email) result.createdContactIdsMissingEmail.push(createdId);
      } else if (outcome === 'created_flagged') {
        result.created++;
        result.flaggedForReview++;
        // Flagged-for-review contacts are deliberately excluded from
        // createdContactIdsMissingEmail — Part 3's auto-enrichment trigger
        // only targets clean creates, never rows a human still has to
        // resolve first.
      }
    } catch (err) {
      log.error('outreachContactImport: unexpected error processing row', err, { sourceProvider: options.sourceProvider });
    }
  }

  return result;
}
