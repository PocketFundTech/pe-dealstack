"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { getInitials, formatRelativeTime } from "@/lib/formatters";
import { CHANNEL_CONFIG, REPLY_INTENT_CONFIG, type OutreachContact, type OutreachStage } from "./types";

// ---------------------------------------------------------------------------
// Outreach Kanban Card — click opens the detail/edit modal; the overflow
// menu offers a reliable "Move to..." action instead of drag-and-drop, plus
// a one-click "Enrich" quick action so it doesn't require opening the modal.
// ---------------------------------------------------------------------------
export function OutreachCard({
  contact,
  otherStages,
  onOpen,
  onMove,
  onEnrich,
  enriching,
}: {
  contact: OutreachContact;
  /** Every stage except this card's current one, ordered by position. */
  otherStages: OutreachStage[];
  onOpen: (contact: OutreachContact) => void;
  onMove: (contactId: string, stageId: string) => void;
  onEnrich: (contactId: string) => void;
  /** True while this contact's enrichment call is in flight. */
  enriching: boolean;
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
      className="group relative bg-surface-card rounded-lg border border-border-subtle p-3 shadow-sm hover:shadow-md hover:border-primary/30 transition-all cursor-pointer"
      onClick={() => onOpen(contact)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(contact); }}
    >
      <div className="flex items-start gap-2 mb-2">
        <div className="size-8 rounded-md bg-primary-light border border-primary/10 flex items-center justify-center text-[#003366] shrink-0 text-[11px] font-bold">
          {getInitials(contact.name)}
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-text-main truncate" title={contact.name}>
            {contact.name}
          </h4>
          <p className="text-[11px] text-text-muted truncate">{contact.company || "—"}</p>
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

      <div className="flex items-center gap-1.5 flex-wrap">
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
        {contact.enrichedAt && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[10px] font-medium border border-emerald-200"
            title={`Enriched ${formatRelativeTime(contact.enrichedAt)}`}
          >
            <span className="material-symbols-outlined text-[12px]">auto_awesome</span>
            Enriched
          </span>
        )}
      </div>
    </div>
  );
}
