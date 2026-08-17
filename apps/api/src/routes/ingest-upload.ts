import { Router, type Request } from 'express';
import { supabase } from '../supabase.js';
import { extractDealDataFromText, ExtractedDealData } from '../services/aiExtractor.js';
import { embedDocument } from '../rag.js';
import { log } from '../utils/logger.js';
import { captureAgentError } from '../utils/sentryHelpers.js';
import { extractTextFromWord } from '../services/documentParser.js';
import { extractTextFromExcel, isExcelFile } from '../services/excelFinancialExtractor.js';
import { deepExtract, isDeepExtractionAvailable, DeepExtractionResult } from '../services/langExtractClient.js';
import { AuditLog } from '../services/auditLog.js';
import { validateFinancials } from '../services/financialValidator.js';
import { mergeIntoExistingDeal, getIconForIndustry } from '../services/dealMerger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { extractTextFromPDF, upload } from './ingest-shared.js';
import { resolveUserId } from './notifications.js';
import { findExistingDocument, logDuplicateSkip } from '../services/documentDedup.js';
import { generateTeasersForDeal } from '../services/firmTeaserService.js';
import { runInBackground } from '../utils/background.js';
import { runIngestDeepPass, shouldRunIngestDeepPass } from '../services/ingestDeepPass.js';

const router = Router();

// INGEST_ENGINE=claude: deal-level overview extraction reads the document
// natively (claudeDealReader — whole PDF via the Files API, or full text up
// to 200k chars) instead of the legacy truncated-text chain. Read per call
// (never cached at module load) so a Vercel env flip applies on the next
// invocation — same idiom as extractNode's EXTRACTION_ENGINE.
function isClaudeIngestEnabled(): boolean {
  return (process.env.INGEST_ENGINE || 'legacy') === 'claude';
}

// Transform deep extraction result into ExtractedDealData format
function transformDeepResultToExtractedDealData(result: DeepExtractionResult): ExtractedDealData {
  const d = result.dealData;
  const highConf = 85; // Deep extraction yields high confidence
  return {
    companyName: { value: d.companyName, confidence: d.companyName ? highConf : 0 },
    industry: { value: d.industry, confidence: d.industry ? highConf : 0 },
    description: { value: [d.companyName, d.industry].filter(Boolean).join(' — ') || 'Extracted via deep analysis', confidence: highConf },
    currency: (d as any).currency || 'USD',
    revenue: { value: d.revenue, confidence: d.revenue != null ? highConf : 0 },
    ebitda: { value: d.ebitda, confidence: d.ebitda != null ? highConf : 0 },
    ebitdaMargin: { value: d.ebitdaMargin, confidence: d.ebitdaMargin != null ? highConf : 0 },
    dealSize: { value: (d as any).dealSize || null, confidence: (d as any).dealSize != null ? highConf : 0 },
    revenueGrowth: { value: d.revenueGrowth, confidence: d.revenueGrowth != null ? highConf : 0 },
    employees: { value: d.employees, confidence: d.employees != null ? highConf : 0 },
    foundedYear: { value: null, confidence: 0 },
    headquarters: { value: d.headquarters, confidence: d.headquarters ? highConf : 0 },
    keyRisks: d.keyRisks || [],
    investmentHighlights: d.investmentHighlights || [],
    summary: `Deep extraction found ${result.extractionCount} data points`,
    overallConfidence: highConf,
    needsReview: !d.companyName,
    reviewReasons: !d.companyName ? ['Company name not found in deep extraction'] : [],
  };
}

// POST /api/ingest - Upload document and auto-create deal
router.post('/', upload.single('file'), async (req, res) => {
  const uploaded = req.file;
  if (!uploaded) {
    return res.status(400).json({ error: 'No file provided' });
  }
  const result = await runIngestFromBuffer({
    buffer: uploaded.buffer,
    mimeType: uploaded.mimetype,
    documentName: uploaded.originalname,
    fileSize: uploaded.size,
    req,
  });
  res.status(result.status).json(result.body);
});

/**
 * Shared ingest pipeline: extract text → AI deal extraction → create/merge
 * deal → store file → create Document → embed. Used by both the multipart
 * upload route above and the Google Drive ingest route (ingest-drive.ts),
 * which downloads the user-picked Drive file into a Buffer and calls this
 * directly. Returns `{ status, body }` instead of writing the response so
 * every entry point shares identical error handling.
 *
 * Reads optional deal-context fields (source, userThesis, priority,
 * targetTimeline, concerns) and the target `dealId` off `req.body`.
 */
export interface IngestBufferInput {
  buffer: Buffer;
  mimeType: string;
  documentName: string;
  fileSize: number;
  req: Request;
}

export async function runIngestFromBuffer(
  input: IngestBufferInput,
): Promise<{ status: number; body: unknown }> {
  const { buffer, mimeType, documentName, fileSize, req } = input;
  try {
    const orgId = getOrgId(req);

    log.info('Ingest starting', { documentName });

    // Step 1: Extract text from document
    let extractedText: string | null = null;
    let numPages: number | null = null;

    if (mimeType === 'application/pdf') {
      log.info('Step 1: Extracting text from PDF (LlamaParse → pdf-parse)', { documentName });
      const extraction = await extractTextFromPDF(buffer, documentName);
      if (!extraction) {
        // Both layers hard-failed (encrypted / malformed). Don't 500 — give the user a hint.
        log.error('PDF extraction failed in both layers', undefined, { documentName });
        return {
          status: 422,
          body: {
            error:
              "Couldn't extract data from this document. The PDF may be encrypted, password-protected, or malformed — try uploading a different copy.",
          },
        };
      }
      extractedText = extraction.text.replace(/\u0000/g, '');
      numPages = extraction.numPages;
      log.info('PDF extracted', {
        layer: extraction.source,
        numPages,
        charCount: extractedText.length,
        sparse: extraction.sparse,
      });
      // Image-only one-pagers (scanned PDFs) yield ~0 chars from pdf-parse.
      // Surface a useful 422 instead of letting the AI extractor return null.
      if (extraction.sparse && extractedText.trim().length < 100) {
        if (!isClaudeIngestEnabled()) {
          log.warn('PDF text too sparse for AI extraction', {
            documentName,
            chars: extractedText.trim().length,
            layer: extraction.source,
          });
          return {
            status: 422,
            body: {
              error:
                "Couldn't extract data from this document. The PDF appears to be image-only or scanned — please upload a text-based PDF, or contact support to enable OCR for this file type.",
            },
          };
        }
        // INGEST_ENGINE=claude: scanned/image-only PDFs proceed — the native
        // reader sees the complete file regardless of text layer. Only the
        // downstream "AI couldn't identify deal information" 422 fires if the
        // native read ALSO fails.
        log.info('Sparse/scanned PDF — deferring to native Claude read', {
          documentName,
          chars: extractedText.trim().length,
        });
      }
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mimeType === 'application/msword'
    ) {
      log.debug('Step 1: Extracting text from Word document');
      extractedText = await extractTextFromWord(buffer);
      if (!extractedText) {
        return { status: 400, body: { error: 'Failed to extract text from Word document' } };
      }
      log.debug('Word extracted', { charCount: extractedText.length });
    } else if (mimeType === 'text/plain') {
      log.debug('Step 1: Reading plain text file');
      extractedText = buffer.toString('utf-8');
      if (!extractedText || extractedText.trim().length < 50) {
        return { status: 400, body: { error: 'Text file is too short or empty' } };
      }
    } else if (isExcelFile(mimeType, documentName)) {
      log.debug('Step 1: Extracting text from Excel');
      extractedText = extractTextFromExcel(buffer);
      if (!extractedText || extractedText.trim().length < 50) {
        return { status: 400, body: { error: 'Excel file appears empty or has no readable data' } };
      }
      log.debug('Excel extracted', { charCount: extractedText.length });
    } else {
      return {
        status: 400,
        body: {
          error: 'Unsupported file type for auto-deal creation',
          supported: ['PDF (.pdf)', 'Word (.docx, .doc)', 'Excel (.xlsx, .xls)', 'Text (.txt)'],
        },
      };
    }

    // Step 2: Run AI extraction with confidence scores
    let aiData: ExtractedDealData | null = null;

    // INGEST_ENGINE=claude — native full-document read (whole PDF via the
    // Files API; full text for other formats). Returns the exact
    // ExtractedDealData shape, so everything downstream is unchanged. Any
    // failure falls through to the legacy chain below — deal creation is
    // never blocked by the new engine.
    if (isClaudeIngestEnabled()) {
      const { readDealDocument } = await import('../services/extraction/claudeDealReader.js');
      aiData = await readDealDocument({
        fileBuffer: mimeType === 'application/pdf' ? buffer : undefined,
        fileName: documentName,
        fullText: mimeType === 'application/pdf' ? undefined : extractedText,
        sourceLength: extractedText.length,
      });
      if (!aiData) {
        log.warn('INGEST_ENGINE=claude deal read failed — falling back to legacy extractor', { documentName });
      }
    }

    // Legacy chain (also the fallback when the claude read returns null).
    // Smart routing: use deep extraction for long documents (>50k chars) if available
    const shouldUseDeepExtraction =
      !aiData && extractedText.length > 50000 && isDeepExtractionAvailable();

    if (aiData) {
      // native read succeeded — skip the legacy chain entirely
    } else if (shouldUseDeepExtraction) {
      log.info('Using deep extraction for long document', { textLength: extractedText.length });
      const deepResult = await deepExtract(extractedText);

      if (deepResult?.success) {
        aiData = transformDeepResultToExtractedDealData(deepResult);
        log.info('Deep extraction succeeded', { extractionCount: deepResult.extractionCount });
      } else {
        log.warn('Deep extraction failed, falling back to standard extraction');
        aiData = await extractDealDataFromText(extractedText);
      }
    } else {
      log.debug('Step 2: Running AI data extraction');
      aiData = await extractDealDataFromText(extractedText);
    }

    if (!aiData) {
      log.error('AI extraction returned null', undefined, {
        documentName,
        textLength: extractedText.length,
      });
      return {
        status: 422,
        body: {
          error:
            "Couldn't extract data from this document. The AI couldn't identify any deal information in the text — please verify it's a CIM, teaser, or financial document.",
        },
      };
    }

    log.debug('AI extraction completed', {
      companyName: aiData.companyName.value,
      companyConfidence: aiData.companyName.confidence,
      industry: aiData.industry.value,
      overallConfidence: aiData.overallConfidence,
      needsReview: aiData.needsReview,
    });

    // Financial validation — sourceLength enables short-doc bounds
    const financialCheck = validateFinancials({
      revenue: aiData.revenue.value,
      ebitda: aiData.ebitda.value,
      ebitdaMargin: aiData.ebitdaMargin?.value,
      revenueGrowth: aiData.revenueGrowth?.value,
      employees: aiData.employees?.value,
      dealSize: aiData.dealSize?.value,
      sourceLength: extractedText.length,
    });
    if (!financialCheck.isValid) {
      aiData.needsReview = true;
      aiData.reviewReasons = [...(aiData.reviewReasons || []), ...financialCheck.warnings];
    }

    // Check if updating an existing deal or creating a new one
    const targetDealId = req.body.dealId;
    let deal: any;
    let company: any;
    let isUpdate = false;

    if (targetDealId) {
      // ─── Update Existing Deal path ───
      // Verify the caller's org owns this deal before merging extracted data
      // into it (and dropping a Document row pointing at it). Without this,
      // a client could ingest a CIM into any tenant's deal.
      const dealAccess = await verifyDealAccess(targetDealId, orgId);
      if (!dealAccess) {
        return { status: 404, body: { error: 'Deal not found' } };
      }

      log.info('Ingest into existing deal', { dealId: targetDealId });
      const result = await mergeIntoExistingDeal(targetDealId, aiData, req.user?.id, documentName);
      deal = result.deal;
      company = deal.company;
      isUpdate = true;
    } else {
      // ─── Create New Deal path (original flow) ───
      log.debug('Step 3: Creating/finding company');
      const companyName = aiData.companyName.value || `Company from ${documentName}`;

      const { data: existingCompany } = await supabase
        .from('Company')
        .select('id, name')
        .ilike('name', companyName)
        .eq('organizationId', orgId)
        .single();

      if (existingCompany) {
        company = existingCompany;
        log.debug('Found existing company', { name: company.name, id: company.id });
      } else {
        const { data: newCompany, error: companyError } = await supabase
          .from('Company')
          .insert({
            name: companyName,
            industry: aiData.industry.value,
            description: aiData.description.value,
            organizationId: orgId,
          })
          .select()
          .single();

        if (companyError) {
          log.error('Company creation error', companyError);
          throw companyError;
        }
        company = newCompany;
        log.debug('Created new company', { name: company.name, id: company.id });
      }

      log.debug('Step 4: Creating deal');
      const dealIcon = getIconForIndustry(aiData.industry.value);
      const dealStatus = aiData.needsReview ? 'PENDING_REVIEW' : 'ACTIVE';

      // Per-field confidence floor — values below this don't auto-populate
      // the Deal table. Same gate as merge path (see dealMerger.ts).
      const FIELD_FLOOR = 60;
      const safeRevenue = aiData.revenue.value != null && aiData.revenue.confidence >= FIELD_FLOOR
        ? aiData.revenue.value : null;
      const safeEbitda = aiData.ebitda.value != null && aiData.ebitda.confidence >= FIELD_FLOOR
        ? aiData.ebitda.value : null;
      const safeDealSize = aiData.dealSize?.value != null && aiData.dealSize.confidence >= FIELD_FLOOR
        ? aiData.dealSize.value : null;

      // User-provided deal context (optional fields from ingest form)
      const userSource = req.body?.source || null;
      const userThesis = req.body?.userThesis || null;
      const userPriority = req.body?.priority || 'MEDIUM';
      const rawTimeline = req.body?.targetTimeline || null;
      const userConcerns = req.body?.concerns || null;

      // Convert timeline string ("30 days", "6 months") to ISO date
      let userTimeline: string | null = null;
      if (rawTimeline) {
        const now = new Date();
        const match = rawTimeline.match(/^(\d+)\s*(day|month|year)s?$/i);
        if (match) {
          const amount = parseInt(match[1], 10);
          const unit = match[2].toLowerCase();
          if (unit === 'day') now.setDate(now.getDate() + amount);
          else if (unit === 'month') now.setMonth(now.getMonth() + amount);
          else if (unit === 'year') now.setFullYear(now.getFullYear() + amount);
          userTimeline = now.toISOString().split('T')[0];
        }
      }

      const { data: newDeal, error: dealError } = await supabase
        .from('Deal')
        .insert({
          name: companyName,
          companyId: company.id,
          organizationId: orgId,
          stage: 'INITIAL_REVIEW',
          status: dealStatus,
          priority: userPriority,
          industry: aiData.industry.value,
          description: aiData.description.value,
          revenue: safeRevenue,
          ebitda: safeEbitda,
          currency: aiData.currency || 'USD',
          dealSize: safeDealSize,
          aiThesis: userThesis || aiData.summary,
          icon: dealIcon,
          ...(userSource ? { source: userSource } : {}),
          lastDocument: documentName,
          lastDocumentUpdated: new Date().toISOString(),
          extractionConfidence: aiData.overallConfidence,
          needsReview: aiData.needsReview,
          reviewReasons: aiData.reviewReasons,
          aiRisks: { keyRisks: aiData.keyRisks || [], investmentHighlights: aiData.investmentHighlights || [] },
          ...(userTimeline ? { targetCloseDate: userTimeline } : {}),
          ...(userConcerns ? { customFields: { concerns: userConcerns } } : {}),
        })
        .select()
        .single();

      if (dealError) {
        log.error('Deal creation error', dealError);
        throw dealError;
      }
      deal = newDeal;
      log.info('Deal created', { name: deal.name, id: deal.id, status: dealStatus });
    }

    // Step 5: Upload file to storage
    log.debug('Step 5: Uploading file to storage');
    let fileUrl = null;

    const timestamp = Date.now();
    const sanitizedName = documentName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filePath = `${deal.id}/${timestamp}_${sanitizedName}`;

    const { error: uploadError } = await supabase.storage
      .from('documents')
      .upload(filePath, buffer, {
        contentType: mimeType,
        upsert: false,
      });

    if (uploadError) {
      log.warn('Storage upload warning', { error: uploadError.message });
    } else {
      // Store the storage path (not full URL) — signed URLs generated on demand
      fileUrl = filePath;
      log.debug('File uploaded to storage', { storagePath: filePath });
    }

    // Step 6: Create document record with confidence data
    log.debug('Step 6: Creating document record');

    // Auto-classify by filename + mimeType. Spreadsheets default to
    // FINANCIALS so the re-extract loop in financials-extraction.ts
    // (which filters `type IN ('CIM','FINANCIALS')`) picks them up.
    let docType = 'OTHER';
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
    else if (lowerName.includes('loi') || lowerName.includes('letter')) docType = 'LOI';
    else if (lowerName.includes('due diligence') || lowerName.includes('dd')) docType = 'DD_REPORT';

    // Auto-assign to a VDR folder based on document type
    let ingestFolderId: string | null = null;
    const folderPatterns: Record<string, RegExp> = {
      CIM: /financ|cim/i,
      FINANCIALS: /financ/i,
      LEGAL: /legal/i,
      LOI: /legal|commercial/i,
      DD_REPORT: /due\s*diligence|dd/i,
    };
    const folderPattern = folderPatterns[docType];
    if (folderPattern) {
      const { data: folders } = await supabase
        .from('Folder')
        .select('id, name')
        .eq('dealId', deal.id)
        .order('name', { ascending: true });
      if (folders && folders.length > 0) {
        const match = folders.find((f: any) => folderPattern.test(f.name));
        ingestFolderId = match?.id || folders[0]?.id || null;
      }
    } else {
      const { data: folders } = await supabase
        .from('Folder')
        .select('id')
        .eq('dealId', deal.id)
        .order('name', { ascending: true })
        .limit(1);
      ingestFolderId = folders?.[0]?.id || null;
    }

    // Dedup: if a Document with the same (dealId, name, fileSize) already
    // exists, reuse it instead of creating a duplicate row. Mostly relevant in
    // the existing-deal (merge) path where users sometimes re-upload the same
    // file by accident — we don't want a second ingest/extraction pass.
    const existingDuplicate = await findExistingDocument(deal.id, documentName, fileSize, { requireFileUrl: true });
    let document: any;
    if (existingDuplicate) {
      logDuplicateSkip(existingDuplicate, {
        dealId: deal.id,
        name: documentName,
        fileSize,
        newFileUrl: fileUrl,
      });
      document = existingDuplicate;
    } else {
      const { data: insertedDoc, error: docError } = await supabase
        .from('Document')
        .insert({
          dealId: deal.id,
          folderId: ingestFolderId,
          name: documentName,
          type: docType,
          fileUrl,
          fileSize,
          mimeType,
          extractedData: {
            companyName: aiData.companyName,
            industry: aiData.industry,
            description: aiData.description,
            revenue: aiData.revenue,
            ebitda: aiData.ebitda,
            ebitdaMargin: aiData.ebitdaMargin,
            dealSize: aiData.dealSize,
            revenueGrowth: aiData.revenueGrowth,
            employees: aiData.employees,
            foundedYear: aiData.foundedYear,
            headquarters: aiData.headquarters,
            keyRisks: aiData.keyRisks,
            investmentHighlights: aiData.investmentHighlights,
            summary: aiData.summary,
            overallConfidence: aiData.overallConfidence,
            needsReview: aiData.needsReview,
            reviewReasons: aiData.reviewReasons,
          },
          extractedText,
          status: aiData.needsReview ? 'pending_review' : 'analyzed',
          confidence: aiData.overallConfidence / 100,
          aiAnalyzedAt: new Date().toISOString(),
        })
        .select()
        .single();

      if (docError) {
        log.error('Document creation error', docError);
        throw docError;
      }
      document = insertedDoc;
      log.debug('Created document', { name: document.name, id: document.id });
    }

    // Step 7: Trigger RAG embedding in background
    if (extractedText && extractedText.length > 0) {
      log.debug('Step 7: Triggering RAG embedding');
      embedDocument(document.id, deal.id, extractedText)
        .then(result => {
          if (result.success) {
            log.debug('RAG embedding complete', { chunkCount: result.chunkCount });
          } else {
            log.error('RAG embedding failed', result.error);
          }
        })
        .catch(err => {
          log.error('RAG embedding error', err);
        });
    }

    // Step 8: Log activity (only for new deals — merge already logs)
    if (!isUpdate) {
      await supabase.from('Activity').insert({
        dealId: deal.id,
        type: 'DEAL_CREATED',
        title: `Deal created from ${docType}`,
        description: aiData.needsReview
          ? `New deal "${deal.name}" created with ${aiData.overallConfidence}% confidence - NEEDS REVIEW`
          : `New deal "${deal.name}" auto-created with ${aiData.overallConfidence}% confidence`,
        metadata: {
          documentId: document.id,
          documentType: docType,
          overallConfidence: aiData.overallConfidence,
          needsReview: aiData.needsReview,
          reviewReasons: aiData.reviewReasons,
        },
      });

      // Auto-assign creator as analyst (only for new deals)
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
    }

    // Audit log
    await AuditLog.aiIngest(req, documentName, deal.id);

    // Auto-trigger multi-doc analysis if 2+ documents exist
    const { count: docCount } = await supabase
      .from('Document')
      .select('id', { count: 'exact', head: true })
      .eq('dealId', deal.id);

    if (docCount && docCount >= 2) {
      import('../services/multiDocAnalyzer.js')
        .then(({ analyzeMultipleDocuments }) =>
          analyzeMultipleDocuments(deal.id)
        )
        .then(result => {
          if (result) log.info('Auto multi-doc analysis complete', { dealId: deal.id, conflicts: result.conflicts.length });
        })
        .catch(err => {
          log.error('Auto multi-doc analysis failed', err);
          captureAgentError(err, { context: 'multi_doc_analysis:background' });
        });
    }

    // Auto-generate firm-teaser blurbs for newly-created deals. BLOCKS the
    // response so the teasers are ready when the client renders the deal.
    // Best-effort: a teaser failure must never fail ingest.
    if (!isUpdate) {
      try {
        await generateTeasersForDeal({ dealId: deal.id, orgId });
      } catch (teaserErr) {
        log.error('Ingest: firm-teaser auto-gen failed', teaserErr, { dealId: deal.id });
      }
    }

    // Background deep pass: financial-statement extraction + auto-score, so
    // the deal page fills in (financials, red flags, scorecard) without a
    // manual Re-extract. Survives the serverless response freeze via
    // waitUntil (utils/background.ts). Skipped for duplicate re-uploads
    // (already extracted) and file types that carry no statements.
    let backgroundExtraction: 'started' | 'skipped' = 'skipped';
    if (!existingDuplicate && shouldRunIngestDeepPass(mimeType, documentName)) {
      runInBackground(
        `ingest-deep-pass:${deal.id}`,
        runIngestDeepPass({
          dealId: deal.id,
          orgId,
          documentId: document.id,
          fileBuffer: buffer,
          fileName: documentName,
          mimeType,
        }),
      );
      backgroundExtraction = 'started';
    }

    log.info('Ingest complete', { dealId: deal.id, isUpdate, backgroundExtraction });

    return {
      status: isUpdate ? 200 : 201,
      body: {
        success: true,
        isUpdate,
        backgroundExtraction,
        deal: {
          ...deal,
          company: company || deal.company,
        },
        document,
        extraction: {
          companyName: aiData.companyName,
          industry: aiData.industry,
          currency: aiData.currency || 'USD',
          revenue: aiData.revenue,
          ebitda: aiData.ebitda,
          overallConfidence: aiData.overallConfidence,
          needsReview: aiData.needsReview,
          reviewReasons: aiData.reviewReasons,
        },
      },
    };
  } catch (error) {
    log.error('Ingest error', error);
    const message = error instanceof Error ? error.message : 'Failed to process document';
    return { status: 500, body: { error: 'Failed to process document', message } };
  }
}

export default router;
