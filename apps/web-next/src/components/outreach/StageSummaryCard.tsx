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
// keyed to today's 6 stage names.
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
}: {
  stage: OutreachStage;
  /** Only this stage's contacts — caller filters, same as OutreachColumn expected before. */
  contacts: OutreachContact[];
  onOpen: (stageId: string) => void;
}) {
  const total = contacts.length;
  const needsReviewCount = contacts.filter((c) => c.needsReview).length;
  const needsMatchReviewCount = contacts.filter((c) => c.needsMatchReview).length;
  const enrichedCount = contacts.filter(isReallyEnriched).length;
  const proprietaryCount = contacts.filter((c) => c.channel === "proprietary").length;
  const brokerCount = total - proprietaryCount;

  return (
    <button
      type="button"
      onClick={() => onOpen(stage.id)}
      className="flex flex-col gap-3 text-left w-[260px] shrink-0 bg-surface-card rounded-xl border border-border-subtle p-4 shadow-sm hover:shadow-md hover:border-primary/30 transition-all"
    >
      <div className="flex items-center gap-2">
        <div className="size-9 rounded-lg bg-primary-light border border-primary/10 flex items-center justify-center text-[#003366] shrink-0">
          <span className="material-symbols-outlined text-[18px]">{iconForStage(stage.name)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold uppercase tracking-wider text-text-secondary truncate" title={stage.name}>
            {stage.name}
          </h3>
        </div>
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="text-3xl font-bold text-text-main">{total}</span>
        <span className="text-xs text-text-muted">contact{total !== 1 ? "s" : ""}</span>
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
    </button>
  );
}
