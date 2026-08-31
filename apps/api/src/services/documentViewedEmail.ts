// ─── Document viewed email ─────────────────────────────────────────
// Sent once per share link — the very first time an external viewer opens
// a shared deal through the public portal (see routes/portal.ts's
// fire-and-forget notify helper, which gates this to the first
// DealShareView row for a given share).
//
// Null-safe on RESEND_API_KEY exactly like welcomeEmail.ts and
// docRequestEmail.ts: a missing key logs and returns false, it never
// throws into the caller.

import { Resend } from 'resend';
import { log } from '../utils/logger.js';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export interface DocumentViewedEmailInput {
  to: string;
  name?: string | null;
  dealName: string;
  /** A share doesn't require a label — falls back to generic copy when absent. */
  shareLabel?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send the "your shared deal was viewed" notice. Callers (routes/portal.ts)
 * only invoke this for a share's first-ever view — repeat views never call
 * in again. Returns true when the mail was handed to Resend, false when
 * email isn't configured or the send failed; the caller treats either as a
 * silent no-op since this is purely informational.
 */
export async function sendDocumentViewedEmail(input: DocumentViewedEmailInput): Promise<boolean> {
  if (!resend) {
    log.warn('Resend not configured — document viewed email skipped', { to: input.to });
    return false;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const trimmedName = input.name?.trim();
  const firstName = trimmedName ? escapeHtml(trimmedName.split(' ')[0]) : 'there';
  const dealName = escapeHtml(input.dealName);
  const trimmedLabel = input.shareLabel?.trim();
  const shareDescription = trimmedLabel
    ? `Your &ldquo;${escapeHtml(trimmedLabel)}&rdquo; share link`
    : 'Your shared deal';

  try {
    const { error } = await resend.emails.send({
      from: `Avise <${fromEmail}>`,
      to: input.to,
      subject: `${dealName} was just viewed`,
      html: `
        <div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
          <p>Hi ${firstName},</p>
          <p>${shareDescription} for <strong>${dealName}</strong> was just opened for the first time.</p>
          <p style="color:#6B7280;font-size:13px;">This is a one-time notice &mdash; you won't be emailed again for later views of this link.</p>
          <p style="margin-top:24px;">&mdash; The Avise Team</p>
        </div>
      `,
    });

    if (error) {
      log.error('Document viewed email failed', { error });
      return false;
    }
    return true;
  } catch (err) {
    log.error('Document viewed email threw', { err });
    return false;
  }
}
