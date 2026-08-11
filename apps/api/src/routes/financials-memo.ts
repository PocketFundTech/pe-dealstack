import { Router } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { analyzeFinancials } from '../services/analysis/index.js';

const router = Router();

// ─── Aggregate cap (Task 5.3.2) ───────────────────────────────
// Memo generation and benchmarking need all rows for analyzeFinancials /
// peer percentile math; pagination would skew results. Defensive cap of
// 500 rows with log.warn on hit. Peer-deal loop has its own .slice(0, 50)
// cap on number-of-peer-deals which is separate from this row cap.
const AGGREGATE_CAP = 500;
const PEER_DEAL_CAP = 50;

// ─── Phase 5: Portfolio Benchmarking ─────────────────────────

router.get('/deals/:dealId/financials/benchmark', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    // Get this deal's latest financials
    const { data: dealRows } = await supabase
      .from('FinancialStatement')
      .select('*')
      .eq('dealId', dealId)
      .eq('isActive', true)
      .eq('statementType', 'INCOME_STATEMENT')
      .eq('periodType', 'HISTORICAL')
      .order('period', { ascending: false })
      .limit(1);

    if (!dealRows || dealRows.length === 0) {
      return res.json({ hasData: false });
    }

    // Normalise stored values to MILLIONS so the deal vs peer comparison
    // is apples-to-apples regardless of the source-document scale.
    // unitScale was previously assumed MILLIONS — now it's whatever the
    // extractor saw on the source (ACTUALS for raw $ figures, THOUSANDS
    // for tables in '000s, BILLIONS for $B, etc).
    const toMillions = (val: number | null | undefined, unit: string | null | undefined): number | null => {
      if (val == null) return null;
      switch ((unit || 'MILLIONS').toUpperCase()) {
        case 'BILLIONS':  return val * 1000;
        case 'MILLIONS':  return val;
        case 'THOUSANDS': return val / 1000;
        case 'ACTUALS':   return val / 1_000_000;
        default:          return val;
      }
    };

    const dealLi = dealRows[0].lineItems as Record<string, number | null>;
    const dealUnit = (dealRows[0] as any).unitScale ?? 'MILLIONS';
    const dealRev = toMillions(dealLi.revenue, dealUnit);
    const dealEbitda = toMillions(dealLi.ebitda, dealUnit);
    const dealMargin = dealRev && dealEbitda && dealRev > 0 ? (dealEbitda / dealRev) * 100 : null;
    const dealGP = toMillions(dealLi.gross_profit, dealUnit);
    const dealGrossMargin = dealGP && dealRev && dealRev > 0
      ? (dealGP / dealRev) * 100 : null;

    // Get peer deals in the org. Push the cap down to the DB (instead of
    // fetching all and slicing in-app) so a tenant with thousands of deals
    // doesn't pull the full Deal table into memory just to slice the first
    // 50 off. Matches the existing .slice(0, 50) semantics below.
    const { data: allDeals } = await supabase
      .from('Deal')
      .select('id, name')
      .eq('organizationId', orgId)
      .neq('id', dealId)
      .limit(PEER_DEAL_CAP);

    if (!allDeals || allDeals.length === 0) {
      return res.json({ hasData: true, peerCount: 0, benchmarks: [] });
    }

    const peerMetrics: { revenue: number; ebitdaMargin: number; grossMargin: number | null }[] = [];

    // Fetch latest IS for each peer deal
    for (const peer of allDeals.slice(0, PEER_DEAL_CAP)) {
      const { data: peerRows } = await supabase
        .from('FinancialStatement')
        .select('lineItems, unitScale')
        .eq('dealId', peer.id)
        .eq('isActive', true)
        .eq('statementType', 'INCOME_STATEMENT')
        .eq('periodType', 'HISTORICAL')
        .order('period', { ascending: false })
        .limit(1);

      if (peerRows && peerRows.length > 0) {
        const pli = peerRows[0].lineItems as Record<string, number | null>;
        const pUnit = (peerRows[0] as any).unitScale ?? 'MILLIONS';
        const pRev = toMillions(pli.revenue, pUnit);
        const pEbitda = toMillions(pli.ebitda, pUnit);
        const pGP = toMillions(pli.gross_profit, pUnit);
        if (pRev && pEbitda && pRev > 0) {
          peerMetrics.push({
            revenue: pRev,
            ebitdaMargin: (pEbitda / pRev) * 100,
            grossMargin: pGP && pRev > 0 ? (pGP / pRev) * 100 : null,
          });
        }
      }
    }

    // Compute percentile ranks
    function percentileRank(values: number[], target: number): number {
      const sorted = [...values].sort((a, b) => a - b);
      const below = sorted.filter(v => v < target).length;
      return Math.round((below / sorted.length) * 100);
    }

    const benchmarks: {
      metric: string;
      dealValue: number | null;
      percentile: number | null;
      peerMedian: number | null;
      peerMin: number | null;
      peerMax: number | null;
      unit: string;
    }[] = [];

    if (peerMetrics.length > 0) {
      const revs = peerMetrics.map(p => p.revenue);
      const margins = peerMetrics.map(p => p.ebitdaMargin);
      const grossMargins = peerMetrics.map(p => p.grossMargin).filter((v): v is number => v != null);

      const median = (arr: number[]) => {
        const s = [...arr].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
      };
      const r2 = (v: number | null) => v != null ? Math.round(v * 100) / 100 : null;

      if (dealRev != null) {
        benchmarks.push({
          metric: 'Revenue',
          dealValue: r2(dealRev),
          percentile: percentileRank(revs, dealRev),
          peerMedian: r2(median(revs)),
          peerMin: r2(Math.min(...revs)),
          peerMax: r2(Math.max(...revs)),
          unit: '$M',
        });
      }

      if (dealMargin != null) {
        benchmarks.push({
          metric: 'EBITDA Margin',
          dealValue: r2(dealMargin),
          percentile: percentileRank(margins, dealMargin),
          peerMedian: r2(median(margins)),
          peerMin: r2(Math.min(...margins)),
          peerMax: r2(Math.max(...margins)),
          unit: '%',
        });
      }

      if (dealGrossMargin != null && grossMargins.length > 0) {
        benchmarks.push({
          metric: 'Gross Margin',
          dealValue: r2(dealGrossMargin),
          percentile: percentileRank(grossMargins, dealGrossMargin),
          peerMedian: r2(median(grossMargins)),
          peerMin: r2(Math.min(...grossMargins)),
          peerMax: r2(Math.max(...grossMargins)),
          unit: '%',
        });
      }
    }

    res.json({
      hasData: true,
      peerCount: peerMetrics.length,
      benchmarks,
    });
  } catch (err) {
    log.error('GET benchmark error', err);
    res.status(500).json({ error: 'Failed to compute benchmarks' });
  }
});

// ─── Phase 6: Investment Memo Auto-Draft ─────────────────────

router.get('/deals/:dealId/financials/memo', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    // Fetch deal info
    const { data: deal } = await supabase
      .from('Deal')
      .select('*, Company(name, industry, description)')
      .eq('id', dealId)
      .single();

    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    // Fetch financials (aggregate — feeds analyzeFinancials; cap at
    // AGGREGATE_CAP with log.warn on hit per Task 5.3.2)
    const { data: rows } = await supabase
      .from('FinancialStatement')
      .select('*')
      .eq('dealId', dealId)
      .eq('isActive', true)
      .order('period', { ascending: true })
      .range(0, AGGREGATE_CAP - 1);

    if (rows && rows.length === AGGREGATE_CAP) {
      log.warn('financials memo hit row cap', { dealId, cap: AGGREGATE_CAP });
    }

    // Fetch analysis
    let analysis = null;
    if (rows && rows.length > 0) {
      analysis = await analyzeFinancials(dealId, rows);
    }

    // Build memo sections
    const company = (deal as any).Company;
    const sections: { title: string; content: string; icon: string }[] = [];

    // 1. Executive Summary
    sections.push({
      title: 'Executive Summary',
      icon: 'summarize',
      content: `${company?.name || deal.name || 'Target Company'} is a ${company?.industry || 'N/A'} company. ${company?.description || ''} ${deal.dealSize ? `The proposed transaction size is $${deal.dealSize}M.` : ''}`,
    });

    // 2. Financial Overview
    if (analysis) {
      const latestP = analysis.periods[analysis.periods.length - 1];
      const isData = rows?.filter(r => r.statementType === 'INCOME_STATEMENT' && r.period === latestP);
      if (isData && isData.length > 0) {
        const li = isData[0].lineItems as Record<string, number | null>;
        sections.push({
          title: 'Financial Summary',
          icon: 'table_chart',
          content: `Latest period (${latestP}): Revenue $${li.revenue ?? 'N/A'}M, EBITDA $${li.ebitda ?? 'N/A'}M, Net Income $${li.net_income ?? 'N/A'}M. ${analysis.revenueQuality ? `Revenue CAGR: ${analysis.revenueQuality.revenueCAGR}%.` : ''} ${analysis.cashFlowAnalysis ? `Average EBITDA-to-FCF conversion: ${analysis.cashFlowAnalysis.avgConversion}%.` : ''}`,
        });
      }
    }

    // 3. Quality of Earnings
    if (analysis?.qoe) {
      const critical = analysis.qoe.flags.filter(f => f.severity === 'critical');
      const positive = analysis.qoe.flags.filter(f => f.severity === 'positive');
      sections.push({
        title: 'Quality of Earnings',
        icon: 'verified',
        content: `QoE Score: ${analysis.qoe.score}/100. ${analysis.qoe.summary} ${critical.length > 0 ? `\n\nCritical concerns: ${critical.map(f => f.title).join(', ')}.` : ''} ${positive.length > 0 ? `\n\nStrengths: ${positive.map(f => f.title).join(', ')}.` : ''}`,
      });
    }

    // 4. Key Risks
    if (analysis?.redFlags && analysis.redFlags.length > 0) {
      sections.push({
        title: 'Key Risks',
        icon: 'flag',
        content: analysis.redFlags.map(f => `• [${f.severity.toUpperCase()}] ${f.title}: ${f.detail}`).join('\n'),
      });
    }

    // 5. Debt Capacity
    if (analysis?.debtCapacity) {
      const dc = analysis.debtCapacity;
      sections.push({
        title: 'Debt Capacity & Financing',
        icon: 'account_balance',
        content: `Current leverage: ${dc.currentLeverage}x Net Debt/EBITDA. Maximum senior debt capacity at 4x: $${dc.maxDebt4x}M. DSCR: ${dc.dscr}x. Debt headroom: $${dc.debtHeadroom}M.`,
      });
    }

    // 6. LBO Assessment
    if (analysis?.lboScreen) {
      const lbo = analysis.lboScreen;
      const bestScenario = lbo.scenarios.reduce((best, s) =>
        (s.irr ?? 0) > (best.irr ?? 0) ? s : best, lbo.scenarios[0]);
      sections.push({
        title: 'LBO Assessment',
        icon: 'rocket_launch',
        content: `${lbo.passesScreen ? 'Deal passes LBO screen.' : 'Deal below typical LBO return thresholds.'} Best-case scenario: Entry at ${bestScenario.entryMultiple}x, Exit at ${bestScenario.exitMultiple}x → ${bestScenario.moic}x MOIC / ${bestScenario.irr}% IRR over 5 years. Equity required: $${bestScenario.equityRequired}M.`,
      });
    }

    // 7. Recommendation placeholder
    sections.push({
      title: 'Recommendation',
      icon: 'recommend',
      content: analysis?.qoe && analysis.qoe.score >= 70
        ? 'Based on the financial analysis, this deal warrants further due diligence. The quality of earnings profile is generally supportive of the investment thesis. Key areas for focused diligence have been flagged above.'
        : 'Based on the financial analysis, several concerns have been identified that require thorough investigation before proceeding. Recommend focused diligence on flagged risk areas before advancing to LOI stage.',
    });

    res.json({
      dealName: company?.name || deal.name,
      generatedAt: new Date().toISOString(),
      sections,
      periodsCovered: analysis?.periods || [],
      qoeScore: analysis?.qoe?.score || null,
    });
  } catch (err) {
    log.error('GET memo error', err);
    res.status(500).json({ error: 'Failed to generate investment memo' });
  }
});

export default router;
