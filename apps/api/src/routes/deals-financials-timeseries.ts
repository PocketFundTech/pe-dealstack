// ─── /api/deals/:dealId/financials/timeseries router ──────────────
// Charting-friendly per-period income-statement view.
//
// The deal page's CustomGraph feature plots metrics across periods,
// but FinancialStatement.lineItems uses snake_case (revenue, cogs,
// gross_profit, total_opex, ebitda, net_income, ebitda_margin_pct,
// gross_margin_pct) with optional fields and inconsistent presence of
// derived values. This endpoint projects each active income-statement
// row into a typed FinancialRow with camelCase keys, computing derived
// fields (grossProfit, margins) when the absolutes are present but the
// derived value isn't.
//
// Mounted under /api/deals so the final URL is
//   GET /api/deals/:dealId/financials/timeseries
//
// Rows are sorted ascending by period via comparePeriodChronologically
// (the same helper used by the period-scope financials chart) so the
// chart's x-axis is monotone left-to-right.

import { Router } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { comparePeriodChronologically } from '../utils/periodChrono.js';

const router = Router();

// ============================================================
// Output schema
// ============================================================

interface FinancialRow {
  period: string;
  revenue?: number;
  cogs?: number;
  grossProfit?: number;
  opex?: number;
  ebitda?: number;
  netIncome?: number;
  grossMargin?: number;
  ebitdaMargin?: number;
  netMargin?: number;
}

// ============================================================
// Helpers
// ============================================================

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function round1(value: number): number {
  return parseFloat(value.toFixed(1));
}

/**
 * Project a single FinancialStatement.lineItems blob into the
 * camelCased FinancialRow shape, computing derived fields where
 * possible. Only emits keys whose value is a finite number.
 */
function projectRow(
  period: string,
  lineItems: Record<string, unknown> | null,
): FinancialRow {
  const li = lineItems ?? {};
  const out: FinancialRow = { period };

  // ── Absolutes ──────────────────────────────────────────────
  const revenue = num(li.revenue);
  const cogs = num(li.cogs);
  // Accept either snake_case (canonical for FinancialStatement) or the
  // legacy camelCase key in case any older row carries it.
  let grossProfit = num(li.gross_profit) ?? num(li.grossProfit);
  // Opex in canonical schema is total_opex; fall back to opex/operating_expenses.
  const opex =
    num(li.total_opex) ?? num(li.opex) ?? num(li.operating_expenses);
  const ebitda = num(li.ebitda);
  const netIncome = num(li.net_income) ?? num(li.netIncome);

  // Derive grossProfit from revenue - cogs if not present
  if (grossProfit === undefined && revenue !== undefined && cogs !== undefined) {
    grossProfit = revenue - cogs;
  }

  if (revenue !== undefined) out.revenue = round1(revenue);
  if (cogs !== undefined) out.cogs = round1(cogs);
  if (grossProfit !== undefined) out.grossProfit = round1(grossProfit);
  if (opex !== undefined) out.opex = round1(opex);
  if (ebitda !== undefined) out.ebitda = round1(ebitda);
  if (netIncome !== undefined) out.netIncome = round1(netIncome);

  // ── Percents ───────────────────────────────────────────────
  // Prefer explicit *_margin_pct fields when present (the extractor
  // sometimes captures these directly without enough info to recompute
  // them client-side). Otherwise compute from the absolutes — revenue,
  // grossProfit, ebitda, netIncome are in the same unitScale so the
  // ratio is scale-free.
  const explicitGrossMarginPct =
    num(li.gross_margin_pct) ?? num(li.grossMarginPct);
  const explicitEbitdaMarginPct =
    num(li.ebitda_margin_pct) ?? num(li.ebitdaMarginPct);
  const explicitNetMarginPct =
    num(li.net_margin_pct) ?? num(li.netMarginPct);

  if (explicitGrossMarginPct !== undefined) {
    out.grossMargin = round1(explicitGrossMarginPct);
  } else if (
    revenue !== undefined &&
    grossProfit !== undefined &&
    revenue !== 0
  ) {
    out.grossMargin = round1((grossProfit / revenue) * 100);
  }

  if (explicitEbitdaMarginPct !== undefined) {
    out.ebitdaMargin = round1(explicitEbitdaMarginPct);
  } else if (
    revenue !== undefined &&
    ebitda !== undefined &&
    revenue !== 0
  ) {
    out.ebitdaMargin = round1((ebitda / revenue) * 100);
  }

  if (explicitNetMarginPct !== undefined) {
    out.netMargin = round1(explicitNetMarginPct);
  } else if (
    revenue !== undefined &&
    netIncome !== undefined &&
    revenue !== 0
  ) {
    out.netMargin = round1((netIncome / revenue) * 100);
  }

  return out;
}

// ============================================================
// GET /:dealId/financials/timeseries
// ============================================================

router.get('/:dealId/financials/timeseries', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { dealId } = req.params;

    const deal = await verifyDealAccess(dealId, orgId);
    if (!deal) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const { data, error } = await supabase
      .from('FinancialStatement')
      .select('period, lineItems')
      .eq('dealId', dealId)
      .eq('statementType', 'INCOME_STATEMENT')
      .eq('isActive', true);

    if (error) {
      // Missing table — return empty list rather than 500 so the chart
      // renders its empty state cleanly (mirrors the graphs router
      // pattern).
      if (error.code === '42P01' || error.code === 'PGRST205') {
        return res.json([]);
      }
      throw error;
    }

    const rows = (data ?? [])
      .filter((r): r is { period: string; lineItems: Record<string, unknown> | null } =>
        typeof r.period === 'string' && r.period.length > 0,
      )
      .map((r) => projectRow(r.period, r.lineItems))
      .sort((a, b) => comparePeriodChronologically(a.period, b.period));

    res.json(rows);
  } catch (err) {
    log.error('GET /api/deals/:dealId/financials/timeseries error', err);
    res.status(500).json({ error: 'Failed to fetch financials timeseries' });
  }
});

export default router;
