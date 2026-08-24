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
