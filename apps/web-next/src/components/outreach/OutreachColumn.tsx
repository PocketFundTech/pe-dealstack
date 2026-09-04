"use client";

import { useState, type DragEvent } from "react";
import { cn } from "@/lib/cn";
import { OutreachCard } from "./OutreachCard";
import type { OutreachContact, OutreachStage } from "./types";

// ---------------------------------------------------------------------------
// One pipeline stage's full contact list: header (name + count + select-all
// + add button [+ close, when hosted in a modal] + a name/company search
// row) and its cards. Used exclusively inside StageDetailModal (the main
// board shows StageSummaryCard tiles instead — clicking one opens this) —
// sized to fill whatever container it's placed in (flex-1 +
// overflow-y-auto), not a fixed viewport-relative height, since it's no
// longer an inline sibling in a row of columns. Real stages can hold 700+
// contacts, so the search box is what makes finding one tractable.
//
// The search box filters only what's rendered (`filteredContacts`) — the
// "select all" checkbox intentionally keeps operating on the full,
// unfiltered `contacts` list via `onToggleSelectAll` (bulk-move semantics
// are out of scope here; don't wire selection to the filtered list).
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
  onClose,
  onSendContact,
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
  /** Present when hosted inside StageDetailModal — renders a close button in the header. */
  onClose?: () => void;
  /** Opens SendConfirmModal for one contact — see OutreachCard.tsx. */
  onSendContact: (contactId: string) => void;
}) {
  const [search, setSearch] = useState("");

  const otherStages = allStages.filter((s) => s.id !== stage.id);
  const allSelectedInStage = contacts.length > 0 && contacts.every((c) => selectedIds.has(c.id));

  // Case-insensitive substring match against name OR company. Left
  // deliberately independent of the "select all" checkbox above, which
  // still operates on the full unfiltered `contacts` — see onToggleSelectAll.
  const q = search.trim().toLowerCase();
  const isSearching = q.length > 0;
  const filteredContacts = contacts.filter(
    (c) => c.name.toLowerCase().includes(q) || (c.company ?? "").toLowerCase().includes(q),
  );

  return (
    <div className="h-full flex flex-col min-h-0" data-stage-id={stage.id}>
      <div className="px-4 py-3 border-b border-border-subtle bg-background-body shrink-0 flex flex-col gap-2">
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
            <span className="text-sm font-bold text-text-main truncate" title={stage.name}>
              {stage.name}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-xs font-bold bg-white/70 border border-border-subtle px-2 py-0.5 rounded-full text-text-muted">
              {isSearching ? `${filteredContacts.length} of ${contacts.length}` : contacts.length}
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
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="flex items-center justify-center size-6 rounded-md text-text-muted hover:bg-white hover:text-text-main transition-colors"
                aria-label="Close"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            )}
          </div>
        </div>
        <div className="relative">
          <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[16px] pointer-events-none">
            search
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or company..."
            aria-label={`Search contacts in ${stage.name}`}
            className="w-full rounded-lg border border-border-subtle bg-white pl-8 pr-8 py-1.5 text-sm text-text-main placeholder-text-muted focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center size-5 rounded-md text-text-muted hover:bg-gray-100 hover:text-text-main transition-colors"
              aria-label="Clear search"
              title="Clear search"
            >
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          )}
        </div>
      </div>
      <div
        className={cn(
          "flex-1 min-h-0 p-3 space-y-3 overflow-y-auto border-2 border-dashed border-transparent rounded-lg transition-all custom-scrollbar",
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
        {filteredContacts.map((contact) => (
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
            onSend={onSendContact}
          />
        ))}
        {contacts.length === 0 && (
          <div className="text-center py-8 text-text-muted text-sm">
            <span className="material-symbols-outlined text-2xl mb-2 block opacity-40">inbox</span>
            No contacts yet
          </div>
        )}
        {contacts.length > 0 && isSearching && filteredContacts.length === 0 && (
          <div className="text-center py-8 text-text-muted text-sm">
            <span className="material-symbols-outlined text-2xl mb-2 block opacity-40">search_off</span>
            No contacts match &quot;{search.trim()}&quot;
          </div>
        )}
      </div>
    </div>
  );
}
