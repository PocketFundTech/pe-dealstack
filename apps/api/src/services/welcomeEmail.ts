// ─── Signup welcome email ──────────────────────────────────────────
// Sent once, right after a new account is created (see
// routes/welcome-email.ts for the guarded caller). Null-safe on
// RESEND_API_KEY exactly like docRequestEmail.ts and routes/invitations.ts:
// a missing key logs and returns false, it never throws into the caller.

import { Resend } from 'resend';
import { log } from '../utils/logger.js';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export interface WelcomeEmailInput {
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
 * Send the "Welcome to Avise" email. Returns true when the mail was handed
 * to Resend, false when email isn't configured or the send failed — the
 * caller (routes/welcome-email.ts) treats either as a silent no-op.
 */
export async function sendWelcomeEmail(input: WelcomeEmailInput): Promise<boolean> {
  if (!resend) {
    log.warn('Resend not configured — welcome email skipped', { to: input.to });
    return false;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const trimmedName = input.name?.trim();
  const firstName = trimmedName ? escapeHtml(trimmedName.split(' ')[0]) : 'there';

  try {
    const { error } = await resend.emails.send({
      from: `Avise <${fromEmail}>`,
      to: input.to,
      subject: 'Welcome to Avise',
      html: `
        <div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
          <p>Hi ${firstName},</p>
          <p>Welcome to Avise &mdash; glad to have you on board.</p>
          <p>You've now got one place for deal screening, diligence, and portfolio work &mdash; pre-loaded context, no blank-page prompts. Jump back in whenever you're ready.</p>
          <p style="margin-top:24px;">&mdash; The Avise Team</p>
        </div>
      `,
    });

    if (error) {
      log.error('Welcome email failed', { error });
      return false;
    }
    return true;
  } catch (err) {
    log.error('Welcome email threw', { err });
    return false;
  }
}
