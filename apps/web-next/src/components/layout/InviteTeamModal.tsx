"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError } from "@/lib/api";
import { BulkCsvImportPanel } from "./InviteTeamModal.csv";
import { RowDealPicker, type DealOption } from "./RowDealPicker";
import { ROLE_OPTIONS, type ApiRole } from "@/lib/roles";

// Shared with onboarding, the team list and accept-invite (lib/roles.ts).
type Role = ApiRole;
const ROLES = ROLE_OPTIONS;

interface InviteRow {
  id: number;
  email: string;
  role: Role;
  deals: DealOption[];
}

const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export function InviteTeamModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<InviteRow[]>([
    { id: 1, email: "", role: "MEMBER", deals: [] },
  ]);
  const nextId = useRef(2);
  const [availableDeals, setAvailableDeals] = useState<DealOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error" | "warning"; text: string } | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  // Per-row inline errors keyed by row id. Used for known cases the API
  // returns with a `code` (INVITE_SELF, INVITE_ALREADY_MEMBER,
  // INVITE_ALREADY_PENDING). Generic failures fall back to the top `message`.
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  // "rows" = the per-row entry UI; "csv" = the bulk CSV import sub-flow.
  // The bulk panel handles its own sub-stages (upload/preview/result).
  const [viewMode, setViewMode] = useState<"rows" | "csv">("rows");

  useEffect(() => {
    (async () => {
      try {
        const data = await api.get<Array<{ id: string; name: string }> | { deals: Array<{ id: string; name: string }> }>(
          "/deals?status=ACTIVE",
        );
        const list = Array.isArray(data) ? data : data.deals || [];
        setAvailableDeals(list.map((d) => ({ id: d.id, name: d.name })));
      } catch (err) {
        console.warn("[layout/InviteTeamModal] failed to load deals:", err);
        setAvailableDeals([]);
      }
    })();
  }, []);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const validCount = useMemo(() => rows.filter((r) => isValidEmail(r.email)).length, [rows]);

  const updateRow = (id: number, patch: Partial<InviteRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    // Clear any inline error for this row when the user edits it.
    setRowErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const addRow = () =>
    setRows((prev) => [...prev, { id: nextId.current++, email: "", role: "MEMBER", deals: [] }]);

  const removeRow = (id: number) => {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.id !== id)));
    setRowErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  // Map known API error codes to user-facing copy. Returns null for unknown
  // codes — the caller should fall back to the top-of-modal `message` banner.
  const inlineCopyForCode = (code: string | undefined, email: string): string | null => {
    switch (code) {
      case "INVITE_SELF":
        return "This is your account — you can't invite yourself. Try a teammate's email.";
      case "INVITE_ALREADY_MEMBER":
        return `${email} is already on the team.`;
      case "INVITE_ALREADY_PENDING":
        return `${email} already has a pending invitation.`;
      default:
        return null;
    }
  };

  const handleSubmit = async () => {
    const valid = rows.filter((r) => isValidEmail(r.email));
    if (valid.length === 0) {
      setMessage({ type: "error", text: "Please enter at least one valid email address" });
      return;
    }

    setSubmitting(true);
    setMessage(null);
    setInviteUrl(null);
    setRowErrors({});

    let successCount = 0;
    let emailFailCount = 0;
    let lastInviteUrl: string | null = null;
    const genericErrors: string[] = [];
    const nextRowErrors: Record<number, string> = {};

    for (const row of valid) {
      try {
        const data = await api.post<{ emailSent?: boolean; inviteUrl?: string }>("/invitations", {
          email: row.email,
          role: row.role,
        });
        successCount++;
        if (data?.emailSent === false) {
          emailFailCount++;
          if (data.inviteUrl) lastInviteUrl = data.inviteUrl;
        }
      } catch (err) {
        const code = err instanceof ApiError ? err.code : undefined;
        const inlineCopy = inlineCopyForCode(code, row.email);
        if (inlineCopy) {
          nextRowErrors[row.id] = inlineCopy;
        } else {
          genericErrors.push(`${row.email}: ${err instanceof Error ? err.message : "Failed"}`);
        }
      }
    }

    setSubmitting(false);
    setRowErrors(nextRowErrors);

    if (successCount > 0) {
      if (emailFailCount === successCount && lastInviteUrl) {
        setInviteUrl(lastInviteUrl);
        setMessage({
          type: "warning",
          text: "Invitation created but email could not be sent. Copy the link to share manually.",
        });
      } else if (emailFailCount > 0) {
        setMessage({
          type: "warning",
          text: `${successCount - emailFailCount} sent. ${emailFailCount} email${emailFailCount > 1 ? "s" : ""} failed to deliver.`,
        });
      } else if (Object.keys(nextRowErrors).length > 0) {
        // Some succeeded, some had per-row inline errors — keep the modal
        // open and let the inline notes do the talking.
        setMessage({
          type: "warning",
          text: `${successCount} invitation${successCount > 1 ? "s" : ""} sent. Fix the highlighted row${
            Object.keys(nextRowErrors).length > 1 ? "s" : ""
          } below.`,
        });
      } else {
        setMessage({
          type: "success",
          text: `${successCount} invitation${successCount > 1 ? "s" : ""} sent successfully.`,
        });
        setTimeout(() => onClose(), 1200);
      }
    } else if (genericErrors.length > 0) {
      setMessage({ type: "error", text: genericErrors[0] });
    }
    // If only per-row inline errors and zero success, the inline notes carry
    // the message — no top banner needed.
  };

  return createPortal(
    <div className="fixed inset-0 z-[10000]">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-xl"
        data-modal-overlay
        onClick={onClose}
      />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div
          className="w-full max-w-[960px] max-h-[90vh] flex flex-col bg-[#FAFAFA] border border-[#EBEBEB] rounded-2xl shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-8 pt-8 pb-4 flex justify-between items-start">
            <div className="flex flex-col gap-1">
              <h3 className="text-[#343A40] tracking-tight text-2xl font-bold leading-tight">
                Invite Team Members
              </h3>
              <p className="text-[#868E96] text-base font-normal leading-normal">
                Add colleagues to your organization and assign deal access.
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-[#868E96] hover:text-[#343A40] transition-colors p-2 rounded-full hover:bg-black/5"
              aria-label="Close"
            >
              <span className="material-symbols-outlined text-2xl">close</span>
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-8 py-2">
            {viewMode === "csv" ? (
              <div className="py-2">
                <BulkCsvImportPanel
                  onBack={() => setViewMode("rows")}
                  onClose={onClose}
                />
              </div>
            ) : (
            <>
            <div className="space-y-4">
              {rows.map((row, index) => {
                const isFirst = index === 0;
                const emailValid = isValidEmail(row.email);
                return (
                  <div
                    key={row.id}
                    className={`flex flex-col lg:flex-row gap-4 ${isFirst ? "pt-2" : "pt-4"}`}
                  >
                    {/* Email */}
                    <div className="flex-[2]">
                      {isFirst && (
                        <label className="block mb-2 text-sm font-medium text-[#868E96]">
                          Email Address
                        </label>
                      )}
                      <div className="relative">
                        <input
                          type="email"
                          value={row.email}
                          onChange={(e) => updateRow(row.id, { email: e.target.value })}
                          placeholder="colleague@firm.com"
                          aria-invalid={Boolean(rowErrors[row.id])}
                          className={`block w-full rounded-lg border bg-white text-[#343A40] placeholder-[#868E96]/60 focus:ring-2 h-12 px-4 text-sm transition-all outline-none ${
                            rowErrors[row.id]
                              ? "border-red-300 focus:border-red-500 focus:ring-red-500/20"
                              : "border-[#EBEBEB] focus:border-[#003366] focus:ring-[#003366]/20"
                          }`}
                        />
                        {emailValid && !rowErrors[row.id] && (
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-green-600 material-symbols-outlined text-lg">
                            check_circle
                          </span>
                        )}
                      </div>
                      {rowErrors[row.id] && (
                        <span className="mt-1.5 block text-xs text-red-600">
                          {rowErrors[row.id]}
                        </span>
                      )}
                    </div>

                    {/* Role */}
                    <div className="flex-1 min-w-[140px]">
                      {isFirst && (
                        <label className="block mb-2 text-sm font-medium text-[#868E96]">
                          Role
                        </label>
                      )}
                      <select
                        value={row.role}
                        onChange={(e) => updateRow(row.id, { role: e.target.value as Role })}
                        className="block w-full rounded-lg border border-[#EBEBEB] bg-white text-[#343A40] focus:border-[#003366] focus:ring-2 focus:ring-[#003366]/20 h-12 px-4 text-sm transition-all cursor-pointer outline-none appearance-none pr-10"
                        style={{
                          backgroundImage:
                            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%239CA3AF'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E\")",
                          backgroundPosition: "right 0.5rem center",
                          backgroundRepeat: "no-repeat",
                          backgroundSize: "1.5em 1.5em",
                        }}
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Workspaces */}
                    <div className="flex-[2]">
                      {isFirst && (
                        <label className="block mb-2 text-sm font-medium text-[#868E96]">
                          Workspaces
                        </label>
                      )}
                      <RowDealPicker
                        row={row}
                        available={availableDeals}
                        onAdd={(deal) =>
                          updateRow(row.id, { deals: [...row.deals, deal] })
                        }
                        onRemove={(dealId) =>
                          updateRow(row.id, {
                            deals: row.deals.filter((d) => d.id !== dealId),
                          })
                        }
                      />
                    </div>

                    {/* Delete */}
                    <div className={`flex ${isFirst ? "items-end pb-1 lg:pb-1" : "items-center"}`}>
                      <button
                        type="button"
                        onClick={() => removeRow(row.id)}
                        disabled={rows.length === 1}
                        title="Remove"
                        className={`text-[#868E96] hover:text-red-500 transition-colors p-1.5 rounded-lg hover:bg-black/5 ${
                          rows.length === 1 ? "opacity-30 cursor-not-allowed" : ""
                        }`}
                      >
                        <span className="material-symbols-outlined">delete</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Action Buttons Row */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mt-6 gap-4 border-t border-[#EBEBEB] pt-6 pb-2">
              <button
                type="button"
                onClick={addRow}
                className="flex items-center gap-2 text-[#003366] hover:text-blue-700 font-medium text-sm transition-colors group px-2 py-1 rounded-md hover:bg-[#E6EDF5]"
              >
                <span className="material-symbols-outlined text-xl group-hover:scale-110 transition-transform">
                  add_circle
                </span>
                Add another team member
              </button>
              <button
                type="button"
                onClick={() => {
                  // Clear any inline state from the row flow before swapping —
                  // the bulk panel keeps its own state.
                  setMessage(null);
                  setInviteUrl(null);
                  setRowErrors({});
                  setViewMode("csv");
                }}
                className="flex items-center gap-2 text-[#868E96] hover:text-[#343A40] font-medium text-sm transition-colors px-2 py-1 rounded-md hover:bg-black/5"
              >
                <span className="material-symbols-outlined text-xl">upload_file</span>
                Bulk import via CSV
              </button>
            </div>

            {/* Access Control Info */}
            <div className="mt-4 bg-[#F0F4F8] border border-[#E0E8F0] rounded-lg p-3 flex gap-3 items-start">
              <span className="material-symbols-outlined text-[#003366] text-xl mt-0.5">info</span>
              <div className="text-sm text-[#868E96]">
                <span className="text-[#343A40] font-medium">Access Control:</span> Analysts have{" "}
                <span className="text-[#343A40]">view-only</span> access to assigned deal workspaces.
                Associates can edit models but cannot invite external guests.
              </div>
            </div>

            {message && (
              <div
                className={`mt-4 rounded-lg p-3 text-sm border ${
                  message.type === "success"
                    ? "bg-green-50 border-green-200 text-green-700"
                    : message.type === "warning"
                      ? "bg-amber-50 border-amber-200 text-amber-800"
                      : "bg-red-50 border-red-200 text-red-700"
                }`}
              >
                {message.text}
                {inviteUrl && (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      readOnly
                      value={inviteUrl}
                      className="flex-1 text-xs bg-white border border-gray-200 rounded-lg px-3 py-2 text-gray-700 select-all"
                    />
                    <button
                      type="button"
                      onClick={() => navigator.clipboard?.writeText(inviteUrl)}
                      className="px-3 py-2 text-xs font-medium text-white rounded-lg whitespace-nowrap"
                      style={{ backgroundColor: "#003366" }}
                    >
                      Copy
                    </button>
                  </div>
                )}
              </div>
            )}
            </>
            )}
          </div>

          {/* Footer — hidden in CSV mode; the bulk panel renders its own actions. */}
          {viewMode === "rows" && (
          <div className="px-8 py-6 bg-white border-t border-[#EBEBEB] flex flex-col sm:flex-row justify-between items-center gap-4">
            <div className="text-sm text-[#868E96] hidden sm:block">
              Inviting{" "}
              <span className="text-[#343A40] font-semibold">
                {validCount} user{validCount !== 1 ? "s" : ""}
              </span>{" "}
              to organization
            </div>
            <div className="flex gap-3 w-full sm:w-auto">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 sm:flex-none px-6 py-3 rounded-lg border border-[#EBEBEB] text-[#343A40] font-medium text-sm hover:bg-black/5 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || validCount === 0}
                className="flex-1 sm:flex-none px-6 py-3 rounded-lg text-white font-medium text-sm shadow-lg transition-all active:scale-95 flex items-center justify-center gap-2 disabled:opacity-60"
                style={{ backgroundColor: "#003366" }}
              >
                {submitting ? (
                  <>
                    <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
                    Sending...
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-lg">send</span>
                    Send Invitations
                  </>
                )}
              </button>
            </div>
          </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
