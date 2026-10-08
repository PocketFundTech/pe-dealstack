/**
 * Find the live deal an upload already belongs to (5 Oct testing, item 8:
 * "three records of the same deal when documents to update it were
 * uploaded"). Ingest without a target deal ALWAYS created a new Deal, and
 * the Company lookup used .single(), which errors once two companies share
 * a name — so duplicates compounded.
 *
 * Match = same org, not deleted, and the company or deal name equal after
 * normalising case, punctuation and legal suffixes ("Acme, Inc." = "ACME inc").
 * The same rule Outlook auto-create already follows.
 */

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';

const LEGAL_SUFFIXES = /\b(incorporated|inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|sa|ag|bv|pvt|private|holdings?|group|lp|llp)\b/g;

export function normaliseCompanyName(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DealMatch { id: string; name: string }

/** The most recently updated live deal for this company in the org, or null. */
export async function findLiveDealForCompany(orgId: string, companyName: string | null | undefined): Promise<DealMatch | null> {
  const key = normaliseCompanyName(companyName);
  // Too short to be a safe identity ("AB", "Co").
  if (key.length < 3) return null;
  try {
    const { data, error } = await supabase
      .from('Deal')
      .select('id, name, updatedAt, company:Company(name)')
      .eq('organizationId', orgId)
      .is('deletedAt', null)
      .order('updatedAt', { ascending: false })
      .limit(500);
    if (error) {
      log.warn('findLiveDealForCompany: lookup failed', { error: error.message });
      return null;
    }
    for (const d of (data ?? []) as Array<{ id: string; name: string; company?: { name?: string | null } | Array<{ name?: string | null }> | null }>) {
      const company = Array.isArray(d.company) ? d.company[0] : d.company;
      if (normaliseCompanyName(company?.name) === key || normaliseCompanyName(d.name) === key) {
        return { id: d.id, name: d.name };
      }
    }
    return null;
  } catch (err) {
    log.warn('findLiveDealForCompany: unexpected error', { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

const INDEX_PAGE = 1000;
const INDEX_MAX_PAGES = 10;

/**
 * Every live deal in the org keyed by normalised company name AND deal name,
 * for batch paths (bulk import) that would otherwise look up row by row.
 * The most recently updated deal wins a key. Empty on lookup failure, so a
 * failed lookup never blocks an import — it just skips the duplicate check.
 * `unlinkedOnly` keeps only deals no HubSpot record owns yet (hubspotId null),
 * for the HubSpot import, which must never re-link a deal another HubSpot
 * deal already claimed.
 */
export async function loadLiveDealIndex(
  orgId: string,
  opts: { unlinkedOnly?: boolean } = {},
): Promise<Map<string, DealMatch>> {
  const index = new Map<string, DealMatch>();
  try {
    for (let page = 0; page < INDEX_MAX_PAGES; page++) {
      const from = page * INDEX_PAGE;
      let query = supabase
        .from('Deal')
        .select('id, name, updatedAt, company:Company(name)')
        .eq('organizationId', orgId)
        .is('deletedAt', null);
      if (opts.unlinkedOnly) query = query.is('hubspotId', null);
      const { data, error } = await query
        .order('updatedAt', { ascending: false })
        .range(from, from + INDEX_PAGE - 1);
      if (error) {
        log.warn('loadLiveDealIndex: lookup failed', { error: error.message });
        return index;
      }
      const rows = (data ?? []) as Array<{ id: string; name: string; company?: { name?: string | null } | Array<{ name?: string | null }> | null }>;
      for (const d of rows) {
        const company = Array.isArray(d.company) ? d.company[0] : d.company;
        for (const key of [normaliseCompanyName(company?.name), normaliseCompanyName(d.name)]) {
          if (key.length >= 3 && !index.has(key)) index.set(key, { id: d.id, name: d.name });
        }
      }
      if (rows.length < INDEX_PAGE) break;
    }
  } catch (err) {
    log.warn('loadLiveDealIndex: unexpected error', { err: err instanceof Error ? err.message : String(err) });
  }
  return index;
}
