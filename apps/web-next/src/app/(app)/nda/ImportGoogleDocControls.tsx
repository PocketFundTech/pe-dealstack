"use client";

import { cn } from "@/lib/cn";

// Presentational controls for the Google Doc import form, split out of
// ImportGoogleDocFlow.tsx to keep that file under the 500-line cap. These are
// pure UI — all state + the picker call live in the parent.

/**
 * "Choose from Google Drive" primary control. Disabled (with a dev-facing note)
 * when the NEXT_PUBLIC_GOOGLE_* env trio isn't set — the user is the admin, so
 * the note names exactly which vars to configure.
 */
export function ChooseFromDriveButton({
  configured,
  picking,
  disabled,
  onClick,
}: {
  configured: boolean;
  picking: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || !configured}
        className={cn(
          "w-full px-4 py-3 rounded-md text-sm font-semibold text-white inline-flex items-center justify-center gap-2",
          disabled || !configured
            ? "opacity-60 cursor-not-allowed"
            : "hover:opacity-90",
        )}
        style={{ backgroundColor: "#003366" }}
      >
        <span
          className={cn(
            "material-symbols-outlined text-[18px]",
            picking && "animate-spin",
          )}
        >
          {picking ? "progress_activity" : "add_to_drive"}
        </span>
        {picking ? "Opening Google Drive…" : "Choose from Google Drive"}
      </button>
      {!configured && (
        <p className="mt-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-2 leading-snug">
          Google Drive picker isn&rsquo;t configured yet — set{" "}
          <code className="font-mono">NEXT_PUBLIC_GOOGLE_CLIENT_ID</code>,{" "}
          <code className="font-mono">NEXT_PUBLIC_GOOGLE_API_KEY</code> and{" "}
          <code className="font-mono">NEXT_PUBLIC_GOOGLE_APP_ID</code>.
        </p>
      )}
    </div>
  );
}

/**
 * Read-only chip showing the picked Doc with a "Change" affordance that
 * re-opens the Picker.
 */
export function PickedDocChip({
  name,
  disabled,
  onChange,
}: {
  name: string;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
      <span className="material-symbols-outlined text-[20px] text-[#003366] shrink-0">
        description
      </span>
      <span className="flex-1 min-w-0 text-sm text-slate-900 truncate font-medium">
        {name}
      </span>
      <button
        type="button"
        onClick={onChange}
        disabled={disabled}
        className="text-xs font-semibold text-[#003366] hover:underline disabled:opacity-50 disabled:no-underline shrink-0"
      >
        Change
      </button>
    </div>
  );
}
