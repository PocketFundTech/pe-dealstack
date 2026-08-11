// ─── Gmail Contacts service ─────────────────────────────────────────
// Best-effort, BOUNDED, org-scoped Gmail helpers for the contacts overhaul:
//   1. scanCorrespondents — suggest NEW contacts from the user's recent Gmail
//      correspondents (deduped against existing org contacts).
//   2. getContactEmailSummary — an AI summary of the email conversation with a
//      single contact.
//
// Uses the EXISTING gmail.readonly scope (no reconnect). Every Gmail fetch and
// token use is bounded. When Gmail isn't linked, callers get `connected:false`
// with empty/neutral payloads — never an error.
//
// Token + internal-user patterns are copied from inboxDealScanService.ts (those
// helpers aren't exported, so they're replicated locally here).

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import {
  getDecryptedTokens,
  saveTokens,
  markStatus,
} from '../integrations/_platform/tokenStore.js';
import {
  getMessage,
  getMessageFull,
  getUserInfo,
  listMessagesForDeal,
  refreshAccessToken,
} from '../integrations/gmail/client.js';
import type { Integration } from '../integrations/_platform/types.js';
import type { GmailMessage, GmailMessageFull } from '../integrations/gmail/types.js';
import { getChatModel } from './llm.js';

// ─── Tunables (no magic numbers) ───────────────────────────────────
const SCAN_DAYS_DEFAULT = 90;
const SCAN_DAYS_MIN = 7;
const SCAN_DAYS_MAX = 365;
// Cap on messages whose headers we read during a correspondent scan.
const MAX_SCAN_MESSAGES = 150;
// Bounded concurrency for the per-message header fetches.
const HEADER_FETCH_CONCURRENCY = 8;
// Top-N suggestions returned.
const MAX_SUGGESTIONS = 25;

// Email-summary caps.
const SUMMARY_LOOKBACK_DAYS = 365;
const MAX_SUMMARY_THREADS = 30; // cap on listMessagesForDeal results
const MAX_SUMMARY_BODIES = 12; // bounded set of bodies actually fetched + summarized
const BODY_FETCH_CONCURRENCY = 4;
const MAX_BODY_CHARS = 1500; // per-message slice fed to the LLM
const SUMMARY_MAX_TOKENS = 700;

const TOKEN_REFRESH_SAFETY_MS = 60_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const SUMMARY_OPERATION = 'deal_analysis';

// Local-parts that signal an automated / no-reply sender we never suggest.
const AUTOMATED_LOCAL_HINTS = [
  'no-reply',
  'noreply',
  'no_reply',
  'donotreply',
  'do-not-reply',
  'do_not_reply',
  'mailer-daemon',
  'postmaster',
  'notifications',
  'notification',
  'alerts',
  'alert',
  'support',
  'bounce',
  'bounces',
  'newsletter',
  'updates',
  'automated',
  'auto-confirm',
];

// Free-mail domains we never infer a "company" from.
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'mail.com',
]);

// ─── Public types ──────────────────────────────────────────────────

export interface ContactSuggestion {
  email: string;
  name: string | null;
  company: string | null;
  emailCount: number;
  lastEmailDate: string;
}

export interface ScanCorrespondentsResult {
  connected: boolean;
  scanned: number;
  suggestions: ContactSuggestion[];
}

export interface ContactEmailSummaryResult {
  connected: boolean;
  threadCount: number;
  lastContact: string | null;
  summary: string;
  highlights: string[];
}

// ─── Internal helpers (replicated locally — no routes→services coupling) ──

/** Run an async mapper across `items` with at most `limit` in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const n = Math.min(limit, items.length);
  for (let w = 0; w < n; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor++;
          if (i >= items.length) return;
          results[i] = await fn(items[i], i);
        }
      })()
    );
  }
  await Promise.all(workers);
  return results;
}

/** Resolve auth UUID (req.user?.id) to the internal User.id used as Integration.userId. */
async function resolveInternalUserId(authOrInternalId: string): Promise<string | null> {
  const { data: byAuth } = await supabase
    .from('User')
    .select('id')
    .eq('authId', authOrInternalId)
    .maybeSingle();
  if (byAuth?.id) return byAuth.id as string;
  const { data: byId } = await supabase
    .from('User')
    .select('id')
    .eq('id', authOrInternalId)
    .maybeSingle();
  return (byId?.id as string | undefined) ?? null;
}

/** Fetch a fresh access token for this integration, refreshing if expired. */
async function ensureFreshGmailToken(integration: Integration): Promise<string | null> {
  const { accessToken, refreshToken } = await getDecryptedTokens(integration);
  if (!accessToken) return null;

  const expiresAt = integration.tokenExpiresAt ? Date.parse(integration.tokenExpiresAt) : 0;
  const now = Date.now();
  if (!expiresAt || expiresAt - now > TOKEN_REFRESH_SAFETY_MS) {
    return accessToken;
  }
  if (!refreshToken) {
    await markStatus(integration.id, 'error', 'no refresh token').catch(() => {});
    return null;
  }
  try {
    const refreshed = await refreshAccessToken(refreshToken);
    await saveTokens({
      integrationId: integration.id,
      accessToken: refreshed.access_token,
      refreshToken,
      tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    });
    return refreshed.access_token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    log.warn('gmailContacts: gmail token refresh failed', { integrationId: integration.id, msg });
    await markStatus(integration.id, 'error', `refresh failed: ${msg}`).catch(() => {});
    return null;
  }
}

/**
 * Resolve the connected Gmail integration + a fresh access token for an auth
 * user. Returns null at any failure point so callers map to `connected:false`.
 */
async function resolveGmailToken(authUserId: string): Promise<string | null> {
  const internalUserId = await resolveInternalUserId(authUserId);
  if (!internalUserId) return null;

  const { data: integration } = await supabase
    .from('Integration')
    .select('*')
    .eq('userId', internalUserId)
    .eq('provider', 'gmail')
    .eq('status', 'connected')
    .maybeSingle();
  if (!integration) return null;

  return ensureFreshGmailToken(integration as Integration);
}

// ─── Address parsing ───────────────────────────────────────────────

/** Parse one address from a header value like `"Jane Doe" <jane@x.com>, ...`. */
interface ParsedAddress {
  email: string;
  name: string | null;
}

/** Split a From/To/Cc header into individual `{ email, name }` entries. */
function parseAddressList(headerValue: string): ParsedAddress[] {
  if (!headerValue) return [];
  // Split on commas that are not inside quotes/angle brackets. Header values
  // from Gmail are well-formed enough that a simple comma split works for the
  // common case; we trim aggressively and validate the email below.
  const out: ParsedAddress[] = [];
  for (const raw of headerValue.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const angle = part.match(/<([^>]+)>/);
    let email: string;
    let name: string | null = null;
    if (angle) {
      email = angle[1].trim().toLowerCase();
      const namePart = part.slice(0, angle.index).trim().replace(/^"|"$/g, '').trim();
      name = namePart || null;
    } else {
      email = part.trim().toLowerCase();
    }
    email = email.replace(/^<|>$/g, '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    out.push({ email, name });
  }
  return out;
}

function isAutomatedAddress(email: string): boolean {
  const local = email.split('@')[0] ?? '';
  return AUTOMATED_LOCAL_HINTS.some((hint) => local.includes(hint));
}

/** Infer a company display name from an email domain (skips free-mail providers). */
function inferCompanyFromEmail(email: string): string | null {
  const domain = email.split('@')[1]?.toLowerCase().trim();
  if (!domain) return null;
  if (FREE_MAIL_DOMAINS.has(domain)) return null;
  // Strip a leading "mail."/"email." style subdomain, then take the registrable
  // label and Title-case it. e.g. "goldmansachs.com" → "Goldmansachs".
  const labels = domain.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const core = labels[labels.length - 2];
  if (!core || core.length < 2) return null;
  return core.charAt(0).toUpperCase() + core.slice(1);
}

/** Load existing org contact emails, lowercased, for dedupe. */
async function loadExistingContactEmails(orgId: string): Promise<Set<string>> {
  const set = new Set<string>();
  const { data, error } = await supabase
    .from('Contact')
    .select('email')
    .eq('organizationId', orgId);
  if (error) {
    log.warn('gmailContacts: existing contact email lookup failed', { orgId, message: error.message });
    return set;
  }
  for (const row of (data ?? []) as Array<{ email: string | null }>) {
    const email = (row.email ?? '').trim().toLowerCase();
    if (email) set.add(email);
  }
  return set;
}

/** Pull the header value off a metadata-format GmailMessage payload. */
function metaHeader(msg: GmailMessage, name: string): string {
  const headers = msg.payload?.headers;
  if (!headers) return '';
  const wanted = name.toLowerCase();
  const found = headers.find((h) => (h.name ?? '').toLowerCase() === wanted);
  return found?.value ?? '';
}

/**
 * Pure transform: tally From/To/Cc addresses across messages into ranked
 * contact suggestions. Excludes the user's own address, automated senders, and
 * emails already in the CRM; ranks by frequency then recency; caps at `cap`.
 * Exported for unit testing (no Gmail/Supabase deps).
 */
export function buildContactSuggestions(
  messages: GmailMessage[],
  ownEmail: string | null,
  existingEmails: Set<string>,
  cap: number = MAX_SUGGESTIONS,
): ContactSuggestion[] {
  interface Tally {
    email: string;
    name: string | null;
    company: string | null;
    emailCount: number;
    lastEmailMs: number;
  }
  const byEmail = new Map<string, Tally>();

  for (const msg of messages) {
    if (!msg) continue;
    const dateStr = metaHeader(msg, 'Date');
    const dateMs = dateStr ? Date.parse(dateStr) : NaN;
    const whenMs = Number.isFinite(dateMs) ? dateMs : 0;

    const addresses = [
      ...parseAddressList(metaHeader(msg, 'From')),
      ...parseAddressList(metaHeader(msg, 'To')),
      ...parseAddressList(metaHeader(msg, 'Cc')),
    ];

    for (const addr of addresses) {
      const email = addr.email;
      if (!email) continue;
      if (ownEmail && email === ownEmail) continue;
      if (isAutomatedAddress(email)) continue;
      if (existingEmails.has(email)) continue;

      const existing = byEmail.get(email);
      if (existing) {
        existing.emailCount++;
        if (whenMs > existing.lastEmailMs) existing.lastEmailMs = whenMs;
        if (!existing.name && addr.name) existing.name = addr.name;
      } else {
        byEmail.set(email, {
          email,
          name: addr.name,
          company: inferCompanyFromEmail(email),
          emailCount: 1,
          lastEmailMs: whenMs,
        });
      }
    }
  }

  return Array.from(byEmail.values())
    .sort((a, b) => b.emailCount - a.emailCount || b.lastEmailMs - a.lastEmailMs)
    .slice(0, cap)
    .map((t) => ({
      email: t.email,
      name: t.name,
      company: t.company,
      emailCount: t.emailCount,
      lastEmailDate: t.lastEmailMs ? new Date(t.lastEmailMs).toISOString() : '',
    }));
}

// ─── Entry point: scanCorrespondents ───────────────────────────────

/**
 * Bounded scan of the user's recent Gmail. Reads From/To/Cc/Date headers
 * (lightweight metadata fetch) across up to MAX_SCAN_MESSAGES recent messages,
 * tallies per-email frequency + display name + last date, infers company from
 * the email domain, EXCLUDES the user's own address + obvious automated
 * senders, DEDUPES against existing org contacts, and returns the top
 * MAX_SUGGESTIONS correspondents.
 */
export async function scanCorrespondents(
  orgId: string,
  authUserId: string,
  days: number = SCAN_DAYS_DEFAULT
): Promise<ScanCorrespondentsResult> {
  const notConnected: ScanCorrespondentsResult = { connected: false, scanned: 0, suggestions: [] };

  const lookbackDays = Math.min(Math.max(days || SCAN_DAYS_DEFAULT, SCAN_DAYS_MIN), SCAN_DAYS_MAX);

  const accessToken = await resolveGmailToken(authUserId);
  if (!accessToken) {
    log.info('gmailContacts: scanCorrespondents — gmail not connected', { orgId });
    return notConnected;
  }

  // Identify the user's own address so we never suggest them as a contact.
  let ownEmail: string | null = null;
  try {
    const info = await getUserInfo(accessToken);
    ownEmail = (info.email ?? '').toLowerCase().trim() || null;
  } catch (err) {
    log.warn('gmailContacts: getUserInfo failed (continuing)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // List recent message ids using listMessagesForDeal with the user's own
  // address as the "known email" — this returns from/to/cc matches for the user,
  // i.e. their correspondence. Bounded by MAX_SCAN_MESSAGES.
  const since = new Date(Date.now() - lookbackDays * MS_PER_DAY);
  let ids: { id: string; threadId: string }[] = [];
  try {
    if (ownEmail) {
      ids = await listMessagesForDeal(accessToken, since, [ownEmail], [], MAX_SCAN_MESSAGES);
    } else {
      // Without the user's address we can't scope to their correspondence; bail
      // gracefully rather than scanning the entire mailbox unscoped.
      log.info('gmailContacts: no own email — skipping correspondent scan', { orgId });
      return { connected: true, scanned: 0, suggestions: [] };
    }
  } catch (err) {
    log.warn('gmailContacts: listMessagesForDeal failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { connected: true, scanned: 0, suggestions: [] };
  }

  if (ids.length === 0) {
    return { connected: true, scanned: 0, suggestions: [] };
  }

  const existingEmails = await loadExistingContactEmails(orgId);

  // Fetch headers (metadata format) with bounded concurrency; drop failures.
  const fetched = await mapWithConcurrency<{ id: string; threadId: string }, GmailMessage | null>(
    ids,
    HEADER_FETCH_CONCURRENCY,
    async (h) => {
      try {
        return await getMessage(accessToken, h.id);
      } catch (err) {
        log.warn('gmailContacts: per-message header fetch failed (skipping)', {
          messageId: h.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }
  );

  // Tally + rank into suggestions (pure logic — unit-tested via buildContactSuggestions).
  const validMsgs = fetched.filter((m): m is GmailMessage => m !== null);
  const scanned = validMsgs.length;
  const suggestions = buildContactSuggestions(validMsgs, ownEmail, existingEmails);

  log.info('gmailContacts: scanCorrespondents complete', {
    orgId,
    scanned,
    suggestions: suggestions.length,
  });

  return { connected: true, scanned, suggestions };
}

// ─── Entry point: getContactEmailSummary ───────────────────────────

/**
 * Load the (org-scoped) contact, find email threads with their address, fetch a
 * bounded set of bodies, and produce ONE LLM summary + highlights. If the
 * contact has no email or no messages, returns a neutral summary (never errors).
 */
export async function getContactEmailSummary(
  orgId: string,
  contactId: string,
  authUserId: string
): Promise<ContactEmailSummaryResult> {
  const empty: ContactEmailSummaryResult = {
    connected: false,
    threadCount: 0,
    lastContact: null,
    summary: '',
    highlights: [],
  };

  // Load contact (org-scoped).
  const { data: contact } = await supabase
    .from('Contact')
    .select('id, firstName, lastName, email, company, title, organizationId')
    .eq('id', contactId)
    .eq('organizationId', orgId)
    .maybeSingle();
  if (!contact) {
    // Caller is expected to have verified access; treat as not-found → neutral.
    return { ...empty, connected: false, summary: 'Contact not found.' };
  }

  const contactEmail = (contact.email ?? '').trim().toLowerCase();
  const contactName = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contactEmail || 'this contact';

  const accessToken = await resolveGmailToken(authUserId);
  if (!accessToken) {
    return {
      connected: false,
      threadCount: 0,
      lastContact: null,
      summary: 'Gmail is not connected, so no email history is available for this contact.',
      highlights: [],
    };
  }

  if (!contactEmail) {
    return {
      connected: true,
      threadCount: 0,
      lastContact: null,
      summary: `${contactName} has no email address on file, so there is no email history to summarize.`,
      highlights: [],
    };
  }

  // Find threads with this email.
  const since = new Date(Date.now() - SUMMARY_LOOKBACK_DAYS * MS_PER_DAY);
  let ids: { id: string; threadId: string }[] = [];
  try {
    ids = await listMessagesForDeal(accessToken, since, [contactEmail], [], MAX_SUMMARY_THREADS);
  } catch (err) {
    log.warn('gmailContacts: email-summary list failed', {
      contactId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      connected: true,
      threadCount: 0,
      lastContact: null,
      summary: `Unable to load email history for ${contactName} right now.`,
      highlights: [],
    };
  }

  const uniqueThreads = new Set(ids.map((i) => i.threadId)).size;

  if (ids.length === 0) {
    return {
      connected: true,
      threadCount: 0,
      lastContact: null,
      summary: `No emails found with ${contactName} in the last ${Math.round(SUMMARY_LOOKBACK_DAYS / 30)} months.`,
      highlights: [],
    };
  }

  // Fetch a bounded set of bodies.
  const toFetch = ids.slice(0, MAX_SUMMARY_BODIES);
  const fetched = await mapWithConcurrency<{ id: string; threadId: string }, GmailMessageFull | null>(
    toFetch,
    BODY_FETCH_CONCURRENCY,
    async (h) => {
      try {
        return await getMessageFull(accessToken, h.id);
      } catch (err) {
        log.warn('gmailContacts: summary body fetch failed (skipping)', {
          messageId: h.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }
  );
  const messages = fetched.filter((m): m is GmailMessageFull => m !== null);

  if (messages.length === 0) {
    return {
      connected: true,
      threadCount: uniqueThreads,
      lastContact: null,
      summary: `Found email activity with ${contactName} but could not read the message contents.`,
      highlights: [],
    };
  }

  // Determine last contact date from fetched headers.
  let lastMs = 0;
  const blocks: string[] = [];
  for (const m of messages) {
    const dateStr = m.headers.Date || '';
    const ms = dateStr ? Date.parse(dateStr) : NaN;
    if (Number.isFinite(ms) && ms > lastMs) lastMs = ms;
    const body = (m.body || m.snippet || '').slice(0, MAX_BODY_CHARS);
    blocks.push(
      [
        `Subject: ${m.headers.Subject || '(no subject)'}`,
        `From: ${m.headers.From || 'unknown'}`,
        `Date: ${dateStr || 'unknown'}`,
        '',
        body,
      ].join('\n')
    );
  }
  const lastContact = lastMs ? new Date(lastMs).toISOString() : null;

  const corpus = blocks.join('\n\n---\n\n');

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const systemPrompt = `You summarize an email correspondence history between a private-equity professional and an external contact, for a CRM. Be concise and factual; ground ONLY in the provided emails, never invent.

Today's date: ${today}

Respond in this exact format:
SUMMARY: <2-4 sentence overview of the relationship and what's been discussed>
HIGHLIGHTS:
- <key fact, commitment, ask, or next step>
- <another>
(Up to 5 highlights. If there's nothing notable, write "- None".)`;

  const humanPrompt = `Contact: ${contactName}${contact.company ? ` (${contact.company})` : ''}${contact.title ? `, ${contact.title}` : ''}
Email: ${contactEmail}

Emails (most relevant ${messages.length} of ${ids.length} matched):

${corpus}`;

  let summary = '';
  let highlights: string[] = [];
  try {
    const model = getChatModel(0.3, SUMMARY_MAX_TOKENS, SUMMARY_OPERATION);
    const result = await model.invoke([new SystemMessage(systemPrompt), new HumanMessage(humanPrompt)]);
    const text =
      typeof result.content === 'string'
        ? result.content
        : Array.isArray(result.content)
          ? result.content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).join('')
          : '';
    const parsed = parseSummaryOutput(text);
    summary = parsed.summary;
    highlights = parsed.highlights;
  } catch (err) {
    log.warn('gmailContacts: summary LLM call failed', {
      contactId,
      error: err instanceof Error ? err.message : String(err),
    });
    summary = `Found ${ids.length} message(s) with ${contactName} but the summary could not be generated.`;
  }

  return {
    connected: true,
    threadCount: uniqueThreads,
    lastContact,
    summary: summary || `Correspondence history with ${contactName}.`,
    highlights,
  };
}

/** Parse the `SUMMARY:` / `HIGHLIGHTS:` formatted LLM output. */
function parseSummaryOutput(text: string): { summary: string; highlights: string[] } {
  const trimmed = (text || '').trim();
  if (!trimmed) return { summary: '', highlights: [] };

  const summaryMatch = trimmed.match(/SUMMARY:\s*([\s\S]*?)(?:\n\s*HIGHLIGHTS:|$)/i);
  const highlightsMatch = trimmed.match(/HIGHLIGHTS:\s*([\s\S]*)$/i);

  const summary = (summaryMatch?.[1] ?? trimmed).trim();

  const highlights: string[] = [];
  if (highlightsMatch?.[1]) {
    for (const line of highlightsMatch[1].split('\n')) {
      const item = line.replace(/^\s*[-*•]\s*/, '').trim();
      if (!item) continue;
      if (/^none$/i.test(item)) continue;
      highlights.push(item);
    }
  }
  return { summary, highlights: highlights.slice(0, 5) };
}
