import { Router } from 'express';
import { supabase } from '../supabase.js';
import { embedDocument } from '../rag.js';
import { log } from '../utils/logger.js';
import { parseEmailFile } from '../services/emailParser.js';
import { parseExcelToDealRows } from '../services/excelParser.js';
import { getIconForIndustry } from '../services/dealMerger.js';
import { AuditLog } from '../services/auditLog.js';
import { getOrgId } from '../middleware/orgScope.js';
import { extractTextFromPDF, upload, resolveUploadedFile, cleanupStagingObject } from './ingest-shared.js';
import { runIngestFromBuffer } from './ingest-upload.js';
import { generateTeasersForDeal } from '../services/firmTeaserService.js';
import { createDealFromEmail } from '../integrations/gmail/autoCreateDeal.js';
import { runAfterResponse } from '../utils/afterResponse.js';

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

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

    // 3. Process PDF attachments concurrently (kept route-side; cron path
    // doesn't fetch them). Each attachment is independent — extraction +
    // insert + RAG embed for one doesn't depend on any other, so run them
    // in parallel instead of one at a time.
    const pdfAttachments = emailData.attachments.filter(
      att => att.contentType === 'application/pdf' && att.size < 50 * 1024 * 1024,
    );
    const attachmentResults = await mapWithConcurrency(pdfAttachments, 3, async (att) => {
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

          embedDocument(dealId + '-' + att.filename, dealId, pdfData.text)
            .catch(err => log.error('Attachment RAG error', err));

          return att.filename;
        }
      } catch (err) {
        log.warn('Attachment processing failed', { filename: att.filename, error: err });
      }
      return null;
    });
    const processedAttachments = attachmentResults.filter((name): name is string => name !== null);

    // 4. Audit log (route layer holds `req`).
    await AuditLog.aiIngest(req, `Email — ${emailData.subject}`, dealId);

    // Auto-generate firm-teaser blurbs for the new deal. Never blocks the
    // response — deferred via runAfterResponse (awaited inline when no
    // post-response hook is present). Best-effort: never fail ingest.
    await runAfterResponse(req, async () => {
      try {
        await generateTeasersForDeal({ dealId, orgId });
      } catch (teaserErr) {
        log.error('Email ingest: firm-teaser auto-gen failed', teaserErr, { dealId });
      }
    });

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
//
// Accepts either multipart/form-data (legacy) or a JSON body
// `{ storagePath, fileName, mimeType, size }` pointing at a file already
// staged in Supabase Storage via POST /api/uploads/sign — see
// ingest-shared.ts#resolveUploadedFile.
subRouter.post('/bulk', upload.single('file'), async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const resolved = await resolveUploadedFile(req);
    if (resolved.error) {
      return res.status(resolved.error.status).json(resolved.error.body);
    }
    const file = resolved.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });
    const cleanupStoragePath = resolved.cleanupStoragePath;

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
      // The intake form sends EVERY spreadsheet here in "new deal" mode, so a
      // financial model / CIM workbook (no "Company" column) lands on this
      // path too. Treat it as a single-company document and run the normal
      // ingest pipeline (Excel is a supported single-doc input there) instead
      // of telling the user to add a column that makes no sense for their file.
      log.info('Bulk ingest: no deal-list columns — routing to single-document ingest', {
        filename: file.originalname,
      });
      const result = await runIngestFromBuffer({
        buffer: file.buffer,
        mimeType: file.mimetype,
        documentName: file.originalname,
        fileSize: file.size,
        req,
      });
      if (cleanupStoragePath) {
        await runAfterResponse(req, () => cleanupStagingObject(cleanupStoragePath));
      }
      return res.status(result.status).json(result.body);
    }

    if (dealRows.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 deals per import. Split your file.' });
    }

    const results: { success: any[]; failed: any[]; total: number } = {
      success: [],
      failed: [],
      total: dealRows.length,
    };

    // ─── Batch company resolution ───
    // One query for every existing company in this org, matched in-memory
    // case-insensitively (replicates the original per-row `.ilike()` exact
    // match), instead of one SELECT per row.
    const { data: allCompanies } = await supabase
      .from('Company')
      .select('id, name')
      .eq('organizationId', orgId);
    const companyByLowerName = new Map<string, { id: string; name: string }>();
    for (const c of allCompanies || []) companyByLowerName.set(c.name.toLowerCase(), c);

    const missingNames = [...new Set(
      dealRows.map(r => r.companyName).filter(name => !companyByLowerName.has(name.toLowerCase())),
    )];

    if (missingNames.length > 0) {
      const payload = missingNames.map(name => {
        const row = dealRows.find(r => r.companyName === name)!;
        return { name: row.companyName, industry: row.industry, description: row.description, organizationId: orgId };
      });
      const { data: inserted, error } = await supabase.from('Company').insert(payload).select();
      if (!error && inserted) {
        for (const c of inserted) companyByLowerName.set(c.name.toLowerCase(), c);
      } else {
        // Batch insert failed (e.g. one bad row) — fall back to per-row
        // inserts so a single bad company doesn't sink the whole import.
        log.warn('Bulk ingest: batch company insert failed, falling back to per-row', { error });
        for (const name of missingNames) {
          const row = dealRows.find(r => r.companyName === name)!;
          try {
            const { data: c, error: rowErr } = await supabase
              .from('Company')
              .insert({ name: row.companyName, industry: row.industry, description: row.description, organizationId: orgId })
              .select()
              .single();
            if (rowErr) throw rowErr;
            companyByLowerName.set(c.name.toLowerCase(), c);
          } catch (err) {
            log.warn('Bulk ingest: company creation failed', { companyName: name, error: (err as any).message });
          }
        }
      }
    }

    const unresolvedRows = dealRows.filter(r => !companyByLowerName.has(r.companyName.toLowerCase()));
    for (const row of unresolvedRows) {
      results.failed.push({ companyName: row.companyName, error: 'Failed to resolve or create company' });
    }

    // ─── Batch deal insert ───
    const resolvedRows = dealRows.filter(r => companyByLowerName.has(r.companyName.toLowerCase()));
    const buildDealPayload = (row: (typeof resolvedRows)[number]) => ({
      name: row.companyName,
      companyId: companyByLowerName.get(row.companyName.toLowerCase())!.id,
      organizationId: orgId,
      stage: row.stage || 'INITIAL_REVIEW',
      status: 'ACTIVE',
      industry: row.industry,
      description: row.description || row.notes,
      revenue: row.revenue,
      ebitda: row.ebitda,
      icon: getIconForIndustry(row.industry || null),
      extractionConfidence: 100, // Manual import = high confidence
    });

    if (resolvedRows.length > 0) {
      const { data: insertedDeals, error: dealsErr } = await supabase
        .from('Deal')
        .insert(resolvedRows.map(buildDealPayload))
        .select();

      if (!dealsErr && insertedDeals) {
        insertedDeals.forEach((deal: any, i: number) => {
          results.success.push({ companyName: resolvedRows[i].companyName, dealId: deal.id });
        });
      } else {
        // Batch insert failed — fall back to per-row inserts so one bad row
        // doesn't sink the whole import, preserving per-row error reporting.
        log.warn('Bulk ingest: batch deal insert failed, falling back to per-row', { error: dealsErr });
        for (const row of resolvedRows) {
          try {
            const { data: deal, error: dealErr } = await supabase
              .from('Deal')
              .insert(buildDealPayload(row))
              .select()
              .single();
            if (dealErr) throw dealErr;
            results.success.push({ companyName: row.companyName, dealId: deal.id });
          } catch (err) {
            log.warn('Row import failed', { companyName: row.companyName, error: (err as any).message });
            results.failed.push({ companyName: row.companyName, error: (err as any).message });
          }
        }
      }
    }

    // Auto-generate firm-teaser blurbs for every imported deal. Never blocks
    // the response — ONE deferred job (not one await per row) with bounded
    // parallelism, so a 40-60+ row import doesn't serially eat into
    // maxDuration. Best-effort: a teaser failure must never fail the import.
    if (results.success.length > 0) {
      const createdDeals = results.success;
      await runAfterResponse(req, async () => {
        await mapWithConcurrency(createdDeals, 3, async (s) => {
          try {
            await generateTeasersForDeal({ dealId: s.dealId, orgId });
          } catch (teaserErr) {
            log.error('Bulk ingest: firm-teaser auto-gen failed', teaserErr, { dealId: s.dealId });
          }
        });
      });
    }

    if (cleanupStoragePath) {
      await runAfterResponse(req, () => cleanupStagingObject(cleanupStoragePath));
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
