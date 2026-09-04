"use client";

import { OutreachColumn } from "./OutreachColumn";
import type { OutreachContact, OutreachStage } from "./types";

/** Synthetic, non-DB "stage" used purely to give the Stale view the same
 *  header/count chrome as a real StageSummaryCard tile and the same
 *  OutreachColumn list rendering below — it is never written to a
 *  contact's real `stageId`. See useOutreachStaleness.ts for how staleness
 *  itself is computed, and OutreachBoard.tsx for where this id/stage get
 *  wired into the board's existing `openStageId` state. */
export const STALE_STAGE_ID = "__stale__";
export const STALE_VIEW_STAGE: OutreachStage = { id: STALE_STAGE_ID, name: "Stale", position: -1 };

// ---------------------------------------------------------------------------
// Opened by clicking the board's synthetic "Stale" tile — a "needs
// attention" cross-cutting list of contacts untouched for longer than the
// org's configured staleDays, regardless of which real pipeline stage
// they're actually in (see useOutreachStaleness.ts). Reuses OutreachColumn
// for the actual card list/selection/detail-open rendering, same pattern as
// StageDetailModal, but three things can't just pass straight through
// unmodified since "Stale" isn't a real stage any contact ever belongs to:
//
//   - "Select all" can't reuse useOutreachSelection's toggleSelectAllInStage
//     — that looks up which contacts belong to a stage by real `stageId`,
//     and nothing here actually has stageId "__stale__". Built locally
//     instead from the hook's generic per-contact `toggleSelect`, which
//     doesn't care what stage anything is in.
//   - Drag-and-drop "drop into this stage" is disabled here (no-op
//     handlers) rather than wired to the board's real handleMove — dropping
//     a card into this list would otherwise PATCH its stageId to the
//     literal string "__stale__".
//   - "Add contact" still works, it just creates the new contact in the
//     real default stage (`defaultAddStageId`, the board's lowest-position
//     stage) rather than the synthetic one.
//
// Everything else — open contact detail, per-card "Move to..." (uses the
// contact's actual current stageId), per-card Enrich, Send — passes
// straight through to the board's existing handlers unchanged: this is
// purely a filtered *display* list, not a different set of actions.
// ---------------------------------------------------------------------------
export function StaleContactsModal({
  contacts,
  allStages,
  defaultAddStageId,
  onClose,
  onAddContact,
  onOpenContact,
  onMoveContact,
  onEnrichContact,
  enrichingContactId,
  selectedIds,
  onToggleSelect,
  onSendContact,
}: {
  /** Already-filtered stale contacts — see useOutreachStaleness.ts. */
  contacts: OutreachContact[];
  allStages: OutreachStage[];
  /** Where a new contact created from this view actually lands — the
   *  board's lowest-position ("Source") stage, since "Stale" isn't a real
   *  stage to add into. */
  defaultAddStageId: string;
  onClose: () => void;
  onAddContact: (stageId: string) => void;
  onOpenContact: (contact: OutreachContact) => void;
  onMoveContact: (contactId: string, stageId: string) => void;
  onEnrichContact: (contactId: string) => void;
  enrichingContactId: string | null;
  selectedIds: Set<string>;
  onToggleSelect: (contactId: string) => void;
  onSendContact: (contactId: string) => void;
}) {
  // Local "toggle select all" built from the generic per-id toggleSelect —
  // see header comment for why toggleSelectAllInStage doesn't fit here.
  // Mirrors that hook's own select/deselect-all logic, just against this
  // filtered list instead of a real stageId lookup.
  function toggleSelectAllStale() {
    const ids = contacts.map((c) => c.id);
    const allSelected = ids.length > 0 && ids.every((id) => selectedIds.has(id));
    for (const id of ids) {
      if (selectedIds.has(id) === allSelected) onToggleSelect(id);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-md p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface-card rounded-xl shadow-2xl w-full max-w-2xl h-[85vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <OutreachColumn
          stage={STALE_VIEW_STAGE}
          contacts={contacts}
          allStages={allStages}
          onAddContact={() => onAddContact(defaultAddStageId)}
          onOpenContact={onOpenContact}
          onMoveContact={onMoveContact}
          onEnrichContact={onEnrichContact}
          enrichingContactId={enrichingContactId}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          onToggleSelectAll={toggleSelectAllStale}
          dragOverStageId={null}
          onDragOverStage={() => {}}
          onDragLeaveStage={() => {}}
          onDropOnStage={(e) => e.preventDefault()}
          onClose={onClose}
          onSendContact={onSendContact}
        />
      </div>
    </div>
  );
}
