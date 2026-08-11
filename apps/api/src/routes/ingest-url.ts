import { Router } from 'express';
import { supabase } from '../supabase.js';
import { extractDealDataFromText } from '../services/aiExtractor.js';
import { z } from 'zod';
import { embedDocument } from '../rag.js';
import { log } from '../utils/logger.js';
import { captureAgentError } from '../utils/sentryHelpers.js';
import { validateFinancials } from '../services/financialValidator.js';
import { researchCompany, buildResearchText } from '../services/companyResearcher.js';
import { mergeIntoExistingDeal, getIconForIndustry } from '../services/dealMerger.js';
import { AuditLog } from '../services/auditLog.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { formatValueWithUnit } from './ingest-shared.js';
import { resolveUserId } from './notifications.js';
import { isPrivateUrl } from '../utils/urlHelpers.js';
import { findExistingDocument, logDuplicateSkip } from '../services/documentDedup.js';
import { generateTeasersForDeal } from '../services/firmTeaserService.js';

const subRouter = Router();

// ─── Website URL Research (Multi-Page Scraping) ──────────────

const urlResearchSchema = z.object({
  url: z.string().url('Must be a valid URL').max(2048),
  companyName: z.string().max(500).optional(),
  autoCreateDeal: z.boolean().optional().default(true),
  dealId: z.string().uuid().optional(),
});

// POST /api/ingest/url — Research company from website URL (scrapes multiple pages)
subRouter.post('/url', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const validation = urlResearchSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.errors });
    }

    const { url, companyName: userCompanyName, autoCreateDeal, dealId: targetDealId } = validation.data;

    // SECURITY: block SSRF — refuse URLs pointing to loopback / RFC1918 / .local before fetch.
    if (isPrivateUrl(url)) {
      return res.status(400).json({ error: 'URL points to a private/internal network' });
    }

    log.info('URL research starting', { url, targetDealId });

    // Step 1: Research company (scrapes multiple pages in parallel)
    const research = await researchCompany(url);
    const researchText = buildResearchText(research);

    if (researchText.length < 100) {
      return res.status(400).json({
        error: 'Could not extract enough content from website',
        pagesAttempted: research.companyWebsite.scrapedPages.length,
      });
    }

    log.debug('Company research complete', {
      url,
      pagesScraped: research.companyWebsite.scrapedPages.length,
      charCount: researchText.length,
    });

    // Step 2: AI extraction from combined research text
    const aiData = await extractDealDataFromText(researchText);
    if (!aiData) {
      return res.status(400).json({ error: 'AI could not extract deal data from website content' });
    }

    if (userCompanyName) {
      aiData.companyName.value = userCompanyName;
      aiData.companyName.confidence = 100;
    }

    // Financial validation — sourceLength allows tighter bounds on short docs
    const financialCheck = validateFinancials({
      revenue: aiData.revenue.value,
      ebitda: aiData.ebitda.value,
      ebitdaMargin: aiData.ebitdaMargin?.value,
      revenueGrowth: aiData.revenueGrowth?.value,
      employees: aiData.employees?.value,
      dealSize: aiData.dealSize?.value,
      sourceLength: researchText.length,
    });
    if (!financialCheck.isValid) {
      aiData.needsReview = true;
      aiData.reviewReasons = [...(aiData.reviewReasons || []), ...financialCheck.warnings];
    }

    // If preview-only mode, return extraction without creating deal
    if (!autoCreateDeal && !targetDealId) {
      return res.json({
        success: true,
        extraction: {
          companyName: aiData.companyName,
          industry: aiData.industry,
          revenue: aiData.revenue,
          ebitda: aiData.ebitda,
          overallConfidence: aiData.overallConfidence,
          needsReview: aiData.needsReview,
          reviewReasons: aiData.reviewReasons,
        },
        research: {
          pagesScraped: research.companyWebsite.scrapedPages,
          textLength: researchText.length,
        },
      });
    }

    const companyName = aiData.companyName.value || userCompanyName || 'Unknown Company';
    let deal: any;
    let company: any;
    let isUpdate = false;

    if (targetDealId) {
      // ─── Update Existing Deal path ───
      // Verify the caller's org owns this deal before merging extracted data
      // and dropping a Document row pointing at it. Without this, a client
      // could ingest scraped web data into any tenant's deal.
      const dealAccess = await verifyDealAccess(targetDealId, orgId);
      if (!dealAccess) {
        return res.status(404).json({ error: 'Deal not found' });
      }

      log.info('URL ingest into existing deal', { dealId: targetDealId });
      const result = await mergeIntoExistingDeal(targetDealId, aiData, req.user?.id, `Web Research — ${url}`);
      deal = result.deal;
      company = deal.company;
      isUpdate = true;
    } else {
      // ─── Create New Deal path ───
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

      // Per-field confidence floor — see ingest-text.ts for rationale.
      const FIELD_FLOOR = 60;
      const safeRevenue = aiData.revenue.value != null && aiData.revenue.confidence >= FIELD_FLOOR
        ? aiData.revenue.value : null;
      const safeEbitda = aiData.ebitda.value != null && aiData.ebitda.confidence >= FIELD_FLOOR
        ? aiData.ebitda.value : null;
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
          // dealSize is the EV/transaction value of the deal, NOT revenue.
          // Use the dedicated dealSize extraction field, gated on confidence.
          dealSize: safeDealSize,
          aiThesis: aiData.summary,
          icon: dealIcon,
          extractionConfidence: aiData.overallConfidence,
          needsReview: aiData.needsReview,
          reviewReasons: aiData.reviewReasons,
          aiRisks: { keyRisks: aiData.keyRisks || [], investmentHighlights: aiData.investmentHighlights || [] },
          source: 'web_research',
        })
        .select()
        .single();

      if (dealError) throw dealError;
      deal = newDeal;
    }

    // Generate formatted Deal Overview and store as document
    const overviewSections: string[] = [];
    overviewSections.push(`# Deal Overview: ${companyName}\n`);

    if (aiData.description.value) {
      overviewSections.push(`## Company Profile`);
      overviewSections.push(aiData.description.value);
    }

    const details: string[] = [];
    if (aiData.industry.value) details.push(`- **Industry:** ${aiData.industry.value}`);
    if (aiData.headquarters?.value) details.push(`- **Headquarters:** ${aiData.headquarters.value}`);
    if (aiData.foundedYear?.value) details.push(`- **Founded:** ${aiData.foundedYear.value}`);
    if (aiData.employees?.value) details.push(`- **Employees:** ~${aiData.employees.value.toLocaleString()}`);
    details.push(`- **Website:** ${url}`);
    if (details.length > 1) {
      overviewSections.push(`\n## Key Details\n${details.join('\n')}`);
    }

    if (aiData.summary) {
      overviewSections.push(`\n## Investment Thesis\n${aiData.summary}`);
    }

    const financials: string[] = [];
    if (aiData.revenue.value != null) financials.push(`- **Revenue:** ${formatValueWithUnit(aiData.revenue.value)}`);
    if (aiData.ebitda.value != null) financials.push(`- **EBITDA:** ${formatValueWithUnit(aiData.ebitda.value)}`);
    if (aiData.ebitdaMargin?.value != null) financials.push(`- **EBITDA Margin:** ${aiData.ebitdaMargin.value}%`);
    if (aiData.revenueGrowth?.value != null) financials.push(`- **Revenue Growth:** ${aiData.revenueGrowth.value}% YoY`);
    if (financials.length > 0) {
      overviewSections.push(`\n## Financial Highlights\n${financials.join('\n')}`);
    }

    if (aiData.investmentHighlights?.length > 0) {
      overviewSections.push(`\n## Investment Highlights\n${aiData.investmentHighlights.map((h: string, i: number) => `${i + 1}. ${h}`).join('\n')}`);
    }

    if (aiData.keyRisks?.length > 0) {
      overviewSections.push(`\n## Key Risks\n${aiData.keyRisks.map((r: string, i: number) => `${i + 1}. ${r}`).join('\n')}`);
    }

    overviewSections.push(`\n---\n*Generated from web research of ${url}*`);
    overviewSections.push(`*${research.companyWebsite.scrapedPages.length} pages analyzed · ${aiData.overallConfidence}% confidence*`);

    const overviewText = overviewSections.join('\n');
    const overviewDocName = `Deal Overview — ${companyName}.md`;
    const overviewByteLength = Buffer.byteLength(overviewText, 'utf8');

    // Dedup: if a Deal Overview with the same name+byte-length already exists
    // for this deal (re-research of the same URL), reuse it.
    const existingUrlDuplicate = await findExistingDocument(deal.id, overviewDocName, overviewByteLength);
    let document: any;
    if (existingUrlDuplicate) {
      logDuplicateSkip(existingUrlDuplicate, {
        dealId: deal.id,
        name: overviewDocName,
        fileSize: overviewByteLength,
      });
      document = existingUrlDuplicate;
    } else {
      const { data: insertedDoc } = await supabase
        .from('Document')
        .insert({
          dealId: deal.id,
          name: overviewDocName,
          type: 'OTHER',
          fileSize: overviewByteLength,
          extractedText: researchText,
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
          aiAnalysis: overviewText,
          status: aiData.needsReview ? 'pending_review' : 'analyzed',
          confidence: aiData.overallConfidence / 100,
          aiAnalyzedAt: new Date().toISOString(),
          mimeType: 'text/markdown',
          metadata: {
            sourceUrl: url,
            pagesScraped: research.companyWebsite.scrapedPages,
          },
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
        title: 'Deal created from web research',
        description: `"${companyName}" auto-created from ${url} (${research.companyWebsite.scrapedPages.length} pages) with ${aiData.overallConfidence}% confidence`,
        metadata: {
          sourceType: 'web_research',
          url,
          pagesScraped: research.companyWebsite.scrapedPages,
          overallConfidence: aiData.overallConfidence,
        },
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

    // RAG embed research text in background
    if (researchText.length > 100) {
      embedDocument(document?.id || deal.id, deal.id, researchText)
        .then(result => {
          if (result.success) log.debug('Research RAG embedding complete', { chunkCount: result.chunkCount });
          else log.error('Research RAG embedding failed', result.error);
        })
        .catch(err => {
          log.error('Research RAG embedding error', err);
          captureAgentError(err, { context: 'rag:embed_url_research' }, 'warning');
        });
    }

    await AuditLog.aiIngest(req, `Web Research — ${url}`, deal.id);

    // Auto-generate firm-teaser blurbs for newly-created deals (blocking,
    // best-effort — never fail ingest on teaser error).
    if (!isUpdate) {
      try {
        await generateTeasersForDeal({ dealId: deal.id, orgId });
      } catch (teaserErr) {
        log.error('URL ingest: firm-teaser auto-gen failed', teaserErr, { dealId: deal.id });
      }
    }

    log.info('URL research ingest complete', { dealId: deal.id, url, isUpdate });

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
      research: {
        pagesScraped: research.companyWebsite.scrapedPages,
        textLength: researchText.length,
      },
    });
  } catch (error) {
    log.error('URL research error', error);
    res.status(500).json({ error: 'Failed to research company' });
  }
});

export default subRouter;
