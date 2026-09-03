"use client";

import { cn } from "@/lib/cn";
import type { OutreachStage } from "./types";

// ---------------------------------------------------------------------------
// Appears above the board whenever one or more cards are selected. The
// "Move to..." picker is a plain <select> rather than a custom dropdown
// (matches the pattern used elsewhere for simple pick-one lists) — no
// open/close state or click-outside handling to get wrong for a one-shot
// action. "Enrich" is a single button (no picker needed — it always runs
// every configured provider, same as the per-card action).
//
// Deliberately NOT here: a bulk "Send" action. The backend endpoint for
// sending via Reply.io (POST /contacts/:id/send) exists but has never been
// wired to any UI, bulk or single. It requires a real email per contact
// (Reply.io has no phone/LinkedIn-only path today), which the two real
// import sources never provide, and REPLY_IO_API_KEY is genuinely
// configured on this deployment — so a Send button here would either 400
// for almost every contact or, worse, actually email the rare one that
// does have an address. Building that needs an explicit answer on whether
// this Reply.io account is live or a test workspace, and the
// double-confirmation flow that was asked for — not a quiet addition
// alongside Move/Enrich.
// ---------------------------------------------------------------------------
export function BulkActionsBar({
  count,
  stages,
  moving,
  enriching,
  onMove,
  onEnrich,
  onClear,
}: {
  count: number;
  stages: OutreachStage[];
  moving: boolean;
  enriching: boolean;
  onMove: (stageId: string) => void;
  onEnrich: () => void;
  onClear: () => void;
}) {
  if (count === 0) return null;
  const busy = moving || enriching;

  return (
    <div className="sticky top-0 z-30 rounded-lg border border-primary/30 bg-primary-light shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <span className="text-sm font-semibold text-[#003366]">
          {count} contact{count !== 1 ? "s" : ""} selected
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onEnrich}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-primary/30 bg-white text-sm font-medium text-[#003366] hover:bg-primary-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className={cn("material-symbols-outlined text-[16px]", enriching && "animate-spin")}>
              {enriching ? "progress_activity" : "auto_awesome"}
            </span>
            {enriching ? "Enriching..." : "Enrich"}
          </button>
          <select
            disabled={busy}
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
            disabled={busy}
            className="px-3 py-1.5 rounded-md border border-border-subtle bg-white text-text-secondary text-sm font-medium hover:bg-background-body transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Clear
          </button>
        </div>
      </div>
      {/* Indeterminate progress bar — visible feedback for a bulk action across
          tens/hundreds of contacts, beyond the small spinner text on the button
          or the disabled <select>. Reuses the shared .import-progress-track/-fill
          pair from globals.css. Sits flush along the bar's bottom edge;
          `overflow-hidden` above clips it to the container's rounded corners
          (matches the .pe-toast-progress-bar pattern). */}
      {busy && (
        <div className="import-progress-track">
          <div className="import-progress-fill" />
        </div>
      )}
    </div>
  );
}
