"use client";

import { type DragEvent } from "react";
import {
  formatCurrency,
  formatHeadlineValue,
  getDealDisplayName,
  pickHeadlineMetrics,
} from "@/lib/formatters";
import { METRIC_CONFIG, type MetricKey } from "@/lib/constants";
import { cn } from "@/lib/cn";
import Link from "next/link";
import type { Deal, FinancialSummary } from "@/types";

// ---------------------------------------------------------------------------
// Kanban Card (Compact) with drag-and-drop support
// ---------------------------------------------------------------------------
export function KanbanCard({
  deal,
  activeMetrics,
  onDragStart,
  summary,
  summariesLoading,
}: {
  deal: Deal;
  activeMetrics: MetricKey[];
  onDragStart?: (e: DragEvent<HTMLDivElement>, dealId: string) => void;
  /**
   * Latest INCOME_STATEMENT summary — when present we format
   * revenue/EBITDA at the correct unitScale. Optional so cards still
   * render before the bulk fetch resolves.
   */
  summary?: FinancialSummary;
  /** True until the bulk summaries fetch resolves; see DealCard. */
  summariesLoading?: boolean;
}) {
  // Headline metrics via the canonical precedence (cached → summary →
  // legacy). The risk-flag sign comparison stays meaningful because the
  // helper preserves unitScale alongside the picked value.
  const cacheHit =
    deal.cachedRevenue != null ||
    deal.cachedEbitda != null ||
    deal.cachedEbitdaMargin != null;
  const headline = pickHeadlineMetrics(
    deal,
    summary && (summary.revenue != null || summary.ebitda != null) ? summary : null,
  );
  const headlineLoading = !cacheHit && summariesLoading;
  const ebitdaForRiskFlag = headlineLoading ? null : headline.ebitda;
  const hasRiskFlag = (ebitdaForRiskFlag ?? 0) < 0 || deal.stage === "PASSED";
  const kanbanMetrics = activeMetrics.slice(0, 3);

  return (
    <div
      className="kanban-card bg-surface-card rounded-lg border border-border-subtle p-3 shadow-sm hover:shadow-md hover:border-primary/30 transition-all cursor-grab active:cursor-grabbing"
      draggable
      data-deal-id={deal.id}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", deal.id);
        (e.target as HTMLDivElement).style.opacity = "0.5";
        onDragStart?.(e, deal.id);
      }}
      onDragEnd={(e) => {
        (e.target as HTMLDivElement).style.opacity = "1";
      }}
    >
      <Link href={`/deals/${deal.id}`} className="block">
        <div className="flex items-start gap-2 mb-2">
          <div className="size-8 rounded-md bg-primary-light border border-primary/10 flex items-center justify-center text-[#003366] shrink-0">
            <span className="material-symbols-outlined text-[16px]">
              {deal.icon || "business_center"}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold text-text-main truncate hover:text-[#003366] transition-colors" title={getDealDisplayName(deal)}>
              {getDealDisplayName(deal)}
            </h4>
            <p className="text-[11px] text-text-muted truncate">
              {deal.industry || "\u2014"}
            </p>
          </div>
        </div>
        {/* Dynamic compact metrics (first 3) \u2014 revenue/EBITDA route
            through pickHeadlineMetrics (cached \u2192 summary \u2192 legacy) so
            the cards never render mismatched-scale legacy columns. */}
        <div className="flex gap-3 mb-2">
          {kanbanMetrics.map((key) => {
            const cfg = METRIC_CONFIG[key];
            if (!cfg) return null;
            const isStmtKey = key === "revenue" || key === "ebitda";
            const stmtValue = isStmtKey
              ? key === "revenue"
                ? headline.revenue
                : headline.ebitda
              : null;
            const dealValue = deal[key as keyof Deal] as number | undefined | null;
            const colorValue = isStmtKey ? stmtValue : dealValue;
            const renderedValue = (() => {
              if (key === "irrProjected") {
                return dealValue != null ? Number(dealValue).toFixed(1) + "%" : "\u2014";
              }
              if (key === "mom") {
                return dealValue != null ? Number(dealValue).toFixed(1) + "x" : "\u2014";
              }
              if (isStmtKey) {
                if (headlineLoading) return "\u2014";
                if (stmtValue == null) return "\u2014";
                return formatHeadlineValue(stmtValue, headline);
              }
              return formatCurrency(dealValue as number | null | undefined, deal.currency);
            })();
            return (
              <div key={key} className="flex-1 bg-background-body rounded px-2 py-1.5">
                <span className="text-[9px] text-text-muted font-medium uppercase block">{cfg.kanbanLabel}</span>
                <span className={cn(
                  "text-xs font-bold",
                  key === "mom" && colorValue != null && colorValue >= 3 ? "text-secondary" : "",
                  key === "ebitda" && colorValue != null && colorValue < 0 ? "text-red-600" : "",
                  !(key === "mom" && colorValue != null && colorValue >= 3) && !(key === "ebitda" && colorValue != null && colorValue < 0) ? "text-text-main" : "",
                  isStmtKey && headlineLoading ? "text-text-muted/60 animate-pulse" : "",
                )}>
                  {renderedValue}
                </span>
              </div>
            );
          })}
        </div>
        {deal.aiThesis && (
          <div className="flex items-start gap-1.5 pt-2 border-t border-border-subtle">
            <span
              className={cn(
                "material-symbols-outlined text-[12px] mt-0.5",
                hasRiskFlag ? "text-red-500" : "text-green-600"
              )}
            >
              {hasRiskFlag ? "warning" : "auto_awesome"}
            </span>
            <p className="text-[11px] text-text-secondary line-clamp-2 leading-relaxed">
              {deal.aiThesis}
            </p>
          </div>
        )}
      </Link>
    </div>
  );
}
