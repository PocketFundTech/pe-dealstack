// Cached results for every formula in the model workbook.
//
// The workbook is live formulas on purpose (change an input, the returns
// move). But a formula cell with no cached result is BLANK in anything that
// doesn't recalculate on open: Excel's Protected View (every downloaded file
// opens in it), Mac Quick Look / Preview, Gmail / WhatsApp / Slack previews,
// the iOS Files app. That is how the team's first model export looked
// "mostly empty". So we evaluate every formula here and store the value next
// to it; Excel still recalculates on load (fullCalcOnLoad).

import type ExcelJS from 'exceljs';
import FormulaParser, { type CellRef, type Param, type RangeRef } from 'fast-formula-parser';

const { FormulaError, FormulaHelpers: H, Types } = FormulaParser;

type Scalar = number | string | boolean | undefined;
/** A formula the parser itself choked on (not an Excel error value). */
const UNEVALUATED = Symbol('unevaluated');

/** Numbers in the arguments, the way MIN / MAX / NPV read them (text and blanks in ranges are skipped). */
function numbers(params: Param[]): number[] {
  const out: number[] = [];
  for (const p of params) {
    if (p.isRangeRef || p.isArray || p.isCellRef) {
      for (const v of H.flattenDeep(p.isCellRef ? [p.value] : p.value)) if (typeof v === 'number') out.push(v);
    } else if (!p.omitted) {
      out.push(H.accept(p, Types.NUMBER) as number);
    }
  }
  return out;
}

/** Excel's IRR: Newton from 10%, falling back to bisection. */
export function irr(flows: number[]): number {
  if (!flows.some((v) => v > 0) || !flows.some((v) => v < 0)) throw FormulaError.NUM;
  const npv = (r: number) => flows.reduce((s, v, i) => s + v / (1 + r) ** i, 0);
  let r = 0.1;
  for (let i = 0; i < 50; i++) {
    const f = npv(r);
    const d = flows.reduce((s, v, k) => s - (k * v) / (1 + r) ** (k + 1), 0);
    if (!Number.isFinite(f) || !Number.isFinite(d) || d === 0) break;
    const next = r - f / d;
    if (Math.abs(next - r) < 1e-10) return next;
    if (next <= -1) break;
    r = next;
  }
  let lo = -0.9999, hi = 10;
  if (Math.sign(npv(lo)) === Math.sign(npv(hi))) throw FormulaError.NUM;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (Math.sign(npv(mid)) === Math.sign(npv(lo))) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Functions the workbook uses that the parser leaves unimplemented (or lacks).
const RAW_FUNCTIONS: Record<string, (...params: Param[]) => unknown> = {
  MIN: (...p) => { const n = numbers(p); return n.length ? Math.min(...n) : 0; },
  MAX: (...p) => { const n = numbers(p); return n.length ? Math.max(...n) : 0; },
  // CHOOSE is on the parser's hardcoded funsNeedContext list, so it's always
  // called (context, ...args) regardless of whose implementation runs —
  // overriding it without taking the leading context arg shifts every
  // argument by one (the index becomes the parser instance).
  CHOOSE: (_context, idx, ...values) => {
    const i = Math.trunc(H.accept(idx, Types.NUMBER) as number);
    if (i < 1 || i > values.length) throw FormulaError.VALUE;
    return H.accept(values[i - 1]);
  },
  // INDEX is also on the context list, and gets its arguments UNRESOLVED.
  // The built-in returned a reference that lost its sheet, so
  // INDEX(Projections!C5:G5,1,n) on Returns read Returns!C5:G5 — blank — and
  // exit EBITDA / EV / IRR were cached as 0 / "n/a" (found by the
  // workbook-vs-preview parity test). This resolves the range through our
  // own onRange (sheet-aware) and returns the value. The workbook only uses
  // the value form: INDEX(row range, 1, n).
  INDEX: (context, range, rowNum, colNum) => {
    const ctx = context as unknown as { utils: { extractRefValue: (x: unknown) => { val: unknown } } };
    const num = (p: unknown, dflt: number) =>
      p == null ? dflt : Math.trunc(H.accept({ value: ctx.utils.extractRefValue(p).val } as Param, Types.NUMBER) as number);
    const val = ctx.utils.extractRefValue(range).val;
    const rows = Array.isArray(val) ? (val as unknown[][]) : [[val]];
    let r = num(rowNum, 1);
    let c = num(colNum, 1);
    // Excel: INDEX(one-row range, n) is the n-th column.
    if (colNum == null && rows.length === 1) { c = r; r = 1; }
    if (r < 1 || c < 1 || r > rows.length || c > (rows[r - 1]?.length ?? 0)) throw FormulaError.REF;
    return rows[r - 1][c - 1] ?? 0;
  },
  // Exact match only (match type 0) — the only form the workbook writes.
  MATCH: (lookup, range) => {
    const want = H.accept(lookup);
    const norm = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);
    const at = H.flattenDeep(range.value).findIndex((v) => norm(v) === norm(want));
    if (at < 0) throw FormulaError.NA;
    return at + 1;
  },
  IRR: (values) => irr(numbers([values])),
  NPV: (rate, ...values) => {
    const r = H.accept(rate, Types.NUMBER) as number;
    return numbers(values).reduce((s, v, i) => s + v / (1 + r) ** (i + 1), 0);
  },
};

// The parser's grammar swallows any exception a custom function throws and
// re-wraps it as a generic FormulaError('#ERROR!'), losing the real message
// and stack. Surface it during development with CALC_DEBUG=1.
const FUNCTIONS: Record<string, (...params: Param[]) => unknown> = process.env.CALC_DEBUG
  ? Object.fromEntries(Object.entries(RAW_FUNCTIONS).map(([name, fn]) => [name, (...args: Param[]) => {
      try {
        return fn(...args);
      } catch (e) {
        if (!(e instanceof FormulaError)) console.error(`[calc] ${name} threw`, e);
        throw e;
      }
    }]))
  : RAW_FUNCTIONS;

function isFormula(v: unknown): v is ExcelJS.CellFormulaValue {
  return !!v && typeof v === 'object' && 'formula' in v;
}

/**
 * Evaluates every formula in the workbook and stores its value as the cell's
 * cached result. Returns the addresses it could not evaluate (left uncached,
 * so Excel computes them on open as before).
 */
export function fillCachedResults(wb: ExcelJS.Workbook): string[] {
  const memo = new Map<string, Scalar | InstanceType<typeof FormulaError> | typeof UNEVALUATED>();
  const visiting = new Set<string>();
  const failed: string[] = [];

  const value = (sheet: string, row: number, col: number): unknown => {
    const cell = wb.getWorksheet(sheet)?.findCell(row, col);
    const v = cell?.value;
    if (isFormula(v)) {
      const r = evaluate(sheet, row, col, v.formula);
      if (r === UNEVALUATED) throw new Error(`depends on ${sheet}!${row},${col}, which could not be evaluated`);
      return r;
    }
    if (v == null || v === '') return undefined;
    if (typeof v === 'object' && 'richText' in v) return v.richText.map((t) => t.text).join('');
    return v;
  };

  // One parser per RECURSION DEPTH, not a single shared instance.
  //
  // Evaluating a cell's dependencies (via onCell/onRange below) recursively
  // calls evaluate() again, and the parser mutates shared internal
  // lexer/parse state (this.parser.input) while it's still mid-parse. Two
  // calls reentering the SAME instance corrupt that state — the outer parse
  // resumes with the inner call's tokens and fails with a lexer error, which
  // the library reports as a generic, unhelpful '#ERROR!'. A fresh instance
  // per call is reentrancy-safe but, with thousands of formula cells and
  // deep dependency chains, noticeably slow (each construction is cheap —
  // ~1ms — but they stack up); a pool indexed by depth gives every nesting
  // level its own instance, reusing it across sibling calls at that depth,
  // which is still reentrancy-safe (two calls at the same depth never run
  // concurrently — JS is single-threaded and this is synchronous) and keeps
  // the pool as small as the model's dependency chain is deep.
  const makeParser = () => new FormulaParser({
    onCell: (ref: CellRef) => value(ref.sheet!, ref.row, ref.col),
    onRange: (ref: RangeRef) => {
      const rows: unknown[][] = [];
      for (let r = ref.from.row; r <= ref.to.row; r++) {
        const row: unknown[] = [];
        for (let c = ref.from.col; c <= ref.to.col; c++) row.push(value(ref.sheet!, r, c));
        rows.push(row);
      }
      return rows;
    },
    functions: FUNCTIONS,
  });
  const parserPool: Array<ReturnType<typeof makeParser>> = [];
  let depth = 0;

  function evaluate(sheet: string, row: number, col: number, formula: string) {
    const key = `${sheet}!${row},${col}`;
    if (memo.has(key)) return memo.get(key);
    if (visiting.has(key)) throw FormulaError.REF; // circular — the model has none, but never loop
    visiting.add(key);
    const parser = (parserPool[depth] ??= makeParser());
    let result: Scalar | InstanceType<typeof FormulaError> | typeof UNEVALUATED;
    depth += 1;
    try {
      result = parser.parse(formula, { sheet, row, col }) as Scalar;
    } catch (e) {
      result = e instanceof FormulaError ? e : UNEVALUATED;
    } finally {
      depth -= 1;
    }
    visiting.delete(key);
    memo.set(key, result);
    return result;
  }

  for (const ws of wb.worksheets) {
    ws.eachRow((r, rowNumber) => r.eachCell((cell, colNumber) => {
      const v = cell.value;
      if (!isFormula(v)) return;
      const result = evaluate(ws.name, rowNumber, colNumber, v.formula);
      if (result === UNEVALUATED) {
        failed.push(`${ws.name}!${cell.address}`);
        return;
      }
      // ExcelJS's `cell.value = {formula, result}` setter silently drops a
      // falsy `result` (e.g. 0, "") — it copies the model via a truthy
      // check. Set the formula first, then write the result straight onto
      // the live model object `cell.model` returns (not a copy) to avoid it.
      cell.value = { formula: v.formula } as ExcelJS.CellFormulaValue;
      (cell.model as ExcelJS.CellFormulaValue).result =
        result instanceof FormulaError ? ({ error: result.error } as ExcelJS.CellErrorValue) : (result ?? 0);
    }));
  }
  return failed;
}
