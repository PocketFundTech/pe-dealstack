"use client";

import { type DragEvent } from "react";
import { OutreachColumn } from "./OutreachColumn";
import type { OutreachContact, OutreachStage } from "./types";

// ---------------------------------------------------------------------------
// Opened by clicking a StageSummaryCard — a modal shell around
// OutreachColumn's existing header+list, which used to render inline as one
// of a row of columns and now renders exclusively in here. Every prop below
// is a pass-through to OutreachColumn; this component owns none of the
// board logic itself, just the modal chrome.
// ---------------------------------------------------------------------------
export function StageDetailModal({
  stage,
  contacts,
  allStages,
  onClose,
  onAddContact,
  onOpenContact,
  onMoveContact,
  onEnrichContact,
  enrichingContactId,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  dragOverStageId,
  onDragOverStage,
  onDragLeaveStage,
  onDropOnStage,
}: {
  stage: OutreachStage;
  contacts: OutreachContact[];
  allStages: OutreachStage[];
  onClose: () => void;
  onAddContact: (stageId: string) => void;
  onOpenContact: (contact: OutreachContact) => void;
  onMoveContact: (contactId: string, stageId: string) => void;
  onEnrichContact: (contactId: string) => void;
  enrichingContactId: string | null;
  selectedIds: Set<string>;
  onToggleSelect: (contactId: string) => void;
  onToggleSelectAll: (stageId: string) => void;
  dragOverStageId: string | null;
  onDragOverStage: (stageId: string) => void;
  onDragLeaveStage: () => void;
  onDropOnStage: (e: DragEvent<HTMLDivElement>, stageId: string) => void;
}) {
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
          stage={stage}
          contacts={contacts}
          allStages={allStages}
          onAddContact={onAddContact}
          onOpenContact={onOpenContact}
          onMoveContact={onMoveContact}
          onEnrichContact={onEnrichContact}
          enrichingContactId={enrichingContactId}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          onToggleSelectAll={onToggleSelectAll}
          dragOverStageId={dragOverStageId}
          onDragOverStage={onDragOverStage}
          onDragLeaveStage={onDragLeaveStage}
          onDropOnStage={onDropOnStage}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
