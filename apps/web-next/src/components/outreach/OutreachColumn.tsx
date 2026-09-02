"use client";

import { type DragEvent } from "react";
import { cn } from "@/lib/cn";
import { OutreachCard } from "./OutreachCard";
import type { OutreachContact, OutreachStage } from "./types";

// ---------------------------------------------------------------------------
// One pipeline-stage column: header (name + count + add button) and its cards.
// ---------------------------------------------------------------------------
export function OutreachColumn({
  stage,
  contacts,
  allStages,
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
  onAddContact: (stageId: string) => void;
  onOpenContact: (contact: OutreachContact) => void;
  onMoveContact: (contactId: string, stageId: string) => void;
  onEnrichContact: (contactId: string) => void;
  /** Contact id currently mid-enrichment, if any. */
  enrichingContactId: string | null;
  /** For bulk "Move to stage" — see useOutreachSelection.ts. */
  selectedIds: Set<string>;
  onToggleSelect: (contactId: string) => void;
  onToggleSelectAll: (stageId: string) => void;
  /** For single-card drag-and-drop — the stage id currently being dragged over, if any. */
  dragOverStageId: string | null;
  onDragOverStage: (stageId: string) => void;
  onDragLeaveStage: () => void;
  onDropOnStage: (e: DragEvent<HTMLDivElement>, stageId: string) => void;
}) {
  const otherStages = allStages.filter((s) => s.id !== stage.id);
  const allSelectedInStage = contacts.length > 0 && contacts.every((c) => selectedIds.has(c.id));

  return (
    <div className="flex-1 min-w-0" data-stage-id={stage.id}>
      <div className="bg-surface-card rounded-xl border border-border-subtle overflow-hidden h-full flex flex-col">
        <div className="px-4 py-3 border-b border-border-subtle bg-background-body">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <input
                type="checkbox"
                checked={allSelectedInStage}
                onChange={() => onToggleSelectAll(stage.id)}
                disabled={contacts.length === 0}
                className="size-3.5 shrink-0 rounded border-border-subtle accent-[#003366] cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={`Select all contacts in ${stage.name}`}
                title={`Select all in ${stage.name}`}
              />
              <span className="text-xs font-bold uppercase tracking-wider text-text-secondary truncate" title={stage.name}>
                {stage.name}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-xs font-bold bg-white/70 border border-border-subtle px-2 py-0.5 rounded-full text-text-muted">
                {contacts.length}
              </span>
              <button
                type="button"
                onClick={() => onAddContact(stage.id)}
                className="flex items-center justify-center size-6 rounded-md text-text-muted hover:bg-white hover:text-primary transition-colors"
                title={`Add contact to ${stage.name}`}
                aria-label={`Add contact to ${stage.name}`}
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
              </button>
            </div>
          </div>
        </div>
        <div
          className={cn(
            "flex-1 p-3 space-y-3 overflow-y-auto max-h-[calc(100vh-320px)] border-2 border-dashed border-transparent rounded-lg transition-all custom-scrollbar",
            dragOverStageId === stage.id && "bg-[rgba(0,51,102,0.05)] border-[rgba(0,51,102,0.3)]",
          )}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            onDragOverStage(stage.id);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) onDragLeaveStage();
          }}
          onDrop={(e) => onDropOnStage(e, stage.id)}
        >
          {contacts.map((contact) => (
            <OutreachCard
              key={contact.id}
              contact={contact}
              otherStages={otherStages}
              onOpen={onOpenContact}
              onMove={onMoveContact}
              onEnrich={onEnrichContact}
              enriching={enrichingContactId === contact.id}
              selected={selectedIds.has(contact.id)}
              onToggleSelect={onToggleSelect}
            />
          ))}
          {contacts.length === 0 && (
            <div className="text-center py-8 text-text-muted text-sm">
              <span className="material-symbols-outlined text-2xl mb-2 block opacity-40">inbox</span>
              No contacts yet
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
