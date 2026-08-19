// ─── Contact Enrichment Agent — Pure Helpers ─────────────────────
// Email-domain analysis, company-website scrape, LinkedIn URL builder.
// No LLM / DB calls here — keeps the node logic testable.

import { log } from '../../../utils/logger.js';
import { PERSONAL_DOMAINS } from './state.js';

export function analyzeEmailDomain(email: string | null): Record<string, any> {
  if (!email || !email.includes('@')) {
    return { isPersonal: null, domain: null, companyFromDomain: null };
  }

  const domain = email.split('@')[1].toLowerCase();
  const isPersonal = PERSONAL_DOMAINS.has(domain);

  // Extract company name from corporate domain
  let companyFromDomain: string | null = null;
  if (!isPersonal) {
    // e.g., "john@goldmansachs.com" → "Goldman Sachs" (LLM will refine this)
    const baseDomain = domain.replace(/\.(com|org|net|io|co|ai|app|dev|tech)$/i, '');
    companyFromDomain = baseDomain.charAt(0).toUpperCase() + baseDomain.slice(1);
  }

  return {
    domain,
    isPersonal,
    companyFromDomain,
    emailProvider: isPersonal ? domain.split('.')[0] : null,
  };
}

// ─── Company website scraper ────────────────────────────────────────

export async function scrapeCompanyWebsite(domain: string): Promise<{ title: string; description: string; raw: string } | null> {
  if (!domain || PERSONAL_DOMAINS.has(domain)) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://${domain}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AviseBot/1.0)' },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const html = await res.text();
    // Extract meta tags and first chunk of visible text
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
    const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
    // Strip HTML tags to get visible text (first 2000 chars)
    const textContent = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000);
    return {
      title: titleMatch?.[1]?.trim() || '',
      description: descMatch?.[1]?.trim() || ogDescMatch?.[1]?.trim() || '',
      raw: textContent,
    };
  } catch (err) {
    // Best-effort scrape — caller treats null as "no website data". Network/parse errors are
    // expected when domains are unreachable or block our user agent.
    log.warn('contactEnrichment: scrapeCompanyWebsite failed', { domain, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ─── LinkedIn URL construction ──────────────────────────────────────

export function constructLinkedInUrl(firstName: string, lastName: string, company?: string | null): string | null {
  if (!firstName || !lastName) return null;
  // Construct a LinkedIn search URL (not a profile URL — we can't guess the slug)
  const query = company
    ? `${firstName} ${lastName} ${company}`
    : `${firstName} ${lastName}`;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}`;
}
