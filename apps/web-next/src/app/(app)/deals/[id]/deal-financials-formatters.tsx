import { cn } from "@/lib/cn";
import {
  formatFinancialValue,
  formatPercent,
  type UnitScale,
} from "@/lib/formatters";

export function isPctKey(key: string): boolean {
  return key.endsWith("_pct") || key.endsWith("_margin");
}

/**
 * Format a financial line-item value at the most appropriate human scale.
 * Delegates to `formatFinancialValue` so all callers get the same B/M/K
 * auto-scaling and unitScale handling.
 */
export function fmtMoney(
  val: number | null | undefined,
  unitScale?: string | null,
  currency?: string | null,
): string {
  // The legacy server contract emits MILLIONS / THOUSANDS / ACTUALS / BILLIONS;
  // anything else is treated as ACTUALS by formatFinancialValue.
  const scale = (unitScale ?? undefined) as UnitScale | undefined;
  return formatFinancialValue(val, scale, { currency });
}

export const fmtPct = formatPercent;

export function ConfidenceBadge({ confidence }: { confidence?: number | null }) {
  const pct = Math.round(confidence ?? 0);
  const [cls, dotColor] =
    pct >= 80 ? ["bg-emerald-50 text-emerald-700 border-emerald-200", "#059669"]
    : pct >= 50 ? ["bg-amber-50 text-amber-700 border-amber-200", "#d97706"]
    : ["bg-red-50 text-red-600 border-red-200", "#dc2626"];
  return (
    <span className={cn("inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border", cls)}>
      <span className="inline-block rounded-full" style={{ width: 5, height: 5, background: dotColor }} />
      {pct}%
    </span>
  );
}
