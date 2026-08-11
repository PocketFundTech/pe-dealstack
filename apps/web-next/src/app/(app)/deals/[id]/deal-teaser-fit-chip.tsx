"use client";

import { cn } from "@/lib/cn";
import type { TeaserFit, TeaserVerdict } from "@/lib/teaser";

// ---------------------------------------------------------------------------
// Firm Teaser — single criterion fit row.
//
// Renders one TeaserFit: the criterion label, a colored verdict chip
// (fit = green, partial = amber, miss = red) and the model's note. Kept in
// its own file so DealTeasers.tsx stays well under the 500-line cap.
// ---------------------------------------------------------------------------

// Per-verdict presentation. Centralised here so chip colors and labels stay
// consistent and there are no magic strings sprinkled through the JSX.
const VERDICT_STYLES: Record<
  TeaserVerdict,
  { label: string; chip: string; icon: string }
> = {
  fit: {
    label: "Fit",
    chip: "bg-green-50 text-green-700 border-green-200",
    icon: "check_circle",
  },
  partial: {
    label: "Partial",
    chip: "bg-amber-50 text-amber-700 border-amber-200",
    icon: "remove_circle",
  },
  miss: {
    label: "Miss",
    chip: "bg-red-50 text-red-700 border-red-200",
    icon: "cancel",
  },
};

export function TeaserFitChip({ fit }: { fit: TeaserFit }) {
  // Unknown verdicts (e.g. a future API value) fall back to "partial" styling
  // so the row still renders rather than crashing on an undefined lookup.
  const style = VERDICT_STYLES[fit.verdict] ?? VERDICT_STYLES.partial;

  return (
    <div className="flex items-start gap-3 py-2">
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
          style.chip,
        )}
      >
        <span className="material-symbols-outlined text-[14px]">{style.icon}</span>
        {style.label}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-medium text-text-main">{fit.criterion}</div>
        {fit.note && (
          <p className="mt-0.5 text-sm text-text-secondary leading-relaxed">
            {fit.note}
          </p>
        )}
      </div>
    </div>
  );
}
