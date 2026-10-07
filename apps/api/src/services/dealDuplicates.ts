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

// ─── Fuzzy duplicate candidates (ask, never auto-merge) ─────────────────────
//
// Testers kept getting a second deal for the same company because the
// document named it differently ("CSP" vs "Community Solar Platform
// Holdings"). Exact matching (above) can't see that. The rules below find
// LIKELY matches so the interactive intake flows can ASK the user before
// creating anything. They are never used to merge on their own.

/** Words that never identify a company on their own. */
const STOPWORDS = new Set(['and', 'the', 'of', 'for', 'a', 'an', 'at', 'in', 'on', 'by', 'to']);

/**
 * Words about a firm's structure, not its identity. Two names that differ
 * only in these are likely the same company ("Acme Partners" / "Acme
 * Capital"), but they never make a match on their own ("Summit Partners" vs
 * "Apex Partners").
 */
const STRUCTURAL_WORDS = new Set([
  'capital', 'partners', 'partner', 'group', 'groups', 'holdings', 'holding', 'solutions', 'solution',
  'services', 'service', 'technologies', 'technology', 'tech', 'systems', 'system', 'industries', 'industry',
  'international', 'global', 'enterprises', 'enterprise', 'ventures', 'venture', 'management', 'consulting',
  'investments', 'investment', 'advisors', 'advisers', 'advisory', 'associates', 'company', 'companies',
  'corporation', 'corp', 'fund', 'funds', 'equity', 'business', 'businesses', 'operations', 'acquisition',
  'acquisitions', 'platform', 'platforms', 'co', 'inc', 'llc', 'ltd',
]);

/**
 * Industry / geography words. Common across unrelated companies, so they
 * can't carry a match alone ("American Tower" vs "American Airlines"), but
 * unlike structural words they DO tell companies apart ("Summit Health" is
 * not "Summit Partners").
 */
const DESCRIPTIVE_WORDS = new Set([
  'financial', 'finance', 'healthcare', 'health', 'medical', 'energy', 'software', 'data', 'digital', 'products',
  'product', 'manufacturing', 'logistics', 'logistic', 'brands', 'brand', 'networks', 'network', 'labs', 'lab',
  'media', 'resources', 'resource', 'properties', 'property', 'realty', 'real', 'estate', 'trust', 'bank',
  'insurance', 'retail', 'foods', 'food', 'care', 'america', 'americas', 'american', 'national', 'usa', 'us', 'uk',
  'north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western', 'first', 'new', 'united',
  'general', 'pacific', 'atlantic', 'solar',
]);

function tokens(name: string | null | undefined): string[] {
  const norm = normaliseCompanyName(name);
  if (!norm) return [];
  const toks = norm.split(' ').filter((t) => t && !STOPWORDS.has(t));
  // "C.S.P." normalises to "c s p" — read it as one acronym token.
  if (toks.length > 1 && toks.every((t) => t.length === 1)) return [toks.join('')];
  return toks;
}

function isGeneric(token: string): boolean {
  return STRUCTURAL_WORDS.has(token) || DESCRIPTIVE_WORDS.has(token) || /^\d+$/.test(token);
}

/** Jaro-Winkler similarity, 0..1. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(b.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!bMatched[j] && a[i] === b[j]) {
        aMatched[i] = bMatched[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** `short` (one 3–6 letter token) is the initials of `long`'s words. */
function isAcronymOf(short: string[], longToks: string[], longName: string | null | undefined): boolean {
  if (short.length !== 1) return false;
  const acr = short[0];
  if (acr.length < 3 || acr.length > 6 || !/^\p{L}+$/u.test(acr)) return false;
  const initials = (ts: string[]) => ts.map((t) => t[0]).join('');
  if (longToks.length === acr.length && initials(longToks) === acr) return true;
  // With stopwords kept ("Bank of America" → "boa"), and with suffixes kept
  // ("American Broadcasting Company" → "abc").
  const withStops = normaliseCompanyName(longName).split(' ').filter(Boolean);
  const raw = (longName ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  return [withStops, raw].some((ts) => ts.length >= acr.length && initials(ts) === acr);
}

/** Shorter token list is a strict prefix of the longer, on a distinctive word. */
function isDistinctivePrefix(a: string[], b: string[]): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!short.length || short.length === long.length) return false;
  for (let i = 0; i < short.length; i++) if (short[i] !== long[i]) return false;
  return short.join(' ').length >= 4 && short.some((t) => !isGeneric(t));
}

/** Same distinctive words with only typo-level differences on long words. */
function isFuzzyTokenMatch(coreA: string[], coreB: string[]): boolean {
  if (!coreA.length || coreA.length !== coreB.length) return false;
  if (coreA.join('').length < 5) return false;
  const used = new Array<boolean>(coreB.length).fill(false);
  for (const t of coreA) {
    let found = -1;
    for (let j = 0; j < coreB.length; j++) {
      if (used[j]) continue;
      const u = coreB[j];
      if (t === u || (t.length >= 7 && u.length >= 7 && jaroWinkler(t, u) >= 0.92)) { found = j; break; }
    }
    if (found < 0) return false;
    used[found] = true;
  }
  return true;
}

export type DuplicateReason = 'exact' | 'similar';

/**
 * How alike two company names are: 'exact' (equal after normalising case,
 * punctuation and legal suffixes — the auto-merge rule), 'similar' (likely
 * the same company: acronym, name + extra words, same distinctive words in
 * another order, spacing or a typo) or null. Pure — no I/O.
 */
export function scoreCompanyNameMatch(a: string | null | undefined, b: string | null | undefined): DuplicateReason | null {
  const normA = normaliseCompanyName(a);
  const normB = normaliseCompanyName(b);
  if (normA.length < 2 || normB.length < 2) return null;
  if (normA === normB) return normA.length >= 3 ? 'exact' : null;

  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return null;
  if (ta.join(' ') === tb.join(' ') && ta.join(' ').length >= 3) return 'similar'; // differ only by stopwords

  if (isAcronymOf(ta, tb, b) || isAcronymOf(tb, ta, a)) return 'similar';
  if (isDistinctivePrefix(ta, tb)) return 'similar';

  // "NorthWind" vs "North Wind".
  const joinedA = ta.join('');
  const joinedB = tb.join('');
  if (joinedA === joinedB && joinedA.length >= 5) return 'similar';

  // Identity words: structural padding dropped, industry words kept. At
  // least one must be fully distinctive.
  const coreA = ta.filter((t) => !STRUCTURAL_WORDS.has(t));
  const coreB = tb.filter((t) => !STRUCTURAL_WORDS.has(t));
  if (!coreA.some((t) => !isGeneric(t)) || !coreB.some((t) => !isGeneric(t))) return null;
  const sortedA = [...coreA].sort().join(' ');
  const sortedB = [...coreB].sort().join(' ');
  // Same distinctive words, any order / generic padding ("Acme Partners" vs "Acme Capital").
  if (sortedA === sortedB && sortedA.replace(/ /g, '').length >= 4) return 'similar';
  if (isFuzzyTokenMatch(coreA, coreB)) return 'similar';
  return null;
}

export interface DuplicateCandidate {
  id: string;
  name: string;
  companyName: string | null;
  reason: DuplicateReason;
}

type DealRow = { id: string; name: string; company?: { name?: string | null } | Array<{ name?: string | null }> | null };

/**
 * Rank live deals against a company name. Exact matches first, then similar;
 * within each, the input order (most recently updated first). Pure.
 */
export function rankDuplicateCandidates(companyName: string | null | undefined, deals: DealRow[], max = 3): DuplicateCandidate[] {
  const exact: DuplicateCandidate[] = [];
  const similar: DuplicateCandidate[] = [];
  for (const d of deals) {
    const company = Array.isArray(d.company) ? d.company[0] : d.company;
    const companyNameOfDeal = company?.name ?? null;
    const scores = [scoreCompanyNameMatch(companyName, companyNameOfDeal), scoreCompanyNameMatch(companyName, d.name)];
    const reason: DuplicateReason | null = scores.includes('exact') ? 'exact' : scores.includes('similar') ? 'similar' : null;
    if (!reason) continue;
    (reason === 'exact' ? exact : similar).push({ id: d.id, name: d.name, companyName: companyNameOfDeal, reason });
  }
  return [...exact, ...similar].slice(0, max);
}

/**
 * Up to `max` live deals in the org that look like the same company — for
 * the interactive intake flows to ASK about. Empty on lookup failure (never
 * blocks an upload).
 */
export async function findDuplicateCandidates(orgId: string, companyName: string | null | undefined, max = 3): Promise<DuplicateCandidate[]> {
  if (normaliseCompanyName(companyName).length < 2) return [];
  try {
    const { data, error } = await supabase
      .from('Deal')
      .select('id, name, updatedAt, company:Company(name)')
      .eq('organizationId', orgId)
      .is('deletedAt', null)
      .order('updatedAt', { ascending: false })
      .limit(500);
    if (error) {
      log.warn('findDuplicateCandidates: lookup failed', { error: error.message });
      return [];
    }
    return rankDuplicateCandidates(companyName, (data ?? []) as DealRow[], max);
  } catch (err) {
    log.warn('findDuplicateCandidates: unexpected error', { err: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

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
 */
export async function loadLiveDealIndex(orgId: string): Promise<Map<string, DealMatch>> {
  const index = new Map<string, DealMatch>();
  try {
    for (let page = 0; page < INDEX_MAX_PAGES; page++) {
      const from = page * INDEX_PAGE;
      const { data, error } = await supabase
        .from('Deal')
        .select('id, name, updatedAt, company:Company(name)')
        .eq('organizationId', orgId)
        .is('deletedAt', null)
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
