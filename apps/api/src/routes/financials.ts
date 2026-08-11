import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { comparePeriodChronologically } from '../utils/periodChrono.js';
import { refreshDealCache } from '../services/dealCacheWriteback.js';
import { correctMistaggedUnitScale } from '../utils/financialFormat.js';

/**
 * Sweep an array of FinancialStatement rows in place, correcting any
 * `unitScale` whose `lineItems._source` quotes indicate the value is
 * actually raw dollars (the "DMpro LTM/Current Month" stale-row bug
 * where pre-fix extractions tagged $1,473 / $15,600 as MILLIONS). Pure
 * read-time safety net — does NOT touch the DB.
 */
function correctRowsUnitScale<
  T extends { unitScale?: unknown; lineItems?: Record<string, unknown> | null },
>(rows: T[] | null | undefined): void {
  if (!rows) return;
  for (const row of rows) {
    const corrected = correctMistaggedUnitScale(
      row.unitScale as string | null | undefined,
      row.lineItems,
    );
    if (corrected !== row.unitScale) {
      row.unitScale = corrected;
    }
  }
}

// Sub-routers
import financialsExtractionRouter from './financials-extraction.js';
import financialsMergeRouter from './financials-merge.js';
import financialsAnalysisRouter from './financials-analysis.js';

const router = Router();

// Mount sub-routers
router.use('/', financialsExtractionRouter);
router.use('/', financialsMergeRouter);
router.use('/', financialsAnalysisRouter);

// ─── Validation Schemas ───────────────────────────────────────

const patchStatementSchema = z.object({
  lineItems: z.record(z.number().nullable()).optional(),
  period: z.string().optional(),
  periodType: z.enum(['HISTORICAL', 'PROJECTED', 'LTM']).optional(),
  currency: z.string().optional(),
  unitScale: z.enum(['MILLIONS', 'THOUSANDS', 'ACTUALS', 'BILLIONS']).optional(),
});

// ─── Pagination (Task 5.3.3) ──────────────────────────────────
// Default 100 (a typical deal has <100 statements), cap at 500 to prevent
// abuse via ?limit=999999. Per Phase 5 of REMEDIATION_ROADMAP.
const PAGINATION_DEFAULT = 100;
const PAGINATION_MAX = 500;
const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGINATION_MAX).default(PAGINATION_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

// ─── 5a: GET /api/deals/:dealId/financials ────────────────────
// All stored financial statements for a deal

router.get('/deals/:dealId/financials', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    // Validate pagination params; defaults preserve the previous "fetch
    // everything for a deal" UX since deals rarely have >100 statements.
    const paginationParsed = paginationSchema.safeParse(req.query);
    if (!paginationParsed.success) {
      return res.status(400).json({ error: 'Invalid pagination', details: paginationParsed.error.errors });
    }
    const { limit, offset } = paginationParsed.data;

    const { data: statements, error } = await supabase
      .from('FinancialStatement')
      .select('*, Document(id, name)')
      .eq('dealId', dealId)
      .eq('isActive', true)
      .order('statementType', { ascending: true })
      .order('period', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    // Read-time safety net: correct any stale rows whose unitScale doesn't
    // match the raw-dollar amount in their _source quote before serving.
    correctRowsUnitScale(statements);

    // Preserve legacy array response shape (clients depend on `Array.isArray`)
    // while also exposing pagination on the response headers so future clients
    // can opt-in without breaking existing ones.
    const rows = statements ?? [];
    res.setHeader('X-Pagination-Limit', String(limit));
    res.setHeader('X-Pagination-Offset', String(offset));
    res.setHeader('X-Pagination-Has-More', String(rows.length === limit));
    res.json(rows);
  } catch (err) {
    log.error('GET financials error', err);
    res.status(500).json({ error: 'Failed to fetch financial statements' });
  }
});

// ─── 5b: GET /api/deals/:dealId/financials/summary ───────────
// Top-line summary: latest revenue, EBITDA, margins + all periods for charts

router.get('/deals/:dealId/financials/summary', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    // Aggregate endpoint: we need ALL income rows to build sparklines + headline
    // metrics. Pagination would skew aggregates, so we cap at PAGINATION_MAX
    // instead and log if we hit the cap (extremely unlikely for one deal).
    const { data: incomeRows, error } = await supabase
      .from('FinancialStatement')
      .select('*')
      .eq('dealId', dealId)
      .eq('statementType', 'INCOME_STATEMENT')
      .eq('isActive', true)
      .order('period', { ascending: true })
      .range(0, PAGINATION_MAX - 1);

    if (error) throw error;

    if (incomeRows && incomeRows.length === PAGINATION_MAX) {
      log.warn('financials summary hit row cap', { dealId, cap: PAGINATION_MAX });
    }
    // Read-time safety net (see GET /deals/:dealId/financials).
    correctRowsUnitScale(incomeRows);

    if (!incomeRows || incomeRows.length === 0) {
      return res.json({ hasData: false, periods: [] });
    }

    // Latest historical period for the headline numbers (descending so [0] is newest)
    const historical = incomeRows
      .filter(r => r.periodType === 'HISTORICAL')
      .sort((a, b) => comparePeriodChronologically(b.period, a.period));

    const latest = historical[0];
    const li = (row: any, key: string) =>
      (row.lineItems as Record<string, number | null>)?.[key] ?? null;

    const revenue = li(latest, 'revenue');
    const ebitda = li(latest, 'ebitda');
    const ebitdaMargin = revenue && ebitda && revenue > 0
      ? parseFloat(((ebitda / revenue) * 100).toFixed(1))
      : li(latest, 'ebitda_margin_pct');

    // Build sparkline data for all income periods
    const periods = incomeRows.map(r => ({
      period: r.period,
      periodType: r.periodType,
      revenue: li(r, 'revenue'),
      ebitda: li(r, 'ebitda'),
      ebitdaMargin: li(r, 'ebitda_margin_pct'),
      confidence: r.extractionConfidence,
    }));

    res.json({
      hasData: true,
      latestPeriod: latest.period,
      revenue,
      ebitda,
      ebitdaMargin,
      overallConfidence: Math.round(
        incomeRows.reduce((sum, r) => sum + r.extractionConfidence, 0) / incomeRows.length,
      ),
      periods,
    });
  } catch (err) {
    log.error('GET financials summary error', err);
    res.status(500).json({ error: 'Failed to fetch financial summary' });
  }
});

// ─── 5c: PATCH /api/deals/:dealId/financials/:statementId ────
// User edits/corrects an extracted value

router.patch('/deals/:dealId/financials/:statementId', async (req, res) => {
  try {
    const { dealId, statementId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    const updates = patchStatementSchema.parse(req.body);

    // Fetch existing statement (need lineItems for merge)
    const { data: existing, error: findError } = await supabase
      .from('FinancialStatement')
      .select('id, lineItems')
      .eq('id', statementId)
      .eq('dealId', dealId)
      .single();

    if (findError || !existing) {
      return res.status(404).json({ error: 'Statement not found' });
    }

    // Merge lineItems instead of replacing the entire JSONB column
    const updatePayload: Record<string, unknown> = {
      reviewedAt: new Date().toISOString(),
    };

    if (updates.lineItems) {
      updatePayload.lineItems = {
        ...((existing.lineItems as Record<string, unknown>) ?? {}),
        ...updates.lineItems,
      };
    }
    if (updates.period) updatePayload.period = updates.period;
    if (updates.periodType) updatePayload.periodType = updates.periodType;
    if (updates.currency) updatePayload.currency = updates.currency;
    if (updates.unitScale) updatePayload.unitScale = updates.unitScale;

    // Resolve internal User id from auth UUID for reviewedBy FK
    const authId = req.user?.id;
    if (authId) {
      const { data: userRecord } = await supabase
        .from('User')
        .select('id')
        .eq('authId', authId)
        .single();
      if (userRecord) updatePayload.reviewedBy = userRecord.id;
    }

    const { data: updated, error: updateError } = await supabase
      .from('FinancialStatement')
      .update(updatePayload)
      .eq('id', statementId)
      .select()
      .single();

    if (updateError) throw updateError;

    // Refresh cache so deal headline stays in sync with the row just edited.
    await refreshDealCache(dealId);

    res.json(updated);
  } catch (err) {
    log.error('PATCH financials error', err);
    res.status(500).json({ error: 'Failed to update financial statement' });
  }
});

export default router;
