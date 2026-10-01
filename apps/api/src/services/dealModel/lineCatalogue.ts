// ─── Deal model — P&L line catalogue (fix plan E1) ────────────────
// The model used to carry six fixed figures (revenue, COGS, GP, EBITDA,
// D&A, net income) — "it's only using the main figures" (analyst feedback
// on the SRM deal). Now every income-statement line the deal has becomes a
// model line:
//
//   - the standard vocabulary (revenue … net income, other income/expense);
//   - each raw account the extractor filed under a parent (#164 keys are
//     `<parent>_<label>`: cogs_cement, cogs_fly_ash, revenue_discounts …),
//     nested under that parent, which becomes the SUM of its accounts;
//   - an "Other (unallocated)" line per parent whose accounts don't add up
//     to the reported total, so the parent still ties to the statement.
//
// Gaps are filled where the statement implies them (COGS = revenue − GP,
// operating costs = GP − EBITDA, D&A = EBITDA − EBIT) so EBITDA can be a
// formula on both Historicals and Projections. Implied figures are flagged.
//
// Pure and deterministic: the route, deriveDefaults and the workbook all
// rebuild the same catalogue from the same history.

import type { ModelLine } from '@ai-crm/shared';
import type { HistoricalRow } from './assumptions.js';
import { selectBasePeriod, type BasePeriod } from './basePeriod.js';

/** Standard keys a raw account can nest under (income statement subset of LINE_ITEM_PARENTS). */
const IS_PARENTS = [
  'revenue', 'cogs', 'sga', 'rd', 'other_opex', 'total_opex', 'da',
  'interest_expense', 'other_income', 'other_expense', 'tax',
] as const;

const STANDARD_KEYS = new Set<string>([
  'revenue', 'cogs', 'gross_profit', 'sga', 'rd', 'other_opex', 'total_opex', 'ebitda', 'da', 'ebit',
  'interest_expense', 'other_income', 'other_expense', 'ebt', 'tax', 'net_income',
]);

/** Ratios, memo lines and provenance — never model lines. */
const NON_LINE_RE = /(_pct|_ratio|_multiple|_margin|_source|_label|_order)$|^(sde|gross_margin_pct|ebitda_margin_pct)$/;

/** Old / alternative keys still found on stored rows. */
const ALIASES: Record<string, string> = {
  depreciation_amortization: 'da', d_and_a: 'da', depreciation: 'da',
  tax_expense: 'tax', opex: 'total_opex', operating_expenses: 'total_opex',
  grossProfit: 'gross_profit', netIncome: 'net_income', operating_income: 'ebit',
};

const OPEX_SUBLINES = ['sga', 'rd', 'other_opex'] as const;

export const REMAINDER_SUFFIX = '__other';
const EPS = 0.0005;

const LABELS: Record<string, string> = {
  revenue: 'Revenue', cogs: 'COGS', gross_profit: 'Gross profit', sga: 'SG&A', rd: 'R&D',
  other_opex: 'Other operating expenses', total_opex: 'Operating expenses', ebitda: 'EBITDA',
  da: 'D&A', ebit: 'EBIT', interest_expense: 'Interest expense', other_income: 'Other income',
  other_expense: 'Other expense', ebt: 'EBT', tax: 'Tax', net_income: 'Net income',
};
const ACRONYMS = new Set(['cos', 'cogs', 'sga', 'ppe', 'hr', 'it', 'gst', 'vat', 'llc', 'ltd']);

function childLabel(key: string, parent: string): string {
  if (key === `${parent}${REMAINDER_SUFFIX}`) return 'Other (unallocated)';
  const words = key.slice(parent.length + 1).split('_').filter(Boolean);
  const text = words.map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A row's line values — `lines` when present, else the legacy fixed fields. */
export function rowLines(r: HistoricalRow): Record<string, number> {
  const out: Record<string, number> = {};
  const src: Record<string, unknown> = r.lines ?? {
    revenue: r.revenue, cogs: r.cogs, gross_profit: r.grossProfit, total_opex: r.opex,
    ebitda: r.ebitda, net_income: r.netIncome, da: r.da,
  };
  for (const [rawKey, v] of Object.entries(src)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || NON_LINE_RE.test(rawKey)) continue;
    const key = ALIASES[rawKey] ?? rawKey;
    if (out[key] === undefined || key === rawKey) out[key] = v;
  }
  return out;
}

function parentOf(key: string): string | null {
  if (STANDARD_KEYS.has(key)) return null;
  let best: string | null = null;
  for (const p of IS_PARENTS) {
    if (key.startsWith(`${p}_`) && (!best || p.length > best.length)) best = p;
  }
  return best;
}

export interface PeriodValues {
  values: Record<string, number>;
  /** Keys whose figure was implied rather than printed. */
  implied: string[];
}

export interface LineCatalogue {
  lines: ModelLine[];
  /** Aligned with the history rows, implied gaps filled. */
  periods: PeriodValues[];
  /** Accounts with no recognisable parent — absorbed by "Other (unallocated)". */
  unclassified: string[];
  /** How accounts roll up — reused to fill a synthesised (LTM) base period. */
  structure: Structure;
  included: Set<string>;
}

export interface Structure {
  childrenOf: Record<string, string[]>;
  remainders: Set<string>;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Fill what the statement implies. Mutates `v`; returns implied keys. */
function fillPeriod(v: Record<string, number>, s: Structure): string[] {
  const implied: string[] = [];
  const set = (k: string, n: number) => { v[k] = r3(n); implied.push(k); };
  const sumOf = (keys: string[]) => {
    const present = keys.filter((k) => v[k] !== undefined);
    return present.length ? present.reduce((t, k) => t + v[k], 0) : undefined;
  };
  for (const p of [...OPEX_SUBLINES, 'revenue', 'cogs', 'da', 'interest_expense', 'other_income', 'other_expense', 'tax']) {
    const sum = sumOf(s.childrenOf[p] ?? []);
    if (v[p] === undefined && sum !== undefined) set(p, sum);
  }
  if (v.cogs === undefined && v.revenue !== undefined && v.gross_profit !== undefined) set('cogs', v.revenue - v.gross_profit);
  if (v.gross_profit === undefined && v.revenue !== undefined && v.cogs !== undefined) v.gross_profit = r3(v.revenue - v.cogs);
  const gp = v.gross_profit ?? (v.revenue !== undefined ? v.revenue - (v.cogs ?? 0) : undefined);
  if (v.total_opex === undefined) {
    // EBITDA is printed (or derived from EBIT + D&A) — it pins total costs.
    if (v.ebitda !== undefined && gp !== undefined) set('total_opex', gp - v.ebitda);
    else {
      const sum = sumOf([...OPEX_SUBLINES, ...(s.childrenOf.total_opex ?? [])]);
      if (sum !== undefined) set('total_opex', sum);
    }
  }
  if (v.ebitda === undefined && gp !== undefined && v.total_opex !== undefined) v.ebitda = r3(gp - v.total_opex);
  if (v.da === undefined && v.ebitda !== undefined && v.ebit !== undefined) set('da', v.ebitda - v.ebit);
  return implied;
}

/** Components of a SUM parent (accounts, sub-lines, remainder). */
function sumComponents(p: string, s: Structure, included: Set<string>): string[] {
  const subs = p === 'total_opex' ? OPEX_SUBLINES.filter((k) => included.has(k)) : [];
  const rem = s.remainders.has(p) ? [`${p}${REMAINDER_SUFFIX}`] : [];
  return [...subs, ...(s.childrenOf[p] ?? []), ...rem];
}

function applyRemainders(pv: PeriodValues, s: Structure, included: Set<string>) {
  const v = pv.values;
  for (const p of s.remainders) {
    const comps = sumComponents(p, s, included).filter((k) => !k.endsWith(REMAINDER_SUFFIX));
    const present = comps.filter((k) => v[k] !== undefined);
    if (v[p] === undefined || present.length === 0) continue;
    v[`${p}${REMAINDER_SUFFIX}`] = r3(v[p] - present.reduce((t, k) => t + v[k], 0));
  }
}

export function buildLineCatalogue(history: HistoricalRow[]): LineCatalogue {
  const raw = history.map(rowLines);
  const childrenOf: Record<string, string[]> = {};
  const unclassified = new Set<string>();
  const magnitude: Record<string, number> = {};
  for (const r of raw) {
    for (const [k, n] of Object.entries(r)) {
      magnitude[k] = Math.max(magnitude[k] ?? 0, Math.abs(n));
      if (STANDARD_KEYS.has(k)) continue;
      const p = parentOf(k);
      if (!p) { unclassified.add(k); continue; }
      childrenOf[p] ??= [];
      if (!childrenOf[p].includes(k)) childrenOf[p].push(k);
    }
  }
  // Biggest accounts first, then alphabetical — deterministic and readable.
  for (const p of Object.keys(childrenOf)) {
    childrenOf[p].sort((a, b) => (magnitude[b] - magnitude[a]) || a.localeCompare(b));
  }
  const s: Structure = { childrenOf, remainders: new Set() };

  const periods: PeriodValues[] = raw.map((r) => {
    const values = { ...r };
    return { values, implied: fillPeriod(values, s) };
  });
  const has = (k: string) => periods.some((p) => p.values[k] !== undefined);

  const included = new Set<string>(['revenue', 'ebitda', 'da', 'ebit', 'interest_expense', 'ebt', 'tax', 'net_income']);
  for (const k of ['cogs', ...OPEX_SUBLINES, 'total_opex', 'other_income', 'other_expense']) if (has(k)) included.add(k);
  if (included.has('cogs')) included.add('gross_profit');
  if (OPEX_SUBLINES.some((k) => included.has(k)) || childrenOf.total_opex) included.add('total_opex');
  // Always at least one operating cost line, or EBITDA would equal revenue.
  if (!included.has('cogs') && !included.has('total_opex')) included.add('total_opex');

  // Parents whose accounts don't add up to the printed total get a remainder.
  const sumParents = ['revenue', 'cogs', ...OPEX_SUBLINES, 'total_opex', 'da', 'other_income', 'other_expense']
    .filter((p) => included.has(p) && sumComponents(p, s, included).length > 0);
  for (const p of sumParents) {
    const comps = sumComponents(p, s, included);
    const off = periods.some(({ values: v }) => {
      const present = comps.filter((k) => v[k] !== undefined);
      return v[p] !== undefined && present.length > 0
        && Math.abs(v[p] - present.reduce((t, k) => t + v[k], 0)) > EPS;
    });
    if (off) s.remainders.add(p);
  }
  // No EBITDA in the base period: entry EBITDA is then set through an
  // implied operating-cost figure (Deal.ebitda fallback), which needs an input line.
  const baseRow = selectBasePeriod(history)?.row;
  if (baseRow && rowLines(baseRow).ebitda === undefined && sumParents.includes('total_opex')) s.remainders.add('total_opex');

  for (const pv of periods) applyRemainders(pv, s, included);

  return { lines: buildLines(s, included), periods, unclassified: [...unclassified].sort(), structure: s, included };
}

function buildLines(s: Structure, included: Set<string>): ModelLine[] {
  const lines: ModelLine[] = [];
  const isSum = (p: string) => sumComponents(p, s, included).length > 0;

  const addTree = (key: string, level: number, flags: Partial<ModelLine>, parent?: string) => {
    const comps = isSum(key) ? sumComponents(key, s, included) : [];
    lines.push({
      key,
      label: parent ? (LABELS[key] ?? childLabel(key, parent)) : LABELS[key],
      kind: comps.length ? 'SUM' : 'INPUT',
      level,
      ...(parent ? { parent } : {}),
      ...(comps.length ? { components: comps.map((k) => ({ key: k, sign: 1 as const })) } : {}),
      ...flags,
    });
    for (const c of comps) addTree(c, level + 1, flags, key);
  };
  const subtotal = (key: string, components: Array<[string, 1 | -1]>) => lines.push({
    key, label: LABELS[key], kind: 'SUBTOTAL', level: 0,
    components: components.filter(([k]) => included.has(k)).map(([k, sign]) => ({ key: k, sign })),
  });
  const computed = (key: string, kind: 'INTEREST' | 'TAX') => {
    lines.push({ key, label: LABELS[key], kind: 'COMPUTED', level: 0, computed: kind });
    for (const c of s.childrenOf[key] ?? []) {
      lines.push({ key: c, label: childLabel(c, key), kind: 'INPUT', level: 1, parent: key, historicalOnly: true });
    }
  };

  addTree('revenue', 0, { revenueLine: true });
  if (included.has('cogs')) {
    addTree('cogs', 0, { costLine: true });
    subtotal('gross_profit', [['revenue', 1], ['cogs', -1]]);
  }
  if (included.has('total_opex')) addTree('total_opex', 0, { costLine: true });
  subtotal('ebitda', included.has('gross_profit')
    ? [['gross_profit', 1], ['total_opex', -1]]
    : [['revenue', 1], ['total_opex', -1]]);
  addTree('da', 0, {});
  subtotal('ebit', [['ebitda', 1], ['da', -1]]);
  computed('interest_expense', 'INTEREST');
  if (included.has('other_income')) addTree('other_income', 0, {});
  if (included.has('other_expense')) addTree('other_expense', 0, {});
  subtotal('ebt', [['ebit', 1], ['interest_expense', -1], ['other_income', 1], ['other_expense', -1]]);
  computed('tax', 'TAX');
  subtotal('net_income', [['ebt', 1], ['tax', -1]]);
  return lines;
}

/** Values for the Projections base column, with the entry-EBITDA fallback. */
export interface BaseColumn {
  values: Record<string, number>;
  implied: string[];
  entrySource: 'base' | 'deal' | 'missing';
}

/** First input line that can absorb an implied operating-cost figure. */
function impliedCostKey(lines: ModelLine[]): string | null {
  const keys = lines.filter((l) => l.kind === 'INPUT' && l.costLine && !l.historicalOnly).map((l) => l.key);
  return ['total_opex', `total_opex${REMAINDER_SUFFIX}`, 'cogs', `cogs${REMAINDER_SUFFIX}`].find((k) => keys.includes(k)) ?? keys[0] ?? null;
}

/** Evaluate SUM / SUBTOTAL lines over a values map (blank = 0). */
export function evaluateLine(lines: ModelLine[], values: Record<string, number>, key: string): number {
  const line = lines.find((l) => l.key === key);
  if (!line) return 0;
  if ((line.kind === 'SUM' || line.kind === 'SUBTOTAL') && line.components) {
    return line.components.reduce((t, c) => t + c.sign * evaluateLine(lines, values, c.key), 0);
  }
  return values[key] ?? 0;
}

export function baseColumnValues(
  cat: LineCatalogue,
  history: HistoricalRow[],
  base: BasePeriod | null,
  fallbackEbitda?: number | null,
): BaseColumn {
  if (!base) return { values: {}, implied: [], entrySource: 'missing' };
  // The base row is one of the history rows, or a synthesised LTM.
  const idx = history.indexOf(base.row);
  let pv: PeriodValues;
  if (idx >= 0) pv = { values: { ...cat.periods[idx].values }, implied: [...cat.periods[idx].implied] };
  else {
    const values = rowLines(base.row);
    pv = { values, implied: fillPeriod(values, cat.structure) };
    applyRemainders(pv, cat.structure, cat.included);
  }
  const reported = typeof base.row.ebitda === 'number' || pv.values.ebitda !== undefined;
  if (reported) return { ...pv, entrySource: 'base' };

  const costKey = impliedCostKey(cat.lines);
  const target = typeof fallbackEbitda === 'number' && fallbackEbitda > 0 ? fallbackEbitda : 0;
  if (costKey) {
    const without = { ...pv.values, [costKey]: 0 };
    pv.values[costKey] = r3(evaluateLine(cat.lines, without, 'ebitda') - target);
    pv.implied.push(costKey);
  }
  return { ...pv, entrySource: target > 0 ? 'deal' : 'missing' };
}
