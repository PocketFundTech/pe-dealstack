"use client";

// Per-line driver table for the "Build model" panel (fix plan E1): one row
// per P&L line, accounts nested (collapsible) under their parent. Input
// lines get a method + one value per projected year; parents, subtotals,
// interest and tax show their projected figures read-only, exactly as the
// workbook's formulas compute them.

import { useMemo, useState } from "react";
import {
  DRIVER_METHOD_LABELS, allowedMethods,
  type DriverMethod, type LineDriver, type ModelLine, type ModelProjection,
} from "@ai-crm/shared";
import { cn } from "@/lib/cn";
import { isHidden } from "./deal-model-types";

const READ_ONLY_LABEL: Record<string, string> = {
  SUM: "Sum of accounts",
  SUBTOTAL: "Subtotal",
  INTEREST: "Debt schedule",
  TAX: "Tax rate × EBT",
};

interface Props {
  lines: ModelLine[];
  drivers: Record<string, LineDriver>;
  projection: ModelProjection | null;
  years: number;
  onValue: (key: string, year: number, value: number) => void;
  onMethod: (key: string, method: DriverMethod) => void;
}

export function DriverTable({ lines, drivers, projection, years, onValue, onMethod }: Props) {
  const visibleLines = useMemo(() => lines.filter((l) => !l.historicalOnly), [lines]);
  const byKey = useMemo(() => new Map(lines.map((l) => [l.key, l])), [lines]);
  const parents = useMemo(() => new Set(visibleLines.filter((l) => l.parent).map((l) => l.parent!)), [visibleLines]);
  // Accounts start collapsed so the statement reads top-down; expand a parent to edit its accounts.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(parents));

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border-subtle text-xs text-text-muted">
            <th className="py-2 pr-2 text-left font-medium">Line</th>
            <th className="px-2 py-2 text-left font-medium">Method</th>
            {Array.from({ length: years }, (_, y) => (
              <th key={y} className="px-1 py-2 text-right font-medium">Y{y + 1}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleLines.map((line) => {
            if (isHidden(line, byKey, collapsed)) return null;
            const isParent = parents.has(line.key);
            const driver = drivers[line.key];
            const editable = line.kind === "INPUT" && driver && driver.method !== "SUBTOTAL";
            const isPct = driver?.method === "GROWTH" || driver?.method === "PCT_REVENUE";
            return (
              <tr
                key={line.key}
                data-testid={`driver-row-${line.key}`}
                className={cn("border-b border-border-subtle/60", line.kind === "SUBTOTAL" && "bg-gray-50 font-semibold")}
              >
                <td className="py-1.5 pr-2" style={{ paddingLeft: `${line.level * 16}px` }}>
                  {isParent ? (
                    <button
                      type="button"
                      onClick={() => toggle(line.key)}
                      aria-expanded={!collapsed.has(line.key)}
                      aria-label={`${collapsed.has(line.key) ? "Expand" : "Collapse"} ${line.label}`}
                      className="flex items-center gap-1 text-left text-text-main hover:text-[#003366]"
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        {collapsed.has(line.key) ? "chevron_right" : "expand_more"}
                      </span>
                      {line.label}
                    </button>
                  ) : (
                    <span className={cn(line.level > 0 ? "text-text-secondary" : "text-text-main")}>{line.label}</span>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  {editable ? (
                    <select
                      aria-label={`${line.label} method`}
                      value={driver.method}
                      onChange={(e) => onMethod(line.key, e.target.value as DriverMethod)}
                      className="rounded-md border border-border-subtle bg-white px-1.5 py-1 text-xs focus:border-[#003366] focus:outline-none"
                    >
                      {allowedMethods(line).map((m) => (
                        <option key={m} value={m}>{m === "SUBTOTAL" ? "Formula" : DRIVER_METHOD_LABELS[m]}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs text-text-muted">
                      {READ_ONLY_LABEL[line.computed ?? line.kind] ?? "Formula"}
                    </span>
                  )}
                </td>
                {Array.from({ length: years }, (_, y) => (
                  <td key={y} className="px-1 py-1.5 text-right">
                    {editable ? (
                      <span className="inline-flex items-center gap-0.5">
                        <input
                          type="number"
                          aria-label={`${line.label} Y${y + 1}`}
                          step={isPct ? 0.5 : 0.1}
                          value={driver.values[y] ?? 0}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (Number.isFinite(v)) onValue(line.key, y, v);
                          }}
                          className="w-16 rounded-md border border-border-subtle px-1.5 py-1 text-right text-xs tabular-nums focus:border-[#003366] focus:outline-none"
                        />
                        <span className="w-3 text-[10px] text-text-muted">{isPct ? "%" : "m"}</span>
                      </span>
                    ) : (
                      <span className="text-xs tabular-nums text-text-secondary">
                        {projection?.values[line.key]?.[y]?.toFixed(1) ?? "—"}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
          {projection && (
            <tr className="text-xs text-text-muted">
              <td className="py-1.5 pr-2">EBITDA margin</td>
              <td />
              {projection.ebitdaMarginPct.map((m, y) => (
                <td key={y} className="px-1 py-1.5 text-right tabular-nums">{m === null ? "—" : `${m.toFixed(1)}%`}</td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
