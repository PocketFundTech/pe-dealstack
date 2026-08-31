// ─── Deal stage-changed email ──────────────────────────────────────
// Sent to the deal's assigned owner whenever a PATCH on /api/deals/:id
// moves the deal to a new stage (see routes/deals-mutate.ts for the
// guarded, fire-and-forget caller). Null-safe on RESEND_API_KEY exactly
// like welcomeEmail.ts: a missing key logs and returns false, it never
// throws into the caller.

import { Resend } from 'resend';
import { log } from '../utils/logger.js';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export interface DealStageChangedEmailInput {
  to: string;
  name?: string | null;
  dealName: string;
  oldStage: string;
  newStage: string;
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
 * Send the "deal moved to a new stage" notification email to the deal
 * owner. Returns true when the mail was handed to Resend, false when
 * email isn't configured or the send failed — the caller (deals-mutate.ts)
 * treats either as a silent no-op.
 */
export async function sendDealStageChangedEmail(
  input: DealStageChangedEmailInput,
): Promise<boolean> {
  if (!resend) {
    log.warn('Resend not configured — deal stage-changed email skipped', { to: input.to });
    return false;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const trimmedName = input.name?.trim();
  const firstName = trimmedName ? escapeHtml(trimmedName.split(' ')[0]) : 'there';
  const dealName = escapeHtml(input.dealName);
  const oldStage = escapeHtml(input.oldStage);
  const newStage = escapeHtml(input.newStage);

  try {
    const { error } = await resend.emails.send({
      from: `Avise <${fromEmail}>`,
      to: input.to,
      subject: `${dealName} moved to ${newStage}`,
      html: `
        <div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
          <p>Hi ${firstName},</p>
          <p><strong>${dealName}</strong> moved from <strong>${oldStage}</strong> to <strong>${newStage}</strong>.</p>
          <p style="margin-top:24px;">&mdash; The Avise Team</p>
        </div>
      `,
    });

    if (error) {
      log.error('Deal stage-changed email failed', { error });
      return false;
    }
    return true;
  } catch (err) {
    log.error('Deal stage-changed email threw', { err });
    return false;
  }
}
