"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { getInitials, formatRelativeTime } from "@/lib/formatters";
import {
  CHANNEL_CONFIG,
  REPLY_INTENT_CONFIG,
  SOURCE_PROVIDER_CONFIG,
  type OutreachContact,
  type OutreachStage,
} from "./types";

// ---------------------------------------------------------------------------
// Outreach Kanban Card — click opens the detail/edit modal. Three ways to
// move a contact to another stage, each suited to a different scale:
//   - Drag-and-drop (this card, same pattern as the Deals kanban) — one
//     contact, the familiar Kanban gesture.
//   - The overflow menu's "Move to..." — one contact, no drag required
//     (keyboard/trackpad-friendly fallback).
//   - Bulk select + BulkActionsBar (OutreachBoard.tsx) — tens/hundreds of
//     contacts at once, e.g. an entire fresh CSV import sitting in Source.
// Also has a one-click "Enrich" quick action so it doesn't require opening
// the modal.
// ---------------------------------------------------------------------------
export function OutreachCard({
  contact,
  otherStages,
  onOpen,
  onMove,
  onEnrich,
  enriching,
  selected,
  onToggleSelect,
}: {
  contact: OutreachContact;
  /** Every stage except this card's current one, ordered by position. */
  otherStages: OutreachStage[];
  onOpen: (contact: OutreachContact) => void;
  onMove: (contactId: string, stageId: string) => void;
  onEnrich: (contactId: string) => void;
  /** True while this contact's enrichment call is in flight. */
  enriching: boolean;
  /** For bulk "Move to stage" — see useOutreachSelection.ts. */
  selected: boolean;
  onToggleSelect: (contactId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  const channel = CHANNEL_CONFIG[contact.channel];

  return (
    <div
      className={cn(
        // border-t-4 + the channel-keyed border-t-{color} below give each card a
        // colored top accent (blue = proprietary, amber = broker) so a column full
        // of cards reads as distinct cards at a glance, not a plain list. Order
        // matters for tailwind-merge: the channel accent must come after the
        // selected/unselected border-color so it isn't stripped as a duplicate
        // (verified — border-t-{color} utilities compile after border-{color} ones,
        // so this also renders correctly independent of merge order).
        "group relative bg-surface-card rounded-lg border border-t-4 p-3.5 shadow-sm hover:shadow-md hover:border-primary/30 transition-all cursor-grab active:cursor-grabbing",
        selected ? "border-primary ring-1 ring-primary/40 bg-primary-light/40" : "border-border-subtle",
        contact.channel === "proprietary" ? "border-t-blue-400" : "border-t-amber-400",
      )}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", contact.id);
        e.currentTarget.style.opacity = "0.5";
      }}
      onDragEnd={(e) => {
        e.currentTarget.style.opacity = "1";
      }}
      onClick={() => onOpen(contact)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(contact); }}
    >
      <div className="flex items-start gap-2 mb-2.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(contact.id)}
          onClick={(e) => e.stopPropagation()}
          className="mt-1.5 size-3.5 shrink-0 rounded border-border-subtle accent-[#003366] cursor-pointer"
          aria-label={`Select ${contact.name}`}
        />
        <div className="size-8 rounded-md bg-primary-light border border-primary/10 flex items-center justify-center text-[#003366] shrink-0 text-[11px] font-bold">
          {getInitials(contact.name)}
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-text-main truncate" title={contact.name}>
            {contact.name}
          </h4>
          <p className="text-[11px] text-text-muted truncate" title={contact.company || undefined}>
            {contact.company || "—"}
          </p>
        </div>
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="flex items-center justify-center size-6 rounded-md text-text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-gray-100 hover:text-text-secondary transition-all"
            title="Move to another stage"
            aria-label="Move to another stage"
          >
            <span className="material-symbols-outlined text-[16px]">more_vert</span>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-surface-card rounded-lg shadow-lg border border-border-subtle py-1 z-50">
              <button
                type="button"
                disabled={enriching}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onEnrich(contact.id);
                }}
                className="w-full flex items-center gap-2 text-left px-3 py-2 text-sm text-text-secondary hover:bg-primary-light hover:text-[#003366] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined text-[16px]">
                  {enriching ? "progress_activity" : "auto_awesome"}
                </span>
                {enriching ? "Enriching..." : "Enrich"}
              </button>
              <div className="my-1 border-t border-border-subtle" />
              <div className="px-3 py-1.5 text-[10px] font-bold text-text-muted uppercase tracking-wider">
                Move to
              </div>
              {otherStages.length === 0 ? (
                <p className="px-3 py-2 text-xs text-text-muted">No other stages</p>
              ) : (
                otherStages.map((stage) => (
                  <button
                    key={stage.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                      onMove(contact.id, stage.id);
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-primary-light hover:text-[#003366] transition-colors truncate"
                  >
                    {stage.name}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={cn(
            "px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wider",
            channel.bg,
            channel.border,
            channel.text,
          )}
        >
          {channel.label}
        </span>
        {contact.needsMatchReview && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 text-[10px] font-bold border border-violet-300"
            title={contact.matchReviewReason || "Possible duplicate — flagged during Private Circle import"}
          >
            <span className="material-symbols-outlined text-[12px]">content_copy</span>
            Possible duplicate
          </span>
        )}
        {contact.needsReview && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-bold border border-amber-300"
            title="Needs review — reply intent unclear"
          >
            <span className="material-symbols-outlined text-[12px]">warning</span>
            Needs review
          </span>
        )}
        {contact.replyIntent && !contact.needsReview && (
          <span
            className={cn(
              "px-2 py-0.5 rounded-full border text-[10px] font-medium",
              REPLY_INTENT_CONFIG[contact.replyIntent].bg,
              REPLY_INTENT_CONFIG[contact.replyIntent].border,
              REPLY_INTENT_CONFIG[contact.replyIntent].text,
            )}
            title={`Latest reply: ${REPLY_INTENT_CONFIG[contact.replyIntent].label}`}
          >
            {REPLY_INTENT_CONFIG[contact.replyIntent].label}
          </span>
        )}
        {contact.assignedTo && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-background-body text-text-muted text-[10px] font-medium border border-border-subtle">
            <span className="material-symbols-outlined text-[12px]">person</span>
            {contact.assignedTo}
          </span>
        )}
        {/* enrichmentSource only ever holds providers that returned 'ok' or
            'submitted' (see enrichContact() in outreachEnrichment.ts) — enrichedAt
            alone just means a provider ran, not that it found anything. Require
            both so this badge means "we actually got new data", not "we tried". */}
        {contact.enrichedAt && contact.enrichmentSource && contact.enrichmentSource.length > 0 && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[10px] font-medium border border-emerald-200"
            title={`Enriched ${formatRelativeTime(contact.enrichedAt)}`}
          >
            <span className="material-symbols-outlined text-[12px]">auto_awesome</span>
            Enriched
          </span>
        )}
      </div>

      {contact.sourceProvider && SOURCE_PROVIDER_CONFIG[contact.sourceProvider] && (
        <p className="mt-2 flex items-center gap-1 text-[10px] text-text-muted">
          <span className="material-symbols-outlined text-[11px]">
            {SOURCE_PROVIDER_CONFIG[contact.sourceProvider]!.icon}
          </span>
          {SOURCE_PROVIDER_CONFIG[contact.sourceProvider]!.label}
        </p>
      )}

      {/* Indeterminate progress bar — visible feedback for the per-card "Enrich"
          quick action beyond the small spinning icon inside the overflow menu.
          Reuses the shared .import-progress-track/-fill pair from globals.css. */}
      {enriching && (
        <div className="import-progress-track mt-2">
          <div className="import-progress-fill" />
        </div>
      )}
    </div>
  );
}
