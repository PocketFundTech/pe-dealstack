// ─── Re-engagement / inactivity nudge email ────────────────────────
// Sent by the reengagement-nudge cron (see routes/cron-reengagement-nudge.ts)
// to users whose most recent AuditLog activity is more than 14 days old.
// Null-safe on RESEND_API_KEY exactly like welcomeEmail.ts: a missing key
// logs and returns false, it never throws into the caller.

import { Resend } from 'resend';
import { log } from '../utils/logger.js';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export interface ReengagementEmailInput {
  to: string;
  name?: string | null;
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
 * Send the "we haven't seen you in a while" nudge email. Returns true when
 * the mail was handed to Resend, false when email isn't configured or the
 * send failed — the caller (routes/cron-reengagement-nudge.ts) treats
 * either as a per-user no-op and keeps going with the rest of the batch.
 */
export async function sendReengagementEmail(input: ReengagementEmailInput): Promise<boolean> {
  if (!resend) {
    log.warn('Resend not configured — reengagement email skipped', { to: input.to });
    return false;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const trimmedName = input.name?.trim();
  const firstName = trimmedName ? escapeHtml(trimmedName.split(' ')[0]) : 'there';

  try {
    const { error } = await resend.emails.send({
      from: `Avise <${fromEmail}>`,
      to: input.to,
      subject: "We haven't seen you in a while",
      html: `
        <div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
          <p>Hi ${firstName},</p>
          <p>Haven't seen you in a while &mdash; your deals are still here whenever you're ready.</p>
          <p style="margin-top:24px;">&mdash; The Avise Team</p>
        </div>
      `,
    });

    if (error) {
      log.error('Reengagement email failed', { error });
      return false;
    }
    return true;
  } catch (err) {
    log.error('Reengagement email threw', { err });
    return false;
  }
}
