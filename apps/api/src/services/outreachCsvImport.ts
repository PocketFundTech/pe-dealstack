// ─── Shared CSV-import engine (column-mapping + Claude cleaning + de-dupe) ──
//
// Generalizes what was originally built as outreachPrivateCircleImport.ts —
// the actual per-source difference between a Private Circle CSV export and
// a Clay table CSV export is only the expected column headers. Everything
// after "map raw CSV headers to our row shape" (Claude cleaning pass,
// shared de-dupe/import engine, auto-enrichment eligibility) is identical.
//
// outreachPrivateCircleImport.ts and outreachClayCsvImport.ts are now thin
// wrappers around importContactsCsv() below, each supplying their own
// column-header map and sourceProvider/touchChannel — same pattern used to
// generalize outreachClayImport.ts into outreachContactImport.ts.

import { parseCSV } from './dealImportMapper.js';
import { log } from '../utils/logger.js';
import { isImportCleanerEnabled, cleanImportRows, type RawImportNameFields } from './outreachImportCleaner.js';
import { processContactImportBatch, type ContactImportResult, type ContactImportRow } from './outreachContactImport.js';

export type CsvMappedField =
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

export type CsvColumnMap = Record<CsvMappedField, string[]>;

export interface CsvImportOptions {
  sourceProvider: string;
  touchChannel: string;
  columnMap: CsvColumnMap;
  /** Used only in log messages, e.g. 'Private Circle', 'Clay'. */
  sourceLabel: string;
}

export interface CsvImportResult extends ContactImportResult {
  /** Rows in the CSV that had no resolvable company-name column and were dropped before de-dupe/import. */
  unmappable: number;
}

/** Lowercase + strip everything but letters/digits, so header matching survives
 *  punctuation/spacing/casing variance ("Company Name", "company_name", "COMPANY NAME"). */
function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildHeaderLookup(columnMap: CsvColumnMap): Map<string, CsvMappedField> {
  const lookup = new Map<string, CsvMappedField>();
  for (const [field, variants] of Object.entries(columnMap) as Array<[CsvMappedField, string[]]>) {
    for (const variant of variants) lookup.set(normalizeHeader(variant), field);
  }
  return lookup;
}

/**
 * Maps one raw CSV row (keyed by whatever headers the source's export
 * actually used) into the shared engine's row shape. Returns null when no
 * companyName could be resolved — companyName is required downstream.
 */
export function mapCsvRow(raw: Record<string, string>, headerLookup: Map<string, CsvMappedField>): Record<string, string> | null {
  const mapped: Record<string, string> = {};

  for (const [header, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    const trimmed = String(value).trim();
    if (!trimmed) continue;

    const field = headerLookup.get(normalizeHeader(header));
    if (!field) continue;
    // First non-empty column wins if two header variants somehow both
    // matched the same field in one row.
    if (!mapped[field]) mapped[field] = trimmed;
  }

  if (!mapped.companyName) return null;
  return mapped;
}

/**
 * Full pipeline for one uploaded CSV: parse -> map columns -> clean via
 * Claude (soft-fails to deterministic-only if Claude isn't configured) ->
 * run through the shared de-dupe/import engine. Never throws — CSV parse
 * failures are the one exception, since an unparsable file has nothing safe
 * to fall back to; the caller's route handles that.
 */
export async function importContactsCsv(orgId: string, csvText: string, options: CsvImportOptions): Promise<CsvImportResult> {
  const headerLookup = buildHeaderLookup(options.columnMap);
  const parsedRows = parseCSV(csvText);

  const mappedRows: Record<string, string>[] = [];
  let unmappable = 0;
  for (const raw of parsedRows) {
    const mapped = mapCsvRow(raw, headerLookup);
    if (!mapped) {
      unmappable++;
      continue;
    }
    mappedRows.push(mapped);
  }

  if (mappedRows.length === 0) {
    log.warn(`outreachCsvImport (${options.sourceLabel}): no rows had a resolvable company-name column`, { totalRows: parsedRows.length });
    return { received: parsedRows.length, created: 0, updated: 0, flaggedForReview: 0, createdContactIdsMissingEmail: [], unmappable };
  }

  // Claude cleaning pass — same as before generalization: company-name
  // canonicalization + contact-name split, soft-fails to deterministic-only
  // normalization if Claude isn't configured.
  let cleaned = new Map<number, { company: string | null; firstName: string | null; lastName: string | null }>();
  if (isImportCleanerEnabled()) {
    const cleanerInput: RawImportNameFields[] = mappedRows.map((row, index) => ({
      index,
      companyName: row.companyName,
      contactName: row.contactName || null,
    }));
    cleaned = await cleanImportRows(cleanerInput);
  } else {
    log.info(`outreachCsvImport (${options.sourceLabel}): Claude cleaning skipped — ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN not set`);
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
    sourceProvider: options.sourceProvider,
    touchChannel: options.touchChannel,
  });

  return { ...result, received: parsedRows.length, unmappable };
}
