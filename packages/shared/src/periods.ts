// ============================================================
// Canonical financial periods (single source of truth across apps)
// ============================================================
//
// Financial statement period labels arrive in whatever shape the source
// document printed: "2024", "FY2023 (Jan - Dec 2023)", "2025 YTD (Jan - Sep
// 2025)", "LTM Sep-25", "Q1'26", "2026E". Sorting those as plain strings
// scrambles them (FY2023 lands after 2025 YTD), and treating a 9-month YTD as
// a year produces false declines. Every consumer — analysis, ratios, the
// model builder, the chat agents and the web tables — should parse with
// `parsePeriod` and order with `comparePeriods`.

export type PeriodKind = 'FY' | 'YTD' | 'LTM' | 'Q' | 'H' | 'M' | 'EST';

export interface CanonicalPeriod {
  /** Original label, for display. */
  label: string;
  kind: PeriodKind;
  /** Fiscal year the period ends in. */
  fiscalYear: number;
  /** Months covered; null when the label doesn't say (e.g. a bare "2025 YTD"). */
  months: number | null;
  /** ISO yyyy-mm-dd, end of the last month covered (year-end when unknown). */
  endDate: string;
  /** Stable grouping key: "2023", "YTD Sep 2025", "LTM Sep 2025", "Q1 2026", "H1 2026", "Sep 2025", "2026E". */
  canonicalKey: string;
}

const MONTHS: Record<string, number> = {
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6, JULY: 7,
  AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
  JAN: 1, FEB: 2, MAR: 3, APR: 4, JUN: 6, JUL: 7, AUG: 8, SEPT: 9, SEP: 9,
  OCT: 10, NOV: 11, DEC: 12,
};
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Longest names first so "SEPTEMBER" isn't read as "SEP" + "TEMBER".
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
// A month, optionally followed by a year. A 2-digit number followed by a
// 4-digit year is a day ("Sep 30, 2025"), not a year.
const MONTH_TOKEN_RE = new RegExp(
  `\\b(${MONTH_ALT})\\b\\.?(?:[\\s\\-\\/']*(\\d{4}|\\d{2}(?!\\d|,?\\s*\\d{4}))\\b)?`,
  'g',
);

const KIND_ORDER: Record<PeriodKind, number> = { M: 0, Q: 1, H: 2, YTD: 3, LTM: 4, FY: 5, EST: 6 };

function toYear(raw: string): number {
  const n = Number(raw);
  return raw.length === 2 ? 2000 + n : n;
}

function isoMonthEnd(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

interface MonthToken { month: number; year: number | null }

function monthTokens(upper: string): MonthToken[] {
  const out: MonthToken[] = [];
  for (const m of upper.matchAll(MONTH_TOKEN_RE)) {
    out.push({ month: MONTHS[m[1]], year: m[2] ? toYear(m[2]) : null });
  }
  return out;
}

function findYear(upper: string): number | null {
  const fy = upper.match(/\b(?:FY|CY)\s?'?(\d{4}|\d{2})\b/);
  if (fy) return toYear(fy[1]);
  const four = upper.match(/\b((?:19|20)\d{2})(?:[A-Z]\b|\b)/g);
  if (four) return Number(four[four.length - 1].slice(0, 4));
  const two = upper.match(/(?:'|\b[QH][1-4][\s\-]?|\b[1-4][QH]\s?)(\d{2})\b/) ?? upper.match(/\b(\d{2})[EFPBA]\b/);
  if (two) return toYear(two[1]);
  return null;
}

export interface ParsePeriodOptions {
  /**
   * The company's fiscal year-end month (1-12), for labels that don't state
   * one: a bare "FY2025" otherwise ends in December, which mis-orders a June
   * year-end company's annual figures against its quarters and months.
   * See inferFiscalYearEndMonth.
   */
  fiscalYearEndMonth?: number | null;
}

/**
 * Parse a period label into a canonical period, or null when it carries no
 * usable date (e.g. "Current", "ARR (Annualised)").
 */
export function parsePeriod(label: string | null | undefined, opts: ParsePeriodOptions = {}): CanonicalPeriod | null {
  if (!label) return null;
  const s = label.trim();
  if (!s) return null;
  const u = s.toUpperCase();

  const isYtd = /\bYTD\b/.test(u);
  const isLtm = /\b(LTM|TTM)\b/.test(u);
  const isEst =
    /\b(EST|ESTIMATE[SD]?|FORECAST|BUDGET|PROJ|PROJECTED|PROJECTION|PLAN)\b/.test(u) ||
    /\b(?:FY\s?)?'?(?:\d{4}|\d{2})\s?[EFPB]\b/.test(u);
  const quarter = u.match(/\bQ([1-4])(?=\b|['\-\s]?\d)|\b([1-4])Q(?=\s?'?\d{2})/);
  const half = u.match(/\bH([12])(?=\b|['\-\s]?\d)|\b([12])H(?=\s?'?\d{2})/);
  const tokens = monthTokens(u);

  // Explicit month range: "(Jan - Sep 2025)", "Apr 2024 - Mar 2025".
  let rangeMonths: number | null = null;
  let endMonth: number | null = null;
  let endYear: number | null = null;
  const last = tokens[tokens.length - 1];
  if (tokens.length >= 2 && last.year != null) {
    const first = tokens[0];
    const startYear = first.year ?? (first.month <= last.month ? last.year : last.year - 1);
    rangeMonths = last.year * 12 + last.month - (startYear * 12 + first.month) + 1;
    if (rangeMonths < 1 || rangeMonths > 24) rangeMonths = null;
    else { endMonth = last.month; endYear = last.year; }
  } else if (tokens.length >= 1) {
    // "Sep 2025", or "Mar 31, 2024" (day, then the year found below).
    endMonth = last.month;
    endYear = last.year;
  }

  const year = endYear ?? findYear(u);
  if (year == null) return null;
  const fye = opts.fiscalYearEndMonth && opts.fiscalYearEndMonth >= 1 && opts.fiscalYearEndMonth <= 12 ? opts.fiscalYearEndMonth : null;

  const build = (kind: PeriodKind, months: number | null, month: number | null, key: string): CanonicalPeriod => ({
    label: s,
    kind,
    fiscalYear: year,
    months,
    endDate: isoMonthEnd(year, month ?? 12),
    canonicalKey: key,
  });
  const mon = (m: number) => MONTH_ABBR[m - 1];

  if (isEst) return build('EST', 12, endMonth ?? fye, `${year}E`);
  if (isLtm) return build('LTM', 12, endMonth, endMonth ? `LTM ${mon(endMonth)} ${year}` : `LTM ${year}`);
  if (isYtd) {
    return build('YTD', rangeMonths ?? (endMonth && tokens.length === 1 ? endMonth : null), endMonth,
      endMonth ? `YTD ${mon(endMonth)} ${year}` : `YTD ${year}`);
  }
  if (quarter) {
    const q = Number(quarter[1] ?? quarter[2]);
    return build('Q', 3, endMonth ?? q * 3, `Q${q} ${year}`);
  }
  if (half) {
    const h = Number(half[1] ?? half[2]);
    return build('H', 6, endMonth ?? h * 6, `H${h} ${year}`);
  }
  if (rangeMonths != null && endMonth != null) {
    if (rangeMonths === 12) return build('FY', 12, endMonth, `${year}`);
    if (rangeMonths === 1) return build('M', 1, endMonth, `${mon(endMonth)} ${year}`);
    if (rangeMonths === 3 && endMonth % 3 === 0) return build('Q', 3, endMonth, `Q${endMonth / 3} ${year}`);
    if (rangeMonths === 6 && endMonth % 6 === 0) return build('H', 6, endMonth, `H${endMonth / 6} ${year}`);
    // Any other partial span is a year-to-date figure.
    return build('YTD', rangeMonths, endMonth, `YTD ${mon(endMonth)} ${year}`);
  }
  // A lone month with a year is a monthly period — unless the label names a
  // fiscal year ("FY2024 ended Mar 2024"), in which case the month is the FYE.
  const namesFy = /\b(FY|CY|FISCAL|YEAR|ANNUAL)\b|\bFY\s?'?\d/.test(u);
  if (endMonth != null && !namesFy) return build('M', 1, endMonth, `${mon(endMonth)} ${year}`);
  return build('FY', 12, endMonth ?? fye, `${year}`);
}

/**
 * The fiscal year-end month the labels themselves state, from full years
 * with a non-December end ("FY2024 (Jul 2023 - Jun 2024)" → 6), or null
 * when none say (calendar-year companies, or nothing to go on). Pass it to
 * parsePeriod for the labels that don't state one.
 */
export function inferFiscalYearEndMonth(labels: Array<string | null | undefined>): number | null {
  const counts = new Map<number, number>();
  for (const label of labels) {
    const p = parsePeriod(label);
    if (!p || p.kind !== 'FY' || p.months !== 12) continue;
    const month = Number(p.endDate.slice(5, 7));
    if (month !== 12) counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  let best: number | null = null;
  for (const [month, n] of counts) if (best === null || n > counts.get(best)!) best = month;
  return best;
}

/** True for a full fiscal year (the only periods growth/CAGR should compare). */
export function isFullYear(p: CanonicalPeriod | null | undefined): boolean {
  return !!p && p.kind === 'FY' && p.months === 12;
}

/**
 * Chronological comparator: by end date, then kind (M < Q < H < YTD < LTM <
 * FY < EST). Accepts labels or parsed periods; unparseable labels sort last,
 * alphabetically.
 */
export function comparePeriods(
  a: string | CanonicalPeriod | null | undefined,
  b: string | CanonicalPeriod | null | undefined,
): number {
  const pa = typeof a === 'string' || a == null ? parsePeriod(a) : a;
  const pb = typeof b === 'string' || b == null ? parsePeriod(b) : b;
  if (pa && pb) {
    if (pa.endDate !== pb.endDate) return pa.endDate < pb.endDate ? -1 : 1;
    return KIND_ORDER[pa.kind] - KIND_ORDER[pb.kind];
  }
  if (pa) return -1;
  if (pb) return 1;
  const la = typeof a === 'string' ? a : a?.label ?? '';
  const lb = typeof b === 'string' ? b : b?.label ?? '';
  return la.localeCompare(lb);
}

/**
 * A single sortable number for a label (yyyymm + kind / 10), for callers that
 * sort by a numeric key. Same order as `comparePeriods`; null if unparseable.
 */
export function periodOrdinal(label: string | null | undefined): number | null {
  const p = parsePeriod(label);
  if (!p) return null;
  return Number(p.endDate.slice(0, 4)) * 100 + Number(p.endDate.slice(5, 7)) + KIND_ORDER[p.kind] / 10;
}
