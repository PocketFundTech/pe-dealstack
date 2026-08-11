import { Router } from 'express';
import { supabase } from '../supabase.js';
import { z } from 'zod';
import { log } from '../utils/logger.js';
import { AuditLog } from '../services/auditLog.js';
import { getOrgId } from '../middleware/orgScope.js';
import { generateTeasersForDeal } from '../services/firmTeaserService.js';

// Re-export shared utilities for backwards compatibility
export { extractTextFromPDF, formatValueWithUnit, upload } from './ingest-shared.js';

// Sub-routers
import ingestUploadRouter from './ingest-upload.js';
import ingestDriveRouter from './ingest-drive.js';
import ingestTextRouter from './ingest-text.js';
import ingestUrlRouter from './ingest-url.js';
import ingestEmailRouter from './ingest-email.js';

const router = Router();

// Mount sub-routers
router.use('/', ingestUploadRouter);
router.use('/', ingestDriveRouter);
router.use('/', ingestTextRouter);
router.use('/', ingestUrlRouter);
router.use('/', ingestEmailRouter);

// Validation schema for review approval
const reviewApprovalSchema = z.object({
  companyName: z.string().optional(),
  industry: z.string().optional(),
  revenue: z.number().nullable().optional(),
  ebitda: z.number().nullable().optional(),
  description: z.string().optional(),
  approved: z.boolean(),
});

// GET /api/ingest/pending-review - Get deals pending manual review
router.get('/pending-review', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { data: deals, error } = await supabase
      .from('Deal')
      .select(`
        id, name, stage, status, industry, revenue, ebitda,
        extractionConfidence, needsReview, reviewReasons,
        createdAt,
        company:Company(id, name),
        documents:Document(id, name, type, extractedData, confidence)
      `)
      .eq('organizationId', orgId)
      .eq('needsReview', true)
      .order('createdAt', { ascending: false });

    if (error) throw error;

    res.json({
      count: deals?.length || 0,
      deals: deals || [],
    });
  } catch (error) {
    log.error('Error fetching pending reviews', error);
    res.status(500).json({ error: 'Failed to fetch pending reviews' });
  }
});

// POST /api/ingest/:dealId/review - Approve or update extracted data
router.post('/:dealId/review', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const validation = reviewApprovalSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid request', details: validation.error.errors });
    }

    const { companyName, industry, revenue, ebitda, description, approved } = validation.data;

    // Get current deal (org-scoped)
    const { data: deal, error: fetchError } = await supabase
      .from('Deal')
      .select('*')
      .eq('id', dealId)
      .eq('organizationId', orgId)
      .single();

    if (fetchError || !deal) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // Build update object
    const updates: Record<string, any> = {
      needsReview: false,
      reviewReasons: [],
      status: 'ACTIVE',
    };

    // Apply user corrections if provided
    if (companyName !== undefined) updates.name = companyName;
    if (industry !== undefined) updates.industry = industry;
    if (revenue !== undefined) updates.revenue = revenue;
    if (ebitda !== undefined) updates.ebitda = ebitda;
    if (description !== undefined) updates.description = description;

    // If user explicitly rejected, mark as rejected
    if (!approved) {
      updates.status = 'REJECTED';
    }

    // Update deal
    const { data: updatedDeal, error: updateError } = await supabase
      .from('Deal')
      .update(updates)
      .eq('id', dealId)
      .select()
      .single();

    if (updateError) throw updateError;

    // Update company name if changed
    if (companyName && deal.companyId) {
      await supabase
        .from('Company')
        .update({ name: companyName, industry })
        .eq('id', deal.companyId);
    }

    // Log activity
    await supabase.from('Activity').insert({
      dealId,
      type: 'DEAL_REVIEWED',
      title: approved ? 'Deal extraction approved' : 'Deal extraction rejected',
      description: approved
        ? `Manual review completed. ${companyName ? 'Company name updated.' : ''} ${industry ? 'Industry updated.' : ''}`
        : 'Deal was rejected during manual review.',
      metadata: {
        previousValues: {
          name: deal.name,
          industry: deal.industry,
          revenue: deal.revenue,
          ebitda: deal.ebitda,
        },
        newValues: updates,
        approved,
      },
    });

    // Audit log
    await AuditLog.dealUpdated(req, dealId, updatedDeal.name || deal.name, {
      action: approved ? 'APPROVED' : 'REJECTED',
      previousValues: { name: deal.name, industry: deal.industry, revenue: deal.revenue, ebitda: deal.ebitda },
      newValues: updates,
    });

    // On approval the deal becomes ACTIVE (and the user may have corrected
    // fields) — (re)generate firm-teaser blurbs so they reflect the approved
    // data. Blocking + best-effort; never fail the review on teaser error.
    if (approved) {
      try {
        await generateTeasersForDeal({ dealId, orgId });
      } catch (teaserErr) {
        log.error('Review: firm-teaser auto-gen failed', teaserErr, { dealId });
      }
    }

    res.json({
      success: true,
      deal: updatedDeal,
    });
  } catch (error) {
    log.error('Review error', error);
    res.status(500).json({ error: 'Failed to process review' });
  }
});

// GET /api/ingest/:dealId/extraction - Get extraction details for a deal
router.get('/:dealId/extraction', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);

    // Verify deal belongs to user's org
    const { data: deal } = await supabase
      .from('Deal')
      .select('id, name, extractionConfidence, needsReview, reviewReasons')
      .eq('id', dealId)
      .eq('organizationId', orgId)
      .single();

    if (!deal) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const { data: documents, error } = await supabase
      .from('Document')
      .select('id, name, type, extractedData, extractedText, confidence, aiAnalyzedAt')
      .eq('dealId', dealId)
      .order('createdAt', { ascending: false });

    if (error) throw error;

    res.json({
      deal,
      documents: documents || [],
    });
  } catch (error) {
    log.error('Error fetching extraction', error);
    res.status(500).json({ error: 'Failed to fetch extraction details' });
  }
});

export default router;
