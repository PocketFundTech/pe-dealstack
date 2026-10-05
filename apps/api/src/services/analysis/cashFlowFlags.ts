/**
 * Cash-flow red flags (fix plan F1, part 1).
 *
 * The SRM analyst found what the analysis missed: free cash flow negative in
 * both years, and equipment spending funded with loans. Both are plain
 * arithmetic on the (now sign-normalised, B4) cash flow statement:
 *
 *   FCF = fcf as reported, else operating_cf − |capex|
 *   debt-funded capex = FCF < 0 and new borrowing (proceeds lines, or the
 *     balance sheet's debt increase) covers at least half of the cash
 *     shortfall (capex − operating cash flow).
 *
 * Full fiscal years only (comparablePeriods) — a 9-month YTD isn't a year.
 */

import { PreparedData, QoEFlag, RedFlag } from './types.js';
import { li, round2, comparablePeriods } from './helpers.js';

// Inflows from new borrowing: "proceeds" + a debt word (new_debt_proceeds,
// proceeds_from_term_loans …), or the usual standalone names.
const DEBT_WORD_RE = /(debt|borrow|loan|notes?|credit|loc|revolver)/;
const DEBT_INFLOW_RE = /^((new_)?borrowings?|debt_(issued|issuance|drawdowns?)|issuance_of_debt\w*|new_debt|loans?_received)$/;
function isDebtInflowKey(k: string): boolean {
  if (k.endsWith('_source') || /repay|payment|principal/.test(k)) return false;
  return DEBT_INFLOW_RE.test(k) || (/proceeds/.test(k) && DEBT_WORD_RE.test(k));
}

// Capex as one line, or split (growth_capex + maintenance_capex +
// replacement_capex_capitalized on SRM).
const CAPEX_PART_RE = /(^|_)capex(_|$)|capital_expenditures?|purchases?_of_(property|equipment|ppe|fixed_assets)/;

type Items = Record<string, number | null>;

function capexOf(cf: Items): number | null {
  const c = li(cf, 'capex');
  if (c != null) return Math.abs(c);
  const parts = Object.entries(cf).filter(([k, v]) =>
    typeof v === 'number' && !k.endsWith('_source') && !k.endsWith('_pct') && CAPEX_PART_RE.test(k));
  return parts.length > 0 ? parts.reduce((sum, [, v]) => sum + Math.abs(v as number), 0) : null;
}

export function freeCashFlowOf(cf: Items): number | null {
  const reported = li(cf, 'fcf') ?? li(cf, 'free_cash_flow');
  if (reported != null) return reported;
  const ocf = li(cf, 'operating_cf') ?? li(cf, 'operating_cash_flow');
  const capex = capexOf(cf);
  return ocf != null && capex != null ? ocf - capex : null;
}

/** New borrowing in the period: proceeds lines on the cash flow, else the balance-sheet debt increase. */
export function newBorrowingOf(cf: Items, bal: Items | undefined, prevBal: Items | undefined): { amount: number; basis: string } | null {
  const proceeds = Object.entries(cf)
    .filter(([k, v]) => isDebtInflowKey(k) && typeof v === 'number' && v > 0)
    .reduce((sum, [, v]) => sum + (v as number), 0);
  if (proceeds > 0) return { amount: proceeds, basis: 'debt proceeds on the cash flow' };

  const debt = (b: Items | undefined) => {
    if (!b) return null;
    const st = li(b, 'short_term_debt');
    const lt = li(b, 'long_term_debt');
    if (st != null || lt != null) return (st ?? 0) + (lt ?? 0);
    return li(b, 'total_debt');
  };
  const now = debt(bal);
  const before = debt(prevBal);
  if (now != null && before != null && now > before) return { amount: now - before, basis: 'increase in balance-sheet debt' };
  return null;
}

interface PeriodCash { period: string; fcf: number | null; capex: number | null; borrowing: { amount: number; basis: string } | null }

function periodCash(data: PreparedData): PeriodCash[] {
  const years = comparablePeriods(data, 'cashflow');
  return years.map((p, i) => {
    const cf = data.cashflow.get(p) ?? {};
    return {
      period: p,
      fcf: freeCashFlowOf(cf),
      capex: capexOf(cf),
      borrowing: newBorrowingOf(cf, data.balance.get(p), i > 0 ? data.balance.get(years[i - 1]) : undefined),
    };
  });
}

const fmt = (v: number) => (v < 0 ? `−$${round2(-v)}M` : `$${round2(v)}M`);

export function computeCashFlowRedFlags(data: PreparedData): RedFlag[] {
  const flags: RedFlag[] = [];
  const rows = periodCash(data);

  const negative = rows.filter((r) => r.fcf != null && r.fcf < 0);
  if (negative.length > 0) {
    const all = negative.length === rows.filter((r) => r.fcf != null).length;
    flags.push({
      id: 'negative_free_cash_flow',
      severity: negative.length >= 2 ? 'critical' : 'warning',
      category: 'Cash Flow',
      title: negative.length >= 2 ? `Negative Free Cash Flow in ${negative.length} Years` : `Negative Free Cash Flow (${negative[0].period})`,
      detail: `Operating cash flow did not cover capital spending${all && negative.length > 1 ? ' in any year analysed' : ''}. The business consumed cash, so growth or distributions were funded from outside — check debt, owner funding and the capex plan.`,
      evidence: negative.map((r) => `${r.period}: FCF ${fmt(r.fcf!)}`).join(' · '),
      icon: 'money_off',
    });
  }

  const debtFunded = rows.filter((r) =>
    r.fcf != null && r.fcf < 0 && r.capex != null && r.capex > 0 && r.borrowing && r.borrowing.amount >= 0.5 * -r.fcf);
  if (debtFunded.length > 0) {
    flags.push({
      id: 'debt_funded_capex',
      severity: 'warning',
      category: 'Cash Flow',
      title: `Capex Funded with Debt (${debtFunded.map((r) => r.period).join(', ')})`,
      detail: 'Capital expenditure exceeded operating cash flow and new borrowing covered the gap. Leverage is rising to fund equipment — check what is maintenance vs growth capex and the debt the buyer would assume.',
      evidence: debtFunded
        .map((r) => `${r.period}: capex ${fmt(r.capex!)}, shortfall ${fmt(-r.fcf!)}, new borrowing ${fmt(r.borrowing!.amount)} (${r.borrowing!.basis})`)
        .join(' · '),
      icon: 'construction',
    });
  }
  return flags;
}

/** The same findings for the Quality of Earnings card, so they move the QoE score. */
export function computeCashFlowQoEFlags(data: PreparedData): QoEFlag[] {
  return computeCashFlowRedFlags(data).map((f) => ({
    id: f.id,
    severity: f.severity === 'info' ? 'info' : f.severity,
    category: 'Cash Quality',
    title: f.title,
    detail: f.detail,
    metric: f.evidence.split(' · ')[0]?.split(': ')[1],
    icon: f.icon,
  }));
}
