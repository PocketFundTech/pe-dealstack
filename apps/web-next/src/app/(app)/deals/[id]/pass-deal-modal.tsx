"use client";

// Second step of closing a deal as PASSED: capture WHY, and when to look
// again. Both are optional — a partner in a hurry can skip straight
// through — but the defaults are chosen so most passes end up carrying
// context.
//
// Why this exists: a passed deal without a reason is a dead card. With one,
// it's a dormant target that the reactivation engine can wake up when the
// business grows into the firm's range or the thesis moves. See
// services/agents/dealReactivation on the API side.

import { useState } from "react";

const REASONS = [
  "Too small",
  "Too expensive",
  "Wrong sector",
  "Customer concentration",
  "Owner not ready",
  "Declining financials",
  "Lost to another buyer",
  "No time / bandwidth",
] as const;

const REVISIT_PRESETS = [
  { label: "In 3 months", months: 3 },
  { label: "In 6 months", months: 6 },
  { label: "In 12 months", months: 12 },
] as const;

function isoDateInMonths(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function PassDealModal({
  dealName,
  saving,
  error,
  onConfirm,
  onClose,
}: {
  dealName: string;
  saving: boolean;
  error?: string;
  onConfirm: (input: { passReason?: string; revisitAt?: string }) => void;
  onClose: () => void;
}) {
  const [chips, setChips] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [revisitAt, setRevisitAt] = useState<string | null>(isoDateInMonths(6));

  const toggleChip = (reason: string) =>
    setChips((current) =>
      current.includes(reason) ? current.filter((c) => c !== reason) : [...current, reason],
    );

  const composedReason = [chips.join(", "), note.trim()].filter(Boolean).join(" — ");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-md"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-md rounded-xl border border-white/50 bg-white/90 shadow-lg backdrop-blur-md">
        <div className="border-b border-border-subtle px-5 py-4">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-semibold text-text-main">Passing on this deal</h3>
              <p className="mt-0.5 text-xs text-text-muted">{dealName}</p>
            </div>
            <button
              onClick={onClose}
              className="flex size-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-gray-100 hover:text-text-main"
            >
              <span className="material-symbols-outlined text-xl">close</span>
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-5 p-5">
          <div>
            <label className="mb-2 block text-sm font-medium text-text-main">
              Why are you passing?
            </label>
            <div className="flex flex-wrap gap-1.5">
              {REASONS.map((reason) => {
                const on = chips.includes(reason);
                return (
                  <button
                    key={reason}
                    onClick={() => toggleChip(reason)}
                    className="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
                    style={{
                      borderColor: on ? "#003366" : "#E5E7EB",
                      backgroundColor: on ? "rgba(0,51,102,0.06)" : "#fff",
                      color: on ? "#003366" : "#6B7280",
                    }}
                  >
                    {reason}
                  </button>
                );
              })}
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Anything worth remembering when this comes back around…"
              className="mt-2 w-full rounded-lg border border-border-subtle px-3 py-2 text-sm focus:border-[#003366] focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-text-main">Look again</label>
            <div className="flex flex-wrap gap-1.5">
              {REVISIT_PRESETS.map(({ label, months }) => {
                const value = isoDateInMonths(months);
                const on = revisitAt === value;
                return (
                  <button
                    key={label}
                    onClick={() => setRevisitAt(value)}
                    className="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
                    style={{
                      borderColor: on ? "#003366" : "#E5E7EB",
                      backgroundColor: on ? "rgba(0,51,102,0.06)" : "#fff",
                      color: on ? "#003366" : "#6B7280",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
              <button
                onClick={() => setRevisitAt(null)}
                className="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
                style={{
                  borderColor: revisitAt === null ? "#003366" : "#E5E7EB",
                  backgroundColor: revisitAt === null ? "rgba(0,51,102,0.06)" : "#fff",
                  color: revisitAt === null ? "#003366" : "#6B7280",
                }}
              >
                Never
              </button>
            </div>
            {revisitAt && (
              <input
                type="date"
                value={revisitAt}
                onChange={(e) => setRevisitAt(e.target.value || null)}
                className="mt-2 rounded-lg border border-border-subtle px-3 py-2 text-sm focus:border-[#003366] focus:outline-none"
              />
            )}
            <p className="mt-2 text-xs text-text-muted">
              We&rsquo;ll re-score this deal against your criteria if its financials change, if you
              change your thesis, or when this date arrives — and tell you if it&rsquo;s worth
              another look.
            </p>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium text-text-secondary hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={() =>
              onConfirm({
                passReason: composedReason || undefined,
                revisitAt: revisitAt ?? undefined,
              })
            }
            disabled={saving}
            className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            style={{ backgroundColor: "#003366" }}
          >
            {saving ? "Saving…" : "Pass on deal"}
          </button>
        </div>
      </div>
    </div>
  );
}
