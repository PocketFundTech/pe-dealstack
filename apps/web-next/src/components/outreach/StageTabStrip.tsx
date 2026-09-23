"use client";

import { cn } from "@/lib/cn";
import { STALE_STAGE_ID, STALE_VIEW_STAGE, type OutreachContact, type OutreachStage } from "./types";

// ---------------------------------------------------------------------------
// Sticky pill row across the top of the promoted list — replaces the
// StageSummaryCard grid. Same per-stage count and needs-review/duplicate
// signal (now a dot instead of a stat chip), but clicking a pill switches
// the single OutreachColumn rendered below instead of opening a modal.
// Still one stage visible at a time (real stages can hold 700+ contacts —
// rendering every stage's list inline at once is the exact problem the
// StageSummaryCard/modal split was built to avoid), it just no longer takes
// a click-then-modal round trip to get there.
// ---------------------------------------------------------------------------

/** Best-effort keyword match against a stage's free-text name — stage names
 *  are admin-configured (OutreachStage is a plain DB table, not a fixed
 *  enum), so nothing here can hardcode today's 6 stage names. Moved as-is
 *  from the now-deleted StageSummaryCard.tsx. */
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

function Pill({
  active,
  icon,
  label,
  count,
  flagged,
  onClick,
}: {
  active: boolean;
  icon: string;
  label: string;
  count: number;
  flagged?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 transition-colors",
        active
          ? "border-primary/20 bg-primary-light"
          : "border-transparent hover:bg-background-body",
      )}
    >
      <span
        className={cn("material-symbols-outlined text-[16px]", active ? "text-[#003366]" : "text-text-muted")}
      >
        {icon}
      </span>
      <span
        className={cn(
          "text-xs font-bold uppercase tracking-wider whitespace-nowrap",
          active ? "text-[#003366]" : "text-text-secondary",
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "rounded-full px-2 py-0.5 text-xs font-bold",
          active ? "bg-white text-[#003366]" : "bg-background-body text-text-muted",
        )}
      >
        {count}
      </span>
      {!!flagged && (
        <span className="size-1.5 shrink-0 rounded-full bg-amber-500" title={`${flagged} need review`} />
      )}
    </button>
  );
}

export function StageTabStrip({
  stages,
  contacts,
  staleContacts,
  activeStageId,
  onSelectStage,
}: {
  stages: OutreachStage[];
  contacts: OutreachContact[];
  staleContacts: OutreachContact[];
  activeStageId: string;
  onSelectStage: (stageId: string) => void;
}) {
  return (
    <nav className="sticky top-0 z-20 flex items-center gap-1.5 overflow-x-auto rounded-lg border border-border-subtle bg-surface-card p-1.5 shadow-sm">
      {stages.map((stage) => {
        const stageContacts = contacts.filter((c) => c.stageId === stage.id);
        const flagged = stageContacts.filter((c) => c.needsReview || c.needsMatchReview).length;
        return (
          <Pill
            key={stage.id}
            active={activeStageId === stage.id}
            icon={iconForStage(stage.name)}
            label={stage.name}
            count={stageContacts.length}
            flagged={flagged}
            onClick={() => onSelectStage(stage.id)}
          />
        );
      })}
      <div className="mx-1 h-6 w-px shrink-0 bg-border-subtle" />
      <Pill
        active={activeStageId === STALE_STAGE_ID}
        icon="schedule"
        label={STALE_VIEW_STAGE.name}
        count={staleContacts.length}
        onClick={() => onSelectStage(STALE_STAGE_ID)}
      />
    </nav>
  );
}
