"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatCurrency, formatRelativeTime } from "@/lib/formatters";
import { useToast } from "@/providers/ToastProvider";

// ---------------------------------------------------------------------------
// Inbox Deal Finder review modal. Mirrors the TasksModal chrome
// (dashboard-modals.tsx): fixed overlay, click-outside-to-close, Esc to close.
// Each candidate is reviewed individually — a Deal is created ONLY when the
// user clicks "Create deal" on that candidate.
// ---------------------------------------------------------------------------

// Returned by POST /ai/scan-inbox. revenue/ebitda/dealSize are ALREADY IN
// MILLIONS (same unit as Deal.dealSize), so they render straight through
// formatCurrency with no conversion.
export interface InboxDealCandidate {
  emailId: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  companyName: string;
  industry: string | null;
  description: string;
  summary: string;
  currency: string;
  revenue: number | null;
  ebitda: number | null;
  dealSize: number | null;
  overallConfidence: number;
  reviewReasons: string[];
  // Explainable pickup breakdown from the backend signal scorer — why this
  // email was picked up and at what priority.
  signalScore: number;
  priority: "high" | "medium" | "low";
  signals: string[];
}

// Priority chip styling — High/Medium/Low tiers from the signal scorer.
const PRIORITY_STYLES: Record<
  InboxDealCandidate["priority"],
  { label: string; className: string }
> = {
  high: { label: "High priority", className: "bg-green-50 text-green-700 border border-green-200" },
  medium: { label: "Medium priority", className: "bg-amber-50 text-amber-700 border border-amber-200" },
  low: { label: "Low priority", className: "bg-gray-100 text-text-muted border border-border-subtle" },
};

interface InboxDealsModalProps {
  candidates: InboxDealCandidate[];
  onClose: () => void;
  // Create/Dismiss lifts the removal to the parent (which owns + persists the
  // candidate list) instead of mutating a divergent local copy that would drop
  // reviewed cards on the next render.
  onRemove: (emailId: string) => void;
  // Count of PDF attachments on scanned emails that couldn't be read (scanned /
  // image-only decks, parse failures, oversized, or skipped once the scan's PDF
  // time/byte budget ran out). Optional so existing call sites that only pass
  // `candidates` still type-check; surfaced as a note when > 0 so a silently
  // empty deck doesn't just vanish.
  attachmentsUnread?: number;
}

// Format a candidate.date defensively — Gmail dates should be ISO, but guard
// against an unparseable value so the card never renders "Invalid Date".
function safeRelativeTime(date: string): string | null {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatRelativeTime(parsed.toISOString());
}

// Render a money chip only when the value is non-null. The value is already in
// millions, matching Deal.dealSize, so it's passed straight to formatCurrency.
function MoneyChip({
  label,
  value,
  currency,
}: {
  label: string;
  value: number | null;
  currency: string;
}) {
  if (value === null) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-[11px] font-medium text-text-secondary">
      <span className="text-text-muted">{label}</span>
      <span className="font-semibold text-text-main">{formatCurrency(value, currency)}</span>
    </span>
  );
}

function CandidateCard({
  candidate,
  onCreated,
  onDismiss,
}: {
  candidate: InboxDealCandidate;
  onCreated: () => void;
  onDismiss: () => void;
}) {
  const { showToast } = useToast();
  const [name, setName] = useState(candidate.companyName);
  const [creating, setCreating] = useState(false);

  const relative = safeRelativeTime(candidate.date);
  // overallConfidence is already a 0–100 percentage (see aiExtractor: needsReview
  // triggers when it drops below 70), so round it — do NOT multiply by 100.
  const confidencePct = Math.round(candidate.overallConfidence);
  const priority = PRIORITY_STYLES[candidate.priority] ?? PRIORITY_STYLES.low;

  const handleCreate = async () => {
    setCreating(true);
    try {
      await api.post("/deals", {
        name: name.trim() || candidate.companyName,
        companyName: candidate.companyName,
        ...(candidate.industry !== null ? { industry: candidate.industry } : {}),
        ...(candidate.revenue !== null ? { revenue: candidate.revenue } : {}),
        ...(candidate.ebitda !== null ? { ebitda: candidate.ebitda } : {}),
        ...(candidate.dealSize !== null ? { dealSize: candidate.dealSize } : {}),
        currency: candidate.currency,
        description: candidate.description,
        source: "Gmail: " + candidate.subject,
      });
      showToast("Deal created", "success");
      onCreated();
    } catch (err) {
      console.warn("[dashboard/inbox-deals] failed to create deal from candidate:", err);
      showToast(err instanceof Error ? err.message : "Couldn't create deal", "error");
      setCreating(false);
    }
  };

  return (
    <div className="rounded-lg border border-border-subtle p-4 transition-colors hover:border-primary/30">
      {/* Source email line */}
      <div className="mb-3 flex items-start gap-2">
        <span className="material-symbols-outlined mt-0.5 text-[16px] text-text-muted">mail</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-text-secondary" title={candidate.subject}>
            {candidate.subject}
          </p>
          <p className="truncate text-[11px] text-text-muted">
            {candidate.from}
            {relative && <span> &middot; {relative}</span>}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", priority.className)}>
            {priority.label}
          </span>
          <span className="rounded-full bg-primary-light px-2 py-0.5 text-[10px] font-bold text-primary">
            {confidencePct}% confidence
          </span>
        </div>
      </div>

      {/* Why this email was picked up — the signal breakdown from the scanner. */}
      {candidate.signals.length > 0 && (
        <div className="mb-3 rounded-lg bg-gray-50 px-3 py-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
            Why it was picked up
          </p>
          <div className="flex flex-wrap gap-1.5">
            {candidate.signals.map((signal, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-0.5 text-[11px] text-text-secondary ring-1 ring-border-subtle"
              >
                <span className="material-symbols-outlined text-[12px] text-primary">check_small</span>
                {signal}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Editable deal name */}
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        Deal name
      </label>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={candidate.companyName}
        className="mb-3 w-full rounded-lg border border-border-subtle px-3 py-2 text-sm text-text-main placeholder-text-muted transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
      />

      {/* Read-only company + industry */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="text-text-muted">
          Company: <span className="font-medium text-text-main">{candidate.companyName}</span>
        </span>
        <span className="text-text-muted">
          Industry:{" "}
          <span className="font-medium text-text-main">{candidate.industry ?? "—"}</span>
        </span>
      </div>

      {/* Money chips — only rendered when present */}
      {(candidate.revenue !== null ||
        candidate.ebitda !== null ||
        candidate.dealSize !== null) && (
        <div className="mb-3 flex flex-wrap gap-2">
          <MoneyChip label="Revenue" value={candidate.revenue} currency={candidate.currency} />
          <MoneyChip label="EBITDA" value={candidate.ebitda} currency={candidate.currency} />
          <MoneyChip label="Deal size" value={candidate.dealSize} currency={candidate.currency} />
        </div>
      )}

      {/* Review reasons */}
      {candidate.reviewReasons.length > 0 && (
        <ul className="mb-3 space-y-0.5">
          {candidate.reviewReasons.map((reason, i) => (
            <li key={i} className="flex items-start gap-1 text-[11px] text-text-muted">
              <span className="material-symbols-outlined mt-px text-[12px]">info</span>
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-all disabled:opacity-60"
          style={{ backgroundColor: "#003366" }}
        >
          <span
            className={cn("material-symbols-outlined text-[16px]", creating && "animate-spin")}
          >
            {creating ? "progress_activity" : "add_circle"}
          </span>
          {creating ? "Creating..." : "Create deal"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={creating}
          className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-gray-50 disabled:opacity-60"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function InboxDealsModal({
  candidates,
  onClose,
  onRemove,
  attachmentsUnread = 0,
}: InboxDealsModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-border-subtle p-6">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">forward_to_inbox</span>
            <h3 className="text-lg font-bold text-text-main">Inbox Deal Finder</h3>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-text-muted">
              {candidates.length}
            </span>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-main">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-6">
          {attachmentsUnread > 0 && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
              <span className="material-symbols-outlined mt-px text-[14px]">picture_as_pdf</span>
              <span>
                {attachmentsUnread} attached PDF{attachmentsUnread === 1 ? "" : "s"} couldn&apos;t be
                read — open the email to import manually.
              </span>
            </div>
          )}
          {candidates.length === 0 ? (
            <div className="py-8 text-center text-text-muted">
              <span className="material-symbols-outlined mb-2 block text-3xl opacity-60">
                done_all
              </span>
              <p className="text-sm font-medium">All candidates reviewed</p>
            </div>
          ) : (
            <div className="space-y-3">
              {candidates.map((candidate) => (
                <CandidateCard
                  key={candidate.emailId}
                  candidate={candidate}
                  onCreated={() => onRemove(candidate.emailId)}
                  onDismiss={() => onRemove(candidate.emailId)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
