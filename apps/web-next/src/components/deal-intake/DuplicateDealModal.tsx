"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AskDuplicate, DuplicateCheck, DuplicateDecision } from "@/components/deal-intake/duplicateCheck";

// ---------------------------------------------------------------------------
// DuplicateDealModal — asked BEFORE anything is created when the document /
// text being added looks like a deal the org already has. Same chrome as
// DealTeaserPopup; portals above the intake modal (z-[10000]).
// ---------------------------------------------------------------------------

const BANKER_BLUE = "#003366";

interface DuplicateDealModalProps {
  check: DuplicateCheck;
  onDecide: (decision: DuplicateDecision) => void;
}

export function DuplicateDealModal({ check, onDecide }: DuplicateDealModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDecide({ action: "cancel" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDecide]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10001] flex items-start justify-center pt-[10vh] pb-[6vh] backdrop-blur-md"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onDecide({ action: "cancel" });
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="duplicate-deal-title"
        className="mx-4 flex max-h-[84vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface-card shadow-2xl"
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-border-subtle bg-background-body px-6 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100">
            <span className="material-symbols-outlined text-[20px] text-amber-700">content_copy</span>
          </div>
          <div className="min-w-0">
            <h3 id="duplicate-deal-title" className="text-base font-bold text-text-main">
              This looks like a deal you already have
            </h3>
            <p className="text-xs text-text-muted">
              {check.extractedCompanyName ? (
                <>The AI read the company as <span className="font-medium text-text-secondary">{check.extractedCompanyName}</span>. </>
              ) : null}
              Nothing has been created yet.
            </p>
          </div>
        </div>

        <ul className="flex flex-1 flex-col gap-3 overflow-y-auto p-6">
          {check.candidates.map((c) => (
            <li key={c.id} className="rounded-lg border border-border-subtle bg-white p-4 shadow-card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-main">{c.name}</p>
                  {c.companyName && c.companyName !== c.name && (
                    <p className="truncate text-xs text-text-muted">{c.companyName}</p>
                  )}
                </div>
                <span
                  className={
                    c.reason === "exact"
                      ? "shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700"
                      : "shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                  }
                >
                  {c.reason === "exact" ? "Same name" : "Similar name"}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => onDecide({ action: "add", dealId: c.id, dealName: c.name })}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                  style={{ backgroundColor: BANKER_BLUE }}
                >
                  <span className="material-symbols-outlined text-[16px]">add</span>
                  Add to {c.name}
                </button>
                <a
                  href={`/deals/${c.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  Open deal
                  <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                </a>
              </div>
            </li>
          ))}
        </ul>

        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border-subtle bg-background-body px-6 py-4">
          <button
            type="button"
            onClick={() => onDecide({ action: "cancel" })}
            className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onDecide({ action: "create" })}
            className="rounded-lg border border-border-subtle bg-white px-4 py-2 text-sm font-semibold text-text-main transition-colors hover:bg-gray-50"
          >
            Create a new deal anyway
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Promise-style prompt for the upload handlers: `askDuplicate(check)` opens
 * the modal and resolves with the user's choice. Render `modal` once.
 * Unmounting mid-question resolves as "cancel" so a handler never hangs.
 */
export function useDuplicatePrompt(): { askDuplicate: AskDuplicate; modal: React.ReactNode } {
  const [check, setCheck] = useState<DuplicateCheck | null>(null);
  const resolveRef = useRef<((d: DuplicateDecision) => void) | null>(null);

  useEffect(() => () => { resolveRef.current?.({ action: "cancel" }); }, []);

  const askDuplicate = useCallback<AskDuplicate>((next) => new Promise<DuplicateDecision>((resolve) => {
    resolveRef.current?.({ action: "cancel" });
    resolveRef.current = resolve;
    setCheck(next);
  }), []);

  const onDecide = useCallback((decision: DuplicateDecision) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setCheck(null);
    resolve?.(decision);
  }, []);

  return { askDuplicate, modal: check ? <DuplicateDealModal check={check} onDecide={onDecide} /> : null };
}
