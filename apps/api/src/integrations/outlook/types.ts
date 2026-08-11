// Microsoft Graph mail shapes (subset we consume). Full schema:
// https://learn.microsoft.com/graph/api/resources/message

export interface GraphEmailAddress {
  name?: string;
  address?: string;
}

export interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

export interface GraphMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  conversationId?: string;
  internetMessageId?: string;
  hasAttachments?: boolean;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  body?: { contentType?: 'text' | 'html'; content?: string };
}

// A file attachment on a message. We only consume `#microsoft.graph.fileAttachment`
// (the kind that carries `contentBytes`); inline images and item/reference
// attachments are ignored.
export interface GraphFileAttachment {
  '@odata.type'?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string; // base64
}

export interface GraphListResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
}
