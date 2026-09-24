"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { OutreachRow } from "./OutreachRow";
import type { OutreachContact, OutreachStage } from "./types";

// ---------------------------------------------------------------------------
// The active stage's full contact list, promoted directly onto the Outreach
// page (OutreachBoard.tsx renders exactly one of these, for whichever stage
// StageTabStrip has selected) — no longer hosted inside a modal, so this
// owns its own bordered panel chrome instead of borrowing a modal's. Header
// (name + count + optional "Enrich all" + search + add) and OutreachRow
// list; real stages can hold 700+ contacts, so the search box is what makes
// finding one tractable.
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
  onSendContact,
  staleIds,
  onEnrichAll,
  enrichingAll,
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
  /** Caller resolves what "select all" means for this list (a real stage's
   *  contacts vs. the synthetic Stale view's) — see OutreachBoard.tsx. */
  onToggleSelectAll: () => void;
  /** Opens SendConfirmModal for one contact — see OutreachRow.tsx. */
  onSendContact: (contactId: string) => void;
  /** Contact ids in the cross-cutting Stale view's result set right now —
   *  only affects OutreachRow's "Updated" timestamp styling, not which
   *  contacts render (that's entirely this component's `contacts` prop). */
  staleIds: Set<string>;
  /** Only passed for the lowest-position ("Source") stage — a one-click
   *  "enrich everything currently in this stage" quick action. Previously
   *  lived on that stage's StageSummaryCard tile. */
  onEnrichAll?: () => void;
  enrichingAll?: boolean;
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
    <div
      className="bg-surface-card border border-border-subtle rounded-lg shadow-sm overflow-hidden"
      data-stage-id={stage.id}
    >
      <div className="px-4 py-3 border-b border-border-subtle bg-background-body flex items-center gap-3 flex-wrap">
        <input
          type="checkbox"
          checked={allSelectedInStage}
          onChange={onToggleSelectAll}
          disabled={contacts.length === 0}
          className="size-3.5 shrink-0 rounded border-border-subtle accent-[#003366] cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`Select all contacts in ${stage.name}`}
          title={`Select all in ${stage.name}`}
        />
        <span className="text-sm font-bold text-text-main" title={stage.name}>
          {stage.name}
        </span>
        <span className="text-xs font-bold bg-white/70 border border-border-subtle px-2 py-0.5 rounded-full text-text-muted">
          {isSearching ? `${filteredContacts.length} of ${contacts.length}` : contacts.length}
        </span>
        {onEnrichAll && (
          <button
            type="button"
            onClick={onEnrichAll}
            disabled={enrichingAll || contacts.length === 0}
            title={`Enrich all ${contacts.length} contact${contacts.length !== 1 ? "s" : ""} in ${stage.name}`}
            className="flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-md border border-border-subtle bg-white text-[11px] font-medium text-text-secondary hover:bg-primary-light hover:text-[#003366] hover:border-primary/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className={cn("material-symbols-outlined text-[13px]", enrichingAll && "animate-spin")}>
              {enrichingAll ? "progress_activity" : "auto_awesome"}
            </span>
            {enrichingAll ? "Enriching" : `Enrich all ${contacts.length}`}
          </button>
        )}
        <div className="relative ml-auto w-64 shrink-0">
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
        <button
          type="button"
          onClick={() => onAddContact(stage.id)}
          className="flex items-center justify-center size-8 shrink-0 rounded-md text-text-muted hover:bg-white hover:text-primary transition-colors"
          title={`Add contact to ${stage.name}`}
          aria-label={`Add contact to ${stage.name}`}
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
        </button>
      </div>

      <div className="divide-y divide-border-subtle">
        {filteredContacts.map((contact) => (
          <OutreachRow
            key={contact.id}
            contact={contact}
            otherStages={otherStages}
            currentStageName={stage.name}
            onOpen={onOpenContact}
            onMove={onMoveContact}
            onEnrich={onEnrichContact}
            enriching={enrichingContactId === contact.id}
            selected={selectedIds.has(contact.id)}
            onToggleSelect={onToggleSelect}
            onSend={onSendContact}
            stale={staleIds.has(contact.id)}
          />
        ))}
        {contacts.length === 0 && (
          <div className="text-center py-12 text-text-muted text-sm">
            <span className="material-symbols-outlined text-2xl mb-2 block opacity-40">inbox</span>
            No contacts yet
          </div>
        )}
        {contacts.length > 0 && isSearching && filteredContacts.length === 0 && (
          <div className="text-center py-12 text-text-muted text-sm">
            <span className="material-symbols-outlined text-2xl mb-2 block opacity-40">search_off</span>
            No contacts match &quot;{search.trim()}&quot;
          </div>
        )}
      </div>
    </div>
  );
}
