// ─── Outreach Contact Enrichment ────────────────────────────────────
//
// Powers the "Enrich" action on the Outreach pipeline board
// (routes/outreach.ts POST /contacts/:id/enrich). Three third-party
// providers, each independently optional via its own env var — mirrors the
// soft-fail pattern already used for optional integrations in this codebase
// (services/anthropic.ts's ANTHROPIC_API_KEY check, utils/aiModels.ts's
// hasAnthropic): missing key => log.info (expected, not a warning/error)
// and skip. One provider erroring never blocks the others or throws past
// this module — the caller always gets a result object back.
//
// ─── Provider API shapes (confirmed against each vendor's own docs, Aug 2026) ───
//
// Apollo.io — POST https://api.apollo.io/api/v1/people/match
//   Auth: `x-api-key` header (raw key, no Bearer prefix).
//   Params: query string (NOT a JSON body — this is how Apollo's own docs
//   specify it, unusual for a POST but confirmed at
//   https://docs.apollo.io/reference/people-enrichment).
//   Synchronous JSON response: { person: { email, title, linkedin_url,
//   organization: { name }, ... } }.
//
// Anymail Finder — POST https://api.anymailfinder.com/v5.1/find-email/person
//   Auth: `Authorization` header (raw key, no Bearer prefix — confirmed at
//   https://anymailfinder.com/email-finder-api/docs/authentication, which
//   only documents "set your API key as its value", no scheme).
//   Body: JSON { full_name, domain | company_name }.
//   Synchronous JSON response: { email_status, valid_email,
//   person_job_title, person_company_name, ... }.
//
// Clay — NOT a synchronous request/response REST API. Confirmed across
//   university.clay.com/docs and developers.clay.com: Clay has no public,
//   versioned REST endpoint catalogue, no fixed base URL, and no OpenAPI
//   spec for "send a contact, get enrichment back" the way Apollo/Anymail
//   work. Clay's real product model is table-based and asynchronous:
//     1. A human creates a Clay table with a Webhook source, which gives
//        Clay a unique per-table inbound webhook URL (not a fixed host —
//        this is why CLAY_WEBHOOK_URL exists below, alongside CLAY_API_KEY).
//     2. We POST the contact to that webhook URL; Clay enqueues a table row
//        and returns 200 immediately — that response carries NO enrichment
//        data, just acknowledgement of receipt.
//     3. Clay's enrichment columns (its 150+ provider waterfall) run
//        against that row over the following minutes, not milliseconds.
//     4. Results only leave Clay via an export or an outbound HTTP API
//        action a human wires up inside the Clay table — i.e. Clay calling
//        US, on Clay's own schedule, not us polling or awaiting Clay.
//   The only endpoint-shaped alternative Clay offers is an Enterprise-only,
//   undocumented People/Company lookup API — not accessible on a normal
//   plan and not something we can build against sight-unseen.
//   Given that shape, enrichViaClay() below submits the contact to the
//   configured webhook and returns status 'submitted' — it deliberately
//   contributes ZERO synchronous fields to the enrichment result, because
//   Clay genuinely has none to give back in the same request. Wiring a
//   receiver for Clay's later, async callback is a separate, deliberately
//   out-of-scope follow-up (see the report this file's commit references) —
//   it needs its own auth model (Clay can't carry a Supabase user session
//   the way this router's other routes require) and a human still has to
//   configure the outbound action inside Clay's UI regardless of our code,
//   so it isn't a "drop in the key and it works" integration the way Apollo
//   and Anymail Finder are.

import { log } from '../utils/logger.js';
import { supabase } from '../supabase.js';
import { PERSONAL_DOMAINS } from './agents/contactEnrichment/state.js';
import { recordTouch } from './outreachTouchLog.js';

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const ANYMAIL_FINDER_API_KEY = process.env.ANYMAIL_FINDER_API_KEY;
const CLAY_API_KEY = process.env.CLAY_API_KEY;
// Clay has no fixed API host (see note above) — the per-table webhook URL a
// human generates inside Clay's UI is a second, Clay-specific requirement on
// top of the key. Not one of the three names the integration was speced
// against, so it's additive/optional: Clay simply stays skipped without it.
const CLAY_WEBHOOK_URL = process.env.CLAY_WEBHOOK_URL;

const APOLLO_MATCH_URL = 'https://api.apollo.io/api/v1/people/match';
const ANYMAIL_FINDER_URL = 'https://api.anymailfinder.com/v5.1/find-email/person';

// ─── Types ───────────────────────────────────────────────────────────

export interface EnrichmentContact {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  linkedinUrl?: string | null;
}

export interface NormalizedEnrichment {
  email?: string;
  phone?: string;
  title?: string;
  linkedinUrl?: string;
  company?: string;
}

type ProviderName = 'apollo' | 'anymailFinder' | 'clay';
type ProviderStatus = 'ok' | 'no_match' | 'submitted' | 'error' | 'skipped';

interface ProviderResult {
  provider: ProviderName;
  status: ProviderStatus;
  normalized?: NormalizedEnrichment;
  raw?: unknown;
  error?: string;
}

export interface EnrichContactResult {
  /** Fields ready to persist — only truthy values from the merge below. */
  updates: NormalizedEnrichment;
  /** Raw + normalized per-provider results, keyed by provider name. */
  enrichmentData: Record<string, unknown>;
  /** Providers that returned usable data (ok) or accepted an async job (submitted). */
  sourcesUsed: string[];
}

// ─── Small helpers ───────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/** Corporate domain from an email, or null for missing/personal (gmail.com etc) domains. */
function domainFromEmail(email?: string | null): string | null {
  if (!email || !email.includes('@')) return null;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain || PERSONAL_DOMAINS.has(domain)) return null;
  return domain;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Apollo.io ───────────────────────────────────────────────────────

export async function enrichViaApollo(contact: EnrichmentContact): Promise<ProviderResult> {
  if (!APOLLO_API_KEY) {
    log.info('outreachEnrichment: Apollo skipped — APOLLO_API_KEY not set');
    return { provider: 'apollo', status: 'skipped' };
  }

  const { firstName, lastName } = splitName(contact.name);
  if (!contact.email && !firstName && !contact.company) {
    return { provider: 'apollo', status: 'no_match' };
  }

  try {
    const params = new URLSearchParams();
    if (contact.email) params.set('email', contact.email);
    if (firstName) params.set('first_name', firstName);
    if (lastName) params.set('last_name', lastName);
    if (contact.company) params.set('organization_name', contact.company);

    const res = await fetchWithTimeout(
      `${APOLLO_MATCH_URL}?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'x-api-key': APOLLO_API_KEY,
        },
      },
      15000,
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn('outreachEnrichment: Apollo request failed', { status: res.status, body: body.slice(0, 500) });
      return { provider: 'apollo', status: 'error', error: `HTTP ${res.status}` };
    }

    const data: any = await res.json();
    const person = data?.person;
    if (!person) return { provider: 'apollo', status: 'no_match', raw: data };

    const normalized: NormalizedEnrichment = {
      email: person.email || undefined,
      phone: person.phone_numbers?.[0]?.sanitized_number || person.phone_number || undefined,
      title: person.title || undefined,
      linkedinUrl: person.linkedin_url || undefined,
      company: person.organization?.name || undefined,
    };

    return { provider: 'apollo', status: 'ok', normalized, raw: data };
  } catch (err) {
    // Network error / timeout — treated as a soft failure, never thrown past
    // this function so one provider going down doesn't block the others.
    log.warn('outreachEnrichment: Apollo call threw', { error: errMessage(err) });
    return { provider: 'apollo', status: 'error', error: errMessage(err) };
  }
}

// ─── Anymail Finder ──────────────────────────────────────────────────

export async function enrichViaAnymailFinder(contact: EnrichmentContact): Promise<ProviderResult> {
  if (!ANYMAIL_FINDER_API_KEY) {
    log.info('outreachEnrichment: Anymail Finder skipped — ANYMAIL_FINDER_API_KEY not set');
    return { provider: 'anymailFinder', status: 'skipped' };
  }

  const domain = domainFromEmail(contact.email);
  if (!domain && !contact.company) {
    // Anymail Finder needs a domain or a company name to resolve one — a
    // bare name with no company/corporate-email context can't be matched.
    return { provider: 'anymailFinder', status: 'no_match' };
  }

  try {
    const body: Record<string, string> = { full_name: contact.name };
    if (domain) body.domain = domain;
    else if (contact.company) body.company_name = contact.company;

    const res = await fetchWithTimeout(
      ANYMAIL_FINDER_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: ANYMAIL_FINDER_API_KEY,
        },
        body: JSON.stringify(body),
      },
      // Anymail Finder's own docs recommend a 180s client timeout (email
      // verification can be slow). That's impractical for a synchronous
      // "Enrich" button click, so we cap well below it — a still-running
      // lookup past this point is treated as a soft error, not a crash.
      20000,
    );

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      log.warn('outreachEnrichment: Anymail Finder request failed', { status: res.status, body: errBody.slice(0, 500) });
      return { provider: 'anymailFinder', status: 'error', error: `HTTP ${res.status}` };
    }

    const data: any = await res.json();
    if (data?.email_status !== 'valid' || !data?.valid_email) {
      return { provider: 'anymailFinder', status: 'no_match', raw: data };
    }

    const normalized: NormalizedEnrichment = {
      email: data.valid_email,
      title: data.person_job_title || undefined,
      company: data.person_company_name || undefined,
    };

    return { provider: 'anymailFinder', status: 'ok', normalized, raw: data };
  } catch (err) {
    log.warn('outreachEnrichment: Anymail Finder call threw', { error: errMessage(err) });
    return { provider: 'anymailFinder', status: 'error', error: errMessage(err) };
  }
}

// ─── Clay ────────────────────────────────────────────────────────────

export async function enrichViaClay(contact: EnrichmentContact): Promise<ProviderResult> {
  if (!CLAY_API_KEY) {
    log.info('outreachEnrichment: Clay skipped — CLAY_API_KEY not set');
    return { provider: 'clay', status: 'skipped' };
  }
  if (!CLAY_WEBHOOK_URL) {
    // See the module-level Clay note: there's no fixed api.clay.com host to
    // call — a per-table webhook URL, generated in Clay's UI, is required
    // and can't be inferred from the key alone.
    log.info('outreachEnrichment: Clay skipped — CLAY_API_KEY is set but CLAY_WEBHOOK_URL is not (Clay has no fixed API host; see comment block above)');
    return { provider: 'clay', status: 'skipped' };
  }

  try {
    const res = await fetchWithTimeout(
      CLAY_WEBHOOK_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Clay webhook auth is a user-defined header configured per-webhook
          // inside Clay's UI, not a fixed scheme. Bearer is the convention
          // Clay's own docs use as their example, so we match it.
          Authorization: `Bearer ${CLAY_API_KEY}`,
        },
        body: JSON.stringify({
          contactId: contact.id,
          name: contact.name,
          email: contact.email || null,
          company: contact.company || null,
          phone: contact.phone || null,
          linkedinUrl: contact.linkedinUrl || null,
        }),
      },
      10000,
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn('outreachEnrichment: Clay webhook submission failed', { status: res.status, body: body.slice(0, 500) });
      return { provider: 'clay', status: 'error', error: `HTTP ${res.status}` };
    }

    // A 200 here only confirms Clay accepted the row — not that enrichment
    // ran. Clay processes tables asynchronously (minutes), and has no
    // synchronous field to hand back in this response. See module note.
    return {
      provider: 'clay',
      status: 'submitted',
      raw: { submittedAt: new Date().toISOString() },
    };
  } catch (err) {
    log.warn('outreachEnrichment: Clay webhook call threw', { error: errMessage(err) });
    return { provider: 'clay', status: 'error', error: errMessage(err) };
  }
}

// ─── Aggregator ──────────────────────────────────────────────────────

/** Provider names with all their required env vars present right now. */
export function getConfiguredProviders(): ProviderName[] {
  const providers: ProviderName[] = [];
  if (APOLLO_API_KEY) providers.push('apollo');
  if (ANYMAIL_FINDER_API_KEY) providers.push('anymailFinder');
  if (CLAY_API_KEY && CLAY_WEBHOOK_URL) providers.push('clay');
  return providers;
}

/**
 * Run all configured providers concurrently and merge their results.
 *
 * Merge rule: first-non-null wins per field, in this priority order —
 * Apollo, then Anymail Finder, then Clay:
 *   - Apollo is checked first because it returns the richest, most current
 *     org-linked record (title + org name together) when it has a match.
 *   - Anymail Finder is an email-finding specialist, so it's a good second
 *     pass to fill an email Apollo didn't return.
 *   - Clay never contributes a field here — it's asynchronous (see
 *     enrichViaClay) and has nothing to hand back synchronously.
 * A provider that errors or has no match simply contributes nothing; it
 * never blocks another provider's fields from being used.
 */
export async function enrichContact(contact: EnrichmentContact): Promise<EnrichContactResult> {
  const results = await Promise.all([
    enrichViaApollo(contact),
    enrichViaAnymailFinder(contact),
    enrichViaClay(contact),
  ]);

  const updates: NormalizedEnrichment = {};
  const fieldOrder: Array<keyof NormalizedEnrichment> = ['email', 'phone', 'title', 'linkedinUrl', 'company'];
  for (const result of results) {
    if (result.status !== 'ok' || !result.normalized) continue;
    for (const field of fieldOrder) {
      const value = result.normalized[field];
      if (value && !updates[field]) updates[field] = value;
    }
  }

  const enrichmentData: Record<string, unknown> = {};
  const sourcesUsed: string[] = [];
  for (const result of results) {
    // Skip providers that weren't configured at all — nothing to record,
    // and keeps enrichmentData from filling up with noise for keys nobody
    // has set yet.
    if (result.status === 'skipped') continue;

    enrichmentData[result.provider] = {
      status: result.status,
      fetchedAt: new Date().toISOString(),
      ...(result.normalized ? { normalized: result.normalized } : {}),
      ...(result.raw !== undefined ? { raw: result.raw } : {}),
      ...(result.error ? { error: result.error } : {}),
    };

    if (result.status === 'ok' || result.status === 'submitted') {
      sourcesUsed.push(result.provider);
    }
  }

  return { updates, enrichmentData, sourcesUsed };
}

// ─── Persist helper ──────────────────────────────────────────────────
//
// Fetches one OutreachContact, runs it through enrichContact() above, and
// persists the result with the exact same fill-blank-only semantics as the
// manual "Enrich" button (routes/outreach.ts POST /contacts/:id/enrich):
// enrichmentData/enrichmentSource/enrichedAt always update (they record the
// attempt itself), every other field only fills in when currently
// null/empty. Extracted here so a second caller — the Private Circle
// import route's auto-enrichment trigger for newly-created, email-less
// contacts (routes/outreach-private-circle-import.ts) — gets identical
// persist behaviour without duplicating it. The manual Enrich route is
// left as-is (it also needs to return the full updated row to its caller,
// which this helper doesn't); this is purely additive.

export interface EnrichAndPersistResult {
  /** False only when zero enrichment providers are configured at all — nothing was attempted. */
  attempted: boolean;
  /** True when this run filled in a previously-blank email. */
  emailFilled: boolean;
  sourcesUsed: string[];
}

export async function enrichAndPersistOutreachContact(orgId: string, contactId: string): Promise<EnrichAndPersistResult> {
  const configuredProviders = getConfiguredProviders();
  if (configuredProviders.length === 0) {
    return { attempted: false, emailFilled: false, sourcesUsed: [] };
  }

  const { data: contact, error: fetchError } = await supabase
    .from('OutreachContact')
    .select('*')
    .eq('id', contactId)
    .eq('organizationId', orgId)
    .single();

  if (fetchError || !contact) {
    log.warn('enrichAndPersistOutreachContact: contact not found', { contactId, orgId });
    return { attempted: true, emailFilled: false, sourcesUsed: [] };
  }

  const result = await enrichContact({
    id: contact.id,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    company: contact.company,
    linkedinUrl: contact.linkedinUrl,
  });

  const updates: Record<string, any> = {
    updatedAt: new Date().toISOString(),
    enrichedAt: new Date().toISOString(),
    enrichmentData: { ...(contact.enrichmentData || {}), ...result.enrichmentData },
    enrichmentSource: Array.from(new Set([...(contact.enrichmentSource || []), ...result.sourcesUsed])),
  };

  const emailFilled = Boolean(result.updates.email && !contact.email);
  if (emailFilled) updates.email = result.updates.email;
  if (result.updates.phone && !contact.phone) updates.phone = result.updates.phone;
  if (result.updates.title && !contact.title) updates.title = result.updates.title;
  if (result.updates.linkedinUrl && !contact.linkedinUrl) updates.linkedinUrl = result.updates.linkedinUrl;
  if (result.updates.company && !contact.company) updates.company = result.updates.company;

  const { error: updateError } = await supabase
    .from('OutreachContact')
    .update(updates)
    .eq('id', contactId)
    .eq('organizationId', orgId);

  if (updateError) {
    log.error('enrichAndPersistOutreachContact: failed to persist enrichment', updateError, { contactId });
    return { attempted: true, emailFilled: false, sourcesUsed: [] };
  }

  await recordTouch({
    organizationId: orgId,
    contactId,
    channel: 'enrichment',
    type: 'enriched',
    direction: 'outbound',
    metadata: { providersConfigured: configuredProviders, sourcesUsed: result.sourcesUsed, trigger: 'private_circle_import' },
  });

  return { attempted: true, emailFilled, sourcesUsed: result.sourcesUsed };
}
