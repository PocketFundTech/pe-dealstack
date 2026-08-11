"use client";

import { type DragEvent } from "react";
import {
  KANBAN_STAGES,
  STAGE_STYLES,
  STAGE_LABELS,
  type MetricKey,
} from "@/lib/constants";
import { cn } from "@/lib/cn";
import type { Deal, FinancialSummariesMap } from "@/types";
import { KanbanCard } from "./components";

// ---------------------------------------------------------------------------
// Kanban view grid for the deals page.
// Extracted from deals/page.tsx for file-size budget.
// ---------------------------------------------------------------------------

export function KanbanView({
  deals,
  activeMetrics,
  dragOverStage,
  setDragOverStage,
  onDrop,
  summaries,
  summariesLoading,
}: {
  deals: Deal[];
  activeMetrics: MetricKey[];
  dragOverStage: string | null;
  setDragOverStage: (stage: string | null) => void;
  onDrop: (e: DragEvent<HTMLDivElement>, newStage: string) => void;
  /**
   * Latest INCOME_STATEMENT summary keyed by dealId. Optional so the
   * kanban renders before the bulk fetch resolves.
   */
  summaries?: FinancialSummariesMap;
  /** True until the bulk summaries fetch resolves. */
  summariesLoading?: boolean;
}) {
  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {KANBAN_STAGES.map((stage) => {
        const s = STAGE_STYLES[stage] || STAGE_STYLES.INITIAL_REVIEW;
        const stageDeals = deals.filter((d) => d.stage === stage);
        return (
          <div key={stage} className="min-w-[300px] w-[300px] shrink-0" data-stage={stage}>
            <div className="bg-surface-card rounded-xl border border-border-subtle overflow-hidden h-full flex flex-col">
              <div className={cn("px-4 py-3 border-b border-border-subtle", s.bg)}>
                <div className="flex items-center justify-between">
                  <span className={cn("px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wider", s.bg, s.border, s.text)}>
                    {STAGE_LABELS[stage]}
                  </span>
                  <span className={cn("text-xs font-bold bg-white/60 px-2 py-0.5 rounded-full", s.text)}>
                    {stageDeals.length}
                  </span>
                </div>
              </div>
              <div
                className={cn(
                  "flex-1 p-3 space-y-3 overflow-y-auto max-h-[calc(100vh-320px)] border-2 border-dashed border-transparent rounded-lg transition-all custom-scrollbar",
                  dragOverStage === stage && "bg-[rgba(0,51,102,0.05)] border-[rgba(0,51,102,0.3)]",
                )}
                style={{ minHeight: 100 }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverStage(stage); }}
                onDragLeave={(e) => {
                  const col = (e.currentTarget as HTMLElement);
                  if (!col.contains(e.relatedTarget as Node)) setDragOverStage(null);
                }}
                onDrop={(e) => onDrop(e, stage)}
              >
                {stageDeals.map((deal) => (
                  <KanbanCard
                    key={deal.id}
                    deal={deal}
                    activeMetrics={activeMetrics}
                    summary={summaries?.[deal.id]}
                    summariesLoading={summariesLoading}
                  />
                ))}
                {stageDeals.length === 0 && (
                  <div className="text-center py-8 text-text-muted text-sm">
                    <span className="material-symbols-outlined text-2xl mb-2 block opacity-40">inbox</span>
                    Drop deals here
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
