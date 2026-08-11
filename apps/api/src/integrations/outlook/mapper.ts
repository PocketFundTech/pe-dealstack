import type { GraphMessage, GraphRecipient } from './types.js';

export interface OutlookIntegrationActivityRow {
  integrationId: string;
  organizationId: string;
  userId: string;
  source: 'outlook';
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

function recipientEmail(r: GraphRecipient | undefined): string | null {
  const addr = r?.emailAddress?.address;
  return addr ? addr.trim().toLowerCase() : null;
}

function recipientObj(r: GraphRecipient | undefined): { name: string | null; email: string } | null {
  const email = recipientEmail(r);
  if (!email) return null;
  return { name: r?.emailAddress?.name?.trim() || null, email };
}

function occurredAtFor(message: GraphMessage): string {
  if (message.receivedDateTime) {
    const t = Date.parse(message.receivedDateTime);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

// All participant emails (from + to + cc), lowercased — used to match the
// message against known Contacts/Deals.
export function extractAddressEmails(message: GraphMessage): string[] {
  const out: string[] = [];
  const from = recipientEmail(message.from) ?? recipientEmail(message.sender);
  if (from) out.push(from);
  for (const r of message.toRecipients ?? []) {
    const e = recipientEmail(r);
    if (e) out.push(e);
  }
  for (const r of message.ccRecipients ?? []) {
    const e = recipientEmail(r);
    if (e) out.push(e);
  }
  return out;
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

// Body text for the classifier: prefer the full body (HTML stripped),
// falling back to the short bodyPreview Graph returns on list calls.
export function extractBodyText(message: GraphMessage): string {
  const content = message.body?.content;
  if (content && content.trim().length > 0) {
    return message.body?.contentType === 'html' ? htmlToText(content) : content.trim();
  }
  return (message.bodyPreview ?? '').trim();
}

export function outlookMessageToIntegrationActivity(params: {
  message: GraphMessage;
  integrationId: string;
  organizationId: string;
  userId: string;
  dealIds: string[];
  contactIds: string[];
}): OutlookIntegrationActivityRow {
  const { message, integrationId, organizationId, userId, dealIds, contactIds } = params;
  return {
    integrationId,
    organizationId,
    userId,
    source: 'outlook',
    externalId: message.id,
    type: 'EMAIL',
    dealIds,
    contactIds,
    title: message.subject || '(no subject)',
    summary: message.bodyPreview ?? '',
    occurredAt: occurredAtFor(message),
    durationSeconds: null,
    metadata: {
      conversationId: message.conversationId ?? null,
      internetMessageId: message.internetMessageId ?? null,
      from: recipientObj(message.from) ?? recipientObj(message.sender),
      to: (message.toRecipients ?? []).map(recipientObj).filter(Boolean),
      cc: (message.ccRecipients ?? []).map(recipientObj).filter(Boolean),
    },
    aiExtraction: null,
    rawTranscript: '',
  };
}
