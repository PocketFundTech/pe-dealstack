// ─── @-mention notification email ──────────────────────────────────
// Sent alongside the existing in-app MENTION notification (see the
// mention-handling block in routes/activities.ts POST
// /deals/:dealId/activities). Null-safe on RESEND_API_KEY exactly like
// welcomeEmail.ts: a missing key logs and returns false, it never
// throws into the caller.

import { Resend } from 'resend';
import { log } from '../utils/logger.js';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export interface MentionEmailInput {
  to: string;
  name?: string | null;
  mentionedByName: string;
  dealName: string;
  // Truncated to 150 chars by this service (see NOTE_EXCERPT_MAX_LENGTH
  // below) — callers may pass the raw note text, already-truncated text,
  // or nothing at all.
  noteExcerpt?: string | null;
}

const NOTE_EXCERPT_MAX_LENGTH = 150;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send the "you were mentioned" email. Returns true when the mail was
 * handed to Resend, false when email isn't configured or the send
 * failed — the caller (routes/activities.ts) treats either as a silent
 * no-op alongside the in-app notification, which is unaffected either
 * way.
 */
export async function sendMentionEmail(input: MentionEmailInput): Promise<boolean> {
  if (!resend) {
    log.warn('Resend not configured — mention email skipped', { to: input.to });
    return false;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const trimmedName = input.name?.trim();
  const firstName = trimmedName ? escapeHtml(trimmedName.split(' ')[0]) : 'there';
  const mentionedByName = escapeHtml(input.mentionedByName);
  const dealName = escapeHtml(input.dealName);
  const rawExcerpt = (input.noteExcerpt || '').slice(0, NOTE_EXCERPT_MAX_LENGTH);
  const excerpt = escapeHtml(rawExcerpt);

  try {
    const { error } = await resend.emails.send({
      from: `Avise <${fromEmail}>`,
      to: input.to,
      subject: `${mentionedByName} mentioned you in ${dealName}`,
      html: `
        <div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
          <p>Hi ${firstName},</p>
          <p><strong>${mentionedByName}</strong> mentioned you in <strong>${dealName}</strong>:</p>
          ${excerpt ? `<p style="margin:16px 0;padding:12px 16px;background:#F8F9FA;border-left:3px solid #003366;color:#111827;">${excerpt}</p>` : ''}
          <p style="margin-top:24px;">&mdash; The Avise Team</p>
        </div>
      `,
    });

    if (error) {
      log.error('Mention email failed', { error });
      return false;
    }
    return true;
  } catch (err) {
    log.error('Mention email threw', { err });
    return false;
  }
}
