import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { z } from 'zod';
import multer from 'multer';
import type { ExtractedDealData } from '../services/aiExtractor.js';
import { AuditLog, logFromRequest, AUDIT_ACTIONS, RESOURCE_TYPES, SEVERITY } from '../services/auditLog.js';
import { validateFile, sanitizeFilename, isPotentiallyDangerous, ALLOWED_MIME_TYPES } from '../services/fileValidator.js';
import { AICache } from '../services/aiCache.js';
import { log } from '../utils/logger.js';
import { notifyDealTeam, resolveUserId } from './notifications.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { extractTextFromPDF } from '../services/pdfExtractor.js';
import { acquireExtractionSlot, acquireExtractionSlotBy, releaseExtractionSlot } from '../services/agents/financialAgent/concurrency.js';

/** How long an upload waits for an extraction slot before skipping (see B3). */
const UPLOAD_SLOT_WAIT_MS = 30_000;
/** Text the deal-field top-up read sees on a data-room upload (~16 pages). */
const DATA_ROOM_TEXT_CHARS = 40_000;
import { findExistingDocument, logDuplicateSkip } from '../services/documentDedup.js';
import { runAfterResponse, type RequestWithAfterResponse } from '../utils/afterResponse.js';
import { resolveUploadedFile, cleanupStagingObject } from './ingest-shared.js';
import { getProviderAccessToken } from '../integrations/_platform/tokenStore.js';
import {
  getDriveFileMetadata,
  downloadDriveFile,
  exportDriveFile,
  isGoogleNativeMime,
  driveExportTargetFor,
} from '../integrations/googleDrive/client.js';
import { GoogleDriveError } from '../integrations/googleDrive/types.js';
import { emitWebhookEvent } from '../services/outboundWebhooks.js';

const router = Router();

// Configure multer for memory storage (we'll upload to Supabase)
// Initial filter based on MIME type, deep validation happens after upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max (individual limits applied after)
    files: 1, // Single file upload only
  },
  fileFilter: (req, file, cb) => {
    // Basic MIME type check - deep validation with magic bytes happens after
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: PDF, Excel, CSV, Word, Email, Images'));
    }
  },
});

// Document type enum
const documentTypes = ['CIM', 'TEASER', 'FINANCIALS', 'LEGAL', 'NDA', 'LOI', 'EMAIL', 'PDF', 'EXCEL', 'DOC', 'OTHER'] as const;

// POST /api/deals/:dealId/documents - Upload document
//
// Extracted to a named function so the Google Drive import route below can
// reuse the EXACT same pipeline (validation, Supabase storage, dedup, PDF/Excel
// extraction, deep financial pass, VDR folder auto-assignment, RAG embedding,
// activity/audit/notifications) by synthesizing a multer-style `req.file` from
// the downloaded Drive bytes. Keep this handler the single source of truth for
// "a document was added to a deal" — do not fork it.
//
// Exported for the same reason: routes/doc-request-portal.ts feeds
// broker/seller uploads (unauthenticated, token-gated) through this exact
// pipeline by synthesizing a request whose `user.organizationId` comes from
// the DocRequest row — the token is the credential, so the org is derived
// from the token, never from anything the uploader supplies.
export async function handleDocumentUpload(req: Request, res: Response) {
  try {
    // Lazy-load heavy extraction deps so the shared lite bundle stays light on cold start
    const { extractDealDataFromText } = await import('../services/aiExtractor.js');
    const { embedDocument } = await import('../rag.js');
    const { tryCompleteOnboardingStep } = await import('./onboarding.js');
    const { excelToMarkdown } = await import('../services/excelToMarkdown.js');
    const { isExcelFile } = await import('../services/excelFinancialExtractor.js');
    const { runDeepPass } = await import('../services/financialExtractionOrchestrator.js');
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // Accepts either multipart/form-data (legacy — multer populates
    // req.file) or a JSON body `{ storagePath, fileName, mimeType, size }`
    // pointing at a file already staged in Supabase Storage via
    // POST /api/uploads/sign — see ingest-shared.ts#resolveUploadedFile.
    // A file is optional here (a Document row can be metadata-only), so
    // `file` staying null is not itself an error.
    const resolvedUpload = await resolveUploadedFile(req);
    if (resolvedUpload.error) {
      return res.status(resolvedUpload.error.status).json(resolvedUpload.error.body);
    }
    const file = resolvedUpload.file;
    const stagingPathToClean = resolvedUpload.cleanupStoragePath;

    // verifyDealAccess() above already confirmed the Deal row exists (and is
    // in this org) — a second SELECT here was redundant.

    let fileUrl = null;
    let fileSize = null;
    let mimeType = null;
    let fileSha256: string | null = null;
    let documentName = req.body.name;

    // If file is provided, validate and upload to Supabase Storage
    if (file) {
      // SHA-256 fingerprint of the original uploaded bytes — stored at upload
      // time so we (and customers) can verify the file hasn't been tampered
      // with downstream, and so a leaked file can be matched to its origin.
      const { createHash } = await import('node:crypto');
      fileSha256 = createHash('sha256').update(file.buffer).digest('hex');

      // Deep file validation with magic bytes verification
      const validation = validateFile(file.buffer, file.originalname, file.mimetype);
      if (!validation.isValid) {
        log.warn('File validation failed', { filename: file.originalname, error: validation.error });
        return res.status(400).json({
          error: 'File validation failed',
          details: validation.error,
        });
      }

      // Additional check for potentially dangerous content
      if (isPotentiallyDangerous(file.buffer, file.originalname)) {
        log.warn('Potentially dangerous file detected', { filename: file.originalname });
        return res.status(400).json({
          error: 'File validation failed',
          details: 'File appears to contain executable or script content',
        });
      }

      fileSize = file.size;
      mimeType = file.mimetype;
      // Use sanitized filename from validation
      const safeName = validation.sanitizedFilename || sanitizeFilename(file.originalname);
      documentName = documentName || safeName;

      // Generate unique filename with sanitization
      const timestamp = Date.now();
      const filePath = `${dealId}/${timestamp}_${safeName}`;

      // Upload to Supabase Storage
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('documents')
        .upload(filePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        log.error('Storage upload error', uploadError);
        // Continue without file URL if storage fails (bucket might not exist)
      } else {
        // Store the storage path (not full URL) — signed URLs generated on demand
        fileUrl = filePath;
      }
    }

    // Dedup: if a Document with the same (dealId, name, fileSize) already
    // exists for this deal, treat this as a no-op re-upload. Returns the
    // existing row so the client gets a 200-shaped response instead of an
    // error, but we skip extraction/embedding/activity to avoid doubling cost.
    //
    // Security: we ALWAYS recompute SHA-256 above (don't trust existing row's
    // value) and require fingerprints to match before treating as a dedup.
    // If (dealId, name, fileSize) collide but content differs, that's a
    // security-relevant event — bypass dedup and emit an audit event so the
    // collision is visible (e.g. someone trying to overwrite an audit-trail
    // doc with a same-name/size impostor).
    //
    // Fingerprint logging uses only an 8-char prefix at INFO; the full hex
    // lives in DB columns / audit metadata.
    const existingDuplicate = await findExistingDocument(dealId, documentName, fileSize, { requireFileUrl: true });
    const sha256Prefix = fileSha256 ? fileSha256.slice(0, 8) : null;
    if (existingDuplicate) {
      const existingPrefix = existingDuplicate.fileSha256 ? existingDuplicate.fileSha256.slice(0, 8) : null;
      // If we have both fingerprints AND they differ, this is a metadata
      // collision (same name + size, different content). Do NOT dedup.
      if (fileSha256 && existingDuplicate.fileSha256 && fileSha256 !== existingDuplicate.fileSha256) {
        log.warn('Document upload metadata collision: same (dealId, name, fileSize) but different SHA-256', {
          dealId,
          existingDocId: existingDuplicate.id,
          name: documentName,
          fileSize,
          newSha256Prefix: sha256Prefix,
          existingSha256Prefix: existingPrefix,
        });
        await logFromRequest(req, 'DOCUMENT_UPLOADED' as any, {
          resourceType: RESOURCE_TYPES.DOCUMENT,
          resourceId: existingDuplicate.id,
          resourceName: documentName,
          description: 'upload_metadata_collision: same name+size, different content',
          severity: SEVERITY.WARNING,
          metadata: {
            dealId,
            collision: true,
            newSha256Prefix: sha256Prefix,
            existingSha256Prefix: existingPrefix,
          },
        });
        // Fall through to normal insert path.
      } else {
        // Genuine dedup hit: either fingerprints match, or existing row
        // pre-dates fingerprinting (null fileSha256) — treat as dedup but
        // still emit an audit event so the upload attempt is recorded.
        logDuplicateSkip(existingDuplicate, {
          dealId,
          name: documentName,
          fileSize,
          newFileUrl: fileUrl,
        });
        await logFromRequest(req, AUDIT_ACTIONS.DOCUMENT_UPLOADED, {
          resourceType: RESOURCE_TYPES.DOCUMENT,
          resourceId: existingDuplicate.id,
          resourceName: documentName,
          description: 'upload_deduped: matched existing document',
          metadata: {
            dealId,
            deduped: true,
            sha256Prefix,
            fingerprintMatched: !!(fileSha256 && existingDuplicate.fileSha256 && fileSha256 === existingDuplicate.fileSha256),
            existingFingerprintMissing: !existingDuplicate.fileSha256,
          },
        });
        return res.status(200).json({ ...existingDuplicate, dealUpdated: false, updatedFields: [] });
      }
    }

    // Determine document type from filename if not provided. Spreadsheets
    // (XLSX / XLS / CSV) default to FINANCIALS so the re-extract loop in
    // financials-extraction.ts (which filters `type IN ('CIM','FINANCIALS')`)
    // picks them up. Without this, a Master Sheet upload silently misses
    // the deep extraction path and ends up as OTHER, never producing
    // FinancialStatement rows even though the data is sitting in the DB.
    let docType = req.body.type || 'OTHER';
    if (docType === 'OTHER' && documentName) {
      const lowerName = documentName.toLowerCase();
      const lowerMime = (mimeType ?? '').toLowerCase();
      const looksLikeSpreadsheet =
        lowerName.endsWith('.xlsx') ||
        lowerName.endsWith('.xls') ||
        lowerName.endsWith('.csv') ||
        lowerMime.includes('spreadsheet') ||
        lowerMime.includes('excel') ||
        lowerMime === 'text/csv' ||
        lowerMime === 'application/csv';

      if (lowerName.includes('cim') || lowerName.includes('confidential')) docType = 'CIM';
      else if (lowerName.includes('teaser')) docType = 'TEASER';
      else if (
        lowerName.includes('financial') ||
        lowerName.includes('model') ||
        lowerName.includes('p&l') ||
        lowerName.includes('p_l') ||
        lowerName.includes('income') ||
        lowerName.includes('balance') ||
        lowerName.includes('cashflow') ||
        lowerName.includes('cash flow') ||
        lowerName.includes('master sheet') ||
        lowerName.includes('mastersheet') ||
        looksLikeSpreadsheet
      ) docType = 'FINANCIALS';
      else if (lowerName.includes('legal') || lowerName.includes('dd')) docType = 'LEGAL';
      else if (lowerName.includes('nda')) docType = 'NDA';
      else if (lowerName.includes('loi') || lowerName.includes('letter')) docType = 'LOI';
      else if (lowerName.includes('email') || lowerName.endsWith('.msg')) docType = 'EMAIL';
    }

    // Parse optional fields
    let aiAnalysis = null;
    if (req.body.aiAnalysis) {
      try {
        aiAnalysis = typeof req.body.aiAnalysis === 'string'
          ? JSON.parse(req.body.aiAnalysis)
          : req.body.aiAnalysis;
      } catch (e) {
        // Ignore parse errors
      }
    }

    let tags: string[] = [];
    if (req.body.tags) {
      tags = typeof req.body.tags === 'string'
        ? req.body.tags.split(',').map((t: string) => t.trim())
        : req.body.tags;
    }

    // Extract text from PDF / Excel if applicable. This is local parsing
    // only (no LLM call), so it always runs inline before the Document row
    // is created — it's needed to populate extractedText on the row and to
    // decide whether there's AI work left to defer (see needsAiWork below).
    let extractedText: string | null = null;
    let extractionStatus = 'pending';
    let numPages: number | null = null;

    if (file && mimeType === 'application/pdf') {
      extractionStatus = 'processing';
      log.info('Starting PDF extraction', { documentName });

      const extraction = await extractTextFromPDF(file.buffer);
      if (extraction) {
        // Remove null characters that PostgreSQL can't store
        extractedText = extraction.text.replace(/\u0000/g, '');
        numPages = extraction.numPages;
        extractionStatus = 'completed';
        log.info('PDF extraction completed', { numPages, textLength: extractedText.length });
      } else {
        extractionStatus = 'failed';
        log.warn('PDF extraction failed', { documentName });
      }
    } else if (file && isExcelFile(mimeType, documentName)) {
      // Excel extraction — convert sheets to Markdown tables for RAG / chat
      // context. The AI deal-level extraction (company name / industry /
      // revenue / EBITDA) and the deep per-period FinancialStatement pass
      // both run afterwards, once the Document row exists — see
      // runPostProcessing below.
      extractionStatus = 'processing';
      log.info('Starting Excel-to-Markdown extraction', { documentName });
      try {
        const markdownText = excelToMarkdown(file.buffer);
        if (markdownText) {
          extractedText = markdownText.replace(/\u0000/g, '');
          log.info('Excel extraction completed', { documentName, textLength: extractedText.length });
        } else {
          log.info('Excel extraction: no meaningful content', { documentName });
          extractionStatus = 'completed';
        }
      } catch (excelError) {
        log.error('Excel extraction failed', excelError, { documentName });
        extractionStatus = 'completed'; // don't block upload
      }
    } else if (file) {
      // Other non-PDF files (Word, etc.) — no extraction yet
      extractionStatus = 'completed';
    }

    // Whether there's LLM-dependent work left to do once the Document row
    // exists: the deal-level AI extraction runs whenever we have text at
    // all (PDF or Excel); the Excel deep financial pass additionally runs
    // for Excel files with text. Both are deferred to runPostProcessing
    // below, via runAfterResponse, whenever a post-response hook is present.
    const needsAiWork = !!(file && extractedText && extractedText.length > 0);
    if (needsAiWork) {
      extractionStatus = 'processing';
    }

    // Auto-assign to a VDR folder if none was provided
    let resolvedFolderId = req.body.folderId || null;
    if (!resolvedFolderId) {
      // Try to find a matching folder in this deal's VDR based on document type
      const folderPatterns: Record<string, RegExp> = {
        CIM: /financ|cim/i,
        FINANCIALS: /financ/i,
        LEGAL: /legal/i,
        NDA: /legal|nda/i,
        LOI: /legal|commercial/i,
        DD_REPORT: /due\s*diligence|dd/i,
      };

      // Get existing folders for this deal
      let { data: folders } = await supabase
        .from('Folder')
        .select('id, name')
        .eq('dealId', dealId)
        .order('name', { ascending: true });

      // If deal has no folders at all, auto-create default VDR structure
      if (!folders || folders.length === 0) {
        const defaultFolders = [
          { name: '100 Financials', sortOrder: 100, description: 'Financial statements, projections, and analysis' },
          { name: '200 Legal', sortOrder: 200, description: 'Legal documents, contracts, and agreements' },
          { name: '300 Commercial', sortOrder: 300, description: 'Commercial due diligence materials' },
          { name: '400 HR & Data', sortOrder: 400, description: 'HR documents and data room materials' },
          { name: '500 Intellectual Property', sortOrder: 500, description: 'IP documentation and patents' },
        ];
        const { data: createdFolders } = await supabase
          .from('Folder')
          .insert(defaultFolders.map(f => ({ ...f, dealId, parentId: null, isRestricted: false })))
          .select('id, name');
        if (createdFolders && createdFolders.length > 0) {
          folders = createdFolders;
          log.info('Auto-created default VDR folders for deal', { dealId, count: createdFolders.length });
        }
      }

      // Match document type to folder
      const pattern = folderPatterns[docType];
      if (pattern && folders && folders.length > 0) {
        const match = folders.find((f: any) => pattern.test(f.name));
        resolvedFolderId = match?.id || folders[0]?.id || null;
      } else if (folders && folders.length > 0) {
        // For any doc type without a specific pattern, assign to the first folder
        resolvedFolderId = folders[0]?.id || null;
      }
      if (resolvedFolderId) {
        log.info('Auto-assigned document to folder', { docType, folderId: resolvedFolderId });
      }
    }

    // Resolve the uploader's internal User.id from the authenticated
    // request. Never trust a client-supplied value here — previously this
    // read req.body.uploadedBy, which no caller ever sent, so Author always
    // showed "Unknown" in the VDR table. doc-request-portal.ts / from-drive
    // synthesize req.user without an `id` (token-derived org, no real user),
    // in which case uploadedBy stays null exactly as before.
    const uploadedByUserId = req.user?.id ? await resolveUserId(req.user.id) : null;

    const { data: document, error: docError } = await supabase
      .from('Document')
      .insert({
        dealId,
        folderId: resolvedFolderId,
        uploadedBy: uploadedByUserId,
        name: documentName,
        type: docType,
        fileUrl,
        fileSize,
        mimeType,
        fileSha256,
        extractedData: req.body.extractedData ? JSON.parse(req.body.extractedData) : null,
        extractedText,
        status: extractionStatus,
        confidence: req.body.confidence ? parseFloat(req.body.confidence) : null,
        aiAnalysis,
        aiAnalyzedAt: aiAnalysis ? new Date().toISOString() : null,
        tags: tags.length > 0 ? tags : null,
        isHighlighted: req.body.isHighlighted === 'true' || req.body.isHighlighted === true,
      })
      .select()
      .single();

    if (docError) throw docError;

    // Update deal's lastDocument field — cheap, single-row update, not
    // AI-dependent, so it stays inline regardless of needsAiWork.
    await supabase
      .from('Deal')
      .update({
        lastDocument: documentName,
        lastDocumentUpdated: new Date().toISOString(),
      })
      .eq('id', dealId);

    const autoUpdateDeal = req.body.autoUpdateDeal === 'true' || req.body.autoUpdateDeal === true;
    let dealUpdated = false;
    let updatedFields: string[] = [];

    // Everything below depends on (or follows) the LLM deal-data extraction.
    // When needsAiWork is true AND the caller has wired up a post-response
    // hook (see apps/api/src/utils/afterResponse.ts / api-adapter.ts), this
    // whole block runs AFTER the 201 response has already been sent, so the
    // slow `extractDealDataFromText` / Excel deep-pass calls never make the
    // upload request wait. Every side effect here is unchanged from before
    // this refactor — only the timing moved.
    const runPostProcessing = async () => {
      let aiExtractedData: ExtractedDealData | null = null;
      let finalStatus = extractionStatus;

      if (needsAiWork) {
        try {
          log.info('Starting AI data extraction', { documentName });
          // INGEST_ENGINE=claude: Haiku on the first ~16 pages of text
          // (~$0.01) instead of GPT-4o; GPT-4o only if that read fails.
          let aiData: ExtractedDealData | null = null;
          if ((process.env.INGEST_ENGINE || 'legacy') === 'claude') {
            const { readDealDocument } = await import('../services/extraction/claudeDealReader.js');
            aiData = await readDealDocument({
              fileName: documentName,
              fullText: extractedText as string,
              sourceLength: (extractedText as string).length,
              maxTextChars: DATA_ROOM_TEXT_CHARS,
            });
          }
          if (!aiData) aiData = await extractDealDataFromText(extractedText as string);
          if (aiData) {
            aiExtractedData = aiData;
            finalStatus = 'analyzed';
            log.info('AI extraction completed', { documentName, companyName: aiData.companyName, industry: aiData.industry });
          } else {
            finalStatus = 'completed';
            log.info('AI extraction returned no data', { documentName });
          }
        } catch (aiError) {
          // Log AI error but don't fail the upload - text extraction still worked
          log.error('AI extraction failed', aiError, { documentName });
          finalStatus = 'completed';
        }

        // Excel-only follow-up: populate FinancialStatement rows so the
        // Financial Analysis tab can show per-period revenue / EBITDA / line
        // items extracted from the spreadsheet. Failures are logged but
        // never fail the upload (text + AI fields are already saved). Only
        // fires for Excel because PDFs have a different financial
        // extraction path.
        if (file && isExcelFile(mimeType, documentName) && extractedText) {
          // Concurrency-slot guard mirrors /api/deals/:id/financials/extract
          // (financials-extraction.ts:173). Without it, parallel uploads from
          // the same org both run runDeepPass concurrently and can blow
          // Vercel's function memory on a multi-statement workbook. If the
          // slot isn't free, wait a short while for one (a multi-file upload
          // arrives as parallel requests); only then log and skip — the user
          // can Re-extract rather than the upload failing. The wait is short
          // because the upload response is waiting on it.
          const slotAcquired = await acquireExtractionSlotBy(orgId, Date.now() + UPLOAD_SLOT_WAIT_MS);
          if (!slotAcquired) {
            log.warn('Deep financial extraction skipped — org at concurrency cap', {
              documentId: document.id,
              dealId,
              orgId,
            });
          } else {
            try {
              // EXTRACTION_ENGINE=claude routes upload-time spreadsheet
              // extraction through the same flag-aware agent the Re-extract
              // button uses (extractNode → claudeEngine, container mode), with
              // the raw workbook buffer. runDeepPass remains the legacy-only
              // path.
              const useClaudeEngine = (process.env.EXTRACTION_ENGINE || 'legacy') === 'claude';
              if (useClaudeEngine) {
                log.info('Running deep financial extraction (claude engine)', { documentId: document.id, dealId });
                const { runFinancialAgent } = await import('../services/agents/financialAgent/index.js');
                const agentResult = await runFinancialAgent({
                  dealId,
                  documentId: document.id,
                  fileBuffer: file.buffer,
                  fileName: documentName,
                  fileType: 'excel',
                  organizationId: orgId,
                });
                log.info('Deep financial extraction complete (claude engine)', {
                  documentId: document.id,
                  status: agentResult.status,
                  statementsStored: agentResult.statementIds.length,
                  periodsStored: agentResult.periodsStored,
                  overallConfidence: agentResult.overallConfidence,
                });
              } else {
                log.info('Running deep financial extraction', { documentId: document.id, dealId });
                const deepResult = await runDeepPass({
                  text: extractedText,
                  dealId,
                  documentId: document.id,
                });
                if (deepResult) {
                  log.info('Deep financial extraction complete', {
                    documentId: document.id,
                    statementsStored: deepResult.statementsStored,
                    periodsStored: deepResult.periodsStored,
                    overallConfidence: deepResult.overallConfidence,
                    warnings: deepResult.warnings,
                  });
                } else {
                  log.info('Deep financial extraction: no statements detected', { documentId: document.id });
                }
              }
            } catch (deepErr) {
              log.error('Deep financial extraction failed', deepErr, { documentId: document.id });
            } finally {
              releaseExtractionSlot(orgId);
            }
          }
        }

        // Persist the AI results onto the Document row now that they exist
        // — the initial insert above only had 'processing' + null fields.
        try {
          const { error: updateErr } = await supabase
            .from('Document')
            .update({
              extractedData: aiExtractedData,
              status: finalStatus,
              confidence: aiExtractedData ? 0.85 : null,
              // Matches the original inline logic: either the LLM extraction
              // OR a client-supplied `aiAnalysis` marks the document as
              // AI-analyzed as of now.
              aiAnalyzedAt: aiExtractedData || aiAnalysis ? new Date().toISOString() : null,
            })
            .eq('id', document.id);
          if (updateErr) {
            log.error('Failed to persist AI extraction results on Document row', updateErr, { documentId: document.id });
          }
        } catch (updateThrow) {
          log.error('Threw persisting AI extraction results on Document row', updateThrow, { documentId: document.id });
        }
      }

      // Auto-update deal with extracted data if requested
      if (autoUpdateDeal && aiExtractedData) {
        try {
          const { mergeIntoExistingDeal } = await import('../services/dealMerger.js');
          const mergeResult = await mergeIntoExistingDeal(dealId, aiExtractedData, (req as any).user?.id, documentName);
          dealUpdated = true;
          updatedFields = Object.keys(mergeResult.deal || {}).filter(k =>
            ['revenue', 'ebitda', 'industry', 'description', 'aiThesis'].includes(k) && mergeResult.deal[k] != null
          );
          log.info('Deal auto-updated from document upload', { dealId, documentName, updatedFields });
        } catch (mergeError) {
          log.error('Deal auto-update failed (upload continues)', mergeError, { dealId, documentName });
        }
      }

      // Log activity
      let activityDescription = `${docType} document uploaded`;
      if (extractedText && aiExtractedData) {
        activityDescription = `${docType} document uploaded, processed (${numPages} pages), and AI-analyzed`;
      } else if (extractedText) {
        activityDescription = `${docType} document uploaded and processed (${numPages} pages extracted)`;
      }

      // Activity row is a nice-to-have for the timeline — if its schema drifts
      // or the insert fails for any other reason, we should NOT fail the
      // upload. The Document row is already persisted at this point, the
      // file is in Supabase Storage. Logging the failure preserves
      // debuggability.
      try {
        const { error: activityErr } = await supabase.from('Activity').insert({
          dealId,
          type: 'DOCUMENT_UPLOADED',
          title: `Document uploaded: ${documentName}`,
          description: activityDescription,
          metadata: {
            documentId: document.id,
            documentType: docType,
            extractionStatus: finalStatus,
            numPages,
            textLength: extractedText?.length || 0,
            aiExtracted: !!aiExtractedData,
            extractedCompany: aiExtractedData?.companyName || null,
            extractedIndustry: aiExtractedData?.industry || null,
          },
        });
        if (activityErr) {
          log.warn('Activity row insert failed (upload continues)', { dealId, documentId: document.id, err: activityErr });
        }
      } catch (activityThrow) {
        log.warn('Activity row threw (upload continues)', { dealId, documentId: document.id, err: activityThrow });
      }

      // Audit log — same logic: if the audit pipeline errors, don't fail the
      // upload. The Document row is already in the DB. Better to log a
      // partial-audit warning than fail a successful upload.
      try {
        await AuditLog.documentUploaded(req, document.id, documentName, dealId);
      } catch (auditErr) {
        log.warn('Audit log threw (upload continues)', { dealId, documentId: document.id, err: auditErr });
      }

      // Notify team: document uploaded (fire-and-forget)
      if (req.user?.id) {
        resolveUserId(req.user.id).then(internalId => {
          notifyDealTeam(
            dealId, 'DOCUMENT_UPLOADED',
            `New document uploaded: ${documentName}`,
            aiExtractedData ? `AI-analyzed (${numPages} pages)` : undefined,
            internalId || undefined
          );
        }).catch(err => log.error('Notification error (doc upload)', err));
      }

      // Invalidate AI cache since new document was uploaded
      // This ensures next thesis/risk analysis uses fresh data
      await AICache.invalidate(dealId);
      log.debug('AICache invalidated for deal due to document upload', { dealId });

      // Trigger RAG embedding (don't block anything downstream of this)
      if (extractedText && extractedText.length > 0) {
        log.info('RAG starting document embedding', { documentName });
        try {
          const result = await embedDocument(document.id, dealId, extractedText);
          if (result.success) {
            log.info('RAG embedded document successfully', { documentName, chunkCount: result.chunkCount });
          } else {
            log.error('RAG failed to embed document', result.error, { documentName });
          }
        } catch (err) {
          log.error('RAG embedding error', err, { documentName });
        }
      }

      // Onboarding: mark uploadDocument step complete
      if (req.user?.id) {
        tryCompleteOnboardingStep(req.user.id, 'uploadDocument');
      }
    };

    const afterResponseHook = (req as RequestWithAfterResponse).runAfterResponse;
    if (needsAiWork && typeof afterResponseHook === 'function') {
      // Response first: the client sees status 'processing' and no
      // dealUpdated/updatedFields yet (those land once the deferred merge
      // runs). The VDR UI already polls a folder's documents while any file
      // in it is 'processing' (see file-handlers.ts), so this is picked up
      // automatically.
      emitWebhookEvent(req, orgId, 'document.uploaded', { ...document, dealId });
      res.status(201).json({ ...document, dealUpdated: false, updatedFields: [] });
      await runAfterResponse(req, runPostProcessing);
    } else {
      // No post-response hook available (local dev via app.ts, tests,
      // non-Vercel deploys) — preserve the original fully-synchronous
      // behavior so the response reflects the final state.
      await runPostProcessing();
      emitWebhookEvent(req, orgId, 'document.uploaded', { ...document, dealId });
      res.status(201).json({ ...document, dealUpdated, updatedFields });
    }

    // Delete the staging object after the response — best-effort, never
    // blocks or fails the upload.
    if (stagingPathToClean) {
      await runAfterResponse(req, () => cleanupStagingObject(stagingPathToClean));
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    // Surface a short error detail to the client so the user can see what
    // actually broke (was previously a useless "Failed to upload document").
    // We deliberately don't leak the full stack — just the top-level
    // message + the most-likely identifying fields. Full diagnostic stays
    // in server logs.
    log.error('Error uploading document', error);
    const err = error as any;
    const detail =
      typeof err?.message === 'string'
        ? err.message
        : err?.error?.message ?? err?.code ?? 'unknown error';
    res.status(500).json({
      error: 'Failed to upload document',
      detail,
      ...(err?.code ? { code: err.code } : {}),
    });
  }
}

router.post('/deals/:dealId/documents', upload.single('file'), handleDocumentUpload);

// ─── POST /api/deals/:dealId/documents/from-drive — add a doc from Google Drive ───

/** Append `.ext` to a name that doesn't already end in it (for native exports). */
function ensureDriveExt(name: string, ext: string): string {
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

const driveDocBodySchema = z.object({
  fileId: z.string().min(10),
  // Optional VDR folder to drop the document into. Omitted → auto-assigned by
  // type inside handleDocumentUpload, exactly like a manual upload.
  folderId: z.string().uuid().optional().nullable(),
  type: z.enum(documentTypes).optional(),
});

// Adds a document to an EXISTING deal straight from the user's Google Drive.
// The browser Picker mints per-file `drive.file` access; the server-side
// "Google" token (same OAuth client + user) then reads the bytes — the same
// trust model as POST /ingest/drive and the NDA import flow. Native Google
// types (Docs/Sheets/Slides) are exported to PDF/XLSX first. The resulting
// bytes are handed to handleDocumentUpload so this path is byte-for-byte
// identical to a manual upload downstream (dedup, extraction, VDR folder
// assignment, RAG, notifications — all reused, nothing forked).
router.post('/deals/:dealId/documents/from-drive', async (req: Request, res: Response) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    // Fail fast before spending any Drive API calls on an inaccessible deal.
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const parsed = driveDocBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'A Google Drive fileId is required',
        code: 'INVALID_BODY',
        details: parsed.error.flatten(),
      });
    }
    const { fileId } = parsed.data;

    const authId = req.user?.id;
    if (!authId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const internalUserId = await resolveUserId(authId);
    if (!internalUserId) {
      return res.status(403).json({ error: 'User not provisioned', code: 'USER_NOT_PROVISIONED' });
    }

    // Google Drive piggybacks on the `google_calendar` ("Google") OAuth token.
    const accessToken = await getProviderAccessToken({
      userId: internalUserId,
      organizationId: orgId,
      providerId: 'google_calendar',
    });
    if (!accessToken) {
      return res.status(409).json({
        error: 'Google is not connected. Connect it in Settings → Integrations.',
        code: 'GOOGLE_NOT_CONNECTED',
      });
    }

    // Fetch the file bytes: export native Google types, download everything else.
    let buffer: Buffer;
    let mimeType: string;
    let documentName: string;
    let exported = false;
    try {
      const meta = await getDriveFileMetadata(accessToken, fileId);
      mimeType = meta.mimeType;
      documentName = meta.name;
      if (isGoogleNativeMime(meta.mimeType)) {
        exported = true;
        const target = driveExportTargetFor(meta.mimeType);
        if (!target) {
          return res.status(415).json({
            error: `Unsupported Google file type: ${meta.mimeType}`,
            code: 'UNSUPPORTED_DRIVE_TYPE',
          });
        }
        buffer = await exportDriveFile(accessToken, fileId, target.mimeType);
        mimeType = target.mimeType;
        // Name the exported bytes with the right extension so the downstream
        // filename-based type classifier behaves like the upload path.
        documentName = ensureDriveExt(meta.name, target.ext);
      } else {
        buffer = await downloadDriveFile(accessToken, fileId);
      }
    } catch (driveErr) {
      if (driveErr instanceof GoogleDriveError) {
        const status =
          driveErr.code === 'INVALID_TOKEN'
            ? 401
            : driveErr.code === 'INSUFFICIENT_SCOPE' || driveErr.code === 'PERMISSION_DENIED'
              ? 403
              : 502;
        log.warn('documents from-drive: Drive error', { code: driveErr.code, status: driveErr.status });
        return res.status(status).json({ error: driveErr.message, code: driveErr.code });
      }
      throw driveErr;
    }

    log.info('documents from-drive: fetched Drive file', {
      dealId,
      fileId,
      mimeType,
      bytes: buffer.length,
      exported,
    });

    // Drive filenames can legally contain characters a browser file-picker
    // never produces — ":", "?", "|", "*", leading/trailing spaces, consecutive
    // dots. The shared handler's validateFile() treats those as a "dangerous
    // filename" and 400s, so a perfectly good PDF/Doc from Drive would be
    // rejected on its NAME alone (e.g. "Q3: Teaser.pdf"). Pre-sanitize to the
    // same shape a safe upload filename has BEFORE handing it to the pipeline;
    // the real content checks (magic bytes, type allow-list, size) still run on
    // the actual bytes.
    const safeName = sanitizeFilename(documentName).replace(/\.{2,}/g, '.');

    // Synthesize a multer-style file + body so the shared upload handler runs
    // the identical pipeline. handleDocumentUpload reads req.file for the
    // bytes/size/mime/name and req.body.name to pin the resolved filename.
    (req as any).file = {
      buffer,
      originalname: safeName,
      mimetype: mimeType,
      size: buffer.length,
    };
    req.body = { ...req.body, name: safeName };

    return handleDocumentUpload(req, res);
  } catch (error) {
    log.error('Error importing document from Google Drive', error);
    const err = error as any;
    const detail =
      typeof err?.message === 'string'
        ? err.message
        : err?.error?.message ?? err?.code ?? 'unknown error';
    return res.status(500).json({ error: 'Failed to import from Google Drive', detail });
  }
});

export default router;
