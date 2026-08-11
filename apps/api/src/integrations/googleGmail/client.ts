// Gmail SEND client. NOT a registered provider — these functions are
// invoked directly from services (legalDocSendService) using the access
// token stored under the `google_calendar` (Workspace) integration row.
//
// Separate from the inbox-reading `../gmail/` integration: that one uses
// `gmail.readonly` and its own token store. This one uses `gmail.send`
// from the Workspace OAuth and never reads.
//
// Scopes required (already in CALENDAR_SCOPES):
//   - https://www.googleapis.com/auth/gmail.send
//
// The `From:` header on the outgoing message is set automatically by
// Gmail to the authenticated user's address — we intentionally do not
// pass it (Gmail rejects forged From headers).

import { log } from '../../utils/logger.js';
import {
  GoogleGmailError,
  type GmailProfile,
  type SendMailResult,
} from './types.js';

const GMAIL_SEND_URL =
  'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GMAIL_PROFILE_URL =
  'https://gmail.googleapis.com/gmail/v1/users/me/profile';

const REQUEST_TIMEOUT_MS = 20_000;

function mapGmailError(
  status: number,
  bodyText: string,
  fallbackMessage: string,
): GoogleGmailError {
  // 401 = expired/invalid token. 403 with body mentioning "insufficient"
  // or "scope" = missing gmail.send scope. 429 = rate-limited. Everything
  // else maps to a generic GMAIL_API_ERROR (the body is captured in
  // `details` so the caller can surface it).
  const lower = bodyText.toLowerCase();
  if (status === 401) {
    return new GoogleGmailError(
      'INVALID_TOKEN',
      'Google access token rejected (expired or revoked)',
      status,
      bodyText.slice(0, 500),
    );
  }
  if (status === 403) {
    if (lower.includes('insufficient') || lower.includes('scope')) {
      return new GoogleGmailError(
        'INSUFFICIENT_SCOPE',
        'Token lacks gmail.send scope — user must re-authorize Google Workspace',
        status,
        bodyText.slice(0, 500),
      );
    }
    return new GoogleGmailError(
      'GMAIL_API_ERROR',
      'Gmail denied this request',
      status,
      bodyText.slice(0, 500),
    );
  }
  if (status === 429) {
    return new GoogleGmailError(
      'RATE_LIMITED',
      'Gmail rate limit exceeded',
      status,
      bodyText.slice(0, 500),
    );
  }
  return new GoogleGmailError(
    'GMAIL_API_ERROR',
    fallbackMessage,
    status,
    bodyText.slice(0, 500),
  );
}

/**
 * Encode a Subject line per RFC 2047 if it contains non-ASCII chars.
 * Common case (pure ASCII English) returns the input unchanged so we
 * don't inflate every NDA subject with an encoded-word wrapper.
 */
function encodeSubjectHeader(subject: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  const b64 = Buffer.from(subject, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

/**
 * Build the raw RFC 2822 message body Gmail expects.
 *
 * Notes:
 *   - We deliberately omit the `From:` header. Gmail injects the
 *     authenticated user's address there; if we set one, Gmail either
 *     rejects the send or silently overrides it.
 *   - Content-Transfer-Encoding is 7bit + the HTML body is sent as-is.
 *     Per RFC 2822 line-length rules a perfectly conformant message
 *     would soft-wrap long lines; Gmail accepts long-line HTML in
 *     practice and renders it correctly.
 */
function buildRawMessage(opts: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}): string {
  const CRLF = '\r\n';
  const subjectHeader = encodeSubjectHeader(opts.subject);
  const headers = [
    'MIME-Version: 1.0',
    `To: ${opts.to}`,
    `Subject: ${subjectHeader}`,
  ];
  if (opts.replyTo) headers.push(`Reply-To: ${opts.replyTo}`);
  headers.push('Content-Type: text/html; charset="UTF-8"');
  headers.push('Content-Transfer-Encoding: 7bit');

  const rfc2822 = headers.join(CRLF) + CRLF + CRLF + opts.html;
  return Buffer.from(rfc2822, 'utf8').toString('base64url');
}

/**
 * Send an HTML email from the authenticated user's Gmail mailbox.
 * Returns the Gmail message id + threadId. Throws GoogleGmailError on
 * non-2xx responses.
 */
export async function sendMail(
  accessToken: string,
  opts: { to: string; subject: string; html: string; replyTo?: string },
): Promise<SendMailResult> {
  const raw = buildRawMessage(opts);

  const res = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn('googleGmail.sendMail: non-2xx', {
      status: res.status,
      bodyPreview: text.slice(0, 200),
    });
    throw mapGmailError(res.status, text, 'Gmail send call failed');
  }

  const json = (await res.json()) as { id?: string; threadId?: string };
  if (!json.id || !json.threadId) {
    throw new GoogleGmailError(
      'GMAIL_API_ERROR',
      'Gmail send response missing id/threadId',
      res.status,
      JSON.stringify(json).slice(0, 500),
    );
  }
  return { id: json.id, threadId: json.threadId };
}

/**
 * Fetch the authenticated user's Gmail profile — used to surface the
 * sender's mailbox address back to the frontend. Cheap GET, but skip
 * if the address is already available from the JWT.
 */
export async function getMyProfile(
  accessToken: string,
): Promise<GmailProfile> {
  const res = await fetch(GMAIL_PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn('googleGmail.getMyProfile: non-2xx', {
      status: res.status,
      bodyPreview: text.slice(0, 200),
    });
    throw mapGmailError(res.status, text, 'Gmail profile fetch failed');
  }

  const json = (await res.json()) as { emailAddress?: string };
  if (!json.emailAddress) {
    throw new GoogleGmailError(
      'GMAIL_API_ERROR',
      'Gmail profile response missing emailAddress',
      res.status,
      JSON.stringify(json).slice(0, 500),
    );
  }
  return { emailAddress: json.emailAddress };
}
