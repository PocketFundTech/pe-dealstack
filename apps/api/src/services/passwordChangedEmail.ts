// ─── Password-changed confirmation email ───────────────────────────
// Sent right after a password change succeeds (see
// routes/account-security.ts for the guarded caller). Null-safe on
// RESEND_API_KEY exactly like welcomeEmail.ts: a missing key logs and
// returns false, it never throws into the caller.
//
// Deliberately no link/button in the body — a "click here" security email
// is indistinguishable from a phishing template. This is a notice only.

import { Resend } from 'resend';
import { log } from '../utils/logger.js';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export interface PasswordChangedEmailInput {
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
 * Send the "Your Avise password was changed" confirmation email. Returns
 * true when the mail was handed to Resend, false when email isn't
 * configured or the send failed — the caller (routes/account-security.ts)
 * treats either as a silent no-op.
 */
export async function sendPasswordChangedEmail(
  input: PasswordChangedEmailInput
): Promise<boolean> {
  if (!resend) {
    log.warn('Resend not configured — password-changed email skipped', { to: input.to });
    return false;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const trimmedName = input.name?.trim();
  const firstName = trimmedName ? escapeHtml(trimmedName.split(' ')[0]) : 'there';

  try {
    const { error } = await resend.emails.send({
      from: `Avise <${fromEmail}>`,
      to: input.to,
      subject: 'Your Avise password was changed',
      html: `
        <div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
          <p>Hi ${firstName},</p>
          <p>The password on your Avise account was just changed.</p>
          <p>If you made this change, you don't need to do anything.</p>
          <p style="font-weight:600;color:#003366;">If this wasn't you, contact us immediately so we can secure your account.</p>
          <p style="margin-top:24px;">&mdash; The Avise Team</p>
        </div>
      `,
    });

    if (error) {
      log.error('Password-changed email failed', { error });
      return false;
    }
    return true;
  } catch (err) {
    log.error('Password-changed email threw', { err });
    return false;
  }
}
