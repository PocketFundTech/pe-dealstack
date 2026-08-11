// eSignature send + completion handling via Dropbox Sign.
//
// This is the "locked signed PDF" alternative to legalDocSendService's
// "share an editable Google Doc link" model. Flow:
//
//   1. sendLegalDocForSignature — render the LegalDocument to PDF (reusing
//      exportLegalDocument, the same Google-Drive export the download button
//      uses), hand that PDF to Dropbox Sign as a signature request, and flip
//      the row to SENT with the signature_request_id stamped on metadata.esign.
//   2. handleDropboxSignEvent — when Dropbox Sign POSTs back that everyone
//      signed, download the flattened signed PDF, stash it in the documents
//      bucket, and flip the row to SIGNED.
//
// Prototype scope (test mode by default): single signer (the counterparty),
// one PDF, no countersign. Multi-signer + countersign are follow-ups.

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import {
  exportLegalDocument,
  LegalDocExportError,
} from './legalDocExportService.js';
import {
  getDropboxSignConfig,
  sendSignatureRequest,
  downloadSignedPdf,
  DropboxSignError,
} from '../integrations/dropboxSign/client.js';
import { placeEsignSignatureBlock } from './legalDocSignatureBlock.js';
import { substituteTokens } from './legalDocSubstituteService.js';
import {
  loadDealForLegalDoc,
  loadOrgForLegalDoc,
  buildLegalDocTokenValues,
} from './legalDocLookups.js';

export type LegalDocEsignErrorCode =
  | 'NOT_CONFIGURED'
  | 'DOCUMENT_NOT_FOUND'
  | 'NO_RECIPIENT'
  | 'EXPORT_FAILED'
  | 'PROVIDER_ERROR';

export class LegalDocEsignError extends Error {
  code: LegalDocEsignErrorCode;
  status: number;
  details?: string;
  constructor(
    code: LegalDocEsignErrorCode,
    message: string,
    status: number,
    details?: string,
  ) {
    super(message);
    this.name = 'LegalDocEsignError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// metadata.esign sub-object persisted on the LegalDocument row. `status`
// tracks the eSignature lifecycle independently of the row's coarse
// DRAFT/SENT/SIGNED column.
interface EsignMetadata {
  provider: 'dropbox_sign';
  signatureRequestId: string;
  testMode: boolean;
  status: 'sent' | 'signed';
  sentAt: string;
  signedAt?: string;
  signedPdfPath?: string;
}

export interface SendForSignatureInput {
  documentId: string;
  organizationId: string;
  userId: string; // internal User.id — for the Workspace token lookup in export
  toEmail?: string;
  signerName?: string;
  subject?: string;
  message?: string;
}

export interface SendForSignatureResult {
  ok: true;
  signatureRequestId: string;
  testMode: boolean;
  sentToEmail: string;
  sentAt: string;
}

interface EsignDocRow {
  id: string;
  organizationId: string;
  dealId: string;
  title: string;
  content: string | null;
  counterpartyName: string | null;
  counterpartyAddress: string | null;
  counterpartyEmail: string | null;
  jurisdiction: string | null;
  effectiveDate: string | null;
  metadata: Record<string, unknown> | null;
}

async function loadDoc(id: string, orgId: string): Promise<EsignDocRow> {
  const { data, error } = await supabase
    .from('LegalDocument')
    .select(
      'id, organizationId, dealId, title, content, counterpartyName, counterpartyAddress, counterpartyEmail, jurisdiction, effectiveDate, metadata',
    )
    .eq('id', id)
    .eq('organizationId', orgId)
    .maybeSingle();
  if (error) {
    throw new LegalDocEsignError(
      'DOCUMENT_NOT_FOUND',
      'Failed to load document',
      502,
      error.message,
    );
  }
  if (!data) {
    throw new LegalDocEsignError('DOCUMENT_NOT_FOUND', 'Legal document not found', 404);
  }
  return data as EsignDocRow;
}

export async function sendLegalDocForSignature(
  input: SendForSignatureInput,
): Promise<SendForSignatureResult> {
  const config = getDropboxSignConfig();
  if (!config) {
    throw new LegalDocEsignError(
      'NOT_CONFIGURED',
      'Dropbox Sign is not configured — set DROPBOX_SIGN_API_KEY',
      409,
    );
  }

  const doc = await loadDoc(input.documentId, input.organizationId);

  const recipient = (input.toEmail ?? doc.counterpartyEmail ?? '').trim();
  if (!recipient) {
    throw new LegalDocEsignError(
      'NO_RECIPIENT',
      'No recipient email — set counterpartyEmail or pass toEmail',
      409,
    );
  }
  const signerName =
    (input.signerName ?? doc.counterpartyName ?? '').trim() || recipient;

  // Resolve tokens (same map as the emailed Google Doc copy) and place the
  // Dropbox Sign signature text-tag block where the user dropped the
  // [SIGNATURE_BLOCK] marker (or appended at the end if they placed none), so
  // the signer gets the finished wording with signature/date fields in a
  // defined spot — not raw [TOKEN] literals and an auto-placed field. Only
  // possible when we have in-app HTML; an imported gdoc (content null,
  // googleDocId set) exports its own Doc untouched and Dropbox auto-places.
  let contentOverride: string | undefined;
  if (doc.content && doc.content.trim()) {
    const deal = await loadDealForLegalDoc(doc.dealId, input.organizationId);
    const org = await loadOrgForLegalDoc(input.organizationId);
    const tokenValues = buildLegalDocTokenValues(doc, deal, org);
    contentOverride = placeEsignSignatureBlock(
      substituteTokens(doc.content, tokenValues),
    );
  }

  // Render the document to a PDF — same Drive export the download button uses.
  let pdf;
  try {
    pdf = await exportLegalDocument({
      documentId: input.documentId,
      organizationId: input.organizationId,
      userId: input.userId,
      format: 'pdf',
      contentOverride,
    });
  } catch (err) {
    if (err instanceof LegalDocExportError) {
      throw new LegalDocEsignError(
        'EXPORT_FAILED',
        `Couldn't render the document to PDF: ${err.message}`,
        err.status,
        err.details,
      );
    }
    throw err;
  }

  let result;
  try {
    result = await sendSignatureRequest({
      apiKey: config.apiKey,
      testMode: config.testMode,
      pdf: pdf.bytes,
      filename: pdf.filename,
      title: doc.title || 'Document for signature',
      subject: input.subject?.trim() || `${doc.title || 'Document'} — signature request`,
      message: input.message?.trim() || undefined,
      signer: { email: recipient, name: signerName },
      useTextTags: true,
      metadata: {
        legalDocumentId: doc.id,
        organizationId: doc.organizationId,
      },
    });
  } catch (err) {
    if (err instanceof DropboxSignError) {
      throw new LegalDocEsignError(
        'PROVIDER_ERROR',
        `Dropbox Sign rejected the request: ${err.message}`,
        err.status === 401 || err.status === 403 ? 409 : 502,
        err.details,
      );
    }
    throw err;
  }

  const sentAt = new Date().toISOString();
  const esign: EsignMetadata = {
    provider: 'dropbox_sign',
    signatureRequestId: result.signatureRequestId,
    testMode: result.testMode,
    status: 'sent',
    sentAt,
  };
  const nextMetadata = {
    ...((doc.metadata as Record<string, unknown> | null) ?? {}),
    esign,
  };
  const { error: updateErr } = await supabase
    .from('LegalDocument')
    .update({
      status: 'SENT',
      sentAt,
      sentToEmail: recipient,
      metadata: nextMetadata,
      updatedAt: sentAt,
    })
    .eq('id', doc.id)
    .eq('organizationId', doc.organizationId);
  if (updateErr) {
    // The request is already out at Dropbox Sign — log loudly but don't fail
    // the call. The webhook still carries the metadata to reconcile later.
    log.error('legalDocEsignService: failed to persist esign metadata', updateErr, {
      documentId: doc.id,
      signatureRequestId: result.signatureRequestId,
    });
  }

  return {
    ok: true,
    signatureRequestId: result.signatureRequestId,
    testMode: result.testMode,
    sentToEmail: recipient,
    sentAt,
  };
}

// ─────────────────────────── webhook handling ──────────────────────────── //

// Shape of the slice of a Dropbox Sign event we actually read.
interface DropboxSignEvent {
  event?: {
    event_type?: string;
  };
  signature_request?: {
    signature_request_id?: string;
    is_complete?: boolean;
    metadata?: Record<string, unknown> | null;
  };
}

const SIGNED_BUCKET = 'documents';

async function storeSignedPdf(
  documentId: string,
  signatureRequestId: string,
  pdf: Buffer,
): Promise<string | null> {
  const path = `legal-documents/${documentId}/signed-${signatureRequestId}.pdf`;
  const { error } = await supabase.storage
    .from(SIGNED_BUCKET)
    .upload(path, pdf, { contentType: 'application/pdf', upsert: true });
  if (error) {
    log.error('legalDocEsignService: signed PDF upload failed', error, {
      documentId,
      signatureRequestId,
    });
    return null;
  }
  return path;
}

/**
 * Processes a verified Dropbox Sign webhook event. Only acts on the
 * "all signed" completion event: downloads the flattened signed PDF, stores
 * it in the documents bucket, and flips the LegalDocument to SIGNED. Every
 * other event type (sent, viewed, declined…) is acknowledged + ignored for
 * this prototype. Never throws — the webhook route always answers 200 so
 * Dropbox Sign doesn't retry-storm us; failures are logged for follow-up.
 */
export async function handleDropboxSignEvent(event: DropboxSignEvent): Promise<void> {
  const eventType = event.event?.event_type;
  if (eventType !== 'signature_request_all_signed') {
    log.info('legalDocEsignService: ignoring event', { eventType });
    return;
  }

  const sigReq = event.signature_request;
  const signatureRequestId = sigReq?.signature_request_id;
  const documentId =
    typeof sigReq?.metadata?.legalDocumentId === 'string'
      ? (sigReq.metadata.legalDocumentId as string)
      : null;
  const organizationId =
    typeof sigReq?.metadata?.organizationId === 'string'
      ? (sigReq.metadata.organizationId as string)
      : null;
  if (!signatureRequestId || !documentId || !organizationId) {
    log.warn('legalDocEsignService: completion event missing identifiers', {
      signatureRequestId,
      documentId,
      organizationId,
    });
    return;
  }

  const config = getDropboxSignConfig();
  if (!config) {
    log.error(
      'legalDocEsignService: cannot process completion — Dropbox Sign not configured',
      new Error('NOT_CONFIGURED'),
      { documentId, signatureRequestId },
    );
    return;
  }

  const { data: row } = await supabase
    .from('LegalDocument')
    .select('id, metadata')
    .eq('id', documentId)
    .eq('organizationId', organizationId)
    .maybeSingle();
  if (!row) {
    log.warn('legalDocEsignService: completion for unknown document', {
      documentId,
      signatureRequestId,
    });
    return;
  }

  let signedPdfPath: string | null = null;
  try {
    const pdf = await downloadSignedPdf(config.apiKey, signatureRequestId);
    signedPdfPath = await storeSignedPdf(documentId, signatureRequestId, pdf);
  } catch (err) {
    // Couldn't fetch/store the PDF — still mark SIGNED (the signature is real)
    // and log so we can re-pull the artifact later.
    log.error('legalDocEsignService: signed PDF retrieval failed', err, {
      documentId,
      signatureRequestId,
    });
  }

  const signedAt = new Date().toISOString();
  const existingMeta = (row as { metadata: Record<string, unknown> | null }).metadata ?? {};
  const existingEsign = (existingMeta.esign as EsignMetadata | undefined) ?? {
    provider: 'dropbox_sign' as const,
    signatureRequestId,
    testMode: config.testMode,
    status: 'sent' as const,
    sentAt: signedAt,
  };
  const nextEsign: EsignMetadata = {
    ...existingEsign,
    status: 'signed',
    signedAt,
    ...(signedPdfPath ? { signedPdfPath } : {}),
  };
  const { error: updateErr } = await supabase
    .from('LegalDocument')
    .update({
      status: 'SIGNED',
      signedAt,
      metadata: { ...existingMeta, esign: nextEsign },
      updatedAt: signedAt,
    })
    .eq('id', documentId)
    .eq('organizationId', organizationId);
  if (updateErr) {
    log.error('legalDocEsignService: failed to mark SIGNED', updateErr, {
      documentId,
      signatureRequestId,
    });
    return;
  }
  log.info('legalDocEsignService: document signed', {
    documentId,
    signatureRequestId,
    signedPdfPath,
  });
}
