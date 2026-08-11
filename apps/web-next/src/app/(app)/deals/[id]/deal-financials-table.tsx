"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { getCurrencySymbol } from "@/lib/formatters";
import { type FinancialStatement } from "./deal-financials-charts";
import { comparePeriodChronologically } from "./deal-financials-period-scope";
import {
  LINE_ITEM_LABELS,
  ORDERED_LINE_ITEMS,
  SUBTOTAL_KEYS,
  type StatementType,
} from "./deal-financials-constants";
import { ConfidenceBadge, fmtMoney, fmtPct, isPctKey } from "./deal-financials-formatters";
import { type ConflictGroup } from "./deal-financials-conflicts";

// --- Shell wrapper (header + border) ---

export function FinancialShell({ children, avgConfidence, currency, collapsed, onToggle, onFullscreen }: {
  children: React.ReactNode; avgConfidence?: number | null; currency?: string;
  collapsed?: boolean; onToggle?: () => void; onFullscreen?: () => void;
}) {
  return (
    <div id="financials-section" className="overflow-hidden"
      style={{ borderRadius: 12, border: "2px solid #003366", boxShadow: "0 2px 8px rgba(0,51,102,0.15)", flexShrink: 0 }}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 cursor-pointer"
        style={{ backgroundColor: "#003366", padding: "14px 20px", borderRadius: collapsed ? "10px" : "10px 10px 0 0", border: "none" }}>
        <span className="material-symbols-outlined text-white text-[20px]">table_chart</span>
        <span className="text-white text-[13px] font-bold uppercase tracking-wider" style={{ letterSpacing: "0.05em" }}>
          Financial Statements
        </span>
        <div className="ml-auto flex items-center gap-2">
          {currency && currency !== "USD" && (
            <span className="text-[10px] font-semibold text-white/70 bg-white/10 px-2 py-0.5 rounded-full">{currency}</span>
          )}
          {avgConfidence != null && (
            <span className={cn("text-[10px] font-semibold px-2 py-0.5 rounded-full",
              avgConfidence >= 80 ? "bg-emerald-400/20 text-emerald-200"
              : avgConfidence >= 50 ? "bg-amber-400/20 text-amber-200"
              : "bg-red-400/20 text-red-200")}>
              {avgConfidence}% confidence
            </span>
          )}
          <span
            className="material-symbols-outlined text-[16px] transition-colors"
            style={{ color: "rgba(255,255,255,0.5)", cursor: onFullscreen ? "pointer" : "default" }}
            title="Fullscreen"
            onMouseEnter={(e) => { (e.target as HTMLElement).style.color = "rgba(255,255,255,0.9)"; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.color = "rgba(255,255,255,0.5)"; }}
            onClick={(e) => { e.stopPropagation(); onFullscreen?.(); }}
          >
            open_in_full
          </span>
          <span
            className="material-symbols-outlined text-[18px] transition-transform duration-200"
            style={{ color: "rgba(255,255,255,0.75)", transform: collapsed ? "rotate(0deg)" : "rotate(180deg)" }}
          >
            expand_more
          </span>
        </div>
      </button>
      {!collapsed && (
        <div className="bg-white" style={{ padding: 20, borderRadius: "0 0 10px 10px" }}>{children}</div>
      )}
    </div>
  );
}

// --- Sub-category detection helpers ---
//
// Sub-categories follow the convention "<parent_canonical>_<short_label>" where
// <parent_canonical> is one of the keys already declared in ORDERED_LINE_ITEMS
// (e.g. rd, cogs, sga, capex). The renderer detects them at runtime so a source
// like "Engineering R&D / Product R&D / Applied R&D" can be emitted as
// rd_engineering / rd_product / rd_applied and shown indented under the rd row.
//
// Reserved suffixes that must NOT be treated as children:
//   _source — citation strings stored alongside numeric values
//   _pct, _percent, _ratio, _margin — derived percentages with their own slot
//   _total — convention some sources use to flag the rolled-up total
const RESERVED_CHILD_SUFFIXES = ["source", "pct", "percent", "ratio", "margin", "total"];

const CANONICAL_SET = new Set<string>(ORDERED_LINE_ITEMS);

/**
 * Find the longest canonical-key prefix that K is a sub-category of.
 * Returns null if K is itself a canonical key OR has no canonical parent OR
 * the trailing segment matches a reserved suffix (e.g. *_source, *_pct).
 *
 * Longest-prefix matching prevents `total_assets_other` from being parsed as
 * "total" + "assets_other" — it correctly resolves to parent "total_assets".
 */
export function findCanonicalParent(key: string): string | null {
  if (CANONICAL_SET.has(key)) return null;
  if (key.endsWith("_source")) return null;

  let bestParent: string | null = null;
  for (const candidate of ORDERED_LINE_ITEMS) {
    const prefix = candidate + "_";
    if (key.startsWith(prefix) && key.length > prefix.length) {
      if (bestParent === null || candidate.length > bestParent.length) {
        bestParent = candidate;
      }
    }
  }
  if (!bestParent) return null;

  const childSuffix = key.slice(bestParent.length + 1);
  // Reject reserved single-segment suffixes; multi-segment children with these
  // suffixes inside (e.g. cogs_engineering_total) are still rejected because
  // the trailing token disambiguates from a real child label.
  const segments = childSuffix.split("_");
  const lastSegment = segments[segments.length - 1].toLowerCase();
  if (RESERVED_CHILD_SUFFIXES.includes(lastSegment)) return null;

  return bestParent;
}

/** Humanize a child suffix (e.g. "engineering_rd" → "Engineering R&D"). */
function labelForChild(parent: string, key: string): string {
  if (LINE_ITEM_LABELS[key]) return LINE_ITEM_LABELS[key];
  const suffix = key.slice(parent.length + 1);
  return suffix
    .split("_")
    .map((seg) => (seg.length <= 3 ? seg.toUpperCase() : seg.charAt(0).toUpperCase() + seg.slice(1)))
    .join(" ");
}

interface DisplayRow {
  key: string;
  label: string;
  isChild: boolean;
  parent?: string;
}

/**
 * Build the ordered render plan: walk ORDERED_LINE_ITEMS for canonical/parent
 * rows, attach detected children directly under their parent, then append any
 * unknown standalone keys at the end.
 */
function buildDisplayRows(allKeys: Set<string>): DisplayRow[] {
  const childrenByParent = new Map<string, string[]>();
  const standaloneUnknown: string[] = [];

  for (const k of allKeys) {
    if (k.endsWith("_source")) continue;
    if (CANONICAL_SET.has(k)) continue;
    const parent = findCanonicalParent(k);
    if (parent) {
      const arr = childrenByParent.get(parent) ?? [];
      arr.push(k);
      childrenByParent.set(parent, arr);
    } else {
      standaloneUnknown.push(k);
    }
  }
  // Stable child order — alphabetical so re-renders don't shuffle.
  childrenByParent.forEach((arr) => arr.sort());

  const rows: DisplayRow[] = [];
  for (const canonical of ORDERED_LINE_ITEMS) {
    const hasOwnValue = allKeys.has(canonical);
    const children = childrenByParent.get(canonical) ?? [];
    if (!hasOwnValue && children.length === 0) continue;
    rows.push({
      key: canonical,
      label: LINE_ITEM_LABELS[canonical] ?? canonical.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      isChild: false,
    });
    for (const child of children) {
      rows.push({
        key: child,
        label: labelForChild(canonical, child),
        isChild: true,
        parent: canonical,
      });
    }
  }
  for (const k of standaloneUnknown) {
    rows.push({
      key: k,
      label: LINE_ITEM_LABELS[k] ?? k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      isChild: false,
    });
  }
  return rows;
}

/**
 * Hide-empty filter. A row is hidden when EVERY period's value is null or
 * undefined — legitimate zeros (e.g. "no debt repayments this year") are
 * preserved so users still see them. Subtotals always render so a zero
 * subtotal carries the "no operating expenses" signal.
 *
 * Children: same nullness check. If a parent has no own value AND every child
 * is hidden, the parent is hidden too (the entire group collapses).
 */
function applyHideEmpty(
  displayRows: DisplayRow[],
  periods: FinancialStatement[],
): DisplayRow[] {
  const hasAnyValue = (key: string): boolean => {
    for (const p of periods) {
      const v = (p.lineItems ?? {})[key];
      if (v !== null && v !== undefined) return true;
    }
    return false;
  };

  const visibleChildKeys = new Set<string>();
  for (const r of displayRows) {
    if (r.isChild && hasAnyValue(r.key)) visibleChildKeys.add(r.key);
  }

  const result: DisplayRow[] = [];
  for (const r of displayRows) {
    if (r.isChild) {
      if (visibleChildKeys.has(r.key)) result.push(r);
      continue;
    }
    if (SUBTOTAL_KEYS.has(r.key)) {
      result.push(r);
      continue;
    }
    // Parent / standalone row. Show if it has its own value OR if any of its
    // children survive the filter.
    if (hasAnyValue(r.key)) {
      result.push(r);
      continue;
    }
    // Walk forward for direct children of this row.
    const childCount = displayRows.filter(
      (x) => x.isChild && x.parent === r.key && visibleChildKeys.has(x.key),
    ).length;
    if (childCount > 0) result.push(r);
  }
  return result;
}

// --- Financial Data Table ---

export function FinancialTable({
  statements,
  statementType,
  conflicts,
}: {
  statements: FinancialStatement[];
  statementType: StatementType;
  conflicts: ConflictGroup[];
}) {
  const [showEmpty, setShowEmpty] = useState(false);

  const rows = statements.filter((s) => s.statementType === statementType).sort((a, b) => comparePeriodChronologically(a.period, b.period));

  const allKeys = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => Object.keys(r.lineItems ?? {}).forEach((k) => set.add(k)));
    return set;
  }, [rows]);

  const baseDisplayRows = useMemo(() => buildDisplayRows(allKeys), [allKeys]);
  const displayRows = useMemo(
    () => (showEmpty ? baseDisplayRows : applyHideEmpty(baseDisplayRows, rows)),
    [baseDisplayRows, rows, showEmpty],
  );

  if (rows.length === 0) {
    return <p className="text-xs text-gray-400 py-4 text-center">No {statementType.replace(/_/g, " ").toLowerCase()} data available.</p>;
  }

  const currency = rows[0]?.currency ?? "USD";
  const sym = getCurrencySymbol(currency);
  // Cells auto-scale via formatFinancialValue, so we only label the currency
  // here. Per-cell suffixes (K/M/B/Cr/L) are applied at render time.
  const headerLabel = sym.trim();

  const docMap = new Map<string, string>();
  rows.forEach((r) => { if (r.Document?.id) docMap.set(r.Document.id, r.Document.name ?? "Unknown document"); });

  // Build a Set of conflict period keys for quick lookup
  const conflictPeriodSet = new Set(
    conflicts
      .filter((c) => c.statementType === statementType)
      .map((c) => c.period),
  );

  const hiddenCount = baseDisplayRows.length - displayRows.length;

  return (
    <>
      <div className="flex items-center justify-end mb-2 px-1">
        <label className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 cursor-pointer select-none">
          <input
            type="checkbox"
            className="h-3 w-3 rounded border-gray-300 text-[#003366] focus:ring-[#003366]/30 cursor-pointer"
            checked={showEmpty}
            onChange={(e) => setShowEmpty(e.target.checked)}
          />
          Show empty rows
          {!showEmpty && hiddenCount > 0 && (
            <span className="text-gray-400">({hiddenCount} hidden)</span>
          )}
        </label>
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        <table className="w-full text-xs" style={{ borderCollapse: "separate", borderSpacing: 0 }}>
          <thead>
            <tr style={{ background: "#fafbfc" }}>
              <th className="px-3 py-3 text-left text-[11px] font-semibold text-gray-500 sticky left-0 min-w-[160px]"
                style={{ background: "#fafbfc", zIndex: 3, boxShadow: "2px 0 4px -2px rgba(0,0,0,0.06)" }}>
                Line Item <span className="text-[10px] font-normal text-gray-400">({headerLabel})</span>
              </th>
              {rows.map((r) => {
                const hasConflict = conflictPeriodSet.has(r.period);
                return (
                  <th key={r.id} className="px-3 py-3 text-right whitespace-nowrap min-w-[95px]" style={{ background: "#fafbfc" }}>
                    <div className="flex items-center justify-end gap-1">
                      {hasConflict && (
                        <span
                          className="material-symbols-outlined text-amber-500 cursor-default"
                          style={{ fontSize: 14 }}
                          title="Multiple versions exist for this period — overlapping extraction detected"
                        >
                          merge_type
                        </span>
                      )}
                      <span className={cn("text-[11px] font-semibold", r.periodType === "PROJECTED" ? "italic text-gray-400" : "text-gray-700")}>{r.period}</span>
                    </div>
                    <div className="mt-1"><ConfidenceBadge confidence={r.extractionConfidence} /></div>
                    {r.Document?.name && <div className="text-[9px] text-gray-400 truncate max-w-[88px] mt-0.5" title={r.Document.name}>{r.Document.name}</div>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, idx) => {
              const { key, label, isChild } = row;
              const isSubtotal = SUBTOTAL_KEYS.has(key);
              const isPct = isPctKey(key);
              const rowBg = isSubtotal ? "#f7f8f9" : idx % 2 === 0 ? "#ffffff" : "#fbfbfc";
              // Indentation:
              //   - subtotals stay flush-left (font-semibold marks them)
              //   - margin/% rows already indent via existing pl-6 styling
              //   - sub-category children indent one extra level
              //   - everything else is the regular gray-500 leaf
              const labelCls = isSubtotal
                ? "font-semibold text-gray-800"
                : isChild
                ? "text-gray-500 pl-8 italic"
                : isPct
                ? "text-gray-400 pl-6"
                : "text-gray-500";
              return (
                <tr key={key} className="border-b border-gray-100 hover:bg-blue-50/30 transition-colors group">
                  <td className={cn("px-3 py-2 text-xs whitespace-nowrap sticky left-0", labelCls)}
                    style={{ zIndex: 2, background: rowBg, boxShadow: "2px 0 4px -2px rgba(0,0,0,0.06)" }}>
                    {isChild && (
                      <span className="text-gray-300 mr-1" aria-hidden="true">└</span>
                    )}
                    {label}
                  </td>
                  {rows.map((r) => {
                    const val = (r.lineItems ?? {})[key];
                    // Each row carries its own `unitScale`; per-cell formatting
                    // means a single statement can mix periods stored at
                    // different scales without mis-rendering.
                    const display = isPct
                      ? fmtPct(val)
                      : fmtMoney(val, r.unitScale ?? "ACTUALS", r.currency ?? currency);
                    const valCls = r.periodType === "PROJECTED" ? "text-gray-400 italic"
                      : isSubtotal ? "text-gray-900 font-semibold"
                      : isChild ? "text-gray-600"
                      : "text-gray-700";
                    return <td key={r.id} className={cn("px-3 py-2 text-right text-xs", valCls)}>{display}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {docMap.size > 0 && (
        <p className="text-[10px] text-gray-400 mt-2.5 px-1 flex items-center gap-1">
          <span className="material-symbols-outlined text-xs">description</span>
          Source{docMap.size > 1 ? "s" : ""}: {[...docMap.values()].join(" · ")}
        </p>
      )}
    </>
  );
}
