import { Router } from 'express';
import { supabase } from '../supabase.js';
import { z } from 'zod';
import multer from 'multer';
import { extractDealDataFromText, ExtractedDealData } from '../services/aiExtractor.js';
import { mergeIntoExistingDeal } from '../services/dealMerger.js';
import { AuditLog } from '../services/auditLog.js';
import { validateFile, sanitizeFilename, isPotentiallyDangerous, ALLOWED_MIME_TYPES } from '../services/fileValidator.js';
import { embedDocument } from '../rag.js';
import { AICache } from '../services/aiCache.js';
import { log } from '../utils/logger.js';
import { captureAgentError } from '../utils/sentryHelpers.js';
import { notifyDealTeam, resolveUserId } from './notifications.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { tryCompleteOnboardingStep } from './onboarding.js';
import { excelToMarkdown } from '../services/excelToMarkdown.js';
import { isExcelFile } from '../services/excelFinancialExtractor.js';
import { extractTextFromPDF } from '../services/pdfExtractor.js';

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
router.post('/deals/:dealId/documents', upload.single('file'), async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const file = req.file;

    // Verify deal exists
    const { data: deal, error: dealError } = await supabase
      .from('Deal')
      .select('id, name')
      .eq('id', dealId)
      .single();

    if (dealError || !deal) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    let fileUrl = null;
    let fileSize = null;
    let mimeType = null;
    let documentName = req.body.name;

    // If file is provided, validate and upload to Supabase Storage
    if (file) {
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

    // Determine document type from filename if not provided
    let docType = req.body.type || 'OTHER';
    if (docType === 'OTHER' && documentName) {
      const lowerName = documentName.toLowerCase();
      if (lowerName.includes('cim') || lowerName.includes('confidential')) docType = 'CIM';
      else if (lowerName.includes('teaser')) docType = 'TEASER';
      else if (lowerName.includes('financial') || lowerName.includes('model')) docType = 'FINANCIALS';
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

    // Extract text from PDF if applicable
    let extractedText: string | null = null;
    let extractionStatus = 'pending';
    let numPages: number | null = null;
    let aiExtractedData: ExtractedDealData | null = null;

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

        // Run AI extraction on the extracted text
        try {
          log.info('Starting AI data extraction', { documentName });
          const aiData = await extractDealDataFromText(extractedText);
          if (aiData) {
            aiExtractedData = aiData;
            extractionStatus = 'analyzed';
            log.info('AI extraction completed', { documentName, companyName: aiData.companyName, industry: aiData.industry });
          } else {
            log.info('AI extraction returned no data', { documentName });
          }
        } catch (aiError) {
          // Log AI error but don't fail the upload - text extraction still worked
          log.error('AI extraction failed', aiError, { documentName });
        }
      } else {
        extractionStatus = 'failed';
        log.warn('PDF extraction failed', { documentName });
      }
    } else if (file && isExcelFile(mimeType, documentName)) {
      // Excel extraction — convert sheets to Markdown tables
      extractionStatus = 'processing';
      log.info('Starting Excel-to-Markdown extraction', { documentName });
      try {
        const markdownText = excelToMarkdown(file.buffer);
        if (markdownText) {
          extractedText = markdownText.replace(/\u0000/g, '');
          log.info('Excel extraction completed', { documentName, textLength: extractedText.length });
        } else {
          log.info('Excel extraction: no meaningful content', { documentName });
        }
        extractionStatus = 'completed';
      } catch (excelError) {
        log.error('Excel extraction failed', excelError, { documentName });
        extractionStatus = 'completed'; // don't block upload
      }
    } else if (file) {
      // Other non-PDF files (Word, etc.) — no extraction yet
      extractionStatus = 'completed';
    }

    // Create document record
    // Use AI extracted data if available, otherwise fall back to request body
    const extractedDataToSave = aiExtractedData
      || (req.body.extractedData ? JSON.parse(req.body.extractedData) : null);

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

    const { data: document, error: docError } = await supabase
      .from('Document')
      .insert({
        dealId,
        folderId: resolvedFolderId,
        uploadedBy: req.body.uploadedBy || null,
        name: documentName,
        type: docType,
        fileUrl,
        fileSize,
        mimeType,
        extractedData: extractedDataToSave,
        extractedText,
        status: extractionStatus,
        confidence: aiExtractedData ? 0.85 : (req.body.confidence ? parseFloat(req.body.confidence) : null),
        aiAnalysis,
        aiAnalyzedAt: aiExtractedData ? new Date().toISOString() : (aiAnalysis ? new Date().toISOString() : null),
        tags: tags.length > 0 ? tags : null,
        isHighlighted: req.body.isHighlighted === 'true' || req.body.isHighlighted === true,
      })
      .select()
      .single();

    if (docError) throw docError;

    // Update deal's lastDocument field
    await supabase
      .from('Deal')
      .update({
        lastDocument: documentName,
        lastDocumentUpdated: new Date().toISOString(),
      })
      .eq('id', dealId);

    // Auto-update deal with extracted data if requested
    const autoUpdateDeal = req.body.autoUpdateDeal === 'true' || req.body.autoUpdateDeal === true;
    let dealUpdated = false;
    let updatedFields: string[] = [];
    if (autoUpdateDeal && aiExtractedData) {
      try {
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

    await supabase.from('Activity').insert({
      dealId,
      type: 'DOCUMENT_UPLOADED',
      title: `Document uploaded: ${documentName}`,
      description: activityDescription,
      metadata: {
        documentId: document.id,
        documentType: docType,
        extractionStatus,
        numPages,
        textLength: extractedText?.length || 0,
        aiExtracted: !!aiExtractedData,
        extractedCompany: aiExtractedData?.companyName || null,
        extractedIndustry: aiExtractedData?.industry || null,
      },
    });

    // Audit log
    await AuditLog.documentUploaded(req, document.id, documentName, dealId);

    // Notify team: document uploaded (fire-and-forget)
    if (req.user?.id) {
      resolveUserId(req.user.id).then(internalId => {
        notifyDealTeam(
          dealId, 'DOCUMENT_UPLOADED',
          `New document uploaded: ${documentName}`,
          aiExtractedData ? `AI-analyzed (${numPages} pages)` : undefined,
          internalId || undefined
        );
      }).catch(err => {
        log.error('Notification error (doc upload)', err);
        captureAgentError(err, { context: 'notifyDealTeam:doc_upload' }, 'warning');
      });
    }

    // Invalidate AI cache since new document was uploaded
    // This ensures next thesis/risk analysis uses fresh data
    await AICache.invalidate(dealId);
    log.debug('AICache invalidated for deal due to document upload', { dealId });

    // Trigger RAG embedding in background (don't block response)
    if (extractedText && extractedText.length > 0) {
      log.info('RAG starting document embedding', { documentName });
      embedDocument(document.id, dealId, extractedText)
        .then(result => {
          if (result.success) {
            log.info('RAG embedded document successfully', { documentName, chunkCount: result.chunkCount });
          } else {
            log.error('RAG failed to embed document', result.error, { documentName });
          }
        })
        .catch(err => {
          log.error('RAG embedding error', err, { documentName });
        });
    }

    // Onboarding: mark uploadDocument step complete (fire-and-forget)
    if (req.user?.id) {
      tryCompleteOnboardingStep(req.user.id, 'uploadDocument');
    }

    res.status(201).json({ ...document, dealUpdated, updatedFields });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log.error('Error uploading document', error);
    res.status(500).json({ error: 'Failed to upload document' });
  }
});

export default router;
