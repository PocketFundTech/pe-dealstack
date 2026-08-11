// Exports a LegalDocument as a .docx or .pdf binary.
//
// Strategy: go through Google Drive's native Doc export so the output
// matches exactly what the counterparty sees in the shared Google Doc.
//   * SENT docs already have a googleDocId — export that Doc directly,
//     creating zero extra Drive objects. (Its body is the substituted
//     snapshot, so the download shows resolved token values.)
//   * DRAFT docs (no googleDocId) get a throwaway Doc created from the
//     current `content` HTML, exported, then deleted. The temp Doc is
//     never shared, so the counterparty never sees it. Draft downloads
//     therefore still contain the raw [TOKEN] literals — intentional,
//     it's a working draft.
//
// Requires the user's Google Workspace connection (same token as send) —
// returns GOOGLE_NOT_CONNECTED (409) when absent so the route can surface
// a "connect Google" hint, mirroring legalDocSendService.

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getProviderAccessToken } from '../integrations/_platform/tokenStore.js';
import {
  createDocFromHtml,
  exportDocAs,
  deleteFile,
  type DriveExportFormat,
} from '../integrations/googleDrive/client.js';
import { GoogleDriveError } from '../integrations/googleDrive/types.js';

export type LegalDocExportErrorCode =
  | 'GOOGLE_NOT_CONNECTED'
  | 'GOOGLE_SCOPES_MISSING'
  | 'NO_CONTENT'
  | 'DOCUMENT_NOT_FOUND'
  | 'DRIVE_API_ERROR';

export class LegalDocExportError extends Error {
  code: LegalDocExportErrorCode;
  status: number;
  details?: string;
  constructor(
    code: LegalDocExportErrorCode,
    message: string,
    status: number,
    details?: string,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ExportLegalDocumentInput {
  documentId: string;
  organizationId: string;
  userId: string; // internal User.id — for the Workspace token lookup
  format: DriveExportFormat;
  // Optional HTML rendered instead of the stored document — the eSign flow
  // passes token-substituted content with the Dropbox Sign text-tag signature
  // block placed in it. When set it ALWAYS forces a throwaway Doc built from
  // this HTML, even if the row has a persistent googleDocId: that shared Doc
  // carries no text tags, so exporting it would strip the signature fields and
  // Dropbox would auto-place a single one. The download path omits this and
  // keeps exporting the persistent Doc.
  contentOverride?: string;
}

export interface ExportLegalDocumentResult {
  bytes: Buffer;
  filename: string;
  contentType: string;
}

interface ExportDocRow {
  id: string;
  organizationId: string;
  title: string;
  content: string | null;
  googleDocId: string | null;
}

const CONTENT_TYPE: Record<DriveExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

function safeFilename(title: string, format: DriveExportFormat): string {
  const base =
    (title || 'document')
      .replace(/[^\w\-. ]+/g, '') // strip path/quote/control chars
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 120) || 'document';
  return `${base}.${format}`;
}

async function loadDoc(id: string, orgId: string): Promise<ExportDocRow> {
  const { data, error } = await supabase
    .from('LegalDocument')
    .select('id, organizationId, title, content, googleDocId')
    .eq('id', id)
    .eq('organizationId', orgId)
    .maybeSingle();
  if (error) {
    throw new LegalDocExportError(
      'DOCUMENT_NOT_FOUND',
      'Failed to load document',
      502,
      error.message,
    );
  }
  if (!data) {
    throw new LegalDocExportError('DOCUMENT_NOT_FOUND', 'Legal document not found', 404);
  }
  return data as ExportDocRow;
}

function mapDriveErr(err: unknown): LegalDocExportError {
  if (err instanceof GoogleDriveError) {
    if (err.code === 'INVALID_TOKEN' || err.code === 'INSUFFICIENT_SCOPE') {
      return new LegalDocExportError(
        'GOOGLE_SCOPES_MISSING',
        'Google connection lacks Drive/Docs scope — please reconnect Google Workspace',
        409,
        err.details ?? err.message,
      );
    }
    return new LegalDocExportError(
      'DRIVE_API_ERROR',
      `Drive export failed: ${err.message}`,
      502,
      err.details ?? err.message,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new LegalDocExportError('DRIVE_API_ERROR', 'Drive export failed', 502, message);
}

export async function exportLegalDocument(
  input: ExportLegalDocumentInput,
): Promise<ExportLegalDocumentResult> {
  const doc = await loadDoc(input.documentId, input.organizationId);

  const accessToken = await getProviderAccessToken({
    userId: input.userId,
    organizationId: input.organizationId,
    providerId: 'google_calendar',
  });
  if (!accessToken) {
    throw new LegalDocExportError(
      'GOOGLE_NOT_CONNECTED',
      'Google Workspace is not connected — open Settings → Integrations to enable downloads',
      409,
    );
  }

  // Pick the source Doc:
  //   1. contentOverride (eSign) → always a throwaway Doc built from it, so the
  //      text-tag signature block actually reaches the PDF.
  //   2. else a persistent googleDocId → export it directly (download path).
  //   3. else (plain draft) → a throwaway Doc from the raw content.
  let fileId: string;
  let tempFileId: string | null = null;
  const overrideBody = input.contentOverride?.trim()
    ? input.contentOverride
    : null;
  if (overrideBody || !doc.googleDocId) {
    const body = overrideBody ?? doc.content;
    if (!body || !body.trim()) {
      throw new LegalDocExportError('NO_CONTENT', 'Document has no content to export', 409);
    }
    try {
      const created = await createDocFromHtml(
        accessToken,
        doc.title || 'Document',
        body,
      );
      fileId = created.id;
      tempFileId = created.id;
    } catch (err) {
      throw mapDriveErr(err);
    }
  } else {
    fileId = doc.googleDocId;
  }

  let bytes: Buffer;
  try {
    bytes = await exportDocAs(accessToken, fileId, input.format);
  } catch (err) {
    throw mapDriveErr(err);
  } finally {
    if (tempFileId) {
      // Best-effort cleanup — never fail the download over a leaked temp Doc.
      try {
        await deleteFile(accessToken, tempFileId);
      } catch (cleanupErr) {
        log.warn('legalDocExportService: temp Doc cleanup failed', {
          documentId: doc.id,
          tempFileId,
          message:
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
    }
  }

  return {
    bytes,
    filename: safeFilename(doc.title, input.format),
    contentType: CONTENT_TYPE[input.format],
  };
}
