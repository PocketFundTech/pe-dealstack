/**
 * Financial Period Normalizer & Deduper
 * ======================================
 *
 * Spreadsheet column headers in CIMs are not normalised. The same logical
 * period often appears under multiple labels because rows are typed in by
 * hand:
 *
 *   "FY26 Est"  ↔  "FY26 Est."  ↔  "FY26 Estimated"  ↔  "2026 FY Est"
 *   "YTD 2026"  ↔  "2026 YTD"  ↔  "YTD Total"  ↔  "YTD Total (Jan-Apr 20, 2026)"
 *   "Apr-26"   ↔  "2026-04"   ↔  "April 2026"  ↔  "Apr-2026"  ↔  "apr-26"
 *   "Apr-26 LTM" ↔ "2026-04_LTM" ↔ "2026-04-LTM" ↔ "Apr 26 (LTM)"
 *   "Q1-26"    ↔  "1Q26"     ↔  "Q1 2026"
 *   "H1-26"    ↔  "1H26"     ↔  "H1 2026"
 *
 * The LLM (financialClassifier.ts) reads these labels verbatim, so the same
 * period ends up as two-to-six rows in `FinancialStatement` and the chart
 * X-axis goes from 4 points to 10 points of duplicates.
 *
 * Canonicalisation map applied here (case-insensitive matching, casing of
 * the FIRST occurrence is kept on output):
 *
 *   trim + collapse whitespace + strip trailing  . , :
 *   "FY26 Est." / "FY26 Estimated" / "FY26 estimate"      →  "FY26 Est"
 *   "2026 FY Est" / "2026 FY Est." / "2026 FY Estimated"  →  "FY26 Est"
 *   "2026 YTD"  / "YTD Total (Jan-Apr…)"                  →  "YTD 2026"
 *   "YTD Total" with sibling rows all on same year         →  "YTD <year>"
 *   "YTD Total" with mixed/no sibling years                →  "YTD Total"
 *   month-year labels ("Jan-26", "2026-01", "January 2026") →  "Jan 2026"
 *   month-year LTM labels ("Apr-26 LTM", "2026-04_LTM")    →  "Apr 2026 LTM"
 *   quarter labels ("Q1-26", "1Q26", "Q1 2026")            →  "Q1 2026"
 *   half labels ("H1-26", "1H26", "H1 2026")               →  "H1 2026"
 *
 * Dedup runs per (statementType, periodType) bucket. Within each bucket,
 * rows that normalise to the same key are merged: line-item values from
 * the row with higher `confidence` win, ties go to the row with more
 * non-null fields, then to the first occurrence.
 *
 * Edge cases handled:
 *   - "FY26 Est." vs "FY26 Est" vs "2026 FY Est"
 *   - "YTD 2026" / "2026 YTD" / "YTD Total" / "YTD Total (Jan-Apr 20, 2026)"
 *   - Whitespace and trailing-punctuation variants
 *   - Case differences ("ytd 2026" vs "YTD 2026", "apr-26" vs "Apr-26")
 *   - Bare "YTD Total" inferred from sibling-row years (when unambiguous)
 *   - 2-digit years folded to 20XX ("26" → "2026", "99" → "2099")
 *
 * NOT canonicalised (intentionally):
 *   - "Current_Month_Range" / "Current Month Range" / "Current Period" /
 *     "Current" — these are LLM-synthesised placeholder labels that should
 *     be resolved upstream to a real period (e.g. "Apr 2026") by the
 *     extractor before storage. We leave them alone here so we do not
 *     silently drop or mis-merge them. They will NOT dedup against
 *     "Apr 2026". Future improvement: resolve these in the extractor.
 *   - Rolling-period labels like "L3M", "TTM" — preserved as-is.
 *   - Bare "YTD Total" with mixed-year siblings — left as-is to avoid
 *     cross-year false-merges.
 */
import { log } from '../utils/logger.js';
import type {
  ClassifiedStatement,
  FinancialPeriod,
  PeriodType,
  StatementType,
} from './financialClassifier.js';

// ─── Public types ────────────────────────────────────────────

/** A period with a key for grouping by (statementType, periodType). */
export interface BucketedPeriod extends FinancialPeriod {
  statementType: StatementType;
}

// ─── normalizePeriodLabel ────────────────────────────────────

/**
 * Canonicalise a period label so equivalent headers compare equal.
 *
 * Pure / synchronous. Does not need access to the surrounding bucket —
 * the canonicalisation rules are deterministic on the label alone.
 *
 * @example
 *   normalizePeriodLabel("FY26 Est.")                          // "FY26 Est"
 *   normalizePeriodLabel("FY26 Estimated")                     // "FY26 Est"
 *   normalizePeriodLabel("2026 YTD")                           // "YTD 2026"
 *   normalizePeriodLabel("YTD Total")                          // "YTD Total"
 *   normalizePeriodLabel("YTD Total (Jan-Apr 20, 2026)")       // "YTD Total"
 *   normalizePeriodLabel(" Q1   2026 ")                        // "Q1 2026"
 *   normalizePeriodLabel("Apr-26")                             // "Apr 2026"
 *   normalizePeriodLabel("2026-04")                            // "Apr 2026"
 *   normalizePeriodLabel("April 2026")                         // "Apr 2026"
 *   normalizePeriodLabel("Apr-26 LTM")                         // "Apr 2026 LTM"
 *   normalizePeriodLabel("2026-04_LTM")                        // "Apr 2026 LTM"
 *   normalizePeriodLabel("Q1-26")                              // "Q1 2026"
 *   normalizePeriodLabel("1Q26")                               // "Q1 2026"
 *   normalizePeriodLabel("H1-26")                              // "H1 2026"
 *   normalizePeriodLabel("Current_Month_Range")                // "Current_Month_Range"
 */
export function normalizePeriodLabel(label: string): string {
  if (!label) return '';

  // 1. Trim leading/trailing whitespace
  let s = String(label).trim();

  // 2. Strip trailing punctuation (. , : ;)  — repeat in case of ".."  etc
  s = s.replace(/[.,:;]+$/g, '').trim();

  // 3. Collapse internal whitespace runs to single space
  s = s.replace(/\s+/g, ' ');

  // 3a. Carve out LLM-synthesised placeholder labels that we explicitly
  //     refuse to canonicalise. These are emitted by the extractor when it
  //     cannot identify a concrete period, and they should be resolved
  //     UPSTREAM (in the extractor) to a real period like "Apr 2026" before
  //     reaching dedup. We pass them through here so we don't silently drop
  //     data — but they intentionally will NOT collide with any real period
  //     bucket like "Apr 2026". Future improvement: resolve these in the
  //     extractor before storage so this carve-out becomes unnecessary.
  if (/^(?:Current[\s_-]?Month[\s_-]?Range|Current[\s_-]?Period|Current)$/i.test(s)) {
    return s;
  }

  // 4. Synonym normalisation — applied in priority order.
  //    All matches are case-insensitive; output uses canonical casing.
  //
  //    Order rationale:
  //      a) FY-Est rules first — they have a unique "FY" prefix that won't
  //         collide with date formats like "Apr-26" or "Q1-26".
  //      b) YTD rules second — also have a unique "YTD" token.
  //      c) Then date formats: month-year, quarter, half. These rely on
  //         pattern shape (numeric-numeric, Mon-numeric, etc.) so they
  //         must run AFTER any rule that could rewrite the input into a
  //         different shape.

  // 4a. "FY<NN> Estimated"  →  "FY<NN> Est"   (also handles "estimate")
  //     Only matches when "Estimated"/"estimate" is the trailing word.
  s = s.replace(/^(FY\d{2,4})\s+Estimated?$/i, (_m, fy) => `${fy.toUpperCase()} Est`);

  // 4a-bis. Year-first FY Est ordering — "<YEAR> FY Est" / "<YEAR> FY Est."
  //         / "<YEAR> FY Estimate" / "<YEAR> FY Estimated"   →   "FY<YY> Est"
  //
  //   YEAR can be 4-digit (2026) or 2-digit (26).
  //   4-digit years are folded down to 2-digit so the output collapses with
  //   the canonical "FY26 Est" label (the existing form most LLM extractions
  //   already emit). Trailing "." was stripped in step 2 already, but we
  //   tolerate it here too in case a caller bypasses the prelude.
  const yearFirstFyEst = s.match(/^(\d{2,4})\s+FY\s+Est(?:imated?)?\.?$/i);
  if (yearFirstFyEst) {
    const yr = yearFirstFyEst[1];
    const yy = yr.length === 4 ? yr.slice(2) : yr;
    s = `FY${yy} Est`;
  }

  // 4b. "FY<NN> Est"  (any case)  →  canonical casing "FY<NN> Est"
  const fyEstMatch = s.match(/^(FY\d{2,4})\s+Est$/i);
  if (fyEstMatch) {
    s = `${fyEstMatch[1].toUpperCase()} Est`;
  }

  // 4c. "FY<NN> Forecast" / "FY<NN> Budget" / "FY<NN> Proj" — leave as
  //     individual labels but uppercase the FY prefix for consistency.
  const fyOtherMatch = s.match(/^(FY\d{2,4})\s+(Forecast|Budget|Proj(?:ected)?|Plan)$/i);
  if (fyOtherMatch) {
    s = `${fyOtherMatch[1].toUpperCase()} ${capitalize(fyOtherMatch[2])}`;
  }

  // 4c-bis. Pure fiscal-year / calendar-year labels collapse onto the bare
  //   4-digit year so "FY2024" / "FY24" / "FY 2024" / "2024 FY" / "CY2024"
  //   all dedup against a bare "2024" row (real extractions emit both the
  //   spreadsheet's "FY2024" header AND a narrative "2024", producing two
  //   statements for one fiscal year — see the InstateMe CIM which yielded
  //   2024 + FY2024, 2025 + FY2025, 2023 + FY2023).
  //
  //   Only YEAR-ONLY forms match — a trailing qualifier ("FY26 Est",
  //   "FY26 Forecast") means a projection/estimate and is handled above and
  //   kept as a DISTINCT label, so this must run AFTER 4a-4c and requires an
  //   end anchor right after the year. HISTORICAL vs PROJECTED are already
  //   in separate dedup buckets, so collapsing the label here never merges a
  //   projection into an actual.
  {
    const fyYear =
      s.match(/^FY\s?(\d{2,4})$/i) || // FY2024, FY24, "FY 2024"
      s.match(/^(\d{2,4})\s?FY$/i) || // "2024 FY", 24FY
      s.match(/^CY\s?(\d{4})$/i); //    CY2024
    if (fyYear) {
      const yr = normalizeYear(fyYear[1]);
      if (yr) return yr;
    }
  }

  // 4d. YTD synonyms.  Order matters — try the most specific first.
  //
  //   "YTD Total (Jan-Apr 20, 2026)"  →  "YTD 2026"   (year extracted)
  //   "YTD Total ("…anything…")"      →  "YTD Total"  (no year)
  //   "<year> YTD"                    →  "YTD <year>"
  //   "YTD <year>"                    →  "YTD <year>"  (canonical casing)
  //   "YTD Total"                     →  "YTD Total"   (kept distinct)
  //
  // We deliberately fold "YTD Total (…dates…)" into "YTD <year>" only when
  // a 4-digit year is in the parens; otherwise we keep "YTD Total" so we
  // do not confuse two years' YTD figures.

  // "YTD Total (…)" with year in parens → YTD <year>
  const ytdTotalWithDates = s.match(/^YTD\s+Total\s*\(.*?(\d{4}).*?\)$/i);
  if (ytdTotalWithDates) {
    s = `YTD ${ytdTotalWithDates[1]}`;
  } else {
    // Bare "YTD Total" or "YTD Total ()" → "YTD Total"
    if (/^YTD\s+Total(\s*\(\s*\))?$/i.test(s)) {
      s = 'YTD Total';
    }
  }

  // "<year> YTD" → "YTD <year>"
  const yearYtdMatch = s.match(/^(\d{4})\s+YTD$/i);
  if (yearYtdMatch) {
    s = `YTD ${yearYtdMatch[1]}`;
  }

  // "YTD <year>" → canonical casing
  const ytdYearMatch = s.match(/^YTD\s+(\d{4})$/i);
  if (ytdYearMatch) {
    s = `YTD ${ytdYearMatch[1]}`;
  }

  // 4e. Date-format canonicalisation (month-year, quarter, half).
  //
  // Each branch detects its shape, extracts the date components plus an
  // optional LTM marker, and rewrites to the canonical form. We try
  // QUARTER and HALF before MONTH-YEAR — the quarter/half regexes are
  // more constrained (they require Q/H or 1-4Q/1-2H tokens) so the
  // month-year fallback never sees them. After any branch matches, we
  // return immediately to avoid a downstream branch re-matching its own
  // output (e.g. once "Apr 2026" is produced, the quarter regex must
  // not look at it).

  // 4e-quarter:  "Q1-26", "1Q26", "Q1 2026", "Q1-2026" (+ optional LTM)
  //
  // Two shapes accepted:
  //   - Q-first:    ^Q ([1-4]) <sep?> <year> <ltm?>$
  //   - Number-first: ^([1-4]) Q <sep?> <year> <ltm?>$
  // Separator is one of: " ", "-", "_", or empty (for "1Q26").
  //
  // Year alternative ORDER MATTERS: \d{4} must be tried BEFORE \d{2} so the
  // engine prefers a 4-digit match over a 2-digit prefix. We additionally
  // anchor with (?=\D|$) after the year so that "Q1 2026 LTM" does NOT get
  // truncated to year=20 and tail="26 LTM". A simple \b would not suffice
  // because underscore counts as a word character, breaking "Q1-26_LTM"-
  // shaped inputs (none in the wild for quarters, but consistent with the
  // numeric-first month-year branch where `_LTM` IS a real format).
  {
    const qFirst = s.match(/^Q([1-4])\s*[-_ ]?\s*(\d{4}|\d{2})(?=\D|$)\s*(.*)$/i);
    const qLast = s.match(/^([1-4])Q\s*[-_ ]?\s*(\d{4}|\d{2})(?=\D|$)\s*(.*)$/i);
    const m = qFirst ?? qLast;
    if (m) {
      const qNum = m[1];
      const yr = normalizeYear(m[2]);
      if (yr) {
        const ltm = parseLtmTail(m[3]);
        if (ltm !== null) {
          return ltm ? `Q${qNum} ${yr} LTM` : `Q${qNum} ${yr}`;
        }
      }
    }
  }

  // 4e-half:  "H1-26", "1H26", "H1 2026", "H1-2026" (+ optional LTM)
  // Same year-ordering rule as quarter (4-digit first, (?=\D|$) anchor).
  {
    const hFirst = s.match(/^H([1-2])\s*[-_ ]?\s*(\d{4}|\d{2})(?=\D|$)\s*(.*)$/i);
    const hLast = s.match(/^([1-2])H\s*[-_ ]?\s*(\d{4}|\d{2})(?=\D|$)\s*(.*)$/i);
    const m = hFirst ?? hLast;
    if (m) {
      const hNum = m[1];
      const yr = normalizeYear(m[2]);
      if (yr) {
        const ltm = parseLtmTail(m[3]);
        if (ltm !== null) {
          return ltm ? `H${hNum} ${yr} LTM` : `H${hNum} ${yr}`;
        }
      }
    }
  }

  // 4e-month-year:  "Apr-26", "Apr 26", "Apr-2026", "Apr 2026", "April 2026"
  //                 (+ optional LTM tail)
  {
    // Month name + year:  ^<month-word> <sep> <year> <ltm?>$
    // Separator is one of: " ", "-", "_", "/", ".".
    // Year alternative ordering: 4-digit first, (?=\D|$) after to prevent
    // "Apr 2026 LTM" tokenising as year=20 / tail="26 LTM".
    const m = s.match(/^([A-Za-z]{3,9})\s*[-_ /.]\s*(\d{4}|\d{2})(?=\D|$)\s*(.*)$/);
    if (m) {
      const mon = monthAbbrev(m[1]);
      const yr = normalizeYear(m[2]);
      if (mon && yr) {
        const ltm = parseLtmTail(m[3]);
        if (ltm !== null) {
          return ltm ? `${mon} ${yr} LTM` : `${mon} ${yr}`;
        }
      }
    }
  }

  // 4e-month-year (numeric-first):  "2026-04", "2026/04", "2026.04",
  //                                 "04-2026", "04/2026", "2026-4"
  //                                 (+ optional LTM tail with sep _ or -)
  //
  // Two shapes accepted:
  //   - Year-first:   ^(\d{4}) <sep> (\d{1,2}) <ltm-sep ltm?>$
  //   - Month-first:  ^(\d{1,2}) <sep> (\d{4})  <ltm-sep ltm?>$
  // Separator is one of: "-", "/", ".".
  //
  // We DO NOT accept all-2-digit forms like "04-26" here — they are
  // ambiguous with day-month or month-year and we'd rather pass through
  // than guess wrong.
  //
  // We anchor the month digit-run with (?=\D|$) so that "2026-04_LTM" lets
  // the LTM tail be consumed by parseLtmTail rather than swallowed by the
  // word-boundary on '_' (underscores ARE word characters, so a plain \b
  // would FAIL between '4' and '_'). The year-first regex requires the
  // year to be exactly 4 digits.
  {
    const numericMonth = (mm: string): string | null => {
      const n = parseInt(mm, 10);
      if (!Number.isFinite(n) || n < 1 || n > 12) return null;
      const NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return NAMES[n - 1];
    };
    const yearFirst = s.match(/^(\d{4})[-/.](\d{1,2})(?=\D|$)\s*(.*)$/);
    const monthFirst = s.match(/^(\d{1,2})[-/.](\d{4})(?=\D|$)\s*(.*)$/);
    if (yearFirst) {
      const yr = normalizeYear(yearFirst[1]);
      const mon = numericMonth(yearFirst[2]);
      if (mon && yr) {
        const ltm = parseLtmTail(yearFirst[3]);
        if (ltm !== null) {
          return ltm ? `${mon} ${yr} LTM` : `${mon} ${yr}`;
        }
      }
    }
    if (monthFirst) {
      const mon = numericMonth(monthFirst[1]);
      const yr = normalizeYear(monthFirst[2]);
      if (mon && yr) {
        const ltm = parseLtmTail(monthFirst[3]);
        if (ltm !== null) {
          return ltm ? `${mon} ${yr} LTM` : `${mon} ${yr}`;
        }
      }
    }
  }

  return s;
}

function capitalize(w: string): string {
  if (!w) return w;
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

// ─── Date-format canonicalisation helpers ────────────────────

/**
 * Map any case of a 3-9 letter month name (short or long form) to its
 * canonical 3-letter form with capital first letter. Returns null if the
 * input is not a recognised month name.
 *
 *   "apr" / "Apr" / "APR" / "april" / "April"   →  "Apr"
 *   "sept"                                      →  null  (not in table)
 */
function monthAbbrev(input: string): string | null {
  if (!input) return null;
  const lower = input.toLowerCase();
  // Both short (3-letter) and long forms map to the canonical 3-letter form.
  // We use a map rather than slicing because some months (e.g. "May") are
  // the same as their short form, and we want exact-case-only matching to
  // avoid swallowing arbitrary 3-9 letter words.
  const TABLE: Record<string, string> = {
    jan: 'Jan', january: 'Jan',
    feb: 'Feb', february: 'Feb',
    mar: 'Mar', march: 'Mar',
    apr: 'Apr', april: 'Apr',
    may: 'May',
    jun: 'Jun', june: 'Jun',
    jul: 'Jul', july: 'Jul',
    aug: 'Aug', august: 'Aug',
    sep: 'Sep', sept: 'Sep', september: 'Sep',
    oct: 'Oct', october: 'Oct',
    nov: 'Nov', november: 'Nov',
    dec: 'Dec', december: 'Dec',
  };
  return TABLE[lower] ?? null;
}

/**
 * Fold a 2-digit or 4-digit year string into a canonical 4-digit year.
 * Returns null if the input is not a recognised year shape.
 *
 *   "26"   →  "2026"
 *   "99"   →  "2099"
 *   "2026" →  "2026"
 *   "130"  →  null   (3 digits is not a valid year shape)
 *   "20260"→  null   (5 digits is not a valid year shape)
 *
 * 2-digit years are always assumed to be 20XX. This matches the convention
 * elsewhere in this file (`inferYearFromSiblings`) and reflects the fact
 * that PE deal financials are essentially never older than 1999 or newer
 * than 2099 in our data set.
 */
function normalizeYear(input: string): string | null {
  if (!input) return null;
  if (/^\d{2}$/.test(input)) return `20${input}`;
  if (/^\d{4}$/.test(input)) return input;
  return null;
}

/**
 * Inspect the trailing text of a date label and report whether it is empty
 * (no LTM marker, return false), an LTM marker (return true), or something
 * we don't recognise (return null — caller should bail out and pass the
 * original label through unchanged).
 *
 * Accepted LTM markers (case-insensitive):
 *   ""               →  false       (no marker)
 *   "LTM"            →  true
 *   "(LTM)"          →  true
 *   "_LTM"           →  true        (underscore prefix from "2026-04_LTM")
 *   "-LTM"           →  true        (hyphen prefix from "2026-04-LTM")
 *   anything else    →  null        (don't canonicalise)
 *
 * The leading separator is tolerated because the calling regex may have
 * already absorbed only part of it (e.g. for "Apr-26 LTM" we already ate
 * the space before "LTM"; for "2026-04_LTM" we may need to eat the "_" or
 * "-" here).
 */
function parseLtmTail(tail: string): boolean | null {
  if (!tail) return false;
  const t = tail.trim();
  if (!t) return false;
  // Strip a single leading "_" or "-" (sometimes the date regex leaves it
  // attached when the LTM token is glued on with no whitespace).
  const stripped = t.replace(/^[-_]\s*/, '').trim();
  if (!stripped) return false;
  if (/^(?:LTM|\(LTM\))$/i.test(stripped)) return true;
  return null;
}

// ─── inferYearFromSiblings ───────────────────────────────────

/**
 * Look at every period OTHER than `target` in the same bucket and decide
 * whether they unambiguously identify a single calendar year. If so, that
 * year is returned and the caller can rewrite a bare "YTD Total" label to
 * "YTD <year>" so the downstream merge collapses it.
 *
 * Returns `null` when:
 *   - There are no other siblings (no inference possible).
 *   - Sibling labels reference a mix of distinct years (ambiguous — could
 *     be a multi-year statement, do not collapse).
 *   - No sibling label exposes any 4-digit or 2-digit year.
 *
 * Year hunting:
 *   - Scans the raw `period` string of each sibling for tokens that look
 *     like a year. We accept 4-digit (2024-2099) and 2-digit (00-99) forms.
 *   - 2-digit years are folded to a 4-digit equivalent (`26` → `2026`)
 *     using a 20XX assumption — the same convention used elsewhere in the
 *     codebase. This is intentional: financial spreadsheets rarely span
 *     before 1999 or after 2099 in practice.
 *   - All distinct years across all siblings are collected. If the set has
 *     exactly one element, that's the inferred year.
 */
export function inferYearFromSiblings(
  periods: FinancialPeriod[],
  target: FinancialPeriod,
): number | null {
  const years = new Set<number>();
  for (const p of periods) {
    if (p === target) continue;
    const label = String(p.period ?? '');
    if (!label) continue;
    // Match 4-digit years first (2024-2099 range).
    const fourDigit = label.match(/\b(20\d{2})\b/g);
    if (fourDigit) {
      for (const y of fourDigit) years.add(parseInt(y, 10));
    }
    // Then 2-digit years embedded in tokens like "FY26", "Jan-26", "26 YTD".
    // Avoid double-counting when a 4-digit year has already been pulled out
    // (e.g. "2026 YTD" should not contribute year 20 from the leading "20").
    const stripped = label.replace(/\b20\d{2}\b/g, '');
    const twoDigit = stripped.match(/(?:FY|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|YTD|H1|H2|Q[1-4])[\s\-']?(\d{2})\b/gi);
    if (twoDigit) {
      for (const m of twoDigit) {
        const yyMatch = m.match(/(\d{2})$/);
        if (!yyMatch) continue;
        const yy = parseInt(yyMatch[1], 10);
        years.add(2000 + yy);
      }
    }
    // Also pick up trailing "<year> YTD" / "<year> FY" forms (already
    // covered by 4-digit branch above, but 2-digit could appear like
    // "26 YTD" as a sibling). The regex above handles those too.
  }
  if (years.size === 1) {
    const [only] = Array.from(years);
    return only;
  }
  return null;
}

// ─── dedupePeriods ────────────────────────────────────────────

/**
 * Within a single (statementType, periodType) bucket, merge periods whose
 * normalised labels collide.
 *
 * Merge strategy when two rows collide:
 *   1. Higher `confidence` wins: that row's lineItems become the base.
 *   2. Tie on confidence → row with more non-null fields wins.
 *   3. Final tie → first occurrence wins.
 *   4. Whichever side did NOT win contributes line-item KEYS the winner is
 *      missing (i.e. fill nulls / fill new keys from loser).
 *   5. Output `period` label preserves the casing of the first occurrence
 *      whose normalised form == the canonical key.
 *   6. Output `confidence` is the MAX of the two.
 *
 * Pre-pass:
 *   - Bare "YTD Total" labels (no year) are rewritten to "YTD <year>" when
 *     all sibling rows in the same bucket reference one and only one year.
 *     See `inferYearFromSiblings`.
 *
 * The function operates on a single bucket. Callers should bucket inputs
 * by (statementType, periodType) before calling — see `dedupeStatement`.
 */
export function dedupePeriods(periods: FinancialPeriod[]): FinancialPeriod[] {
  if (periods.length <= 1) return periods;

  // ─── Pre-pass: infer year for bare "YTD Total" rows ───────────
  //
  // We need a copy of the bucket so the pre-pass is non-destructive on the
  // input; downstream we work on this rewritten array.
  const prepass: FinancialPeriod[] = periods.map(p => ({ ...p }));
  for (const p of prepass) {
    const norm = normalizePeriodLabel(p.period);
    if (norm.toLowerCase() !== 'ytd total') continue;
    const inferred = inferYearFromSiblings(prepass, p);
    if (inferred == null) continue;
    const newLabel = `YTD ${inferred}`;
    log.info(
      `Period dedup: inferred year for 'YTD Total' from siblings → '${newLabel}'`,
    );
    p.period = newLabel;
  }

  // ─── Main pass: collide on normalised label ──────────────────
  //
  // Group by case-insensitive normalised label. We also track every label
  // that fell into each bucket so we can emit a per-merge log line that
  // names the originals the user might recognise from their CIM.
  const byKey = new Map<string, FinancialPeriod>();
  const firstLabel = new Map<string, string>();
  const originals = new Map<string, string[]>();

  for (const p of prepass) {
    const norm = normalizePeriodLabel(p.period);
    const key = norm.toLowerCase();
    if (!key) continue;

    const seen = originals.get(key) ?? [];
    seen.push(p.period);
    originals.set(key, seen);

    if (!byKey.has(key)) {
      byKey.set(key, { ...p, period: norm, lineItems: { ...p.lineItems } });
      firstLabel.set(key, norm);
      continue;
    }

    // Collision — merge.
    const existing = byKey.get(key)!;
    const merged = mergeTwoPeriods(existing, p);
    // Preserve first-seen normalised label.
    merged.period = firstLabel.get(key)!;
    byKey.set(key, merged);
  }

  // ─── Post-pass: per-merge log lines ──────────────────────────
  for (const [key, labels] of originals.entries()) {
    if (labels.length <= 1) continue;
    const canonical = firstLabel.get(key) ?? key;
    const distinct = Array.from(new Set(labels.map(l => `'${l}'`)));
    log.info(
      `Period dedup: merged ${distinct.join(' + ')} into '${canonical}' ` +
        `(${labels.length} → 1, kept highest-confidence values)`,
    );
  }

  return Array.from(byKey.values());
}

/** Pick a winner between two periods using the documented strategy. */
function mergeTwoPeriods(a: FinancialPeriod, b: FinancialPeriod): FinancialPeriod {
  const aConf = a.confidence ?? 0;
  const bConf = b.confidence ?? 0;
  const aNonNull = countNonNull(a.lineItems);
  const bNonNull = countNonNull(b.lineItems);

  let winner: FinancialPeriod;
  let loser: FinancialPeriod;
  if (bConf > aConf) {
    winner = b; loser = a;
  } else if (aConf > bConf) {
    winner = a; loser = b;
  } else if (bNonNull > aNonNull) {
    winner = b; loser = a;
  } else {
    // ties → first occurrence wins (a was added first in caller)
    winner = a; loser = b;
  }

  // Union of keys: winner's values dominate, loser fills holes/missing keys.
  const items: Record<string, number | null> = { ...loser.lineItems };
  for (const [k, v] of Object.entries(winner.lineItems)) {
    if (v !== null && v !== undefined) {
      items[k] = v;
    } else if (!(k in items)) {
      items[k] = v;
    }
  }
  // Preserve _source citation strings on either side without overwriting
  // truthy strings with null.
  for (const [k, v] of Object.entries(loser.lineItems)) {
    if (k.endsWith('_source') && typeof v === 'string' && !items[k]) {
      (items as any)[k] = v;
    }
  }

  return {
    period: winner.period,
    periodType: winner.periodType,
    lineItems: items,
    confidence: Math.max(aConf, bConf),
  };
}

function countNonNull(items: Record<string, number | null>): number {
  let n = 0;
  for (const v of Object.values(items)) {
    if (v !== null && v !== undefined) n++;
  }
  return n;
}

// ─── Statement-level helper ──────────────────────────────────

/**
 * Dedup all periods within one statement, bucketing by `periodType` so we
 * never collapse e.g. "FY26 Est" (PROJECTED) with a "FY26" HISTORICAL.
 * Logs a single info line per statement summarising the reduction.
 */
export function dedupeStatementPeriods(
  statementType: StatementType,
  periods: FinancialPeriod[],
): FinancialPeriod[] {
  if (periods.length <= 1) return periods;

  const buckets = new Map<PeriodType, FinancialPeriod[]>();
  for (const p of periods) {
    const arr = buckets.get(p.periodType) ?? [];
    arr.push(p);
    buckets.set(p.periodType, arr);
  }

  const out: FinancialPeriod[] = [];
  let droppedTotal = 0;
  for (const [, group] of buckets) {
    const before = group.length;
    const deduped = dedupePeriods(group);
    droppedTotal += (before - deduped.length);
    out.push(...deduped);
  }

  if (droppedTotal > 0) {
    log.info(
      `Period dedup: ${periods.length} input → ${out.length} output (dropped ${droppedTotal} duplicates)`,
      { statementType },
    );
  }

  return out;
}

// ─── Statement-level dedup (merges same statementType siblings) ────────────

/**
 * Collapse multiple `ClassifiedStatement` entries of the same `statementType`
 * into one merged statement. The classifier sometimes emits a separate
 * statement object per source section (e.g. one `BALANCE_SHEET` for working
 * capital, another for AR/AP, another for fixed assets). Each section may
 * carry overlapping period labels (e.g. all four reference "2026-03-31").
 *
 * If we hand that raw list to the upserter, every period whose
 * `(dealId, statementType, period, documentId)` key collides with a sibling
 * statement's period will overwrite the previously-stored row's `lineItems`
 * column wholesale — we end up with N upserts mapping to the same DB row, so
 * only the LAST-iterated section's keys survive. Bug observed in production
 * (LangSmith trace 2026-05-07 11:16:10): four BALANCE_SHEET sections all
 * referencing "2026-03-31" upserted to the same UUID; the final row only
 * carried `other_current_liabilities` because the deferred-revenue section
 * was processed last.
 *
 * Strategy:
 *   1. Bucket statements by `statementType`.
 *   2. Within a bucket, concatenate all `periods` arrays.
 *   3. Run the existing per-period dedup (`dedupeStatementPeriods`) which
 *      already knows how to merge two `FinancialPeriod` values whose labels
 *      collide — line-item KEYS from each side are unioned, with higher-
 *      confidence values winning per key. That's exactly the behaviour we
 *      want when two sibling statements describe different facets of the
 *      same period.
 *   4. Merge `unitScale` / `currency` from the first occurrence — these are
 *      already deterministic per file (the LLM doesn't switch units mid-
 *      document) so first-wins is fine.
 *
 * Logs a per-merge info line when a `statementType` had >1 source statement.
 */
export function mergeStatementsBySameType(
  statements: ClassifiedStatement[],
): ClassifiedStatement[] {
  if (statements.length <= 1) return statements;

  const byType = new Map<StatementType, ClassifiedStatement[]>();
  for (const s of statements) {
    const arr = byType.get(s.statementType) ?? [];
    arr.push(s);
    byType.set(s.statementType, arr);
  }

  const merged: ClassifiedStatement[] = [];
  for (const [statementType, group] of byType.entries()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }

    // Multiple statements of the same type — concatenate periods then dedup.
    const allPeriods: FinancialPeriod[] = [];
    for (const s of group) {
      for (const p of s.periods) allPeriods.push(p);
    }
    const dedupedPeriods = dedupeStatementPeriods(statementType, allPeriods);

    log.info(
      `Statement merge: ${group.length} ${statementType} statements → 1 ` +
        `(${allPeriods.length} input periods → ${dedupedPeriods.length} after dedup)`,
      {
        statementType,
        sourceCount: group.length,
        inputPeriods: allPeriods.length,
        outputPeriods: dedupedPeriods.length,
      },
    );

    // First-wins for unitScale/currency — see header comment.
    merged.push({
      statementType,
      unitScale: group[0].unitScale,
      currency: group[0].currency,
      periods: dedupedPeriods,
    });
  }

  return merged;
}
