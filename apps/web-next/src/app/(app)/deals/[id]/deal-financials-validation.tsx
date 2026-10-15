"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { type FinancialStatement } from "./deal-financials-charts";
import { VALIDATION_FLAGS_ANCHOR } from "./deal-financials-constants";

export interface ValidationCheck {
  check: string;
  passed: boolean;
  severity: "error" | "warning" | "info";
  message: string;
  period?: string;
}

export interface ValidationResult {
  checks: ValidationCheck[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
  overallPassed: boolean;
}

// --- Client-side validation flag derivation ---
// Mirrors the legacy financials.js checks run against the loaded statements.
// We derive flags purely from the statements array so no extra API round-trip
// is needed when the server /validation endpoint is unavailable.

export function deriveClientValidationFlags(statements: FinancialStatement[]): ValidationCheck[] {
  const flags: ValidationCheck[] = [];

  // 1. Low confidence warning (< 70%) on any period
  for (const s of statements) {
    const conf = s.extractionConfidence ?? null;
    if (conf !== null && conf < 70) {
      flags.push({
        check: "low_confidence",
        passed: false,
        severity: conf < 50 ? "error" : "warning",
        message: `${s.statementType.replace(/_/g, " ")} ${s.period}: extraction confidence is ${Math.round(conf)}% — review extracted values`,
        period: s.period,
      });
    }
  }

  // 2. Cross-source value divergence for the same (statementType, period)
  //    Group statements by type+period, check if multiple docs report wildly different values.
  const KEY_FIELDS = ["revenue", "ebitda", "net_income", "total_assets", "total_equity", "operating_cf"];
  const groups = new Map<string, FinancialStatement[]>();
  for (const s of statements) {
    const key = `${s.statementType}|${s.period}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const [stmtType, period] = key.split("|");
    for (const field of KEY_FIELDS) {
      const vals = group
        .map((s) => (s.lineItems ?? {})[field])
        .filter((v): v is number => v != null);
      if (vals.length < 2) continue;
      const maxAbs = Math.max(...vals.map(Math.abs));
      const spread = Math.max(...vals) - Math.min(...vals);
      const discPct = maxAbs > 0 ? (spread / maxAbs) * 100 : 0;
      if (discPct > 10) {
        const fieldLabel = field.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        flags.push({
          check: `cross_source_${field}`,
          passed: false,
          severity: discPct > 30 ? "error" : "warning",
          message: `${stmtType.replace(/_/g, " ")} ${period}: ${fieldLabel} differs by ${discPct.toFixed(1)}% across source documents — verify`,
          period,
        });
      }
    }
  }

  return flags;
}

// --- Validation Flags Panel ---

export function ValidationFlagsPanel({ flags }: { flags: ValidationCheck[] }) {
  const [open, setOpen] = useState(true);

  if (flags.length === 0) return null;

  const errorFlags = flags.filter((f) => f.severity === "error");
  const hasErrors = errorFlags.length > 0;

  return (
    <div id={VALIDATION_FLAGS_ANCHOR} className="mb-4 rounded-lg border overflow-hidden border-amber-200 bg-amber-50">
      <button
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-amber-100/50"
        aria-expanded={open}
      >
        <span className="material-symbols-outlined text-base text-amber-500">
          warning
        </span>
        <span className="text-xs font-semibold text-amber-800">
          {flags.length} Validation Flag{flags.length > 1 ? "s" : ""}
          {hasErrors && ` (${errorFlags.length} error${errorFlags.length > 1 ? "s" : ""})`}
        </span>
        <span
          className="material-symbols-outlined text-sm ml-auto transition-transform duration-200 text-amber-400"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
          aria-hidden
        >
          expand_more
        </span>
      </button>

      {open && (
        <div className="px-4 pb-3 border-t border-amber-200/60">
          <ul className="text-xs space-y-1 mt-2 text-amber-700">
            {flags.map((f, i) => (
              <li key={`${f.check}-${i}`} className="flex items-start gap-1.5">
                <span
                  className={cn(
                    "mt-0.5 shrink-0 material-symbols-outlined",
                    f.severity === "error" || f.severity === "warning"
                      ? "text-amber-400 text-xs"
                      : "text-gray-400 text-xs",
                  )}
                  style={{ fontSize: 12 }}
                >
                  {f.severity === "error" ? "error" : f.severity === "warning" ? "warning" : "info"}
                </span>
                <span>{f.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
