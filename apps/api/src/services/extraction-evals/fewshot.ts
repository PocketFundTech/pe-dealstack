/**
 * Few-shot bank for financial extraction — period hygiene.
 * ========================================================
 *
 * These exemplars + rules target the defects the eval harness measures
 * (cohort-labels-as-periods, duplicate fiscal years, a future year split into
 * HISTORICAL+PROJECTED rows). Pass `buildPeriodHygieneGuidance()` as
 * `buildExtractionPrompt({ extraGuidance })` to inject them.
 *
 * Workflow (per the extraction roadmap): run the harness WITHOUT this block to
 * capture a baseline, run it WITH the block, keep the block only if the scored
 * metrics improve. It is intentionally NOT wired into production by default —
 * flipping it on is a one-line change at the classifier call sites once the
 * harness confirms the delta.
 */

/**
 * Financial source authority.
 * ===========================
 *
 * When two documents extract the SAME period (e.g. a P&L spreadsheet and a CIM
 * both report 2024 revenue), which one owns the active FinancialStatement row?
 * Confidence alone is wrong — a polished CIM often scores HIGHER than the raw
 * spreadsheet, yet the spreadsheet is the authoritative financial record. So we
 * rank by SOURCE TYPE first: a dedicated financials spreadsheet outranks a
 * narrative deal doc (CIM / teaser / LOI), which outranks anything else.
 *
 * Mirrors the isFinancialDoc / isNarrativeDoc heuristic in
 * quantitativeReconciler.ts (type → mimeType → filename fallback) so the two
 * stay consistent.
 */

export interface DocAuthorityMeta {
  type?: string | null;
  mimeType?: string | null;
  name?: string | null;
}

export const SOURCE_AUTHORITY = {
  /** Dedicated financial statements — spreadsheet/CSV. Authoritative for numbers. */
  FINANCIAL_SHEET: 3,
  /** Narrative deal doc (CIM / teaser / LOI) — contains financials but secondary. */
  NARRATIVE: 2,
  /** Unknown / other. */
  OTHER: 1,
} as const;

/**
 * Rank a document as a source of financial numbers. Higher wins.
 * Pure and total — undefined/empty metadata ranks OTHER.
 */
export function financialSourceAuthorityRank(doc: DocAuthorityMeta | null | undefined): number {
  if (!doc) return SOURCE_AUTHORITY.OTHER;
  const t = (doc.type ?? '').toUpperCase();
  const m = (doc.mimeType ?? '').toLowerCase();
  const n = (doc.name ?? '').toLowerCase();

  // Financial spreadsheet — the authoritative numeric source.
  if (t === 'FINANCIALS' || t === 'EXCEL') return SOURCE_AUTHORITY.FINANCIAL_SHEET;
  if (m.includes('spreadsheet') || m.includes('excel') || m.includes('csv')) {
    return SOURCE_AUTHORITY.FINANCIAL_SHEET;
  }
  if (n.endsWith('.xlsx') || n.endsWith('.xls') || n.endsWith('.csv')) {
    return SOURCE_AUTHORITY.FINANCIAL_SHEET;
  }

  // Narrative deal documents — contain financials but are secondary to the sheet.
  if (t === 'CIM' || t === 'TEASER' || t === 'LOI') return SOURCE_AUTHORITY.NARRATIVE;
  if (m.includes('pdf') || m.includes('word') || m.includes('document')) {
    return SOURCE_AUTHORITY.NARRATIVE;
  }

  return SOURCE_AUTHORITY.OTHER;
}

/** Explicit period-hygiene rules — the deterministic lessons behind the bugs. */
export const PERIOD_HYGIENE_RULES = `PERIOD HYGIENE — READ CAREFULLY (these are the most common extraction errors):
- A "period" is a fiscal REPORTING span only: a year (2024), fiscal year (FY2024), quarter (Q1 2024), month (Apr 2024), or LTM/TTM. Emit ONE row per distinct fiscal span.
- Enrollment / cohort / season labels ("Fall 2026", "Spring 2027", "Summer 2025", cohort or class names) are NOT periods. They are revenue CHANNELS/segments. Capture them as sub-line-items (e.g. "revenue_fall26_cohort") under the fiscal period they belong to — never as their own period row.
- Do NOT emit the same fiscal year twice. "FY2024" and "2024" are the SAME period — emit it once. If the document shows a year in several places, merge into one period row.
- A full year whose end date is AFTER today is a SINGLE PROJECTED period (e.g. "2026E", periodType PROJECTED). Do NOT also emit a HISTORICAL "2026" row for the same year.`;

/** One input→output teaching example. */
export interface FewShotExample {
  title: string;
  input: string;
  /** The correct structured shape (abbreviated JSON) the model should emit. */
  output: string;
}

export const FEW_SHOT_EXAMPLES: FewShotExample[] = [
  {
    title: 'Cohort revenue model → channels within ONE projected year (not cohort periods)',
    input:
      'FY2026 projected revenue $476,600, built from enrollment cohorts: Fall 2026 classification $301,600; Onboarding pipeline $68,000; Spring 2026 additional $87,000; Spring 2027 onboarding $20,000.',
    output:
      '{ "period": "2026E", "periodType": "PROJECTED", "lineItems": { "revenue": 476600, "revenue_fall26_classification": 301600, "revenue_onboarding_pipeline": 68000, "revenue_spring26_additional": 87000, "revenue_spring27_onboarding": 20000 } }  // ONE period; cohorts are channels. No "Fall 2026"/"Spring 2027" period rows.',
  },
  {
    title: 'Same fiscal year shown as "FY2024" and "2024" → ONE period',
    input: 'P&L header row: "FY2024" with Total Revenue $390,558. Narrative: "in 2024 the company earned $390,558".',
    output:
      '{ "period": "2024", "periodType": "HISTORICAL", "lineItems": { "revenue": 390558 } }  // one row, not two (FY2024 == 2024).',
  },
];

/** Render the few-shot examples as a compact prompt block. */
export function formatFewShotBlock(examples: FewShotExample[] = FEW_SHOT_EXAMPLES): string {
  if (examples.length === 0) return '';
  const lines = examples.map(
    (e, i) => `Example ${i + 1} — ${e.title}\n  INPUT: ${e.input}\n  CORRECT: ${e.output}`,
  );
  return `EXAMPLES OF CORRECT PERIOD HANDLING:\n${lines.join('\n')}`;
}

/** Full guidance string to pass as `buildExtractionPrompt({ extraGuidance })`. */
export function buildPeriodHygieneGuidance(): string {
  return `${PERIOD_HYGIENE_RULES}\n\n${formatFewShotBlock()}`;
}

/**
 * Production A/B gate. Returns the period-hygiene guidance when the env flag
 * EXTRACTION_PERIOD_HYGIENE is truthy ("1"/"true"/"on"), else undefined.
 *
 * This lets the guidance be validated on a real deployment by flipping ONE env
 * var (e.g. in a Vercel preview) with no code change. Default OFF → the
 * extraction prompt is byte-for-byte unchanged, so turning it on is a clean
 * A/B: re-run the same document with the flag on vs off and compare.
 */
export function periodHygieneGuidanceIfEnabled(): string | undefined {
  const flag = (process.env.EXTRACTION_PERIOD_HYGIENE ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'on'
    ? buildPeriodHygieneGuidance()
    : undefined;
}
