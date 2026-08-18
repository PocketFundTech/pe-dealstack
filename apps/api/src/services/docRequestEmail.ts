// ─── Document request emails ──────────────────────────────────────
// The outbound half of the request loop: a broker or seller gets a link,
// drops files on it, and never creates an account. Shared by the create
// route, the manual "Remind" button, and the nightly reminder cron so the
// three never drift apart.
//
// Null-safe on RESEND_API_KEY exactly like routes/invitations.ts and
// deals-share.ts: a missing key logs and returns false, it never throws
// into the caller's request.

import { Resend } from 'resend';
import { log } from '../utils/logger.js';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export interface DocRequestEmailInput {
  to: string;
  recipientName?: string | null;
  dealName: string;
  firmName?: string | null;
  message?: string | null;
  url: string;
  items: Array<{ label: string; required: boolean; fulfilledAt?: string | null }>;
  /** Reminder copy instead of first-contact copy. */
  isReminder?: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderChecklist(items: DocRequestEmailInput['items']): string {
  if (items.length === 0) return '';
  const rows = items
    .map((i) => {
      const done = !!i.fulfilledAt;
      const mark = done ? '&#10003;' : '&bull;';
      const style = done ? 'color:#6B7280;text-decoration:line-through;' : 'color:#111827;';
      const optional = i.required ? '' : ' <span style="color:#6B7280;">(optional)</span>';
      return `<li style="${style}margin:4px 0;">${mark} ${escapeHtml(i.label)}${optional}</li>`;
    })
    .join('');
  return `<ul style="list-style:none;padding-left:0;margin:16px 0;">${rows}</ul>`;
}

/**
 * Send (or re-send) a document request. Returns true when the mail was
 * handed to Resend, false when email isn't configured or the send failed —
 * callers treat a false as "link created, tell the user to copy it".
 */
export async function sendDocRequestEmail(input: DocRequestEmailInput): Promise<boolean> {
  const outstanding = input.items.filter((i) => !i.fulfilledAt);

  if (!resend) {
    log.warn('Resend not configured — doc request email skipped', { url: input.url });
    return false;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const firm = input.firmName || 'A deal team';
  const greeting = input.recipientName ? `Hi ${escapeHtml(input.recipientName)},` : 'Hi,';
  const subject = input.isReminder
    ? `Reminder: documents requested for ${input.dealName}`
    : `Document request — ${input.dealName}`;
  const lede = input.isReminder
    ? `Following up on the documents ${escapeHtml(firm)} requested for <strong>${escapeHtml(input.dealName)}</strong>.`
    : `${escapeHtml(firm)} has requested some documents for <strong>${escapeHtml(input.dealName)}</strong>.`;

  try {
    const { error } = await resend.emails.send({
      from: fromEmail,
      to: input.to,
      subject,
      html: `
        <div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
          <p>${greeting}</p>
          <p>${lede}</p>
          ${input.message ? `<p style="padding:12px 16px;background:#F8F9FA;border-left:3px solid #003366;">${escapeHtml(input.message)}</p>` : ''}
          <p style="margin-top:24px;font-weight:600;">${input.isReminder ? 'Still outstanding' : 'What we need'}:</p>
          ${renderChecklist(input.isReminder ? outstanding : input.items)}
          <p style="margin:28px 0;">
            <a href="${input.url}"
               style="background-color:#003366;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:600;">
              Upload documents
            </a>
          </p>
          <p style="color:#6B7280;font-size:13px;">
            No account or password needed — the link opens straight to an upload page.
            It's private to you, so please don't forward it.
          </p>
        </div>
      `,
    });

    if (error) {
      log.error('Doc request email failed', { error });
      return false;
    }
    return true;
  } catch (err) {
    log.error('Doc request email threw', { err });
    return false;
  }
}
