// ─── NDA signature-completed confirmation email ────────────────────
// Sent once, right after legalDocSignaturePollService flips a
// LegalDocument row from SENT to SIGNED (see the "if (state.signed)"
// branch there — it's a natural one-shot trigger since the poller only
// re-processes rows still in SENT status). Null-safe on RESEND_API_KEY
// exactly like welcomeEmail.ts and docRequestEmail.ts: a missing key
// logs and returns false, it never throws into the caller.
//
// Deliberately has no button/link — this confirms a legal document was
// signed, and an email about a legal document shouldn't train the
// recipient to click links inside it.

import { Resend } from 'resend';
import { log } from '../utils/logger.js';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export interface SignatureCompletedEmailInput {
  to: string;
  name?: string | null;
  dealName: string;
  documentName: string;
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
 * Send the "NDA signed" confirmation email to the document's sender/owner.
 * Returns true when the mail was handed to Resend, false when email isn't
 * configured or the send failed — the caller (legalDocSignaturePollService)
 * treats either as a non-fatal, log-and-continue no-op.
 */
export async function sendSignatureCompletedEmail(
  input: SignatureCompletedEmailInput,
): Promise<boolean> {
  if (!resend) {
    log.warn('Resend not configured — signature completed email skipped', { to: input.to });
    return false;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const trimmedName = input.name?.trim();
  const firstName = trimmedName ? escapeHtml(trimmedName.split(' ')[0]) : 'there';
  const dealName = escapeHtml(input.dealName);
  const documentName = escapeHtml(input.documentName);
  const subject = `The NDA for ${input.dealName} was just signed`;

  try {
    const { error } = await resend.emails.send({
      from: `Avise <${fromEmail}>`,
      to: input.to,
      subject,
      html: `
        <div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
          <p>Hi ${firstName},</p>
          <p><strong>${documentName}</strong> for <strong>${dealName}</strong> has just been signed.</p>
          <p>No action is needed &mdash; this is a confirmation that the signature was detected. You can review the signed document in Avise whenever it's convenient.</p>
          <p style="margin-top:24px;">&mdash; The Avise Team</p>
        </div>
      `,
    });

    if (error) {
      log.error('Signature completed email failed', { error });
      return false;
    }
    return true;
  } catch (err) {
    log.error('Signature completed email threw', { err });
    return false;
  }
}
