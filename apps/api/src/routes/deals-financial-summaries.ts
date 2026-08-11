// ─── Bulk financial-summary endpoint for the deals listing ─────────
// GET /api/deals/financial-summaries
//   ?dealIds=a,b,c   (optional) — limit to specific deals
//
// Returns the latest INCOME_STATEMENT row for every deal in the org,
// keyed by dealId. Lets the deals listing page format revenue / EBITDA
// with the correct unitScale + currency (instead of the legacy
// formatCurrency() helper which assumes MILLIONS and renders "$6.7K"
// data as "$6.7M"). Used by /deals (list view + kanban) so we don't
// have to do an N+1 fetch of /deals/:id/financials per card.
//
// One Supabase query, grouped by dealId in-memory; we pick the row with
// the chronologically-latest period using comparePeriodChronologically
// (preferring HISTORICAL/ACTUAL/LTM over PROJECTED, mirroring the
// per-deal /financials/summary endpoint).
//
// Mounted in deals.ts BEFORE the catch-all /:id route so the literal
// path matches first.
//
// IMPORTANT: keep this file under the 500-line cap. Logic that grows
// beyond per-deal-row reduction belongs in a service module.

import { Router } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';
import { comparePeriodChronologically } from '../utils/periodChrono.js';

const router = Router();

type UnitScale = 'MILLIONS' | 'THOUSANDS' | 'ACTUALS' | 'BILLIONS';

interface FinancialSummary {
  revenue: number | null;
  ebitda: number | null;
  ebitdaMargin: number | null;
  unitScale: UnitScale;
  currency: string;
  latestPeriod: string;
}

interface IncomeStatementRow {
  dealId: string;
  period: string | null;
  periodType: string | null;
  unitScale: UnitScale | null;
  currency: string | null;
  lineItems: Record<string, number | null> | null;
}

router.get('/financial-summaries', async (req, res) => {
  try {
    const orgId = getOrgId(req);

    // Optional ?dealIds=a,b,c filter — frontend can pass the visible
    // page's deals to keep the response small.
    const dealIdsParam =
      typeof req.query.dealIds === 'string' ? req.query.dealIds.trim() : '';
    const dealIds = dealIdsParam
      ? dealIdsParam.split(',').map((s) => s.trim()).filter(Boolean)
      : null;

    // Pull the org's deals first so we can scope by dealId. Foreign-key
    // joins via supabase-js .in('dealId', …) require a list anyway.
    let dealsQuery = supabase
      .from('Deal')
      .select('id')
      .eq('organizationId', orgId);

    if (dealIds && dealIds.length > 0) {
      dealsQuery = dealsQuery.in('id', dealIds);
    }

    const { data: deals, error: dealsErr } = await dealsQuery;
    if (dealsErr) throw dealsErr;
    if (!deals || deals.length === 0) {
      return res.json({ summaries: {} });
    }

    const orgDealIds = deals.map((d) => d.id as string);

    // Single bulk query: every active income statement for every deal
    // we care about. We group + reduce client-side because we want the
    // chronologically-latest period (not the latest extractedAt).
    const { data: rows, error: rowsErr } = await supabase
      .from('FinancialStatement')
      .select(
        'dealId, period, periodType, unitScale, currency, lineItems',
      )
      .in('dealId', orgDealIds)
      .eq('statementType', 'INCOME_STATEMENT')
      .eq('isActive', true);

    if (rowsErr) throw rowsErr;

    const summaries: Record<string, FinancialSummary> = {};
    if (!rows || rows.length === 0) {
      return res.json({ summaries });
    }

    // Group by dealId
    const byDeal = new Map<string, IncomeStatementRow[]>();
    for (const r of rows as IncomeStatementRow[]) {
      const list = byDeal.get(r.dealId) ?? [];
      list.push(r);
      byDeal.set(r.dealId, list);
    }

    for (const [dealId, dealRows] of byDeal.entries()) {
      // Prefer historical/LTM rows (skip projections); fall back to the
      // full set if the deal only has projected statements.
      const historical = dealRows.filter(
        (r) =>
          r.periodType === 'HISTORICAL' ||
          r.periodType === 'ACTUAL' ||
          r.periodType === 'LTM',
      );
      const candidates = historical.length > 0 ? historical : dealRows;

      // comparePeriodChronologically sorts ASC; reverse to get newest.
      const sortedDesc = [...candidates].sort((a, b) =>
        comparePeriodChronologically(b.period, a.period),
      );

      // Pick the latest period that actually carries the headline
      // line items. Without this, a deal whose most-recent period is
      // an unbacked PROJECTED row (or a stub with revenue/ebitda=null)
      // would show "—" on the cards even though earlier periods have
      // values — this matched the user-visible Website Speedy /
      // PromptStash bug. We require BOTH revenue and ebitda to be
      // present so the unitScale + currency stay consistent across
      // both numbers (so the implied margin always makes sense).
      const latestWithBoth = sortedDesc.find(
        (r) =>
          r.lineItems?.revenue != null && r.lineItems?.ebitda != null,
      );
      const latestWithRevenue = sortedDesc.find(
        (r) => r.lineItems?.revenue != null,
      );
      const latestWithEbitda = sortedDesc.find(
        (r) => r.lineItems?.ebitda != null,
      );
      const latest =
        latestWithBoth ??
        latestWithRevenue ??
        latestWithEbitda ??
        sortedDesc[0];
      if (!latest) continue;

      const li = latest.lineItems ?? {};
      const revenue = li.revenue ?? null;
      const ebitda = li.ebitda ?? null;

      // Margin: prefer the explicit ebitda_margin_pct line item when
      // present, else compute from revenue/ebitda (both in the same
      // unitScale, so the ratio is scale-free).
      let ebitdaMargin: number | null = null;
      if (
        revenue != null &&
        ebitda != null &&
        Number.isFinite(revenue) &&
        Number.isFinite(ebitda) &&
        revenue !== 0
      ) {
        ebitdaMargin = parseFloat(((ebitda / revenue) * 100).toFixed(1));
      } else if (li.ebitda_margin_pct != null) {
        ebitdaMargin = li.ebitda_margin_pct;
      }

      summaries[dealId] = {
        revenue,
        ebitda,
        ebitdaMargin,
        unitScale: (latest.unitScale ?? 'ACTUALS') as UnitScale,
        currency: latest.currency ?? 'USD',
        latestPeriod: latest.period ?? '',
      };
    }

    res.json({ summaries });
  } catch (err) {
    log.error('GET /api/deals/financial-summaries error', err);
    res
      .status(500)
      .json({ error: 'Failed to fetch financial summaries' });
  }
});

export default router;
