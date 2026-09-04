"use client";

import { cn } from "@/lib/cn";
import type { OutreachContact, OutreachStage } from "./types";

// ---------------------------------------------------------------------------
// The main board's default view is a grid of these — one per pipeline
// stage, compact stats only, no individual contact cards. Click one to open
// StageDetailModal, which is where the actual per-contact list lives.
// Replaces the old inline-row-of-columns layout: with real import volumes
// (700+ contacts), showing every card inline made the board itself the
// thing you had to scroll past, not a useful overview.
//
// Stage names are admin-configured (OutreachStage is a plain DB table, not
// a fixed enum — see the touch-log migration's own comment that stage
// taxonomy still needs a human workshop), so the icon lookup below is a
// best-effort keyword match with a generic fallback, not a hardcoded map
// keyed to today's 6 stage names. The `icon` prop overrides this lookup
// entirely — used by OutreachBoard.tsx's synthetic "Stale" tile, which
// passes a fake `OutreachStage` (this component only reads `id`/`name`/
// `position` off it, so a lightweight literal works fine) and needs a
// clock icon rather than whatever iconForStage("Stale") would guess, so it
// doesn't read as a 7th real pipeline stage.
//
// The outer element is a `<div role="button">`, not a real `<button>`,
// because the optional "Enrich all" quick action below renders a nested
// `<button>` — the same div+role pattern OutreachCard.tsx already uses for
// the same reason (a `<button>` can't contain another `<button>`).
// ---------------------------------------------------------------------------

function iconForStage(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("source")) return "travel_explore";
  if (n.includes("enrich")) return "auto_awesome";
  if (n.includes("send")) return "send";
  if (n.includes("reply") || n.includes("handle")) return "forum";
  if (n.includes("escalat")) return "trending_up";
  if (n.includes("meeting") || n.includes("book")) return "event_available";
  return "view_column";
}

/** True when a contact actually got enrichment data back, not just an
 *  attempt — same definition the card badge and bulk-enrich toast use. */
function isReallyEnriched(contact: OutreachContact): boolean {
  return Boolean(contact.enrichedAt && contact.enrichmentSource && contact.enrichmentSource.length > 0);
}

export function StageSummaryCard({
  stage,
  contacts,
  onOpen,
  icon,
  onEnrichAll,
  enriching = false,
}: {
  stage: OutreachStage;
  /** Only this stage's contacts — caller filters, same as OutreachColumn expected before. */
  contacts: OutreachContact[];
  onOpen: (stageId: string) => void;
  /** Overrides the auto-derived iconForStage lookup — see header comment. */
  icon?: string;
  /** Only passed for the lowest-position ("Source") stage's tile — a
   *  one-click "enrich everything currently in this stage" quick action.
   *  See useOutreachSelection.ts's enrichAllInStage. Omitted entirely for
   *  every other tile (including the synthetic "Stale" one). */
  onEnrichAll?: () => void;
  /** True while a bulk enrich (from this button, the BulkActionsBar, or
   *  another stage's own "Enrich all") is in flight — reused as-is from
   *  useOutreachSelection's `bulkEnriching` so the two entry points can't
   *  race each other. */
  enriching?: boolean;
}) {
  const total = contacts.length;
  const needsReviewCount = contacts.filter((c) => c.needsReview).length;
  const needsMatchReviewCount = contacts.filter((c) => c.needsMatchReview).length;
  const enrichedCount = contacts.filter(isReallyEnriched).length;
  const proprietaryCount = contacts.filter((c) => c.channel === "proprietary").length;
  const brokerCount = total - proprietaryCount;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(stage.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) onOpen(stage.id);
      }}
      className="flex flex-col gap-3 text-left w-[260px] shrink-0 bg-surface-card rounded-xl border border-border-subtle p-4 shadow-sm hover:shadow-md hover:border-primary/30 transition-all cursor-pointer"
    >
      <div className="flex items-center gap-2">
        <div className="size-9 rounded-lg bg-primary-light border border-primary/10 flex items-center justify-center text-[#003366] shrink-0">
          <span className="material-symbols-outlined text-[18px]">{icon ?? iconForStage(stage.name)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold uppercase tracking-wider text-text-secondary truncate" title={stage.name}>
            {stage.name}
          </h3>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-1.5">
          <span className="text-3xl font-bold text-text-main">{total}</span>
          <span className="text-xs text-text-muted">contact{total !== 1 ? "s" : ""}</span>
        </div>
        {onEnrichAll && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEnrichAll();
            }}
            disabled={enriching || total === 0}
            title={`Enrich all ${total} contact${total !== 1 ? "s" : ""} in ${stage.name}`}
            className="flex items-center gap-1 shrink-0 px-2 py-1 rounded-md border border-border-subtle bg-background-body text-[11px] font-medium text-text-secondary hover:bg-primary-light hover:text-[#003366] hover:border-primary/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className={cn("material-symbols-outlined text-[13px]", enriching && "animate-spin")}>
              {enriching ? "progress_activity" : "auto_awesome"}
            </span>
            {enriching ? "Enriching" : `Enrich all ${total}`}
          </button>
        )}
      </div>

      {total > 0 && (
        <p className="text-[11px] text-text-muted">
          {proprietaryCount} proprietary · {brokerCount} broker
        </p>
      )}

      {(needsReviewCount > 0 || needsMatchReviewCount > 0 || enrichedCount > 0) && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {enrichedCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[10px] font-medium border border-emerald-200">
              <span className="material-symbols-outlined text-[12px]">auto_awesome</span>
              {enrichedCount} enriched
            </span>
          )}
          {needsReviewCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-bold border border-amber-300">
              <span className="material-symbols-outlined text-[12px]">warning</span>
              {needsReviewCount} needs review
            </span>
          )}
          {needsMatchReviewCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 text-[10px] font-bold border border-violet-300">
              <span className="material-symbols-outlined text-[12px]">content_copy</span>
              {needsMatchReviewCount} duplicate{needsMatchReviewCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      )}

      {total === 0 && <p className="text-xs text-text-muted italic">No contacts yet</p>}

      <span
        className={cn(
          "self-start flex items-center gap-1 text-xs font-medium text-[#003366] mt-1",
        )}
      >
        View list
        <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
      </span>
    </div>
  );
}
