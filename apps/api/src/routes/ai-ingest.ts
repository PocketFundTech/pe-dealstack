import { Router } from 'express';
import { supabase } from '../supabase.js';
import { isAIEnabled } from '../openai.js';
import multer from 'multer';
import { extractDealDataFromText, ExtractedDealData } from '../services/aiExtractor.js';
import { validateFile, sanitizeFilename, isPotentiallyDangerous, ALLOWED_MIME_TYPES } from '../services/fileValidator.js';
import { AuditLog } from '../services/auditLog.js';
import { log } from '../utils/logger.js';
import { captureAgentError } from '../utils/sentryHelpers.js';
import { createNotification, resolveUserId } from './notifications.js';
import { getOrgId } from '../middleware/orgScope.js';
import { extractTextFromPDF } from './ingest-shared.js';
import { findExistingDocument, logDuplicateSkip } from '../services/documentDedup.js';
import { generateTeasersForDeal } from '../services/firmTeaserService.js';

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  },
});

const subRouter = Router();

// POST /api/ai/ingest - Ingest a document and create a deal from AI-extracted data
subRouter.post('/ai/ingest', upload.single('file'), async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // Validate file
    const validation = validateFile(file.buffer, file.originalname, file.mimetype);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'File validation failed', details: validation.error });
    }

    if (isPotentiallyDangerous(file.buffer, file.originalname)) {
      return res.status(400).json({ error: 'File appears to contain unsafe content' });
    }

    // Check AI availability
    if (!isAIEnabled()) {
      return res.status(503).json({
        error: 'AI service unavailable',
        message: 'OpenAI API key not configured. Cannot process document.',
      });
    }

    const safeName = validation.sanitizedFilename || sanitizeFilename(file.originalname);
    log.info('AI Ingest processing file', { filename: safeName, mimeType: file.mimetype });

    // Extract text from PDF (LlamaParse → pdf-parse fallback)
    let extractedText = '';
    let numPages = 0;

    if (file.mimetype === 'application/pdf') {
      log.info('AI Ingest: extracting PDF (LlamaParse → pdf-parse)', { filename: safeName });
      const extraction = await extractTextFromPDF(file.buffer, safeName);
      if (!extraction) {
        log.error('AI Ingest: PDF extraction failed in both layers', undefined, { filename: safeName });
        return res.status(422).json({
          error:
            "Couldn't extract data from this document. The PDF may be encrypted, password-protected, or malformed.",
        });
      }
      extractedText = extraction.text;
      numPages = extraction.numPages;
      log.info('AI Ingest: PDF text extracted', {
        layer: extraction.source,
        textLength: extractedText.length,
        numPages,
        sparse: extraction.sparse,
      });
    } else {
      // For non-PDF files, attempt text extraction or return error
      return res.status(400).json({
        error: 'Only PDF files are supported for AI ingestion at this time',
      });
    }

    if (extractedText.length < 100) {
      log.warn('AI Ingest: extracted text too short for AI', {
        filename: safeName,
        textLength: extractedText.length,
      });
      return res.status(422).json({
        error:
          "Couldn't extract data from this document. The PDF appears to be image-only or scanned — please upload a text-based PDF.",
      });
    }

    // Extract deal data using AI
    log.info('Starting AI extraction');
    const extractedData = await extractDealDataFromText(extractedText);

    if (!extractedData) {
      log.error('AI Ingest: AI extraction returned null', undefined, {
        filename: safeName,
        textLength: extractedText.length,
      });
      return res.status(422).json({
        error:
          "Couldn't extract data from this document. The AI couldn't identify any deal information.",
      });
    }

    // Create or find company (use .value for new format with confidence scores)
    let companyId: string | null = null;
    const companyName = extractedData.companyName.value;
    const industryValue = extractedData.industry.value;
    const descriptionValue = extractedData.description.value;
    // Per-field confidence floor — same gate as the other ingest routes.
    // Low-confidence financial values are NOT auto-populated on the Deal.
    const FIELD_FLOOR = 60;
    const revenueValue = extractedData.revenue.value != null && extractedData.revenue.confidence >= FIELD_FLOOR
      ? extractedData.revenue.value : null;
    const ebitdaValue = extractedData.ebitda.value != null && extractedData.ebitda.confidence >= FIELD_FLOOR
      ? extractedData.ebitda.value : null;

    if (companyName) {
      // Check if company already exists in this org
      const { data: existingCompany } = await supabase
        .from('Company')
        .select('id')
        .ilike('name', companyName)
        .eq('organizationId', orgId)
        .single();

      if (existingCompany) {
        companyId = existingCompany.id;
      } else {
        // Create new company
        const { data: newCompany, error: companyError } = await supabase
          .from('Company')
          .insert({
            name: companyName,
            industry: industryValue,
            description: descriptionValue,
            organizationId: orgId,
          })
          .select()
          .single();

        if (companyError) {
          log.error('Error creating company', companyError);
        } else {
          companyId = newCompany.id;
        }
      }
    }

    // Create the deal
    const dealName = companyName
      ? `Project ${companyName.charAt(0).toUpperCase()}${Math.random().toString(36).substring(2, 5)}`
      : `New Opportunity - ${new Date().toLocaleDateString()}`;

    // Determine status based on confidence
    const dealStatus = extractedData.needsReview ? 'PENDING_REVIEW' : 'ACTIVE';

    const { data: deal, error: dealError } = await supabase
      .from('Deal')
      .insert({
        name: dealName,
        companyId,
        organizationId: orgId,
        stage: 'INITIAL_REVIEW',
        status: dealStatus,
        industry: industryValue,
        revenue: revenueValue,
        ebitda: ebitdaValue,
        currency: extractedData.currency || 'USD',
        description: descriptionValue,
        aiThesis: extractedData.summary,
        icon: 'business_center',
        priority: 'MEDIUM',
        source: `AI Ingest: ${safeName}`,
        extractionConfidence: extractedData.overallConfidence,
        needsReview: extractedData.needsReview,
        reviewReasons: extractedData.reviewReasons,
      })
      .select()
      .single();

    if (dealError) {
      log.error('Error creating deal', dealError);
      return res.status(500).json({ error: 'Failed to create deal from extracted data' });
    }

    // Upload document to storage and create document record
    const timestamp = Date.now();
    const filePath = `${deal.id}/${timestamp}_${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from('documents')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    let fileUrl = null;
    if (!uploadError) {
      // Store the storage path (not full URL) — signed URLs generated on demand
      fileUrl = filePath;
    }

    // Auto-create default VDR folders for the new deal
    const defaultFolders = [
      { name: '100 Financials', sortOrder: 100, description: 'Financial statements, projections, and analysis' },
      { name: '200 Legal', sortOrder: 200, description: 'Legal documents, contracts, and agreements' },
      { name: '300 Commercial', sortOrder: 300, description: 'Commercial due diligence materials' },
      { name: '400 HR & Data', sortOrder: 400, description: 'HR documents and data room materials' },
      { name: '500 Intellectual Property', sortOrder: 500, description: 'IP documentation and patents' },
    ];
    const { data: createdFolders } = await supabase
      .from('Folder')
      .insert(defaultFolders.map(f => ({ ...f, dealId: deal.id, parentId: null, isRestricted: false })))
      .select('id, name');

    // Assign to Financials folder (CIM docs go there)
    const financialsFolder = createdFolders?.find((f: any) => /financ/i.test(f.name));
    const folderId = financialsFolder?.id || createdFolders?.[0]?.id || null;

    // Dedup: this route always creates a new deal, so a true duplicate is
    // unlikely (a re-submit produces a fresh deal). But guard anyway in case
    // the caller wires it to an existing-deal flow later.
    const existingAiDuplicate = await findExistingDocument(deal.id, safeName, file.size, { requireFileUrl: true });
    let document: any;
    if (existingAiDuplicate) {
      logDuplicateSkip(existingAiDuplicate, {
        dealId: deal.id,
        name: safeName,
        fileSize: file.size,
        newFileUrl: fileUrl,
      });
      document = existingAiDuplicate;
    } else {
      const { data: insertedDoc } = await supabase
        .from('Document')
        .insert({
          dealId: deal.id,
          folderId,
          name: safeName,
          type: 'CIM',
          fileUrl,
          fileSize: file.size,
          mimeType: file.mimetype,
          extractedText,
          extractedData,
          status: extractedData.needsReview ? 'pending_review' : 'analyzed',
          confidence: extractedData.overallConfidence / 100,
          aiAnalyzedAt: new Date().toISOString(),
        })
        .select()
        .single();
      document = insertedDoc;
    }

    // Log activity
    await supabase.from('Activity').insert({
      dealId: deal.id,
      type: 'DOCUMENT_UPLOADED',
      title: 'Deal Created via AI Ingestion',
      description: extractedData.needsReview
        ? `AI analyzed "${safeName}" with ${extractedData.overallConfidence}% confidence - NEEDS REVIEW`
        : `AI analyzed "${safeName}" and created deal "${dealName}" with ${extractedData.overallConfidence}% confidence`,
      metadata: {
        documentId: document?.id,
        companyName: companyName,
        companyConfidence: extractedData.companyName.confidence,
        industry: industryValue,
        industryConfidence: extractedData.industry.confidence,
        overallConfidence: extractedData.overallConfidence,
        needsReview: extractedData.needsReview,
        numPages,
        textLength: extractedText.length,
      },
    });

    // Auto-assign uploader as analyst
    if (req.user?.id) {
      const internalUserId = await resolveUserId(req.user.id);
      if (internalUserId) {
        await supabase.from('DealTeamMember').insert({
          dealId: deal.id,
          userId: internalUserId,
          role: 'MEMBER',
        }).then(({ error }) => { if (error) log.warn('Auto-assign analyst failed', error); });
      }
    }

    // Audit log
    await AuditLog.aiIngest(req, safeName, deal.id);

    // Notify: deal created via AI ingest (fire-and-forget)
    if (req.user?.id) {
      resolveUserId(req.user.id).then(internalId => {
        if (internalId) {
          createNotification({
            userId: internalId,
            type: 'AI_INSIGHT',
            title: `Deal created via AI: ${deal.name}`,
            message: `${extractedData.overallConfidence}% confidence from "${safeName}"`,
            dealId: deal.id,
          });
        }
      }).catch(err => {
        log.error('Notification error (ingest)', err);
        captureAgentError(err, { context: 'notification:ai_ingest' }, 'warning');
      });
    }

    // Auto-generate firm-teaser blurbs for the new deal (blocking, best-effort
    // — never fail ingest on teaser error).
    try {
      await generateTeasersForDeal({ dealId: deal.id, orgId });
    } catch (teaserErr) {
      log.error('AI Ingest: firm-teaser auto-gen failed', teaserErr, { dealId: deal.id });
    }

    log.info('AI Ingest complete', { dealId: deal.id, filename: safeName, confidence: extractedData.overallConfidence });

    res.status(201).json({
      success: true,
      deal: {
        id: deal.id,
        name: deal.name,
        stage: deal.stage,
        industry: deal.industry,
      },
      company: companyName ? {
        id: companyId,
        name: companyName,
      } : null,
      document: document ? {
        id: document.id,
        name: document.name,
      } : null,
      extraction: {
        companyName: extractedData.companyName,
        industry: extractedData.industry,
        currency: extractedData.currency || 'USD',
        revenue: extractedData.revenue,
        ebitda: extractedData.ebitda,
        summary: extractedData.summary,
        keyRisks: extractedData.keyRisks,
        investmentHighlights: extractedData.investmentHighlights,
        overallConfidence: extractedData.overallConfidence,
        needsReview: extractedData.needsReview,
        reviewReasons: extractedData.reviewReasons,
      },
    });
  } catch (error) {
    log.error('AI Ingest error', error);
    res.status(500).json({ error: 'Failed to process AI ingestion' });
  }
});

// POST /api/ai/extract - Extract data from document without creating a deal (preview)
subRouter.post('/ai/extract', upload.single('file'), async (req, res) => {
  try {
    // Verify org context for audit trail (no data saved, but ensures authenticated org user)
    getOrgId(req);

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // Validate file
    const validation = validateFile(file.buffer, file.originalname, file.mimetype);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'File validation failed', details: validation.error });
    }

    if (!isAIEnabled()) {
      return res.status(503).json({
        error: 'AI service unavailable',
        message: 'OpenAI API key not configured',
      });
    }

    // Extract text from PDF only
    if (file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDF files are supported' });
    }

    const safeName = validation.sanitizedFilename || file.originalname;
    log.info('AI Extract: extracting PDF (LlamaParse → pdf-parse)', { filename: safeName });
    const extraction = await extractTextFromPDF(file.buffer, safeName);
    if (!extraction) {
      log.error('AI Extract: PDF extraction failed in both layers', undefined, { filename: safeName });
      return res.status(422).json({
        error:
          "Couldn't extract data from this document. The PDF may be encrypted, password-protected, or malformed.",
      });
    }
    const extractedText = extraction.text;
    log.info('AI Extract: PDF text extracted', {
      layer: extraction.source,
      textLength: extractedText.length,
      numPages: extraction.numPages,
      sparse: extraction.sparse,
    });

    if (extractedText.length < 100) {
      return res.status(422).json({
        error:
          "Couldn't extract data from this document. The PDF appears to be image-only or scanned.",
      });
    }

    // Extract deal data
    const extractedData = await extractDealDataFromText(extractedText);

    if (!extractedData) {
      return res.status(422).json({
        error: "AI couldn't identify any deal information in this document.",
      });
    }

    res.json({
      success: true,
      filename: safeName,
      numPages: extraction.numPages,
      textLength: extractedText.length,
      extracted: extractedData,
    });
  } catch (error) {
    log.error('AI Extract error', error);
    res.status(500).json({ error: 'Failed to extract data' });
  }
});

export default subRouter;
