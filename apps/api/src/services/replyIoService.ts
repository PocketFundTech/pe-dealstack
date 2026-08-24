// ─── Reply.io send + reply-tracking integration ─────────────────────
//
// Powers the "Send" action on the Outreach pipeline board
// (routes/outreach.ts GET /campaigns, POST /contacts/:id/send) and the
// inbound reply webhook (routes/outreach-webhooks.ts). Same soft-fail idiom
// as services/outreachEnrichment.ts: no REPLY_IO_API_KEY => every exported
// function returns a clear "not configured" result object, never throws.
//
// ─── API version — researched against Reply.io's own docs, Aug 2026 ───
//
// Reply.io publishes two generations of REST API:
//   - v3 (current, maintained) — docs.reply.io. Base URL
//     https://api.reply.io/v3, auth header `Authorization: Bearer <key>`.
//     Confirmed at https://docs.reply.io/api-reference/introduction and
//     https://docs.reply.io/api-reference/authentication.
//   - v1/v2 (legacy — docs.reply.io's own intro page: "no longer supported
//     ... will be deprecated in the future") — documented separately at
//     apidocs.reply.io, using a DIFFERENT auth scheme: an `X-Api-Key: <key>`
//     header (no Bearer prefix), against `https://api.reply.io/v1/...` /
//     `/v2/...` paths (e.g. legacy `/v1/campaigns`, `/v1/people`).
// This module targets v3 exclusively — "campaigns" in this file's public
// API maps to Reply.io v3's "sequences" resource.
//
// Whether the configured REPLY_IO_API_KEY is v3-shaped or legacy-shaped
// could NOT be conclusively determined from format alone: neither doc set
// documents a distinguishing prefix/length, and Reply.io's own published
// legacy-key example (`AKp2BbuyfS-ugPMkBmd3sg2`, 22 chars + hyphen) and the
// configured key (24 mixed-case alphanumeric chars, no hyphen) are both
// unstructured opaque tokens of similar shape — the API "version" appears
// to be a property of which base path + header scheme you call it with,
// not something encoded into the key string itself, as far as either doc
// set discloses. Per this task's explicit instruction for genuine
// ambiguity, this module is built against v3 (the current, maintained
// generation). If the configured key turns out to be legacy-only in
// practice, listCampaigns()/addContactToCampaign() below will surface that
// as a 401 `error` from Reply.io (visible in logs + the route's response),
// not a silent failure — nothing here assumes the key works.
//
// ─── Webhook signing — researched against Reply.io's own docs, Aug 2026 ───
//
// Checked: https://docs.reply.io/api-reference/webhooks/create-a-webhook-subscription,
// https://docs.reply.io/webhook-events, https://docs.reply.io/webhook-event-payloads,
// https://docs.reply.io/api-reference/webhooks/send-a-test-payload, and
// Reply.io's full bundled OpenAPI spec
// (https://docs.reply.io/api-reference/bundled.yaml — searched for
// "signature" / "hmac" / "secret" / "sign", case-insensitive: zero matches
// anywhere in the document). Conclusion: Reply.io does NOT sign or
// authenticate its outbound webhook calls in any way — no signature
// header, no HMAC, no shared-secret mechanism on their side.
//
// Webhook subscriptions themselves ARE createable via API
// (`POST /v3/webhooks`, requires the `webhooks:write` scope — not
// dashboard-UI only), but nothing about the delivery proves it actually
// came from Reply.io.
//
// Given that gap, this module verifies our OWN shared secret
// (REPLY_IO_WEBHOOK_SECRET) instead of anything Reply.io provides — the
// operator embeds that secret as a URL path segment when registering the
// webhook subscription with Reply.io (either via `POST /v3/webhooks
// {"url": ".../api/webhooks/reply-io/<secret>", "eventType": "email_replied", ...}`
// or by pasting that same URL into the dashboard's webhook UI — either path
// creates a working subscription, per the docs above). See
// verifyReplyIoWebhookSecret() below, routes/outreach-webhooks.ts for where
// it's enforced, and .env.example for the operator-facing setup steps.

import { timingSafeEqual } from 'node:crypto';
import { log } from '../utils/logger.js';

const REPLY_IO_API_KEY = process.env.REPLY_IO_API_KEY;
const REPLY_IO_WEBHOOK_SECRET = process.env.REPLY_IO_WEBHOOK_SECRET;
const REPLY_IO_BASE_URL = 'https://api.reply.io/v3';

// ─── Types ───────────────────────────────────────────────────────────

export interface ReplyIoCampaign {
  id: number;
  name: string;
  status: string;
}

export interface ListCampaignsResult {
  configured: boolean;
  campaigns: ReplyIoCampaign[];
  /** Set when configured=true but the live call to Reply.io failed. */
  error?: string;
}

export interface ReplyIoContactInput {
  name: string;
  email?: string | null;
  company?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
}

export interface AddContactToCampaignResult {
  configured: boolean;
  success: boolean;
  replyIoContactId?: number;
  /** A named precondition that isn't a Reply.io failure (no email, bad campaignId, not configured). */
  reason?: string;
  /** A genuine upstream (Reply.io API) failure. */
  error?: string;
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${REPLY_IO_API_KEY}`,
  };
}

export function isReplyIoConfigured(): boolean {
  return !!REPLY_IO_API_KEY;
}

export function isReplyIoWebhookConfigured(): boolean {
  return !!REPLY_IO_WEBHOOK_SECRET;
}

// ─── GET /v3/sequences — list campaigns ─────────────────────────────

export async function listCampaigns(): Promise<ListCampaignsResult> {
  if (!REPLY_IO_API_KEY) {
    log.info('replyIoService: listCampaigns skipped — REPLY_IO_API_KEY not set');
    return { configured: false, campaigns: [] };
  }

  try {
    const res = await fetchWithTimeout(
      `${REPLY_IO_BASE_URL}/sequences?top=200`,
      { headers: authHeaders() },
      15000,
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn('replyIoService: listCampaigns failed', { status: res.status, body: body.slice(0, 500) });
      return { configured: true, campaigns: [], error: `Reply.io returned HTTP ${res.status}` };
    }

    const data: any = await res.json();
    const campaigns: ReplyIoCampaign[] = Array.isArray(data?.items)
      ? data.items.map((s: any) => ({ id: s.id, name: s.name, status: s.status }))
      : [];

    return { configured: true, campaigns };
  } catch (err) {
    log.warn('replyIoService: listCampaigns call threw', { error: errMessage(err) });
    return { configured: true, campaigns: [], error: errMessage(err) };
  }
}

// ─── Contact create/lookup + move-to-sequence — the "Send" action ──

/**
 * POST /v3/contacts. Returns the new Reply.io contact id, or null if
 * creation failed. A 400 here most commonly means "contact already exists"
 * (Reply.io's docs describe 400 as "a business rule rejection, e.g. contact
 * already exists" without a distinct error code for it) — that case isn't
 * logged as a warning; the caller falls back to findReplyIoContactByEmail.
 * Any other non-2xx is logged and also returns null, so a single Send click
 * degrades to "couldn't create or find the contact" rather than throwing.
 */
async function createReplyIoContact(input: {
  email: string;
  firstName: string;
  lastName: string;
  company?: string | null;
  phone?: string | null;
  linkedInUrl?: string | null;
}): Promise<number | null> {
  const res = await fetchWithTimeout(
    `${REPLY_IO_BASE_URL}/contacts`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        email: input.email,
        firstName: input.firstName || undefined,
        lastName: input.lastName || undefined,
        company: input.company || undefined,
        phone: input.phone || undefined,
        linkedInUrl: input.linkedInUrl || undefined,
      }),
    },
    15000,
  );

  if (res.status === 200 || res.status === 201) {
    const data: any = await res.json().catch(() => null);
    return typeof data?.id === 'number' ? data.id : null;
  }

  if (res.status !== 400) {
    const body = await res.text().catch(() => '');
    log.warn('replyIoService: create contact failed', { status: res.status, body: body.slice(0, 500) });
  }

  return null;
}

/** POST /v3/contacts/filter, scoped to a single email match. */
async function findReplyIoContactByEmail(email: string): Promise<number | null> {
  const res = await fetchWithTimeout(
    `${REPLY_IO_BASE_URL}/contacts/filter?top=1`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ rules: [{ property: 'email', condition: 'equals', value: email }] }),
    },
    15000,
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    log.warn('replyIoService: filter contacts failed', { status: res.status, body: body.slice(0, 500) });
    return null;
  }

  const data: any = await res.json().catch(() => null);
  const first = data?.items?.[0];
  return typeof first?.id === 'number' ? first.id : null;
}

/**
 * The "Send" action: ensures the contact exists in Reply.io (create, or
 * look up by email if it already does), then enrolls it in the given
 * campaign via POST /v3/contacts/{id}/move-to-sequence — this is what
 * actually makes Reply.io start emailing them.
 */
export async function addContactToCampaign(
  campaignId: string,
  contact: ReplyIoContactInput,
): Promise<AddContactToCampaignResult> {
  if (!REPLY_IO_API_KEY) {
    log.info('replyIoService: addContactToCampaign skipped — REPLY_IO_API_KEY not set');
    return { configured: false, success: false, reason: 'Reply.io is not configured' };
  }

  if (!contact.email) {
    // Reply.io requires at minimum an email or a LinkedIn URL to create a
    // contact (docs.reply.io/api-reference/contacts/create-a-contact) — the
    // Outreach board's Send action is email-only today, so no email means
    // there's nothing to submit.
    return { configured: true, success: false, reason: 'Contact has no email address' };
  }

  const sequenceId = Number(campaignId);
  if (!Number.isFinite(sequenceId)) {
    return { configured: true, success: false, reason: 'Invalid campaignId' };
  }

  try {
    const { firstName, lastName } = splitName(contact.name);
    let contactId = await createReplyIoContact({
      email: contact.email,
      firstName,
      lastName,
      company: contact.company,
      phone: contact.phone,
      linkedInUrl: contact.linkedinUrl,
    });

    if (contactId === null) {
      contactId = await findReplyIoContactByEmail(contact.email);
    }

    if (contactId === null) {
      return { configured: true, success: false, error: 'Could not create or find this contact in Reply.io' };
    }

    const moveRes = await fetchWithTimeout(
      `${REPLY_IO_BASE_URL}/contacts/${contactId}/move-to-sequence`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ sequenceId }),
      },
      15000,
    );

    if (!moveRes.ok) {
      const body = await moveRes.text().catch(() => '');
      log.warn('replyIoService: move-to-sequence failed', { status: moveRes.status, body: body.slice(0, 500) });
      return {
        configured: true,
        success: false,
        error: `Reply.io returned HTTP ${moveRes.status} adding the contact to the campaign`,
      };
    }

    return { configured: true, success: true, replyIoContactId: contactId };
  } catch (err) {
    log.warn('replyIoService: addContactToCampaign threw', { error: errMessage(err) });
    return { configured: true, success: false, error: errMessage(err) };
  }
}

// ─── On-demand reply sync — researched against Reply.io's own docs, Aug 2026 ───
//
// Same problem as legalDocSignaturePollService.ts: the registered-webhook
// path (routes/outreach-webhooks.ts) needs a stable public URL that this
// deployment doesn't have yet (PR-preview Vercel URLs aren't practical to
// register with Reply.io). Until there's a verified prod domain, reply
// detection has to work by on-demand polling instead — this section is that
// poll, mirroring legalDocSignaturePollService.pollOrgSignatures's shape
// (an on-demand batch check, callable by a human now and a cron later).
//
// Reply.io v3 does NOT expose a "does this contact have status=replied"
// endpoint that also returns reply text/date, and nothing is batchable by a
// list of contacts. Endpoints actually considered (all under
// https://docs.reply.io/api-reference/):
//
//   - GET /v3/contacts/{id}/statuses — returns a per-sequence
//     `emailDisposition.isReplied` boolean. Rejected: single-contact only
//     (no batch), no reply text, no reply timestamp at all. Also requires a
//     Reply.io contact id, which this codebase never stores (OutreachContact
//     only persists replyIoCampaignId, not a per-contact id) — using this
//     endpoint would mean an extra lookup call per contact just to get an id
//     to poll with.
//   - GET /v3/contacts/{id}/activities — generic activity feed
//     (`activityType`/`sourceType`/free-form `content`), not documented as
//     reply-specific and still single-contact/no-email-matching.
//   - POST /v3/contacts/mark-or-unmark-as-replied — a WRITE endpoint (lets
//     you set the flag), not a read path.
//
// What this uses instead — the Inbox surface ("Replies handled through the
// unified Inbox" per the docs' own API index):
//
//   1. POST /v3/inbox/threads/filter — batch, date-bounded
//      (docs.reply.io/api-reference/inbox/filter-inbox-threads). Body takes
//      `channels` + a `from`/`to` ISO 8601 date-time range filtered against
//      each thread's `lastActivityDate`; response items include
//      `contact.email` (so threads map back to OutreachContact rows without
//      needing a stored Reply.io contact id) and `lastActivityDate`, but
//      only a truncated `bodyPreview` of the last message — not reliably the
//      full reply text, and "last message" isn't necessarily inbound (could
//      be our own follow-up).
//   2. GET /v3/inbox/threads/{id}/messages — per-thread message history
//      (docs.reply.io/api-reference/inbox/list-messages-in-an-inbox-thread).
//      Each message has `isOutbound` (true = sent by us, false = received)
//      plus `date` and `body` (full text, "may contain HTML"). Called once
//      per thread that (1) matched a tracked contact by email and (2) has
//      lastActivityDate after that contact's cutoff — not for every thread
//      returned by step 1 — to pull out the latest genuinely inbound message
//      and confirm it's actually new (a thread's most recent activity can be
//      an outbound send, which isn't a reply at all).
//
// This gives text + date + batch-by-email in two calls per sync run (plus
// one extra call per thread that actually has new activity), which is the
// closest thing v3 has to "list new replies since X" without a webhook.

const INBOX_PAGE_SIZE = 500;
const INBOX_MAX_PAGES = 3; // bounded — up to 1,500 threads per sync run, ample for this org's volume

export interface ReplyIoContactRef {
  /** OutreachContact.id (our DB id) — NOT a Reply.io id. */
  contactId: string;
  email: string | null;
  /** ISO timestamp. Prefer this as the "since" cutoff when set. */
  lastReplyAt?: string | null;
  /** ISO timestamp. Fallback cutoff when the contact has never replied. */
  sentAt?: string | null;
}

export interface NewReplyFound {
  contactId: string;
  /** Plain text, HTML tags stripped. Null if Reply.io returned no body. */
  replyText: string | null;
  /** ISO timestamp of the reply message itself. */
  replyDate: string;
}

export interface CheckForNewRepliesResult {
  configured: boolean;
  replies: NewReplyFound[];
  /** Set when configured=true but the live call to Reply.io failed. */
  error?: string;
}

/** Strips HTML tags and collapses whitespace — thread messages "may contain
 *  HTML" per Reply.io's docs; lastReplyText elsewhere in this feature (the
 *  webhook path's `email_text`) is plain text, so this keeps both paths'
 *  stored text consistent and keeps the classifier prompt clean. */
function stripHtml(input: string): string {
  return input
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetches the latest genuinely INBOUND message in a thread that's newer
 * than `sinceMs`, or null if there isn't one (e.g. the thread's most recent
 * activity was actually our own outbound follow-up). top=100 is generous
 * for a single email thread; Reply.io's own default page ordering is
 * oldest-first per the docs, so this scans the full page for the max date
 * rather than assuming the last item is newest.
 */
async function latestInboundMessageSince(
  threadId: number,
  sinceMs: number,
): Promise<{ body: string | null; date: string } | null> {
  const res = await fetchWithTimeout(
    `${REPLY_IO_BASE_URL}/inbox/threads/${threadId}/messages?top=100`,
    { headers: authHeaders() },
    15000,
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    log.warn('replyIoService: list thread messages failed', { threadId, status: res.status, body: body.slice(0, 500) });
    return null;
  }

  const data: any = await res.json().catch(() => null);
  const items: any[] = Array.isArray(data?.items) ? data.items : [];

  let latest: { body: string | null; date: string; ms: number } | null = null;
  for (const msg of items) {
    if (msg?.isOutbound) continue;
    const ms = Date.parse(msg?.date);
    if (Number.isNaN(ms) || ms <= sinceMs) continue;
    if (!latest || ms > latest.ms) {
      const rawBody = typeof msg.body === 'string' ? msg.body : null;
      latest = { body: rawBody ? stripHtml(rawBody) : null, date: new Date(ms).toISOString(), ms };
    }
  }

  return latest ? { body: latest.body, date: latest.date } : null;
}

/**
 * Given a batch of OutreachContact rows that have been sent via Reply.io,
 * checks for any reply newer than each contact's cutoff (lastReplyAt if
 * they've replied before, else sentAt) and returns the ones with a new
 * reply + its text/date. Never throws — same soft-fail idiom as
 * addContactToCampaign: not-configured and upstream failures both come back
 * as a result object, not an exception.
 */
export async function checkForNewReplies(contacts: ReplyIoContactRef[]): Promise<CheckForNewRepliesResult> {
  if (!REPLY_IO_API_KEY) {
    log.info('replyIoService: checkForNewReplies skipped — REPLY_IO_API_KEY not set');
    return { configured: false, replies: [] };
  }

  // Per-contact cutoff, keyed by lowercased email (Reply.io inbox threads
  // are matched back to our contacts by contact.email — see module header).
  // Contacts without an email or without any cutoff to measure "new"
  // against (never sent, so no sentAt) are silently excluded, not errored.
  const cutoffByEmail = new Map<string, { contactId: string; sinceMs: number }>();
  for (const c of contacts) {
    if (!c.email) continue;
    const since = c.lastReplyAt || c.sentAt;
    if (!since) continue;
    const sinceMs = Date.parse(since);
    if (Number.isNaN(sinceMs)) continue;
    cutoffByEmail.set(c.email.toLowerCase(), { contactId: c.contactId, sinceMs });
  }

  if (cutoffByEmail.size === 0) {
    return { configured: true, replies: [] };
  }

  const globalSinceMs = Math.min(...Array.from(cutoffByEmail.values()).map((v) => v.sinceMs));

  try {
    const threads: any[] = [];
    let skip = 0;
    for (let page = 0; page < INBOX_MAX_PAGES; page++) {
      const res = await fetchWithTimeout(
        `${REPLY_IO_BASE_URL}/inbox/threads/filter?top=${INBOX_PAGE_SIZE}&skip=${skip}`,
        {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            channels: ['email'],
            from: new Date(globalSinceMs).toISOString(),
          }),
        },
        15000,
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log.warn('replyIoService: filter inbox threads failed', { status: res.status, body: body.slice(0, 500) });
        return { configured: true, replies: [], error: `Reply.io returned HTTP ${res.status}` };
      }

      const data: any = await res.json().catch(() => null);
      const items: any[] = Array.isArray(data?.items) ? data.items : [];
      threads.push(...items);

      if (!data?.hasMore || items.length === 0) break;
      skip += INBOX_PAGE_SIZE;
    }

    const replies: NewReplyFound[] = [];

    for (const thread of threads) {
      const email: string | undefined = thread?.contact?.email;
      if (!email) continue;

      const match = cutoffByEmail.get(email.toLowerCase());
      if (!match) continue; // thread belongs to a contact we're not tracking, or already checked

      const lastActivityMs = Date.parse(thread?.lastActivityDate);
      if (Number.isNaN(lastActivityMs) || lastActivityMs <= match.sinceMs) continue;

      const inbound = await latestInboundMessageSince(thread.id, match.sinceMs);
      if (!inbound) continue; // thread has new activity, but it was outbound (not a reply)

      replies.push({ contactId: match.contactId, replyText: inbound.body, replyDate: inbound.date });
    }

    return { configured: true, replies };
  } catch (err) {
    log.warn('replyIoService: checkForNewReplies threw', { error: errMessage(err) });
    return { configured: true, replies: [], error: errMessage(err) };
  }
}

// ─── Webhook secret verification ────────────────────────────────────

/**
 * Verifies the shared secret Reply.io echoes back on every inbound webhook
 * call (as a URL path segment — see routes/outreach-webhooks.ts). Reply.io
 * has no native signing (see module header above for the full research
 * trail) — this is our own scheme, not theirs. Constant-time comparison,
 * same pattern as integrations/dropboxSign/client.ts's verifyWebhookEvent.
 *
 * Fails CLOSED: returns false whenever REPLY_IO_WEBHOOK_SECRET isn't
 * configured, or the provided value is missing/empty — an unconfigured
 * secret must never be treated as "anything passes".
 */
export function verifyReplyIoWebhookSecret(provided: string | undefined | null): boolean {
  if (!REPLY_IO_WEBHOOK_SECRET || !provided) return false;

  const expectedBuf = Buffer.from(REPLY_IO_WEBHOOK_SECRET, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}
