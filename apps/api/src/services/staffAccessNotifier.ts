import type { Resend } from 'resend';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';

// This module is pulled in by staffAccessLogger, which is mounted on (almost)
// every API route — so it loads on every lite serverless cold start. `resend`
// is only needed when an email is actually sent, so load it lazily on first
// use instead of at module init. `undefined` = not yet resolved.
let resendClient: Resend | null | undefined;
async function getResend(): Promise<Resend | null> {
  if (resendClient !== undefined) return resendClient;
  if (!process.env.RESEND_API_KEY) {
    resendClient = null;
    return null;
  }
  const { Resend } = await import('resend');
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

export interface StaffAccessEvent {
  staffEmail: string;
  method: string;
  path: string;
  testMode?: boolean;
}

interface OrgNotifyConfig {
  staffAccessWebhookUrl: string | null;
  staffAccessNotifyEmail: string | null;
  name: string | null;
}

const WEBHOOK_TIMEOUT_MS = 5000;

function buildSlackPayload(orgName: string | null, event: StaffAccessEvent) {
  const heading = event.testMode
    ? 'This is a test from Pocket Fund — staff access notifications are wired correctly.'
    : `Pocket Fund staff (${event.staffEmail}) accessed your data: ${event.method} ${event.path}`;

  return {
    text: heading,
    attachments: [
      {
        color: event.testMode ? '#003366' : '#e11d48',
        fields: [
          { title: 'Organization', value: orgName ?? 'Unknown', short: true },
          { title: 'Staff', value: event.staffEmail, short: true },
          { title: 'Method', value: event.method, short: true },
          { title: 'Path', value: event.path, short: true },
          { title: 'Timestamp', value: new Date().toISOString(), short: false },
        ],
        footer: event.testMode ? 'pocket-fund • test event' : 'pocket-fund • staff access',
      },
    ],
  };
}

function buildEmailHtml(orgName: string | null, event: StaffAccessEvent): string {
  const heading = event.testMode
    ? 'Test event from Pocket Fund'
    : `Pocket Fund staff accessed your data`;
  const body = event.testMode
    ? '<p>This is a test from Pocket Fund. Real staff-access events will look like this:</p>'
    : `<p>The following Pocket Fund staff member accessed data in your organization:</p>`;
  return `<!DOCTYPE html>
<html><body style="font-family: Inter, system-ui, sans-serif; color: #1F2937; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #003366; margin-top: 0;">${heading}</h2>
  ${body}
  <table style="border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px;">
    <tr><td style="padding: 6px 0; color: #6B7280;">Organization</td><td>${escapeHtml(orgName ?? 'Unknown')}</td></tr>
    <tr><td style="padding: 6px 0; color: #6B7280;">Staff</td><td><code>${escapeHtml(event.staffEmail)}</code></td></tr>
    <tr><td style="padding: 6px 0; color: #6B7280;">Method</td><td>${escapeHtml(event.method)}</td></tr>
    <tr><td style="padding: 6px 0; color: #6B7280;">Path</td><td><code>${escapeHtml(event.path)}</code></td></tr>
    <tr><td style="padding: 6px 0; color: #6B7280;">Timestamp</td><td>${new Date().toISOString()}</td></tr>
  </table>
  <p style="color: #6B7280; font-size: 12px;">You configured these notifications in Settings → Security &amp; Privacy. To stop receiving them, clear the email field there.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]!));
}

async function fireWebhook(url: string, slackPayload: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fireEmail(to: string, orgName: string | null, event: StaffAccessEvent): Promise<void> {
  const resend = await getResend();
  if (!resend) return;
  const subject = event.testMode
    ? '[Test] Pocket Fund staff access notification'
    : 'Pocket Fund staff accessed your data';
  await resend.emails.send({
    from: 'security@pocket-fund.com',
    to,
    subject,
    html: buildEmailHtml(orgName, event),
  });
}

/**
 * Notify the customer that a Pocket Fund staff member accessed their data.
 *
 * Best-effort: failures are logged at warn level but never thrown. Callers
 * should fire-and-forget so the audit-log write path stays unblocked.
 */
export async function notifyStaffAccess(orgId: string, event: StaffAccessEvent): Promise<void> {
  let config: OrgNotifyConfig | null = null;
  try {
    const { data, error } = await supabase
      .from('Organization')
      .select('staffAccessWebhookUrl, staffAccessNotifyEmail, name')
      .eq('id', orgId)
      .single();
    if (error || !data) return;
    config = data as OrgNotifyConfig;
  } catch (err) {
    log.warn('staffAccessNotifier: org lookup failed', { err, orgId });
    return;
  }

  if (config.staffAccessWebhookUrl) {
    try {
      await fireWebhook(config.staffAccessWebhookUrl, buildSlackPayload(config.name, event));
    } catch (err) {
      log.warn('staffAccessNotifier: webhook delivery failed', { err, orgId });
    }
  }

  if (config.staffAccessNotifyEmail) {
    try {
      await fireEmail(config.staffAccessNotifyEmail, config.name, event);
    } catch (err) {
      log.warn('staffAccessNotifier: email delivery failed', { err, orgId });
    }
  }
}
