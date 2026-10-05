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
