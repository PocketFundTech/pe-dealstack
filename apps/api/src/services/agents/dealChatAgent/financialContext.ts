// ─── Deal chat financial context ─────────────────────────────────────
// Two renderings of a deal's extracted FinancialStatement rows:
//
//  * buildFinancialSummary — what goes into EVERY chat request: the latest
//    three fiscal years of revenue / EBITDA / margin / growth (~400 tokens)
//    plus a list of what else exists. AI cost plan A1: the chat used to send
//    every statement, period and line item on every message and every tool
//    step (7–13K tokens on real deals, up to 77 periods).
//  * buildFinancialMarkdown — the full line-item tables, now returned by the
//    get_deal_financials tool only when the question needs them.

import { parsePeriod, isFullYear, periodOrdinal } from '@ai-crm/shared';
import { correctMistaggedUnitScale, formatFinancialValue } from '../../../utils/financialFormat.js';

export interface FinancialRow {
  statementType: string;
  period: string;
  lineItems: Record<string, number | null> | null;
  unitScale?: string | null;
  currency?: string | null;
}

const STATEMENT_LABELS: Record<string, string> = {
  INCOME_STATEMENT: 'Income Statement',
  BALANCE_SHEET: 'Balance Sheet',
  CASH_FLOW: 'Cash Flow Statement',
};

/** Line items as a plain record, or null for rows without any. */
function itemsOf(row: FinancialRow): Record<string, number | null> | null {
  return row.lineItems && typeof row.lineItems === 'object' ? row.lineItems : null;
}

/** First numeric value whose key is `exact`, else whose key passes `match`. */
function pick(
  items: Record<string, number | null>,
  exact: string,
  match: (key: string) => boolean,
): number | null {
  const direct = items[exact];
  if (typeof direct === 'number') return direct;
  for (const [key, value] of Object.entries(items)) {
    if (typeof value === 'number' && match(key.toLowerCase())) return value;
  }
  return null;
}

const revenueOf = (items: Record<string, number | null>) =>
  pick(items, 'revenue', (k) => (k.includes('revenue') || k.includes('net sales')) && !k.includes('growth') && !k.includes('%'));
const ebitdaOf = (items: Record<string, number | null>) =>
  pick(items, 'ebitda', (k) => k.includes('ebitda') && !k.includes('margin') && !k.includes('%'));

/**
 * Compact financial context for every chat request: latest three fiscal
 * years of the income statement (actuals before projections), then a one-line
 * index of every statement on file so the model knows what it can fetch.
 */
export function buildFinancialSummary(statements: FinancialRow[]): string {
  const rows = statements.filter((s) => itemsOf(s));
  if (!rows.length) {
    return '\n=== FINANCIAL DATA ===\nNo extracted financial data available yet. Use the get_deal_financials tool or ask the user to upload financial documents.';
  }

  const lines: string[] = ['\n=== FINANCIAL SUMMARY (verified extracted data — source of truth) ==='];

  const income = rows.filter((s) => s.statementType === 'INCOME_STATEMENT');
  const annual = income
    .map((s) => ({ row: s, period: parsePeriod(s.period) }))
    .filter((x) => isFullYear(x.period))
    .sort((a, b) => (periodOrdinal(a.row.period) ?? 0) - (periodOrdinal(b.row.period) ?? 0));
  // Prefer the latest three actual years; fall back to whatever periods exist.
  const latest = annual.slice(-3).map((x) => x.row);
  const shown = latest.length
    ? latest
    : [...income].sort((a, b) => (periodOrdinal(a.period) ?? 0) - (periodOrdinal(b.period) ?? 0)).slice(-3);

  if (shown.length) {
    lines.push(`Income statement, ${latest.length ? 'latest fiscal years' : 'latest periods'}:`);
    let prevRevenue: number | null = null;
    for (const row of shown) {
      const items = itemsOf(row)!;
      const scale = correctMistaggedUnitScale(row.unitScale ?? 'ACTUALS', items);
      const fmt = (v: number) => formatFinancialValue(v, scale, { currency: row.currency ?? 'USD' });
      const revenue = revenueOf(items);
      const ebitda = ebitdaOf(items);
      const parts: string[] = [];
      if (revenue !== null) parts.push(`revenue ${fmt(revenue)}`);
      if (revenue !== null && prevRevenue) {
        parts.push(`growth ${(((revenue - prevRevenue) / Math.abs(prevRevenue)) * 100).toFixed(1)}%`);
      }
      if (ebitda !== null) parts.push(`EBITDA ${fmt(ebitda)}`);
      if (ebitda !== null && revenue) parts.push(`margin ${((ebitda / revenue) * 100).toFixed(1)}%`);
      lines.push(`- ${row.period}: ${parts.length ? parts.join(', ') : 'no revenue/EBITDA line'}`);
      prevRevenue = revenue;
    }
  }

  lines.push('Statements on file:');
  const byType = new Map<string, FinancialRow[]>();
  for (const s of rows) byType.set(s.statementType, [...(byType.get(s.statementType) ?? []), s]);
  for (const [type, list] of byType) {
    const sorted = [...list].sort((a, b) => (periodOrdinal(a.period) ?? 0) - (periodOrdinal(b.period) ?? 0));
    const range = sorted.length > 1 ? `${sorted[0].period} to ${sorted[sorted.length - 1].period}` : sorted[0].period;
    lines.push(`- ${STATEMENT_LABELS[type] ?? type}: ${list.length} period${list.length === 1 ? '' : 's'} (${range})`);
  }
  lines.push(
    'For line items (COGS, opex, D&A, working capital…), other periods, the balance sheet or cash flow, call get_deal_financials with statementType and/or periods. Never estimate a number you have not fetched.',
  );

  return lines.join('\n');
}

/**
 * Full Markdown tables, periods as columns, grouped by statement type and
 * labelled with each statement's unit scale and currency.
 */
export function buildFinancialMarkdown(statements: FinancialRow[]): string {
  if (!statements.length) {
    return '\n=== VERIFIED FINANCIAL DATA ===\nNo extracted financial data available yet. Use get_deal_financials tool or ask the user to upload financial documents.';
  }

  // Group by statement type. Track the unit scale + currency of each
  // statement so the agent prompt tells the LLM what scale the numbers
  // are stored in (formerly hard-coded as "$M USD" — wrong when the
  // source was in actuals / thousands / billions).
  //
  // Default unitScale is ACTUALS (matches `normalizeUnitScale` in
  // financialClassifier.ts — the safest fallback because it means "do
  // not multiply"). Defaulting to MILLIONS would silently inflate values
  // 1,000,000× whenever a row was inserted without a unitScale set.
  const grouped: Record<string, { period: string; data: Record<string, number | null>; unitScale: string; currency: string }[]> = {};
  for (const stmt of statements) {
    if (!stmt.lineItems) continue;
    const data = stmt.lineItems as Record<string, number | null>;
    if (!grouped[stmt.statementType]) grouped[stmt.statementType] = [];
    grouped[stmt.statementType].push({
      period: stmt.period,
      data,
      unitScale: (stmt.unitScale ?? 'ACTUALS').toUpperCase(),
      currency: stmt.currency ?? 'USD',
    });
  }

  // Header reflects the actual scales present rather than assuming MILLIONS.
  // Spell out the multiplier so the LLM can convert correctly when echoing
  // values to the user — e.g. "ACTUALS USD (raw dollars)" makes it unambiguous
  // that "6900" means $6,900, not $6,900M.
  const scaleGloss = (label: string): string => {
    switch (label.split(' ')[0]) {
      case 'ACTUALS':  return ' (raw dollars — multiply by 1)';
      case 'THOUSANDS': return ' (each unit = 1,000)';
      case 'MILLIONS':  return ' (each unit = 1,000,000)';
      case 'BILLIONS':  return ' (each unit = 1,000,000,000)';
      default:          return '';
    }
  };
  const allScales = new Set<string>();
  for (const entries of Object.values(grouped)) {
    for (const e of entries) allScales.add(`${e.unitScale} ${e.currency}`);
  }
  const scaleHeader = allScales.size === 1
    ? [...allScales][0] + scaleGloss([...allScales][0])
    : 'mixed scales — see per-statement labels below';
  const sections: string[] = [`\n=== VERIFIED FINANCIAL DATA (Source of Truth — values in ${scaleHeader}) ===`];

  for (const [type, entries] of Object.entries(grouped)) {
    const label = STATEMENT_LABELS[type] || type;
    const periods = entries.map(e => e.period);

    // Per-statement scale label (covers the multi-statement case where one
    // statement is in MILLIONS but another came from a doc in ACTUALS).
    const stmtScales = new Set(entries.map(e => `${e.unitScale} ${e.currency}`));
    const stmtScaleSuffix = stmtScales.size === 1
      ? ` (values in ${[...stmtScales][0]}${scaleGloss([...stmtScales][0])})`
      : '';

    // Collect all unique metric keys across periods (preserving insertion order)
    const metricKeys: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      for (const key of Object.keys(entry.data)) {
        if (!seen.has(key)) { seen.add(key); metricKeys.push(key); }
      }
    }

    if (!metricKeys.length) continue;

    // Build Markdown table
    const header = `| Metric | ${periods.join(' | ')} |`;
    const divider = `|--------|${periods.map(() => '-------').join('|')}|`;
    const rows = metricKeys.map(key => {
      const cells = entries.map(e => {
        const val = e.data[key];
        if (val === null || val === undefined) return '—';
        return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
      });
      return `| ${key} | ${cells.join(' | ')} |`;
    });

    sections.push(`\n### ${label}${stmtScaleSuffix}\n${header}\n${divider}\n${rows.join('\n')}`);
  }

  return sections.join('\n');
}
