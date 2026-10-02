"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { getCurrencySymbol } from "@/lib/formatters";
import { type FinancialStatement } from "./deal-financials-charts";
import { comparePeriodChronologically } from "./deal-financials-period-scope";
import { SUBTOTAL_KEYS, type StatementType } from "./deal-financials-constants";
import { buildStatementRows, hideEmptyRows, UNCLASSIFIED_KEY } from "./deal-financials-layout";
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

  // Statement-specific layout (deal-financials-layout.ts): sections in P&L
  // order, raw accounts nested under their section, leftovers grouped.
  const baseDisplayRows = useMemo(() => buildStatementRows(statementType, allKeys), [statementType, allKeys]);
  const visibleRows = useMemo(() => {
    if (showEmpty) return baseDisplayRows;
    const hasAnyValue = (key: string) => rows.some((p) => {
      const v = (p.lineItems ?? {})[key];
      return v !== null && v !== undefined;
    });
    return hideEmptyRows(baseDisplayRows, hasAnyValue);
  }, [baseDisplayRows, rows, showEmpty]);

  // Collapsible sections. Unclassified accounts start collapsed so the
  // statement reads top-down; everything else starts open.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set([UNCLASSIFIED_KEY]));
  const toggleSection = (key: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const displayRows = visibleRows.filter((r) => !(r.isChild && r.parent && collapsed.has(r.parent)));
  const childCount = (key: string) => visibleRows.filter((r) => r.isChild && r.parent === key).length;

  // A value computed by the backend (EBITDA from EBIT + D&A, etc.) carries
  // `<key>_source: "derived: …"` — mark it rather than pass it off as printed.
  const derivedFormula = (key: string): string | null => {
    for (const r of rows) {
      const src = (r.lineItems ?? {})[`${key}_source`] as unknown;
      if (typeof src === "string" && src.startsWith("derived:")) return src.slice("derived:".length).trim();
    }
    return null;
  };

  if (rows.length === 0) {
    return <p className="text-xs text-gray-400 py-4 text-center">No {statementType.replace(/_/g, " ").toLowerCase()} data available.</p>;
  }

  const currency = rows[0]?.currency ?? "USD";
  const sym = getCurrencySymbol(currency);
  // Columns can come from documents in different currencies; each cell is
  // formatted in its own, but nothing is converted — say so instead of
  // labelling the whole table with the first column's currency.
  const currencies = Array.from(new Set(rows.map((r) => (r.currency ?? "USD").toUpperCase())));
  const mixedCurrency = currencies.length > 1;
  // Cells auto-scale via formatFinancialValue, so we only label the currency
  // here. Per-cell suffixes (K/M/B/Cr/L) are applied at render time.
  const headerLabel = mixedCurrency ? "mixed currencies" : sym.trim();

  const docMap = new Map<string, string>();
  rows.forEach((r) => { if (r.Document?.id) docMap.set(r.Document.id, r.Document.name ?? "Unknown document"); });

  // Build a Set of conflict period keys for quick lookup
  const conflictPeriodSet = new Set(
    conflicts
      .filter((c) => c.statementType === statementType)
      .map((c) => c.period),
  );

  const hiddenCount = baseDisplayRows.length - visibleRows.length;

  return (
    <>
      {mixedCurrency && (
        <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900" role="note">
          These columns are in different currencies ({currencies.join(", ")}). Figures are not converted, so don&apos;t compare or add them across currencies.
        </p>
      )}
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
              const { key, label, isChild, kind } = row;
              const isGroup = kind === "group";
              const isSubtotal = kind === "subtotal" || SUBTOTAL_KEYS.has(key);
              const kids = isChild ? 0 : childCount(key);
              const derived = derivedFormula(key);
              const isPct = isPctKey(key);
              const rowBg = isSubtotal ? "#f7f8f9" : idx % 2 === 0 ? "#ffffff" : "#fbfbfc";
              // Indentation:
              //   - subtotals stay flush-left (font-semibold marks them)
              //   - margin/% rows already indent via existing pl-6 styling
              //   - sub-category children indent one extra level
              //   - everything else is the regular gray-500 leaf
              const labelCls = isGroup
                ? "text-gray-400 italic"
                : isSubtotal
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
                    {kids > 0 ? (
                      <button type="button" onClick={() => toggleSection(key)}
                        className="inline-flex items-center gap-0.5 hover:text-[#003366]"
                        aria-expanded={!collapsed.has(key)}
                        title={collapsed.has(key) ? `Show ${kids} account${kids === 1 ? "" : "s"}` : "Hide accounts"}>
                        <span className="material-symbols-outlined text-[14px] text-gray-400">
                          {collapsed.has(key) ? "chevron_right" : "expand_more"}
                        </span>
                        {label}
                      </button>
                    ) : label}
                    {derived && (
                      <span className="ml-1.5 text-[9px] font-medium uppercase tracking-wide text-sky-600 bg-sky-50 px-1 py-px rounded"
                        title={`Not printed in the source — derived: ${derived}`}>derived</span>
                    )}
                  </td>
                  {rows.map((r) => {
                    if (isGroup) return <td key={r.id} />;
                    const val = (r.lineItems ?? {})[key];
                    // Each row carries its own `unitScale`; per-cell formatting
                    // means a single statement can mix periods stored at
                    // different scales without mis-rendering.
                    // Accounting-style negatives: (1.2M) rather than −1.2M.
                    const display = isPct
                      ? fmtPct(val)
                      : typeof val === "number" && val < 0
                      ? `(${fmtMoney(-val, r.unitScale ?? "ACTUALS", r.currency ?? currency)})`
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
