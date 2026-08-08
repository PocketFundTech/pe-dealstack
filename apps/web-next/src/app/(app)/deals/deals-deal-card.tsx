"use client";

import { useEffect, useState, useRef } from "react";
import { formatCurrency, getDocIcon, getDealDisplayName } from "@/lib/formatters";
import { useLiveTime } from "@/lib/useLiveTime";
import {
  STAGE_STYLES,
  STAGE_LABELS,
  METRIC_CONFIG,
  type MetricKey,
} from "@/lib/constants";
import { cn } from "@/lib/cn";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Deal } from "@/types";
import { ScorecardBadge } from "./scorecard-badge";

// ---------------------------------------------------------------------------
// Deal Card (List View)
// ---------------------------------------------------------------------------
export function DealCard({
  deal,
  selected,
  onToggleSelect,
  onDelete,
  activeMetrics,
  onRemoveSample,
}: {
  deal: Deal;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onDelete: (id: string, name: string) => void;
  activeMetrics: MetricKey[];
  onRemoveSample?: (id: string) => void;
}) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const style = STAGE_STYLES[deal.stage] || STAGE_STYLES.INITIAL_REVIEW;
  const isPassed = deal.status === "PASSED" || deal.stage === "PASSED";
  const hasRiskFlag = (deal.ebitda ?? 0) < 0 || deal.stage === "PASSED";
  const liveUpdated = useLiveTime(deal.lastDocumentUpdated || deal.updatedAt);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div className="relative group/card" data-deal-id={deal.id}>
      {/* Checkbox */}
      <div className="absolute top-3 left-3 z-10">
        <label
          className={cn(
            "flex items-center justify-center size-6 rounded bg-white/90 backdrop-blur border cursor-pointer shadow-sm transition-all",
            selected
              ? "bg-[#003366] border-[#003366]"
              : "border-border-subtle hover:border-[#003366]"
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            className="sr-only"
            checked={selected}
            onChange={() => onToggleSelect(deal.id)}
          />
          <span
            className={cn(
              "material-symbols-outlined text-[16px]",
              selected
                ? "text-white"
                : "text-transparent group-hover/card:text-gray-300"
            )}
          >
            check
          </span>
        </label>
      </div>

      {/* Three-dot Menu */}
      <div className="absolute top-3 right-3 z-10" ref={menuRef}>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenuOpen((o) => !o);
          }}
          className="flex items-center justify-center size-7 rounded-md bg-white/90 backdrop-blur border border-border-subtle cursor-pointer hover:border-[#003366] shadow-sm transition-all opacity-0 group-hover/card:opacity-100 focus:opacity-100"
        >
          <span className="material-symbols-outlined text-[18px] text-text-muted">more_vert</span>
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 w-44 bg-surface-card rounded-lg shadow-lg border border-border-subtle py-1 z-50">
            <Link
              href={`/deals/${deal.id}`}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-primary-light hover:text-[#003366] transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">open_in_new</span>
              Open Deal
            </Link>
            <Link
              href={`/data-room?dealId=${deal.id}`}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-primary-light hover:text-[#003366] transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">folder_open</span>
              Open Data Room
            </Link>
            <div className="border-t border-border-subtle my-1" />
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenuOpen(false);
                onDelete(deal.id, deal.name);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">delete</span>
              Delete Deal
            </button>
          </div>
        )}
      </div>

      {/* Remove Sample button (for sample deals) */}
      {deal.tags?.includes("sample") && onRemoveSample && (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemoveSample(deal.id); }}
          className="absolute top-2 right-2 z-10 px-2 py-1 rounded-md bg-white border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-200 text-[10px] font-medium transition-colors shadow-sm"
          title="Remove sample deal"
        >
          <span className="material-symbols-outlined text-[14px] align-middle">close</span>{" "}
          Remove Sample
        </button>
      )}

      <article
        onClick={() => router.push(`/deals/${deal.id}`)}
        onMouseEnter={() => router.prefetch(`/deals/${deal.id}`)}
        className={cn(
          "bg-surface-card rounded-lg border border-border-subtle p-5 hover:border-primary/30 transition-all cursor-pointer flex flex-col h-full shadow-card hover:shadow-card-hover relative",
          isPassed && "opacity-70 hover:opacity-100",
          selected && "ring-2 ring-[#003366] border-[#003366]"
        )}
      >
          {/* Header */}
          <div className="flex items-start gap-2 mb-4 pl-6 pr-8 min-w-0">
            <div className="size-10 rounded-lg bg-primary-light border border-primary/10 flex items-center justify-center text-[#003366] shrink-0">
              <span className="material-symbols-outlined text-[20px]">
                {deal.icon || "business_center"}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-text-main font-bold text-base leading-tight group-hover/card:text-[#003366] transition-colors truncate" title={getDealDisplayName(deal)}>
                {getDealDisplayName(deal)}
              </h3>
              <p className="text-text-muted text-xs font-medium truncate">
                {deal.industry || "\u2014"}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <ScorecardBadge scorecard={deal.scorecard} />
              <span
                className={cn(
                  "px-2 py-1 rounded-md border text-[10px] font-bold uppercase tracking-wider whitespace-nowrap leading-none",
                  style.bg,
                  style.border,
                  style.text
                )}
              >
                {STAGE_LABELS[deal.stage] || deal.stage}
              </span>
              {deal.tags?.includes("sample") && (
                <span className="px-2 py-1 rounded-md bg-amber-50 border border-amber-200 text-amber-700 text-[10px] font-bold uppercase tracking-wider">
                  Sample
                </span>
              )}
            </div>
          </div>

          {/* Dynamic Metrics Grid */}
          <div className={cn("grid gap-3 mb-4", activeMetrics.length >= 5 ? "grid-cols-3" : "grid-cols-2")}>
            {activeMetrics.map((key) => {
              const cfg = METRIC_CONFIG[key];
              if (!cfg) return null;
              const value = deal[key as keyof Deal] as number | undefined | null;
              return (
                <div key={key} className="bg-background-body rounded-md p-3">
                  <span className="text-text-muted text-[10px] font-bold uppercase tracking-wider block mb-1">
                    {cfg.label}
                  </span>
                  <span className={cn(
                    "font-bold text-lg",
                    key === "mom" && value != null && value >= 3 ? "text-secondary" : "",
                    key === "ebitda" && value != null && value < 0 ? "text-red-600" : "",
                    !(key === "mom" && value != null && value >= 3) && !(key === "ebitda" && value != null && value < 0) ? "text-text-main" : "",
                  )}>
                    {key === "irrProjected"
                      ? (value != null ? Number(value).toFixed(1) + "%" : "\u2014")
                      : key === "mom"
                        ? (value != null ? Number(value).toFixed(1) + "x" : "\u2014")
                        : formatCurrency(value as number | null | undefined, deal.currency)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* AI Thesis */}
          <div className="bg-background-body rounded-md p-3 mt-auto border border-border-subtle">
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className={cn(
                  "material-symbols-outlined text-[14px]",
                  hasRiskFlag ? "text-red-500" : "text-green-600"
                )}
              >
                {hasRiskFlag ? "warning" : "auto_awesome"}
              </span>
              <span
                className={cn(
                  "text-[10px] font-bold uppercase tracking-wider",
                  hasRiskFlag ? "text-red-500" : "text-green-600"
                )}
              >
                {hasRiskFlag ? "Risk Flag" : "AI Thesis"}
              </span>
            </div>
            <p className="text-text-secondary text-xs leading-relaxed line-clamp-2">
              {deal.aiThesis || "No AI analysis available yet."}
            </p>
          </div>

          {/* Risk Flag: Low EBITDA Margin */}
          {(deal.ebitda ?? 0) < 0 && (
            <div className="flex items-center gap-1.5 mt-3">
              <span className="material-symbols-outlined text-red-500 text-[14px]">warning</span>
              <span className="text-red-500 text-[11px] font-semibold">Low EBITDA margin</span>
            </div>
          )}

          {/* Data Completeness Bar */}
          {(() => {
            let filled = 0;
            const total = 6;
            if (deal.revenue) filled++;
            if (deal.ebitda) filled++;
            if (deal.dealSize) filled++;
            if (deal.aiThesis && deal.aiThesis !== "No AI analysis available yet.") filled++;
            if (deal.lastDocument) filled++;
            if (deal.industry) filled++;
            const completePct = Math.round((filled / total) * 100);
            const barColor = completePct >= 80 ? "#059669" : completePct >= 50 ? "#F59E0B" : "#9CA3AF";
            return (
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border-subtle">
                <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Data</span>
                <div className="flex-1 bg-gray-100 h-1.5 rounded-full overflow-hidden">
                  <div className="h-1.5 rounded-full transition-all" style={{ width: `${completePct}%`, background: barColor }} />
                </div>
                <span className="text-[10px] font-bold" style={{ color: barColor }}>{completePct}%</span>
              </div>
            );
          })()}

          {/* Footer */}
          <div className="flex items-center justify-between mt-3 pt-0">
            <div className="flex items-center gap-1.5 text-text-muted min-w-0">
              <span className="material-symbols-outlined text-[14px] shrink-0">
                {getDocIcon(deal.lastDocument)}
              </span>
              <span className="text-[11px] font-medium truncate max-w-[100px]">
                {deal.lastDocument || "No docs"}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Link
                href={`/data-room?dealId=${deal.id}`}
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-1 text-[11px] text-text-muted hover:text-[#003366] transition-colors"
                title="Open Data Room"
              >
                <span className="material-symbols-outlined text-[14px]">folder_open</span>
                <span className="hidden sm:inline">VDR</span>
              </Link>
              <span className="text-[11px] text-text-muted font-medium">
                {liveUpdated}
              </span>
            </div>
          </div>
      </article>
    </div>
  );
}
