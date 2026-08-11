// Gmail send client types. Gmail send is NOT a standalone integration
// provider — it piggybacks on the `google_calendar` provider's OAuth token
// (which has `gmail.send` scope since the Workspace expansion). This is
// separate from the inbox-reading `gmail/` integration (which lives in
// ../gmail and has its own scopes/tokens for reading messages).

export interface SendMailResult {
  id: string;
  threadId: string;
}

export interface GmailProfile {
  emailAddress: string;
}

export type GoogleGmailErrorCode =
  | 'GMAIL_API_ERROR'
  | 'INVALID_TOKEN'
  | 'INSUFFICIENT_SCOPE'
  | 'RATE_LIMITED';

export class GoogleGmailError extends Error {
  code: GoogleGmailErrorCode;
  status?: number;
  details?: string;

  constructor(
    code: GoogleGmailErrorCode,
    message: string,
    status?: number,
    details?: string,
  ) {
    super(message);
    this.name = 'GoogleGmailError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
