"use client";

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
}: {
  stage: OutreachStage;
  contacts: OutreachContact[];
  allStages: OutreachStage[];
  onAddContact: (stageId: string) => void;
  onOpenContact: (contact: OutreachContact) => void;
  onMoveContact: (contactId: string, stageId: string) => void;
}) {
  const otherStages = allStages.filter((s) => s.id !== stage.id);

  return (
    <div className="min-w-[300px] w-[300px] shrink-0" data-stage-id={stage.id}>
      <div className="bg-surface-card rounded-xl border border-border-subtle overflow-hidden h-full flex flex-col">
        <div className="px-4 py-3 border-b border-border-subtle bg-background-body">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-text-secondary truncate" title={stage.name}>
              {stage.name}
            </span>
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
        <div className="flex-1 p-3 space-y-3 overflow-y-auto max-h-[calc(100vh-320px)] custom-scrollbar">
          {contacts.map((contact) => (
            <OutreachCard
              key={contact.id}
              contact={contact}
              otherStages={otherStages}
              onOpen={onOpenContact}
              onMove={onMoveContact}
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
