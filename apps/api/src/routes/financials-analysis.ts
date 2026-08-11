import { Router } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { analyzeFinancials } from '../services/analysis/index.js';
import {
  generateNarrativeInsights,
  computeAnalysisHash,
  getOrGenerateInsights,
  cacheInsights,
  invalidateCache,
} from '../services/narrativeInsights.js';
import {
  getIndustryBenchmarks,
  getPortfolioSummary,
  snapshotDealMetrics,
  updateIndustryMemory,
} from '../services/agentMemory.js';
import financialsMemoRouter from './financials-memo.js';

const router = Router();

// ─── Aggregate cap (Task 5.3.1) ───────────────────────────────
// These endpoints (analysis / insights / cross-doc) feed every row into
// math (analyzeFinancials, conflict detection) so paginating would silently
// produce wrong results. Instead we apply a defensive upper bound and log
// if a deal ever hits it. Per REMEDIATION_ROADMAP Phase 5 Task 5.3 option
// (1): "for endpoints whose semantics demand all rows, log the unbounded-
// ness as a known trade-off".
const AGGREGATE_CAP = 500;

// Mount benchmark + memo sub-router
router.use('/', financialsMemoRouter);

// ─── 5b2: GET /api/deals/:dealId/financials/analysis ─────────
// QoE flags + Financial Ratios computed from stored data

router.get('/deals/:dealId/financials/analysis', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    const { data: rows, error } = await supabase
      .from('FinancialStatement')
      .select('*')
      .eq('dealId', dealId)
      .eq('isActive', true)
      .order('period', { ascending: true })
      .range(0, AGGREGATE_CAP - 1);

    if (error) throw error;

    if (rows && rows.length === AGGREGATE_CAP) {
      log.warn('financials analysis hit row cap', { dealId, cap: AGGREGATE_CAP });
    }

    if (!rows || rows.length === 0) {
      return res.json({ hasData: false, qoe: null, ratios: [], periods: [] });
    }

    const analysis = await analyzeFinancials(dealId, rows);
    res.json({ hasData: true, ...analysis });
  } catch (err) {
    log.error('GET financials analysis error', err);
    res.status(500).json({ error: 'Failed to compute financial analysis' });
  }
});

// ─── AI Narrative Insights (AI + Agent Memory) ───────────────

router.get('/deals/:dealId/financials/insights', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    // Fetch financial rows (aggregate — see AGGREGATE_CAP note above)
    const { data: rows, error } = await supabase
      .from('FinancialStatement')
      .select('*')
      .eq('dealId', dealId)
      .eq('isActive', true)
      .order('period', { ascending: true })
      .range(0, AGGREGATE_CAP - 1);

    if (error) throw error;

    if (rows && rows.length === AGGREGATE_CAP) {
      log.warn('financials insights hit row cap', { dealId, cap: AGGREGATE_CAP });
    }

    if (!rows || rows.length === 0) {
      return res.json({ hasData: false, insights: null });
    }

    // Run analysis (pure math — fast)
    const analysis = await analyzeFinancials(dealId, rows);
    const analysisHash = computeAnalysisHash(analysis);

    // Fetch deal context (cheap; needed even on cache hit for downstream
    // memory snapshotting). We still call getOrGenerateInsights below which
    // checks the cache before any LLM call.
    const { data: deal } = await supabase
      .from('Deal')
      .select('name, industry, dealSize, revenue, ebitda')
      .eq('id', dealId)
      .single();

    // Fetch memory in parallel
    const [industryMem, portfolioMem] = await Promise.all([
      deal?.industry ? getIndustryBenchmarks(orgId, deal.industry) : Promise.resolve([]),
      getPortfolioSummary(orgId, dealId),
    ]);

    // Coordinated cache + dedup + generate. Concurrent requests for the
    // same (dealId, analysisHash) share a single LLM call.
    const { insights, fromCache } = await getOrGenerateInsights(
      dealId,
      orgId,
      analysisHash,
      analysis,
      {
        dealName: deal?.name,
        industry: deal?.industry,
        dealSize: deal?.dealSize,
        revenue: deal?.revenue,
        ebitda: deal?.ebitda,
      },
      { industry: industryMem, portfolio: portfolioMem },
    );

    // Fire-and-forget memory updates (only on a fresh generation — repeated
    // cache hits don't need to keep re-snapshotting the same metrics).
    if (!fromCache && deal?.industry) {
      const metrics: Record<string, number> = {};
      if (analysis.qoe?.score != null) metrics.qoe_score = analysis.qoe.score;
      if (analysis.revenueQuality?.revenueCAGR != null) metrics.revenue_cagr = analysis.revenueQuality.revenueCAGR;
      if (analysis.cashFlowAnalysis?.avgConversion != null) metrics.fcf_conversion = analysis.cashFlowAnalysis.avgConversion;
      if (analysis.debtCapacity?.currentLeverage != null) metrics.leverage = analysis.debtCapacity.currentLeverage;
      updateIndustryMemory(orgId, deal.industry, metrics).catch(() => {});
    }
    if (!fromCache) {
      snapshotDealMetrics(orgId, dealId, analysis, deal?.industry, deal?.revenue, deal?.ebitda).catch(() => {});
    }

    res.json({ hasData: true, insights, fromCache });
  } catch (err) {
    log.error('GET financials insights error', err);
    res.status(500).json({ error: 'Failed to generate insights' });
  }
});

router.post('/deals/:dealId/financials/insights/regenerate', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    // Invalidate cache
    await invalidateCache(dealId);

    // Fetch rows (aggregate — see AGGREGATE_CAP note above)
    const { data: rows, error } = await supabase
      .from('FinancialStatement')
      .select('*')
      .eq('dealId', dealId)
      .eq('isActive', true)
      .order('period', { ascending: true })
      .range(0, AGGREGATE_CAP - 1);

    if (error) throw error;

    if (rows && rows.length === AGGREGATE_CAP) {
      log.warn('financials regenerate hit row cap', { dealId, cap: AGGREGATE_CAP });
    }

    if (!rows || rows.length === 0) {
      return res.json({ hasData: false, insights: null });
    }

    const analysis = await analyzeFinancials(dealId, rows);
    const analysisHash = computeAnalysisHash(analysis);

    const { data: deal } = await supabase
      .from('Deal')
      .select('name, industry, dealSize, revenue, ebitda')
      .eq('id', dealId)
      .single();

    const [industryMem, portfolioMem] = await Promise.all([
      deal?.industry ? getIndustryBenchmarks(orgId, deal.industry) : Promise.resolve([]),
      getPortfolioSummary(orgId, dealId),
    ]);

    const insights = await generateNarrativeInsights(
      analysis,
      {
        dealName: deal?.name,
        industry: deal?.industry,
        dealSize: deal?.dealSize,
        revenue: deal?.revenue,
        ebitda: deal?.ebitda,
      },
      { industry: industryMem, portfolio: portfolioMem },
    );

    cacheInsights(dealId, orgId, analysisHash, insights).catch(() => {});

    res.json({ hasData: true, insights, fromCache: false });
  } catch (err) {
    log.error('POST financials insights regenerate error', err);
    res.status(500).json({ error: 'Failed to regenerate insights' });
  }
});

// ─── Phase 4: Cross-Document Verification ────────────────────

router.get('/deals/:dealId/financials/cross-doc', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    // Get rows (including inactive) to compare across documents. Aggregate
    // endpoint — needs all rows to detect conflicts. Defensive cap of
    // AGGREGATE_CAP applied; log if hit (a deal with >500 statement rows
    // including inactive duplicates is pathological).
    const { data: allRows, error } = await supabase
      .from('FinancialStatement')
      .select('*, Document(id, name)')
      .eq('dealId', dealId)
      .order('period', { ascending: true })
      .range(0, AGGREGATE_CAP - 1);

    if (error) throw error;

    if (allRows && allRows.length === AGGREGATE_CAP) {
      log.warn('financials cross-doc hit row cap', { dealId, cap: AGGREGATE_CAP });
    }

    if (!allRows || allRows.length === 0) {
      return res.json({ hasData: false, conflicts: [], documents: [] });
    }

    // Group by (statementType, period) to find discrepancies across documents
    const groups = new Map<string, typeof allRows>();
    for (const row of allRows) {
      const key = `${row.statementType}|${row.period}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    const conflicts: {
      statementType: string;
      period: string;
      field: string;
      values: { documentName: string; value: number | null; isActive: boolean; unitScale?: string | null }[];
      discrepancyPct: number;
    }[] = [];

    const keyFields = ['revenue', 'ebitda', 'net_income', 'total_assets', 'total_equity', 'operating_cf'];

    // Normalise extracted values to a common scale (MILLIONS) before
    // comparing them across documents. Without this, two docs that report
    // the same revenue at different unitScales (e.g. one in ACTUALS, one
    // in MILLIONS) get flagged as a 1,000,000× discrepancy when in fact
    // the figures agree. This was the source of the "Cross-Document
    // Verification flagging tons of false conflicts" bug.
    const toMillions = (val: number | null, unit: string | null | undefined): number | null => {
      if (val == null) return null;
      switch ((unit || 'MILLIONS').toUpperCase()) {
        case 'BILLIONS':  return val * 1000;
        case 'MILLIONS':  return val;
        case 'THOUSANDS': return val / 1000;
        case 'ACTUALS':   return val / 1_000_000;
        default:          return val;
      }
    };

    for (const [key, rows] of groups) {
      if (rows.length < 2) continue;
      const [statementType, period] = key.split('|');

      for (const field of keyFields) {
        const values = rows
          .map(r => {
            const raw = (r.lineItems as Record<string, number | null>)?.[field] ?? null;
            const unit = (r as any).unitScale ?? 'MILLIONS';
            return {
              documentName: (r as any).Document?.name ?? 'Unknown',
              // Display value: the original (so the UI can show
              // "$53,700K" vs "$53.7M" with the source's own scale).
              value: raw,
              unitScale: unit,
              // Comparison value: rebased to millions.
              _normalized: toMillions(raw, unit),
              isActive: r.isActive,
            };
          })
          .filter(v => v.value != null && v._normalized != null);

        if (values.length < 2) continue;

        const nums = values.map(v => v._normalized!);
        const maxVal = Math.max(...nums.map(Math.abs));
        const spread = Math.max(...nums) - Math.min(...nums);
        const discrepancyPct = maxVal > 0 ? (spread / maxVal) * 100 : 0;

        if (discrepancyPct > 2) {
          // Strip the internal _normalized helper from the wire payload
          const cleanedValues = values.map(({ _normalized: _omit, ...rest }) => rest);
          conflicts.push({ statementType, period, field, values: cleanedValues, discrepancyPct: Math.round(discrepancyPct * 10) / 10 });
        }
      }
    }

    // Unique documents
    const documents = [...new Set(allRows.map(r => (r as any).Document?.name).filter(Boolean))];

    res.json({
      hasData: true,
      conflicts: conflicts.sort((a, b) => b.discrepancyPct - a.discrepancyPct),
      documents,
      totalComparisons: groups.size,
    });
  } catch (err) {
    log.error('GET cross-doc error', err);
    res.status(500).json({ error: 'Failed to run cross-document verification' });
  }
});

export default router;
