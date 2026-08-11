import { Router } from 'express';
import { supabase } from '../supabase.js';
import { embedDocument } from '../rag.js';
import { log } from '../utils/logger.js';
import { parseEmailFile } from '../services/emailParser.js';
import { parseExcelToDealRows } from '../services/excelParser.js';
import { getIconForIndustry } from '../services/dealMerger.js';
import { AuditLog } from '../services/auditLog.js';
import { getOrgId } from '../middleware/orgScope.js';
import { extractTextFromPDF, upload } from './ingest-shared.js';
import { generateTeasersForDeal } from '../services/firmTeaserService.js';
import { createDealFromEmail } from '../integrations/gmail/autoCreateDeal.js';

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

    // 1. Parse the .eml.
    const emailData = await parseEmailFile(file.buffer);
    if (!emailData) {
      return res.status(400).json({ error: 'Failed to parse email file' });
    }

    // 2. Delegate deal creation to the shared helper (same path used by Gmail
    //    cron sync). The route layer keeps responsibility for attachments,
    //    audit logging (needs `req`), and the HTTP response shape.
    const result = await createDealFromEmail({
      organizationId: orgId,
      userId: req.user?.id ?? null,
      source: 'manual_eml',
      email: {
        subject: emailData.subject,
        from: emailData.from,
        date: emailData.date,
        bodyText: emailData.bodyText,
      },
    });

    if (!result.created) {
      const msg =
        result.reason === 'duplicate'
          ? 'A deal already exists for this email'
          : result.reason === 'insufficient_content'
            ? 'Email has insufficient content for deal extraction'
            : result.reason === 'extraction_failed'
              ? 'Could not extract deal data from email'
              : 'Could not create a deal from this email';
      return res.status(400).json({ error: msg, reason: result.reason, existingDealId: result.dealId });
    }

    const dealId = result.dealId!;

    // 3. Process PDF attachments (kept route-side; cron path doesn't fetch them).
    const processedAttachments: string[] = [];
    for (const att of emailData.attachments) {
      if (att.contentType === 'application/pdf' && att.size < 50 * 1024 * 1024) {
        try {
          const pdfData = await extractTextFromPDF(att.content);
          if (pdfData?.text) {
            await supabase.from('Document').insert({
              dealId,
              name: att.filename,
              type: 'OTHER',
              extractedText: pdfData.text,
              mimeType: 'application/pdf',
              status: 'pending_analysis',
            });
            processedAttachments.push(att.filename);

            embedDocument(dealId + '-' + att.filename, dealId, pdfData.text)
              .catch(err => log.error('Attachment RAG error', err));
          }
        } catch (err) {
          log.warn('Attachment processing failed', { filename: att.filename, error: err });
        }
      }
    }

    // 4. Audit log (route layer holds `req`).
    await AuditLog.aiIngest(req, `Email — ${emailData.subject}`, dealId);

    // Auto-generate firm-teaser blurbs for the new deal (blocking,
    // best-effort — never fail ingest on teaser error).
    try {
      await generateTeasersForDeal({ dealId, orgId });
    } catch (teaserErr) {
      log.error('Email ingest: firm-teaser auto-gen failed', teaserErr, { dealId });
    }

    log.info('Email ingest complete', {
      dealId,
      companyName: result.companyName,
      confidence: result.extraction?.overallConfidence,
      attachments: processedAttachments.length,
    });

    res.status(201).json({
      success: true,
      deal: { id: dealId, name: result.companyName },
      extraction: result.extraction,
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

        // Auto-generate firm-teaser blurbs for each imported deal (best-effort;
        // a teaser failure must not fail the row).
        try {
          await generateTeasersForDeal({ dealId: deal.id, orgId });
        } catch (teaserErr) {
          log.error('Bulk ingest: firm-teaser auto-gen failed', teaserErr, { dealId: deal.id });
        }

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
