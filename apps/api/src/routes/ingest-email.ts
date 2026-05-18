import { Router } from 'express';
import { supabase } from '../supabase.js';
import { extractDealDataFromText } from '../services/aiExtractor.js';
import { embedDocument } from '../rag.js';
import { log } from '../utils/logger.js';
import { captureAgentError } from '../utils/sentryHelpers.js';
import { validateFinancials } from '../services/financialValidator.js';
import { parseEmailFile, buildDealTextFromEmail } from '../services/emailParser.js';
import { parseExcelToDealRows } from '../services/excelParser.js';
import { getIconForIndustry } from '../services/dealMerger.js';
import { AuditLog } from '../services/auditLog.js';
import { getOrgId } from '../middleware/orgScope.js';
import { extractTextFromPDF, upload } from './ingest-shared.js';
import { resolveUserId } from './notifications.js';

const subRouter = Router();

// ─── Email Parsing & Auto-Ingest ──────────────────────────────

// POST /api/ingest/email — Parse uploaded .eml file into a deal
subRouter.post('/email', upload.single('file'), async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No email file provided' });

    if (!file.originalname.endsWith('.eml') && file.mimetype !== 'message/rfc822') {
      return res.status(400).json({ error: 'File must be .eml format' });
    }

    log.info('Email ingest starting', { filename: file.originalname });

    // Step 1: Parse email
    const emailData = await parseEmailFile(file.buffer);
    if (!emailData) {
      return res.status(400).json({ error: 'Failed to parse email file' });
    }

    // Step 2: Build text for AI extraction
    const dealText = buildDealTextFromEmail(emailData);
    if (dealText.length < 100) {
      return res.status(400).json({ error: 'Email has insufficient content for deal extraction' });
    }

    // Step 3: AI extraction
    const aiData = await extractDealDataFromText(dealText);
    if (!aiData) {
      return res.status(400).json({ error: 'Could not extract deal data from email' });
    }

    // Step 4: Financial validation
    const financialCheck = validateFinancials({
      revenue: aiData.revenue.value,
      ebitda: aiData.ebitda.value,
      ebitdaMargin: aiData.ebitdaMargin?.value,
      revenueGrowth: aiData.revenueGrowth?.value,
      employees: aiData.employees?.value,
    });
    if (!financialCheck.isValid) {
      aiData.needsReview = true;
      aiData.reviewReasons = [...(aiData.reviewReasons || []), ...financialCheck.warnings];
    }

    // Step 5: Create or find company
    const companyName = aiData.companyName.value || emailData.subject;
    const { data: existingCompany } = await supabase
      .from('Company')
      .select('id, name')
      .ilike('name', companyName)
      .eq('organizationId', orgId)
      .single();

    let company;
    if (existingCompany) {
      company = existingCompany;
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
      if (companyError) throw companyError;
      company = newCompany;
    }

    // Step 6: Create deal
    const dealIcon = getIconForIndustry(aiData.industry.value);
    const dealStatus = aiData.needsReview ? 'PENDING_REVIEW' : 'ACTIVE';

    const { data: deal, error: dealError } = await supabase
      .from('Deal')
      .insert({
        name: companyName,
        companyId: company.id,
        organizationId: orgId,
        stage: 'INITIAL_REVIEW',
        status: dealStatus,
        industry: aiData.industry.value,
        description: aiData.description.value,
        revenue: aiData.revenue.value,
        ebitda: aiData.ebitda.value,
        dealSize: aiData.revenue.value,
        aiThesis: aiData.summary,
        icon: dealIcon,
        extractionConfidence: aiData.overallConfidence,
        needsReview: aiData.needsReview,
        reviewReasons: aiData.reviewReasons,
        aiRisks: { keyRisks: aiData.keyRisks || [], investmentHighlights: aiData.investmentHighlights || [] },
        source: 'email',
      })
      .select()
      .single();

    if (dealError) throw dealError;

    // Step 7: Create document record for email body
    const { data: document } = await supabase
      .from('Document')
      .insert({
        dealId: deal.id,
        name: `Email — ${emailData.subject}`,
        type: 'OTHER',
        extractedText: dealText,
        extractedData: {
          companyName: aiData.companyName,
          industry: aiData.industry,
          description: aiData.description,
          revenue: aiData.revenue,
          ebitda: aiData.ebitda,
          ebitdaMargin: aiData.ebitdaMargin,
          revenueGrowth: aiData.revenueGrowth,
          employees: aiData.employees,
          summary: aiData.summary,
          overallConfidence: aiData.overallConfidence,
          needsReview: aiData.needsReview,
          reviewReasons: aiData.reviewReasons,
        },
        status: aiData.needsReview ? 'pending_review' : 'analyzed',
        confidence: aiData.overallConfidence / 100,
        aiAnalyzedAt: new Date().toISOString(),
        mimeType: 'message/rfc822',
      })
      .select()
      .single();

    // Step 8: Process PDF attachments
    const processedAttachments: string[] = [];
    for (const att of emailData.attachments) {
      if (att.contentType === 'application/pdf' && att.size < 50 * 1024 * 1024) {
        try {
          const pdfData = await extractTextFromPDF(att.content);
          if (pdfData?.text) {
            await supabase.from('Document').insert({
              dealId: deal.id,
              name: att.filename,
              type: 'OTHER',
              extractedText: pdfData.text,
              mimeType: 'application/pdf',
              status: 'pending_analysis',
            });
            processedAttachments.push(att.filename);

            // RAG embed the attachment in background
            embedDocument(deal.id + '-' + att.filename, deal.id, pdfData.text)
              .catch(err => {
                log.error('Attachment RAG error', err);
                captureAgentError(err, { context: 'rag:embed_email_attachment' }, 'warning');
              });
          }
        } catch (err) {
          log.warn('Attachment processing failed', { filename: att.filename, error: err });
        }
      }
    }

    // Step 9: Log activity
    await supabase.from('Activity').insert({
      dealId: deal.id,
      type: 'DEAL_CREATED',
      title: 'Deal created from email',
      description: `From: ${emailData.from}\nSubject: ${emailData.subject}`,
      metadata: {
        emailFrom: emailData.from,
        emailSubject: emailData.subject,
        emailDate: emailData.date,
        attachmentsProcessed: processedAttachments,
      },
    });

    // Step 10: Auto-assign creator as analyst
    if (req.user?.id) {
      await supabase.from('DealTeamMember').insert({
        dealId: deal.id,
        userId: req.user.id,
        role: 'MEMBER',
      });
    }

    // Step 11: RAG embed email body in background
    if (dealText.length > 100) {
      embedDocument(document?.id || deal.id, deal.id, dealText)
        .catch(err => {
          log.error('Email RAG embedding error', err);
          captureAgentError(err, { context: 'rag:embed_email' }, 'warning');
        });
    }

    // Step 11: Audit log
    await AuditLog.aiIngest(req, `Email — ${emailData.subject}`, deal.id);

    log.info('Email ingest complete', {
      dealId: deal.id,
      companyName,
      confidence: aiData.overallConfidence,
      attachments: processedAttachments.length,
    });

    res.status(201).json({
      success: true,
      deal,
      extraction: aiData,
      email: {
        subject: emailData.subject,
        from: emailData.from,
        date: emailData.date,
        attachmentsProcessed: processedAttachments.length,
        attachmentNames: processedAttachments,
      },
    });
  } catch (error) {
    log.error('Email ingest error', error);
    res.status(500).json({ error: 'Failed to process email' });
  }
});

// ─── Excel/CSV Bulk Import ────────────────────────────────────

// POST /api/ingest/bulk — Import deals from Excel/CSV
subRouter.post('/bulk', upload.single('file'), async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });

    if (
      !file.mimetype.includes('spreadsheet') &&
      !file.mimetype.includes('excel') &&
      !file.mimetype.includes('csv')
    ) {
      return res.status(400).json({ error: 'File must be Excel (.xlsx) or CSV (.csv)' });
    }

    log.info('Bulk ingest starting', { filename: file.originalname });

    const dealRows = parseExcelToDealRows(file.buffer);
    if (dealRows.length === 0) {
      return res.status(400).json({
        error: 'No valid deals found in file. Ensure you have a column named "Company" or "Company Name".',
        hint: 'Supported columns: Company Name, Industry, Revenue, EBITDA, Stage, Description, Notes',
      });
    }

    if (dealRows.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 deals per import. Split your file.' });
    }

    const results: { success: any[]; failed: any[]; total: number } = {
      success: [],
      failed: [],
      total: dealRows.length,
    };

    for (const row of dealRows) {
      try {
        // Deduplicate company
        const { data: existing } = await supabase
          .from('Company')
          .select('id, name')
          .ilike('name', row.companyName)
          .eq('organizationId', orgId)
          .single();

        let company;
        if (existing) {
          company = existing;
        } else {
          const { data: newCo, error } = await supabase
            .from('Company')
            .insert({
              name: row.companyName,
              industry: row.industry,
              description: row.description,
              organizationId: orgId,
            })
            .select()
            .single();
          if (error) throw error;
          company = newCo;
        }

        // Create deal
        const { data: deal, error: dealErr } = await supabase
          .from('Deal')
          .insert({
            name: row.companyName,
            companyId: company.id,
            organizationId: orgId,
            stage: row.stage || 'INITIAL_REVIEW',
            status: 'ACTIVE',
            industry: row.industry,
            description: row.description || row.notes,
            revenue: row.revenue,
            ebitda: row.ebitda,
            icon: getIconForIndustry(row.industry || null),
            extractionConfidence: 100, // Manual import = high confidence
          })
          .select()
          .single();

        if (dealErr) throw dealErr;
        results.success.push({ companyName: row.companyName, dealId: deal.id });
      } catch (err) {
        log.warn('Row import failed', { companyName: row.companyName, error: (err as any).message });
        results.failed.push({ companyName: row.companyName, error: (err as any).message });
      }
    }

    // Audit log for bulk import
    await AuditLog.log(req, {
      action: 'AI_INGEST',
      resourceType: 'DEAL',
      description: `Bulk import: ${results.success.length} deals imported, ${results.failed.length} failed`,
      metadata: {
        source: 'bulk_import',
        filename: file.originalname,
        total: results.total,
        imported: results.success.length,
        failed: results.failed.length,
      },
    });

    log.info('Bulk ingest complete', {
      total: results.total,
      success: results.success.length,
      failed: results.failed.length,
    });

    res.status(201).json({
      success: true,
      summary: {
        total: results.total,
        imported: results.success.length,
        failed: results.failed.length,
        deals: results.success,
        errors: results.failed,
      },
    });
  } catch (error) {
    log.error('Bulk ingest error', error);
    res.status(500).json({ error: 'Failed to process file' });
  }
});

export default subRouter;
