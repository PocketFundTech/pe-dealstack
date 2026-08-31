// ─── New-device login alert email ──────────────────────────────────
// Sent when a login is seen from a device fingerprint that isn't in the
// KnownLoginDevice table yet (see routes/account-security.ts for the
// guarded caller). Null-safe on RESEND_API_KEY exactly like
// welcomeEmail.ts: a missing key logs and returns false, it never throws
// into the caller.
//
// Deliberately no button/link (this is a notice, not an action) and no
// geo-IP location claim — this codebase has no IP-geolocation lookup, so
// inventing a city/region here would just be wrong. No unsubscribe
// language either: security alerts aren't an opt-in mailing list.

import { Resend } from 'resend';
import { log } from '../utils/logger.js';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export interface NewDeviceLoginEmailInput {
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
 * Send the "New sign-in to your Avise account" alert email. Returns true
 * when the mail was handed to Resend, false when email isn't configured or
 * the send failed — the caller (routes/account-security.ts) treats either
 * as a silent no-op.
 */
export async function sendNewDeviceLoginEmail(
  input: NewDeviceLoginEmailInput
): Promise<boolean> {
  if (!resend) {
    log.warn('Resend not configured — new-device login email skipped', { to: input.to });
    return false;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const trimmedName = input.name?.trim();
  const firstName = trimmedName ? escapeHtml(trimmedName.split(' ')[0]) : 'there';

  try {
    const { error } = await resend.emails.send({
      from: `Avise <${fromEmail}>`,
      to: input.to,
      subject: 'New sign-in to your Avise account',
      html: `
        <div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
          <p>Hi ${firstName},</p>
          <p>We noticed a sign-in to your Avise account from a device we haven't seen before.</p>
          <p>If this was you, you don't need to do anything.</p>
          <p style="font-weight:600;color:#003366;">If this wasn't you, contact us immediately so we can secure your account.</p>
          <p style="margin-top:24px;">&mdash; The Avise Team</p>
        </div>
      `,
    });

    if (error) {
      log.error('New-device login email failed', { error });
      return false;
    }
    return true;
  } catch (err) {
    log.error('New-device login email threw', { err });
    return false;
  }
}
