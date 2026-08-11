// Shapes for the subset of Gmail API we use for sync.

export interface GmailUserInfo {
  email: string;
  verified_email?: boolean;
  name?: string;
}

export interface GmailListMessagesResponse {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailMessageHeader {
  name: string;
  value: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailMessageHeader[];
  body?: {
    size?: number;
    data?: string;     // base64url-encoded
    attachmentId?: string;
  };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  sizeEstimate?: number;
}

export interface GmailTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

/** Metadata for a downloadable message attachment (filename + id to fetch). */
export interface GmailAttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** Parsed full Gmail message — body extracted from MIME parts. */
export interface GmailMessageFull {
  id: string;
  threadId: string;
  snippet: string;
  body: string;
  /** Named attachments with a fetchable attachmentId (body parsing ignores these). */
  attachments: GmailAttachmentMeta[];
  headers: {
    Subject: string;
    From: string;
    To: string;
    Cc: string;
    Date: string;
    MessageId: string;
    InReplyTo: string;
  };
}
