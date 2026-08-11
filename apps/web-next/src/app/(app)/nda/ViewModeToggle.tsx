"use client";

import { cn } from "@/lib/cn";

export type ViewMode = "edit" | "preview";

interface ViewModeToggleProps {
  viewMode: ViewMode;
  onChange: (next: ViewMode) => void;
}

/**
 * Two-state segmented control: Edit | Preview.
 *
 * Edit mode shows raw token literals like `[COUNTERPARTY_NAME]` so the
 * user can keep editing the document body. Preview substitutes the tokens
 * with the current counterparty / firm / date metadata so the user sees
 * what the recipient will see. Live preview only — does not call the
 * backend; the actual outbound document is regenerated on send.
 *
 * Orthogonal to the snapshot toggle in FullEditPage (snapshot reads the
 * frozen `contentSnapshot`, preview reads the live `content` with
 * substitutions applied). The parent hides this toggle while a snapshot
 * is being viewed to avoid presenting two competing "view modes" at once.
 */
export function ViewModeToggle({ viewMode, onChange }: ViewModeToggleProps) {
  const segment =
    "px-3 py-1 text-xs font-semibold rounded transition-colors inline-flex items-center gap-1";
  return (
    <div
      role="group"
      aria-label="Editor view mode"
      className="inline-flex items-center gap-0.5 p-0.5 rounded-md border border-slate-200 bg-slate-50"
    >
      <button
        type="button"
        onClick={() => onChange("edit")}
        aria-pressed={viewMode === "edit"}
        className={cn(
          segment,
          viewMode === "edit"
            ? "bg-white text-[#003366] shadow-sm"
            : "text-slate-600 hover:text-slate-900",
        )}
      >
        <span className="material-symbols-outlined text-[14px]">edit</span>
        Edit
      </button>
      <button
        type="button"
        onClick={() => onChange("preview")}
        aria-pressed={viewMode === "preview"}
        className={cn(
          segment,
          viewMode === "preview"
            ? "bg-white text-[#003366] shadow-sm"
            : "text-slate-600 hover:text-slate-900",
        )}
      >
        <span className="material-symbols-outlined text-[14px]">
          visibility
        </span>
        Preview
      </button>
    </div>
  );
}
