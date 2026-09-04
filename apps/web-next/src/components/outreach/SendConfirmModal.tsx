"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { ListCampaignsResult, OutreachContact } from "./types";

// ---------------------------------------------------------------------------
// Send is a REAL, outward-facing action: POST /contacts/:id/send enrolls
// the contact in a live Reply.io sequence, and Reply.io is genuinely
// configured on this deployment (confirmed via `vercel env ls` while this
// was built — not a guess). This modal is the only path to it, for both
// the single-contact and bulk cases, and is deliberately two steps:
//   1. Pick a campaign, see exactly how many contacts are eligible (have an
//      email — Reply.io requires one) vs. will be skipped.
//   2. A distinct confirm step naming the real count and campaign, gated on
//      typing SEND — not a single click, on purpose (explicitly requested
//      after "double verification for send" came up mid-build).
// Ineligible (no-email) contacts are filtered out here, before the caller's
// onConfirm ever fires — the backend would 400 them anyway, but showing the
// split up front is honest instead of a confusing partial-failure toast
// after the fact.
// ---------------------------------------------------------------------------

const CONFIRM_PHRASE = "SEND";

export function SendConfirmModal({
  contacts,
  sending,
  onConfirm,
  onClose,
}: {
  /** The contact(s) under consideration — one for a single-card Send, many for bulk. */
  contacts: OutreachContact[];
  /** True while a send is actually in flight (owned by the caller). */
  sending: boolean;
  onConfirm: (campaignId: string) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"pick" | "confirm">("pick");
  const [campaignsResult, setCampaignsResult] = useState<ListCampaignsResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .get<ListCampaignsResult>("/outreach/campaigns")
      .then((result) => {
        if (!cancelled) setCampaignsResult(result);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : "Failed to load Reply.io campaigns");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const eligible = contacts.filter((c) => c.email);
  const ineligible = contacts.length - eligible.length;
  const selectedCampaign = campaignsResult?.campaigns.find((c) => String(c.id) === selectedCampaignId);
  const canContinue = eligible.length > 0 && Boolean(selectedCampaignId);
  const canSend = confirmText.trim().toUpperCase() === CONFIRM_PHRASE;

  function handleConfirm() {
    if (!canSend || !selectedCampaignId || sending) return;
    onConfirm(selectedCampaignId);
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-md p-4"
      onClick={sending ? undefined : onClose}
    >
      <div
        className="bg-surface-card rounded-xl shadow-2xl w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h3 className="text-base font-bold text-text-main flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-[#003366]">send</span>
            Send via Reply.io
          </h3>
          {!sending && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-text-muted hover:text-text-main transition-colors"
              aria-label="Close"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          )}
        </div>

        <div className="p-5 flex flex-col gap-4">
          {loadError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">{loadError}</p>
          )}

          {!loadError && !campaignsResult && (
            <p className="text-sm text-text-muted">Loading Reply.io campaigns...</p>
          )}

          {campaignsResult && !campaignsResult.configured && (
            <p className="text-sm text-text-muted bg-background-body border border-border-subtle rounded-lg p-3">
              {campaignsResult.reason || "Reply.io is not configured yet."}
            </p>
          )}

          {campaignsResult?.configured && campaignsResult.error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
              {campaignsResult.error}
            </p>
          )}

          {campaignsResult?.configured && !campaignsResult.error && step === "pick" && (
            <>
              <p className="text-sm text-text-secondary">
                {eligible.length} of {contacts.length} contact{contacts.length !== 1 ? "s" : ""} have an email and
                can be sent.
                {ineligible > 0 &&
                  ` ${ineligible} will be skipped — Reply.io requires an email address.`}
              </p>

              <div>
                <label className="block text-sm font-medium text-text-main mb-1.5">Campaign</label>
                <select
                  value={selectedCampaignId}
                  onChange={(e) => setSelectedCampaignId(e.target.value)}
                  className="w-full rounded-lg border border-border-subtle bg-white px-3 py-2 text-sm text-text-main focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors"
                >
                  <option value="" disabled>
                    Select a campaign...
                  </option>
                  {campaignsResult.campaigns.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.name} ({c.status})
                    </option>
                  ))}
                </select>
                {campaignsResult.campaigns.length === 0 && (
                  <p className="mt-1.5 text-xs text-text-muted">No campaigns found in the connected Reply.io account.</p>
                )}
              </div>
            </>
          )}

          {step === "confirm" && selectedCampaign && (
            <>
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 flex flex-col gap-1.5">
                <p className="text-sm font-semibold text-amber-900 flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px]">warning</span>
                  This sends real email
                </p>
                <p className="text-sm text-amber-900">
                  You&apos;re about to enroll <strong>{eligible.length}</strong> contact
                  {eligible.length !== 1 ? "s" : ""} into <strong>&quot;{selectedCampaign.name}&quot;</strong> via
                  Reply.io. Reply.io will begin emailing them — this can&apos;t be undone from here.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-main mb-1.5">
                  Type <span className="font-mono font-bold">{CONFIRM_PHRASE}</span> to confirm
                </label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  className="w-full rounded-lg border border-border-subtle bg-white px-3 py-2 text-sm text-text-main focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors"
                  placeholder={CONFIRM_PHRASE}
                  autoFocus
                  disabled={sending}
                />
              </div>
            </>
          )}

          {sending && (
            <div className="import-progress-track">
              <div className="import-progress-fill" />
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border-subtle">
          {step === "pick" ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg border border-border-subtle text-text-secondary text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              {campaignsResult?.configured && !campaignsResult.error && (
                <button
                  type="button"
                  disabled={!canContinue}
                  onClick={() => setStep("confirm")}
                  className="px-4 py-2 rounded-lg text-white text-sm font-medium hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ backgroundColor: "#003366" }}
                >
                  Continue
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setStep("pick")}
                disabled={sending}
                className="px-4 py-2 rounded-lg border border-border-subtle text-text-secondary text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Back
              </button>
              <button
                type="button"
                disabled={!canSend || sending}
                onClick={handleConfirm}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-medium hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ backgroundColor: "#003366" }}
              >
                <span className={sending ? "material-symbols-outlined text-[16px] animate-spin" : "hidden"}>
                  progress_activity
                </span>
                {sending ? "Sending..." : `Send to ${eligible.length}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
