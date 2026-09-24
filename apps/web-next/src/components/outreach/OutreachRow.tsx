"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { getInitials, formatRelativeTime } from "@/lib/formatters";
import { StageSuggestionBanner } from "./StageSuggestionBanner";
import {
  CHANNEL_CONFIG,
  REPLY_INTENT_CONFIG,
  SOURCE_PROVIDER_CONFIG,
  suggestStageMove,
  type OutreachContact,
  type OutreachStage,
} from "./types";

// ---------------------------------------------------------------------------
// One contact, one dense row — replaces the Kanban-card-shaped OutreachCard
// now that the list lives inline on the page instead of one column at a
// time inside a modal. Move-to-stage is a native <select> instead of
// OutreachCard's kebab-menu submenu — faster for a single change, and
// can't hit the overflow-x-auto dropdown-clipping issue noted in this app's
// CLAUDE.md. No drag-and-drop: since the StageSummaryCard/modal split
// (2db4781), only one stage is ever visible at a time, so OutreachCard's
// draggable handlers had nothing left to drop onto — a dead affordance,
// not a design choice. Move already has two working paths here (this
// select, and bulk select + BulkActionsBar), so it's just not reintroduced.
// ---------------------------------------------------------------------------
export function OutreachRow({
  contact,
  otherStages,
  currentStageName,
  onOpen,
  onMove,
  onEnrich,
  enriching,
  selected,
  onToggleSelect,
  onSend,
  stale,
}: {
  contact: OutreachContact;
  /** Every stage except this row's current one, ordered by position. */
  otherStages: OutreachStage[];
  /** This row's current stage's name — needed only to check whether the
   *  "Claude suggests..." banner below applies (see suggestStageMove). */
  currentStageName: string;
  onOpen: (contact: OutreachContact) => void;
  onMove: (contactId: string, stageId: string) => void;
  onEnrich: (contactId: string) => void;
  /** True while this contact's enrichment call is in flight. */
  enriching: boolean;
  /** For bulk "Move to stage" — see useOutreachSelection.ts. */
  selected: boolean;
  onToggleSelect: (contactId: string) => void;
  /** Opens SendConfirmModal for just this contact — see that file for why
   *  Send never fires directly from here (a real, live Reply.io account is
   *  connected on this deployment). */
  onSend: (contactId: string) => void;
  /** True when this contact is in the cross-cutting Stale view's result set
   *  (see useOutreachStaleness.ts) — highlights the "Updated" timestamp. */
  stale?: boolean;
}) {
  // Ephemeral, client-only — resets on reload by design, no persistence.
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const suggestion = suggestStageMove(contact, currentStageName, otherStages);
  const channel = CHANNEL_CONFIG[contact.channel];
  const sourceLabel = contact.sourceProvider ? SOURCE_PROVIDER_CONFIG[contact.sourceProvider]?.label : undefined;
  const isEnriched = Boolean(
    contact.enrichedAt && contact.enrichmentSource && contact.enrichmentSource.length > 0,
  );

  return (
    <div className={cn("border-b border-border-subtle last:border-b-0", selected && "bg-primary-light/40")}>
      <div
        className="group flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-background-body/60 transition-colors"
        onClick={() => onOpen(contact)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpen(contact);
        }}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(contact.id)}
          onClick={(e) => e.stopPropagation()}
          className="size-3.5 shrink-0 rounded border-border-subtle accent-[#003366] cursor-pointer"
          aria-label={`Select ${contact.name}`}
        />
        <div className="size-8 rounded-md bg-primary-light border border-primary/10 flex items-center justify-center text-[#003366] shrink-0 text-[11px] font-bold">
          {getInitials(contact.name)}
        </div>
        <div className="min-w-0 w-44 shrink-0">
          <p className="text-sm font-semibold text-text-main truncate" title={contact.name}>
            {contact.name}
          </p>
          <p className="text-[11px] text-text-muted truncate">
            {contact.company || "—"}
            {contact.title ? ` · ${contact.title}` : ""}
            {sourceLabel ? ` · ${sourceLabel}` : ""}
          </p>
        </div>

        <div className="flex flex-1 min-w-0 items-center gap-1.5 flex-wrap">
          <span
            className={cn(
              "px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wider shrink-0",
              channel.bg,
              channel.border,
              channel.text,
            )}
          >
            {channel.label}
          </span>
          {contact.needsMatchReview && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 text-[10px] font-bold border border-violet-300 shrink-0"
              title={contact.matchReviewReason || "Possible duplicate — flagged during Private Circle import"}
            >
              <span className="material-symbols-outlined text-[12px]">content_copy</span>
              Duplicate
            </span>
          )}
          {contact.needsReview && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-bold border border-amber-300 shrink-0"
              title="Needs review — reply intent unclear"
            >
              <span className="material-symbols-outlined text-[12px]">warning</span>
              Needs review
            </span>
          )}
          {contact.replyIntent && !contact.needsReview && (
            <span
              className={cn(
                "px-2 py-0.5 rounded-full border text-[10px] font-medium shrink-0",
                REPLY_INTENT_CONFIG[contact.replyIntent].bg,
                REPLY_INTENT_CONFIG[contact.replyIntent].border,
                REPLY_INTENT_CONFIG[contact.replyIntent].text,
              )}
            >
              {REPLY_INTENT_CONFIG[contact.replyIntent].label}
            </span>
          )}
          {isEnriched && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[10px] font-medium border border-emerald-200 shrink-0"
              title={`Enriched ${formatRelativeTime(contact.enrichedAt)}`}
            >
              <span className="material-symbols-outlined text-[12px]">auto_awesome</span>
              Enriched
            </span>
          )}
          {contact.assignedTo && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-background-body text-text-muted text-[10px] font-medium border border-border-subtle shrink-0">
              <span className="material-symbols-outlined text-[12px]">person</span>
              {contact.assignedTo}
            </span>
          )}
        </div>

        <div
          className={cn(
            "hidden sm:flex items-center gap-1 shrink-0 w-20 justify-end text-[11px]",
            stale ? "text-amber-700 font-semibold" : "text-text-muted",
          )}
          title={stale ? "Hasn't been updated in a while" : undefined}
        >
          {stale && <span className="material-symbols-outlined text-[12px]">schedule</span>}
          {formatRelativeTime(contact.updatedAt)}
        </div>

        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) onMove(contact.id, e.target.value);
            }}
            aria-label={`Move ${contact.name} to another stage`}
            className="max-w-[130px] rounded-md border border-border-subtle bg-surface-card px-2 py-1 text-[11px] font-medium text-text-secondary hover:border-primary/30 transition-colors"
          >
            <option value="" disabled>
              Move to...
            </option>
            {otherStages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </div>

        <div
          className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            disabled={enriching}
            onClick={() => onEnrich(contact.id)}
            title="Enrich"
            className="flex items-center justify-center size-7 rounded-md text-text-muted hover:bg-primary-light hover:text-[#003366] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-[15px]">
              {enriching ? "progress_activity" : "auto_awesome"}
            </span>
          </button>
          <button
            type="button"
            onClick={() => onSend(contact.id)}
            title="Send"
            className="flex items-center justify-center size-7 rounded-md text-text-muted hover:bg-primary-light hover:text-[#003366] transition-colors"
          >
            <span className="material-symbols-outlined text-[15px]">send</span>
          </button>
        </div>
      </div>

      {/* Low-key, non-binding suggestion — same rule/copy as before, just
          hosted under the row instead of under a card's badge row. */}
      {suggestion && !suggestionDismissed && (
        <div className="px-4 pb-2.5">
          <StageSuggestionBanner
            suggestion={suggestion}
            variant="compact"
            onAccept={() => onMove(contact.id, suggestion.stageId)}
            onDismiss={() => setSuggestionDismissed(true)}
          />
        </div>
      )}

      {enriching && (
        <div className="px-4 pb-2.5">
          <div className="import-progress-track">
            <div className="import-progress-fill" />
          </div>
        </div>
      )}
    </div>
  );
}
