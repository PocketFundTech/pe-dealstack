"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { formatRelativeTime } from "@/lib/formatters";
import type { DealTeaser } from "@/lib/teaser";
import { TeaserFitChip } from "@/app/(app)/deals/[id]/deal-teaser-fit-chip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/providers/ToastProvider";

// ---------------------------------------------------------------------------
// DealTeaserPopup — fires right after a new deal is created from the intake
// flow, showing how the target scores against the firm's investment-criteria
// profiles (the "firm teaser"). One card per profile: headline + a
// criterion-by-criterion fit/partial/miss breakdown, reusing TeaserFitChip.
//
// No regenerate here (the deal-page teaser tab owns that). It doubles as a
// first-look gate: from a poor-fit summary the analyst can Reject the deal,
// which soft-deletes it (recoverable from Trash). Portals to document.body at
// a higher z-index than the ingest modal (z-[10000]) so it layers on top.
// ---------------------------------------------------------------------------

const BANKER_BLUE = "#003366";

interface DealTeaserPopupProps {
  deal: { id: string; name: string };
  teasers: DealTeaser[];
  onClose: () => void;
  onViewDeal: () => void;
  // Called after the deal is rejected (soft-deleted) so the parent can clear
  // the now-stale "Deal Created" state.
  onRejected: () => void;
}

export function DealTeaserPopup({ deal, teasers, onClose, onViewDeal, onRejected }: DealTeaserPopupProps) {
  const { showToast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  // Esc closes the confirm first (if open), otherwise the popup. The intake
  // modal owns body scroll-lock while it's open, so we don't touch
  // document.body.style here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirmOpen) setConfirmOpen(false);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, confirmOpen]);

  const handleReject = async () => {
    setRejecting(true);
    try {
      await api.delete(`/deals/${deal.id}`);
      showToast("Deal rejected and removed", "success");
      onRejected();
    } catch (err) {
      console.warn("[deal-intake] reject deal failed:", err);
      showToast(err instanceof Error ? err.message : "Couldn't reject the deal", "error");
      setRejecting(false);
      setConfirmOpen(false);
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10001] flex items-start justify-center pt-[6vh] pb-[6vh] backdrop-blur-md"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mx-4 flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface-card shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border-subtle bg-background-body px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{ backgroundColor: BANKER_BLUE }}
            >
              <span className="material-symbols-outlined text-[20px] text-white">
                center_focus_strong
              </span>
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-base font-bold text-text-main">Firm criteria fit</h3>
              <p className="truncate text-xs text-text-muted">
                How <span className="font-medium text-text-secondary">{deal.name}</span> scores
                against your investment criteria.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5 text-text-muted transition-colors hover:bg-background-body"
            title="Close"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Body — one card per profile */}
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
          {teasers.map((teaser) => (
            <PopupTeaserCard key={teaser.id || teaser.profileId} teaser={teaser} />
          ))}
        </div>

        {/* Footer — Reject (left) gates a poor-fit deal; Close / View deal (right) */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-subtle bg-background-body px-6 py-4">
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={rejecting}
            className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-4 py-2 text-sm font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:opacity-60"
          >
            <span className={`material-symbols-outlined text-[18px] ${rejecting ? "animate-spin" : ""}`}>
              {rejecting ? "progress_activity" : "block"}
            </span>
            {rejecting ? "Rejecting..." : "Reject deal"}
          </button>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-gray-50"
            >
              Close
            </button>
            <button
              type="button"
              onClick={onViewDeal}
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: BANKER_BLUE }}
            >
              <span className="material-symbols-outlined text-[18px]">open_in_new</span>
              View deal
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        variant="danger"
        title="Reject this deal?"
        message={`This removes ${deal.name} from your pipeline. You can restore it from Trash within 30 days.`}
        confirmLabel="Reject & delete"
        cancelLabel="Keep deal"
        onConfirm={handleReject}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>,
    document.body,
  );
}

// One profile's teaser — read-only (no regenerate). Mirrors the TeaserCard on
// the deal page (DealTeasers.tsx) minus the regenerate control.
function PopupTeaserCard({ teaser }: { teaser: DealTeaser }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-white p-5 shadow-card">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-[18px] text-primary">
          center_focus_strong
        </span>
        <h4 className="truncate text-sm font-bold uppercase tracking-wider text-text-muted">
          {teaser.profileName || "Profile"}
        </h4>
      </div>

      {/* Headline — plain text, never dangerouslySet. */}
      <p className="mt-3 text-[15px] font-semibold leading-relaxed text-text-main">
        {teaser.headline}
      </p>

      {/* Fit breakdown */}
      {teaser.fits.length > 0 && (
        <div className="mt-3 divide-y divide-border-subtle border-t border-border-subtle">
          {teaser.fits.map((fit, i) => (
            <TeaserFitChip key={`${fit.criterion}-${i}`} fit={fit} />
          ))}
        </div>
      )}

      {/* Footer: model + generated time */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]">smart_toy</span>
          {teaser.model}
        </span>
        <span aria-hidden>·</span>
        <span>Generated {formatRelativeTime(teaser.generatedAt)}</span>
      </div>
    </div>
  );
}
