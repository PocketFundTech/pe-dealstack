"use client";

import type { OutreachStage } from "./types";

// ---------------------------------------------------------------------------
// Appears above the board whenever one or more cards are selected. A plain
// <select> rather than a custom dropdown menu (matches the pattern used
// elsewhere for simple pick-one lists) — no open/close state or
// click-outside handling to get wrong for what's a one-shot action.
// ---------------------------------------------------------------------------
export function BulkActionsBar({
  count,
  stages,
  moving,
  onMove,
  onClear,
}: {
  count: number;
  stages: OutreachStage[];
  moving: boolean;
  onMove: (stageId: string) => void;
  onClear: () => void;
}) {
  if (count === 0) return null;

  return (
    <div className="sticky top-0 z-30 rounded-lg border border-primary/30 bg-primary-light shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <span className="text-sm font-semibold text-[#003366]">
          {count} contact{count !== 1 ? "s" : ""} selected
        </span>
        <div className="flex items-center gap-2">
          <select
            disabled={moving}
            value=""
            onChange={(e) => {
              if (e.target.value) onMove(e.target.value);
            }}
            className="px-3 py-1.5 rounded-md border border-primary/30 bg-white text-sm font-medium text-[#003366] disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Move selected contacts to stage"
          >
            <option value="" disabled>
              {moving ? "Moving..." : "Move to..."}
            </option>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onClear}
            disabled={moving}
            className="px-3 py-1.5 rounded-md border border-border-subtle bg-white text-text-secondary text-sm font-medium hover:bg-background-body transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Clear
          </button>
        </div>
      </div>
      {/* Indeterminate progress bar — visible feedback for bulk-moving tens/hundreds
          of contacts, beyond the small spinner text in the disabled <select>. Reuses
          the shared .import-progress-track/-fill pair from globals.css. Sits flush
          along the bar's bottom edge; `overflow-hidden` above clips it to the
          container's rounded corners (matches the .pe-toast-progress-bar pattern). */}
      {moving && (
        <div className="import-progress-track">
          <div className="import-progress-fill" />
        </div>
      )}
    </div>
  );
}
