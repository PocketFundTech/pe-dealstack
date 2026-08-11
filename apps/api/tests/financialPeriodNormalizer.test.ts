/**
 * Period Normalizer — Unit Tests
 * ==============================
 *
 * Coverage matrix for `normalizePeriodLabel`:
 *
 *   - Month-year canonicalisation:      `Apr-26`, `2026-04`, `April 2026`, …
 *   - Month-year LTM canonicalisation:  `Apr-26 LTM`, `2026-04_LTM`, …
 *   - Quarter canonicalisation:         `Q1-26`, `1Q26`, `Q1 2026`, …
 *   - Half canonicalisation:            `H1-26`, `1H26`, `H1 2026`, …
 *   - Quarters and months never alias.
 *   - All 12 months map correctly (loop).
 *   - 4-digit and 2-digit year forms agree.
 *   - Case-insensitive month name matching.
 *   - Numeric month-first ordering (`01-2026` → `Jan 2026`).
 *
 * Regression coverage:
 *   - FY-Est rules (`FY26 Estimated`, `2026 FY Est` → `FY26 Est`)
 *   - YTD rules (`2026 YTD`, `YTD Total (…2026)` → `YTD 2026`)
 *   - Trailing-punctuation strip (`Apr-26.` → `Apr 2026`)
 *   - Empty string round-trips
 *
 * Untouched (intentional pass-through):
 *   - `Current_Month_Range` / `Current Period` / `Current` — these are
 *     LLM-synthesised placeholders and intentionally do NOT collide with
 *     any real period (see normalizer source for rationale).
 *   - Unknown labels.
 *   - Year shapes that aren't 2-digit or 4-digit (e.g. `Feb-130`).
 */

import { describe, it, expect } from 'vitest';
import { normalizePeriodLabel } from '../src/services/financialPeriodNormalizer.js';

// ─── Month-year canonicalisation (Apr 2026 family) ──────────────

describe('normalizePeriodLabel — month-year canonicalisation', () => {
  it.each([
    ['Apr-26', 'Apr 2026'],
    ['Apr 26', 'Apr 2026'],
    ['Apr-2026', 'Apr 2026'],
    ['Apr 2026', 'Apr 2026'],
    ['April 2026', 'Apr 2026'],
    ['April-2026', 'Apr 2026'],
    ['2026-04', 'Apr 2026'],
    ['2026/04', 'Apr 2026'],
    ['2026.04', 'Apr 2026'],
    ['04-2026', 'Apr 2026'],
    ['04/2026', 'Apr 2026'],
    ['2026-4', 'Apr 2026'],     // no zero-pad
    ['4-2026', 'Apr 2026'],     // no zero-pad, month-first
  ])('folds %j → %j', (input, expected) => {
    expect(normalizePeriodLabel(input)).toBe(expected);
  });

  it('is case-insensitive (apr-26, APR-26, Apr-26 all fold)', () => {
    expect(normalizePeriodLabel('apr-26')).toBe('Apr 2026');
    expect(normalizePeriodLabel('APR-26')).toBe('Apr 2026');
    expect(normalizePeriodLabel('Apr-26')).toBe('Apr 2026');
    expect(normalizePeriodLabel('APRIL 2026')).toBe('Apr 2026');
    expect(normalizePeriodLabel('april 2026')).toBe('Apr 2026');
  });

  it('all ten Apr-26 variants normalise identically', () => {
    const variants = [
      'Apr-26', 'Apr 26', 'Apr-2026', 'Apr 2026', 'April 2026',
      'April-2026', '2026-04', '2026/04', '04-2026', 'apr-26',
    ];
    const normalized = variants.map(normalizePeriodLabel);
    const distinct = new Set(normalized);
    expect(distinct.size).toBe(1);
    expect(distinct.has('Apr 2026')).toBe(true);
  });
});

// ─── Month-year LTM canonicalisation ─────────────────────────────

describe('normalizePeriodLabel — month-year LTM canonicalisation', () => {
  it.each([
    ['Apr-26 LTM', 'Apr 2026 LTM'],
    ['Apr-26 (LTM)', 'Apr 2026 LTM'],
    ['2026-04_LTM', 'Apr 2026 LTM'],
    ['2026-04-LTM', 'Apr 2026 LTM'],
    ['April 2026 LTM', 'Apr 2026 LTM'],
    ['Apr 26 LTM', 'Apr 2026 LTM'],
    ['Apr 2026 LTM', 'Apr 2026 LTM'],
    ['2026/04_LTM', 'Apr 2026 LTM'],
  ])('folds %j → %j', (input, expected) => {
    expect(normalizePeriodLabel(input)).toBe(expected);
  });

  it('LTM marker is case-insensitive', () => {
    expect(normalizePeriodLabel('Apr-26 ltm')).toBe('Apr 2026 LTM');
    expect(normalizePeriodLabel('Apr-26 Ltm')).toBe('Apr 2026 LTM');
    expect(normalizePeriodLabel('Apr-26 LTM')).toBe('Apr 2026 LTM');
  });

  it('all eight Apr-26 LTM variants normalise identically', () => {
    const variants = [
      'Apr-26 LTM', 'Apr-26 (LTM)', '2026-04_LTM', '2026-04-LTM',
      'April 2026 LTM', 'Apr 26 LTM', 'apr-26 ltm', 'APR-26 LTM',
    ];
    const normalized = variants.map(normalizePeriodLabel);
    const distinct = new Set(normalized);
    expect(distinct.size).toBe(1);
    expect(distinct.has('Apr 2026 LTM')).toBe(true);
  });

  it('LTM and non-LTM are NOT equal (must dedup separately)', () => {
    expect(normalizePeriodLabel('Apr-26')).not.toBe(normalizePeriodLabel('Apr-26 LTM'));
    expect(normalizePeriodLabel('Apr 2026')).not.toBe(normalizePeriodLabel('Apr 2026 LTM'));
    expect(normalizePeriodLabel('2026-04')).not.toBe(normalizePeriodLabel('2026-04_LTM'));
  });
});

// ─── Quarter canonicalisation ────────────────────────────────────

describe('normalizePeriodLabel — quarter canonicalisation', () => {
  it.each([
    ['Q1-26', 'Q1 2026'],
    ['Q1 26', 'Q1 2026'],
    ['Q1-2026', 'Q1 2026'],
    ['Q1 2026', 'Q1 2026'],
    ['1Q26', 'Q1 2026'],
    ['1Q 2026', 'Q1 2026'],
    ['1Q-26', 'Q1 2026'],
    ['q1-26', 'Q1 2026'],
    ['1q26', 'Q1 2026'],
  ])('folds %j → %j', (input, expected) => {
    expect(normalizePeriodLabel(input)).toBe(expected);
  });

  it('all 4 quarter numbers map correctly', () => {
    expect(normalizePeriodLabel('Q1-26')).toBe('Q1 2026');
    expect(normalizePeriodLabel('Q2-26')).toBe('Q2 2026');
    expect(normalizePeriodLabel('Q3-26')).toBe('Q3 2026');
    expect(normalizePeriodLabel('Q4-26')).toBe('Q4 2026');
    expect(normalizePeriodLabel('1Q26')).toBe('Q1 2026');
    expect(normalizePeriodLabel('4Q-2026')).toBe('Q4 2026');
  });

  it('LTM variant: Q1-26 LTM → Q1 2026 LTM', () => {
    expect(normalizePeriodLabel('Q1-26 LTM')).toBe('Q1 2026 LTM');
    expect(normalizePeriodLabel('Q1 2026 LTM')).toBe('Q1 2026 LTM');
    expect(normalizePeriodLabel('1Q26 LTM')).toBe('Q1 2026 LTM');
    expect(normalizePeriodLabel('Q1-26 (LTM)')).toBe('Q1 2026 LTM');
  });
});

// ─── Half canonicalisation ───────────────────────────────────────

describe('normalizePeriodLabel — half canonicalisation', () => {
  it.each([
    ['H1-26', 'H1 2026'],
    ['H1 26', 'H1 2026'],
    ['H1-2026', 'H1 2026'],
    ['H1 2026', 'H1 2026'],
    ['1H26', 'H1 2026'],
    ['1H 2026', 'H1 2026'],
    ['h1-26', 'H1 2026'],
    ['1h26', 'H1 2026'],
  ])('folds %j → %j', (input, expected) => {
    expect(normalizePeriodLabel(input)).toBe(expected);
  });

  it('both half numbers map correctly', () => {
    expect(normalizePeriodLabel('H1-26')).toBe('H1 2026');
    expect(normalizePeriodLabel('H2-26')).toBe('H2 2026');
    expect(normalizePeriodLabel('1H26')).toBe('H1 2026');
    expect(normalizePeriodLabel('2H26')).toBe('H2 2026');
  });

  it('LTM variant: H1-26 LTM → H1 2026 LTM', () => {
    expect(normalizePeriodLabel('H1-26 LTM')).toBe('H1 2026 LTM');
    expect(normalizePeriodLabel('H1 2026 LTM')).toBe('H1 2026 LTM');
    expect(normalizePeriodLabel('1H26 LTM')).toBe('H1 2026 LTM');
  });
});

// ─── No accidental folding between Q, H, and Mon ────────────────

describe('normalizePeriodLabel — no accidental folding', () => {
  it('Q1 ≠ Apr (must remain distinct)', () => {
    expect(normalizePeriodLabel('Q1 2026')).not.toBe(normalizePeriodLabel('Apr 2026'));
    expect(normalizePeriodLabel('Q1-26')).not.toBe(normalizePeriodLabel('Apr-26'));
  });

  it('H1 ≠ Jan (must remain distinct)', () => {
    expect(normalizePeriodLabel('H1 2026')).not.toBe(normalizePeriodLabel('Jan 2026'));
    expect(normalizePeriodLabel('H1-26')).not.toBe(normalizePeriodLabel('Jan-26'));
  });

  it('Q1 ≠ H1 (must remain distinct)', () => {
    expect(normalizePeriodLabel('Q1 2026')).not.toBe(normalizePeriodLabel('H1 2026'));
  });
});

// ─── All 12 months map correctly ─────────────────────────────────

describe('normalizePeriodLabel — all 12 months', () => {
  const MONTHS: Array<[string, string, string, string]> = [
    // [shortName, longName, shortNumeric, expectedCanonical]
    ['Jan', 'January', '01', 'Jan 2026'],
    ['Feb', 'February', '02', 'Feb 2026'],
    ['Mar', 'March', '03', 'Mar 2026'],
    ['Apr', 'April', '04', 'Apr 2026'],
    ['May', 'May', '05', 'May 2026'],
    ['Jun', 'June', '06', 'Jun 2026'],
    ['Jul', 'July', '07', 'Jul 2026'],
    ['Aug', 'August', '08', 'Aug 2026'],
    ['Sep', 'September', '09', 'Sep 2026'],
    ['Oct', 'October', '10', 'Oct 2026'],
    ['Nov', 'November', '11', 'Nov 2026'],
    ['Dec', 'December', '12', 'Dec 2026'],
  ];

  it.each(MONTHS)('short form %s-26 → %s', (short, _long, _num, expected) => {
    expect(normalizePeriodLabel(`${short}-26`)).toBe(expected);
  });

  it.each(MONTHS)('long form %s 2026 → %s', (_short, long, _num, expected) => {
    expect(normalizePeriodLabel(`${long} 2026`)).toBe(expected);
  });

  it.each(MONTHS)('numeric 2026-%s → %s', (_short, _long, num, expected) => {
    expect(normalizePeriodLabel(`2026-${num}`)).toBe(expected);
  });

  it.each(MONTHS)('numeric %s-2026 → %s', (_short, _long, num, expected) => {
    expect(normalizePeriodLabel(`${num}-2026`)).toBe(expected);
  });

  it('numeric month with no zero-pad: 1-2026 → Jan 2026', () => {
    expect(normalizePeriodLabel('1-2026')).toBe('Jan 2026');
    expect(normalizePeriodLabel('2026-1')).toBe('Jan 2026');
    expect(normalizePeriodLabel('9-2026')).toBe('Sep 2026');
    expect(normalizePeriodLabel('2026-9')).toBe('Sep 2026');
  });

  it('also accepts "sept" as Sep (common abbreviation)', () => {
    expect(normalizePeriodLabel('Sept 2026')).toBe('Sep 2026');
    expect(normalizePeriodLabel('sept-26')).toBe('Sep 2026');
  });
});

// ─── 4-digit and 2-digit year forms agree ─────────────────────────

describe('normalizePeriodLabel — year folding', () => {
  it('2-digit year folds to 20XX (`24` → `2024`)', () => {
    expect(normalizePeriodLabel('Mar-24')).toBe('Mar 2024');
    expect(normalizePeriodLabel('Mar-2024')).toBe('Mar 2024');
    expect(normalizePeriodLabel('Mar-24')).toBe(normalizePeriodLabel('Mar-2024'));
  });

  it('99 → 2099 (consistent 20XX assumption)', () => {
    expect(normalizePeriodLabel('Feb-99')).toBe('Feb 2099');
  });

  it('00 → 2000', () => {
    expect(normalizePeriodLabel('Jan-00')).toBe('Jan 2000');
  });

  it('all 4-digit and 2-digit pairs agree across the date format', () => {
    expect(normalizePeriodLabel('Apr-26')).toBe(normalizePeriodLabel('Apr-2026'));
    expect(normalizePeriodLabel('Q1-26')).toBe(normalizePeriodLabel('Q1-2026'));
    expect(normalizePeriodLabel('H1-26')).toBe(normalizePeriodLabel('H1-2026'));
    expect(normalizePeriodLabel('Apr-26 LTM')).toBe(normalizePeriodLabel('Apr-2026 LTM'));
  });
});

// ─── Specific spec callouts ──────────────────────────────────────

describe('normalizePeriodLabel — spec callouts', () => {
  it('01-2026 → Jan 2026', () => {
    expect(normalizePeriodLabel('01-2026')).toBe('Jan 2026');
  });

  it('March 2026 → Mar 2026', () => {
    expect(normalizePeriodLabel('March 2026')).toBe('Mar 2026');
  });

  it('Mar-2026 → Mar 2026', () => {
    expect(normalizePeriodLabel('Mar-2026')).toBe('Mar 2026');
  });
});

// ─── Defensive: invalid year shapes pass through ─────────────────

describe('normalizePeriodLabel — defensive', () => {
  it('3-digit "year" (Feb-130) is not folded — passes through', () => {
    expect(normalizePeriodLabel('Feb-130')).toBe('Feb-130');
  });

  it('5-digit "year" is not folded', () => {
    expect(normalizePeriodLabel('Feb-12345')).toBe('Feb-12345');
  });

  it('numeric month out of range (13) does not fold', () => {
    expect(normalizePeriodLabel('2026-13')).toBe('2026-13');
    expect(normalizePeriodLabel('13-2026')).toBe('13-2026');
  });

  it('all-2-digit "04-26" is ambiguous and passes through', () => {
    // We do not guess whether this is Apr-26 or 04-day of 26.
    expect(normalizePeriodLabel('04-26')).toBe('04-26');
  });
});

// ─── Untouched: LLM-synthesised placeholders ─────────────────────

describe('normalizePeriodLabel — Current_Month_Range pass-through', () => {
  it('Current_Month_Range passes through unchanged', () => {
    expect(normalizePeriodLabel('Current_Month_Range')).toBe('Current_Month_Range');
  });

  it('Current Month Range (spaces) passes through unchanged', () => {
    expect(normalizePeriodLabel('Current Month Range')).toBe('Current Month Range');
  });

  it('Current Period passes through unchanged', () => {
    expect(normalizePeriodLabel('Current Period')).toBe('Current Period');
  });

  it('bare "Current" passes through unchanged', () => {
    expect(normalizePeriodLabel('Current')).toBe('Current');
  });

  it('Current_Month_Range does NOT collide with Apr 2026 (they have different keys)', () => {
    expect(normalizePeriodLabel('Current_Month_Range')).not.toBe(normalizePeriodLabel('Apr 2026'));
  });
});

// ─── Untouched: unknown labels pass through ──────────────────────

describe('normalizePeriodLabel — unknown labels pass through', () => {
  it('Random Label passes through unchanged', () => {
    expect(normalizePeriodLabel('Random Label')).toBe('Random Label');
  });

  it('LTM alone (no date) passes through', () => {
    // Bare "LTM" with no date prefix — we cannot manufacture a year, so
    // pass through unchanged. This is consistent with the existing
    // pre-canonicalisation policy for rolling-period labels.
    expect(normalizePeriodLabel('LTM')).toBe('LTM');
  });

  it('TTM passes through unchanged', () => {
    expect(normalizePeriodLabel('TTM')).toBe('TTM');
  });

  it('a bare 4-digit year passes through unchanged', () => {
    expect(normalizePeriodLabel('2026')).toBe('2026');
  });
});

// ─── Regression: existing FY-Est rules ───────────────────────────

describe('normalizePeriodLabel — FY-Est regression', () => {
  it('FY26 Estimated → FY26 Est', () => {
    expect(normalizePeriodLabel('FY26 Estimated')).toBe('FY26 Est');
  });

  it('FY26 estimate → FY26 Est', () => {
    expect(normalizePeriodLabel('FY26 estimate')).toBe('FY26 Est');
  });

  it('FY26 Est. → FY26 Est', () => {
    expect(normalizePeriodLabel('FY26 Est.')).toBe('FY26 Est');
  });

  it('2026 FY Est → FY26 Est', () => {
    expect(normalizePeriodLabel('2026 FY Est')).toBe('FY26 Est');
  });

  it('2026 FY Estimated → FY26 Est', () => {
    expect(normalizePeriodLabel('2026 FY Estimated')).toBe('FY26 Est');
  });

  it('case-insensitive: fy26 est → FY26 Est', () => {
    expect(normalizePeriodLabel('fy26 est')).toBe('FY26 Est');
  });

  it('FY26 Forecast → FY26 Forecast (canonical casing only)', () => {
    expect(normalizePeriodLabel('FY26 forecast')).toBe('FY26 Forecast');
    expect(normalizePeriodLabel('fy26 BUDGET')).toBe('FY26 Budget');
  });
});

// ─── Regression: existing YTD rules ──────────────────────────────

describe('normalizePeriodLabel — YTD regression', () => {
  it('2026 YTD → YTD 2026', () => {
    expect(normalizePeriodLabel('2026 YTD')).toBe('YTD 2026');
  });

  it('YTD 2026 → YTD 2026 (case-only)', () => {
    expect(normalizePeriodLabel('ytd 2026')).toBe('YTD 2026');
    expect(normalizePeriodLabel('YTD 2026')).toBe('YTD 2026');
  });

  it('YTD Total (Jan-Apr 20, 2026) → YTD 2026', () => {
    expect(normalizePeriodLabel('YTD Total (Jan-Apr 20, 2026)')).toBe('YTD 2026');
  });

  it('YTD Total (no year in parens) → YTD Total', () => {
    expect(normalizePeriodLabel('YTD Total')).toBe('YTD Total');
    expect(normalizePeriodLabel('YTD Total ()')).toBe('YTD Total');
  });
});

// ─── Regression: trailing-punctuation strip ──────────────────────

describe('normalizePeriodLabel — trailing punctuation strip', () => {
  it('Apr-26. → Apr 2026', () => {
    expect(normalizePeriodLabel('Apr-26.')).toBe('Apr 2026');
  });

  it('Apr-26: → Apr 2026', () => {
    expect(normalizePeriodLabel('Apr-26:')).toBe('Apr 2026');
  });

  it('Apr-26,, → Apr 2026', () => {
    expect(normalizePeriodLabel('Apr-26,,')).toBe('Apr 2026');
  });

  it('FY26 Est., → FY26 Est', () => {
    expect(normalizePeriodLabel('FY26 Est.,')).toBe('FY26 Est');
  });
});

// ─── Edge: empty string & whitespace ─────────────────────────────

describe('normalizePeriodLabel — edges', () => {
  it('empty string → empty string', () => {
    expect(normalizePeriodLabel('')).toBe('');
  });

  it('whitespace-only string → empty string', () => {
    expect(normalizePeriodLabel('   ')).toBe('');
  });

  it('leading/trailing whitespace is trimmed', () => {
    expect(normalizePeriodLabel('  Apr-26  ')).toBe('Apr 2026');
  });

  it('internal whitespace runs collapse to a single space', () => {
    expect(normalizePeriodLabel('Apr   26')).toBe('Apr 2026');
    expect(normalizePeriodLabel('Q1   2026')).toBe('Q1 2026');
  });
});

// ─── Fiscal-year / calendar-year → bare year collapse ────────────
//
// Real extractions emit the spreadsheet's "FY2024" header AND a narrative
// "2024", producing two FinancialStatement rows for one fiscal year. These
// must normalise to the same key so dedup merges them.

describe('normalizePeriodLabel — FY/CY year collapses onto bare year', () => {
  it('FY2024 → 2024', () => {
    expect(normalizePeriodLabel('FY2024')).toBe('2024');
  });

  it('FY24 → 2024 (2-digit year folded to 20XX)', () => {
    expect(normalizePeriodLabel('FY24')).toBe('2024');
  });

  it('"FY 2024" (spaced) → 2024', () => {
    expect(normalizePeriodLabel('FY 2024')).toBe('2024');
  });

  it('"2024 FY" (year-first) → 2024', () => {
    expect(normalizePeriodLabel('2024 FY')).toBe('2024');
  });

  it('CY2024 → 2024', () => {
    expect(normalizePeriodLabel('CY2024')).toBe('2024');
  });

  it('case-insensitive: fy2024 / cy2024 → 2024', () => {
    expect(normalizePeriodLabel('fy2024')).toBe('2024');
    expect(normalizePeriodLabel('cy2024')).toBe('2024');
  });

  it('FY2024 and 2024 produce the SAME key (so they dedup)', () => {
    expect(normalizePeriodLabel('FY2024')).toBe(normalizePeriodLabel('2024'));
    expect(normalizePeriodLabel('FY2025')).toBe(normalizePeriodLabel('2025'));
    expect(normalizePeriodLabel('FY2023')).toBe(normalizePeriodLabel('2023'));
  });

  it('does NOT collapse estimate/forecast variants (they stay distinct projections)', () => {
    expect(normalizePeriodLabel('FY26 Est')).toBe('FY26 Est');
    expect(normalizePeriodLabel('FY26 Est')).not.toBe('2026');
    expect(normalizePeriodLabel('FY26 Forecast')).toBe('FY26 Forecast');
    expect(normalizePeriodLabel('2026 FY Est')).not.toBe('2026');
  });

  it('does NOT touch the estimate suffix "2026E" (distinct projected label)', () => {
    expect(normalizePeriodLabel('2026E')).toBe('2026E');
    expect(normalizePeriodLabel('2026E')).not.toBe('2026');
  });
});
