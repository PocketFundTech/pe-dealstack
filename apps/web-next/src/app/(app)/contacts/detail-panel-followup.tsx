"use client";

import { cn } from "@/lib/cn";
import {
  ContactEnrichment, FollowUpSuggestion,
  isFollowUpOverdue, toDateInputValue,
} from "./detail-panel-types";

// ─── Follow-up section ─────────────────────────────────────
// Presentational: all state lives with the DetailPanel owner; this component
// renders the follow-up date picker, the AI "Suggest follow-up" affordance, the
// retry banner (on timeout/failure) and the suggested follow-up card. The pulse
// highlight + success toast are driven by props passed in from the owner.

export function FollowUpSection({
  followUpAt,
  savingFollowUp,
  suggestingFollowUp,
  followUpSuggestion,
  followUpSuggestFailed,
  pulseSuggestion,
  onSuggest,
  onUpdateFollowUp,
  onApplySuggestion,
  onDismissSuggestion,
}: {
  followUpAt?: string | null;
  savingFollowUp: boolean;
  suggestingFollowUp: boolean;
  followUpSuggestion: FollowUpSuggestion | null;
  followUpSuggestFailed: boolean;
  pulseSuggestion: boolean;
  onSuggest: () => void;
  onUpdateFollowUp: (value: string | null) => void;
  onApplySuggestion: (suggestion: FollowUpSuggestion) => void;
  onDismissSuggestion: () => void;
}) {
  const overdue = isFollowUpOverdue(followUpAt);
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-xs font-bold uppercase tracking-wider text-text-muted">Follow-up</h4>
        <button
          onClick={onSuggest}
          disabled={suggestingFollowUp}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-primary hover:bg-primary-light transition-colors disabled:opacity-50"
          title="Use AI to suggest a follow-up date based on recent interactions"
        >
          <span className={cn("material-symbols-outlined text-[14px]", suggestingFollowUp && "animate-spin")}>{suggestingFollowUp ? "sync" : "auto_awesome"}</span>
          {suggestingFollowUp ? "Thinking..." : "Suggest follow-up"}
        </button>
      </div>
      <div className={cn("flex items-center gap-2 p-2.5 rounded-lg border", overdue ? "border-red-200 bg-red-50/60" : "border-border-subtle bg-gray-50")}>
        <span className={cn("material-symbols-outlined text-[18px]", overdue ? "text-red-500" : "text-text-muted")}>{overdue ? "event_busy" : "event"}</span>
        <input
          type="date"
          value={toDateInputValue(followUpAt)}
          disabled={savingFollowUp}
          onChange={(e) => onUpdateFollowUp(e.target.value || null)}
          className={cn("flex-1 rounded-md border bg-white px-2.5 py-1.5 text-sm focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors disabled:opacity-50", overdue ? "border-red-300 text-red-700" : "border-border-subtle text-text-main")}
        />
        {followUpAt && (
          <button onClick={() => onUpdateFollowUp(null)} disabled={savingFollowUp} className="p-1.5 rounded hover:bg-white text-text-muted hover:text-red-500 transition-colors disabled:opacity-50" title="Clear follow-up">
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        )}
      </div>
      {overdue && <p className="text-[11px] text-red-600 font-medium mt-1.5 flex items-center gap-1"><span className="material-symbols-outlined text-[13px]">warning</span>Follow-up is overdue</p>}

      {/* Retry affordance when the suggestion fetch failed/timed out */}
      {followUpSuggestFailed && !suggestingFollowUp && !followUpSuggestion && (
        <div className="mt-2.5 flex items-center justify-between gap-2 p-2.5 rounded-lg border border-amber-200 bg-amber-50/60">
          <p className="text-xs text-amber-700 flex items-center gap-1">
            <span className="material-symbols-outlined text-[14px]">error_outline</span>
            Couldn&apos;t get a suggestion.
          </p>
          <button
            onClick={onSuggest}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-primary hover:bg-primary-light transition-colors"
          >
            <span className="material-symbols-outlined text-[14px]">refresh</span>Retry
          </button>
        </div>
      )}

      {/* AI follow-up suggestion (cheap single LLM call) */}
      {followUpSuggestion && (
        <div className={cn(
          "mt-2.5 p-3 rounded-lg border border-primary/20 bg-blue-50/30 transition-all duration-500",
          pulseSuggestion && "ring-2 ring-primary/50 ring-offset-1 animate-pulse",
        )}>
          <div className="flex items-start gap-2.5">
            <span className="material-symbols-outlined text-[18px] text-primary shrink-0 mt-0.5">event_upcoming</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-bold uppercase tracking-wider text-primary">Suggested Follow-up</p>
                <button onClick={onDismissSuggestion} className="p-0.5 rounded hover:bg-white text-text-muted hover:text-text-main transition-colors" title="Dismiss">
                  <span className="material-symbols-outlined text-[14px]">close</span>
                </button>
              </div>
              <p className="text-sm text-text-secondary leading-relaxed mt-0.5">{followUpSuggestion.action}</p>
              {followUpSuggestion.reasoning && <p className="text-xs text-text-muted mt-1 italic">{followUpSuggestion.reasoning}</p>}
              <div className="flex items-center justify-between gap-2 mt-2">
                <p className="text-xs text-text-muted">{toDateInputValue(followUpSuggestion.date) || followUpSuggestion.date}</p>
                <button
                  onClick={() => onApplySuggestion(followUpSuggestion)}
                  disabled={savingFollowUp}
                  className="shrink-0 px-3 py-1.5 rounded-md text-white text-xs font-medium hover:opacity-90 transition-colors disabled:opacity-50"
                  style={{ backgroundColor: "#003366" }}
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── AI Suggestions (enrichment) box ───────────────────────
// Renders the result of POST /ai/enrich-contact: summary, insights, suggested
// tags and a suggested follow-up the user can apply.

export function EnrichmentBox({
  enrichment,
  savingFollowUp,
  onDismiss,
  onApplyFollowUpDate,
}: {
  enrichment: ContactEnrichment;
  savingFollowUp: boolean;
  onDismiss: () => void;
  onApplyFollowUpDate: (date: string) => void;
}) {
  return (
    <div className="mb-6 p-4 rounded-lg border border-primary/20 bg-blue-50/30">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-xs font-bold uppercase tracking-wider text-primary flex items-center gap-1.5"><span className="material-symbols-outlined text-[16px]">auto_awesome</span>AI Suggestions</h4>
        <button onClick={onDismiss} className="p-1 rounded hover:bg-white text-text-muted hover:text-text-main transition-colors"><span className="material-symbols-outlined text-[16px]">close</span></button>
      </div>
      {enrichment.summary && <p className="text-sm text-text-secondary leading-relaxed mb-3">{enrichment.summary}</p>}
      {enrichment.insights && enrichment.insights.length > 0 && (
        <ul className="flex flex-col gap-1.5 mb-3">
          {enrichment.insights.map((ins, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-text-secondary">
              <span className="material-symbols-outlined text-[16px] text-primary shrink-0 mt-0.5">lightbulb</span>
              <span>{ins}</span>
            </li>
          ))}
        </ul>
      )}
      {enrichment.suggestedTags && enrichment.suggestedTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {enrichment.suggestedTags.map((t, i) => <span key={i} className="px-2.5 py-1 rounded-full bg-white text-text-secondary text-xs font-medium border border-border-subtle">{t}</span>)}
        </div>
      )}
      {enrichment.suggestedFollowUp && (enrichment.suggestedFollowUp.date || enrichment.suggestedFollowUp.action) && (
        <div className="flex items-start gap-2.5 p-3 rounded-lg bg-white border border-primary/15">
          <span className="material-symbols-outlined text-[18px] text-primary shrink-0 mt-0.5">event_upcoming</span>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold uppercase tracking-wider text-text-muted mb-0.5">Suggested Follow-up</p>
            {enrichment.suggestedFollowUp.action && <p className="text-sm text-text-secondary leading-relaxed">{enrichment.suggestedFollowUp.action}</p>}
            {enrichment.suggestedFollowUp.date && <p className="text-xs text-text-muted mt-0.5">{toDateInputValue(enrichment.suggestedFollowUp.date) || enrichment.suggestedFollowUp.date}</p>}
          </div>
          {enrichment.suggestedFollowUp.date && (
            <button
              onClick={() => onApplyFollowUpDate(enrichment.suggestedFollowUp!.date!)}
              disabled={savingFollowUp}
              className="shrink-0 px-3 py-1.5 rounded-md text-white text-xs font-medium hover:opacity-90 transition-colors disabled:opacity-50"
              style={{ backgroundColor: "#003366" }}
            >
              Apply
            </button>
          )}
        </div>
      )}
    </div>
  );
}
