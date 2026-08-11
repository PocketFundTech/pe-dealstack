// Type definitions for the NDA / legal-document feature.
//
// Mirrors the contract from `apps/api/src/services/legalDocs/*` (built by the
// peer backend agent). Keep this in sync with the server-side TypeScript types
// — divergence here = subtle bugs at the API boundary.

export type DocType =
  | "NDA"
  | "LOI"
  | "TERM_SHEET"
  | "DEFINITIVE_AGREEMENT"
  | "SIDE_LETTER"
  | "OTHER";

export type DocStatus = "DRAFT" | "SENT" | "SIGNED" | "EXPIRED";

// The known placeholder tokens the editor lets users insert. The backend
// substitutes these on send. Adding a new one? Add to TOKEN_KEYS / TOKEN_LABELS
// / TOKEN_DESCRIPTIONS in constants.ts and to the backend's substitution map.
export type TokenKey =
  | "COUNTERPARTY_NAME"
  | "COUNTERPARTY_ADDRESS"
  | "COUNTERPARTY_EMAIL"
  | "EFFECTIVE_DATE"
  | "JURISDICTION"
  | "DEAL_NAME"
  | "FIRM_NAME"
  | "TODAY";

export interface LegalDocument {
  id: string;
  organizationId: string;
  dealId: string;
  createdById: string | null;
  docType: DocType;
  title: string;
  counterpartyName: string | null;
  counterpartyEmail: string | null;
  counterpartyAddress: string | null;
  jurisdiction: string | null;
  status: DocStatus;
  // Current editable HTML payload — what the user sees in the in-app editor.
  content: string | null;
  // Frozen-at-send-time copy. Lets us show the exact wording that went out
  // even after the live draft has been edited again.
  contentSnapshot: string | null;
  templateId: string | null;
  effectiveDate: string | null; // YYYY-MM-DD
  signedAt: string | null;
  expiresAt: string | null;
  sentAt: string | null;
  sentToEmail: string | null;
  // Populated by the backend on send: the Google Doc copy created in the
  // user's Drive that the counterparty gets edit access to. Null until the
  // first successful /send call.
  googleDocId: string | null;
  googleDocUrl: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// The cross-deal `GET /legal-documents` endpoint embeds a small `deal` summary
// on each row so the firm-wide gallery can show which deal a document belongs
// to without a second round-trip.
export interface LegalDocumentWithDeal extends LegalDocument {
  deal: {
    id: string;
    projectName: string | null;
    target: string | null;
  };
}

// Marker stamped on `metadata.source` by the import-gdoc flow. Docs the user
// brought in by pasting a Google Doc URL (vs. drafted from a template or
// uploaded as a file). These have `content: null` and render in
// GoogleDocImportView (embedded preview + open-externally) instead of the HTML
// editor, which doesn't apply to a doc that lives entirely in Google Docs.
export const IMPORTED_GDOC_SOURCE = "imported-gdoc" as const;

// True when a document was imported via the "bring your own Google Doc" flow.
// Use this everywhere instead of inlining the metadata.source string so the
// magic value stays in one place (and stays in sync with the backend marker).
export function isImportedGdoc(
  doc: Pick<LegalDocument, "metadata">,
): boolean {
  return (
    (doc.metadata as { source?: string } | undefined)?.source ===
    IMPORTED_GDOC_SOURCE
  );
}

// A reusable HTML template, uploaded once and reused per NDA. The
// `verifiedAt` field is null between parse-time and the user clicking "Save
// Template" in the verifier — only verified rows are surfaced as picker
// options on the create flow.
export interface LegalDocTemplate {
  id: string;
  organizationId: string;
  name: string;
  docType: DocType;
  bodyHtml: string | null;
  originalFileName: string | null;
  uploadedAt: string | null;
  verifiedAt: string | null;
  placeholderKeys: TokenKey[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

// Returned by POST /legal-document-templates/parse — a parsed-but-unsaved
// draft the verifier UI can render and let the user mark up.
export interface ParsedTemplateDraft {
  bodyHtml: string;
  originalFileName: string | null;
  suggestedName: string;
}

// Payload for POST /deals/:dealId/legal-documents. A templateId is always
// required now — the "blank document" path is gone.
export interface CreateDocBody {
  templateId: string;
  title: string;
  counterpartyName?: string;
  counterpartyEmail?: string;
  counterpartyAddress?: string;
  effectiveDate?: string;
  jurisdiction?: string;
}

// Payload for PATCH /legal-documents/:id. All fields optional — server only
// applies what's supplied. Content lives here too now (not in Google Docs).
export interface UpdateDocBody {
  title?: string;
  status?: DocStatus;
  content?: string;
  counterpartyName?: string | null;
  counterpartyEmail?: string | null;
  counterpartyAddress?: string | null;
  effectiveDate?: string | null;
  jurisdiction?: string | null;
  signedAt?: string | null;
  expiresAt?: string | null;
}

// Payload for POST /legal-document-templates (the "Save Template" action).
export interface CreateTemplateBody {
  name: string;
  docType?: DocType;
  bodyHtml: string;
  originalFileName?: string;
  placeholderKeys: TokenKey[];
  isDefault?: boolean;
}

// Payload for PATCH /legal-document-templates/:id. `verifiedAt` is bumped to
// "now" when the user re-saves a draft template — the server may accept null
// to revert, but the UI doesn't expose that path.
export interface UpdateTemplateBody {
  name?: string;
  bodyHtml?: string;
  placeholderKeys?: TokenKey[];
  isDefault?: boolean;
  verifiedAt?: string | null;
}

// Payload for POST /deals/:dealId/legal-documents/upload (multipart).
// Sent as form-data fields alongside the `file` + `kind` parts — the
// frontend assembles a FormData rather than a JSON body. Status must be
// SENT or SIGNED; DRAFT goes through the template flow so token
// substitution can't be skipped.
export interface UploadExistingMetadata {
  title: string;
  status: "SENT" | "SIGNED";
  counterpartyName?: string;
  counterpartyEmail?: string;
  counterpartyAddress?: string;
  jurisdiction?: string;
  effectiveDate?: string; // YYYY-MM-DD
  expiresAt?: string;     // YYYY-MM-DD
  sentAt?: string;        // ISO datetime
  signedAt?: string;      // ISO datetime
  sentToEmail?: string;
}

export type UploadExistingKind = "docx" | "html" | "md" | "pdf";

// Payload for POST /legal-documents/:id/send.
export interface SendDocBody {
  toEmail?: string;
  subject?: string;
  message?: string;
}

export interface SendDocResponse {
  ok: true;
  googleDocId: string;
  googleDocUrl: string;
  // Gmail message id of the email that just went out from the sender's
  // Workspace inbox. Replaces the old Resend `messageId` field — kept under
  // the new name to make the multi-tenant Gmail flow explicit at the boundary.
  gmailMessageId: string;
  sentAt: string;
  // The Gmail address the message went from — i.e. the current user's
  // Workspace email. Surfaced to the user as provenance in the success toast
  // and in the post-send action bar so they know which inbox to check for
  // the thread.
  senderEmail: string;
  // Server returns `alreadySent: true` on idempotent re-sends so the client
  // can soften its success toast ("Already sent" vs "Sent").
  alreadySent?: boolean;
}

// Payload for POST /legal-documents/:id/send-for-signature. Sends the doc as a
// locked Dropbox Sign signature request (PDF) instead of an editable Doc link.
export interface SendForSignatureBody {
  toEmail?: string;
  signerName?: string;
  subject?: string;
  message?: string;
}

export interface SendForSignatureResponse {
  ok: true;
  signatureRequestId: string;
  // True while DROPBOX_SIGN_TEST_MODE !== "false" — the request is free,
  // non-binding, and the signed PDF carries a test-mode watermark.
  testMode: boolean;
  sentToEmail: string;
  sentAt: string;
}
