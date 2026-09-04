"use client";

import type { StageMoveSuggestion } from "./types";

// ---------------------------------------------------------------------------
// Shared "Claude suggests..." banner for the reply-intent move suggestion
// (see suggestStageMove in types.ts for the rule). Two variants:
//   - "compact": OutreachCard's Kanban card — small, low-key, doesn't compete
//     visually with the amber needsReview / violet needsMatchReview badges.
//   - "full": ContactFormModal's contact detail popup — more room, includes
//     the one-line reasoning.
// Purely presentational — callers own the dismiss state (ephemeral, no
// persistence by design) and the Accept handler (which stage move mechanism
// it calls differs per caller — see each file).
// ---------------------------------------------------------------------------
export function StageSuggestionBanner({
  suggestion,
  variant,
  onAccept,
  onDismiss,
  disabled,
}: {
  suggestion: StageMoveSuggestion;
  variant: "compact" | "full";
  onAccept: () => void;
  onDismiss: () => void;
  /** Disables the Accept button — e.g. while the parent form is saving. */
  disabled?: boolean;
}) {
  if (variant === "compact") {
    return (
      <div className="mt-2 flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 text-indigo-700">
        <span className="material-symbols-outlined text-[13px] shrink-0">auto_awesome</span>
        <p
          className="min-w-0 flex-1 truncate text-[10px] font-medium"
          title={`Claude suggests: ${suggestion.stageName}`}
        >
          Claude suggests: <span className="font-bold">{suggestion.stageName}</span>
        </p>
        <button
          type="button"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onAccept();
          }}
          className="flex items-center justify-center size-5 rounded text-indigo-600 hover:bg-indigo-100 transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
          title={`Accept — move to ${suggestion.stageName}`}
          aria-label={`Accept suggestion — move to ${suggestion.stageName}`}
        >
          <span className="material-symbols-outlined text-[13px]">check</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className="flex items-center justify-center size-5 rounded text-indigo-400 hover:bg-indigo-100 hover:text-indigo-600 transition-colors shrink-0"
          title="Dismiss suggestion"
          aria-label="Dismiss suggestion"
        >
          <span className="material-symbols-outlined text-[13px]">close</span>
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <span className="material-symbols-outlined text-[14px] text-indigo-600">auto_awesome</span>
        <span className="text-xs font-bold uppercase tracking-wider text-indigo-700">Claude Suggests</span>
      </div>
      <p className="text-sm text-indigo-900">
        Based on their reply, Claude suggests moving this contact to{" "}
        <span className="font-semibold">{suggestion.stageName}</span>.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={onAccept}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-indigo-300 text-indigo-700 text-xs font-medium hover:bg-indigo-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span className="material-symbols-outlined text-[14px]">check_circle</span>
          Move to {suggestion.stageName}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border-subtle text-text-secondary text-xs font-medium hover:bg-gray-50 transition-colors"
        >
          <span className="material-symbols-outlined text-[14px]">close</span>
          Dismiss
        </button>
      </div>
    </div>
  );
}
