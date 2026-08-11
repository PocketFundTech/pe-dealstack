// Pure helpers for legalDocSendService — the typed send error, the cover-email
// HTML builder, and the Drive/Gmail error→send-error mappers. Extracted so the
// send service stays under the 500-line file cap. No I/O lives here.
//
// `LegalDocSendError` is re-exported from legalDocSendService.ts, so existing
// importers (routes/legal-documents.ts) keep their import path unchanged.

import { GoogleDriveError } from '../integrations/googleDrive/types.js';
import { GoogleGmailError } from '../integrations/googleGmail/types.js';

export type LegalDocSendErrorCode =
  | 'GOOGLE_NOT_CONNECTED'
  | 'GOOGLE_SCOPES_MISSING'
  | 'NO_RECIPIENT'
  | 'NO_CONTENT'
  | 'DOCUMENT_NOT_FOUND'
  | 'DRIVE_API_ERROR'
  | 'EMAIL_SEND_FAILED';

export class LegalDocSendError extends Error {
  code: LegalDocSendErrorCode;
  status: number;
  details?: string;
  constructor(code: LegalDocSendErrorCode, message: string, status: number, details?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const DEFAULT_COVER_HTML =
  '<p>Please review the attached NDA. You\'ve been granted edit access in Google Docs.</p>';

export function buildEmailHtml(coverHtml: string, docUrl: string): string {
  // Plain inline-styled "button" — Gmail renders the HTML as-is, and we
  // want this to look acceptable in Gmail/Outlook without external CSS.
  const button =
    `<p style="margin:24px 0;">` +
    `<a href="${docUrl}" ` +
    `style="display:inline-block;padding:12px 24px;background:#1a73e8;` +
    `color:#ffffff;text-decoration:none;border-radius:4px;font-weight:600;` +
    `font-family:Arial,Helvetica,sans-serif;">Open the NDA in Google Docs</a>` +
    `</p>` +
    `<p style="color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif;">` +
    `Or paste this link into your browser: <a href="${docUrl}">${docUrl}</a>` +
    `</p>`;
  return `${coverHtml}\n${button}`;
}

export function mapDriveErrorToSendError(
  err: unknown,
  stage: 'create' | 'permission',
): LegalDocSendError {
  if (err instanceof GoogleDriveError) {
    if (err.code === 'INVALID_TOKEN' || err.code === 'INSUFFICIENT_SCOPE') {
      return new LegalDocSendError(
        'GOOGLE_SCOPES_MISSING',
        'Google connection lacks Drive/Docs scope — please reconnect Google Workspace',
        409,
        err.details ?? err.message,
      );
    }
    return new LegalDocSendError(
      'DRIVE_API_ERROR',
      `Drive ${stage} call failed: ${err.message}`,
      502,
      err.details ?? err.message,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new LegalDocSendError(
    'DRIVE_API_ERROR',
    `Drive ${stage} call failed`,
    502,
    message,
  );
}

export function mapGmailErrorToSendError(err: unknown): LegalDocSendError {
  if (err instanceof GoogleGmailError) {
    if (err.code === 'INVALID_TOKEN' || err.code === 'INSUFFICIENT_SCOPE') {
      return new LegalDocSendError(
        'GOOGLE_SCOPES_MISSING',
        'Google connection lacks Gmail send scope — please reconnect Google Workspace',
        409,
        err.details ?? err.message,
      );
    }
    return new LegalDocSendError(
      'EMAIL_SEND_FAILED',
      `Gmail send failed: ${err.message}`,
      502,
      err.details ?? err.message,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new LegalDocSendError(
    'EMAIL_SEND_FAILED',
    'Gmail send failed',
    502,
    message,
  );
}
