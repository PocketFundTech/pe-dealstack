"use client";

// ---------------------------------------------------------------------------
// IngestDealModal — full-screen overlay wrapping IngestDealForm so the deal
// intake flow no longer hijacks the user's current page. Mirrors the legacy
// deal-intake-modal.js behaviour: backdrop blur, centered card,
// Escape to close, click-outside to close, body scroll lock.
//
// Visual styling matches the existing edit-deal-modal pattern in
// apps/(app)/deals/[id]/edit-deal-modal.tsx for consistency.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IngestDealForm } from "./IngestDealForm";
import type { DealOption } from "@/app/(app)/deal-intake/components";

interface IngestDealModalProps {
  open: boolean;
  onClose: () => void;
  /** When set, the modal opens directly in "Update Existing Deal" mode with
   *  this deal pre-selected. See IngestDealForm's preselectedDeal prop. */
  preselectedDeal?: DealOption | null;
}

export function IngestDealModal({ open, onClose, preselectedDeal = null }: IngestDealModalProps) {
  // True while the form has an upload/extraction request in flight. Closing
  // the modal mid-request used to abandon the result entirely — the files
  // looked un-uploaded on reopen, so the natural next step was to re-upload
  // them and create a duplicate deal/document.
  const [isProcessing, setIsProcessing] = useState(false);
  const requestClose = () => {
    if (!isProcessing) onClose();
  };

  // Escape to close + body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose, isProcessing]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-start justify-center pt-[6vh] pb-[6vh] backdrop-blur-md"
      data-modal-overlay
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="rounded-xl shadow-2xl w-full max-w-3xl mx-4 overflow-hidden bg-surface-card border border-border-subtle flex flex-col max-h-[88vh]">
        {/* Header */}
        <div className="px-6 py-4 flex items-center justify-between border-b border-border-subtle bg-background-body shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: "#003366" }}
            >
              <span className="material-symbols-outlined text-white text-[20px]">smart_toy</span>
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-bold text-text-main truncate">Ingest Deal Data</h3>
              <p className="text-xs text-text-muted truncate">
                {isProcessing
                  ? "Processing — please wait for this to finish before closing."
                  : "Upload a document or paste text to create or update a deal."}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={isProcessing}
            className="p-1.5 rounded-md text-text-muted hover:bg-background-body transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            title={isProcessing ? "Please wait for processing to finish" : "Close"}
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
          <IngestDealForm
            variant="modal"
            onClose={onClose}
            preselectedDeal={preselectedDeal}
            onProcessingChange={setIsProcessing}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
