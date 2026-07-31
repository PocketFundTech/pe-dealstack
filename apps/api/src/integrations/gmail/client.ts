import { log } from '../../utils/logger.js';
import type {
  GmailAttachmentMeta,
  GmailListMessagesResponse,
  GmailMessage,
  GmailMessageFull,
  GmailMessagePart,
  GmailTokenResponse,
  GmailUserInfo,
} from './types.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

function googleClientCreds(): { id: string; secret: string } {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured');
  return { id, secret };
}

export function buildAuthorizeUrl(params: {
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const { id } = googleClientCreds();
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('client_id', id);
  u.searchParams.set('redirect_uri', params.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', (params.scopes ?? GMAIL_SCOPES).join(' '));
  u.searchParams.set('state', params.state);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  return u.toString();
}

export async function exchangeCode(code: string, redirectUri: string): Promise<GmailTokenResponse> {
  const { id, secret } = googleClientCreds();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: id,
    client_secret: secret,
    redirect_uri: redirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail token exchange failed: ${res.status} ${text}`);
  }
  return (await res.json()) as GmailTokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<GmailTokenResponse> {
  const { id, secret } = googleClientCreds();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: id,
    client_secret: secret,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail token refresh failed: ${res.status} ${text}`);
  }
  return (await res.json()) as GmailTokenResponse;
}

export async function getUserInfo(accessToken: string): Promise<GmailUserInfo> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail userinfo failed: ${res.status} ${text}`);
  }
  return (await res.json()) as GmailUserInfo;
}

export async function listMessagesSince(
  accessToken: string,
  since: Date,
  knownEmails: string[]
): Promise<{ id: string; threadId: string }[]> {
  if (knownEmails.length === 0) return [];
  const afterUnix = Math.floor(since.getTime() / 1000);
  const orClause = knownEmails
    .map(e => `from:${e} OR to:${e} OR cc:${e}`)
    .join(' OR ');
  const q = `after:${afterUnix} (${orClause})`;

  const out: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined = undefined;
  let pageCount = 0;
  const MAX_PAGES = 20;
  do {
    const params = new URLSearchParams({ q, maxResults: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${GMAIL_BASE}/messages?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gmail listMessages failed: ${res.status} ${text}`);
    }
    const page = (await res.json()) as GmailListMessagesResponse;
    if (page.messages) out.push(...page.messages);
    pageToken = page.nextPageToken;
    pageCount++;
    if (pageCount >= MAX_PAGES) {
      log.warn('gmail: listMessagesSince hit MAX_PAGES, stopping early', { pageCount });
      break;
    }
  } while (pageToken);
  return out;
}

export async function getMessage(accessToken: string, messageId: string): Promise<GmailMessage> {
  const url = `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date&metadataHeaders=Message-ID&metadataHeaders=In-Reply-To`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail getMessage failed: ${res.status} ${text}`);
  }
  return (await res.json()) as GmailMessage;
}

// ─── helpers for getMessageFull ────────────────────────────────────────

function stripHtmlTags(html: string): string {
  // Drop <style>, <script> blocks entirely, then strip remaining tags,
  // collapse whitespace, and decode the handful of HTML entities that
  // commonly survive Gmail's HTML pipeline.
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeBase64UrlBody(data: string | undefined): string {
  if (!data) return '';
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Walk a Gmail MIME tree collecting text/plain bodies. Falls back to text/html
 * (with tags stripped) when no plaintext part exists.
 */
function extractBodyFromPayload(payload: GmailMessagePart | undefined, maxLen = 4000): string {
  if (!payload) return '';
  const textParts: string[] = [];
  const htmlParts: string[] = [];

  const walk = (part: GmailMessagePart) => {
    const mime = (part.mimeType ?? '').toLowerCase();
    if (mime === 'text/plain' && part.body?.data) {
      textParts.push(decodeBase64UrlBody(part.body.data));
    } else if (mime === 'text/html' && part.body?.data) {
      htmlParts.push(decodeBase64UrlBody(part.body.data));
    }
    if (part.parts && part.parts.length) {
      for (const child of part.parts) walk(child);
    }
  };
  walk(payload);

  let combined = textParts.join('\n').trim();
  if (!combined && htmlParts.length) {
    combined = stripHtmlTags(htmlParts.join('\n')).trim();
  }
  if (combined.length > maxLen) combined = combined.slice(0, maxLen) + '…';
  return combined;
}

/**
 * Walk the MIME tree and collect named attachments that have a fetchable
 * attachmentId. extractBodyFromPayload deliberately ignores these; callers that
 * want attachment bytes (e.g. PDF teasers) use this + getAttachment().
 */
function collectAttachments(payload: GmailMessagePart | undefined): GmailAttachmentMeta[] {
  if (!payload) return [];
  const out: GmailAttachmentMeta[] = [];
  const walk = (part: GmailMessagePart) => {
    const attachmentId = part.body?.attachmentId;
    const filename = (part.filename ?? '').trim();
    if (attachmentId && filename) {
      out.push({
        attachmentId,
        filename,
        mimeType: (part.mimeType ?? '').toLowerCase(),
        size: part.body?.size ?? 0,
      });
    }
    if (part.parts?.length) {
      for (const child of part.parts) walk(child);
    }
  };
  walk(payload);
  return out;
}

function headerValue(headers: GmailMessagePart['headers'], name: string): string {
  if (!headers) return '';
  const wanted = name.toLowerCase();
  const found = headers.find(h => (h.name ?? '').toLowerCase() === wanted);
  return found?.value ?? '';
}

/**
 * Fetch a Gmail message with format=full and parse a plain-text body (≤4000 chars)
 * plus the headers most useful for follow-up extraction.
 */
export async function getMessageFull(
  accessToken: string,
  messageId: string
): Promise<GmailMessageFull> {
  const url = `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=full`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail getMessageFull failed: ${res.status} ${text}`);
  }
  const msg = (await res.json()) as GmailMessage;
  const headers = msg.payload?.headers;
  return {
    id: msg.id,
    threadId: msg.threadId,
    snippet: msg.snippet ?? '',
    body: extractBodyFromPayload(msg.payload, 4000),
    attachments: collectAttachments(msg.payload),
    headers: {
      Subject: headerValue(headers, 'Subject'),
      From: headerValue(headers, 'From'),
      To: headerValue(headers, 'To'),
      Cc: headerValue(headers, 'Cc'),
      Date: headerValue(headers, 'Date'),
      MessageId: headerValue(headers, 'Message-ID'),
      InReplyTo: headerValue(headers, 'In-Reply-To'),
    },
  };
}

/**
 * Download a single attachment's bytes. The Gmail API returns base64url-encoded
 * data; we decode straight to a Buffer for PDF/text extraction. gmail.readonly
 * already permits this — no extra scope.
 */
export async function getAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const url = `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail getAttachment failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { data?: string; size?: number };
  if (!json.data) throw new Error('Gmail getAttachment: empty attachment data');
  return Buffer.from(json.data, 'base64url');
}

/**
 * Like listMessagesSince but the Gmail query also OR-matches the deal's
 * company name (subject + body text). At least one of knownEmails / companyTerms
 * must be non-empty; if both are empty, returns [].
 *
 * Caps total results at `cap` (default 50) to keep token budget bounded.
 */
export async function listMessagesForDeal(
  accessToken: string,
  since: Date,
  knownEmails: string[],
  companyTerms: string[],
  cap = 50
): Promise<{ id: string; threadId: string }[]> {
  const emails = Array.from(new Set(knownEmails.filter(Boolean)));
  const terms = Array.from(new Set(companyTerms.map(t => t.trim()).filter(Boolean)));
  if (emails.length === 0 && terms.length === 0) return [];

  const afterUnix = Math.floor(since.getTime() / 1000);
  const orParts: string[] = [];
  if (emails.length > 0) {
    orParts.push(emails.map(e => `from:${e} OR to:${e} OR cc:${e}`).join(' OR '));
  }
  if (terms.length > 0) {
    // Quote each term so multi-word names match as a phrase. Search both
    // subject: and free-text (Gmail does a full-content match for bare terms).
    const quoted = terms.map(t => `"${t.replace(/"/g, '')}"`);
    const subjClause = quoted.map(q => `subject:${q}`).join(' OR ');
    const bodyClause = quoted.join(' OR ');
    orParts.push(`${subjClause} OR ${bodyClause}`);
  }
  const q = `after:${afterUnix} (${orParts.map(p => `(${p})`).join(' OR ')})`;

  const out: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined = undefined;
  let pageCount = 0;
  const MAX_PAGES = 5;
  do {
    const remaining = cap - out.length;
    if (remaining <= 0) break;
    const params = new URLSearchParams({
      q,
      maxResults: String(Math.min(100, remaining)),
    });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${GMAIL_BASE}/messages?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gmail listMessagesForDeal failed: ${res.status} ${text}`);
    }
    const page = (await res.json()) as GmailListMessagesResponse;
    if (page.messages) {
      for (const m of page.messages) {
        out.push(m);
        if (out.length >= cap) break;
      }
    }
    pageToken = page.nextPageToken;
    pageCount++;
    if (pageCount >= MAX_PAGES) {
      log.warn('gmail: listMessagesForDeal hit MAX_PAGES, returning partial', { pageCount, returned: out.length });
      break;
    }
  } while (pageToken && out.length < cap);
  return out.slice(0, cap);
}

// Language common in sourcing / intro emails from bankers, brokers, AND the
// off-market deal-sourcing firms that dominate real inbound (Pocket Fund style
// "here are this week's opportunities" emails). Used to keyword-scope the broad
// inbox scan so we don't fetch + AI-extract every email. Kept intentionally
// wide for RECALL — the per-email signal score (inboxDealSignals.ts) is the
// PRECISION gate that drops anything that merely brushes one of these terms.
export const DEAL_SOURCING_TERMS = [
  // Bank / broker CIM language
  'confidential information memorandum',
  'CIM',
  'teaser',
  'information memorandum',
  'investment opportunity',
  'acquisition opportunity',
  'for sale',
  'off-market',
  'enterprise value',
  'EBITDA',
  'buyout',
  // Off-market / SaaS sourcing language (the majority of real inbound)
  'MRR',
  'ARR',
  'asking price',
  'seeking a buyer',
  'majority buyout',
  'one-pager',
  'deal flow',
  'acquisition opportunities',
];

// Attachment-FILENAME signals. Gmail free-text search does NOT match attachment
// filenames — only the explicit `filename:` operator does — so a teaser/CIM sent
// as "please find the attached" + a deck, with no deal keywords in the body, is
// invisible to DEAL_SOURCING_TERMS above. These catch the file itself. Kept tight
// to deal-document names (not a blanket has:attachment) so the scan isn't flooded
// with every invoice/receipt/signature PDF.
export const DEAL_ATTACHMENT_FILENAME_TERMS = [
  'cim',
  'teaser',
  'memorandum',
  'one-pager',
  'onepager',
  'tearsheet',
  'tear-sheet',
];

/**
 * Broad inbox query for NEW deal candidates — powers the dashboard inbox scan.
 * Unlike listMessagesSince / listMessagesForDeal, this does NOT require known
 * contact emails (a brand-new deal has no contacts yet). It keyword-scopes to
 * deal-sourcing language and drops Gmail's promotions/social buckets to cut
 * newsletter noise. Caps total results at `cap`.
 */
export async function listRecentDealCandidates(
  accessToken: string,
  since: Date,
  cap = 15
): Promise<{ id: string; threadId: string }[]> {
  const afterUnix = Math.floor(since.getTime() / 1000);
  const keywordClause = DEAL_SOURCING_TERMS
    .map(t => (t.includes(' ') ? `"${t}"` : t))
    .join(' OR ');
  // OR in attachment-filename matches so an email whose ONLY deal signal is a
  // CIM/teaser attachment (empty/uninformative body) still enters the scan.
  const filenameClause = DEAL_ATTACHMENT_FILENAME_TERMS
    .map(t => (t.includes(' ') ? `filename:"${t}"` : `filename:${t}`))
    .join(' OR ');
  const q = `after:${afterUnix} ((${keywordClause}) OR (${filenameClause})) -category:promotions -category:social -in:chats`;

  const out: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined = undefined;
  let pageCount = 0;
  const MAX_PAGES = 3;
  do {
    const remaining = cap - out.length;
    if (remaining <= 0) break;
    const params = new URLSearchParams({ q, maxResults: String(Math.min(100, remaining)) });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${GMAIL_BASE}/messages?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gmail listRecentDealCandidates failed: ${res.status} ${text}`);
    }
    const page = (await res.json()) as GmailListMessagesResponse;
    if (page.messages) {
      for (const m of page.messages) {
        out.push(m);
        if (out.length >= cap) break;
      }
    }
    pageToken = page.nextPageToken;
    pageCount++;
    if (pageCount >= MAX_PAGES) break;
  } while (pageToken && out.length < cap);
  return out.slice(0, cap);
}

// format=full returns the raw message payload with body parts (base64url-encoded),
// for callers that parse the MIME tree themselves (extractBodyText/getHeaderMap in
// mapper.ts — the auto-deal classifier flow). getMessageFull above returns a
// pre-parsed view instead. Costs ~5x more bytes than format=metadata, so only
// call this when the pre-filter has already decided the message is worth classifying.
export async function getMessageRaw(accessToken: string, messageId: string): Promise<GmailMessage> {
  const url = `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=full`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail getMessageRaw failed: ${res.status} ${text}`);
  }
  return (await res.json()) as GmailMessage;
}
