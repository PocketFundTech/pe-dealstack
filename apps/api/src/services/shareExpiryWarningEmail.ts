// ─── Share-link expiring-soon warning email ───────────────────────
// Sent by the nightly cron (routes/cron-share-expiry-warnings.ts) roughly
// 48 hours before a DealShare link's expiresAt. Purely informational: the
// only consequence of the link expiring is that the recipient loses access
// to the shared deal — no countdown, no "act now", no button. Null-safe on
// RESEND_API_KEY exactly like welcomeEmail.ts and docRequestEmail.ts.

import { Resend } from 'resend';
import { log } from '../utils/logger.js';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export interface ShareExpiryWarningEmailInput {
  to: string;
  name?: string | null;
  dealName: string;
  shareLabel?: string | null;
  expiresAt: Date;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatExpiry(expiresAt: Date): string {
  return expiresAt.toLocaleString('en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  }) + ' UTC';
}

/**
 * Send the "your shared link expires soon" warning. Returns true when the
 * mail was handed to Resend, false when email isn't configured or the send
 * failed — the cron route treats either as "don't mark this row warned,
 * try again on a later run".
 */
export async function sendShareExpiryWarningEmail(
  input: ShareExpiryWarningEmailInput,
): Promise<boolean> {
  if (!resend) {
    log.warn('Resend not configured — share expiry warning email skipped', { to: input.to });
    return false;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const trimmedName = input.name?.trim();
  const firstName = trimmedName ? escapeHtml(trimmedName.split(' ')[0]) : 'there';
  const dealName = escapeHtml(input.dealName);
  const expiryText = formatExpiry(input.expiresAt);
  const labelLine = input.shareLabel
    ? `<p>The link labeled &ldquo;${escapeHtml(input.shareLabel)}&rdquo; that you created for <strong>${dealName}</strong> is set to expire on ${expiryText}.</p>`
    : `<p>The link you created for <strong>${dealName}</strong> is set to expire on ${expiryText}.</p>`;

  try {
    const { error } = await resend.emails.send({
      from: `Avise <${fromEmail}>`,
      to: input.to,
      subject: `Your shared link for ${input.dealName} expires soon`,
      html: `
        <div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
          <p>Hi ${firstName},</p>
          ${labelLine}
          <p>Once it expires, the recipient will no longer be able to open it &mdash; that's the only thing that changes. If they still need access, you can create a new share link for the deal at any time from Avise.</p>
          <p style="margin-top:24px;">&mdash; The Avise Team</p>
        </div>
      `,
    });

    if (error) {
      log.error('Share expiry warning email failed', { error });
      return false;
    }
    return true;
  } catch (err) {
    log.error('Share expiry warning email threw', { err });
    return false;
  }
}
