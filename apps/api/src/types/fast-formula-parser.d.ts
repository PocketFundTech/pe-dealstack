// Minimal types for fast-formula-parser (the package ships none). Only what
// services/dealModel/workbook/calc.ts uses.
declare module 'fast-formula-parser' {
  export interface CellRef { sheet?: string; row: number; col: number }
  export interface RangeRef { sheet?: string; from: { row: number; col: number }; to: { row: number; col: number } }
  /** A function argument as the parser hands it over. */
  export interface Param { value: unknown; isCellRef?: boolean; isRangeRef?: boolean; isArray?: boolean; omitted?: boolean }

  export class FormulaError extends Error {
    static NA: FormulaError;
    static NUM: FormulaError;
    static VALUE: FormulaError;
    static REF: FormulaError;
    static DIV0: FormulaError;
    readonly error: string;
  }

  interface ParserOptions {
    onCell?: (ref: CellRef) => unknown;
    onRange?: (ref: RangeRef) => unknown[][];
    functions?: Record<string, (...params: Param[]) => unknown>;
  }

  interface FormulaParserStatic {
    new (options: ParserOptions): { parse(formula: string, position: CellRef & { sheet: string }): unknown };
    FormulaError: typeof FormulaError;
    FormulaHelpers: {
      accept(param: Param, type?: number | null, defValue?: unknown): unknown;
      flattenDeep(arr: unknown): unknown[];
    };
    Types: { NUMBER: number; STRING: number; BOOLEAN: number; ARRAY: number };
  }

  const FormulaParser: FormulaParserStatic;
  export default FormulaParser;
}
