"use client";

// Low / Base / High (fix plan E2): case tabs and a side-by-side summary of
// IRR, MoM and exit EV. Figures come from summariseCase in @ai-crm/shared —
// the same arithmetic as the workbook's Scenarios sheet — so unsaved edits
// to any case show up immediately.

import { MODEL_CASES, type CaseSummary, type ModelCase } from "@ai-crm/shared";
import { cn } from "@/lib/cn";
import { fmtMoney } from "./deal-model-types";

interface TabsProps {
  active: ModelCase;
  saved: Record<ModelCase, boolean>;
  dirty: Record<ModelCase, boolean>;
  onSelect: (c: ModelCase) => void;
}

export function CaseTabs({ active, saved, dirty, onSelect }: TabsProps) {
  return (
    <div role="tablist" aria-label="Model case" className="inline-flex rounded-lg border border-border-subtle p-0.5">
      {MODEL_CASES.map((c) => (
        <button
          key={c}
          type="button"
          role="tab"
          aria-selected={active === c}
          onClick={() => onSelect(c)}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-medium",
            active === c ? "text-white" : "text-text-secondary hover:bg-gray-50",
          )}
          style={active === c ? { backgroundColor: "#003366" } : undefined}
        >
          {c}
          {dirty[c] ? " •" : !saved[c] && c !== "Base" ? " (seeded)" : ""}
        </button>
      ))}
    </div>
  );
}

interface SummaryProps {
  summaries: Record<ModelCase, CaseSummary | null>;
  active: ModelCase;
  currency: string;
}

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const mult = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}x`);

export function ScenarioSummary({ summaries, active, currency }: SummaryProps) {
  const rows: Array<{ label: string; value: (s: CaseSummary) => string }> = [
    { label: "IRR", value: (s) => pct(s.irr) },
    { label: "MoM", value: (s) => mult(s.mom) },
    { label: "Exit EV", value: (s) => fmtMoney(s.exitEv, currency) },
    { label: "Exit EBITDA", value: (s) => fmtMoney(s.exitEbitda, currency) },
  ];
  return (
    <table className="w-full text-sm" aria-label="Scenario summary">
      <thead>
        <tr className="text-xs text-text-muted">
          <th className="py-1.5 text-left font-medium">Scenario</th>
          {MODEL_CASES.map((c) => (
            <th key={c} className={cn("px-2 py-1.5 text-right font-medium", c === active && "text-[#003366]")}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-t border-border-subtle/60">
            <td className="py-1.5 text-text-secondary">{r.label}</td>
            {MODEL_CASES.map((c) => {
              const s = summaries[c];
              return (
                <td
                  key={c}
                  data-testid={`summary-${r.label}-${c}`}
                  className={cn("px-2 py-1.5 text-right tabular-nums", c === active ? "font-semibold text-text-main" : "text-text-secondary")}
                >
                  {s ? r.value(s) : "—"}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
