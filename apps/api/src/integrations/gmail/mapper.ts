import type { GmailMessage, GmailMessagePart } from './types.js';

export interface ParsedAddress {
  name: string | null;
  email: string;
}

export interface GmailIntegrationActivityRow {
  integrationId: string;
  organizationId: string;
  userId: string;
  source: 'gmail';
  externalId: string;
  type: 'EMAIL';
  dealIds: string[];
  contactIds: string[];
  title: string;
  summary: string;
  occurredAt: string;
  durationSeconds: number | null;
  metadata: Record<string, unknown>;
  aiExtraction: null;
  rawTranscript: string;
}

export function parseEmailAddress(s: string): ParsedAddress | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/);
  if (m) {
    return { name: m[1]?.trim() || null, email: m[2].trim().toLowerCase() };
  }
  // Plain email
  if (/^[^@\s]+@[^@\s]+$/.test(trimmed)) {
    return { name: null, email: trimmed.toLowerCase() };
  }
  return null;
}

function parseAddressList(s: string | undefined): ParsedAddress[] {
  if (!s) return [];
  return s.split(',').map(p => parseEmailAddress(p)).filter((x): x is ParsedAddress => !!x);
}

function header(message: GmailMessage, name: string): string | undefined {
  return message.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function occurredAtFor(message: GmailMessage): string {
  if (message.internalDate) {
    const ms = Number(message.internalDate);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const dateHeader = header(message, 'Date');
  if (dateHeader) {
    const t = Date.parse(dateHeader);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

export function gmailMessageToIntegrationActivity(params: {
  message: GmailMessage;
  integrationId: string;
  organizationId: string;
  userId: string;
  dealIds: string[];
  contactIds: string[];
}): GmailIntegrationActivityRow {
  const { message, integrationId, organizationId, userId, dealIds, contactIds } = params;

  const subject = header(message, 'Subject') ?? '(no subject)';
  const fromHeader = header(message, 'From');
  const toHeader = header(message, 'To');
  const ccHeader = header(message, 'Cc');
  const messageId = header(message, 'Message-ID');
  const inReplyTo = header(message, 'In-Reply-To');

  return {
    integrationId,
    organizationId,
    userId,
    source: 'gmail',
    externalId: message.id,
    type: 'EMAIL',
    dealIds,
    contactIds,
    title: subject,
    summary: message.snippet ?? '',
    occurredAt: occurredAtFor(message),
    durationSeconds: null,
    metadata: {
      threadId: message.threadId,
      messageId: messageId ?? null,
      inReplyTo: inReplyTo ?? null,
      from: fromHeader ? parseEmailAddress(fromHeader) : null,
      to: parseAddressList(toHeader),
      cc: parseAddressList(ccHeader),
      labels: message.labelIds ?? [],
    },
    aiExtraction: null,
    rawTranscript: '',
  };
}

export function extractAddressEmails(message: GmailMessage): string[] {
  const all: string[] = [];
  const fromHeader = header(message, 'From');
  if (fromHeader) {
    const parsed = parseEmailAddress(fromHeader);
    if (parsed) all.push(parsed.email);
  }
  for (const h of ['To', 'Cc']) {
    const v = header(message, h);
    parseAddressList(v).forEach(a => all.push(a.email));
  }
  return all;
}

// Headers helper exposed for callers that need raw header lookup
// (pre-filter inspects Auto-Submitted, List-Id, etc.).
export function getHeaderMap(message: GmailMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of message.payload?.headers ?? []) {
    out[h.name] = h.value;
  }
  return out;
}

function decodeBase64Url(data: string): string {
  // Gmail returns body data as base64url. Node's Buffer accepts the alphabet
  // but not the padding rules — normalize first.
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  try {
    return Buffer.from(normalized + pad, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// Walks the (possibly nested) MIME tree and returns the first non-empty plain-text
// body it finds, falling back to a stripped HTML body. Skips attachment parts.
export function extractBodyText(message: GmailMessage): string {
  const collectByMime = (mime: string): string => {
    const found: string[] = [];
    const walk = (part: GmailMessagePart | undefined): void => {
      if (!part) return;
      const isAttachment = !!(part.filename && part.filename.length > 0);
      if (!isAttachment && part.mimeType === mime && part.body?.data) {
        const decoded = decodeBase64Url(part.body.data);
        if (decoded.trim().length > 0) found.push(decoded);
      }
      for (const sub of part.parts ?? []) walk(sub);
    };
    walk(message.payload);
    return found.join('\n').trim();
  };

  const plain = collectByMime('text/plain');
  if (plain.length > 0) return plain;
  const html = collectByMime('text/html');
  if (html.length > 0) return htmlToText(html);
  return (message.snippet ?? '').trim();
}
