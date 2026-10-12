import { createHash } from 'node:crypto';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { validateFile, sanitizeFilename, isPotentiallyDangerous } from './fileValidator.js';
import { extractTextFromPDF } from './pdfExtractor.js';

// Shared "a file lands in a deal's data room" steps. The upload route
// (routes/documents-upload.ts) and server-side importers (HubSpot files) both
// use these, so type detection, folder placement and text extraction stay
// identical. addFileToDeal is the server-side entry point: it never embeds or
// runs AI — indexing for chat is a separate, user-clicked action.

/** Guess the document type from its name / MIME type (the upload route's rules). */
export function inferDocumentType(name: string, mimeType: string | null): string {
  const lowerName = name.toLowerCase();
  const lowerMime = (mimeType ?? '').toLowerCase();
  // Spreadsheets default to FINANCIALS so the deep financial extraction picks them up.
  const looksLikeSpreadsheet =
    lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls') || lowerName.endsWith('.csv') ||
    lowerMime.includes('spreadsheet') || lowerMime.includes('excel') ||
    lowerMime === 'text/csv' || lowerMime === 'application/csv';

  if (lowerName.includes('cim') || lowerName.includes('confidential')) return 'CIM';
  if (lowerName.includes('teaser')) return 'TEASER';
  if (
    lowerName.includes('financial') || lowerName.includes('model') || lowerName.includes('p&l') ||
    lowerName.includes('p_l') || lowerName.includes('income') || lowerName.includes('balance') ||
    lowerName.includes('cashflow') || lowerName.includes('cash flow') ||
    lowerName.includes('master sheet') || lowerName.includes('mastersheet') || looksLikeSpreadsheet
  ) return 'FINANCIALS';
  if (lowerName.includes('legal') || lowerName.includes('dd')) return 'LEGAL';
  if (lowerName.includes('nda')) return 'NDA';
  if (lowerName.includes('loi') || lowerName.includes('letter')) return 'LOI';
  if (lowerName.includes('email') || lowerName.endsWith('.msg')) return 'EMAIL';
  return 'OTHER';
}

const FOLDER_PATTERNS: Record<string, RegExp> = {
  CIM: /financ|cim/i,
  FINANCIALS: /financ/i,
  LEGAL: /legal/i,
  NDA: /legal|nda/i,
  LOI: /legal|commercial/i,
  DD_REPORT: /due\s*diligence|dd/i,
};

const DEFAULT_FOLDERS = [
  { name: '100 Financials', sortOrder: 100, description: 'Financial statements, projections, and analysis' },
  { name: '200 Legal', sortOrder: 200, description: 'Legal documents, contracts, and agreements' },
  { name: '300 Commercial', sortOrder: 300, description: 'Commercial due diligence materials' },
  { name: '400 HR & Data', sortOrder: 400, description: 'HR documents and data room materials' },
  { name: '500 Intellectual Property', sortOrder: 500, description: 'IP documentation and patents' },
];

/**
 * The VDR folder a new document of `docType` goes into. Creates the default
 * folder set when the deal has none yet.
 */
export async function resolveDefaultFolderId(dealId: string, docType: string): Promise<string | null> {
  let { data: folders } = await supabase
    .from('Folder').select('id, name').eq('dealId', dealId).order('name', { ascending: true });

  if (!folders || folders.length === 0) {
    const { data: created } = await supabase
      .from('Folder')
      .insert(DEFAULT_FOLDERS.map((f) => ({ ...f, dealId, parentId: null, isRestricted: false })))
      .select('id, name');
    if (created && created.length > 0) {
      folders = created;
      log.info('Auto-created default VDR folders for deal', { dealId, count: created.length });
    }
  }
  if (!folders || folders.length === 0) return null;

  const pattern = FOLDER_PATTERNS[docType];
  const list = folders as Array<{ id: string; name: string }>;
  const match = pattern ? list.find((f) => pattern.test(f.name)) : undefined;
  return match?.id ?? list[0]?.id ?? null;
}

export interface LocalText {
  text: string | null;
  numPages: number | null;
  /** The upload route's extraction status: Excel with text stays 'processing' (AI may follow). */
  status: 'completed' | 'failed' | 'processing';
}

/** Local (no-AI) text extraction for PDFs and spreadsheets. */
export async function extractLocalText(buffer: Buffer, mimeType: string | null, name: string): Promise<LocalText> {
  if (mimeType === 'application/pdf') {
    const extraction = await extractTextFromPDF(buffer);
    if (!extraction) return { text: null, numPages: null, status: 'failed' };
    // PostgreSQL can't store NUL characters.
    return { text: extraction.text.replace(/\u0000/g, ''), numPages: extraction.numPages, status: 'completed' };
  }
  // Lazy-loaded so the lite bundle stays light on cold start.
  const { isExcelFile } = await import('./excelFinancialExtractor.js');
  if (isExcelFile(mimeType, name)) {
    try {
      const { excelToMarkdown } = await import('./excelToMarkdown.js');
      const markdown = excelToMarkdown(buffer);
      if (markdown) return { text: markdown.replace(/\u0000/g, ''), numPages: null, status: 'processing' };
      return { text: null, numPages: null, status: 'completed' };
    } catch (err) {
      log.error('Excel extraction failed', err, { name });
      return { text: null, numPages: null, status: 'completed' };
    }
  }
  return { text: null, numPages: null, status: 'completed' };
}

export interface AddFileInput {
  dealId: string;
  filename: string;
  buffer: Buffer;
  mimeType: string;
  /** Internal User.id, or null. */
  uploadedBy: string | null;
  /** Set by the HubSpot importer; omitted from the row otherwise. */
  hubspotFileId?: string | null;
}

export type AddFileResult =
  | { outcome: 'created' | 'existing'; documentId: string }
  | { outcome: 'rejected'; reason: string };

/**
 * Store a file in a deal's data room: validation, sha256 de-duplication,
 * default folder, local text extraction. No embedding and no AI.
 * Throws when storage or the insert fails.
 */
export async function addFileToDeal(input: AddFileInput): Promise<AddFileResult> {
  const { dealId, filename, buffer, mimeType, uploadedBy, hubspotFileId } = input;

  if (hubspotFileId) {
    const { data: already } = await supabase
      .from('Document').select('id').eq('dealId', dealId).eq('hubspotFileId', hubspotFileId).maybeSingle();
    if (already) return { outcome: 'existing', documentId: (already as { id: string }).id };
  }

  const validation = validateFile(buffer, filename, mimeType);
  if (!validation.isValid) return { outcome: 'rejected', reason: validation.error ?? 'File failed validation' };
  if (isPotentiallyDangerous(buffer, filename)) return { outcome: 'rejected', reason: 'File appears to contain executable or script content' };

  const fileSha256 = createHash('sha256').update(buffer).digest('hex');
  const { data: same } = await supabase
    .from('Document').select('id, hubspotFileId').eq('dealId', dealId).eq('fileSha256', fileSha256).limit(1).maybeSingle();
  if (same) {
    const row = same as { id: string; hubspotFileId?: string | null };
    if (hubspotFileId && !row.hubspotFileId) {
      const { error } = await supabase.from('Document').update({ hubspotFileId }).eq('id', row.id);
      if (error) {
        log.warn('Could not link HubSpot file to existing document', {
          documentId: row.id, hubspotFileId, error: (error as { message?: string }).message,
        });
      }
    }
    return { outcome: 'existing', documentId: row.id };
  }

  const safeName = validation.sanitizedFilename || sanitizeFilename(filename);
  const filePath = `${dealId}/${Date.now()}_${safeName}`;
  const { error: uploadError } = await supabase.storage
    .from('documents').upload(filePath, buffer, { contentType: mimeType, upsert: false });
  if (uploadError) throw new Error(`Storage upload failed: ${(uploadError as { message?: string }).message ?? 'unknown error'}`);

  const docType = inferDocumentType(safeName, mimeType);
  const folderId = await resolveDefaultFolderId(dealId, docType);
  const local = await extractLocalText(buffer, mimeType, safeName);

  const { data: doc, error: insertError } = await supabase
    .from('Document')
    .insert({
      dealId,
      folderId,
      uploadedBy,
      name: safeName,
      type: docType,
      fileUrl: filePath,
      fileSize: buffer.length,
      mimeType,
      fileSha256,
      extractedText: local.text,
      // No AI follows a server-side import, so the row is final.
      status: 'completed',
      ...(hubspotFileId ? { hubspotFileId } : {}),
    })
    .select('id')
    .single();
  if (insertError || !doc) throw new Error(`Document insert failed: ${(insertError as { message?: string } | null)?.message ?? 'no row'}`);

  await supabase.from('Deal')
    .update({ lastDocument: safeName, lastDocumentUpdated: new Date().toISOString() })
    .eq('id', dealId);

  return { outcome: 'created', documentId: (doc as { id: string }).id };
}
