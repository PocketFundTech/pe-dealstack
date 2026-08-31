// ─── Weekly team activity digest ───────────────────────────────────
// Sent to each org's ADMIN users by the cron-weekly-digest sweep
// (see routes/cron-weekly-digest.ts). Null-safe on RESEND_API_KEY
// exactly like welcomeEmail.ts / docRequestEmail.ts: a missing key
// logs and returns false, it never throws into the caller.

import { Resend } from 'resend';
import { log } from '../utils/logger.js';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export interface WeeklyDigestEmailInput {
  to: string;
  name?: string | null;
  orgName: string;
  counts: Record<string, number>;
  weekOf: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "DEAL_CREATED" -> "deal created" */
function humanizeAction(action: string): string {
  return action.replace(/_/g, ' ').toLowerCase();
}

function renderCountItems(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([action, count]) => `<li>${count} ${escapeHtml(humanizeAction(action))}</li>`)
    .join('\n          ');
}

/**
 * Send the weekly team activity digest email. Returns true when the mail
 * was handed to Resend, false when email isn't configured or the send
 * failed — the caller (routes/cron-weekly-digest.ts) logs and moves on.
 */
export async function sendWeeklyDigestEmail(input: WeeklyDigestEmailInput): Promise<boolean> {
  if (!resend) {
    log.warn('Resend not configured — weekly digest email skipped', { to: input.to });
    return false;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const trimmedName = input.name?.trim();
  const firstName = trimmedName ? escapeHtml(trimmedName.split(' ')[0]) : 'there';
  const orgName = escapeHtml(input.orgName);
  const weekOf = escapeHtml(input.weekOf);
  const items = renderCountItems(input.counts);

  try {
    const { error } = await resend.emails.send({
      from: `Avise <${fromEmail}>`,
      to: input.to,
      subject: `Your Avise weekly digest — week of ${input.weekOf}`,
      html: `
        <div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
          <p>Hi ${firstName},</p>
          <p>Here's what happened at <strong style="color:#003366;">${orgName}</strong> for the week of ${weekOf}:</p>
          <ul>
          ${items}
          </ul>
          <p style="margin-top:24px;">&mdash; The Avise Team</p>
        </div>
      `,
    });

    if (error) {
      log.error('Weekly digest email failed', { error });
      return false;
    }
    return true;
  } catch (err) {
    log.error('Weekly digest email threw', { err });
    return false;
  }
}
