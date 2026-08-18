"use client";

// "Review an incoming NDA": pick the deal it belongs to, drop the
// counterparty's file, get a clause-by-clause report.
//
// Deliberately two steps and no more. The user is holding a broker's PDF
// and wants an answer — anything else in the way is friction on the
// feature whose entire pitch is "30 minutes becomes two".

import { useCallback, useRef, useState } from "react";
import { authFetchRaw } from "@/app/(app)/deal-intake/components";
import { DealPicker, type PickableDeal } from "./DealPicker";
import { NdaReviewReport, type NdaReviewPayload } from "./NdaReviewReport";

type Phase =
  | { step: "pickDeal" }
  | { step: "upload"; dealId: string; dealLabel: string }
  | { step: "reviewing"; dealId: string; dealLabel: string }
  | { step: "report"; review: NdaReviewPayload };

const ACCEPTED = ".pdf,.docx,.html,.htm,.md";

export function NdaReviewFlow({ onExit }: { onExit: () => void }) {
  const [phase, setPhase] = useState<Phase>({ step: "pickDeal" });
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const runReview = useCallback(
    async (dealId: string, dealLabel: string, file: File) => {
      setPhase({ step: "reviewing", dealId, dealLabel });
      setError(null);
      try {
        const form = new FormData();
        form.append("file", file);
        // Multipart: authFetchRaw is the repo's helper for this — it adds the
        // bearer token but lets the browser set the multipart boundary.
        // Never set Content-Type by hand here.
        const res = await authFetchRaw(`/deals/${dealId}/nda-reviews`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "That review didn't go through.");
        }
        const review = (await res.json()) as NdaReviewPayload;
        setPhase({ step: "report", review: { ...review, sourceFileName: file.name } });
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "That review didn't go through. Please try again.",
        );
        setPhase({ step: "upload", dealId, dealLabel });
      }
    },
    [],
  );

  if (phase.step === "report") {
    return <NdaReviewReport review={phase.review} onBack={onExit} />;
  }

  if (phase.step === "pickDeal") {
    return (
      <DealPicker
        open
        onCancel={onExit}
        onSelect={(deal: PickableDeal) =>
          setPhase({ step: "upload", dealId: deal.id, dealLabel: deal.label })
        }
      />
    );
  }

  const busy = phase.step === "reviewing";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-[520px] rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Review an incoming NDA</h3>
            <p className="mt-0.5 text-xs text-slate-500">{phase.dealLabel}</p>
          </div>
          <button
            onClick={onExit}
            disabled={busy}
            className="text-slate-400 transition-colors hover:text-slate-900 disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="px-6 py-6">
          {busy ? (
            <div className="flex flex-col items-center py-8 text-center">
              <span className="material-symbols-outlined animate-spin text-3xl text-slate-400">
                progress_activity
              </span>
              <p className="mt-3 text-sm font-medium text-slate-700">
                Reading the NDA against your playbook…
              </p>
              <p className="mt-1 text-xs text-slate-500">Usually about 30 seconds.</p>
            </div>
          ) : (
            <>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPTED}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void runReview(phase.dealId, phase.dealLabel, file);
                  e.target.value = "";
                }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                className="flex w-full flex-col items-center rounded-lg border-2 border-dashed border-slate-300 px-6 py-10 transition-colors hover:border-[#003366] hover:bg-slate-50"
              >
                <span className="material-symbols-outlined text-3xl text-slate-400">upload_file</span>
                <span className="mt-2 text-sm font-medium text-slate-700">
                  Choose the counterparty&rsquo;s NDA
                </span>
                <span className="mt-1 text-xs text-slate-500">PDF, Word, HTML or Markdown</span>
              </button>

              {error && (
                <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </p>
              )}

              <p className="mt-4 text-xs text-slate-500">
                We compare each clause against your firm&rsquo;s playbook and quote only language we
                can find verbatim in your file.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
