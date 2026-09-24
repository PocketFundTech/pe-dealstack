"use client";

import { cn } from "@/lib/cn";
import { CsvImportButton } from "./CsvImportButton";

// ---------------------------------------------------------------------------
// Board header: contact/stage count + the import/sync/add-contact actions.
// Extracted out of OutreachBoard.tsx to stay under the repo's 500-line cap
// once bulk-select + drag-and-drop pushed it over — same reasoning as the
// CsvImportButton extraction earlier.
// ---------------------------------------------------------------------------
export function OutreachToolbar({
  contactCount,
  stageCount,
  onImported,
  syncingReplies,
  onSyncReplies,
  canAddContact,
  onAddContact,
}: {
  contactCount: number;
  stageCount: number;
  onImported: () => void | Promise<void>;
  syncingReplies: boolean;
  onSyncReplies: () => void;
  canAddContact: boolean;
  onAddContact: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm text-text-muted">
        {contactCount} contact{contactCount !== 1 ? "s" : ""} across {stageCount} stage
        {stageCount !== 1 ? "s" : ""}
      </p>
      <div className="flex items-center gap-2">
        <CsvImportButton
          label="Import from Private Circle"
          endpoint="/outreach/import/private-circle"
          onImported={onImported}
        />
        <CsvImportButton label="Import from Clay CSV" endpoint="/outreach/import/clay-csv" onImported={onImported} />
        <button
          type="button"
          onClick={onSyncReplies}
          disabled={syncingReplies}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border-subtle bg-surface-card text-text-secondary shadow-sm hover:bg-primary-light hover:text-[#003366] hover:border-primary/30 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span className={cn("material-symbols-outlined text-[18px]", syncingReplies && "animate-spin")}>
            {syncingReplies ? "progress_activity" : "sync"}
          </span>
          {syncingReplies ? "Syncing..." : "Sync Replies"}
        </button>
        <button
          type="button"
          disabled={!canAddContact}
          onClick={onAddContact}
          className="flex items-center gap-2 px-4 py-2 text-white rounded-lg shadow-sm hover:bg-[#002855] transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ backgroundColor: "#003366" }}
        >
          <span className="material-symbols-outlined text-[18px]">person_add</span>
          Add Contact
        </button>
      </div>
    </div>
  );
}
