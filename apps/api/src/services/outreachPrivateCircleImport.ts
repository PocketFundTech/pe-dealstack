// ─── Private Circle CSV import — column mapping + orchestration ──────
//
// Private Circle has no API yet (enterprise access request still pending)
// and its own CSV export caps out around 100-200 rows. Per this feature's
// source planning doc, the current process is: a human sources/filters
// inside Private Circle's own UI (that stays human-driven — this module
// does NOT touch sourcing), exports a CSV, then today retypes the rows
// into Reply.io by hand. This module — plumbed in from
// routes/outreach-private-circle-import.ts — automates exactly that
// retyping step: parse the CSV → map its columns → clean via Claude
// (services/outreachImportCleaner.ts) → de-dupe/import via the shared
// engine (services/outreachContactImport.ts, sourceProvider:
// 'private_circle', touchChannel: 'private_circle_import').
//
// ─── Expected CSV column mapping (OUR contract — NOT a confirmed Private
//     Circle export field dictionary; no real PC export sample was
//     available while building this) ──────────────────────────────────
//
// Header matching is case/whitespace/punctuation-insensitive (see
// normalizeHeader()) and accepts any of a small set of plausible variants
// per field, listed below. Whoever runs the FIRST real Private Circle
// import should compare PC's actual column headers against this list and
// extend PRIVATE_CIRCLE_COLUMN_MAP if they don't match — the header
// variants here are a best guess at Private Circle's likely export
// wording, not a verified spec.
//
//   Row field      Accepted header variants (normalized)
//   -----------    --------------------------------------------------
//   companyName    Company Name, Company, Organisation Name,
//                  Organization Name                          (required)
//   cin            CIN, Corporate Identification Number
//   contactName    Decision Maker, Decision Maker Name, Contact Name,
//                  Contact Person, Key Contact, Point Of Contact
//   title          Designation, Title, Role, Job Title
//   email          Email, Email Address, Decision Maker Email
//   phone          Phone, Phone Number, Mobile, Contact Number
//   linkedinUrl    LinkedIn, LinkedIn URL, LinkedIn Profile
//   location       Location, City, Address, HQ Location
//   employeeSize   Employee Count, Company Size, Employees, Headcount
//   industry       Industry, Sector
//   sourceUrl      Profile URL, Source URL, Private Circle URL,
//                  Record URL
//
// A row with no resolvable companyName is dropped before it reaches the
// cleaner/import engine (companyName is required by
// outreachContactImport.ts's row schema) and counted as "received" but not
// created/updated/flagged, same as any other row that fails validation.

import { parseCSV } from './dealImportMapper.js';
import { log } from '../utils/logger.js';
import { isImportCleanerEnabled, cleanImportRows, type RawImportNameFields } from './outreachImportCleaner.js';
import { processContactImportBatch, type ContactImportResult, type ContactImportRow } from './outreachContactImport.js';

const PRIVATE_CIRCLE_SOURCE_PROVIDER = 'private_circle';
const PRIVATE_CIRCLE_TOUCH_CHANNEL = 'private_circle_import';

// ─── Column mapping ────────────────────────────────────────────────────

type MappedField =
  | 'companyName'
  | 'cin'
  | 'contactName'
  | 'title'
  | 'email'
  | 'phone'
  | 'linkedinUrl'
  | 'location'
  | 'employeeSize'
  | 'industry'
  | 'sourceUrl';

const PRIVATE_CIRCLE_COLUMN_MAP: Record<MappedField, string[]> = {
  companyName: ['Company Name', 'Company', 'Organisation Name', 'Organization Name'],
  cin: ['CIN', 'Corporate Identification Number'],
  contactName: ['Decision Maker', 'Decision Maker Name', 'Contact Name', 'Contact Person', 'Key Contact', 'Point Of Contact'],
  title: ['Designation', 'Title', 'Role', 'Job Title'],
  email: ['Email', 'Email Address', 'Decision Maker Email'],
  phone: ['Phone', 'Phone Number', 'Mobile', 'Contact Number'],
  linkedinUrl: ['LinkedIn', 'LinkedIn URL', 'LinkedIn Profile'],
  location: ['Location', 'City', 'Address', 'HQ Location'],
  employeeSize: ['Employee Count', 'Company Size', 'Employees', 'Headcount'],
  industry: ['Industry', 'Sector'],
  sourceUrl: ['Profile URL', 'Source URL', 'Private Circle URL', 'Record URL'],
};

/** Lowercase + strip everything but letters/digits, so header matching survives
 *  punctuation/spacing/casing variance ("Company Name", "company_name", "COMPANY NAME"). */
function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Built once at module load: normalizedVariant -> canonical row field.
const HEADER_LOOKUP: Map<string, MappedField> = new Map();
for (const [field, variants] of Object.entries(PRIVATE_CIRCLE_COLUMN_MAP) as Array<[MappedField, string[]]>) {
  for (const variant of variants) HEADER_LOOKUP.set(normalizeHeader(variant), field);
}

/**
 * Maps one raw CSV row (keyed by whatever headers Private Circle's export
 * actually used) into the shared engine's row shape. Returns null when no
 * companyName could be resolved — companyName is required downstream.
 */
export function mapPrivateCircleRow(raw: Record<string, string>): Record<string, string> | null {
  const mapped: Record<string, string> = {};

  for (const [header, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    const trimmed = String(value).trim();
    if (!trimmed) continue;

    const field = HEADER_LOOKUP.get(normalizeHeader(header));
    if (!field) continue;
    // First non-empty column wins if two header variants somehow both
    // matched the same field in one row (shouldn't happen with a
    // well-formed export, but don't let a later blank column clobber an
    // earlier match).
    if (!mapped[field]) mapped[field] = trimmed;
  }

  if (!mapped.companyName) return null;
  return mapped;
}

// ─── Orchestration ────────────────────────────────────────────────────

export interface PrivateCircleImportResult extends ContactImportResult {
  /** Rows in the CSV that had no resolvable company-name column and were dropped before de-dupe/import. */
  unmappable: number;
}

/**
 * Full pipeline for one uploaded Private Circle CSV: parse → map columns →
 * clean via Claude (soft-fails to deterministic-only if Claude isn't
 * configured) → run through the shared de-dupe/import engine. Never
 * throws — CSV parse failures are the one exception, since an unparsable
 * file has nothing safe to fall back to; the route catches that.
 */
export async function importPrivateCircleCsv(orgId: string, csvText: string): Promise<PrivateCircleImportResult> {
  const parsedRows = parseCSV(csvText);

  const mappedRows: Record<string, string>[] = [];
  let unmappable = 0;
  for (const raw of parsedRows) {
    const mapped = mapPrivateCircleRow(raw);
    if (!mapped) {
      unmappable++;
      continue;
    }
    mappedRows.push(mapped);
  }

  if (mappedRows.length === 0) {
    log.warn('outreachPrivateCircleImport: no rows had a resolvable company-name column', { totalRows: parsedRows.length });
    return { received: parsedRows.length, created: 0, updated: 0, flaggedForReview: 0, createdContactIdsMissingEmail: [], unmappable };
  }

  // ─── Claude cleaning pass — company-name canonicalization + contact-name
  // split. Soft-fail: if Claude isn't configured, skip straight to the
  // shared engine with only the deterministic normalization it already
  // does internally for matching. A row's cleaned value is used only when
  // the cleaner actually returned one for that index; every other field on
  // the row is untouched either way.
  let cleaned = new Map<number, { company: string | null; firstName: string | null; lastName: string | null }>();
  if (isImportCleanerEnabled()) {
    const cleanerInput: RawImportNameFields[] = mappedRows.map((row, index) => ({
      index,
      companyName: row.companyName,
      contactName: row.contactName || null,
    }));
    cleaned = await cleanImportRows(cleanerInput);
  } else {
    log.info('outreachPrivateCircleImport: Claude cleaning skipped — ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN not set, importing with deterministic normalization only');
  }

  const engineRows: ContactImportRow[] = mappedRows.map((row, index) => {
    const cleanedRow = cleaned.get(index);
    const company = cleanedRow?.company || row.companyName;
    const cleanedContactName =
      cleanedRow && (cleanedRow.firstName || cleanedRow.lastName)
        ? [cleanedRow.firstName, cleanedRow.lastName].filter(Boolean).join(' ')
        : null;

    return {
      companyName: company,
      contactName: cleanedContactName || row.contactName || undefined,
      email: row.email || undefined,
      phone: row.phone || undefined,
      title: row.title || undefined,
      linkedinUrl: row.linkedinUrl || undefined,
      location: row.location || undefined,
      employeeSize: row.employeeSize || undefined,
      industry: row.industry || undefined,
      sourceUrl: row.sourceUrl || undefined,
      cin: row.cin || undefined,
    };
  });

  const result = await processContactImportBatch(orgId, engineRows, {
    sourceProvider: PRIVATE_CIRCLE_SOURCE_PROVIDER,
    touchChannel: PRIVATE_CIRCLE_TOUCH_CHANNEL,
  });

  // received should reflect the whole uploaded CSV, not just the mappable
  // subset that reached the engine, so the response accounts for every row
  // in the file (mirrors createContact's dropped-row accounting).
  return { ...result, received: parsedRows.length, unmappable };
}
