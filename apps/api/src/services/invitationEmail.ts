import type { Request } from 'express';
import { Resend } from 'resend';
import { log } from '../utils/logger.js';

// Initialize Resend
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Helper: Get expiration date (7 days from now)
export function getExpirationDate(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  return date;
}

// Resolve the public base URL the invite link should point to. Prefers the
// caller's Origin header (so a preview-deployment admin gets links back to
// THEIR preview, and a prod admin gets prod links) over the static APP_URL
// env var. Falls back to APP_URL, then localhost for dev.
export function resolveBaseUrl(req?: Request): string {
  const origin = req?.headers?.origin;
  if (origin && /^https?:\/\//.test(origin)) return origin.replace(/\/$/, '');
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  return 'http://localhost:3000';
}

// Helper: Send invitation email via Resend
export async function sendInvitationEmail(
  email: string,
  inviterName: string,
  firmName: string,
  token: string,
  role: string,
  req?: Request
): Promise<{ success: boolean; error?: string }> {
  try {
    const baseUrl = resolveBaseUrl(req);
    const inviteUrl = `${baseUrl}/accept-invite?token=${token}`;

    log.info('Sending invitation email', { email, inviterName, firmName, role, inviteUrl });

    if (!resend) {
      log.warn('Resend not configured — RESEND_API_KEY missing. Invitation URL logged above.');
      return { success: false, error: 'Email service not configured (RESEND_API_KEY missing)' };
    }

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

    const { data, error } = await resend.emails.send({
      from: `Avise <${fromEmail}>`,
      to: [email],
      subject: `You're invited to join ${firmName} on Avise`,
      html: `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
          <div style="background: linear-gradient(135deg, #003366, #0055aa); padding: 32px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 600;">Avise</h1>
            <p style="color: #b3d1ff; margin: 8px 0 0; font-size: 14px;">AI-Powered Private Equity CRM</p>
          </div>
          <div style="padding: 32px;">
            <h2 style="color: #003366; margin: 0 0 16px; font-size: 20px;">You're Invited! 🎉</h2>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              <strong>${inviterName}</strong> has invited you to join <strong>${firmName}</strong> on Avise.
            </p>
            <p style="color: #555; font-size: 15px; line-height: 1.6;">
              You've been assigned the role of <strong>${role}</strong>. Click the button below to create your account and get started.
            </p>
            <div style="text-align: center; margin: 32px 0;">
              <a href="${inviteUrl}"
                 style="background: linear-gradient(135deg, #003366, #0055aa); color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; display: inline-block; font-size: 16px; font-weight: 600; letter-spacing: 0.5px;">
                Accept Invitation
              </a>
            </div>
            <p style="color: #888; font-size: 13px; text-align: center;">This invitation expires in 7 days.</p>
          </div>
          <hr style="border: none; border-top: 1px solid #eef2f7; margin: 0;" />
          <div style="padding: 20px 32px; text-align: center;">
            <p style="color: #aaa; font-size: 12px; margin: 0;">
              Avise — AI-Powered Private Equity CRM<br/>
              If you didn't expect this invitation, you can safely ignore this email.
            </p>
          </div>
        </div>
      `,
    });

    if (error) {
      log.error('Resend email error', error);
      return { success: false, error: error.message || 'Failed to send email' };
    }

    log.info('Invitation email sent successfully', { email, messageId: data?.id });
    return { success: true };
  } catch (error) {
    log.error('Email send error', error);
    return { success: false, error: 'Failed to send invitation email' };
  }
}

