/**
 * excelStructureHints.ts
 *
 * Walks the structured grid produced by `excelFinancialExtractor` and emits
 * two explicit hint blocks that the LLM can use as anchors:
 *
 *   1. Period headers: which row carries the column→period map.
 *      Catches month-band, quarter-band, year-only, and mixed labels.
 *   2. Line-item rows: which row in column A maps to which canonical
 *      `LINE_ITEM_KEYS` key (revenue, ebitda, ebit, ebitda_margin_pct, …).
 *
 * Why this lives outside `excelFinancialExtractor.ts`:
 *   - The extractor file is bumping against the 500-line cap. Keeping the
 *     hint-detection helpers here lets each module stay focused.
 *   - These helpers are pure functions over the 2-D grid; they don't need
 *     to know how the grid was rendered or how the workbook was loaded.
 *
 * Output shape:
 *   - PeriodHint[]  — one entry per detected period column
 *   - LineItemHint[] — one entry per matched column-A label
 *   - unmatchedLabels — non-empty column-A strings that didn't match any
 *     canonical key (so the prompt can mention them and the LLM can
 *     decide whether they are headers or new line items).
 *
 * The block-formatting helpers (`formatPeriodHintBlock`,
 * `formatLineItemHintBlock`) produce the prompt-ready strings that
 * `extractionPrompt.buildExtractionPrompt` injects after the per-sheet
 * metadata header.
 */

import XLSX from 'xlsx';

// ─── Types ───────────────────────────────────────────────────────

export interface PeriodHint {
  /** 0-based column index. Column letter via XLSX.utils.encode_col(col). */
  col: number;
  /** Spreadsheet-style column letter (B, C, …, AA). */
  colLetter: string;
  /** Period label as it appears in the source (e.g. "Apr-23", "Q1 2024"). */
  label: string;
  /** Coarse type hint based on the label — does not anchor against today
   *  (the prompt's DATE CONTEXT block does that). Used here only so the
   *  hint block can flag obvious projected suffixes ("FY26E"). */
  classification: 'HISTORICAL_OR_PROJECTED' | 'PROJECTED_LIKELY' | 'LTM';
}

export interface LineItemHint {
  /** 0-based row index. */
  row: number;
  /** Original column-A label (verbatim, post-trim). */
  label: string;
  /** Canonical key from `LINE_ITEM_KEYS.{INCOME_STATEMENT,BALANCE_SHEET,CASH_FLOW}`. */
  canonicalKey: string;
  /** Which statement bucket the canonical key belongs to. */
  statement: 'INCOME_STATEMENT' | 'BALANCE_SHEET' | 'CASH_FLOW';
  /** Optional disambiguation note added to the prompt — e.g. why
   *  "Operating Income" maps to ebit and not ebitda. */
  note?: string;
}

export interface SheetStructureHints {
  /** Detected period header row (0-based) — null if no period band found. */
  periodRow: number | null;
  /** One PeriodHint per column with a recognisable period label. */
  periods: PeriodHint[];
  /** Canonical line-item rows in column A. */
  lineItems: LineItemHint[];
  /** Column-A labels that didn't match any canonical key — surfaced to
   *  the LLM so it can decide whether they are subheadings, comments,
   *  or new line items the extractor's regex bank doesn't yet know. */
  unmatchedLabels: { row: number; label: string }[];
}

// ─── Period Regex Bank ────────────────────────────────────────────

/**
 * Period-label regex bank. Order matters — most specific patterns first
 * so a label like "Q1 2024" doesn't accidentally match a generic year
 * regex. Each entry returns a coarse classification used by the prompt
 * formatter; the actual HISTORICAL/PROJECTED decision is made by the LLM
 * against today's date (see DATE CONTEXT in extractionPrompt.ts).
 */
const PERIOD_PATTERNS: Array<{
  pattern: RegExp;
  classify: (label: string) => PeriodHint['classification'];
}> = [
  // LTM / TTM marker — strongest specificity
  {
    pattern: /\b(LTM|TTM)\b/i,
    classify: () => 'LTM',
  },
  // Month-year: "Apr-23", "Apr 23", "April 2024", "Apr-2024"
  {
    pattern: /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)[\s\-/.]?\d{2,4}$/i,
    classify: () => 'HISTORICAL_OR_PROJECTED',
  },
  // Numeric month-year: "2024-04", "04-2024", "2024/4"
  {
    pattern: /^(20\d{2}|19\d{2})[\s\-/.](0?[1-9]|1[0-2])$|^(0?[1-9]|1[0-2])[\s\-/.](20\d{2}|19\d{2})$/,
    classify: () => 'HISTORICAL_OR_PROJECTED',
  },
  // Quarter labels: "Q1 2024", "Q1-24", "1Q24", "1Q 2026"
  {
    pattern: /^Q[1-4][\s\-/.]?\d{2,4}$|^[1-4]Q[\s\-/.]?\d{2,4}$/i,
    classify: (label: string) => /[EF]$|[Pp]roj|[Ee]st|[Ff]orecast/.test(label)
      ? 'PROJECTED_LIKELY'
      : 'HISTORICAL_OR_PROJECTED',
  },
  // Half-year: "H1 2024", "1H24", "H1-24"
  {
    pattern: /^H[12][\s\-/.]?\d{2,4}$|^[12]H[\s\-/.]?\d{2,4}$/i,
    classify: () => 'HISTORICAL_OR_PROJECTED',
  },
  // Year with explicit projected suffix: "2025E", "FY26E", "FY 2027 Est"
  {
    pattern: /^(FY\s?)?(20\d{2}|19\d{2}|\d{2})\s?(E|F|P|Est|Proj|Forecast|Budget)$|^(FY\s?)?(20\d{2}|19\d{2}|\d{2})\s+(E|F|P|Est|Proj|Forecast|Budget)$/i,
    classify: () => 'PROJECTED_LIKELY',
  },
  // Year with actual suffix: "2024A"
  {
    pattern: /^(FY\s?)?(20\d{2}|19\d{2}|\d{2})A$/i,
    classify: () => 'HISTORICAL_OR_PROJECTED',
  },
  // Bare year / FY year: "2024", "FY2024", "FY 2024"
  {
    pattern: /^(FY\s?)?(20\d{2}|19\d{2})$/i,
    classify: () => 'HISTORICAL_OR_PROJECTED',
  },
];

/**
 * Match a single cell's string against the period regex bank.
 * Returns the classification + a normalised label, or null if no match.
 */
export function classifyPeriodLabel(raw: unknown): PeriodHint['classification'] | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Strip surrounding parens/brackets the merge expansion sometimes leaves
  // ("(Q1 2024)") so the inner regex bank gets a clean match.
  const stripped = s.replace(/^[\[(]+|[\])]+$/g, '').trim();
  for (const { pattern, classify } of PERIOD_PATTERNS) {
    if (pattern.test(stripped)) return classify(stripped);
  }
  return null;
}

// ─── Period Row Detection ─────────────────────────────────────────

/**
 * Walk the grid top-down looking for the first row where ≥3 contiguous
 * columns (starting after column A) carry period labels.
 *
 * Three-column threshold: smaller than that and we risk false-matching
 * a single "FY 2024" merged banner that is really context, not the
 * period axis. Real spreadsheets we have seen always have at least 3
 * period columns side-by-side (3 monthly columns is the bare minimum
 * for a useful trailing-quarter view).
 *
 * Two-row headers (year banner + month band): the algorithm walks
 * row-by-row, so it will find the month-band row (the second one). The
 * year banner has only repeated values like "FY 2024 / FY 2024 / …" —
 * those count as period labels under our regex bank, but the SAME
 * banner string repeats in every column. The "≥3 contiguous *unique*
 * matches" guard would over-engineer this; we instead prefer the LATER
 * row when both a banner and a band match, by scoring rows further
 * down higher when they have more diversity. Implemented below as:
 * pick the row with the highest count of distinct period strings.
 */
export function detectPeriodRow(grid: unknown[][]): {
  row: number;
  periods: PeriodHint[];
} | null {
  if (grid.length === 0) return null;
  const maxCols = grid.reduce((m, r) => Math.max(m, r.length), 0);

  let bestRow = -1;
  let bestPeriods: PeriodHint[] = [];
  let bestDistinctCount = 0;

  // Cap the scan at the first 12 rows — period headers should be near
  // the top (after a short title/unit-disclaimer block at most). Scanning
  // 1000 rows of data would mis-detect a stray date column inside the
  // P&L body as a "period header".
  const scanLimit = Math.min(grid.length, 12);

  for (let r = 0; r < scanLimit; r++) {
    const row = grid[r];
    if (!row) continue;
    const cells: PeriodHint[] = [];
    for (let c = 1; c < maxCols; c++) {
      const cls = classifyPeriodLabel(row[c]);
      if (cls === null) continue;
      cells.push({
        col: c,
        colLetter: XLSX.utils.encode_col(c),
        label: String(row[c]).trim(),
        classification: cls,
      });
    }
    // Require at least 3 *contiguous* matches to count as the period row.
    // A single "FY 2024" cell in row 1 is a banner, not the period axis.
    const contiguousRun = longestContiguousRun(cells);
    if (contiguousRun < 3) continue;

    const distinctCount = new Set(cells.map((p) => p.label)).size;
    // Prefer rows with more distinct labels (the actual month/quarter band
    // beats the year banner above it). On a tie, pick the lower row —
    // headers are typically two-row, with the period axis underneath.
    if (
      distinctCount > bestDistinctCount ||
      (distinctCount === bestDistinctCount && r > bestRow)
    ) {
      bestRow = r;
      bestPeriods = cells;
      bestDistinctCount = distinctCount;
    }
  }

  if (bestRow === -1) return null;
  return { row: bestRow, periods: bestPeriods };
}

/** Length of the longest run of column indices that are contiguous in a
 *  sorted column list. Helps reject single-cell banners from counting
 *  as a "period band". */
function longestContiguousRun(cells: PeriodHint[]): number {
  if (cells.length === 0) return 0;
  const cols = cells.map((p) => p.col).sort((a, b) => a - b);
  let best = 1;
  let run = 1;
  for (let i = 1; i < cols.length; i++) {
    if (cols[i] === cols[i - 1] + 1) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 1;
    }
  }
  return best;
}

// ─── Line-Item Label Classification ───────────────────────────────

/**
 * Canonical key bank. Order matters — more-specific patterns FIRST so
 * "EBITDA Margin" doesn't get classified as "ebitda". The regexes are
 * tested against a normalised label (lower-case, punctuation stripped,
 * whitespace collapsed) returned by `normaliseLabel`.
 *
 * Each entry encodes a single regex → canonical key mapping plus a
 * statement bucket and an optional disambiguation note that the prompt
 * formatter surfaces when there is a known mis-mapping risk.
 */
const LINE_ITEM_PATTERNS: Array<{
  pattern: RegExp;
  key: string;
  statement: LineItemHint['statement'];
  note?: string;
}> = [
  // ── Income statement — ratios / margins (must run BEFORE the dollar rows) ──
  { pattern: /^gross\s*margin(\s*pct|\s*%|\s*percent)?$/, key: 'gross_margin_pct', statement: 'INCOME_STATEMENT', note: 'percentage row, store as gross_margin_pct (NOT gross_profit)' },
  { pattern: /^ebitda\s*margin(\s*pct|\s*%|\s*percent)?$/, key: 'ebitda_margin_pct', statement: 'INCOME_STATEMENT', note: 'percentage row, store as ebitda_margin_pct (NOT ebitda)' },

  // ── Income statement — dollar rows ──
  { pattern: /^(total\s*)?(net\s*)?revenue$|^sales$|^turnover$|^total\s*sales$|^net\s*sales$/, key: 'revenue', statement: 'INCOME_STATEMENT' },
  { pattern: /^(total\s*)?cogs$|^cost\s*of\s*goods\s*sold$|^cost\s*of\s*sales$|^cost\s*of\s*revenue$/, key: 'cogs', statement: 'INCOME_STATEMENT' },
  { pattern: /^gross\s*profit$|^gross\s*income$/, key: 'gross_profit', statement: 'INCOME_STATEMENT' },
  { pattern: /^sg\s*&\s*a$|^sga$|^selling\s*general\s*(and|&)\s*administrative$|^s\s*g\s*and\s*a$/, key: 'sga', statement: 'INCOME_STATEMENT' },
  { pattern: /^r\s*&\s*d$|^rd$|^research\s*(and|&)\s*development$/, key: 'rd', statement: 'INCOME_STATEMENT' },
  { pattern: /^other\s*opex$|^other\s*operating\s*expense(s)?$/, key: 'other_opex', statement: 'INCOME_STATEMENT' },
  { pattern: /^total\s*opex$|^total\s*operating\s*expense(s)?$|^operating\s*expense(s)?$|^opex$/, key: 'total_opex', statement: 'INCOME_STATEMENT' },
  { pattern: /^ebitda$|^adjusted\s*ebitda$/, key: 'ebitda', statement: 'INCOME_STATEMENT' },
  { pattern: /^d\s*&\s*a$|^da$|^depreciation\s*(and|&)\s*amortization$|^depreciation\s*(and|&)\s*amortisation$/, key: 'da', statement: 'INCOME_STATEMENT' },
  // Operating Income / EBIT — note clarifies the classifier mistake we have
  // shipped historically: "Operating Income" maps to ebit, not ebitda.
  { pattern: /^operating\s*income$|^operating\s*profit$|^ebit$/, key: 'ebit', statement: 'INCOME_STATEMENT', note: 'NOT ebitda — operating_income maps to ebit (operating income is post-D&A)' },
  { pattern: /^interest\s*expense$|^interest$/, key: 'interest_expense', statement: 'INCOME_STATEMENT' },
  { pattern: /^ebt$|^earnings\s*before\s*tax(es)?$|^pretax\s*income$|^income\s*before\s*tax(es)?$/, key: 'ebt', statement: 'INCOME_STATEMENT' },
  { pattern: /^tax$|^taxes$|^income\s*tax(es)?$|^tax\s*expense$|^provision\s*for\s*tax(es)?$/, key: 'tax', statement: 'INCOME_STATEMENT' },
  { pattern: /^net\s*income$|^net\s*profit$|^net\s*earnings$/, key: 'net_income', statement: 'INCOME_STATEMENT' },
  { pattern: /^sde$|^sellers?\s*discretionary\s*earnings$/, key: 'sde', statement: 'INCOME_STATEMENT' },

  // ── Balance sheet ──
  { pattern: /^cash$|^cash\s*(and|&)\s*equivalents?$|^cash\s*(and|&)\s*cash\s*equivalents?$/, key: 'cash', statement: 'BALANCE_SHEET' },
  { pattern: /^accounts\s*receivable$|^a\s*\/?\s*r$|^trade\s*receivables?$|^receivables?$/, key: 'accounts_receivable', statement: 'BALANCE_SHEET' },
  { pattern: /^inventory$|^inventories$/, key: 'inventory', statement: 'BALANCE_SHEET' },
  { pattern: /^other\s*current\s*assets$/, key: 'other_current_assets', statement: 'BALANCE_SHEET' },
  { pattern: /^total\s*current\s*assets$/, key: 'total_current_assets', statement: 'BALANCE_SHEET' },
  { pattern: /^pp\s*&\s*e\s*(net|,?\s*net)?$|^ppe\s*net$|^net\s*pp\s*&\s*e$|^property,?\s*plant\s*(and|&)\s*equipment(\s*net)?$/, key: 'ppe_net', statement: 'BALANCE_SHEET' },
  { pattern: /^goodwill$/, key: 'goodwill', statement: 'BALANCE_SHEET' },
  { pattern: /^intangibles?$|^intangible\s*assets$/, key: 'intangibles', statement: 'BALANCE_SHEET' },
  { pattern: /^total\s*assets$/, key: 'total_assets', statement: 'BALANCE_SHEET' },
  { pattern: /^accounts\s*payable$|^a\s*\/?\s*p$|^trade\s*payables?$|^payables?$/, key: 'accounts_payable', statement: 'BALANCE_SHEET' },
  { pattern: /^short\s*[\-\s]?term\s*debt$|^current\s*(portion\s*of\s*)?debt$|^short\s*[\-\s]?term\s*borrowings$/, key: 'short_term_debt', statement: 'BALANCE_SHEET' },
  { pattern: /^other\s*current\s*liabilities$/, key: 'other_current_liabilities', statement: 'BALANCE_SHEET' },
  { pattern: /^total\s*current\s*liabilities$/, key: 'total_current_liabilities', statement: 'BALANCE_SHEET' },
  { pattern: /^long\s*[\-\s]?term\s*debt$|^lt\s*debt$|^long\s*[\-\s]?term\s*borrowings$/, key: 'long_term_debt', statement: 'BALANCE_SHEET' },
  { pattern: /^total\s*liabilities$/, key: 'total_liabilities', statement: 'BALANCE_SHEET' },
  { pattern: /^total\s*(stockholders?\s*|shareholders?\s*)?equity$|^equity$/, key: 'total_equity', statement: 'BALANCE_SHEET' },

  // ── Cash flow ──
  { pattern: /^operating\s*cf$|^operating\s*cash\s*flow$|^cash\s*from\s*operations$|^cash\s*flow\s*from\s*operations$|^cfo$/, key: 'operating_cf', statement: 'CASH_FLOW' },
  { pattern: /^capex$|^capital\s*expenditures?$/, key: 'capex', statement: 'CASH_FLOW' },
  { pattern: /^fcf$|^free\s*cash\s*flow$|^unlevered\s*free\s*cash\s*flow$/, key: 'fcf', statement: 'CASH_FLOW' },
  { pattern: /^acquisitions?$|^m\s*&\s*a$/, key: 'acquisitions', statement: 'CASH_FLOW' },
  { pattern: /^debt\s*repayment$|^repayment\s*of\s*debt$|^debt\s*paydown$/, key: 'debt_repayment', statement: 'CASH_FLOW' },
  { pattern: /^dividends?$|^dividend\s*paid?$/, key: 'dividends', statement: 'CASH_FLOW' },
  { pattern: /^net\s*change\s*(in\s*)?cash$|^change\s*in\s*cash$|^net\s*cash\s*flow$/, key: 'net_change_cash', statement: 'CASH_FLOW' },
];

/** Header bands the spreadsheet author types to break sections — they
 *  don't carry a value and shouldn't appear in the line-item map. */
const HEADER_BAND_PATTERNS: RegExp[] = [
  /^income\s*statement$/i,
  /^balance\s*sheet$/i,
  /^cash\s*flow(\s*statement)?$/i,
  /^profit\s*(and|&)\s*loss$/i,
  /^p\s*[&+]\s*l$/i,
  /^assets$|^liabilities$|^equity$/i,
  /^current\s*assets$|^current\s*liabilities$/i,
  /^operating\s*activities$|^investing\s*activities$|^financing\s*activities$/i,
  /^revenue\s*(breakdown|build)$|^ebitda\s*build$|^opex\s*(breakdown|build)$/i,
  /^historical$|^projected$|^forecast$|^actuals?$/i,
];

/**
 * Normalise a column-A label so the regex bank matches reliably:
 * lower-case, strip leading bullet/section markers ("1.", "•", " - "),
 * collapse internal whitespace, drop trailing colons and footnote
 * markers ("(1)").
 */
export function normaliseLabel(raw: unknown): string {
  if (raw == null) return '';
  let s = String(raw);
  // Drop any leading enumeration ("1.", "1)", " - ", "• ").
  s = s.replace(/^\s*([0-9]+[\.\)]\s*|[•\-\*]\s+)/g, '');
  // Drop trailing footnote markers like "(1)" or "*".
  s = s.replace(/\s*\([0-9]+\)\s*$|[\*]+$/g, '');
  // Drop trailing punctuation.
  s = s.replace(/[\s\.,;:]+$/g, '');
  // Lower-case + collapse internal whitespace.
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** True if the label is a section/header band (e.g. "INCOME STATEMENT"). */
export function isHeaderBand(label: string): boolean {
  return HEADER_BAND_PATTERNS.some((p) => p.test(label));
}

/**
 * Match a normalised column-A label against the canonical key bank.
 * Returns the first match, or null.
 *
 * Pattern-bank order encodes precedence: percentage rows (margin, %)
 * come BEFORE their dollar counterparts so that "EBITDA Margin" doesn't
 * fall through to the "ebitda" pattern. Operating Income → ebit comes
 * AFTER the EBITDA pattern (because "ebitda" doesn't match
 * "operating income").
 */
export function classifyLineItem(rawLabel: unknown): {
  key: string;
  statement: LineItemHint['statement'];
  note?: string;
} | null {
  const normalised = normaliseLabel(rawLabel);
  if (!normalised) return null;
  if (isHeaderBand(normalised)) return null;
  for (const { pattern, key, statement, note } of LINE_ITEM_PATTERNS) {
    if (pattern.test(normalised)) return { key, statement, note };
  }
  return null;
}

/** Walk column A (col 0) over the whole grid and emit a hint per labelled row. */
export function detectLineItems(grid: unknown[][]): {
  lineItems: LineItemHint[];
  unmatchedLabels: { row: number; label: string }[];
} {
  const lineItems: LineItemHint[] = [];
  const unmatchedLabels: { row: number; label: string }[] = [];

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    if (!row || row.length === 0) continue;
    const raw = row[0];
    if (raw == null || String(raw).trim() === '') continue;
    const label = String(raw).trim();
    const normalised = normaliseLabel(raw);
    if (isHeaderBand(normalised)) continue;
    const matched = classifyLineItem(raw);
    if (matched) {
      lineItems.push({
        row: r,
        label,
        canonicalKey: matched.key,
        statement: matched.statement,
        note: matched.note,
      });
    } else {
      unmatchedLabels.push({ row: r, label });
    }
  }
  return { lineItems, unmatchedLabels };
}

// ─── Sheet-level entry point + prompt formatters ──────────────────

/**
 * One-shot detection over a 2-D grid. Convenience wrapper used by the
 * Excel extractor — keeps the orchestration in one place so callers
 * don't have to wire up `detectPeriodRow` + `detectLineItems` themselves.
 */
export function detectSheetStructure(grid: unknown[][]): SheetStructureHints {
  const periodRowResult = detectPeriodRow(grid);
  const { lineItems, unmatchedLabels } = detectLineItems(grid);
  return {
    periodRow: periodRowResult?.row ?? null,
    periods: periodRowResult?.periods ?? [],
    lineItems,
    unmatchedLabels,
  };
}

/**
 * Render the period-headers block for the prompt. Keeping the formatter
 * here (vs in `extractionPrompt.ts`) means the prompt builder doesn't
 * need to know the hint schema — it just receives ready-made strings.
 */
export function formatPeriodHintBlock(periods: PeriodHint[]): string {
  if (periods.length === 0) return '';
  const lines: string[] = ['[Period headers detected]'];
  for (const p of periods) {
    // The prompt only needs the column letter + label + a coarse note.
    // The HISTORICAL/PROJECTED decision is made by the LLM against
    // today's date (DATE CONTEXT block). We surface "PROJECTED_LIKELY"
    // as a hint when the source uses an explicit suffix ("FY27E").
    const tag = p.classification === 'PROJECTED_LIKELY'
      ? ' (PROJECTED — explicit suffix)'
      : p.classification === 'LTM'
      ? ' (LTM)'
      : '';
    lines.push(`- Column ${p.colLetter}: ${p.label}${tag}`);
  }
  lines.push(`EXPECTED OUTPUT: emit one period per detected column above (${periods.length} periods). If you skip any, the validator will flag it.`);
  return lines.join('\n');
}

/**
 * Render the line-item rows block for the prompt. Includes
 * disambiguation notes for known mis-mapping risks (Operating Income
 * vs EBITDA, EBITDA Margin as a percentage row, etc.).
 */
export function formatLineItemHintBlock(
  lineItems: LineItemHint[],
  unmatchedLabels: { row: number; label: string }[],
): string {
  if (lineItems.length === 0 && unmatchedLabels.length === 0) return '';
  const lines: string[] = ['[Line item rows detected]'];
  for (const li of lineItems) {
    // Row numbers in the prompt are 1-based to match how spreadsheet
    // users count rows ("row 1 is the header"). Internal hint rows
    // are 0-based; we add 1 here for display only.
    const noteSuffix = li.note ? `  (${li.note})` : '';
    lines.push(`- Row ${li.row + 1}: ${li.label} → ${li.canonicalKey}${noteSuffix}`);
  }
  if (unmatchedLabels.length > 0) {
    lines.push('[Unmatched column-A labels — decide whether they are subheadings, comments, or new line items]');
    // Cap the unmatched list at 30 entries to keep the prompt small —
    // a sheet with 100 unmatched rows is almost certainly not a
    // financial statement, and dumping all 100 just bloats the prompt.
    for (const u of unmatchedLabels.slice(0, 30)) {
      lines.push(`- Row ${u.row + 1}: ${u.label}`);
    }
    if (unmatchedLabels.length > 30) {
      lines.push(`- … (${unmatchedLabels.length - 30} more unmatched labels)`);
    }
  }
  lines.push('LLM should use these row anchors when extracting values from the grid. Percentage rows (margin, %) MUST be stored under their _pct keys (e.g. ebitda_margin_pct), NOT under the dollar key.');
  return lines.join('\n');
}
