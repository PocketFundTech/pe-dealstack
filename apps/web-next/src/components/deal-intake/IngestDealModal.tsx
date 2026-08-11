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

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { IngestDealForm } from "./IngestDealForm";

interface IngestDealModalProps {
  open: boolean;
  onClose: () => void;
}

export function IngestDealModal({ open, onClose }: IngestDealModalProps) {
  // Escape to close + body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-start justify-center pt-[6vh] pb-[6vh] backdrop-blur-md"
      data-modal-overlay
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
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
                Upload a document or paste text to create or update a deal.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-text-muted hover:bg-background-body transition-colors shrink-0"
            title="Close"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
          <IngestDealForm variant="modal" onClose={onClose} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
