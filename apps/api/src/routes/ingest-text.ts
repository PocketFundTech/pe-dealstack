import { Router } from 'express';
import { supabase } from '../supabase.js';
import { extractDealDataFromText } from '../services/aiExtractor.js';
import { z } from 'zod';
import { embedDocument } from '../rag.js';
import { log } from '../utils/logger.js';
import { captureAgentError } from '../utils/sentryHelpers.js';
import { validateFinancials } from '../services/financialValidator.js';
import { mergeIntoExistingDeal, getIconForIndustry } from '../services/dealMerger.js';
import { AuditLog } from '../services/auditLog.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { resolveUserId } from './notifications.js';
import { findExistingDocument, logDuplicateSkip } from '../services/documentDedup.js';
import { generateTeasersForDeal } from '../services/firmTeaserService.js';

const subRouter = Router();

// ─── Validation Schema ───────────────────────────────────────

const textIngestSchema = z.object({
  text: z
    .string()
    .min(50, 'Text must be at least 50 characters')
    .max(500_000, 'Text must be at most 500,000 characters'),
  sourceName: z.string().max(500).optional(),
  sourceType: z.enum(['email', 'note', 'slack', 'whatsapp', 'other']).optional(),
  dealId: z.string().uuid().optional(),
});

// POST /api/ingest/text — Create deal from raw pasted text
subRouter.post('/text', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const validation = textIngestSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.errors });
    }

    const { text, sourceName, sourceType, dealId: targetDealId } = validation.data;
    log.info('Text ingest starting', { textLength: text.length, sourceType, targetDealId });

    // Step 1: Extract data using existing AI extractor
    const aiData = await extractDealDataFromText(text);
    if (!aiData) {
      return res.status(400).json({ error: 'Could not extract deal data from text. Try providing more detail.' });
    }

    // Financial validation — sourceLength allows tighter bounds on short docs
    const financialCheck = validateFinancials({
      revenue: aiData.revenue.value,
      ebitda: aiData.ebitda.value,
      ebitdaMargin: aiData.ebitdaMargin?.value,
      revenueGrowth: aiData.revenueGrowth?.value,
      employees: aiData.employees?.value,
      dealSize: aiData.dealSize?.value,
      sourceLength: text.length,
    });
    if (!financialCheck.isValid) {
      aiData.needsReview = true;
      aiData.reviewReasons = [...(aiData.reviewReasons || []), ...financialCheck.warnings];
    }

    const docName = sourceName || `${sourceType || 'Text'} input - ${new Date().toLocaleDateString()}`;
    let deal: any;
    let company: any;
    let isUpdate = false;

    if (targetDealId) {
      // ─── Update Existing Deal path ───
      // Verify the caller's org owns this deal before merging extracted data
      // and dropping a Document row pointing at it. Without this, a client
      // could ingest text into any tenant's deal.
      const dealAccess = await verifyDealAccess(targetDealId, orgId);
      if (!dealAccess) {
        return res.status(404).json({ error: 'Deal not found' });
      }

      log.info('Text ingest into existing deal', { dealId: targetDealId });
      const result = await mergeIntoExistingDeal(targetDealId, aiData, req.user?.id, docName);
      deal = result.deal;
      company = deal.company;
      isUpdate = true;
    } else {
      // ─── Create New Deal path ───
      const companyName = aiData.companyName.value || 'Unknown Company';
      const { data: existingCompany } = await supabase
        .from('Company')
        .select('id, name')
        .ilike('name', companyName)
        .eq('organizationId', orgId)
        .single();

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

      const dealIcon = getIconForIndustry(aiData.industry.value);
      const dealStatus = aiData.needsReview ? 'PENDING_REVIEW' : 'ACTIVE';

      // Per-field confidence floor — values below this don't auto-populate
      // the Deal table (they remain on the Document.extractedData blob for
      // manual review). Prevents one-pager teasers / aspirational figures
      // from overwriting deal-level fields.
      const FIELD_FLOOR = 60;
      const safeRevenue = aiData.revenue.value != null && aiData.revenue.confidence >= FIELD_FLOOR
        ? aiData.revenue.value : null;
      const safeEbitda = aiData.ebitda.value != null && aiData.ebitda.confidence >= FIELD_FLOOR
        ? aiData.ebitda.value : null;
      // dealSize is the EV/transaction value of the deal — NOT revenue.
      // Only populate from the dedicated dealSize field, never from revenue.
      const safeDealSize = aiData.dealSize?.value != null && aiData.dealSize.confidence >= FIELD_FLOOR
        ? aiData.dealSize.value : null;

      const { data: newDeal, error: dealError } = await supabase
        .from('Deal')
        .insert({
          name: companyName,
          companyId: company.id,
          organizationId: orgId,
          stage: 'INITIAL_REVIEW',
          status: dealStatus,
          industry: aiData.industry.value,
          description: aiData.description.value,
          revenue: safeRevenue,
          ebitda: safeEbitda,
          currency: aiData.currency || 'USD',
          dealSize: safeDealSize,
          aiThesis: aiData.summary,
          icon: dealIcon,
          extractionConfidence: aiData.overallConfidence,
          needsReview: aiData.needsReview,
          reviewReasons: aiData.reviewReasons,
          aiRisks: { keyRisks: aiData.keyRisks || [], investmentHighlights: aiData.investmentHighlights || [] },
        })
        .select()
        .single();

      if (dealError) throw dealError;
      deal = newDeal;
    }

    // Use the text's byte length as fileSize so re-pasting the exact same
    // content matches the dedup triple. (Pasting a different snippet under
    // the same name = different length = legitimately a new doc.)
    const textByteLength = Buffer.byteLength(text, 'utf8');

    // Dedup: if a Document with the same (dealId, name, fileSize) already
    // exists, reuse it rather than inserting a duplicate.
    const existingTextDuplicate = await findExistingDocument(deal.id, docName, textByteLength);
    let document: any;
    if (existingTextDuplicate) {
      logDuplicateSkip(existingTextDuplicate, {
        dealId: deal.id,
        name: docName,
        fileSize: textByteLength,
      });
      document = existingTextDuplicate;
    } else {
      const { data: insertedDoc } = await supabase
        .from('Document')
        .insert({
          dealId: deal.id,
          name: docName,
          type: 'OTHER',
          fileSize: textByteLength,
          extractedText: text,
          extractedData: {
            companyName: aiData.companyName,
            industry: aiData.industry,
            description: aiData.description,
            revenue: aiData.revenue,
            ebitda: aiData.ebitda,
            ebitdaMargin: aiData.ebitdaMargin,
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
          status: aiData.needsReview ? 'pending_review' : 'analyzed',
          confidence: aiData.overallConfidence / 100,
          aiAnalyzedAt: new Date().toISOString(),
          mimeType: 'text/plain',
        })
        .select()
        .single();
      document = insertedDoc;
    }

    // Log activity + assign team (only for new deals)
    if (!isUpdate) {
      await supabase.from('Activity').insert({
        dealId: deal.id,
        type: 'DEAL_CREATED',
        title: `Deal created from ${sourceType || 'text'} input`,
        description: `"${deal.name}" auto-created with ${aiData.overallConfidence}% confidence`,
        metadata: { sourceType, sourceName, overallConfidence: aiData.overallConfidence },
      });

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

    // Trigger RAG embedding in background
    if (text.length > 100) {
      embedDocument(document?.id || deal.id, deal.id, text)
        .then(result => {
          if (result.success) log.debug('RAG embedding complete', { chunkCount: result.chunkCount });
          else log.error('RAG embedding failed', result.error);
        })
        .catch(err => {
          log.error('RAG embedding error', err);
          captureAgentError(err, { context: 'rag:embed_text' }, 'warning');
        });
    }

    await AuditLog.aiIngest(req, docName, deal.id);

    // Auto-generate firm-teaser blurbs for newly-created deals (blocking,
    // best-effort — never fail ingest on teaser error).
    if (!isUpdate) {
      try {
        await generateTeasersForDeal({ dealId: deal.id, orgId });
      } catch (teaserErr) {
        log.error('Text ingest: firm-teaser auto-gen failed', teaserErr, { dealId: deal.id });
      }
    }

    log.info('Text ingest complete', { dealId: deal.id, isUpdate });

    res.status(isUpdate ? 200 : 201).json({
      success: true,
      isUpdate,
      deal: { ...deal, company: company || deal.company },
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
    });
  } catch (error) {
    log.error('Text ingest error', error);
    res.status(500).json({ error: 'Failed to process text input' });
  }
});

export default subRouter;
